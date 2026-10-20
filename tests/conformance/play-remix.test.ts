/**
 * Remix from Play: a published game's public source becomes a new game of the person's own. Only an
 * https repository on Genex's git is cloned, into a fresh folder of the games folder, under a git
 * that runs nothing of the copy; the author's history is dropped, the folder is adopted without
 * trusting its Claude settings, and a failed copy leaves no folder behind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayWorld } from "../../src/main/play/gallery.ts";
import {
  claimFolder,
  cloneArgs,
  isRemixSource,
  lfsDownloaded,
  lfsPointers,
  DOWNLOAD_STALL_MS,
  lfsPullArgs,
  type RemixDeps,
  remixGame,
  type StallClock,
  stallGuard,
  tracksLfs,
} from "../../src/main/play/remix.ts";
import { type RemixProgress, RemixStep } from "../../src/shared/play.ts";
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
  },
  install: async () => {},
  adopt: async () => "adopted",
  build: async () => {},
  progress: () => {},
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

  it("brings a copy's Git LFS files from the game's own repository, never where a file in it points", async () => {
    const url = WORLD.cloneUrl as string;
    const args = lfsPullArgs(url);
    assert.ok(args.includes(`lfs.url=${url}/info/lfs`), "the repository's own LFS, whatever its .lfsconfig says");
    for (const setting of ["protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null"])
      assert.ok(args.includes(setting), setting);
    // The host's git runs without the person's git config, where `git lfs install` put the filter:
    // without it here, git-lfs downloads the models and then leaves its pointers in their place.
    for (const setting of [
      "filter.lfs.process=git-lfs filter-process",
      "filter.lfs.smudge=git-lfs smudge -- %f",
      "filter.lfs.required=true",
    ])
      assert.ok(args.includes(setting), setting);
    assert.deepEqual(args.slice(-2), ["lfs", "pull"]);
    const dir = await tmpDir("studio-remix-lfs-");
    assert.equal(await tracksLfs(dir), false, "no attributes");
    await writeFile(path.join(dir, ".gitattributes"), "# models: filter=lfs\n*.txt text\n");
    assert.equal(await tracksLfs(dir), false, "a comment turns nothing on");
    await writeFile(path.join(dir, ".gitattributes"), "*.txt text\n*.glb filter=lfs diff=lfs merge=lfs -text\n");
    assert.equal(await tracksLfs(dir), true);
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

  it("finds the files git-lfs left as pointers, from its listing", () => {
    const listing = [
      "9000ee0141 * public/models/character/player.glb",
      "a45e6d25fd - public/animations/Emotes.glb",
      "fb7093552e - public/sounds/footstep 1.mp3",
      "",
    ].join("\n");
    assert.deepEqual(lfsPointers(listing), ["public/animations/Emotes.glb", "public/sounds/footstep 1.mp3"]);
    assert.deepEqual(lfsPointers("9000ee0141 * a.glb\n"), []);
  });

  it("counts the models downloaded so far from git-lfs's progress lines", () => {
    const lines = [
      "download 1/3 1369/7660640 public/models/player.glb",
      "download 1/3 7660640/7660640 public/models/player.glb",
      "download 2/3 4096/9000 public/sounds/shot.mp3",
      "checkout 1/1 9000/9000 public/sounds/shot.mp3",
      "download 3/3 500",
      "not a progress line",
    ].join("\n");
    assert.equal(lfsDownloaded(lines), 7660640 + 4096);
    assert.equal(lfsDownloaded(""), 0);
  });
});
