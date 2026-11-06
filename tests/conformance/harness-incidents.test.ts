import { OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
/**
 * Incident tests for the loop. One `it` per incident from the
 * morrowind-2 and shooter postmortems, named after it, on the real rig (a real StudioCore,
 * real git, a fake delegated engine, a fake preview) or on the pure functions the fix lives
 * in. A change under `src/harness-seed/**` without a row here that would have failed on the
 * incident it fixes is not done; every future postmortem adds rows before its fixes land.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import {
  EngineError,
  type CompleteRequest,
  type DelegateRequest,
  type SteerMessage,
  type SteerSend,
} from "../../src/substrate/engines/types.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { MessageFrom } from "../../src/shared/engine-requests.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { forgetProviderLosses, noteProviderLoss, providerLossFor } from "../../src/harness-seed/loop/provider-loss.ts";
import { createRunInbox, type RunInbox } from "../../src/harness-seed/loop/run-inbox.ts";
import { runWakeLoop, type DirectorTalk } from "../../src/harness-seed/loop/director/wake.ts";
import { LOOP_WORDS } from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { chatWaitsFor, leadDoor, stopRunsOf } from "../../src/harness-seed/loop/live-chat.ts";
import { steeredCall } from "../../src/harness-seed/loop/chat-steer.ts";
import { steerFeed, steerSession, userFrame } from "../../src/substrate/engines/claude-steer.ts";
import { openLeadLine } from "../../src/harness-seed/loop/director/lead-line.ts";
import { handleUserMessage } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { resumeStopped } from "../../src/harness-seed/loop/after-loop-run.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { setImmediate as nextTurn } from "node:timers/promises";
import { cancelThread } from "../../src/harness-seed/loop/main.ts";
import type { Studio } from "../../src/harness-seed/loop/studio-state.ts";
import type { Host } from "../../src/harness-seed/types/harness.d.ts";
import { folderLabelOf } from "../../src/harness-seed/loop/workers/identity.ts";

it("WIN-FOLDER-LABEL: a Windows game folder is named by its last two parts, never the whole C:\\Users path", () => {
  assert.equal(folderLabelOf("C:\\Users\\ana\\AI Games\\rift", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf("C:/Users/ana/AI Games/rift/", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf("/Users/ana/AI Games/rift", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf(null, "rift"), "rift");
});

it("AUDIT-STOP-RACE: cancellation is visible before a delayed queue-pause write", async () => {
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const studio: Studio = {
    host: { call: async () => null, notify: () => {}, heartbeat: () => {}, workspace: "/fixture" } as Host,
    cancels: new Set(),
    stoppedMessages: new Set(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => {
      throw new Error("unused fixture scope");
    },
  };
  const stopping = cancelThread(studio, { current: () => "message", pause: () => paused }, "thread");
  try {
    assert.equal(studio.cancels.has("thread"), true);
    assert.equal(studio.stoppedMessages?.has("message"), true);
  } finally {
    release();
    await stopping;
  }
});
import { tmpDir } from "../helpers/tmp.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import { JOB_POLL_MS } from "../../src/harness-seed/loop/jobs/watch.ts";
import { jobEndLine } from "../../src/harness-seed/loop/jobs/prompts.ts";
import { RUN_POOL_WORDS } from "../../src/harness-seed/loop/workers/prompts.ts";
import { describeUnknownImage, sniffImage } from "../../src/substrate/image-sniff.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { runTurn } from "../../src/harness-seed/loop/turn-loop.ts";
import { materializePrompt } from "../../src/harness-seed/loop/prompt.ts";
import { toPiMessages } from "../../src/substrate/engines/ollama.ts";
import { killTree } from "../../src/substrate/spawn.ts";
const rigs: Rig[] = [];
/** The core's RPC table, as the harness child sees it. */
const apiOf = (rig: Rig) => rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** A minimal AVIF: an ISO BMFF `ftyp` box with the avif brand — what a phone exports as ".jpg". */
const AVIF_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from("ftypavif", "latin1"),
  Buffer.alloc(24, 0),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

type FakeEngineHooks = {
  complete: (text: string, request: CompleteRequest) => string | null | Promise<string | null>;
  delegate: (request: DelegateRequest) => Promise<Record<string, unknown> | null>;
};

/** A scripted contractor + judge on the rig; `complete` sees the flattened prompt, `delegate` the request. */
/** Settles once `signal` aborts (a Stop), or at once when it already has or there is none. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function registerFakeEngine(rig: Rig, hooks: FakeEngineHooks, id = "fake-delegate"): void {
  rig.core.engines.register({
    id,
    label: "Fake contractor",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async (request: CompleteRequest) => {
      const text = request.messages.map((m) => String(m.content)).join("\n") + "\n" + (request.systemPrompt ?? "");
      const reply = (await hooks.complete(text, request)) ?? defaultJudge(text, request);
      return {
        message: { role: "assistant", content: reply },
        usage: {},
        stopReason: "stop",
        model: "fake",
        engine: id,
      };
    },
    delegate: async (request: DelegateRequest) => {
      const extra = (await hooks.delegate(request)) ?? {};
      return { ok: true, summary: "ok", usage: {}, turns: 1, engine: id, ...extra };
    },
  });
}

/**
 * Answer a batched board of picture questions — one call per camera since M3.10, with one reply
 * keyed by check id. Every question the `no` pattern names is answered no; the rest, yes.
 */
function answerBatch(text: string, options: { no?: RegExp; note?: string } = {}): string {
  const answers: Record<string, unknown> = {};
  for (const [, id, ask] of text.matchAll(/^- (\S+) — IMAGE [^:]*: (.*)$/gm)) {
    answers[id!] = options.no?.test(`${id} ${ask}`)
      ? { answer: "no", confidence: 0.9, note: options.note ?? "still there" }
      : { answer: "yes", confidence: 0.9, note: "seen" };
  }
  return JSON.stringify({ answers });
}

/** The synthetic preview encodes its capture counter in pixels; scripted judges prefer the newer fixture image. */
function newestFixtureBuild(request: CompleteRequest): "A" | "B" {
  const latest = { A: 0, B: 0 };
  for (const image of request.messages.flatMap((message) => message.images ?? [])) {
    const side = image.label?.startsWith("BUILD A") ? "A" : image.label?.startsWith("BUILD B") ? "B" : null;
    if (!side) continue;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length >= 7) latest[side] = Math.max(latest[side], bytes.readUInt32BE(3));
  }
  return latest.A >= latest.B ? "A" : "B";
}

/** Judges that keep the loop moving: checks pass, the taste judge is never satisfied, panels prefer the reference. */
function defaultJudge(text: string, request: CompleteRequest): string {
  if (text.includes("QUESTIONS (")) return answerBatch(text);
  if (text.includes("QUESTION:")) return JSON.stringify({ answer: "yes", confidence: 0.9, note: "seen" });
  if (text.includes("DIFF:")) return JSON.stringify({ violations: [], summary: "clean" });
  if (text.includes("THE FACET UNDER JUDGEMENT")) {
    const pick = newestFixtureBuild(request);
    return JSON.stringify({
      pick,
      satisfied: false,
      regression: null,
      newCheck: null,
      defects: [],
      reason: "scripted",
    });
  }
  if (text.includes("BUILD A") && text.includes("BUILD B")) {
    const pick = newestFixtureBuild(request);
    return JSON.stringify({ pick, biggest_gap: "", reason: "scripted global" });
  }
  if (text.includes("REFERENCE:"))
    return JSON.stringify({
      looks: "reference",
      plays: "reference",
      better: "",
      biggest_gap: "flat",
      reason: "scripted panel",
    });
  return "ok";
}

function twoFacetPlan(extra: { waterChecks?: unknown[]; skyChecks?: unknown[]; more?: unknown[] } = {}) {
  return {
    facets: [
      {
        id: "water",
        title: "Water",
        intent: "a dark mirror marsh",
        owns: ["src/water.js"],
        identity: ["marsh"],
        budgetShare: 0.5,
        checks: extra.waterChecks ?? [
          { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        ],
      },
      {
        id: "sky",
        title: "Sky",
        intent: "a sun in the sky",
        owns: ["src/sky.js"],
        identity: ["sun"],
        budgetShare: 0.5,
        checks: extra.skyChecks ?? [
          { id: "sky-lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        ],
      },
      ...(extra.more ?? []),
    ],
    mainOwner: "water",
    base: null,
    integrationNotes: "",
    assumptions: [],
  };
}

async function runAutopilot(
  rig: Rig,
  project: string,
  options: { budgets?: Record<string, unknown>; reference?: Record<string, unknown>; engine?: string } = {},
) {
  const runId = rig.core.newRunId();
  await rig.core.dispatchRun({
    runId,
    goal: "a marsh with a sun",
    project,
    mode: "autopilot",
    classic: true,
    engine: options.engine ?? "fake-delegate",
    reference: options.reference ?? { name: "quiet marsh", shots: [], kind: "direction" },
    budgets: { wallClockMs: 3_600_000, maxIterations: 10, review: true, ...(options.budgets ?? {}) },
  } as never);
  const events = await waitForLog(
    rig.core,
    (log) =>
      log.some(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === "run_finished" &&
          (e.data.payload as { runId?: string } | undefined)?.runId === runId,
      ),
    240_000,
    `${project} run_finished`,
  );
  return { runId, events };
}

describe("harness incidents", () => {
  it("6. D3 stills: an AVIF named .jpg is refused at save with a log; sniffing names what it is", async () => {
    assert.equal(sniffImage(AVIF_BYTES), null);
    assert.equal(describeUnknownImage(AVIF_BYTES), "AVIF");
    assert.equal(sniffImage(JPEG_BYTES)?.mimeType, "image/jpeg");
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]))?.ext, ".png");
    const rig = await startRig();
    rigs.push(rig);
    await apiOf(rig)["game.scaffold"]!({ name: "stillworld", title: "Stills" });
    const saved = await rig.core.saveReferenceFrames("stillworld", [
      { label: "image-psd-102", mimeType: "image/jpeg", data: AVIF_BYTES.toString("base64") },
      { label: "dock", mimeType: "image/jpeg", data: JPEG_BYTES.toString("base64") },
    ]);
    assert.equal(saved.length, 1, "only the real JPEG was saved");
    assert.match(saved[0]!.file, /dock-[0-9a-f]{8}\.jpg$/);
    assert.ok(
      rig.logs.some((line) => /reference skipped: image-psd-102 is AVIF/.test(line)),
      `the log says why: ${rig.logs.filter((l) => /reference/.test(l)).join(" | ")}`,
    );
    // game.read refuses the renamed file rather than declaring it a JPEG.
    const refDir = path.join(rig.core.layout.gamesRoot, "stillworld", "references");
    await writeFile(path.join(refDir, "renamed.jpg"), AVIF_BYTES);
    await assert.rejects(apiOf(rig)["game.read"]!({ project: "stillworld", file: "references/renamed.jpg" }), /AVIF/);
    const listed = await rig.core.referenceStills("stillworld");
    assert.deepEqual(
      listed.frames.map((f) => f.label),
      ["dock-" + saved[0]!.file.slice(-12, -4)],
    );
    assert.equal(listed.skipped.length, 1);
    assert.match(listed.skipped[0]!.why, /AVIF/);
  });

  // ── provider outages and judge failures ──
});

describe("the modeller in the loop (AG-930)", () => {
  it("T-Snapshot. a plugin disabled while a builder's tools are prepared leaves its tools and its guidance in agreement", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        requests.push(request);
        return { sessionId: "ses" };
      },
    });
    await rig.core.games.scaffold("snapshot-world");
    const threadId = await rig.core.createGameThread("snapshot-world");
    // The disable lands in the one await every builder's preparation makes: the connectors' tool lists.
    const mcp = rig.core.mcp;
    const toolsReport = mcp.toolsReport.bind(mcp);
    mcp.toolsReport = async (...args: Parameters<typeof toolsReport>) => {
      await rig.core.plugins.setEnabled("genex", false);
      return toolsReport(...args);
    };
    await apiOf(rig)["engine.delegate"]!({
      engine: "fake-delegate",
      project: "snapshot-world",
      threadId,
      prompt: "build",
    });
    const [request] = requests;
    assert.ok(request, "the builder was asked");
    const tools = request.liveTools?.some((t) => t.name === "genex__asset") ?? false;
    // An engine with no system channel reads its system text as a new session's first notice.
    const guidance = [...(request.notices ?? []), request.prompt].join("\n\n").includes("[genex/genex-tool-model]");
    assert.equal(guidance, tools, "a brief never names a skill whose tools it lacks, nor tools it never explains");
    assert.equal(tools, true, "both come from the plugins as the session began");
  });

  // Flipped (T-Withdrawn, T-Withdrawn-Failed, T-Withdrawn-Interleaved): a resumed session was told
  // first which plugins and skills were withdrawn since it last ran. Its tools are what it is handed
  // on each launch; no notice says what changed, and nothing is recorded to compare against.
  it("T-Withdrawn. a resumed builder session after a plugin was turned off reads its words alone, without that plugin's tools", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        requests.push(request);
        return { sessionId: "ses" };
      },
    });
    await rig.core.games.scaffold("withdrawn-world");
    const threadId = await rig.core.createGameThread("withdrawn-world");
    const delegate = async (resume?: string) => {
      await apiOf(rig)["engine.delegate"]!({
        engine: "fake-delegate",
        project: "withdrawn-world",
        threadId,
        prompt: "build",
        ...(resume ? { resume } : {}),
      });
      const request = requests.at(-1);
      assert.ok(request);
      return request;
    };
    const genexTools = (request: DelegateRequest) =>
      request.liveTools?.some((t) => t.name.startsWith("genex__")) ?? false;
    assert.equal(genexTools(await delegate()), true, "a first session is handed the Genex plugin");
    await rig.core.plugins.setEnabled("genex", false);
    const resumed = await delegate("ses");
    assert.equal(resumed.prompt, "build");
    assert.equal(resumed.notices, undefined, "no notice of what changed");
    assert.equal(genexTools(resumed), false, "its tools are what is on now");
  });
});

describe("the loop dies in the middle of the run (M3.9)", () => {
  /**
   * Poll until it holds, or say what was still true when the clock ran out: a label given as a
   * function is read then, not when the wait began.
   */
  async function until(
    condition: () => boolean | Promise<boolean>,
    label: string | (() => string),
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * The 1 am incident: the harness child dies, the app restarts it in seconds, and five
   * contractors keep editing worktrees for another forty minutes with no loop left to judge,
   * commit or land a single round — while the chat still says the run is running, the Mac
   * stays awake and Cmd-Q still asks about a run nobody is running. Every clause below is one
   * of those forty minutes.
   */
  it("aborts every contractor, settles the run, and closes the run in its own thread as paused with a Resume", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    // The pause itself is what this row reads: the host's automatic resume has a row of its own.
    await rig.core.updateSettings({ autoResume: false });
    const project = await rig.core.games.scaffold("crash-run", { title: "Crash run" });
    const aborts = { lead: 0, builder: 0 };
    // Each engine's session once it listens for the abort. The host lists a delegation before it
    // calls the engine, so a kill that lands in between aborts a signal no listener has heard yet.
    const building = { lead: false, builder: false };
    const letBuilderGo: Array<() => void> = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          // Registered before the first tool call: the kill below may land in the middle of one.
          const aborted = new Promise<void>((resolve) =>
            request.signal!.addEventListener("abort", () => {
              aborts.lead++;
              resolve();
            }),
          );
          building.lead = true;
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args).catch(() => "");
          await call("worker_start", { title: "Plaza", task: "paint the plaza red", isolation: "copy" });
          // A lead that lets go when it is told to — the session ends on the abort.
          await aborted;
          return { sessionId: "director-1", summary: "the lead was aborted" };
        }
        // The worker, in its copy of the game, that shrugs off the first signal, which is the
        // one Stop must still reach: the scripted lead is what the run is waiting on when the loop dies.
        return new Promise<Record<string, unknown>>((resolve) => {
          request.signal!.addEventListener("abort", () => {
            aborts.builder++;
          });
          building.builder = true;
          letBuilderGo.push(() => resolve({ sessionId: "worker-1", summary: "let go" }));
        });
      },
    });

    const runId = rig.core.newRunId();
    // Never awaited: the run is meant to be in flight when the loop under it dies.
    void rig.core
      .dispatchRun({
        runId,
        goal: "a red plaza",
        project: project.name,
        mode: "autopilot",
        engine: "fake-delegate",
        reference: { name: "plaza", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      } as never)
      .catch(() => {});
    const delegations = async () =>
      (await apiOf(rig)["engine.delegations"]!({})) as Array<{ project: string; cwd: string }>;
    await until(() => building.lead && building.builder, "the lead and one builder to be building", 180_000);

    // 1 am.
    const pid = rig.core.host.pid;
    assert.ok(pid, "the harness child has a pid to kill");
    killTree(pid);

    // Nothing that was in flight can be judged or committed by a loop that no longer exists.
    await until(
      () => aborts.lead >= 1 && aborts.builder >= 1,
      () => `every contractor to be aborted (lead ${aborts.lead}, builder ${aborts.builder})`,
      60_000,
    );
    // …and nothing may keep the Mac awake, the quit gate armed or the pill spinning for it.
    assert.ok(
      rig.events.some((e) => e.type === "run.settled" && (e.payload as { runId?: string }).runId === runId),
      "the run settled the moment its loop died",
    );

    // The reborn loop owes the run an ending where the user is looking.
    const threadId = await rig.core.threadForGame(project.name);
    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "autopilot_paused").some((e) => e.runId === runId),
      "the paused card in the game's own chat",
      120_000,
    );
    const inThread = await rig.core.store.listEvents(threadId);
    const finished = customEvents(inThread, "run_finished").find((e) => e.runId === runId);
    assert.ok(finished, "the run was closed");
    assert.equal(finished!.stoppedBecause, "the studio's loop crashed and restarted");
    assert.equal(finished!.victory, false);
    assert.equal(finished!.project, project.name);
    const main = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(
      customEvents(main, "run_finished").filter((e) => e.runId === runId).length,
      0,
      "the ending is in the game's chat, not the studio's",
    );
    // Paused, not dead: what makes the card's Resume real is the journal it can pick up from.
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string } | null;
    assert.equal(journal?.phase, "paused", "the journal says the run can be picked up again");

    // A contractor that did not die on the signal is still the app's to reach: its entry stays
    // registered, which is what the next test's Stop depends on.
    assert.ok(
      (await delegations()).some((d) => d.project === project.name),
      "the builder the crash could not kill is still held by the app",
    );

    for (const go of letBuilderGo) go();
  });

  /**
   * The other half of the same run: the loop that started the run is gone, so `activeRuns`
   * knows nothing about it — but the contractors are the *app's*, not the loop's, and the run's
   * own start event still says which project they were hired for. Without the fallback, Stop
   * after a restart is a notification and nothing else.
   */
  it("a run this incarnation of the loop never started can still be stopped: the builders are reached by the project its start event names", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("stop-after-restart", { title: "Stop after restart" });
    const threadId = await rig.core.threadForGame(project.name);
    const runId = "run_orphaned";
    // The run as the previous incarnation left it, and as the reborn loop's own repair closed it.
    await rig.core.store.appendEvents(threadId, [
      {
        type: "custom",
        event_type: "run_registered",
        payload: { runId, project: project.name, goal: "a red plaza", mode: "autopilot" },
      },
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId, project: project.name, goal: "a red plaza", mode: "director" },
      },
      {
        type: "custom",
        event_type: "run_finished",
        payload: {
          runId,
          project: project.name,
          victory: false,
          stoppedBecause: "the studio's loop crashed and restarted",
        },
      },
    ]);
    let aborted = 0;
    const letGo: Array<() => void> = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) =>
        new Promise<Record<string, unknown>>((resolve) => {
          request.signal!.addEventListener("abort", () => {
            aborted++;
          });
          letGo.push(() => resolve({ sessionId: "worker-1", summary: "let go" }));
        }),
    });
    const api = apiOf(rig);
    void (api["engine.delegate"] as (p: unknown) => Promise<unknown>)({
      project: project.name,
      prompt: "keep painting",
      engine: "fake-delegate",
    }).catch(() => {});
    await until(
      async () => ((await api["engine.delegations"]!({})) as unknown[]).length === 1,
      "the contractor to be building",
    );

    // The notice the host sends a reborn loop: these runs were in flight when the last one died.
    await rig.core.host.dispatch({
      type: "boot_notice",
      notice: { reason: "crash_restart", detail: "exit code 1", openRuns: [runId] },
    });
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await until(() => aborted >= 1, "Stop to reach the contractor the previous loop briefed", 30_000);

    for (const go of letGo) go();
  });
});

/**
 * The run after the 1 am incident: paused with a Resume, and Resume pressed. The resumed run
 * used to know only what its brief said — the names of the workers from before, "gone" — and
 * nothing of what they had built, what the judges had shelved or what had happened since the
 * lead last looked; and it got a whole fresh budget, as every Resume did. Everything a run
 * needs to go on is in its journal now — the time it has worked among it, so a Resume goes on with
 * what the budget has left — and the resumed lead's first message is read from it.
 */
describe("a run the loop died in, resumed (the full journal)", () => {
  async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const BUDGET_MS = 30 * 60_000;

  it("crash mid-build with Resume builds automatically on: the host resumes the paused run once, as soon as its loop is back", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    assert.equal(rig.core.settings.autoResume, true, "on by default");
    const project = await rig.core.games.scaffold("auto-resume-run", { title: "Auto resume run" });
    const lead: DelegateRequest[] = [];
    let crashed = false;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          lead.push(request);
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args).catch(() => "");
          if (crashed) {
            await call("finish", { land: "no", summary: "picked up on its own" });
            return { sessionId: "lead-1", summary: "finished" };
          }
          await call("worker_start", { title: "Dusk sky", task: "Build a dusk sky over the plaza", isolation: "copy" });
          return { sessionId: "lead-1", summary: "the sky is building" };
        }
        // The worker, in its copy of the game, builds until the loop under it dies.
        return new Promise<Record<string, unknown>>((resolve) =>
          request.signal!.addEventListener("abort", () => resolve({ ok: false, stopReason: "stopped", summary: "" })),
        );
      },
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a dusk plaza",
        project: project.name,
        mode: "autopilot",
        engine: "fake-delegate",
        reference: { name: "Dusk", shots: [] },
        budgets: { wallClockMs: BUDGET_MS },
      } as never)
      .catch(() => {});
    const threadId = await rig.core.threadForGame(project.name);
    const journal = async () =>
      ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`).catch(() => null)) ?? null) as Record<
        string,
        any
      > | null;
    await until(
      async () => lead.length === 1 && Boolean((await journal())?.director?.wake),
      "the lead to rest with the sky building",
      180_000,
    );

    crashed = true;
    const pid = rig.core.host.pid;
    assert.ok(pid, "the harness child has a pid to kill");
    killTree(pid);
    // Nobody presses Resume: the reborn loop pauses the run and the host picks it back up.
    await until(() => lead.length >= 2, "the run resumed without a click", 180_000);
    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "run_finished").filter((e) => e.runId === runId)
          .length >= 2,
      "the resumed run to close",
      180_000,
    );
    const events = await rig.core.store.listEvents(threadId);
    const automatic = customEvents(events, "run_auto_resumed").filter((e) => e.runId === runId);
    assert.deepEqual(
      automatic.map((e) => [e.cause, e.attempt, e.project]),
      [["loop-restart", 1, project.name]],
      "resumed once, for the loop's crash, and recorded before it resumed",
    );
    const order = events
      .filter((e) => e.data.type === "custom" && (e.data.payload as { runId?: string })?.runId === runId)
      .map((e) => (e.data as { event_type: string }).event_type)
      .filter((type) => ["autopilot_paused", "run_auto_resumed", "run_registered"].includes(type));
    assert.deepEqual(order, ["run_registered", "autopilot_paused", "run_auto_resumed", "run_registered"]);
  });
});

/**
 * "Research how to build this and write a plan, don't build yet", sent with Loop on, reached a
 * write-less interviewer whose only way forward was start_autopilot — hours of build to deliver
 * two documents. The chat's own session is a contractor now: it may launch a build, and does the
 * rest itself.
 */
describe("a chat asked for research (corner-guy)", () => {
  it("corner-guy. research and a plan: the chat writes the plan itself, starts no build and takes no preview pass", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        await mkdir(path.join(request.cwd, "docs"), { recursive: true });
        await writeFile(path.join(request.cwd, "docs/fight-plan.md"), "# Plan\n");
        return {
          ok: true,
          engine: "vendor",
          sessionId: "loop-plan",
          turns: 4,
          usage: {},
          summary: "The plan is in docs/fight-plan.md. Want me to build it?",
        };
      },
    });
    await rig.core.sendUserMessage("Research how to build this and write a plan. Don't build yet.", {
      engine: "vendor",
    });
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(
      request?.interviewTools?.some((tool) => tool.name === "start_autopilot"),
      "it may still launch",
    );
    // Flipped: the brief told it "A request for research or a plan is not a request to build"; the
    // Loop's start describes itself, and the person's words say the rest.
    assert.doesNotMatch(String(request?.prompt), /not a request to build/);
    assert.ok(request?.onCapture, "the chat has its eyes on its build");
    const started = customEvents(events, "run_registered").length + customEvents(events, "run_started").length;
    assert.equal(started, 0, "no build was started");
    // A plan is nothing the preview can show: no "black canvas" warning for the empty scaffold
    // and no failed build in the learning log.
    assert.equal(customEvents(events, "build_observation").length, 0, "a docs-only turn takes no preview pass");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      messages.some((m) => /docs\/fight-plan\.md/.test(m.content ?? "")),
      "the answer reaches the chat",
    );
    assert.ok(!messages.some((m) => /loads clean|black|console error/.test(m.content ?? "")), "no verdict on a plan");
  });
});

import { gameRepo, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";

/**
 * A build an earlier version paused with the classic pipeline's journal was resumed by the director
 * on a session engine: it kept none of its plan, got a fresh time budget and started the whole build
 * again from its old goal. Such a build is closed as it stood, its work kept, and the chat says why.
 */
describe("a paused build from an earlier version (old-pause)", () => {
  it("old-pause. Resume on a classic journal: the build closes as it stood, never starting over on the director", {
    timeout: 60_000,
  }, async () => {
    const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("old-pause-")));
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { runId: "run_old_pause", engine: "codex" },
    });
    host.artifacts.set("autopilot_run_old_pause", {
      runId: "run_old_pause",
      run: host.run,
      plan: { facets: [{ id: "museum", title: "Museum" }] },
      phase: "paused",
      facets: { museum: { stoppedBecause: "stopped by the user" } },
      finalization: { report: { runId: "run_old_pause" } },
    });
    await host.rec.ctx.call("events.append", {
      threadId: host.threadId,
      batch: [
        {
          type: "custom",
          event_type: "run_finished",
          payload: {
            runId: "run_old_pause",
            executionStatus: "paused",
            paused: true,
            integrationHead: "head-1",
            stoppedBecause: "stopped by the user",
          },
        },
      ],
    });
    await host.dispatch({ resume: true });
    assert.equal(host.leadCalls().length, 0, "no director led it");
    const closed = host.appended("run_finished").at(-1);
    assert.match(String(closed?.stoppedBecause), /earlier version of Genex/);
    assert.equal(closed?.executionStatus, "completed", "closed, not paused again");
    // Flipped (one Loop): the close kept the old build's `integrationHead` to show or land; its work
    // stays on its git ref, and the close names no build of its own.
    assert.equal(closed?.integrationHead, undefined);
    assert.equal(host.appended("autopilot_paused").length, 0);
  });
});

/**
 * After a build paused long ago, "update our multiplayer" was not that build's work. A contained
 * change after a paused build is made by the chat's own session in the game folder, and the build
 * stays paused: only going on with that build itself resumes it.
 */
describe("a change after a paused build (stale-pause)", () => {
  // Flipped: the session read an after-run note restating when to resume. It led the build itself,
  // and the resume is its tool's to say: the session is handed it while the build is paused.
  it("stale-pause words. after a paused build, only going on with that build resumes it: the resume tool says so", async () => {
    const { afterLoopRunGrant } = await import("../../src/harness-seed/loop/after-loop-run.ts");
    // Flipped (one Loop): the paused run named no `inPlace`; only a Loop that worked in place resumes now.
    const paused = {
      runId: "run_paused",
      state: "paused",
      engine: "claude-code",
      onLeadEngine: true,
      model: null,
      inPlace: true,
    };
    const resume = afterLoopRunGrant(paused).interviewTools?.find((tool) => tool.name === "resume_run");
    const words = String(resume?.description);
    // Flipped (BP-2): it went on only when the person asked to go on with that build; a build is the
    // whole making of the game now, so any work on it beyond a quick fix goes on in it.
    assert.match(words, /Go on with this chat's paused build/);
    assert.doesNotMatch(words, /new instruction after a stop is a request to continue/i);
    // Flipped: "A question or a quick fix needs no build" repeated what "beyond a quick fix" says.
    assert.match(
      words,
      /Any work on this game beyond a quick fix goes on in it/,
      "a question or a quick fix needs none",
    );
  });
});

type Json = Record<string, any>;

/** The run a fake-host chat's last build was: a Codex Loop, built on gpt-5.6-sol. */
const OWN_RUN = "run_own";
const OWN_THREAD = "thread_own";
const ownRun = {
  runId: OWN_RUN,
  project: "plaza",
  goal: "a dusk plaza",
  engine: "codex",
  mode: "autopilot",
  reference: { name: "plaza", shots: [] },
  roles: { planner: "gpt-5.6-sol", builder: "gpt-5.6-sol", judge: "gpt-5.6-sol" },
  rolesApplied: true,
  budgets: { wallClockMs: HOUR_MS },
};
/** A message the person sends that chat. */
const ownMessage = {
  type: "user_message",
  threadId: OWN_THREAD,
  text: "add enemies",
  engine: "codex",
  model: "gpt-5.6-terra",
  project: "plaza",
  messageId: "m9",
};

/**
 * A chat whose last build closed — finished, or `paused` — under a lead of its own (`chatSession`
 * false) or the chat's own session, on a host that keeps the log and the journal. Every delegation is
 * recorded in `asked.sessions` and answers with the `recorded` calls; every host call is in `calls`.
 * Once the chat's turn has ended no game has the build's name, so a run started again throws before
 * it builds and closes — unless a `game` is given, which the host lists throughout. `engines` is what
 * `engine.describe` lists.
 */
function ownSessionChat({
  chatSession = false,
  paused = false,
  recorded = [],
  since = [],
  artifacts = {},
  game = null,
  engines = [{ id: "codex", kind: "delegated", label: "Codex" }],
}: {
  chatSession?: boolean;
  paused?: boolean;
  recorded?: Json[];
  since?: Json[];
  artifacts?: Json;
  game?: Json | null;
  engines?: Json[];
} = {}) {
  const closing = { runId: OWN_RUN, project: "plaza", landed: !paused };
  const log: Array<{ id: string; data: Json }> = [
    { id: "e1", data: { type: "custom", event_type: "run_registered", payload: { ...ownRun, resumed: false } } },
    { id: "e2", data: { type: "custom", event_type: "run_finished", payload: closing } },
    ...(paused ? [{ id: "e3", data: { type: "custom", event_type: "autopilot_paused", payload: closing } }] : []),
  ];
  for (const data of since) log.push({ id: `e${log.length + 1}`, data });
  const store: Json = {
    // Flipped (one Loop): the journal had no `open`, as an earlier Genex's web Loop's, and still resumed.
    journal: {
      phase: "done",
      run: ownRun,
      director: { lead: { chatSession }, sessionId: "lead-own", plan: {}, open: { version: 1, savePoints: [] } },
    },
    turnOver: false,
  };
  const asked = { sessions: [] as Json[], said: [] as string[] };
  const calls: Array<{ method: string; params: Json }> = [];
  const append = (data: Json) => log.push({ id: `e${log.length + 1}`, data });
  const answers: Record<string, (params: Json) => unknown> = {
    [HostMethod.EventsList]: (params) =>
      params?.after ? log.slice(log.findIndex((entry) => entry.id === params.after) + 1) : [...log],
    [HostMethod.EngineDescribe]: () => engines,
    [HostMethod.ArtifactRead]: (params) =>
      params.artifactId === `autopilot_${OWN_RUN}` ? store.journal : (artifacts[params.artifactId] ?? null),
    [HostMethod.ArtifactWrite]: (params) => {
      if (params.artifactId === `autopilot_${OWN_RUN}`) store.journal = params.value;
    },
    [HostMethod.EventsAppend]: (params) => {
      for (const data of params.batch) append(data);
    },
    [HostMethod.TurnBegin]: () => ({ turnId: "turn-1" }),
    [HostMethod.TurnAppend]: (params) => {
      for (const data of params.batch) for (const m of data.messages ?? []) asked.said.push(String(m.content));
    },
    [HostMethod.TurnEnd]: () => {
      store.turnOver = true;
    },
    [HostMethod.EventsMessages]: () => [],
    [HostMethod.GameList]: () => {
      if (game) return [game];
      return store.turnOver ? [] : [{ name: "plaza", title: "Plaza" }];
    },
    [HostMethod.EngineDelegate]: (params) => {
      asked.sessions.push(params);
      const result = { ok: true, engine: params.engine, turns: 1, usage: {}, sessionId: "chat-1", summary: "done" };
      return { ...result, studioToolCalls: recorded };
    },
    // The host's resume of a paused build: the harness's start of it then reserves the run.
    [HostMethod.RunControl]: (params) => {
      if (params.name === "resume_run")
        resumeStopped(
          studio as never,
          { threadId: params.threadId, run: { runId: params.runId }, resume: true } as never,
        );
      return "Resume requested for the same run.";
    },
  };
  const notified: Array<{ event: string; payload: Json }> = [];
  const host = {
    workspace: "/nonexistent",
    notify: (event: string, payload: Json) => {
      notified.push({ event, payload });
    },
    call: async (method: string, params: Json): Promise<unknown> => {
      calls.push({ method, params });
      return answers[method]?.(params) ?? null;
    },
  };
  const studio: Json = {
    host,
    cancels: new Set<string>(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
  };
  const ctx = {
    ...host,
    host,
    threadId: OWN_THREAD,
    setStatus: () => {},
    get cancelled() {
      return studio.cancels.has(OWN_THREAD);
    },
  };
  studio.scoped = () => ctx;
  /** The runs registered on the thread, once the ones under way have closed. */
  const registered = async () => {
    const of = () => log.filter((entry) => entry.data.event_type === "run_registered");
    for (let n = 0; n < 200 && of().length < 2; n++) await nextTurn();
    for (let n = 0; n < 400 && studio.activeRuns.size + studio.startingRuns.size > 0; n++) await nextTurn();
    return of().map((entry) => entry.data.payload);
  };
  return { studio, log, store, asked, calls, registered, notified };
}

/** The names of the tools a delegation was handed to record. */
const recordable = (params: Json | undefined): string[] =>
  (params?.interviewTools ?? []).map((tool: Json) => String(tool.name));

/**
 * The run's coordinator answered a game's chat whenever no lead of the chat's own had led its last
 * build: after a classic or long-turn build, a lead with a session of its own, a message on another
 * engine, an engine without sessions, and while a Loop prepared its start. It was a second agent,
 * read-only, with its own tools and prompt, beside the chat's own session. Every message is now the
 * chat's own turn: the lead's while its build runs, the chat's own session otherwise, which keeps
 * the run's controls after a closed Loop that seated a lead.
 */
describe("one session answers the chat (no-coordinator)", () => {
  it("NC1. a change after a classic paused build is made by the chat's own session in the game folder; nothing starts again", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("paused-plaza");
    const thread = await rig.core.createGameThread("paused-plaza");
    const runId = "run_paused_plaza";
    await rig.core.append(
      [
        { type: "messages", messages: [{ role: "user", content: "Make the plaza photoreal" }] },
        {
          type: "custom",
          event_type: "run_started",
          payload: { runId, project: "paused-plaza", goal: "a photoreal plaza", mode: "autopilot", engine: "codex" },
        },
        {
          type: "custom",
          event_type: "run_finished",
          payload: { runId, project: "paused-plaza", victory: false, stoppedBecause: "stopped by the user" },
        },
        { type: "custom", event_type: "autopilot_paused", payload: { runId, project: "paused-plaza" } },
      ],
      thread,
    );
    const asked: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        asked.push(request);
        if (!request.readOnly) await writeFile(path.join(request.cwd, "multiplayer.txt"), "0.17.1");
        return {
          ok: true,
          summary: "Updated the multiplayer.",
          sessionId: "chat-1",
          turns: 1,
          usage: {},
          engine: "codex",
        };
      },
    });
    await rig.core.sendUserMessage("Update our in-game multiplayer", { thread, engine: "codex" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      30_000,
      "the message answered",
    );
    assert.deepEqual(
      asked.map((request) => ({ coordinator: "coordinator" in request, readOnly: request.readOnly === true })),
      [{ coordinator: false, readOnly: false }],
      "one session answers, with its hands",
    );
    assert.equal(await readFile(path.join(rig.core.games.dirFor("paused-plaza"), "multiplayer.txt"), "utf8"), "0.17.1");
    const restarted = customEvents(events, "run_registered").length + customEvents(events, "run_started").length;
    assert.equal(restarted, 1, "the paused build did not start again");
  });

  it("NC2. after a build whose lead was a session of its own, the chat's own session answers with the run's controls, and resumes the paused build itself", async () => {
    const finished = ownSessionChat();
    await handleUserMessage(finished.studio as never, { ...ownMessage } as never);
    assert.equal(finished.asked.sessions.length, 1, "one session answers");
    const [answer] = finished.asked.sessions;
    assert.equal("coordinator" in (answer ?? {}), false, "never a coordinator");
    assert.notEqual(answer?.readOnly, true, "with its hands");
    assert.deepEqual(answer?.runControls, { runId: OWN_RUN, messageId: "m9" }, "run_status");

    const paused = ownSessionChat({ paused: true, recorded: [{ name: "resume_run", args: { text: "add enemies" } }] });
    await handleUserMessage(paused.studio as never, { ...ownMessage } as never);
    assert.equal(paused.asked.sessions.length, 1);
    assert.deepEqual(paused.asked.sessions[0]?.runControls, { runId: OWN_RUN, messageId: "m9" });
    assert.ok(recordable(paused.asked.sessions[0]).includes("resume_run"), "after a pause it may resume the build");
    assert.deepEqual(
      paused.calls.filter((call) => call.method === HostMethod.RunControl).map((call) => call.params),
      [{ threadId: OWN_THREAD, runId: OWN_RUN, messageId: "m9", name: "resume_run", args: { text: "add enemies" } }],
      "the resume it recorded, once its reply ended",
    );
  });

  it("NC3. a message on another engine than the build's is the chat's own session there, with the run's controls: no reopen, no resume", async () => {
    const chat = ownSessionChat({
      chatSession: true,
      recorded: [{ name: "reopen_run", args: { text: "add enemies" } }],
      engines: [
        { id: "codex", kind: "delegated", label: "Codex" },
        { id: "claude-code", kind: "delegated", label: "Claude Code" },
      ],
    });
    const elsewhere = { ...ownMessage, engine: "claude-code", model: undefined };
    await handleUserMessage(chat.studio as never, elsewhere as never);
    assert.equal(chat.asked.sessions.length, 1);
    const [answer] = chat.asked.sessions;
    assert.equal("coordinator" in (answer ?? {}), false, "never a coordinator");
    assert.equal(answer?.engine, "claude-code", "on the message's engine");
    assert.deepEqual(answer?.runControls, { runId: OWN_RUN, messageId: "m9" });
    assert.equal(recordable(answer).includes("reopen_run"), false, "another engine never reopens the build");
    assert.equal((await chat.registered()).length, 1, "nothing reopened");

    // A paused build: that turn moves the chat's bookmark to its engine, so no resume of it would
    // continue the lead's session. Builds' Resume stays.
    const paused = ownSessionChat({
      chatSession: true,
      paused: true,
      recorded: [{ name: "resume_run", args: { text: "add enemies" } }],
      engines: [
        { id: "codex", kind: "delegated", label: "Codex" },
        { id: "claude-code", kind: "delegated", label: "Claude Code" },
      ],
    });
    await handleUserMessage(
      paused.studio as never,
      { ...ownMessage, engine: "claude-code", model: undefined } as never,
    );
    const [onAnother] = paused.asked.sessions;
    assert.deepEqual(onAnother?.runControls, { runId: OWN_RUN, messageId: "m9" });
    assert.equal(recordable(onAnother).includes("resume_run"), false, "another engine never resumes the build");
    assert.doesNotMatch(String(onAnother?.prompt), /resume_run|you lead it again/);
    assert.equal(paused.calls.filter((call) => call.method === HostMethod.RunControl).length, 0, "nothing resumed");
  });

  it("NC4. a message on Ollama after a finished Loop is a plain chat turn: none of the coordinator's tools", {
    timeout: 120_000,
  }, async () => {
    const rig = await startRig({ replies: [{ text: "The plaza has no enemies yet." }] });
    rigs.push(rig);
    await rig.core.games.scaffold("lead-plaza");
    const thread = await rig.core.createGameThread("lead-plaza");
    const runId = "run_lead_plaza";
    const run = { runId, project: "lead-plaza", goal: "a dusk plaza", mode: "autopilot", engine: "codex" };
    await rig.core.append(
      [
        { type: "messages", messages: [{ role: "user", content: "Make a dusk plaza" }] },
        { type: "custom", event_type: "run_started", payload: run },
        { type: "custom", event_type: "run_finished", payload: { runId, project: "lead-plaza", landed: true } },
      ],
      thread,
    );
    await rig.core.store.writeArtifact(thread, `autopilot_${runId}`, {
      phase: "done",
      run,
      director: { lead: { chatSession: true }, sessionId: "chat-1", plan: {} },
    });
    await rig.core.sendUserMessage("add enemies", { thread, engine: "ollama", model: "qwen3.6:27b" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      60_000,
      "the message answered",
    );
    const offered = rig.server.requests.flatMap((request) =>
      ((request.body as { tools?: Array<{ function?: { name?: string } }> })?.tools ?? []).map((tool) =>
        String(tool.function?.name),
      ),
    );
    for (const name of ["steer_run", "finish_run", "stop_run", "continue_build", "start_autopilot"])
      assert.equal(offered.includes(name), false, `${name} is no tool of the chat's`);
    assert.equal(customEvents(events, "run_registered").length, 0, "no run starts");
  });

  /**
   * While a Loop prepared its start, the coordinator answered what was sent at once. Flipped
   * assertion: a message sent then waits for the lead's line and is handed to the lead alone.
   */
  it("NC5. a message while the Loop prepares waits for its lead, which alone answers it; Stop stops the build", {
    timeout: 120_000,
  }, async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("starting-plaza");
    const thread = await rig.core.createGameThread("starting-plaza");
    // The chat has a session of its own, which the lead continues: its first turn resumes it.
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "contractor_session",
          payload: { project: "starting-plaza", engine: "fake-delegate", sessionId: "chat-1" },
        },
      ],
      thread,
    );
    // The page never answers a step while the start is looked at: the Loop stays preparing.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const studioCall = rig.preview.studioCall.bind(rig.preview);
    rig.preview.studioCall = async (method, arg) => {
      await held;
      return studioCall(method, arg);
    };
    const leadPrompts: string[] = [];
    const others: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        if (!request.director) {
          others.push(request);
          return { summary: "Stopping the build.", sessionId: "chat" };
        }
        leadPrompts.push(request.prompt);
        // Flipped (no clock): the lead's turn ended at once and the lead rested until the Stop; a turn
        // that ends with nothing at work pauses the Loop now, so this one works until the Stop.
        await untilAborted(request.signal);
        return { summary: "Looking at the plaza.", sessionId: request.resume ?? "lead-1" };
      },
    });
    const runId = rig.core.newRunId();
    // The start answers once the run is over: the row talks to the chat meanwhile.
    const running = rig.core.dispatchRun({
      runId,
      goal: "a plaza",
      project: "starting-plaza",
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "plaza", shots: [], kind: "direction" },
      budgets: {},
    } as never);
    void running.catch(() => {});
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "autopilot_started").some((e) => e.runId === runId),
      60_000,
      "the run started",
    );
    await rig.core.sendUserMessage("stop the workers", { thread, engine: "fake-delegate" });
    const messageId = customEvents(
      await waitForLog(rig.core, (log) => customEvents(log, "coordinator_message_queued").length === 1),
      "coordinator_message_queued",
    )[0]?.messageId;
    release();
    const delivered = await waitForLog(
      rig.core,
      (log) =>
        customEvents(log, "coordinator_message_delivered").some((e) => e.messageId === messageId && e.how === "lead"),
      60_000,
      "the message handed to the lead",
    );
    await waitForLog(
      rig.core,
      () => leadPrompts.some((prompt) => prompt.includes("stop the workers")),
      60_000,
      "the lead reads it",
    );
    assert.equal(
      customEvents(delivered, "coordinator_message_processing").filter((e) => e.messageId === messageId).length,
      0,
      "no turn of the chat's own takes it",
    );
    assert.equal(others.length, 0, "no session but the lead answers it");

    await rig.core.stopThread(thread);
    const closed = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      60_000,
      "the build closed",
    );
    const close = customEvents(closed, "run_finished").find((e) => e.runId === runId);
    assert.match(String(close?.stoppedBecause), /stop/i, JSON.stringify(close));
    await running;
  });
});

/**
 * Steering that reached a classic build after its last round was written to the game's NOTES.md
 * under "Steering backlog" and headed the next plan. NOTES.md is read in every later chat, so a
 * "stop the workers" said to one build stayed in the game for good, telling every later agent the
 * work was cancelled. Such steering stays with the build it was said to, and the studio's old
 * section no longer reaches a later chat.
 */
describe("steering said to a closed build (stale-backlog)", () => {
  const STALE = [
    "# plaza",
    "",
    "## Pitch",
    "",
    "A plaza to skate.",
    "",
    "## Steering backlog",
    "",
    '- The user explicitly cancelled the work: "ok kill the workers". Do not begin further implementation.',
    "",
    "## Current state",
    "",
    "Playable.",
    "",
  ].join("\n");

  it("stale-backlog. a chat after that build: the old section is gone from NOTES.md and from what the agent reads, the rest kept", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("backlog-plaza");
    const thread = await rig.core.createGameThread("backlog-plaza");
    const notesFile = path.join(rig.core.games.dirFor("backlog-plaza"), "NOTES.md");
    await writeFile(notesFile, STALE);
    const read: string[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        read.push(String(request.prompt), await readFile(path.join(request.cwd, "NOTES.md"), "utf8"));
        return { ok: true, summary: "Updated.", sessionId: "chat", turns: 1, usage: {}, engine: "codex" };
      },
    });
    await rig.core.sendUserMessage("Update our in-game multiplayer", { thread, engine: "codex" });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      30_000,
      "answered",
    );
    assert.doesNotMatch(read.join("\n"), /kill the workers/, "the agent never reads the old cancellation");
    const notes = await readFile(notesFile, "utf8");
    assert.doesNotMatch(notes, /Steering backlog|kill the workers/);
    assert.match(
      notes,
      /## Pitch\n\nA plaza to skate\.\n\n## Current state\n\nPlayable\.\n/,
      "the rest of the notes stays",
    );
  });
});

/**
 * A Loop started only when the person asked for one in words (or with the composer's Loop switch
 * on): the chat's agent was handed its start with a rule about when ("only when the user asks for
 * one in words… Pass the hours they named"), a rule sentence in its brief, and the hours it was
 * told capped the run. There is no switch now: every chat's own turn is handed start_autopilot as
 * the tool describes itself, with no hours and no rule, and the agent decides; a Loop it starts
 * goes until its lead finishes it, on the roles the message carries. A message queued before the
 * upgrade with a Keep building commission launched with no turn deciding it; it is answered by an
 * ordinary turn now.
 */
describe("the chat's agent decides when a Loop starts (always-launch)", () => {
  /** A game chat on a delegated engine whose answer records `launch` (none: it only answers); a run's own sessions end at once. */
  async function launchingChat(launch: Record<string, unknown> | null) {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = "seyda-neen";
    await rig.core.games.scaffold(project);
    const thread = await rig.core.createGameThread(project);
    const chat: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        const inTheGame = request.cwd?.endsWith(`/games/${project}`) === true;
        const ran = { ok: true, engine: "vendor", turns: 1, usage: {} };
        if (request.director || !inTheGame || chat.length > 0)
          return { ...ran, sessionId: "run-session", summary: "Looked around." };
        chat.push(request);
        const calls = launch ? { studioToolCalls: [{ name: "start_autopilot", args: launch }] } : {};
        return { ...ran, sessionId: "own-chat", summary: launch ? "Starting the Loop." : "Answered.", ...calls };
      },
    });
    return { rig, project, thread, chat };
  }
  type Json = Record<string, any>;
  const ask = { goal: "The Morrowind start scene", direction: "AAA swamp town at dawn" };
  /** The thread's registered runs in `log`, by their payloads. */
  const runsIn = (log: Parameters<typeof customEvents>[0], thread: string): Json[] =>
    customEvents(
      log.filter((e) => e.thread_id === thread),
      "run_registered",
    );

  it("always-launch. a plain message: the chat's own session is handed start_autopilot as it describes itself, with no hours and no rule, and its Loop goes until its lead finishes it, on the message's roles", async () => {
    const { startAutopilot } = await import("../../src/harness-seed/loop/start-autopilot.ts");
    const { rig, thread, chat } = await launchingChat({ ...ask, hours: 3 });
    const roles = { builder: "vendor-fast", judge: "vendor-model" };
    await rig.core.sendUserMessage("Make my Morrowind scene", { thread, engine: "vendor", roles });
    const events = await waitForLog(rig.core, (log) => runsIn(log, thread).length > 0, 30_000, "run_registered");
    await rig.core.stopThread(thread);
    const run = runsIn(events, thread)[0];

    const launch = chat[0]?.interviewTools?.find((tool) => tool.name === "start_autopilot");
    assert.equal(launch?.description, startAutopilot.description, "the tool's own description, no rule beside it");
    assert.equal((launch?.parameters as Json)?.properties?.hours, undefined, "no hours");
    assert.equal("onlyWhenAsked" in (launch ?? {}), false);
    assert.doesNotMatch(String(chat[0]?.prompt), /Never say a Loop started|Loop switch|asks in words/);
    assert.equal(run?.goal, ask.goal);
    // Flipped (no clock): the run's budgets named a day's ceiling and `untilSatisfied`; a run has no clock now.
    assert.equal(run?.budgets?.untilSatisfied, undefined, "no clock: whatever hours the call named");
    assert.equal(run?.budgets?.wallClockMs, undefined, "no working time");
    assert.deepEqual(run?.roles, roles, "the roles the message carries");
  });

  it("always-launch. a message queued before the upgrade with a Keep building commission gets an ordinary turn: no Loop starts unless that turn starts one", async () => {
    const { rig, project, thread, chat } = await launchingChat(null);
    const older = { autopilot: { hours: 2, keepBuilding: true } };
    await rig.core.host.dispatch({
      type: "user_message",
      threadId: thread,
      text: "Keep building: the swamp's fog",
      engine: "vendor",
      project,
      ...older,
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length > 0 || runsIn(log, thread).length > 0,
      30_000,
      "answered",
    );
    assert.equal(chat.length, 1, "one turn of the chat's own session");
    assert.match(String(chat[0]?.prompt), /the swamp's fog/);
    assert.deepEqual(runsIn(events, thread), [], "no Loop started by itself");
  });

  it("always-launch-direct. a direct engine's chat (Ollama's tool loop), which cannot lead a Loop, is not handed a Loop's start", async () => {
    const { createToolRegistry } = await import("../../src/harness-seed/tools/index.ts");
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: { "plugins.tools": () => ({ tools: [] }), "mcp.tools": () => ({ tools: [] }) },
    });
    const registry = await createToolRegistry(recorder.ctx as never, { threadId: "t1" } as never);
    assert.ok(registry.names().includes("read_file"), "the tool loop's own tools are there");
    const launches = new Set(["start_autopilot", "start_unattended_run"]);
    assert.deepEqual(
      registry.names().filter((name) => launches.has(name)),
      [],
    );
  });

  // BP-2: the Loop's start said what a Loop is and nothing about when, so a lead made a whole Unreal
  // game in its chat replies over nine messages and Builds stayed empty; its resume went on with a
  // paused build only on "resume" or "keep going".
  it("BP-2. the Loop's start says a build is the whole making of the game, started as the work begins, and a paused one is gone on with: the resume goes on with it for any work on it", async () => {
    const { startAutopilot } = await import("../../src/harness-seed/loop/start-autopilot.ts");
    const { afterLoopRunGrant } = await import("../../src/harness-seed/loop/after-loop-run.ts");
    const start = String(startAutopilot.description);
    assert.match(start, /whole making of this game/, "what a build is");
    assert.match(start, /as soon as you set to making the game/, "when one starts: as the work begins");
    assert.match(start, /instead of doing that work in your reply/, "never built in the reply instead");
    assert.match(start, /paused build[^.]*resume_run/, "a paused build goes on");
    // Flipped: "a new build only when one is needed" said again what going on with a paused one says.
    assert.match(start, /resume_run\) unless the person wants to start over/, "a new build only to start over");
    assert.doesNotMatch(start, /call it once, last/, "it starts the work, it does not close it");
    const paused = {
      runId: "r1",
      state: "paused",
      engine: "claude-code",
      onLeadEngine: true,
      model: null,
      inPlace: true,
    };
    const resume = afterLoopRunGrant(paused).interviewTools?.find((tool) => tool.name === "resume_run");
    assert.match(
      String(resume?.description),
      /Any work on this game[^.]*goes on in it/,
      "work on the game goes on in it",
    );
    assert.doesNotMatch(String(resume?.description), /when the user asks to go on/, "not only on an ask to resume");
  });
});

/**
 * A new game's chat asked for Unreal, and its session started a build before the game had a kind: the
 * build's start wrote the web starter, so the Loop ran on a web page, Unreal's new-game was refused
 * while that Loop ran, and its finish failed the web check ("the page's frame is blank") on what was
 * meant to be an Unreal game; only the person's pause got it out. Now the kind comes before the
 * build: Genex holds the launch, and the same session makes the kind and then starts the build. A
 * finish checks no page on an engine's game, by what its folder holds as the lead finishes.
 */
describe("a build started before its game had a kind (web-scaffold-unreal)", () => {
  const NAME = "sword-duel";
  const UNREAL_KIND = { plugin: "unreal", name: "Unreal Editor", tool: "unreal__new-game", makes: ["unreal-project"] };
  const PENDING = { name: NAME, title: NAME, dir: `/games/${NAME}`, facts: [], holds: "nothing" };
  const UNREAL = { ...PENDING, facts: [{ id: "unreal-project", path: "unreal", source: "core" }], holds: undefined };
  const LAUNCH = { name: "start_autopilot", args: { goal: "An Unreal sword duel" } };

  /**
   * One chat turn on the new game: each leg of the session answers the next of `legs` (its recorded
   * calls, and whether it made the Unreal project), with the Unreal plugin's kind on offer or not.
   */
  async function chatTurn(legs: Array<{ calls?: unknown[]; makesUnreal?: boolean }>, kinds: unknown[] = [UNREAL_KIND]) {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    let unreal = false;
    let leg = 0;
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "make an Unreal sword duel" }],
        "game.contentStamp": () => ({ all: "a", source: "a" }),
        "game.list": () => [unreal ? UNREAL : PENDING],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds }),
        "engine.describe": () => [],
        "preview.ready": () => ({ ready: false }),
        "engine.delegate": () => {
          const answer = legs[leg] ?? {};
          leg += 1;
          if (answer.makesUnreal) unreal = true;
          return {
            ok: true,
            engine: "claude-code",
            turns: 1,
            usage: {},
            sessionId: "s1",
            summary: "Working on it.",
            ...(answer.calls ? { studioToolCalls: answer.calls } : {}),
          };
        },
      },
    });
    const turn = { threadId: "t1", turnId: "turn-1", engine: "claude-code", engineLabel: "Claude Code", project: NAME };
    const outcome = await runDelegatedTurn(
      recorder.ctx as never,
      { ...turn, text: "make an Unreal sword duel" } as never,
    );
    return { outcome, legs: recorder.paramsOf("engine.delegate") };
  }

  it("web-scaffold-unreal. a launch on a game with no kind while a plugin offers one waits: the same session makes the kind, then its launch starts the build on it", async () => {
    const turn = await chatTurn([{ calls: [LAUNCH] }, { makesUnreal: true }, { calls: [LAUNCH] }]);
    assert.equal(turn.legs.length, 3, "the launch, the kind, the launch again");
    for (const later of turn.legs.slice(1)) assert.equal(later.resume, "s1", "the same session goes on");
    const kindFirst = String(turn.legs[1]?.prompt);
    assert.match(kindFirst, /mcp__studio__unreal__new-game/, "the kind on offer, by the tool that makes it");
    assert.match(kindFirst, /mcp__studio__start_web_game/, "and the web page");
    assert.match(kindFirst, /mcp__studio__start_autopilot/, "then the build again");
    assert.equal(turn.outcome.stopped, "launch_run", "the build starts once the game has its kind");
    assert.equal((turn.outcome.details as { run?: { project?: string } })?.run?.project, NAME);
  });

  it("web-scaffold-unreal. a launch recorded again with still no kind starts as before, and one with no kind on offer starts at once", async () => {
    const again = await chatTurn([{ calls: [LAUNCH] }, { calls: [LAUNCH] }]);
    assert.equal(again.legs.length, 2, "held once, never twice");
    assert.equal(again.outcome.stopped, "launch_run");
    const none = await chatTurn([{ calls: [LAUNCH] }], []);
    assert.equal(none.legs.length, 1, "no kind to pick: no hold");
    assert.equal(none.outcome.stopped, "launch_run");
    const asked = await chatTurn([{ calls: [{ name: "ask_user", args: { question: "Web or Unreal?" } }, LAUNCH] }]);
    assert.equal(asked.legs.length, 1, "a question beside the launch is asked: its answer comes first");
    assert.notEqual(asked.outcome.stopped, "launch_run", "and nothing starts");
  });

  it("web-scaffold-unreal. a game ported from the web starter to Unreal in unreal/ (its index.html and src/ left as the reference) is an engine's game: no web page check", async (t) => {
    const { pageChecked } = await import("../../src/harness-seed/loop/folder-facts.ts");
    const { core, close } = await coreLite();
    t.after(close);
    const game = await core.games.scaffold("asian-sword-duel");
    await mkdir(path.join(game.dir, "unreal"));
    await writeFile(path.join(game.dir, "unreal", "SwordDuel.uproject"), "{}\n");
    const meta = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8")) as object;
    const portedFrom = [{ id: "web-game", path: ".", source: "core" }];
    await writeFile(path.join(game.dir, "studio.json"), `${JSON.stringify({ ...meta, portedFrom }, null, 2)}\n`);
    const listed = (await core.games.list()).find((row) => row.name === game.name);
    assert.deepEqual(
      listed?.facts.map((fact) => `${fact.id}@${fact.path}`),
      ["unreal-project@unreal"],
      "the web files stay as the reference only",
    );
    assert.equal(pageChecked(listed as never), false, "a finish checks no page");
    assert.equal(pageChecked({ ...listed, facts: [...(listed?.facts ?? []), ...portedFrom] } as never), false);
    assert.equal(pageChecked({ facts: portedFrom } as never), true, "a web game's page is still checked");
  });
});

/**
 * A resumed run read its inbox from the whole log as if it were new: a wrap-up the user asked
 * of the session before the Resume told it to skip every builder and integrate having built
 * nothing (the host only narrowed this by refusing a finish on a run that was not running), and
 * every steer an earlier session had handed over went out again. Reading hand-overs from the log
 * then overshot: a director that restarted in a fresh session after the Resume never heard an
 * instruction the earlier run's director had been told, since its `wait` asked only for steers
 * no session had handed over.
 */
describe("a resumed run inherited the session before it (resume-inbox)", () => {
  const custom = (event_type: string, payload: Record<string, unknown>) => ({
    type: "custom",
    event_type,
    payload: { runId: "r", ...payload },
  });
  /** A run's thread with one steer, read by a first run and then resumed. */
  function resumedLog() {
    const log: Array<{ id: string; data: Record<string, unknown> }> = [];
    const append = (...batch: Array<Record<string, unknown>>) => {
      for (const data of batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
    };
    const ctx = {
      call: async (method: string, p: { after?: string; batch?: Array<Record<string, unknown>> }) => {
        if (method === "events.append") return append(...(p.batch ?? []));
        return p.after ? log.slice(log.findIndex((e) => e.id === p.after) + 1) : [...log];
      },
    };
    append(custom("run_registered", {}), custom("run_steering", { text: "brighter sky" }));
    return { log, append, ctx };
  }

  // Flipped: the inbox recorded each steer handed over (`run_steering_delivered`, stage "next brief"),
  // so a resumed session could hand one over twice; it hands nothing over now — the lead reads its line.
  it("resume-inbox. a Resume forgets the earlier wrap-up, and reading the run's steers writes nothing", async () => {
    const { log, append, ctx } = resumedLog();
    const loopRun = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    assert.deepEqual(await loopRun.steering(), ["brighter sky"]);
    append(
      custom("run_control", { action: "finish" }),
      custom("autopilot_paused", {}),
      custom("run_registered", { resumed: true }),
    );
    const resumedAt = log.length;
    const resumed = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    assert.equal(await resumed.finishing(), false, "the resumed run was never asked to wrap up");
    assert.deepEqual(await resumed.steering(), ["brighter sky"]);
    assert.deepEqual(log.slice(resumedAt), [], "nothing is written for a read");
  });
});

/**
 * The lead's later turns (the wake loop, loop/director/wake.ts). The limit wait and the fallback
 * to a fresh session used to cover only the first session: a limit on the wrap-up paused the
 * run, and a session the engine had forgotten by the wrap-up closed it unfinished. The lead now
 * takes many turns a run, so both hold on every one of them.
 */
describe("the lead's later turns (wake loop)", () => {
  /** The one worker the lead starts: a copy of the game, to paint the sky. */
  const start = { title: "Sky", task: "paint the sky blue", isolation: "copy" };

  /** A run whose lead is scripted turn by turn, and whose one builder paints the sky and stops. */
  async function lateTurnLoopRun(
    name: string,
    lead: (request: DelegateRequest, turn: number) => Promise<Record<string, unknown>>,
    budgets: Record<string, unknown> = {},
    complete: FakeEngineHooks["complete"] = () => null,
  ) {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold(name, { title: name });
    const turns: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          turns.push(request);
          return lead(request, turns.length);
        }
        // Anything else the run delegates is its worker, in its copy of the game.
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        return { sessionId: "worker-1", summary: "painted the sky" };
      },
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a blue sky",
      project: project.name,
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "sky", shots: [] },
      budgets: { wallClockMs: 15 * 60_000, ...budgets },
    } as never);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      `${name} run_finished`,
    );
    return { turns, events, finished: customEvents(events, "run_finished").find((e) => e.runId === runId)! };
  }

  // Flipped (no clock): a limit that reset within the turn's time was waited out in process, and a
  // longer one paused the run; one rule now: the run pauses, and the host's auto-resume resumes it at
  // the reset (`auto-resume.ts`).
  it("I1. the lead's session limit on a later turn pauses the run with the reset the host resumes it at", async () => {
    const { turns, finished } = await lateTurnLoopRun("late-limit", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("worker_start", start);
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      // The engine's own session limit, on a wake: it resets in a second and a half.
      if (turn === 2) throw new EngineError("rate_limit", "fake-delegate", "You've hit your session limit", 1_500);
      await call("finish", { summary: "the sky is blue", land: "no" });
      return { sessionId: "lead-1", summary: "finished" };
    });
    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(finished.executionStatus, "paused", String(finished.stoppedBecause));
    assert.equal(finished.landed, false);
    const limit = finished.limit as { kind?: string; retryAfterMs?: number };
    assert.equal(limit.kind, "rate_limit");
    assert.equal(limit.retryAfterMs, 1_500, "the reset the host's auto-resume waits for");
  });

  it("I3. a provider outage on a later lead turn is waited out, and the same session carries on", async () => {
    const { turns, finished } = await lateTurnLoopRun(
      "late-outage",
      async (request, turn) => {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (turn === 1) {
          await call("worker_start", start);
          return { sessionId: "lead-1", summary: "the sky worker is building" };
        }
        // One overloaded gateway on a wake: not a limit, not the lead's fault.
        if (turn === 2) throw new EngineError("unavailable", "fake-delegate", "529 overloaded_error");
        await call("finish", { summary: "the sky is blue", land: "no" });
        return { sessionId: "lead-1", summary: "finished" };
      },
      { outageDelays: [200] },
    );
    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(turns[2]!.resume, "lead-1", "the same session carries on");
    assert.equal(turns[2]!.prompt, turns[1]!.prompt, "the turn's own message is asked again");
    // Flipped (one Loop): "the lead finished the run" was a web Loop's landing; it closes in place on the lead's word.
    assert.equal(finished.stoppedBecause, "the lead says the goal is reached", "the run was not wrapped up for it");
  });

  // Flipped: the fresh session's prompt was "YOUR EARLIER SESSION WAS LOST … Your notes and the run so far
  // are below", the brief, YOUR NOTES, THE RUN SO FAR and the digest; it is the turn's own message, with
  // Genex's line beside it that the session was lost, and how the Loop began.
  it("I2. a session lost on a later turn is replaced by a fresh one with the turn's own message, the loss and the Loop's start beside it", async () => {
    const { turns, finished } = await lateTurnLoopRun("late-lost", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("note", { text: "the sky first; the plaza after it" });
        await call("worker_start", start);
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      // The engine no longer knows the lead's session when it is woken.
      if (request.resume) throw new Error(`No conversation found with session ID: ${request.resume}`);
      await call("finish", { summary: "the sky is blue", land: "no" });
      return { sessionId: "lead-2", summary: "finished" };
    });
    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(turns[1]!.resume, "lead-1");
    assert.equal(turns[2]!.resume, undefined, "a fresh session");
    assert.equal(turns[2]!.prompt, turns[1]!.prompt, "the turn's own message");
    const told = (turns[2]!.notices ?? []).join("\n");
    // Flipped: the start line named the web build's worktree ("The Loop started; it builds in …"); its
    // session's added folder is that worktree, and `run_status` names it.
    assert.match(
      told,
      /Your earlier session was lost \(the session could not be resumed\); this session is new\.\nThe Loop started\. Its goal: /,
    );
    assert.doesNotMatch(told, /YOUR NOTES|THE RUN SO FAR|WHAT HAPPENED/);
    // Flipped (one Loop): it closed by landing ("the lead finished the run"); it closes in place on its word.
    assert.equal(finished.stoppedBecause, "the lead says the goal is reached");
  });

  // Flipped: the ordinary end was worded as a session that stopped short ("the lead's session ended
  // (on its own) before it called finish"). Flipped again (one Loop): a web game's close added what
  // its landing did ("; nothing was landed …"); it closes in place, in the words every Loop's does.
  it("no-clock. a web lead's turn that ends with nothing at work pauses the Loop in its ordinary end's words", async () => {
    const { turns, finished } = await lateTurnLoopRun("idle-end", async () => ({
      sessionId: "lead-1",
      summary: "the sky is blue",
    }));
    assert.equal(turns.length, 1, "no wake and no wrap-up turn after it");
    assert.equal(finished.stoppedBecause, "the lead's turn ended with nothing at work");
  });

  // BP-1: an Unreal game's lead asked the person something and its turn ended, which closed the build
  // for good, so their answer could only start another; a build is the whole making of the game.
  it("BP-1. a lead's turn that ends with nothing at work pauses the build, so the person's next word goes on with it", async () => {
    const { events, finished } = await lateTurnLoopRun("idle-pause", async () => ({
      sessionId: "lead-1",
      summary: "Which bench should he sleep on first?",
    }));
    assert.equal(finished.executionStatus, "paused", "the build waits for the person");
    assert.equal(finished.stoppedBecause, "the lead's turn ended with nothing at work");
    const paused = customEvents(events, "autopilot_paused").filter((e) => e.runId === finished.runId);
    assert.equal(paused.length, 1, "a Resume, or the chat's own session, picks it up");
  });

  it("D11. the lead's account disabled on a wake pauses the run: workers stopped, nothing landed, no wrap-up, the user told what to fix", async () => {
    const disabled =
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
    const { turns, finished } = await lateTurnLoopRun("late-access-lost", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("worker_start", start);
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      throw new EngineError("auth", "fake-delegate", disabled);
    });
    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(finished.executionStatus, "paused", String(finished.stoppedBecause));
    assert.equal(finished.landed, false);
    // Flipped (one Loop): a web Loop's pause named its landing (`landingResult.why` paused, "nothing
    // was landed"); every Loop pauses in place, its folder as the lead left it.
    assert.equal(finished.landingResult, undefined);
    assert.equal((finished.limit as { kind?: string }).kind, "auth");
    assert.match(String(finished.stoppedBecause), /lost its sign-in/);
    assert.match(String(finished.stoppedBecause), /disabled Claude subscription access/);
  });
});

/**
 * The wake loop on a clock the row moves (loop/director/wake.ts `runWakeLoop`), with no rig: one
 * running worker, and the run's log, inbox and journal as plain objects. `ticks` run on every
 * sleep, so a row can make the run move while the lead rests.
 */
function clockNight(inbox: Record<string, unknown> = {}) {
  const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);
  const at = { now: T0 };
  const ticks: Array<(now: number) => void> = [];
  const log: Array<{ at: number; seq: number; text: string; kind?: string }> = [];
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const worker = {
    id: "sky",
    title: "Sky",
    state: "running",
    iterations: [],
    brief: "paint the sky",
    deadline: T0 + HOUR_MS,
    stopRequested: false,
  };
  const state = {
    monitor: {},
    finished: false,
    limit: null as Record<string, unknown> | null,
    planReviewUntil: null,
    planGo: false,
    planSaidFrom: 0,
    workerLimit: null,
    workers: new Map([["sky", worker]]),
    integrationHead: null,
    integrationHealthy: null,
    ledger: [],
    plan: null,
    fromScratch: false,
    log,
  };
  const loopRun = {
    state,
    // The host lists the run's jobs (none) as the app does; anything else it answers with nothing.
    ctx: {
      cancelled: false,
      call: async (method: string): Promise<unknown> => (method === HostMethod.JobsList ? { jobs: [], seq: 0 } : null),
    },
    report: {},
    waitSeq: 0,
    logSeq: 0,
    run: { runId: "run_w", project: "sky", goal: "a blue sky", reference: { kind: "direction" } },
    journal: { director: { workers: {}, notes: [] } },
    inbox: {
      steering: async () => [],
      unheard: async () => [],
      notes: async () => [],
      finishing: async () => false,
      ...inbox,
    },
    routeUserSteers: async () => {},
    runningWorkers: () => [...state.workers.values()].filter((w) => w.state === "running"),
    notesSince: (seq: number) => log.filter((entry) => entry.seq > seq),
    appendRun: async (type: string, payload: Record<string, any>) => {
      events.push({ type, payload });
    },
    decision: async () => {},
    saveJournal: async () => {},
    ledgerLines: () => [],
    // The Loop's own record, which every run carries (`LoopRunData.open`): nothing has halted it.
    open: { halted: null },
  };
  const note = (text: string, kind?: string) => {
    loopRun.logSeq += 1;
    log.push({ at: at.now, seq: loopRun.logSeq, text, ...(kind ? { kind } : {}) });
  };
  const clock = {
    now: () => at.now,
    sleep: async (ms: number) => {
      at.now += ms;
      for (const tick of ticks) tick(at.now);
    },
  };
  /** The lead's turns, each answered by `script`; `keep` holds the session a turn answered with, as directorTalk does. */
  function lead(script: (turn: number, at: number) => Record<string, unknown>) {
    const calls: Array<{ prompt: string; sid: string | null | undefined; at: number }> = [];
    const talk: DirectorTalk = {
      sessionId: "lead-1",
      keep: async (result) => {
        if (result?.sessionId) talk.sessionId = result.sessionId;
      },
      session: async (prompt, sid) => {
        calls.push({ prompt, sid, at: at.now });
        return script(calls.length, at.now);
      },
    };
    return { talk, calls };
  }
  const run = (talk: DirectorTalk) => runWakeLoop(loopRun as never, talk, [LOOP_WORDS.started("a blue sky")], clock);
  return { T0, at, ticks, loopRun, state, worker, note, lead, run };
}

/** A wake that is no wrap-up: the running worker ends five minutes in, and the lead hears of it. */
function workerEndsSoon(w: ReturnType<typeof clockNight>): void {
  w.ticks.push((now) => {
    if (now < w.T0 + 5 * MINUTE_MS || w.worker.state !== "running") return;
    w.worker.state = "done";
    w.note("sky ended: the sky is painted", "worker_ended");
  });
}

/**
 * The wake loop, reviewed before it shipped: holes where a lead would sleep through the rest of
 * its working time, be woken again and again with nothing to read, open a session that knows
 * nothing, or have its last looks cut off by a wrap-up that started early.
 */
describe("the wake loop, reviewed", () => {
  // Flipped: the person's words came from the run's inbox, which records their hand-over, so a store
  // that refused the record needed a list of words told unrecorded (`heardUnrecorded`); the lead now
  // reads them from its line, and the record that it heard them is only the chat's receipt.
  it("I4. a store that refuses the record that the lead heard the person's words still tells it them once, and wakes it once for each", async () => {
    const chat = liveChat();
    chat.hooks.refuseHeard = true;
    chat.sayAt(chat.T0 + MINUTE_MS, "make the sky red");
    chat.sayAt(chat.T0 + 10 * MINUTE_MS, "and the benches oak");
    const one = chat.loopRun();
    await one.run((turn) => {
      if (turn === 3) one.state.finished = true;
      return worked;
    });
    assert.deepEqual(
      one.calls.slice(1).map((c) => c.prompt),
      ["make the sky red", "and the benches oak"],
      "each said once, as written, each its own wake",
    );
  });
});

/** The chat's messages as the queue's view of the log keeps them. */
const messageQueueStateOf = (log: Array<{ id: string; data: Record<string, any> }>) =>
  messageQueueState(log as never).messages;

/** Poll, yielding to the event loop, until it holds or the turns run out; whether it held. */
async function settleOn(check: () => boolean, turns = 2_000): Promise<boolean> {
  for (let n = 0; n < turns; n++) {
    if (check()) return true;
    await nextTurn();
  }
  return check();
}

/**
 * Live chat during a build (loop/live-chat.ts, loop/director/lead-line.ts), with no rig: the chat's
 * real queue hands messages to a run's real line, the run's real inbox reads them from the same
 * log, and the lead's wake loop runs on a clock the row moves, as director.ts drives it — the line
 * released when the run ends. `run({ resume })` opens a run of the same run on the same log,
 * as a Resume does; `closeBuild` is the run's close, after which the chat answers what waits.
 */
let liveChats = 0;
function liveChat() {
  const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);
  // Lines are kept by run: each row's run is a run of its own.
  const RUN = `run_live_${++liveChats}`;
  const THREAD = `t_${RUN}`;
  const at = { now: T0 };
  const ticks: Array<(now: number) => void> = [];
  const log: Array<{ id: string; data: Record<string, any> }> = [];
  const steers: Array<Record<string, any>> = [];
  const answered: string[] = [];
  /**
   * The host's knobs: a gate on appends, a hook before each read, whether it cuts a lead short or
   * its session reads input mid-turn (`native`), and a hold on its answer to a steer.
   */
  const hooks: {
    gate?: Promise<void>;
    gated: number;
    beforeList?: () => Promise<void>;
    cuts: boolean;
    native?: boolean;
    steerAnswer?: Promise<void>;
    /** The store refuses the record that the lead heard a message. */
    refuseHeard?: boolean;
  } = {
    gated: 0,
    cuts: true,
  };
  const artifacts = new Map<string, unknown>();
  const append = (batch: Array<Record<string, any>>) => {
    for (const data of batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
    return log.at(-1)?.id ?? null;
  };
  async function call(method: string, p: Record<string, any> = {}): Promise<any> {
    if (method === HostMethod.ArtifactWrite) return artifacts.set(p.artifactId, structuredClone(p.value)) && null;
    if (method === HostMethod.ArtifactRead) return artifacts.get(p.artifactId) ?? null;
    if (method === HostMethod.EngineSteer && hooks.native && p.native !== false) {
      steers.push(p);
      return { how: "native", accepted: p.messages.map((m: { id: string }) => m.id) };
    }
    if (method === HostMethod.EventsAppend) {
      if (hooks.gate) {
        hooks.gated += 1;
        await hooks.gate;
      }
      const heard = (p.batch ?? []).some((data: Record<string, any>) => data.event_type === "run_steering_delivered");
      if (hooks.refuseHeard && heard) throw new Error("events.append failed");
      return append(p.batch ?? []);
    }
    if (method === HostMethod.EventsList) {
      await hooks.beforeList?.();
      return p.after ? log.slice(log.findIndex((e) => e.id === p.after) + 1) : [...log];
    }
    if (method === HostMethod.EngineSteer) {
      steers.push(p);
      await hooks.steerAnswer;
      // The host cuts a lead that cannot read input mid-turn short — unless it is asked not to.
      const cut = hooks.cuts && p.interrupt !== false;
      return { how: cut ? "interrupt" : null, accepted: cut ? p.messages.map((m: { id: string }) => m.id) : [] };
    }
    return null;
  }
  const host = { call, notify: () => {}, heartbeat: () => {}, workspace: "/nowhere" };
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const build = { run: { runId: RUN, project: "plaza" }, threadId: THREAD, settled: closed, closed, done: false };
  const studio = {
    host,
    cancels: new Set<string>(),
    activeRuns: new Map([[RUN, build]]),
    startingRuns: new Map(),
    orphanRuns: new Map(),
  };
  const queue = new MessageQueue(
    host as never,
    async (action) => {
      answered.push(String(action.text));
    },
    (threadId, next) => chatWaitsFor(studio as never, threadId, next),
    () => false,
    (threadId, action) => leadDoor(studio as never, threadId, action),
  );
  const say = (text: string, extra: Record<string, unknown> = {}) =>
    queue.enqueue({ type: "user_message", threadId: THREAD, text, ...extra });
  /** The id the queue saved a message under, by its words. */
  const idOf = (text: string): string =>
    log.find((e) => e.data.event_type === "coordinator_message_queued" && e.data.payload.action?.text === text)!.data
      .payload.messageId;
  /** The words of the messages that went back to the chat, in order. */
  const requeued = (): string[] =>
    log
      .filter((e) => e.data.event_type === "coordinator_message_requeued")
      .map((e) => log.find((q) => q.data.payload?.messageId === e.data.payload.messageId)!.data.payload.action.text);
  const clock = {
    now: () => at.now,
    sleep: async (ms: number) => {
      at.now += ms;
      for (const tick of ticks) tick(at.now);
      await nextTurn();
    },
  };
  /** Send `text` once the clock reaches `when`. */
  const sayAt = (when: number, text: string) => {
    let sent = false;
    ticks.push((now) => {
      if (sent || now < when) return;
      sent = true;
      void say(text);
    });
  };
  /** A run of the row's; `sessionId` is the session its lead resumes, null for a lead that opens a fresh one. */
  function loopRun({ resume = false, sessionId = "lead-1" as string | null } = {}) {
    const notes: Array<{ at: number; seq: number; text: string; kind?: string }> = [];
    const worker = { id: "sky", title: "Sky", state: "running", iterations: [], brief: "paint the sky" };
    const state = {
      monitor: {},
      finished: false,
      limit: null as Record<string, unknown> | null,
      planReviewUntil: null,
      planGo: false,
      planSaidFrom: 0,
      workerLimit: null,
      workers: new Map([["sky", { ...worker, deadline: T0 + 3 * HOUR_MS, stopRequested: false }]]),
      integrationHead: null,
      integrationHealthy: null,
      ledger: [],
      plan: null,
      fromScratch: false,
      log: notes,
    };
    const ctx = {
      threadId: THREAD,
      cancelled: false,
      workspace: "/nowhere",
      call,
      notify: () => {},
      setStatus: () => {},
    };
    const n: Record<string, any> = {
      state,
      ctx,
      report: {},
      waitSeq: 0,
      logSeq: 0,
      threadId: THREAD,
      run: { runId: RUN, project: "plaza", goal: "a dusk plaza", reference: { kind: "direction" } },
      resume,
      priorJournal: resume ? { director: { workers: {}, notes: [] } } : null,
      journal: { director: { workers: {}, notes: [] } },
      inbox: createRunInbox(ctx as never, { threadId: THREAD, runId: RUN }),
      routeUserSteers: async () => {},
      runningWorkers: () => [...state.workers.values()].filter((w) => w.state === "running"),
      notesSince: (seq: number) => notes.filter((entry) => entry.seq > seq),
      appendRun: async () => {},
      decision: async () => {},
      saveJournal: async () => {},
      ledgerLines: () => [],
      // The Loop's own record, which every run carries (`LoopRunData.open`): nothing has halted it.
      open: { halted: null },
    };
    // As director.ts opens it: live while the run goes on, recording on the run's own log.
    const line = openLeadLine(RUN, THREAD, () => !state.finished && !ctx.cancelled && !n.report.failure, ctx as never);
    const calls: Array<{ prompt: string; at: number; said?: Record<string, unknown> }> = [];
    /** The app quits under this run: nothing of it moves again, its clock included. */
    let quit = false;
    const runClock = {
      now: clock.now,
      sleep: (ms: number) => (quit ? new Promise<void>(() => {}) : clock.sleep(ms)),
    };
    const appQuits = () => {
      quit = true;
    };
    /** The run, each of the lead's turns answered by `script`; its line released when it ends, as director.ts does. */
    const run = async (script: (turn: number) => unknown) => {
      const talk: DirectorTalk = {
        sessionId,
        keep: async (result) => {
          if (result?.sessionId) talk.sessionId = result.sessionId;
        },
        session: async (prompt, _sid, said) => {
          calls.push({ prompt, at: at.now, ...(said ? { said: { ...said } } : {}) });
          return (await script(calls.length)) as never;
        },
      };
      await runWakeLoop(n as never, talk, [LOOP_WORDS.started("a dusk plaza")], runClock, line);
      await line.release();
    };
    return { n, state, ctx, line, calls, run, appQuits };
  }
  const closeBuild = () => {
    build.done = true;
    close();
  };
  return {
    T0,
    RUN,
    at,
    ticks,
    log,
    steers,
    answered,
    hooks,
    queue,
    say,
    sayAt,
    idOf,
    requeued,
    loopRun,
    closeBuild,
    append,
  };
}

/** The lead's turn that worked on its message: a session, and a turn taken. */
const worked = { ok: true, sessionId: "lead-1", turns: 1 };
/** The lead's turn the chat's words cut short: its session stopped at its next step, to be resumed with them. */
const cutShort = { ok: false, stopReason: "stopped", sessionId: "lead-1", turns: 1 };

/**
 * Live chat during a build, reviewed before it shipped: every chat message is now a steer of the
 * run, so a resumed run told the lead the whole run's chat again; a failed turn, a line
 * released under a message, and a message handed while the lead's inbox was read lost or doubled
 * what the user said; a lead that cannot read input mid-turn was cut short inside a tool call; and
 * the chat's own wakes used up the lead's hourly cap.
 */
/**
 * A provider that disables the account mid-run is no verdict on anybody's work: the run pauses
 * (nothing landed, no wrap-up, Resume carries on), no round is counted broken or auto-tied, and
 * nobody asks the provider again.
 */
describe("a provider lost mid-run", () => {
  const DISABLED =
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

  it("D6. a limit that names its reset holds its engine until then and no longer; one that names none is retried as before", () => {
    const at = Date.UTC(2026, 9, 6, 11, 7, 0);
    try {
      const limit = { kind: "rate_limit", message: "session limit", retryAfterMs: 60_000 };
      noteProviderLoss("run_limit", "claude-code", limit, at);
      assert.equal(providerLossFor("run_limit", "claude-code", at + 59_000)?.kind, "rate_limit");
      assert.equal(providerLossFor("run_limit", "claude-code", at + 60_000), null, "reset: the circuit closes");
      assert.equal(providerLossFor("run_limit", "codex", at), null, "another engine is not lost");
      assert.equal(providerLossFor("run_other", "claude-code", at), null, "nor another run");
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "rate_limit", message: "429" }, at), null);
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "other", message: "boom" }, at), null);
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "unavailable", message: "529" }, at), null);
    } finally {
      forgetProviderLosses("run_limit");
    }
  });

  it("D7. a lead whose account is disabled on a wake pauses the run: no wrap-up turn, the loss kept for the close", async () => {
    const w = clockNight();
    workerEndsSoon(w);
    try {
      const { talk, calls } = w.lead((turn) => {
        if (turn === 1) return { ok: true, sessionId: "lead-1" };
        throw new EngineError("auth", "claude-code", DISABLED);
      });
      const outcome = await w.run(talk);
      assert.equal(calls.length, 2, calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
      assert.equal(outcome.wrapCause, null, "no wrap-up started");
      assert.equal(w.state.limit?.kind, "auth");
      assert.match(String(w.state.limit?.message), /disabled Claude subscription access/);
    } finally {
      forgetProviderLosses("run_w");
    }
  });

  it("D8. a lead's first turn that meets a disabled account pauses the run instead of crashing it", async () => {
    const w = clockNight();
    try {
      const { talk, calls } = w.lead(() => {
        throw new EngineError("auth", "claude-code", DISABLED);
      });
      await w.run(talk);
      assert.equal(calls.length, 1);
      assert.equal(w.state.limit?.kind, "auth");
    } finally {
      forgetProviderLosses("run_w");
    }
  });

  it("D9. a lead turn the provider's outage ended is not a failed turn: the run pauses, it does not wrap up", async () => {
    const w = clockNight();
    workerEndsSoon(w);
    const { talk, calls } = w.lead((turn) =>
      turn === 1
        ? { ok: true, sessionId: "lead-1" }
        : { ok: false, stopReason: "error", errorText: "API Error: 529 Overloaded", sessionId: "lead-1" },
    );
    const outcome = await w.run(talk);
    assert.equal(outcome.wrapCause, null, calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.ok(
      calls.slice(1).every((c) => c.prompt === calls[1]!.prompt),
      "only the same message, asked again",
    );
    assert.equal(w.state.limit?.kind, "unavailable");
    assert.equal(w.state.limit?.retryAfterMs, null);
  });

  // Live, 2026-10-15: a 2-hour Unreal Loop ended 6 minutes in when the Mac's network dropped, and
  // its closing words said the time ran out.
  it("D9b. a lead turn that couldn't reach the API (no network, no DNS) pauses the run like any outage", async () => {
    const unreachable = [
      "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
      "API Error: connect ENETUNREACH 160.79.104.10:443",
      "API Error: connect EHOSTUNREACH 160.79.104.10:443",
      "API Error: getaddrinfo ENOTFOUND api.anthropic.com",
      "API Error: ENETDOWN",
    ];
    for (const errorText of unreachable) {
      const w = clockNight();
      workerEndsSoon(w);
      const { talk } = w.lead((turn) =>
        turn === 1
          ? { ok: true, sessionId: "lead-1" }
          : { ok: false, stopReason: "error", errorText, sessionId: "lead-1" },
      );
      const outcome = await w.run(talk);
      assert.equal(outcome.wrapCause, null, errorText);
      assert.equal(w.state.limit?.kind, "unavailable", errorText);
    }
  });
});

describe("live chat during a build, reviewed", () => {
  /**
   * Run one: the lead hears "is the sky dusk yet?" (woken by it) and "then light the lamps"
   * (woken by it), then, in the turn the lamps woke, the user adds "and add some fog". The run
   * then ends as `ending` says: Stop, the app quitting mid-turn, or the engine's usage limit.
   */
  async function loopRunOne(ending: "stop" | "restart" | "limit") {
    const chat = liveChat();
    // The host refuses the words mid-turn: they wait for the lead's next message.
    chat.hooks.cuts = false;
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    chat.sayAt(chat.T0 + 2 * MINUTE_MS, "then light the lamps");
    const one = chat.loopRun();
    const quit = one.run(async (turn) => {
      if (turn < 3) return worked;
      void chat.say("and add some fog");
      await settleOn(() => chat.steers.length === 1);
      if (ending === "restart") return new Promise(() => {});
      if (ending === "limit") {
        one.state.limit = { kind: "usage_limit", message: "out of usage", retryAfterMs: null, at: chat.at.now };
        return { ok: false, stopReason: "usage_limit", sessionId: "lead-1" };
      }
      one.ctx.cancelled = true;
      return worked;
    });
    if (ending === "restart") {
      // The app quits in the middle of the turn: nothing more of this run happens, nothing is given back.
      await settleOn(() => chat.steers.length === 1);
      chat.queue.stop();
      one.appQuits();
    } else {
      await quit;
      chat.closeBuild();
    }
    assert.equal(one.calls.length, 3, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    return chat;
  }

  /** Run two of the same run, resumed: the first message it opens with. */
  async function resumedFirst(chat: ReturnType<typeof liveChat>) {
    const two = chat.loopRun({ resume: true });
    await two.run(() => {
      two.state.finished = true;
      return worked;
    });
    return two.calls[0]!;
  }

  it("LC1a. Stop, then Resume: the resumed lead is told only what the chat said since, never the run's chat again", async () => {
    const chat = await loopRunOne("stop");
    assert.deepEqual(chat.requeued(), ["and add some fog"], "Stop gave back only what the lead never heard");
    await settleOn(() => chat.answered.length === 1);
    assert.deepEqual(chat.answered, ["and add some fog"]);
    // The chat's answer resumed the run with a new instruction (resume_run records it as a steer).
    chat.append([
      {
        type: "custom",
        event_type: "run_steering",
        payload: { runId: chat.RUN, text: "then keep going", sourceMessageId: chat.idOf("and add some fog") },
      },
    ]);
    // Flipped: the resumed lead was told "then keep going" as the person's; the chat's session wrote it
    // into `resume_run` itself, and that session is the lead, so it opens with Genex's line alone.
    const first = await resumedFirst(chat);
    assert.equal(first.prompt, LOOP_WORDS.started("a dusk plaza"));
    assert.equal(first.said?.from, MessageFrom.Genex);
  });

  it("LC1b. the app quits mid-turn, then Resume: the lead is told what it never heard — and nothing it had", async () => {
    const chat = await loopRunOne("restart");
    assert.deepEqual(chat.requeued(), [], "a quit gives nothing back: the words stay with the run");
    const first = await resumedFirst(chat);
    assert.equal(first.prompt, "then light the lamps\n\nand add some fog", "as written, the person's");
    assert.equal(first.said?.from, MessageFrom.Person);
  });

  it("LC1c. the engine's limit pauses the run, then Resume: what went back to the chat is not told again, nor what the lead heard", async () => {
    const chat = await loopRunOne("limit");
    assert.deepEqual(chat.requeued(), ["then light the lamps", "and add some fog"]);
    assert.equal((await resumedFirst(chat)).prompt, LOOP_WORDS.started("a dusk plaza"));
  });

  it("LC2. a lead in the middle of a tool call is never cut short for the chat; a cut turn resumes with the person's words alone", async () => {
    const chat = liveChat();
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    const one = chat.loopRun();
    const words = (steer: Record<string, any>): string[] => steer.messages.map((m: SteerMessage) => m.text);
    const oak = () => chat.steers.find((steer) => words(steer).includes("and the benches oak"));
    await one.run(async (turn) => {
      if (turn === 1) return worked;
      if (turn === 3) {
        one.state.finished = true;
        return worked;
      }
      // Turn 2 is inside a tool call (an integrate, say) when the user speaks.
      one.n.toolsInFlight = 1;
      void chat.say("make the sky red");
      await settleOn(() => chat.steers.length > 0);
      // The call returned; the user speaks again, and this time the turn may be cut.
      one.n.toolsInFlight = 0;
      void chat.say("and the benches oak");
      await settleOn(() => oak() !== undefined);
      return { ok: false, stopReason: "stopped", sessionId: "lead-1", turns: 1 };
    });
    const inCall = chat.steers.filter((steer) => steer !== oak());
    assert.ok(inCall.length > 0);
    assert.ok(
      inCall.every((steer) => steer.interrupt === false),
      "inside a tool call the words wait for the turn's end",
    );
    assert.equal(oak()?.interrupt, true, "the next words, outside it, cut the turn — the waiting ones with them");
    // Flipped: each message a steer of its own, as they wrote it, nothing of Genex's around it.
    assert.deepEqual(words(oak()!), ["make the sky red", "and the benches oak"]);
    assert.ok(
      oak()!.messages.every((m: SteerMessage) => m.from === undefined),
      "the person's: no sender mark",
    );
    assert.equal(one.calls.length, 3);
    assert.equal(one.calls[2]!.prompt, "make the sky red\n\nand the benches oak", "resumed with their words alone");
    assert.equal(one.calls[2]!.said?.from, "person");
  });

  it("LC3. a turn that failed before it worked on its message owes the user's words to the next one, and they are never given back twice", async () => {
    const chat = liveChat();
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    const one = chat.loopRun();
    await one.run((turn) => {
      if (turn === 1) return worked;
      if (turn === 2) throw new Error("the provider broke");
      one.state.finished = true;
      return worked;
    });
    assert.equal(one.calls.length, 3, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[1]!.prompt, "is the sky dusk yet?");
    assert.equal(one.calls[2]!.prompt, "is the sky dusk yet?", "the wrap-up says them again");
    assert.match(String(one.calls[2]!.said?.notices), /^Your last turn failed \(the provider broke\): the Loop closes/);
    assert.deepEqual(chat.requeued(), [], "heard in the wrap-up: nothing goes back to the chat");
  });

  it("LC5. a message handed to a lead whose run ended under it comes back at once, and the chat answers it", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    let write = () => {};
    chat.hooks.gate = new Promise<void>((resolve) => {
      write = resolve;
    });
    // The lead takes it, and its receipt is being written…
    const sending = chat.say("is it done?");
    assert.ok(await settleOn(() => chat.hooks.gated === 1), "the receipt is being written");
    // …when the run ends and its line is released.
    one.state.finished = true;
    await one.line.release();
    chat.hooks.gate = undefined;
    write();
    await sending;
    assert.deepEqual(chat.requeued(), ["is it done?"], "given back at once, not left with a run that is over");
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1), "the chat answers it");
  });

  // Flipped: the race was a message handed while the lead's message was read from the run's inbox;
  // the lead reads its line, so what waits there is read whole, each message as written.
  it("LC6. what the person sent while the lead could not read it wakes it once, every message as written, none given back", async () => {
    const chat = liveChat();
    chat.hooks.cuts = false;
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.ctx.cancelled = true;
        return worked;
      }
      void chat.say("is the sky dusk yet?");
      void chat.say("and the benches oak");
      await settleOn(() => chat.steers.length === 2);
      return worked;
    });
    assert.equal(one.calls.length, 2);
    assert.equal(one.calls[1]!.prompt, "is the sky dusk yet?\n\nand the benches oak");
    assert.deepEqual(chat.requeued(), [], "the lead heard both: Stop gives neither back");
  });

  it("LC19. a note about a build ahead of a chat message the lead never heard: Stop gives the chat its message back, the note stays with the run", async () => {
    const chat = liveChat();
    chat.hooks.cuts = false;
    const NOTE = "[USER FEEDBACK on Sky · try 2] make it darker";
    const one = chat.loopRun();
    await one.run(async () => {
      chat.append([{ type: "custom", event_type: "run_steering", payload: { runId: chat.RUN, text: NOTE } }]);
      await settleOn(() => one.line.unheard().length === 1);
      await chat.say("and the moon?");
      await settleOn(() => one.line.unheard().length === 2);
      one.ctx.cancelled = true;
      return worked;
    });
    chat.closeBuild();
    assert.deepEqual(chat.requeued(), ["and the moon?"], "the chat answers its own message");
    const resumed = createRunInbox(one.ctx as never, { threadId: `t_${chat.RUN}`, runId: chat.RUN });
    assert.deepEqual(
      (await resumed.notes()).map((note) => note.text),
      [NOTE],
      "a Resume hands the note to its lead",
    );
  });

  /** Where each of the chat's messages stands, by its words. */
  const standing = (chat: ReturnType<typeof liveChat>) =>
    Object.fromEntries(
      [...messageQueueStateOf(chat.log).values()].map((m) => [
        String(m.action?.text),
        `${m.state}${m.into ? ` ${m.into}` : ""}`,
      ]),
    );
  const picture = { stills: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] };

  // Flipped: a picture reaches the lead, alone or with words (as an image block, LM1, LM4); a slash command waits.
  it("LC7. a slash command waits for the chat, and what is sent after it — a picture alone too — still reaches the lead, in order", async () => {
    const chat = liveChat();
    chat.loopRun();
    await chat.say("/compact");
    await chat.say("", picture);
    await chat.say("make the sky red");
    const lead = `delivered ${chat.RUN}`;
    assert.deepEqual(standing(chat), {
      "/compact": "queued",
      "": lead,
      "make the sky red": lead,
    });
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["/compact"], "the chat runs the command once the build closes");
  });

  it("LC8. what waited while the run prepared reaches the lead once its line opens — past a slash command among it", async () => {
    const chat = liveChat();
    // The build is under way, but its lead has no line yet: everything waits.
    await chat.say("is it started?");
    await chat.say("/compact");
    await chat.say("", picture);
    assert.ok(await settleOn(() => Object.values(standing(chat)).every((state) => state === "queued")));
    chat.loopRun();
    const lead = `delivered ${chat.RUN}`;
    assert.ok(await settleOn(() => standing(chat)[""] === lead), JSON.stringify(standing(chat)));
    assert.deepEqual(standing(chat), {
      "is it started?": lead,
      "/compact": "queued",
      "": lead,
    });
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["/compact"]);
  });

  // Flipped: the lead reads the picture itself (LM1), never a line naming a file it should open.
  it("LC11. a picture the chat saved in the game's references reaches the lead with the words alone, as typed", async () => {
    const chat = liveChat();
    chat.loopRun();
    const saved = { ...picture, references: ["references/skydome-warning-1a2b3c4d.png"] };
    await chat.say("i got this msg", saved);
    await chat.say("does it look like this?", picture);
    assert.deepEqual(standing(chat), {
      "i got this msg": `delivered ${chat.RUN}`,
      "does it look like this?": `delivered ${chat.RUN}`,
    });
    const heard = chat.log.filter((e) => e.data.event_type === "run_steering").map((e) => e.data.payload.text);
    assert.deepEqual(heard, ["i got this msg", "does it look like this?"]);
  });

  it("LC9. a run that crashed before its lead's loop began gives every message it was handed back to the chat", async () => {
    const back: string[][] = [];
    const line = openLeadLine("run_crash", "t_crash", () => true);
    const giveBack = async (items: Array<{ text?: string }>) => {
      back.push(items.map((item) => String(item.text)));
    };
    line.hear({ threadId: "t_crash", messageId: "m1", text: "is it started?" }, giveBack);
    line.hear({ threadId: "t_crash", messageId: "m2", text: "and the sky?" }, giveBack);
    // What director.ts does when the run crashes before `runWakeLoop` ever took the line.
    await line.release();
    assert.deepEqual(back, [["is it started?", "and the sky?"]]);
  });

  it("LC10. a message after Stop does not undo it for the run: the chat takes the message, the run stays stopped", async () => {
    const cancels = new Set<string>();
    const host = {
      call: async (method: string) => {
        if (method === HostMethod.EventsList) return [];
        throw new Error(`${method}: not in this row`);
      },
      notify: () => {},
    };
    const threadCtx = (threadId: string) => ({
      threadId,
      call: host.call,
      notify: host.notify,
      setStatus: () => {},
      get cancelled() {
        return cancels.has(threadId);
      },
    });
    const closedRun = {
      run: { runId: "run_done", project: "plaza" },
      threadId: "t_pass",
      settled: new Promise(() => {}),
      done: true,
    };
    const studio = {
      host,
      cancels,
      activeRuns: new Map([["run_done", closedRun]]),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: threadCtx,
    };
    // The run has closed and settles.
    // Stop in its chat, as the loop's dispatch takes it.
    cancels.add("t_pass");
    stopRunsOf(studio as never, "t_pass");
    // A new message: the chat's own stop is over, and it answers.
    await handleUserMessage(studio as never, { threadId: "t_pass", text: "what did you finish?" }).catch(() => {});
    assert.equal(cancels.has("t_pass"), false, "the chat takes the message");
    assert.equal((closedRun as { stopped?: boolean }).stopped, true, "the Stop that reached the run stays");
  });

  /*
   * A Codex lead could not hear the chat for its whole first turn — up to an open Loop's 45 minutes:
   * "stop, just test computer use" was shown as delivered and read by nobody until the person pressed
   * Stop. A first turn with a session to resume is cut for the words like any other.
   */
  it("LC12. a lead's first turn with a session to resume is cut short for the user's words, and resumed with them alone", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("stop building, just test computer use");
      await settleOn(() => chat.steers.length > 0);
      return { ok: false, stopReason: "stopped", sessionId: "lead-1", turns: 4 };
    });
    assert.equal(chat.steers[0]?.interrupt, true, "the first turn may be cut for the words");
    // Flipped: the words alone; that a stop is wrap_up is said once, in wrap_up's own description.
    assert.equal(chat.steers[0]?.messages[0]?.text, "stop building, just test computer use");
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[1]?.prompt, "stop building, just test computer use", "resumed with their words alone");
    assert.equal(one.calls[1]?.said?.from, "person");
  });

  // Flipped: the brief was asked again with the words glued after it ("SINCE THEN: THE USER SAYS…");
  // the turn resumes with the words that cut it, Genex's start line beside them.
  it("LC13. a first turn cut before its session began is resumed with the words, its start line beside them, never crashing the run", async () => {
    const chat = liveChat();
    // The host's answer to the cut reaches the loop only after the failure the cut caused.
    let answer = () => {};
    chat.hooks.steerAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("stop building");
      await settleOn(() => chat.steers.length > 0);
      setImmediate(answer);
      // The host was still preparing the session's tools when the cut came.
      throw new EngineError("aborted", "codex", "stopped before the contractor started");
    });
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[1]!.prompt, "stop building");
    assert.deepEqual(one.calls[1]!.said?.notices, [LOOP_WORDS.started("a dusk plaza")], "the start it never read");
  });

  it("LC14. a first turn with no session to resume yet is left alone: the words open the next message", async () => {
    const chat = liveChat();
    const one = chat.loopRun({ sessionId: null });
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("is it started?");
      await settleOn(() => chat.steers.length > 0);
      return { ok: true, sessionId: "lead-9", turns: 2 };
    });
    assert.equal(chat.steers[0]?.interrupt, false, "a cut would leave nothing to resume");
    assert.equal(one.calls[1]?.prompt, "is it started?");
  });

  it("LC15. a picture sent before (its file the game's already) reaches the lead with the words as typed", async () => {
    const chat = liveChat();
    chat.loopRun();
    // Saved before, so this message added no file of its own: only `pictureFiles` names where it is.
    const again = { ...picture, pickedImages: 1, references: [], pictureFiles: ["references/sky-1a2b3c4d.png"] };
    await chat.say("this one again", again);
    assert.deepEqual(standing(chat), { "this one again": `delivered ${chat.RUN}` });
    const heard = chat.log.find((e) => e.data.event_type === "run_steering")?.data.payload.text;
    assert.equal(heard, "this one again", "flipped: no line naming the file");
  });

  it("LC16. a picture the person's words name by its path (no picture attached) reaches the lead with the words", async () => {
    const chat = liveChat();
    chat.loopRun();
    await chat.say("look at ~/Desktop/sky.png", { ...picture, pickedImages: 0 });
    assert.deepEqual(standing(chat), { "look at ~/Desktop/sky.png": `delivered ${chat.RUN}` });
  });

  /*
   * One session per chat: the session that heard a message in the wrap-up is the chat's own, and
   * answers it there. The chat no longer kept it to answer a second time after the close.
   */
  it("LC17. in the wrap-up the lead hears the person's words as they wrote them, and the chat never answers them again", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    // Flipped (no clock): the working time being over made the first turn the wrap-up; the person's
    // Finish makes the turn after the first one the wrap-up.
    one.n.inbox = { ...one.n.inbox, finishing: async () => true };
    await one.run(async (turn) => {
      if (turn === 1) return worked;
      void chat.say("also add rain");
      await settleOn(() => chat.steers.length > 0);
      one.state.finished = true;
      return { ...worked, steered: chat.steers.map((steer) => steer.messages[0].id) };
    });
    // Flipped: "The user asked to finish, so the wrap-up starts now." and the web wrap-up's rules.
    assert.equal(one.calls[1]?.prompt, LOOP_WORDS.finishAsked);
    assert.equal(chat.steers[0]?.interrupt, false, "the wrap-up is never cut short");
    assert.deepEqual(
      chat.steers[0]?.messages.map(({ id: _id, ...said }: Record<string, unknown>) => said),
      [{ text: "also add rain" }],
    );
    assert.deepEqual(standing(chat), { "also add rain": `delivered ${chat.RUN}` });
    const told = chat.log.filter((e) => e.data.event_type === "run_steering").map((e) => e.data.payload);
    assert.deepEqual(
      told.map((payload) => [payload.text, "kept" in payload]),
      [["also add rain", false]],
    );
    chat.closeBuild();
    await settleOn(() => chat.answered.length > 0, 200);
    assert.deepEqual(chat.answered, [], "heard in the wrap-up: never answered a second time");
  });

  it("LC18. words a wrap-up turn could not read go back to the chat when its line is released, and the chat answers them", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    // Flipped (no clock): as LC17, the person's Finish makes the second turn the wrap-up.
    one.n.inbox = { ...one.n.inbox, finishing: async () => true };
    await one.run(async (turn) => {
      if (turn === 1) return worked;
      if (turn === 2) {
        void chat.say("also add rain");
        await settleOn(() => chat.steers.length > 0);
      }
      one.state.finished = true;
      return worked;
    });
    assert.equal(chat.steers[0]?.interrupt, false, "the wrap-up is never cut short");
    assert.equal(chat.steers[0]?.messages[0]?.text, "also add rain");
    assert.deepEqual(chat.requeued(), ["also add rain"]);
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["also add rain"], "and the chat answers it once the build closed");
  });

  /*
   * The lead read the person's words wrapped in Genex's: "THE USER SAYS (verbatim, oldest first):",
   * then a paragraph of rules — and on an engine cut for them, "YOUR LAST TURN WAS CUT SHORT…" and
   * a whole digest. Their pictures reached it as a line naming a file, when the chat had saved one.
   */
  it("LM1. the lead receives the person's words as they wrote them, their picture an image block", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    const sky = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "sky" };
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("hdrp или urp?", { stills: [sky] });
      await settleOn(() => chat.steers.length > 0);
      return cutShort;
    });
    assert.equal(chat.steers.length, 1);
    const said = chat.steers[0]!.messages.map(({ id: _id, ...message }: Record<string, unknown>) => message);
    // Flipped: a steer marks only Genex's; the person's carries no sender.
    assert.deepEqual(said, [{ text: "hdrp или urp?", images: [sky] }]);
    // Flipped (castle-artillery): read mid-turn on an engine that takes input as it works; their words
    // now cut the turn, and the turn after it opens with them and their picture.
    assert.equal(one.calls[1]?.prompt, "hdrp или urp?");
    assert.deepEqual(one.calls[1]?.said?.images, [sky]);
    assert.deepEqual(chat.requeued(), [], "heard in the turn they opened");
  });

  it("LM3. a message Genex wrote, sent during a build, reaches the lead as Genex's, never as the person's", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    await one.run(async () => {
      void chat.say("You turned on the Blender plugin.", { origin: "plugin-turned-on", from: "genex" });
      await settleOn(() => chat.steers.length > 0);
      one.state.finished = true;
      return { ...worked, steered: chat.steers.map((steer) => steer.messages[0].id) };
    });
    const said = chat.steers[0]!.messages.map(({ id: _id, ...message }: Record<string, unknown>) => message);
    assert.deepEqual(said, [{ text: "You turned on the Blender plugin.", from: "genex" }]);
    const recorded = chat.log.filter((e) => e.data.event_type === "run_steering").map((e) => e.data.payload.from);
    assert.deepEqual(recorded, ["genex"], "the lead's inbox keeps who wrote it");
  });

  it("LM4. a picture sent alone during a build reaches the lead as an image block, not once the build has closed", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    const sky = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "sky" };
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("", { stills: [sky] });
      await settleOn(() => chat.steers.length > 0);
      return cutShort;
    });
    const said = chat.steers[0]!.messages.map(({ id: _id, ...message }: Record<string, unknown>) => message);
    assert.deepEqual(said, [{ text: "", images: [sky] }]);
    assert.deepEqual(standing(chat), { "": `delivered ${chat.RUN}` });
    // Flipped (castle-artillery): read mid-turn; the person's picture now cuts the turn, and the next opens with it.
    assert.deepEqual(one.calls[1]?.said?.images, [sky]);
    assert.deepEqual(chat.requeued(), [], "heard in the turn it opened");
  });

  it("LM2. a worker's end said into the lead's turn is Genex's, and Claude Code takes it as not the person's", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    const line = { at: chat.T0, seq: 1, text: 'worker sky "Sky" ended: done.', kind: "worker_ended" };
    await one.run(async () => {
      one.n.logSeq = 1;
      one.state.log.push(line);
      await settleOn(() => chat.steers.length > 0);
      one.state.finished = true;
      return worked;
    });
    const news = chat.steers[0]!;
    assert.equal(news.interrupt, false);
    const [message] = news.messages as SteerMessage[];
    assert.equal(message?.text, line.text);
    assert.equal(message?.from, "genex");
    // Claude Code's own input for it: CLI 2.1.257 shows it under "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]".
    const readies: Array<SteerSend | null> = [];
    const feed = steerFeed(
      steerSession((send) => readies.push(send)),
      userFrame("brief", []),
      new AbortController().signal,
      () => "ses_lead",
    );
    const input = feed.prompt[Symbol.asyncIterator]();
    await input.next();
    feed.initialized({ capabilities: ["msg_lifecycle_v1"] }, false);
    assert.equal(readies[0]!(message!), true);
    const frame = (await input.next()).value as Record<string, unknown>;
    assert.equal(frame.isSynthetic, true);
    assert.equal("origin" in frame, false, "never the person's: no human origin");
    feed.dispose();
  });
});

/**
 * A Claude Code lead building an Unreal game was asked "How is it going?", then "Man you hear me? Can
 * you answer please": both reached its turn mid-turn, beside a tool's result, and it went on writing
 * code with no word back (its turn had started with Genex's "The Loop started" half an hour before).
 * The person's words now cut the turn at its next step on an engine that reads input mid-turn too,
 * and the same session goes on with them as the person's own message. Genex's words go in mid-turn
 * and cut nothing, and inside a tool call the person's do too, as before.
 */
describe("the lead built on past the person's words (castle-artillery)", () => {
  /** How each steer asked to be delivered: whether it may cut the turn, and whether it may be read mid-turn. */
  const asked = (chat: ReturnType<typeof liveChat>) => chat.steers.map((steer) => [steer.interrupt, steer.native]);
  /** The ids a steer carried, as the session reports what it read mid-turn. */
  const idsOf = (steer: { messages?: SteerMessage[] } | undefined): string[] =>
    (steer?.messages ?? []).map((m) => m.id);

  it("CA1. the person's words while a Claude Code lead works cut its turn, and the next turn opens with them as they wrote them", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    // The run ends ten minutes on, its worker still at work, whether or not a turn came for the words.
    chat.ticks.push((now) => {
      if (now >= chat.T0 + 10 * MINUTE_MS) one.state.finished = true;
    });
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("How is it going?");
      await settleOn(() => chat.steers.length > 0);
      // Read mid-turn, the turn goes on and ends without a word to them; cut, it stops at its next step.
      return chat.steers[0]?.native === false ? cutShort : { ...worked, steered: idsOf(chat.steers[0]) };
    });
    assert.deepEqual(asked(chat), [[true, false]], "never read beside a tool's result: the turn is cut for them");
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[1]?.prompt, "How is it going?", "the same session goes on with their message, as written");
    assert.equal(one.calls[1]?.said?.from, MessageFrom.Person);
    assert.deepEqual(chat.requeued(), [], "heard by the lead: never given back");
  });

  it("CA2. inside a tool call the person's words still reach a Claude Code lead's turn mid-turn, and never cut it there", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    await one.run(async () => {
      one.n.toolsInFlight = 1;
      void chat.say("is the door done?");
      await settleOn(() => chat.steers.length > 0);
      one.state.finished = true;
      return { ...worked, steered: idsOf(chat.steers[0]) };
    });
    assert.deepEqual(asked(chat), [[false, undefined]], "read at the session's next step, as before");
    assert.equal(one.calls.length, 1);
    assert.deepEqual(chat.requeued(), []);
  });

  it("CA3. a message Genex wrote in the chat during a build goes into a Claude Code lead's turn mid-turn, never cutting it", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    await one.run(async () => {
      void chat.say("You turned on the Blender plugin.", { origin: "plugin-turned-on", from: "genex" });
      await settleOn(() => chat.steers.length > 0);
      one.state.finished = true;
      return { ...worked, steered: idsOf(chat.steers[0]) };
    });
    assert.notEqual(chat.steers[0]?.native, false, "Genex's own words are read mid-turn");
    assert.equal(one.calls.length, 1, "no turn cut for them");
  });
});

/**
 * A resting lead was woken with a digest around the person's words: "WOKEN AT 09:01 UTC — the user
 * spoke; a worker ended", "THE USER SAYS (verbatim, oldest first):", "WHAT HAPPENED:", "WHERE THE
 * RUN STANDS:" and "Act on it…", and every worker's or job's end carried what to do next. Now a
 * resting lead is woken by the person's message alone, as they wrote it, or by Genex's one-line
 * facts, marked as Genex's; what comes while it works reaches that turn at its next step.
 */
describe("a person's words woke the lead inside a digest (digest-wake)", () => {
  /** A line of the run's log, as a worker's end writes it while the lead rests. */
  const noteEnd = (one: ReturnType<ReturnType<typeof liveChat>["loopRun"]>, at: number, text: string) => {
    one.n.logSeq += 1;
    one.state.log.push({ at, seq: one.n.logSeq, text, kind: "worker_ended" });
  };
  const SKY_DONE = 'worker w1 "Sky" ended: done.';
  const SEA_DONE = 'worker w2 "Sea" ended: failed.';

  it("DW1. words sent while the lead rests wake it with the words alone; two workers' ends ride beside them as Genex's", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    const at = chat.T0 + MINUTE_MS;
    let ended = 0;
    chat.ticks.push((now) => {
      if (ended === 0 && now >= at) noteEnd(one, at, SKY_DONE), (ended = 1);
      if (ended === 1 && now >= at + 2_000) noteEnd(one, at + 2_000, SEA_DONE), (ended = 2);
    });
    chat.sayAt(at + 3_000, "hdrp или urp?");
    await one.run((turn) => {
      if (turn === 2) one.state.finished = true;
      return worked;
    });
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[1]!.prompt, "hdrp или urp?", "the person's words, as they wrote them");
    assert.equal(one.calls[1]!.said?.from, MessageFrom.Person);
    assert.deepEqual(one.calls[1]!.said?.notices, [`${SKY_DONE}\n${SEA_DONE}`], "Genex's lines beside them, marked");
    assert.deepEqual(chat.steers, [], "nothing said again into the turn they woke");
  });

  // Flipped (castle-artillery): the message was read by the turn it reached, mid-turn, and that turn
  // was taken to answer it; a Claude Code lead built on past it. It now cuts that turn, and the same
  // session's next turn opens with it.
  it("DW2. the person's message sent while the lead works cuts that turn, and the next opens with it as they wrote it", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("is the door done?");
      await settleOn(() => chat.steers.length > 0);
      return cutShort;
    });
    assert.deepEqual(
      one.calls.map((c) => c.prompt),
      [LOOP_WORDS.started("a dusk plaza"), "is the door done?"],
      "its own turn, nothing of Genex's around it",
    );
    const said = chat.steers.flatMap((steer) => steer.messages.map(({ id: _id, ...m }: SteerMessage) => m));
    assert.deepEqual(said, [{ text: "is the door done?" }], "verbatim, the person's");
    const heard = chat.log
      .filter((e) => e.data.event_type === "run_steering_delivered" && e.data.payload.how === "lead")
      .map((e) => e.data.payload.sourceMessageId);
    assert.deepEqual(heard, [chat.idOf("is the door done?")], "recorded as heard by the lead");
    assert.deepEqual(chat.requeued(), [], "never given back for a second answer");
  });

  it("DW3. a worker's end wakes a resting lead with that one line, Genex's", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    const at = chat.T0 + MINUTE_MS;
    chat.ticks.push((now) => {
      if (now >= at && one.state.log.length === 0) noteEnd(one, at, SKY_DONE);
    });
    await one.run((turn) => {
      if (turn === 2) one.state.finished = true;
      return worked;
    });
    assert.equal(one.calls.length, 2);
    assert.equal(one.calls[1]!.prompt, SKY_DONE);
    assert.equal(one.calls[1]!.said?.from, MessageFrom.Genex);
    assert.equal(one.calls[1]!.said?.notices, undefined);
  });

  it("DW4. a worker's end while the lead works is said into that turn once, Genex's, and wakes nobody after", async () => {
    const chat = liveChat();
    chat.hooks.native = true;
    const one = chat.loopRun();
    // The run ends ten minutes on: no wake came for the line its turn read.
    chat.ticks.push((now) => {
      if (now >= chat.T0 + 10 * MINUTE_MS) one.state.finished = true;
    });
    await one.run(async () => {
      noteEnd(one, chat.at.now, SKY_DONE);
      await settleOn(() => chat.steers.length > 0);
      return { ...worked, steered: chat.steers.flatMap((steer) => steer.messages.map((m: SteerMessage) => m.id)) };
    });
    assert.equal(one.calls.length, 1, "read in its turn: nothing woke the lead for it after");
    const said = chat.steers.flatMap((steer) => steer.messages.map(({ id: _id, ...m }: SteerMessage) => m));
    assert.deepEqual(said, [{ text: SKY_DONE, from: MessageFrom.Genex }]);
    assert.equal(chat.steers[0]!.interrupt, false, "Genex's line never cuts the turn short");
    assert.equal(one.n.waitSeq, 1, "told");
  });

  it("DW5. a session lost on a wake opens a fresh one with the turn's own message, Genex's lines beside it", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    chat.sayAt(chat.T0 + MINUTE_MS, "hdrp или urp?");
    await one.run((turn) => {
      if (turn === 2) throw new Error("No conversation found with session ID: lead-1");
      one.state.finished = turn === 3;
      return worked;
    });
    assert.equal(one.calls.length, 3, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.equal(one.calls[2]!.prompt, "hdrp или urp?", "the turn's own message, never a replay around it");
    assert.equal(one.calls[2]!.said?.from, MessageFrom.Person);
    const [told = ""] = (one.calls[2]!.said?.notices ?? []) as string[];
    assert.match(told, /^Your earlier session was lost \(the session could not be resumed\)/);
    assert.match(told, /The Loop started/, "and how the Loop began");
    assert.doesNotMatch(told, /YOUR NOTES|THE RUN SO FAR|WHAT HAPPENED/);
  });

  it("DW7. a note the person left about a build, which reaches the run and no chat queue, wakes a resting lead with its words, once", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    const NOTE = "[USER FEEDBACK on Sky · try 2] make it darker";
    let left = false;
    chat.ticks.push((now) => {
      if (left || now < chat.T0 + MINUTE_MS) return;
      left = true;
      chat.append([{ type: "custom", event_type: "run_steering", payload: { runId: chat.RUN, text: NOTE } }]);
    });
    chat.ticks.push((now) => {
      if (now >= chat.T0 + 10 * MINUTE_MS) one.state.finished = true;
    });
    await one.run(() => worked);
    assert.deepEqual(
      one.calls.map((c) => c.prompt),
      [LOOP_WORDS.started("a dusk plaza"), NOTE],
      "woken by the note as written, and by nothing after it",
    );
    assert.equal(one.calls[1]!.said?.from, MessageFrom.Person);
  });

  it("DW8. a line the turn could not take yet is said again with the next one, and no later line is told past it", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    chat.ticks.push((now) => {
      if (now >= chat.T0 + 10 * MINUTE_MS) one.state.finished = true;
    });
    await one.run(async (turn) => {
      if (turn > 1) return worked;
      // No session takes input yet (the call waits for the folder another chat's turn holds): refused.
      noteEnd(one, chat.at.now, SKY_DONE);
      await settleOn(() => chat.steers.length === 1);
      chat.hooks.native = true;
      noteEnd(one, chat.at.now, SEA_DONE);
      await settleOn(() => chat.steers.length === 2);
      return { ...worked, steered: chat.steers[1]!.messages.map((m: SteerMessage) => m.id) };
    });
    assert.deepEqual(
      chat.steers.map((steer) => steer.messages.map((m: SteerMessage) => m.text)),
      [[SKY_DONE], [SKY_DONE, SEA_DONE]],
      "the refused line goes in again, before the one after it",
    );
    assert.equal(one.calls.length, 1, "both read in the turn: nothing wakes the lead for them again");
  });

  it("DW6. a worker's and a job's end are facts: what ended and how, with no instruction after them", () => {
    assert.equal(RUN_POOL_WORDS.ended("w1", "Sky", "done"), SKY_DONE);
    const job = {
      id: "j1",
      title: "Unreal build",
      command: "make",
      role: "worker",
      worker: "w2",
      state: "failed",
      exitCode: 2,
      durationMs: 4 * MINUTE_MS,
      stoppedBy: null,
    };
    assert.equal(
      jobEndLine(job as never),
      'job j1 "Unreal build" (`make`, started by worker w2) failed (exit 2) after 4 min.',
    );
    const stopped = { ...job, state: "stopped", exitCode: null, stoppedBy: "person" };
    assert.equal(
      jobEndLine(stopped as never),
      'job j1 "Unreal build" (`make`, started by worker w2) was stopped by the person after 4 min.',
    );
  });
});

/**
 * Messages without a queue: a message the person sent while the chat's answer ran 3 workers for 28
 * minutes had switched the Loop on, so it never joined the answer and sat in Queued for 21 minutes;
 * a Stop pressed to get it going handed over at once, and the next press stopped it. Now it reaches
 * the answer at its next step, which goes on with its settings, and a wait ends when the person writes.
 */
describe("messages without a queue", () => {
  const ok = (summary: string, sessionId: string) => ({
    ok: true,
    summary,
    sessionId,
    turns: 1,
    usage: {},
    engine: "x",
  });
  const cut = (sessionId: string) => ({
    ok: false,
    summary: "",
    stopReason: "stopped",
    sessionId,
    turns: 2,
    usage: {},
    engine: "x",
  });

  it("NQ1. another model picked while the chat's answer works reaches that answer at its next step, which goes on on it", async () => {
    const log: Array<{ id: string; data: Record<string, any> }> = [];
    let onCut = () => {};
    const host = {
      call: async (method: string, p: Record<string, any>) => {
        if (method === HostMethod.EventsAppend)
          for (const data of p.batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
        if (method === HostMethod.EventsList) return log;
        if (method === HostMethod.EngineSteer) {
          onCut();
          return { how: "interrupt", accepted: p.messages.map((m: { id: string }) => m.id) };
        }
        return null;
      },
      notify: () => {},
    };
    const legs: Array<{ prompt: string; resume: string | null; switched: boolean }> = [];
    let running = () => {};
    const working = new Promise<void>((resolve) => {
      running = resolve;
    });
    const queue = new MessageQueue(host as never, async (action, steer) => {
      if (action.text !== "build the boss fight") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "BRIEF",
        call: async (prompt, resume) => {
          legs.push({ prompt, resume, switched: false });
          const cutNow = new Promise<void>((resolve) => {
            onCut = resolve;
          });
          running();
          await cutNow;
          return cut("s1") as never;
        },
        switches: {
          changes: (item) => Boolean(item.model),
          takes: () => true,
          apply: async () => ({
            call: async (prompt, resume) => {
              legs.push({ prompt, resume, switched: true });
              return ok("On it.", "s1") as never;
            },
            newSession: false,
          }),
        },
      });
    });
    await queue.enqueue({
      type: "user_message",
      threadId: "chat",
      text: "build the boss fight",
      engine: "claude-code",
    });
    await working;
    await queue.enqueue({
      type: "user_message",
      threadId: "chat",
      text: "use sonnet for it",
      engine: "claude-code",
      model: "sonnet",
    });
    assert.ok(await settleOn(() => legs.length === 2));
    const states = () => [...messageQueueState(log as never).messages.values()].map((m) => [m.action?.text, m.state]);
    // Flipped: the leg opened with "You now run on sonnet." The model is its call's option alone.
    assert.deepEqual(legs[1], { prompt: "use sonnet for it", resume: "s1", switched: true });
    assert.ok(
      await settleOn(
        () =>
          [...messageQueueState(log as never).messages.values()].find((m) => m.action?.text === "use sonnet for it")
            ?.state === "delivered",
      ),
      JSON.stringify(states()),
    );
    queue.stop();
  });
});

/**
 * One session, reviewed: holes a lead would have fallen into — a conflict worker committing the
 * markers it left, changes no worker made stopping every merge for good, a first turn crashing the
 * run because the lead's lock was still held — and, once the lead was limited only by the chat's
 * permission mode, what its own commands leave in the game folder at the landing.
 */
describe("one session, reviewed", () => {
  it("OS3. a first turn the host refused because the lead's lock was held is asked again after a wait, and the run goes on", async () => {
    const w = clockNight();
    const busy = () => Object.assign(new Error('a contractor is already building in "sky"'), { code: "folder_busy" });
    const { talk, calls } = w.lead((turn) => {
      if (turn === 1) throw busy();
      w.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await w.run(talk);
    assert.equal(calls.length, 2, "asked once more");
    assert.equal(calls[1]!.prompt, calls[0]!.prompt, "the same first message");
    assert.ok(calls[1]!.at > calls[0]!.at, "after a wait on the loop's own clock");
  });

  // Flipped: a web lead's lock busy for four asks ended its turn as failed (`MAX_BUSY_RETRIES`); every
  // lead now waits for its lock as an open Loop's lead waits for its folder: until it is free, or a Stop.
  it("OS4. a first turn the lead's lock stays busy for waits until the person stops the run — never a failed turn, never a crash", async () => {
    const w = clockNight();
    const { talk, calls } = w.lead(() => {
      if (calls.length === 12) w.loopRun.ctx.cancelled = true;
      throw Object.assign(new Error("busy"), { code: "folder_busy" });
    });
    const outcome = await w.run(talk);
    assert.equal(calls.length, 12, "asked again after each wait until the Stop");
    assert.equal(outcome.failed, null, "no wrap-up for a failed turn");
    assert.equal(outcome.wrapCause, null);
  });
});

describe("a Loop has no time limit", () => {
  /**
   * The composer's ∞ ("until satisfied") reached the log as a plain 24-hour budget, so every
   * surface that read the run back called it a 24 h build. There are no hours to pick, and a Loop
   * has no clock: its start names no hours, whatever hours the call named.
   */
  it("L1. a Loop's start names no hours and no 24-hour cap, whatever hours its call named", async () => {
    const { startAutopilot } = await import("../../src/harness-seed/loop/start-autopilot.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const outcome = await startAutopilot.execute({ goal: "g", direction: "d", hours: 3 }, ctxRecorder().ctx);
    assert.ok(typeof outcome === "object" && outcome.details, "start_autopilot answers with the run");
    const run = outcome.details.run as Record<string, unknown>;
    // Flipped: the start wrote its hours (3) and untilSatisfied only for ∞; it writes neither now.
    assert.equal("hours" in run, false);
    assert.equal("untilSatisfied" in run, false);
  });

  /*
   * no-clock: a Loop ran under a clock of its own — a turn cap that cut and woke its lead, a carry-on
   * wake after a turn that changed something, a heads-up and a time's-up, a wrap-up at its working
   * deadline and a close at the end of its grace — so a lead resting on a long worker was wrapped up
   * for the time, and one done with nothing at work was kept open until the clock ran out.
   */
  it("no-clock. a lead resting on its worker for two days hears no time and is woken only by the worker's end", async () => {
    const w = clockNight();
    w.ticks.push((now) => {
      if (now < w.T0 + 48 * HOUR_MS || w.worker.state !== "running") return;
      w.worker.state = "done";
      w.note("sky ended: the sky is painted", "worker_ended");
    });
    const { talk, calls } = w.lead((turn) => {
      if (turn === 2) w.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    const outcome = await w.run(talk);
    assert.equal(calls.length, 2, calls.map((c) => c.prompt.split("\n")[0]).join(" | "));
    assert.ok(calls[1]!.at >= w.T0 + 48 * HOUR_MS, "woken only once its worker ended");
    // Flipped: "WOKEN AT … — a worker ended" around it; the worker's own line now.
    assert.equal(calls[1]!.prompt, "sky ended: the sky is painted");
    assert.equal(outcome.wrapCause, null, "no wrap-up for time");
    for (const call of calls) assert.doesNotMatch(call.prompt, /working minutes|time's up|minutes left/i);
  });

  it("no-clock. a lead turn that ends with nothing at work pauses the Loop at once: no wake, no wrap-up turn", async () => {
    const w = clockNight();
    w.worker.state = "done";
    const { talk, calls } = w.lead(() => ({ ok: true, sessionId: "lead-1" }));
    const outcome = await w.run(talk);
    assert.equal(calls.length, 1);
    assert.equal(outcome.wrapCause, null);
    assert.ok(w.at.now < w.T0 + MINUTE_MS, "closed as its turn ended, not when a clock ran out");
  });

  /**
   * A lead resting on one job of its run that runs for an hour (the worker is done), on a host that
   * lists the run's jobs as `jobs.list` does; `failRunningRead` names which read of the running jobs
   * (one with no `endedAfter`) the host cannot answer.
   */
  function restingOnAJob(failRunningRead: number | null) {
    const w = clockNight();
    w.worker.state = "done";
    const endsAt = w.T0 + HOUR_MS;
    const job = { id: "job-1", title: "Long build", state: "running", role: "lead" };
    const reads = { all: 0, running: 0 };
    // The job's end is a line of the run's log, as the run writes it.
    Object.assign(w.loopRun, { note: w.note });
    Object.assign(w.loopRun.ctx, {
      call: async (method: string, params: { endedAfter?: number }) => {
        if (method !== HostMethod.JobsList) return null;
        reads.all += 1;
        if (params.endedAfter === undefined && ++reads.running === failRunningRead)
          throw new Error("jobs.list: the host's deadline passed");
        if (w.at.now < endsAt) return { jobs: [job], seq: 0 };
        return { jobs: [{ ...job, state: "exited", exitCode: 0, endSeq: 1 }], seq: 1 };
      },
    });
    const { talk, calls } = w.lead((turn) => {
      if (turn === 2) w.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    return { w, endsAt, reads, calls, run: () => w.run(talk) };
  }

  it("no-clock. a read of the run's jobs the host could not answer closes nothing: the lead is woken by its job's end", async () => {
    const resting = restingOnAJob(1);
    await resting.run();
    assert.equal(resting.calls.length, 2, "the Loop stayed open while its job ran");
    assert.ok(resting.calls[1]!.at >= resting.endsAt, "woken once its job ended");
    // Flipped: "WOKEN AT … — a job of the run ended"; the job's own line now.
    assert.match(resting.calls[1]!.prompt, /^job job-1 "Long build" /);
  });

  it("no-clock. a lead resting on a job reads the run's jobs at most twice every JOB_POLL_MS: its ends and what runs", async () => {
    const resting = restingOnAJob(null);
    await resting.run();
    assert.equal(resting.calls.length, 2);
    const polls = HOUR_MS / JOB_POLL_MS;
    assert.ok(resting.reads.all <= 2 * polls + 4, `${resting.reads.all} reads over an hour's rest`);
  });

  it("no-clock. the person's Finish while the lead's turn works gives exactly one wrap-up turn once it ends", async () => {
    let finishing = false;
    const w = clockNight({ finishing: async () => finishing });
    const { talk, calls } = w.lead((turn) => {
      if (turn === 1) finishing = true;
      return { ok: true, sessionId: "lead-1" };
    });
    const outcome = await w.run(talk);
    assert.equal(calls.length, 2, "its turn, then the one wrap-up turn");
    // Flipped: "The user asked to finish, so the wrap-up starts now." and the `director_continued`
    // reasons it was recorded under; Genex's one line, at once, not by a clock.
    assert.equal(calls[1]!.prompt, LOOP_WORDS.finishAsked);
    assert.ok(calls[1]!.at - calls[0]!.at < MINUTE_MS, "at once, not by a clock");
    assert.equal(outcome.wrapCause, "finish");
  });
});

it("CAT-1. provider default must not inject a pinned planner", async () => {
  const { resolveRoles } = await import("../../src/harness-seed/loop/model-roles.ts");
  assert.deepEqual(resolveRoles("claude-code", undefined), {
    planner: undefined,
    builder: undefined,
    judge: undefined,
  });
});

describe("a run started again after a close of its own", () => {
  const threadId = "thread_again";
  const runId = "run_again";
  const run = {
    runId,
    project: "plaza",
    goal: "a dusk plaza",
    engine: "codex",
    mode: "autopilot",
    reference: { name: "plaza", shots: [] },
    budgets: { wallClockMs: HOUR_MS },
  };
  /** One record of the thread's log, as the host keeps it. */
  type Logged = { type: string; event_type?: string; message?: string; payload?: Record<string, unknown> };
  /** The log as the earlier session left it: the run registered, then closed. */
  const closedLog = (): Array<{ id: string; data: Logged }> => [
    { id: "e1", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: false } } },
    {
      id: "e2",
      data: {
        type: "custom",
        event_type: "run_finished",
        payload: { runId, project: "plaza", victory: false, executionStatus: "completed" },
      },
    },
  ];

  /**
   * Start the run again, as a resume, on a host that keeps `log` and lists it from a cursor as the
   * host does. The engine is session-capable, so the run is a director's; no game has its name,
   * so the run cannot ready its folder and throws. Answers the run's ctx and what the app was told.
   */
  async function startAgain(
    log: Array<{ id: string; data: Logged }>,
    extra: Record<string, unknown> = {},
    hostAnswers: Record<string, (params?: { artifactId?: string }) => unknown> = {},
  ) {
    const { handleRunStart } = await import("../../src/harness-seed/loop/run-dispatch.ts");
    /** What the run's host calls carry here: a batch to append, or a cursor to list from. */
    type Params = { batch?: Logged[]; after?: string };
    const answers: Record<string, (params?: Params) => unknown> = {
      [HostMethod.EventsList]: (params) =>
        params?.after ? log.slice(log.findIndex((entry) => entry.id === params.after) + 1) : [...log],
      [HostMethod.EngineDescribe]: () => [{ id: "codex", kind: "delegated" }],
      [HostMethod.GameList]: () => [],
      ...hostAnswers,
    };
    const failed: unknown[] = [];
    const host = {
      workspace: "/nonexistent",
      notify: (method: string, payload: unknown) => {
        if (method === "run.failed") failed.push(payload);
      },
      call: async (method: string, params?: Params): Promise<unknown> => {
        if (method === HostMethod.EventsAppend)
          for (const data of params?.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return answers[method]?.(params) ?? null;
      },
    };
    const ctx: { runInbox?: RunInbox } & Record<string, unknown> = {
      ...host,
      host,
      threadId,
      cancelled: false,
      setStatus: () => {},
    };
    const studio = {
      host,
      cancels: new Set<string>(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ctx,
    };
    await handleRunStart(studio as never, { type: "run_start", threadId, run: run as never, resume: true, ...extra });
    return { ctx, failed };
  }

  /**
   * A run registered again after an earlier session of it closed — a Resume of a paused run, or
   * a finished build its chat's own session reopens — that threw before it wrote its own close:
   * `closeFailedRun` took the earlier session's `run_finished` for this session's and wrote none,
   * so the log kept the new `run_registered` unmatched and the run read as running for good.
   */
  // Flipped: refused with words at the run's start and kept paused (Resume tries again), never failed for good.
  it("a resumed run whose journal cannot be read stays paused, instead of starting over with a full budget", async () => {
    const log = closedLog();
    await startAgain(
      log,
      {},
      {
        [HostMethod.ArtifactRead]: (params) => {
          if (params?.artifactId === `autopilot_${runId}`) throw new Error("journal read failed: EIO");
          return null;
        },
      },
    );
    const closes = log
      .map((entry) => entry.data)
      .filter((data) => data.event_type === "run_finished" && data.payload?.runId === runId);
    const own = closes.at(-1)?.payload;
    assert.equal(own?.stoppedBecause, OPEN_LOOP_REFUSAL.journalUnreadable, JSON.stringify(closes));
    assert.equal(own?.executionStatus, "paused", "the run stays paused for a Resume");
  });

  it("a resumed or reopened run that throws before its own close still closes: an earlier session's close is not this one's", async () => {
    const log = closedLog();
    const { failed } = await startAgain(log);

    const records = log.map((entry) => entry.data);
    const registered = records.findLastIndex(
      (data) => data.event_type === "run_registered" && data.payload?.runId === runId,
    );
    assert.ok(registered > 1, "the run was registered again after its earlier close");
    const errorAt = records.findIndex((data, i) => i > registered && data.type === "error");
    assert.ok(errorAt > registered, `the run threw: ${JSON.stringify(records.slice(registered))}`);
    const ownClose = records
      .slice(registered + 1)
      .filter((data) => data.event_type === "run_finished" && data.payload?.runId === runId);
    assert.equal(ownClose.length, 1, `this session closes the run: ${JSON.stringify(records.slice(registered))}`);
    assert.equal(ownClose[0]?.payload?.executionStatus, "failed");
    assert.equal(ownClose[0]?.payload?.victory, false);
    assert.equal(failed.length, 1, "the app is told the run failed");
  });

  /**
   * The loop died under a run started again after a close of its own — a Resume of a paused run,
   * or a finished build reopened — while the app lived on: the host restarted the loop and named the
   * run among the runs in flight (`BootNotice.openRuns`), but the reborn loop (boot-notice.ts
   * `runsIn`) took the earlier session's `run_finished` for this one's and closed nothing, so the chat
   * read the run as running until the next launch of the app.
   */
  it("RO3. a run started again after a close of its own, left open by a loop crash, is closed by the reborn loop: an earlier session's close is not this one's", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const log = [
      ...closedLog(),
      { id: "e3", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: true } } },
    ];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { threadId?: string; batch?: Logged[] }): Promise<unknown> => {
        if (method === HostMethod.ThreadList) return [{ id: threadId }];
        if (method === HostMethod.EventsInbox) return [];
        if (method === HostMethod.EventsList) return params?.threadId === threadId ? [...log] : [];
        if (method === HostMethod.EventsAppend && params?.threadId === threadId)
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return null;
      },
    };
    const studio = { host, orphanRuns: new Map<string, string>() };
    const messages = { restore: async () => {} };
    await handleBootNotice(studio as never, messages as never, { reason: "crash_restart", openRuns: [runId] } as never);

    const closes = log.slice(3).filter((entry) => entry.data.event_type === "run_finished");
    assert.equal(closes.length, 1, `the run is closed once: ${JSON.stringify(log.slice(3))}`);
    assert.equal(closes[0]?.data.payload?.runId, runId);
  });

  /**
   * The host names a run in flight at every later crash of the same app session, so a reborn loop can
   * be told of a run it has already started again itself — a Resume or a reopen taken the moment it
   * woke. Read as open again (RO3), it would be closed and paused under the run running it.
   */
  it("RO3b. a run the reborn loop is itself running again is never closed as one the crash left open", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const log = [
      ...closedLog(),
      { id: "e3", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: true } } },
    ];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { threadId?: string; batch?: Logged[] }): Promise<unknown> => {
        if (method === HostMethod.ThreadList) return [{ id: threadId }];
        if (method === HostMethod.EventsInbox) return [];
        if (method === HostMethod.EventsList) return params?.threadId === threadId ? [...log] : [];
        if (method === HostMethod.EventsAppend && params?.threadId === threadId)
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return null;
      },
    };
    const studio = {
      host,
      orphanRuns: new Map<string, string>(),
      activeRuns: new Map([[runId, { threadId, run }]]),
      startingRuns: new Map(),
    };
    await handleBootNotice(
      studio as never,
      { restore: async () => {} } as never,
      {
        reason: "crash_restart",
        openRuns: [runId],
      } as never,
    );
    assert.deepEqual(
      log.slice(3).filter((entry) => entry.data.event_type === "run_finished"),
      [],
      "the run this loop runs is not closed under it",
    );
  });
});

/**
 * A message after a finished build whose lead was a session of its own (the chat's session on
 * another model), or a build no lead was seated for: the chat's own session answers either.
 */
describe("a message after a finished build whose lead was a session of its own", () => {
  it("RO5c. a question is answered: nothing continues and nothing reopens", async () => {
    const chat = ownSessionChat();
    await handleUserMessage(chat.studio as never, { ...ownMessage, text: "why dusk?" } as never);
    assert.equal(chat.asked.sessions.length, 1, "one session answers");
    assert.equal((await chat.registered()).length, 1);
  });

  it("RO5d. after a finished build no lead was seated for, a message gets a plain turn with no run's controls", async () => {
    const chat = ownSessionChat();
    chat.store.journal = { phase: "done", run: ownRun, director: { plan: {} } };
    await handleUserMessage(chat.studio as never, { ...ownMessage } as never);
    assert.equal(chat.asked.sessions.length, 1, "one plain turn answers");
    assert.equal(chat.asked.sessions[0]?.runControls, undefined, "a run that seated no lead hands no controls");
    assert.equal((await chat.registered()).length, 1, "nothing reopened");
  });

  /**
   * The chat reports how a command the person ran from a reply went, in words it writes itself
   * (`origin`). Sent while the chat's history was still loading, the renderer saw no build and gave it
   * the chat's Loop; queued before an upgrade, it replays with it. The harness kept that Loop for a
   * finished build, so a failing command's output — read as a request for a fix — reopened the build
   * for hours though nobody asked. No message carries a Loop now, nothing reopens a build, and what
   * the chat writes itself is handed no Loop's start.
   */
  it("RO6. a command's result, words the chat wrote itself, is handed no Loop's start: an ordinary turn answers it", async () => {
    const report = {
      ...ownMessage,
      model: undefined,
      text: "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.",
      origin: "command-result",
      // As the host queues every message the chat wrote itself: Genex's (conversation.ts).
      from: MessageFrom.Genex,
      autopilot: { hours: 2 },
    };
    for (const chatSession of [true, false]) {
      const chat = ownSessionChat({
        chatSession,
        recorded: [{ name: "reopen_run", args: { text: "fix the failing test" } }],
      });
      await handleUserMessage(chat.studio as never, { ...report } as never);
      assert.equal(
        chat.asked.sessions[0]?.interviewTools,
        undefined,
        "the chat's own session is offered no Loop's start",
      );
      assert.equal((await chat.registered()).length, 1, "nothing reopened");
    }
  });

  /*
   * A plugin's words shown in the chat (desktop-assist) are queued as Genex's (`from`) with no
   * `origin`: the turn that answers them is a Genex-written one, like a command's result.
   */
  it("RO6b. words a plugin posted in the chat, Genex's with no origin, are handed no Loop's start", async () => {
    const chat = ownSessionChat({ chatSession: true });
    const posted = { ...ownMessage, text: "Computer control is on: try the game again.", from: MessageFrom.Genex };
    await handleUserMessage(chat.studio as never, posted as never);
    assert.equal(chat.asked.sessions[0]?.interviewTools, undefined, "no Loop's start for Genex's words");
    assert.equal(chat.asked.sessions[0]?.from, MessageFrom.Genex, "the turn reads them as Genex's");
  });

  /**
   * A game linked to Unreal whose finished run was an Unreal Loop, which seats no lead and keeps no
   * journal: a new ask starts another Loop when the chat's own session starts one, never "Loop can't
   * continue this build here" and one plain turn. The host lists the game here linked to the project
   * inside its folder.
   */
  const unrealGame = {
    name: "plaza",
    title: "Plaza",
    dir: "/games/plaza",
    engine: { kind: GameEngine.Unreal, project: "/games/plaza/unreal/Plaza.uproject" },
  };
  const dirtBike = { goal: "A dirt-bike track game.", direction: "Dirt track" };

  it("a message after the game's finished Unreal Loop whose turn starts a Loop starts a new one, until its lead finishes it", async () => {
    const chat = ownSessionChat({ game: unrealGame, recorded: [{ name: "start_autopilot", args: dirtBike }] });
    chat.store.journal = null;
    await handleUserMessage(chat.studio as never, { ...ownMessage, text: "Make it a dirt-bike track game." } as never);
    assert.equal(chat.asked.sessions.length, 1);
    assert.deepEqual(recordable(chat.asked.sessions[0]), ["start_autopilot"], "the session holds the Loop's start");
    const runs = await chat.registered();
    assert.equal(runs.length, 2, JSON.stringify(chat.log.map((entry) => entry.data.event_type ?? entry.data.type)));
    assert.notEqual(runs[1]?.runId, OWN_RUN, "a new run, never the finished one reopened");
    assert.equal(runs[1]?.resumed, false);
    assert.equal(runs[1]?.goal, dirtBike.goal, "the ask is its goal");
    // Flipped (no clock): the new Loop was recorded `untilSatisfied` under a day's ceiling; it has no clock.
    assert.equal(runs[1]?.budgets?.untilSatisfied, undefined, "until its lead finishes it: no clock");
    assert.equal(runs[1]?.budgets?.wallClockMs, undefined);
    // The Loop's lead rests (no idle stop ends it): the person's Stop closes it, and the close names its profile.
    (chat.studio as unknown as Studio).cancels.add(OWN_THREAD);
    stopRunsOf(chat.studio as never, OWN_THREAD);
    for (let i = 0; i < 100 && !chat.notified.some((note) => note.event === "run.finished"); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const finished = chat.notified.find((note) => note.event === "run.finished")?.payload;
    assert.equal(finished?.profile, "open", "conducted by the one Loop, in place");
  });

  it("a message after the game's finished Unreal Loop whose turn starts none is one plain turn: no run", async () => {
    const chat = ownSessionChat({ game: unrealGame });
    chat.store.journal = null;
    await handleUserMessage(chat.studio as never, { ...ownMessage } as never);
    assert.equal(chat.asked.sessions.length, 1, "one plain turn");
    assert.deepEqual(recordable(chat.asked.sessions[0]), ["start_autopilot"]);
    assert.equal((await chat.registered()).length, 1, "no run started");
  });
});

describe("a reply cut off by its output limit", () => {
  it("runs none of its tool calls and asks again for a smaller, complete reply", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: CompleteRequest[] = [];
    rig.core.engines.register({
      id: "fake-direct",
      label: "Fake direct",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async (request: CompleteRequest) => {
        requests.push(request);
        const cut = requests.length === 1;
        return {
          message: {
            role: "assistant",
            content: cut ? "Writing the whole file" : "Done in smaller steps.",
            ...(cut ? { tool_calls: [{ id: "cut-1", name: "list_games", arguments: {} }] } : {}),
          },
          usage: {},
          stopReason: cut ? "length" : "stop",
          model: "fake",
          engine: "fake-direct",
        };
      },
    });
    await rig.core.sendUserMessage("rewrite the game", { engine: "fake-direct" });
    const log = await waitForLog(rig.core, (l) => l.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const toolEvents = log.filter((e) => e.data.type === "tool_requested" || e.data.type === "tool_result");
    assert.deepEqual(toolEvents, [], "a call from a truncated reply is not an executable request");
    assert.equal(requests.length, 2, "the turn asked again instead of ending on the cut-off reply");
    const retry = JSON.stringify(requests[1]!.messages);
    assert.doesNotMatch(retry, /cut-1/, "the partial call is not replayed as if it had been made");
    assert.match(retry, /output limit/, "the model hears why its reply was dropped");
    const userSaid = log.flatMap((e) =>
      e.data.type === "messages" ? e.data.messages.filter((m) => m.role === "user").map((m) => m.content) : [],
    );
    assert.deepEqual(userSaid, ["rewrite the game"], "the note is Studio's, never put in the user's mouth");
  });
});

describe("a turn that has taken many pictures", () => {
  it("reserves room for the pictures it sends, not for every picture it has taken", async () => {
    // Only the latest few pictures ride the prompt; reserving for all of them made a turn with
    // many screenshots compact — then refuse — a conversation that fit.
    const still = { label: "shot", mimeType: "image/png", data: "iVBORw0KGgo=" };
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: {
        "engine.describe": () => [
          {
            id: "ollama",
            label: "Ollama",
            kind: "direct",
            status: { code: "ready" },
            models: [{ id: "m", label: "m", contextWindow: 160_000 }],
            defaultModel: "m",
          },
        ],
        "context.policy": () => ({ policy: { mode: "default" } }),
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
        "turn.append": () => ({}),
        "engine.complete": () => ({ message: { role: "assistant", content: "Looks right." }, usage: {} }),
      },
    });
    const outcome = await runTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn1",
      engine: "ollama",
      stills: Array.from({ length: 60 }, (_, i) => ({ ...still, label: `shot ${i}` })),
    });

    assert.equal((outcome as { stopped: string }).stopped, "done");
    const completions = recorder.paramsOf("engine.complete");
    assert.equal(completions.length, 1, "the turn answered without compacting a conversation that fit");
  });
});

describe("a turn's round limit", () => {
  it("asks the model at most maxRounds times", async () => {
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: {
        "engine.describe": () => [
          { id: "ollama", label: "Ollama", kind: "direct", status: { code: "ready" }, models: [], defaultModel: "m" },
        ],
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
        "turn.append": () => ({}),
        "engine.complete": () => ({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: `c${Math.random()}`, name: "list_games", arguments: {} }],
          },
          usage: {},
        }),
      },
    });
    const outcome = await runTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn1",
      engine: "ollama",
      maxRounds: 2,
    });

    assert.equal((outcome as { stopped: string }).stopped, "max_rounds");
    assert.equal(recorder.paramsOf("engine.complete").length, 2, "two rounds, not three");
  });
});

describe("a failed tool call on the local engine", () => {
  it("reaches the model marked as an error, not as a plain answer", async () => {
    const events = [
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "read it" }] } },
      {
        id: "01b",
        data: {
          type: "messages",
          messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: {} }] }],
        },
      },
      { id: "01c", data: { type: "tool_result", tool_call_id: "c1", result: { ok: false, content: "no such file" } } },
      {
        id: "01d",
        data: {
          type: "messages",
          messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c2", name: "list_games", arguments: {} }] }],
        },
      },
      { id: "01e", data: { type: "tool_result", tool_call_id: "c2", result: { ok: true, content: "none" } } },
    ];
    const ctx = { workspace: "/nowhere", call: async (method: string) => (method === "events.list" ? events : null) };
    const prompt = await materializePrompt(ctx as never, { threadId: "t1" } as never);
    const { piMessages } = toPiMessages(prompt.messages);
    const results = (piMessages as Array<{ role: string; toolCallId?: string; isError?: boolean }>).filter(
      (m) => m.role === "toolResult",
    );
    assert.deepEqual(
      results.map((m) => [m.toolCallId, m.isError]),
      [
        ["c1", true],
        ["c2", false],
      ],
    );
  });
});

describe("two starts of a run on one chat at once", () => {
  it("reserves the chat for the first; the second is refused, not started beside it", async () => {
    const { handleRunStart } = await import("../../src/harness-seed/loop/run-dispatch.ts");
    const appended: Array<Record<string, any>> = [];
    let gameLists = 0;
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { batch?: Array<Record<string, any>> }): Promise<unknown> => {
        if (method === HostMethod.EventsAppend) appended.push(...(params?.batch ?? []));
        if (method !== HostMethod.GameList) return null;
        gameLists++;
        // A folder no run can build on: each start that gets this far ends here, cleanly.
        return [{ name: "plaza", shape: { kind: "engine-export" } }];
      },
    };
    const studio = {
      host,
      cancels: new Set<string>(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ({ ...host, host, cancelled: false, setStatus: () => {} }),
    };
    const start = (runId: string) =>
      handleRunStart(studio as never, {
        type: "run_start",
        threadId: "chat-1",
        run: { runId, project: "plaza", goal: "a plaza" } as never,
      });

    await Promise.all([start("run-a"), start("run-b")]);

    assert.equal(gameLists, 1, "only one run got past the reservation");
    const blocked = appended.filter((data) => data.event_type === "run_start_blocked").map((data) => data.payload);
    assert.ok(
      blocked.some((payload) => payload.requestedRunId === "run-b" && payload.runId === "run-a"),
      `the second start is refused because the first holds the chat: ${JSON.stringify(blocked)}`,
    );
  });
});

describe("the chat's own contractor session", () => {
  it("resumes the chat's bookmarked session, not a later session another role opened in the thread", async () => {
    const { lastContractorSession } = await import("../../src/harness-seed/loop/chat-session.ts");
    const custom = (event_type: string, payload: Record<string, unknown>) => ({
      data: { type: "custom", event_type, payload },
    });
    const events = [
      custom("contractor_session", { sessionId: "chat-ses", engine: "claude-code", project: "plaza" }),
      // A worker or reviewer that ran in this thread afterwards: its mirrored init
      // and an incomplete delegation of its own name sessions that are not the chat's.
      custom("delegated.claude-code", {
        kind: "system",
        data: { subtype: "init", session_id: "reviewer-ses" },
        project: "plaza",
      }),
      custom("delegation_incomplete", { sessionId: "worker-ses", engine: "claude-code", project: "plaza" }),
    ];
    assert.equal(lastContractorSession(events, "claude-code")?.sessionId, "chat-ses");
  });

  it("still finds a session in a chat that predates the bookmark", async () => {
    const { lastContractorSession } = await import("../../src/harness-seed/loop/chat-session.ts");
    const events = [
      {
        data: {
          type: "custom",
          event_type: "delegated.claude-code",
          payload: { kind: "system", data: { subtype: "init", session_id: "old-ses" } },
        },
      },
    ];
    assert.equal(lastContractorSession(events, "claude-code")?.sessionId, "old-ses");
  });
});

describe("a tool call the turn stopped before running", () => {
  it("is answered in the prompt as not run, right after the calls that did run", async () => {
    const { eventsToMessages } = await import("../../src/harness-seed/loop/prompt.ts");
    const calls = [
      { id: "c1", name: "read_file", arguments: {} },
      { id: "c2", name: "write_file", arguments: {} },
    ];
    const messages = eventsToMessages([
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "fix it" }] } },
      { id: "01b", data: { type: "messages", messages: [{ role: "assistant", content: "", tool_calls: calls }] } },
      { id: "01c", data: { type: "tool_requested", tool_call_id: "c1", request: { name: "read_file" } } },
      { id: "01d", data: { type: "tool_result", tool_call_id: "c1", result: { ok: true, content: "text" } } },
      // Stop pressed here: c2 never ran. The next message starts a new turn.
      { id: "01e", data: { type: "messages", messages: [{ role: "user", content: "go on" }] } },
    ] as never);
    assert.deepEqual(
      messages.map((m) => [m.role, m.tool_call_id ?? null, m.is_error ?? false]),
      [
        ["user", null, false],
        ["assistant", null, false],
        ["tool", "c1", false],
        ["tool", "c2", true],
        ["user", null, false],
      ],
    );
    assert.match(messages[3]!.content, /not run/i);
  });
});

describe("Stop on a one-facet Autopilot run", () => {
  it("pauses the run where it was: no finalization is journaled for Resume to skip ahead to", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("onefacetstop");
    const plan = { ...twoFacetPlan(), facets: [twoFacetPlan().facets[0]] };
    let stopped = false;
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        if (!stopped) {
          stopped = true;
          // The user presses Stop while the first build works.
          await rig.core.stopThread(await rig.core.threadForGame(project.name));
          return { ok: false, stopReason: "stopped", errorText: "stopped by you", sessionId: "ses_one" };
        }
        return { sessionId: "ses_one" };
      },
    });
    const { runId } = await runAutopilot(rig, project.name);
    const threadId = await rig.core.threadForGame(project.name);
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as Record<
      string,
      unknown
    > | null;
    assert.ok(journal, "the run kept its journal");
    assert.equal(journal!.phase, "paused", "a Stop pauses the run");
    assert.equal(journal!.finalization ?? null, null, "Resume goes on with the building, not the finalization");
  });
});

describe("a run's close the log refuses once", () => {
  // Flipped (one Loop): this drove the web Loop's own close (integrate.ts `appendClose`); every Loop
  // closes in place now, and its close (open/close.ts) is checked through a Loop's run.
  it("is written on a second try instead of being dropped", async () => {
    const { loopHost, gameRepo } = await import("../helpers/loop-host.ts");
    const { copyProject, Project } = await import("../helpers/project-fixtures.ts");
    const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("close-retry-")));
    const host = loopHost({
      dir,
      facts: [{ id: "godot-project", path: "." }],
      run: { runId: "run-close-retry" },
      turns: [
        async ({ tool }) => {
          await tool("finish", { summary: "The level is built." });
          return undefined;
        },
      ],
    });
    let refusals = 1;
    const closes: unknown[] = [];
    host.rec.handle("events.append", (params) => {
      const batch = (params.batch as Array<{ event_type?: string }> | undefined) ?? [];
      const closing = batch.some((data) => data.event_type === "run_finished");
      if (closing && refusals-- > 0) throw new Error("EBUSY: the log is being rotated");
      if (closing) closes.push(...batch.filter((data) => data.event_type === "run_finished"));
      return { ids: batch.map((_, i) => `e${i}`) };
    });
    await host.start();
    assert.equal(closes.length, 1, "the run is closed, not left running");
  });
});

describe("the inbox replayed at boot", () => {
  it("restores every conversation's queue even when one of them cannot be", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const errors: Array<{ threadId?: string; message: string }> = [];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (
        method: string,
        params?: { threadId?: string; batch?: Array<{ type: string; message?: string }> },
      ) => {
        for (const data of params?.batch ?? [])
          if (data.type === "error") errors.push({ threadId: params?.threadId, message: String(data.message) });
        if (method === HostMethod.EventsInbox)
          return [
            { threadId: "broken", events: [] },
            { threadId: "fine", events: [] },
          ];
        return method === HostMethod.ThreadList ? [] : null;
      },
    };
    const restored: string[] = [];
    const messages = {
      restore: async (threadId: string) => {
        if (threadId === "broken") throw new Error("EIO while requeueing");
        restored.push(threadId);
      },
    };
    await handleBootNotice(
      { host, orphanRuns: new Map() } as never,
      messages as never,
      {
        reason: "start",
        openRuns: [],
      } as never,
    );
    assert.deepEqual(restored, ["fine"], "the other conversation still gets its answers");
    assert.deepEqual(
      errors.map((e) => e.threadId),
      ["broken"],
      "the conversation that lost its line is told so, where it is read",
    );
  });
});

describe("how a chat message's turn ended", () => {
  it("a message whose answer failed is recorded as handled without an answer", async () => {
    const { MessageQueue } = await import("../../src/harness-seed/loop/message-queue.ts");
    const events: Array<{ id: string; thread_id: string; data: Record<string, any> }> = [];
    const host = {
      call: async (method: string, p: { threadId: string; batch?: Array<Record<string, any>> }) => {
        if (method === HostMethod.EventsAppend)
          for (const data of p.batch ?? [])
            events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
        if (method === HostMethod.EventsList) return events;
        return null;
      },
      notify: () => {},
    };
    const queue = new MessageQueue(host as never, async () => {
      throw new Error("the engine's process exited");
    });
    await queue.enqueue({ type: "user_message", threadId: "chat", text: "make the pond deeper" } as never);
    assert.ok(
      await settleOn(() => events.some((e) => e.data.event_type === "coordinator_message_handled")),
      "the message was settled",
    );
    const handled = events.find((e) => e.data.event_type === "coordinator_message_handled")!;
    assert.equal(handled.data.payload.failed, true, "nobody reading the log takes it for an answered message");
  });

  it("a chat turn that stopped short says how in its turn_ended", async () => {
    const rig = await startRig();
    rigs.push(rig);
    rig.core.engines.register({
      id: "fake-direct",
      label: "Fake direct",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async () => {
        throw new EngineError("rate_limit", "fake-direct", "slow down");
      },
    });
    await rig.core.sendUserMessage("make a pond", { engine: "fake-direct" });
    const log = await waitForLog(rig.core, (l) => l.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");
    const ended = log.find((e) => e.data.type === "turn_ended")!.data as { metadata?: { outcome?: string } };
    assert.equal(ended.metadata?.outcome, "engine_limited", "the turn's own record says it was cut short");
  });
});

describe("a tool called with arguments its schema refuses", () => {
  it("answers the model what is wrong and runs nothing", async () => {
    const { createToolRegistry } = await import("../../src/harness-seed/tools/index.ts");
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: { "plugins.tools": () => ({ tools: [] }), "mcp.tools": () => ({ tools: [] }) },
    });
    const tools = await createToolRegistry(recorder.ctx as never, { threadId: "t1" } as never);
    const clicked = await tools.execute(
      { name: "click", arguments: { x: "the left door", y: 0.5 } },
      recorder.ctx as never,
    );
    assert.equal(clicked.ok, false);
    assert.match(clicked.content, /x/);
    const read = await tools.execute({ name: "read_file", arguments: { project: "sky" } }, recorder.ctx as never);
    assert.equal(read.ok, false);
    assert.match(read.content, /file/);
    assert.deepEqual(
      recorder.sequence((m) => m === "preview.input" || m === "artifact.write"),
      [],
      "nothing ran on arguments the schema refuses",
    );
    const ok = await tools.execute({ name: "click", arguments: { x: "0.25", y: 0.5 } }, recorder.ctx as never);
    assert.notEqual(ok.content.includes("refused"), true, "a number sent as its digits still reads as a number");
  });
});

describe("the chat's main agent asked to read the owner's Downloads", () => {
  // Flipped: every brief said "Stay inside this workspace. Do not list or read
  // sibling folders", and the chat's own session, in Auto, refused to read the owner's Downloads
  // without trying. Where the game's work goes is the context's to say; what it may reach is its
  // permissions', and the person's question reaches it as they wrote it.
  it("names the game's folder without forbidding the rest of the Mac", async () => {
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const context = chatContext({ folderLabel: "AI Games/blame", appLanguage: null });
    assert.match(context, /`AI Games\/blame`/, "names the game's folder");
    assert.doesNotMatch(
      context,
      /stay inside|do not (list|search|read|explore)[^.]*(folder|project)|stays in this workspace/i,
    );
  });
});

describe("the chat's agent briefed like plain Claude Code (lean chat)", () => {
  // A one-line "make a tower defense game" reached the model as 25k characters: judge-era template
  // rules (window.__studio, no Math.random, NOTES.md upkeep, .studio/ helpers, video frames, sandbox
  // shell syntax for a session with no sandbox), and every follow-up, a question too, ended with
  // "Pick up exactly where you left off and finish the remaining work" — so a person asking what the
  // build was doing watched it keep building. Flipped: the words now go alone (chat brief, CB-1).
  it("gives a web game's context none of the judge-era template rules, nor any order to keep building", async () => {
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const context = chatContext({ folderLabel: "AI Games/cat", appLanguage: null });
    for (const rule of [
      /__studio/,
      /Math\.random/,
      /NOTES\.md/,
      /\.studio\//,
      /TMPDIR/,
      /statically analyze/,
      /left off|remaining work/i,
    ])
      assert.doesNotMatch(context, rule, `${rule}: ${context}`);
  });
});

describe("an engine's plugin turned on from the chat's card (mp-unity)", () => {
  // A chat asked for a Unity game while the Unity plugin was off; its card turned the plugin on and
  // the same session resumed with "Go on with what I asked". The resumed brief carried no kind rules,
  // so the lead never heard "When the request names Unity, call unity__new-game" and launched a Loop.
  // Flipped: no words restate a kind tool; a folder with no kind yet is handed each engine's
  // way-in tools (tool scoping), and the question card stays bridged while kinds are on offer.
  it("a resumed session of a folder with no kind yet keeps the question card and reads the person's words alone", async () => {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const unity = { plugin: "unity", name: "Unity", tool: "unity__new-game", makes: ["unity-project"] };
    const ask = "I turned on the Unity plugin from your card. Go on with what I asked.";
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: ask }],
        "game.contentStamp": () => ({ all: null, source: null }),
        "game.list": () => [
          { name: "dodger", title: "Dodger", dir: "/games/dodger", shape: null, built: false, facts: [] },
        ],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [unity] }),
        "engine.describe": () => [],
        "engine.delegate": () => ({
          ok: true,
          engine: "claude-code",
          turns: 1,
          usage: {},
          sessionId: "s",
          summary: "ok",
        }),
      },
    });
    const turn = { threadId: "t", turnId: "turn-2", text: ask, engine: "claude-code", engineLabel: "Claude Code" };
    await runDelegatedTurn(recorder.ctx as never, { ...turn, project: "dodger", resume: "session-1" } as never);
    const [delegated] = recorder.paramsOf("engine.delegate");
    assert.equal(delegated?.prompt, ask);
    const bridged = (delegated?.interviewTools as Array<{ name: string }> | undefined)?.map((tool) => tool.name) ?? [];
    assert.ok(bridged.includes("ask_user"), "the card is still there to call");
  });
});

describe("what the lead is told about its workers", () => {
  // Flipped: the web lead's brief said it ("WORKERS (optional, up to 8 at once)"); the brief is gone, and
  // the count is the tool's own description, as an open Loop's lead reads it.
  it("GGR-11. the brief said '8 of 8 worker windows free' of a pool whose workers could use six: worker_start says how many workers may run at once", async () => {
    const { openTools } = await import("../../src/harness-seed/loop/director/open/tool-specs.ts");
    const start = openTools([], { workers: 6 }).find((tool) => tool.name === "worker_start");
    assert.match(String(start?.description), /Up to 6 at once/);
    assert.doesNotMatch(String(start?.description), /worker windows free/);
  });
});

/**
 * A game linked to an Unreal project is built in the user's Unreal Editor, so its chat builds are
 * never checked as a web page: no preview load of its notes folder, no "fix the black screen" over a
 * black canvas, and no failed `build_observation` for SkillOpt to learn from. A game linked to an
 * Unreal project takes no web health pass.
 */
describe("an Unreal game is never checked as a web page", () => {
  const GAME = "tower-game";

  /** A rig whose game is linked to a real `.uproject`, whose preview would show a black canvas, and whose contractor edits game sources. */
  async function unrealGameRig(
    reply: Record<string, unknown> = {},
  ): Promise<{ rig: Rig; prompts: string[]; requests: DelegateRequest[] }> {
    const { writeEngineBinding } = await import("../../src/substrate/game-engine-binding.ts");
    const { ENGINES, UNREAL_ENGINE } = await import("../helpers/engines.ts");
    const { tmpDir } = await import("../helpers/tmp.ts");
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await rig.core.games.scaffold(GAME, { title: "Tower Game" });
    const uproject = path.join(await tmpDir("unreal-project-"), "Tower.uproject");
    await writeFile(uproject, "{}\n");
    await writeEngineBinding(game.dir, uproject, UNREAL_ENGINE.id, ENGINES);
    rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0.4, litFraction: 0 };
    const prompts: string[] = [];
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        // What the session reads: its notices (an engine with no system channel reads its context
        // there on a new session), then the words.
        prompts.push([...(request.notices ?? []), request.prompt].join("\n\n"));
        requests.push(request);
        await writeFile(path.join(request.cwd, "src/lighthouse.js"), "export const lighthouse = 1;\n");
        return {
          ok: true,
          engine: "vendor",
          sessionId: "session-1",
          turns: 2,
          usage: {},
          summary: "Added it.",
          ...reply,
        };
      },
    });
    return { rig, prompts, requests };
  }

  /** The turn's log once it ended, and every chat message's text. */
  async function afterTurn(rig: Rig) {
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");
    const messages = (await rig.core.store.listMessages(rig.core.mainThread)).map((m) => m.content ?? "");
    return { events, said: messages.join("\n") };
  }

  it("an Unreal game's chat build gets no web page's brief and no web health pass: no black-screen line, no failed build_observation", async () => {
    const { rig, prompts } = await unrealGameRig();
    await rig.core.sendUserMessage("Add a lighthouse", { engine: "vendor", project: GAME });
    const { events, said } = await afterTurn(rig);
    assert.equal(prompts.length, 1);
    // The Unreal plugin is off in this rig. Flipped: the brief also said it had no Unreal tools; its
    // tool list says so, and Genex infers no plugin from the facts. Flipped again: it was told it is
    // an Unreal game; a resumed session keeps the system text it started with, so the context never
    // says what the folder holds.
    assert.doesNotMatch(prompts[0]!, /it holds/, "the context names no kind");
    assert.doesNotMatch(prompts[0]!, /window\.__studio/, "and not as a web page");
    assert.equal(customEvents(events, "build_observation").length, 0, "no web observation of an Unreal game");
    assert.doesNotMatch(said, /black screen|loads clean|console error/, "no web verdict in the chat");
    assert.match(said, /Added it\./, "the contractor's report still reaches the chat");
  });

  it("an Unreal game's builder is told no web-only plugin skills and is handed no web capture tool or checkpoint line", async () => {
    const { rig, requests } = await unrealGameRig();
    await rig.core.plugins.setEnabled("genex", true);
    await rig.core.sendUserMessage("Add a lighthouse", { engine: "vendor", project: GAME });
    await afterTurn(rig);
    const [request] = requests;
    assert.ok(request, "the build reached the builder");
    const web = rig.core.plugins.snapshot(GameEngine.Web).applied.skills;
    const told = rig.core.plugins.snapshot(GameEngine.Unreal).applied.skills;
    const webOnly = web.filter((skill) => !told.includes(skill));
    assert.ok(webOnly.includes("genex/genex-threejs-multiplayer"), "the web has skills an Unreal game does not");
    const read = [...(request.notices ?? []), request.prompt].join("\n\n");
    assert.match(read, /\[genex\//, "the plugin's guidance it does get is there to read");
    for (const skill of webOnly) assert.ok(!read.includes(`[${skill}]`), `${skill} stays out of its context`);
    assert.equal(request.onCapture, undefined, "no capture of a folder that holds notes");
    assert.doesNotMatch(read, /lights the user's Reload/, "no web preview Reload to light");
  });
});

import { LoopTool, PartRunState } from "../../src/plugins/unreal/editor-queue.ts";
import { LoopToolName } from "../../src/plugins/unreal/loop-tools.ts";
import { checkPython, PythonProblemCode } from "../../src/plugins/unreal/python-check.ts";
import { coreLite } from "../helpers/core-lite.ts";
import * as editorStandIn from "../helpers/unreal-editor-stand-in.ts";

/**
 * A Loop on a racing game from Epic's Vehicle template: builders and the chat never hold the
 * harness-only tools, an invented Python method fails the gate, and the play test runs unthrottled.
 */
describe("a Loop on a vehicle template", () => {
  it("builders and the chat are never handed the runner-only Loop tools (run-part, rollback-part, ...): a chat's and a builder's Unreal tools leave out every harness-only one", async (t) => {
    const { core, close } = await coreLite();
    // The plugin's backend and its editor bridge stop here; a core that was only initialized stops nothing of its own.
    t.after(async () => {
      core.plugins.cancel();
      await core.mcp.close().catch(() => {});
      await close();
    });
    await core.plugins.setEnabled("unreal", true);
    const project = "racer";
    const game = await core.games.scaffold(project);
    // The builder's gate and lookups reach a game that holds an Unreal project.
    await writeFile(path.join(game.dir, "Racer.uproject"), "{}");
    const threadId = await core.createGameThread(project);
    const handed: string[][] = [];
    core.engines.register({
      id: EngineId.ClaudeCode,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        handed.push((request.liveTools ?? []).map((tool) => tool.name).filter((name) => name.startsWith("unreal__")));
        return { ok: true, engine: EngineId.ClaudeCode, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const delegate = (extra: Record<string, unknown>) =>
      api["engine.delegate"]?.({ engine: EngineId.ClaudeCode, project, threadId, ...extra });
    await delegate({ prompt: "Make the bike first-person" });
    const worktree = path.join(core.layout.scratch, "worktrees", `${project}-RiderView-1`);
    await mkdir(worktree, { recursive: true });
    await delegate({ prompt: "Build the part RiderView", cwd: worktree });
    const runnerOnly = [
      LoopToolName.RunPart,
      LoopToolName.PartResult,
      LoopToolName.RollbackPart,
      LoopToolName.ReloadLevel,
      LoopToolName.ExportReference,
    ].map((name) => `unreal__${name}`);
    assert.equal(handed.length, 2);
    for (const [who, tools = []] of [
      ["the chat", handed[0]],
      ["a builder", handed[1]],
    ] as const) {
      for (const name of runnerOnly) assert.ok(!tools.includes(name), `${who} is not handed ${name}`);
      assert.ok(tools.includes(`unreal__${LoopToolName.CheckPart}`), `${who} still has the builder's gate`);
      // The C++ module's tools are any Unreal project's agents' own: the one Loop's lead calls them.
      for (const name of [`unreal__${LoopToolName.CppStatus}`, `unreal__${LoopToolName.AddCppModule}`])
        assert.ok(tools.includes(name), `${who} is handed ${name}`);
    }
  });

  it("the play test ran with Unreal's background throttle on: the editor queue turns the throttle off before StartPIE and gives it back after stop_play", async () => {
    const editor = editorStandIn.standIn();
    const run = await editorStandIn.runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.equal(editor.state.throttleAtPlay, false, "the test played unthrottled");
    assert.equal(editor.state.throttle, true, "the editor has its setting back");
    assert.deepEqual(editorStandIn.written(editor.calls), [false, true]);
    const tools = editorStandIn.sequence(editor.calls);
    assert.ok(tools.indexOf(LoopTool.SetProperties) < tools.indexOf(LoopTool.StartPlay), "lifted before play");
    assert.ok(tools.lastIndexOf(LoopTool.SetProperties) > tools.indexOf(LoopTool.StopPlay), "given back after it");
  });

  it("an apply.py called an invented method (set_generate_overlap_events) and passed the gate: the check names an unknown method on an object of a known class", async (t) => {
    const python = await promisify(execFile)("python3", ["-c", "import ast"]).then(
      () => "python3",
      () => "",
    );
    if (!python || process.platform === "win32") {
      t.skip("needs python3 (the product uses Unreal's own)");
      return;
    }
    const names = path.join(await tmpDir("python-names-"), "python-names.json");
    await writeFile(
      names,
      JSON.stringify({
        Actor: ["get_component_by_class"],
        StaticMeshComponent: ["set_editor_property"],
        PrimitiveComponent: ["generate_overlap_events", "set_editor_property"],
      }),
    );
    const source = [
      "import unreal",
      "box = actor.get_component_by_class(unreal.StaticMeshComponent)",
      "box.set_generate_overlap_events(True)",
    ].join("\n");
    const problems = await checkPython({ python, names }, source);
    assert.deepEqual(
      problems.map((p) => [p.code, p.line]),
      [[PythonProblemCode.UnknownName, 3]],
    );
    assert.match(problems[0]?.message ?? "", /set_generate_overlap_events \(a StaticMeshComponent\)/);
    assert.match(problems[0]?.message ?? "", /set_editor_property\("generate_overlap_events"/, "and what to call");
  });
});

/**
 * New game makes the game before the chat's first ask, as an empty folder with no kind; with the
 * Unreal plugin on, the delegated turn finds a project that already exists. A folder with no kind
 * yet (the host's facts) is handed the question card, exactly as a game the turn makes itself, and
 * keeps it in the session that asked: the answer comes back to it, the card still at hand.
 * Flipped: the first build's brief asked web or Unreal in words; the words go alone now.
 */
describe("a game New game made is asked its engine on its chat's first ask", () => {
  it("with the Unreal plugin on, a game New game made is empty, its chat's builds read the words alone with the question card at hand", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.plugins.setEnabled("unreal", true);
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        return { ok: true, engine: "vendor", sessionId: "session-1", turns: 1, usage: {}, summary: "Web or Unreal?" };
      },
    });
    const game = await rig.core.createGame("Arcade Racer");
    assert.deepEqual(
      (await rig.core.games.list()).find((listed) => listed.name === game.name)?.facts,
      [],
      "the made game has no kind yet",
    );
    const thread = await rig.core.threadForGame(game.name);
    const turnsEnded = (count: number) =>
      waitForLog(
        rig.core,
        (log) => log.filter((e) => e.thread_id === thread && e.data.type === "turn_ended").length >= count,
        30_000,
        `turn ${count}`,
      );
    await rig.core.sendUserMessage("Make me a small arcade racing game with a neon city track.", {
      engine: "vendor",
      thread,
    });
    await turnsEnded(1);
    await rig.core.sendUserMessage("Web, please", { engine: "vendor", thread });
    await turnsEnded(2);
    const [first, next] = requests;
    assert.ok(first && next, "both messages reached the builder");
    assert.equal(first.prompt, "Make me a small arcade racing game with a neon city track.");
    assert.deepEqual(
      first.interviewTools?.map((tool) => tool.name),
      ["start_autopilot", "ask_user"],
      "with the question card bridged in beside Auto's Loop start (flipped: auto-loop)",
    );
    assert.equal(next.prompt, "Web, please");
    assert.deepEqual(
      next.interviewTools?.map((tool) => tool.name),
      ["start_autopilot", "ask_user"],
      "the session that asked keeps its card while the game has no kind (flipped: resumed card)",
    );
  });
});

/**
 * A game linked to Unreal during its turn (the user answered the engine question and the builder
 * made the game's Unreal project in that same turn): the turn's end reads the game's engine again,
 * so it never loads the web preview, judges a black canvas or records a failed `build_observation`.
 */
describe("a game linked to Unreal during its turn", () => {
  it("a game linked to Unreal during its turn got the web health pass and a black-screen line: no preview load, no build_observation, the builder's report alone", async () => {
    const { writeEngineBinding } = await import("../../src/substrate/game-engine-binding.ts");
    const { ENGINES, UNREAL_ENGINE } = await import("../helpers/engines.ts");
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await rig.core.games.scaffold("city-circuit", { title: "City Circuit" });
    // The folder the web preview would load shows a black canvas.
    rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0, litFraction: 0 };
    const report = "Made the Unreal project from the vehicle template. Unreal is opening it for the first time.";
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        // What `unreal__new-game` did mid-turn: the project inside the game's folder, the game linked to it.
        const uproject = path.join(game.dir, "unreal", "CityCircuit.uproject");
        await mkdir(path.dirname(uproject), { recursive: true });
        await writeFile(uproject, "{}\n");
        await writeEngineBinding(game.dir, uproject, UNREAL_ENGINE.id, ENGINES);
        await writeFile(path.join(request.cwd, "NOTES.md"), "# City Circuit\n");
        return { ok: true, engine: "vendor", sessionId: "cc-1", turns: 9, usage: {}, summary: report };
      },
    });
    await rig.core.sendUserMessage("Unreal Engine", { engine: "vendor", project: game.name });
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");
    const said = (await rig.core.store.listMessages(rig.core.mainThread)).map((m) => m.content ?? "").join("\n");
    assert.equal((await rig.core.games.list()).find((g) => g.name === game.name)?.engine?.kind, GameEngine.Unreal);
    assert.deepEqual(rig.preview.loads, [], "the web preview never loads the Unreal game's folder");
    assert.equal(customEvents(events, "build_observation").length, 0, "no web observation for SkillOpt to learn from");
    assert.doesNotMatch(said, /black screen|loads clean|console error/, "no web verdict in the chat");
    assert.ok(said.includes(report), "the builder's report reaches the chat");
  });
});

/**
 * A new game from home, first message "Hello": the game was named "Hello World
 * Adventure", and the reply was seven tool steps, one failed, and a report that the workspace was
 * still empty, its renderer and inspection hooks set up, with a question card about what to make.
 * The brief had said "Continue from the existing code in this workspace" and nothing about how to
 * answer small talk.
 */
describe("a Hello in a brand-new game", () => {
  // Flipped: the greeting was briefed as a blank page with a rule for small talk ahead of the build
  // rules. It reaches the model as written; the context says who the person is, and nothing of where
  // the game stands, which the session sees in the folder.
  it("HG-1. a greeting in a game the studio just made reaches the model as written, with no rule about greetings", async () => {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const prompts: string[] = [];
    const systems: string[] = [];
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "Hello" }],
        "events.list": () => [],
        "game.list": () => [{ name: "untitled-game", title: "Untitled game", dir: "/g/untitled-game" }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "run.exec": (params) => ({
          code: 0,
          stdout: String(params.command).includes("rev-list") ? "1\n" : "",
          stderr: "",
        }),
        "engine.delegate": (params) => {
          prompts.push(String(params.prompt));
          systems.push(String(params.system));
          return { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "s1", summary: "Hi!" };
        },
      },
    });
    await runDelegatedTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn-1",
      text: "Hello",
      engine: "claude-code",
      engineLabel: "Claude Code",
      project: "untitled-game",
    });
    assert.deepEqual(prompts, ["Hello"]);
    assert.doesNotMatch(systems[0] ?? "", /Continue from the existing code|nothing has been built|greeting/i);
    assert.match(systems[0] ?? "", /may not be a programmer: talk with them about their game/);
  });
});

/**
 * A Resume pressed as soon as the pause shows reaches the harness while the paused run still writes
 * its close (its report, its tear-down): it waits for that close and then starts, and is never
 * refused as a second run of the same chat. The paused run's report is held until the harness has
 * read the Resume's journal and answered one more message, so the Resume has met the closing run.
 */
describe("a Resume pressed as the pause shows", () => {
  it("the web director's Resume waits for the paused run's close, then starts: never refused as a second run", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    let calls = 0;
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        calls++;
        // Only the chat's launch matters here; each run's lead thinks until it is stopped.
        if (calls > 1)
          return new Promise((resolve) =>
            request.signal?.addEventListener("abort", () =>
              resolve({ ok: false, stopReason: "stopped", summary: "" } as never),
            ),
          );
        return {
          ok: true,
          engine: "vendor",
          summary: "Starting the garden now.",
          turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [{ name: "start_autopilot", args: { goal: "A small walled garden to explore" } }],
        };
      },
    });
    await rig.core.games.scaffold("garden", { title: "garden" });
    const thread = await rig.core.threadForGame("garden");
    type Log = Awaited<ReturnType<typeof rig.core.listAllEvents>>;
    const leading = (n: number) => (log: Log) => customEvents(log, "run_registered").length >= n && calls > n;
    const paused = (n: number) => (log: Log) =>
      customEvents(log, "autopilot_paused").length + customEvents(log, "run_finished").length >= n;

    await rig.core.sendUserMessage("Make a small walled garden to explore", { thread, engine: "vendor" });
    const first = await waitForLog(rig.core, leading(1), 60_000, "the run's lead at work");
    const runId = String((customEvents(first, "run_registered")[0] as Record<string, unknown>).runId);

    // The host calls the harness makes, as the host serves them: the paused run's report is held.
    type Serve = (params: Record<string, unknown>) => Promise<unknown>;
    const api = rig.core.host.options.api as unknown as Record<string, Serve>;
    const serve = {
      report: api[HostMethod.RunArtifact]!,
      read: api[HostMethod.ArtifactRead]!,
      list: api[HostMethod.GameList]!,
    };
    let reportHeld = () => {};
    const held = new Promise<void>((resolve) => {
      reportHeld = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resumeRead = () => {};
    const read = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    let resumeSent = false;
    let listsWhileHeld = 0;
    api[HostMethod.RunArtifact] = async (params) => {
      if (params.runId === runId && params.name === "report.json") {
        reportHeld();
        await released;
      }
      return serve.report(params);
    };
    api[HostMethod.ArtifactRead] = async (params) => {
      const value = await serve.read(params);
      // Answered first; the next turn is after the answer went to the harness.
      if (resumeSent && params.artifactId === `autopilot_${runId}`) setImmediate(resumeRead);
      return value;
    };
    api[HostMethod.GameList] = async (params) => {
      if (resumeSent) listsWhileHeld += 1;
      return serve.list(params);
    };

    await rig.core.stopThread(thread).catch(() => {});
    await held;
    assert.equal(customEvents(await rig.core.listAllEvents(), "autopilot_paused").length, 1, "the pause shows");
    resumeSent = true;
    void rig.core.resumeAutopilot(runId).catch(() => {});
    await read;
    // The harness answers in order: once it answers this, it has run the Resume's start past the
    // journal it read, up to where that start waits (or would be refused, or would begin).
    assert.equal(await rig.core.host.healthcheck(), true);
    const startsWhileHeld = listsWhileHeld;
    release();

    const second = await waitForLog(
      rig.core,
      (log) => leading(2)(log) || customEvents(log, "run_start_blocked").length > 0,
      60_000,
      "the resumed run's lead at work",
    );
    assert.deepEqual(customEvents(second, "run_start_blocked"), [], "the Resume is not refused");
    assert.equal(startsWhileHeld, 0, "while the paused run closed, the Resume only waited: it read no game list");
    const resumed = (customEvents(second, "run_registered") as Array<Record<string, unknown>>)[1];
    assert.equal(resumed?.resumed, true, "the Resume started once the paused run had closed");
    await rig.core.stopThread(thread).catch(() => {});
    await waitForLog(rig.core, paused(2), 60_000, "the resumed run to pause").catch(() => {});
  });
});

/**
 * Issue #47: a coding model that cannot see images, picked as the workers' or the main agent's
 * model on a local engine. A screenshot a tool took, or a frame the person attached, went to it as
 * pixels, Ollama refused the request as unavailable, and the turn died or fell back to another
 * engine. A model that cannot see is told the pictures exist instead.
 */
describe("a local model that cannot see images (issue #47)", () => {
  const describedWith = (supportsVision: boolean) => [
    {
      id: "ollama",
      label: "Ollama",
      kind: "direct",
      status: { code: "ready", detail: "" },
      defaultModel: "coder",
      models: [{ id: "coder", label: "coder", contextWindow: 32_000, supportsTools: true, supportsVision }],
    },
  ];
  /** The messages a direct turn's one completion carries, for a model that sees or not. */
  async function sent(supportsVision: boolean): Promise<Array<{ role: string; content: string; images: number }>> {
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "engine.describe": () => describedWith(supportsVision),
        "engine.complete": () => ({ message: { role: "assistant", content: "done" } }),
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
      },
    });
    await runTurn(
      recorder.ctx as never,
      {
        turnId: "t1",
        threadId: "th",
        engine: "ollama",
        model: "coder",
        input: [],
        stills: [{ label: "plaza", mimeType: "image/jpeg", data: "AAAA" }],
      } as never,
    );
    const [complete] = recorder.paramsOf("engine.complete") as Array<{
      messages: Array<{ role: string; content: unknown; images?: unknown[] }>;
    }>;
    return (complete?.messages ?? []).map((m) => ({
      role: m.role,
      content: String(m.content),
      images: m.images?.length ?? 0,
    }));
  }

  it("LR2. a turn on a model that cannot see sends no pixels and says the pictures exist; one that sees gets them", async () => {
    const blind = await sent(false);
    assert.ok(blind.length > 0, "the turn asked its model");
    assert.equal(
      blind.reduce((n, m) => n + m.images, 0),
      0,
      "no pixels reach a model that cannot see them",
    );
    assert.match(blind.at(-1)?.content ?? "", /plaza/, "the model hears which pictures it was not shown");
    const seeing = await sent(true);
    assert.equal(seeing.at(-1)?.images, 1, "a model that sees gets the picture, as before");
  });
});

describe("a chat whose turn made the game's project (an Unreal game)", () => {
  // Flipped: the session was told to go on with what it said it would do. Genex's line says the
  // project's new kind alone; the session goes on in its own words.
  it("LL1. the session that goes on is told the project's new kind, and no rule about a Loop or what to do", async () => {
    const { factsReadyNotice } = await import("../../src/harness-seed/loop/project-prompts.ts");
    const notice = factsReadyNotice([{ id: "unreal-project", path: "unreal" }]);
    assert.match(notice, /now holds an Unreal Engine project in `unreal\/`/);
    assert.doesNotMatch(notice, /start_autopilot|Loop|Go on with/);
  });
});

describe("a chat whose saved session is gone (another account, or never saved)", () => {
  it("LS1. the engine's answer that it has no such session starts a fresh one, never 'the build stopped early'", async () => {
    const calls: Array<string | null> = [];
    const result = await steeredCall({ cancelled: false }, undefined, {
      prompt: "PROMPT",
      resume: "aa932c8a-f6c0-463c-8fa0-87a9ae52895c",
      call: async (_prompt, resume) => {
        calls.push(resume);
        if (resume)
          return {
            ok: false,
            summary: "",
            turns: 0,
            usage: {},
            engine: "claude-code",
            errorText: `No conversation found with session ID: ${resume}`,
          };
        return { ok: true, summary: "built", turns: 1, usage: {}, engine: "claude-code", sessionId: "fresh-1" };
      },
    });
    assert.deepEqual(calls, ["aa932c8a-f6c0-463c-8fa0-87a9ae52895c", null]);
    assert.equal(result.ok, true);
  });
});

/** The smallest PNG: one transparent pixel. */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("a lead hears what its workers found", () => {
  /** A reader's written report, its finding far past its first sentence. */
  const REPORT = [
    "Reviewed the scene from four cameras.",
    "",
    "1. The roofs and the dock read well from the overview camera.",
    "2. The fog is a little thin at the far shore; raise its density.",
    "3. The hero's left arm sticks out about 40 degrees from the body in idle, and a strip of cloth stretches to the floor in the walk.",
  ].join("\n");
  const FINDING = /left arm sticks out about 40 degrees/;

  it("LH1. a reader's written report never reached the lead: worker_status names it in full, and a reopened pool still does", async () => {
    const { chatPool, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Fresh eyes", task: "Review the scene.", isolation: "read" });
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: REPORT });
    assert.match(await pool.call(WorkerTool.Status, { id }), FINDING);
    assert.match(await pool.call(WorkerTool.Wait, { id }), FINDING);
    await pool.close();
    const reopened = await chatPool(host, repo);
    assert.match(await reopened.call(WorkerTool.Status, { id }), FINDING, "the report outlives the turn");
  });

  it("LH2. a lead waiting on any worker reads the report of the one that ended, while the list of all stays one line each", async () => {
    const { chatPool, gameRepo, poolHost, settle, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Fresh eyes", task: "Review the scene.", isolation: "read" });
    const waited = pool.call(WorkerTool.Wait, { seconds: 60 });
    await settle();
    host.sessionOf(id).end({ ok: true, sessionId: "s1", summary: REPORT });
    assert.match(await waited, FINDING);
    const all = await pool.call(WorkerTool.Status, {});
    assert.match(all, /Reviewed the scene from four cameras\./, "the list names it by its first sentence");
    assert.doesNotMatch(all, FINDING);
  });

  it("LH4. a worker ended its turn to wait on a long job in the background, and its later calls were refused: its brief says its turn is its whole job", async () => {
    const { workerBrief } = await import("../../src/harness-seed/loop/workers/prompts.ts");
    const brief = workerBrief({
      identity: { folderLabel: "AI Games/garden", facts: [{ id: "web-game", path: "." }] },
      task: "Make the three townsfolk with Genex.",
      isolation: "copy",
      research: false,
      typeDescription: null,
      inputs: [],
    } as never);
    assert.match(brief, /Your turn is your whole job/);
    assert.match(brief, /never wait with sleep or a background command/i);
    assert.match(brief, /call its wait again with the same id/);
  });

  it("LH5. a save point may name the picture that shows its change, and that picture leads its round on the graph", async () => {
    const { gameRepo, loopHost } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir("save-shows-");
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await writeFile(path.join(dir, "shots/hero-closeup.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await gameRepo(dir);
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          const shows = "shots/hero-closeup.png";
          answers.push(await tool("save_point", { label: "Hero", summary: "the hero's arms at his sides", shows }));
          await writeFile(path.join(dir, "b.txt"), "b");
          answers.push(await tool("save_point", { label: "Dock", summary: "the dock" }));
          await writeFile(path.join(dir, "c.txt"), "c");
          answers.push(await tool("save_point", { label: "Boat", summary: "the boat", shows: "../outside.png" }));
          await tool("finish", { summary: "Built.", proof: "a.txt" });
          return undefined;
        },
      ],
    });
    await host.start();
    const [hero, dock, boat] = host.appended("facet_iteration");
    assert.match(String((hero?.shown as { path?: string } | undefined)?.path), /save-1\/shows/);
    assert.equal(dock?.shown, undefined);
    assert.equal(boat?.shown, undefined, "a path outside the folder is never read");
    // Flipped (phase 5): a save point without a picture is fine; naming one is optional, never asked for.
    for (const answer of answers.slice(0, 2)) assert.doesNotMatch(String(answer), /name the picture/);
    assert.match(String(answers[2]), /not a picture in the project's folder/);
  });

  it("a save point's picture is read only from inside the folder, as a plain PNG or JPEG", async () => {
    const { shownPicture } = await import("../../src/harness-seed/loop/director/open/shown-picture.ts");
    const { symlink } = await import("node:fs/promises");
    const root = await tmpDir("save-shows-hostile-");
    const dir = path.join(root, "game");
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    const picture = Buffer.from(ONE_PIXEL_PNG, "base64");
    await writeFile(path.join(root, "outside.png"), picture);
    await writeFile(path.join(dir, ".hidden/a.png"), picture);
    await writeFile(path.join(dir, "shots/notes.txt"), "not a picture\n");
    await writeFile(path.join(dir, "shots/huge.png"), Buffer.concat([picture, Buffer.alloc(9 * 1024 * 1024)]));
    await writeFile(path.join(dir, "shots/ok.png"), picture);
    await symlink(path.join(root, "outside.png"), path.join(dir, "shots/link.png"));
    await promisify(execFile)("mkfifo", [path.join(dir, "shots/pipe.png")]);
    const hostile = [
      "../outside.png",
      path.join(root, "outside.png"),
      "shots/link.png",
      ".hidden/a.png",
      "shots/pipe.png",
      "shots/huge.png",
      "shots/notes.txt",
      "shots/missing.png",
      "shots/../../outside.png",
    ];
    for (const rel of hostile) {
      const shown = await shownPicture(dir, rel);
      assert.ok("problem" in shown, `${rel} is refused`);
    }
    const ok = await shownPicture(dir, "shots/ok.png");
    assert.ok("image" in ok && ok.image.data === picture.toString("base64"));
  });

  it("LH6. a worker's work merged: the merge hands back the pictures it made", async () => {
    const { chatPool, delegation, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Model the annex", task: "Model the annex.", isolation: "copy" });
    const copy = String(delegation(host, id).cwd);
    await mkdir(path.join(copy, "assets/annex"), { recursive: true });
    await writeFile(path.join(copy, "assets/annex/annex.glb"), "glb");
    await writeFile(path.join(copy, "assets/annex/render.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Modelled the annex." });
    const merged = await pool.call(WorkerTool.Mark, { id, verdict: "used" });
    assert.match(merged, /Merged w1/);
    assert.match(merged, /Pictures it made: assets\/annex\/render\.png/);
    assert.doesNotMatch(merged, /annex\.glb/, "only its pictures");
  });

  it("LH3. a copy worker's status names the files its work changes", async () => {
    const { chatPool, delegation, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Add a boat", task: "Add boat.js.", isolation: "copy" });
    const copy = String(delegation(host, id).cwd);
    await mkdir(path.join(copy, "src"), { recursive: true });
    await writeFile(path.join(copy, "src/boat.js"), "export const boat = 1;\n");
    await writeFile(path.join(copy, "a.txt"), "changed\n");
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Added the boat." });
    const status = await pool.call(WorkerTool.Status, { id });
    assert.match(status, /a\.txt/);
    assert.match(status, /src\/boat\.js/);
  });
});

describe("a finish claim with known gaps", () => {
  /** A game folder with one commit, for a Loop in place. */
  const folder = async (prefix: string) => {
    const { gameRepo } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir(prefix);
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    return gameRepo(dir);
  };
  const GAPS = "the player has no walk animation\nthe hero's left arm sticks out from the body";

  it("LF1. the lead's closing line of known gaps was cut off with its claim at its length limit: what remains is a field of its own, read first and whole", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const dir = await folder("finish-remaining-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 15 * MINUTE_MS, completionPolicy: "goal" } },
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          await tool("save_point", { label: "Scene", summary: "the scene" });
          await tool("finish", {
            review: "yes",
            summary: `${"The scene holds the town. ".repeat(160)}`,
            remaining: GAPS,
            proof: "a.txt",
          });
          return undefined;
        },
      ],
    });
    await host.start();
    const prompt = String(host.reviewed()[0]?.prompt ?? "");
    assert.match(prompt, /the hero's left arm sticks out from the body/);
    assert.ok(
      prompt.indexOf("the player has no walk animation") < prompt.indexOf("## The lead's claim"),
      "what remains comes before the claim",
    );
  });

  it("LF3. with gaps named but the Loop's time nearly spent, a reviewer's yes still closes it", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const dir = await folder("finish-gaps-late-");
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 15 * MINUTE_MS, completionPolicy: "timed" } },
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          await tool("save_point", { label: "Scene", summary: "the scene" });
          answers.push(
            await tool("finish", { review: "yes", summary: "The scene is built.", remaining: GAPS, proof: "a.txt" }),
          );
          return undefined;
        },
      ],
    });
    await host.start();
    assert.match(String(answers[0]), /^Accepted/);
  });
});

describe("the most workers at once", () => {
  it("LW1. a lead was told 'up to eight at once' while the person's Settings allowed four, and the fifth was answered 'Started' before the host refused it: the pool says the live cap and refuses at once", async () => {
    const { chatPool, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const { workerTools } = await import("../../src/harness-seed/loop/workers/specs.ts");
    const repo = await gameRepo();
    const host = poolHost(repo, { workersAllowed: 4 });
    const pool = await chatPool(host, repo);
    for (const n of [1, 2, 3, 4]) await start(pool, { title: `Read ${n}`, task: "Look around.", isolation: "read" });
    const fifth = await pool.call(WorkerTool.Start, { title: "Read 5", task: "Look around.", isolation: "read" });
    assert.match(fifth, /^Not started: 4 workers are running, and at most 4 run at once/);
    assert.equal(host.sessions.length, 4, "nothing was asked of the host for the fifth");
    const start5 = workerTools([], pool.state.allowed).find((tool) => tool.name === WorkerTool.Start);
    assert.match(String(start5?.description), /Up to 4 at once/);
  });
});

describe("the user's ask to finish a running build (director/wrap-up.ts)", () => {
  // Flipped: the wrap-up's message said what to call and claim ("Call finish now … victory=yes only if
  // the goal is reached", "THE PERSON ASKED THE LOOP TO FINISH: this is your last turn…"); it is Genex's
  // one line now, and what the lead may do is finish's and wrap_up's own descriptions.
  it("FA4. the wrap-up after the person's ask never invites a claim: its one line says why the turn is the last", () => {
    for (const line of [LOOP_WORDS.finishAsked, LOOP_WORDS.turnFailed("the provider broke")]) {
      assert.doesNotMatch(line, /victory|claim|review|call /i, line);
      assert.match(line, /closes when this turn ends/);
    }
  });

  it("FA7. wrap_up told a lead to stop at once with `finish user_asked`, a parameter the one Loop's finish never had: the one rule names the finish it has, and that finish stops the Loop at once", async () => {
    const { loopHost, gameRepo } = await import("../helpers/loop-host.ts");
    const { copyProject, Project } = await import("../helpers/project-fixtures.ts");
    const { MESSAGE: OPEN_END } = await import("../../src/harness-seed/loop/director/open/finish.ts");
    const words = "Stop the build now, please.";
    const answers: string[] = [];
    const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("stop-at-once-")));
    const host = loopHost({
      dir,
      facts: [{ id: "godot-project", path: "." }],
      run: { runId: "run-stop-at-once" },
      turns: [
        async ({ tool, host }) => {
          answers.push(String(await tool("wrap_up", { user_asked: words })));
          // The ask is the app's own run_control record: the run's inbox reads it as finishing.
          host.inbox.finishing = true;
          answers.push(String(await tool("finish", { summary: "Stopped as asked." })));
          return undefined;
        },
      ],
    });
    host.inbox.said.push(words);
    await host.start();
    const tools = (host.leadCalls()[0]?.director as { tools?: Array<Record<string, any>> } | undefined)?.tools ?? [];
    const finish = tools.find((tool) => tool.name === "finish");
    const wrapUp = tools.find((tool) => tool.name === "wrap_up");
    assert.ok(finish && wrapUp, "both are the lead's");
    assert.ok(!("user_asked" in (finish.parameters?.properties ?? {})), "finish takes no user_asked");
    assert.doesNotMatch(String(wrapUp.description), /finish user_asked/, "the rule names no parameter finish lacks");
    assert.equal(host.leadCalls().length, 1, "no wrap-up turn after a finish that stopped it");
    assert.equal(host.appended("run_finished").at(-1)?.stoppedBecause, OPEN_END.personFinished);
    assert.match(String(answers[1]), /asked the Loop to finish: it is closed/);
  });

  it("FA6. an open Loop starts no worker once anybody asked it to finish — the app's own Finish too, not only the lead's wrap_up", async () => {
    const { openHandler } = await import("../../src/harness-seed/loop/director/open/tools.ts");
    const { WRAP_UP_WORDS } = await import("../../src/harness-seed/loop/director/wrap-up-prompts.ts");
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      open: { halted: false },
      state: { finished: false, finish: null, finishAsk: null },
      inbox: { finishing: async () => true },
    };
    const answer = await openHandler(loopRun as never)("worker_start", { title: "Lights", task: "Add street lights" });
    assert.equal(answer, WRAP_UP_WORDS.noWorkers);
  });
});

// Flipped (one Loop): this drove the web lead's handler (director/tools.ts); every Loop's lead has the one handler now.
describe("a worker asked for after the lead's finish (director/open/tools.ts)", () => {
  it("FW1. worker_start after the lead's finish answered 'Started w2' though no session ran: it refuses with the run's own reason and starts nothing", async () => {
    const { openHandler } = await import("../../src/harness-seed/loop/director/open/tools.ts");
    const { OPEN_WORDS } = await import("../../src/harness-seed/loop/director/open/prompts.ts");
    const { latchClose } = await import("../../src/harness-seed/loop/director/close-latch.ts");
    const asked: string[] = [];
    const pool = {
      state: { records: [], types: [] },
      call: async (name: string) => {
        asked.push(name);
        return "Started w2 (copy).";
      },
    };
    const loopRunOf = () => ({
      ctx: { cancelled: false },
      toolCalls: 0,
      open: { halted: null, pool },
      state: { finished: false, finish: null as unknown, finishAsk: null },
      inbox: { finishing: async () => false },
    });
    const start = { title: "Lights", task: "Add street lights", isolation: "copy" };
    const open = loopRunOf();
    assert.equal(
      await openHandler(open as never)("worker_start", start),
      "Started w2 (copy).",
      "a running run still starts workers",
    );

    const closing = loopRunOf();
    closing.state.finish = { summary: "The plaza is lit.", at: 0 };
    void latchClose(closing.state as never, () => new Promise(() => {}));
    assert.equal(await openHandler(closing as never)("worker_start", start), OPEN_WORDS.ending, "its close under way");

    const closed = loopRunOf();
    closed.state.finished = true;
    assert.equal(await openHandler(closed as never)("worker_start", start), OPEN_WORDS.ending, "the run closed");
    assert.deepEqual(asked, ["worker_start"], "the pool was asked for the running run's worker alone");
  });
});

describe("a run whose every role was set to think at max effort", () => {
  it("EF1. its workers and reviewers think at most hard, its lead as set; a lower setting is every role's", async () => {
    const { roleEffort } = await import("../../src/harness-seed/loop/model-roles.ts");
    const set = (effort: string) => ({ roles: { efforts: { planner: effort, builder: effort, judge: effort } } });
    const each = (run: object) => ["planner", "builder", "judge"].map((role) => roleEffort(run, role));
    assert.deepEqual(each(set("max")), ["max", "high", "high"], "a worker's and a reviewer's thinking is held to high");
    assert.deepEqual(each(set("medium")), ["medium", "medium", "medium"]);
    assert.deepEqual(each({ effort: "max" }), ["max", undefined, undefined], "the composer's dial is the lead's");
  });
});

describe("a chat in a game linked to an engine other than Unreal", () => {
  // Flipped: an older caller that named only the engine was briefed too; every caller hands the facts.
  // The context no longer reads the game at all: it is the same text in every folder.
  it("EG1. its context never gives web-page rules, the preview's Reload or the web Loop", async () => {
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const context = chatContext({ folderLabel: "AI Games/garden", appLanguage: null });
    for (const words of [/window\.__studio/, /Reload/, /holds a web game/, /builders working in parallel/])
      assert.doesNotMatch(context, words, String(words));
  });
});

describe("the close's sentence of an open Loop", () => {
  it('SP1. a save point the lead gave no summary closes as its label alone, never with an empty "()" or ":"', async () => {
    const { openCloseOf } = await import("../../src/harness-seed/loop/director/open/graph.ts");
    const { newOpenJournal } = await import("../../src/harness-seed/loop/director/open/contract.ts");
    const point = (label: string, summary: string) => ({
      label,
      summary,
      snapshotId: "s",
      auto: false,
      at: 0,
      notes: [],
    });
    const journal = (...savePoints: ReturnType<typeof point>[]) => ({ ...newOpenJournal(), savePoints });
    assert.equal(openCloseOf(journal(point("Ship flies", "")), false).summary, "One save point: Ship flies.");
    assert.equal(
      openCloseOf(journal(point("Ship flies", ""), point("Rocks fall", "  ")), false).summary,
      "2 save points; the last, Rocks fall.",
    );
    assert.equal(
      openCloseOf(journal(point("Ship flies", "It turns and thrusts.")), false).summary,
      "One save point: Ship flies (It turns and thrusts).",
      "a summary's own full stop is not doubled",
    );
  });
});

describe("a plugin's web build and the chat's turn", () => {
  it("WB1. a turn whose only change is a plugin's web build (Godot's export in web/) leaves the game's kind as it was: no new-kind continuation", async () => {
    const { kindKey } = await import("../../src/harness-seed/loop/web-build.ts");
    const before = [{ id: "godot-project", path: "godot" }];
    const exported = [
      ...before,
      { id: "web-game", path: "web" },
      { id: "godot-web-export", path: "web", source: "plugin:godot" },
    ];
    assert.equal(kindKey(exported), kindKey(before), "the build is no new kind");
    const site = [...before, { id: "web-game", path: "site" }];
    assert.notEqual(kindKey(site), kindKey(before), "a web game no plugin claims is one");
  });
});

describe("a Loop whose lead lost what its goal needs (claude-code-and-chatgpt)", () => {
  const WHY =
    "Unity's editor tools are gone from this session, so nothing I change reaches the game. Open the project in Unity, then press Resume.";

  it("MK1. a Unity lead whose editor tools vanished spent hours on work that never reached the game, with no way to tell the person: it pauses the Loop with its words, and nothing runs after", async () => {
    const { gameRepo, loopHost } = await import("../helpers/loop-host.ts");
    const { OPEN_WORDS } = await import("../../src/harness-seed/loop/director/open/prompts.ts");
    const dir = await tmpDir("lead-pauses-");
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await gameRepo(dir);
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          answers.push(await tool("pause", {}));
          answers.push(await tool("pause", { why: WHY }));
          answers.push(await tool("save_point", { label: "Late", summary: "after the pause" }));
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.match(String(answers[0]), /pause needs/, "a pause says what only the person can do");
    assert.match(String(answers[1]), /end your turn/i);
    assert.equal(answers[2], OPEN_WORDS.paused, "nothing is kept once it pauses");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /Open the project in Unity, then press Resume/);
    assert.equal(host.leadCalls().length, 1, "no turn after the pause");
    assert.equal(host.appended("autopilot_paused").length, 1);
    assert.equal(host.reviewed().length, 0, "nothing was claimed");
  });
});

describe("a tool the user asked for that can't run here (claude-code-and-chatgpt)", () => {
  // Flipped: the brief carried a rule to tell the user with the fix first. The tools' own refusals
  // say why they can't run, and the person's words, naming Blender, reach the session as written.
  it("MK2. the contractor saw Blender was too old to run, said Unity was ready and queued a 24-hour build that never used Blender: the words naming Blender reach it as written, with no rule beside them", async () => {
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const context = chatContext({ folderLabel: "AI Games/fight", appLanguage: null });
    assert.doesNotMatch(context, /never carry on without it in silence|can't run here/);
  });
});

describe("the reviewer's no's in a Loop that still has time", () => {
  const MET = "The hands, the boss and the full run were already accepted and still hold.";
  const NOT_DONE = "The enemy in the game shows none of the armour its model has.";
  const CLAIM = { review: "yes", summary: "The enemy wears its armour in the game.", proof: "shots/enemy.png" };

  /** A web game with a close picture the lead names as proof, made before the Loop. */
  async function gameWithProof(prefix: string): Promise<string> {
    const { gameRepo } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir(prefix);
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await writeFile(path.join(dir, "shots/enemy.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await gameRepo(dir);
    return dir;
  }

  it("FC4. a Loop the person stopped after a no paused, and its card offered Keep building beside Resume: a pause carries no list", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const { reviewerAnswer } = await import("../helpers/reviewer.ts");
    const dir = await gameWithProof("stop-after-no-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ host, tool }) => {
          await tool("finish", CLAIM);
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    host.reviews.push(reviewerAnswer("no", [MET], "claude-code", [NOT_DONE]));
    const report = await host.start();
    assert.equal(report.executionStatus, "paused", "a Stop pauses the Loop for a Resume");
    assert.equal(report.stillToFix, undefined);
  });
});

/**
 * A resumed chat session whose game still has no kind keeps the question card its first brief named:
 * a session that remembers the engine question would otherwise call a tool it no longer has.
 */
describe("a resumed chat session on a game with no kind yet", () => {
  it("a resumed session was told to ask with ask_user on its first turn and lost the card on the next: it keeps the card while the game has no kind", async () => {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const unity = { plugin: "unity", name: "Unity", tool: "unity__new-game", makes: ["unity-project"] };
    const made = { name: "dodger", title: "Dodger", dir: "/games/dodger", shape: null, built: false, facts: [] };
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "make a game in godot" }],
        "game.contentStamp": () => ({ all: null, source: null }),
        "game.list": () => [made],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [unity] }),
        "engine.describe": () => [],
        "preview.ready": () => ({ ready: false }),
        "engine.delegate": () => ({
          ok: true,
          engine: "claude-code",
          turns: 1,
          usage: {},
          sessionId: "s",
          summary: "ok",
        }),
      },
    });
    const turn = { threadId: "t", turnId: "turn-2", text: "Godot is on now", engine: "claude-code", project: "dodger" };
    await runDelegatedTurn(
      recorder.ctx as never,
      { ...turn, engineLabel: "Claude Code", resume: "session-1" } as never,
    );
    const [delegated] = recorder.paramsOf("engine.delegate");
    const bridged = (delegated?.interviewTools as Array<{ name: string }> | undefined)?.map((tool) => tool.name) ?? [];
    assert.ok(bridged.includes("ask_user"), "the card is still there to call");
  });
});

describe("the language of Genex's own turns", () => {
  it("AL1. a resume or continue is Genex's own English words, and the agent answered a Russian chat in English: the context names the app's language as the fallback for a turn of Genex's", async () => {
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const russian = { tag: "ru", name: "Русский" };
    const context = chatContext({ folderLabel: "AI Games/x", appLanguage: russian });
    assert.match(context, /a line marked as Genex's rather than the user's[\s\S]*Русский \(ru\)/);
  });
});

describe("a new Loop a plugin held back before its first turn", () => {
  it("HS1. the Loop's start was held back (Unreal wouldn't reopen) and nobody acted until the person asked the chat to reopen it: the close says startHeld and the chat's agent is told once", async () => {
    const { heldStartAsk } = await import("../../src/main/core/held-start.ts");
    const { MessageOrigin } = await import("../../src/shared/protocol.ts");
    const record = (id: string, event_type: string, payload: Record<string, unknown>) => ({
      id,
      thread_id: "t1",
      turn_id: null,
      session_id: null,
      created_at: "2026-10-27T18:58:00.000Z",
      data: { type: "custom" as const, event_type, payload },
    });
    const person = { type: "user_message", threadId: "t1", text: "make it photoreal", engine: "claude-code" };
    const because = "The Loop didn't start: a plugin of this project held it back: Unreal couldn't be reopened.";
    const events = [
      record("1", "coordinator_message_queued", { messageId: "m1", action: person }),
      record("2", "run_finished", { runId: "r1", stoppedBecause: because, startHeld: true }),
    ];
    const ask = heldStartAsk("t1", events, "r1");
    assert.equal(ask?.options.origin, MessageOrigin.LoopHeld);
    assert.equal(ask?.options.engine, "claude-code");
    assert.ok(ask?.text.includes(because));
    const asked = { ...person, origin: MessageOrigin.LoopHeld };
    const again = [
      ...events,
      record("3", "coordinator_message_queued", { messageId: "m2", action: asked }),
      record("4", "run_finished", { runId: "r2", stoppedBecause: because, startHeld: true }),
    ];
    assert.equal(heldStartAsk("t1", again, "r2"), null, "held again: it waits for the person");
  });
});

describe("the lead and its workers are free agents (Loop phase 3)", () => {
  it("FL2. Blender went to one worker only, and a worker on an engine's project was told the editor was the lead's alone: a worker has every tool its lead has, its type only the kind of work", async () => {
    const { workerBrief } = await import("../../src/harness-seed/loop/workers/prompts.ts");
    const { workerTools } = await import("../../src/harness-seed/loop/workers/specs.ts");
    const { CoreFact } = await import("../../src/harness-seed/loop/folder-facts.ts");
    const blender = { pluginId: "blender", id: "blender_model", description: "Models one prop.", tools: ["blender__"] };
    const start = workerTools([{ ...blender, isolation: "copy" }] as never).find(
      (tool) => tool.name === "worker_start",
    );
    assert.match(String(start?.description), /with every plugin tool and connector you have/);
    const type = start?.parameters.properties.type;
    assert.doesNotMatch(String(type?.description), /brings that kind's tools/);
    const onUnreal = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [{ id: CoreFact.UnrealProject, path: "." }] as never },
      task: "restart the editor and play the gate",
      isolation: "copy" as never,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.doesNotMatch(onUnreal, /none of its tools|lead's alone/, "the editor's tools are a worker's too");
    assert.match(onUnreal, /use the editor's tools for what only it can do \(start or restart it/);
  });

  it("FL6. only Claude Code and Codex could lead in place or run workers: every engine that keeps a session (a local model's too) orchestrates alike; one with no session of its own does not", async () => {
    const { leadsInPlace } = await import("../../src/harness-seed/loop/engine-seat.ts");
    const { hasSessionRoles } = await import("../../src/harness-seed/loop/model-roles.ts");
    const rows: Array<[string, Record<string, unknown>, boolean]> = [
      ["a delegated agent", { kind: "delegated", supportsSessions: true }, true],
      ["a delegated agent that says nothing", { kind: "delegated" }, true],
      [
        "a local model's session (Bonsai, OpenRouter, a local server)",
        { kind: "direct", supportsSessions: true },
        true,
      ],
      ["a tool loop with no session (Ollama)", { kind: "direct" }, false],
      ["an agent that keeps no session", { kind: "delegated", supportsSessions: false }, false],
    ];
    for (const [label, descriptor, leads] of rows) assert.equal(leadsInPlace(descriptor), leads, label);
    // The chat's own session is handed the worker tools on each engine that keeps a session.
    for (const engine of ["claude-code", "codex", "bonsai", "openrouter", "local-server", "opencode"])
      assert.equal(hasSessionRoles(engine), true, engine);
    assert.equal(hasSessionRoles("ollama"), false);
  });
});

describe("the Loop's stop and nudge rules, audited after phase 5", () => {
  // Flipped: a lead whose turn ended with nothing running was asked once what next, and a second quiet
  // turn started the wrap-up (`WrapCause.Idle`); the phase 5 rules wake a lead on events only.
  // Flipped (no clock): the working time no longer wakes a resting lead (`WakeCause.WrapUp` at its
  // working deadline): with nothing unread and nobody waiting, nothing is due.
  it("PA1. a lead that ends a turn with nothing running rests: nothing asks it what next, and being quiet starts no wrap-up", async () => {
    const { afterTurn, nextWake, TurnEnd, WrapCause } = await import(
      "../../src/harness-seed/loop/director/wake-schedule.ts"
    );
    const quiet = { ok: true, closed: false, finishRequested: false };
    assert.equal(afterTurn(quiet).next, TurnEnd.Sleep, "the first quiet turn");
    assert.equal(afterTurn(quiet).next, TurnEnd.Sleep, "and every one after it");
    assert.equal(Object.values(WrapCause).includes("idle" as never), false, "no wrap-up is started by idleness");
    const resting = nextWake({ now: 1_000, untold: [], asleepSince: 1_000, personWaiting: false });
    assert.equal(resting, null, "no clock wakes it");
  });

  // Flipped: the lead's answer to a reviewer's no counted a row of no's ("2 of 3 in a row stop the Loop")
  // and told it the Loop "has time left, so it goes on"; no row stops a Loop, and a no is a second opinion.
  it("PA2. a reviewer's no reaches the lead as a second opinion that decides nothing, with no row of no's counted", async () => {
    const { finishAnswer } = await import("../../src/harness-seed/loop/finish-check.ts");
    const answer = finishAnswer({
      step: "rejected",
      reasons: ["the timer never shows"],
      notDone: ["the third lap"],
      done: [],
      rejections: 2,
      timeLeft: true,
    } as never);
    assert.match(answer, /decides nothing/);
    assert.match(answer, /the timer never shows/);
    assert.match(answer, /Not done: the third lap/);
    assert.doesNotMatch(answer, /in a row|stop the Loop|has time left|Say nothing to the person/);
  });
});

// Flipped (one Loop): GP1 checked the web Loop's merge and finish records (`integration_health`)
// naming their picture and worker; no Loop checks a merge now, and a web game's finish keeps no
// record of its one check. GP2 drove that check through the web lead; it is the health check's own.
describe("pictures of a Loop's builds (Loop phase 5)", () => {
  it("GP2. a build's health check said only in words what it found and loaded the page as Live does: Builds could not tell a blank build from a broken one, and a game could not know which load is the build's picture", async () => {
    const { checkHealth } = await import("../../src/harness-seed/loop/health-check.ts");
    const blank = "the page's frame is blank: one flat colour, nothing drawn";
    const rec = ctxRecorder({
      handlers: {
        [HostMethod.PreviewAcquire]: () => ({ handle: "pool:1" }),
        [HostMethod.PreviewLoad]: () => ({ ok: true }),
        [HostMethod.PreviewReady]: () => ({ ready: true }),
        [HostMethod.PreviewObserve]: () => ({ ok: false, reasons: [blank], findings: ["blank"] }),
        [HostMethod.PreviewScreenshot]: () => ({ path: "/runs/run_j/director/finish.jpg" }),
        [HostMethod.PreviewRelease]: () => true,
      },
    });
    const check = await checkHealth(
      rec.ctx as never,
      { project: "plaza", runId: "run_j", label: "director/finish" },
      { sleep: async () => {} },
    );
    assert.deepEqual(check.problems, [blank]);
    assert.deepEqual(check.findings, ["blank"], "the host's codes ride beside its words");
    const loads = rec.paramsOf(HostMethod.PreviewLoad);
    assert.equal(loads.length, 1, "one load, no second pass");
    assert.equal(loads[0]?.shot, true, "the load whose screenshot is the build's picture says so");
  });
});
describe("an engine app the chat finds not ready", () => {
  // Flipped: the agent was also told to get the app ready with its own tools before it used it.
  // Genex's line now says only the fact; what the agent does with it is its own.
  it("UR1. a chat that linked an Unreal project whose editor wasn't running ended with words asking the person to open it: the agent is told the reason, and only the reason", async () => {
    const { MOMENT_WORDS } = await import("../../src/plugins/unreal/hook-answers.ts");
    const { CoreFact } = await import("../../src/harness-seed/loop/folder-facts.ts");
    const { factsReadyNotice } = await import("../../src/harness-seed/loop/project-prompts.ts");
    const reason = MOMENT_WORDS.NotReady("WalkLab");
    assert.doesNotMatch(reason, /button|send a message/i, "where Unreal stands, never an errand for the person");
    const facts = [{ id: CoreFact.UnrealProject, path: "WalkLab", source: "link" }] as never;
    const notice = factsReadyNotice(facts, reason);
    assert.ok(notice.includes(reason), notice);
    assert.doesNotMatch(notice, /Get it ready|before you use it|Go on with/, "a fact, never an instruction");
    assert.doesNotMatch(factsReadyNotice(facts), /isn't ready/, "a ready app adds nothing");
  });
});

/**
 * A Unity chat's every resumed message reached the model with ~2.5K characters of Genex's rules
 * after the person's words, and its first with ~3.7K: the Loop, the workers, the checkpoint, the
 * Run button, where the work stays, the language. The person's words now go alone, as they wrote
 * them; Genex's context rides the session's system prompt, the same text on every turn while the
 * game is the same, so Claude Code's prompt cache keeps it.
 */
describe("the person's words reach the chat's own session as they wrote them (chat brief)", () => {
  const UNITY_GAME = {
    name: "keep",
    title: "Keep",
    dir: "/games/keep",
    shape: null,
    built: false,
    facts: [{ id: "unity-project", path: ".", source: "plugin:unity" }],
  };
  /** The chat's bookmark of its session, as an earlier turn left it in the log. */
  const bookmark = (sessionId: string) => ({
    data: {
      type: "custom",
      event_type: "contractor_session",
      payload: { project: "keep", engine: "claude-code", sessionId },
    },
  });
  const answered = { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "s1", summary: "ok" };

  /** One chat turn on the Unity game; what the builder was handed, each delegation in order. */
  async function chatTurn(
    text: string,
    options: {
      events?: unknown[];
      messages?: Array<{ role: string; content: string }>;
      delegate?: (params: Record<string, unknown>) => unknown;
    } = {},
  ) {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => options.messages ?? [{ role: "user", content: text }],
        "events.list": () => options.events ?? [],
        "game.list": () => [UNITY_GAME],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
        "engine.describe": () => [],
        "engine.delegate": options.delegate ?? (() => answered),
      },
    });
    await runDelegatedTurn(
      recorder.ctx as never,
      {
        threadId: "t1",
        turnId: "turn-1",
        text,
        engine: "claude-code",
        engineLabel: "Claude Code",
        project: "keep",
      } as never,
    );
    return { delegated: recorder.paramsOf("engine.delegate"), recorder };
  }

  it("CB-1. a Unity chat's first and resumed messages reached the model wrapped in Genex's rules: the words go alone, Genex's context in a system text the same on both turns", async () => {
    const first = (await chatTurn("Make a castle game")).delegated[0];
    const resumed = (
      await chatTurn("hdrp или urp?", {
        events: [bookmark("s1")],
        messages: [
          { role: "user", content: "Make a castle game" },
          { role: "assistant", content: "Built the keep." },
          { role: "user", content: "hdrp или urp?" },
        ],
      })
    ).delegated[0];
    assert.equal(first?.prompt, "Make a castle game", "the first message, as written");
    assert.equal(resumed?.prompt, "hdrp или urp?", "a resumed message, as written");
    assert.equal(resumed?.resume, "s1");
    assert.equal(first?.from, MessageFrom.Person, "the person wrote it");
    assert.match(String(first?.system), /inside Genex/, "Genex's context is the system text");
    // Flipped: the context named the Unity project; it never says what the folder holds now.
    assert.doesNotMatch(String(first?.system), /Unity project/);
    assert.equal(resumed?.system, first?.system, "byte-identical on every turn");
    for (const told of [/worker_start/, /checkpoint/, /stays in this workspace/, /can't run here/])
      assert.doesNotMatch(String(first?.system), told, `${told}: the tools say it, or nobody needs it`);
    assert.equal(resumed?.notices, undefined, "a resumed session is told nothing beside the words");
  });

  it("CB-2. a session that could not be resumed started afresh from a brief quoting the chat: it gets the same words, and the chat so far as one Genex notice", async () => {
    const { delegated } = await chatTurn("Add a moat", {
      events: [bookmark("gone")],
      messages: [
        { role: "user", content: "Make a castle game" },
        { role: "assistant", content: "Built the keep." },
        { role: "user", content: "Add a moat" },
      ],
      delegate: (params) => {
        if (params.resume) throw new Error("No conversation found with session ID: gone");
        return { ...answered, sessionId: "s2", summary: "Moat added." };
      },
    });
    assert.equal(delegated.length, 2, "the resume, then a new session");
    const [lost, fresh] = delegated;
    assert.equal(lost?.notices, undefined, "the resumed leg is told nothing beside the words");
    assert.equal(fresh?.resume, undefined, "a new session");
    assert.equal(fresh?.prompt, "Add a moat", "the same words, as written");
    assert.equal(fresh?.system, lost?.system, "the same system text");
    const [history, ...more] = (fresh?.notices as string[] | undefined) ?? [];
    assert.deepEqual(more, [], "one notice");
    assert.match(String(history), /user: Make a castle game/);
    assert.match(String(history), /assistant: Built the keep\./);
    assert.doesNotMatch(String(history), /user: Add a moat/, "the words it answers are its prompt, not its history");
  });

  it("CB-3. the Loop's lead continued the chat's own session with no Genex context: it sends the chat's own system text, so the session reads one", async () => {
    const { loopHost, gameRepo } = await import("../helpers/loop-host.ts");
    const { chatContext } = await import("../../src/harness-seed/loop/chat-session.ts");
    const { folderLabelOf } = await import("../../src/harness-seed/loop/workers/identity.ts");
    const dir = await tmpDir("lead-context-");
    await writeFile(path.join(dir, "project.godot"), "[application]\n");
    await gameRepo(dir);
    const host = loopHost({ dir, facts: [{ id: "godot-project", path: "." }], turns: [async () => undefined] });
    await host.start();
    const [lead] = host.leadCalls();
    assert.ok(lead, "the lead took a turn");
    const chat = chatContext({ folderLabel: folderLabelOf(dir, host.game.name), appLanguage: null });
    assert.equal(lead.system, chat, "the lead's system text is the chat's own");
  });
});
