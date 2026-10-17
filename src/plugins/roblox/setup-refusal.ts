/**
 * Why Roblox Studio setup wrote nothing: one vocabulary for Set up, the MCP switch and Undo, so
 * the backend answers the panel with a code and the person reads the error's own plain sentence.
 */

/** Why setup or Undo refused before writing anything. Wire values: never rename. */
export const SetupRefusal = {
  /** Studio runs: it rewrites its settings file itself, so Genex writes only while it is closed. */
  StudioRunning: "studio-running",
  /** A home or LOCALAPPDATA that isn't a full path of this system, or a system Studio doesn't run on. */
  OtherSystem: "other-system",
  /** Documents › Roblox (or %LOCALAPPDATA%\Roblox) isn't there: Studio makes it the first time it runs. */
  NoRobloxFolder: "no-roblox-folder",
  /** A link where Genex would write or read: it is never followed. */
  Linked: "linked",
  /** Something other than a folder where a folder belongs, or a folder where a file belongs. */
  NotAFolder: "not-a-folder",
  /** An account's settings file Genex can't read as one JSON object of a sane size. */
  UnreadableSettings: "unreadable-settings",
  /** Undo with nothing Genex set up. */
  NotSetUp: "not-set-up",
} as const;
export type SetupRefusal = (typeof SetupRefusal)[keyof typeof SetupRefusal];

/** A refusal with its code and the sentence the person reads. */
export class RobloxSetupError extends Error {
  readonly code: SetupRefusal;

  constructor(code: SetupRefusal, message: string) {
    super(message);
    this.name = "RobloxSetupError";
    this.code = code;
  }
}
