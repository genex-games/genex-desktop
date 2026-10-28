/**
 * Main's own diagnostics, told to the window as typed facts (`UiEvent.AppDiagnostic`): an error
 * main's process caught nowhere (its kind and built-in type, never its words or stack), and how
 * long a window stopped answering, once it answers again. Each is also counted in the session's
 * marker (`session-marker.ts`), so a session whose window never heard it still says so at the next
 * launch. Free of Electron: `main/index.ts` wires it to `process` and each window.
 */
import { MainDiagnostic } from "../shared/app-session.ts";
import { UiEvent, type UiEventMap } from "../shared/ui-events.ts";
import type { SessionMarker } from "./session-marker.ts";

/** How many errors main tells the window in one launch: a loop that throws is one problem. */
export const MAIN_FAULT_EVENTS_MAX = 10;

/** An error main caught nowhere, as `installProcessHandlers` names it. */
export type MainFault = typeof MainDiagnostic.Uncaught | typeof MainDiagnostic.Rejection;

/** What main tells the window: `UiEvent.AppDiagnostic`'s payload. */
export type AppDiagnosticPayload = UiEventMap[typeof UiEvent.AppDiagnostic];

/** One window's hang: it stopped answering, then answered again. */
export interface HangWatch {
  unresponsive(): void;
  responsive(): void;
}

/** Main's diagnostics for this launch. */
export interface AppDiagnostics {
  /** An error main caught nowhere: counted, and told the window a few times a launch. */
  fault(kind: MainFault, reason: unknown): void;
  /** A watch for one window's hangs. */
  hangWatch(): HangWatch;
}

/** The thrown value's own type name, for the window to check against JavaScript's; nothing else of it. */
const typeName = (reason: unknown): string | undefined => (reason instanceof Error ? reason.name : undefined);

/** Main's diagnostics, told through `push`, counted in `marker` (when this launch keeps one), on `now`'s clock. */
export function createAppDiagnostics({
  push,
  marker,
  now,
}: {
  push(payload: AppDiagnosticPayload): void;
  marker: Pick<SessionMarker, "mainError" | "hung"> | null;
  now(): number;
}): AppDiagnostics {
  let told = 0;
  return {
    fault(kind, reason) {
      marker?.mainError();
      if (told >= MAIN_FAULT_EVENTS_MAX) return;
      told++;
      const errorType = typeName(reason);
      push(errorType === undefined ? { kind } : { kind, errorType });
    },
    hangWatch() {
      let since: number | null = null;
      return {
        unresponsive() {
          if (since !== null) return;
          since = now();
          marker?.hung();
        },
        responsive() {
          if (since === null) return;
          const durationMs = Math.max(0, now() - since);
          since = null;
          push({ kind: MainDiagnostic.Unresponsive, durationMs });
        },
      };
    },
  };
}
