/**
 * The Genex app eval lane end to end on a real core (evals plan §5.3, lanes A/D): the launch's
 * own core options with the scripted fixture engines, a real harness, and `runEvalLane` driving
 * it the way the smoke sub-runner does. What is asserted is the sequence (preflight, a fresh game
 * chat in the spec's permission mode, the brief with its suffix, typed questions answered with
 * the shared sentence), the deadline rail taking the core's Stop, and the report's shape.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CATALOG_WAIT_MS,
  type EvalLaneClock,
  type EvalLaneCore,
  type EvalLaneDeps,
  evalCoreOptions,
  openEvalLane,
  runEvalLane,
  threadBoundListeners,
} from "../../src/main/smoke/eval-lane.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import {
  AnswerPolicy,
  EVAL_LANE_EXIT,
  EVAL_LANE_REPORT_SCHEMA,
  EndedHow,
  type EvalLaneReport,
  type EvalLaneSpec,
  EvalLaneErrorCode,
  LaneModeServed,
  LaunchPath,
  QuestionKind,
} from "../../src/shared/eval-lane.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { ModelCatalogState, type ModelCatalogStatus } from "../../src/shared/model-catalog.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { FIXTURE_MODEL } from "../../src/main/dev/fixture-kit.ts";
import { workspaceDigest } from "../../src/substrate/workspace-digest.ts";
import { makeResources } from "../helpers/studio-rig.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

/** A real clock whose waits are short, so a poll costs the test a moment rather than a second. */
/** A bundled engine plugin: on, a new game's chat asks which kind it is. */
const GODOT_PLUGIN = "godot";
const QUICK_CLOCK: EvalLaneClock = { now: () => Date.now(), sleep: (ms) => sleep(Math.min(ms, 100)) };

/** A clock that advances by each wait it is asked for, and lets real time run briefly between polls. */
function virtualClock(): EvalLaneClock {
  let now = Date.UTC(2026, 9, 1, 12, 0, 0);
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      await sleep(20);
    },
  };
}

function laneSpec(work: string, patch: Partial<EvalLaneSpec> = {}): EvalLaneSpec {
  return {
    runId: "20261001T120000-fixture-genex-case-01-r1",
    laneId: "fixture-genex",
    caseId: "case-01",
    engine: EngineId.ClaudeCode,
    model: FIXTURE_MODEL,
    effort: "high",
    brief: "Make a tiny synthetic arena game.",
    suffix: "You have about 1 minutes. Nobody will answer questions; make reasonable assumptions and continue.",
    commission: {},
    permissionMode: PermissionMode.AcceptEdits,
    deadlineMs: 90_000,
    graceMs: 5_000,
    answerPolicy: AnswerPolicy.NoAnswers,
    maxAnswers: 3,
    codexHostSkillSuppression: false,
    gamesRoot: path.join(work, "games"),
    userDataRoot: path.join(work, "userdata"),
    workRoot: work,
    homes: { claude: path.join(work, "homes", "claude"), codex: path.join(work, "homes", "codex") },
    reportPath: path.join(work, "report", "lane-report.json"),
    fixture: true,
    ...patch,
  };
}

/**
 * The launch main opens (`--studio-eval-lane` with `--studio-eval-fixture`), and a real core built
 * from its own options, started, and stopped before its folders go. The run reads the opened spec,
 * whose roots are real paths.
 */
async function laneCore(
  patch: Partial<EvalLaneSpec> = {},
): Promise<{ core: StudioCore; spec: EvalLaneSpec; deps: EvalLaneDeps }> {
  const base = await tmpDir("studio-eval-lane-");
  const written = laneSpec(path.join(base, "work", "run-1"), patch);
  await mkdir(written.workRoot, { recursive: true });
  const file = path.join(base, "spec.json");
  await writeFile(file, JSON.stringify({ ...written, fixture: false }));
  const opened = await openEvalLane({
    file,
    smoke: true,
    devLaunch: false,
    fixtureFlag: true,
    liveAllowed: false,
    userData: written.userDataRoot,
    aiGames: path.join(base, "home", "AI Games"),
    defaultUserData: path.join(base, "home", "Library", "Genex"),
  });
  if (!opened.ok) throw new Error(opened.refusal);
  const { spec } = opened.launch;
  // The core's UI events reach the lane as main routes them: through the thread-bound fan-out.
  const bound = threadBoundListeners();
  const core = new StudioCore({
    paths: { userData: spec.userDataRoot, resources: await makeResources() },
    ...evalCoreOptions(opened.launch, spec.userDataRoot),
    execPath: process.execPath,
    appVersion: "0.0.0-eval-test",
    onUiEvent: bound.push,
  });
  await core.init();
  closeBeforeCleanup(() => core.stop());
  await core.start();
  return { core, spec, deps: { onThreadBound: bound.onThreadBound } };
}

/** The core as the lane sees it, with each call it makes recorded in order. */
function recording(core: StudioCore): { lane: EvalLaneCore; calls: string[] } {
  const calls: string[] = [];
  const lane: EvalLaneCore = {
    engines: core.engines,
    layout: core.layout,
    options: core.options,
    store: core.store,
    games: core.games,
    activeBuilders: () => core.activeBuilders(),
    plugins: {
      list: () => core.plugins.list(),
      enabled: (id) => core.plugins.enabled(id),
      setEnabled: async (id, enabled) => {
        calls.push(`setPluginEnabled:${id}:${String(enabled)}`);
        return core.plugins.setEnabled(id, enabled);
      },
    },
    createGameThread: async (project) => {
      calls.push("createGameThread");
      return core.createGameThread(project);
    },
    setPermissionMode: async (threadId, mode) => {
      calls.push(`setPermissionMode:${String(mode)}`);
      return core.setPermissionMode(threadId, mode);
    },
    sendUserMessage: async (text, options) => {
      calls.push("sendUserMessage");
      return core.sendUserMessage(text, options);
    },
    answerPlan: async (thread, id, approved) => {
      calls.push("answerPlan");
      return core.answerPlan(thread, id, approved);
    },
    requestRunFinish: async (thread, runId) => {
      calls.push("requestRunFinish");
      return core.requestRunFinish(thread, runId);
    },
    stopThread: async (threadId, options) => {
      calls.push("stopThread");
      return core.stopThread(threadId, options);
    },
  };
  return { lane, calls };
}

/** A model catalog whose first read has not answered yet, as a live launch's first moments have it. */
const CATALOG_LOADING: ModelCatalogStatus = { state: ModelCatalogState.Loading, revision: 0, refreshing: true };

/**
 * The core's engines as a live launch reads them while the spec's engine still loads its model
 * list: for the first `loadingReads` reads its catalog is loading and the pinned model is not
 * listed yet; after them the list is the core's own. `reads()` counts the reads made.
 */
function lateCatalog(
  core: StudioCore,
  spec: EvalLaneSpec,
  loadingReads: number,
): { engines: EvalLaneCore["engines"]; reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    engines: {
      describe: async () => {
        const list = await core.engines.describe();
        reads += 1;
        if (reads > loadingReads) return list;
        return list.map((engine) =>
          engine.id === spec.engine
            ? {
                ...engine,
                catalog: CATALOG_LOADING,
                models: engine.models.filter((model) => model.id !== spec.model),
              }
            : engine,
        );
      },
    },
  };
}

async function readReport(spec: EvalLaneSpec): Promise<EvalLaneReport> {
  return JSON.parse(await readFile(spec.reportPath, "utf8"));
}

/** The user's words in the chat, in order. */
async function userWords(core: StudioCore, threadId: string): Promise<string[]> {
  const words: string[] = [];
  for (const event of await core.store.listEvents(threadId)) {
    if (event.data.type !== EventKind.Messages) continue;
    for (const message of event.data.messages)
      if (message.role === "user" && typeof message.content === "string") words.push(message.content);
  }
  return words;
}

describe("eval lane on a real core", () => {
  it("sends the brief in the spec's mode, answers the typed question, and reports the chat finished", async () => {
    const { core, spec, deps } = await laneCore();
    // An engine plugin on: the new game has no kind yet, so its chat is handed the question card.
    await core.plugins.setEnabled(GODOT_PLUGIN, true);
    const { lane, calls } = recording(core);
    // The seeded game's digest, taken beside the lane's at the same moment: when the chat is bound.
    let seeded: Promise<string> | null = null;
    deps.onThreadBound?.((bound) => {
      seeded ??= workspaceDigest(core.games.dirFor(bound.project));
    });

    const code = await runEvalLane(lane, spec, QUICK_CLOCK, deps);

    assert.equal(code, EVAL_LANE_EXIT.Ok);
    const report = await readReport(spec);
    assert.equal(report.schema, EVAL_LANE_REPORT_SCHEMA);
    assert.equal(report.endedHow, EndedHow.AgentFinished);
    assert.deepEqual(calls.slice(0, 3), [
      "createGameThread",
      `setPermissionMode:${PermissionMode.AcceptEdits}`,
      "sendUserMessage",
    ]);
    assert.equal(report.permissionModeServed, PermissionMode.AcceptEdits);
    const words = await userWords(core, report.threadId);
    assert.equal(words[0], `${spec.brief}\n\n${spec.suffix}`);
    // The fixture's game chat opens with one `ask_user` question, then takes the answer.
    assert.equal(report.questionsAsked, 1);
    assert.equal(report.answers.length, 1);
    for (const answer of report.answers) {
      assert.equal(answer.question, QuestionKind.AskUser);
      assert.equal(answer.policy, AnswerPolicy.NoAnswers);
    }
    assert.deepEqual(
      words.slice(1),
      report.answers.map(() => words[1]),
    );
    assert.equal(calls.includes("stopThread"), false);
    assert.equal(report.launch, LaunchPath.None);
    assert.deepEqual(report.budgets, { completionPolicy: null });
    assert.equal(report.modeServed, LaneModeServed.Fixture);
    assert.deepEqual(report.commissionSent, spec.commission);
    assert.equal(report.harnessDigest.matches, true);
    assert.equal(report.appVersion, "0.0.0-eval-test");
    assert.deepEqual(report.cliVersions, { claude: null, codex: null });
    assert.deepEqual(report.errors, []);
    assert.equal(report.fixture, true);
    assert.deepEqual(
      report.plugins?.find((plugin) => plugin.id === GENEX_PLUGIN_ID),
      { id: GENEX_PLUGIN_ID, enabled: true },
      "a lane that turns nothing off runs with the bundled Genex plugin on, as a fresh profile does",
    );
    assert.ok(seeded, "the fixture chat is bound to the game it seeds");
    assert.equal(report.templateDigest, await seeded);
  });

  it("at deadline plus grace takes the core's Stop and reports a deadline ending", async () => {
    const { core, spec } = await laneCore({ deadlineMs: 0, graceMs: 0 });
    const { lane, calls } = recording(core);

    const code = await runEvalLane(lane, spec, virtualClock());

    assert.equal(code, EVAL_LANE_EXIT.Ok);
    const report = await readReport(spec);
    assert.equal(report.endedHow, EndedHow.Deadline);
    assert.equal(calls.includes("stopThread"), true);
    assert.deepEqual(report.answers, []);
    assert.ok(Date.parse(report.endedAt) >= Date.parse(report.startedAt));
  });

  it("turns the spec's plugins off before the chat exists, and reports them off", async () => {
    const { core, spec } = await laneCore({ disabledPlugins: [GENEX_PLUGIN_ID] });
    assert.equal(core.plugins.enabled(GENEX_PLUGIN_ID), true, "a fresh eval profile starts with Genex on");
    const { lane, calls } = recording(core);

    const code = await runEvalLane(lane, spec, QUICK_CLOCK);

    assert.equal(code, EVAL_LANE_EXIT.Ok);
    assert.deepEqual(calls.slice(0, 2), [`setPluginEnabled:${GENEX_PLUGIN_ID}:false`, "createGameThread"]);
    assert.equal(core.plugins.enabled(GENEX_PLUGIN_ID), false);
    const report = await readReport(spec);
    assert.equal(report.endedHow, EndedHow.AgentFinished);
    assert.deepEqual(
      report.plugins?.find((plugin) => plugin.id === GENEX_PLUGIN_ID),
      { id: GENEX_PLUGIN_ID, enabled: false },
    );
    assert.deepEqual(report.errors, []);
  });

  it("refuses a plugin it cannot turn off, before any chat exists", async () => {
    const { core, spec } = await laneCore({ disabledPlugins: ["no-such-plugin"] });
    const { lane, calls } = recording(core);

    const code = await runEvalLane(lane, spec, QUICK_CLOCK);

    assert.equal(code, EVAL_LANE_EXIT.Failed);
    const report = await readReport(spec);
    assert.equal(report.endedHow, EndedHow.HarnessFailure);
    assert.deepEqual(
      report.errors.map((error) => error.code),
      [EvalLaneErrorCode.PluginNotDisabled],
    );
    assert.equal(calls.includes("createGameThread"), false);
    assert.equal(report.threadId, "");
  });

  it("refuses a model the engine does not list, before any chat exists", async () => {
    const { core, spec } = await laneCore({ model: "no-such-model" });
    const { lane, calls } = recording(core);

    const code = await runEvalLane(lane, spec, QUICK_CLOCK);

    assert.equal(code, EVAL_LANE_EXIT.Failed);
    const report = await readReport(spec);
    assert.equal(report.endedHow, EndedHow.HarnessFailure);
    assert.deepEqual(
      report.errors.map((error) => error.code),
      [EvalLaneErrorCode.UnknownModel],
    );
    assert.deepEqual(calls, []);
    assert.equal(report.threadId, "");
    assert.equal(report.templateDigest, null);
  });

  it("waits for a model list that is still loading, then sends the brief", async () => {
    const { core, spec } = await laneCore();
    const { lane, calls } = recording(core);
    const late = lateCatalog(core, spec, 2);

    const code = await runEvalLane({ ...lane, engines: late.engines }, spec, QUICK_CLOCK);

    assert.equal(code, EVAL_LANE_EXIT.Ok);
    const report = await readReport(spec);
    assert.deepEqual(report.errors, []);
    assert.equal(report.endedHow, EndedHow.AgentFinished);
    assert.equal(calls.includes("sendUserMessage"), true);
    assert.equal(late.reads(), 3, "the lane reads the engines again until the list has loaded, and no more");
  });

  it("gives up as engine-not-ready when the model list is still loading at the catalog deadline", async () => {
    const { core, spec } = await laneCore();
    const { lane, calls } = recording(core);
    const late = lateCatalog(core, spec, Number.POSITIVE_INFINITY);

    const code = await runEvalLane({ ...lane, engines: late.engines }, spec, virtualClock());

    assert.equal(code, EVAL_LANE_EXIT.Failed);
    const report = await readReport(spec);
    assert.equal(report.endedHow, EndedHow.HarnessFailure);
    assert.deepEqual(
      report.errors.map((error) => error.code),
      [EvalLaneErrorCode.EngineNotReady],
      "a list that never loaded says nothing about the model: the engine was not ready",
    );
    assert.deepEqual(calls, []);
    assert.equal(report.threadId, "");
    const waitedMs = Date.parse(report.endedAt) - Date.parse(report.startedAt);
    assert.ok(waitedMs >= CATALOG_WAIT_MS, `waited ${waitedMs} ms, under the deadline`);
    assert.ok(waitedMs <= CATALOG_WAIT_MS + 2 * SECOND_MS, `waited ${waitedMs} ms, past the deadline`);
  });
});
