/**
 * A reviewer's one big move for a part (`{ what, why }`): the bold step the taste judge and the
 * playtester name beside their defects. Judges asked only for defects list hundreds of them and
 * never the one step their part needs; this is that step, as the director and a worker
 * read it. A module of its own, so a workspace that kept an older judge.ts still loads the parts
 * that read it.
 *
 * A move carries its typed `scope` (loop/scope.ts `MoveScope`) when the reviewer gave one: "adds"
 * is a step beyond what the user asked for, which the loop turns into a question for the user and
 * never into a move. A move without one deepens, as every reviewer's did before.
 */
import { clip, CLIP_REASON } from "./text.ts";
import { MoveScope } from "./scope.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** What a judge gave as its big move, as a record: an object, a bare sentence, or nothing. */
function asProposal(raw: unknown): AnyRecord | null {
  if (typeof raw === "string") return { what: raw };
  return raw && typeof raw === "object" ? (raw as AnyRecord) : null;
}

/** A proposal's typed scope, when it is one; anything else says nothing. */
function scopeOf(raw: unknown): MoveScope | null {
  return Object.values(MoveScope).find((scope) => scope === raw) ?? null;
}

/** A judge's big move for a part, or null when it named none: an object, or a bare sentence. */
export function normalizeBigMove(raw: unknown): { what: string; why: string; scope?: MoveScope } | null {
  const given = asProposal(raw);
  const what = typeof given?.what === "string" ? given.what.trim() : "";
  if (!what) return null;
  const why = typeof given?.why === "string" ? given.why.trim() : "";
  const scope = scopeOf(given?.scope);
  return { what: clip(what, CLIP_REASON), why: clip(why, CLIP_REASON), ...(scope ? { scope } : {}) };
}
