/** What the round's gate tells a builder about changes the lead made to its own files. */
import { shortSha } from "../git.ts";

/** How many of those files the note names before it counts the rest. */
const NAMED_FILES = 6;

/**
 * The note a part's builder gets when the integration merge brought edits to files it owns that it
 * did not make: the lead's integration fixes. They are kept, never reverted as somebody's accident.
 */
export function leadChangesNote(files: readonly string[], head: string): string {
  const named = files.slice(0, NAMED_FILES).join(", ");
  const more = files.length > NAMED_FILES ? ` and ${files.length - NAMED_FILES} more` : "";
  return `THE LEAD CHANGED YOUR FILES: the integration merge (${shortSha(head)}) brought edits to files you own that you did not make — ${named}${more}. They are the lead's integration fixes: keep them, build on top of them, and never revert them; if one is in your way, say so in your notes instead of undoing it.`;
}
