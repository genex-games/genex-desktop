/**
 * First launch: who is welcomed, what each subscription's one-line button says in every sign-in
 * state, and that the art draws finite shapes from where the words really are.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectView,
  markState,
  shouldWelcome,
  WELCOMED_KEY,
  type ConnectInput,
} from "../../src/renderer/onboarding/state.ts";
import {
  drawChip,
  drawMarks,
  drawPlanner,
  drawWelcome,
  PLANNER_VIEW,
  PROMPT_ORIGIN,
  type Palette,
} from "../../src/renderer/onboarding/art.ts";

const storage = (value: string | null) => ({ getItem: (key: string) => (key === WELCOMED_KEY ? value : null) });
const engine = (
  code: "ready" | "needs_login" | "not_installed" | "error",
  cli: "ready" | "missing" | "incompatible" = "ready",
): ConnectInput["engine"] => ({
  status: { code, detail: "" },
  account: { source: "none", afterSignOut: "signed-out", cli: { state: cli } },
});

describe("first launch", () => {
  it("welcomes only an allowed session with an empty library that was never welcomed", () => {
    assert.equal(shouldWelcome(true, 0, storage(null)), true);
    assert.equal(shouldWelcome(true, 1, storage(null)), false, "someone with games already knows the app");
    assert.equal(shouldWelcome(true, 0, storage("1")), false, "finishing or skipping is remembered");
    assert.equal(shouldWelcome(false, 0, storage(null)), false, "smoke, self-test and fixture sessions");
    assert.equal(shouldWelcome(undefined, 0, storage(null)), false, "an older main process says nothing");
  });

  it("gives each subscription one line for every step of its sign-in", () => {
    const claude = (input: Partial<ConnectInput>) =>
      connectView("claude-code", { engine: engine("needs_login"), ...input });
    assert.deepEqual(claude({}), { kind: "action", action: "connect", label: "Connect Claude Code" });
    assert.deepEqual(claude({ claude: "starting" }), { kind: "busy", label: "Opening sign-in…", cancel: true });
    assert.deepEqual(claude({ claude: "browser" }), { kind: "busy", label: "Finish in your browser", cancel: true });
    // Claude Code offers a code box beside its browser sign-in; the browser nearly always finishes on its own.
    assert.deepEqual(claude({ claude: "code" }), {
      kind: "busy",
      label: "Finish in your browser",
      cancel: true,
      offersCode: true,
    });
    assert.deepEqual(claude({ claude: "code", pastingCode: true }), { kind: "code" });
    assert.deepEqual(claude({ claude: "browser", pastingCode: true }), claude({ claude: "browser" }));
    assert.deepEqual(claude({ claude: "verifying" }), { kind: "busy", label: "Checking…", cancel: false });
    assert.deepEqual(claude({ claude: "terminal" }), {
      kind: "action",
      action: "terminal",
      label: "Finish in the terminal",
    });
    assert.deepEqual(
      claude({ claude: "failed" }),
      { kind: "action", action: "connect", label: "Connect Claude Code" },
      "a failed sign-in can be tried again",
    );
    assert.deepEqual(claude({ engine: engine("ready") }), { kind: "on", label: "Claude Code connected" });
    assert.deepEqual(
      claude({ engine: engine("ready"), claude: "browser" }),
      { kind: "on", label: "Claude Code connected" },
      "the engine's answer wins",
    );
    assert.deepEqual(claude({ engine: engine("not_installed", "missing") }), {
      kind: "action",
      action: "install",
      label: "Set up Claude Code",
    });
    assert.deepEqual(claude({ engine: engine("needs_login", "incompatible") }), {
      kind: "action",
      action: "update",
      label: "Update Claude Code",
    });
    assert.deepEqual(claude({ engine: engine("error") }), {
      kind: "action",
      action: "recheck",
      label: "Check Claude Code again",
    });
    assert.deepEqual(claude({ engine: engine("not_installed", "missing"), checking: true }), {
      kind: "busy",
      label: "Checking…",
      cancel: false,
    });

    const codex = (input: Partial<ConnectInput>) => connectView("codex", { engine: engine("needs_login"), ...input });
    assert.deepEqual(codex({}), { kind: "action", action: "connect", label: "Connect ChatGPT" });
    // Codex's browser sign-in has no window of its own over the welcome: the button waits and can cancel.
    assert.deepEqual(codex({ codexActive: true, codex: "waiting" }), {
      kind: "busy",
      label: "Finish in your browser",
      cancel: true,
    });
    assert.deepEqual(codex({ codexActive: true, codex: "verifying" }), {
      kind: "busy",
      label: "Checking…",
      cancel: false,
    });
    assert.deepEqual(
      codex({ claude: "browser" }),
      { kind: "action", action: "connect", label: "Connect ChatGPT" },
      "Claude's sign-in is not ChatGPT's",
    );
    assert.deepEqual(codex({ engine: engine("not_installed", "missing") }), {
      kind: "action",
      action: "install",
      label: "Set up Codex",
    });
    assert.deepEqual(codex({ engine: engine("ready") }), { kind: "on", label: "ChatGPT connected" });
  });

  it("gives OpenCode one line for every step of its terminal sign-in", () => {
    const opencode = (input: Partial<ConnectInput>) =>
      connectView("opencode", { engine: engine("needs_login"), ...input });
    assert.deepEqual(opencode({}), { kind: "action", action: "connect", label: "Connect OpenCode" });
    assert.deepEqual(opencode({ openCodeSigningIn: true }), { kind: "busy", label: "Signing in…", cancel: true });
    assert.deepEqual(opencode({ engine: engine("ready") }), { kind: "on", label: "OpenCode connected" });
    assert.deepEqual(opencode({ engine: engine("not_installed", "missing") }), {
      kind: "action",
      action: "install",
      label: "Set up OpenCode",
    });
    assert.deepEqual(opencode({ engine: engine("needs_login", "incompatible") }), {
      kind: "action",
      action: "update",
      label: "Update OpenCode",
    });
    assert.deepEqual(opencode({ engine: engine("error") }), {
      kind: "action",
      action: "recheck",
      label: "Check OpenCode again",
    });
  });

  it("installs or updates a CLI in place and says so while it runs", () => {
    const view = (id: "claude-code" | "codex", input: Partial<ConnectInput>) =>
      connectView(id, { engine: engine("not_installed", "missing"), ...input });
    assert.deepEqual(view("codex", { installing: true }), { kind: "busy", label: "Setting up Codex…", cancel: false });
    assert.deepEqual(view("claude-code", { engine: engine("needs_login", "incompatible"), installing: true }), {
      kind: "busy",
      label: "Updating Claude Code…",
      cancel: false,
    });
    assert.equal(view("codex", { installing: true, checking: true }).kind, "busy");
    assert.deepEqual(view("codex", { installing: true, checking: true }), view("codex", { installing: true }));
    assert.equal(view("codex", { engine: engine("ready"), installing: true }).kind, "on", "a working CLI is connected");
    assert.equal(markState(view("codex", { installing: true })), "busy");
  });

  it("shows each mark as its button's state", () => {
    assert.equal(markState({ kind: "on", label: "" }), "on");
    assert.equal(markState({ kind: "busy", label: "", cancel: false }), "busy");
    assert.equal(markState({ kind: "code" }), "busy");
    assert.equal(markState({ kind: "action", action: "install", label: "" }), "missing");
    assert.equal(markState({ kind: "action", action: "connect", label: "" }), "idle");
  });
});

/** A 2D context that records what is drawn and refuses a non-finite coordinate. */
function recorder() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const finite = (name: string, args: unknown[]) => {
    for (const arg of args) if (typeof arg === "number") assert.ok(Number.isFinite(arg), `${name}(${args.join(", ")})`);
    calls.push({ name, args });
  };
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy({ font: "", letterSpacing: "0px" } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 8 });
      if (key === "createLinearGradient" || key === "createRadialGradient")
        return (...args: unknown[]) => {
          finite(key, args);
          return gradient;
        };
      return (...args: unknown[]) => finite(key, args);
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
const palette: Palette = {
  accent: [136, 172, 239],
  ink: [222, 224, 226],
  muted: [168, 169, 172],
  green: [124, 209, 148],
  orange: [239, 190, 114],
};

describe("first-launch art", () => {
  it("streams the sent prompt from where the composer shows it", () => {
    const { ctx, calls } = recorder();
    drawWelcome(ctx, 0, "Ab", { font: "15px sans-serif", spacing: "-0.44px" }, palette);
    const letters = calls.filter((call) => call.name === "fillText");
    assert.deepEqual(
      letters.map((call) => call.args[0]),
      ["A", "b"],
    );
    const moves = calls
      .filter((call) => call.name === "translate")
      .slice(-2)
      .map((call) => call.args);
    assert.deepEqual(
      moves,
      [
        [PROMPT_ORIGIN.x + 4, PROMPT_ORIGIN.y],
        [PROMPT_ORIGIN.x + 12, PROMPT_ORIGIN.y],
      ],
      "each letter leaves from its own place",
    );
  });

  it("draws every part of the welcome, the marks and the chip with finite coordinates", () => {
    const globals = globalThis as Record<string, unknown>;
    globals.Path2D ??= class {
      addPath() {}
    };
    globals.DOMMatrix ??= class {};
    for (const t of [0, 0.5, 1.1, 2.5, 4.8, 9, 14.5, 16])
      drawWelcome(
        recorder().ctx,
        t,
        "A tiny space shooter in a field of asteroids",
        { font: "15px sans-serif", spacing: "0px" },
        palette,
      );
    drawWelcome(recorder().ctx, 4.8, "Ab", { font: "15px sans-serif", spacing: "0px" }, palette, true);
    for (const state of ["idle", "busy", "on", "missing"] as const)
      for (const tg of [0, 0.3, 2, 7.5]) {
        drawMarks(
          recorder().ctx,
          { claude: state, codex: state },
          tg,
          { claude: tg < 1 ? tg : -1, codex: -1 },
          { claude: 192, codex: 448 },
          palette,
        );
      }
    for (const state of ["idle", "downloading", "ready"] as const) drawChip(recorder().ctx, state, 40, 1.5, palette);
  });

  it("the stage's Planner writes its page once, then only floats, inside the part of the stage it is cut from", () => {
    const lines = (t: number, still = false) => {
      const { ctx, calls } = recorder();
      drawPlanner(ctx, t, palette, still);
      return calls.filter((call) => call.name === "lineTo" || call.name === "moveTo");
    };
    const writing = lines(0.8).length;
    const written = lines(4).length;
    assert.ok(writing < written, "the page is still being written early on");
    assert.equal(lines(9).length, written, "once written, the page keeps what it has: it only floats");
    assert.equal(lines(0, true).length, written, "a still frame shows the page written");
    const { x, y, width, height } = PLANNER_VIEW;
    for (const t of [0.8, 4, 9])
      for (const call of lines(t)) {
        const [px, py] = call.args as number[];
        assert.ok(px >= x && px <= x + width && py >= y && py <= y + height, `${call.name}(${px}, ${py}) at ${t}s`);
      }
  });
});
