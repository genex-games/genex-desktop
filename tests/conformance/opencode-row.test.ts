/**
 * Settings → Model Providers: OpenCode's row says Connected only once a provider is signed in. While
 * OpenCode lists only its own free models it asks for a sign-in, though those models still run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeRowState, openCodeRowState } from "../../src/renderer/panels/opencode-row.ts";
import { EngineStatusCode, LoginSource } from "../../src/shared/engine-descriptor.ts";

const cli = { state: "ready" as const, version: "1.18.35" };
const engine = (code: EngineStatusCode, source?: LoginSource) => ({
  status: { code, detail: "" },
  ...(source ? { account: { source, afterSignOut: "signed-out" as const, cli } } : {}),
});
const idle = { installing: false, signingIn: false };

describe("OpenCode's row", () => {
  it("asks for a sign-in while OpenCode lists only its free models, and says Connected after one", () => {
    assert.equal(openCodeRowState(engine(EngineStatusCode.Ready, LoginSource.None), idle), OpenCodeRowState.FreeOnly);
    assert.equal(
      openCodeRowState(engine(EngineStatusCode.Ready, LoginSource.System), idle),
      OpenCodeRowState.Connected,
    );
  });

  it("shows the sign-in running in the terminal until a provider is signed in", () => {
    const signingIn = { installing: false, signingIn: true };
    assert.equal(
      openCodeRowState(engine(EngineStatusCode.Ready, LoginSource.None), signingIn),
      OpenCodeRowState.SigningIn,
    );
    assert.equal(openCodeRowState(engine(EngineStatusCode.NeedsLogin), signingIn), OpenCodeRowState.SigningIn);
    assert.equal(
      openCodeRowState(engine(EngineStatusCode.Ready, LoginSource.System), signingIn),
      OpenCodeRowState.SigningIn,
      "another provider's sign-in, started from Connected, runs in the row with its Cancel",
    );
  });

  it("follows the engine's status otherwise", () => {
    assert.equal(
      openCodeRowState(engine(EngineStatusCode.NotInstalled), { installing: true, signingIn: false }),
      OpenCodeRowState.Installing,
    );
    assert.equal(openCodeRowState(engine(EngineStatusCode.NotInstalled), idle), OpenCodeRowState.NotInstalled);
    assert.equal(openCodeRowState(engine(EngineStatusCode.NeedsLogin), idle), OpenCodeRowState.SignedOut);
    assert.equal(openCodeRowState(engine(EngineStatusCode.Error), idle), OpenCodeRowState.Unreachable);
    assert.equal(
      openCodeRowState(engine(EngineStatusCode.Ready), idle),
      OpenCodeRowState.Connected,
      "an engine that reports no account is taken at its status",
    );
  });
});
