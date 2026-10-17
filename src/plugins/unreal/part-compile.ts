/**
 * check-part's compiles of a part's C++: one job per builder's copy of the game, keyed by the
 * copy's .uproject and a fingerprint of everything the build reads that may change (the part's
 * C++, the module's rules, the copy's Source, Plugins and .uproject, the engine). A compile takes
 * 45-90 s and a plugin tool call ends near 190 s, so check-part waits at most
 * {@link CHECK_COMPILE_WAIT_MS} and never past {@link CHECK_ANSWER_BY_MS} into the call, then
 * answers that the C++ is still compiling; the compile keeps running, and the next call for the
 * same C++ picks up its result. A finished result for the same C++ is reused; changed C++ stops
 * the copy's running compile and starts once it ended, so two builds never share a copy's
 * Intermediate folder. A result that says nothing about the code (stopped, timed out, another
 * build's lock, not started) is answered once, then compiled again.
 *
 * UnrealBuildTool can miss a source written within about a second after its last build ended and
 * call the target up to date, so a compile is told when the copy's previous one ended and
 * {@link freshenSources} moves such a file's write time past {@link UBT_TIME_GRAIN_MS}.
 */
import { createHash } from "node:crypto";
import { lstat, lutimes } from "node:fs/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CompileFailure, type CompileResult } from "./ubt.ts";

/** How long check-part waits for a compile before answering that it is still compiling. */
export const CHECK_COMPILE_WAIT_MS = 140 * SECOND_MS;
/** How far into its call check-part answers at the latest: 20 s inside a plugin call's 190 s. */
export const CHECK_ANSWER_BY_MS = 170 * SECOND_MS;
/** How long after a build ended UnrealBuildTool may miss a source written: about a second and a half, with room. */
export const UBT_TIME_GRAIN_MS = 2 * SECOND_MS;
/** How many copies' compiles are remembered; the oldest finished ones are forgotten first. */
const MAX_JOBS = 32;
/** The results that say what the code is: kept for the same C++. */
const KEPT: ReadonlySet<CompileFailure | undefined> = new Set([
  undefined,
  CompileFailure.Failed,
  CompileFailure.Invalid,
  CompileFailure.Unsupported,
]);

/** Starts a compile, told when the copy's previous one ended (if this process saw one); it ends early when `signal` aborts. */
export type StartCompile = (signal: AbortSignal, previousEnd: number | undefined) => Promise<CompileResult>;
/** Waits before answering "still compiling"; `signal` aborts once the compile answered first. */
export type CompileWait = (signal: AbortSignal) => Promise<void>;
/** What a part's compile reads that may change between two check-part calls. */
export type CppInput = {
  part: string;
  /** The part's C++ files by their path inside its folder. */
  files: Record<string, string>;
  /** The module's rules file's text. */
  buildRules: string;
  engineDir: string;
  /** A stamp of the rest of what the copy builds: its Source, Plugins and .uproject. */
  tree: string;
};

/** The compiles check-part runs, one per builder's copy. */
export type CompileJobs = {
  /**
   * The compile of the copy `project` at `hash`: the copy's running or kept one for that hash, else
   * a new one from `start` (a different hash stops the copy's running compile first). Its result,
   * or undefined when `wait` ends first; the compile then keeps running for the next call.
   */
  result(project: string, hash: string, start: StartCompile, wait: CompileWait): Promise<CompileResult | undefined>;
};

type Job = { hash: string; controller: AbortController; done: Promise<CompileResult>; result?: CompileResult };

const notStarted = (failure: unknown): CompileResult => ({
  ok: false,
  seconds: 0,
  errors: [],
  summary: errorMessage(failure),
  failure: CompileFailure.NotStarted,
  retryable: false,
});

/** How long check-part may still wait for a compile, `elapsedMs` into its call. */
export function compileWaitMs(elapsedMs: number): number {
  return Math.max(0, Math.min(CHECK_COMPILE_WAIT_MS, CHECK_ANSWER_BY_MS - Math.max(0, elapsedMs)));
}

/** A fingerprint of what a part's compile reads: each C++ file by its path, whatever order it was read in. */
export function cppFingerprint(input: CppInput): string {
  const entries = Object.entries(input.files).sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return createHash("sha256")
    .update(JSON.stringify([input.part, entries, input.buildRules, input.engineDir, input.tree]))
    .digest("hex");
}

/** The compile's result, or undefined when `wait` ends first; the wait's timer is stopped either way. */
async function raced(done: Promise<CompileResult>, wait: CompileWait): Promise<CompileResult | undefined> {
  const stop = new AbortController();
  // A wait stopped once the compile answered may reject: that is its end, not a failure.
  const waited = wait(stop.signal).then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([done, waited]);
  } finally {
    stop.abort();
  }
}

/** The clock and wait {@link freshenSources} uses. */
export type FreshenClock = { now(): number; sleep(ms: number): Promise<void> };

/**
 * Moves each of `files` written before `previousEnd` + {@link UBT_TIME_GRAIN_MS} past it, waiting
 * for the grain to pass first, so UnrealBuildTool sees the change. Nothing without a previous
 * build. A builder writes these files: a link is moved itself, never followed, and one that is
 * gone is skipped.
 */
export async function freshenSources(
  files: readonly string[],
  previousEnd: number | undefined,
  clock: FreshenClock,
): Promise<void> {
  if (previousEnd === undefined) return;
  const seen = previousEnd + UBT_TIME_GRAIN_MS;
  const written = await Promise.all(
    files.map((file) =>
      lstat(file).then(
        (info) => info.mtimeMs,
        () => undefined,
      ),
    ),
  );
  const missed = files.filter((_file, i) => (written[i] ?? seen) < seen);
  if (missed.length === 0) return;
  const left = seen - clock.now();
  if (left > 0) await clock.sleep(left);
  const now = new Date(Math.max(clock.now(), seen));
  await Promise.all(missed.map((file) => lutimes(file, now, now).catch(() => undefined)));
}

/** check-part's compile jobs, held for this process; `now` is the clock a compile's end is read from. */
export function createCompileJobs(now: () => number = Date.now): CompileJobs {
  const jobs = new Map<string, Job>();
  /** When each copy's last compile ended, newest last, for the next compile of it. */
  const ended = new Map<string, number>();
  const finished = (project: string) => {
    ended.delete(project);
    ended.set(project, now());
    for (const old of ended.keys()) {
      if (ended.size <= MAX_JOBS) break;
      ended.delete(old);
    }
  };
  /** Forgets the oldest finished jobs past the cap; a running one is never forgotten. */
  const prune = () => {
    for (const [project, job] of jobs) {
      if (jobs.size <= MAX_JOBS) return;
      if (job.result) jobs.delete(project);
    }
  };
  const begin = (project: string, hash: string, start: StartCompile, previous: Job | undefined): Job => {
    previous?.controller.abort();
    const controller = new AbortController();
    const before = previous ? previous.done.then(() => undefined) : Promise.resolve();
    const done = before.then(() => start(controller.signal, ended.get(project))).catch(notStarted);
    const job: Job = { hash, controller, done };
    void done.then((result) => {
      job.result = result;
      finished(project);
    });
    jobs.delete(project);
    jobs.set(project, job);
    prune();
    return job;
  };
  return {
    async result(project, hash, start, wait) {
      const current = jobs.get(project);
      const job = current?.hash === hash ? current : begin(project, hash, start, current);
      const result = job.result ?? (await raced(job.done, wait));
      const answeredOnce = result !== undefined && !KEPT.has(result.failure);
      if (answeredOnce && jobs.get(project) === job) jobs.delete(project);
      return result;
    },
  };
}
