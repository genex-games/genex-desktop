/**
 * The pictures an engine judge's probe took inside its play, by the trace of the session that
 * played. The host saves them in the game's captures folder as the play opens
 * (`editor-play-session.ts`) and keeps their paths here; the chat's judge line takes them by the
 * trace the harness's answer names. The harness is agent-editable, so a line shows only pictures
 * the host itself kept for that trace, once.
 */

/** How many traces' pictures are remembered; the oldest is forgotten first. */
const MAX_PROBED_TRACES = 200;

const pictures = new Map<string, string[]>();

/** The probe of the session whose trace is `tracePath` took these pictures (game-relative paths). */
export function keepProbePictures(tracePath: string, paths: readonly string[]): void {
  if (!paths.length) return;
  if (pictures.size >= MAX_PROBED_TRACES) {
    const oldest = pictures.keys().next().value;
    if (oldest !== undefined) pictures.delete(oldest);
  }
  pictures.set(tracePath, [...paths]);
}

/** The pictures kept for this trace, taken: a trace's pictures go with one line only. None for any other. */
export function takeProbePictures(tracePath: unknown): string[] {
  if (typeof tracePath !== "string") return [];
  const kept = pictures.get(tracePath) ?? [];
  pictures.delete(tracePath);
  return kept;
}
