/** Observe a Windows process by a pinned handle, so a reused PID cannot look like a survivor. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

/** Pin before stopping the broker; immediate checks do not wait for the process to exit. */
export async function observeExit(pid: number, { immediate = false } = {}) {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop';$observed=Get-Process -Id ${pid};$null=$observed.Handle;[Console]::WriteLine('pinned');${immediate ? "$null=[Console]::ReadLine();if(-not $observed.HasExited){throw 'Observed process is still running after cancellation completed'}" : "if(-not $observed.WaitForExit(5000)){throw 'Observed process did not exit'}"};$observed.Dispose()`,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let stderr = "";
  let pinned = () => {};
  const ready = new Promise<void>((resolve) => {
    pinned = resolve;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("pinned")) pinned();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      pinned();
      if (code === 0) resolve();
      else reject(new Error(stderr));
    });
  });
  void exited.catch(() => {});
  await ready;
  assert.match(output, /pinned/, stderr);
  let checked = false;
  return {
    exited,
    assertExited: () => {
      if (immediate && !checked) {
        checked = true;
        child.stdin.end("check\n");
      }
      return exited;
    },
  };
}
