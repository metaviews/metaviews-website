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

  // Intelligence (newest-first, supports filename dates)
  eleventyConfig.addCollection("intelligence", (collectionApi) => {
    const items = collectionApi.getFilteredByGlob(
      "src/intelligence/archive/**/*.{md,njk,html,liquid,11ty.js}"
    );

    const effectiveDate = (item) => {
      if (item.data && item.data.date) return new Date(item.data.date);
      if (item.date) return new Date(item.date);

      const slug = item.fileSlug || "";
      const m = slug.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return new Date(`${m[1]}T00:00:00Z`);

      return new Date(0);
    };

    return items.sort((a, b) => effectiveDate(b) - effectiveDate(a));
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
