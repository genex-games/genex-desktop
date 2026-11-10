/**
 * Apps Genex builds on its own computers (`genex native build`): only a CLI new enough asks, the
 * project is staged and removed once sent, a build's job is followed until it ends, and anything off
 * in an answer, a job id above all, is dropped before it reaches the record or the CLI's arguments.
 * A build Genex keeps (`--hold`) reaches players only when a publish asks (`build-release`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate as turn, setTimeout as wait } from "node:timers/promises";
import {
  beginCloudSend,
  buildReleaseArgs,
  buildStatusArgs,
  CLOUD_BUILD_FILE,
  CLOUD_SOURCE_FOLDER,
  type CloudBuildDeps,
  cloudBuildArgs,
  cloudBuildOf,
  hasCloudBuildCommand,
  isKeptApp,
  isRunning,
  latestOf,
  newestHeld,
  pollDelayMs,
  readCloudBuilds,
  readCloudSend,
  refreshCloudBuild,
  releaseCloudBuild,
  startCloudBuild,
  watchCloudBuild,
  withBuild,
} from "../../src/plugins/genex/cloud-build.ts";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { CloudBuildFailure, CloudBuildState, CloudSendState, type GenexCloudBuild } from "../../src/shared/genex.ts";
import { type GenexFixtureApi, type GenexHandler, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const STARTED = "2026-10-23T10:00:00.000Z";
const BUILD = { platform: "windows", jobId: "job_1", state: CloudBuildState.Queued, startedAt: STARTED };
/** A build Genex made and keeps for a publish. */
const KEPT = { ...BUILD, state: CloudBuildState.Built, held: true, installedBytes: 2048, finishedAt: STARTED };

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8").catch(() => "null"));

/** Deps whose CLI answers `answers` in turn (an Error is thrown), every call and wait recorded. */
function fakeDeps(answers: unknown[]) {
  const calls: string[][] = [];
  const waits: number[] = [];
  const staged: string[] = [];
  const deps: CloudBuildDeps & { read: (file: string) => Promise<unknown> } = {
    cli: async (args) => {
      calls.push(args);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    stage: async (_gameDir, dest) => {
      staged.push(dest);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "Game.uproject"), "{}");
      return { files: 1, bytes: 2 };
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    read: readJson,
  };
  return { deps, calls, waits, staged };
}

/** `fakeDeps` that count their reads of the record. */
function countingReader(answers: unknown[]) {
  const { deps } = fakeDeps(answers);
  let reads = 0;
  deps.read = (file) => {
    reads += 1;
    return readJson(file);
  };
  return { deps, reads: () => reads };
}

/**
 * `fakeDeps` whose first read of the record has it in hand (`inHand`) and gives it only after
 * `letGo`: an answer on its way into the record while another one arrives.
 */
function heldReader(answers: unknown[]) {
  const { deps } = fakeDeps(answers);
  let reached = () => {};
  let letGo = () => {};
  const inHand = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let first = true;
  deps.read = async (file) => {
    const value = await readJson(file);
    if (!first) return value;
    first = false;
    reached();
    await held;
    return value;
  };
  return { deps, inHand, letGo: () => letGo() };
}

describe("asking Genex to build an app", () => {
  it("is asked only by a CLI that can keep a build for a publish (`genex native build --hold`)", () => {
    for (const version of ["1.41.0", "1.41.1", "1.42.0-dev.1", "2.0.0"])
      assert.equal(hasCloudBuildCommand(version), true, version);
    for (const version of ["1.40.9", "1.41.0-dev.4", "1.38.0", "", "latest", "1.41"])
      assert.equal(hasCloudBuildCommand(version), false, version);
  });

  it("names the platform and the staged project, and a job by its id", () => {
    const build = ["native", "build", "--platform", "windows", "--source", "/w/cloud-source"];
    assert.deepEqual(cloudBuildArgs("windows", "/w/cloud-source"), build);
    assert.deepEqual(cloudBuildArgs("windows", "/w/cloud-source", true), [...build, "--hold"], "kept for a publish");
    assert.deepEqual(buildStatusArgs("job_1"), ["native", "build-status", "job_1"]);
    assert.deepEqual(buildReleaseArgs("job_1"), ["native", "build-release", "job_1"]);
    assert.deepEqual(
      buildReleaseArgs("job_1", { title: "Seyda Neen" }),
      ["native", "build-release", "job_1", "--gallery", "--title", "Seyda Neen"],
      "a game's first app lists it",
    );
  });

  it("reads a build Genex keeps, its size, and never a failed or live one as kept", () => {
    assert.deepEqual(cloudBuildOf({ build: KEPT }), KEPT);
    assert.deepEqual(cloudBuildOf({ build: { ...BUILD, held: true } }), { ...BUILD, held: true }, "kept once built");
    const done = { ...BUILD, state: CloudBuildState.Done };
    assert.deepEqual(cloudBuildOf({ build: { ...done, held: true, installedBytes: 2048 } }), {
      ...done,
      installedBytes: 2048,
    });
    const failed = { ...BUILD, state: CloudBuildState.Failed, failure: CloudBuildFailure.Expired };
    assert.deepEqual(cloudBuildOf({ build: { ...failed, held: true, installedBytes: 2048 } }), failed);
    for (const installedBytes of ["big", -1, 0, 1.5, Number.MAX_VALUE])
      assert.equal(
        cloudBuildOf({ build: { ...KEPT, installedBytes } })?.installedBytes,
        undefined,
        String(installedBytes),
      );
    assert.equal(isRunning(KEPT), false, "a kept build rests until a publish asks for it");
  });

  it("gives a publish the newest build Genex keeps for a system", () => {
    const older = { ...KEPT, jobId: "job_old", startedAt: "2026-10-22T10:00:00.000Z" };
    const live = { ...BUILD, jobId: "job_live", state: CloudBuildState.Done, startedAt: "2026-10-24T10:00:00.000Z" };
    assert.equal(newestHeld([KEPT, older, live], "windows")?.jobId, "job_1", "by when it started, wherever it is kept");
    assert.equal(newestHeld([older, live], "windows")?.jobId, "job_old");
    assert.equal(newestHeld([live], "windows"), undefined, "a live build is not kept");
    assert.equal(newestHeld([KEPT], "mac"), undefined);
  });

  it("never takes a build back a step when two answers cross", () => {
    const released = { ...BUILD, state: CloudBuildState.Done };
    assert.deepEqual(latestOf(released, KEPT), released, "a status read from before the release");
    assert.deepEqual(latestOf(KEPT, released), released);
    const going = { ...BUILD, state: CloudBuildState.Building };
    assert.deepEqual(latestOf(going, { ...going, held: true }), going, "once a publish asked, never kept back again");
    assert.deepEqual(latestOf(undefined, KEPT), KEPT);
    assert.deepEqual(withBuild([released], KEPT), [released]);
  });

  it("keeps a build Genex answers only when all of it is whole, and a failure only on a failed one", () => {
    assert.deepEqual(cloudBuildOf({ build: BUILD }), BUILD);
    assert.deepEqual(
      cloudBuildOf({ build: { ...BUILD, failure: CloudBuildFailure.Cook } }),
      BUILD,
      "only a failed build has a reason",
    );
    assert.deepEqual(
      cloudBuildOf({ build: { ...BUILD, state: CloudBuildState.Failed, failure: "disk-on-fire" } }),
      { ...BUILD, state: CloudBuildState.Failed, failure: CloudBuildFailure.Failed },
      "a reason Studio doesn't know reads as a plain failure",
    );
    const failedBuild = { ...BUILD, state: CloudBuildState.Failed, failure: CloudBuildFailure.Compile };
    assert.deepEqual(
      cloudBuildOf({ build: { ...failedBuild, errors: ["Focus.cpp(79,19): error C2065", 7, "", null] } })?.errors,
      ["Focus.cpp(79,19): error C2065"],
      "only lines of text are kept",
    );
    assert.equal(cloudBuildOf({ build: { ...BUILD, errors: ["not failed"] } })?.errors, undefined);
    assert.equal(cloudBuildOf({ build: { ...failedBuild, errors: "one string" } })?.errors, undefined);
    const flood = cloudBuildOf({ build: { ...failedBuild, errors: Array(500).fill("x".repeat(5000)) } })?.errors ?? [];
    assert.deepEqual([flood.length, flood[0]?.length], [60, 300], "what Genex sends is held to what it says it sends");
    const hostile: Array<[string, unknown]> = [
      ["no build", {}],
      ["not a record", { build: "windows" }],
      ["a system Genex doesn't build", { build: { ...BUILD, platform: "mac" } }],
      ["a job id that reads as an option", { build: { ...BUILD, jobId: "--source=/etc" } }],
      ["a job id with a path", { build: { ...BUILD, jobId: "../../escape" } }],
      ["a job id with a space", { build: { ...BUILD, jobId: "job 1" } }],
      ["a job id too long", { build: { ...BUILD, jobId: "j".repeat(129) } }],
      ["a state Studio doesn't know", { build: { ...BUILD, state: "exploded" } }],
      ["no start time", { build: { ...BUILD, startedAt: "yesterday" } }],
    ];
    for (const [why, answer] of hostile) assert.equal(cloudBuildOf(answer), null, why);
    assert.deepEqual(readCloudBuilds({ builds: [BUILD, { ...BUILD, jobId: "-x" }, null] }), [BUILD]);
    assert.deepEqual(readCloudBuilds("garbage"), []);
  });

  it("keeps the newest few builds, a job's later answer in place of its earlier one", () => {
    const done = { ...BUILD, state: CloudBuildState.Done };
    assert.deepEqual(withBuild([BUILD], done), [done]);
    const many: GenexCloudBuild[] = Array.from({ length: 10 }, (_, at) => ({ ...BUILD, jobId: `job_${at}` }));
    const kept = many.reduce<GenexCloudBuild[]>((builds, build) => withBuild(builds, build), []);
    assert.deepEqual(
      kept.map((build) => build.jobId),
      ["job_2", "job_3", "job_4", "job_5", "job_6", "job_7", "job_8", "job_9"],
    );
    assert.equal(isRunning(BUILD), true);
    assert.equal(isRunning(done), false);
    assert.deepEqual([0, 1, 2, 3, 9].map(pollDelayMs), [15_000, 30_000, 60_000, 120_000, 120_000]);
  });
});

describe("a build on Genex in the publish workspace", () => {
  it("sends the staged project, keeps the build Genex started and removes the copy", async () => {
    const dir = await tmpDir("cloud-build");
    const { deps, calls, staged } = fakeDeps([{ build: BUILD }]);
    const build = await startCloudBuild(dir, "windows", "/games/seyda", deps, new AbortController().signal);
    assert.deepEqual(build, BUILD);
    assert.deepEqual(staged, [path.join(dir, CLOUD_SOURCE_FOLDER)]);
    assert.deepEqual(calls, [cloudBuildArgs("windows", path.join(dir, CLOUD_SOURCE_FOLDER))]);
    assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [BUILD] });
    assert.deepEqual(await readdir(dir), [CLOUD_BUILD_FILE], "the staged project is gone once sent");
  });

  it("refuses a system Genex doesn't build, and keeps nothing of a refused build", async () => {
    const dir = await tmpDir("cloud-build");
    const signal = new AbortController().signal;
    const refused = fakeDeps([]);
    await assert.rejects(startCloudBuild(dir, "mac", "/games/seyda", refused.deps, signal), /no app for that system/);
    await assert.rejects(startCloudBuild(dir, "../windows", "/games/seyda", refused.deps, signal));
    assert.deepEqual([refused.calls, refused.staged], [[], []], "nothing staged, nothing asked");
    const cli = fakeDeps([new Error("✗ This game has no page on Genex")]);
    await assert.rejects(startCloudBuild(dir, "windows", "/games/seyda", cli.deps, signal), /no page on Genex/);
    const odd = fakeDeps([{ build: { ...BUILD, platform: "linux" } }]);
    await assert.rejects(startCloudBuild(dir, "windows", "/games/seyda", odd.deps, signal), /without the build/);
    assert.deepEqual(await readdir(dir), [], "no record and no staged copy left behind");
  });

  it("follows a build until it ends, through a read that fails and an answer for another job", async () => {
    const dir = await tmpDir("cloud-build");
    await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [BUILD] }));
    const finished = { ...BUILD, state: CloudBuildState.Done, finishedAt: "2026-10-23T10:20:00.000Z" };
    const { deps, calls, waits } = fakeDeps([
      new Error("network"),
      { build: { ...BUILD, jobId: "job_other", state: CloudBuildState.Done } },
      { build: { ...BUILD, state: CloudBuildState.Building } },
      { build: finished },
      { build: BUILD },
    ]);
    await watchCloudBuild(dir, "job_1", deps, new AbortController().signal);
    assert.equal(calls.length, 4, "it stops at the build's end");
    assert.deepEqual(waits, [15_000, 30_000, 60_000, 120_000]);
    assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [finished] });
  });

  it("keeps a send on its way while an older build's status is written", async () => {
    const dir = await tmpDir("cloud-build");
    const send = { platform: "windows", startedAt: STARTED, state: CloudSendState.Sending };
    await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [BUILD], send }));
    const finished = { ...BUILD, state: CloudBuildState.Done };
    await watchCloudBuild(dir, "job_1", fakeDeps([{ build: finished }]).deps, new AbortController().signal);
    assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [finished], send });
  });

  it("keeps a release's answer when a status read of the same build is still on its way into the record", async () => {
    // The incident: a publish gave players a kept build while its status read was being written. Each
    // read the record, then wrote it back; the status wrote last, from what it read first, and the
    // record said "built, kept" of an app players already had.
    const dir = await tmpDir("cloud-build");
    const file = path.join(dir, CLOUD_BUILD_FILE);
    await writeFile(file, JSON.stringify({ builds: [{ ...BUILD, held: true }] }));
    const signal = new AbortController().signal;
    const status = heldReader([{ build: KEPT }]);
    const read = refreshCloudBuild(dir, "job_1", status.deps, signal);
    await status.inHand;
    const live = { ...BUILD, state: CloudBuildState.Done, finishedAt: STARTED, installedBytes: 2048 };
    const release = countingReader([{ build: live }]);
    const released = releaseCloudBuild(dir, "job_1", release.deps, signal);
    await turn();
    assert.equal(release.reads(), 0, "the release waits for the status read to write the record back");
    status.letGo();
    await Promise.all([read, released]);
    assert.deepEqual(await readJson(file), { builds: [live] }, "players have it, and the record says so");
  });

  it("keeps a send that starts while a status read is still on its way into the record", async () => {
    // The incident: Build was pressed while a kept app's status was being written. The status read
    // the record before the send was in it and wrote it back after: the send was gone from the record
    // while the project was still going up.
    const dir = await tmpDir("cloud-build");
    const file = path.join(dir, CLOUD_BUILD_FILE);
    await writeFile(file, JSON.stringify({ builds: [KEPT] }));
    const status = heldReader([{ build: KEPT }]);
    const read = refreshCloudBuild(dir, "job_1", status.deps, new AbortController().signal);
    await status.inHand;
    const press = countingReader([]);
    const begun = beginCloudSend(dir, "windows", press.deps.read, true, new Date(STARTED));
    await turn();
    assert.equal(press.reads(), 0, "the send waits for the status read to write the record back");
    status.letGo();
    const [, send] = await Promise.all([read, begun]);
    assert.deepEqual(await readJson(file), { builds: [KEPT], send }, "the build and the send are both there");
  });

  it("keeps a send only when all of it is whole", () => {
    const send = { platform: "windows", startedAt: STARTED, state: CloudSendState.Failed, error: "no" };
    assert.deepEqual(readCloudSend({ send }), send);
    const hostile: unknown[] = [
      {},
      { send: "windows" },
      { send: { ...send, platform: "mac" } },
      { send: { ...send, state: "exploded" } },
      { send: { ...send, startedAt: "yesterday" } },
    ];
    for (const value of hostile) assert.equal(readCloudSend(value), null);
    const { error: _words, ...wordless } = send;
    assert.deepEqual(readCloudSend({ send: { ...send, error: 7 } }), wordless, "words that aren't words are dropped");
  });

  it("gives players a kept build, keeps Genex's answer, and hands back how listing the game went", async () => {
    const dir = await tmpDir("cloud-build");
    await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [KEPT] }));
    const live = { ...BUILD, state: CloudBuildState.Done, finishedAt: STARTED, installedBytes: 2048 };
    const listing = { state: "published", slug: "seyda-neen" };
    const { deps, calls } = fakeDeps([{ build: live, listing }, { build: live }]);
    const signal = new AbortController().signal;
    const first = await releaseCloudBuild(dir, "job_1", deps, signal, { title: "Seyda Neen" });
    assert.deepEqual(first, { build: live, listing });
    assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [live] });
    assert.deepEqual(await releaseCloudBuild(dir, "job_1", deps, signal), { build: live }, "asked twice, same answer");
    assert.deepEqual(calls, [buildReleaseArgs("job_1", { title: "Seyda Neen" }), buildReleaseArgs("job_1")]);
  });

  it("releases nothing for a job id that isn't one, a refusal, or an answer about another build", async () => {
    const dir = await tmpDir("cloud-build");
    await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [KEPT] }));
    const signal = new AbortController().signal;
    const hostile = fakeDeps([]);
    for (const jobId of ["--gallery", "../job", "", "job 1"])
      await assert.rejects(releaseCloudBuild(dir, jobId, hostile.deps, signal), /without the build/, jobId);
    assert.deepEqual(hostile.calls, [], "the CLI is never run with it");
    const refused = fakeDeps([new Error("✗ Genex no longer keeps this build")]);
    await assert.rejects(releaseCloudBuild(dir, "job_1", refused.deps, signal), /no longer keeps/);
    const other = fakeDeps([{ build: { ...BUILD, jobId: "job_other", state: CloudBuildState.Done } }]);
    await assert.rejects(releaseCloudBuild(dir, "job_1", other.deps, signal), /without the build/);
    assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [KEPT] }, "the record is as it was");
  });

  it("says in the record that Genex no longer keeps a build it refuses to release, and fails in Genex's words", async () => {
    const signal = new AbortController().signal;
    const now = new Date("2026-11-20T09:00:00.000Z");
    const gone = { platform: "windows", jobId: "job_1", startedAt: STARTED, state: CloudBuildState.Failed };
    const ended = { ...gone, finishedAt: now.toISOString() };
    const refusal = (failure: unknown, message?: unknown) => ({
      error: "cloud_build_not_releasable",
      failure,
      message,
    });
    const cases: Array<[unknown, RegExp, CloudBuildFailure]> = [
      [
        refusal("expired", "Genex no longer keeps this build. Build the app again."),
        /: Genex no longer keeps this build\. Build the app again\.$/,
        CloudBuildFailure.Expired,
      ],
      [
        refusal("failed", "This build failed, so there is nothing of it to publish."),
        /This build failed/,
        CloudBuildFailure.Failed,
      ],
      [refusal("a code Studio never heard of"), /no longer keeps this build/, CloudBuildFailure.Failed],
      [refusal("expired", 7), /no longer keeps this build/, CloudBuildFailure.Expired],
    ];
    for (const [answer, words, failure] of cases) {
      const dir = await tmpDir("cloud-build");
      await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [KEPT] }));
      const { deps } = fakeDeps([answer]);
      await assert.rejects(releaseCloudBuild(dir, "job_1", deps, signal, undefined, now), words);
      assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [{ ...ended, failure }] });
    }
    // A build the record no longer calls kept ended already, or is followed to its own end: it stays as it is.
    const cooked = {
      ...gone,
      failure: CloudBuildFailure.Cook,
      errors: ["Content/Map.umap: missing"],
      finishedAt: STARTED,
    };
    for (const kept of [cooked, { ...BUILD, state: CloudBuildState.Building }]) {
      const dir = await tmpDir("cloud-build");
      await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [kept] }));
      const { deps } = fakeDeps([refusal("failed")]);
      await assert.rejects(releaseCloudBuild(dir, "job_1", deps, signal, undefined, now), /no longer keeps/);
      assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [kept] });
    }
  });

  it("fails a release Genex can't do right now in Genex's words, and the build stays kept", async () => {
    const signal = new AbortController().signal;
    const busy = "Genex could not read this build right now. Try again in a moment.";
    const cases: Array<[unknown, RegExp]> = [
      [{ error: "cloud_build_storage_unavailable", message: busy }, /: Genex could not read this build right now\./],
      [{ error: "cloud_build_busy", message: "This build is changing right now. Try again in a moment." }, /changing/],
      [{ error: "cloud_build_busy", message: 7 }, /without the build/],
      [{ error: "cloud_build_busy", message: "   " }, /without the build/],
    ];
    for (const [answer, words] of cases) {
      const dir = await tmpDir("cloud-build");
      await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [KEPT] }));
      const { deps } = fakeDeps([answer]);
      await assert.rejects(releaseCloudBuild(dir, "job_1", deps, signal), words);
      assert.deepEqual(await readJson(path.join(dir, CLOUD_BUILD_FILE)), { builds: [KEPT] });
    }
  });

  it("reads an app Genex keeps again once: what Genex says now is kept, and nothing when it can't be read", async () => {
    assert.deepEqual(
      [KEPT, BUILD, { ...KEPT, held: undefined }, { ...KEPT, state: CloudBuildState.Done }].map(isKeptApp),
      [true, false, false, false],
      "only a built app Genex still keeps rests until someone asks",
    );
    const dir = await tmpDir("cloud-build");
    const file = path.join(dir, CLOUD_BUILD_FILE);
    await writeFile(file, JSON.stringify({ builds: [KEPT] }));
    const signal = new AbortController().signal;
    const expired = {
      ...BUILD,
      state: CloudBuildState.Failed,
      failure: CloudBuildFailure.Expired,
      finishedAt: STARTED,
    };
    const { deps, calls, waits } = fakeDeps([
      new Error("offline"),
      { build: { ...KEPT, jobId: "job_other" } },
      { build: KEPT },
      { build: expired },
    ]);
    assert.equal(await refreshCloudBuild(dir, "job_1", deps, signal), false, "Genex could not be read");
    assert.equal(await refreshCloudBuild(dir, "job_1", deps, signal), false, "an answer about another build");
    assert.deepEqual(await readJson(file), { builds: [KEPT] });
    assert.equal(await refreshCloudBuild(dir, "job_1", deps, signal), true);
    assert.deepEqual(await readJson(file), { builds: [KEPT] }, "still kept");
    assert.equal(await refreshCloudBuild(dir, "job_1", deps, signal), true);
    assert.deepEqual(await readJson(file), { builds: [expired] }, "Genex no longer keeps it");
    assert.deepEqual(
      calls,
      Array.from({ length: 4 }, () => buildStatusArgs("job_1")),
    );
    assert.deepEqual(waits, [], "one read, no wait");
    for (const jobId of ["--help", "../job", "", "job 1"])
      assert.equal(await refreshCloudBuild(dir, jobId, deps, signal), false);
    assert.equal(calls.length, 4, "the CLI is never run with a job id that isn't one");
  });

  it("asks nothing for a job id that isn't one, and stops when told to", async () => {
    const dir = await tmpDir("cloud-build");
    const hostile = fakeDeps([]);
    for (const jobId of ["--help", "../job", "", "job 1"])
      await watchCloudBuild(dir, jobId, hostile.deps, new AbortController().signal);
    assert.deepEqual(hostile.calls, []);
    const stop = new AbortController();
    const stopped = fakeDeps([]);
    stopped.deps.sleep = async () => stop.abort();
    await watchCloudBuild(dir, "job_1", stopped.deps, stop.signal);
    assert.deepEqual(stopped.calls, []);
    assert.deepEqual(await readdir(dir), []);
  });
});

/**
 * A Genex plugin whose CLI is a stand-in, every run logged. It answers `native build` and
 * `build-status` (a build asked with `--hold` ends built and kept, until `build-release` gives it to
 * players), makes the game's hosted project for `init`, and takes a Mac app for `native publish`;
 * `--gallery` lists the game with either.
 */
async function toolsWithBuildCli(options: { buildsApps?: boolean; engine?: string; api?: string } = {}) {
  const root = await tmpDir("cloud-build-tools");
  const log = path.join(root, "runs.jsonl");
  /** While this file exists the send's upload hangs, as a big project's does; `fail` makes it end refused. */
  const hold = path.join(root, "hold-send");
  const fail = path.join(root, "fail-send");
  /** While this file exists Genex no longer keeps the build: a release is refused, and its status says expired. */
  const refuse = path.join(root, "refuse-release");
  /** While these files exist the game's project is still being made, an app is still going up, a release is still being answered. */
  const holdInit = path.join(root, "hold-init");
  const holdPublish = path.join(root, "hold-publish");
  const holdRelease = path.join(root, "hold-release");
  /** While this file exists Genex can't be read: `build-status` fails. */
  const failStatus = path.join(root, "fail-status");
  /** While this file exists the build is changing under a release: Genex says to ask again. */
  const busy = path.join(root, "busy-release");
  const kept = path.join(root, "kept-build");
  const standIn = path.join(root, "build-cli.mjs");
  await writeFile(
    standIn,
    `import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
const staged = source && existsSync(source) ? readdirSync(source).sort() : null;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), staged }) + "\\n");
const say = (answer) => {
  process.stdout.write(JSON.stringify(answer));
  process.exit(0);
};
const held = async (file) => {
  while (existsSync(file)) await new Promise((go) => setTimeout(go, 20));
};
if (args[0] === "init") {
  await held(${JSON.stringify(holdInit)});
  mkdirSync(".genex", { recursive: true });
  writeFileSync(".genex/project.json", JSON.stringify({ slug: "seyda-neen", id: "p1", status: "draft" }));
  process.exit(0);
}
if (args[0] === "cover") say({ coverUrl: null, coverSource: null });
if (args[1] === "build-status" && existsSync(${JSON.stringify(failStatus)})) {
  process.stderr.write("✗ Couldn't reach Genex.\\n");
  process.exit(1);
}
const listing = args.includes("--gallery") ? { listing: { state: "published", slug: "seyda-neen" } } : {};
const ended = "2026-10-23T10:21:00.000Z";
if (args[1] === "publish") {
  await held(${JSON.stringify(holdPublish)});
  const app = { platform: "mac", arch: "universal", version: "1.0+3f2a9c1d0e4b", sizeBytes: 10, publishedAt: ended };
  say({ build: { ...app, sha256: "3f".repeat(32) }, engine: "unreal", ...listing });
}
if (args[1] === "build") while (existsSync(${JSON.stringify(hold)})) await new Promise((go) => setTimeout(go, 20));
if (args[1] === "build" && existsSync(${JSON.stringify(fail)})) {
  process.stderr.write("Zipping the project\\nUpload failed (part 93/150).\\n");
  process.exit(1);
}
const build = { platform: "windows", jobId: "job_7", startedAt: "2026-10-23T10:00:00.000Z" };
const keeping = { ...build, state: "built", held: true, installedBytes: 2048, finishedAt: ended };
if (args[1] === "build") {
  const keep = args.includes("--hold");
  if (keep) writeFileSync(${JSON.stringify(kept)}, "");
  say({ build: { ...build, state: "queued", ...(keep ? { held: true } : {}) } });
}
if (args[1] === "build-release") {
  await held(${JSON.stringify(holdRelease)});
  if (existsSync(${JSON.stringify(busy)})) {
    process.stdout.write(JSON.stringify({ error: "cloud_build_busy", message: "The build changed. Try again." }));
    process.exit(1);
  }
  if (existsSync(${JSON.stringify(refuse)})) {
    const message = "Genex no longer keeps this build. Build the app again, then publish it.";
    process.stderr.write("✗ " + message + "\\n");
    process.stdout.write(JSON.stringify({ error: "cloud_build_not_releasable", failure: "expired", message }));
    process.exit(1);
  }
  rmSync(${JSON.stringify(kept)}, { force: true });
  say({ build: { ...build, state: "done", installedBytes: 2048, finishedAt: ended }, ...listing });
}
if (existsSync(${JSON.stringify(refuse)})) say({ build: { ...build, state: "failed", failure: "expired", finishedAt: ended } });
say({ build: existsSync(${JSON.stringify(kept)}) ? keeping : { ...build, state: "done", finishedAt: ended } });
`,
  );
  const make = () =>
    new GenexTools(path.join(root, "host"), options.api ?? "http://127.0.0.1:9", {
      credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
      preload: standIn,
      buildsApps: options.buildsApps ?? true,
      // A stand-in with `genex native build` has `genex native` too, whatever CLI the app pins.
      sendsApps: true,
      cloudSleep: async () => {},
    });
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; staged: string[] | null });
  const game = path.join(root, "seyda-neen");
  await mkdir(path.join(game, "unreal", "Content"), { recursive: true });
  await writeFile(
    path.join(game, "unreal", "SeydaNeen.uproject"),
    JSON.stringify({ EngineAssociation: options.engine ?? "5.8" }),
  );
  await writeFile(path.join(game, "unreal", "Content", "Map.umap"), "map");
  await writeFile(path.join(game, "index.html"), "<p>the game's page, no part of its app</p>");
  execFileSync("git", ["init", "-q"], { cwd: game });
  execFileSync("git", ["add", "."], { cwd: game });
  const onGenex = async () => {
    const dir = path.join(root, "host", "publish", "seyda");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "publish.json"),
      JSON.stringify({ version: 1, project: "seyda", connected: true, slug: "seyda-neen" }),
    );
  };
  const workspace = path.join(root, "host", "publish", "seyda");
  const holds = { hold, holdInit, holdPublish, holdRelease };
  return { make, runs, game, onGenex, ...holds, fail, refuse, failStatus, busy, workspace };
}

/** How long `until` waits for what it was told to see before the test fails. */
const UNTIL_MS = 15_000;

/** Wait until `seen` says so: for what happens behind a press, which no call answers for. */
async function until(seen: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!(await seen())) {
    if (Date.now() > deadline) throw new Error("what the test waited for never happened");
    await wait(20);
  }
}

const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** Genex knowing the game the stand-in's `init` makes as this account's own, as it does once it made it. */
const OWN_GAME: GenexHandler = (req, reply) => {
  if (req.url === "/api/auth/get-session") return reply.json({ user: { id: "u-me", email: "me@example.invalid" } });
  if (req.url.startsWith("/api/projects/by-slug/seyda-neen"))
    return reply.json({ project: { id: "p1", slug: "seyda-neen", owner: { id: "u-me" } } });
};

/** A fixture Genex API: the signed-in session and accepted terms, and what `handler` answers before them. */
async function fixtureApi(handler: GenexHandler = OWN_GAME): Promise<string> {
  const server = await startGenexFixtureApi(handler);
  servers.push(server);
  return server.url;
}

/** Each run in short: its command, and whether it keeps the build (`--hold`) or lists the game (`--gallery`). */
const words = (runs: Array<{ args: string[] }>): string[] =>
  runs.map(({ args }) => {
    if (args[0] !== "native") return String(args[0]);
    return [args[1], ...["--hold", "--gallery"].filter((flag) => args.includes(flag))].join(" ");
  });

/** What a publish asked of the CLI after the three runs of a kept build; the kept app's own re-read lands anywhere among them. */
const publishWords = (runs: Array<{ args: string[] }>): string[] =>
  words(runs)
    .slice(3)
    .filter((run) => run !== "build-status");

describe("the Genex plugin's builds on Genex", () => {
  it("sends the game's project for a Windows build once the game is on Genex, then follows it to its end", async () => {
    const { make, runs, game, onGenex, workspace } = await toolsWithBuildCli();
    const genex = make();
    await assert.rejects(genex.cloudBuild("seyda", "windows", game), /Publish the game first/);
    await assert.rejects(genex.cloudBuild("seyda", "windows", undefined), /Open the game/);
    assert.deepEqual(await runs(), [], "Genex is asked nothing before the game has a page there");
    await onGenex();
    const started = await genex.cloudBuild("seyda", "windows", game);
    assert.equal(started.cloud?.supported, true);
    await genex.cloudSettled();
    const calls = await runs();
    assert.deepEqual(
      // The command's own words: the runner adds `--json`, the credential file and the API after them.
      calls.map((call) => call.args.slice(0, call.args[1] === "build" ? 6 : 3)),
      [cloudBuildArgs("windows", path.join(workspace, CLOUD_SOURCE_FOLDER)), buildStatusArgs("job_7")],
    );
    assert.deepEqual(
      calls[0]?.staged,
      ["Content", "SeydaNeen.uproject"],
      "the game's Unreal project alone went, its .uproject at the top",
    );
    const realWorkspace = await realpath(workspace);
    assert.ok(
      calls.every((call) => call.cwd === realWorkspace),
      "each run is in the game's publish workspace",
    );
    const { native } = await genex.publishView("seyda");
    assert.deepEqual(
      native?.cloud?.builds.map((build) => [build.jobId, build.state]),
      [["job_7", CloudBuildState.Done]],
    );
    assert.equal((await readdir(workspace)).includes(CLOUD_SOURCE_FOLDER), false, "the staged copy is gone");
    const ignored = (await readFile(path.join(workspace, ".gitignore"), "utf8")).split("\n");
    assert.ok(
      ignored.includes(`${CLOUD_SOURCE_FOLDER}/`) && ignored.includes(CLOUD_BUILD_FILE),
      "the workspace never pushes them",
    );
  });

  it("builds a game linked to its page on Genex but never published from this app, as the dialog offers", async () => {
    // The incident: a game put on Genex through the CLI (its publish workspace's `.genex/project.json`)
    // had no slug in `publish.json`. The dialog read the link and offered Build on Genex; the press
    // read `publish.json` alone and answered "Publish the game first".
    const { make, runs, game, workspace } = await toolsWithBuildCli();
    await mkdir(path.join(workspace, ".genex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".genex", "project.json"),
      JSON.stringify({ id: "proj_1", slug: "seyda-neen", status: "published" }),
    );
    const genex = make();
    assert.equal((await genex.publishView("seyda")).slug, "seyda-neen", "the dialog sees the game's page");
    const started = await genex.cloudBuild("seyda", "windows", game);
    assert.equal(started.cloud?.supported, true);
    await genex.cloudSettled();
    assert.deepEqual(
      (await runs()).map((call) => call.args[1]),
      ["build", "build-status"],
    );
  });

  it("answers the press at once and sends a big project behind it: a call lives 190 seconds, an upload doesn't", async () => {
    // The incident: the press waited for the whole upload inside one plugin call, so the host gave
    // up at 190 seconds and said "Stopped local plugin wait" while the project was still going up.
    const { make, runs, game, onGenex, hold, workspace } = await toolsWithBuildCli();
    await onGenex();
    await writeFile(hold, "");
    const genex = make();
    const pressed = await genex.cloudBuild("seyda", "windows", game);
    assert.equal(pressed.cloud?.send?.state, CloudSendState.Sending, "the press answers while the upload runs");
    assert.equal(pressed.cloud?.send?.platform, "windows");
    assert.equal(pressed.cloud?.send?.held, undefined, "its app goes on the game's page once built");
    const again = await genex.cloudBuild("seyda", "windows", game);
    assert.equal(again.cloud?.send?.state, CloudSendState.Sending, "a second press joins the send under way");
    await rm(hold);
    await genex.cloudSettled();
    assert.deepEqual(
      (await runs()).map((call) => call.args[1]),
      ["build", "build-status"],
      "one send, then the build is followed",
    );
    const { native } = await genex.publishView("seyda");
    assert.equal(native?.cloud?.send, undefined, "a send that arrived leaves only its build");
    assert.deepEqual(
      native?.cloud?.builds.map((build) => build.state),
      [CloudBuildState.Done],
    );
    assert.equal((await readdir(workspace)).includes(CLOUD_SOURCE_FOLDER), false, "the staged copy is gone");
  });

  it("says why a send stopped in the CLI's last words, and Try again sends it once more", async () => {
    const { make, runs, game, onGenex, fail, workspace } = await toolsWithBuildCli();
    await onGenex();
    await writeFile(fail, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game);
    await genex.cloudSettled();
    const failed = (await genex.publishView("seyda")).native?.cloud;
    assert.equal(failed?.send?.state, CloudSendState.Failed);
    assert.equal(failed?.send?.error, "Upload failed (part 93/150).");
    assert.deepEqual(failed?.builds, []);
    assert.equal((await readdir(workspace)).includes(CLOUD_SOURCE_FOLDER), false, "nothing staged stays behind");
    await rm(fail);
    await genex.cloudBuild("seyda", "windows", game);
    await genex.cloudSettled();
    const sent = (await genex.publishView("seyda")).native?.cloud;
    assert.equal(sent?.send, undefined, "the failure is gone once a send arrives");
    assert.equal(sent?.builds[0]?.state, CloudBuildState.Done);
    assert.equal((await runs()).filter((call) => call.args[1] === "build").length, 2);
  });

  it("reads a send Studio was closed in the middle of as stopped, never as still going", async () => {
    const { make, onGenex, workspace } = await toolsWithBuildCli();
    await onGenex();
    const send = { platform: "windows", startedAt: STARTED, state: CloudSendState.Sending };
    await writeFile(path.join(workspace, CLOUD_BUILD_FILE), JSON.stringify({ builds: [], send }));
    const { native } = await make().publishView("seyda");
    assert.deepEqual(native?.cloud?.send, { ...send, state: CloudSendState.Failed });
  });

  it("refuses an Unreal version the build computers don't have before anything is sent", async () => {
    const versions = ["5.5", "5.7", "5.9", "4.27", "", "{A1B2C3D4-0000-0000-0000-000000000000}"];
    for (const engine of versions) {
      const { make, runs, game, onGenex } = await toolsWithBuildCli({ engine });
      await onGenex();
      const genex = make();
      await assert.rejects(genex.cloudBuild("seyda", "windows", game), /Genex builds Unreal 5\.8 games/, engine);
      assert.deepEqual(await runs(), [], `nothing sent for "${engine}"`);
      assert.equal((await genex.publishView("seyda")).native?.cloud?.send, undefined);
    }
  });

  it("follows a build Studio left running when it next reads the record", async () => {
    const { make, runs, onGenex, workspace } = await toolsWithBuildCli();
    await onGenex();
    await writeFile(path.join(workspace, CLOUD_BUILD_FILE), JSON.stringify({ builds: [{ ...BUILD, jobId: "job_7" }] }));
    const genex = make();
    const first = await genex.publishView("seyda");
    assert.equal(first.native?.cloud?.builds[0]?.state, CloudBuildState.Queued);
    await genex.cloudSettled();
    assert.deepEqual(
      (await runs()).map((call) => call.args[1]),
      ["build-status"],
    );
    assert.equal((await genex.publishView("seyda")).native?.cloud?.builds[0]?.state, CloudBuildState.Done);
  });

  it("asks nothing while the CLI has no `genex native build`, and says so in the record", async () => {
    const { make, runs, game, onGenex } = await toolsWithBuildCli({ buildsApps: false });
    await onGenex();
    const genex = make();
    await assert.rejects(genex.cloudBuild("seyda", "windows", game), /can’t build apps on Genex yet/);
    assert.deepEqual((await genex.publishView("seyda")).native?.cloud, { supported: false, builds: [] });
    assert.deepEqual(await runs(), []);
  });
});

describe("an app Genex builds and keeps for a publish", () => {
  const MAC_APP = { target: "/game/Builds/Mac/Seyda Neen.app", platform: "mac" as const };

  it("builds a game that was never published: its project is made on Genex and nothing goes to players", async () => {
    const { make, runs, game } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    const started = await genex.cloudBuild("seyda", "windows", game, true);
    assert.deepEqual(
      [started.cloud?.send?.state, started.cloud?.send?.held],
      [CloudSendState.Sending, true],
      "on its way, and the record says Genex keeps what it builds",
    );
    await genex.cloudSettled();
    assert.deepEqual(words(await runs()), ["init", "build --hold", "build-status"]);
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.held, build.installedBytes]),
      [[CloudBuildState.Built, true, 2048]],
      "built, kept, and its size known",
    );
    assert.deepEqual(view.native?.sent, [], "players have nothing");
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    assert.equal(words(await runs()).filter((run) => run === "init").length, 1, "the game's project is made once");
  });

  it("asks nothing before Genex's terms are accepted, or signed out", async () => {
    const refusing = await fixtureApi((req, reply) => {
      if (req.url.includes("legal")) return reply.json({ accepted: false });
    });
    const { make, runs, game } = await toolsWithBuildCli({ api: refusing });
    const genex = make();
    const answer = await genex.cloudBuild("seyda", "windows", game, true);
    assert.equal(answer.cloud?.send, undefined);
    assert.equal((await genex.publishStatus("seyda")).terms?.accepted, false, "the dialog asks for the terms");
    assert.deepEqual(await runs(), [], "nothing made on Genex, nothing sent");
    const signedOut = new GenexTools(path.join(await tmpDir("cloud-build-out"), "host"), refusing, {
      credentials: { get: async () => null, set: async () => {}, clear: async () => {} },
      buildsApps: true,
    });
    await assert.rejects(signedOut.cloudBuild("seyda", "windows", game, true), /Connect the Genex plugin first/);
  });

  it("gives players a kept build with a publish, and lists the game with it when it is the game's first app", async () => {
    const { make, runs, game } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    const started = await genex.publishAppsOnly("seyda", [], "Seyda Neen", {}, undefined, ["windows"]);
    assert.equal(started.job?.state, "running");
    const state = await genex.publishWait("seyda");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    const calls = await runs();
    assert.deepEqual(publishWords(calls), ["build-release --gallery", "cover"]);
    const release = calls.find((call) => call.args[1] === "build-release")?.args ?? [];
    assert.deepEqual(release.slice(0, 6), ["native", "build-release", "job_7", "--gallery", "--title", "Seyda Neen"]);
    assert.equal(state.status, "published");
    assert.deepEqual(state.native?.listing, { state: "published", detail: null });
    assert.deepEqual(
      state.native?.cloud?.builds.map((build) => [build.state, build.held]),
      [[CloudBuildState.Done, undefined]],
      "players have it",
    );
  });

  it("sends the Mac app and the kept Windows build in one publish, listing the game once", async () => {
    const { make, runs, game } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    const state = await genex.publishWait("seyda");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.deepEqual(publishWords(await runs()), ["publish --gallery", "build-release", "cover"]);
    assert.deepEqual(
      state.native?.sent.map((sent) => sent.platform),
      ["mac"],
    );
    assert.equal(state.native?.cloud?.builds[0]?.state, CloudBuildState.Done);
  });

  it("remembers a publish that comes while the project is still going up, and asks once Genex names the build", async () => {
    const { make, runs, game, hold } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(hold, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    const state = await genex.publishWait("seyda");
    assert.equal(state.job?.state, "done", "the Mac app is live; Windows follows");
    assert.deepEqual(
      [state.native?.cloud?.send?.state, state.native?.cloud?.send?.released],
      [CloudSendState.Sending, true],
      "its row says it is on its way to players",
    );
    assert.equal(words(await runs()).includes("build-release"), false, "nothing to ask for yet");
    await rm(hold);
    await genex.cloudSettled();
    const after = words(await runs());
    assert.equal(after.filter((run) => run === "build-release").length, 1, "asked once, with no listing of its own");
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.held]),
      [[CloudBuildState.Done, undefined]],
    );
    assert.equal(view.native?.cloud?.send, undefined);
  });

  it("forgets a publish's ask when the project never arrives: the next build is kept, not given to players", async () => {
    const { make, runs, game, hold, fail } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(hold, "");
    await writeFile(fail, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    await genex.publishWait("seyda");
    await rm(hold);
    await genex.cloudSettled();
    assert.equal((await genex.publishView("seyda")).native?.cloud?.send?.state, CloudSendState.Failed);
    await rm(fail);
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    assert.equal(words(await runs()).includes("build-release"), false);
    assert.equal((await genex.publishView("seyda")).native?.cloud?.builds[0]?.state, CloudBuildState.Built);
  });

  it("asks once for a build a publish wanted when Genex refuses it for good, and the record says it is not built", async () => {
    const { make, runs, game, hold, refuse } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(hold, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    await genex.publishWait("seyda");
    // Genex has nothing of the build to give by the time its project is up.
    await writeFile(refuse, "");
    await rm(hold);
    await genex.cloudSettled();
    assert.equal(
      words(await runs()).filter((run) => run === "build-release").length,
      1,
      "a refusal is an answer: asking again changes nothing",
    );
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.failure, build.held]),
      [[CloudBuildState.Failed, CloudBuildFailure.Expired, undefined]],
    );
  });

  it("asks again for a build a publish wanted while Genex can't release it right now, and the build stays kept", async () => {
    const { make, runs, game, hold, busy } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(hold, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    await genex.publishWait("seyda");
    await writeFile(busy, "");
    await rm(hold);
    await genex.cloudSettled();
    assert.equal(
      words(await runs()).filter((run) => run === "build-release").length,
      4,
      "asked a few times, then no more",
    );
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.held]),
      [[CloudBuildState.Built, true]],
      "still kept: the next Publish gives it to players",
    );
  });

  it("starts a new build when asked while Genex is still answering the release of the one before", async () => {
    const { make, runs, game, hold, holdRelease } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(hold, "");
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen", {}, undefined, ["windows"]);
    await genex.publishWait("seyda");
    await writeFile(holdRelease, "");
    await rm(hold);
    // The project is up and its app built; the release a publish asked for is still under way.
    await until(
      async () => (await genex.publishView("seyda")).native?.cloud?.builds[0]?.state === CloudBuildState.Built,
    );
    await until(async () => words(await runs()).includes("build-release"));
    const pressed = await genex.cloudBuild("seyda", "windows", game, true);
    assert.equal(pressed.cloud?.send?.state, CloudSendState.Sending, "the press starts a send: none is under way");
    await rm(holdRelease);
    await genex.cloudSettled();
    assert.equal(words(await runs()).filter((run) => run === "build --hold").length, 2);
  });

  it("refuses a build while a publish is still making the game's project, and sends nothing", async () => {
    const { make, runs, game, holdInit } = await toolsWithBuildCli({ api: await fixtureApi() });
    await writeFile(holdInit, "");
    const genex = make();
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen");
    await until(async () => words(await runs()).includes("init"));
    await assert.rejects(genex.cloudBuild("seyda", "windows", game, true), /still running/);
    assert.equal(words(await runs()).includes("build --hold"), false, "nothing is sent to a project that isn't there");
    await rm(holdInit);
    assert.equal((await genex.publishWait("seyda")).job?.state, "done");
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    assert.deepEqual(
      words(await runs()).filter((run) => run === "init" || run === "build --hold"),
      ["init", "build --hold"],
      "once the publish made the project, the build goes to it",
    );
  });

  it("gives players a kept build asked for while another publish runs, once that publish is done", async () => {
    const { make, runs, game, holdPublish } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    // A publish is under way (a web build's, or the Mac app's here) when the kept Windows app is asked for.
    await writeFile(holdPublish, "");
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen");
    const asked = await genex.publishAppsOnly("seyda", [], "Seyda Neen", {}, undefined, ["windows"]);
    assert.equal(asked.job?.state, "running", "the publish under way goes on");
    assert.equal(words(await runs()).includes("build-release"), false, "nothing is asked of Genex yet");
    await rm(holdPublish);
    assert.equal((await genex.publishWait("seyda")).job?.state, "done");
    await until(async () => words(await runs()).includes("build-release"));
    await genex.appsSent("seyda");
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.held]),
      [[CloudBuildState.Done, undefined]],
      "players have the Windows app",
    );
    assert.deepEqual(
      view.native?.sent.map((sent) => sent.platform),
      ["mac"],
      "and the record still says the Mac app went",
    );
  });

  it("gives players a kept build behind a web publish's apps, keeping what the record says of the others", async () => {
    const { make, runs, game } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    await genex.publishAppsOnly("seyda", [MAC_APP], "Seyda Neen");
    await genex.publishWait("seyda");
    await genex.publishApps("seyda", "web-job", [], ["windows"]);
    assert.equal(words(await runs()).filter((run) => run === "build-release").length, 1);
    const view = await genex.publishView("seyda");
    assert.equal(view.native?.cloud?.builds[0]?.state, CloudBuildState.Done);
    assert.deepEqual(
      view.native?.sent.map((sent) => sent.platform),
      ["mac"],
    );
  });

  it("reads a kept app again when Genex couldn't be read the first time", async () => {
    const { make, runs, onGenex, refuse, failStatus, workspace } = await toolsWithBuildCli();
    await onGenex();
    await writeFile(path.join(workspace, CLOUD_BUILD_FILE), JSON.stringify({ builds: [{ ...KEPT, jobId: "job_7" }] }));
    await writeFile(failStatus, "");
    const genex = make();
    await genex.publishView("seyda");
    await genex.cloudSettled();
    assert.equal((await genex.publishView("seyda")).native?.cloud?.builds[0]?.state, CloudBuildState.Built);
    await genex.cloudSettled();
    // Back online: Genex stopped keeping the app meanwhile.
    await rm(failStatus);
    await writeFile(refuse, "");
    await genex.publishView("seyda");
    await genex.cloudSettled();
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.failure]),
      [[CloudBuildState.Failed, CloudBuildFailure.Expired]],
      "the record learns it before anyone presses Publish",
    );
    assert.ok(words(await runs()).length >= 2, "asked again after the read that failed");
  });

  it("reads a kept app again once when the record is next read: one Genex no longer keeps is not built", async () => {
    const { make, runs, onGenex, refuse, workspace } = await toolsWithBuildCli();
    await onGenex();
    await writeFile(path.join(workspace, CLOUD_BUILD_FILE), JSON.stringify({ builds: [{ ...KEPT, jobId: "job_7" }] }));
    await writeFile(refuse, "");
    const genex = make();
    const first = await genex.publishView("seyda");
    assert.equal(first.native?.cloud?.builds[0]?.state, CloudBuildState.Built, "as Studio left it");
    await genex.cloudSettled();
    const view = await genex.publishView("seyda");
    assert.deepEqual(
      view.native?.cloud?.builds.map((build) => [build.state, build.failure, build.held]),
      [[CloudBuildState.Failed, CloudBuildFailure.Expired, undefined]],
    );
    await genex.cloudSettled();
    assert.deepEqual(words(await runs()), ["build-status"], "asked once, however often the record is read");
  });

  it("fails a publish of a kept build alone in Genex's words when Genex no longer keeps it, and the record says so", async () => {
    const { make, runs, game, refuse } = await toolsWithBuildCli({ api: await fixtureApi() });
    const genex = make();
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    // The dialog read the record while Genex still kept the app; it stopped keeping it after.
    await genex.publishView("seyda");
    await genex.cloudSettled();
    await writeFile(refuse, "");
    await genex.publishAppsOnly("seyda", [], "Seyda Neen", {}, undefined, ["windows"]);
    const state = await genex.publishWait("seyda");
    assert.equal(state.job?.state, "failed");
    assert.match(state.job?.error ?? "", /no longer keeps this build/);
    assert.deepEqual(
      state.native?.cloud?.builds.map((build) => [build.state, build.failure, build.held]),
      [[CloudBuildState.Failed, CloudBuildFailure.Expired, undefined]],
      "not built any more: the next press builds it",
    );
    await genex.cloudBuild("seyda", "windows", game, true);
    await genex.cloudSettled();
    assert.equal(words(await runs()).filter((run) => run === "build --hold").length, 2, "and it is built again");
    await assert.rejects(
      genex.publishAppsOnly("seyda", [], "Seyda Neen", {}, undefined, []),
      /no Mac, Windows or Linux app/,
    );
    await assert.rejects(
      genex.publishAppsOnly("seyda", [], "Seyda Neen", {}, undefined, ["mac"]),
      /no app for that system/,
    );
  });
});
