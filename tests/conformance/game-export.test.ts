import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { copyFile, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CppBuilds } from "../../src/main/cpp-build.ts";
import { ExportError, ExportRefusal } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { ToolchainId, type ToolchainLock } from "../../src/shared/toolchain.ts";
import {
  excludedFromExport,
  exportPublicGame,
  fileWithSecret,
  resolveExportTarget,
  swapIntoPlace,
  WEB_SERVER_README,
} from "../../src/substrate/game-export.ts";
import { shellQuote } from "../../src/substrate/shell-quote.ts";
import type { LocatedToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

it("exports public runtime files without nested credentials or private directories; fails safely on symlinks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-"));
  const source = path.join(temp, "game"),
    target = path.join(temp, "public");
  try {
    await mkdir(path.join(source, "assets"), { recursive: true });
    await mkdir(path.join(source, "src"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(path.join(source, "assets/texture.png"), "fixture");
    for (const p of [
      ".env",
      "private.pem",
      "assets/.env",
      "assets/private.key",
      "assets/production.env",
      "src/env.local",
      "assets/keys.jks",
    ])
      await writeFile(path.join(source, p), "PRIVATE FIXTURE");
    const result = await exportPublicGame(source, target, ["index.html", "src", "assets", ".env", "private.pem"]);
    assert.deepEqual(result.included.sort(), ["assets/texture.png", "index.html", "src/main.js"]);
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "missing-public-file"]),
      /Selected public path is missing/,
    );
    assert.equal(await readFile(path.join(target, "assets/.env"), "utf8").catch(() => null), null);
    await symlink(path.join(source, ".env"), path.join(source, "assets/leak.txt"));
    await assert.rejects(exportPublicGame(source, target, ["index.html", "src", "assets"]), /symlink/);
    assert.match(await readFile(path.join(target, "index.html"), "utf8"), /main.js/);
    await assert.rejects(exportPublicGame(source, path.join(source, "export"), ["index.html"]), /outside/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("ships Studio's Genex SDK, with its licenses, only in a game that maps it", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-genex-"));
  const game = path.join(temp, "game"),
    vendor = path.join(temp, "vendor");
  try {
    await mkdir(game);
    await mkdir(path.join(vendor, "genex"), { recursive: true });
    await writeFile(path.join(vendor, "three.module.js"), "export const REVISION = 'test';");
    await writeFile(path.join(vendor, "three-LICENSE"), "three notice");
    await writeFile(path.join(vendor, "genex", "multiplayer.js"), 'export * from "./chunk-A.js";');
    await writeFile(path.join(vendor, "genex", "chunk-A.js"), "export const connect = () => {};");
    await writeFile(path.join(vendor, "genex", "embed-sdk.js"), "export const waitForPlayer = () => {};");
    await writeFile(path.join(vendor, "genex", "LICENSES.md"), "colyseus notice");
    await writeFile(path.join(vendor, "genex", "VERSION.json"), "{}");
    const page = (imports: Record<string, string>) =>
      `<script type="importmap">${JSON.stringify({ imports: { three: "/vendor/three.module.js", ...imports } })}</script><script type="module" src="./main.js"></script>`;
    await writeFile(path.join(game, "index.html"), page({}));
    await writeFile(path.join(game, "main.js"), 'import * as THREE from "three"; console.log(THREE);');
    const solo = await exportPublicGame(game, path.join(temp, "solo"), ["index.html", "main.js"], vendor);
    assert.deepEqual(
      solo.included.filter((rel) => rel.startsWith("vendor/genex/")),
      [],
      "a single-player game carries none of it, licenses included",
    );
    assert.ok(solo.included.includes("vendor/three-LICENSE"), "the vendor root's own notices stay");

    await writeFile(
      path.join(game, "index.html"),
      page({
        "@genex-ai/multiplayer": "/vendor/genex/multiplayer.js",
        "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk.js",
      }),
    );
    await writeFile(
      path.join(game, "main.js"),
      'import { connect } from "@genex-ai/multiplayer"; console.log(connect);',
    );
    const online = await exportPublicGame(game, path.join(temp, "online"), ["index.html", "main.js"], vendor);
    for (const rel of ["multiplayer.js", "chunk-A.js", "embed-sdk.js", "LICENSES.md", "VERSION.json"])
      assert.ok(online.included.includes(`vendor/genex/${rel}`), rel);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("validates module dependencies, ignores commented examples and keeps only reachable vendored files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-modules-"));
  const game = path.join(temp, "game"),
    vendor = path.join(temp, "vendor");
  try {
    await mkdir(game);
    await mkdir(vendor);
    await writeFile(
      path.join(game, "index.html"),
      '<script type="importmap">{"imports":{"engine":"/vendor/engine.js"}}</script><script type="module" src="./main.js"></script>',
    );
    await writeFile(
      path.join(game, "main.js"),
      '// import "./not-real.js";\nimport {value} from "engine"; console.log(value);',
    );
    await writeFile(path.join(vendor, "engine.js"), 'export {value} from "./part.js";');
    await writeFile(path.join(vendor, "part.js"), "export const value=1;");
    await writeFile(path.join(vendor, "unused.js"), 'import "./missing-example.js";');
    await writeFile(path.join(vendor, "LICENSE"), "notice");
    const result = await exportPublicGame(game, path.join(temp, "public"), ["index.html", "main.js"], vendor);
    assert.ok(result.included.includes("vendor/part.js"));
    assert.ok(result.included.includes("vendor/LICENSE"));
    assert.ok(!result.included.includes("vendor/unused.js"));
    await writeFile(path.join(game, "main.js"), 'import "./missing.js";');
    await assert.rejects(
      exportPublicGame(game, path.join(temp, "public"), ["index.html", "main.js"], vendor),
      /missing.js/,
    );
    assert.match(
      await readFile(path.join(temp, "public/main.js"), "utf8"),
      /not-real/,
      "a failed replacement preserves the last valid export",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("reads a page's script address as a file beside the page, as a Godot web export writes it", async () => {
  // Godot's shell loads `<script src="index.js">` and Genex's multiplayer bridge the same way: an
  // address in the page is a URL, never a bare module name for the import map.
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-scripts-"));
  const game = path.join(temp, "game");
  try {
    await mkdir(game);
    const page = (scripts: string[]) => scripts.map((src) => `<script src="${src}"></script>`).join("");
    await writeFile(path.join(game, "index.html"), page(["genex-multiplayer-bridge.js", "index.js"]));
    await writeFile(path.join(game, "genex-multiplayer-bridge.js"), '"use strict";(()=>{window.bridge=1})();');
    await writeFile(path.join(game, "index.js"), "var Engine=1;");
    const files = ["index.html", "genex-multiplayer-bridge.js", "index.js"];
    const result = await exportPublicGame(game, path.join(temp, "public"), files);
    assert.deepEqual([...result.included].sort(), [...files].sort());
    await writeFile(path.join(game, "index.html"), page(["index.js", "gone.js"]));
    await assert.rejects(
      exportPublicGame(game, path.join(temp, "public"), files),
      /missing a referenced public file: gone\.js in index\.html/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("refuses to export a file that holds a credential Studio knows, and leaves the last export in place (SEC-6)", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-secrets-"));
  const source = path.join(temp, "game"),
    target = path.join(temp, "public");
  const secret = "genex-FAKE-token-value";
  try {
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "assets"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(path.join(source, "assets/data.bin"), Buffer.from([1, 2, 3]));
    await exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, {
      secretValues: [secret, "short"],
    });
    await writeFile(path.join(source, "src/main.js"), `const KEY='${secret}';console.log("game")`);
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      (error: Error) => {
        assert.match(error.message, /src\/main\.js/);
        assert.equal(error.message.includes(secret), false, "the refusal does not repeat the value");
        return true;
      },
    );
    assert.equal(
      await readFile(path.join(target, "src/main.js"), "utf8"),
      'console.log("game")',
      "the previous export is untouched",
    );
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(
      path.join(source, "assets/data.bin"),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(secret), Buffer.from([2])]),
    );
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      /assets\/data\.bin/,
      "binary files are checked too",
    );
    const names = (await readdir(temp)).filter((n) => n.startsWith(".studio-export-"));
    assert.deepEqual(names, [], "no staging directory is left behind");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

const REPO = path.resolve(import.meta.dirname, "../..");
const EMCC_FIXTURE = path.join(REPO, "tests", "fixtures", "raylib-wasm");
const HOSTILE_FIXTURE = path.join(REPO, "tests", "fixtures", "raylib-wasm-hostile");
/** Emscripten's web output: the page, its classic glue, the module and the preloaded assets. */
const EMCC_FILES = ["index.data", "index.html", "index.js", "index.wasm"];
const HOSTILE_FILES = ["index.html", "index.js", "index.wasm"];
const POSIX_ONLY = process.platform === "win32" && "the stub toolchain is POSIX shell";
const MIB = 1024 * 1024;

/** A game folder holding copies of `files` from `fixture` (the fixtures stay untouched). */
async function gameFrom(fixture: string, files: string[]): Promise<string> {
  const game = path.join(await tmpDir("studio-export-emcc-"), "game");
  await mkdir(game);
  for (const file of files) await copyFile(path.join(fixture, file), path.join(game, file));
  return game;
}

/** The sha256 of a file's bytes. */
async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** The `.studio-export-*` staging folders left in `dir`. */
async function stagingLeft(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(".studio-export-"));
}

/** A small valid export in `temp`: the page and one module. */
async function plainGame(temp: string): Promise<string> {
  const game = path.join(temp, "game");
  await mkdir(path.join(game, "src"), { recursive: true });
  await writeFile(path.join(game, "index.html"), '<script type="module" src="./src/main.js"></script>');
  await writeFile(path.join(game, "src", "main.js"), 'console.log("game")');
  return game;
}

describe("export characterization (pins of today's behaviour)", () => {
  it("a failed export leaves no staging folder beside the target", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    await writeFile(path.join(game, "src", "main.js"), 'import "./missing.js";');
    await assert.rejects(exportPublicGame(game, path.join(temp, "public"), ["index.html", "src"]), /missing\.js/);
    assert.deepEqual(await stagingLeft(temp), []);
    assert.equal(existsSync(path.join(temp, "public")), false, "nothing was published");
  });

  // Only the first rename fails here: the restore after a failed second rename (the previous export
  // already moved aside) needs an injectable swap first, and its own row then.
  it("a swap that cannot move the previous export aside keeps it and leaves no staging folder", async (t) => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const target = path.join(temp, "public");
    await exportPublicGame(game, target, ["index.html", "src"]);
    const now = 1_790_000_000_000;
    t.mock.timers.enable({ apis: ["Date"], now });
    // Where the swap moves the previous export aside: a file there makes that move fail.
    await writeFile(`${target}.previous-${now}`, "in the way");
    await writeFile(path.join(game, "src", "main.js"), 'console.log("second")');
    await assert.rejects(exportPublicGame(game, target, ["index.html", "src"]));
    assert.equal(await readFile(path.join(target, "src", "main.js"), "utf8"), 'console.log("game")');
    assert.deepEqual(await stagingLeft(temp), []);
  });

  it("an occupied backup path is never replaced, even when it is an empty folder", async () => {
    const temp = await tmpDir("studio-export-backup-");
    const target = path.join(temp, "public");
    const staging = path.join(temp, "staging");
    const now = 1_790_000_000_000;
    const backup = `${target}.previous-${now}`;
    await mkdir(target);
    await writeFile(path.join(target, "old.txt"), "previous export");
    await mkdir(staging);
    await writeFile(path.join(staging, "new.txt"), "next export");
    await mkdir(backup);
    await assert.rejects(
      swapIntoPlace(staging, target, await lstat(target), () => now),
      (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.NotAnExportFolder,
    );
    assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "previous export");
    assert.equal(await readFile(path.join(staging, "new.txt"), "utf8"), "next export");
    assert.deepEqual(await readdir(backup), [], "the foreign backup folder remains");
  });

  it("a folder that is not an export is refused and left as it was", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const target = path.join(temp, "documents");
    await mkdir(target);
    await writeFile(path.join(target, "thesis.txt"), "mine");
    await assert.rejects(exportPublicGame(game, target, ["index.html", "src"]), {
      message: "Export target is not an app-managed export; choose an empty directory",
    });
    assert.deepEqual(await readdir(target), ["thesis.txt"]);
    assert.deepEqual(await stagingLeft(temp), []);
  });

  it("a symlink target is refused as not an ordinary directory, and what it points at is left alone", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const elsewhere = path.join(temp, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, ".studio-export.json"), '{"studioExport":1,"included":[]}');
    const target = path.join(temp, "public");
    await symlink(elsewhere, target, "dir");
    await assert.rejects(exportPublicGame(game, target, ["index.html", "src"]), {
      message: "Export target must be an ordinary directory",
    });
    assert.deepEqual(await readdir(elsewhere), [".studio-export.json"]);
    assert.deepEqual(await stagingLeft(temp), []);
  });

  it("a file over 32 MiB is not read for held credentials; one of exactly 32 MiB is", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const secret = "genex-FAKE-token-in-a-large-asset";
    const asset = (bytes: number) => {
      const buffer = Buffer.alloc(bytes, 0x2e);
      buffer.write(secret, 0);
      return buffer;
    };
    await mkdir(path.join(game, "assets"));
    await writeFile(path.join(game, "assets", "level.bin"), asset(32 * MIB + 1));
    const roots = ["index.html", "src", "assets"];
    const result = await exportPublicGame(game, path.join(temp, "large"), roots, undefined, {
      secretValues: [secret],
    });
    assert.ok(result.included.includes("assets/level.bin"));
    await writeFile(path.join(game, "assets", "level.bin"), asset(32 * MIB));
    await assert.rejects(
      exportPublicGame(game, path.join(temp, "exact"), roots, undefined, { secretValues: [secret] }),
      /assets\/level\.bin/,
    );
  });

  it("the manifest carries the marker and the public list, so the next export may replace the folder", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const target = path.join(temp, "public");
    const result = await exportPublicGame(game, target, ["index.html", "src"]);
    const manifest = JSON.parse(await readFile(path.join(target, ".studio-export.json"), "utf8"));
    assert.deepEqual(manifest, { studioExport: 1, included: result.included });
    await writeFile(path.join(game, "src", "main.js"), 'console.log("again")');
    await exportPublicGame(game, target, ["index.html", "src"]);
    assert.equal(await readFile(path.join(target, "src", "main.js"), "utf8"), 'console.log("again")');
  });
});

describe("exporting Emscripten's web output", () => {
  it("exports the real emcc output whole: the page, its classic glue, the module and the preloaded data", async () => {
    const game = await gameFrom(EMCC_FIXTURE, EMCC_FILES);
    const target = path.join(path.dirname(game), "public");
    const result = await exportPublicGame(game, target, EMCC_FILES);
    assert.deepEqual([...result.included].sort(), EMCC_FILES);
    assert.deepEqual(result.excluded, []);
  });

  it("stages .wasm and .data byte-identical to the build's", async () => {
    const game = await gameFrom(EMCC_FIXTURE, EMCC_FILES);
    const target = path.join(path.dirname(game), "public");
    await exportPublicGame(game, target, EMCC_FILES);
    for (const file of ["index.wasm", "index.data"])
      assert.equal(await sha256(path.join(target, file)), await sha256(path.join(EMCC_FIXTURE, file)), file);
  });

  it("exports the hostile synthetic glue: an import() in a classic script is not a module specifier", async () => {
    const game = await gameFrom(HOSTILE_FIXTURE, HOSTILE_FILES);
    const target = path.join(path.dirname(game), "public");
    const result = await exportPublicGame(game, target, HOSTILE_FILES);
    assert.deepEqual([...result.included].sort(), HOSTILE_FILES);
    assert.equal(await sha256(path.join(target, "index.wasm")), await sha256(path.join(HOSTILE_FIXTURE, "index.wasm")));
  });

  it("reads a script as a module only when a tag or an import makes it one", async () => {
    const unresolved = /Export has an unresolved module: x/;
    const cases: Array<[string, string, RegExp | null]> = [
      ["quoted classic tag", '<script type="text/javascript" src="index.js"></script>', null],
      ["unquoted classic tag, as emcc minifies it", "<script async src=index.js></script>", null],
      ["a nomodule tag", '<script nomodule src="./index.js"></script>', null],
      ["a type only in a data attribute", '<script data-type="module" src="index.js"></script>', null],
      ["a module tag", '<script type="module" src="index.js"></script>', unresolved],
      ["an unquoted module tag", "<script type=module src=index.js></script>", unresolved],
      ["a module tag in capitals", "<SCRIPT TYPE='Module' SRC='index.js'></SCRIPT>", unresolved],
      ["a module that imports the glue", '<script type="module">import "./index.js";</script>', unresolved],
      [
        "a classic tag and a module importing the same file",
        '<script src="index.js"></script><script type="module">import "./index.js";</script>',
        unresolved,
      ],
      ["no tag names it: every staged script is read as a module", "<canvas></canvas>", unresolved],
    ];
    for (const [name, page, refusal] of cases) {
      const game = await gameFrom(HOSTILE_FIXTURE, HOSTILE_FILES);
      await writeFile(path.join(game, "index.html"), `<!doctype html>${page}`);
      const target = path.join(path.dirname(game), "public");
      const exported = exportPublicGame(game, target, HOSTILE_FILES);
      if (refusal) {
        await assert.rejects(exported, refusal, name);
        assert.equal(existsSync(target), false, `${name}: nothing was published`);
      } else assert.deepEqual([...(await exported).included].sort(), HOSTILE_FILES, name);
    }
  });

  it("refuses a classic script that leaves the export, and publishes nothing", async () => {
    const sources = ["../game/index.js", "/../game/index.js", "%2e%2e/game/index.js", "..%2fgame%2findex.js"];
    for (const src of sources) {
      const game = await gameFrom(HOSTILE_FIXTURE, HOSTILE_FILES);
      await writeFile(path.join(game, "index.html"), `<script src=${src}></script>`);
      const target = path.join(path.dirname(game), "public");
      await assert.rejects(
        exportPublicGame(game, target, HOSTILE_FILES),
        /Export is missing a referenced public file: .* in index\.html/,
        src,
      );
      assert.equal(existsSync(target), false, src);
      assert.deepEqual(await stagingLeft(path.dirname(game)), [], src);
    }
  });

  it("refuses a page whose classic script is not in the export, quoted or not", async () => {
    for (const page of ["<script async src=index.js></script>", '<script src="index.js"></script>']) {
      const game = await gameFrom(EMCC_FIXTURE, EMCC_FILES);
      await writeFile(path.join(game, "index.html"), page);
      const target = path.join(path.dirname(game), "public");
      await assert.rejects(
        exportPublicGame(game, target, ["index.html", "index.wasm", "index.data"]),
        { message: "Export is missing a referenced public file: index.js in index.html" },
        page,
      );
      assert.equal(existsSync(target), false, page);
    }
  });
});

describe("a classic script's imports on the three.js stack", () => {
  /** A game whose page loads `src/boot.js` as a classic script, beside `files`, and an import map. */
  async function classicGame(imports: Record<string, string>, files: Record<string, string>): Promise<string> {
    const game = path.join(await tmpDir("studio-export-classic-"), "game");
    await mkdir(path.join(game, "src"), { recursive: true });
    const map = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
    await writeFile(path.join(game, "index.html"), `${map}<script src="./src/boot.js"></script>`);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(game, name), text);
    return game;
  }

  it("follows a classic script's relative and mapped imports as a module's, and refuses what is missing", async () => {
    const cases: Array<[string, Record<string, string>, Record<string, string>, string | null]> = [
      [
        "a missing chunk",
        {},
        { "src/boot.js": 'import("./missing-chunk.js");' },
        "Export is missing a referenced public file: ./missing-chunk.js in src/boot.js",
      ],
      [
        "a chunk whose own import no map answers",
        {},
        { "src/boot.js": 'import("./chunk.js");', "src/chunk.js": 'import "x";' },
        "Export has an unresolved module: x",
      ],
      [
        "a mapped import whose file is missing",
        { "lib/": "/libs/" },
        { "src/boot.js": 'import("lib/missing.js");' },
        "Export is missing a referenced public file: /libs/missing.js in index.html",
      ],
      ["a bare import no map answers (emcc's Node branch)", {}, { "src/boot.js": 'import("x");' }, null],
      [
        "a chunk that is there",
        {},
        { "src/boot.js": 'import("./chunk.js");', "src/chunk.js": "export const chunk = 1;" },
        null,
      ],
    ];
    for (const [name, imports, files, refusal] of cases) {
      const game = await classicGame(imports, files);
      const target = path.join(path.dirname(game), "public");
      const exported = exportPublicGame(game, target, ["index.html", "src"]);
      if (refusal) {
        await assert.rejects(exported, { message: refusal }, name);
        assert.equal(existsSync(target), false, `${name}: nothing was published`);
        assert.deepEqual(await stagingLeft(path.dirname(game)), [], name);
      } else assert.ok((await exported).included.includes("src/boot.js"), name);
    }
  });

  it("keeps the vendored file a classic script imports through the import map, and prunes the rest", async () => {
    const game = await classicGame(
      { "three/addons/": "/vendor/three/examples/jsm/" },
      { "src/boot.js": 'import("three/addons/controls/OrbitControls.js").then(({ OrbitControls }) => OrbitControls);' },
    );
    const vendor = path.join(path.dirname(game), "vendor");
    await mkdir(path.join(vendor, "three", "examples", "jsm", "controls"), { recursive: true });
    await writeFile(
      path.join(vendor, "three/examples/jsm/controls/OrbitControls.js"),
      "export const OrbitControls = 1;",
    );
    await writeFile(path.join(vendor, "three/examples/jsm/unused.js"), "export const unused = 1;");
    const target = path.join(path.dirname(game), "public");
    const result = await exportPublicGame(game, target, ["index.html", "src"], vendor);
    assert.ok(result.included.includes("vendor/three/examples/jsm/controls/OrbitControls.js"));
    assert.ok(result.excluded.includes("vendor/three/examples/jsm/unused.js"));
    assert.ok(existsSync(path.join(target, "vendor/three/examples/jsm/controls/OrbitControls.js")));
  });
});

describe("a C++ game's preload pack and private names", () => {
  it("reads a preload pack (.data) for held credentials whatever its size, and across read boundaries", async () => {
    const secret = "genex-FAKE-token-in-the-pack";
    const cases: Array<[string, string, number, number]> = [
      ["a pack over 32 MiB, the token across the 32 MiB mark", "index.data", 32 * MIB + 64, 32 * MIB - 5],
      ["a pack over 32 MiB, the token in its last bytes", "index.data", 32 * MIB + 64, 32 * MIB + 64 - secret.length],
      ["an asset under the cap, the token across the 4 MiB mark", "assets/level.bin", 5 * MIB, 4 * MIB - 5],
    ];
    for (const [name, rel, size, offset] of cases) {
      const temp = await tmpDir("studio-export-pack-");
      const game = await plainGame(temp);
      const bytes = Buffer.alloc(size, 0x2e);
      bytes.write(secret, offset);
      await mkdir(path.dirname(path.join(game, rel)), { recursive: true });
      await writeFile(path.join(game, rel), bytes);
      const target = path.join(temp, "public");
      await assert.rejects(
        exportPublicGame(game, target, ["index.html", "src", rel], undefined, { secretValues: [secret] }),
        (error: unknown) => {
          assert.ok(error instanceof ExportError, name);
          assert.equal(error.code, ExportRefusal.SecretFound, name);
          assert.ok(error.message.startsWith(`Export stopped: ${rel} contains a credential`), name);
          return true;
        },
        name,
      );
      assert.equal(existsSync(target), false, `${name}: nothing was published`);
      assert.deepEqual(await stagingLeft(temp), [], name);
    }
  });

  it("leaves out exactly the names excludedFromExport names, the one table a pack should follow too", async () => {
    const names = [".env", ".DS_Store", "id_rsa", "credentials.json", "server.key", "notes.log", "README.md", "tests"];
    const kept = ["level.png", "music.ogg", "notes.txt", "shaders.glsl"];
    const temp = await tmpDir("studio-export-private-");
    const game = await plainGame(temp);
    await mkdir(path.join(game, "assets"));
    for (const name of [...names, ...kept]) await writeFile(path.join(game, "assets", name), "fixture");
    const result = await exportPublicGame(game, path.join(temp, "public"), ["index.html", "src", "assets"]);
    for (const name of [...names, ...kept]) {
      const rel = `assets/${name}`;
      assert.equal(result.excluded.includes(rel), excludedFromExport(name), rel);
      assert.equal(result.included.includes(rel), !excludedFromExport(name), rel);
    }
    assert.deepEqual(
      names.filter((name) => !excludedFromExport(name)),
      [],
      "every private name is left out",
    );
  });
});

describe("typed export refusals", () => {
  it("a folder that is not an export: not-an-export-folder, the sentence unchanged", async () => {
    const temp = await tmpDir("studio-export-typed-");
    const game = await plainGame(temp);
    const target = path.join(temp, "documents");
    await mkdir(target);
    await writeFile(path.join(target, "thesis.txt"), "mine");
    await assert.rejects(exportPublicGame(game, target, ["index.html", "src"]), (error: unknown) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, ExportRefusal.NotAnExportFolder);
      assert.equal(error.message, "Export target is not an app-managed export; choose an empty directory");
      return true;
    });
  });

  it("a file holding a held credential: secret-found, the sentence unchanged", async () => {
    const temp = await tmpDir("studio-export-typed-");
    const game = await plainGame(temp);
    const secret = "genex-FAKE-token-typed";
    await writeFile(path.join(game, "src", "main.js"), `const KEY = "${secret}";`);
    await assert.rejects(
      exportPublicGame(game, path.join(temp, "public"), ["index.html", "src"], undefined, { secretValues: [secret] }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError);
        assert.equal(error.code, ExportRefusal.SecretFound);
        assert.equal(
          error.message,
          "Export stopped: src/main.js contains a credential Studio holds (an API key or sign-in token). Remove it from the game and export again.",
        );
        return true;
      },
    );
  });
});

/** A lock the fake store says it holds: the web components at made-up versions. */
const LOCK: ToolchainLock = {
  version: 1,
  entries: {
    [ToolchainId.Cmake]: { version: "4.4.3", sha12: "000000000001" },
    [ToolchainId.Ninja]: { version: "1.13.2", sha12: "000000000002" },
    [ToolchainId.Emsdk]: { version: "6.0.10", sha12: "000000000003" },
    [ToolchainId.RaylibSource]: { version: "6.0", sha12: "000000000004" },
  },
  digest: "e".repeat(64),
};

/**
 * A stand-in store: its `cmake` records the source folder at configure and, at `--build`, copies
 * the real emcc fixture into `<binary>/out`, or prints a clang-style error and exits 1 when
 * `src/main.cpp` holds GENEX_FORCE_ERROR. Every other path the lane may touch exists.
 */
async function fakeStore(): Promise<LocatedToolchain> {
  const store = await tmpDir("studio-export-store-");
  const cmake = path.join(store, "cmake");
  await writeFile(
    cmake,
    [
      "#!/bin/sh",
      'mode=configure; src=""; bin=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -S) src="$2"; shift ;;',
      '    -B) bin="$2"; shift ;;',
      '    --build) mode=build; bin="$2"; shift ;;',
      "  esac",
      "  shift",
      "done",
      'if [ "$mode" = configure ]; then',
      '  /bin/mkdir -p "$bin" && printf "%s" "$src" > "$bin/genex-test-source" && : > "$bin/CMakeCache.txt"',
      "  exit $?",
      "fi",
      'src=$(/bin/cat "$bin/genex-test-source")',
      'if /usr/bin/grep -q GENEX_FORCE_ERROR "$src/src/main.cpp" 2>/dev/null; then',
      '  echo "src/main.cpp:1:1: error: forced by the test" >&2',
      "  exit 1",
      "fi",
      `/bin/mkdir -p "$bin/out" && /bin/cp ${EMCC_FILES.map((file) => shellQuote(path.join(EMCC_FIXTURE, file))).join(" ")} "$bin/out/"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(path.join(store, "ninja"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const emsdk = path.join(store, "emsdk");
  await mkdir(path.join(store, "em-cache"), { recursive: true });
  await mkdir(emsdk);
  for (const file of ["Emscripten.cmake", "emscripten.config", "genex-web.cmake"])
    await writeFile(path.join(store, file), "");
  return {
    lock: LOCK,
    cmake,
    ninja: path.join(store, "ninja"),
    emscripten: {
      root: emsdk,
      toolchainFile: path.join(store, "Emscripten.cmake"),
      python: "/usr/bin/false",
      node: process.execPath,
      config: path.join(store, "emscripten.config"),
      cache: path.join(store, "em-cache"),
    },
    genexCmake: { [BuildTarget.Web]: path.join(store, "genex-web.cmake") },
  };
}

describe("a raylib game's web export", { skip: POSIX_ONLY }, () => {
  it("exportPublicCopy exports the lane's output, never a stale in-tree build/web, and refuses a failed build", async () => {
    const { core } = await coreLite();
    const located = await fakeStore();
    core.cppBuilds = new CppBuilds({
      ...core.cppBuilds.options,
      currentLock: async () => LOCK,
      locate: async () => ({ ok: true, toolchain: located }),
    });
    const game = await core.games.scaffold("pong-cpp", {
      title: "Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web],
    });
    await mkdir(path.join(game.dir, "build", "web"), { recursive: true });
    await writeFile(path.join(game.dir, "build", "web", "index.html"), "<p>a stale in-tree build</p>");
    const target = path.join(core.layout.exports, "pong-cpp");
    const result = await core.exportPublicCopy(game.name, target);
    assert.deepEqual([...result.included].sort(), EMCC_FILES);
    for (const file of ["index.html", "index.wasm", "index.data"])
      assert.equal(await sha256(path.join(target, file)), await sha256(path.join(EMCC_FIXTURE, file)), file);

    await writeFile(path.join(game.dir, "src", "main.cpp"), "// GENEX_FORCE_ERROR\n");
    await assert.rejects(core.exportPublicCopy(game.name, target), (error: unknown) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, ExportRefusal.BuildFailed);
      return true;
    });
    assert.equal(await sha256(path.join(target, "index.wasm")), await sha256(path.join(EMCC_FIXTURE, "index.wasm")));
  });

  /**
   * A web build of a game without Browser is made for the judges only: it is never exported or
   * published (the export IPC and the plugins' export.stage both come here).
   */
  it("refuses a game without Browser among its destinations as not-a-destination, building and staging nothing", async (t) => {
    const { core } = await coreLite();
    const ensure = t.mock.method(core.cppBuilds, "ensure");
    const game = await core.games.scaffold("pong-mac", {
      title: "Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Mac],
    });
    const target = path.join(core.layout.exports, "pong-mac");
    await assert.rejects(core.exportPublicCopy(game.name, target), (error: unknown) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, ExportRefusal.NotADestination);
      return true;
    });
    assert.equal(ensure.mock.callCount(), 0, "the lane is never asked");
    assert.equal(await lstat(target).catch(() => null), null, "nothing is staged");
  });
});

/**
 * Pins taken before the Mac export shares the web export's target, staging, swap and credential
 * helpers: every sentence and refusal stays what it was.
 */
describe("export characterization before the helpers are shared", { skip: POSIX_ONLY }, () => {
  it("a target that is a file is refused as not an ordinary directory, and the file is left as it was", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const target = path.join(temp, "public");
    await writeFile(target, "a file");
    await assert.rejects(exportPublicGame(game, target, ["index.html", "src"]), {
      message: "Export target must be an ordinary directory",
    });
    assert.equal(await readFile(target, "utf8"), "a file");
    assert.deepEqual(await stagingLeft(temp), []);
  });

  it("a target inside the game is refused before anything is made there", async () => {
    const temp = await realpath(await tmpDir("studio-export-pin-"));
    const game = await plainGame(temp);
    await assert.rejects(exportPublicGame(game, path.join(game, "dist", "public"), ["index.html", "src"]), {
      message: "Export destination must be outside the game",
    });
    assert.equal(existsSync(path.join(game, "dist")), false, "no folder is made inside the game");
  });

  it("a target that a link in its parent puts inside the game is refused, and nothing is staged there", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    await symlink(game, path.join(temp, "into-game"), "dir");
    await assert.rejects(exportPublicGame(game, path.join(temp, "into-game", "public"), ["index.html", "src"]), {
      message: "Export destination must resolve outside the game",
    });
    assert.deepEqual((await readdir(game)).sort(), ["index.html", "src"]);
  });

  it("a page export carries the files it lists and the marker, and nothing else", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    const target = path.join(temp, "public");
    const result = await exportPublicGame(game, target, ["index.html", "src"]);
    assert.deepEqual((await readdir(target)).sort(), [".studio-export.json", "index.html", "src"]);
    const dir = path.join(await realpath(temp), "public");
    assert.deepEqual(result, { dir, files: 2, included: ["index.html", "src/main.js"], excluded: [] });
  });

  it("a private root is listed as excluded under the name it was asked by", async () => {
    const temp = await tmpDir("studio-export-pin-");
    const game = await plainGame(temp);
    await writeFile(path.join(game, ".env"), "PRIVATE");
    const result = await exportPublicGame(game, path.join(temp, "public"), ["index.html", "src", ".env"]);
    assert.deepEqual(result.excluded, [".env"]);
  });
});

/** The helpers the Mac app export shares with the web export, through their own interface. */
describe("the shared export helpers", { skip: POSIX_ONLY }, () => {
  it("a target a link above it puts inside the game is refused, and no folder is made in the game", async () => {
    const temp = await tmpDir("studio-export-shared-");
    const game = await plainGame(temp);
    await symlink(game, path.join(temp, "into-game"), "dir");
    for (const target of [path.join(temp, "into-game", "dist", "public"), path.join(game, "dist", "public")]) {
      await assert.rejects(resolveExportTarget(await realpath(game), target), /Export destination must/);
      assert.deepEqual((await readdir(game)).sort(), ["index.html", "src"], target);
    }
  });

  it("swapIntoPlace keeps the previous export when the staged folder cannot move in, by the clock it is given", async () => {
    const temp = await tmpDir("studio-export-shared-");
    const target = path.join(temp, "public");
    await mkdir(target);
    await writeFile(path.join(target, "index.html"), "previous");
    const existing = await lstat(target);
    const now = () => 1_790_000_000_123;
    await assert.rejects(swapIntoPlace(path.join(temp, ".studio-export-gone"), target, existing, now));
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "previous");
    assert.equal(existsSync(`${target}.previous-1790000000123`), false, "the previous export is moved back");
  });

  it("fileWithSecret reads a file the caller always reads, whatever its size", async () => {
    const temp = await tmpDir("studio-export-shared-");
    const secret = "genex-FAKE-token-in-an-executable";
    const bytes = Buffer.alloc(32 * MIB + 16, 0x2e);
    bytes.write(secret, bytes.length - secret.length);
    await writeFile(path.join(temp, "game"), bytes);
    assert.equal(await fileWithSecret(temp, ["game"], [secret]), undefined, "over the cap, unread by default");
    assert.equal(await fileWithSecret(temp, ["game"], [secret], (rel) => rel === "game"), "game");
  });

  it("a web export whose root holds a WebAssembly module carries the server README, outside the public list", async () => {
    const game = await gameFrom(EMCC_FIXTURE, EMCC_FILES);
    const target = path.join(path.dirname(game), "public");
    const result = await exportPublicGame(game, target, EMCC_FILES);
    const readme = await readFile(path.join(target, "README.txt"), "utf8");
    assert.equal(readme, WEB_SERVER_README);
    assert.match(readme, /\.wasm[^\n]*application\/wasm/);
    assert.match(readme, /\.data[^\n]*application\/octet-stream/);
    assert.deepEqual([...result.included].sort(), EMCC_FILES, "the README is the host's, not a public file");
    assert.equal(result.files, EMCC_FILES.length);
  });

  it("a page export with no WebAssembly at its root gets no README", async () => {
    const temp = await tmpDir("studio-export-shared-");
    const game = await plainGame(temp);
    await mkdir(path.join(game, "assets"));
    await writeFile(path.join(game, "assets", "decoder.wasm"), "\0asm");
    const target = path.join(temp, "public");
    await exportPublicGame(game, target, ["index.html", "src", "assets"]);
    assert.equal(existsSync(path.join(target, "README.txt")), false);
  });
});

/**
 * A sandboxed process writes the exports folder (`layout.exports` is a writable root). One that
 * watches it plants links in a staging folder it finds there, at the moment the host scans the
 * staging for held credentials: a link named like a file the host writes next would make the host
 * write through it. Every link it planted is returned.
 */
function plantInStaging(exportsDir: string, victim: string): Iterable<string> & { planted: string[] } {
  const planted: string[] = [];
  return {
    planted,
    *[Symbol.iterator]() {
      for (const name of readdirSync(exportsDir).filter((entry) => entry.startsWith(".studio-export-")))
        for (const file of ["README.txt", ".studio-export.json"]) {
          symlinkSync(victim, path.join(exportsDir, name, file));
          planted.push(path.join(name, file));
        }
      yield "genex-FAKE-held-credential-value";
    },
  };
}

describe("an export staged where no sandboxed process writes", { skip: POSIX_ONLY }, () => {
  it("stages in the host's own folder: links planted in the exports folder meanwhile change nothing outside it", async () => {
    const game = await gameFrom(EMCC_FIXTURE, EMCC_FILES);
    const temp = path.dirname(game);
    const exportsDir = path.join(temp, "exports");
    await mkdir(exportsDir);
    const victim = path.join(temp, "victim.txt");
    await writeFile(victim, "the person's own file");
    const secretValues = plantInStaging(exportsDir, victim);
    const stagingRoot = path.join(temp, "export-staging");
    const target = path.join(exportsDir, "pong");
    await exportPublicGame(game, target, EMCC_FILES, undefined, { secretValues, stagingRoot });
    assert.equal(await readFile(victim, "utf8"), "the person's own file");
    assert.deepEqual(secretValues.planted, [], "nothing was staged in the exports folder");
    assert.equal(await readFile(path.join(target, "README.txt"), "utf8"), WEB_SERVER_README);
    assert.deepEqual(await stagingLeft(stagingRoot), [], "the staging folder moved into place");
  });

  it("the library stages every export in the studio's own export-staging folder", async () => {
    const { core } = await coreLite();
    await core.games.scaffold("pong", { title: "Pong" });
    const victim = path.join(core.layout.scratch, "victim.txt");
    await writeFile(victim, "the person's own file");
    const secretValues = plantInStaging(core.layout.exports, victim);
    const target = path.join(core.layout.exports, "pong");
    // A built game's output (the C++ lane's, for one): the library exports it as given.
    const built = await plainGame(await tmpDir("studio-export-built-"));
    await core.games.export("pong", target, built, { secretValues });
    assert.equal(await readFile(victim, "utf8"), "the person's own file");
    assert.deepEqual(secretValues.planted, []);
    assert.ok(existsSync(path.join(target, ".studio-export.json")));
    assert.equal((await lstat(path.join(target, ".studio-export.json"))).isFile(), true);
  });
});
