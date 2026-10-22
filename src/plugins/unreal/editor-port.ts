/**
 * Which Unreal editor Genex reaches. Setup gives every project its own port for Epic's MCP server,
 * always inside a block of Genex's own and chosen once from a hash of the project's path, so two
 * set-up projects never clash and a port outside the block, such as Epic's default 8000 that any
 * project or app may hold, is never trusted to mean this project. "Answering" means Epic's own
 * server completes an MCP `initialize` on that port: a bare TCP connect said yes to any app holding
 * it, and other MCP apps name themselves where Epic's leaves the name empty. Setup records each
 * project and its port in the plugin's storage; the bridge reads them there with the panel's choice.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { GameEngine } from "../../shared/game-engine.ts";
import { ENGINE_LINKS_FOLDER } from "../../shared/plugins.ts";
import { atomicWriteJson, isJsonObject, listDirs, readRegularFile } from "../../substrate/fsx.ts";
import { isProjectPath, projectName } from "./project-file.ts";

const EDITOR_HOST = "127.0.0.1";
const EDITOR_PATH = "/mcp";
/** Ports below this need root; Epic's default is 8000. */
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65_535;
/** Genex's block for project ports, clear of Epic's 8000 and the usual development servers. */
const PROJECT_PORTS = { first: 18_000, count: 1000 } as const;

/** Genex's block as people read it: its first and last port. */
export const PROJECT_PORT_RANGE = {
  first: PROJECT_PORTS.first,
  last: PROJECT_PORTS.first + PROJECT_PORTS.count - 1,
} as const;

/** Whether a port lies in Genex's own block, the only ports setup gives a project. */
export function inProjectBlock(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= PROJECT_PORTS.first &&
    port < PROJECT_PORTS.first + PROJECT_PORTS.count
  );
}
/**
 * Each request of the answering check gives up after this. Epic's server answers in milliseconds
 * while the editor is in front, and in about 400 ms while it is behind another app.
 */
const ANSWER_TIMEOUT_MS = 0.8 * SECOND_MS;
/**
 * The longest an answering check takes ({@link editorServes}): its four requests (`initialize`, the
 * notification, the helper's `project_file` and the session's end), each within {@link ANSWER_TIMEOUT_MS}.
 */
export const ANSWER_CHECK_MS = 4 * ANSWER_TIMEOUT_MS;
/** How long a project's last good answer stands while its editor is asked again ({@link rememberAnswers}). */
const ANSWER_KEEP_MS = 10 * SECOND_MS;
/** A free local port refuses a connection at once; one that hangs this long counts as held. */
const LISTEN_TIMEOUT_MS = 0.5 * SECOND_MS;
/** macOS's own netstat, by full path, and its listing of every TCP socket by number. */
const NETSTAT = "/usr/sbin/netstat";
const NETSTAT_ARGS = ["-an", "-p", "tcp"] as const;
/** netstat answers in milliseconds; past this the test bind decides alone. */
const NETSTAT_TIMEOUT_MS = 5 * SECOND_MS;
/** A listing of every TCP socket is a few hundred KB at most. */
const NETSTAT_MAX_BYTES = 4 * 1024 * 1024;
/** netstat's columns: protocol, receive and send queues, then the local address. */
const NETSTAT_LOCAL_COLUMN = 3;
const COLUMNS = /\s+/;
/** A setup record is a few hundred bytes; anything larger is not one. */
const STORED_JSON_MAX_BYTES = 64 * 1024;
/** The Genex editor helper's toolset, and its tool that names the project the editor has open. */
export const HELPER_TOOLSET = "genex_play.tools.GenexPlayTools";
export const PROJECT_FILE_TOOL = "project_file";
const IDENTITY_ID = 2;
/** The MCP revision the check asks for; Epic 5.8 supports it. */
const PROTOCOL_VERSION = "2025-06-18";
const CHECK_ID = 1;
const SESSION_HEADER = "mcp-session-id";
const PLAIN_PORT = /^[1-9]\d*$/;
const LINE_BREAK = /\r?\n/;
const SSE_DATA = "data:";
/** The blank line that ends one server-sent event. */
const EVENT_END = /\r?\n\r?\n/;

/**
 * What setup keeps in the plugin's storage: one folder per project with its record, the panel's
 * choice, and when Genex last opened which project in Unreal.
 */
export const SetupStorage = {
  Folder: "setup",
  Record: "record.json",
  Chosen: "chosen.json",
  Starting: "starting.json",
  /** Each game's link, which the host keeps here (`<game>.json`). */
  Links: ENGINE_LINKS_FOLDER,
  /** The games whose chats chose Unreal before their project could be made (`<game>.json`). */
  Wants: "wants",
} as const;

const MESSAGE = {
  BadPort: (port: unknown) =>
    `Unreal MCP port must be a whole number from ${LOWEST_PORT} to ${HIGHEST_PORT}; got ${JSON.stringify(port)}.`,
} as const;

/** A set-up project the bridge may reach: its `.uproject`, its name for the agent and its editor's port. */
export type SetUpProject = { project: string; name: string; port: number };

/** How setup picks a port: the project, the port it has now, the ports other projects hold, and a listener probe. */
export type PortChoice = {
  project: string;
  current?: number;
  taken: ReadonlySet<number>;
  listening: (port: number) => Promise<boolean>;
};

/** Whether `value` is a port a user's program may serve on. */
export function isUserPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= LOWEST_PORT && value <= HIGHEST_PORT;
}

/** A port as written in a settings file, or undefined unless it is a plain user port number. */
export function parsePort(text: string | undefined): number | undefined {
  const value = text?.trim() ?? "";
  return PLAIN_PORT.test(value) && isUserPort(Number(value)) ? Number(value) : undefined;
}

/** The editor's MCP endpoint for a port as written, refusing anything but a plain user port number. */
export function editorEndpoint(port: string | undefined): URL {
  const value = typeof port === "string" && PLAIN_PORT.test(port) ? Number(port) : undefined;
  if (!isUserPort(value)) throw new Error(MESSAGE.BadPort(port));
  return new URL(`http://${EDITOR_HOST}:${value}${EDITOR_PATH}`);
}

/** The port setup starts from for a project: always the same for the same project file. */
export function derivedPort(project: string): number {
  const hash = createHash("sha256").update(project).digest();
  return PROJECT_PORTS.first + (hash.readUInt32BE(0) % PROJECT_PORTS.count);
}

/**
 * The port a project's editor serves on: the one it has while that is inside Genex's block and
 * usable, else the first usable one from its derived port, wrapping inside the block; undefined
 * when none is. A port outside the block (Epic's default 8000) always moves: another project or app
 * may serve there, and nothing in Epic's answer says which project it is. Usable means no other
 * set-up project holds it and nothing listens on it (setup runs only while Unreal is closed, so a
 * listener is another app).
 */
export async function choosePort(choice: PortChoice): Promise<number | undefined> {
  const usable = async (port: number) => !choice.taken.has(port) && !(await choice.listening(port));
  if (inProjectBlock(choice.current) && (await usable(choice.current))) return choice.current;
  const start = derivedPort(choice.project) - PROJECT_PORTS.first;
  for (let step = 0; step < PROJECT_PORTS.count; step++) {
    const port = PROJECT_PORTS.first + ((start + step) % PROJECT_PORTS.count);
    if (await usable(port)) return port;
  }
  return undefined;
}

/** Whether anything on this computer accepts connections on the port. */
export function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: EDITOR_HOST, port, timeout: LISTEN_TIMEOUT_MS });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Whether a test listener can bind the editor's address on `port` right now. */
function bindsNow(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: EDITOR_HOST, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

const run = promisify(execFile);

/** Every TCP socket on this Mac, as netstat lists them by number. */
async function netstatListing(): Promise<string> {
  const { stdout } = await run(NETSTAT, [...NETSTAT_ARGS], {
    timeout: NETSTAT_TIMEOUT_MS,
    maxBuffer: NETSTAT_MAX_BYTES,
  });
  return stdout;
}

/**
 * Whether macOS's netstat listing (`-an -p tcp`) holds a TCP socket whose own address is the
 * editor's, or any address, on `port`: one listening there, or a closed one still lingering.
 */
export function heldInListing(listing: string, port: number): boolean {
  const held = new Set([`${EDITOR_HOST}.${port}`, `*.${port}`]);
  return listing.split(LINE_BREAK).some((line) => {
    const columns = line.trim().split(COLUMNS);
    const tcp = columns[0]?.startsWith("tcp") === true;
    return tcp && held.has(columns[NETSTAT_LOCAL_COLUMN] ?? "");
  });
}

/**
 * Whether Unreal could listen on the port now. For about 30 s after an editor quits, its sockets
 * linger on the port (TIME_WAIT on a Mac), Epic's listener then can't bind it, and the MCP server
 * never starts. A test bind sees a listener, but Node's own bind sets SO_REUSEADDR and passes over
 * lingering sockets, so on a Mac netstat is asked as well; a netstat that can't run leaves the test
 * bind to decide. Elsewhere the test bind decides alone.
 */
export async function portFree(
  port: number,
  platform: NodeJS.Platform = process.platform,
  listSockets: () => Promise<string> = netstatListing,
): Promise<boolean> {
  if (!(await bindsNow(port))) return false;
  if (platform !== "darwin") return true;
  const listing = await listSockets().catch(() => undefined);
  return listing === undefined || !heldInListing(listing, port);
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: CHECK_ID,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "genex-studio", version: "0" } },
});

/** The data of an event stream's first event that carries any, or undefined while none has. */
function firstEventData(text: string): string | undefined {
  const events = text.split(EVENT_END);
  // The last piece is an event still arriving, unless the stream has ended.
  for (const event of events.slice(0, -1)) {
    const data = event
      .split(LINE_BREAK)
      .filter((line) => line.startsWith(SSE_DATA))
      .map((line) => line.slice(SSE_DATA.length).trimStart());
    if (data.length > 0) return data.join("\n");
  }
  return undefined;
}

/**
 * The text of an event stream up to the end of its first event with data. Epic's server keeps a
 * tool call's stream open after the answer until the connection idles out (about 15 s), so
 * waiting for the stream to end would miss every deadline.
 */
async function firstEvent(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      text += decoder.decode(value, { stream: !done });
      if (done) return firstEventData(`${text}\n\n`);
      const data = firstEventData(text);
      if (data !== undefined) return data;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The JSON-RPC message an answer carries, whether sent as JSON or as one server-sent event. */
async function answerMessage(response: Response): Promise<unknown> {
  const events = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const json = events && response.body ? await firstEvent(response.body) : await response.text();
  try {
    return JSON.parse(json ?? "");
  } catch {
    return undefined;
  }
}

/**
 * Whether an `initialize` answer is Epic's Unreal MCP as UE 5.8.3 sends it: an empty server name
 * (Epic never fills `serverInfo`, where other MCP apps name themselves) with both the resources and
 * the tools capability.
 */
export function isEpicServer(info: unknown, capabilities: unknown): boolean {
  const unnamed = isJsonObject(info) && info.name === "";
  const offers = isJsonObject(capabilities) && isJsonObject(capabilities.resources) && isJsonObject(capabilities.tools);
  return unnamed && offers;
}

/** Whether the message completes our `initialize` as Epic's Unreal MCP does. */
function completesAsEpic(message: unknown): boolean {
  const result = isJsonObject(message) && message.id === CHECK_ID ? message.result : undefined;
  return isJsonObject(result) && isEpicServer(result.serverInfo, result.capabilities);
}

/**
 * Whether Epic's Unreal MCP answers at the endpoint: an MCP `initialize` there completes the way
 * Epic's server does ({@link isEpicServer}) within {@link ANSWER_TIMEOUT_MS}. Redirects are never
 * followed, and the session the check opened is ended at once so the editor keeps none per check.
 */
export async function editorAnswers(endpoint: URL, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const signal = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: INITIALIZE,
      redirect: "error",
      signal,
    });
    const answers = response.ok && completesAsEpic(await answerMessage(response));
    const session = response.headers.get(SESSION_HEADER);
    if (session) {
      const signal = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
      const end = { method: "DELETE", headers: { [SESSION_HEADER]: session }, redirect: "error" as const, signal };
      await fetchImpl(endpoint.href, end).catch(() => undefined);
    }
    return answers;
  } catch {
    return false;
  }
}

const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const PROJECT_FILE_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: IDENTITY_ID,
  method: "tools/call",
  params: {
    name: "call_tool",
    arguments: { toolset_name: HELPER_TOOLSET, tool_name: PROJECT_FILE_TOOL, arguments: {} },
  },
});

/** The `returnValue` text an Epic tool answer carries, or undefined. */
export function returnedText(result: unknown): string | undefined {
  if (!isJsonObject(result) || result.isError === true || !Array.isArray(result.content)) return undefined;
  const text = result.content.find((part) => isJsonObject(part) && part.type === "text");
  try {
    const value: unknown = JSON.parse(isJsonObject(text) && typeof text.text === "string" ? text.text : "");
    return isJsonObject(value) && typeof value.returnValue === "string" ? value.returnValue : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the project an editor names is `project` (a real `.uproject`), as written or by its real path. */
export async function sameProject(named: string, project: string): Promise<boolean> {
  if (!named) return false;
  return named === project || (await realpath(named).catch(() => named)) === project;
}

/**
 * Whether the editor at the endpoint is Epic's Unreal MCP with `project` open: it answers
 * `initialize` as Epic's server does, and the Genex editor helper's `project_file` names this
 * project. Epic's own answer carries no project, so without this another project's editor on
 * the same port would pass for this one. Each request has its own {@link ANSWER_TIMEOUT_MS}: an
 * editor behind another app takes about 400 ms per request, so one budget for all three failed it.
 * The session the check opened is ended.
 */
export async function editorServes(endpoint: URL, project: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const post = (body: string, session: string | null) =>
    fetchImpl(endpoint.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { [SESSION_HEADER]: session } : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
  let session: string | null = null;
  try {
    const opened = await post(INITIALIZE, null);
    session = opened.headers.get(SESSION_HEADER);
    if (!opened.ok || !completesAsEpic(await answerMessage(opened))) return false;
    await (await post(INITIALIZED, session)).text();
    const answer = await post(PROJECT_FILE_CALL, session);
    const message = answer.ok ? await answerMessage(answer) : undefined;
    const named = isJsonObject(message) && message.id === IDENTITY_ID ? returnedText(message.result) : undefined;
    return named !== undefined && (await sameProject(named, project));
  } catch {
    return false;
  } finally {
    if (session) {
      const signal = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
      const end = { method: "DELETE", headers: { [SESSION_HEADER]: session }, redirect: "error" as const, signal };
      await fetchImpl(endpoint.href, end).catch(() => undefined);
    }
  }
}

/** A JSON file in the plugin's storage, or undefined when it is missing, a link, not a plain file or not JSON. */
async function readStoredJson(file: string): Promise<unknown> {
  try {
    return JSON.parse((await readRegularFile(file, STORED_JSON_MAX_BYTES)).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored record names an absolute `.uproject` and a port in Genex's block; a record from
 * before ports moved there (Epic's 8000) is not trusted until setup runs again.
 */
const namesProjectAndPort = (record: unknown): record is { project: string; port: number } =>
  isJsonObject(record) && isProjectPath(record.project) && inProjectBlock(record.port);

/** The set-up project a record names, or undefined when the record can't be trusted to name one. */
function setUpProjectFrom(record: unknown): SetUpProject | undefined {
  if (!namesProjectAndPort(record)) return undefined;
  const { project, port } = record;
  return { project, name: projectName(project), port };
}

/** The project last chosen in the panel, as its real `.uproject` path. */
export async function chosenProject(storage: string): Promise<string | undefined> {
  const chosen = await readStoredJson(path.join(storage, SetupStorage.Chosen));
  return isJsonObject(chosen) && isProjectPath(chosen.project) ? chosen.project : undefined;
}

/** Remembers the project chosen in the panel; writes only when the choice changed. */
export async function rememberChoice(storage: string, project: string): Promise<void> {
  if ((await chosenProject(storage)) === project) return;
  await atomicWriteJson(path.join(storage, SetupStorage.Chosen), { project });
}

/**
 * The projects setup recorded in the plugin's storage, each with its own port: the one chosen in
 * the panel first, then by path. Only reads; a record that is a link, not a plain file, not JSON
 * or without a usable port is skipped.
 */
export async function listSetUpProjects(storage: string): Promise<SetUpProject[]> {
  const folder = path.join(storage, SetupStorage.Folder);
  const found: SetUpProject[] = [];
  for (const key of await listDirs(folder).catch(() => [])) {
    const project = setUpProjectFrom(await readStoredJson(path.join(folder, key, SetupStorage.Record)));
    if (project) found.push(project);
  }
  const chosen = await chosenProject(storage);
  const rank = (p: SetUpProject) => (p.project === chosen ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b) || a.project.localeCompare(b.project));
}

/** The project chosen in the panel as the bridge needs it: its `.uproject`, its name, and its port once set up. */
export type ChosenProject = { project: string; name: string; port?: number };

/** The folder the host runs a bridge in when a call has no game. */
const SHARED_BRIDGE = "_shared";

/**
 * Where a bridge started in `cwd` keeps its records and which game it serves: the host runs it in
 * `<plugin storage>/mcp/<game>`, or in `<plugin storage>/mcp/_shared` for calls without a game.
 */
export function bridgeHome(cwd: string): { storage: string; game?: string } {
  const folder = path.basename(cwd);
  const storage = path.dirname(path.dirname(cwd));
  return folder === SHARED_BRIDGE ? { storage } : { storage, game: folder };
}

/** A game id as Genex names a game's link file: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/**
 * The project Genex linked `game` to (`links/<game>.json`, which the host writes in this plugin's
 * storage and agents can't), or undefined when it has none: never linked, its link undone, or a
 * record that isn't a plain file naming a `.uproject`.
 */
export async function linkedProject(storage: string, game: string | undefined): Promise<string | undefined> {
  if (!game || !GAME_ID.test(game)) return undefined;
  const link = await readStoredJson(path.join(storage, SetupStorage.Links, `${game}.json`));
  return isJsonObject(link) && link.kind === GameEngine.Unreal && isProjectPath(link.project)
    ? link.project
    : undefined;
}

/** Where `game`'s record that its chat chose Unreal lives, or undefined for an id that isn't a plain folder name. */
const wantFile = (storage: string, game: string | undefined): string | undefined =>
  game && GAME_ID.test(game) ? path.join(storage, SetupStorage.Wants, `${game}.json`) : undefined;

/**
 * Whether `game`'s chat chose Unreal before its project could be made (no Unreal Genex makes games
 * with was installed): its stage strip shows the Unreal button, which shows how to get Unreal.
 */
export async function wantsUnreal(storage: string, game: string | undefined): Promise<boolean> {
  const file = wantFile(storage, game);
  return file ? isJsonObject(await readStoredJson(file)) : false;
}

/** Remembers that `game`'s chat chose Unreal; written once. */
export async function rememberWant(storage: string, game: string | undefined, now: number): Promise<void> {
  const file = wantFile(storage, game);
  if (!file || (await wantsUnreal(storage, game))) return;
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteJson(file, { at: new Date(now).toISOString() });
}

/** The suffix of each game's link record in the plugin's storage, `<game>.json`. */
const LINK_SUFFIX = ".json";

/**
 * Whether some Genex game builds in `project` (its real `.uproject`), by the link records the host
 * keeps in the plugin's storage. Only reads.
 */
export async function linkedToAGame(storage: string, project: string): Promise<boolean> {
  const names = await readdir(path.join(storage, SetupStorage.Links)).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(LINK_SUFFIX)))
    if ((await linkedProject(storage, name.slice(0, -LINK_SUFFIX.length))) === project) return true;
  return false;
}

/**
 * What the bridge may reach: the calling game's own project when Genex linked it, else the project
 * chosen in the panel (with its port when it is set up, and none when it isn't), and every set-up
 * project. Only reads.
 */
export async function bridgeProjects(
  storage: string,
  game?: string,
): Promise<{ chosen?: ChosenProject; setUp: SetUpProject[] }> {
  const [linked, panel, setUp] = await Promise.all([
    linkedProject(storage, game),
    chosenProject(storage),
    listSetUpProjects(storage),
  ]);
  const file = linked ?? panel;
  if (!file) return { setUp };
  const recorded = setUp.find((p) => p.project === file);
  const chosen: ChosenProject = {
    project: file,
    name: projectName(file),
    ...(recorded ? { port: recorded.port } : {}),
  };
  return { chosen, setUp };
}

/** A check of whether the editor on `port` answers, with `project` open when it is named. */
export type AnswerCheck = (port: number, project?: string) => Promise<boolean>;

/**
 * `check`, remembering each port and project's last good answer for {@link ANSWER_KEEP_MS} by
 * `now`. While a good answer stands, a check says yes at once and asks the editor again in the
 * background: with the editor behind another app one check takes about 1.3 s, and now and then a
 * single request stalls past its limit, which flipped a connected panel to "not answering" for one
 * refresh. A failed ask is never remembered, so the next call waits for the editor and believes
 * it: a stopped editor reads as not answering one refresh later. One ask at a time per port and
 * project; an ask that throws counts as not answering.
 */
export function rememberAnswers(check: AnswerCheck, now: () => number): AnswerCheck {
  const goodAt = new Map<string, number>();
  const asking = new Map<string, Promise<boolean>>();
  const ask = (key: string, port: number, project: string | undefined) => {
    const pending = asking.get(key);
    if (pending) return pending;
    const answer = check(port, project)
      .catch(() => false)
      .then((yes) => {
        asking.delete(key);
        if (yes) goodAt.set(key, now());
        else goodAt.delete(key);
        return yes;
      });
    asking.set(key, answer);
    return answer;
  };
  return (port, project) => {
    const key = JSON.stringify([port, project ?? null]);
    const at = goodAt.get(key);
    if (at === undefined || now() - at >= ANSWER_KEEP_MS) return ask(key, port, project);
    void ask(key, port, project);
    return Promise.resolve(true);
  };
}
