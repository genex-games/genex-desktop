import { randomUUID } from "node:crypto";
import { SECOND_MS } from "../shared/duration.ts";
import {
  TERMINAL_LIMITS,
  TerminalKind,
  terminalSize,
  type TerminalEvent,
  type TerminalSession,
  revealsDock,
} from "../shared/terminal.ts";
import { commandOutput, keepTail } from "./terminal-command.ts";

/** A host that has not started its shell by then is killed. */
const START_TIMEOUT_MS = 15 * SECOND_MS;
/** A stopping host that has not exited by then is killed. */
const STOP_TIMEOUT_MS = 4 * SECOND_MS;
/** The exit code a session stopped by the user reports: the shell's own for an interrupt. */
export const INTERRUPTED_EXIT_CODE = 130;

/** What the terminal panel reads when a session cannot open, take input or continue. */
const MESSAGE = {
  closing: "Terminals are closing. Try again in a moment.",
  tooMany: "Close a terminal session before opening another.",
  couldNotStart: "The terminal could not start. Try opening it again.",
  endedUnexpectedly: "Terminal process ended unexpectedly.",
  closed: "This terminal session has closed.",
  inputTooLarge: "Terminal input is too large. Paste a smaller selection.",
  stopFirst: "Stop this terminal before closing its session.",
  commandRunning: "A command is already running for this game. Wait for it to finish or stop it.",
} as const;

/** What the terminal host utility tells main. */
export const HostEventType = {
  Ready: "ready",
  Data: "data",
  Link: "link",
  Started: "started",
  Exit: "exit",
} as const;

/** What main tells the terminal host utility. */
export const HostCommand = {
  Start: "start",
  Attach: "attach",
  Ack: "ack",
  Input: "input",
  Resize: "resize",
  Stop: "stop",
} as const;
export type HostCommand = (typeof HostCommand)[keyof typeof HostCommand];

export interface TerminalLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  title: string;
  kind: TerminalSession["kind"];
  project?: string;
  /** A command session's command line, reported on its session. */
  command?: string;
  onUrl?: (url: string) => void;
  onExit?: (code: number) => void;
}
export interface TerminalHost {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: HostEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}
export type HostEvent =
  | { type: typeof HostEventType.Ready }
  | { type: typeof HostEventType.Data; data: string }
  | { type: typeof HostEventType.Link; url: string }
  | { type: typeof HostEventType.Started }
  | { type: typeof HostEventType.Exit; code: number; error?: string };
interface Entry {
  state: TerminalSession;
  host: TerminalHost;
  launch: TerminalLaunch;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve: () => void;
  /** A command session's newest output, where its last lines are read from when it ends. */
  tail: string;
  /** The newest https sign-in page it printed, opened only when the person asks. */
  link: string | null;
}

/** Main owns admission and lifecycle. Only the dedicated child loads the native addon. */
export class TerminalService {
  #entries = new Map<string, Entry>();
  #disposing: Promise<void> | null = null;
  private readonly createHost: () => TerminalHost;
  private readonly emit: (event: TerminalEvent) => void;
  constructor(createHost: () => TerminalHost, emit: (event: TerminalEvent) => void) {
    this.createHost = createHost;
    this.emit = emit;
  }
  list(): TerminalSession[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.state }));
  }
  open(launch: TerminalLaunch): TerminalSession {
    if (this.#disposing) throw new Error(MESSAGE.closing);
    const existing = this.#openFor(launch);
    // A second command would take the first one's place in the chat that offered it.
    if (existing && launch.kind === TerminalKind.Command) throw new Error(MESSAGE.commandRunning);
    if (existing) {
      this.emit({ type: "session", session: { ...existing.state }, reveal: revealsDock(launch.kind) });
      return { ...existing.state };
    }
    this.#makeRoom();
    const host = this.createHost();
    const state: TerminalSession = {
      id: randomUUID(),
      title: launch.title,
      kind: launch.kind,
      project: launch.project,
      phase: "starting",
      ...(launch.command === undefined ? {} : { command: launch.command }),
    };
    let resolve = () => {};
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const entry: Entry = {
      state,
      host,
      launch,
      done,
      resolve,
      tail: "",
      link: null,
      timer: setTimeout(() => {
        host.kill();
        this.#finish(entry, 1, MESSAGE.couldNotStart);
      }, START_TIMEOUT_MS),
    };
    this.#entries.set(state.id, entry);
    host.on("message", (message) => {
      if (!this.#entries.has(state.id) || state.phase === "exited") return;
      this.#onHostEvent(entry, message);
    });
    host.on("exit", (code) => {
      const expected = state.phase === "stopping" || state.phase === "exited";
      this.#finish(entry, code || 1, expected ? undefined : MESSAGE.endedUnexpectedly);
    });
    // A command a reply offered shows its output in the chat, a Settings sign-in in Settings; the
    // dock opens for them only when asked.
    this.#state(entry, revealsDock(launch.kind));
    return { ...state };
  }
  /** The live session of this kind for this project, if one is open. */
  #openFor(launch: TerminalLaunch): Entry | undefined {
    return [...this.#entries.values()].find(
      (entry) =>
        entry.state.phase !== "exited" && entry.state.kind === launch.kind && entry.state.project === launch.project,
    );
  }
  /** Finished sessions can be discarded before admitting another process; refuse when none can. */
  #makeRoom(): void {
    for (const entry of this.#entries.values())
      if (this.#entries.size >= TERMINAL_LIMITS.sessions && entry.state.phase === "exited") this.remove(entry.state.id);
    if (this.#entries.size >= TERMINAL_LIMITS.sessions) throw new Error(MESSAGE.tooMany);
  }
  #onHostEvent(entry: Entry, message: HostEvent): void {
    const { state, host, launch } = entry;
    switch (message.type) {
      case HostEventType.Ready:
        if (state.phase === "stopping") host.kill();
        else host.postMessage(startCommand(launch));
        return;
      case HostEventType.Started:
        if (state.phase === "stopping") return;
        clearTimeout(entry.timer);
        state.phase = "running";
        this.#state(entry);
        return;
      case HostEventType.Data:
        if (launch.kind === TerminalKind.Command) entry.tail = keepTail(entry.tail, message.data);
        this.emit({ type: "data", id: state.id, data: message.data });
        return;
      case HostEventType.Link:
        this.#linked(entry, message.url);
        launch.onUrl?.(message.url);
        return;
      case HostEventType.Exit:
        this.#finish(entry, message.code, message.error);
    }
  }
  /** Keep the newest https page a session printed, and tell the page it has one to open. */
  #linked(entry: Entry, url: string): void {
    if (!isHttps(url)) return;
    entry.link = url;
    if (entry.state.signInPage) return;
    entry.state.signInPage = true;
    this.#state(entry);
  }
  #state(entry: Entry, reveal = false): void {
    this.emit({ type: "session", session: { ...entry.state }, reveal });
  }
  #finish(entry: Entry, code: number, error?: string): void {
    if (entry.state.phase === "exited") return;
    const stopped = entry.state.phase === "stopping";
    clearTimeout(entry.timer);
    const exitCode = stopped ? INTERRUPTED_EXIT_CODE : code;
    Object.assign(entry.state, { phase: "exited", exitCode, error });
    if (entry.launch.kind === TerminalKind.Command) entry.state.output = commandOutput(entry.tail);
    this.#state(entry);
    entry.resolve();
    entry.launch.onExit?.(exitCode);
  }
  #get(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(MESSAGE.closed);
    return entry;
  }
  /** The newest sign-in page this session printed, or null when it printed none. */
  link(id: string): string | null {
    return this.#get(id).link;
  }
  attach(id: string): void {
    const entry = this.#get(id);
    if (entry.state.phase !== "exited") entry.host.postMessage({ type: HostCommand.Attach });
  }
  write(id: string, data: string): void {
    const entry = this.#get(id);
    if (entry.state.phase !== "running") return;
    if (typeof data !== "string" || data.length > TERMINAL_LIMITS.input) throw new Error(MESSAGE.inputTooLarge);
    entry.host.postMessage({ type: HostCommand.Input, data });
  }
  resize(id: string, cols: number, rows: number): void {
    const size = terminalSize(cols, rows);
    const entry = this.#get(id);
    if (entry.state.phase !== "exited") entry.host.postMessage({ type: HostCommand.Resize, ...size });
  }
  acknowledge(id: string, count: number): void {
    const entry = this.#entries.get(id);
    if (entry?.state.phase !== "exited" && Number.isInteger(count) && count > 0 && count <= TERMINAL_LIMITS.chunk)
      entry?.host.postMessage({ type: HostCommand.Ack, count });
  }
  async stop(id: string): Promise<void> {
    const entry = this.#get(id);
    if (entry.state.phase === "exited") return;
    if (entry.state.phase !== "stopping") {
      entry.state.phase = "stopping";
      this.#state(entry);
      clearTimeout(entry.timer);
      entry.host.postMessage({ type: HostCommand.Stop });
      entry.timer = setTimeout(() => {
        entry.host.kill();
        this.#finish(entry, INTERRUPTED_EXIT_CODE);
      }, STOP_TIMEOUT_MS);
    }
    await entry.done;
  }
  remove(id: string): void {
    const entry = this.#get(id);
    if (entry.state.phase !== "exited") throw new Error(MESSAGE.stopFirst);
    entry.host.kill();
    this.#entries.delete(id);
    this.emit({ type: "removed", id });
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#disposing = (async () => {
      await Promise.all([...this.#entries.keys()].map((id) => this.stop(id)));
      for (const id of this.#entries.keys()) this.remove(id);
    })().finally(() => {
      this.#disposing = null;
    });
    return this.#disposing;
  }
}

/** What the host needs to start the shell: never the callbacks, which stay in main. */
function startCommand(launch: TerminalLaunch) {
  return {
    type: HostCommand.Start,
    file: launch.file,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    kind: launch.kind,
  };
}

/** Only an https address is a page to open. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
