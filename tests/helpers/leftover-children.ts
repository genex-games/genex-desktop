/**
 * Loaded into every test file's process by the test runners (`TEST_PRELOAD` in
 * `scripts/affected-tests.mjs`): once the file's own `after` hooks have run, a child process it
 * started that is still running fails the file by name, and is killed so the process can exit.
 * `node --test` waits for every file's process to exit, so such a child held a runner slot for
 * good: on Linux, sandbox-runtime's socat bridges held every slot until the CI job timed out.
 *
 * Only children that keep the process open count (a ref'd `ChildProcess`); esbuild's service, which
 * unrefs itself and ends with its parent, does not.
 *
 * Node runs the root's `after` hooks as soon as the tests registered so far have ended, so in a file
 * that registers more tests after a top-level await (native-launch awaits its Xcode check) the hooks
 * run while the file is still loading. The check then waits for the file's module and, when that
 * registered more tests, for the root run Node starts once they have all ended.
 */
import { ChildProcess } from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import path from "node:path";
import { after } from "node:test";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { SECOND_MS } from "../../src/shared/duration.ts";

/**
 * How long a child already on its way out gets to exit: a stopped plugin backend is sent SIGTERM
 * and killed after 3 s (`KILL_GRACE_MS` in `src/substrate/plugins/process.ts`).
 */
const EXIT_GRACE_MS = 10 * SECOND_MS;
/** How often the grace period looks again. */
const POLL_MS = 50;
/** Test seam: the grace period in milliseconds, for this check's own test. */
export const EXIT_GRACE_ENV = "STUDIO_TEST_EXIT_GRACE_MS";

/** `node --test` marks the process it runs one test file in with this variable. */
const TEST_FILE_PROCESS = "NODE_TEST_CONTEXT";
/** A test file's name: what `node --test` runs as the process's main script. */
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

/** The tracing channel Node's test runner reports each test, suite and root run on. */
const TEST_TRACE = "node.test";
/** The name Node gives a test file's root test. */
const ROOT_TEST = "<root>";

/** Node's list of the handles keeping the event loop alive (undocumented, stable since Node 0.x). */
type ActiveHandles = { _getActiveHandles(): unknown[] };

/** What the test runner's trace has shown so far: root runs, and tests or suites started. */
const traced = { rootRuns: 0, starts: 0 };
/** Whether the check has run: a later root run can start the hooks again, and one look is enough. */
let looked = false;

/** Whether a trace event is a run of the file's root test (its context carries `name` and `nesting`). */
function isRootRun(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false;
  const named = "name" in context && context.name === ROOT_TEST;
  return named && "nesting" in context && context.nesting === 0;
}

/** Count each root run and each other test or suite the runner starts. */
function traceTests(): void {
  tracingChannel(TEST_TRACE).start.subscribe((context) => {
    if (isRootRun(context)) traced.rootRuns++;
    else traced.starts++;
  });
}

/**
 * Resolves once the file has registered every test and all of them have ended: its module has
 * finished loading, and when that registered tests after these hooks began, Node has run the root
 * again, which it does once the last of them ends.
 */
async function fileFinished(): Promise<void> {
  const { rootRuns, starts } = traced;
  // A module still loading settles this import once its top-level awaits have.
  await import(pathToFileURL(process.argv[1] ?? "").href).catch(() => undefined);
  // A test registered last starts a few promise turns after it is registered.
  await nextTurn();
  if (traced.starts === starts) return;
  while (traced.rootRuns === rootRuns) await sleep(POLL_MS);
}

/** The child processes this process started that are still running and keep it open. */
function runningChildren(): ChildProcess[] {
  return (process as unknown as ActiveHandles)
    ._getActiveHandles()
    .filter(
      (handle): handle is ChildProcess =>
        handle instanceof ChildProcess && handle.exitCode === null && handle.signalCode === null,
    );
}

/** The children still running once each has had the grace period to finish exiting. */
async function leftBehind(): Promise<ChildProcess[]> {
  const deadline = Date.now() + Number(process.env[EXIT_GRACE_ENV] ?? EXIT_GRACE_MS);
  let running = runningChildren();
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    running = runningChildren();
  }
  return running;
}

/**
 * Fail the file, naming it and each child it left running, and kill them so the process can exit.
 * `node --test` reports the failure at this hook, not at the test file.
 */
async function refuseLeftoverChildren(): Promise<void> {
  if (looked) return;
  looked = true;
  await fileFinished();
  const left = await leftBehind();
  if (left.length === 0) return;
  for (const child of left) child.kill("SIGKILL");
  const file = path.relative(process.cwd(), process.argv[1] ?? "");
  const named = left.map((child) => `  pid ${child.pid}: ${child.spawnargs.join(" ")}`);
  throw new Error(
    `${file} left ${left.length} child process(es) running after its cleanup; stop what its tests start (a core's stop(), a sandbox's dispose()):\n${named.join("\n")}`,
  );
}

/**
 * Whether this process runs one test file for `node --test`, not the runner itself or a process a
 * test started (a forked one inherits both the preload and the variable).
 */
function isTestFileProcess(): boolean {
  return process.env[TEST_FILE_PROCESS] !== undefined && TEST_FILE.test(process.argv[1] ?? "");
}

if (isTestFileProcess()) {
  traceTests();
  // Root `after` hooks run in the order they were added; one added from inside the first runs
  // after every hook the test file and its helpers added, so it sees what their cleanup left.
  // The root's hooks get a test's context, which is the one with `after`.
  after((context) => {
    if ("after" in context) context.after(refuseLeftoverChildren);
  });
}
