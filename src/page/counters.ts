/**
 * The draw counters — what the frame actually cost, read at the graphics API (M4.9a).
 *
 * `renderer.info` is three's own bookkeeping, and it stops being the truth the moment a game
 * uses something three does not count for itself: a post-processing composer draws its passes
 * through a renderer that resets between them, and the WebGPU path records draws into a render
 * bundle once and replays it every frame, so `info` reports the recording and not the replay.
 * A run that measured only `info` reported a blank optimization stage for exactly those two
 * shapes, which are the two shapes a good-looking game is most likely to have.
 *
 * So the counting moves one layer down, to the calls the browser itself receives: the WebGL
 * draw entry points (including the ANGLE instancing extension and multi-draw), and, on WebGPU,
 * `GPURenderPassEncoder` plus `GPURenderBundleEncoder` — a bundle's tally is remembered when it
 * is finished and added again on every `executeBundles`, which is the whole point of a bundle.
 *
 * Triangles are exact on WebGL, because the mode and the vertex count say so. On WebGPU they
 * are not knowable here (the topology lives in the pipeline, not the call), so the number is
 * null and `trianglesExact` is false; the triangle figure for a WebGPU page comes from
 * `renderer.info` instead. An indirect draw counts a call and no triangles anywhere, because
 * its arguments are in a buffer the CPU never reads.
 *
 * Everything is built from injected globals (`options.scope`) so the arithmetic is testable
 * under `node --test` against stub prototypes, with no browser and no GPU.
 */

import type { Foreign } from "./foreign.ts";

/** The counter surface's version — read before anything trusts these numbers. */
export const DRAW_VERSION = 1;

/** WebGL primitive modes whose triangle count is arithmetic on the vertex count. */
export const GL_TRIANGLES = 4;
export const GL_TRIANGLE_STRIP = 5;
export const GL_TRIANGLE_FAN = 6;

/** How many characters of a GPU error message reach the studio's error list. */
const MESSAGE_CAP = 200;

/**
 * Triangles one WebGL draw submits, exactly. A mode that draws points or lines submits none;
 * a strip or a fan of n vertices submits n - 2; a triangle list submits n / 3, rounded down
 * because the tail of an incomplete triangle is dropped by the driver too.
 */
export function trianglesFor(mode: Foreign, count: unknown, instances = 1) {
  const vertices = Number(count) || 0;
  const reps = Math.trunc(Number(instances) || 0);
  if (vertices <= 0 || reps <= 0) return 0;
  if (mode === GL_TRIANGLES) return Math.floor(vertices / 3) * reps;
  if (mode === GL_TRIANGLE_STRIP || mode === GL_TRIANGLE_FAN) return Math.max(0, vertices - 2) * reps;
  return 0;
}

/** Vertices one draw submits — the honest number even when the topology is unknown. */
export function verticesFor(count: unknown, instances = 1) {
  const vertices = Number(count) || 0;
  const reps = Math.trunc(Number(instances) || 0);
  if (vertices <= 0 || reps <= 0) return 0;
  return vertices * reps;
}

/** How the counters are installed: onto which globals, reporting where, and whether they start on. */
export interface DrawCounterOptions {
  /** The globals to wrap (the page's window by default; stub prototypes under test). */
  scope?: Foreign;
  /** Where a GPU error message goes (the page's `__studioGl.note` by default). */
  note?: (message: string) => void;
  /** Start counting at once (the default) or wait for `enable(true)`. */
  enabled?: boolean;
  /** Publish the api as `scope.__studioDraw` (the default). */
  install?: boolean;
}

/** What a draw adds beyond its calls, triangles and vertices. */
interface DrawFlags {
  indirect?: number;
  inexact?: boolean;
  unknown?: boolean;
}

/** What the counters have seen since install, and how to put every wrapped method back. */
interface Tally {
  enabled: boolean;
  drawCalls: number;
  triangles: number;
  vertices: number;
  indirect: number;
  frames: number;
  // `exact` goes false for a call whose triangle count the CPU cannot know (multi-draw,
  // indirect); `known` goes false for a backend where the topology is not in the call at all.
  exact: boolean;
  known: boolean;
  frameCalls: number;
  frameTriangles: number;
  frameVertices: number;
  last: { drawCalls: number; triangles: number; vertices: number };
  restores: Array<() => void>;
}

function addDraw(t: Tally, calls: number, tris: number, verts: number, flags: DrawFlags = {}) {
  if (!t.enabled) return;
  t.drawCalls += calls;
  t.frameCalls += calls;
  if (flags.indirect) t.indirect += flags.indirect;
  if (flags.inexact) t.exact = false;
  if (flags.unknown) t.known = false;
  t.triangles += tris;
  t.frameTriangles += tris;
  t.vertices += verts;
  t.frameVertices += verts;
}

/**
 * Replace one prototype method, remembering how to put the original back with its own
 * identity — `end()` must leave a page indistinguishable from one the studio never touched.
 */
function patch(t: Tally, proto: Foreign, name: string, make: (original: Foreign) => Foreign) {
  if (!proto || typeof proto[name] !== "function") return;
  const original = proto[name];
  if (original.__studioCounter) return;
  let wrapper: Foreign;
  try {
    wrapper = make(original);
    wrapper.__studioCounter = true;
    const had = Object.hasOwn(proto, name);
    proto[name] = wrapper;
    t.restores.push(() => {
      if (proto[name] !== wrapper) return;
      if (had) proto[name] = original;
      else delete proto[name];
    });
  } catch {
    /* a locked-down prototype keeps its own method; the counters simply see less */
  }
}

/** A global class's prototype, or null when the page has no such class. */
const prototypeOf = (scope: Foreign, key: string): Foreign =>
  typeof scope[key] === "function" ? scope[key].prototype : null;

// ── WebGL: the draw entry points, plus the two extensions three reaches for ──
function patchWebGl(t: Tally, proto: Foreign) {
  patch(
    t,
    proto,
    "drawArrays",
    (original: Foreign) =>
      function drawArrays(this: Foreign, mode: Foreign, first: Foreign, count: unknown) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, 1), verticesFor(count, 1));
        return result;
      },
  );
  patch(
    t,
    proto,
    "drawElements",
    (original: Foreign) =>
      function drawElements(this: Foreign, mode: Foreign, count: unknown) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, 1), verticesFor(count, 1));
        return result;
      },
  );
  patch(
    t,
    proto,
    "drawArraysInstanced",
    (original: Foreign) =>
      function drawArraysInstanced(
        this: Foreign,
        mode: Foreign,
        first: Foreign,
        count: unknown,
        instanceCount: Foreign,
      ) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, instanceCount), verticesFor(count, instanceCount));
        return result;
      },
  );
  patch(
    t,
    proto,
    "drawElementsInstanced",
    (original: Foreign) =>
      function drawElementsInstanced(
        this: Foreign,
        mode: Foreign,
        count: unknown,
        type: Foreign,
        offset: Foreign,
        instanceCount: Foreign,
      ) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, instanceCount), verticesFor(count, instanceCount));
        return result;
      },
  );
  patch(
    t,
    proto,
    "drawRangeElements",
    (original: Foreign) =>
      function drawRangeElements(this: Foreign, mode: Foreign, start: Foreign, end: Foreign, count: unknown) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, 1), verticesFor(count, 1));
        return result;
      },
  );
}

function patchAngle(t: Tally, angle: Foreign) {
  patch(
    t,
    angle,
    "drawArraysInstancedANGLE",
    (original: Foreign) =>
      function drawArraysInstancedANGLE(
        this: Foreign,
        mode: Foreign,
        first: Foreign,
        count: unknown,
        primcount: Foreign,
      ) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, primcount), verticesFor(count, primcount));
        return result;
      },
  );
  patch(
    t,
    angle,
    "drawElementsInstancedANGLE",
    (original: Foreign) =>
      function drawElementsInstancedANGLE(
        this: Foreign,
        mode: Foreign,
        count: unknown,
        type: Foreign,
        offset: Foreign,
        primcount: Foreign,
      ) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, trianglesFor(mode, count, primcount), verticesFor(count, primcount));
        return result;
      },
  );
}

// Multi-draw submits a list the CPU would have to read back to count; the call count is
// honest and the triangle number stops claiming to be exact.
function patchMultiDraw(t: Tally, multi: Foreign) {
  const multiDraw = (original: Foreign) =>
    function multiDrawWEBGL(this: Foreign) {
      const result = original.apply(this, arguments);
      const count = Math.max(0, Math.trunc(Number(arguments[arguments.length - 1]) || 0));
      addDraw(t, count, 0, 0, { inexact: true });
      return result;
    };
  patch(t, multi, "multiDrawArraysWEBGL", multiDraw);
  patch(t, multi, "multiDrawElementsWEBGL", multiDraw);
}

/** A bundle's draws, remembered when it is recorded and added again every time it is executed. */
interface BundleTally {
  drawCalls: number;
  vertices: number;
  indirect: number;
  inexact: boolean;
}

// ── WebGPU: the pass encoder, and bundles that are recorded once and replayed ──
function patchRenderPass(t: Tally, passProto: Foreign, bundleTallies: WeakMap<object, BundleTally>) {
  patch(
    t,
    passProto,
    "draw",
    (original: Foreign) =>
      function draw(this: Foreign, vertexCount: Foreign, instanceCount: Foreign) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, 0, verticesFor(vertexCount, instanceCount ?? 1), { unknown: true });
        return result;
      },
  );
  patch(
    t,
    passProto,
    "drawIndexed",
    (original: Foreign) =>
      function drawIndexed(this: Foreign, indexCount: Foreign, instanceCount: Foreign) {
        const result = original.apply(this, arguments);
        addDraw(t, 1, 0, verticesFor(indexCount, instanceCount ?? 1), { unknown: true });
        return result;
      },
  );
  for (const name of ["drawIndirect", "drawIndexedIndirect"]) {
    patch(
      t,
      passProto,
      name,
      (original: Foreign) =>
        function drawIndirectCall(this: Foreign) {
          const result = original.apply(this, arguments);
          addDraw(t, 1, 0, 0, { unknown: true, inexact: true, indirect: 1 });
          return result;
        },
    );
  }
  patch(
    t,
    passProto,
    "executeBundles",
    (original: Foreign) =>
      function executeBundles(this: Foreign, bundles: Foreign) {
        const result = original.apply(this, arguments);
        for (const bundle of bundles ?? []) {
          const tally = bundleTallies.get(bundle);
          if (!tally) continue;
          addDraw(t, tally.drawCalls, 0, tally.vertices, {
            unknown: true,
            inexact: tally.inexact,
            indirect: tally.indirect,
          });
        }
        return result;
      },
  );
}

function patchRenderBundles(t: Tally, bundleProto: Foreign, bundleTallies: WeakMap<object, BundleTally>) {
  const recording = new WeakMap<object, BundleTally>();
  const record = (encoder: Foreign, calls: number, verts: number, flags: DrawFlags = {}) => {
    const tally = recording.get(encoder) ?? { drawCalls: 0, vertices: 0, indirect: 0, inexact: false };
    tally.drawCalls += calls;
    tally.vertices += verts;
    if (flags.indirect) tally.indirect += flags.indirect;
    if (flags.inexact) tally.inexact = true;
    recording.set(encoder, tally);
  };
  patch(
    t,
    bundleProto,
    "draw",
    (original: Foreign) =>
      function draw(this: Foreign, vertexCount: Foreign, instanceCount: Foreign) {
        const result = original.apply(this, arguments);
        record(this, 1, verticesFor(vertexCount, instanceCount ?? 1));
        return result;
      },
  );
  patch(
    t,
    bundleProto,
    "drawIndexed",
    (original: Foreign) =>
      function drawIndexed(this: Foreign, indexCount: Foreign, instanceCount: Foreign) {
        const result = original.apply(this, arguments);
        record(this, 1, verticesFor(indexCount, instanceCount ?? 1));
        return result;
      },
  );
  for (const name of ["drawIndirect", "drawIndexedIndirect"]) {
    patch(
      t,
      bundleProto,
      name,
      (original: Foreign) =>
        function drawIndirectCall(this: Foreign) {
          const result = original.apply(this, arguments);
          record(this, 1, 0, { indirect: 1, inexact: true });
          return result;
        },
    );
  }
  patch(
    t,
    bundleProto,
    "finish",
    (original: Foreign) =>
      function finish(this: Foreign) {
        const bundle = original.apply(this, arguments);
        const tally = recording.get(this);
        recording.delete(this);
        if (bundle && tally) bundleTallies.set(bundle, tally);
        return bundle;
      },
  );
}

/** A GPU error message, clipped to what reaches the studio's error list. */
const gpuMessage = (label: string, message: unknown) =>
  `${label}${message ? `: ${String(message).slice(0, MESSAGE_CAP)}` : ""}`;

/** Reports a device's uncaptured errors and its loss into the page's error list. */
function watchDevice(device: Foreign, note: (message: unknown) => void) {
  if (!device || typeof device !== "object") return;
  const handler = (event: Foreign) =>
    note(gpuMessage("GPU_UNCAPTURED_ERROR", event?.error?.message ?? event?.message ?? ""));
  try {
    if (typeof device.addEventListener === "function") device.addEventListener("uncapturederror", handler);
    else device.onuncapturederror = handler;
  } catch {
    /* a device that refuses a listener still reports through `lost` */
  }
  try {
    device.lost?.then?.(
      (info: Foreign) => note(gpuMessage("GPU_DEVICE_LOST", info?.reason)),
      () => {},
    );
  } catch {
    /* nothing to await */
  }
}

// ── the WebGPU error surface, into the same list GL errors go into ──
function patchAdapter(t: Tally, adapterProto: Foreign, note: (message: unknown) => void) {
  const attach = (device: Foreign) => watchDevice(device, note);
  patch(
    t,
    adapterProto,
    "requestDevice",
    (original: Foreign) =>
      function requestDevice(this: Foreign) {
        const result = original.apply(this, arguments);
        try {
          if (result && typeof result.then === "function") result.then(attach, () => {});
        } catch {
          /* a thenable that throws on `then` is not the studio's problem */
        }
        return result;
      },
  );
}

function counterApi(t: Tally, scope: Foreign) {
  const shape = () => ({
    drawCalls: t.drawCalls,
    triangles: t.known ? t.triangles : null,
    vertices: t.vertices,
    indirect: t.indirect,
    frames: t.frames,
    trianglesExact: t.known && t.exact,
    counting: t.enabled,
  });
  const api = {
    version: DRAW_VERSION,
    /** Close a frame: the frame tally becomes the last frame's, and a new one starts. */
    mark() {
      t.frames++;
      t.last = { drawCalls: t.frameCalls, triangles: t.frameTriangles, vertices: t.frameVertices };
      t.frameCalls = 0;
      t.frameTriangles = 0;
      t.frameVertices = 0;
      return { ...t.last };
    },
    /** What the last completed frame cost. */
    frame: () => ({ ...t.last, triangles: t.known ? t.last.triangles : null, trianglesExact: t.known && t.exact }),
    /** Everything since install. */
    totals: shape,
    /** A point-in-time copy — subtract two of these rather than dividing a lifetime total. */
    snapshot: () => ({ ...shape(), at: Date.now() }),
    /** The optimization observer quiets the counters around a sample; the patches stay. */
    enable(on: Foreign) {
      t.enabled = on !== false;
      return t.enabled;
    },
    enabled: () => t.enabled,
    /** Put every prototype method back with its original identity. */
    end() {
      for (const restore of t.restores.splice(0)) {
        try {
          restore();
        } catch {
          /* a prototype that was frozen after we wrapped it keeps the wrapper */
        }
      }
      t.enabled = false;
      if (scope.__studioDraw === api) delete scope.__studioDraw;
      return true;
    },
  };
  return api;
}

// Behind an accessor, not a plain property: the studio reads `__studioDraw` back by name to
// decide whether a frame drew anything, and a page that could replace the object could
// answer that question for it. Configurable, so `end()` below can still take it away.
function publish(scope: Foreign, api: unknown) {
  try {
    Object.defineProperty(scope, "__studioDraw", {
      configurable: true,
      enumerable: true,
      get: () => api,
      set: () => {},
    });
  } catch {
    scope.__studioDraw = api;
  }
}

/**
 * Install the counters on `options.scope` (the page's window by default) and answer
 * `{ mark, frame, totals, snapshot, end, enable }`. Idempotent: a second install returns the
 * first one rather than wrapping the same prototypes twice.
 */
export function installStudioDrawCounters(options: DrawCounterOptions = {}) {
  const scope = options.scope ?? globalThis;
  const existing = scope.__studioDraw;
  if (existing && existing.version === DRAW_VERSION) return existing;

  const note = (message: unknown) => {
    try {
      if (typeof options.note === "function") options.note(String(message));
      else scope.__studioGl?.note?.(String(message));
    } catch {
      /* the error list is a convenience, never a reason to break a draw */
    }
  };
  const t: Tally = {
    enabled: options.enabled !== false,
    drawCalls: 0,
    triangles: 0,
    vertices: 0,
    indirect: 0,
    frames: 0,
    exact: true,
    known: true,
    frameCalls: 0,
    frameTriangles: 0,
    frameVertices: 0,
    last: { drawCalls: 0, triangles: 0, vertices: 0 },
    restores: [],
  };
  for (const key of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
    const proto = prototypeOf(scope, key);
    if (proto) patchWebGl(t, proto);
  }
  patchAngle(t, prototypeOf(scope, "ANGLE_instanced_arrays"));
  patchMultiDraw(t, prototypeOf(scope, "WEBGL_multi_draw"));
  const bundleTallies = new WeakMap<object, BundleTally>();
  patchRenderPass(t, prototypeOf(scope, "GPURenderPassEncoder"), bundleTallies);
  patchRenderBundles(t, prototypeOf(scope, "GPURenderBundleEncoder"), bundleTallies);
  patchAdapter(t, prototypeOf(scope, "GPUAdapter"), note);
  const api = counterApi(t, scope);
  if (options.install !== false) publish(scope, api);
  return api;
}
