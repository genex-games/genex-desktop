/**
 * First launch's Genex screen: the promo card's film and its three rows, then one control for the
 * step the sign-in is at, and Start building once Genex is signed in. Rendered from the plain
 * renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";

/** The screen as the renderer build compiles it, and React's server renderer. */
async function screen() {
  const result = await build({
    stdin: {
      contents: [
        'export { GenexScreen } from "./src/renderer/onboarding/GenexScreen.tsx";',
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

/** One build for the whole file. */
let compiled: ReturnType<typeof screen> | null = null;

/** The screen's markup at one step, with or without something to build with, under Reduce Motion or not. */
async function markupAt(step: string, shown: { anyOn?: boolean; problem?: string; reducedMotion?: boolean } = {}) {
  compiled ??= screen();
  const { GenexScreen, createElement, renderToStaticMarkup } = await compiled;
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: shown.reducedMotion === true });
  const press = () => {};
  const genex = { step, problem: shown.problem ?? null, signIn: press, reopen: press, cancel: press };
  const props = { genex, anyOn: shown.anyOn === true, onBack: press, onSkip: press, onStart: press };
  return renderToStaticMarkup(createElement(GenexScreen, props)) as string;
}

const count = (markup: string, piece: string): number => markup.split(piece).length - 1;

test("the Genex screen offers one sign-in under the card's film and its three rows", async () => {
  const markup = await markupAt("offer");
  assert.match(markup, /data-genex-screen="offer"/);
  assert.equal(count(markup, "<video"), 1, "the card's film plays");
  assert.equal(count(markup, "<li"), 3, "the card's three rows");
  assert.equal(count(markup, "data-genex-sign-in"), 1, "one button signs in");
  assert.equal(count(markup, "data-genex-reopen"), 0);
  assert.match(markup, /data-onboarding-action="skip"/, "nothing is connected yet: Skip for now stays");
  assert.doesNotMatch(markup, /data-onboarding-action="start"/);

  const still = await markupAt("offer", { reducedMotion: true });
  assert.equal(count(still, "<video"), 0, "Reduce Motion holds the film's still");
  assert.equal(count(still, "<img"), 1);
});

test("the Genex screen waits on the browser with a cancel and the page again", async () => {
  const markup = await markupAt("browser");
  assert.match(markup, /data-genex-screen="browser"/);
  assert.equal(count(markup, "data-genex-sign-in"), 0, "the button gave way to the wait");
  assert.equal(count(markup, "data-genex-cancel"), 1);
  assert.equal(count(markup, "data-genex-reopen"), 1);
  assert.equal(count(markup, 'role="status"'), 1);
});

test("the Genex screen says Genex is ready and starts building once signed in", async () => {
  for (const step of ["setup", "on"]) {
    const markup = await markupAt(step, { anyOn: true });
    assert.match(markup, new RegExp(`data-genex-screen="${step}"`));
    assert.equal(count(markup, "data-genex-sign-in"), 0, step);
    assert.equal(count(markup, "data-genex-cancel"), 0, step);
    assert.equal(count(markup, 'role="status"'), 1, step);
    assert.match(markup, /data-onboarding-action="start"/, step);
    assert.doesNotMatch(markup, /data-onboarding-action="skip"/, step);
  }
});

test("the Genex screen says what went wrong under its control", async () => {
  const markup = await markupAt("offer", { problem: "The sign-in stopped." });
  assert.match(markup, /role="alert"[^>]*>The sign-in stopped\.</);
});
