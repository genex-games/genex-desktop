/**
 * The environment a child process starts with (SEC-2).
 *
 * The studio's own environment can hold every credential a developer's shell exports: another
 * vendor's API key, a GitHub token, the Genex token. None of that is a child's business.
 *
 * - `sandbox`: the harness and every command it runs through `ProcessSandbox`. Agent-directed
 *   shells, so an allow-list: the basics a toolchain needs, and nothing else from the parent.
 * - `contractor`: a coding CLI (Claude Code, Codex). It needs the user's toolchain environment
 *   (proxies, certificates, version managers), so the parent's environment minus every
 *   credential and minus the other vendor's variables. Its own sign-in variable stays only when
 *   the caller names it in `keep`.
 *
 * Every child commits as the studio (R1): a contractor told to commit, or a repo whose own
 * instructions say "always commit", would otherwise sign its commits with the user's identity,
 * and the snapshot engine rightly refuses to reset past commits the user made.
 *
 * What the caller `set`s is the child's own and always arrives, unfiltered.
 */

import path from "node:path";
import { STUDIO_COMMITTER } from "./snapshots.ts";
import { envValue } from "./toolchain.ts";
import { StudioPlatform } from "../shared/boot.ts";

const STUDIO_IDENTITY = {
  GIT_AUTHOR_NAME: STUDIO_COMMITTER.name,
  GIT_AUTHOR_EMAIL: STUDIO_COMMITTER.email,
  GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
  GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
} as const;

export type ChildEnvRequest =
  | { base: "sandbox"; set?: Record<string, string | undefined> }
  | {
      base: "contractor";
      /**
       * The CLI's vendor: the other vendors' variables are dropped wholesale. `none` is a tool that
       * is no coding CLI (the Ollama server): every vendor's variables stay behind.
       */
      vendor: "claude" | "codex" | "opencode" | "none";
      /** Credential variables this child is meant to use — its own sign-in, never a metered key. */
      keep?: readonly string[];
      set?: Record<string, string | undefined>;
    };

/** What a sandboxed toolchain needs from the parent. Everything else stays behind. */
const SANDBOX_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "__CF_USER_TEXT_ENCODING",
  // A machine behind a TLS-inspecting proxy cannot install a package without these.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
const SANDBOX_ALLOW_PREFIX = /^LC_/;

/**
 * A variable whose name says it carries a secret, in any case. `_PWD` needs its underscore: `PWD`
 * and `OLDPWD` are the working directory. `SESSION` covers `BW_SESSION` and `OP_SESSION_<account>`;
 * a secret word inside a name counts too (`SECRET_KEY_BASE`, `PGPASSWORD`).
 */
const CREDENTIAL =
  /(?:^|_)(?:TOKENS?|SECRETS?|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|KEYS?|APIKEY|KEY_ID|PAT|JWT|DSN|SESSION|WEBHOOK_URL|ASKPASS)$|(?:^|_)(?:SECRETS?|CREDENTIALS?|PASSWORD|PASSWD)_|PASSWORD$|_PWD$|^OP_SESSION_|AUTHTOKEN/i;
/**
 * Git config handed over the environment (`http.extraheader=Authorization: …`, a credential
 * helper), which also runs whatever a config value names: the whole mechanism stays behind.
 */
const GIT_CONFIG = /^GIT_CONFIG_(?:KEY_\d+|VALUE_\d+|COUNT|PARAMETERS)$/i;
/** Credentials whose names do not say so. */
const CREDENTIAL_NAMES = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO"]);
/** A URL with a password in it (`postgres://app:hunter2@db`), whatever the variable is called. */
const PASSWORD_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;
const VENDOR = {
  claude: /^(?:ANTHROPIC|CLAUDE)_/i,
  codex: /^(?:OPENAI|CODEX)_/i,
  opencode: /^OPENCODE_/i,
} as const;

export function isCredentialVariable(name: string, value?: string): boolean {
  return (
    CREDENTIAL.test(name) ||
    GIT_CONFIG.test(name) ||
    CREDENTIAL_NAMES.has(name.toUpperCase()) ||
    (value !== undefined && PASSWORD_URL.test(value))
  );
}

/** The other vendor's variables a coding CLI's child never sees; a tool of neither vendor sees neither's. */
const FOREIGN_VENDORS: Record<ContractorRequest["vendor"], readonly RegExp[]> = {
  claude: [VENDOR.codex, VENDOR.opencode],
  codex: [VENDOR.claude, VENDOR.opencode],
  opencode: [VENDOR.claude, VENDOR.codex],
  none: [VENDOR.claude, VENDOR.codex, VENDOR.opencode],
};

type ContractorRequest = Extract<ChildEnvRequest, { base: "contractor" }>;

/** The sandbox's allow-list: only what a toolchain needs from the parent. */
function sandboxBase(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    const allowed = SANDBOX_ALLOW.has(key) || SANDBOX_ALLOW_PREFIX.test(key);
    if (value !== undefined && allowed) env[key] = value;
  }
  return env;
}

/** The parent minus every credential (bar the ones kept) and minus the other vendor's variables. */
function contractorBase(
  parent: Record<string, string | undefined>,
  request: ContractorRequest,
): Record<string, string> {
  const env: Record<string, string> = {};
  const foreign = FOREIGN_VENDORS[request.vendor];
  const keep = new Set(request.keep ?? []);
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || foreign.some((vendor) => vendor.test(key))) continue;
    if (isCredentialVariable(key, value) && !keep.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export function childEnv(parent: Record<string, string | undefined>, request: ChildEnvRequest): Record<string, string> {
  const env = request.base === "sandbox" ? sandboxBase(parent) : contractorBase(parent, request);
  Object.assign(env, STUDIO_IDENTITY);
  for (const [key, value] of Object.entries(request.set ?? {})) if (value !== undefined) env[key] = value;
  return env;
}

/**
 * What any Windows program needs from its parent to start and find its folders (Node itself reads
 * SystemRoot, USERPROFILE and TEMP); none of it is a credential. Only asked for on Windows.
 */
const WINDOWS_BASE = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

/**
 * The Windows basics a child built from scratch must still get (`WINDOWS_BASE`), read from
 * `parent` whatever their case. With `home`, the profile folders move inside it, so a contained
 * run's `~`, APPDATA and LOCALAPPDATA are its own. Empty on macOS and Linux.
 */
export function windowsBaseEnv(
  parent: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): Record<string, string> {
  if (platform !== StudioPlatform.Windows) return {};
  const env: Record<string, string> = {};
  for (const name of WINDOWS_BASE) {
    const value = envValue(parent, name);
    if (value !== undefined) env[name] = value;
  }
  if (home) {
    env.USERPROFILE = home;
    env.APPDATA = path.win32.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.win32.join(home, "AppData", "Local");
  }
  return env;
}
