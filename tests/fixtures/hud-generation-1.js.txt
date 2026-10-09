/**
 * The HUD: the one screen, drawn into the canvas (M4.2a moved it out of `studio.js`).
 *
 * Every readout, bar, crosshair and flash goes through `__studio.hud`, which paints a 2D canvas
 * and composites it as ONE quad over the world after each render. It is tagged `hud`, counted
 * once, and part of capture() — so the judge's picture is the user's picture. DOM UI is invisible
 * to the canvas capture, and two builders who each learned that once painted their own HUD quads;
 * the user got three.
 *
 * It lives here, beside `studio.js`, because it is the only part of the contract that needs
 * three: the contract itself must be importable by a game with no import map, another version of
 * three, or no three in its graph at all, and `studio.js` reaches this file through a dynamic
 * import the first time a game actually draws a HUD item. It is a CONTRACT FILE and ships with
 * every shape: withholding it would leave a bundled game with a dynamic import of a file that is
 * not there, and Vite and Rollup both fail on an unresolvable static-literal dynamic import.
 */

import * as THREE from "three";

/** The screen flash fades by this factor per simulation step. */
const FLASH_DECAY = 0.86;

/** The font a text item is drawn in unless it names its own. */
const HUD_FONT = "ui-sans-serif, system-ui, sans-serif";
/** The resolution the HUD's sizes are written for; larger screens scale them up. */
const DESIGN_HEIGHT = 720;

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

function paintText(g, item, width, height, scale) {
  const px = Math.round((item.size ?? 16) * scale);
  g.font = `${item.weight ?? 600} ${px}px ${item.font ?? HUD_FONT}`;
  g.textAlign = item.align ?? "left";
  g.textBaseline = "top";
  if (item.shadow !== false) {
    g.shadowColor = "rgba(0,0,0,0.85)";
    g.shadowBlur = 2 * scale;
    g.shadowOffsetY = 1 * scale;
  }
  g.fillStyle = item.color ?? "#e8eef8";
  const lines = String(item.text ?? "").split("\n");
  lines.forEach((line, i) => g.fillText(line, item.x * width, item.y * height + i * px * 1.25));
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
}

function paintBar(g, item, width, height) {
  const x = item.x * width;
  const y = item.y * height;
  const w = (item.w ?? 0.2) * width;
  const h = (item.h ?? 0.018) * height;
  g.fillStyle = item.back ?? "rgba(0,0,0,0.55)";
  g.fillRect(x, y, w, h);
  g.fillStyle = item.color ?? "#e8eef8";
  g.fillRect(x, y, w * Math.max(0, Math.min(1, item.fraction ?? 0)), h);
}

function paintCrosshair(g, item, width, height, scale) {
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

function paintItem(g, item, width, height, scale) {
  if (item.type === "text") paintText(g, item, width, height, scale);
  else if (item.type === "bar") paintBar(g, item, width, height);
  else if (item.type === "crosshair" && item.visible !== false) paintCrosshair(g, item, width, height, scale);
}

/** Paint every item, then the flash over them, onto the overlay's canvas at the drawing size. */
function paint(overlay, items, state, deps) {
  const { surface } = overlay;
  const { width, height } = drawingSize(deps);
  if (surface.width !== width || surface.height !== height) {
    surface.width = width;
    surface.height = height;
  }
  const g = surface.getContext("2d");
  g.clearRect(0, 0, width, height);
  const scale = Math.max(1, Math.min(width, height) / DESIGN_HEIGHT);
  for (const item of items.values()) paintItem(g, item, width, height, scale);
  if (state.flashAlpha > 0.01) {
    g.globalAlpha = Math.min(1, state.flashAlpha);
    g.fillStyle = state.flashColor;
    g.fillRect(0, 0, width, height);
    g.globalAlpha = 1;
  }
  overlay.texture.needsUpdate = true;
  state.dirty = false;
}

/** What a game draws with: `__studio.hud.text(id, text)`, `.bar`, `.crosshair`, `.flash`, and the rest. */
function hudApi(items, state) {
  function set(id, item) {
    items.set(String(id), item);
    state.dirty = true;
  }
  return {
    text: (id, text, opts = {}) => set(id, { type: "text", text, x: 0.02, y: 0.03, ...opts }),
    bar: (id, fraction, opts = {}) => set(id, { type: "bar", fraction, x: 0.02, y: 0.94, ...opts }),
    crosshair: (opts = {}) => set("crosshair", { type: "crosshair", visible: true, ...opts }),
    flash: (color = "#ffffff", alpha = 0.5) => {
      state.flashColor = color;
      state.flashAlpha = Math.max(state.flashAlpha, Math.min(1, Number(alpha) || 0));
      state.dirty = true;
    },
    remove: (id) => {
      if (items.delete(String(id))) state.dirty = true;
    },
    clear: () => {
      items.clear();
      state.dirty = true;
    },
    get: (id) => items.get(String(id)) ?? null,
    items: () => [...items.keys()],
    enable: (on = true) => {
      state.enabled = Boolean(on);
      state.dirty = true;
    },
  };
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
  const state = { flashAlpha: 0, flashColor: "#ffffff", dirty: true, enabled: true };
  return {
    api: hudApi(items, state),
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
      if (state.dirty) paint(overlay, items, state, deps);
      composeOver(renderer, overlay);
    },
    summary() {
      const crosshair = items.get("crosshair");
      return {
        items: [...items.keys()],
        crosshair: crosshair ? crosshair.visible !== false : false,
        flash: Number(state.flashAlpha.toFixed(3)),
      };
    },
  };
}
