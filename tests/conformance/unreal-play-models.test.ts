/**
 * Whether an Unreal game calls play-time models when it is played in the editor
 * (`unrealGameCallsPlayTimeModels`): its Unreal project (`unreal/`, or the game folder itself) holds
 * Genex's kit and its own code or Blueprints name the kit's `GenexModelsSubsystem`. The game folder
 * is the person's and its agents
 * write in it, so nothing a folder holds makes the check follow a link, read a huge file, hang or
 * throw.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GAME_PROJECT_FOLDER } from "../../src/plugins/unreal/game-folder.ts";
import { type UnrealFilesSeen, unrealGameCallsPlayTimeModels } from "../../src/substrate/project-shape.ts";
import { tmpDir } from "../helpers/tmp.ts";

const KIT = `${GAME_PROJECT_FOLDER}/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin`;
const CLASS = "GenexModelsSubsystem";
const CALL = `#include "${CLASS}.h"\nvoid UNpc::Ask() { GetGameInstance()->GetSubsystem<U${CLASS}>()->Generate({}); }`;
/** A Blueprint as Unreal saves one: binary, with the class path it calls as plain bytes. */
const BLUEPRINT = Buffer.concat([
  Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0, 0, 1]),
  Buffer.from(`/Script/GenexMultiplayer\0${CLASS}\0`, "latin1"),
  Buffer.alloc(64, 0xff),
]);

/** A game folder holding `files` (paths from the game's root), each written as given. */
async function game(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await tmpDir("studio-unreal-models-");
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), data);
  }
  return dir;
}

describe("an Unreal game that calls play-time models", () => {
  const table: Array<{ name: string; files: Record<string, string | Buffer>; calls: boolean }> = [
    { name: "its C++ names the class", files: { [KIT]: "{}", "unreal/Source/Inn/Private/Npc.cpp": CALL }, calls: true },
    {
      name: "a header names the class",
      files: { [KIT]: "{}", "unreal/Source/Inn/Public/Npc.h": `class U${CLASS};` },
      calls: true,
    },
    {
      name: "a Blueprint carries the class path",
      files: { [KIT]: "{}", "unreal/Content/Npc/BP_Npc.uasset": BLUEPRINT },
      calls: true,
    },
    {
      name: "a level carries the class path",
      files: { [KIT]: "{}", "unreal/Content/Inn.umap": BLUEPRINT },
      calls: true,
    },
    {
      name: "the game folder is itself the Unreal project, and its C++ names the class",
      files: { "Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": "{}", "Source/Inn/Private/Npc.cpp": CALL },
      calls: true,
    },
    {
      name: "the game folder is itself the Unreal project, and a Blueprint carries the class path",
      files: { "Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": "{}", "Content/Npc/BP_Npc.uasset": BLUEPRINT },
      calls: true,
    },
    {
      name: "a folder with code that names the class and no kit of its own",
      files: { "Source/Inn/Private/Npc.cpp": CALL, "Content/Npc/BP_Npc.uasset": BLUEPRINT },
      calls: false,
    },
    {
      name: "the kit is there and nothing of the game's names the class",
      files: { [KIT]: "{}", "unreal/Source/Inn/Private/Npc.cpp": "void UNpc::Ask() {}" },
      calls: false,
    },
    { name: "the class is named and the kit is not there", files: { "unreal/Source/Inn/Npc.cpp": CALL }, calls: false },
    {
      name: "only the kit's own code names the class",
      files: { [KIT]: "{}", [`unreal/Plugins/GenexMultiplayer/Source/GenexMultiplayer/Public/${CLASS}.h`]: CALL },
      calls: false,
    },
    {
      name: "only another plugin inside the game's code names the class",
      files: { [KIT]: "{}", "unreal/Source/Plugins/Other/Npc.cpp": CALL },
      calls: false,
    },
    {
      name: "only what Unreal made names the class",
      files: {
        [KIT]: "{}",
        "unreal/Source/Intermediate/Npc.cpp": CALL,
        "unreal/Source/Saved/Npc.cpp": CALL,
        "unreal/Source/Binaries/Npc.cpp": CALL,
        "unreal/Content/DerivedDataCache/BP_Npc.uasset": BLUEPRINT,
        "unreal/Intermediate/Build/Npc.cpp": CALL,
      },
      calls: false,
    },
    {
      name: "only files of other kinds name the class",
      files: {
        [KIT]: "{}",
        "unreal/Source/Inn/notes.txt": CALL,
        "unreal/Source/Inn/BP_Npc.uasset": BLUEPRINT,
        "unreal/Content/Npc.cpp": CALL,
        "unreal/Config/DefaultGame.ini": CLASS,
        "unreal/Npc.cpp": CALL,
      },
      calls: false,
    },
    {
      name: "only a hidden folder names the class",
      files: { [KIT]: "{}", "unreal/Source/.git/Npc.cpp": CALL },
      calls: false,
    },
    { name: "the folder is empty", files: {}, calls: false },
  ];
  for (const { name, files, calls } of table)
    it(`${calls ? "calls" : "does not call"}: ${name}`, async () => {
      assert.equal(await unrealGameCallsPlayTimeModels(await game(files)), calls);
    });

  it("says no for a folder that is not there", async () => {
    assert.equal(await unrealGameCallsPlayTimeModels(path.join(await tmpDir("studio-unreal-none-"), "missing")), false);
  });
});

describe("what a game folder cannot make the check do", () => {
  const hostile: Array<{ name: string; arrange: (dir: string, outside: string) => Promise<void> }> = [
    {
      name: "Source is a link out of the game",
      arrange: async (dir, outside) => {
        await mkdir(path.join(dir, "unreal"), { recursive: true });
        await symlink(outside, path.join(dir, "unreal", "Source"));
      },
    },
    {
      name: "Content is a link out of the game",
      arrange: (dir, outside) => symlink(outside, path.join(dir, "unreal", "Content")),
    },
    {
      name: "a folder in Source is a link out of the game",
      arrange: async (dir, outside) => {
        await mkdir(path.join(dir, "unreal", "Source"), { recursive: true });
        await symlink(outside, path.join(dir, "unreal", "Source", "Inn"));
      },
    },
    {
      name: "a file in Source is a link out of the game",
      arrange: async (dir, outside) => {
        await mkdir(path.join(dir, "unreal", "Source"), { recursive: true });
        await symlink(path.join(outside, "Npc.cpp"), path.join(dir, "unreal", "Source", "Npc.cpp"));
      },
    },
    {
      name: "a file over the size the check reads names the class at its end",
      arrange: async (dir) => {
        await mkdir(path.join(dir, "unreal", "Content"), { recursive: true });
        const huge = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), Buffer.from(CLASS)]);
        await writeFile(path.join(dir, "unreal", "Content", "Big.uasset"), huge);
        await writeFile(path.join(dir, "unreal", "Content", "Big.umap"), Buffer.concat([Buffer.from(CLASS), huge]));
      },
    },
    {
      name: "the class is named deeper than the check looks",
      arrange: async (dir) => {
        const deep = path.join(dir, "unreal", "Source", ...Array.from({ length: 40 }, (_, at) => `d${at}`));
        await mkdir(deep, { recursive: true });
        await writeFile(path.join(deep, "Npc.cpp"), CALL);
      },
    },
  ];
  for (const { name, arrange } of hostile)
    it(`says no, and throws nothing: ${name}`, async () => {
      const dir = await game({ [KIT]: "{}" });
      const outside = await game({ "Npc.cpp": CALL, "BP_Npc.uasset": BLUEPRINT, "Inn/Npc.cpp": CALL });
      await arrange(dir, outside);
      assert.equal(await unrealGameCallsPlayTimeModels(dir), false);
    });

  const linkedKit: Array<{ name: string; arrange: (dir: string, outside: string) => Promise<void> }> = [
    {
      name: "unreal/ is a link",
      arrange: (dir, outside) => symlink(path.join(outside, "unreal"), path.join(dir, "unreal")),
    },
    {
      name: "unreal/Plugins is a link",
      arrange: async (dir, outside) => {
        await mkdir(path.join(dir, "unreal", "Source"), { recursive: true });
        await writeFile(path.join(dir, "unreal", "Source", "Npc.cpp"), CALL);
        await symlink(path.join(outside, "unreal", "Plugins"), path.join(dir, "unreal", "Plugins"));
      },
    },
    {
      name: "the kit's folder is a link",
      arrange: async (dir, outside) => {
        await mkdir(path.join(dir, "unreal", "Source"), { recursive: true });
        await mkdir(path.join(dir, "unreal", "Plugins"), { recursive: true });
        await writeFile(path.join(dir, "unreal", "Source", "Npc.cpp"), CALL);
        const kit = path.join("unreal", "Plugins", "GenexMultiplayer");
        await symlink(path.join(outside, kit), path.join(dir, kit));
      },
    },
  ];
  for (const { name, arrange } of linkedKit)
    it(`takes no kit reached through a link: ${name}`, async () => {
      const dir = await tmpDir("studio-unreal-models-");
      const outside = await game({ [KIT]: "{}", "unreal/Source/Inn/Npc.cpp": CALL });
      await arrange(dir, outside);
      assert.equal(await unrealGameCallsPlayTimeModels(dir), false);
    });

  it("says no for a file it may not read, and reads the next", { skip: process.platform === "win32" }, async () => {
    const dir = await game({ [KIT]: "{}", "unreal/Source/Inn/Locked.cpp": CALL });
    const locked = path.join(dir, "unreal", "Source", "Inn", "Locked.cpp");
    await chmod(locked, 0o000);
    try {
      // Root reads any file: the case proves nothing there.
      if (process.getuid?.() !== 0) assert.equal(await unrealGameCallsPlayTimeModels(dir), false);
      await writeFile(path.join(dir, "unreal", "Source", "Inn", "Npc.cpp"), CALL);
      assert.equal(await unrealGameCallsPlayTimeModels(dir), true, "one unreadable file hides no other");
    } finally {
      await chmod(locked, 0o600);
    }
  });

  it("reads a file again only when it changed, when told what an earlier check read", async () => {
    const dir = await game({ [KIT]: "{}", "unreal/Source/Inn/Private/Npc.cpp": "void UNpc::Ask() {}" });
    const npc = path.join(dir, "unreal", "Source", "Inn", "Private", "Npc.cpp");
    const seen: UnrealFilesSeen = new Map();
    assert.equal(await unrealGameCallsPlayTimeModels(dir, seen), false);
    assert.deepEqual([...seen.keys()], [npc], "the file it read is remembered");
    await writeFile(npc, CALL);
    assert.equal(
      await unrealGameCallsPlayTimeModels(dir, seen),
      true,
      "the agent wrote the call: the changed file is read",
    );
    await writeFile(path.join(dir, "unreal", "Source", "Inn", "Private", "Door.cpp"), "void UDoor::Open() {}");
    assert.equal(await unrealGameCallsPlayTimeModels(dir, seen), true, "a new file beside it changes nothing");
  });

  it("does not read an unchanged file a second time", { skip: process.platform === "win32" }, async () => {
    const dir = await game({ [KIT]: "{}", "unreal/Source/Inn/Private/Npc.cpp": CALL });
    const npc = path.join(dir, "unreal", "Source", "Inn", "Private", "Npc.cpp");
    const seen: UnrealFilesSeen = new Map();
    assert.equal(await unrealGameCallsPlayTimeModels(dir, seen), true);
    // Unreadable now, with the same size and change time: only a check that reads it again says no.
    await chmod(npc, 0o000);
    try {
      assert.equal(await unrealGameCallsPlayTimeModels(dir, seen), true, "what was read stands");
      if (process.getuid?.() !== 0) assert.equal(await unrealGameCallsPlayTimeModels(dir), false);
    } finally {
      await chmod(npc, 0o600);
    }
  });

  it("never waits on a pipe named as code", { skip: process.platform === "win32" }, async () => {
    const dir = await game({ [KIT]: "{}", "unreal/Source/Inn/readme.txt": "" });
    execFileSync("mkfifo", [path.join(dir, "unreal", "Source", "Inn", "Npc.cpp")]);
    assert.equal(await unrealGameCallsPlayTimeModels(dir), false);
  });
});
