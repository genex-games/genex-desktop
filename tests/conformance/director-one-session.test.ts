/**
 * One session through the real core and harness (loop/director/lead-session.ts): a waking run
 * launched from a chat is led by that chat's own contractor session — resumed in the game folder,
 * read-only, leading the integration worktree it reads — and the chat goes on in the same session
 * once the run closes, with its hands back and the run's controls (loop/after-loop-run.ts); with Loop
 * on it reopens a finished build — the same run, led by the same session (loop/reopen-run.ts). A
 * session that cannot be resumed is replaced by a fresh one told the brief, the chat so far and the
 * digest, and a merge conflict goes to a worker instead of the lead.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
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

/** The plan every scripted lead writes before its first worker, as a real one must. */
const plan = (ids: string[]) => ({
  summary: "This run: a dusk sky over the plaza.",
  workers: JSON.stringify(
    ids.map((id) => ({ id, title: id, seam: `the ${id}`, owns: "src/", done: [`${id} is there`], minutes: 5 })),
  ),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
});
const single = (id: string, owns: string) => ({
  id,
  title: id,
  brief: `Build the ${id}`,
  mode: "single",
  minutes: "5",
  owns,
});

/** What one delegation was for, read off the request the way the host hands it to an engine. */
const Kind = {
  Chat: "chat",
  Lead: "lead",
  Worker: "worker",
  Coordinator: "coordinator",
  Playtester: "playtester",
  FollowUp: "follow-up",
  /** The chat's own session after its run: the run's controls ride on its turn. */
  After: "after",
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];
function kindOf(request: DelegateRequest): Kind {
  if (request.director) return Kind.Lead;
  if (request.coordinator) return Kind.Coordinator;
  if (request.playtest) return Kind.Playtester;
  if (request.selfCapture?.runId) return Kind.Worker;
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
      const own = kind === Kind.Worker || kind === Kind.Coordinator || kind === Kind.Playtester;
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

/** A game with its chat, on a rig with windows to lend: two are the lead's, the rest its workers'. */
async function gameChat(name: string, windows = 3) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: windows, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
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
            await call("plan", plan(["sky"]));
            results.started = json(await call("worker_start", single("sky", "src/sky.js")));
            return;
          }
          const status = json(await call("run_status", {}));
          if (
            status.workers.some(
              (worker: { id: string; state: string }) => worker.id === "sky" && worker.state === "running",
            )
          )
            return;
          results.integrated = json(await call("integrate", { worker: "sky" }));
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
        assert.equal(turn.readOnly, true, "and writes nothing while the build runs");
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
      assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
      assert.ok(!/DIRECTOR\.md/.test(lead[0]!.prompt), "no memory file in its brief");
      assert.match(lead[0]!.prompt, /still this chat's own session/);
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
            await call("plan", plan(["sky"]));
            results.started = json(await call("worker_start", single("sky", "src/sky.js")));
            return;
          }
          const status = json(await call("run_status", {}));
          if (
            status.workers.some(
              (worker: { id: string; state: string }) => worker.id === "sky" && worker.state === "running",
            )
          )
            return;
          results.integrated = json(await call("integrate", { worker: "sky" }));
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
      assert.equal(results.started.started, "sky", JSON.stringify(results.started));
      assert.equal(results.workerSawSplit, true, "the worker forked from the lead's commit");
      assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
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
    const at = [
      "THE CHAT SO FAR",
      "make a dusk plaza with a fountain",
      "You are the DIRECTOR of run",
      "HOW THIS RUN WORKS",
    ].map((mark) => fresh.indexOf(mark));
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

describe("a merge conflict goes to a worker", () => {
  it("S3. integrate starts a worker from the integration branch with the merge open; the lead integrates it and lands both sides", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, project } = await gameChat("one-session-conflict", 4);
    const results: Record<string, any> = {};
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("plan", plan(["left", "right"]));
          await call("worker_start", single("left", "src/sign.js"));
          await call("worker_start", single("right", "src/sign.js"));
          return;
        }
        const status = JSON.parse(text(await call("worker_status", {}))) as Array<{ id: string; state: string }>;
        const ended = (id: string) => status.some((w) => w.id === id && w.state !== "running");
        if (!results.conflict && ended("left") && ended("right")) {
          results.left = json(await call("integrate", { worker: "left" }));
          results.conflict = json(await call("integrate", { worker: "right" }));
          return;
        }
        if (results.conflict && ended(results.conflict.resolving)) {
          results.resolved = json(await call("integrate", { worker: results.conflict.resolving }));
          results.finished = text(await call("finish", { summary: "both signs", land: "yes" }));
        }
        return;
      }
      if (kind !== Kind.Worker) return;
      const facet = request.selfCapture!.facetId!;
      const sign = path.join(request.cwd, "src", "sign.js");
      if (facet.startsWith("merge-")) {
        results.markers = await readFile(sign, "utf8");
        results.mergeHead = await git(request.cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "");
        await writeFile(sign, "export const sign = ['left', 'right'];\n");
        return;
      }
      await mkdir(path.dirname(sign), { recursive: true });
      await writeFile(sign, `export const sign = '${facet}';\n`);
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

    assert.equal(results.left.merged, true, JSON.stringify(results.left));
    assert.equal(results.conflict.merged, false, JSON.stringify(results.conflict));
    assert.deepEqual(results.conflict.conflict, ["src/sign.js"]);
    assert.equal(results.conflict.resolving, "merge-right", JSON.stringify(results.conflict));
    assert.match(results.markers, /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/, "the merge is open in its worktree");
    assert.match(results.mergeHead, /^[0-9a-f]{40}$/, "mid-merge, not a fresh fork");
    const briefed = requests.find((r) => r.request.selfCapture?.facetId === "merge-right")!.request;
    assert.match(briefed.prompt, /MERGE CONFLICT TO RESOLVE/);
    assert.equal(results.resolved.merged, true, JSON.stringify(results.resolved));
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(
      await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "export const sign = ['left', 'right'];\n",
    );
    const mergeCommit = (await git(project.dir, ["log", "--all", "--format=%P %s"]))
      .split("\n")
      .find((line) => line.includes("worker merge-right: Merge right"));
    assert.equal(mergeCommit?.split(" ").filter((part) => /^[0-9a-f]{40}$/.test(part)).length, 2, "a merge commit");
    for (const turn of requests.filter((r) => r.kind === Kind.Lead))
      assert.equal(turn.request.readOnly, true, "the lead's own hands never touched it");
  });
});

describe("a conflict worker that leaves conflict markers", () => {
  it("S4. commits nothing: the merge is aborted, the worker failed naming the files, and integrate refuses it", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, project } = await gameChat("one-session-markers", 4);
    const results: Record<string, any> = {};
    let leadTurns = 0;
    sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("plan", plan(["left", "right"]));
          await call("worker_start", single("left", "src/sign.js"));
          await call("worker_start", single("right", "src/sign.js"));
          return;
        }
        const status = JSON.parse(text(await call("worker_status", {}))) as Array<Record<string, any>>;
        const ended = (id: string) => status.some((w) => w.id === id && w.state !== "running");
        if (!results.conflict && ended("left") && ended("right")) {
          results.left = json(await call("integrate", { worker: "left" }));
          results.conflict = json(await call("integrate", { worker: "right" }));
          return;
        }
        if (results.conflict && ended(results.conflict.resolving)) {
          results.merger = status.find((w) => w.id === results.conflict.resolving);
          results.mergeHead = await git(results.mergerCwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(
            () => "",
          );
          results.refused = text(await call("integrate", { worker: results.conflict.resolving }));
          results.finished = text(await call("finish", { summary: "the left sign", land: "yes" }));
        }
        return;
      }
      if (kind !== Kind.Worker) return;
      const facet = request.selfCapture!.facetId!;
      const sign = path.join(request.cwd, "src", "sign.js");
      // The conflict worker stops without resolving anything: the markers stay in the file.
      if (facet.startsWith("merge-")) {
        results.mergerCwd = request.cwd;
        return;
      }
      await mkdir(path.dirname(sign), { recursive: true });
      await writeFile(sign, `export const sign = '${facet}';\n`);
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
    const finished = await loopRunClosed(rig, "the run whose conflict worker left markers");

    assert.equal(results.conflict.resolving, "merge-right", JSON.stringify(results.conflict));
    assert.equal(results.merger?.state, "failed", JSON.stringify(results.merger));
    assert.match(String(results.merger?.stoppedBecause ?? results.merger?.error), /src\/sign\.js/);
    assert.equal(results.mergeHead, "", "the merge in its worktree was aborted");
    assert.doesNotMatch(results.refused, /"merged":\s*true/, results.refused);
    assert.match(results.refused, /src\/sign\.js/, results.refused);
    const subjects = await git(project.dir, ["log", "--all", "--format=%s"]);
    assert.ok(!subjects.includes("worker merge-right"), `nothing of the conflict worker was committed:\n${subjects}`);
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'left';\n");
  });
});

describe("the studio's hands for a lead that writes nothing", () => {
  it("S5. what no worker made in the build it leads is set aside on a ref, a playtest of the game folder plays a copy of its commit, and each answer speaks to a lead", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
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
          await call("plan", plan(["sky"]));
          results.gameHead = await git(project.dir, ["rev-parse", "HEAD"]);
          results.playedLive = text(await call("playtest", { target: "live", ask: "does the plaza load?" }));
          // The user edits the game folder mid-build: a copy of its commit would not be what they see.
          await writeFile(path.join(project.dir, "mine.txt"), "the user's own edit\n");
          results.liveDirty = text(await call("playtest", { target: "live", ask: "does the plaza load?" }));
          await rm(path.join(project.dir, "mine.txt"));
          // A game that builds in place leaves files no worker made in the build the lead leads.
          await writeFile(path.join(root, "built.txt"), "made by a build\n");
          results.started = json(await call("worker_start", single("sky", "src/sky.js")));
          return;
        }
        const status = JSON.parse(text(await call("worker_status", {}))) as Array<{ id: string; state: string }>;
        if (results.merged || !status.some((w) => w.id === "sky" && w.state !== "running")) return;
        // A stray git cannot read: the studio cannot set it aside, and says so.
        const locked = path.join(root, "locked.txt");
        await writeFile(locked, "unreadable\n");
        await chmod(locked, 0o000);
        results.stuck = text(await call("integrate", { worker: "sky" }));
        await chmod(locked, 0o644);
        results.merged = json(await call("integrate", { worker: "sky" }));
        results.cleanAfter = await git(root, ["status", "--porcelain"]);
        results.finished = text(await call("finish", { summary: "a dusk sky", land: "yes" }));
        return;
      }
      if (kind === Kind.Playtester) {
        results.playCwd = await realpath(request.cwd);
        results.playHead = await git(request.cwd, ["rev-parse", "HEAD"]);
        return;
      }
      if (kind !== Kind.Worker) return;
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

    // The game folder is played from a worktree of its commit, never in place.
    assert.doesNotMatch(results.playedLive, /does not run|uncommitted/, results.playedLive);
    assert.ok(
      results.playCwd.includes(path.join("autopilot", runId, "play-")),
      `the playtester sat in a worktree of the run: ${results.playCwd}`,
    );
    assert.notEqual(results.playCwd, await realpath(project.dir));
    assert.equal(results.playHead, results.gameHead, "at the game folder's commit");
    assert.match(results.liveDirty, /the game folder has uncommitted changes/, results.liveDirty);
    assert.match(results.liveDirty, /playtest integration or a worker instead/);
    // What no worker made: told at worker_start in a lead's words, kept aside at integrate.
    assert.equal(results.started.started, "sky", JSON.stringify(results.started));
    assert.match(results.started.note, /no worker made/, results.started.note);
    assert.doesNotMatch(results.started.note, /commit first/);
    assert.match(results.stuck, /could not set them aside/, results.stuck);
    assert.doesNotMatch(results.stuck, /do not try to clear/);
    assert.equal(results.merged.merged, true, JSON.stringify(results.merged));
    const ref = /refs\/studio\/runs\/[^ ]+\/set-aside\/\d+/.exec(results.merged.setAside)?.[0];
    assert.ok(ref, results.merged.setAside);
    assert.match(results.merged.setAside, /built\.txt/);
    assert.equal(await git(project.dir, ["show", `${ref}:built.txt`]), "made by a build", "kept on the ref");
    assert.equal(results.cleanAfter, "", "and the worktree reset to the integration head");
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'dusk';\n");
    await assert.rejects(readFile(path.join(project.dir, "built.txt")), "what was set aside never landed");
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
          await call("plan", plan(["sky"]));
          await call("worker_start", single("sky", "src/sky.js"));
          return;
        }
        const status = JSON.parse(text(await call("worker_status", {}))) as Array<{ id: string; state: string }>;
        if (results.integrated || !status.some((w) => w.id === "sky" && w.state !== "running")) return;
        results.integrated = json(await call("integrate", { worker: "sky" }));
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
    // Loop off: nothing to record after a finished build — no reopen, no launch, no question.
    assert.deepEqual(
      afters.map((turn) => offeredTools(turn.request)),
      afters.map(() => []),
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
          await call("plan", plan(["moon"]));
          await call("worker_start", single("moon", "src/moon.js"));
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
    assert.deepEqual(results.offered, ["resume_run"], "a paused run can be resumed from the chat");
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
        await call("plan", plan(["moon"]));
        await call("worker_start", single("moon", "src/moon.js"));
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
 * A run that builds `id` with one worker and lands it, as S1 scripts it: its lead plans (on its
 * first run) and starts the worker, then integrates and finishes once the worker is done.
 */
function landingLoopRun(id: string, planned: boolean) {
  let turns = 0;
  let finished = false;
  return async (request: DelegateRequest): Promise<void> => {
    const call = liveCall(request);
    turns += 1;
    if (turns === 1) {
      if (!planned) await call("plan", plan([id]));
      await call("worker_start", single(id, `src/${id}.js`));
      return;
    }
    const status = JSON.parse(text(await call("worker_status", {}))) as Array<{ id: string; state: string }>;
    if (finished || !status.some((w) => w.id === id && w.state !== "running")) return;
    finished = true;
    await call("integrate", { worker: id });
    await call("finish", { summary: `the ${id}`, land: "yes" });
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

  it("S7b. 'continue with…' sent with Loop on after a paused run resumes it with the time it had left: the resume alone is offered, never a reopen or a launch", {
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
      { offered: [["resume_run"]], runs: 1, resumed: [false, true], workingTime: [86_400_000, 86_400_000] },
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
          await call("plan", plan(["sky"]));
          await call("worker_start", single("sky", "src/sky.js"));
          return;
        }
        await call("integrate", { worker: "sky" });
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
    const first = landingLoopRun("sky", false);
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
    let loopRun = landingLoopRun("sky", false);
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
    // The reopened run works to its ask (a goal commission): its lead plans for it first.
    loopRun = landingLoopRun("enemies", false);
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
  // The reopened run works to its ask (a goal commission, golden-boot-glory): its lead plans for it first.
  const loopRuns = [landingLoopRun("sky", false), landingLoopRun("enemies", false)];
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
    assert.match(opening, /THE BUILD GOES ON AT/);
    assert.match(opening, /THE USER SAYS[\s\S]*add enemies/);
    assert.ok(!seen.reopenedPrompts.some((p) => p.includes("old note")), "a steer from before the ask is not told");
    assert.equal(seen.workerHead, seen.folderHead, "the new worker forks from the game folder as it is now");
    assert.equal(seen.workerSky, "export const sky = 'pink';\n", "with the change made after the run");

    const second = customEvents(log, "run_finished")[1] ?? {};
    assert.equal(second.landed, true, String(second.stoppedBecause));
    assert.deepEqual(
      Object.keys(second.workers ?? {}).sort(),
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
    const first = landingLoopRun("sky", false);
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
    const first = landingLoopRun("sky", false);
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
