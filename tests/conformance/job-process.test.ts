/**
 * A job's start time as this machine's own tool reads it (`ps`, Windows PowerShell): the same
 * reading for the same process every time, and none for a process that does not run, so a later
 * app start ends a left job only when it is the same process.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { psProbe, startTimeCommand } from "../../src/substrate/job-process.ts";

/** A process id no process holds on any platform the app runs on. */
const NO_SUCH_PID = 2_147_483_000;

it("reads a running process's start time the same way each time, and none for a gone process", async () => {
  const probe = psProbe();
  const first = await probe.startTime(process.pid);
  assert.ok(first, "the test's own process has a start time");
  assert.equal(await probe.startTime(process.pid), first);
  assert.equal(await probe.startTime(NO_SUCH_PID), null);
});

it("asks Windows PowerShell by its full path, with the process id as a number only", () => {
  const command = startTimeCommand(4321, "win32", { SystemRoot: "D:\\Windows" });
  assert.equal(command.file, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(command.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(command.args[3] ?? "", /^\(Get-Process -Id 4321 -ErrorAction Stop\)\.StartTime/);
  assert.deepEqual(startTimeCommand(4321, "darwin"), { file: "/bin/ps", args: ["-o", "lstart=", "-p", "4321"] });
});
