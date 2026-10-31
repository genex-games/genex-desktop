/**
 * The Genex account's credits as the Genex plugin's Credits tab shows them: the balance, the Pro
 * allowance and when it comes, the invite bonus, what each kind of generation costs (read live from
 * genex.games, never typed into the app) and the last few spends and refunds with their game. The
 * same prices and balance put a price on what is being made, where credits are spent.
 */
import { GenexOperation } from "./genex.ts";

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
  /** The guided character's 3D preview of the candidate the person approved. */
  CharacterPreview: "character_preview",
  /** The guided character's finished, rigged model, once its preview is approved. */
  CharacterFinalize: "character_finalize",
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

/**
 * The price list's kind for each Genex operation whose price it names exactly. A bare `character`
 * is left out: it is either the guided concept or a one-shot rigged character, priced apart.
 */
const OPERATION_KINDS: Partial<Record<string, CreditKind>> = {
  [GenexOperation.Model]: CreditKind.Model,
  [GenexOperation.ModelRig]: CreditKind.ModelRig,
  [GenexOperation.ModelAnimate]: CreditKind.ModelAnimation,
  [GenexOperation.Image]: CreditKind.Image,
  [GenexOperation.Texture]: CreditKind.Texture,
  [GenexOperation.Video]: CreditKind.Video,
  [GenexOperation.Sfx]: CreditKind.Sound,
  [GenexOperation.Music]: CreditKind.Music,
  [GenexOperation.Voice]: CreditKind.Voice,
  [GenexOperation.CharacterPreview]: CreditKind.CharacterPreview,
  [GenexOperation.CharacterFinalize]: CreditKind.CharacterFinalize,
};

/** What a Genex operation costs by default, from the price list; null when the list does not say. */
export function operationPrice(
  operation: string | null | undefined,
  prices: Readonly<Partial<Record<string, number>>> | null | undefined,
): number | null {
  // The plugin's word, never an inherited name (`constructor`) read off the table.
  if (!operation || !prices || !Object.hasOwn(OPERATION_KINDS, operation)) return null;
  const kind = OPERATION_KINDS[operation];
  return kind ? (prices[kind] ?? null) : null;
}

/**
 * Whether a balance pays for a price: an unlimited account always does, and an unread balance or
 * price is never taken for too little.
 */
export function canAfford(credits: { balance: number | null; unlimited: boolean }, price: number | null): boolean {
  if (credits.unlimited || credits.balance === null) return true;
  return price === null ? credits.balance > 0 : credits.balance >= price;
}

/** How many spends and refunds the tab lists. */
export const RECENT_CREDITS = 5;
/** Where Get credits leads: the plans page of the website at `web` (genex.games'), opened in the browser. */
export const creditsPlansUrl = (web: string): string => `${web}/plans`;
