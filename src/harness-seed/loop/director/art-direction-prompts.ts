/**
 * What the art director's look says to the lead when the lead asks for it (tools.ts `judge
 * ship=yes`, integrate.ts `finish`): ship or not, the defects grouped by the part that owns them, and
 * the finish mark's rule. A second opinion, which decides nothing (Loop phase 4). Plain facts in,
 * text out. A new module: it imports only from modules as new as it, so a seed upgrade never finds it
 * older than a caller.
 */
import { DefectSeverity } from "../ship-review.ts";
import { blockersOf } from "../ship-blockers.ts";
import { shortSha } from "../git.ts";
import type { ShipDefect } from "../ship-review.ts";

/** The question every ship review is asked, as the verdict record names it. */
export const SHIP_QUESTION = "Would you ship this as the user's demo today?";

/** The group of the defects no plan part owns: the lead's. */
export const NO_PART = "no part — yours";

/** The rule from the finish mark on, and after a look that names a blocker, as the lead reads it. */
export const FINISH_MARK_RULE =
  "From here no new parts or systems: finish what exists. worker_steer stage=finish on each running owner of a part you want finished (or, for a finished part, worker_start stage=finish replaces=<its id> owns=<its files> from=integration, which takes that part's blockers on its board). Integrate; judge ship=yes only when you want the art director's opinion.";

/**
 * What a goal build's card and brief say of the art director's defects, when the lead asked for its
 * look: its blockers are worth finishing, its visible flaws and nits are the user's report, and none
 * of it holds the finish back.
 */
export const SHIP_DEFECTS_NOT_POLISH =
  "When you ask the art director, its blockers are worth finishing and its visible flaws and nits go in your report; its word holds nothing back.";

/** What a ship defect on a worker's board is, as its steer says it. */
export interface ShipSteerFacts {
  /** The defect's words, as its check names it. */
  defect: string;
  /** The question's id on the worker's board. */
  checkId: string;
  /** How much it matters: only a blocker reaches a board (art-direction.ts `routeShipDefects`). */
  severity: DefectSeverity;
  /** The review's verdict: ship, not ship, or none read. */
  ship: boolean | null;
  /** The worker finishes its part (`stage=finish`), or the run is past its finish mark: the defects are its round's work, not beside a move. */
  finishing: boolean;
}

/** How the steer opens, by the review's verdict: a build the art director would ship never reads as one it would not. */
function steerOpening(ship: boolean | null): string {
  if (ship === false) return "The art director looked at the whole game and would not ship it with this, in your part";
  if (ship === true) return "The art director would ship the game, but a player notices this in your part";
  return "The art director named this in your part";
}

/**
 * What the owner of a blocker is told when it lands on its board, by the review's verdict: worth
 * fixing — a finisher's round's work, and for a worker still building, beside its move, never ahead
 * of it — and never what its part's own contract is.
 */
export function shipSteer({ defect, checkId, severity, ship, finishing }: ShipSteerFacts): string {
  const work = finishing ? "it is this round's work" : "fix it beside your move, never instead of it";
  return `${steerOpening(ship)}: "${defect}" (${severity}). It is on your board as ${checkId}, a second opinion worth fixing — ${work}.`;
}

/** What to do next when the art director names no blocker: its other defects are the report's. */
const NO_BLOCKER_NEXT =
  "The art director names no blocker: its visible flaws and nits go in your report and never start a round (fix a quick one yourself if you like). Finish when you judge the goal reached.";

/** What to do next when nobody could read the art director's answer. */
const SHIP_UNREAD_NEXT =
  "The art director's answer could not be read — no verdict either way: go on, and judge ship=yes again later.";

/** Why the studio's own look at the finish mark did not happen: kept for a kept older wake.ts or art-direction.ts, which still say it. */
export const ART_SKIPPED = {
  nothingNew: "the integration branch has nothing beyond the starting point yet",
  doesNotLoad: "the integrated build did not load at its last look",
  notJudged: "the art director could not look at the integrated build",
  stopped: "the run is stopping",
  olderTools: "this workspace keeps an older tools.ts without the art director",
} as const;

/** Why `judge ship=yes` with another build named is refused: the look is absolute, at its own size. */
export const SHIP_ALONE =
  "judge ship=yes looks at one build on its own at 1600x900, so it is never compared with a build seen at another size: leave out against (or say against=none), and compare builds in a judge call of their own.";

/** The run's note when a goal build's finish closed before the art director could look: kept for a kept older art-direction.ts. */
export function shipGateSkipped(head: string | null): string {
  return `the art director did not look at ${shortSha(head)} before this finish: the close's own blind judge against the start needs the finish call's time — judge ship=yes before finishing to have its word`;
}

/** The art director's answer as a review has it. */
interface ShipWords {
  ship: boolean | null;
  defects: readonly ShipDefect[];
  /** What already works and must stay (absent from a review kept before the list). */
  doNotRegress?: readonly string[];
}

/** The heading of the regular look's paragraph: whose look it is, and that it is not the finish mark. */
const SHIP_LOOK_HEADING =
  "THE ART DIRECTOR'S LOOK AT THE WHOLE GAME — the studio's regular look while workers build, not the finish mark";

/** What the lead does after a regular look: its blockers are already with their owners, and building goes on. */
const SHIP_LOOK_NEXT =
  "Each blocker is on its owner's board — a building owner fixes it beside its move — or, for a part nobody builds now, on your ledger; visible flaws and nits are for your report, never a round. The build stage goes on: no finish stage before the finish mark.";

/** The do-not-regress list in a line, as the lead reads it, or nothing when the review named none. */
function doNotRegressLine(review: ShipWords): string {
  const items = review.doNotRegress ?? [];
  if (!items.length) return "";
  return `DO NOT REGRESS (every loop worker's brief carries this): ${items.join("; ")}`;
}

/** One defect in a line: how much it matters, what, and where it shows. */
export function defectLine(defect: ShipDefect): string {
  return `${defect.severity}: ${defect.what}${defect.camera ? ` (${defect.camera})` : ""}`;
}

/** The defects grouped by the part that owns them; those no part owns under `NO_PART`. */
export function defectsByPart(defects: readonly ShipDefect[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const defect of defects) {
    const part = defect.part ?? NO_PART;
    groups[part] = [...(groups[part] ?? []), defectLine(defect)];
  }
  return groups;
}

/** How many of the defects a player would notice: blockers and visible ones. */
export const noticed = (defects: readonly ShipDefect[]): number =>
  defects.filter((d) => d.severity !== DefectSeverity.Nit).length;

/** The line that says what to do after a ship review: a blocker is finished by its owner; anything less is the report's. */
export function shipNext({ ship, defects }: ShipWords): string {
  if (ship === null) return SHIP_UNREAD_NEXT;
  return blockersOf(defects).length ? FINISH_MARK_RULE : NO_BLOCKER_NEXT;
}

/** Ship or not, in the words a sentence starts with. */
function verdictWords({ ship }: ShipWords): string {
  if (ship === true) return "would ship";
  if (ship === false) return "would not ship";
  return "gave no readable answer about";
}

/**
 * The wake's paragraph at the finish mark after the studio's own look: kept for a kept older wake.ts,
 * which still runs that look (the shipped one says the rule alone, finish-mark-prompts.ts).
 */
export function artDirectionBlock({
  head,
  review,
  skipped = null,
}: {
  head: string | null;
  review: ShipWords | null;
  skipped?: string | null;
}): string {
  const heading = "THE FINISH MARK — the art director's look at the whole game";
  if (!review) return [heading, `- no ship review: ${skipped ?? ART_SKIPPED.notJudged}`, FINISH_MARK_RULE].join("\n");
  return [heading, ...reviewLines(head, review), shipNext(review)].filter(Boolean).join("\n");
}

/** A review's verdict on the integrated build, its defects by part, and what must not regress. */
function reviewLines(head: string | null, review: ShipWords): string[] {
  const groups = Object.entries(defectsByPart(review.defects)).map(
    ([part, lines]) => `- ${part}: ${lines.join(" | ")}`,
  );
  return [
    `The art director ${verdictWords(review)} the integrated build ${shortSha(head)} as the user's demo today.`,
    ...(groups.length ? ["DEFECTS BY PART:", ...groups] : ["- no defects named"]),
    doNotRegressLine(review),
  ];
}

/**
 * The wake's paragraph after the studio's regular look at the whole game: kept for a kept older
 * wake.ts, which still runs that look (the shipped one never does, Loop phase 4).
 */
export function shipLookBlock({
  head,
  review,
  skipped = null,
}: {
  head: string | null;
  review: ShipWords | null;
  skipped?: string | null;
}): string {
  if (!review)
    return [
      SHIP_LOOK_HEADING,
      `- no ship review: ${skipped ?? ART_SKIPPED.notJudged}; the studio looks again later`,
    ].join("\n");
  return [SHIP_LOOK_HEADING, ...reviewLines(head, review), SHIP_LOOK_NEXT].filter(Boolean).join("\n");
}

/** What `finish` adds about the art director's last look at the head it closed on, or nothing. */
export function shipFinishLine(review: ShipWords | null): string {
  if (!review || review.ship === null) return "";
  const blockers = blockersOf(review.defects).length;
  const flaws = review.defects.length - blockers;
  const report = flaws ? `; ${flaws} visible flaws and nits for your report` : "";
  if (blockers)
    return ` The art director names ${blockers} blocker${blockers === 1 ? "" : "s"} on this build${report} — say so, and claim no more.`;
  return ` The art director names no blocker on this build${report}.`;
}

/** Why a goal build's first finish was turned back on the art director's blockers: kept for a kept older art-direction.ts. */
export function shipFinishRefusal(review: ShipWords): string {
  const groups = Object.entries(defectsByPart(blockersOf(review.defects))).map(
    ([part, lines]) => `${part}: ${lines.join(" | ")}`,
  );
  return `finish turned back once: the art director names blockers on this build — ${groups.join("; ")}. ${FINISH_MARK_RULE} Calling finish again with victory=no closes the build as it stands; a claim waits until no blocker stands.`;
}
