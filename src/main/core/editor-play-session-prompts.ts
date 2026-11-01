/**
 * What a session reads in its first answer from a game played in its editor
 * (`editor-play-session.ts`): the live-data warning.
 */

/** The notes the play adds to the session's first answer. */
export const EDITOR_PLAY_PROMPTS = {
  liveData:
    "Saved data in this play is the live game's: play only as the test players this play opened, and never change a real player's saved data.",
} as const;
