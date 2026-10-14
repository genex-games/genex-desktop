/**
 * A page verb on the browser preview (`studioCallScript` run in a page, read by `readStudioCall`):
 * a Rust web build that refused to start for want of WebGPU is refused `gpu-unsupported`, typed,
 * so the parity gate records the preview's limit as unavailable instead of failing the game
 * (plan M3.3); every other page answers as before.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { readStudioCall, studioCallScript } from "../../src/main/preview-page-scripts.ts";
import { NativeError, NativeRefusal } from "../../src/shared/native-contract.ts";
import { RenderSettingsRefusal } from "../../src/shared/render-quality.ts";
import { NativeOpRefusedError } from "../../src/substrate/native-game-port.ts";

/** The script run in a page whose `window` is `page`, then read as the preview reads it. */
function callOn(page: Record<string, unknown>, method: string, arg?: unknown): unknown {
  const argument = arg === undefined ? "" : JSON.stringify(arg);
  const answer = vm.runInNewContext(studioCallScript(method, argument), { window: page });
  return readStudioCall(JSON.parse(JSON.stringify(answer)), method);
}

const shell = (state: string, code: string | null = null) => ({ GenexShell: { status: { state, code } } });

describe("a page verb on the browser preview", () => {
  it("answers the page's own verb", () => {
    const page = { __studio: { seed: (n: number) => n * 2 } };
    assert.equal(callOn(page, "seed", 21), 42);
  });

  it("answers {__missing} for a verb the page lacks, as before", () => {
    assert.deepEqual(callOn({}, "seed", 1), { __missing: true });
    assert.deepEqual(callOn({ __studio: {} }, "seed", 1), { __missing: true });
    assert.deepEqual(callOn(shell("starting"), "seed", 1), { __missing: true });
    assert.deepEqual(callOn(shell("failed", "boot-failed"), "seed", 1), { __missing: true });
  });

  it("refuses gpu-unsupported, typed, when a Rust web shell showed its needs-WebGPU page", () => {
    assert.throws(
      () => callOn(shell("unsupported", NativeRefusal.GpuUnsupported), "seed", 1),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.GpuUnsupported,
    );
  });

  it("takes no other code a page claims as the preview's limit", () => {
    for (const code of ["device-lost", "unsupported", "", "GPU-UNSUPPORTED"]) {
      const answer = callOn(shell("unsupported", code), "seed", 1) as Record<string, unknown>;
      assert.equal(answer.__missing, true, code);
    }
  });

  it("is the op's typed refusal when the page hands back the game's refusal, as a native game's is", () => {
    const page = { __studio: { renderSettings: () => ({ __refused: RenderSettingsRefusal.InvalidFrameBudget }) } };
    assert.throws(
      () => callOn(page, "renderSettings", { set: { frameBudgetMs: 0.5 } }),
      (error: unknown) =>
        error instanceof NativeOpRefusedError &&
        error.refusal === NativeRefusal.Unsupported &&
        error.gameError === RenderSettingsRefusal.InvalidFrameBudget,
    );
  });

  it("keeps a hostile page's refusal to the native cap, and answers anything else as the page did", () => {
    const long = { __studio: { renderSettings: () => ({ __refused: "x".repeat(100_000) }) } };
    assert.throws(
      () => callOn(long, "renderSettings"),
      (error: unknown) => error instanceof NativeOpRefusedError && error.gameError.length === 512,
    );
    for (const refused of [42, null, { code: "unknown-preset" }, ["unknown-preset"]]) {
      const page = { __studio: { renderSettings: () => ({ __refused: refused }) } };
      assert.deepEqual(callOn(page, "renderSettings"), { __refused: refused }, JSON.stringify(refused));
    }
  });
});
