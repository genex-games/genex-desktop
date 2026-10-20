/**
 * The Rust lane as the core builds it (`StudioCore` → `coreGameBuilds`): `RustBuilds`
 * (`rust-build.ts`) over the profile's toolchain store (M2.3's `locateRust`), the real staging and
 * host-written manifest (M2.2's `stageRustGame`) at the genex release the shipped lock line pins,
 * and the determinism gate's `clippy.toml` from the shipped payload (`scripts/rust-payload.ts`).
 *
 * The payload is read-only app resources: `<resources>/native/genex-rust/{Cargo.lock,clippy.toml}`,
 * each read as a regular file (never through a link). A payload without its lock line refuses the
 * stage and one without a non-empty `clippy.toml` locates no toolchain, so no game builds without the gate.
 * A web build serves the template's WebGPU-only shell from `<resources>/game-template-rust/web/shell.html`
 * (the app's copy, never the game's), read the same way, and packs with the store's wasm-bindgen and wasm-opt.
 * The prewarmed target folders are not cloned into a build yet (`cloneRustTarget`): a destination
 * builds from its base alone, cold, prewarmed or not.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { type BuildTarget, GameStack } from "../../shared/game-project.ts";
import { ToolchainId, type ToolchainLock, toolchainHostOf } from "../../shared/toolchain.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { renderTomlFragment, wgslTomlFragment } from "../../substrate/genex-toml.ts";
import { admitRustOutput } from "../../substrate/native-cross-admission.ts";
import {
  NoticeRefusal,
  parseLockClosure,
  readVendoredLicences,
  type RustNotices,
  rustNotices,
  rustRuntimeSources,
} from "../../substrate/rust-notices.ts";
import { crateOverlayLayout } from "../../substrate/toolchain-store/crate-overlay.ts";
import { readCurrentLock } from "../../substrate/toolchain-store/lock.ts";
import { locateRust } from "../../substrate/toolchain-store/rust-locate.ts";
import { FIXTURE_STORE_MARKER } from "../dev/fixture-toolchains.ts";
import {
  RustBuilds,
  type RustBuildsOptions,
  type RustLocateResult,
  type RustOutputAdmit,
  type RustStage,
} from "../rust-build.ts";
import { colyseusComponentFolder } from "../rust-colyseus.ts";
import { genexReleaseOf, RUST_GAME_PACKAGE, RustManifestCode } from "../rust-manifest.ts";
import { stageRustGame } from "../rust-stage.ts";

/** Where the shipped Rust payload's lane files sit under the app's resources. */
export const RUST_PAYLOAD_DIR = ["native", "genex-rust"] as const;
/** The lock line the genex release is read from (`scripts/rust-payload.ts` ships it byte for byte). */
export const RUST_LOCK_LINE_FILE = "Cargo.lock";
/** The determinism gate clippy reads (`CLIPPY_CONF_DIR`). */
export const RUST_CLIPPY_FILE = "clippy.toml";
/** The app's web shell under the resources: the template's page with the unsupported-GPU state. */
export const RUST_WEB_SHELL = ["game-template-rust", "web", "shell.html"] as const;
/** The facade every game depends on. */
const FACADE_CRATE = "genex";
/** The most of the web shell the host reads. */
const SHELL_MAX_BYTES = 256 * 1024;
/** The most of the lock line the host reads. */
const LOCK_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** The most of the clippy configuration the host reads. */
const CLIPPY_MAX_BYTES = 256 * 1024;

/** The folder a Rust export's notices are written into, at the export's root. */
export const RUST_EXPORT_NOTICES = "notices";
/** The most of an admitted build's `Cargo.lock` the notices read. */
const BUILD_LOCK_MAX_BYTES = 4 * 1024 * 1024;

const MESSAGE = {
  noRelease: (file: string) => `${file} is not a lock line pinning one genex release`,
  noClippy: (file: string) => `the lane's determinism gate (${file})`,
  noBuildLock: (file: string) => `the admitted build's lock (${file}) is not a file the export can read`,
  noToolchain: (target: string) => `the store has no Rust toolchain for ${target} to read the runtime's licences from`,
} as const;

/**
 * The lane's admission over `store` (M3.5's `admitRustOutput`: each destination's executable
 * policy and the transport scan), except over a development fixture's stand-in store (its
 * marker), whose stub tools write stand-in artifacts that no policy could admit. The store is
 * the host's: no agent process writes it, so none plants the marker.
 */
export function storeRustAdmit(store: string): RustOutputAdmit {
  return async (out, target, options) =>
    (await isFixtureStore(store)) ? { ok: true, files: [] } : admitRustOutput(out, target, options);
}

/** Whether `store` is a development fixture's stand-in (its marker file): stub tools, stand-in artifacts, no licence texts. */
export async function isFixtureStore(store: string): Promise<boolean> {
  return lstat(path.join(store, FIXTURE_STORE_MARKER)).then(
    (info) => info.isFile(),
    () => false,
  );
}

/**
 * The licence notices a Rust export carries (M3.5): every crate the admitted build's `Cargo.lock`
 * names, from the store's vendored set then the profile's approved overlay (M3.15), and the
 * runtime parts the destination's row names, from the store's sysroot. Refused typed
 * (`NoticeRefusal`) when the lock, a crate's licence or a part's text is missing.
 */
export async function rustExportNotices(input: {
  store: string;
  buildLock: string;
  target: BuildTarget;
  /** The toolchain lock the game was built on (its retained one); absent, the store's current Rust lock. */
  lock?: ToolchainLock;
}): Promise<RustNotices> {
  const bytes = await readRegularFile(input.buildLock, BUILD_LOCK_MAX_BYTES).catch(() => null);
  if (!bytes) return { ok: false, refusal: NoticeRefusal.LockInvalid, detail: MESSAGE.noBuildLock(input.buildLock) };
  const lock = bytes.toString("utf8");
  const closure = parseLockClosure(lock);
  if (!closure.ok) return closure;
  const built = input.lock ?? (await readCurrentLock(input.store, GameStack.RustWgpu));
  const found = built ? await locateRust(input.store, built, input.target, { prewarm: false }) : null;
  if (!found?.ok)
    return { ok: false, refusal: NoticeRefusal.RuntimeNoticeMissing, detail: MESSAGE.noToolchain(input.target) };
  const vendorDirs = [found.located.vendor, crateOverlayLayout(input.store).vendor];
  const licences = await readVendoredLicences(vendorDirs, closure.crates);
  const runtime = await rustRuntimeSources({ sysroot: found.located.sysroot, vendorDirs, crates: closure.crates });
  return rustNotices({ target: input.target, lock, roots: [RUST_GAME_PACKAGE], licences, runtime });
}

/** The shipped payload folder under `resources`. */
export function rustPayloadDir(resources: string): string {
  return path.join(resources, ...RUST_PAYLOAD_DIR);
}

/** The genex release the payload's lock line pins, or null (absent, a link, unreadable, or no one release). */
export async function shippedGenexRelease(payload: string): Promise<string | null> {
  const bytes = await readRegularFile(path.join(payload, RUST_LOCK_LINE_FILE), LOCK_LINE_MAX_BYTES).catch(() => null);
  return bytes ? genexReleaseOf(bytes.toString("utf8")) : null;
}

/** Whether the payload holds its `clippy.toml` as a regular file with something in it: an empty gate gates nothing. */
async function hasClippyConf(payload: string): Promise<boolean> {
  return readRegularFile(path.join(payload, RUST_CLIPPY_FILE), CLIPPY_MAX_BYTES).then(
    (bytes) => bytes.length > 0,
    () => false,
  );
}

/**
 * The lane's `locate` over the store at `store`: the lock's sysroot, vendored crates and CARGO_HOME
 * for a destination (its base; a prewarm is not required), clippy pointed at the payload's gate.
 * The build reads the store and the payload, nothing else of the host's.
 */
export function storeRustLocate(store: string, payload: string): RustBuildsOptions["locate"] {
  return async (lock, target): Promise<RustLocateResult> => {
    const found = await locateRust(store, lock, target, { prewarm: false });
    if (!found.ok) return { ok: false, missing: [...found.missing] };
    const clippy = path.join(payload, RUST_CLIPPY_FILE);
    if (!(await hasClippyConf(payload))) return { ok: false, missing: [MESSAGE.noClippy(clippy)] };
    const { sysroot, vendor, webTools } = found.located;
    const reads = [await realpath(store), await realpath(payload)];
    const colyseus = colyseusComponentFolder(store, toolchainHostOf(process.platform, process.arch));
    const toolchain = {
      bin: path.join(sysroot, "bin"),
      vendor,
      clippyConf: payload,
      reads,
      ...(colyseus && { colyseus }),
    };
    return { ok: true, toolchain: webTools ? { ...toolchain, web: webTools } : toolchain };
  };
}

/** The app's web shell text, or null when it is absent, a link, not a regular file or empty. */
export function shippedWebShell(resources: string): () => Promise<string | null> {
  return async () => {
    const bytes = await readRegularFile(path.join(resources, ...RUST_WEB_SHELL), SHELL_MAX_BYTES).catch(() => null);
    return bytes && bytes.length > 0 ? bytes.toString("utf8") : null;
  };
}

/** A published genex release's version: `x.y.z`, never a development vendored set's pre-release (`0.0.0-dev`). */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The genex release `lock`'s vendored crate set is, or null: a published release pins the vendored
 * set by the genex version it was cut for (`rust-release.ts pin`), so a game kept on an older lock
 * after an app update stages the release its own crates hold and builds offline. A development
 * set (a pre-release version) names none.
 */
export function genexReleaseOfLock(lock: ToolchainLock | undefined): string | null {
  const vendored = lock?.entries[ToolchainId.RustVendor]?.version;
  return vendored !== undefined && RELEASE_VERSION.test(vendored) ? vendored : null;
}

/**
 * The lane's `stage`: M2.2's link-free stage and host-written manifest at the release the build's
 * lock vendored ({@link genexReleaseOfLock}), else the one the payload's lock line pins; the lane
 * resolves and verifies the lock itself. Its dependencies are the facade and the crates
 * `genex.toml` asked for. An ejected game's forked crates take their manifests from the store's
 * vendored set the lane hands it (`vendor`), and only where the person's recorded eject
 * (`ejectedFrom`) names the release its `[engine]` row does.
 */
export function shippedRustStage(payload: string): RustStage {
  return async (game, into, target, flavour, lock, vendor, ejectedFrom) => {
    const genexVersion = genexReleaseOfLock(lock) ?? (await shippedGenexRelease(payload));
    if (!genexVersion) {
      const detail = MESSAGE.noRelease(path.join(...RUST_PAYLOAD_DIR, RUST_LOCK_LINE_FILE));
      return { ok: false, code: RustManifestCode.LockUnreadable, detail };
    }
    const pins = { genexVersion, baseLock: null };
    const engineVendor = vendor ?? null;
    const staged = await stageRustGame({
      source: game.dir,
      stage: into,
      target,
      pins,
      flavour,
      engineVendor,
      ejectedFrom: ejectedFrom ?? null,
    });
    if (!staged.ok) return { ok: false, code: staged.code, detail: staged.detail };
    const dependencies = [FACADE_CRATE, ...staged.manifest.crates.map((crate) => crate.name)];
    const { title, nativeFeatures, render, wgsl, wasmBudgetMb, assetGroups, assets } = staged.manifest;
    const renderToml = render ? renderTomlFragment(render) : null;
    const wgslToml = wgslTomlFragment(wgsl);
    const loading = render?.loading ?? null;
    return {
      ok: true,
      dependencies,
      title,
      nativeFeatures,
      renderToml,
      wgslToml,
      wasmBudgetMb: wasmBudgetMb ?? null,
      loading,
      assetGroups: assetGroups ?? [],
      assets: assets ?? null,
    };
  };
}

/** What the core hands its Rust lane besides the store and the payload. */
export type CoreRustLaneOptions = Omit<RustBuildsOptions, "locate" | "currentLock" | "stage" | "webShell"> & {
  /** The profile's toolchain store (`layout.toolchains`). */
  store: string;
  /** The app's read-only resources. */
  resources: string;
};

/** The core's Rust lane: the store's current Rust lock and toolchain, the shipped payload's release and gate. */
export function createCoreRustBuilds(options: CoreRustLaneOptions): RustBuilds {
  const { store, resources, ...lane } = options;
  const payload = rustPayloadDir(resources);
  return new RustBuilds({
    ...lane,
    locate: storeRustLocate(store, payload),
    currentLock: () => readCurrentLock(store, GameStack.RustWgpu),
    stage: shippedRustStage(payload),
    webShell: shippedWebShell(resources),
  });
}
