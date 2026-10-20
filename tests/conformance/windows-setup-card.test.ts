/**
 * The Windows setup card names a disabled Secondary Logon service in one plain line: while Set up
 * runs or waits for the approval, that Set up turns it back on; after a Set up that could not, what
 * to do by hand. Rendered from the plain renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { SandboxProblemCode, StudioPlatform, type SandboxProblem, WindowsSetupNeed } from "../../src/shared/boot.ts";
import { SANDBOX_SETUP_WORDS } from "../../src/renderer/words.ts";

const WORDS = SANDBOX_SETUP_WORDS.windows.logonService;

function problem(needs?: WindowsSetupNeed[]): SandboxProblem {
  return {
    code: SandboxProblemCode.NotProvisioned,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details: [],
    ...(needs ? { windowsNeeds: needs } : {}),
  };
}

/** The setup card as the renderer build compiles it (the studio itself left out), and React's server renderer. */
async function card() {
  const result = await build({
    stdin: {
      contents: [
        'export { WindowsSetup } from "./src/renderer/SandboxSetup.tsx";',
        'export { SetupReport } from "./src/renderer/state/boot.ts";',
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

async function renderCard(held: SandboxProblem, state: { settingUp: boolean; error: string | null }) {
  const { WindowsSetup, SetupReport, createElement, renderToStaticMarkup } = await card();
  const props = { problem: held, report: SetupReport.Idle, onSetUp: () => {}, onReport: () => {}, ...state };
  return renderToStaticMarkup(createElement(WindowsSetup, props)) as string;
}

const SERVICE_LINE = /data-windows-need="logon-service"/;

test("while Set up runs or waits for the approval, the card says it turns Secondary Logon back on", async () => {
  const off = problem([WindowsSetupNeed.Sandbox, WindowsSetupNeed.LogonService]);
  for (const settingUp of [true, false]) {
    const markup = await renderCard(off, { settingUp, error: null });
    assert.match(markup, SERVICE_LINE, `settingUp=${settingUp}`);
    assert.ok(markup.includes(escaped(WORDS.line)), `settingUp=${settingUp}`);
    assert.ok(!markup.includes(escaped(WORDS.fix)));
  }
});

test("after a Set up that could not turn it on, the card says what to do by hand", async () => {
  const markup = await renderCard(problem([WindowsSetupNeed.LogonService]), {
    settingUp: false,
    error: "could not turn on seclogon",
  });
  assert.match(markup, SERVICE_LINE);
  assert.ok(markup.includes(escaped(WORDS.fix)));
  assert.ok(!markup.includes(escaped(WORDS.line)));
});

test("a sandbox that only needs installing says nothing about the service", async () => {
  for (const held of [problem(), problem([WindowsSetupNeed.Sandbox])]) {
    for (const error of [null, "srt-win install failed"]) {
      assert.doesNotMatch(await renderCard(held, { settingUp: false, error }), SERVICE_LINE);
    }
  }
});

/** Text as React's server renderer writes it. */
function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
