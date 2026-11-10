// The fast channel on a Unity WebGL player (PROTOCOL.md §17.12 *WebTransport*): a browser has no raw UDP, so the
// seat's fast@1 datagrams go by WebTransport to the room's relay. The rules are the TypeScript opener's
// (packages/multiplayer/src/authority/fast-webtransport.ts): unreliable or nothing, the relay's certificate matched by
// the hashes the binding carries, and a refused or failed session reported at once so the seat stays on the WebSocket.
// C# polls it (GenexFastWebSocket): nothing here calls back, so a datagram waits in the inbox for the next frame.
var GenexFastWebLibrary = {
  $GenexFastWeb: {
    sessions: {},
    nextId: 1,
    /** Datagrams kept while the session connects (two round trips): the newest. */
    CONNECT_QUEUE_MAX: 32,
    /** Datagrams kept between two polls: a hidden tab polls not at all, and only the newest can be applied. */
    INBOX_MAX: 1024,
    hexBytes: function (hex) {
      var out = new Uint8Array(hex.length / 2);
      for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    },
    fail: function (s) {
      if (s.state === 'closed' || s.state === 'failed') return;
      s.state = 'failed';
      s.writer = null;
      s.waiting = [];
      try {
        s.transport.close();
      } catch (e) {
        // Already closed.
      }
    },
    readAll: function (s, reader) {
      return reader.read().then(function (r) {
        if (r.done) return;
        if (s.state === 'open') {
          s.inbox.push(r.value);
          if (s.inbox.length > GenexFastWeb.INBOX_MAX) s.inbox.shift();
        }
        return GenexFastWeb.readAll(s, reader);
      });
    }
  },
  GenexFastWeb_Available: function () {
    return typeof WebTransport === 'function' ? 1 : 0;
  },
  /** A session to `url`, its certificate one of `hashes` (comma-separated hex): its id, else 0. */
  GenexFastWeb_Open__deps: ['$GenexFastWeb'],
  GenexFastWeb_Open: function (urlPtr, hashesPtr) {
    if (typeof WebTransport !== 'function') return 0;
    var url = UTF8ToString(urlPtr);
    var hashes = UTF8ToString(hashesPtr).split(',').map(function (h) {
      return { algorithm: 'sha-256', value: GenexFastWeb.hexBytes(h) };
    });
    var transport;
    try {
      transport = new WebTransport(url, { serverCertificateHashes: hashes, requireUnreliable: true, allowPooling: false, congestionControl: 'low-latency' });
    } catch (e) {
      return 0;
    }
    var id = GenexFastWeb.nextId++;
    var s = { transport: transport, state: 'connecting', writer: null, waiting: [], inbox: [] };
    GenexFastWeb.sessions[id] = s;
    var fail = function () {
      GenexFastWeb.fail(s);
    };
    transport.ready.then(function () {
      if (s.state !== 'connecting') return;
      if (transport.reliability === 'reliable-only') return fail();
      s.state = 'open';
      var datagrams = transport.datagrams;
      // Safari has createWritable() and no writable.
      var writable = datagrams.writable || (datagrams.createWritable ? datagrams.createWritable() : null);
      if (!writable) return fail();
      s.writer = writable.getWriter();
      s.waiting.forEach(function (bytes) {
        s.writer.write(bytes).catch(function () {});
      });
      s.waiting = [];
      GenexFastWeb.readAll(s, datagrams.readable.getReader()).then(fail, fail);
    }, fail);
    transport.closed.then(fail, fail);
    return id;
  },
  GenexFastWeb_Send__deps: ['$GenexFastWeb'],
  GenexFastWeb_Send: function (id, ptr, length) {
    var s = GenexFastWeb.sessions[id];
    if (!s) return;
    var bytes = HEAPU8.slice(ptr, ptr + length);
    if (s.state === 'open' && s.writer) {
      // A lost datagram is the channel's normal case: a rejected write is not a failure.
      s.writer.write(bytes).catch(function () {});
    } else if (s.state === 'connecting') {
      s.waiting.push(bytes);
      if (s.waiting.length > GenexFastWeb.CONNECT_QUEUE_MAX) s.waiting.shift();
    }
  },
  /** The next datagram into `ptr`, at most `capacity` bytes: its length, else -1. */
  GenexFastWeb_Receive__deps: ['$GenexFastWeb'],
  GenexFastWeb_Receive: function (id, ptr, capacity) {
    var s = GenexFastWeb.sessions[id];
    if (!s) return -1;
    while (s.inbox.length > 0) {
      var bytes = s.inbox.shift();
      if (bytes.length > capacity) continue;
      HEAPU8.set(bytes, ptr);
      return bytes.length;
    }
    return -1;
  },
  /** 1 once the session can never carry the channel, else 0. */
  GenexFastWeb_Failed__deps: ['$GenexFastWeb'],
  GenexFastWeb_Failed: function (id) {
    var s = GenexFastWeb.sessions[id];
    return s && s.state === 'failed' ? 1 : 0;
  },
  /** The longest datagram the session can send now, else 0 (not known yet). */
  GenexFastWeb_MaxDatagram__deps: ['$GenexFastWeb'],
  GenexFastWeb_MaxDatagram: function (id) {
    var s = GenexFastWeb.sessions[id];
    var size = s && s.state === 'open' ? s.transport.datagrams.maxDatagramSize : 0;
    return typeof size === 'number' ? size : 0;
  },
  GenexFastWeb_Close__deps: ['$GenexFastWeb'],
  GenexFastWeb_Close: function (id) {
    var s = GenexFastWeb.sessions[id];
    if (!s) return;
    delete GenexFastWeb.sessions[id];
    var was = s.state;
    s.state = 'closed';
    s.writer = null;
    if (was === 'failed') return;
    try {
      s.transport.close();
    } catch (e) {
      // Already closed.
    }
  }
};
autoAddDeps(GenexFastWebLibrary, '$GenexFastWeb');
mergeInto(LibraryManager.library, GenexFastWebLibrary);
