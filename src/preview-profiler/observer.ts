/**
 * A value of the game's page: its renderer, scene, camera, the globals it set. Read defensively.
 * Type-only, like every annotation in this file: the function below is serialized by
 * `toString()` into the page, so it may use nothing from outside its own body at runtime.
 */
// biome-ignore lint/suspicious/noExplicitAny: the untrusted page's own objects
type Foreign = any;

/** What the host asks for: where to publish `{ read, end }`, and the sample's windows. */
export interface ProfileObserverOptions {
  key: string;
  warmupMs: number;
  sampleMs: number;
  counters?: boolean;
}

/**
 * App-owned temporary observer. This function is serialized into the untrusted game page.
 * Every helper is declared inside it: `toString()` carries only this function's own body, so it
 * cannot be split into module-level steps.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: serialized by toString() into the page, so its helpers must live inside it
export function installProfileObserver(options: ProfileObserverOptions) {
  const key = options.key;
  (globalThis as Foreign)[key]?.end?.();
  // The studio's own hook (what the game rendered with) and clock: the game is never asked.
  const hook = (globalThis as Foreign).__studioHook;
  const clock = (globalThis as Foreign).__studioClock;
  const capable =
    typeof hook?.current === "function" &&
    ["start", "pause", "step", "state"].every((k) => typeof clock?.[k] === "function");
  if (!capable) return { error: "missing the studio's hook or clock on this page" };
  const inspected = hook.current();
  const renderer = inspected?.renderer;
  const scene = inspected?.scene;
  const camera = inspected?.camera;
  const drawable = typeof renderer?.render === "function" && renderer.info?.render && renderer.domElement;
  if (!renderer || !scene || !camera || !drawable) return { error: "missing renderer/scene/camera/render info" };
  const common = typeof renderer.hasInitialized === "function";
  // A common Renderer throws out of render() until init() has resolved, and a WebGPU game's
  // init() is a top-level await away. Saying so once used to skip the whole optimization stage;
  // `retryable` asks the host to come back rather than to give up.
  if (common && !renderer.hasInitialized()) return { error: "renderer is not initialized", retryable: true };
  /** The graphics API the renderer actually drew with, or null when it cannot tell. */
  function backendOf(): "webgpu" | "webgl" | null {
    if (!common) return renderer.isWebGLRenderer ? "webgl" : null;
    if (renderer.backend?.isWebGPUBackend) return "webgpu";
    return renderer.backend?.isWebGLBackend ? "webgl" : null;
  }
  const backend = backendOf();
  if (!backend) return { error: "actual renderer backend unavailable" };
  const field = common ? "drawCalls" : "calls";
  const info = renderer.info;
  if (typeof info.reset !== "function") return { error: "renderer reset capability unavailable" };
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const canvas = renderer.domElement;
  const INVENTORY_LIMIT = 100_000;
  /** Adds one scene object to the inventory's counts by its kind. */
  function countObject(out: Record<string, number>, o: Foreign) {
    if (o.isMesh) out.meshes++;
    if (o.isInstancedMesh) out.instancedObjects++;
    if (o.isInstancedMesh && finite(o.count)) out.instances += o.count;
    if (o.isLight) countLight(out, o);
    if (o.isBundleGroup) out.bundleGroups++;
  }
  /** A light, counted in all and by its type. */
  function countLight(out: Record<string, number>, o: Foreign) {
    out.lights++;
    if (/^[A-Za-z]{1,40}Light$/.test(o.type ?? "")) out[o.type] = (out[o.type] ?? 0) + 1;
  }
  function addMaterials(materials: Set<unknown>, o: Foreign) {
    if (!o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) materials.add(m);
  }
  const inventory = (root: Foreign) => {
    const out: Record<string, number> = {
      objects: 0,
      meshes: 0,
      instancedObjects: 0,
      instances: 0,
      materials: 0,
      lights: 0,
      bundleGroups: 0,
    };
    const materials = new Set();
    const stack = [root];
    let visited = 0;
    while (stack.length) {
      const o = stack.pop();
      if (++visited > INVENTORY_LIMIT) throw new Error("scene inventory exceeds limit");
      if (o !== root) out.objects++;
      countObject(out, o);
      addMaterials(materials, o);
      for (const child of o.children ?? []) stack.push(child);
    }
    out.materials = materials.size;
    return out;
  };
  // What must not change for a sample to stay valid: the surface it is drawn on and how it is
  // drawn. The camera is deliberately NOT in here — a game that swaps camera mid-sample is
  // reported through `configuration` instead, which makes the sample incomparable rather than
  // unavailable, and an unavailable sample is how a whole optimization stage used to vanish.
  const config = () => ({
    width: canvas.width,
    height: canvas.height,
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    pixelRatio: renderer.getPixelRatio?.() ?? null,
    toneMapping: renderer.toneMapping ?? null,
    exposure: renderer.toneMappingExposure ?? null,
    outputColorSpace: renderer.outputColorSpace ?? null,
    shadows: renderer.shadowMap?.enabled ?? null,
    shadowType: renderer.shadowMap?.type ?? null,
    visibility: document.visibilityState,
    counters: options.counters !== false,
  });
  let currentScene = scene;
  let currentCamera = camera;
  let sceneSwitches = 0;
  // The lens and the pose the sample actually describes — read at the end, from the camera the
  // last world frame used, so a sample never reports an abandoned camera.
  const lens = () => ({
    cameraType: currentCamera?.type ?? null,
    fov: currentCamera?.fov ?? null,
    near: currentCamera?.near ?? null,
    far: currentCamera?.far ?? null,
  });
  const view = () => ({
    position: currentCamera?.position?.toArray?.() ?? null,
    quaternion: currentCamera?.quaternion?.toArray?.() ?? null,
    projection: currentCamera?.projectionMatrix?.toArray?.() ?? null,
  });
  const initial = config();
  const counts = inventory(scene);
  // A menu -> level game renders a different scene after a switch. The hook already decides
  // which scene was the world of a frame (a HUD scene and a full-screen composer quad never
  // are), so the observer follows that decision instead of dying on the first switch.
  const worldScenes = () => {
    try {
      const s = (globalThis as Foreign).__studioHook?.scenes?.();
      return Array.isArray(s) ? s : [];
    } catch {
      return [];
    }
  };
  const isWorld = (value: Foreign) => {
    if (!value || typeof value !== "object") return false;
    if (value === currentScene) return true;
    if (!worldScenes().includes(value)) return false;
    currentScene = value;
    sceneSwitches++;
    return true;
  };
  const originalRender = renderer.render;
  const originalReset = info.reset;
  const hadRender = Object.hasOwn(renderer, "render");
  const hadReset = Object.hasOwn(info, "reset");
  let depth = 0;
  let active = false;
  let mark: number[] | null = null;
  let calls = 0;
  let triangles = 0;
  let invalidCounters = false;
  let bucket = false;
  let bucketCalls = 0;
  let bucketTriangles = 0;
  let frames = 0;
  let intervals = 0;
  let elapsedMs = 0;
  let minMs = Infinity;
  let maxMs = 0;
  let totalCalls = 0;
  let totalTriangles = 0;
  let previous: number | null = null;
  let raf: number | null = null;
  let ended = false;
  let reason: string | null = null;
  let finished = false;
  let quieted = false;
  const started = performance.now();
  const warmEnd = started + options.warmupMs;
  const endAt = warmEnd + options.sampleMs;
  const readCounters = () => [info.render[field], info.render.triangles];
  // When render bundles are in play `renderer.info` cannot see the replayed workload, so the
  // two counter metrics come from the shim's graphics-API counters instead — as the delta
  // between a snapshot taken at the end of the warm-up and one taken at the end of the sample.
  // Dividing lifetime totals by the sample's frames would count the whole boot.
  const drawApi = () => {
    try {
      return (globalThis as Foreign).__studioDraw ?? null;
    } catch {
      return null;
    }
  };
  const drawSnapshot = () => {
    try {
      const s = drawApi()?.snapshot?.();
      return s && finite(s.drawCalls) ? s : null;
    } catch {
      return null;
    }
  };
  const wantsDrawCounters = Boolean(counts.bundleGroups) && Boolean(drawSnapshot());
  let warmDraws: Foreign = null;
  let endDraws: Foreign = null;
  const flush = () => {
    const now = readCounters();
    const before = mark;
    mark = now;
    const readable = before !== null && [...before, ...now].every(finite);
    // A total that went down was reset somewhere the observer could not see.
    const wentBack = readable && (now[0] < before[0] || now[1] < before[1]);
    if (!readable || wentBack) {
      invalidCounters = true;
      return;
    }
    calls += now[0] - before[0];
    triangles += now[1] - before[1];
  };
  function reset(this: Foreign, ...args: Foreign[]) {
    if (active && options.counters !== false) flush();
    try {
      return originalReset.apply(this, args);
    } finally {
      if (active) mark = readCounters();
    }
  }
  /** Close the outer world render, whether it returned, threw, or settled a promise. */
  function finishOuter(succeeded: boolean) {
    if (options.counters !== false) flush();
    active = false;
    if (succeeded) {
      bucket = true;
      bucketCalls += calls;
      bucketTriangles += triangles;
    } else reason = "renderer threw during sample";
  }
  /** Open the outer world render: count from here, and follow the camera it draws with. */
  function beginOuter(args: Foreign[]) {
    active = true;
    calls = 0;
    triangles = 0;
    mark = readCounters();
    currentCamera = args[1] ?? currentCamera;
  }
  /** Close a deferred outer render when its promise settles. True when the result is one. */
  function settleLater(result: Foreign): boolean {
    if (!result || typeof result.then !== "function") return false;
    result.then(
      () => finishOuter(true),
      () => finishOuter(false),
    );
    return true;
  }
  function render(this: Foreign, ...args: Foreign[]) {
    const outer = depth === 0 && isWorld(args[0]);
    depth++;
    if (outer) beginOuter(args);
    let deferred = false;
    try {
      const result = originalRender.apply(this, args);
      // The common Renderer returns renderAsync() until it is initialised, and a game may call
      // renderAsync itself; either way the frame is finished when the promise settles, not when
      // the call returns. Measuring it is the point — refusing it skipped the whole stage.
      if (outer) deferred = settleLater(result);
      return result;
    } catch (err) {
      if (outer) {
        deferred = true;
        finishOuter(false);
      }
      throw err;
    } finally {
      depth--;
      if (outer && !deferred) finishOuter(true);
    }
  }
  const contextLost = () => {
    reason = "rendering device/context lost";
    end();
  };
  /** Put back a method the observer wrapped, unless the game has replaced it since. */
  function unwrap(owner: Foreign, name: string, wrapper: unknown, original: unknown, had: boolean) {
    if (owner[name] !== wrapper) return;
    if (had) owner[name] = original;
    else delete owner[name];
  }
  /** Turn the shim's graphics-API counters back on, if the observer quieted them. */
  function unquiet() {
    if (!quieted) return;
    try {
      (globalThis as Foreign).__studioGl?.count?.(true);
    } catch {
      /* an older page has no counters to restore */
    }
  }
  function end() {
    if (ended) return;
    ended = true;
    if (wantsDrawCounters && warmDraws && !endDraws) endDraws = drawSnapshot();
    if (raf !== null) cancelAnimationFrame(raf);
    unwrap(renderer, "render", render, originalRender, hadRender);
    unwrap(info, "reset", reset, originalReset, hadReset);
    unquiet();
    canvas.removeEventListener("webglcontextlost", contextLost);
  }
  const APP_PROVENANCE = "app observer / primary world render calls";
  const COUNTER_PROVENANCE = "graphics API draw counters / whole frame, warm-window delta";
  /** Fewer frame intervals than this cannot describe the sample's cadence. */
  const MIN_INTERVALS = 30;
  /** The last frame may end at most this long before the sample does, or this many mean frames. */
  const MAX_END_GAP_MS = 250;
  const MAX_END_GAP_FRAMES = 3;
  /** The share of the sample window the frames must span. */
  const MIN_COVERAGE = 0.8;
  const metric = (value: number | null, unit: string, why: string | null = null, provenance = APP_PROVENANCE) => ({
    value: finite(value) ? value : null,
    unit,
    reason: finite(value) ? null : (why ?? "not measured"),
    provenance,
  });
  /** Has the renderer, its canvas or its backend been swapped since the sample began? */
  function rendererReplaced(): boolean {
    if (renderer.domElement !== canvas) return true;
    if (!common) return false;
    const webgpu = Boolean(renderer.backend?.isWebGPUBackend) !== (backend === "webgpu");
    const webgl = Boolean(renderer.backend?.isWebGLBackend) !== (backend === "webgl");
    return webgpu || webgl;
  }
  /** Why the renderer's own counters cannot be trusted for this sample, or null. */
  function counterLimit(finalInventory: Record<string, number>): string | null {
    if (counts.bundleGroups || finalInventory.bundleGroups)
      return "render bundle counters do not cover cached workload";
    if (invalidCounters) return "invalid/reset-ambiguous counters";
    if (options.counters === false) return "counter observer disabled for overhead control";
    return null;
  }
  /** The graphics-API counters' warm-window delta, when the renderer's own counters are limited. */
  function counterFallback(limited: string | null) {
    if (!limited || !warmDraws || !endDraws || !frames) return null;
    const trianglesKnown = finite(endDraws.triangles) && finite(warmDraws.triangles);
    return {
      calls: endDraws.drawCalls - warmDraws.drawCalls,
      triangles: trianglesKnown ? endDraws.triangles - warmDraws.triangles : null,
    };
  }
  /** Why the frame timing does not describe the sample window, or null when it does. */
  function cadenceProblem(): string | null {
    if (intervals < MIN_INTERVALS) return "insufficient live render frames";
    const gapAtEnd =
      previous === null || endAt - previous > Math.max(MAX_END_GAP_MS, (MAX_END_GAP_FRAMES * elapsedMs) / intervals);
    if (elapsedMs < options.sampleMs * MIN_COVERAGE || gapAtEnd)
      return "live rendering did not cover the sample window";
    return null;
  }
  /** The draw-call and triangle metrics: the renderer's own, or the counters' fallback. */
  function workloadMetrics(limited: string | null) {
    const fallback = counterFallback(limited);
    const unmeasured = limited || !frames;
    const drawCalls = fallback
      ? metric(fallback.calls / frames, "calls/world frame", null, COUNTER_PROVENANCE)
      : metric(unmeasured ? null : totalCalls / frames, "calls/world frame", limited ?? "no world renders");
    const triangles =
      fallback && fallback.triangles !== null
        ? metric(fallback.triangles / frames, "triangles/world frame", null, COUNTER_PROVENANCE)
        : metric(unmeasured ? null : totalTriangles / frames, "triangles/world frame", limited ?? "no world renders");
    return { drawCalls, triangles };
  }
  function finishedSample() {
    const finalInventory = inventory(currentScene);
    const cadenceReason = cadenceProblem();
    const { drawCalls, triangles } = workloadMetrics(counterLimit(finalInventory));
    return {
      state: "finished",
      reason: null,
      sample: {
        schemaVersion: 1,
        backend,
        renderer: common ? "Three common Renderer" : "Three WebGLRenderer",
        // Version is stamped by the host from its bundled vendor manifest.
        // The scope string is invariant on purpose: it is compared between a baseline and a
        // candidate, and a candidate that introduced a bundle would otherwise be wholly
        // incomparable — losing the frame-time comparison too. Provenance carries the difference.
        version: "",
        scope: "world-render-call (includes internal renderer passes; excludes separate HUD/postprocess calls)",
        configuration: { ...initial, ...lens(), view: view(), sceneSwitches },
        inventory: finalInventory,
        intervals: { count: intervals, elapsedMs, minMs: intervals ? minMs : null, maxMs: intervals ? maxMs : null },
        metrics: {
          fps: metric(cadenceReason ? null : (intervals * 1000) / elapsedMs, "frames/s", cadenceReason),
          frameMs: metric(cadenceReason ? null : elapsedMs / intervals, "ms/frame", cadenceReason),
          drawCalls,
          triangles,
        },
      },
    };
  }
  /** Records why the sample no longer holds, if what it measures has changed under it. */
  function checkStillHolds() {
    if (rendererReplaced()) reason = "renderer/backend replaced";
    if (JSON.stringify(config()) !== JSON.stringify(initial)) reason = "viewport/render configuration changed";
    const current = hook.current();
    // The renderer and its canvas must hold; the scene and the camera may not, and a game that
    // switches them says so in `configuration.sceneSwitches` instead of losing the sample.
    if (current?.renderer !== renderer) reason = "inspected renderer replaced";
  }
  function read() {
    if (!finished && performance.now() >= endAt) {
      finished = true;
      end();
    }
    checkStillHolds();
    if (reason) {
      end();
      return { state: "unavailable", sample: null, reason };
    }
    if (!finished)
      return {
        state: performance.now() < warmEnd ? "warming" : "sampling",
        sample: null,
        reason: null,
        progress: { elapsedMs: performance.now() - started, frames, intervals, ended },
      };
    return finishedSample();
  }
  /** One sampled world frame: its interval since the last, and the workload it drew. */
  function recordFrame(now: number) {
    if (wantsDrawCounters && !warmDraws) warmDraws = drawSnapshot();
    if (previous !== null && now > previous) {
      const dt = now - previous;
      intervals++;
      elapsedMs += dt;
      minMs = Math.min(minMs, dt);
      maxMs = Math.max(maxMs, dt);
    }
    previous = now;
    frames++;
    totalCalls += bucketCalls;
    totalTriangles += bucketTriangles;
  }
  function tick(now: number) {
    if (ended) return;
    if (now >= endAt) {
      finished = true;
      end();
      return;
    }
    if (now >= warmEnd && bucket) recordFrame(now);
    else if (now < warmEnd) previous = null;
    bucket = false;
    bucketCalls = 0;
    bucketTriangles = 0;
    raf = requestAnimationFrame(tick);
  }
  renderer.render = render;
  info.reset = reset;
  // The shim counts draw calls at the graphics API on every frame; that wrapper is overhead
  // this sample must not pay, so it is off for the length of the sample and on again in end().
  // Backend detection through the counters is unavailable in between — everything this observer
  // reports comes from the renderer's own info, which is why it can be. The one exception is a
  // scene with render bundles, whose real workload only the counters can see: there they stay on.
  function quiet() {
    try {
      quieted = (globalThis as Foreign).__studioGl?.count?.(false) === false;
    } catch {
      /* an older page has no counters to quiet */
    }
  }
  if (!wantsDrawCounters) quiet();
  canvas.addEventListener("webglcontextlost", contextLost);
  if (backend === "webgpu") renderer.backend?.device?.lost?.then?.(contextLost).catch?.(() => {});
  (globalThis as Foreign)[key] = { read, end };
  raf = requestAnimationFrame(tick);
  return {
    backend,
    renderer: common ? "common" : "webgl",
    scope: "world-render-call",
    counters: wantsDrawCounters ? "graphics-api" : "renderer-info",
  };
}
