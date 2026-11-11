import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { errorCode, errorMessage } from "../../src/shared/errors.ts";
import { ExportRefusal } from "../../src/shared/game-library.ts";
import {
  type ExportListing,
  type ExportOptions,
  exportPublicGame,
  listPublicGame,
} from "../../src/substrate/game-export.ts";

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

/** Everything below `dir`: each file with its bytes, each link with where it points. */
async function treeOf(dir: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const at = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, at);
    if (entry.isSymbolicLink()) tree[rel] = `link to ${await readlink(at)}`;
    else tree[rel] = entry.isFile() ? await readFile(at, "base64") : "folder";
  }
  return tree;
}

/** How an export or a listing ended: its two lists in one order, or the refusal's code and words. */
async function endOf(run: () => Promise<ExportListing>) {
  try {
    const { included, excluded } = await run();
    return { included: [...included].sort(), excluded: [...excluded].sort() };
  } catch (error) {
    return { code: errorCode(error), message: errorMessage(error) };
  }
}

const LISTED_SECRET = "genex-FAKE-listed-token";
const LISTED_ROOTS = ["index.html", "src", "assets", ".env", "docs"];
const LISTED_PAGE = '<link rel="stylesheet" href="/src/style.css"><script type="module" src="/src/main.js"></script>';

/** A game with public files, files an export leaves out by name, one it was not asked for, and one outside it. */
async function listedGame(temp: string): Promise<string> {
  const game = path.join(temp, "game");
  for (const folder of ["src", "assets", "docs"]) await mkdir(path.join(game, folder), { recursive: true });
  const files: Record<string, string> = {
    "index.html": LISTED_PAGE,
    "src/main.js": 'import { part } from "./part.js?v=2"; console.log(part);',
    "src/part.js": "export const part = 1;",
    "src/style.css": 'body { background: url("../assets/sky.png"); }',
    "assets/sky.png": "fixture",
    ".env": "PRIVATE FIXTURE",
    "docs/helper.js": "export const helper = 1;",
    "unlisted.js": "export const unlisted = 1;",
    "../outside.js": "export const outside = 1;",
  };
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(game, rel), text);
  return game;
}

it("lists the files of a public copy where they are: the lists an export answers, with nothing written", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-listed-"));
  try {
    const game = await listedGame(temp);
    const before = await treeOf(temp);
    const listed = await endOf(() => listPublicGame(game, LISTED_ROOTS, { secretValues: [LISTED_SECRET] }));
    assert.deepEqual(listed, {
      included: ["assets/sky.png", "index.html", "src/main.js", "src/part.js", "src/style.css"],
      excluded: [".env", "docs"],
    });
    assert.deepEqual(await treeOf(temp), before, "no copy, no staging folder, and the page is not rewritten");
    assert.deepEqual(await endOf(() => exportPublicGame(game, path.join(temp, "public"), LISTED_ROOTS)), listed);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/**
 * Inputs an export refuses or must not be fooled by. `arrange` changes the game and answers the
 * public paths to ask for; `refusal` is how both must end, and without one both list the files.
 * `diskDecides`: a disk that takes `Part.js` for `part.js` lets it through and any other refuses,
 * so the two only have to agree.
 */
const HOSTILE_LISTINGS: Array<{
  name: string;
  arrange: (game: string, temp: string) => Promise<string[] | undefined>;
  refusal?: ExportRefusal;
  diskDecides?: true;
  options?: ExportOptions;
}> = [
  {
    name: "a selected path that is not there",
    arrange: async () => [...LISTED_ROOTS, "missing"],
    refusal: ExportRefusal.PublicPathMissing,
  },
  {
    name: "a selected path that climbs out of the game",
    arrange: async () => [...LISTED_ROOTS, "../outside.js"],
    refusal: ExportRefusal.PublicPathInvalid,
  },
  {
    name: "a selected path given from the disk's root",
    arrange: async (_game, temp) => [...LISTED_ROOTS, path.join(temp, "outside.js")],
    refusal: ExportRefusal.PublicPathInvalid,
  },
  {
    name: "a link among the public files",
    arrange: async (game, temp) => {
      await symlink(path.join(temp, "outside.js"), path.join(game, "assets", "leak.js"));
      return undefined;
    },
    refusal: ExportRefusal.Symlink,
  },
  {
    name: "a selected folder that is a link",
    arrange: async (game) => {
      await symlink(path.join(game, "docs"), path.join(game, "shared"));
      return [...LISTED_ROOTS, "shared"];
    },
    refusal: ExportRefusal.Symlink,
  },
  {
    name: "no page among the public files",
    arrange: async () => ["src", "assets"],
    refusal: ExportRefusal.NoEntry,
  },
  {
    name: "a module that imports a file left out by its folder's name",
    arrange: async (game) => {
      await writeFile(path.join(game, "src", "main.js"), 'import "../docs/helper.js";');
      return undefined;
    },
    refusal: ExportRefusal.MissingReference,
  },
  {
    name: "a module that imports a file of the game nobody selected",
    arrange: async (game) => {
      await writeFile(path.join(game, "src", "main.js"), 'import "../unlisted.js";');
      return undefined;
    },
    refusal: ExportRefusal.MissingReference,
  },
  {
    name: "a page that loads a file of the game nobody selected, from the root",
    arrange: async (game) => {
      await writeFile(path.join(game, "index.html"), '<script type="module" src="/unlisted.js"></script>');
      return undefined;
    },
    refusal: ExportRefusal.MissingReference,
  },
  {
    name: "a module that imports a file outside the game",
    arrange: async (game) => {
      await writeFile(path.join(game, "src", "main.js"), 'import "../../outside.js";');
      return undefined;
    },
    refusal: ExportRefusal.MissingReference,
  },
  {
    name: "a style that reaches a public file through a linked folder nobody selected",
    arrange: async (game) => {
      await symlink(path.join(game, "assets"), path.join(game, "art"));
      await writeFile(path.join(game, "src", "style.css"), 'body { background: url("../art/sky.png"); }');
      return undefined;
    },
    refusal: ExportRefusal.MissingReference,
  },
  {
    name: "an import no import map names",
    arrange: async (game) => {
      await writeFile(path.join(game, "src", "main.js"), 'import "three";');
      return undefined;
    },
    refusal: ExportRefusal.UnresolvedModule,
  },
  {
    name: "a scoped import map",
    arrange: async (game) => {
      const map = { imports: {}, scopes: { "/src/": { part: "/src/part.js" } } };
      await writeFile(
        path.join(game, "index.html"),
        `<script type="importmap">${JSON.stringify(map)}</script>${LISTED_PAGE}`,
      );
      return undefined;
    },
    refusal: ExportRefusal.ScopedImportMap,
  },
  {
    name: "a public file that holds a credential",
    arrange: async (game) => {
      await writeFile(path.join(game, "assets", "sky.png"), Buffer.from(`\u0000${LISTED_SECRET}\u0001`));
      return undefined;
    },
    refusal: ExportRefusal.SecretLeaked,
    options: { secretValues: [LISTED_SECRET] },
  },
  {
    name: "a credential in a file the copy leaves out",
    arrange: async (game) => {
      await writeFile(path.join(game, ".env"), LISTED_SECRET);
      return undefined;
    },
    options: { secretValues: [LISTED_SECRET] },
  },
  {
    name: "a public file named in another case",
    arrange: async (game) => {
      await writeFile(path.join(game, "src", "main.js"), 'import "./Part.js";');
      return undefined;
    },
    diskDecides: true,
  },
];

for (const hostile of HOSTILE_LISTINGS) {
  it(`a listing ends as the export does, and writes nothing: ${hostile.name}`, async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-hostile-"));
    try {
      const game = await listedGame(temp);
      const roots = (await hostile.arrange(game, temp)) ?? LISTED_ROOTS;
      const before = await treeOf(temp);
      const listed = await endOf(() => listPublicGame(game, roots, hostile.options));
      assert.deepEqual(await treeOf(temp), before, "the listing left the disk as it was");
      const exported = await endOf(() =>
        exportPublicGame(game, path.join(temp, "public"), roots, undefined, hostile.options),
      );
      assert.deepEqual(listed, exported);
      if (hostile.diskDecides) return;
      assert.equal("code" in listed ? listed.code : null, hostile.refusal ?? null);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
