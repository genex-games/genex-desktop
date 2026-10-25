/**
 * The Claude sign-in, inside the app instead of a Terminal window.
 *
 * `claude auth login` is written for a TTY, but over a pipe it degrades to the one flow a window
 * can actually drive: it prints an authorize URL, opens the browser itself, then waits on stdin
 * for the code the browser shows. So the studio spawns the selected external `claude`, keeps that URL
 * (never showing it — it carries the PKCE challenge and the session state), and gives the card a
 * box for the code. A CLI that prints neither a link nor a prompt within a few seconds is a
 * version that needs a PTY: the same binary then runs in Studio's embedded terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { commandLaunch } from "../substrate/command-launch.ts";
import { stopChild } from "../substrate/process-tree.ts";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import {
  claudeAuthStatus,
  claudeCliEnv,
  type ClaudeAuthStatus,
  type ClaudeLoginStart,
} from "../substrate/engines/claude-cli.ts";
import { isClaudeLoginActive, type ClaudeLoginState } from "../shared/claude-login.ts";
import { errorMessage } from "../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { t } from "../shared/i18n.ts";

/** How long the piped CLI has to print a link or a code prompt before the embedded terminal takes over. */
const DEFAULT_GRACE_MS = 5 * SECOND_MS;
/** A sign-in nobody finishes is cancelled after this. */
const DEFAULT_TIMEOUT_MS = 10 * MINUTE_MS;
/** How much of the CLI's recent output is kept to look for the link and the code prompt. */
const SEEN_TAIL_CHARS = 8192;
/** How long a CLI asked to stop has before it is killed. */
const KILL_GRACE_MS = 1500;
/** Anthropic's own sign-in hosts: the only ones a sign-in link may point at. */
const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com", "auth.anthropic.com"];

/** What the Claude sign-in sheet shows at each step and failure. */
const MESSAGE = {
  cancelled: () => t("Sign-in cancelled"),
  timedOut: () => t("Sign-in timed out. Try again."),
  couldNotStart: () => t("The studio couldn't start the sign-in. Try again."),
  noCodeWaiting: () => t("No sign-in is waiting for a code. Start sign-in again."),
  notACode: () => t("That doesn't look like the code from the sign-in page. Copy it again."),
  noLink: () => t("No active sign-in link. Start sign-in again."),
  noTerminal: () => t("The embedded terminal is unavailable."),
  terminalFailed: () => t("Could not open the sign-in terminal. Close an unused session and try again."),
  cliFailed: () => t("Claude Code could not start the sign-in."),
  notFinished: () => t("Claude Code could not finish signing in. Try again."),
  notConfirmed: () => t("Claude couldn't confirm the sign-in. Try again."),
} as const;

interface LoginAttempt {
  home: string | null;
  binary: string;
  env?: NodeJS.ProcessEnv;
  child?: ChildProcess;
  closed?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  /** A bounded tail of what the CLI has said since we last answered it. */
  seen: string;
  /** The CLI printed a link or asked for a code: this is a login we are driving. */
  driven: boolean;
  /** The embedded PTY took over: this child's exit says nothing about the sign-in. */
  handedOver: boolean;
  terminalCancel?: () => Promise<void>;
  settle?: (result: ClaudeLoginStart) => void;
}

export interface ClaudeTerminalOptions {
  configDir: string | null;
  env: NodeJS.ProcessEnv;
  findBinary: () => Promise<string | null>;
  onUrl: (url: string) => void;
  onExit: (code: number) => void;
}

export interface ClaudeLoginDependencies {
  resolveCli?: () => Promise<{ path: string; env: NodeJS.ProcessEnv }>;
  findBinary: () => Promise<string | null>;
  spawn?: typeof spawn;
  probe?: (home: string | null, binary: string) => Promise<ClaudeAuthStatus>;
  /** Host-owned embedded PTY. No external Terminal application or shell interpolation. */
  terminal?: (options: ClaudeTerminalOptions) => Promise<ClaudeLoginStart & { cancel?: () => Promise<void> }>;
  openExternal: (url: string) => Promise<unknown>;
  onState: (state: ClaudeLoginState) => void;
  /** The sign-in into `home` (null: the CLI's own) was confirmed, by the account `email` when the CLI named one. */
  onConnected: (home: string | null, email?: string) => Promise<unknown>;
  /** How long the piped CLI has to say something we understand before the embedded terminal takes over. */
  graceMs?: number;
  timeoutMs?: number;
  /** The operating system the CLI runs on; the host's by default. */
  platform?: NodeJS.Platform;
}

/** Said only when the binary is genuinely absent — never as a way of not knowing. */
export const MISSING_CLAUDE_CLI = "Claude Code isn't installed on this computer.";

const URL_IN_OUTPUT = /https:\/\/[^\s"'<>]+/g;
const CODE_PROMPT = /paste[^\n]{0,20}code/i;

export class ClaudeLoginController {
  #state: ClaudeLoginState = { revision: 0, phase: "idle", hasBrowserUrl: false };
  #attempt: LoginAttempt | null = null;
  #url: string | null = null;
  readonly #deps: ClaudeLoginDependencies;

  constructor(deps: ClaudeLoginDependencies) {
    this.#deps = deps;
  }

  snapshot(): ClaudeLoginState {
    return { ...this.#state };
  }

  #update(patch: Partial<ClaudeLoginState>): void {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 };
    this.#deps.onState(this.snapshot());
  }

  #fail(message: string): void {
    clearTimeout(this.#attempt?.timer);
    clearTimeout(this.#attempt?.grace);
    this.#url = null;
    this.#update({ phase: "failed", hasBrowserUrl: false, error: message });
  }

  /**
   * Starts the sign-in and resolves as soon as the answer is known: a link or a code prompt from
   * the piped CLI, or the embedded terminal that took over. The reply is the same shape the sign-in
   * IPC always returned, so the card keeps its one "started / missing / error" grammar.
   */
  async start(home: string | null): Promise<ClaudeLoginStart> {
    // The same sign-in again is a no-op; a different login home (another account) replaces it,
    // or "Use a different account" would silently finish the Terminal login it interrupted.
    if (isClaudeLoginActive(this.#state)) {
      if (this.#attempt?.home === home) return { started: true };
      await this.cancel();
    }
    const found = await this.#findCli();
    if ("started" in found) return found;
    const attempt: LoginAttempt = {
      home,
      binary: found.binary,
      env: found.env,
      cancelled: false,
      seen: "",
      driven: false,
      handedOver: false,
    };
    this.#attempt = attempt;
    this.#url = null;
    this.#update({ phase: "starting", hasBrowserUrl: false, error: undefined });
    let settle: (result: ClaudeLoginStart) => void = () => {};
    const settled = new Promise<ClaudeLoginStart>((resolve) => {
      settle = (result) => {
        resolve(result);
        settle = () => {};
      };
    });
    attempt.settle = settle;
    try {
      if (home) await mkdir(home, { recursive: true, mode: 0o700 });
      if (attempt.cancelled) return { started: false, error: MESSAGE.cancelled() };
      this.#drive(attempt, settle);
    } catch (error) {
      // The card shows a sentence, not the home directory a failed mkdir or spawn names.
      if (!attempt.cancelled && this.#attempt === attempt) this.#fail(MESSAGE.couldNotStart());
      settle({ started: false, error: errorMessage(error) });
    }
    return settled;
  }

  /** The CLI to run and its environment, or the answer to give when there is none. */
  async #findCli(): Promise<{ binary: string; env?: NodeJS.ProcessEnv } | ClaudeLoginStart> {
    let installation: { path: string; env: NodeJS.ProcessEnv } | undefined;
    try {
      installation = await this.#deps.resolveCli?.();
    } catch (error) {
      this.#fail(errorMessage(error));
      return { started: false, error: errorMessage(error) };
    }
    const binary = installation?.path ?? (await this.#deps.findBinary());
    if (!binary) {
      this.#fail(MISSING_CLAUDE_CLI);
      return { started: false, missingCli: true, error: MISSING_CLAUDE_CLI };
    }
    return { binary, env: installation?.env };
  }

  /** Is this still the sign-in in progress, read from its pipe? */
  #listening(attempt: LoginAttempt): boolean {
    return this.#attempt === attempt && !attempt.cancelled && !attempt.handedOver;
  }

  /** Spawn `claude auth login` on a pipe and listen: for a link, a code prompt, or its exit. */
  #drive(attempt: LoginAttempt, settle: (result: ClaudeLoginStart) => void): void {
    const { home } = attempt;
    // npm's `claude.cmd` on Windows starts through cmd.exe, its arguments escaped (command-launch.ts).
    const launch = commandLaunch(attempt.binary, ["auth", "login"], this.#deps.platform);
    const child = (this.#deps.spawn ?? spawn)(launch.file, launch.args, {
      cwd: home ?? os.tmpdir(),
      env: loginEnv(home, attempt.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    attempt.child = child;
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => this.#read(attempt, chunk, settle));
    }
    attempt.closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        resolve();
        if (!this.#listening(attempt)) return;
        void this.#handOver(attempt, settle, error.message);
      });
      child.once("close", (code) => {
        resolve();
        if (!this.#listening(attempt)) return;
        // Nothing we could drive was ever printed: this CLI wants a terminal, so give it one.
        if (attempt.driven) void this.#finish(attempt, code);
        else void this.#handOver(attempt, settle);
      });
    });
    attempt.grace = setTimeout(() => {
      if (this.#attempt === attempt && !attempt.cancelled && !attempt.driven) void this.#handOver(attempt, settle);
    }, this.#deps.graceMs ?? DEFAULT_GRACE_MS);
    attempt.timer = setTimeout(() => {
      void this.cancel().then(() => {
        if (this.#attempt === attempt) this.#fail(MESSAGE.timedOut());
      });
    }, this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    attempt.timer.unref?.();
  }

  #read(attempt: LoginAttempt, chunk: string, settle: (result: ClaudeLoginStart) => void): void {
    if (!this.#listening(attempt)) return;
    // A bounded tail of the visible text, not a line reader: the code prompt arrives with no
    // newline after it, so a line reader would never see the one thing the user must answer.
    // The link comes wrapped in a terminal hyperlink escape whose closing bell survives
    // `stripVTControlCharacters` and would otherwise be read as part of the address.
    attempt.seen = (attempt.seen + stripVTControlCharacters(chunk).replace(/\p{Cc}+/gu, "\n")).slice(-SEEN_TAIL_CHARS);
    this.#noteLinks(attempt);
    if (CODE_PROMPT.test(attempt.seen) && this.#state.phase !== "code") {
      attempt.driven = true;
      this.#update({ phase: "code" });
    }
    if (attempt.driven) settle({ started: true });
  }

  /** Every new sign-in link in what the CLI said: remember it, and move from starting to the browser. */
  #noteLinks(attempt: LoginAttempt): void {
    for (const match of attempt.seen.matchAll(URL_IN_OUTPUT)) {
      const url = allowedClaudeLoginUrl(match[0]);
      if (!url || url === this.#url) continue;
      this.#url = url;
      attempt.driven = true;
      this.#update({
        hasBrowserUrl: true,
        ...(this.#state.phase === "starting" ? { phase: "browser" as const } : {}),
      });
    }
  }

  /** The code the browser showed. It is typed by the user and goes nowhere but the CLI's stdin. */
  async submitCode(code: string): Promise<ClaudeLoginState> {
    const attempt = this.#attempt;
    if (!attempt || attempt.cancelled || this.#state.phase !== "code" || !attempt.child?.stdin) {
      throw new Error(MESSAGE.noCodeWaiting());
    }
    const trimmed = code.trim();
    // One line, no whitespace: what goes into the CLI's stdin is a code, never a second command.
    if (!/^[A-Za-z0-9._~#/+=-]{6,512}$/.test(trimmed)) {
      throw new Error(MESSAGE.notACode());
    }
    attempt.child.stdin.write(`${trimmed}\n`);
    // Forget what has been read: the prompt we just answered must not read as a second ask, and
    // a CLI that refuses this code and prompts again is then heard as exactly that.
    attempt.seen = "";
    this.#update({ phase: "verifying", hasBrowserUrl: false });
    this.#url = null;
    return this.snapshot();
  }

  async openBrowser(): Promise<void> {
    if (!this.#url || !isClaudeLoginActive(this.#state)) throw new Error(MESSAGE.noLink());
    await this.#deps.openExternal(this.#url);
  }

  async cancel(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || !isClaudeLoginActive(this.#state)) return;
    attempt.cancelled = true;
    attempt.settle?.({ started: false, error: MESSAGE.cancelled() });
    clearTimeout(attempt.timer);
    clearTimeout(attempt.grace);
    await this.#kill(attempt);
    await attempt.terminalCancel?.();
    this.#url = null;
    if (this.#attempt === attempt) this.#update({ phase: "cancelled", hasBrowserUrl: false });
  }

  async #kill(attempt: LoginAttempt): Promise<void> {
    const child = attempt.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const platform = this.#deps.platform;
    void stopChild(child, { signal: "SIGTERM", platform });
    const hard = setTimeout(() => void stopChild(child, { platform }), KILL_GRACE_MS);
    hard.unref?.();
    await attempt.closed;
    clearTimeout(hard);
  }

  /** This CLI cannot be driven from a pipe. Hand the sign-in to the embedded terminal, with the same binary. */
  async #handOver(attempt: LoginAttempt, settle: (result: ClaudeLoginStart) => void, why?: string): Promise<void> {
    if (attempt.handedOver) return;
    attempt.handedOver = true;
    clearTimeout(attempt.grace);
    await this.#kill(attempt);
    if (this.#attempt !== attempt || attempt.cancelled) return;
    const result: ClaudeLoginStart & { cancel?: () => Promise<void> } = await (
      this.#deps.terminal ?? (async () => ({ started: false, error: MESSAGE.noTerminal() }))
    )({
      configDir: attempt.home,
      env: loginEnv(attempt.home, attempt.env),
      findBinary: async () => attempt.binary,
      onUrl: (value) => {
        if (this.#attempt !== attempt || attempt.cancelled) return;
        const url = allowedClaudeLoginUrl(value);
        if (url) {
          this.#url = url;
          this.#update({ hasBrowserUrl: true });
        }
      },
      onExit: (code) => {
        if (this.#attempt === attempt && !attempt.cancelled) void this.#finish(attempt, code);
      },
    }).catch(() => ({
      started: false,
      error: MESSAGE.terminalFailed(),
    }));
    attempt.terminalCancel = "cancel" in result ? result.cancel : undefined;
    if (this.#attempt !== attempt || attempt.cancelled) {
      await attempt.terminalCancel?.();
      settle({ started: false, error: MESSAGE.cancelled() });
      return;
    }
    if (result.started) this.#update({ phase: "terminal", hasBrowserUrl: this.#url !== null });
    else this.#fail(result.error ?? why ?? MESSAGE.cliFailed());
    const publicResult: ClaudeLoginStart = { started: result.started };
    if (result.error) publicResult.error = result.error;
    if (result.missingCli) publicResult.missingCli = true;
    settle(publicResult);
  }

  /** The CLI exited on its own: ask it whether that actually signed anybody in. */
  async #finish(attempt: LoginAttempt, code: number | null): Promise<void> {
    clearTimeout(attempt.timer);
    clearTimeout(attempt.grace);
    this.#url = null;
    if (code !== 0) {
      this.#fail(MESSAGE.notFinished());
      return;
    }
    // The code path already said "verifying"; a second identical announcement is a second render.
    if (this.#state.phase !== "verifying") this.#update({ phase: "verifying", hasBrowserUrl: false });
    try {
      const probe =
        this.#deps.probe ??
        ((home, binary) => claudeAuthStatus(home, { findBinary: async () => binary, env: attempt.env }));
      const status = await probe(attempt.home, attempt.binary);
      if (this.#attempt !== attempt || attempt.cancelled) return;
      // `null` is "we could not ask", which is not a sign-in: the engine's own handshake decides.
      if (status.loggedIn !== true) throw new Error(MESSAGE.notConfirmed());
      await this.#deps.onConnected(attempt.home, status.email);
      if (this.#attempt !== attempt || attempt.cancelled) return;
      this.#update({ phase: "connected", hasBrowserUrl: false, error: undefined });
    } catch {
      // The one authored throw above says exactly this; a raw one from the probe must not reach the card.
      if (this.#attempt === attempt && !attempt.cancelled) this.#fail(MESSAGE.notConfirmed());
    }
  }
}

/** Only Anthropic's own sign-in hosts, and only a plain https link. */
export function allowedClaudeLoginUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain && SIGN_IN_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * D8 again: an ambient ANTHROPIC_API_KEY in the inherited environment would let the CLI call the
 * login a success against a metered key nobody agreed to. Colour is off so the output we read is
 * the output the CLI meant.
 */
function loginEnv(home: string | null, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // M6: every other credential stays behind too; the login home it signs into still arrives.
  return { ...claudeCliEnv(extra ?? {}, home), NO_COLOR: "1" };
}
