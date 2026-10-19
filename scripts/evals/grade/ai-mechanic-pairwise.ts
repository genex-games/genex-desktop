/**
 * The blind pairwise mechanic judge (the AI archetype cases): which of two runs' games uses its AI
 * as a game mechanic, from each game's saved AI calls and its replay with no answer — never from its
 * code. An eval-owned rubric (`ai-mechanic-pairwise-prompt.md`, refused if it names the Studio
 * contract, an incumbent or a placeholder, like the pairwise rubric); every pair is judged in both
 * orders, and only two orders that agree make a win. An unreadable reply or a failed call is
 * `invalid`, never a tie.
 */
import { readFile } from "node:fs/promises";
import { PairOutcome, PairPick } from "../vocabulary.ts";
import type { GraderComplete, GraderPrompt } from "./checklist/complete.ts";
import { type PairwiseRubric, pairwiseRubricSha, PairwiseRubricError, rubricViolations } from "./pairwise.ts";
import type { AiPlayEvidence } from "./ai-play.ts";
import type { GraderPin } from "./types.ts";

/** Where the rubric lives, beside this module. */
export const AI_MECHANIC_PAIRWISE_RUBRIC_FILE = new URL("./ai-mechanic-pairwise-prompt.md", import.meta.url);
/** The most calls one side quotes, and how much of one answer. */
const CALLS_SHOWN = 20;
const VALUE_CHARS = 300;
/** The one line a reply answers on. */
const PICK_LINE = /^\s*MECHANIC:\s*(LEFT|RIGHT|TIE)\s*$/im;

/** Read and check the rubric; one with a violation is refused, never used. */
export async function readAiMechanicRubric(
  file: URL | string = AI_MECHANIC_PAIRWISE_RUBRIC_FILE,
): Promise<PairwiseRubric> {
  const text = await readFile(file, "utf8");
  const violations = rubricViolations(text);
  if (violations.length > 0) throw new PairwiseRubricError(violations);
  return { text, sha: pairwiseRubricSha(text) };
}

/** One side's evidence: its saved calls, clipped, and its demos with no answer. */
function sideText(side: string, evidence: AiPlayEvidence): string {
  const calls = evidence.tapes
    .flatMap((tape) =>
      tape.lines.map((line) => `- ${tape.demo} · ${line.site}: ${JSON.stringify(line.value).slice(0, VALUE_CHARS)}`),
    )
    .slice(0, CALLS_SHOWN);
  const noAnswer = evidence.noAnswer.map(
    (replay) =>
      `- ${replay.demo}: ${replay.settled ? "ended cleanly" : "crashed, logged an error or never ended"}${replay.stuck ? `, ${replay.stuck} calls left waiting` : ""}`,
  );
  return [
    `${side} — AI CALLS SAVED WHILE THE DEMO PLAYED (${calls.length}):`,
    ...(calls.length ? calls : ["- none"]),
    `${side} — THE SAME DEMOS WITH NO AI ANSWER:`,
    ...(noAnswer.length ? noAnswer : ["- not replayed"]),
  ].join("\n");
}

/** The prompt for one order. */
export function aiMechanicPairPrompt(
  rubric: PairwiseRubric,
  brief: string,
  left: AiPlayEvidence,
  right: AiPlayEvidence,
): GraderPrompt {
  return {
    text: [
      rubric.text.trim(),
      `WHAT THE PERSON ASKED FOR:\n${brief}`,
      sideText("LEFT", left),
      sideText("RIGHT", right),
    ].join("\n\n"),
    images: [],
  };
}

/** A reply's pick, or invalid. */
export function readAiMechanicPick(text: string): PairPick {
  const match = PICK_LINE.exec(text);
  if (!match) return PairPick.Invalid;
  return (
    { LEFT: PairPick.Left, RIGHT: PairPick.Right, TIE: PairPick.Tie }[match[1]?.toUpperCase() ?? ""] ?? PairPick.Invalid
  );
}

/** Ask one order; a failed call is invalid. */
async function pickOf(complete: GraderComplete, pin: GraderPin, prompt: GraderPrompt): Promise<PairPick> {
  try {
    return readAiMechanicPick((await complete(pin, prompt)).text);
  } catch {
    return PairPick.Invalid;
  }
}

/** The pair's outcome from the two orders' picks, each read as which game it chose. */
export function mechanicOutcome(firstLeft: PairPick, firstRight: PairPick): PairOutcome {
  if (firstLeft === PairPick.Invalid || firstRight === PairPick.Invalid) return PairOutcome.Invalid;
  const chose = (pick: PairPick, firstSide: PairPick) => {
    if (pick === PairPick.Tie) return PairOutcome.Tie;
    return pick === firstSide ? PairOutcome.First : PairOutcome.Second;
  };
  const one = chose(firstLeft, PairPick.Left);
  const two = chose(firstRight, PairPick.Right);
  return one === two ? one : PairOutcome.PositionInconsistent;
}

/** Judge a pair in both orders: the first run's game on the left, then on the right. */
export async function judgeAiMechanicPair({
  complete,
  pin,
  rubric,
  brief,
  first,
  second,
}: {
  complete: GraderComplete;
  pin: GraderPin;
  rubric: PairwiseRubric;
  brief: string;
  first: AiPlayEvidence;
  second: AiPlayEvidence;
}): Promise<{ outcome: PairOutcome; picks: [PairPick, PairPick]; rubricSha: string }> {
  const firstLeft = await pickOf(complete, pin, aiMechanicPairPrompt(rubric, brief, first, second));
  const firstRight = await pickOf(complete, pin, aiMechanicPairPrompt(rubric, brief, second, first));
  return { outcome: mechanicOutcome(firstLeft, firstRight), picks: [firstLeft, firstRight], rubricSha: rubric.sha };
}
