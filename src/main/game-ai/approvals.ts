/**
 * Play-time AI's cards on trusted surfaces (the Play bar, Studio's chrome): the one-sentence
 * first-use card, the leaderboard card, the set-up card and the Genex confirm (D3). A card is a
 * ticket: one pending per game, lapsing after {@link AI_CONSENT_TTL_MS} as a decline, with a
 * cooldown after a decline so a game cannot ask in a loop. A commit inside the card's first
 * {@link CONSENT_INPUT_DELAY_MS} is refused (a click meant for the game), and a yes that spends the
 * person's plan or money asserts its native step first (`GameAiNativeStep`), so a fixture profile
 * can never approve spending. A model chosen with Change must be one this game may use here.
 */
import { randomBytes } from "node:crypto";
import { SECOND_MS } from "../../shared/duration.ts";
import { AiDoor, AiErrorCode, type AiGameKey, type AiModelRef } from "../../shared/game-ai.ts";
import {
  AI_CONSENT_TTL_MS,
  type AiConsentAnswer,
  AiConsentKind,
  AiConsentRefusal,
  type AiConsentResult,
  type AiConsentTicket,
  GameAiNoticeKind,
  type GameAiNotice,
} from "../../shared/game-ai-views.ts";
import { AiRefusal } from "./refusal.ts";
import { type GameAiCaller, type GameAiClock, type GameAiConsents, GameAiNativeStep } from "./types.ts";

/** A card ignores a commit this soon after it shows: the click or key was meant for the game. */
export const CONSENT_INPUT_DELAY_MS = 600;
/** After a decline (or a lapse) a game waits this long before it may show a card again. */
export const DECLINE_COOLDOWN_MS = 30 * SECOND_MS;
/** A ticket id's random part, in bytes. */
const TICKET_BYTES = 12;

/** The step a yes on each door asserts; a free door asserts none. */
const NATIVE_STEP_OF = {
  [AiDoor.Local]: null,
  [AiDoor.OpenCode]: GameAiNativeStep.ApprovePaid,
  [AiDoor.Byok]: GameAiNativeStep.ApprovePaid,
  [AiDoor.Plan]: GameAiNativeStep.ApprovePlan,
  [AiDoor.PlanWatcher]: GameAiNativeStep.ApprovePlan,
  [AiDoor.GenexCredits]: GameAiNativeStep.ApprovePaid,
  [AiDoor.GenexDev]: GameAiNativeStep.ApprovePaid,
  [AiDoor.Tape]: null,
  [AiDoor.Fixture]: null,
} as const satisfies Record<AiDoor, GameAiNativeStep | null>;

/** The card's facts but its ticket and lapse, which the store sets. */
export type ConsentCardFacts = Omit<AiConsentTicket, "ticket" | "expiresAt">;

/** A card's ticket: a fresh id, lapsing {@link AI_CONSENT_TTL_MS} from now on `clock`. */
export function consentTicket(clock: GameAiClock, facts: ConsentCardFacts): AiConsentTicket {
  return {
    ...facts,
    ticket: `t_${randomBytes(TICKET_BYTES).toString("base64url")}`,
    expiresAt: new Date(clock.now() + AI_CONSENT_TTL_MS).toISOString(),
  };
}

/** What the cards run on. */
export interface GameAiConsentsOptions {
  clock: GameAiClock;
  notify(notice: GameAiNotice): void;
  /** Throws in a fixture profile for a native step (`assertNativeActionAllowed`). */
  assertNative(step: GameAiNativeStep): void;
  /** Whether a model chosen with Change may be used for this game here (it is in the game's menu, and ready). */
  usable(game: AiGameKey, model: AiModelRef): Promise<boolean>;
  /** How long a card waits (tests hold it short). */
  ttlMs?: number | undefined;
}

/** One card showing. */
interface Pending {
  ticket: AiConsentTicket;
  game: AiGameKey;
  shownAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(answer: AiConsentAnswer): void;
}

/** The step a yes asserts: by the model it will use, or by the card for a Genex confirm. */
function nativeStepFor(kind: AiConsentKind, model: AiModelRef | null): GameAiNativeStep | null {
  if (kind === AiConsentKind.GenexConfirm || kind === AiConsentKind.Credits) return GameAiNativeStep.ApprovePaid;
  return model ? NATIVE_STEP_OF[model.door] : null;
}

const declined = (ticket: string): AiConsentAnswer => ({ ticket, approve: false, model: null, unranked: false });

/** The cards of one profile. */
export function createGameAiConsents(options: GameAiConsentsOptions): GameAiConsents {
  return new Consents(options);
}

class Consents implements GameAiConsents {
  readonly #options: GameAiConsentsOptions;
  readonly #pending = new Map<string, Pending>();
  /** Until when a game may not show a card, after a decline. */
  readonly #cooling = new Map<AiGameKey, number>();

  constructor(options: GameAiConsentsOptions) {
    this.#options = options;
  }

  ask(caller: GameAiCaller, ticket: AiConsentTicket): Promise<AiConsentAnswer> {
    const now = this.#options.clock.now();
    if (this.#pendingOf(caller.game)) return Promise.reject(new AiRefusal(AiErrorCode.ConsentPending));
    const until = this.#cooling.get(caller.game) ?? 0;
    if (until > now) return Promise.reject(new AiRefusal(AiErrorCode.ConsentDeclined, until - now));
    return new Promise<AiConsentAnswer>((resolve) => {
      const timer = setTimeout(() => this.#finish(ticket.ticket, declined(ticket.ticket), true), this.#ttl());
      timer.unref?.();
      this.#pending.set(ticket.ticket, { ticket, game: caller.game, shownAt: now, timer, resolve });
      this.#options.notify({ kind: GameAiNoticeKind.Consent, consent: ticket });
    });
  }

  async answer(answer: AiConsentAnswer): Promise<AiConsentResult> {
    const pending = this.#pending.get(answer.ticket);
    if (!pending) return { ok: false, code: AiConsentRefusal.Expired };
    if (this.#options.clock.now() - pending.shownAt < CONSENT_INPUT_DELAY_MS) {
      return { ok: false, code: AiConsentRefusal.TooSoon };
    }
    if (!answer.approve) {
      this.#finish(answer.ticket, declined(answer.ticket), true);
      return { ok: true, model: null };
    }
    const model = answer.model ?? pending.ticket.model;
    if (answer.model && !(await this.#options.usable(pending.game, answer.model))) {
      return { ok: false, code: AiConsentRefusal.Unavailable };
    }
    const step = nativeStepFor(pending.ticket.kind, model);
    // Throws in a fixture profile: nothing is resolved, the card stays open.
    if (step) this.#options.assertNative(step);
    // The card may have lapsed or closed while the model was checked.
    if (!this.#pending.has(answer.ticket)) return { ok: false, code: AiConsentRefusal.Expired };
    this.#finish(answer.ticket, { ticket: answer.ticket, approve: true, model, unranked: answer.unranked }, false);
    return { ok: true, model };
  }

  close(game: AiGameKey): void {
    const pending = this.#pendingOf(game);
    if (pending) this.#finish(pending.ticket.ticket, declined(pending.ticket.ticket), false);
  }

  #ttl(): number {
    return this.#options.ttlMs ?? AI_CONSENT_TTL_MS;
  }

  #pendingOf(game: AiGameKey): Pending | null {
    for (const pending of this.#pending.values()) if (pending.game === game) return pending;
    return null;
  }

  /** Resolve a card once: close it on every surface, and after a decline start the game's cooldown. */
  #finish(ticket: string, answer: AiConsentAnswer, coolDown: boolean): void {
    const pending = this.#pending.get(ticket);
    if (!pending) return;
    this.#pending.delete(ticket);
    clearTimeout(pending.timer);
    if (coolDown && !answer.approve) {
      this.#cooling.set(pending.game, this.#options.clock.now() + DECLINE_COOLDOWN_MS);
    }
    this.#options.notify({ kind: GameAiNoticeKind.ConsentClosed, ticket });
    pending.resolve(answer);
  }
}
