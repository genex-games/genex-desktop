/**
 * One session through the real core and harness (loop/director/lead-session.ts): a waking run
 * launched from a chat is led by that chat's own contractor session — resumed in the game folder,
 * building in the integration worktree it leads, never read-only — and the chat goes on in the same session
 * once the run closes, with its hands back and the run's controls (loop/after-loop-run.ts); with Loop
 * on it reopens a finished build — the same run, led by the same session (loop/reopen-run.ts). A
 * session that cannot be resumed is replaced by a fresh one told the brief, the chat so far and the
 * digest, and a worker's work that conflicts comes back to the lead, the merge undone.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { MessageOrigin } from "../../src/shared/protocol.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { gitFile } from "../helpers/git.ts";

/** No run here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
/**
 * How long the host's resume of a paused run is held back from the loop in the tests that hold
 * it: the chat's chance to take its next message, or the person's to press Stop, before the run
 * is under way again. The chat itself holds for up to after-loop-run.ts `RESUME_RESERVED_WITHIN_MS`.
 */
const RESUME_HELD_MS = 1_500;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();
const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

/** Reference stills guide appearance; omitting hours explicitly commissions goal completion. */
const FRAMES = [
  { data: Buffer.from("frame-one").toString("base64"), mimeType: "image/png", label: "dusk 1" },
  { data: Buffer.from("frame-two").toString("base64"), mimeType: "image/png", label: "dusk 2" },
];

/** A worker in its own copy of the integration branch, as a lead starts one: a title and its task. */
const copyWorker = (title: string) => ({ title, task: `Build the ${title}`, isolation: "copy" });

/** The id of the worker a start named (`Started w1 (copy).`). */
const startedId = (answer: string): string => /\bw\d+\b/.exec(answer)?.[0] ?? "";

/** Whether `run_status` says the worker `id` is still at work. */
const stillRunning = (status: Record<string, any>, id: string): boolean =>
  (status.workers as Array<{ id: string; state: string }>).some(
    (worker) => worker.id === id && worker.state === "running",
  );

/** What one delegation was for, read off the request the way the host hands it to an engine. */
const Kind = {
  Chat: "chat",
  Lead: "lead",
  Worker: "worker",
  Coordinator: "coordinator",
  FollowUp: "follow-up",
  /** The chat's own session after its run: the run's controls ride on its turn. */
  After: "after",
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];
function kindOf(request: DelegateRequest): Kind {
  if (request.director) return Kind.Lead;
  if (request.coordinator) return Kind.Coordinator;
  if (request.worker) return Kind.Worker;
  if (request.liveTools?.some((tool) => tool.name === "run_status")) return Kind.After;
  return request.interviewTools?.length ? Kind.Chat : Kind.FollowUp;
}

/**
 * A delegated engine that keeps each session's conversation the way a real one does: a resumed
 * session answers with its own id and remembers every turn it was given. What the script returns
 * joins the result (a bridged tool the session recorded, say).
 */
function sessionEngine(
  rig: Rig,
  id: string,
  script: (request: DelegateRequest, kind: Kind) => Promise<void | Partial<DelegateResult>>,
) {
  const histories = new Map<string, Kind[]>();
  const requests: Array<{ kind: Kind; request: DelegateRequest; sessionId?: string }> = [];
  let minted = 0;
  rig.core.engines.register({
    id,
    label: id,
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: id,
      stopReason: "stop",
    }),
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      const kind = kindOf(request);
      const asked: { kind: Kind; request: DelegateRequest; sessionId?: string } = { kind, request };
      requests.push(asked);
      const extra = (await script(request, kind)) ?? {};
      const sessionId = request.resume ?? `${kind}-${++minted}`;
      asked.sessionId = sessionId;
      const own = kind === Kind.Worker || kind === Kind.Coordinator;
      if (!own) histories.set(sessionId, [...(histories.get(sessionId) ?? []), kind]);
      return {
        ok: true,
        engine: id,
        turns: 1,
        usage: {},
        sessionId,
        summary: `${kind} done`,
        ...(kind === Kind.Chat
          ? { studioToolCalls: [{ name: "start_autopilot", args: { goal: "a dusk plaza", direction: "dusk" } }] }
          : {}),
        ...extra,
      };
    },
  } as never);
  return { histories, requests };
}

/**
 * A game with its chat, on a rig with windows to lend: two are the lead's, the rest its workers'.
 * The Genex plugin is off unless `cover` asks for it: with it on, every landed run is followed by
 * the cover step's turn (core/cover-step.ts), which only the cover's own row is about.
 */
async function gameChat(name: string, windows = 3, { cover = false } = {}) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: windows, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  await rig.core.plugins.setEnabled(GENEX_PLUGIN_ID, cover);
  const project = await rig.core.games.scaffold(name, { title: name });
  const threadId = await rig.core.threadForGame(project.name);
  return { rig, project, threadId };
}

/** The run the chat launched, once it closed. */
async function loopRunClosed(rig: Rig, label: string) {
  const events = await waitForLog(rig.core, (log) => customEvents(log, "run_finished").length >= 1, 150_000, label);
  return customEvents(events, "run_finished")[0]!;
}

/**
 * Send a message in the chat — on `engine`, or naming none — and wait until it is answered: the
 * `handled`th handled message of the thread.
 */
async function answered(
  rig: Rig,
  threadId: string,
  text: string,
  engine: string | null,
  handled: number,
  /** The composer's bubble id, which the host notes as the person's message (a rig send has none). */
  clientId?: string,
) {
  await rig.core.sendUserMessage(text, {
    thread: threadId,
    ...(engine ? { engine } : {}),
    ...(clientId ? { clientId } : {}),
  });
  return handledUpTo(rig, threadId, handled, text);
}

/** The Loop a message carries from the composer: its hours (none: ∞) and its pictures. */
type Loop = { hours?: number; frames?: typeof FRAMES };

/** Send a message with Loop on, on `engine`, and wait until it is answered: the `handled`th of the thread. */
async function answeredOnLoop(rig: Rig, threadId: string, text: string, engine: string, loop: Loop, handled: number) {
  await rig.core.sendUserMessage(text, { thread: threadId, engine, autopilot: loop });
  return handledUpTo(rig, threadId, handled, text);
}

/** The thread's log once it has handled `handled` messages, the last the answer to `text`. */
function handledUpTo(rig: Rig, threadId: string, handled: number, text: string) {
  return waitForLog(
    rig.core,
    (log) =>
      customEvents(
        log.filter((e) => e.thread_id === threadId),
        "coordinator_message_handled",
      ).length >= handled,
    60_000,
    `the chat's answer to "${text}"`,
  );
}

/** The live tools a request was handed, by name. */
const toolNames = (request: DelegateRequest): string[] => (request.liveTools ?? []).map((tool) => tool.name);

/** The studio tools a request was offered to record (bridged in), by name. */
const offeredTools = (request: DelegateRequest): string[] => (request.interviewTools ?? []).map((tool) => tool.name);

/**
 * Hold the host's resume of a paused run back from the loop until `release`, as a slow journal
 * read or a learning pass still being waited out would.
 */
function holdResumes(rig: Rig): { release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = rig.core.host.dispatch.bind(rig.core.host);
  rig.core.host.dispatch = (async (action, timeoutMs) => {
    if (action.type === "autopilot_resume") await held;
    return dispatch(action, timeoutMs);
  }) as typeof rig.core.host.dispatch;
  return { release };
}

/** The chat's bookmark in the thread's record: the session its next message resumes. */
async function chatBookmark(rig: Rig, threadId: string): Promise<string | undefined> {
  const record = await rig.core.store.getRecord(threadId);
  return (record.metadata as { contractor?: { sessionId?: string } } | undefined)?.contractor?.sessionId;
}

for (const engine of ["claude-code", "codex"]) {
  describe(`one session on ${engine}`, () => {
    it("S1. the chat's own session leads the run it launched, read-only in the game folder, and the chat goes on in it after the close", {
      timeout: RIG_TIMEOUT_MS,
    }, async () => {
      const { rig, project, threadId } = await gameChat(`one-session-${engine}`);
      const results: Record<string, any> = {};
      let leadTurns = 0;
      const { histories, requests } = sessionEngine(rig, engine, async (request, kind) => {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (kind === Kind.Lead) {
          leadTurns += 1;
          if (leadTurns === 1) {
            // It reads the build it leads by its full path; it writes nothing (the engine refuses).
            results.readable = await readFile(path.join(request.director!.root, "index.html"), "utf8").then(
              () => true,
              () => false,
            );
            results.started = text(await call("worker_start", copyWorker("sky")));
            return;
          }
          const id = startedId(results.started);
          if (stillRunning(json(await call("run_status", {})), id)) return;
          results.integrated = text(await call("worker_mark", { id, verdict: "used" }));
          results.finished = text(await call("finish", { summary: "a dusk sky", land: "yes" }));
          return;
        }
        if (kind === Kind.Worker) {
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
          return;
        }
        if (kind === Kind.After) results.status = json(await call("run_status", {}));
      });

      await rig.core.sendUserMessage("make a dusk plaza", {
        thread: threadId,
        engine,
        autopilot: { frames: FRAMES },
      });
      const finished = await loopRunClosed(rig, "the launched run's close");
      assert.equal(finished.landed, true, String(finished.stoppedBecause));

      const chat = requests.find((r) => r.kind === Kind.Chat)!.request;
      const lead = requests.filter((r) => r.kind === Kind.Lead).map((r) => r.request);
      assert.ok(lead.length >= 2, `${lead.length} lead turns`);
      const chatSession = histories.keys().next().value!;
      assert.equal(chatSession, requests.find((r) => r.kind === Kind.Chat)!.sessionId, "the chat's session came first");
      assert.equal(lead[0]!.resume, chatSession, "the lead resumes the chat's own session");
      for (const turn of lead) {
        assert.equal(await realpath(turn.cwd), await realpath(project.dir), "the lead sits in the game folder");
        // Flipped (Loop phase 3): the lead was read-only while the build ran; it builds in it now.
        assert.notEqual(turn.readOnly, true, "never read-only");
        assert.equal(turn.leadBuilds, turn.director?.root, "its box writes the build it leads");
        assert.equal(turn.resume, chatSession, "every turn is that one session");
      }
      assert.equal(await realpath(chat.cwd), await realpath(project.dir), "where the chat's session lives");
      const root = lead[0]!.director!.root;
      assert.ok(root.includes(path.join("autopilot")) && path.basename(root) === "integration", root);
      assert.ok(
        (lead[0]!.extraReads ?? []).some((dir) => root.startsWith(dir)),
        "the build it leads is readable",
      );
      assert.equal(results.readable, true, "and it reads it");
      assert.ok(
        (lead[0]!.liveTools ?? []).some((t) => t.name === "look"),
        "with its window on that build",
      );
      // Flipped (Loop phase 5): the lead merges a worker's copy with worker_mark used, no integrate.
      assert.match(results.integrated, /^Merged w1's work into your folder\. Health check: /, results.integrated);
      assert.ok(!/DIRECTOR\.md/.test(lead[0]!.prompt), "no memory file in its brief");
      // Flipped (Loop phase 5): the brief opens YOU LEAD THIS LOOP and says whose session it is.
      assert.match(lead[0]!.prompt, /You are this chat's own session, leading a Loop/);
      assert.equal(await chatBookmark(rig, threadId), chatSession, "the chat's bookmark is still its session");

      // The chat goes on after the close in that same session: a question is answered there, with
      // its hands back and the run's controls — no coordinator of its own, no builder follow-up.
      await answered(rig, threadId, "why dusk?", engine, 2);
      assert.deepEqual(
        requests.filter((r) => r.kind === Kind.Coordinator || r.kind === Kind.FollowUp).map((r) => r.kind),
        [],
        "no coordinator session opens, and no builder follow-up",
      );
      const after = requests.find((r) => r.kind === Kind.After)!.request;
      assert.equal(after.resume, chatSession, "answered by the same session");
      assert.equal(await realpath(after.cwd), await realpath(project.dir), "in the game folder");
      assert.notEqual(after.readOnly, true, "with its hands back");
      for (const tool of ["run_status", "show_build", "land_build"])
        assert.ok(toolNames(after).includes(tool), `${tool} in ${toolNames(after).join(", ")}`);
      assert.ok(
        !(after.interviewTools ?? []).some((tool) => tool.name === "resume_run"),
        "a finished run has nothing to resume",
      );
      assert.match(after.prompt, /why dusk\?/);
      assert.equal(results.status.run.state, "finished", JSON.stringify(results.status));
      assert.deepEqual(
        histories.get(chatSession),
        [Kind.Chat, ...lead.map(() => Kind.Lead), Kind.After],
        "one conversation: before the build, during it and after it",
      );
      assert.equal(histories.size, 1, `no other session of the chat: ${JSON.stringify([...histories.keys()])}`);
      assert.equal(await chatBookmark(rig, threadId), chatSession, "and the chat's bookmark stays on it");
    });

    it("S1c. with Genex on, the landed build's cover is asked of the same session right after the close, before the person's next message", {
      timeout: RIG_TIMEOUT_MS,
    }, async () => {
      const { rig, threadId } = await gameChat(`one-session-cover-${engine}`, 3, { cover: true });
      let leadTurns = 0;
      const { histories, requests } = sessionEngine(rig, engine, async (request, kind) => {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (kind === Kind.Lead) {
          leadTurns += 1;
          if (leadTurns === 1) {
            await call("worker_start", copyWorker("sky"));
            return;
          }
          if (stillRunning(json(await call("run_status", {})), "w1")) return;
          await call("worker_mark", { id: "w1", verdict: "used" });
          await call("finish", { summary: "a dusk sky", land: "yes" });
          return;
        }
        if (kind === Kind.Worker) {
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        }
      });

      await rig.core.sendUserMessage("make a dusk plaza", { thread: threadId, engine, autopilot: { frames: FRAMES } });
      const finished = await loopRunClosed(rig, "the launched run's close");
      assert.equal(finished.landed, true, String(finished.stoppedBecause));
      const log = await handledUpTo(rig, threadId, 2, "the cover step");
      const asks = customEvents(
        log.filter((e) => e.thread_id === threadId),
        "coordinator_message_queued",
      )
        .map((payload) => payload.action as { origin?: string; autopilot?: unknown } | undefined)
        .filter((action) => action?.origin === MessageOrigin.CoverStep);
      assert.equal(asks.length, 1, "one cover ask for the landed run");
      assert.equal(asks[0]?.autopilot, undefined, "sent without the person's Loop: it starts no build");

      await answered(rig, threadId, "why dusk?", engine, 3);
      const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId!;
      const afterClose = requests.filter((r) => r.kind === Kind.After);
      assert.equal(afterClose.length, 2, afterClose.map((r) => r.request.prompt.slice(0, 60)).join(" | "));
      assert.match(afterClose[0]!.request.prompt, /genex__skill \{"name":"cover"\}/, "the cover comes first");
      assert.match(afterClose[1]!.request.prompt, /why dusk\?/, "then the person's message");
      for (const turn of afterClose) assert.equal(turn.request.resume, chatSession, "both in the chat's own session");
      assert.equal(customEvents(log, "run_started").length, 1, "the cover step started no build");
      assert.equal(histories.size, 1, `no other session of the chat: ${JSON.stringify([...histories.keys()])}`);
    });

    it("S1b. the lead builds with its own hands: it commits a split in the integration worktree, a worker builds on that commit, and both land", {
      timeout: RIG_TIMEOUT_MS,
    }, async () => {
      const { rig, project, threadId } = await gameChat(`own-hands-${engine}`);
      const results: Record<string, any> = {};
      let leadTurns = 0;
      const { requests } = sessionEngine(rig, engine, async (request, kind) => {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (kind === Kind.Lead) {
          leadTurns += 1;
          const root = request.director!.root;
          if (leadTurns === 1) {
            // The foundation it lays itself: a module split, committed where the build is.
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src", "parts.js"), "export const parts = ['sky'];\n");
            await git(root, ["add", "-A"]);
            await git(root, ["commit", "-q", "-m", "lead: split the parts"]);
            results.leadCommit = await git(root, ["rev-parse", "HEAD"]);
            results.started = text(await call("worker_start", copyWorker("sky")));
            return;
          }
          const id = startedId(results.started);
          if (stillRunning(json(await call("run_status", {})), id)) return;
          results.integrated = text(await call("worker_mark", { id, verdict: "used" }));
          results.finished = text(await call("finish", { summary: "a dusk sky on the lead's parts", land: "yes" }));
          return;
        }
        if (kind === Kind.Worker) {
          results.workerSawSplit = await readFile(path.join(request.cwd, "src", "parts.js"), "utf8").then(
            () => true,
            () => false,
          );
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        }
      });

      await rig.core.sendUserMessage("make a dusk plaza", { thread: threadId, engine, autopilot: { frames: FRAMES } });
      const finished = await loopRunClosed(rig, "the own-hands run's close");
      assert.equal(finished.landed, true, String(finished.stoppedBecause));
      assert.ok(
        requests.some((r) => r.kind === Kind.Lead),
        "a lead led it",
      );
      assert.match(results.started, /^Started w1 \(copy\)/, results.started);
      assert.equal(results.workerSawSplit, true, "the worker forked from the lead's commit");
      assert.match(results.integrated, /^Merged w1's work into your folder/, results.integrated);
      const landed = await git(project.dir, ["rev-parse", "HEAD"]);
      await git(project.dir, ["merge-base", "--is-ancestor", results.leadCommit, landed]);
      assert.equal(
        await readFile(path.join(project.dir, "src", "parts.js"), "utf8"),
        "export const parts = ['sky'];\n",
      );
      assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'dusk';\n");
    });
  });
}

describe("a lead whose chat session cannot be resumed", () => {
  it("S2. starts fresh in the game folder with the chat so far, the brief and the digest, and becomes the chat's session", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, project, threadId } = await gameChat("one-session-lost");
    const prompts: string[] = [];
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind !== Kind.Lead) return;
      prompts.push(request.prompt);
      const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId;
      if (request.resume && request.resume === chatSession)
        throw new Error(`No conversation found with session ID: ${chatSession}`);
      leadTurns += 1;
      if (leadTurns === 1) await call("finish", { summary: "nothing to build this run", land: "no" });
    });

    await rig.core.sendUserMessage("make a dusk plaza with a fountain", {
      thread: threadId,
      engine,
      autopilot: { frames: FRAMES },
    });
    await loopRunClosed(rig, "the run's close");

    const lead = requests.filter((r) => r.kind === Kind.Lead).map((r) => r.request);
    assert.equal(
      lead[0]!.resume,
      requests.find((r) => r.kind === Kind.Chat)!.sessionId,
      "the chat's session is tried first",
    );
    assert.equal(lead[1]!.resume, undefined, "then a fresh one");
    assert.equal(await realpath(lead[1]!.cwd), await realpath(project.dir), "in the game folder too");
    const fresh = prompts[1]!;
    // Flipped (Loop phase 5): the brief says YOU LEAD THIS LOOP and THE GOAL, no DIRECTOR or HOW THIS RUN WORKS.
    const at = ["THE CHAT SO FAR", "make a dusk plaza with a fountain", "YOU LEAD THIS LOOP", "THE GOAL:"].map((mark) =>
      fresh.indexOf(mark),
    );
    assert.ok(
      at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)),
      `in order: ${JSON.stringify(at)}\n${fresh.slice(0, 2_000)}`,
    );
    // The fresh session's turn ends after the close it called: the chat's bookmark follows that
    // turn, so wait for it rather than read the bookmark the moment the run closed.
    const freshLead = () => requests.filter((r) => r.kind === Kind.Lead)[1]?.sessionId;
    await waitForLog(rig.core, () => Boolean(freshLead()), 15_000, "the fresh session's turn to end");
    const freshSession = freshLead();
    // The harness's view of the chat says the same (its bookmark follows the turn that answered).
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "contractor_session").some((e) => e.sessionId === freshSession),
      15_000,
      "the fresh session on the chat's bookmark",
    );
    assert.equal(await chatBookmark(rig, threadId), freshSession, "the chat goes on in the fresh session");
    const bookmarks = customEvents(events, "contractor_session").map((e) => e.sessionId);
    assert.equal(bookmarks.at(-1), freshSession, JSON.stringify(bookmarks));
  });
});

describe("a merge conflict comes back to the lead", () => {
  it("S3. worker_mark used on a copy that conflicts undoes the merge and names the files; the lead resolves it in its own folder and both sides land", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    // Flipped (Loop phase 5): no conflict worker is started from the merge; the lead hears the
    // conflict, the merge is undone, and it resolves the files itself (S4, the conflict worker that
    // left markers, went with it).
    const engine = "codex";
    const { rig, project } = await gameChat("one-session-conflict", 4);
    const results: Record<string, any> = {};
    let leadTurns = 0;
    sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("worker_start", copyWorker("left"));
          await call("worker_start", copyWorker("right"));
          return;
        }
        const status = json(await call("run_status", {}));
        if (results.finished || stillRunning(status, "w1") || stillRunning(status, "w2")) return;
        results.left = text(await call("worker_mark", { id: "w1", verdict: "used" }));
        results.conflict = text(await call("worker_mark", { id: "w2", verdict: "used" }));
        const root = request.director!.root;
        results.mergeHead = await git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "");
        results.statusAfter = await git(root, ["status", "--porcelain"]);
        // The lead fits both in with its own hands, commits, and sets the copy aside.
        await writeFile(path.join(root, "src", "sign.js"), "export const sign = ['left', 'right'];\n");
        await git(root, ["commit", "-qam", "lead: both signs"]);
        results.rejected = text(await call("worker_mark", { id: "w2", verdict: "rejected" }));
        results.finished = text(await call("finish", { summary: "both signs", land: "yes" }));
        return;
      }
      if (kind !== Kind.Worker) return;
      const sign = path.join(request.cwd, "src", "sign.js");
      await mkdir(path.dirname(sign), { recursive: true });
      await writeFile(sign, `export const sign = '${request.worker!.title}';\n`);
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "two signs",
        project: project.name,
        mode: "autopilot",
        engine,
        reference: { name: "signs", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      } as never)
      .catch(() => {});
    const finished = await loopRunClosed(rig, "the conflicted run's close");

    assert.match(results.left, /^Merged w1's work into your folder/, results.left);
    assert.match(
      results.conflict,
      /^Not merged: w2's work conflicts with yours in src\/sign\.js\. The merge was undone\./,
      results.conflict,
    );
    assert.equal(results.mergeHead, "", "no merge is left open in the lead's folder");
    assert.equal(results.statusAfter, "", "and nothing of it is left behind");
    assert.match(results.rejected, /^Rejected w2/, results.rejected);
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(
      await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "export const sign = ['left', 'right'];\n",
    );
  });
});

describe("the studio's hands beside a lead that builds", () => {
  it("S5. what the lead leaves uncommitted in the build it leads is committed as its work before a worker forks, merged with the worker's, and lands with the run", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    // Flipped (Loop phase 5): no playtest of the game folder (the playtest tool is gone), and a
    // merge no longer commits the lead's leftovers first or says it could not: worker_mark merges
    // over what the lead left, and the health check commits it as the lead's work.
    const engine = "codex";
    const { rig, project } = await gameChat("one-session-hands", 4);
    const results: Record<string, any> = {};
    let leadTurns = 0;
    sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        const root = request.director!.root;
        if (leadTurns === 1) {
          // A game that builds in place leaves files no worker made in the build the lead leads.
          await writeFile(path.join(root, "built.txt"), "made by a build\n");
          results.started = text(await call("worker_start", copyWorker("sky")));
          results.cleanAtStart = await git(root, ["status", "--porcelain"]);
          return;
        }
        if (results.merged || stillRunning(json(await call("run_status", {})), "w1")) return;
        await writeFile(path.join(root, "haze.txt"), "the lead's own edit\n");
        results.merged = text(await call("worker_mark", { id: "w1", verdict: "used" }));
        results.cleanAfter = await git(root, ["status", "--porcelain"]);
        results.finished = text(await call("finish", { summary: "a dusk sky", land: "yes" }));
        return;
      }
      if (kind !== Kind.Worker) return;
      results.workerSawBuilt = await readFile(path.join(request.cwd, "built.txt"), "utf8").catch(() => null);
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a dusk sky",
        project: project.name,
        mode: "autopilot",
        engine,
        reference: { name: "dusk", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      } as never)
      .catch(() => {});
    const finished = await loopRunClosed(rig, "the run whose lead the studio lent its hands");

    assert.match(results.started, /^Started w1 \(copy\)/, results.started);
    assert.equal(results.cleanAtStart, "", "the lead's work was committed before the fork");
    assert.equal(results.workerSawBuilt, "made by a build\n", "and the worker started from it");
    assert.match(results.merged, /^Merged w1's work into your folder/, results.merged);
    assert.equal(results.cleanAfter, "", "the health check committed the lead's own edit as its work");
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'dusk';\n");
    const landedWithIt = { "built.txt": "made by a build\n", "haze.txt": "the lead's own edit\n" };
    for (const [file, contents] of Object.entries(landedWithIt))
      assert.equal(await readFile(path.join(project.dir, file), "utf8"), contents, `${file} landed with the run`);
  });
});

describe("the same agent after the build", () => {
  it("S6. after a finished run the chat's own session shows the build, lands it, and makes a change in the game folder itself", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, project, threadId } = await gameChat("after-run-hands");
    const results: Record<string, any> = {};
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("worker_start", copyWorker("sky"));
          return;
        }
        if (results.integrated || stillRunning(json(await call("run_status", {})), "w1")) return;
        results.integrated = text(await call("worker_mark", { id: "w1", verdict: "used" }));
        // Left beside the game folder: the user lands it from the chat.
        results.finished = text(await call("finish", { summary: "a dusk sky", land: "no" }));
        return;
      }
      if (kind === Kind.Worker) {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        return;
      }
      if (kind !== Kind.After) return;
      if (request.prompt.includes("show me what you built")) {
        results.shown = text(await call("show_build", {}));
        results.folderWhenShown = await readFile(path.join(project.dir, "src", "sky.js"), "utf8").catch(() => null);
        return;
      }
      if (request.prompt.includes("put it in my game again")) {
        results.refused = await call("land_build", {}).then(text, (err: Error) => `refused: ${err.message}`);
        return;
      }
      if (request.prompt.includes("put it in my game")) {
        results.landed = await call("land_build", {}).then(text, (err: Error) => `refused: ${err.message}`);
        return;
      }
      if (request.prompt.includes("make the sky pink")) {
        results.pinkAt = await realpath(request.cwd);
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'pink';\n");
      }
    });

    await rig.core.sendUserMessage("make a dusk plaza", {
      thread: threadId,
      engine,
      autopilot: { frames: FRAMES },
    });
    const finished = await loopRunClosed(rig, "the run left beside the game folder");
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId;

    // Sent from the composer, so the host knows the person asked, and Live is out of their sight
    // (Builds in front): only then does Live change. While they watch it, Reload offers it instead.
    await rig.core.previewStageVisible(false);
    await answered(rig, threadId, "show me what you built", engine, 2, "msg_s6_show");
    assert.match(results.shown, /Live, on the right of the chat, now shows the run's build/, results.shown);
    assert.equal(results.folderWhenShown, null, "showing it left the game folder as it was");

    await answered(rig, threadId, "put it in my game", engine, 3, "msg_s6_land");
    assert.match(
      results.landed,
      /Landed [0-9a-f]{10} in the game folder \(merged\); Live now shows it/,
      results.landed,
    );
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'dusk';\n");

    await answered(rig, threadId, "make the sky pink", engine, 4);
    assert.equal(results.pinkAt, await realpath(project.dir), "the change is made in the game folder itself");
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'pink';\n");

    // Landing refuses a game folder with edits of its own, as it always has.
    await answered(rig, threadId, "put it in my game again", engine, 5);
    assert.match(results.refused, /^refused: .*uncommitted/, results.refused);
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'pink';\n");

    const afters = requests.filter((r) => r.kind === Kind.After);
    assert.equal(afters.length, 4, requests.map((r) => r.kind).join(", "));
    for (const turn of afters) {
      assert.equal(turn.request.resume, chatSession, "every answer is the chat's own session");
      assert.notEqual(turn.request.readOnly, true);
    }
    // Loop off after a finished build: no reopen and no question. Named flip: the start of a new
    // Loop, for one asked in words, is always held (it used to be no launch at all).
    assert.deepEqual(
      afters.map((turn) => offeredTools(turn.request)),
      afters.map(() => ["start_autopilot"]),
    );
    assert.deepEqual(
      requests.filter((r) => r.kind === Kind.Coordinator || r.kind === Kind.FollowUp).map((r) => r.kind),
      [],
      "no coordinator and no builder follow-up",
    );
    const log = await rig.core.store.listEvents(threadId);
    assert.equal(customEvents(log, "run_registered").length, 1, "no new run");
    assert.equal(customEvents(log, "run_followup_requested").length, 0, "nothing handed to a builder");
  });

  it("S7. after a paused run a question is answered in place, and 'continue with…' resumes the run with the same session as its lead", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-resume");
    const results: Record<string, any> = {};
    const leadPrompts: string[] = [];
    let workerStarted = false;
    const { requests, histories } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadPrompts.push(request.prompt);
        if (leadPrompts.length === 1) {
          await call("worker_start", copyWorker("moon"));
          return;
        }
        results.resumedFinish = text(await call("finish", { summary: "a red moon", land: "no" }));
        return;
      }
      if (kind === Kind.Worker) {
        // Building until the user stops the run.
        workerStarted = true;
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      if (kind !== Kind.After) return;
      results.offered = (request.interviewTools ?? []).map((tool) => tool.name);
      if (request.prompt.includes("is the moon red yet")) {
        results.status = json(await call("run_status", {}));
        return;
      }
      if (request.prompt.includes("continue with a red moon"))
        return { studioToolCalls: [{ name: "resume_run", args: { text: "continue with a red moon" } }] };
    });

    await rig.core.sendUserMessage("make a moonlit plaza", {
      thread: threadId,
      engine,
      autopilot: { frames: FRAMES },
    });
    await waitForLog(rig.core, () => workerStarted, 120_000, "the run's worker to start");
    await rig.core.stopThread(threadId);
    await waitForLog(rig.core, (log) => customEvents(log, "autopilot_paused").length >= 1, 60_000, "the paused run");
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId!;

    // A question alone never restarts the build.
    await answered(rig, threadId, "is the moon red yet?", engine, 2);
    assert.equal(results.status.run.state, "paused", JSON.stringify(results.status.run));
    // Named flip: a new Loop's start, for one asked in words, sits beside the resume.
    assert.deepEqual(results.offered, ["start_autopilot", "resume_run"], "a paused run can be resumed from the chat");
    let log = await rig.core.store.listEvents(threadId);
    assert.equal(customEvents(log, "run_registered").length, 1, "the question resumed nothing");
    assert.equal(leadPrompts.length, 1);

    // An instruction to go on resumes the run; its lead is this same session again.
    await answered(rig, threadId, "continue with a red moon", engine, 3);
    log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_finished").length >= 2,
      120_000,
      "the resumed run's close",
    );
    const leads = requests.filter((r) => r.kind === Kind.Lead);
    assert.equal(leads.length, 2, requests.map((r) => r.kind).join(", "));
    assert.equal(leads[1]!.request.resume, chatSession, "the resumed run's lead is the chat's own session");
    assert.match(leadPrompts[1]!, /THE USER SAYS[\s\S]*continue with a red moon/);
    assert.ok(
      customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      "the instruction is saved on the run before it resumes",
    );
    assert.equal(customEvents(log, "run_registered").length, 2, "the same run, registered again by its resume");
    assert.equal(new Set(customEvents(log, "run_registered").map((e) => e.runId)).size, 1, "never a second run");
    assert.deepEqual(
      requests.filter((r) => r.kind === Kind.Coordinator).map((r) => r.kind),
      [],
      "no coordinator session opens",
    );
    // The run closes inside the resumed lead's `finish` call: its turn returns just after.
    const whole = [Kind.Chat, Kind.Lead, Kind.After, Kind.After, Kind.Lead];
    for (let waited = 0; (histories.get(chatSession)?.length ?? 0) < whole.length && waited < 600; waited++)
      await sleep(25);
    assert.deepEqual(histories.get(chatSession), whole);
  });
});

/** A paused run's lead and worker, as S7 scripts them: the worker builds until Stop, the resumed lead finishes. */
function pausedLoopRun(leadPrompts: string[], started: { worker: boolean }) {
  return async (request: DelegateRequest, kind: Kind) => {
    const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
    if (kind === Kind.Lead) {
      leadPrompts.push(request.prompt);
      if (leadPrompts.length === 1) {
        await call("worker_start", copyWorker("moon"));
        return;
      }
      await call("finish", { summary: "a red moon", land: "no" });
      return;
    }
    if (kind === Kind.Worker) {
      started.worker = true;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
}

/** Launch a run from the chat and pause it with Stop once its worker builds. */
async function launchAndPause(rig: Rig, threadId: string, engine: string, started: { worker: boolean }) {
  await rig.core.sendUserMessage("make a moonlit plaza", {
    thread: threadId,
    engine,
    autopilot: { frames: FRAMES },
  });
  await waitForLog(rig.core, () => started.worker, 120_000, "the run's worker to start");
  await rig.core.stopThread(threadId);
  await waitForLog(rig.core, (log) => customEvents(log, "autopilot_paused").length >= 1, 60_000, "the paused run");
}

/** The resume the chat's own session records, as the session's result carries it. */
const recordedResume = (text: string) => ({ studioToolCalls: [{ name: "resume_run", args: { text } }] });

/** The live tools a scripted turn calls, as the host handed them over. */
function liveCall(request: DelegateRequest) {
  const onLiveTool = request.onLiveTool;
  if (!onLiveTool) throw new Error(`no live tools on this ${kindOf(request)} turn`);
  return (name: string, args: Record<string, unknown>) => onLiveTool(name, args);
}

/**
 * A run that builds `part` with one worker and lands it, as S1 scripts it: its lead starts the
 * worker, then merges its copy and finishes once the worker is done.
 */
function landingLoopRun(part: string, onStatus: (status: Record<string, any>) => void = () => {}) {
  let turns = 0;
  let finished = false;
  let worker = "";
  return async (request: DelegateRequest): Promise<void> => {
    const call = liveCall(request);
    turns += 1;
    if (turns === 1) {
      worker = startedId(text(await call("worker_start", copyWorker(part))));
      return;
    }
    const status = json(await call("run_status", {}));
    if (finished || stillRunning(status, worker)) return;
    onStatus(status);
    finished = true;
    await call("worker_mark", { id: worker, verdict: "used" });
    await call("finish", { summary: `the ${part}`, land: "yes" });
  };
}

/** A worker that writes its part: `src/<id>.js`. */
async function writePart(request: DelegateRequest, id: string): Promise<void> {
  await mkdir(path.join(request.cwd, "src"), { recursive: true });
  await writeFile(path.join(request.cwd, "src", `${id}.js`), `export const ${id} = true;\n`);
}

/** The dusk plaza the chat launches with Loop on, on `engine`, once its run has closed. */
async function launchedAndClosed(rig: Rig, threadId: string, engine: string) {
  await rig.core.sendUserMessage("make a dusk plaza", {
    thread: threadId,
    engine,
    autopilot: { hours: 1, frames: FRAMES },
  });
  return loopRunClosed(rig, "the launched run's close");
}

/** The log once `count` runs have closed. */
function loopRunsClosed(rig: Rig, count: number, label: string) {
  return waitForLog(rig.core, (events) => customEvents(events, "run_finished").length >= count, 150_000, label);
}

/** The working time a run was registered with. */
const workingTime = (registered: Record<string, unknown> | undefined): number | undefined =>
  (registered?.budgets as { wallClockMs?: number } | undefined)?.wallClockMs;

/** The kinds of this chat's turns no build of its own should open: a coordinator, a builder follow-up. */
const strangers = (requests: ReadonlyArray<{ kind: Kind }>): Kind[] =>
  requests.filter((r) => r.kind === Kind.Coordinator || r.kind === Kind.FollowUp).map((r) => r.kind);

describe("the same agent after the build: the resume it asks for, and the session it is", () => {
  it("S8. a message sent while the chat's own session asks to resume waits for the resumed run, never answered as after a paused run again; a reply that ended early resumes anyway, and says so", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-resuming");
    const leadPrompts: string[] = [];
    const started = { worker: false };
    const loopRun = pausedLoopRun(leadPrompts, started);
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind !== Kind.After) return loopRun(request, kind);
      if (!request.prompt.includes("continue with a red moon")) return;
      // The person sends another message while this reply is still being written; it reaches the
      // reply (the host interrupts it) and waits again once the reply ends.
      await rig.core.sendUserMessage("and make the moon big", { thread: threadId, engine });
      await Promise.race([
        new Promise((resolve) => request.signal?.addEventListener("abort", resolve, { once: true })),
        waitForLog(rig.core, () => false, 5_000).catch(() => null),
      ]);
      return {
        ...recordedResume("continue with a red moon"),
        ok: false,
        stopReason: "error",
        errorText: "the session hit its deadline",
      };
    });
    await launchAndPause(rig, threadId, engine, started);
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId!;

    const { release } = holdResumes(rig);
    await rig.core.sendUserMessage("continue with a red moon", { thread: threadId, engine });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      60_000,
      "the resume the chat asked for",
    );
    const answeredWhilePaused = () =>
      requests.filter(
        (r) =>
          r.kind === Kind.After &&
          r.request.prompt.includes("make the moon big") &&
          (r.request.interviewTools ?? []).some((tool) => tool.name === "resume_run"),
      );
    // Before the resumed run is under way again, the chat has every chance to take the message.
    await waitForLog(rig.core, () => answeredWhilePaused().length > 0, RESUME_HELD_MS).catch(() => null);
    release();

    let log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_finished").length >= 2,
      120_000,
      "the resumed run's close",
    );
    const bigId = customEvents(log, "coordinator_message_queued").find(
      (e) => (e.action as { text?: string } | undefined)?.text === "and make the moon big",
    )?.messageId;
    // It reaches the resumed run's lead, or is answered once that run has closed.
    log = await waitForLog(
      rig.core,
      (events) =>
        customEvents(events, "coordinator_message_handled").some((e) => e.messageId === bigId) ||
        customEvents(events, "coordinator_message_delivered").some((e) => e.messageId === bigId && e.how === "lead"),
      60_000,
      "the message sent during the resuming reply, settled",
    );
    const said = (await rig.core.store.listMessages(threadId)).map((m) => String(m.content ?? ""));
    assert.deepEqual(
      {
        answeredWhilePaused: answeredWhilePaused().length,
        toldItEndedEarly: said.some((m) =>
          /ended early \(error: the session hit its deadline\).*resuming it anyway/.test(m),
        ),
      },
      { answeredWhilePaused: 0, toldItEndedEarly: true },
    );
    const leads = requests.filter((r) => r.kind === Kind.Lead);
    assert.equal(leads.length, 2, requests.map((r) => r.kind).join(", "));
    assert.equal(leads[1]!.request.resume, chatSession, "the resumed run's lead is the chat's own session");
    assert.equal(customEvents(log, "run_registered").length, 2, "resumed once");
    assert.equal(new Set(customEvents(log, "run_registered").map((e) => e.runId)).size, 1, "never a second run");
  });

  it("S9. Stop after the resuming reply, before the run is under way again: it stays paused, and the chat is told", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-stopped-resume");
    const leadPrompts: string[] = [];
    const started = { worker: false };
    const loopRun = pausedLoopRun(leadPrompts, started);
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind !== Kind.After) return loopRun(request, kind);
      if (request.prompt.includes("continue with a red moon")) return recordedResume("continue with a red moon");
    });
    await launchAndPause(rig, threadId, engine, started);

    const { release } = holdResumes(rig);
    await rig.core.sendUserMessage("continue with a red moon", { thread: threadId, engine });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      60_000,
      "the resume the chat asked for",
    );
    await rig.core.stopThread(threadId);
    release();

    const notResumed = (events: Awaited<ReturnType<typeof rig.core.listAllEvents>>) =>
      events.some(
        (e) =>
          e.thread_id === threadId &&
          e.data.type === "error" &&
          /The build was not resumed: Stop came before it started again/.test(e.data.message),
      );
    const log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_registered").length >= 2 || notResumed(events),
      60_000,
      "the resume, started or held back",
    );
    assert.deepEqual(
      { registered: customEvents(log, "run_registered").length, told: notResumed(log) },
      { registered: 1, told: true },
      "the run did not start again after the Stop",
    );
    assert.equal(requests.filter((r) => r.kind === Kind.Lead).length, 1, "no lead turn after the Stop");
  });

  it("S7b. 'continue with…' sent with Loop on after a paused run resumes it with the time it had left: the resume is offered, never a reopen, and a new Loop's start only beside it", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-resume-on-loop");
    const leadPrompts: string[] = [];
    const started = { worker: false };
    const loopRun = pausedLoopRun(leadPrompts, started);
    const offered: string[][] = [];
    sessionEngine(rig, engine, async (request, kind) => {
      if (kind !== Kind.After) return loopRun(request, kind);
      offered.push(offeredTools(request));
      if (request.prompt.includes("continue with a red moon")) return recordedResume("continue with a red moon");
    });
    await launchAndPause(rig, threadId, engine, started);

    await answeredOnLoop(rig, threadId, "continue with a red moon", engine, { hours: 3 }, 2);
    const log = await loopRunsClosed(rig, 2, "the resumed run's close");
    const registered = customEvents(log, "run_registered");
    assert.deepEqual(
      {
        offered,
        runs: new Set(registered.map((e) => e.runId)).size,
        resumed: registered.map((e) => e.resumed),
        workingTime: registered.map(workingTime),
      },
      // The launch names no hours, so it is an ∞ build with its 24 h ceiling (origin/dev's launch).
      {
        offered: [["start_autopilot", "resume_run"]],
        runs: 1,
        resumed: [false, true],
        workingTime: [86_400_000, 86_400_000],
      },
      "the same run resumed on its own budget: the Loop's three hours are not a new one",
    );
    assert.match(leadPrompts[1] ?? "", /THE USER SAYS[\s\S]*continue with a red moon/);
  });

  it("S10. a message that names no engine goes on on the lead's engine, in the same session; one on another engine is the coordinator's", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-engines");
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("worker_start", copyWorker("sky"));
          return;
        }
        if (stillRunning(json(await call("run_status", {})), "w1")) return;
        await call("worker_mark", { id: "w1", verdict: "used" });
        await call("finish", { summary: "a dusk sky", land: "yes" });
        return;
      }
      if (kind === Kind.Worker) {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
      }
    });
    const other = sessionEngine(rig, "claude-code", async () => {});
    await rig.core.sendUserMessage("make a dusk plaza", {
      thread: threadId,
      engine,
      autopilot: { frames: FRAMES },
    });
    await loopRunClosed(rig, "the codex run's close");
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId;

    // No engine named: the lead's engine, its own session, with the run's controls.
    await answered(rig, threadId, "why dusk?", null, 2);
    const onTheLeadsEngine = requests
      .filter((r) => r.kind === Kind.After)
      .map((r) => ({ resume: r.request.resume, asked: r.request.prompt.includes("why dusk?") }));
    const elsewhereFirst = other.requests.map((r) => r.kind);
    // Another engine is another session: the coordinator answers there, and the lead's is not asked.
    await answered(rig, threadId, "and why a plaza?", "claude-code", 3);
    assert.deepEqual(
      {
        onTheLeadsEngine,
        elsewhereFirst,
        onAnotherEngine: other.requests.map((r) => r.kind),
        leadsSessionAsked: requests.filter((r) => r.kind === Kind.After).length,
      },
      {
        onTheLeadsEngine: [{ resume: chatSession, asked: true }],
        elsewhereFirst: [],
        onAnotherEngine: [Kind.Coordinator],
        leadsSessionAsked: 1,
      },
    );
  });

  it("S10b. a message with Loop on another engine after the build is still the coordinator's: nothing to record, nothing reopens", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-engines-on-loop");
    const first = landingLoopRun("sky");
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead) return first(request);
      if (kind === Kind.Worker) return writePart(request, "sky");
    });
    const other = sessionEngine(rig, "claude-code", async () => {});
    await launchedAndClosed(rig, threadId, engine);

    const log = await answeredOnLoop(rig, threadId, "add enemies", "claude-code", { hours: 2 }, 2);
    assert.deepEqual(
      {
        onAnotherEngine: other.requests.map((r) => ({ kind: r.kind, tools: r.request.interviewTools ?? [] })),
        leadsSessionAsked: requests.filter((r) => r.kind === Kind.After).length,
        steered: customEvents(log, "run_steering").length,
        registered: customEvents(log, "run_registered").length,
      },
      {
        onAnotherEngine: [{ kind: Kind.Coordinator, tools: [] }],
        leadsSessionAsked: 0,
        steered: 0,
        registered: 1,
      },
    );
  });

  it("S10c. a message with Loop 2 h on another engine asking for more: the coordinator continues the build, and the same run reopens with the Loop's time, led by the chat's session on the build's engine", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-coordinator-reopens");
    let loopRun = landingLoopRun("sky");
    let part = "sky";
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead) return loopRun(request);
      if (kind === Kind.Worker) return writePart(request, part);
    });
    const other = sessionEngine(rig, "claude-code", async (request, kind) => {
      if (kind === Kind.Coordinator) await liveCall(request)("continue_build", { text: "add enemies to the plaza" });
    });
    await launchedAndClosed(rig, threadId, engine);
    const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId;
    const leadsBefore = requests.filter((r) => r.kind === Kind.Lead).length;
    // The reopened run works to its ask: its lead starts a worker for it.
    loopRun = landingLoopRun("enemies");
    part = "enemies";

    await answeredOnLoop(rig, threadId, "add enemies", "claude-code", { hours: 2 }, 2);
    const log = await loopRunsClosed(rig, 2, "the reopened run's close");
    const registered = customEvents(log, "run_registered");
    const reopenedLead = requests.filter((r) => r.kind === Kind.Lead)[leadsBefore];
    /** The model a registration planned on. */
    const plannerOf = (e: Record<string, unknown> | undefined) =>
      (e?.roles as { planner?: string } | undefined)?.planner;
    assert.deepEqual(
      {
        onAnotherEngine: other.requests.map((r) => r.kind),
        runs: new Set(registered.map((e) => e.runId)).size,
        resumed: registered.map((e) => e.resumed),
        workingTime: registered.map(workingTime),
        planner: registered.map(plannerOf),
        asked: customEvents(log, "run_steering").map((e) => e.text),
        leadResumes: reopenedLead?.request.resume,
      },
      {
        onAnotherEngine: [Kind.Coordinator],
        runs: 1,
        resumed: [false, true],
        workingTime: [3_600_000, 7_200_000],
        planner: [plannerOf(registered[0]), plannerOf(registered[0])],
        asked: ["add enemies to the plaza"],
        leadResumes: chatSession,
      },
      "no builder turn on the other engine: the same build goes on, on its own engine and models",
    );
    assert.match(String(other.requests[0]?.request.prompt), /Loop is on/);
  });
});

/** The reopen the chat's own session records, as the session's result carries it. */
const recordedReopen = (text: string) => ({ studioToolCalls: [{ name: "reopen_run", args: { text } }] });

/** What the chat's own session is offered with Loop on after a finished build it led: the reopen, a start over, a question. */
const REOPEN_OFFERED = ["reopen_run", "start_autopilot", "ask_user"];

/** What S11 saw from inside its sessions: the offer, and where the reopened run stood. */
interface ReopenSeen {
  offered?: string[];
  /** The game folder's HEAD when the reopened run's lead first woke: its starting point. */
  folderHead?: string;
  /** The reopened run's worker: the commit it started on, and the sky it found there. */
  workerHead?: string;
  workerSky?: string;
  /** Every prompt the reopened run's lead was given. */
  reopenedPrompts: string[];
  /** The workers the reopened run's lead read in its status before it finished. */
  reopenedWorkers?: string[];
}

/** The reopened run's lead, seen: every prompt it is given, and the game folder's HEAD when it first wakes. */
async function seeReopenedLead(gameDir: string, request: DelegateRequest, seen: ReopenSeen): Promise<void> {
  seen.reopenedPrompts.push(request.prompt);
  // The reopened run took its starting point before its lead's first turn.
  seen.folderHead ??= await git(gameDir, ["rev-parse", "HEAD"]);
}

/** The reopened run's worker, seen: the commit it starts on, and the sky it finds there. */
async function seeReopenedWorker(request: DelegateRequest, seen: ReopenSeen): Promise<void> {
  seen.workerHead = await git(request.cwd, ["rev-parse", "HEAD"]);
  seen.workerSky = await readFile(path.join(request.cwd, "src", "sky.js"), "utf8");
}

/**
 * S11's sessions: a run that lands the sky; the chat after it, which paints the sky pink itself and
 * then records the reopen for enemies; and the run reopened, which builds them.
 */
function reopenedLoopRuns(gameDir: string, seen: ReopenSeen) {
  // The reopened run works to its ask: its lead starts a worker for it.
  const loopRuns = [
    landingLoopRun("sky"),
    landingLoopRun("enemies", (status) => {
      seen.reopenedWorkers = (status.workers as Array<{ title: string }>).map((worker) => worker.title);
    }),
  ];
  let loopRun = 0;
  const chatAfter = async (request: DelegateRequest) => {
    if (request.prompt.includes("add enemies")) {
      seen.offered = offeredTools(request);
      loopRun = 1;
      return recordedReopen("add enemies");
    }
    if (request.prompt.includes("make the sky pink"))
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'pink';\n");
  };
  return async (request: DelegateRequest, kind: Kind) => {
    const reopened = loopRun === 1;
    if (kind === Kind.Lead) {
      if (reopened) await seeReopenedLead(gameDir, request, seen);
      return loopRuns[loopRun]?.(request);
    }
    if (kind === Kind.Worker) {
      if (reopened) await seeReopenedWorker(request, seen);
      return writePart(request, reopened ? "enemies" : "sky");
    }
    if (kind === Kind.After) return chatAfter(request);
  };
}

/** A steer left on a run after its close, as a Stop can leave one: nobody asked the next run for it. */
async function leaveStaleSteer(rig: Rig, threadId: string, runId: unknown, words: string): Promise<void> {
  await rig.core.store.appendEvents(threadId, [
    { type: "custom", event_type: "run_steering", payload: { runId, text: words, at: new Date().toISOString() } },
  ]);
}

describe("the same agent after the build: a finished build reopened with Loop on", () => {
  it("S11. an ask for more with Loop 2 h reopens the same run with a fresh budget, led by the same session, hearing the chat from the ask on and forking from the game folder as it is now", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, project, threadId } = await gameChat("after-run-reopen");
    const seen: ReopenSeen = { reopenedPrompts: [] };
    const { requests, histories } = sessionEngine(rig, engine, reopenedLoopRuns(project.dir, seen));
    const first = await launchedAndClosed(rig, threadId, engine);
    assert.equal(first.landed, true, String(first.stoppedBecause));
    const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId ?? "";
    const firstLeads = requests.filter((r) => r.kind === Kind.Lead).length;

    // Loop off: the session makes the change in the game folder itself, and nothing reopens.
    await answered(rig, threadId, "make the sky pink", engine, 2);
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'pink';\n");
    await leaveStaleSteer(rig, threadId, first.runId, "old note");

    await answeredOnLoop(rig, threadId, "add enemies", engine, { hours: 2 }, 3);
    assert.deepEqual(seen.offered, REOPEN_OFFERED, "the reopen is offered first");
    const log = await loopRunsClosed(rig, 2, "the reopened run's close");
    const registered = customEvents(log, "run_registered");
    assert.deepEqual(
      {
        runs: [...new Set(registered.map((e) => e.runId))],
        resumed: registered.map((e) => e.resumed),
        workingTime: registered.map(workingTime),
        asked: customEvents(log, "run_steering").some((e) => e.runId === first.runId && e.text === "add enemies"),
      },
      { runs: [first.runId], resumed: [false, true], workingTime: [3_600_000, 7_200_000], asked: true },
      "the same run registered again, with the Loop's two hours and the ask saved on it",
    );

    const leads = requests.filter((r) => r.kind === Kind.Lead);
    assert.equal(leads.at(-1)?.request.resume, chatSession, "the reopened run's lead is the chat's own session");
    const [opening = ""] = seen.reopenedPrompts;
    // Flipped (Loop phase 5): the reopen is said in the brief, no THE BUILD GOES ON AT heading.
    assert.match(opening, /the same run goes on with a fresh working budget from the game folder as it is now/);
    assert.match(opening, /THE USER SAYS[\s\S]*add enemies/);
    assert.ok(!seen.reopenedPrompts.some((p) => p.includes("old note")), "a steer from before the ask is not told");
    assert.equal(seen.workerHead, seen.folderHead, "the new worker forks from the game folder as it is now");
    assert.equal(seen.workerSky, "export const sky = 'pink';\n", "with the change made after the run");

    const second = customEvents(log, "run_finished")[1] ?? {};
    assert.equal(second.landed, true, String(second.stoppedBecause));
    // Flipped (Loop phase 5): the run's workers are its pool's records, read in run_status, not the report's.
    assert.deepEqual(
      [...(seen.reopenedWorkers ?? [])].sort(),
      ["enemies", "sky"],
      "the reopened run's record keeps the finished run's workers",
    );
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'pink';\n");
    assert.equal(await readFile(path.join(project.dir, "src", "enemies.js"), "utf8"), "export const enemies = true;\n");
    assert.deepEqual(strangers(requests), [], "no coordinator and no builder follow-up");
    const leadsAgain = leads.length - firstLeads;
    const whole = [
      Kind.Chat,
      ...Array.from({ length: firstLeads }, () => Kind.Lead),
      Kind.After,
      Kind.After,
      ...Array.from({ length: leadsAgain }, () => Kind.Lead),
    ];
    // The run closes inside the last lead's `finish` call: its turn returns just after.
    for (let waited = 0; (histories.get(chatSession)?.length ?? 0) < whole.length && waited < 600; waited++)
      await sleep(25);
    assert.deepEqual(
      histories.get(chatSession),
      whole,
      "one conversation: the build, the chat after it, and the build again",
    );
    assert.equal(histories.size, 1, `no other session of the chat: ${JSON.stringify([...histories.keys()])}`);
  });
});

describe("the same agent after the build: a start over or a question with Loop on", () => {
  it("S12. an explicit start over with Loop on launches a new build: another run, never the finished one reopened", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-start-over");
    const first = landingLoopRun("sky");
    let offered: string[] | null = null;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead && offered) {
        await liveCall(request)("finish", { summary: "a neon city", land: "no" });
        return;
      }
      if (kind === Kind.Lead) return first(request);
      if (kind === Kind.Worker) return writePart(request, "sky");
      if (kind !== Kind.After || !request.prompt.includes("start over")) return;
      offered = offeredTools(request);
      return { studioToolCalls: [{ name: "start_autopilot", args: { goal: "a neon city", direction: "neon" } }] };
    });
    await launchedAndClosed(rig, threadId, engine);

    await answeredOnLoop(rig, threadId, "start over, a neon city", engine, { hours: 1, frames: FRAMES }, 2);
    assert.deepEqual(offered, REOPEN_OFFERED);
    const log = await loopRunsClosed(rig, 2, "the new build's close");
    const registered = customEvents(log, "run_registered");
    assert.deepEqual(
      {
        runs: new Set(registered.map((e) => e.runId)).size,
        goals: registered.map((e) => e.goal),
        resumed: registered.map((e) => e.resumed),
      },
      { runs: 2, goals: ["a dusk plaza", "a neon city"], resumed: [false, false] },
      "a new run of its own, started afresh",
    );
    assert.deepEqual(strangers(requests), []);
  });

  it("S13. a question with Loop on is answered, the reopen offered and not taken: nothing starts again", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-question-on-loop");
    const first = landingLoopRun("sky");
    let offered: string[] | null = null;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead) return first(request);
      if (kind === Kind.Worker) return writePart(request, "sky");
      if (kind === Kind.After) offered = offeredTools(request);
    });
    await launchedAndClosed(rig, threadId, engine);
    const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId;

    const log = await answeredOnLoop(rig, threadId, "why dusk?", engine, { hours: 2 }, 2);
    assert.deepEqual(
      {
        offered,
        answeredBy: requests.filter((r) => r.kind === Kind.After).map((r) => r.request.resume),
        // A reopen saves the ask on the run before the message is handled; its start follows.
        steered: customEvents(log, "run_steering").length,
        registered: customEvents(log, "run_registered").length,
        leads: requests.filter((r) => r.kind === Kind.Lead && r.request.prompt.includes("why dusk?")).length,
      },
      { offered: REOPEN_OFFERED, answeredBy: [chatSession], steered: 0, registered: 1, leads: 0 },
      "answered by the chat's own session, and the build stays finished",
    );
  });
});
