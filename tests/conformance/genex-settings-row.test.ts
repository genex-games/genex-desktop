/**
 * Settings → Model Providers, Genex's row (`panels/GenexBuildRow.tsx`): shown only where
 * genex.games offers building with credits; a status plate and the chat notice's line and step for
 * what is missing; once ready, Connected with its Account menu. Rendered from the plain renderer
 * build with React's server renderer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { type EngineStatus, EngineStatusCode, EngineStatusReason } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { GenexNeed } from "../../src/renderer/genex-build.ts";

/** The row as the renderer build compiles it, and React's server renderer. */
async function views() {
  const result = await build({
    stdin: {
      contents: [
        'export { GenexBuildRow, GenexCard, genexRowView } from "./src/renderer/panels/GenexBuildRow.tsx";',
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
    plugins: [
      {
        name: "no-studio",
        setup(on) {
          on.onResolve({ filter: /\/App\.tsx$/ }, () => ({ path: "app", namespace: "no-studio" }));
          on.onLoad({ filter: /.*/, namespace: "no-studio" }, () => ({
            contents: "export function App() { return null; }",
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const engine = (status: EngineStatus) => ({ id: EngineId.Genex, label: "Genex", kind: "delegated", status });
const signedOut = { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.NotSignedIn };
const quiet = { waiting: false, installing: false, primary: async () => {} };
const act = { onCheck: () => {}, onGetCredits: () => {} };

describe("Genex's row in Model Providers", () => {
  it("is not there where genex.games does not offer Genex, nor in a build without it", async () => {
    const { GenexBuildRow, createElement, renderToStaticMarkup } = await views();
    const notOffered = { code: EngineStatusCode.NotInstalled, detail: "", reason: EngineStatusReason.NotOffered };
    for (const engines of [[engine(notOffered)], []])
      assert.equal(renderToStaticMarkup(createElement(GenexBuildRow, { engines, onEnginesRefresh: () => {} })), "");
  });

  it("says what is missing in the chat notice's words, with its one step", async () => {
    const { GenexCard, genexRowView, createElement, renderToStaticMarkup } = await views();
    const draw = (need: GenexNeed, installing = false): string =>
      renderToStaticMarkup(
        createElement(GenexCard, {
          engine: engine(signedOut),
          view: genexRowView({ ...quiet, installing, need }, act),
          checking: false,
          problem: null,
        }),
      );
    const signIn = draw(GenexNeed.SignIn);
    assert.match(signIn, /data-provider-row="genex"/);
    assert.match(signIn, />Genex</);
    assert.match(signIn, /data-tone="off"[^>]*>.*Not connected</);
    assert.match(signIn, /Sign in to Genex and pick Pro or a credit pack to start building\.</);
    assert.match(signIn, /data-genex-action="primary"[^>]*>Continue in browser</);
    const out = draw(GenexNeed.OutOfCredits);
    assert.match(out, /data-tone="warning"[^>]*>.*Out of credits</);
    assert.match(out, /You’re out of Genex credits\. Everything so far is saved\.</);
    assert.match(out, /data-genex-action="primary"[^>]*>Get credits</);
    const settingUp = draw(GenexNeed.Setup, true);
    assert.match(settingUp, /data-tone="busy"[^>]*>.*Setting up…</);
    assert.doesNotMatch(settingUp, /data-genex-action/, "nothing to press while it sets up");
    assert.doesNotMatch(signIn + out + settingUp, /Genex AI/);
  });

  it("reads Connected once Genex is ready, with its Account menu", async () => {
    const { GenexCard, genexRowView, createElement, renderToStaticMarkup } = await views();
    const html: string = renderToStaticMarkup(
      createElement(GenexCard, {
        // A signed-out engine keeps the picker's model list, which needs the running app, out of the render.
        engine: engine(signedOut),
        view: genexRowView({ ...quiet, need: null }, act),
        checking: false,
        problem: "genex.games couldn’t be reached.",
      }),
    );
    assert.match(html, /data-tone="connected"[^>]*>.*Connected</);
    assert.match(html, /Builds with your Genex credits\.</);
    assert.match(html, /aria-label="Genex account"/);
    assert.match(html, /role="alert"[^>]*>genex\.games couldn’t be reached\.</);
  });
});
