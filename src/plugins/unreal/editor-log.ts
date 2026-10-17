/**
 * A project's own Unreal editor log, read to tell "this project is still loading" from "another
 * project is open" and to learn that Epic's server couldn't listen on the project's port, and
 * watched for a crash while a call to the editor is pending or a part is in the editor. Unreal starts
 * the log when the editor opens (`Log file open, <local time>`), names the project on its command
 * line near the top (quoted when its path has a space) and ends it with `Log file closed`; a crash
 * writes Unreal's own error lines last: its critical-error banner, the signal, the call stack and
 * the shutdown. A bounded head and tail are read, plus a capped scan for the line that says loading
 * finished; a watch reads only what was appended since it started. A log that is a link is not read,
 * and a log names the project by any spelling of its real path. A log that never closed is open
 * only while an editor holds it, when the computer can tell (`editor-holds.ts`). The live
 * builder's checkpoint reads the error lines a log gained since an offset (`log-errors`), without
 * Unreal's and Genex's own noise, across a log Unreal started anew.
 */
import { constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openNoFollow } from "../../substrate/fsx.ts";
import type { LogHeld } from "./editor-holds.ts";
import { sameProject } from "./editor-port.ts";

/** The top of the log: the open line and the command line come within the first few KB. */
const LOG_HEAD_BYTES = 8 * 1024;
/** The end of the log: its last lines say whether it closed and whether Epic's server started. */
const LOG_TAIL_BYTES = 8 * 1024;
/** `Log file open, MM/DD/YY HH:MM:SS`, in the computer's local time, after an optional byte-order mark. */
const OPENED = /^﻿?Log file open, (\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const CLOSED = "Log file closed";
const MCP_STARTED = "LogModelContextProtocol: Starting MCP server on port";
/** Unreal's line once the editor has finished loading; Epic's server answers within about a second of it. */
const LOADED = "LogLoad: (Engine Initialization) Total time:";
/** How far into a log the loaded line is looked for, in chunks; a loading log is a few MB at most. */
const LOG_SCAN_BYTES = 16 * 1024 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;
/**
 * The command line as Unreal logs it, the project between `"" ` and `""`; a path with a space is
 * quoted once more (`commandline="" "/Users/x/AI Games/y.uproject"""`).
 */
const COMMAND_LINE = /commandline="" ("?)(.+?)\1""/;
const CENTURY = 2000;
const LINE_BREAK = /\r?\n/;
const NEWLINE = 0x0a;
const NOTHING = Buffer.alloc(0);
/** At most this much of what a watched log gained between two reads is read: a crash is what Unreal writes last. */
const WATCH_READ_BYTES = 256 * 1024;
/** A line still being written is kept for the next read up to this long; a longer one is no crash line. */
const PARTIAL_LINE_BYTES = 16 * 1024;
/** What a crash's text is cut to for the agent. */
const CRASH_DETAIL_MAX_CHARS = 300;
/**
 * Epic's HTTP server's line when it can't listen on Genex's address and port (a quit editor's
 * sockets still held it): it carries on without that listener, so the MCP server never answers.
 */
const BIND_FAILED =
  /^(?:\[[^\]]*\]\[\s*\d+\])?LogHttpListener: Error: HttpListener unable to bind to 127\.0\.0\.1:([1-9]\d{0,4})\s*$/;

const MESSAGE = {
  PortBlocked: (port: number) =>
    `Unreal couldn't open Genex's connection on port ${port}, so it won't answer. Ask the user to quit Unreal and open the game again from the Unreal button.`,
} as const;

/**
 * Unreal's own crash lines, by its fixed log format: the error it raised (`appError called:
 * <message>`), the banner that opens its crash report (the next message line says what failed),
 * the report's call-stack lines, and where a message names its source file.
 */
const CrashLine = {
  Raised: "appError called: ",
  Report: "=== Critical error: ===",
  Callstack: "[Callstack]",
  Source: " [File:",
  Shutdown: "Executing StaticShutdownAfterError",
} as const;

/**
 * What a crash report names as its signal when Unreal names no signal or exception: a failed
 * assert, another fatal error, or (`Exited`) an editor whose process ended without writing a crash.
 */
export const CrashSignal = { Assert: "assert", Error: "error", Exited: "exited" } as const;
export type CrashSignal = (typeof CrashSignal)[keyof typeof CrashSignal];

/** The signal a Mac editor died of (`SIGSEGV: invalid attempt to access memory…`), and Windows' exception. */
const SIGNAL = /^(SIG[A-Z]{2,7})\b/;
const EXCEPTION = /\b(EXCEPTION_[A-Z_]{2,40})\b/;
/** Unreal's text for a failed `check()`. */
const ASSERT_TEXT = "Assertion failed";
/**
 * One call stack frame after its optional `[Callstack]`: its address, the library and the function
 * (`0x5635bb18 libUnrealEditor-DirtTrack-1234.dylib!AMyGameMode::MakeBike(APawn*)`), then
 * where Unreal found its source, if anywhere (`[UnknownFile])`, `[<path>:<line>]`), which is dropped.
 */
const FRAME = /^(?:\[Callstack\]\s+)?0x[0-9a-fA-F]+\s+([^\s!]+)!(.+?)(?:\s+\[[^\]]*\]\)?)?\s*$/;
/** A library of the game's own: `libUnrealEditor-<Module>[-<hot reload>].dylib`, or Windows' `.dll`. */
const GAME_LIBRARY = /^(?:lib)?UnrealEditor-([A-Za-z_][A-Za-z0-9_]*?)(-\d+)?\.(?:dylib|dll)$/;
/** The frames a crash report names, top first, and how long each may be. */
const MAX_FRAMES = 8;
const FRAME_MAX_CHARS = 200;
/** How long a crash's cause may be in one line. */
const CAUSE_MAX_CHARS = 160;
/** A stamp-only prefix, for lines whose text starts with a word and a colon of its own (`SIGSEGV: …`). */
const STAMP = /^\[[^\]]*\]\[\s*\d+\]/;
/** How long a log line an agent reads may be. */
const SHOWN_LINE_MAX_CHARS = 300;
const ELLIPSIS = "…";
/** An absolute or home path up to a `Source/` folder: dropped, so the file reads from Source/ on. */
const BEFORE_SOURCE = /(?<=^|[\s'"(=:])~?\/(?:[^/\n]+\/)*?(?=Source\/)/g;
/** A quoted absolute or home path, spaces and all (Python's tracebacks): kept as its base name, in its quotes. */
const QUOTED_PATH = /(["'])~?\/[^"'\n]*\/([^"'\n/]*)\1/g;
/** Any other absolute or home path, but Unreal's own package paths (`/Game/…`, `/Script/…`): kept as its base name. */
const OTHER_PATH = /(?<![\w.~])~?\/(?!(?:Game|Engine|Script|Temp|Memory)\/)(?:[^\s/'"`():,;]+\/)+([^\s/'"`():,;]*)/g;
/** Unreal's line for an error: its optional stamp, its category, `Error` or `Fatal`, and the message. */
const ERROR_LINE = /^(?:\[[^\]]*\]\[\s*\d+\])?([A-Za-z]\w*): (Error|Fatal):(.*)$/;
/** The most error lines `log-errors` names; it counts the rest. */
const LOG_ERRORS_MAX_LINES = 40;

/**
 * Error lines that are never the game's, by category and, where the category also carries the
 * game's errors, by the message's start: Epic's MCP server and online services, Genex's own bridge
 * and toolset calls, the engine's own start-up complaint, and an ensure's call stack and blank
 * lines (its first line says what failed).
 */
const LOG_NOISE: ReadonlyArray<{ category: RegExp; message?: RegExp }> = [
  { category: /^LogHttp(?:Connection|Listener)$/ },
  { category: /^LogModelContextProtocol$/ },
  { category: /^LogToolsetRegistry$/ },
  { category: /^(?:LogEOS\w*|LogOnline\w*|LogFriendsAndChatManager|LogPortal\w*|LogSelfUpdateService)$/ },
  { category: /^LogClass$/, message: /^ByteProperty FStepSettings::TraceChannel is not initialized properly/ },
  { category: /^LogAutomationTest$/, message: /^LogClass: ByteProperty FStepSettings::TraceChannel/ },
  { category: /^LogOutputDevice$/, message: /^(?:\[Callstack\]|$)/ },
];
/** A line's optional `[time][frame]` stamp, then its optional `Category: ` and `Verbosity: `. */
const LOG_PREFIX =
  /^(?:\[[^\]]*\]\[\s*\d+\])?(?:[A-Za-z]\w*: (?:(?:Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose): )?)?/;
/** Trailing punctuation and space after a crash's text, dropped so the agent's sentence reads on. */
const TRAILING = /[\s.:!]+$/;

/**
 * What a project's log says: whether the editor still has it open, when it opened (ms), when the
 * log last changed (ms), whether Epic's MCP server has started, about 5 s before it answers,
 * whether the editor has finished loading, and whether Epic's server couldn't listen on the port
 * it was asked about (so it will never answer).
 */
export type EditorLog = {
  open: boolean;
  /** The log never closed and nothing could tell whether an editor still holds it (no lsof, or lsof failed). */
  openUnsure?: boolean;
  openedAt: number;
  mtime: number;
  mcpStarted: boolean;
  loaded: boolean;
  portBlocked?: boolean;
};

/** Whether `line` is Epic's own line saying its server couldn't listen on 127.0.0.1:`port`. */
const blocksPort = (line: string, port: number) => Number(BIND_FAILED.exec(line)?.[1]) === port;

/** Whether the log lines hold Epic's line saying its server couldn't listen on the project's own `port`. */
export function portBlockedIn(lines: readonly string[], port: number): boolean {
  return lines.some((line) => blocksPort(line, port));
}

/** Unreal is open but Epic's server couldn't listen on the project's port, so waiting for it is pointless. */
export class PortBlockedError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(MESSAGE.PortBlocked(port));
    this.port = port;
  }
}

/**
 * The account's own home, where Unreal writes its Mac logs, whatever `HOME` says: Studio starts a
 * plugin's MCP server with `HOME` inside the plugin's storage, where `os.homedir()` would look.
 */
export function userHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/** Unreal's own logs folder on a Mac, under the account's `home`: one `<Project>Editor` folder per project. */
export const macLogsFolder = (home: string) => path.posix.join(home, "Library", "Logs", "Unreal Engine");

/** Where Unreal writes a project's editor log: ~/Library/Logs on a Mac, the project's Saved/Logs on Windows. */
export function editorLogPath(
  project: { file: string; directory: string },
  home: string,
  platform: NodeJS.Platform,
): string {
  const name = (platform === "win32" ? path.win32 : path.posix).parse(project.file).name;
  if (platform === "win32") return path.win32.join(project.directory, "Saved", "Logs", `${name}.log`);
  return path.posix.join(macLogsFolder(home), `${name}Editor`, `${name}.log`);
}

/** When the log's first line says the editor opened, in local time; undefined unless it is Unreal's open line. */
function openedAt(head: string): number | undefined {
  const match = OPENED.exec(head);
  if (!match) return undefined;
  const [month, day, year, hour, minute, second] = match.slice(1).map(Number);
  return new Date(CENTURY + year, month - 1, day, hour, minute, second).getTime();
}

type LogHandle = Awaited<ReturnType<typeof openNoFollow>>;

/** The bytes at `position`, up to `length`. */
async function readBytes(handle: LogHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The bytes at `position` up to `length`, as text. */
async function readAt(handle: LogHandle, position: number, length: number) {
  return (await readBytes(handle, position, length)).toString("utf8");
}

/**
 * When the log whose head this is opened, if it is Unreal's log of `project` (its real `.uproject`):
 * its command line names the project as it is, or by any spelling whose real path it is (through a
 * link, or in another case on a disk that ignores case).
 */
async function openedFor(head: string, project: string): Promise<number | undefined> {
  const named = COMMAND_LINE.exec(head)?.[2];
  if (named === undefined || !(await sameProject(named, project))) return undefined;
  return openedAt(head);
}

/**
 * Whether the log at `file` is Unreal's log of `project` (its real `.uproject`), as a crash
 * report's copy of the editor's log is: a plain file, not a link, whose head names it.
 */
export async function logOfProject(file: string, project: string): Promise<boolean> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return false;
    return (await openedFor(await readAt(handle, 0, Math.min(info.size, LOG_HEAD_BYTES)), project)) !== undefined;
  } finally {
    await handle.close();
  }
}

/** What a scan of the whole log found: Unreal's loaded line, and Epic's failure to listen on the port asked about. */
type LogScan = { loaded: boolean; portBlocked: boolean };

/** Notes in `scan` what complete lines say. */
function noteLines(scan: LogScan, lines: readonly string[], port: number | undefined) {
  scan.loaded ||= lines.some((line) => line.includes(LOADED));
  scan.portBlocked ||= port !== undefined && portBlockedIn(lines, port);
}

/**
 * Reads the log line by line in chunks up to a cap, until it has found what it looks for: a line
 * across two chunks is still found, and a line too long to be Unreal's is dropped.
 */
async function scanLog(handle: LogHandle, size: number, port: number | undefined): Promise<LogScan> {
  const end = Math.min(size, LOG_SCAN_BYTES);
  const scan: LogScan = { loaded: false, portBlocked: false };
  const found = () => scan.loaded && (scan.portBlocked || port === undefined);
  let carry = "";
  for (let position = 0; position < end && !found(); position += LOG_CHUNK_BYTES) {
    const text = carry + (await readAt(handle, position, Math.min(LOG_CHUNK_BYTES, end - position)));
    const lines = text.split(LINE_BREAK);
    const last = lines.pop() ?? "";
    carry = last.length > PARTIAL_LINE_BYTES ? "" : last;
    noteLines(scan, lines, port);
  }
  noteLines(scan, [carry], port);
  return scan;
}

/**
 * What the log at `file` says about `project` (its real `.uproject`) and, given one, the project's
 * own `port`; undefined when the log is missing, a link, not a plain file, not Unreal's log, or
 * names another project. A log that never closed is open unless `held` says no editor holds it
 * (an editor that crashed leaves it so); without `held`, or when it can't tell, it is open and
 * `openUnsure`.
 */
export async function readEditorLog(
  file: string,
  project: string,
  port?: number,
  held?: LogHeld,
): Promise<EditorLog | undefined> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const opened = await openedFor(await readAt(handle, 0, Math.min(info.size, LOG_HEAD_BYTES)), project);
    if (opened === undefined) return undefined;
    const tailStart = Math.max(0, info.size - LOG_TAIL_BYTES);
    const tail = await readAt(handle, tailStart, info.size - tailStart);
    const last =
      tail
        .split(LINE_BREAK)
        .filter((line) => line.trim() !== "")
        .at(-1) ?? "";
    const scan = await scanLog(handle, info.size, port);
    const unclosed = !last.includes(CLOSED);
    const holds = unclosed ? await held?.(file) : false;
    return {
      open: unclosed && holds !== false,
      ...(unclosed && holds === undefined ? { openUnsure: true } : {}),
      openedAt: opened,
      mtime: info.mtimeMs,
      mcpStarted: tail.includes(MCP_STARTED),
      ...scan,
    };
  } finally {
    await handle.close();
  }
}

/** A crash Unreal wrote to its log, with its own text for what failed when it gave one. */
export type EditorCrash = { detail: string | undefined };

/** A line's message, without Unreal's stamp, category and verbosity. */
const messageOf = (line: string) => line.replace(LOG_PREFIX, "").trim();

/** A crash's text as the agent reads it: without its source file and line, trailing punctuation or excess length. */
function crashDetail(text: string): string | undefined {
  const [what = ""] = text.split(CrashLine.Source);
  return what.trim().slice(0, CRASH_DETAIL_MAX_CHARS).replace(TRAILING, "") || undefined;
}

/** The first message after the crash report's banner at `banner` that isn't its call stack. */
function reportDetail(messages: string[], banner: number): string | undefined {
  if (banner < 0) return undefined;
  const next = messages.slice(banner + 1).find((m) => m !== "" && !m.startsWith(CrashLine.Callstack));
  return next === undefined ? undefined : crashDetail(next);
}

/**
 * The crash among complete log lines, or undefined when they hold none. Unreal's raised error says
 * what failed; without it, the first message after its crash report's banner does.
 */
export function crashIn(lines: readonly string[]): EditorCrash | undefined {
  const messages = lines.map(messageOf);
  const raised = messages.find((message) => message.startsWith(CrashLine.Raised));
  const banner = messages.indexOf(CrashLine.Report);
  if (raised === undefined && banner < 0) return undefined;
  const said = raised === undefined ? undefined : crashDetail(raised.slice(CrashLine.Raised.length));
  return { detail: said ?? reportDetail(messages, banner) };
}

/** A pending call's watch of its editor's log: `crashed` settles once a crash is written after it began; `stop` ends it. */
export type CrashWatch = { crashed: Promise<EditorCrash>; stop: () => Promise<void> };

/** How far a watch has read a log: which file (by inode), up to which byte, and the start of a line still being written. */
type LogMark = { ino: number; offset: number; partial: Buffer };

/** Where the log ends now: the lines before it are not the watch's. */
async function logEnd(file: string): Promise<LogMark | undefined> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    return info.isFile() ? { ino: info.ino, offset: info.size, partial: NOTHING } : undefined;
  } finally {
    await handle.close();
  }
}

/** The complete lines in `bytes`, and what is left of a last line still being written. */
function splitLines(bytes: Buffer): { lines: string[]; partial: Buffer } {
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  const partial = bytes.subarray(end);
  return {
    lines: bytes.subarray(0, end).toString("utf8").split(LINE_BREAK),
    partial: partial.length > PARTIAL_LINE_BYTES ? NOTHING : Buffer.from(partial),
  };
}

/**
 * The complete lines `project`'s log gained since `mark`, and the mark to read on from; none from a
 * log that is missing, a link, not a plain file or another project's. A log started anew (another
 * file, or shorter than the mark) is read from its start, and at most its last {@link WATCH_READ_BYTES}.
 */
async function readAppended(file: string, project: string, mark: LogMark | undefined) {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return { lines: [], mark };
  try {
    const info = await handle.stat();
    const same = mark !== undefined && mark.ino === info.ino && info.size >= mark.offset;
    const from = same ? mark.offset : 0;
    if (!info.isFile() || info.size === from) return { lines: [], mark };
    const next = { ino: info.ino, offset: info.size, partial: NOTHING };
    const head = await readAt(handle, 0, Math.min(info.size, LOG_HEAD_BYTES));
    if ((await openedFor(head, project)) === undefined) return { lines: [], mark: next };
    const start = Math.max(from, info.size - WATCH_READ_BYTES);
    const carried = same && start === from ? mark.partial : NOTHING;
    const { lines, partial } = splitLines(Buffer.concat([carried, await readBytes(handle, start, info.size - start)]));
    return { lines, mark: { ...next, partial } };
  } finally {
    await handle.close();
  }
}

/** Each call answers the complete lines a log gained since the one before; never throws. */
export type LogTail = () => Promise<string[]>;

/** Starts reading what `project`'s log at `file` gains from now on, one call at a time. */
export async function tailLog(file: string, project: string): Promise<LogTail> {
  let mark = await logEnd(file).catch(() => undefined);
  return async () => {
    const read = await readAppended(file, project, mark).catch(() => ({ lines: [], mark }));
    mark = read.mark;
    return read.lines;
  };
}

/**
 * Watches `project`'s log at `file` for a crash written after the watch begins, reading what the
 * log gained every `everyMs`, one read at a time. `stop` ends the watch and waits out a read under
 * way, so nothing is left running.
 */
export async function watchForCrash(file: string, project: string, everyMs: number): Promise<CrashWatch> {
  const next = await tailLog(file, project);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let reading: Promise<void> = Promise.resolve();
  let report: (crash: EditorCrash) => void = () => {};
  const crashed = new Promise<EditorCrash>((resolve) => {
    report = resolve;
  });
  const read = async () => {
    const crash = crashIn(await next());
    if (crash) report(crash);
    else if (!stopped) timer = setTimeout(tick, everyMs);
  };
  const tick = () => {
    reading = read();
  };
  timer = setTimeout(tick, everyMs);
  return {
    crashed,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await reading;
    },
  };
}

/**
 * What a crashed editor died of, for the Loop: the signal (`SIGSEGV`, Windows' exception, or a
 * {@link CrashSignal}), the call stack's top functions with their parameters (no library, path or
 * address), what failed in one line (the signal, or Unreal's assert text), and the frame to name
 * (the game module's first, else the top one).
 */
export type CrashReport = { signal: string; frames: string[]; cause: string; at: string | undefined };

/** One frame of a call stack: its library and its function. */
type Frame = { library: string; name: string };

/** A frame as the report names it: the function with its parameters, cut short. */
const frameName = (text: string) => {
  const name = text.trim();
  return name.length > FRAME_MAX_CHARS ? `${name.slice(0, FRAME_MAX_CHARS - 1)}…` : name;
};

/** The call stack's frames among a crash's lines, top first. */
function framesIn(lines: readonly string[]): Frame[] {
  return lines.flatMap((line) => {
    const match = FRAME.exec(messageOf(line));
    return match?.[1] && match[2] ? [{ library: match[1], name: frameName(match[2]) }] : [];
  });
}

/** Whether a frame runs the game's own code: its module's library, or one hot reload made (`-<n>`). */
function isGameFrame(frame: Frame, module: string | undefined): boolean {
  const library = GAME_LIBRARY.exec(frame.library);
  if (!library) return false;
  const named = module !== undefined && library[1]?.toLowerCase() === module.toLowerCase();
  return named || library[2] !== undefined;
}

/** The signal or exception Unreal names in a crash's lines that aren't its call stack. */
function signalIn(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (FRAME.test(messageOf(line))) continue;
    const named = SIGNAL.exec(line.replace(STAMP, "").trim())?.[1] ?? EXCEPTION.exec(line)?.[1];
    if (named) return named;
  }
  return undefined;
}

/** The index of the first line a crash wrote: its raised error, its report's banner, or its shutdown. */
function crashStart(messages: readonly string[]): number {
  return messages.findIndex(
    (m) => m.startsWith(CrashLine.Raised) || m === CrashLine.Report || m === CrashLine.Shutdown,
  );
}

/**
 * The crash among complete log lines, read for the Loop, or undefined when they hold none. Its
 * cause is the signal Unreal names, else its own text for what failed (an assert's); `module`, the
 * game's C++ module, picks the frame to name.
 */
export function crashReportIn(lines: readonly string[], module?: string): CrashReport | undefined {
  const messages = lines.map(messageOf);
  const start = crashStart(messages);
  if (start < 0) return undefined;
  const block = lines.slice(start);
  const frames = framesIn(block);
  const named = signalIn(block);
  const said = crashIn(block)?.detail?.slice(0, CAUSE_MAX_CHARS);
  const fallback = said?.startsWith(ASSERT_TEXT) ? CrashSignal.Assert : CrashSignal.Error;
  const at = (frames.find((frame) => isGameFrame(frame, module)) ?? frames[0])?.name;
  return {
    signal: named ?? fallback,
    frames: frames.slice(0, MAX_FRAMES).map((frame) => frame.name),
    cause: named ?? said ?? fallback,
    at,
  };
}

/** Asks whether the watched editor crashed since its watch began: Unreal's report once there is one; never throws. */
export type CrashCheck = () => Promise<CrashReport | undefined>;
/** What a crash check asks besides the log: whether an editor process still runs, and the game's C++ module. */
export type CrashProbe = { running: () => Promise<boolean>; module?: string };

/** An editor whose process is gone without a crash in its log. */
const EXITED: CrashReport = {
  signal: CrashSignal.Exited,
  frames: [],
  cause: "its process ended without writing a crash to its log",
  at: undefined,
};
/** How many looks in a row must find no editor process before it counts as gone: one could be a probe that failed. */
const GONE_LOOKS = 2;
/** The lines a check keeps from a crash's start on: its report and call stack come well within. */
const CRASH_BLOCK_LINES = 400;

/**
 * Starts watching `project`'s log at `file` and its editor's process for a crash from now on; each
 * call of the check reads what the log gained. A crash Unreal writes is reported once its call
 * stack is there, its process is gone, or one look later; a process gone {@link GONE_LOOKS} looks
 * in a row without one is reported as {@link CrashSignal.Exited}.
 */
export async function startCrashCheck(file: string, project: string, probe: CrashProbe): Promise<CrashCheck> {
  const next = await tailLog(file, project);
  const seen: CrashSeen = { block: undefined, waited: false, gone: 0 };
  return async () => {
    keepCrashLines(seen, await next());
    const running = await probe.running().catch(() => true);
    if (seen.block) return reportWhenReady(seen, seen.block, running, probe.module);
    seen.gone = running ? 0 : seen.gone + 1;
    return seen.gone >= GONE_LOOKS ? { ...EXITED, frames: [] } : undefined;
  };
}

/** What a crash check has seen: the lines from a crash's start on, whether it waited a look for them, and looks without a process. */
type CrashSeen = { block: string[] | undefined; waited: boolean; gone: number };

/** Keeps the lines a log gained from a crash's start on: all of them once one started. */
function keepCrashLines(seen: CrashSeen, lines: readonly string[]) {
  const start = seen.block ? 0 : crashStart(lines.map(messageOf));
  if (start < 0) return;
  seen.block = [...(seen.block ?? []), ...lines.slice(start)].slice(0, CRASH_BLOCK_LINES);
}

/** The crash in `block` once its call stack is there, its process is gone, or a look later. */
function reportWhenReady(seen: CrashSeen, block: string[], running: boolean, module: string | undefined) {
  const report = crashReportIn(block, module);
  const ready = report !== undefined && (report.frames.length > 0 || !running || seen.waited);
  seen.waited = true;
  return ready ? report : undefined;
}

/**
 * One line of an editor's log as an agent reads it: a machine path from its `Source/` folder on, or
 * else by its base name (never the owner's folders), Unreal's own package paths kept, cut short.
 */
export function shownLine(line: string): string {
  const text = line
    .trim()
    .replace(BEFORE_SOURCE, "")
    .replace(QUOTED_PATH, (_path, quote: string, base: string) => `${quote}${base}${quote}`)
    .replace(OTHER_PATH, (_path, base: string) => base);
  if (text.length <= SHOWN_LINE_MAX_CHARS) return text;
  return `${text.slice(0, SHOWN_LINE_MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** Whether an error line is noise: one of {@link LOG_NOISE}'s categories, with its message's start where it names one. */
const isNoise = (category: string, message: string) =>
  LOG_NOISE.some((noise) => noise.category.test(category) && (noise.message?.test(message) ?? true));

/** An error line as `log-errors` names it, without its stamp; undefined for any other line, and for noise. */
function shownError(line: string): string | undefined {
  const [, category = "", verbosity = "", said = ""] = ERROR_LINE.exec(line.trimEnd()) ?? [];
  const message = said.trim();
  if (!category || isNoise(category, message)) return undefined;
  return shownLine(`${category}: ${verbosity}: ${message}`);
}

/** What `log-errors` answers: where to read on from, the error lines (each once), how many more, and whether the log was a new one. */
export type LogErrors = { offset: number; lines: string[]; more: number; rotated: boolean };
/** A read of a log's errors and the log's file (by inode) it read, for telling the next read's log from it. */
export type LogErrorsRead = LogErrors & { ino: number | null };
/** Where a read of a log ended: the byte offset, and the log's file (by inode) then, when known. */
export type LogPlace = { offset: number; ino?: number };

/** Nothing to read: a log that is missing, a link, not a plain file, or not this project's. */
const NOTHING_READ: LogErrorsRead = { offset: 0, lines: [], more: 0, rotated: false, ino: null };

/** Collects error lines once each, the first {@link LOG_ERRORS_MAX_LINES} by name and the rest by count. */
function errorCollector() {
  const seen = new Set<string>();
  const lines: string[] = [];
  let more = 0;
  return {
    take(line: string) {
      const shown = shownError(line);
      if (shown === undefined || seen.has(shown)) return;
      seen.add(shown);
      if (lines.length < LOG_ERRORS_MAX_LINES) lines.push(shown);
      else more++;
    },
    found: () => ({ lines, more }),
  };
}

/**
 * Hands each complete line from `from` up to `end` to `take`, read in chunks: a line begun before
 * `from` is skipped, and a line still being written is left for the next read. Answers the offset
 * after the last complete line.
 */
async function eachCompleteLine(handle: LogHandle, from: number, end: number, take: (line: string) => void) {
  let skip = from > 0 && (await readBytes(handle, from - 1, 1))[0] !== NEWLINE;
  let carry = NOTHING;
  let after = from;
  for (let position = from; position < end; position += LOG_CHUNK_BYTES) {
    const chunk = await readBytes(handle, position, Math.min(LOG_CHUNK_BYTES, end - position));
    const bytes = Buffer.concat([carry, chunk]);
    const cut = bytes.lastIndexOf(NEWLINE) + 1;
    carry = Buffer.from(bytes.subarray(cut));
    // A line this long is no line of Unreal's: it is dropped, not carried.
    if (carry.length > PARTIAL_LINE_BYTES) carry = NOTHING;
    after = position + chunk.length - carry.length;
    if (cut === 0) continue;
    const lines = bytes
      .subarray(0, cut - 1)
      .toString("utf8")
      .split(LINE_BREAK);
    for (const line of skip ? lines.slice(1) : lines) take(line);
    skip = false;
  }
  return after;
}

/**
 * The error lines `project`'s log at `file` gained since `since` (its end now, and none, without
 * it), Unreal's and Genex's own noise left out, each once and shown as {@link shownLine} shows it.
 * A log started anew since (another file than `since.ino`, or shorter than its offset) is read from
 * its start and answered `rotated`; at most {@link LOG_SCAN_BYTES} are read per call, and the
 * offset answered is where the next read goes on. A log that is missing, a link, not a plain file
 * or another project's answers nothing.
 */
export async function errorLinesSince(file: string, project: string, since?: LogPlace): Promise<LogErrorsRead> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return { ...NOTHING_READ };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ...NOTHING_READ };
    const head = await readAt(handle, 0, Math.min(info.size, LOG_HEAD_BYTES));
    if ((await openedFor(head, project)) === undefined) return { ...NOTHING_READ };
    if (since === undefined) return { offset: info.size, lines: [], more: 0, rotated: false, ino: info.ino };
    const otherFile = since.ino !== undefined && since.ino !== info.ino;
    const rotated = otherFile || since.offset > info.size;
    const from = rotated ? 0 : since.offset;
    const errors = errorCollector();
    const offset = await eachCompleteLine(handle, from, Math.min(info.size, from + LOG_SCAN_BYTES), errors.take);
    return { offset, ...errors.found(), rotated, ino: info.ino };
  } finally {
    await handle.close();
  }
}
