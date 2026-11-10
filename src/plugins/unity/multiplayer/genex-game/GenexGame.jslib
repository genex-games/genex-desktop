// Written by Genex, for GenexGame in a WebGL build: the game's project as its published Genex page
// names it (window.__GENEX__.slug), Studio's local room as its preview names it
// (?genex_authority_url=ws://127.0.0.1:<port>, only a loopback room on a loopback page), and the
// published page's room servers (window.genexEmbed.getAuthorityUrls(), one per line). An empty
// string where none is named.
mergeInto(LibraryManager.library, {
  $GenexGameText: function (text) {
    var size = lengthBytesUTF8(text) + 1;
    var buffer = _malloc(size);
    stringToUTF8(text, buffer, size);
    return buffer;
  },
  GenexGame_PageSlug__deps: ['$GenexGameText'],
  GenexGame_PageSlug: function () {
    var genex = typeof window !== 'undefined' ? window.__GENEX__ : undefined;
    return GenexGameText(genex && typeof genex.slug === 'string' ? genex.slug : '');
  },
  GenexGame_LocalRoomUrl__deps: ['$GenexGameText'],
  GenexGame_LocalRoomUrl: function () {
    var loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/;
    try {
      var room = new URLSearchParams(window.location.search).get('genex_authority_url') || '';
      var url = room ? new URL(room) : null;
      var local = url && url.protocol === 'ws:' && loopback.test(url.hostname) && loopback.test(window.location.hostname);
      return GenexGameText(local ? room : '');
    } catch (e) {
      return GenexGameText('');
    }
  },
  GenexGame_PageAuthorityUrls__deps: ['$GenexGameText'],
  GenexGame_PageAuthorityUrls: function () {
    var sdk = typeof window !== 'undefined' ? window.genexEmbed : undefined;
    var urls = [];
    try {
      if (sdk && typeof sdk.getAuthorityUrls === 'function') urls = sdk.getAuthorityUrls() || [];
    } catch (e) {
      urls = [];
    }
    return GenexGameText(urls.filter(function (u) { return typeof u === 'string' && u; }).join('\n'));
  }
});
