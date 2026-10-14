/**
 * Prebuilds one raylib variant from a store's lock, with the store's one recipe implementation
 * (`raylibPrebuild` and `crossRaylibPrebuild` in `src/substrate/toolchain-store/prewarm.ts`,
 * reading `recipe.json` and the cross table): CI uses it to produce a prebuild artifact, a
 * developer to rebuild one by hand. Every step runs under the real `ProcessSandbox` with the network
 * off, writing only `--out` and its sibling work folder `<out>.work/` (the build, temporary files,
 * its own Emscripten config and cache for the web, the headless variant's build-tree copy of
 * raylib's `src/` for the Mac, zig's caches, the toolchain file, raylib's project include and the
 * wayland-scanner stand-in for Windows and Linux), which the script makes, marks and removes after a
 * successful build; the store itself is write-denied. It refuses an `--out` that holds anything
 * but an earlier prebuild, and a `<out>.work` it did not make. Nothing is downloaded.
 *
 *   node scripts/toolchains/prebuild-raylib.ts --out <dir>/raylib-<variant>
 *     [--target web|macos|windows|linux] [--variant <name>] [--store <store>] [--lock-file <file>]
 *
 * `--variant` defaults to the destination's own (`web-es3`, `macos-es3-angle`,
 * `windows-x64-es3-angle`, `linux-x64-es3-angle`); the Mac's headless one is
 * `macos-es3-angle-headless`, which compiles Genex's headless platform
 * (`native/raylib-platform/rcore_genex_headless.c`) in raylib's `rcore_memory.c` place. A Mac
 * variant needs the Command Line Tools (`xcode-select -p`, then `xcrun --show-sdk-path`). Windows
 * and Linux build with the lock's zig through a toolchain file rooted in the work folder (Linux
 * also in the lock's headers' sysroot), never on a Windows host for Linux. The store defaults to
 * `$GENEX_DEV_TOOLCHAINS/dev-store` (`scripts/toolchains/dev-store.ts`) and the lock to the one this
 * worktree's real-build rows read (`devStoreLockFile`: `GENEX_DEV_STORE_LOCK`, the worktree's
 * `.studio-dev/dev-store-lock.json`, else the store's `current-lock.json`).
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BuildTarget, isBuildTarget } from "../../src/shared/game-project.ts";
import { ToolchainId, type ToolchainLock } from "../../src/shared/toolchain.ts";
import { ProcessSandbox, type RunRequest } from "../../src/substrate/spawn.ts";
import {
  CROSS_TARGETS,
  type CrossTarget,
  crossTargetOf,
  crossToolchainFile,
} from "../../src/substrate/toolchain-store/cross-targets.ts";
import {
  HEADLESS_PLATFORM_FILE,
  headlessPlatformPath,
  raylibVariant,
  readRecipe,
  targetRecipe,
} from "../../src/substrate/toolchain-store/genex-cmake.ts";
import {
  execXcode,
  type LocatedToolchain,
  locateComponents,
  macSdkPath,
  requiredFor,
} from "../../src/substrate/toolchain-store/locate.ts";
import { isToolchainLock } from "../../src/substrate/toolchain-store/lock.ts";
import {
  cacheCloneRequest,
  crossRaylibPrebuild,
  emscriptenConfig,
  type PrebuildPlan,
  raylibPrebuild,
  toolchainIn,
} from "../../src/substrate/toolchain-store/prewarm.ts";
import { devStoreLockFile } from "../../tests/helpers/dev-toolchains.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The work folder is `--out` plus this suffix, beside it. */
const WORK_SUFFIX = ".work";
/** The file that marks a work folder as this script's own, which a later run may replace. */
const WORK_MARKER = ".genex-prebuild-work";
/** What an earlier prebuild in `--out` holds; anything else there is not this script's to overwrite. */
const PREBUILD_ENTRIES: ReadonlySet<string> = new Set(["lib", "include"]);

const MESSAGE = {
  Usage:
    "usage: node scripts/toolchains/prebuild-raylib.ts --out <dir>/raylib-<variant> [--target web|macos|windows|linux] [--variant <name>] [--store <store>] [--lock-file <file>]",
  WrongTarget: (variant: string, target: string) => `The raylib variant ${variant} is not one of ${target}'s.`,
  NoLock: (file: string) => `${file} holds no lock: build the dev store with node scripts/toolchains/dev-store.ts.`,
  Missing: (ids: readonly string[]) => `The store is missing ${ids.join(", ")} for the lock.`,
  NoSdk: "A Mac prebuild needs Apple's Command Line Tools: xcode-select -p names no developer folder.",
  NoZig: (target: string) => `A ${target} prebuild needs the lock's zig and its ANGLE.`,
  StepFailed: (label: string, code: number | null, detail: string) => `${label} failed (exit ${code}):\n${detail}`,
  Done: (out: string) => `raylib prebuilt into ${out}`,
  OutTaken: (out: string) =>
    `${out} holds something other than an earlier raylib prebuild (lib/, include/); choose another --out.`,
  WorkTaken: (work: string) => `${work} exists and was not made by this script; remove it or choose another --out.`,
} as const;

/** The names in `dir`, or null when it does not exist. */
async function namesIn(dir: string): Promise<string[] | null> {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** `--out` is absent, empty or an earlier prebuild: the one folder besides the work folder the build writes. */
async function assertOutFree(out: string): Promise<void> {
  const names = await namesIn(out);
  if (names?.some((name) => !PREBUILD_ENTRIES.has(name))) throw new Error(MESSAGE.OutTaken(out));
}

/** A fresh, marked work folder; an existing one is replaced only when it carries this script's mark. */
async function claimWork(work: string): Promise<void> {
  const names = await namesIn(work);
  if (names && !names.includes(WORK_MARKER)) throw new Error(MESSAGE.WorkTaken(work));
  if (names) await rm(work, { recursive: true, force: true });
  await mkdir(path.join(work, ".tmp"), { recursive: true });
  await writeFile(path.join(work, WORK_MARKER), "");
}

/** What the flags ask for: the destination, its raylib variant and, for Windows and Linux, the cross destination. */
interface Chosen {
  target: BuildTarget;
  variant: string;
  cross: CrossTarget | null;
}

/** The destination and variant the flags name, each checked against the recipe or the cross table. */
function chosen(values: { target?: string; variant?: string }): Chosen {
  const target = values.target ?? BuildTarget.Web;
  if (!isBuildTarget(target)) throw new Error(MESSAGE.Usage);
  const cross = crossTargetOf(target);
  if (cross) {
    const variant = values.variant ?? CROSS_TARGETS[cross].raylib;
    if (variant !== CROSS_TARGETS[cross].raylib) throw new Error(MESSAGE.WrongTarget(variant, target));
    return { target, variant, cross };
  }
  const recipe = readRecipe();
  const variant = values.variant ?? targetRecipe(recipe, target).raylib;
  if (raylibVariant(recipe, variant).target !== target) throw new Error(MESSAGE.WrongTarget(variant, target));
  return { target, variant, cross: null };
}

/** A Mac prebuild's SDK and, for the headless variant, the platform file copied into the work folder. */
async function macInputs(target: BuildTarget, variant: string, work: string) {
  if (target !== BuildTarget.Mac) return {};
  const sdk = await macSdkPath(execXcode);
  if (!sdk) throw new Error(MESSAGE.NoSdk);
  if (!raylibVariant(readRecipe(), variant).headless) return { sdk };
  const platform = path.join(work, HEADLESS_PLATFORM_FILE);
  await copyFile(headlessPlatformPath(), platform);
  return { sdk, platform };
}

/** The lock in `file`, or a refusal. */
async function readLock(file: string): Promise<ToolchainLock> {
  const value = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  if (!isToolchainLock(value)) throw new Error(MESSAGE.NoLock(file));
  return value;
}

/**
 * The plan for a Windows or Linux prebuild: the toolchain file written first into the work folder
 * (rooted there, and in the lock's sysroot for Linux), then the store's cross prebuild.
 */
async function crossPlan(cross: CrossTarget, target: BuildTarget, located: LocatedToolchain, out: string) {
  const work = `${out}${WORK_SUFFIX}`;
  const parts = located.cross?.[target];
  if (!located.zig || !parts) throw new Error(MESSAGE.NoZig(target));
  const sysroot = parts.sysroot === undefined ? {} : { sysroot: parts.sysroot };
  const text = crossToolchainFile(cross, { lock: located.lock, zig: located.zig, root: work, ...sysroot });
  await writeFile(parts.toolchainFile, text);
  return crossRaylibPrebuild(cross, located, readRecipe(), { out, work }, { platform: process.platform });
}

/** The plan for the web or the Mac: the web's Emscripten cache and config first, then the store's prebuild. */
async function nativePlan(
  wanted: Chosen,
  located: LocatedToolchain,
  out: string,
  run: (request: RunRequest) => Promise<void>,
  emsdk: string,
): Promise<PrebuildPlan> {
  const work = `${out}${WORK_SUFFIX}`;
  if (wanted.target === BuildTarget.Web && located.emscripten) {
    await run(cacheCloneRequest(located, emsdk, work, process.platform));
    await writeFile(located.emscripten.config, emscriptenConfig(emsdk, located.emscripten.node));
  }
  const options = await macInputs(wanted.target, wanted.variant, work);
  return raylibPrebuild(wanted.variant, located, readRecipe(), { out, work }, options);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      target: { type: "string" },
      variant: { type: "string" },
      store: { type: "string" },
      "lock-file": { type: "string" },
    },
  });
  if (!values.out) throw new Error(MESSAGE.Usage);
  const wanted = chosen(values);
  const toolchains = process.env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains");
  const store = await realpath(values.store ?? path.join(toolchains, "dev-store"));
  const lock = await readLock(path.resolve(values["lock-file"] ?? devStoreLockFile(process.env, REPO)));
  const found = await locateComponents(store, lock, requiredFor([wanted.target]));
  if (!found.ok) throw new Error(MESSAGE.Missing(found.missing));

  const out = path.resolve(values.out);
  const work = `${out}${WORK_SUFFIX}`;
  await assertOutFree(out);
  await claimWork(work);
  await mkdir(out, { recursive: true });
  const located = await toolchainIn(work, lock, found.components);
  const emsdk = found.components.get(ToolchainId.Emsdk)?.folder ?? "";
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genex-prebuild-"));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [],
    scratchDir: path.join(scratch, "tmp"),
    secretPaths: [],
  });
  const policy = { allowedDomains: [], allowWrite: [out, work], denyWrite: [store, path.join(scratch, "tmp")] };
  const run = async (request: RunRequest) => {
    const result = await sandbox.run({ ...request, policy });
    if (result.code !== 0)
      throw new Error(MESSAGE.StepFailed(request.label ?? "", result.code, result.stderr || result.stdout));
    console.log(`${request.label}: ok in ${(result.durationMs / 1000).toFixed(1)} s`);
  };
  try {
    if (path.basename(out) !== `raylib-${wanted.variant}`)
      console.log(`note: the store names this prebuild raylib-${wanted.variant}`);
    const plan = wanted.cross
      ? await crossPlan(wanted.cross, wanted.target, located, out)
      : await nativePlan(wanted, located, out, run, emsdk);
    for (const file of plan.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.text, { mode: file.mode });
    }
    for (const request of plan.steps) await run(request);
    await rm(work, { recursive: true, force: true });
    console.log(MESSAGE.Done(out));
  } finally {
    await sandbox.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
