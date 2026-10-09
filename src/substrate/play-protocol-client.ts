/**
 * The studio's end of the Genex Play Protocol (docs/play-protocol.md): newline-delimited JSON to
 * a game process's stdin, replies read from its stdout and matched to their call by id.
 *
 * Everything the engine prints is untrusted: a line that does not parse, an answer to a call
 * nobody made, a reply larger than the studio reads, a process that never says ready or dies
 * mid-call — each is dropped or fails exactly the call it concerns with a typed code, and none of
 * them can throw out of a stream handler. Electron-free; time comes in through {@link PlayDeadlines}.
 *
 * The game's stderr is read for as long as it runs, so a game that logs a lot never blocks on a
 * full pipe; its last lines are kept in a bounded tail and named in every failure sentence.
 */
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { SECOND_MS } from "../shared/duration.ts";
import { PlayErrorCode, PlayEvent, PlayFailure, type PlayOp, type PlayRequestArgs } from "../shared/play-protocol.ts";

/** How long a process may take to print its ready line. */
export const PLAY_READY_TIMEOUT_MS = 20 * SECOND_MS;
/** How long one call may wait for its reply when the caller names no deadline. */
export const PLAY_CALL_TIMEOUT_MS = 10 * SECOND_MS;
/** The longest line the studio reads: a large inline screenshot fits, a runaway stream does not. */
export const MAX_PLAY_LINE_CHARS = 24 * 1024 * 1024;
/** Characters of a dropped line kept in the log, and of one stderr line named in a failure. */
const LOGGED_LINE_CHARS = 160;
/** Characters of the game's stderr kept: the tail a failure sentence quotes from. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** How many of the game's last stderr lines a failure sentence names. */
const STDERR_TAIL_LINES = 6;
/** Characters at the head of an oversize line searched for the id of the reply it was meant to be. */
const OVERSIZE_ID_PROBE_CHARS = 64;

/** The process ended: its exit code and signal, as far as they are known. */
export interface PlayExit {
  code: number | null;
  signal: string | null;
}

/** A game process's pipes as the client sees them; a child process is adapted by {@link playStreamsOf}. */
export interface PlayStreams {
  /** The engine's stdout. */
  readable: Readable;
  /** The engine's stdin. */
  writable: Writable;
  /** The engine's stderr, read throughout so it never fills, its tail kept for failures. */
  stderr?: Readable;
  /** Settles once the process is gone. */
  exited: Promise<PlayExit>;
}

/** The clock deadlines are kept on: `after` arms one and answers its cancel. */
export interface PlayDeadlines {
  after(ms: number, fire: () => void): () => void;
}

/** How a client is opened. */
export interface PlayClientOptions {
  readyTimeoutMs?: number;
  callTimeoutMs?: number;
  deadlines?: PlayDeadlines;
  /** Where dropped lines and engine events are reported. */
  log?: (line: string) => void;
}

/** A failed call: the engine's own refusal code, or the studio's reason it got no usable answer. */
export class PlayProtocolError extends Error {
  readonly code: PlayErrorCode | PlayFailure;
  readonly op: string;

  constructor(code: PlayErrorCode | PlayFailure, op: string, message: string) {
    super(message);
    this.name = "PlayProtocolError";
    this.code = code;
    this.op = op;
  }
}

/** An open connection to one game process. */
export interface PlayClient {
  /** The engine's ready line, as it printed it. */
  readonly ready: Record<string, unknown>;
  /** Whether the process is gone; every call fails with `exited` from then on. */
  readonly exited: boolean;
  /** A core op with its typed arguments; the reply's `result`, unread. */
  call<O extends PlayOp>(op: O, args: PlayRequestArgs[O], options?: { timeoutMs?: number }): Promise<unknown>;
  /** Any op by name — a game-specific one `hello` listed — with its arguments. */
  send(op: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Stop writing to the process: its stdin is ended. */
  close(): void;
  /** The last lines the game wrote to stderr, oldest first, each cut to a readable length. */
  stderrTail(): string[];
}

const MESSAGE = {
  notReady: (ms: number) => `the game did not say ready within ${ms} ms`,
  fatal: (why: string) => `the game failed to start: ${why}`,
  exited: (op: string) => `the game process is gone (${op})`,
  timeout: (op: string, ms: number) => `${op} got no reply within ${ms} ms`,
  oversize: (op: string) => `${op}'s reply is longer than ${MAX_PLAY_LINE_CHARS} characters`,
  refused: (op: string, why: string) => `${op} refused: ${why}`,
  badReply: (op: string) => `${op} got a reply the studio cannot read`,
  dropped: (why: string, line: string) => `[play] dropped ${why}: ${line.slice(0, LOGGED_LINE_CHARS)}`,
  withTail: (sentence: string, lines: string[]) =>
    lines.length ? `${sentence} — the game's last stderr lines: ${lines.join(" | ")}` : sentence,
} as const;

/** Deadlines on the real clock; an armed one never keeps the studio alive. */
const REAL_DEADLINES: PlayDeadlines = {
  after(ms, fire) {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** A child process's pipes and exit, for the client. */
export function playStreamsOf(child: ChildProcess): PlayStreams {
  const { stdout, stdin, stderr } = child;
  if (!stdout || !stdin) throw new Error("a play process needs piped stdin and stdout");
  const exited = new Promise<PlayExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return { readable: stdout, writable: stdin, ...(stderr ? { stderr } : {}), exited };
}

/** Read a stderr stream to its end, keeping only its last {@link STDERR_TAIL_CHARS}; answers its last lines. */
function stderrTail(stream: Readable | undefined): () => string[] {
  let kept = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    kept = (kept + chunk).slice(-STDERR_TAIL_CHARS);
  });
  // A broken stderr pipe only loses the tail; it never fails the game's calls.
  stream?.on("error", () => {});
  return () =>
    kept
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-STDERR_TAIL_LINES)
      .map((line) => line.slice(0, LOGGED_LINE_CHARS));
}

/** Is this a non-null, non-array object whose fields can be read? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An engine refusal code the studio knows, or null. */
function knownCode(raw: unknown): PlayErrorCode | null {
  return Object.values(PlayErrorCode).find((code) => code === raw) ?? null;
}

/**
 * Split a character stream into lines, refusing any line longer than {@link MAX_PLAY_LINE_CHARS}:
 * its characters are discarded as they arrive, and the head is kept so the reply can be named.
 */
function lineSplitter(onLine: (line: string) => void, onOversize: (head: string) => void): (chunk: string) => void {
  let parts: string[] = [];
  let length = 0;
  let oversize: string | null = null;
  const take = (piece: string) => {
    if (oversize !== null) return;
    if (length + piece.length > MAX_PLAY_LINE_CHARS) {
      oversize = (parts.join("") + piece).slice(0, OVERSIZE_ID_PROBE_CHARS);
      parts = [];
      length = 0;
      return;
    }
    parts.push(piece);
    length += piece.length;
  };
  return (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; end = chunk.indexOf("\n", start)) {
      take(chunk.slice(start, end));
      start = end + 1;
      if (oversize !== null) onOversize(oversize);
      else onLine(parts.join(""));
      parts = [];
      length = 0;
      oversize = null;
    }
    take(chunk.slice(start));
  };
}

/** A call waiting for its reply. */
interface Pending {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: PlayProtocolError) => void;
  cancel: () => void;
}

/** What the handshake is waiting on: the ready line, or the reason it will never come. */
interface Handshake {
  resolve: (ready: Record<string, unknown>) => void;
  reject: (error: PlayProtocolError) => void;
}

/** The connection's state shared by its line handler, its calls and its exit. */
interface Wire {
  pending: Map<number, Pending>;
  handshake: Handshake | null;
  exited: boolean;
  log: (line: string) => void;
  /** A failure sentence with the game's last stderr lines after it. */
  told: (sentence: string) => string;
}

/** The engine's refusal as a typed failure: its own code when the studio knows it, else bad-reply. */
function refusalOf(op: string, message: Record<string, unknown>): PlayProtocolError {
  const code = knownCode(message.code);
  if (!code) return new PlayProtocolError(PlayFailure.BadReply, op, MESSAGE.badReply(op));
  const why = typeof message.error === "string" ? message.error : code;
  return new PlayProtocolError(code, op, MESSAGE.refused(op, why));
}

/** A reply line: settle the call it names, or drop it. */
function settleReply(wire: Wire, message: Record<string, unknown>, line: string): void {
  const id = typeof message.id === "number" ? message.id : null;
  const call = id === null ? undefined : wire.pending.get(id);
  if (id === null || !call) {
    wire.log(MESSAGE.dropped("a reply to no pending call", line));
    return;
  }
  if (typeof message.ok !== "boolean") {
    wire.log(MESSAGE.dropped("a reply with no ok flag", line));
    return;
  }
  wire.pending.delete(id);
  call.cancel();
  if (message.ok) call.resolve(message.result ?? null);
  else call.reject(refusalOf(call.op, message));
}

/** An id-less line: the handshake's ready or fatal, or an event that is only logged. */
function handleEvent(wire: Wire, message: Record<string, unknown>, line: string): void {
  const handshake = wire.handshake;
  const ready = message.event === PlayEvent.Ready;
  const fatal = message.event === PlayEvent.Fatal;
  if (!handshake || !(ready || fatal)) {
    wire.log(MESSAGE.dropped("an event", line));
    return;
  }
  wire.handshake = null;
  if (ready) {
    handshake.resolve(message);
    return;
  }
  const why = typeof message.error === "string" ? message.error : "no reason given";
  handshake.reject(new PlayProtocolError(PlayFailure.Fatal, PlayEvent.Fatal, wire.told(MESSAGE.fatal(why))));
}

/** A line as a JSON object, or null after logging why it was dropped. */
function parsedLine(wire: Wire, line: string): Record<string, unknown> | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    wire.log(MESSAGE.dropped("a line that is not JSON", line));
    return null;
  }
  if (isRecord(message)) return message;
  wire.log(MESSAGE.dropped("a line that is not an object", line));
  return null;
}

/** One complete stdout line: an event while the handshake waits or when it carries no id, else a reply. */
function handleLine(wire: Wire, raw: string): void {
  const line = raw.trim();
  const message = line ? parsedLine(wire, line) : null;
  if (!message) return;
  if (wire.handshake || message.id === undefined) handleEvent(wire, message, line);
  else settleReply(wire, message, line);
}

/** An oversize line: fail the call its head names, if it names one; the rest is dropped. */
function handleOversize(wire: Wire, head: string): void {
  const id = /^\s*\{\s*"id"\s*:\s*(\d+)/.exec(head)?.[1];
  const call = id === undefined ? undefined : wire.pending.get(Number(id));
  wire.log(MESSAGE.dropped("an oversize line", head));
  if (!call) return;
  wire.pending.delete(Number(id));
  call.cancel();
  call.reject(new PlayProtocolError(PlayFailure.Oversize, call.op, MESSAGE.oversize(call.op)));
}

/** The process is gone: the handshake and every pending call fail with `exited`. */
function handleExit(wire: Wire): void {
  if (wire.exited) return;
  wire.exited = true;
  wire.handshake?.reject(
    new PlayProtocolError(PlayFailure.Exited, PlayEvent.Ready, wire.told(MESSAGE.exited(PlayEvent.Ready))),
  );
  wire.handshake = null;
  for (const [id, call] of wire.pending) {
    wire.pending.delete(id);
    call.cancel();
    call.reject(new PlayProtocolError(PlayFailure.Exited, call.op, wire.told(MESSAGE.exited(call.op))));
  }
}

/** Write one request line, or fail it at once when the process is gone. */
function request(
  wire: Wire,
  streams: PlayStreams,
  deadlines: PlayDeadlines,
  next: () => number,
  call: { op: string; args: Record<string, unknown>; timeoutMs: number },
): Promise<unknown> {
  const { op, timeoutMs } = call;
  if (wire.exited) return Promise.reject(new PlayProtocolError(PlayFailure.Exited, op, wire.told(MESSAGE.exited(op))));
  const id = next();
  return new Promise((resolve, reject) => {
    const cancel = deadlines.after(timeoutMs, () => {
      if (!wire.pending.delete(id)) return;
      reject(new PlayProtocolError(PlayFailure.Timeout, op, wire.told(MESSAGE.timeout(op, timeoutMs))));
    });
    wire.pending.set(id, { op, resolve, reject, cancel });
    streams.writable.write(`${JSON.stringify({ ...call.args, id, op })}\n`);
  });
}

/**
 * Open a client on a game process's pipes: wait for its ready line (or its fatal line, its exit,
 * or the deadline), then answer calls. Rejects with a {@link PlayProtocolError} when it never
 * becomes ready.
 */
export async function openPlayClient(streams: PlayStreams, options: PlayClientOptions = {}): Promise<PlayClient> {
  const deadlines = options.deadlines ?? REAL_DEADLINES;
  const readyTimeoutMs = options.readyTimeoutMs ?? PLAY_READY_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? PLAY_CALL_TIMEOUT_MS;
  const tail = stderrTail(streams.stderr);
  const wire: Wire = {
    pending: new Map(),
    handshake: null,
    exited: false,
    log: options.log ?? (() => {}),
    told: (sentence) => MESSAGE.withTail(sentence, tail()),
  };
  let ids = 0;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    wire.handshake = { resolve, reject };
  });
  const cancelReady = deadlines.after(readyTimeoutMs, () => {
    wire.handshake?.reject(
      new PlayProtocolError(PlayFailure.NotReady, PlayEvent.Ready, wire.told(MESSAGE.notReady(readyTimeoutMs))),
    );
    wire.handshake = null;
  });
  const split = lineSplitter(
    (line) => handleLine(wire, line),
    (head) => handleOversize(wire, head),
  );
  streams.readable.setEncoding("utf8");
  streams.readable.on("data", (chunk: string) => split(chunk));
  streams.readable.once("end", () => handleExit(wire));
  streams.readable.once("error", () => handleExit(wire));
  // A write racing the process's death errors on stdin; the exit already fails what was pending.
  streams.writable.on("error", (error) => wire.log(`[play] stdin write failed: ${error.message}`));
  void streams.exited.then(() => handleExit(wire));
  const said = await ready.finally(cancelReady);
  const call = (op: string, args: Record<string, unknown>, timeoutMs?: number) =>
    request(wire, streams, deadlines, () => ++ids, { op, args, timeoutMs: timeoutMs ?? callTimeoutMs });
  return {
    ready: said,
    get exited() {
      return wire.exited;
    },
    call: (op, args, callOptions) => call(op, { ...args }, callOptions?.timeoutMs),
    send: (op, args, callOptions) => call(op, args, callOptions?.timeoutMs),
    close: () => {
      streams.writable.end();
    },
    stderrTail: tail,
  };
}
