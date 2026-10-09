/**
 * The renderer hook — attach, don't install (M4.2a).
 *
 * A Three.js game becomes judgeable with nothing added to it. The serve layer points the page's
 * own `three` at a wrapper module that re-exports the same module record and calls `hook()` with
 * it; from there the studio watches what the game's renderers actually draw and reads the scene,
 * the camera and the renderer off the frames themselves. A game whose `three` is inside its own
 * bundle, out of the import map's reach, gets the same thing from two lines:
 * `installStudio({ renderer, player })` calls `wrapRenderer(renderer)`.
 *
 * TWO FACTS DECIDE THE MECHANISM.
 *
 *   1. `WebGLRenderer.render` is not a prototype method in three r185: the class body is empty
 *      and the constructor assigns `this.render`.
 *   2. `three.webgpu.js` exports only `WebGPURenderer`, whose own prototype carries nothing but
 *      a constructor; `render()` and `renderAsync()` live on the unexported base class.
 *
 * So the wrapper WALKS THE PROTOTYPE CHAIN and wraps the first prototype that owns a
 * data-property function, installing the wrapped copy as an own property of the exported class's
 * prototype. Only when no prototype in the chain owns the method does it install the accessor
 * trap that captures the constructor's assignment. The naive "own data property or accessor
 * trap" rule shadows the inherited method and makes every WebGPU game throw on its first render.
 *
 * Nothing is traversed inside a render call: each call pushes one record, and the frame's records
 * are turned into observations, scored and reduced to one world by {@link endFrame}, which the
 * shim's clock runs after the last of the page's own animation-frame callbacks returns.
 *
 * Every export is a plain browser value, so the pure logic (describeObservation,
 * scoreObservation, chooseWorld, countDrawables) is tested under `node --test` with no DOM.
 */

import type { Foreign, PageGlobal } from "./foreign.ts";

/** The hook's version — the studio reads it before it trusts any of these answers. */
export const HOOK_VERSION = 1;

/** Render calls recorded in one frame. A page that renders more is drawing passes, not worlds. */
export const RECORDS_PER_FRAME = 32;

/** The scene walk stops here. A world is recognised long before the two-thousandth node. */
export const OBJECT_CAP = 2048;

/** A root's object count is re-walked no more often than this, unless its children change. */
export const COUNT_INTERVAL_MS = 500;

/** How long a scene stays in `scenes()` after the last frame that chose it. */
export const SCENE_TTL_MS = 1000;

/** The methods a renderer is watched through. */
export const WRAPPED_METHODS = Object.freeze(["render", "renderAsync", "setRenderTarget"]);

/** The import-map keys the serve layer points at this module. */
export const HOOKED_KEYS = Object.freeze(["three", "three/webgpu"]);

/** What a helper throws when there is no scene to answer about. */
export const UNAVAILABLE = "the game's scene graph is not available";

/** Why `inspect()` has nothing to answer with. Reported, never thrown, so a check can say it. */
export const NO_RENDER_REASON =
  "no scene has been rendered yet — the game has not called renderer.render(scene, camera) since load, and installStudio was not given a scene";

// ── module state ─────────────────────────────────────────────────────────────

/** A `three` namespace the serve layer handed the hook, and the renderers it wrapped there. */
interface HookedNamespace {
  key: string;
  url: string;
  revision: string | null;
  wrapped: string[];
}
/** One render call of the current frame (`record`). */
interface RenderRecord {
  renderer: Foreign;
  scene: Foreign;
  camera: Foreign;
  method: Foreign;
  depth: number;
  calls: number;
  target: Foreign;
  viewport: { width: number; height: number } | null;
  at: number;
}
/** A frame's winner: the render the frame was the world of. */
interface World {
  renderer: Foreign;
  scene: Foreign;
  camera: Foreign;
  at: number;
  score: number;
}
/** What a caller (the installed contract, a check) may hand `inspect`; the rest comes from the world. */
export interface InspectOptions {
  scene?: Foreign;
  renderer?: Foreign;
  camera?: Foreign;
  roots?: Foreign[];
  reason?: string;
  state?: Foreign;
  player?: Foreign;
  hud?: () => Foreign;
  audio?: () => Foreign;
  renderTargets?: () => Foreign[];
}

const state: {
  namespaces: HookedNamespace[];
  records: RenderRecord[];
  frames: number;
  renders: number;
  world: World | null;
  worlds: World[];
  targets: Set<Foreign>;
  driven: boolean;
  wrapErrors: string[];
} = {
  /** Every namespace the serve layer handed us: `{ key, url, revision, wrapped: [] }`. */
  namespaces: [],
  /** The current frame's render records; drained by endFrame(). */
  records: [],
  frames: 0,
  renders: 0,
  /** The last frame's winner: `{ renderer, scene, camera, at, score }`. */
  world: null,
  /** Every scene that won a frame recently, most recent first. */
  worlds: [],
  /** Render targets the page pointed a renderer at, without the builder's help. */
  targets: new Set(),
  /** Whether the frame boundary is being driven by the studio's clock. */
  driven: false,
  wrapErrors: [],
};

const wrappedInstances = new WeakSet();
const wrappedClasses = new WeakSet();
const trapped = new WeakMap();
const counts = new WeakMap();
let renderDepth = 0;
let instancesWrapped = 0;

function now() {
  try {
    return globalThis.performance ? globalThis.performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/** A navigation starts a new page: nothing about the old one is true any more. */
export function reset() {
  state.namespaces = [];
  state.records = [];
  state.frames = 0;
  state.renders = 0;
  state.world = null;
  state.worlds = [];
  state.targets = new Set();
  state.wrapErrors = [];
  renderDepth = 0;
  instancesWrapped = 0;
}

// ── wrapping ─────────────────────────────────────────────────────────────────

/**
 * The serve layer's entry point: the wrapper module calls this with the real `three` namespace.
 * Every export whose name ends in `Renderer` is watched. The namespace itself is never written
 * to — a module namespace is sealed, and re-exporting it is what keeps there being one `three`.
 */
export function hook(namespace: Foreign, key: Foreign, url: Foreign) {
  const entry: HookedNamespace = { key: String(key ?? "three"), url: String(url ?? ""), revision: null, wrapped: [] };
  state.namespaces.push(entry);
  if (!namespace || (typeof namespace !== "object" && typeof namespace !== "function")) return entry;
  entry.revision = namespaceRevision(namespace);
  for (const name of exportNames(namespace)) {
    if (!/Renderer$/.test(name)) continue;
    const ctor = rendererClass(namespace, name);
    if (ctor && wrapClass(ctor, name)) entry.wrapped.push(name);
  }
  return entry;
}

/** The namespace's `REVISION`, or null (an exotic namespace object may throw on the read). */
function namespaceRevision(namespace: Foreign): string | null {
  try {
    return typeof namespace.REVISION === "string" ? namespace.REVISION : null;
  } catch {
    /* an exotic namespace object */
    return null;
  }
}

function exportNames(namespace: Foreign): string[] {
  try {
    return Object.keys(namespace);
  } catch {
    return [];
  }
}

/** The export as a class with a prototype, or null when it is not one (or cannot be read). */
function rendererClass(namespace: Foreign, name: string): Foreign {
  let ctor = null;
  try {
    ctor = namespace[name];
  } catch {
    return null;
  }
  return typeof ctor === "function" && ctor.prototype ? ctor : null;
}

/**
 * Watch one renderer class. Returns whether anything was wrapped.
 *
 * For each watched method: walk the prototype chain for the first prototype that owns a
 * data-property function and install a wrapped copy of it as an own property of THIS class's
 * prototype (so a shared base class is left alone and an instance of the exported class still
 * reaches the original). When no prototype in the chain owns the method, the constructor is the
 * one that assigns it — install the accessor trap that catches that assignment.
 */
export function wrapClass(ctor: Foreign, name = "") {
  const proto = ctor?.prototype;
  if (!proto || wrappedClasses.has(proto)) return Boolean(proto);
  wrappedClasses.add(proto);
  let any = false;
  for (const method of WRAPPED_METHODS) {
    const owner = ownerOf(proto, method);
    try {
      if (owner) {
        const original = Object.getOwnPropertyDescriptor(owner, method)!.value;
        if (original.__studioHooked) continue;
        Object.defineProperty(proto, method, {
          configurable: true,
          writable: true,
          enumerable: false,
          value: wrapMethod(original, method),
        });
        any = true;
      } else {
        installTrap(proto, method);
        any = true;
      }
    } catch (err) {
      state.wrapErrors.push(`${name || "renderer"}.${method}: ${String(err)}`);
    }
  }
  return any;
}

/** The first prototype in the chain that owns `method` as a plain function. */
function ownerOf(proto: Foreign, method: Foreign) {
  let cursor = proto;
  while (cursor && cursor !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, method);
    if (descriptor) return typeof descriptor.value === "function" ? cursor : null;
    cursor = Object.getPrototypeOf(cursor);
  }
  return null;
}

/**
 * The last resort, and the whole mechanism for WebGL r185: the class assigns `this.render` in
 * its constructor, so the prototype carries an accessor that wraps whatever is assigned and
 * hands the wrapper back. Per instance, and never on the prototype itself.
 */
function installTrap(proto: Foreign, method: Foreign) {
  Object.defineProperty(proto, method, {
    configurable: true,
    enumerable: false,
    get() {
      const slot = trapped.get(this);
      return slot ? slot[method] : undefined;
    },
    set(value) {
      const slot = trapped.get(this) ?? {};
      slot[method] = typeof value === "function" && !value.__studioHooked ? wrapMethod(value, method) : value;
      trapped.set(this, slot);
    },
  });
}

/**
 * Watch one renderer INSTANCE — the two-line install, for a game whose `three` is inside its own
 * bundle and never passed through the serve layer's wrapper.
 */
export function wrapRenderer(instance: Foreign) {
  if (!instance || typeof instance !== "object") return false;
  if (wrappedInstances.has(instance)) return true;
  wrappedInstances.add(instance);
  instancesWrapped++;
  let any = false;
  for (const method of WRAPPED_METHODS) {
    let original = null;
    try {
      original = instance[method];
    } catch {
      continue;
    }
    if (typeof original !== "function" || original.__studioHooked) continue;
    try {
      Object.defineProperty(instance, method, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: wrapMethod(original, method),
      });
      any = true;
    } catch (err) {
      state.wrapErrors.push(`renderer.${method}: ${String(err)}`);
    }
  }
  return any;
}

function wrapMethod(original: Foreign, method: Foreign) {
  if (method === "setRenderTarget") {
    const wrapped = function studioSetRenderTarget(this: Foreign, target: Foreign, ...rest: Foreign) {
      if (target) state.targets.add(target);
      return original.call(this, target, ...rest);
    };
    wrapped.__studioHooked = true;
    return wrapped;
  }
  const wrapped = function studioRender(this: Foreign, ...args: Foreign) {
    record(this, args[0], args[1], method);
    renderDepth++;
    try {
      return original.apply(this, args);
    } finally {
      renderDepth--;
    }
  };
  wrapped.__studioHooked = true;
  return wrapped;
}

/**
 * One record per render call. `renderAsync` re-enters `render` on the same instance — after an
 * await, so a synchronous flag would already be gone — so the same renderer drawing the same
 * scene through the same camera twice in one frame is counted once.
 */
function record(renderer: Foreign, scene: Foreign, camera: Foreign, method: Foreign) {
  if (!scene || typeof scene !== "object") return null;
  for (const existing of state.records) {
    if (existing.renderer === renderer && existing.scene === scene && existing.camera === camera) {
      existing.calls++;
      return existing;
    }
  }
  if (state.records.length >= RECORDS_PER_FRAME) return null;
  state.renders++;
  const entry: RenderRecord = {
    renderer,
    scene,
    camera: camera ?? null,
    method,
    depth: renderDepth,
    calls: 1,
    target: renderTargetOf(renderer),
    viewport: drawingBufferOf(renderer),
    at: now(),
  };
  state.records.push(entry);
  return entry;
}

function renderTargetOf(renderer: Foreign) {
  try {
    return typeof renderer?.getRenderTarget === "function" ? (renderer.getRenderTarget() ?? null) : null;
  } catch {
    return null;
  }
}

function drawingBufferOf(renderer: Foreign) {
  try {
    const canvas = renderer?.domElement ?? null;
    if (canvas && Number(canvas.width) > 0) return { width: Number(canvas.width), height: Number(canvas.height) };
  } catch {
    /* a renderer without a canvas is still a renderer */
  }
  return null;
}

// ── what a render call was ───────────────────────────────────────────────────

/**
 * A render record as plain, comparable numbers. Pure but for the object counts, which are
 * memoised per root, so the same frame described twice costs one walk.
 */
export function describeObservation(record: Foreign, at = now()) {
  const scene = record?.scene ?? null;
  const camera = record?.camera ?? null;
  const target = record?.target ?? null;
  const counted = countDrawables(scene, at);
  return {
    depth: Number(record?.depth) || 0,
    method: record?.method ?? "render",
    calls: Number(record?.calls) || 1,
    toTarget: Boolean(target),
    targetSize: target ? { width: Number(target.width) || 0, height: Number(target.height) || 0 } : null,
    viewport: record?.viewport ?? null,
    cameraKind: cameraKind(camera),
    unitFrustum: isUnitFrustum(camera),
    isScene: Boolean(scene?.isScene),
    quadRoot: isQuadRoot(scene),
    drawables: counted.drawables,
    objects: counted.objects,
    capped: counted.capped,
    scene,
    camera,
    renderer: record?.renderer ?? null,
  };
}

/** Which kind of camera drew this — a cube face is never the world the player is looking at. */
export function cameraKind(camera: Foreign) {
  if (!camera || typeof camera !== "object") return "none";
  if (camera.isCubeCamera || camera.parent?.isCubeCamera || camera.type === "CubeCamera") return "cube";
  if (camera.isArrayCamera) return "array";
  if (camera.isPerspectiveCamera) return "perspective";
  if (camera.isOrthographicCamera) return "orthographic";
  const type = String(camera.type ?? "");
  if (type === "PerspectiveCamera") return "perspective";
  if (type === "OrthographicCamera") return "orthographic";
  return "unknown";
}

/** The full-screen-quad camera every post-processing pass uses: an orthographic unit box. */
export function isUnitFrustum(camera: Foreign) {
  if (!camera || cameraKind(camera) !== "orthographic") return false;
  const near = (a: Foreign, b: Foreign) => Math.abs(Number(a) - b) < 1e-6;
  return near(camera.left, -1) && near(camera.right, 1) && near(camera.top, 1) && near(camera.bottom, -1);
}

/** A pass rendered from a bare mesh root — three's own QuadMesh, never a world. */
export function isQuadRoot(scene: Foreign) {
  if (!scene || typeof scene !== "object") return false;
  if (scene.isScene) return false;
  return Boolean(scene.isQuadMesh || scene.isMesh || scene.type === "QuadMesh" || scene.type === "Mesh");
}

/**
 * How much of a world this looked like. Everything the studio refuses to judge scores -1: a
 * pass into a unit frustum with nothing in it, a bare quad root, a cube face, a nested render.
 */
export function scoreObservation(obs: Foreign) {
  if (!obs) return -1;
  if ((Number(obs.depth) || 0) > 0) return -1;
  if (obs.quadRoot) return -1;
  if (obs.cameraKind === "cube" || obs.cameraKind === "none") return -1;
  const drawables = Number(obs.drawables) || 0;
  if (obs.unitFrustum && drawables <= 2) return -1;
  if (drawables === 0) return -1;
  let score = 1;
  if (obs.cameraKind === "perspective" || obs.cameraKind === "array") score += 3;
  else if (obs.cameraKind === "orthographic") score += 1;
  score += Math.min(4, Math.log2(1 + drawables));
  if (obs.toTarget) score += 1;
  score += 2 * coverage(obs);
  return score;
}

/** How much of the frame this pass covered: a minimap into a small target is not the world. */
function coverage(obs: Foreign) {
  const full = obs.viewport ? (Number(obs.viewport.width) || 0) * (Number(obs.viewport.height) || 0) : 0;
  if (!obs.targetSize) return 1;
  const area = (Number(obs.targetSize.width) || 0) * (Number(obs.targetSize.height) || 0);
  if (!(full > 0) || !(area > 0)) return 1;
  return Math.min(1, area / full);
}

/**
 * Which of a frame's observations was the world. The index, or -1 when the frame drew nothing a
 * judge could look at. Ties go to the later call: the last thing drawn is what the user sees.
 */
export function chooseWorld(observations: Foreign) {
  let best = -1;
  let bestScore = 0;
  const list = Array.isArray(observations) ? observations : [];
  for (let i = 0; i < list.length; i++) {
    const score = scoreObservation(list[i]);
    if (score > 0 && score >= bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Objects under a root, walked with an explicit stack and capped — never `Object3D.traverse`,
 * which has no exit. Memoised per root: re-walked only when the root's children count changes
 * or the interval has passed, so a sixty-frame second costs at most two walks per scene.
 */
export function countDrawables(root: Foreign, at = now()) {
  const empty = { drawables: 0, objects: 0, capped: false };
  if (!root || typeof root !== "object") return empty;
  const children = childCount(root);
  if (children === null) return empty;
  const cached = counts.get(root);
  if (cached && cached.children === children && at - cached.at < COUNT_INTERVAL_MS) return cached.value;
  const value = walkDrawables(root);
  try {
    counts.set(root, { at, children, value });
  } catch {
    /* a frozen root cannot be memoised; it is still counted */
  }
  return value;
}

/** How many children the root has, or null when reading them throws. */
function childCount(root: Foreign): number | null {
  try {
    const roots = root.children;
    return Array.isArray(roots) ? roots.length : 0;
  } catch {
    return null;
  }
}

/** Pushes a node's children that are objects; none when reading them throws. */
function pushObjectChildren(stack: Foreign[], node: Foreign): void {
  let kids = null;
  try {
    kids = node.children;
  } catch {
    kids = null;
  }
  if (!Array.isArray(kids)) return;
  for (let i = 0; i < kids.length; i++) if (kids[i] && typeof kids[i] === "object") stack.push(kids[i]);
}

/** Counts the drawables under the root, stopping at the object cap. */
function walkDrawables(root: Foreign) {
  const stack = [root];
  let objects = 0;
  let drawables = 0;
  let capped = false;
  while (stack.length) {
    if (objects >= OBJECT_CAP) {
      capped = true;
      break;
    }
    const node = stack.pop();
    objects++;
    if (node !== root && isDrawable(node)) drawables++;
    pushObjectChildren(stack, node);
  }
  return { drawables, objects, capped };
}

function isDrawable(node: Foreign) {
  return Boolean(
    node &&
      (node.isMesh ||
        node.isInstancedMesh ||
        node.isSkinnedMesh ||
        node.isBatchedMesh ||
        node.isPoints ||
        node.isLine ||
        node.isLineSegments ||
        node.isSprite),
  );
}

// ── the frame boundary ───────────────────────────────────────────────────────

/**
 * Turn the frame's render calls into one world. Registered with the clock's `afterFrame`, so it
 * runs inside the same task as the frame it is closing, before control leaves it.
 */
export function endFrame(at = now()) {
  const records = state.records;
  state.records = [];
  state.frames++;
  if (!records.length) return state.world;
  const observations = records.map((entry) => describeObservation(entry, at)).filter((obs) => obs.depth === 0);
  const index = chooseWorld(observations);
  if (index < 0) return state.world;
  const won = observations[index];
  state.world = { renderer: won.renderer, scene: won.scene, camera: won.camera, at, score: scoreObservation(won) };
  rememberWorld(state.world);
  return state.world;
}

function rememberWorld(world: Foreign) {
  const existing = state.worlds.findIndex((entry) => entry.scene === world.scene);
  if (existing >= 0) state.worlds.splice(existing, 1);
  state.worlds.unshift({ ...world });
  state.worlds = state.worlds.filter((entry, index) => index === 0 || world.at - entry.at <= SCENE_TTL_MS);
  if (state.worlds.length > 8) state.worlds.length = 8;
}

/** The renderer, scene and camera the last judged frame used, or null before the first one. */
export function current() {
  if (!state.world) return null;
  const { renderer, scene, camera } = state.world;
  return { renderer, scene, camera, canvas: canvasOf(renderer) };
}

/** Every scene rendered as the world in the last second, most recent first. */
export function scenes() {
  const at = now();
  return state.worlds
    .filter((entry, index) => index === 0 || at - entry.at <= SCENE_TTL_MS)
    .map((entry) => entry.scene);
}

/** The class a value came from — a name for a report, never an identity comparison. */
function constructorName(value: Foreign) {
  try {
    if (!value || typeof value !== "object") return null;
    return value.constructor && value.constructor.name ? String(value.constructor.name) : typeof value;
  } catch {
    return null;
  }
}

/** A scene's own name when it has one, else its class. */
function nameOf(value: Foreign) {
  try {
    if (!value || typeof value !== "object") return null;
    return value.name ? String(value.name) : constructorName(value);
  } catch {
    return null;
  }
}

function canvasOf(renderer: Foreign) {
  try {
    return renderer?.domElement ?? null;
  } catch {
    return null;
  }
}

// ── the read-only scene graph ────────────────────────────────────────────────

/**
 * The helpers every `scene` check is evaluated against. One implementation for both paths: the
 * game the studio attached to and the game that called `installStudio` share this code, so a
 * check written against one means the same thing against the other.
 */
export function sceneHelpers(source: InspectOptions = {}) {
  const scene = source.scene ?? null;
  const roots = (Array.isArray(source.roots) && source.roots.length ? source.roots : [scene]).filter(Boolean);
  const objects = (tag?: Foreign) => {
    const out: Foreign[] = [];
    for (const root of roots) {
      walk(root, (obj: Foreign) => {
        if (obj === root) return;
        if (tag === undefined || obj.userData?.tag === tag) out.push(obj);
      });
    }
    return out;
  };
  const meshes = (tag?: Foreign) => objects(tag).filter((o) => o.isMesh || o.isInstancedMesh || o.isSkinnedMesh);
  const materials = (tag: Foreign) => {
    const set = new Set();
    for (const mesh of meshes(tag)) {
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => x && set.add(x));
      else if (m) set.add(m);
    }
    return [...set];
  };
  const lights = () => objects().filter((o) => o.isLight);
  const tags = () => {
    const seen = new Set();
    walk(scene, (obj: Foreign) => {
      if (obj?.userData?.tag) seen.add(String(obj.userData.tag));
    });
    return [...seen];
  };
  const ancestorTag = (obj: Foreign) => {
    let cursor = obj.parent;
    while (cursor) {
      if (cursor.userData?.tag) return cursor.userData.tag;
      cursor = cursor.parent;
    }
    return null;
  };
  const untagged = () => meshes().filter((m) => !m.userData?.tag && !ancestorTag(m)).length;
  const bbox = (tag: Foreign) => boundsOf(objects(tag));
  const bboxOf = (obj: Foreign) => {
    if (!obj) return null;
    const list: Foreign[] = [];
    walk(obj, (o: Foreign) => list.push(o));
    return boundsOf(list);
  };
  return {
    objects,
    meshes,
    materials,
    lights,
    tags,
    untagged,
    count: (tag: Foreign) => objects(tag).length,
    bbox,
    bboxOf,
    domUi: () => domUi(canvasOf(source.renderer) ?? current()?.canvas ?? null),
    renderTargets: source.renderTargets ?? (() => [...state.targets]),
  };
}

/** Depth-first over a scene graph, capped, with no dependence on `Object3D.traverse`. */
function walk(root: Foreign, visit: Foreign) {
  if (!root || typeof root !== "object") return;
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < OBJECT_CAP) {
    const node = stack.pop();
    seen++;
    visit(node);
    const kids = node.children;
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) if (kids[i] && typeof kids[i] === "object") stack.push(kids[i]);
    }
  }
}

/** The eight corners of a bounding box. */
function boxCorners(box: Foreign): number[][] {
  return [
    [box.min.x, box.min.y, box.min.z],
    [box.max.x, box.min.y, box.min.z],
    [box.min.x, box.max.y, box.min.z],
    [box.max.x, box.max.y, box.min.z],
    [box.min.x, box.min.y, box.max.z],
    [box.max.x, box.min.y, box.max.z],
    [box.min.x, box.max.y, box.max.z],
    [box.max.x, box.max.y, box.max.z],
  ];
}

/** A local point through a world matrix's elements (or as it is, without one). */
function toWorld(e: Foreign, c: number[]): number[] {
  if (!e) return c;
  return [
    e[0] * c[0] + e[4] * c[1] + e[8] * c[2] + e[12],
    e[1] * c[0] + e[5] * c[1] + e[9] * c[2] + e[13],
    e[2] * c[0] + e[6] * c[1] + e[10] * c[2] + e[14],
  ];
}

/** An object's local bounding box, computed if it has none yet; null without geometry. */
function localBox(obj: Foreign): Foreign {
  if (!obj.geometry) return null;
  obj.updateWorldMatrix?.(true, false);
  obj.geometry.computeBoundingBox?.();
  return obj.geometry.boundingBox;
}

function boundsOf(list: Foreign) {
  if (!list.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const obj of list) {
    const box = localBox(obj);
    if (!box) continue;
    for (const c of boxCorners(box)) {
      const w = toWorld(obj.matrixWorld?.elements, c);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], w[axis]);
        max[axis] = Math.max(max[axis], w[axis]);
      }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  // Both spellings work: `bbox('tree').size.y` and `bbox('tree').size[1]`.
  return { min: xyz(min), max: xyz(max), size: xyz([max[0] - min[0], max[1] - min[1], max[2] - min[2]]) };
}

function xyz(v: Foreign) {
  const out = { x: v[0], y: v[1], z: v[2] };
  Object.defineProperty(out, 0, { value: v[0], enumerable: false });
  Object.defineProperty(out, 1, { value: v[1], enumerable: false });
  Object.defineProperty(out, 2, { value: v[2], enumerable: false });
  Object.defineProperty(out, "length", { value: 3, enumerable: false });
  return out;
}

/** Elements that are never UI a player sees. */
const NOT_UI_TAGS = new Set(["CANVAS", "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "TITLE", "HEAD", "HTML", "BODY"]);
/** Elements that are visible UI even with no text of their own. */
const VISUAL_TAGS = new Set(["IMG", "SVG", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "VIDEO", "PROGRESS", "METER"]);
/** How many UI elements `domUi` names, and how much of each one's text. */
const MAX_DOM_UI = 12;
const UI_TEXT_CHARS = 40;

/** An element that is not UI at all: a document or script element, inside an SVG, or an empty `#fatal`. */
function isNotUi(el: Foreign): boolean {
  if (NOT_UI_TAGS.has(el.tagName) || (el.closest("svg") !== null && el.tagName !== "SVG")) return true;
  return el.id === "fatal" && !el.textContent.trim();
}

/** Hidden by style, or with no box on screen. */
function isInvisible(el: Foreign, style: CSSStyleDeclaration): boolean {
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
  const rect = el.getBoundingClientRect();
  return rect.width <= 0 || rect.height <= 0 || el.getClientRects().length === 0;
}

/** The text of the element's own text nodes, not its children's. */
function ownTextOf(el: Foreign): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => (n.textContent ?? "").trim())
    .join(" ")
    .trim();
}

/** Does the element paint something itself: a background, an image or a border? */
function isPainted(style: CSSStyleDeclaration): boolean {
  const background =
    style.backgroundColor && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/.test(style.backgroundColor);
  const image = style.backgroundImage && style.backgroundImage !== "none";
  const border = style.borderStyle && style.borderStyle !== "none" && parseFloat(style.borderWidth) > 0;
  return Boolean(background || image || border);
}

/** `tag#id.class.names`, as a selector names it. */
function uiName(el: Foreign): string {
  const id = el.id ? `#${el.id}` : "";
  const classes =
    el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${id}${classes}`;
}

/**
 * A visible canvas that is not the game's and lies over it: a second HUD painted beside the
 * contract's, which no camera frame photographs (every capture reads the renderer's canvas
 * alone). A canvas that does not touch the game is not named.
 */
function secondCanvas(el: Foreign, game: Foreign): string | null {
  if (!game || el === game || typeof game.getBoundingClientRect !== "function") return null;
  if (isInvisible(el, getComputedStyle(el))) return null;
  const rect = el.getBoundingClientRect();
  const own = game.getBoundingClientRect();
  const over = rect.left < own.right && rect.right > own.left && rect.top < own.bottom && rect.bottom > own.top;
  return over ? `${uiName(el)} (second canvas over the game)` : null;
}

/**
 * Visible DOM elements outside the canvas — the UI a canvas capture never sees — and any second
 * canvas over `game`, the renderer's own (by default the canvas of the world last rendered).
 * Each entry names the element and its text, so a failing check is actionable.
 */
export function domUi(game: Foreign = current()?.canvas ?? null) {
  const out: string[] = [];
  if (typeof document === "undefined" || !document.body) return out;
  for (const el of document.body.querySelectorAll("*")) {
    const entry = uiEntry(el, game);
    if (!entry) continue;
    out.push(entry);
    if (out.length >= MAX_DOM_UI) break;
  }
  return out;
}

/** What `domUi` names one element: a second canvas over the game, or visible UI; null for neither. */
function uiEntry(el: Foreign, game: Foreign): string | null {
  if (el.tagName === "CANVAS") return secondCanvas(el, game);
  if (isNotUi(el)) return null;
  const style = getComputedStyle(el);
  if (isInvisible(el, style)) return null;
  const ownText = ownTextOf(el);
  if (!ownText && !VISUAL_TAGS.has(el.tagName) && !isPainted(style)) return null;
  const name = uiName(el);
  return ownText ? `${name} "${ownText.slice(0, UI_TEXT_CHARS)}"` : name;
}

/** The shape `inspect()` answers with when there is nothing to inspect yet. */
export function unavailable(reason = NO_RENDER_REASON) {
  const fail = () => {
    throw new Error(`${UNAVAILABLE}: ${reason}`);
  };
  return {
    available: false,
    reason,
    scene: null,
    renderer: null,
    camera: null,
    state: null,
    player: null,
    objects: fail,
    meshes: fail,
    materials: fail,
    lights: fail,
    tags: fail,
    untagged: fail,
    count: fail,
    bbox: fail,
    bboxOf: fail,
    domUi,
    hud: () => ({ items: [], crosshair: false, flash: 0 }),
    renderTargets: () => [...state.targets],
    audio: () => ({ available: false, rms: 0, centroid: 0 }),
  };
}

/**
 * Read-only helpers over whatever the studio can see. `options` lets the installed contract pass
 * its own scene, camera, player and probes in; with nothing passed, the world the page rendered
 * is the answer.
 */
export function inspect(options: InspectOptions = {}): Foreign {
  const world = current();
  const scene = options.scene ?? world?.scene ?? null;
  if (!scene) return unavailable(options.reason ?? NO_RENDER_REASON);
  const renderer = options.renderer ?? world?.renderer ?? null;
  const camera = options.camera ?? world?.camera ?? null;
  const roots = Array.isArray(options.roots) && options.roots.length ? options.roots : [scene];
  const helpers = sceneHelpers({ ...options, scene, roots });
  return {
    available: true,
    scene,
    renderer,
    camera,
    state: options.state ?? pageState(),
    player: options.player ?? null,
    ...helpers,
    hud: options.hud ?? (() => ({ items: [], crosshair: false, flash: 0 })),
    audio: options.audio ?? (() => ({ available: false, rms: 0, centroid: 0 })),
  };
}

function pageState() {
  try {
    const game = (globalThis as PageGlobal).__studio?.__game;
    if (game && typeof game.state === "function") return game.state();
  } catch {
    /* a game whose state() throws is not the hook's problem */
  }
  return null;
}

/** Counts by tag, lights and render targets — what a check reads without the graph. */
export function sceneSummary(options: InspectOptions = {}) {
  const I = inspect(options);
  if (I.available === false) return { available: false, reason: I.reason };
  const byTag: Record<string, number> = {};
  for (const tag of I.tags()) byTag[tag] = I.count(tag);
  return {
    available: true,
    meshes: I.meshes().length,
    untagged: I.untagged(),
    byTag,
    lights: I.lights().map((l: Foreign) => l.type),
    renderTargets: I.renderTargets().map((rt: Foreign) => ({ width: rt.width, height: rt.height })),
    scenes: state.worlds.length,
  };
}

/**
 * An attached game registered no cameras, but it renders through one, and the studio can name
 * it: `default` is whatever camera drew the last judged frame.
 */
export function cameras() {
  return current()?.camera ? ["default"] : [];
}

export function debugCamera(name: Foreign) {
  const available = cameras();
  if (name === "default" && available.length) {
    return { ok: true, camera: "default" };
  }
  return { ok: false, available };
}

/** What the hook knows — the page half of the studio's attach report. */
export function hookState() {
  const world = current();
  return {
    version: HOOK_VERSION,
    attached: Boolean(world),
    renders: state.renders,
    frames: state.frames,
    scenes: state.worlds.length,
    renderer: constructorName(world?.renderer),
    scene: nameOf(world?.scene),
    camera: constructorName(world?.camera),
    cameraKind: cameraKind(world?.camera ?? null),
    three: state.namespaces.map((entry) => ({
      key: entry.key,
      url: entry.url,
      revision: entry.revision,
      wrapped: entry.wrapped.slice(),
    })),
    targets: state.targets.size,
    driven: state.driven,
    reason: world ? null : attachReason(),
    errors: state.wrapErrors.slice(0, 4),
  };
}

/**
 * Why nothing has been seen. The accessor trap is the whole mechanism for WebGL, so a three that
 * assigns `render` some other way — or a game that replaces `renderer.render` after construction
 * — must say so rather than report an empty scene graph.
 */
function attachReason() {
  if (!state.namespaces.length && instancesWrapped === 0) {
    return "the studio never reached this page's three — its renderer is inside its own bundle; call installStudio({ renderer, player }) from the game's entry";
  }
  if (state.renders === 0 && state.frames > 30) {
    return "the page has drawn frames but no wrapped renderer was called — a game that replaces renderer.render after construction is invisible to the studio";
  }
  return NO_RENDER_REASON;
}

/** The end-of-frame photograph, once M4.9's page-side capture is on the page. */
export function capture(options: Foreign) {
  try {
    return (globalThis as PageGlobal).__studioCapture?.capture?.(options) ?? null;
  } catch {
    return null;
  }
}

/** The canvas the world was drawn on — what the page-side capture photographs. */
export function canvas() {
  return current()?.canvas ?? null;
}

// ── installation ─────────────────────────────────────────────────────────────

/**
 * Put the hook on the page and close every frame with it. Idempotent, and safe on a page with
 * no clock: the studio's shim installs first, but a game served by something else still gets
 * the frame boundary from the browser's own animation frames.
 */
export function installStudioHook(target: PageGlobal = globalThis as PageGlobal) {
  const existing = target.__studioHook;
  if (existing && existing.version === HOOK_VERSION) return existing;
  const api = {
    version: HOOK_VERSION,
    hook,
    wrapRenderer,
    wrapClass,
    current,
    scenes,
    inspect,
    sceneSummary,
    cameras,
    debugCamera,
    state: hookState,
    endFrame,
    capture,
    canvas,
    reset,
    describeObservation,
    scoreObservation,
    chooseWorld,
  };
  // Behind an accessor: the attach report, the camera census and the capture all read the hook
  // back by name, so it is not a page's to replace. Configurable, so a newer hook can install.
  try {
    Object.defineProperty(target, "__studioHook", {
      configurable: true,
      enumerable: true,
      get: () => api,
      set: () => {},
    });
  } catch {
    target.__studioHook = api;
  }
  const clock = target.__studioClock;
  if (clock && typeof clock.afterFrame === "function") {
    clock.afterFrame(() => endFrame());
    state.driven = true;
  } else if (typeof target.requestAnimationFrame === "function") {
    const beat = () => {
      target.requestAnimationFrame(beat);
      endFrame();
    };
    target.requestAnimationFrame(beat);
  }
  return api;
}

// Importing this module is enough: the wrapper the serve layer generates imports it to call
// `hook()`, and `hook-entry.js` imports it for a page whose three never passes through the map.
// Both reach the same module record, so there is exactly one hook on a page however it got there.
try {
  installStudioHook();
} catch {
  /* a host with no globals to install on still exports every function above */
}
