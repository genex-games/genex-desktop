/**
 * The other names models use for the `computer` tool's actions — cua's and OpenAI's computer-use
 * spellings — read as the studio's own before parsing. They are accepted, never advertised: the
 * tool description stays Anthropic's vocabulary, and a model trained on another one (a small local
 * model above all) still lands its action instead of spending a turn on "no action click".
 */

/** Wheel pixels per notch — what a physical wheel click delivers to a page. */
export const SCROLL_NOTCH_PX = 120;

/** A plain rename: the alias, and the studio's own action it means. */
const RENAMED: Record<string, string> = {
  type_text: "type",
  press_key: "key",
  hotkey: "key",
  move_cursor: "mouse_move",
  move: "mouse_move",
  drag_to: "left_click_drag",
  get_cursor_position: "cursor_position",
};

/** OpenAI's `click{button}`: which of the studio's clicks each button means. */
const CLICK_BUTTONS: Record<string, string> = {
  left: "left_click",
  right: "right_click",
  middle: "middle_click",
  wheel: "middle_click",
};

/** cua's one-direction scrolls. */
const SCROLL_ALIASES: Record<string, string> = {
  scroll_up: "up",
  scroll_down: "down",
  scroll_left: "left",
  scroll_right: "right",
};

/** A finite number, or null. */
function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) ? n : null;
}

/** OpenAI's `scroll{scroll_x, scroll_y}` in pixels → a direction and a number of notches. */
function pixelScroll(raw: Record<string, unknown>): Record<string, unknown> | null {
  const dx = finite(raw.scroll_x);
  const dy = finite(raw.scroll_y);
  if (dx === null && dy === null) return null;
  const vertical = Math.abs(dy ?? 0) >= Math.abs(dx ?? 0);
  const amount = vertical ? (dy ?? 0) : (dx ?? 0);
  const positive = vertical ? "down" : "right";
  const negative = vertical ? "up" : "left";
  return {
    ...raw,
    scroll_direction: amount >= 0 ? positive : negative,
    scroll_amount: Math.max(1, Math.round(Math.abs(amount) / SCROLL_NOTCH_PX)),
  };
}

/** A drag's `path` of points → where it starts and where it ends. */
function pathDrag(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.path) || raw.path.length < 2) return { ...raw, action: "left_click_drag" };
  return {
    ...raw,
    action: "left_click_drag",
    start_coordinate: raw.start_coordinate ?? raw.path[0],
    coordinate: raw.coordinate ?? raw.path.at(-1),
  };
}

/** `keypress{keys: ["CTRL", "S"]}` → one chord the key action reads. */
function keysChord(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = Array.isArray(raw.keys) ? raw.keys.map(String).filter(Boolean) : [];
  return { ...raw, action: "key", ...(raw.text === undefined && keys.length ? { text: keys.join("+") } : {}) };
}

/**
 * The arguments with any alias read as the studio's own action. `action` is the name as the
 * caller spelled it after trimming and lower-casing; everything else passes through untouched.
 */
export function resolveAlias(action: string, raw: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(RENAMED, action)) return { ...raw, action: RENAMED[action] };
  if (Object.hasOwn(SCROLL_ALIASES, action))
    return { ...raw, action: "scroll", scroll_direction: SCROLL_ALIASES[action] };
  if (action === "drag") return pathDrag(raw);
  if (action === "keypress") return keysChord(raw);
  if (action === "click") {
    const button = String(raw.button ?? "left").toLowerCase();
    return { ...raw, action: Object.hasOwn(CLICK_BUTTONS, button) ? CLICK_BUTTONS[button] : "left_click" };
  }
  if (action === "scroll" && raw.scroll_direction === undefined && raw.direction === undefined) {
    return pixelScroll(raw) ?? raw;
  }
  return raw;
}
