/**
 * OpenCode's vendor publishes no Windows installer Genex can run (`installsInApp`), so on Windows its
 * Settings row and its first-launch screen offer the install guide instead of an Install that can only
 * fail; on macOS and Linux they keep Install. Rendered from the plain renderer build with React's
 * server renderer, on the platform main reports (`data-platform`).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { CodingCliState } from "../../src/shared/coding-cli.ts";
import { EngineStatusCode, LoginSource } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";

/** The row and the screen as the renderer build compiles them, and React's server renderer. */
async function views() {
  const result = await build({
    stdin: {
      contents: [
        'export { default as CliSignInRow } from "./src/renderer/panels/CliSignInRow.tsx";',
        'export { OpenCodeScreen } from "./src/renderer/onboarding/OpenCodeScreen.tsx";',
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

const missing = {
  id: EngineId.OpenCode,
  label: "OpenCode",
  kind: "delegated",
  status: { code: EngineStatusCode.NotInstalled, detail: "" },
};

/** The page's root as main's answer sets it: `data-platform` in `process.platform` spelling. */
function onPlatform(platform: string): void {
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { dataset: { platform } } },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
});

describe("OpenCode where Genex can't install it", () => {
  it("Settings offers its install guide on Windows, and Install elsewhere", async () => {
    const { CliSignInRow, createElement, renderToStaticMarkup } = await views();
    const row = (platform: string): string => {
      onPlatform(platform);
      return renderToStaticMarkup(
        createElement(CliSignInRow, { engine: missing, provider: EngineId.OpenCode, onEnginesRefresh: () => {} }),
      );
    };
    const windows = row("win32");
    assert.match(windows, />Install guide</);
    assert.match(windows, /Install OpenCode with its guide, then check again\./);
    assert.match(windows, />Check again</);
    assert.doesNotMatch(windows, />Install OpenCode</, "no Install that can only fail");
    for (const platform of ["darwin", "linux"]) {
      const html = row(platform);
      assert.match(html, />Install OpenCode</, platform);
      assert.doesNotMatch(html, />Install guide</, platform);
    }
  });

  it("first launch's OpenCode screen opens the guide on Windows instead of Set up", async () => {
    const { OpenCodeScreen, createElement, renderToStaticMarkup } = await views();
    const screen = (openGuide: (() => void) | null): string =>
      renderToStaticMarkup(
        createElement(OpenCodeScreen, {
          code: {
            row: "not_installed",
            checking: false,
            terminal: null,
            problem: null,
            setTerminalError: () => {},
            install: () => {},
            openGuide,
            recheck: () => {},
            signIn: () => {},
            cancelSignIn: () => {},
            openSignInPage: null,
          },
          free: null,
          anyOn: false,
          onBack: () => {},
          onSkip: () => {},
          onStart: () => {},
        }),
      );
    const windows = screen(() => {});
    assert.match(windows, />Open install guide</);
    assert.match(windows, /On Windows, OpenCode installs from its guide/);
    assert.doesNotMatch(windows, />Set up OpenCode</);
    const mac = screen(null);
    assert.match(mac, />Set up OpenCode</);
    assert.doesNotMatch(mac, /install guide/i);
  });
});

describe("Pi, which Genex installs nowhere", () => {
  it("Settings offers its install guide on every system", async () => {
    const { CliSignInRow, createElement, renderToStaticMarkup } = await views();
    const engine = { ...missing, id: EngineId.Pi, label: "Pi" };
    for (const platform of ["darwin", "linux", "win32"]) {
      onPlatform(platform);
      const html = renderToStaticMarkup(
        createElement(CliSignInRow, { engine, provider: EngineId.Pi, onEnginesRefresh: () => {} }),
      );
      assert.match(html, />Install guide</, platform);
      assert.match(html, /Install Pi with its guide, then check again\./, platform);
    }
  });

  it("a Pi too old for a session says to update it, and offers its guide: Genex can update only a Pi that runs", async () => {
    const { CliSignInRow, createElement, renderToStaticMarkup } = await views();
    onPlatform("linux");
    const row = (state: CodingCliState) =>
      renderToStaticMarkup(
        createElement(CliSignInRow, {
          engine: {
            ...missing,
            id: EngineId.Pi,
            label: "Pi",
            status: { code: EngineStatusCode.Error, detail: "" },
            account: { source: LoginSource.None, cli: { state } },
          },
          provider: EngineId.Pi,
          onEnginesRefresh: () => {},
        }),
      );
    const old = row(CodingCliState.Incompatible);
    assert.match(old, />Update needed</);
    assert.match(old, /This version of Pi is too old for Genex\. Update Pi, then check again\./);
    assert.match(old, />Install guide</);
    assert.match(old, />Check again</);
    assert.doesNotMatch(old, />Update Pi</, "Pi's own update is run only for a Pi that is ready");
    assert.doesNotMatch(old, /didn(&#x27;|')t answer/);
    const noRuntime = row(CodingCliState.MissingRuntime);
    assert.match(noRuntime, /Pi didn(&#x27;|')t answer\. Check the installation, then try again\./);
    assert.doesNotMatch(noRuntime, /too old/, "a Pi that could not start is not an old one");
  });
});
