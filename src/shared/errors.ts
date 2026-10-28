import { isStudioErrorCode, type StudioErrorCode } from "./error-codes.ts";

/**
 * The words of whatever was thrown. JavaScript throws anything — an `Error`, a string, an object
 * from another realm, `null` — and `(err as Error).message` read `undefined` for most of them and
 * threw on `null`. Browser-safe, so main, the substrate and the renderer share it.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string")
    return (error as { message: string }).message;
  return String(error);
}

/** What a refusal by the user says; the IPC edge carries only the words, so they are the contract. */
const USER_CANCELLED_MESSAGE = "Cancelled by user";

/**
 * The user said no to a confirmation (an install, a connector): nothing failed, nothing to report.
 * Its `name` stays `Error`, so the text that crosses IPC is the one the edge always carried.
 */
export class UserCancelledError extends Error {
  constructor() {
    super(USER_CANCELLED_MESSAGE);
  }
}

/**
 * Did the user cancel? True for a `UserCancelledError` and for exactly its words, never for an
 * error that only ends with them: a failure quoting a cancel is still a failure to report.
 */
export function isUserCancelled(error: unknown): boolean {
  return error instanceof UserCancelledError || errorMessage(error) === USER_CANCELLED_MESSAGE;
}

/**
 * A failure with a typed code beside its words: the code crosses IPC with the words (`IpcResult`)
 * and comes back as this class in the renderer, so a caller tells failures apart by `code`.
 */
export class CodedError extends Error {
  readonly code: StudioErrorCode;
  constructor(code: StudioErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Whatever a thrown value says its `code` is, unchecked. */
const thrownCode = (error: unknown): unknown =>
  error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;

/** The code of whatever was thrown, when it is one of the app's; never words, a path or a Node code. */
export function errorCode(error: unknown): StudioErrorCode | null {
  const code = thrownCode(error);
  return isStudioErrorCode(code) ? code : null;
}

/** The code of whatever was thrown when it is a value of `vocabulary`, else null. */
export function errorCodeIn<V extends Record<string, string>>(vocabulary: V, error: unknown): V[keyof V] | null {
  const code = thrownCode(error);
  const values: readonly unknown[] = Object.values(vocabulary);
  return values.includes(code) ? (code as V[keyof V]) : null;
}
