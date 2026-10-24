/**
 * The helper link: which Genex helper in which Roblox Studio is which game's, and the requests and
 * answers between the backend and that helper.
 *
 * Binding is exact. Each connection gets a random session id (`session.mark`); the helper puts it
 * in a non-archivable StringValue in Studio's CoreGui ({@link SESSION_MARKER}), the sessions of
 * its connections joined by commas (a helper talks to at most two Genex backends); the backend then
 * reads that marker in every Studio StudioMCP lists, through `execute_luau` in Edit. The one Studio
 * whose marker holds the session is the connection's. Only when no listed Studio lets the marker
 * be read at all does the place the helper names stand in, and two Studios with that place are
 * refused. The game is the one whose linked place that Studio has open; with none, or two, the
 * connection binds no game.
 *
 * A bound game's binding file (`<storage>/mcp/<game>/studio.json`, `studio-binding.ts`) is written
 * at once and refreshed every {@link BINDING_REFRESH_MS}; the game's Roblox Studio connection reads
 * it on every call. When the connection ends the file is no longer refreshed and goes stale. After
 * a Studio restart the helper connects again with a new session, and the new Studio's id is
 * written. The newest connection wins: for one Studio the older one is closed, for one game the
 * older one stops writing.
 *
 * Before a connection's game is first bound, `beforeBind` runs with that helper (a place load that
 * waited for Studio, `place-files.ts`), so the binding file, which agents need to reach Studio,
 * appears only after it.
 *
 * A connection bound to no game is heard but obeyed in nothing: its events reach no sink and call
 * nothing. Data chunks reach only the request they belong to.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import type { JobClock } from "../../substrate/job-process.ts";
import { isBelow } from "../../substrate/paths.ts";
import { agentBusyMarker, agentFolder, type BusyMarker } from "./agent-marks.ts";
import {
  CHUNK_BYTES,
  chunkFrame,
  createHelperInbox,
  type DataChunk,
  type HelloBody,
  type HelperAnswer,
  type HelperEvent,
  type HelperInbox,
  HelperMessage,
  type HelperRequest,
  type HelperRequestBodies,
  type HelperResults,
  type ScriptChange,
  SESSION_MARKER,
  requestFrame,
} from "./helper-protocol.ts";
import {
  type HelperConnection,
  type HelperHandlers,
  type HelperServer,
  type HelperSocketOptions,
  startHelperSocket,
  WsClose,
} from "./helper-socket.ts";
import { BINDING_REFRESH_MS, type PlaceLink, placeMatcher, readPlaceLinks, writeBinding } from "./studio-binding.ts";
import type { StudioClient, StudioEntry, StudioToolResult } from "./studio-client.ts";
import { DATAMODEL_ARG, EDIT_DATAMODEL, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";

/** How long the helper may take to put its session marker in place. */
const MARK_ANSWER_MS = 10 * SECOND_MS;
/** A request's limit unless its caller gives one. */
export const HELPER_ANSWER_MS = 30 * SECOND_MS;
/** How often a connection not yet found in any Studio is looked for again. */
export const BIND_RETRY_MS = 2 * SECOND_MS;
/** How long a connection is looked for: Studio joins a fresh StudioMCP a few seconds after it starts. */
export const BIND_WAIT_MS = 30 * SECOND_MS;
/** The folder of the game connections under the plugin's storage (manifest cwd `storage:project`). */
const CONNECTIONS_FOLDER = "mcp";
/** The game folder's script root. */
const SCRIPTS_FOLDER = "src";
const MARKER_VALUE = "genex-marker:";
/** Between the sessions a marker holds. */
const SESSION_SEPARATOR = ",";
const MARKER_UNREACHABLE = "genex-marker-unreachable";
/** The marker's value in an answer: printable, no spaces. */
const MARKER_IN_TEXT = new RegExp(`${MARKER_VALUE}([\\x21-\\x7e]*)`);

/**
 * The marker read, run in Edit in each listed Studio. It reads only the one value and says plainly
 * when CoreGui can't be reached from `execute_luau`.
 */
export const MARKER_READ_LUAU = [
  "local ok, value = pcall(function()",
  `  local marker = game:GetService("CoreGui"):FindFirstChild("${SESSION_MARKER}")`,
  '  return if marker and marker:IsA("StringValue") then marker.Value else ""',
  "end)",
  `return if ok then "${MARKER_VALUE}" .. value else "${MARKER_UNREACHABLE}"`,
].join("\n");

/** Why a request didn't get its answer. Wire values: never rename. */
export const HelperLinkFailure = {
  /** No helper is bound to the game. */
  NotBound: "not-bound",
  TimedOut: "timed-out",
  /** The helper's connection ended first. */
  Closed: "closed",
  /** The request is larger than the link carries. */
  TooBig: "too-big",
  /** The helper answered with its own error (`helperCode`). */
  Answered: "answered",
} as const;
export type HelperLinkFailure = (typeof HelperLinkFailure)[keyof typeof HelperLinkFailure];

const MESSAGE = {
  NotBound: "The Genex helper in Roblox Studio isn't connected for this game.",
  TimedOut: (type: string) => `The Genex helper in Roblox Studio didn't answer ${type} in time.`,
  Closed: "The Genex helper's connection ended before it answered.",
  TooBig: "The request is larger than the helper link carries.",
} as const;

/** A request's failure, with the helper's own error code when it answered with one. */
export class HelperLinkError extends Error {
  code: HelperLinkFailure;
  helperCode: string | undefined;
  constructor(code: HelperLinkFailure, message: string, helperCode?: string) {
    super(message);
    this.name = "HelperLinkError";
    this.code = code;
    this.helperCode = helperCode;
  }
}

/** Where a bound helper's events go; each is given the game they belong to. */
export interface HelperSinks {
  scriptsChanged?(game: string, change: ScriptChange): void | Promise<void>;
  activity?(game: string, body: { editing: boolean }): void;
  team?(game: string, body: { others: string[] }): void;
}

/** One game's helper, asked through the link: what `beforeBind` is given. */
export type HelperAsk = <T extends HelperRequest>(
  type: T,
  body: HelperRequestBodies[T],
  options?: RequestOptions,
) => Promise<HelperResults[T]>;

/** A part the backend sends ahead of its request, as raw bytes. */
export interface Upload {
  part: string;
  data: Uint8Array;
}

/** How one request is sent and answered. */
export interface RequestOptions {
  /** The request's limit on the link's clock; never lengthened. */
  timeoutMs?: number;
  /** Gets each `data.chunk` the helper sends for this request, before its answer. */
  onChunk?(chunk: DataChunk): void;
  /** Parts sent as `data.chunk`s of this request's transfer just before it. */
  upload?: Upload[];
}

/** What the link works with; tests hand in a fake Studio and clock. */
export interface HelperLinkDeps {
  /** The plugin's storage: link records under `links/`, binding files under `mcp/<game>/`. */
  storage: string;
  /** StudioMCP, through which the marker is read. */
  studio: Pick<StudioClient, "studios" | "callTool">;
  clock: JobClock;
  /** A fresh random session id. */
  newSession(): string;
  /**
   * Runs once when a connection first takes a game, before its binding file is written: the
   * helper can be asked already, agents can't reach the Studio yet. A failure is logged and the
   * game is bound all the same.
   */
  beforeBind?(game: string, ask: HelperAsk): Promise<void>;
  sinks?: HelperSinks;
  log?(line: string): void;
}

/** The link over its connections. */
export interface HelperLink {
  /** Takes a connection the socket accepted. */
  accept(connection: HelperConnection): HelperHandlers;
  /** Asks the game's helper; rejects with a {@link HelperLinkError}. */
  request<T extends HelperRequest>(
    game: string,
    type: T,
    body: HelperRequestBodies[T],
    options?: RequestOptions,
  ): Promise<HelperResults[T]>;
  /** The Studio a game's helper is bound to now. */
  bound(game: string): string | undefined;
  /** Settles once every bind, refresh and event under way has finished. */
  idle(): Promise<void>;
  close(): void;
}

interface Pending {
  type: HelperRequest;
  onChunk?(chunk: DataChunk): void;
  resolve(result: unknown): void;
  reject(error: HelperLinkError): void;
  timer: unknown;
}

/** One helper connection and what the link knows of it. */
interface Linked {
  connection: HelperConnection;
  inbox: HelperInbox;
  pending: Map<number, Pending>;
  nextId: number;
  hello?: HelloBody;
  session?: string;
  /** When binding began, for the retry window. */
  bindFrom?: number;
  retry?: unknown;
  studio?: StudioEntry;
  /** Binding order: a later connection wins. */
  order: number;
  game?: string;
  /** While `beforeBind` runs for the game: no binding file is written until it ends. */
  preparing: boolean;
  closed: boolean;
}

/** What a Studio's marker read says. */
type MarkerRead = { value: string } | { unreachable: true } | { unknown: true };

const textOf = (result: StudioToolResult) =>
  result.content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");

/** The marker a Studio's answer holds; a failed call tells nothing. */
function markerOf(result: StudioToolResult): MarkerRead {
  if (result.isError) return { unknown: true };
  const text = textOf(result);
  const value = MARKER_IN_TEXT.exec(text)?.[1];
  if (value !== undefined) return { value };
  return text.includes(MARKER_UNREACHABLE) ? { unreachable: true } : { unknown: true };
}

/** A whole number standing alone in `text`. */
const holdsNumber = (text: string, digits: string) => new RegExp(`(^|\\D)${digits}(\\D|$)`).test(text);

/** Whether a listed Studio has the place the helper names open: by its published id, else its name. */
function namesPlace(hello: HelloBody | undefined, studio: StudioEntry): boolean {
  if (!hello) return false;
  if (hello.place.id !== "0") return holdsNumber(studio.name, hello.place.id);
  return studio.name === hello.place.name;
}

/**
 * The file a script path lands in: `<root>/src/<path>`, with no link and nothing but folders on the
 * way, and the file itself (when it exists) a plain file. Throws otherwise. The backend's mapping
 * from a {@link ScriptChange} to its file name ends here before any write.
 */
export async function scriptTarget(root: string, scriptPath: string): Promise<string> {
  const base = await realpath(root);
  const parts = [SCRIPTS_FOLDER, ...scriptPath.split("/")];
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // Nothing exists from here on, so nothing on the rest of the way is a link.
    if (!stat) break;
    const last = index === parts.length - 1;
    const plain = last ? stat.isFile() : stat.isDirectory();
    if (stat.isSymbolicLink() || !plain) throw new Error(`Refused script path ${scriptPath}`);
  }
  const target = path.join(base, ...parts);
  if (!isBelow(base, target)) throw new Error(`Refused script path ${scriptPath}`);
  return target;
}

/** The link's whole state: its connections, which Studio and game each holds, and the work under way. */
interface LinkState {
  deps: HelperLinkDeps;
  connections: Set<Linked>;
  byStudio: Map<string, Linked>;
  owners: Map<string, Linked>;
  work: Set<Promise<unknown>>;
  order: number;
  refresh: unknown;
  closed: boolean;
  /** Each game's busy mark, shared by every read the link runs in that game's Studio. */
  markers: Map<string, BusyMarker>;
}

const log = (link: LinkState, line: string) => link.deps.log?.(line);

/** Runs `task` as work `idle` waits for; its failure is logged, never thrown. */
function track(link: LinkState, task: Promise<unknown>): void {
  const settled = task.catch((error: unknown) => log(link, `helper link: ${String(error)}`));
  link.work.add(settled);
  void settled.finally(() => link.work.delete(settled));
}

/** The chunk frames of `uploads` for the transfer `transfer`, each with the next id. */
function uploadFrames(linked: Linked, transfer: number, uploads: readonly Upload[]): string[] {
  const frames: string[] = [];
  for (const upload of uploads) {
    const count = Math.max(1, Math.ceil(upload.data.length / CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      const piece = upload.data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      const data = Buffer.from(piece.buffer, piece.byteOffset, piece.length).toString("base64");
      frames.push(chunkFrame(++linked.nextId, { transfer, part: upload.part, index, count, data }));
    }
  }
  return frames;
}

/** Sends a request (after its uploads) and waits for its answer until the deadline on the link's clock. */
function send<T extends HelperRequest>(
  link: LinkState,
  linked: Linked,
  request: { type: T; body: HelperRequestBodies[T]; timeoutMs: number } & Omit<RequestOptions, "timeoutMs">,
): Promise<HelperResults[T]> {
  const id = ++linked.nextId;
  try {
    for (const frame of uploadFrames(linked, id, request.upload ?? [])) linked.connection.send(frame);
    linked.connection.send(requestFrame(id, request.type, request.body));
  } catch {
    const error = linked.connection.open
      ? new HelperLinkError(HelperLinkFailure.TooBig, MESSAGE.TooBig)
      : new HelperLinkError(HelperLinkFailure.Closed, MESSAGE.Closed);
    return Promise.reject(error);
  }
  return new Promise<HelperResults[T]>((resolve, reject) => {
    const timer = link.deps.clock.setTimeout(() => {
      if (!linked.pending.delete(id)) return;
      reject(new HelperLinkError(HelperLinkFailure.TimedOut, MESSAGE.TimedOut(request.type)));
    }, request.timeoutMs);
    const pending: Pending = { type: request.type, resolve: resolve as (result: unknown) => void, reject, timer };
    if (request.onChunk) pending.onChunk = request.onChunk;
    linked.pending.set(id, pending);
  });
}

function answered(link: LinkState, linked: Linked, re: number, answer: HelperAnswer): void {
  const pending = linked.pending.get(re);
  if (!pending) return;
  linked.pending.delete(re);
  link.deps.clock.clearTimeout(pending.timer);
  if (answer.ok) pending.resolve(answer.result);
  else pending.reject(new HelperLinkError(HelperLinkFailure.Answered, answer.error.message, answer.error.code));
}

/**
 * Runs Genex's own read in a Studio with the busy mark of the game bound to that Studio: Studio
 * records an `execute_luau` run as an edit, and that game's helper would report it as the person's.
 */
function asAgentIn<T>(link: LinkState, studio: StudioEntry, work: () => Promise<T>): Promise<T> {
  const game = link.byStudio.get(studio.id)?.game;
  const folder = game ? agentFolder(link.deps.storage, game) : undefined;
  if (!game || !folder) return work();
  let marker = link.markers.get(game);
  if (!marker) {
    marker = agentBusyMarker(folder, link.deps.clock.now);
    link.markers.set(game, marker);
  }
  return marker.around(work);
}

function readMarker(link: LinkState, studio: StudioEntry): Promise<MarkerRead> {
  const args = { [STUDIO_ID_ARG]: studio.id, [DATAMODEL_ARG]: EDIT_DATAMODEL, code: MARKER_READ_LUAU };
  const read = () => link.deps.studio.callTool(StudioTool.ExecuteLuau, args);
  return asAgentIn(link, studio, read).then(markerOf, (): MarkerRead => ({ unknown: true }));
}

/** The Studio the connection is in: its marker, or with no marker readable anywhere, its place alone. */
async function findStudio(link: LinkState, linked: Linked): Promise<StudioEntry | undefined> {
  const studios = await link.deps.studio.studios();
  const reads = await Promise.all(studios.map((studio) => readMarker(link, studio)));
  const holdsSession = (read: MarkerRead | undefined) =>
    read !== undefined &&
    "value" in read &&
    read.value.split(SESSION_SEPARATOR).some((held) => held === linked.session);
  const marked = studios.filter((_studio, index) => holdsSession(reads[index]));
  if (marked.length > 0) return marked.length === 1 ? marked[0] : undefined;
  const unreadable = studios.length > 0 && reads.every((read) => "unreachable" in read);
  if (!unreadable) return undefined;
  const named = studios.filter((studio) => namesPlace(linked.hello, studio));
  return named.length === 1 ? named[0] : undefined;
}

/** Lets go of a connection's game and Studio, if it still holds them. */
function release(link: LinkState, linked: Linked): void {
  if (linked.studio && link.byStudio.get(linked.studio.id) === linked) link.byStudio.delete(linked.studio.id);
  if (linked.game && link.owners.get(linked.game) === linked) link.owners.delete(linked.game);
  linked.game = undefined;
}

/** The connection is this Studio's now; an older connection from the same Studio is closed. */
function takeStudio(link: LinkState, linked: Linked, studio: StudioEntry): void {
  const older = link.byStudio.get(studio.id);
  if (older && older !== linked) {
    release(link, older);
    older.studio = undefined;
    older.connection.close(WsClose.Policy, "replaced");
  }
  linked.studio = studio;
  linked.order = ++link.order;
  link.byStudio.set(studio.id, linked);
}

/** Whether a linked place's project file is still there: a removed game's link record outlives it. */
const projectExists = (place: PlaceLink) =>
  lstat(place.project).then(
    () => true,
    () => false,
  );

/** The one live game whose linked place the Studio has open; none when no game, or two, link it. */
async function gameOf(link: LinkState, studio: StudioEntry): Promise<string | undefined> {
  const matching = (await readPlaceLinks(link.deps.storage)).filter(({ link: place }) => placeMatcher(place)(studio));
  const live = await Promise.all(matching.map(({ link: place }) => projectExists(place)));
  const games = matching.filter((_game, index) => live[index]);
  if (games.length > 1) log(link, `helper link: ${games.length} games link the place ${studio.name}; none bound`);
  return games.length === 1 ? games[0]?.game : undefined;
}

/** Each connection's Studio as StudioMCP lists it now: a publish or a save renames its place. */
async function relistStudios(link: LinkState): Promise<void> {
  const listed = await link.deps.studio.studios().catch(() => [] as StudioEntry[]);
  const byId = new Map(listed.map((studio) => [studio.id, studio]));
  for (const linked of link.connections) {
    const now = linked.studio && byId.get(linked.studio.id);
    if (now) linked.studio = now;
  }
}

/** Binds the connection to its Studio's game, unless a newer connection holds it, and writes its file. */
async function claimGame(link: LinkState, linked: Linked): Promise<void> {
  const { studio, session } = linked;
  if (!studio || !session || linked.closed || linked.preparing) return;
  const game = await gameOf(link, studio);
  if (linked.game && linked.game !== game) release(link, linked);
  if (!game || linked.closed) return;
  const owner = link.owners.get(game);
  if (owner && owner !== linked && owner.order > linked.order) return;
  if (owner && owner !== linked) owner.game = undefined;
  link.owners.set(game, linked);
  const first = linked.game !== game;
  linked.game = game;
  if (first) {
    linked.preparing = true;
    await runBeforeBind(link, linked, game).finally(() => {
      linked.preparing = false;
    });
  }
  if (linked.closed || link.owners.get(game) !== linked) return;
  const folder = path.join(link.deps.storage, CONNECTIONS_FOLDER, game);
  await writeBinding(folder, { studioId: studio.id, session }, link.deps.clock.now());
}

/** The game's `beforeBind`, asked through this connection; its failure is logged, never thrown. */
async function runBeforeBind(link: LinkState, linked: Linked, game: string): Promise<void> {
  const ask: HelperAsk = (type, body, options = {}) =>
    send(link, linked, { ...options, type, body, timeoutMs: options.timeoutMs ?? HELPER_ANSWER_MS });
  await link.deps
    .beforeBind?.(game, ask)
    .catch((error: unknown) => log(link, `helper link: before binding ${game}: ${String(error)}`));
}

/** Rewrites every bound game's file each refresh period while the link runs. */
function scheduleRefresh(link: LinkState): void {
  if (link.refresh !== undefined || link.closed) return;
  link.refresh = link.deps.clock.setTimeout(() => {
    link.refresh = undefined;
    const claims = async () => {
      await relistStudios(link);
      for (const linked of link.connections) if (linked.studio) track(link, claimGame(link, linked));
    };
    track(link, claims());
    scheduleRefresh(link);
  }, BINDING_REFRESH_MS);
}

/** Finds the connection's Studio, asking again while Studio may still be joining StudioMCP. */
async function bind(link: LinkState, linked: Linked): Promise<void> {
  linked.retry = undefined;
  if (linked.closed || link.closed) return;
  const studio = await findStudio(link, linked).catch(() => undefined);
  if (linked.closed) return;
  if (studio) {
    takeStudio(link, linked, studio);
    await claimGame(link, linked);
    scheduleRefresh(link);
    return;
  }
  const now = link.deps.clock.now();
  const waited = now - (linked.bindFrom ?? now);
  if (waited + BIND_RETRY_MS > BIND_WAIT_MS) {
    log(link, "helper link: the helper's Studio wasn't found; the connection stays unbound");
    return;
  }
  linked.retry = link.deps.clock.setTimeout(() => track(link, bind(link, linked)), BIND_RETRY_MS);
}

/** A hello's answer: the session the helper marks in CoreGui, then the search for its Studio. */
async function start(link: LinkState, linked: Linked): Promise<void> {
  const session = link.deps.newSession();
  linked.session = session;
  await send(link, linked, { type: HelperMessage.SessionMark, body: { session }, timeoutMs: MARK_ANSWER_MS });
  linked.bindFrom = link.deps.clock.now();
  await bind(link, linked);
}

/** A bound connection's event, handed to its sink with the connection's game. */
function deliverEvent(link: LinkState, game: string, event: HelperEvent): void {
  const sinks = link.deps.sinks;
  if (event.type === HelperMessage.ScriptsChanged)
    track(link, Promise.resolve(sinks?.scriptsChanged?.(game, event.body)));
  else if (event.type === HelperMessage.Activity) sinks?.activity?.(game, event.body);
  else if (event.type === HelperMessage.Team) sinks?.team?.(game, event.body);
}

function onEvent(link: LinkState, linked: Linked, event: HelperEvent): void {
  if (event.type === HelperMessage.DataChunk) {
    // The reader let it through only for a request still waiting.
    linked.pending.get(event.body.transfer)?.onChunk?.(event.body);
    return;
  }
  if (event.type !== HelperMessage.Hello) {
    // A connection bound to no game is obeyed in nothing.
    if (linked.game) deliverEvent(link, linked.game, event);
    return;
  }
  if (linked.hello) {
    log(link, "helper link: a second hello was ignored");
    return;
  }
  linked.hello = event.body;
  track(link, start(link, linked));
}

function onMessage(link: LinkState, linked: Linked, text: string): void {
  const read = linked.inbox.read(text, (re) => linked.pending.get(re)?.type);
  if (!read.ok) log(link, `helper link: refused a message (${read.refusal})`);
  else if (read.message.kind === "answer") answered(link, linked, read.message.re, read.message.answer);
  else onEvent(link, linked, read.message.event);
}

function onClosed(link: LinkState, linked: Linked): void {
  linked.closed = true;
  link.connections.delete(linked);
  link.deps.clock.clearTimeout(linked.retry);
  for (const pending of linked.pending.values()) {
    link.deps.clock.clearTimeout(pending.timer);
    pending.reject(new HelperLinkError(HelperLinkFailure.Closed, MESSAGE.Closed));
  }
  linked.pending.clear();
  release(link, linked);
}

/** The link over the Studio and storage it is given. */
export function createHelperLink(deps: HelperLinkDeps): HelperLink {
  const link: LinkState = {
    deps,
    connections: new Set(),
    byStudio: new Map(),
    owners: new Map(),
    work: new Set(),
    order: 0,
    refresh: undefined,
    closed: false,
    markers: new Map(),
  };
  return {
    accept(connection) {
      const linked: Linked = {
        connection,
        inbox: createHelperInbox(),
        pending: new Map(),
        nextId: 0,
        order: 0,
        preparing: false,
        closed: false,
      };
      link.connections.add(linked);
      return { message: (text) => onMessage(link, linked, text), closed: () => onClosed(link, linked) };
    },
    request(game, type, body, options = {}) {
      const owner = link.owners.get(game);
      if (!owner) return Promise.reject(new HelperLinkError(HelperLinkFailure.NotBound, MESSAGE.NotBound));
      return send(link, owner, { ...options, type, body, timeoutMs: options.timeoutMs ?? HELPER_ANSWER_MS });
    },
    bound: (game) => link.owners.get(game)?.studio?.id,
    async idle() {
      while (link.work.size > 0) await Promise.allSettled([...link.work]);
    },
    close() {
      link.closed = true;
      deps.clock.clearTimeout(link.refresh);
      link.refresh = undefined;
      for (const linked of link.connections) linked.connection.close(WsClose.GoingAway);
    },
  };
}

/**
 * The link on its socket, listening on the first free helper port. It closes once `signal` aborts:
 * a backend whose host is gone must not hold the port, nor stay alive for it.
 */
export async function startHelperLink(
  deps: HelperLinkDeps,
  options: Omit<HelperSocketOptions, "accept" | "clock"> & { signal?: AbortSignal } = {},
): Promise<{ port: number; link: HelperLink; close(): Promise<void> }> {
  const { signal, ...socket } = options;
  const link = createHelperLink(deps);
  const server: HelperServer = await startHelperSocket({ ...socket, clock: deps.clock, accept: link.accept });
  const close = async () => {
    link.close();
    await server.close();
  };
  if (signal?.aborted) await close();
  else signal?.addEventListener("abort", () => void close(), { once: true });
  return { port: server.port, link, close };
}
