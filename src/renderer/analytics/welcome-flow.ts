/**
 * The welcome's own journey as analytics tells it: the screens a person moves through and how long
 * each held them, what they did to the film, the Connect screen as they found it, how they left,
 * and the Genex promo after it. Pure: times come in as arguments, and nothing a person wrote leaves
 * (an idea is only its length's bucket).
 */
import { EngineStatusCode, type EngineDescriptor } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { type PromoAccount, PromoPhase } from "../genex-promo.ts";
import {
  type ConnectAction,
  type ConnectView,
  ConnectViewKind,
  type Subscription,
  WelcomeScreen,
} from "../onboarding/state.ts";
import type { Room } from "../state/threads.ts";
import type { WelcomeEvent, WelcomeEventProperties } from "./events/welcome.ts";
import { charsBucket, elapsedMs } from "./properties.ts";
import {
  engineRef,
  type FilmAction,
  FreeModelChoice,
  type PromoCloseVia,
  SignInOutcome,
} from "./welcome-vocabulary.ts";

type Props<E extends keyof WelcomeEventProperties> = WelcomeEventProperties[E];

/** A subscription's button on Connect, named by its action or, while it is not one, by its shape. */
export type ConnectViewName = Exclude<ConnectViewKind, typeof ConnectViewKind.Action> | ConnectAction;

/** The name of what a subscription's button shows. */
export const connectViewName = (view: ConnectView): ConnectViewName =>
  view.kind === ConnectViewKind.Action ? view.action : view.kind;

/** The engines ready to build with, by the app's ids, sorted. */
export const readyEngineRefs = (engines: readonly Pick<EngineDescriptor, "id" | "status">[]): string[] =>
  engines
    .filter((engine) => engine.status.code === EngineStatusCode.Ready)
    .map((engine) => engineRef(engine.id))
    .sort();

/** Where the welcome has taken a person: when it started, the screen they are on and since when, and every screen seen. */
export interface WelcomeJourney {
  startedAt: number;
  screen: WelcomeScreen;
  screenAt: number;
  visited: readonly WelcomeScreen[];
}

/** A welcome starting on its first screen. */
export const startJourney = (now: number): WelcomeJourney => ({
  startedAt: now,
  screen: WelcomeScreen.Welcome,
  screenAt: now,
  visited: [WelcomeScreen.Welcome],
});

/**
 * The welcome as it shows: whether its film is still and, once the screen an unfinished welcome
 * stood on is kept on the profile (`stored`; undefined while it is not), whether this one resumes it.
 * Only the welcome's own screen names count; anything else stored is no screen.
 */
export function welcomeShown(reducedMotion: boolean, stored?: string | null): Props<typeof WelcomeEvent.WelcomeShown> {
  if (stored === undefined) return { reduced_motion: reducedMotion };
  const screen = Object.values(WelcomeScreen).find((known) => known === stored) ?? null;
  return { reduced_motion: reducedMotion, resumed: stored !== null, last_screen_before: screen };
}

/** A move to another screen: the journey after it, and what to say about it (nothing for the same screen). */
export function journeyMoved(
  journey: WelcomeJourney,
  move: { to: WelcomeScreen; back: boolean },
  now: number,
): { journey: WelcomeJourney; viewed: Props<typeof WelcomeEvent.WelcomeScreenViewed> | null } {
  if (move.to === journey.screen) return { journey, viewed: null };
  const visited = journey.visited.includes(move.to) ? journey.visited : [...journey.visited, move.to];
  return {
    journey: { ...journey, screen: move.to, screenAt: now, visited },
    viewed: {
      screen: move.to,
      from: journey.screen,
      back: move.back,
      ms_on_previous: elapsedMs(journey.screenAt, now),
    },
  };
}

/** What the film saw by Next: the furthest beat, how often it looped, and the idea's length (never its words). */
export interface FilmSeen {
  beatReached: number;
  loops: number;
  ideaLength: number;
}

/** Next pressed on the welcome. */
export function welcomeNext(
  journey: WelcomeJourney,
  film: FilmSeen,
  now: number,
): Props<typeof WelcomeEvent.WelcomeNextClicked> {
  return {
    ms_on_welcome: elapsedMs(journey.screenAt, now),
    beat_reached: film.beatReached,
    film_loops: film.loops,
    idea_written: film.ideaLength > 0,
    idea_chars_bucket: charsBucket(film.ideaLength),
  };
}

/** Something done to the film or its composer; an idea is told by its length's bucket. */
export function filmInteraction(
  action: FilmAction,
  beat: number,
  ideaLength?: number,
): Props<typeof WelcomeEvent.WelcomeFilmInteracted> {
  const idea = ideaLength === undefined ? {} : { idea_chars_bucket: charsBucket(ideaLength) };
  return { action, beat, ...idea };
}

/** Connect as a person found it: each subscription's button and CLI, and what was ready already. */
export function connectScreenViewed(
  views: Record<Subscription, ConnectView>,
  engines: readonly EngineDescriptor[],
  anyReady: boolean,
): Props<typeof WelcomeEvent.ConnectScreenViewed> {
  const cli = (id: Subscription) => engines.find((engine) => engine.id === id)?.account?.cli.state ?? null;
  return {
    claude_view: connectViewName(views[EngineId.ClaudeCode]),
    codex_view: connectViewName(views[EngineId.Codex]),
    claude_cli_state: cli(EngineId.ClaudeCode),
    codex_cli_state: cli(EngineId.Codex),
    engines_ready: readyEngineRefs(engines),
    any_ready: anyReady,
  };
}

/** The free model a welcome hands on: none offered, OpenCode's own default, or another one picked. */
export function freeModelChoice(free: { picked: string } | null, defaultKey: string): FreeModelChoice {
  if (!free) return FreeModelChoice.None;
  return free.picked === defaultKey ? FreeModelChoice.Default : FreeModelChoice.Picked;
}

/** How a welcome ended, beside the journey that led there. */
export interface WelcomeEnd {
  exit: Props<typeof WelcomeEvent.WelcomeFinished>["exit"];
  engines: readonly Pick<EngineDescriptor, "id" | "status">[];
  anyReady: boolean;
  ideaCarried: boolean;
  freeModel: FreeModelChoice;
  readyFailed: boolean;
}

/** The welcome ended. */
export function welcomeFinished(
  journey: WelcomeJourney,
  end: WelcomeEnd,
  now: number,
): Props<typeof WelcomeEvent.WelcomeFinished> {
  return {
    exit: end.exit,
    screen: journey.screen,
    ms_in_welcome: elapsedMs(journey.startedAt, now),
    screens_visited: journey.visited.length,
    engines_ready: readyEngineRefs(end.engines),
    any_ready: end.anyReady,
    idea_carried: end.ideaCarried,
    free_model: end.freeModel,
    ready_failed: end.readyFailed,
  };
}

/** Connect AI model pressed in a composer, lit by a blocked send or not. */
export const connectModelClicked = (nudged: boolean, room: Room): Props<typeof WelcomeEvent.ConnectModelClicked> => ({
  nudged,
  room,
});

/** The Genex promo card rose: where, the account it found, and how long after the welcome ended. */
export function promoShown(
  card: { atHome: boolean; account: PromoAccount; welcomeEndedAt: number | null },
  now: number,
): Props<typeof WelcomeEvent.GenexPromoShown> {
  return {
    at_home: card.atHome,
    account: card.account ?? null,
    ms_since_welcome: card.welcomeEndedAt === null ? null : elapsedMs(card.welcomeEndedAt, now),
  };
}

/** How a promo step ends the card's own sign-in: connected, failed, or not yet. */
const PROMO_OUTCOMES: Partial<Record<PromoPhase, SignInOutcome>> = {
  [PromoPhase.Connected]: SignInOutcome.Connected,
  [PromoPhase.Failed]: SignInOutcome.Failed,
};

/** The outcome a promo step means for the sign-in the card started, or null while it waits. */
export const promoOutcome = (phase: PromoPhase): SignInOutcome | null => PROMO_OUTCOMES[phase] ?? null;

/** The promo's own sign-in settled. */
export function promoConnectFinished(
  attempt: { outcome: SignInOutcome; retry: boolean; sawSignIn: boolean; startedAt: number },
  now: number,
): Props<typeof WelcomeEvent.GenexPromoConnectFinished> {
  return {
    outcome: attempt.outcome,
    retry: attempt.retry,
    saw_sign_in: attempt.sawSignIn,
    duration_ms: elapsedMs(attempt.startedAt, now),
  };
}

/** The promo card went away. */
export function promoClosed(
  card: { phase: PromoPhase; via: PromoCloseVia; learnMore: boolean; shownAt: number },
  now: number,
): Props<typeof WelcomeEvent.GenexPromoClosed> {
  return { phase: card.phase, via: card.via, learn_more: card.learnMore, ms_visible: elapsedMs(card.shownAt, now) };
}
