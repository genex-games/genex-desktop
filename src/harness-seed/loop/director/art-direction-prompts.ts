/**
 * What the art director's look says to the lead (director/art-direction.ts, tools.ts `judge
 * ship=yes`, integrate.ts `finish`): ship or not, the defects grouped by the part that owns them,
 * and the rule from the finish mark on. Plain facts in, text out. A new module: it imports only
 * from modules as new as it, so a seed upgrade never finds it older than a caller.
 */
import { DefectSeverity } from "../ship-review.ts";
import { shortSha } from "../git.ts";
import type { ShipDefect } from "../ship-review.ts";

/** The question every ship review is asked, as the verdict record names it. */
export const SHIP_QUESTION = "Would you ship this as the user's demo today?";

/** The group of the defects no plan part owns: the lead's. */
export const NO_PART = "no part — yours";

/** The rule from the finish mark on, as the lead reads it. */
export const FINISH_MARK_RULE =
  "From here no new parts or systems: finish what exists. worker_steer stage=finish on each running owner of a part with defects (or, for a finished part, worker_start stage=finish replaces=<its id> owns=<its files> from=integration, which takes that part's defects on its board); a finish round may win on polish. Integrate, then judge ship=yes again.";

/**
 * What a goal build's card and brief say of the art director's defects: a goal build reports
 * blockers instead of optional polish, and the art director's blocker and visible defects are not
 * that polish — its look turns a goal build's first finish back with them.
 */
export const SHIP_DEFECTS_NOT_POLISH =
  "The art director's blocker and visible defects are required finishing, not optional polish; its nits stay optional.";

/** What a ship defect on a worker's board is, as its steer says it. */
export interface ShipSteerFacts {
  /** The defect's words, as its check names it. */
  defect: string;
  /** The question's id on the worker's board. */
  checkId: string;
  /** How much it matters: a nit is optional polish; a blocker or visible defect is the work. */
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
 * What the owner of a ship defect is told when it lands on its board, by the review's verdict and
 * the defect's severity: a nit is optional polish that decides nothing; a blocker or a visible
 * defect must be gone before the part is done — a finisher's round's work, and for a worker still
 * building, beside its move, never ahead of it.
 */
export function shipSteer({ defect, checkId, severity, ship, finishing }: ShipSteerFacts): string {
  if (severity === DefectSeverity.Nit) {
    const when = finishing ? "take it if this round has room" : "never ahead of your move";
    return `The art director noticed a nit in your part: "${defect}" (${checkId} on your board). It is optional polish — ${when}; it decides nothing.`;
  }
  const work = finishing ? "it is this round's work" : "fix it beside your move, never instead of it";
  return `${steerOpening(ship)}: "${defect}" (${severity}). It is on your board as ${checkId} and must be gone before your part is done — ${work}.`;
}

/** What to do next when the art director would ship the build. */
const SHIP_YES_NEXT =
  "The art director would ship this build: hand any nits left to their owners with stage=finish, or finish.";

/** What to do next when nobody could read the art director's answer. */
const SHIP_UNREAD_NEXT =
  "The art director's answer could not be read — no verdict either way: go on, and judge ship=yes again later.";

/** Why the studio's own look at the finish mark did not happen, in the lead's words. */
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

/** The run's note when a goal build's finish closes before the art director could look. */
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

/** What the lead does after a regular look: its defects are already with their owners, and building goes on. */
const SHIP_LOOK_NEXT =
  "Each defect is on its owner's board — a building owner fixes it beside its move — or, for a part nobody builds now, on your ledger. The build stage goes on: no finish stage before the finish mark. Steer by the verdict, not by single defects.";

/** The do-not-regress list in a line, as the lead reads it, or nothing when the review named none. */
function doNotRegressLine(review: ShipWords): string {
  const items = review.doNotRegress ?? [];
  if (!items.length) return "";
  return `DO NOT REGRESS (every loop worker's brief and its taste judge carry this): ${items.join("; ")}`;
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

/** The line that says what to do after a ship review. */
export function shipNext({ ship, defects }: ShipWords): string {
  if (ship === null) return SHIP_UNREAD_NEXT;
  if (ship && !noticed(defects)) return SHIP_YES_NEXT;
  return FINISH_MARK_RULE;
}

/** Ship or not, in the words a sentence starts with. */
function verdictWords({ ship }: ShipWords): string {
  if (ship === true) return "would ship";
  if (ship === false) return "would not ship";
  return "gave no readable answer about";
}

/**
 * The wake's paragraph at the finish mark: what the art director said of the integrated build,
 * its defects by part, and the rule — or, when it could not look, why, and the rule all the same.
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
 * The wake's paragraph after the art director's regular look (art-direction.ts `shipLookPass`):
 * the verdict, the defects by part, what must not regress, and that the build stage goes on — or,
 * when it could not look, why, and that the studio looks again later.
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
  const left = review.defects.length;
  if (review.ship)
    return left
      ? ` The art director would ship this build; ${left} defects left.`
      : " The art director would ship this build.";
  return ` The art director would not ship this build; ${left} defects left — say so, and claim no more.`;
}

/** Why a goal build's first finish is turned back: the art director's look found what to finish. */
export function shipFinishRefusal(review: ShipWords): string {
  const groups = Object.entries(defectsByPart(review.defects)).map(([part, lines]) => `${part}: ${lines.join(" | ")}`);
  return `finish turned back once: the art director would not ship this build — ${groups.join("; ") || "no defects named"}. ${FINISH_MARK_RULE} Calling finish again closes the build as it stands.`;
}
