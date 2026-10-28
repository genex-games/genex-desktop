// WebGL bridge to the page's @genex-ai/embed-sdk (PROTOCOL.md §3.2). The page must expose the SDK
// module as `window.genexEmbed` after calling initEmbed(...) — see the package README. The token is
// read fresh on every request and is never stored or logged here.
// Unverified outside a Unity WebGL build (no Unity on the machine that wrote it).
mergeInto(LibraryManager.library, {
  GenexEmbed_RequestAuth: function (requestId, callback) {
    function reply(obj) {
      var str = JSON.stringify(obj);
      var size = lengthBytesUTF8(str) + 1;
      var buf = _malloc(size);
      stringToUTF8(str, buf, size);
      {{{ makeDynCall('vii', 'callback') }}}(requestId, buf);
      _free(buf);
    }
    var started = Date.now();
    function attempt() {
      var sdk = typeof window !== 'undefined' ? window.genexEmbed : undefined;
      if (!sdk || typeof sdk.waitForPlayer !== 'function') {
        if (Date.now() - started > 15000) {
          reply({ error: 'window.genexEmbed is missing: load @genex-ai/embed-sdk on the page and call initEmbed()' });
          return;
        }
        setTimeout(attempt, 100);
        return;
      }
      sdk.waitForPlayer().then(function () {
        var auth = sdk.getColyseusAuth();
        var urls = typeof sdk.getColyseusUrls === 'function' ? sdk.getColyseusUrls() : [];
        if (!auth || !auth.embedToken) { reply({ error: 'no embed token yet' }); return; }
        reply({ embedToken: auth.embedToken, urls: urls || [] });
      }, function (err) {
        reply({ error: String((err && err.message) || err || 'identity blocked') });
      });
    }
    attempt();
  }
});
