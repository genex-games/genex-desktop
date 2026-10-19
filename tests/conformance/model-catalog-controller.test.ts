import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelCatalog, CatalogError } from "../../src/substrate/engines/model-catalog.ts";
import { ModelCatalogSource, ModelCatalogState, ModelCatalogProblemCode } from "../../src/shared/model-catalog.ts";
const row = (id: string) => ({
  id,
  label: id,
  contextWindow: 0,
  maxTokens: 100,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
});
const result = (id: string) => ({ models: [row(id)], source: ModelCatalogSource.Provider });
test("refresh coalesces, respects freshness and can be forced", async () => {
  let now = 0;
  let calls = 0;
  const catalog = new ModelCatalog(
    () => {},
    () => now,
  );
  const read = async () => {
    calls++;
    return result("first");
  };
  await Promise.all([catalog.refresh("a", read), catalog.refresh("a", read)]);
  assert.equal(calls, 1);
  await catalog.refresh("a", read);
  assert.equal(calls, 1);
  await catalog.refresh("a", read, true);
  assert.equal(calls, 2);
  now = 60001;
  await catalog.refresh("a", read);
  assert.equal(calls, 3);
});
test("a forced refresh while a read runs reads again, and the running read's older answer never lands", async () => {
  const catalog = new ModelCatalog();
  let finishFirst = (_: ReturnType<typeof result>) => {};
  let calls = 0;
  const read = () => {
    calls++;
    if (calls > 1) return Promise.resolve(result("after-sign-in"));
    return new Promise<ReturnType<typeof result>>((resolve) => {
      finishFirst = resolve;
    });
  };
  const running = catalog.refresh("a", read);
  const forced = catalog.refresh("a", read, true);
  finishFirst(result("before-sign-in"));
  await Promise.all([running, forced]);
  assert.equal(calls, 2);
  assert.equal(catalog.models()[0]?.id, "after-sign-in");
});
test("late catalog from a previous identity cannot replace the current account", async () => {
  const catalog = new ModelCatalog();
  let finish = (_: ReturnType<typeof result>) => {};
  const old = catalog.refresh(
    "old",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await catalog.refresh("new", async () => result("new-model"));
  finish(result("old-model"));
  await old;
  assert.equal(catalog.models()[0]?.id, "new-model");
});
test("failed refresh keeps complete rows stale and recovery replaces them", async () => {
  const catalog = new ModelCatalog();
  await catalog.refresh("a", async () => result("old"));
  await catalog.refresh(
    "a",
    async () => {
      throw new CatalogError(ModelCatalogProblemCode.Timeout, "Timeout");
    },
    true,
  );
  assert.equal(catalog.models()[0]?.id, "old");
  assert.equal(catalog.snapshot().state, ModelCatalogState.Stale);
  await catalog.refresh("a", async () => ({ models: [], source: ModelCatalogSource.Provider }), true);
  assert.deepEqual(catalog.models(), []);
  assert.equal(catalog.snapshot().state, ModelCatalogState.Ready);
});
test("failed cold discovery remains separate from authentication", async () => {
  const catalog = new ModelCatalog();
  await catalog.refresh("a", async () => {
    throw new Error("unauthorized private details");
  });
  assert.equal(catalog.snapshot().state, ModelCatalogState.Unavailable);
  assert.equal(catalog.snapshot().problem?.code, ModelCatalogProblemCode.Provider);
  assert.equal(JSON.stringify(catalog.snapshot()).includes("private details"), false);
});

import { EngineRegistry } from "../../src/substrate/engines/registry.ts";
import { EngineKind, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import type { Engine } from "../../src/substrate/engines/types.ts";
test("maintenance excludes active operations and refuses new work until completion", async () => {
  const registry = new EngineRegistry();
  let release = () => {};
  let calls = 0;
  const engine: Engine = {
    id: "fixture",
    label: "Fixture",
    kind: EngineKind.Delegated,
    status: async () => ({ code: EngineStatusCode.Ready, detail: "" }),
    models: async () => [],
    refreshModels: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  registry.register(engine);
  const active = engine.refreshModels?.();
  await assert.rejects(
    registry.maintain(engine.id, async () => {}),
    /active provider work/,
  );
  release();
  await active;
  let finish = () => {};
  const update = registry.maintain(
    engine.id,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await assert.rejects(engine.refreshModels?.() ?? Promise.resolve(), /update/);
  assert.equal(calls, 1);
  finish();
  await update;
});
