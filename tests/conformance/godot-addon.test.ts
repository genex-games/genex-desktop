/**
 * Setting a Godot game up for Genex's play: the Genex addon (the Play Protocol autoload) in the
 * project, its autoload line, the bin/play launcher and studio.json's bridge runtime; every file the
 * person's (nothing through a link, their changes kept as .mine, every other studio.json key kept);
 * and the backend's New game, Set up and its review over it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import {
  ADDON_FOLDER,
  AddonError,
  addonState,
  isSetUp,
  LAUNCHER,
  launcherText,
  setUpGame,
  withAutoload,
  withEditorPlugin,
} from "../../src/plugins/godot/genex-addon.ts";
import { ADDON, godotBackendFixture } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
/** A shell string literal, as a test writes its own stand-in script. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const SETTINGS = 'config_version=5\n\n[application]\n\nconfig/name="Moon"\n';
const AUTOLOAD = 'GenexPlay="*res://addons/genex/play_protocol.gd"';
const EDITOR_PLUGIN = '"res://addons/genex/plugin.cfg"';

/** A game with a Godot project at `where` (relative), and its studio.json as given. */
async function game(where = "godot", studio: object | null = { title: "Moon" }) {
  const dir = await realpath(await tmpDir("studio-godot-addon-"));
  const project = path.join(dir, where);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "project.godot"), SETTINGS);
  if (studio) await writeFile(path.join(dir, "studio.json"), JSON.stringify(studio));
  return { dir, project };
}

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("the Genex addon in a Godot project", () => {
  it("adds its autoload once: a section of its own, or a line in the one there", () => {
    const added = withAutoload(SETTINGS);
    assert.match(added, /\[autoload\]\n\nGenexPlay="\*res:\/\/addons\/genex\/play_protocol\.gd"\n$/);
    assert.equal(withAutoload(added), added, "twice is once");
    const other = `${SETTINGS}\n[autoload]\n\nScore="*res://score.gd"\n\n[display]\n`;
    const merged = withAutoload(other);
    assert.ok(merged.includes(`[autoload]\n${AUTOLOAD}\n\nScore=`));
    assert.ok(merged.endsWith("[display]\n"), "the sections after it stay");
  });

  it("turns its editor plugin on once, beside the person's own", () => {
    const rows: Array<[string, string, string]> = [
      ["no section", SETTINGS, `${SETTINGS}\n[editor_plugins]\n\nenabled=PackedStringArray(${EDITOR_PLUGIN})\n`],
      [
        "a section with no list",
        `${SETTINGS}\n[editor_plugins]\n\n[display]\n`,
        `${SETTINGS}\n[editor_plugins]\nenabled=PackedStringArray(${EDITOR_PLUGIN})\n\n[display]\n`,
      ],
      [
        "the person's plugins",
        `[editor_plugins]\n\nenabled=PackedStringArray("res://addons/dialogue/plugin.cfg")\n`,
        `[editor_plugins]\n\nenabled=PackedStringArray("res://addons/dialogue/plugin.cfg", ${EDITOR_PLUGIN})\n`,
      ],
      [
        "an empty list",
        `[editor_plugins]\nenabled=PackedStringArray()\n`,
        `[editor_plugins]\nenabled=PackedStringArray(${EDITOR_PLUGIN})\n`,
      ],
    ];
    for (const [what, settings, enabled] of rows) {
      assert.equal(withEditorPlugin(settings), enabled, what);
      assert.equal(withEditorPlugin(enabled), enabled, `${what}: twice is once`);
    }
    const later = `[editor_plugins]\n\n[other]\nenabled=PackedStringArray("res://x/plugin.cfg")\n`;
    assert.ok(
      withEditorPlugin(later).startsWith(`[editor_plugins]\nenabled=PackedStringArray(${EDITOR_PLUGIN})\n`),
      "another section's list stays its own",
    );
  });

  it("launches the project with Genex's play on, from GENEX_GODOT, the install found, the usual places or the PATH", () => {
    const text = launcherText("godot", "/Apps/It's Godot.app/Contents/MacOS/Godot");
    assert.ok(text.startsWith("#!/bin/sh\n"));
    assert.ok(text.includes(`"$GENEX_GODOT" '/Apps/It'\\''s Godot.app/Contents/MacOS/Godot'`), "a found path, quoted");
    assert.ok(text.includes(`--path "$root"/'godot' --no-header --fixed-fps 60 --max-fps 60`));
    assert.ok(text.includes('-- --play-protocol "$@"'));
    assert.ok(text.includes('{"event":"fatal"'), "no Godot is a fatal line the studio reads");
    assert.ok(launcherText(".", null).includes('--path "$root" '), "a project at the game's root");
  });

  it("hands Godot the project's folder whatever its name holds, running none of it", async () => {
    const base = await realpath(await tmpDir("godot-launcher-"));
    const fakeGodot = path.join(base, "godot");
    // The stand-in Godot writes the folder it was given into a file beside it.
    await writeFile(
      fakeGodot,
      `#!/bin/sh\nwhile [ "$1" != "--path" ]; do shift; done\nprintf '%s' "$2" > ${shellQuote(path.join(base, "given"))}\n`,
      { mode: 0o755 },
    );
    const hostile = [
      'quote"d',
      "dollar$HOME",
      "sub$(touch pwned)",
      "tick`touch pwned`",
      "it's",
      "two  spaces",
      "back\\slash",
      "nested/dir",
    ];
    for (const name of hostile) {
      const game = path.join(base, `game-${hostile.indexOf(name)}`);
      await mkdir(path.join(game, "bin"), { recursive: true });
      await mkdir(path.join(game, name), { recursive: true });
      const launcher = path.join(game, "bin", "play");
      await writeFile(launcher, launcherText(name, null), { mode: 0o755 });
      await execFileAsync("/bin/sh", [launcher], { cwd: base, env: { ...process.env, GENEX_GODOT: fakeGodot } });
      assert.equal(await readFile(path.join(base, "given"), "utf8"), path.join(game, name), name);
      assert.equal(existsSync(path.join(base, "pwned")), false, `${name}: nothing in the name ran`);
      assert.equal(existsSync(path.join(game, "pwned")), false, `${name}: nothing in the name ran`);
    }
  });

  it("sets a game up: the addon, its autoload, an executable launcher and the bridge, every other key kept", async () => {
    const { dir, project } = await game();
    assert.deepEqual(await addonState(dir, project, ADDON), {
      addon: "missing",
      autoload: false,
      editor: false,
      launcher: false,
      bridge: false,
    });
    assert.deepEqual(await setUpGame(dir, project, ADDON, "/Applications/Godot.app/Contents/MacOS/Godot"), []);
    const state = await addonState(dir, project, ADDON);
    assert.ok(isSetUp(state), JSON.stringify(state));
    assert.equal(
      await readFile(path.join(project, ADDON_FOLDER, "play_protocol.gd"), "utf8"),
      await readFile(path.join(ADDON, "play_protocol.gd"), "utf8"),
    );
    const settings = await readFile(path.join(project, "project.godot"), "utf8");
    assert.ok(settings.includes(AUTOLOAD));
    assert.ok(settings.includes(`[editor_plugins]\n\nenabled=PackedStringArray(${EDITOR_PLUGIN})`), settings);
    assert.equal(((await lstat(path.join(dir, LAUNCHER))).mode & 0o111) !== 0, true, "the launcher runs");
    assert.deepEqual(await json(path.join(dir, "studio.json")), {
      title: "Moon",
      runtime: "bridge",
      play: {
        command: "bin/play",
        engine: {
          runtime: "godot",
          args: [
            "--path",
            "godot",
            "--no-header",
            "--fixed-fps",
            "60",
            "--max-fps",
            "60",
            "--position",
            "-10000,-10000",
            "--",
            "--play-protocol",
          ],
        },
      },
    });
  });

  it("keeps a Genex file the person changed beside the new one as .mine, and says it did", async () => {
    const { dir, project } = await game(".", null);
    await mkdir(path.join(project, ADDON_FOLDER), { recursive: true });
    await writeFile(path.join(project, ADDON_FOLDER, "play_protocol.gd"), "# mine\n");
    assert.equal((await addonState(dir, project, ADDON)).addon, "outdated");
    assert.deepEqual(await setUpGame(dir, project, ADDON, null), ["play_protocol.gd"]);
    assert.equal(await readFile(path.join(project, ADDON_FOLDER, "play_protocol.gd.mine"), "utf8"), "# mine\n");
    assert.ok((await readFile(path.join(dir, LAUNCHER), "utf8")).includes('--path "$root" '));
  });

  it("writes nothing through a link, and nothing outside the game", async () => {
    const outside = await realpath(await tmpDir("studio-godot-outside-"));
    const rows: Array<[string, (dir: string) => Promise<void>]> = [
      ["addons", (dir) => symlink(outside, path.join(dir, "godot", "addons"))],
      [
        "addons/genex",
        async (dir) => {
          await mkdir(path.join(dir, "godot", "addons"), { recursive: true });
          await symlink(outside, path.join(dir, "godot", ADDON_FOLDER));
        },
      ],
      ["studio.json", (dir) => symlink(path.join(outside, "studio.json"), path.join(dir, "studio.json"))],
      ["bin", (dir) => symlink(outside, path.join(dir, "bin"))],
      [
        "project.godot",
        async (dir) => {
          await writeFile(path.join(outside, "project.godot"), SETTINGS);
          await rm(path.join(dir, "godot", "project.godot"));
          await symlink(path.join(outside, "project.godot"), path.join(dir, "godot", "project.godot"));
        },
      ],
    ];
    for (const [label, plant] of rows) {
      const { dir, project } = await game("godot", null);
      await plant(dir);
      await assert.rejects(setUpGame(dir, project, ADDON, null), AddonError, label);
    }
    assert.equal(await readFile(path.join(outside, "project.godot"), "utf8"), SETTINGS, "the linked settings stay");
    assert.deepEqual((await readdir(outside)).sort(), ["project.godot"], "no addon file written through a link");
    const elsewhere = await game();
    await assert.rejects(setUpGame(elsewhere.dir, outside, ADDON, null), AddonError, "a project outside the game");
  });
});

describe("New game and Set up", () => {
  it("a new Godot game is set up for Genex's play from the start", async () => {
    const fixture = await godotBackendFixture();
    await fixture.backend.tool?.(GodotTool.NewGame, { template: "2d", name: "Moon" }, fixture.context());
    const status = (await fixture.backend.action?.("status", {}, fixture.context())) as { setup: object };
    assert.deepEqual(status.setup, { addon: "current", autoload: true, editor: true, launcher: true, bridge: true });
    const launcher = await readFile(path.join(fixture.gameDir, LAUNCHER), "utf8");
    assert.ok(launcher.includes(path.join(fixture.root, "Applications", "Godot.app")), "the install found comes first");
  });

  it("sets an existing Godot game up after the person confirms what it will change", async () => {
    const fixture = await godotBackendFixture();
    await mkdir(path.join(fixture.gameDir, "client"), { recursive: true });
    await writeFile(path.join(fixture.gameDir, "client", "project.godot"), SETTINGS);
    const review = await fixture.backend.review?.("set-up", {}, fixture.context());
    assert.match(String(review?.detail), /client\/addons\/genex/);
    const answer = String(await fixture.backend.tool?.(GodotTool.SetUp, {}, fixture.context()));
    assert.match(answer, /set up for Genex's play/);
    assert.ok((await readFile(path.join(fixture.gameDir, "client", "project.godot"), "utf8")).includes(AUTOLOAD));
  });
});
