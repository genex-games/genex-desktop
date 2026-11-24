/**
 * A Godot game's app export through the backend on a fake Mac: the export is a Godot job of
 * Genex's (never the session's own shell, which an unattended session's sandbox keeps out of
 * Godot's settings folder and macOS's temporary folder), with Genex's preset beside the person's
 * own, the person's template linked into the job's private home, writes only to the project (and,
 * for a Mac app, the one folder Godot's signing works in), the
 * app in `Builds/<Platform>/` where Publish finds it, a failure named by Godot's words, an app
 * Godot gave up on or left unsigned removed, a Mac app refused on Windows, and nothing written
 * through a link.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { APP_PRESET, appName, appTarget, bundleIdentifier, withAppPreset } from "../../src/plugins/godot/app-export.ts";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { ExportPlatform } from "../../src/plugins/godot/export-templates.ts";
import { type GodotCall, GodotJob } from "../../src/plugins/godot/godot-run.ts";
import { findNativeBuilds } from "../../src/main/core/native-builds.ts";
import { NativePlatform } from "../../src/shared/play-native.ts";
import { godotBackendFixture, type JobAnswers } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEMPLATES = "Library/Application Support/Godot/export_templates/4.6.1.stable";
/** A thin arm64 Mach-O header, a PE header for x64 and a 64-bit x86 ELF header: what Publish reads a build by. */
const MACH_O_ARM64 = Buffer.from("cffaedfe0c000001000000000200000000000000000000000000000000000000", "hex");
const PE_X64 = Buffer.concat([
  Buffer.from("4d5a", "hex"),
  Buffer.alloc(58),
  Buffer.from("40000000", "hex"),
  Buffer.from("504500006486", "hex"),
  Buffer.alloc(32),
]);
const ELF_X64 = Buffer.concat([Buffer.from("7f454c460201010000000000000000000200", "hex"), Buffer.from("3e00", "hex")]);

/** Godot's export as the fake runner plays it: the app at the path it was given, as Godot lays one out. */
async function exported(call: GodotCall): Promise<string> {
  const entry = call.args.at(-1) ?? "";
  if (entry.endsWith(".app")) {
    await mkdir(path.join(entry, "Contents", "MacOS"), { recursive: true });
    await writeFile(path.join(entry, "Contents", "Info.plist"), "<plist/>");
    await mkdir(path.join(entry, "Contents", "_CodeSignature"), { recursive: true });
    await writeFile(path.join(entry, "Contents", "_CodeSignature", "CodeResources"), "<plist/>");
    await writeFile(path.join(entry, "Contents", "MacOS", "Moon Base"), MACH_O_ARM64, { mode: 0o755 });
    return "";
  }
  await writeFile(entry, entry.endsWith(".exe") ? PE_X64 : ELF_X64, { mode: 0o755 });
  await writeFile(entry.replace(/\.(exe|x86_64)$/, ".pck"), "pck");
  return "";
}

/** A game with a 2D project New Godot game made, every app template installed or none, and Godot's export answered by `answers`. */
async function gameToExport(options: { templates?: boolean; answers?: JobAnswers } = {}) {
  const fixture = await godotBackendFixture({ answers: { [GodotJob.Export]: exported, ...options.answers } });
  await fixture.backend.tool?.(GodotTool.NewGame, { template: "2d", name: "Moon Base" }, fixture.context());
  fixture.jobs.length = 0;
  if (options.templates !== false) {
    await mkdir(path.join(fixture.home, TEMPLATES), { recursive: true });
    for (const name of [
      "macos.zip",
      "windows_release_x86_64.exe",
      "windows_release_x86_64_console.exe",
      "linux_release.x86_64",
    ])
      await writeFile(path.join(fixture.home, TEMPLATES, name), "template");
  }
  const project = path.join(fixture.gameDir, "godot");
  const exportApp = async (platform?: string | number) =>
    fixture.backend.tool?.(GodotTool.AppExport, platform === undefined ? {} : { platform }, fixture.context());
  return { ...fixture, project, exportApp };
}

describe("a Godot game's app export", () => {
  it("names the app by the project's own name, and a Mac app's identifier by it", () => {
    const rows: Array<[string, string, string]> = [
      ['config/name="Collect a Single Coin"', "CollectASingleCoin", "games.genex.collectasinglecoin"],
      ['config/name="moon-base 2!"', "MoonBase2", "games.genex.moonbase2"],
      ['config/name="Say \\"hi\\""', "SayHi", "games.genex.sayhi"],
      ['config/name="Ёжик в тумане"', "ЁжикВТумане", "games.genex.game"],
      ['config/name="../../etc"', "Etc", "games.genex.etc"],
      ['config/name=""', "Game", "games.genex.game"],
      ["[application]", "Game", "games.genex.game"],
    ];
    for (const [settings, name, identifier] of rows) {
      assert.equal(appName(`[application]\n\n${settings}\n`), name, settings);
      assert.equal(bundleIdentifier(appName(`${settings}\n`)), identifier, settings);
    }
    assert.equal(appName(`config/name="${"a".repeat(200)}"\n`).length, 60, "a long name is cut");
  });

  it("adds Genex's preset for a platform once, after the person's own, and keeps what was set in it", () => {
    const mac = withAppPreset("", ExportPlatform.Mac, "Moon");
    assert.match(mac, /^\[preset\.0\]\n\nname="Genex Mac"\nplatform="macOS"/);
    assert.match(mac, /export_path="Builds\/Mac\/Moon\.app"/);
    assert.match(mac, /application\/bundle_identifier="games\.genex\.moon"/);
    assert.match(mac, /codesign\/codesign=1\n/, "signed ad hoc by Godot itself, never by Xcode's program");
    assert.match(
      mac,
      /codesign\/entitlements\/custom_file="res:\/\/Builds\/genex-mac-entitlements\.plist"/,
      "with entitlements of the game's own: Godot's would be a file named after the game in macOS's temporary folder",
    );
    const theirs = '[preset.0]\n\nname="macOS"\nplatform="macOS"\n\n[preset.0.options]\n';
    const added = withAppPreset(theirs, ExportPlatform.Windows, "Moon");
    assert.ok(added.startsWith(theirs.trimEnd()), "the person's presets stay");
    assert.match(added, /\[preset\.1\]\n\nname="Genex Windows"\nplatform="Windows Desktop"/);
    assert.match(added, /export_path="Builds\/Windows\/Moon\.exe"/);
    assert.equal(withAppPreset(added, ExportPlatform.Windows, "Other"), added, "twice is once");
    const versioned = mac.replace("codesign/codesign=1", 'application/short_version="1.2"\ncodesign/codesign=1');
    assert.equal(withAppPreset(versioned, ExportPlatform.Mac, "Moon"), versioned, "the version set in it is kept");
    assert.match(withAppPreset("", ExportPlatform.Linux, "Moon"), /platform="Linux"[\s\S]*Builds\/Linux\/Moon\.x86_64/);
  });

  it("exports a Mac app as a Godot job of Genex's: the template linked in, writing the project and Godot's signing folder", async () => {
    const game = await gameToExport();
    const answer = String(await game.exportApp("mac"));
    assert.match(answer, /Exported the Mac app to godot\/Builds\/Mac\/MoonBase\.app/);
    assert.match(answer, /Publish/);
    const [job, ...more] = game.jobs;
    assert.deepEqual(more, [], "one job: the export");
    assert.equal(job?.call.job, GodotJob.Export);
    const entry = appTarget(game.project, ExportPlatform.Mac, "MoonBase").entry;
    assert.deepEqual(job?.call.args, [
      "--headless",
      "--path",
      game.project,
      "--export-release",
      APP_PRESET[ExportPlatform.Mac],
      entry,
    ]);
    assert.deepEqual(
      job?.call.writes,
      [game.project, path.join(game.root, "user-temp", "_lipo")],
      "the app's folder is the project's own; Godot's signing splits the program in its one folder of macOS's temporary folder",
    );
    assert.deepEqual(
      job?.call.writePrefixes,
      [path.join(game.root, "user-temp", "tmpproject.binary")],
      "and the one file Godot writes in macOS's own temporary folder, which a session's own shell may not reach",
    );
    assert.deepEqual(job?.call.reads, [path.join(game.home, TEMPLATES)]);
    assert.deepEqual(
      job?.call.homeLinks,
      [{ at: TEMPLATES, to: path.join(game.home, TEMPLATES) }],
      "Godot's settings stay in the job's private home, with the person's templates linked in",
    );
    assert.match(await readFile(path.join(game.project, "export_presets.cfg"), "utf8"), /name="Genex Mac"/);
    assert.match(
      await readFile(path.join(game.project, "project.godot"), "utf8"),
      /textures\/vram_compression\/import_etc2_astc=true/,
      "a Mac export needs ETC2/ASTC textures",
    );
    assert.deepEqual((await readdir(path.join(game.project, "Builds"))).sort(), [
      ".gdignore",
      "Mac",
      "genex-mac-entitlements.plist",
    ]);
    const entitlements = path.join(game.project, "Builds", "genex-mac-entitlements.plist");
    assert.match(await readFile(entitlements, "utf8"), /<dict>\n<\/dict>/, "Godot's own for an ad hoc app: none");
    await writeFile(entitlements, "the game's own");
    await game.exportApp("mac");
    assert.equal(await readFile(entitlements, "utf8"), "the game's own", "kept once the game has one");
    const builds = await findNativeBuilds(game.gameDir);
    assert.deepEqual(
      builds.map((build) => [build.platform, build.entry]),
      [[NativePlatform.Mac, "godot/Builds/Mac/MoonBase.app"]],
      "Publish finds it",
    );
  });

  it("exports a Windows and a Linux program the same way, each into its own folder", async () => {
    const game = await gameToExport();
    assert.match(
      String(await game.exportApp("windows")),
      /Exported the Windows app to godot\/Builds\/Windows\/MoonBase\.exe/,
    );
    assert.match(
      String(await game.exportApp("linux")),
      /Exported the Linux app to godot\/Builds\/Linux\/MoonBase\.x86_64/,
    );
    assert.deepEqual(
      game.jobs.map((job) => [job.call.job, job.call.args[4], path.basename(job.call.args[5] ?? "")]),
      [
        [GodotJob.Export, "Genex Windows", "MoonBase.exe"],
        [GodotJob.Export, "Genex Linux", "MoonBase.x86_64"],
      ],
    );
    for (const job of game.jobs) assert.deepEqual(job.call.writes, [game.project], "nothing outside the project");
    const presets = await readFile(path.join(game.project, "export_presets.cfg"), "utf8");
    assert.match(presets, /name="Genex Windows"[\s\S]*name="Genex Linux"/);
    assert.deepEqual((await readdir(path.join(game.project, "Builds"))).sort(), [".gdignore", "Linux", "Windows"]);
    const found = (await findNativeBuilds(game.gameDir)).map((build) => build.platform).sort();
    assert.deepEqual(found, [NativePlatform.Linux, NativePlatform.Windows].sort());
  });

  it("refuses a platform it doesn't export for, before Godot runs", async () => {
    const game = await gameToExport();
    for (const platform of ["web", "ios", "", undefined, 3, "mac,windows", "../mac"])
      await assert.rejects(game.exportApp(platform), /platform is mac, windows or linux/, String(platform));
    assert.deepEqual(game.jobs, []);
    assert.equal(await lstat(path.join(game.project, "Builds")).catch(() => null), null, "no Builds folder made");
  });

  it("is refused before Godot runs when the template is missing and can't be fetched, and says how to get it", async () => {
    const game = await gameToExport({ templates: false });
    await assert.rejects(
      game.exportApp("mac"),
      /export template for mac isn't on this computer and Genex couldn't fetch it: [\s\S]*Manage Export Templates/,
    );
    assert.deepEqual(game.jobs, []);
    assert.equal(await lstat(path.join(game.project, "Builds")).catch(() => null), null, "no Builds folder made");
  });

  it("names what Godot said when it wrote no app, and an app from before is not taken for a new one", async () => {
    const failing = 'ERROR: Cannot export project with preset "Genex Mac" due to configuration errors.\n';
    const game = await gameToExport({ answers: { [GodotJob.Export]: failing } });
    await assert.rejects(game.exportApp("mac"), /Mac export didn't finish: ERROR: Cannot export project/);
    const old = appTarget(game.project, ExportPlatform.Mac, "MoonBase").entry;
    await exported({ args: [old] } as GodotCall);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(path.join(old, "Contents", "MacOS", "Moon Base"), longAgo, longAgo);
    await assert.rejects(game.exportApp("mac"), /Mac export didn't finish/);
  });

  it("removes an app Godot wrote and then gave up on, or left unsigned, so Publish never finds it", async () => {
    const gaveUp = async (call: GodotCall) => {
      await exported(call);
      return 'ERROR: Code Signing: Could not create entitlements file.\nERROR: Project export for preset "Genex Mac" failed.\n';
    };
    const unsigned = async (call: GodotCall) => {
      await exported(call);
      await rm(path.join(call.args.at(-1) ?? "", "Contents", "_CodeSignature"), { recursive: true });
      return "ERROR: CodeSign: Failed to extract thin binary.\n";
    };
    const rows: Array<[string, (call: GodotCall) => Promise<string>, RegExp]> = [
      ["gave up", gaveUp, /Mac export didn't finish: [\s\S]*Could not create entitlements file/],
      ["unsigned", unsigned, /Mac export didn't finish: ERROR: CodeSign: Failed to extract thin binary/],
    ];
    for (const [what, answer, said] of rows) {
      const game = await gameToExport({ answers: { [GodotJob.Export]: answer } });
      await assert.rejects(game.exportApp("mac"), said, what);
      const app = appTarget(game.project, ExportPlatform.Mac, "MoonBase").entry;
      assert.equal(await lstat(app).catch(() => null), null, `${what}: the app is gone`);
      assert.deepEqual(await findNativeBuilds(game.gameDir), [], what);
    }
  });

  it("builds no Mac app on Windows, where Godot makes only a zip of one", async () => {
    const fixture = await godotBackendFixture({ platform: "win32" });
    await assert.rejects(
      (async () => fixture.backend.tool?.(GodotTool.AppExport, { platform: "mac" }, fixture.context()))(),
      /A Mac app is exported on a Mac/,
    );
    assert.deepEqual(fixture.jobs, []);
  });

  it("writes nothing through a link", async () => {
    const outside = await tmpDir("studio-godot-app-outside-");
    const builds = (game: { project: string }) => path.join(game.project, "Builds");
    const rows: Array<[string, (game: Awaited<ReturnType<typeof gameToExport>>) => Promise<void>]> = [
      ["Builds/", (game) => symlink(outside, builds(game))],
      [
        "Builds/Mac",
        async (game) => {
          await mkdir(builds(game));
          await symlink(outside, path.join(builds(game), "Mac"));
        },
      ],
      [
        "Builds/.gdignore",
        async (game) => {
          await mkdir(builds(game));
          await symlink(path.join(outside, "marker"), path.join(builds(game), ".gdignore"));
        },
      ],
      [
        "Builds/genex-mac-entitlements.plist",
        async (game) => {
          await mkdir(builds(game));
          await symlink(path.join(outside, "entitlements"), path.join(builds(game), "genex-mac-entitlements.plist"));
        },
      ],
      [
        "the app itself",
        async (game) => {
          await mkdir(path.join(builds(game), "Mac"), { recursive: true });
          await symlink(outside, path.join(builds(game), "Mac", "MoonBase.app"));
        },
      ],
      [
        "export_presets.cfg",
        (game) => symlink(path.join(outside, "presets"), path.join(game.project, "export_presets.cfg")),
      ],
    ];
    for (const [what, plant] of rows) {
      const game = await gameToExport();
      await plant(game);
      await assert.rejects(game.exportApp("mac"), /is a link, so Genex won't write through it/, what);
      assert.deepEqual(game.jobs, [], what);
      assert.deepEqual(await readdir(outside), [], `${what}: nothing written outside`);
    }
  });
});
