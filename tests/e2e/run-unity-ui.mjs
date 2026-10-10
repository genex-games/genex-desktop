/** Real rendered Unity UI with a synthetic bridge only: no Unity, licence or provider access. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { _electron, expect } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.join(root, ".studio-dev/evidence/unity-ui");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const html = (await readFile(path.join(root, "src/plugins/unity/panel.html"), "utf8")).replace(
  "<!-- STUDIO_PANEL_SDK -->",
  `<script>${await readFile(path.join(root, "src/plugin-sdk/panel.js"), "utf8")}</script>`,
);
await build({
  entryPoints: [path.join(root, "tests/e2e/unity-stage-fixture.tsx")],
  outfile: path.join(output, "fixture.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { UNITY_PANEL_HTML: JSON.stringify(html) },
});
await cp(path.join(root, "dist/renderer/theme.css"), path.join(output, "theme.css"));
await cp(path.join(root, "src/renderer/fonts"), path.join(output, "fonts"), { recursive: true });
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="theme.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script src="fixture.js"></script>',
);
const bootstrap = path.join(output, "app.cjs");
await writeFile(
  bootstrap,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, "session"))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1000,height:850,x:-12000,y:-12000,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();win.loadFile(${JSON.stringify(path.join(output, "index.html"))});});`,
);
const report = { source: sourceIdentity(root), provider: "none", bridge: "synthetic replies", profile, checks: [] };
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
  const stage = page.locator("[data-unity-stage]");
  await check("Unity chat build action opens its native workspace without exporting a browser game", async () => {
    await page.getByRole("button", { name: "Chat actions" }).click({ noWaitAfter: true });
    await expect(page.getByRole("menuitem", { name: "Build Unity player…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Build Unity player…" }).click({ noWaitAfter: true });
    assert.deepEqual(await page.evaluate(() => window.unityFixture.headerActions()), [{ name: "show-live" }]);
  });
  await page.keyboard.press("Escape");
  await check("browser chat retains its Export game action and existing export callback", async () => {
    await page.evaluate(() => window.unityFixture.header("browser"));
    await page.getByRole("button", { name: "Chat actions" }).click({ noWaitAfter: true });
    await expect(page.getByRole("menuitem", { name: "Export game…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Export game…" }).click({ noWaitAfter: true });
    const actions = await page.evaluate(() => window.unityFixture.headerActions());
    assert.deepEqual(actions.at(-1), { name: "browser-export", project: "Alpha" });
    await page.evaluate(() => window.unityFixture.header("unity"));
  });
  await check("disabled plugin gives an actionable state and hides the previous browser preview", async () => {
    await expect(stage).toContainText("Enable the Unity plugin");
    await expect(stage.getByRole("button", { name: "Open plugins" })).toBeVisible();
    const calls = await page.evaluate(() => window.unityFixture.calls());
    assert.ok(calls.some((call) => call.method === "previewBounds" && call.args[0].watching === false));
  });
  await check("loading and failed panel states remain readable and recoverable", async () => {
    await page.evaluate(() => window.unityFixture.mode("loading"));
    await expect(stage).toContainText("Opening Unity workspace");
    await page.evaluate(() => window.unityFixture.mode("error"));
    await expect(stage).toContainText("Synthetic panel loading failure");
    await expect(stage.getByRole("button", { name: "Open plugins" })).toBeVisible();
    await page.evaluate(() => window.unityFixture.mode("ready"));
  });
  const panel = page.frameLocator('iframe[title="Unity fixture panel"]');
  await check("setup and explicit connect render the real isolated panel", async () => {
    await expect(panel.locator("#setup")).toBeVisible();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    await panel.locator("#connect").click({ noWaitAfter: true });
    await expect(panel.locator("#workspace")).toBeVisible();
    await expect(panel.locator("#project")).toContainText("Alpha");
    await expect(panel.locator("#stop")).toBeDisabled();
    await expect(panel.locator("#step")).toBeDisabled();
    assert.equal(
      (await page.evaluate(() => window.unityFixture.actions())).filter((call) => call.name === "open-editor").length,
      0,
    );
  });
  await check("hierarchy selection, literal labels, console and camera capture use declared actions", async () => {
    await panel.locator("#load-hierarchy").click({ noWaitAfter: true });
    await expect(panel.locator("#target")).toHaveValue("StandaloneWindows64");
    await panel.locator("#hierarchy button").click({ noWaitAfter: true });
    await expect(panel.locator("#selection")).toContainText("Camera <literal>");
    await expect(panel.locator("#capture")).toBeEnabled();
    await panel.locator("#capture").click({ noWaitAfter: true });
    await expect(panel.locator("#capture-result")).toBeVisible();
    await panel.getByText("Console", { exact: true }).click({ noWaitAfter: true });
    await panel.locator("#read-console").click({ noWaitAfter: true });
    await expect(panel.locator("#console")).toContainText("Fixture warning <literal>");
  });
  await check("compilation disables editing controls and enabled buttons keep pointer feedback", async () => {
    await page.evaluate(() => window.unityFixture.compiling(true));
    await expect(panel.locator("#badge")).toHaveText("Compiling");
    await expect(panel.locator("#play")).toBeDisabled();
    assert.equal(await panel.locator("#play").evaluate((button) => getComputedStyle(button).cursor), "default");
    await page.evaluate(() => window.unityFixture.compiling(false));
    await expect(panel.locator("#play")).toBeEnabled();
    assert.equal(await panel.locator("#play").evaluate((button) => getComputedStyle(button).cursor), "pointer");
  });
  await check("Play mode can pause, step, resume and stop using the current state", async () => {
    await panel.locator("#play").click({ noWaitAfter: true });
    await expect(panel.locator("#pause")).toBeEnabled();
    await panel.locator("#pause").click({ noWaitAfter: true });
    await expect(panel.locator("#pause")).toHaveText("Resume");
    await expect(panel.locator("#step")).toBeEnabled();
    await panel.locator("#step").click({ noWaitAfter: true });
    await expect(panel.locator("#pause")).toBeEnabled();
    await panel.locator("#pause").click({ noWaitAfter: true });
    await expect(panel.locator("#pause")).toHaveText("Pause");
    await expect(panel.locator("#step")).toBeDisabled();
    await panel.locator("#stop").click({ noWaitAfter: true });
    await expect(panel.locator("#play")).toBeEnabled();
  });
  await check("asset search and inspection stay inside the declared panel actions", async () => {
    await panel.getByText("Assets", { exact: true }).click({ noWaitAfter: true });
    await panel.locator("#search-assets").click({ noWaitAfter: true });
    await panel.locator("#assets button").click({ noWaitAfter: true });
    await expect(panel.locator("#asset-detail")).toContainText("Assets/Tower.glb");
  });
  await check("queued tests can cancel and a completed build presents its exact output", async () => {
    await panel.getByText("Tests and builds", { exact: true }).click({ noWaitAfter: true });
    await panel.locator("#tests").click({ noWaitAfter: true });
    await expect(panel.locator("#jobs")).toContainText("tests · queued");
    await expect(panel.locator("#tests")).toBeDisabled();
    for (const action of ["play", "stop", "pause", "step"]) await expect(panel.locator(`#${action}`)).toBeDisabled();
    await panel.getByRole("button", { name: "Cancel job" }).click({ noWaitAfter: true });
    await expect(panel.locator("#jobs")).toContainText("cancelled");
    await expect(panel.locator("#play")).toBeEnabled();
    await panel.locator("#build").click({ noWaitAfter: true });
    await expect(panel.locator("#jobs")).toContainText("build · queued");
    for (const action of ["play", "stop", "pause", "step"]) await expect(panel.locator(`#${action}`)).toBeDisabled();
    const id = await panel.locator("#job-id").inputValue();
    await page.evaluate((value) => window.unityFixture.finishJob(value), id);
    await panel.locator("#read-job").click({ noWaitAfter: true });
    await expect(panel.getByRole("textbox", { name: "Completed build output path" })).toHaveValue(
      `C:/fixture/Alpha/Builds/Genex/${id}/Game.exe`,
    );
    await expect(panel.locator("#play")).toBeEnabled();
  });
  await check("lost connection returns to setup with no invisible Editor launch", async () => {
    await page.evaluate(() => window.unityFixture.connection(false));
    await panel.locator("#refresh").click({ noWaitAfter: true });
    await expect(panel.locator("#setup")).toBeVisible();
    await expect(panel.locator("#workspace")).toBeHidden();
    assert.equal(
      (await page.evaluate(() => window.unityFixture.actions())).filter((call) => call.name === "open-editor").length,
      0,
    );
    await panel.locator("#connect").click({ noWaitAfter: true });
    await expect(panel.locator("#workspace")).toBeVisible();
  });
  await check("switching projects clears the old hierarchy selection and capture", async () => {
    await page.evaluate(() => window.unityFixture.project("Beta"));
    await expect(panel.locator("#project")).toContainText("Beta", { timeout: 1000 });
    await expect(panel.locator("#selection")).toBeEmpty({ timeout: 1000 });
    await expect(panel.locator("#capture-result")).toBeHidden();
  });
  await check("long project names fit a narrow pane without horizontal scrolling", async () => {
    await page.setViewportSize({ width: 480, height: 760 });
    assert.equal(await stage.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    const frame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.ok(frame);
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  await page.screenshot({ path: path.join(output, "unity-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.screenshot({ path: path.join(output, "unity-workspace.png"), fullPage: true });
} finally {
  await application?.close();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await rm(profile, { recursive: true, force: true });
}
console.log(path.join(output, "report.json"));
process.exitCode = report.checks.every((entry) => entry.ok) ? 0 : 1;
