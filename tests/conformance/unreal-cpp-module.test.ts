/**
 * A Blueprint project becomes a C++ project the way Unreal lays one out: two Target.cs
 * files, the module's Build.cs, header and source, and one Runtime entry in the .uproject's
 * "Modules", every other field and the tab indentation kept. Genex writes the module once; a second
 * call changes nothing. The project folder is the user's, so a link, a path taken by something
 * else, another module or a name the engine already uses is refused before anything is written.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addCppModule,
  CppModuleError,
  CppModuleErrorCode,
  GAME_LIBRARY,
  hotLibraryLoaded,
  isModuleName,
  moduleNameFor,
  projectModule,
} from "../../src/plugins/unreal/cpp-module.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A Blueprint project's .uproject (tabs, no trailing newline), as Unreal 5.8 writes it. */
const BLUEPRINT_UPROJECT = [
  "{",
  '\t"FileVersion": 3,',
  '\t"EngineAssociation": "5.8",',
  '\t"Category": "",',
  '\t"Description": "",',
  '\t"Plugins": [',
  "\t\t{",
  '\t\t\t"Name": "ModelingToolsEditorMode",',
  '\t\t\t"Enabled": true,',
  '\t\t\t"TargetAllowList": [',
  '\t\t\t\t"Editor"',
  "\t\t\t]",
  "\t\t},",
  "\t\t{",
  '\t\t\t"Name": "ModelContextProtocol",',
  '\t\t\t"Enabled": true,',
  '\t\t\t"TargetAllowList": [',
  '\t\t\t\t"Editor"',
  "\t\t\t]",
  "\t\t}",
  "\t]",
  "}",
].join("\n");

/** Source/GxCpp.Target.cs as Unreal 5.8 writes it for a C++ project, byte for byte. */
const UNREAL_GAME_TARGET = `using UnrealBuildTool;
using System.Collections.Generic;

public class GxCppTarget : TargetRules
{
	public GxCppTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("GxCpp");
	}
}
`;

/** Source/GxCppEditor.Target.cs as Unreal 5.8 writes it for a C++ project, byte for byte. */
const UNREAL_EDITOR_TARGET = `using UnrealBuildTool;
using System.Collections.Generic;

public class GxCppEditorTarget : TargetRules
{
	public GxCppEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("GxCpp");
	}
}
`;

const UNREAL_HEADER = `#pragma once

#include "CoreMinimal.h"
`;

const UNREAL_SOURCE = `#include "GxCpp.h"
#include "Modules/ModuleManager.h"

IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, GxCpp, "GxCpp");
`;

/** Unreal's Build.cs with the dependencies every Genex game module gets (UMG and Slate for HUDs). */
const GXCPP_BUILD = `using UnrealBuildTool;

public class GxCpp : ModuleRules
{
	public GxCpp(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput", "UMG", "Slate", "SlateCore" });
		PublicIncludePaths.Add(ModuleDirectory);
	}
}
`;

const MODULE_FILES = (module: string) => [
  `Source/${module}.Target.cs`,
  `Source/${module}/${module}.Build.cs`,
  `Source/${module}/${module}.cpp`,
  `Source/${module}/${module}.h`,
  `Source/${module}Editor.Target.cs`,
];

/** A Blueprint project in a temp root: its root, its folder and its .uproject. */
type Planted = { root: string; dir: string; file: string };

/** A temp root holding `game/unreal/<name>.uproject`; the root also holds anything a hostile row plants outside. */
async function blueprintProject(name = "GxCpp", text = BLUEPRINT_UPROJECT) {
  const root = await realpath(await tmpDir("studio-cpp-module-"));
  const dir = path.join(root, "game", "unreal");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.uproject`);
  await writeFile(file, text);
  return { root, dir, file };
}

/** Every entry under `dir` with its kind and content (a file's text, a link's target), sorted. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  const rows: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) rows.push(`${entry} -> ${await readlink(full)}`);
    else if (info.isFile()) rows.push(`${entry} = ${await readFile(full, "utf8")}`);
    else rows.push(`${entry}/`);
  }
  return rows;
}

const read = (dir: string, relative: string) => readFile(path.join(dir, relative), "utf8");

async function rejectsWith(promise: Promise<unknown>, code: CppModuleErrorCode, label: string) {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof CppModuleError, `${label}: a CppModuleError`);
      assert.equal(error.code, code, label);
      assert.ok(error.message.length > 0, `${label}: says why`);
      return true;
    },
    label,
  );
}

describe("making a Blueprint project a C++ project", () => {
  it("writes Unreal's module files and declares the module, keeping every other field and the tabs", async () => {
    const { dir, file } = await blueprintProject();
    const added = await addCppModule(file);
    assert.equal(added.module, "GxCpp");
    assert.deepEqual([...added.created].sort(), MODULE_FILES("GxCpp"));
    assert.equal(added.declared, true);
    assert.equal(await read(dir, "Source/GxCpp.Target.cs"), UNREAL_GAME_TARGET);
    assert.equal(await read(dir, "Source/GxCppEditor.Target.cs"), UNREAL_EDITOR_TARGET);
    assert.equal(await read(dir, "Source/GxCpp/GxCpp.h"), UNREAL_HEADER);
    assert.equal(await read(dir, "Source/GxCpp/GxCpp.cpp"), UNREAL_SOURCE);
    assert.equal(await read(dir, "Source/GxCpp/GxCpp.Build.cs"), GXCPP_BUILD);

    const text = await readFile(file, "utf8");
    const before = JSON.parse(BLUEPRINT_UPROJECT);
    const after = JSON.parse(text);
    assert.deepEqual(after.Modules, [{ Name: "GxCpp", Type: "Runtime", LoadingPhase: "Default" }]);
    assert.deepEqual({ ...after, Modules: undefined }, { ...before, Modules: undefined });
    // Where Unreal itself writes it: after Description, before Plugins.
    assert.deepEqual(Object.keys(after), [
      "FileVersion",
      "EngineAssociation",
      "Category",
      "Description",
      "Modules",
      "Plugins",
    ]);
    assert.ok(text.includes('\n\t"Modules": [\n\t\t{\n\t\t\t"Name": "GxCpp",\n'), "tab indented");
    assert.ok(!/^ /m.test(text), "no space indentation");
    assert.ok(!text.endsWith("\n"), "no trailing newline, as before");
    assert.equal(await projectModule(file), "GxCpp");
  });

  it("adds ChaosVehicles and PhysicsCore only when the project enables the vehicle plugin", async () => {
    const vehicle = JSON.parse(BLUEPRINT_UPROJECT);
    vehicle.Plugins.push({ Name: "ChaosVehiclesPlugin", Enabled: true });
    const disabled = JSON.parse(BLUEPRINT_UPROJECT);
    disabled.Plugins.push({ Name: "ChaosVehiclesPlugin", Enabled: false });
    const rows: Array<[string, unknown, boolean]> = [
      ["vehicle plugin enabled", vehicle, true],
      ["vehicle plugin disabled", disabled, false],
      ["no vehicle plugin", JSON.parse(BLUEPRINT_UPROJECT), false],
    ];
    for (const [label, json, vehicles] of rows) {
      const { dir, file } = await blueprintProject("Rush", JSON.stringify(json, null, "\t"));
      await addCppModule(file);
      const build = await read(dir, "Source/Rush/Rush.Build.cs");
      assert.equal(build.includes('"ChaosVehicles", "PhysicsCore"'), vehicles, label);
      assert.ok(build.includes('"UMG", "Slate", "SlateCore"'), label);
      assert.ok(build.includes("PublicIncludePaths.Add(ModuleDirectory);"), label);
    }
  });

  it("picks the include order of the engine the project names, else Unreal 5.8's", async () => {
    const rows: Array<[string, string | undefined, string]> = [
      ["5.8", undefined, "Unreal5_8"],
      ["5.9", undefined, "Unreal5_9"],
      ["5.8", "5.10.1", "Unreal5_10"],
      ["", undefined, "Unreal5_8"],
      ["{8C1E2E52-4E19-4E22-9C1C-0A4D3F2A9B11}", undefined, "Unreal5_8"],
      ["5.3", undefined, "Unreal5_8"],
      ["6.0", undefined, "Unreal5_8"],
    ];
    for (const [association, engineVersion, order] of rows) {
      const json = { ...JSON.parse(BLUEPRINT_UPROJECT), EngineAssociation: association };
      const { dir, file } = await blueprintProject("Order", JSON.stringify(json, null, "\t"));
      await addCppModule(file, engineVersion === undefined ? {} : { engineVersion });
      for (const target of ["Source/Order.Target.cs", "Source/OrderEditor.Target.cs"])
        assert.ok(
          (await read(dir, target)).includes(`EngineIncludeOrderVersion.${order};`),
          `${association} ${target}`,
        );
    }
  });

  it("appends to Modules that are already there, and keeps CRLF line ends and a trailing newline", async () => {
    const json = { ...JSON.parse(BLUEPRINT_UPROJECT), Modules: [] };
    const text = `${JSON.stringify(json, null, "\t").replaceAll("\n", "\r\n")}\r\n`;
    const { file } = await blueprintProject("Crlf", text);
    await addCppModule(file);
    const after = await readFile(file, "utf8");
    assert.ok(after.endsWith("}\r\n"));
    assert.ok(!/[^\r]\n/.test(after), "every line ends with CRLF");
    assert.deepEqual(JSON.parse(after).Modules, [{ Name: "Crlf", Type: "Runtime", LoadingPhase: "Default" }]);
  });
});

describe("adding the module again, finishing it, and naming it", () => {
  it("is idempotent: a second call, or a C++ project laid out as Unreal makes one, changes nothing", async () => {
    const { root, file } = await blueprintProject();
    await addCppModule(file);
    await mkdir(path.join(root, "game", "unreal", "Source", "GxCpp", "Parts", "Probe"), { recursive: true });
    await writeFile(
      path.join(root, "game", "unreal", "Source", "GxCpp", "Parts", "Probe", "GxProbe.h"),
      "#pragma once\n",
    );
    await writeFile(path.join(root, "game", "unreal", "Source", ".DS_Store"), "");
    const before = await snapshot(root);
    assert.deepEqual(await addCppModule(file), { module: "GxCpp", created: [], declared: false });
    assert.deepEqual(await snapshot(root), before);
  });

  it("finishes an interrupted one: declares written files, writes a missing file, keeps the rest", async () => {
    const { dir, file } = await blueprintProject();
    await addCppModule(file);
    await writeFile(file, BLUEPRINT_UPROJECT);
    assert.deepEqual(await addCppModule(file), { module: "GxCpp", created: [], declared: true });
    assert.equal(await projectModule(file), "GxCpp");

    await writeFile(path.join(dir, "Source", "GxCpp", "GxCpp.h"), "// the user's own header\n");
    await rm(path.join(dir, "Source", "GxCpp", "GxCpp.cpp"));
    assert.deepEqual(await addCppModule(file), {
      module: "GxCpp",
      created: ["Source/GxCpp/GxCpp.cpp"],
      declared: false,
    });
    assert.equal(await read(dir, "Source/GxCpp/GxCpp.h"), "// the user's own header\n");
    assert.equal(await read(dir, "Source/GxCpp/GxCpp.cpp"), UNREAL_SOURCE);
  });

  it("names the module after the project, cleaned into a C++ identifier", async () => {
    const rows: Array<[string, string]> = [
      ["GxCpp", "GxCpp"],
      ["Dirt-Track", "DirtTrack"],
      ["dirt track", "DirtTrack"],
      ["my_game", "my_game"],
      // Flipped (was "_Hidden"): a leading underscore makes the module's _HIDDEN_API macro a reserved name.
      ["_Hidden", "Hidden"],
      ["class", "Class"],
      ["System", "GenexGame"],
      ["_", "GenexGame"],
      ["Rush_", "Rush"],
      ["my__game", "My_game"],
      ["2048 Clone", "Clone"],
      ["Rush 2", "Rush2"],
      ["A".repeat(33), "A".repeat(32)],
      ["Гонка", "GenexGame"],
      ["123", "GenexGame"],
    ];
    for (const [name, module] of rows) {
      assert.equal(moduleNameFor(`/games/x/unreal/${name}.uproject`), module, name);
      assert.ok(isModuleName(module), module);
    }
    const { dir, file } = await blueprintProject("Dirt-Track");
    const added = await addCppModule(file);
    assert.equal(added.module, "DirtTrack");
    const keyword = await blueprintProject("class");
    assert.equal((await addCppModule(keyword.file)).module, "Class");
    assert.deepEqual([...added.created].sort(), MODULE_FILES("DirtTrack"));
    assert.ok(
      (await read(dir, "Source/DirtTrack/DirtTrack.cpp")).includes(
        'IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, DirtTrack, "DirtTrack");',
      ),
    );
  });
});

/** Each row plants something in a fresh Blueprint project, and names the refusal it expects. */
const HOSTILE_ROWS: Array<{
  label: string;
  name?: string;
  code: CppModuleErrorCode;
  plant?: (project: Planted) => Promise<unknown>;
  target?: (project: Planted) => string;
  engineDir?: (project: Planted) => Promise<string>;
}> = [
  {
    label: "Source is a link to a folder outside the project",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, dir }) => {
      await mkdir(path.join(root, "outside"));
      await symlink(path.join(root, "outside"), path.join(dir, "Source"));
    },
  },
  {
    label: "the .uproject is a link",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, file }) => {
      await writeFile(path.join(root, "real.uproject"), BLUEPRINT_UPROJECT);
      await rm(file);
      await symlink(path.join(root, "real.uproject"), file);
    },
  },
  {
    label: "the project folder is a link",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, dir }) => {
      await mkdir(path.join(root, "elsewhere"));
      await writeFile(path.join(root, "elsewhere", "GxCpp.uproject"), BLUEPRINT_UPROJECT);
      await symlink(path.join(root, "elsewhere"), path.join(root, "game", "linked"));
      await rm(dir, { recursive: true });
    },
    target: ({ root }) => path.join(root, "game", "linked", "GxCpp.uproject"),
  },
  {
    label: "Source/<Module> is a link",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, dir }) => {
      await mkdir(path.join(root, "outside"));
      await mkdir(path.join(dir, "Source"));
      await symlink(path.join(root, "outside"), path.join(dir, "Source", "GxCpp"));
    },
  },
  {
    label: "a Target.cs Genex would write is a dangling link",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, dir }) => {
      await mkdir(path.join(dir, "Source"));
      await symlink(path.join(root, "nowhere.cs"), path.join(dir, "Source", "GxCpp.Target.cs"));
    },
  },
  {
    label: "the Build.cs Genex would write is a link to a file outside",
    code: CppModuleErrorCode.Link,
    plant: async ({ root, dir }) => {
      await writeFile(path.join(root, "secret.cs"), "secret");
      await mkdir(path.join(dir, "Source", "GxCpp"), { recursive: true });
      await symlink(path.join(root, "secret.cs"), path.join(dir, "Source", "GxCpp", "GxCpp.Build.cs"));
    },
  },
  {
    label: "Source is a file",
    code: CppModuleErrorCode.PathTaken,
    plant: async ({ dir }) => writeFile(path.join(dir, "Source"), "not a folder"),
  },
  {
    label: "Source/<Module> is a file",
    code: CppModuleErrorCode.PathTaken,
    plant: async ({ dir }) => {
      await mkdir(path.join(dir, "Source"));
      await writeFile(path.join(dir, "Source", "GxCpp"), "not a folder");
    },
  },
  {
    label: "a header Genex would write is a folder",
    code: CppModuleErrorCode.PathTaken,
    plant: async ({ dir }) => mkdir(path.join(dir, "Source", "GxCpp", "GxCpp.h"), { recursive: true }),
  },
  {
    label: "the .uproject is a folder",
    code: CppModuleErrorCode.NotProjectFile,
    plant: async ({ file }) => {
      await rm(file);
      await mkdir(file);
    },
  },
  {
    label: "the .uproject is missing",
    code: CppModuleErrorCode.NotProjectFile,
    plant: async ({ file }) => rm(file),
  },
  {
    label: "a relative path",
    code: CppModuleErrorCode.NotProjectFile,
    target: () => path.join("game", "unreal", "GxCpp.uproject"),
  },
  {
    label: "not a .uproject",
    code: CppModuleErrorCode.NotProjectFile,
    plant: async ({ dir }) => writeFile(path.join(dir, "GxCpp.json"), BLUEPRINT_UPROJECT),
    target: ({ dir }) => path.join(dir, "GxCpp.json"),
  },
  {
    label: "the .uproject isn't JSON",
    code: CppModuleErrorCode.Unreadable,
    plant: async ({ file }) => writeFile(file, "{ not json"),
  },
  {
    label: "the .uproject is a JSON array",
    code: CppModuleErrorCode.Unreadable,
    plant: async ({ file }) => writeFile(file, "[]"),
  },
  {
    label: "Modules isn't a list",
    code: CppModuleErrorCode.Unreadable,
    plant: async ({ file }) => writeFile(file, JSON.stringify({ FileVersion: 3, Modules: { Name: "GxCpp" } })),
  },
  {
    label: "the .uproject is huge",
    code: CppModuleErrorCode.Unreadable,
    plant: async ({ file }) =>
      writeFile(file, JSON.stringify({ FileVersion: 3, Description: "x".repeat(2 * 1024 * 1024) })),
  },
  {
    label: "the .uproject declares another module",
    code: CppModuleErrorCode.DifferentModule,
    plant: async ({ file }) =>
      writeFile(file, JSON.stringify({ FileVersion: 3, Modules: [{ Name: "Other", Type: "Runtime" }] })),
  },
  {
    label: "Source holds another module's folder",
    code: CppModuleErrorCode.DifferentModule,
    plant: async ({ dir }) => mkdir(path.join(dir, "Source", "Other"), { recursive: true }),
  },
  {
    label: "Source holds another module's target",
    code: CppModuleErrorCode.DifferentModule,
    plant: async ({ dir }) => {
      await mkdir(path.join(dir, "Source"));
      await writeFile(path.join(dir, "Source", "OtherEditor.Target.cs"), "");
    },
  },
  { label: "a project named after an engine module", name: "Engine", code: CppModuleErrorCode.ReservedName },
  { label: "an engine module in another case", name: "coreuobject", code: CppModuleErrorCode.ReservedName },
  { label: "the engine's own target name", name: "Unreal", code: CppModuleErrorCode.ReservedName },
  {
    label: "a module the installed engine has",
    name: "Landscape",
    code: CppModuleErrorCode.ReservedName,
    engineDir: async ({ root }) => {
      await mkdir(path.join(root, "UE_5.8", "Engine", "Source", "Runtime", "Landscape"), { recursive: true });
      return path.join(root, "UE_5.8");
    },
  },
];

describe("refusing what isn't Genex's to write, before anything is written", () => {
  for (const row of HOSTILE_ROWS) {
    it(row.label, async () => {
      const project = await blueprintProject(row.name);
      await row.plant?.(project);
      const engineDir = await row.engineDir?.(project);
      const before = await snapshot(project.root);
      const target = row.target?.(project) ?? project.file;
      await rejectsWith(addCppModule(target, engineDir ? { engineDir } : {}), row.code, row.label);
      assert.deepEqual(await snapshot(project.root), before, `${row.label}: nothing written`);
    });
  }

  it("a module name the engine doesn't have is fine with the engine folder given", async () => {
    const { root, file } = await blueprintProject("Rush");
    await mkdir(path.join(root, "UE_5.8", "Engine", "Source", "Runtime", "Landscape"), { recursive: true });
    const added = await addCppModule(file, { engineDir: path.join(root, "UE_5.8") });
    assert.equal(added.module, "Rush");
  });
});

describe("the project's module", () => {
  it("is the first Runtime module the .uproject names", async () => {
    const json = {
      ...JSON.parse(BLUEPRINT_UPROJECT),
      Modules: [
        { Name: "GxCppEditorTools", Type: "Editor" },
        { Name: "GxCpp", Type: "Runtime", LoadingPhase: "Default" },
        { Name: "GxCppMore", Type: "Runtime" },
      ],
    };
    const { file } = await blueprintProject("GxCpp", JSON.stringify(json, null, "\t"));
    assert.equal(await projectModule(file), "GxCpp");
  });

  it("reads a .uproject that starts with a UTF-8 byte order mark", async () => {
    const json = { ...JSON.parse(BLUEPRINT_UPROJECT), Modules: [{ Name: "GxCpp", Type: "Runtime" }] };
    const { file } = await blueprintProject("GxCpp", `﻿${JSON.stringify(json, null, "\t")}`);
    assert.equal(await projectModule(file), "GxCpp");
  });

  it("is never a C++ or C# keyword, a name the rules files use, or an underscore shape C++ reserves", async () => {
    const reserved = [
      "class",
      "namespace",
      "int",
      "delete",
      "object",
      "string",
      "System",
      "UnrealBuildTool",
      "ModuleRules",
      "TargetRules",
      "_",
      "_Gx",
      "Gx_",
      "Gx__Cpp",
    ];
    for (const name of reserved) {
      assert.equal(isModuleName(name), false, name);
      const { file } = await blueprintProject("Any", JSON.stringify({ Modules: [{ Name: name, Type: "Runtime" }] }));
      assert.equal(await projectModule(file), undefined, name);
    }
    for (const name of ["GxCpp", "Class", "system", "Gx_Cpp", "my_game"]) assert.ok(isModuleName(name), name);
  });

  it("is undefined for a Blueprint project, a name that isn't an identifier, or a file Genex won't read", async () => {
    const rows: Array<[string, (project: Planted) => Promise<unknown>]> = [
      ["a Blueprint project", async () => {}],
      [
        "a name that isn't an identifier",
        ({ file }) => writeFile(file, JSON.stringify({ Modules: [{ Name: "../../Evil", Type: "Runtime" }] })),
      ],
      [
        "a name with a space",
        ({ file }) => writeFile(file, JSON.stringify({ Modules: [{ Name: "A B", Type: "Runtime" }] })),
      ],
      ["not JSON", ({ file }) => writeFile(file, "{")],
      [
        "huge",
        ({ file }) =>
          writeFile(
            file,
            JSON.stringify({ Description: "x".repeat(2 * 1024 * 1024), Modules: [{ Name: "Big", Type: "Runtime" }] }),
          ),
      ],
      [
        "a link",
        async ({ root, file }) => {
          await writeFile(
            path.join(root, "real.uproject"),
            JSON.stringify({ Modules: [{ Name: "Linked", Type: "Runtime" }] }),
          );
          await rm(file);
          await symlink(path.join(root, "real.uproject"), file);
        },
      ],
      ["missing", ({ file }) => rm(file)],
    ];
    for (const [label, plant] of rows) {
      const project = await blueprintProject();
      await plant(project);
      assert.equal(await projectModule(project.file), undefined, label);
    }
    assert.equal(await projectModule("relative/GxCpp.uproject"), undefined);
  });
});

/** `Binaries/Mac/UnrealEditor.modules` as Unreal writes it on a Mac, naming each module's library. */
const modulesText = (modules: Record<string, string>) =>
  `${JSON.stringify({ BuildId: "58210709", Modules: modules }, null, "\t")}\n`;

/** Writes the project's `Binaries/Mac/UnrealEditor.modules`. */
async function writeModules(project: Planted, text: string) {
  await mkdir(path.join(project.dir, "Binaries", "Mac"), { recursive: true });
  await writeFile(path.join(project.dir, "Binaries", "Mac", "UnrealEditor.modules"), text);
}

describe("a hot-reloaded library of the game's module", () => {
  it("is loaded when the project's UnrealEditor.modules names the module's library with a hot reload's suffix", async () => {
    const project = await blueprintProject();
    await writeModules(project, modulesText({ GxCpp: "libUnrealEditor-GxCpp-4543.dylib" }));
    assert.equal(await hotLibraryLoaded(project.file, "GxCpp"), true);
  });

  it("is not loaded after a cold build, before any build, or when only another module was hot-reloaded", async () => {
    const rows: Array<[string, string | null]> = [
      ["a cold build's library", modulesText({ GxCpp: "libUnrealEditor-GxCpp.dylib" })],
      ["no modules file: never built", null],
      [
        "another module's hot library",
        modulesText({ GxCpp: "libUnrealEditor-GxCpp.dylib", Tools: "libUnrealEditor-Tools-12.dylib" }),
      ],
      [
        "the module's entry names another module's hot library",
        modulesText({ GxCpp: "libUnrealEditor-Other-7.dylib" }),
      ],
      ["no entry for the module", modulesText({ Tools: "libUnrealEditor-Tools-12.dylib" })],
    ];
    for (const [label, text] of rows) {
      const project = await blueprintProject();
      if (text !== null) await writeModules(project, text);
      assert.equal(await hotLibraryLoaded(project.file, "GxCpp"), false, label);
    }
  });

  it("names the game's library as a crash frame or the modules file spells it, with the hot reload's suffix apart", () => {
    const hot = GAME_LIBRARY.exec("libUnrealEditor-DirtTrack-1234.dylib");
    assert.deepEqual([hot?.[1], hot?.[2]], ["DirtTrack", "-1234"]);
    const cold = GAME_LIBRARY.exec("libUnrealEditor-DirtTrack.dylib");
    assert.deepEqual([cold?.[1], cold?.[2]], ["DirtTrack", undefined]);
    assert.equal(GAME_LIBRARY.exec("libUnrealEditor-Engine.so"), null);
  });
});
