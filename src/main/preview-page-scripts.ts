/**
 * The scripts the preview runs inside a game's page: probes that report what the page can do
 * and saw (trusted input, the attach report, WebGL errors), the page-side capture and the bounded
 * read of `__studio.state()`. Each is an expression string for `webContents.executeJavaScript`.
 */
import { ElidedKind, StateShape, keepPathsOf } from "../shared/studio-state-shape.ts";

/** The studio reads at most this much of a `state()` whole; past it, the largest lists are cut. */
export const STATE_MAX_CHARS = 48_000;

/** Installed once per page: remembers whether any trusted (native) input ever arrived. */
export const TRUSTED_PROBE = `(() => {
  if (window.__studioTrustedProbe) return true;
  window.__studioTrustedProbe = true;
  const mark = (event) => {
    if (!event.isTrusted) return;
    window.__studioTrustedInput = true;
    (window.__studioTrustedTypes = window.__studioTrustedTypes || {})[event.type] = true;
  };
  for (const type of ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "wheel"]) window.addEventListener(type, mark, true);
  return true;
})()`;

/**
 * Is the game attached, and to what? Read off the hook, which knows what it wrapped and what it
 * has seen rendered — never off the game's own claim about itself. `contract` is `installed` when
 * a game assigned `window.__studio` (the facade keeps the object as `__game`), `attached` when
 * the studio recognised a world in the frames the page drew, and `none` when neither is true.
 */
export const ATTACH_PROBE = `(() => {
  const hook = window.__studioHook || null;
  const facade = window.__studio || null;
  const game = facade && facade.__game ? facade.__game : null;
  const call = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
  const world = hook && typeof hook.current === "function" ? call(() => hook.current()) : null;
  const s = hook && typeof hook.state === "function" ? call(() => hook.state()) : null;
  const name = (v) => { try { return v && v.constructor && v.constructor.name ? v.constructor.name : (v ? typeof v : null); } catch { return null; } };
  return {
    contract: game ? "installed" : world ? "attached" : "none",
    shim: Boolean(window.__studioClock),
    hook: Boolean(hook),
    renderer: name(world && world.renderer),
    scene: name(world && world.scene),
    camera: name(world && world.camera),
    cameraKind: s ? s.cameraKind : null,
    cameras: call(() => facade.cameras()) || [],
    eyes: call(() => facade.eyes()) || [],
    player: Boolean(call(() => facade.player())),
    renders: s ? s.renders : 0,
    frames: s ? s.frames : 0,
    scenes: s ? s.scenes : 0,
    three: s ? s.three.map((n) => n.key + (n.revision ? " r" + n.revision : "")) : [],
    namespaces: s ? s.three : [],
    reason: s ? s.reason : "the studio hook is not on this page",
  };
})()`;

/**
 * What the page-side capture reported about the frame it took, or declined to take (M4.9a).
 * Every field is optional: the page answers what it knows, and an older page answers nothing.
 */
export interface PageCaptureInfo {
  source?: string;
  reason?: string | null;
  picked?: unknown;
  canvases?: unknown[];
  background?: string | null;
  composited?: boolean;
  drawCalls?: number | null;
  ladder?: string[];
  backend?: string | null;
  kind?: string | null;
  /** How many pictures the shim's own capture has recorded — how a stale record is spotted. */
  count?: number;
  /** Who took this picture: `shim` read the canvas itself, `game` answered with its own. */
  provenance?: "shim" | "game";
  /** The record describes some earlier picture: the game answered without going through the shim. */
  stale?: boolean;
}

/** The page-side capture never runs longer than this before the compositor takes the frame. */
export const PAGE_CAPTURE_TIMEOUT_MS = 1500;

/**
 * Ask the page for the end of its own frame. `capture()` may be async (a WebGPU game awaits
 * its render), so this awaits it; `captureInfo()` is plain data and comes back beside it, which
 * is how a shot's provenance reaches the stats a check reads.
 */
export const PAGE_CAPTURE = `(async () => {
  var readInfo = function (holder) {
    try { return holder && typeof holder.captureInfo === "function" ? JSON.parse(JSON.stringify(holder.captureInfo())) : null; } catch (err) { return null; }
  };
  try {
    const s = window.__studio;
    if (!s || typeof s.capture !== "function") return null;
    /* Provenance, not the page's word for it. \`capture()\` and \`captureInfo()\` are both members
       the facade delegates to the game, so a build could answer with a pre-baked picture and the
       draw count to go with it, and the record would be indistinguishable from a frame the shim
       read off the canvas. The shim's own capture counts the pictures IT took: if that count did
       not move, this one came from the game and is labelled so. */
    const own = window.__studioCapture;
    const before = readInfo(own);
    const image = await s.capture();
    const after = readInfo(own);
    const info = after || readInfo(s);
    if (info) {
      const fresh = Boolean(after && before && after.count !== before.count);
      const supplied = !fresh || info.source === "game" || (Array.isArray(info.ladder) && info.ladder.indexOf("game") >= 0);
      info.provenance = supplied ? "game" : "shim";
      if (!fresh) info.stale = true;
    }
    return { image: typeof image === "string" ? image : null, info: info };
  } catch (err) {
    return null;
  }
})()`;

/**
 * Wrap WebGL getError + drain each frame. Chromium's GPU process logs
 * `GL_INVALID_OPERATION` where the page console cannot hear them — that is how a
 * real run shipped a broken sampler while every probe looked clean.
 */
export const GL_PROBE = `(() => {
  if (window.__studioGl) return true;
  const seen = [];
  const names = {
    1280: "INVALID_ENUM",
    1281: "INVALID_VALUE",
    1282: "INVALID_OPERATION",
    1285: "OUT_OF_MEMORY",
    1286: "INVALID_FRAMEBUFFER_OPERATION",
    37442: "CONTEXT_LOST_WEBGL",
  };
  const note = (code) => {
    const msg = "GL_" + (names[code] || String(code));
    if (!seen.includes(msg) && seen.length < 16) seen.push(msg);
  };
  const wrap = (proto) => {
    if (!proto || proto.__studioWrapped) return;
    proto.__studioWrapped = true;
    const orig = proto.getError;
    proto.getError = function () {
      const e = orig.call(this);
      if (e && e !== this.NO_ERROR) note(e);
      return e;
    };
  };
  if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype);
  // Every WebGL context the page creates from here on, by canvas. The drain reads only these:
  // asking a canvas for "webgl2" CREATES a WebGL context on a canvas that has none yet, and a
  // WebGPU renderer that initialises a moment later then finds getContext("webgpu") null —
  // every frame of a WebGPU game failed that way. Never probe a canvas blind.
  const contexts = new WeakMap();
  const tracked = new Set();
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === "webgl" || type === "webgl2" || type === "experimental-webgl")) {
      if (!contexts.has(this)) {
        contexts.set(this, ctx);
        tracked.add(this);
        this.addEventListener("webglcontextlost", () => {
          if (!seen.includes("GL_CONTEXT_LOST") && seen.length < 16) seen.push("GL_CONTEXT_LOST");
        });
      }
    }
    return ctx;
  };
  const drain = () => {
    for (const canvas of tracked) {
      const gl = contexts.get(canvas);
      if (!gl || typeof gl.getError !== "function" || gl.isContextLost?.()) continue;
      let n = 0;
      let err;
      while ((err = gl.getError()) !== gl.NO_ERROR && n++ < 8) note(err);
    }
  };
  const GL_DRAIN_EVERY_FRAMES = 30;
  let frames = 0;
  const tick = () => {
    if (++frames % GL_DRAIN_EVERY_FRAMES === 0) drain();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__studioGl = { errors: () => { drain(); return seen.slice(); } };
  return true;
})()`;

/**
 * How every expression is evaluated in the page: awaited first (an async probe must resolve
 * before it is serialised, or it reads `{}`), then serialised to JSON text there, with a throw
 * answered as `{__error}`. The host parses that text; nothing else crosses.
 */
export function pageEvaluation(expression: string): string {
  return `Promise.resolve().then(() => ${expression}).then(
        (value) => JSON.stringify(value === undefined ? null : value),
        (err) => JSON.stringify({ __error: String(err) }),
      )`;
}

/**
 * What {@link boundStudioState} is told. It runs in the page from its own source, so the marker
 * names arrive here rather than through an import the page would not have.
 */
export interface StateBoundOptions {
  /** The budget for the state's JSON, its `__cut` marker included. */
  maxChars: number;
  /** Paths cut only when nothing else brings the state under the budget. */
  keep: readonly string[];
  shape: typeof StateShape;
  kind: typeof ElidedKind;
}

/** The bounder's options for a budget and the `keep` paths a caller sent, validated here. */
export function stateBoundOptions(maxChars: number, keep: unknown = []): StateBoundOptions {
  return { maxChars, keep: keepPathsOf(keep), shape: StateShape, kind: ElidedKind };
}

/**
 * The page expression that reads `window.__studio.state()` bounded to `maxChars`: a page without
 * the contract answers `{__missing}` and a throwing `state()` answers `{__error}`, exactly as the
 * unbounded read did.
 */
export function studioStateExpression(maxChars = STATE_MAX_CHARS, keep: unknown = []): string {
  const options = JSON.stringify(stateBoundOptions(maxChars, keep));
  const read = `window.__studio ? window.__studio.state() : { ${StateShape.Missing}: true }`;
  return `Promise.resolve(${read}).then((state) => (${boundStudioState.toString()})(state, ${options}))`;
}

/**
 * A `state()` bounded by structure, never cut as a string. A state whose JSON fits `maxChars` comes
 * back unchanged, byte for byte. Past it, the largest lists are replaced by stubs
 * (`{__elided, length, chars}`), then — when no list is left to cut — the object that holds the
 * bulk, descending while one child holds most of it; a long string is cut the same way. Order is
 * deterministic (size, then path); a scalar is never removed; the paths in `keep` are cut only
 * when nothing else is left, lists first. The root then says what was cut under `__cut`.
 *
 * A cycle or a throwing getter throws exactly as serialising the state did. The walks are
 * iterative, so deep nesting cannot overflow the stack, and sizes are measured in one pass.
 *
 * It runs from its own source text (`boundStudioState.toString()`), so everything it uses — its
 * limits included — is declared inside it: a helper or a constant of this module would not exist
 * in the page.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: evaluated in the page from its own source, so it stays one self-contained function
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: evaluated in the page from its own source, so it stays one self-contained function
export function boundStudioState(state: unknown, options: StateBoundOptions): unknown {
  /** `__cut.paths` names at most this many paths, each clipped to this many characters. */
  const MAX_CUT_PATHS = 32;
  const MAX_CUT_PATH_CHARS = 120;
  /** The most one cut adds back: its stub, and its path in `__cut.paths`. */
  const CUT_COST_CHARS = MAX_CUT_PATH_CHARS + 72;
  /** A value smaller than this is never worth a stub: cutting it could grow the state. */
  const MIN_ELIDE_CHARS = 2 * CUT_COST_CHARS;
  /** The bounder stops after this many cuts; the host's own cap is the last word. */
  const MAX_ELISIONS = 512;
  /** Lists get at most half the cuts, so the object that holds them can always still be cut. */
  const MAX_LIST_CUTS = MAX_ELISIONS / 2;
  /** A value's relation to the `keep` paths: none, an ancestor of one, or one (or inside one). */
  const FREE = 0;
  const ON_KEPT_PATH = 1;
  const KEPT = 2;
  const { shape, kind, maxChars } = options;
  let text: string | undefined;
  try {
    text = JSON.stringify(state);
  } catch {
    // A cycle, a throwing getter, nesting too deep to serialise: hand the state back untouched,
    // and the evaluation fails on it exactly where and how it always has.
    return state;
  }
  if (text === undefined) return state;
  const root: unknown = JSON.parse(text);
  if (text.length <= maxChars) return root;

  const isContainer = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
  const kindOf = (v: unknown): string => {
    if (Array.isArray(v)) return kind.Array;
    if (typeof v === "string") return kind.String;
    return kind.Object;
  };
  const lengthOf = (v: unknown): number => {
    if (Array.isArray(v) || typeof v === "string") return v.length;
    return isContainer(v) ? Object.keys(v).length : 0;
  };
  const stubOf = (v: unknown, chars: number) => ({ [shape.Elided]: kindOf(v), length: lengthOf(v), chars });
  // Never `target[key] = value`: a state may carry a `__proto__` key, and assigning it would
  // change the object's prototype instead of replacing the data.
  const setOwn = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };
  const cut = { chars: text.length, paths: [] as string[] };
  if (!isContainer(root) || Array.isArray(root)) {
    const answer = stubOf(root, text.length);
    cut.paths.push("");
    setOwn(answer, shape.Cut, cut);
    return answer;
  }

  // One pre-order walk: every value's parent, key and relation to `keep`. A value's subtree is
  // the index range [i, ends[i]).
  const values: unknown[] = [];
  const parents: number[] = [];
  const keys: string[] = [];
  /** What a member's key adds to its parent's JSON: `"key":` in an object, nothing in a list. */
  const memberChars: number[] = [];
  const depths: number[] = [];
  const keepState: number[] = [];
  const kids: number[][] = [];
  const keepSegments = options.keep.map((path) => path.split("."));
  type Pending = { value: unknown; parent: number; key: string; member: number; matching: number[]; kept: boolean };
  const stack: Pending[] = [
    { value: root, parent: -1, key: "", member: 0, matching: keepSegments.map((_, j) => j), kept: false },
  ];
  while (stack.length > 0) {
    const next = stack.pop() as Pending;
    const i = values.length;
    const depth = next.parent < 0 ? 0 : depths[next.parent] + 1;
    const kept = next.kept || next.matching.some((j) => keepSegments[j].length === depth);
    values.push(next.value);
    parents.push(next.parent);
    keys.push(next.key);
    memberChars.push(next.member);
    depths.push(depth);
    kids.push([]);
    let relation = FREE;
    if (kept) relation = KEPT;
    else if (next.matching.length > 0) relation = ON_KEPT_PATH;
    keepState.push(relation);
    if (next.parent >= 0) kids[next.parent].push(i);
    const value = next.value;
    if (!isContainer(value)) continue;
    const names = Array.isArray(value) ? value.map((_, k) => String(k)) : Object.keys(value);
    for (let k = names.length - 1; k >= 0; k--) {
      const key = names[k];
      const member = Array.isArray(value) ? 0 : JSON.stringify(key).length + 1;
      const matching = kept ? [] : next.matching.filter((j) => keepSegments[j][depth] === key);
      stack.push({ value: value[key], parent: i, key, member, matching, kept });
    }
  }

  // Sizes bottom-up: every value's JSON length, and how much of it lies in kept values.
  const n = values.length;
  const sizes: number[] = new Array(n).fill(0);
  const ends: number[] = new Array(n).fill(0);
  const keptChars: number[] = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const own = kids[i];
    let size = 0;
    let keptBelow = 0;
    if (isContainer(values[i])) {
      size = 2 + Math.max(0, own.length - 1);
      for (const c of own) {
        size += memberChars[c] + sizes[c];
        keptBelow += keptChars[c];
      }
    } else size = String(JSON.stringify(values[i])).length;
    sizes[i] = size;
    keptChars[i] = keepState[i] === KEPT ? size : keptBelow;
    ends[i] = own.length > 0 ? ends[own[own.length - 1]] : i + 1;
  }

  const dead = new Uint8Array(n);
  const exhausted = new Uint8Array(n);
  let elisions = 0;
  const cutMarkerChars = () => JSON.stringify(shape.Cut).length + 2 + JSON.stringify(cut).length;
  const overBudget = () => sizes[0] + cutMarkerChars() > maxChars && elisions < MAX_ELISIONS;
  const paths = new Map<number, string>();
  const pathOf = (i: number): string => {
    const known = paths.get(i);
    if (known !== undefined) return known;
    const segments: string[] = [];
    for (let at = i; at > 0; at = parents[at]) segments.push(keys[at]);
    const path = segments.reverse().join(".");
    paths.set(i, path);
    return path;
  };
  const heavierFirst = (a: number, b: number): number => {
    if (sizes[a] !== sizes[b]) return sizes[b] - sizes[a];
    const pa = pathOf(a);
    const pb = pathOf(b);
    if (pa === pb) return a - b;
    return pa < pb ? -1 : 1;
  };
  const elide = (i: number): void => {
    const stub = stubOf(values[i], sizes[i]);
    const stubChars = JSON.stringify(stub).length;
    setOwn(values[parents[i]] as object, keys[i], stub);
    const saved = sizes[i] - stubChars;
    for (let at = parents[i]; at >= 0; at = parents[at]) sizes[at] -= saved;
    sizes[i] = stubChars;
    for (let d = i + 1; d < ends[i]; d++) dead[d] = 1;
    exhausted[i] = 1;
    elisions++;
    if (cut.paths.length >= MAX_CUT_PATHS) return;
    const path = pathOf(i);
    cut.paths.push(path.length > MAX_CUT_PATH_CHARS ? `${path.slice(0, MAX_CUT_PATH_CHARS - 1)}…` : path);
  };

  // Lists first, largest first: a list is what grows without bound (every HUD id, every bullet).
  const isLooseList = (i: number): boolean =>
    Array.isArray(values[i]) && keepState[i] === FREE && dead[i] === 0 && sizes[i] >= MIN_ELIDE_CHARS;
  // Whether the lists, largest first, bring the state under the budget within MAX_LIST_CUTS cuts
  // (or run out first). When they cannot, the weight is spread over many medium lists — every
  // car's path in a map of thousands — and cutting them one by one would spend every cut and
  // still not fit: the map that holds them is cut whole instead.
  const listsFitInCuts = (lists: number[]): boolean => {
    const planned = new Uint8Array(n);
    let over = sizes[0] + cutMarkerChars() - maxChars;
    let count = 0;
    for (const i of lists) {
      if (over <= 0) return true;
      let inside = false;
      for (let at = parents[i]; at > 0 && !inside; at = parents[at]) inside = planned[at] === 1;
      if (inside) continue;
      if (count >= MAX_LIST_CUTS) return false;
      planned[i] = 1;
      count++;
      over -= sizes[i] - CUT_COST_CHARS;
    }
    return true;
  };
  const cutLists = (): void => {
    const lists: number[] = [];
    for (let i = 1; i < n; i++) if (isLooseList(i)) lists.push(i);
    lists.sort(heavierFirst);
    if (!listsFitInCuts(lists)) return;
    for (const i of lists) {
      if (!overBudget()) return;
      if (dead[i] === 0) elide(i);
    }
  };
  // Then the bulk: descend from the root into the heaviest child while one child holds most of
  // its parent; where the weight is spread over many children, cut the parent whole.
  const cuttable = (i: number): number => (exhausted[i] || dead[i] ? 0 : sizes[i] - keptChars[i]);
  const heaviestKid = (i: number): number => {
    let best = -1;
    for (const c of kids[i]) {
      if (keepState[c] === KEPT || cuttable(c) < MIN_ELIDE_CHARS) continue;
      const tie = best >= 0 && cuttable(c) === cuttable(best) && keys[c] < keys[best];
      if (best < 0 || cuttable(c) > cuttable(best) || tie) best = c;
    }
    return best;
  };
  const excess = (): number => sizes[0] + cutMarkerChars() - maxChars;
  const loose = (at: number): boolean => at > 0 && keepState[at] === FREE;
  // Stop at `at` when its weight is spread over many children (a map of thousands of entries)
  // or when its heaviest child alone would not bring the state under the budget.
  const stopsAt = (at: number, kid: number): boolean => {
    const spread = cuttable(kid) * 2 < cuttable(at);
    const tooSmall = cuttable(kid) < excess() + CUT_COST_CHARS;
    return loose(at) && (spread || tooSmall);
  };
  const pickBulk = (): number => {
    let at = 0;
    for (;;) {
      const kid = heaviestKid(at);
      if (kid < 0) {
        if (loose(at)) return at;
        exhausted[at] = 1;
        return -1;
      }
      if (stopsAt(at, kid)) return at;
      if (!isContainer(values[kid])) return kid;
      at = kid;
    }
  };
  const cutBulk = (): void => {
    while (overBudget() && exhausted[0] === 0) {
      const target = pickBulk();
      if (target >= 0) elide(target);
    }
  };
  // Last, the kept paths themselves, by the same rules.
  const releaseKeeps = (): void => {
    for (let i = 0; i < n; i++) {
      keepState[i] = FREE;
      keptChars[i] = 0;
      if (dead[i] === 0 && sizes[i] >= MIN_ELIDE_CHARS) exhausted[i] = 0;
    }
  };

  cutLists();
  cutBulk();
  if (overBudget() && keepSegments.length > 0) {
    releaseKeeps();
    cutLists();
    cutBulk();
  }
  setOwn(root, shape.Cut, cut);
  return root;
}
