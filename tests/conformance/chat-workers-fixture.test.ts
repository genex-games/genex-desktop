/**
 * The `chat-workers` dev fixture: two games whose Builds graphs show workers. The fixture game's
 * chat holds an earlier Loop, then a chat message whose two workers ended (one's work added to the
 * game), so Builds opens on that chat turn. A second game holds a Loop still going: three workers,
 * the lead's background work and the finish check that has not run yet. Every worker is one line
 * in its chat, and seeding again writes nothing.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { seedBuildGraph } from "../../src/main/dev/fixture-build-graph.ts";
import { seedChatWorkers, seedChatWorkersLoop } from "../../src/main/dev/fixture-chat-workers.ts";
import { seedLeadGraph } from "../../src/main/dev/fixture-lead-graph.ts";
import { buildHistory, historyLabel, isNewestBuild, projectBuildGraph } from "../../src/renderer/build-progress.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { buildRunGraph, FinishCheckState, GraphNodeKind, type RunGraph } from "../../src/renderer/run-graph.ts";
import { partRows, statusLine, stepWord } from "../../src/renderer/run-steps.ts";
import { LeadFace, leadFace, leadNodeOf } from "../../src/renderer/run-tree.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { JobState } from "../../src/shared/jobs.ts";
import { RunState } from "../../src/shared/run-state.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "fixture-game";
const GAME_THREAD = "thread-fixture-game";
const START = Date.UTC(2026, 0, 1, 9, 0, 0);

/** A core that keeps each chat's log and its games, as the fixture writes through them. */
async function fakeCore() {
  const runs = await tmpDir("studio-chat-workers-");
  const logs = new Map<string, EventEnvelope[]>();
  const games: Array<{ name: string; dir: string; title: string }> = [];
  let seq = 0;
  const core = {
    layout: { runs },
    store: { listEvents: async (threadId: string) => logs.get(threadId) ?? [] },
    append: async (events: EventData[], threadId: string) => {
      const log = logs.get(threadId) ?? [];
      for (const data of events) {
        seq += 1;
        log.push({
          id: `e${String(seq).padStart(5, "0")}`,
          thread_id: threadId,
          session_id: null,
          turn_id: null,
          created_at: new Date(START + seq * 1000).toISOString(),
          data,
        } as EventEnvelope);
      }
      logs.set(threadId, log);
      return threadId;
    },
    games: {
      list: async () => [...games],
      scaffold: async (name: string, options: { title: string }) => {
        const game = { name, dir: path.join(runs, "games", name), title: options.title };
        games.push(game);
        return game;
      },
    },
    threadForGame: async (name: string) => `thread-${name}`,
  };
  return { core, logs, games };
}

/** The fixture's whole seed: the game's chat before the window opens, the Loop once the app has started. */
async function seeded() {
  const fake = await fakeCore();
  await seedChatWorkers(fake.core as never, GAME, GAME_THREAD);
  await seedChatWorkersLoop(fake.core as never);
  const loopGame = fake.games.find((game) => game.name === "fixture-loop");
  assert.ok(loopGame, "a second game holds the Loop");
  return { ...fake, loopThread: `thread-${loopGame.name}`, loopGame, webLoopThread: "thread-fixture-web-loop" };
}

/** Each worker row's title and the word its step reads. */
function rowWords(graph: RunGraph) {
  return partRows(graph, graph.summary ?? null).flatMap((row) =>
    row.steps.map((step) => [row.facet.title, stepWord(step, graph.active)]),
  );
}

const workerLines = (events: EventEnvelope[]): string[] =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.Action && entry.action === EntryAction.Worker ? [entry.text] : [],
  );

describe("the chat-workers dev fixture", () => {
  it("draws the chat message's workers under the lead, and Builds opens on it", async () => {
    const { logs, core } = await seeded();
    const graph = projectBuildGraph(logs.get(GAME_THREAD) ?? [], GAME_THREAD, [], core.layout.runs);
    assert.ok(graph);
    assert.ok(graph.turn, "the newest build is the chat turn");
    assert.equal(graph.tree, true);
    const asked = graph.nodes.find((node) => node.kind === GraphNodeKind.Run);
    assert.equal(
      asked?.kind === GraphNodeKind.Run && asked.goal,
      "The car drifts left on straight roads. Find out why and fix it.",
    );
    const rows = partRows(graph, null);
    assert.equal(leadFace(graph, null, rows), LeadFace.Done);
    assert.deepEqual(rowWords(graph), [
      ["Check the physics", "Done"],
      ["Center the steering", "Added to your game"],
    ]);
    assert.equal(
      graph.nodes.some((node) => node.kind === GraphNodeKind.FinishCheck),
      false,
      "a chat turn has no finish check",
    );
    const line = statusLine(graph, null, rows);
    assert.deepEqual([line.strong, line.rest], ["Live in your game", "from this chat turn"]);
  });

  it("draws the Loop's workers under the lead with its background work and the finish check waiting", async () => {
    const { logs, loopThread, loopGame } = await seeded();
    const events = logs.get(loopThread) ?? [];
    const graph = buildRunGraph(events);
    assert.ok(graph);
    assert.equal(graph.turn, undefined);
    assert.equal(graph.tree, true);
    graph.summary = summarizeRun(events, loopGame.name, graph.runId);
    assert.deepEqual(rowWords(graph), [
      ["Study the web game", "Done"],
      ["Port the car", "Added to your game"],
      ["Build the track", "Working"],
    ]);
    const rows = partRows(graph, graph.summary);
    assert.equal(leadFace(graph, graph.summary, rows), LeadFace.Waiting);
    assert.deepEqual(
      leadNodeOf(graph)?.jobs.map((job) => job.state),
      [JobState.Succeeded, JobState.Succeeded, JobState.Running],
    );
    const check = graph.nodes.find((node) => node.kind === GraphNodeKind.FinishCheck);
    assert.ok(check?.kind === GraphNodeKind.FinishCheck);
    assert.equal(check.state, FinishCheckState.NotYet);
  });

  it("a third game holds the build-graph fixture's web Loops with their builders' worker records: trees of the same rows", async () => {
    const { logs, core, webLoopThread } = await seeded();
    const events = logs.get(webLoopThread) ?? [];
    const plain = await fakeCore();
    await seedBuildGraph(plain.core as never, "fixture-web-loop", "plain");
    const before = plain.logs.get("plain") ?? [];
    for (const [runId, finishCheck] of [
      ["fixture-graph-run", false],
      ["fixture-graph-live", true],
    ] as const) {
      const graph = projectBuildGraph(events, webLoopThread, [], core.layout.runs, runId);
      const old = projectBuildGraph(before, "plain", [], core.layout.runs, runId);
      assert.ok(graph && old);
      assert.equal(graph.tree, true, `${runId}: a builder's records make the Loop a tree`);
      assert.equal(old.tree, false, `${runId}: the build-graph fixture itself is unchanged`);
      const steps = (g: RunGraph) => partRows(g, null).map((row) => [row.facet.facetId, row.steps.length]);
      assert.deepEqual(steps(graph), steps(old), `${runId}: the same rows and steps`);
      assert.equal(
        graph.nodes.some((node) => node.kind === GraphNodeKind.FinishCheck),
        finishCheck,
        `${runId}: the finish check waits only while the Loop goes`,
      );
    }
    const done = projectBuildGraph(events, webLoopThread, [], core.layout.runs, "fixture-graph-run");
    assert.ok(done);
    assert.deepEqual(rowWords(done)[0], ["Sword, ice and light", "Added to your game"]);
    assert.deepEqual(
      workerLines(events),
      [
        "Sword, ice and light. Added to your game.",
        "Frozen landscape. Added to your game.",
        "Sky and fog. Added to your game.",
        "Sword, ice and light. Added to your game.",
        "Frozen landscape…",
        "Sky and fog…",
      ],
      "a builder the lead integrated reads as added in the chat once it is over, even stopped, as on its row; one still at work reads working",
    );
  });

  it("a fourth game holds the Unreal lead's runs with their typed workers' records: trees that keep the lead's own columns", async () => {
    const { logs, core } = await seeded();
    const events = logs.get("thread-fixture-unreal-loop") ?? [];
    const plain = await fakeCore();
    await seedLeadGraph(plain.core as never, "fixture-unreal-loop", "plain");
    const before = plain.logs.get("plain") ?? [];
    for (const runId of ["fixture-lead-done", "fixture-lead-live"]) {
      const graph = projectBuildGraph(events, "thread-fixture-unreal-loop", [], core.layout.runs, runId);
      const old = projectBuildGraph(before, "plain", [], core.layout.runs, runId);
      assert.ok(graph && old);
      assert.equal(graph.tree, true, `${runId}: the typed workers' records make the run a tree`);
      assert.equal(old.tree, false, `${runId}: the lead-graph fixture itself is unchanged`);
      const steps = (g: RunGraph) => partRows(g, null).map((row) => [row.facet.facetId, row.steps.length]);
      assert.deepEqual(steps(graph), steps(old), `${runId}: the same rows, the lead's own columns among them`);
    }
    const done = projectBuildGraph(events, "thread-fixture-unreal-loop", [], core.layout.runs, "fixture-lead-done");
    assert.ok(done);
    const katana = rowWords(done).find(([title]) => title === "Blender: Katana");
    assert.deepEqual(katana, ["Blender: Katana", "Added to your game"]);
    assert.deepEqual(workerLines(events).slice(0, 3), [
      "Blender: Katana. Added to your game.",
      "Texture: Wet concrete.",
      "Meshy: Goblin: didn't finish.",
    ]);
  });

  it("the first game's history lists the Loop, then the chat turn", async () => {
    const { logs } = await seeded();
    const history = buildHistory(logs.get(GAME_THREAD) ?? [], GAME_THREAD);
    assert.deepEqual(
      history.map((entry) => [entry.chat === true, entry.state]),
      [
        [false, RunState.Finished],
        [true, RunState.Finished],
      ],
    );
    const now = new Date(START + 60_000);
    assert.deepEqual(
      history.map((entry) => historyLabel(entry, { newest: isNewestBuild(history, entry), now })),
      ["Loop from today", "This chat turn"],
    );
  });

  it("names each worker once in the chat", async () => {
    const { logs, loopThread } = await seeded();
    assert.deepEqual(workerLines(logs.get(GAME_THREAD) ?? []), [
      "Checked the physics: the front wheels sit off center.",
      "Centered the steering. Added to your game.",
    ]);
    assert.deepEqual(workerLines(logs.get(loopThread) ?? []), [
      "Studied the web game.",
      "Ported the car. Added to your game.",
      "Build the track…",
    ]);
  });

  it("seeding again writes nothing", async () => {
    const { core, logs, games } = await seeded();
    const before = new Map([...logs].map(([thread, log]) => [thread, log.length]));
    const gamesBefore = games.length;
    await seedChatWorkers(core as never, GAME, GAME_THREAD);
    await seedChatWorkersLoop(core as never);
    assert.deepEqual(new Map([...logs].map(([thread, log]) => [thread, log.length])), before);
    assert.equal(games.length, gamesBefore);
  });
});
