import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  NativeCleanupError,
  superviseNativeJob,
  type NativeProcessRequest,
  type NativeProcessResult,
} from "../../src/substrate/plugins/native-process.ts";

function worker(kill: () => Promise<void>) {
  const child = Object.assign(new ChildProcess(), {
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const controller = new AbortController();
  const request: NativeProcessRequest = {
    binary: "/worker",
    args: [],
    cwd: "/job",
    scratch: "/job",
    reads: [],
    writes: [],
    denyRead: [],
    signal: controller.signal,
    timeoutMs: 300000,
    maxOutputBytes: 1000,
  };
  const result = new Promise<NativeProcessResult>((resolve, reject) =>
    superviseNativeJob(child, request, resolve, reject, kill),
  );
  return { child, result, controller };
}

test("a worker exiting at 297.5 seconds succeeds when clean cleanup crosses its compute deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let cleaned = () => {};
  const cleanup = new Promise<void>((resolve) => {
    cleaned = resolve;
  });
  const f = worker(() => cleanup);
  t.mock.timers.tick(297500);
  f.child.emit("exit", 0, null);
  t.mock.timers.tick(4000);
  cleaned();
  const result = await f.result;
  assert.equal(result.reason, "exit");
  assert.equal(result.code, 0);
});

test("cleanup has a short independent budget and cannot report success when it hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = worker(() => new Promise(() => {}));
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  t.mock.timers.tick(10000);
  await assert.rejects(f.result, NativeCleanupError);
});

test("exiting just before the compute ceiling stops that clock before pipes drain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = worker(async () => {});
  t.mock.timers.tick(299500);
  f.child.emit("exit", 0, null);
  t.mock.timers.tick(2000);
  assert.equal((await f.result).reason, "exit");
});

test("deadline kills immediately and cancellation cannot overwrite a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let kills = 0;
  const f = worker(async () => {
    kills++;
  });
  t.mock.timers.tick(300000);
  assert.equal(kills, 1);
  f.controller.abort();
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  assert.equal((await f.result).reason, "timeout");
});

test("cancellation after worker exit leaves successful compute and cleanup intact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = worker(async () => {});
  f.child.emit("exit", 0, null);
  f.controller.abort();
  f.child.emit("close", 0, null);
  assert.equal((await f.result).reason, "exit");
});
