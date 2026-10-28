/**
 * The usage analytics question: it names the replay only to an install that records one, and its
 * two answers are the same quiet button, found by their choice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { ANALYTICS_WORDS } from "../../src/renderer/words.ts";

/** The question's choices as the plain renderer build compiles them, and React's server renderer. */
async function consentChoices() {
  const result = await build({
    stdin: {
      contents: [
        'export { ConsentChoices } from "./src/renderer/panels/AnalyticsConsent.tsx";',
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

/** Every `<button …>` opening tag, with its classes. */
const buttons = (markup: string): string[] => markup.match(/<button[^>]*>/g) ?? [];
const classOf = (tag: string): string => /class="([^"]*)"/.exec(tag)?.[1] ?? "";

test("names the first week's replay only to an install that records one", async () => {
  const { ConsentChoices, createElement, renderToStaticMarkup } = await consentChoices();
  const render = (replay: boolean): string =>
    renderToStaticMarkup(createElement(ConsentChoices, { replay, onAnswer: () => {} }));
  const sampled = render(true);
  const unsampled = render(false);
  assert.ok(sampled.includes(ANALYTICS_WORDS.replay));
  assert.ok(sampled.includes(ANALYTICS_WORDS.replayWhat));
  assert.ok(!unsampled.includes(ANALYTICS_WORDS.replay), "four installs in five never hear of a replay");
  assert.ok(!unsampled.includes(ANALYTICS_WORDS.replayWhat));
  for (const markup of [sampled, unsampled]) {
    assert.ok(markup.includes(ANALYTICS_WORDS.events));
    assert.ok(markup.includes(ANALYTICS_WORDS.never), "what is never sent is always said");
  }
});

test("offers Don't share and Share as the same button, found by their choice", async () => {
  const { ConsentChoices, createElement, renderToStaticMarkup } = await consentChoices();
  const markup: string = renderToStaticMarkup(createElement(ConsentChoices, { replay: false, onAnswer: () => {} }));
  const [keep, share] = buttons(markup);
  assert.match(keep ?? "", /data-analytics-choice="off"/);
  assert.match(share ?? "", /data-analytics-choice="on"/);
  assert.equal(classOf(keep ?? ""), classOf(share ?? ""), "both answers weigh the same");
  assert.equal(buttons(markup).length, 2, "nothing else to press: no close, no way past it");
});
