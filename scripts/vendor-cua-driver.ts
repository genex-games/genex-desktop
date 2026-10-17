/**
 * Vendor cua-driver (trycua/cua, MIT) into a macOS build's resources, so computer control works the
 * moment the app is installed (`src/substrate/cua-embedded.ts` owns the layout and runs it).
 *
 * The one file downloaded at build time: npm carries no driver binary. The release is pinned by
 * version and SHA-256 (cua publishes both in the release's `checksums.txt`), and an archive whose
 * digest differs is refused before anything is unpacked. Only the `cua-driver` executable is taken
 * from it, thinned to the build's architecture, with cua's license and notices for that release
 * (`build/cua-driver/`) beside it. The packager then signs it with the app's identity like every
 * other executable in the bundle. The archive is cached, so a second build makes no request.
 *
 * Moving to a newer driver: change the pin below and the two notice files, then verify computer
 * control live (docs/computer-use.md).
 */
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CUA_DRIVER_BINARY, CUA_DRIVER_DIR } from "../src/substrate/cua-embedded.ts";
import { type Download, fetchTo, verifiedArchive } from "./pinned-download.ts";

/** A driver release: its version, where its macOS executable is, and that archive's SHA-256. */
export interface CuaDriverRelease {
  version: string;
  url: string;
  sha256: string;
}

/** The driver release a build ships. */
export const CUA_DRIVER_RELEASE: CuaDriverRelease = {
  version: "0.35.2",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.2/cua-driver-rs-0.35.2-darwin-universal-binary.tar.gz",
  sha256: "ec8d9a073ee8c5e81113de682ba17b040eaacd58e84139f851540092c6b8d3b6",
};

/** cua's license and notices for the pinned release, shipped beside the executable. */
const NOTICE_FILES = ["LICENSE.md", "THIRD_PARTY_NOTICES.md"] as const;
/** The file beside the executable that names its version. */
const VERSION_FILE = "VERSION";
/** Node's architecture names, as `lipo` names them. */
const LIPO_ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };

const MESSAGE = {
  arch: (arch: string) => `no cua-driver build for the ${arch} architecture`,
} as const;

/** What vendoring touches outside itself, so a test can stand in for the network and `lipo`. */
export interface VendorCuaDriverDeps {
  /** Write what `url` answers to `file`. */
  download: Download;
  /** Run a tool (`tar`, `lipo`) to completion. */
  run(command: string, args: string[]): Promise<void>;
}

export interface VendoredCuaDriver {
  version: string;
  /** The executable's size once thinned. */
  bytes: number;
}

const defaultDeps: VendorCuaDriverDeps = {
  download: fetchTo,
  run: async (command, args) => {
    await promisify(execFile)(command, args);
  },
};

/**
 * Put the pinned cua-driver in `<resources>/cua-driver/`: the executable for `arch`, cua's license
 * and notices, and its version.
 */
export async function vendorCuaDriver(
  root: string,
  resources: string,
  options: {
    arch?: string;
    cacheDir?: string;
    release?: CuaDriverRelease;
    deps?: VendorCuaDriverDeps;
  } = {},
): Promise<VendoredCuaDriver> {
  const arch = options.arch ?? process.arch;
  const lipoArch = LIPO_ARCH[arch];
  if (!lipoArch) throw new Error(MESSAGE.arch(arch));
  const release = options.release ?? CUA_DRIVER_RELEASE;
  const deps = options.deps ?? defaultDeps;
  const cacheDir = options.cacheDir ?? path.join(root, "node_modules", ".cache", "genex", "cua-driver");
  const archive = await verifiedArchive("cua-driver", release, cacheDir, deps.download);
  const unpacked = await mkdtemp(path.join(os.tmpdir(), "genex-cua-vendor-"));
  try {
    // Only the executable, by its exact name: nothing else in the archive is written anywhere.
    await deps.run("tar", ["-xzf", archive, "-C", unpacked, CUA_DRIVER_BINARY]);
    const dest = path.join(resources, CUA_DRIVER_DIR);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    const binary = path.join(dest, CUA_DRIVER_BINARY);
    await deps.run("lipo", [path.join(unpacked, CUA_DRIVER_BINARY), "-thin", lipoArch, "-output", binary]);
    await chmod(binary, 0o755);
    for (const name of NOTICE_FILES)
      await copyFile(path.join(root, "build", "cua-driver", name), path.join(dest, name));
    await writeFile(path.join(dest, VERSION_FILE), `${release.version}\n`);
    return { version: release.version, bytes: (await stat(binary)).size };
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}
