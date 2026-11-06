/**
 * A director's run at Genex's moments, through the real core and harness: its start
 * (`run.prepare`) runs the game's plugins' steps before any lead turn, and what they found (a block,
 * or Genex's hold that skipped a step) is its lead's first line, never a closed run; a Stop while
 * those steps work is the user's stop; and the run's end (`run.end`) is announced once, however it
 * ended.
 *
 * The local test plugin `hk5` (`helpers/hook-plugin.ts`) hooks both for every game; its start step
 * needs its lock `stage`, whose probe the test scripts.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, it } from "node:test";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import { type HookPackage, STAGE_PLUGIN, stagePackage } from "../helpers/hook-plugin.ts";
import { customEvents, makeFakePreview, type Rig, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** No run here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** A run on a game whose plugin hooks the run's start and end, with a lead that records each turn it is asked for. */
async function stagedRun(name: string, budgets: Record<string, unknown> = {}) {
  // The locks' clock moves on by itself: a wait for the person passes in no real time.
  let skew = 0;
  const rig = await startRig(
    { replies: [] },
    {
      previewPoolMax: 3,
      createHeadlessPreview: async () => makeFakePreview(),
      locks: {
        now: () => Date.now() + skew,
        sleep: async (ms: number) => {
          skew += ms;
          await nextTurn();
        },
      },
    },
  );
  rigs.push(rig);
  const stage: HookPackage = await stagePackage();
  await rig.core.plugins.installLocal(stage.dir, PluginSourceKind.Local, []);
  await rig.core.plugins.setEnabled(STAGE_PLUGIN, true);
  const project = await rig.core.games.scaffold(name, { title: name });
  const runId = rig.core.newRunId();
  const leadTurns: DelegateRequest[] = [];
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
      if (request.director) leadTurns.push(request);
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "lead-1", summary: "done" };
    },
  } as never);
  const dispatch = () =>
    rig.core
      .dispatchRun({
        runId,
        goal: "a lit stage",
        project: project.name,
        mode: "autopilot",
        engine: "codex",
        reference: { name: "Stage", shots: [] },
        budgets,
      } as never)
      .catch(() => {});
  const finished = async () => {
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      150_000,
      `${name} run_finished`,
    );
    return customEvents(events, "run_finished").find((e) => e.runId === runId) as Record<string, unknown>;
  };
  return { rig, stage, runId, leadTurns, dispatch, finished };
}

/** How many times the plugin's log holds `entry`. */
const count = async (stage: HookPackage, entry: string) => (await stage.trail()).filter((at) => at === entry).length;

describe("a director's run at Genex's moments", () => {
  // Flipped: the run closed before any lead turn, in the Loop's words ("a plugin of this project
  // held it back: The stage is being swept."); every start is its lead's, which reads why.
  it("a run whose start a plugin's step blocks runs, its lead's first message saying why, and its end is announced once", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { stage, leadTurns, dispatch, finished } = await stagedRun("stage-blocked");
    await stage.script({ "run.prepare:gate": { block: "The stage is being swept." } });
    const running = dispatch();
    const ended = await finished();
    await running;
    const [first] = leadTurns;
    assert.ok(first, "its lead's session opened");
    assert.match(first.prompt, /The stage is being swept\./);
    assert.doesNotMatch(String(ended.stoppedBecause), /held it back/);
    assert.equal(await count(stage, "run.end:farewell"), 1, "the run's end is announced once");
  });

  // Flipped: Genex's hold closed the run before any lead turn ("waited for you to finish in Stage, so
  // the run didn't start"); the step that needs the stage is skipped, and its lead reads that.
  it("a run whose start Genex held for the person skips the step that needs the stage and runs, its lead told in Genex's words", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { stage, leadTurns, dispatch, finished } = await stagedRun("stage-person");
    await stage.script({ probe: { personActive: true } });
    const running = dispatch();
    const ended = await finished();
    await running;
    const [first] = leadTurns;
    assert.ok(first, "its lead's session opened");
    assert.match(first.prompt, /Genex skipped a step of the game's plugins while you were using Stage\./);
    assert.doesNotMatch(String(ended.stoppedBecause), /didn't start/);
    assert.equal(await count(stage, "run.prepare:gate"), 0, "the step that needs the stage never ran");
    assert.equal(await count(stage, "run.end:farewell"), 1);
  });

  it("a Stop while the run's start steps work closes it as the user's stop, never as a run that didn't start", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, stage, runId, leadTurns, dispatch, finished } = await stagedRun("stage-stopped");
    const gate = path.join(await tmpDir("stage-gate-"), "go");
    await stage.script({ "run.prepare:gate": { until: gate } });
    const running = dispatch();
    for (let tries = 0; tries < 600 && (await count(stage, "run.prepare:gate")) === 0; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await count(stage, "run.prepare:gate"), 1, "the start step is working");
    await rig.core.stopRun(runId);
    // The Stop ends the step's moment: the run closes without the step ever answering.
    const ended = await finished();
    await writeFile(gate, "");
    await running;
    assert.equal(leadTurns.length, 0, "no session opened");
    assert.equal(ended.stoppedBecause, "stopped by the user");
    assert.equal(await count(stage, "run.end:farewell"), 1);
  });

  // Deleted (no clock): "a run whose lead turns a plugin keeps holding back ends saying why" ran a
  // Loop whose time was up, so its held turn gave up at once. A held turn now waits until the plugin
  // lets it start or the person stops the run (hook-moments.test.ts, the held turn's rows).
});
