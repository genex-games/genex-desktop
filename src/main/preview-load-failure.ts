/**
 * Why Live's page did not load, as main reads it: a `did-fail-load` as the line the game console
 * and the agents read beside its typed kind (`LiveLoadFailure`), and a load Electron refused as
 * the code it crosses IPC with. Pure, so it is tested without Electron (`preview.ts` and
 * `ipc/preview.ts` use it).
 */
import { CodedError, errorMessage } from "../shared/errors.ts";
import { LiveLoadFailure, liveLoadFailure } from "../shared/preview-contract.ts";

/** What a failed load leaves on the preview: the line it logs, and its kind. */
export interface FailedLoad {
  loadError: string;
  loadFailure: LiveLoadFailure;
}

/** A `did-fail-load` as the preview keeps it; null for a load another navigation took the place of. */
export function failedLoad(code: number, description: string, url: string): FailedLoad | null {
  const loadFailure = liveLoadFailure(code);
  if (loadFailure === LiveLoadFailure.Aborted) return null;
  return { loadError: `${description} (${code}) for ${url}`, loadFailure };
}

/** Chromium's error number on a refused `loadURL` (Electron sets `errno`), or null for anything else. */
function errnoOf(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const errno: unknown = Reflect.get(error, "errno");
  return typeof errno === "number" && Number.isInteger(errno) ? errno : null;
}

/** A load Electron refused, as the same words with its kind as their code; any other failure as thrown. */
export function codedLoadRefusal(error: unknown): unknown {
  const errno = errnoOf(error);
  if (errno === null) return error;
  return new CodedError(liveLoadFailure(errno), errorMessage(error));
}
