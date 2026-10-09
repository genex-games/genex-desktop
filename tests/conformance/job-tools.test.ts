/**
 * Jobs for the chat's agent, the lead and workers: who is offered the job tools, the chat's mode at
 * the moment of each start (Bypass and Auto start it in the mode's box, Accept edits and Manual ask
 * on a card, Plan answers that it waits for the plan), the folder a job runs in, the never-touch
 * screen on its command in every mode, who sees and stops which job, the host records in the chat,
 * the chat's next turn told of its jobs, and what ends a job besides itself (its run's settle, its
 * chat turn's end). Real core, fake delegated engines, and each job a plain `/bin/sh -c` in its own
 * process group, its spawn request recorded.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import {
  isJobTool,
  type JobEndedPayload,
  JobRole,
  JobScopeKind,
  type JobStartedPayload,
  JobState,
  JobStopper,
  JobTool,
  type JobView,
} from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import { running } from "../helpers/processes.ts";
import { CLAUDE, closeWorkerChats, LOCAL, POLL_MS, POLL_TRIES, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

/** A case that would hang on a regression fails within this instead; each case has its own. */
const CASE_TIMEOUT_MS = 60_000;
const JOB_TOOLS = Object.values(JobTool).sort();
/** A command that runs until it is stopped, and one that ends at once. */
const LONG = "sleep 30";
const SHORT = "echo built; exit 0";
const STARTED = /^Job ([0-9a-f-]{36}) \(/;
const IN_PLAN = /The chat is in Plan mode, so this did not start: jobs wait until the plan is approved/;
const NEVER_TOUCH = /Genex never lets a worker reach|Genex could not check what this command reaches/;
const POSIX = { skip: process.platform === "win32" && "process groups and /bin/sh are POSIX" } as const;
/** What the harness reads of a job: what it is and how it ended, never where its files are. */
const JOB_VIEW_FIELDS = [
  "command",
  "durationMs",
  "endSeq",
  "endedAt",
  "exitCode",
  "id",
  "role",
  "state",
  "stoppedBy",
  "title",
  "worker",
];
type JobsListAnswer = { jobs: JobView[]; seq: number };

after(closeWorkerChats);

type SpawnRequest = Parameters<JobSpawn>[0];
type Chat = Awaited<ReturnType<typeof jobChat>>;
type Call = [string, Record<string, unknown>];

/** A game chat whose core starts each job as a plain `/bin/sh -c` in its own group, recording each request. */
async function jobChat() {
  const spawned: SpawnRequest[] = [];
  const jobSpawn: JobSpawn = async (request) => {
    spawned.push(request);
    const child = spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, detached: true, stdio: "pipe" });
    return { child, sandboxed: false };
  };
  const chat = await workerChat({ jobSpawn });
  return { ...chat, spawned, game: chat.game, gameDir: await realpath(chat.project.dir) };
}

/** A tool's answer, as text. */
const textOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? answer : (answer?.text ?? ""));

/** The job tools a session was handed. */
const jobToolsOf = (request: DelegateRequest | undefined) =>
  (request?.liveTools ?? [])
    .map((tool) => tool.name)
    .filter((name) => isJobTool(name))
    .sort();

/** The id a started job's answer names. */
function startedId(answer: string): string {
  const id = STARTED.exec(answer)?.[1];
  assert.ok(id, `a job started: ${answer}`);
  return id;
}

/** A session briefed with `extra` makes `calls` in order while its turn runs: what each answered, and its request. */
async function callsIn(chat: Chat, extra: Record<string, unknown>, calls: Call[], engine = CLAUDE) {
  const answers: string[] = [];
  let seen: DelegateRequest | undefined;
  chat.whileRunning(async (request) => {
    seen = request;
    for (const [name, args] of calls) answers.push(textOf(await request.onLiveTool?.(name, args)));
  });
  try {
    await chat.delegate(extra, engine);
  } finally {
    chat.whileRunning(async () => {});
  }
  return { answers, request: seen };
}

/** The chat's own session answering a message the person sent now. */
const ownTurn = async (chat: Chat) => ({ chatTurn: { messageId: await chat.personSays() } });

/** A lead of the chat's run that sits in the game folder and leads a build of its own (a web lead). */
async function webLead(chat: Chat) {
  const root = await chat.copyOf(RUN_ID, "integration");
  const director = { runId: RUN_ID, threadId: chat.threadId, project: chat.game, root, setup: null, tools: [] };
  return { brief: { readOnly: true, director: { ...director, chatSession: true } }, root: await realpath(root) };
}

/** A lead of the chat's run that works in the game folder in place, as the Unreal lead does. */
const inPlaceLead = (chat: Chat) => ({
  director: { runId: RUN_ID, threadId: chat.threadId, project: chat.game, root: chat.gameDir, setup: null, tools: [] },
});

/** A job's records of one kind in the chat. */
async function jobRows<T>(chat: Chat, type: string): Promise<T[]> {
  return (await chat.core.store.listEvents(chat.threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === type ? [custom.payload as unknown as T] : [];
  });
}

/** Wait until a job's record says what `done` asks of it. */
async function untilJob(chat: Chat, id: string, done: (state: JobState | undefined) => boolean) {
  for (let tries = 0; tries < POLL_TRIES; tries++) {
    if (done((await chat.core.jobs.get(chat.game, id))?.state)) return;
    await sleep(POLL_MS);
  }
  assert.fail(`job ${id} never got there`);
}

/** Wait until a job's end is recorded in its chat and the registry marks it recorded (the mark follows the row). */
async function untilEndRecorded(chat: Chat, id: string) {
  for (let tries = 0; tries < POLL_TRIES; tries++) {
    const ended = await jobRows<JobEndedPayload>(chat, "job_ended");
    const marked = (await chat.core.jobs.get(chat.game, id))?.endLogged === true;
    if (marked && ended.some((row) => row.jobId === id)) return;
    await sleep(POLL_MS);
  }
  assert.fail(`job ${id}'s end was never recorded`);
}

describe("job tools", () => {
  it("the chat's own session, a lead and a writing worker are offered the job tools; a reader, an unseated builder, the coordinator and a local model are not", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    const own = await callsIn(chat, await ownTurn(chat), []);
    assert.deepEqual(jobToolsOf(own.request), JOB_TOOLS, "the chat's own session");
    const lead = await webLead(chat);
    assert.deepEqual(jobToolsOf((await callsIn(chat, lead.brief, [])).request), JOB_TOOLS, "a lead");
    assert.deepEqual(jobToolsOf((await callsIn(chat, chat.runWorker(), [])).request), JOB_TOOLS, "a writing worker");
    const none: Array<[string, Record<string, unknown>, string?]> = [
      ["a reader worker", chat.runWorker("r1", chat.worktree, { readOnly: true })],
      ["an unseated builder", { cwd: chat.worktree }],
      ["the coordinator", { coordinator: { runId: RUN_ID }, readOnly: true }],
      ["the chat's own session on a local model", await ownTurn(chat), LOCAL],
    ];
    for (const [label, brief, engine] of none)
      assert.deepEqual(jobToolsOf((await callsIn(chat, brief, [], engine)).request), [], label);
  });

  it("in Bypass and Auto a job starts without a card, in its own folder, in the mode's box", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    for (const mode of [PermissionMode.Bypass, PermissionMode.Auto]) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      const { answers } = await callsIn(chat, await ownTurn(chat), [
        [JobTool.Start, { title: "Server", command: LONG }],
      ]);
      startedId(answers[0] ?? "");
      const request = chat.spawned.at(-1);
      assert.equal(request?.cwd, chat.gameDir, `${mode}: in the game's folder`);
      const writes = mode === PermissionMode.Bypass ? [os.homedir(), chat.gameDir] : [chat.gameDir];
      assert.deepEqual(request?.policy.allowWrite, writes, `${mode}: the mode's box`);
      assert.deepEqual(request?.policy.allowedDomains, [], `${mode}: no outbound network`);
      assert.ok(request?.policy.denyWrite?.includes(await realpath(chat.other.dir)), `${mode}: never another game`);
    }
    assert.deepEqual(await chat.rows(), [], "no card");
  });

  it("a job follows the chat's mode at the moment it starts, not the mode its session began in", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const answers: string[] = [];
    chat.whileRunning(async (request) => {
      answers.push(textOf(await request.onLiveTool?.(JobTool.Start, { title: "First", command: LONG })));
      await chat.core.setPermissionMode(chat.threadId, PermissionMode.Manual);
      const second = request.onLiveTool?.(JobTool.Start, { title: "Second", command: LONG });
      const card = await chat.nextCard(new Set());
      assert.equal(card.tool, "Job", "the second waits on a card");
      assert.equal(chat.core.answerPermission(card.requestId, { decision: "allow" }), true);
      answers.push(textOf(await second));
    });
    await chat.delegate(await ownTurn(chat));
    chat.whileRunning(async () => {});
    for (const answer of answers) startedId(answer);
    assert.equal(chat.spawned.length, 2);
  });

  it("in Accept edits and Manual a job waits for the person's card, and a declined card starts nothing", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    for (const mode of [PermissionMode.AcceptEdits, PermissionMode.Manual]) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      for (const decision of ["allow", "deny"] as const) {
        const known = new Set((await chat.rows()).map((row) => row.requestId));
        const before = chat.spawned.length;
        const answers: string[] = [];
        chat.whileRunning(async (request) => {
          const call = request.onLiveTool?.(JobTool.Start, { title: "Unreal build", command: LONG });
          const card = await chat.nextCard(known);
          assert.equal(card.state, "pending");
          assert.equal(card.tool, "Job");
          assert.deepEqual(card.input, { title: "Unreal build", command: LONG, folder: "." });
          assert.equal(chat.core.answerPermission(card.requestId, { decision }), true);
          answers.push(textOf(await call));
        });
        await chat.delegate(await ownTurn(chat));
        chat.whileRunning(async () => {});
        if (decision === "allow") startedId(answers[0] ?? "");
        else assert.match(answers[0] ?? "", /did not allow this job/, `${mode}: declined`);
        assert.equal(chat.spawned.length - before, decision === "allow" ? 1 : 0, `${mode} ${decision}`);
      }
    }
  });

  it("in Plan a job does not start and the answer says to put it in the plan", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const { answers } = await callsIn(chat, await ownTurn(chat), [
      [JobTool.Start, { title: "Build", command: "cat ~/.ssh/id_rsa", cwd: "../nowhere" }],
    ]);
    assert.match(answers[0] ?? "", IN_PLAN, "the plan answer comes before anything else");
    assert.equal(chat.spawned.length, 0);
    assert.deepEqual(await chat.rows(), [], "no card");
    assert.deepEqual(await chat.core.jobs.list(chat.game), [], "no record");
  });

  it("a worker's job card names the worker and waits; don't wait for me refuses it at once", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Manual);
    const answers: string[] = [];
    let known = new Set<string>();
    chat.whileRunning(async (request) => {
      const call = request.onLiveTool?.(JobTool.Start, { title: "Bake lights", command: LONG });
      const card = await chat.nextCard(known);
      assert.equal(card.state, "pending", "it waits");
      assert.deepEqual(card.worker, { id: "w1", title: "Worker w1" }, "naming the worker");
      assert.deepEqual(card.input, { title: "Bake lights", command: LONG, folder: "." });
      for (const words of [card.title ?? "", card.description ?? ""])
        assert.ok(!words.includes(LONG), `no command in the card's words: ${words}`);
      assert.equal(chat.core.answerPermission(card.requestId, { decision: "deny" }), true);
      answers.push(textOf(await call));
    });
    await chat.delegate(chat.runWorker());
    assert.match(answers[0] ?? "", /did not allow this job/);

    await chat.core.setDontWait(chat.threadId, true);
    known = new Set((await chat.rows()).map((row) => row.requestId));
    chat.whileRunning(async (request) => {
      answers.push(textOf(await request.onLiveTool?.(JobTool.Start, { title: "Bake lights", command: LONG })));
    });
    await chat.delegate(chat.runWorker());
    chat.whileRunning(async () => {});
    assert.match(answers[1] ?? "", /asked not to be waited for/, "refused at once");
    const kept = (await chat.rows()).filter((row) => !known.has(row.requestId));
    assert.deepEqual(
      kept.map((row) => [row.state, row.by ?? null]),
      [
        ["pending", null],
        ["denied", "not_waited"],
      ],
      "the question stays in the chat, settled",
    );
    assert.equal(chat.spawned.length, 0);
  });

  it("a worker's job writes only its own folders and never reaches the never-touch list", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    for (const mode of [PermissionMode.Auto, PermissionMode.Bypass]) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      const { answers, request } = await callsIn(chat, chat.runWorker(), [
        [JobTool.Start, { title: "Bake", command: LONG }],
      ]);
      startedId(answers[0] ?? "");
      const seat = request?.worker;
      assert.ok(seat, "a seated worker");
      const job = chat.spawned.at(-1);
      assert.equal(job?.cwd, await realpath(chat.worktree), `${mode}: in its own copy`);
      const writes = mode === PermissionMode.Bypass ? [os.homedir(), ...seat.writeRoots] : seat.writeRoots;
      assert.deepEqual(job?.policy.allowWrite, writes, `${mode}: its seat's write roots`);
      const genexRuns = path.join(chat.lite.userData, "runs");
      for (const denied of [job?.policy.denyRead ?? [], job?.policy.denyWrite ?? []]) {
        assert.ok(denied.includes(await realpath(chat.other.dir)), `${mode}: another game`);
        assert.ok(denied.includes(genexRuns), `${mode}: Genex's data`);
      }
      if (mode === PermissionMode.Auto)
        assert.ok(job?.policy.denyWrite?.includes(chat.gameDir), "a copy's job never writes the game itself");
    }
  });

  it("refuses a cwd outside the session's folder, starting nothing", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Bypass);
    await symlink(path.join(os.homedir(), ".codex"), path.join(chat.gameDir, "codex-link"));
    await writeFile(path.join(chat.gameDir, "a-file.txt"), "x");
    const hostile = [
      "..",
      `../${path.basename(chat.other.dir)}`,
      "/etc",
      "~",
      "~/.codex",
      "codex-link",
      "missing",
      "a-file.txt",
      "\0",
    ];
    const calls: Call[] = hostile.map((cwd) => [JobTool.Start, { title: "Build", command: LONG, cwd }]);
    const { answers } = await callsIn(chat, await ownTurn(chat), calls);
    for (const [at, answer] of answers.entries())
      assert.match(answer, /is not a folder inside yours/, `cwd ${hostile[at]}`);
    assert.equal(chat.spawned.length, 0, "nothing spawned");
    assert.deepEqual(await chat.rows(), [], "no card");
    assert.deepEqual(await chat.core.jobs.list(chat.game), [], "no record");
  });

  it("refuses a command that reaches the never-touch list in every mode, Bypass included, starting nothing", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await symlink(chat.other.dir, path.join(chat.gameDir, "peek"));
    const other = path.basename(chat.other.dir);
    const hostile = [
      "cat ~/.ssh/id_rsa",
      "security find-generic-password -s x",
      `cp a ../${other}/`,
      "cat peek/index.html",
      // ANSI-C quoting, decoded as the shell would: another game.
      `cat $'..\\x2f${other}'/index.html`,
      // A parameter form the screen cannot read.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter form is the input.
      "cat ${HOME:-/x}/.codex/auth.json",
    ];
    for (const mode of [
      PermissionMode.Bypass,
      PermissionMode.Auto,
      PermissionMode.AcceptEdits,
      PermissionMode.Manual,
    ]) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      const calls: Call[] = hostile.map((command) => [JobTool.Start, { title: "Peek", command }]);
      const { answers } = await callsIn(chat, await ownTurn(chat), calls);
      for (const [at, answer] of answers.entries()) assert.match(answer, NEVER_TOUCH, `${mode}: ${hostile[at]}`);
    }
    assert.equal(chat.spawned.length, 0, "nothing spawned");
    assert.deepEqual(await chat.rows(), [], "no card");
    assert.deepEqual(await chat.core.jobs.list(chat.game), [], "no record");
  });

  it("a web lead's job runs in the worktree it leads and never writes the game folder; the Unreal lead's runs in the game folder", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const web = await webLead(chat);
    const led = await callsIn(chat, web.brief, [[JobTool.Start, { title: "Build", command: LONG }]]);
    startedId(led.answers[0] ?? "");
    const webJob = chat.spawned.at(-1);
    assert.equal(webJob?.cwd, web.root, "in the worktree it leads");
    assert.deepEqual(webJob?.policy.allowWrite, [web.root], "writing only that worktree");
    assert.ok(webJob?.policy.denyWrite?.includes(chat.gameDir), "never the game folder it sits in");

    const inPlace = await callsIn(chat, inPlaceLead(chat), [[JobTool.Start, { title: "Build", command: LONG }]]);
    startedId(inPlace.answers[0] ?? "");
    const placeJob = chat.spawned.at(-1);
    assert.equal(placeJob?.cwd, chat.gameDir, "in the game folder");
    assert.deepEqual(placeJob?.policy.allowWrite, [chat.gameDir], "writing it in place");
    const owners = (await chat.core.jobs.list(chat.game)).map((job) => [job.owner.role, job.owner.scope]);
    assert.deepEqual(owners, [
      [JobRole.Lead, { kind: JobScopeKind.Run, runId: RUN_ID }],
      [JobRole.Lead, { kind: JobScopeKind.Run, runId: RUN_ID }],
    ]);
  });

  it("a session sees and stops only its chat's jobs, and a worker only its own", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const own = await callsIn(chat, await ownTurn(chat), [[JobTool.Start, { title: "Server", command: LONG }]]);
    const ownId = startedId(own.answers[0] ?? "");
    const w1 = await callsIn(chat, chat.runWorker("w1"), [[JobTool.Start, { title: "Bake", command: LONG }]]);
    const w1Id = startedId(w1.answers[0] ?? "");
    const foreign = await chat.core.jobs.start({
      owner: {
        project: chat.other.name,
        chatThreadId: "elsewhere",
        role: JobRole.Chat,
        scope: { kind: JobScopeKind.Chat },
      },
      title: "Theirs",
      command: LONG,
      cwd: await realpath(chat.other.dir),
      policy: {},
      mode: PermissionMode.Auto,
    });
    const hostile = [foreign.id, "../x", "", ownId.slice(0, 8)];
    const w2 = await callsIn(chat, chat.runWorker("w2", await chat.copyOf(RUN_ID, "w2")), [
      [JobTool.Status, {}],
      [JobTool.Stop, { id: ownId }],
      [JobTool.Tail, { id: w1Id }],
      ...hostile.map((id): Call => [JobTool.Stop, { id }]),
    ]);
    assert.equal(w2.answers[0], "No jobs here yet.", "a worker sees none but its own");
    for (const answer of w2.answers.slice(1)) assert.match(answer, /^No job /);
    const status = await callsIn(chat, await ownTurn(chat), [
      [JobTool.Status, {}],
      ...hostile.map((id): Call => [JobTool.Tail, { id }]),
      [JobTool.Stop, { id: w1Id }],
    ]);
    assert.ok(status.answers[0]?.includes(ownId) && status.answers[0].includes(w1Id), "the chat's own sees its chat's");
    assert.ok(!status.answers[0]?.includes(foreign.id), "never another chat's");
    for (const answer of status.answers.slice(1, -1)) assert.match(answer, /^No job /);
    assert.match(status.answers.at(-1) ?? "", /^Stopped: /);
    assert.equal((await chat.core.jobs.get(chat.game, w1Id))?.stoppedBy, JobStopper.Agent);
    assert.equal((await chat.core.jobs.get(chat.game, ownId))?.state, JobState.Running, "the rest run on");
    assert.equal((await chat.core.jobs.get(chat.other.name, foreign.id))?.state, JobState.Running);
    await chat.core.jobs.stop(chat.other.name, foreign.id, JobStopper.Person);
  });

  it("every start and end is a host record in the chat, and the harness cannot write one", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const { answers } = await callsIn(chat, chat.runWorker(), [[JobTool.Start, { title: "Bake", command: SHORT }]]);
    const id = startedId(answers[0] ?? "");
    await untilEndRecorded(chat, id);
    const [started] = await jobRows<JobStartedPayload>(chat, "job_started");
    assert.deepEqual(
      { ...started, startedAt: "", deadlineAt: "" },
      {
        jobId: id,
        project: chat.game,
        title: "Bake",
        command: SHORT,
        cwd: await realpath(chat.worktree),
        startedAt: "",
        role: JobRole.Worker,
        worker: { id: "w1", title: "Worker w1" },
        runId: RUN_ID,
        deadlineAt: "",
      },
    );
    const [ended] = await jobRows<JobEndedPayload>(chat, "job_ended");
    assert.equal(ended?.state, JobState.Succeeded);
    assert.equal(ended?.exitCode, 0);
    assert.equal(ended?.runId, RUN_ID);
    assert.deepEqual(ended?.worker, { id: "w1", title: "Worker w1" }, "an end names its worker on its own");
    assert.match(ended?.tail ?? "", /built/);
    assert.equal((await chat.core.jobs.get(chat.game, id))?.endLogged, true, "marked recorded");
    const append = chat.api["events.append"];
    assert.ok(append, "the harness's append");
    for (const type of ["job_started", "job_ended"])
      await assert.rejects(
        append({
          threadId: chat.threadId,
          batch: [{ type: "custom", event_type: type, payload: { jobId: id, project: chat.game } }],
        }),
        `the harness cannot write ${type}`,
      );
  });

  it("a job's records name its run, or the chat turn it was started in", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const lead = await callsIn(chat, inPlaceLead(chat), [[JobTool.Start, { title: "Lead's", command: SHORT }]]);
    const leadJob = startedId(lead.answers[0] ?? "");
    const turn = await ownTurn(chat);
    const own = await callsIn(chat, turn, [[JobTool.Start, { title: "Chat's", command: SHORT }]]);
    const ownJob = startedId(own.answers[0] ?? "");
    for (const id of [leadJob, ownJob]) await untilEndRecorded(chat, id);
    const started = await jobRows<JobStartedPayload>(chat, "job_started");
    const ended = await jobRows<JobEndedPayload>(chat, "job_ended");
    const scopeOf = (row: { runId?: string; turn?: string } | undefined) => ({ runId: row?.runId, turn: row?.turn });
    for (const rows of [started, ended]) {
      const byJob = (id: string) => rows.find((row) => row.jobId === id);
      assert.deepEqual(scopeOf(byJob(leadJob)), { runId: RUN_ID, turn: undefined }, "the lead's names its run");
      assert.deepEqual(
        scopeOf(byJob(ownJob)),
        { runId: undefined, turn: turn.chatTurn.messageId },
        "the chat's own names the turn it was started in",
      );
    }
    const record = await chat.core.jobs.get(chat.game, ownJob);
    assert.deepEqual(record?.owner.scope, { kind: JobScopeKind.Chat }, "it still outlives the turn");
  });

  it("the person's Stop stops the job and records who stopped it", { ...POSIX, timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const { answers } = await callsIn(chat, await ownTurn(chat), [[JobTool.Start, { title: "Server", command: LONG }]]);
    const id = startedId(answers[0] ?? "");
    const foreign = await chat.core.jobs.start({
      owner: {
        project: chat.other.name,
        chatThreadId: "elsewhere",
        role: JobRole.Chat,
        scope: { kind: JobScopeKind.Chat },
      },
      title: "Theirs",
      command: LONG,
      cwd: await realpath(chat.other.dir),
      policy: {},
      mode: PermissionMode.Auto,
    });
    for (const [project, jobId] of [
      [chat.game, foreign.id],
      [chat.game, "../x"],
      [chat.game, ""],
      ["../x", id],
      ["", id],
    ])
      assert.equal(await chat.core.stopJob(project, jobId), null, `${project} ${jobId}`);
    assert.equal((await chat.core.jobs.get(chat.game, id))?.state, JobState.Running, "nothing was stopped");
    assert.equal((await chat.core.jobs.get(chat.other.name, foreign.id))?.state, JobState.Running);
    const stopped = await chat.core.stopJob(chat.game, id);
    assert.equal(stopped?.state, JobState.Stopped);
    assert.equal(stopped?.stoppedBy, JobStopper.Person);
    await untilEndRecorded(chat, id);
    const [ended] = await jobRows<JobEndedPayload>(chat, "job_ended");
    assert.equal(ended?.stoppedBy, JobStopper.Person, "its end row says the person stopped it");
    assert.equal(ended?.worker, undefined, "the chat's own job names no worker");
    const next = await callsIn(chat, await ownTurn(chat), [[JobTool.Status, { id }]]);
    assert.match(
      next.request?.prompt ?? "",
      /Jobs since your last turn: Server \(`[^`]+`\) was stopped by the person after \d+ min: read it with job_tail [^;.]+, and do not start it again unless the person asks/,
      "the chat's agent is told the person stopped it",
    );
    assert.match(
      next.answers[0] ?? "",
      /· Server · stopped by the person after \d+ min/,
      "job_status says who stopped it",
    );
    await chat.core.jobs.stop(chat.other.name, foreign.id, JobStopper.Person);
  });

  it("the harness reads a run's job ends and cannot start or stop one", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const { answers } = await callsIn(chat, chat.runWorker(), [
      [JobTool.Start, { title: "Bake", command: SHORT }],
      [JobTool.Start, { title: "Serve", command: LONG }],
    ]);
    const [baked = "", served = ""] = answers.map(startedId);
    try {
      await untilJob(chat, baked, (state) => state === JobState.Succeeded);
      const list = chat.api["jobs.list"] as (params: unknown) => Promise<JobsListAnswer>;
      assert.ok(list, "the harness's read");
      const read = await list({ project: chat.game, runId: RUN_ID, endedAfter: 0 });
      assert.deepEqual(
        read.jobs.map((job) => [job.id, job.title, job.state, job.role, job.worker, job.exitCode, job.endSeq]),
        [[baked, "Bake", JobState.Succeeded, JobRole.Worker, "Worker w1", 0, 1]],
      );
      assert.equal(read.seq, 1);
      assert.deepEqual(Object.keys(read.jobs[0] ?? {}).sort(), JOB_VIEW_FIELDS, "no folder, log or process id");
      assert.ok(!JSON.stringify(read).includes(chat.gameDir), "no path of the game");
      assert.deepEqual(await list({ project: chat.game, runId: RUN_ID, endedAfter: read.seq }), { jobs: [], seq: 1 });
      assert.deepEqual(await list({ project: chat.game, runId: "another-run", endedAfter: 0 }), { jobs: [], seq: 1 });
      const all = await list({ project: chat.game, runId: RUN_ID });
      assert.deepEqual(Object.fromEntries(all.jobs.map((job) => [job.id, job.state])), {
        [baked]: JobState.Succeeded,
        [served]: JobState.Running,
      });
      for (const project of ["../x", "a/b", ".", ""])
        assert.deepEqual(await list({ project, endedAfter: 0 }), { jobs: [], seq: 0 }, project);
      assert.deepEqual(
        Object.keys(chat.api).filter((method) => method.startsWith("jobs.")),
        ["jobs.list"],
        "the harness can neither start nor stop a job",
      );
      assert.equal((await chat.core.jobs.get(chat.game, served))?.state, JobState.Running, "a read stops nothing");
    } finally {
      await chat.core.jobs.stop(chat.game, served, JobStopper.Person);
    }
  });

  it("the chat's next turn is told which of its jobs finished, once", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const first = await callsIn(chat, await ownTurn(chat), [
      [JobTool.Start, { title: "Build", command: SHORT }],
      [JobTool.Start, { title: "Server", command: LONG }],
    ]);
    const built = startedId(first.answers[0] ?? "");
    const server = startedId(first.answers[1] ?? "");
    await untilEndRecorded(chat, built);
    const next = await callsIn(chat, await ownTurn(chat), []);
    assert.match(
      next.request?.prompt ?? "",
      /Jobs since your last turn: Build \(`echo built; exit 0`\) finished \(exit 0\)/,
    );
    assert.match(next.request?.prompt ?? "", new RegExp(`Still running: Server \\(${server}\\)`));
    const again = await callsIn(chat, await ownTurn(chat), []);
    assert.doesNotMatch(again.request?.prompt ?? "", /Jobs since your last turn/, "told once");
    assert.match(again.request?.prompt ?? "", /Still running: Server/);
  });

  it("a run's jobs stop when the harness reports the run settled, and a crash does not stop them", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const { answers } = await callsIn(chat, chat.runWorker(), [[JobTool.Start, { title: "Bake", command: LONG }]]);
    const id = startedId(answers[0] ?? "");
    // A harness that died settles its runs without its own notice (`recovery.ts`).
    chat.core.emit(UiEvent.RunSettled, { runId: RUN_ID });
    assert.equal((await chat.core.jobs.get(chat.game, id))?.state, JobState.Running, "a crash ends none");
    chat.core.host.options.onNotify?.(UiEvent.RunSettled, { runId: RUN_ID });
    await untilJob(chat, id, (state) => state === JobState.Stopped);
    const record = await chat.core.jobs.get(chat.game, id);
    assert.equal(record?.stoppedBy, JobStopper.ScopeEnded);
    assert.equal(running(record?.pid ?? 0), false);
  });

  it("a chat-turn worker's jobs stop when the turn's delegation returns; the chat's own outlive it", {
    ...POSIX,
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await jobChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const messageId = await chat.personSays();
    const copy = await chat.copyOf("turn", "w9");
    const answers: string[] = [];
    chat.whileRunning(async (request) => {
      answers.push(textOf(await request.onLiveTool?.(JobTool.Start, { title: "Job", command: LONG })));
      if (request.worker) return;
      await chat.delegate({ cwd: copy, worker: { id: "w9", title: "Turn worker", turn: messageId } });
    });
    await chat.delegate({ chatTurn: { messageId } });
    chat.whileRunning(async () => {});
    const [ownId, workerId] = answers.map(startedId);
    const worker = await chat.core.jobs.get(chat.game, workerId ?? "");
    assert.deepEqual(worker?.owner.scope, { kind: JobScopeKind.Turn, turn: messageId });
    await untilJob(chat, workerId ?? "", (state) => state === JobState.Stopped);
    assert.equal((await chat.core.jobs.get(chat.game, workerId ?? ""))?.stoppedBy, JobStopper.ScopeEnded);
    assert.equal((await chat.core.jobs.get(chat.game, ownId ?? ""))?.state, JobState.Running, "the chat's own runs on");
    for (
      let tries = 0;
      tries < POLL_TRIES && !(await chat.core.jobs.get(chat.game, workerId ?? ""))?.endLogged;
      tries++
    )
      await sleep(POLL_MS);
    const ofWorker = <T extends { jobId?: string }>(rows: T[]) => rows.filter((row) => row.jobId === workerId);
    const started = ofWorker(await jobRows<JobStartedPayload>(chat, "job_started"));
    const ended = ofWorker(await jobRows<JobEndedPayload>(chat, "job_ended"));
    for (const row of [...started, ...ended]) {
      assert.equal(row.turn, messageId, "a turn worker's job is on its turn's graph");
      assert.equal(row.runId, undefined, "and on no run's");
    }
    assert.deepEqual([started.length, ended.length], [1, 1]);
  });
});
