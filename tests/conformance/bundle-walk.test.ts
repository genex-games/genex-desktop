/**
 * The one bounded walker both bundle gates and the cross run directory read a build's output
 * through (`substrate/bundle-walk.ts`): `opendir` one name at a time, `lstat` for every kind, never
 * into a link, never opening a FIFO, and refused at its entry and depth caps without reading a
 * name past them. Every hostile row asserts the refusal, what was read (no name past the cap, no
 * folder below a link or the depth cap) and that nothing under the folder changed. Rows that need
 * a listing no Mac disk can hold (names one only by case or Unicode form) inject the listing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BUNDLE_WALK_LIMITS,
  type BundleReads,
  type FolderListing,
  openBundleFile,
  WALK_REPORT_ONLY,
  WalkKind,
  type WalkLimits,
  WalkProblem,
  walkBundle,
} from "../../src/substrate/bundle-walk.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX = process.platform !== "win32";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Everything under `root`, without following a link: kind, size, mode, mtime, link count, digest and link target. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const rel = path.relative(root, full);
      const facts = `${info.mode} ${info.mtimeMs} ${info.nlink}`;
      if (info.isSymbolicLink()) out[rel] = `link ${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[rel] = `dir ${facts}`;
        await walk(full);
      } else if (info.isFile()) out[rel] = `file ${info.size} ${facts} ${sha256(await readFile(full))}`;
      else out[rel] = `other ${facts}`;
    }
  };
  await walk(root);
  return out;
}

/** Reads that record every call: which paths were `lstat`ed and listed, and how many names were read. */
function counted(base: BundleReads = { lstat, opendir }) {
  const seen = { lstat: [] as string[], opendir: [] as string[], names: 0 };
  const reads: BundleReads = {
    lstat: (file) => {
      seen.lstat.push(file);
      return base.lstat(file);
    },
    opendir: async (dir) => {
      seen.opendir.push(dir);
      const listing = await base.opendir(dir);
      return {
        read: async () => {
          const next = await listing.read();
          if (next !== null) seen.names += 1;
          return next;
        },
        close: () => listing.close(),
      };
    },
  };
  return { reads, seen };
}

/** A listing of exactly `names`, in that order: a folder no disk of this host can hold. */
function listingOf(names: readonly string[]): FolderListing {
  let at = 0;
  return {
    read: async () => (at < names.length ? { name: names[at++] ?? "" } : null),
    close: async () => {},
  };
}

/** Node's reads, except that listing `dir` yields `names` instead of what is on disk. */
function listingAt(dir: string, names: readonly string[]): BundleReads {
  return { lstat, opendir: async (each) => (each === dir ? listingOf(names) : opendir(each)) };
}

/** A build output: a few files and folders, and a folder outside it that links may lead to. */
async function outputTree(): Promise<{ root: string; outside: string; parent: string }> {
  const parent = await tmpDir("bundle-walk-");
  const root = path.join(parent, "out");
  const outside = path.join(parent, "outside");
  await mkdir(path.join(root, "assets", "levels"), { recursive: true });
  await mkdir(path.join(root, "empty"));
  await mkdir(outside);
  await writeFile(path.join(root, "game"), "game bytes");
  await writeFile(path.join(root, "assets", "sprite.png"), "png");
  await writeFile(path.join(root, "assets", "levels", "one.json"), "{}");
  await writeFile(path.join(outside, "secret.txt"), "not for the bundle");
  return { root, outside, parent };
}

/** One hostile folder: how it is arranged, the reads it is walked with, and the refusal it earns. */
interface HostileRow {
  name: string;
  posixOnly?: boolean;
  arrange: (tree: {
    root: string;
    outside: string;
  }) => Promise<{ reads?: BundleReads; close?: () => Promise<void> } | undefined>;
  limits?: Partial<WalkLimits>;
  problem: WalkProblem;
  path: string;
  /** Extra checks on what the walk read. */
  readCheck?: (seen: { lstat: string[]; opendir: string[]; names: number }, root: string) => void;
}

const DEEP = Array.from({ length: BUNDLE_WALK_LIMITS.depth }, (_, index) => `d${index}`);

const HOSTILE: HostileRow[] = [
  {
    name: `${BUNDLE_WALK_LIMITS.entries + 1} entries (the default cap)`,
    arrange: async ({ root }) => {
      const flat = path.join(root, "assets", "tiles");
      await mkdir(flat);
      const names = Array.from({ length: BUNDLE_WALK_LIMITS.entries + 1 }, (_, index) => `t${index}.png`);
      for (let start = 0; start < names.length; start += 500) {
        await Promise.all(names.slice(start, start + 500).map((name) => writeFile(path.join(flat, name), "")));
      }
      return undefined;
    },
    problem: WalkProblem.TooManyEntries,
    path: "assets/tiles",
    readCheck: (seen) => {
      assert.ok(seen.names <= BUNDLE_WALK_LIMITS.entries + 1, `read ${seen.names} names`);
      assert.ok(seen.lstat.length < 50, `lstat ${seen.lstat.length} times: entries past the cap were looked at`);
    },
  },
  {
    name: "an endless listing, stopped one name past a small cap",
    arrange: async ({ root }) => ({ reads: listingAt(root, Array(5000).fill("same")) }),
    limits: { entries: 50 },
    problem: WalkProblem.TooManyEntries,
    path: ".",
    readCheck: (seen) => {
      assert.equal(seen.names, 51);
      assert.equal(seen.lstat.length, 1, "only the root was looked at");
    },
  },
  {
    name: `a file ${BUNDLE_WALK_LIMITS.depth + 1} segments deep (the default cap)`,
    arrange: async ({ root }) => {
      await mkdir(path.join(root, ...DEEP), { recursive: true });
      await writeFile(path.join(root, ...DEEP, "x.png"), "png");
      return undefined;
    },
    problem: WalkProblem.TooDeep,
    path: [...DEEP, "x.png"].join("/"),
    readCheck: (seen, root) => {
      assert.ok(!seen.lstat.includes(path.join(root, ...DEEP, "x.png")), "the too-deep entry was looked at");
    },
  },
  {
    name: "a folder deeper than a small cap, never listed",
    arrange: async ({ root }) => {
      await mkdir(path.join(root, "assets", "a", "b", "c", "d"), { recursive: true });
      return undefined;
    },
    limits: { depth: 3 },
    problem: WalkProblem.TooDeep,
    path: "assets/a/b/c",
    readCheck: (seen, root) => {
      assert.ok(!seen.opendir.includes(path.join(root, "assets", "a", "b", "c")), "the too-deep folder was listed");
    },
  },
  {
    name: "a FIFO (never opened)",
    posixOnly: true,
    arrange: async ({ root }) => {
      const pipe = path.join(root, "assets", "pipe");
      execFileSync("/usr/bin/mkfifo", [pipe]);
      let opened = false;
      // A writer's open completes only once a reader opens the FIFO: only if the walk opened it.
      const writer = open(pipe, "w").then((handle) => {
        opened = true;
        return handle;
      });
      return {
        close: async () => {
          assert.equal(opened, false, "the walk opened the FIFO");
          const reader: FileHandle = await open(pipe, FS.O_RDONLY | FS.O_NONBLOCK);
          await (await writer).close();
          await reader.close();
        },
      };
    },
    problem: WalkProblem.Special,
    path: "assets/pipe",
  },
  {
    name: "a socket",
    posixOnly: true,
    arrange: async ({ root }) => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(path.join(root, "assets", "s.sock"), resolve));
      return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    },
    problem: WalkProblem.Special,
    path: "assets/s.sock",
  },
  {
    name: "a device node",
    posixOnly: true,
    arrange: async ({ root }) => {
      const node = path.join(root, "assets", "tty");
      await writeFile(node, "");
      return { reads: { opendir, lstat: (file) => lstat(file === node ? "/dev/null" : file) } };
    },
    problem: WalkProblem.Special,
    path: "assets/tty",
  },
  {
    name: "a symlinked folder (never listed, nor its target)",
    posixOnly: true,
    arrange: async ({ root, outside }) => {
      await symlink(outside, path.join(root, "assets", "more"));
      return undefined;
    },
    problem: WalkProblem.Symlink,
    path: "assets/more",
    readCheck: (seen, root) => {
      const listed = seen.opendir.filter((dir) => dir.includes("more") || dir.includes("outside"));
      assert.deepEqual(listed, [], `listed ${listed.join(", ")} under ${root}`);
    },
  },
  {
    name: "a symlinked file",
    posixOnly: true,
    arrange: async ({ root, outside }) => {
      await symlink(path.join(outside, "secret.txt"), path.join(root, "assets", "secret.txt"));
      return undefined;
    },
    problem: WalkProblem.Symlink,
    path: "assets/secret.txt",
  },
  {
    name: "a hard-linked file",
    arrange: async ({ root, outside }) => {
      await link(path.join(outside, "secret.txt"), path.join(root, "assets", "levels", "two.json"));
      return undefined;
    },
    problem: WalkProblem.HardLink,
    path: "assets/levels/two.json",
  },
  {
    name: "two names differing only by case",
    arrange: async ({ root }) => ({
      reads: listingAt(path.join(root, "assets"), ["Sprite.png", "levels", "sprite.png"]),
    }),
    problem: WalkProblem.CaseTwin,
    path: "assets/sprite.png",
    readCheck: (seen, root) => {
      assert.ok(
        !seen.lstat.some((file) => file.startsWith(path.join(root, "assets") + path.sep)),
        "a twin was looked at",
      );
    },
  },
  {
    name: "two names differing only by Unicode form (NFC and NFD)",
    arrange: async ({ root }) => ({
      reads: listingAt(path.join(root, "assets"), ["caf\u00e9.png", "levels", "cafe\u0301.png"]),
    }),
    problem: WalkProblem.CaseTwin,
    path: "assets/caf\u00e9.png",
  },
  {
    name: "two folders differing only by case",
    arrange: async ({ root }) => ({ reads: listingAt(root, ["ASSETS", "assets", "game"]) }),
    problem: WalkProblem.CaseTwin,
    path: "assets",
  },
  ...["..", ".", "", "a/b", "a\0b"].map(
    (name): HostileRow => ({
      name: `a listed name no folder can hold: ${JSON.stringify(name)}`,
      arrange: async ({ root }) => ({ reads: listingAt(path.join(root, "assets"), ["levels", name]) }),
      problem: WalkProblem.BadName,
      path: `assets/${name}`,
    }),
  ),
  {
    name: "a folder swapped for another while it was listed",
    arrange: async ({ root, outside }) => {
      const assets = path.join(root, "assets");
      let looks = 0;
      return {
        reads: {
          opendir,
          lstat: async (file) => {
            if (file !== assets) return lstat(file);
            looks += 1;
            return lstat(looks > 1 ? outside : file);
          },
        },
      };
    },
    problem: WalkProblem.Swapped,
    path: "assets",
  },
  {
    name: "a root that is a link",
    posixOnly: true,
    arrange: async ({ root, outside }) => {
      const alias = path.join(outside, "alias");
      await symlink(root, alias);
      return { reads: { opendir, lstat: (file) => lstat(file === root ? alias : file) } };
    },
    problem: WalkProblem.Symlink,
    path: ".",
  },
  {
    name: "a root that is a file",
    arrange: async ({ root }) => ({
      reads: { opendir, lstat: (file) => lstat(file === root ? path.join(root, "game") : file) },
    }),
    problem: WalkProblem.NotAFolder,
    path: ".",
  },
  {
    name: "a root that is missing",
    arrange: async ({ root }) => ({
      reads: { opendir, lstat: (file) => lstat(file === root ? `${root}-missing` : file) },
    }),
    problem: WalkProblem.NotAFolder,
    path: ".",
  },
  {
    name: "a folder that cannot be listed",
    arrange: async ({ root }) => ({
      reads: {
        lstat,
        opendir: async (dir) => {
          if (dir === path.join(root, "assets")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return opendir(dir);
        },
      },
    }),
    problem: WalkProblem.Unreadable,
    path: "assets",
  },
];

describe("walkBundle: one bounded, no-follow walk", () => {
  it("lists a tree depth first in name order, with each entry's kind, links and size from lstat", async () => {
    const { root } = await outputTree();
    const before = await snapshot(root);
    const walk = await walkBundle(root);
    assert.ok(walk.ok, JSON.stringify(walk));
    assert.deepEqual(
      walk.entries.map((entry) => [entry.path, entry.kind, entry.links, entry.kind === WalkKind.File ? entry.size : 0]),
      [
        ["assets", WalkKind.Directory, (await lstat(path.join(root, "assets"))).nlink, 0],
        ["assets/levels", WalkKind.Directory, (await lstat(path.join(root, "assets", "levels"))).nlink, 0],
        ["assets/levels/one.json", WalkKind.File, 1, 2],
        ["assets/sprite.png", WalkKind.File, 1, 3],
        ["empty", WalkKind.Directory, (await lstat(path.join(root, "empty"))).nlink, 0],
        ["game", WalkKind.File, 1, 10],
      ],
    );
    const sprite = await lstat(path.join(root, "assets", "sprite.png"));
    const entry = walk.entries.find((each) => each.path === "assets/sprite.png");
    assert.deepEqual([entry?.dev, entry?.ino], [sprite.dev, sprite.ino]);
    assert.deepEqual(await snapshot(root), before, "the walk changed the folder");
  });

  it("reports links, FIFOs, sockets, devices and hard links when asked to refuse none of them", {
    skip: !POSIX,
  }, async () => {
    const { root, outside } = await outputTree();
    await symlink(outside, path.join(root, "assets", "more"));
    execFileSync("/usr/bin/mkfifo", [path.join(root, "assets", "pipe")]);
    await link(path.join(outside, "secret.txt"), path.join(root, "assets", "twice.txt"));
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(root, "assets", "s.sock"), resolve));
    const tty = path.join(root, "assets", "tty");
    await writeFile(tty, "");
    try {
      const { reads, seen } = counted({ opendir, lstat: (file) => lstat(file === tty ? "/dev/null" : file) });
      const walk = await walkBundle(root, { reads, refuse: WALK_REPORT_ONLY });
      assert.ok(walk.ok, JSON.stringify(walk));
      const kinds = Object.fromEntries(walk.entries.map((entry) => [entry.path, entry.kind]));
      assert.equal(kinds["assets/more"], WalkKind.Symlink);
      assert.equal(kinds["assets/pipe"], WalkKind.Fifo);
      assert.equal(kinds["assets/s.sock"], WalkKind.Socket);
      assert.equal(kinds["assets/tty"], WalkKind.Device);
      assert.equal(walk.entries.find((entry) => entry.path === "assets/twice.txt")?.links, 2);
      assert.ok(!seen.opendir.some((dir) => dir.endsWith("more")), "the walk listed a linked folder");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  for (const row of HOSTILE) {
    it(`refuses ${row.name}, reading nothing past it and writing nothing`, {
      skip: row.posixOnly && !POSIX,
    }, async () => {
      const tree = await outputTree();
      const arranged = await row.arrange(tree);
      const { reads, seen } = counted(arranged?.reads);
      try {
        const before = await snapshot(tree.parent);
        const walk = await walkBundle(tree.root, { reads, limits: row.limits });
        assert.equal(walk.ok, false, `${row.name} was walked`);
        if (walk.ok) return;
        assert.deepEqual(
          { problem: walk.problem, path: walk.path },
          { problem: row.problem, path: row.path },
          walk.detail,
        );
        row.readCheck?.(seen, tree.root);
        assert.deepEqual(await snapshot(tree.parent), before, "the walk changed the folder");
      } finally {
        await arranged?.close?.();
      }
    });
  }

  it("never throws: a listing that fails mid-way is a refusal", async () => {
    const { root } = await outputTree();
    const failing: FolderListing = {
      read: async () => {
        throw new Error("EIO");
      },
      close: async () => {},
    };
    const walk = await walkBundle(root, { reads: { lstat, opendir: async () => failing } });
    assert.deepEqual(walk.ok ? null : [walk.problem, walk.path], [WalkProblem.Unreadable, "."]);
  });
});

describe("openBundleFile: a link behind a folder, or swapped in after the look", () => {
  it("refuses a FIFO under a linked folder as a link without opening it", { skip: !POSIX }, async () => {
    const tree = await outputTree();
    const fifos = path.join(tree.outside, "fifos");
    await mkdir(fifos);
    const pipe = path.join(fifos, "pipe");
    execFileSync("/usr/bin/mkfifo", [pipe]);
    await symlink(fifos, path.join(tree.root, "assets", "more"));
    let opened = false;
    // A writer's open completes only once a reader opens the FIFO: only if the open went through the link.
    const writer = open(pipe, "w").then((handle) => {
      opened = true;
      return handle;
    });
    try {
      const result = await openBundleFile(tree.root, "assets/more/pipe");
      if (result.ok) await result.handle.close();
      assert.equal(result.ok ? null : result.problem, WalkProblem.Symlink);
      assert.equal(opened, false, "the FIFO behind the linked folder was opened");
    } finally {
      const reader = await open(pipe, FS.O_RDONLY | FS.O_NONBLOCK);
      await (await writer).close();
      await reader.close();
    }
  });

  it("refuses a folder swapped for a link after it was looked at, by the file's real path", {
    skip: !POSIX,
  }, async () => {
    const tree = await outputTree();
    const levels = path.join(tree.root, "assets", "levels");
    const stand = path.join(tree.parent, "stand-in");
    await mkdir(stand);
    await writeFile(path.join(tree.outside, "one.json"), "{}");
    await rm(levels, { recursive: true });
    await symlink(tree.outside, levels);
    // The swap lands between the look and the open: the look still sees a plain folder there.
    const looked: string[] = [];
    const look = async (file: string) => {
      looked.push(file);
      return lstat(file === levels ? stand : file);
    };
    const before = await snapshot(tree.parent);
    const result = await openBundleFile(tree.root, "assets/levels/one.json", { lstat: look });
    if (result.ok) await result.handle.close();
    assert.ok(looked.includes(levels), "the injected look was not used");
    assert.equal(result.ok ? null : result.problem, WalkProblem.Symlink, "a file through a swapped-in link was opened");
    assert.deepEqual(await snapshot(tree.parent), before);
  });
});

describe("openBundleFile: one file under the root, never through a link", () => {
  it("opens a regular file and hands back its handle and stats", async () => {
    const { root } = await outputTree();
    const opened = await openBundleFile(root, "assets/levels/one.json");
    assert.ok(opened.ok, JSON.stringify(opened));
    try {
      assert.equal(opened.info.size, 2);
      assert.equal((await opened.handle.readFile()).toString(), "{}");
    } finally {
      await opened.handle.close();
    }
  });

  const rows: Array<{
    name: string;
    posixOnly?: boolean;
    arrange: (tree: { root: string; outside: string }) => Promise<void>;
    relative: string;
    problem: WalkProblem;
  }> = [
    {
      name: "a file that is a link",
      posixOnly: true,
      arrange: async ({ root, outside }) =>
        symlink(path.join(outside, "secret.txt"), path.join(root, "assets", "s.txt")),
      relative: "assets/s.txt",
      problem: WalkProblem.Symlink,
    },
    {
      name: "a file under a linked folder",
      posixOnly: true,
      arrange: async ({ root, outside }) => symlink(outside, path.join(root, "assets", "more")),
      relative: "assets/more/secret.txt",
      problem: WalkProblem.Symlink,
    },
    {
      name: "a FIFO (opened without blocking, refused)",
      posixOnly: true,
      arrange: async ({ root }) => {
        execFileSync("/usr/bin/mkfifo", [path.join(root, "assets", "pipe")]);
      },
      relative: "assets/pipe",
      problem: WalkProblem.Special,
    },
    {
      name: "a folder",
      posixOnly: true,
      arrange: async () => {},
      relative: "assets/levels",
      problem: WalkProblem.Special,
    },
    { name: "a missing file", arrange: async () => {}, relative: "assets/nope.png", problem: WalkProblem.Unreadable },
    { name: "a file under a file", arrange: async () => {}, relative: "game/x", problem: WalkProblem.Unreadable },
    ...["../outside/secret.txt", "", "/etc/hosts", "assets//sprite.png", "assets/./sprite.png", "a\0b"].map(
      (relative) => ({
        name: `the path ${JSON.stringify(relative)}`,
        arrange: async () => {},
        relative,
        problem: WalkProblem.BadName,
      }),
    ),
  ];
  for (const row of rows) {
    it(`refuses ${row.name}, writing nothing`, { skip: row.posixOnly && !POSIX }, async () => {
      const tree = await outputTree();
      await row.arrange(tree);
      const before = await snapshot(tree.parent);
      const opened = await openBundleFile(tree.root, row.relative);
      if (opened.ok) await opened.handle.close();
      assert.equal(opened.ok ? null : opened.problem, row.problem, JSON.stringify(opened.ok ? opened.info : opened));
      assert.deepEqual(await snapshot(tree.parent), before);
    });
  }
});
