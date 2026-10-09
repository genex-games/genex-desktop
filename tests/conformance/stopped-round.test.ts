/**
 * A round the lead stopped (M1.4).
 *
 * The harness stops a builder mid-edit — to fix the starting point, to wrap the run up — and
 * commits what it had written instead of judging it. On screen that round is neither kept nor
 * undone: it is grey, it says who stopped it, and it never claims the work was thrown away.
 * One run showed the owner four red "stopped by you" rounds they had had no part in.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { stopSignal, stopsThisRound } from "../../src/harness-seed/loop/facet-loop.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { buildRunGraph, type IterationNode } from "../../src/renderer/run-graph.ts";
import { partRows, STATE_TONE, stepSentence } from "../../src/renderer/run-steps.ts";
import { sideBySideWords, stoppedWords, verdictWords, wasStopped } from "../../src/renderer/words.ts";
import { TRY_GLYPH, TRY_WORD } from "../../src/renderer/round-status.ts";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

let counter = 0;
function event(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  counter += 1;
  return {
    id: `e${String(counter).padStart(4, "0")}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: `2026-09-08T02:${String(counter % 60).padStart(2, "0")}:00.000Z`,
    data: { type: "custom", event_type: eventType, payload: { runId: "run_stop", ...payload } },
  };
}

/** Round one kept, round two stopped by the lead — exactly what `facet-loop.ts` writes. */
function loopRun(): EventEnvelope[] {
  counter = 0;
  return [
    event("run_started", { project: "plaza", goal: "a red plaza" }),
    event("autopilot_started", { facets: [{ id: "plaza", title: "Plaza", budgetShare: 1 }], maxParallel: 1 }),
    event("facet_iteration", {
      facetId: "plaza",
      facetTitle: "Plaza",
      iteration: 1,
      winner: "challenger",
      satisfied: false,
      verdictSource: "checks",
      reason: "checks accepted",
      biggest_gap: "the stone reads flat",
      defects: [],
      unmeasured: [],
      scoreboard: { total: 4, passing: 3, unmeasured: 0, flips: ["lit"], regressions: [], results: [] },
      shots: [{ camera: "default", path: "/runs/run_stop/plaza/1/default.jpg", bytes: 10 }],
      flags: [],
      diffs: {},
    }),
    event("facet_stopped", {
      facetId: "plaza",
      iteration: 2,
      by: "director",
      reason: "stopped by the director: fixing the starting point",
      attemptBranch: "refs/studio/runs/run_x/attempts/plaza/2-stopped",
    }),
    event("facet_iteration", {
      facetId: "plaza",
      facetTitle: "Plaza",
      iteration: 2,
      winner: null,
      satisfied: false,
      verdictSource: "stopped",
      reason: "stopped by the director: fixing the starting point",
      biggest_gap: "the stone reads flat",
      defects: [],
      unmeasured: [],
      scoreboard: null,
      attemptBranch: "refs/studio/runs/run_x/attempts/plaza/2-stopped",
      shots: [],
      flags: [],
      diffs: {},
    }),
    event("run_finished", {
      victory: false,
      stoppedBecause: "the director finished the run",
      facets: {
        plaza: {
          stoppedBecause:
            "stopped by the director: fixing the starting point — its work so far is kept on refs/studio/runs/run_x/attempts/plaza/2-stopped",
          iterations: 1,
          satisfied: false,
        },
      },
    }),
  ];
}

const roundsOf = (graph: ReturnType<typeof buildRunGraph>): IterationNode[] =>
  (graph?.nodes ?? []).filter((node): node is IterationNode => node.kind === "iteration");

describe("a stopped round in the run graph", () => {
  it("is its own status — not kept, not undone, and not counted as a loss", () => {
    const graph = buildRunGraph(loopRun());
    assert.ok(graph);
    const rounds = roundsOf(graph);
    assert.deepEqual(
      rounds.map((round) => round.status),
      ["accepted", "stopped"],
    );
    const stopped = rounds[1]!;
    assert.equal(stopped.winner, null);
    assert.equal(stopped.scoreboard, null);
    assert.match(stopped.verdictLabel, /^stopped — /);
    assert.doesNotMatch(stopped.verdictLabel, /undone/);

    // The part's tallies: one kept round, nothing rolled back, and the stopped round is not
    // one of the rounds the judges decided.
    const facet = graph.facets[0]!;
    assert.equal(facet.accepted, 1);
    assert.equal(facet.rolled, 0, "a stop is not a defeat");
    assert.equal(facet.iterations, 1, "only judged rounds count");
    assert.equal(facet.trend.length, 1, "an unjudged round has nothing to plot");
  });

  it("carries the lead's own reason, so the card cannot blame the owner", () => {
    const stopped = roundsOf(buildRunGraph(loopRun()))[1]!;
    assert.match(stopped.reason, /fixing the starting point/);
    assert.equal(stoppedWords(stopped.reason), "stopped by the lead — fixing the starting point");
    // The old wording, and what the user hears instead of it.
    assert.equal(stoppedWords("finishing after the current attempt at the user’s request"), "you asked it to wrap up");
    assert.equal(stoppedWords("stopped by the director"), "stopped by the lead");
  });
});

/** The builder's own starting brief: what an unjudged round carries as its "gap". */
const BRIEF =
  "Own src/main.js, src/chess/ and NOTES.md. Implement complete deterministic chess rules as pure state in src/chess/.";

/** Round one of a chess build, never judged: stopped by the lead, or its judge out of reach. */
function unjudgedFirstRound(verdictSource: string, reason: string): EventEnvelope[] {
  counter = 0;
  return [
    event("run_started", { project: "chess", goal: "playable chess" }),
    event("facet_iteration", {
      facetId: "chess",
      facetTitle: "Playable chess",
      iteration: 1,
      winner: verdictSource === "stopped" ? null : "incumbent",
      satisfied: false,
      verdictSource,
      reason,
      biggest_gap: BRIEF,
      defects: [],
      unmeasured: [],
      scoreboard: null,
      shots: [],
      flags: [],
      diffs: {},
    }),
  ];
}

/** The chat's narration lines for the part's rounds: a line on its own, or a row of a quiet group. */
function roundLines(events: EventEnvelope[]): { text: string; attention?: boolean }[] {
  const lines = toEntries(events).flatMap((entry) => {
    if (entry.kind === "system") return [{ text: entry.text, attention: entry.attention }];
    if (entry.kind === "activity") return entry.rows.map((row) => ({ text: row.text, attention: undefined }));
    return [];
  });
  return lines.filter((line) => / · round \d+: /.test(line.text));
}

describe("a stopped round in the chat", () => {
  it("says the lead stopped it in the lead's words, and never quotes the builder's brief as a gap", () => {
    const [line] = roundLines(
      unjudgedFirstRound(
        "stopped",
        "stopped by the director: Correcting a malformed initial check before the first judged round.",
      ),
    );
    assert.ok(line);
    assert.equal(
      line.text,
      "Playable chess · round 1: stopped by the lead — Correcting a malformed initial check before the first judged round.",
    );
    assert.doesNotMatch(line.text, /next gap/);
    assert.equal(line.attention, true, "a stop still asks for a look");
  });

  it("names no gap for a round whose judge could not be reached", () => {
    const [line] = roundLines(unjudgedFirstRound("outage", "judge unavailable"));
    assert.ok(line);
    assert.doesNotMatch(line.text, /next gap|src\/chess/);
  });

  it("keeps the judges' gap on a judged round", () => {
    const lines = roundLines(loopRun());
    assert.match(lines[0]!.text, /^Plaza · round 1: .* · next gap: the stone reads flat$/);
    assert.equal(lines[1]!.text, "Plaza · round 2: stopped by the lead — fixing the starting point");
  });

  it("leaves a stopped try's card without a problem nobody found", () => {
    const [stopped] = roundsOf(buildRunGraph(unjudgedFirstRound("stopped", "stopped by the director: fixing")));
    assert.equal(stopped!.biggestGap, "");
  });
});

describe("the words a stopped round wears", () => {
  it("says stopped, and says the work was kept", () => {
    assert.equal(wasStopped("stopped"), true);
    assert.equal(wasStopped("broken"), false);
    const words = verdictWords({ winner: null, satisfied: false, source: "stopped" });
    assert.equal(words.word, "stopped");
    assert.match(words.because, /the work it had done is kept/);
    assert.doesNotMatch(words.label, /undone|broken/);
    assert.equal(
      sideBySideWords({ status: "stopped", satisfied: false, source: "stopped" }),
      "Not reviewed — the lead stopped this round.",
    );
  });
});

describe("the Builds graph paints it grey", () => {
  it("gives a stopped step and try the muted ink, never the red of a broken build", () => {
    assert.equal(STATE_TONE["not-in-build"], "muted");
    assert.deepEqual(TRY_GLYPH.stopped, TRY_GLYPH.abandoned, "the same grey as a try nobody judged");
    assert.deepEqual(TRY_GLYPH.unjudged, TRY_GLYPH.abandoned, "a try with no recorded verdict is grey too");
    assert.equal(TRY_GLYPH.stopped.color, "var(--ink-3)");
    assert.notEqual(TRY_GLYPH.stopped.color, TRY_GLYPH.rolled.color, "not painted as broken");
    assert.equal(TRY_WORD.stopped, "stopped by the lead");
  });

  it("names a stopped try the lead stopped, and never calls it undone", () => {
    const graph = buildRunGraph(loopRun())!;
    const [row] = partRows(graph);
    const stopped = row!.steps.find((step) => step.tries.some((node) => node.status === "stopped"))!;
    assert.notEqual(stopped.state, "undone");
    assert.doesNotMatch(stepSentence(stopped, graph.active), /undid/);
  });
});

/**
 * Where a stop can land. `engine.abort` reaches only a live delegation, and a worker spends most
 * of its round in review, evidence, scoring and the judge with none — so a stop that arrived
 * there used to be swallowed: the round ran on to a verdict, lost it, the rollback erased the
 * work, and the `…-stopped` ref worker_stop names never existed.
 */
describe("a stop that lands between phases", () => {
  it("is the lead's alone: the owner's wrap-up still means after the current attempt", () => {
    assert.equal(stopsThisRound(false), null);
    assert.equal(stopsThisRound(true), null, "a wrap-up does not abandon the round in flight");
    assert.deepEqual(stopsThisRound({ by: "director", reason: "stopped by the director: fixing the starting point" }), {
      by: "director",
      reason: "stopped by the director: fixing the starting point",
    });
    // The build turn's own abort ends the round whoever asked, in their words when they gave any.
    assert.deepEqual(stopsThisRound(false, { aborted: true }), {
      by: "user",
      reason: "stopped before the round finished",
    });
    assert.deepEqual(stopsThisRound(true, { aborted: true }), {
      by: "user",
      reason: "finishing after the current attempt at the user\u2019s request",
    });
  });

  it("is asked at every phase after the build turn, and by both mid-round turns", () => {
    // The facet loop is facet-loop.ts and its modules under loop/facet/ (the phases among them).
    const loopDir = path.join(root, "src/harness-seed/loop");
    const files = [
      "facet-loop.ts",
      ...readdirSync(path.join(loopDir, "facet"), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => `facet/${file}`),
    ];
    const source = files.map((file) => readFileSync(path.join(loopDir, file), "utf8")).join("\n");
    assert.match(source, /const stoppedHere = async \(iteration(?:: number)?, aborted = false\)/);
    // Each round phase that follows the build asks, and a stop ends the facet's loop there.
    assert.equal(
      (source.match(/if \(await stoppedHere\(round\.iteration\)\) return RoundFlow\.Stop;/g) ?? []).length,
      3,
      "before review, before evidence, before the verdict",
    );
    // The review fix and the regression follow-up are delegations of their own: an abort lands
    // on them, not on the build turn, and used to be read for its session id and nothing else.
    assert.equal((source.match(/fix\.ok === false && fix\.stopReason === StopReason\.Stopped/g) ?? []).length, 2);
    // One place commits and bookmarks the round, whichever phase the stop arrived in.
    assert.equal(
      (source.match(/attemptRef\(run\.runId, facet\.id, iteration, \{ stopped: true \}\)/g) ?? []).length,
      1,
    );
  });
});

describe("who asked the facet to stop", () => {
  it("keeps the user's wrap-up as the user's, and lets the director answer for itself", () => {
    // Nobody asked.
    assert.equal(stopSignal(false), null);
    assert.equal(stopSignal(undefined), null);
    // The old contract — a bare `true` is the owner's own wrap-up signal, and reads as one.
    assert.deepEqual(stopSignal(true), {
      by: "user",
      reason: "finishing after the current attempt at the user\u2019s request",
    });
    // The director answers with itself and its reason, which becomes the round's wording.
    assert.deepEqual(stopSignal({ by: "director", reason: "stopped by the director: fixing the starting point" }), {
      by: "director",
      reason: "stopped by the director: fixing the starting point",
    });
    // A director that gives no reason still does not get to blame anyone.
    assert.deepEqual(stopSignal({ by: "director" }), { by: "director", reason: "stopped by the director" });
  });
});
