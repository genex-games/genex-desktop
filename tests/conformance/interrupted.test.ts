/**
 * Every death leaves a durable trace — the boot repair for logs a crash left mid-sentence.
 *
 * The properties that matter:
 *  1. a turn the process died inside is closed at the next boot — `turn_ended` marked
 *     interrupted, plus a visible message inviting a follow-up — so no chat thinks forever;
 *  2. a `run_started` the process died inside gains a synthetic `run_finished` (no victory,
 *     "interrupted by restart") exactly once — a second boot appends nothing;
 *  3. work that ended honestly is left exactly as it was.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { StudioCore } from "../../src/main/studio-core.ts";
import { TurnFactory, findInterruptedTurns } from "../../src/substrate/turns.ts";
import { makeFakePreview, makeResources } from "../helpers/studio-rig.ts";
import { startFakeOllama, type FakeOllama } from "../helpers/fake-ollama.ts";
import { tmpDir } from "../helpers/tmp.ts";
import type { PluginConsentEvent } from "../../src/shared/plugins.ts";
import { consentOutcomeWords } from "../../src/renderer/words.ts";

let server: FakeOllama | null = null;
let resources: string | null = null;
const bootedCores: StudioCore[] = [];
after(async () => {
  await Promise.all(bootedCores.map((core) => core.stop().catch(() => {})));
  await server?.close();
});

/** A core over the given userData — the same install, another lifetime. */
async function makeCore(userData: string): Promise<StudioCore> {
  server ??= await startFakeOllama({ replies: [] });
  resources ??= await makeResources();
  const core = new StudioCore({
    paths: { userData, resources },
    preview: makeFakePreview(),
    execPath: process.execPath,
    ollamaHost: server.host,
  });
  await core.init();
  return core;
}

describe("every death leaves a durable trace", () => {
  it("boot withdraws unanswered permissions across chats exactly once and preserves previous answers", async () => {
    const userData = path.join(await tmpDir("studio-consent-interrupted-"), "userData");
    const before = await makeCore(userData);
    const threads = await Promise.all(
      ["first chat", "second chat"].map((title) => before.store.createThread({ title })),
    );
    const child = await before.store.createThread({ title: "worker" });
    const consent = (threadId: string, consentId: string, state: PluginConsentEvent["state"]): PluginConsentEvent => ({
      consentId,
      pluginId: "example",
      pluginName: "Example",
      tool: "example__publish",
      args: {},
      project: "arena",
      threadId: child,
      originThreadId: child,
      runId: `run-${threadId}`,
      prompt: "Publish this game?",
      state,
      ...(state === "pending" ? { expiresAt: Date.now() + 60_000 } : { by: "user" as const }),
    });
    for (const threadId of threads) {
      await before.store.appendEvents(
        threadId,
        [
          consent(threadId, "unanswered", "pending"),
          consent(threadId, "approved", "pending"),
          consent(threadId, "approved", "approved"),
          consent(threadId, "declined", "pending"),
          consent(threadId, "declined", "declined"),
        ].map((payload) => ({ type: "custom" as const, event_type: "plugin_consent", payload })),
      );
      // Build the context cache before recovery to exercise its incremental update too.
      assert.equal((await before.store.chatState(threadId)).length, 1);
    }
    for (let boot = 0; boot < 2; boot++) {
      const reborn = await makeCore(userData);
      bootedCores.push(reborn);
      await reborn.start();
      for (const threadId of threads) {
        const events = await reborn.store.listEvents(threadId);
        const questions = events.flatMap((event) =>
          event.data.type === "custom" && event.data.event_type === "plugin_consent"
            ? [event.data.payload as PluginConsentEvent]
            : [],
        );
        assert.equal(questions.length, 6, "only the unanswered question gains a closure, once");
        assert.deepEqual(questions.at(-1), {
          ...consent(threadId, "unanswered", "declined"),
          by: "restart",
          expiresAt: questions[0]!.expiresAt,
        });
        assert.equal(consentOutcomeWords(questions.at(-1)!), "Withdrawn when the studio restarted");
        assert.deepEqual(
          await reborn.store.chatState(threadId),
          [],
          "no stale question remains pinned outside history",
        );
        assert.equal(reborn.resolveConsent("unanswered", true), false, "a stale question cannot approve anything");
        assert.equal(
          events.some((event) => event.data.type === "custom" && event.data.event_type === "plugin_tool_started"),
          false,
        );
      }
      await reborn.stop();
    }
  });

  it("a boot closes the turn and the run the last process died inside — exactly once", async () => {
    const userData = path.join(await tmpDir("studio-interrupted-"), "userData");

    // The run before: a turn begun (durable before any model call) and a run started —
    // then the process dies with neither ever ended.
    const before = await makeCore(userData);
    const threadId = await before.store.createThread({ title: "crashed chat" });
    const turn = await new TurnFactory(before.store).beginTurn(threadId, {
      input: [{ role: "user", content: "make the boss meaner" }],
    });
    await before.store.appendEvents(threadId, [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "run_lost", project: "arena", goal: "beat the bar" },
      },
    ]);

    const reborn = await makeCore(userData);
    bootedCores.push(reborn);
    await reborn.start();

    const events = await reborn.store.listEvents(threadId);
    const ended = events.filter((e) => e.data.type === "turn_ended");
    assert.equal(ended.length, 1, "the stranded turn is closed");
    assert.equal(ended[0]!.turn_id, turn.turnId, "the closure names the turn it closes");
    assert.equal((ended[0]!.data as { status?: string }).status, "error");
    assert.equal(((ended[0]!.data as { metadata?: { interrupted?: boolean } }).metadata ?? {}).interrupted, true);
    assert.ok(
      events.some(
        (e) =>
          e.data.type === "error" &&
          /interrupted by a restart/i.test(e.data.message) &&
          /send a message to continue/i.test(e.data.message),
      ),
      "the chat says what happened and how a message continues it",
    );
    assert.deepEqual(await findInterruptedTurns(reborn.store, threadId), []);

    const finished = events.filter((e) => e.data.type === "custom" && e.data.event_type === "run_finished");
    assert.equal(finished.length, 1, "the stranded run is closed");
    const payload = (finished[0]!.data as { payload: Record<string, unknown> }).payload;
    assert.equal(payload.runId, "run_lost");
    assert.equal(payload.victory, false);
    assert.equal(payload.stoppedBecause, "interrupted by restart");
    assert.equal(payload.project, "arena", "the closure keeps the run's own story");
    assert.ok(payload.finishedAt, "the closure is datable");

    await reborn.stop();

    // The morning after the morning: a second boot has nothing left to close.
    const again = await makeCore(userData);
    bootedCores.push(again);
    await again.start();
    const later = await again.store.listEvents(threadId);
    assert.equal(later.filter((e) => e.data.type === "turn_ended").length, 1, "the turn is not closed twice");
    assert.equal(
      later.filter((e) => e.data.type === "custom" && e.data.event_type === "run_finished").length,
      1,
      "the synthetic run_finished is not appended twice",
    );
    await again.stop();
  });

  it("work that ended honestly is left exactly as it was", async () => {
    const userData = path.join(await tmpDir("studio-honest-"), "userData");

    const before = await makeCore(userData);
    const threadId = await before.store.createThread({ title: "finished chat" });
    const turn = await new TurnFactory(before.store).beginTurn(threadId, {
      input: [{ role: "user", content: "ship it" }],
    });
    await turn.end("ok");
    await before.store.appendEvents(threadId, [
      { type: "custom", event_type: "run_started", payload: { runId: "run_done", project: "arena", goal: "win" } },
      {
        type: "custom",
        event_type: "run_finished",
        payload: { runId: "run_done", victory: true, stoppedBecause: "victory", finishedAt: "2026-08-23T00:00:00Z" },
      },
    ]);
    const sizeBefore = (await before.store.listEvents(threadId)).length;

    const reborn = await makeCore(userData);
    bootedCores.push(reborn);
    await reborn.start();
    const events = await reborn.store.listEvents(threadId);
    assert.equal(events.length, sizeBefore, "a clean log gains nothing at boot");
    assert.ok(!events.some((e) => e.data.type === "error"), "no invented failures");
    await reborn.stop();
  });
});

it("boot persists interrupted Optimization and charges its active budget without starting a worker", async () => {
  const { emptyOptimization } = await import("../../src/harness-seed/loop/optimization.ts");
  const userData = path.join(await tmpDir("studio-opt-interrupted-"), "userData");
  const before = await makeCore(userData),
    threadId = await before.store.createThread({ title: "optimization interrupted" });
  const run = { runId: "run_opt_lost", project: "arena" };
  const result = emptyOptimization(run);
  result.phase = "building_candidate";
  result.sequence = 2;
  await before.store.writeArtifact(threadId, `autopilot_${run.runId}`, {
    phase: "optimization",
    optimization: {
      schemaVersion: 1,
      ...run,
      stageId: "optimization",
      phase: "building_candidate",
      baseline: null,
      candidate: null,
      adoptionIntent: null,
      result,
      budget: {
        allocatedMs: 100,
        consumedMs: 0,
        workerAllocatedMs: 45,
        workerConsumedMs: 0,
        activeSegmentStartedAt: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });
  await before.store.appendEvents(threadId, [
    { type: "custom", event_type: "run_started", payload: { ...run, mode: "autopilot" } },
  ]);
  const reborn = await makeCore(userData);
  bootedCores.push(reborn);
  await reborn.start();
  const events = await reborn.store.listEvents(threadId);
  const updates = events.filter((e) => e.data.type === "custom" && e.data.event_type === "optimization_updated");
  assert.equal(updates.length, 1);
  const cp = ((await reborn.store.readArtifact(threadId, `autopilot_${run.runId}`)) as any).optimization;
  assert.equal(cp.result.outcome, "interrupted");
  assert.equal(cp.budget.consumedMs, 100);
  assert.equal(cp.budget.workerConsumedMs, 45);
  assert.ok(!events.some((e) => e.data.type === "custom" && e.data.event_type === "delegation_started"));
  await reborn.stop();
});

it("boot finishes an interrupted Optimization adoption from what the game folder kept", async () => {
  const { emptyOptimization } = await import("../../src/harness-seed/loop/optimization.ts");
  const revision = { snapshotId: null, commit: "c".repeat(40), tree: "t".repeat(40) };
  const scenarios = [
    { retained: "candidate", outcome: "improved", adopted: true, summary: "adoption recovered after restart" },
    { retained: "changed", outcome: "interrupted", adopted: false, summary: "they were preserved" },
    { retained: "baseline", outcome: "interrupted", adopted: false, summary: "were not applied" },
  ] as const;
  for (const scenario of scenarios) {
    const userData = path.join(await tmpDir("studio-opt-adoption-"), "userData");
    const before = await makeCore(userData);
    const threadId = await before.store.createThread({ title: `adoption ${scenario.retained}` });
    const run = { runId: `run_opt_${scenario.retained}`, project: "arena" };
    const result = emptyOptimization(run);
    result.phase = "adopting";
    await before.store.writeArtifact(threadId, `autopilot_${run.runId}`, {
      phase: "optimization",
      optimization: {
        schemaVersion: 1,
        ...run,
        stageId: "optimization",
        phase: "adopting",
        baseline: { revision, verified: true, qualityVerdict: null, evidenceRefs: [], checkResults: null },
        candidate: null,
        adoptionIntent: { expectedLive: revision, verifiedCandidate: revision, validationArtifact: "v.json" },
        result,
        budget: {
          allocatedMs: 100,
          consumedMs: 10,
          workerAllocatedMs: 45,
          workerConsumedMs: 5,
          activeSegmentStartedAt: null,
        },
      },
    });
    await before.store.appendEvents(threadId, [
      { type: "custom", event_type: "run_started", payload: { ...run, mode: "autopilot" } },
    ]);
    const reborn = await makeCore(userData);
    bootedCores.push(reborn);
    reborn.candidates.reconcile = async () => ({ revision, retained: scenario.retained });
    await reborn.start();
    const cp = ((await reborn.store.readArtifact(threadId, `autopilot_${run.runId}`)) as any).optimization;
    assert.equal(cp.phase, "interrupted", scenario.retained);
    assert.equal(cp.result.outcome, scenario.outcome, scenario.retained);
    assert.equal(cp.result.candidateAdopted, scenario.adopted, scenario.retained);
    assert.deepEqual(cp.result.retainedRevision, revision, scenario.retained);
    assert.ok(cp.result.summary.includes(scenario.summary), `${scenario.retained}: ${cp.result.summary}`);
    assert.equal(cp.result.phase, "terminal", scenario.retained);
    assert.equal(cp.budget.consumedMs, 10, `${scenario.retained}: no active segment to charge`);
    await reborn.stop();
  }
});

/**
 * A director's run is the default unattended path, and the repair above used to miss it
 * entirely: the run is registered as `mode: "autopilot"` and started as `mode: "director"`, and
 * the closure gated its pause on the second value. So a run the user quit the app on was
 * closed as dead — no Resume, no head, no "play this build" — while its merges sat on
 * `refs/studio/runs/<id>/integration` with nobody told they existed.
 */
it("a director's run the app died inside is paused with the head it reached, not buried", async () => {
  const { latestRun } = await import("../../src/shared/coordinator.ts");
  const userData = path.join(await tmpDir("studio-director-interrupted-"), "userData");
  const runId = "run_paused";
  const base = "a".repeat(40);
  const head = "b".repeat(40);

  const before = await makeCore(userData);
  const threadId = await before.store.createThread({ title: "the run" });
  // The order a real director's run writes them in.
  await before.store.appendEvents(threadId, [
    {
      type: "custom",
      event_type: "run_registered",
      payload: { runId, project: "plaza", goal: "a plaza to skate", mode: "autopilot" },
    },
    {
      type: "custom",
      event_type: "run_started",
      payload: { runId, project: "plaza", goal: "a plaza to skate", mode: "director" },
    },
  ]);
  await before.store.writeArtifact(threadId, `autopilot_${runId}`, {
    runId,
    run: { runId, project: "plaza", goal: "a plaza to skate", mode: "autopilot" },
    mode: "director",
    phase: "director",
    director: { sessionId: "director-1", baseCommit: base, integrationHead: head, workers: {}, notes: [] },
  });

  const reborn = await makeCore(userData);
  bootedCores.push(reborn);
  await reborn.start();

  const events = await reborn.store.listEvents(threadId);
  const finished = events.filter((e) => e.data.type === "custom" && e.data.event_type === "run_finished");
  assert.equal(finished.length, 1, "the stranded run is closed exactly once");
  const payload = (finished[0]!.data as { payload: Record<string, unknown> }).payload;
  assert.equal(payload.stoppedBecause, "interrupted by restart");
  assert.equal(payload.mode, "director", "the run keeps its own identity");
  assert.equal(payload.landed, false, "nothing was landed — and the closure says so");
  assert.equal(payload.integrationHead, head, "the head the run reached");
  assert.equal(payload.baseCommit, base);
  assert.equal(
    payload.integrationRef,
    `refs/studio/runs/${runId}/integration`,
    "reachable whatever happened to the worktree",
  );
  // Exactly the condition the chat and the Builds tab ask before offering the build.
  assert.ok(
    payload.landed === false &&
      typeof payload.integrationHead === "string" &&
      payload.integrationHead !== payload.baseCommit,
    "the Play this build / Make it live card has everything it needs",
  );
  assert.ok(
    events.some(
      (e) =>
        e.data.type === "custom" &&
        e.data.event_type === "autopilot_paused" &&
        (e.data.payload as { runId?: string }).runId === runId,
    ),
    "paused, not finished-dead",
  );

  // The two gates Resume asks: the journal is not done, and the run reads as paused.
  const journal = (await reborn.store.readArtifact(threadId, `autopilot_${runId}`)) as {
    phase?: string;
    director?: { integrationHead?: string };
  };
  assert.equal(journal.phase, "paused");
  assert.equal(journal.director?.integrationHead, head, "the journal still points at the head a resume forks from");
  assert.equal(latestRun(events)?.state, "paused");
  await reborn.stop();
});

/**
 * The other half of the same closure: a run that merged nothing. A classic pipeline never
 * journals a head at all, and a director killed before its first integrate is still standing on
 * the base it forked from. Claiming `landed: false` there told the morning card "the build is
 * kept and playable" and then gave it no build to offer — a sentence with nothing to press.
 */
it("a run that merged nothing is paused without promising a build", async () => {
  for (const [name, director] of [
    ["a classic run, which journals no head at all", null],
    [
      "a director killed before its first merge",
      { sessionId: "director-1", baseCommit: "c".repeat(40), integrationHead: "c".repeat(40), workers: {}, notes: [] },
    ],
  ] as Array<[string, Record<string, unknown> | null]>) {
    const userData = path.join(await tmpDir("studio-nothing-merged-"), "userData");
    const runId = "run_empty";
    const before = await makeCore(userData);
    const threadId = await before.store.createThread({ title: name });
    await before.store.appendEvents(threadId, [
      { type: "custom", event_type: "run_started", payload: { runId, project: "plaza", goal: "a plaza to skate" } },
    ]);
    await before.store.writeArtifact(threadId, `autopilot_${runId}`, {
      runId,
      phase: director ? "director" : "facets",
      ...(director ? { mode: "director", director } : {}),
    });

    const reborn = await makeCore(userData);
    bootedCores.push(reborn);
    await reborn.start();
    const events = await reborn.store.listEvents(threadId);
    const payload = (
      events.find((e) => e.data.type === "custom" && e.data.event_type === "run_finished")!.data as {
        payload: Record<string, unknown>;
      }
    ).payload;
    assert.equal(payload.stoppedBecause, "interrupted by restart", name);
    assert.equal(payload.landed, undefined, `${name}: no build was kept, so none is claimed`);
    assert.equal(payload.integrationHead, undefined, `${name}: there is no head to offer`);
    assert.equal(payload.integrationRef, undefined, `${name}: and no ref that was ever written`);
    // The work is still there to resume — the closure is honest, not empty.
    assert.ok(
      events.some(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === "autopilot_paused" &&
          (e.data.payload as { runId?: string }).runId === runId,
      ),
      `${name}: paused, so Resume is offered`,
    );
    assert.equal(
      ((await reborn.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string }).phase,
      "paused",
      name,
    );
    await reborn.stop();
  }
});

/**
 * Wrap up is a durable ask for the run's current session. A press that lands after the run is
 * over is refused: the Stop sheet stays open when the run ends under it, and there is nothing
 * running to wrap up. A resumed run registers again and ignores asks made before it
 * (`finishRequested`), so even a stale ask could not make it skip every builder. Both doors —
 * the sheet's IPC and the coordinator's `finish_run` — go through this one guard.
 */
it("a wrap-up asked of a build that is already over is refused, so a Resume cannot inherit it", async () => {
  const userData = path.join(await tmpDir("studio-wrapup-"), "userData");
  const core = await makeCore(userData);
  bootedCores.push(core);
  const threadId = await core.store.createThread({ title: "the run" });
  const runId = "run_wrapping";
  const asks = async (): Promise<number> =>
    (await core.store.listEvents(threadId)).filter(
      (e) =>
        e.data.type === "custom" &&
        e.data.event_type === "run_control" &&
        (e.data.payload as { runId?: string; action?: string }).runId === runId &&
        (e.data.payload as { action?: string }).action === "finish",
    ).length;

  await core.store.appendEvents(threadId, [
    { type: "custom", event_type: "run_started", payload: { runId, project: "plaza", goal: "a plaza to skate" } },
  ]);
  await core.requestRunFinish(threadId, runId);
  await core.requestRunFinish(threadId, runId);
  assert.equal(await asks(), 1, "however often it is pressed, the running build is asked once");

  // The run ends under the open sheet — a session limit closes it as paused, which is exactly
  // the run a user resumes tomorrow.
  await core.store.appendEvents(threadId, [
    {
      type: "custom",
      event_type: "run_finished",
      payload: { runId, victory: false, stoppedBecause: "the account's limit" },
    },
    { type: "custom", event_type: "autopilot_paused", payload: { runId } },
  ]);
  await assert.rejects(() => core.requestRunFinish(threadId, runId), /no longer running/, "the late press is refused");
  assert.equal(await asks(), 1, "and nothing is written for the run to inherit");
  await assert.rejects(() => core.requestRunFinish(threadId, "run_elsewhere"), /not in this conversation/);
  await core.stop();
});
