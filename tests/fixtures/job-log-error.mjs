import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { pipeJobOutput } from "../../src/substrate/job-process.ts";

const child = new ChildProcess();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
const log = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { callback(new Error("synthetic disk error")); } });
const closed = new Promise((resolve) => log.once("close", resolve));
pipeJobOutput(child, log, 1024, () => {});
child.stdout.write("output");
await closed;
assert.equal(child.stdout.isPaused(), false);
assert.equal(child.stderr.isPaused(), false);
child.stdout.destroy();
child.stderr.destroy();
