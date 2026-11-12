/**
 * The chat is woken when a background job its agent started ends. A plugin tool whose manifest
 * names a `jobStatus` (an Unreal package, a plugin build) answers `{started: true}` at once, and a
 * `job_start` command runs past the turn; an agent that said "I'll test it once it's packaged" and
 * ended its turn would otherwise hear of the end only from the person's next message.
 *
 * - **Plugin jobs.** Genex reads the status tool every {@link JOB_WATCH_POLL_MS}, with the arguments
 *   of the starting call it declares, until it answers `jobRunning: false`; then one hidden message
 *   (`MessageOrigin.JobEnded`) starts the chat's next turn, or joins the turn that is running. The
 *   agent's own read of the status tool answering `false` ends the watch unasked: it knows. A new
 *   call of the starting tool replaces the watch, and one that started nothing (a stop) ends it. A
 *   status tool that keeps answering neither, or a job past {@link JOB_WATCH_MAX_MS}, ends the watch
 *   with no message. Only the chat's own session's calls are watched: a Loop's lead and its workers
 *   follow their own jobs.
 * - **`job_start` jobs.** A chat's own job that finished, failed or ran out of time wakes the chat
 *   with its line, and counts as told; one someone stopped (the agent, the person, quitting Genex)
 *   or one an earlier Genex left running wakes nothing, and the next turn's notice says it.
 *
 * It lives on the host, so every engine's chat is woken the same way, and decides from typed fields
 * only: the manifest's `jobStatus`, the answers' `started` and `jobRunning`, the job's state.
 */
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type JobRecord, JobRole, JobState } from "../../shared/jobs.ts";
import { type PluginBinding, PluginToolAudience, pluginJobRunning, startedPluginJob } from "../../shared/plugins.ts";
import { MessageOrigin } from "../../shared/protocol.ts";
import type { JobService } from "../../substrate/jobs.ts";
import type { StudioCore } from "../studio-core.ts";
import { jobNotice } from "./delegation-prompts.ts";
import { chatChoice } from "./desktop-assist.ts";
import { JOB_WAKE_PROMPT } from "./job-wake-prompts.ts";

/** How often Genex reads a watched job's status tool. */
export const JOB_WATCH_POLL_MS = 15 * SECOND_MS;
/** The longest Genex watches one job: past the longest any plugin job runs (an Unreal package's two hours). */
export const JOB_WATCH_MAX_MS = 3 * HOUR_MS;
/** How many reads in a row may answer neither running nor ended (or fail) before the watch ends. */
export const JOB_WATCH_MISSES_MAX = 3;

/** The ends of a chat's own `job_start` job that wake the chat: those that came by themselves. */
const WAKING_ENDS: ReadonlySet<JobState> = new Set([JobState.Succeeded, JobState.Failed, JobState.TimedOut]);

const MESSAGE = {
  watchGaveUp: (status: string, why: string) => `[core] stopped watching ${status} for its job's end: ${why}`,
  notWoken: (threadId: string, error: unknown) =>
    `[core] the chat ${threadId} wasn't told its job ended: ${errorMessage(error)}`,
  pastMax: "it ran past the longest a job is watched",
  unread: "its answers said neither running nor ended",
} as const;

/** Runs `fire` after `ms` and returns what calls it off: real timers, or a test's own clock. */
export type WatchSchedule = (fire: () => void, ms: number) => () => void;

/** What watching plugin jobs needs of the host. */
export interface JobWakeDeps {
  /** The status tool an agent tool `<plugin>__<tool>` names for its job, with its parameters; null for none. */
  jobStatusOf(name: string): { status: string; parameters: readonly string[] } | null;
  /** Genex's own read of a status tool for the bound game. */
  readStatus(
    status: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** Starts the chat's next turn with Genex's words (or joins its running turn). */
  wake(threadId: string, project: string, text: string): Promise<void>;
  schedule: WatchSchedule;
  now(): number;
  log(line: string): void;
}

/** One job being watched: the tools, the status read's arguments, the chat, and how the reads went. */
interface Watch {
  start: string;
  status: string;
  args: Record<string, unknown>;
  binding: PluginBinding & { threadId: string };
  since: number;
  misses: number;
  reading: AbortController;
  cancel: () => void;
}

/** A watch's key: one per chat and status tool, so a new start of a job it reports replaces the old watch. */
const watchKey = (threadId: string, status: string) => `${threadId}\u0000${status}`;

/** The starting call's arguments the status tool declares, as its read passes them. */
function statusArgs(args: Record<string, unknown>, parameters: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(parameters.filter((name) => args[name] !== undefined).map((name) => [name, args[name]]));
}

/** The plugin jobs the chats' own sessions started, each watched until it ends (module comment). */
export class PluginJobWatches {
  readonly #deps: JobWakeDeps;
  readonly #watches = new Map<string, Watch>();

  constructor(deps: JobWakeDeps) {
    this.#deps = deps;
  }

  /** How many jobs are watched now. */
  get size(): number {
    return this.#watches.size;
  }

  /**
   * A plugin call of a chat's own session answered: a starting tool's call starts (or replaces, or
   * ends) its job's watch, and a status read that says the job ended ends it, as the agent knows.
   */
  called(name: string, args: Record<string, unknown>, binding: PluginBinding, answer: unknown): void {
    const threadId = binding.threadId;
    if (!threadId) return;
    const job = this.#deps.jobStatusOf(name);
    if (job) {
      this.#watch(name, job, args, { ...binding, threadId }, answer);
      return;
    }
    if (pluginJobRunning(answer) === false) this.#end(watchKey(threadId, name));
  }

  /** Whether a job a chat of `project` started is being watched now. */
  watching(project: string): boolean {
    return [...this.#watches.values()].some((watch) => watch.binding.project === project);
  }

  /** Ends every watch with no message: the core stops. */
  dispose(): void {
    for (const key of [...this.#watches.keys()]) this.#end(key);
  }

  #watch(
    start: string,
    job: { status: string; parameters: readonly string[] },
    args: Record<string, unknown>,
    binding: Watch["binding"],
    answer: unknown,
  ): void {
    const key = watchKey(binding.threadId, job.status);
    this.#end(key);
    if (!startedPluginJob(answer)) return;
    const watch: Watch = {
      start,
      status: job.status,
      args: statusArgs(args, job.parameters),
      binding,
      since: this.#deps.now(),
      misses: 0,
      reading: new AbortController(),
      cancel: () => {},
    };
    this.#watches.set(key, watch);
    this.#next(key, watch);
  }

  #next(key: string, watch: Watch): void {
    watch.cancel = this.#deps.schedule(() => void this.#look(key, watch), JOB_WATCH_POLL_MS);
  }

  #end(key: string): void {
    const watch = this.#watches.get(key);
    if (!watch) return;
    this.#watches.delete(key);
    watch.cancel();
    watch.reading.abort();
  }

  /** One read of the status tool: on again while the job runs, the chat woken once it has ended. */
  async #look(key: string, watch: Watch): Promise<void> {
    if (this.#watches.get(key) !== watch) return;
    if (this.#deps.now() - watch.since >= JOB_WATCH_MAX_MS) {
      this.#end(key);
      this.#deps.log(MESSAGE.watchGaveUp(watch.status, MESSAGE.pastMax));
      return;
    }
    const { status, args, binding, reading } = watch;
    const answer = await this.#deps.readStatus(status, args, binding, reading.signal).catch(() => null);
    if (this.#watches.get(key) !== watch) return;
    const running = pluginJobRunning(answer);
    if (running === true) watch.misses = 0;
    else if (running === null) watch.misses += 1;
    if (running === true || (running === null && watch.misses < JOB_WATCH_MISSES_MAX)) {
      this.#next(key, watch);
      return;
    }
    this.#end(key);
    if (running === null) {
      this.#deps.log(MESSAGE.watchGaveUp(status, MESSAGE.unread));
      return;
    }
    await this.#deps
      .wake(binding.threadId, binding.project, JOB_WAKE_PROMPT.plugin(watch.start, status))
      .catch((error: unknown) => this.#deps.log(MESSAGE.notWoken(binding.threadId, error)));
  }
}

/** Whether a `job_start` job's end wakes its chat: the chat's own session's, ended by itself, its agent not told yet. */
export function wakesChat(record: JobRecord): boolean {
  return record.owner.role === JobRole.Chat && record.toldChat !== true && WAKING_ENDS.has(record.state);
}

/** What waking a chat for its `job_start` job needs: the wake, the log and the registry's told marks. */
export type JobEndWakeDeps = Pick<JobWakeDeps, "wake" | "log"> & {
  jobs: Pick<JobService, "markTold" | "markUntold">;
};

/**
 * Wake the chat a `job_start` job of its own session ended in, when that end wakes it. The job is
 * marked told first, so the woken turn's own notice does not tell it again; a wake that never
 * reached the chat takes the mark back, and the next turn's notice tells it.
 */
export async function wakeForJob(record: JobRecord, deps: JobEndWakeDeps): Promise<void> {
  if (!wakesChat(record)) return;
  const { project, chatThreadId } = record.owner;
  const ids = [record.id];
  try {
    await deps.jobs.markTold(project, ids);
    await deps.wake(chatThreadId, project, JOB_WAKE_PROMPT.jobs(jobNotice([record])));
  } catch (error) {
    deps.log(MESSAGE.notWoken(chatThreadId, error));
    await deps.jobs.markUntold(project, ids).catch(() => {});
  }
}

/** The real schedule: a timer that never holds the app open by itself. */
export const realSchedule: WatchSchedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Start a chat's next turn with Genex's words, or join the turn running: one hidden message from
 * `origin`, on the chat's last model. A job's end wakes the chat so, and so does a `wake_later`
 * timer (`wake-later.ts`).
 */
export async function wakeChat(
  core: StudioCore,
  origin: MessageOrigin,
  wake: { threadId: string; project: string; text: string },
): Promise<void> {
  const choice = await chatChoice(core, wake.threadId);
  await core.sendUserMessage(wake.text, { thread: wake.threadId, project: wake.project, origin, ...choice });
}

/**
 * The core's side of waking a chat: the registry's `jobStatus`, Genex's own read of a status tool
 * (asking nothing: a status tool has no card), and one hidden message on the chat's last model.
 */
export function coreJobWake(core: StudioCore): JobWakeDeps {
  return {
    jobStatusOf: (name) => core.plugins.jobStatusOf(name),
    readStatus: (status, args, binding, signal) =>
      core.plugins.tool(status, args, binding, signal, PluginToolAudience.Harness),
    wake: (threadId, project, text) => wakeChat(core, MessageOrigin.JobEnded, { threadId, project, text }),
    schedule: realSchedule,
    now: Date.now,
    log: (line) => core.options.onLog?.(line, "stderr"),
  };
}
