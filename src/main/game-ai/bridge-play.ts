/**
 * The Play bridge: how a published game's page in desktop Play reaches play-time AI. The Play
 * view's preload (`preload/play-mic.ts`, page half `preload/play-ai-page.ts`) carries numbered
 * envelopes (`shared/play-ai.ts`) on the view's own IPC; `play/viewer-view.ts` hands each to
 * {@link playAiPort}, which decides on every message, from where it came and never from what it
 * says, which game is calling:
 *  - only the page's top frame, on the very origin the viewer opened for the game on screen
 *    ({@link playCallerFor}); the game's key is `play:<genex.games project id>`, never the slug;
 *  - at most `PLAY_AI_BURST` envelopes a window, `PLAY_AI_MAX_PENDING` unanswered, one call per ticket;
 *  - a grant or a Genex confirm only inside a person's gesture: the page's isolated world saw an
 *    activation and main saw a click or a key reach the page just before;
 *  - an answer only to the page that asked: a navigation abandons the page's calls and cards.
 *
 * {@link createGameAiPlayBridge} answers the envelopes: the AI ops through `GameAiService`, and the
 * embed-sdk 0.34 desktop confirm (D3) by drawing Genex's card with genex.games' own terms and
 * approving there only after the person's yes. Popups stay denied (`viewer-view.ts`).
 * Electron-free.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  AiBridgeOp,
  AiErrorCode,
  type AiGameKey,
  GAME_AI_WIRE_VERSION,
  playGameKey,
  readAiGameKey,
  refusedAnswer,
} from "../../shared/game-ai.ts";
import { AiContext } from "../../shared/game-ai-route.ts";
import { AI_CONSENT_TTL_MS, AiConsentKind, type AiConsentTicket } from "../../shared/game-ai-views.ts";
import {
  type GenexDesktopConfirmAnswer,
  type GenexDesktopConfirmRequest,
  readGenexConfirmAnswer,
} from "../../shared/genex-desktop-bridge.ts";
import {
  PLAY_AI_BURST,
  PLAY_AI_MAX_PENDING,
  PLAY_AI_WINDOW_MS,
  type PlayAiDelta,
  type PlayAiEnvelope,
  type PlayAiReply,
  PlayBridgeOp,
  readPlayAiEnvelope,
} from "../../shared/play-ai.ts";
import {
  type GameAiCaller,
  type GameAiClock,
  type GameAiConsents,
  GameAiNativeStep,
  type GameAiPlayBridge,
  type GameAiService,
  type GenexAiPlatform,
} from "./types.ts";

/**
 * How long after a click or a key a page's ask still counts as the person's: Chromium's transient
 * user activation, which the page's isolated world checks too.
 */
export const PLAY_AI_GESTURE_MS = 5 * SECOND_MS;

/** The inputs that give a page a person's activation (as Chromium grants it); a held Esc and pointer moves do not. */
const GESTURE_INPUTS: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "pointerDown",
  "pointerUp",
  "touchEnd",
  "gestureTap",
]);
/** Keys that never activate a page. */
const INERT_KEYS: ReadonlySet<string> = new Set(["Escape", "Esc"]);
/** Ops answered even past the pending cap: they only ever let go of something. */
const ALWAYS_HEARD: ReadonlySet<string> = new Set([AiBridgeOp.Cancel, AiBridgeOp.BudgetStop]);

/** The Play game the viewer has open, as its AI bridge attributes a page's messages to it. */
export interface PlayAiGame {
  /** genex.games' project id: the game's key is `play:<projectId>`. */
  projectId: string;
  /** The game's name, for its cards. */
  title: string;
  /** The address the viewer opened the game at: its origin is the game's (a fixture's stand-in page: the address itself). */
  address: string;
}

/** The parts of an address its origin is compared by: scheme, host and port, and no user. */
function originOf(raw: string): { protocol: string; host: string } | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

/** Whether a frame at `frameUrl` shows the game the viewer opened at `address`. */
function onGamePage(address: string, frameUrl: string): boolean {
  // A fixture launch's stand-in page is an inline document: it is the game only at its very address.
  if (address.startsWith("data:")) return frameUrl === address;
  const game = originOf(address);
  const frame = originOf(frameUrl);
  if (game?.protocol !== "https:" || !frame) return false;
  return frame.protocol === game.protocol && frame.host === game.host;
}

/**
 * Who is calling: the game on screen, when the sending top frame is on the origin the viewer opened
 * it at; else null. A page that moved to another game's or another slug's address is no one.
 */
export function playCallerFor(game: PlayAiGame | null, frameUrl: string, channel: string): GameAiCaller | null {
  if (!game || !onGamePage(game.address, frameUrl)) return null;
  const key = readAiGameKey(playGameKey(game.projectId));
  if (!key) return null;
  return { game: key, title: game.title, context: AiContext.DesktopPlay, ownGame: false, replaying: false, channel };
}

/** The answer to an envelope that was refused before anything ran: the op's own shape, saying `code`. */
export function playAiRefusal(envelope: PlayAiEnvelope, code: AiErrorCode): PlayAiReply {
  const { id } = envelope;
  switch (envelope.op) {
    case PlayBridgeOp.Hello:
      return { id, op: envelope.op, body: { v: GAME_AI_WIRE_VERSION, on: false } };
    case PlayBridgeOp.Doors:
      return { id, op: envelope.op, body: { on: false, door: null } };
    case PlayBridgeOp.Call:
      return { id, op: envelope.op, body: refusedAnswer(envelope.body.ticket, code) };
    case PlayBridgeOp.Cancel:
      return { id, op: envelope.op, body: { canceled: false } };
    case PlayBridgeOp.BudgetActive:
    case PlayBridgeOp.BudgetRequest:
      return { id, op: envelope.op, body: { view: null, code } };
    case PlayBridgeOp.BudgetStop:
      return { id, op: envelope.op, body: { stopped: false } };
    case PlayBridgeOp.GenexConfirm:
      return { id, op: envelope.op, body: { approved: false } };
  }
}

/** Run one envelope on the bridge, keeping its op beside its answer. */
async function answerEnvelope(
  bridge: GameAiPlayBridge,
  caller: GameAiCaller,
  envelope: PlayAiEnvelope,
  onDelta: (text: string) => void,
): Promise<PlayAiReply> {
  const { id } = envelope;
  switch (envelope.op) {
    case PlayBridgeOp.GenexConfirm:
      return { id, op: envelope.op, body: await bridge.confirm(caller, envelope.body) };
    case PlayBridgeOp.Hello:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
    case PlayBridgeOp.Doors:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
    case PlayBridgeOp.Call:
      return {
        id,
        op: envelope.op,
        body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }, onDelta),
      };
    case PlayBridgeOp.Cancel:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
    case PlayBridgeOp.BudgetActive:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
    case PlayBridgeOp.BudgetRequest:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
    case PlayBridgeOp.BudgetStop:
      return { id, op: envelope.op, body: await bridge.handle(caller, { op: envelope.op, body: envelope.body }) };
  }
}

/** The ticket of a call: what names its streamed text and its cancel on the page. */
const callTicket = (envelope: PlayAiEnvelope): string | null =>
  envelope.op === PlayBridgeOp.Call ? envelope.body.ticket : null;

/** Whether an op spends only inside a person's gesture. */
const needsGesture = (envelope: PlayAiEnvelope): boolean =>
  envelope.op === PlayBridgeOp.BudgetRequest || envelope.op === PlayBridgeOp.GenexConfirm;

/** At most `limit` events per `windowMs` on `clock`; past them, false until the window turns. */
function burstLimiter(clock: GameAiClock, limit: number, windowMs: number): () => boolean {
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;
  return () => {
    const now = clock.now();
    // A clock that went backwards starts a new window too, never a longer one.
    if (now - windowStart >= windowMs || now < windowStart) {
      windowStart = now;
      used = 0;
    }
    used += 1;
    return used <= limit;
  };
}

/** What a Play game view's AI port runs on. */
export interface PlayAiPortDeps {
  /** The Play bridge; null in a studio composed without play-time AI, where every op answers off. */
  bridge: GameAiPlayBridge | null;
  /** The game Play has open now, once its facts are read; null when there is none. */
  game(): Promise<PlayAiGame | null>;
  /** The address the view's top frame shows now. */
  pageUrl(): string;
  /**
   * Whether the view's top frame may go to `url` (`play/game-address.ts`): a link it may not is
   * sent to the browser instead, and the page stays.
   */
  navigable(url: string): boolean;
  /** The view is still the viewer's and not destroyed. */
  live(): boolean;
  /** The view's own id (`webContents.id`): what the bridge abandons. */
  channel: string;
  send: { reply(reply: PlayAiReply): void; delta(delta: PlayAiDelta): void };
  clock: GameAiClock;
}

/** The frame an envelope came from, as Electron names it. */
export interface PlayAiFrame {
  url: string;
  /** The page's top frame, not a frame inside it. */
  top: boolean;
}

/** An input event that reached the page, as Electron's `input-event` reports it. */
export interface PlayAiInput {
  type: string;
  keyCode?: string;
}

/** One Play game view's AI port: what its page asks, what its person does, and where it goes. */
export function playAiPort(deps: PlayAiPortDeps) {
  const allow = burstLimiter(deps.clock, PLAY_AI_BURST, PLAY_AI_WINDOW_MS);
  /** Bumped when a new document commits (or the view goes): an answer for an earlier one is dropped. */
  let epoch = 0;
  /** A navigation started and has not committed: the page on screen is on its way out. */
  let leaving = false;
  let gone = false;
  let lastGesture = Number.NEGATIVE_INFINITY;
  /** The page's envelopes main has not answered yet, by number, each with its call's ticket. */
  const pending = new Map<number, string | null>();

  const current = (at: number): boolean => at === epoch && !gone && deps.live();
  const deliver = (at: number, reply: PlayAiReply): void => {
    if (current(at)) deps.send.reply(reply);
  };
  const gestured = (bit: unknown): boolean => bit === true && deps.clock.now() - lastGesture <= PLAY_AI_GESTURE_MS;

  /** Why an envelope from the game is answered without running, or null when it may run. */
  const refusal = (envelope: PlayAiEnvelope, gesture: unknown): AiErrorCode | null => {
    if (pending.size >= PLAY_AI_MAX_PENDING && !ALWAYS_HEARD.has(envelope.op)) return AiErrorCode.Concurrency;
    // Two calls under one ticket would share one stream and one cancel on the page.
    const ticket = callTicket(envelope);
    if (ticket !== null && [...pending.values()].includes(ticket)) return AiErrorCode.BadRequest;
    if (needsGesture(envelope) && !gestured(gesture)) return AiErrorCode.NoGesture;
    return null;
  };

  /** Run an accepted envelope and answer it, unless its page has gone meanwhile. */
  const run = async (at: number, caller: GameAiCaller, envelope: PlayAiEnvelope): Promise<void> => {
    const { bridge } = deps;
    if (!bridge) return deliver(at, playAiRefusal(envelope, AiErrorCode.Off));
    pending.set(envelope.id, callTicket(envelope));
    const onDelta = (text: string): void => {
      if (current(at) && pending.has(envelope.id)) deps.send.delta({ id: envelope.id, text });
    };
    let reply: PlayAiReply;
    try {
      reply = await answerEnvelope(bridge, caller, envelope, onDelta);
    } catch {
      reply = playAiRefusal(envelope, AiErrorCode.Provider);
    } finally {
      if (at === epoch) pending.delete(envelope.id);
    }
    // Still the page that asked, still on the game's origin.
    if (playCallerFor(await deps.game(), deps.pageUrl(), deps.channel)?.game !== caller.game) return;
    deliver(at, reply);
  };

  return {
    /** An envelope from the view's IPC, with the isolated world's word on the person's gesture. */
    async request(frame: PlayAiFrame, raw: unknown, gesture: unknown): Promise<void> {
      if (gone || leaving || !frame.top || !deps.live() || !allow()) return;
      const envelope = readPlayAiEnvelope(raw);
      if (!envelope) return;
      const at = epoch;
      const caller = playCallerFor(await deps.game(), frame.url, deps.channel);
      if (!caller || !current(at) || leaving || pending.has(envelope.id)) return;
      const refused = refusal(envelope, gesture);
      if (refused) return deliver(at, playAiRefusal(envelope, refused));
      await run(at, caller, envelope);
    },
    /** An input event reached the page: a click or a key is the person's gesture. */
    input(input: PlayAiInput): void {
      if (!GESTURE_INPUTS.has(input.type) || INERT_KEYS.has(input.keyCode ?? "")) return;
      lastGesture = deps.clock.now();
    },
    /**
     * The top frame started for another document at `url`: its calls abort and its cards close.
     * A link the viewer sends to the browser instead leaves the page, and its calls, as they are.
     */
    navigating(url: string): void {
      if (!deps.navigable(url)) return;
      leaving = true;
      deps.bridge?.abandon(deps.channel);
    },
    /** Another document committed: it starts with nothing pending and no gesture. */
    navigated(): void {
      epoch += 1;
      leaving = false;
      pending.clear();
      lastGesture = Number.NEGATIVE_INFINITY;
    },
    /** The navigation went nowhere (it failed, or the server answered no page): the page stays. */
    stayed(): void {
      leaving = false;
    },
    /** The view is gone. */
    gone(): void {
      if (gone) return;
      gone = true;
      epoch += 1;
      pending.clear();
      deps.bridge?.abandon(deps.channel);
    },
  };
}

/** A Play game view's AI port, as `playAiPort` makes it. */
export type PlayAiPort = ReturnType<typeof playAiPort>;

/** What the Play bridge runs on. */
export interface PlayBridgeDeps {
  service: Pick<GameAiService, "handle" | "abandon">;
  platform: Pick<GenexAiPlatform, "confirmTerms" | "answerConfirm" | "balanceCredits">;
  consents: Pick<GameAiConsents, "ask" | "close">;
  clock: GameAiClock;
  /** Throws where a native step may not run (a fixture profile): nothing is approved then. */
  assertNative(step: GameAiNativeStep): void;
  /** A fresh card ticket (`AI_ID_RE`). */
  newTicket(): string;
}

const NOT_APPROVED: GenexDesktopConfirmAnswer = { approved: false };

/** A confirm's terms as the card may show them: genex.games' grant of this game, for some credits. */
const usableTerms = (
  terms: { maxCredits: number; game: string } | null,
  caller: GameAiCaller,
): terms is { maxCredits: number; game: string } => {
  if (!terms || playGameKey(terms.game) !== caller.game) return false;
  return Number.isFinite(terms.maxCredits) && terms.maxCredits > 0;
};

/** The Play bridge: AI ops through the service, and the embed-sdk's desktop confirm as Genex's card. */
export function createGameAiPlayBridge(deps: PlayBridgeDeps): GameAiPlayBridge {
  /** One confirm per game at a time, with the page it came from; `left` once that page went away. */
  const confirming = new Map<AiGameKey, { channel: string; left: boolean }>();

  const card = async (caller: GameAiCaller, maxCredits: number): Promise<AiConsentTicket> => ({
    ticket: deps.newTicket(),
    game: caller.game,
    title: caller.title,
    kind: AiConsentKind.GenexConfirm,
    model: null,
    modelLabel: null,
    balanceCredits: await deps.platform.balanceCredits().catch(() => null),
    keepForBuildingPercent: null,
    localDownloadBytes: null,
    maxCredits,
    expiresAt: new Date(deps.clock.now() + AI_CONSENT_TTL_MS).toISOString(),
  });

  /** Read the terms, show the card, and answer on genex.games: approved only after the person's yes. */
  const ask = async (
    caller: GameAiCaller,
    request: GenexDesktopConfirmRequest,
    state: { left: boolean },
  ): Promise<GenexDesktopConfirmAnswer> => {
    const terms = await deps.platform.confirmTerms(request);
    if (!usableTerms(terms, caller) || state.left) return NOT_APPROVED;
    const ticket = await card(caller, terms.maxCredits);
    if (state.left) return NOT_APPROVED;
    const answer = await deps.consents.ask(caller, ticket);
    if (state.left) return NOT_APPROVED;
    if (answer.ticket !== ticket.ticket) return NOT_APPROVED;
    if (!answer.approve) {
      await deps.platform.answerConfirm(request, false).catch(() => NOT_APPROVED);
      return NOT_APPROVED;
    }
    deps.assertNative(GameAiNativeStep.ApprovePaid);
    return readGenexConfirmAnswer(await deps.platform.answerConfirm(request, true));
  };

  return {
    handle: (caller, message, onDelta) => deps.service.handle(caller, message, onDelta),
    async confirm(caller, request) {
      // One card per game: a second confirm while one waits is not the person's to answer twice.
      if (confirming.has(caller.game)) return NOT_APPROVED;
      const state = { channel: caller.channel, left: false };
      confirming.set(caller.game, state);
      try {
        return await ask(caller, request, state);
      } catch {
        return NOT_APPROVED;
      } finally {
        confirming.delete(caller.game);
      }
    },
    abandon(channel) {
      deps.service.abandon(channel);
      for (const [game, state] of confirming) {
        if (state.channel !== channel || state.left) continue;
        state.left = true;
        deps.consents.close(game);
      }
    },
  };
}
