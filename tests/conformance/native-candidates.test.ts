import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CandidateDeps,
  candidatePaths,
  commandProgram,
  registryData,
} from "../../src/substrate/plugins/native-candidates.ts";

const STORE_PACKAGES =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
const PROGRAM_FILES = "C:\\Program Files";

/** A Windows PC whose folders and registry the test lays out; every lookup it is asked is logged. */
function windowsPc(options: {
  folders?: Record<string, string[]>;
  values?: Record<string, string>;
  keys?: Record<string, string[]>;
  settings?: Record<string, unknown>;
}): CandidateDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    platform: "win32",
    env: {
      ProgramFiles: PROGRAM_FILES,
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    },
    home: "C:\\Users\\ada",
    studio: "C:\\Users\\ada\\AppData\\Roaming\\Genex",
    storage: "C:\\Users\\ada\\AppData\\Roaming\\Genex\\plugins\\data\\blender",
    settings: options.settings ?? {},
    list: async (dir) => {
      asked.push(`list ${dir}`);
      return options.folders?.[dir] ?? [];
    },
    registryValue: async (key, value) => {
      asked.push(`value ${key} ${value ?? ""}`.trim());
      return options.values?.[value ? `${key}|${value}` : key] ?? null;
    },
    registryKeys: async (key) => {
      asked.push(`keys ${key}`);
      return options.keys?.[key] ?? [];
    },
  };
}

/** A Mac with the same lookups: none of Windows's folders, and no registry. */
function mac(): CandidateDeps & { asked: string[] } {
  return { ...windowsPc({}), platform: "darwin", env: {}, home: "/Users/ada", studio: "/s", storage: "/p" };
}

describe("Runtime candidates on Windows", () => {
  it("try every installed Blender in Program Files, newest version first", async () => {
    const pc = windowsPc({
      folders: { [`${PROGRAM_FILES}\\Blender Foundation`]: ["Blender 4.2", "Blender 10.0", "blender 5.2", "Other"] },
    });
    assert.deepEqual(await candidatePaths("programfiles:Blender Foundation/Blender */blender.exe", pc), [
      `${PROGRAM_FILES}\\Blender Foundation\\Blender 10.0\\blender.exe`,
      `${PROGRAM_FILES}\\Blender Foundation\\blender 5.2\\blender.exe`,
      `${PROGRAM_FILES}\\Blender Foundation\\Blender 4.2\\blender.exe`,
    ]);
  });

  it("find the Blender .blend files open with, beside the launcher the registry names", async () => {
    const pc = windowsPc({
      values: {
        "HKCR\\.blend": "blendfile",
        "HKCR\\blendfile\\shell\\open\\command": `"D:\\Tools\\Blender\\blender-launcher.exe" "%1"`,
      },
    });
    assert.deepEqual(await candidatePaths("opens:.blend/blender.exe", pc), ["D:\\Tools\\Blender\\blender.exe"]);
  });

  it("find Blender in this user's Microsoft Store package, newest package first", async () => {
    const old = `HKEY_CURRENT_USER\\…\\Packages\\BlenderFoundation.Blender_4.2.0.0_x64__ppwjx1n5r4v9t`;
    const current = `HKEY_CURRENT_USER\\…\\Packages\\BlenderFoundation.Blender_5.2.1.0_x64__ppwjx1n5r4v9t`;
    const pc = windowsPc({
      keys: { [STORE_PACKAGES]: [old, current, "HKEY_CURRENT_USER\\…\\Packages\\Other.App_1.0.0.0_x64__x"] },
      values: {
        [`${old}|PackageRootFolder`]:
          "C:\\Program Files\\WindowsApps\\BlenderFoundation.Blender_4.2.0.0_x64__ppwjx1n5r4v9t",
        [`${current}|PackageRootFolder`]:
          "C:\\Program Files\\WindowsApps\\BlenderFoundation.Blender_5.2.1.0_x64__ppwjx1n5r4v9t",
      },
    });
    assert.deepEqual(await candidatePaths("package:BlenderFoundation.Blender/Blender/blender.exe", pc), [
      "C:\\Program Files\\WindowsApps\\BlenderFoundation.Blender_5.2.1.0_x64__ppwjx1n5r4v9t\\Blender\\blender.exe",
      "C:\\Program Files\\WindowsApps\\BlenderFoundation.Blender_4.2.0.0_x64__ppwjx1n5r4v9t\\Blender\\blender.exe",
    ]);
  });

  it("use the program the person chose in the plugin's settings", async () => {
    const pc = windowsPc({ settings: { program: "  E:\\Blender\\blender.exe " } });
    assert.deepEqual(await candidatePaths("setting:program", pc), ["E:\\Blender\\blender.exe"]);
  });

  it("skip a Mac's absolute paths, and a folder Windows doesn't name", async () => {
    const pc = windowsPc({});
    assert.deepEqual(await candidatePaths("/Applications/Blender.app/Contents/MacOS/Blender", pc), []);
    assert.deepEqual(await candidatePaths("programfiles:Blender/blender.exe", { ...pc, env: {} }), []);
    assert.deepEqual(pc.asked, []);
  });

  // Hostile or broken answers: each one is no candidate, and nothing past it is looked up.
  const NOT_A_PROGRAM: Array<[string, Parameters<typeof windowsPc>[0], string]> = [
    ["a chosen network share", { settings: { program: "\\\\attacker\\share\\blender.exe" } }, "setting:program"],
    ["a chosen device path", { settings: { program: "\\\\?\\C:\\Blender\\blender.exe" } }, "setting:program"],
    ["a chosen relative path", { settings: { program: "blender.exe" } }, "setting:program"],
    ["a chosen drive-relative path", { settings: { program: "C:blender.exe" } }, "setting:program"],
    ["a setting that isn't text", { settings: { program: 7 } }, "setting:program"],
    ["an empty setting", { settings: { program: "  " } }, "setting:program"],
    ["no setting", {}, "setting:program"],
    [
      "an open command on a network share",
      {
        values: {
          "HKCR\\.blend": "blendfile",
          "HKCR\\blendfile\\shell\\open\\command": `"\\\\attacker\\share\\blender-launcher.exe" "%1"`,
        },
      },
      "opens:.blend/blender.exe",
    ],
    [
      "an open command with no program",
      { values: { "HKCR\\.blend": "blendfile", "HKCR\\blendfile\\shell\\open\\command": `"` } },
      "opens:.blend/blender.exe",
    ],
    ["no handler for the file type", {}, "opens:.blend/blender.exe"],
    [
      "a Store package root on a network share",
      {
        keys: { [STORE_PACKAGES]: ["HKEY_CURRENT_USER\\…\\BlenderFoundation.Blender_5.2.1.0_x64__p"] },
        values: {
          "HKEY_CURRENT_USER\\…\\BlenderFoundation.Blender_5.2.1.0_x64__p|PackageRootFolder": "\\\\host\\apps",
        },
      },
      "package:BlenderFoundation.Blender/Blender/blender.exe",
    ],
  ];
  for (const [label, pc, candidate] of NOT_A_PROGRAM)
    it(`refuse ${label}`, async () => {
      assert.deepEqual(await candidatePaths(candidate, windowsPc(pc)), []);
    });
});

describe("Runtime candidates on a Mac", () => {
  it("keep absolute paths and folder aliases, and never ask Windows's registry", async () => {
    const m = mac();
    assert.deepEqual(await candidatePaths("/Applications/Blender.app/Contents/MacOS/Blender", m), [
      "/Applications/Blender.app/Contents/MacOS/Blender",
    ]);
    assert.deepEqual(await candidatePaths("home:Applications/Blender.app/Contents/MacOS/Blender", m), [
      "/Users/ada/Applications/Blender.app/Contents/MacOS/Blender",
    ]);
    for (const candidate of [
      "programfiles:Blender Foundation/Blender */blender.exe",
      "opens:.blend/blender.exe",
      "package:BlenderFoundation.Blender/Blender/blender.exe",
    ])
      assert.deepEqual(await candidatePaths(candidate, m), [], candidate);
    assert.deepEqual(m.asked, []);
  });
});

describe("Reading the registry", () => {
  it("reads a string value and expands a REG_EXPAND_SZ one", () => {
    const out = "\r\nHKEY_CLASSES_ROOT\\.blend\r\n    (Default)    REG_SZ    blendfile\r\n\r\n";
    assert.equal(registryData(out), "blendfile");
    const expand = "\r\nHKEY_X\r\n    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\Blender\\blender.exe\r\n";
    assert.equal(
      registryData(expand, { PROGRAMFILES: "C:\\Program Files" }),
      "C:\\Program Files\\Blender\\blender.exe",
    );
    assert.equal(
      registryData(expand, {}),
      "%ProgramFiles%\\Blender\\blender.exe",
      "an unknown variable stays as written",
    );
    assert.equal(registryData("ERROR: The system was unable to find the specified registry key or value."), null);
    assert.equal(registryData("\r\nHKEY_X\r\n    Size    REG_DWORD    0x1\r\n"), null, "not a string value");
  });

  it("finds the program a shell open command starts", () => {
    assert.equal(commandProgram(`"C:\\A B\\blender-launcher.exe" "%1"`), "C:\\A B\\blender-launcher.exe");
    assert.equal(commandProgram(`C:\\A B\\blender-launcher.exe "%1"`), "C:\\A B\\blender-launcher.exe");
    assert.equal(commandProgram(`""`), null);
    assert.equal(commandProgram("rundll32 something"), null);
  });
});
