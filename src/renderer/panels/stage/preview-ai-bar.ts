/**
 * What Live's AI bar says for a game (`PreviewAiBar.tsx`): practice answers with a way to real
 * models and to a plan of the person's own, the confirmation of each, the meter while real models
 * answer, the plan that answers, the cap used up, why real models are not available, and the game's
 * microphone ask. Pure, so each state is tested as words.
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
  PlanConfirm: "plan-confirm",
  Starting: "starting",
  Live: "live",
  Plan: "plan",
  CapReached: "cap-reached",
  Unavailable: "unavailable",
} as const;
export type PreviewAiBarKind = (typeof PreviewAiBarKind)[keyof typeof PreviewAiBarKind];

/** What the person is confirming in the bar: real models for a cap, or a plan of their own. */
export const PreviewAiConfirm = { Real: "real", Plan: "plan" } as const;
export type PreviewAiConfirm = (typeof PreviewAiConfirm)[keyof typeof PreviewAiConfirm];

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
  myPlan: () => t("Use my plan"),
  planConfirm: (plan: string) =>
    t(
      "Your own {plan} plan answers in this preview, on this computer. No Genex credits are spent; your plan's limits apply, answers come slower, and voices stay practice.",
      { plan },
    ),
  planChoice: () => t("The plan that answers"),
  startingPlan: (plan: string) => t("Starting {plan}…", { plan }),
  plan: (plan: string) => t("{plan} answers · your own plan, no credits", { plan }),
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
  [PreviewAiUnavailable.PlanNotReady]: () =>
    t(
      "That plan is not signed in or ready on this computer. Check it in Settings, then try again. Practice answers go on.",
    ),
} as const satisfies Record<PreviewAiUnavailable, () => string>;

/** The reasons whose next step is to try again from the bar. */
const RETRIES: ReadonlySet<PreviewAiUnavailable> = new Set([
  PreviewAiUnavailable.SignedOut,
  PreviewAiUnavailable.NoDraft,
  PreviewAiUnavailable.Terms,
  PreviewAiUnavailable.LaneOff,
  PreviewAiUnavailable.HelperFailed,
  PreviewAiUnavailable.PlanNotReady,
]);

/** Why real models are not available, with the CLI's own words when the helper failed. */
export function unavailableWords(reason: PreviewAiUnavailable | null, error: string | null): string {
  const words = UNAVAILABLE_WORDS[reason ?? PreviewAiUnavailable.HelperFailed]();
  return error ? `${words} (${error})` : words;
}

/** Whether the bar offers Try again for this reason. */
export const offersRetry = (reason: PreviewAiUnavailable | null): boolean => reason !== null && RETRIES.has(reason);

/** What a retry from the unavailable state confirms again: the plan when it was the plan that failed. */
export const retryConfirms = (reason: PreviewAiUnavailable | null): PreviewAiConfirm =>
  reason === PreviewAiUnavailable.PlanNotReady ? PreviewAiConfirm.Plan : PreviewAiConfirm.Real;

/** What the bar shows for a game's state, and what the person is confirming, if anything. */
export function previewAiBarKind(
  state: PreviewAiState | undefined,
  confirming: PreviewAiConfirm | null,
): PreviewAiBarKind {
  if (!state) return PreviewAiBarKind.Hidden;
  if (state.mic === PreviewMicAsk.Asking) return PreviewAiBarKind.Mic;
  if (state.mode === PreviewAiMode.None) return PreviewAiBarKind.Hidden;
  if (confirming === PreviewAiConfirm.Real) return PreviewAiBarKind.Confirm;
  // A plan that stopped being ready while its confirmation was open has nothing left to confirm.
  if (confirming === PreviewAiConfirm.Plan && state.plans.length > 0) return PreviewAiBarKind.PlanConfirm;
  const kinds = {
    [PreviewAiMode.Practice]: PreviewAiBarKind.Practice,
    [PreviewAiMode.Starting]: PreviewAiBarKind.Starting,
    [PreviewAiMode.Live]: PreviewAiBarKind.Live,
    [PreviewAiMode.Plan]: PreviewAiBarKind.Plan,
    [PreviewAiMode.CapReached]: PreviewAiBarKind.CapReached,
    [PreviewAiMode.Unavailable]: PreviewAiBarKind.Unavailable,
  } as const;
  return kinds[state.mode];
}
