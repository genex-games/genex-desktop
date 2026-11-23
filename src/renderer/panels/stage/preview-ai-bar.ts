/**
 * What Live's AI bar says for a game (`PreviewAiBar.tsx`): practice answers with a way to real
 * models, the confirmation of a cap, the meter while real models answer, the cap used up, why real
 * models are not available, and the game's microphone ask. Pure, so each state is tested as words.
 */
import { t } from "../../../shared/i18n.ts";
import {
  CREDITS_PER_DOLLAR,
  PreviewAiMode,
  type PreviewAiState,
  PreviewAiUnavailable,
  PreviewMicAsk,
} from "../../../shared/preview-ai.ts";

/** What the bar shows. Wire values: `data-preview-ai` reads them. */
export const PreviewAiBarKind = {
  Hidden: "hidden",
  Mic: "mic",
  Practice: "practice",
  Confirm: "confirm",
  Starting: "starting",
  Live: "live",
  CapReached: "cap-reached",
  Unavailable: "unavailable",
} as const;
export type PreviewAiBarKind = (typeof PreviewAiBarKind)[keyof typeof PreviewAiBarKind];

/** A cap in US dollars, as the bar spells it: `$1`, `$3`, `$10`, `$2.50`. */
export function capDollars(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/** The bar's words. */
export const PREVIEW_AI_WORDS = {
  practice: () => t("Practice answers (free, made up)"),
  realAi: () => t("Use real AI"),
  confirm: (cap: number, onGenex = true) =>
    onGenex
      ? t(
          "Real models answer in this preview, paid from your Genex credits: at most {cap} credits ({dollars}) for this play session.",
          { cap: String(cap), dollars: capDollars(cap) },
        )
      : t(
          "Real models answer in this preview, paid from your Genex credits: at most {cap} credits ({dollars}) for this play session. The game is added to your Genex account as a private draft; none of its files are uploaded.",
          { cap: String(cap), dollars: capDollars(cap) },
        ),
  capChoice: () => t("Most credits this play session may spend"),
  capOption: (cap: number) => String(cap),
  start: () => t("Start"),
  cancel: () => t("Cancel"),
  starting: () => t("Starting real AI…"),
  live: (spent: number, cap: number) =>
    t("Real AI · {spent} of {cap} credits", { spent: String(spent), cap: String(cap) }),
  stop: () => t("Stop"),
  capReached: () => t("The cap is used up"),
  addMore: (cap: number) => t("Add {cap} more", { cap: String(cap) }),
  tryAgain: () => t("Try again"),
  micAsk: () => t("This game wants to hear you through your microphone."),
  micAllow: () => t("Allow"),
  micNotNow: () => t("Not now"),
  practiceFailed: (error: string) => t("Practice answers could not start: {error}", { error }),
} as const;

/** Why real models are not available, and the next step, by reason. */
const UNAVAILABLE_WORDS = {
  [PreviewAiUnavailable.SignedOut]: () =>
    t("Real AI needs you signed in to Genex. Sign in from Settings, then try again. Practice answers go on."),
  [PreviewAiUnavailable.NoDraft]: () =>
    t("Real AI could not start: this game could not be added to your Genex account. Practice answers go on."),
  [PreviewAiUnavailable.Terms]: () =>
    t(
      "Real AI needs Genex's updated terms accepted. Review them on genex.games, then try again. Practice answers go on.",
    ),
  [PreviewAiUnavailable.LaneOff]: () => t("Genex's real models are switched off right now. Practice answers go on."),
  [PreviewAiUnavailable.HelperFailed]: () => t("Real AI stopped. Practice answers go on."),
  [PreviewAiUnavailable.NotHere]: () => t("Real AI is not available in this test profile. Practice answers go on."),
} as const satisfies Record<PreviewAiUnavailable, () => string>;

/** The reasons whose next step is to try again from the bar. */
const RETRIES: ReadonlySet<PreviewAiUnavailable> = new Set([
  PreviewAiUnavailable.SignedOut,
  PreviewAiUnavailable.NoDraft,
  PreviewAiUnavailable.Terms,
  PreviewAiUnavailable.LaneOff,
  PreviewAiUnavailable.HelperFailed,
]);

/** Why real models are not available, with the CLI's own words when the helper failed. */
export function unavailableWords(reason: PreviewAiUnavailable | null, error: string | null): string {
  const words = UNAVAILABLE_WORDS[reason ?? PreviewAiUnavailable.HelperFailed]();
  return error ? `${words} (${error})` : words;
}

/** Whether the bar offers Try again for this reason. */
export const offersRetry = (reason: PreviewAiUnavailable | null): boolean => reason !== null && RETRIES.has(reason);

/** What the bar shows for a game's state, and whether the person is confirming a cap. */
export function previewAiBarKind(state: PreviewAiState | undefined, confirming: boolean): PreviewAiBarKind {
  if (!state) return PreviewAiBarKind.Hidden;
  if (state.mic === PreviewMicAsk.Asking) return PreviewAiBarKind.Mic;
  if (state.mode === PreviewAiMode.None) return PreviewAiBarKind.Hidden;
  if (confirming) return PreviewAiBarKind.Confirm;
  const kinds = {
    [PreviewAiMode.Practice]: PreviewAiBarKind.Practice,
    [PreviewAiMode.Starting]: PreviewAiBarKind.Starting,
    [PreviewAiMode.Live]: PreviewAiBarKind.Live,
    [PreviewAiMode.CapReached]: PreviewAiBarKind.CapReached,
    [PreviewAiMode.Unavailable]: PreviewAiBarKind.Unavailable,
  } as const;
  return kinds[state.mode];
}
