module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");

  eleventyConfig.addGlobalData("build", {
    year: new Date().getFullYear(),
  });

  const formatDate = (dateObj) => {
    if (!dateObj) return "";
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(dateObj);
  };

  eleventyConfig.addFilter("postDate", formatDate);
  eleventyConfig.addFilter("date", formatDate);

  // Add missing Nunjucks split filter (used by intelligence-captivate.njk)
  eleventyConfig.addFilter("split", (value, delimiter = "/") => {
    return String(value || "").split(delimiter);
  });

  const intelligenceGlob =
    "src/intelligence/archive/**/*.{md,njk,html,liquid,11ty.js}";

  const effectiveDate = (item) => {
    if (item.data && item.data.date) return new Date(item.data.date);
    if (item.date) return new Date(item.date);

    const slug = item.fileSlug || "";
    const m = slug.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return new Date(`${m[1]}T00:00:00Z`);

    return new Date(0);
  };

  // Intelligence (newest-first, supports filename dates)
  eleventyConfig.addCollection("intelligence", (collectionApi) => {
    const items = collectionApi
      .getFilteredByGlob(intelligenceGlob)
      .filter((item) => item.data && item.data.layout === "layouts/intelligence-post.njk");
    return items.sort((a, b) => effectiveDate(b) - effectiveDate(a));
  });

  // Intelligence tags (unique, alphabetical)
  eleventyConfig.addCollection("intelligenceTags", (collectionApi) => {
    const items = collectionApi
      .getFilteredByGlob(intelligenceGlob)
      .filter((item) => item.data && item.data.layout === "layouts/intelligence-post.njk");
    const tagSet = new Set();

    for (const item of items) {
      const tags = item.data && item.data.tags ? item.data.tags : [];
      const tagList = Array.isArray(tags) ? tags : [tags];
      for (const tag of tagList) {
        if (typeof tag === "string" && tag.trim()) {
          tagSet.add(tag.trim());
        }
      }
    }

    return Array.from(tagSet).sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" })
    );
  });

  // Intelligence by year (newest-first)
  eleventyConfig.addCollection("intelligenceYears", (collectionApi) => {
    const items = collectionApi
      .getFilteredByGlob(intelligenceGlob)
      .filter((item) => item.data && item.data.layout === "layouts/intelligence-post.njk");
    const byYear = new Map();

    for (const item of items) {
      const date = effectiveDate(item);
      const year = date.getUTCFullYear();
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(item);
    }

    const years = Array.from(byYear.keys()).sort((a, b) => b - a);
    return years.map((year) => {
      const yearItems = byYear.get(year) || [];
      yearItems.sort((a, b) => effectiveDate(b) - effectiveDate(a));
      return { year, items: yearItems };
    });
  });

  // Metaviews episodes (newest-first)
  eleventyConfig.addCollection("metaviewsEpisodes", (collectionApi) => {
    return collectionApi
      .getFilteredByGlob("src/programming/podcasts/metaviews/episodes/**/*.md")
      .sort((a, b) => b.date - a.date);
  });

  return {
    dir: {
      input: "src",
      output: "_site",
    },
  };
};
