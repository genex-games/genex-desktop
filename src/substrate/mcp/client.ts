/**
 * One connection to one MCP server.
 *
 * Studio main is the only MCP client in the system: the delegated CLIs never talk MCP on their
 * own account, and the local harness has no child processes at all. Everything a connector
 * offers arrives here, is turned into the studio's own `LiveToolResult`, and travels the same
 * `liveTools`/`onLiveTool` channel plugin tools already ride.
 *
 * Four things this file is careful about:
 *  - **The environment.** A stdio server gets `PATH`, `HOME`, `TMPDIR`, `LANG` and the values of
 *    the env names its connector declares. Studio's own environment (and any API key in it) is not
 *    inherited, and this env never reaches a delegated coding CLI. The SDK's own transport adds its
 *    small default-inheritance set (`LOGNAME`, `SHELL`, `TERM`, `USER`) on top; the piped transport
 *    below, which plugin-declared servers with a credential use, adds nothing at all.
 *  - **Nothing a server says repeats a secret.** Its stderr, its errors and its tool results reach
 *    the card, the `mcp.changed` event, the thread log and the model: every credential-named value
 *    this connection materialized or was handed by its launch, and anything token-shaped, is taken
 *    out first. A config value (`BASE_URL`) is not a secret and stays.
 *  - **stderr is not status.** A server that prints warnings is not a broken server. The tail is
 *    kept only to put a real message on a connection that actually failed.
 *  - **Timeouts are layered.** 10 s to connect, 10 s for the whole of `tools/list` however many
 *    pages it takes, 120 s for a call, 600 s total even when the server keeps reporting progress,
 *    and every one of them is cancellable by the delegation's abort signal, so stopping a build
 *    really does stop the tool.
 */
import { MCP_ASSET_META, type PluginToolAsset, readToolAsset } from "../../shared/asset-making.ts";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { commandNames, isWindows, isWindowsRunnable, pathDelimiter, toolchain } from "../toolchain.ts";
import { windowsBaseEnv } from "../child-env.ts";
import type { JsonSchemaValidator, JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CONNECTOR_OUTCOME_META, McpHealth, McpTransport, type McpConnector } from "../../shared/mcp.ts";
import type { LiveToolResult } from "../engines/types.ts";
import { materializeSecrets, type SecretPort } from "./store.ts";
import { errorMessage } from "../../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  credentialEnvValues,
  isCredentialName,
  redactSecrets,
  redactTokens,
  redactValues,
} from "../../shared/redact.ts";

export const CONNECT_TIMEOUT_MS = 10 * SECOND_MS;
export const CALL_TIMEOUT_MS = 2 * MINUTE_MS;
export const CALL_TOTAL_TIMEOUT_MS = 10 * MINUTE_MS;
/** A tool result is prompt text on the next turn; past this it is noise with a cost. */
export const MAX_RESULT_CHARS = 200_000;
const MAX_STDERR_CHARS = 4_000;
/** A closing stdio child gets this long after SIGTERM before close stops waiting for it. */
const CHILD_CLOSE_GRACE_MS = 2 * SECOND_MS;
/** `tools/list` pages read before the list is taken as complete. */
const MAX_TOOL_PAGES = 20;
/**
 * What a server that only speaks the older SSE transport answers the Streamable HTTP POST with:
 * no such route, method not allowed, or a request it cannot read. A URL saved as HTTP then tries SSE.
 */
const SSE_ONLY_STATUSES: ReadonlySet<number> = new Set([400, 404, 405]);

/** What a connector's failures say. */
const MESSAGE = {
  MissingExecutable: (command: string) =>
    `Cannot find executable "${command}" in your login PATH. Install its runtime or choose an absolute executable path, then Connect again.`,
  TransportStarted: "Transport already started",
  NotConnected: "Not connected",
  ConnectionCancelled: "Connector connection cancelled",
  SwitchedOff: (name: string) => `${name} is switched off`,
  ToolListTimedOut: (name: string) => `${name} did not finish listing its tools in time.`,
  ConnectorNotConnected: (name: string) => `${name} is not connected`,
  ToolWithdrawn: "This tool is no longer offered by the connector",
  InvalidArguments: (name: string, problem: string | undefined) => `Invalid arguments for ${name}: ${problem}`,
} as const;

export interface McpRawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What a call of it makes, when its listing's `_meta` says ({@link MCP_ASSET_META}); a display hint, never authority. */
  asset?: PluginToolAsset;
}

/**
 * How a connector's process is actually started, when the connector alone does not say.
 * A plugin-declared server runs as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (a packaged
 * app has no `node` on its PATH), and `stdioExtra` hands the spawned child to the host so a
 * credential can go down an anonymous pipe on fd 3 instead of through the environment.
 */
export interface McpLaunch {
  /** Replaces `connector.command`. */
  execPath?: string;
  /** Prepended to `connector.args`. */
  extraArgs?: string[];
  /** Merged over the materialized env. */
  extraEnv?: Record<string, string>;
  /** Extra stdio slots to open beyond stdin/stdout/stderr, e.g. `['pipe']` for fd 3. */
  extraStdio?: Array<"pipe" | "ignore">;
  /** Called once, with the live child, as soon as it is spawned. */
  stdioExtra?: (child: ChildProcess) => void;
  /**
   * Worked out afresh every time the child is started, because some of it cannot be known when
   * the connector is recorded: a per-project working directory, and the `HOME` inside it that
   * keeps a CLI's startup away from the user's own dotfiles. The registry calls it with the
   * project the connection is being opened for.
   */
  resolve?: (project: string | null) => Promise<McpLaunchContext>;
  /** `resolve` answers differently per project, so a connection opened for one is not reused for another. */
  perProject?: boolean;
}

/**
 * The program a stdio connector runs: an absolute command as it is, a bare name as the first
 * executable match on `PATH`'s absolute entries. Connect uses it, and so does the trust dialog, so
 * the person is shown the file that will actually run (GPX-7).
 */
export async function resolveExecutable(
  command: string,
  PATH: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!command) return undefined;
  // On Windows `npx` is `npx.cmd`: each PATHEXT name, and only a file Windows can start.
  const names = commandNames(command, platform, process.env);
  const dirs = path.isAbsolute(command) ? [""] : PATH.split(pathDelimiter(platform)).filter((p) => path.isAbsolute(p));
  const candidates = dirs.flatMap((dir) => names.map((name) => (dir ? path.join(dir, name) : name)));
  for (const candidate of candidates) {
    if (await runnable(candidate, platform)) return candidate;
  }
  return undefined;
}

/** Whether `file` can be started: executable on macOS and Linux, a runnable file on Windows. */
async function runnable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  if (isWindows(platform)) return isWindowsRunnable(file) && (await stat(file).catch(() => null))?.isFile() === true;
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * What `McpLaunch.resolve` works out for one start. `secrets` are the credential values this
 * start hands the child by any route (an env value, the fd 3 pipe), so the connection can take
 * them back out of anything the server says; credential-named `extraEnv` values are added anyway.
 */
export interface McpLaunchContext {
  cwd?: string;
  extraEnv?: Record<string, string>;
  secrets?: string[];
}

export interface McpConnectionOptions {
  connector: McpConnector;
  secrets?: SecretPort | null;
  launch?: McpLaunch;
  onHealth?: (health: McpHealth, error?: string) => void;
  onToolsChanged?: () => void;
  /** Supplied by Studio, never by a model or the remote server. */
  project?: string | null;
  authProvider?: OAuthClientProvider;
  redact?: (text: string) => string;
  /** Credential values the launch hands the child outside the declared env (see `McpLaunchContext`). */
  secretValues?: string[];
  /** Injectable for tests; the http and sse transports use it instead of global fetch. */
  fetchImpl?: typeof fetch;
}

interface SdkClient {
  connect(transport: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown; _meta?: unknown }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<unknown>;
  /** What the server said about itself when it connected: its name, title and icons. */
  getServerVersion?(): { name?: unknown; title?: unknown; icons?: unknown } | undefined;
  setNotificationHandler(schema: unknown, handler: () => void): void;
  setRequestHandler(schema: unknown, handler: () => unknown): void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

interface SdkTransport {
  close(): Promise<void>;
  pid?: number | null;
  stderr?: NodeJS.ReadableStream | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One listed tool with a name, its schema defaulting to an empty object schema; undefined otherwise. */
function rawTool(
  tool: { name?: unknown; description?: unknown; inputSchema?: unknown; _meta?: unknown } | null,
): McpRawTool | undefined {
  if (!tool || typeof tool.name !== "string" || !tool.name) return undefined;
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  const asset = listedAsset(tool._meta);
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: schema,
    ...(asset ? { asset } : {}),
  };
}

/** What a listed tool says it makes, read off its own `_meta` only; anything malformed says nothing. */
function listedAsset(meta: unknown): PluginToolAsset | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Object.hasOwn(meta, MCP_ASSET_META)) return null;
  return readToolAsset((meta as Record<string, unknown>)[MCP_ASSET_META]);
}

/** One content part of an MCP tool result, as the wire may carry it. */
interface ContentPart {
  type?: string;
  text?: unknown;
  uri?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: { text?: unknown; uri?: unknown };
}
type ResultImage = { mimeType: string; data: string };

/** What one part adds to a result: text, an image, or nothing Studio can use. */
function readPart(part: ContentPart): { text?: string; image?: ResultImage } {
  if (part.type === "text") return { text: text(part.text) };
  if (part.type === "image" && typeof part.data === "string")
    return { image: { mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png", data: part.data } };
  if (part.type === "resource" && typeof part.resource?.text === "string") return { text: part.resource.text };
  if (part.type === "resource_link" && typeof part.uri === "string") return { text: String(part.uri) };
  return {};
}

/** Structured content as text, for a result that carried no text of its own. */
function structuredText(structured: unknown): string | undefined {
  if (structured === undefined) return undefined;
  try {
    return JSON.stringify(structured);
  } catch {
    return undefined; // unserializable: leave it out
  }
}

/**
 * A connector's error answer. `outcomeUnknown` is set when the answer says the call may have taken
 * effect before it failed ({@link CONNECTOR_OUTCOME_META}): the host records it so, and never
 * repeats it on its own.
 * It keeps Error's own name, so a record of it reads as the connector's words.
 */
export class ConnectorCallError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown: boolean) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Whether an answer's `_meta` says the call's outcome is unknown: exactly the marker, nothing like it. */
function saysOutcomeUnknown(meta: unknown): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>)[CONNECTOR_OUTCOME_META.Key] === CONNECTOR_OUTCOME_META.Unknown;
}

/**
 * An MCP result becomes the studio's own: text parts joined, images carried as images (a path is
 * not a picture), and `isError` raised so every engine reports it as a failed tool call; an error
 * that says its outcome is unknown is a {@link ConnectorCallError} saying so.
 */
export function toLiveToolResult(result: unknown): LiveToolResult {
  const value = (result ?? {}) as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
    _meta?: unknown;
  };
  const parts: string[] = [];
  const images: ResultImage[] = [];
  for (const entry of Array.isArray(value.content) ? value.content : []) {
    const read = readPart((entry ?? {}) as ContentPart);
    if (read.text !== undefined) parts.push(read.text);
    if (read.image) images.push(read.image);
  }
  const structured = parts.length ? undefined : structuredText(value.structuredContent);
  if (structured !== undefined) parts.push(structured);
  const joined = parts.join("\n");
  const capped =
    joined.length > MAX_RESULT_CHARS ? `${joined.slice(0, MAX_RESULT_CHARS)}\n… (result truncated)` : joined;
  if (value.isError)
    throw new ConnectorCallError(
      capped || "The connector reported an error with no message.",
      saysOutcomeUnknown(value._meta),
    );
  return images.length ? { text: capped, images } : capped;
}

/**
 * A stdio transport Studio spawns itself.
 *
 * The SDK's own `StdioClientTransport` fixes the child's stdio at three slots, which is right for
 * a connector the user typed in. A plugin-declared server needs a fourth: the credential pipe on
 * fd 3 that `src/genex-host/preload.mjs` already reads, so a token never appears in argv, in the
 * environment or in a file. This class exists for that case only and shares the SDK's framing.
 */
class PipedStdioTransport implements SdkTransport {
  onmessage?: (message: unknown) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  #command: string;
  #args: string[];
  #cwd?: string;
  #env: Record<string, string>;
  #extra: Array<"pipe" | "ignore">;
  #ready: (child: ChildProcess) => void;
  #child: ChildProcess | undefined;
  #buffer: { append(chunk: Buffer): void; readMessage(): unknown; clear(): void } | undefined;
  #serialize: ((message: unknown) => string) | undefined;
  #stderr: PassThrough;

  constructor(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    extraStdio: Array<"pipe" | "ignore">;
    onSpawn: (child: ChildProcess) => void;
  }) {
    this.#command = options.command;
    this.#args = options.args;
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#extra = options.extraStdio;
    this.#ready = options.onSpawn;
    this.#stderr = new PassThrough();
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }
  /** Available before `start()`, so no early error output is lost. */
  get stderr(): NodeJS.ReadableStream {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error(MESSAGE.TransportStarted);
    const [{ spawn }, framing] = await Promise.all([
      import("node:child_process"),
      import("@modelcontextprotocol/sdk/shared/stdio.js") as Promise<{
        ReadBuffer: new () => { append(chunk: Buffer): void; readMessage(): unknown; clear(): void };
        serializeMessage(message: unknown): string;
      }>,
    ]);
    const buffer = new framing.ReadBuffer();
    this.#buffer = buffer;
    this.#serialize = framing.serializeMessage;
    const child = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe", ...this.#extra],
      shell: false,
    });
    this.#child = child;
    child.stderr?.pipe(this.#stderr);
    child.on("error", (error) => this.onerror?.(error as Error));
    child.on("close", () => {
      this.#child = undefined;
      this.onclose?.();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        buffer.append(chunk);
        for (;;) {
          const message = buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error as Error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
    this.#ready(child);
  }

  async send(message: unknown): Promise<void> {
    const stdin = this.#child?.stdin;
    const serialize = this.#serialize;
    if (!stdin || !serialize) throw new Error(MESSAGE.NotConnected);
    await new Promise<void>((resolve) => {
      if (stdin.write(serialize(message))) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#buffer?.clear();
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), CHILD_CLOSE_GRACE_MS);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/** The longest server title Studio shows. */
const SERVER_TITLE_MAX_CHARS = 80;

/** How a server introduced itself: the title to show for it and the icons it offers. */
export interface McpServerIdentity {
  title?: string;
  icons: unknown;
}

/** A server's `initialize` answer, reduced to what the page may show: a plain, short title and the icons as given. */
function serverIdentity(info: ReturnType<NonNullable<SdkClient["getServerVersion"]>>): McpServerIdentity {
  const raw = typeof info?.title === "string" ? info.title.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  const title = raw.slice(0, SERVER_TITLE_MAX_CHARS);
  return { ...(title ? { title } : {}), icons: info?.icons };
}

/** The HTTP status an SDK transport error carries (`StreamableHTTPError`, `SseError`), if any. */
function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** A connection that failed, with the HTTP status a URL server answered when it gave one. */
export class McpConnectFailed extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

export class McpConnection {
  readonly connector: McpConnector;
  health: McpHealth;
  error: string | undefined;
  lastConnectedAt: string | undefined;
  /** How the server introduced itself on its last connect. */
  identity: McpServerIdentity | undefined;
  #secrets: SecretPort | null;
  #launch: McpLaunch | undefined;
  #onHealth: ((health: McpHealth, error?: string) => void) | undefined;
  #onToolsChanged: (() => void) | undefined;
  #project: string | null;
  #authProvider: OAuthClientProvider | undefined;
  #redact: ((text: string) => string) | undefined;
  #epoch = 0;
  #fetch: typeof fetch | undefined;
  #client: SdkClient | undefined;
  #transport: SdkTransport | undefined;
  #connecting: Promise<void> | undefined;
  #tools: McpRawTool[] | undefined;
  #validators = new Map<string, JsonSchemaValidator<unknown>>();
  #stderr = "";
  /**
   * The secret values this connection actually materialized. The host is the only thing that
   * knows them, and a server that prints its own environment or headers would otherwise put one
   * in an error message that travels to `mcp.changed`, the card and the thread log.
   */
  #materialized: string[] = [];

  constructor(options: McpConnectionOptions) {
    this.connector = options.connector;
    this.#secrets = options.secrets ?? null;
    this.#launch = options.launch;
    this.#onHealth = options.onHealth;
    this.#onToolsChanged = options.onToolsChanged;
    this.#project = options.project ?? null;
    this.#authProvider = options.authProvider;
    this.#redact = options.redact;
    this.#fetch = options.fetchImpl;
    this.health = options.connector.enabled ? McpHealth.Idle : McpHealth.Disabled;
    this.#remember(options.secretValues ?? []);
  }

  /** The secret values this connection holds or handed its server, for Studio's own redactor. */
  secretValues(): string[] {
    return [...this.#materialized];
  }

  get pid(): number | null {
    return this.#transport?.pid ?? null;
  }
  get connected(): boolean {
    return !!this.#client;
  }

  #setHealth(health: McpHealth, error?: string): void {
    if (this.health === health && this.error === error) return;
    this.health = health;
    this.error = error;
    try {
      this.#onHealth?.(health, error);
    } catch {
      /* a reporting hook never breaks a connection */
    }
  }

  /**
   * Remember what a secret became, so it can be taken back out of anything a person will read.
   * Of a connector's named values only the credential-named ones count (`WEATHER_API_KEY`, not
   * `BASE_URL`): the store holds its config too, and a public URL or folder is not a secret.
   */
  #remember<T extends Record<string, string> | string[]>(values: T): T {
    const secrets = Array.isArray(values)
      ? values
      : Object.entries(values)
          .filter(([name]) => isCredentialName(name))
          .map(([, value]) => value);
    // Shorter than this is not a secret worth redacting, and redacting it would eat ordinary words.
    for (const value of secrets)
      if (value.length >= 4 && !this.#materialized.includes(value)) this.#materialized.push(value);
    return values;
  }

  /**
   * `PATH`, `HOME`, `TMPDIR`, `LANG` and the declared secrets, plus on Windows what any program
   * needs to start there (`windowsBaseEnv`). Nothing inherited beyond that.
   */
  async #env(): Promise<Record<string, string>> {
    const base: Record<string, string> = windowsBaseEnv(process.env);
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG"] as const) {
      const value = process.env[name];
      if (value) base[name] = value;
    }
    base.PATH = (await toolchain()).path;
    const extra = this.#launch?.extraEnv ?? {};
    this.#remember(credentialEnvValues(extra));
    return { ...base, ...this.#remember(await materializeSecrets(this.#secrets, this.connector, "env")), ...extra };
  }

  async #headers(): Promise<Record<string, string>> {
    return this.#remember(await materializeSecrets(this.#secrets, this.connector, "header"));
  }

  /** An SDK client that answers `roots/list` with the bound project, when the connector may see it. */
  async #newClient(): Promise<SdkClient> {
    const { Client } = (await import("@modelcontextprotocol/sdk/client/index.js")) as unknown as {
      Client: new (info: { name: string; version: string }, options?: unknown) => SdkClient;
    };
    const client = new Client({ name: "ai-game-studio", version: "1" }, { capabilities: { roots: {} } });
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots:
        this.#project && path.isAbsolute(this.#project)
          ? [{ uri: pathToFileURL(this.#project).href, name: path.basename(this.#project) }]
          : [],
    }));
    return client;
  }

  /** The child a stdio connector runs: the SDK transport, or the piped one when the launch needs fd 3. */
  async #stdioTransport(): Promise<SdkTransport> {
    const env = await this.#env();
    const command = this.#launch?.execPath ?? this.connector.command ?? "";
    const executable = await resolveExecutable(command, env.PATH ?? "");
    if (!executable) throw new Error(MESSAGE.MissingExecutable(command));
    const args = [...(this.#launch?.extraArgs ?? []), ...(this.connector.args ?? [])];
    // The real folder, as macOS gives a child anyway; Windows would keep a short 8.3 or linked spelling.
    const cwd = this.connector.cwd ? await realpath(this.connector.cwd).catch(() => this.connector.cwd) : undefined;
    let transport: SdkTransport;
    if (this.#launch?.stdioExtra) {
      transport = new PipedStdioTransport({
        command: executable,
        args,
        cwd,
        env,
        extraStdio: this.#launch.extraStdio ?? ["pipe"],
        onSpawn: this.#launch.stdioExtra,
      }) as unknown as SdkTransport;
    } else {
      const { StdioClientTransport } = (await import("@modelcontextprotocol/sdk/client/stdio.js")) as unknown as {
        StdioClientTransport: new (params: Record<string, unknown>) => SdkTransport;
      };
      transport = new StdioClientTransport({ command: executable, args, cwd, env, stderr: "pipe" });
    }
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });
    return transport;
  }

  /** The connector's url; validation guarantees one for http and sse. */
  #remoteUrl(): URL {
    return new URL(this.connector.url ?? "");
  }

  async #httpTransport(): Promise<SdkTransport> {
    const { StreamableHTTPClientTransport } = (await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    )) as unknown as {
      StreamableHTTPClientTransport: new (url: URL, options?: Record<string, unknown>) => SdkTransport;
    };
    return new StreamableHTTPClientTransport(this.#remoteUrl(), {
      authProvider: this.#authProvider,
      requestInit: { headers: await this.#headers() },
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  async #sseTransport(): Promise<SdkTransport> {
    const headers = await this.#headers();
    const { SSEClientTransport } = (await import("@modelcontextprotocol/sdk/client/sse.js")) as unknown as {
      SSEClientTransport: new (url: URL, options?: Record<string, unknown>) => SdkTransport;
    };
    return new SSEClientTransport(this.#remoteUrl(), {
      authProvider: this.#authProvider,
      requestInit: { headers },
      eventSourceInit: { headers },
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  #transportFor(): Promise<SdkTransport> {
    if (this.connector.transport === McpTransport.Stdio) return this.#stdioTransport();
    if (this.connector.transport === McpTransport.Http) return this.#httpTransport();
    return this.#sseTransport();
  }

  /** A client error fails the connection; a close forgets it and drops a ready health to idle. */
  #watch(client: SdkClient): void {
    client.onerror = (error) => {
      this.#setHealth(McpHealth.Failed, this.#message(error));
    };
    client.onclose = () => {
      if (this.#client !== client) return;
      this.#client = undefined;
      this.#transport = undefined;
      this.#tools = undefined;
      if (this.health === McpHealth.Ready) this.#setHealth(McpHealth.Idle);
    };
  }

  /** Forget the cached tools whenever the server says its list changed. */
  async #followToolChanges(client: SdkClient): Promise<void> {
    try {
      const types = (await import("@modelcontextprotocol/sdk/types.js")) as unknown as {
        ToolListChangedNotificationSchema: unknown;
      };
      client.setNotificationHandler(types.ToolListChangedNotificationSchema, () => {
        this.#tools = undefined;
        this.#validators.clear();
        this.#onToolsChanged?.();
      });
    } catch {
      /* a server without list-change notifications simply never invalidates */
    }
  }

  /** Connect over the connector's transport; a URL saved as HTTP that answers like an SSE-only server gets SSE. */
  async #open(signal?: AbortSignal, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    try {
      await this.#openOver(await this.#transportFor(), signal, timeoutMs);
    } catch (error) {
      if (!(await this.#speaksOnlySse(error))) throw error;
      await this.#openOver(await this.#sseTransport(), signal, timeoutMs);
    }
  }

  /** Whether a failed Streamable HTTP handshake is the refusal of a server that only speaks SSE. */
  async #speaksOnlySse(error: unknown): Promise<boolean> {
    if (this.connector.transport !== McpTransport.Http) return false;
    const { StreamableHTTPError } = (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")) as unknown as {
      StreamableHTTPError: new (...args: never[]) => Error & { code?: number };
    };
    if (!(error instanceof StreamableHTTPError)) return false;
    const unanswered = this.#transport;
    this.#transport = undefined;
    await unanswered?.close().catch(() => {});
    return SSE_ONLY_STATUSES.has(error.code ?? 0);
  }

  async #openOver(transport: SdkTransport, signal?: AbortSignal, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const epoch = this.#epoch;
    const cancelled = () => epoch !== this.#epoch || Boolean(signal?.aborted);
    const client = await this.#newClient();
    this.#watch(client);
    if (cancelled()) throw new Error(MESSAGE.ConnectionCancelled);
    // Recorded before the handshake so a connect that times out still has its child to kill.
    this.#transport = transport;
    await client.connect(transport, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
    if (cancelled()) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new Error(MESSAGE.ConnectionCancelled);
    }
    await this.#followToolChanges(client);
    this.#client = client;
    this.#transport = transport;
    this.identity = serverIdentity(client.getServerVersion?.());
    this.lastConnectedAt = new Date().toISOString();
  }

  #message(error: unknown): string {
    const base = errorMessage(error);
    const tail = this.#stderr.trim().split("\n").slice(-4).join("\n");
    // This message reaches `mcp.changed`, the Connectors card and `connector_tool` in the thread
    // log. A server that echoes its own environment or headers must not leak a token through it.
    return this.#scrub(tail ? `${base} — ${tail}` : base);
  }

  /**
   * The values this connection knows, the account's tokens, then the credential shapes: all of
   * them in an error message, only the unmistakable tokens in a result, which is the service's
   * own words and goes to the model as they are (`the api_key field` is not a credential).
   */
  #scrub(text: string, shapes: (text: string) => string = redactSecrets): string {
    const byValue = redactValues(text, this.#materialized);
    return shapes(this.#redact?.(byValue) ?? byValue);
  }

  /** The same error with its words scrubbed: its class and code still tell a caller what happened. */
  #scrubbed(error: unknown): Error {
    if (!(error instanceof Error)) return new Error(this.#scrub(errorMessage(error)));
    error.message = this.#scrub(error.message);
    if (error.stack) error.stack = this.#scrub(error.stack);
    return error;
  }

  /** Idempotent, and safe to call again after a failure: a failed connection is rebuilt, never looped. */
  async connect(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (!this.connector.enabled) throw new Error(MESSAGE.SwitchedOff(this.connector.name));
    if (this.#client) return;
    if (this.#connecting) return this.#connecting;
    this.#stderr = "";
    this.#setHealth(McpHealth.Connecting);
    const attempt = this.#open(options.signal, options.timeoutMs)
      .then(
        () => {
          this.#setHealth(McpHealth.Ready);
        },
        async (error) => {
          const message = this.#message(error);
          await this.close().catch(() => {});
          this.#setHealth(McpHealth.Failed, message);
          throw new McpConnectFailed(message, httpStatusOf(error));
        },
      )
      .finally(() => {
        this.#connecting = undefined;
      });
    this.#connecting = attempt;
    return attempt;
  }

  /**
   * Every page of `tools/list`, cached until the server says the list changed. The pages share
   * ONE budget rather than each getting their own: twenty pages at ten seconds apiece would be a
   * three-minute delegation start, which is not what "a ten-second budget per connector" means.
   */
  async listTools(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpRawTool[]> {
    if (this.#tools) return this.#tools;
    await this.connect(options);
    const client = this.#connectedClient();
    const deadline = Date.now() + (options.timeoutMs ?? CONNECT_TIMEOUT_MS);
    const tools: McpRawTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const answer = await this.#toolPage(client, cursor, deadline, options.signal);
      tools.push(...answer.tools);
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    this.#tools = tools;
    return tools;
  }

  /** One `tools/list` page within what is left of the shared deadline. */
  async #toolPage(client: SdkClient, cursor: string | undefined, deadline: number, signal: AbortSignal | undefined) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(MESSAGE.ToolListTimedOut(this.connector.name));
    const answer = await client.listTools(cursor ? { cursor } : {}, { timeout: left, ...(signal ? { signal } : {}) });
    const tools = (answer.tools ?? []).map(rawTool).filter((tool): tool is McpRawTool => tool !== undefined);
    return { tools, nextCursor: answer.nextCursor };
  }

  /** The client `connect` just opened. */
  #connectedClient(): SdkClient {
    if (!this.#client) throw new Error(MESSAGE.ConnectorNotConnected(this.connector.name));
    return this.#client;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number; maxTotalTimeoutMs?: number } = {},
  ): Promise<LiveToolResult> {
    await this.connect({ signal: options.signal });
    const tools = await this.listTools({ signal: options.signal });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(MESSAGE.ToolWithdrawn);
    let validate = this.#validators.get(name);
    if (!validate) {
      // Compile per schema; one server's $id cannot replace another server's contract.
      const { AjvJsonSchemaValidator } = await import("@modelcontextprotocol/sdk/validation/ajv");
      validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
      this.#validators.set(name, validate);
    }
    const checked = validate(args ?? {});
    if (!checked.valid) throw new Error(MESSAGE.InvalidArguments(name, checked.errorMessage));
    // The answer goes to the model and, cut down, to the thread log; so do its errors.
    let live: LiveToolResult;
    try {
      live = toLiveToolResult(
        await this.#connectedClient().callTool({ name, arguments: args ?? {} }, undefined, {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: options.timeoutMs ?? CALL_TIMEOUT_MS,
          maxTotalTimeout: options.maxTotalTimeoutMs ?? CALL_TOTAL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        }),
      );
    } catch (error) {
      throw this.#scrubbed(error);
    }
    return typeof live === "string"
      ? this.#scrub(live, redactTokens)
      : { ...live, text: this.#scrub(live.text, redactTokens) };
  }

  /** Closes the client and kills the child. Health drops to `idle` unless it already failed. */
  async close(): Promise<void> {
    this.#epoch += 1;
    const client = this.#client,
      transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools = undefined;
    this.#connecting = undefined;
    this.#validators.clear();
    if (client) {
      client.onclose = undefined;
      client.onerror = undefined;
      await client.close().catch(() => {});
    }
    if (transport) await transport.close().catch(() => {});
    if (this.health === McpHealth.Ready || this.health === McpHealth.Connecting)
      this.#setHealth(this.connector.enabled ? McpHealth.Idle : McpHealth.Disabled);
  }
}
