/**
 * Where connectors live on disk, and where their secrets do not.
 *
 * `engine-homes/mcp/connectors.json` is written exactly like `external-cli.ts`'s
 * `setCodingCliOverride`: one serialized promise chain, a 0o700 directory, a 0o600 temp file and
 * a rename. `engine-homes` is already on the sandbox deny-read list and on both delegated
 * engines' `protectedPaths`, so a file placed there is unreadable by any agent for free.
 *
 * The file holds **names only**. Every value — an API token in an env var, a bearer header —
 * lives in a `SecretStore` under `engine-homes/mcp/secrets` keyed `mcp.<id>.env.<NAME>` or
 * `mcp.<id>.header.<NAME>`, and is materialized only into a child's environment, or a request
 * header, at connect time. In a profile where OS encryption is unavailable
 * (`STUDIO_DISABLE_OS_CREDENTIALS=1`, a headless test run, Linux without a keyring) the port is
 * `null`: connectors that need no secret still work, and the card says why values cannot be
 * stored rather than storing them in the clear.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWriteText } from "../fsx.ts";
import {
  MCP_ENV_NAME,
  MCP_HEADER_NAME,
  MCP_ID,
  isMcpScope,
  type McpConnector,
  type McpConnectorSource,
  type McpConnectorsFile,
  type McpToolPolicy,
  McpTransport,
} from "../../shared/mcp.ts";
import { SecretStorageUnavailableError, SecretStore } from "../secrets.ts";
import { SecretStorageIssue } from "../../shared/secret-storage.ts";
import { errorMessage } from "../../shared/errors.ts";

/** The half of `SecretStore` the connector code needs. A Map stands in for it in tests. */
export interface SecretPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export const MAX_ARGS = 64;
export const MAX_ARGS_BYTES = 4096;
const MAX_NAMES = 64;
/** The most tool names a connector's allow or deny list keeps. */
const MAX_POLICY_NAMES = 256;
const MAX_NAME_CHARS = 200;
const MAX_DATE_CHARS = 64;
const MAX_COMMAND_CHARS = 1024;
const MAX_PATH_CHARS = 4096;
const MAX_URL_CHARS = 2048;

/** What a person reads when a connector or the connectors file is refused. */
const MESSAGE = {
  NotANameList: (label: string) => `Connector ${label} must be a list of names`,
  TooManyNames: (label: string) => `Too many ${label} names`,
  InvalidName: (label: string, name: unknown) => `Invalid ${label} name: ${String(name)}`,
  InvalidToolPolicy: "Invalid connector tool policy",
  InvalidPolicyList: (label: string) => `Invalid connector ${label} list`,
  InvalidSource: "Invalid connector source",
  InvalidConnector: "Invalid connector",
  InvalidId: "A connector id is lowercase letters, digits and dashes, up to 32 characters",
  NeedsName: "A connector needs a name",
  InvalidTransport: "A connector is stdio, http or sse",
  InvalidScope: "Invalid connector scope",
  InvalidEnabled: "Invalid connector enabled flag",
  InvalidCreatedAt: "Invalid connector createdAt",
  OAuthRemoteOnly: "Browser OAuth is available for HTTP/SSE connectors only",
  OAuthOrHeader: "Choose browser OAuth or an Authorization header, not both",
  ArgsNotText: "Connector arguments must be text",
  TooManyArgs: `A connector takes at most ${MAX_ARGS} arguments`,
  ArgsTooLong: "Connector arguments are too long",
  NeedsCommand: "A stdio connector needs a command",
  StdioHasUrl: "A stdio connector has no url",
  RelativeCwd: "A connector working directory must be an absolute path",
  InsecureUrl: "A connector url must be https, or http on localhost",
  RemoteHasCommand: "An http or sse connector has no command",
  InvalidTrustDigest: "Invalid connector trust digest",
  InvalidShareProjectRoot: "Invalid project root sharing option",
  DuplicateId: "Duplicate connector id",
  PluginConnectorInFile: "A plugin connector is not stored in this file",
  FileUnreadable: "The connectors file could not be read.",
  FileShape: "The connectors file has an unexpected shape.",
  SecretsLocked: "Saved credentials are locked. Press Connect in Studio to unlock them.",
} as const;

export function secretKey(id: string, kind: "env" | "header", name: string): string {
  return `mcp.${id}.${kind}.${name}`;
}

/** `env.NAME` / `header.NAME` — how the IPC payload and the card address one secret. */
export function secretField(kind: "env" | "header", name: string): string {
  return `${kind}.${name}`;
}

/**
 * The digest the native trust dialog approves: a connectors.json edited by hand cannot start a
 * different program than the one the user was shown.
 */
export function launchDigest(connector: Pick<McpConnector, "command" | "args" | "cwd" | "env">): string {
  const value = JSON.stringify([
    connector.command ?? "",
    connector.args ?? [],
    connector.cwd ?? null,
    [...(connector.env ?? [])].sort(),
  ]);
  return createHash("sha256").update(value).digest("hex");
}

/** A stdio connector may only launch when its recorded digest still matches what it would run. */
export function launchTrusted(connector: McpConnector): boolean {
  if (connector.transport !== McpTransport.Stdio) return true;
  return !!connector.trustedLaunch && connector.trustedLaunch === launchDigest(connector);
}

const isText = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;

function names(value: unknown, shape: RegExp, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(MESSAGE.NotANameList(label));
  if (value.length > MAX_NAMES) throw new Error(MESSAGE.TooManyNames(label));
  const out: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !shape.test(name)) throw new Error(MESSAGE.InvalidName(label, name));
    if (!out.includes(name)) out.push(name);
  }
  return out.length ? out : undefined;
}

function policy(value: unknown): McpToolPolicy {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(MESSAGE.InvalidToolPolicy);
  const list = (v: unknown, label: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(MESSAGE.InvalidPolicyList(label));
    return (v as string[]).slice(0, MAX_POLICY_NAMES);
  };
  const allow = list((value as McpToolPolicy).allow, "allow");
  const deny = list((value as McpToolPolicy).deny, "deny");
  const autoApprove = list((value as McpToolPolicy).autoApprove, "autoApprove");
  const out: McpToolPolicy = {};
  if (allow) out.allow = allow;
  if (deny) out.deny = deny;
  if (autoApprove) out.autoApprove = autoApprove;
  return out;
}

function source(value: unknown): McpConnectorSource | undefined {
  if (value === undefined || value === null || value === "user") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const owner = value as { plugin?: unknown; server?: unknown };
    if (typeof owner.plugin === "string" && typeof owner.server === "string")
      return { plugin: owner.plugin, server: owner.server };
  }
  throw new Error(MESSAGE.InvalidSource);
}

/** Loopback http is allowed because a locally launched server has no certificate to offer. */
export function validUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
}

const TRANSPORTS = new Set<string>(Object.values(McpTransport));
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_SCOPE_PROJECTS = 256;

/** The fields every connector has: id, name, transport, scope, switch and creation time. */
function validateIdentity(c: McpConnector): McpTransport {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(MESSAGE.InvalidConnector);
  if (typeof c.id !== "string" || !MCP_ID.test(c.id)) throw new Error(MESSAGE.InvalidId);
  if (!isText(c.name, 1, MAX_NAME_CHARS)) throw new Error(MESSAGE.NeedsName);
  if (!TRANSPORTS.has(c.transport)) throw new Error(MESSAGE.InvalidTransport);
  if (!isMcpScope(c.scope)) throw new Error(MESSAGE.InvalidScope);
  if (typeof c.enabled !== "boolean") throw new Error(MESSAGE.InvalidEnabled);
  if (!isText(c.createdAt, 1, MAX_DATE_CHARS) || Number.isNaN(Date.parse(c.createdAt)))
    throw new Error(MESSAGE.InvalidCreatedAt);
  return c.transport;
}

/** Browser OAuth: remote connectors only, and never alongside an Authorization header. */
function applyAuthentication(c: McpConnector, transport: McpTransport, out: McpConnector): void {
  if (c.authentication === undefined) return;
  if (c.authentication !== "oauth" || transport === McpTransport.Stdio) throw new Error(MESSAGE.OAuthRemoteOnly);
  if (c.headers?.some((h) => h.toLowerCase() === "authorization")) throw new Error(MESSAGE.OAuthOrHeader);
  out.authentication = "oauth";
}

function validateArgs(value: unknown): string[] {
  const args = value ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error(MESSAGE.ArgsNotText);
  if (args.length > MAX_ARGS) throw new Error(MESSAGE.TooManyArgs);
  if (Buffer.byteLength(args.join("\u0000"), "utf8") > MAX_ARGS_BYTES) throw new Error(MESSAGE.ArgsTooLong);
  return args;
}

/** A stdio connector: a command, text arguments and an optional absolute working directory; no url. */
function applyStdioLaunch(c: McpConnector, out: McpConnector): void {
  if (!isText(c.command, 1, MAX_COMMAND_CHARS)) throw new Error(MESSAGE.NeedsCommand);
  if (c.url) throw new Error(MESSAGE.StdioHasUrl);
  const args = validateArgs(c.args);
  out.command = c.command;
  if (args.length) out.args = [...args];
  if (c.cwd === undefined || c.cwd === null || c.cwd === "") return;
  if (!isText(c.cwd, 1, MAX_PATH_CHARS) || !path.isAbsolute(c.cwd)) throw new Error(MESSAGE.RelativeCwd);
  out.cwd = c.cwd;
}

/** An http or sse connector: an https (or loopback http) url; no command. */
function applyRemoteUrl(c: McpConnector, out: McpConnector): void {
  if (!isText(c.url, 1, MAX_URL_CHARS) || !validUrl(c.url)) throw new Error(MESSAGE.InsecureUrl);
  if (c.command) throw new Error(MESSAGE.RemoteHasCommand);
  out.url = c.url;
}

/** The secret names, the approved launch digest and the owning plugin, when present. */
function applyNamesAndTrust(c: McpConnector, out: McpConnector): void {
  const env = names(c.env, MCP_ENV_NAME, "environment variable");
  if (env) out.env = env;
  const headers = names(c.headers, MCP_HEADER_NAME, "header");
  if (headers) out.headers = headers;
  if (c.trustedLaunch !== undefined && c.trustedLaunch !== null) {
    if (typeof c.trustedLaunch !== "string" || !SHA256_HEX.test(c.trustedLaunch))
      throw new Error(MESSAGE.InvalidTrustDigest);
    out.trustedLaunch = c.trustedLaunch;
  }
  const owner = source(c.source);
  if (owner) out.source = owner;
}

/**
 * Validate one connector and return it in a fixed shape. Throws with a message a person can
 * act on: this runs on the IPC save path and on every load of the file.
 */
export function validateConnector(value: unknown): McpConnector {
  const c = value as McpConnector;
  const transport = validateIdentity(c);
  const out: McpConnector = {
    id: c.id,
    name: c.name,
    transport,
    enabled: c.enabled,
    scope: c.scope === "global" ? "global" : { projects: [...new Set(c.scope.projects)].slice(0, MAX_SCOPE_PROJECTS) },
    toolPolicy: policy(c.toolPolicy),
    createdAt: c.createdAt,
  };
  if (c.shareProjectRoot !== undefined) {
    if (typeof c.shareProjectRoot !== "boolean") throw new Error(MESSAGE.InvalidShareProjectRoot);
    out.shareProjectRoot = c.shareProjectRoot;
  }
  applyAuthentication(c, transport, out);
  if (transport === McpTransport.Stdio) applyStdioLaunch(c, out);
  else applyRemoteUrl(c, out);
  applyNamesAndTrust(c, out);
  return out;
}

/** The connectors file's contents, or what is wrong with the file as a whole. */
function parseConnectorsFile(raw: string): McpConnectorsFile | string {
  let parsed: McpConnectorsFile;
  try {
    parsed = JSON.parse(raw) as McpConnectorsFile;
  } catch {
    return MESSAGE.FileUnreadable;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.connectors)) return MESSAGE.FileShape;
  return parsed;
}

/** One file entry, valid, not a duplicate, and the user's own. */
function fileConnector(entry: unknown, loaded: McpConnector[]): McpConnector {
  const connector = validateConnector(entry);
  if (loaded.some((c) => c.id === connector.id)) throw new Error(MESSAGE.DuplicateId);
  // A plugin's server is registered in memory by the plugin host; it is never a file entry.
  if (connector.source && connector.source !== "user") throw new Error(MESSAGE.PluginConnectorInFile);
  return connector;
}

export interface McpStoreLoad {
  connectors: McpConnector[];
  errors: Map<string, string>;
}

/** The connectors file. One writer, atomic replacement, names only. */
export class McpStore {
  readonly file: string;
  #write: Promise<unknown> = Promise.resolve();
  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<McpStoreLoad> {
    const errors = new Map<string, string>();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connectors: [], errors };
      throw error;
    }
    const parsed = parseConnectorsFile(raw);
    if (typeof parsed === "string") {
      errors.set("*", parsed);
      return { connectors: [], errors };
    }
    const connectors: McpConnector[] = [];
    for (const entry of parsed.connectors) {
      const id = (entry as McpConnector)?.id;
      try {
        connectors.push(fileConnector(entry, connectors));
      } catch (error) {
        errors.set(typeof id === "string" && id ? id : `entry-${connectors.length}`, errorMessage(error));
      }
    }
    return { connectors, errors };
  }

  async save(connectors: McpConnector[]): Promise<void> {
    const file = this.file;
    const value: McpConnectorsFile = { version: 1, connectors: connectors.map((c) => validateConnector(c)) };
    const operation = this.#write
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      });
    this.#write = operation;
    await operation;
  }
}

/**
 * Open the secret store connectors keep their values in; when this profile has no OS encryption
 * (or, on Linux, no keyring) the port is `null` and `locked` says why. Never falls back to
 * plaintext: a secret silently stored in the clear is worse than one that failed to store.
 */
export async function mcpSecretPort(
  dir: string,
): Promise<{ port: SecretPort | null; locked: SecretStorageIssue | null }> {
  try {
    const store = await SecretStore.open(dir);
    const port: SecretPort = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: (key) => store.delete(key),
      list: () => store.list(),
    };
    return { port, locked: null };
  } catch (error) {
    const locked =
      error instanceof SecretStorageUnavailableError ? error.issue : SecretStorageIssue.EncryptionUnavailable;
    return { port: null, locked };
  }
}

/** A Map-backed port for tests and for profiles that opt out of the OS keychain. */
export function memorySecretPort(values = new Map<string, string>()): SecretPort {
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async list() {
      return [...values.keys()].sort();
    },
  };
}

/**
 * A connector's saved values are still in the store: nothing has unlocked them this session. Not the
 * same as "no value" — a process started now would run without a secret the user did save.
 */
export class McpSecretsLocked extends Error {
  constructor() {
    super(MESSAGE.SecretsLocked);
    this.name = "McpSecretsLocked";
  }
}

/**
 * Read the values a connector's declared names point at. Missing values are simply absent; values
 * that are still locked are not, and fail the launch instead of starting it without them.
 */
export async function materializeSecrets(
  port: SecretPort | null,
  connector: McpConnector,
  kind: "env" | "header",
): Promise<Record<string, string>> {
  const declared = (kind === "env" ? connector.env : connector.headers) ?? [];
  if (!port || !declared.length) return {};
  const out: Record<string, string> = {};
  for (const name of declared) {
    const value = await port.get(secretKey(connector.id, kind, name)).catch((error) => {
      if (error instanceof McpSecretsLocked) throw error;
      return null;
    });
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out;
}

/** The `env.NAME` / `header.NAME` fields this connector has stored values for. */
export async function storedSecretFields(port: SecretPort | null, connector: McpConnector): Promise<string[]> {
  if (!port) return [];
  const fields: string[] = [];
  for (const kind of ["env", "header"] as const) {
    for (const name of (kind === "env" ? connector.env : connector.headers) ?? []) {
      const value = await port.get(secretKey(connector.id, kind, name)).catch(() => null);
      if (value) fields.push(secretField(kind, name));
    }
  }
  return fields;
}

/** The file beside connectors.json that keeps plugin connectors' "always allow" grants. */
export const GRANTS_FILE = "always-allowed.json";
/** A tool name a grant may hold; longer is not a tool any server exposes. */
const GRANT_NAME_MAX = 200;
/** Grants one connector may hold. */
const GRANTS_PER_CONNECTOR_MAX = 200;

/** Connector id → the exact raw tool names the person said always to allow, from the file's text. */
function parseGrants(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const grants = (parsed as { grants?: unknown } | null)?.grants;
  if (typeof grants !== "object" || grants === null || Array.isArray(grants)) return out;
  for (const [id, names] of Object.entries(grants)) {
    if (!MCP_ID.test(id) || !Array.isArray(names)) continue;
    const valid = names.filter(
      (name): name is string => typeof name === "string" && name.length > 0 && name.length <= GRANT_NAME_MAX,
    );
    if (valid.length) out.set(id, [...new Set(valid)].slice(0, GRANTS_PER_CONNECTOR_MAX));
  }
  return out;
}

/**
 * Plugin connectors live in memory, so the "always allow" a person gives one of them is kept
 * here instead of in connectors.json, and added to its policy each time the plugin registers it.
 */
export class McpGrantStore {
  readonly file: string;
  #write: Promise<unknown> = Promise.resolve();
  constructor(file: string) {
    this.file = file;
  }

  /** The saved grants; a missing or unreadable file is none. */
  async load(): Promise<Map<string, string[]>> {
    try {
      return parseGrants(await readFile(this.file, "utf8"));
    } catch {
      return new Map();
    }
  }

  async save(grants: ReadonlyMap<string, readonly string[]>): Promise<void> {
    const file = this.file;
    const value = { version: 1, grants: Object.fromEntries(grants) };
    const operation = this.#write
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      });
    this.#write = operation;
    await operation;
  }
}
