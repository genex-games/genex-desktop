/**
 * One client for Roblox Studio's own MCP server, `StudioMCP`, which the plugin's backend and each
 * game's Roblox Studio connection both use. It speaks newline-delimited JSON-RPC over stdio
 * (MCP 2025-06-18: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
 *
 * - StudioMCP is the person's vendor program, started with an argument list, never a shell
 *   string, and outside Genex's process sandbox: Studio's own connection to it and the person's
 *   sign-in must work. On a Mac it gets the person's real home (`home`), whatever HOME this
 *   process runs with: StudioMCP keeps its connection token there, which Genex never reads. On
 *   Windows, `mcp.bat` starts through `commandLaunch`'s cmd.exe line from its real path inside
 *   `%LOCALAPPDATA%\Roblox`, and anything cmd.exe would rewrite in that path is refused.
 * - Studio joins a fresh StudioMCP a moment after it starts, so `waitForStudio` asks
 *   `list_roblox_studios` until the wanted Studio is listed or the injected deadline passes; two
 *   Studios that both match are refused, never guessed between.
 * - A StudioMCP that exits fails every pending call; the next call starts a fresh one. `restart`
 *   does the same on purpose: a StudioMCP that reached Studio through another one (only one hosts
 *   Studio's connection) loses Studio when that one ends.
 * - Time is injected (`now`, `sleep`), so every wait runs on a test's clock.
 */
import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { commandLaunch } from "../../substrate/command-launch.ts";
import { killProcessTree } from "../../substrate/process-tree.ts";
import { envValue } from "../../substrate/toolchain.ts";
import { type LocateFs, systemLocateFs } from "./studio-locate.ts";
import { StudioTool } from "./studio-tools.ts";

/** The MCP version StudioMCP 0.743 speaks. */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "genex-roblox", version: "0.1.0" } as const;
/** How long Studio may take to join a fresh StudioMCP (it took about 1–4 s when measured). */
export const STUDIO_JOIN_MS = 10 * SECOND_MS;
/** How often the join wait asks again. */
export const STUDIO_POLL_MS = SECOND_MS / 4;
/** A call's limit unless its caller gives one: `execute_luau` runs on Studio's main thread. */
const CALL_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long the backend's "does Studio answer" ask may take. */
const ANSWER_CHECK_MS = 5 * SECOND_MS;
/** How long `initialize` and `tools/list` may take. */
const HANDSHAKE_MS = 15 * SECOND_MS;
/** How long an ended StudioMCP gets to exit before it is killed. */
const EXIT_GRACE_MS = 2 * SECOND_MS;
/** The longest line read from StudioMCP: a picture answer is one line of base64. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
/** The Studio program's folder under LOCALAPPDATA on Windows, and the script StudioMCP starts from. */
const WINDOWS_ROBLOX = "Roblox";
const WINDOWS_MCP_SCRIPT = "mcp.bat";
/** What cmd.exe would rewrite in a script's path, beyond what `commandLaunch` already refuses. */
const CMD_UNSAFE_IN_PATH = /[%^&"!<>|\r\n\0]/;
/** A full Windows path on a drive. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;

/** Why a call didn't reach Studio. Wire values: never rename. */
export const StudioClientFailure = {
  /** No StudioMCP on this computer. */
  NotInstalled: "not-installed",
  /** A StudioMCP path Genex won't start. */
  Refused: "refused",
  /** The wanted Studio wasn't listed before the deadline. */
  NotListed: "not-listed",
  /** Two listed Studios match. */
  TwoStudios: "two-studios",
  /** StudioMCP exited (or couldn't start) with the call pending. */
  Crashed: "crashed",
  TimedOut: "timed-out",
  /** The client was closed. */
  Closed: "closed",
  /** StudioMCP answered with a protocol error. */
  Failed: "failed",
} as const;
export type StudioClientFailure = (typeof StudioClientFailure)[keyof typeof StudioClientFailure];

const MESSAGE = {
  NotInstalled: "Roblox Studio isn't on this computer, or it has no MCP server.",
  Refused: (file: string) => `Genex won't start Roblox Studio's MCP server from ${file}.`,
  NotListed: "Roblox Studio didn't answer through its MCP server in time.",
  TwoStudios: (name: string) => `Two Roblox Studio windows have ${name} open.`,
  Crashed: "Roblox Studio's MCP server stopped before it answered.",
  TimedOut: (method: string) => `Roblox Studio's MCP server didn't answer ${method} in time.`,
  Closed: "The Roblox Studio connection is closed.",
  Failed: (message: string) => `Roblox Studio's MCP server refused the call: ${message}`,
  BadAnswer: "Roblox Studio's MCP server answered something Genex can't read.",
} as const;

/** A failure with its code, so callers choose their words by code, never by its text. */
export class StudioClientError extends Error {
  code: StudioClientFailure;
  constructor(code: StudioClientFailure, message: string) {
    super(message);
    this.name = "StudioClientError";
    this.code = code;
  }
}

const fail = (code: StudioClientFailure, message: string) => new StudioClientError(code, message);

/** Starts StudioMCP: a program and its argument list, never a shell string. */
export type SpawnStudioMcp = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean },
) => ChildProcess;

/** The computer the client works on; tests hand in fakes. */
export interface StudioClientDeps {
  platform: NodeJS.Platform;
  /** This process's environment, which StudioMCP inherits (its HOME replaced by `home` on a Mac). */
  env: NodeJS.ProcessEnv;
  /** The person's real home folder. */
  home: string;
  /** StudioMCP on a Mac, `mcp.bat` on Windows; undefined when Studio has none. */
  mcp(): Promise<string | undefined>;
  fs: Pick<LocateFs, "lstat" | "realpath">;
  spawn: SpawnStudioMcp;
  now(): number;
  /** The join wait's pause between asks; it ends early, without throwing, once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A call's time limit: settles after `ms`, or early, without throwing, once `signal` aborts. */
  limit(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A Studio StudioMCP lists: its id and a name with its place's file name or id. */
export interface StudioEntry {
  id: string;
  name: string;
}

/** An MCP tool as StudioMCP lists it. */
export interface StudioMcpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
}

/** An MCP tool result. */
export interface StudioToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
}

/** What a call may be given: its caller's cancel and limit. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** How a join wait runs. */
export interface JoinOptions extends CallOptions {
  everyMs?: number;
}

/** The one StudioMCP client. */
export interface StudioClient {
  listTools(options?: CallOptions): Promise<StudioMcpTool[]>;
  studios(options?: CallOptions): Promise<StudioEntry[]>;
  callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<StudioToolResult>;
  /** The one listed Studio `match` accepts, asked for until the deadline. */
  waitForStudio(match: (studio: StudioEntry) => boolean, options?: JoinOptions): Promise<StudioEntry>;
  /** Ends the running StudioMCP; the next call starts a fresh one. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** The program, arguments and spawn option that start StudioMCP. */
interface Launch {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** Whether `target` is `root` or inside it, in `flavour`'s spelling. */
function within(flavour: path.PlatformPath, root: string, target: string): boolean {
  const relative = flavour.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !flavour.isAbsolute(relative));
}

async function plainFile(fs: StudioClientDeps["fs"], file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => undefined);
  return Boolean(stat?.file && !stat.link);
}

/** `mcp.bat` as cmd.exe starts it, from its real path inside a real `%LOCALAPPDATA%\Roblox`. */
async function windowsLaunch(deps: StudioClientDeps, mcp: string): Promise<Launch> {
  const refused = fail(StudioClientFailure.Refused, MESSAGE.Refused(mcp));
  const local = envValue(deps.env, "LOCALAPPDATA");
  if (!local || !WINDOWS_DRIVE_PATH.test(local)) throw refused;
  const roblox = path.win32.join(local, WINDOWS_ROBLOX);
  const folder = await deps.fs.lstat(roblox).catch(() => undefined);
  if (!folder?.directory || folder.link) throw refused;
  if (path.win32.basename(mcp).toLowerCase() !== WINDOWS_MCP_SCRIPT || !(await plainFile(deps.fs, mcp))) throw refused;
  const [realRoblox, real] = await Promise.all([deps.fs.realpath(roblox), deps.fs.realpath(mcp)]).catch(() => {
    throw refused;
  });
  if (!within(path.win32, realRoblox, real) || CMD_UNSAFE_IN_PATH.test(real)) throw refused;
  // Never read as an npm shim: Roblox's script always starts through cmd.exe.
  const reader = { readScript: () => null, exists: () => false };
  const launch = commandLaunch(real, [], "win32", deps.env, reader);
  return { file: launch.file, args: launch.args, windowsVerbatimArguments: launch.windowsVerbatimArguments };
}

/** How StudioMCP starts on this computer; refuses a path Genex won't run, starting nothing. */
async function studioMcpLaunch(deps: StudioClientDeps): Promise<Launch> {
  const mcp = await deps.mcp();
  if (!mcp) throw fail(StudioClientFailure.NotInstalled, MESSAGE.NotInstalled);
  if (deps.platform === "win32") return windowsLaunch(deps, mcp);
  if (!(await plainFile(deps.fs, mcp))) throw fail(StudioClientFailure.Refused, MESSAGE.Refused(mcp));
  return { file: mcp, args: [], windowsVerbatimArguments: false };
}

/** StudioMCP's environment: this process's, with the person's real home on a Mac. */
function childEnv(deps: StudioClientDeps): NodeJS.ProcessEnv {
  return deps.platform === "win32" ? { ...deps.env } : { ...deps.env, HOME: deps.home };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type JsonRpcAnswer = { id?: unknown; result?: unknown; error?: { message?: unknown } };

/** One running StudioMCP: its requests by id, failed together when it exits. */
interface Session {
  child: ChildProcess;
  pending: Map<number, Pending>;
  nextId: number;
  ended: boolean;
  exited: Promise<void>;
}

function settle(session: Session, line: string): void {
  let answer: JsonRpcAnswer;
  try {
    answer = JSON.parse(line) as JsonRpcAnswer;
  } catch {
    return;
  }
  if (typeof answer.id !== "number") return;
  const pending = session.pending.get(answer.id);
  if (!pending) return;
  session.pending.delete(answer.id);
  if (answer.error) pending.reject(fail(StudioClientFailure.Failed, MESSAGE.Failed(String(answer.error.message))));
  else pending.resolve(answer.result);
}

/** Fails every pending request of a session that ended. */
function endSession(session: Session, error: StudioClientError): void {
  session.ended = true;
  for (const pending of session.pending.values()) pending.reject(error);
  session.pending.clear();
}

/** Reads StudioMCP's answers line by line; a line past the cap ends the session. */
function readLines(session: Session): void {
  let buffer = "";
  session.child.stdout?.setEncoding("utf8");
  session.child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) settle(session, line);
    }
    if (buffer.length > MAX_LINE_CHARS) {
      endSession(session, fail(StudioClientFailure.Crashed, MESSAGE.BadAnswer));
      session.child.kill();
    }
  });
}

function startSession(deps: StudioClientDeps, launch: Launch): Session {
  const child = deps.spawn(launch.file, launch.args, {
    env: childEnv(deps),
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const session: Session = { child, pending: new Map(), nextId: 0, ended: false, exited };
  const crashed = () => endSession(session, fail(StudioClientFailure.Crashed, MESSAGE.Crashed));
  child.once("exit", crashed);
  child.once("error", crashed);
  child.stdin?.on("error", crashed);
  // StudioMCP logs to stderr; reading it keeps its pipe from filling.
  child.stderr?.resume();
  readLines(session);
  return session;
}

function send(session: Session, message: Record<string, unknown>): void {
  session.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/** One request on a session, failed by its limit, its caller's cancel or the session ending. */
function request(
  deps: StudioClientDeps,
  session: Session,
  method: string,
  params: unknown,
  options: CallOptions,
): Promise<unknown> {
  if (session.ended) return Promise.reject(fail(StudioClientFailure.Crashed, MESSAGE.Crashed));
  const id = ++session.nextId;
  const timer = new AbortController();
  const answered = new Promise<unknown>((resolve, reject) => session.pending.set(id, { resolve, reject }));
  send(session, { id, method, params });
  const limit = deps
    .limit(options.timeoutMs ?? CALL_TIMEOUT_MS, AbortSignal.any([timer.signal, ...signals(options)]))
    .then(() => {
      if (!session.pending.delete(id)) return;
      throw options.signal?.aborted
        ? fail(StudioClientFailure.Closed, MESSAGE.Closed)
        : fail(StudioClientFailure.TimedOut, MESSAGE.TimedOut(method));
    });
  return Promise.race([answered, limit]).finally(() => timer.abort());
}

const signals = (options: CallOptions) => (options.signal ? [options.signal] : []);

function toolResult(value: unknown): StudioToolResult {
  const content = (value as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) throw fail(StudioClientFailure.Failed, MESSAGE.BadAnswer);
  return value as StudioToolResult;
}

/**
 * The Studios a `list_roblox_studios` answer names. A Studio with no name (a play test's server or
 * client, or one still opening) is kept with an empty name; an entry without a string id, or with a
 * name that is neither a string nor absent, is left out.
 */
export function parseStudios(result: StudioToolResult): StudioEntry[] {
  const text = result.content.find((part) => part.type === "text")?.text;
  let parsed: unknown;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const studios = (parsed as { studios?: unknown } | undefined)?.studios;
  if (!Array.isArray(studios)) return [];
  return studios.flatMap((entry: unknown) => {
    const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
    const named = typeof name === "string" || name === null || name === undefined;
    return typeof id === "string" && id && named ? [{ id, name: name ?? "" }] : [];
  });
}

/** Ends a session's StudioMCP (its whole tree on Windows), waiting a short while for it to exit. */
async function stopSession(deps: StudioClientDeps, session: Session): Promise<void> {
  endSession(session, fail(StudioClientFailure.Closed, MESSAGE.Closed));
  const { child } = session;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (deps.platform === "win32") await killProcessTree(child.pid, { platform: "win32" }).catch(() => undefined);
  else child.kill("SIGTERM");
  const waited = new AbortController();
  const late = deps.limit(EXIT_GRACE_MS, waited.signal).then(() => true);
  const gone = await Promise.race([session.exited.then(() => false), late]);
  waited.abort();
  if (gone) child.kill("SIGKILL");
}

/** The client over the computer it is given. */
export function createStudioClient(deps: StudioClientDeps): StudioClient {
  let session: Promise<Session> | undefined;
  let closed = false;

  /** A fresh StudioMCP past its handshake; one that fails the handshake is ended, never left running. */
  async function open(): Promise<Session> {
    const launch = await studioMcpLaunch(deps);
    const started = startSession(deps, launch);
    const hello = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
    try {
      await request(deps, started, "initialize", hello, { timeoutMs: HANDSHAKE_MS });
    } catch (error) {
      await stopSession(deps, started);
      throw error;
    }
    send(started, { method: "notifications/initialized" });
    return started;
  }

  /** The running session, started afresh (once, however many calls ask) when there is none or it ended. */
  async function current(): Promise<Session> {
    if (closed) throw fail(StudioClientFailure.Closed, MESSAGE.Closed);
    const prior = session;
    const running = prior ? await prior.catch(() => undefined) : undefined;
    if (running && !running.ended) return running;
    if (session !== prior) return current();
    const opening = (async () => {
      if (running) await stopSession(deps, running);
      return open();
    })();
    session = opening;
    opening.catch(() => {
      if (session === opening) session = undefined;
    });
    return opening;
  }

  async function call(method: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
    return request(deps, await current(), method, params, options);
  }

  const callTool = async (name: string, args: Record<string, unknown>, options: CallOptions = {}) =>
    toolResult(await call("tools/call", { name, arguments: args }, options));

  const studios = async (options: CallOptions = {}) =>
    parseStudios(await callTool(StudioTool.ListRobloxStudios, {}, options));

  async function waitForStudio(match: (studio: StudioEntry) => boolean, options: JoinOptions = {}) {
    const deadline = deps.now() + (options.timeoutMs ?? STUDIO_JOIN_MS);
    for (;;) {
      const found = (await studios(options)).filter(match);
      if (found.length > 1) throw fail(StudioClientFailure.TwoStudios, MESSAGE.TwoStudios(found[0]?.name ?? ""));
      if (found[0]) return found[0];
      const left = deadline - deps.now();
      if (left <= 0 || options.signal?.aborted) throw fail(StudioClientFailure.NotListed, MESSAGE.NotListed);
      await deps.sleep(Math.min(options.everyMs ?? STUDIO_POLL_MS, left), options.signal);
    }
  }

  async function endCurrent(): Promise<void> {
    const running = session ? await session.catch(() => undefined) : undefined;
    session = undefined;
    if (running) await stopSession(deps, running);
  }

  return {
    listTools: async (options = {}) => {
      const listed = (await call("tools/list", {}, { timeoutMs: HANDSHAKE_MS, ...options })) as { tools?: unknown };
      return Array.isArray(listed?.tools) ? (listed.tools as StudioMcpTool[]) : [];
    },
    studios,
    callTool,
    waitForStudio,
    restart: endCurrent,
    close: async () => {
      closed = true;
      await endCurrent();
    },
  };
}

/**
 * Whether a Studio answers through StudioMCP now: one is listed. Never throws: a missing, refused
 * or failing StudioMCP answers false, as does a fresh one Studio hasn't joined yet.
 */
export async function studioAnswers(client: StudioClient): Promise<boolean> {
  const listed = await client.studios({ timeoutMs: ANSWER_CHECK_MS }).catch(() => []);
  return listed.length > 0;
}

/** A pause on this computer's clock that ends early, without throwing, once `signal` aborts. */
const systemSleep = (ms: number, signal?: AbortSignal) =>
  delay(ms, undefined, { signal, ref: false }).catch(() => undefined);

/**
 * This computer: StudioMCP from `mcp` (the locator's answer), with the person's real home from the
 * system's user record, never from HOME, which the host points at the connection's own folder.
 */
export function systemStudioClientDeps(mcp: () => Promise<string | undefined>): StudioClientDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: os.userInfo().homedir,
    mcp,
    fs: systemLocateFs,
    spawn: (file, args, options) =>
      spawn(file, [...args], {
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      }),
    now: Date.now,
    sleep: systemSleep,
    limit: systemSleep,
  };
}
