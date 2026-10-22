/**
 * Genex's client of Unity's Pipeline package (`com.unity.pipeline`): the HTTP server a Unity
 * editor runs on 127.0.0.1 while a project that has the package is open in it. The editor writes a
 * descriptor into the project's own `Library/Pipeline` folder naming its port and the token every
 * request carries, so a call finds its editor by the project's folder: no port is chosen or kept by
 * Genex, and a project that is closed has no editor to mistake for it.
 *
 * The wire is what Pipeline 0.6.0-exp.1 answered on Unity 6000.6 (measured 2026-09-11) and what
 * 0.8.0-exp.1 documents: every endpoint wants the bearer; 503 means the editor is importing or
 * showing a dialog; a domain reload drops the server for a few seconds; a restarted editor writes a
 * new token; a failed command answers `success: false` (`ok: false` before 0.8) with its reason.
 * A command is never sent twice: only a request that provably never left (nothing listened) or
 * that the server refused to run (503, 401) is tried again.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { containedReal } from "../../substrate/paths.ts";

/** Unity's package that serves the editor to tools. */
export const PIPELINE_PACKAGE = "com.unity.pipeline";
/** The version Genex asks for in a project it makes or sets up: the one this plugin was run against. */
export const PIPELINE_VERSION = "0.8.0-exp.1";
/** Where an open editor keeps its descriptor, relative to the project. */
const DESCRIPTOR_FILE = "Library/Pipeline/.unity-pipeline-port";
/** The most of a descriptor Genex reads: Unity writes a few short fields. */
const DESCRIPTOR_MAX_BYTES = 16 * 1024;
/** A token as it may ride in a header: printable, no spaces. */
const TOKEN = /^[\x21-\x7e]{1,512}$/;
/** A Pipeline command name: lowercase words joined by underscores. A listed entry of any other shape is dropped. */
export const COMMAND_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The most commands, and of each the most tags, parameters and description, kept from a catalogue. */
const MAX_COMMANDS = 500;
const MAX_TAGS = 8;
const MAX_PARAMETERS = 64;
const MAX_DESCRIPTION_CHARS = 1000;
/** The longest tag, parameter name or type kept. */
const MAX_NAME_CHARS = 80;
/** The most of the editor's own words for a failure handed on. */
const MAX_DETAIL_CHARS = 600;
/** How long a call waits for an editor that is busy or reloading before it says so. */
const WAIT_FOR_EDITOR_MS = MINUTE_MS;
/** How long one request may take once the editor has it: a compile or a test run takes minutes. */
const REQUEST_MS = 5 * MINUTE_MS;
/** The waits between tries of a busy editor: a quarter second, doubling to two seconds. */
const FIRST_BACKOFF_MS = SECOND_MS / 4;
const MAX_BACKOFF_MS = 2 * SECOND_MS;

const HttpStatus = { Unauthorized: 401, Unavailable: 503 } as const;
const ApiPath = {
  Commands: "/api/commands",
  Exec: "/api/exec",
  Status: "/api/status",
  EditorStatus: "/api/editor_status",
} as const;
/** How Pipeline's words for a command its main thread never ran begin. */
const MAIN_THREAD_TIMED_OUT = "Main thread operation timed out";
/** How long the editor's main thread gets to answer a look before it counts as stalled. */
const MAIN_THREAD_MS = 10 * SECOND_MS;
/** The error code of a connection nothing listened for: the request never left. */
const CONNECTION_REFUSED = "ECONNREFUSED";

/** Why a call got no result from the editor. Wire values: never rename one. */
export const PipelineProblem = {
  /** No editor has the project open, or its Pipeline package is not there. */
  NotOpen: "not-open",
  /** The editor's server did not answer within the wait. */
  NotAnswering: "not-answering",
  /** The editor answered that it is busy for the whole wait; `detail` is its reason. */
  Busy: "busy",
  /** The editor refused Genex's token twice. */
  Refused: "refused",
  /** The command ran and failed; `detail` is the editor's own text. */
  Failed: "failed",
  /** The command was sent and no answer came: whether it took effect is unknown. */
  Unknown: "unknown",
  /**
   * The server answers but the editor's main thread runs nothing: a long import or bake, or a
   * dialog nobody answered (a system save panel is one Pipeline itself does not see).
   */
  Stalled: "stalled",
} as const;
export type PipelineProblem = (typeof PipelineProblem)[keyof typeof PipelineProblem];

/** What a call came to. */
export type PipelineAnswer<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; problem: PipelineProblem; detail?: string };

/** An open editor's server: its process, port and token, and the editor's version when it says. */
export interface PipelineDescriptor {
  pid: number;
  port: number;
  token: string;
  unityVersion?: string;
}

/** One parameter of a command, as the editor's catalogue types it (`String`, `ObjectRef`, `Boolean`…). */
export interface PipelineParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** One command of the editor's catalogue: what it does, the tags it is listed under and what it takes. */
export interface PipelineCommand {
  name: string;
  description: string;
  tags: string[];
  parameters: PipelineParameter[];
}

/** A command to run with its parameters. */
export interface PipelineCall {
  command: string;
  parameters: Record<string, unknown>;
}

/** What a call may be given: the stop of its turn, and how long to wait for a busy editor. */
export interface PipelineOptions {
  signal?: AbortSignal;
  waitMs?: number;
}

/** The network, the clock and the process table a call uses; tests stand in for each. */
export interface PipelineDeps {
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  now: () => number;
  alive: (pid: number) => boolean;
  timeout: (ms: number) => AbortSignal;
}

/** Whether a process with this id runs (one Genex may not signal still runs). */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** This computer's own network, clock and processes. */
export const systemPipelineDeps: PipelineDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
  now: () => Date.now(),
  alive: processRuns,
  timeout: (ms) => AbortSignal.timeout(ms),
};

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
const isPid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The descriptor of the editor that has the project at `root` (its real path) open, or undefined:
 * none there, one reached through a link out of the project, or one naming no usable port or token.
 */
export async function readDescriptor(root: string): Promise<PipelineDescriptor | undefined> {
  const file = await containedReal(root, DESCRIPTOR_FILE).catch(() => undefined);
  if (!file) return undefined;
  const text = await readRegularFile(file, DESCRIPTOR_MAX_BYTES).catch(() => undefined);
  const raw = text ? parseJson(text.toString("utf8")) : undefined;
  if (!isJsonObject(raw) || !isPid(raw.pid) || !isPort(raw.port)) return undefined;
  if (typeof raw.evalToken !== "string" || !TOKEN.test(raw.evalToken)) return undefined;
  const version = typeof raw.unityVersion === "string" ? raw.unityVersion : undefined;
  return { pid: raw.pid, port: raw.port, token: raw.evalToken, ...(version ? { unityVersion: version } : {}) };
}

/** One request to the editor's server; a `repeatable` one changes nothing, so it may be sent again. */
interface PipelineRequest {
  path: (typeof ApiPath)[keyof typeof ApiPath];
  body?: unknown;
  repeatable: boolean;
  /** A look at the main thread: no answer within this is a stall, never waited out or asked again. */
  stalledAfterMs?: number;
}

/** What one try came to: the call's answer, or why to try again. */
type Attempt = { done: PipelineAnswer } | { again: PipelineProblem; detail?: string };

const problemOf = (problem: PipelineProblem, detail?: string): PipelineAnswer => ({
  ok: false,
  problem,
  ...(detail ? { detail } : {}),
});

const clip = (text: string, max: number): string => text.trim().slice(0, max);

/** Whether a failed request never left this computer: nothing listened on the port. */
function neverLeft(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return isJsonObject(cause) && cause.code === CONNECTION_REFUSED;
}

/** Sends one request to the descriptor's own port on this computer, never following a redirect. */
function send(
  descriptor: PipelineDescriptor,
  request: PipelineRequest,
  deps: PipelineDeps,
  limits: { limit: AbortSignal; signal?: AbortSignal },
): Promise<Response> {
  const posts = request.body !== undefined;
  const { limit, signal } = limits;
  return deps.fetch(`http://127.0.0.1:${descriptor.port}${request.path}`, {
    method: posts ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      ...(posts ? { "content-type": "application/json" } : {}),
    },
    ...(posts ? { body: JSON.stringify(request.body) } : {}),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  });
}

/** Why a command failed, in the editor's words: its error, and its details when they say more. */
function failureOf(body: unknown, text: string, status: number): string {
  if (!isJsonObject(body) || body.error === undefined) return clip(text, MAX_DETAIL_CHARS) || `HTTP ${status}`;
  const error = String(body.error);
  const details = typeof body.errorDetails === "string" ? body.errorDetails.trim() : "";
  return clip(details && details !== error ? `${error}: ${details}` : error, MAX_DETAIL_CHARS);
}

/** What keeps a busy editor, as it says (`settling`, `compiling`, `blocked_by_dialog`). */
function busyReasonOf(body: unknown): string {
  const reason = isJsonObject(body) ? (body.busyReason ?? body.reason) : undefined;
  return typeof reason === "string" ? clip(reason, MAX_NAME_CHARS) : "";
}

/** Whether an answer's body says its command failed: `success: false` (0.8), `ok: false` before it. */
const saysFailed = (body: unknown): boolean => isJsonObject(body) && (body.success === false || body.ok === false);

/**
 * Whether a failed answer is Pipeline giving up on its own main thread, which ran nothing for a
 * minute. Pipeline has no code for it: its words are all there is to read.
 */
const saysMainThreadTimedOut = (body: unknown): boolean =>
  isJsonObject(body) && typeof body.errorDetails === "string" && body.errorDetails.startsWith(MAIN_THREAD_TIMED_OUT);

/** Reads the editor's answer to one request. */
async function readResponse(response: Response): Promise<Attempt> {
  const text = await response.text();
  const body = parseJson(text);
  if (response.status === HttpStatus.Unauthorized) return { again: PipelineProblem.Refused };
  if (response.status === HttpStatus.Unavailable) return { again: PipelineProblem.Busy, detail: busyReasonOf(body) };
  if (saysMainThreadTimedOut(body)) return { done: problemOf(PipelineProblem.Stalled) };
  if (!response.ok || saysFailed(body))
    return { done: problemOf(PipelineProblem.Failed, failureOf(body, text, response.status)) };
  const result = isJsonObject(body) && "result" in body ? body.result : (body ?? text);
  return { done: { ok: true, result } };
}

/** One try: finds the editor by the project's descriptor, sends the request and reads its answer. */
async function attempt(
  root: string,
  request: PipelineRequest,
  deps: PipelineDeps,
  signal?: AbortSignal,
): Promise<Attempt> {
  const descriptor = await readDescriptor(root);
  if (!descriptor || !deps.alive(descriptor.pid)) return { done: problemOf(PipelineProblem.NotOpen) };
  const limit = deps.timeout(request.stalledAfterMs ?? REQUEST_MS);
  let response: Response;
  try {
    response = await send(descriptor, request, deps, { limit, signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (request.stalledAfterMs !== undefined && limit.aborted) return { done: problemOf(PipelineProblem.Stalled) };
    const mayHaveRun = !request.repeatable && !neverLeft(error);
    return mayHaveRun ? { done: problemOf(PipelineProblem.Unknown) } : { again: PipelineProblem.NotAnswering };
  }
  return readResponse(response);
}

/**
 * Asks the editor that has `root` open, trying again while it is busy, reloading or has changed its
 * token, until the wait runs out. The descriptor is read anew for every try.
 */
async function ask(
  root: string,
  request: PipelineRequest,
  deps: PipelineDeps,
  options: PipelineOptions,
): Promise<PipelineAnswer> {
  const deadline = deps.now() + (options.waitMs ?? WAIT_FOR_EDITOR_MS);
  let backoff = FIRST_BACKOFF_MS;
  let refusals = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const tried = await attempt(root, request, deps, options.signal);
    if ("done" in tried) return tried.done;
    if (tried.again === PipelineProblem.Refused) {
      // A restarted editor writes a new token: the next try reads the descriptor again, once.
      refusals += 1;
      if (refusals > 1) return problemOf(PipelineProblem.Refused);
      continue;
    }
    if (deps.now() + backoff > deadline) return problemOf(tried.again, tried.detail);
    await deps.sleep(backoff, options.signal);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }
}

const wordsOf = (value: unknown): string => (typeof value === "string" ? clip(value, MAX_DESCRIPTION_CHARS) : "");
const listOf = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

/** One parameter as the catalogue lists it; an entry with no name is dropped. */
function parameterOf(entry: unknown): PipelineParameter | undefined {
  if (!isJsonObject(entry) || typeof entry.name !== "string" || !entry.name) return undefined;
  return {
    name: clip(entry.name, MAX_NAME_CHARS),
    type: typeof entry.type === "string" ? clip(entry.type, MAX_NAME_CHARS) : "",
    required: entry.required === true,
    description: wordsOf(entry.description),
  };
}

/** One catalogue entry as the editor lists it: a name with words, tags and parameters, or a bare name. */
function commandOf(entry: unknown): PipelineCommand | undefined {
  const row = isJsonObject(entry) ? entry : { name: entry };
  if (typeof row.name !== "string" || !COMMAND_NAME.test(row.name)) return undefined;
  const tags = listOf(row.tags, MAX_TAGS).filter((tag) => typeof tag === "string");
  const parameters = listOf(row.parameters, MAX_PARAMETERS).map(parameterOf);
  return {
    name: row.name,
    description: wordsOf(row.description ?? row.summary),
    tags: tags.map((tag) => clip(tag, MAX_NAME_CHARS)),
    parameters: parameters.filter((parameter) => parameter !== undefined),
  };
}

/** The commands the editor that has `root` open offers. */
export async function listCommands(
  root: string,
  deps: PipelineDeps = systemPipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineAnswer<PipelineCommand[]>> {
  const answer = await ask(root, { path: ApiPath.Commands, repeatable: true }, deps, options);
  if (!answer.ok) return answer;
  const body = answer.result;
  const listed = isJsonObject(body) ? body.commands : body;
  const commands = (Array.isArray(listed) ? listed : []).slice(0, MAX_COMMANDS).map(commandOf);
  return { ok: true, result: commands.filter((command) => command !== undefined) };
}

/** Where an open editor's server says it stands. Wire values: Pipeline's own. */
export const ServerStatus = { Ready: "ready", Settling: "settling", BlockedByDialog: "blocked_by_dialog" } as const;

/**
 * Where the editor that has `root` open says it stands (`ready`, `settling` while it imports,
 * `blocked_by_dialog`), asked once: an editor that is not there or does not answer is a problem,
 * never waited for.
 */
export async function serverStatus(
  root: string,
  deps: PipelineDeps = systemPipelineDeps,
  signal?: AbortSignal,
): Promise<PipelineAnswer<string>> {
  const answer = await ask(root, { path: ApiPath.Status, repeatable: true }, deps, { waitMs: 0, signal });
  if (!answer.ok) return answer;
  const status = isJsonObject(answer.result) ? answer.result.status : undefined;
  return { ok: true, result: typeof status === "string" ? clip(status, MAX_NAME_CHARS) : "" };
}

/** What the editor's main thread says of itself: its Play mode, and whether it compiles or reloads scripts. */
export interface EditorStatus {
  /** `stopped`, `playing` or `paused`; empty when the editor does not say. */
  playMode: string;
  compiling: boolean;
  reloading: boolean;
}

/** The editor's word for no Play mode. */
export const PLAY_STOPPED = "stopped";

/**
 * A look at the main thread of the editor that has `root` open: its status when it answers,
 * `Stalled` when it answers nothing in ten seconds while the server itself is there. A stall is
 * never waited out; with `waits`, a busy or reloading editor is, as for a command.
 */
export async function editorStatus(
  root: string,
  deps: PipelineDeps = systemPipelineDeps,
  options: { signal?: AbortSignal; waits?: boolean } = {},
): Promise<PipelineAnswer<EditorStatus>> {
  const look = { path: ApiPath.EditorStatus, repeatable: true, stalledAfterMs: MAIN_THREAD_MS };
  // Before a command the look waits out a reload as the command would; a health check asks once.
  const waitMs = options.waits ? WAIT_FOR_EDITOR_MS : 0;
  const answer = await ask(root, look, deps, { waitMs, signal: options.signal });
  if (!answer.ok) return answer;
  const said = isJsonObject(answer.result) ? answer.result : {};
  return {
    ok: true,
    result: {
      playMode: typeof said.playMode === "string" ? clip(said.playMode, MAX_NAME_CHARS) : "",
      compiling: said.compiling === true,
      reloading: said.domainReloadInProgress === true,
    },
  };
}

/** Runs one command in the editor that has `root` open. */
export function runCommand(
  root: string,
  call: PipelineCall,
  deps: PipelineDeps = systemPipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineAnswer> {
  return ask(root, { path: ApiPath.Exec, body: call, repeatable: false }, deps, options);
}
