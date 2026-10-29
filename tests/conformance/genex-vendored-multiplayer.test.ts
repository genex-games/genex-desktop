/**
 * Studio's own copy of Genex's multiplayer SDK (`scripts/vendor-genex-multiplayer.ts`) and how a
 * template game's page maps Studio's copies (`withGenexSdkImport`): what the import map points at
 * must exist after a build, at the version Studio tells the agent and Genex, with every bundled
 * package's license beside it, and only Studio's own copies count as turned on.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { bridgeLicenses, vendorGenexMultiplayer } from "../../scripts/vendor-genex-multiplayer.ts";
import {
  GENEX_GAME_PACKAGES,
  GENEX_MULTIPLAYER_VENDOR,
  genexPackageSet,
  studioSdkImports,
  studioSdkPackages,
} from "../../src/shared/genex.ts";
import { pageStudioSdkPackages, withGenexSdkImport } from "../../src/shared/genex-page.ts";
import { templateGenexManifest } from "../../src/substrate/genex-game-manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");

/** The template's page as a new game starts: three.js from Studio's vendor folder. */
const TEMPLATE_PAGE = `<!doctype html>
<html>
  <head>
    <script type="importmap">
      { "imports": { "three": "/vendor/three.module.js" } }
    </script>
  </head>
  <body><script type="module" src="./src/main.js"></script></body>
</html>
`;

describe("Studio's vendored Genex multiplayer SDK", () => {
  it("names the license of every package the engine bridge bundles, which a Godot web export carries beside it", async () => {
    const text = await bridgeLicenses(repo);
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    for (const name of ["@genex-ai/multiplayer", "@genex-ai/embed-sdk", "@colyseus/sdk", "@colyseus/schema"])
      assert.ok(
        headings.some((line) => line.startsWith(`## ${name} `)),
        `${name} is bundled into the bridge: ${headings.join(" | ")}`,
      );
    assert.ok(
      headings.includes(`## @genex-ai/multiplayer ${GENEX_GAME_PACKAGES["@genex-ai/multiplayer"]} (MIT)`),
      "at Studio's pin",
    );
  });

  it("builds every file a template game maps, at Studio's pin, licenses beside them", async () => {
    const vendor = await tmpDir("studio-genex-multiplayer-");
    const built = await vendorGenexMultiplayer(repo, vendor);
    const folder = path.join(vendor, GENEX_MULTIPLAYER_VENDOR.Dir);
    const files = await readdir(folder);
    for (const served of [GENEX_MULTIPLAYER_VENDOR.Entry, GENEX_MULTIPLAYER_VENDOR.Schema])
      assert.ok(files.includes(path.posix.basename(served)), `${served} is built`);
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, "VERSION.json"), "utf8")), {
      "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"],
    });
    const licenses = await readFile(path.join(folder, "LICENSES.md"), "utf8");
    for (const name of ["@genex-ai/multiplayer", "@colyseus/sdk", "@colyseus/schema"])
      assert.match(licenses, new RegExp(`## ${name.replace("/", "\\/")} `), `${name}'s license ships`);
    assert.ok(built.inputs.some((input) => input.includes("node_modules/@colyseus/schema/")));
    assert.ok(!built.inputs.some((input) => input.includes("node_modules/three/")), "three stays the game's own");
    // One copy of Colyseus's schema, shared: a state class one entry defines must be the other's.
    const multiplayer = await readFile(path.join(vendor, GENEX_MULTIPLAYER_VENDOR.Entry), "utf8");
    const schema = await readFile(path.join(vendor, GENEX_MULTIPLAYER_VENDOR.Schema), "utf8");
    const chunks = (text: string) => [...text.matchAll(/from "\.\/(chunk-[^"]+\.js)"/g)].map(([, name]) => name);
    assert.ok(
      chunks(schema).some((chunk) => chunks(multiplayer).includes(chunk)),
      "the schema entry imports a chunk the multiplayer entry also imports",
    );
  });

  it("is the version package.json pins, so the agent, Genex and the game agree", async () => {
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(GENEX_GAME_PACKAGES))
      assert.equal(pkg.devDependencies[name], version, `${name} is pinned exactly`);
  });

  it("maps each package with what it needs, and counts only Studio's own copies as turned on", () => {
    assert.deepEqual(genexPackageSet("@genex-ai/multiplayer"), ["@genex-ai/multiplayer", "@genex-ai/embed-sdk"]);
    assert.deepEqual(Object.keys(studioSdkImports("@genex-ai/multiplayer")), [
      "@genex-ai/multiplayer",
      "@genex-ai/multiplayer/schema",
      "@genex-ai/embed-sdk",
    ]);
    assert.deepEqual(studioSdkImports("@genex-ai/embed-sdk"), {
      "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk/index.js",
    });
    assert.deepEqual(studioSdkPackages(studioSdkImports("@genex-ai/multiplayer")), [
      "@genex-ai/embed-sdk",
      "@genex-ai/multiplayer",
    ]);
    const hostile: Array<[string, Record<string, string>]> = [
      ["a CDN copy", { "@genex-ai/embed-sdk": "https://esm.sh/@genex-ai/embed-sdk" }],
      ["the game's own file", { "@genex-ai/multiplayer": "/src/multiplayer.js" }],
      ["a path that only starts like Studio's", { "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk/index.js?x" }],
      ["multiplayer without its schema", { "@genex-ai/multiplayer": "/vendor/genex/multiplayer/index.js" }],
      ["an inherited key", Object.create({ "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk/index.js" })],
    ];
    for (const [name, imports] of hostile) assert.deepEqual(studioSdkPackages(imports), [], name);
  });

  it("maps multiplayer into a template page beside player identity and the connect module, once", () => {
    const page = withGenexSdkImport(TEMPLATE_PAGE, "@genex-ai/multiplayer");
    assert.ok(page);
    assert.deepEqual(pageStudioSdkPackages(page), ["@genex-ai/embed-sdk", "@genex-ai/multiplayer"]);
    assert.match(page, /"three": "\/vendor\/three\.module\.js"/, "the game's own entries stay");
    assert.equal(page.match(/\/vendor\/genex\/connect\.js/g)?.length, 1, "the connect module loads once");
    assert.equal(withGenexSdkImport(page, "@genex-ai/multiplayer"), page, "a mapped page is left alone");
    const identityFirst = withGenexSdkImport(TEMPLATE_PAGE) ?? "";
    assert.deepEqual(pageStudioSdkPackages(identityFirst), ["@genex-ai/embed-sdk"]);
    const added = withGenexSdkImport(identityFirst, "@genex-ai/multiplayer") ?? "";
    assert.deepEqual(
      pageStudioSdkPackages(added),
      ["@genex-ai/embed-sdk", "@genex-ai/multiplayer"],
      "adds to identity",
    );
    assert.equal(added.match(/\/vendor\/genex\/connect\.js/g)?.length, 1);
  });

  it("names multiplayer, never the SDK Studio connects with, in a template game's manifest", () => {
    const multiplayer = withGenexSdkImport(TEMPLATE_PAGE, "@genex-ai/multiplayer") ?? "";
    const identity = withGenexSdkImport(TEMPLATE_PAGE) ?? "";
    assert.deepEqual(templateGenexManifest(multiplayer, undefined), {
      dependencies: { "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"] },
    });
    assert.equal(templateGenexManifest(identity, undefined), undefined, "Studio names the SDK it connects with");
    assert.equal(templateGenexManifest(TEMPLATE_PAGE, undefined), undefined);
    assert.deepEqual(templateGenexManifest(identity, { matchmaking: { maxPlayers: 4 } })?.dependencies, {});
  });
});
