/**
 * Where the crate checker lives in a profile's toolchain store: cargo-deny, cargo-vet and the
 * RustSec snapshot at the Rust recipe's pins (`CRATE_CHECK_COMPONENTS`), installed on demand at
 * the person's first crate approval and named by no build lock. A located tool is a regular file
 * inside its own install folder (never a link), and the snapshot a real folder holding RustSec's
 * `crates/` tree at the commit the shipped policy pins; anything else is not located, so the
 * request is refused `crate-checker-unavailable` rather than run on something the store did not
 * install.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { CRATE_CHECK_COMPONENTS, type ToolchainEntry, ToolchainHost, ToolchainId } from "../../shared/toolchain.ts";
import { isBelow } from "../paths.ts";
import type { CrateCheckTools } from "./crate-check.ts";
import type { CratePolicy } from "./crate-policy.ts";
import { componentFolder, type InstalledComponent, locateComponents } from "./locate.ts";
import { lockOf } from "./lock.ts";
import { entrySha12, manifestEntry } from "./manifest.ts";

/** The program each tool component holds at its root. */
const TOOL_PROGRAM = {
  [ToolchainId.CargoDeny]: "cargo-deny",
  [ToolchainId.CargoVet]: "cargo-vet",
} as const;
/** The snapshot's folder of advisories, one subfolder per crate. */
const ADVISORY_CRATES_FOLDER = "crates";

/** The crate checker's manifest entries for `host`, in the table's order; empty when the recipe lacks one. */
export function crateCheckEntries(host: ToolchainHost): ToolchainEntry[] {
  const entries = CRATE_CHECK_COMPONENTS.map((id) => manifestEntry(id, host));
  return entries.every((entry) => entry !== null) ? entries.filter((entry) => entry !== null) : [];
}

/** The store-relative install folders (`<id>/<version>-<sha12>`) the checker's pins name: what a prune keeps. */
export function crateCheckFolders(host: ToolchainHost): string[] {
  return crateCheckEntries(host).map((entry) => `${entry.id}/${entry.version}-${entrySha12(entry)}`);
}

/** The program `name` at the root of `component`'s folder: a regular file there itself, or null. */
async function program(component: InstalledComponent | undefined, name: string): Promise<string | null> {
  if (!component) return null;
  const host = component.receipt.host ?? ToolchainHost.MacArm64;
  const file = path.join(component.folder, host === ToolchainHost.WindowsX64 ? `${name}.exe` : name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const real = await realpath(file).catch(() => null);
  return real !== null && isBelow(component.folder, real) ? real : null;
}

/** Whether `dir` is a real folder (not a link) holding a real `crates/` folder. */
async function isSnapshot(dir: string): Promise<boolean> {
  const [root, crates] = await Promise.all([
    lstat(dir).catch(() => null),
    lstat(path.join(dir, ADVISORY_CRATES_FOLDER)).catch(() => null),
  ]);
  return root?.isDirectory() === true && crates?.isDirectory() === true;
}

/**
 * The checker's tools in the store at `store` for `host`, at the recipe's pins, with the snapshot
 * the shipped `policy` pins; null when cargo-deny or the snapshot is not installed there as the
 * store installs them, or the recipe's snapshot is not the policy's. cargo-vet may be absent (the
 * audits are then not asked). It only reads.
 */
export async function locateCrateCheckTools(
  store: string,
  host: ToolchainHost,
  policy: CratePolicy,
): Promise<CrateCheckTools | null> {
  const entries = crateCheckEntries(host);
  const snapshot = entries.find((entry) => entry.id === ToolchainId.RustsecAdvisoryDb);
  if (snapshot?.archives[0]?.sha256 !== policy.advisories.sha256) return null;
  const root = await realpath(store).catch(() => null);
  if (root === null) return null;
  const pins = Object.fromEntries(
    entries.map((entry) => [entry.id, { version: entry.version, sha12: entrySha12(entry) }]),
  );
  const found = new Map<ToolchainId, InstalledComponent>();
  for (const entry of entries) {
    const one = await locateComponents(root, lockOf(pins), [entry.id]);
    const component = one.ok ? one.components.get(entry.id) : undefined;
    const real = component ? await realpath(component.folder).catch(() => null) : null;
    // The install folder itself must be where the pin names it, not a link to elsewhere.
    if (component && real === componentFolder(root, entry.id, pins[entry.id] ?? component.receipt))
      found.set(entry.id, component);
  }
  const deny = await program(found.get(ToolchainId.CargoDeny), TOOL_PROGRAM[ToolchainId.CargoDeny]);
  const vet = await program(found.get(ToolchainId.CargoVet), TOOL_PROGRAM[ToolchainId.CargoVet]);
  const db = found.get(ToolchainId.RustsecAdvisoryDb);
  if (deny === null || !db || !(await isSnapshot(db.folder))) return null;
  const version = (id: ToolchainId) => found.get(id)?.receipt.version ?? "";
  return {
    cargoDeny: { bin: deny, version: version(ToolchainId.CargoDeny) },
    cargoVet: vet === null ? null : { bin: vet, version: version(ToolchainId.CargoVet) },
    advisoryDb: { dir: db.folder, commit: policy.advisories.commit },
  };
}
