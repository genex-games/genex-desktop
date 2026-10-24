/**
 * Which face Cursor's row in Settings → Model Providers shows: Cursor is ready only once its CLI
 * says an account is signed in, so a ready engine is a connected one.
 */
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";

/** The row's states, from installing to connected. */
export const CursorRowState = {
  Installing: "installing",
  NotInstalled: "not_installed",
  SigningIn: "signing_in",
  SignedOut: "signed_out",
  Connected: "connected",
  Unreachable: "unreachable",
} as const;
export type CursorRowState = (typeof CursorRowState)[keyof typeof CursorRowState];

/** The row's state from the engine's status, and what the row itself is running. */
export function cursorRowState(
  engine: { status: Pick<EngineStatus, "code"> },
  local: { installing: boolean; signingIn: boolean },
): CursorRowState {
  const code = engine.status.code;
  if (local.installing) return CursorRowState.Installing;
  if (code === EngineStatusCode.NotInstalled) return CursorRowState.NotInstalled;
  // A sign-in runs in the row itself, so it shows (with its Cancel) even beside an earlier one.
  const canSignIn = code === EngineStatusCode.Ready || code === EngineStatusCode.NeedsLogin;
  if (local.signingIn && canSignIn) return CursorRowState.SigningIn;
  if (code === EngineStatusCode.Ready) return CursorRowState.Connected;
  if (code === EngineStatusCode.NeedsLogin) return CursorRowState.SignedOut;
  return CursorRowState.Unreachable;
}
