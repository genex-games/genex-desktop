/**
 * check-part's compiles of a part's C++, one job per builder's copy: a compile takes 45-90 s and a
 * plugin tool call ends near 190 s, so check-part waits a while, then answers "still compiling"
 * while the compile keeps running for the next call. A finished result for the same C++ is reused;
 * changed C++ stops the copy's running compile and starts after it; one copy's result is never
 * another's; a result that says nothing about the code (stopped, timed out) is not kept.
 */
import assert from "node:assert/strict";
import { lstat, lutimes, mkdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CHECK_ANSWER_BY_MS,
  CHECK_COMPILE_WAIT_MS,
  type CppInput,
  compileWaitMs,
  cppFingerprint,
  createCompileJobs,
  freshenSources,
  UBT_TIME_GRAIN_MS,
} from "../../src/plugins/unreal/part-compile.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { CompileFailure, type CompileResult } from "../../src/plugins/unreal/ubt.ts";
import { tmpDir } from "../helpers/tmp.ts";

const OK: CompileResult = { ok: true, seconds: 12, errors: [], summary: "built", retryable: false };
const BROKEN: CompileResult = {
  ok: false,
  seconds: 8,
  errors: [{ file: "Source/Rush/Parts/Bike/Bike.cpp", line: 3, column: 1, message: "use of undeclared identifier" }],
  summary: "failed",
  failure: CompileFailure.Failed,
  retryable: false,
};

/** A compile the test finishes by hand, recording each start and its signal. */
function manual() {
  const starts: AbortSignal[] = [];
  const finishers: Array<(result: CompileResult) => void> = [];
  const start = (signal: AbortSignal) => {
    starts.push(signal);
    return new Promise<CompileResult>((resolve) => finishers.push(resolve));
  };
  return { start, starts, finish: (i: number, result: CompileResult) => finishers[i]?.(result) };
}

/** A wait that never ends, and one that already has. */
const never = () => new Promise<void>(() => {});
const elapsed = () => Promise.resolve();
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("check-part's compile jobs", () => {
  it("waits about 140 s, well inside a plugin tool call", () => {
    assert.ok(CHECK_COMPILE_WAIT_MS >= 120_000 && CHECK_COMPILE_WAIT_MS <= 150_000);
  });

  it("waits at most what the call has left, well inside the plugin call's 190 s", () => {
    assert.ok(CHECK_ANSWER_BY_MS > CHECK_COMPILE_WAIT_MS && CHECK_ANSWER_BY_MS <= 175 * SECOND_MS);
    const rows: Array<[number, number]> = [
      [0, CHECK_COMPILE_WAIT_MS],
      [10 * SECOND_MS, CHECK_COMPILE_WAIT_MS],
      [100 * SECOND_MS, CHECK_ANSWER_BY_MS - 100 * SECOND_MS],
      [CHECK_ANSWER_BY_MS, 0],
      [CHECK_ANSWER_BY_MS + 60 * SECOND_MS, 0],
      [-5 * SECOND_MS, CHECK_COMPILE_WAIT_MS],
    ];
    for (const [elapsed, wait] of rows) assert.equal(compileWaitMs(elapsed), wait, `${elapsed} ms in`);
  });

  it("stops the wait's timer once the compile answers first", async () => {
    const jobs = createCompileJobs();
    const signals: AbortSignal[] = [];
    const wait = (signal: AbortSignal) => {
      signals.push(signal);
      return never();
    };
    assert.deepEqual(await jobs.result("/copy/a/Rush.uproject", "h1", async () => OK, wait), OK);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
  });

  it("a wait that ends by being stopped is not an error", async () => {
    const jobs = createCompileJobs();
    const wait = (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    assert.deepEqual(await jobs.result("/copy/a/Rush.uproject", "h1", async () => OK, wait), OK);
    await settle();
  });

  it("answers with the result when the compile ends in time", async () => {
    const jobs = createCompileJobs();
    const result = await jobs.result("/copy/a/Rush.uproject", "h1", async () => OK, never);
    assert.deepEqual(result, OK);
  });

  it("answers undefined when the wait ends first, and the next call gets the running compile's result", async () => {
    const jobs = createCompileJobs();
    const compile = manual();
    assert.equal(await jobs.result("/copy/a/Rush.uproject", "h1", compile.start, elapsed), undefined);
    compile.finish(0, BROKEN);
    await settle();
    assert.deepEqual(await jobs.result("/copy/a/Rush.uproject", "h1", compile.start, elapsed), BROKEN);
    assert.equal(compile.starts.length, 1, "one compile for the same C++");
  });

  it("reuses a finished result for the same C++ without compiling again", async () => {
    const jobs = createCompileJobs();
    let runs = 0;
    const start = async () => {
      runs++;
      return BROKEN;
    };
    await jobs.result("/copy/a/Rush.uproject", "h1", start, never);
    assert.deepEqual(await jobs.result("/copy/a/Rush.uproject", "h1", start, never), BROKEN);
    assert.equal(runs, 1);
  });

  it("changed C++ stops the copy's running compile and starts only after it ended", async () => {
    const jobs = createCompileJobs();
    const compile = manual();
    assert.equal(await jobs.result("/copy/a/Rush.uproject", "h1", compile.start, elapsed), undefined);
    const second = jobs.result("/copy/a/Rush.uproject", "h2", compile.start, never);
    await settle();
    assert.equal(compile.starts[0]?.aborted, true, "the old compile was told to stop");
    assert.equal(compile.starts.length, 1, "the new one waits for the old one to end");
    compile.finish(0, { ...OK, ok: false, failure: CompileFailure.Aborted, summary: "stopped" });
    await settle();
    assert.equal(compile.starts.length, 2);
    compile.finish(1, OK);
    assert.deepEqual(await second, OK);
  });

  it("never answers one copy with another copy's result", async () => {
    const jobs = createCompileJobs();
    const a = await jobs.result("/copy/a/Rush.uproject", "same", async () => BROKEN, never);
    const b = await jobs.result("/copy/b/Rush.uproject", "same", async () => OK, never);
    assert.deepEqual(a, BROKEN);
    assert.deepEqual(b, OK);
  });

  it("compiles again after a result that says nothing about the code", async () => {
    const rows: CompileFailure[] = [
      CompileFailure.Aborted,
      CompileFailure.TimedOut,
      CompileFailure.Conflicting,
      CompileFailure.NotStarted,
    ];
    for (const failure of rows) {
      const jobs = createCompileJobs();
      let runs = 0;
      const start = async (): Promise<CompileResult> => {
        runs++;
        return { ok: false, seconds: 0, errors: [], summary: failure, failure, retryable: false };
      };
      assert.equal((await jobs.result("/copy/a/Rush.uproject", "h", start, never))?.failure, failure);
      await jobs.result("/copy/a/Rush.uproject", "h", start, never);
      assert.equal(runs, 2, failure);
    }
  });

  it("tells each compile when the copy's previous one ended, and only that copy's", async () => {
    let clock = 1_000;
    const jobs = createCompileJobs(() => clock);
    const seen: Array<number | undefined> = [];
    const start = async (_signal: AbortSignal, previousEnd: number | undefined) => {
      seen.push(previousEnd);
      clock += 5_000;
      return BROKEN;
    };
    await jobs.result("/copy/a/Rush.uproject", "h1", start, never);
    await jobs.result("/copy/a/Rush.uproject", "h2", start, never);
    await jobs.result("/copy/b/Rush.uproject", "h1", start, never);
    assert.deepEqual(seen, [undefined, 6_000, undefined]);
  });

  it("a compile that throws is a failed result, not a crash", async () => {
    const jobs = createCompileJobs();
    const result = await jobs.result(
      "/copy/a/Rush.uproject",
      "h",
      async () => {
        throw new Error("spawn failed");
      },
      never,
    );
    assert.equal(result?.ok, false);
    assert.equal(result?.failure, CompileFailure.NotStarted);
  });
});

describe("a part's C++ fingerprint", () => {
  const input: CppInput = {
    part: "Bike",
    files: { "Bike.h": "a", "Private/Bike.cpp": "b" },
    buildRules: "rules",
    engineDir: "/Users/Shared/Epic Games/UE_5.8",
    tree: "Source: Rush/Rush.h 12 1000",
  };
  it("changes with the part's C++, the module's rules, the engine or anything else the copy builds", () => {
    const base = cppFingerprint(input);
    assert.equal(cppFingerprint({ ...input, files: { "Private/Bike.cpp": "b", "Bike.h": "a" } }), base, "order");
    const rows: Array<[string, Partial<CppInput>]> = [
      ["a file's text", { files: { ...input.files, "Bike.h": "a2" } }],
      ["a file's path", { files: { "Bike2.h": "a", "Private/Bike.cpp": "b" } }],
      ["text moved between files", { files: { "Bike.h": "aPrivate/Bike.cpp" } }],
      ["the module's rules", { buildRules: "rules2" }],
      ["the part", { part: "Lap" }],
      ["the engine", { engineDir: "/Users/Shared/Epic Games/UE_5.9" }],
      ["another part landed in the copy, or its project changed", { tree: "Source: Rush/Rush.h 12 2000" }],
    ];
    for (const [label, change] of rows) assert.notEqual(cppFingerprint({ ...input, ...change }), base, label);
  });
});

describe("a part's sources written just after the copy's last build", () => {
  // UnrealBuildTool can miss a source written within about a second after its last build ended,
  // and report the target up to date.
  async function sources() {
    const dir = await realpath(await tmpDir("studio-part-freshen-"));
    const files = ["Bike.h", "Bike.cpp"].map((name) => path.join(dir, name));
    for (const file of files) await writeFile(file, "// c++\n");
    return { dir, files };
  }
  const at = async (file: string, ms: number) => utimes(file, new Date(ms), new Date(ms));
  const writtenAt = async (file: string) => (await lstat(file)).mtimeMs;

  it("moves a file written within the grain after the last build past it, once the grain has passed", async () => {
    const { files } = await sources();
    const [header = "", source = ""] = files;
    const previousEnd = 1_700_000_000_000;
    await at(header, previousEnd + 200);
    await at(source, previousEnd + 60_000);
    let now = previousEnd + 300;
    const waits: number[] = [];
    await freshenSources(files, previousEnd, {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    assert.deepEqual(waits, [UBT_TIME_GRAIN_MS - 300]);
    assert.ok((await writtenAt(header)) >= previousEnd + UBT_TIME_GRAIN_MS, "the quick edit is now newer");
    assert.equal(await writtenAt(source), previousEnd + 60_000, "a file written later is left alone");
  });

  it("leaves everything alone without a build before it, and waits for nothing past the grain", async () => {
    const { files } = await sources();
    const [header = ""] = files;
    await at(header, 5_000);
    const waits: number[] = [];
    const clock = { now: () => 100_000, sleep: async (ms: number) => void waits.push(ms) };
    await freshenSources(files, undefined, clock);
    assert.equal(await writtenAt(header), 5_000);
    await freshenSources(files, 4_000, clock);
    assert.deepEqual(waits, [], "the grain had passed");
    assert.ok((await writtenAt(header)) >= 6_000);
  });

  it("never follows a link a builder swapped in, and skips a file that is gone", async () => {
    const { dir, files } = await sources();
    const [header = "", source = ""] = files;
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    const target = path.join(outside, "secret.txt");
    await writeFile(target, "outside the part");
    await at(target, 1_000);
    await rm(header);
    await symlink(target, header);
    // The link itself looks written just after the build, so it is the one to move.
    await lutimes(header, new Date(1_000), new Date(1_000));
    await rm(source);
    await freshenSources(files, 900, { now: () => 10_000, sleep: async () => {} });
    assert.equal((await stat(target)).mtimeMs, 1_000, "the link's target is untouched");
    assert.ok((await lstat(header)).mtimeMs >= 10_000, "the link itself was moved");
  });
});
