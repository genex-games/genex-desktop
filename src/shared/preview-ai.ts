/**
 * Play-time models in Live (docs/product/builds-live.md): a game whose code calls Genex's models gets
 * a practice helper beside its preview (`genex llm practice`), which answers every call with made-up
 * text for free. In Live only, the person can switch that game to real models, paid from their own
 * Genex credits up to a cap they chose; the microphone is asked for in the same bar.
 */

/** How Live's model calls are answered now. Wire values: never rename one. */
export const PreviewAiMode = {
  /** The game calls no play-time model: no bar. */
  None: "none",
  /** Made-up answers from the practice helper, free (`source: 'practice'`). */
  Practice: "practice",
  /** The person pressed Start: real models are being started for the cap they chose. */
  Starting: "starting",
  /** Real models answer, paid from the person's credits up to the cap. */
  Live: "live",
  /** The cap is used up: calls are refused until the person adds more. */
  CapReached: "cap_reached",
  /** Real models cannot answer here; `reason` says why, and practice answers go on. */
  Unavailable: "unavailable",
} as const;
export type PreviewAiMode = (typeof PreviewAiMode)[keyof typeof PreviewAiMode];

/** Why real models cannot answer in Live. Wire values: never rename one. */
export const PreviewAiUnavailable = {
  /** The app is not signed in to Genex. */
  SignedOut: "signed_out",
  /** The game has no published draft on Genex, which real calls are billed to. */
  NoDraft: "no_draft",
  /** Genex's model lane is off. */
  LaneOff: "lane_off",
  /** The helper failed to start or stopped; `error` holds the CLI's words or code. */
  HelperFailed: "helper_failed",
  /** This profile never spends (a test profile). */
  NotHere: "not_here",
} as const;
export type PreviewAiUnavailable = (typeof PreviewAiUnavailable)[keyof typeof PreviewAiUnavailable];

/** The caps the person chooses between, in credits (1 credit is 1 cent). */
export const PREVIEW_AI_CAPS = [100, 300, 1000] as const;
/** The cap the confirmation starts on. */
export const PREVIEW_AI_DEFAULT_CAP = 100;
/** Credits in one US dollar. */
export const CREDITS_PER_DOLLAR = 100;

/** Whether `value` is one of the caps the person can choose. */
export const isPreviewAiCap = (value: unknown): value is (typeof PREVIEW_AI_CAPS)[number] =>
  PREVIEW_AI_CAPS.some((cap) => cap === value);

/** The microphone's ask in Live. Wire values: never rename one. */
export const PreviewMicAsk = {
  /** Nothing asked, or the game declares no microphone. */
  None: "none",
  /** The game asked for the microphone and waits for the person's answer. */
  Asking: "asking",
  /** The person allowed it for this game, for this app session. */
  Allowed: "allowed",
  /** The person said not now: the game is refused until it asks again. */
  Refused: "refused",
} as const;
export type PreviewMicAsk = (typeof PreviewMicAsk)[keyof typeof PreviewMicAsk];

/** Live's play-time model state for one game: the `preview.ai` UI event, and what the bar reads on mount. */
export interface PreviewAiState {
  project: string;
  mode: PreviewAiMode;
  /** Set while `mode` is unavailable (or practice after a fallback): why real models cannot answer. */
  reason: PreviewAiUnavailable | null;
  /** The CLI's own words or code when the helper failed. */
  error: string | null;
  /** The cap the person approved, while real models answer or are starting. */
  capCredits: number | null;
  /** Credits charged in this play session. */
  chargedCredits: number;
  /** Credits set aside for calls whose bill is not final yet. */
  heldCredits: number;
  /** The microphone's ask for this game. */
  mic: PreviewMicAsk;
}

/** A game's state before anything is known: no bar. */
export const noPreviewAi = (project: string): PreviewAiState => ({
  project,
  mode: PreviewAiMode.None,
  reason: null,
  error: null,
  capCredits: null,
  chargedCredits: 0,
  heldCredits: 0,
  mic: PreviewMicAsk.None,
});
