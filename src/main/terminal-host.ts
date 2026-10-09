/** Dedicated Electron utility process: native code and terminal traffic stay off main. */
import type * as Pty from "node-pty";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TerminalFlow } from "./terminal-flow.ts";
import { LinkScanner } from "./terminal-links.ts";
import { LoginTerminalOutput } from "./terminal-login-output.ts";
import { HostCommand, HostEventType, INTERRUPTED_EXIT_CODE, type TerminalLaunch } from "./terminal-service.ts";
import { TerminalKind, terminalSize, TERMINAL_LIMITS } from "../shared/terminal.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { StudioPlatform } from "../shared/boot.ts";
import { killProcessTree } from "../substrate/process-tree.ts";

/** Output is sent to main at most once a frame. */
const FLUSH_MS = 16;
/** The exit message gets this long to leave before the process does. */
const EXIT_DELAY_MS = 20;
/** `ps` gets this long and this much output to list the process table. */
const PS_TIMEOUT_MS = 1000;
const PS_MAX_BUFFER = 4 * 1024 * 1024;
/** Jobs asked to stop get this long before they are killed. */
const TERM_GRACE_MS = 1000;
/** How often the host checks that the app that started it is still alive. */
const OWNER_POLL_MS = 2000;
/** What the terminal panel reads when a session breaks, and why the host refuses to run. */
const MESSAGE = {
  bufferFull: "Terminal output exceeded its buffer limit. Open a new session.",
  broken: "Could not start or communicate with the terminal. Open a new session.",
  notUtilityProcess: "the terminal host runs only as an Electron utility process",
} as const;

const parentPort = process.parentPort;
if (!parentPort) throw new Error(MESSAGE.notUtilityProcess);
const parent = parentPort;
// node-pty rewrites app.asar to app.asar.unpacked for spawn-helper itself. Resolve its
// JS through the archive, even though this utility's entry point is already unpacked.
const pty: typeof Pty = createRequire(__filename.replace(/app\.asar\.unpacked([/\\])/, "app.asar$1"))("node-pty");
const run = promisify(execFile);
let terminal: Pty.IPty | undefined;
let started = false,
  stopping = false,
  finished = false,
  cleanupDone = false;
let result: { code: number; error?: string } | undefined;
let filter: LoginTerminalOutput | undefined;
/** OpenCode's sign-in draws its own prompts: its pages are noticed, its output left as it is. */
let links: LinkScanner | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let stopTask: Promise<void> | undefined;
let size = { cols: 80, rows: 16 };
const send = (message: unknown): void => parent.postMessage(message);
const flow = new TerminalFlow(
  (data) => send({ type: HostEventType.Data, data }),
  (paused) => {
    if (!terminal || result) return;
    if (paused) terminal.pause();
    else terminal.resume();
  },
);
const finish = (): void => {
  const stillDraining = stopping ? !cleanupDone : flow.pending > 0;
  if (finished || !result || stillDraining) return;
  finished = true;
  clearTimeout(flushTimer);
  send({ type: HostEventType.Exit, ...result });
  setTimeout(() => process.exit(0), EXIT_DELAY_MS);
};
const output = (data: string): void => {
  try {
    flow.append(data);
  } catch {
    result = { code: 1, error: MESSAGE.bufferFull };
    void stop();
    return;
  }
  if (!flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flow.flush();
      finish();
    }, FLUSH_MS);
};

interface ProcessIdentity {
  pid: number;
  ppid: number;
  started: string;
}
async function processes(): Promise<ProcessIdentity[]> {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
  });
  return stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    const [, pid, ppid, started] = m ?? [];
    return pid && ppid && started ? [{ pid: Number(pid), ppid: Number(ppid), started }] : [];
  });
}
async function stop(): Promise<void> {
  if (stopTask) return stopTask;
  stopping = true;
  stopTask = (async () => {
    if (terminal) await stopJobs(terminal);
    result ??= { code: INTERRUPTED_EXIT_CODE };
    cleanupDone = true;
    flow.flush();
    finish();
  })();
  return stopTask;
}

/** Ask the shell and every job under it to stop, then kill whichever of them is still the same process. */
async function stopJobs(shell: Pty.IPty): Promise<void> {
  if (process.platform === StudioPlatform.Windows) {
    // No `ps`, signals or process groups: taskkill ends the shell and every job under it, and
    // node-pty refuses a signal there (a deferred refusal would throw outside this function).
    await killProcessTree(shell.pid);
    try {
      shell.kill();
    } catch {}
    return;
  }
  const owned = jobsUnder(await processes().catch(() => []), shell.pid);
  for (const pid of [...owned.keys()].reverse()) signal(pid, "SIGTERM");
  killShell(shell, "SIGHUP");
  await sleep(TERM_GRACE_MS);
  // A fresh identity check prevents escalation from targeting a reused PID.
  for (const row of await processes().catch(() => []))
    if (owned.get(row.pid) === row.started) signal(row.pid, "SIGKILL");
  killShell(shell, "SIGKILL");
}

/**
 * The shell and its descendants, by pid, with when each started. Interactive jobs have separate
 * process groups. Walk descendants, not only the shell PID.
 */
function jobsUnder(rows: ProcessIdentity[], root: number): Map<number, string> {
  const ids = new Set([root]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows)
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
  }
  const owned = new Map<number, string>();
  for (const row of rows) if (ids.has(row.pid)) owned.set(row.pid, row.started);
  return owned;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {}
}

function killShell(shell: Pty.IPty, name: NodeJS.Signals): void {
  try {
    shell.kill(name);
  } catch {}
}

function startShell(launch: TerminalLaunch): void {
  if (started || stopping) return;
  started = true;
  if (launch.kind === TerminalKind.ClaudeLogin)
    filter = new LoginTerminalOutput((url) => send({ type: HostEventType.Link, url }));
  if (launch.kind === TerminalKind.OpenCodeLogin)
    links = new LinkScanner((url) => send({ type: HostEventType.Link, url }));
  const shell = pty.spawn(launch.file, launch.args, {
    name: "xterm-256color",
    ...size,
    cwd: launch.cwd,
    env: Object.fromEntries(
      Object.entries(launch.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    ),
  });
  terminal = shell;
  shell.onData((data) => {
    links?.write(data);
    output(filter ? filter.write(data) : data);
  });
  shell.onExit(({ exitCode }) => {
    if (filter) output(filter.end());
    result ??= { code: exitCode };
    flow.flush();
    // Stop owns escalation, even if the shell exits before its foreground children.
    if (!stopping) finish();
  });
  send({ type: HostEventType.Started });
}

function writeInput(data: unknown): void {
  const acceptable = !stopping && typeof data === "string" && data.length <= TERMINAL_LIMITS.input;
  if (acceptable) terminal?.write(data);
}

/** What each command from main does. */
const COMMANDS: Record<HostCommand, (message: Record<string, any>) => void> = {
  [HostCommand.Start]: (message) => startShell(message as unknown as TerminalLaunch),
  [HostCommand.Attach]: () => flow.attach(),
  [HostCommand.Ack]: (message) => {
    flow.acknowledge(message.count);
    finish();
  },
  [HostCommand.Input]: (message) => writeInput(message.data),
  [HostCommand.Resize]: (message) => {
    size = terminalSize(message.cols, message.rows);
    if (!result) terminal?.resize(size.cols, size.rows);
  },
  [HostCommand.Stop]: () => void stop(),
};

parent.on("message", ({ data: message }: { data: Record<string, any> }) => {
  try {
    COMMANDS[message.type as HostCommand]?.(message);
  } catch {
    result = { code: 1, error: MESSAGE.broken };
    void stop();
  }
});
// Parent death must not leave interactive jobs running after an application crash.
const owner = process.ppid;
setInterval(() => {
  if (process.ppid !== owner) void stop();
}, OWNER_POLL_MS).unref();
process.on("SIGTERM", () => {
  void stop();
});
process.on("disconnect", () => {
  void stop();
});
process.on("exit", () => {
  if (terminal && !result) {
    try {
      // node-pty takes no signal on Windows.
      terminal.kill(process.platform === StudioPlatform.Windows ? undefined : "SIGHUP");
    } catch {}
  }
});
send({ type: HostEventType.Ready });
