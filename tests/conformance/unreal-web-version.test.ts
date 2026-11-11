/**
 * An Unreal game's web version: the build Unreal staged for the web, in `web/` at the game's root.
 * Only that counts. A page anyone else left in an Unreal game (an agent's design mockups, even in
 * `web/`) is never its web game, so Publish never puts a mockup online as the game.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { buildFinished, BUILD_SETTLE_MS } from "../../src/main/core/live-gate.ts";
import {
  CoreFact,
  engineWebFolderOf,
  engineWebVersion,
  FactSource,
  factsOfFiles,
  pluginFactSource,
  type ProjectFact,
  UNREAL_WEB_BUILD_FACT,
  UNREAL_WEB_BUILD_MARKER,
  withEngineWebVersion,
} from "../../src/shared/project-facts.ts";
import { publishesAsWebGame, webFolderOf } from "../../src/shared/project-workspace.ts";
import {
  platformRows,
  shownRows,
  webOfferFor,
  WebOffer,
} from "../../src/renderer/panels/plugins/genex/publish-platforms-view.ts";
import { publishPlatforms } from "../../src/main/core/publish-platforms.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLUGIN = pluginFactSource("unreal");
const unreal: ProjectFact = { id: CoreFact.UnrealProject, path: "unreal", source: FactSource.Core };
const page = (at: string): ProjectFact => ({ id: CoreFact.WebGame, path: at, source: FactSource.Core });
const build = (at: string): ProjectFact => ({ id: UNREAL_WEB_BUILD_FACT, path: at, source: PLUGIN });

describe("an Unreal game's web version", () => {
  it("is web/ when it holds a build Unreal staged for the web", () => {
    const game = { facts: [unreal, page("web"), build("web")] };
    assert.equal(engineWebFolderOf(game), "web");
    assert.equal(webFolderOf(game), "web");
    assert.equal(publishesAsWebGame(game), true);
  });

  const never: Array<[string, ProjectFact[]]> = [
    ["a page of mockups in web/", [unreal, page("web")]],
    ["a page of mockups in another folder", [unreal, page("ui_design")]],
    [
      "a staged build left in the project's own build folder",
      [unreal, page("unreal/Builds/Wasm"), build("unreal/Builds/Wasm")],
    ],
    ["an Unreal build's file beside a page in another folder", [unreal, page("web"), build("old")]],
    ["no page at all", [unreal, build("web")]],
  ];
  for (const [name, facts] of never)
    it(`is never ${name}`, () => {
      assert.equal(engineWebFolderOf({ facts }), null);
      assert.equal(publishesAsWebGame({ facts }), false);
    });

  it("a game of another kind gains nothing from the build's file", () => {
    assert.equal(engineWebFolderOf({ facts: [page("web"), build("web")] }), null);
  });

  it("is listed as the game's web game from the folder's files, in any case of the folder's name", () => {
    for (const folder of ["web", "Web"]) {
      const found = [unreal, page("."), page(folder), build(folder)];
      assert.deepEqual(engineWebVersion([unreal, page(".")], found), page(folder));
      // Genex's web starter at the root gives way to the build, as for a Unity or Godot game.
      assert.deepEqual(withEngineWebVersion([unreal, page(".")], found, true), [unreal, page(folder)].sort(byPath));
    }
    assert.equal(engineWebVersion([unreal], [unreal, page("web")]), null, "mockups in web/ are not listed as it");
  });

  it("is the web game of a game that began as Genex's web starter, once the starter's page is gone", async () => {
    const lite = await coreLite();
    try {
      await lite.core.plugins.setEnabled("unreal", true);
      const game = await lite.core.games.scaffold("strike");
      for (const file of ["unreal/Strike.uproject", "web/index.html", `web/${UNREAL_WEB_BUILD_MARKER}`]) {
        await mkdir(path.dirname(path.join(game.dir, file)), { recursive: true });
        await writeFile(path.join(game.dir, file), "{}\n");
      }
      const listed = async () => (await lite.core.games.list()).find((entry) => entry.name === game.name);
      // The starter's own page, nothing built on it, gives way to the build.
      assert.equal(webFolderOf({ facts: (await listed())?.facts ?? [] }), "web");
      // With the page gone only studio.json still records the starter: Publish looked for index.html
      // at the root and refused ("Selected public path is missing or unreadable: index.html").
      await unlink(path.join(game.dir, "index.html"));
      const facts = (await listed())?.facts ?? [];
      assert.deepEqual(
        facts.map((fact) => `${fact.id}@${fact.path}`),
        [`${CoreFact.UnrealProject}@unreal`, `${UNREAL_WEB_BUILD_FACT}@web`, `${CoreFact.WebGame}@web`],
      );
      assert.equal(webFolderOf({ facts }), "web");
      assert.equal(publishesAsWebGame({ facts }), true);
      // The same with the starter's code gone too, as in the folder this was found in.
      await unlink(path.join(game.dir, "src", "main.js"));
      assert.equal(webFolderOf({ facts: (await listed())?.facts ?? [] }), "web");
    } finally {
      lite.core.plugins.cancel();
      await lite.close();
    }
  });

  it("the Unreal plugin's manifest finds the build by the file Unreal writes at its root", () => {
    const manifest = JSON.parse(readFileSync("src/plugins/unreal/plugin.json", "utf8")) as {
      detect: Array<{ fact: string; files: string[] }>;
    };
    const rule = manifest.detect.find((entry) => entry.fact === UNREAL_WEB_BUILD_FACT);
    assert.deepEqual(rule?.files, [`**/${UNREAL_WEB_BUILD_MARKER}`]);
    const files = [
      "unreal/Dust.uproject",
      "web/index.html",
      "web/wasm-manifest.json",
      "web/Dust/Binaries/Wasm/Dust.wasm",
    ];
    const facts = factsOfFiles(files, [
      { rule: { fact: UNREAL_WEB_BUILD_FACT, files: rule?.files ?? [] }, source: PLUGIN },
    ]);
    assert.deepEqual(facts, [build("web")]);
  });

  it("Live takes the build as finished once its files are left alone: it reaches web/ whole, in one move", () => {
    const NOW = 1_000_000;
    const files = new Set(["Dust/Binaries/Wasm/Dust.wasm", "index.html", "wasm-manifest.json"]);
    const kinds = [CoreFact.UnrealProject, CoreFact.WebGame, UNREAL_WEB_BUILD_FACT];
    assert.equal(buildFinished({ print: "p", files, newestMs: NOW - BUILD_SETTLE_MS }, kinds, NOW), true);
    assert.equal(buildFinished({ print: "p", files, newestMs: NOW - 1 }, kinds, NOW), false, "just written");
    assert.equal(buildFinished({ print: "p", files: new Set(), newestMs: 0 }, kinds, NOW), false, "an empty folder");
    assert.equal(
      buildFinished({ print: "p", files, newestMs: 0 }, [CoreFact.UnrealProject, CoreFact.WebGame], NOW),
      false,
      "a page in an Unreal game that Unreal did not build",
    );
  });

  it("with none, Publish offers an Unreal game no web row to make", () => {
    assert.equal(webOfferFor([unreal]), WebOffer.Unavailable);
    const missing = { target: PublishTarget.Web, state: PublishPlatformState.Missing } as PublishPlatform;
    assert.deepEqual(shownRows(platformRows([missing], 0, undefined, webOfferFor([unreal]))), []);
  });

  it("with one, Publish lists its web row ready to send, as for a Unity or Godot game", async () => {
    const root = await tmpDir("unreal-web-publish-");
    for (const file of ["unreal/Dust.uproject", "web/index.html", "web/wasm-manifest.json"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "{}");
    }
    const facts = [unreal, page("web"), build("web")];
    const core = {
      games: { list: async () => [{ name: "dust", facts }] },
      pluginBinding: async () => ({ project: "dust", directory: root }),
    } as unknown as Parameters<typeof publishPlatforms>[0];
    const web = (await publishPlatforms(core, "dust", true)).find((row) => row.target === PublishTarget.Web);
    assert.deepEqual([web?.state, web?.uploads], [PublishPlatformState.Ready, true]);
    const rows = shownRows(platformRows(web ? [web] : [], 0, undefined, webOfferFor(facts)));
    assert.deepEqual(
      rows.map((row) => [row.target, row.detail]),
      [[PublishTarget.Web, "Plays right away"]],
    );
  });
});

const byPath = (a: ProjectFact, b: ProjectFact) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1);
