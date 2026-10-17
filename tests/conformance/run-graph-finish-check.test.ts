/**
 * The reviewer's check of the lead's claim, as the Builds graph and the chat show it.
 *
 * Each step of a finish check is one `finish_check` record of the run (checking, then the
 * reviewer's yes, no or no answer). The graph's last node follows the newest round in the owner's
 * four looks (Checking, Not yet, Done, Stopped), its panel lists every round, and a run with a
 * record draws the node whether or not its other records made it a tree. Old logs draw as before.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedBuildGraph } from "../../src/main/dev/fixture-build-graph.ts";
import { seedLeadGraph } from "../../src/main/dev/fixture-lead-graph.ts";
import {
  buildRunGraph,
  type FinishCheckNode,
  FinishCheckState,
  type FinishRound,
  GraphNodeKind,
  type RunGraph,
} from "../../src/renderer/run-graph.ts";
import { partRows, Tone } from "../../src/renderer/run-steps.ts";
import {
  buildsLayout,
  FinishLook,
  finishCheckFace,
  finishCheckLook,
  finishPanelTone,
  reasonTone,
  roundNoteOf,
} from "../../src/renderer/run-tree.ts";
import { FINISH_CHECK_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../../src/shared/finish-check.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN = "run-f";
const TURN = "msg-t";

let seq = 0;
/** One record of the chat's log, a second after the one before. */
function logged(data: EventData): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, seq)).toISOString(),
    data,
  } as EventEnvelope;
}
const custom = (eventType: string, payload: Record<string, unknown>) =>
  logged({ type: EventKind.Custom, event_type: eventType, payload });
const inRun = (eventType: string, payload: Record<string, unknown> = {}) =>
  custom(eventType, { runId: RUN, ...payload });

/** A Loop whose lead writes worker records, started and still running. */
const loopOpened = (): EventEnvelope[] => [
  inRun(CustomEvent.RunStarted, { goal: "Port the racer and make the track feel fast", project: "game" }),
  inRun(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
];
/** One step of the run's finish check. */
const check = (round: number, step: FinishCheckStep, extra: Record<string, unknown> = {}) =>
  inRun(CustomEvent.FinishCheck, { round, step, ...extra });

const CLAIM = "A lap runs from start to finish and the timer counts on screen.";
const NO_FINISH_LINE = "The track has no finish line, so a lap never ends.";
const NO_TIMER = "The lap timer isn't on screen in any shot.";

const finishCheckOf = (graph: RunGraph | null | undefined): FinishCheckNode | undefined =>
  graph?.nodes.find((node): node is FinishCheckNode => node.kind === GraphNodeKind.FinishCheck);
const kinds = (graph: RunGraph | null) => graph?.nodes.map((node) => node.kind);

/** What a dev fixture appends, as the log would hand it back. */
async function seeded(seed: (core: never, project: string, threadId: string) => Promise<void>) {
  const appended: EventData[] = [];
  const core = {
    store: { listEvents: async () => [], writeArtifact: async () => 0 },
    layout: { runs: await tmpDir("studio-finish-check-") },
    append: async (events: EventData[]) => void appended.push(...events),
  };
  await seed(core as never, "fixture-game", "thread-1");
  return appended.map(logged);
}
const runIdOf = (event: EventEnvelope) => (event.data as { payload?: { runId?: string } }).payload?.runId;

describe("the finish check on the Builds graph", () => {
  it("a run's finish check is its last node and follows each round", () => {
    seq = 0;
    const rounds = [
      ...loopOpened(),
      check(1, FinishCheckStep.Checking, { claim: CLAIM, proof: ["lap.png"] }),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE], rejections: 1 }),
      check(2, FinishCheckStep.Checking, { claim: CLAIM }),
      check(2, FinishCheckStep.Accepted, { reasons: ["A full lap runs and the timer counts."], rejections: 0 }),
    ];
    const accepted = buildRunGraph(rounds);
    const node = finishCheckOf(accepted);
    assert.ok(node);
    assert.equal(accepted?.nodes.at(-1)?.kind, GraphNodeKind.FinishCheck, "the last node");
    assert.equal(node.state, FinishCheckState.Done);
    assert.equal(node.round, 2);
    assert.deepEqual(node.reasons, ["A full lap runs and the timer counts."]);
    assert.equal(node.rejections, 0, "a yes resets the no's in a row");
    assert.deepEqual(
      node.rounds.map((round) => [round.round, round.step, round.reasons, round.claim]),
      [
        [1, FinishCheckStep.Rejected, [NO_FINISH_LINE], CLAIM],
        [2, FinishCheckStep.Accepted, ["A full lap runs and the timer counts."], CLAIM],
      ],
      "a round's verdict keeps the claim its checking record named",
    );

    const over = buildRunGraph([...rounds, inRun(CustomEvent.RunFinished, { victory: true })]);
    assert.equal(over?.active, false);
    assert.equal(finishCheckOf(over)?.state, FinishCheckState.Done, "still drawn once the run finished");
    assert.ok(over);
    const layout = buildsLayout(over, partRows(over, null), null);
    const { final } = layout.rects;
    const box = layout.rects[GraphNodeKind.FinishCheck];
    assert.ok(final && box);
    assert.ok(box.x >= final.x + final.w, "right of the result");
  });

  it("a no reads as not yet with its reasons and round, three no's as stopped, and no answer says so", () => {
    seq = 0;
    const opened = loopOpened();
    const checking = buildRunGraph([...opened, check(1, FinishCheckStep.Checking, { claim: CLAIM })]);
    assert.equal(finishCheckOf(checking)?.state, FinishCheckState.Checking);
    assert.deepEqual(finishCheckFace(finishCheckOf(checking) as FinishCheckNode), {
      name: FINISH_CHECK_WORDS.state.checking,
      word: FINISH_CHECK_WORDS.checking,
    });

    const firstNo = [
      ...opened,
      check(1, FinishCheckStep.Checking, { claim: CLAIM }),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE, NO_TIMER], rejections: 1 }),
    ];
    const notYet = finishCheckOf(buildRunGraph(firstNo));
    assert.ok(notYet);
    assert.equal(notYet.state, FinishCheckState.NotYet);
    assert.deepEqual(notYet.reasons, [NO_FINISH_LINE, NO_TIMER]);
    assert.equal(notYet.rejections, 1);
    assert.deepEqual(finishCheckFace(notYet), {
      name: FINISH_CHECK_WORDS.state.not_yet,
      word: `2 reasons · round 1 of ${MAX_FINISH_REJECTIONS}`,
    });

    const noAnswer = [
      ...firstNo,
      check(2, FinishCheckStep.Checking, { claim: CLAIM }),
      check(2, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 1 }),
    ];
    const unanswered = finishCheckOf(buildRunGraph(noAnswer));
    assert.ok(unanswered);
    assert.equal(unanswered.state, FinishCheckState.NotYet);
    assert.equal(unanswered.why, "the reviewer's session ended");
    assert.equal(unanswered.rejections, 1, "no answer neither counts nor breaks the row");
    assert.deepEqual(finishCheckFace(unanswered), {
      name: FINISH_CHECK_WORDS.state.not_yet,
      word: FINISH_CHECK_WORDS.unanswered,
    });

    const stoppedLog = [
      ...noAnswer,
      check(3, FinishCheckStep.Checking, { claim: CLAIM }),
      check(3, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 2 }),
      check(4, FinishCheckStep.Checking, { claim: CLAIM }),
      check(4, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 3, stopped: true }),
      inRun(CustomEvent.RunFinished, { victory: false }),
    ];
    const stopped = finishCheckOf(buildRunGraph(stoppedLog));
    assert.ok(stopped);
    assert.equal(stopped.state, FinishCheckState.Stopped);
    assert.equal(stopped.rejections, MAX_FINISH_REJECTIONS);
    assert.deepEqual(finishCheckFace(stopped), {
      name: FINISH_CHECK_WORDS.state.stopped,
      word: FINISH_CHECK_WORDS.stoppedWord,
    });
    assert.equal(stopped.rounds.length, 4);

    const placeholder = finishCheckOf(buildRunGraph(opened));
    assert.ok(placeholder);
    assert.deepEqual(finishCheckFace(placeholder), {
      name: FINISH_CHECK_WORDS.state.not_yet,
      word: FINISH_CHECK_WORDS.placeholder,
    });
  });

  it("a run that ended while the reviewer was checking reads as not yet, with no answer", () => {
    seq = 0;
    const claimed = [...loopOpened(), check(1, FinishCheckStep.Checking, { claim: CLAIM })];
    const ended = buildRunGraph([...claimed, inRun(CustomEvent.RunFinished, { victory: false })]);
    const node = finishCheckOf(ended);
    assert.ok(node);
    assert.equal(node.state, FinishCheckState.NotYet, "no reviewer is at work once the run is over");
    assert.equal(node.rounds.at(-1)?.step, FinishCheckStep.Unanswered);
    assert.equal(node.rounds.at(-1)?.claim, CLAIM, "the round keeps the lead's claim");
    assert.equal(node.why, null, "the run wrote no reason");
    assert.deepEqual(finishCheckFace(node), {
      name: FINISH_CHECK_WORDS.state.not_yet,
      word: FINISH_CHECK_WORDS.unanswered,
    });
    assert.equal(
      finishCheckOf(buildRunGraph(claimed))?.state,
      FinishCheckState.Checking,
      "a running run's reviewer is still at work",
    );
  });

  it("a finished run reopened for a new ask counts its check afresh, listing the earlier rounds", () => {
    seq = 0;
    const stoppedLog = [
      ...loopOpened(),
      check(1, FinishCheckStep.Checking, { claim: CLAIM }),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 1 }),
      check(2, FinishCheckStep.Checking, { claim: CLAIM }),
      check(2, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 2 }),
      check(3, FinishCheckStep.Checking, { claim: CLAIM }),
      check(3, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 3, stopped: true }),
      inRun(CustomEvent.RunFinished, { victory: false }),
    ];
    assert.equal(finishCheckOf(buildRunGraph(stoppedLog))?.state, FinishCheckState.Stopped);
    const reopened = [
      ...stoppedLog,
      inRun(CustomEvent.RunStarted, { goal: "and add a second track", project: "game" }),
    ];
    const fresh = finishCheckOf(buildRunGraph(reopened));
    assert.ok(fresh);
    assert.equal(fresh.state, FinishCheckState.NotYet, "the earlier ask's stop is not the new one's");
    assert.equal(fresh.rejections, 0);
    assert.equal(fresh.rounds.length, 3, "the earlier rounds stay listed");
    assert.deepEqual(
      finishCheckFace(fresh),
      { name: FINISH_CHECK_WORDS.state.not_yet, word: FINISH_CHECK_WORDS.placeholder },
      "the new ask's check runs at its end",
    );
    assert.deepEqual(
      fresh.rounds.map((round) => roundNoteOf(round, fresh)),
      [null, null, { text: FINISH_CHECK_WORDS.reportInChat, quiet: true }],
      "no earlier no promises more no's to the new ask",
    );
    const oneNo = [
      ...reopened,
      check(4, FinishCheckStep.Checking, { claim: CLAIM }),
      check(4, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE], rejections: 1 }),
    ];
    const after = finishCheckOf(buildRunGraph(oneNo));
    assert.equal(after?.rejections, 1, "one no for the new ask");
    assert.equal(after?.state, FinishCheckState.NotYet);
    assert.equal(after && finishCheckFace(after).word, `1 reason · round 1 of ${MAX_FINISH_REJECTIONS}`);
  });

  it("a finished run reopened after an earlier ask's yes or unanswered round waits for the new ask's claim", () => {
    for (const [name, ending] of [
      ["a yes", check(1, FinishCheckStep.Accepted, { reasons: ["A lap runs."], rejections: 0 })],
      ["no answer", check(1, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 0 })],
    ] as const) {
      seq = 0;
      const reopened = [
        ...loopOpened(),
        check(1, FinishCheckStep.Checking, { claim: CLAIM }),
        ending,
        inRun(CustomEvent.RunFinished, { victory: true }),
        inRun(CustomEvent.RunStarted, { goal: "and add a second track", project: "game" }),
      ];
      const node = finishCheckOf(buildRunGraph(reopened));
      assert.ok(node, name);
      assert.equal(node.round, null, `${name}: no round of the new ask yet`);
      assert.deepEqual(
        finishCheckFace(node),
        { name: FINISH_CHECK_WORDS.state.not_yet, word: FINISH_CHECK_WORDS.placeholder },
        `${name}: the card and the node say the check runs at the end`,
      );
    }
  });

  it("a reopened run that finishes again without a claim of its own draws no finish check", () => {
    seq = 0;
    const log = [
      ...loopOpened(),
      check(1, FinishCheckStep.Checking, { claim: CLAIM }),
      check(1, FinishCheckStep.Accepted, { reasons: ["A lap runs."], rejections: 0 }),
      inRun(CustomEvent.RunFinished, { victory: true }),
      inRun(CustomEvent.RunStarted, { goal: "and add a second track", project: "game" }),
      inRun(CustomEvent.RunFinished, { victory: false, stoppedBecause: "the time ran out" }),
    ];
    const graph = buildRunGraph(log);
    assert.equal(finishCheckOf(graph), undefined, "nothing will run at the end of a run that is over");
    assert.ok(
      graph?.nodes.some((node) => node.kind === GraphNodeKind.Lead),
      "it stays a tree: nothing moves",
    );
  });

  it("after a no the card says what follows while the Loop runs, and that it ended once it is over", () => {
    seq = 0;
    const firstNo = [
      ...loopOpened(),
      check(1, FinishCheckStep.Checking, { claim: CLAIM }),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 1 }),
    ];
    const running = finishCheckOf(buildRunGraph(firstNo));
    assert.ok(running);
    assert.equal(running.over, false, "a running Loop still waits for its check");
    assert.deepEqual(roundNoteOf(running.rounds[0] as FinishRound, running), {
      text: FINISH_CHECK_WORDS.moreNos(1),
      quiet: true,
    });
    const paused = finishCheckOf(buildRunGraph([...firstNo, inRun(CustomEvent.RunFinished, { paused: true })]));
    assert.equal(paused?.over, false, "a paused Loop still waits for its check");
    const ended = finishCheckOf(buildRunGraph([...firstNo, inRun(CustomEvent.RunFinished, { victory: false })]));
    assert.ok(ended);
    assert.equal(ended.over, true, "a finished Loop takes no further check");
    assert.deepEqual(roundNoteOf(ended.rounds[0] as FinishRound, ended), {
      text: FINISH_CHECK_WORDS.endedAfterNo,
      quiet: true,
    });
  });

  it("a lead that claims through a finish check is a tree from its start: nothing moves at its first claim", () => {
    seq = 0;
    const started = [
      inRun(CustomEvent.RunStarted, { goal: "A katana tower", project: "game" }),
      inRun(CustomEvent.AutopilotStarted, {
        director: true,
        facets: [{ id: "lead", title: "Lead" }],
        finishCheck: true,
      }),
    ];
    const before = buildRunGraph(started);
    assert.ok(before);
    assert.equal(before.tree, true);
    const claimed = buildRunGraph([...started, check(1, FinishCheckStep.Checking, { claim: CLAIM })]);
    assert.ok(claimed);
    const placed = (graph: RunGraph) => buildsLayout(graph, partRows(graph, null), null).rects;
    const [was, now] = [placed(before), placed(claimed)];
    for (const [id, rect] of Object.entries(was)) assert.deepEqual(now[id], rect, `${id} stays where it was`);
  });

  it("a run that is no tree draws its finish check after its result", async () => {
    seq = 0;
    const lead = await seeded(seedLeadGraph);
    const done = lead.filter((event) => runIdOf(event) === "fixture-lead-done");
    const before = buildRunGraph(done, "fixture-lead-done");
    assert.equal(before?.tree, false, "the Unreal lead's run is no tree from its own records");
    assert.equal(finishCheckOf(before), undefined);
    const claimed = [
      ...done,
      custom(CustomEvent.FinishCheck, { runId: "fixture-lead-done", round: 1, step: FinishCheckStep.Checking }),
      custom(CustomEvent.FinishCheck, {
        runId: "fixture-lead-done",
        round: 1,
        step: FinishCheckStep.Accepted,
        reasons: ["The katana swings."],
      }),
    ];
    const graph = buildRunGraph(claimed, "fixture-lead-done");
    assert.ok(graph);
    assert.equal(finishCheckOf(graph)?.state, FinishCheckState.Done);
    assert.equal(graph.nodes.at(-1)?.kind, GraphNodeKind.FinishCheck);
    assert.ok(
      graph.edges.some((edge) => edge.from === GraphNodeKind.Final && edge.to === GraphNodeKind.FinishCheck),
      "after its result",
    );
    const layout = buildsLayout(graph, partRows(graph, null), null);
    const { final } = layout.rects;
    const box = layout.rects[GraphNodeKind.FinishCheck];
    assert.ok(final && box, "the layout places it");
    assert.ok(box.x >= final.x + final.w, "right of the result");
  });

  it("ignores finish records it cannot place", () => {
    seq = 0;
    /** A plain Loop that finished without a claim: no finish check. */
    const finishedRun = [
      inRun(CustomEvent.RunStarted, { goal: "A racing game", project: "game" }),
      inRun(CustomEvent.AutopilotStarted, { director: true, facets: [] }),
      inRun(CustomEvent.RunFinished, { victory: true }),
    ];
    const plain = buildRunGraph(finishedRun, RUN);
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["no runId", { round: 1, step: FinishCheckStep.Accepted }],
      ["another run's id", { runId: "run-other", round: 1, step: FinishCheckStep.Accepted }],
      ["no round", { runId: RUN, step: FinishCheckStep.Accepted }],
      ["a round that is no count", { runId: RUN, round: "1", step: FinishCheckStep.Accepted }],
      ["round zero", { runId: RUN, round: 0, step: FinishCheckStep.Accepted }],
      ["an unknown step", { runId: RUN, round: 1, step: "maybe" }],
      ["reasons that are not strings", { runId: RUN, round: 1, step: FinishCheckStep.Rejected, reasons: [{ a: 1 }] }],
      ["reasons that are no list", { runId: RUN, round: 1, step: FinishCheckStep.Rejected, reasons: "no" }],
    ];
    for (const [name, payload] of hostile) {
      const graph = buildRunGraph([...finishedRun, custom(CustomEvent.FinishCheck, payload)], RUN);
      assert.deepEqual(kinds(graph), kinds(plain), `${name}: no node`);
      assert.equal(graph?.tree, false, `${name}: the graph keeps its layout`);
    }

    const turn = buildRunGraph([
      custom(CustomEvent.WorkerStarted, { turn: TURN, workerId: "pool.w1", title: "Check", task: "Check it" }),
      custom(CustomEvent.FinishCheck, { turn: TURN, round: 1, step: FinishCheckStep.Accepted }),
    ]);
    assert.ok(turn?.turn, "a chat turn's graph");
    assert.equal(finishCheckOf(turn), undefined, "a chat turn never has a finish check");
  });

  it("an old run with no finish check draws exactly as before", async () => {
    seq = 0;
    const web = await seeded(seedBuildGraph);
    const lead = await seeded(seedLeadGraph);
    const shapes = [
      ["fixture-graph-run", web],
      ["fixture-graph-live", web],
      ["fixture-lead-done", lead],
      ["fixture-lead-live", lead],
    ] as const;
    for (const [runId, events] of shapes) {
      const graph = buildRunGraph(events, runId);
      assert.ok(graph, runId);
      assert.equal(graph.tree, false, `${runId}: no tree`);
      assert.equal(finishCheckOf(graph), undefined, `${runId}: no finish check`);
      assert.deepEqual(
        [kinds(graph), partRows(graph, null).map((row) => [row.facet.facetId, row.steps.length])],
        OLD_SHAPES[runId],
        `${runId}: the nodes and rows it always had`,
      );
    }
  });
});

const PARTS_WEB = ["run", "base", "facet", "facet"];
const LEAD_HEAD = ["run", "base", "facet", "iteration", "facet", "iteration", "facet", "facet", "facet", "facet"];
const LEAD_DONE_ROWS = [
  ["lead", 1],
  ["lead-atmosphere", 1],
  ["agent-blender_model-1", 1],
  ["agent-texture-1", 1],
  ["agent-genex_cast-1", 1],
  ["lead-combat", 1],
];
/** The build-graph and lead-graph fixtures' runs as they drew before the finish check existed: node kinds, then rows. */
const OLD_SHAPES: Record<string, unknown> = {
  "fixture-graph-run": [
    [...PARTS_WEB, ...Array(12).fill("iteration"), "facet", "iteration", "integration", "final"],
    [
      ["sword", 1],
      ["land", 5],
      ["sky", 1],
    ],
  ],
  "fixture-graph-live": [
    [...PARTS_WEB, ...Array(5).fill("iteration"), "facet", "iteration", "integration", "final"],
    [
      ["sword", 1],
      ["land", 4],
      ["sky", 1],
    ],
  ],
  "fixture-lead-done": [[...LEAD_HEAD, "iteration", "integration", "final", "assets"], LEAD_DONE_ROWS],
  "fixture-lead-live": [
    [...LEAD_HEAD, "facet", "integration", "final", "assets"],
    [...LEAD_DONE_ROWS, ["agent-sound-1", 1]],
  ],
};

describe("the finish check's look", () => {
  /** The finish check of a running Loop after these steps of its check. */
  const nodeAfter = (...steps: EventEnvelope[]): FinishCheckNode => {
    seq = 0;
    const node = finishCheckOf(buildRunGraph([...loopOpened(), ...steps]));
    assert.ok(node);
    return node;
  };
  const claimed = () => check(1, FinishCheckStep.Checking, { claim: CLAIM });
  const placeholder = () => nodeAfter();
  const rejected = () =>
    nodeAfter(claimed(), check(1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE, NO_TIMER], rejections: 1 }));
  const unanswered = () =>
    nodeAfter(claimed(), check(1, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 0 }));
  const checking = () => nodeAfter(claimed());
  const done = () => nodeAfter(claimed(), check(1, FinishCheckStep.Accepted, { reasons: ["A lap runs."] }));
  const stopped = () =>
    nodeAfter(
      claimed(),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: MAX_FINISH_REJECTIONS, stopped: true }),
    );

  it("each state has the design's edge and fill; the placeholder stays a ghost", () => {
    assert.deepEqual(finishCheckLook(placeholder()), {
      look: FinishLook.Placeholder,
      tone: Tone.Muted,
      edge: null,
      fill: null,
    });
    const notYet = { look: FinishLook.NotYet, tone: Tone.Orange, edge: "var(--orange)", fill: null };
    assert.deepEqual(finishCheckLook(rejected()), notYet, "a no: amber edge on the plain surface");
    assert.deepEqual(finishCheckLook(unanswered()), notYet, "no answer reads as not yet too");
    assert.deepEqual(finishCheckLook(checking()), {
      look: FinishLook.Checking,
      tone: Tone.Accent,
      edge: "var(--accent)",
      fill: "var(--accent-tint)",
    });
    assert.deepEqual(finishCheckLook(done()), {
      look: FinishLook.Done,
      tone: Tone.Green,
      edge: "var(--green)",
      fill: "var(--green-tint)",
    });
    assert.deepEqual(finishCheckLook(stopped()), {
      look: FinishLook.Stopped,
      tone: Tone.Red,
      edge: "var(--red)",
      fill: "var(--red-tint)",
    });
  });

  it("a reopened run's earlier rounds leave the new ask's check a ghost until it claims", () => {
    seq = 0;
    const reopened = [
      ...loopOpened(),
      claimed(),
      check(1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 1 }),
      inRun(CustomEvent.RunFinished, { victory: false }),
      inRun(CustomEvent.RunStarted, { goal: "and add a second track", project: "game" }),
    ];
    const node = finishCheckOf(buildRunGraph(reopened));
    assert.ok(node);
    assert.equal(node.rounds.length, 1, "the earlier round stays listed");
    assert.equal(finishCheckLook(node).look, FinishLook.Placeholder);
    assert.equal(finishPanelTone(node), Tone.Muted);
  });

  it("the card's status and numbers take the state's colour", () => {
    assert.equal(finishPanelTone(placeholder()), Tone.Muted);
    assert.equal(finishPanelTone(rejected()), Tone.Orange);
    assert.equal(finishPanelTone(unanswered()), Tone.Orange);
    assert.equal(finishPanelTone(checking()), Tone.Accent);
    assert.equal(finishPanelTone(done()), Tone.Green);
    assert.equal(finishPanelTone(stopped()), Tone.Red);
    const roundOf = (node: FinishCheckNode) => node.rounds.at(-1) as FinishRound;
    assert.equal(reasonTone(roundOf(rejected())), Tone.Orange, "why not yet: amber numbers");
    assert.equal(reasonTone(roundOf(stopped())), Tone.Red, "what isn't done: red numbers");
    assert.equal(reasonTone(roundOf(done())), Tone.Green, "why yes: green numbers");
    assert.equal(reasonTone(roundOf(checking())), Tone.Muted, "a round still being checked has no reasons yet");
  });
});
