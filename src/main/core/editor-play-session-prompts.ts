/**
 * What a judge's session reads in its first answer from a game played in its editor
 * (`editor-play-session.ts`): its brief, what its probe measured, and the live-data warning.
 */

/** The notes the play adds to the judge's first answer. */
export const EDITOR_PLAY_PROMPTS = {
  liveData:
    "Saved data in this play is the live game's: play only as the test players this play opened, and never change a real player's saved data.",
  probed: (label: string, note: string) => `What the ${label} judge's probe measured once the play opened: ${note}`,
  probeFailed: (label: string, why: string) => `The ${label} judge's probe could not measure the play: ${why}`,
  brief: (label: string, brief: string) => `Your brief as the ${label} judge:\n${brief}`,
} as const;
