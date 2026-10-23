/**
 * The workspace's stack split (M1.2). What the Three.js and C++ · raylib paths write and export is
 * characterized by digest, recorded before the split, so the split changes none of it; a Rust ·
 * wgpu folder is its own kind and never the studio's template; and a kind only a newer Genex knows
 * opens read-only (`kind-unsupported`) with nothing written into it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ExportError, ExportRefusal } from "../../src/shared/game-export-contract.ts";
import {
  BuildTarget,
  GameStack,
  GameValidationCode,
  ContractWord,
  declaresMouseLook,
  ProjectKind,
  stackOf,
} from "../../src/shared/game-project.ts";
import { DestinationBadge, TargetRefusal } from "../../src/shared/game-targets.ts";
import type { DestinationCheck } from "../../src/shared/native-contract.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";
import {
  DestinationError,
  detectProjectShape,
  findGameRoot,
  GameWorkspaces,
  RUST_SHAPE,
  readProjectShape,
  TEMPLATE_SHAPE,
  ScaffoldCaller,
} from "../../src/substrate/game-workspace.ts";
import { validateGameDir } from "../../src/substrate/game-validation.ts";
import { readGameDestinations } from "../../src/substrate/project-shape.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Digests of what the pre-M1 workspace wrote and exported for the fixture games below. */
const PRE_M1 = {
  threeScaffold: "ce0774cd5a353620",
  threeExport: "f39c3362c4717a73",
  raylibScaffold: "f34b145cdb4e281f",
  raylibExport: "be7ef8afd1252577",
  raylibAdopted: "ab01503006435f73",
  ownAdopted: "9d642945cbed77c0",
} as const;

/** A title every escaping rule has to handle: quotes, markup, a backslash and a `?` pair. */
const AWKWARD_TITLE = 'Pong "Deluxe" <1> \\ ??';

/** A fixture template: a few files, each carrying the title placeholder where the real one does. */
type TemplateFiles = Record<string, string>;

const THREE_TEMPLATE: TemplateFiles = {
  "index.html":
    '<!doctype html><title>__GAME_TITLE__</title><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><script type="module" src="./src/main.js"></script>\n',
  "src/main.js": 'import * as THREE from "three";\nimport { installStudio } from "./studio.js";\ninstallStudio({});\n',
  "src/studio.js": "export function installStudio() { window.__studio = {}; }\n",
  "NOTES.md": "# __GAME_TITLE__\n\nEmpty project.\n",
  "CLAUDE.md": "# Template rules\n",
  "CLAUDE.own.md": "Entry __ENTRY_MAIN__ served at __SERVED_ENTRY__; __BUILD_LINE__.\n__BUILD_RULE__",
  "NOTES.own.md": "# __GAME_TITLE__\n\n__SEEDED_PITCH__\n\n__CURRENT_STATE__\n",
  "docs/CONTRACT.md": "No build step, no package manager, no network.\n",
  "assets/.keep": "",
};

const CPP_TEMPLATE: TemplateFiles = {
  "CMakeLists.txt": `include("\${GENEX_CMAKE}")\ngenex_add_game(game src/main.cpp)\n`,
  "src/main.cpp": '#include "studio.h"\nint main() { studio::install({ .title = "__GAME_TITLE__" }); }\n',
  "src/studio.h": "namespace studio { void install(...); }\n",
  "web/shell.html": "<!doctype html><title>__GAME_TITLE__</title>\n",
  "NOTES.md": "# __GAME_TITLE__\n",
  "CLAUDE.md": "# C++ template rules\n",
  "CLAUDE.own.md": "C++ entry __ENTRY_MAIN__; __BUILD_LINE__.\n",
  "NOTES.own.md": "# __GAME_TITLE__\n\n__SEEDED_PITCH__\n\n__CURRENT_STATE__\n",
  "docs/CONTRACT.md": "The C++ contract.\n",
  "docs/STUDIO_API.md": "studio::install, studio::tag.\n",
};

const RUST_TEMPLATE: TemplateFiles = {
  "genex.toml": '[game]\ntitle = "__GAME_TITLE__"\n',
  "src/main.rs":
    'use genex::prelude::*;\nmod game;\nfn main() {\n    let mut game = Game::new(game::World::default()).title("__GAME_TITLE__");\n    // FACET WIRING\n    genex::install(game);\n}\n',
  "src/game.rs": "#[derive(Default)]\npub struct World;\n",
  "web/shell.html": "<!doctype html><title>__GAME_TITLE__</title>\n",
  "NOTES.md": "# __GAME_TITLE__\n",
  "CLAUDE.md": "# Rust template rules\n",
  "CLAUDE.own.md": "Rust entry __ENTRY_MAIN__; __BUILD_LINE__.\n",
  "NOTES.own.md": "# __GAME_TITLE__\n\n__SEEDED_PITCH__\n\n__CURRENT_STATE__\n",
  "docs/CONTRACT.md": "The Rust contract.\n",
  "docs/GENEX_API.md": "The genex facade, read-only.\n",
};

/** The checked-in Rust folder: genex.toml, src/main.rs and src/game.rs, nothing else. */
const RUST_FIXTURE = path.resolve(import.meta.dirname, "../fixtures/rust-wgpu-min");

async function writeFiles(dir: string, files: TemplateFiles): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

/** A library over fixture templates, so a digest moves only when the workspace's own behavior does. */
async function library(options: Record<string, unknown> = {}) {
  const base = await tmpDir("studio-workspace-split-");
  const templates = path.join(base, "templates");
  await writeFiles(path.join(templates, "game-template"), THREE_TEMPLATE);
  await writeFiles(path.join(templates, "game-template-cpp"), CPP_TEMPLATE);
  await writeFiles(path.join(templates, "game-template-rust"), RUST_TEMPLATE);
  const vendorDir = path.join(base, "vendor");
  await writeFiles(vendorDir, { "three.module.js": "export const REVISION = '0';\n" });
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(templates, "game-template"),
    vendorDir,
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: "darwin",
    ...options,
  });
  return { games, base, templates };
}

/** Every file under `dir` but git's own, `/`-separated and sorted. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (child === ".git") continue;
    if (entry.isDirectory()) files.push(...(await filesUnder(dir, child)));
    else files.push(child);
  }
  return files.sort();
}

/** One digest of a folder's files and bytes; studio.json's `createdAt` (the clock) is left out. */
async function treeDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of await filesUnder(dir)) {
    let bytes = await readFile(path.join(dir, rel));
    if (rel === "studio.json") {
      const { createdAt: _clock, ...rest } = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      bytes = Buffer.from(JSON.stringify(rest));
    }
    hash.update(`${rel}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** A raylib folder the studio did not scaffold: its own CMake project and entry. */
async function ownRaylibFolder(dir: string): Promise<void> {
  await writeFiles(dir, {
    "CMakeLists.txt":
      "cmake_minimum_required(VERSION 3.20)\nfind_package(raylib REQUIRED)\nadd_executable(g main.cpp)\n",
    "src/main.cpp": "int main() { return 0; }\n",
    "README.md": "A raylib toy somebody wrote.\n",
  });
}

/** A browser game of its own: a page, an entry, no build. */
async function ownBrowserFolder(dir: string): Promise<void> {
  await writeFiles(dir, {
    "index.html": '<!doctype html><canvas></canvas><script type="module" src="./game.js"></script>\n',
    "game.js": 'const ctx = document.querySelector("canvas").getContext("2d");\nctx.fillRect(0, 0, 1, 1);\n',
    "README.md": "A canvas toy.\n",
  });
}

describe("the pre-M1 characterization", () => {
  it("a Three.js game is scaffolded and exported exactly as before", async () => {
    const { games, base } = await library();
    // A new game is empty until its first message picks its kind; the web starter is the Three.js game.
    const made = await games.create(AWKWARD_TITLE);
    const game = await games.start(made.name, ProjectStarter.Web);
    assert.equal(game.shape.kind, ProjectKind.StudioTemplate);
    const out = path.join(base, "out-three");
    await games.export(game.name, out);
    assert.equal(await treeDigest(game.dir), PRE_M1.threeScaffold);
    assert.equal(await treeDigest(out), PRE_M1.threeExport);
  });

  // Flipped (M6.0): bare desktop targets no longer imply raylib, so the characterization names its stack.
  it("a C++ · raylib game is still scaffolded and exported exactly as before", async () => {
    const { games, base } = await library();
    const game = await games.create(AWKWARD_TITLE, {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    assert.equal(game.shape.kind, ProjectKind.RaylibCpp);
    assert.equal(stackOf(game.shape), GameStack.RaylibCpp);
    assert.deepEqual(game.destinations, { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] });
    await assert.rejects(
      games.export(game.name, path.join(base, "unbuilt")),
      (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.BuildFailed,
    );
    const built = path.join(base, "built");
    await writeFiles(built, { "index.html": "<!doctype html><script src=game.js></script>\n", "game.js": "1;\n" });
    const out = path.join(base, "out-raylib");
    await games.export(game.name, out, built);
    assert.equal(await treeDigest(game.dir), PRE_M1.raylibScaffold);
    assert.equal(await treeDigest(out), PRE_M1.raylibExport);
  });

  it("adopting a raylib folder and a browser game of its own writes exactly what it did", async () => {
    const { games, base } = await library();
    const raylib = path.join(base, "toy");
    await ownRaylibFolder(raylib);
    const planned = await games.plannedWrites(raylib);
    const adopted = await games.adopt(raylib);
    assert.equal(adopted.shape.kind, ProjectKind.RaylibCpp);
    assert.deepEqual(planned, ["docs/STUDIO_API.md", "CLAUDE.md", "NOTES.md", "studio.json", ".gitignore", ".git"]);
    const own = path.join(base, "canvas");
    await ownBrowserFolder(own);
    const ownPlanned = await games.plannedWrites(own);
    const ownGame = await games.adopt(own);
    assert.equal(ownGame.shape.kind, ProjectKind.Canvas2d);
    const ownWrites = ["assets/.keep", "src/studio.js", "CLAUDE.md", "NOTES.md", "studio.json", ".gitignore", ".git"];
    assert.deepEqual(ownPlanned, ownWrites);
    assert.equal(await treeDigest(raylib), PRE_M1.raylibAdopted);
    assert.equal(await treeDigest(own), PRE_M1.ownAdopted);
  });
});

/** A copy of the Rust fixture at `dir`, with `studio` written as its studio.json when given. */
async function rustFolder(dir: string, studio?: Record<string, unknown>): Promise<string> {
  await cp(RUST_FIXTURE, dir, { recursive: true });
  if (studio) await writeFile(path.join(dir, "studio.json"), JSON.stringify(studio));
  return dir;
}

const refusedWith = (code: string) => (error: unknown) => error instanceof DestinationError && error.code === code;

describe("a Rust · wgpu folder", () => {
  it("is detected as rust-wgpu, never the studio's template, whatever studio.json records beside it", async () => {
    const base = await tmpDir("studio-rust-shape-");
    const rows: Array<[string, Record<string, unknown> | undefined]> = [
      ["bare", undefined],
      ["template-marker", { contractVersion: 1 }],
      [
        "claims-a-vite-build",
        { entry: "dist/index.html", main: "src/main.ts", build: "npm run build", own: true, kind: "three-vite" },
      ],
      ["claims-raylib-stack", { stack: GameStack.RaylibCpp }],
    ];
    for (const [name, studio] of rows) {
      const dir = await rustFolder(path.join(base, name), studio);
      const shape = await readProjectShape(dir);
      assert.deepEqual(shape, RUST_SHAPE, name);
      assert.equal(stackOf(shape), GameStack.RustWgpu, name);
      assert.notEqual(shape.kind, TEMPLATE_SHAPE.kind, name);
    }
    assert.deepEqual(await detectProjectShape(path.join(base, "bare")), RUST_SHAPE);
    assert.deepEqual(RUST_SHAPE, {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    });
  });

  it("is read by the name of its genex.toml alone: a link, a FIFO or a folder there is never opened", async () => {
    const base = await tmpDir("studio-rust-hostile-");
    const outside = path.join(base, "outside.toml");
    await writeFile(outside, "[game]\ntitle = 'stolen'\n");
    const plant: Record<string, (file: string) => Promise<void>> = {
      link: (file) => symlink(outside, file),
      dangling: (file) => symlink(path.join(base, "nowhere"), file),
      fifo: async (file) => {
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => execFile("mkfifo", [file], (e) => (e ? reject(e) : resolve())));
      },
      folder: (file) => mkdir(file).then(() => {}),
    };
    for (const [name, planted] of Object.entries(plant)) {
      if (name === "fifo" && process.platform === "win32") continue;
      const dir = await rustFolder(path.join(base, name));
      await rm(path.join(dir, "genex.toml"));
      await planted(path.join(dir, "genex.toml"));
      assert.equal((await readProjectShape(dir)).kind, ProjectKind.RustWgpu, name);
      const checked = await validateGameDir(dir);
      assert.equal(checked.ok, false, name);
      assert.ok(checked.codes.includes(GameValidationCode.MissingFile), name);
    }
    assert.equal(await readFile(outside, "utf8"), "[game]\ntitle = 'stolen'\n");
  });

  it("is validated by its own checks: genex.toml, the entry and genex::install in code", async () => {
    const base = await tmpDir("studio-rust-validate-");
    const fine = await validateGameDir(await rustFolder(path.join(base, "fine")));
    assert.deepEqual([fine.ok, fine.codes, fine.contract, fine.problems], [true, [], ContractWord.Loaded, []]);

    const commented = await rustFolder(path.join(base, "commented"));
    await writeFile(
      path.join(commented, "src/main.rs"),
      'fn main() {\n    // genex::install(game);\n    /* genex::install( /* nested */ game) */\n    let s = "genex::install(";\n    let r = r#"genex::install("#;\n    let c = \'"\';\n}\n',
    );
    const removed = await validateGameDir(commented);
    assert.equal(removed.contract, ContractWord.Missing);
    assert.deepEqual(removed.codes, [GameValidationCode.NativeContractRemoved]);

    const lost = await rustFolder(path.join(base, "lost"), { kind: ProjectKind.RustWgpu });
    await rm(path.join(lost, "genex.toml"));
    assert.equal((await readProjectShape(lost)).kind, ProjectKind.RustWgpu, "studio.json keeps a Rust game Rust");
    assert.deepEqual((await validateGameDir(lost)).codes, [GameValidationCode.MissingFile]);

    const contradicted = await rustFolder(path.join(base, "contradicted"), { stack: GameStack.RaylibCpp });
    assert.deepEqual((await validateGameDir(contradicted)).codes, [GameValidationCode.StackContradictsKind]);
  });

  it("refuses a build input of the game's own (cargo files, a build script, cargo configuration), never opening it", async () => {
    const base = await tmpDir("studio-rust-own-input-");
    const outside = path.join(base, "outside.toml");
    await writeFile(outside, "[package]\nname = 'elsewhere'\n");
    const plant: Array<[string, string, (file: string) => Promise<void>]> = [
      ["cargo-toml", "Cargo.toml", (file) => writeFile(file, '[package]\nname = "pond"\n')],
      ["cargo-lock", "Cargo.lock", (file) => writeFile(file, "version = 4\n")],
      ["build-script", "build.rs", (file) => writeFile(file, "fn main() {}\n")],
      ["cargo-config", ".cargo", (file) => mkdir(file).then(() => writeFile(path.join(file, "config.toml"), ""))],
      ["linked-manifest", "Cargo.toml", (file) => symlink(outside, file)],
      ["dangling-build-script", "build.rs", (file) => symlink(path.join(base, "nowhere"), file)],
      [
        "fifo-build-script",
        "build.rs",
        async (file) => {
          const { execFile } = await import("node:child_process");
          await new Promise<void>((resolve, reject) => execFile("mkfifo", [file], (e) => (e ? reject(e) : resolve())));
        },
      ],
    ];
    for (const [name, rel, planted] of plant) {
      if (name.startsWith("fifo") && process.platform === "win32") continue;
      const dir = await rustFolder(path.join(base, name));
      await planted(path.join(dir, rel));
      const checked = await validateGameDir(dir);
      assert.equal(checked.ok, false, name);
      assert.deepEqual(checked.codes, [GameValidationCode.RustOwnBuildInput], name);
      assert.ok(checked.problems[0]?.startsWith(rel), name);
      assert.equal(checked.contract, ContractWord.Loaded, `${name}: the entry still installs genex`);
    }
    assert.equal(await readFile(outside, "utf8"), "[package]\nname = 'elsewhere'\n", "nothing outside was touched");
  });
});

describe("a Rust · wgpu folder among others", () => {
  it("is a candidate in a picked folder, found by its genex.toml", async () => {
    const base = await tmpDir("studio-rust-root-");
    await rustFolder(path.join(base, "pond"));
    const found = await findGameRoot(base);
    assert.deepEqual(
      found.map(({ rel, shape, why }) => ({ rel, kind: shape.kind, why })),
      [{ rel: "pond", kind: ProjectKind.RustWgpu, why: ["genex.toml"] }],
    );
  });

  it("keeps the phone destinations studio.json names; a raylib game still reads them as unknown", async () => {
    const base = await tmpDir("studio-rust-targets-");
    const targets = [BuildTarget.Android, BuildTarget.Web, BuildTarget.Ios];
    const rust = await rustFolder(path.join(base, "rust"), { targets });
    const reading = await readGameDestinations(rust, RUST_SHAPE, null);
    assert.deepEqual(reading.destinations, {
      stack: GameStack.RustWgpu,
      targets: [BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android],
    });
    assert.deepEqual(reading.warnings, []);
    const raylib = path.join(base, "raylib");
    await ownRaylibFolder(raylib);
    await writeFile(path.join(raylib, "studio.json"), JSON.stringify({ targets }));
    const old = await readGameDestinations(raylib, await readProjectShape(raylib), null);
    assert.deepEqual(old.destinations.targets, [BuildTarget.Web]);
    assert.equal(old.warnings.length, 1);
  });
});

describe("a Rust · wgpu game in the library", () => {
  it("is adopted with no JavaScript or C++ scaffold, its own files untouched, and the writes it promised", async () => {
    const { games, base } = await library();
    const dir = await rustFolder(path.join(base, "pond"));
    const before = await readFile(path.join(dir, "src/main.rs"), "utf8");
    const planned = await games.plannedWrites(dir);
    const filesBefore = await filesUnder(dir);
    const game = await games.adopt(dir);
    assert.equal(game.shape.kind, ProjectKind.RustWgpu);
    assert.deepEqual(game.destinations, { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] });
    const added = (await filesUnder(dir)).filter((file) => !filesBefore.includes(file));
    assert.deepEqual(planned, ["docs/GENEX_API.md", "CLAUDE.md", "NOTES.md", "studio.json", ".gitignore", ".git"]);
    // `references/README.md` lands in every adopted folder and is not on any stack's list (as before the split).
    const promised = [...planned.filter((file) => file !== ".git"), "references/README.md"];
    assert.deepEqual(added.sort(), promised.sort());
    for (const never of ["index.html", "src/main.js", "CMakeLists.txt", "src/main.cpp", "web/shell.html"])
      assert.equal(added.includes(never), false, never);
    assert.equal(await readFile(path.join(dir, "src/main.rs"), "utf8"), before);
    const studio = JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8")) as Record<string, unknown>;
    assert.equal(studio.stack, GameStack.RustWgpu);
    assert.equal(studio.kind, ProjectKind.RustWgpu);
    assert.equal(studio.own, false);
    assert.match(await readFile(path.join(dir, "NOTES.md"), "utf8"), /Rust toolchain/);
  });

  // Flipped (M1 review): writeNativeLock refused a Rust game until its lock line could be recorded;
  // a compiled game now records its own stack's lock, which retention keeps (`nativeLocks`).
  it("gets a Mac bundle id, desktop checks and its recorded lock as a compiled game", async () => {
    const { games, base } = await library();
    const game = await games.adopt(await rustFolder(path.join(base, "pond")));
    assert.match(await games.bundleIdFor(game.name), /^games\.genex\.game\.[0-9a-f]{12}$/);
    const check: DestinationCheck = {
      badge: DestinationBadge.NotRunHere,
      lock: "0123456789ab",
      at: "2026-10-06T00:00:00.000Z",
    };
    await games.writeNativeCheck(game.name, BuildTarget.Mac, check);
    const listed = (await games.list()).find((listedGame) => listedGame.name === game.name);
    assert.deepEqual(listed?.nativeChecks, { [BuildTarget.Mac]: check });
    await games.writeNativeLock(game.name, "a".repeat(64));
    assert.deepEqual(await games.nativeLocks(), ["a".repeat(64)], "the Rust game's lock is one retention keeps");
  });

  it("is created only behind the dev gate, from its own template, its title escaped for Rust and TOML", async () => {
    const gated = await library();
    await assert.rejects(
      gated.games.create("Pond", { stack: GameStack.RustWgpu }),
      refusedWith(TargetRefusal.StackGated),
    );

    const { games } = await library({ rustCreation: true });
    const title = 'Pond "Deluxe" \\ {1}';
    const game = await games.create(title, { stack: GameStack.RustWgpu, targets: [BuildTarget.Ios, BuildTarget.Web] });
    assert.deepEqual(game.shape, RUST_SHAPE);
    assert.deepEqual(game.destinations, { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Ios] });
    const main = await readFile(path.join(game.dir, "src/main.rs"), "utf8");
    assert.ok(main.includes('.title("Pond \\"Deluxe\\" \\\\ {1}")'), main);
    const toml = await readFile(path.join(game.dir, "genex.toml"), "utf8");
    assert.ok(toml.includes('title = "Pond \\"Deluxe\\" \\\\ {1}"'), toml);
    const studio = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      [studio.stack, studio.kind, studio.main],
      [GameStack.RustWgpu, ProjectKind.RustWgpu, "src/main.rs"],
    );

    const grown = await games.setDestinations(game.name, [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Android]);
    assert.deepEqual(grown.destinations?.targets, [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Android]);
    // Flipped (M6.0): desktop targets alone now mean Rust · wgpu, so behind the closed gate they are
    // refused like an explicit Rust choice, and with it open they make a Rust game.
    await assert.rejects(
      gated.games.create("Pong", { targets: [BuildTarget.Web, BuildTarget.Mac] }),
      refusedWith(TargetRefusal.StackGated),
    );
    const desktop = await games.create("Pong", { targets: [BuildTarget.Web, BuildTarget.Mac] });
    assert.equal(desktop.shape.kind, ProjectKind.RustWgpu);
    // Destinations never change the stack: a raylib game never grows a phone.
    const raylib = await games.create("Breakout", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Mac],
    });
    await assert.rejects(games.setDestinations(raylib.name, [BuildTarget.Web, BuildTarget.Ios]), /destinations/);
  });
});

describe("a kind only a newer Genex knows", () => {
  /** A folder a newer Genex made: a kind and stack this one does not know, and a build it must never run. */
  async function newerGame(dir: string): Promise<string> {
    await writeFiles(dir, {
      "studio.json": JSON.stringify({
        name: "fjord",
        title: "Fjord",
        contractVersion: 1,
        kind: "rust-bevy",
        stack: "rust-bevy",
        entry: "index.html",
        main: "src/main.rs",
        build: "cargo run",
        install: "npm install",
        own: false,
      }),
      "src/main.rs": "fn main() {}\n",
      "Bevy.toml": "[game]\n",
    });
    return dir;
  }

  it("opens read-only with kind-unsupported, never as the template and never with its build", async () => {
    const base = await tmpDir("studio-newer-shape-");
    const shape = await readProjectShape(await newerGame(path.join(base, "fjord")));
    assert.equal(shape.readOnly, TargetRefusal.KindUnsupported);
    assert.notEqual(shape.kind, ProjectKind.StudioTemplate);
    assert.deepEqual([shape.build, shape.install, shape.own], [null, null, true]);
    const checked = await validateGameDir(path.join(base, "fjord"));
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.codes, [GameValidationCode.KindUnsupported]);
    const found = await findGameRoot(base);
    assert.deepEqual(
      found.map(({ rel, why }) => ({ rel, why })),
      [{ rel: "fjord", why: ["studio.json"] }],
    );
  });

  it("is listed and opened, but nothing is written into it and nothing changes its destinations or exports it", async () => {
    const { games, base } = await library();
    const dir = await newerGame(path.join(base, "fjord"));
    const before = await treeDigest(dir);
    assert.deepEqual(await games.plannedWrites(dir), []);
    const game = await games.adopt(dir);
    assert.equal(game.shape.readOnly, TargetRefusal.KindUnsupported);
    assert.equal(await treeDigest(dir), before);
    assert.equal((await readdir(dir)).includes(".git"), false);
    await games.adopt(dir);
    assert.equal(await treeDigest(dir), before);
    assert.equal(await games.exists(game.name), true);
    await assert.rejects(
      games.setDestinations(game.name, [BuildTarget.Web]),
      refusedWith(TargetRefusal.KindUnsupported),
    );
    await assert.rejects(games.export(game.name, path.join(base, "out")), refusedWith(TargetRefusal.KindUnsupported));
    assert.equal(await treeDigest(dir), before);
  });

  it("leaves a kind an older studio retired to the folder's own evidence", async () => {
    const base = await tmpDir("studio-retired-kind-");
    const dir = path.join(base, "canvas");
    await ownBrowserFolder(dir);
    await writeFile(path.join(dir, "studio.json"), JSON.stringify({ kind: "unity-project" }));
    const shape = await readProjectShape(dir);
    assert.equal(shape.readOnly, undefined);
    assert.equal(shape.kind, ProjectKind.Canvas2d);
  });
});

describe("a game played with mouse look", () => {
  it("is listed with mouseLook from studio.json's game block, as the harness writes it", async () => {
    const { games } = await library();
    const game = await games.scaffold("ashen-horde", { title: "Ashen Horde" });
    assert.equal(game.mouseLook, undefined, "a new game declares nothing");
    const file = path.join(game.dir, "studio.json");
    const meta = JSON.parse(await readFile(file, "utf8"));
    const block = { kind: "first-person", hud: true, mouseLook: true, keyboardMove: true };
    await writeFile(file, JSON.stringify({ ...meta, game: block }));
    const listed = (await games.list()).find((item) => item.name === game.name);
    assert.equal(listed?.mouseLook, true);
  });

  it("only a plain true counts: anything else keeps the cursor free", () => {
    assert.equal(declaresMouseLook({ game: { mouseLook: true } }), true);
    for (const meta of [
      null,
      "game",
      {},
      { game: null },
      { game: "first-person" },
      { game: { mouseLook: "true" } },
      { game: { mouseLook: 1 } },
      { game: { kind: "top-down", mouseLook: false } },
      { mouseLook: true },
    ])
      assert.equal(declaresMouseLook(meta), false, JSON.stringify(meta));
  });
});
