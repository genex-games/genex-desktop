/**
 * Words — the app's one vocabulary.
 *
 * Two kinds of test live here. The first is ordinary: a harness phrase goes in, the sentence a
 * non-technical owner reads comes out. The second is a gate: the harness's own status lines are
 * read out of `src/harness-seed/loop/*.ts` and every one of them must survive translation
 * without leaking a run id or a commit sha, and no renderer file except `words.ts` may hold a
 * translation of its own. That is what stops the vocabulary drifting back into the panels.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  autopilotStartWords,
  backgroundCount,
  BUILD_HISTORY_WORDS,
  FINISH_CHECK_WORDS,
  JOBS_EYEBROW,
  JOBS_WORDS,
  LEAD_WORDS,
  TURN_WORDS,
  WORKER_LINE_WORDS,
  WORKER_STOP_WORDS,
  WORKER_WORDS,
  workersOnIt,
  checkCounts,
  checkReplanWords,
  circuitBreakWords,
  connectorStepWords,
  consentAskWords,
  decisionWords,
  fixWords,
  flagWords,
  isKept,
  isPlanning,
  livenessWords,
  liveBehindLabel,
  liveBehindWords,
  modelWords,
  moveWords,
  loopRunWords,
  outageWords,
  pausedWords,
  planReviewWords,
  pluginToolWords,
  problemWords,
  ranToItsEnd,
  resumedWords,
  runIdIn,
  runStartWords,
  sideBySideWords,
  statusWords,
  stoppedWords,
  toolGroupHeader,
  toolWords,
  undoneBecause,
  verdictLabel,
  verdictSentence,
  verdictWords,
  withoutIds,
} from "../../src/renderer/words.ts";
import { morningWords } from "../../src/renderer/morning-words.ts";
import { LeadFace, leadAbout } from "../../src/renderer/run-tree.ts";
import { endedWords } from "../../src/renderer/round-status.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { DirectorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { WorkerTool } from "../../src/shared/workers.ts";
import { APP_LOOK_TOOL_NAME, JobTool } from "../../src/shared/jobs.ts";
import { connectorStep, showsPlayView, StepAction } from "../../src/renderer/chat/connector-steps.ts";
import type { RunSummary } from "../../src/shared/run-summary.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

const RUN_ID = /run_[0-9a-z]/i;
const SHA = /\b[0-9a-f]{40}\b/i;
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The `ctx.setStatus` calls whose argument is not one plain string literal — a ternary, a
 * variable — written out by hand so this gate still sees them. Adding a call the collector below
 * cannot read fails the count assertion rather than being skipped in silence.
 */
const COMPUTED_STATUSES: Record<string, string[][]> = {
  // one entry per unreadable call site; its strings are that site's own branches
  // evidence.ts's evidence retry writes its two branches inside the template, quotes and all
  "evidence.ts": [
    [
      "the page was not up yet — retrying evidence in ${Math.round(delay / SECOND_MS)}s (${evidence.problems[0]})",
      "observation outage — retrying evidence in ${Math.round(delay / SECOND_MS)}s (${evidence.problems[0]})",
    ],
  ],
};

/** Every `setStatus(...)` the harness can emit, with its placeholders filled in. */
function emittedStatuses(): string[] {
  const dir = path.join(root, "src/harness-seed/loop");
  const samples: Array<[RegExp, string]> = [
    [/runId/, "run_fixture123456"],
    [/facet\.title|target\.label/, "Crash damage"],
    [/iteration/, "3"],
    [/candidate\.id/, "state.contact.speedKept"],
    [/skill\.slug/, "run-brief"],
    [/skills\.length|index/, "2"],
    [/Math\./, "30"],
  ];
  const fill = (template: string): string =>
    template.replace(/\$\{([^}]*)\}/g, (_, expression: string) => {
      for (const [pattern, value] of samples) if (pattern.test(expression)) return value;
      return "something";
    });
  const found: string[] = [];
  // The loop's own folders too (director/): a status written there is on the same screen.
  for (const file of readdirSync(dir, { recursive: true }).map(String)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(path.join(dir, file), "utf8");
    // `setStatus\??\(` never matched the optional-call form the seed mostly uses — `\??` ate the
    // `?` and `\(` then had to match the `.` — so six statuses were collected by nobody.
    const literals = [...source.matchAll(/\bctx\??\.setStatus(?:\?\.)?\(\s*[`"']([^`"']*)[`"']\s*,?\s*\)/g)];
    for (const match of literals) found.push(fill(match[1]!));
    const calls = (source.match(/\bctx\??\.setStatus(?:\?\.)?\(/g) ?? []).length;
    const named = COMPUTED_STATUSES[file] ?? [];
    assert.equal(
      calls - literals.length,
      named.length,
      `${file}: a ctx.setStatus call this gate cannot read — add its templates to COMPUTED_STATUSES`,
    );
    for (const template of named.flat()) found.push(fill(template));
  }
  return found;
}

/** Every renderer source file — the gate below has to see all of them, not a hand-kept list. */
function rendererFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(root, "src/renderer"));
  return out;
}

describe("background work", () => {
  it("counts background work as running and finished, leaving out a zero", () => {
    assert.equal(backgroundCount(1, 2), "1 running · 2 finished");
    assert.equal(backgroundCount(0, 2), "2 finished");
    assert.equal(backgroundCount(1, 0), "1 running");
  });
});

describe("the lead, its workers and the finish check on the graph", () => {
  /** Every string a table holds, its functions called with a sample. */
  const said = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value === "function") return [String(value("Unreal"))];
    if (value && typeof value === "object") return Object.values(value).flatMap(said);
    return [];
  };

  it("no worker, lead, job, finish check, history or chat turn word names how a worker works", () => {
    const words = said([
      WORKER_WORDS,
      WORKER_LINE_WORDS,
      WORKER_STOP_WORDS,
      LEAD_WORDS,
      JOBS_EYEBROW,
      JOBS_WORDS,
      FINISH_CHECK_WORDS,
      BUILD_HISTORY_WORDS,
      BUILD_HISTORY_WORDS.turnFrom("Monday"),
      BUILD_HISTORY_WORDS.loopFrom(BUILD_HISTORY_WORDS.yesterday),
      TURN_WORDS,
      workersOnIt(3),
    ]);
    assert.ok(words.length > 20, "the tables were read");
    const forbidden =
      /\b(reader|writer|editor|copy|lock|merged?|isolation|sandbox|seat|sub-agents?|helper|night|overnight|morning|tonight)\b|\bbuild \d/i;
    assert.deepEqual(
      words.filter((text) => forbidden.test(text)),
      [],
    );
    assert.equal(workersOnIt(1), "1 worker on it");
    assert.equal(WORKER_WORDS.workingIn("Unreal"), "Working in Unreal");
  });
});

describe("the lead's card", () => {
  it("in a tree, the lead at work never says nothing works, and names workers; a graph that is no tree keeps its words", () => {
    const inTree = leadAbout(LeadFace.Working, true);
    assert.doesNotMatch(inTree, /no part|nothing/i);
    assert.doesNotMatch(inTree, /\bparts?\b/i);
    assert.match(inTree, /\bworker\b/);
    assert.equal(leadAbout(LeadFace.Working, false), LEAD_WORDS.about.working, "old logs read as they did");
    for (const face of Object.values(LeadFace).filter((face) => face !== LeadFace.Working))
      assert.equal(leadAbout(face, true), LEAD_WORDS.about[face], face);
  });
});

describe("statusWords", () => {
  it("says what the lead is doing, never which run it is doing it in", () => {
    const run = "run run_fixture123456";
    assert.deepEqual(statusWords(`${run} · director`), {
      line: "The lead is watching the workers",
      short: "The lead",
    });
    assert.deepEqual(statusWords(`${run} · director judging Crash damage`), {
      line: "The lead is reviewing Crash damage",
      short: "Reviewing Crash damage",
    });
    assert.deepEqual(statusWords(`${run} · director playtesting Crash damage`), {
      line: "The lead is playing Crash damage",
      short: "Playing Crash damage",
    });
    // Flipped: no time-of-day words in the app's copy.
    assert.deepEqual(statusWords(`${run} · director finishing`), {
      line: "The lead is finishing the build",
      short: "Finishing",
    });
  });

  it("gives a builder its own title and a round number, not an iteration", () => {
    const run = "run run_fixture123456";
    assert.deepEqual(statusWords(`${run} · Crash damage — iteration 3`), {
      line: "Crash damage · round 3",
      short: "Crash damage · round 3",
    });
    assert.deepEqual(statusWords(`${run} · Crash damage — spike on state.contact.speedKept`), {
      line: "Crash damage · a focused fix for one check",
      short: "Crash damage · fixing",
    });
    assert.deepEqual(statusWords(`${run} · Crash damage — verifying`), {
      line: "Crash damage · checking the round",
      short: "Crash damage · checking",
    });
    assert.equal(
      statusWords(`${run} · Crash damage — provider overloaded, retrying in 30s`).line,
      "Crash damage · the model is busy — trying again in 30s",
    );
  });

  it("translates the run stages and the chat's own work", () => {
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(statusWords("run run_x").line, "The build is running");
    assert.equal(statusWords("run run_x · building the shared base").line, "Building the starting point");
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(statusWords("run run_x · integrating facets").line, "Putting the parts together");
    assert.equal(statusWords("run run_x · iteration 4 — judging blind").line, "Round 4 · reviewing");
    assert.equal(statusWords("thinking").line, "Thinking");
    assert.equal(statusWords("self-improving · run-brief (2/4)").line, "Improving its own craft · run-brief (2/4)");
    assert.equal(statusWords("self-improving · run-brief (2/4)").short, "Improving");
    assert.deepEqual(statusWords("idle"), { line: "", short: "" });
    assert.deepEqual(statusWords(""), { line: "", short: "" });
  });

  it("keeps a rail chip short enough for a 220px rail", () => {
    const long = statusWords("run run_x · A very long part title indeed — iteration 12");
    assert.ok(long.short.length <= 24, long.short);
    assert.match(long.short, /…$/);
  });

  it("strips an identifier even out of a phrase it does not recognise", () => {
    const words = statusWords(
      "run run_fixture123456 · reconciling 5719bbb1a4c0de9f2b3a41d0e7c8a95612ff3ab7 — iteration 2",
    );
    assert.doesNotMatch(words.line, RUN_ID);
    assert.doesNotMatch(words.line, SHA);
    assert.equal(withoutIds("landed run_abc (5719bbb1a4c0de9f2b3a41d0e7c8a95612ff3ab7)"), "landed");
  });

  it("strips the short shas the harness actually prints, and leaves ordinary words alone", () => {
    // Every sha the harness puts in free text is `slice(0, 10)` or `slice(0, 8)`; a 12-character
    // floor never fired once.
    assert.equal(withoutIds("the build at 69f573d1a2 does not run"), "the build at does not run");
    assert.equal(withoutIds("base a82ee734 was rebuilt"), "base was rebuilt");
    assert.equal(withoutIds("kept unlanded on refs/studio/runs/run_fixture123456/integration"), "kept unlanded on");
    for (const ordinary of ["defaced", "facade", "20260908", "added"]) {
      assert.equal(withoutIds(`the ${ordinary} thing`), `the ${ordinary} thing`, ordinary);
    }
  });

  it("keeps a part's own dash out of the phase it is doing", () => {
    // Facet titles are free text the lead invents; a non-greedy split cut this one in half and
    // let "iteration 3" reach the titlebar — the one word the module exists to remove.
    const words = statusWords("run run_fixture123456 · Crash damage — deformation — iteration 3");
    assert.equal(words.line, "Crash damage — deformation · round 3");
    assert.doesNotMatch(words.line, /iteration/i);
    // The run's two first steps, said as what they are for (M1.3, M2.6) — never as a stage name.
    assert.equal(statusWords("run run_x · building the starting point").short, "Starting point");
    assert.deepEqual(statusWords("run run_x · making the game judgeable"), {
      line: "Connecting your game to the studio",
      short: "Connecting",
    });
    const verifying = statusWords("run run_x · Dirt: mud — tyre dust — verifying");
    assert.equal(verifying.line, "Dirt: mud — tyre dust · checking the round");
    // A phase this module does not know is dropped rather than printed raw.
    assert.doesNotMatch(statusWords("run run_x · Crash damage — deformation — iteration 12").line, /iteration/i);
  });

  it("carries no identifier for any status the harness can emit", () => {
    const statuses = emittedStatuses();
    assert.ok(statuses.length >= 20, `expected the seed's setStatus calls, found ${statuses.length}`);
    for (const status of statuses) {
      const words = statusWords(status);
      assert.doesNotMatch(words.line, RUN_ID, status);
      assert.doesNotMatch(words.short, RUN_ID, status);
      assert.doesNotMatch(words.line, SHA, status);
      assert.doesNotMatch(words.short, SHA, status);
      assert.doesNotMatch(words.line, /^run\b/i, status);
      assert.doesNotMatch(words.short, /^run\b/i, status);
      assert.ok(words.short.length <= 24, `${status} → ${words.short}`);
    }
  });
});

describe("how a run reads when it is over", () => {
  it("says what became of the build, not whether a flag was set", () => {
    // The first real run landed nothing and read "Stopped after 21 rounds"; a run that
    // lands its build read the same, because `victory` is a claim the lead rarely makes.
    assert.equal(loopRunWords({ rounds: 21, landed: true }).headline, "Finished after 21 rounds · live in your game");
    assert.equal(
      loopRunWords({
        rounds: 21,
        landed: false,
        stoppedBecause: "the session limit was reached; nothing was landed (land=no)",
      }).headline,
      "Finished after 21 rounds · not made live yet",
    );
    assert.match(loopRunWords({ rounds: 21, landed: false, stoppedBecause: "land=no" }).because, /kept and playable/);
    assert.match(loopRunWords({ rounds: 1, landed: true }).headline, /after 1 round ·/);
    // An older log says nothing about landing: the headline claims nothing either.
    assert.equal(
      loopRunWords({ rounds: 3, landed: null, stoppedBecause: "autopilot finished" }).headline,
      "Finished after 3 rounds",
    );
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(
      loopRunWords({ rounds: 3, landed: null, stoppedBecause: "autopilot finished" }).because,
      "The build finished.",
    );
    assert.equal(loopRunWords({ rounds: 0, landed: null }).headline, "Finished");
    assert.doesNotMatch(
      loopRunWords({ rounds: 2, landed: false, stoppedBecause: "the director failed on run_fixture123456" }).because,
      RUN_ID,
    );
  });

  it("promises a playable build only when there is one", () => {
    // A run that merged nothing (an early stop, an unhealthy integration) used to read
    // "The build is kept and playable" over a card with no button on it at all.
    const nothing = loopRunWords({
      rounds: 4,
      landed: false,
      hasBuild: false,
      stoppedBecause: "the director ran out of time without calling finish; nothing was landed (land=no)",
    });
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(nothing.headline, "Finished after 4 rounds · nothing new");
    assert.doesNotMatch(nothing.because, /playable/);
    assert.match(nothing.because, /as you left it/);
    assert.match(
      loopRunWords({ rounds: 4, landed: false, hasBuild: true, stoppedBecause: "land=no" }).because,
      /kept and playable/,
    );
  });

  it("calls a paused run paused, and says it can be picked up", () => {
    // The engine's session limit ends the run at 105 minutes with `run_finished` + paused.
    const paused = loopRunWords({
      rounds: 21,
      landed: false,
      paused: true,
      hasBuild: true,
      stoppedBecause:
        "the engine hit its session limit before the director called finish (rate limit reached); the run is paused — Resume it when the limit resets; nothing was landed (land=no)",
    });
    assert.equal(paused.headline, "Paused after 21 rounds");
    assert.doesNotMatch(paused.headline, /Finished/);
    assert.match(paused.because, /limit/);
    assert.match(paused.because, /kept/);
  });

  it("tells the owner what to fix when the provider stopped accepting the account, from the close's typed kind", () => {
    // A provider that took the account's access away ("Your organization has disabled Claude
    // subscription access…").
    const lost = loopRunWords({
      rounds: 5,
      landed: false,
      paused: true,
      hasBuild: true,
      pausedOn: "auth",
      stoppedBecause:
        "the engine lost its sign-in before the director called finish (Your organization has disabled Claude subscription access for Claude Code); the run is paused — sign in again (or have the admin turn access back on), then Resume; nothing was landed (the run paused on its provider; nothing is made live that nobody could check)",
    });
    assert.equal(lost.headline, "Paused after 5 rounds");
    assert.match(lost.because, /stopped accepting this account/);
    assert.match(lost.because, /sign in again/i);
    assert.match(lost.because, /Resume/);
    assert.doesNotMatch(lost.because, /director|engine|nobody could check/);
    const down = loopRunWords({ rounds: 5, landed: false, paused: true, hasBuild: true, pausedOn: "unavailable" });
    assert.match(down.because, /model provider stayed down/);
    for (const words of [lost, down]) assert.doesNotMatch(words.because, /\b(night|morning|overnight|tonight)\b/i);
    // The close's typed kind reaches the card: the chat's result entry carries it to the card's words.
    const closed: EventEnvelope = {
      id: "e1",
      thread_id: "t",
      session_id: null,
      turn_id: null,
      created_at: "2026-10-06T11:08:17.000Z",
      data: {
        type: "custom",
        event_type: "run_finished",
        payload: { runId: "run_a", executionStatus: "paused", landed: false, limit: { kind: "auth", message: "x" } },
      },
    };
    const card = toEntries([closed]).find((entry) => entry.kind === "morning");
    assert.equal(card?.kind === "morning" ? card.pausedOn : null, "auth");
    const words = morningWords({
      rounds: 0,
      kept: 0,
      undone: 0,
      landed: false,
      paused: true,
      hasBuild: false,
      pausedOn: "auth",
    });
    assert.match(words.because, /stopped accepting this account/);
  });

  it("does not tell the owner a run they stopped simply finished", () => {
    const stopped = loopRunWords({ rounds: 6, landed: false, hasBuild: true, stoppedBecause: "stopped by the user" });
    assert.equal(stopped.headline, "Stopped after 6 rounds · the build so far is kept");
    assert.equal(stopped.because, "Stopped. Everything built so far is kept.");
    // A stop the run can pick up again reads the same way — one word, not "paused" and "stopped".
    const resumable = loopRunWords({
      rounds: 6,
      landed: false,
      paused: true,
      hasBuild: true,
      stoppedBecause: "stopped by the user",
    });
    assert.equal(resumable.because, "Stopped. Everything built so far is kept.");
    assert.doesNotMatch(resumable.headline, /Paused/);
    assert.equal(
      loopRunWords({ rounds: 6, landed: false, hasBuild: false, stoppedBecause: "stopped by the user" }).headline,
      "Stopped after 6 rounds",
    );
  });
});

describe("the morning card", () => {
  const loopRun = (over: Partial<Parameters<typeof morningWords>[0]> = {}) =>
    morningWords({
      rounds: 21,
      kept: 10,
      undone: 11,
      landed: false,
      paused: false,
      hasBuild: true,
      stoppedBecause: "land=no",
      summary: null,
      ...over,
    });

  it("offers Play it, and says the run's own report, when the build is live", () => {
    const words = loopRun({
      landed: true,
      hasBuild: false,
      summary: "The river catches the light and moves.",
      landingLine: "made live, not judged better",
      stoppedBecause: "the director finished the run",
    });
    assert.match(words.headline, /live in your game/);
    assert.deepEqual(words.actions, ["play"]);
    assert.equal(words.summary, "The river catches the light and moves.");
    assert.equal(words.noReport, null);
    // The close's own sentence, not a flat promise: a build no judge preferred must not read
    // like one a judge chose.
    assert.match(words.because, /Made live, not reviewed better/);
    assert.equal(words.tally, "10 kept · 11 undone");
    const judged = loopRun({
      landed: true,
      hasBuild: false,
      landingLine: "made live, a judge preferred it",
      stoppedBecause: "the director finished the run",
    });
    assert.match(judged.because, /a reviewer preferred it/);
    // An older run wrote no landing sentence: the card keeps the plain one.
    const older = loopRun({ landed: true, hasBuild: false, stoppedBecause: "the director finished the run" });
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(older.because, "This build is your game now — open Live to play it.");
  });

  it("offers the build itself when the run merged one but did not make it live", () => {
    const words = loopRun();
    assert.deepEqual(words.actions, ["play-build"]);
    assert.match(words.because, /kept and playable/);
  });

  it("offers nothing, and promises nothing, when the run merged nothing", () => {
    const words = loopRun({ hasBuild: false });
    assert.deepEqual(words.actions, []);
    assert.doesNotMatch(words.because, /playable/);
  });

  it("puts Resume first on a paused run, and never calls it finished", () => {
    const words = loopRun({
      paused: true,
      stoppedBecause:
        "the engine hit its usage cap before the director called finish (limit reached); the run is paused — Resume it when the limit resets; nothing was landed (land=no)",
    });
    assert.equal(words.actions[0], "resume");
    assert.doesNotMatch(words.headline, /Finished/);
    assert.match(words.headline, /^Paused/);
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(words.noReport, "It was paused before it could write up the build.");
  });

  it("says the run wrote no report rather than printing the lead's own note", () => {
    const words = loopRun();
    assert.equal(words.summary, null);
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(words.noReport, "It ended before it could write up the build.");
  });

  it("reads a run the owner stopped as stopped", () => {
    const words = loopRun({ stoppedBecause: "stopped by the user" });
    assert.match(words.headline, /^Stopped after 21 rounds/);
    assert.deepEqual(words.actions, ["play-build"]);
  });
});

describe("reading a harness status", () => {
  it("names the run a status belongs to, and the stage before any part exists", () => {
    assert.equal(runIdIn("run run_fixture123456 · planning facets"), "run_fixture123456");
    assert.equal(runIdIn("thinking"), null);
    assert.equal(isPlanning("run run_fixture123456 · planning facets"), true);
    assert.equal(isPlanning("run run_fixture123456 · director"), false);
    assert.equal(isPlanning("idle"), false);
  });
});

describe("verdicts", () => {
  it("says kept or undone, and why, in one sentence", () => {
    assert.deepEqual(verdictWords({ winner: "challenger", source: "checks" }), {
      word: "kept",
      because: "the checks it was given now pass, and no reviewer objected",
      label: "kept — the checks it was given now pass, and no reviewer objected",
    });
    assert.equal(
      verdictWords({ winner: "challenger", source: "taste" }).because,
      "the reviewer preferred it to the round before",
    );
    assert.equal(verdictWords({ winner: "challenger", satisfied: true }).word, "done");
    assert.equal(
      verdictWords({ winner: "incumbent", source: "taste-veto" }).because,
      "the reviewer preferred the round before",
    );
    assert.equal(verdictWords({ winner: "incumbent", source: "invisible" }).because, "nothing visible changed");
    assert.equal(verdictWords({ winner: "incumbent", source: "unfixed" }).because, "the must-fix was not fixed");
    // A round the lead stopped is not undone (M1.4): no judge saw it, and the builder's work
    // was committed, not rolled back — so it gets its own word, not "undone".
    assert.equal(verdictWords({ winner: null, source: "stopped" }).word, "stopped");
    assert.match(verdictWords({ winner: null, source: "stopped" }).because, /the work it had done is kept/);
    assert.equal(verdictWords({ winner: "incumbent", source: null }).word, "undone");
    assert.equal(verdictLabel("incumbent", false, "no-move"), "undone — the step it was asked for was not delivered");
    // The graph card already says "Undone"; it wants the reason on its own.
    assert.equal(undoneBecause("broken"), "the build was broken");
    assert.equal(undoneBecause(null), "it was not clearly better than the round before");
  });

  it("says the harness's judge as the app's reviewer, and leaves the verb alone", () => {
    // The harness and its models keep "judge"; only what the app shows is reworded.
    assert.equal(
      verdictSentence({ because: "Kept: no check moved, but the judge preferred it to the round before." }),
      "Kept: no check moved, but the reviewer preferred it to the round before.",
    );
    assert.equal(verdictSentence({ because: "The judge preferred it." }), "The reviewer preferred it.");
    assert.equal(
      verdictSentence({ because: "Undone: the taste judge's notes and the judges' ledger agree." }),
      "Undone: the taste reviewer's notes and the reviewers' ledger agree.",
    );
    const verb = decisionWords("the director must fix it or judge it before it can land");
    assert.match(verb, /fix it or judge it/, "a verb is not a role");
    assert.match(decisionWords("no judge had passed it"), /^no reviewer had passed it$/);
  });

  it("passes a record's own sentence through the same gate as every other phrase", () => {
    // `loop/verdict.ts` writes this sentence out of the run's own material, so it can carry an
    // id the way a facet title can. The three surfaces that print it read it through here.
    const record = { because: "Kept: 2 checks that were failing now pass at 5719bbb111 on run_fixture123456." };
    assert.doesNotMatch(verdictSentence(record), RUN_ID);
    assert.doesNotMatch(verdictSentence(record), /5719bbb111/);
    assert.equal(verdictSentence(null), "");
    assert.equal(verdictSentence({ because: null }), "");
    const kept = verdictWords({ winner: "challenger", source: "checks", record });
    assert.equal(kept.word, "kept");
    assert.doesNotMatch(kept.label, RUN_ID);
    assert.doesNotMatch(kept.because, /5719bbb111/);
    // The card that already says "Undone" gets the reason with the record's own word taken off.
    assert.equal(undoneBecause("broken", { because: "Undone: the build did not load." }), "the build did not load");
  });

  it("never says a rolled-back round was kept", () => {
    assert.equal(isKept("challenger"), true);
    assert.equal(isKept("incumbent"), false);
    assert.equal(isKept(null), false);
    // The Runs strip used to label an undone round "Kept" because the harness had kept the
    // incumbent. From the user's side that is the opposite of what happened.
    assert.equal(verdictWords({ winner: "incumbent" }).word, "undone");
  });

  it("says what the side-by-side judge did with the round", () => {
    assert.equal(sideBySideWords({ status: "building", satisfied: false, source: null }), "");
    assert.equal(
      sideBySideWords({ status: "rolled", satisfied: false, source: "taste-veto" }),
      "The reviewer preferred the round before.",
    );
    assert.equal(
      sideBySideWords({ status: "rolled", satisfied: false, source: "checks" }),
      "Not needed — the round was undone on the checks.",
    );
    assert.equal(
      sideBySideWords({ status: "accepted", satisfied: false, source: "checks" }),
      "No objection to the new build.",
    );
    assert.equal(
      sideBySideWords({ status: "accepted", satisfied: true, source: "taste" }),
      "The reviewer is satisfied with this part.",
    );
  });

  it("turns the harness's stop reasons into plain ones", () => {
    assert.equal(stoppedWords("stopped by the user"), "you stopped it");
    assert.equal(stoppedWords("finishing the current work at the user’s request"), "you asked it to wrap up");
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(stoppedWords("the director finished the run"), "the lead finished the build");
    // Flipped: no time-of-day words in the app's copy.
    assert.equal(stoppedWords("autopilot finished"), "the build finished");
    assert.equal(stoppedWords(""), "it finished");
    assert.doesNotMatch(stoppedWords("the director failed on run_fixture123456"), RUN_ID);
  });

  it("keeps why the run ended when the landing clause is appended to it", () => {
    // Every close composes "<why>; <what happened to the build>". Matching the landing half
    // anywhere in the string collapsed every non-landing run to four words and deleted the
    // half a user can act on.
    assert.equal(
      stoppedWords("the director ran out of time without calling finish; nothing was landed (land=no)"),
      "it ran out of time",
    );
    assert.match(
      stoppedWords(
        "the engine hit its session limit before the director called finish (429 too many requests); the run is paused — Resume it when the limit resets; nothing was landed (land=no)",
      ),
      /limit/,
    );
    assert.equal(
      stoppedWords("the director's session ended (failed) before it called finish; nothing was landed (land=no)"),
      "the engine's session ended early",
    );
    assert.equal(
      stoppedWords(
        "the engine lost its sign-in before the director called finish (Your organization has disabled Claude subscription access for Claude Code); the run is paused — sign in again (or have the admin turn access back on), then Resume; nothing was landed (the run paused on its provider; nothing is made live that nobody could check)",
      ),
      "the model provider stopped accepting the account — sign in again, then Resume",
    );
    assert.equal(
      stoppedWords(
        "the engine's provider stayed down before the director called finish (529 overloaded); the run is paused — Resume it once the provider is back; nothing was landed (the run paused on its provider; nothing is made live that nobody could check)",
      ),
      "the model provider stayed down — Resume picks the build up",
    );
    assert.equal(stoppedWords("interrupted by restart"), "the studio restarted");
    // Nothing but the landing clause: then it really is the only thing there is to say.
    assert.equal(stoppedWords("nothing was landed (land=no)"), "nothing was made live");
    assert.equal(stoppedWords("land=no"), "nothing was made live");
  });

  it("says a builder used up its time, and never names the branch its work is on", () => {
    assert.equal(stoppedWords("facet budget exhausted"), "it used up the time it was given");
    assert.equal(stoppedWords("wall-clock budget exhausted"), "it used up the time it was given");
    assert.equal(
      stoppedWords(
        "stopped by the director: it was going nowhere — its work so far is kept on attempt/cars2/3-stopped",
      ),
      "stopped by the lead — it was going nowhere — its work was kept",
    );
    assert.doesNotMatch(
      stoppedWords("stopped by the director: fixing the base — its work so far is kept on attempt/cars2/3-stopped"),
      /attempt\//,
    );
    // The bookmark is a ref of the studio's own now (M2.7), and just as much the harness's business.
    assert.equal(
      stoppedWords(
        "stopped by the director: it was going nowhere — its work so far is kept on refs/studio/runs/run_fixture123456/attempts/cars2/3-stopped",
      ),
      "stopped by the lead — it was going nowhere — its work was kept",
    );
    // The card's colour reads off the same fact: running out of budget is not trouble.
    assert.equal(ranToItsEnd("facet iteration budget exhausted"), true);
    assert.equal(ranToItsEnd("stopped by the director: it was going nowhere"), false);
    assert.equal(ranToItsEnd(null), false);
  });
});

describe("the checks, counted", () => {
  it("separates a failing check from one nothing could measure", () => {
    // Thirteen probes of the first real run read `missing: state.…` on builds that worked, and
    // the card said "1 of 10 checks".
    assert.equal(checkCounts({ total: 10, passing: 1, unmeasured: 9 }), "Passed 1 · Couldn't measure 9");
    assert.equal(checkCounts({ total: 9, passing: 3, unmeasured: 4 }), "Passed 3 · Failed 2 · Couldn't measure 4");
    assert.equal(checkCounts({ total: 4, passing: 4, unmeasured: 0 }), "Passed 4");
    assert.equal(checkCounts({ total: 0, passing: 0, unmeasured: 0 }), "No checks yet");
    assert.equal(checkCounts(null), "No checks yet");
  });

  it("counts the plan's checks, and the judge's own questions as notes beside them", () => {
    // The run that motivated this: a part whose nine planned checks were mostly fine read
    // "1 of 10" because the judge had grown three questions of its own onto the same board.
    assert.equal(
      checkCounts({
        total: 12,
        passing: 3,
        unmeasured: 4,
        plannedTotal: 9,
        plannedPassing: 3,
        plannedUnmeasured: 4,
        grownTotal: 3,
      }),
      "Passed 3 · Failed 2 · Couldn't measure 4 · 3 reviewer notes",
    );
    assert.equal(
      checkCounts({
        total: 5,
        passing: 4,
        unmeasured: 0,
        plannedTotal: 4,
        plannedPassing: 4,
        plannedUnmeasured: 0,
        grownTotal: 1,
      }),
      "Passed 4 · 1 reviewer note",
    );
    // A plan with no checks yet, and a judge already asking questions, says so rather than nothing.
    assert.equal(
      checkCounts({
        total: 2,
        passing: 0,
        unmeasured: 0,
        plannedTotal: 0,
        plannedPassing: 0,
        plannedUnmeasured: 0,
        grownTotal: 2,
      }),
      "2 reviewer notes",
    );
    assert.equal(
      checkCounts({
        total: 0,
        passing: 0,
        unmeasured: 0,
        plannedTotal: 0,
        plannedPassing: 0,
        plannedUnmeasured: 0,
        grownTotal: 0,
      }),
      "No checks yet",
    );
  });
});

describe("what the run says as it goes", () => {
  const jargon = /\bfacet|\biteration|\bworktree|\bdirector\b|\bworker\b|\bthe harness\b|run_[0-9a-z]/i;
  const part = { facetId: "crumple", facetTitle: "Crash damage", iteration: 3 };

  it("names the part and the round, never the id and the iteration", () => {
    const lines = [
      moveWords({ ...part, what: "buckle the lids", delivered: false, scale: "small" }),
      fixWords({ ...part, what: "the tyres float", delivered: false, streak: 3 }),
      livenessWords({ ...part, total: 6, max: 10, biggest: "nothing moves", summary: "still and quiet" }),
      circuitBreakWords({ ...part, reason: "two builds in a row would not load" }),
      checkReplanWords({ ...part, action: "repointed", why: "the camera could not see it" }),
      flagWords({ ...part, what: "the starting point does not run" }),
      modelWords({ ...part, name: "tyre", bytes: 20480, ok: true, triangles: 900 }),
    ];
    for (const line of lines) {
      assert.doesNotMatch(line, jargon, line);
      assert.match(line, /Crash damage/, line);
    }
    assert.match(lines[0]!, /Crash damage · round 3/);
  });

  it("says a round waits for a lost provider, and why, without quoting the exception or counting it", () => {
    const line = outageWords({ facetTitle: "Sky", phase: "verify", lost: "auth" });
    assert.match(line, /^Sky: the model provider stopped accepting the account — the round waits for it/);
    assert.match(line, /nothing is counted against the build/);
    assert.doesNotMatch(line, /busy|min before|organization/);
    assert.match(outageWords({ facetTitle: "Sky", phase: "build", lost: "rate_limit" }), /session limit/);
    const status = statusWords("run run_fixture123456 · Sky — waiting for its model provider (lost sign-in)");
    assert.equal(status.line, "Sky · waiting for the model provider (lost sign-in)");
    assert.equal(status.short, "Sky · waiting");
  });

  it("says the provider is busy without quoting the exception", () => {
    const line = outageWords({ facetTitle: "Crash damage", phase: "judge", minutes: 8, attempt: 2 });
    assert.match(line, /the model provider is busy/);
    assert.doesNotMatch(line, /overloaded|Error|429/);
    // No part named: the run itself is waiting, and it is still not called a run.
    // Flipped: no time-of-day words in the app's copy.
    assert.match(outageWords({ phase: "plan", minutes: 3, attempt: 1 }), /^this build:/);
  });

  it("teaches the one word that starts the plan, and drops the check ids", () => {
    const line = planReviewWords({
      facets: [{ id: "cars2", title: "Crash damage", identity: ["state.contact.speedKept"] } as never],
      waitMinutes: 15,
    });
    assert.match(line, /Say "go"/);
    assert.doesNotMatch(line, /state\.contact/);
    assert.doesNotMatch(line, /repoint <check>/);
  });

  it("reads the lead's own summary, and never asks for a go the run is not waiting for", () => {
    const held = planReviewWords({
      summary: "This run: crash damage you can feel, on run_abc123 (5719bbb111).",
      facets: [{ title: "Crash damage" }, { title: "Dirt" }],
      waitMinutes: 12,
    });
    assert.match(held, /^This run: crash damage you can feel/);
    assert.match(held, /The parts: Crash damage · Dirt\./);
    assert.match(held, /Say "go" to start it.*waits up to 12 min/);
    assert.doesNotMatch(held, RUN_ID, held);
    assert.doesNotMatch(held, /5719bbb111/, "no sha on a card the user reads");
    // Nobody asked to review this one: the builders are already starting, so "go" would be a lie.
    const building = planReviewWords({
      summary: "This run: crash damage you can feel.",
      facets: [{ title: "Crash damage" }],
    });
    assert.doesNotMatch(building, /"go"/);
    assert.doesNotMatch(building, /waits up to/);
    assert.match(building, /Say what to change and the workers will hear it\./);
    // A lead that ends its summary without a full stop must not run into the studio's own
    // sentence: "…you can feel The parts:" was one card of two sentences glued together.
    const unpunctuated = planReviewWords({
      summary: "This run: crash damage you can feel",
      facets: [{ title: "Crash damage" }],
      waitMinutes: 12,
    });
    assert.match(unpunctuated, /you can feel\. The parts: Crash damage\./);
    assert.match(
      planReviewWords({ summary: "This run: crash damage you can feel" }),
      /you can feel\. Say what to change/,
    );
  });

  it("names the kind the run decided this game is — the plan's other decision", () => {
    // The kind is written back into the user's studio.json, decides the controls the studio
    // drives before every judgement and which critic reads the build. The window meant for
    // objecting to the plan showed every part of it except that one.
    const named = planReviewWords({
      summary: "This run: crash damage you can feel.",
      facets: [{ title: "Crash damage" }],
      game: { kind: "third-person" },
      waitMinutes: 12,
    });
    assert.match(named, /third person game/);
    assert.match(named, /Say "go" to start it/, "the kind sentence goes before the ask, not after it");
    // A plan that declared no kind says nothing rather than guessing one.
    const unnamed = planReviewWords({
      summary: "This run: crash damage you can feel.",
      facets: [{ title: "Crash damage" }],
    });
    assert.doesNotMatch(unnamed, /treats this as/);
    assert.doesNotMatch(planReviewWords({ summary: "This run.", game: { kind: null } }), /treats this as/);
  });

  it("says on Reload what would change Live, in the user's own terms", () => {
    assert.equal(liveBehindWords("changed"), "The game changed — reload to see it");
    assert.equal(liveBehindWords("build"), "A new build is ready — reload to play it");
    for (const reason of ["changed", "build", "broken"] as const) {
      const line = liveBehindWords(reason);
      assert.doesNotMatch(line, /handle|lease|pool|worktree|integration|commit|preview/i, line);
      assert.match(line, /reload/i, line);
    }
    // The accessible name is the tooltip, with the builder's own note when it left one.
    assert.equal(liveBehindLabel("changed", null), "The game changed — reload to see it");
    assert.equal(liveBehindLabel("changed", "added the jump"), "The game changed — reload to see it: added the jump");
  });

  it("says a run was paused and resumed without printing its id", () => {
    assert.doesNotMatch(pausedWords(), RUN_ID);
    assert.doesNotMatch(pausedWords(), /paused/i);
    assert.equal(resumedWords(5), "picking up where it left off — 5 finished parts kept");
    assert.equal(resumedWords(1), "picking up where it left off — 1 finished part kept");
    assert.equal(resumedWords(0), "picking up where it left off");
    assert.doesNotMatch(resumedWords(5), /facet/i);
  });

  it("says what the run is, before it says how it is split", () => {
    assert.match(runStartWords({ name: "Dirt 5", kind: "direction" }), /Dirt 5/);
    // No reference: the rule still reaches the user, without a bar literally named "unnamed".
    assert.doesNotMatch(runStartWords({ name: "unnamed", kind: "bar" }), /unnamed/);
    assert.match(runStartWords(null), /beat the one before/);
    // Which model judges is part of what the run IS: a saved preference could make the
    // orchestrator's model answer every crop question with no screen saying so (M3.10).
    assert.match(runStartWords(null, "Opus"), /Opus, reviewing without being told which build is which/);
    assert.match(runStartWords(null, "default"), /a reviewer that cannot see which is which/);
    const lead = autopilotStartWords({ director: true, maxParallel: 2, facets: [] });
    assert.match(lead, /the lead/);
    assert.doesNotMatch(lead, /window|facet|integrat/i);
    const split = autopilotStartWords({
      director: false,
      maxParallel: 2,
      facets: [
        { id: "a", title: "Crash damage", budgetShare: 0.5 },
        { id: "b", title: "Dirt", budgetShare: 0.5 },
      ],
    });
    assert.match(split, /2 parts/);
    assert.match(split, /2 workers at once/);
    assert.doesNotMatch(split, /worktree|facet|blind/i);
  });

  it("says the lead's own decisions in the user's words", () => {
    // The six shapes director.ts writes into the chat, verbatim.
    assert.equal(
      decisionWords('director started worker "Crash damage" (cars2, loop, 47 min): rebuild the crumple so lids buckle'),
      'the lead put a worker on "Crash damage" for 47 min: rebuild the crumple so lids buckle',
    );
    const health = decisionWords(
      "the integrated build a82ee734ce did not pass its health pass: the game did not draw anything — the director must fix it or judge it before it can land",
    );
    // Flipped: no time-of-day words in the app's copy.
    assert.match(health, /this build/);
    assert.doesNotMatch(health, /a82ee734ce|director|health pass/);
    assert.match(health, /did not run when it was checked/);
    const close = decisionWords(
      "the integration branch beef1234aa did not load at the close (no frame) and no judge had passed it — kept unlanded on refs/studio/runs/run_fixture123456/integration",
    );
    assert.doesNotMatch(close, /refs\/|run_|beef1234aa/);
    assert.match(close, /nothing was made live/);
    assert.equal(
      decisionWords('the engine hit its usage cap: 429 {"type":"error"} rate limit'),
      "the model provider stopped us — waiting for the limit to reset",
    );
    assert.equal(
      decisionWords("director stopped worker post2: it was going nowhere"),
      "the lead stopped a worker: it was going nowhere",
    );
    assert.match(decisionWords("director: the crowd shader compiles again"), /the crowd shader compiles again/);
  });
});

describe("tools", () => {
  it("names what a builder did, not which tool it called", () => {
    assert.deepEqual(toolWords("mcp__studio__computer"), { icon: "see", label: "looked at the game" });
    assert.equal(toolWords("Bash").label, "ran a command");
    assert.equal(toolWords("Read").label, "read the code");
    assert.equal(toolWords("Edit").label, "edited the code");
    assert.equal(toolWords("MultiEdit").label, "edited the code");
    assert.equal(toolWords("Grep").label, "searched the code");
    assert.equal(toolWords("TodoWrite").label, "planned its next steps");
    assert.equal(toolWords("Task").label, "asked a helper");
  });

  it("names the studio's own tools the same way", () => {
    assert.deepEqual(toolWords("run_command"), { icon: "run", label: "ran a command" });
    assert.equal(toolWords("load_preview").label, "loaded the game");
    assert.equal(toolWords("start_autopilot").label, "requested an iterative build");
    // The MCP wrapper around a studio tool is the same tool.
    assert.equal(toolWords("mcp__studio__screenshot").label, "took a screenshot");
    // An unknown tool still reads as English, never as an identifier.
    assert.equal(toolWords("some_new_tool").label, "used some new tool");
    assert.equal(toolWords("").label, "used a tool");
  });

  it("names the lead's and the chat's run tools, never 'used …'", () => {
    const names = [
      ...Object.values(DirectorTool).filter((name) => name !== DirectorTool.ResolveRoot),
      // Every lead's and the chat's worker tools, the same six everywhere.
      ...Object.values(WorkerTool),
      // The background-work tools and the look-only app tool the chat, leads and workers share.
      ...Object.values(JobTool),
      APP_LOOK_TOOL_NAME,
      "capture",
      "checkpoint",
      "continue_build",
      "reopen_run",
      "show_build",
      "land_build",
      "ask_user",
      "set_game_cover",
    ];
    const unnamed = names
      .flatMap((name) => [name, `mcp__studio__${name}`])
      .filter((name) => toolWords(name).label.startsWith("used "));
    assert.deepEqual(unnamed, []);
    // A playtester waits too: the word stays neutral.
    assert.deepEqual(toolWords("wait"), { icon: "think", label: "waited", active: "Waiting" });
    assert.deepEqual(toolWords("mcp__studio__capture"), {
      icon: "see",
      label: "captured the game",
      active: "Capturing the game",
    });
  });

  it("names a qualified tool without guessing plugin versus MCP or exposing its id", () => {
    // Every engine namespaces a plugin's tools; the chip must not read "used genex asset".
    assert.deepEqual(toolWords("genex__asset"), { icon: "run", label: "used a tool: asset" });
    assert.equal(toolWords("mcp__studio__genex__asset").label, "used a tool: asset");
    assert.equal(toolWords("example__shout").label, "used a tool: shout");
    assert.equal(toolWords("my-plugin__make_thing").label, "used a tool: make thing");
    assert.equal(
      toolWords("public-docs__search_model_context_protocol").label,
      "used a tool: search model context protocol",
    );
    // And the fallback for an ordinary unknown name is untouched by that branch.
    assert.equal(toolWords("some_new_tool").label, "used some new tool");
    assert.equal(toolWords("").label, "used a tool");
  });

  it("tells the story of a plugin call: asked, came back, or failed — and never leaks an id", () => {
    const call = {
      pluginName: "Genex Tools",
      tool: "asset",
      toolName: "genex__asset",
      facetTitle: "Cottages & chapel",
      iteration: 3,
    };
    assert.equal(
      pluginToolWords(call),
      "Cottages & chapel · round 3: Genex Tools is running asset",
      "a call still out says only that",
    );
    assert.equal(
      pluginToolWords({ ...call, ok: true, files: ["assets/genex/j1/barn.png"], images: 2 }),
      "Cottages & chapel · round 3: Genex Tools ran asset — 1 file, 2 images",
    );
    assert.equal(
      pluginToolWords({ ...call, ok: true, files: [], images: 0 }),
      "Cottages & chapel · round 3: Genex Tools ran asset",
    );
    assert.equal(
      pluginToolWords({ ...call, ok: false, error: "out of credits" }),
      "Cottages & chapel · round 3: Genex Tools could not run asset — out of credits",
    );
    // A chat call has no part and no round; it still has a subject.
    assert.equal(
      pluginToolWords({ pluginName: "Genex Tools", tool: "asset", ok: true, files: ["a.png"] }),
      "chat: Genex Tools ran asset — 1 file",
    );
    // A plugin that says nothing about itself is still described.
    assert.equal(pluginToolWords({ ok: true }), "chat: a plugin ran a tool");
    // The plugin's own strings pass the same gate as the model's.
    const leaky = pluginToolWords({
      pluginName: "Genex Tools",
      tool: "asset",
      ok: false,
      error: "job for run_fixture123456 failed at 69f573d411",
    });
    assert.doesNotMatch(leaky, /run_fixture123456/);
    assert.doesNotMatch(leaky, /69f573d411/);
    // The namespaced name alone is enough to name the tool.
    assert.equal(
      pluginToolWords({ pluginName: "Genex Tools", toolName: "mcp__studio__genex__asset", ok: true }),
      "chat: Genex Tools ran asset",
    );
  });

  it("names a connector step by what it did, falls back to its connector and tool, and never leaks an id", () => {
    const step = (tool: string, toolName?: string) => connectorStep({ tool, ...(toolName ? { toolName } : {}) });
    assert.deepEqual(connectorStepWords(step("get_file"), "Figma"), {
      label: "Figma · get_file",
      active: "Working in Figma",
      icon: "run",
    });
    assert.equal(
      connectorStepWords(step("get_file"), "Figma", { ok: false, error: "no such file" }).label,
      "Figma · get_file: no such file",
    );
    // A record with nothing in it is still a line.
    assert.equal(connectorStepWords(step(""), "").active, "Working in a connector");
    // The server's own error text passes the same gate as the model's.
    const leaky = connectorStepWords(step("get_file"), "figma", {
      ok: false,
      error: "job run_fixture123456 died at 69f573d411",
    }).label;
    assert.doesNotMatch(leaky, /run_fixture123456/);
    assert.doesNotMatch(leaky, /69f573d411/);
    // The card's own health words never borrow the two labels the build smoke matches exactly.
    const card = readFileSync(path.join(root, "src/renderer/panels/ConnectorsCard.tsx"), "utf8");
    assert.doesNotMatch(card, /\b(Retry|Ready)\b/);
  });

  it("every tool of the Genex editor helper's build and play toolsets has its own step", () => {
    const toolsets = {
      "genex_build.tools.GenexBuildTools": [
        "set_route",
        "track_terrain",
        "dirt_material",
        "run_script",
        "shot_cameras",
        "capture_shot",
        "capture_play",
        "motion_strip",
        "import_model",
        "import_character",
        "import_animation",
        "import_sound",
        "retarget",
        "attach_to_socket",
        "audit",
        "attach_mesh",
      ],
      "genex_play.tools.GenexPlayTools": [
        "list_actions",
        "hold",
        "release_all",
        "project_file",
        "player_state",
        "settle",
        "drive_route",
        "probe_route",
      ],
    };
    const step = (toolset: string, toolName: string, args: Record<string, unknown> = {}) =>
      connectorStep({ tool: "call_tool", toolset, toolName, args });
    for (const [toolset, tools] of Object.entries(toolsets))
      for (const tool of tools) assert.notEqual(step(toolset, tool).action, StepAction.Other, `${toolset} ${tool}`);
    const build = "genex_build.tools.GenexBuildTools";
    const label = (toolName: string, args: Record<string, unknown>) =>
      connectorStepWords(step(build, toolName, args), "Unreal").label;
    assert.match(label("run_script", { file: "track", args_json: "{}" }), /track/);
    assert.match(label("capture_shot", { camera: "HeroCam_Start" }), /HeroCam_Start/);
    assert.match(label("import_model", { file: "/tmp/bike.fbx", dest: "/Game/Bike", name: "SM_Bike" }), /SM_Bike/);
    assert.equal(showsPlayView(step(build, "motion_strip", { frames: 4, interval_s: 0.5 }), false), true);
    assert.equal(showsPlayView(step(build, "capture_play", { name: "jump" }), false), true);
  });

  it("folds a delegated minute into one closed line", () => {
    assert.equal(toolGroupHeader(1), "1 tool call");
    assert.equal(toolGroupHeader(37), "37 tool calls");
    const source = readFileSync(path.join(root, "src/renderer/ui/ToolChips.tsx"), "utf8");
    assert.match(source, /const \[open, setOpen\] = useState\(false\)/, "the tool block opens closed");
    assert.match(source, /aria-expanded=\{open\}/);
  });
});

describe("what the user is told when something refuses", () => {
  it("says the studio's own refusals in plain words", () => {
    assert.equal(
      problemWords(
        new Error('a contractor is building in "skate" right now — wait for it to finish before landing a build'),
      ),
      "A worker is busy in your game folder right now — try again once it has finished.",
    );
    assert.match(
      problemWords(
        new Error("the game folder has uncommitted edits (3 file(s)) — commit or discard them before landing a build"),
      ),
      /edits of its own/,
    );
    assert.match(
      problemWords(new Error('commit 69f573d411 is not in "skate"\'s history')),
      /not in this game\'s history/,
    );
  });

  it("never carries a sha, a ref or a git command's own output into a toast", () => {
    const conflict = problemWords(
      new Error(
        "landing 69f573d411 conflicted with the game folder; nothing was changed (CONFLICT (content): Merge conflict in src/main.js)",
      ),
    );
    assert.match(conflict, /nothing was changed/);
    assert.doesNotMatch(conflict, /69f573d411/);
    assert.doesNotMatch(conflict, /CONFLICT/);
    // A refusal this table does not know keeps its sentence and loses its tail.
    const unknown = problemWords(
      new Error("the preview could not start (Error: spawn EACCES opening the served folder for run_fixture123456)"),
    );
    assert.equal(unknown, "The preview could not start.");
    assert.equal(problemWords(undefined), "That didn't work, and nothing was changed.");
    // A sentence already written for the user survives whole.
    assert.equal(
      problemWords(new Error("That build is no longer running; nothing was asked to finish.")),
      "That build is no longer running; nothing was asked to finish.",
    );
  });

  it("is what the toasts actually call: no raw error message reaches one", () => {
    const offenders: string[] = [];
    for (const file of rendererFiles()) {
      const source = readFileSync(file, "utf8");
      for (const hit of source.matchAll(/(?:notify|onNotice)\??\.?\([^\n]*as Error\)\.message/g)) {
        offenders.push(`${path.relative(root, file)}: ${hit[0]}`);
      }
    }
    assert.deepEqual(offenders, [], "a toast must be given problemWords(err), not the thrown text");
  });
});

describe("the vocabulary lives in one file", () => {
  it("leaves no harness verdict word in any other renderer file", () => {
    const offenders: string[] = [];
    for (const file of rendererFiles()) {
      if (path.basename(file) === "words.ts") continue;
      const source = readFileSync(file, "utf8");
      const hits = [
        ...source.matchAll(/verdictSource\s*[=!]==?\s*["'][^"']*["']/g),
        ...source.matchAll(/["'](challenger|incumbent|taste-veto|no-move|unfixed)["']/g),
        ...source.matchAll(/\bcase\s+["'](invisible|broken|outage|race|stopped)["']/g),
      ];
      for (const hit of hits) offenders.push(`${path.relative(root, file)}: ${hit[0]}`);
    }
    assert.deepEqual(offenders, [], "these belong in words.ts");
  });

  it("leaves no harness verdict word in src/shared but the run rules", () => {
    // What a round's verdict *was* is decided once, in shared/run-state.ts; the summary and the
    // review read it from there rather than comparing the harness's words themselves.
    const offenders: string[] = [];
    const shared = path.join(root, "src/shared");
    for (const file of readdirSync(shared, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.ts$/.test(name))
      .map((name) => path.join(shared, name))) {
      if (path.basename(file) === "run-state.ts") continue;
      const source = readFileSync(file, "utf8");
      const hits = [
        ...source.matchAll(/verdictSource\s*[=!]==?\s*["'][^"']*["']/g),
        ...source.matchAll(/["'](challenger|incumbent|taste-veto|no-move|unfixed)["']/g),
      ];
      for (const hit of hits) offenders.push(`${path.relative(root, file)}: ${hit[0]}`);
    }
    assert.deepEqual(offenders, [], "these belong in shared/run-state.ts");
  });

  it("reads the recorded stop reason through stoppedWords in the Builds drawer, never raw", () => {
    const ended = endedWords({ active: false, summary: { reason: "stopped by the director" } as RunSummary });
    assert.equal(
      ended,
      `Ended because ${stoppedWords("stopped by the director")}.`,
      "the run-level reason is translated like every other one",
    );
    assert.doesNotMatch(ended ?? "", /director/, "the harness's own sentence must not reach the screen");
    assert.equal(
      endedWords({ active: true, summary: { reason: "stopped by the director" } as RunSummary }),
      null,
      "a live run has not ended",
    );
    assert.equal(endedWords({ active: false, summary: undefined }), null);
  });

  it("holds those words itself, so the gate above means something", () => {
    // The harness's ids go in, and only the owner's words come out.
    assert.equal(isKept("challenger"), true);
    assert.equal(isKept("incumbent"), false);
    const reasons = ["taste-veto", "no-move", "unfixed", "invisible"].map((source) => undoneBecause(source));
    assert.equal(new Set(reasons).size, 4, "each harness reason has a sentence of its own");
    for (const reason of reasons)
      assert.doesNotMatch(reason, /taste-veto|no-move|unfixed|invisible|not clearly better/, reason);
    assert.equal(toolWords("mcp__studio__computer").label, "looked at the game");
  });

  it("writes a plugin tool call's sentence in words.ts and nowhere else", () => {
    const record = (id: string, eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
      id,
      thread_id: "t",
      session_id: null,
      turn_id: null,
      created_at: "2026-09-08T02:00:00.000Z",
      data: {
        type: "custom",
        event_type: eventType,
        payload: { pluginName: "Genex Tools", tool: "asset", ...payload },
      },
    });
    const rowsOf = (events: EventEnvelope[]) =>
      toEntries(events).flatMap((entry) => (entry.kind === "tools" ? entry.rows : []));
    // Both halves of the host's record are read, into one line per call.
    const out = rowsOf([record("e1", "plugin_tool_started", { callId: "c1" })]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.state, "running");
    assert.equal(
      out[0]!.detail?.[0]?.text,
      pluginToolWords({ pluginName: "Genex Tools", tool: "asset" }),
      "the chat line comes from the vocabulary",
    );
    const back = rowsOf([
      record("e1", "plugin_tool_started", { callId: "c1" }),
      record("e2", "plugin_tool", { callId: "c1", ok: false, error: "quota" }),
    ]);
    assert.equal(back.length, 1, "the closing record rewrites the same line");
    assert.equal(back[0]!.state, "failed");
    assert.match(back[0]!.detail?.[0]?.text ?? "", /could not run asset — quota/);
    // An API 1 record has no `ok` and was only ever written once the call had returned; without
    // this, every plugin call in a log from before this version would read as still out, forever.
    const legacy = rowsOf([record("e3", "plugin_tool", { callId: "c2" })]);
    assert.equal(legacy[0]!.state, "succeeded", "a closing record with no outcome is read as a call that came back");
    assert.equal(legacy[0]!.detail?.[0]?.text, pluginToolWords({ pluginName: "Genex Tools", tool: "asset", ok: true }));
    assert.match(toolWords("genex__make_asset").label, /^used a tool: make asset$/);
    // No other renderer file may write a plugin call's outcome for itself.
    const offenders: string[] = [];
    for (const file of rendererFiles()) {
      if (path.basename(file) === "words.ts") continue;
      const source = readFileSync(file, "utf8");
      for (const hit of source.matchAll(/could not run|used a tool:/g))
        offenders.push(`${path.relative(root, file)}: ${hit[0]}`);
    }
    assert.deepEqual(offenders, [], "these belong in words.ts");
  });
});

describe("a plugin's permission request", () => {
  it("names the plugin and the tool, and quotes its arguments up to 120 characters", () => {
    const ask = (args: Record<string, unknown>) =>
      consentAskWords({ pluginName: "Painter", tool: "mcp__painter__make_image", args });
    assert.equal(ask({ size: 2 }), "Painter asks to run make image (size: 2)");
    assert.equal(ask({ prompt: "x".repeat(112) }), `Painter asks to run make image (prompt: ${"x".repeat(112)})`);
    assert.equal(ask({ prompt: "x".repeat(113) }), `Painter asks to run make image (prompt: ${"x".repeat(111)}…)`);
    assert.equal(consentAskWords({ prompt: "Make it red" }), "A plugin asks to run a tool — Make it red");
  });
});
