/**
 * The dev builds `studio:dev start` makes (`.studio-dev/builds/b-<uuid>`), one per start, and the
 * owned profiles that launch them. Nothing removed them, so they piled up on a developer's disk.
 * `listDevBuilds` names each build's referencing profiles; `pruneDevBuilds` removes the orphans:
 * a `b-<uuid>` folder (never a link) that no profile's launch, attempt or controller record names
 * and that is older than {@link BUILD_PRUNE_GRACE_MS}, since a start still building one has not
 * written its record yet. A profile record that cannot be read refuses the prune.
 */
import fs from "node:fs";
import path from "node:path";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { safeChild } from "./files.mjs";

/** A build younger than this may be one a concurrent start is still making: never pruned. */
export const BUILD_PRUNE_GRACE_MS = HOUR_MS;
/** The name every `studio:dev start` gives its build; other folders under `builds` are someone's own. */
const BUILD_ID = /^b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The profile records that name the build a profile launched or is launching. */
const RECORDS = ["launch.json", "attempt.json", "controller.json"] as const;

/** One dev build: its bytes, the profiles that name it, and whether a prune would remove it. */
export interface DevBuild {
  buildId: string;
  bytes: number;
  referencedBy: string[];
  orphan: boolean;
}

/** The builds under a dev root, and the bytes a prune would free. */
export interface DevBuildList {
  builds: DevBuild[];
  reclaimableBytes: number;
}

/** The plain (not linked) entries of `dir`, by name, or none when it is absent. */
function plainEntries(dir: string): fs.Dirent[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The build id one record names, or null when the record is absent; an unreadable one throws, naming it. */
function recordedBuild(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const buildId = JSON.parse(fs.readFileSync(file, "utf8"))?.buildId;
    return typeof buildId === "string" ? buildId : null;
  } catch (error) {
    throw new Error(`cannot read ${file}; nothing is pruned: ${(error as Error).message}`);
  }
}

/** Each build id the owned profiles name, with the profiles naming it. */
function references(root: string): Map<string, string[]> {
  const named = new Map<string, string[]>();
  for (const profile of plainEntries(path.join(root, "profiles"))) {
    for (const record of RECORDS) {
      const buildId = recordedBuild(path.join(root, "profiles", profile.name, record));
      if (!buildId) continue;
      const profiles = named.get(buildId) ?? [];
      if (!profiles.includes(profile.name)) named.set(buildId, [...profiles, profile.name]);
    }
  }
  return named;
}

/** The bytes of the files under `dir`, never following a link. */
function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(at);
    else if (entry.isFile()) total += fs.lstatSync(at).size;
  }
  return total;
}

/** Every dev build under the dev root `root`, with its referencing profiles, at `now`. */
export function listDevBuilds(root: string, now: number): DevBuildList {
  const named = references(root);
  const builds = plainEntries(path.join(root, "builds")).map((entry): DevBuild => {
    const dir = path.join(root, "builds", entry.name);
    const referencedBy = named.get(entry.name) ?? [];
    const old = now - fs.lstatSync(dir).mtimeMs > BUILD_PRUNE_GRACE_MS;
    const orphan = BUILD_ID.test(entry.name) && referencedBy.length === 0 && old;
    return { buildId: entry.name, bytes: treeBytes(dir), referencedBy, orphan };
  });
  const reclaimableBytes = builds.filter((b) => b.orphan).reduce((sum, b) => sum + b.bytes, 0);
  return { builds, reclaimableBytes };
}

/** Removes every orphan build under the dev root `root` (see the module header); answers what went. */
export function pruneDevBuilds(root: string, now: number): { removed: string[]; bytes: number } {
  const orphans = listDevBuilds(root, now).builds.filter((build) => build.orphan);
  for (const build of orphans) fs.rmSync(safeChild(root, `builds/${build.buildId}`), { recursive: true });
  return { removed: orphans.map((build) => build.buildId), bytes: orphans.reduce((sum, b) => sum + b.bytes, 0) };
}
