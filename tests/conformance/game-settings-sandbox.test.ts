/**
 * A game's own settings for a provider's CLI (`.grok`, `.cursor`, `opencode.json`, `.agents`) are
 * write-denied in that provider's session: a later session in the game loads them. On Linux
 * sandbox-runtime guards a deny path that is not there with a stand-in device file in the game
 * while the session runs, and the build's own `git add -A` then refuses the game: so there only
 * settings that exist are denied (`gameSettingsDenyWrites`). The real-sandbox tests run each
 * provider's own box, no mocks.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { antigravitySandbox } from "../../src/substrate/engines/antigravity.ts";
import { cursorSandbox } from "../../src/substrate/engines/cursor.ts";
import { grokSandbox } from "../../src/substrate/engines/grok-cli.ts";
import { openCodeSandbox } from "../../src/substrate/engines/opencode.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";
import { gameSettingsDenyWrites, ProcessSandbox, type SandboxOptions } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** What a test names of a box: its folders, and the platform and disk it is built for. */
interface BoxInput {
  root: string;
  game: string;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

/** One provider: its box, and the settings in a game it never lets a session write. */
interface Provider {
  name: string;
  /** The settings, by their names in the game folder; a folder unless listed in `files`. */
  settings: string[];
  files?: string[];
  box: (input: BoxInput) => SandboxOptions;
}

/** The folders every provider's box is given. */
function shared(input: BoxInput) {
  const { platform, exists } = input;
  return {
    runDir: input.game,
    gameDir: input.game,
    gitDirs: [],
    scratchDir: path.join(input.root, "scratch"),
    secretPaths: [],
    ...(platform ? { platform } : {}),
    ...(exists ? { exists } : {}),
  };
}

const PROVIDERS: Provider[] = [
  {
    name: "Grok Build",
    settings: [".grok"],
    box: (input) => grokSandbox({ ...shared(input), home: path.join(input.root, "home") }),
  },
  {
    name: "Cursor",
    settings: [".cursor"],
    box: (input) => cursorSandbox({ ...shared(input), compileCache: path.join(input.root, "compile-cache") }),
  },
  {
    name: "OpenCode",
    settings: ["opencode.json", ".opencode"],
    files: ["opencode.json"],
    box: (input) => openCodeSandbox({ ...shared(input), env: {}, home: path.join(input.root, "home") }),
  },
  {
    name: "Antigravity",
    settings: [".agents"],
    box: (input) => antigravitySandbox(shared(input)),
  },
];

// Linux's sandbox proxy remains active after the last command: release it so the file can exit.
after(async () => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
});

describe("a game's own provider settings are write-denied", () => {
  const game = path.resolve(path.sep, "games", "pong");
  const root = path.resolve(path.sep, "studio");

  it("on Linux only what exists is named, on macOS and Windows a path not made yet too", () => {
    const paths = [path.join(game, ".grok"), path.join(game, "opencode.json")];
    const onlyGrok = (file: string) => file === paths[0];
    assert.deepEqual(gameSettingsDenyWrites(paths, "linux", onlyGrok), [paths[0]]);
    assert.deepEqual(
      gameSettingsDenyWrites(paths, "linux", () => false),
      [],
    );
    for (const platform of ["darwin", "win32"] as const)
      assert.deepEqual(
        gameSettingsDenyWrites(paths, platform, () => false),
        paths,
        platform,
      );
  });

  for (const provider of PROVIDERS)
    it(`${provider.name}: a missing ${provider.settings.join(" or ")} is denied everywhere but Linux`, () => {
      const all = provider.settings.map((name) => path.join(game, name));
      const denied = (platform: NodeJS.Platform, there: string[]) =>
        provider.box({ root, game, platform, exists: (file) => there.includes(file) }).denyWrite;
      for (const platform of ["darwin", "win32"] as const)
        assert.deepEqual(denied(platform, []), all, `${platform}: a session never plants them`);
      assert.deepEqual(denied("linux", []), [], "a deny on a missing path would put a stand-in file in the game");
      assert.deepEqual(denied("linux", all), all, "settings that are there are denied");
      assert.deepEqual(denied("linux", [all[0] ?? ""]), [all[0]], "each path by itself");
    });
});

describe("a provider's real sandbox and the game's own settings", {
  skip: process.platform === "win32" && "Windows grants last a whole session: the live provider tests run them",
}, () => {
  for (const provider of PROVIDERS)
    it(`${provider.name}: the build's commit takes a game without them, and a session writes none that are there`, async (t) => {
      const root = await realpath(await tmpDir("game-settings-"));
      const game = path.join(root, "game");
      await mkdir(game, { recursive: true });
      await writeFile(path.join(game, "main.js"), "export const x = 1;\n");
      const [first = ""] = provider.settings;

      const fresh = await ProcessSandbox.create(provider.box({ root, game }));
      try {
        const started = await fresh.ensureReady().catch((err: unknown) => err);
        if (started instanceof SandboxUnavailableError) return t.skip(`no sandbox on this machine: ${started.message}`);
        if (started) throw started;
        const build = await fresh.run({ command: "git init -q . && git add -A && ls -A", cwd: game });
        assert.equal(build.code, 0, `the build's own commit takes every file of the game: ${build.stderr}`);
        assert.deepEqual(build.stdout.split("\n").filter(Boolean).sort(), [".git", "main.js"], "no stand-in file");
        if (process.platform === "darwin") {
          const planted = await fresh.run({ command: `mkdir "${first}" || printf x > "${first}"`, cwd: game });
          assert.notEqual(planted.code, 0, "macOS refuses settings not made yet");
        }
      } finally {
        await fresh.dispose();
      }
      assert.deepEqual((await readdir(game)).sort(), [".git", "main.js"], "and nothing is left in the game");

      // The person's own session made the settings: a provider's session still may not write them.
      for (const name of provider.settings) {
        if (provider.files?.includes(name)) await writeFile(path.join(game, name), "{}\n");
        else await mkdir(path.join(game, name));
      }
      const kept = await ProcessSandbox.create(provider.box({ root, game }));
      try {
        for (const name of provider.settings) {
          const target = provider.files?.includes(name) ? name : `${name}/hooks.json`;
          const written = await kept.run({ command: `printf x > "${target}"`, cwd: game });
          assert.notEqual(written.code, 0, `${name} stays as the person left it`);
        }
        const build = await kept.run({ command: "git add -A", cwd: game });
        assert.equal(build.code, 0, `the commit still takes the game: ${build.stderr}`);
        const source = await kept.run({ command: "printf x > src.js", cwd: game });
        assert.equal(source.code, 0, `the rest of the game is the session's to write: ${source.stderr}`);
      } finally {
        await kept.dispose();
      }
    });
});
