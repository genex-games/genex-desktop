/**
 * Native builds of a Play game: a Mac app, a Windows program or a Linux one the author built in Unity,
 * Godot or Unreal, which Genex installs and runs in its own window. This is the app's copy of the draft
 * contract genex.games serves (`docs/play.md`, "Native builds"): every field is optional on the
 * wire, and a game the API says nothing new about stays today's web game. Browser-safe: main parses
 * the API's answers with it and the renderer reads the same shapes.
 */

/** The systems a build runs on, in the API's spelling. Wire values: never rename one. */
export const NativePlatform = { Mac: "mac", Windows: "windows", Linux: "linux" } as const;
export type NativePlatform = (typeof NativePlatform)[keyof typeof NativePlatform];

/** A build's processor architecture; `universal` is a Mac app with both. Wire values: never rename one. */
export const NativeArch = { Arm64: "arm64", X64: "x64", Universal: "universal" } as const;
export type NativeArch = (typeof NativeArch)[keyof typeof NativeArch];

/** The platforms in the order cards and pages list them. */
export const NATIVE_PLATFORMS: readonly NativePlatform[] = Object.values(NativePlatform);

/**
 * Where Genex can run a native game: the Mac (Seatbelt), Linux (bubblewrap) and Windows (an
 * AppContainer of the game's own, `substrate/plugins/windows-game.ts`). No game runs outside one.
 */
const LAUNCH_PLATFORMS: ReadonlySet<NativePlatform> = new Set([
  NativePlatform.Mac,
  NativePlatform.Linux,
  NativePlatform.Windows,
]);

/**
 * The hosts a build archive downloads from: genex.games' CDN, which already serves Play's covers
 * and clips. Matched by exact name, so a game's own `<slug>.genex.technology` site never hands out
 * an app. Until the API lists builds there, no row survives and Play stays as it is.
 */
export const NATIVE_BUILD_HOSTS: ReadonlySet<string> = new Set(["cdn.genex.technology"]);

/**
 * The build host of a fixture launch's made-up games. `.invalid` never resolves, and a fixture
 * launch serves these archives from its own files, so no socket opens.
 */
export const FIXTURE_BUILD_HOST = "builds.genex.invalid";
/** The hosts a fixture launch's builds come from. */
export const FIXTURE_BUILD_HOSTS: ReadonlySet<string> = new Set([FIXTURE_BUILD_HOST]);

/** The largest archive the app downloads (32 GiB), and the largest unpacked game it installs (64 GiB). */
export const NATIVE_ARCHIVE_MAX_BYTES = 32 * 1024 ** 3;
export const NATIVE_INSTALL_MAX_BYTES = 64 * 1024 ** 3;
/** The most build rows one game keeps. */
export const NATIVE_BUILDS_MAX = 8;
/** The longest version and entry the app keeps. */
const VERSION_MAX = 64;
const ENTRY_MAX = 255;
/** The most folders a Windows entry may sit in. */
const ENTRY_DEPTH_MAX = 4;

/** One build of a game for one platform and architecture, as the API serves it. */
export interface NativeBuild {
  platform: NativePlatform;
  arch: NativeArch;
  /** The author's build id: what an update compares. */
  version: string;
  /** The archive's size: what the download is. */
  sizeBytes: number;
  /** The unpacked size: what the disk check asks for before the download starts. */
  installedBytes: number;
  /** The archive's sha256, lowercase hex: checked before anything is unpacked. */
  sha256: string;
  /** The archive's https address on a build host. */
  url: string;
  /** What runs, relative to the archive's root: `Dust Runners.app`, `Dust Runners/DustRunners.exe`. */
  entry: string;
  /** The oldest system it runs on: `13.0` (macOS), `10.0.19041` (Windows). */
  minOs?: string;
  /** When it was published, ISO 8601. */
  publishedAt: string;
}

/** The engines the catalog names a native build's game by: what Play opens full screen in each one's own way. */
export const NativeEngine = { Unity: "unity", Godot: "godot", Unreal: "unreal" } as const;
export type NativeEngine = (typeof NativeEngine)[keyof typeof NativeEngine];

/** What a game adds once the API names native builds for it. */
export interface PlayNative {
  /** It also has a web build: a card press plays that, and the native app is offered beside it. */
  web: boolean;
  /** The engine it was made with, as an engine id (`unity`, `godot`, `unreal`), or null. */
  engine: string | null;
  /** Its builds the app accepted; empty when every row was refused. */
  builds: NativeBuild[];
}

/** The computer a game would run on. */
export interface NativeHost {
  platform: NativePlatform;
  arch: typeof NativeArch.Arm64 | typeof NativeArch.X64;
  /** The system's version, dotted (`15.1`). */
  osVersion: string;
  /** An Apple silicon Mac that runs Intel apps (Rosetta is installed). */
  rosetta?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PLATFORMS: ReadonlySet<unknown> = new Set(NATIVE_PLATFORMS);
const ARCHES: ReadonlySet<unknown> = new Set(Object.values(NativeArch));
/** Whether a value names a platform. */
export const isNativePlatform = (value: unknown): value is NativePlatform => PLATFORMS.has(value);
/** Whether a value names an architecture. */
export const isNativeArch = (value: unknown): value is NativeArch => ARCHES.has(value);

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const OS_VERSION = /^\d{1,4}(\.\d{1,6}){0,3}$/;
const ENGINE = /^[a-z][a-z0-9-]{1,39}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const UNSAFE_ENTRY_CHARACTER = /[\0-\x1f\x7f\\:*?"<>|]/;

/** A size the wire may name: a whole number of bytes above zero, at most `max`. */
const isSize = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;

/** An https address on one of `hosts`, with no port and no credentials, else null. */
function buildUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain && hosts.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether `entry` stays inside the archive, spelled plainly: `/`-separated, no absolute path, drive,
 * backslash or control character, and no empty, `.` or `..` part.
 */
function isPlainEntry(entry: string): boolean {
  if (entry.length > ENTRY_MAX || entry.startsWith("/") || UNSAFE_ENTRY_CHARACTER.test(entry)) return false;
  return entry.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Whether `entry` is what `platform` launches: a Mac app bundle at the archive's root, a Windows `.exe`. */
function entryRunsOn(platform: NativePlatform, entry: string): boolean {
  if (!isPlainEntry(entry)) return false;
  const parts = entry.split("/");
  if (platform === NativePlatform.Mac) return parts.length === 1 && entry.toLowerCase().endsWith(".app");
  if (platform === NativePlatform.Windows)
    return parts.length <= ENTRY_DEPTH_MAX && entry.toLowerCase().endsWith(".exe");
  return parts.length <= ENTRY_DEPTH_MAX;
}

/** Whether `arch` exists for `platform`: only a Mac app is universal. */
const archOn = (platform: NativePlatform, arch: NativeArch): boolean =>
  arch !== NativeArch.Universal || platform === NativePlatform.Mac;

/** A date the wire names, as ISO 8601, or null. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** What a row builds: its platform, architecture, version and entry, when each is one the app accepts. */
function identityOf(
  value: Record<string, unknown>,
): Pick<NativeBuild, "platform" | "arch" | "version" | "entry"> | null {
  const { platform, arch, version, entry } = value;
  if (!isNativePlatform(platform) || !isNativeArch(arch) || !archOn(platform, arch)) return null;
  if (typeof version !== "string" || version.length > VERSION_MAX || !VERSION.test(version)) return null;
  if (typeof entry !== "string" || !entryRunsOn(platform, entry)) return null;
  return { platform, arch, version, entry };
}

/** One build row, or null when anything in it is off. */
function parseBuild(value: unknown, hosts: ReadonlySet<string>): NativeBuild | null {
  if (!isRecord(value)) return null;
  const identity = identityOf(value);
  const { minOs, sizeBytes, installedBytes } = value;
  if (!identity) return null;
  if (!isSize(sizeBytes, NATIVE_ARCHIVE_MAX_BYTES) || !isSize(installedBytes, NATIVE_INSTALL_MAX_BYTES)) return null;
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  const url = buildUrl(value.url, hosts);
  const publishedAt = isoDate(value.publishedAt);
  if (!SHA256.test(sha256) || !url || !publishedAt) return null;
  if (minOs !== undefined && (typeof minOs !== "string" || !OS_VERSION.test(minOs))) return null;
  return {
    ...identity,
    sizeBytes,
    installedBytes,
    sha256,
    url,
    ...(typeof minOs === "string" ? { minOs } : {}),
    publishedAt,
  };
}

/**
 * A game's build rows as the API serves them: each one kept only when every field is sane and its
 * archive is on one of `hosts`, one per platform and architecture (the first), at most
 * {@link NATIVE_BUILDS_MAX}. Anything that is not a list is no builds.
 */
export function parseNativeBuilds(value: unknown, hosts: ReadonlySet<string>): NativeBuild[] {
  if (!Array.isArray(value)) return [];
  const builds: NativeBuild[] = [];
  const seen = new Set<string>();
  for (const row of value.slice(0, NATIVE_BUILDS_MAX * 4)) {
    const build = parseBuild(row, hosts);
    const key = build ? `${build.platform}/${build.arch}` : "";
    if (!build || seen.has(key)) continue;
    seen.add(key);
    builds.push(build);
    if (builds.length === NATIVE_BUILDS_MAX) break;
  }
  return builds;
}

/**
 * What a gallery item says about its native side, or undefined for an item that names no builds:
 * today's web game. A game whose rows were all refused keeps an empty list, so a native-only game is
 * never mistaken for a web one.
 */
export function nativeOf(item: Record<string, unknown>, hosts: ReadonlySet<string>): PlayNative | undefined {
  if (!Array.isArray(item.builds) || item.builds.length === 0) return undefined;
  const engine = typeof item.engine === "string" ? item.engine.toLowerCase() : "";
  return {
    web: item.web !== false,
    engine: ENGINE.test(engine) ? engine : null,
    builds: parseNativeBuilds(item.builds, hosts),
  };
}

/** Anything that may carry a native side: a card, a game's page. */
interface WithNative {
  native?: PlayNative;
}

/** Whether a game has a web build: every game the API names no builds for, and a native one that says so. */
export const hasWebBuild = (game: WithNative): boolean => game.native?.web !== false;

/** The platforms a game was built for, in {@link NATIVE_PLATFORMS} order; none for a web-only game. */
export function platformsOf(game: WithNative): NativePlatform[] {
  const built = new Set(game.native?.builds.map((build) => build.platform));
  return NATIVE_PLATFORMS.filter((platform) => built.has(platform));
}

/** `a` against `b`, dotted system versions compared number by number (`13` equals `13.0`). */
export function compareOsVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Whether Genex launches native games on `host` at all. */
export const launchesOn = (host: NativeHost): boolean => LAUNCH_PLATFORMS.has(host.platform);

/**
 * Whether `host` meets a build's minimum system. A Linux build's minimum is the C library it was
 * linked against, which the kernel's release says nothing about, so Linux has none to meet.
 */
const runsOn = (build: NativeBuild, host: NativeHost): boolean =>
  !build.minOs || host.platform === NativePlatform.Linux || compareOsVersions(host.osVersion, build.minOs) >= 0;

/** Whether `host` runs an Intel-only Mac app: an Apple silicon Mac with Rosetta. */
const translatesIntel = (host: NativeHost): boolean => host.arch === NativeArch.Arm64 && host.rosetta === true;

/**
 * The build this computer installs, or null: this platform's build for its own architecture first,
 * then a universal Mac app, then (an Apple silicon Mac with Rosetta) an Intel-only one, each only
 * where its minimum system is met. Nothing is offered where Genex cannot launch a game yet.
 */
export function buildFor(builds: readonly NativeBuild[], host: NativeHost): NativeBuild | null {
  if (!launchesOn(host)) return null;
  const fits = builds.filter((build) => build.platform === host.platform && runsOn(build, host));
  const own = fits.find((build) => build.arch === host.arch);
  const universal = fits.find((build) => build.arch === NativeArch.Universal);
  const intel = translatesIntel(host) ? fits.find((build) => build.arch === NativeArch.X64) : undefined;
  return own ?? universal ?? intel ?? null;
}

/** Why no build of a game installs on this computer. Wire-free: only the game page's words read it. */
export const WhyNotHere = {
  /** Genex launches no native game on this system (Windows). */
  System: "system",
  /** No build was made for this system. */
  NoBuild: "no-build",
  /** Its builds for this system ask for a newer one. */
  OldSystem: "old-system",
  /** Its Mac builds are for Apple silicon only, and this Mac is an Intel one. */
  AppleSilicon: "apple-silicon",
  /** Its only Mac builds are for Intel, and this Apple silicon Mac has no Rosetta. */
  Rosetta: "rosetta",
  /** Its builds for this system are for another processor. */
  Processor: "processor",
} as const;
export type WhyNotHere = (typeof WhyNotHere)[keyof typeof WhyNotHere];

/** Why nothing installs here, with what its words name: where it plays instead, the system it needs. */
export type NotHere =
  | { why: typeof WhyNotHere.System; elsewhere: NativePlatform[] }
  | { why: typeof WhyNotHere.OldSystem; minOs: string }
  | { why: Exclude<WhyNotHere, typeof WhyNotHere.System | typeof WhyNotHere.OldSystem> };

/** Whether `host`'s processor runs a build: its own, a universal Mac app, or Intel through Rosetta. */
const archFits = (build: NativeBuild, host: NativeHost): boolean =>
  build.arch === host.arch ||
  build.arch === NativeArch.Universal ||
  (build.arch === NativeArch.X64 && translatesIntel(host));

/** The reason this processor runs none of a Mac's or Linux computer's builds. */
function wrongChip(host: NativeHost): NotHere {
  if (host.platform !== NativePlatform.Mac) return { why: WhyNotHere.Processor };
  return { why: host.arch === NativeArch.X64 ? WhyNotHere.AppleSilicon : WhyNotHere.Rosetta };
}

/** The lowest system any of `builds` asks for. */
const lowestMinOs = (builds: readonly NativeBuild[]): string =>
  builds
    .map((build) => build.minOs ?? "")
    .sort(compareOsVersions)
    .at(0) ?? "";

/**
 * Why `builds` offer this computer nothing (`buildFor` is null), or null when one installs: the
 * system first (and where Genex plays it instead), then no build for it, then the processor, then
 * the system's version.
 */
export function whyNotHere(builds: readonly NativeBuild[], host: NativeHost): NotHere | null {
  if (buildFor(builds, host)) return null;
  if (!launchesOn(host)) {
    const built = new Set(builds.map((build) => build.platform));
    const elsewhere = NATIVE_PLATFORMS.filter((platform) => built.has(platform) && LAUNCH_PLATFORMS.has(platform));
    return { why: WhyNotHere.System, elsewhere };
  }
  const forHere = builds.filter((build) => build.platform === host.platform);
  if (forHere.length === 0) return { why: WhyNotHere.NoBuild };
  const fits = forHere.filter((build) => archFits(build, host));
  if (fits.length === 0) return wrongChip(host);
  return { why: WhyNotHere.OldSystem, minOs: lowestMinOs(fits) };
}

/** Whether a game plays on `host` at all: in the viewer, or as a build this computer installs. */
export const playableHere = (game: WithNative, host: NativeHost): boolean =>
  hasWebBuild(game) || buildFor(game.native?.builds ?? [], host) !== null;

/** Where an install stands. Wire values: never rename one. */
export const InstallPhase = {
  /** Waiting for the install before it: one runs at a time. */
  Queued: "queued",
  Downloading: "downloading",
  /** The archive's checksum is being checked. */
  Verifying: "verifying",
  /** The archive is being unpacked and the app inside checked. */
  Unpacking: "unpacking",
  Ready: "ready",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type InstallPhase = (typeof InstallPhase)[keyof typeof InstallPhase];

/** Why an install failed. Wire values: never rename one; the words for each are the renderer's. */
export const InstallFailure = {
  /** Not enough free space for the download and the unpacked game. */
  NoSpace: "no-space",
  /** The archive is not the one the catalog names. */
  Checksum: "checksum",
  /** The download could not reach the build host or lost it; the bytes so far are kept. */
  Network: "network",
  /** The download stopped moving. */
  Stalled: "stalled",
  /** The archive names a file outside itself, or links out of the game. */
  UnsafeArchive: "unsafe-archive",
  /** The app is not signed, not even ad hoc. */
  Unsigned: "unsigned",
  /** The archive or what it unpacks to is larger than the catalog says. */
  TooLarge: "too-large",
  /** The app is not built for this computer's processor or system. */
  UnsupportedOs: "unsupported-os",
  /** The app is for Intel only, and this Apple silicon Mac has no Rosetta to run it. */
  NeedsRosetta: "needs-rosetta",
  /** The archive does not hold the app the catalog names. */
  EntryMissing: "entry-missing",
  /** The catalog offers no build for this computer. */
  NotOffered: "not-offered",
  /** Anything else: a step that failed for a reason none of the above names. */
  Failed: "failed",
} as const;
export type InstallFailure = (typeof InstallFailure)[keyof typeof InstallFailure];

const FAILURES: ReadonlySet<unknown> = new Set(Object.values(InstallFailure));
/** Whether a value names an install failure. */
export const isInstallFailure = (value: unknown): value is InstallFailure => FAILURES.has(value);

/** A game installed on this computer, as Play shows it. */
export interface InstalledGame {
  slug: string;
  /** Its name and cover when it was installed, for Storage and notifications. */
  title: string;
  coverUrl: string | null;
  version: string;
  platform: NativePlatform;
  arch: NativeArch;
  /** The space its installed version takes, in bytes (saves not counted). */
  bytes: number;
  /** ISO 8601. */
  installedAt: string;
  /** The last time it was played here, ISO 8601, or null. */
  lastPlayedAt: string | null;
}

/** An install under way, or how the last one ended when it did not finish. */
export interface InstallProgress {
  slug: string;
  version: string;
  phase: InstallPhase;
  /** Bytes of the archive downloaded so far, and its whole size. */
  receivedBytes: number;
  totalBytes: number;
  /** About how long the download has left, or null while it is not known. */
  etaMs: number | null;
  /** Why it failed; null unless `phase` is failed. */
  failure: InstallFailure | null;
}

/** Every installed game and every install under way or failed (`studio:play.installs`, `UiEvent.PlayInstalls`). */
export interface NativeInstalls {
  installed: InstalledGame[];
  progress: InstallProgress[];
  /** This computer, where Genex installs and plays native games; null where it does not. */
  host: NativeHost | null;
}

/** No game installed and none installing, on a computer that plays no native game. */
export const NO_INSTALLS: NativeInstalls = { installed: [], progress: [], host: null };

/** Where a native game's session stands. Wire values: never rename one. */
export const NativeSessionPhase = {
  /** Its process started; its window has not appeared yet. */
  Starting: "starting",
  /** Its window is up: it is being played. */
  Running: "running",
  /** It could not start, or quit before its window appeared. */
  Failed: "failed",
} as const;
export type NativeSessionPhase = (typeof NativeSessionPhase)[keyof typeof NativeSessionPhase];

/** Why a native game did not start. Wire values: never rename one. */
export const LaunchFailure = {
  /** It is not installed on this computer. */
  NotInstalled: "not-installed",
  /** Its sandbox or its process could not start. */
  StartFailed: "start-failed",
  /** It quit before its window appeared. */
  QuitEarly: "quit-early",
} as const;
export type LaunchFailure = (typeof LaunchFailure)[keyof typeof LaunchFailure];

/** A native game being played in its own window, or one that failed to start. */
export interface NativeSession {
  slug: string;
  phase: NativeSessionPhase;
  /** When it started, ISO 8601: the page counts the minutes played from it. */
  startedAt: string;
  failure: LaunchFailure | null;
}

/** What the game page asks of a running game (`studio:play.session`). Wire values: never rename one. */
export const SessionAction = {
  /** Bring its window forward. */
  Show: "show",
  /** End it, and everything it started. */
  Quit: "quit",
} as const;
export type SessionAction = (typeof SessionAction)[keyof typeof SessionAction];

const SESSION_ACTIONS: ReadonlySet<unknown> = new Set(Object.values(SessionAction));
/** Whether a value names a session action. */
export const isSessionAction = (value: unknown): value is SessionAction => SESSION_ACTIONS.has(value);

/** What the viewer's bar offers for a web game's native app (canvas board "WebFirst"). Wire values: never rename one. */
export const NativeAppOffer = {
  /** Not on this computer: the pill installs it. */
  Install: "install",
  /** Installing: the pill shows how far it has come. */
  Installing: "installing",
  /** Installed: the pill plays it in its own window, and the viewer gives way. */
  Ready: "ready",
} as const;
export type NativeAppOffer = (typeof NativeAppOffer)[keyof typeof NativeAppOffer];

/** The bar's native-app pill: what it offers, for which system, its size and an install's progress. */
export interface PlayBarNative {
  offer: NativeAppOffer;
  platform: NativePlatform;
  /** The installed game's size (its download's while not installed). */
  bytes: number;
  /** How far an install has come, whole percent; 0 otherwise. */
  percent: number;
}

/** Whether an install is still going (queued, downloading, being checked or unpacked). */
export const installUnderWay = (progress: InstallProgress | undefined): progress is InstallProgress =>
  progress !== undefined &&
  progress.phase !== InstallPhase.Ready &&
  progress.phase !== InstallPhase.Failed &&
  progress.phase !== InstallPhase.Cancelled;

/**
 * What the viewer's bar offers for a web game's native app on this computer, or null: a native-only
 * game opens its page instead, and a game with no build here has nothing to offer.
 */
export function nativeAppOffer(
  game: { slug: string; native?: PlayNative },
  installs: NativeInstalls,
): PlayBarNative | null {
  if (!game.native?.web || !installs.host) return null;
  const build = buildFor(game.native.builds, installs.host);
  const installed = installs.installed.find((one) => one.slug === game.slug);
  if (!build && !installed) return null;
  const platform = installs.host.platform;
  const progress = installs.progress.find((one) => one.slug === game.slug);
  if (installUnderWay(progress)) {
    const percent = progress.totalBytes > 0 ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : 0;
    return {
      offer: NativeAppOffer.Installing,
      platform,
      bytes: build?.installedBytes ?? 0,
      percent: Math.min(100, percent),
    };
  }
  if (installed) return { offer: NativeAppOffer.Ready, platform, bytes: installed.bytes, percent: 0 };
  return { offer: NativeAppOffer.Install, platform, bytes: build?.installedBytes ?? 0, percent: 0 };
}

/** What a Play install's notice records: the game and the version (`CustomEvent.PlayInstall*`). */
export interface PlayInstallPayload {
  slug?: string;
  title?: string;
  version?: string;
  platform?: NativePlatform;
}
