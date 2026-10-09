// @ts-nocheck: `installProbe` is handed to Playwright as `installProbe.toString()`, so its body is
// plain browser JavaScript that monkey-patches host globals (`getContext`'s overload set, an
// `EventTarget` that is really an element, a `window.__GENEX_PROBE__` that does not exist until it
// installs it), where typing would defeat the technique rather than make it safer. It is verified
// behaviourally: `tests/conformance/eval-prober-instrument.test.ts` runs the injected source in a
// `node:vm` context against a fake DOM. The exported types below are what readers of the snapshot use.
// biome-ignore-all lint/correctness/noInnerDeclarations: installProbe is serialized with toString() into the page
/**
 * The init-script payload. `page.addInitScript` runs it in the page's OWN JavaScript context before
 * any page script executes, so cross-origin is irrelevant and the game needs no cooperation, no SDK
 * and no rebuild: audio, WebGL, errors, pointer lock and fullscreen are captured by patching the
 * constructors before the game can reach them. `probeInitSource()` is what the driver injects: one
 * self-contained expression with no free variables.
 */

/** Set on the page as `window.__GENEX_PROBE__`. */
export type ProbeHandle = {
  version: number;
  mark: (label: string) => void;
  snapshot: () => ProbeState;
  series: (fromFrame: number, fromRms: number) => ProbeSeries;
};

export type ProbeSample = { t: number; m: number; d: number };
export type ProbeRms = { t: number; c: number; rms: number; peak: number };

export type ProbeSeries = {
  installedAt: number;
  href: string;
  frames: ProbeSample[];
  rms: ProbeRms[];
  nextFrame: number;
  nextRms: number;
};

export type ProbeState = {
  version: number;
  installedAt: number;
  /**
   * The page clock at install, paired with `installedAt` (wall). Together they
   * are one `(t, wall)` pair for the document even when no mark was ever made,
   * which is what lets the prober convert this document's page times into run
   * times exactly — `installedAt` alone lands ~0.5–0.9 s late (measured: 842 ms and 511 ms of
   * page time had passed by then).
   */
  installedT: number;
  href: string;
  notes: string[];
  marks: Array<{ label: string; t: number; wall: number }>;
  errors: Array<{ t: number; message: string; stack: string | null; source: string }>;
  rejections: Array<{ t: number; message: string }>;
  resourceErrors: Array<{ t: number; url: string; tag: string }>;
  canvases: Array<{ id: number; kind: string; t: number; attrs: unknown; width: number; height: number }>;
  contextLost: Array<{ t: number; kind: string }>;
  gl: { renderer: string | null; vendor: string | null; forcedPreserveDrawingBuffer: boolean };
  raf: { calls: number; distinctFrames: number; firstT: number | null; lastT: number | null; intervals: number[] };
  frames: {
    samples: number;
    dropped: number;
    lastMean: number | null;
    sampleCostMs: number;
    mirror: { mean: number; distinctColors: number; stdDev: number; at: number } | null;
    mirrorBestColors: number;
    mirrorBestStdDev: number;
    firstNonDegenerateT: number | null;
    mirrorWidth: number;
    mirrorHeight: number;
  };
  audio: {
    contexts: Array<{
      id: number;
      t: number;
      sampleRate: number;
      states: Array<{ t: number; state: string }>;
      finalState: string;
      analyserAttached: boolean;
    }>;
    edges: Array<{ t: number; from: string; to: string; toDestination: boolean; ctx: number }>;
    edgesTotal: number;
    edgesRecordingCapped: boolean;
    edgesToDestination: number;
    distinctSources: number;
    peakRms: number;
    rmsSamples: number;
    elements: Array<{
      id: number;
      src: string;
      everPlayed: boolean;
      paused: boolean;
      muted: boolean;
      volume: number;
      currentTime: number;
      duration: number | null;
      readyState: number;
      error: string | null;
      events: Array<{ t: number; type: string }>;
    }>;
  };
  heap: { available: boolean; samples: Array<{ t: number; used: number; total: number }>; note: string };
  /**
   * THE CLICK-TO-LOCK DOOR. `requested` counts real `requestPointerLock()`
   * calls; `grantedNatively` means the browser actually locked; `shimmed` means
   * it refused and the probe engaged a synthetic lock so the game could be
   * entered anyway. All three are reported so a reader can tell a game that was
   * never asked about pointer lock from one the probe had to fake its way past.
   */
  pointerLock: {
    requested: number;
    grantedNatively: boolean;
    shimmed: boolean;
    /** Whether the synthetic lock is held right now (a game may exit it). */
    locked: boolean;
    firstRequestAtMs: number | null;
    engagedAtMs: number | null;
    exits: number;
    /**
     * DELIVERED INPUT, counted at the shim's own capture-phase listeners while
     * the synthetic lock is held. Three counters because they answer three
     * different questions, and the first cut's single one (`movesRouted`,
     * genex-prober/1) answered none of them: it counted only events the
     * fallback had patched, so `0` read as "no look input reached the game" on
     * a run whose camera swept 158°.
     *
     * `movesWhileLocked` — every mousemove / pointermove / pointerrawupdate
     * seen while locked (one physical move fires up to three of these, so it
     * counts EVENTS, not gestures). `deltasNative` — of those, the ones the
     * browser delivered with non-zero movementX/movementY of its own.
     * `deltasSupplied` — the ones that arrived with zero movement while the
     * cursor had moved, which the fallback filled in from consecutive
     * positions. A game's camera can turn on `deltasNative` alone, and on the
     * measured bare run it did.
     */
    movesWhileLocked: number;
    deltasNative: number;
    deltasSupplied: number;
    /**
     * `navigator.userActivation.isActive` at the FIRST `requestPointerLock()`
     * call — `null` when the API is absent. A request made with no activation
     * is refused for every real player too, which is the fact that separates a
     * headless refusal (the shim's case) from a defect in the game. Also
     * counted per request as `requestsWithActivation`, since a game may ask
     * once at boot and again on a click.
     */
    userActivationAtRequest: boolean | null;
    requestsWithActivation: number;
    /** How the browser refused, verbatim — the evidence that the shim was needed. */
    lastRefusal: string | null;
    /**
     * THE HEADING SINCE THE LOCK, accumulated as it happens — the record the
     * delivered-look verdict reads. It exists because the camera SAMPLES cannot
     * carry that question: the first cut's buffer took the first 4,000 frames
     * and refused the rest, the snapshot handed over the last 1,200 of THOSE,
     * and on any game past 4,000 frames the verdict read a fixed mid-run slice
     * (MEASURED on two hosted bundles: page-ms 163,879–202,052 of a 352,643 ms
     * run; 177,088–240,160 of 379,498) while its sentences claimed the
     * post-lock period. A camera that turned on the directions drag and froze
     * two minutes later was demoted on yaw that had been observed and thrown
     * away. Now every sample flushed after `engagedAtMs` feeds this record and
     * none is discarded, whatever the ring below retains.
     *
     * `sweepDeg` is the unwrapped range of the ground heading over EVERY
     * post-lock sample. `mouseSweepDeg` is the same range over only the steps
     * that followed a locked move event by at most `windowMs` — the half that
     * can be called delivery, because A/D-turn games, a follow camera swinging
     * behind a walking character and a game's own idle pan all move the
     * heading with zero mouse input. `mouseStepsUnattributable` counts steps
     * that followed a move but spanned more than the window (a sampler slower
     * than the window cannot say what inside the step was the mouse), so a
     * zero here on a slow run is legible as the sampler's, not the game's.
     */
    look: {
      windowMs: number;
      samples: number;
      headings: number;
      firstT: number | null;
      lastT: number | null;
      sweepDeg: number;
      mouseSweepDeg: number;
      mouseSteps: number;
      mouseStepsUnattributable: number;
      lastMoveT: number | null;
    };
  };
  /**
   * THE FULLSCREEN DOOR — INSTRUMENTED, NEVER SHIMMED. `requested` counts
   * real `requestFullscreen()` calls (the `webkit` alias too); `granted` is
   * read from `document.fullscreenElement` after the call settled and on
   * `fullscreenchange`, never inferred from a promise resolving;
   * `userActivationAtRequest` is read INSIDE the first call, because a
   * request with no activation is refused for every real player and that is
   * the fact that separates a headless refusal from a defect in the game.
   * No shim, deliberately: one would mask exactly that defect. Zero measured
   * games have asked so far; the first that does will say so here, and a
   * shim is built only against a run showing `requested > 0` with activation
   * live.
   */
  fullscreen: {
    requested: number;
    granted: boolean;
    firstRequestAtMs: number | null;
    userActivationAtRequest: boolean | null;
    requestsWithActivation: number;
    lastRefusal: string | null;
    refusals: number;
  };
  /**
   * The camera read from the engine's view-matrix uploads. `seen: false` means no three.js-shaped
   * view matrix was ever uploaded (a 2D game, or a renderer the hook cannot see into). `samples` are
   * the newest `retained` of `frames` (a ring), oldest first.
   */
  camera: {
    seen: boolean;
    source: string;
    note: string | null;
    frames: number;
    hooks: number;
    calls: number;
    affine: number;
    flushes: number;
    viewLocs: number;
    firstSampleT: number | null;
    retained: number;
    ringCap: number;
    samples: CameraSample[];
  };
  /** The canvases on the page at snapshot time (the instrument's own mirror excluded). */
  liveCanvases: Array<{ width: number; height: number }>;
  frameSampleCount: number;
  rmsSampleCount: number;
};

/** One engine camera reading: page-clock `t`, world position and forward axis. */
export type CameraSample = { t: number; x: number; y: number; z: number; fx: number; fy: number; fz: number };

/** Install the page-side instrument once, as `window.__GENEX_PROBE__`. Runs inside the page. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: installProbe is serialized with toString() into the page
export function installProbe() {
  if (window.__GENEX_PROBE__) return;

  var MAX_FRAME_SAMPLES = 24000;
  var MAX_RMS_SAMPLES = 24000;
  var MAX_EVENTS = 500;
  var MIRROR_W = 64;
  var MIRROR_H = 36;
  var SAMPLE_MIN_INTERVAL_MS = 24;
  var HEAP_INTERVAL_MS = 1000;
  /**
   * The camera-sample RING: the snapshot always carries the newest samples.
   * The first cut was first-come-first-kept (`push` refuses past its cap), so
   * `samples[length - 1]` — what the prober reads as "the camera now" — froze
   * at frame 4,000 and stayed stale for the rest of the run.
   */
  var CAM_RING = 1200;
  /**
   * How long after a locked move event a heading step still counts as the
   * mouse's. CHOSEN, not measured against a corpus: the soak leaves at least
   * 700 ms between a key-up and the next mouse move (its own `sleep(700)`
   * after every action), so no attributed step can begin under 200 ms after a
   * soak key was released; and the vendored FollowCamera's default
   * `smoothTime` of 0.125 s settles a delta in ~3× that by its own docblock,
   * inside the window. The directions drag follows its last key by 400 ms plus
   * a capture, so the inertia of a key ALREADY RELEASED can still leak into
   * the first attributed step there; that residue is not excluded.
   */
  var PL_LOOK_WINDOW_MS = 500;
  var AUDIBLE_RMS = 0.002;

  var perf = window.performance;
  var now = () => (perf && perf.now ? perf.now() : Date.now());

  var D = {
    version: 1,
    installedAt: Date.now(),
    installedT: now(),
    href: location.href,
    notes: [],
    marks: [],
    errors: [],
    rejections: [],
    resourceErrors: [],
    canvases: [],
    contextLost: [],
    /**
     * THE CAMERA, READ FROM THE ENGINE INSTEAD OF INFERRED FROM PIXELS.
     *
     * Three attempts at deciding "did W go forward" from screenshots failed on
     * a real game: whole-frame expansion was unusable on 6 of 8 keys, the lower
     * band turned out to be the player's car welded to the viewport (0.9
     * correlation, zero shift), and the side bands scored 0.34-0.67 on a dark
     * night scene — too weak to call without manufacturing a verdict.
     *
     * This is exact instead. It is UNIVERSAL because it hooks WebGL, not the
     * game: every three.js renderer uploads a `viewMatrix` uniform once per
     * frame, whatever the game's structure, bundler or framework. Nothing is
     * required of the game and no global `THREE` needs to exist.
     *
     * The view matrix is told apart from the projection matrix by `m[15]`: an
     * affine world-to-camera transform has 1 there, a perspective projection
     * has 0. Among the affine ones the view matrix is the one uploaded to the
     * MOST distinct programs in a frame, because every object shares it while
     * model matrices differ.
     */
    camera: {
      firstSampleT: null,
      frames: 0,
      seen: false,
      source: "webgl",
      note: null,
      hooks: 0,
      calls: 0,
      viewLocs: 0,
      affine: 0,
      flushes: 0,
      __flushers: [],
    },
    gl: { renderer: null, vendor: null, forcedPreserveDrawingBuffer: true },
    raf: { calls: 0, distinctFrames: 0, firstT: null, lastT: null, intervals: [] },
    frames: {
      samples: 0,
      dropped: 0,
      lastMean: null,
      sampleCostMs: 0,
      mirror: null,
      mirrorBestColors: 0,
      mirrorBestStdDev: 0,
      firstNonDegenerateT: null,
      mirrorWidth: MIRROR_W,
      mirrorHeight: MIRROR_H,
    },
    audio: {
      contexts: [],
      edges: [],
      edgesTotal: 0,
      edgesToDestination: 0,
      distinctSources: 0,
      peakRms: 0,
      rmsSamples: 0,
      elements: [],
    },
    heap: { available: false, samples: [], note: "" },
    pointerLock: {
      requested: 0,
      grantedNatively: false,
      shimmed: false,
      locked: false,
      firstRequestAtMs: null,
      engagedAtMs: null,
      exits: 0,
      movesWhileLocked: 0,
      deltasNative: 0,
      deltasSupplied: 0,
      userActivationAtRequest: null,
      requestsWithActivation: 0,
      lastRefusal: null,
      look: {
        windowMs: PL_LOOK_WINDOW_MS,
        samples: 0,
        headings: 0,
        firstT: null,
        lastT: null,
        sweepDeg: 0,
        mouseSweepDeg: 0,
        mouseSteps: 0,
        mouseStepsUnattributable: 0,
        lastMoveT: null,
      },
    },
    fullscreen: {
      requested: 0,
      granted: false,
      firstRequestAtMs: null,
      userActivationAtRequest: null,
      requestsWithActivation: 0,
      lastRefusal: null,
      refusals: 0,
    },
  };

  var frameSamples = [];
  var rmsSamples = [];

  function push(arr, item, cap) {
    if (arr.length >= cap) return false;
    arr.push(item);
    return true;
  }

  var camRing = new Array(CAM_RING);
  var camHead = 0;
  var camCount = 0;
  /** Every camera sample, from either route: the ring keeps the newest, the look record keeps the sweep. */
  function camPush(sample) {
    if (D.camera.firstSampleT === null) D.camera.firstSampleT = sample.t;
    camRing[camHead] = sample;
    camHead = (camHead + 1) % CAM_RING;
    if (camCount < CAM_RING) camCount++;
    plLookObserve(sample);
  }
  function camSamples() {
    var out = [];
    var start = camCount < CAM_RING ? 0 : camHead;
    for (var i = 0; i < camCount; i++) out.push(camRing[(start + i) % CAM_RING]);
    return out;
  }

  // ---------------------------------------------------------------- errors
  window.addEventListener(
    "error",
    (e) => {
      var target = e.target;
      if (target && target !== window && target.tagName) {
        push(
          D.resourceErrors,
          { t: now(), url: String(target.src || target.href || ""), tag: String(target.tagName) },
          MAX_EVENTS,
        );
        return;
      }
      push(
        D.errors,
        {
          t: now(),
          message: String((e && e.message) || (e && e.error && e.error.message) || "unknown error"),
          stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null,
          source: e && e.filename ? String(e.filename) : "",
        },
        MAX_EVENTS,
      );
    },
    true,
  );

  window.addEventListener("unhandledrejection", (e) => {
    var reason = e && e.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    push(D.rejections, { t: now(), message: String(message).slice(0, 2000) }, MAX_EVENTS);
  });

  // ---------------------------------------------------------------- pointer lock
  /**
   * THE SHIM THAT GETS THE PROBE THROUGH A CLICK-TO-LOCK DOOR.
   *
   * Measured on a first-person game: its only entrance was
   * a full-screen overlay whose click handler called `requestPointerLock()` and
   * which hid ONLY on `pointerlockchange`. Headless Chromium never grants
   * pointer lock, the promise rejected, the game swallowed the rejection, and
   * the prober clicked that overlay 17 times over 395s while the scene ran
   * perfectly behind a 94%-opaque blur. `l2.input_changes_state` and
   * `l2.no_soft_lock_5min` both failed, every judge frame was the menu, and
   * `camera.samples` held exactly one entry — the spawn position. The game was
   * complete and correct.
   *
   * First-person plus click-to-lock is the DEFAULT for the vendored
   * `FollowCamera` with `pointerLockAim`, so this was a whole GENRE the harness
   * could not enter.
   *
   * This is the SECOND deliberate perturbation of the page, after
   * `preserveDrawingBuffer`, and it is recorded in `scorecard.notes` for the
   * same reason: a reader must be able to see that the page was changed.
   *
   * THREE RULES, and each one is what keeps this from hiding a real defect.
   * 1. THE REAL LOCK WINS. The shim engages only after the browser has refused —
   *    a rejected promise, a `pointerlockerror`, a synchronous throw, or a grace
   *    period with `document.pointerLockElement` still null — and the shadowed
   *    getter returns the real element whenever there is one.
   * 2. NOTHING IS FABRICATED. `requested` counts real calls. A page that never
   *    asks is never touched: no getter is shadowed, no event is dispatched.
   * 3. IT IS OBSERVABLE. requested / grantedNatively / shimmed / firstRequestAtMs
   *    ride the snapshot, so the scorecard can say which of the three happened —
   *    including "asked, refused, and the shim did not engage either", which is
   *    the state that must demote a check rather than fail it.
   */
  var PL = D.pointerLock;
  var plElement = null;
  var plRealGet = null;
  var plPending = null;
  var plInstalled = false;
  /** Last cursor position PER EVENT TYPE — see the movement note in `plInstall`. */
  var plLastClient = {};
  var PL_GRACE_MS = 500;

  // Captured EAGERLY, before anything is shadowed, so "did the browser really
  // lock?" is answerable at every point below including inside the shim.
  try {
    var plProto = Document.prototype;
    var plDesc = null;
    while (plProto && !plDesc) {
      plDesc = Object.getOwnPropertyDescriptor(plProto, "pointerLockElement");
      if (!plDesc) plProto = Object.getPrototypeOf(plProto);
    }
    plRealGet = plDesc && plDesc.get ? plDesc.get : null;
  } catch (e) {
    plRealGet = null;
  }

  function plRealElement() {
    try {
      return plRealGet ? plRealGet.call(document) : null;
    } catch (e) {
      return null;
    }
  }

  function plFire() {
    try {
      document.dispatchEvent(new Event("pointerlockchange", { bubbles: true }));
    } catch (e) {
      /* a document that refuses a synthetic event tells us nothing we can act on */
    }
  }

  /** Shadow the three surfaces a locked game reads. Runs once, on first refusal. */
  function plInstall() {
    if (plInstalled) return;
    plInstalled = true;
    try {
      Object.defineProperty(document, "pointerLockElement", {
        configurable: true,
        get: () => plRealElement() || plElement,
      });
    } catch (e) {
      D.notes.push("pointer-lock shim could not shadow document.pointerLockElement: " + e);
    }
    // A game that exits the lock (Escape, a pause menu) must get its overlay back.
    try {
      var origExit = typeof document.exitPointerLock === "function" ? document.exitPointerLock : null;
      document.exitPointerLock = () => {
        var had = plElement !== null;
        plElement = null;
        PL.locked = false;
        if (had) {
          PL.exits++;
          plFire();
        }
        try {
          return origExit ? origExit.call(document) : undefined;
        } catch (e) {
          return undefined;
        }
      };
    } catch (e) {
      /* leave the real one in place */
    }
    /**
     * MOVEMENT. A locked game steers from `movementX`/`movementY`. The first
     * cut of this comment said a CDP-dispatched mousemove carries neither
     * ("Input.dispatchMouseEvent has no field for them, so Blink leaves them at
     * 0") and that premise is FALSE: Blink derives movementX/Y from consecutive
     * event positions, CDP-dispatched or not. Measured on a first-person game:
     * the game's own `player.js` read `movementX` off `mousemove`,
     * the fallback below fired for zero events, and the camera samples show the
     * yaw sweeping 158° across the soak. `movesRouted: 0` meant "the fallback
     * was never needed" and was read as the opposite, which is why the three
     * counters that replaced it separate delivered-natively from supplied.
     *
     * The fallback stays for the event that arrives with ZERO movement while
     * the cursor position changed, filled in from the positions the events do
     * carry, at CAPTURE phase on window so the game's own handlers see the
     * patched event. The reported value WINS when it is non-zero: a browser
     * that supplies real movement is not second-guessed.
     *
     * THREE EVENT TYPES, not one: the vendored `FollowCamera` reads `movementX`
     * off a `pointermove` listener bound to the canvas, so a `mousemove`-only
     * patch was dead code for exactly the controller we ship, and a game that
     * wants unthrottled deltas listens to `pointerrawupdate`. Chromium fires
     * all three for one physical move, and the position-delta fallback must
     * track the last position PER TYPE — shared, the first type to fire would
     * consume the delta and the other two would be supplied a zero.
     *
     * The cost of the fallback is stated rather than hidden — deltas come from
     * a cursor that really moves, so it stops producing them at the viewport
     * edge, where a truly locked cursor would not.
     */
    try {
      var PL_MOVE_TYPES = ["mousemove", "pointermove", "pointerrawupdate"];
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
      var plOnMove = (e) => {
        var type = String(e.type || "mousemove");
        var last = plLastClient[type] || null;
        if (plElement) {
          PL.movesWhileLocked++;
          PL.look.lastMoveT = now();
          var dx = typeof e.movementX === "number" ? e.movementX : 0;
          var dy = typeof e.movementY === "number" ? e.movementY : 0;
          if (dx !== 0 || dy !== 0) {
            PL.deltasNative++;
          } else if (last) {
            dx = e.clientX - last.x;
            dy = e.clientY - last.y;
            if (dx !== 0 || dy !== 0) {
              try {
                Object.defineProperty(e, "movementX", { configurable: true, value: dx });
                Object.defineProperty(e, "movementY", { configurable: true, value: dy });
                PL.deltasSupplied++;
              } catch (err) {
                /* an event that refuses the shadow keeps its zeroes */
              }
            }
          }
        }
        plLastClient[type] = { x: e.clientX, y: e.clientY };
      };
      for (var mti = 0; mti < PL_MOVE_TYPES.length; mti++) {
        window.addEventListener(PL_MOVE_TYPES[mti], plOnMove, true);
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * The heading after the lock, accumulated per camera sample as it is flushed
   * (see the `look` record's docblock in `ProbeState`). Unwrapped: each step is
   * taken the short way round and summed, so a full turn is 360° and not 0.
   * A sample whose forward axis has no ground projection (straight up or down)
   * is counted but yields no step.
   */
  var plLookPrevDeg = null;
  var plLookPrevT = null;
  var plLookAcc = 0,
    plLookMin = 0,
    plLookMax = 0;
  var plMouseAcc = 0,
    plMouseMin = 0,
    plMouseMax = 0;
  function plHeadingDeg(s) {
    var fx = s.fx,
      fz = s.fz;
    if (typeof fx !== "number" || typeof fz !== "number" || !isFinite(fx) || !isFinite(fz)) return null;
    if (Math.abs(fx) < 1e-6 && Math.abs(fz) < 1e-6) return null;
    return (Math.atan2(fx, fz) * 180) / Math.PI;
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
  function plLookObserve(s) {
    if (PL.engagedAtMs === null) return;
    var L = PL.look;
    L.samples++;
    if (L.firstT === null) L.firstT = s.t;
    L.lastT = s.t;
    var h = plHeadingDeg(s);
    if (h === null) return;
    L.headings++;
    if (plLookPrevDeg !== null) {
      var step = h - plLookPrevDeg;
      while (step > 180) step -= 360;
      while (step < -180) step += 360;
      plLookAcc += step;
      if (plLookAcc < plLookMin) plLookMin = plLookAcc;
      if (plLookAcc > plLookMax) plLookMax = plLookAcc;
      L.sweepDeg = plLookMax - plLookMin;
      // A locked move landed inside (prev - window, cur]: the step is the
      // mouse's, provided the step itself is no longer than the window.
      if (L.lastMoveT !== null && L.lastMoveT > plLookPrevT - L.windowMs) {
        if (s.t - plLookPrevT <= L.windowMs) {
          plMouseAcc += step;
          if (plMouseAcc < plMouseMin) plMouseMin = plMouseAcc;
          if (plMouseAcc > plMouseMax) plMouseMax = plMouseAcc;
          L.mouseSweepDeg = plMouseMax - plMouseMin;
          L.mouseSteps++;
        } else {
          L.mouseStepsUnattributable++;
        }
      }
    }
    plLookPrevDeg = h;
    plLookPrevT = s.t;
  }

  function plLock(el, why) {
    if (!el) return;
    // The browser granted it after all — prefer reality, always.
    if (plRealElement()) {
      PL.grantedNatively = true;
      return;
    }
    if (plElement) return; // already holding a synthetic lock
    plInstall();
    plElement = el;
    PL.shimmed = true;
    PL.locked = true;
    if (PL.engagedAtMs === null) PL.engagedAtMs = now();
    PL.lastRefusal = why ? String(why).slice(0, 300) : null;
    plFire();
  }

  try {
    var origRPL = window.Element && Element.prototype ? Element.prototype.requestPointerLock : null;
    if (typeof origRPL === "function") {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
      Element.prototype.requestPointerLock = function () {
        PL.requested++;
        // Read INSIDE the call, because activation is consumed by the request
        // itself and expires ~5 s after the gesture; a value read later would
        // describe a different moment.
        var activation = null;
        try {
          var ua = window.navigator && window.navigator.userActivation;
          if (ua && typeof ua.isActive === "boolean") activation = ua.isActive;
        } catch (e) {
          activation = null;
        }
        if (PL.firstRequestAtMs === null) {
          PL.firstRequestAtMs = now();
          PL.userActivationAtRequest = activation;
        }
        if (activation === true) PL.requestsWithActivation++;
        plPending = this;
        var ret;
        try {
          ret = origRPL.apply(this, arguments);
        } catch (e) {
          plLock(this, "requestPointerLock threw: " + e);
          return undefined;
        }
        // The browser gets its grace period first; the shim is the fallback for
        // a call that neither resolves nor rejects.
        try {
          setTimeout(() => {
            if (plRealElement()) {
              PL.grantedNatively = true;
              return;
            }
            plLock(this, "no pointer lock " + PL_GRACE_MS + "ms after the request");
          }, PL_GRACE_MS);
        } catch (e) {
          /* ignore */
        }
        if (ret && typeof ret.then === "function") {
          return ret.then(
            (v) => {
              if (plRealElement()) PL.grantedNatively = true;
              return v;
            },
            /**
             * RESOLVED, never re-thrown. We just granted a lock, so a game that
             * awaits the promise must not take its error path — the two would
             * disagree about the same fact. A game that ignores the promise (the
             * measured one did) sees no difference either way.
             */
            (err) => {
              plLock(this, "requestPointerLock rejected: " + err);
            },
          );
        }
        return ret;
      };
    }
    // The legacy signature reports failure by event rather than by rejection.
    document.addEventListener(
      "pointerlockerror",
      () => {
        plLock(plPending, "pointerlockerror");
      },
      true,
    );
    document.addEventListener(
      "pointerlockchange",
      () => {
        if (plRealElement()) PL.grantedNatively = true;
      },
      true,
    );
  } catch (e) {
    D.notes.push("pointer-lock shim failed to install: " + e);
  }

  // ---------------------------------------------------------------- fullscreen
  /**
   * THE FULLSCREEN DOOR, WATCHED AND NEVER OPENED FOR THE GAME. The mirror of
   * the pointer-lock patch above with the shim left out: count the asks, read
   * the activation state inside the call, record how the browser answered,
   * and read `document.fullscreenElement` afterwards for the grant. A game
   * that gates its overlay on `fullscreenchange` the way the village gated
   * its on `pointerlockchange` would sit at that overlay for the whole run —
   * and the scorecard's `requires.fullscreen` plus `demoteForFullscreen`
   * (verdicts.ts) make that legible as a door, not as a game that ignored
   * input. The `webkit` alias is patched too, because a game written against
   * a compatibility snippet calls whichever exists.
   */
  var FS = D.fullscreen;
  function fsRealElement() {
    try {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    } catch (e) {
      return null;
    }
  }
  function fsRefused(why) {
    FS.refusals++;
    FS.lastRefusal = why ? String(why).slice(0, 300) : "refused";
  }
  function fsPatch(name) {
    var orig = window.Element && Element.prototype ? Element.prototype[name] : null;
    if (typeof orig !== "function") return;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
    Element.prototype[name] = function () {
      FS.requested++;
      var activation = null;
      try {
        var ua = window.navigator && window.navigator.userActivation;
        if (ua && typeof ua.isActive === "boolean") activation = ua.isActive;
      } catch (e) {
        activation = null;
      }
      if (FS.firstRequestAtMs === null) {
        FS.firstRequestAtMs = now();
        FS.userActivationAtRequest = activation;
      }
      if (activation === true) FS.requestsWithActivation++;
      var ret;
      try {
        ret = orig.apply(this, arguments);
      } catch (e) {
        fsRefused(name + " threw: " + e);
        throw e; // the game sees exactly what the browser did
      }
      if (ret && typeof ret.then === "function") {
        // Observed on both branches and handed back UNCHANGED: the game's own
        // `.then`/`.catch` run on the same promise, so a rejection it handles
        // is still counted here and still reaches it.
        try {
          ret.then(
            () => {
              if (fsRealElement()) FS.granted = true;
            },
            (err) => {
              fsRefused(name + " rejected: " + err);
            },
          );
        } catch (e) {
          /* a thenable that refuses a second observer tells us nothing more */
        }
      }
      return ret;
    };
  }
  try {
    fsPatch("requestFullscreen");
    fsPatch("webkitRequestFullscreen");
    document.addEventListener(
      "fullscreenchange",
      () => {
        if (fsRealElement()) FS.granted = true;
      },
      true,
    );
    document.addEventListener(
      "fullscreenerror",
      () => {
        fsRefused("fullscreenerror");
      },
      true,
    );
  } catch (e) {
    D.notes.push("fullscreen instrument failed to install: " + e);
  }

  // ---------------------------------------------------------------- WebGPU camera
  /**
   * THE SAME QUESTION, A DIFFERENT API.
   *
   * WebGPU has no `getUniformLocation` and no uniform names at runtime — WGSL
   * uniforms live in a buffer the renderer writes with `queue.writeBuffer`. So
   * the WebGL trick cannot be ported, and this is deliberately a WEAKER,
   * clearly-labelled route rather than a pretence of the same certainty.
   *
   * What it can rely on: a view matrix is a 64-byte affine block written to the
   * SAME (buffer, offset) every frame, whose last float is 1. Model matrices
   * are affine too, so a single write is ambiguous — but the camera's block is
   * the one at a STABLE address that keeps changing. Candidates are tracked per
   * address and only one that has been rewritten repeatedly is offered.
   *
   * When several addresses qualify the answer is refused rather than guessed:
   * `ambiguous` is reported and the caller falls back to the pixel routes. A
   * wrong matrix here would produce a confident, inverted verdict, which is the
   * exact failure this whole check exists to stop.
   */
  try {
    var GQ = window.GPUQueue;
    if (GQ && GQ.prototype && typeof GQ.prototype.writeBuffer === "function") {
      var origWriteBuffer = GQ.prototype.writeBuffer;
      var addrSeq = 0;
      var addrs = [];
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
      GQ.prototype.writeBuffer = function (buffer, bufferOffset, data) {
        try {
          var f = null;
          if (data instanceof Float32Array) f = data;
          else if (data && data.buffer instanceof ArrayBuffer && data.byteLength >= 64)
            f = new Float32Array(data.buffer, data.byteOffset || 0, Math.floor(data.byteLength / 4));
          if (f && f.length >= 16 && Math.abs(f[15] - 1) < 1e-6) {
            if (!buffer.__genexAddr) buffer.__genexAddr = ++addrSeq;
            var key = buffer.__genexAddr + ":" + bufferOffset;
            var rec = null;
            for (var ai = 0; ai < addrs.length; ai++)
              if (addrs[ai].key === key) {
                rec = addrs[ai];
                break;
              }
            if (!rec && addrs.length < 64) {
              rec = { key: key, writes: 0, changes: 0, last: null, m: null };
              addrs.push(rec);
            }
            if (rec) {
              rec.writes++;
              var m = Array.prototype.slice.call(f, 0, 16);
              if (rec.last !== null) {
                for (var mi = 0; mi < 16; mi++)
                  if (Math.abs(m[mi] - rec.last[mi]) > 1e-5) {
                    rec.changes++;
                    break;
                  }
              }
              rec.last = m;
              rec.m = m;
            }
          }
        } catch (e) {
          /* never break the game's own upload */
        }
        return origWriteBuffer.apply(this, arguments);
      };
      push(
        D.camera.__flushers,
        () => {
          // Only addresses that are rewritten AND actually change are camera-like.
          var live = [];
          for (var li = 0; li < addrs.length; li++) if (addrs[li].changes >= 3 && addrs[li].m) live.push(addrs[li]);
          if (live.length !== 1) {
            if (live.length > 1)
              D.camera.note =
                "webgpu: " + live.length + " candidate matrix addresses — refusing to guess which is the view matrix";
            return;
          }
          var m = live[0].m;
          var x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
          var y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
          var z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
          D.camera.seen = true;
          D.camera.source = "webgpu";
          D.camera.frames++;
          camPush({ t: now(), x: x, y: y, z: z, fx: -m[2], fy: -m[6], fz: -m[10] });
        },
        8,
      );
    }
  } catch (e) {
    /* no WebGPU in this browser */
  }

  // ---------------------------------------------------------------- canvases / WebGL
  var canvasId = 0;
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    var kind = String(type);
    var patched = attrs;
    var isWebgl = kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl";
    if (isWebgl) {
      // Forced so the drawing buffer survives compositing, which is what lets the
      // sampler below read the frame from outside the game's own render callback.
      patched = attrs ? Object.assign({}, attrs) : {};
      patched.preserveDrawingBuffer = true;
    }
    var ctx = origGetContext.call(this, type, patched);
    if (!ctx) return ctx;
    if (!this.__genexProbeSeen) this.__genexProbeSeen = {};
    if (this.__genexProbeSeen[kind]) return ctx;
    this.__genexProbeSeen[kind] = true;

    var id = ++canvasId;
    push(
      D.canvases,
      {
        id: id,
        kind: kind,
        t: now(),
        attrs: patched ? JSON.parse(JSON.stringify(patched)) : null,
        width: this.width,
        height: this.height,
      },
      200,
    );

    if (isWebgl && typeof ctx.uniformMatrix4fv === "function") {
      D.camera.hooks++;
      /**
       * THE UNIFORM'S NAME IS A STRING ARGUMENT — so ask for it by name rather
       * than guessing which matrix is the camera.
       *
       * The first attempt picked "the affine matrix uploaded most often in a
       * frame", reasoning that every object shares the view matrix. Measured on
       * a real game that heuristic never fired once: peak repeat count was 1
       * across 87,876 affine uploads, because the per-object modelViewMatrix
       * arrives first and fills any bounded buffer before the shared one shows
       * up. A cap cannot be raised out of that; the premise was wrong.
       *
       * `getUniformLocation(program, name)` is called with the literal declared
       * in the shader, and three.js's common chunk declares `uniform mat4
       * viewMatrix`. Recording the locations returned for that exact name makes
       * the later upload unambiguous — no repetition, no ordering assumption,
       * and it works for any renderer that names the uniform conventionally.
       */
      var viewLocs = [];
      var origGetUniformLocation = ctx.getUniformLocation;
      if (typeof origGetUniformLocation === "function") {
        ctx.getUniformLocation = function (program, name) {
          var loc = origGetUniformLocation.apply(this, arguments);
          try {
            if (loc && String(name) === "viewMatrix" && viewLocs.indexOf(loc) === -1 && viewLocs.length < 200) {
              viewLocs.push(loc);
              D.camera.viewLocs = viewLocs.length;
            }
          } catch (e) {
            /* never break program linking */
          }
          return loc;
        };
      }

      var pending = null;
      var origUniformMatrix4fv = ctx.uniformMatrix4fv;
      ctx.uniformMatrix4fv = function (loc, transpose, value) {
        try {
          D.camera.calls++;
          if (loc && value && value.length === 16 && viewLocs.indexOf(loc) !== -1) {
            D.camera.affine++;
            pending = Array.prototype.slice.call(value);
          }
        } catch (e) {
          /* never break the game's own render */
        }
        return origUniformMatrix4fv.apply(this, arguments);
      };

      push(
        D.camera.__flushers,
        () => {
          D.camera.flushes++;
          if (!pending) return;
          var m = pending;
          pending = null;
          // Camera world position from a world-to-camera matrix: -R^T . t.
          var x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
          var y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
          var z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
          // Camera-space forward is -Z; in world space that is -(third row of R).
          var fx = -m[2],
            fy = -m[6],
            fz = -m[10];
          D.camera.seen = true;
          D.camera.frames++;
          camPush({ t: now(), x: x, y: y, z: z, fx: fx, fy: fy, fz: fz });
        },
        8,
      );
    }
    ["webglcontextlost", "webglcontextrestored", "webglcontextcreationerror"].forEach((ev) => {
      this.addEventListener(ev, () => {
        push(D.contextLost, { t: now(), kind: ev }, MAX_EVENTS);
      });
    });

    if (isWebgl && !D.gl.renderer) {
      try {
        var dbg = ctx.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          D.gl.renderer = String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
          D.gl.vendor = String(ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        } else {
          D.gl.renderer = String(ctx.getParameter(ctx.RENDERER));
          D.gl.vendor = String(ctx.getParameter(ctx.VENDOR));
        }
      } catch (err) {
        D.notes.push("could not read WebGL renderer string");
      }
    }
    return ctx;
  };

  // ---------------------------------------------------------------- audio graph
  var inProbe = false;
  var ctxId = 0;
  var ctxRecords = [];
  var ctxByObject = typeof WeakMap === "function" ? new WeakMap() : null;
  var sourceKeys = {};

  function nodeLabel(node) {
    try {
      return node && node.constructor && node.constructor.name ? node.constructor.name : "AudioNode";
    } catch (e) {
      return "AudioNode";
    }
  }

  function trackContext(ctx) {
    var rec = {
      id: ++ctxId,
      t: now(),
      sampleRate: ctx.sampleRate || 0,
      states: [{ t: now(), state: String(ctx.state) }],
      finalState: String(ctx.state),
      analyserAttached: false,
      analyser: null,
      buffer: null,
      ctx: ctx,
    };
    ctxRecords.push(rec);
    if (ctxByObject) ctxByObject.set(ctx, rec);
    try {
      ctx.addEventListener("statechange", () => {
        rec.finalState = String(ctx.state);
        push(rec.states, { t: now(), state: String(ctx.state) }, 200);
      });
    } catch (e) {
      D.notes.push("AudioContext statechange listener failed");
    }
    try {
      inProbe = true;
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      rec.analyser = analyser;
      rec.buffer = new Float32Array(analyser.fftSize);
      rec.analyserAttached = true;
    } catch (e) {
      D.notes.push("could not create probe AnalyserNode: " + e);
    } finally {
      inProbe = false;
    }
    return rec;
  }

  function recordFor(ctx) {
    if (!ctx) return null;
    if (ctxByObject && ctxByObject.has(ctx)) return ctxByObject.get(ctx);
    for (var i = 0; i < ctxRecords.length; i++) if (ctxRecords[i].ctx === ctx) return ctxRecords[i];
    return null;
  }

  function wrapAudioCtor(Orig) {
    if (typeof Orig !== "function") return Orig;
    return new Proxy(Orig, {
      construct: (target, args, newTarget) => {
        var ctx = Reflect.construct(target, args, newTarget);
        try {
          trackContext(ctx);
        } catch (e) {
          D.notes.push("AudioContext tracking failed: " + e);
        }
        return ctx;
      },
    });
  }

  if (window.AudioContext) window.AudioContext = wrapAudioCtor(window.AudioContext);
  if (window.webkitAudioContext) window.webkitAudioContext = wrapAudioCtor(window.webkitAudioContext);

  if (window.AudioNode && window.AudioNode.prototype && window.AudioNode.prototype.connect) {
    var origConnect = AudioNode.prototype.connect;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
    AudioNode.prototype.connect = function (dest) {
      var out = origConnect.apply(this, arguments);
      if (inProbe) return out;
      try {
        var isDestination =
          typeof window.AudioDestinationNode === "function" && dest instanceof window.AudioDestinationNode;
        var rec = recordFor(this.context);
        D.audio.edgesTotal++;
        push(
          D.audio.edges,
          {
            t: now(),
            from: nodeLabel(this),
            to: nodeLabel(dest),
            toDestination: !!isDestination,
            ctx: rec ? rec.id : 0,
          },
          1000,
        );
        var key = nodeLabel(this);
        if (!sourceKeys[key]) {
          sourceKeys[key] = true;
          D.audio.distinctSources++;
        }
        if (isDestination) {
          D.audio.edgesToDestination++;
          // Tap the same signal into our analyser. The analyser is NOT connected to
          // the destination, so this adds no audio path; it only observes one.
          if (rec && rec.analyser) {
            inProbe = true;
            try {
              origConnect.call(this, rec.analyser);
            } finally {
              inProbe = false;
            }
          }
        }
      } catch (e) {
        /* observing must never break the game */
      }
      return out;
    };
  }

  // ---------------------------------------------------------------- media elements
  var mediaId = 0;
  var mediaRecords = [];
  var mediaSeen = typeof WeakSet === "function" ? new WeakSet() : null;

  function trackMedia(el) {
    if (!el || (mediaSeen && mediaSeen.has(el))) return;
    if (mediaSeen) mediaSeen.add(el);
    var rec = {
      id: ++mediaId,
      el: el,
      everPlayed: false,
      events: [],
    };
    mediaRecords.push(rec);
    ["play", "playing", "pause", "ended", "error", "stalled", "canplay"].forEach((ev) => {
      try {
        el.addEventListener(ev, () => {
          if (ev === "play" || ev === "playing") rec.everPlayed = true;
          push(rec.events, { t: now(), type: ev }, 100);
        });
      } catch (e) {
        /* ignore */
      }
    });
  }

  if (typeof window.Audio === "function") {
    window.Audio = new Proxy(window.Audio, {
      construct: (target, args, newTarget) => {
        var el = Reflect.construct(target, args, newTarget);
        try {
          trackMedia(el);
        } catch (e) {
          /* ignore */
        }
        return el;
      },
    });
  }

  if (window.HTMLMediaElement && HTMLMediaElement.prototype.play) {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        trackMedia(this);
      } catch (e) {
        /* ignore */
      }
      return origPlay.apply(this, arguments);
    };
  }

  function sweepMedia() {
    try {
      var els = document.querySelectorAll("audio, video");
      for (var i = 0; i < els.length; i++) trackMedia(els[i]);
    } catch (e) {
      /* document may not be ready */
    }
  }

  // ---------------------------------------------------------------- frame sampling
  var rawRaf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb) =>
        setTimeout(() => {
          cb(now());
        }, 16);

  var lastRafTs = null;
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
      return rawRaf((ts) => {
        D.raf.calls++;
        if (lastRafTs === null || ts !== lastRafTs) {
          if (lastRafTs !== null) push(D.raf.intervals, ts - lastRafTs, 30000);
          if (D.raf.firstT === null) D.raf.firstT = ts;
          D.raf.lastT = ts;
          D.raf.distinctFrames++;
          // One view matrix per frame: flush on the boundary the probe already
          // owns rather than adding a second clock.
          for (var cfi = 0; cfi < D.camera.__flushers.length; cfi++) {
            try {
              D.camera.__flushers[cfi]();
            } catch (e) {
              /* never break rAF */
            }
          }
          lastRafTs = ts;
        }
        return cb(ts);
      });
    };
  }

  var mirror = null;
  var mirrorCtx = null;
  var prevGrid = null;

  function ensureMirror() {
    if (mirrorCtx) return true;
    try {
      mirror = document.createElement("canvas");
      mirror.width = MIRROR_W;
      mirror.height = MIRROR_H;
      mirrorCtx = mirror.getContext("2d", { willReadFrequently: true });
      return !!mirrorCtx;
    } catch (e) {
      return false;
    }
  }

  function pickCanvas() {
    var best = null;
    var bestArea = 0;
    try {
      var list = document.getElementsByTagName("canvas");
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === mirror) continue;
        var area = (c.width || 0) * (c.height || 0);
        if (area > bestArea) {
          bestArea = area;
          best = c;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return best;
  }

  var lastSampleAt = -1e9;
  var sampleCostMs = 0;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
  function sampleFrame(t) {
    // Back off when sampling is expensive. On a heavy scene under a software
    // rasteriser the drawImage readback is not free, and the probe must never be
    // the reason a game looks slow.
    // Proportional, not a step: on a game where the readback costs ~900ms a fixed
    // 120ms floor still means the probe is most of the frame budget. Capped so the
    // series never goes so sparse that it stops being a time series.
    var minInterval = Math.min(1000, Math.max(SAMPLE_MIN_INTERVAL_MS, sampleCostMs * 4));
    if (t - lastSampleAt < minInterval) return;
    lastSampleAt = t;
    var costT0 = now();
    if (!ensureMirror()) return;
    var canvas = pickCanvas();
    if (!canvas || !canvas.width || !canvas.height) return;
    var data;
    try {
      mirrorCtx.clearRect(0, 0, MIRROR_W, MIRROR_H);
      mirrorCtx.drawImage(canvas, 0, 0, MIRROR_W, MIRROR_H);
      data = mirrorCtx.getImageData(0, 0, MIRROR_W, MIRROR_H).data;
    } catch (e) {
      D.frames.dropped++;
      return;
    }
    var n = MIRROR_W * MIRROR_H;
    var sum = 0;
    var diff = 0;
    var colours = {};
    var colourCount = 0;
    var lums = new Float64Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      var l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lums[p] = l;
      sum += l;
      var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (!colours[key]) {
        colours[key] = 1;
        colourCount++;
      }
      if (prevGrid) {
        diff += Math.abs(r - prevGrid[i]) + Math.abs(g - prevGrid[i + 1]) + Math.abs(b - prevGrid[i + 2]);
      }
    }
    var meanLum = sum / n;
    var acc = 0;
    for (var q = 0; q < n; q++) acc += (lums[q] - meanLum) * (lums[q] - meanLum);
    var stdDev = Math.sqrt(acc / n);
    D.frames.mirror = { mean: meanLum, distinctColors: colourCount, stdDev: stdDev, at: t };
    if (colourCount > D.frames.mirrorBestColors) D.frames.mirrorBestColors = colourCount;
    if (stdDev > D.frames.mirrorBestStdDev) D.frames.mirrorBestStdDev = stdDev;
    if (D.frames.firstNonDegenerateT === null && colourCount > 4 && stdDev > 0.005) {
      D.frames.firstNonDegenerateT = t;
    }
    var meanDiff = prevGrid ? diff / (n * 3) / 255 : 0;
    if (!prevGrid) prevGrid = new Uint8ClampedArray(data.length);
    prevGrid.set(data);
    D.frames.lastMean = meanLum;
    sampleCostMs = sampleCostMs * 0.8 + (now() - costT0) * 0.2;
    D.frames.sampleCostMs = sampleCostMs;
    if (push(frameSamples, { t: t, m: meanLum, d: meanDiff }, MAX_FRAME_SAMPLES)) D.frames.samples++;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
  function sampleAudio(t) {
    for (var i = 0; i < ctxRecords.length; i++) {
      var rec = ctxRecords[i];
      if (!rec.analyser || !rec.buffer) continue;
      try {
        rec.analyser.getFloatTimeDomainData(rec.buffer);
      } catch (e) {
        continue;
      }
      var sum = 0;
      var peak = 0;
      var buf = rec.buffer;
      for (var k = 0; k < buf.length; k++) {
        var v = buf[k];
        sum += v * v;
        var a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      var rms = Math.sqrt(sum / buf.length);
      if (rms > D.audio.peakRms) D.audio.peakRms = rms;
      if (push(rmsSamples, { t: t, c: rec.id, rms: rms, peak: peak }, MAX_RMS_SAMPLES)) D.audio.rmsSamples++;
    }
  }

  var lastHeapAt = -1e9;
  function sampleHeap(t) {
    if (t - lastHeapAt < HEAP_INTERVAL_MS) return;
    lastHeapAt = t;
    var mem = perf && perf.memory;
    if (!mem) {
      if (!D.heap.note) {
        D.heap.note = "performance.memory unavailable in this browser build";
      }
      return;
    }
    D.heap.available = true;
    D.heap.note =
      "performance.memory is the JS heap only; it excludes GPU, WASM and decoded-media memory, and Chromium quantises it";
    push(D.heap.samples, { t: t, used: mem.usedJSHeapSize, total: mem.totalJSHeapSize }, 2000);
  }

  var lastSweepAt = -1e9;
  function loop(t) {
    try {
      sampleFrame(t);
      sampleAudio(t);
      sampleHeap(t);
      if (t - lastSweepAt > 1000) {
        lastSweepAt = t;
        sweepMedia();
      }
    } catch (e) {
      /* the probe must never take the page down */
    }
    rawRaf(loop);
  }
  rawRaf(loop);

  // ---------------------------------------------------------------- readout
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installProbe is serialized with toString() into the page
  function mediaSnapshot() {
    var out = [];
    for (var i = 0; i < mediaRecords.length; i++) {
      var rec = mediaRecords[i];
      var el = rec.el;
      var err = null;
      try {
        err = el.error ? "code " + el.error.code : null;
      } catch (e) {
        err = null;
      }
      out.push({
        id: rec.id,
        src: String((el && (el.currentSrc || el.src)) || ""),
        everPlayed: rec.everPlayed,
        paused: !!el.paused,
        muted: !!el.muted,
        volume: typeof el.volume === "number" ? el.volume : 1,
        currentTime: typeof el.currentTime === "number" ? el.currentTime : 0,
        duration: typeof el.duration === "number" && isFinite(el.duration) ? el.duration : null,
        readyState: el.readyState || 0,
        error: err,
        events: rec.events.slice(0, 60),
      });
    }
    return out;
  }

  function contextSnapshot() {
    var out = [];
    for (var i = 0; i < ctxRecords.length; i++) {
      var rec = ctxRecords[i];
      var state = rec.finalState;
      try {
        state = String(rec.ctx.state);
      } catch (e) {
        /* ignore */
      }
      out.push({
        id: rec.id,
        t: rec.t,
        sampleRate: rec.sampleRate,
        states: rec.states.slice(0),
        finalState: state,
        analyserAttached: rec.analyserAttached,
      });
    }
    return out;
  }

  function canvasSnapshot() {
    var list = document.getElementsByTagName("canvas");
    var live = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] === mirror) continue;
      live.push({ width: list[i].width, height: list[i].height });
    }
    return live;
  }

  window.__GENEX_PROBE__ = {
    version: 1,
    audibleRmsThreshold: AUDIBLE_RMS,
    mark: (label) => {
      push(D.marks, { label: String(label), t: now(), wall: Date.now() }, 2000);
      return now();
    },
    now: now,
    series: (fromFrame, fromRms) => ({
      installedAt: D.installedAt,
      href: location.href,
      frames: frameSamples.slice(fromFrame || 0),
      rms: rmsSamples.slice(fromRms || 0),
      nextFrame: frameSamples.length,
      nextRms: rmsSamples.length,
    }),
    snapshot: () => {
      sweepMedia();
      var out = JSON.parse(
        JSON.stringify({
          version: D.version,
          installedAt: D.installedAt,
          installedT: D.installedT,
          href: D.href,
          notes: D.notes,
          marks: D.marks,
          errors: D.errors,
          rejections: D.rejections,
          resourceErrors: D.resourceErrors,
          canvases: D.canvases,
          // `seen: false` means no three.js-shaped view matrix was ever
          // uploaded — a 2D-canvas game, or a renderer that does not use one.
          // That is reported, never defaulted to an origin at zero. `samples`
          // are the NEWEST `retained` of `frames` (a ring), oldest first;
          // `firstSampleT` is the first sample ever taken, which the ring may
          // no longer hold.
          camera: {
            seen: D.camera.seen,
            source: D.camera.source,
            note: D.camera.note,
            frames: D.camera.frames,
            hooks: D.camera.hooks,
            calls: D.camera.calls,
            affine: D.camera.affine,
            flushes: D.camera.flushes,
            viewLocs: D.camera.viewLocs,
            firstSampleT: D.camera.firstSampleT,
            retained: camCount,
            ringCap: CAM_RING,
            samples: camSamples(),
          },
          contextLost: D.contextLost,
          gl: D.gl,
          raf: {
            calls: D.raf.calls,
            distinctFrames: D.raf.distinctFrames,
            firstT: D.raf.firstT,
            lastT: D.raf.lastT,
            intervals: D.raf.intervals,
          },
          frames: D.frames,
          heap: D.heap,
          // Whether the probe had to fake its way past a click-to-lock door.
          // Read by `l1.builds_and_boots` and by the two L2 demotions.
          pointerLock: D.pointerLock,
          // Whether the game asked for fullscreen, and how the browser
          // answered. Read by `requires.fullscreen` and `demoteForFullscreen`.
          fullscreen: D.fullscreen,
        }),
      );
      out.liveCanvases = canvasSnapshot();
      out.audio = {
        contexts: contextSnapshot(),
        edges: D.audio.edges.slice(0),
        edgesTotal: D.audio.edgesTotal,
        edgesRecordingCapped: D.audio.edges.length >= 1000,
        edgesToDestination: D.audio.edgesToDestination,
        distinctSources: D.audio.distinctSources,
        peakRms: D.audio.peakRms,
        rmsSamples: D.audio.rmsSamples,
        elements: mediaSnapshot(),
      };
      out.frameSampleCount = frameSamples.length;
      out.rmsSampleCount = rmsSamples.length;
      return out;
    },
  };
}

/**
 * The exact source injected into the page. Self-contained: one IIFE, no imports,
 * no free variables, so it can be reasoned about (and syntax-checked) in isolation.
 */
export function probeInitSource(): string {
  return `(${installProbe.toString()})();`;
}
