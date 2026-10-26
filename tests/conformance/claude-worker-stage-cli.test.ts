import { test } from "node:test";
import assert from "node:assert/strict";
import { stageCli } from "../../src/main/smoke/claude-worker-check.ts";
import { CliInstallProblem } from "../../src/shared/cli-install.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import type { InstallerRun } from "../../src/substrate/cli-installer.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The whole self test's limit with this stage (`run-electron-e2e.mjs`), which the install must report inside. */
const SELF_TEST_MS = 10 * MINUTE_MS;
/** What the stage needs after the install, its worker's turn included, as the canary measured it. */
const AFTER_INSTALL_MS = 3 * MINUTE_MS;

/** A fetch that serves a stand-in installer script for any URL. */
const serving: typeof fetch = (async (input: string | URL | Request) => {
  const response = new Response("echo installing");
  Object.defineProperty(response, "url", { value: String(input) });
  return response;
}) as typeof fetch;

test("a stalled Claude install is reported inside the self test, with how long it ran and what it printed", async () => {
  const home = await tmpDir("claude-stage-cli-");
  let clock = 0;
  let allowed = 0;
  const stalls: InstallerRun = async (_command, { timeoutMs }) => {
    allowed = timeoutMs;
    clock += timeoutMs;
    return { code: null, output: "Setting up Claude Code...", timedOut: true };
  };

  const cli = await stageCli(home, { fetch: serving, run: stalls, now: () => clock });

  assert.equal(cli.path, null);
  assert.ok(
    allowed > 0 && allowed <= SELF_TEST_MS - AFTER_INSTALL_MS,
    `the install gets ${allowed} ms, inside the self test`,
  );
  assert.match(cli.detail, new RegExp(`^${CliInstallProblem.TimedOut} after ${allowed / SECOND_MS} s: `));
  assert.match(cli.detail, /Setting up Claude Code\.\.\./);
});

test("a failing Claude installer is reported with its exit and output, and how long it ran", async () => {
  const home = await tmpDir("claude-stage-cli-");
  let clock = 0;
  const fails: InstallerRun = async () => {
    clock += 12 * SECOND_MS;
    return { code: 1, output: "Failed to download binary", timedOut: false };
  };

  const cli = await stageCli(home, { fetch: serving, run: fails, now: () => clock });

  assert.equal(cli.path, null);
  assert.match(cli.detail, new RegExp(`^${CliInstallProblem.Installer} after 12 s: .*Failed to download binary`));
});
