import { resolveCodingCli } from "./external-cli.ts";
/**
 * Talk to the *real* `claude` CLI — never to a token file. Sign-in is Claude Code's own OAuth;
 * the studio only launches that flow and asks the CLI whether a session is alive.
 */
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { childEnv } from "../child-env.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";

/** How long `claude auth status` may take to answer. */
const AUTH_STATUS_TIMEOUT_MS = 8 * SECOND_MS;

const MESSAGE = {
  AuthStatusTimedOut: "timed out asking Claude Code whether you are signed in",
} as const;

/**
 * What a Claude CLI question (auth status) starts with (M6): the contractor environment — no
 * metered key, no other credential, no Codex variable — plus the home it is asked about.
 */
export function claudeCliEnv(base: NodeJS.ProcessEnv, configDir?: string | null): NodeJS.ProcessEnv {
  return childEnv(
    { ...process.env, ...base },
    {
      base: "contractor",
      vendor: "claude",
      keep: ["CLAUDE_CODE_OAUTH_TOKEN"],
      set: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {},
    },
  );
}

export const CLAUDE_INSTALL_URL = "https://code.claude.com";

export interface ClaudeAuthStatus {
  /** `null` means we could not ask (no CLI, timeout) — not the same as signed out. */
  loggedIn: boolean | null;
  detail: string;
}

export interface ClaudeLoginStart {
  started: boolean;
  missingCli?: boolean;
  error?: string;
}

/** External installations only. */
export async function findClaudeBinary(): Promise<string | null> {
  const cli = await resolveCodingCli(EngineId.ClaudeCode);
  return cli.status.state === CodingCliState.Ready ? (cli.status.path ?? null) : null;
}

export function parseAuthStatus(exitCode: number, stdout: string, stderr: string): ClaudeAuthStatus {
  const text = `${stdout}\n${stderr}`.trim();
  const parsed = parseCliJsonObject(stdout) ?? parseCliJsonObject(stderr);
  const fromJson = parsed ? statusFromJson(parsed, text) : null;
  return fromJson ?? statusFromText(exitCode, text);
}

/** The sign-in state a JSON answer states, in any of the spellings CLI versions have used. */
function statusFromJson(parsed: Record<string, unknown>, text: string): ClaudeAuthStatus | null {
  if (typeof parsed.loggedIn === "boolean") {
    return {
      loggedIn: parsed.loggedIn,
      detail: String(parsed.email ?? parsed.message ?? (text || signedLabel(parsed.loggedIn))),
    };
  }
  if (typeof parsed.logged_in === "boolean") {
    return { loggedIn: parsed.logged_in, detail: text || signedLabel(parsed.logged_in) };
  }
  if (typeof parsed.authenticated === "boolean") {
    return { loggedIn: parsed.authenticated, detail: text || signedLabel(parsed.authenticated) };
  }
  return null;
}

/** The sign-in state read from what the CLI printed and how it exited. */
function statusFromText(exitCode: number, text: string): ClaudeAuthStatus {
  // A `claude` old enough to reject `--json` has said nothing about the account. That is "we
  // could not ask", never "signed out": a false negative here puts a sign-in card over a working
  // subscription and stops the run.
  if (exitCode !== 0 && /unknown option|unknown argument|unrecognized option/i.test(text)) {
    return { loggedIn: null, detail: text };
  }
  if (/not logged|logged out|unauthenticated|not signed in|needs.?login|no account/i.test(text)) {
    return { loggedIn: false, detail: text || "not signed in" };
  }
  if (/expired|could not be refreshed|session expired/i.test(text)) {
    return { loggedIn: false, detail: text || "session expired" };
  }
  if (exitCode === 0) {
    return { loggedIn: true, detail: text || "signed in" };
  }
  return { loggedIn: false, detail: text || "not signed in" };
}

export async function claudeAuthStatus(
  configDir?: string | null,
  deps: { findBinary?: typeof findClaudeBinary; run?: typeof runCommand; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeAuthStatus> {
  const binary = await (deps.findBinary ?? findClaudeBinary)();
  if (!binary) return { loggedIn: null, detail: "claude CLI not found" };
  try {
    const env = claudeCliEnv(
      deps.env ?? (deps.findBinary ? process.env : (await resolveCodingCli(EngineId.ClaudeCode)).env),
      configDir,
    );
    const result = await (deps.run ?? runCommand)(binary, ["auth", "status", "--json"], {
      env,
      timeoutMs: AUTH_STATUS_TIMEOUT_MS,
    });
    return parseAuthStatus(result.code, result.stdout, result.stderr);
  } catch (err) {
    return { loggedIn: null, detail: errorMessage(err) };
  }
}

export async function runCommand(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(file, args, { env: options.env ?? claudeCliEnv(process.env) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      void stopChild(child);
      reject(new Error(MESSAGE.AuthStatusTimedOut));
    }, options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseCliJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function signedLabel(loggedIn: boolean): string {
  return loggedIn ? "signed in" : "not signed in";
}
