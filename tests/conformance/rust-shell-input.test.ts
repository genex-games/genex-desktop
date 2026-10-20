/**
 * What the Rust web shell (`src/game-template-rust/web/shell.html`) sends the game's `input` verb
 * for real pads and the keyboard's layout (IN-7): each pad with its `Gamepad.id`, cut to 128
 * characters, so genex-core can tell its family; and, where the browser offers
 * `navigator.keyboard.getLayoutMap()`, the layout's key labels once, capped, for display only.
 * The shell's script runs as a classic script in a stand-in page without WebGPU (its boot stops at
 * the unsupported card), and its top-level functions are driven with a recording module.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SHELL = path.join(fileURLToPath(new URL("../..", import.meta.url)), "src/game-template-rust/web/shell.html");
/** The shell's caps (shell.html), restated as the wire's numbers. */
const PAD_ID_MAX_CHARS = 128;
const LAYOUT_KEYS_MAX = 256;

type Call = [op: string, arg: Record<string, unknown>];
type Page = Record<string, unknown> & {
  pollGamepads: (game: unknown, input: unknown) => void;
  forwardKeyboardLayout: (game: unknown) => Promise<void>;
};

/** The shell's page with `navigator` as given; the module double records every studio_call. */
function shellPage(navigator: Record<string, unknown>): { page: Page; game: unknown; calls: Call[] } {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(readFileSync(SHELL, "utf8"))?.[1] ?? "";
  const element = () => ({
    hidden: false,
    textContent: "",
    classList: { add() {} },
    addEventListener() {},
    setAttribute() {},
    append() {},
    replaceChildren() {},
  });
  const page: Record<string, unknown> = {
    navigator,
    document: { getElementById: element, querySelector: element, createElement: element, body: element() },
    location: { search: "" },
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout() {},
    // The page's own listeners (resize, the trap catcher of CRASH-3): never dispatched here.
    addEventListener() {},
  };
  page.window = page;
  vm.runInContext(script, vm.createContext(page));
  const calls: Call[] = [];
  const game = {
    studio_call: (op: string, arg: string) => {
      calls.push([op, JSON.parse(arg)]);
      return JSON.stringify({ ok: true, result: {} });
    },
  };
  return { page: page as Page, game, calls };
}

const pad = (index: number, id: unknown) => ({
  index,
  id,
  connected: true,
  buttons: [{ value: 0, pressed: true }],
  axes: [0.5, 0, 0, 0],
});
const freshInput = () => ({ held: new Set(), pads: new Map(), ticked: false });

describe("the web shell sends each real pad with its Gamepad.id", () => {
  it("names the pad's id beside its state, cut to 128 characters", () => {
    const playstation = "054c-0ce6-Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";
    const long = "x".repeat(PAD_ID_MAX_CHARS * 4);
    const { page, game, calls } = shellPage({ getGamepads: () => [pad(0, playstation), null, pad(2, long)] });
    page.pollGamepads(game, freshInput());
    assert.equal(calls.length, 1);
    const [op, arg] = calls[0] ?? [];
    assert.equal(op, "input");
    const pads = arg?.pads as Array<Record<string, unknown>>;
    assert.deepEqual(
      pads.map((sent) => sent.id),
      [playstation, long.slice(0, PAD_ID_MAX_CHARS)],
    );
    assert.deepEqual(pads[0], { index: 0, connected: true, buttons: [1], axes: [0.5, 0, 0, 0], id: playstation });
  });

  it("sends an id the browser leaves out (or gives as a non-string) as text, and nothing again until a pad changes", () => {
    const { page, game, calls } = shellPage({ getGamepads: () => [pad(0, undefined), pad(1, 7)] });
    const input = freshInput();
    page.pollGamepads(game, input);
    page.pollGamepads(game, input);
    assert.equal(calls.length, 1, "an unchanged pad is not sent twice");
    const pads = calls[0]?.[1].pads as Array<Record<string, unknown>>;
    assert.deepEqual(
      pads.map((sent) => sent.id),
      ["", "7"],
    );
  });
});

describe("the web shell sends the keyboard's layout labels once, where the browser has them", () => {
  it("sends the layout map's labels by key code as the input verb's layout", async () => {
    const layout = new Map([
      ["KeyW", "z"],
      ["KeyQ", "a"],
    ]);
    const { page, game, calls } = shellPage({ keyboard: { getLayoutMap: async () => layout } });
    await page.forwardKeyboardLayout(game);
    assert.deepEqual(calls, [["input", { layout: { KeyW: "z", KeyQ: "a" } }]]);
  });

  it("sends nothing without the API, when it refuses, or when it has nothing readable", async () => {
    const navigators: Array<Record<string, unknown>> = [
      {},
      { keyboard: {} },
      { keyboard: { getLayoutMap: async () => Promise.reject(new Error("not allowed")) } },
      {
        keyboard: {
          getLayoutMap: () => {
            throw new Error("sync throw");
          },
        },
      },
      { keyboard: { getLayoutMap: async () => null } },
      { keyboard: { getLayoutMap: async () => new Map([["KeyW", "a label far too long"]]) } },
    ];
    for (const navigator of navigators) {
      const { page, game, calls } = shellPage(navigator);
      await page.forwardKeyboardLayout(game);
      assert.deepEqual(calls, [], JSON.stringify(Object.keys(navigator)));
    }
  });

  it("keeps at most 256 keys, drops hostile codes and labels, and a __proto__ key is plain data", async () => {
    const entries: Array<[unknown, unknown]> = [
      ["__proto__", "p"],
      ["x".repeat(65), "long code"],
      ["KeyE", 5],
      [3, "number code"],
      ...Array.from({ length: LAYOUT_KEYS_MAX + 10 }, (_, i): [string, string] => [`Key${i}`, "k"]),
    ];
    const { page, game, calls } = shellPage({ keyboard: { getLayoutMap: async () => new Map(entries) } });
    await page.forwardKeyboardLayout(game);
    assert.equal(calls.length, 1);
    const sent = calls[0]?.[1].layout as Record<string, unknown>;
    assert.equal(Object.keys(sent).length, LAYOUT_KEYS_MAX);
    assert.equal(Object.hasOwn(sent, "__proto__"), true, "kept as an own key, never the prototype");
    assert.equal(sent.KeyE, undefined);
    assert.equal(Object.hasOwn(sent, "x".repeat(65)), false);
  });
});
