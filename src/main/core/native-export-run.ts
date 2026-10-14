/**
 * A C++ game's Mac app export, as `StudioCore.exportPublicCopy` runs it for `destination: macos`:
 * the destination, host and signing checks first (nothing is built for a refused export), then the
 * window target through the lane (purpose `export`), its admission, the store's ANGLE and raylib
 * licences for the lock it was built with, the game's once-chosen bundle id, and
 * `substrate/native-export.ts`. Only on a Mac. Windows and Linux archives go through
 * {@link exportDesktopGame} (`destination: windows | linux`).
 *
 * Also the checks every export request passes before the core sees it, from the studio window
 * (`studio:export`) and the harness (`game.export`) alike: the destination is a build target, the
 * signing is checked by `parseExportSigning` and must be one the destination takes
 * ({@link exportSigningFor}), and only a person signs with an identity or certificate.
 */
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import {
  EXPORT_RUNS,
  ExportError,
  ExportRefusal,
  ExportRun,
  ExportSigning,
  type ExportSigningChoice,
  gpuQualificationOf,
  type MobileArtifact,
  mobileArtifactOf,
} from "../../shared/game-export-contract.ts";
import {
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  destinationsOf,
  isBuildTarget,
  isCompiledStack,
  stackOf,
} from "../../shared/game-project.ts";
import { isMobileBuildTarget, type MobileBuildTarget, type ToolchainLock } from "../../shared/toolchain.ts";
import { NativeRunMode } from "../../shared/native-contract.ts";
import type { GameWorkspaces } from "../../substrate/game-workspace.ts";
import { admitMacBundle, type BundleExec, type MacAngle } from "../../substrate/native-bundle.ts";
import { assertMacSigning, exportMacApp, gameNotices, storeNotices } from "../../substrate/native-export.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../../substrate/spawn.ts";
import type { JavaProxy } from "../../substrate/windows-sign.ts";
import { CppBuildPurpose } from "../cpp-build.ts";
import type { GameBuildLanes } from "../game-build.ts";
import type { ConformanceGateResult } from "./game-conformance-gate.ts";
import type { NativeBundleSteps } from "./native-prepare.ts";
import type { ToolchainService } from "./toolchains.ts";
import { ExportCaller, exportSigningFor } from "./native-export-signing.ts";
export { ExportCaller, exportSigningFor } from "./native-export-signing.ts";

const MESSAGE = {
  needsAMac: "Mac apps are exported on a Mac.",
  notNative: (project: string) => `"${project}" is not a C++ · raylib game, so it has no Mac app`,
  notADestination: (project: string) => `"${project}" is not made for the Mac`,
  buildFailed: "The game's Mac build failed, so no app was made.",
  admission: (refusal: string, detail: string) =>
    `The Mac build did not pass Genex's checks, so no app was made (${refusal}): ${detail}`,
  noStore: "The toolchain store holds no Mac ANGLE or raylib source for this build, so no app was made.",
  notADestinationName: (value: string) => `${value} is not a destination Genex exports to`,
  unknownProject: (name: string) => `unknown project ${name}`,
  noExportHere: (stack: string, destination: string) => `A ${stack} game has no ${destination} export`,
  noExportYet: (destination: string) => `This build of Genex cannot export this game to ${destination} yet`,
} as const;

/**
 * The folder each destination's export goes to, as a suffix on the game's name under the exports
 * root: the browser folder is `<exports>/<project>`, the Mac app `<project>.mac`, the Windows zip
 * `<project>.windows`, the Linux tarball `<project>.linux` and the phone packages `<project>.ios`
 * and `<project>.android`. A game's name never holds a dot, so no game's browser folder is another
 * destination's folder.
 */
const EXPORT_SUFFIX = {
  [BuildTarget.Web]: "",
  [BuildTarget.Mac]: ".mac",
  [BuildTarget.Windows]: ".windows",
  [BuildTarget.Linux]: ".linux",
  [BuildTarget.Ios]: ".ios",
  [BuildTarget.Android]: ".android",
} as const satisfies Record<BuildTarget, string>;

/** A project name an export request may name: a plain folder name (the library is asked next). */
const PLAIN_PROJECT = /^[^/\\\0]+$/;

/** What a Mac app export reaches: the core's own services. */
export interface NativeExportDeps {
  /** This host, or null on a platform the studio does not build for. */
  host: StudioPlatform | null;
  /** The library, its exporter and the game's once-chosen bundle id. */
  games: Pick<GameWorkspaces, "list" | "export"> & { bundleIdFor(name: string): Promise<string> };
  /** The build-lane seam (`x.gameBuilds`): the game's stack's lane builds it. */
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock" | "locate">;
  /** Host programs without a shell (`codesign`, `ditto`, `xcrun`, `spctl`). */
  exec: BundleExec;
  /** The app's resources. Unread: an app's notices come from the toolchain store the game was built with. */
  resources: string;
  /** The host-only folder an app is staged and signed in (`layout.exportStaging`), on the exports' volume: the swap is a rename. */
  stagingRoot: string;
  /** `layout.exports`: when given, the app's folder must resolve below it. */
  exportsRoot?: string;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /** Admission and assembly (default: `native-bundle.ts`). */
  bundle?: NativeBundleSteps;
  /** The clock (default: `Date.now`). */
  now?(): number;
  /** Where the Developer ID gate is read (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** One Mac app export: the game, the folder its `.app` goes into, and the checked signing. */
export interface MacExportGameRequest {
  game: GameProject;
  targetDir: string;
  signing: ExportSigningChoice;
  /** The person asked in the studio's window (IPC): the only caller Developer ID may run for. */
  person?: boolean;
}

/**
 * The destination an export request names: absent is the browser; a phone is a destination too
 * (the export-run table refuses it for a stack that never makes one); anything else is refused.
 */
export function exportDestinationOf(value: unknown): BuildTarget {
  if (value === undefined) return BuildTarget.Web;
  if (isBuildTarget(value) || isMobileBuildTarget(value)) return value;
  throw new ExportError(ExportRefusal.NotADestination, MESSAGE.notADestinationName(JSON.stringify(value) ?? "?"));
}

/** Where an export of `destination` goes: `<exports>/<project>` for the browser, `<project>.mac`, `.windows` or `.linux` beside it. */
export function exportDirFor(exportsRoot: string, project: string, destination: BuildTarget): string {
  return path.join(exportsRoot, `${project}${EXPORT_SUFFIX[destination]}`);
}

/** How an export is shown: Electron's `shell` in the app, a recorder in a test. */
export interface ExportReveal {
  showItemInFolder(target: string): void;
  openPath(target: string): Promise<string>;
}

/** Shows what an export made: a Mac app selected in the file manager (opening an `.app` launches it), a folder opened. */
export async function revealExport(result: ExportResult, reveal: ExportReveal): Promise<void> {
  if (result.destination === BuildTarget.Mac && result.artifact) {
    reveal.showItemInFolder(result.artifact);
    return;
  }
  await reveal.openPath(result.dir);
}

/** What `studio:export` reaches of the core. */
export interface ExportingCore {
  layout: { exports: string };
  exportPublicCopy(
    project: string,
    targetDir: string,
    options: { destination?: BuildTarget; signing?: ExportSigningChoice },
  ): Promise<ExportResult>;
}

/**
 * `studio:export {project, destination?, signing?}` from the studio window: every field checked
 * before the core is asked (a refused request builds, spawns and writes nothing), the export made
 * into its folder under the exports root, then revealed ({@link revealExport}).
 */
export async function exportForPerson(
  core: ExportingCore,
  payload: unknown,
  reveal: ExportReveal,
): Promise<ExportResult> {
  const { project, destination: rawDestination, signing: rawSigning } = (payload ?? {}) as Record<string, unknown>;
  if (typeof project !== "string" || !PLAIN_PROJECT.test(project) || project === "." || project === "..") {
    throw new Error(MESSAGE.unknownProject(String(project)));
  }
  const destination = exportDestinationOf(rawDestination);
  const signing = exportSigningFor(destination, rawSigning, ExportCaller.Person);
  if (destination === BuildTarget.Mac) assertMacSigning(signing, { person: true, env: process.env });
  // A Windows game signed with the person's own certificate is checked before anything runs by
  // the desktop export itself (`exportDesktopGame`): jsign's launcher and the keystore's real path.
  const options = { destination, signing, person: true };
  const result = await core.exportPublicCopy(project, exportDirFor(core.layout.exports, project, destination), options);
  await revealExport(result, reveal);
  return result;
}

/** Refuses a game that is not a C++ game naming the Mac among its destinations. */
function assertMacDestination(game: GameProject): void {
  // raylib's own: the app is assembled from a raylib bundle, the store's ANGLE and raylib's licences.
  // Another compiled game that names the Mac has no export lane in this build yet (`lane-missing`).
  const stack = stackOf(game.shape);
  if (stack !== GameStack.RaylibCpp) {
    const lane = isCompiledStack(stack) && destinationsOf(game).targets.includes(BuildTarget.Mac);
    throw new ExportError(
      lane ? ExportRefusal.LaneMissing : ExportRefusal.NotADestination,
      MESSAGE.notNative(game.name),
    );
  }
  if (!destinationsOf(game).targets.includes(BuildTarget.Mac)) {
    throw new ExportError(ExportRefusal.NotADestination, MESSAGE.notADestination(game.name));
  }
}

/** The lane's window build of the game for export, and the lock it was built with; else `build-failed`. */
async function buildForExport(deps: NativeExportDeps, game: GameProject) {
  const lock = await deps.toolchains.currentLock();
  const { name: project, dir, shape } = game;
  const asked = { project, dir, shape, destinations: destinationsOf(game), lock };
  const { outcome: built } = await deps.gameBuilds.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Export);
  if (!built?.ok || !built.output || !lock) throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.buildFailed);
  return { output: built.output, lock };
}

/** The store's Mac ANGLE and raylib source for `lock`; a store without either is `build-failed`. */
async function storeFor(
  deps: NativeExportDeps,
  lock: ToolchainLock,
): Promise<{ angle: MacAngle; raylibSource: string }> {
  const located = await deps.toolchains.locate(lock, [BuildTarget.Mac]);
  const angle = located.ok ? located.toolchain.angle : null;
  const raylibSource = located.ok ? located.toolchain.raylibSource : undefined;
  if (!angle || !raylibSource) throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.noStore);
  return { angle, raylibSource };
}

/** Exports `game` as a Mac app into `targetDir`; refused `mac-builds-need-a-mac` anywhere but a Mac. */
export async function exportMacGame(deps: NativeExportDeps, request: MacExportGameRequest): Promise<ExportResult> {
  if (deps.host !== StudioPlatform.Mac) throw new ExportError(ExportRefusal.MacBuildsNeedAMac, MESSAGE.needsAMac);
  const { game, signing } = request;
  assertMacDestination(game);
  assertMacSigning(signing, { person: request.person === true, env: deps.env ?? process.env });
  const { output, lock } = await buildForExport(deps, game);
  const admission = await (deps.bundle?.admit ?? admitMacBundle)(output, { mode: NativeRunMode.Window });
  if (!admission.ok) {
    throw new ExportError(ExportRefusal.AdmissionRefused, MESSAGE.admission(admission.refusal, admission.detail));
  }
  const { angle, raylibSource } = await storeFor(deps, lock);
  const bundleId = await deps.games.bundleIdFor(game.name);
  const exported = await exportMacApp({
    admitted: admission.bundle,
    angle,
    notices: [...storeNotices({ raylibSource, angleDir: angle.dir }), ...(await gameNotices(game.dir))],
    bundleId,
    title: game.title ?? game.name,
    fallbackName: game.name,
    signing,
    source: game.dir,
    target: request.targetDir,
    ...(deps.exportsRoot === undefined ? {} : { exportsRoot: deps.exportsRoot }),
    stagingRoot: deps.stagingRoot,
    exec: deps.exec,
    ...(deps.now ? { now: deps.now } : {}),
    secretValues: deps.secretValues(),
    person: request.person === true,
    env: deps.env ?? process.env,
  });
  return {
    dir: exported.dir,
    files: exported.files,
    included: exported.included,
    excluded: [],
    destination: BuildTarget.Mac,
    artifact: exported.app,
  };
}

// ---------- Windows and Linux archives ----------

/**
 * The sandbox one jsign run gets (`ProcessSandbox.create(jsignSandboxOptions(…))`): it runs one
 * request, is disposed after it, and names the filtering HTTP proxy Java is handed as
 * `-Dhttp.proxyHost`/`-Dhttp.proxyPort` (`ProcessSandbox.networkProxy`; null or absent when it has none).
 */
export interface ExportSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
  networkProxy?(): JavaProxy | null;
}

/** What a Windows or Linux archive export reaches: the core's own services. */
export interface DesktopExportGameDeps {
  /** This host, or null on a platform the studio does not build for. */
  host: StudioPlatform | null;
  /** The library: the game is looked up, never trusted from the request. */
  games: Pick<GameWorkspaces, "list">;
  /** The build-lane seam (`x.gameBuilds`): the game's stack's lane builds it. */
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock" | "locate">;
  /** `layout.exportStaging`: the host-only folder an archive is written in before it is renamed into place. */
  stagingRoot: string;
  /** `layout.signing`: the host-private folder the files jsign signs are staged in. */
  signingRoot: string;
  /** `layout.exports`: every archive's folder resolves below it. */
  exportsRoot: string;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /** Folders a keystore may never come from: the games root, scratch, userData and the app's resources. */
  forbiddenRoots: readonly string[];
  /** Host credentials denied to the signing sandbox. */
  secretPaths: readonly string[];
  /** A sandbox of jsign's own for one signing run (`ProcessSandbox.create`). */
  sandboxFor(options: SandboxOptions): Promise<ExportSandbox>;
  /** Where `GENEX_EXPORT_JSIGN` (jsign's absolute launcher) is read (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The clock (default: `Date.now`). */
  now?(): number;
}

/** One Windows or Linux export: the game, the folder its archive goes into, and the checked signing. */
export interface DesktopExportGameRequest {
  destination: typeof BuildTarget.Windows | typeof BuildTarget.Linux;
  game: GameProject;
  targetDir: string;
  signing: ExportSigningChoice;
  /** The person asked in the studio's window (IPC): the only caller a certificate may sign for. */
  person?: boolean;
}

export { exportDesktopGame, exportRefusalOf } from "./desktop-export-run.ts";

// ---------- the export-run dispatch ----------

/** One phone export: the game, the folder its artifact goes into, the checked signing and the artifact it makes. */
export interface MobileExportGameRequest {
  destination: MobileBuildTarget;
  game: GameProject;
  targetDir: string;
  signing: ExportSigningChoice;
  /** What the signing makes (`mobileArtifactOf`): a Simulator app or an IPA, a dev APK or an AAB. */
  artifact: MobileArtifact;
  /** The person asked in the studio's window (IPC): the only caller an identity or a release keystore signs for. */
  person: boolean;
}

/** The core's export steps the dispatch table names (`StudioCore` binds them to its own services). */
export interface ExportRunners {
  browserFolder(game: GameProject, targetDir: string): Promise<ExportResult>;
  compiledWeb(game: GameProject, targetDir: string): Promise<ExportResult>;
  macApp(request: MacExportGameRequest): Promise<ExportResult>;
  desktopArchive(request: DesktopExportGameRequest): Promise<ExportResult>;
  /** An iPhone export (`exportIosGame` over the core's iPhone services). */
  iosApp(request: MobileExportGameRequest): Promise<ExportResult>;
  /** An Android export (`exportAndroidGame` over the core's Android services). */
  androidPackage(request: MobileExportGameRequest): Promise<ExportResult>;
  /**
   * The conformance gate of an ejected Rust game (`game-conformance-gate.ts`), over the game's
   * current host build: asked before any export runs. Absent: every game passes (a test's runners).
   */
  conformance?(game: GameProject): Promise<ConformanceGateResult>;
}

/** One export, as the core asks it: the library's game, the destination, its folder and the checked signing. */
export interface ExportRunRequest {
  game: GameProject;
  destination: BuildTarget;
  targetDir: string;
  /** Absent: a Mac app is signed ad hoc, everything else unsigned. */
  signing?: ExportSigningChoice;
  /** The person asked in the studio's window (IPC). */
  person: boolean;
}

/** The archive destinations a desktop-archive run takes. */
type ArchiveTarget = DesktopExportGameRequest["destination"];

const isArchiveTarget = (target: BuildTarget): target is ArchiveTarget =>
  target === BuildTarget.Windows || target === BuildTarget.Linux;

/** The receipt with the stack's GPU qualification for the destination, where its receipt carries one. */
export function withGpuQualification(result: ExportResult, stack: GameStack, destination: BuildTarget): ExportResult {
  const gpuQualification = gpuQualificationOf(stack, destination);
  return gpuQualification ? { ...result, gpuQualification } : result;
}

/** The phone run's request: the signing a phone export takes by default (ad hoc, Studio's debug key) and the artifact it makes. */
function mobileRequest(request: ExportRunRequest, destination: MobileBuildTarget): MobileExportGameRequest {
  const signing = request.signing ?? {
    kind: destination === BuildTarget.Ios ? ExportSigning.AdHoc : ExportSigning.AndroidDebug,
  };
  const { game, targetDir, person } = request;
  return { destination, game, targetDir, signing, artifact: mobileArtifactOf(destination, signing.kind), person };
}

/** Runs the table's export for `request`; a refused pair throws before anything runs. */
function dispatchExport(runners: ExportRunners, run: ExportRun, request: ExportRunRequest): Promise<ExportResult> {
  const { game, destination, targetDir, person } = request;
  switch (run) {
    case ExportRun.BrowserFolder:
      return runners.browserFolder(game, targetDir);
    case ExportRun.CompiledWeb:
      return runners.compiledWeb(game, targetDir);
    case ExportRun.MacApp:
      return runners.macApp({ game, targetDir, signing: request.signing ?? { kind: ExportSigning.AdHoc }, person });
    case ExportRun.DesktopArchive: {
      if (!isArchiveTarget(destination)) break;
      const signing = request.signing ?? { kind: ExportSigning.None };
      return runners.desktopArchive({ game, destination, targetDir, signing, person });
    }
    case ExportRun.IosApp:
      if (!isMobileBuildTarget(destination)) break;
      return runners.iosApp(mobileRequest(request, destination));
    case ExportRun.AndroidPackage:
      if (!isMobileBuildTarget(destination)) break;
      return runners.androidPackage(mobileRequest(request, destination));
    case ExportRun.LaneMissing:
      throw new ExportError(ExportRefusal.LaneMissing, MESSAGE.noExportYet(destination));
    case ExportRun.NotADestination:
      break;
  }
  throw new ExportError(ExportRefusal.NotADestination, MESSAGE.noExportHere(stackOf(game.shape), destination));
}

/**
 * Exports `request.game` to `request.destination` through {@link EXPORT_RUNS}, and records on the
 * receipt whether its GPU path ran on a real GPU of the destination ({@link withGpuQualification}).
 */
export async function runExport(runners: ExportRunners, request: ExportRunRequest): Promise<ExportResult> {
  const stack = stackOf(request.game.shape);
  // An ejected game exports only a build its conformance run vouches for; nothing runs before.
  const gate = (await runners.conformance?.(request.game)) ?? null;
  if (gate && !gate.ok) throw new ExportError(ExportRefusal.ConformanceRequired, gate.detail);
  const result = await dispatchExport(runners, EXPORT_RUNS[stack][request.destination], request);
  return withGpuQualification(result, stack, request.destination);
}
