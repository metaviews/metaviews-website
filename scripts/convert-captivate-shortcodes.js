#!/usr/bin/env node
/**
 * Converts WordPress Captivate shortcodes (including escaped underscores)
 * into Intelligence pages that use layouts/intelligence-captivate.njk.
 *
 * It preserves existing front matter, injects:
 *   layout: layouts/intelligence-captivate.njk
 *   captivateEpisode: "###"
 * and removes the shortcode line from the body.
 *
 * Usage:
 *   node scripts/convert-captivate-shortcodes.js --dry-run
 *   node scripts/convert-captivate-shortcodes.js
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// Safer default: only touch your Eleventy content
const ROOT = path.resolve(process.cwd(), "src");

// Skip directories
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "_site",
  "dist",
  "build",
  ".cache",
  ".next",
  ".venv",
  "scripts", // avoid matching this script if run from repo root by mistake
]);

const ALLOWED_EXT = new Set([".md", ".markdown", ".njk", ".html"]);

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
      if (SKIP_DIR.has(ent.name)) continue;
      walk(full, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (ALLOWED_EXT.has(ext)) out.push(full);
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

function containsCaptivateShortcode(text) {
  // Matches [cfm_captivate_episodes ...] OR [cfm\_captivate\_episodes ...]
  return /\[\s*cfm\\?_captivate\\?_episodes\b[\s\S]*?\]/i.test(text);
}

function extractEpisodeId(text) {
  // Matches episode_id="273" OR episode\_id="273" OR without quotes
  const m = text.match(/episode\\?_id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function stripCaptivateShortcodeFromBody(body) {
  // Remove the entire shortcode block, even if it spans a line
  return body.replace(/\[\s*cfm\\?_captivate\\?_episodes\b[\s\S]*?\]\s*/gi, "").trimStart();
}

function parseFrontMatter(text) {
  // Very small, safe front matter parser: only handles leading --- ... ---
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!fmMatch) return { frontMatter: null, body: text };

  return {
    frontMatter: fmMatch[1],
    body: text.slice(fmMatch[0].length),
  };
}

function hasKey(frontMatter, key) {
  const re = new RegExp(`^\\s*${key}\\s*:`, "m");
  return re.test(frontMatter);
}

function upsertKey(frontMatter, key, valueLine) {
  // If key exists, replace its line; otherwise add it near the top.
  const re = new RegExp(`^\\s*${key}\\s*:[^\\r\\n]*$`, "m");
  if (re.test(frontMatter)) {
    return frontMatter.replace(re, valueLine);
  }
  // Insert after first line (or at start)
  return `${valueLine}\n${frontMatter}`;
}

function convertFile(text) {
  const { frontMatter, body } = parseFrontMatter(text);

  // We only operate on files that already have front matter (your imports do).
  // If you have some without, we can support that too, but better to be safe.
  if (frontMatter === null) return null;

  const epId = extractEpisodeId(text);
  if (!epId) return null;

  let fm = frontMatter;

  // Ensure layout + captivateEpisode exist
  fm = upsertKey(fm, "layout", "layout: layouts/intelligence-captivate.njk");
  fm = upsertKey(fm, "captivateEpisode", `captivateEpisode: "${epId}"`);

  // Optional: ensure it appears in intelligence collection if your site expects it.
  // You already have tags; we won’t overwrite them. If you want to enforce a tag, we can.
  // For now: leave tags alone.

  const newBody = stripCaptivateShortcodeFromBody(body);

  const rebuilt = `---\n${fm}\n---\n${newBody}`;
  return { rebuilt, epId };
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`ERROR: Can't find ${ROOT}. Are you running this from the repo root?`);
    process.exit(1);
  }

  const files = walk(ROOT);

  let scanned = 0;
  let matched = 0;
  let rewritten = 0;
  let skippedNoId = 0;
  let skippedNoFM = 0;

  const rewrites = [];

  for (const file of files) {
    scanned += 1;
    const text = safeRead(file);
    if (!text) continue;

    if (!containsCaptivateShortcode(text)) continue;
    matched += 1;

    const rel = path.relative(process.cwd(), file);

    const parsed = parseFrontMatter(text);
    if (parsed.frontMatter === null) {
      skippedNoFM += 1;
      console.warn(`SKIP (no front matter): ${rel}`);
      continue;
    }

    const conv = convertFile(text);
    if (!conv) {
      skippedNoId += 1;
      console.warn(`SKIP (couldn't extract episode id): ${rel}`);
      continue;
    }

    const bakPath = `${file}.bak`;

    if (!DRY_RUN) {
      if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, text, "utf8");
      fs.writeFileSync(file, conv.rebuilt, "utf8");
    }

    rewritten += 1;
    rewrites.push({ file: rel, episodeId: conv.epId, backup: path.relative(process.cwd(), bakPath) });

    console.log(`${DRY_RUN ? "DRY" : "OK"}: ${rel} -> captivateEpisode=${conv.epId}`);
  }

  console.log("\n=== Captivate shortcode conversion summary ===");
  console.log(`Scanned:   ${scanned}`);
  console.log(`Matched:   ${matched} (contained Captivate shortcode)`);
  console.log(`Rewritten: ${rewritten}${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(`Skipped (no episode_id): ${skippedNoId}`);
  console.log(`Skipped (no front matter): ${skippedNoFM}`);

  if (rewrites.length) {
    console.log("\nFiles converted:");
    for (const r of rewrites) {
      console.log(`- ${r.file} (episode ${r.episodeId}) [backup: ${r.backup}]`);
    }
  } else {
    console.log("\nNo files were rewritten.");
  }
}

main();
