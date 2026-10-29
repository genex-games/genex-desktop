/**
 * Core startup makes the sandbox and wires plugin services side by side. A sandbox that cannot
 * start must not end startup while the plugins are still being copied: the setup screen's retry
 * starts a new core whose plugin registry would sweep and copy the same folders under it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { sandboxBesidePlugins } from "../../src/main/core/boot-side-by-side.ts";

/** A promise the test settles by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeSandbox() {
  const sandbox = { disposed: 0, dispose: async () => void sandbox.disposed++ };
  return sandbox;
}

describe("sandbox beside plugins", () => {
  it("answers the sandbox once both are done", async () => {
    const sandbox = fakeSandbox();
    assert.equal(await sandboxBesidePlugins(Promise.resolve(sandbox), Promise.resolve()), sandbox);
    assert.equal(sandbox.disposed, 0);
  });

  it("a sandbox that cannot start fails only after the plugins finish", async () => {
    const plugins = deferred();
    const order: string[] = [];
    const started = sandboxBesidePlugins(Promise.reject(new Error("not_provisioned")), plugins.promise).catch(
      (error: Error) => void order.push(`failed: ${error.message}`),
    );
    await setImmediate();
    order.push("plugins done");
    plugins.resolve();
    await started;
    assert.deepEqual(order, ["plugins done", "failed: not_provisioned"]);
  });

  it("the sandbox's failure wins over the plugins' own", async () => {
    await assert.rejects(
      sandboxBesidePlugins(Promise.reject(new Error("not_provisioned")), Promise.reject(new Error("bad seed"))),
      /not_provisioned/,
    );
  });

  it("plugins that fail release the sandbox made beside them", async () => {
    const sandbox = fakeSandbox();
    await assert.rejects(
      sandboxBesidePlugins(Promise.resolve(sandbox), Promise.reject(new Error("bad seed"))),
      /bad seed/,
    );
    assert.equal(sandbox.disposed, 1);
  });
});
