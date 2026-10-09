/**
 * Which face OpenCode's row in Settings → Model Providers shows. OpenCode lists its own free models
 * to anyone, so a ready engine is not yet a signed-in one: until OpenCode lists a provider's model
 * the row asks for a sign-in, while the free models stay in the picker.
 */
import {
  type EngineAccount,
  type EngineStatus,
  EngineStatusCode,
  LoginSource,
} from "../../shared/engine-descriptor.ts";

/** The row's states, from installing to connected. */
export const OpenCodeRowState = {
  Installing: "installing",
  NotInstalled: "not_installed",
  SigningIn: "signing_in",
  SignedOut: "signed_out",
  FreeOnly: "free_only",
  Connected: "connected",
  Unreachable: "unreachable",
} as const;
export type OpenCodeRowState = (typeof OpenCodeRowState)[keyof typeof OpenCodeRowState];

/** Is a provider signed in to OpenCode? An engine that reports no account is taken at its status. */
const signedIn = (account: Pick<EngineAccount, "source"> | null | undefined): boolean =>
  account?.source !== LoginSource.None;

/** The row's state from the engine's status and account, and what the row itself is running. */
export function openCodeRowState(
  engine: { status: Pick<EngineStatus, "code">; account?: Pick<EngineAccount, "source"> | null },
  local: { installing: boolean; signingIn: boolean },
): OpenCodeRowState {
  const code = engine.status.code;
  if (local.installing) return OpenCodeRowState.Installing;
  if (code === EngineStatusCode.NotInstalled) return OpenCodeRowState.NotInstalled;
  // A sign-in runs in the row itself, so it shows (with its Cancel) even beside an earlier one.
  const canSignIn = code === EngineStatusCode.Ready || code === EngineStatusCode.NeedsLogin;
  if (local.signingIn && canSignIn) return OpenCodeRowState.SigningIn;
  if (code === EngineStatusCode.Ready)
    return signedIn(engine.account) ? OpenCodeRowState.Connected : OpenCodeRowState.FreeOnly;
  if (code === EngineStatusCode.NeedsLogin) return OpenCodeRowState.SignedOut;
  return OpenCodeRowState.Unreachable;
}
