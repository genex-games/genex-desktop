/**
 * Finding Godot on a Mac: the apps where people keep them (Applications, their own Applications,
 * Downloads), a `godot` on the PATH, each once by its real path, newest supported first; what Genex
 * builds with (4.3 or newer in the 4 line) and what the engine question says when there is none.
 * On Windows: Genex's own install, Program Files (Steam's too) and the PATH, never a Godot elsewhere
 * in the person's profile, which Genex's sandbox can't run.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  findGodots,
  GodotReadiness,
  godotReadiness,
  isSupported,
  parseVersion,
  programFilesOf,
  usableGodot,
  versionName,
} from "../../src/plugins/godot/find-godot.ts";
import { fakeMac, fakeWindows, GODOT_461 } from "../helpers/godot-fake-engine.ts";

const GODOT_472 = "4.7.2.stable.official.7c2a2f5a1";

describe("Godot's version line", () => {
  const table: Array<[string, { name: string; mono: boolean; status: string; supported: boolean } | null]> = [
    [GODOT_461, { name: "4.6.1", mono: false, status: "stable", supported: true }],
    ["4.3.stable.mono.official.77dcf97d8", { name: "4.3", mono: true, status: "stable", supported: true }],
    ["4.5.rc2.official.abc", { name: "4.5", mono: false, status: "rc2", supported: true }],
    ["4.2.2.stable.official.15073afe3", { name: "4.2.2", mono: false, status: "stable", supported: false }],
    ["3.6.stable.official.de2f0f147", { name: "3.6", mono: false, status: "stable", supported: false }],
    ["5.0.dev1.official.abc", { name: "5.0", mono: false, status: "dev1", supported: false }],
    ["Blender 4.2.0", null],
    ["", null],
  ];
  for (const [line, expected] of table) {
    it(`reads ${JSON.stringify(line)}`, () => {
      const version = parseVersion(line);
      if (!expected) return assert.equal(version, null);
      assert.ok(version);
      assert.equal(versionName(version), expected.name);
      assert.equal(version.mono, expected.mono);
      assert.equal(version.status, expected.status);
      assert.equal(isSupported(version), expected.supported);
    });
  }
});

describe("finding Godot", () => {
  it("lists every Godot app, newest first, and uses the newest supported one", async () => {
    const mac = await fakeMac([
      { where: "downloads", name: "Godot 4.2.app", version: "4.2.2.stable.official.15073afe3" },
      { where: "applications", name: "Godot.app", version: GODOT_461 },
      { where: "home-applications", name: "Godot_mono.app", version: "4.3.stable.mono.official.77dcf97d8" },
      { where: "applications", name: "GodotSteam.app", version: null },
      { where: "applications", name: "Blender.app", version: "4.2.0" },
    ]);
    const found = await findGodots(mac.env);
    assert.deepEqual(
      found.map((install) => [versionName(install.version), install.supported, path.basename(install.app ?? "")]),
      [
        ["4.6.1", true, "Godot.app"],
        ["4.3", true, "Godot_mono.app"],
        ["4.2.2", false, "Godot 4.2.app"],
      ],
    );
    assert.equal(usableGodot(found)?.version.text, GODOT_461);
    assert.deepEqual(godotReadiness(found), { readiness: GodotReadiness.Ready, version: "4.6.1" });
  });

  it("counts a godot on the PATH that links into an app once, with its app", async () => {
    const mac = await fakeMac();
    const bin = path.join(mac.root, "bin");
    await mkdir(bin);
    const [app] = [...mac.versions.keys()];
    await symlink(app ?? "", path.join(bin, "godot"));
    const found = await findGodots({ ...mac.env, pathDirs: [bin] });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.app, path.join(mac.root, "Applications", "Godot.app"));
  });

  it("finds a bare binary Homebrew put in place, with no app", async () => {
    const mac = await fakeMac([]);
    const brew = path.join(mac.root, "opt", "godot");
    await mkdir(path.dirname(brew), { recursive: true });
    await writeFile(brew, "");
    mac.versions.set(brew, GODOT_461);
    const found = await findGodots({ ...mac.env, binaries: [brew] });
    assert.deepEqual(
      found.map((install) => [install.binary, install.app]),
      [[brew, null]],
    );
  });

  it("says what stands in the way: none, only older, only newer", async () => {
    const none = await fakeMac([]);
    assert.deepEqual(godotReadiness(await findGodots(none.env)), { readiness: GodotReadiness.None, version: null });
    const older = await fakeMac([{ where: "applications", name: "Godot.app", version: "3.6.stable.official.x" }]);
    assert.deepEqual(godotReadiness(await findGodots(older.env)), {
      readiness: GodotReadiness.OlderOnly,
      version: "3.6",
    });
    const newer = await fakeMac([{ where: "applications", name: "Godot.app", version: "5.0.stable.official.x" }]);
    assert.deepEqual(godotReadiness(await findGodots(newer.env)), {
      readiness: GodotReadiness.NewerOnly,
      version: "5.0",
    });
  });

  it("looks nowhere off a Mac and Windows", async () => {
    const mac = await fakeMac();
    assert.deepEqual(await findGodots({ ...mac.env, platform: "linux" }), []);
  });
});

describe("finding Godot on Windows", () => {
  it("finds Genex's own install, Program Files' and Steam's, newest first, never a console wrapper", async () => {
    const pc = await fakeWindows([
      { where: "Program Files/Godot/Godot_v4.6.1-stable_win64.exe", version: GODOT_461 },
      { where: "Program Files/Godot/Godot_v4.6.1-stable_win64_console.exe", version: GODOT_461 },
      {
        where: "Program Files (x86)/Steam/steamapps/common/Godot Engine/godot.windows.opt.tools.64.exe",
        version: "4.3.stable.official.77dcf97d8",
      },
      { where: "Program Files/Godot Engine/Godot_v3.6-stable_win64.exe", version: "3.6.stable.official.de2f0f147" },
      { where: "Program Files/Blender Foundation/blender.exe", version: "4.2.0" },
    ]);
    const own = await pc.place({
      where: "Users/Ada/AppData/Roaming/Genex/native-runtimes/godot/godot/Godot_v4.7.2-stable_win64.exe",
      version: GODOT_472,
    });
    const found = await findGodots(pc.env, [own]);
    assert.deepEqual(
      found.map((install) => [versionName(install.version), path.basename(install.binary), install.app]),
      [
        ["4.7.2", "Godot_v4.7.2-stable_win64.exe", null],
        ["4.6.1", "Godot_v4.6.1-stable_win64.exe", null],
        ["4.3", "godot.windows.opt.tools.64.exe", null],
        ["3.6", "Godot_v3.6-stable_win64.exe", null],
      ],
    );
    assert.equal(usableGodot(found)?.binary, own);
  });

  it("finds Steam's Godot in every library Steam lists, its own and one on another drive", async () => {
    const pc = await fakeWindows([
      {
        where: "SteamLibrary/steamapps/common/Godot Engine/godot.windows.opt.tools.64.exe",
        version: GODOT_461,
      },
    ]);
    const library = path.join(pc.root, "SteamLibrary");
    const vdf = path.join(pc.root, "Program Files (x86)", "Steam", "steamapps", "libraryfolders.vdf");
    await mkdir(path.dirname(vdf), { recursive: true });
    const escaped = library.replaceAll("\\", "\\\\");
    await writeFile(vdf, `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${escaped}"\n\t}\n}\n`);
    const found = await findGodots(pc.env);
    assert.deepEqual(
      found.map((install) => install.binary),
      [path.join(library, "steamapps", "common", "Godot Engine", "godot.windows.opt.tools.64.exe")],
    );
  });

  it("leaves out a Godot in the person's profile Genex didn't install: its sandbox can't read it", async () => {
    const pc = await fakeWindows([
      { where: "Users/Ada/Downloads/Godot_v4.7.2-stable_win64.exe/Godot_v4.7.2-stable_win64.exe", version: GODOT_472 },
      { where: "Users/Ada/scoop/apps/godot/current/godot.exe", version: GODOT_472 },
    ]);
    const scoop = path.join(pc.home, "scoop", "apps", "godot", "current");
    assert.deepEqual(await findGodots({ ...pc.env, pathDirs: [scoop] }), []);
    assert.deepEqual(godotReadiness(await findGodots(pc.env)), { readiness: GodotReadiness.None, version: null });
  });

  it("finds a godot.exe on the PATH outside the profile, by its real path, once", async () => {
    const pc = await fakeWindows([{ where: "ProgramData/chocolatey/bin/godot.exe", version: GODOT_461 }]);
    const bin = path.join(pc.root, "ProgramData", "chocolatey", "bin");
    const found = await findGodots({ ...pc.env, pathDirs: [bin, bin] });
    assert.deepEqual(
      found.map((install) => install.binary),
      [path.join(bin, "godot.exe")],
    );
  });

  it("reads Program Files from Windows's environment, each a whole path, once", () => {
    const table: Array<[NodeJS.ProcessEnv, string[]]> = [
      [{ ProgramFiles: "D:\\Apps", "ProgramFiles(x86)": "D:\\Apps (x86)" }, ["D:\\Apps", "D:\\Apps (x86)"]],
      [{}, ["C:\\Program Files"]],
      [{ ProgramFiles: "C:\\P", "ProgramFiles(x86)": "C:\\P" }, ["C:\\P"]],
      [{ ProgramFiles: "relative", "ProgramFiles(x86)": "" }, []],
    ];
    for (const [env, expected] of table) assert.deepEqual(programFilesOf(env), expected, JSON.stringify(env));
  });
});
