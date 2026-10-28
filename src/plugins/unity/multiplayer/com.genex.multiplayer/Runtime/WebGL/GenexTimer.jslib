// WebGL wall-clock pump for GenexPump (PROTOCOL.md §6.3, §16.2). Unity's WebGL main loop runs on
// requestAnimationFrame, which stops entirely in a hidden tab, while the socket stays open: a hidden
// host would freeze the room and the clock heartbeat would stop. setInterval keeps firing there (the
// browser throttles it to about 1 Hz, as for the TypeScript SDK's timers). It calls one C# callback
// that runs only the time-driven work (heartbeat, host ticks, control timeouts, reconnect deadline).
// Unverified outside a Unity WebGL build (no Unity on the machine that wrote it).
mergeInto(LibraryManager.library, {
  GenexTimer_Start: function (intervalMs, callback) {
    if (Module.genexTimerId) return;
    Module.genexTimerId = setInterval(function () {
      {{{ makeDynCall('v', 'callback') }}}();
    }, intervalMs);
  },
  GenexTimer_Stop: function () {
    if (!Module.genexTimerId) return;
    clearInterval(Module.genexTimerId);
    Module.genexTimerId = 0;
  }
});
