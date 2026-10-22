/**
 * The colour tweaker's own stylesheet. The panel keeps fixed colours of its own instead of the
 * app's tokens: it has to stay readable while those tokens are being pulled around, flashed to
 * locate a role, or set to something unreadable on purpose.
 */
export const TWEAKER_CSS = `
[data-color-tweaker] {
  --ct-bg: #141416;
  --ct-raised: #1e1e21;
  --ct-hover: #2a2a2e;
  --ct-line: #ffffff17;
  --ct-ink: #ececef;
  --ct-ink-2: #a3a3ab;
  --ct-ink-3: #75757d;
  --ct-accent: #7aa2ff;
  --ct-ok: #6fcf8a;
  --ct-warn: #f0b35a;
  position: fixed;
  z-index: 2147483000;
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--ct-bg);
  color: var(--ct-ink);
  border: 1px solid #ffffff1f;
  border-radius: 12px;
  box-shadow: 0 16px 48px #0000009e, 0 0 0 1px #000000a6;
  font: 12px/1.35 -apple-system, BlinkMacSystemFont, "TikTok Sans Genex", system-ui, sans-serif;
  color-scheme: dark;
  user-select: none;
  overflow: hidden;
  outline: none;
  /* A modal dialog turns off pointer events on the body; the panel stays pressable over it. */
  pointer-events: auto;
  /* Over the title bar's drag strip, the window would take the press: the panel keeps its own. */
  -webkit-app-region: no-drag;
}
[data-color-tweaker] * { box-sizing: border-box; }
[data-color-tweaker] button, [data-color-tweaker] select { font: inherit; color: inherit; }
[data-color-tweaker] :focus-visible { outline: 2px solid var(--ct-accent); outline-offset: 1px; }
.ct-head {
  display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 6px 0 10px;
  cursor: grab; flex-shrink: 0;
}
[data-color-tweaker][data-dragging] .ct-head { cursor: grabbing; }
[data-color-tweaker]:not([data-collapsed]) .ct-head { border-bottom: 1px solid var(--ct-line); }
.ct-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-title span { color: var(--ct-ink-3); font-weight: 400; margin-left: 4px; }
.ct-count { color: var(--ct-warn); font-size: 11px; font-variant-numeric: tabular-nums; }
.ct-body { overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding-bottom: 8px; }
.ct-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px 0; }
.ct-grow { flex: 1; min-width: 0; }
.ct-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 24px;
  padding: 0 8px; border: 0; border-radius: 6px; background: var(--ct-raised); cursor: pointer;
  white-space: nowrap;
}
.ct-btn:hover { background: var(--ct-hover); }
.ct-btn:disabled { opacity: .4; cursor: default; background: var(--ct-raised); }
.ct-btn[data-primary] { background: var(--ct-accent); color: #0b1020; font-weight: 600; }
.ct-btn[data-primary]:hover { background: #95b5ff; }
.ct-icon { width: 24px; padding: 0; background: transparent; color: var(--ct-ink-2); }
.ct-icon:hover { color: var(--ct-ink); }
.ct-icon[data-mirror] svg { transform: scaleX(-1); }
.ct-select {
  flex: 1; min-width: 0; height: 24px; padding: 0 6px; border: 0; border-radius: 6px;
  background: var(--ct-raised); cursor: pointer;
}
.ct-seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 7px; background: var(--ct-raised); }
.ct-seg button { height: 20px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; cursor: pointer; color: var(--ct-ink-2); }
.ct-seg button[aria-pressed="true"] { background: var(--ct-hover); color: var(--ct-ink); }
.ct-section {
  padding: 12px 10px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--ct-ink-3);
}
.ct-section-row { display: flex; align-items: center; justify-content: space-between; padding-block: 6px 0; padding-inline-end: 6px; }
.ct-slider { display: grid; grid-template-columns: 64px 1fr 44px; align-items: center; gap: 8px; padding: 3px 10px; }
.ct-slider-label { color: var(--ct-ink-2); cursor: default; }
.ct-slider output { text-align: right; color: var(--ct-ink-2); font: 11px "Geist Mono", ui-monospace, monospace; }
.ct-slider input { width: 100%; }
[data-color-tweaker] input[type="range"] {
  -webkit-appearance: none; appearance: none; height: 14px; margin: 0; background: transparent; cursor: pointer;
}
[data-color-tweaker] input[type="range"]::-webkit-slider-runnable-track {
  height: 8px; border-radius: 4px; background: var(--track, #3a3a40); box-shadow: inset 0 0 0 1px #ffffff14;
}
[data-color-tweaker] input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 14px; height: 14px; margin-top: -3px; border-radius: 50%;
  background: #fff; box-shadow: 0 0 0 1px #0009, 0 1px 3px #0008; cursor: grab;
}
.ct-role { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 10px; }
.ct-role:hover { background: #ffffff08; }
.ct-swatch {
  width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 0; border-radius: 6px; cursor: pointer;
  box-shadow: inset 0 0 0 1px #ffffff26, 0 0 0 1px #0006;
}
.ct-role[data-open] .ct-swatch { box-shadow: 0 0 0 2px var(--ct-accent); }
.ct-picker { display: grid; gap: 10px; margin: 2px 10px 8px; padding: 10px; border-radius: 8px; background: #ffffff0a; }
.ct-sv { position: relative; height: 150px; border-radius: 6px; cursor: crosshair; touch-action: none; box-shadow: inset 0 0 0 1px #ffffff1a; }
.ct-hue {
  position: relative; height: 12px; border-radius: 6px; cursor: pointer; touch-action: none;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
}
.ct-thumb {
  position: absolute; width: 14px; height: 14px; border-radius: 50%; transform: translate(-50%, -50%);
  border: 2px solid #fff; box-shadow: 0 0 0 1px #0009, 0 1px 3px #0008; pointer-events: none;
}
.ct-shadow { margin: 2px 0 8px; padding: 4px 0 0; background: #ffffff0a; }
.ct-shadow .ct-picker { background: none; margin-top: 4px; }
.ct-role-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-role[data-changed] .ct-role-name::after { content: " •"; color: var(--ct-warn); }
.ct-role[data-auto] .ct-role-name::after { content: " auto"; color: var(--ct-ink-3); font-size: 10.5px; }
.ct-role[data-auto] .ct-hex { color: var(--ct-ink-3); }
.ct-role[data-auto] .ct-swatch { box-shadow: inset 0 0 0 1px #ffffff26, 0 0 0 1px #0006, 0 0 0 2px #ffffff14; }
.ct-badge { font: 10.5px "Geist Mono", ui-monospace, monospace; padding: 1px 4px; border-radius: 4px; color: var(--ct-ok); background: #6fcf8a1a; }
.ct-badge[data-low] { color: var(--ct-warn); background: #f0b35a1f; }
.ct-hex {
  width: 70px; height: 22px; padding: 0 6px; border: 1px solid transparent; border-radius: 5px;
  background: var(--ct-raised); font: 11px "Geist Mono", ui-monospace, monospace; user-select: text;
}
.ct-hex:focus { border-color: var(--ct-accent); outline: none; }
.ct-hex[aria-invalid="true"] { border-color: var(--ct-warn); }
.ct-hint { padding: 10px 10px 2px; color: var(--ct-ink-3); font-size: 11px; line-height: 1.45; }
.ct-hint kbd { font: 10.5px "Geist Mono", ui-monospace, monospace; color: var(--ct-ink-2); }
`;
