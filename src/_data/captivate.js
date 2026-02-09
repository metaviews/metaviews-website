// src/_data/captivate.js
const EleventyFetch = require("@11ty/eleventy-fetch");
const { XMLParser } = require("fast-xml-parser");

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€”/g, "-")
    .replace(/â€“/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeUrl(u) {
  return String(u || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\/+$/, "");
}

function normalizeUrlNoScheme(u) {
  return normalizeUrl(u).replace(/^https?:\/\//, "");
}

function getLastPathSegment(url) {
  const u = normalizeUrl(url);
  if (!u) return "";
  const noQuery = u.split("?")[0].split("#")[0];
  const parts = noQuery.split("/");
  return parts[parts.length - 1] || "";
}

function slugifyTitle(str) {
  const norm = normalizeTitle(str);
  return norm.replace(/\s+/g, "-");
}

function buildSlugSuffixes(slug, minWords = 4) {
  // slug like: "26-cory-doctorow-on-the-sucks-to-be-you-society"
  // We want suffixes like: "the-sucks-to-be-you-society"
  const cleaned = String(slug || "").toLowerCase().trim();
  if (!cleaned) return [];

  const bits = cleaned.split("-").filter(Boolean);

  // If first token is numeric (episode number), drop it
  const startBits = /^\d+$/.test(bits[0]) ? bits.slice(1) : bits;

  const out = new Set();

  // Full slug without leading number
  if (startBits.length) out.add(startBits.join("-"));

  // Suffixes: join bits[i..end], only if length >= minWords
  for (let i = 0; i < startBits.length; i++) {
    const suffix = startBits.slice(i);
    if (suffix.length >= minWords) out.add(suffix.join("-"));
  }

  return Array.from(out);
}

module.exports = async function () {
  const feedUrl =
    process.env.CAPTIVATE_RSS_URL || "https://feeds.captivate.fm/metaviews/";

  const xml = await EleventyFetch(feedUrl, {
    duration: "1h",
    type: "text",
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const data = parser.parse(xml);
  const channel = data?.rss?.channel || {};
  let items = channel?.item || [];
  if (!Array.isArray(items)) items = [items];

  const normalizeArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const stripHtml = (html) =>
    String(html || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const summaryFrom = (html, maxLen = 220) => {
    const t = stripHtml(html);
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen).trim() + "...";
  };

  const episodes = items.map((it) => {
    const enclosureUrl = it?.enclosure?.["@_url"] || "";

    const guid =
      typeof it?.guid === "object" ? it?.guid?.["#text"] : it?.guid || "";

    const episodeNumber =
      it?.["itunes:episode"] || it?.["podcast:episode"] || null;

    const image =
      it?.["itunes:image"]?.["@_href"] ||
      it?.image?.url ||
      channel?.["itunes:image"]?.["@_href"] ||
      channel?.image?.url ||
      "";

    const pubDateRaw = it?.pubDate || "";
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;

    const description = it?.["content:encoded"] || it?.description || "";
    const title = it?.["itunes:title"] || it?.title || "";

    const link =
      typeof it?.link === "string" ? it.link : it?.link?.["#text"] || "";
    const linkSlug = getLastPathSegment(link);
    const slug = linkSlug || slugifyTitle(title);

    return {
      title,
      link,
      guid,
      pubDate,
      pubDateRaw,
      description,
      contentHtml: description,
      summary: summaryFrom(description, 240),
      excerpt: summaryFrom(description, 220),
      enclosureUrl,
      episodeNumber: episodeNumber !== null ? String(episodeNumber) : null,
      image,
      slug,
      categories: normalizeArray(it?.category).map((c) =>
        typeof c === "string" ? c : c?.["#text"] || ""
      ),
      _normTitle: normalizeTitle(title),
      _normLink: normalizeUrl(link),
      _normLinkNoScheme: normalizeUrlNoScheme(link),
      _linkSlug: linkSlug, // e.g. "26-cory-doctorow-on-the-sucks-to-be-you-society"
    };
  });

  const byEpisodeNumber = {};
  const byGuid = {};
  const byTitle = {};
  const byLink = {};
  const byLinkNoScheme = {};
  const bySlug = {};

  for (const ep of episodes) {
    if (ep.episodeNumber) byEpisodeNumber[ep.episodeNumber] = ep;
    if (ep.guid) byGuid[ep.guid] = ep;
    if (ep._normTitle && !byTitle[ep._normTitle]) byTitle[ep._normTitle] = ep;
    if (ep._normLink && !byLink[ep._normLink]) byLink[ep._normLink] = ep;
    if (ep._normLinkNoScheme && !byLinkNoScheme[ep._normLinkNoScheme]) {
      byLinkNoScheme[ep._normLinkNoScheme] = ep;
    }

    // slug-based indexes
    const suffixes = buildSlugSuffixes(ep._linkSlug, 4);
    for (const s of suffixes) {
      if (!bySlug[s]) bySlug[s] = ep;
    }
  }

  return {
    feedUrl,
    feed: feedUrl,
    home: typeof channel?.link === "string" ? channel.link : channel?.link?.["#text"] || "",
    itunesImage:
      channel?.["itunes:image"]?.["@_href"] ||
      channel?.image?.url ||
      "",
    items: episodes,
    itemsCount: episodes.length,
    byEpisodeNumber,
    byGuid,
    byTitle,
    byLink,
    byLinkNoScheme,
    bySlug,
  };
};
