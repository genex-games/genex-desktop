/**
 * The bootstrap's own state: loading, ready or failed (with main's reason), and whether a first
 * launch is being welcomed (the welcome covers the app and ends at home, its idea in the composer).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { PLAY_ORIGIN } from "../../shared/play.ts";

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
}

export const initialSession = (): SessionState => ({
  status: SessionStatus.Loading,
  error: null,
  welcoming: false,
  developer: false,
  playWeb: PLAY_ORIGIN.web,
});

export function bootstrapStarted(state: SessionState): SessionState {
  return { ...state, status: SessionStatus.Loading };
}

export function bootstrapReady(
  state: SessionState,
  opening: { welcome?: boolean; developer?: boolean; playWeb?: string },
): SessionState {
  return {
    ...state,
    status: SessionStatus.Ready,
    error: null,
    welcoming: opening.welcome === true,
    developer: opening.developer === true,
    playWeb: opening.playWeb ?? PLAY_ORIGIN.web,
  };
}

/** The welcome was finished or skipped: home follows it. */
export function welcomeFinished(state: SessionState): SessionState {
  return { ...state, welcoming: false };
}

export function bootstrapFailed(state: SessionState, error: string): SessionState {
  return { ...state, status: SessionStatus.Failed, error };
}

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  return createStore<SessionState>()(() => initialSession());
}
