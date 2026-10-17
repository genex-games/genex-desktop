import { codexControl } from "./codex-control.ts";
import { resolveCodingCli } from "./external-cli.ts";
/**
 * Talk to the *real* `codex` CLI — never to a token file. Sign-in is Codex's own ChatGPT OAuth;
 * the studio only launches that flow and asks the CLI whether a session is alive.
 *
 * The Claude half of this lives in `claude-cli.ts` and reads almost identically on purpose: two
 * subscriptions, one grammar, so the UI can speak about them in the same words.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./claude-cli.ts";
import { childEnv } from "../child-env.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";

/** How long `codex login status`, and the app server's plan-limits answer, may take. */
const LOGIN_STATUS_TIMEOUT_MS = 8 * SECOND_MS;
const RATE_LIMITS_TIMEOUT_MS = 10 * SECOND_MS;
/** The marker a studio-connected profile leaves in its home. */
const STUDIO_LOGIN_MARKER = "studio-login.json";

/** These overrides must also reach exec, which deliberately ignores user config. */
export const CODEX_STUDIO_AUTH_ARGS = [
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'cli_auth_credentials_store="auto"',
];

export interface CodexAuthStatus {
  /** `null` means we could not ask (no CLI, timeout) — not the same as signed out. */
  loggedIn: boolean | null;
  detail: string;
  /**
   * How the CLI says it is authenticated. "chatgpt" is the subscription the studio wants; an
   * "api_key" login is a metered bill nobody agreed to in this window (D8), so it is reported
   * separately rather than quietly accepted as ready.
   */
  method?: "chatgpt" | "api_key";
}

export async function findCodexBinary(): Promise<string | null> {
  const cli = await resolveCodingCli(EngineId.Codex);
  return cli.status.state === CodingCliState.Ready ? (cli.status.path ?? null) : null;
}

/**
 * The environment every Codex process starts with. D8: no metered key (`OPENAI_API_KEY`,
 * `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`). SEC-2: no other credential and no Anthropic/Claude
 * variable either — a Claude sign-in or a GitHub token is not this CLI's business.
 */
export function codexSubscriptionEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return childEnv({ ...process.env, ...extra }, { base: "contractor", vendor: "codex" });
}

/** Only app-selected profiles use our storage policy; legacy CLI profiles keep theirs. */
export async function codexProfileArgs(home: string | null | undefined): Promise<string[]> {
  if (!home) return [];
  try {
    await access(path.join(home, STUDIO_LOGIN_MARKER));
    return [...CODEX_STUDIO_AUTH_ARGS];
  } catch {
    return [];
  }
}

/**
 * `codex login status` prints one line: "Logged in using ChatGPT", "Logged in using an API key",
 * or "Not logged in". Parsed rather than pattern-guessed so the API-key case can be named.
 */
export function parseCodexAuthStatus(exitCode: number, stdout: string, stderr: string): CodexAuthStatus {
  const text = `${stdout}\n${stderr}`.trim();
  if (/not logged in|no credentials|run `?codex login/i.test(text)) {
    return { loggedIn: false, detail: text || "not signed in" };
  }
  if (exitCode === 0 && /logged in using (?:ChatGPT|an? API key)/i.test(text)) {
    const method = /api key/i.test(text) ? ("api_key" as const) : ("chatgpt" as const);
    return { loggedIn: true, detail: text, method };
  }
  if (/expired|refresh|reauthenticate/i.test(text)) {
    return { loggedIn: false, detail: text || "session expired" };
  }
  return { loggedIn: null, detail: "Could not verify the Codex sign-in. Please try again." };
}

export async function codexAuthStatus(
  codexHome?: string | null,
  deps: { findBinary?: typeof findCodexBinary; run?: typeof runCommand; env?: NodeJS.ProcessEnv } = {},
): Promise<CodexAuthStatus> {
  const binary = await (deps.findBinary ?? findCodexBinary)();
  if (!binary) return { loggedIn: null, detail: "codex CLI not found" };
  try {
    const env = codexSubscriptionEnv({
      ...(deps.env ?? (deps.findBinary ? process.env : (await resolveCodingCli(EngineId.Codex)).env)),
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    });
    const result = await (deps.run ?? runCommand)(binary, [...(await codexProfileArgs(codexHome)), "login", "status"], {
      env,
      timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
    });
    return parseCodexAuthStatus(result.code, result.stdout, result.stderr);
  } catch (err) {
    return { loggedIn: null, detail: errorMessage(err) };
  }
}

/**
 * The account's plan limits from `codex app-server`: initialize, one `account/rateLimits/read`,
 * then close. Nothing else is sent, so no thread starts and nothing is spent. Null when the
 * CLI cannot answer in time; the caller keeps whatever it read before.
 */
export async function readCodexRateLimits(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = RATE_LIMITS_TIMEOUT_MS,
): Promise<unknown> {
  const control = codexControl(binary, args, env, timeoutMs);
  try {
    await control.initialize();
    return await control.request("account/rateLimits/read", { excludeResetCreditDetails: true });
  } catch {
    return null;
  } finally {
    await control.close();
  }
}

/**
 * The signed-in account's email from `codex app-server` (`account/read`): initialize, one request,
 * close. Null when the CLI cannot answer in time or names no email.
 */
export async function readCodexAccountEmail(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = RATE_LIMITS_TIMEOUT_MS,
): Promise<string | null> {
  const control = codexControl(binary, args, env, timeoutMs);
  try {
    await control.initialize();
    return accountEmailOf(await control.request("account/read", { refreshToken: false }));
  } catch {
    return null;
  } finally {
    await control.close();
  }
}

/** The email in an `account/read` answer (`{ account: { email } }`), if it names one. */
export function accountEmailOf(answer: unknown): string | null {
  const account = (answer as { account?: { email?: unknown } } | null)?.account;
  const email = account?.email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

/** Ask the selected CLI/account to refresh its catalog without starting a model turn. */
export async function refreshCodexCatalogue(
  binary: string,
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = RATE_LIMITS_TIMEOUT_MS,
): Promise<void> {
  const result = await runCommand(binary, ["debug", "models", ...(await codexProfileArgs(home))], {
    env: codexSubscriptionEnv({ ...env, CODEX_HOME: home }),
    timeoutMs,
  });
  if (result.code !== 0) throw new Error("Codex could not refresh its model catalog");
}
