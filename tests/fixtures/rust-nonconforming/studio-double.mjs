// A dev-flavour Rust · wgpu game's stand-in on fd 3 (contract v2, NDJSON both ways), as
// `genex-studio` serves it: `ready` once with the run's nonce, protocol 2 and the capability
// receipt, then every host verb but Live's ring (`surface`, `release`: `unknown-op`, as a game with
// no frames service answers). Its simulation is a tick counter and a seed, so a seeded run is
// deterministic and `state().checksum` is a function of the seed and the ticks; `capture` writes a
// checkerboard (shifted by the tick) as top-down BGRA into `<GENEX_STATE_DIR>/captures/<seq>.bgra`
// with its FNV-1a 64. No GPU, no compiler, nothing fetched.
//
// `serveStudioGame({ defect })` serves it; a `defect` makes it fail one conformance check on
// purpose (the suite's red rows, `tests/conformance/game-conformance.test.ts`):
//   missing-verb     `timing` answers `unknown-op`;
//   nondeterministic each `seed` mixes a random salt into the checksum;
//   wrong-digest     `capture` reports the digest of other bytes than it wrote;
//   ignores-stop     `quit` is answered but ignored, SIGTERM too, and a helper runs in a session of its own;
//   orphan-child     `quit` ends the game but leaves its helper (a session of its own) running;
//   invalid-reply    `timing` answers outside its shape, so the host's port ends the game (`reply-invalid`).
//
// `serveStudioGame({ renderSettings: true })` is a game built after RQ0.7: its receipt advertises
// `renderSettingsApi`, it serves the `renderSettings` verb (a preset, an emulated device class, feature
// switches, a scale lock), `state().volatile.render` names what it runs with, `volatile.customPasses`
// lists its one custom pass (`halo`, an in-world pass at custom-pass API v1, so `degraded` names
// `custom-pass-v1-in-world`, which its v1 receipt allows) and each capture carries its `render`
// provenance (the reference class until the verb sets something). A render defect implies it:
//   render-blank-low     a capture under the low preset is one flat colour;
//   render-flaky         two captures of one state differ (the picture depends on the capture count);
//   render-ultra-flaky   two captures of one state differ under the ultra preset only (temporal history
//                        a settled capture should not see);
//   render-unnamed       `volatile.render` names another preset than the one the verb set;
//   render-no-preset     `volatile.render` carries no `preset`;
//   render-refuses-class `renderSettings` refuses an emulated device class (`unknown-device-class`);
//   render-keeps-preset  `renderSettings` answers the preset it already had instead of the one asked;
//   render-ignores-set   `renderSettings {set}` answers what was asked but changes nothing: a
//                        `renderSettings` without `set` answers what the game still runs;
//   render-dark-low      the low preset changes the look: its capture is far darker than high's;
//   render-pass-refused  after the first switch to the ultra preset, `halo` is refused (`gpu-pass-invalid`);
//   render-v1-degrade    the receipt serves only the v2 APIs, yet `degraded` names `custom-pass-v1-in-world`;
//   render-unpinned      a capture's render scale follows a calibration drawn at each boot, so two cold
//                        boots capture under different settings (the picture itself does not change);
//   render-blank-phone-default  a capture on the emulated mobile-low class with no switches (the way
//                        a weak phone draws by default) is one flat colour; with switches it draws;
//   render-ignores-features  `renderSettings` takes the preset and class but ignores the feature
//                        switches: its answer and status list none of them, and nothing is degraded for them;
//   render-extension-refused  `volatile.extensions` lists the `glow` material (Level-2, api 2), refused
//                        (`wgsl-too-large`) after the first switch to the ultra preset;
//   render-lags-change   a slow Live frame: after a change the drawn frame keeps the switches it had
//                        (`degraded` names `pipeline-change-deferred`) until a few `step`s land it, and
//                        neither a capture nor a read lands it. It conforms;
//   render-never-lands   as render-lags-change, but no number of `step`s lands a change.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** The defects a double can be started with. */
export const Defect = {
  MissingVerb: "missing-verb",
  Nondeterministic: "nondeterministic",
  WrongDigest: "wrong-digest",
  IgnoresStop: "ignores-stop",
  OrphanChild: "orphan-child",
  InvalidReply: "invalid-reply",
  RenderBlankLow: "render-blank-low",
  RenderFlaky: "render-flaky",
  RenderUnnamed: "render-unnamed",
  RenderRefusesClass: "render-refuses-class",
  RenderKeepsPreset: "render-keeps-preset",
  RenderUltraFlaky: "render-ultra-flaky",
  RenderNoPreset: "render-no-preset",
  RenderIgnoresSet: "render-ignores-set",
  RenderDarkLow: "render-dark-low",
  RenderPassRefused: "render-pass-refused",
  RenderV1Degrade: "render-v1-degrade",
  RenderUnpinned: "render-unpinned",
  RenderBlankPhoneDefault: "render-blank-phone-default",
  RenderIgnoresFeatures: "render-ignores-features",
  RenderExtensionRefused: "render-extension-refused",
  RenderLagsChange: "render-lags-change",
  RenderNeverLands: "render-never-lands",
};

/** The device class this double's probe finds, and the preset each class defaults to. */
const DETECTED_CLASS = "desktop-high";
const CLASS_DEFAULT_PRESET = { "desktop-ultra": "ultra", "desktop-high": "high", "desktop-mid": "medium", "desktop-low": "low", "mobile-high": "medium", "mobile-mid": "low", "mobile-low": "low" };
const PRESETS = ["auto", "low", "medium", "high", "ultra"];
/** The `renderSettings` verb's version the receipt advertises (`NATIVE_RENDER_SETTINGS_API_VERSION`). */
const RENDER_SETTINGS_API = 1;
/** The luma of the flat frame the blank defect captures. */
const FLAT_BGRA = [30, 30, 30, 255];
/** How much of its light the dark-low defect keeps under the low preset. */
const DARK_LOW_GAIN = 0.4;
/** The class captures are drawn as until the verb sets something (genex's `REFERENCE_CLASS`). */
const REFERENCE_CLASS = "desktop-high";
/** The presets whose captures settle over a jitter cycle (TAA on). */
const TEMPORAL_PRESETS = ["high", "ultra"];
const SETTLE_FRAMES_TEMPORAL = 8;
/** A receipt that serves only the v2 extension and custom-pass APIs. */
const V2_ONLY_APIS = { extensionApi: 2, customPassApi: 2, extensionApis: [2], customPassApis: [2] };
/** The double's one custom pass: in the world, at custom-pass API v1. */
const HALO = { name: "halo", stage: "after-opaque" };
/** The double's one Level-2 source: a v2 material. */
const GLOW = { path: "shaders/glow.wgsl", kind: "material", api: 2 };
/** How many `step`s the lags-change defect draws the switches it had for after a change. */
const LAG_STEPS = 3;
/** What the lags-change defect's `degraded` names while a change has not landed (genex's deferral). */
const CHANGE_DEFERRED = { reason: "pipeline-change-deferred", subject: "anti-aliasing" };
/** The emulated class the blank-phone-default defect draws flat without switches. */
const BLANK_PHONE_CLASS = "mobile-low";

/** The world the stub renders, in pixels. */
const WORLD = { width: 64, height: 36 };
/** One checker square's side, in pixels. */
const SQUARE_PX = 8;
/** A tick, in milliseconds (1/60 s). */
const TICK_MS = 1000 / 60;
/** The most ticks one `step` runs. */
const STEP_TICKS_MAX = 36_000;
/** How many ticks the `walk` demo advances. */
const DEMO_TICKS = 120;
/** The game's own named camera, beside `default`. */
const CAMERAS = ["default", "top"];
const DEMOS = ["walk"];
/** How long a helper left behind lives at most, so a failed test never leaks it for long. */
const HELPER_LIFETIME_MS = 60_000;

/** FNV-1a 64 of `bytes`, 16 lowercase hex: the digest every capture declares. */
function fnv(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The checkerboard shifted by `shift` columns, top row first, BGRA, its colour scaled by `gain`. At tick 0 it is the fixture's fixed board. */
function frame(shift, gain = 1) {
  const bytes = Buffer.alloc(WORLD.width * WORLD.height * 4);
  for (let y = 0; y < WORLD.height; y++) {
    for (let x = 0; x < WORLD.width; x++) {
      const lit = (Math.floor((x + shift) / SQUARE_PX) + Math.floor(y / SQUARE_PX)) % 2 === 0;
      const at = (y * WORLD.width + x) * 4;
      bytes[at] = Math.round((lit ? 40 : 200) * gain);
      bytes[at + 1] = Math.round((lit ? 160 : 60) * gain);
      bytes[at + 2] = Math.round((lit ? 220 : 30) * gain);
      bytes[at + 3] = 255;
    }
  }
  return bytes;
}

/** A process in a session of its own that outlives the game unless someone ends it. */
function startHelper() {
  const code = `setTimeout(() => process.exit(0), ${HELPER_LIFETIME_MS}); setInterval(() => {}, 1000);`;
  const helper = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  helper.unref();
}

/** Serves the game on fd 3 until the studio ends it. */
export function serveStudioGame({ defect = null, renderSettings = false } = {}) {
  const rendering = renderSettings || String(defect).startsWith("render-");
  const nonce = process.env.GENEX_STUDIO_NONCE ?? "";
  const stateDir = process.env.GENEX_STATE_DIR ?? "";
  const pipe = new net.Socket({ fd: 3, readable: true, writable: true });
  const sim = { seed: 1, tick: 0, running: false, salt: "", camera: "default", muted: false };
  const render = { requested: "auto", deviceClass: null, features: {}, lock: null, verb: false, haloRefused: false, glowRefused: false };
  // The switches the last drawn frame has, and the steps until a change lands (the lags-change defect).
  const drawn = { features: {}, lagging: 0 };
  const lags = defect === Defect.RenderLagsChange || defect === Defect.RenderNeverLands;
  const drawnFeatures = () => (lags ? drawn.features : render.features);
  const classNow = () => render.deviceClass ?? DETECTED_CLASS;
  const presetNow = () => (render.requested === "auto" ? CLASS_DEFAULT_PRESET[classNow()] : render.requested);
  /** The class and preset captures are drawn with: the reference class until the verb sets something. */
  const captureClass = () => (render.verb ? classNow() : REFERENCE_CLASS);
  const capturePreset = () => (render.verb ? presetNow() : CLASS_DEFAULT_PRESET[REFERENCE_CLASS]);
  // A calibration drawn at boot: the unpinned defect lets it reach the capture's settings.
  const calibratedScale = defect === Defect.RenderUnpinned ? 0.5 + Math.random() / 2 : 1;
  let seq = 0;

  const writeLine = (value) => pipe.write(`${JSON.stringify(value)}\n`);
  const ok = (id, op, result) => writeLine({ id, ok: true, op, result });
  const refuse = (id, op, error, extra = {}) => writeLine({ id, ok: false, op, error, ...extra });

  /** The state folder, when it is one a run may write: absolute and never climbing. */
  const trustedState = () => (path.isAbsolute(stateDir) && !stateDir.split(path.sep).includes("..") ? stateDir : null);
  const checksum = () => fnv(Buffer.from(JSON.stringify({ seed: sim.seed, tick: sim.tick, salt: sim.salt })));
  const advance = (ticks) => {
    sim.tick += ticks;
  };

  function capture(id, op) {
    const state = trustedState();
    if (!state) return refuse(id, op, "no-state-dir");
    const phoneDefault = render.deviceClass === BLANK_PHONE_CLASS && Object.keys(render.features).length === 0;
    const flat =
      (defect === Defect.RenderBlankLow && presetNow() === "low") ||
      (defect === Defect.RenderBlankPhoneDefault && phoneDefault);
    // A flaky renderer's picture depends on how many captures came before (history it should have reset).
    const flaky = defect === Defect.RenderFlaky || (defect === Defect.RenderUltraFlaky && presetNow() === "ultra");
    const shift = sim.tick + (flaky ? seq : 0);
    const gain = defect === Defect.RenderDarkLow && presetNow() === "low" ? DARK_LOW_GAIN : 1;
    const bytes = flat ? Buffer.from(Array.from({ length: WORLD.width * WORLD.height }, () => FLAT_BGRA).flat()) : frame(shift % (2 * SQUARE_PX), gain);
    const dir = path.join(state, "captures");
    mkdirSync(dir, { recursive: true });
    seq += 1;
    writeFileSync(path.join(dir, `${seq}.bgra`), bytes);
    const declared = defect === Defect.WrongDigest ? fnv(Buffer.concat([bytes, Buffer.from([1])])) : fnv(bytes);
    const provenance = rendering ? { render: captureProvenance() } : {};
    ok(id, op, { seq, width: WORLD.width, height: WORLD.height, format: "bgra8", digest: declared, camera: sim.camera, ...provenance });
  }

  /** A capture's `render` provenance: the pinned profile until the verb sets something. */
  function captureProvenance() {
    const preset = capturePreset();
    return {
      preset,
      deviceClass: captureClass(),
      settingsSource: render.verb ? "verb" : "reference-class",
      scale: render.lock ?? calibratedScale,
      settleFrames: TEMPORAL_PRESETS.includes(preset) ? SETTLE_FRAMES_TEMPORAL : 1,
      historyReset: true,
      exposure: "instant",
    };
  }

  function state(id, op) {
    const safeArea = { top: 0, left: 0, bottom: 0, right: 0 };
    ok(id, op, {
      tick: sim.tick,
      frame: sim.tick,
      seed: sim.seed,
      running: sim.running,
      contractVersion: 2,
      lifecycle: "resumed",
      safeArea,
      checksum: checksum(),
      ...(rendering ? { volatile: { render: renderStatus(), customPasses: customPasses(), extensions: extensions() } } : {}),
    });
  }

  /** `state().volatile.render`: what the renderer runs with (`render-unnamed` names another preset). */
  function renderStatus() {
    const preset = defect === Defect.RenderUnnamed ? (presetNow() === "low" ? "high" : "low") : presetNow();
    // The halo pass is v1 and in the world, so the frame stays LDR: a typed degrade, never a refusal.
    const degraded = [{ reason: "custom-pass-v1-in-world", subject: HALO.name }];
    if (drawn.lagging > 0) degraded.push(CHANGE_DEFERRED);
    const status = { deviceClass: classNow(), preset, scale: 1, features: { ...drawnFeatures() }, degraded, gpuMs: null, cpuMs: null };
    if (defect === Defect.RenderNoPreset) delete status.preset;
    return status;
  }

  /** `state().volatile.customPasses`: the halo pass, refused once the pass-refused defect switched to ultra. */
  function customPasses() {
    const refused = render.haloRefused;
    return [{ ...HALO, running: !refused, code: refused ? "gpu-pass-invalid" : null }];
  }

  /** `state().volatile.extensions`: the glow material, refused once the extension-refused defect switched to ultra. */
  function extensions() {
    const code = render.glowRefused ? "wgsl-too-large" : null;
    return [{ ...GLOW, code, fault: null, detail: code ? "glow: over the class's texture limit" : null }];
  }

  /** `renderSettings`: the settings in force after the change, or a typed refusal. */
  function renderVerb(id, op, arg) {
    const change = arg?.set ?? {};
    const presetKnown = change.preset === undefined || change.preset === null || PRESETS.includes(change.preset);
    if (!presetKnown) return refuse(id, op, "unknown-preset");
    if (change.deviceClass !== undefined && change.deviceClass !== null) {
      const known = Object.hasOwn(CLASS_DEFAULT_PRESET, change.deviceClass);
      if (!known || defect === Defect.RenderRefusesClass) return refuse(id, op, "unknown-device-class");
    }
    const before = { ...render, features: { ...render.features } };
    // A null preset gives the game's own back: this double's game has none, so `auto`.
    if (change.preset !== undefined && defect !== Defect.RenderKeepsPreset) render.requested = change.preset ?? "auto";
    if (change.deviceClass !== undefined) render.deviceClass = change.deviceClass;
    if (change.features === null) render.features = {};
    if (defect !== Defect.RenderIgnoresFeatures) Object.assign(render.features, change.features ?? {});
    if (change.renderScaleLock !== undefined) render.lock = change.renderScaleLock;
    if (change.preset !== undefined || change.deviceClass !== undefined) render.verb = render.requested !== "auto" || render.deviceClass !== null;
    if (defect === Defect.RenderPassRefused && presetNow() === "ultra") render.haloRefused = true;
    if (defect === Defect.RenderExtensionRefused && presetNow() === "ultra") render.glowRefused = true;
    if (lags && arg?.set !== undefined) drawn.lagging = defect === Defect.RenderNeverLands ? Number.POSITIVE_INFINITY : LAG_STEPS;
    const answer = settingsAnswer();
    // The ignores-set defect answers what was asked, then keeps what it had.
    if (defect === Defect.RenderIgnoresSet) Object.assign(render, before);
    ok(id, op, answer);
  }

  /** What `renderSettings` answers: the settings in force. */
  function settingsAnswer() {
    return {
      preset: presetNow(),
      requested: render.requested,
      deviceClass: classNow(),
      detectedClass: DETECTED_CLASS,
      features: { ...render.features },
      renderScaleLock: render.lock,
      scale: render.lock ?? 1,
    };
  }

  function quit(id, op) {
    ok(id, op, { quitting: true });
    if (defect === Defect.IgnoresStop) return;
    setTimeout(() => process.exit(0), 10);
  }

  const verbs = {
    seed: (id, op, arg) => {
      Object.assign(sim, { seed: Number(arg?.seed ?? 0), tick: 0, running: false });
      sim.salt = defect === Defect.Nondeterministic ? String(Math.random()) : "";
      ok(id, op, { seed: sim.seed, paused: true });
    },
    start: (id, op) => {
      sim.running = true;
      ok(id, op, { running: true });
    },
    pause: (id, op) => {
      sim.running = false;
      ok(id, op, { running: false });
    },
    step: (id, op, arg) => {
      const ticks = Math.min(STEP_TICKS_MAX, Math.max(1, Math.round(Number(arg?.ms ?? TICK_MS) / TICK_MS)));
      advance(ticks);
      drawn.lagging = Math.max(0, drawn.lagging - 1);
      if (drawn.lagging === 0) drawn.features = { ...render.features };
      ok(id, op, { frame: sim.tick, simulatedMs: sim.tick * TICK_MS, steppedFrames: ticks, drawCalls: 1 });
    },
    state,
    input: (id, op) => ok(id, op, { held: [] }),
    capture,
    debugCamera: (id, op, arg) => {
      const camera = arg?.camera ?? "default";
      if (!CAMERAS.includes(camera)) return ok(id, op, { ok: false, available: CAMERAS });
      sim.camera = camera;
      ok(id, op, { ok: true, camera });
    },
    cameras: (id, op) => ok(id, op, { cameras: CAMERAS }),
    eyes: (id, op) => ok(id, op, { eyes: [] }),
    demos: (id, op) => ok(id, op, { demos: DEMOS }),
    demo: (id, op, arg) => {
      if (!DEMOS.includes(arg?.name)) return ok(id, op, { ok: false, available: DEMOS });
      advance(DEMO_TICKS);
      sim.running = false;
      ok(id, op, { ok: true, demo: arg.name, result: sim.tick });
    },
    audio: (id, op, arg) => {
      sim.muted = arg?.muted === true;
      ok(id, op, { muted: sim.muted });
    },
    audioLevel: (id, op) => ok(id, op, { rms: 0, centroid: 0 }),
    timing: (id, op) => {
      if (defect === Defect.MissingVerb) return refuse(id, op, "unknown-op");
      if (defect === Defect.InvalidReply) return ok(id, op, { frameMs: "fast", updateMs: 0, drawMs: 0, frames: 0 });
      ok(id, op, { frameMs: TICK_MS, updateMs: 0.1, drawMs: 0.1, frames: sim.tick });
    },
    quit,
    ...(rendering ? { renderSettings: renderVerb } : {}),
    front: (id, op) => ok(id, op, { fronted: false }),
    visible: (id, op, arg) => ok(id, op, { visible: arg?.visible !== false }),
  };

  function answer(request) {
    const { id, op, arg } = request;
    const serve = Object.hasOwn(verbs, op) ? verbs[op] : null;
    if (!serve) return refuse(id, op, "unknown-op");
    serve(id, op, arg);
  }

  let buffered = "";
  pipe.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      answer(JSON.parse(line));
    }
  });
  pipe.on("end", () => {
    if (defect !== Defect.IgnoresStop) process.exit(0);
  });
  pipe.on("error", () => {});

  if (defect === Defect.IgnoresStop) process.on("SIGTERM", () => {});
  if (defect === Defect.IgnoresStop || defect === Defect.OrphanChild) startHelper();

  writeLine({
    event: "ready",
    nonce,
    protocol: 2,
    contractVersion: 2,
    build: "genex fixture fd3 stub",
    backend: { api: "metal", device: "genex fixture" },
    size: WORLD,
    seed: 0,
    receipt: {
      tier: "core",
      backend: "metal",
      adapter: "genex fixture (no GPU)",
      nativeEnhanced: [],
      ...(defect === Defect.RenderV1Degrade ? V2_ONLY_APIS : { extensionApi: 1, customPassApi: 1 }),
      ...(rendering ? { renderSettingsApi: RENDER_SETTINGS_API } : {}),
    },
  });
  // Keep running until the studio ends the run.
  setInterval(() => {}, 60_000);
}
