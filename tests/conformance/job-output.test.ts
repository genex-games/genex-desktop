import assert from "node:assert/strict";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeJobLog, jobEnd, pipeJobOutput, type JobClock } from "../../src/substrate/job-process.ts";
import { JobService } from "../../src/substrate/jobs.ts";
import { JobRole, JobScopeKind, JobState, JobStopper, type JobRecord } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CHUNK_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 5_000;

function streams(t: TestContext, highWaterMark = 16 * 1024) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  const chunks: Buffer[] = [];
  const callbacks: (() => void)[] = [];
  const errors: Error[] = [];
  const log = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  log.on("error", (error) => errors.push(error));
  t.after(() => {
    stdout.destroy();
    stderr.destroy();
    log.destroy();
  });
  return {
    child,
    stdout,
    stderr,
    log,
    errors,
    text: () => Buffer.concat(chunks).toString(),
    flush: () => {
      while (callbacks.length) callbacks.shift()?.();
    },
  };
}

it("a slow job log pauses both output pipes instead of buffering the entire log cap", (t) => {
  const s = streams(t);
  pipeJobOutput(s.child, s.log, 64 * CHUNK_BYTES, () => {});
  for (let at = 0; at < 8; at++) s.stdout.write(Buffer.alloc(CHUNK_BYTES, 97));
  assert.ok(s.log.writableLength <= CHUNK_BYTES, `queued ${s.log.writableLength} bytes for one blocked write`);
  assert.equal(s.stdout.isPaused(), true);
  assert.equal(s.stderr.isPaused(), true);
});

it("resumes both pipes on drain and preserves output before a normal log close", async (t) => {
  const s = streams(t, 1);
  let written = 0;
  pipeJobOutput(s.child, s.log, CHUNK_BYTES, (bytes) => {
    written = bytes;
  });
  s.stdout.write("out");
  s.stderr.write("err");
  assert.equal(s.stdout.isPaused(), true);
  s.flush();
  await setImmediate();
  s.flush();
  await setImmediate();
  assert.equal(s.stdout.isPaused(), false);
  assert.equal(s.stderr.isPaused(), false);
  assert.equal(written, 6);
  assert.equal(s.text(), "outerr");
  await closeJobLog(s.log);
  assert.deepEqual(s.errors, []);
});

it("keeps draining after the size cap and writes its notice only once", async (t) => {
  const s = streams(t, 1);
  const updates: [number, boolean][] = [];
  pipeJobOutput(s.child, s.log, 4, (bytes, capped) => updates.push([bytes, capped]));
  s.stdout.write("output beyond cap");
  s.stderr.write("ignored stderr");
  s.stdout.write("ignored stdout");
  assert.equal(s.stdout.isPaused(), false);
  assert.equal(s.stderr.isPaused(), false);
  s.flush();
  await closeJobLog(s.log);
  assert.equal(s.text().startsWith("outp\n[Genex:"), true);
  assert.equal(s.text().split("size cap").length, 2);
  assert.deepEqual(updates, [[4, true]]);
  assert.deepEqual(s.errors, []);
});

it("closing a backpressured log releases the pipes and removes its drain listener", async (t) => {
  const s = streams(t, 1);
  pipeJobOutput(s.child, s.log, CHUNK_BYTES, () => {});
  s.stdout.write("out");
  s.stderr.write("buffered stderr");
  const closing = closeJobLog(s.log);
  s.flush();
  await closing;
  await setImmediate();
  assert.equal(s.stdout.isPaused(), false);
  assert.equal(s.stderr.isPaused(), false);
  assert.equal(s.log.listenerCount("drain"), 0);
  assert.deepEqual(s.errors, []);
});

it("an errored writer releases paused pipes without attempting further writes", async (t) => {
  const s = streams(t, 1);
  const report = t.mock.method(console, "error", () => {});
  pipeJobOutput(s.child, s.log, CHUNK_BYTES, () => {});
  s.stdout.write("out");
  const closed = once(s.log, "close").catch(() => {});
  s.log.destroy(new Error("synthetic disk failure"));
  await closed;
  await setImmediate();
  s.stderr.write("after failure");
  assert.equal(s.stderr.isPaused(), false);
  assert.equal(s.log.listenerCount("drain"), 0);
  assert.equal(s.text(), "out");
  assert.equal(s.errors.length, 1);
  assert.equal(report.mock.callCount(), 1);
});

it("a capped log never extends the deadline of an orphan that keeps its output open", async (t) => {
  const s = streams(t, 1);
  let expire = () => {};
  const clock: JobClock = {
    now: () => 0,
    setTimeout(fn) {
      expire = fn;
      return fn;
    },
    clearTimeout() {},
  };
  const draining = pipeJobOutput(s.child, s.log, 4, () => {});
  const ending = jobEnd(s.child, () => {}, clock, 1, draining).then(() => closeJobLog(s.log));
  s.stdout.write("past the cap");
  s.child.emit("exit", 0, null);
  expire();
  await setImmediate();
  assert.equal(s.log.writableEnded, true);
  s.flush();
  await ending;
});

it("the job service preserves both real output streams and finishes after the log is flushed", async (t) => {
  const root = await tmpDir();
  const bytes = 256 * 1024;
  let ended = (_record: JobRecord) => {};
  const ending = new Promise<JobRecord>((resolve) => {
    ended = resolve;
  });
  const service = new JobService({
    root,
    spawn: async () => ({
      child: spawn(
        process.execPath,
        ["-e", `process.stdout.write('o'.repeat(${bytes}));process.stderr.write('e'.repeat(${bytes}));`],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      ),
      sandboxed: true,
    }),
    onEnded: ended,
  });
  t.after(async () => {
    await service.stopAll(JobStopper.Quit);
  });
  await service.start({
    owner: {
      project: "fixture",
      chatThreadId: "fixture-thread",
      role: JobRole.Chat,
      scope: { kind: JobScopeKind.Chat },
    },
    title: "Output fixture",
    command: "fixture",
    cwd: root,
    policy: {},
    mode: PermissionMode.Manual,
  });
  const result = await ending;
  assert.equal(result.state, JobState.Succeeded);
  const text = await readFile(result.logFile, "utf8");
  assert.equal(text.length, 2 * bytes);
  assert.equal(text.replaceAll("o", "").length, bytes);
  assert.equal(text.replaceAll("e", "").length, bytes);
  assert.equal(result.logBytes, 2 * bytes);
});

it("the production log pipe owns disk errors without a process-level uncaught event", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/job-log-error.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [fixture], { timeout: CHILD_TIMEOUT_MS, windowsHide: true });
});

it("the orphan-pipe deadline does not discard output waiting for a slow log writer", async (t) => {
  const s = streams(t, 1);
  const pending = new Set<() => void>();
  const clock: JobClock = {
    now: () => 0,
    setTimeout(fn) {
      pending.add(fn);
      return fn;
    },
    clearTimeout(handle) {
      pending.delete(handle as () => void);
    },
  };
  const draining = pipeJobOutput(s.child, s.log, CHUNK_BYTES, () => {});
  const ending = jobEnd(s.child, () => {}, clock, 1, draining).then(() => closeJobLog(s.log));
  s.stdout.write("first");
  s.stderr.write("buffered tail");
  s.child.emit("exit", 0, null);
  for (const timer of [...pending]) {
    pending.delete(timer);
    timer();
  }
  await setImmediate();
  assert.equal(s.log.writableEnded, false, "the writer must drain before ending its log");
  s.flush();
  await setImmediate();
  s.flush();
  await setImmediate();
  s.child.emit("close", 0, null);
  await ending;
  assert.equal(s.text(), "firstbuffered tail");
});
