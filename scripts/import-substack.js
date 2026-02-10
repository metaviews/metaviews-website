#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const args = new Set(process.argv.slice(2));
const getArgValue = (key, fallback) => {
  const idx = process.argv.indexOf(key);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
};

const SOURCE_DIR = path.resolve(getArgValue("--source", "substack.feb5"));
const POSTS_CSV = path.join(SOURCE_DIR, "posts.csv");
const POSTS_DIR = path.join(SOURCE_DIR, "posts");
const OUTPUT_ROOT = path.resolve(getArgValue("--output", "src/intelligence/archive"));
const ASSETS_ROOT = path.resolve(getArgValue("--assets", "src/assets/substack"));
const DRY_RUN = args.has("--dry-run");
const ARCHIVE_ROOT = path.resolve("src/intelligence/archive");
const FULL_REBUILD = args.has("--full-rebuild");
const SINCE_ARG = getArgValue("--since", "");
const SINCE_DATE = SINCE_ARG ? new Date(SINCE_ARG) : null;

if (!fs.existsSync(POSTS_CSV) || !fs.existsSync(POSTS_DIR)) {
  console.error("ERROR: posts.csv or posts/ not found in", SOURCE_DIR);
  process.exit(1);
}
if (SINCE_DATE && Number.isNaN(SINCE_DATE.getTime())) {
  console.error("ERROR: Invalid --since date. Use YYYY-MM-DD.");
  process.exit(1);
}

const stopwords = new Set([
  "the","a","an","and","or","but","so","for","nor","on","in","to","of","at","by","with","from","into","over","under","as","is","are","was","were","be","been","being",
  "this","that","these","those","it","its","we","our","you","your","they","their","i","me","my","he","she","him","her","them",
  "what","who","why","how","when","where","which","not","no","yes","do","does","did","done","just","now","then","than",
  "if","while","about","before","after","between","through","across","per","via","vs","v","will","can","could","should","would",
  "new","old","future","authority","power","intelligence" // too generic for tags here
]);

function parseCSV(text) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }

    if (char === '\r') {
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function safeRead(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 2_000_000) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseFrontMatter(text) {
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  return fmMatch[1];
}

function hasSubstackIdFrontMatter(fm) {
  return /\bsubstack_id\s*:/i.test(fm || "");
}

function extractSubstackId(fm) {
  const m = (fm || "").match(/\bsubstack_id\s*:\s*['"]?([^\r\n'"]+)['"]?/i);
  return m ? m[1].trim() : null;
}

function extractTagsFromFrontMatter(fm) {
  if (!fm) return [];
  const tagsMatch = fm.match(/\btags:\s*\r?\n([\s\S]*?)(\r?\n\w+:|$)/i);
  if (!tagsMatch) return [];
  const lines = tagsMatch[1].split(/\r?\n/).map((l) => l.trim());
  const tags = [];
  for (const line of lines) {
    const m = line.match(/^-+\s*(.+)$/);
    if (!m) continue;
    let tag = m[1].trim();
    tag = tag.replace(/^['"]|['"]$/g, "");
    if (tag) tags.push(tag);
  }
  return tags;
}

function slugifyTitle(title) {
  if (!title) return "";
  let s = title.normalize("NFKD");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[’']/g, "");
  s = s.replace(/[^a-zA-Z0-9]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-|-$/g, "");
  return s.toLowerCase();
}

function yamlQuote(value) {
  if (value === null || value === undefined) return "''";
  const s = String(value);
  return `'${s.replace(/'/g, "''")}'`;
}

function titleCase(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function extractAcronyms(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z]{2,}\b/g) || [];
  const cleaned = matches.map((m) => m.replace(/\./g, ""));
  return Array.from(new Set(cleaned));
}

function inferTags(title, subtitle, acronymMap) {
  const base = `${title || ""} ${subtitle || ""}`.trim();
  const acronyms = extractAcronyms(base);
  const cleaned = base
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase();

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const counts = new Map();
  const firstIndex = new Map();

  tokens.forEach((t, idx) => {
    if (t.length < 3) return;
    if (/^\d+$/.test(t)) return;
    if (stopwords.has(t)) return;
    counts.set(t, (counts.get(t) || 0) + 1);
    if (!firstIndex.has(t)) firstIndex.set(t, idx);
  });

  const sorted = Array.from(counts.keys()).sort((a, b) => {
    const ca = counts.get(a) || 0;
    const cb = counts.get(b) || 0;
    if (cb !== ca) return cb - ca;
    return (firstIndex.get(a) || 0) - (firstIndex.get(b) || 0);
  });

  const tags = [];
  const seen = new Set();

  const pushTag = (t) => {
    const key = String(t || "").toLowerCase();
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(t);
  };

  pushTag("Future of Authority");

  for (const ac of acronyms) {
    pushTag(ac);
  }

  for (const t of sorted) {
    const lower = t.toLowerCase();
    if (acronymMap && acronymMap.has(lower)) {
      pushTag(acronymMap.get(lower));
      continue;
    }

    const tc = titleCase(t);
    pushTag(tc);
    if (tags.length >= 6) break; // 1 series tag + up to 5 inferred
  }

  return tags;
}

function slugifyTag(tag) {
  return String(tag || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildArchiveInfo() {
  const canonicalTagMap = new Map(); // slug -> canonical tag (legacy)
  const tagCounts = new Map(); // slug -> count (legacy only)
  const substackIds = new Set();

  if (!fs.existsSync(ARCHIVE_ROOT)) {
    return { canonicalTagMap, tagCounts, substackIds };
  }

  const files = walk(ARCHIVE_ROOT).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const text = safeRead(file);
    if (!text) continue;
    const fm = parseFrontMatter(text);
    if (!fm) continue;

    const isSubstack = hasSubstackIdFrontMatter(fm);
    const tags = extractTagsFromFrontMatter(fm);

    if (isSubstack) {
      const id = extractSubstackId(fm);
      if (id) substackIds.add(id);
      for (const tag of tags) {
        const slug = slugifyTag(tag);
        if (!slug) continue;
        tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
      }
      continue;
    }

    for (const tag of tags) {
      const slug = slugifyTag(tag);
      if (!slug) continue;
      if (!canonicalTagMap.has(slug)) canonicalTagMap.set(slug, tag);
      tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
    }
  }

  return { canonicalTagMap, tagCounts, substackIds };
}

function canonicalizeTags(rawTags, canonicalTagMap, importTagMap) {
  const tags = [];
  const seen = new Set();

  for (const tag of rawTags) {
    const slug = slugifyTag(tag);
    if (!slug) continue;
    let canon = canonicalTagMap.get(slug);
    if (!canon) {
      canon = importTagMap.get(slug);
      if (!canon) {
        canon = tag;
        importTagMap.set(slug, canon);
      }
    }
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(canon);
  }

  return tags;
}

function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, "&");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hashSuffix(input) {
  return crypto.createHash("md5").update(input).digest("hex").slice(0, 8);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https:") ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", reject);
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.replace(new RegExp(escapeRegExp(needle), "g"), replacement);
}

function cleanHtml(html) {
  let out = html;
  // Remove subscription widgets
  out = out.replace(/<div class="subscription-widget-wrap-editor"[\s\S]*?<\/div>\s*<\/div>/gi, "");
  out = out.replace(/<div class="subscription-widget[\s\S]*?<\/div>\s*<\/div>/gi, "");
  // Remove share/CTA buttons
  out = out.replace(/<p class="button-wrapper"[\s\S]*?<\/p>/gi, "");
  out = out.replace(/<div class="button-wrapper"[\s\S]*?<\/div>/gi, "");
  // Remove image expand controls
  out = out.replace(/<div class="image-link-expand"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, "");
  // Remove empty paragraphs
  out = out.replace(/<p>\s*<\/p>/gi, "");
  return out.trim();
}

function extractImageSrcs(html) {
  const srcs = [];
  const re = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (raw && /^https?:/i.test(raw)) srcs.push(raw);
  }
  return Array.from(new Set(srcs));
}

function getSubstackSlug(postId) {
  const idx = postId.indexOf(".");
  if (idx === -1) return postId;
  return postId.slice(idx + 1);
}

async function main() {
  const csvText = fs.readFileSync(POSTS_CSV, "utf8");
  const rows = parseCSV(csvText);
  const headers = rows.shift();
  if (!headers) {
    console.error("ERROR: empty posts.csv");
    process.exit(1);
  }

  const records = rows.map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] || "";
    });
    return obj;
  });

  const published = records.filter((r) => String(r.is_published).toLowerCase() === "true");
  const { canonicalTagMap, tagCounts, substackIds } = buildArchiveInfo();
  const importTagMap = new Map();

  const postsToProcess = published.filter((post) => {
    if (!FULL_REBUILD && substackIds.has(post.post_id)) return false;
    if (SINCE_DATE) {
      const d = new Date(post.post_date);
      if (Number.isNaN(d.getTime())) return false;
      if (d < SINCE_DATE) return false;
    }
    return true;
  });

  const acronymMap = new Map();
  const inferredById = new Map();

  for (const post of postsToProcess) {
    const base = `${post.title || ""} ${post.subtitle || ""}`.trim();
    for (const ac of extractAcronyms(base)) {
      const key = ac.toLowerCase();
      if (!acronymMap.has(key)) acronymMap.set(key, ac);
    }
  }

  for (const post of postsToProcess) {
    const rawTags = inferTags(post.title || post.post_id, post.subtitle || "", acronymMap);
    const tags = canonicalizeTags(rawTags, canonicalTagMap, importTagMap);
    inferredById.set(post.post_id, tags);
    for (const tag of tags) {
      const slug = slugifyTag(tag);
      tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
    }
  }

  const written = [];
  const missing = [];
  const assetFailures = [];
  const slugSet = new Set();

  for (const post of postsToProcess) {
    const postId = post.post_id;
    const htmlPath = path.join(POSTS_DIR, `${postId}.html`);
    if (!fs.existsSync(htmlPath)) {
      missing.push(postId);
      continue;
    }

    const date = new Date(post.post_date);
    const yyyy = date.getUTCFullYear();
    const dateStr = date.toISOString().slice(0, 10);

    const title = post.title || postId;
    const subtitle = post.subtitle || "";

    let slug = slugifyTitle(title);
    if (!slug) slug = getSubstackSlug(postId);

    let fileSlug = slug;
    if (slugSet.has(`${yyyy}-${dateStr}-${fileSlug}`)) {
      fileSlug = `${slug}-${postId.split(".")[0]}`;
    }
    slugSet.add(`${yyyy}-${dateStr}-${fileSlug}`);

    const outDir = path.join(OUTPUT_ROOT, String(yyyy));
    const outPath = path.join(outDir, `${dateStr}-${fileSlug}.md`);

    let html = fs.readFileSync(htmlPath, "utf8");
    html = cleanHtml(html);

    const imgSrcs = extractImageSrcs(html);
    const assetDir = path.join(ASSETS_ROOT, fileSlug);
    const urlToLocal = new Map();

    for (const rawSrc of imgSrcs) {
      const decoded = decodeHtmlEntities(rawSrc);
      let filename = "image";
      try {
        const u = new URL(decoded);
        filename = path.basename(u.pathname) || "image";
      } catch {
        filename = "image";
      }

      if (!path.extname(filename)) filename += ".jpg";
      const hashed = hashSuffix(decoded);
      const finalName = `${path.parse(filename).name}-${hashed}${path.extname(filename)}`;
      const dest = path.join(assetDir, finalName);
      const publicPath = `/assets/substack/${fileSlug}/${finalName}`;

      if (DRY_RUN) {
        urlToLocal.set(rawSrc, publicPath);
        urlToLocal.set(decoded, publicPath);
        continue;
      }

      try {
        ensureDir(assetDir);
        if (!fs.existsSync(dest)) {
          await downloadFile(decoded, dest);
        }
        if (fs.existsSync(dest)) {
          urlToLocal.set(rawSrc, publicPath);
          urlToLocal.set(decoded, publicPath);
        }
      } catch (err) {
        assetFailures.push({ postId, url: decoded, error: err.message });
      }
    }

    // Rewrite image URLs
    for (const [from, to] of urlToLocal.entries()) {
      html = replaceAll(html, from, to);
    }

    // Drop srcset attributes to avoid broken references
    html = html.replace(/\s+srcset="[^"]*"/gi, "");

    const allTags = inferredById.get(postId) || [];
    const tags = allTags.filter((tag) => (tagCounts.get(slugifyTag(tag)) || 0) >= 2);
    const canonical = `https://metaviews.substack.com/p/${getSubstackSlug(postId)}`;

    const fm = [];
    fm.push("---");
    fm.push("layout: layouts/intelligence-post.njk");
    fm.push(`title: ${yamlQuote(title)}`);
    fm.push(`date: ${dateStr}`);
    if (subtitle) fm.push(`description: ${yamlQuote(subtitle)}`);
    if (tags.length) {
      fm.push("tags:");
      for (const t of tags) fm.push(`  - ${yamlQuote(t)}`);
    }
    fm.push(`canonical: ${yamlQuote(canonical)}`);
    fm.push(`substack_id: ${yamlQuote(postId)}`);
    fm.push("---");

    const content = `${fm.join("\n")}\n${html}\n`;

    if (!DRY_RUN) {
      ensureDir(outDir);
      fs.writeFileSync(outPath, content, "utf8");
    }

    written.push({ postId, outPath, images: imgSrcs.length });
  }

  console.log(`Published posts: ${published.length}`);
  console.log(`Written: ${written.length}${DRY_RUN ? " (dry-run)" : ""}`);
  if (missing.length) console.log(`Missing HTML files: ${missing.length}`);
  if (assetFailures.length) console.log(`Asset download failures: ${assetFailures.length}`);

  if (missing.length) {
    console.log("Missing post_ids:");
    missing.forEach((id) => console.log(`- ${id}`));
  }

  if (assetFailures.length) {
    console.log("Asset download failures (first 10):");
    assetFailures.slice(0, 10).forEach((f) =>
      console.log(`- ${f.postId}: ${f.url} (${f.error})`)
    );
  }

  if (written.length) {
    console.log("Sample outputs (first 5):");
    written.slice(0, 5).forEach((w) => console.log(`- ${w.outPath}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
