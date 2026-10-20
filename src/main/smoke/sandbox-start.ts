/**
 * Called only by --studio-smoke --studio-sandbox-start-smoke, inside a disposable profile: a fresh
 * launch's first sandboxed command, timed from the process's start. The core started the sandbox
 * at boot as it does for a person (on Windows in the background, logging each step's time as a
 * `[sandbox]` line); one command waits for that start and runs inside it. The report,
 * `__SANDBOX_START_JSON__{…}__END__` on stdout, is read by `tests/e2e/run-sandbox-start-packaged.mjs`.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { RunResult } from "../../substrate/spawn.ts";
import type { StudioCore } from "../studio-core.ts";

/** How long the command itself may run once the sandbox has started; srt-win's steps keep their own deadlines. */
const COMMAND_TIMEOUT_MS = 60 * SECOND_MS;
/** What the command prints, so a run that exits 0 without running it does not pass. */
const MARKER = "SANDBOX_START_OK";
/** The tail of a failed command's stderr the report keeps. */
const STDERR_TAIL_CHARS = 2_000;

/** What the runner reads: how long from launch until the first sandboxed command ended, and how it ended. */
export interface SandboxStartReport {
  ok: boolean;
  /** From the process's start until the command ended, the sandbox's start included. */
  firstCommandMs: number;
  /** From this command's request until it ended. */
  commandMs: number;
  code: number | null;
  sandboxed: boolean;
  error?: string;
}

/** The report's fields that describe how the command ended. */
function outcome(result: RunResult): Pick<SandboxStartReport, "ok" | "code" | "sandboxed" | "error"> {
  const ok = result.code === 0 && result.sandboxed && result.stdout.includes(MARKER);
  return {
    ok,
    code: result.code,
    sandboxed: result.sandboxed,
    ...(ok ? {} : { error: result.stderr.slice(-STDERR_TAIL_CHARS) || result.stdout.slice(-STDERR_TAIL_CHARS) }),
  };
}

/** Run one command in the core's sandbox, print the report, and answer the exit code. */
export async function runSandboxStartAcceptance(core: StudioCore): Promise<number> {
  const cwd = path.join(core.layout.workspaces, "sandbox start");
  await mkdir(cwd, { recursive: true });
  const requested = performance.now();
  const ended = await core.sandbox
    .run({ command: `echo ${MARKER}`, cwd, timeoutMs: COMMAND_TIMEOUT_MS, label: "sandbox-start-smoke" })
    .then(outcome)
    .catch((error: unknown) => ({ ok: false, code: null, sandboxed: false, error: errorMessage(error) }));
  const now = performance.now();
  const report: SandboxStartReport = {
    ...ended,
    firstCommandMs: Math.round(now),
    commandMs: Math.round(now - requested),
  };
  process.stdout.write(`__SANDBOX_START_JSON__${JSON.stringify(report)}__END__\n`);
  return report.ok ? 0 : 1;
}
