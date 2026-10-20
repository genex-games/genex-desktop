/**
 * The chat header's export: copy a game's public files out, one export at a time, and say what
 * was made. A three.js game has one export, the browser folder; a C++ game offers the destinations
 * this computer exports (the browser folder, and on a Mac the Mac app and the Windows and Linux
 * archives it cross-builds); a Rust · wgpu game the destinations its host builds for it
 * (`STACK_HOST_MATRIX`) that this build exports (`exportsTo`: the browser folder and the phones).
 * A phone opens the export sheet, where the person picks what to make and how it is signed. A
 * destination whose export only a software GPU has drawn is labelled untested on real GPUs, a
 * phone no real device has run untested on real devices.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { StudioPlatform } from "../../shared/boot.ts";
import {
  type ExportWarning,
  ExportWarningCode,
  exportsTo,
  GpuQualification,
  gpuQualificationOf,
  WEB_BUDGET_MB_BYTES,
} from "../../shared/game-export-contract.ts";
import {
  ALL_BUILD_TARGETS,
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  destinationsOf,
  stackOf,
} from "../../shared/game-project.ts";
import { hostOf, STACK_HOST_MATRIX } from "../../shared/game-targets.ts";
import { laneRunsOn } from "../../shared/stack-setup.ts";
import { isMobileBuildTarget, type MobileBuildTarget } from "../../shared/toolchain.ts";
import { hostPlatform } from "../platform.ts";
import { useLibrary } from "../state/hooks.ts";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import { EXPORT_WORDS, exportedWords } from "../words.ts";

/** The phone export sheet the header has open: whose game and which phone. */
export interface ExportSheetOpen {
  project: string;
  destination: MobileBuildTarget;
}

export interface ChatExport {
  /** An export is running. */
  exporting: boolean;
  /**
   * The header's handler for a game's export, to `destination` (absent: the browser folder, as
   * before); a phone opens the export sheet instead; a second click while one runs does nothing.
   */
  exportGame(project: string): (destination?: BuildTarget) => void;
  /** The phone export sheet, while it is open. */
  sheet: ExportSheetOpen | null;
  /** The sheet made its export: say what was made and close it. */
  sheetExported(result: ExportResult): void;
  /** The person left the sheet without an export. */
  closeSheet(): void;
}

/** Whether `host` is a Mac: it builds Mac apps and cross-builds Windows and Linux with pinned tools. */
const onMac = (host: StudioPlatform | null): boolean => host === StudioPlatform.Mac;

/**
 * Which destinations this version exports a C++ · raylib game to on each host. A Linux host's lane has no pinned
 * linux-x64 CMake and Ninja yet, and a Windows host's lane is off, so only a Mac exports desktop builds.
 */
const EXPORTS_HERE = {
  [BuildTarget.Web]: () => true,
  [BuildTarget.Mac]: onMac,
  [BuildTarget.Windows]: onMac,
  [BuildTarget.Linux]: onMac,
  // A C++ game never makes a phone game.
  [BuildTarget.Ios]: () => false,
  [BuildTarget.Android]: () => false,
} as const satisfies Record<BuildTarget, (host: StudioPlatform | null) => boolean>;

/** The menu's words for each destination it offers. */
const DESTINATION_LABEL = {
  [BuildTarget.Web]: EXPORT_WORDS.browser,
  [BuildTarget.Mac]: EXPORT_WORDS.mac,
  [BuildTarget.Windows]: EXPORT_WORDS.windows,
  [BuildTarget.Linux]: EXPORT_WORDS.linux,
  [BuildTarget.Ios]: EXPORT_WORDS.ios,
  [BuildTarget.Android]: EXPORT_WORDS.android,
} as const satisfies Record<BuildTarget, string>;

/** The `.app` suffix of a Mac app export's artifact, left out of the notice's name. */
const APP_SUFFIX = /\.app$/i;

/** What the toast says after a desktop export, given the artifact's file name and the machine that built it. */
const DESKTOP_NOTICE: Partial<Record<BuildTarget, (file: string, machine?: string) => string>> = {
  [BuildTarget.Mac]: (file) => EXPORT_WORDS.exportedMac(file.replace(APP_SUFFIX, "")),
  [BuildTarget.Windows]: EXPORT_WORDS.exportedWindows,
  [BuildTarget.Linux]: EXPORT_WORDS.exportedLinux,
};

/** Whether `host` exports a Rust · wgpu game to `target`: its lane runs there and builds the destination. */
function rustExportsHere(target: BuildTarget, host: StudioPlatform | null): boolean {
  if (!host || !laneRunsOn(GameStack.RustWgpu, host)) return false;
  const builds: readonly BuildTarget[] = STACK_HOST_MATRIX[GameStack.RustWgpu][host].build;
  return builds.includes(target);
}

/**
 * The destinations the header offers for `game` on `host`, in the create dialog's order: null for a
 * three.js game, which keeps its one export item. Only destinations the export-run table exports
 * (`exportsTo`): never one refused `lane-missing` or `not-a-destination`.
 */
export function exportDestinationsFor(
  game: Pick<GameProject, "shape" | "destinations">,
  host: StudioPlatform | null,
): BuildTarget[] | null {
  const stack = stackOf(game.shape);
  if (stack === GameStack.ThreeJs) return null;
  const named = destinationsOf(game).targets;
  const exportsHere =
    stack === GameStack.RustWgpu ? rustExportsHere : (target: BuildTarget) => EXPORTS_HERE[target](host);
  return ALL_BUILD_TARGETS.filter(
    (target) => named.includes(target) && exportsTo(stack, target) && exportsHere(target, host),
  );
}

/** Whether exporting to `destination` opens the phone export sheet (what to make, how it is signed) rather than exporting at once. */
export function exportOpensSheet(destination: BuildTarget | undefined): destination is MobileBuildTarget {
  return isMobileBuildTarget(destination);
}

/**
 * The label beside a destination in the export list: where the stack's export is untested
 * (`gpuQualificationOf`), untested on real devices for a phone no real device has run, untested
 * on real GPUs where only a software GPU has drawn it; else null. The owner's real-device or
 * real-GPU row for a destination removes it.
 */
export function exportCaveat(game: Pick<GameProject, "shape">, destination: BuildTarget): string | null {
  const untested = gpuQualificationOf(stackOf(game.shape), destination) === GpuQualification.Untested;
  if (!untested) return null;
  return isMobileBuildTarget(destination) ? EXPORT_WORDS.untestedOnRealDevices : EXPORT_WORDS.untestedOnRealGpus;
}

/** The menu's label for a destination. */
export function exportDestinationLabel(destination: BuildTarget): string {
  return DESTINATION_LABEL[destination];
}

/**
 * What the toast says after an export: the Mac app, or the Windows or Linux archive, by its file
 * name (from a POSIX or a Windows path) and the machine `host` that built it; the browser folder's
 * files as before. A receipt that says untested on real GPUs adds what that means, and each
 * warning the export carries adds its own sentence.
 */
export function exportNotice(result: ExportResult, host: StudioPlatform | null = StudioPlatform.Mac): string {
  const phone = isMobileBuildTarget(result.destination);
  const said = (phone ? phoneNotice(result) : desktopNotice(result, host)) ?? exportedWords(result);
  const untested = result.gpuQualification === GpuQualification.Untested;
  const caveat = phone ? EXPORT_WORDS.untestedDevicesNotice : EXPORT_WORDS.untestedNotice;
  const warnings = (result.warnings ?? []).map(warningNotice);
  return [said, ...(untested ? [caveat] : []), ...warnings].join(" ");
}

/** An MB figure for a notice: whole budgets as they were named, sizes to one decimal. */
const megabytes = (bytes: number, digits: number) => (bytes / WEB_BUDGET_MB_BYTES).toFixed(digits);

/** The sentence an export warning adds to the notice. */
function warningNotice(warning: ExportWarning): string {
  switch (warning.code) {
    case ExportWarningCode.WasmOverTarget:
      return EXPORT_WORDS.wasmOverTarget(megabytes(warning.gzipBytes, 1), megabytes(warning.budgetBytes, 0));
    case ExportWarningCode.AssetsOverBudget:
      return EXPORT_WORDS.assetsOverBudget(megabytes(warning.bytes, 1), megabytes(warning.budgetBytes, 0));
  }
}

/** A phone export's notice by its artifact's file name, or null for a receipt that names none. */
function phoneNotice(result: ExportResult): string | null {
  if (!result.artifact) return null;
  return EXPORT_WORDS.mobile.exported(result.artifact.split(/[\\/]/).at(-1) ?? result.artifact);
}

/** The desktop artifact's own notice, or null for a receipt that names no desktop artifact. */
function desktopNotice(result: ExportResult, host: StudioPlatform | null): string | null {
  const notice = result.destination ? DESKTOP_NOTICE[result.destination] : undefined;
  if (!notice || !result.artifact) return null;
  const file = result.artifact.split(/[\\/]/).at(-1) ?? result.artifact;
  return host === StudioPlatform.Mac ? notice(file) : notice(file, EXPORT_WORDS.builtElsewhere);
}

/** The destinations the header offers for `project` on this computer (null: one export item). */
export function useExportDestinations(project: string | null): BuildTarget[] | null {
  const game = useLibrary((state) => (project ? state.games.find((listed) => listed.name === project) : undefined));
  return useMemo(() => (game ? exportDestinationsFor(game, hostOf(hostPlatform())) : null), [game]);
}

/** The label beside each of `project`'s export destinations ({@link exportCaveat}). */
export function useExportCaveat(project: string | null): (destination: BuildTarget) => string | null {
  const game = useLibrary((state) => (project ? state.games.find((listed) => listed.name === project) : undefined));
  return useCallback((destination) => (game ? exportCaveat(game, destination) : null), [game]);
}

export function useChatExport(onNotice: Notify): ChatExport {
  const [exporting, setExporting] = useState(false);
  const [sheet, setSheet] = useState<ExportSheetOpen | null>(null);
  // A ref as well as the state: two clicks in one frame both see the state before it changes.
  const pending = useRef(false);
  const sheetExported = (result: ExportResult) => {
    setSheet(null);
    onNotice(exportNotice(result, hostOf(hostPlatform())), ToastTone.Ok);
  };
  const exportGame = (project: string) => (destination?: BuildTarget) => {
    if (pending.current) return;
    if (exportOpensSheet(destination)) {
      setSheet({ project, destination });
      return;
    }
    pending.current = true;
    setExporting(true);
    const exported =
      destination === undefined
        ? window.studio.exportGame(project)
        : window.studio.exportGame(project, { destination });
    void exported
      .then((result) => onNotice(exportNotice(result, hostOf(hostPlatform())), ToastTone.Ok))
      .catch(notifyProblem(onNotice))
      .finally(() => {
        pending.current = false;
        setExporting(false);
      });
  };
  return { exporting, exportGame, sheet, sheetExported, closeSheet: () => setSheet(null) };
}
