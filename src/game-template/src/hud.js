/**
 * The HUD: the one screen, drawn into the canvas (M4.2a moved it out of `studio.js`).
 *
 * Every readout, gauge, panel, icon, crosshair and flash goes through `__studio.hud`, which paints
 * a 2D canvas and composites it as ONE quad over the world after each render. It is tagged `hud`,
 * counted once, and part of capture() — so the judge's picture is the user's picture. DOM UI is
 * invisible to the canvas capture, and two builders who each learned that once painted their own
 * HUD quads; the user got three.
 *
 * It paints at the renderer's drawing buffer, so it is as sharp as the pixel ratio allows, and
 * it draws real curves: arcs, vector paths, images, rounded panels and bundled fonts. A builder
 * who only had rectangles once built circles out of thousands of them, and the judge saw stairs.
 * Lengths of the newer items are fractions of the frame's HEIGHT, so a circle stays round at any
 * aspect, and every item can be anchored to one of nine points of the frame.
 *
 * It lives here, beside `studio.js`, because it is the only part of the contract that needs
 * three: the contract itself must be importable by a game with no import map, another version of
 * three, or no three in its graph at all, and `studio.js` reaches this file through a dynamic
 * import the first time a game actually draws a HUD item. It is a CONTRACT FILE and ships with
 * every shape: withholding it would leave a bundled game with a dynamic import of a file that is
 * not there, and Vite and Rollup both fail on an unresolvable static-literal dynamic import.
 */

import * as THREE from "three";

/**
 * Which HUD this file is. The studio replaces a game's copy with a newer generation only when the
 * copy is byte for byte one it shipped; a copy anyone edited is left as it is.
 */
export const HUD_GENERATION = 2;

/** What a HUD item is: the `type` of every item `get(id)` returns. */
export const HudItemKind = {
  Text: "text",
  Bar: "bar",
  Crosshair: "crosshair",
  Arc: "arc",
  Path: "path",
  Image: "image",
  Panel: "panel",
};

/** The nine points of the frame an item can be anchored to; `x`/`y` then move it inward from there. */
export const HudAnchor = {
  TopLeft: "top-left",
  Top: "top",
  TopRight: "top-right",
  Left: "left",
  Center: "center",
  Right: "right",
  BottomLeft: "bottom-left",
  Bottom: "bottom",
  BottomRight: "bottom-right",
};

/** The screen flash fades by this factor per simulation step. */
const FLASH_DECAY = 0.86;

/** The font a text item is drawn in unless it names its own. */
const HUD_FONT = "ui-sans-serif, system-ui, sans-serif";
/** The colour an item is drawn in unless it names its own. */
const HUD_COLOR = "#e8eef8";
/** The resolution text and crosshair sizes are written for; larger screens scale them up. */
const DESIGN_HEIGHT = 720;

/** How many item ids the summary lists; `count` says how many there are. */
const HUD_SUMMARY_ITEMS = 64;
/** The grid coverage is measured on: the share of these cells the HUD's items cover. */
const HUD_COVERAGE_GRID = { cols: 96, rows: 54 };
/** How many overlapping pairs the summary names. */
const HUD_MAX_OVERLAPS = 8;
/** Two items overlap when they share at least this much of the smaller one. */
const HUD_OVERLAP_MIN = 0.2;
/**
 * An item with at least this share of its box inside a larger one sits in it (a readout in its
 * dial, a label on its bar, a ring around the crosshair): a group, not a collision.
 */
const HUD_GROUPED_SHARE = 0.75;
/** How many times larger than the item the one it sits in must be: two same-sized gauges still collide. */
const HUD_GROUP_AREA_RATIO = 2;
/** The longest an id is written in the summary: a game's own id never makes state() large. */
const HUD_SUMMARY_ID_CHARS = 32;
/** The most pairs the overlap sweep compares before it stops: a summary never stalls a frame. */
const HUD_OVERLAP_COMPARISONS = 200_000;

/** A gauge's sweep, in radians: it opens at the bottom, like a tachometer. */
const GAUGE_START = 0.75 * Math.PI;
const GAUGE_END = 2.25 * Math.PI;
/** Default lengths of the newer items, in fractions of the frame's height. */
const ARC_RADIUS = 0.06;
const ARC_WIDTH = 0.012;
const PANEL_SIZE = 0.2;
const PANEL_RADIUS = 0.012;
const STROKE_WIDTH = 0.003;
const PATH_SIZE = 0.06;
const IMAGE_HEIGHT = 0.08;
/** A panel's fill unless it names its own. */
const PANEL_FILL = "rgba(0,0,0,0.45)";
/** A path's coordinate system unless it names its own: `0 0 100 100`. */
const PATH_VIEWBOX = [0, 0, 100, 100];

/** Where each anchor sits, as fractions of the frame and of the item's own box. */
const ANCHOR_POINTS = {
  [HudAnchor.TopLeft]: [0, 0],
  [HudAnchor.Top]: [0.5, 0],
  [HudAnchor.TopRight]: [1, 0],
  [HudAnchor.Left]: [0, 0.5],
  [HudAnchor.Center]: [0.5, 0.5],
  [HudAnchor.Right]: [1, 0.5],
  [HudAnchor.BottomLeft]: [0, 1],
  [HudAnchor.Bottom]: [0.5, 1],
  [HudAnchor.BottomRight]: [1, 1],
};
/** The text alignment that keeps anchored text inside the frame at each horizontal anchor. */
const TEXT_ALIGN_AT = { 0: "left", 0.5: "center", 1: "right" };

/** One Path2D per path item, made the first time it is painted. */
const PATHS = new WeakMap();

/** The overlay: a 2D canvas as the texture of one full-frame quad, in its own orthographic scene. */
function createOverlay() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const surface = document.createElement("canvas");
  surface.width = 2;
  surface.height = 2;
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.name = "studio-hud";
  quad.userData.tag = "hud";
  quad.frustumCulled = false;
  scene.add(quad);
  return { scene, camera, surface, texture };
}

/** The size to paint at: the renderer's drawing buffer, or the game canvas's own size without one. */
function drawingSize(deps) {
  const canvas = deps.canvas();
  const renderer = deps.renderer();
  if (renderer && typeof renderer.getDrawingBufferSize === "function") {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    return { width: Math.max(2, Math.round(v.x)), height: Math.max(2, Math.round(v.y)) };
  }
  return { width: Math.max(2, canvas?.width ?? 2), height: Math.max(2, canvas?.height ?? 2) };
}

/** The frame an item is laid out in: its size in pixels and the scale of design pixels. */
function frameOf({ width, height }) {
  return { width, height, scale: Math.max(1, Math.min(width, height) / DESIGN_HEIGHT) };
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Where an item's anchor sits: `[0, 0]` (top-left, the default) to `[1, 1]` (bottom-right). */
const anchorOf = (item) => ANCHOR_POINTS[item.anchor] ?? ANCHOR_POINTS[HudAnchor.TopLeft];

/** The frame coordinate `offset` (a fraction of `size`) lands on, measured inward from the anchored edge. */
function fromEdge(anchor, offset, size) {
  if (anchor === 1) return size - offset * size;
  return anchor * size + offset * size;
}

/** A `w` × `h` box placed so its anchor point sits at the frame's, moved inward by the item's x/y. */
function placed(item, w, h, frame) {
  const [ax, ay] = anchorOf(item);
  const left = fromEdge(ax, item.x ?? 0, frame.width) - ax * w;
  const top = fromEdge(ay, item.y ?? 0, frame.height) - ay * h;
  return { left, top, width: w, height: h };
}

// ── text ──

/** Where a text item's lines go: the x its alignment hangs from, the top of its first line. */
function textLayout(item, frame) {
  const px = Math.round((item.size ?? 16) * frame.scale);
  const lines = String(item.text ?? "").split("\n");
  if (!item.anchor) {
    return { px, lines, x: item.x * frame.width, top: item.y * frame.height, align: item.align ?? "left" };
  }
  const [ax, ay] = anchorOf(item);
  const block = (lines.length - 1) * px * 1.25 + px;
  return {
    px,
    lines,
    x: fromEdge(ax, item.x ?? 0, frame.width),
    top: fromEdge(ay, item.y ?? 0, frame.height) - ay * block,
    align: item.align ?? TEXT_ALIGN_AT[ax],
  };
}

const fontOf = (item, px) => `${item.weight ?? 600} ${px}px ${item.font ?? HUD_FONT}`;

function paintText(g, item, frame) {
  const { px, lines, x, top, align } = textLayout(item, frame);
  const { scale } = frame;
  g.font = fontOf(item, px);
  g.textAlign = align;
  g.textBaseline = "top";
  if (item.shadow !== false) {
    g.shadowColor = "rgba(0,0,0,0.85)";
    g.shadowBlur = 2 * scale;
    g.shadowOffsetY = 1 * scale;
  }
  g.fillStyle = item.color ?? HUD_COLOR;
  lines.forEach((line, i) => {
    g.fillText(line, x, top + i * px * 1.25);
  });
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
}

function textBox(item, frame, measure) {
  const { px, lines, x, top, align } = textLayout(item, frame);
  const font = fontOf(item, px);
  const width = Math.max(...lines.map((line) => measure(font, px, line)));
  const height = (lines.length - 1) * px * 1.25 + px;
  let left = x;
  if (align === "center") left = x - width / 2;
  else if (align === "right" || align === "end") left = x - width;
  return { left, top, width, height };
}

// ── bar ──

function barBox(item, frame) {
  const w = (item.w ?? 0.2) * frame.width;
  const h = (item.h ?? 0.018) * frame.height;
  if (!item.anchor) return { left: item.x * frame.width, top: item.y * frame.height, width: w, height: h };
  return placed(item, w, h, frame);
}

function paintBar(g, item, frame) {
  const box = barBox(item, frame);
  g.fillStyle = item.back ?? "rgba(0,0,0,0.55)";
  g.fillRect(box.left, box.top, box.width, box.height);
  g.fillStyle = item.color ?? HUD_COLOR;
  g.fillRect(box.left, box.top, box.width * clamp01(item.fraction ?? 0), box.height);
}

// ── crosshair ──

function crosshairBox(item, frame) {
  if (item.visible === false) return null;
  const reach = ((item.gap ?? 4) + (item.spread ?? 0) + (item.size ?? 10)) * frame.scale;
  return { left: frame.width / 2 - reach, top: frame.height / 2 - reach, width: 2 * reach, height: 2 * reach };
}

function paintCrosshair(g, item, frame) {
  if (item.visible === false) return;
  const { width, height, scale } = frame;
  const cx = width / 2;
  const cy = height / 2;
  const gap = ((item.gap ?? 4) + (item.spread ?? 0)) * scale;
  const len = (item.size ?? 10) * scale;
  g.strokeStyle = item.color ?? "#ffffff";
  g.lineWidth = (item.thickness ?? 2) * scale;
  g.beginPath();
  g.moveTo(cx - gap - len, cy);
  g.lineTo(cx - gap, cy);
  g.moveTo(cx + gap, cy);
  g.lineTo(cx + gap + len, cy);
  g.moveTo(cx, cy - gap - len);
  g.lineTo(cx, cy - gap);
  g.moveTo(cx, cy + gap);
  g.lineTo(cx, cy + gap + len);
  g.stroke();
  if (item.dot) {
    g.fillStyle = item.color ?? "#ffffff";
    g.fillRect(cx - 1 * scale, cy - 1 * scale, 2 * scale, 2 * scale);
  }
}

// ── arc: gauges, tachometers, rings ──

function arcBox(item, frame) {
  const extent = 2 * ((item.r ?? ARC_RADIUS) + (item.width ?? ARC_WIDTH) / 2) * frame.height;
  return placed(item, extent, extent, frame);
}

function strokeArc(g, circle, from, to, color) {
  g.strokeStyle = color;
  g.beginPath();
  g.arc(circle.x, circle.y, circle.radius, from, to);
  g.stroke();
}

function paintArc(g, item, frame) {
  const box = arcBox(item, frame);
  const circle = {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    radius: (item.r ?? ARC_RADIUS) * frame.height,
  };
  const start = item.start ?? GAUGE_START;
  const end = item.end ?? GAUGE_END;
  g.lineWidth = (item.width ?? ARC_WIDTH) * frame.height;
  g.lineCap = item.cap ?? "round";
  if (item.back) strokeArc(g, circle, start, end, item.back);
  const fraction = clamp01(item.fraction ?? 1);
  if (fraction > 0) strokeArc(g, circle, start, start + (end - start) * fraction, item.color ?? HUD_COLOR);
}

// ── panel: a rounded rectangle behind a group of readouts ──

function panelBox(item, frame) {
  return placed(item, (item.w ?? PANEL_SIZE) * frame.height, (item.h ?? PANEL_SIZE) * frame.height, frame);
}

function paintPanel(g, item, frame) {
  const box = panelBox(item, frame);
  g.beginPath();
  if (typeof g.roundRect === "function") {
    g.roundRect(box.left, box.top, box.width, box.height, (item.radius ?? PANEL_RADIUS) * frame.height);
  } else {
    g.rect(box.left, box.top, box.width, box.height);
  }
  if (item.fill !== null) {
    g.fillStyle = item.fill ?? PANEL_FILL;
    g.fill();
  }
  if (item.stroke) {
    g.strokeStyle = item.stroke;
    g.lineWidth = (item.width ?? STROKE_WIDTH) * frame.height;
    g.stroke();
  }
}

// ── path: an SVG path string, drawn through its viewBox into its box ──

function viewBoxOf(item) {
  const raw = typeof item.viewBox === "string" ? item.viewBox.trim().split(/[\s,]+/) : item.viewBox;
  const numbers = Array.isArray(raw) ? raw.map(Number) : [];
  const usable = numbers.length === 4 && numbers.every(Number.isFinite) && numbers[2] > 0 && numbers[3] > 0;
  return usable ? numbers : PATH_VIEWBOX;
}

function pathBox(item, frame) {
  return placed(item, (item.w ?? PATH_SIZE) * frame.height, (item.h ?? PATH_SIZE) * frame.height, frame);
}

function shapeOf(item) {
  if (typeof Path2D !== "function") return null;
  if (!PATHS.has(item)) PATHS.set(item, new Path2D(String(item.d ?? "")));
  return PATHS.get(item);
}

function paintPath(g, item, frame) {
  const shape = shapeOf(item);
  if (!shape) return;
  const box = pathBox(item, frame);
  const [vx, vy, vw, vh] = viewBoxOf(item);
  const sx = box.width / vw;
  const sy = box.height / vh;
  g.save();
  g.translate(box.left, box.top);
  g.scale(sx, sy);
  if (vx !== 0 || vy !== 0) g.translate(-vx, -vy);
  if (item.fill !== null) {
    g.fillStyle = item.fill ?? item.color ?? HUD_COLOR;
    g.fill(shape);
  }
  if (item.stroke) {
    g.strokeStyle = item.stroke;
    g.lineWidth = ((item.width ?? STROKE_WIDTH) * frame.height) / Math.max(sx, sy);
    g.stroke(shape);
  }
  g.restore();
}

// ── image: a file from assets/ or a data URL, drawn once it has decoded ──

function imageBox(item, frame, res) {
  const entry = res.images.get(item.src);
  const natural = entry?.ready && entry.img.naturalHeight > 0;
  const aspect = natural ? entry.img.naturalWidth / entry.img.naturalHeight : 1;
  let h = (item.h ?? IMAGE_HEIGHT) * frame.height;
  if (item.h == null && item.w != null) h = (item.w * frame.height) / aspect;
  const w = item.w == null ? h * aspect : item.w * frame.height;
  return placed(item, w, h, frame);
}

function paintImage(g, item, frame, res) {
  const entry = res.images.get(item.src);
  if (!entry?.ready) return;
  const box = imageBox(item, frame, res);
  g.drawImage(entry.img, box.left, box.top, box.width, box.height);
}

/** Start decoding an image the first time a HUD item names it; the HUD repaints when it arrives. */
function loadImage(res, src, state) {
  if (res.images.has(src) || typeof Image !== "function") return;
  const img = new Image();
  const entry = { img, ready: false, failed: false };
  res.images.set(src, entry);
  img.onload = () => {
    entry.ready = true;
    state.dirty = true;
    state.version += 1;
  };
  img.onerror = () => {
    entry.failed = true;
    state.version += 1;
    console.warn(`the HUD image ${src} could not be loaded`);
  };
  img.src = src;
}

/** The painter of each kind. An item of a kind nobody knows is skipped, never thrown on. */
const PAINTERS = {
  [HudItemKind.Text]: paintText,
  [HudItemKind.Bar]: paintBar,
  [HudItemKind.Crosshair]: paintCrosshair,
  [HudItemKind.Arc]: paintArc,
  [HudItemKind.Path]: paintPath,
  [HudItemKind.Image]: paintImage,
  [HudItemKind.Panel]: paintPanel,
};

/** The box each kind covers on the frame, in pixels, or null when it draws nothing. */
const BOXES = {
  [HudItemKind.Text]: (item, frame, _res, measure) => textBox(item, frame, measure),
  [HudItemKind.Bar]: barBox,
  [HudItemKind.Crosshair]: crosshairBox,
  [HudItemKind.Arc]: arcBox,
  [HudItemKind.Path]: pathBox,
  [HudItemKind.Image]: imageBox,
  [HudItemKind.Panel]: panelBox,
};

/** Paint every item, then the flash over them, onto the overlay's canvas at the drawing size. */
function paint(overlay, items, state, deps, res) {
  const { surface } = overlay;
  const { width, height } = drawingSize(deps);
  if (surface.width !== width || surface.height !== height) {
    surface.width = width;
    surface.height = height;
  }
  const g = surface.getContext("2d");
  g.clearRect(0, 0, width, height);
  const frame = frameOf({ width, height });
  for (const item of items.values()) PAINTERS[item.type]?.(g, item, frame, res);
  if (state.flashAlpha > 0.01) {
    g.globalAlpha = Math.min(1, state.flashAlpha);
    g.fillStyle = state.flashColor;
    g.fillRect(0, 0, width, height);
    g.globalAlpha = 1;
  }
  overlay.texture.needsUpdate = true;
  state.dirty = false;
}

// ── the measured summary ──

/** A text measurer on the overlay's own context, or an estimate where there is none (no DOM). */
function measurerFor(surface) {
  const g = surface.getContext?.("2d") ?? null;
  if (!g || typeof g.measureText !== "function") return (_font, px, text) => text.length * px * 0.55;
  return (font, _px, text) => {
    g.font = font;
    return g.measureText(text).width;
  };
}

/** The cells of the coverage grid whose centres a span covers, or the one its centre falls in. */
function cellSpan(from, to, cells) {
  const first = Math.max(0, Math.ceil(from * cells - 0.5));
  const last = Math.min(cells - 1, Math.floor(to * cells - 0.5));
  if (first <= last) return [first, last];
  const middle = Math.min(cells - 1, Math.max(0, Math.floor(((from + to) / 2) * cells)));
  return [middle, middle];
}

/** The share of the frame the boxes cover, measured on HUD_COVERAGE_GRID (overlaps counted once). */
function coverageOf(boxes) {
  const { cols, rows } = HUD_COVERAGE_GRID;
  const cells = new Uint8Array(cols * rows);
  for (const box of boxes) {
    const offFrame = box.x1 <= 0 || box.x0 >= 1 || box.y1 <= 0 || box.y0 >= 1;
    if (offFrame) continue;
    const [c0, c1] = cellSpan(box.x0, box.x1, cols);
    const [r0, r1] = cellSpan(box.y0, box.y1, rows);
    for (let r = r0; r <= r1; r++) cells.fill(1, r * cols + c0, r * cols + c1 + 1);
  }
  let covered = 0;
  for (const cell of cells) covered += cell;
  return Number((covered / cells.length).toFixed(3));
}

const areaOf = (box) => (box.x1 - box.x0) * (box.y1 - box.y0);

/** A panel with another item inside it is a group, not a collision. */
function panelHolds(outer, inner) {
  const eps = 1e-6;
  if (!outer.panel) return false;
  return (
    outer.x0 <= inner.x0 + eps && outer.y0 <= inner.y0 + eps && outer.x1 >= inner.x1 - eps && outer.y1 >= inner.y1 - eps
  );
}

/** Does `inner`, the smaller by far, sit in `outer` (`shared` is the area the two have in common)? */
function sitsIn(outer, inner, shared) {
  const innerArea = areaOf(inner);
  const muchSmaller = innerArea * HUD_GROUP_AREA_RATIO <= areaOf(outer);
  return muchSmaller && shared >= HUD_GROUPED_SHARE * innerArea;
}

/** Do two items run into each other: a real share of the smaller one, and neither one sitting in the other? */
function collide(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const shared = w * h;
  if (shared < HUD_OVERLAP_MIN * Math.min(areaOf(a), areaOf(b))) return false;
  const grouped = panelHolds(a, b) || panelHolds(b, a) || sitsIn(a, b, shared) || sitsIn(b, a, shared);
  return !grouped;
}

/** An id as the summary writes it: clipped to HUD_SUMMARY_ID_CHARS, the cut marked. */
function summaryId(id) {
  return id.length > HUD_SUMMARY_ID_CHARS ? `${id.slice(0, HUD_SUMMARY_ID_CHARS - 1)}…` : id;
}

/**
 * The pairs of items that run into each other, at most HUD_MAX_OVERLAPS, in the order the sweep
 * (left edge first) finds them; within a pair, the item added first comes first.
 */
function overlapsOf(boxes) {
  const sorted = boxes.filter((box) => areaOf(box) > 0).sort((a, b) => a.x0 - b.x0);
  const out = [];
  let compared = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].x0 < a.x1; j++) {
      compared += 1;
      if (compared > HUD_OVERLAP_COMPARISONS || out.length >= HUD_MAX_OVERLAPS) return out;
      const b = sorted[j];
      if (collide(a, b)) out.push((a.order < b.order ? [a.id, b.id] : [b.id, a.id]).map(summaryId));
    }
  }
  return out;
}

/** Every item's box as fractions of the frame, with the kinds counted. */
function measure(items, frame, res, measureText) {
  const kinds = {};
  const boxes = [];
  let order = 0;
  for (const [id, item] of items) {
    kinds[item.type] = (kinds[item.type] ?? 0) + 1;
    const box = BOXES[item.type]?.(item, frame, res, measureText) ?? null;
    order += 1;
    if (!box) continue;
    boxes.push({
      id,
      order,
      panel: item.type === HudItemKind.Panel,
      x0: box.left / frame.width,
      y0: box.top / frame.height,
      x1: (box.left + box.width) / frame.width,
      y1: (box.top + box.height) / frame.height,
    });
  }
  return { kinds, coverage: coverageOf(boxes), overlaps: overlapsOf(boxes) };
}

/** The first `limit` item ids, each clipped as the summary writes it. */
function firstIds(items, limit) {
  const out = [];
  for (const id of items.keys()) {
    if (out.length >= limit) break;
    out.push(summaryId(id));
  }
  return out;
}

/** What a game draws with: `__studio.hud.text(id, text)`, `.bar`, `.arc`, `.panel`, `.path`, `.image`, `.font`, and the rest. */
function hudApi(items, state, res) {
  /** Something to draw changed: repaint, and measure again. */
  function touch() {
    state.dirty = true;
    state.version += 1;
  }
  function set(id, item) {
    items.set(String(id), item);
    touch();
  }
  return {
    text: (id, text, opts = {}) => set(id, { type: HudItemKind.Text, text, x: 0.02, y: 0.03, ...opts }),
    bar: (id, fraction, opts = {}) => set(id, { type: HudItemKind.Bar, fraction, x: 0.02, y: 0.94, ...opts }),
    crosshair: (opts = {}) => set("crosshair", { type: HudItemKind.Crosshair, visible: true, ...opts }),
    arc: (id, opts = {}) => set(id, { type: HudItemKind.Arc, x: 0.02, y: 0.03, ...opts }),
    panel: (id, opts = {}) => set(id, { type: HudItemKind.Panel, x: 0.02, y: 0.03, ...opts }),
    path: (id, d, opts = {}) => set(id, { type: HudItemKind.Path, d, x: 0.02, y: 0.03, ...opts }),
    image: (id, src, opts = {}) => {
      loadImage(res, String(src), state);
      set(id, { type: HudItemKind.Image, src: String(src), x: 0.02, y: 0.03, ...opts });
    },
    font: (family, url) => loadFont(family, url, state),
    flash: (color = "#ffffff", alpha = 0.5) => {
      state.flashColor = color;
      state.flashAlpha = Math.max(state.flashAlpha, Math.min(1, Number(alpha) || 0));
      state.dirty = true;
    },
    remove: (id) => {
      if (items.delete(String(id))) touch();
    },
    clear: () => {
      items.clear();
      touch();
    },
    get: (id) => items.get(String(id)) ?? null,
    items: () => [...items.keys()],
    enable: (on = true) => {
      state.enabled = Boolean(on);
      touch();
    },
  };
}

/** Register a bundled font (`font("Racing", "assets/racing.woff2")`); text naming it repaints once it loads. */
function loadFont(family, url, state) {
  const fonts = typeof document === "object" ? document?.fonts : null;
  if (typeof FontFace !== "function" || !fonts) return;
  const face = new FontFace(String(family), `url(${JSON.stringify(String(url))})`);
  state.fontsLoading += 1;
  face
    .load()
    .then((loaded) => {
      fonts.add(loaded);
      state.dirty = true;
      state.version += 1;
    })
    .catch((err) => console.warn(`the HUD font ${family} could not be loaded from ${url}`, err))
    .finally(() => {
      state.fontsLoading -= 1;
    });
}

/** Render the overlay over the frame already drawn, without clearing it, to the screen. */
function composeOver(renderer, { scene, camera }) {
  const autoClear = renderer.autoClear;
  const target = typeof renderer.getRenderTarget === "function" ? renderer.getRenderTarget() : null;
  try {
    renderer.autoClear = false;
    if (target && typeof renderer.setRenderTarget === "function") renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = autoClear;
  }
}

/** Items whose pixels have not arrived yet: images still decoding, plus fonts still loading. */
function pendingOf(items, state, res) {
  let pending = state.fontsLoading;
  for (const item of items.values()) {
    if (item.type !== HudItemKind.Image) continue;
    const entry = res.images.get(item.src);
    if (!entry?.ready && !entry?.failed) pending += 1;
  }
  return pending;
}

/**
 * A 2D canvas painted on demand, uploaded as a texture on one full-frame quad in its own
 * orthographic scene, composited after the world render without clearing. The quad is tagged
 * `hud` and named `studio-hud`; `count('hud') === 1` is the harness's proof that a game has
 * exactly one HUD.
 *
 * `deps.renderer()` and `deps.canvas()` are accessors, not values: the renderer a game passed to
 * `installStudio` and the one the studio attached to are read at the moment they are used.
 */
export function createHud(deps) {
  const items = new Map();
  const overlay = createOverlay();
  const state = { flashAlpha: 0, flashColor: "#ffffff", dirty: true, enabled: true, version: 0, fontsLoading: 0 };
  const res = { images: new Map() };
  let measured = null;

  /** The measured layout, recomputed only when an item or the frame size changed. */
  function measuredNow() {
    const size = drawingSize(deps);
    const fresh =
      measured &&
      measured.version === state.version &&
      measured.width === size.width &&
      measured.height === size.height;
    if (fresh) return measured.value;
    const value = state.enabled
      ? measure(items, frameOf(size), res, measurerFor(overlay.surface))
      : { kinds: {}, coverage: 0, overlaps: [] };
    measured = { version: state.version, width: size.width, height: size.height, value };
    return value;
  }

  return {
    api: hudApi(items, state, res),
    scene: overlay.scene,
    get flashAlpha() {
      return state.flashAlpha;
    },
    set flashAlpha(v) {
      state.flashAlpha = v;
      state.dirty = true;
    },
    /** Called once per simulation step: the flash fades on simulated time, never the wall clock. */
    tick() {
      if (state.flashAlpha > 0) {
        state.flashAlpha *= FLASH_DECAY;
        if (state.flashAlpha < 0.01) state.flashAlpha = 0;
        state.dirty = true;
      }
    },
    /** Composite the overlay onto the current frame. No renderer, or nothing to draw: no-op. */
    compose() {
      const renderer = deps.renderer();
      const cannotDraw = !renderer || typeof renderer.render !== "function" || !state.enabled;
      if (cannotDraw) return;
      if (items.size === 0 && state.flashAlpha <= 0) return;
      if (state.dirty) paint(overlay, items, state, deps, res);
      composeOver(renderer, overlay);
    },
    /**
     * What `state().hud` reports: the first HUD_SUMMARY_ITEMS ids (each clipped to
     * HUD_SUMMARY_ID_CHARS) and how many there are, the kinds, the share of the frame the items
     * cover, the pairs that run into each other, and how many images or fonts have not arrived
     * yet. Bounded however many items a game draws, and however long their ids.
     */
    summary() {
      const { kinds, coverage, overlaps } = measuredNow();
      const crosshair = items.get("crosshair");
      return {
        items: firstIds(items, HUD_SUMMARY_ITEMS),
        count: items.size,
        kinds,
        coverage,
        overlaps,
        pending: pendingOf(items, state, res),
        crosshair: crosshair ? crosshair.visible !== false : false,
        flash: Number(state.flashAlpha.toFixed(3)),
      };
    },
  };
}
