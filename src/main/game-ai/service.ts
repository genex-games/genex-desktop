/**
 * `GameAiService`: every in-game AI call on this Mac, from a caller main derived, through one
 * tested order — read → route → reserve → queue → door → validate → settle.
 *
 *  - Admission refusals have no side effect: a bad schema, a duplicate ticket, AI off, no grant, a
 *    door that is not legal here, not ready or too small all answer before anything is reserved.
 *  - A game with no grant starts silently only on a free model that is ready (routing's rule);
 *    every other first use waits for the person's yes on a trusted card (`requestGrant`, `pick`).
 *  - The worst case is reserved and on disk before dispatch; the queue puts builds first; a door
 *    answers text, which is held to the game's shape with one repair. A reply the game could not use
 *    costs nothing, and neither does the repair (D7). Text other players will see is moderated
 *    before it is answered (D6).
 *  - Each settled call is a ledger line with no text. Stop and a payer change abort in-flight calls
 *    at once; a page that goes away abandons its calls and closes its cards.
 *
 * Genex picks a game's model in the v3 order: the model the game last used, the maker's pick if
 * the person has it, their best model that fits (free, then plan, then paid), then Genex credits;
 * a card asks once, before a game uses the person's plan or money.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  AiBridgeOp,
  type AiBudgetView,
  type AiCallAnswer,
  type AiCallRequest,
  AiConsent,
  AiDoor,
  AiErrorCode,
  AiFunding,
  type AiGameKey,
  AiGameKind,
  type AiGrantRequest,
  AiGrantStatus,
  type AiModelRef,
  type AiProvenance,
  AiRequirement,
  AiAuthority,
  creditsOfMicros,
  fundingOf,
  GAME_AI_WIRE_VERSION,
  isPlatformDoor,
  needsConsent,
  refusedAnswer,
} from "../../shared/game-ai.ts";
import type { AiBridgeAnswers, AiBridgeMessage, AiGrantAnswer } from "../../shared/game-ai-bridge.ts";
import {
  AiContext,
  type AiChoice,
  isLegalDoor,
  routeCall,
  type RouteDecision,
  type RouteInput,
} from "../../shared/game-ai-route.ts";
import { checkSchema, parseOutput } from "../../shared/game-ai-schema.ts";
import {
  AI_LOW_CREDITS,
  type AiActivity,
  type AiConsentAnswer,
  AiConsentKind,
  type AiConsentResult,
  type AiMenuRow,
  type AiModelMenu,
  AiModelTag,
  AiPickPolicy,
  type AiPickResult,
  type AiStopCard,
  AiStopReason,
  GameAiNoticeKind,
} from "../../shared/game-ai-views.ts";
import { type PlayAiBar, PlayAiNote, PlayAiPhase } from "../../shared/play-bar.ts";
import { CompletePurpose } from "../../substrate/engines/types.ts";
import { consentTicket, type ConsentCardFacts } from "./approvals.ts";
import type { GameAiSettings } from "./budgets.ts";
import { MESSAGE as PROMPTS, promptTokensOf } from "./game-ai-prompts.ts";
import { failureOf } from "./refusal.ts";
import type {
  AiDoorAnswer,
  AiGrantRecord,
  AiHold,
  GameAiCaller,
  GameAiDeps,
  GameAiDoorImpl,
  GameAiGrants,
  GameAiIpcHost,
  GameAiLedger,
  GameAiModelCheck,
  GameAiReports,
  GameAiService,
  GameAiTapes,
  GenexAiPlatform,
} from "./types.ts";

/** The one repair a reply that does not fit the game's shape gets. */
const REPAIR_ATTEMPTS = 1;
/** How long a game's model menu is kept between calls. */
const MENU_TTL_MS = 5 * SECOND_MS;
/** A stop card of one reason shows once in this long per game. */
const STOP_CARD_QUIET_MS = MINUTE_MS;
/** The channel a pick from a menu speaks on: no page, so abandon never closes its card. */
const MENU_CHANNEL = "menu";

const MESSAGE = {
  unavailable: "that model can't be used for this game here",
  checkoutElsewhere: "checkout opens only on genex.games",
} as const;

/** The model a replayed call names. */
const TAPE_MODEL: AiModelRef = { door: AiDoor.Tape, engine: "tape", model: "tape" };

/** What the service runs on: the contract's deps, with Settings' own store (its local values are read per call). */
export type GameAiServiceDeps = Omit<GameAiDeps, "settings"> & { settings: GameAiSettings };

/** A model Genex picked for a game, with the row the menu shows for it. */
export interface AiPick {
  model: AiModelRef;
  row: AiMenuRow;
}

/** How Genex orders what fits, best first: free, then the plan, then the person's key, then credits. */
const FUNDING_ORDER = {
  [AiFunding.Free]: 0,
  [AiFunding.Plan]: 1,
  [AiFunding.Key]: 2,
  [AiFunding.Credits]: 3,
  [AiFunding.Playtest]: 4,
} as const satisfies Record<AiFunding, number>;

/** The card a first use of each way of paying shows. */
const CARD_OF_FUNDING = {
  [AiFunding.Plan]: AiConsentKind.Plan,
  [AiFunding.Key]: AiConsentKind.Key,
  [AiFunding.Credits]: AiConsentKind.Credits,
} as const;

const sameModel = (a: AiModelRef, b: AiModelRef): boolean =>
  a.door === b.door && a.engine === b.engine && a.model === b.model;

/** Every row a menu offers (its groups; never the folded "may struggle" ones). */
const menuRows = (menu: AiModelMenu): AiMenuRow[] => menu.groups.flatMap((group) => group.rows);

/** The menu's row for a model it offers ready now, or null: what a pick or a Change may choose. */
export function menuOffers(menu: AiModelMenu, model: AiModelRef): AiMenuRow | null {
  return menuRows(menu).find((row) => row.ready && sameModel(row.model, model)) ?? creditsRow(menu, model);
}

/** The Genex group's row: the maker's pick on the person's credits, when they are signed in. */
function creditsRow(menu: AiModelMenu, model?: AiModelRef): AiMenuRow | null {
  const { recommended, signedIn, recommendedLabel } = menu.genex;
  if (!signedIn || !recommended || (model && !sameModel(model, recommended))) return null;
  const label = recommendedLabel ?? recommended.model;
  return {
    model: recommended,
    label,
    shortLabel: label,
    funding: AiFunding.Credits,
    tag: null,
    fit: null,
    ready: true,
  };
}

/** Whether a row may be used in a context: a host door legal there, or Genex credits in Play. */
const usableIn = (context: AiContext, row: AiMenuRow): boolean =>
  isLegalDoor(context, row.model.door) || (isPlatformDoor(row.model.door) && context === AiContext.DesktopPlay);

/**
 * The model Genex picks for a game (§14): the model it last used, the maker's pick if the person has
 * it, their best model that fits (free, then plan, then paid), then Genex credits. Only ready rows
 * usable here; under Free only, nothing that spends.
 */
export function pickModel(menu: AiModelMenu, policy: AiPickPolicy, context: AiContext): AiPick | null {
  const freeOnly = policy === AiPickPolicy.FreeOnly;
  const credits = creditsRow(menu);
  const rows = [...menuRows(menu), ...(credits ? [credits] : [])].filter(
    (row) => row.ready && usableIn(context, row) && (!freeOnly || row.funding === AiFunding.Free),
  );
  const last = menu.current ? rows.find((row) => menu.current && sameModel(row.model, menu.current)) : undefined;
  const best = rows.find((row) => row.tag === AiModelTag.Best);
  const fits = [...rows].sort((a, b) => FUNDING_ORDER[a.funding] - FUNDING_ORDER[b.funding])[0];
  const row = last ?? best ?? fits;
  return row ? { model: row.model, row } : null;
}

/** Whether a door's answers may be kept: a replay answers by occurrence and a fixture is instant, so neither is. */
const keepsAnswers = (door: AiDoor): boolean => door !== AiDoor.Tape && door !== AiDoor.Fixture;

/** A refusal for a ticket. */
const refused = (ticket: string, code: AiErrorCode, retryAfterMs: number | null = null): AiCallAnswer =>
  refusedAnswer(ticket, code, retryAfterMs);

/** One call running: its game, the page or process it came from, and how to stop it. */
interface Flight {
  game: AiGameKey;
  channel: string;
  controller: AbortController;
}

/** A call admitted: everything dispatch needs, decided before anything was reserved. */
interface Admitted {
  route: Extract<RouteDecision, { ok: true }>;
  door: GameAiDoorImpl;
  grant: AiGrantRecord | null;
  model: AiModelRef;
  /** The silent start this call makes, done only once it is admitted. */
  silent: AiPick | null;
  requires: AiRequirement;
}

/** The service over its deps. */
export function createGameAiService(deps: GameAiServiceDeps): GameAiServiceImpl {
  return new GameAiServiceImpl(deps);
}

/** The service: `GameAiService` plus the pill's pick, which the IPC host calls. */
export class GameAiServiceImpl implements GameAiService {
  readonly #deps: GameAiServiceDeps;
  readonly #flights = new Map<string, Flight>();
  readonly #menus = new Map<AiGameKey, { at: number; menu: AiModelMenu | null }>();
  /** Leaderboard games the person chose to play unranked, this session. */
  readonly #unranked = new Set<AiGameKey>();
  /** When each (game, reason) stop card last showed. */
  readonly #stops = new Map<string, number>();
  /** The games each page or process asked about, for abandon. */
  readonly #channels = new Map<string, Set<AiGameKey>>();
  /** The game titles callers named, for cards. */
  readonly #titles = new Map<AiGameKey, string>();

  constructor(deps: GameAiServiceDeps) {
    this.#deps = deps;
  }

  handle<M extends AiBridgeMessage>(
    caller: GameAiCaller,
    message: M,
    onDelta?: (text: string) => void,
  ): Promise<AiBridgeAnswers[M["op"]]>;
  handle(
    caller: GameAiCaller,
    message: AiBridgeMessage,
    onDelta?: (text: string) => void,
  ): Promise<AiBridgeAnswers[AiBridgeOp]> {
    this.#seen(caller);
    return this.#answer(caller, message, onDelta);
  }

  /** One message's answer, by its op. */
  async #answer(
    caller: GameAiCaller,
    message: AiBridgeMessage,
    onDelta?: (text: string) => void,
  ): Promise<AiBridgeAnswers[AiBridgeOp]> {
    const { grants } = this.#deps;
    switch (message.op) {
      case AiBridgeOp.Hello:
        return { v: GAME_AI_WIRE_VERSION, on: !grants.isOff(caller.game) };
      case AiBridgeOp.Doors: {
        const on = !grants.isOff(caller.game);
        return { on, door: on ? (grants.live(caller.game)?.door ?? null) : null };
      }
      case AiBridgeOp.Call:
        return this.#call(caller, message.body, onDelta);
      case AiBridgeOp.Cancel:
        return { canceled: this.#cancel(caller, message.body.ticket) };
      case AiBridgeOp.BudgetActive:
        return this.#active(caller.game);
      case AiBridgeOp.BudgetRequest:
        return this.requestGrant(caller, message.body);
      case AiBridgeOp.BudgetStop:
        await this.stop(caller.game);
        return { stopped: true };
    }
  }

  // ── a call ─────────────────────────────────────────────────────────────────────────────────

  async #call(caller: GameAiCaller, request: AiCallRequest, onDelta?: (text: string) => void): Promise<AiCallAnswer> {
    // A ticket names one call at a time: a second while the first runs is refused before anything else.
    if (this.#flights.has(request.ticket)) return refused(request.ticket, AiErrorCode.BadRequest);
    // Registered from the first check, so Stop or a page going away aborts a call still being admitted.
    const controller = new AbortController();
    this.#flights.set(request.ticket, { game: caller.game, channel: caller.channel, controller });
    try {
      return await this.#admitted(caller, request, controller.signal, onDelta);
    } finally {
      this.#flights.delete(request.ticket);
    }
  }

  async #admitted(
    caller: GameAiCaller,
    request: AiCallRequest,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<AiCallAnswer> {
    const admitted = await this.#admit(caller, request);
    if ("ok" in admitted) return admitted;
    if (signal.aborted) return refused(request.ticket, AiErrorCode.Canceled);
    const cached = keepsAnswers(admitted.route.door) ? await this.#deps.cache.get(caller.game, request) : null;
    // A kept answer only from the door this call routes to: never another door's provenance.
    if (cached?.ok && cached.source === admitted.route.door && !admitted.silent) return cached;
    const grant = admitted.silent ? await this.#silentStart(caller, admitted) : admitted.grant;
    const worst = admitted.door.worstCaseMicros(request, admitted.model);
    const hold = grant && admitted.route.door !== AiDoor.Tape ? await this.#deps.grants.reserve(grant, worst) : null;
    if (hold && !hold.ok) {
      this.#refusedAfter(caller, hold.code, hold.retryAfterMs);
      return refused(request.ticket, hold.code, hold.retryAfterMs);
    }
    return this.#fly(caller, request, { ...admitted, grant }, { hold: hold?.hold ?? null, signal }, onDelta);
  }

  /** Everything a call is checked against before anything is reserved; a refusal changes nothing. */
  async #admit(caller: GameAiCaller, request: AiCallRequest): Promise<Admitted | AiCallAnswer> {
    if (request.schema !== null && checkSchema(request.schema) !== null) {
      return refused(request.ticket, AiErrorCode.InvalidSchema);
    }
    const grant = this.#deps.grants.live(caller.game);
    const menu = await this.#menu(caller.game);
    const pick = grant || !menu ? null : pickModel(menu, this.#deps.settings.local().pick, caller.context);
    const route = routeCall(await this.#routeInput(caller, request, grant, menu, pick));
    if (!route.ok) {
      this.#refusedAfter(caller, route.code, null);
      return refused(request.ticket, route.code);
    }
    const routed = this.#deps.doors.get(route.door);
    const model = route.door === AiDoor.Tape ? TAPE_MODEL : (grant?.model ?? pick?.model);
    if (!routed || !model) return refused(request.ticket, AiErrorCode.DoorUnavailable);
    const requires = menu?.requires ?? grant?.requires ?? AiRequirement.Optional;
    return { route, door: routed, grant, model, silent: route.start === AiConsent.Silent ? pick : null, requires };
  }

  /** What routing reads for one call: the grant or Genex's pick, and the readiness of the one door either names. */
  async #routeInput(
    caller: GameAiCaller,
    request: AiCallRequest,
    grant: AiGrantRecord | null,
    menu: AiModelMenu | null,
    pick: AiPick | null,
  ): Promise<RouteInput> {
    const local = this.#deps.settings.local();
    const choice: AiChoice | null = pick ? { door: pick.model.door, free: pick.row.funding === AiFunding.Free } : null;
    const door = grant?.door ?? choice?.door ?? null;
    const impl = door ? this.#deps.doors.get(door) : undefined;
    return {
      context: caller.context,
      replaying: caller.replaying,
      aiOff: this.#deps.grants.isOff(caller.game),
      grant: grant ? { door: grant.door, status: grant.status } : null,
      choice,
      authority: request.authority,
      leaderboard: Boolean(menu?.leaderboard) && !this.#unranked.has(caller.game),
      needsJson: request.schema !== null,
      promptTokens: promptTokensOf(request),
      planUnlocked: local.allowPlan && caller.context === AiContext.CreateLive && caller.ownGame,
      doors: impl && !caller.replaying ? [await impl.readiness()] : [],
    };
  }

  /** Start a game on a free model with no tap: the grant, and the pill's 4-second note. */
  async #silentStart(caller: GameAiCaller, admitted: Admitted): Promise<AiGrantRecord> {
    const model = admitted.silent?.model ?? admitted.model;
    const grant = await this.#deps.grants.grant(caller.game, model, AiConsent.Silent, admitted.requires);
    this.#changed(caller.game, PlayAiNote.FirstUse);
    return grant;
  }

  /** Queue, dispatch and settle one admitted, reserved call; whatever happens, the slot and the hold close. */
  async #fly(
    caller: GameAiCaller,
    request: AiCallRequest,
    admitted: Admitted,
    running: { hold: AiHold | null; signal: AbortSignal },
    onDelta?: (text: string) => void,
  ): Promise<AiCallAnswer> {
    const { hold, signal } = running;
    this.#draw(caller.game, PlayAiPhase.Writing);
    const started = this.#deps.clock.now();
    try {
      const slot = await this.#deps.queue.acquire(admitted.route.door, caller.game, signal);
      if (!slot.ok) {
        await hold?.release();
        this.#refusedAfter(caller, slot.code, slot.retryAfterMs);
        return refused(request.ticket, slot.code, slot.retryAfterMs);
      }
      try {
        return await this.#dispatch(caller, request, admitted, hold, signal, started, onDelta);
      } finally {
        slot.release();
      }
    } catch (error) {
      const failure = failureOf(error);
      await hold?.settle(null);
      await this.#ledger(caller, request, admitted, { code: failure.code, repaired: false, answer: null, started });
      this.#refusedAfter(caller, failure.code, failure.retryAfterMs);
      return refused(request.ticket, failure.code, failure.retryAfterMs);
    } finally {
      this.#draw(caller.game, PlayAiPhase.Ready);
    }
  }

  /** Run the call on its door, held to the game's shape with one repair; settle what it cost. */
  async #dispatch(
    caller: GameAiCaller,
    request: AiCallRequest,
    admitted: Admitted,
    hold: AiHold | null,
    signal: AbortSignal,
    started: number,
    onDelta?: (text: string) => void,
  ): Promise<AiCallAnswer> {
    let repair: { previous: string; problem: string } | null = null;
    for (let attempt = 0; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      if (attempt > 0) hold?.countRepair();
      const answer = await admitted.door.run(
        { game: caller.game, request, model: admitted.model, purpose: CompletePurpose.Game, repair },
        signal,
        attempt === 0 ? onDelta : undefined,
      );
      const parsed = parseOutput(request.schema, answer.text);
      if (parsed.ok)
        return this.#settle(caller, request, admitted, hold, {
          answer,
          value: parsed.value,
          repaired: attempt > 0,
          started,
        });
      repair = { previous: answer.text, problem: PROMPTS.repair(parsed.problem, request.schema !== null) };
    }
    // D7: a reply still unusable after its repair costs nothing.
    await hold?.settle(null);
    await this.#ledger(caller, request, admitted, {
      code: AiErrorCode.InvalidOutput,
      repaired: true,
      answer: null,
      started,
    });
    return refused(request.ticket, AiErrorCode.InvalidOutput);
  }

  /** A usable answer: moderated if others will see it, charged (unless repaired: D7), logged, kept. */
  async #settle(
    caller: GameAiCaller,
    request: AiCallRequest,
    admitted: Admitted,
    hold: AiHold | null,
    result: { answer: AiDoorAnswer; value: unknown; repaired: boolean; started: number },
  ): Promise<AiCallAnswer> {
    const { answer, value, repaired, started } = result;
    if (request.authority === AiAuthority.Shared && !(await this.#passes(value))) {
      await hold?.settle(null);
      await this.#ledger(caller, request, admitted, { code: AiErrorCode.Moderated, repaired, answer: null, started });
      return refused(request.ticket, AiErrorCode.Moderated);
    }
    const charged = repaired ? null : { usage: answer.usage, costMicros: answer.costMicros };
    await hold?.settle(charged);
    await this.#ledger(caller, request, admitted, { code: null, repaired, answer, started });
    const reply: AiCallAnswer = {
      v: GAME_AI_WIRE_VERSION,
      ok: true,
      ticket: request.ticket,
      value,
      source: admitted.route.door,
      provenance: admitted.route.provenance,
      latencyMs: Math.max(0, this.#deps.clock.now() - started),
      cached: false,
    };
    if (keepsAnswers(admitted.route.door)) await this.#deps.cache.put(caller.game, request, reply);
    this.#afterSettle(caller);
    return reply;
  }

  /** D6: text other players will see passes moderation first; a classifier that fails refuses it. */
  async #passes(value: unknown): Promise<boolean> {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return this.#deps.moderate(text).catch(() => false);
  }

  /** The call's ledger line: ids, counts and money, never text. */
  async #ledger(
    caller: GameAiCaller,
    request: AiCallRequest,
    admitted: Admitted,
    outcome: { code: AiErrorCode | null; repaired: boolean; answer: AiDoorAnswer | null; started: number },
  ): Promise<void> {
    const now = this.#deps.clock.now();
    const charged = outcome.code === null && !outcome.repaired ? (outcome.answer?.costMicros ?? 0) : 0;
    const provenance: AiProvenance = admitted.route.provenance;
    await this.#deps.ledger
      .append({
        at: new Date(now).toISOString(),
        game: caller.game,
        grantId: admitted.grant?.id ?? null,
        site: request.site,
        door: admitted.route.door,
        model: outcome.answer?.model ?? admitted.model.model,
        provenance,
        code: outcome.code,
        repaired: outcome.repaired,
        usage: outcome.answer?.usage ?? null,
        costMicros: charged,
        latencyMs: Math.max(0, now - outcome.started),
      })
      .catch(() => undefined);
  }

  /** After a charge: a game paused at its daily alert shows its card. */
  #afterSettle(caller: GameAiCaller): void {
    const grant = this.#deps.grants.live(caller.game);
    if (grant?.status !== AiGrantStatus.Paused) return;
    this.#stopCard(caller.game, AiStopReason.DailyAlert, { spentCredits: creditsOfMicros(grant.todayMicros) });
  }

  /** The stop card a refusal shows, if any. */
  #refusedAfter(caller: GameAiCaller, code: AiErrorCode, retryAfterMs: number | null): void {
    const now = this.#deps.clock.now();
    if (code === AiErrorCode.WaitingForPlan) {
      const resetsAt = retryAfterMs === null ? null : new Date(now + retryAfterMs).toISOString();
      this.#stopCard(caller.game, AiStopReason.PlanResting, { resetsAt });
      return;
    }
    if (code === AiErrorCode.OutOfCredits) this.#stopCard(caller.game, AiStopReason.OutOfCredits, {});
    if (code === AiErrorCode.Paused) {
      const spent = creditsOfMicros(this.#deps.grants.live(caller.game)?.todayMicros ?? 0);
      this.#stopCard(caller.game, AiStopReason.DailyAlert, { spentCredits: spent });
    }
  }

  // ── grants, stops and pages ────────────────────────────────────────────────────────────────

  async requestGrant(caller: GameAiCaller, request: AiGrantRequest): Promise<AiGrantAnswer> {
    this.#seen(caller);
    const { grants } = this.#deps;
    if (grants.isOff(caller.game)) return { view: null, code: AiErrorCode.Off };
    const live = grants.live(caller.game);
    if (live) return { view: await this.#view(live), code: null };
    const menu = await this.#menu(caller.game);
    const pick = menu ? pickModel(menu, this.#deps.settings.local().pick, caller.context) : null;
    if (!menu || !pick) return this.#setUp(caller, request, menu);
    const leaderboard = menu.leaderboard && !this.#unranked.has(caller.game);
    const verified = pick.row.funding === AiFunding.Credits;
    if (leaderboard && !verified) return this.#ask(caller, request.requires, pick, AiConsentKind.Leaderboard, menu);
    const free = pick.row.funding === AiFunding.Free;
    if (!needsConsent(pick.model.door, free) || grants.consented(caller.game, pick.model.door)) {
      const consent = free ? AiConsent.Silent : AiConsent.Card;
      return this.#granted(caller.game, pick.model, consent, request.requires);
    }
    return this.#ask(caller, request.requires, pick, this.#cardKind(pick.row.funding), menu);
  }

  /** A pick in the pill's menu: use it now, or show the card a first use of its payer needs. */
  async pick(game: AiGameKey, model: AiModelRef): Promise<AiPickResult> {
    const menu = await this.#menu(game, true);
    const row = menu ? menuOffers(menu, model) : null;
    if (!menu || !row) throw new Error(MESSAGE.unavailable);
    const free = row.funding === AiFunding.Free;
    const requires = menu.requires;
    if (!needsConsent(model.door, free) || this.#deps.grants.consented(game, model.door)) {
      await this.#granted(game, model, AiConsent.Menu, requires);
      return { ok: true, model };
    }
    const caller = this.#menuCaller(game, menu);
    const ticket = consentTicket(
      this.#deps.clock,
      this.#facts(caller, { model, row }, this.#cardKind(row.funding), menu),
    );
    void this.#askFor(caller, ticket, requires, model).catch(() => undefined);
    return { ok: false, consent: ticket };
  }

  async stop(game: AiGameKey): Promise<void> {
    await this.#deps.grants.setOn(game, false);
    this.#abortWhere((flight) => flight.game === game);
    this.#deps.consents.close(game);
    this.#changed(game, PlayAiNote.TurnedOff);
  }

  async payerChanged(door: AiDoor): Promise<void> {
    const games = await this.#deps.grants.stopDoor(door);
    for (const game of games) {
      this.#abortWhere((flight) => flight.game === game);
      this.#changed(game, null);
    }
  }

  abandon(channel: string): void {
    this.#abortWhere((flight) => flight.channel === channel);
    for (const game of this.#channels.get(channel) ?? []) this.#deps.consents.close(game);
    this.#channels.delete(channel);
  }

  showStop(card: AiStopCard): void {
    this.#deps.notify({ kind: GameAiNoticeKind.Stop, card });
  }

  /** A card's answer from the bar or Studio: the native step is asserted there before a yes spends. */
  answer(answer: AiConsentAnswer): Promise<AiConsentResult> {
    return this.#deps.consents.answer(answer);
  }

  /** Turn a game's AI on again (Settings' Games list, the pill). */
  async enable(game: AiGameKey): Promise<void> {
    await this.#deps.grants.setOn(game, true);
    this.#changed(game, null);
  }

  /** The menu of a game, read through the short-lived copy (`fresh` reads it again). */
  async menuOf(game: AiGameKey): Promise<AiModelMenu> {
    const menu = await this.#menu(game, true);
    if (!menu) throw new Error(MESSAGE.unavailable);
    return menu;
  }

  /** What the game's grant shows it: a plan's share of its window comes from the plan door. */
  async #view(grant: AiGrantRecord): Promise<AiBudgetView> {
    const view = this.#deps.grants.view(grant);
    if (grant.door !== AiDoor.Plan) return view;
    const share = await this.#deps.doors
      .get(AiDoor.Plan)
      ?.usage?.()
      .catch(() => null);
    return share ? { ...view, planUsedPercent: share.usedPercent, planResetsAt: share.resetsAt } : view;
  }

  async #active(game: AiGameKey): Promise<AiGrantAnswer> {
    if (this.#deps.grants.isOff(game)) return { view: null, code: AiErrorCode.Off };
    const live = this.#deps.grants.live(game);
    return { view: live ? await this.#view(live) : null, code: null };
  }

  async #granted(game: AiGameKey, model: AiModelRef, consent: AiConsent, requires: AiRequirement) {
    const grant = await this.#deps.grants.grant(game, model, consent, requires);
    // Read the menu again: it names the game's model now, and the pill draws from it.
    await this.#menu(game, true);
    this.#changed(game, PlayAiNote.FirstUse);
    return { view: await this.#view(grant), code: null };
  }

  /** Nothing to pick: a game that needs AI shows the set-up card; one that does not plays on. */
  async #setUp(caller: GameAiCaller, request: AiGrantRequest, menu: AiModelMenu | null): Promise<AiGrantAnswer> {
    if (request.requires !== AiRequirement.Ai || !menu) return { view: null, code: AiErrorCode.DoorUnavailable };
    return this.#ask(caller, request.requires, null, AiConsentKind.SetUp, menu);
  }

  /** Show a card and, on the person's yes, grant the model they agreed to. */
  async #ask(
    caller: GameAiCaller,
    requires: AiRequirement,
    pick: AiPick | null,
    kind: AiConsentKind,
    menu: AiModelMenu,
  ): Promise<AiGrantAnswer> {
    const ticket = consentTicket(this.#deps.clock, this.#facts(caller, pick, kind, menu));
    try {
      return await this.#askFor(caller, ticket, requires, pick?.model ?? null);
    } catch (error) {
      const failure = failureOf(error);
      return { view: null, code: failure.code };
    }
  }

  async #askFor(
    caller: GameAiCaller,
    ticket: ReturnType<typeof consentTicket>,
    requires: AiRequirement,
    fallback: AiModelRef | null,
  ): Promise<AiGrantAnswer> {
    this.#draw(caller.game, PlayAiPhase.NeedsYou);
    const answer = await this.#deps.consents.ask(caller, ticket);
    if (answer.unranked) this.#unranked.add(caller.game);
    const model = answer.model ?? fallback;
    if (!answer.approve || !model) {
      this.#draw(caller.game, PlayAiPhase.Ready);
      return { view: null, code: AiErrorCode.ConsentDeclined };
    }
    return this.#granted(caller.game, model, AiConsent.Card, requires);
  }

  #cardKind(funding: AiFunding): AiConsentKind {
    return funding === AiFunding.Plan || funding === AiFunding.Key || funding === AiFunding.Credits
      ? CARD_OF_FUNDING[funding]
      : AiConsentKind.SetUp;
  }

  /** A card's facts: the game, the model Genex picked and what the person needs to know about paying. */
  #facts(caller: GameAiCaller, pick: AiPick | null, kind: AiConsentKind, menu: AiModelMenu): ConsentCardFacts {
    const plan = pick?.row.funding === AiFunding.Plan;
    return {
      game: caller.game,
      title: caller.title,
      kind,
      model: pick?.model ?? null,
      modelLabel: pick?.row.label ?? null,
      balanceCredits: menu.genex.balanceCredits,
      keepForBuildingPercent: plan ? this.#deps.settings.local().keepForBuildingPercent : null,
      localDownloadBytes: null,
      maxCredits: null,
    };
  }

  /** The caller a pick in Studio's or the bar's menu speaks for. */
  #menuCaller(game: AiGameKey, menu: AiModelMenu): GameAiCaller {
    const play = game.startsWith(`${AiGameKind.Play}:`);
    return {
      game,
      title: this.#titles.get(game) ?? menu.title,
      context: play ? AiContext.DesktopPlay : AiContext.CreateLive,
      ownGame: !play,
      replaying: false,
      channel: MENU_CHANNEL,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  #seen(caller: GameAiCaller): void {
    this.#titles.set(caller.game, caller.title);
    const games = this.#channels.get(caller.channel) ?? new Set<AiGameKey>();
    games.add(caller.game);
    this.#channels.set(caller.channel, games);
  }

  #cancel(caller: GameAiCaller, ticket: string): boolean {
    const flight = this.#flights.get(ticket);
    if (!flight || flight.game !== caller.game) return false;
    flight.controller.abort();
    return true;
  }

  #abortWhere(match: (flight: Flight) => boolean): void {
    for (const flight of this.#flights.values()) if (match(flight)) flight.controller.abort();
  }

  async #menu(game: AiGameKey, fresh = false): Promise<AiModelMenu | null> {
    const now = this.#deps.clock.now();
    const kept = this.#menus.get(game);
    if (!fresh && kept && now - kept.at < MENU_TTL_MS) return kept.menu;
    const menu = await this.#deps.menu(game).catch(() => null);
    this.#menus.set(game, { at: now, menu });
    return menu;
  }

  #changed(game: AiGameKey, note: PlayAiNote | null): void {
    this.#deps.notify({ kind: GameAiNoticeKind.Changed, game });
    this.#draw(game, this.#deps.grants.isOff(game) ? PlayAiPhase.Off : PlayAiPhase.Ready, note);
  }

  /** Show a stop card once a minute at most per game and reason. */
  #stopCard(game: AiGameKey, reason: AiStopReason, facts: { resetsAt?: string | null; spentCredits?: number }): void {
    const key = `${reason} ${game}`;
    const now = this.#deps.clock.now();
    if (now - (this.#stops.get(key) ?? Number.NEGATIVE_INFINITY) < STOP_CARD_QUIET_MS) return;
    this.#stops.set(key, now);
    const title = this.#titles.get(game) ?? this.#menus.get(game)?.menu?.title ?? game;
    this.showStop(
      stopCardOf(game, title, reason, this.#deps.grants.live(game), this.#menus.get(game)?.menu ?? null, facts),
    );
  }

  /** Redraw the game's pill from its grant and the menu Genex last read. */
  #draw(game: AiGameKey, phase: PlayAiPhase, note: PlayAiNote | null = null): void {
    const menu = this.#menus.get(game)?.menu ?? null;
    const off = this.#deps.grants.isOff(game);
    const unranked = Boolean(menu?.leaderboard) && this.#unranked.has(game);
    const bar = pillBar(game, this.#deps.grants.live(game), menu, {
      phase: off ? PlayAiPhase.Off : phase,
      note,
      unranked,
    });
    this.#deps.drawPill(game, bar);
  }
}

/** The pill for a game: its model as the menu names it, how it is paid, and the balance on credits. */
function pillBar(
  game: AiGameKey,
  grant: AiGrantRecord | null,
  menu: AiModelMenu | null,
  state: { phase: PlayAiPhase; note: PlayAiNote | null; unranked: boolean },
): PlayAiBar {
  const row = grant && menu ? menuOffers(menu, grant.model) : null;
  const credits = row?.funding === AiFunding.Credits;
  const balance = credits ? (menu?.genex.balanceCredits ?? null) : null;
  return {
    game,
    phase: state.phase,
    model: grant?.model ?? null,
    label: row?.label ?? null,
    shortLabel: row?.shortLabel ?? null,
    funding: row?.funding ?? null,
    tag: row?.tag ?? null,
    balanceCredits: balance,
    lowCredits: balance !== null && balance <= AI_LOW_CREDITS,
    unranked: state.unranked,
    note: state.note,
    addedCredits: null,
  };
}

/** A stop card's facts: the model the game used and, when there is one, a free model to go on with. */
function stopCardOf(
  game: AiGameKey,
  title: string,
  reason: AiStopReason,
  grant: AiGrantRecord | null,
  menu: AiModelMenu | null,
  facts: { resetsAt?: string | null; spentCredits?: number },
): AiStopCard {
  const free = menu ? pickModel(menu, AiPickPolicy.FreeOnly, AiContext.DesktopPlay) : null;
  const alternative = free && (!grant || !sameModel(free.model, grant.model)) ? free : null;
  const row = grant && menu ? menuOffers(menu, grant.model) : null;
  return {
    game,
    title,
    reason,
    model: grant?.model ?? null,
    modelLabel: row?.label ?? null,
    alternative: alternative?.model ?? null,
    alternativeLabel: alternative?.row.label ?? null,
    resetsAt: facts.resetsAt ?? null,
    spentCredits: facts.spentCredits ?? null,
  };
}

// ── what the IPC registrar delegates to ────────────────────────────────────────────────────

/** What the IPC host runs on: the service and the stores, plus the parts other areas build. */
export interface GameAiIpcHostOptions {
  service: GameAiServiceImpl;
  grants: GameAiGrants;
  settings: GameAiSettings;
  tapes: GameAiTapes;
  ledger: GameAiLedger;
  platform: Pick<GenexAiPlatform, "packs" | "checkoutUrl">;
  reports: GameAiReports;
  check: GameAiModelCheck;
  /** A library game's folder, resolved through the library by real path; throws for any other name. */
  projectFolder(project: string): Promise<string>;
  /** A game's name as the library or the catalog shows it. */
  titleOf(game: AiGameKey): Promise<string>;
  /** Open a page in the person's browser. */
  openExternal(url: string): Promise<void>;
  /** genex.games' own origin: checkout opens there and nowhere else. */
  checkoutOrigin: string;
}

/** Whether a grant's spend shows as money in the Games list: credits or the person's key. */
const spendsMoney = (funding: AiFunding): boolean => funding === AiFunding.Credits || funding === AiFunding.Key;

/** `GameAiIpcHost` over the service; every payload was already read by the registrar. */
export function createGameAiIpcHost(options: GameAiIpcHostOptions): GameAiIpcHost {
  const { service, grants, settings, check, reports } = options;
  return {
    menu: (game) => service.menuOf(game),
    pick: (game, model) => service.pick(game, model),
    answer: (answer) => service.answer(answer),
    enable: (game, enabled) => (enabled ? service.enable(game) : service.stop(game)),
    activity: () => activityOf(options),
    settings: () => settings.view(),
    saveSettings: async (patch) => {
      const view = await settings.save(patch);
      // Taking the plan away is a payer change: every game on it stops at once.
      if (patch.allowPlan === false) await service.payerChanged(AiDoor.Plan);
      return view;
    },
    tapes: async (project) => options.tapes.list(await options.projectFolder(project)),
    reportPreview: (game) => reports.preview(game),
    report: (request) => reports.send(request),
    check: (project) => check.start(project, { localOnly: false }),
    checkState: (project) => check.state(project),
    checkStop: (project) => check.stop(project),
    recommend: (project, model) => check.recommend(project, model),
    publishFacts: (project) => check.publishFacts(project),
    credits: () => options.platform.packs(),
    checkout: async (product) => {
      const url = new URL(await options.platform.checkoutUrl(product));
      if (url.origin !== new URL(options.checkoutOrigin).origin || url.protocol !== "https:") {
        throw new Error(MESSAGE.checkoutElsewhere);
      }
      await options.openExternal(url.href);
    },
  };
  /** Settings' Games list: every game holding a grant, its model and what it spent this month. */
  async function activityOf(host: GameAiIpcHostOptions): Promise<AiActivity> {
    const month = await host.ledger.monthByGame();
    const live = grants.list().filter((grant) => grant.status !== AiGrantStatus.Replaced);
    const games = await Promise.all(
      live.map(async (grant) => {
        const funding = fundingOf(grant.door, grant.door === AiDoor.Local);
        return {
          game: grant.game,
          title: await host.titleOf(grant.game).catch(() => grant.game),
          model: grant.model,
          modelLabel: grant.model.model,
          funding,
          monthMicros: spendsMoney(funding) ? (month.get(grant.game) ?? 0) : 0,
          on: grant.status !== AiGrantStatus.Off,
          consent: grant.consent,
        };
      }),
    );
    return { games };
  }
}
