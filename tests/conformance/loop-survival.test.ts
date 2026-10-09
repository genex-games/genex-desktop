/**
 * Goldens for what the Loop must keep while it is reshaped: which loop conducts a run, the exact
 * run tools each lead is offered and the kinds of its workers, and one canonical Unreal Loop as
 * Genex sees it (the editor calls at each moment, the events it writes, the graph and summary it
 * closes with, and the journal a resume reads). Every expected value is a literal, so a rename made
 * on both sides at once still fails here; a change to any of them is a named flip.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DIRECTOR_TOOLS } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { chooseRunner } from "../../src/harness-seed/loop/run-dispatch.ts";
import { RunMode } from "../../src/harness-seed/loop/run-events.ts";
import { runUnrealLead } from "../../src/harness-seed/loop/unreal/lead.ts";
import {
  AgentKind,
  LEAD_JOURNAL_KIND,
  type LeadJournal,
  LeadTool,
} from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { LEAD_TOOLS } from "../../src/harness-seed/loop/unreal/lead-tools.ts";
import { GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { partRows, statusLine } from "../../src/renderer/run-steps.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import { graphOf, type LeadHost, leadHost, RUN, type Turn } from "../helpers/unreal-lead-host.ts";

const MINUTE = 60_000;

/** One lead run on the host, on its clock. */
function run(host: LeadHost, runRecord: Record<string, unknown>) {
  return runUnrealLead(host.rec.ctx as never, {
    threadId: "t1",
    run: runRecord as never,
    resume: false,
    now: host.now,
    sleep: host.sleep,
  });
}

/** A run of `minutes` working minutes. */
const shortRun = (minutes: number) => ({ ...RUN, budgets: { ...RUN.budgets, wallClockMs: minutes * MINUTE } });

/**
 * The run's engine as `engine.describe` lists it: a delegated engine that says it keeps sessions,
 * says it doesn't, or doesn't say (its kind decides), and a direct engine that doesn't say.
 */
const SESSIONS = {
  yes: { id: "claude-code", kind: "delegated", supportsSessions: true },
  no: { id: "claude-code", kind: "delegated", supportsSessions: false },
  unsaid: { id: "claude-code", kind: "delegated" },
  unsaidDirect: { id: "claude-code", kind: "direct" },
} as const;

/** Mode × the engine's session support × classic × the game's engine → the runner, as wire values. */
const RUNNER_MATRIX: Array<[RunMode, keyof typeof SESSIONS, boolean, GameEngine, string]> = [
  ["autopilot", "yes", false, "web", "director"],
  ["autopilot", "yes", false, "unreal", "unreal"],
  ["autopilot", "yes", true, "web", "autopilot"],
  ["autopilot", "yes", true, "unreal", "unreal"],
  ["autopilot", "no", false, "web", "autopilot"],
  ["autopilot", "no", false, "unreal", "unreal"],
  ["autopilot", "no", true, "web", "autopilot"],
  ["autopilot", "no", true, "unreal", "unreal"],
  ["autopilot", "unsaid", false, "web", "director"],
  ["autopilot", "unsaid", false, "unreal", "unreal"],
  ["autopilot", "unsaid", true, "web", "autopilot"],
  ["autopilot", "unsaid", true, "unreal", "unreal"],
  ["autopilot", "unsaidDirect", false, "web", "autopilot"],
  ["autopilot", "unsaidDirect", false, "unreal", "unreal"],
  ["autopilot", "unsaidDirect", true, "web", "autopilot"],
  ["autopilot", "unsaidDirect", true, "unreal", "unreal"],
  ["director", "yes", false, "web", "gauntlet"],
  ["director", "yes", false, "unreal", "gauntlet"],
  ["director", "yes", true, "web", "gauntlet"],
  ["director", "yes", true, "unreal", "gauntlet"],
  ["director", "no", false, "web", "gauntlet"],
  ["director", "no", false, "unreal", "gauntlet"],
  ["director", "no", true, "web", "gauntlet"],
  ["director", "no", true, "unreal", "gauntlet"],
  ["director", "unsaid", false, "web", "gauntlet"],
  ["director", "unsaid", false, "unreal", "gauntlet"],
  ["director", "unsaid", true, "web", "gauntlet"],
  ["director", "unsaid", true, "unreal", "gauntlet"],
  ["director", "unsaidDirect", false, "web", "gauntlet"],
  ["director", "unsaidDirect", false, "unreal", "gauntlet"],
  ["director", "unsaidDirect", true, "web", "gauntlet"],
  ["director", "unsaidDirect", true, "unreal", "gauntlet"],
];

describe("which loop conducts a run", () => {
  it("picks the runner by mode, session support, classic and the game's engine", () => {
    assert.deepEqual(
      [...new Set(RUNNER_MATRIX.map(([mode]) => mode))].sort(),
      Object.values(RunMode).sort(),
      "every mode is a row",
    );
    assert.deepEqual(
      [...new Set(RUNNER_MATRIX.map(([, , , engine]) => engine))].sort(),
      Object.values(GameEngine).sort(),
      "every game engine is a row",
    );
    const combinations =
      Object.values(RunMode).length * Object.keys(SESSIONS).length * 2 * Object.values(GameEngine).length;
    const distinct = new Set(RUNNER_MATRIX.map((row) => row.slice(0, 4).join(" ")));
    assert.equal(distinct.size, combinations, "every combination once");
    assert.equal(RUNNER_MATRIX.length, combinations, "and no row twice");
    for (const [mode, sessions, classic, gameEngine, expected] of RUNNER_MATRIX) {
      const runRecord = { ...RUN, mode, classic };
      const row = `${mode} · sessions ${sessions} · classic ${classic} · ${gameEngine}`;
      assert.equal(chooseRunner(runRecord as never, [SESSIONS[sessions]] as never, gameEngine), expected, row);
    }
  });
});

describe("the run tools each lead is offered", () => {
  it("the director offers exactly these tools", () => {
    assert.deepEqual(DIRECTOR_TOOLS.map((tool) => tool.name).sort(), [
      "finish",
      "goal_update",
      "integrate",
      "judge",
      "note",
      "plan",
      "playtest",
      "run_status",
      "show",
      "worker_mark",
      "worker_start",
      "worker_status",
      "worker_steer",
      "worker_stop",
      "worker_wait",
    ]);
  });

  it("the Unreal lead offers exactly these tools, and its workers come in these kinds", () => {
    assert.deepEqual(LEAD_TOOLS.map((tool) => tool.name).sort(), [
      "critic",
      "milestone",
      "note",
      "rebuild_unreal",
      "rewind",
      "run_status",
      "save_point",
      "worker_mark",
      "worker_start",
      "worker_status",
      "worker_steer",
      "worker_stop",
      "worker_wait",
    ]);
    assert.deepEqual(Object.values(AgentKind), [
      "blender_model",
      "blender_prep",
      "genex_cast",
      "sound",
      "texture",
      "cpp",
    ]);
  });
});

/** Turn one builds and saves 'One'; turn two builds and asks to rewind to it; turn three builds and saves 'Two'. */
const CANONICAL_TURNS: Turn[] = [
  async ({ tool, host }) => {
    host.work("a");
    await tool(LeadTool.SavePoint, { label: "One", summary: "first" });
    return undefined;
  },
  async ({ tool, host }) => {
    host.work("b");
    await tool(LeadTool.Rewind, { label: "One" });
    return undefined;
  },
  async ({ tool, host }) => {
    host.work("c");
    await tool(LeadTool.SavePoint, { label: "Two", summary: "second" });
    return undefined;
  },
];

/** The editor's own polls, which the harness repeats as often as its watch looks. */
const POLLS = new Set(["tool:unreal__editor-state", "tool:unreal__editor-activity"]);
/** The host calls that mark Genex's moments beside the plugin's tools. */
const MOMENTS = new Set(["snapshot.create", "snapshot.restore", "engine.delegate"]);

/** Each moment's handlers of the Unreal plugin, renamed: the runner must find them by its manifest. */
const RENAMED: Record<string, string> = {
  "open-for-run": "wake-up",
  "save-all": "keep-everything",
  "log-errors": "read-log",
  "hero-shots": "stills",
  "end-editor": "close-up",
  "reopen-editor": "open-again",
  "editor-state": "pulse",
  "editor-activity": "who-is-there",
};

/** A canonical host whose Unreal manifest names every moment's handler (and the lock's probe) otherwise. */
function renamedHost() {
  const manifest = structuredClone(unrealManifest) as unknown as {
    id: string;
    tools: Array<{ name: string }>;
    hooks: Array<{ tool: string }>;
    locks: Array<{ personFirst?: string }>;
  };
  const named = (tool: string) => RENAMED[tool] ?? tool;
  for (const tool of manifest.tools) tool.name = named(tool.name);
  for (const hook of manifest.hooks ?? []) hook.tool = named(hook.tool);
  for (const lock of manifest.locks ?? []) if (lock.personFirst) lock.personFirst = named(lock.personFirst);
  const roles = Object.fromEntries(Object.entries(RENAMED).map(([role, name]) => [name, role]));
  const host = leadHost({ turns: [...CANONICAL_TURNS], manifest: manifest as never, roles });
  return { host, names: RENAMED };
}

/** The trail of plugin tools, snapshots and turns, with the editor's polls left out. */
const momentTrail = (host: LeadHost) =>
  host.trail().filter((call) => !POLLS.has(call) && (call.startsWith("tool:") || MOMENTS.has(call)));

/**
 * The editor calls at each moment, with the editor's polls left out. The start (C++, then Unreal
 * opened for the run and its log marked); a turn; before and after its save point; a turn that
 * ends with unsaved work is autosaved the same way, then its rewind; a turn and its save point;
 * the end leaves the editor open.
 */
const MOMENT_TRAIL = [
  "tool:unreal__cpp-status",
  "tool:unreal__open-for-run",
  "tool:unreal__log-errors",
  "engine.delegate",
  "tool:unreal__save-all",
  "tool:unreal__log-errors",
  "snapshot.create",
  "tool:unreal__hero-shots",
  "engine.delegate",
  "tool:unreal__save-all",
  "tool:unreal__log-errors",
  "snapshot.create",
  "tool:unreal__hero-shots",
  "tool:unreal__save-all",
  "tool:unreal__end-editor",
  "snapshot.restore",
  "tool:unreal__reopen-editor",
  "engine.delegate",
  "tool:unreal__save-all",
  "tool:unreal__log-errors",
  "snapshot.create",
  "tool:unreal__hero-shots",
];

/** The fields of the lead's journal, sorted. */
const JOURNAL_KEYS = [
  "agents",
  "between",
  "briefed",
  "builtStamp",
  "cost",
  "crashes",
  "credits",
  "critiques",
  "digest",
  "ends",
  "handovers",
  "jobsCursor",
  "kind",
  "logOffset",
  "milestones",
  "phase",
  "run",
  "savePoints",
  "savedAt",
  "seat",
  "sessionId",
  "turns",
  "workedMs",
];

describe("a canonical Unreal Loop, as Genex sees it", () => {
  let host: LeadHost;
  before(async () => {
    host = leadHost({ turns: [...CANONICAL_TURNS] });
    await run(host, shortRun(30));
  });

  it("calls the editor at each moment in this order", () => {
    assert.deepEqual(momentTrail(host), MOMENT_TRAIL);
  });

  it("every plugin call the Unreal lead's runner makes is its own step", () => {
    const invokes = host.rec.calls.filter((c) => c.method === "plugins.invoke");
    assert.ok(invokes.length > 0);
    for (const call of invokes) assert.equal(call.params.step, true, String(call.params.name));
  });

  it("the runner's checkpoints and restores wait in a planning chat; its reads do not", () => {
    // Genex holds a checkpoint and a game folder's restore while the run's chat plans: both name the run's chat.
    const asked = (method: string) => host.rec.paramsOf(method);
    for (const method of ["checkpoint.take", "snapshot.restore"]) {
      assert.ok(asked(method).length > 0, method);
      for (const params of asked(method)) assert.deepEqual([params.threadId, params.runId], ["t1", RUN.runId], method);
    }
    // No editor write is the runner's own call any more; its read of the C++ status is a plain step.
    const invokes = host.rec.paramsOf("plugins.invoke");
    assert.deepEqual([...new Set(invokes.map((p) => p.name))], ["unreal__cpp-status"]);
    assert.ok(invokes.every((p) => p.checkpoint === undefined));
  });

  it("runs each moment's steps from the plugin's manifest, whatever they are named", async () => {
    const renamed = renamedHost();
    await run(renamed.host, shortRun(30));
    const polls = new Set([
      `tool:unreal__${renamed.names["editor-state"]}`,
      `tool:unreal__${renamed.names["editor-activity"]}`,
    ]);
    const trail = renamed.host
      .trail()
      .filter((call) => !polls.has(call) && (call.startsWith("tool:") || MOMENTS.has(call)));
    const rename = (call: string) => {
      const tool = call.startsWith("tool:unreal__") ? call.slice("tool:unreal__".length) : null;
      return tool && renamed.names[tool] ? `tool:unreal__${renamed.names[tool]}` : call;
    };
    assert.deepEqual(trail, MOMENT_TRAIL.map(rename));
  });

  it("polls the editor's state during and between turns", () => {
    assert.ok(host.duringTurn.includes("unreal__editor-state"), "the health look runs while a turn is under way");
    const all = host.trail().filter((call) => call === "tool:unreal__editor-state").length;
    const during = host.duringTurn.filter((call) => call === "unreal__editor-state").length;
    assert.ok(all > during, "and between turns");
  });

  it("writes these events, in this order of first appearance", () => {
    const types = host.events().map((event) => (event.data as { event_type: string }).event_type);
    assert.deepEqual(
      [...new Set(types)],
      [
        "run_started",
        "autopilot_started",
        "facet_iteration",
        "integration_merge",
        "contractor_session",
        "run_finished",
      ],
    );
  });

  it("draws this graph and closes with this summary", () => {
    const { graph, summary } = graphOf(host);
    assert.ok(graph);
    assert.deepEqual(
      graph.nodes.map((node) => node.kind),
      ["run", "base", "facet", "iteration", "iteration", "iteration", "integration", "final"],
    );
    const final = graph.nodes.find((node) => node.kind === GraphNodeKind.Final);
    assert.ok(final?.kind === GraphNodeKind.Final);
    assert.equal(final.landed, true);
    assert.equal(final.summary, "3 save points; the last, Two: second.");
    assert.equal(summary.landed, true);
    const line = statusLine(graph, summary, partRows(graph, summary));
    assert.deepEqual([line.strong, line.rest], ["Live in your game · 0 min", "3 save points"]);
  });

  it("keeps a journal a resume reads", () => {
    const journal = host.artifacts.get(`autopilot_${RUN.runId}`) as LeadJournal;
    assert.equal(journal.kind, LEAD_JOURNAL_KIND);
    assert.equal(journal.kind, "unreal-lead");
    assert.deepEqual(Object.keys(journal).sort(), JOURNAL_KEYS);
    assert.deepEqual(
      journal.savePoints.map((point) => point.label),
      ["One", "Autosave", "Two"],
    );
  });
});
