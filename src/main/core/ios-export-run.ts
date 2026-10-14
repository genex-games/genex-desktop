/**
 * A Rust · wgpu game's iPhone export (`ExportRun.IosApp`): a Simulator app signed ad hoc, or an
 * IPA signed with the person's own Apple Development or Distribution identity, packaged by
 * `substrate/ios-package.ts` (M5.1).
 *
 * The checks run before anything is built: a Mac (iPhone builds need Xcode), a Rust game naming
 * the iPhone, the harness never asking for an IPA, and the Xcode gate (a device or distribution
 * build needs Xcode 26 with the iOS 26 SDK). Then the lane builds the artifact's own platform
 * (the Simulator triple for a Simulator app, the device triple for an IPA, purpose export), the
 * notices are generated from that build's admitted lock (`rust-notices.ts`, the iOS row) and the
 * package is made from the admitted output.
 *
 * The core reaches it through `ExportRunners.iosApp` with {@link IosExportDeps}
 * (`mobile-export-deps.ts`: the Rust lane's device build, the Simulator lane, the Xcode probe and
 * `codesign` in a sandbox of its own); without them it refuses `lane-missing` before anything is
 * built or written. Nothing here launches a Simulator or a device (containment stage 1).
 */
import { StudioPlatform } from "../../shared/boot.ts";
import {
  ExportError,
  ExportRefusal,
  HARNESS_MOBILE_ARTIFACTS,
  MobileArtifact,
} from "../../shared/game-export-contract.ts";
import {
  BuildTarget,
  destinationsOf,
  type ExportResult,
  type GameProject,
  GameStack,
  stackOf,
} from "../../shared/game-project.ts";
import {
  IOS_DEFAULT_ORIENTATIONS,
  type IosArtifact,
  type IosSigner,
  iosXcodeRefusal,
  packageIosApp,
} from "../../substrate/ios-package.ts";
import type { AdmittedOutputFile } from "../../substrate/native-bundle.ts";
import type { RustNotices } from "../../substrate/rust-notices.ts";
import type { XcodeSdks } from "../../substrate/toolchain-store/xcode-probe.ts";
import { SigningRequester } from "../../substrate/windows-sign.ts";
import { MobileBuild } from "../rust-build-mobile.ts";
import type { MobileExportGameRequest } from "./native-export-run.ts";

const MESSAGE = {
  notYet: "This build of Genex cannot export an iPhone game yet.",
  needsAMac: "iPhone games are exported on a Mac with Xcode.",
  notADestination: (project: string) => `"${project}" is not a Rust game made for the iPhone`,
  harness: "Only you can export an iPhone app signed with your own identity; the agent exports Simulator apps.",
  xcode: (refusal: string) =>
    `This Mac's Xcode cannot make that iPhone build (${refusal}): a device or App Store build needs Xcode 26 or later with the iOS 26 SDK.`,
  buildFailed: "The game's iPhone build failed, so no app was made.",
  notices: (refusal: string, detail: string) =>
    `The iPhone app's licence notices could not be made (${refusal}): ${detail}`,
  notAPhoneArtifact: (artifact: string) => `${artifact} is not an iPhone artifact`,
} as const;

/** The lane's admitted iPhone build: its `out/`, the digests it admitted, and the lock it was built with. */
export interface IosBuild {
  out: string;
  outputs: readonly AdmittedOutputFile[];
  /** The `Cargo.lock` the build resolved (`admittedBuildLock`), for the notices. */
  buildLock: string;
}

/** What an iPhone export reaches: the core's own services. */
export interface IosExportDeps {
  /** This host, or null on a platform the studio does not build for. */
  host: StudioPlatform | null;
  /** The game's once-chosen bundle id. */
  games: { bundleIdFor(name: string): Promise<string> };
  /** The Rust lane's build of `game` for `build` (purpose export), admitted; null when it failed. */
  build(game: GameProject, build: MobileBuild): Promise<IosBuild | null>;
  /** The Xcode probe (`probeXcodeSdks`). */
  xcode(): Promise<XcodeSdks>;
  /** The notices for the build's admitted lock and the iOS row (`rustExportNotices`). */
  notices(game: GameProject, build: IosBuild): Promise<RustNotices>;
  /** The sandboxed `codesign` (`mobileSignSandboxOptions` over the export's staging root). */
  signer: IosSigner;
  /** `layout.exportStaging`. */
  stagingRoot: string;
  /** `layout.exports`. */
  exportsRoot: string;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /**
   * Admits a signed Simulator app, still in staging, for the person's device launch
   * (`phonePackageStore`); absent, nothing is admitted.
   */
  admitSimulatorApp?(project: string, app: string): Promise<void>;
  now?(): number;
}

/** The lane build each iPhone artifact is made from. */
const ARTIFACT_BUILD = {
  [MobileArtifact.SimulatorApp]: MobileBuild.IosSimulator,
  [MobileArtifact.Ipa]: MobileBuild.IosDevice,
} as const satisfies Record<IosArtifact, MobileBuild>;

const isIosArtifact = (artifact: MobileArtifact): artifact is IosArtifact => Object.hasOwn(ARTIFACT_BUILD, artifact);

/** Refuses a game that is not a Rust game naming the iPhone. */
function assertIosGame(game: GameProject): void {
  const named = destinationsOf(game).targets.includes(BuildTarget.Ios);
  if (stackOf(game.shape) !== GameStack.RustWgpu || !named) {
    throw new ExportError(ExportRefusal.NotADestination, MESSAGE.notADestination(game.name));
  }
}

/** The checks before anything is built: a Mac, an iPhone game, the caller, the artifact and Xcode. */
function assertCanExport(request: MobileExportGameRequest, deps: IosExportDeps): IosArtifact {
  if (deps.host !== StudioPlatform.Mac) throw new ExportError(ExportRefusal.MacBuildsNeedAMac, MESSAGE.needsAMac);
  assertIosGame(request.game);
  const { artifact } = request;
  if (!isIosArtifact(artifact))
    throw new ExportError(ExportRefusal.SigningInvalid, MESSAGE.notAPhoneArtifact(artifact));
  if (!request.person && !HARNESS_MOBILE_ARTIFACTS.includes(artifact)) {
    throw new ExportError(ExportRefusal.HarnessMayNotSign, MESSAGE.harness);
  }
  return artifact;
}

/** The Xcode probe's findings, refused for `artifact` before anything is built. */
async function checkedXcode(artifact: IosArtifact, deps: IosExportDeps): Promise<XcodeSdks> {
  const xcode = await deps.xcode();
  const refusal = iosXcodeRefusal(artifact, xcode);
  if (refusal !== null) throw new ExportError(ExportRefusal.ToolchainUnusable, MESSAGE.xcode(refusal), { refusal });
  return xcode;
}

/**
 * Exports `request.game` for iOS as `request.artifact` into `request.targetDir`. Without `deps`
 * (the core has not wired the iPhone lane) it refuses `lane-missing` before anything runs.
 */
export async function exportIosGame(request: MobileExportGameRequest, deps?: IosExportDeps): Promise<ExportResult> {
  if (!deps) throw new ExportError(ExportRefusal.LaneMissing, MESSAGE.notYet);
  const artifact = assertCanExport(request, deps);
  const xcode = await checkedXcode(artifact, deps);
  const { game } = request;
  const built = await deps.build(game, ARTIFACT_BUILD[artifact]);
  if (!built) throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.buildFailed);
  const notices = await deps.notices(game, built);
  if (!notices.ok) throw new ExportError(ExportRefusal.MissingNotice, MESSAGE.notices(notices.refusal, notices.detail));
  const packaged = await packageIosApp({
    artifact,
    out: built.out,
    outputs: built.outputs,
    notices: notices.notices,
    bundleId: await deps.games.bundleIdFor(game.name),
    title: game.title ?? game.name,
    fallbackName: game.name,
    orientations: IOS_DEFAULT_ORIENTATIONS,
    signing: request.signing,
    requestedBy: request.person ? SigningRequester.Person : SigningRequester.Harness,
    xcode,
    source: game.dir,
    target: request.targetDir,
    exportsRoot: deps.exportsRoot,
    stagingRoot: deps.stagingRoot,
    secretValues: deps.secretValues(),
    signer: deps.signer,
    ...(deps.now ? { now: deps.now } : {}),
    admitStaged: async (app) => deps.admitSimulatorApp?.(game.name, app),
  });
  return {
    dir: packaged.dir,
    files: packaged.files,
    included: packaged.included,
    excluded: [],
    destination: BuildTarget.Ios,
    artifact: packaged.artifact,
  };
}
