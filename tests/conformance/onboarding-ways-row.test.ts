/**
 * First launch's "or use" lines: one button per way, in order, each led by its own mark, the Beta
 * tag beside a beta provider's name only, and no button for a way this computer has no engine for. Rendered from the plain renderer build with React's server
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

test("the lines offer Grok Build, Cursor and Antigravity first, each with its mark, and only the beta ones say Beta", async () => {
  const { OtherWays, cliWay, localWay, openCodeWay, openRouterWay, createElement, renderToStaticMarkup } = await row();
  for (const cliRow of ["not_installed", "connected"]) {
    const views = {
      local: localWay("idle", "", 0),
      openrouter: openRouterWay(undefined, false),
      opencode: openCodeWay("not_installed"),
      grok: cliWay("grok", cliRow),
      cursor: cliWay("cursor", cliRow),
      antigravity: cliWay("antigravity", cliRow),
    };
    const markup: string = renderToStaticMarkup(createElement(OtherWays, { views, onOpen: () => {} }));
    const found = buttons(markup);
    assert.deepEqual(
      found.map((button) => button.way),
      ["grok", "cursor", "antigravity", "local", "openrouter", "opencode"],
      cliRow,
    );
    assert.deepEqual(
      found.filter((button) => button.beta).map((button) => button.way),
      ["cursor", "antigravity"],
      `${cliRow}: the Beta tag stands beside Cursor and Antigravity only`,
    );
    if (cliRow === "not_installed")
      for (const way of ["openrouter", "opencode", "grok", "cursor", "antigravity"])
        assert.ok(found.find((button) => button.way === way)?.marked, `${way} leads with its mark`);
  }
});

test("a way with no engine on this computer is left out of the lines", async () => {
  const { OtherWays, cliWay, localWay, openCodeWay, openRouterWay, createElement, renderToStaticMarkup } = await row();
  const views = {
    local: localWay("idle", "", 0),
    openrouter: openRouterWay(undefined, false),
    opencode: openCodeWay("not_installed"),
    grok: cliWay("grok", "not_installed"),
    cursor: cliWay("cursor", "not_installed"),
  };
  const markup: string = renderToStaticMarkup(createElement(OtherWays, { views, onOpen: () => {} }));
  assert.deepEqual(
    buttons(markup).map((button) => button.way),
    ["grok", "cursor", "local", "openrouter", "opencode"],
  );
});
