import { fork, type ChildProcess } from "node:child_process";
import { outlivesHarness } from "../../shared/plugin-hooks.ts";
import { CallCutOff, type PluginBinding } from "../../shared/plugins.ts";
import { errorMessage } from "../../shared/errors.ts";
import { activeCatalog, currentLocale } from "../../shared/i18n.ts";
import type { Locale } from "../../shared/locale.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { windowsBaseEnv } from "../child-env.ts";
import { envPath, envValue, isWindows } from "../toolchain.ts";

/** What the backend bootstrap (`plugin-sdk/backend.mjs`) and the host say to each other. Wire values. */
const MessageKind = {
  Call: "call",
  Cancel: "cancel",
  Result: "result",
  Host: "host",
  HostResult: "host-result",
  /** The app's language and its words, before the first call and again after it changes (`plugin-sdk/backend.mjs`). */
  Language: "language",
} as const;
/** A message from the backend: a call's result, or a host-service request made during a call. */
interface BackendMessage {
  kind?: string;
  id: number;
  callId?: number;
  method?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}
const NO_INVOCATION = "No active authorized invocation";
const STOPPED_BEFORE = "Stopped before plugin invocation";
/** The longest stderr line forwarded to the debug sink. */
const STDERR_LINE_CHARS = 4000;
/** How long one plugin invocation may run unless its caller sets its own limit. */
const DEFAULT_CALL_TIMEOUT_MS = 190 * SECOND_MS;
/** A stopped backend gets this long after its stop (SIGTERM, or on Windows its channel closing) before it is ended. */
const KILL_GRACE_MS = 3 * SECOND_MS;

/** What a cut-off call answers, by why it was cut off; the backend's own end keeps its exit text. */
const CUT_OFF_MESSAGE: Record<CallCutOff, string> = {
  [CallCutOff.HarnessEnded]:
    "The studio's loop ended while this call ran, so whether it took effect is unknown; accepted remote jobs may still continue. Look before you repeat it.",
  [CallCutOff.PluginEnded]: "The plugin stopped while this call ran, so whether it took effect is unknown.",
  [CallCutOff.AppLost]: "The app this call drives went away while it ran, so whether it took effect is unknown.",
  [CallCutOff.TurnEnded]:
    "This call was made after the session's turn had ended, so no answer could reach it; the person declined nothing.",
};

/**
 * A call that had gone out to its plugin and was ended before it answered, so whether it took
 * effect is unknown (`reason` says why). Never replayed: the caller records it and looks first.
 * It keeps Error's own name: a call's record drops only a leading "Error:" from its text, and the
 * chat row shows the rest as it is.
 */
export class PluginCallCutOff extends Error {
  readonly reason: CallCutOff;
  constructor(reason: CallCutOff, message: string = CUT_OFF_MESSAGE[reason]) {
    super(message);
    this.reason = reason;
  }
}

/** A call stopped before it was sent to its plugin: it never ran. */
export class PluginCallNotSent extends Error {
  constructor() {
    super(STOPPED_BEFORE);
  }
}

/**
 * Names a bundled plugin's seed folder in the app's resources to its backend. A first launch copies
 * the seed without its `node_modules` (Windows 11 held each first write of the Genex seed's
 * thousands of dependency files for minutes), so the backend resolves its dependencies there.
 */
export const PLUGIN_SEED_ENV = "STUDIO_PLUGIN_SEED";

/**
 * A plugin backend's whole environment, built from scratch: PATH, HOME, TMPDIR, the credential
 * opt-out and, on Windows, what any program needs to start there plus ProgramData and Program
 * Files (x86), the made-up Mac a development test of an engine plugin names, and a bundled plugin's
 * seed folder (`seed`). Nothing else of Studio's.
 * `toolPath` is the user's login PATH when known: an app started from the Finder has a bare one,
 * on which a backend finds none of the user's tools (Genex's publish needs git-lfs from Homebrew).
 */
export function pluginBackendEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  toolPath?: string,
  seed?: string,
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...windowsBaseEnv(parent, platform),
    PATH: toolPath || envPath(parent),
    HOME: parent.HOME,
    TMPDIR: parent.TMPDIR,
    ELECTRON_RUN_AS_NODE: "1",
    STUDIO_DISABLE_OS_CREDENTIALS: parent.STUDIO_DISABLE_OS_CREDENTIALS,
    STUDIO_ENGINE_TEST_ROOT: parent.STUDIO_ENGINE_TEST_ROOT,
    // A bundled plugin's own seed, where its dependencies stay (never the parent's: only the host names it).
    [PLUGIN_SEED_ENV]: seed,
    // Where Windows keeps shared app data and 32-bit programs, which a plugin may need to find an
    // installed app (Epic's launcher keeps its list of engines there); neither is secret.
    ...(platform === "win32"
      ? { ProgramData: envValue(parent, "ProgramData"), "ProgramFiles(x86)": envValue(parent, "ProgramFiles(x86)") }
      : {}),
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Hand each complete stderr line to `onStderr`; a throwing sink never breaks the pipe. */
function forwardStderrLines(child: ChildProcess, onStderr: (line: string) => void) {
  const send = (line: string) => {
    try {
      onStderr(line.slice(0, STDERR_LINE_CHARS));
    } catch {}
  };
  let rest = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    rest += chunk;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) if (line) send(line);
  });
  child.stderr?.on("end", () => {
    if (rest) send(rest);
    rest = "";
  });
}

/**
 * The call a backend's host request is made on behalf of: its kind (`tool`, `action`, …), its name,
 * the signal that ends with it, and `confirmed` when the host showed that very call's card and the
 * person approved it (a tool that declares `confirmation`). Only the host sets it.
 */
export interface PluginInvocation {
  method: string;
  name: string;
  signal: AbortSignal;
  confirmed?: true;
}

/** How one call is made beyond its name and arguments. */
export interface PluginCallOptions {
  /** The person approved this call's own card: its host requests carry `confirmed`. */
  confirmed?: boolean;
}

/** Crash isolation only. Installed backends remain trusted native code. Never replay a call. */
export class PluginProcess {
  #child: ChildProcess | undefined;
  /** The language the running backend was last told, so a call after a change tells it again. */
  #told: Locale | undefined;
  #sequence = 0;
  #pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
      context: PluginBinding | undefined;
      method: string;
      name: string;
      controller: AbortController;
      confirmed: boolean;
    }
  >();
  readonly bootstrap: string;
  readonly entry: string;
  readonly service: (
    method: string,
    args: any,
    context: PluginBinding | undefined,
    invocation: PluginInvocation,
  ) => Promise<unknown>;
  readonly failed: (error: string) => void;
  /** Developer debug sink for backend stderr lines; default discards. Never a source of user-facing status. */
  readonly onStderr: ((line: string) => void) | undefined;
  /** The PATH the backend starts with; absent or failing, the app's own. */
  readonly toolPath: (() => Promise<string>) | undefined;
  /** A bundled plugin's seed folder, named to the backend (`PLUGIN_SEED_ENV`). */
  readonly seed: string | undefined;
  /** The computer the backend runs on, which decides how it is asked to stop. */
  readonly platform: NodeJS.Platform;
  constructor(
    bootstrap: string,
    entry: string,
    service: (
      method: string,
      args: any,
      context: PluginBinding | undefined,
      invocation: PluginInvocation,
    ) => Promise<unknown>,
    failed: (error: string) => void,
    options?: {
      onStderr?: (line: string) => void;
      toolPath?: () => Promise<string>;
      seed?: string;
      platform?: NodeJS.Platform;
    },
  ) {
    this.bootstrap = bootstrap;
    this.entry = entry;
    this.service = service;
    this.failed = failed;
    this.onStderr = options?.onStderr;
    this.toolPath = options?.toolPath;
    this.seed = options?.seed;
    this.platform = options?.platform ?? process.platform;
  }
  /** A backend's answer to one call: its result or its error. */
  #settle(m: BackendMessage) {
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    p.cleanup();
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }
  /** Answer a backend's host-service request, but only on behalf of a call still in flight. */
  async #answerHost(child: ChildProcess, m: BackendMessage) {
    const reply = (answer: { result?: unknown; error?: string }) => {
      if (child.connected) child.send({ kind: MessageKind.HostResult, id: m.id, ...answer });
    };
    const p = m.callId === undefined ? undefined : this.#pending.get(m.callId);
    if (!p) {
      reply({ error: NO_INVOCATION });
      return;
    }
    try {
      const result = await this.service(m.method ?? "", m.args, p.context, {
        method: p.method,
        name: p.name,
        signal: p.controller.signal,
        ...(p.confirmed ? { confirmed: true as const } : {}),
      });
      reply({ result });
    } catch (e) {
      reply({ error: errorMessage(e) });
    }
  }
  /** Tell the backend the app's language when it has not heard it: its words for the person follow it. */
  #tellLanguage(child: ChildProcess): void {
    const locale = currentLocale();
    if (this.#told === locale) return;
    child.send({ kind: MessageKind.Language, locale, catalog: activeCatalog() });
    this.#told = locale;
  }
  /** The running backend, started with the user's PATH when this is its first call. */
  async #started(): Promise<ChildProcess> {
    if (this.#child) return this.#child;
    const toolPath = await this.toolPath?.().catch(() => undefined);
    // Another call may have started it while the PATH was read.
    return this.#start(toolPath);
  }
  #start(toolPath?: string) {
    if (this.#child) return this.#child;
    const child = fork(this.bootstrap, [this.entry], {
      execPath: process.execPath,
      execArgv: [],
      serialization: "advanced",
      env: pluginBackendEnv(process.env, process.platform, toolPath, this.seed),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.#child = child;
    this.#told = undefined;
    // Backend stderr may contain provider output: never surface it as sanitized account status.
    const onStderr = this.onStderr;
    if (!onStderr) child.stderr?.resume();
    else forwardStderrLines(child, onStderr);
    child.on("message", async (raw) => {
      const m = raw as BackendMessage | undefined;
      if (m?.kind === MessageKind.Result) this.#settle(m);
      else if (m?.kind === MessageKind.Host) await this.#answerHost(child, m);
    });
    const fail = (error: string) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      for (const p of this.#pending.values()) {
        p.cleanup();
        p.reject(new PluginCallCutOff(CallCutOff.PluginEnded, error));
      }
      this.#pending.clear();
      this.failed(error);
    };
    child.on("error", (e) => fail(e.message));
    child.on("exit", (code) => fail(`Plugin process exited (${code}); accepted remote jobs may still continue. `));
    return child;
  }
  async call(
    method: "tool" | "action" | "review" | "ping",
    name: string,
    args: unknown,
    context?: PluginBinding,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    options: PluginCallOptions = {},
  ): Promise<any> {
    if (signal?.aborted) throw new PluginCallNotSent();
    const child = await this.#started();
    if (signal?.aborted) throw new PluginCallNotSent();
    const id = ++this.#sequence,
      controller = new AbortController();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (child.connected) child.send({ kind: MessageKind.Cancel, id });
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        p.cleanup();
        reject(
          new Error("Stopped local plugin wait; accepted remote jobs may continue. Do not repeat unresolved creation."),
        );
      };
      const timer = setTimeout(cancel, timeoutMs);
      this.#pending.set(id, {
        resolve,
        reject,
        context,
        method,
        name,
        controller,
        confirmed: options.confirmed === true,
        cleanup: () => {
          controller.abort();
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.#tellLanguage(child);
      child.send({ kind: MessageKind.Call, id, method, name, args, context }, (error) => {
        if (error) {
          const p = this.#pending.get(id);
          if (p) {
            this.#pending.delete(id);
            p.cleanup();
            reject(error);
          }
        }
      });
    });
  }
  cancel(binding: Partial<PluginBinding>) {
    for (const [id, p] of this.#pending) {
      if (binding.project && p.context?.project !== binding.project) continue;
      if (binding.threadId && p.context?.threadId !== binding.threadId) continue;
      // A restore's after steps outlive a Stop (they reopen what its before steps closed), and so
      // does the person's own Rewind: a harness shutting down sends a Stop for everything.
      if (outlivesHarness(p.context?.hook)) continue;
      this.#endPending(id, new Error("Stopped local plugin work; accepted remote jobs may continue."));
    }
  }
  /**
   * End every call in flight as cut off, for `reason` (the harness that made them ended): each is
   * told to stop, and its caller learns that whether it took effect is unknown. The host's own work
   * goes on (`outlivesHarness`: a restore's after steps, the person's Rewind). The backend keeps
   * running for the calls that follow.
   */
  cutOff(reason: CallCutOff) {
    for (const [id, p] of [...this.#pending]) {
      if (outlivesHarness(p.context?.hook)) continue;
      this.#endPending(id, new PluginCallCutOff(reason));
    }
  }
  /** Tell the backend to stop one call and answer its caller with `error`. */
  #endPending(id: number, error: Error) {
    const p = this.#pending.get(id);
    if (!p) return;
    if (this.#child?.connected) this.#child.send({ kind: MessageKind.Cancel, id });
    this.#pending.delete(id);
    p.cleanup();
    p.reject(error);
  }
  stop() {
    for (const p of this.#pending.values()) {
      p.cleanup();
      p.reject(new Error("Plugin stopped locally; accepted remote jobs may continue."));
    }
    this.#pending.clear();
    const c = this.#child;
    if (!c) return;
    this.#askToStop(c);
    const timer = setTimeout(() => c.kill("SIGKILL"), KILL_GRACE_MS);
    timer.unref();
    c.once("exit", () => clearTimeout(timer));
  }
  /**
   * Asks the backend to stop its work and exit: SIGTERM, or on Windows, where any signal ends a
   * process outright and leaves the programs its jobs started running, the closing of its channel,
   * which the backend hears the same way.
   */
  #askToStop(c: ChildProcess) {
    if (!isWindows(this.platform)) {
      c.kill("SIGTERM");
      return;
    }
    if (c.connected) c.disconnect();
    else c.kill();
  }
}
