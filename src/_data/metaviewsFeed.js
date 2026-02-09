const EleventyFetch = require("@11ty/eleventy-fetch");
const { XMLParser } = require("fast-xml-parser");

module.exports = async function () {
  const feedUrl = "https://feeds.captivate.fm/metaviews/";

  // Fetch RSS (cached to keep builds fast)
  const xml = await EleventyFetch(feedUrl, {
    duration: "30m",
    type: "text",
    fetchOptions: {
      headers: { "User-Agent": "eleventy" },
    },
  });

  // Parse RSS -> JS
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const data = parser.parse(xml);
  const channel = data?.rss?.channel || {};
  const rawItems = channel?.item || [];

  const itemsArray = Array.isArray(rawItems) ? rawItems : [rawItems];

  const safeText = (v) => (typeof v === "string" ? v.trim() : "");
  const first = (v) => (Array.isArray(v) ? v[0] : v);

  const slugify = (s) =>
    safeText(s)
      .toLowerCase()
      .replace(/&amp;/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const normalizeDate = (pubDate) => {
    const d = new Date(pubDate);
    return isNaN(d.getTime()) ? null : d;
  };

  const itunesImage =
    channel?.["itunes:image"]?.["@_href"] ||
    channel?.image?.url ||
    "";

  const home =
    safeText(channel?.link) ||
    "";

  const normalizedItems = itemsArray
    .map((it) => {
      const title = safeText(it?.title);
      const link = safeText(it?.link);
      const pubDate = safeText(it?.pubDate);
      const dateObj = normalizeDate(pubDate);

      // Episode image: try itunes:image first, then enclosure none, then channel image fallback in templates
      const image =
        it?.["itunes:image"]?.["@_href"] ||
        it?.["media:thumbnail"]?.["@_url"] ||
        "";

      // Captivate often includes itunes:duration and itunes:episode
      const duration = safeText(it?.["itunes:duration"]);
      const episodeNumber = safeText(it?.["itunes:episode"]);

      // Make a stable slug. Prefer link path last segment if present.
      let slug = "";
      try {
        if (link) {
          const u = new URL(link);
          const parts = u.pathname.split("/").filter(Boolean);
          slug = parts[parts.length - 1] || "";
        }
      } catch (e) {}

      if (!slug) slug = slugify(title);

      // Short excerpt
      const excerpt =
        safeText(first(it?.["itunes:summary"])) ||
        safeText(first(it?.description)) ||
        "";

      return {
        title,
        link,
        date: dateObj, // a real Date object
        image,
        duration,
        episodeNumber,
        slug,
        excerpt,
      };
    })
    .filter((x) => x.title && x.slug)
    .sort((a, b) => (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0));

  return {
    url: feedUrl,
    home,
    itunesImage,
    items: normalizedItems,
  };
};
