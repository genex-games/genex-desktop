/**
 * A native game's AI budget from its page in Play: the read, the quote, Approve and Stop. The
 * renderer names a game only by its address and chooses only a limit; main finds the game's id in
 * the catalog and keeps the quote an approval names (`play/ai-budget.ts`). A payload that is not
 * exactly the call's own is refused before genex.games hears of it.
 */
import { isPlaySlug } from "../../shared/play.ts";
import { type AiBudgetRead, AiBudgetRefusal } from "../../shared/play-ai-budget.ts";
import type { PlayAiBudget } from "../play/ai-budget.ts";
import { SignInNeeded } from "../play/gallery.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a call is refused: each answers only a malformed call from our own renderer. */
const MESSAGE = {
  badCall: "not an AI budget call",
  badSlug: "not a game address",
  badLimit: "not a whole number of credits",
} as const;

const SIGNED_OUT: AiBudgetRead = { signedOut: true, declared: null, current: null };

/** What the AI budget's channels answer from. */
export interface AiBudgetIpcDeps {
  budget: PlayAiBudget;
}

/** The payload's fields when it is a plain object with exactly `keys`; throws for anything else. */
function fieldsOf(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  const plain = typeof payload === "object" && payload !== null && !Array.isArray(payload);
  if (!plain) throw new Error(MESSAGE.badCall);
  const sent = Object.keys(payload);
  const exact = sent.length === keys.length && keys.every((key) => Object.hasOwn(payload, key));
  if (!exact) throw new Error(MESSAGE.badCall);
  return Object.fromEntries(Object.entries(payload));
}

/** The game address a payload names; throws for anything else. */
function slugOf(fields: Record<string, unknown>): string {
  if (!isPlaySlug(fields.slug)) throw new Error(MESSAGE.badSlug);
  return fields.slug;
}

/** A write's answer, with the app signed out told by its code instead of thrown. */
async function refusedSignedOut<T>(call: Promise<T>): Promise<T | { refused: AiBudgetRefusal }> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof SignInNeeded) return { refused: AiBudgetRefusal.SignedOut };
    throw error;
  }
}

/** Register the AI budget's four channels. */
export function registerAiBudgetIpc(handle: IpcHandle, { budget }: AiBudgetIpcDeps): void {
  handle("studio:play.ai-budget", async (payload) => {
    const slug = slugOf(fieldsOf(payload, ["slug"]));
    try {
      return await budget.status(slug);
    } catch (error) {
      if (error instanceof SignInNeeded) return SIGNED_OUT;
      throw error;
    }
  });
  handle("studio:play.ai-budget-open", (payload) => refusedSignedOut(budget.open(slugOf(fieldsOf(payload, ["slug"])))));
  handle("studio:play.ai-budget-confirm", (payload) => {
    const fields = fieldsOf(payload, ["slug", "limitCredits"]);
    const slug = slugOf(fields);
    const { limitCredits } = fields;
    if (typeof limitCredits !== "number" || !Number.isSafeInteger(limitCredits)) throw new Error(MESSAGE.badLimit);
    return refusedSignedOut(budget.confirm(slug, limitCredits));
  });
  handle("studio:play.ai-budget-stop", (payload) => refusedSignedOut(budget.stop(slugOf(fieldsOf(payload, ["slug"])))));
}
