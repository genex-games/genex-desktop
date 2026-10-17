/**
 * Files too large to save that a chat checkpoint left out, or a rewind left as they were, by the
 * thread whose chat said so, until a later delegated session of the thread is told of them
 * (`delegation-prompts.ts` `unsavedFilesNotice`) and answers. Memory only, like cut-off calls: an
 * app restart drops a note not yet shown, and the chat's line stays in the log.
 */
import type { SkippedFile } from "../../shared/chat-rewind.ts";

/** At most this many unsaved files wait per thread; the oldest noted goes first. */
const MAX_UNSAVED_PER_THREAD = 10;

/** A file too large to save, as the lead is told of it. */
export type UnsavedFile = SkippedFile;

/**
 * Note files for their thread, the most important first (past the cap, a call's later files are
 * left); a file noted again keeps only its newest size.
 */
export function noteUnsaved(
  unsaved: Map<string, UnsavedFile[]>,
  threadId: string | undefined,
  files: readonly UnsavedFile[],
): void {
  if (!threadId || files.length === 0) return;
  const taken = files.slice(0, MAX_UNSAVED_PER_THREAD);
  const named = new Set(taken.map((file) => file.file));
  const earlier = (unsaved.get(threadId) ?? []).filter((file) => !named.has(file.file));
  const noted = [...earlier, ...taken.map((file) => ({ ...file }))];
  unsaved.set(threadId, noted.slice(-MAX_UNSAVED_PER_THREAD));
}

/** The thread's unsaved files, oldest noted first, left noted until a session has read them (`clearUnsaved`). */
export function peekUnsaved(unsaved: Map<string, UnsavedFile[]>, threadId: string | undefined): UnsavedFile[] {
  if (!threadId) return [];
  return [...(unsaved.get(threadId) ?? [])];
}

/**
 * Forget the files a session was told of and answered after; a file noted since (again, or anew)
 * stays for the thread's next session.
 */
export function clearUnsaved(
  unsaved: Map<string, UnsavedFile[]>,
  threadId: string | undefined,
  shown: readonly UnsavedFile[],
): void {
  if (!threadId || shown.length === 0) return;
  const left = (unsaved.get(threadId) ?? []).filter((file) => !shown.includes(file));
  if (left.length) unsaved.set(threadId, left);
  else unsaved.delete(threadId);
}
