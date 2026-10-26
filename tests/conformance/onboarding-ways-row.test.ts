/**
 * First launch's "or use" row: one button per way, in order, each led by its own mark, and the Beta
 * tag beside a beta provider's name only. Rendered from the plain renderer build with React's server
 * renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";

/** The row as the renderer build compiles it, its ways' decisions, and React's server renderer. */
async function row() {
  const result = await build({
    stdin: {
      contents: [
        'export { OtherWays } from "./src/renderer/onboarding/OtherWays.tsx";',
        'export { cliWay, localWay, openCodeWay, openRouterWay } from "./src/renderer/onboarding/ways.ts";',
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

/** Each button's way and whether it carries the Beta tag, in the order they stand. */
function buttons(markup: string): { way: string; beta: boolean; marked: boolean }[] {
  return [...markup.matchAll(/<button[^>]*data-way="([^"]+)"[^>]*>(.*?)<\/button>/g)].map((match) => ({
    way: match[1] ?? "",
    beta: (match[2] ?? "").includes("data-beta-tag"),
    marked: (match[2] ?? "").includes("<svg"),
  }));
}

test("the row offers Grok Build and Cursor after OpenCode, each with its mark, and only Cursor says Beta", async () => {
  const { OtherWays, cliWay, localWay, openCodeWay, openRouterWay, createElement, renderToStaticMarkup } = await row();
  for (const [grokRow, cursorRow] of [
    ["not_installed", "not_installed"],
    ["connected", "connected"],
  ]) {
    const views = {
      local: localWay("idle", "", 0),
      openrouter: openRouterWay(undefined, false),
      opencode: openCodeWay("not_installed"),
      grok: cliWay("grok", grokRow),
      cursor: cliWay("cursor", cursorRow),
    };
    const markup: string = renderToStaticMarkup(createElement(OtherWays, { views, onOpen: () => {} }));
    const found = buttons(markup);
    assert.deepEqual(
      found.map((button) => button.way),
      ["local", "openrouter", "opencode", "grok", "cursor"],
      grokRow,
    );
    assert.deepEqual(
      found.filter((button) => button.beta).map((button) => button.way),
      ["cursor"],
      `${grokRow}: the Beta tag stands beside Cursor only`,
    );
    if (grokRow === "not_installed")
      for (const way of ["openrouter", "opencode", "grok", "cursor"])
        assert.ok(found.find((button) => button.way === way)?.marked, `${way} leads with its mark`);
  }
});
