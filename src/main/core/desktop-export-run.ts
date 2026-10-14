/** Windows and Linux archive orchestration over the core's owned library and toolchain lock. */
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { ExportError, ExportRefusal, ExportSigning } from "../../shared/game-export-contract.ts";
import {
  BuildTarget,
  destinationsOf,
  type ExportResult,
  type GameProject,
  GameStack,
  isCompiledStack,
  stackOf,
} from "../../shared/game-project.ts";
import { realpathNearest } from "../../substrate/fsx.ts";
import { EXPORT_MANIFEST, makeStaging, resolveExportTarget, swapIntoPlace } from "../../substrate/game-export.ts";
import {
  ArchiveRefusal,
  linuxExportName,
  NativeArchiveError,
  windowsExportName,
} from "../../substrate/native-export-archive.ts";
import {
  DesktopExportError,
  DesktopExportProblem,
  exportLinuxTarball,
  exportWindowsZip,
  type WindowsExportDeps,
} from "../../substrate/native-export-desktop.ts";
import { isBelow } from "../../substrate/paths.ts";
import {
  jsignPreflight,
  jsignSandboxOptions,
  type JsignRun,
  runJsign,
  SigningRequester,
  WindowsSignError,
  WindowsSignProblem,
  WindowsSigningKind,
  withJsignProxy,
} from "../../substrate/windows-sign.ts";
import { CppBuildPurpose } from "../cpp-build.ts";
import type { DesktopExportGameDeps, DesktopExportGameRequest } from "./native-export-run.ts";
import { ExportCaller, exportSigningFor } from "./native-export-signing.ts";

const DESKTOP_REFUSALS = {
  [DesktopExportProblem.Target]: ExportRefusal.TargetRefused,
  [DesktopExportProblem.NotAdmitted]: ExportRefusal.AdmissionRefused,
  [DesktopExportProblem.Changed]: ExportRefusal.BuildChanged,
  [DesktopExportProblem.StoreFile]: ExportRefusal.ToolchainUnusable,
  [DesktopExportProblem.SignFailed]: ExportRefusal.SigningFailed,
  [DesktopExportProblem.SignedNotAdmitted]: ExportRefusal.SigningFailed,
} as const;
const UNAVAILABLE = new Set<WindowsSignProblem>([
  WindowsSignProblem.HardwareToken,
  WindowsSignProblem.WindowsHostPassword,
  WindowsSignProblem.Tool,
]);

/** Maps only known refusal types. Unexpected filesystem or programming failures retain their identity. */
export function exportRefusalOf(error: unknown): ExportError {
  if (error instanceof ExportError) return error;
  if (error instanceof DesktopExportError) {
    return new ExportError(DESKTOP_REFUSALS[error.code], error.message, { refusal: error.refusal, file: error.file });
  }
  if (error instanceof WindowsSignError) {
    let code: ExportRefusal = ExportRefusal.SigningInvalid;
    if (error.code === WindowsSignProblem.HarnessMayNotSign) code = ExportRefusal.HarnessMayNotSign;
    else if (UNAVAILABLE.has(error.code)) code = ExportRefusal.SigningUnavailable;
    return new ExportError(code, error.message);
  }
  if (error instanceof NativeArchiveError) {
    let code: ExportRefusal = ExportRefusal.ArchiveRefused;
    if (error.code === ArchiveRefusal.SecretFound) code = ExportRefusal.SecretFound;
    else if (error.code === ArchiveRefusal.MissingNotice) code = ExportRefusal.MissingNotice;
    return new ExportError(code, error.message);
  }
  throw error;
}

async function ownedGame(deps: DesktopExportGameDeps, request: DesktopExportGameRequest): Promise<GameProject> {
  const game = (await deps.games.list()).find((entry) => entry.name === request.game.name);
  const named = game !== undefined && destinationsOf(game).targets.includes(request.destination);
  if (!game || !named) {
    throw new ExportError(ExportRefusal.NotADestination, "The game does not name this desktop destination.");
  }
  // raylib's own: the archive is made from zig cross builds, the store's ANGLE and raylib's licences.
  // Another compiled game names it, but its export lane is not in this build yet.
  if (stackOf(game.shape) !== GameStack.RaylibCpp) {
    const code = isCompiledStack(stackOf(game.shape)) ? ExportRefusal.LaneMissing : ExportRefusal.NotADestination;
    throw new ExportError(code, "This build of Genex cannot export this game's stack to the desktop yet.");
  }
  if (deps.host !== StudioPlatform.Mac) {
    throw new ExportError(ExportRefusal.ToolchainUnusable, "Desktop archives are currently built on a Mac.");
  }
  return game;
}

async function signedRun(deps: DesktopExportGameDeps, run: JsignRun) {
  const staging = run.request.cwd;
  await mkdir(deps.signingRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(deps.signingRoot, "scratch-"));
  try {
    const sandbox = await deps.sandboxFor(
      jsignSandboxOptions({ staging, scratch, secretPaths: deps.secretPaths, denyWrite: deps.forbiddenRoots }),
    );
    try {
      const proxy = sandbox.networkProxy?.();
      if (!proxy)
        throw new ExportError(ExportRefusal.SigningUnavailable, "The signing sandbox has no filtering HTTP proxy.");
      return await runJsign(sandbox, withJsignProxy(run, proxy));
    } finally {
      await sandbox.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function signingDeps(
  deps: DesktopExportGameDeps,
  request: DesktopExportGameRequest,
  game: GameProject,
): Promise<WindowsExportDeps> {
  const caller = request.person ? ExportCaller.Person : ExportCaller.Harness;
  const signing = exportSigningFor(request.destination, request.signing, caller);
  if (signing.kind !== ExportSigning.OwnCertificate) return {};
  const launcher = (deps.env ?? process.env).GENEX_EXPORT_JSIGN;
  if (!launcher || !path.isAbsolute(launcher)) {
    throw new ExportError(
      ExportRefusal.SigningUnavailable,
      "An absolute jsign launcher must be configured before signing an export.",
    );
  }
  if (!(await stat(launcher).catch(() => null))?.isFile()) {
    throw new ExportError(ExportRefusal.SigningUnavailable, "The configured jsign launcher is unavailable.");
  }
  const tool = { file: launcher, args: [] };
  const checked = await jsignPreflight({
    choice: signing,
    requestedBy: SigningRequester.Person,
    host: deps.host ?? StudioPlatform.Mac,
    tool,
    programName: game.title,
    forbiddenRoots: deps.forbiddenRoots,
  });
  if (checked?.hardwareToken) throw new WindowsSignError(WindowsSignProblem.HardwareToken);
  return {
    jsign: { tool, forbiddenRoots: deps.forbiddenRoots, stagingRoot: deps.signingRoot },
    runSigned: (run) => signedRun(deps, run),
  };
}

async function buildParts(deps: DesktopExportGameDeps, request: DesktopExportGameRequest, game: GameProject) {
  const lock = await deps.toolchains.currentLock();
  const { name: project, dir, shape } = game;
  const asked = { project, dir, shape, destinations: destinationsOf(game), lock };
  const { outcome: built } = await deps.gameBuilds.ensure(asked, request.destination, CppBuildPurpose.Export);
  if (!built?.ok || !built.output || !lock) {
    const gate = built?.problem?.gate;
    throw new ExportError(
      gate ? ExportRefusal.AdmissionRefused : ExportRefusal.BuildFailed,
      "The desktop build failed; no archive was made.",
      gate ?? {},
    );
  }
  const located = await deps.toolchains.locate(lock, [request.destination]);
  const toolchain = located.ok ? located.toolchain : null;
  const cross = toolchain?.cross?.[request.destination];
  const linux = request.destination === BuildTarget.Linux;
  if (
    !toolchain?.zig ||
    !toolchain.raylibSource ||
    !cross?.angle ||
    (linux && (!cross.sysroot || !cross.sysrootManifestSha256))
  ) {
    throw new ExportError(
      ExportRefusal.ToolchainUnusable,
      "The locked desktop toolchain is incomplete; no archive was made.",
    );
  }
  return {
    out: built.output,
    angle: cross.angle,
    zig: path.dirname(toolchain.zig),
    raylib: toolchain.raylibSource,
    sysroot:
      cross.sysroot && cross.sysrootManifestSha256
        ? { dir: cross.sysroot, manifestSha256: cross.sysrootManifestSha256 }
        : null,
  };
}

async function checkedTarget(deps: DesktopExportGameDeps, game: GameProject, targetDir: string) {
  const root = path.resolve(deps.exportsRoot);
  const realRoot = await realpathNearest(root);
  const realTarget = await realpathNearest(targetDir);
  if (!isBelow(root, path.resolve(targetDir)) || !isBelow(realRoot, realTarget)) {
    throw new ExportError(ExportRefusal.TargetRefused, "The archive folder must stay inside Genex's exports folder.");
  }
  return resolveExportTarget(await realpath(game.dir), targetDir);
}

async function archiveGame(deps: DesktopExportGameDeps, request: DesktopExportGameRequest): Promise<ExportResult> {
  const game = await ownedGame(deps, request);
  const sign = await signingDeps(deps, request, game);
  const parts = await buildParts(deps, request, game);
  const { target, parent, existing } = await checkedTarget(deps, game, request.targetDir);
  const staging = await makeStaging(parent, deps.stagingRoot);
  try {
    const windows = request.destination === BuildTarget.Windows;
    const name = windows
      ? `${windowsExportName(game.title)}-windows-x64.zip`
      : `${linuxExportName(game.title)}-linux-x64.tar.gz`;
    const common = {
      ...parts,
      game: game.dir,
      title: game.title,
      archive: path.join(staging, name),
      builtOn: StudioPlatform.Mac,
      ranOnTarget: false,
      secretValues: deps.secretValues(),
    };
    const signing =
      request.signing.kind === ExportSigning.OwnCertificate ? request.signing : { kind: WindowsSigningKind.Unsigned };
    const exported = windows
      ? await exportWindowsZip(
          {
            ...common,
            signing: {
              requester: request.person ? SigningRequester.Person : SigningRequester.Harness,
              choice: signing,
            },
          },
          sign,
        )
      : await exportLinuxTarball({ ...common, sysroot: parts.sysroot! });
    const marker = {
      studioExport: 1,
      destination: request.destination,
      archive: name,
      signed: exported.signed,
      included: [name],
    };
    await writeFile(path.join(staging, EXPORT_MANIFEST), JSON.stringify(marker), { flag: "wx" });
    await swapIntoPlace(staging, target, existing, deps.now);
    return {
      dir: target,
      files: 1,
      included: [name],
      excluded: [],
      destination: request.destination,
      artifact: path.join(target, name),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Exports the current owned game's destination, or a typed refusal without replacing its previous export. */
export async function exportDesktopGame(
  deps: DesktopExportGameDeps,
  request: DesktopExportGameRequest,
): Promise<ExportResult> {
  try {
    return await archiveGame(deps, request);
  } catch (error) {
    throw exportRefusalOf(error);
  }
}
