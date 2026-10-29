/**
 * Who a native game Play starts on this Mac is told the player is. Genex mints a native sign-in
 * ticket only for a game the player agreed may know who they are (App Review 4.7.3: per game and
 * account, remembered until withdrawn). Play mints; when Genex answers that the agreement is
 * missing, it asks the player once, records a yes on Genex and mints again. A no, a refusal or a
 * failure plays as a guest, and nothing is recorded. Electron-free: the question is a dependency.
 */
import { t } from "../../shared/i18n.ts";
import { type PlayTicket, TicketDelivery, TicketStatus } from "./gallery.ts";

/**
 * What Play asks before a native game may know who the player is: the same words as Genex's own
 * app asks with (one obligation, one sentence), and where to take it back in Studio.
 */
export const IDENTITY_QUESTION = {
  title: (game: string) => t("Let {game} know who you are?", { game }),
  detail: () =>
    t(
      "It will see your display name and avatar, so your progress and scores can be saved to your account. Games are code written by other people, not by Genex. You can stop sharing any time in Settings › Storage.",
    ),
  accept: () => t("Continue as me"),
  decline: () => t("Play as guest"),
} as const;

/** Words the person may see when stopping fails. */
const MESSAGE = {
  ForgetFailed: () => t("Genex couldn't stop sharing who you are with this game. Try again in a moment."),
} as const;

/** What Play asks the player about: the game that would learn who they are. */
export interface IdentityAsk {
  slug: string;
}

/** What starting a native game signed in takes. */
export interface NativeIdentityDeps {
  /** A sign-in ticket for the game, as the gallery mints one. */
  ticket(slug: string, delivery: TicketDelivery): Promise<PlayTicket>;
  /** Ask the player whether the game may know who they are: true for yes. */
  ask(question: IdentityAsk): Promise<boolean>;
  /** Record the player's yes for the game's project on Genex: true once Genex took it. */
  share(projectId: string): Promise<boolean>;
  /** Keep, for Settings, that this game now knows who the player is, under its project. */
  shared(slug: string, projectId: string): Promise<void>;
}

/** The ticket a native game starts with, or undefined to play as a guest. */
export async function nativeTicket(deps: NativeIdentityDeps, slug: string): Promise<string | undefined> {
  const first = await deps.ticket(slug, TicketDelivery.Native);
  if (first.status === TicketStatus.Minted) return first.ticket;
  if (first.status !== TicketStatus.ConsentRequired) return undefined;
  if (!(await deps.ask({ slug }))) return undefined;
  if (!(await deps.share(first.projectId))) return undefined;
  await deps.shared(slug, first.projectId);
  const second = await deps.ticket(slug, TicketDelivery.Native);
  return second.status === TicketStatus.Minted ? second.ticket : undefined;
}

/** What withdrawing the player's agreement for one installed game takes. */
export interface ForgetIdentityDeps {
  /** The Genex project the game knows the player under, or null when it knows nobody. */
  projectOf(slug: string): Promise<string | null>;
  /** Withdraw the agreement on Genex: true once Genex took it. */
  forget(projectId: string): Promise<boolean>;
  /** Remember (`projectId`) or forget (null) it here. */
  knowsYou(slug: string, projectId: string | null): Promise<void>;
}

/**
 * Stop sharing who the player is with an installed game: withdrawn on Genex first, then forgotten
 * here, so Settings never says it stopped while Genex still mints for it.
 */
export async function forgetNativeIdentity(deps: ForgetIdentityDeps, slug: string): Promise<void> {
  const projectId = await deps.projectOf(slug);
  if (!projectId) return;
  if (!(await deps.forget(projectId))) throw new Error(MESSAGE.ForgetFailed());
  await deps.knowsYou(slug, null);
}
