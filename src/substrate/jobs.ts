/**
 * Agent jobs: long processes (a build, a headless run, a server, a render) the app starts for the
 * chat's agent, a lead or a worker and owns itself, so they outlive the agent's turn and a harness
 * restart. Each runs through ProcessSandbox under the policy its caller built, in its own process
 * group, with its output in a log and its record on disk per game (`job-registry.ts`). It ends on
 * its own, by a stop, at its time limit, with its scope, or when Genex quits; a later app start
 * marks what an earlier one left as interrupted. Electron-free.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import {
  isEndedJob,
  type JobOwner,
  type JobRecord,
  type JobScope,
  JobState,
  type JobStopper,
  jobTitle,
} from "../shared/jobs.ts";
import type { PermissionMode } from "../shared/permissions.ts";
import {
  closeJobLog,
  type JobClock,
  type JobExit,
  type JobKill,
  type JobProbe,
  jobEnd,
  openJobLog,
  pipeJobOutput,
  psProbe,
  SYSTEM_CLOCK,
  signalGroup,
  signalJob,
} from "./job-process.ts";
import {
  isJobId,
  isJobProject,
  jobFolder,
  type JobTail,
  jobLogFile,
  jobProjects,
  lastEndSeq,
  pruneEndedJobs,
  readGameJobs,
  readJobRecord,
  tailLog,
  writeJobRecord,
} from "./job-registry.ts";
import type { SandboxPolicy } from "./spawn.ts";
import { isWindows } from "./toolchain.ts";

export type { JobClock, JobKill, JobProbe, JobTail };

/** How long a job may run when its starter names no limit. */
export const JOB_DEFAULT_HOURS = 2;
/** The longest a job may run. */
export const JOB_MAX_HOURS = 24;
/** The shortest limit a job may be given: one minute. */
const JOB_MIN_HOURS = MINUTE_MS / HOUR_MS;
/** The most jobs of one game running at once. */
export const MAX_RUNNING_JOBS_PER_GAME = 8;
/** The ended jobs of one game whose records and logs are kept; older ones are removed. */
export const MAX_ENDED_JOBS_KEPT = 50;
/** The most a job's log holds; past it the job runs on and its output is dropped. */
export const JOB_LOG_MAX_BYTES = 64 * 1024 ** 2;
/** The most lines a tail hands back. */
export const JOB_TAIL_MAX_LINES = 400;
/** The lines a tail hands back when none are asked for. */
export const JOB_TAIL_DEFAULT_LINES = 50;
/** The most characters a tail hands back. */
export const JOB_TAIL_MAX_CHARS = 12_000;
/** The most of a log's end a tail reads. */
const JOB_TAIL_SCAN_BYTES = 1024 ** 2;
/** The longest command a job may run. */
export const JOB_COMMAND_MAX_CHARS = 4_000;
/** How long a stopped job's group has after SIGTERM before SIGKILL. */
export const JOB_STOP_GRACE_MS = 3 * SECOND_MS;
/** How long a job's output may stay open after its process exited (something it left holds it). */
const JOB_DRAIN_MS = 2 * SECOND_MS;

/** Why a job did not start (`JobRefusal.code`). Never rename a value: the job tools answer by it. */
export const JobRefusalCode = {
  TooMany: "too_many",
  EmptyCommand: "empty_command",
  CommandTooLong: "command_too_long",
  BadProject: "bad_project",
} as const;
export type JobRefusalCode = (typeof JobRefusalCode)[keyof typeof JobRefusalCode];

const MESSAGE = {
  refused: (code: JobRefusalCode) => `The job did not start: ${code}`,
} as const;

/** A job the registry would not start; nothing was spawned or written. */
export class JobRefusal extends Error {
  readonly code: JobRefusalCode;
  constructor(code: JobRefusalCode) {
    super(MESSAGE.refused(code));
    this.name = "JobRefusal";
    this.code = code;
  }
}

/** Starts a job's process in its own group (production: `ProcessSandbox.spawnLongLived`). */
export type JobSpawn = (request: {
  command: string;
  cwd: string;
  label: string;
  policy: Partial<SandboxPolicy>;
}) => Promise<{ child: ChildProcess; sandboxed: boolean }>;

/** What a job's start asks for: whose it is, what it runs where, under which policy and for how long. */
export interface JobStartRequest {
  owner: JobOwner;
  title: string;
  command: string;
  cwd: string;
  policy: Partial<SandboxPolicy>;
  /** Its time limit in hours (default {@link JOB_DEFAULT_HOURS}, one minute to {@link JOB_MAX_HOURS}). */
  hours?: number;
  mode: PermissionMode;
}

/** What a {@link JobService} is built from. */
export interface JobServiceOptions {
  /** The folder holding every game's job folders (`StudioLayout.jobs`). */
  root: string;
  spawn: JobSpawn;
  probe?: JobProbe;
  clock?: JobClock;
  kill?: JobKill;
  /** Hears each start once its record is on disk. */
  onStarted?: (record: JobRecord) => void | Promise<void>;
  /** Hears each end once its record is on disk, and on a later start each end not yet logged. */
  onEnded?: (record: JobRecord) => void | Promise<void>;
  platform?: NodeJS.Platform;
  /** The most a job's log holds (default {@link JOB_LOG_MAX_BYTES}); a test seam. */
  logMaxBytes?: number;
}

/** How a stop ends a job: as stopped, by someone, or as past its time limit. */
type Ending = { state: typeof JobState.Stopped; by: JobStopper } | { state: typeof JobState.TimedOut };

/** A job this app started and still runs. */
interface LiveJob {
  record: JobRecord;
  child: ChildProcess;
  ending: Ending | null;
  deadline: unknown;
  started: Promise<JobRecord>;
  ended: Promise<JobRecord>;
  stopping: Promise<JobRecord> | null;
}

const copy = (record: JobRecord): JobRecord => structuredClone(record);

/** Whether two scopes are the same chat, run or turn. */
function sameScope(a: JobScope, b: JobScope): boolean {
  if (a.kind !== b.kind) return false;
  if ("runId" in a && "runId" in b) return a.runId === b.runId;
  if ("turn" in a && "turn" in b) return a.turn === b.turn;
  return true;
}

/** A job's time limit in milliseconds: its hours, clamped. */
function deadlineMs(hours: number | undefined): number {
  const asked = typeof hours === "number" && Number.isFinite(hours) ? hours : JOB_DEFAULT_HOURS;
  return Math.min(JOB_MAX_HOURS, Math.max(JOB_MIN_HOURS, asked)) * HOUR_MS;
}

/** Ended first by end number, then running ones by start. */
function byEnd(a: JobRecord, b: JobRecord): number {
  const order = (a.endSeq ?? Number.POSITIVE_INFINITY) - (b.endSeq ?? Number.POSITIVE_INFINITY);
  return Number.isNaN(order) || order === 0 ? a.startedAt.localeCompare(b.startedAt) : order;
}

/** The refusal a start request earns before anything is spawned, if any. */
function refusalOf(request: JobStartRequest): JobRefusalCode | null {
  if (!isJobProject(request.owner.project)) return JobRefusalCode.BadProject;
  const command = request.command.trim();
  if (command === "") return JobRefusalCode.EmptyCommand;
  if (command.length > JOB_COMMAND_MAX_CHARS) return JobRefusalCode.CommandTooLong;
  return null;
}

/** The app's agent jobs: started, listed, tailed and stopped here, and nowhere else. */
export class JobService {
  readonly #root: string;
  readonly #spawn: JobSpawn;
  readonly #probe: JobProbe;
  readonly #clock: JobClock;
  readonly #kill: JobKill | undefined;
  readonly #onStarted: JobServiceOptions["onStarted"];
  readonly #onEnded: JobServiceOptions["onEnded"];
  readonly #platform: NodeJS.Platform;
  readonly #logMaxBytes: number;
  readonly #live = new Map<string, LiveJob>();
  /** Starts in flight per game, counted against its running jobs. */
  readonly #reserved = new Map<string, number>();
  /** Starts in flight, by whose job each will be. */
  readonly #starting = new Map<Promise<unknown>, JobOwner>();
  /** Jobs whose process ended and whose end is still being told (`onEnded`). */
  readonly #finishing = new Map<string, LiveJob>();
  /** The last end number per game, once read. */
  readonly #seq = new Map<string, number>();
  /** One writer of a game's records at a time. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: JobServiceOptions) {
    this.#root = options.root;
    this.#spawn = options.spawn;
    this.#platform = options.platform ?? process.platform;
    this.#probe = options.probe ?? psProbe(this.#platform);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#kill = options.kill;
    this.#onStarted = options.onStarted;
    this.#onEnded = options.onEnded;
    this.#logMaxBytes = options.logMaxBytes ?? JOB_LOG_MAX_BYTES;
  }

  /** Start a job, or refuse it ({@link JobRefusal}) with nothing spawned or written. */
  async start(request: JobStartRequest): Promise<JobRecord> {
    const refused = refusalOf(request);
    if (refused) throw new JobRefusal(refused);
    const project = request.owner.project;
    const reserved = this.#reserved.get(project) ?? 0;
    if (this.#runningIn(project) + reserved >= MAX_RUNNING_JOBS_PER_GAME) throw new JobRefusal(JobRefusalCode.TooMany);
    this.#reserved.set(project, reserved + 1);
    const starting = this.#launch(request).finally(() => {
      this.#reserved.set(project, (this.#reserved.get(project) ?? 1) - 1);
    });
    this.#starting.set(starting, request.owner);
    void starting.then(
      () => this.#starting.delete(starting),
      () => this.#starting.delete(starting),
    );
    return starting;
  }

  /** A game's jobs, ended ones by end number then running ones; only one scope's, or only ends after `endedAfter`. */
  async list(project: string, filter: { scope?: JobScope; endedAfter?: number } = {}): Promise<JobRecord[]> {
    if (!isJobProject(project)) return [];
    const records = new Map((await readGameJobs(this.#root, project)).map((record) => [record.id, record]));
    for (const live of this.#live.values())
      if (live.record.owner.project === project) records.set(live.record.id, copy(live.record));
    const { scope, endedAfter } = filter;
    return [...records.values()]
      .filter((record) => !scope || sameScope(record.owner.scope, scope))
      .filter((record) => endedAfter === undefined || (record.endSeq ?? 0) > endedAfter)
      .sort(byEnd);
  }

  /**
   * {@link list} and the game's last end number, read together while no end is being numbered: a
   * reader that goes on from `seq` misses no end and hears none twice. A game it does not hold has
   * nothing and number 0.
   */
  async listWithSeq(
    project: string,
    filter: { scope?: JobScope; endedAfter?: number } = {},
  ): Promise<{ records: JobRecord[]; seq: number }> {
    if (!isJobProject(project)) return { records: [], seq: 0 };
    return this.#locked(project, async () => ({
      records: await this.list(project, filter),
      seq: await this.#lastSeq(project),
    }));
  }

  /** One job of a game, or null for an id or a game it does not hold. */
  async get(project: string, id: string): Promise<JobRecord | null> {
    if (!isJobProject(project) || !isJobId(id)) return null;
    const live = this.#live.get(id);
    if (live) return live.record.owner.project === project ? copy(live.record) : null;
    return readJobRecord(this.#root, project, id);
  }

  /** The end of a job's log: its last lines (capped), or only those holding `contains` as plain text. */
  async tail(project: string, id: string, ask: { lines?: number; contains?: string }): Promise<JobTail | null> {
    if (!(await this.get(project, id))) return null;
    const asked = Math.floor(ask.lines ?? JOB_TAIL_DEFAULT_LINES);
    const lines = Math.min(JOB_TAIL_MAX_LINES, Math.max(1, Number.isFinite(asked) ? asked : JOB_TAIL_DEFAULT_LINES));
    return tailLog(jobLogFile(this.#root, project, id), {
      lines,
      maxChars: JOB_TAIL_MAX_CHARS,
      scanBytes: JOB_TAIL_SCAN_BYTES,
      contains: ask.contains || undefined,
    });
  }

  /** Stop one job (SIGTERM to its group, then SIGKILL); an ended job answers its record, an unknown one null. */
  async stop(project: string, id: string, by: JobStopper): Promise<JobRecord | null> {
    const live = isJobId(id) ? this.#live.get(id) : undefined;
    if (!live || live.record.owner.project !== project) return this.get(project, id);
    return this.#stopLive(live, { state: JobState.Stopped, by });
  }

  /**
   * Stop every running job of one scope, in one game or (`project` undefined) in all, its starts in
   * flight included. Answers once each of the scope's ends is told, the ends of jobs that exited by
   * themselves just before included, with the records of the jobs it stopped.
   */
  async stopScope(project: string | undefined, scope: JobScope, by: JobStopper): Promise<JobRecord[]> {
    const inScope = (owner: JobOwner) =>
      (project === undefined || owner.project === project) && sameScope(owner.scope, scope);
    const starts = [...this.#starting].filter(([, owner]) => inScope(owner)).map(([start]) => start);
    await Promise.allSettled(starts);
    const finishing = [...this.#finishing.values()].filter((live) => inScope(live.record.owner));
    const matching = [...this.#live.values()].filter((live) => inScope(live.record.owner));
    const [stopped] = await Promise.all([
      Promise.all(matching.map((live) => this.#stopLive(live, { state: JobState.Stopped, by }))),
      Promise.allSettled(finishing.map((live) => live.ended)),
    ]);
    return stopped;
  }

  /** Stop every job this app runs, starts in flight included, all within one grace period. */
  async stopAll(by: JobStopper): Promise<JobRecord[]> {
    await Promise.allSettled([...this.#starting.keys()]);
    const live = [...this.#live.values()];
    return Promise.all(live.map((job) => this.#stopLive(job, { state: JobState.Stopped, by })));
  }

  /**
   * On app start: every record still running that this app did not start is closed as
   * interrupted, its process group killed first when (POSIX only) the recorded start time still
   * matches, so a reused id is never hit. Each such end, and each earlier end whose chat record
   * was never written, is handed to `onEnded` once. A record that does not parse is left as it is.
   */
  async reconcile(): Promise<void> {
    const toTell: JobRecord[] = [];
    for (const project of await jobProjects(this.#root)) {
      for (const record of await readGameJobs(this.#root, project)) {
        if (this.#live.has(record.id)) continue;
        if (!isEndedJob(record)) toTell.push(await this.#interrupt(record));
        else if (record.endLogged !== true) toTell.push(record);
      }
    }
    for (const record of toTell) await this.#tellEnded(record);
  }

  /** Note that the chat's agent has been told how these jobs ended. */
  async markTold(project: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.#mark(project, id, { toldChat: true });
  }

  /** Note that a job's end is recorded in its chat. */
  async markEndLogged(project: string, id: string): Promise<void> {
    await this.#mark(project, id, { endLogged: true });
  }

  #runningIn(project: string): number {
    return [...this.#live.values()].filter((live) => live.record.owner.project === project).length;
  }

  /** Make the job's folder and log, spawn it, and announce it once its record is on disk. */
  async #launch(request: JobStartRequest): Promise<JobRecord> {
    const id = randomUUID();
    const { project } = request.owner;
    const folder = jobFolder(this.#root, project, id);
    await mkdir(folder, { recursive: true });
    const logFile = jobLogFile(this.#root, project, id);
    const log = await openJobLog(logFile);
    let child: ChildProcess;
    try {
      ({ child } = await this.#spawn({
        command: request.command,
        cwd: request.cwd,
        label: `job-${id}`,
        policy: request.policy,
      }));
    } catch (error) {
      await closeJobLog(log);
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
    const startedAt = this.#clock.now();
    const record: JobRecord = {
      id,
      title: jobTitle(request.title, request.command),
      owner: structuredClone(request.owner),
      command: request.command,
      cwd: request.cwd,
      startedAt: new Date(startedAt).toISOString(),
      state: JobState.Running,
      deadlineAt: new Date(startedAt + deadlineMs(request.hours)).toISOString(),
      pid: child.pid,
      logFile,
      logBytes: 0,
      mode: request.mode,
    };
    return this.#run(record, child, log, deadlineMs(request.hours));
  }

  /** Watch a spawned job to its end, write its record, arm its time limit and announce it. */
  #run(record: JobRecord, child: ChildProcess, log: WriteStream, limitMs: number): Promise<JobRecord> {
    child.stdin?.end();
    pipeJobOutput(child, log, this.#logMaxBytes, (bytes, capped) => {
      record.logBytes = bytes;
      if (capped) record.logCapped = true;
    });
    const exit = jobEnd(child, () => this.#clearLeftovers(live), this.#clock, JOB_DRAIN_MS);
    const arm = () => {
      live.deadline = this.#clock.setTimeout(() => void this.#stopLive(live, { state: JobState.TimedOut }), limitMs);
    };
    const started = this.#announce(record, arm);
    const live: LiveJob = {
      record,
      child,
      ending: null,
      deadline: undefined,
      stopping: null,
      started,
      ended: started
        .then(
          () => exit,
          () => exit,
        )
        .then((end) => this.#finish(live, end, log)),
    };
    this.#live.set(record.id, live);
    // A record that could not be written leaves no job running unseen; the end is still handled.
    void started.catch(() => this.#signal(live, "SIGKILL"));
    void live.ended.catch(() => {});
    return started;
  }

  /** Write the record, arm the time limit, then tell `onStarted`: all before the job's end is handled. */
  async #announce(record: JobRecord, arm: () => void): Promise<JobRecord> {
    if (record.pid && !isWindows(this.#platform))
      record.procStart = (await this.#probe.startTime(record.pid).catch(() => null)) ?? undefined;
    await this.#locked(record.owner.project, () => writeJobRecord(this.#root, record));
    arm();
    const started = copy(record);
    await Promise.resolve(this.#onStarted?.(copy(started))).catch(() => {});
    return started;
  }

  /** After a job's own process exits by itself, nothing it started outlives it. */
  #clearLeftovers(live: LiveJob): void {
    if (live.ending || isWindows(this.#platform)) return;
    signalGroup(live.record.pid, "SIGKILL", this.#kill);
  }

  /**
   * Signal a job this app runs. POSIX signals its group only, never the lone id, which may belong
   * to another process once the job's own has exited; Windows ends the tree while the job runs.
   */
  async #signal(live: LiveJob, signal: NodeJS.Signals): Promise<void> {
    if (!isWindows(this.#platform)) return signalGroup(live.record.pid, signal, this.#kill);
    if (live.child.exitCode !== null || live.child.signalCode !== null) return;
    await signalJob(live.record.pid, signal, { kill: this.#kill, platform: this.#platform });
  }

  async #finish(live: LiveJob, end: JobExit, log: WriteStream): Promise<JobRecord> {
    this.#clock.clearTimeout(live.deadline);
    await closeJobLog(log);
    const { record } = live;
    const { ending } = live;
    record.state = ending?.state ?? (end.exitCode === 0 ? JobState.Succeeded : JobState.Failed);
    if (ending && "by" in ending) record.stoppedBy = ending.by;
    record.exitCode = end.exitCode;
    record.signal = end.signal;
    record.endedAt = new Date(this.#clock.now()).toISOString();
    await this.#saveEnd(record);
    this.#live.delete(record.id);
    this.#finishing.set(record.id, live);
    const ended = copy(record);
    try {
      await this.#tellEnded(ended);
    } finally {
      this.#finishing.delete(record.id);
    }
    return ended;
  }

  /** Number the end, write the record and drop the game's oldest ended jobs beyond the kept count. */
  async #saveEnd(record: JobRecord): Promise<void> {
    const { project } = record.owner;
    await this.#locked(project, async () => {
      record.endSeq = (await this.#lastSeq(project)) + 1;
      this.#seq.set(project, record.endSeq);
      await writeJobRecord(this.#root, record);
      await pruneEndedJobs(this.#root, project, MAX_ENDED_JOBS_KEPT, (id) => this.#live.has(id) && id !== record.id);
    });
  }

  async #tellEnded(record: JobRecord): Promise<void> {
    await Promise.resolve(this.#onEnded?.(copy(record))).catch(() => {});
  }

  async #lastSeq(project: string): Promise<number> {
    const known = this.#seq.get(project);
    if (known !== undefined) return known;
    return lastEndSeq(await readGameJobs(this.#root, project));
  }

  #stopLive(live: LiveJob, ending: Ending): Promise<JobRecord> {
    live.ending ??= ending;
    live.stopping ??= this.#terminate(live);
    return live.stopping;
  }

  /** SIGTERM to the group; SIGKILL once the grace period passes without an end. */
  async #terminate(live: LiveJob): Promise<JobRecord> {
    await this.#signal(live, "SIGTERM");
    let grace: unknown;
    const graceOver = new Promise<void>((resolve) => {
      grace = this.#clock.setTimeout(resolve, JOB_STOP_GRACE_MS);
    });
    const first = await Promise.race([live.ended.then(() => false), graceOver.then(() => true)]);
    this.#clock.clearTimeout(grace);
    if (first) await this.#signal(live, "SIGKILL");
    return live.ended;
  }

  /** Close a record an earlier app left running; kill its group only when it is the same process. */
  async #interrupt(record: JobRecord): Promise<JobRecord> {
    if (record.pid && record.procStart && !isWindows(this.#platform)) {
      const now = await this.#probe.startTime(record.pid).catch(() => null);
      if (now === record.procStart)
        await signalJob(record.pid, "SIGKILL", { kill: this.#kill, platform: this.#platform });
    }
    const closed: JobRecord = {
      ...record,
      state: JobState.Interrupted,
      endedAt: new Date(this.#clock.now()).toISOString(),
    };
    await this.#saveEnd(closed);
    return copy(closed);
  }

  async #mark(project: string, id: string, fields: Pick<JobRecord, "toldChat" | "endLogged">): Promise<void> {
    if (!isJobProject(project) || !isJobId(id)) return;
    await this.#locked(project, async () => {
      const live = this.#live.get(id);
      const record = live?.record ?? (await readJobRecord(this.#root, project, id));
      if (!record || record.owner.project !== project) return;
      Object.assign(record, fields);
      await writeJobRecord(this.#root, record);
    });
  }

  /** Run `fn` once every earlier write of the game's records is done. */
  #locked<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(project) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#locks.set(
      project,
      next.catch(() => {}),
    );
    return next;
  }
}
