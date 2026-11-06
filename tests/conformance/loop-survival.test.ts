/**
 * Goldens for what the Loop must keep while it is reshaped: which loop conducts a run, and one
 * canonical Unreal Loop on the one Loop as Genex sees it (the editor calls at each moment, the events
 * it writes, the graph and summary it closes with, and the journal a resume reads). Every expected
 * value is a literal, so a rename made on both sides at once still fails here; a change to any of
 * them is a named flip.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { chooseRunner } from "../../src/harness-seed/loop/run-dispatch.ts";
import { RunMode } from "../../src/harness-seed/loop/run-events.ts";
import { buildRunGraph, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { partRows, statusLine } from "../../src/renderer/run-steps.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import { gameRepo, type LoopHost, type LoopManifest, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";

/** A run's record, as the runner is chosen for it. */
const RUN = { runId: "run-survival", goal: "a level", project: "lantern", engine: "claude-code" };

/**
 * The run's engine as `engine.describe` lists it: a delegated engine that says it keeps sessions,
 * says it doesn't, or doesn't say (its kind decides), a direct engine that doesn't say, and a direct
 * engine that keeps sessions (Bonsai, OpenRouter): Genex runs its session, and seats it in place.
 */
const SESSIONS = {
  yes: { id: "claude-code", kind: "delegated", supportsSessions: true },
  no: { id: "claude-code", kind: "delegated", supportsSessions: false },
  unsaid: { id: "claude-code", kind: "delegated" },
  unsaidDirect: { id: "claude-code", kind: "direct" },
  directSessions: { id: "claude-code", kind: "direct", supportsSessions: true },
} as const;

/** Whether each engine, as `engine.describe` lists it, leads a Loop: it keeps a session of its own. */
const LEADS: Record<keyof typeof SESSIONS, boolean> = {
  yes: true,
  no: false,
  unsaid: true,
  unsaidDirect: false,
  directSessions: true,
};

/**
 * Mode × the engine's session support × classic → the runner, as wire values. Flipped (phase 5):
 * neither the mode nor classic chooses any more — the classic pipeline and the gauntlet are gone.
 * Every Loop is its lead's session, on any project, and an engine that keeps none is refused with its
 * typed reason (`needs_session`). Flipped: the folder's profile chose the Unreal runner behind its
 * internal switch; that runner is gone, so the profile is no column.
 */
const RUNNER_MATRIX: Array<[RunMode, keyof typeof SESSIONS, boolean, string]> = Object.values(RunMode).flatMap((mode) =>
  (Object.keys(SESSIONS) as Array<keyof typeof SESSIONS>).flatMap((sessions) =>
    [false, true].map((classic): [RunMode, keyof typeof SESSIONS, boolean, string] => [
      mode,
      sessions,
      classic,
      LEADS[sessions] ? "director" : "needs_session",
    ]),
  ),
);

describe("which loop conducts a run", () => {
  it("picks the runner by mode, session support and classic", () => {
    assert.deepEqual(
      [...new Set(RUNNER_MATRIX.map(([mode]) => mode))].sort(),
      Object.values(RunMode).sort(),
      "every mode is a row",
    );
    const combinations = Object.values(RunMode).length * Object.keys(SESSIONS).length * 2;
    const distinct = new Set(RUNNER_MATRIX.map((row) => row.slice(0, 3).join(" ")));
    assert.equal(distinct.size, combinations, "every combination once");
    assert.equal(RUNNER_MATRIX.length, combinations, "and no row twice");
    for (const [mode, sessions, classic, expected] of RUNNER_MATRIX) {
      const runRecord = { ...RUN, mode, classic };
      const row = `${mode} · sessions ${sessions} · classic ${classic}`;
      assert.equal(chooseRunner(runRecord as never, [SESSIONS[sessions]] as never), expected, row);
    }
  });
});

/** The editor's own polls, which the harness repeats as often as its watch looks. */
const POLLS = new Set(["tool:unreal__editor-state", "tool:unreal__editor-activity"]);
/** The host calls that mark Genex's moments beside the plugin's tools. */
// The finish check is Genex's: a claim's review and its settle are the host's calls, not a session the Loop starts.
const MOMENTS = new Set(["snapshot.create", "snapshot.restore", "engine.delegate", "finish.review", "finish.settle"]);

/** The trail of plugin tools, snapshots and turns, with the editor's polls left out. */
const momentTrail = (host: Pick<LoopHost, "trail">) =>
  host.trail().filter((call) => !POLLS.has(call) && (call.startsWith("tool:") || MOMENTS.has(call)));

/**
 * Three turns on the one Loop (save point "One"; rewind to "One"; save point "Two", then finish), on
 * the Unreal plugin's real manifest: Genex's snapshot before the Loop opens the trail; the chat's own
 * session leads (no `contractor_session` of a session of its own); its journal is a director journal
 * with the open Loop's record (`director.open`); its save points draw on the lead's row
 * (`director_worker`), with no milestone columns; and `worker_*` records appear only when a worker
 * starts. The editor calls at each moment, with the editor's polls left out: the log marked at the
 * run's start; a turn; before and after its save point; a turn that ends with unsaved work is
 * autosaved the same way, then its rewind; a turn and its save point; the close's save point.
 * Flipped: Unreal was opened for the run (`open-for-run`) before its log was marked; the lead opens
 * it itself.
 */
const ONE_LOOP_TRAIL = [
  "snapshot.create",
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
  // Flipped (Loop phase 4): the claim closes on the lead's word, with no review (finish.review, finish.settle).
  "tool:unreal__save-all",
  "tool:unreal__log-errors",
  "snapshot.create",
  "tool:unreal__hero-shots",
];

/** The fields of the open Loop's record in its journal, sorted. */
// Flipped (phase 5): no fresh-eyes reminder, so no last reader is kept.
// Flipped: the open Loop's journal carried lines for the lead's next message (`carried`); they are
// lines of the run's log, which the director's own record keeps.
// Flipped: it kept `appLost`, whether the app was the lead's to bring back when the journal was kept
// (a Resume went on from it); Genex hands the lead no app now, and holds no Resume back.
const OPEN_JOURNAL_KEYS = ["between", "crashes", "savePoints", "version"];

describe("a canonical Unreal Loop on the one Loop, as Genex sees it", () => {
  let host: LoopHost;
  before(async () => {
    const dir = await gameRepo(await copyProject(Project.UnrealGame, await tmpDir("loop-survival-")));
    const work = (name: string) => writeFile(path.join(dir, `${name}.txt`), name);
    host = loopHost({
      dir,
      facts: [{ id: "unreal-project", path: "." }],
      manifest: unrealManifest as unknown as LoopManifest,
      // Flipped (no clock): the run named 30 minutes of working time; a Loop has none. A turn that
      // ends with nothing at work pauses it, so the person's words wake each next turn.
      run: { runId: "run-one-loop", budgets: {} },
      turns: [
        async ({ host, tool }) => {
          await work("a");
          await tool("save_point", { label: "One", summary: "first" });
          await host.say("Go on.");
          return undefined;
        },
        async ({ host, tool }) => {
          await work("b");
          await tool("rewind", { label: "One" });
          await host.say("Go on.");
          return undefined;
        },
        async ({ tool }) => {
          await work("c");
          await tool("save_point", { label: "Two", summary: "second" });
          await tool("finish", { summary: "Built.", proof: "Lantern.uproject" });
          return undefined;
        },
      ],
    });
    await host.start();
  });

  /** Every record the Loop appended, as the log keeps them. */
  const logOf = () =>
    host.rec
      .paramsOf("events.append")
      .flatMap((params, i) =>
        (params.batch as Array<Record<string, unknown>>).map((data, j) => ({ id: `e${i}_${j}`, data })),
      );

  it("calls the editor at each moment in this order", () => {
    assert.deepEqual(momentTrail(host), ONE_LOOP_TRAIL);
  });

  it("writes these events, in this order of first appearance", () => {
    const types = logOf().map(({ data }) => String(data.event_type ?? data.type));
    assert.deepEqual(
      [...new Set(types)],
      [
        "run_started",
        "autopilot_started",
        "director_worker",
        "facet_iteration",
        "integration_merge",
        // Flipped: each wake was recorded as `director_continued`; what woke the lead is what it read,
        // and the person's words it read off its line are recorded heard.
        "run_steering_delivered",
        // Flipped (Loop phase 4): no finish_check, as no reviewer reads a claim the lead asked none for.
        "run_finished",
      ],
    );
  });

  it("draws this graph and closes with this summary", () => {
    const events = logOf() as never;
    const graph = buildRunGraph(events);
    const summary = summarizeRun(events, String(host.run.project), host.run.runId);
    assert.ok(graph);
    assert.deepEqual(
      graph.nodes.map((node) => node.kind),
      // Flipped (Loop phase 4): no finish_check node.
      ["run", "base", "lead", "facet", "iteration", "iteration", "iteration", "integration", "final"],
    );
    const final = graph.nodes.find((node) => node.kind === GraphNodeKind.Final);
    assert.ok(final?.kind === GraphNodeKind.Final);
    assert.equal(final.landed, true);
    assert.equal(
      final.summary,
      "3 save points; the last, Two: second. Genex kept the last work in a checkpoint at the close.",
    );
    const line = statusLine(graph, summary, partRows(graph, summary));
    // A Loop led in the project's own folder kept its work there: never promised as a build to play in Live.
    assert.deepEqual([line.strong, line.rest], ["Kept in your project", "3 save points"]);
  });

  it("keeps a director journal with the open Loop's record", () => {
    const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as {
      kind?: string;
      director: { open: Record<string, unknown> & { savePoints: Array<{ label: string }> } };
    };
    assert.equal(journal.kind, undefined, "a director journal, of no other kind");
    assert.deepEqual(Object.keys(journal.director.open).sort(), OPEN_JOURNAL_KEYS);
    assert.deepEqual(
      journal.director.open.savePoints.map((point) => point.label),
      ["One", "Autosave", "Two"],
    );
  });
});
