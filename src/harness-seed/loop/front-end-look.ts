/**
 * Whether a pass judged a build on its front-end: the setup said `begin: false`, the game was on
 * its menu, and the drive pressed nothing (evidence.ts `PlayVia.Kept`). Every judge's game line
 * then says so instead of describing a drive that did not happen (kinds.ts gameLine).
 *
 * Its own module, reading evidence.ts through a namespace, so an upgraded judge.ts never asks a
 * kept, older evidence.ts for a name it does not have: a pass from such a module is never kept.
 */
import * as evidence from "./evidence.ts";

/** One pass's evidence, as far as this module reads it. */
interface PassOf {
  play?: { via?: unknown } | null;
}

/** True when the pass kept the game on its front-end and drove nothing. */
export function judgedOnFrontEnd(pass: PassOf | null | undefined): boolean {
  const kept: unknown = (evidence as { PlayVia?: { Kept?: unknown } }).PlayVia?.Kept;
  return kept !== undefined && pass?.play?.via === kept;
}
