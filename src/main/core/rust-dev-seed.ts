/**
 * Where an owned developer profile's Rust · wgpu stack comes from before any genex release is
 * published: the developer's dev store (`scripts/toolchains/dev-store.ts --stack rust-wgpu`, whose
 * vendored set holds this checkout's genex crates or a locally cut release's) and this worktree's
 * Rust lock file. `main/index.ts` names it only for an owned live `studio:dev` launch; a fixture
 * profile keeps its stub store, and a release build refuses the seed (`ToolchainService.seedRust`).
 * Also the project a profile's Rust prewarm warms, which the dev store warms too.
 */
import path from "node:path";
import type { GenexToml } from "../../substrate/genex-toml.ts";
import type { RustWarmProject } from "../../substrate/toolchain-store/rust-prewarm.ts";
import { rustTrustPolicy } from "../rust-build.ts";
import { cargoManifest } from "../rust-manifest.ts";
import { LEGACY_APP_NAME } from "../user-data-migration.ts";
import { rustPayloadDir, shippedGenexRelease } from "./rust-lane.ts";

/** The environment a developer launch reads its Rust seed from. Wire names: never rename one. */
export const RustDevSeedEnv = {
  /** The developer's toolchains folder, holding `dev-store/` (default `<checkout>/.studio-dev/toolchains`). */
  Toolchains: "GENEX_DEV_TOOLCHAINS",
  /** The Rust lock file to seed (default this worktree's `.studio-dev/dev-store-rust-lock.json`). */
  Lock: "GENEX_DEV_STORE_RUST_LOCK",
  /** `0` turns the seed off for this launch. */
  Seed: "GENEX_DEV_RUST_SEED",
} as const;
export type RustDevSeedEnv = (typeof RustDevSeedEnv)[keyof typeof RustDevSeedEnv];

/** The dev store's folder inside the developer's toolchains folder (`dev-store.ts`'s `DEV_STORE`). */
const DEV_STORE_FOLDER = "dev-store";
/** This worktree's Rust lock file, under the checkout (`dev-store.ts`'s `WORKTREE_RUST_LOCK`). */
const WORKTREE_RUST_LOCK = [".studio-dev", "dev-store-rust-lock.json"] as const;
const DEV_TOOLCHAINS = [".studio-dev", "toolchains"] as const;
/** The value of {@link RustDevSeedEnv.Seed} that turns the seed off. */
const SEED_OFF = "0";
/** The normal profile's folders under the OS's app-data folder: the product's (package.json `productName`) and its old name. */
const NORMAL_APP_FOLDERS = ["Genex", LEGACY_APP_NAME] as const;
/** A profile's toolchain store inside its data folder (`core/layout.ts`). */
const STORE_FOLDER = "toolchains";

/** What a developer profile's Rust stack is seeded from, and the stores it must never write. */
export interface RustSeedFrom {
  from: string;
  lockFile: string;
  forbidden: readonly string[];
}

/** What {@link devRustSeedFrom} reads. */
export interface DevRustSeedInput {
  env: NodeJS.ProcessEnv;
  /** The developer build's checkout (the launch's). */
  checkout: string;
  /** The OS's app-data folder (`app.getPath("appData")`), under which the normal profile lives. */
  appData: string;
}

/**
 * Where an owned developer launch seeds its Rust stack from: the dev store under the developer's
 * toolchains folder and the worktree's Rust lock file (each overridable through
 * {@link RustDevSeedEnv}), never writing the normal profile's store; null when the launch turned
 * it off. Nothing is read here: the seed refuses an absent store or lock (`no-source`).
 */
export function devRustSeedFrom(input: DevRustSeedInput): RustSeedFrom | null {
  const { env, checkout, appData } = input;
  if (env[RustDevSeedEnv.Seed] === SEED_OFF) return null;
  const named = (value: string | undefined) => (value ? path.resolve(value) : null);
  const toolchains = named(env[RustDevSeedEnv.Toolchains]) ?? path.join(checkout, ...DEV_TOOLCHAINS);
  const lockFile = named(env[RustDevSeedEnv.Lock]) ?? path.join(checkout, ...WORKTREE_RUST_LOCK);
  const forbidden = NORMAL_APP_FOLDERS.map((folder) => path.join(appData, folder, STORE_FOLDER));
  return { from: path.join(toolchains, DEV_STORE_FOLDER), lockFile, forbidden };
}

/** The compiler flags every untrusted game build carries, one per argument: what a profile's prewarm is built with. */
export const GAME_PREWARM_RUSTFLAGS: readonly string[] = rustTrustPolicy(false).rustflags.flatMap((flag) =>
  flag.split(" "),
);

/** The project a Rust prewarm warms: an empty game's host-written manifest on the facade at `genexVersion`. */
export function rustWarmProject(genexVersion: string): RustWarmProject {
  const manifest: GenexToml = {
    title: "warm",
    worldSize: [1, 1],
    saveName: null,
    crates: [],
    wgsl: [],
    nativeFeatures: [],
  };
  return { manifest: cargoManifest(manifest, genexVersion), lock: null, sources: { "src/main.rs": "fn main() {}\n" } };
}

/** The warm project at the genex release the shipped payload pins (the one a development lock's games stage); null when it pins none. */
export async function shippedWarmProject(resources: string): Promise<RustWarmProject | null> {
  const release = await shippedGenexRelease(rustPayloadDir(resources));
  return release ? rustWarmProject(release) : null;
}
