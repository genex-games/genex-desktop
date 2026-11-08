/**
 * A profile whose games were on a drive that is gone (a USB disk unplugged, a network drive no
 * longer mapped) still starts. On Windows the drive is a letter no volume holds, so every walk up
 * from a game's folder ends at a root that does not exist either: 0.1.35 could not start there
 * (`ENOENT: no such file or directory, realpath 'J:\'`). Elsewhere it is a mount folder that went
 * away. The games in the chosen games folder are not listed meanwhile, and that folder stays
 * chosen for the launch that finds the drive again.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StudioCore } from "../../src/main/studio-core.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import type { ProjectIndexFile } from "../../src/substrate/game-workspace.ts";
import { sharedResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Drive letters, from the end of the alphabet, where a volume is least usual. */
const DRIVE_LETTERS = "ZYXWVUTSRQPONMLKJIHGFED";

/** The root of a drive that is not there: a free letter on Windows, a mount folder that went away elsewhere. */
function goneDrive(base: string): string | undefined {
  if (process.platform !== StudioPlatform.Windows) return path.join(base, "Volumes", "gone");
  const letter = [...DRIVE_LETTERS].find((free) => !existsSync(`${free}:\\`));
  return letter && `${letter}:\\`;
}

/** A profile as an install that kept its games on `drive` leaves it, with one game on the local disk. */
async function profileWithGamesOn(drive: string, base: string) {
  const userData = path.join(base, "userData");
  const localRoot = path.join(base, "AI Games");
  const chosenRoot = path.join(drive, "AI Games");
  await mkdir(path.join(localRoot, "here"), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "games-root.json"), JSON.stringify({ dir: chosenRoot }));
  const index: ProjectIndexFile = {
    version: 1,
    aliases: { elsewhere: path.join(drive, "Elsewhere", "elsewhere") },
    recents: [{ name: "dyina", dir: path.join(chosenRoot, "dyina"), openedAt: "2026-11-07T10:00:00.000Z" }],
    presentation: {
      [path.join(chosenRoot, "dyina")]: { title: "Dyina", pinned: true },
      [path.join(drive, "Elsewhere", "elsewhere")]: { title: "Far away" },
      [drive]: { title: "A game at the root of the drive" },
    },
  };
  await writeFile(path.join(userData, "projects.json"), JSON.stringify(index));
  return { userData, localRoot, chosenRoot };
}

describe("a drive that is gone", () => {
  it("Genex starts on a profile whose games and chosen games folder were on it, and lists the games it can reach", async (t) => {
    const base = await tmpDir("studio-gone-drive-");
    const gone = goneDrive(base);
    if (!gone) return t.skip("every drive letter holds a volume");
    const { userData, localRoot, chosenRoot } = await profileWithGamesOn(gone, base);
    const core = new StudioCore({
      paths: { userData, resources: await sharedResources() },
      gamesRoot: localRoot,
      engines: [],
      sandbox: false,
      execPath: process.execPath,
    });
    // Stopping is safe on a core that never started, so a failed start is stopped too.
    t.after(() => core.stop());
    await core.init();

    assert.equal(core.layout.gamesRoot, localRoot, "this launch makes its games in the default folder");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(userData, "games-root.json"), "utf8")),
      { dir: chosenRoot },
      "the chosen folder stays chosen for the launch that finds the drive again",
    );
    assert.deepEqual(
      (await core.games.list()).map((game) => game.name),
      ["here"],
    );
    assert.deepEqual(await core.games.recents(), []);
    const made = await core.createGame("Made meanwhile");
    assert.equal(path.dirname(made.dir), localRoot);
  });
});
