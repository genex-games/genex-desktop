/** Windows keyboard and setup acceptance in real Electron, with synthetic actions only. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { _electron, expect } from "@playwright/test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";
import { studioWindowSize } from "../../src/main/window-chrome.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.join(root, ".studio-dev/evidence/windows-ui");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
await build({
  entryPoints: [path.join(root, "tests/e2e/windows-ui-fixture.tsx")],
  outfile: path.join(output, "fixture.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
});
await build({
  entryPoints: [path.join(root, "src/main/window-chrome.ts")],
  outfile: path.join(output, "chrome.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
});
await cp(path.join(root, "dist/renderer/theme.css"), path.join(output, "theme.css"));
await cp(path.join(root, "src/renderer/fonts"), path.join(output, "fonts"), { recursive: true });
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="theme.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="fixture.js"></script>',
);
const bootstrap = path.join(output, "app.cjs");
await writeFile(
  bootstrap,
  `const {app,BrowserWindow}=require('electron');
const {windowChrome}=require(${JSON.stringify(path.join(output, "chrome.cjs"))});
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, "session"))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1080,height:680,x:-12000,y:-12000,show:false,skipTaskbar:true,focusable:false,...windowChrome(process.platform),webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();win.loadFile(${JSON.stringify(path.join(output, "index.html"))});});`,
);
const report = { source: sourceIdentity(root), provider: "none", profile, checks: [] };
let application;
async function check(name, operation) {
  try {
    await operation();
    report.checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, ok: false, detail: String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
try {
  application = await _electron.launch({
    executablePath: resolveElectron(root),
    args: fixtureElectronArgs([bootstrap]),
    env: fixtureElectronEnv(),
    timeout: 20_000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(2000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("textbox", { name: "Keyboard fixture" })).toBeVisible();
  const dispatch = async (key, code, modifiers, wanted) => {
    await page.evaluate(() => window.windowsFixture.reset());
    await page.evaluate(
      ({ key, code, modifiers }) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers }),
        ),
      { key, code, modifiers },
    );
    assert.deepEqual(await page.evaluate(() => window.windowsFixture.calls()), wanted);
  };
  for (const [key, code, wanted] of [
    ["b", "KeyB", "sidebar"],
    ["k", "KeyK", "search"],
    ["n", "KeyN", "new"],
    ["1", "Digit1", "game"],
    ["2", "Digit2", "studio"],
  ]) {
    await check(`Ctrl+${key} operates the expected app action`, () => dispatch(key, code, { ctrlKey: true }, [wanted]));
  }
  await check("Ctrl+B works with a Cyrillic keyboard layout", () =>
    dispatch("и", "KeyB", { ctrlKey: true }, ["sidebar"]),
  );
  await check("recognized logical keys keep alternate Latin layouts usable", () =>
    dispatch("b", "KeyN", { ctrlKey: true }, ["sidebar"]),
  );
  await check("alternate Latin layouts preserve browser copy commands", () =>
    dispatch("c", "KeyI", { ctrlKey: true }, []),
  );
  await check("Ctrl+1 works when the number row produces a layout symbol", () =>
    dispatch("&", "Digit1", { ctrlKey: true }, ["game"]),
  );
  await check("Chromium keyboard input reaches the app shortcut handler", async () => {
    await page.evaluate(() => window.windowsFixture.reset());
    await page.keyboard.press("Control+b");
    assert.deepEqual(await page.evaluate(() => window.windowsFixture.calls()), ["sidebar"]);
  });
  await check("AltGr text does not trigger app commands", () =>
    dispatch("b", "KeyB", { ctrlKey: true, altKey: true }, []),
  );
  await check("Ctrl+Shift+N does not create an unintended game", () =>
    dispatch("N", "KeyN", { ctrlKey: true, shiftKey: true }, []),
  );
  await check("held Ctrl+N does not create repeated games", () =>
    dispatch("n", "KeyN", { ctrlKey: true, repeat: true }, []),
  );
  await check("Alt+Down steps through conversations", () =>
    dispatch("ArrowDown", "ArrowDown", { altKey: true }, ["rail:1"]),
  );
  await check("Ctrl+Alt+Down is left to Windows", () =>
    dispatch("ArrowDown", "ArrowDown", { ctrlKey: true, altKey: true }, []),
  );
  await check("composition input does not invoke a command", () =>
    dispatch("n", "KeyN", { ctrlKey: true, isComposing: true }, []),
  );
  await check("an app-owned modal blocks shortcuts", async () => {
    await page.evaluate(() => window.windowsFixture.block(true));
    await dispatch("n", "KeyN", { ctrlKey: true }, []);
    await page.evaluate(() => window.windowsFixture.block(false));
  });
  await check("a DOM dialog owns the keyboard", async () => {
    await page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
    });
    await dispatch("b", "KeyB", { ctrlKey: true }, []);
    await page.evaluate(() => document.querySelector('[role="dialog"]').remove());
  });
  await page.evaluate(() => window.windowsFixture.mode("setup"));
  await check("setup action uses a pointer and invokes only the explicit callback", async () => {
    const button = page.locator("[data-sandbox-set-up]");
    await expect(button).toBeVisible();
    assert.equal(await button.evaluate((element) => getComputedStyle(element).cursor), "pointer");
    await page.evaluate(() => window.windowsFixture.reset());
    await button.click();
    assert.deepEqual(await page.evaluate(() => window.windowsFixture.calls()), ["setup"]);
  });
  await check("busy setup disables both actions and exposes busy state", async () => {
    await page.evaluate(() => window.windowsFixture.mode("busy"));
    await expect(page.locator("[data-sandbox-set-up]")).toBeDisabled();
    await expect(page.locator("[data-sandbox-retry]")).toBeDisabled();
    await expect(page.locator("[data-sandbox-set-up]")).toHaveAttribute("aria-busy", "true");
    assert.notEqual(
      await page.locator("[data-sandbox-set-up]").evaluate((element) => getComputedStyle(element).cursor),
      "pointer",
    );
  });
  await check("a cancelled UAC keeps setup retryable", async () => {
    await page.evaluate(() => window.windowsFixture.mode("cancelled"));
    await expect(page.locator("[data-sandbox-set-up]")).toBeEnabled();
    await expect(page.locator("[data-sandbox-retry]")).toBeEnabled();
  });
  await check("missing Git offers built-in setup without terminal instructions", async () => {
    await page.evaluate(() => window.windowsFixture.mode("git-setup"));
    await expect(page.locator("[data-sandbox-set-up]")).toBeEnabled();
    await expect(page.getByText("Genex will download Git Bash for this app.", { exact: false })).toBeVisible();
    await page.screenshot({ path: path.join(output, "setup-windows-git.png") });
  });
  for (const zoom of [1, 1.25, 2]) {
    await check(`long setup errors remain scrollable at ${zoom * 100}% zoom`, async () => {
      await application.evaluate(
        ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
        zoom,
      );
      await page.evaluate(() => window.windowsFixture.mode("error"));
      await expect(page.getByRole("alert")).toBeVisible();
      await page.locator("[data-sandbox-retry]").scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await expect(page.locator("[data-sandbox-retry]")).toBeInViewport();
    });
  }
  for (const area of [
    { width: 960, height: 500 },
    { width: 640, height: 360 },
  ]) {
    for (const zoom of [1, 2]) {
      await check(
        `setup actions remain reachable at ${area.width}x${area.height} and ${zoom * 100}% zoom`,
        async () => {
          await application.evaluate(
            ({ BrowserWindow }, { size, zoom }) => {
              const win = BrowserWindow.getAllWindows()[0];
              win.setMinimumSize(size.minWidth, size.minHeight);
              win.setSize(size.width, size.height);
              win.webContents.setZoomFactor(zoom);
            },
            { size: studioWindowSize("win32", area), zoom },
          );
          await page.evaluate(() => window.windowsFixture.mode("error"));
          await page.locator("[data-sandbox-retry]").scrollIntoViewIfNeeded();
          await expect(page.locator("[data-sandbox-retry]")).toBeInViewport();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        },
      );
    }
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 680));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.evaluate(() => window.windowsFixture.mode("setup"));
  await page.screenshot({ path: path.join(output, "setup-windows.png") });
  await check("renderer has no uncaught errors", async () => assert.deepEqual(errors, []));
} finally {
  await application?.close();
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
console.log(
  `${report.checks.filter((item) => item.ok).length}/${report.checks.length} Windows Electron UI checks passed`,
);
if (report.checks.some((item) => !item.ok)) process.exitCode = 1;
