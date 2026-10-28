// Written by Genex: the game's project as its published Genex page names it (window.__GENEX__.slug),
// for GenexGame.Slug in a WebGL build. An empty string where no Genex page named one.
mergeInto(LibraryManager.library, {
  GenexGame_PageSlug: function () {
    var genex = typeof window !== 'undefined' ? window.__GENEX__ : undefined;
    var slug = genex && typeof genex.slug === 'string' ? genex.slug : '';
    var size = lengthBytesUTF8(slug) + 1;
    var buffer = _malloc(size);
    stringToUTF8(slug, buffer, size);
    return buffer;
  }
});
