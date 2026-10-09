/**
 * Long processes the agents start: owned by the app, kept on disk per game, stopped on quit and
 * never anything else.
 *
 * The registry is driven through its own interface with a spawn that starts a real `/bin/sh -c`
 * without the sandbox (the sandbox's own containment is proven elsewhere), a fake clock for the
 * deadline, and a `kill` that records each signal before it sends it. POSIX only.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { after, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  JOB_TITLE_MAX_CHARS,
  type JobOwner,
  type JobRecord,
  JobRole,
  JobScopeKind,
  JobState,
  JobStopper,
  jobTitle,
} from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import {
  JOB_COMMAND_MAX_CHARS,
  JOB_MAX_HOURS,
  JOB_TAIL_MAX_CHARS,
  JOB_TAIL_MAX_LINES,
  JobRefusal,
  JobRefusalCode,
  JobService,
  type JobServiceOptions,
  type JobSpawn,
  MAX_ENDED_JOBS_KEPT,
  MAX_RUNNING_JOBS_PER_GAME,
} from "../../src/substrate/jobs.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "game";
/** How often a test looks again for something a job writes; never a deadline. */
const LOOK_AGAIN_MS = 20;
/** How long a test waits for a job's own output before it fails. */
const OUTPUT_PATIENCE_MS = 10 * SECOND_MS;

const owner = (project = GAME): JobOwner => ({
  project,
  chatThreadId: "thread-1",
  role: JobRole.Chat,
  scope: { kind: JobScopeKind.Chat },
});

/** A clock whose timers fire only when the test moves it on. */
function fakeClock(start = Date.UTC(2030, 0, 1)) {
  let now = start;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as { at: number; fn: () => void });
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          timer.fn();
        }
    },
  };
}

interface Harness {
  root: string;
  cwd: string;
  service: JobService;
  requests: Parameters<JobSpawn>[0][];
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
  clock: ReturnType<typeof fakeClock>;
  ended: JobRecord[];
  started: JobRecord[];
  /** The record `onEnded` was handed for `id`, once the job ends. */
  endOf(id: string): Promise<JobRecord>;
}

const services: JobService[] = [];
const strays: ChildProcess[] = [];
after(async () => {
  await Promise.all(services.map((service) => service.stopAll(JobStopper.Quit)));
  for (const child of strays) if (child.pid) killGroup(child.pid);
});

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function harness(options: Partial<JobServiceOptions> & { sendSignals?: boolean } = {}): Promise<Harness> {
  const base = await tmpDir("jobs-registry-");
  const root = path.join(base, "jobs");
  const cwd = path.join(base, "game");
  await mkdir(cwd, { recursive: true });
  const requests: Parameters<JobSpawn>[0][] = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ended: JobRecord[] = [];
  const started: JobRecord[] = [];
  const waiters = new Map<string, (record: JobRecord) => void>();
  const clock = fakeClock();
  const spawnJob: JobSpawn = async (request) => {
    requests.push(request);
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { child, sandboxed: false };
  };
  const { sendSignals = true, ...rest } = options;
  const service = new JobService({
    root,
    spawn: spawnJob,
    clock,
    platform: "darwin",
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (sendSignals) process.kill(pid, signal);
    },
    onStarted: (record) => {
      started.push(record);
    },
    onEnded: (record) => {
      ended.push(record);
      waiters.get(record.id)?.(record);
    },
    ...rest,
  });
  services.push(service);
  const endOf = (id: string) =>
    new Promise<JobRecord>((resolve) => {
      const done = ended.find((record) => record.id === id);
      if (done) resolve(done);
      else waiters.set(id, resolve);
    });
  return { root, cwd, service, requests, kills, clock, ended, started, endOf };
}

function startRequest(h: Harness, command: string, extra: { title?: string; hours?: number; project?: string } = {}) {
  return {
    owner: owner(extra.project ?? GAME),
    title: extra.title ?? "",
    command,
    cwd: h.cwd,
    policy: { allowedDomains: [] },
    hours: extra.hours,
    mode: PermissionMode.Auto,
  };
}

/** Wait until the job's log holds a line `matches` accepts, and hand that line back. */
async function lineInLog(h: Harness, id: string, matches: (line: string) => boolean): Promise<string> {
  const deadline = Date.now() + OUTPUT_PATIENCE_MS;
  while (Date.now() < deadline) {
    const tail = await h.service.tail(GAME, id, {});
    const line = tail?.text.split("\n").find(matches);
    if (line) return line;
    await sleep(LOOK_AGAIN_MS);
  }
  throw new Error(`job ${id} never wrote the line`);
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JobRefusal, `a typed refusal, not ${String(error)}`);
    return error.code;
  }
  assert.fail("the start was not refused");
}

async function folders(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

it("starts a job, logs its output, and records how it ended", async () => {
  const h = await harness();
  const record = await h.service.start(startRequest(h, "echo hi; exit 3", { title: "Greeting" }));
  assert.equal(record.state, JobState.Running);
  assert.equal(h.started.length, 1, "the start is announced once its record is on disk");
  const done = await h.endOf(record.id);
  assert.equal(done.state, JobState.Failed);
  assert.equal(done.exitCode, 3);
  assert.equal(done.endSeq, 1);
  const tail = await h.service.tail(GAME, record.id, {});
  assert.match(tail?.text ?? "", /^hi$/m);
  const onDisk = JSON.parse(await readFile(path.join(h.root, GAME, record.id, "job.json"), "utf8"));
  assert.deepEqual(onDisk, await h.service.get(GAME, record.id));
  assert.equal(h.requests[0]?.cwd, h.cwd);
  assert.deepEqual(h.requests[0]?.policy, { allowedDomains: [] }, "the policy is handed to the spawn as given");
});

it("refuses an empty or over-long command, a bad game name and a ninth running job, starting nothing", async () => {
  const h = await harness();
  const refused: Array<[string, ReturnType<typeof startRequest>, string]> = [
    ["an empty command", startRequest(h, ""), JobRefusalCode.EmptyCommand],
    ["a blank command", startRequest(h, "  \n "), JobRefusalCode.EmptyCommand],
    [
      "an over-long command",
      startRequest(h, `echo ${"x".repeat(JOB_COMMAND_MAX_CHARS)}`),
      JobRefusalCode.CommandTooLong,
    ],
    ["a game name that climbs", startRequest(h, "true", { project: "../x" }), JobRefusalCode.BadProject],
    ["a game name with a slash", startRequest(h, "true", { project: "a/b" }), JobRefusalCode.BadProject],
    ["a dot for a game name", startRequest(h, "true", { project: "." }), JobRefusalCode.BadProject],
    ["an empty game name", startRequest(h, "true", { project: "" }), JobRefusalCode.BadProject],
  ];
  for (const [name, request, code] of refused) {
    assert.equal(await refusalOf(h.service.start(request)), code, name);
    assert.equal(h.requests.length, 0, `${name}: nothing spawned`);
  }
  assert.deepEqual(await folders(h.root), [], "no folder for a refused job");
  assert.deepEqual(await folders(path.dirname(h.root)).then((names) => names.sort()), ["game"], "nothing beside it");

  const sleepers = await Promise.all(
    Array.from({ length: MAX_RUNNING_JOBS_PER_GAME }, () => h.service.start(startRequest(h, "sleep 30"))),
  );
  assert.equal(
    await refusalOf(h.service.start(startRequest(h, "sleep 30"))),
    JobRefusalCode.TooMany,
    "a ninth running job of the game",
  );
  assert.equal(h.requests.length, MAX_RUNNING_JOBS_PER_GAME, "spawned only the eight");
  assert.equal((await folders(path.join(h.root, GAME))).length, MAX_RUNNING_JOBS_PER_GAME);
  const other = await h.service.start(startRequest(h, "true", { project: "other-game" }));
  assert.equal(other.owner.project, "other-game", "another game has room of its own");
  await h.service.stopAll(JobStopper.Quit);
  for (const sleeper of sleepers) assert.equal(running(sleeper.pid ?? 0), false);
});

it("keeps a plain title, and names a job by its program when none is given", async () => {
  const table: Array<[string, string, string]> = [
    ["Unreal build", "make", "Unreal build"],
    ["  Unreal\nbuild\u0007 \u001b[31m ", "make", "Unreal build [31m"],
    ["", "/usr/bin/godot --headless", "godot"],
    ["   ", "FOO=1 BAR=2 /opt/tools/blender -b scene.blend", "blender"],
  ];
  for (const [asked, command, title] of table) assert.equal(jobTitle(asked, command), title, JSON.stringify(asked));
  const long = jobTitle("a".repeat(200), "make");
  assert.ok(long.length <= JOB_TITLE_MAX_CHARS, "clipped to the most a title holds");
  assert.ok(long.startsWith("aaaa"));

  const h = await harness();
  const record = await h.service.start(startRequest(h, "/usr/bin/true --quiet", { title: "\n" }));
  assert.equal(record.title, "true");
  await h.endOf(record.id);
});

it("stops a job's whole process group, and a job past its deadline as timed out", async () => {
  const h = await harness();
  const job = await h.service.start(startRequest(h, "sleep 30 & echo child $!; wait"));
  const childPid = Number((await lineInLog(h, job.id, (line) => line.startsWith("child "))).split(" ")[1]);
  assert.ok(running(childPid), "the job's own child runs");
  const stopped = await h.service.stop(GAME, job.id, JobStopper.Agent);
  assert.equal(stopped?.state, JobState.Stopped);
  assert.equal(stopped?.stoppedBy, JobStopper.Agent);
  assert.ok(
    h.kills.some((kill) => kill.pid === -(job.pid ?? 0) && kill.signal === "SIGTERM"),
    "the stop signals the job's group",
  );
  assert.equal(running(job.pid ?? 0), false, "the job is gone");
  assert.equal(running(childPid), false, "and so is what it started");
  assert.deepEqual(await h.service.stop(GAME, job.id, JobStopper.Person), stopped, "a second stop answers the record");

  const capped = await h.service.start(startRequest(h, "true", { hours: 1000 }));
  assert.equal(Date.parse(capped.deadlineAt) - Date.parse(capped.startedAt), JOB_MAX_HOURS * HOUR_MS);
  await h.endOf(capped.id);

  const late = await h.service.start(startRequest(h, "sleep 30", { hours: 0 }));
  assert.equal(Date.parse(late.deadlineAt) - Date.parse(late.startedAt), MINUTE_MS, "at least a minute");
  h.clock.advance(MINUTE_MS);
  const timedOut = await h.endOf(late.id);
  assert.equal(timedOut.state, JobState.TimedOut);
  assert.equal(running(late.pid ?? 0), false);
});

it("caps the log and keeps the job running", async () => {
  const h = await harness({ logMaxBytes: 1000 });
  const command = "head -c 5000 /dev/zero | tr '\\0' a; echo; echo after the cap; touch still-ran";
  const job = await h.service.start(startRequest(h, command));
  const done = await h.endOf(job.id);
  assert.equal(done.state, JobState.Succeeded, "the job ran to its own end");
  assert.equal(done.logCapped, true);
  await stat(path.join(h.cwd, "still-ran"));
  const log = await readFile(path.join(h.root, GAME, job.id, "output.log"), "utf8");
  assert.ok(log.startsWith("a".repeat(1000)), "the output up to the cap is kept");
  assert.doesNotMatch(log, /after the cap/);
  assert.match(log.trimEnd().split("\n").at(-1) ?? "", /size cap; the job keeps running/);
  assert.ok(log.length < 1200, `the log stays near its cap (${log.length} bytes)`);
});

it("tails the end of a large log without reading it whole", async () => {
  const h = await harness();
  const script = path.join(h.cwd, "big.js");
  await writeFile(
    script,
    [
      'let s = "early .*( match\\n";',
      "for (let i = 0; i < 100000; i++) s += 'line ' + i + ' ' + 'x'.repeat(40) + '\\n';",
      's += "late .*( match\\n";',
      "for (let i = 0; i < 10; i++) s += 'end ' + i + '\\n';",
      "process.stdout.write(s);",
    ].join("\n"),
  );
  const job = await h.service.start(startRequest(h, `"${process.execPath}" big.js`));
  await h.endOf(job.id);
  const size = (await stat(path.join(h.root, GAME, job.id, "output.log"))).size;
  assert.ok(size > 5_000_000, `a large log (${size} bytes)`);

  const last = await h.service.tail(GAME, job.id, { lines: 3 });
  assert.deepEqual(last?.text.split("\n"), ["end 7", "end 8", "end 9"]);
  const many = await h.service.tail(GAME, job.id, { lines: 100_000 });
  assert.ok((many?.text.split("\n").length ?? 0) <= JOB_TAIL_MAX_LINES, "lines capped");
  assert.ok((many?.text.length ?? 0) <= JOB_TAIL_MAX_CHARS, "characters capped");
  assert.match(many?.text ?? "", /end 9$/, "the newest output is the one kept");

  const found = await h.service.tail(GAME, job.id, { contains: ".*(" });
  assert.deepEqual(found?.text.split("\n"), ["late .*( match"], "a plain substring, read from the end only");
  assert.equal((await h.service.tail(GAME, job.id, { contains: "no such text" }))?.text, "");
});

it("a new app start marks jobs it did not start as interrupted, and kills a left group only when its start time matches", async () => {
  const h = await harness({ sendSignals: false });
  const ids = {
    matches: "00000000-0000-4000-8000-000000000001",
    differs: "00000000-0000-4000-8000-000000000002",
    corrupt: "00000000-0000-4000-8000-000000000003",
    endedUntold: "00000000-0000-4000-8000-000000000004",
    endedTold: "00000000-0000-4000-8000-000000000005",
  };
  const left = (id: string, pid: number, procStart: string, extra: Partial<JobRecord> = {}): JobRecord => ({
    id,
    title: "Left",
    owner: owner(),
    command: "sleep 600",
    cwd: h.cwd,
    startedAt: new Date(Date.UTC(2029, 11, 31)).toISOString(),
    state: JobState.Running,
    deadlineAt: new Date(Date.UTC(2030, 0, 1)).toISOString(),
    pid,
    procStart,
    logFile: path.join(h.root, GAME, id, "output.log"),
    logBytes: 0,
    mode: PermissionMode.Auto,
    ...extra,
  });
  const write = async (id: string, text: string) => {
    await mkdir(path.join(h.root, GAME, id), { recursive: true });
    await writeFile(path.join(h.root, GAME, id, "job.json"), text);
  };
  await write(ids.matches, JSON.stringify(left(ids.matches, 4_000_001, "Mon Jan  1 00:00:00 2030")));
  await write(ids.differs, JSON.stringify(left(ids.differs, 4_000_002, "Mon Jan  1 00:00:00 2030")));
  await write(ids.corrupt, "{ not json");
  const endedFields = { state: JobState.Succeeded, endSeq: 4, endedAt: new Date(Date.UTC(2030, 0, 1)).toISOString() };
  await write(ids.endedUntold, JSON.stringify(left(ids.endedUntold, 1, "x", endedFields)));
  await write(
    ids.endedTold,
    JSON.stringify(left(ids.endedTold, 1, "x", { ...endedFields, endSeq: 5, endLogged: true })),
  );
  const probed: number[] = [];
  const service = new JobService({
    root: h.root,
    spawn: async () => assert.fail("reconcile starts nothing"),
    clock: h.clock,
    platform: "darwin",
    probe: {
      startTime: async (pid) => {
        probed.push(pid);
        return pid === 4_000_001 ? "Mon Jan  1 00:00:00 2030" : "Tue Jan  2 00:00:00 2030";
      },
    },
    kill: (pid, signal) => {
      h.kills.push({ pid, signal });
    },
    onEnded: (record) => {
      h.ended.push(record);
    },
  });
  await service.reconcile();

  assert.deepEqual(probed.sort(), [4_000_001, 4_000_002]);
  assert.deepEqual(
    h.kills.map((kill) => kill.pid),
    [-4_000_001],
    "only the group whose start time matches is killed",
  );
  for (const id of [ids.matches, ids.differs]) {
    const record = await service.get(GAME, id);
    assert.equal(record?.state, JobState.Interrupted, id);
    assert.ok((record?.endSeq ?? 0) > 5, "ends are numbered after the game's last");
    assert.ok(record?.endedAt);
  }
  assert.equal(await readFile(path.join(h.root, GAME, ids.corrupt, "job.json"), "utf8"), "{ not json");
  assert.deepEqual(h.ended.map((record) => record.id).sort(), [ids.matches, ids.differs, ids.endedUntold].sort());
  assert.equal((await service.get(GAME, ids.endedTold))?.state, JobState.Succeeded, "an ended job stays as it was");
});

it("keeps the last fifty ended jobs per game and never removes a running one", async () => {
  const h = await harness();
  const keeper = await h.service.start(startRequest(h, "sleep 30", { title: "Server" }));
  const total = MAX_ENDED_JOBS_KEPT + 3;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const job = await h.service.start(startRequest(h, "true"));
    ids.push(job.id);
    await h.endOf(job.id);
  }
  const listed = await h.service.list(GAME);
  const ended = listed.filter((record) => record.state !== JobState.Running);
  assert.equal(ended.length, MAX_ENDED_JOBS_KEPT);
  assert.deepEqual(
    ended.map((record) => record.endSeq).sort((a, b) => (a ?? 0) - (b ?? 0)),
    Array.from({ length: MAX_ENDED_JOBS_KEPT }, (_, i) => i + 4),
    "the oldest ends go first",
  );
  for (const id of ids.slice(0, 3)) assert.equal(await h.service.get(GAME, id), null, "its folder is gone");
  assert.equal((await h.service.get(GAME, keeper.id))?.state, JobState.Running, "the running one stays");
  assert.deepEqual(
    (await h.service.list(GAME, { endedAfter: total - 2 })).map((record) => record.endSeq),
    [total - 1, total],
  );
  await h.service.stop(GAME, keeper.id, JobStopper.Agent);
});

it("stopping all jobs reaches only job processes", async () => {
  const h = await harness();
  const stray = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  strays.push(stray);
  const job = await h.service.start(startRequest(h, "sleep 30"));
  await h.service.stopAll(JobStopper.Quit);
  const record = await h.service.get(GAME, job.id);
  assert.equal(record?.state, JobState.Stopped);
  assert.equal(record?.stoppedBy, JobStopper.Quit);
  assert.equal(running(job.pid ?? 0), false, "the job is gone");
  assert.ok(stray.pid && running(stray.pid), "a process that is not a job is left alone");
  killGroup(stray.pid ?? 0);
});

/** A promise the test resolves when it chooses. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Whether `promise` has settled after the jobs' own work has had a moment to run. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(LOOK_AGAIN_MS);
  return settled;
}

it("stopping a scope waits until every one of its jobs' ends is told, finishing and starting ones too", async () => {
  const runScope = { kind: JobScopeKind.Run, runId: "run-1" } as const;
  const inRun = (h: Harness, command: string) => ({
    ...startRequest(h, command),
    owner: { ...owner(), scope: runScope },
  });
  const telling = gate<void>();
  const told: string[] = [];
  const entered = gate<string>();
  const h = await harness({
    onEnded: async (record) => {
      entered.resolve(record.id);
      await telling.promise;
      told.push(record.id);
    },
  });
  const exited = await h.service.start(inRun(h, "exit 0"));
  assert.equal(await entered.promise, exited.id, "the job exited by itself and its end is being told");
  const finishing = h.service.stopScope(undefined, runScope, JobStopper.ScopeEnded);
  assert.equal(await settledSoon(finishing), false, "the stop waits for the end that is still being told");
  telling.resolve();
  await finishing;
  assert.deepEqual(told, [exited.id], "its end was told before the stop answered");

  const spawning = gate<void>();
  const slow = await harness({
    spawn: async (request) => {
      await spawning.promise;
      const child = spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, detached: true, stdio: "pipe" });
      return { child, sandboxed: false };
    },
  });
  const starting = slow.service.start(inRun(slow, "sleep 30"));
  const stopping = slow.service.stopScope(undefined, runScope, JobStopper.ScopeEnded);
  assert.equal(await settledSoon(stopping), false, "the stop waits for the start in flight");
  spawning.resolve();
  const job = await starting;
  await stopping;
  assert.equal(slow.ended.find((record) => record.id === job.id)?.stoppedBy, JobStopper.ScopeEnded, "it was stopped");
  assert.equal(running(job.pid ?? 0), false, "the job is gone");
});

it("answers nothing for an id or a game it does not hold", async () => {
  const h = await harness();
  const job = await h.service.start(startRequest(h, "true"));
  await h.endOf(job.id);
  for (const [project, id] of [
    [GAME, ""],
    [GAME, "../x"],
    [GAME, `${job.id}/../${job.id}`],
    ["other-game", job.id],
    ["..", job.id],
  ] as const) {
    assert.equal(await h.service.get(project, id), null, `${project} ${id}`);
    assert.equal(await h.service.tail(project, id, {}), null, `${project} ${id}`);
    assert.equal(await h.service.stop(project, id, JobStopper.Agent), null, `${project} ${id}`);
  }
  assert.deepEqual(await h.service.list(".."), []);
});
