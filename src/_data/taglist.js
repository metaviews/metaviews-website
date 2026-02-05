module.exports = (data) => {
  const collections = (data && data.collections) ? data.collections : {};
  const skip = new Set([
    "all",
    "nav",
    "post",
    "intelligence",
    "metaviewsEpisodes",
  ]);

  return Object.keys(collections)
    .filter((k) => !skip.has(k))
    .filter((k) => Array.isArray(collections[k]) && collections[k].length > 0)
    .sort((a, b) => a.localeCompare(b));
};
