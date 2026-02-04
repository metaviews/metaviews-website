module.exports = function (eleventyConfig) {
  // Date formatting filter (no dependencies)
  eleventyConfig.addFilter("date", (value) => {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  // passthrough assets if you add them later
  eleventyConfig.addPassthroughCopy("src/assets");

  // Collections: intelligence posts + podcast episodes
  eleventyConfig.addCollection("intelligence", function (collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/intelligence/**/*.md")
      .filter((item) => !item.data.draft)
      .sort((a, b) => (b.date || 0) - (a.date || 0));
  });

  eleventyConfig.addCollection("metaviewsEpisodes", function (collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/programming/podcasts/metaviews/episodes/**/*.md")
      .filter((item) => !item.data.draft)
      .sort((a, b) => (b.date || 0) - (a.date || 0));
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
};

eleventyConfig.addCollection("tagList", function (collectionApi) {
  const tagSet = new Set();

  collectionApi.getAll().forEach((item) => {
    const tags = item.data.tags;
    if (!tags) return;
    (Array.isArray(tags) ? tags : [tags]).forEach((t) => {
      if (!t) return;
      if (["all", "nav", "post"].includes(t)) return;
      tagSet.add(String(t).toLowerCase());
    });
  });

  return Array.from(tagSet).sort();
});
eleventyConfig.addFilter("slug", (value) => {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
});
