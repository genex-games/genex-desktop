/** Render the real host cards with disposable records; no provider or native worker is started. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { _electron as electron, expect } from "@playwright/test";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { removeTree } from "../helpers/tmp.ts";

await test("host native job cards disclose limits, follow receipts and cancel by keyboard", async () => {
  const root = process.cwd();
  const evidence =
    process.env.GITHUB_ACTIONS && process.platform === "win32"
      ? ".studio-dev/evidence/windows-tests"
      : ".studio-dev/evidence";
  const out = path.join(root, evidence, "native-jobs-ui");
  await mkdir(out, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), "genex-native-jobs-ui-"));
  await build({
    entryPoints: ["tests/e2e/native-jobs-fixture.tsx"],
    outfile: path.join(out, "fixture.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  stop();
  await writeFile(
    path.join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, "dist/renderer/theme.css")).href}"><div id="root"></div><script type="module" src="fixture.js"></script>`,
  );
  const main = path.join(out, "check.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:900,show:false,x:-4000,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.showInactive();w.loadFile(${JSON.stringify(path.join(out, "index.html"))});});`,
  );
  const app = await electron.launch({
    executablePath: resolveElectron(),
    args: fixtureElectronArgs([main]),
    env: fixtureElectronEnv(),
  });
  const checks = [];
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(String(error)));
    await expect(page.locator("[data-native-job]")).toHaveCount(4);
    await expect(page.locator("[data-native-job-limits]")).toContainText("up to 35 minutes");
    await expect(page.locator("[data-native-job-limits]")).toContainText("uses the GPU");
    checks.push("manifest duration and GPU disclosure rendered");
    const cancel = page.getByRole("button", { name: "Cancel hunyuan-shape" });
    await expect(cancel).toHaveCount(1);
    await expect(cancel).toHaveCSS("cursor", "pointer");
    await expect(page.locator('[data-native-job="job-0"] [data-native-job-elapsed]')).toHaveText(/3:\d\d/);
    checks.push("running card has elapsed time and one host Cancel control");
    expect(await page.evaluate(() => window.nativeJobsFixture.detailCalls)).toEqual([]);
    await expect(page.locator('[data-native-job="job-3"] [data-native-job-elapsed]')).toHaveText("—");
    const completed = page.locator('[data-native-job="job-1"]');
    await page.evaluate(() => window.nativeJobsFixture.holdDetails());
    await completed.getByRole("button", { name: "Show details for hunyuan-shape" }).click();
    await expect(completed).toContainText("Loading details…");
    await page.evaluate(() => window.nativeJobsFixture.releaseDetails());
    await expect(completed.locator("[data-native-job-log]")).toContainText("Mesh generation complete.");
    await expect(completed.locator("[data-native-job-files]")).toContainText("shape.glb");
    expect(await page.evaluate(() => window.nativeJobsFixture.detailCalls)).toEqual([
      { plugin: "local-generation", jobId: "job-1" },
    ]);
    const polls = await page.evaluate(() => window.nativeJobsFixture.summaryCalls());
    await expect.poll(() => page.evaluate(() => window.nativeJobsFixture.summaryCalls())).toBeGreaterThan(polls);
    expect(await page.evaluate(() => window.nativeJobsFixture.detailCalls.length)).toBe(1);
    await completed.getByRole("button", { name: "Hide details for hunyuan-shape" }).click();
    await page.evaluate(() => window.nativeJobsFixture.failDetails("job-1"));
    await completed.getByRole("button", { name: "Show details for hunyuan-shape" }).click();
    await expect(completed.getByRole("alert")).toContainText("Unable to load job details. Try again.");
    await page.evaluate(() => window.nativeJobsFixture.clearDetailFailure());
    await completed.getByRole("button", { name: "Retry" }).click();
    await expect(completed.locator("[data-native-job-log]")).toContainText("Mesh generation complete.");
    await completed.getByRole("button", { name: "Hide details for hunyuan-shape" }).click();
    await page.evaluate(() => window.nativeJobsFixture.emptyDetails("job-1"));
    await completed.getByRole("button", { name: "Show details for hunyuan-shape" }).click();
    await expect(completed).toContainText("No logs or output files yet.");
    checks.push("summary polling never downloads logs; explicit details supports loading, retry and empty output");

    await page.evaluate(() => window.nativeJobsFixture.theme("light"));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightBackground = await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
    await page.screenshot({ path: path.join(out, "jobs-light.png") });
    await page.evaluate(() => window.nativeJobsFixture.theme("dark"));
    expect(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor)).not.toBe(
      lightBackground,
    );
    await page.screenshot({ path: path.join(out, "jobs-dark.png") });
    await cancel.focus();
    await page.keyboard.press("Enter");
    await expect(cancel).toBeDisabled();
    expect(await page.evaluate(() => window.nativeJobsFixture.calls)).toEqual([
      { plugin: "local-generation", jobId: "job-0" },
    ]);
    checks.push("keyboard Cancel routes the exact plugin/job and prevents duplicate requests");
    await page.evaluate(() => window.nativeJobsFixture.release());
    await expect(page.locator('[data-native-job="job-0"]')).toContainText("Cancelled");
    await expect(page.getByRole("button", { name: "Cancel hunyuan-shape" })).toHaveCount(0);
    checks.push("completed cancellation updates the durable card and removes Cancel");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(480, 800));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(out, "jobs-narrow.png") });
    checks.push("narrow panel has no horizontal overflow");
    await page.evaluate(() => window.nativeJobsFixture.fail());
    await expect(page.getByRole("alert")).toContainText("Unable to read job records");
    await expect(page.locator("[data-native-job]")).toHaveCount(4);
    checks.push("read failures are visible and retain the last records");
    expect(errors).toEqual([]);
    await writeFile(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          checks,
          errors,
          provider: "fixture",
          scope: "isolated host component with synthetic receipts",
          electron: await app.evaluate(() => process.versions.electron),
        },
        null,
        2,
      ),
    );
    for (const check of checks) console.log(`✔ ${check}`);
  } finally {
    console.log("Closing disposable Electron fixture");
    await app.close();
    console.log("Removing disposable Electron profile");
    await removeTree(profile);
    console.log("Disposable fixture cleanup complete");
  }
});
