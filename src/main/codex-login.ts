import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { commandLaunch } from "../substrate/command-launch.ts";
import { stopChild } from "../substrate/process-tree.ts";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CODEX_STUDIO_AUTH_ARGS,
  codexAuthStatus,
  codexSubscriptionEnv,
  findCodexBinary,
  type CodexAuthStatus,
} from "../substrate/engines/codex-cli.ts";
import { isCodexLoginActive, type CodexLoginState } from "../shared/codex-login.ts";
import { errorMessage } from "../shared/errors.ts";
import { redactSecrets } from "../shared/redact.ts";
import { MINUTE_MS } from "../shared/duration.ts";

/** A sign-in nobody finishes is cancelled after this. */
const DEFAULT_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long a CLI asked to stop has before it is killed. */
const KILL_GRACE_MS = 1500;
/** Output lines the card keeps, the longest unfinished line held, and the longest line shown. */
const MAX_LINES = 50;
const MAX_PENDING_CHARS = 16384;
const MAX_LINE_CHARS = 2000;
/** OpenAI's own sign-in hosts: the only ones a sign-in link may point at. */
const SIGN_IN_HOSTS = ["auth.openai.com", "auth0.openai.com", "chatgpt.com"];
const URL_IN_OUTPUT = /https:\/\/[^\s<>"']+/g;
const DEVICE_CODE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;

/** What the Codex sign-in sheet shows at each step and failure. */
const MESSAGE = {
  starting: "Starting Codex sign-in…",
  notInstalled: "Install Codex, then check again.",
  timedOut: "Sign-in timed out. Try again or use a device code.",
  notFinished: "Codex could not finish signing in. Check the output and try again.",
  apiKeyLogin: "This login uses an API key. Connect your ChatGPT subscription instead.",
  notVerified: "Codex could not verify a ChatGPT login. Please try again.",
  connected: "ChatGPT connected. You can start building.",
  noLink: "No active sign-in link. Start sign-in again.",
  longOutput: "[Long login output omitted]",
} as const;

/** The two ways Codex signs in: a browser page, or a code typed on another device. */
type LoginMethod = "browser" | "device";
/** Unfinished output lines of one login child, per stream. */
type PendingOutput = { stdout: string; stderr: string };

interface LoginAttempt {
  home: string;
  env?: NodeJS.ProcessEnv;
  child?: ChildProcess;
  closed?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface CodexLoginDependencies {
  resolveCli?: () => Promise<{ path: string; env: NodeJS.ProcessEnv }>;
  findBinary?: () => Promise<string | null>;
  spawn?: typeof spawn;
  probe?: (home: string, binary: string) => Promise<CodexAuthStatus>;
  openExternal: (url: string) => Promise<unknown>;
  onState: (state: CodexLoginState) => void;
  /** The sign-in into `home` was confirmed. */
  onConnected: (home: string) => Promise<unknown>;
  timeoutMs?: number;
  /** The operating system the CLI runs on; the host's by default. */
  platform?: NodeJS.Platform;
}

/** Runs only Codex's fixed login command. This is not a shell or a token broker. */
export class CodexLoginController {
  #state: CodexLoginState = {
    revision: 0,
    visible: false,
    phase: "idle",
    method: "browser",
    lines: [],
    hasBrowserUrl: false,
  };
  #attempt: LoginAttempt | null = null;
  #url: string | null = null;
  readonly #deps: CodexLoginDependencies;

  constructor(deps: CodexLoginDependencies) {
    this.#deps = deps;
  }

  snapshot(): CodexLoginState {
    return { ...this.#state, lines: [...this.#state.lines] };
  }

  #update(patch: Partial<CodexLoginState>): void {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 };
    this.#deps.onState(this.snapshot());
  }

  #line(line: string): void {
    const safe = sanitizeLoginLine(line).trim();
    if (safe) this.#update({ lines: [...this.#state.lines, safe].slice(-MAX_LINES) });
  }

  async start(home: string, method: LoginMethod = "browser"): Promise<CodexLoginState> {
    if (isCodexLoginActive(this.#state)) {
      this.#update({ visible: true });
      return this.snapshot();
    }
    const attempt: LoginAttempt = { home, cancelled: false };
    this.#attempt = attempt;
    this.#url = null;
    // The browser sign-in needs no window over the app: the page opens on its own and the button
    // that started it waits. A device code has to be read somewhere, so that one shows the window.
    this.#update({
      visible: method === "device",
      phase: "starting",
      method,
      lines: [MESSAGE.starting],
      hasBrowserUrl: false,
      deviceCode: undefined,
      error: undefined,
    });
    try {
      const installation = await this.#deps.resolveCli?.();
      const binary = installation?.path ?? (await (this.#deps.findBinary ?? findCodexBinary)());
      attempt.env = installation?.env;
      if (attempt.cancelled) return this.snapshot();
      if (!binary) throw new Error(MESSAGE.notInstalled);
      await prepareLoginHome(home);
      if (attempt.cancelled) return this.snapshot();
      this.#drive(attempt, binary, method);
    } catch (error) {
      if (!attempt.cancelled && this.#attempt === attempt) this.#fail(errorMessage(error));
    }
    return this.snapshot();
  }

  /** Run `codex login` and read what it prints until it exits or the sign-in times out. */
  #drive(attempt: LoginAttempt, binary: string, method: LoginMethod): void {
    const { home } = attempt;
    // npm's `codex.cmd` on Windows starts through cmd.exe, its arguments escaped (command-launch.ts).
    const launch = commandLaunch(
      binary,
      [...CODEX_STUDIO_AUTH_ARGS, "login", ...(method === "device" ? ["--device-auth"] : [])],
      this.#deps.platform,
    );
    const child = (this.#deps.spawn ?? spawn)(launch.file, launch.args, {
      cwd: home,
      env: codexSubscriptionEnv({ ...attempt.env, CODEX_HOME: home }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    attempt.child = child;
    this.#update({ phase: "waiting" });
    const pending: PendingOutput = { stdout: "", stderr: "" };
    const consume = (stream: keyof PendingOutput, chunk: string, flush = false): void => {
      for (const line of takeLines(pending, stream, chunk, flush)) {
        if (this.#attempt !== attempt || attempt.cancelled) return;
        this.#readLine(stripVTControlCharacters(line), method);
      }
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => consume(stream, chunk));
    }
    attempt.closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        clearTimeout(attempt.timer);
        if (!attempt.cancelled && this.#attempt === attempt) this.#fail(error.message);
        resolve();
      });
      child.once("close", (code) => {
        clearTimeout(attempt.timer);
        consume("stdout", "", true);
        consume("stderr", "", true);
        resolve();
        if (!attempt.cancelled && this.#attempt === attempt) void this.#finish(attempt, binary, code);
      });
    });
    attempt.timer = setTimeout(() => {
      void this.cancel().then(() => {
        if (this.#attempt === attempt) this.#fail(MESSAGE.timedOut);
      });
    }, this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    attempt.timer.unref();
  }

  /** One line of login output: a sign-in link, a device code, and the line itself for the card. */
  #readLine(plain: string, method: LoginMethod): void {
    for (const match of plain.matchAll(URL_IN_OUTPUT)) {
      const url = allowedLoginUrl(match[0]);
      if (url) {
        this.#url = url;
        this.#update({ hasBrowserUrl: true });
      }
    }
    if (method === "device") {
      const code = plain.match(DEVICE_CODE);
      if (code) this.#update({ deviceCode: code[0] });
    }
    this.#line(plain);
  }

  async #finish(attempt: LoginAttempt, binary: string, code: number | null): Promise<void> {
    if (code !== 0) {
      this.#fail(MESSAGE.notFinished);
      return;
    }
    this.#update({ phase: "verifying", hasBrowserUrl: false });
    this.#url = null;
    try {
      const status = await (
        this.#deps.probe ?? ((home, exe) => codexAuthStatus(home, { findBinary: async () => exe, env: attempt.env }))
      )(attempt.home, binary);
      if (this.#attempt !== attempt || attempt.cancelled) return;
      if (status.loggedIn !== true || status.method !== "chatgpt") {
        throw new Error(status.method === "api_key" ? MESSAGE.apiKeyLogin : MESSAGE.notVerified);
      }
      await this.#deps.onConnected(attempt.home);
      if (this.#attempt !== attempt || attempt.cancelled) return;
      this.#line(MESSAGE.connected);
      this.#update({ phase: "connected", deviceCode: undefined });
    } catch (error) {
      if (this.#attempt === attempt && !attempt.cancelled) this.#fail(errorMessage(error));
    }
  }

  #fail(message: string): void {
    this.#url = null;
    // A failure opens the window: its output, Try again and a device code are the way back.
    this.#update({
      visible: true,
      phase: "failed",
      hasBrowserUrl: false,
      deviceCode: undefined,
      error: sanitizeLoginLine(message),
    });
  }

  async openBrowser(): Promise<void> {
    if (!this.#url || !isCodexLoginActive(this.#state)) throw new Error(MESSAGE.noLink);
    await this.#deps.openExternal(this.#url);
  }

  async cancel(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || !isCodexLoginActive(this.#state)) return;
    attempt.cancelled = true;
    clearTimeout(attempt.timer);
    const child = attempt.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const platform = this.#deps.platform;
      void stopChild(child, { signal: "SIGTERM", platform });
      const kill = setTimeout(() => void stopChild(child, { platform }), KILL_GRACE_MS);
      kill.unref();
      await attempt.closed;
      clearTimeout(kill);
    }
    this.#url = null;
    if (this.#attempt === attempt) this.#update({ phase: "cancelled", hasBrowserUrl: false, deviceCode: undefined });
  }

  async dismiss(): Promise<void> {
    await this.cancel();
    this.#update({ visible: false, lines: [], deviceCode: undefined });
  }
}

export function allowedLoginUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain && SIGN_IN_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeLoginLine(value: string): string {
  return redactSecrets(stripVTControlCharacters(value).replace(/https?:\/\/[^\s<>"']+/g, "[sign-in link]")).slice(
    0,
    MAX_LINE_CHARS,
  );
}

/**
 * The studio's Codex home, ready for a login. A non-secret selection marker also supports
 * keychain-only credentials. It prevents a cancelled/expired studio login from silently falling
 * back to another account.
 */
async function prepareLoginHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, "studio-login.json"), "{}\n", { mode: 0o600 });
  await writeFile(
    path.join(home, "config.toml"),
    'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "auto"\n',
    {
      flag: "wx",
      mode: 0o600,
    },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/** Add `chunk` to a stream's unfinished line; the lines it completed (all of them when flushing). */
function takeLines(pending: PendingOutput, stream: keyof PendingOutput, chunk: string, flush: boolean): string[] {
  pending[stream] += chunk;
  const lines = pending[stream].split(/[\r\n]/);
  pending[stream] = flush ? "" : (lines.pop() ?? "");
  // Bound unfinished lines as well as displayed history.
  if (pending[stream].length > MAX_PENDING_CHARS) pending[stream] = MESSAGE.longOutput;
  return lines;
}
