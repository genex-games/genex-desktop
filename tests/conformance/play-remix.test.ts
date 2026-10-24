/**
 * Remix from Play: a published game's public source becomes a new game of the person's own. Only an
 * https repository on Genex's git is cloned, into a fresh folder of the games folder, under a git
 * that runs nothing of the copy; the author's history is dropped, the folder is adopted without
 * trusting its Claude settings, and a failed copy leaves no folder behind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayWorld } from "../../src/main/play/gallery.ts";
import {
  claimFolder,
  cloneArgs,
  isRemixSource,
  DOWNLOAD_STALL_MS,
  holdsGame,
  lfsRoutedFiles,
  type RemixDeps,
  RemixRefusedError,
  remixGame,
  type StallClock,
  stallGuard,
  tracksLfs,
} from "../../src/main/play/remix.ts";
import { PlayRemixRefusal, type RemixProgress, RemixStep } from "../../src/shared/play.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

const WORLD: PlayWorld = {
  id: "cm1",
  slug: "lost-cathedral",
  title: "Lost Cathedral",
  multiplayer: false,
  likes: 0,
  liked: false,
  remixable: true,
  cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
  author: "Simeon M",
  authorId: null,
  plays: 0,
  online: null,
  comments: 2,
  coverUrl: null,
};

/** Timers the test moves by hand. */
function manualTimers(): { clock: StallClock; advance: (ms: number) => void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      setTimeout: (run, ms) => {
        next += 1;
        timers.set(next, { at: now + ms, run });
        return next;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

/** A remix's dependencies that do nothing beyond what a test overrides. */
const quiet = (root: string, overrides: Partial<RemixDeps> = {}): RemixDeps => ({
  gamesRoot: () => root,
  clone: async (_url, dest) => {
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "index.html"), "<canvas></canvas>");
  },
  install: async () => {},
  adopt: async () => "adopted",
  build: async () => {},
  progress: () => {},
  log: () => {},
  ...overrides,
});

const exists = async (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

describe("Play remix", () => {
  it("clones only an https repository on Genex's git", () => {
    const cases: Array<[unknown, boolean]> = [
      ["https://git.genex.games/u-1/lost-cathedral.git", true],
      ["https://git.genex.games/u-1/lost-cathedral", false],
      ["http://git.genex.games/u-1/lost-cathedral.git", false],
      ["https://github.com/u-1/lost-cathedral.git", false],
      ["https://git.genex.games.evil.example/u-1/x.git", false],
      ["https://user:pass@git.genex.games/u-1/x.git", false],
      ["https://git.genex.games/u-1/x.git?upload-pack=touch", false],
      ["https://git.genex.games/../../x.git", false],
      ["ext::sh -c touch% /tmp/pwned", false],
      ["file:///etc/x.git", false],
      ["--upload-pack=touch /tmp/pwned", false],
      [null, false],
    ];
    for (const [url, ok] of cases) assert.equal(isRemixSource(url), ok, String(url));
  });

  it("clones shallowly, https only, with no filters, links or hooks, after `--`", () => {
    const args = cloneArgs(WORLD.cloneUrl as string, "/games/lost-cathedral-remix");
    for (const setting of [
      "protocol.allow=never",
      "protocol.https.allow=always",
      "core.symlinks=false",
      "filter.lfs.smudge=",
      "core.hooksPath=/dev/null",
    ])
      assert.ok(args.includes(setting), setting);
    const clone = args.indexOf("clone");
    assert.ok(clone > 0 && args.includes("--depth=1"));
    // Its progress is how a stalled clone is told from a slow one.
    assert.ok(args.includes("--progress"));
    assert.deepEqual(args.slice(-3), ["--", WORLD.cloneUrl, "/games/lost-cathedral-remix"]);
  });

  it("downloads Git LFS files only for a copy whose attributes name the lfs filter", async () => {
    const dir = await tmpDir("studio-remix-lfs-");
    assert.equal(await tracksLfs(dir), false, "no attributes");
    await writeFile(path.join(dir, ".gitattributes"), "# models: filter=lfs\n*.txt text\n");
    assert.equal(await tracksLfs(dir), false, "a comment turns nothing on");
    await writeFile(path.join(dir, ".gitattributes"), "*.txt text\n*.glb filter=lfs diff=lfs merge=lfs -text\n");
    assert.equal(await tracksLfs(dir), true);
  });

  it("routes through Git LFS only the files the clone's own attributes name, nested ones included", async () => {
    const dir = await tmpDir("studio-remix-routed-");
    await gitFile(["init", "-q"], { cwd: dir });
    await mkdir(path.join(dir, "art", "ui"), { recursive: true });
    await writeFile(path.join(dir, ".gitattributes"), "*.glb filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(path.join(dir, "art", ".gitattributes"), "*.png filter=lfs -text\nui/*.png -filter\n");
    const files = ["hero.glb", "notes.txt", "logo.png", "art/sky.png", "art/ui/button.png", "art/tree model.glb"].map(
      (file) => file.split("/").join(path.sep),
    );
    for (const file of files) await writeFile(path.join(dir, file), "x");
    const routed = await lfsRoutedFiles(dir, files);
    assert.deepEqual([...routed].map((file) => file.split(path.sep).join("/")).sort(), [
      "art/sky.png",
      "art/tree model.glb",
      "hero.glb",
    ]);
    assert.deepEqual(await lfsRoutedFiles(dir, []), new Set());
  });

  it("fails, never crashes, when git stops reading the paths it was given", async () => {
    // No repository: git exits at once, and a list bigger than a pipe's buffer meets a closed input.
    const dir = await tmpDir("studio-remix-not-a-repo-");
    const files = Array.from({ length: 20_000 }, (_, index) => `models/a-rather-long-folder-name/${index}.glb`);
    await assert.rejects(lfsRoutedFiles(dir, files));
  });

  it("claims the first free remix folder by making it, so two remixes never share one", async () => {
    const root = await tmpDir("play-remix-claim");
    await mkdir(path.join(root, "x-remix"));
    const [first, second] = await Promise.all([claimFolder(root, "x"), claimFolder(root, "x")]);
    assert.notEqual(first, second);
    assert.deepEqual([first, second].map((dir) => path.basename(dir)).sort(), ["x-remix-2", "x-remix-3"]);
    const always = async () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    await assert.rejects(claimFolder(root, "x", always), /no free folder/);
    const denied = async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    await assert.rejects(claimFolder(root, "y", denied), /denied/);
  });

  it("makes a new game without the author's history and without trusting its settings", async () => {
    const root = await tmpDir("play-remix");
    const adopted: Array<{ dir: string; title: string }> = [];
    const name = await remixGame(
      WORLD,
      quiet(root, {
        clone: async (_url, dest) => {
          await mkdir(path.join(dest, ".git"), { recursive: true });
          await writeFile(path.join(dest, "index.html"), "<h1>game</h1>");
        },
        adopt: async (dir, title) => {
          adopted.push({ dir, title });
          return "lost-cathedral-remix";
        },
      }),
    );
    assert.equal(name, "lost-cathedral-remix");
    const dest = path.join(root, "lost-cathedral-remix");
    assert.deepEqual(adopted, [{ dir: dest, title: "Lost Cathedral remix" }]);
    assert.deepEqual(await readdir(dest), ["index.html"]);
  });

  it("lists the copy under the remix's own title, keeping what kind of game the author's record says it is", async () => {
    const root = await tmpDir("play-remix-record");
    const record = {
      name: "lost-cathedral",
      title: "Lost Cathedral",
      createdAt: "2026-09-18T10:00:00.000Z",
      scaffold: { plugin: "unity", id: "game", label: "Unity game", facts: [] },
    };
    await remixGame(
      WORLD,
      quiet(root, {
        clone: async (_url, dest) => {
          await mkdir(dest, { recursive: true });
          await writeFile(path.join(dest, "studio.json"), JSON.stringify(record));
        },
      }),
    );
    const own = JSON.parse(await readFile(path.join(root, "lost-cathedral-remix", "studio.json"), "utf8"));
    assert.equal(own.title, "Lost Cathedral remix");
    assert.deepEqual(own.scaffold, record.scaffold);
    assert.equal(own.name, undefined, "the author's name for it goes");
    assert.notEqual(own.createdAt, record.createdAt);
    const odd = await tmpDir("play-remix-odd-record");
    await remixGame(
      WORLD,
      quiet(odd, {
        clone: async (_url, dest) => {
          await mkdir(dest, { recursive: true });
          await writeFile(path.join(dest, "index.html"), "<canvas></canvas>");
          await writeFile(path.join(dest, "studio.json"), "[1, 2]");
        },
      }),
    );
    assert.equal(
      await readFile(path.join(odd, "lost-cathedral-remix", "studio.json"), "utf8"),
      "[1, 2]",
      "not an object: left as it is",
    );
  });

  it("leaves nothing behind when the copy fails", async () => {
    const root = await tmpDir("play-remix-fail");
    await assert.rejects(
      remixGame(
        WORLD,
        quiet(root, {
          clone: async (_url, dest) => {
            await mkdir(dest, { recursive: true });
            await writeFile(path.join(dest, "half"), "x");
            throw new Error("network went away");
          },
        }),
      ),
      /network went away/,
    );
    assert.deepEqual(await readdir(root), [], "neither the copy nor its hidden folder");
  });

  it("says in the log why a remix failed, which its toast does not", async () => {
    const root = await tmpDir("play-remix-log");
    const logged: string[] = [];
    const failing = quiet(root, {
      clone: async () => {
        throw new Error("3 of this game’s files didn’t download from Git LFS");
      },
      log: (message) => {
        logged.push(message);
      },
    });
    await assert.rejects(remixGame(WORLD, failing), /didn’t download/);
    assert.deepEqual(logged, ["remix of lost-cathedral failed: 3 of this game’s files didn’t download from Git LFS"]);
    logged.length = 0;
    assert.equal(await remixGame(WORLD, quiet(root, { log: (message) => logged.push(message) })), "adopted");
    assert.deepEqual(logged, [], "a remix that worked logs nothing");
  });

  it("makes nothing of a source with no game in it, and says so by its code", async () => {
    const noGame: Array<[string, Record<string, string>]> = [
      ["a README alone, as a game whose apps alone went to Genex has", { "README.md": "# megastructure" }],
      [
        "a publish's bookkeeping, as a game Studio published before its project could go has",
        {
          "package.json": '{"name":"game-","private":true,"dependencies":{"@genex-ai/embed-sdk":"0.33.0"}}',
          "publish.json": "{}",
          "src/genex.config.ts": "export {}",
          "CLAUDE.md": "notes",
          ".gitignore": "home/",
        },
      ],
      ["an engine's mark too deep to be the game's project", { "a/b/c/ProjectSettings/ProjectVersion.txt": "6000.2" }],
    ];
    for (const [why, files] of noGame) {
      const root = await tmpDir("play-remix-no-game");
      const logged: string[] = [];
      const deps = quiet(root, {
        clone: async (_url, dest) => {
          for (const [file, text] of Object.entries(files)) {
            await mkdir(path.dirname(path.join(dest, file)), { recursive: true });
            await writeFile(path.join(dest, file), text);
          }
        },
        log: (line) => logged.push(line),
      });
      await assert.rejects(
        remixGame(WORLD, deps),
        (error: unknown) => error instanceof RemixRefusedError && error.code === PlayRemixRefusal.NoProject,
        why,
      );
      assert.deepEqual(await readdir(root), [], `${why}: nothing is left behind`);
      assert.equal(logged.length, 1, `${why}: the log says why`);
    }
  });

  it("knows a game by its record, its page, the packages that build it, or an engine's project", async () => {
    const games: Array<[string, Record<string, string>]> = [
      ["a Genex game's record", { "studio.json": "{}" }],
      ["a page at its root", { "index.html": "<canvas></canvas>" }],
      ["packages that build it", { "package.json": '{"scripts":{"build":"vite build"}}' }],
      ["a Unity project", { "unity/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.2" }],
      ["a Godot project", { "godot/project.godot": "[application]" }],
      ["an Unreal project", { "Arena/Arena.uproject": "{}" }],
    ];
    for (const [why, files] of games) {
      const dir = await tmpDir("play-remix-game");
      for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), text);
      }
      assert.equal(await holdsGame(dir), true, why);
    }
    const linked = await tmpDir("play-remix-linked");
    const elsewhere = await tmpDir("play-remix-elsewhere");
    await writeFile(path.join(elsewhere, "index.html"), "<canvas></canvas>");
    await symlink(path.join(elsewhere, "index.html"), path.join(linked, "index.html"));
    assert.equal(await holdsGame(linked), false, "a link to a page elsewhere is no game");
  });

  it("refuses a game that may not be remixed before touching the disk", async () => {
    const root = await tmpDir("play-remix-refused");
    let cloned = 0;
    const deps = quiet(root, {
      clone: async () => {
        cloned += 1;
      },
    });
    for (const world of [
      { ...WORLD, remixable: false },
      { ...WORLD, cloneUrl: "https://github.com/a/b.git" },
      { ...WORLD, slug: "../escape" },
    ])
      await assert.rejects(remixGame(world, deps), /can’t be remixed/);
    assert.equal(cloned, 0);
    assert.deepEqual(await readdir(root), []);
  });
  it("makes the copy in order: files, models, packages, the game, its first build, and says each step", async () => {
    const root = await tmpDir("play-remix-steps");
    const seen: string[] = [];
    const heard: Array<Omit<RemixProgress, "slug">> = [];
    const name = await remixGame(
      WORLD,
      quiet(root, {
        clone: async (_url, dest, models) => {
          await mkdir(path.join(dest, ".git"), { recursive: true });
          await writeFile(path.join(dest, "studio.json"), "{}");
          seen.push("clone");
          models(0, 2_000);
          models(2_000, 2_000);
        },
        install: async (dir) => {
          // The author's history is gone before anything of theirs is installed.
          seen.push(`install ${await exists(path.join(dir, ".git"))}`);
        },
        adopt: async () => {
          seen.push("adopt");
          return "lost-cathedral-remix";
        },
        build: async (game) => {
          seen.push(`build ${game}`);
        },
        progress: (progress) => {
          heard.push(progress);
        },
      }),
    );
    assert.equal(name, "lost-cathedral-remix");
    assert.deepEqual(seen, ["clone", "install false", "adopt", "build lost-cathedral-remix"]);
    // The step after adoption names the game, so Create shows one row for it, never two.
    assert.deepEqual(heard, [
      { step: RemixStep.Copy, done: null, total: null, name: null },
      { step: RemixStep.Models, done: 0, total: 2_000, name: null },
      { step: RemixStep.Models, done: 2_000, total: 2_000, name: null },
      { step: RemixStep.Packages, done: null, total: null, name: null },
      { step: RemixStep.Build, done: null, total: null, name: "lost-cathedral-remix" },
    ]);
  });

  it("keeps the remix when its packages or its first build fail: the stage offers what is left", async () => {
    const root = await tmpDir("play-remix-partial");
    const failing = quiet(root, {
      install: async () => {
        throw new Error("registry unreachable");
      },
      adopt: async () => "kept",
      build: async () => {
        throw new Error("type error");
      },
    });
    assert.equal(await remixGame(WORLD, failing), "kept");
    assert.equal(await exists(path.join(root, "lost-cathedral-remix")), true);
  });

  it("never lists half a game: the copy is made in a hidden folder and moves to its own once whole", async () => {
    const root = await tmpDir("play-remix-hidden");
    const seen: string[][] = [];
    const listed = async () => (await readdir(root)).filter((name) => !name.startsWith("."));
    const name = await remixGame(
      WORLD,
      quiet(root, {
        clone: async (_url, dest) => {
          assert.ok(path.basename(dest).startsWith(".remix-lost-cathedral-"), dest);
          await mkdir(path.join(dest, ".git"), { recursive: true });
          await writeFile(path.join(dest, "index.html"), "<h1>game</h1>");
          seen.push(await listed());
        },
        install: async () => {
          seen.push(await listed());
        },
        adopt: async (dir) => {
          seen.push(await listed());
          assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "<h1>game</h1>");
          return path.basename(dir);
        },
      }),
    );
    assert.equal(name, "lost-cathedral-remix");
    assert.deepEqual(seen, [[], [], ["lost-cathedral-remix"]]);
    assert.deepEqual(await readdir(root), ["lost-cathedral-remix"]);
    // A game folder like any other: not the private one a temporary folder would be.
    const plain = await tmpDir("play-remix-plain");
    await mkdir(path.join(plain, "game"));
    const mode = async (dir: string) => (await stat(dir)).mode & 0o777;
    assert.equal(await mode(path.join(root, "lost-cathedral-remix")), await mode(path.join(plain, "game")));
  });

  it("clears what a remix the app quit in the middle of left, and nothing else", async () => {
    const root = await tmpDir("play-remix-left");
    const left = path.join(root, ".remix-lost-cathedral-ab12cd");
    await mkdir(path.join(left, "node_modules"), { recursive: true });
    const kept = [
      ".remix-notes",
      ".remix-lost-cathedral-short",
      ".remix-lost-cathedral-zzzzzz",
      "lost-cathedral-remix-draft",
    ];
    for (const name of kept) await mkdir(path.join(root, name));
    await remixGame(WORLD, quiet(root));
    assert.equal(await exists(left), false);
    for (const name of kept) assert.equal(await exists(path.join(root, name)), true, name);
  });

  it("makes one remix at a time", async () => {
    const root = await tmpDir("play-remix-one");
    let finish = () => {};
    const cloning = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = remixGame(
      WORLD,
      quiet(root, {
        clone: async (_url, dest) => {
          await mkdir(dest, { recursive: true });
          await writeFile(path.join(dest, "index.html"), "<canvas></canvas>");
          started();
          await cloning;
        },
      }),
    );
    await entered;
    await assert.rejects(remixGame({ ...WORLD, slug: "other-game" }, quiet(root)), /Another remix/);
    finish();
    await first;
    assert.equal(await remixGame({ ...WORLD, slug: "other-game" }, quiet(root)), "adopted");
  });

  it("gives a download up only once it stops moving, however long it takes", () => {
    const { clock, advance } = manualTimers();
    const moving = stallGuard(clock);
    // Half an hour of a big game on a slow line, a little progress every minute.
    for (let minute = 0; minute < 30; minute += 1) {
      advance(DOWNLOAD_STALL_MS - 1);
      moving.moved();
    }
    assert.equal(moving.signal.aborted, false);
    advance(DOWNLOAD_STALL_MS);
    assert.equal(moving.signal.aborted, true, "a minute with nothing: stalled");
    const finished = stallGuard(clock);
    finished.stop();
    advance(DOWNLOAD_STALL_MS * 2);
    assert.equal(finished.signal.aborted, false, "a finished download is never given up");
  });
});
