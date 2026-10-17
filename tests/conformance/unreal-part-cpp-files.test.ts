/**
 * The gate reads a part's C++ (`unreal/Source/<Module>/Parts/<Part>/`) from the builder's copy of
 * the game, and compares the copy's Source with the game's: a builder writes the copy, so the
 * folder is read by real path, only plain `.h` and `.cpp` files at most one folder deep, within
 * caps; anything else is a problem, a link is never followed and nothing is written.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { copyStamp, PART_CPP_LIMITS, readPartCpp } from "../../src/plugins/unreal/part-files.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MODULE = "Rush";
const UPROJECT = JSON.stringify({ FileVersion: 3, Modules: [{ Name: MODULE, Type: "Runtime" }] });
const BUILD_CS = "public class Rush : ModuleRules {}\n";
const FOLDER = `unreal/Source/${MODULE}/Parts/Bike`;

/** Writes the module's own files and a landed part Hud under `unreal` of `dir`. */
async function writeGame(dir: string) {
  const source = path.join(dir, "unreal", "Source", MODULE);
  await mkdir(path.join(source, "Parts", "Hud"), { recursive: true });
  await writeFile(path.join(dir, "unreal", "Rush.uproject"), UPROJECT);
  await writeFile(path.join(source, "Rush.Build.cs"), BUILD_CS);
  await writeFile(path.join(source, "Rush.h"), "#pragma once\n");
  await writeFile(path.join(source, "Parts", "Hud", "Hud.h"), "// hud\n");
  await writeFile(path.join(dir, "unreal", "Source", "Rush.Target.cs"), "// target\n");
}

/** The game (with its module) and a builder's copy of it holding the part Bike's C++. */
async function world() {
  const root = await realpath(await tmpDir("studio-part-cpp-"));
  const game = path.join(root, "game");
  const copy = path.join(root, "copy");
  await writeGame(game);
  await writeGame(copy);
  const part = path.join(copy, ...FOLDER.split("/"));
  await mkdir(path.join(part, "Private"), { recursive: true });
  await writeFile(path.join(part, "BikeCamera.h"), "UCLASS() class ABikeCamera {};\n");
  await writeFile(path.join(part, "Private", "BikeCamera.cpp"), '#include "BikeCamera.h"\n');
  const project = path.join(game, "unreal", "Rush.uproject");
  return { root, game, copy, part, project, read: () => readPartCpp("Bike", { copy, project }) };
}
type World = Awaited<ReturnType<typeof world>>;

/** Every entry under `dir` with its kind and content, sorted. */
async function snapshot(dir: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of (await readdir(dir, { recursive: true })).sort()) {
    const full = path.join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) rows.push(`${entry} -> ${await readlink(full)}`);
    else if (info.isFile()) rows.push(`${entry} = ${await readFile(full, "utf8")}`);
    else rows.push(`${entry}/`);
  }
  return rows;
}

describe("reading a part's C++ from the builder's copy", () => {
  it("reads its headers and sources, one folder deep, with the game's module", async () => {
    const w = await world();
    const read = await w.read();
    assert.equal(read.module, MODULE);
    assert.equal(read.folder, FOLDER);
    assert.deepEqual(Object.keys(read.files).sort(), ["BikeCamera.h", "Private/BikeCamera.cpp"]);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.outside, []);
  });

  it("has no module and reads nothing in a Blueprint game", async () => {
    const w = await world();
    await writeFile(path.join(w.copy, "unreal", "Rush.uproject"), JSON.stringify({ FileVersion: 3 }));
    const read = await w.read();
    assert.equal(read.module, undefined);
    assert.deepEqual(read.files, {});
  });

  it("reads a part without a C++ folder as no files", async () => {
    const w = await world();
    await rm(w.part, { recursive: true });
    const read = await w.read();
    assert.equal(read.module, MODULE);
    assert.deepEqual(read.files, {});
    assert.deepEqual(read.problems, []);
  });

  it("refuses a part name that is a path", async () => {
    const w = await world();
    for (const name of ["../Bike", "Bike/x", "", "Bike "]) {
      await assert.rejects(readPartCpp(name, { copy: w.copy, project: w.project }), Error, JSON.stringify(name));
    }
  });
});

describe("a part's C++ folder a builder made hostile", () => {
  type Row = { label: string; plant: (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>; file: string };
  const HOSTILE: Row[] = [
    {
      label: "a header that is a link to a secret",
      plant: async (w) => {
        await writeFile(path.join(w.root, "secret.h"), "SECRET");
        await symlink(path.join(w.root, "secret.h"), path.join(w.part, "Leak.h"));
      },
      file: `${FOLDER}/Leak.h`,
    },
    {
      label: "a subfolder that is a link",
      plant: async (w) => {
        await mkdir(path.join(w.root, "elsewhere"));
        await writeFile(path.join(w.root, "elsewhere", "Evil.h"), "SECRET");
        await symlink(path.join(w.root, "elsewhere"), path.join(w.part, "Public"));
      },
      file: `${FOLDER}/Public`,
    },
    {
      label: "a folder two deep",
      plant: async (w) => {
        await mkdir(path.join(w.part, "Private", "Deep"));
        await writeFile(path.join(w.part, "Private", "Deep", "Deep.h"), "SECRET");
      },
      file: `${FOLDER}/Private/Deep`,
    },
    {
      label: "a file that isn't C++",
      plant: (w) => writeFile(path.join(w.part, "notes.txt"), "SECRET"),
      file: `${FOLDER}/notes.txt`,
    },
    {
      label: "a C# rules file",
      plant: (w) => writeFile(path.join(w.part, "Bike.Build.cs"), "SECRET"),
      file: `${FOLDER}/Bike.Build.cs`,
    },
    {
      label: "a header with a space in its name",
      plant: (w) => writeFile(path.join(w.part, "Bike Camera.h"), "SECRET"),
      file: `${FOLDER}/Bike Camera.h`,
    },
    {
      label: "a header too large",
      plant: (w) => writeFile(path.join(w.part, "Big.h"), `// SECRET${"x".repeat(PART_CPP_LIMITS.fileBytes)}`),
      file: `${FOLDER}/Big.h`,
    },
  ];

  for (const row of HOSTILE) {
    it(`names ${row.label}, never reads it and writes nothing`, async () => {
      const w = await world();
      await row.plant(w);
      const before = await snapshot(w.root);
      const read = await w.read();
      assert.ok(
        read.problems.some((p) => p.file === row.file),
        `${row.label}: ${JSON.stringify(read.problems)}`,
      );
      assert.ok(!JSON.stringify(read.files).includes("SECRET"), `${row.label}: not read`);
      assert.deepEqual(Object.keys(read.files).sort(), ["BikeCamera.h", "Private/BikeCamera.cpp"], row.label);
      assert.deepEqual(await snapshot(w.root), before, `${row.label}: nothing written`);
    });
  }

  it("names a folder with more files than a part may have, reading no more than the cap", async () => {
    const w = await world();
    for (let i = 0; i < PART_CPP_LIMITS.files; i++) await writeFile(path.join(w.part, `Extra${i}.h`), "// x\n");
    const read = await w.read();
    assert.ok(read.problems.some((p) => p.file === FOLDER));
    assert.equal(Object.keys(read.files).length, PART_CPP_LIMITS.files);
  });

  it("names a part folder, or a folder on the way to it, that is a link", async () => {
    const w = await world();
    const parts = path.join(w.copy, "unreal", "Source", MODULE, "Parts");
    await rm(w.part, { recursive: true });
    await mkdir(path.join(w.root, "other", "Bike"), { recursive: true });
    await writeFile(path.join(w.root, "other", "Bike", "BikeCamera.h"), "SECRET");
    await symlink(path.join(w.root, "other", "Bike"), path.join(parts, "Bike"));
    const read = await w.read();
    assert.ok(read.problems.some((p) => p.file === FOLDER));
    assert.deepEqual(read.files, {});
  });
});

describe("C++ the copy changed outside the part's own folder", () => {
  it("is nothing when the copy's Source is the game's plus the part's own folder", async () => {
    const w = await world();
    assert.deepEqual((await w.read()).outside, []);
  });

  it("names every file the copy added or changed, anywhere in its Source but the part's folder", async () => {
    const w = await world();
    const source = path.join(w.copy, "unreal", "Source");
    await writeFile(path.join(source, MODULE, "Rush.Build.cs"), `${BUILD_CS}// more\n`);
    await writeFile(path.join(source, MODULE, "Parts", "Hud", "Hud.h"), "// changed\n");
    await mkdir(path.join(source, MODULE, "Parts", "Lap"));
    await writeFile(path.join(source, MODULE, "Parts", "Lap", "Lap.h"), "// another part's folder\n");
    await writeFile(path.join(source, "Other.Target.cs"), "// new\n");
    await symlink(path.join(w.root, "game"), path.join(source, MODULE, "Linked"));
    const outside = (await w.read()).outside;
    assert.deepEqual(outside.sort(), [
      "unreal/Source/Other.Target.cs",
      "unreal/Source/Rush/Linked",
      "unreal/Source/Rush/Parts/Hud/Hud.h",
      "unreal/Source/Rush/Parts/Lap/Lap.h",
      "unreal/Source/Rush/Rush.Build.cs",
    ]);
  });

  // The open editor writes Python caches into the game's Genex editor helper; a builder's copy (a
  // git worktree) never has them, so naming them would fail every part at the gate.
  it("never names what the editor or a build generates in the game and git ignores: Python caches, a plugin's Intermediate and Binaries", async () => {
    const w = await world();
    const plugin = path.join(w.game, "unreal", "Plugins", "GenexEditorHelper");
    await mkdir(path.join(plugin, "Content", "Python", "genex_loop", "__pycache__"), { recursive: true });
    await writeFile(path.join(plugin, "Content", "Python", "genex_loop", "__pycache__", "parts.cpython-311.pyc"), "x");
    await writeFile(path.join(plugin, "Content", "Python", "genex_loop", "stale.pyc"), "x");
    for (const generated of ["Intermediate", "Binaries"]) {
      await mkdir(path.join(plugin, generated, "Mac"), { recursive: true });
      await writeFile(path.join(plugin, generated, "Mac", "made.bin"), "x");
    }
    await mkdir(path.join(w.game, "unreal", "Source", MODULE, "__pycache__"), { recursive: true });
    await writeFile(path.join(w.game, "unreal", "Source", MODULE, "__pycache__", "x.pyc"), "x");
    assert.deepEqual((await w.read()).outside, []);
  });

  it("names a module file the copy lost, but not another part's file that landed after the copy was made", async () => {
    const w = await world();
    await rm(path.join(w.copy, "unreal", "Source", MODULE, "Rush.h"));
    await mkdir(path.join(w.game, "unreal", "Source", MODULE, "Parts", "Jumps"));
    await writeFile(path.join(w.game, "unreal", "Source", MODULE, "Parts", "Jumps", "Jumps.h"), "// landed\n");
    assert.deepEqual((await w.read()).outside, ["unreal/Source/Rush/Rush.h"]);
  });

  // UnrealBuildTool also reads the .uproject (modules, plugins, build steps) and every enabled
  // plugin's descriptor and rules, so a copy that changed them never compiles.
  const outsideSource: Array<{ label: string; plant: (w: World) => Promise<unknown>; named: string[] }> = [
    {
      label: "a .uproject with a build step",
      plant: (w) =>
        writeFile(
          path.join(w.copy, "unreal", "Rush.uproject"),
          JSON.stringify({ ...JSON.parse(UPROJECT), PreBuildSteps: { Mac: ["echo planted"] } }),
        ),
      named: ["unreal/Rush.uproject"],
    },
    {
      label: "a .uproject that is a link",
      plant: async (w) => {
        await rm(path.join(w.copy, "unreal", "Rush.uproject"));
        await symlink(w.project, path.join(w.copy, "unreal", "Rush.uproject"));
      },
      named: ["unreal/Rush.uproject"],
    },
    {
      label: "a plugin the copy added",
      plant: async (w) => {
        await mkdir(path.join(w.copy, "unreal", "Plugins", "Planted"), { recursive: true });
        await writeFile(path.join(w.copy, "unreal", "Plugins", "Planted", "Planted.uplugin"), "{}");
      },
      named: ["unreal/Plugins/Planted/Planted.uplugin"],
    },
    {
      label: "a plugin's descriptor and rules the copy changed",
      plant: async (w) => {
        await writeFile(path.join(w.copy, "unreal", "Plugins", "Kit", "Kit.uplugin"), '{"PreBuildSteps":{}}');
        await writeFile(path.join(w.copy, "unreal", "Plugins", "Kit", "Source", "Kit.Build.cs"), "// changed\n");
      },
      named: ["unreal/Plugins/Kit/Kit.uplugin", "unreal/Plugins/Kit/Source/Kit.Build.cs"],
    },
    {
      label: "a plugin file the copy lost",
      plant: (w) => rm(path.join(w.copy, "unreal", "Plugins", "Kit", "Source", "Kit.Build.cs")),
      named: ["unreal/Plugins/Kit/Source/Kit.Build.cs"],
    },
    {
      label: "a Plugins folder that is a link",
      plant: async (w) => {
        await rm(path.join(w.copy, "unreal", "Plugins"), { recursive: true });
        await symlink(path.join(w.root, "elsewhere"), path.join(w.copy, "unreal", "Plugins"));
      },
      named: ["unreal/Plugins"],
    },
  ];
  for (const row of outsideSource) {
    it(`names ${row.label}, and writes nothing`, async () => {
      const w = await world();
      for (const dir of [w.game, w.copy]) {
        await mkdir(path.join(dir, "unreal", "Plugins", "Kit", "Source"), { recursive: true });
        await writeFile(path.join(dir, "unreal", "Plugins", "Kit", "Kit.uplugin"), "{}");
        await writeFile(path.join(dir, "unreal", "Plugins", "Kit", "Source", "Kit.Build.cs"), "// kit\n");
      }
      await mkdir(path.join(w.root, "elsewhere"));
      assert.deepEqual((await w.read()).outside, [], `${row.label}: equal before`);
      await row.plant(w);
      const before = await snapshot(w.root);
      const outside = (await w.read()).outside;
      for (const named of row.named) assert.ok(outside.includes(named), `${row.label}: ${named} in ${outside}`);
      assert.deepEqual(await snapshot(w.root), before, `${row.label}: nothing written`);
    });
  }

  it("compares nothing when the copy is the game itself", async () => {
    const w = await world();
    const read = await readPartCpp("Bike", { copy: w.game, project: w.project });
    assert.deepEqual(read.outside, []);
  });
});

describe("the stamp of what the copy builds besides the part's own C++", () => {
  it("ignores the part's own folder and sees the rest of Source, Plugins and the .uproject", async () => {
    const w = await world();
    const stamp = () => copyStamp({ copy: w.copy, project: w.project }, { module: MODULE, part: "Bike" });
    const touch = (file: string, ms: number) => utimes(file, new Date(ms), new Date(ms));
    const base = await stamp();
    await touch(path.join(w.part, "BikeCamera.h"), 5_000);
    assert.equal(await stamp(), base, "the part's own files are fingerprinted by their text instead");
    const rows: Array<[string, () => Promise<unknown>]> = [
      [
        "another part's file",
        () => touch(path.join(w.copy, "unreal", "Source", MODULE, "Parts", "Hud", "Hud.h"), 6_000),
      ],
      ["the module's own file", () => writeFile(path.join(w.copy, "unreal", "Source", MODULE, "Rush.h"), "// new\n")],
      ["a plugin", () => mkdir(path.join(w.copy, "unreal", "Plugins", "Kit"), { recursive: true })],
      ["the .uproject", () => writeFile(path.join(w.copy, "unreal", "Rush.uproject"), "{}")],
    ];
    let previous = base;
    for (const [label, change] of rows) {
      await change();
      const next = await stamp();
      assert.notEqual(next, previous, label);
      previous = next;
    }
  });
});
