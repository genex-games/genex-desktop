/**
 * A Rust · wgpu game's Android export (`ExportRun.AndroidPackage`, M5.2): a development APK signed
 * with Studio's per-profile debug key (the harness may ask), or an AAB signed with the person's own
 * release keystore (the person only). The order is the desktop exports': the artifact, signing and
 * caller checks first (nothing is built for a refused export), then the lane's Android build
 * (purpose `export`), the toolchain's packaging tools, the notices through the M3.5 generator, and
 * `substrate/android-package.ts` over the lane's admitted `out/`. The export folder is resolved as
 * every export's is (`resolveExportTarget`: by its real path inside the exports folder, never a
 * link, and only an empty folder or one this app exported); the package is made in the host's own
 * staging as `<name>-debug.apk` or `<name>.aab` beside the export marker and swapped into place.
 * A dev APK is admitted from staging for the person's device launch before the swap. Its
 * `versionCode` comes from the clock, minutes since 2024, so each export's is newer than the last.
 *
 * The core binds its packaging services ({@link AndroidExportDeps}, `mobile-export-deps.ts`): the
 * person's Build-Tools and platform from `probeAndroidSdk`, the store's JDK and bundletool from
 * `locateMobileStoreTools`. Without them it refuses `lane-missing` before anything is built or
 * written. Nothing here installs or launches the package (containment stage 1).
 */
import { realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { ExportError, ExportRefusal, ExportSigning, MobileArtifact } from "../../shared/game-export-contract.ts";
import {
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  destinationsOf,
} from "../../shared/game-project.ts";
import {
  type AndroidPackageContext,
  AndroidPackageError,
  AndroidPackageProblem,
  type AndroidPackageTools,
  AndroidOrientation,
  androidApplicationId,
  packageAndroidAab,
  packageAndroidApk,
  readAndroidPayload,
} from "../../substrate/android-package.ts";
import { linuxExportName } from "../../substrate/native-export-archive.ts";
import { type MacNotice, readNotices } from "../../substrate/native-export.ts";
import {
  EXPORT_MANIFEST,
  type ExportTarget,
  makeStaging,
  resolveExportTarget,
  swapIntoPlace,
} from "../../substrate/game-export.ts";
import { realpathNearest } from "../../substrate/fsx.ts";
import { isBelow } from "../../substrate/paths.ts";
import { SigningRequester } from "../../substrate/windows-sign.ts";
import { CppBuildPurpose } from "../cpp-build.ts";
import type { GameBuildLanes } from "../game-build.ts";
import type { MobileExportGameRequest } from "./native-export-run.ts";
import type { ToolchainService } from "./toolchains.ts";

const MESSAGE = {
  notYet: "This build of Genex cannot export an Android game yet.",
  notAndroid: "This is not an Android export.",
  wrongArtifact: "That signing does not make this Android artifact.",
  harness: "Only you can make an Android App Bundle or sign with your own keystore.",
  notADestination: (project: string) => `"${project}" is not made for Android`,
  buildFailed: "The game's Android build failed, so no package was made.",
  noTools:
    "The Android packaging tools (the SDK's Build-Tools and platform, the store's JDK and bundletool) are not installed.",
  targetDir: "The export folder is not inside Genex's exports folder.",
  refused: (detail: string) => `The Android package was not made: ${detail}`,
} as const;

/** The version name every export carries (the person names none yet); the code comes from the clock. */
const VERSION_NAME = "1.0";
/** Where `versionCode` counts minutes from: 2024-01-01T00:00:00Z. */
const VERSION_EPOCH_MS = Date.UTC(2024, 0, 1);
/** Play's largest `versionCode`. */
const VERSION_CODE_MAX = 2_100_000_000;

/**
 * The `versionCode` an export made at `now` carries: whole minutes since 2024, so a later export's
 * is larger (Play refuses a bundle whose code it has seen) — the clock-derived build number the
 * iPhone export's `CFBundleVersion` is, at the same minute resolution.
 */
export function androidVersionCode(now: number): number {
  const minutes = Math.floor((now - VERSION_EPOCH_MS) / MINUTE_MS);
  return Math.min(Math.max(minutes, 1), VERSION_CODE_MAX);
}

/** Each packaging refusal as the export's refusal. */
const EXPORT_REFUSAL_OF = {
  [AndroidPackageProblem.ManifestField]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.ActivityUnavailable]: ExportRefusal.LaneMissing,
  [AndroidPackageProblem.NotAdmitted]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.DigestMismatch]: ExportRefusal.BuildChanged,
  [AndroidPackageProblem.ExtraLibrary]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.ReservedAsset]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.SecretFound]: ExportRefusal.SecretFound,
  [AndroidPackageProblem.Target]: ExportRefusal.TargetRefused,
  [AndroidPackageProblem.ToolFailed]: ExportRefusal.BuildFailed,
  [AndroidPackageProblem.NotAligned]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.BundleInvalid]: ExportRefusal.AdmissionRefused,
  [AndroidPackageProblem.PackagedEntryChanged]: ExportRefusal.BuildChanged,
  [AndroidPackageProblem.ZipInvalid]: ExportRefusal.ArchiveRefused,
  [AndroidPackageProblem.HarnessMayNotSign]: ExportRefusal.HarnessMayNotSign,
  [AndroidPackageProblem.SigningKind]: ExportRefusal.SigningInvalid,
  [AndroidPackageProblem.SigningFailed]: ExportRefusal.SigningFailed,
} as const satisfies Record<AndroidPackageProblem, ExportRefusal>;

/** What an Android export reaches: the core's own services. */
export interface AndroidExportDeps {
  /** The build-lane seam (`x.gameBuilds`): the Rust lane builds the game for Android. */
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock">;
  /** The game's once-chosen bundle id, the application id's source. */
  games: { bundleIdFor(name: string): Promise<string> };
  /** The packaging tools on this host at the game's Rust lock, or null when any is missing. */
  tools(game: GameProject): Promise<AndroidPackageTools | null>;
  /** The Android export's notices for the admitted build (`rustNotices` with `androidRuntimeSources`). */
  notices(game: GameProject, output: string): Promise<MacNotice[]>;
  /** The packaging context without the tools: sandboxes, staging, secrets and the signer. */
  packaging: Omit<AndroidPackageContext, "tools" | "secretValues">;
  /** Values no packaged file may hold (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /** `layout.exports`: the export folder must be inside it. */
  exportsRoot: string;
  /**
   * Admits a dev APK, still in staging, for the person's device launch (`phonePackageStore`);
   * absent, nothing is admitted.
   */
  admitDevApk?(project: string, apk: string): Promise<void>;
  /** The clock `versionCode` and the swap read. */
  now?(): number;
}

/** The checks made before anything is built: the destination, the artifact's signing and who asked. */
function checkRequest(request: MobileExportGameRequest): void {
  if (request.destination !== BuildTarget.Android)
    throw new ExportError(ExportRefusal.NotADestination, MESSAGE.notAndroid);
  const bundle = request.artifact === MobileArtifact.Aab;
  const release = request.signing.kind === ExportSigning.AndroidRelease;
  if ((bundle || release) && !request.person) throw new ExportError(ExportRefusal.HarnessMayNotSign, MESSAGE.harness);
  const expected = bundle ? ExportSigning.AndroidRelease : ExportSigning.AndroidDebug;
  const fits = request.signing.kind === expected || (!bundle && release);
  if (!fits) throw new ExportError(ExportRefusal.SigningInvalid, MESSAGE.wrongArtifact);
  if (!destinationsOf(request.game).targets.includes(BuildTarget.Android))
    throw new ExportError(ExportRefusal.NotADestination, MESSAGE.notADestination(request.game.name));
}

/** The lane's export build for Android at the game's Rust lock and its admitted outputs; else `build-failed`. */
async function buildForExport(deps: AndroidExportDeps, game: GameProject) {
  const lock = await deps.toolchains.currentLock(GameStack.RustWgpu, game.name);
  const { name: project, dir, shape } = game;
  const asked = { project, dir, shape, destinations: destinationsOf(game), lock };
  const { outcome } = await deps.gameBuilds.ensure(asked, BuildTarget.Android, CppBuildPurpose.Export);
  const outputs = outcome?.rust?.receipt?.outputs;
  if (!outcome?.ok || !outcome.output || !outputs)
    throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.buildFailed);
  return { output: outcome.output, outputs };
}

/**
 * The export folder, resolved as every export's is: below the exports root by its lexical and real
 * path, then `resolveExportTarget` (never holding the game, no link, only an empty folder or one
 * this app exported: `not-an-export-folder` otherwise). Nothing is made or removed for a refused one.
 */
async function exportFolder(deps: AndroidExportDeps, request: MobileExportGameRequest): Promise<ExportTarget> {
  const lexical = isBelow(path.resolve(deps.exportsRoot), path.resolve(request.targetDir));
  const real = await realpathNearest(request.targetDir).catch(() => null);
  const root = await realpathNearest(deps.exportsRoot);
  if (!lexical || real === null || !isBelow(root, real))
    throw new ExportError(ExportRefusal.TargetRefused, MESSAGE.targetDir);
  try {
    return await resolveExportTarget(await realpath(request.game.dir), request.targetDir);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError(ExportRefusal.TargetRefused, MESSAGE.targetDir);
  }
}

/** Runs a packaging step; a packaging refusal becomes the export's typed refusal. */
async function packaged<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof AndroidPackageError)) throw error;
    throw new ExportError(EXPORT_REFUSAL_OF[error.code], MESSAGE.refused(error.message));
  }
}

/**
 * Exports `request.game` for Android as `request.artifact`; refused `lane-missing` when the core
 * has not handed it its packaging services (`deps`).
 */
export async function exportAndroidGame(
  request: MobileExportGameRequest,
  deps?: AndroidExportDeps,
): Promise<ExportResult> {
  if (deps === undefined) throw new ExportError(ExportRefusal.LaneMissing, MESSAGE.notYet);
  checkRequest(request);
  const tools = await deps.tools(request.game);
  if (tools === null) throw new ExportError(ExportRefusal.ToolchainUnusable, MESSAGE.noTools);
  const built = await buildForExport(deps, request.game);
  return exportBuilt(deps, request, tools, built);
}

/** The packaging of a built game: payload, notices, manifest and the artifact's package. */
async function exportBuilt(
  deps: AndroidExportDeps,
  request: MobileExportGameRequest,
  tools: AndroidPackageTools,
  built: { output: string; outputs: ReadonlyArray<{ path: string; sha256: string }> },
): Promise<ExportResult> {
  const { game } = request;
  const name = linuxExportName(game.title ?? game.name);
  const payload = await packaged(readAndroidPayload(built.output, built.outputs));
  const notices = await readNotices(await deps.notices(game, built.output));
  const now = deps.now ?? Date.now;
  const manifest = {
    applicationId: await packaged(deps.games.bundleIdFor(game.name).then(androidApplicationId)),
    label: game.title ?? game.name,
    versionCode: androidVersionCode(now()),
    versionName: VERSION_NAME,
    orientation: AndroidOrientation.Landscape,
  };
  const context = { ...deps.packaging, tools, secretValues: deps.secretValues() };
  const folder = await exportFolder(deps, request);
  const bundle = request.artifact === MobileArtifact.Aab;
  const file = bundle ? `${name}.aab` : `${name}-debug.apk`;
  const staging = await makeStaging(folder.parent, deps.packaging.stagingRoot);
  try {
    const requestedBy = request.person ? SigningRequester.Person : SigningRequester.Harness;
    const target = path.join(staging, file);
    const packageRequest = { manifest, payload, notices, signing: request.signing, requestedBy, target };
    const made = await packaged(
      bundle ? packageAndroidAab(context, packageRequest) : packageAndroidApk(context, packageRequest),
    );
    const marker = {
      studioExport: 1,
      destination: BuildTarget.Android,
      artifact: request.artifact,
      file,
      sha256: made.sha256,
    };
    await writeFile(path.join(staging, EXPORT_MANIFEST), JSON.stringify(marker), { flag: "wx" });
    if (!bundle) await deps.admitDevApk?.(game.name, made.file);
    await swapIntoPlace(staging, folder.target, folder.existing, now);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    dir: folder.target,
    files: 1,
    included: [file],
    excluded: [],
    destination: BuildTarget.Android,
    artifact: path.join(folder.target, file),
  };
}
