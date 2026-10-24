/**
 * Stopping a plugin's backend (Genex quits, or the plugin is turned off) lets it end its own work
 * first: a running call's signal aborts, and a job the call started ends its program's tree. On a
 * Mac a SIGTERM does that. On Windows a signal is no request: `kill()` ends the backend outright,
 * so a job's program (Unreal's headless editor, UAT, Godot) would outlive it. There the backend's
 * channel is closed first, which the backend hears as its stop, and only then is it ended.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { PluginProcess } from "../../src/substrate/plugins/process.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BOOTSTRAP = path.resolve("src/plugin-sdk/backend.mjs");
const SETTLE_MS = 15_000;
const POSIX_SIGNALS = process.platform === "win32" && "a signal ends a Windows process outright";

/** A backend whose one tool waits forever, writing to `log` how it was told to stop. */
async function recordingBackend(root: string) {
  const log = path.join(root, "stops.log");
  const entry = path.join(root, "backend.mjs");
  await writeFile(log, "");
  await writeFile(
    entry,
    [
      'import { appendFileSync } from "node:fs";',
      `const log = ${JSON.stringify(log)};`,
      'process.on("SIGTERM", () => appendFileSync(log, "signal\\n"));',
      'process.on("disconnect", () => appendFileSync(log, "channel\\n"));',
      "export const activate = () => ({",
      "  tool: (_name, _args, context) => new Promise((resolve) => {",
      '    appendFileSync(log, "running\\n");',
      '    context.signal.addEventListener("abort", () => {',
      '    appendFileSync(log, "aborted\\n");',
      "    resolve({});",
      "  }); }),",
      "});",
    ].join("\n"),
  );
  return { log, entry };
}

/** Starts the backend on a call, stops it the way `platform` does, and answers what it heard once it exited. */
async function stopOn(platform: NodeJS.Platform): Promise<string[]> {
  const root = await tmpDir("studio-plugin-stop-");
  const { log, entry } = await recordingBackend(root);
  let exited = false;
  const backend = new PluginProcess(
    BOOTSTRAP,
    entry,
    async () => ({}),
    () => (exited = true),
    { platform },
  );
  const call = backend.call("tool", "wait", {}).catch(() => {});
  // The backend imports its entry on its first call: wait in real time for the call to be running.
  const isRunning = async () => (await readFile(log, "utf8")).includes("running");
  for (const end = Date.now() + SETTLE_MS; !(await isRunning()) && Date.now() < end; ) await pause(20);
  assert.ok(await isRunning(), "the call runs in the backend");
  backend.stop();
  await call;
  for (const end = Date.now() + SETTLE_MS; !exited && Date.now() < end; ) await pause(20);
  assert.ok(exited, "the backend exited");
  return (await readFile(log, "utf8")).split("\n").filter(Boolean);
}

describe("stopping a plugin's backend", () => {
  it("on Windows closes its channel, which the backend hears as its stop, and never signals it", async () => {
    const heard = await stopOn("win32");
    assert.ok(heard.includes("channel"), `the backend heard its channel close: ${heard.join(", ")}`);
    assert.ok(heard.includes("aborted"), "its running call was told to stop");
    assert.ok(!heard.includes("signal"), "no signal: on Windows one ends the backend before it can stop its work");
  });

  it("on a Mac asks with SIGTERM, which the backend hears as its stop", { skip: POSIX_SIGNALS }, async () => {
    const heard = await stopOn("darwin");
    assert.ok(heard.includes("signal"), `the backend heard SIGTERM: ${heard.join(", ")}`);
    assert.ok(heard.includes("aborted"), "its running call was told to stop");
  });
});
