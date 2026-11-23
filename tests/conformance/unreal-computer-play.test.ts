/**
 * The Unreal plugin's play tools for the studio's `computer` tool (`plugins/unreal/computer-play.ts`),
 * against a stand-in editor that plays on a game clock of its own: a session starts play with the
 * background throttle off (or joins the play already running), holds keys in Unreal's names for game
 * seconds, takes the player's view, reads the player, and ends only a play it started, giving the
 * throttle back. While the editor queue still has a build to play, the editor is the queue's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { agentPlaying } from "../../src/plugins/unreal/agent-play.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import {
  ENGINE_PLAY_VIEW,
  EnginePlayOptionalTool,
  EnginePlayRefusal,
  type EnginePlayShot,
  EnginePlayTool,
  type EnginePlayWalked,
} from "../../src/shared/engine-play.ts";
import { createComputerPlay, unrealKey } from "../../src/plugins/unreal/computer-play.ts";
import { createEditorQueue, LoopTool } from "../../src/plugins/unreal/editor-queue.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { playable, TEST, THROTTLE, written } from "../helpers/unreal-editor-stand-in.ts";

const STORAGE = "/storage";
const GAME = "valley";
const CONTEXT: PluginContext = {
  project: GAME,
  directory: "/games/valley",
  signal: new AbortController().signal,
  callId: 1,
  // The play tools never ask the host anything.
  host: (async () => {
    throw new Error("the play tools never ask the host");
  }) as never,
};

/** The play tools over a stand-in editor that plays the game at `rate` game seconds per second. */
function playTools(
  options: {
    rate?: number;
    storage?: string;
    overrides?: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
  } = {},
) {
  const storage = options.storage ?? STORAGE;
  const game = playable({ rate: options.rate ?? 1 }, options.overrides);
  const queue = createEditorQueue(game.deps);
  const play = createComputerPlay({ queueDeps: () => game.deps, queue: () => queue, game: () => GAME });
  const call = (tool: EnginePlayTool | EnginePlayOptionalTool, args: Record<string, unknown> = {}) =>
    play.handlers[tool](args, CONTEXT, storage);
  const tools = () => game.editor.calls.map(([tool]) => tool);
  const agentPlays = () => agentPlaying(storage, GAME, game.deps.now());
  return { ...game, queue, call, tools, agentPlays };
}

describe("the Unreal plugin's play tools for the computer", () => {
  // Unreal 5.9 runs no tool for the frames a settings change blocks it, and says so only in words.
  it("starts play again when the editor refused the first start for a moment", async () => {
    let refusals = 1;
    const lead = playTools({
      overrides: {
        [LoopTool.StartPlay]: () => {
          if (refusals-- > 0) throw new Error("Not run: the Unreal Editor is running a slow task.");
          lead.editor.state.pie = true;
          return true;
        },
      },
    });
    assert.deepEqual(await lead.call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: false });
    assert.equal(lead.tools().filter((tool) => tool === LoopTool.StartPlay).length, 2);
  });

  it("gives the throttle back at close though switching the light blocks the editor for a moment", async () => {
    const BLOCK_MS = 100;
    let blockedUntil = 0;
    const busy = () => lead.deps.now() < blockedUntil;
    const lead = playTools({
      overrides: {
        [LoopTool.LightPlay]: (args) => {
          blockedUntil = lead.deps.now() + BLOCK_MS;
          return { light: args.on === true };
        },
        [LoopTool.SetProperties]: (args) => {
          if (busy()) throw new Error("Not run: the Unreal Editor is running a slow task.");
          lead.editor.state.throttle = JSON.parse(String(args.values))[THROTTLE];
          return true;
        },
        [LoopTool.StartPlay]: () => {
          if (busy()) throw new Error("Not run: the Unreal Editor is running a slow task.");
          lead.editor.state.pie = true;
          return true;
        },
      },
    });
    assert.deepEqual(await lead.call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: false });
    assert.equal(
      lead.tools().filter((tool) => tool === LoopTool.StartPlay).length,
      1,
      "the start waited the block out",
    );
    assert.deepEqual(await lead.call(EnginePlayTool.Close), { closed: true });
    assert.equal(lead.editor.state.throttle, true, "the throttle went back as it was");
    assert.deepEqual(lead.tools().filter((tool) => tool === LoopTool.LightPlay).length, 2, "the light went back too");
  });

  it("gives the throttle back, and keeps no session, when play can't start", async () => {
    const { call, editor, tools } = playTools({
      overrides: {
        [LoopTool.StartPlay]: () => {
          throw new Error("The level has errors.");
        },
      },
    });
    await assert.rejects(call(EnginePlayTool.Open), /The level has errors\./);
    assert.equal(tools().filter((tool) => tool === LoopTool.StartPlay).length, 2, "one more try, no more");
    assert.deepEqual(written(editor.calls), [false, true], "the throttle went back as it was");
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: false }, "no session was kept");
  });

  it("starts play with the throttle off, and ends that play and gives the throttle back when it closes", async () => {
    const { call, editor, tools } = playTools();
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: false });
    assert.equal(editor.state.pie, true);
    assert.equal(editor.state.throttleAtPlay, false, "play ran unthrottled");
    // Looking again keeps the session: no second start, nothing owed twice.
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: true });
    assert.equal(tools().filter((tool) => tool === LoopTool.StartPlay).length, 1);
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: true });
    assert.equal(editor.state.pie, false, "the play it started ended");
    assert.deepEqual(written(editor.calls), [false, true], "the throttle went back as it was");
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: false }, "nothing left to close");
  });

  // Unreal's person-first probe reads any play it isn't told is the agent's as the person's, and
  // every later call of the session would wait for "the person" to finish playing.
  it("marks the play it started as the agent's while it runs, and a joined play of the person's never", async () => {
    const { call, editor, agentPlays } = playTools({ storage: await tmpDir("computer-play-") });
    await call(EnginePlayTool.Open);
    assert.equal(await agentPlays(), true, "the probe reads the session's play as the agent's");
    await call(EnginePlayTool.Close);
    assert.equal(await agentPlays(), false, "the mark goes with the play");
    editor.state.pie = true;
    await call(EnginePlayTool.Open);
    assert.equal(await agentPlays(), false, "the person's play stays the person's");
  });

  // UE 5.8 renders nothing to capture in the first moments of a play: the first look came back empty.
  it("warms a play it starts up for 2 game seconds before the first look", async () => {
    const { call, seconds } = playTools({ rate: 0.5 });
    await call(EnginePlayTool.Open);
    assert.ok(seconds() >= 2, "the play ran 2 game seconds before the session looks");
  });

  it("answers a tap soon after its tenth of a game second, not a quarter second later", async () => {
    const { call, deps } = playTools();
    await call(EnginePlayTool.Open);
    const before = deps.now();
    await call(EnginePlayTool.Input, { keys: "KeyI", seconds: 0.1 });
    assert.ok(deps.now() - before <= 150, `a 0.1 s tap took ${deps.now() - before} ms of the queue's clock`);
  });

  it("looks soon at a game that waits paused on its title menu, its clock standing still", async () => {
    const { call, deps } = playTools({ rate: 0 });
    const before = deps.now();
    await call(EnginePlayTool.Open);
    assert.ok(deps.now() - before <= 3 * SECOND_MS, `waited ${deps.now() - before} ms for a clock that never moves`);
  });

  // A plugin update restarts the backend mid-session: the play the old session started must not outlive it.
  it("takes over the agent's own play a restarted plugin left running, and ends it when it closes", async () => {
    const storage = await tmpDir("computer-play-");
    const before = playTools({ storage });
    await before.call(EnginePlayTool.Open);
    // The plugin's process is replaced: new tools over the same editor and storage, nothing in memory.
    const after = createComputerPlay({
      queueDeps: () => before.deps,
      queue: () => createEditorQueue(before.deps),
      game: () => GAME,
    });
    const call = (tool: EnginePlayTool) => after.handlers[tool]({}, CONTEXT, storage);
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: true });
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: true });
    assert.equal(before.editor.state.pie, false, "the agent's play ended with the session that took it over");
    assert.equal(await agentPlaying(storage, GAME, before.deps.now()), false);
  });

  it("pauses and resumes the play through the helper, and never leaves a game paused when it closes", async () => {
    const { call, editor } = playTools();
    await call(EnginePlayTool.Open);
    assert.deepEqual(await call(EnginePlayTool.Pause, { paused: true }), { paused: true });
    assert.equal(editor.state.paused, true);
    await call(EnginePlayTool.Close);
    assert.equal(editor.state.paused, false, "resumed before the session let go");
    const joined = playTools();
    joined.editor.state.pie = true;
    await joined.call(EnginePlayTool.Open);
    await joined.call(EnginePlayTool.Pause, { paused: true });
    await joined.call(EnginePlayTool.Close);
    assert.deepEqual([joined.editor.state.pie, joined.editor.state.paused], [true, false], "the person's play runs on");
  });

  // Live, 2026-10-15: two blind judges began in the guard hall, joining the lead's play mid-level.
  it("starts a fresh play for a judge: an agent's play left running is ended and started over", async () => {
    const storage = await tmpDir("computer-play-");
    const lead = playTools({ storage });
    await lead.call(EnginePlayTool.Open);
    const starts = () => lead.tools().filter((tool) => tool === LoopTool.StartPlay).length;
    // The judge's own tools, with nothing of the lead's session in memory.
    const judge = createComputerPlay({
      queueDeps: () => lead.deps,
      queue: () => createEditorQueue(lead.deps),
      game: () => GAME,
    });
    const opened = await judge.handlers[EnginePlayTool.Open]({ fresh: true }, CONTEXT, storage);
    assert.deepEqual(opened, { ...ENGINE_PLAY_VIEW, joined: false }, "a new play, not the lead's");
    assert.equal(starts(), 2, "play started over");
    assert.ok(lead.tools().includes(LoopTool.StopPlay), "the lead's play ended first");
    assert.equal(await agentPlaying(storage, GAME, lead.deps.now()), true, "the new play is the agent's");
  });

  it("never restarts the person's own play for a fresh look: it refuses and leaves it running", async () => {
    const { call, editor, tools } = playTools({ storage: await tmpDir("computer-play-") });
    editor.state.pie = true;
    const answer = (await call(EnginePlayTool.Open, { fresh: true })) as { refused: string };
    assert.equal(answer.refused, EnginePlayRefusal.PersonPlaying);
    assert.equal(editor.state.pie, true);
    assert.ok(!tools().includes(LoopTool.StopPlay) && !tools().includes(LoopTool.StartPlay));
  });

  it("joins a play the person started, and leaves it running when it closes", async () => {
    const { call, editor, tools } = playTools();
    editor.state.pie = true;
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: true });
    await call(EnginePlayTool.Close);
    assert.equal(editor.state.pie, true, "the person's play goes on");
    assert.ok(!tools().includes(LoopTool.StartPlay) && !tools().includes(LoopTool.StopPlay));
  });

  it("holds keys together in Unreal's names for game seconds, however slowly the editor plays", async () => {
    const { call, editor, seconds } = playTools({ rate: 0.25 });
    await call(EnginePlayTool.Open);
    const before = seconds();
    const held = await call(EnginePlayTool.Input, { keys: "KeyW,ShiftLeft", seconds: 1.5 });
    assert.deepEqual(
      editor.calls.filter(([tool]) => tool === LoopTool.Hold).map(([, args]) => args),
      [
        { name: "W", x: 1, y: 0, seconds: 1.5 },
        { name: "LeftShift", x: 1, y: 0, seconds: 1.5 },
      ],
    );
    assert.ok(seconds() - before >= 1.5, "the call answered once 1.5 game seconds had passed");
    assert.deepEqual((held as { held: string[] }).held, ["W", "LeftShift"]);
  });

  it("moves the player's mouse and turns its wheel for one frame through the helper, and presses its buttons as keys", async () => {
    const { call, editor } = playTools();
    await call(EnginePlayTool.Open);
    await call(EnginePlayTool.Input, { keys: "", seconds: 0.05, dx: 40, dy: -10 });
    await call(EnginePlayTool.Input, { keys: "", seconds: 0.05, wheel: -2 });
    await call(EnginePlayTool.Input, { keys: "ShiftLeft,MouseLeft", seconds: 0.1 });
    assert.deepEqual(
      editor.calls.filter(([tool]) => tool === LoopTool.Mouse).map(([, args]) => args),
      [
        { dx: 40, dy: -10, wheel: 0 },
        { dx: 0, dy: 0, wheel: -2 },
      ],
    );
    assert.deepEqual(
      editor.calls.filter(([tool]) => tool === LoopTool.Hold).map(([, args]) => args.name),
      ["LeftShift", "LeftMouseButton"],
    );
  });

  it("refuses a key Unreal has no name for before holding anything, and any input once play has ended", async () => {
    const { call, editor } = playTools();
    await call(EnginePlayTool.Open);
    const unknown = await call(EnginePlayTool.Input, { keys: "KeyW,Fn", seconds: 1 });
    assert.equal((unknown as { refused: string }).refused, EnginePlayRefusal.UnknownKey);
    assert.equal(editor.calls.filter(([tool]) => tool === LoopTool.Hold).length, 0, "not even the known key");
    editor.state.pie = false;
    for (const tool of [EnginePlayTool.Input, EnginePlayTool.Shot, EnginePlayTool.State]) {
      const answer = await call(tool, { keys: "KeyW", seconds: 1 });
      assert.equal((answer as { refused: string }).refused, EnginePlayRefusal.NotPlaying, tool);
    }
  });

  it("takes the player's view as a PNG at the view's size, its on-screen UI in it, and reads the player", async () => {
    const { call, captures } = playTools();
    await call(EnginePlayTool.Open);
    const shot = (await call(EnginePlayTool.Shot)) as EnginePlayShot;
    assert.deepEqual([shot.width, shot.height], [ENGINE_PLAY_VIEW.width, ENGINE_PLAY_VIEW.height]);
    assert.match(captures[0]?.name ?? "", /^genex-computer-\d+$/);
    assert.equal(captures[0]?.ui, true, "the HUD, a menu or an inventory, as the player sees them");
    assert.equal(shot.png, `png:/p/Saved/Genex/captures/${captures[0]?.name}.png`);
    assert.deepEqual([shot.data, shot.mime], [shot.png, "image/png"], "the picture also as data, named as a PNG");
    const state = (await call(EnginePlayTool.State)) as { pawn: string; gameSeconds: number };
    assert.equal(state.pawn, "OffroadCar_0");
  });

  it("still takes the player's view, without the UI, from a project whose older helper refuses the UI shot", async () => {
    const olderHelper = (a: Record<string, unknown>) =>
      a.ui
        ? { error: "capture_play() got an unexpected keyword argument 'ui'" }
        : { queued: true, file: `/p/Saved/Genex/captures/${a.name}.png` };
    const { call, editor, files } = playTools({ overrides: { [LoopTool.CapturePlay]: olderHelper } });
    for (const file of ["/p/Saved/Genex/captures/genex-computer-1.png"]) files.add(file);
    await call(EnginePlayTool.Open);
    const shot = (await call(EnginePlayTool.Shot)) as EnginePlayShot;
    assert.match(String(shot.png), /^png:\/p\/Saved\/Genex\/captures\/genex-computer-\d+\.png$/);
    const asked = editor.calls.filter(([tool]) => tool === LoopTool.CapturePlay).map(([, args]) => args.ui);
    assert.deepEqual(asked, [true, false]);
  });

  it("walks the player through the helper and answers once the walk has ended", async () => {
    const asked: Array<Record<string, unknown>> = [];
    let reads = 0;
    const walk = (state: string) => ({
      state,
      target: "BP_Door_2",
      way: "navmesh",
      partial: false,
      distanceM: state === "arrived" ? 0.9 : 6,
      tried: [],
      reason: "",
      gameSeconds: 4,
    });
    const { call } = playTools({
      overrides: {
        walk_to: (args) => {
          asked.push(args);
          return { walking: true, target: "BP_Door_2", way: "navmesh", waypoints: 3, distanceM: 8 };
        },
        player_state: () => ({ pawn: "BP_Hero_0", walk: walk(++reads < 3 ? "walking" : "arrived") }),
      },
    });
    await call(EnginePlayTool.Open);
    const walked = (await call(EnginePlayOptionalTool.Walk, { target: "door", seconds: 12 })) as EnginePlayWalked;
    assert.deepEqual(asked, [{ target: "door", within: 1.2, seconds: 12 }]);
    assert.equal(walked.state, "arrived");
    assert.equal(walked.distanceM, 0.9);
  });

  // A walk's own polls read player_state too: had they taken the detectors' findings, the agent
  // would only have heard of a hitch on its tenth time.
  it("takes the detectors' findings only on the computer's own read of the player, never in its polls", async () => {
    let reads = 0;
    const { call, editor } = playTools({
      overrides: {
        walk_to: () => ({ walking: true, target: "BP_Door_2", way: "direct", waypoints: 1, distanceM: 3 }),
        player_state: () => ({ pawn: "BP_Hero_0", walk: { state: ++reads < 3 ? "walking" : "arrived" } }),
      },
    });
    await call(EnginePlayTool.Open);
    await call(EnginePlayOptionalTool.Walk, { target: "door" });
    await call(EnginePlayTool.State);
    const stateReads = editor.calls.filter(([tool]) => tool === LoopTool.PlayerState).map(([, args]) => args);
    assert.deepEqual(stateReads.at(-1), { take_findings: true }, "the computer's read takes them");
    assert.ok(
      stateReads.slice(0, -1).every((args) => !args?.take_findings),
      "every poll during the walk only peeks",
    );
  });

  it("answers a walk the helper refused as failed, in the helper's words", async () => {
    const { call } = playTools({
      overrides: { walk_to: () => ({ error: "No actor is called gate. Closest names: BP_Door_2." }) },
    });
    await call(EnginePlayTool.Open);
    const walked = (await call(EnginePlayOptionalTool.Walk, { target: "gate" })) as EnginePlayWalked;
    assert.equal(walked.state, "failed");
    assert.match(walked.reason, /No actor is called gate\. Closest names: BP_Door_2\./);
  });

  it("turns the view through the helper and answers once the look has ended", async () => {
    let reads = 0;
    const { call } = playTools({
      overrides: {
        look_at: () => ({ looking: true, target: "BP_Enemy_1" }),
        player_state: () => ({
          pawn: "BP_Hero_0",
          look: {
            state: ++reads < 2 ? "looking" : "looked",
            target: "BP_Enemy_1",
            reason: "",
            offDegrees: 1,
            gameSeconds: 0.3,
          },
        }),
      },
    });
    await call(EnginePlayTool.Open);
    const looked = (await call(EnginePlayOptionalTool.Look, { target: "enemy" })) as { state: string };
    assert.equal(looked.state, "looked");
  });

  it("leaves the editor to the queue while it has a build to play, and says why", async () => {
    const { call, queue, tools } = playTools();
    queue.enqueue({ game: GAME, part: "Lantern", script: "/s", test: TEST });
    const before = tools().length;
    const answer = await call(EnginePlayTool.Open);
    assert.equal((answer as { refused: string }).refused, EnginePlayRefusal.Busy);
    assert.equal(tools().length, before, "nothing of the session reached the editor");
  });

  it("plays one player only: more players, or any player but the first, are unsupported and reach nothing", async () => {
    const { call, tools } = playTools();
    const many = await call(EnginePlayTool.Open, { players: 2 });
    assert.equal((many as { refused: string }).refused, EnginePlayRefusal.Unsupported);
    assert.deepEqual(tools(), [], "nothing reached the editor");
    assert.deepEqual(await call(EnginePlayTool.Open, { players: 1 }), { ...ENGINE_PLAY_VIEW, joined: false });
    for (const tool of [EnginePlayTool.Input, EnginePlayTool.Shot, EnginePlayTool.State]) {
      const before = tools().length;
      const answer = await call(tool, { keys: "KeyW", seconds: 1, player: 2 });
      assert.equal((answer as { refused: string }).refused, EnginePlayRefusal.Unsupported, tool);
      assert.equal(tools().length, before, `${tool}: nothing reached the editor`);
    }
  });

  it("says when the game's editor is not open", async () => {
    const { call, editor } = playTools();
    editor.state.answering = false;
    assert.equal(((await call(EnginePlayTool.Open)) as { refused: string }).refused, EnginePlayRefusal.NoEditor);
  });

  it("names web key codes as Unreal does, and nothing it has no key for", () => {
    const table: Array<[string, string | null]> = [
      ["KeyW", "W"],
      ["Digit1", "One"],
      ["Space", "SpaceBar"],
      ["ArrowUp", "Up"],
      ["ShiftLeft", "LeftShift"],
      ["MouseLeft", "LeftMouseButton"],
      ["MouseRight", "RightMouseButton"],
      ["MouseMiddle", "MiddleMouseButton"],
      ["Enter", "Enter"],
      ["F5", "F5"],
      ["F13", null],
      ["Fn", null],
      ["keyw", null],
      ["", null],
      // Unreal's own names, as an agent who read the game's code writes them.
      ["LeftMouseButton", "LeftMouseButton"],
      ["SpaceBar", "SpaceBar"],
      ["E", "E"],
      ["ee", null],
    ];
    for (const [code, name] of table) assert.equal(unrealKey(code), name, code);
  });
});
