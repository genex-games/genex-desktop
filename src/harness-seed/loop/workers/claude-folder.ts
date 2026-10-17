/**
 * Claude Code's own folder in a game: the settings, hooks, commands and skills a session started
 * there loads. No worker's work brings changes to it into the game (the host refuses the same in a
 * landing or a promotion); the seed's copy of the host's rule (`substrate/paths.ts`
 * `throughClaudeFolder`), held to it by `seed-contracts.test.ts`.
 */

/** The folder's name. */
const CLAUDE_FOLDER = ".claude";
/** A name's trailing dots and spaces, which Windows drops when it opens the name. */
const WINDOWS_TRAILING = /[. ]+$/;

/**
 * Whether a path relative to the game goes through a `.claude` folder, at any depth, named the
 * way a case-insensitive file system and Windows read a name: in any case, without trailing dots
 * or spaces, and without a stream suffix (`.claude::$DATA`).
 */
export function throughClaudeFolder(rel: string): boolean {
  return rel.split(/[\\/]+/).some((segment) => {
    const name = (segment.split(":")[0] ?? "").replace(WINDOWS_TRAILING, "").toLowerCase();
    return name === CLAUDE_FOLDER;
  });
}
