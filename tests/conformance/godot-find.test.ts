/**
 * Finding Godot on a Mac: the apps where people keep them (Applications, their own Applications,
 * Downloads), a `godot` on the PATH, each once by its real path, newest supported first; what Genex
 * builds with (4.3 or newer in the 4 line) and what the engine question says when there is none.
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
  usableGodot,
  versionName,
} from "../../src/plugins/godot/find-godot.ts";
import { fakeMac, GODOT_461 } from "../helpers/godot-fake-engine.ts";

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

  it("looks nowhere but on a Mac, where Genex runs Godot", async () => {
    const mac = await fakeMac();
    assert.deepEqual(await findGodots({ ...mac.env, platform: "win32" }), []);
  });
});
