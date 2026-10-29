/**
 * Whether the person has signed in to Roblox in Studio, read from Studio's own logs in a real
 * temporary folder: only Studio's logs written since the wait began count, each look reads only
 * what a log gained, and a hostile folder (a link, a linked log, another program's log) answers no
 * and is never followed.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SIGNED_IN_MARK, signInWatch, studioLogFolder } from "../../src/plugins/roblox/studio-logs.ts";
import { tmpDir } from "../helpers/tmp.ts";

const STUDIO_LOG = "0.744.0.7441077_20261022T120919Z_Studio_ECD98_last.log";
const LINE = (text: string) => `2026-10-22T12:56:36.800Z,2878.800537,1f84,6,Info ${text}\n`;
const SIGNED_IN = LINE(SIGNED_IN_MARK);
const STARTED = LINE("[FLog::StudioKeyEvents] login (automatic) [start]");
const NOT_ON_WINDOWS = { skip: process.platform === "win32" && "links need privileges on Windows" };

/** A fresh log folder, and the wait's start just before now. */
async function logs() {
  const folder = path.join(await tmpDir("roblox-studio-logs-"), "logs");
  await mkdir(folder);
  return { folder, since: Date.now() - 60_000 };
}

describe("Studio's log folder", () => {
  it("is in the person's Library on a Mac and in LOCALAPPDATA on Windows; elsewhere unknown", () => {
    assert.equal(studioLogFolder("darwin", {}, "/Users/maker"), "/Users/maker/Library/Logs/Roblox");
    assert.equal(
      studioLogFolder("win32", { LOCALAPPDATA: "C:\\Users\\maker\\AppData\\Local" }, "C:\\Users\\maker"),
      "C:\\Users\\maker\\AppData\\Local\\Roblox\\logs",
    );
    assert.equal(studioLogFolder("win32", { LOCALAPPDATA: "relative\\path" }, "C:\\Users\\maker"), undefined);
    assert.equal(studioLogFolder("linux", {}, "/home/maker"), undefined);
  });
});

describe("whether the person has signed in, from Studio's logs", () => {
  it("answers no until Studio's log records a finished sign-in, then yes", async () => {
    const { folder, since } = await logs();
    const file = path.join(folder, STUDIO_LOG);
    await writeFile(file, STARTED);
    const signedIn = signInWatch(folder, since);
    assert.equal(await signedIn(), false);
    await appendFile(file, SIGNED_IN);
    assert.equal(await signedIn(), true);
  });

  it("finds the mark when a look ends in the middle of it", async () => {
    const { folder, since } = await logs();
    const file = path.join(folder, STUDIO_LOG);
    const half = Math.floor(SIGNED_IN.length / 2);
    await writeFile(file, STARTED + SIGNED_IN.slice(0, half));
    const signedIn = signInWatch(folder, since);
    assert.equal(await signedIn(), false);
    await appendFile(file, SIGNED_IN.slice(half));
    assert.equal(await signedIn(), true);
  });

  it("answers no with no folder, or no folder Genex can tell", async () => {
    const { folder, since } = await logs();
    assert.equal(await signInWatch(path.join(folder, "missing"), since)(), false);
    assert.equal(await signInWatch(undefined, since)(), false);
  });

  const hostile: { name: string; make: (folder: string, outside: string) => Promise<string>; options?: object }[] = [
    {
      name: "a log written before the wait began (an earlier sign-in)",
      make: async (folder) => {
        const file = path.join(folder, STUDIO_LOG);
        await writeFile(file, SIGNED_IN);
        const old = new Date(Date.now() - 3_600_000);
        await utimes(file, old, old);
        return folder;
      },
    },
    {
      name: "another program's log (the installer's)",
      make: async (folder) => {
        await writeFile(path.join(folder, "RobloxStudioInstaller_3EBAA.log"), SIGNED_IN);
        return folder;
      },
    },
    {
      name: "a Studio log that links to a file outside",
      make: async (folder, outside) => {
        const target = path.join(outside, "planted.log");
        await writeFile(target, SIGNED_IN);
        await symlink(target, path.join(folder, STUDIO_LOG));
        return folder;
      },
      options: NOT_ON_WINDOWS,
    },
    {
      name: "a log folder that is a link to a folder outside",
      make: async (folder, outside) => {
        await writeFile(path.join(outside, STUDIO_LOG), SIGNED_IN);
        const linked = path.join(path.dirname(folder), "linked-logs");
        await symlink(outside, linked);
        return linked;
      },
      options: NOT_ON_WINDOWS,
    },
    {
      name: "a folder named as a Studio log",
      make: async (folder) => {
        await mkdir(path.join(folder, STUDIO_LOG));
        return folder;
      },
    },
  ];
  for (const each of hostile)
    it(`answers no for ${each.name}`, each.options ?? {}, async () => {
      const { folder, since } = await logs();
      const outside = path.join(path.dirname(folder), "outside");
      await mkdir(outside);
      const watched = await each.make(folder, outside);
      assert.equal(await signInWatch(watched, since)(), false);
    });
});
