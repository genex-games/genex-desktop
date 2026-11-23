/**
 * The folder a new game gets, from its title. The app (`substrate/game-workspace.ts`) makes the
 * folder; the New game dialog shows the same name before it is made.
 */

/** A game's name in the library, which is also its folder's name in the games folder. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
/** The longest name a slug or a numbered duplicate is cut to. */
export const MAX_SLUG_LENGTH = 63;
/** Characters macOS or Windows keeps out of a file name, and the brackets a sandbox path reads as a glob. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|[\]]/g;
/** Leading dots (a hidden folder) and the trailing dots and spaces Windows drops from a name. */
const EDGE_DOTS_AND_SPACES = /^[\s.]+|[\s.]+$/g;
/** Windows device names, as Windows reads them: the part before the first dot, trailing spaces dropped. */
const DEVICE_STEM = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** The folder of a game whose title leaves nothing a file name can keep. */
const UNTITLED_FOLDER = "Untitled game";

/** A game's name in the games folder: its title in lowercase letters, digits and dashes. */
export function slugFromName(raw: string): string {
  const slug = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  if (PROJECT_NAME_RE.test(slug)) return slug;
  if (!slug) return "game";
  const padded = `game-${slug}`
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return PROJECT_NAME_RE.test(padded) ? padded : "game";
}

/**
 * The folder a game gets in a folder the user chose: the title as typed, made a name every file
 * system keeps — no separator, not hidden, no trailing dot or space, not a device. A title is at
 * most 80 UTF-16 units, so at most 240 bytes: the name always fits.
 */
export function folderNameFromTitle(title: string): string {
  const name = title.replace(UNSAFE_NAME_CHARS, "-").replace(EDGE_DOTS_AND_SPACES, "");
  if (!name) return UNTITLED_FOLDER;
  const [stem = "", ...rest] = name.split(".");
  if (!DEVICE_STEM.test(stem.trimEnd())) return name;
  return [`${stem.trimEnd()} game`, ...rest].join(".");
}
