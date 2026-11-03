import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Stable developer-build id so every spec shares one compiled tree. */
export const PLAYWRIGHT_BUILD_ID = "playwright-e2e";

const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));

/** Absolute checkout this suite launches from. */
export function checkoutRoot(): string {
  return CHECKOUT;
}

/** Folder of the shared `--dev-build=playwright-e2e` output. */
export function playwrightBuildRoot(): string {
  return path.join(CHECKOUT, ".studio-dev", "builds", PLAYWRIGHT_BUILD_ID);
}

/** Main-process entry of that developer build. */
export function playwrightMainPath(): string {
  return path.join(playwrightBuildRoot(), "main", "main.mjs");
}

/** Whether the shared developer build is already on disk. */
export function playwrightBuildReady(): boolean {
  return fs.existsSync(playwrightMainPath()) && fs.existsSync(path.join(playwrightBuildRoot(), "build.json"));
}

/**
 * Compile a fixture developer build when missing, or when `GENEX_E2E_FORCE_BUILD=1`.
 * `GENEX_E2E_SKIP_BUILD=1` reuses a present tree and fails if it is absent.
 */
export function ensurePlaywrightBuild(): string {
  const skip = process.env.GENEX_E2E_SKIP_BUILD === "1";
  const force = process.env.GENEX_E2E_FORCE_BUILD === "1";
  if (skip && !playwrightBuildReady()) {
    throw new Error("GENEX_E2E_SKIP_BUILD=1 but the playwright-e2e developer build is missing");
  }
  if (!skip && (force || !playwrightBuildReady())) {
    const result = spawnSync(
      process.execPath,
      ["scripts/build.mjs", `--dev-build=${PLAYWRIGHT_BUILD_ID}`, "--commit-counts"],
      { cwd: CHECKOUT, stdio: "inherit", env: process.env },
    );
    if (result.status !== 0) throw new Error(`developer build failed (${result.status})`);
  }
  if (!playwrightBuildReady()) throw new Error("playwright-e2e developer build is missing after compile");
  return playwrightMainPath();
}
