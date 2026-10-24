import { constants } from "node:fs";
import { copyFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { tmpDir } from "./tmp.ts";

type SeededWorkspace = { ws: string; manifest: string };
const baselines = new Map<string, Promise<SeededWorkspace>>();

async function initialize(seedDir: string): Promise<SeededWorkspace> {
  const root = await tmpDir("seed-upgrade-baseline-");
  const ws = path.join(root, "workspace");
  const manifest = path.join(root, "manifest.json");
  await applySeed({ seedDir, workspaceDir: ws, manifestFile: manifest });
  return { ws, manifest };
}

/** Copy an immutable seed's initialized state into a fresh case; the baseline is never imported or edited. */
export async function cloneSeededWorkspace(seedDir: string, root: string): Promise<SeededWorkspace> {
  const input = path.resolve(seedDir);
  let pending = baselines.get(input);
  if (!pending) {
    pending = initialize(input);
    baselines.set(input, pending);
  }
  const baseline = await pending;
  const ws = path.join(root, "workspace");
  const manifest = path.join(root, "manifest.json");
  // Refuse workspace reuse: every import graph must have new absolute paths.
  await mkdir(ws);
  await cp(baseline.ws, ws, { recursive: true });
  await copyFile(baseline.manifest, manifest, constants.COPYFILE_EXCL);
  return { ws, manifest };
}
