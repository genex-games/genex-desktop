/**
 * Apps Genex builds on its own computers (`genex native build`): only a CLI new enough asks, the
 * project is staged and removed once sent, a build's job is followed until it ends, and anything off
 * in an answer, a job id above all, is dropped before it reaches the record or the CLI's arguments.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildStatusArgs,
  CLOUD_BUILD_FILE,
  CLOUD_SOURCE_FOLDER,
  type CloudBuildDeps,
  cloudBuildArgs,
  cloudBuildOf,
  hasCloudBuildCommand,
  isRunning,
  pollDelayMs,
  readCloudBuilds,
  startCloudBuild,
  watchCloudBuild,
  withBuild,
} from "../../src/plugins/genex/cloud-build.ts";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { CloudBuildFailure, CloudBuildState, type GenexCloudBuild } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

const STARTED = "2026-10-23T10:00:00.000Z";
const BUILD = { platform: "windows", jobId: "job_1", state: CloudBuildState.Queued, startedAt: STARTED };

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

describe("asking Genex to build an app", () => {
  it("is asked only by a CLI with `genex native build`", () => {
    for (const version of ["1.38.0", "1.38.1", "1.39.0-dev.1", "2.0.0"])
      assert.equal(hasCloudBuildCommand(version), true, version);
    for (const version of ["1.37.9", "1.38.0-dev.4", "1.36.13", "", "latest", "1.38"])
      assert.equal(hasCloudBuildCommand(version), false, version);
  });

  it("names the platform and the staged project, and a job by its id", () => {
    assert.deepEqual(cloudBuildArgs("windows", "/w/cloud-source"), [
      "native",
      "build",
      "--platform",
      "windows",
      "--source",
      "/w/cloud-source",
    ]);
    assert.deepEqual(buildStatusArgs("job_1"), ["native", "build-status", "job_1"]);
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

/** A Genex plugin whose CLI is a stand-in that answers `native build` and `build-status`, every run logged. */
async function toolsWithBuildCli(options: { buildsApps?: boolean } = {}) {
  const root = await tmpDir("cloud-build-tools");
  const log = path.join(root, "runs.jsonl");
  const standIn = path.join(root, "build-cli.mjs");
  await writeFile(
    standIn,
    `import { appendFileSync, existsSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
const staged = source && existsSync(source) ? readdirSync(source).sort() : null;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), staged }) + "\\n");
const build = { platform: "windows", jobId: "job_7", startedAt: "2026-10-23T10:00:00.000Z" };
if (args[1] === "build") process.stdout.write(JSON.stringify({ build: { ...build, state: "queued" } }));
else process.stdout.write(JSON.stringify({ build: { ...build, state: "done", finishedAt: "2026-10-23T10:21:00.000Z" } }));
process.exit(0);
`,
  );
  const make = () =>
    new GenexTools(path.join(root, "host"), "http://127.0.0.1:9", {
      credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
      preload: standIn,
      buildsApps: options.buildsApps ?? true,
      cloudSleep: async () => {},
    });
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; staged: string[] | null });
  const game = path.join(root, "seyda-neen");
  await mkdir(path.join(game, "Content"), { recursive: true });
  await writeFile(path.join(game, "SeydaNeen.uproject"), "{}");
  await writeFile(path.join(game, "Content", "Map.umap"), "map");
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
  return { make, runs, game, onGenex, workspace: path.join(root, "host", "publish", "seyda") };
}

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
      [".gitattributes", "Content", "SeydaNeen.uproject"],
      "the game’s own files went, its models through LFS",
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
