/**
 * Maximum concurrent workers (Settings → Harness) tops out at the most a lead's pool runs at once,
 * `MAX_WORKERS_AT_ONCE`: the stepper offers no more, a count saved above it reads as it, and the
 * pool is told the setting and runs no more than it allows.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { clampBuilders } from "../../src/main/core/settings.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { MAX_WORKERS_AT_ONCE } from "../../src/shared/workers.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** The most Settings offered before it followed the pool's limit. */
const OLD_MOST_OFFERED = 12;

/** The stepper as the plain renderer build compiles it, and React's server renderer. */
async function stepper() {
  const result = await build({
    stdin: {
      contents: [
        'export { WorkersStepper } from "./src/renderer/panels/HarnessSection.tsx";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** Whether the stepper's button of `label` can be pressed, as drawn. */
function pressable(markup: string, label: string): boolean {
  const button = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  assert.ok(button, `${label} is drawn: ${markup}`);
  return !/\sdisabled(=|\s|>)/.test(button);
}

describe("Maximum concurrent workers", () => {
  it("the stepper offers one more up to the pool's limit, and none past it", async () => {
    const { WorkersStepper, createElement, renderToStaticMarkup } = await stepper();
    const drawn = (value: number): string =>
      renderToStaticMarkup(createElement(WorkersStepper, { value, busy: false, onChange: () => {} }));
    const rows = [1, MAX_WORKERS_AT_ONCE - 1, MAX_WORKERS_AT_ONCE].map((value) => [
      value,
      pressable(drawn(value), "Fewer workers"),
      pressable(drawn(value), "More workers"),
    ]);
    assert.deepEqual(rows, [
      [1, false, true],
      [MAX_WORKERS_AT_ONCE - 1, true, true],
      [MAX_WORKERS_AT_ONCE, true, false],
    ]);
  });

  it("a count past the pool's limit reads as the limit; anything unusable as the default", () => {
    const read = [0, 3, MAX_WORKERS_AT_ONCE, MAX_WORKERS_AT_ONCE + 1, OLD_MOST_OFFERED, 99, Number.NaN].map(
      clampBuilders,
    );
    assert.deepEqual(read, [
      1,
      3,
      MAX_WORKERS_AT_ONCE,
      MAX_WORKERS_AT_ONCE,
      MAX_WORKERS_AT_ONCE,
      MAX_WORKERS_AT_ONCE,
      4,
    ]);
  });

  it("a saved twelve reads as the limit, and the pool is told the limit", async () => {
    const lite = await coreLite({ init: false });
    await mkdir(lite.userData, { recursive: true });
    await writeFile(
      path.join(lite.userData, "settings.json"),
      JSON.stringify({ buildersMax: OLD_MOST_OFFERED, buildersDefault: 4 }),
    );
    await lite.core.init();
    try {
      assert.equal(lite.core.settings.buildersMax, MAX_WORKERS_AT_ONCE);
      const capacity = await lite.api()[HostMethod.PreviewCapacity]();
      assert.equal(capacity.workers, MAX_WORKERS_AT_ONCE, "what the lead's pool is told it may run");
      const chosen = await lite.core.updateSettings({ buildersMax: OLD_MOST_OFFERED });
      assert.equal(chosen.buildersMax, MAX_WORKERS_AT_ONCE, "a change past the limit is saved as the limit");
    } finally {
      await lite.close();
    }
  });
});
