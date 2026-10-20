/**
 * Where a native build finds libcolyseus (MP-1a): the store's `colyseus` component holds one
 * folder of static libraries per triple (`toolchain-store/colyseus.ts`), and every native cargo
 * build names its triple's folder in `GENEX_COLYSEUS_LIB_DIR`. The vendored relay client's build
 * script (genex-multiplayer `build.rs`) downloads the xcframework on a Mac when that variable is
 * unset, so the lane always sets it: to the store's folder, or, where this host's manifest pins no
 * component, to a folder inside the build that does not exist, so the script stops with its own
 * "has no libcolyseus.a" message and never reaches the network. A browser build links nothing.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { type ToolchainHost, ToolchainId } from "../shared/toolchain.ts";
import { colyseusLibraryFile, COLYSEUS_LIB_FOLDER } from "../substrate/toolchain-store/colyseus.ts";
import { componentFolder } from "../substrate/toolchain-store/locate.ts";
import { entrySha12, manifestEntry } from "../substrate/toolchain-store/manifest.ts";

/** The variable the crate's build script reads its library folder from. */
export const COLYSEUS_LIB_DIR_ENV = "GENEX_COLYSEUS_LIB_DIR";
/** The never-created folder inside a build that a host with no pinned component names instead. */
export const COLYSEUS_ABSENT_FOLDER = "colyseus-not-pinned";
/** Triples that link nothing: the browser's relay client is the JS bridge. */
const BRIDGE_ARCH = "wasm32-";

/** Why a triple has no libcolyseus folder. Wire values: never rename one. */
export const ColyseusRefusal = {
  /** This host's manifest pins no `colyseus` component. */
  NotPinned: "colyseus-not-pinned",
  /** The component is pinned but not installed, or holds no library for the triple. */
  NotInstalled: "colyseus-not-installed",
} as const;
export type ColyseusRefusal = (typeof ColyseusRefusal)[keyof typeof ColyseusRefusal];

const MESSAGE = {
  NotPinned: (host: string) => `No libcolyseus is pinned for ${host}.`,
  NotInstalled: (triple: string, dir: string) => `libcolyseus for ${triple} is not installed (${dir}).`,
} as const;

/** The store folder of this host's `colyseus` component (installed or not), or null when the manifest pins none for `host`. */
export function colyseusComponentFolder(store: string, host: ToolchainHost | null): string | null {
  const entry = host === null ? null : manifestEntry(ToolchainId.Colyseus, host);
  if (entry === null) return null;
  return componentFolder(store, ToolchainId.Colyseus, { version: entry.version, sha12: entrySha12(entry) });
}

/** `triple`'s library folder in a `colyseus` component folder. */
export function colyseusLibDir(component: string, triple: string): string {
  return path.join(component, COLYSEUS_LIB_FOLDER, triple);
}

/**
 * The variables a cargo build for `triple` carries: `GENEX_COLYSEUS_LIB_DIR` naming the
 * component's folder for the triple, or the never-created {@link COLYSEUS_ABSENT_FOLDER} inside
 * `bin` when no component is pinned; nothing for a browser build.
 */
export function colyseusBuildEnv(component: string | null, bin: string, triple: string): Record<string, string> {
  if (triple.startsWith(BRIDGE_ARCH)) return {};
  const dir = component === null ? path.join(bin, COLYSEUS_ABSENT_FOLDER) : colyseusLibDir(component, triple);
  return { [COLYSEUS_LIB_DIR_ENV]: dir };
}

/** `triple`'s installed library folder, or why there is none. */
export async function resolveColyseusLibDir(
  component: string | null,
  host: ToolchainHost | null,
  triple: string,
): Promise<{ ok: true; dir: string } | { ok: false; refusal: ColyseusRefusal; detail: string }> {
  if (component === null)
    return { ok: false, refusal: ColyseusRefusal.NotPinned, detail: MESSAGE.NotPinned(String(host)) };
  const dir = colyseusLibDir(component, triple);
  const core = await lstat(path.join(dir, colyseusLibraryFile("colyseus"))).catch(() => null);
  if (!core?.isFile())
    return { ok: false, refusal: ColyseusRefusal.NotInstalled, detail: MESSAGE.NotInstalled(triple, dir) };
  return { ok: true, dir };
}
