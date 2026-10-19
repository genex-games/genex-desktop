/**
 * The Create Live route (owner decision D1): the one deliberate, default-off path from a game in
 * the preview back into the app. A game in the Live human preview asks play-time AI with a POST to
 * `<its own origin>/__genex/ai/v1/<op>` (`AI_ROUTE_PREFIX`), the op's body as JSON
 * (`readAiBridgeBody`), and gets the op's answer as one JSON body, or a `call` sent with
 * `stream: true` as server-sent events (`AiRouteEvent`).
 *
 * Everything below holds before play-time AI hears of a request; a refusal keeps nothing:
 *  - Only POST with `application/json` (UTF-8) is taken. OPTIONS is a 403 with no CORS headers, so
 *    no other origin can preflight it, and nothing here ever sends a CORS header.
 *  - `Origin` equals the request's own origin exactly (a missing or `null` one is refused), fetch
 *    metadata, when sent, says same-origin, and the request names the game the preview shows now.
 *  - The body is at most {@link ROUTE_MAX_BODY_BYTES}, counted as it streams in, and is JSON the
 *    op's reader takes.
 *  - A page sends at most `PLAY_AI_BURST` requests a window and holds at most `PLAY_AI_MAX_PENDING`
 *    unanswered, as in Play.
 *  - The context comes from the preview's partition ({@link previewAiContext}): only the Live human
 *    partition reaches play-time AI. A facet, the stand-in and an offscreen window answer `ai_off`,
 *    and so does Live while a machine drives it ({@link createDriveWatch}: its budgets are suspended).
 *
 * The caller is derived here from the page (the project the preview shows, its partition, its
 * contents), never from the body. No Electron import: the preview hands its protocol requests here,
 * and tests drive it with plain `Request`s.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  AI_MAX_BODY_CHARS,
  AiBridgeOp,
  AiErrorCode,
  type AiGameKey,
  createGameKey,
  GAME_AI_WIRE_VERSION,
  readAiGameKey,
  refusedAnswer,
} from "../../shared/game-ai.ts";
import {
  type AiBridgeAnswers,
  type AiBridgeMessage,
  type AiRouteDelta,
  AiRouteEvent,
  type AiRouteRefusal,
  aiRouteOp,
  readAiBridgeBody,
} from "../../shared/game-ai-bridge.ts";
import { AiContext } from "../../shared/game-ai-route.ts";
import { PLAY_AI_BURST, PLAY_AI_MAX_PENDING, PLAY_AI_WINDOW_MS } from "../../shared/play-ai.ts";
import { HttpStatus, LIVE_PREVIEW_PARTITION } from "../page-serve.ts";
import type { GameAiCaller, GameAiClock, GameAiService, GameAiSettingsStore } from "./types.ts";

/**
 * The most bytes one request body may carry: the characters a game's message may hold in all
 * (`AI_MAX_BODY_CHARS`), as bytes, counted before anything is parsed.
 */
export const ROUTE_MAX_BODY_BYTES = AI_MAX_BODY_CHARS;
/**
 * How long Live's budgets stay suspended after a machine last drove it (an input, a clock step, a
 * `__studio` call). A harness step is an input and a look a few seconds later; a spell this long
 * with none means no step is under way, so a game's timer cannot spend the person's grant between
 * an agent's moves.
 */
export const AI_DRIVE_QUIET_MS = 30 * SECOND_MS;

/** The one method the route takes. */
const ROUTE_METHOD = "POST";
const JSON_MEDIA_TYPE = "application/json";
const UTF8_CHARSET = "charset=utf-8";
const SAME_ORIGIN = "same-origin";

/** Every answer: never cached, never sniffed, and never a CORS header. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;
const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

/** What the route runs on: play-time AI's service and settings, and the library's word on a game. */
export interface CreateRouteHost {
  clock: GameAiClock;
  /** Settings → While you build: the Create Live switch (`createRouteEnabled`). */
  settings: Pick<GameAiSettingsStore, "view">;
  service: Pick<GameAiService, "handle" | "abandon">;
  /** A game the preview shows: its name as the library shows it, and whether it is the creator's own. */
  game(project: string): Promise<{ title: string; ownGame: boolean }>;
}

/** The page a request came from, as the preview knows it when the request arrives. */
export interface RoutePage {
  /** The project the request names: the `game:` host name, or the loopback port's game. */
  project: string;
  /** The project the preview shows now; null while it shows none or is stopped. */
  loaded: string | null;
  /** From the preview's partition ({@link previewAiContext}). */
  context: AiContext;
  /** A machine is driving the preview ({@link DriveWatch}). */
  driving: boolean;
  /** The preview's contents (`webContents.id`), for `abandon`. */
  channel: string;
}

/**
 * Where a preview's requests come from, by its session partition: the Live human preview is Create
 * Live; every other partition, and Live's own rendering offscreen, is an agent's (`ai_off`).
 */
export function previewAiContext(partition: string, offscreen: boolean): AiContext {
  return partition === LIVE_PREVIEW_PARTITION && !offscreen ? AiContext.CreateLive : AiContext.HarnessRun;
}

/** Whether the route is on (D1, off by default). A store that cannot be read is off. */
export async function createRouteEnabled(host: Pick<CreateRouteHost, "settings">): Promise<boolean> {
  try {
    return (await host.settings.view()).createRouteEnabled === true;
  } catch {
    return false;
  }
}

// ── a machine driving the preview ──────────────────────────────────────────────────────────

/** Whether a machine is driving a preview now, or drove it within {@link AI_DRIVE_QUIET_MS}. */
export interface DriveWatch {
  /** A drive starts; `started` when the preview was not already suspended. Call `end` once it is over. */
  begin(): { started: boolean; end(): void };
  driving(): boolean;
}

/** One preview's drive watch, on main's clock. */
export function createDriveWatch(clock: GameAiClock): DriveWatch {
  let active = 0;
  let lastAt: number | null = null;
  const driving = (): boolean => {
    if (active > 0) return true;
    if (lastAt === null) return false;
    const now = clock.now();
    // A clock that went backwards counts as just driven, and the spell runs from the new time.
    if (now < lastAt) lastAt = now;
    return now - lastAt < AI_DRIVE_QUIET_MS;
  };
  return {
    begin() {
      const started = !driving();
      active += 1;
      let ended = false;
      return {
        started,
        end() {
          if (ended) return;
          ended = true;
          active -= 1;
          lastAt = clock.now();
        },
      };
    },
    driving,
  };
}

// ── a page's burst and its unanswered requests ─────────────────────────────────────────────

/** One page's bounds: a burst window and the requests it holds unanswered. */
export interface RouteGate {
  /** Count one request; false when the page is past its burst. */
  admit(): boolean;
  /** Hold one unanswered request, with its release; null when the page holds the most it may. */
  hold(): (() => void) | null;
}

/** One preview's gate, on main's clock. */
export function createRouteGate(clock: GameAiClock): RouteGate {
  const recent: number[] = [];
  let pending = 0;
  return {
    admit() {
      const now = clock.now();
      const inWindow = recent.filter((at) => at <= now && now - at < PLAY_AI_WINDOW_MS);
      recent.splice(0, recent.length, ...inWindow);
      if (recent.length >= PLAY_AI_BURST) return false;
      recent.push(now);
      return true;
    },
    hold() {
      if (pending >= PLAY_AI_MAX_PENDING) return null;
      pending += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending -= 1;
      };
    },
  };
}

// ── answers ────────────────────────────────────────────────────────────────────────────────

type CallMessage = Extract<AiBridgeMessage, { op: typeof AiBridgeOp.Call }>;
type AnyAnswer = AiBridgeAnswers[AiBridgeOp];

function json(
  body: AnyAnswer | AiRouteRefusal,
  status: HttpStatus = HttpStatus.Ok,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** A refusal before play-time AI heard of the request. */
function refusal(status: HttpStatus, code: AiErrorCode, extra: Record<string, string> = {}): Response {
  return json({ v: GAME_AI_WIRE_VERSION, code }, status, extra);
}

/** What a message answers where AI is off: a facet, an offscreen window, a driven Live. */
export function offAnswer(message: AiBridgeMessage): AnyAnswer {
  switch (message.op) {
    case AiBridgeOp.Hello:
      return { v: GAME_AI_WIRE_VERSION, on: false };
    case AiBridgeOp.Doors:
      return { on: false, door: null };
    case AiBridgeOp.Call:
      return refusedAnswer(message.body.ticket, AiErrorCode.Off);
    case AiBridgeOp.Cancel:
      return { canceled: false };
    case AiBridgeOp.BudgetActive:
    case AiBridgeOp.BudgetRequest:
      return { view: null, code: AiErrorCode.Off };
    case AiBridgeOp.BudgetStop:
      return { stopped: false };
  }
}

/** A message whose page already holds the most unanswered: a call answers as Play's would. */
function busy(message: AiBridgeMessage): Response {
  if (message.op === AiBridgeOp.Call) return json(refusedAnswer(message.body.ticket, AiErrorCode.Concurrency));
  return refusal(HttpStatus.TooManyRequests, AiErrorCode.Concurrency);
}

/** Main failed to answer: a call gets a typed refusal the game can fall back from; anything else a 500. */
function failed(message: AiBridgeMessage): Response {
  if (message.op === AiBridgeOp.Call) return json(refusedAnswer(message.body.ticket, AiErrorCode.Provider));
  return refusal(HttpStatus.InternalError, AiErrorCode.Provider);
}

// ── the request ────────────────────────────────────────────────────────────────────────────

/** The request's own origin, as a browser spells it in `Origin`. */
const originOf = (url: URL): string => `${url.protocol}//${url.host}`;

/** Sent from the page's own origin: `Origin` exactly, and fetch metadata, when present, agreeing. */
function sameOrigin(request: Request, url: URL): boolean {
  if (request.headers.get("origin") !== originOf(url)) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === SAME_ORIGIN;
}

/** `application/json`, with no parameter but a UTF-8 charset. */
function isJsonBody(contentType: string | null): boolean {
  if (contentType === null) return false;
  const [media, ...parameters] = contentType.split(";").map((part) => part.trim().toLowerCase());
  return media === JSON_MEDIA_TYPE && parameters.every((parameter) => parameter === UTF8_CHARSET);
}

type BodyRead = { ok: true; text: string } | { ok: false; status: HttpStatus; code: AiErrorCode };

const tooLarge: BodyRead = { ok: false, status: HttpStatus.PayloadTooLarge, code: AiErrorCode.TooLarge };
const unreadable: BodyRead = { ok: false, status: HttpStatus.BadRequest, code: AiErrorCode.BadRequest };

/** A declared length past the cap is refused before a byte is read; a malformed one reads as none. */
function declaredTooLarge(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  return Number.isFinite(declared) && declared > ROUTE_MAX_BODY_BYTES;
}

/** The chunks of a body, stopped as soon as they pass the cap. */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array[] | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    total += value.byteLength;
    if (total > ROUTE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

/** The body as UTF-8 text, at most {@link ROUTE_MAX_BODY_BYTES} of it. */
async function readBody(request: Request): Promise<BodyRead> {
  if (declaredTooLarge(request)) return tooLarge;
  if (!request.body) return unreadable;
  try {
    const chunks = await readCapped(request.body);
    if (!chunks) return tooLarge;
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return unreadable;
  }
}

/** The op's message from the body's text, or null. */
function messageOf(op: AiBridgeOp, text: string): AiBridgeMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return readAiBridgeBody(op, raw);
}

/** The request's head, read: the op it names and the game it is from, or its refusal. */
type Head = { ok: true; op: AiBridgeOp; game: AiGameKey } | { ok: false; refused: Response };

/** Why the request's head is refused, or the op and game it names. */
function readHead(request: Request, url: URL, page: RoutePage): Head {
  const refuse = (refused: Response): Head => ({ ok: false, refused });
  if (request.method === "OPTIONS") return refuse(refusal(HttpStatus.Forbidden, AiErrorCode.BadRequest));
  if (request.method !== ROUTE_METHOD) {
    return refuse(new Response(null, { status: HttpStatus.MethodNotAllowed, headers: { allow: ROUTE_METHOD } }));
  }
  const op = aiRouteOp(url.pathname);
  if (!op) return refuse(refusal(HttpStatus.NotFound, AiErrorCode.BadRequest));
  const shown = page.loaded !== null && page.loaded === page.project;
  const game = readAiGameKey(createGameKey(page.project));
  if (!sameOrigin(request, url) || !shown || !game)
    return refuse(refusal(HttpStatus.Forbidden, AiErrorCode.BadRequest));
  if (!isJsonBody(request.headers.get("content-type"))) {
    return refuse(refusal(HttpStatus.UnsupportedMediaType, AiErrorCode.BadRequest));
  }
  return { ok: true, op, game };
}

/**
 * Answer one request to the Create Live route from `page`. Refusals come first and keep nothing;
 * then the context decides: Live (not driven) reaches play-time AI, everywhere else answers off.
 */
export async function answerCreateRoute(
  request: Request,
  page: RoutePage,
  host: CreateRouteHost,
  gate: RouteGate,
): Promise<Response> {
  const head = readHead(request, new URL(request.url), page);
  if (!head.ok) return head.refused;
  const { op, game } = head;
  if (!gate.admit()) return refusal(HttpStatus.TooManyRequests, AiErrorCode.RateLimited);
  const body = await readBody(request);
  if (!body.ok) return refusal(body.status, body.code);
  const message = messageOf(op, body.text);
  if (!message) return refusal(HttpStatus.BadRequest, AiErrorCode.BadRequest);
  return answerMessage(message, page, host, gate, game);
}

/** Whether play-time AI hears this message: Live, and not driven (a cancel is always heard there). */
function reachesService(message: AiBridgeMessage, page: RoutePage): boolean {
  if (page.context !== AiContext.CreateLive) return false;
  return !page.driving || message.op === AiBridgeOp.Cancel;
}

async function answerMessage(
  message: AiBridgeMessage,
  page: RoutePage,
  host: CreateRouteHost,
  gate: RouteGate,
  game: AiGameKey,
): Promise<Response> {
  if (!reachesService(message, page)) return json(offAnswer(message));
  // A cancel frees a held request; it never waits behind them.
  const release = message.op === AiBridgeOp.Cancel ? () => {} : gate.hold();
  if (!release) return busy(message);
  let caller: GameAiCaller;
  try {
    caller = await callerOf(page, host, game);
  } catch {
    release();
    return failed(message);
  }
  if (message.op === AiBridgeOp.Call && message.body.stream) return streamCall(caller, message, host, release);
  try {
    return json(await host.service.handle(caller, message));
  } catch {
    return failed(message);
  } finally {
    release();
  }
}

/** The caller main derives for a page in the Live human preview. */
async function callerOf(page: RoutePage, host: CreateRouteHost, game: AiGameKey): Promise<GameAiCaller> {
  const { title, ownGame } = await host.game(page.project);
  return { game, title, context: AiContext.CreateLive, ownGame, replaying: false, channel: page.channel };
}

const encoder = new TextEncoder();

/** One server-sent event. The data is JSON, so it never holds a raw line break. */
const sseFrame = (event: AiRouteEvent, data: AiRouteDelta | AnyAnswer): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A streamed call: its text so far as `delta` events, then one `reply`, then the end. A page that
 * drops the stream cancels the call.
 */
function streamCall(caller: GameAiCaller, message: CallMessage, host: CreateRouteHost, release: () => void): Response {
  const ticket = message.body.ticket;
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AiRouteEvent, data: AiRouteDelta | AnyAnswer): void => {
        if (!open) return;
        try {
          controller.enqueue(sseFrame(event, data));
        } catch {
          open = false;
        }
      };
      const finish = (): void => {
        release();
        if (!open) return;
        open = false;
        controller.close();
      };
      host.service
        .handle(caller, message, (text) => send(AiRouteEvent.Delta, { text }))
        .then(
          (answer) => send(AiRouteEvent.Reply, answer),
          () => send(AiRouteEvent.Reply, refusedAnswer(ticket, AiErrorCode.Provider)),
        )
        .finally(finish);
    },
    cancel() {
      if (!open) return;
      open = false;
      host.service.handle(caller, { op: AiBridgeOp.Cancel, body: { ticket } }).catch(() => {});
    },
  });
  return new Response(body, { status: HttpStatus.Ok, headers: STREAM_HEADERS });
}
