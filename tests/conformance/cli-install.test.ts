import { it } from "node:test";
import assert from "node:assert/strict";
import { createCliInstalls } from "../../src/main/cli-install.ts";

it("a manual update never invokes the installer and refuses active work", async () => {
  let installs = 0;
  let updates = 0;
  let busy = true;
  const jobs = createCliInstalls({
    install: async () => {
      installs++;
      return { ok: true };
    },
    update: async () => {
      updates++;
      return { ok: true };
    },
    busy: () => busy,
    found: async () => true,
    pushUiEvent: () => {},
    log: () => {},
  });
  assert.throws(() => jobs.start("codex", "update"), /active work/);
  assert.equal(updates, 0);
  busy = false;
  jobs.start("codex", "update");
  const done = await jobs.settled("codex");
  assert.equal(done?.phase, "installed");
  assert.equal(updates, 1);
  assert.equal(installs, 0);
});

import { updateCodingCli } from "../../src/substrate/cli-update.ts";
import { CliInstallProblem } from "../../src/shared/cli-install.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
it("CLI update runs only the selected executable then verifies that installation", async () => {
  const calls: string[] = [];
  const result = await updateCodingCli("codex", "/selected/codex", {
    resolve: async (provider, executable) => {
      calls.push(`resolve ${executable}`);
      return { ...(await fixtureCodingCli(provider)), path: "/selected/codex" };
    },
    run: async (binary, args) => {
      calls.push(`${binary} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    invalidate: () => {
      calls.push("invalidate");
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    "resolve /selected/codex",
    "/selected/codex update",
    "invalidate",
    "resolve /selected/codex",
  ]);
});

it("a CLI inside a desktop app is never asked to update itself: the app updates it", async () => {
  const bundled = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Users/sam/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
    "/Users/sam/Library/Application Support/Claude/claude-code/2.1.0/abc/claude.app/Contents/MacOS/claude",
  ];
  for (const executable of bundled) {
    const ran: string[] = [];
    const result = await updateCodingCli("codex", executable, {
      resolve: async (provider) => ({ ...(await fixtureCodingCli(provider)), path: executable }),
      run: async (binary, args) => {
        ran.push(`${binary} ${args.join(" ")}`);
        return { code: 1, stdout: "", stderr: "" };
      },
      real: async (file) => file,
    });
    assert.equal(!result.ok && result.problem, CliInstallProblem.AppManaged, executable);
    assert.deepEqual(ran, [], executable);
  }
  // A launcher that only points into an app (a link on the PATH) is the app's copy too.
  const linked = await updateCodingCli("codex", "/usr/local/bin/codex", {
    resolve: async (provider) => ({ ...(await fixtureCodingCli(provider)), path: "/usr/local/bin/codex" }),
    run: async () => assert.fail("the app's copy was run"),
    real: async () => bundled[0],
  });
  assert.equal(!linked.ok && linked.problem, CliInstallProblem.AppManaged);
  // Names that merely look like an app folder are ordinary installs.
  for (const executable of [
    "/opt/my.app/bin/codex",
    "/Users/sam/.application/Contents/codex",
    "/opt/homebrew/bin/codex",
  ]) {
    const ran: string[] = [];
    const result = await updateCodingCli("codex", executable, {
      resolve: async (provider) => ({ ...(await fixtureCodingCli(provider)), path: executable }),
      run: async (binary, args) => {
        ran.push(`${binary} ${args.join(" ")}`);
        return { code: 0, stdout: "", stderr: "" };
      },
      invalidate: () => {},
      real: async (file) => file,
    });
    assert.deepEqual(result, { ok: true }, executable);
    assert.deepEqual(ran, [`${executable} update`], executable);
  }
});
