/**
 * New Roblox game's place file: Genex writes `<name>.rbxlx` from its shipped Baseplate template into
 * the game folder through a hidden temporary file beside it, so the place appears whole or not at
 * all. A name that is taken gets the next free one, an existing file is never overwritten, and a
 * folder that is a link is refused with nothing written.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CreatePlaceError,
  CreatePlaceRefusal,
  createPlace,
  placeSlug,
  SHIPPED_TEMPLATE,
  suggestName,
} from "../../src/plugins/roblox/create-place.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEMPLATE = SHIPPED_TEMPLATE;

async function gameFolder(): Promise<string> {
  // By real path, as the place's own path comes back (macOS: /var is a link to /private/var).
  const dir = await realpath(await tmpDir("roblox-place-"));
  const game = path.join(dir, "sky-race");
  await mkdir(game);
  return game;
}

const refused = (code: CreatePlaceRefusal) => (error: unknown) =>
  error instanceof CreatePlaceError && error.code === code;

describe("a new place from the shipped Baseplate", () => {
  it("holds a Workspace with a Baseplate and a SpawnLocation, and Lighting", async () => {
    const game = await gameFolder();
    const text = await readFile(
      await createPlace({ folder: game, name: "sky-race.rbxlx", template: TEMPLATE }),
      "utf8",
    );
    assert.match(text, /^<roblox [^>]*version="4">/);
    const workspace = text.slice(text.indexOf('class="Workspace"'), text.indexOf('class="Lighting"'));
    assert.match(workspace, /<string name="Name">Baseplate<\/string>/);
    assert.match(workspace, /class="SpawnLocation"/);
    assert.ok(text.includes('class="Lighting"'));
    assert.ok(text.trimEnd().endsWith("</roblox>"));
  });
});

describe("New Roblox game's place file", () => {
  it("writes the template into the game folder through a hidden file beside it, then names it", async () => {
    const game = await gameFolder();
    const seen: string[] = [];
    const file = await createPlace({
      folder: game,
      name: "sky-race.rbxlx",
      template: TEMPLATE,
      write: async (temp, bytes) => {
        seen.push(temp);
        assert.equal(path.dirname(temp), game, "beside the place");
        assert.ok(path.basename(temp).startsWith("."), "hidden while it is written");
        assert.equal(existsSync(path.join(game, "sky-race.rbxlx")), false, "no place until it is whole");
        await writeFile(temp, bytes, { flag: "wx" });
      },
    });
    assert.equal(file, path.join(game, "sky-race.rbxlx"));
    assert.equal(seen.length, 1);
    assert.deepEqual(await readFile(file), await readFile(TEMPLATE));
    assert.deepEqual(await readdir(game), ["sky-race.rbxlx"], "no temporary file left");
  });

  it("leaves no place and no temporary file when the write stops part-way", async () => {
    const game = await gameFolder();
    await assert.rejects(
      createPlace({
        folder: game,
        name: "sky-race.rbxlx",
        template: TEMPLATE,
        write: async (temp, bytes) => {
          await writeFile(temp, bytes.subarray(0, 100));
          throw new Error("disk full");
        },
      }),
      /disk full/,
    );
    assert.deepEqual(await readdir(game), []);
  });

  it("never overwrites a place that is already there", async () => {
    const game = await gameFolder();
    await writeFile(path.join(game, "sky-race.rbxlx"), "the person's own");
    await assert.rejects(
      createPlace({ folder: game, name: "sky-race.rbxlx", template: TEMPLATE }),
      refused(CreatePlaceRefusal.Exists),
    );
    assert.equal(await readFile(path.join(game, "sky-race.rbxlx"), "utf8"), "the person's own");
    assert.deepEqual(await readdir(game), ["sky-race.rbxlx"]);
  });

  it("refuses a game folder that is a link, writing nothing", { skip: process.platform === "win32" }, async () => {
    const game = await gameFolder();
    const elsewhere = path.join(path.dirname(game), "elsewhere");
    await mkdir(elsewhere);
    const linked = path.join(path.dirname(game), "linked");
    await symlink(elsewhere, linked);
    await assert.rejects(
      createPlace({ folder: linked, name: "sky-race.rbxlx", template: TEMPLATE }),
      refused(CreatePlaceRefusal.Linked),
    );
    assert.deepEqual(await readdir(elsewhere), []);
  });

  it("refuses a place that is a link already, writing nothing through it", {
    skip: process.platform === "win32",
  }, async () => {
    const game = await gameFolder();
    const target = path.join(path.dirname(game), "target.rbxlx");
    await symlink(target, path.join(game, "sky-race.rbxlx"));
    await assert.rejects(
      createPlace({ folder: game, name: "sky-race.rbxlx", template: TEMPLATE }),
      refused(CreatePlaceRefusal.Exists),
    );
    assert.equal(existsSync(target), false);
  });

  /** Names that are not one plain `.rbxlx` file in the game folder. */
  const BAD_NAMES = [
    "",
    "sky-race",
    "sky-race.rbxl",
    "../sky-race.rbxlx",
    "a/sky-race.rbxlx",
    "a\\sky-race.rbxlx",
    ".sky-race.rbxlx",
    "sky\u0000race.rbxlx",
    "CON.rbxlx",
    `${"a".repeat(80)}.rbxlx`,
  ];
  for (const name of BAD_NAMES)
    it(`refuses the name ${JSON.stringify(name)}`, async () => {
      const game = await gameFolder();
      await assert.rejects(
        createPlace({ folder: game, name, template: TEMPLATE }),
        refused(CreatePlaceRefusal.BadName),
      );
      assert.deepEqual(await readdir(game), []);
    });
});

describe("the place's suggested name", () => {
  it("is the game's title in small letters and dashes", () => {
    assert.equal(placeSlug("Sky Race!"), "sky-race");
    assert.equal(placeSlug("  Ünïcode — Rally 2  "), "unicode-rally-2");
    assert.equal(placeSlug("???"), "place");
    assert.equal(placeSlug("con"), "con-place", "never a Windows device name");
    assert.ok(placeSlug("x".repeat(200)).length <= 40);
  });

  it("is the next free name when one is taken", async () => {
    const game = await gameFolder();
    assert.equal(await suggestName(game, "Sky Race"), "sky-race.rbxlx");
    await writeFile(path.join(game, "sky-race.rbxlx"), "");
    assert.equal(await suggestName(game, "Sky Race"), "sky-race-2.rbxlx");
    await writeFile(path.join(game, "sky-race-2.rbxlx"), "");
    await writeFile(path.join(game, "sky-race-3.rbxl"), "");
    assert.equal(await suggestName(game, "Sky Race"), "sky-race-3.rbxlx");
  });
});
