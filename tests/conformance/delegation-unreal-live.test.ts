/**
 * The Unreal Loop's lead: one director session in an Unreal game's own folder, building in the
 * visible Unreal editor through the game's engine connector. It gets the harness's run tools and no
 * browser window: no computer, no `look`, no capture. Its grant is honoured for the game folder, and
 * it runs in the unattended sandbox (nobody answers its tool calls; the other games are denied to
 * it). The same grant on a web game keeps its window.
 * Real core, fake delegated engine, no harness.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import type { DispatchAction } from "../../src/shared/protocol.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { ENGINES, UNREAL_ENGINE } from "../helpers/engines.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ENGINE = "claude-code";
const RUN_ID = "run_live";
/** A lead's turn, as the Unreal lead sends it (`lead-turn.ts` `TURN_MS`). */
const STEP_MS = 45 * MINUTE_MS;
const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
/** What the Unreal lead forwards: its run tools, plus the reserved names a harness must never reuse. */
const RUN_TOOLS = [
  tool("run_status"),
  tool("save_point"),
  tool("worker_start"),
  tool("worker_mark"),
  tool("rebuild_unreal"),
  tool("note"),
];
const RESERVED = [tool("computer"), tool("look"), tool("capture"), tool("resolve_root")];

/** The one host call these tests make, as the harness calls it. */
type Api = Record<"engine.delegate", (params: unknown) => Promise<unknown>>;
/** What the session did with its tools while its turn ran. */
type Played = Record<string, string>;

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A tool the turn calls: by name (with the window's arguments), or by name with its own arguments. */
type Play = string | [name: string, args: Record<string, unknown>];

/** A delegated engine that records each request and, during the turn, calls the tools `play` names. */
function liveEngine(seen: DelegateRequest[], played: Played[], play: Play[]) {
  return {
    id: ENGINE,
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      const answers: Played = {};
      for (const [index, entry] of play.entries()) {
        const [name, args] = typeof entry === "string" ? [entry, { target: "live", action: "screenshot" }] : entry;
        const key = typeof entry === "string" ? name : `${index}:${name}`;
        answers[key] = await Promise.resolve(request.onLiveTool?.(name, args)).then(
          (result) => (result === undefined ? "no handler" : text(result)),
          (error: unknown) => `refused: ${String(error)}`,
        );
      }
      played.push(answers);
      return { ok: true, engine: ENGINE, sessionId: `s${seen.length}`, turns: 1, usage: {}, summary: "" };
    },
  };
}

/** A core with an Unreal game (linked to a real `.uproject`), a web game, and a harness that answers run tools. */
async function liveWorld(play: Play[] = []) {
  const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("unreal-live-games-")) });
  lites.push(lite);
  const { core } = lite;
  const seen: DelegateRequest[] = [];
  const played: Played[] = [];
  core.engines.register(liveEngine(seen, played, play) as never);
  const unreal = await core.games.scaffold("dirt-track");
  const web = await core.games.scaffold("pond");
  const projects = await realpath(await tmpDir("unreal-live-projects-"));
  await mkdir(path.join(projects, "DirtTrack"));
  const uproject = path.join(projects, "DirtTrack", "DirtTrack.uproject");
  await writeFile(uproject, '{"FileVersion":3}\n');
  await writeEngineBinding(unreal.dir, uproject, UNREAL_ENGINE.id, ENGINES);
  // The harness that owns the run answers its run tools; the host forwards them there.
  const dispatched: DispatchAction[] = [];
  Object.defineProperty(core.host, "hasCapability", { configurable: true, value: () => true });
  core.host.dispatch = async (action: DispatchAction) => {
    dispatched.push(action);
    return `answered ${(action as { name?: string }).name}`;
  };
  const api = core.api() as unknown as Api;
  /**
   * The lead's turn: a director grant for the game's own folder, no `cwd`, no `readOnly`; with
   * `bare`, a grant with more run tools that names no chat, or the chat `bare.names`.
   */
  const step = async (
    game: { name: string; dir: string },
    bare: { tools: typeof RUN_TOOLS; names?: string } | null = null,
  ) => {
    const threadId = await core.threadForGame(game.name);
    const chat = bare ? bare.names : threadId;
    const named = chat ? { threadId: chat } : {};
    await api["engine.delegate"]({
      engine: ENGINE,
      prompt: "Build the next step.",
      project: game.name,
      threadId,
      timeoutMs: STEP_MS,
      chatTurn: { messageId: RUN_ID },
      director: {
        runId: RUN_ID,
        ...named,
        project: game.name,
        root: game.dir,
        setup: null,
        tools: [...(bare?.tools ?? RUN_TOOLS), ...RESERVED],
      },
    });
    const [request, answers] = [seen.at(-1), played.at(-1)];
    assert.ok(request && answers, "the engine was handed the step");
    return { request, played: answers };
  };
  /** The run's start on the record of its game's chat, as the harness writes it. */
  const startRun = async (game: { name: string }) => {
    const batch = [
      {
        type: "custom",
        event_type: "run_registered",
        payload: { runId: RUN_ID, project: game.name, mode: "director" },
      },
      { type: "custom", event_type: "run_started", payload: { runId: RUN_ID, project: game.name } },
    ];
    await core.append(batch as never, await core.threadForGame(game.name));
  };
  return {
    core,
    unreal,
    web,
    step,
    startRun,
    dispatched,
    threadOf: (game: { name: string }) => core.threadForGame(game.name),
  };
}

const names = (request: DelegateRequest) => (request.liveTools ?? []).map((t) => t.name);

describe("an Unreal game's lead", () => {
  it("gets the forwarded run tools and no window: no computer, no look, no capture", async () => {
    const { unreal, step } = await liveWorld();
    const { request } = await step(unreal);
    const handed = names(request);
    for (const { name } of RUN_TOOLS) assert.ok(handed.includes(name), `${name} is handed: ${handed.join(", ")}`);
    for (const { name } of RESERVED) assert.ok(!handed.includes(name), `${name} is not handed: ${handed.join(", ")}`);
    assert.equal(request.onCapture, undefined, "nothing to capture: the game shows in the Unreal editor");
  });

  it("forwards its run tools to the harness and refuses the window's, calling nothing", async () => {
    const play = ["run_status", "computer", "look", "capture"];
    const { unreal, step, dispatched } = await liveWorld(play);
    const { played } = await step(unreal);
    assert.equal(played.run_status, "answered run_status");
    for (const name of ["computer", "look", "capture"])
      assert.match(String(played[name]), /refused: .*Unknown tool/, name);
    assert.deepEqual(
      dispatched.map((action) => (action as { name?: string }).name),
      ["run_status"],
      "only the run tool reached the harness",
    );
  });

  it("while its chat plans, a writer's start and a merge wait for the plan's approval; a reader starts", async () => {
    const play: Play[] = [
      ["worker_start", { title: "Sky", task: "x", isolation: "copy" }],
      ["worker_start", { title: "In place", task: "x", isolation: "lock" }],
      ["worker_start", { title: "Mesh", task: "x", type: "blender_model" }],
      // A typed worker writes in its copy whatever isolation the call asks for: its type decides.
      ["worker_start", { title: "Mesh", task: "x", type: "blender_model", isolation: "read" }],
      ["worker_start", { title: "Sky", brief: "x", kind: "texture", isolation: "read", inputs: "x" }],
      ["worker_mark", { id: "w1", verdict: "used" }],
      ["worker_mark", { id: "w1", verdict: "rejected" }],
      ["worker_start", { title: "Look around", task: "x", isolation: "read" }],
    ];
    const { core, unreal, step, dispatched, threadOf } = await liveWorld(play);
    await core.setPermissionMode(await threadOf(unreal), "plan");
    const { played } = await step(unreal);
    for (const key of ["0:worker_start", "1:worker_start", "2:worker_start", "3:worker_start", "4:worker_start"])
      assert.match(String(played[key]), /The chat is in Plan: writers start once the person approves your plan/, key);
    assert.match(
      String(played["5:worker_mark"]),
      /The chat is in Plan: a worker's work is merged once the person approves/,
    );
    assert.deepEqual(
      dispatched.map((action) => (action as { args?: { verdict?: string; isolation?: string } }).args),
      [
        { id: "w1", verdict: "rejected" },
        { title: "Look around", task: "x", isolation: "read" },
      ],
      "only the rejection and the reader reached the harness: no snapshot, copy or merge",
    );
  });

  it("while its run's chat plans, a merge and a finish that lands wait too; the chat is the host's record, never the grant's", async () => {
    const play: Play[] = [
      ["integrate", { worker: "w1" }],
      ["finish", { summary: "done" }],
      ["finish", { summary: "done", land: "yes" }],
      ["finish", { summary: "done", land: "no" }],
    ];
    const { core, unreal, step, startRun, dispatched, threadOf } = await liveWorld(play);
    await startRun(unreal);
    await core.setPermissionMode(await threadOf(unreal), "plan");
    // The grant names no chat: the host finds the run's chat from its own records.
    const { played } = await step(unreal, { tools: [...RUN_TOOLS, tool("integrate"), tool("finish")] });
    assert.match(String(played["0:integrate"]), /a worker's work is merged once the person approves/);
    for (const key of ["1:finish", "2:finish"])
      assert.match(String(played[key]), /the build lands in the game once the person approves your plan/, key);
    assert.deepEqual(
      dispatched.map((action) => (action as { args?: { land?: string } }).args),
      [{ summary: "done", land: "no" }],
      "only the finish that lands nothing reached the harness",
    );
  });

  it("a grant naming another chat of the game never lifts the hold of the chat the run was started in, nor the other way", async () => {
    const play: Play[] = [
      ["integrate", { worker: "w1" }],
      ["finish", { summary: "done", land: "yes" }],
      ["worker_start", { title: "Sky", task: "x", isolation: "copy" }],
    ];
    const tools = [...RUN_TOOLS, tool("integrate"), tool("finish")];
    for (const planning of ["recorded", "named"] as const) {
      const { core, unreal, step, startRun, dispatched, threadOf } = await liveWorld(play);
      const started = await threadOf(unreal);
      await startRun(unreal);
      // A second chat of the same game, open, that the harness's grant names instead.
      const other = await core.store.createThread({
        title: "Another chat",
        metadata: { kind: ThreadKind.Game, project: unreal.name },
      });
      assert.notEqual(other, started);
      await core.setPermissionMode(planning === "recorded" ? started : other, "plan");
      const { played } = await step(unreal, { tools, names: other });
      assert.match(String(played["0:integrate"]), /a worker's work is merged once the person approves/, planning);
      assert.match(String(played["1:finish"]), /the build lands in the game once the person approves/, planning);
      assert.match(String(played["2:worker_start"]), /writers start once the person approves your plan/, planning);
      assert.deepEqual(dispatched, [], `${planning}: nothing reached the harness`);
    }
  });

  it("a run whose chat the host cannot find holds what waits for a plan, saying why", async () => {
    const play: Play[] = [
      ["integrate", { worker: "w1" }],
      ["worker_start", { title: "Look around", task: "x", isolation: "read" }],
    ];
    const { unreal, step, dispatched } = await liveWorld(play);
    const { played } = await step(unreal, { tools: [...RUN_TOOLS, tool("integrate")] });
    assert.match(String(played["0:integrate"]), /could not find the chat this run was started in/);
    assert.deepEqual(
      dispatched.map((action) => (action as { name?: string }).name),
      ["worker_start"],
      "a reader still starts",
    );
  });

  it("is honoured in the game's own folder and runs unattended", async () => {
    const { unreal, web, step } = await liveWorld();
    const { request } = await step(unreal);
    assert.equal(
      path.resolve(String(request.director?.root)),
      path.resolve(unreal.dir),
      "the grant is honoured for the game folder",
    );
    assert.equal(path.resolve(request.cwd), path.resolve(unreal.dir), "where the session sits");
    assert.equal(request.readOnly, undefined, "it builds: nothing makes it read-only");
    assert.equal(request.timeoutMs, STEP_MS, "a step's own clock");
    assert.equal(request.permissions, undefined, "nobody answers its tool calls");
    assert.equal(request.leadAsks, undefined, "nor does it ask as a lead");
    assert.ok((request.denyReads ?? []).includes(path.resolve(web.dir)), "the other games are denied to it");
  });

  it("leaves a web game's director its window, its look and its capture", async () => {
    const { web, step } = await liveWorld();
    const { request } = await step(web);
    const handed = names(request);
    for (const name of ["computer", "look", "run_status"]) assert.ok(handed.includes(name), `${name}: ${handed}`);
    assert.equal(typeof request.onCapture, "function");
  });
});
