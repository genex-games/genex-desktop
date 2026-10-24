/**
 * The asset-library fixture: the fixture game's Assets tab as the account's library sees it. Four
 * Genex files, each in its job's own folder and linked (`.studio/library-links.json`) to one of the
 * fixture library's generations — a model not saved, a saved one, a shared one and a saved sound —
 * and a picture dropped in by hand, which Save can send but Share cannot take. The files are the
 * fixture library's own stand-ins: one-triangle models, a short tone and a gradient picture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FixtureGenerationId, toneWav, triangleGlb } from "./fixture-asset-library.ts";
import { gradientShot } from "./fixture-kit.ts";

/** Each Genex file: its job's folder (a uuid, as Genex names them), its name, its generation and how it is drawn. */
const GENEX_FILES = [
  {
    job: "6f1d2c3a-0b4e-4c5d-8e9f-0a1b2c3d4e01",
    name: "giant-mushroom-tree.glb",
    generationId: FixtureGenerationId.Mushroom,
    bytes: () => triangleGlb(18),
  },
  {
    job: "6f1d2c3a-0b4e-4c5d-8e9f-0a1b2c3d4e02",
    name: "silt-strider.glb",
    generationId: FixtureGenerationId.Strider,
    bytes: () => triangleGlb(35),
  },
  {
    job: "6f1d2c3a-0b4e-4c5d-8e9f-0a1b2c3d4e03",
    name: "chitin-hut.glb",
    generationId: FixtureGenerationId.Hut,
    bytes: () => triangleGlb(40),
  },
  {
    job: "6f1d2c3a-0b4e-4c5d-8e9f-0a1b2c3d4e04",
    name: "stadium-crowd.wav",
    generationId: FixtureGenerationId.Crowd,
    bytes: () => toneWav(),
  },
] as const;

/** The picture dropped into the game by hand: no generation, so only Save takes it. */
const DROPPED = { file: "assets/stone-path.png", from: [96, 92, 84], to: [52, 50, 46] } as const;

/** Where a game keeps which generation each file is. */
const LINKS = [".studio", "library-links.json"] as const;

/** Each Genex file's path in the game. */
export const ASSET_LIBRARY_FILES = GENEX_FILES.map((entry) => `assets/genex/${entry.job}/${entry.name}`);

/** Writes the four Genex files, their links to the fixture library and the dropped picture into the game. */
export async function seedAssetLibrary(gameDir: string): Promise<void> {
  const files: Record<string, { generationId: string; sent: boolean }> = {};
  for (const entry of GENEX_FILES) {
    const folder = path.join(gameDir, "assets", "genex", entry.job);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, entry.name), entry.bytes());
    files[`assets/genex/${entry.job}/${entry.name}`] = { generationId: entry.generationId, sent: false };
  }
  await writeFile(path.join(gameDir, DROPPED.file), gradientShot(DROPPED.from, DROPPED.to));
  await mkdir(path.join(gameDir, LINKS[0]), { recursive: true });
  await writeFile(path.join(gameDir, ...LINKS), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}
