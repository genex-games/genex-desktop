/**
 * The one rule for a file or folder name Windows can hold as spelled, which the PE gate (what a
 * Windows build may carry) and the export archives (what a player extracts) both apply: the
 * stricter union of the two rules they used to keep apart. One segment at a time; a caller splits
 * its paths at `/` first.
 */

/** A segment's limit on every filesystem a player extracts to, in UTF-8 bytes. */
export const WINDOWS_NAME_MAX_BYTES = 255;

/** Why Windows cannot hold a name as spelled. Typed; the callers word it. Never rename a value. */
export const WindowsNameProblem = {
  Empty: "empty",
  /** `.` or `..`: a path step, never a name. */
  DotSegment: "dot-segment",
  /** `<>:"|?*`, either slash, a control character or a lone surrogate (no UTF-8 spelling of its own). */
  Character: "character",
  /** A device name (CON, PRN, AUX, NUL, COM0–9, LPT0–9, the superscript digits, CONIN$, CONOUT$), with any extension. */
  Reserved: "reserved",
  /** A trailing dot or space, which Windows drops, so the name on disk is another one. */
  Trailing: "trailing",
  TooLong: "too-long",
} as const;
export type WindowsNameProblem = (typeof WindowsNameProblem)[keyof typeof WindowsNameProblem];

/** Characters Windows refuses, either slash, control characters (C0, DEL, C1) and lone surrogates. */
const FORBIDDEN = /[<>:"|?*\\/\p{Cc}\p{Cs}]/u;
/** Device names Windows reserves, matched against the part before the first dot, trailing spaces dropped. */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/iu;
const TRAILING = /[. ]$/u;

/** Whether Windows reads `segment` as a device: its part before the first dot, trailing spaces dropped, in any capitals. */
function isReserved(segment: string): boolean {
  const stem = segment.split(".")[0] ?? "";
  return RESERVED.test(stem.trimEnd());
}

/** Why Windows cannot hold `segment` as one name as spelled, or null when it can. */
export function windowsNameProblem(segment: string): WindowsNameProblem | null {
  if (segment === "") return WindowsNameProblem.Empty;
  if (segment === "." || segment === "..") return WindowsNameProblem.DotSegment;
  if (FORBIDDEN.test(segment)) return WindowsNameProblem.Character;
  if (isReserved(segment)) return WindowsNameProblem.Reserved;
  if (TRAILING.test(segment)) return WindowsNameProblem.Trailing;
  if (Buffer.byteLength(segment) > WINDOWS_NAME_MAX_BYTES) return WindowsNameProblem.TooLong;
  return null;
}

/** Whether Windows can hold `segment` as one file or folder name as spelled. */
export function isWindowsSafeName(segment: string): boolean {
  return windowsNameProblem(segment) === null;
}
