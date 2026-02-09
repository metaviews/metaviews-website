module.exports = function () {
  // metaviewsFeed is already loaded by src/_data/metaviewsFeed.js
  // Eleventy merges all _data files into global data, but this file can’t directly
  // import that object reliably without duplicating work.
  // So: this file is meant to be used via eleventyComputed on templates
  // OR you can swap to a single multi-feed loader later.

  return {
    // stable “registry” of podcast landing pages and their local index URLs
    shows: [
      {
        key: "metaviews",
        title: "Metaviews",
        indexUrl: "/programming/podcasts/metaviews/",
        // the episodes list comes from metaviewsFeed in templates
      },
    ],
  };
};
