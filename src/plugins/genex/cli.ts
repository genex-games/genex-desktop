/** Running the pinned Genex CLI: its environment, its credential pipe, its limits and its answer. */
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Writable } from "node:stream";
import { GIT_ENV } from "../../substrate/snapshots.ts";
import { genexTelemetryEnv } from "../../substrate/genex-telemetry.ts";
import { windowsBaseEnv } from "../../substrate/child-env.ts";
import { envPath } from "../../substrate/toolchain.ts";
import { SECOND_MS } from "../../shared/duration.ts";

const require = createRequire(import.meta.url);

/** A virtual env path: the preload serves the sign-in record beside it from fd 3, never from disk. */
const CREDENTIALS_ENV_FILE = "/__studio_genex_credentials__";
const KILL_GRACE_MS = 5 * SECOND_MS;
const STDOUT_TAIL_CHARS = 2_000_000;
const STDERR_TAIL_CHARS = 4000;
/** How much of a failure's output reaches the job record. */
export const ERROR_TAIL_CHARS = 3000;
const REDACTED = "[redacted]";
/** A CLI run's answer is its output only when it exits 0, unless the run names other codes. */
const ANSWER_EXIT_CODES: readonly number[] = [0];

const MESSAGE = {
  NoStructuredResult: "Genex returned no structured result",
  LocalStop: (timedOut: boolean) =>
    `${timedOut ? "Local wait timed out" : "Stopped locally"}; an accepted Genex job may still be running. Reconcile the existing request before submitting again.`,
  Exited: (code: number | null) => `Genex exited ${code}`,
} as const;

/** Terminal colour codes the CLI prints despite NO_COLOR. */
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** The first JSON document in the CLI's output, skipping any log lines before it. */
export function parseGenexJson(output: string): any {
  const clean = stripAnsi(output);
  for (const match of clean.matchAll(/^[{[]/gm)) {
    try {
      return JSON.parse(clean.slice(match.index).trim());
    } catch {}
  }
  throw new Error(MESSAGE.NoStructuredResult);
}

/**
 * The pinned CLI's whole environment, built from scratch: nothing else of Studio's reaches it.
 * `home` is a publish run's contained HOME, which also commits as the studio (GIT_ENV).
 * The CLI's crash reporting is off unless the user turned it on (`genexTelemetryEnv`). On Windows
 * it also gets what any program needs to start there, its profile folders inside `home` when set.
 */
export function genexCliEnv(
  parent: NodeJS.ProcessEnv,
  options: { api: string; home?: string; platform?: NodeJS.Platform },
): NodeJS.ProcessEnv {
  return {
    ...windowsBaseEnv(parent, options.platform, options.home),
    PATH: envPath(parent),
    HOME: options.home ?? parent.HOME,
    TMPDIR: parent.TMPDIR,
    ELECTRON_RUN_AS_NODE: "1",
    GENEX_ENV_FILE: CREDENTIALS_ENV_FILE,
    GENEX_API_URL: options.api,
    GENEX_ASSET_BUDGET_CAP: "0",
    NO_COLOR: "1",
    ...genexTelemetryEnv(parent),
    ...(options.home ? GIT_ENV : {}),
  };
}

/** The vendored CLI's entry point, outside the asar archive when packaged. */
export function genexCliPath(): string {
  return path
    .join(path.dirname(require.resolve("@genex-ai/cli-demo/package.json")), "dist/index.js")
    .replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

/** One CLI run. `parse` asks for `--json` and returns the parsed answer; otherwise `{ out }`. */
export interface GenexCliRun {
  cli: string;
  preload: string;
  api: string;
  token: string;
  cwd: string;
  args: string[];
  signal: AbortSignal | undefined;
  timeoutMs: number;
  parse: boolean;
  home?: string;
  /**
   * The exit codes whose output is the command's answer rather than a failure; `[0]` unless given.
   * `genex cover <file>` exits 1 for a frame Genex refused, which is an answer like any other.
   */
  answerExitCodes?: readonly number[];
}

/** A run stopped here, by its signal or its timeout, before the CLI answered. */
export class GenexCliStopped extends Error {
  readonly timedOut: boolean;
  constructor(timedOut: boolean) {
    super(MESSAGE.LocalStop(timedOut));
    this.name = "GenexCliStopped";
    this.timedOut = timedOut;
  }
}

/** The CLI's output so far, each stream kept to its tail. */
interface CliOutput {
  out: string;
  err: string;
}

function collectOutput(child: ChildProcess): CliOutput {
  const output: CliOutput = { out: "", err: "" };
  child.stdout?.on("data", (b) => {
    output.out = (output.out + b).slice(-STDOUT_TAIL_CHARS);
  });
  child.stderr?.on("data", (b) => {
    output.err = (output.err + b).slice(-STDERR_TAIL_CHARS);
  });
  return output;
}

/** SIGTERM on abort or timeout, then SIGKILL after a grace period. `cleanup` disarms all of it. */
function stopOnAbortOrTimeout(child: ChildProcess, signal: AbortSignal | undefined, timeoutMs: number) {
  const state = { timedOut: false, cleanup: () => {} };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    abort();
  }, timeoutMs);
  state.cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", abort);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return state;
}

/** What a finished CLI run means: its answer, or the error that explains why there is none. */
function cliResult(run: GenexCliRun, code: number | null, output: CliOutput, timedOut: boolean): unknown {
  const redact = (text: string) => text.replaceAll(run.token, REDACTED);
  if (run.signal?.aborted || timedOut) throw new GenexCliStopped(timedOut);
  const answered = code !== null && (run.answerExitCodes ?? ANSWER_EXIT_CODES).includes(code);
  if (!answered) throw new Error(redact(output.err || output.out || MESSAGE.Exited(code)).slice(-ERROR_TAIL_CHARS));
  if (!run.parse) return { out: redact(output.out) };
  return parseGenexJson(output.out);
}

/** Spawn the CLI with the token on fd 3 and settle with its answer. */
export function runGenexCli(run: GenexCliRun): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        // A file URL: Node reads a bare `C:\…` here as a URL with the scheme `c:`.
        pathToFileURL(run.preload).href,
        run.cli,
        ...run.args,
        "--env",
        CREDENTIALS_ENV_FILE,
        "--api-url",
        run.api,
        ...(run.parse ? ["--json"] : []),
      ],
      {
        // A publish spawn keeps the CLI's `~` inside Studio's workspace and commits as the studio:
        // `pushSource` runs git with no user identity of its own and must never read or write the user's config.
        cwd: run.cwd,
        env: genexCliEnv(process.env, { api: run.api, home: run.home }),
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    const credentialPipe = child.stdio[3] as Writable;
    credentialPipe.on("error", () => {});
    credentialPipe.end(`GENEX_TOKEN=${run.token}\n`);
    const output = collectOutput(child);
    const stop = stopOnAbortOrTimeout(child, run.signal, run.timeoutMs);
    child.on("error", (e) => {
      stop.cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      stop.cleanup();
      try {
        resolve(cliResult(run, code, output, stop.timedOut));
      } catch (e) {
        reject(e);
      }
    });
  });
}
