/**
 * A profile's vendored crate overlay (extension ladder level 4): the crates the person approved
 * for a game, vetted by the vendor job (`crate-vendor-job.ts`) and kept beside the store's own
 * vendored set, inside the profile's toolchain store (which no sandboxed process writes). It is
 * per profile: nothing seeds it from another profile, so an approval in a developer profile never
 * reaches the normal one, and per game: a crate is granted to the game it was approved for only.
 *
 * ```
 * <store>/crate-overlay/
 *   vendor/<name>-<version>/     one vetted crate, with cargo's .cargo-checksum.json
 *   overlay.json                 the digest manifest: each crate's tree digest and facts, and
 *                                each game's grants (written by the host only)
 *   requests.json                the request ledger (`main/crate-requests.ts`)
 *   jobs/<job>/                  a vendor job's folder while it runs
 *   incoming/<job>/              archives on their way into the download cache
 * ```
 *
 * Every read for a build re-digests each granted crate's folder against the manifest: a changed,
 * missing or linked file, or a manifest that is not the host's shape, refuses the grant
 * `crate-overlay-tampered` before cargo can read anything.
 */
import { lstat, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { CrateRefusal } from "../../shared/crate-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../fsx.ts";
import { treeDigest } from "./archive.ts";
import {
  type CrateId,
  type CrateRefused,
  crateId,
  isCrateName,
  isCrateVersion,
  type VettedCrate,
} from "./crate-vendor-job.ts";

/** The overlay's folder in a profile's toolchain store. */
export const CRATE_OVERLAY_FOLDER = "crate-overlay";
const MANIFEST_FILE = "overlay.json";
const LEDGER_FILE = "requests.json";
const MANIFEST_SCHEMA = 1;
/** The most of the manifest the host reads. */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const MESSAGE = {
  manifest: "the overlay's digest manifest is not the host's",
  changed: (key: string) => `${key} no longer matches its digest`,
  missing: (key: string) => `${key} is missing from the overlay`,
  unreadable: (key: string, why: string) => `${key} cannot be read: ${why}`,
} as const;

/** The overlay's folders and files under one profile's store. */
export interface OverlayLayout {
  root: string;
  vendor: string;
  jobs: string;
  incoming: string;
  manifest: string;
  ledger: string;
}

/** The overlay of the store at `store` (a profile's `layout.toolchains`). */
export function crateOverlayLayout(store: string): OverlayLayout {
  const root = path.join(store, CRATE_OVERLAY_FOLDER);
  return {
    root,
    vendor: path.join(root, "vendor"),
    jobs: path.join(root, "jobs"),
    incoming: path.join(root, "incoming"),
    manifest: path.join(root, MANIFEST_FILE),
    ledger: path.join(root, LEDGER_FILE),
  };
}

/** One vetted crate as the manifest records it. */
export interface OverlayCrate extends CrateId {
  /** The `.crate` archive's sha256 (the index's). */
  cksum: string;
  /** Its folder's tree digest. */
  digest: string;
  licence: string | null;
  buildScript: boolean;
  procMacro: boolean;
}

/** One crate granted to a game, and the request that granted it. */
export interface OverlayGrantRow extends CrateId {
  requestId: string;
}

/** The overlay's digest manifest. */
export interface OverlayManifest {
  schema: number;
  /** By `name@version`. */
  crates: Record<string, OverlayCrate>;
  /** By game. */
  grants: Record<string, OverlayGrantRow[]>;
}

/** What a build of one game may read from the overlay, or why it may read nothing. */
export type OverlayGrant = { ok: true; vendor: string; crates: OverlayCrate[] } | CrateRefused;

const tampered = (detail: string): CrateRefused => ({ ok: false, refusal: CrateRefusal.OverlayTampered, detail });
const emptyManifest = (): OverlayManifest => ({ schema: MANIFEST_SCHEMA, crates: {}, grants: {} });

function overlayCrate(value: unknown): OverlayCrate | null {
  if (!isJsonObject(value) || !isCrateName(value.name) || !isCrateVersion(value.version)) return null;
  const digests = typeof value.cksum === "string" && typeof value.digest === "string";
  if (!digests || !SHA256.test(String(value.cksum)) || !SHA256.test(String(value.digest))) return null;
  const licence = typeof value.licence === "string" ? value.licence : null;
  const flags = typeof value.buildScript === "boolean" && typeof value.procMacro === "boolean";
  if (!flags) return null;
  return {
    name: value.name,
    version: value.version,
    cksum: String(value.cksum),
    digest: String(value.digest),
    licence,
    buildScript: value.buildScript === true,
    procMacro: value.procMacro === true,
  };
}

function grantRow(value: unknown): OverlayGrantRow | null {
  if (!isJsonObject(value) || !isCrateName(value.name) || !isCrateVersion(value.version)) return null;
  if (typeof value.requestId !== "string") return null;
  return { name: value.name, version: value.version, requestId: value.requestId };
}

/** The manifest's own shape checked field by field; null for anything else. */
function shapedManifest(value: unknown): OverlayManifest | null {
  if (!isJsonObject(value) || value.schema !== MANIFEST_SCHEMA) return null;
  if (!isJsonObject(value.crates) || !isJsonObject(value.grants)) return null;
  const crates: Record<string, OverlayCrate> = Object.create(null);
  for (const [key, raw] of Object.entries(value.crates)) {
    const crate = overlayCrate(raw);
    if (!crate || crateId(crate) !== key) return null;
    crates[key] = crate;
  }
  const grants: Record<string, OverlayGrantRow[]> = Object.create(null);
  for (const [project, raw] of Object.entries(value.grants)) {
    if (!Array.isArray(raw)) return null;
    const rows = raw.map(grantRow);
    if (rows.some((row) => row === null || !(crateId(row) in crates))) return null;
    grants[project] = rows.filter((row) => row !== null);
  }
  return { schema: MANIFEST_SCHEMA, crates, grants };
}

/**
 * The overlay's digest manifest: an empty one when there is none yet, null when the file is
 * there but not the host's (a link, oversize, not JSON, or not its shape).
 */
export async function readOverlayManifest(layout: OverlayLayout): Promise<OverlayManifest | null> {
  const present = await lstat(layout.manifest).catch(() => null);
  if (!present) return emptyManifest();
  const bytes = await readRegularFile(layout.manifest, MANIFEST_MAX_BYTES).catch(() => null);
  if (bytes === null) return null;
  try {
    return shapedManifest(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

/** The folder of one vetted crate in the overlay. */
export function overlayCrateDir(layout: OverlayLayout, crate: CrateId): string {
  return path.join(layout.vendor, `${crate.name}-${crate.version}`);
}

/** Whether a crate's folder still matches its recorded digest; the refusal otherwise. */
async function verifyCrate(layout: OverlayLayout, crate: OverlayCrate): Promise<CrateRefused | null> {
  const dir = overlayCrateDir(layout, crate);
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return tampered(MESSAGE.missing(crateId(crate)));
  try {
    const digest = await treeDigest(dir);
    return digest.sha256 === crate.digest ? null : tampered(MESSAGE.changed(crateId(crate)));
  } catch (error) {
    return tampered(MESSAGE.unreadable(crateId(crate), errorMessage(error)));
  }
}

/**
 * What a build of `project` may read: the crates granted to it, each re-digested against the
 * manifest, and the overlay's vendor folder. No grant is an empty one; a manifest or crate folder
 * that does not match is `crate-overlay-tampered`.
 */
export async function overlayGrant(layout: OverlayLayout, project: string): Promise<OverlayGrant> {
  const manifest = await readOverlayManifest(layout);
  if (manifest === null) return tampered(MESSAGE.manifest);
  const rows = Object.hasOwn(manifest.grants, project) ? (manifest.grants[project] ?? []) : [];
  const crates: OverlayCrate[] = [];
  for (const row of rows) {
    const crate = manifest.crates[crateId(row)];
    if (!crate) return tampered(MESSAGE.manifest);
    const refused = await verifyCrate(layout, crate);
    if (refused) return refused;
    crates.push(crate);
  }
  return { ok: true, vendor: layout.vendor, crates };
}

/**
 * Adopts a vetted closure into the overlay and grants it to `project`: each crate's job folder
 * moves into `vendor/` (a crate already there must still match its digest and the job's), then
 * the manifest is rewritten atomically. Answers the grant rows added.
 */
export async function adoptVettedCrates(
  layout: OverlayLayout,
  project: string,
  requestId: string,
  vetted: readonly VettedCrate[],
): Promise<{ ok: true; added: OverlayGrantRow[] } | CrateRefused> {
  const manifest = await readOverlayManifest(layout);
  if (manifest === null) return tampered(MESSAGE.manifest);
  await mkdir(layout.vendor, { recursive: true });
  for (const crate of vetted) {
    const key = crateId(crate);
    const known = manifest.crates[key];
    if (known) {
      const refused =
        (await verifyCrate(layout, known)) ?? (known.digest === crate.digest ? null : tampered(MESSAGE.changed(key)));
      if (refused) return refused;
      continue;
    }
    const into = overlayCrateDir(layout, crate);
    // A folder no manifest names is a leftover of an interrupted adoption, never trusted.
    await rm(into, { recursive: true, force: true });
    await rename(crate.dir, into);
    const { name, version, cksum, digest, licence, buildScript, procMacro } = crate;
    manifest.crates[key] = { name, version, cksum, digest, licence, buildScript, procMacro };
  }
  const existing = Object.hasOwn(manifest.grants, project) ? (manifest.grants[project] ?? []) : [];
  const held = new Set(existing.map(crateId));
  const added = vetted
    .filter((crate) => !held.has(crateId(crate)))
    .map((crate) => ({ name: crate.name, version: crate.version, requestId }));
  manifest.grants[project] = [...existing, ...added];
  await atomicWriteJson(layout.manifest, manifest);
  return { ok: true, added };
}

/**
 * A directory source holding the store's vendored crates and the granted overlay crates, as links
 * the host writes into `into` (made fresh): cargo's `directory` replacement reads one folder.
 * Every link names a real folder of the store's set or of the grant; nothing else is linked.
 */
export async function mergedVendor(
  storeVendor: string,
  grant: readonly CrateId[],
  overlayVendor: string,
  into: string,
): Promise<void> {
  // A junction needs no privilege on Windows; elsewhere a folder link.
  const kind = process.platform === "win32" ? "junction" : "dir";
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  const granted = new Set(grant.map((crate) => `${crate.name}-${crate.version}`));
  for (const entry of await readdir(storeVendor, { withFileTypes: true })) {
    if (!entry.isDirectory() || granted.has(entry.name)) continue;
    await symlink(path.join(storeVendor, entry.name), path.join(into, entry.name), kind);
  }
  for (const name of granted) await symlink(path.join(overlayVendor, name), path.join(into, name), kind);
}
