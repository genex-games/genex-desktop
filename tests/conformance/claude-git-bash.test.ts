/**
 * Claude Code on Windows is handed Genex's Git Bash. Without one it finds itself, the CLI turns
 * its Bash tool off and runs commands through its PowerShell tool, which the never-touch screen
 * and the person's saved Bash rules do not read.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

const GIT_BASH = String.raw`C:\Users\person\AppData\Local\Programs\Genex\resources\git\bin\bash.exe`;
const GIT_BASH_ENV = "CLAUDE_CODE_GIT_BASH_PATH";

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done.",
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A signed-in engine on `platform` whose Git Bash lookup answers `found`, and the lookups it made. */
async function engineOn(platform: NodeJS.Platform, found: string | null | Error) {
  const root = await tmpDir("studio-git-bash-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  const seen: Array<Record<string, unknown>> = [];
  const lookups: number[] = [];
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    platform,
    gitBash: async () => {
      lookups.push(1);
      if (found instanceof Error) throw found;
      return found;
    },
    queryFn: ((params: { prompt: string; options?: Record<string, unknown> }) => {
      seen.push({ ...params.options });
      return {
        async *[Symbol.asyncIterator]() {
          yield success;
        },
      };
    }) as never,
  });
  const cwd = await tmpDir("studio-git-bash-game-");
  const delegate = () => engine.delegate({ cwd, prompt: "Build it" } as never);
  const env = () => (seen.at(-1)?.env ?? {}) as Record<string, string>;
  return { delegate, env, lookups };
}

describe("Claude Code is handed Genex's Git Bash on Windows", () => {
  it("a Windows session's CLI gets the Git Bash Genex found, so its shell is Bash, never PowerShell", async () => {
    const { delegate, env } = await engineOn("win32", GIT_BASH);
    const result = await delegate();
    assert.equal(result.ok, true);
    assert.equal(env()[GIT_BASH_ENV], GIT_BASH);
  });

  it("the Git Bash is looked up once per engine, not per session", async () => {
    const { delegate, lookups } = await engineOn("win32", GIT_BASH);
    await delegate();
    await delegate();
    assert.equal(lookups.length, 1);
  });

  it("a Git Bash the person chose themselves is kept", async (t) => {
    const own = String.raw`D:\tools\git\bin\bash.exe`;
    const saved = process.env[GIT_BASH_ENV];
    process.env[GIT_BASH_ENV] = own;
    t.after(() => {
      if (saved === undefined) delete process.env[GIT_BASH_ENV];
      else process.env[GIT_BASH_ENV] = saved;
    });
    const { delegate, env } = await engineOn("win32", GIT_BASH);
    await delegate();
    assert.equal(env()[GIT_BASH_ENV], own);
  });

  it("with no Git Bash anywhere, nothing is set and the session still starts", async () => {
    const saved = process.env[GIT_BASH_ENV];
    delete process.env[GIT_BASH_ENV];
    try {
      const { delegate, env } = await engineOn("win32", null);
      const result = await delegate();
      assert.equal(result.ok, true);
      assert.equal(env()[GIT_BASH_ENV], undefined);
    } finally {
      if (saved !== undefined) process.env[GIT_BASH_ENV] = saved;
    }
  });

  it("a lookup that fails sets nothing and the session still starts", async () => {
    const { delegate, env } = await engineOn("win32", new Error("reg query failed"));
    const result = await delegate();
    assert.equal(result.ok, true);
    assert.equal(env()[GIT_BASH_ENV], undefined);
  });

  it("macOS and Linux never look for Git Bash (characterization)", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { delegate, env, lookups } = await engineOn(platform, GIT_BASH);
      await delegate();
      assert.equal(lookups.length, 0, platform);
      assert.equal(env()[GIT_BASH_ENV], undefined, platform);
    }
  });
});
