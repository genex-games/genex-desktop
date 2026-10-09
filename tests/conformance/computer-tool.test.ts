/**
 * The computer tool — the studio's own computer use, one vocabulary for every worker:
 * Anthropic's action names parsed from either transport (bridge strings, MCP values), mapped
 * onto the preview's HID plan, with the requested-state setup normalised and verified.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPUTER_ACTIONS,
  computerToInput,
  computerToolDefinition,
  describeComputerAction,
  normalizeSetup,
  parseComputerArgs,
  parsePoint,
  parseRegion,
  parseSurface,
  setupReached,
  setupVerifyExpr,
} from "../../src/substrate/computer-tool.ts";
import { clickModifiers, parseCombo, pointInView, capActions } from "../../src/substrate/preview-input.ts";

describe("computer tool — parsing either transport", () => {
  it("reads points and regions as the bridge (strings) and MCP (values) deliver them", () => {
    assert.deepEqual(parsePoint("412,300"), [412, 300]);
    assert.deepEqual(parsePoint("412 300"), [412, 300]);
    assert.deepEqual(parsePoint("[412, 300]"), [412, 300]);
    assert.deepEqual(parsePoint([412, 300]), [412, 300]);
    assert.deepEqual(parsePoint({ x: 1, y: 2 }), [1, 2]);
    assert.equal(parsePoint("nope"), null);
    assert.deepEqual(parseRegion("100,50,300,200"), [100, 50, 300, 200]);
    assert.deepEqual(parseRegion([300, 200, 100, 50]), [100, 50, 300, 200], "corners are ordered");
  });

  it("validates what each action needs and says so in a sentence", () => {
    const missing = parseComputerArgs({ action: "left_click_drag", coordinate: "10,10" });
    assert.equal(missing.ok, false);
    assert.match((missing as { error: string }).error, /start_coordinate/);
    const unknown = parseComputerArgs({ action: "teleport" });
    assert.equal(unknown.ok, false);
    assert.match((unknown as { error: string }).error, /no action "teleport"/);
    const ok = parseComputerArgs({ action: "Left-Click", coordinate: "412,300", text: "shift" });
    assert.equal(ok.ok, true);
    assert.deepEqual((ok as { request: { coordinate: unknown } }).request.coordinate, [412, 300]);
    const scroll = parseComputerArgs({ action: "scroll", scroll_direction: "down" });
    assert.equal(scroll.ok && scroll.request.scroll_amount, 3, "scroll defaults to three notches");
    const hold = parseComputerArgs({ action: "hold_key", text: "w" });
    assert.equal(hold.ok && hold.request.duration, 1);
    const wait = parseComputerArgs({ action: "wait", duration: "900" });
    assert.equal(wait.ok && wait.request.duration, 300, "waits are capped at five minutes");
    for (const action of COMPUTER_ACTIONS)
      assert.ok(
        computerToolDefinition().description.includes(action.replace(/_/g, "_")) ||
          ["cursor_position", "left_mouse_down", "left_mouse_up", "middle_click"].includes(action),
        `${action} is described`,
      );
  });
});

describe("computer tool — actions become the preview's HID plan", () => {
  const pointer = { x: 480, y: 300 };
  it("clicks land in pixels, never as fractions, with modifiers and click counts", () => {
    const parsed = parseComputerArgs({ action: "double_click", coordinate: "1,1" });
    assert.ok(parsed.ok);
    const [click] = computerToInput(parsed.request, pointer);
    assert.deepEqual(click, { type: "click", x: 1, y: 1, button: "left", clicks: 2, px: true });
    // The port reads px:true as exact pixels: (1,1) is the corner, not the far edge.
    assert.deepEqual(pointInView(1, 1, 960, 600, { exact: true }), { x: 1, y: 1 });
    assert.deepEqual(pointInView(1, 1, 960, 600), { x: 960, y: 600 }, "a script without px keeps the fraction rule");
    const shifted = parseComputerArgs({ action: "right_click", text: "ctrl+shift" });
    assert.ok(shifted.ok);
    const [rc] = computerToInput(shifted.request, pointer);
    assert.equal(rc.type === "click" && rc.x, 480, "no coordinate means the pointer");
    assert.deepEqual(rc.type === "click" ? rc.modifiers : null, ["ControlLeft", "ShiftLeft"]);
  });

  it("drags, moves, scrolls, types, presses chords and holds keys", () => {
    const drag = parseComputerArgs({ action: "left_click_drag", start_coordinate: "10,20", coordinate: "300,400" });
    assert.ok(drag.ok);
    assert.deepEqual(computerToInput(drag.request, pointer), [
      { type: "drag", fromX: 10, fromY: 20, x: 300, y: 400, button: "left", px: true },
    ]);
    const move = parseComputerArgs({ action: "mouse_move", coordinate: [5, 6] });
    assert.ok(move.ok);
    assert.deepEqual(computerToInput(move.request, pointer), [{ type: "move", x: 5, y: 6, px: true }]);
    const scroll = parseComputerArgs({
      action: "scroll",
      scroll_direction: "up",
      scroll_amount: 2,
      coordinate: "100,100",
    });
    assert.ok(scroll.ok);
    assert.deepEqual(computerToInput(scroll.request, pointer), [{ type: "scroll", dx: 0, dy: -240, x: 100, y: 100 }]);
    const type = parseComputerArgs({ action: "type", text: "hello" });
    assert.ok(type.ok);
    assert.deepEqual(computerToInput(type.request, pointer), [{ type: "type", text: "hello" }]);
    const key = parseComputerArgs({ action: "key", text: "ctrl+s", repeat: 2 });
    assert.ok(key.ok);
    assert.deepEqual(computerToInput(key.request, pointer), [{ type: "press", combo: "ctrl+s", repeat: 2 }]);
    const hold = parseComputerArgs({ action: "hold_key", text: "shift+w", duration: 2 });
    assert.ok(hold.ok);
    assert.deepEqual(computerToInput(hold.request, pointer), [{ type: "hold", keys: ["ShiftLeft", "KeyW"], ms: 2000 }]);
    // Every plan the tool emits is one the port accepts.
    for (const request of [drag, move, scroll, type, key, hold])
      assert.ok(request.ok && capActions(computerToInput(request.request, pointer)).length === 1);
  });

  it("parses chords the way computer-use models write them", () => {
    const combo = parseCombo("ctrl+shift+Return");
    assert.deepEqual(
      combo.modifiers.map((k) => k.code),
      ["ControlLeft", "ShiftLeft"],
    );
    assert.equal(combo.key?.code, "Enter");
    assert.equal(parseCombo("Page_Down").key?.code, "PageDown");
    assert.equal(parseCombo("+").key?.key, "+");
    assert.equal(parseCombo("shift").key?.code, "ShiftLeft", "a bare modifier is a key press of its own");
    assert.deepEqual(clickModifiers("alt"), ["AltLeft"]);
  });

  it("captions every action for the agent's screen", () => {
    const parsed = parseComputerArgs({ action: "left_click", coordinate: "412,300" });
    assert.ok(parsed.ok);
    assert.equal(describeComputerAction(parsed.request), "left click at 412,300");
    const key = parseComputerArgs({ action: "key", text: "i" });
    assert.ok(key.ok);
    assert.equal(describeComputerAction(key.request), "key i");
  });
});

describe("computer tool — which surface a look photographs (M4.5)", () => {
  it("reads the words a model actually writes for each surface", () => {
    for (const word of ["screen", "page", "DOM", "window", "UI", "full-page"]) {
      assert.deepEqual(parseSurface(word), { surface: "screen", note: null }, word);
    }
    for (const word of ["canvas", "webgl", "webgl2", "WebGPU", "gl", "game", "render"]) {
      assert.deepEqual(parseSurface(word), { surface: "canvas", note: null }, word);
    }
    // Nothing asked, and "you choose" asked out loud, are the same answer.
    assert.deepEqual(parseSurface(undefined), { surface: null, note: null });
    assert.deepEqual(parseSurface(""), { surface: null, note: null });
    assert.deepEqual(parseSurface("auto"), { surface: null, note: null });
  });

  it("never refuses a surface it cannot read — the studio picks and says so", () => {
    // The Codex bridge turns a valueless `--surface` into the literal string "true"; a
    // refusal there costs a turn on the engine that cannot see the image anyway.
    for (const raw of ["hologram", "true"]) {
      const parsed = parseSurface(raw);
      assert.equal(parsed.surface, null, raw);
      assert.match(parsed.note ?? "", /is not screen or canvas/, raw);
    }
    const request = parseComputerArgs({ action: "screenshot", surface: "true" });
    assert.equal(request.ok, true, "an unreadable surface is never a refusal");
    assert.ok(request.ok && request.request.surface === undefined);
    assert.match((request.ok && request.request.surfaceNote) ?? "", /surface "true" is not screen or canvas/);
  });

  it("carries the surface into the request, and into the caption of a look", () => {
    const shot = parseComputerArgs({ action: "screenshot", surface: "screen" });
    assert.ok(shot.ok);
    assert.equal(shot.request.surface, "screen");
    assert.equal(describeComputerAction(shot.request), "screenshot (screen)");
    const cam = parseComputerArgs({ action: "camera", text: "eye:here", surface: "canvas" });
    assert.ok(cam.ok);
    assert.equal(describeComputerAction(cam.request), "camera eye:here (canvas)");
    // A surface changed what a picture shows and nothing else: a click's caption is untouched.
    const click = parseComputerArgs({ action: "left_click", coordinate: "412,300", surface: "screen" });
    assert.ok(click.ok);
    assert.equal(describeComputerAction(click.request), "left click at 412,300");
  });

  it("tells both engines about it from one definition — the bridge's flag comes from the schema", () => {
    const definition = computerToolDefinition();
    assert.match(definition.parameters.properties.surface!.description ?? "", /surface=screen\|canvas/);
    assert.match(definition.description, /surface=screen\|canvas/);
    assert.ok(!definition.parameters.required?.includes("surface"), "a look without a surface still works");
  });
});

describe("the requested state — setup and its probe", () => {
  it("keeps only a setup the studio can run, and drops a path it cannot read", () => {
    const setup = normalizeSetup({
      actions: [{ type: "tap", keys: ["i"] }, { type: "nonsense" }, { type: "click", x: 480, y: 300, px: true }],
      verify: { path: "maps.activeId", equals: "macba" },
      note: "the map picker",
      settleMs: 99999,
    });
    assert.ok(setup);
    assert.equal(setup!.actions!.length, 2);
    assert.equal(setup!.settleMs, 10_000);
    assert.deepEqual(setup!.verify, { path: "maps.activeId", equals: "macba" });
    assert.equal(normalizeSetup({ verify: { path: "maps[0]" } }), null);
    assert.equal(normalizeSetup({}), null);
  });

  it("takes a gesture: the trusted knock a title screen is waiting for", () => {
    // A page that boots to a title screen needs a real click before anything else is true. A
    // setup that carries only that is a setup worth running.
    assert.deepEqual(normalizeSetup({ gesture: true }), { gesture: true });
    assert.deepEqual(normalizeSetup({ gesture: { x: 480, y: 300, keys: ["Return"] } }), {
      gesture: { x: 480, y: 300, keys: ["Return"] },
    });
    assert.deepEqual(
      normalizeSetup({ gesture: { x: "nope" } }),
      { gesture: {} },
      "a placeless knock lands at the view centre",
    );
    assert.equal(normalizeSetup({ gesture: false }), null);
    const both = normalizeSetup({ gesture: true, demo: "opening" });
    assert.equal(both!.gesture, true);
    assert.equal(both!.demo, "opening");
  });

  it("says whether the state landed, and what the board's probe reads", () => {
    const verify = { path: "maps.activeId", equals: "macba" };
    assert.equal(setupReached(verify, { maps: { activeId: "macba" } }), true);
    assert.equal(setupReached(verify, { maps: { activeId: "street" } }), false);
    assert.equal(setupReached(verify, { __missing: true }), null, "no contract is no measurement");
    assert.equal(setupReached({ path: "mode.museum", truthy: true }, { mode: { museum: 1 } }), true);
    assert.equal(setupVerifyExpr(verify), 'has("maps.activeId") && maps.activeId == "macba"');
    assert.equal(setupVerifyExpr({ path: "ready", truthy: true }), 'has("ready") && ready');
    assert.equal(setupVerifyExpr(undefined), null);
  });
});

describe("computer tool — a playtester's clock (golden-boot-glory)", () => {
  /** The computer on a fake window that records what reached the game, for one screen role. */
  async function playOn(role: "playtester" | "builder") {
    const { computerTools } = await import("../../src/main/core/computer-tools.ts");
    const { tmpDir } = await import("../helpers/tmp.ts");
    const reached: string[] = [];
    const port = {
      studioCall: async (method: string) => {
        reached.push(method);
        return true;
      },
      input: async () => {
        reached.push("input");
        return { ok: true, applied: 1, width: 960, height: 600 };
      },
      studioState: async () => ({ frame: 1 }),
      pointer: () => ({ x: 480, y: 300 }),
      viewSize: () => ({ width: 960, height: 600 }),
      consoleEntries: () => [],
    };
    const previews = {
      loadServed: async () => ({ problem: null, note: null }),
      applySetup: async () => null,
      openScreen: () => {},
      frame: async () => {},
    };
    const sessionPort = { get: async () => port, handle: () => null, loaded: null };
    const tools = computerTools(
      previews as never,
      { project: "golden-boot-glory", role } as never,
      "/nonexistent/build",
      await tmpDir("computer-clock-"),
      sessionPort as never,
    );
    await tools.onLiveTool("computer", { action: "key", text: "d" });
    await tools.onLiveTool("computer", { action: "wait", duration: 0.01 });
    return { reached, prompt: String(tools.liveTools[0]?.description) };
  }

  it("one key press ran four match minutes while the playtester looked: its game stands still between moves and runs only during them", async () => {
    const played = await playOn("playtester");
    assert.deepEqual(played.reached, ["pause", "start", "input", "pause", "start", "pause"]);
    assert.match(played.prompt, /stands still between your actions/);
  });

  it("a builder's game keeps running between actions, as before", async () => {
    const built = await playOn("builder");
    assert.deepEqual(built.reached, ["input"]);
    assert.match(built.prompt, /keeps running between actions/);
  });
});
