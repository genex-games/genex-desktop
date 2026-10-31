import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateProfile } from "../../../scripts/studio-dev/ownership.mjs";
import { safeChild, readVersion, fingerprints, filesBelow, digest } from "../../../scripts/studio-dev/files.mjs";
import { holdBuild } from "../../../scripts/studio-dev/builds.ts";

/** Why a developer launch is refused; `already-running:` is the prefix the studio-dev scripts read. */
const MESSAGE = {
  packaged: "Developer control is not supported in packaged apps",
  invalidConfig: "invalid owned launch configuration",
  wrongBuild: "wrong build identity",
  outputChanged: "built output changed since publication",
  alreadyRunning: "already-running: development profile has an Electron owner",
} as const;

/** The build a launch names: the checkout it was built from and its id. */
interface LaunchBuild {
  checkout: string;
  buildId: string;
}

/** Is `configPath` this profile's own launch file, written for this very build? */
function ownsLaunchConfig(
  configPath: string,
  config: { buildId?: unknown; ownerId?: unknown },
  owner: { root: string; ownerId: string },
  build: LaunchBuild,
): boolean {
  return (
    configPath === safeChild(owner.root, "launch.json") &&
    config.buildId === build.buildId &&
    config.ownerId === owner.ownerId
  );
}

/** Does the published build manifest describe this checkout's developer build? */
function isThisDeveloperBuild(
  manifest: { checkout?: unknown; buildId?: unknown; flags?: { developer?: unknown } },
  build: LaunchBuild,
): boolean {
  return (
    manifest.checkout === build.checkout && manifest.buildId === build.buildId && Boolean(manifest.flags?.developer)
  );
}

/** Has anything under the build folder changed since the manifest recorded its digest? */
function outputChanged(buildRoot: string, outputDigest: unknown): boolean {
  const published = filesBelow(buildRoot).filter((f: string) => f !== "build.json");
  return digest(fingerprints(buildRoot, published)) !== outputDigest;
}

/**
 * Claim an owned development profile for this launch: check its launch file, the build it names
 * and that build's output, write the lease, and point Electron's storage at the profile.
 */
export function initializeLaunch(build: LaunchBuild, configPath: string) {
  if (app.isPackaged) throw new Error(MESSAGE.packaged);
  const config = readVersion(configPath);
  const owner = validateProfile(build.checkout, config.profileId);
  if (!ownsLaunchConfig(configPath, config, owner, build)) throw new Error(MESSAGE.invalidConfig);
  const buildRoot = safeChild(build.checkout, `.studio-dev/builds/${build.buildId}`);
  const manifest = readVersion(path.join(buildRoot, "build.json"));
  if (!isThisDeveloperBuild(manifest, build)) throw new Error(MESSAGE.wrongBuild);
  if (outputChanged(buildRoot, manifest.outputDigest)) throw new Error(MESSAGE.outputChanged);
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  fs.writeFileSync(
    safeChild(owner.root, "lease.json"),
    JSON.stringify({ version: 1, ownerId: owner.ownerId, instanceId, pid: process.pid, startedAt }),
    { flag: "wx", mode: 0o600 },
  );
  app.setPath("userData", owner.electron);
  app.setPath("sessionData", owner.session);
  app.setName(`Genex Dev ${owner.profileId}`);
  if (!app.requestSingleInstanceLock()) throw new Error(MESSAGE.alreadyRunning);
  const buildHandle = holdBuild(buildRoot);
  return { ...owner, instanceId, startedAt, manifest, buildRoot, buildHandle };
}

/** What a claimed developer launch knows about its profile, build and instance. */
export type LaunchContext = ReturnType<typeof initializeLaunch>;
