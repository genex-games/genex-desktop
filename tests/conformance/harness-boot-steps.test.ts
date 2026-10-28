// A slow first start names the part of the harness boot that held it: the host marks when the
// harness process is started and when it says it is ready.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HarnessBootStep, HarnessHost } from "../../src/substrate/harness-host.ts";
import type { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BOOTSTRAP = fileURLToPath(new URL("../../src/harness-boot/bootstrap.mjs", import.meta.url));
const FIXTURE_OK = fileURLToPath(new URL("../fixtures/harness-ok", import.meta.url));

/** Runs the harness's command in a plain shell: the steps are the host's, not the sandbox's. */
const shellSandbox = {
  spawnLongLived: async (request: { command: string; cwd: string; env?: Record<string, string> }) => ({
    child: spawn("sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  }),
} as unknown as ProcessSandbox;

test("the harness boot marks its process start and its ready, in order", {
  skip: process.platform === "win32" && "the stand-in sandbox runs sh",
}, async () => {
  const root = await tmpDir("studio-boot-steps-");
  const workspace = path.join(root, "harness");
  await mkdir(root, { recursive: true });
  await cp(FIXTURE_OK, workspace, { recursive: true });
  const steps: string[] = [];
  const host = new HarnessHost({
    workspace,
    bootstrap: BOOTSTRAP,
    execPath: process.execPath,
    sandbox: shellSandbox,
    api: {},
    updatesDir: path.join(root, "updates"),
    onBootStep: (step) => steps.push(step),
  });
  try {
    await host.start();
    assert.deepEqual(steps, [HarnessBootStep.Spawned, HarnessBootStep.Ready]);
  } finally {
    await host.stop(200);
  }
});
