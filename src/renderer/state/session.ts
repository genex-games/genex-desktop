/**
 * The bootstrap's own state: loading, ready or failed (with main's reason), whether a first
 * launch is being welcomed (the welcome covers the app and ends at home, its idea in the composer),
 * and the usage analytics this session may offer with the person's answer about them.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AnalyticsConfig } from "../../shared/analytics.ts";
import type { LaunchFacts } from "../../shared/app-session.ts";
import { PLAY_ORIGIN } from "../../shared/play.ts";
import type { AnalyticsChoice } from "../analytics/consent.ts";

/** Where the bootstrap stands. */
export const SessionStatus = {
  Loading: "loading",
  Ready: "ready",
  Failed: "failed",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export interface SessionState {
  status: SessionStatus;
  error: string | null;
  /** The first-launch welcome is up (`onboarding/state.ts` decides whether to show it). */
  welcoming: boolean;
  /** An unpackaged developer run: the developer tools (the colour tweaker) are offered. */
  developer: boolean;
  /** The website Play links to: genex.games', unless a development profile points Play elsewhere. */
  playWeb: string;
  /** Usage analytics this session may offer: null in a build without them and in launches that never send. */
  analytics: AnalyticsConfig | null;
  /** The person's answer on this profile for the current consent version, or null while never asked. */
  analyticsChoice: AnalyticsChoice | null;
  /** When this install's replay of its first week ends (epoch ms), or null when it records none. */
  replayUntil: number | null;
  /** The welcome was up when this launch started: the question's answer is the first launch's. */
  firstLaunch: boolean;
  /** How this launch started and the session before it ended, from the first bootstrap only (usage analytics). */
  launch: LaunchFacts | null;
}

export const initialSession = (): SessionState => ({
  status: SessionStatus.Loading,
  error: null,
  welcoming: false,
  developer: false,
  playWeb: PLAY_ORIGIN.web,
  analytics: null,
  analyticsChoice: null,
  replayUntil: null,
  firstLaunch: false,
  launch: null,
});

export function bootstrapStarted(state: SessionState): SessionState {
  return { ...state, status: SessionStatus.Loading };
}

export function bootstrapReady(
  state: SessionState,
  opening: {
    welcome?: boolean;
    developer?: boolean;
    playWeb?: string;
    analytics?: AnalyticsConfig | null;
    analyticsChoice?: AnalyticsChoice | null;
    replayUntil?: number | null;
    launch?: LaunchFacts | null;
  },
): SessionState {
  return {
    ...state,
    status: SessionStatus.Ready,
    error: null,
    welcoming: opening.welcome === true,
    firstLaunch: opening.welcome === true,
    developer: opening.developer === true,
    playWeb: opening.playWeb ?? PLAY_ORIGIN.web,
    analytics: opening.analytics ?? null,
    analyticsChoice: opening.analyticsChoice ?? null,
    replayUntil: opening.replayUntil ?? null,
    launch: opening.launch ?? null,
  };
}

/** The welcome was finished or skipped: home follows it. */
export function welcomeFinished(state: SessionState): SessionState {
  return { ...state, welcoming: false };
}

/** The person answered the analytics question, or changed the answer in Settings → Privacy. */
export function analyticsChosen(state: SessionState, choice: AnalyticsChoice): SessionState {
  return state.analyticsChoice === choice ? state : { ...state, analyticsChoice: choice };
}

/** Whether the analytics question is up: this session offers analytics and the profile never answered it. */
export const asksAboutAnalytics = (state: SessionState): boolean =>
  state.status === SessionStatus.Ready && state.analytics !== null && state.analyticsChoice === null;

export function bootstrapFailed(state: SessionState, error: string): SessionState {
  return { ...state, status: SessionStatus.Failed, error };
}

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  return createStore<SessionState>()(() => initialSession());
}
