/**
 * Steps beyond what the user asked for (scope.ts `isBeyondScope`), put to the user as decision cards,
 * so reviewers' moves never grow a game into systems nobody asked for (police and a pursuit meter
 * in a street race). Each proposal is asked about once, and a part asks at most
 * `BEYOND_CARDS_PER_PART` times: a taste judge names a big move every round, and one that rewords
 * the same idea each time would otherwise post a card a round. The cap is the part's for the whole
 * run: a card names its part and its proposal in typed fields, and a new start of the part's loop
 * (a Resume, or `worker_start replaces=`) reads them back from the run's log. The user's yes is a
 * steer; until then the step waits. A new module, so a kept older sibling can never shadow these names.
 */
import { clip, CLIP_QUOTE } from "../text.ts";
import { HostMethod } from "../host-methods.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { isBeyondScope } from "../scope.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { FacetLoopState } from "./state.ts";

/** How many cards about steps beyond the ask one part puts to the user, whoever proposed them. */
export const BEYOND_CARDS_PER_PART = 2;

/** What the user and the lead read about a step beyond the ask, by who proposed it. */
export const BEYOND_MESSAGE = {
  reviewer: (what: string) => `A reviewer proposes ${what}, which is outside what you asked; say so to add it`,
  planner: (what: string) => `The planner proposes ${what}, which is outside what you asked; say so to add it`,
  critic: (what: string) => `The critic proposes ${what}, which is outside what you asked; say so to add it`,
  player: (what: string) => `The player proposes ${what}, which is outside what you asked; say so to add it`,
  playerStep: (what: string) => ` — the player's big step: ${what}`,
  playerBeyond: (what: string) => ` — the player proposes ${what}, outside the ask: the user decides; never a move`,
} as const;

/** The part as a card about a step beyond the ask reads and records it. */
type BeyondLoop = Pick<FacetLoopState, "run" | "appendRun"> & {
  facet: AnyRecord;
  surfacedBeyond?: string[];
  /** Where the part's earlier cards are read back from; without both, only this start's memory counts. */
  ctx?: unknown;
  runThreadId?: string;
};

/** The loops that already read the part's earlier cards from the run's log: once per start of the loop. */
const recalled = new WeakSet<object>();

/**
 * Put one step beyond the ask to the user as a decision card: once per proposal, and never past the
 * part's cap. What was asked is kept on `loop.surfacedBeyond` (a yielded round carries it) and on the
 * card itself (`facetId`, `beyond`), which a new start of the part reads back (`recallAskedBeyond`).
 */
export async function askUserAboutBeyond(
  loop: BeyondLoop,
  proposal: AnyRecord,
  words: (what: string) => string,
): Promise<void> {
  const what = String(proposal.what ?? "").trim();
  if (!what) return;
  const asked = await recallAskedBeyond(loop);
  if (asked.includes(what) || asked.length >= BEYOND_CARDS_PER_PART) return;
  loop.surfacedBeyond = [...asked, what];
  await loop.appendRun(RunEvent.AutopilotDecision, {
    runId: loop.run.runId,
    decision: `${loop.facet.title ?? loop.facet.id}: ${words(clip(what, CLIP_QUOTE))}`,
    at: new Date().toISOString(),
    facetId: loop.facet.id,
    beyond: what,
  });
}

/**
 * What this part already put to the user in this run — this start's, and every earlier start's of
 * the same part (its id, and the workers it replaces as `director_worker` recorded them) — merged
 * into `loop.surfacedBeyond`. The log is read once per start of the loop; a log that cannot be read
 * leaves this start's own memory.
 */
export async function recallAskedBeyond(loop: BeyondLoop): Promise<string[]> {
  const own = loop.surfacedBeyond ?? [];
  if (recalled.has(loop)) return own;
  recalled.add(loop);
  const ctx = loop.ctx as AnyRecord | null | undefined;
  if (typeof ctx?.call !== "function" || !loop.runThreadId) return own;
  const events: unknown = await Promise.resolve()
    .then(() => ctx.call(HostMethod.EventsList, { threadId: loop.runThreadId }))
    .catch(() => []);
  if (!Array.isArray(events)) return own;
  const earlier = askedByPart(events, loop.run.runId, loop.facet.id);
  loop.surfacedBeyond = [...new Set([...earlier, ...(loop.surfacedBeyond ?? [])])];
  return loop.surfacedBeyond;
}

/** The proposals a part's cards in this run put to the user, oldest first, through its restarts. */
function askedByPart(events: unknown[], runId: unknown, facetId: unknown): string[] {
  const ofRun = events
    .map((event) => (event as AnyRecord | null)?.data as AnyRecord | undefined)
    .filter((data): data is AnyRecord => data?.type === EventKind.Custom && data.payload?.runId === runId);
  const part = partLineage(ofRun, facetId);
  return ofRun
    .filter((data) => data.event_type === RunEvent.AutopilotDecision && part.has(data.payload.facetId))
    .map((data) => data.payload.beyond)
    .filter((what): what is string => typeof what === "string" && what.trim() !== "");
}

/** A part's worker id and every worker it replaces, back to the first, as `director_worker` recorded them. */
function partLineage(ofRun: AnyRecord[], facetId: unknown): Set<unknown> {
  const replaced = new Map<unknown, string>();
  for (const data of ofRun) {
    const replaces = data.event_type === RunEvent.DirectorWorker ? data.payload.replaces : null;
    if (typeof replaces === "string" && replaces) replaced.set(data.payload.workerId, replaces);
  }
  const part = new Set<unknown>([facetId]);
  for (let id = replaced.get(facetId); id !== undefined && !part.has(id); id = replaced.get(id)) part.add(id);
  return part;
}

/**
 * What the lead reads about a playtester's big step, and the card for the user when it adds to the
 * ask: a step inside the ask reads as it always did, and one beyond it is the user's decision.
 */
export function playtestStepWords(bigMove: AnyRecord | null | undefined): { note: string; card: string | null } {
  const what = typeof bigMove?.what === "string" ? bigMove.what.trim() : "";
  if (!what) return { note: "", card: null };
  if (!isBeyondScope(bigMove)) return { note: BEYOND_MESSAGE.playerStep(what), card: null };
  const quoted = clip(what, CLIP_QUOTE);
  return { note: BEYOND_MESSAGE.playerBeyond(quoted), card: BEYOND_MESSAGE.player(quoted) };
}
