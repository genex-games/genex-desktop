/**
 * A page verb on the browser preview (`studioCallScript` run in a page, read by `readStudioCall`):
 * a Rust web build that refused to start for want of WebGPU is refused `gpu-unsupported`, typed,
 * so the parity gate records the preview's limit as unavailable instead of failing the game
 * (plan M3.3); every other page answers as before.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { pageVerbArgument, readStudioCall, studioCallScript } from "../../src/main/preview-page-scripts.ts";
import { NativeError, NativeOpError, NativeRefusal } from "../../src/shared/native-contract.ts";
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

// UIS-15 (new behaviour): a web page's saves and uiSettings verbs take what a native run's ops take.
describe("saves and uiSettings on a web page", () => {
  /** The verb as the preview sends it: its argument checked first, then the script, then the read. */
  function sendOn(page: Record<string, unknown>, method: string, arg?: unknown): unknown {
    return callOn(page, method, pageVerbArgument(method, arg));
  }

  it("refuses a hostile argument bad-argument before the page is asked", () => {
    const asked: unknown[] = [];
    const page = { __studio: { saves: (a: unknown) => asked.push(a), uiSettings: (a: unknown) => asked.push(a) } };
    for (const [method, arg] of [
      ["saves", { op: "load", slot: "../x" }],
      ["saves", { op: "write", slot: "s", envelope: { blob: "x".repeat(2 * 1024 * 1024) } }],
      ["saves", { op: "drop" }],
      ["uiSettings", { scale: Number.NaN }],
    ] as const)
      assert.throws(
        () => sendOn(page, method, arg),
        (error: unknown) => error instanceof NativeOpRefusedError && error.gameError === NativeOpError.BadArgument,
        method,
      );
    assert.deepEqual(asked, [], "the page was never asked");
  });

  it("sends the checked argument, and any other verb's argument as given", () => {
    const page = {
      __studio: {
        saves: (a: unknown) => ({ got: a }),
        uiSettings: (a: unknown) => ({ got: a }),
        seed: (n: number) => n,
      },
    };
    assert.deepEqual(sendOn(page, "saves", { op: "list", slot: "x" }), { got: { op: "list" } });
    assert.deepEqual(sendOn(page, "uiSettings"), { got: {} });
    assert.deepEqual(sendOn(page, "uiSettings", { locale: "xx-pseudo", warp: 1 }), { got: { locale: "xx-pseudo" } });
    assert.equal(pageVerbArgument("seed", 21), 21);
    assert.equal(sendOn(page, "seed", 21), 21);
  });
});
