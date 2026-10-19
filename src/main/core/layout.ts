/** Where the studio keeps its own state under userData: the event store, workspaces, runs and homes. */
import { existsSync } from "node:fs";
import path from "node:path";
import { EXPORT_STAGING_DIR } from "../../substrate/game-export.ts";
import { claudeFolderDenyWrites } from "../../substrate/spawn.ts";
import { hostDownloadCache } from "../../substrate/toolchain-store/download-cache.ts";

// A type alias, not an interface: the bootstrap hands it to the renderer as `Record<string, string>`.
export type StudioLayout = {
  exoharness: string;
  workspaces: string;
  harnessWs: string;
  gamesRoot: string;
  secrets: string;
  scratch: string;
  runs: string;
  updates: string;
  engineHomes: string;
  exports: string;
  /** The managed C++ toolchain store (`substrate/toolchain-store/`): installed by the host, written by no agent. */
  toolchains: string;
  /**
   * The host-level download cache every profile's store installs through (`download-cache.ts`):
   * outside every profile's data, written by the host only, denied to every sandboxed process.
   */
  downloadCache: string;
  /** One folder per native game run (bundle, `state/`): the host's, never under a writable root. */
  nativeRuns: string;
  /**
   * The C++ build lane's folders (`cpp-build.ts`): the host's, never under a writable root, so no
   * agent process plants a link where the host reads, writes or serves; each build run writes only its own.
   */
  cppBuilds: string;
  /**
   * The Rust build lane's folders (`rust-build.ts`), beside the C++ lane's and held to the same
   * rule: the host's, never under a writable root, each build run writing only its own folder.
   */
  rustBuilds: string;
  /**
   * A Rust game's shell sessions' folders (`delegation.ts` `rustSessionFor`): the host-written
   * `Cargo.toml` and `Cargo.lock` each checks with, and its `target/`. The host's, never under a
   * writable root: a session is granted its own `target/` alone, so no other agent process plants
   * a manifest, a build script or a proc macro that a later session would run.
   */
  rustSessions: string;
  /**
   * The Rust build lane's import jobs (`rust-assets.ts` `importStagedAssets`, C-2): one folder per
   * job, host-written and removed once its outputs are placed in the build's stage. The host's,
   * never under a writable root; each job's sandbox writes only its own `out/` and `tmp/`.
   */
  assetJobs: string;
  /**
   * Where every export is staged and signed before it is renamed into place (`game-export.ts`):
   * the host's, never under a writable root, unlike the exports folder an agent may write.
   */
  exportStaging: string;
  /**
   * The host-private folder a signed Windows export stages the files jsign signs in: never under a
   * writable root and denied to every agent process, so none swaps a file between staging and signing.
   */
  signing: string;
  /**
   * The phone packages the exports admitted for the person's device launch (`device-launch.ts`
   * `phonePackageStore`): copied from the export's host-only staging, never under a writable root,
   * so what a launch installs is what the export made.
   */
  phonePackages: string;
  /**
   * Agent jobs' records and logs, one folder per game. Never writable by an agent process: it sits
   * outside every writable root and inside the never-touch list's Genex data.
   */
  jobs: string;
  /**
   * The content-addressed import cache (`asset-cache.ts`, C-3): importer outputs by key. Host-owned;
   * never writable by an agent process (outside every writable root).
   */
  assetCache: string;
  /**
   * The homes of Loops' reviewers, one fresh folder per call. Never writable by an agent process
   * (unlike scratch), so no box can swap a folder on the way for a link while the host makes one.
   */
  reviewers: string;
};

export function layoutFor(userData: string, downloadCache: string = hostDownloadCache()): StudioLayout {
  return {
    exoharness: path.join(userData, "exoharness"),
    workspaces: path.join(userData, "workspaces"),
    harnessWs: path.join(userData, "workspaces", "harness"),
    gamesRoot: path.join(userData, "workspaces", "games"),
    secrets: path.join(userData, "secrets"),
    scratch: path.join(userData, "scratch"),
    runs: path.join(userData, "runs"),
    updates: path.join(userData, "updates"),
    engineHomes: path.join(userData, "engine-homes"),
    exports: path.join(userData, "exports"),
    toolchains: path.join(userData, "toolchains"),
    downloadCache,
    nativeRuns: path.join(userData, "native-runs"),
    cppBuilds: path.join(userData, "cpp-builds"),
    rustBuilds: path.join(userData, "rust-builds"),
    rustSessions: path.join(userData, "rust-sessions"),
    assetJobs: path.join(userData, "asset-jobs"),
    exportStaging: path.join(userData, EXPORT_STAGING_DIR),
    signing: path.join(userData, "signing"),
    phonePackages: path.join(userData, "phone-packages"),
    jobs: path.join(userData, "jobs"),
    assetCache: path.join(userData, "asset-cache"),
    reviewers: path.join(userData, "reviewers"),
  };
}

/**
 * What no toolchain prewarm command may write besides the store's own folders: every folder an
 * agent, a run or a build writes. Prewarm's sandbox has no writable root of its own
 * (`createPrewarmSandbox`), so these denies are defence in depth beneath its one staging allow.
 */
export function prewarmDenyWrites(layout: StudioLayout): string[] {
  return [
    layout.workspaces,
    layout.gamesRoot,
    layout.scratch,
    layout.runs,
    layout.exports,
    layout.cppBuilds,
    layout.rustBuilds,
    layout.rustSessions,
    layout.assetJobs,
    layout.nativeRuns,
    layout.signing,
    layout.phonePackages,
    layout.downloadCache,
    layout.assetCache,
  ];
}

/**
 * The write denies every sandboxed process starts with: the judge's rubrics (readable, frozen: no
 * agent rewrites the yardstick it is measured by), every game's `.claude` folder (a person's own
 * session there would load planted settings or hooks), the toolchain store (its ANGLE is copied
 * into every native bundle and backs the Metal gate), the native run folders and the signing folder
 * (a staged file swapped before jsign signs it would be signed with the person's certificate), the
 * admitted phone packages a device launch installs, the host-level download cache every profile
 * installs through, and the import cache whose outputs every build packages by key. The last six
 * sit outside every writable root already; denying them is defence in depth.
 */
export function studioBaseDenyWrites(
  layout: StudioLayout,
  gameDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string[] {
  return [
    path.join(layout.harnessWs, "judge"),
    ...claudeFolderDenyWrites(layout.gamesRoot, gameDirs, platform, exists),
    layout.toolchains,
    layout.nativeRuns,
    layout.signing,
    layout.phonePackages,
    layout.downloadCache,
    layout.assetCache,
  ];
}
