import fs from "node:fs";
import path from "node:path";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { readVersion, safeChild } from "./files.mjs";

/**
 * How long a build no profile names is kept: one still being made has no launch record naming it
 * yet, and no build takes this long.
 */
const UNNAMED_BUILD_GRACE_MS = HOUR_MS;
/** A dev build's folder name (`b-` and a UUID); anything else in `builds/` is not this module's. */
const BUILD_ID = /^b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The profile records that name a build: the one it starts on, and the one it last ran. */
const BUILD_RECORDS = ["launch.json", "attempt.json"] as const;

/** Every build a profile's records name; throws when a record cannot be read. */
function namedBuilds(root: string): Set<string> {
  const named = new Set<string>();
  const profiles = safeChild(root, "profiles");
  for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of BUILD_RECORDS) {
      const record = path.join(profiles, entry.name, file);
      if (!fs.existsSync(record)) continue;
      const { buildId } = readVersion(record);
      if (typeof buildId === "string") named.add(buildId);
    }
  }
  return named;
}

/**
 * Removes the dev builds in a `.studio-dev` folder that no profile names, once they are an hour
 * old, and returns their ids. Every launch makes a new build, so without this each start keeps
 * another copy of the app. Nothing is removed when a profile's record cannot be read.
 */
export function pruneUnusedBuilds(root: string, now: number = Date.now()): string[] {
  let named: Set<string>;
  try {
    named = namedBuilds(root);
  } catch {
    return [];
  }
  const builds = safeChild(root, "builds");
  const removed: string[] = [];
  for (const entry of fs.readdirSync(builds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !BUILD_ID.test(entry.name) || named.has(entry.name)) continue;
    const dir = safeChild(builds, entry.name);
    if (now - fs.lstatSync(dir).mtimeMs < UNNAMED_BUILD_GRACE_MS) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
