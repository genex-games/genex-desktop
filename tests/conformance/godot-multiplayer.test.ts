/**
 * Genex multiplayer in a Godot game through the plugin's backend on a fake Mac: `godot__multiplayer`
 * puts Genex's addon and its autoload, the Colyseus GDExtension native builds connect with (a
 * release checked against its pin before anything of it is used), the game's Genex project and its
 * matchmaking into the game, and Genex's Web preset loads the SDK's bridge, which the web export
 * then carries beside its page. Arguments are checked before anything is written, and nothing is
 * written through a link.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { type GodotCall, GodotJob } from "../../src/plugins/godot/godot-run.ts";
import {
  BRIDGE_LICENSES_FILE,
  BRIDGE_PAGE_FILE,
  colyseusExtension,
  GenexSetting,
  genexSetting,
  withGenexSetting,
} from "../../src/plugins/godot/multiplayer.ts";
import { withMultiplayerWebPreset, withWebPreset } from "../../src/plugins/godot/web-export.ts";
import type { AppRunner } from "../../src/substrate/app-install.ts";
import { godotBackendFixture, MULTIPLAYER } from "../helpers/godot-fake-engine.ts";

const TEMPLATES = "Library/Application Support/Godot/export_templates/4.6.1.stable";
/** The bytes the fake release download answers, and the release pinned to them. */
const RELEASE_BYTES = Buffer.from("a Colyseus Godot release, as the test serves it");
const RELEASE = {
  version: "0.18.5",
  url: "https://downloads.test/colyseus-godot-0.18.5.zip",
  sha256: createHash("sha256").update(RELEASE_BYTES).digest("hex"),
};

/**
 * The network and `unzip` as the fake Mac has them: every download answers `bytes`, and `unzip`
 * writes each entry it is asked for (a library as bytes, `version.json` naming the release).
 */
function fakeDownloads(bytes: Buffer = RELEASE_BYTES) {
  const fetched: string[] = [];
  const unzipped: string[][] = [];
  const fetch = (async (url: string | URL) => {
    fetched.push(String(url));
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof globalThis.fetch;
  const run: AppRunner = async (command, args) => {
    unzipped.push([command, ...args]);
    const into = args[args.indexOf("-d") + 1] ?? "";
    for (const entry of args.slice(3, args.indexOf("-d"))) {
      const file = path.join(into, entry);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, entry.endsWith("version.json") ? '{\n    "version": "0.18.5"\n}' : `bytes of ${entry}`);
    }
    return { out: "", err: "" };
  };
  return { fetch, run, fetched, unzipped };
}

/** Godot's export as the fake runner plays it: the page and its files in the folder it was given. */
async function exported(call: GodotCall): Promise<string> {
  const page = call.args.at(-1) ?? "";
  for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
    await writeFile(path.join(path.dirname(page), name), name);
  return "";
}

/** A game with a 3D project New Godot game made, the Web template installed, and downloads as given. */
async function godotGame(downloads = fakeDownloads()) {
  const fixture = await godotBackendFixture({
    answers: { [GodotJob.Export]: exported },
    install: { fetch: downloads.fetch, run: downloads.run, applications: "/nowhere", trash: "/nowhere" },
    release: RELEASE,
  });
  await fixture.backend.tool?.(GodotTool.NewGame, { template: "3d", name: "Tanks" }, fixture.context());
  await mkdir(path.join(fixture.home, TEMPLATES), { recursive: true });
  await writeFile(path.join(fixture.home, TEMPLATES, "web_nothreads_release.zip"), "zip");
  const project = path.join(fixture.gameDir, "godot");
  // An object parameter (API 3) reaches the backend as an object; the SDK's type names scalars only.
  const call = async (args: Record<string, unknown> = {}) =>
    String(
      await fixture.backend.tool?.(GodotTool.Multiplayer, args as Record<string, PluginScalar>, fixture.context()),
    );
  const exportGame = async () => fixture.backend.tool?.(GodotTool.WebExport, {}, fixture.context());
  return { ...fixture, downloads, project, web: path.join(fixture.gameDir, "web"), call, exportGame };
}

const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

describe("Genex multiplayer in a Godot game", () => {
  it("adds the addon and its autoload, the native GDExtension, the game's project and matchmaking, and the bridge to the Web preset", async () => {
    const game = await godotGame();
    const matchmaking = { preset: "open", config: { minPlayers: 2, maxPlayers: 10 } };
    const answer = await game.call({ slug: "world-of-tanks-clone", matchmaking });
    assert.match(answer, /Genex multiplayer is in this game's Godot project/);
    assert.match(answer, /Native builds \(macOS, Windows, Linux\) play online too/);
    assert.match(answer, /Its Genex project is world-of-tanks-clone/);

    const shipped = (await readdir(MULTIPLAYER.addon)).sort();
    assert.deepEqual((await readdir(path.join(game.project, "addons/genex_multiplayer"))).sort(), shipped);
    const settings = await readFile(path.join(game.project, "project.godot"), "utf8");
    assert.match(settings, /GenexMultiplayer="\*res:\/\/addons\/genex_multiplayer\/genex_multiplayer\.gd"/);
    assert.match(settings, /GenexPlay="\*res:\/\/addons\/genex\/play_protocol\.gd"/, "Genex's play autoload stays");
    assert.equal(genexSetting(settings, GenexSetting.Slug), "world-of-tanks-clone");
    assert.equal(genexSetting(settings, GenexSetting.ApiUrl), "https://api.genex.games");

    const colyseus = path.join(game.project, "addons/colyseus");
    assert.deepEqual((await readdir(path.join(colyseus, "bin"))).sort(), [
      "colyseus_godot.windows.x86_64.release.dll",
      "libcolyseus_godot.linux.x86_64.release.so",
      "libcolyseus_godot.macos.release.dylib",
    ]);
    assert.equal(await readFile(path.join(colyseus, "colyseus.gdextension"), "utf8"), colyseusExtension());
    assert.match(await readFile(path.join(colyseus, "LICENSE"), "utf8"), /MIT License/);

    assert.deepEqual(JSON.parse(await readFile(path.join(game.gameDir, "genex.json"), "utf8")), { matchmaking });
    const presets = await readFile(path.join(game.project, "export_presets.cfg"), "utf8");
    assert.match(presets, /html\/head_include="<script src=\\"genex-multiplayer-bridge\.js\\"><\/script>"/);
    assert.match(presets, /exclude_filter="addons\/colyseus\/\*"/);
    assert.ok(
      game.jobs.some((job) => job.call.job === GodotJob.Import),
      "Godot imports the project, so the extension registers",
    );
  });

  it("is the same the second time, downloads the release once, and keeps the slug it was given", async () => {
    const game = await godotGame();
    await game.call({ slug: "rain-circuit" });
    const settings = await readFile(path.join(game.project, "project.godot"), "utf8");
    const presets = await readFile(path.join(game.project, "export_presets.cfg"), "utf8");
    await game.call();
    assert.equal(await readFile(path.join(game.project, "project.godot"), "utf8"), settings, "twice is once");
    assert.equal(await readFile(path.join(game.project, "export_presets.cfg"), "utf8"), presets);
    assert.equal(game.downloads.fetched.length, 1, "the checked release stays in the plugin's storage");
    assert.equal(game.downloads.unzipped.length, 1);
    const [command, ...args] = game.downloads.unzipped[0] ?? [];
    assert.equal(command, "/usr/bin/unzip");
    assert.ok(!args.some((arg) => arg.includes(".debug.")), "no debug build is unpacked");
  });

  it("before the first publish, says Genex's Play and the published page name the game, so a publish needs no rebuild", async () => {
    const game = await godotGame();
    const answer = await game.call();
    assert.match(answer, /no Genex project yet/);
    assert.match(answer, /GENEX_GAME/);
    assert.match(answer, /window\.__GENEX__\.slug/);
    assert.doesNotMatch(answer, /so native builds know which game to join/, "a publish needs no second build");
  });

  it("keeps a Genex file the person changed beside the new one as .mine", async () => {
    const game = await godotGame();
    await game.call();
    const theirs = path.join(game.project, "addons/genex_multiplayer/identity.gd");
    await writeFile(theirs, "# my own identity\n");
    const answer = await game.call();
    assert.match(answer, /Kept your changed identity\.gd beside the new ones as \.mine/);
    assert.equal(await readFile(`${theirs}.mine`, "utf8"), "# my own identity\n");
    assert.equal(await readFile(theirs, "utf8"), await readFile(path.join(MULTIPLAYER.addon, "identity.gd"), "utf8"));
  });

  it("refuses a slug or matchmaking that isn't one before writing anything", async () => {
    const game = await godotGame();
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a path", { slug: "../other-game" }],
      ["a settings line", { slug: 'x"\n[autoload]\nEvil="*res://evil.gd"' }],
      ["upper case and spaces", { slug: "My Game" }],
      ["not text", { slug: 42 }],
      ["an unknown preset", { matchmaking: { preset: "battle-royale" } }],
      ["an unknown win condition", { matchmaking: { preset: "arena", winCondition: "mostHats" } }],
      ["a knob that isn't a number", { matchmaking: { preset: "open", config: { maxPlayers: "ten" } } }],
      ["a knob named as a path", { matchmaking: { preset: "open", config: { "../x": 1 } } }],
      ["a list", { matchmaking: ["open"] }],
    ];
    const settings = await readFile(path.join(game.project, "project.godot"), "utf8");
    for (const [name, args] of rows) {
      await assert.rejects(game.call(args), name);
      assert.equal(await exists(path.join(game.project, "addons/genex_multiplayer")), false, name);
      assert.equal(await exists(path.join(game.gameDir, "genex.json")), false, name);
      assert.equal(await readFile(path.join(game.project, "project.godot"), "utf8"), settings, name);
    }
    assert.equal(game.downloads.fetched.length, 0, "nothing was downloaded");
  });

  it("never uses a download that isn't the pinned release: the web build still plays online, and native says why", async () => {
    const game = await godotGame(fakeDownloads(Buffer.from("something else")));
    const answer = await game.call();
    assert.match(answer, /Native builds can't play online yet: .*isn't the one it pins/);
    assert.equal(await exists(path.join(game.project, "addons/colyseus")), false);
    assert.equal(game.downloads.unzipped.length, 0, "nothing of it was unpacked");
    assert.deepEqual(await readdir(path.join(game.storage, "multiplayer")), [], "nor kept");
    assert.equal(await exists(path.join(game.project, "addons/genex_multiplayer/plugin.cfg")), true);
  });

  it("writes nothing through a link", async () => {
    const rows = ["godot/addons/genex_multiplayer", "godot/addons/colyseus", "genex.json"];
    for (const at of rows) {
      const game = await godotGame();
      const outside = path.join(game.root, "outside");
      await mkdir(outside, { recursive: true });
      await mkdir(path.join(game.project, "addons"), { recursive: true });
      await symlink(at.endsWith(".json") ? path.join(outside, "x.json") : outside, path.join(game.gameDir, at));
      const answer = await game.call({ matchmaking: { preset: "duel" } }).catch((error: Error) => error.message);
      assert.match(answer, /link|Native builds can't play online yet/, at);
      assert.deepEqual(await readdir(outside), [], `${at}: nothing written outside the game`);
    }
  });

  it("exports the web build with Genex's SDK bridge beside its page, and a single-player game without it", async () => {
    const single = await godotGame();
    await single.exportGame();
    assert.equal(await exists(path.join(single.web, BRIDGE_PAGE_FILE)), false);
    assert.equal(await exists(path.join(single.web, BRIDGE_LICENSES_FILE)), false);
    assert.doesNotMatch(await readFile(path.join(single.project, "export_presets.cfg"), "utf8"), /head_include/);

    const game = await godotGame();
    await game.call();
    await game.exportGame();
    assert.deepEqual(
      await readFile(path.join(game.web, BRIDGE_PAGE_FILE)),
      await readFile(MULTIPLAYER.bridge),
      "the SDK's bridge as Studio pins it",
    );
    assert.equal(
      await readFile(path.join(game.web, BRIDGE_LICENSES_FILE), "utf8"),
      await readFile(MULTIPLAYER.bridgeLicenses, "utf8"),
      "with the licenses of what it bundles, which the bridge carries none of",
    );
  });
});

describe("Genex's Web preset for a multiplayer game", () => {
  it("loads the bridge and leaves the native extension out, once, and leaves the person's presets alone", () => {
    const theirs =
      '[preset.0]\n\nname="macOS"\nplatform="macOS"\nexclude_filter=""\n\n[preset.0.options]\n\nhtml/head_include=""\n';
    const added = withMultiplayerWebPreset(withWebPreset(theirs));
    assert.ok(added.startsWith(theirs.trimEnd()), "the person's preset stays as it was");
    const genex = added.slice(added.indexOf("[preset.1]"));
    assert.match(genex, /exclude_filter="addons\/colyseus\/\*"/);
    assert.match(genex, /html\/head_include="<script src=\\"genex-multiplayer-bridge\.js\\"><\/script>"/);
    assert.equal(withMultiplayerWebPreset(added), added, "twice is once");
    assert.equal(withMultiplayerWebPreset(theirs), theirs, "no Genex preset, nothing to change");
  });
});

describe("the game's Genex project in project.godot", () => {
  it("is read back as written, beside Genex's other settings, whatever the value holds", () => {
    const settings = '[application]\n\nconfig/name="Tanks"\n\n[genex]\n\nshot_keys="enter 0.2"\n';
    const written = withGenexSetting(settings, GenexSetting.Slug, "world-of-tanks-clone");
    assert.equal(genexSetting(written, GenexSetting.Slug), "world-of-tanks-clone");
    assert.match(written, /shot_keys="enter 0\.2"/, "Genex's other settings stay");
    const again = withGenexSetting(written, GenexSetting.Slug, "rain-circuit");
    assert.equal(genexSetting(again, GenexSetting.Slug), "rain-circuit", "replaced, not added twice");
    assert.equal(again.match(/^slug=/gm)?.length, 1);
    const quoted = withGenexSetting("", GenexSetting.ApiUrl, 'a "quoted" \\ value');
    assert.equal(genexSetting(quoted, GenexSetting.ApiUrl), 'a "quoted" \\ value');
    assert.equal(genexSetting(settings, GenexSetting.Slug), null);
  });

  it("names only the desktop release libraries in the native extension, for the editor and exports alike", () => {
    const extension = colyseusExtension();
    assert.doesNotMatch(extension, /\.debug\.(dylib|dll|so|wasm)/, "no debug build: they weigh up to 97 MB each");
    for (const tag of ["macos.debug", "macos.release", "windows.debug.x86_64", "linux.release.x86_64"])
      assert.match(extension, new RegExp(`^${tag.replaceAll(".", "\\.")} = "bin/`, "m"), tag);
    assert.match(extension, /entry_symbol = "colyseus_sdk_init"/);
  });
});
