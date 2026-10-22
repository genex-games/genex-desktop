/**
 * The Genex account's credits as the Genex plugin's Credits tab shows them: the balance, the Pro
 * allowance and when it comes, the invite bonus, what each kind of generation costs (read live from
 * genex.games, never typed into the app) and the last few spends and refunds with their game.
 */
/** Kinds of generation the price list names. Wire values, as genex.games spells them. */
export const CreditKind = {
  Model: "model",
  ModelRig: "model_rig",
  ModelAnimation: "model_animation",
  Image: "image",
  Video: "video",
  Texture: "texture",
  Sound: "sfx",
  Music: "music",
  Voice: "voice",
  Character: "character",
  CoverRegenerate: "cover_regen",
} as const;
export type CreditKind = (typeof CreditKind)[keyof typeof CreditKind];

/** Whether a value is one of the kinds the app names. */
export const isCreditKind = (value: unknown): value is CreditKind =>
  typeof value === "string" && (Object.values(CreditKind) as string[]).includes(value);

/** The kinds the Credits tab lists under "What credits pay for", in its order. */
export const PRICED_KINDS = [
  CreditKind.Model,
  CreditKind.Character,
  CreditKind.ModelAnimation,
  CreditKind.Image,
  CreditKind.Texture,
  CreditKind.Video,
  CreditKind.Music,
  CreditKind.Sound,
  CreditKind.Voice,
] as const satisfies readonly CreditKind[];

/** One spend or refund. */
export interface CreditEntry {
  id: string;
  /** Credits: negative for a spend, positive for a refund. */
  amount: number;
  kind: CreditKind | null;
  refund: boolean;
  /** When (ISO). */
  at: string;
  /** The game it was for, when genex.games names one. */
  game: string | null;
}

/** The Pro allowance: how much comes, and when (ISO), or null when genex.games does not say. */
export interface CreditPlan {
  allowance: number;
  resetsAt: string | null;
}

/** Everything the Credits tab reads at once. */
export interface PlayCredits {
  /** Spendable credits, or null when unread. */
  balance: number | null;
  /** The account never runs out. */
  unlimited: boolean;
  /** The account's Pro plan, or null when it has none (or plans are off). */
  plan: CreditPlan | null;
  /** Credits for each person who joins from the account's invite link, or null when unread. */
  inviteBonus: number | null;
  /** The cheapest price of each kind, in credits; a kind genex.games did not price is missing. */
  prices: Partial<Record<CreditKind, number>>;
  /** The last few spends and refunds, newest first. */
  recent: CreditEntry[];
}

/** How many spends and refunds the tab lists. */
export const RECENT_CREDITS = 5;
/** Where Get credits leads: the plans page of the website at `web` (genex.games'), opened in the browser. */
export const creditsPlansUrl = (web: string): string => `${web}/plans`;
