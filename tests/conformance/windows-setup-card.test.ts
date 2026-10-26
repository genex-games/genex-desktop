/**
 * The Windows setup card names a disabled Secondary Logon service in one plain line: while Set up
 * runs or waits for the approval, that Set up turns it back on; after a Set up that could not, what
 * to do by hand. The setup and start-failure cards offer a new version downloaded meanwhile.
 * Rendered from the plain renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { SandboxProblemCode, StudioPlatform, type SandboxProblem, WindowsSetupNeed } from "../../src/shared/boot.ts";
import { SANDBOX_SETUP_WORDS, UPDATE_WORDS } from "../../src/renderer/words.ts";
import { type ReadyUpdate, UpdateAction } from "../../src/shared/app-update.ts";

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
        'export { StartFailed, WindowsSetup } from "./src/renderer/SandboxSetup.tsx";',
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

async function renderCard(
  held: SandboxProblem,
  state: { settingUp: boolean; error: string | null; update?: ReadyUpdate | null },
) {
  const { WindowsSetup, SetupReport, createElement, renderToStaticMarkup } = await card();
  const props = {
    problem: held,
    report: SetupReport.Idle,
    onSetUp: () => {},
    onReport: () => {},
    update: null,
    onUpdate: () => {},
    ...state,
  };
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

test("a sandbox another release set up asks for one OK to update it, with one button", async () => {
  const words = SANDBOX_SETUP_WORDS.windows.reinstall;
  const held = problem([WindowsSetupNeed.Reinstall]);
  const waiting = await renderCard(held, { settingUp: false, error: null });
  assert.match(waiting, /data-windows-setup="needs-ok"/);
  assert.ok(waiting.includes(escaped(words.title)));
  assert.ok(waiting.includes(escaped(words.line)));
  assert.equal(waiting.match(/data-sandbox-set-up/g)?.length, 1, "one button");
  assert.ok(waiting.includes(`>${escaped(words.update)}</button>`));
  assert.ok(!waiting.includes(escaped(SANDBOX_SETUP_WORDS.windows.needsOk.title)));
  const updating = await renderCard(held, { settingUp: true, error: null });
  assert.ok(updating.includes(escaped(words.updating)));
  assert.doesNotMatch(updating, /data-sandbox-set-up/);
});

const UPDATE_LINE = /data-boot-update="restart"/;
const NEXT: ReadyUpdate = { version: "0.1.14", action: UpdateAction.Restart };

test("a setup card offers the relaunch into a version downloaded meanwhile", async () => {
  for (const error of [null, "srt-win install failed"]) {
    const markup = await renderCard(problem(), { settingUp: false, error, update: NEXT });
    assert.match(markup, UPDATE_LINE, `error=${error}`);
    assert.ok(markup.includes(escaped(UPDATE_WORDS.restart)));
    assert.ok(markup.includes(escaped(SANDBOX_SETUP_WORDS.update.ready("0.1.14"))));
  }
  assert.doesNotMatch(await renderCard(problem(), { settingUp: false, error: null }), UPDATE_LINE);
});

test("a start that failed offers it too", async () => {
  const { StartFailed, SetupReport, createElement, renderToStaticMarkup } = await card();
  const render = (update: ReadyUpdate | null) =>
    renderToStaticMarkup(
      createElement(StartFailed, {
        error: "harness exited during boot",
        report: SetupReport.Idle,
        onRetry: () => {},
        onReport: () => {},
        onQuit: () => {},
        update,
        onUpdate: () => {},
      }),
    ) as string;
  assert.match(render(NEXT), UPDATE_LINE);
  assert.doesNotMatch(render(null), UPDATE_LINE);
});

/** Text as React's server renderer writes it. */
function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
