/**
 * The Unreal lead's run on the Builds graph: what loop/unreal/lead-graph.ts writes, read back by
 * the renderer's own `buildRunGraph` and `partRows`. Its milestones are columns, each save point a
 * round the lead kept itself (no reviewer's verdict), each sub-agent a part with its asset cards and
 * how it ended, a used delivery merged into the next save point, and the critic's advice shown on
 * the round it looked at — never as a verdict.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import {
  agentMarked,
  agentNode,
  criticAdvice,
  leadCloseOf,
  leadCloseSentence,
  leadFinished,
  leadStarted,
  milestoneColumn,
  savePointRound,
} from "../../src/harness-seed/loop/unreal/lead-graph.ts";
import {
  AgentKind,
  type AgentRecord,
  AgentState,
  AgentVerdict,
  LEAD_PART,
  type SavePoint,
} from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { type Lead, newLeadJournal } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import { VerdictSource } from "../../src/harness-seed/loop/verdict.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { buildRunGraph, GraphNodeKind, type IterationNode } from "../../src/renderer/run-graph.ts";
import { CheckedBy, partRows, StepState, statusLine, stepSentence, stepWord } from "../../src/renderer/run-steps.ts";
import { seedLeadGraph } from "../../src/main/dev/fixture-lead-graph.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, EventKind } from "../../src/shared/event-log.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { agentTitle } from "../../src/harness-seed/loop/unreal/agent-prompts.ts";
import { savedByLead, sideBySideWords } from "../../src/renderer/words.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN_ID = "run-lead";
const RUN = {
  runId: RUN_ID,
  goal: "A stormy coast",
  project: "night-spire",
  engine: "claude-code",
  budgets: {},
} as unknown as Run;
const SEAT = {
  folder: "/games/night-spire",
  chatSession: false,
  sessionId: null,
  bookmarked: null,
  engine: undefined,
  model: null,
};

/** A lead whose graph records are kept, in order, as the log would keep them. */
function recordingLead() {
  const rec = ctxRecorder({ handlers: { "events.append": () => "e" } });
  let now = Date.UTC(2026, 9, 6, 9, 0, 0);
  const lead = {
    ctx: rec.ctx as unknown as HarnessCtx,
    run: RUN,
    threadId: "t1",
    clock: { now: () => (now += 1000), sleep: async () => {} },
    game: { dir: "/games/night-spire", title: "Night Spire" },
    journal: newLeadJournal(RUN, SEAT),
  } as unknown as Lead;
  /** The run's records so far as the log hands them to the graph: its start, what the lead wrote, then `extra`. */
  const events = (extra: EventEnvelope[] = []): EventEnvelope[] => {
    const logged = rec
      .paramsOf("events.append")
      .flatMap((p) => p.batch as Array<{ event_type: string; payload: object }>);
    const started = envelope("run_started", { runId: RUN_ID, goal: RUN.goal }, 0);
    return [
      started,
      ...logged.map((e, i) => envelope(e.event_type, e.payload as Record<string, unknown>, i + 1)),
      ...extra,
    ];
  };
  return { lead, events };
}

let n = 0;
function envelope(eventType: string, payload: Record<string, unknown>, at = (n += 1)): EventEnvelope {
  return {
    id: `e${String(at).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 9, 6, 9, 0, at)).toISOString(),
    data: { type: "custom", event_type: eventType, payload },
  } as EventEnvelope;
}

/** A save point as save-point.ts records it. */
function save(milestoneId: string, round: number, label: string, summary: string): SavePoint {
  return {
    label,
    snapshotId: `snap-${label}`,
    at: Date.UTC(2026, 9, 6, 9, round),
    summary,
    thumbnails: [{ camera: "GX_Shot_Vista", path: `/runs/${RUN_ID}/unreal/${label}/vista.jpg`, tone: null }],
    milestoneId,
    round,
    auto: false,
    logErrors: [],
  };
}

/** A sub-agent as agents.ts records it. */
function agent(
  kind: AgentKind,
  n: number,
  title: string,
  state: AgentState,
  extra: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    kind,
    title,
    brief: "b",
    inputs: [],
    id: `${kind}-${n}`,
    milestoneId: "atmosphere",
    state,
    startedAt: 0,
    endedAt: null,
    worktree: null,
    error: null,
    commit: null,
    landed: [],
    refused: [],
    manifest: null,
    mark: null,
    mergedInto: null,
    credits: 0,
    ...extra,
  };
}

/** The host's records of a sub-agent's Genex job, attributed to the agent's part (the delegation's `attribution`). */
function agentJob(part: string): EventEnvelope[] {
  const call = {
    callId: "call-1",
    pluginId: "genex",
    pluginName: "Genex Tools",
    tool: "asset",
    toolName: "genex__asset",
  };
  const shared = {
    ...call,
    runId: RUN_ID,
    facetId: part,
    project: "night-spire",
    engine: "claude-code",
    role: "builder",
  };
  return [
    envelope("plugin_tool_started", {
      ...shared,
      args: "operation=texture prompt=wet concrete",
      at: "2026-10-06T09:10:00.000Z",
    }),
    envelope("plugin_tool", {
      ...shared,
      args: "",
      ok: true,
      result: '{"id":"job-1"}',
      images: 0,
      durationMs: 900,
      jobId: "job-1",
    }),
    envelope("asset_delivered", {
      project: "night-spire",
      source: "genex",
      pluginId: "genex",
      jobId: "job-1",
      files: [{ file: "assets/genex/job-1/concrete.png", bytes: 20480, kind: "image" }],
      at: "2026-10-06T09:11:00.000Z",
      runId: RUN_ID,
      facetId: part,
    }),
  ];
}

/** One lead run, written by the graph module from start to close. */
async function leadRun() {
  const { lead, events } = recordingLead();
  const { journal } = lead;
  await leadStarted(lead);
  journal.savePoints.push(save(LEAD_PART, 1, "Greybox", "the lighthouse blocked out in grey"));
  await savePointRound(lead, journal.savePoints[0]!);
  journal.milestones.push({ id: "atmosphere", title: "Atmosphere", startedAt: 0, rounds: 0 });
  await milestoneColumn(lead, journal.milestones[0]!);
  const katana = agent(AgentKind.BlenderModel, 1, "Katana", AgentState.Running);
  const goblin = agent(AgentKind.GenexCast, 1, "Goblin", AgentState.Running);
  const concrete = agent(AgentKind.Texture, 1, "Concrete", AgentState.Running);
  journal.agents.push(katana, goblin, concrete);
  for (const each of journal.agents) await agentNode(lead, each);
  Object.assign(katana, { state: AgentState.Done });
  await agentNode(lead, katana);
  katana.mark = { verdict: AgentVerdict.Used, note: null, at: 1 };
  await agentMarked(lead, katana);
  Object.assign(goblin, { state: AgentState.Failed, error: "the model stopped" });
  await agentNode(lead, goblin);
  Object.assign(concrete, { state: AgentState.Done });
  await agentNode(lead, concrete);
  journal.savePoints.push(save("atmosphere", 1, "Fog and light", "volumetric fog, one key light"));
  await savePointRound(lead, journal.savePoints[1]!);
  const advice = {
    at: Date.UTC(2026, 9, 6, 9, 30),
    shots: ["vista.png"],
    question: null,
    milestoneId: "atmosphere",
    round: 1,
    defects: [
      { defect: "The far walls are as dark as the near ones", fix: "Lift the fog's far colour" },
      { defect: "Nothing moves in the air", fix: "Add slow spray in the lighthouse beam" },
    ],
    boldMove: "Drop the camera to the rocks below the lighthouse",
    gates: ["Light: yes — one key light from above"],
  };
  journal.critiques.push(advice);
  await criticAdvice(lead, advice);
  await leadFinished(lead, { landed: true, ...leadCloseOf(journal) }, false);
  const log = events(agentJob("agent-texture-1"));
  return { graph: buildRunGraph(log), lead, log, summary: summarizeRun(log as never, RUN.project, RUN_ID) };
}

describe("the Unreal lead's run on the Builds graph", () => {
  it("draws the lead's columns and each sub-agent as a part, titled for the user", async () => {
    const { graph } = await leadRun();
    assert.ok(graph);
    assert.deepEqual(
      graph.facets.map((facet) => [facet.facetId, facet.title]),
      [
        ["lead", "Lead"],
        ["lead-atmosphere", "Lead · Atmosphere"],
        ["agent-blender_model-1", "Blender: Katana"],
        ["agent-genex_cast-1", "Meshy: Goblin"],
        ["agent-texture-1", "Texture: Concrete"],
      ],
    );
    const run = graph.nodes.find((node) => node.kind === GraphNodeKind.Run);
    assert.equal(run?.kind === GraphNodeKind.Run && run.director, true);
  });

  it("reads each save point as a step the lead kept and added itself, with no reviewer's eye", async () => {
    const { graph } = await leadRun();
    assert.ok(graph);
    const rows = partRows(graph);
    const saves = rows.filter((row) => row.facet.facetId.startsWith("lead")).flatMap((row) => row.steps);
    assert.deepEqual(
      saves.map((step) => [step.name, step.state, step.checkedBy, step.gate]),
      [
        ["Greybox", StepState.InBuild, CheckedBy.Lead, null],
        ["Fog and light", StepState.InBuild, CheckedBy.Lead, null],
      ],
    );
    const [greybox] = saves;
    assert.ok(greybox);
    assert.equal(
      stepSentence(greybox, graph.active),
      "The lead saved it after looking at its own captures; no reviewer judged it.",
    );
    const round = greybox.tries[0] as IterationNode;
    assert.equal(round.verdictSource, "lead");
    assert.match(round.verdictLabel, /^saved — the lead looked at its own captures/);
    assert.match(
      sideBySideWords({ status: round.status, satisfied: round.satisfied, source: round.verdictSource }),
      /the lead saved it/,
    );
    assert.deepEqual(
      round.shots.map((shot) => shot.camera),
      ["GX_Shot_Vista"],
    );
  });

  it("shows each sub-agent's end: used and merged, failed with why, delivered and waiting", async () => {
    const { graph } = await leadRun();
    assert.ok(graph);
    const rows = partRows(graph);
    const agents = rows.filter((row) => row.facet.facetId.startsWith("agent-"));
    assert.deepEqual(
      agents.map((row) => [row.facet.title, row.steps[0]?.state, row.steps[0] && stepWord(row.steps[0], graph.active)]),
      [
        // Typed workers write the worker records, so their nodes wear the workers' words.
        ["Blender: Katana", StepState.InBuild, "Added to your game"],
        ["Meshy: Goblin", StepState.NotDelivered, "Didn't finish"],
        ["Texture: Concrete", StepState.Delivered, "Done"],
      ],
    );
    assert.equal(agents[1]?.facet.stoppedBecause, "the model stopped");
    const merge = graph.nodes.find((node) => node.kind === GraphNodeKind.Integration);
    assert.ok(merge?.kind === GraphNodeKind.Integration);
    assert.ok(
      merge.merges.some((item) => item.facetId === "agent-blender_model-1"),
      "the used delivery merged into the save",
    );
  });

  it("a used worker's line says it was added to the game once the save point merges it, as its row does", async () => {
    const { graph, log } = await leadRun();
    const lines = toEntries(log).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Worker ? [entry.text] : [],
    );
    assert.equal(lines[0], "Blender: Katana. Added to your game.");
    assert.ok(graph);
    const katana = partRows(graph).find((row) => row.facet.facetId === "agent-blender_model-1")?.steps[0];
    assert.ok(katana);
    assert.equal(stepWord(katana, graph.active), "Added to your game");
  });

  it("says the run landed with its save points and names a sub-agent that didn't deliver, title as written", async () => {
    const { graph, summary } = await leadRun();
    assert.ok(graph);
    const line = statusLine(graph, summary, partRows(graph, summary));
    assert.deepEqual(
      [line.strong, line.rest],
      ["Live in your game · 0 min", "2 save points · Meshy: Goblin didn't deliver"],
    );
  });

  it("names a sub-agent by its kind once, whatever kind word the lead put in its title", () => {
    for (const title of [
      "Goblin and Troll (Meshy)",
      "Meshy: Goblin and Troll",
      "Meshy Goblin and Troll",
      "Goblin and Troll",
    ])
      assert.equal(agentTitle(AgentKind.GenexCast, title), "Meshy: Goblin and Troll", title);
    assert.equal(agentTitle(AgentKind.Texture, "Concrete"), "Texture: Concrete");
  });

  it("the Builds graph's dev fixture closes its finished lead run in the seed's own words", async () => {
    const appended: EventData[] = [];
    const runs = await tmpDir("studio-lead-fixture-");
    const core = {
      store: { listEvents: async () => [] },
      layout: { runs },
      append: async (events: EventData[]) => void appended.push(...events),
    };
    await seedLeadGraph(core as never, "katana", "thread-1");
    const closes = appended.flatMap((event) =>
      event.type === EventKind.Custom && event.event_type === CustomEvent.RunFinished ? [event.payload] : [],
    );
    assert.deepEqual(
      closes.map((close) => (close as { summary?: string }).summary),
      [
        leadCloseSentence(
          3,
          { label: "Katana in hand", summary: "the combo with the katana attached" },
          { delivered: 2, used: 1, failed: 1 },
        ),
      ],
    );
  });

  it("drops any kind phrase the lead led a title with, in any case, so the kind is named once", () => {
    const rows: Array<[AgentKind, string, string]> = [
      [AgentKind.BlenderModel, "Blender model: Bike", "Blender: Bike"],
      [AgentKind.BlenderModel, "blender MODEL:Bike", "Blender: Bike"],
      [AgentKind.BlenderModel, "Blender: Bike", "Blender: Bike"],
      [AgentKind.BlenderPrep, "Blender prep: Bike LODs", "Blender: Bike LODs"],
      [AgentKind.GenexCast, "meshy: Goblin", "Meshy: Goblin"],
      [AgentKind.Sound, "SOUND: Blade swings", "Sound: Blade swings"],
      [AgentKind.Texture, "Texture: Concrete", "Texture: Concrete"],
      [AgentKind.Cpp, "c++: Grapple hook", "C++: Grapple hook"],
      [AgentKind.Sound, "Meshy: Goblin", "Sound: Goblin"],
      [AgentKind.Sound, "Sound of rain", "Sound: Sound of rain"],
      [AgentKind.BlenderModel, "Blender modelling kit", "Blender: Blender modelling kit"],
    ];
    for (const [kind, title, named] of rows) assert.equal(agentTitle(kind, title), named, title);
  });

  it("puts a sub-agent's asset cards on its own part", async () => {
    const { graph } = await leadRun();
    const assets = graph?.nodes.find((node) => node.kind === GraphNodeKind.Assets);
    assert.ok(assets?.kind === GraphNodeKind.Assets);
    assert.deepEqual(
      assets.jobs.map((job) => [job.facetId, job.state, job.files]),
      [["agent-texture-1", "delivered", ["assets/genex/job-1/concrete.png"]]],
    );
  });

  it("shows the critic's advice on the round it looked at, and never as a verdict", async () => {
    const { graph } = await leadRun();
    assert.ok(graph);
    const round = graph.nodes.find(
      (node): node is IterationNode => node.kind === GraphNodeKind.Iteration && node.facetId === "lead-atmosphere",
    );
    assert.deepEqual(
      round?.advice?.defects.map((item) => item.fix),
      ["Lift the fog's far colour", "Add slow spray in the lighthouse beam"],
    );
    assert.equal(round?.advice?.boldMove, "Drop the camera to the rocks below the lighthouse");
    assert.deepEqual(graph.verdicts, [], "no verdict was recorded");
    assert.equal(round?.verdict, null);
    assert.equal(round?.status, "accepted", "the round stays the lead's save");
  });

  it("closes with the save points and the workers in its summary, and the run landed", async () => {
    const { graph, lead } = await leadRun();
    const final = graph?.nodes.find((node) => node.kind === GraphNodeKind.Final);
    assert.ok(final?.kind === GraphNodeKind.Final);
    assert.equal(final.landed, true);
    assert.match(String(final.summary), /2 save points; the last, Fog and light: volumetric fog, one key light\./);
    // Flipped: the close names them workers, as everything the person reads does.
    assert.match(String(final.summary), /2 workers delivered, 1 used in the game; 1 didn't deliver\./);
    const close = leadCloseOf(lead.journal);
    assert.deepEqual(Object.keys(close.facets as object), [
      "lead",
      "lead-atmosphere",
      "agent-blender_model-1",
      "agent-genex_cast-1",
      "agent-texture-1",
    ]);
  });

  it("draws no empty lead column for a lead that named a milestone before it saved", async () => {
    const { lead, events } = recordingLead();
    await leadStarted(lead);
    lead.journal.milestones.push({ id: "kit", title: "Kit", startedAt: 0, rounds: 0 });
    await milestoneColumn(lead, lead.journal.milestones[0]!);
    const graph = buildRunGraph(events());
    assert.deepEqual(
      graph?.facets.map((facet) => facet.title),
      ["Lead · Kit"],
    );
  });

  it("holds the renderer's word for a lead's save to the harness's verdict source", () => {
    assert.equal(savedByLead(VerdictSource.Lead), true);
    assert.equal(savedByLead(VerdictSource.Checks), false);
  });
});
