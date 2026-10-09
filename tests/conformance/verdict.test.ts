/**
 * The verdict record — one shape for every judged build, and one sentence a player can read.
 *
 * A run judges builds in five places: a worker's own round, the lead's fork gate, the lead's
 * judge, the health pass after a merge, and the close. Before `loop/verdict.ts` each of those
 * answered in its own shape and its own words, so the app's build box showed boilerplate about
 * the run, a round card counted checks the judge had *grown* as wins, and `report.json` dropped
 * `verdictSource` and the scoreboard on every one of the first real run's twenty-one rounds.
 *
 * Two gates run here. The first is the shape: every pass produces the same keys. The second is
 * the sentence: no `because` may carry a check id, a commit, a branch, a path or a harness word,
 * whatever free text the judge that wrote it handed in.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import {
  againstWords,
  observedFrom,
  plainClause,
  roundRule,
  verdictRecord,
  VERDICT_PASSES,
} from "../../src/harness-seed/loop/verdict.ts";
import { iterationDigest } from "../../src/harness-seed/loop/director.ts";
import { buildRunGraph, headVerdict, plannedFlips, type IterationNode } from "../../src/renderer/run-graph.ts";
import { buildProgress, buildVerdictLine } from "../../src/renderer/build-progress.ts";
import { undoneBecause, verdictWords } from "../../src/renderer/words.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

// ── the gate every sentence passes ────────────────────────────────────────────────────────

/** `state.contact.speedKept`, `motion-blur-at-speed`, `[state.post.bloom]` — a check, not a reason. */
const CHECK_ID = /\[[^\]]*\]|`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/;
/** Any sha the harness prints — every one is sliced to 8 or 10 characters. */
const SHA = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
const RUN_ID = /\brun_[0-9a-z]/i;
const REF = /\b(?:refs\/|attempt\/)|\/(?:Users|private|var|tmp)\//;
/** The harness's own vocabulary: true of the log, unreadable on a card. */
const HARNESS_WORD =
  /\b(?:challengers?|incumbents?|facets?|worktrees?|scoreboards?|gauntlets?|iterations?|verdicts?|autopilot|integration|integrated|director|commits?|shas?|land=|HEAD)\b/i;

function assertPlain(sentence: string, what: string): void {
  assert.ok(sentence.length > 12, `${what}: "${sentence}" is not a sentence`);
  assert.ok(/^[A-Z]/.test(sentence), `${what}: "${sentence}" does not open like a sentence`);
  assert.ok(/[.!?]$/.test(sentence), `${what}: "${sentence}" does not close like a sentence`);
  assert.doesNotMatch(sentence, CHECK_ID, `${what}: a check id reached the screen`);
  assert.doesNotMatch(sentence, SHA, `${what}: a commit reached the screen`);
  assert.doesNotMatch(sentence, RUN_ID, `${what}: a run id reached the screen`);
  assert.doesNotMatch(sentence, REF, `${what}: a ref or a path reached the screen`);
  assert.doesNotMatch(sentence, HARNESS_WORD, `${what}: a harness word reached the screen`);
}

/** The keys every record carries, whichever pass wrote it. */
const SHAPE: Record<string, string[]> = {
  build: ["head", "worker", "round"],
  against: ["head", "what"],
  observed: ["ok", "problems", "cameras", "demos", "consoleFresh", "consoleInherited"],
  measured: ["planned", "grown", "flips", "regressions", "unmeasured"],
  seen: ["pick", "veto", "satisfied", "question", "answer", "alive", "aliveMax", "judgeCalls"],
  decision: ["kept", "rule"],
};

function assertShape(record: Record<string, any>, what: string): void {
  // `runId` is the envelope every run event carries, not part of the record itself.
  assert.deepEqual(
    Object.keys(record)
      .filter((key) => key !== "runId")
      .sort(),
    ["against", "at", "because", "build", "decision", "measured", "observed", "pass", "seen"],
    what,
  );
  assert.ok(VERDICT_PASSES.includes(record.pass), `${what}: unknown pass ${record.pass}`);
  for (const [group, keys] of Object.entries(SHAPE))
    assert.deepEqual(Object.keys(record[group]).sort(), [...keys].sort(), `${what}.${group}`);
  assert.equal(typeof record.decision.rule, "string", `${what}: a rule`);
  assertPlain(record.because, `${what}.because`);
}

// ── the free text a real run hands in ───────────────────────────────────────────────────

/** Gaps, problems and reasons taken verbatim from the first real run's own event journal. */
const REAL_FREE_TEXT = [
  "the build does not run: 1 console error(s)",
  "regressed state.contact.speedKept, motion-blur-at-speed",
  "checks accepted (state.post.bloom), taste judge did not veto",
  "the challenger did not produce a judgeable build in the integration worktree",
  "every camera renders effectively black at 69f573d1a2 (litFraction 0.001)",
  "kept unlanded on refs/studio/runs/run_fixture123456/integration",
  "the base at a82ee734 was rebuilt: crowd shader now compiles under r185",
  "THREE.WebGLProgram: shader error in /Users/x/ai-games/skate/src/main.js",
  "the mud never reaches the tyres on the dirt-side camera",
];

describe("one record, whatever judged the build", () => {
  it("gives every pass the same shape and a sentence with no id, sha or harness word in it", () => {
    const records = [
      verdictRecord({
        pass: "round",
        worker: "shine",
        round: 3,
        kept: true,
        flips: ["a", "b"],
        rule: roundRule({ source: "checks", won: true }),
      }),
      verdictRecord({
        pass: "round",
        worker: "shine",
        round: 4,
        kept: false,
        regressions: ["state.a.b"],
        rule: roundRule({ source: "checks", won: false }),
      }),
      verdictRecord({ pass: "round", worker: "shine", round: 5, kept: null, rule: "stopped" }),
      verdictRecord({
        pass: "gate",
        head: "69f573d1a2",
        worker: "mud",
        ok: false,
        problems: ["every camera renders effectively black"],
        kept: false,
        rule: "does-not-start",
      }),
      verdictRecord({ pass: "gate", head: "69f573d1a2", worker: "mud", ok: true, kept: true, rule: "starts" }),
      verdictRecord({
        pass: "judge",
        head: "69f573d1a2",
        against: againstWords("start"),
        pick: "challenger",
        kept: true,
        rule: "preferred",
      }),
      verdictRecord({
        pass: "judge",
        against: againstWords("shine", { workerTitle: "Shine" }),
        pick: "incumbent",
        kept: true,
        rule: "not-preferred",
      }),
      verdictRecord({ pass: "judge", kept: true, rule: "first-build" }),
      verdictRecord({ pass: "health", head: "a82ee734", worker: "mud", ok: true, kept: true, rule: "starts" }),
      verdictRecord({
        pass: "close",
        head: "a82ee734",
        kept: true,
        rule: "landed",
        landingLine: "made live, a judge preferred it",
      }),
      verdictRecord({ pass: "close", kept: false, rule: "not-landed", notLanded: "does-not-run" }),
      // A game with a repository of its own inside it: the run may not add that folder to the
      // user's history, so the build waits for the button that may (`landBuild`).
      verdictRecord({ pass: "close", kept: false, rule: "not-landed", notLanded: "nested-not-versioned" }),
      // The lead's last edits could not be committed (HQ-2): the land is refused, and says why.
      verdictRecord({ pass: "close", kept: false, rule: "not-landed", notLanded: "final-commit-failed" }),
      // The game folder had uncommitted changes the landing would not merge over (OS5): named, never blamed.
      verdictRecord({ pass: "close", kept: false, rule: "not-landed", notLanded: "uncommitted-changes" }),
      verdictRecord({ pass: "close", kept: false, rule: "not-landed", notLanded: null }),
    ];
    for (const record of records) assertShape(record, record.decision.rule);
    // Every rule reads differently: a shape shared by twelve identical sentences says nothing.
    assert.equal(new Set(records.map((record) => record.because)).size, records.length, "each rule reads differently");
  });

  it("survives the free text a real run hands it", () => {
    for (const text of REAL_FREE_TEXT) {
      for (const rule of ["vetoed", "unfixed", "broken"]) {
        const record = verdictRecord({ pass: "round", kept: false, rule, gap: text });
        assertPlain(record.because, `${rule} on "${text.slice(0, 40)}"`);
      }
      const health = verdictRecord({
        pass: "health",
        ok: false,
        kept: false,
        rule: "does-not-start",
        problems: [text],
      });
      assertPlain(health.because, `health on "${text.slice(0, 40)}"`);
    }
  });

  it("drops a clause that scrubbing left as rubble rather than printing half of it", () => {
    assert.equal(plainClause("regressed state.contact.speedKept, motion-blur-at-speed"), "");
    assert.equal(plainClause("69f573d1a2"), "");
    assert.equal(plainClause("the mud never reaches the tyres"), "the mud never reaches the tyres");
    // A removed id must not leave the preposition that pointed at it behind.
    assert.equal(plainClause("every camera renders black at 69f573d1a2"), "every camera renders black");
  });

  it("reads a round's rule off how it was decided, not off the word 'checks'", () => {
    assert.equal(roundRule({ source: "checks", won: true }), "checks-flipped");
    assert.equal(
      roundRule({ source: "checks", won: false }),
      "checks-regressed",
      "the loop calls a regression a checks verdict too",
    );
    assert.equal(roundRule({ source: "taste", won: true }), "judge-preferred");
    assert.equal(roundRule({ source: "taste", won: false }), "vetoed");
    assert.equal(roundRule({ source: "checks", won: true, satisfied: true }), "satisfied");
    assert.equal(roundRule({ source: "stopped" }), "stopped");
    assert.equal(roundRule({ source: "no-move", won: false }), "no-move");
    assert.equal(
      roundRule({ source: "something-new", won: false }),
      "vetoed",
      "an unknown source is still an undone round",
    );
  });

  it("names what a build was judged against the way its owner would", () => {
    assert.equal(againstWords("start"), "the game you had");
    assert.equal(againstWords("live"), "the game you had");
    assert.equal(againstWords("round"), "the round before");
    assert.equal(againstWords("none"), null);
    assert.equal(againstWords(null), null);
    assert.equal(againstWords("shine", { workerTitle: "Shine" }), "what Shine built");
    assert.equal(againstWords("shine"), "another build");
  });

  it("carries what was looked at, so a record can say more than its verdict", () => {
    const observed = observedFrom({
      ok: true,
      problems: [],
      shots: [{ camera: "default" }, { camera: "arena" }],
      registeredDemos: ["crash"],
      consoleErrors: ["THREE.WebGLProgram: shader error"],
    });
    assert.deepEqual(observed.cameras, ["default", "arena"]);
    assert.deepEqual(observed.demos, ["crash"]);
    assert.equal(observed.consoleFresh.length, 1);
    assert.deepEqual(observedFrom(null).cameras, []);
  });
});

// ── the report the run leaves behind ────────────────────────────────────────────────────

/** A seed loop module and every module under its folder, joined, so a count covers the split. */
function loopTree(module: string, folder: string): string {
  const loop = new URL("../../src/harness-seed/loop/", import.meta.url);
  const nested = readdirSync(new URL(`${folder}/`, loop), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `${folder}/${file}`);
  return [module, ...nested].map((file) => readFileSync(new URL(file, loop), "utf8")).join("\n");
}

describe("one producer, and every path that judges a build calls it", () => {
  it("keeps the five emitters where they are, so a sixth judge cannot answer in its own shape", () => {
    // A worker's judged round and the round the lead stopped mid-build. The facet loop is
    // facet-loop.ts and every module under loop/facet/.
    const facetLoop = loopTree("facet-loop.ts", "facet");
    assert.equal((facetLoop.match(/verdictRecord\(/g) ?? []).length, 2, "the judged round and the stopped round");
    // The lead's four passes, all through the one helper that also puts them on the log. The
    // director is director.ts and every module under director/.
    const director = loopTree("director.ts", "director");
    assert.equal(
      (director.match(/await recordVerdict\(\{/g) ?? []).length,
      4,
      "the fork gate, the judge, the health pass and the close",
    );
    assert.match(
      director,
      /appendRun\(RunEvent\.DirectorVerdict, record\)/,
      "and each reaches the app on the event path",
    );
    // The programmed pipeline, frozen but still judging: its round writes the same record.
    assert.equal(
      (
        readFileSync(new URL("../../src/harness-seed/loop/gauntlet.ts", import.meta.url), "utf8").match(
          /verdictRecord\(/g,
        ) ?? []
      ).length,
      1,
    );
  });
});

describe("the report keeps how a round was judged", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../fixtures/director-loop-run.json", import.meta.url), "utf8"),
  ) as EventEnvelope[];
  const rounds = journal
    .filter((event) => event.data.type === "custom" && event.data.event_type === "facet_iteration")
    .map((event) => (event.data as { payload: Record<string, any> }).payload);

  it("keeps verdictSource and the scoreboard for all twenty-one rounds of the synthetic run", () => {
    assert.equal(rounds.length, 21);
    for (const round of rounds) {
      const digest = iterationDigest(round);
      assert.equal(digest.verdictSource, round.verdictSource, `round ${round.iteration} of ${round.facetId}`);
      assert.ok(digest.verdictSource, "every round says how it was judged");
      assert.ok(digest.scoreboard, "every round keeps what it measured");
      assert.deepEqual(digest.scoreboard!.flips, round.scoreboard.flips);
      assert.equal(digest.scoreboard!.results.length, round.scoreboard.results.length);
    }
    // The synthetic run has ten kept rounds and no stopped rounds.
    assert.equal(rounds.filter((round) => iterationDigest(round).won).length, 10);
  });

  it("keeps a round's own record when it has one, and a truthful digest when it does not", () => {
    const withRecord = iterationDigest({
      ...rounds[0],
      verdict: { because: "Undone: the game did not start after this build." },
    });
    assert.equal(withRecord.verdict!.because, "Undone: the game did not start after this build.");
    assert.equal(iterationDigest(rounds[0]).verdict, null, "the first run wrote none");
    const stopped = iterationDigest({ iteration: 4, verdictSource: "stopped", winner: null, scoreboard: null });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.won, false);
    assert.equal(stopped.scoreboard, null);
  });
});

// ── what the drawer shows ─────────────────────────────────────────────────────────────────

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): EventEnvelope =>
  ({
    id: String(++seq).padStart(6, "0"),
    thread_id: "t",
    created_at: "2026-09-08T20:00:00.000Z",
    data: { type: "custom", event_type: type, payload: { runId: "run_v", ...payload } },
  }) as EventEnvelope;

describe("every round says why, in one sentence", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../fixtures/director-loop-run.json", import.meta.url), "utf8"),
  ) as EventEnvelope[];

  it("gives each of the synthetic run's judged rounds a reason, with no id in it", () => {
    const graph = buildRunGraph(journal)!;
    const judged = graph.nodes.filter(
      (node): node is IterationNode =>
        node.kind === "iteration" && (node.status === "accepted" || node.status === "rolled"),
    );
    assert.equal(judged.length, 21);
    for (const node of judged) {
      // What the drawer prints: the round's own record when it has one, and the mapping from
      // `verdictSource` when it does not — that run wrote no records at all.
      const words = verdictWords({
        winner: node.winner,
        satisfied: node.satisfied,
        source: node.verdictSource,
        record: node.verdict,
      });
      assert.ok(["kept", "undone", "done"].includes(words.word), `${node.id}: ${words.word}`);
      assertPlain(`${words.because.charAt(0).toUpperCase()}${words.because.slice(1)}.`, node.id);
      assert.ok(undoneBecause(node.verdictSource, node.verdict).length > 8, node.id);
    }
  });

  it("prefers the sentence the judge wrote to the mapping, and keeps the round's own word", () => {
    const record = verdictRecord({
      pass: "round",
      kept: true,
      flips: ["a", "b"],
      rule: roundRule({ source: "checks", won: true }),
    });
    const words = verdictWords({ winner: "challenger", satisfied: false, source: "checks", record });
    assert.equal(words.word, "kept");
    assert.equal(words.label, "Kept: 2 checks that were failing now pass, and the reviewer did not object.");
    assert.equal(words.because, "2 checks that were failing now pass, and the reviewer did not object");
    // Without a record the older mapping still answers.
    assert.equal(
      verdictWords({ winner: "challenger", satisfied: false, source: "checks" }).because,
      "the checks it was given now pass, and no reviewer objected",
    );
    // An undone round's card asks only for the reason, and gets the written one.
    const undone = verdictRecord({
      pass: "round",
      kept: false,
      rule: "vetoed",
      gap: "the mud never reaches the tyres",
    });
    assert.equal(
      undoneBecause("taste-veto", undone),
      "the reviewer preferred the round before — the mud never reaches the tyres",
    );
  });

  it("counts only the checks a part was planned against as a round's gains", () => {
    const grown = { id: "judge-1", kind: "vision", pass: true, reason: "" };
    const planned = { id: "state.mud.visible", kind: "probe", pass: true, reason: "" };
    const verdict = verdictRecord({
      pass: "round",
      kept: true,
      rule: "checks-flipped",
      planned: [planned],
      grown: [grown],
      flips: ["state.mud.visible", "judge-1"],
    });
    const graph = buildRunGraph([
      event("run_started", { project: "p" }),
      event("autopilot_started", { director: true }),
      event("facet_iteration", {
        facetId: "mud",
        facetTitle: "Mud",
        iteration: 1,
        winner: "challenger",
        verdictSource: "checks",
        scoreboard: {
          total: 2,
          passing: 2,
          unmeasured: 0,
          flips: ["state.mud.visible", "judge-1"],
          regressions: [],
          results: [],
        },
        verdict,
      }),
    ])!;
    const node = graph.nodes.find((item): item is IterationNode => item.kind === "iteration")!;
    assert.deepEqual(
      node.scoreboard!.flips,
      ["state.mud.visible", "judge-1"],
      "the board keeps both, as it always did",
    );
    assert.deepEqual(plannedFlips(node), ["state.mud.visible"], "the card counts one");
    // A run with no record keeps every flip: nothing there can tell them apart.
    const older = buildRunGraph([
      event("run_started", { project: "p" }),
      event("facet_iteration", {
        facetId: "mud",
        iteration: 1,
        winner: "challenger",
        verdictSource: "checks",
        scoreboard: { total: 2, passing: 2, flips: ["a", "b"], regressions: [], results: [] },
      }),
    ])!;
    assert.equal(plannedFlips(older.nodes.find((item): item is IterationNode => item.kind === "iteration")!).length, 2);
  });
});

describe("the build box shows the last look at the build, not a line about the run", () => {
  it("takes the newest verdict for the merged head, and falls back when a run has none", () => {
    const base = [event("run_started", { project: "p" }), event("autopilot_started", { director: true })];
    const bare = buildRunGraph(base)!;
    assert.deepEqual(bare.verdicts, []);
    assert.equal(buildVerdictLine(bare), null, "nothing has been judged yet");
    assert.ok(buildProgress(bare).health.length > 0, "so the phase line still speaks");

    const graph = buildRunGraph([
      ...base,
      event(
        "director_verdict",
        verdictRecord({
          pass: "gate",
          head: "aaaa1111bb",
          worker: "mud",
          ok: true,
          kept: true,
          rule: "starts",
        }) as never,
      ),
      event("integration_merge", { facetId: "mud", head: "bbbb2222cc", conflict: false }),
      event(
        "director_verdict",
        verdictRecord({
          pass: "health",
          head: "bbbb2222cc",
          worker: "mud",
          ok: true,
          kept: true,
          rule: "starts",
        }) as never,
      ),
      event(
        "director_verdict",
        verdictRecord({
          pass: "judge",
          head: "bbbb2222cc",
          against: againstWords("start"),
          pick: "challenger",
          kept: true,
          rule: "preferred",
        }) as never,
      ),
    ])!;
    assert.equal(graph.verdicts.length, 3, "every look the lead took");
    assert.equal(headVerdict(graph)!.pass, "judge", "the newest look at the build on the stage");
    assert.equal(buildVerdictLine(graph), "The reviewer preferred it to the game you had.");
    assertPlain(buildVerdictLine(graph)!, "the build box");

    // A verdict about an older head is not the head's verdict.
    const stale = buildRunGraph([
      ...base,
      event("integration_merge", { facetId: "mud", head: "bbbb2222cc", conflict: false }),
      event(
        "director_verdict",
        verdictRecord({ pass: "health", head: "bbbb2222cc", ok: true, kept: true, rule: "starts" }) as never,
      ),
      event(
        "director_verdict",
        verdictRecord({
          pass: "judge",
          head: "aaaa1111bb",
          pick: "incumbent",
          against: againstWords("start"),
          kept: true,
          rule: "not-preferred",
        }) as never,
      ),
    ])!;
    assert.equal(headVerdict(stale)!.pass, "health");
  });

  it("ignores a payload with no sentence, so a half-written event never blanks the box", () => {
    const graph = buildRunGraph([
      event("run_started", { project: "p" }),
      event("director_verdict", { pass: "judge", head: "aaaa1111bb" }),
    ])!;
    assert.deepEqual(graph.verdicts, []);
    assert.equal(buildVerdictLine(graph), null);
  });
});

// ── the run itself ──────────────────────────────────────────────────────────────────────

/**
 * One short run through the real core and the real harness child: a worker is started (the
 * fork gate looks), its commit is merged (the health pass looks), the merged build is judged,
 * and the run is closed (the landing). All four of the lead's passes must reach the log as
 * `director_verdict`, in the one shape, each with a sentence the app can print as it stands.
 */
describe("every pass of a real run writes one", () => {
  const rigs: Rig[] = [];
  after(async () => {
    await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
  });

  it("emits a gate, a health pass, a judge, the close's own judge and a close — same shape, plain sentences", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("verdict-run", { title: "Verdict run" });
    const trace: Array<{ tool: string; result: unknown }> = [];
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
      delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
        if (request.director) {
          const call = async (name: string, args: Record<string, unknown>) => {
            const result = await request.onLiveTool!(name, args);
            trace.push({ tool: name, result });
            return result;
          };
          // A run says what it is for before a builder starts (M3.8).
          await call("plan", {
            summary: "This run: a red plaza.",
            workers: JSON.stringify([
              {
                id: "plaza",
                title: "Plaza",
                seam: "the plaza",
                owns: "src/plaza.js",
                done: ["the plaza is red"],
                minutes: 5,
              },
            ]),
          });
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          });
          for (let i = 0; i < 30; i++) {
            const waited = JSON.parse(String(await call("wait", { seconds: "5", worker: "plaza" })));
            if (waited.status.workers[0]?.state !== "running") break;
          }
          await call("integrate", { worker: "plaza" });
          await call("judge", { target: "integration", against: "none" });
          await call("finish", { summary: "the plaza is red", land: "yes", victory: "no" });
          return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "director-1", summary: "run done" };
        }
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
        return {
          ok: true,
          engine: "codex",
          turns: 2,
          usage: {},
          sessionId: "worker-1",
          summary: "painted the plaza red",
        };
      },
    } as never);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "the run to close",
    );

    const verdicts = customEvents(events, "director_verdict").filter((e) => e.runId === runId);
    // Flipped (the close's judge): the lead's judge only looked (against=none), so the close judges
    // the head it makes live against the start before it lands — a fifth pass.
    assert.deepEqual(
      verdicts.map((verdict) => verdict.pass),
      ["gate", "health", "judge", "judge", "close"],
      `the five passes, in the order they looked: ${JSON.stringify(verdicts.map((v) => [v.pass, (v as { decision: { rule: string } }).decision?.rule]))}; tool trace: ${JSON.stringify(trace)}; decisions: ${JSON.stringify(customEvents(events, "autopilot_decision"))}`,
    );
    for (const verdict of verdicts) assertShape(verdict as Record<string, any>, `${verdict.pass} of the run`);
    const byPass = Object.fromEntries(
      verdicts.map((verdict) => [String(verdict.pass), verdict as Record<string, any>]),
    );
    assert.equal(byPass.gate.decision.kept, true, "the scaffold the worker forked from runs");
    assert.equal(byPass.gate.build.worker, "plaza");
    assert.equal(byPass.health.decision.kept, true, JSON.stringify(byPass.health.observed.problems));
    assert.ok(byPass.health.observed.cameras.length >= 1, "the health pass photographed it");
    const [leadJudge, closeJudge] = verdicts.filter((verdict) => verdict.pass === "judge") as Array<
      Record<string, any>
    >;
    assert.ok(leadJudge && closeJudge, "the lead's judge and the close's");
    assert.equal(leadJudge.decision.rule, "starts", "against=none: it was looked at, not preferred");
    assert.equal(leadJudge.decision.kept, null, "a pass that only looked decides nothing");
    const landedHead = (
      customEvents(events, "run_finished").find((e) => e.runId === runId) as { integrationHead: string }
    ).integrationHead;
    assert.equal(closeJudge.build.head, landedHead, "the close judged the head it made live");
    assert.equal(closeJudge.seen.judgeCalls, 1, "blind, against the game the user had");
    assert.equal(byPass.close.decision.rule, "landed");
    assert.equal(byPass.close.build.head, landedHead);

    // The same records survive into the report, and the run's own graph can show the newest.
    const report = customEvents(events, "run_finished").find((e) => e.runId === runId) as {
      verdicts: Array<Record<string, any>>;
    };
    assert.equal(report.verdicts.length, verdicts.length);
    const graph = buildRunGraph(
      await rig.core
        .listAllEvents()
        .then((log) =>
          log.filter((e) => e.data.type === "custom" && (e.data.payload as { runId?: string })?.runId === runId),
        ),
    )!;
    assert.equal(graph.verdicts.length, 5);
    assert.equal(headVerdict(graph)!.pass, "close", "the last word on the build that landed");
    assertPlain(buildVerdictLine(graph)!, "the build box of a finished run");
  });
});
