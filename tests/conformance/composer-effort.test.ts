/**
 * The composer's effort control says what a send carries. With no pick, the send names no effort
 * and the provider's own default applies, so the control reads Default, never its slowest level.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";

/** The effort control as the plain renderer build compiles it, and React's server renderer. */
async function effortControl() {
  const result = await build({
    stdin: {
      contents: [
        'export { ComposerEffort } from "./src/renderer/ui/ComposerEffort.tsx";',
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

// A fresh profile's composer read "Low" on Opus while its sends named no effort at all: the person
// saw the slowest level where the CLI's own default ran.
test("with no pick the effort control reads Default, and a pick reads as itself", async () => {
  const { ComposerEffort, createElement, renderToStaticMarkup } = await effortControl();
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const onChange = () => {};
  const unpicked: string = renderToStaticMarkup(createElement(ComposerEffort, { efforts, value: null, onChange }));
  assert.match(unpicked, /aria-label="Effort: Default"/, unpicked);
  const picked: string = renderToStaticMarkup(createElement(ComposerEffort, { efforts, value: "high", onChange }));
  assert.match(picked, /aria-label="Effort: High"/, picked);
});
