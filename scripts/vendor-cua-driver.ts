/**
 * Vendor cua-driver (trycua/cua, MIT) into a macOS or Windows build's resources, so computer control
 * works the moment the app is installed (`src/substrate/cua-embedded.ts` owns the layout and runs it).
 *
 * The one file downloaded at build time: npm carries no driver binary. Each release is pinned by
 * version and SHA-256 (cua publishes both in the release's `checksums.txt`), and an archive whose
 * digest differs is refused before anything is unpacked. Only the driver's executable is taken from
 * it, with cua's license and notices for that release (`build/cua-driver/`) beside it. On macOS it is
 * thinned to the build's architecture and the packager signs it with the app's identity like every
 * other executable in the bundle; on Windows it ships as cua signed it (Cua AI, Inc.). The archive is
 * cached, so a second build makes no request.
 *
 * Moving to a newer driver: change the pins below and the two notice files, then verify computer
 * control live on both systems (docs/computer-use.md).
 */
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cuaDriverBinary, CUA_DRIVER_DIR } from "../src/substrate/cua-embedded.ts";
import { type Download, fetchTo, verifiedArchive } from "./pinned-download.ts";
import { sevenZip } from "./vendor-git-for-windows.ts";

/** A driver release: its version, where its executable's archive is, and that archive's SHA-256. */
export interface CuaDriverRelease {
  version: string;
  url: string;
  sha256: string;
}

/** The driver release a macOS build ships: one universal archive, thinned to the build's architecture. */
export const CUA_DRIVER_RELEASE: CuaDriverRelease = {
  version: "0.35.2",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.2/cua-driver-rs-0.35.2-darwin-universal-binary.tar.gz",
  sha256: "ec8d9a073ee8c5e81113de682ba17b040eaacd58e84139f851540092c6b8d3b6",
};

/** The driver releases a Windows build ships, by Node's architecture name: Genex ships for x64. */
export const CUA_DRIVER_WINDOWS_RELEASES: Readonly<Record<string, CuaDriverRelease>> = {
  x64: {
    version: "0.35.2",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.2/cua-driver-rs-0.35.2-windows-x86_64-binary.zip",
    sha256: "0eb49cb651986d2888294484be84c25a33e1cd31396e57c457f501358decdd4e",
  },
};

/** cua's license and notices for the pinned release, shipped beside the executable. */
const NOTICE_FILES = ["LICENSE.md", "THIRD_PARTY_NOTICES.md"] as const;
/** The file beside the executable that names its version. */
const VERSION_FILE = "VERSION";
/** Node's architecture names, as `lipo` names them. */
const LIPO_ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };

const MESSAGE = {
  arch: (arch: string) => `no cua-driver build for the ${arch} architecture`,
  platform: (platform: string) => `no cua-driver build for ${platform}: computer control ships on macOS and Windows`,
} as const;

/** What vendoring touches outside itself, so a test can stand in for the network, `lipo` and 7-Zip. */
export interface VendorCuaDriverDeps {
  /** Write what `url` answers to `file`. */
  download: Download;
  /** Run a tool (`tar`, `lipo`, 7-Zip) to completion. */
  run(command: string, args: string[]): Promise<void>;
}

export interface VendoredCuaDriver {
  version: string;
  /** The executable's size as shipped. */
  bytes: number;
}

const defaultDeps: VendorCuaDriverDeps = {
  download: fetchTo,
  run: async (command, args) => {
    await promisify(execFile)(command, args);
  },
};

/** How one system's build is vendored: which release, and how its executable is taken from the archive. */
interface Unpack {
  release: CuaDriverRelease;
  /** Put the executable alone from `archive` at `binary`, using `unpacked` as scratch. */
  take(archive: string, unpacked: string, binary: string, deps: VendorCuaDriverDeps): Promise<void>;
}

/** The macOS build: the universal executable, thinned to `arch`. */
function macUnpack(arch: string, release: CuaDriverRelease | undefined): Unpack {
  const lipoArch = LIPO_ARCH[arch];
  if (!lipoArch) throw new Error(MESSAGE.arch(arch));
  const name = cuaDriverBinary("darwin");
  return {
    release: release ?? CUA_DRIVER_RELEASE,
    take: async (archive, unpacked, binary, deps) => {
      // Only the executable, by its exact name: nothing else in the archive is written anywhere.
      await deps.run("tar", ["-xzf", archive, "-C", unpacked, name]);
      await deps.run("lipo", [path.join(unpacked, name), "-thin", lipoArch, "-output", binary]);
      await chmod(binary, 0o755);
    },
  };
}

/** The Windows build: the executable for `arch`, taken from the zip by 7-Zip (Windows' own tar may be shadowed by Git's). */
function windowsUnpack(arch: string, release: CuaDriverRelease | undefined, zip: string): Unpack {
  const pinned = release ?? CUA_DRIVER_WINDOWS_RELEASES[arch];
  if (!pinned) throw new Error(MESSAGE.arch(arch));
  const name = cuaDriverBinary("win32");
  return {
    release: pinned,
    take: async (archive, unpacked, binary, deps) => {
      // Only the executable, by its exact name, without the archive's folders.
      await deps.run(zip, ["e", "-y", "-bso0", "-bsp0", `-o${unpacked}`, archive, name]);
      await copyFile(path.join(unpacked, name), binary);
    },
  };
}

/**
 * Put the pinned cua-driver in `<resources>/cua-driver/`: the executable for `platform` and `arch`,
 * cua's license and notices, and its version.
 */
export async function vendorCuaDriver(
  root: string,
  resources: string,
  options: {
    arch?: string;
    platform?: NodeJS.Platform;
    cacheDir?: string;
    release?: CuaDriverRelease;
    deps?: VendorCuaDriverDeps;
    /** 7-Zip, for a Windows build: its usual place by default. */
    sevenZip?: string;
  } = {},
): Promise<VendoredCuaDriver> {
  const arch = options.arch ?? process.arch;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error(MESSAGE.platform(platform));
  const unpack =
    platform === "win32"
      ? windowsUnpack(arch, options.release, options.sevenZip ?? sevenZip())
      : macUnpack(arch, options.release);
  const deps = options.deps ?? defaultDeps;
  const cacheDir = options.cacheDir ?? path.join(root, "node_modules", ".cache", "genex", "cua-driver");
  const archive = await verifiedArchive("cua-driver", unpack.release, cacheDir, deps.download);
  const unpacked = await mkdtemp(path.join(os.tmpdir(), "genex-cua-vendor-"));
  try {
    const dest = path.join(resources, CUA_DRIVER_DIR);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    const binary = path.join(dest, cuaDriverBinary(platform));
    await unpack.take(archive, unpacked, binary, deps);
    for (const name of NOTICE_FILES)
      await copyFile(path.join(root, "build", "cua-driver", name), path.join(dest, name));
    await writeFile(path.join(dest, VERSION_FILE), `${unpack.release.version}\n`);
    return { version: unpack.release.version, bytes: (await stat(binary)).size };
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}
