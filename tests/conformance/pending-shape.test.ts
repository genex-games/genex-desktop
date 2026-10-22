/**
 * A region whose content is on its way shows the shape of what is coming, not words: soft blocks
 * hidden from assistive technology, with the region's label announced once as a status. Real work
 * being started shows the chat's orb beside its label instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";

/** `Pending` and the skeleton shapes as the plain renderer build compiles them, and React's server renderer. */
async function pendingModule() {
  const result = await build({
    stdin: {
      contents: [
        'export { Pending } from "./src/renderer/ui/Pending.tsx";',
        'export { Skeleton, SkeletonRows, SkeletonControl } from "./src/renderer/ui/Skeleton.tsx";',
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

/** The text a reader sees: the markup without its tags. */
const visibleText = (markup: string): string => markup.replace(/<[^>]*>/g, "");

test("a region on its way shows its caller's shape and no words, its label held back from the first moments", async () => {
  const { Pending, Skeleton, createElement, renderToStaticMarkup } = await pendingModule();
  const label = "Loading conversation…";
  const shape = createElement(Skeleton, { width: 200, height: 36, radius: 18 });
  const markup: string = renderToStaticMarkup(createElement(Pending, { label }, shape));
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-busy="true"/);
  assert.ok(markup.includes(`aria-label="${label}"`), markup);
  assert.equal(visibleText(markup), "", "no words stand in for what is coming");
  assert.doesNotMatch(markup, /sr-only/, "a short wait is not announced: the label comes in later");
  const blocks = markup.match(/<span aria-hidden="true" class="skeleton[ "][^>]*>/g) ?? [];
  assert.equal(blocks.length, 1, markup);
  assert.match(blocks[0] ?? "", /width:200px;height:36px;border-radius:18px/);
});

test("a region with no shape of its own shows a short paragraph of lines", async () => {
  const { Pending, createElement, renderToStaticMarkup } = await pendingModule();
  const markup: string = renderToStaticMarkup(createElement(Pending, { label: "Loading…" }));
  assert.equal(visibleText(markup), "");
  assert.equal((markup.match(/class="skeleton /g) ?? []).length, 3, markup);
});

test("rows of a list keep their icon and their control, and vary their widths", async () => {
  const { SkeletonRows, SkeletonControl, createElement, renderToStaticMarkup } = await pendingModule();
  const markup: string = renderToStaticMarkup(
    createElement(SkeletonRows, { count: 2, icon: true, control: SkeletonControl.Button }),
  );
  const rows = markup.split('class="skeleton-row"').slice(1);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /width:32px;height:32px;border-radius:8px/, "an icon on the left");
    assert.match(row, /width:72px;height:28px;border-radius:8px/, "a button on the right");
  }
  assert.notEqual(rows[0]?.match(/width:\d+%/)?.[0], rows[1]?.match(/width:\d+%/)?.[0]);
});

test("real work starting shows the orb beside its label, not a shape", async () => {
  const { Pending, createElement, renderToStaticMarkup } = await pendingModule();
  const label = "Checking Blender…";
  const markup: string = renderToStaticMarkup(createElement(Pending, { label, working: true }));
  assert.ok(markup.includes(`aria-label="${label}"`), markup);
  assert.match(markup, /<canvas[^>]*class="[^"]*chat-status-orb/, "the chat's orb, never a spinner");
  assert.equal(visibleText(markup), label);
  assert.doesNotMatch(markup, /class="skeleton[ "]/);
});
