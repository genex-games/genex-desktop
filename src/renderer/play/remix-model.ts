/**
 * A remix being made, as Create shows it (`RemixLayer` and the sidebar's row): the line under the
 * stage's loader, the step bar's segments, and how far round its row's ring it has come.
 */
import { RemixStep } from "../../shared/play.ts";
import { type RemixUnderway, RemixView } from "../state/play.ts";
import { type StepSegment, stepStateAt } from "../ui/step-bar.ts";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.making;
const MEGABYTE = 1024 * 1024;
/** The steps in the order a remix takes them. */
const STEPS: readonly RemixStep[] = [RemixStep.Copy, RemixStep.Models, RemixStep.Packages, RemixStep.Build];
/** Where each step starts round the ring, by how long it usually takes; the models fill theirs by bytes. */
const RING_FROM: Readonly<Record<RemixStep, number>> = {
  [RemixStep.Copy]: 0.04,
  [RemixStep.Models]: 0.08,
  [RemixStep.Packages]: 0.45,
  [RemixStep.Build]: 0.85,
};

const megabytes = (bytes: number): number => Math.round(bytes / MEGABYTE);

/** The games the sidebar lists beside a remix being made: its own game, `adopted` once it is, has the remix's row. */
export function besideRemix<T extends { name: string }>(games: readonly T[], adopted: string | null): readonly T[] {
  return adopted ? games.filter((game) => game.name !== adopted) : games;
}

/** Whether a remix shows over Create: from the press until its game is open, unless set aside. */
export const remixCovers = (making: RemixUnderway | null): boolean =>
  making !== null && making.view !== RemixView.Aside;

/**
 * Whether the person is still with a remix that just ended: it covers Create and nothing (Play,
 * Plugins) is over Create. Its game opens for them, or Play comes back after a failure; anyone who
 * went elsewhere keeps their place and is told.
 */
export const stillWithRemix = (making: RemixUnderway | null, workspaceCovered: boolean): boolean =>
  remixCovers(making) && !workspaceCovered;

/** The models' megabytes while they download, "31 of 44 MB"; null before the first are counted. */
function megabytesSoFar(making: RemixUnderway): string | null {
  const { step, done, total } = making;
  if (step !== RemixStep.Models || done === null) return null;
  return total ? WORDS.megabytesOf(megabytes(done), megabytes(total)) : WORDS.megabytes(megabytes(done));
}

/** What the stage says under its loader: the step, and the models' megabytes while they download. */
export function remixLine(making: RemixUnderway): string {
  const line = WORDS.line[making.step];
  const bytes = megabytesSoFar(making);
  return bytes ? WORDS.measured(line, bytes) : line;
}

/** The step bar: the steps before this one done, this one under way, the rest to come. */
export function remixSegments(making: RemixUnderway): StepSegment[] {
  const at = STEPS.indexOf(making.step);
  return STEPS.map((step, index) => ({ key: step, label: WORDS.steps[step], state: stepStateAt(index, at) }));
}

/** How far round the row's ring the remix has come, 0 to 1: its step's start, the models by their bytes. */
export function remixShare(making: RemixUnderway): number {
  const { step, done, total } = making;
  const from = RING_FROM[step];
  const counted = step === RemixStep.Models && done !== null && total;
  if (!counted) return from;
  return from + (RING_FROM[RemixStep.Packages] - from) * Math.min(1, done / total);
}
