/**
 * A publish's apps: the Mac, Windows and Linux builds in the game folder, sent with `genex native publish`
 * once the web build is public. Each goes on its own, and one that fails is said on its row: it never
 * fails the publish, whose web build is already live. Studio's dialog names the builds by their place
 * in the game folder; that folder is written by agents, so each is resolved here by its real path and
 * sent only from inside the folder.
 */
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
// Read at build time: the packaged app ships the CLI only inside the Genex plugin's payload, so a
// look-up at run time from the app's own bundle finds nothing and no app would ever be sent.
import cliPackage from "@genex-ai/cli-demo/package.json" with { type: "json" };
import {
  GenexBuildReview,
  type GenexNativeFailure,
  type GenexNativeListing,
  type GenexNativeSent,
  GenexListingState,
} from "../../shared/genex.ts";
import { linuxBuildOf } from "../../shared/publish-platforms.ts";

/** The first Genex CLI with `genex native`: an older pin sends no app. */
const NATIVE_CLI = [1, 36, 11] as const;
/** The most apps one publish sends: a Mac app, a Windows program and a Linux one, each at most twice over. */
const NATIVE_UPLOADS_MAX = 6;
/** What a failure keeps of the CLI's words. */
const FAILURE_CHARS = 400;
/** The most of Genex's words on a turned-down app kept. */
const REVIEW_REASON_CHARS = 400;

/** How much of an app's archive hash a clip names as its build: the most `genex cover --commit` takes. */
const CLIP_COMMIT_CHARS = 40;
/** A sha256 as hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

const MESSAGE = { NotABuild: "Genex answered without the build it published" } as const;

/**
 * Whether CLI `version` has `genex native`. A prerelease comes before its release (`1.36.11-dev.4`
 * may predate the command), so only a later release's prerelease counts.
 */
export function hasNativeCommand(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (const [at, wanted] of NATIVE_CLI.entries()) {
    const part = parts[at] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return match[4] === undefined;
}

/** Whether the CLI Studio ships, the version this build pins, can send apps. */
export const pinnedCliSendsApps = (): boolean => hasNativeCommand(cliPackage.version);

/**
 * One app to send: what the CLI is handed (a `.app`, or a Windows or Linux program's folder), its
 * platform and, for Linux, the program inside that folder (the CLI cannot tell it from the files).
 */
export interface NativeUpload {
  target: string;
  platform: "mac" | "windows" | "linux";
  entry?: string;
}

/** The CLI's words for one upload: `genex native publish <target>`, and a Linux build's platform and program. */
export const nativePublishArgs = (upload: NativeUpload): string[] => [
  "native",
  "publish",
  upload.target,
  ...(upload.platform === "linux" && upload.entry ? ["--platform", "linux", "--entry", upload.entry] : []),
];

/** A 64-bit ELF program's first bytes. */
const ELF_MAGIC = "\x7fELF";

/** Whether `entry` is a plain path inside a folder: relative, no `..`, no empty part. */
const isPlainEntry = (entry: string): boolean =>
  !path.isAbsolute(entry) && entry.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");

/** `entry` of the game folder as the CLI takes it, or null when it is not a build inside the folder. */
async function uploadOf(base: string, entry: string): Promise<NativeUpload | null> {
  if (!isPlainEntry(entry)) return null;
  const real = await realpath(path.join(base, entry)).catch(() => null);
  if (!real?.startsWith(base + path.sep)) return null;
  const info = await lstat(real).catch(() => null);
  const lower = real.toLowerCase();
  if (lower.endsWith(".app") && info?.isDirectory()) return { target: real, platform: "mac" };
  // A Windows program is sent with its folder: the game's data sits beside it.
  if (lower.endsWith(".exe") && info?.isFile() && path.dirname(real) !== base)
    return { target: path.dirname(real), platform: "windows" };
  if (info?.isFile() && (await isElf(real))) return linuxUpload(base, real);
  return null;
}

/** Whether `file` starts as an ELF program does. */
async function isElf(file: string): Promise<boolean> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && buffer.toString("latin1") === ELF_MAGIC;
  } finally {
    await handle.close();
  }
}

/** A Linux program inside `base` as the CLI takes it: its build's folder, and the program inside that. */
function linuxUpload(base: string, real: string): NativeUpload | null {
  const build = linuxBuildOf(path.relative(base, real).split(path.sep).join("/"));
  if (!build) return null;
  return { target: path.join(base, ...build.folder.split("/")), platform: "linux", entry: build.entry };
}

/**
 * The apps among `entries` (the dialog's builds, relative to the game folder `directory`) that are
 * real builds inside it, each once. Anything else is dropped: a link out of the folder, a path with
 * `..`, a file that is not a program, a program at the folder's root (its folder would be the game).
 * A Linux program is known by its ELF header, and goes with its build's folder (`linuxBuildOf`).
 */
export async function nativeUploads(directory: string, entries: unknown): Promise<NativeUpload[]> {
  if (!Array.isArray(entries)) return [];
  const base = await realpath(directory).catch(() => null);
  if (!base) return [];
  const uploads: NativeUpload[] = [];
  for (const entry of entries.slice(0, NATIVE_UPLOADS_MAX)) {
    if (typeof entry !== "string") continue;
    const upload = await uploadOf(base, entry);
    const known = (sent: NativeUpload) => sent.target === upload?.target && sent.platform === upload.platform;
    if (upload && !uploads.some(known)) uploads.push(upload);
  }
  return uploads;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The build `genex native publish --json` says it published, or null when its answer names none. */
export function sentBuild(answer: unknown): GenexNativeSent | null {
  const build = isRecord(answer) ? answer.build : undefined;
  if (!isRecord(build)) return null;
  const { platform, arch, version, sizeBytes, sha256, publishedAt } = build;
  const words = [platform, arch, version, publishedAt].every((value) => typeof value === "string");
  if (!words || typeof sizeBytes !== "number") return null;
  return {
    platform: String(platform),
    arch: String(arch),
    version: String(version),
    sizeBytes,
    ...(typeof sha256 === "string" && SHA256_HEX.test(sha256) ? { sha256: sha256.toLowerCase() } : {}),
    publishedAt: String(publishedAt),
    ...reviewOf(build),
  };
}

const REVIEWS: ReadonlySet<unknown> = new Set(Object.values(GenexBuildReview));

/** Genex's review of a sent build, as the API answers it beside the build; nothing for an unknown one. */
function reviewOf(build: Record<string, unknown>): Pick<GenexNativeSent, "review" | "reviewReason"> {
  if (!REVIEWS.has(build.review)) return {};
  const review = build.review as GenexBuildReview;
  const reason = typeof build.reviewReason === "string" ? build.reviewReason.trim() : "";
  return reason ? { review, reviewReason: reason.slice(0, REVIEW_REASON_CHARS) } : { review };
}

/**
 * The listing as it stands for players: a game Genex lists with an app it still reviews shows nowhere
 * until that app is approved, so its listing is held. Genex answers the listing beside the build.
 */
function listingForPlayers(listing: GenexNativeListing | undefined, sent: GenexNativeSent | null) {
  const waiting = listing?.state === GenexListingState.Published && sent?.review === GenexBuildReview.Pending;
  return waiting ? { state: GenexListingState.Held, detail: null } : listing;
}

/**
 * The build a clip of a game with only apps names (`genex cover --commit`): the start of the first
 * sent app's archive hash, which Genex matches as a prefix. Undefined when no sent app has one.
 */
export function appClipCommit(sent: readonly GenexNativeSent[]): string | undefined {
  const hash = sent.map((app) => app.sha256).find((value) => typeof value === "string" && SHA256_HEX.test(value));
  return hash?.slice(0, CLIP_COMMIT_CHARS);
}

/** The CLI's own words for a failure: its last `✗` line, else its last line, kept short. */
function failureWords(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const marked = lines.filter((line) => line.startsWith("✗")).at(-1);
  return (marked ?? lines.at(-1) ?? "").replace(/^✗\s*/, "").slice(0, FAILURE_CHARS);
}

const LISTING_STATES: ReadonlySet<unknown> = new Set(Object.values(GenexListingState));
/** The most of Genex's words on a held or refused listing kept. */
const LISTING_DETAIL_CHARS = 400;

/** Genex's answer to the listing a `--gallery` publish asked for, or undefined when it gave none. */
export function listingOf(answer: unknown): GenexNativeListing | undefined {
  const listing = isRecord(answer) ? answer.listing : undefined;
  if (!isRecord(listing) || !LISTING_STATES.has(listing.state)) return undefined;
  const detail = typeof listing.detail === "string" ? listing.detail.slice(0, LISTING_DETAIL_CHARS) : null;
  return { state: listing.state as GenexNativeListing["state"], detail };
}

/** What became of one app, and of the listing it carried. */
export type NativeOutcome = ({ sent: GenexNativeSent } | { failed: GenexNativeFailure }) & {
  listing?: GenexNativeListing;
};

/** Send one app with `send` (the CLI run), as an outcome: a failure is kept, never thrown. */
export async function sendNativeBuild(
  upload: NativeUpload,
  send: (target: string) => Promise<unknown>,
): Promise<NativeOutcome> {
  try {
    const answer = await send(upload.target);
    const sent = sentBuild(answer);
    const listing = listingForPlayers(listingOf(answer), sent);
    const listed = listing ? { listing } : {};
    if (sent) return { sent, ...listed };
    return { failed: { platform: upload.platform, arch: "", error: MESSAGE.NotABuild }, ...listed };
  } catch (error) {
    return { failed: { platform: upload.platform, arch: "", error: failureWords(error) } };
  }
}
