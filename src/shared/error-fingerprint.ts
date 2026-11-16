/**
 * Where an error was thrown, told without its words or anyone's folders: the top stack frames with
 * only file names and positions, and a short hash of them. The window fingerprints its own errors
 * and main its uncaught ones (`main/app-diagnostics.ts`), so `app_error_caught` tells either apart.
 */

/** How many stack frames make an error's fingerprint. */
const FINGERPRINT_FRAMES = 5;

/** A frame's place: a file's name with its line and column, everything before the last slash dropped. */
const PLACE = /(?:[a-z][\w+.-]*:\/\/)?(?:[^\s()]*[\\/])?([^\s()\\/?#]+?)(?:[?#][^\s():]*)?:(\d+):(\d+)/gi;

/** A fingerprint's own shape: 8 lowercase hex digits. */
const FINGERPRINT_SHAPE = /^[0-9a-f]{8}$/;

/** The top stack frames, with only file names and positions kept: no folder, no address, no message. */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || /@.*:\d+:\d+$/.test(line))
    .slice(0, FINGERPRINT_FRAMES)
    .map((line) => line.replace(PLACE, "$1:$2:$3"));
}

/** FNV-1a over the frames, as 8 hex digits. */
export function fingerprint(frames: readonly string[]): string | null {
  if (frames.length === 0) return null;
  let hash = 0x811c9dc5;
  for (const char of frames.join("\n")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Whether a value is a fingerprint `fingerprint` makes, and nothing else. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_SHAPE.test(value);
}
