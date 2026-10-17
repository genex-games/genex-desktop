/**
 * A Loop's reviewer as the host seats it (`HarnessDelegateParams.reviewer`): read-only, in a home of
 * its own in a folder no box writes, reading the lead's folder and the run's captures, looking at app windows
 * with `app_look` and nothing else. Honoured only for a run of this game reading the game's folder
 * or its own copy in the run's folder; anything else is refused before an engine starts. Real core,
 * fake engines that record each request (`worker-chat.ts`), no harness.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runDir } from "../../src/main/core/run-shots.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { APP_LOOK_TOOL_NAME } from "../../src/shared/jobs.ts";
import { type ScreenAccess, ScreenAccessState, stubAppLook } from "../../src/substrate/app-look.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { gitFile } from "../helpers/git.ts";
import { CLAUDE, CODEX, closeWorkerChats, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

after(closeWorkerChats);

/** A case that would hang on a regression fails within this instead. */
const CASE_TIMEOUT_MS = 60_000;

/** The names of the tools a session was handed. */
const toolsOf = (request: DelegateRequest | undefined) => (request?.liveTools ?? []).map((tool) => tool.name).sort();

/** What a Loop's harness asks for a reviewer of `runId` reading `reads`. */
const reviewerAsk = (reads: string, runId = RUN_ID, extra: Record<string, unknown> = {}) => ({
  readOnly: true,
  reviewer: { runId, reads },
  toolAllow: [],
  ...extra,
});

describe("a Loop's reviewer", () => {
  it("a reviewer of a run of this game reads the lead's folder from a home of its own, read-only, looking with app_look only", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, seen, delegate, copyOf } = await workerChat();
    const homes = await realpath(core.layout.reviewers);
    const game = await realpath(project.dir);
    const copy = await realpath(await copyOf(RUN_ID, "integration"));
    for (const [label, reads, engine] of [
      ["the game's folder", project.dir, undefined],
      ["the run's own copy", copy, undefined],
      ["the game's folder, on Codex", project.dir, CODEX],
    ] as const) {
      await delegate(reviewerAsk(reads), engine);
      const request = seen.at(-1);
      assert.ok(request, `${label}: the engine was asked`);
      assert.ok(request.cwd.startsWith(`${homes}${path.sep}`), `${label}: a home of the host's own: ${request.cwd}`);
      assert.equal(path.basename(path.dirname(request.cwd)), engine ?? "claude-code", `${label}: one per engine`);
      assert.equal(request.readOnly, true, `${label}: read-only`);
      const real = reads === project.dir ? game : copy;
      // The host makes the run's captures folder so it can be read.
      const captures = await realpath(runDir(core.layout.runs, RUN_ID));
      assert.deepEqual(request.extraReads, [real, captures], `${label}: the lead's folder and the run's captures`);
      assert.deepEqual(toolsOf(request), [APP_LOOK_TOOL_NAME], `${label}: app_look and nothing else`);
      // Read-only with nobody answering: Claude Code takes away its edits, shell and sub-agents.
      assert.equal(request.leadAsks, undefined, `${label}: nobody asks`);
      assert.equal(request.permissions, undefined, `${label}: not the chat's own session`);
      assert.equal(request.worker, undefined, `${label}: no worker's seat`);
      assert.ok(request.denyReads?.length, `${label}: the unattended fence`);
    }
    const runHomes = new Set(seen.map((request) => path.dirname(path.dirname(request.cwd))));
    assert.equal(runHomes.size, 1, "the same run's reviewers share one home");
  });

  it("a reviewer is fenced off the rest of Genex's data: other runs' folders and captures, jobs, chats' homes, exports", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, seen, delegate, copyOf } = await workerChat();
    const { exports, jobs, runs, scratch } = core.layout;
    const others = [
      path.join(scratch, "autopilot", "run_other", "integration"),
      path.join(runs, "run_other"),
      path.join(scratch, "coordinators", "abc"),
      path.join(jobs, "some-game"),
      exports,
    ];
    for (const dir of others) await mkdir(dir, { recursive: true });
    const copy = await realpath(await copyOf(RUN_ID, "integration"));
    for (const reads of [project.dir, copy]) {
      await delegate(reviewerAsk(reads));
      const request = seen.at(-1);
      const denied = request?.denyReads ?? [];
      for (const fenced of [
        path.join(scratch, "autopilot", "run_other"),
        path.join(runs, "run_other"),
        path.join(scratch, "coordinators"),
        jobs,
        exports,
      ]) {
        const real = await realpath(fenced);
        assert.ok(denied.includes(real), `${reads}: ${real} is denied: ${denied.join(", ")}`);
      }
      for (const read of request?.extraReads ?? []) {
        assert.ok(
          !denied.some((dir) => read === dir || read.startsWith(dir + path.sep)),
          `${reads}: what it reads stays readable (${read})`,
        );
      }
    }
  });

  it("each call starts in an empty home of its own, with no project settings even for a trusted game", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, seen, delegate } = await workerChat();
    await core.games.adopt(project.dir, { trustProjectSettings: true });
    await delegate(reviewerAsk(project.dir));
    const first = seen.at(-1);
    assert.ok(first);
    assert.notEqual(first.trustedProjectSettings, true, "a reviewer's home loads no project settings");
    // Something plants a settings file in that home.
    await mkdir(path.join(first.cwd, ".claude"), { recursive: true });
    await writeFile(path.join(first.cwd, ".claude", "settings.json"), '{"hooks":{}}');
    await delegate(reviewerAsk(project.dir));
    const second = seen.at(-1);
    assert.ok(second && second.cwd !== first.cwd, "a new home");
    assert.deepEqual(await readdir(second.cwd), [], "empty");
    assert.equal(
      await stat(first.cwd).then(
        () => true,
        () => false,
      ),
      false,
      "the earlier home is gone",
    );
  });

  it("a reviewer's home sits where no box writes, and a link planted on its way is never followed", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, other, seen, delegate } = await workerChat();
    const scratch = await realpath(core.layout.scratch);
    const homes = await realpath(core.layout.reviewers);
    const games = path.dirname(await realpath(project.dir));
    const hash = createHash("sha256").update(RUN_ID).digest("hex").slice(0, 24);
    const listing = async () => (await readdir(games, { recursive: true })).sort();
    // A box writes scratch: what it plants where the homes once sat is never followed.
    for (const at of [["reviewers"], ["reviewers", hash], ["reviewers", hash, "claude-code"]]) {
      const planted = path.join(scratch, ...at);
      await rm(path.join(scratch, "reviewers"), { recursive: true, force: true });
      await mkdir(path.dirname(planted), { recursive: true });
      await symlink(games, planted);
      const before = await listing();
      await delegate(reviewerAsk(project.dir));
      const request = seen.at(-1);
      assert.ok(request, at.join("/"));
      const real = await realpath(request.cwd);
      assert.ok(real.startsWith(homes + path.sep), `${at.join("/")}: a home in the host's own folder: ${real}`);
      assert.ok(!real.startsWith(scratch + path.sep), `${at.join("/")}: not under scratch`);
      assert.deepEqual(await listing(), before, `${at.join("/")}: nothing made or removed in the games folder`);
      assert.ok(
        request.denyReads?.some((dir) => dir.includes(other.name)),
        `${at.join("/")}: the other game is still denied`,
      );
    }
    await rm(path.join(scratch, "reviewers"), { recursive: true, force: true });
    // A link in the host's own folder (no box can write it) is refused, never followed.
    for (const at of [[hash], [hash, "claude-code"]]) {
      await rm(path.join(homes, hash), { recursive: true, force: true });
      await mkdir(path.dirname(path.join(homes, ...at)), { recursive: true });
      await symlink(games, path.join(homes, ...at));
      const before = await listing();
      const asked = seen.length;
      await assert.rejects(delegate(reviewerAsk(project.dir)), /reviewer/, `${at.join("/")}: refused`);
      assert.equal(seen.length, asked, `${at.join("/")}: no engine started`);
      assert.deepEqual(await listing(), before, `${at.join("/")}: nothing made or removed in the games folder`);
    }
    await rm(path.join(homes, hash), { recursive: true, force: true });

    const captures = runDir(core.layout.runs, RUN_ID);
    await rm(captures, { recursive: true, force: true });
    await symlink(games, captures);
    const before = seen.length;
    await assert.rejects(delegate(reviewerAsk(project.dir)), /reviewer/, "a linked captures folder is refused");
    assert.equal(seen.length, before, "no engine started");
    await rm(captures);
  });

  it("a reviewer's look with macOS access missing puts its one line in its run's chat and in no other", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const access: ScreenAccess = {
      status: () => ({ screen: ScreenAccessState.Denied, accessibility: false }),
      asked: async () => true,
      askOnce: async () => {},
    };
    const { core, api, game, project, threadId, whileRunning } = await workerChat({
      appLook: stubAppLook(),
      screenAccess: access,
    });
    const answers: unknown[] = [];
    whileRunning(async (request) => {
      answers.push(await request.onLiveTool?.(APP_LOOK_TOOL_NAME, { app: "Fixture App" }));
    });
    // The harness asks for a reviewer with no chat of its own: the host finds its run's.
    await api["engine.delegate"]?.({ engine: CLAUDE, prompt: "check", project: game, ...reviewerAsk(project.dir) });
    whileRunning(async () => {});
    assert.equal(answers.length, 1, "the reviewer looked");
    assert.match(JSON.stringify(answers[0]), /Screen Recording/, "it is told what the person must turn on");
    const rows = async (thread: string) =>
      (await core.store.listEvents(thread)).filter(
        (event) => customRecord(event.data)?.event_type === CustomEvent.AppLookAccess,
      );
    assert.equal((await rows(threadId)).length, 1, "one line in the run's chat");
    const others = (await core.store.listThreads()).filter((thread) => thread.id !== threadId);
    for (const thread of others) assert.deepEqual(await rows(thread.id), [], `none in ${thread.id}`);
  });

  it("a Stop by its run reaches that run's reviewer and nothing else", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { api, game, project, seen, delegate, runWorker, untilSeen, whileRunning } = await workerChat();
    whileRunning(
      (request) =>
        new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const reviewing = delegate(reviewerAsk(project.dir)).catch((error: unknown) => error);
    await untilSeen(1);
    const working = delegate(runWorker()).catch((error: unknown) => error);
    await untilSeen(2);
    const abort = api["engine.abort"];
    assert.ok(abort);
    assert.deepEqual(await abort({ reviewer: "run_other", project: game }), { aborted: 0 }, "another run's: none");
    assert.deepEqual(await abort({ reviewer: RUN_ID, project: "another-game" }), { aborted: 0 }, "another game's");
    assert.deepEqual(await abort({ reviewer: RUN_ID, project: game }), { aborted: 1 }, "its run's reviewer");
    await reviewing;
    const [reviewer, worker] = seen;
    assert.equal(reviewer?.signal?.aborted, true, "the reviewer stopped");
    assert.equal(worker?.signal?.aborted, false, "the run's worker goes on");
    whileRunning(async () => {});
    assert.ok(await abort({ project: game }));
    await working;
  });

  it("refuses a reviewer it cannot place, before any engine starts", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { core, other, project, seen, delegate, startRun, copyOf } = await workerChat();
    const otherChat = await core.threadForGame(other.name);
    await startRun("run_other_game", otherChat, other.name);
    const runFolder = path.join(core.layout.scratch, "autopilot", RUN_ID);
    await copyOf(RUN_ID, "integration");
    const link = path.join(runFolder, "elsewhere");
    await symlink(other.dir, link);
    const foreign = path.join(runFolder, "foreign");
    await mkdir(foreign, { recursive: true });
    await gitFile(["init", "-q"], { cwd: foreign });
    const rows: Array<{ label: string; ask: Record<string, unknown> }> = [
      { label: "a run of another game", ask: reviewerAsk(project.dir, "run_other_game") },
      { label: "a run no chat of this game started", ask: reviewerAsk(project.dir, "run_nobody") },
      { label: "not read-only", ask: { reviewer: { runId: RUN_ID, reads: project.dir }, toolAllow: [] } },
      { label: "reading the whole disk", ask: reviewerAsk(path.parse(project.dir).root) },
      { label: "another game's folder", ask: reviewerAsk(other.dir) },
      { label: "a link in the run's folder to another game", ask: reviewerAsk(link) },
      { label: "another repository in the run's folder", ask: reviewerAsk(foreign) },
      { label: "a folder that is not there", ask: reviewerAsk(path.join(runFolder, "missing")) },
    ];
    for (const { label, ask } of rows) {
      const before = seen.length;
      await assert.rejects(delegate(ask), /reviewer/, `${label}: refused`);
      assert.equal(seen.length, before, `${label}: no engine started`);
    }
    const made = (dir: string) =>
      stat(dir).then(
        () => true,
        () => false,
      );
    assert.deepEqual(await readdir(core.layout.reviewers), [], "no reviewer's home made");
    for (const runId of [RUN_ID, "run_other_game", "run_nobody"])
      assert.equal(await made(runDir(core.layout.runs, runId)), false, `no captures folder made for ${runId}`);
  });

  it("a reviewer keeps no other grant", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { project, seen, delegate, worktree } = await workerChat();
    const asked = reviewerAsk(project.dir, RUN_ID, {
      director: { project: project.name, root: worktree, runId: RUN_ID, threadId: "chat" },
      attribution: { runId: RUN_ID, agentId: "w9" },
      worker: { id: "w9", title: "Worker w9", runId: RUN_ID },
      workers: { tools: [{ name: "worker_start", description: "start", parameters: { type: "object" } }] },
      selfCapture: { project: project.name, root: worktree, runId: RUN_ID, facetId: "f1" },
      cwd: worktree,
      toolAllow: ["blender__"],
      extraReads: ["/"],
    });
    await delegate(asked);
    const request = seen.at(-1);
    assert.ok(request);
    assert.equal(request.director, undefined, "no director");
    assert.equal(request.worker, undefined, "no worker's seat");
    assert.equal(request.selfCapture, undefined, "no capture grant");
    assert.ok(request.cwd.includes(`${path.sep}reviewers${path.sep}`), "its own home, whatever cwd it named");
    assert.deepEqual(toolsOf(request), [APP_LOOK_TOOL_NAME], "no worker tools, no plugin tools");
    assert.ok(!request.extraReads?.includes("/"), "no folder the brief names");
    assert.equal(request.extraReads?.length, 2, "only the lead's folder and the run's captures");
  });
});
