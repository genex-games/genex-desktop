/**
 * What the Toolchain sheet and Settings → Toolchains show for the store's status and its install
 * job, per compiled stack: what is missing and why a part has no download, which destinations must
 * be set up again, how much disk an install needs, when the sheet is ready and when Install or Try
 * again works. A Rust · wgpu game reads its own components under its own lock, Apple's
 * prerequisites as two rows (the Command Line Tools, which Xcode also provides, and Xcode), and the
 * harness parts a Rust night refuses. A Rust sheet also lists each phone's setup: the iPhone's Rust
 * libraries behind Xcode 26, and Android's SDK parts the person installs under the licence they
 * accept in the sheet, beside the store's parts. Pure, so conformance tests hold these rules
 * without a window.
 */
import type { StudioPlatform } from "../../shared/boot.ts";
import {
  ALL_BUILD_TARGETS,
  BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  GameStack,
} from "../../shared/game-project.ts";
import { hostTarget } from "../../shared/game-targets.ts";
import { SetupPrerequisite } from "../../shared/stack-setup.ts";
import {
  ANDROID_PINS,
  CLT_TARGETS,
  isInstallRunning,
  type MobileBuildTarget,
  type MissingToolchain,
  missingFor,
  type PrewarmState,
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  type ToolchainDownload,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainInstallJob,
  type ToolchainLock,
  type ToolchainStatus,
  type ToolchainUnhosted,
  RUST_MOBILE_COMPONENTS,
  USER_SIDE_COMPONENTS,
  type UserSideComponent,
  UserSideState,
  XcodeStatus,
} from "../../shared/toolchain.ts";
import { TOOLCHAIN_WORDS } from "../words.ts";

/** The stacks whose tools the sheet installs; a Rust game's are read, not yet downloaded, from here. */
const INSTALLS_FROM_SHEET: ReadonlySet<CompiledStack> = new Set([GameStack.RaylibCpp]);

/** The lock `stack`'s builds locate with: raylib's `lock`, else the stack's own (`stackLocks`). */
export function stackLockOf(status: ToolchainStatus, stack: CompiledStack): ToolchainLock | null {
  if (stack === GameStack.RaylibCpp) return status.lock;
  return status.stackLocks?.[stack] ?? null;
}

/**
 * Whether Apple's tools for a Mac build are here for `stack`: raylib reads the Command Line Tools
 * probe as it always did; a Rust game's Mac build also takes the copy inside Xcode.
 */
function macToolsPresent(status: ToolchainStatus, stack: CompiledStack): boolean {
  if (stack === GameStack.RaylibCpp) return status.clt.present;
  return status.clt.present || status.xcode?.present === true;
}

/** Whether the store holds `id` at the version `lock` names, or at any version when the lock names none. */
function holds(status: ToolchainStatus, lock: ToolchainLock | null, id: ToolchainId): boolean {
  const locked = lock?.entries[id];
  return status.installed.some(
    (item) => item.id === id && (!locked || (item.version === locked.version && item.sha12 === locked.sha12)),
  );
}

/**
 * What `targets` of a `stack` game lack before they build: Apple's tools, components at the stack's
 * lock, and destinations to prepare again. raylib's is `missingFor`; a Rust game reads its own
 * components under its own lock, and the store reports no Rust prewarm to redo.
 */
export function missingForStack(
  status: ToolchainStatus,
  targets: readonly BuildTarget[],
  stack: CompiledStack,
): MissingToolchain {
  if (stack === GameStack.RaylibCpp) return missingFor(status, targets);
  const table = STACK_REQUIRED_COMPONENTS[stack];
  const lock = stackLockOf(status, stack);
  const wanted = ALL_BUILD_TARGETS.filter((target) => targets.includes(target));
  const needed = [...new Set(wanted.flatMap((target): readonly ToolchainId[] => table[target]))];
  return {
    clt: !macToolsPresent(status, stack) && wanted.some((target) => CLT_TARGETS.includes(target)),
    components: needed.filter((id) => !holds(status, lock, id)),
    prewarm: [],
  };
}

/** The disk line's two numbers, when both are known and there is something to install. */
export interface DiskFacts {
  need: number;
  free: number;
}

/** One component still to install: its download, or why it has none. */
export interface SheetRow {
  id: ToolchainId;
  /** Its pinned download for this computer, or null when there is none. */
  download: ToolchainDownload | null;
  /** Genex pinned it but has published no download yet, and why; null for a download or a part with no pin. */
  unhosted: ToolchainUnhosted | null;
}

/** What the sheet shows for a status and job. */
export interface SheetView {
  /** The components still to download, in the table's order. */
  components: ToolchainId[];
  /**
   * Each of them with its download or why it has none, leaving out a download only destinations in
   * `notYet` need: Install skips every part of a destination that waits on another download.
   */
  rows: SheetRow[];
  /** Those of them with no download for this computer yet (no pin, or not published): an install cannot fetch them. */
  unavailable: ToolchainId[];
  /** How many of those have no pin at all (the rest are pinned but not published). */
  unpinned: number;
  /** Destinations an install cannot finish here: a component they lack has no download for this computer yet. */
  notYet: BuildTarget[];
  /** Destinations whose tools are all in but whose first build is stale or not prepared: Install prepares it again. */
  prewarm: Array<{ target: BuildTarget; state: PrewarmState }>;
  /** Install would only prepare again, downloading nothing (whatever else is missing has no download): the button says Set up again. */
  setUpAgain: boolean;
  downloads: readonly ToolchainDownload[];
  /** The disk the install needs: what the downloads in `rows` unpack to, plus the reserve. */
  need: number;
  /** The disk line, or null when it has nothing to compare. */
  disk: DiskFacts | null;
  cltMissing: boolean;
  /** Everything `targets` need is there and the current lock names it: Close is the way on. */
  ready: boolean;
  /** Install (or Try again) can start a job that installs something: a destination has every missing component downloadable. */
  canInstall: boolean;
  /** The last job failed or was cancelled: the button says Try again. */
  retry: boolean;
  /** The stack whose tools these are. */
  stack: CompiledStack;
  /** Whether Install fetches this stack's tools here; a Rust game's are listed, not yet downloaded. */
  installsHere: boolean;
  /** The harness parts a Rust night refuses until each is re-taken; empty for any other stack. */
  keptPreRust: string[];
}

/**
 * Whether the current lock names every component `targets` need. A build locates with that lock,
 * so a component on disk that no lock names (an install whose prewarm failed) builds nothing.
 */
function lockCovers(status: ToolchainStatus, targets: readonly BuildTarget[], stack: CompiledStack): boolean {
  const lock = stackLockOf(status, stack);
  if (!lock) return false;
  const table = STACK_REQUIRED_COMPONENTS[stack];
  return targets.every((target) => table[target].every((id) => lock.entries[id] !== undefined));
}

/**
 * The disk an install of `components` needs: each one it can download unpacked, plus the reserve
 * (the install's own check); nothing when it can download none of them.
 */
function diskNeed(status: ToolchainStatus, components: readonly ToolchainId[]): number {
  const downloads = status.downloads ?? [];
  const unpacked = components.reduce((sum, id) => sum + (downloads.find((item) => item.id === id)?.diskBytes ?? 0), 0);
  return unpacked > 0 ? unpacked + (status.reserveBytes ?? 0) : 0;
}

/**
 * Whether an install would do something for some destination in `targets`: every component it
 * still lacks has a download, or it lacks none and no lock names them yet or its prewarm is stale
 * or missing (a prewarm to redo).
 */
function someInstallable(status: ToolchainStatus, targets: readonly BuildTarget[]): boolean {
  const downloadable = (id: ToolchainId) => (status.downloads ?? []).some((item) => item.id === id);
  return targets.some((target) => {
    const { components, prewarm } = missingFor(status, [target]);
    if (components.length > 0) return components.every(downloadable);
    // Managed parts may be installed first; Mac's first build waits for Apple's separate SDK.
    if (target === BuildTarget.Mac && !status.clt.present) return false;
    return prewarm.length > 0 || !lockCovers(status, [target], GameStack.RaylibCpp);
  });
}

/** The destinations in `targets` (in the table's order) that lack a component `rows` has no download for. */
function waitingOnDownloads(
  status: ToolchainStatus | null,
  targets: readonly BuildTarget[],
  rows: readonly SheetRow[],
): BuildTarget[] {
  if (!status) return [];
  const undownloadable = new Set(rows.filter((row) => !row.download).map((row) => row.id));
  return BUILD_TARGETS.filter((target) => {
    if (!targets.includes(target)) return false;
    return missingFor(status, [target]).components.some((id) => undownloadable.has(id));
  });
}

/**
 * The rows the sheet lists: every component with no download (it says why), and each download a
 * destination outside `waiting` needs. A download only waiting destinations need is not fetched.
 */
function listedRows(
  status: ToolchainStatus | null,
  targets: readonly BuildTarget[],
  rows: readonly SheetRow[],
  waiting: readonly BuildTarget[],
): SheetRow[] {
  if (!status) return [...rows];
  const finishing = targets.filter((target) => !waiting.includes(target));
  const fetched = new Set(missingFor(status, finishing).components);
  return rows.filter((row) => !row.download || fetched.has(row.id));
}

/**
 * What a row's size column says: what it downloads, that it comes with Genex (ANGLE, copied from
 * the app, never downloaded), or that this computer has no download for it yet.
 */
export function sizeWords(download: ToolchainDownload | null): string {
  if (!download) return TOOLCHAIN_WORDS.unavailable;
  return download.bundled ? TOOLCHAIN_WORDS.included : TOOLCHAIN_WORDS.size(download.bytes);
}

/** One missing component's row: its download, or why it has none. */
function rowOf(status: ToolchainStatus | null, id: ToolchainId): SheetRow {
  const download = status?.downloads?.find((item) => item.id === id) ?? null;
  const unhosted = download ? null : (status?.unhosted?.find((item) => item.id === id)?.reason ?? null);
  return { id, download, unhosted };
}

/** The destinations to set up again, each with how its prewarm stands. */
function prewarmRows(
  status: ToolchainStatus | null,
  targets: readonly BuildTarget[],
): Array<{ target: BuildTarget; state: PrewarmState }> {
  if (!status) return [];
  return missingFor(status, targets).prewarm.flatMap((target) => {
    const state = status.prewarm?.[target];
    return state ? [{ target, state }] : [];
  });
}

/**
 * What the sheet shows for a `stack` game whose tools it only reads (Rust · wgpu): each missing
 * component as a row with no download, and Install never offered.
 */
function readOnlyView(
  status: ToolchainStatus | null,
  targets: readonly BuildTarget[],
  stack: CompiledStack,
): SheetView {
  const missing = status ? missingForStack(status, targets, stack) : null;
  const components = missing?.components ?? [];
  const covered = status !== null && lockCovers(status, targets, stack);
  return {
    components,
    rows: components.map((id) => ({ id, download: null, unhosted: null })),
    unavailable: [],
    unpinned: 0,
    notYet: [],
    prewarm: [],
    setUpAgain: false,
    downloads: status?.downloads ?? [],
    need: 0,
    disk: null,
    cltMissing: missing?.clt ?? false,
    ready: Boolean(status?.host) && missing !== null && !missing.clt && components.length === 0 && covered,
    canInstall: false,
    retry: false,
    stack,
    installsHere: false,
    keptPreRust: stack === GameStack.RustWgpu ? [...(status?.keptPreRust ?? [])] : [],
  };
}

/** What the sheet shows for a status and job of a `stack` game (C++ · raylib unless said): what is missing, its size, and which buttons work. */
export function sheetView(
  status: ToolchainStatus | null,
  job: ToolchainInstallJob | null,
  targets: readonly BuildTarget[],
  stack: CompiledStack = GameStack.RaylibCpp,
): SheetView {
  return INSTALLS_FROM_SHEET.has(stack) ? installView(status, job, targets) : readOnlyView(status, targets, stack);
}

/** The C++ sheet, whose tools Install fetches: what is missing, its size, and which buttons work. */
function installView(
  status: ToolchainStatus | null,
  job: ToolchainInstallJob | null,
  targets: readonly BuildTarget[],
): SheetView {
  const stack = GameStack.RaylibCpp;
  const missing = status ? missingFor(status, targets) : null;
  const components = missing?.components ?? [];
  const downloads = status?.downloads ?? [];
  const missingRows = components.map((id) => rowOf(status, id));
  const notYet = waitingOnDownloads(status, targets, missingRows);
  const rows = listedRows(status, targets, missingRows, notYet);
  const unavailable = rows.filter((row) => !row.download).map((row) => row.id);
  const prewarm = prewarmRows(status, targets);
  const covered = status !== null && lockCovers(status, targets, stack);
  const need = status
    ? diskNeed(
        status,
        rows.map((row) => row.id),
      )
    : 0;
  const free = status?.freeBytes ?? null;
  const hasDiskFacts = need > 0 && free !== null;
  const nothingToInstall = components.length === 0 && covered && prewarm.length === 0;
  const installable = status !== null && someInstallable(status, targets);
  const retry = job?.phase === ToolchainInstallPhase.Failed || job?.phase === ToolchainInstallPhase.Cancelled;
  return {
    components,
    rows,
    unavailable,
    unpinned: rows.filter((row) => !row.download && !row.unhosted).length,
    notYet,
    prewarm,
    setUpAgain: prewarm.length > 0 && rows.every((row) => !row.download),
    downloads,
    need,
    disk: hasDiskFacts ? { need, free } : null,
    cltMissing: missing?.clt ?? false,
    ready: Boolean(status?.host) && missing !== null && !missing.clt && nothingToInstall,
    canInstall: Boolean(status?.host) && !isInstallRunning(job) && !nothingToInstall && installable,
    retry,
    stack,
    installsHere: true,
    keptPreRust: [],
  };
}

/** One of Apple's prerequisites as the sheet lists it. */
export interface PrerequisiteRow {
  prerequisite: SetupPrerequisite;
  present: boolean;
  version: string | null;
  /** Present only inside another prerequisite (the Command Line Tools inside Xcode). */
  providedBy: SetupPrerequisite | null;
}

/**
 * Apple's prerequisites the sheet lists for a `stack` game on this computer: none off a Mac. A C++
 * game lists the Command Line Tools; a Rust game lists them (Xcode's copy counts for a Mac build)
 * and Xcode itself, which iPhone and iPad builds need.
 */
export function prerequisiteRows(status: ToolchainStatus, stack: CompiledStack): PrerequisiteRow[] {
  if (status.host !== ToolchainHost.MacArm64) return [];
  const { clt } = status;
  if (stack === GameStack.RaylibCpp)
    return [{ prerequisite: SetupPrerequisite.Clt, present: clt.present, version: clt.version, providedBy: null }];
  const xcode = status.xcode ?? { present: false, version: null };
  const viaXcode = !clt.present && xcode.present;
  return [
    {
      prerequisite: SetupPrerequisite.Clt,
      present: clt.present || xcode.present,
      version: clt.version,
      providedBy: viaXcode ? SetupPrerequisite.Xcode : null,
    },
    { prerequisite: SetupPrerequisite.Xcode, present: xcode.present, version: xcode.version, providedBy: null },
  ];
}

/** A prerequisite row's name and its line: installed (with its version), inside Xcode, or why it is needed. */
export function prerequisiteWords(row: PrerequisiteRow, stack: CompiledStack): { name: string; detail: string } {
  if (row.prerequisite === SetupPrerequisite.Xcode) {
    const words = TOOLCHAIN_WORDS.xcode;
    return { name: words.name, detail: row.present ? words.present(row.version) : words.missing };
  }
  const words = TOOLCHAIN_WORDS.clt;
  if (row.providedBy === SetupPrerequisite.Xcode) return { name: words.name, detail: words.viaXcode };
  if (row.present) return { name: words.name, detail: words.present(row.version) };
  return { name: words.name, detail: stack === GameStack.RaylibCpp ? words.missing : words.missingOrXcode };
}

/** The sheet's title, intro and unsupported-computer line for a `stack` game. */
export function sheetWords(stack: CompiledStack): { title: string; intro: string; unsupportedHost: string } {
  return TOOLCHAIN_WORDS.forStack[stack];
}

/**
 * The lines a Rust · wgpu sheet adds under its rows: that this version does not download Rust tools
 * (while any is missing), and the harness parts a Rust night refuses. Nothing for a C++ sheet.
 */
export function rustSheetLines(view: SheetView): string[] {
  if (view.installsHere) return [];
  const words = TOOLCHAIN_WORDS.rust;
  return [
    ...(view.ready ? [] : [words.notInstalledHere]),
    ...(view.keptPreRust.length > 0 ? [words.keptTitle, words.keptIntro] : []),
  ];
}

/**
 * Whether Live should build again now: the sheet it opened has just reached Ready and has not asked
 * yet in this opening (`retried`). Live does not wait for the sheet to close, and asks once.
 */
export function liveRetryDue(view: SheetView, retried: boolean): boolean {
  return view.ready && !retried;
}

/**
 * What Settings → Toolchains lists as not available yet: the parts Genex has pinned but not
 * published that this computer's own games need (Browser and its own OS), each with why.
 */
export function unhostedHere(
  status: ToolchainStatus,
  host: StudioPlatform | null,
): Array<{ id: ToolchainId; reason: ToolchainUnhosted }> {
  const targets = host ? [BuildTarget.Web, hostTarget(host)] : [BuildTarget.Web];
  const needed = new Set<ToolchainId>(targets.flatMap((target) => REQUIRED_COMPONENTS[target]));
  return (status.unhosted ?? []).filter((item) => needed.has(item.id));
}

/** Why a phone's install is not offered. Names of nothing on the wire. */
export const PhoneBlock = {
  /** iPhone builds need Xcode 26 or later with the iOS 26 SDK. */
  Xcode: "xcode",
  /** No Android SDK where the person keeps one. */
  SdkMissing: "sdk-missing",
  /** The person has not accepted the Android SDK licence. */
  Licence: "licence",
  /** A part the store installs has no published download yet. */
  NotPublished: "not-published",
} as const;
export type PhoneBlock = (typeof PhoneBlock)[keyof typeof PhoneBlock];

/** One part a phone's builds need, as the sheet lists it. */
export interface PhoneRow {
  id: ToolchainId;
  /** The person installs it with the Android SDK, under its licence; the store never downloads it. */
  personSide: boolean;
  state: UserSideState;
  /** The store's pinned download of it for this computer, or null. */
  download: ToolchainDownload | null;
}

/** What the sheet shows for one phone. */
export interface PhoneView {
  target: MobileBuildTarget;
  rows: PhoneRow[];
  /** The Xcode probe's status for the iPhone; null for Android. */
  xcode: XcodeStatus | null;
  /** The licence control: offered for a found SDK whose licence the person has not accepted. */
  licence: { offered: boolean; accepted: boolean };
  /** Everything the phone's builds need is here. */
  ready: boolean;
  /** Install works now: nothing blocks it, something is missing and no install runs. */
  canInstall: boolean;
  /** Why Install is not offered, first reason first; null when nothing blocks it. */
  block: PhoneBlock | null;
}

const isPersonSide = (id: ToolchainId): id is UserSideComponent => USER_SIDE_COMPONENTS.includes(id);

/** A part's row: a person-side part as the SDK probe found it, a store part installed or missing. */
function phoneRowOf(status: ToolchainStatus, id: ToolchainId): PhoneRow {
  const download = status.downloads?.find((item) => item.id === id) ?? null;
  if (isPersonSide(id)) {
    const state = status.android?.parts[id] ?? UserSideState.Missing;
    return { id, personSide: true, state, download: null };
  }
  const installed = status.installed.some((item) => item.id === id);
  return { id, personSide: false, state: installed ? UserSideState.Ready : UserSideState.Missing, download };
}

/** Whether the store can fetch every store part `rows` still lacks. */
const storePartsDownloadable = (rows: readonly PhoneRow[]): boolean =>
  rows.every((row) => row.personSide || row.state === UserSideState.Ready || row.download !== null);

/** The first reason a phone's install is not offered, or null. */
function phoneBlock(target: MobileBuildTarget, status: ToolchainStatus, rows: readonly PhoneRow[]): PhoneBlock | null {
  if (target === BuildTarget.Ios) {
    if (status.xcode?.status !== XcodeStatus.Ready) return PhoneBlock.Xcode;
  } else {
    if (status.android?.sdk !== true) return PhoneBlock.SdkMissing;
    if (!status.android.licenceAccepted) return PhoneBlock.Licence;
  }
  return storePartsDownloadable(rows) ? null : PhoneBlock.NotPublished;
}

/** One phone's view over the status. */
function phoneViewOf(target: MobileBuildTarget, status: ToolchainStatus): PhoneView {
  const rows = RUST_MOBILE_COMPONENTS[target].map((id) => phoneRowOf(status, id));
  const block = phoneBlock(target, status, rows);
  const android = status.android;
  const accepted = target === BuildTarget.Android && android?.licenceAccepted === true;
  const offered = target === BuildTarget.Android && android?.sdk === true && !accepted;
  const partsReady = rows.every((row) => row.state === UserSideState.Ready);
  const ready = partsReady && (block === null || block === PhoneBlock.NotPublished);
  return {
    target,
    rows,
    xcode: target === BuildTarget.Ios ? (status.xcode?.status ?? XcodeStatus.Absent) : null,
    licence: { offered, accepted },
    ready,
    canInstall: !ready && block === null && !isInstallRunning(status.job),
    block,
  };
}

/**
 * The phones a `stack` game's sheet lists on this computer: a Rust game's iPhone on a Mac (its
 * builds need Xcode), and its Android where the host probed the person's SDK. None for a C++ game,
 * whose phones are not destinations, or a computer with no pinned toolchain.
 */
export function phoneViews(status: ToolchainStatus, stack: CompiledStack): PhoneView[] {
  if (stack !== GameStack.RustWgpu || status.host === null) return [];
  const targets: MobileBuildTarget[] = [];
  if (status.host === ToolchainHost.MacArm64) targets.push(BuildTarget.Ios);
  if (status.android) targets.push(BuildTarget.Android);
  return targets.map((target) => phoneViewOf(target, status));
}

/** The version each person-side part is pinned at, for its row. */
const PERSON_SIDE_PIN = {
  [ToolchainId.AndroidSdk]: ANDROID_PINS.platform,
  [ToolchainId.AndroidBuildTools]: `${ANDROID_PINS.buildToolsMajor}.x`,
  [ToolchainId.AndroidNdk]: ANDROID_PINS.ndk,
} as const satisfies Record<UserSideComponent, string>;

/** A phone row's name and its line: a store part's size or that it is in, a person-side part's state against its pin. */
export function phoneRowWords(row: PhoneRow): { name: string; detail: string } {
  const name = TOOLCHAIN_WORDS.component[row.id];
  const words = TOOLCHAIN_WORDS.phones;
  if (isPersonSide(row.id)) return { name, detail: words.userSide[row.state](PERSON_SIDE_PIN[row.id]) };
  if (row.state === UserSideState.Ready) return { name, detail: words.installed };
  return { name, detail: sizeWords(row.download) };
}

/** Why a phone's install is not offered, in the sheet's words: Xcode's own line for the iPhone. */
export function phoneBlockWords(view: PhoneView): string | null {
  const words = TOOLCHAIN_WORDS.phones;
  switch (view.block) {
    case null:
      return null;
    case PhoneBlock.Xcode:
      return words.xcode[view.xcode ?? XcodeStatus.Absent];
    case PhoneBlock.SdkMissing:
      return words.sdkMissing;
    case PhoneBlock.Licence:
      return words.licenceNeeded;
    case PhoneBlock.NotPublished:
      return words.notPublished;
  }
}
