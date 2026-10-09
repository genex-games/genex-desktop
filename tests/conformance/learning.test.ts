/**
 * Learning from runs — the studio's memory of one game.
 *
 * The harness already learned two things between runs: skills (skillopt, the blind pairwise
 * gate) and techniques (the recipe library, promoted and retired by check outcomes). Neither
 * remembered a *game*, so the second run on a game paid for the first run's mistakes again:
 * rounds lost to one inherited console error, and nothing anywhere wrote that down.
 *
 * What is tested here: the ledger records a run leaves (judged rounds, stopped rounds, the
 * builders the fork gate refused, the close), the lessons those records add up to, that both
 * briefs carry them the next run, that a check nobody has ever been able to measure is flagged
 * in the catalogue and warned about in the dry run, the one line the morning card gets, and that
 * the skillopt analyst now sees what a director's run actually did. No model runs here: the
 * pure halves are pure, and the rig run is the fake engine.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import {
  appendLedger,
  closeRecord,
  flagRarelyMeasurable,
  lastTimeBlock,
  learnedThisRun,
  ledgerFile,
  ledgerFromEvents,
  lessonsFile,
  loadGameLessons,
  rarelyMeasurable,
  readLedger,
  refusalRecord,
  roundRecord,
  saveGameLessons,
} from "../../src/harness-seed/loop/ledger.ts";
import { compileWorkerSpec, directorBrief } from "../../src/harness-seed/loop/director.ts";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { mineValidationTasks } from "../../src/harness-seed/loop/skillopt.ts";
import { morningWords } from "../../src/renderer/morning-words.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

const FIXTURE = path.resolve(import.meta.dirname, "..", "fixtures", "learning-loop-run.json");
/** Synthetic replay coverage: 21 rounds, 10 kept, nothing landed. */
async function regressionLoopRun(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(FIXTURE, "utf8"));
}

describe("the ledger: one durable record per outcome", () => {
  it("reads a synthetic run back into records — judged, stopped, refused and the close itself", async () => {
    const records = ledgerFromEvents(await regressionLoopRun(), { game: "fixture-derby", gameKind: "three-vite" });
    const rounds = records.filter((r) => r.round > 0);
    assert.equal(rounds.length, 21, "one record per round the run judged");
    assert.equal(rounds.filter((r) => r.decision === "kept").length, 10);
    assert.equal(rounds.filter((r) => r.decision === "undone").length, 11);

    const first = rounds[0]!;
    assert.equal(first.runId, "run_fixture123456");
    assert.equal(first.mode, "director");
    assert.equal(first.gameKind, "three-vite");
    assert.equal(first.part, "post");
    assert.equal(first.round, 1);
    assert.equal(first.rule, "broken");
    // The sentence is the verdict module's, so it carries no check id, sha or branch.
    assert.match(first.because, /the game did not start after this build/);
    assert.doesNotMatch(first.because, /[0-9a-f]{10}|attempt\//);
    // The run's own budget, read off the worker card that started that part.
    assert.equal(first.minutes, 75);

    // The close is one record too: a run that made nothing live is undone, like a round.
    const close = records.at(-1)!;
    assert.equal(close.round, 0);
    assert.equal(close.decision, "undone");
    assert.equal(close.rule, "not-landed");
    assert.match(close.because, /ran out of time without calling finish/);
    // `; nothing was landed (land=no)` is what the record's own decision already says.
    assert.doesNotMatch(close.because, /land=no/);
  });

  it("makes the same record live, from what the run has in its hand", () => {
    const stopped = roundRecord({
      runId: "run_x",
      game: "skate",
      gameKind: "studio-template",
      part: "plaza",
      title: "Plaza",
      round: 2,
      verdictSource: "stopped",
      brief: "paint the plaza red".repeat(40),
    });
    assert.equal(stopped.decision, "stopped");
    assert.equal(stopped.rule, "stopped");
    assert.match(stopped.because, /the lead stopped this round/);
    assert.ok(
      stopped.briefDigest.length <= 300 && stopped.briefDigest.endsWith("…"),
      "the brief is kept as a digest, not as a second copy of itself",
    );

    const kept = roundRecord({
      part: "plaza",
      round: 3,
      winner: "challenger",
      verdictSource: "checks",
      scoreboard: {
        total: 6,
        passing: 4,
        unmeasured: 2,
        flips: ["lit"],
        regressions: [],
        unmeasuredChecks: [{ id: "plaza-wet" }, { id: "bench-sittable" }],
      },
    });
    assert.equal(kept.decision, "kept");
    assert.deepEqual(kept.checks, { passed: 4, failed: 0, unmeasured: 2 });
    assert.deepEqual(kept.unmeasuredChecks, ["plaza-wet", "bench-sittable"]);

    const refused = refusalRecord({ part: "sky", problems: ["the build does not run: 1 console error"] });
    assert.equal(refused.decision, "refused");
    assert.equal(refused.round, 0);
    assert.match(refused.because, /No builder could start/);
  });

  it("appends, survives a half-written line, and hands the whole game back", async () => {
    const workspace = await tmpDir("ledger-");
    await appendLedger(
      workspace,
      "Skate Prod",
      roundRecord({ runId: "r1", part: "plaza", round: 1, winner: "challenger", verdictSource: "checks" }),
    );
    await appendLedger(
      workspace,
      "Skate Prod",
      closeRecord({ runId: "r1", landed: true, because: "made live, a judge preferred it" }),
    );
    // A hard kill mid-write: the line is lost, the ledger is not.
    await writeFile(
      ledgerFile(workspace, "Skate Prod"),
      `${await readFile(ledgerFile(workspace, "Skate Prod"), "utf8")}{"at":"2026`,
    );
    const records = await readLedger(workspace, "Skate Prod");
    assert.equal(records.length, 2);
    assert.equal(records[0]!.decision, "kept");
    // A record read back is the record that was written — the brief digest and the failed count
    // are both fields the normaliser has to accept in the shape it writes them in.
    assert.deepEqual(
      records[0],
      roundRecord({
        runId: "r1",
        part: "plaza",
        round: 1,
        winner: "challenger",
        verdictSource: "checks",
        at: records[0]!.at,
      }),
    );
    assert.equal(records[1]!.rule, "landed");
    assert.match(
      ledgerFile(workspace, "Skate Prod"),
      /library\/games\/skate-prod\.jsonl$/,
      "the studio's own state, never the user's repo",
    );
  });
});

describe("the lessons a game's runs add up to", () => {
  it("names the synthetic run's undone patterns, what its judges kept saying, and what worked", async () => {
    const workspace = await tmpDir("lessons-");
    const records = ledgerFromEvents(await regressionLoopRun(), { game: "fixture-derby", gameKind: "three-vite" });
    for (const record of records) await appendLedger(workspace, "fixture-derby", record);
    const { file, lessons } = await saveGameLessons(
      workspace,
      "fixture-derby",
      await readLedger(workspace, "fixture-derby"),
    );
    assert.equal(file, lessonsFile(workspace, "fixture-derby"));
    const text = await readFile(file, "utf8");

    // The pattern that cost that run: eight rounds against one build that would not run.
    assert.match(lessons[0]!, /8 of 21 rounds were undone because the game did not start after the build/);
    assert.match(lessons[0]!, /Look at what a builder forks from/);
    // What its judges kept rejecting, from the gaps they wrote.
    assert.ok(
      lessons.some((l) => /keep naming the same things: "floating" \(6 rounds\)/.test(l)),
      lessons.join(" | "),
    );
    // What worked, so the next run starts where the last one paid.
    assert.ok(
      lessons.some((l) => /What worked: rounds on "Vehicle silhouettes" were kept 3 of 3/.test(l)),
      lessons.join(" | "),
    );
    // And that it made nothing live.
    assert.ok(
      lessons.some((l) => /made nothing live/.test(l)),
      lessons.join(" | "),
    );

    assert.match(text, /# What the studio learned on "fixture-derby"/);
    assert.match(text, /## The runs behind them/);
    assert.match(text, /21 rounds, 10 kept, 11 undone/);
    // The file is derived; the ledger is the source, so the brief never parses markdown back.
    assert.deepEqual(await loadGameLessons(workspace, "fixture-derby"), lessons.slice(0, 5));
  });

  it("says nothing when there is nothing to say — one run, one kept round, no pattern", async () => {
    const workspace = await tmpDir("quiet-");
    await appendLedger(
      workspace,
      "new-game",
      roundRecord({ runId: "r1", part: "a", round: 1, winner: "challenger", verdictSource: "checks" }),
    );
    await appendLedger(
      workspace,
      "new-game",
      closeRecord({ runId: "r1", landed: true, because: "made live, a judge preferred it" }),
    );
    assert.deepEqual(await loadGameLessons(workspace, "new-game"), [], "one good run is not a lesson");
    assert.equal(lastTimeBlock([]), "", "and an empty list is no block at all");
  });
});

describe("the next run's briefs carry them", () => {
  const lessons = [
    "8 of 21 rounds were undone because the game did not start after the build.",
    'The judges on this game keep naming the same things: "floating" (6 rounds).',
  ];

  it("puts LAST TIME ON THIS GAME in the director's brief", () => {
    const now = Date.now();
    const brief = directorBrief({
      run: { runId: "run_d", project: "fixture-derby", goal: "make the crashes hurt" },
      softDeadline: now + 50 * 60_000,
      finalDeadline: now + 60 * 60_000,
      integrationWorktree: "/scratch/integration",
      baseCommit: "abcdef1234567890",
      gameLessons: lessons,
    } as never);
    assert.match(
      brief,
      /LAST TIME ON THIS GAME \(what earlier runs on this exact game cost — do not pay for them again\):/,
    );
    assert.match(brief, /- 8 of 21 rounds were undone because the game did not start/);
    assert.match(brief, /- The judges on this game keep naming the same things/);
    // A game with no ledger yet is briefed exactly as it was before.
    const first = directorBrief({
      run: { runId: "r", project: "p", goal: "g" },
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.doesNotMatch(first, /LAST TIME ON THIS GAME/);
  });

  it("puts the same block in the builder's BRIEF.md, under the steering the user gave this run", () => {
    const text = renderBrief({
      run: { runId: "run_d", goal: "make the crashes hurt" },
      spec: { id: "crumple", title: "Crash damage", intent: "dents where the hits land", checks: [] },
      iteration: 1,
      board: {},
      comparison: null,
      steering: ["keep the camera where it is"],
      lessons: ["Capture after every meaningful change."],
      gameLessons: lessons,
    } as never);
    assert.match(text, /## LAST TIME ON THIS GAME \(earlier runs on this exact game — do not pay for them again\)/);
    assert.match(text, /- 8 of 21 rounds were undone/);
    // The game's own lessons outrank the general ones, and both sit below the user's steering.
    assert.ok(
      text.indexOf("USER STEERING") < text.indexOf("LAST TIME ON THIS GAME"),
      "the user still outranks the ledger",
    );
    assert.ok(
      text.indexOf("LAST TIME ON THIS GAME") < text.indexOf("Lessons from past runs"),
      "this game before every game",
    );
  });
  it("carries at most six lessons from past runs, so the brief stays about this round's move", () => {
    const many = Array.from({ length: 8 }, (_, i) => `past lesson ${i + 1}`);
    const text = renderBrief({
      run: { runId: "run_d", goal: "make the crashes hurt" },
      spec: { id: "crumple", title: "Crash damage", intent: "dents where the hits land", checks: [] },
      iteration: 1,
      board: {},
      comparison: null,
      steering: [],
      lessons: many,
      gameLessons: [],
    } as never);
    assert.match(text, /## Lessons from past runs/);
    const shown = text.split("\n").filter((line) => /^- past lesson \d+$/.test(line));
    assert.equal(shown.length, 6);
    // The file appends, so its newest lessons are last: those are the six a builder reads.
    assert.deepEqual(
      shown,
      [3, 4, 5, 6, 7, 8].map((n) => `- past lesson ${n}`),
      "the newest six, not the six oldest",
    );
  });
});

describe("a check nobody can measure stops being written", () => {
  const records = [1, 2, 3].map((round) =>
    roundRecord({
      runId: "r1",
      game: "skate",
      gameKind: "studio-template",
      part: "plaza",
      round,
      winner: "incumbent",
      verdictSource: "checks",
      scoreboard: {
        total: 3,
        passing: 1,
        unmeasured: 1,
        flips: [],
        regressions: [],
        unmeasuredChecks: [{ id: "plaza-wet" }],
      },
    }),
  );

  it("counts unmeasured rounds by the kind of game, not across every game at once", () => {
    assert.deepEqual(rarelyMeasurable(records, { kind: "studio-template" }), [{ id: "plaza-wet", rounds: 3 }]);
    assert.deepEqual(
      rarelyMeasurable(records, { kind: "phaser" }),
      [],
      "another kind of game may well be able to read it",
    );
    assert.deepEqual(rarelyMeasurable(records.slice(0, 2), { kind: "studio-template" }), [], "twice is a coincidence");
  });

  /**
   * The warning is only as real as the payload a run actually emits. Every test above hands
   * `roundRecord` a board it wrote itself; the loop's own `facet_iteration.scoreboard` is built
   * field by field, and while it carried the counts but not the ids the ledger recorded
   * "3 unmeasured, none of them named" every round and this whole feature was inert.
   */
  it("reads the ids out of a round payload a run emits, and out of an older one that has only its results", () => {
    const results = [
      { id: "plaza-wet", kind: "probe", weight: "identity", pass: null, reason: "state.plaza.wet is not reported" },
      { id: "lit", kind: "pixel", weight: "normal", pass: true, reason: "" },
    ];
    const loopRun = (scoreboard: Record<string, unknown>) =>
      [1, 2, 3].map((iteration) => ({
        data: {
          type: "custom",
          event_type: "facet_iteration",
          payload: {
            runId: "r2",
            facetId: "plaza",
            iteration,
            winner: "incumbent",
            verdictSource: "checks",
            scoreboard,
          },
        },
      }));
    const asEmitted = ledgerFromEvents(
      loopRun({
        total: 2,
        passing: 1,
        unmeasured: 1,
        flips: [],
        regressions: [],
        unmeasuredChecks: ["plaza-wet"],
        results,
      }),
      { game: "skate", gameKind: "studio-template" },
    );
    assert.deepEqual(asEmitted[0]!.unmeasuredChecks, ["plaza-wet"]);
    assert.deepEqual(rarelyMeasurable(asEmitted, { kind: "studio-template" }), [{ id: "plaza-wet", rounds: 3 }]);
    // A run recorded before the payload carried the ids: its results still say which check
    // measured nothing — neither true nor false is what "unmeasured" means.
    const older = ledgerFromEvents(
      loopRun({ total: 2, passing: 1, unmeasured: 1, flips: [], regressions: [], results }),
      { game: "skate", gameKind: "studio-template" },
    );
    assert.deepEqual(older[0]!.unmeasuredChecks, ["plaza-wet"]);
    assert.deepEqual(rarelyMeasurable(older, { kind: "studio-template" }), [{ id: "plaza-wet", rounds: 3 }]);
  });

  it("flags it in the catalogue, and only where the catalogue already knows the check", () => {
    const catalogue = {
      version: 1,
      checks: { "plaza-wet": { kind: "probe", expr: "state.plaza.wet > 0", uses: 3, passes: 0 } },
    } as never;
    flagRarelyMeasurable(catalogue, records);
    const entry = (
      catalogue as {
        checks: Record<string, { rarelyMeasurable?: string[]; unmeasuredRounds?: Record<string, number> }>;
      }
    ).checks["plaza-wet"]!;
    assert.deepEqual(entry.rarelyMeasurable, ["studio-template"]);
    assert.deepEqual(entry.unmeasuredRounds, { "studio-template": 3 });
    // An id the catalogue has no definition for is not invented: it would reach the planner as
    // a check nobody could run.
    const empty = { version: 1, checks: {} } as never;
    flagRarelyMeasurable(empty, records);
    assert.deepEqual((empty as { checks: Record<string, unknown> }).checks, {});
  });

  it("warns the director's dry run about it, and about nothing else on the board", () => {
    const compiled = compileWorkerSpec(
      {
        id: "plaza",
        title: "Plaza",
        brief: "the plaza at dusk",
        done: [
          { what: "the plaza is wet", check: { id: "plaza-wet", kind: "probe", expr: "state.plaza.wet > 0" } },
          {
            what: "the plaza is lit",
            check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
          },
        ],
      } as never,
      null,
      {
        rarelyMeasurable: [
          { id: "plaza-wet", rounds: 4 },
          { id: "not-on-this-board", rounds: 9 },
        ],
      },
    );
    assert.deepEqual(compiled.rarelyMeasurable, [{ id: "plaza-wet", rounds: 4 }]);
    // It is a warning, never a refusal: a path a build must start reporting is a real contract.
    assert.ok(compiled.spec.checks.some((c: { id: string }) => c.id === "plaza-wet"));
    assert.deepEqual(
      compileWorkerSpec({ id: "plaza", title: "Plaza", brief: "b" } as never, null).rarelyMeasurable,
      [],
    );
  });
});

describe("what the morning card says the studio learned", () => {
  it("turns this run's records into one sentence with no id in it", async () => {
    const runLedger = ledgerFromEvents(await regressionLoopRun(), { game: "fixture-derby", gameKind: "three-vite" });
    const learned = learnedThisRun(runLedger);
    // No part of that run holds more than half of its ten kept rounds, so the sentence claims
    // no favourite: "most of them on X" is a majority's word, not the leader's.
    assert.match(learned, /^10 of 21 rounds were kept\. /, learned);
    assert.match(learned, /written down what worked/);

    // The sentence agrees with its own count. One kept round was kept — and one part holding it
    // is "on", never "most of them on".
    const oneKept = [
      roundRecord({
        part: "plaza",
        title: "Dusk light on the water",
        round: 1,
        winner: "challenger",
        verdictSource: "checks",
      }),
      roundRecord({
        part: "plaza",
        title: "Dusk light on the water",
        round: 2,
        winner: "incumbent",
        verdictSource: "vetoed",
      }),
    ];
    assert.match(
      learnedThisRun(oneKept),
      /^1 of 2 rounds was kept, on Dusk light on the water\./,
      learnedThisRun(oneKept),
    );
    // And a part that does hold the majority is still named as one.
    const mostly = [
      ...[1, 2, 3].map((round) =>
        roundRecord({
          part: "plaza",
          title: "Dusk light on the water",
          round,
          winner: "challenger",
          verdictSource: "checks",
        }),
      ),
      roundRecord({ part: "sky", title: "Sky", round: 4, winner: "challenger", verdictSource: "checks" }),
    ];
    assert.match(
      learnedThisRun(mostly),
      /^4 of 4 rounds were kept, most of them on Dusk light on the water\./,
      learnedThisRun(mostly),
    );

    // A run whose rounds mostly went the same way says which way, in the user's words.
    const broken = [1, 2, 3].map((round) =>
      roundRecord({ part: "plaza", round, winner: "incumbent", verdictSource: "broken" }),
    );
    assert.match(
      learnedThisRun(broken),
      /Most of the work that was undone went the same way: the game did not start after the build/,
    );
    assert.equal(learnedThisRun([]), "", "a run with no rounds learned nothing worth a line");
  });

  it("reaches the card as its own line, scrubbed like every other harness sentence", () => {
    const words = morningWords({
      rounds: 21,
      kept: 10,
      undone: 11,
      landed: false,
      paused: false,
      hasBuild: true,
      summary: "the crashes hurt now",
      learned: "10 of 21 rounds were kept in run_fixture123456, most of them on Vehicle silhouettes.",
    });
    assert.match(words.learned!, /10 of 21 rounds were kept/);
    assert.doesNotMatch(words.learned!, /run_fixture123456/, "no run id reaches the card");
    assert.equal(
      morningWords({ rounds: 0, kept: 0, undone: 0, landed: null, paused: false, hasBuild: false }).learned,
      null,
    );
  });
});

describe("skillopt sees what a director's run actually did", () => {
  it("mines the fork gate, the rounds it stopped, the builders that ended badly and the landing", () => {
    const events = [
      {
        data: {
          type: "custom",
          event_type: "director_verdict",
          payload: {
            pass: "gate",
            decision: { kept: false },
            because: "No builder could start: the build they would work from did not run.",
            build: { worker: "crumple" },
            observed: { problems: ["1 console error"] },
          },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "director_verdict",
          payload: {
            pass: "gate",
            decision: { kept: true },
            because: "It starts and draws its first frame.",
            build: { worker: "dirt" },
          },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "facet_iteration",
          payload: {
            facetId: "plaza",
            facetTitle: "Plaza",
            iteration: 2,
            verdictSource: "stopped",
            reason: "stopped by the director: fixing the starting point",
          },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "director_worker",
          payload: { workerId: "sky", title: "Sky", state: "failed", stoppedBecause: "the session did not finish" },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "director_worker",
          payload: { workerId: "sky", title: "Sky", state: "running" },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "run_finished",
          payload: {
            runId: "run_x",
            landed: false,
            landingResult: { ok: false, how: "not-landed", line: "nothing was made live" },
          },
        },
      },
    ];
    const tasks = mineValidationTasks(events as never, 20);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

    assert.match(byId["gate-crumple"]!.prompt, /a builder was refused before it started: No builder could start/);
    assert.equal(byId["gate-crumple"]!.success, false);
    assert.deepEqual(byId["gate-crumple"]!.skills, ["director"]);
    assert.ok(!tasks.some((t) => t.id === "gate-dirt"), "a fork point that runs is not a lesson");

    assert.match(
      byId["stopped-plaza-2"]!.prompt,
      /a round was stopped before it could be judged: Plaza — stopped by the director/,
    );
    assert.equal(byId["stopped-plaza-2"]!.success, false);

    assert.match(byId["worker-sky"]!.prompt, /a builder ended as failed: Sky — the session did not finish/);
    assert.equal(tasks.filter((t) => t.id === "worker-sky").length, 1, "a running worker's card is not an outcome");

    assert.match(byId["landing-run_x"]!.prompt, /the build ended: nothing was made live/);
    assert.equal(byId["landing-run_x"]!.success, false);
  });

  it("still mines a judged round as the task it always was, and calls a landed run a success", () => {
    const tasks = mineValidationTasks(
      [
        {
          data: {
            type: "custom",
            event_type: "facet_iteration",
            payload: {
              facetId: "terrain",
              facetTitle: "Terrain",
              iteration: 1,
              winner: "challenger",
              verdictSource: "checks",
              biggest_gap: "no depth",
            },
          },
        },
        {
          data: {
            type: "custom",
            event_type: "run_finished",
            payload: {
              runId: "run_y",
              landed: true,
              landingResult: { ok: true, verified: true, how: "judge-pick", line: "made live, a judge preferred it" },
            },
          },
        },
      ] as never,
      20,
    );
    assert.equal(tasks[0]!.prompt, "Terrain: no depth");
    assert.equal(tasks[0]!.success, true);
    assert.deepEqual(tasks[0]!.skills, [], "a round belongs to whoever built it, not to the lead");
    assert.equal(tasks[1]!.success, true);
    assert.match(tasks[1]!.prompt, /made live, a judge preferred it/);
  });
});

function fakeEngine(rig: Rig, delegate: (request: DelegateRequest) => Promise<DelegateResult>): void {
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: "codex",
      stopReason: "stop",
    }),
    delegate,
  } as never);
}

describe("two runs on one game, through the real core and harness", () => {
  it("the first run's outcomes are in the second run's brief, and in every builder's", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("learning-run", { title: "Learning run" });
    const workspace = rig.core.layout.harnessWs;

    // This game already had a run: a synthetic replay in its ledger.
    for (const record of ledgerFromEvents(await regressionLoopRun(), {
      game: project.name,
      gameKind: "studio-template",
    })) {
      await appendLedger(workspace, project.name, record);
    }
    // …and three rounds in which one check never measured anything, so the dry run has something
    // to warn the lead about before it starts a builder on it.
    for (const round of [1, 2, 3]) {
      await appendLedger(
        workspace,
        project.name,
        roundRecord({
          runId: "run_old",
          game: project.name,
          gameKind: "studio-template",
          part: "plaza",
          round,
          winner: "incumbent",
          verdictSource: "checks",
          scoreboard: {
            total: 2,
            passing: 0,
            unmeasured: 1,
            flips: [],
            regressions: [],
            unmeasuredChecks: [{ id: "plaza-wet" }],
          },
        }),
      );
    }

    const seen: DelegateRequest[] = [];
    const results: Record<string, any> = {};
    let loopRun = 0;
    const building: Record<string, boolean> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        loopRun += 1;
        if (loopRun === 1) {
          await call("plan", {
            summary: "This run: the plaza.",
            workers: JSON.stringify([
              {
                id: "plaza",
                title: "Plaza",
                seam: "the plaza",
                owns: "src/plaza.js",
                done: ["the plaza is lit"],
                minutes: 6,
              },
            ]),
          });
          results.started = JSON.parse(
            String(
              await call("worker_start", {
                id: "plaza",
                title: "Plaza",
                brief: "paint the plaza red and light it",
                minutes: "6",
                iterations: "1",
                owns: "src/plaza.js",
                done: JSON.stringify([
                  { what: "the plaza is wet", check: { id: "plaza-wet", kind: "probe", expr: "state.plaza.wet > 0" } },
                  {
                    what: "the plaza is lit",
                    check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
                  },
                ]),
              }),
            ),
          );
          for (let i = 0; i < 60 && !building.plaza; i++) await call("wait", { seconds: "1", worker: "plaza" });
          // The builder's own brief, read out of its worktree while it still exists.
          results.workerBrief = await readFile(
            path.join(results.started.worktree, ".studio", "BRIEF.md"),
            "utf8",
          ).catch((err) => String(err));
          await call("worker_stop", { id: "plaza", why: "the starting point comes first" });
          for (let i = 0; i < 30; i++) {
            const waited = JSON.parse(String(await call("wait", { seconds: "5", worker: "plaza" })));
            if (waited.status.workers[0]?.state !== "running") break;
          }
          await call("finish", { summary: "the plaza needs a starting point first", land: "no" });
          return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "director-1", summary: "run one" };
        }
        await call("finish", { summary: "nothing to build on this run", land: "no" });
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "director-2", summary: "run two" };
      }
      const who = path.basename(request.cwd);
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      building[who] = true;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) return resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "worker-1",
        summary: "half the plaza",
      };
    });

    const runOne = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId: runOne,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const logOne = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runOne),
      180_000,
      "run one",
    );

    // ── the first run reads the ledger it inherited ──
    assert.match(seen[0]!.prompt, /LAST TIME ON THIS GAME/, "the lead is told what this game already cost");
    // Twenty-one rounds from the run the owner watched, three more seeded above.
    assert.match(seen[0]!.prompt, /8 of 24 rounds were undone because the game did not start after the build/);
    // And the builder gets the same five in the one file it is told to read first.
    assert.match(String(results.workerBrief), /## LAST TIME ON THIS GAME/, String(results.workerBrief).slice(0, 400));
    assert.match(String(results.workerBrief), /8 of 24 rounds were undone/);

    // The dry run warns about the check three earlier rounds could never read.
    assert.deepEqual(
      results.started.rarelyMeasurable,
      [{ id: "plaza-wet", rounds: 3 }],
      JSON.stringify(results.started),
    );
    assert.match(String(results.started.rarelyMeasurableWarning), /plaza-wet \(3 rounds\)/);

    // ── what the first run wrote down ──
    const afterOne = await readLedger(workspace, project.name);
    const mine = afterOne.filter((r) => r.runId === runOne);
    assert.equal(mine.length, 2, JSON.stringify(mine));
    const [stopped, close] = mine as [(typeof mine)[number], (typeof mine)[number]];
    assert.equal(stopped.decision, "stopped");
    assert.equal(stopped.part, "plaza");
    assert.equal(stopped.round, 1);
    assert.equal(stopped.gameKind, "studio-template");
    assert.match(stopped.briefDigest, /paint the plaza red and light it/);
    assert.equal(close.decision, "undone");
    assert.equal(close.rule, "not-landed");
    assert.equal(close.round, 0);

    // The lessons file is written at the close, and the run's own report carries the line.
    const lessons = await readFile(lessonsFile(workspace, project.name), "utf8");
    // The lessons file is written after the run's own round joined the ledger: 24 + this one.
    assert.match(lessons, /8 of 25 rounds were undone because the game did not start/);
    assert.match(
      lessons,
      /2 of 2 runs on this game made nothing live — the last one because the lead kept this build aside/,
      lessons,
    );
    const finishedOne = customEvents(logOne, "run_finished").find((e) => e.runId === runOne)!;
    assert.equal(typeof finishedOne.learned, "string", JSON.stringify(finishedOne.learned));

    // ── the second run, on the same game ──
    const runTwo = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId: runTwo,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runTwo),
      180_000,
      "run two",
    );

    assert.equal(seen.length, 2, "two director sessions");
    assert.match(seen[1]!.prompt, /LAST TIME ON THIS GAME/);
    // The lines the SECOND run reads are ones the FIRST run wrote: its own round and its own
    // close are in the count (24 rounds and one run in the brief it read, 25 and two in this).
    assert.match(
      seen[1]!.prompt,
      /8 of 25 rounds were undone because the game did not start/,
      seen[1]!.prompt.slice(0, 3000),
    );
    assert.match(
      seen[1]!.prompt,
      /2 of 2 runs on this game made nothing live — the last one because the lead kept this build aside/,
      seen[1]!.prompt.slice(0, 3000),
    );

    // ── a game whose runs happened before the ledger existed ──
    // Emptied here the way history is empty for every game the studio ran before this file: the
    // thread still holds those runs, so the next one reads them back rather than starting
    // blank (`ledgerFromEvents`, which until now nothing in the studio called).
    await writeFile(ledgerFile(workspace, project.name), "");
    const runThree = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId: runThree,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runThree),
      180_000,
      "run three",
    );

    assert.equal(seen.length, 3, "three director sessions");
    assert.match(seen[2]!.prompt, /LAST TIME ON THIS GAME/, seen[2]!.prompt.slice(0, 3000));
    assert.match(seen[2]!.prompt, /2 of 2 runs on this game made nothing live/, seen[2]!.prompt.slice(0, 3000));
    // The replay is written down, so the run after this one reads a file and not a log again.
    const rebuilt = await readLedger(workspace, project.name);
    assert.ok(
      rebuilt.some((r) => r.runId === runOne),
      `the first run is back in the ledger: ${JSON.stringify(rebuilt.map((r) => r.runId))}`,
    );
    assert.ok(
      rebuilt.some((r) => r.runId === runTwo),
      "and the second",
    );
  });
});
