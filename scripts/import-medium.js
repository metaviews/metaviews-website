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

const SOURCE_DIR = path.resolve(getArgValue("--source", "medium-export"));
const POSTS_DIR = path.join(SOURCE_DIR, "posts");
const OUTPUT_ROOT = path.resolve(getArgValue("--output", "src/intelligence/archive"));
const ASSETS_ROOT = path.resolve(getArgValue("--assets", "src/assets/medium"));
const REPORT_PATH = path.resolve(
  getArgValue("--report", path.join(SOURCE_DIR, "duplicate-candidates.json"))
);
const ARCHIVE_ROOT = path.resolve("src/intelligence/archive");
const DRY_RUN = args.has("--dry-run");
const FULL_REBUILD = args.has("--full-rebuild");

if (!fs.existsSync(POSTS_DIR)) {
  console.error("ERROR: medium-export/posts not found at", POSTS_DIR);
  process.exit(1);
}

const stopwords = new Set([
  "the","a","an","and","or","but","so","for","nor","on","in","to","of","at","by","with","from","into","over","under","as","is","are","was","were","be","been","being",
  "this","that","these","those","it","its","we","our","you","your","they","their","i","me","my","he","she","him","her","them",
  "what","who","why","how","when","where","which","not","no","yes","do","does","did","done","just","now","then","than",
  "if","while","about","before","after","between","through","across","per","via","vs","v","will","can","could","should","would",
  "new","old","future","authority","power","intelligence","medium","post","posts","article"
]);

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
    if (stat.size > 3_000_000) return null;
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

function extractField(fm, key) {
  if (!fm) return "";
  const re = new RegExp(`\\b${key}\\s*:\\s*['"]?([^\\r\\n'"]+)['"]?`, "i");
  const m = fm.match(re);
  return m ? m[1].trim() : "";
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

function stripHtmlTags(text) {
  return String(text || "").replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

function normalizeTitle(title) {
  return slugifyTitle(stripHtmlTags(decodeHtmlEntities(title)));
}

function slugifyTag(tag) {
  return String(tag || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
    if (!key || seen.has(key)) return;
    seen.add(key);
    tags.push(t);
  };

  pushTag("Medium");
  pushTag("Analysis");

  for (const ac of acronyms) {
    pushTag(ac);
  }

  for (const t of sorted) {
    const lower = t.toLowerCase();
    if (acronymMap && acronymMap.has(lower)) {
      pushTag(acronymMap.get(lower));
      continue;
    }

    pushTag(titleCase(t));
    if (tags.length >= 7) break;
  }

  return tags;
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hashSuffix(input) {
  return crypto.createHash("md5").update(input).digest("hex").slice(0, 8);
}

function sanitizeFilePart(name) {
  return String(name || "file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/^-+|-+$/g, "") || "file";
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https:") ? https : http;
    const req = proto.get(
      url,
      {
        headers: {
          "user-agent": "metaviews-importer/1.0",
          "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      },
      (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redirected = new URL(res.headers.location, url).toString();
        return resolve(downloadFile(redirected, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.replace(new RegExp(escapeRegExp(needle), "g"), replacement);
}

function toMiroUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/(\.|^)medium\.com$/i.test(u.hostname)) return rawUrl;
    const maxMatch = u.pathname.match(/\/max\/\d+\/(.+)$/i);
    if (maxMatch && maxMatch[1]) {
      return `https://miro.medium.com/v2/resize:fit:1600/${maxMatch[1]}`;
    }
    const fitMatch = u.pathname.match(/\/fit\/c\/\d+\/\d+\/(.+)$/i);
    if (fitMatch && fitMatch[1]) {
      return `https://miro.medium.com/v2/resize:fit:800/${fitMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

async function downloadWithFallback(rawUrl, dest) {
  const candidates = [];
  const miro = toMiroUrl(rawUrl);
  if (miro) candidates.push(miro);
  if (!candidates.includes(rawUrl)) candidates.push(rawUrl);

  let lastErr = null;
  for (const c of candidates) {
    try {
      await downloadFile(c, dest);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Unable to download ${rawUrl}`);
}

function parseFilename(fileName) {
  const base = path.basename(fileName, ".html");
  const m = base.match(/^(\d{4}-\d{2}-\d{2})_(.+)-([a-f0-9]{8,32})$/i);
  if (!m) return null;
  return {
    date: m[1],
    slugPart: m[2],
    mediumId: m[3].toLowerCase(),
    baseName: base,
  };
}

function extractHtmlTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

function extractSubtitle(html) {
  const m = html.match(/<section[^>]+data-field=["']subtitle["'][^>]*>([\s\S]*?)<\/section>/i);
  return m ? stripHtmlTags(decodeHtmlEntities(m[1])).replace(/\s+/g, " ").trim() : "";
}

function extractBodyHtml(html) {
  const m = html.match(/<section[^>]+data-field=["']body["'][^>]*>([\s\S]*?)<\/section>\s*<footer/i);
  if (m) return m[1].trim();

  const fallback = html.match(/<section[^>]+data-field=["']body["'][^>]*>([\s\S]*?)<\/section>/i);
  return fallback ? fallback[1].trim() : "";
}

function stripLeadingDuplicateHeadings(bodyHtml, title, subtitle) {
  let out = bodyHtml;
  const titleNorm = normalizeTitle(title);
  const subtitleNorm = normalizeTitle(subtitle);

  out = out.replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i, (full, inner) => {
    if (normalizeTitle(inner) === titleNorm) return "";
    return full;
  });
  out = out.replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i, (full, inner) => {
    if (subtitleNorm && normalizeTitle(inner) === subtitleNorm) return "";
    return full;
  });

  return out.trim();
}

function cleanHtml(html) {
  let out = String(html || "");
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\s+srcset="[^"]*"/gi, "");
  out = out.replace(/\s+sizes="[^"]*"/gi, "");
  out = out.replace(/<p>\s*<\/p>/gi, "");
  return out.trim();
}

function extractImageSrcs(html) {
  const srcs = [];
  let m;
  const imgRe = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  while ((m = imgRe.exec(html))) {
    const raw = m[1];
    if (raw && /^https?:/i.test(raw)) srcs.push(raw);
  }

  const cssUrlRe = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi;
  while ((m = cssUrlRe.exec(html))) {
    const raw = m[2];
    if (raw && /^https?:/i.test(raw)) srcs.push(raw);
  }

  return Array.from(new Set(srcs));
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildArchiveInfo() {
  const canonicalTagMap = new Map();
  const titleDateKeyToFiles = new Map();
  const mediumIds = new Set();
  const mediumIdToFile = new Map();

  if (!fs.existsSync(ARCHIVE_ROOT)) {
    return { canonicalTagMap, titleDateKeyToFiles, mediumIds, mediumIdToFile };
  }

  const files = walk(ARCHIVE_ROOT).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const text = safeRead(file);
    if (!text) continue;
    const fm = parseFrontMatter(text);
    if (!fm) continue;

    const date = extractField(fm, "date");
    const title = extractField(fm, "title");
    const mediumId = extractField(fm, "medium_id");
    if (mediumId) {
      const mid = mediumId.toLowerCase();
      mediumIds.add(mid);
      if (!mediumIdToFile.has(mid)) mediumIdToFile.set(mid, file);
    }

    const tags = extractTagsFromFrontMatter(fm);
    for (const tag of tags) {
      const slug = slugifyTag(tag);
      if (!slug) continue;
      if (!canonicalTagMap.has(slug)) canonicalTagMap.set(slug, tag);
    }

    if (date && title) {
      const key = `${date}|${normalizeTitle(title)}`;
      if (!titleDateKeyToFiles.has(key)) titleDateKeyToFiles.set(key, []);
      titleDateKeyToFiles.get(key).push(file);
    }
  }

  return { canonicalTagMap, titleDateKeyToFiles, mediumIds, mediumIdToFile };
}

async function main() {
  const { canonicalTagMap, titleDateKeyToFiles, mediumIds, mediumIdToFile } = buildArchiveInfo();
  const importTagMap = new Map();

  const postFiles = walk(POSTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const parsed = [];
  const badNames = [];
  for (const postFile of postFiles) {
    const info = parseFilename(postFile);
    if (!info) {
      badNames.push(postFile);
      continue;
    }
    parsed.push({ postFile, ...info });
  }

  const acronymMap = new Map();
  for (const p of parsed) {
    const html = safeRead(p.postFile);
    if (!html) continue;
    const title = extractHtmlTitle(html) || p.slugPart.replace(/-/g, " ");
    const subtitle = extractSubtitle(html);
    const base = `${title} ${subtitle}`.trim();
    for (const ac of extractAcronyms(base)) {
      const key = ac.toLowerCase();
      if (!acronymMap.has(key)) acronymMap.set(key, ac);
    }
  }

  const written = [];
  const duplicateCandidates = [];
  const skippedExistingMediumId = [];
  const assetFailures = [];
  const parseFailures = [];
  const usedOutputPaths = new Set();

  for (const p of parsed) {
    if (!FULL_REBUILD && mediumIds.has(p.mediumId)) {
      skippedExistingMediumId.push({ mediumId: p.mediumId, source: p.postFile });
      continue;
    }

    const htmlRaw = safeRead(p.postFile);
    if (!htmlRaw) {
      parseFailures.push({ source: p.postFile, reason: "Cannot read file" });
      continue;
    }

    const title = extractHtmlTitle(htmlRaw) || p.slugPart.replace(/-/g, " ");
    const subtitle = extractSubtitle(htmlRaw);
    const body = extractBodyHtml(htmlRaw);
    if (!title || !body) {
      parseFailures.push({
        source: p.postFile,
        reason: `Missing ${!title ? "title" : "body section"}`,
      });
      continue;
    }

    const existingImportedPath = mediumIdToFile.get(p.mediumId) || "";

    const dupKey = `${p.date}|${normalizeTitle(title)}`;
    const existingMatches = titleDateKeyToFiles.get(dupKey) || [];
    const conflictMatches = existingMatches.filter((f) => f !== existingImportedPath);
    if (!existingImportedPath && conflictMatches.length) {
      duplicateCandidates.push({
        date: p.date,
        title,
        mediumId: p.mediumId,
        source: path.relative(process.cwd(), p.postFile),
        existing: conflictMatches.map((m) => path.relative(process.cwd(), m)),
      });
      continue;
    }

    let slug = slugifyTitle(title);
    if (!slug) slug = p.slugPart.toLowerCase();

    const outDir = path.join(OUTPUT_ROOT, p.date.slice(0, 4));
    let outPath = existingImportedPath || path.join(outDir, `${p.date}-${slug}.md`);
    if (!existingImportedPath && (usedOutputPaths.has(outPath) || fileExists(outPath))) {
      outPath = path.join(outDir, `${p.date}-${slug}-${p.mediumId.slice(0, 6)}.md`);
    }
    usedOutputPaths.add(outPath);

    let bodyHtml = stripLeadingDuplicateHeadings(body, title, subtitle);
    bodyHtml = cleanHtml(bodyHtml);

    const imgSrcs = extractImageSrcs(bodyHtml);
    const assetDir = path.join(ASSETS_ROOT, `${p.date}-${slug}`);
    const urlToLocal = new Map();

    for (const rawSrc of imgSrcs) {
      const decoded = decodeHtmlEntities(rawSrc);
      let filename = "image.jpg";
      try {
        const u = new URL(decoded);
        const base = path.basename(u.pathname) || "image.jpg";
        filename = path.extname(base) ? base : `${base}.jpg`;
      } catch {
        filename = "image.jpg";
      }

      const hashed = hashSuffix(decoded);
      const parsedName = path.parse(filename);
      const safeName = sanitizeFilePart(parsedName.name);
      const finalName = `${safeName}-${hashed}${parsedName.ext || ".jpg"}`;
      const dest = path.join(assetDir, finalName);
      const publicPath = `/assets/medium/${p.date}-${slug}/${finalName}`;

      if (DRY_RUN) {
        urlToLocal.set(rawSrc, publicPath);
        urlToLocal.set(decoded, publicPath);
        continue;
      }

      try {
        ensureDir(assetDir);
        if (!fileExists(dest)) {
          await downloadWithFallback(decoded, dest);
        }
        if (fileExists(dest)) {
          urlToLocal.set(rawSrc, publicPath);
          urlToLocal.set(decoded, publicPath);
        }
      } catch (err) {
        assetFailures.push({
          mediumId: p.mediumId,
          source: path.relative(process.cwd(), p.postFile),
          url: decoded,
          error: err.message,
        });
      }
    }

    for (const [from, to] of urlToLocal.entries()) {
      bodyHtml = replaceAll(bodyHtml, from, to);
    }

    const canonicalLinkMatch = htmlRaw.match(
      /<a[^>]+class=["'][^"']*\bp-canonical\b[^"']*["'][^>]+href=["']([^"']+)["']/i
    );
    const mediumUrl = canonicalLinkMatch ? decodeHtmlEntities(canonicalLinkMatch[1]) : "";

    const rawTags = inferTags(title, subtitle, acronymMap);
    const tags = canonicalizeTags(rawTags, canonicalTagMap, importTagMap);

    const fm = [];
    fm.push("---");
    fm.push("layout: layouts/intelligence-post.njk");
    fm.push(`title: ${yamlQuote(title)}`);
    fm.push(`date: ${p.date}`);
    if (subtitle) fm.push(`description: ${yamlQuote(subtitle)}`);
    if (tags.length) {
      fm.push("tags:");
      for (const tag of tags) fm.push(`  - ${yamlQuote(tag)}`);
    }
    if (mediumUrl) fm.push(`medium_url: ${yamlQuote(mediumUrl)}`);
    fm.push(`medium_id: ${yamlQuote(p.mediumId)}`);
    fm.push("---");

    const content = `${fm.join("\n")}\n${bodyHtml}\n`;

    if (!DRY_RUN) {
      ensureDir(outDir);
      fs.writeFileSync(outPath, content, "utf8");
    }

    written.push({
      mediumId: p.mediumId,
      outPath: path.relative(process.cwd(), outPath),
      images: imgSrcs.length,
    });
  }

  if (!DRY_RUN) {
    ensureDir(path.dirname(REPORT_PATH));
    fs.writeFileSync(REPORT_PATH, JSON.stringify(duplicateCandidates, null, 2), "utf8");
  }

  console.log(`Medium export files: ${postFiles.length}`);
  console.log(`Usable post files: ${parsed.length}`);
  console.log(`Written: ${written.length}${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(`Duplicate candidates flagged: ${duplicateCandidates.length}`);
  if (!DRY_RUN) console.log(`Duplicate report: ${path.relative(process.cwd(), REPORT_PATH)}`);
  if (badNames.length) console.log(`Unrecognized filenames skipped: ${badNames.length}`);
  if (parseFailures.length) console.log(`Parse failures: ${parseFailures.length}`);
  if (skippedExistingMediumId.length) console.log(`Already imported by medium_id: ${skippedExistingMediumId.length}`);
  if (assetFailures.length) console.log(`Asset download failures: ${assetFailures.length}`);

  if (written.length) {
    console.log("Sample outputs (first 5):");
    written.slice(0, 5).forEach((w) => {
      console.log(`- ${w.outPath} (images: ${w.images})`);
    });
  }

  if (duplicateCandidates.length) {
    console.log("Duplicate candidates (first 5):");
    duplicateCandidates.slice(0, 5).forEach((d) => {
      console.log(`- ${d.date} | ${d.title}`);
      d.existing.slice(0, 2).forEach((m) => console.log(`  existing: ${m}`));
    });
  }

  if (assetFailures.length) {
    console.log("Asset download failures (first 10):");
    assetFailures.slice(0, 10).forEach((f) => {
      console.log(`- ${f.source}: ${f.url} (${f.error})`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
