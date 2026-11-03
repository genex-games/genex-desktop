import { defineConfig } from "@playwright/test";

/** HTML and JUnit land with the other disposable evidence, never in Git. */
const EVIDENCE = "../../.studio-dev/evidence/playwright";

/**
 * Playwright drives the built Electron app (`_electron`), one worker, fixture profiles only.
 * The shell entrypoint (`scripts/run-playwright-e2e.sh`) builds first and wraps xvfb on Linux.
 */
export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${EVIDENCE}/html`, open: "never" }],
    ["junit", { outputFile: `${EVIDENCE}/junit.xml` }],
  ],
  outputDir: `${EVIDENCE}/test-results`,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
