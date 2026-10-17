/**
 * The Godot plugin through its backend's interface on a fake Mac: its manifest as Genex reads it,
 * the agent's tools (each Godot job recorded with what it may read and write, answered with
 * Godot's recorded words), Genex's moments and observer, and the panel's and toolbar's actions.
 * Nothing here starts Godot; `godot-live.test.ts` does, on request.
 */
import assert from "node:assert/strict";
import { readdir, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { isEditorOf } from "../../src/plugins/godot/editor.ts";
import { GodotJob } from "../../src/plugins/godot/godot-run.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { ObserverLive } from "../../src/shared/observers.ts";
import { stageCardFrom } from "../../src/shared/plugin-stage-card.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { capturing, godotBackendFixture, playArg, godotOutput, SCRIPTS } from "../helpers/godot-fake-engine.ts";

type Answer = Record<string, unknown>;
const tool = async (fixture: Awaited<ReturnType<typeof godotBackendFixture>>, name: string, args = {}, more = {}) =>
  (await fixture.backend.tool?.(name, args, fixture.context(more))) as Answer;
const action = async (fixture: Awaited<ReturnType<typeof godotBackendFixture>>, name: string, args = {}) =>
  (await fixture.backend.action?.(name, args, fixture.context())) as Answer;

/** A game whose Godot project New Godot game made, its jobs since cleared. */
async function withProject(options: Parameters<typeof godotBackendFixture>[0] = {}) {
  const fixture = await godotBackendFixture(options);
  await tool(fixture, GodotTool.NewGame, { template: "3d", name: "Valley" });
  fixture.jobs.length = 0;
  return { ...fixture, project: path.join(fixture.gameDir, "godot") };
}

/** The Godot manifest as Genex reads it. */
const MANIFEST = validateManifest(JSON.parse(readFileSync("src/plugins/godot/plugin.json", "utf8")) as PluginManifest);

describe("the Godot manifest", () => {
  const manifest = MANIFEST;

  it("is valid and declares exactly the backend's tools", () => {
    assert.deepEqual(manifest.tools.map((t) => t.name).sort(), Object.values(GodotTool).sort());
    assert.equal(manifest.tools.find((t) => t.name === GodotTool.NewGame)?.ready, GodotTool.EngineStatus);
    assert.deepEqual(manifest.tools.find((t) => t.name === GodotTool.NewGame)?.makes, ["godot-project"]);
  });

  it("runs only quiet harness tools at its moments and as its observer, which Live shows as its card", () => {
    const harness = new Set(manifest.tools.filter((t) => t.audience === "harness").map((t) => t.name));
    for (const hook of manifest.hooks ?? []) assert.ok(harness.has(hook.tool), hook.tool);
    assert.deepEqual(
      (manifest.hooks ?? []).map((h) => [h.on, h.tool]),
      [
        [HookEvent.CheckpointBefore, GodotTool.SaveAll],
        [HookEvent.CheckpointBefore, GodotTool.CheckpointCheck],
        [HookEvent.CheckpointAfter, GodotTool.HeroShots],
        [HookEvent.RestoreBefore, GodotTool.SaveAll],
        [HookEvent.RestoreAfter, GodotTool.ReloadEditor],
        [HookEvent.TurnEnd, GodotTool.KeepWebBuild],
        [HookEvent.RestoreAfter, GodotTool.KeepWebBuild],
      ],
    );
    assert.deepEqual(
      (manifest.observers ?? []).map((o) => [o.id, o.tool, o.live, o.status]),
      [["viewport", GodotTool.HeroShots, ObserverLive.Card, "stage-status"]],
    );
  });

  it("offers its skill and project tools only in a Godot project", () => {
    for (const name of [GodotTool.Check, GodotTool.RunScene, GodotTool.Screenshot])
      assert.deepEqual(manifest.tools.find((t) => t.name === name)?.facts, ["godot-project"], name);
    assert.deepEqual(manifest.skills?.[0]?.facts, ["godot-project"]);
  });
});

describe("making a Godot game", () => {
  it("says whether a game can be made here, and how the engine question offers Godot", async () => {
    const ready = await tool(await godotBackendFixture(), GodotTool.EngineStatus);
    assert.equal(ready.ready, true);
    assert.match(String(ready.note), /godot__new-game/);
    const none = await tool(await godotBackendFixture({ apps: [] }), GodotTool.EngineStatus);
    assert.equal(none.ready, false);
    assert.match(String(none.note), /godot__show-steps/, "the setup card installs Godot");
    assert.doesNotMatch(String(none.note), /call godot__new-game with/);
  });

  it("makes the project in the game's godot folder and imports it in the sandbox, writing only there", async () => {
    const fixture = await godotBackendFixture();
    const answer = String(
      await fixture.backend.tool?.(GodotTool.NewGame, { template: "2d", name: "Valley" }, fixture.context()),
    );
    assert.match(answer, /godot\//);
    const project = path.join(fixture.gameDir, "godot");
    assert.deepEqual(
      fixture.jobs.map((j) => [j.call.job, j.call.args, j.call.writes, j.call.gpu]),
      [[GodotJob.Import, ["--headless", "--path", project, "--import"], [project], false]],
    );
    assert.equal(fixture.jobs[0]?.binary.endsWith(path.join("Godot.app", "Contents", "MacOS", "Godot")), true);
  });

  it("a new game fills whatever size Live and the web page show it at: no black bars", async () => {
    for (const template of ["2d", "3d"]) {
      const fixture = await godotBackendFixture();
      await tool(fixture, GodotTool.NewGame, { template, name: "Valley" });
      const settings = await readFile(path.join(fixture.gameDir, "godot", "project.godot"), "utf8");
      const stretches = /^window\/stretch\/mode="(\w+)"$/m.exec(settings)?.[1];
      const aspect = /^window\/stretch\/aspect="(\w+)"$/m.exec(settings)?.[1];
      // A game that stretches widens its view to the space it has; one that doesn't is that space.
      if (stretches) assert.equal(aspect, "expand", `${template}: stretched to fill, never letterboxed`);
      else assert.equal(aspect, undefined, `${template}: its viewport is the window`);
    }
  });

  it("refuses outside a game, and without Godot, making nothing", async () => {
    const outside = await godotBackendFixture({ game: null });
    await assert.rejects(tool(outside, GodotTool.NewGame, { template: "3d", name: "Valley" }), /Open a game/);
    const none = await godotBackendFixture({ apps: [] });
    await assert.rejects(tool(none, GodotTool.NewGame, { template: "3d", name: "Valley" }), /isn't installed/);
    assert.deepEqual(await promisify(readdir)(none.gameDir), []);
  });
});

describe("the agent's Godot tools", () => {
  it("check imports, loads every file with Genex's script and names each problem by file and line", async () => {
    const fixture = await withProject({ answers: { [GodotJob.Check]: await godotOutput("check-parse-errors.log") } });
    const answer = await tool(fixture, GodotTool.Check);
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.errors, [
      'bad.gd:3: Parse Error: Cannot assign a value of type "String" as "int".',
      'bad.gd:3: Parse Error: Cannot assign a value of type String to variable "x" with specified type int.',
      'bad.gd:4: Parse Error: Function "undefined_call()" not found in base self.',
      'ERROR: Failed to load script "res://bad.gd" with error "Parse error".',
    ]);
    assert.match(String(answer.summary), /Loaded 6/);
    const [imported, checked] = fixture.jobs;
    assert.equal(imported?.call.job, GodotJob.Import);
    assert.deepEqual(checked?.call.args, [
      "--headless",
      "--path",
      fixture.project,
      "-s",
      path.join(SCRIPTS, "genex_check.gd"),
    ]);
    assert.deepEqual(checked?.call.reads, [SCRIPTS]);
    assert.deepEqual(checked?.call.writes, [fixture.project]);
  });

  it("run-scene plays the main scene 5 game seconds at 60 frames, answering its prints and errors", async () => {
    const printed = `READY Main\n${await godotOutput("run-null-call.log")}`;
    const fixture = await withProject({ answers: { [GodotJob.Run]: printed } });
    const answer = await tool(fixture, GodotTool.RunScene);
    assert.deepEqual(answer.errors, ["crash.gd:4: Invalid call. Nonexistent function 'boom' in base 'Nil'."]);
    assert.deepEqual(answer.output, ["READY Main"]);
    const run = fixture.jobs.find((j) => j.call.job === GodotJob.Run);
    assert.deepEqual(run?.call.args, [
      "--headless",
      "--path",
      fixture.project,
      "--fixed-fps",
      "60",
      "--quit-after",
      "300",
    ]);
  });

  it("run-scene refuses seconds and scenes it can't use before Godot runs", async () => {
    const fixture = await withProject();
    for (const seconds of [0, 61, 2.5, "soon"])
      await assert.rejects(tool(fixture, GodotTool.RunScene, { seconds }), /seconds/, String(seconds));
    for (const scene of ["../x.tscn", "/etc/hosts.tscn", "player.gd", "nope.tscn"])
      await assert.rejects(tool(fixture, GodotTool.RunScene, { scene }), /scene/, scene);
    assert.deepEqual(fixture.jobs, []);
  });

  it("screenshot answers the cameras' stills as pictures the model sees, and keeps none of them", async () => {
    const fixture = await withProject({ answers: { [GodotJob.Capture]: capturing(["HeroCamera", "Top"]) } });
    const answer = await tool(fixture, GodotTool.Screenshot, { max: 2 });
    assert.deepEqual(answer.shots, ["HeroCamera", "Top"]);
    const images = answer.images as Array<{ mimeType: string; data: string; label: string }>;
    assert.deepEqual(
      images.map((i) => [i.mimeType, i.label, i.data.length > 0]),
      [
        ["image/png", "HeroCamera", true],
        ["image/png", "Top", true],
      ],
    );
    const capture = fixture.jobs.find((j) => j.call.job === GodotJob.Capture);
    assert.equal(capture?.call.gpu, true);
    assert.ok(capture?.call.args.includes("most=2"), "at most the two cameras asked for");
    assert.deepEqual(await promisify(readdir)(path.join(fixture.storage, "stills")), []);
  });

  it("screenshot plays to a moment after keys, with a short recording, and run-scene presses keys headless", async () => {
    const fixture = await withProject({ answers: { [GodotJob.Capture]: capturing(["HeroCamera"]) } });
    const seen = await tool(fixture, GodotTool.Screenshot, { seconds: 2, keys: "right 1, space", frames: 4 });
    assert.deepEqual(seen.shots, ["HeroCamera", "HeroCamera-0.5s", "HeroCamera-1.0s", "HeroCamera-1.5s"]);
    const capture = fixture.jobs.find((j) => j.call.job === GodotJob.Capture)?.call;
    assert.ok(capture);
    assert.equal(playArg(capture, "keys"), "right@0:60;space@60:6");
    assert.equal(playArg(capture, "shots"), "120:all;30:first;60:first;90:first");
    assert.equal(playArg(capture, "frames"), "121");
    fixture.jobs.length = 0;
    await tool(fixture, GodotTool.RunScene, { seconds: 1, keys: "left 3" });
    const played = fixture.jobs.find((j) => j.call.job === GodotJob.Play)?.call;
    assert.ok(played);
    assert.ok(played.args.includes("--headless"), "a play with no stills runs headless");
    assert.equal(playArg(played, "frames"), "181", "it runs until the last key lets go");
    assert.equal(played.gpu, false);
  });

  it("refuses keys and moments it can't play before Godot runs", async () => {
    const fixture = await withProject();
    await assert.rejects(tool(fixture, GodotTool.Screenshot, { keys: "jump" }), /isn't a key/);
    await assert.rejects(tool(fixture, GodotTool.RunScene, { keys: "right 61" }), /60 seconds/);
    await assert.rejects(tool(fixture, GodotTool.Screenshot, { seconds: 0 }), /seconds is when/);
    assert.deepEqual(fixture.jobs, []);
  });

  it("screenshot says so when Godot saved nothing", async () => {
    const fixture = await withProject();
    await assert.rejects(tool(fixture, GodotTool.Screenshot), /no stills/);
  });

  it("class-reference makes the version's reference once and answers a class or a word", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<class name="CharacterBody3D" inherits="PhysicsBody3D">
	<methods>
		<method name="move_and_slide"><return type="bool" /></method>
		<method name="get_floor_angle" qualifiers="const"><return type="float" /><param index="0" name="up_direction" type="Vector3" default="Vector3(0, 1, 0)" /></method>
	</methods>
	<members><member name="velocity" type="Vector3" setter="set_velocity" getter="get_velocity" default="Vector3(0, 0, 0)"></member></members>
	<signals></signals>
</class>`;
    const dump = async (call: { args: string[] }) => {
      const folder = path.join(call.args.at(-1) ?? "", "doc", "classes");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "CharacterBody3D.xml"), xml);
      return "";
    };
    const fixture = await godotBackendFixture({ answers: { [GodotJob.Reference]: dump } });
    const whole = String(
      await fixture.backend.tool?.(GodotTool.ClassReference, { query: "characterbody3d" }, fixture.context()),
    );
    assert.match(whole, /^class CharacterBody3D extends PhysicsBody3D/);
    assert.match(whole, /get_floor_angle\(up_direction: Vector3 = Vector3\(0, 1, 0\)\) const -> float/);
    const word = String(
      await fixture.backend.tool?.(GodotTool.ClassReference, { query: "velocity" }, fixture.context()),
    );
    assert.equal(word, "CharacterBody3D.velocity: Vector3 = Vector3(0, 0, 0)");
    assert.equal(fixture.jobs.filter((j) => j.call.job === GodotJob.Reference).length, 1);
    const refused = String(
      await fixture.backend.tool?.(GodotTool.ClassReference, { query: "../x" }, fixture.context()),
    );
    assert.match(refused, /Ask for a Godot class/);
  });
});

describe("Genex's moments in a Godot game", () => {
  it("a checkpoint notes what Godot's check found, and never blocks", async () => {
    const fixture = await withProject({ answers: { [GodotJob.Check]: await godotOutput("check-parse-errors.log") } });
    const hook = { on: HookEvent.CheckpointBefore };
    const answer = await tool(fixture, GodotTool.CheckpointCheck, {}, { hook });
    assert.equal(answer.block, undefined);
    assert.match(String(answer.note), /^Godot's check found 4 problems: bad\.gd:3: .* \(and 1 more\)$/);
    const quiet = await withProject();
    assert.deepEqual(await tool(quiet, GodotTool.CheckpointCheck, {}, { hook }), {});
  });

  it("a checkpoint says nothing in a game with no project or on a Mac with no Godot", async () => {
    const hook = { on: HookEvent.CheckpointBefore };
    const empty = await godotBackendFixture();
    assert.deepEqual(await tool(empty, GodotTool.CheckpointCheck, {}, { hook }), {});
    assert.deepEqual(empty.jobs, []);
  });

  it("hero-shots takes stills for a run's save point and the observer, and none for a chat's checkpoint", async () => {
    const fixture = await withProject({ answers: { [GodotJob.Capture]: capturing(["HeroCamera"]) } });
    const chat = await tool(fixture, GodotTool.HeroShots, {}, { hook: { on: HookEvent.CheckpointAfter } });
    assert.deepEqual(chat, {});
    assert.equal(fixture.jobs.length, 0, "a chat's checkpoint runs no Godot");
    const run = await tool(fixture, GodotTool.HeroShots, {}, { hook: { on: HookEvent.CheckpointAfter, runId: "r1" } });
    assert.deepEqual(
      (run.images as Array<{ name: string }>).map((i) => i.name),
      ["HeroCamera"],
    );
    assert.deepEqual(
      fixture.jobs.map((j) => j.call.job),
      [GodotJob.Import, GodotJob.Capture],
      "a save point's stills come from an imported project",
    );
    const observe = { observer: "godot/viewport", runId: "r1", why: "finish" as const, withinMs: 30_000 };
    const seen = await tool(fixture, GodotTool.HeroShots, {}, { observe });
    assert.deepEqual(Object.keys(seen), ["images", "recording"], "the reviewer also gets a short recording");
    assert.deepEqual(
      (seen.recording as Array<{ name: string }>).map((frame) => frame.name),
      ["HeroCamera-1.0s", "HeroCamera-2.0s", "HeroCamera-4.0s", "HeroCamera-5.0s", "HeroCamera-6.0s"],
    );
    // Less time than keeping the pictures takes still asks for them, never fails the observer.
    const late = await tool(fixture, GodotTool.HeroShots, {}, { observe: { ...observe, withinMs: 1_000 } });
    assert.deepEqual(Object.keys(late), ["images", "recording"]);
  });
});

describe("the panel and the toolbar", () => {
  it("says to get Godot, names its version, asks to set a game up, and shows when Godot has it open", async () => {
    // The same word as Unity's and Unreal's: what is true, in grey; the setup card is where to get it.
    assert.deepEqual(await action(await godotBackendFixture({ apps: [] }), "toolbar-status"), {
      badge: "Not installed",
      tone: "info",
      dot: true,
      title: "Get Godot 4",
    });
    const fixture = await withProject();
    assert.deepEqual(await action(fixture, "toolbar-status"), { title: "Godot 4.6.1" });
    fixture.editor.lines.push(`/Applications/Godot.app/Contents/MacOS/Godot --path ${fixture.project} --editor`);
    assert.deepEqual(await action(fixture, "toolbar-status"), {
      tone: "ok",
      title: "Godot 4.6.1 has this game's project open",
    });
    const existing = await godotBackendFixture();
    await mkdir(path.join(existing.gameDir, "client"), { recursive: true });
    await writeFile(path.join(existing.gameDir, "client", "project.godot"), "config_version=5\n");
    assert.deepEqual(await action(existing, "toolbar-status"), {
      badge: "Set up",
      tone: "warn",
      title: "Set this Godot game up for Genex's play",
    });
    const status = await action(fixture, "status");
    assert.equal(status.project, "godot");
    assert.equal(status.editorOpen, true);
    assert.equal((status.godot as { version: string }).version, "4.6.1");
  });

  it("a game whose chat chose Godot before Godot was here shows the Godot button, and no other game does", async () => {
    const none = await godotBackendFixture({ apps: [] });
    assert.equal((await action(none, "toolbar-status")).shown, undefined, "nothing chosen yet");
    await assert.rejects(tool(none, GodotTool.NewGame, { template: "2d", name: "Moon" }), /godot__show-steps/);
    assert.equal((await action(none, "toolbar-status")).shown, true, "the refused game keeps its button out");
    const other = await none.backend.action?.("toolbar-status", {}, none.context({ project: "another" }));
    assert.equal((other as Answer).shown, undefined, "another game's strip stays as it was");
  });

  it("tells Live's card where the game stands in Godot, with the one step it needs", async () => {
    const actions = new Set(MANIFEST.actions.map((a) => a.name));
    const card = async (fixture: Awaited<ReturnType<typeof godotBackendFixture>>) =>
      stageCardFrom(await action(fixture, "stage-status"), actions);
    assert.deepEqual(await card(await godotBackendFixture({ apps: [] })), {
      line: "Plays in Godot 4, which isn't on this Mac yet.",
      button: { label: "Get Godot", panel: true },
    });
    assert.deepEqual(await card(await godotBackendFixture()), { line: "No Godot project in this game's folder yet." });
    const fixture = await withProject();
    assert.deepEqual(await card(fixture), {
      line: "Plays in Godot 4.6.1.",
      button: { label: "Open in Godot", action: "open-editor" },
    });
    fixture.editor.lines.push(`/Applications/Godot.app/Contents/MacOS/Godot --path ${fixture.project} --editor`);
    assert.deepEqual(await card(fixture), {
      line: "Open in Godot 4.6.1.",
      hint: "Your Godot reloads the files Genex changes.",
    });
    const existing = await godotBackendFixture();
    await mkdir(path.join(existing.gameDir, "client"), { recursive: true });
    await writeFile(path.join(existing.gameDir, "client", "project.godot"), "config_version=5\n");
    assert.deepEqual(await card(existing), {
      line: "Plays in Godot. Set it up so Genex's playtesters and judges can play it too.",
      button: { label: "Set up for Genex", action: "set-up" },
    });
  });

  it("opens the game's project in a new Godot editor, and Godot's download page", async () => {
    const fixture = await withProject();
    await action(fixture, "open-editor");
    await action(fixture, "get-godot");
    const app = path.join(fixture.root, "Applications", "Godot.app");
    assert.deepEqual(fixture.editor.opened, [
      {
        command: "/usr/bin/open",
        args: ["-n", "-a", app, "--args", "--path", fixture.project, "--editor"],
        detached: false,
      },
      { command: "/usr/bin/open", args: ["https://godotengine.org/download/macos/"], detached: false },
    ]);
  });

  it("makes a Genex game for a new project when none is open", async () => {
    const fixture = await godotBackendFixture({ game: null });
    const made = await action(fixture, "create", { template: "2d", name: "Orbit" });
    assert.deepEqual(made.game, { project: "made-game" });
    assert.equal(made.project, path.join(fixture.made, "godot"));
    assert.deepEqual(
      fixture.hostCalls.map((c) => [c.method, c.args]),
      [["game.create", { title: "Orbit" }]],
    );
  });

  it("knows a Godot editor by its project, never a headless job of Genex's or another project", () => {
    const project = "/Users/me/AI Games/Valley/godot";
    const godot = "/Applications/Godot.app/Contents/MacOS/Godot";
    const table: Array<[string, boolean]> = [
      [`${godot} --path ${project} --editor`, true],
      [`${godot} --path ${project} -e`, true],
      [`${godot} ${project}/project.godot`, true],
      [`${godot} --headless --path ${project} --import`, false],
      [`${godot} --path ${project}`, false],
      [`${godot} --path ${project}-copy --editor`, false],
      [`${godot} --path ${project}/ --editor`, true],
      [`/usr/bin/vim ${project}/project.godot`, false],
    ];
    for (const [line, expected] of table) assert.equal(isEditorOf(line, project), expected, line);
  });

  it("answers no unknown action or tool", async () => {
    const fixture = await godotBackendFixture();
    await assert.rejects(action(fixture, "quit-editor"), /Unknown Godot action/);
    await assert.rejects(tool(fixture, "unreal__new-game"), /Unknown Godot tool/);
  });
});
