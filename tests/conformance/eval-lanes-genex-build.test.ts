/**
 * The Genex lanes' build and product default: the eval-owned build runs `git archive`, extract,
 * `npm ci` and `node scripts/build.mjs` in that order through the injected runner (never a
 * development build), is reused once finished, and refuses a non-SHA before touching disk. The
 * product default is computed by importing this checkout's own pure modules in a separate Node;
 * answers that break purity or name a bypass mode are refused.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AppBuildError,
  AppBuildStep,
  type CommandRunner,
  genexAppEnv,
  prepareAppBuild,
  productDefaults,
} from "../../scripts/evals/lanes/genex-app.ts";
import { DEFAULT_PERMISSION_MODE, PermissionMode } from "../../src/shared/permissions.ts";
import type { EvalLaneSpec } from "../../src/shared/eval-lane.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const temps: string[] = [];
const tempDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-genex-build-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A runner that records each command and answers from `codes` (0 by default). */
function recordingRunner(codes: Record<string, number> = {}): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (file, args, options) => {
      calls.push([path.basename(file), ...args, `@${path.basename(options.cwd)}`]);
      return { code: codes[path.basename(file)] ?? 0, stdout: "", stderr: "boom" };
    },
  };
}

describe("eval app build", () => {
  it("archives, extracts, installs and builds in order, then reuses the finished build", async () => {
    const builds = tempDir();
    const { run, calls } = recordingRunner();
    const build = await prepareAppBuild({ repo, sha: SHA, buildsDir: builds, run, env: { PATH: "/usr/bin" } });
    assert.deepEqual(build, { sha: SHA, dir: path.join(builds, SHA), dirty: false });
    assert.deepEqual(
      calls.map((call) => (call[0] === path.basename(process.execPath) ? ["node", ...call.slice(1)] : call)),
      [
        [
          "git",
          "-C",
          repo,
          "archive",
          "--format=tar",
          "-o",
          `${path.join(builds, SHA)}.tar`,
          SHA,
          `@${path.basename(repo)}`,
        ],
        ["tar", "-xf", `${path.join(builds, SHA)}.tar`, "-C", path.join(builds, SHA), `@${path.basename(builds)}`],
        ["npm", "ci", `@${SHA}`],
        ["node", "scripts/build.mjs", `@${SHA}`],
      ],
    );
    assert.equal(calls.flat().includes("--dev-build"), false);
    const again = recordingRunner();
    await prepareAppBuild({ repo, sha: SHA, buildsDir: builds, run: again.run });
    assert.deepEqual(again.calls, []);
  });

  it("names the step that failed and leaves no finished marker", async () => {
    const builds = tempDir();
    const { run } = recordingRunner({ npm: 1 });
    await assert.rejects(prepareAppBuild({ repo, sha: SHA, buildsDir: builds, run }), (error: unknown) => {
      assert.ok(error instanceof AppBuildError);
      assert.equal(error.step, AppBuildStep.Install);
      return true;
    });
    const retry = recordingRunner();
    await prepareAppBuild({ repo, sha: SHA, buildsDir: builds, run: retry.run });
    assert.equal(retry.calls.length, 4, "an unfinished build is rebuilt");
  });

  for (const bad of ["HEAD", "abc123", `${SHA}0`, "../../../etc", `${SHA.slice(0, 39)}g`])
    it(`refuses the build id ${JSON.stringify(bad)} before running or creating anything`, async () => {
      const builds = tempDir();
      const { run, calls } = recordingRunner();
      await assert.rejects(prepareAppBuild({ repo, sha: bad, buildsDir: builds, run }));
      assert.deepEqual(calls, []);
      assert.deepEqual(fs.readdirSync(builds), []);
    });
});

describe("product default", () => {
  it("reads this checkout's own default commission and permission mode from its pure modules", async () => {
    const defaults = await productDefaults(repo);
    assert.equal(defaults.permissionMode, DEFAULT_PERMISSION_MODE);
    // Flipped: Loop starts off, so a fresh chat's send commissions no build.
    assert.deepEqual(defaults.commission, {});
  });

  const answer =
    (value: unknown): CommandRunner =>
    async () => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

  it("takes the build's own send options when it exports them, else the legacy composer rule", async () => {
    const extras = { autopilot: { hours: null, frames: [] } };
    const own = await productDefaults(
      repo,
      answer({ extras, send: { hours: 3 }, permissionMode: "auto", addedGlobals: [] }),
    );
    assert.deepEqual(own.commission, { autopilot: { hours: 3 } });
    const older = { extras: { autopilot: { hours: 2, frames: [] } }, permissionMode: "auto", addedGlobals: [] };
    assert.deepEqual((await productDefaults(repo, answer(older))).commission, { autopilot: { hours: 2 } });
  });

  const hostile: Array<[string, CommandRunner]> = [
    [
      "send options with a key no fresh send carries",
      answer({ extras: { autopilot: {} }, send: { loop: {} }, permissionMode: "auto", addedGlobals: [] }),
    ],
    [
      "send options with hours that are not a number",
      answer({ extras: { autopilot: {} }, send: { hours: "2" }, permissionMode: "auto", addedGlobals: [] }),
    ],
    ["a module that added a global", answer({ extras: {}, permissionMode: "auto", addedGlobals: ["window"] })],
    ["a bypass permission mode", answer({ extras: {}, permissionMode: PermissionMode.Bypass, addedGlobals: [] })],
    ["an unknown permission mode", answer({ extras: {}, permissionMode: "yolo", addedGlobals: [] })],
    ["no commission", answer({ permissionMode: "auto", addedGlobals: [] })],
    ["a failed import", async () => ({ code: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND" })],
  ];
  for (const [name, run] of hostile)
    it(`refuses ${name}`, async () => {
      await assert.rejects(productDefaults(repo, run));
    });
});

describe("Genex app environment", () => {
  it("starts from the fixture launch environment, then opts into live checks and the eval homes", () => {
    const spec = { fixture: false, homes: { claude: "/e/claude", codex: "/e/codex" } } as EvalLaneSpec;
    const env = genexAppEnv(
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/home/op/.codex", GENEX_TOKEN: "t" },
      spec,
    );
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GENEX_TOKEN, undefined);
    assert.equal(env.STUDIO_DISABLE_OS_CREDENTIALS, "1");
    assert.equal(env.STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS, "1");
    assert.equal(env.CODEX_HOME, "/e/codex");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/e/claude");
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
    assert.equal(genexAppEnv({}, { ...spec, fixture: true }).STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS, "0");
  });
});
