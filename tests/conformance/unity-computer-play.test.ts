import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentPlaying, forgetAgentPlay } from "../../src/plugins/unity/agent-play.ts";
import { createComputerPlay } from "../../src/plugins/unity/computer-play.ts";
import {
  FLUSH_INPUT_CODE,
  inputButtonsCode,
  mouseMotionCode,
  PlayCode,
  restoreBackgroundCode,
} from "../../src/plugins/unity/computer-play-code.ts";
import { unityKey } from "../../src/plugins/unity/computer-play-input.ts";
import { ENGINE_PLAY_VIEW, EnginePlayRefusal, EnginePlayTool } from "../../src/shared/engine-play.ts";
import { isJsonObject } from "../../src/substrate/fsx.ts";
import { backendOn, ok, withProject } from "../helpers/unity-backend.ts";
import { editor, json, openProject, pluginContext, type Seen } from "../helpers/unity-editor-stand-in.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOW = () => new Date("2026-10-14T09:00:00.000Z");

/** Pipeline transport stand-in; eval scripts are dispatched as opaque host-owned operations, not executed as source. */
async function playable() {
  const root = await openProject();
  const storage = await tmpDir("unity-computer-");
  const game = "lantern";
  const controller = new AbortController();
  const timeouts = new Map<number, AbortController>();
  const sim = { mode: "stopped", background: false, seconds: 0, frame: 0, rate: 1, settling: 0, available: true };
  const events: string[] = [];
  const scripts = new Map<string, () => unknown>();
  scripts.set(PlayCode.InputAvailable, () => ({
    available: sim.available,
    reason: "Input System is installed but inactive.",
  }));
  scripts.set(PlayCode.Background, () => sim.background);
  scripts.set(PlayCode.State, () => ({ gameSeconds: sim.seconds, frame: sim.frame, player: { name: "Player" } }));
  scripts.set(FLUSH_INPUT_CODE, () => {
    events.push("flush");
    return true;
  });
  for (const before of [false, true])
    scripts.set(restoreBackgroundCode(before), () => {
      sim.background = before;
      return true;
    });
  const respond = (request: Seen): Response => {
    if (request.url.endsWith("editor_status")) {
      if (sim.settling > 0) {
        sim.settling -= 1;
        return json(503, { busyReason: "reloading" });
      }
      return json(200, { playMode: sim.mode });
    }
    assert.ok(isJsonObject(request.body));
    const { command, parameters } = request.body;
    assert.ok(isJsonObject(parameters));
    events.push(String(command));
    switch (command) {
      case "editor_play":
        sim.mode = "playing";
        return ok();
      case "editor_stop":
        sim.mode = "stopped";
        return ok();
      case "editor_pause":
        sim.mode = sim.mode === "paused" ? "playing" : "paused";
        return ok();
      case "capture_game_view":
        return ok({ encoding: "png", base64: "cG5n", ...ENGINE_PLAY_VIEW });
      case "eval": {
        assert.equal(typeof parameters.code, "string");
        const run = scripts.get(String(parameters.code));
        assert.ok(run, "only an expected host operation reaches the editor");
        return ok(run());
      }
      default:
        throw new Error(`Unexpected command ${String(command)}`);
    }
  };
  const stand = editor(Array.from({ length: 2000 }, () => respond));
  const pipeline = {
    ...stand.deps,
    timeout: (ms: number) => {
      const c = new AbortController();
      timeouts.set(ms, c);
      return c.signal;
    },
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await stand.deps.sleep(ms, signal);
      if (sim.mode === "playing") {
        sim.seconds += (ms / 1000) * sim.rate;
        sim.frame += 1;
      }
    },
  };
  const context = pluginContext(storage, { project: game, directory: root, signal: controller.signal });
  const adapter = createComputerPlay({ pipeline, now: NOW });
  const call = (tool: EnginePlayTool, args: Record<string, unknown> = {}) => adapter(tool, args, context, storage);
  const recovered = () => createComputerPlay({ pipeline, now: NOW });
  const combo = (keys: string[], buttons: string[] = []) => {
    scripts.set(inputButtonsCode(keys, buttons, true), () => {
      events.push("down");
      return true;
    });
    scripts.set(inputButtonsCode(keys, buttons, false), () => {
      events.push("up");
      return true;
    });
  };
  return {
    call,
    recovered,
    context,
    storage,
    game,
    sim,
    events,
    scripts,
    combo,
    pipeline,
    controller,
    timeouts,
    ...stand,
  };
}

describe("Unity computer play", () => {
  it("starts the bound project's play, marks it as the agent's and stops only that play on close", async () => {
    const rig = await backendOn(
      [],
      [
        json(200, { playMode: "stopped" }),
        ok({ available: true }),
        ok(),
        json(200, { playMode: "playing" }),
        ok(false),
        ok(),
        json(200, { playMode: "playing" }),
        ok(),
        json(200, { playMode: "stopped" }),
      ],
    );
    const root = await withProject(rig.game, "6000.6.0f1");
    await rig.openIn(root);
    const context = pluginContext(rig.storage, { project: "lantern", directory: rig.game });
    const call = (tool: EnginePlayTool) => rig.backend.tool?.(tool, {}, context);
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: false });
    assert.equal(await agentPlaying(rig.storage, "lantern", Date.parse("2026-10-14T09:00:00.000Z")), true);
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: true });
    assert.equal(await agentPlaying(rig.storage, "lantern", Date.parse("2026-10-14T09:00:00.000Z")), false);
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: false });
  });

  it("waits across a reload and recovers an agent-owned play after the backend restarts", async () => {
    const rig = await playable();
    rig.scripts.set(PlayCode.InputAvailable, () => {
      rig.sim.settling = 2;
      return { available: true };
    });
    await rig.call(EnginePlayTool.Open);
    assert.ok(rig.sleeps.length >= 2);
    rig.scripts.set(PlayCode.InputAvailable, () => ({ available: true }));
    const after = rig.recovered();
    assert.deepEqual(await after(EnginePlayTool.Open, {}, rig.context, rig.storage), {
      ...ENGINE_PLAY_VIEW,
      joined: true,
    });
    await after(EnginePlayTool.Close, {}, rig.context, rig.storage);
    assert.equal(rig.sim.mode, "stopped");
    assert.equal(await agentPlaying(rig.storage, rig.game, NOW().getTime()), false);
  });

  it("fresh restarts only agent-owned play and refuses the person's play before changing anything", async () => {
    const rig = await playable();
    rig.sim.mode = "playing";
    assert.deepEqual(await rig.call(EnginePlayTool.Open, { fresh: true }), {
      refused: EnginePlayRefusal.PersonPlaying,
      message: "The person is playing in Unity. A fresh play waits until they stop.",
    });
    assert.deepEqual(rig.events, []);
    rig.sim.mode = "stopped";
    await rig.call(EnginePlayTool.Open);
    await rig.call(EnginePlayTool.Open, { fresh: true });
    assert.equal(rig.events.filter((event) => event === "editor_play").length, 2);
    assert.equal(rig.events.filter((event) => event === "editor_stop").length, 1);
  });

  it("sets pause idempotently and restores both initial pause states and runtime background on a joined play", async () => {
    for (const initial of ["playing", "paused"]) {
      const rig = await playable();
      rig.sim.mode = initial;
      await rig.call(EnginePlayTool.Open);
      const paused = initial !== "paused";
      await rig.call(EnginePlayTool.Pause, { paused });
      await rig.call(EnginePlayTool.Pause, { paused });
      assert.equal(rig.events.filter((event) => event === "editor_pause").length, 1);
      await rig.call(EnginePlayTool.Close);
      assert.equal(rig.sim.mode, initial);
      assert.equal(rig.sim.background, false);
      assert.equal(rig.events.includes("editor_stop"), false);
    }
  });

  it("forgets ownership when it observes stopped play before the person starts a new one", async () => {
    const rig = await playable();
    await rig.call(EnginePlayTool.Open);
    rig.sim.mode = "stopped";
    assert.equal(((await rig.call(EnginePlayTool.State)) as { refused: string }).refused, EnginePlayRefusal.NotPlaying);
    rig.sim.mode = "playing";
    await rig.call(EnginePlayTool.Close);
    assert.equal(rig.sim.mode, "playing");
    assert.equal(rig.events.includes("editor_stop"), false);
  });

  it("refuses missing input support before starting play and leaves the package failure actionable", async () => {
    const rig = await playable();
    rig.sim.available = false;
    await assert.rejects(rig.call(EnginePlayTool.Open), /Input System is installed but inactive/);
    assert.equal(rig.events.includes("editor_play"), false);
    assert.equal(await agentPlaying(rig.storage, rig.game, NOW().getTime()), false);
  });

  it("rejects malformed scalars and unknown/prototype key names before contacting the editor", async () => {
    const rig = await playable();
    const bad = [
      { keys: [] },
      { keys: null },
      { seconds: NaN },
      { seconds: Infinity },
      { seconds: 0 },
      { seconds: 11 },
      { dx: null },
      { dx: "1" },
      { dy: -Infinity },
      { wheel: 101 },
      { dx: 10001 },
    ];
    for (const args of bad)
      await assert.rejects(rig.call(EnginePlayTool.Input, { keys: "KeyW", seconds: 0.1, ...args }));
    for (const code of ["constructor", "toString", "__proto__", 'KeyW;System.IO.File.Delete("x")']) {
      const result = await rig.call(EnginePlayTool.Input, { keys: code, seconds: 0.1 });
      assert.equal((result as { refused: string }).refused, EnginePlayRefusal.UnknownKey);
    }
    await assert.rejects(rig.call(EnginePlayTool.Open, { fresh: "yes" }));
    await assert.rejects(rig.call(EnginePlayTool.Pause, { paused: 1 }));
    assert.equal(rig.seen.length, 0);
    assert.equal(unityKey("ArrowLeft"), "LeftArrow");
    assert.equal(unityKey("ControlLeft"), "LeftCtrl");
  });

  it("moves before a combo, holds on the game clock, and consumes a release frame before returning", async () => {
    const rig = await playable();
    rig.sim.rate = 0.5;
    rig.combo(["W", "LeftShift"], ["leftButton"]);
    rig.scripts.set(mouseMotionCode(10, -5, 2), () => {
      rig.events.push("move");
      return true;
    });
    await rig.call(EnginePlayTool.Open);
    const result = await rig.call(EnginePlayTool.Input, {
      keys: "KeyW,ShiftLeft,MouseLeft",
      seconds: 0.2,
      dx: 10,
      dy: -5,
      wheel: 2,
    });
    assert.ok(isJsonObject(result));
    assert.deepEqual(result.held, ["W", "LeftShift", "leftButton"]);
    assert.deepEqual(
      rig.events.filter((event) => ["move", "down", "up"].includes(event)),
      ["move", "down", "up"],
    );
    assert.ok(
      typeof result.gameSeconds === "number" && rig.sim.seconds > result.gameSeconds,
      "release reaches another player frame",
    );
    assert.ok(rig.sleeps.reduce((sum, ms) => sum + ms, 0) >= 400, "slow game gets the requested game time");
    assert.deepEqual(await rig.call(EnginePlayTool.Shot), { png: "cG5n", ...ENGINE_PLAY_VIEW });
    const captured = rig.seen.find(
      (request) => isJsonObject(request.body) && request.body.command === "capture_game_view",
    );
    assert.ok(captured && isJsonObject(captured.body));
    assert.deepEqual(captured.body.parameters, {
      ...ENGINE_PLAY_VIEW,
      source: "screen",
      include_inline_image: true,
    });
  });

  it("releases an attempted combo after a nested input failure without claiming success", async () => {
    const rig = await playable();
    rig.combo(["W"]);
    rig.scripts.set(inputButtonsCode(["W"], [], true), () => ({
      Success: false,
      Error: "No keyboard device is present.",
    }));
    await rig.call(EnginePlayTool.Open);
    await assert.rejects(rig.call(EnginePlayTool.Input, { keys: "KeyW", seconds: 0.1 }), /No keyboard device/);
    assert.ok(rig.events.includes("up"));
  });

  it("uses an independent release signal on cancellation and closes even with the cancelled context", async () => {
    const rig = await playable();
    rig.combo(["W"], ["leftButton"]);
    rig.scripts.set(inputButtonsCode(["W"], ["leftButton"], true), () => {
      rig.controller.abort(new Error("cancelled by the person"));
      return true;
    });
    await rig.call(EnginePlayTool.Open);
    await assert.rejects(
      rig.call(EnginePlayTool.Input, { keys: "KeyW,MouseLeft", seconds: 0.1 }),
      /cancelled by the person/,
    );
    assert.ok(rig.events.includes("up"));
    assert.deepEqual(await rig.call(EnginePlayTool.Close), { closed: true });
    assert.equal(rig.sim.mode, "stopped");
  });

  it("bounds the whole input request and releases after its deadline aborts an in-flight press", async () => {
    const rig = await playable();
    rig.combo(["W"]);
    const fetch = rig.pipeline.fetch;
    rig.pipeline.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.parameters?.code !== inputButtonsCode(["W"], [], true)) return fetch(url, init);
      assert.ok(init?.signal);
      const stalled = new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      );
      rig.timeouts.get(30_000)?.abort(new Error("input deadline"));
      return stalled;
    };
    await rig.call(EnginePlayTool.Open);
    await assert.rejects(rig.call(EnginePlayTool.Input, { keys: "KeyW", seconds: 0.1 }), /input deadline/);
    assert.ok(rig.events.includes("up"));
  });

  it("does not stop a play after the editor probe has cleared this session's ownership marker", async () => {
    const rig = await playable();
    await rig.call(EnginePlayTool.Open);
    await forgetAgentPlay(rig.storage, rig.game);
    await rig.call(EnginePlayTool.Close);
    assert.equal(rig.sim.mode, "playing");
    assert.equal(rig.events.includes("editor_stop"), false);
  });

  it("restores joined pause even when Unity applied the toggle but its reply was lost", async () => {
    const rig = await playable();
    rig.sim.mode = "playing";
    await rig.call(EnginePlayTool.Open);
    const fetch = rig.pipeline.fetch;
    let loseReply = true;
    rig.pipeline.fetch = async (url, init) => {
      const response = await fetch(url, init);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (loseReply && body.command === "editor_pause") {
        loseReply = false;
        throw new Error("reply lost");
      }
      return response;
    };
    await assert.rejects(rig.call(EnginePlayTool.Pause, { paused: true }), /unknown/);
    assert.equal(rig.sim.mode, "paused");
    await rig.call(EnginePlayTool.Close);
    assert.equal(rig.sim.mode, "playing");
  });

  it("restores joined background when Unity applies the setting but its reply is lost", async () => {
    const rig = await playable();
    rig.sim.mode = "playing";
    const fetch = rig.pipeline.fetch;
    let loseReply = true;
    rig.pipeline.fetch = async (url, init) => {
      const before = rig.sim.background;
      const response = await fetch(url, init);
      if (loseReply && !before && rig.sim.background) {
        loseReply = false;
        throw new Error("background reply lost");
      }
      return response;
    };
    await assert.rejects(rig.call(EnginePlayTool.Open), /unknown/);
    assert.equal(rig.sim.background, false, "the joined play's original setting is restored after an uncertain write");
    assert.equal(rig.sim.mode, "playing", "the person's play stays running");
  });

  it("times out a stopped game clock and still lets go of input on a player frame", async () => {
    const rig = await playable();
    rig.combo(["W"]);
    await rig.call(EnginePlayTool.Open);
    rig.sim.rate = 0;
    await assert.rejects(rig.call(EnginePlayTool.Input, { keys: "KeyW", seconds: 0.1 }), /game clock did not advance/);
    assert.ok(rig.events.includes("up"));
    assert.ok(rig.pipeline.now() <= 30_100, "the wall-clock bound does not grow with a stalled game");
  });
});
