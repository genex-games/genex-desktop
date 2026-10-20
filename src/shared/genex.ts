import type { AudioPlaybackEvidence } from "./audio-observation.ts";
import { type CaptureSource, type StillExposure, StillMimeType } from "./preview-contract.ts";

/** The bundled Genex plugin's id: the host's own Genex surfaces (its page, the promo) look it up by this. */
export const GENEX_PLUGIN_ID = "genex";
/** The Genex plugin's skill that teaches an agent to write a Genex plugin (`plugins_find` names it). */
export const GENEX_PLUGIN_AUTHOR_SKILL = "plugin-author";

/**
 * The user actions the Genex plugin.json declares, as its panels, the Plugins page, the promo and
 * the toolbar send them. Wire values: never rename one.
 */
export const GenexAction = {
  Status: "status",
  AssetBadge: "asset-badge",
  Unlock: "unlock",
  Connect: "connect",
  Terms: "terms",
  /** Whether the signed-in account still has Genex's updated terms to accept: `{ pending }`. */
  TermsStatus: "terms-status",
  Disconnect: "disconnect",
  CancelConnect: "cancel-connect",
  Approve: "approve",
  PublishStatus: "publish-status",
  PublishDraft: "publish-draft",
  PublishGallery: "publish-gallery",
  /** Publish a game that has only apps, no web build: send them and list the game (`genex native publish --gallery`). */
  PublishApps: "publish-apps",
  PublishAllowUpload: "publish-allow-upload",
  PublishOpen: "publish-open",
  PublishBadge: "publish-badge",
  CoverAuto: "cover-auto",
  CoverPick: "cover-pick",
} as const;
export type GenexAction = (typeof GenexAction)[keyof typeof GenexAction];

/**
 * The Genex actions that belong to the person's account, not the agent's tools: signing in and
 * out, the account's status and terms, and Publish with its cover and clip. They run while the
 * Genex plugin is off.
 */
export const GENEX_ACCOUNT_ACTIONS: readonly GenexAction[] = [
  GenexAction.Status,
  GenexAction.Unlock,
  GenexAction.Connect,
  GenexAction.Terms,
  GenexAction.TermsStatus,
  GenexAction.Disconnect,
  GenexAction.CancelConnect,
  GenexAction.PublishStatus,
  GenexAction.PublishDraft,
  GenexAction.PublishGallery,
  GenexAction.PublishApps,
  GenexAction.PublishAllowUpload,
  GenexAction.PublishOpen,
  GenexAction.PublishBadge,
  GenexAction.CoverAuto,
  GenexAction.CoverPick,
];

/**
 * The Genex SDK packages a game may add, each at the exact version Studio installs. The agent names
 * a package; the version always comes from here. Multiplayer's card asks for `^0.16.0`.
 */
export const GENEX_GAME_PACKAGES = {
  "@genex-ai/multiplayer": "0.17.0",
  "@genex-ai/embed-sdk": "0.33.0",
} as const;
/** A Genex SDK package a game may add. */
export type GenexGamePackage = keyof typeof GENEX_GAME_PACKAGES;

/**
 * Where Studio's copy of `@genex-ai/embed-sdk` sits under a vendor folder (the app's, served as
 * `/vendor/`, and a published copy's `vendor/`), and the module beside it that connects a page to
 * Genex: a template game imports the SDK through its import map from there, and a published game
 * that brings no SDK of its own is connected by that module.
 */
export const GENEX_EMBED_VENDOR = {
  Sdk: "genex/embed-sdk",
  Entry: "genex/embed-sdk/index.js",
  Connect: "genex/connect.js",
} as const;

/**
 * Where Studio's copy of `@genex-ai/multiplayer` sits under the vendor folder: its entry and its
 * schema entry, built together so both share one copy of Colyseus's schema (a state class defined
 * with one is unknown to the other). A template game maps both in its import map.
 */
export const GENEX_MULTIPLAYER_VENDOR = {
  Dir: "genex/multiplayer",
  Entry: "genex/multiplayer/index.js",
  Schema: "genex/multiplayer/schema.js",
} as const;

/**
 * What a template game's import map maps for each package, at `/vendor`: the specifiers it imports
 * and Studio's copy of each. Multiplayer always brings player identity (`genexPackageSet`).
 */
export const GENEX_STUDIO_IMPORTS = {
  "@genex-ai/embed-sdk": { "@genex-ai/embed-sdk": `/vendor/${GENEX_EMBED_VENDOR.Entry}` },
  "@genex-ai/multiplayer": {
    "@genex-ai/multiplayer": `/vendor/${GENEX_MULTIPLAYER_VENDOR.Entry}`,
    "@genex-ai/multiplayer/schema": `/vendor/${GENEX_MULTIPLAYER_VENDOR.Schema}`,
  },
} as const satisfies Record<GenexGamePackage, Readonly<Record<string, string>>>;

/** The packages a request installs: multiplayer always brings its player-identity dependency. */
export function genexPackageSet(name: GenexGamePackage): GenexGamePackage[] {
  return name === "@genex-ai/multiplayer" ? [name, "@genex-ai/embed-sdk"] : [name];
}

/** The import-map entries a template game needs for `name`, its dependency included. */
export function studioSdkImports(name: GenexGamePackage): Record<string, string> {
  return Object.assign({}, ...genexPackageSet(name).map((pkg) => GENEX_STUDIO_IMPORTS[pkg]));
}

/**
 * The packages an import map takes from Studio's copies: each whose specifiers all map exactly to
 * Studio's files. A Genex name mapped anywhere else (a CDN, the game's own file) turns nothing on.
 */
export function studioSdkPackages(imports: Readonly<Record<string, unknown>>): GenexGamePackage[] {
  return (Object.keys(GENEX_STUDIO_IMPORTS) as GenexGamePackage[]).filter((pkg) =>
    Object.entries(GENEX_STUDIO_IMPORTS[pkg]).every(
      ([specifier, url]) => Object.hasOwn(imports, specifier) && imports[specifier] === url,
    ),
  );
}
/** Whether a name is one of those packages: an own key, never an inherited one. */
export function isGenexGamePackage(name: unknown): name is GenexGamePackage {
  return typeof name === "string" && Object.hasOwn(GENEX_GAME_PACKAGES, name);
}

/**
 * What a game's own `package.json` tells Genex when it is published: the Genex SDK versions it
 * depends on (sign-in support is `@genex-ai/embed-sdk`) and its `genex` settings. The CLI reads
 * these from the folder it runs in, and Studio runs it in a copy of its own, so the host reads
 * them from the game and the publish copy carries them.
 */
export interface GenexGameManifest {
  dependencies: Partial<Record<GenexGamePackage, string>>;
  genex?: { matchmaking?: Record<string, unknown>; mobileControls?: boolean };
}

/** The longest name a game is listed under on Genex. */
export const GENEX_TITLE_MAX_CHARS = 60;

/** A name to list a game under: one line, trimmed, no leading dashes, at most the cap; null when nothing is left. */
export function cleanGenexTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s-]+/, "")
    .trim();
  const title = line.slice(0, GENEX_TITLE_MAX_CHARS).trim();
  return /[\p{L}\p{N}]/u.test(title) ? title : null;
}

/** The name a game is offered under before its owner picks one: its folder name, as words. */
export function defaultGenexTitle(project: string): string {
  const words = project
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return cleanGenexTitle(words.join(" ")) ?? project;
}

/**
 * Where a Genex generation job is, as Studio records it (`GenexJob.status`). A remote status
 * Studio does not map is kept as it came, so the field stays a string. Persisted: never rename a value.
 */
export const GenexJobStatus = {
  Requested: "requested",
  /** A character preview waits for the user to approve one of its images. */
  ApprovalRequired: "approval_required",
  Approved: "approved",
  Submitting: "submitting",
  Accepted: "accepted",
  Generating: "generating",
  Generated: "generated",
  Downloaded: "downloaded",
  Failed: "failed",
  Canceled: "canceled",
  /** The submit's answer never arrived: the job may or may not exist remotely. */
  Unresolved: "unresolved",
  Stopped: "stopped",
  RetrievalFailed: "retrieval_failed",
} as const;
export type GenexJobStatus = (typeof GenexJobStatus)[keyof typeof GenexJobStatus];

/** What a Genex request asks for (`GenexRequest.operation`). Tool arguments: never rename a value. */
export const GenexOperation = {
  Model: "model",
  Image: "image",
  Texture: "texture",
  Video: "video",
  Sfx: "sfx",
  Music: "music",
  Voice: "voice",
  ModelImport: "model.import",
  ModelSegment: "model.segment",
  ModelRig: "model.rig",
  ModelAnimate: "model.animate",
  Character: "character",
  Creature: "creature",
  CharacterPreview: "character.preview",
  CharacterFinalize: "character.finalize",
  CharacterImport: "character.import",
  CharacterAnimate: "character.animate",
  CreatureAnimate: "creature.animate",
  CharacterMotions: "character.motions",
  AnimationsSearch: "animations.search",
  Wait: "wait",
  Status: "status",
  InspectUse: "inspect_use",
  VerifyUse: "verify_use",
} as const;
export type GenexOperation = (typeof GenexOperation)[keyof typeof GenexOperation];

/** Where a publish attempt is (`GenexPublishJob.phase`). Persisted in the publish state: never rename a value. */
export const GenexPublishPhase = {
  Checking: "checking",
  Exporting: "exporting",
  CreatingProject: "creating-project",
  Uploading: "uploading",
  Promoting: "promoting",
  Listing: "listing",
  Done: "done",
  VerifyingDeployment: "verifying-deployment",
  Ready: "ready",
  Failed: "failed",
  Unresolved: "unresolved",
} as const;
export type GenexPublishPhase = (typeof GenexPublishPhase)[keyof typeof GenexPublishPhase];

/** Whether a publish attempt is still going (`GenexPublishJob.state`). Persisted: never rename a value. */
export const GenexPublishJobState = {
  Running: "running",
  Done: "done",
  Failed: "failed",
  /** The upload's outcome is unknown: only Genex's own record, or the user, may settle it. */
  Unresolved: "unresolved",
} as const;
export type GenexPublishJobState = (typeof GenexPublishJobState)[keyof typeof GenexPublishJobState];

/** The panel plugin.json names for publishing: Studio draws it itself on the stage. */
export const GENEX_PUBLISH_PANEL = "publish";

/** What a publish-status call asks for: read the record, wait for the running upload, or check Genex again. */
export const GenexPublishStatusOperation = { Status: "status", Wait: "wait", Check: "check" } as const;
export type GenexPublishStatusOperation =
  (typeof GenexPublishStatusOperation)[keyof typeof GenexPublishStatusOperation];

/** Which page a publish attempt puts the game on (`GenexPublishJob.kind`). Persisted: never rename a value. */
export const GenexPublishKind = {
  /** The unlisted draft page. */
  Draft: "draft",
  /** The public gallery listing. */
  Gallery: "gallery",
} as const;
export type GenexPublishKind = (typeof GenexPublishKind)[keyof typeof GenexPublishKind];

/** Whether Genex lists a hosted game (`GenexPublishState.status`). Genex's own values: never rename one. */
export const GenexHostedStatus = {
  Draft: "draft",
  Published: "published",
} as const;
export type GenexHostedStatus = (typeof GenexHostedStatus)[keyof typeof GenexHostedStatus];

/** How far a delivered asset's use in the game is established (`GenexJob.use.stage`). Persisted: never rename a value. */
export const GenexUseStage = {
  Unconfirmed: "unconfirmed",
  Integrated: "integrated",
  Verified: "verified",
} as const;
export type GenexUseStage = (typeof GenexUseStage)[keyof typeof GenexUseStage];

/** What evidence a use record rests on (`GenexJob.use.verification`). Persisted: never rename a value. */
export const GenexUseVerification = {
  UnavailableAudio: "unavailable-audio",
  PendingVisual: "pending-visual",
  AgentVisualObservation: "agent-visual-observation",
  RuntimeAudioPlayback: "runtime-audio-playback",
} as const;
export type GenexUseVerification = (typeof GenexUseVerification)[keyof typeof GenexUseVerification];

/** Why Genex took a job no further than asking: the person has something to do first. Wire values. */
export const GenexBlocked = {
  /** Genex's terms changed and the account has not accepted them yet. */
  Terms: "terms",
} as const;
export type GenexBlocked = (typeof GenexBlocked)[keyof typeof GenexBlocked];

/** What the Genex plugin announces to the app while a call runs (`events.emit`), by `kind`. Wire values. */
export const GenexPluginEvent = {
  /** The account's terms changed state: `{ kind, pending }`, so the app reads the account again. */
  Terms: "terms",
} as const;
export type GenexPluginEvent = (typeof GenexPluginEvent)[keyof typeof GenexPluginEvent];

export interface GenexJob {
  id: string;
  project: string;
  operation: string;
  status: string;
  manifest?: Array<{ role: string; url: string; bytes?: number }>;
  preferredFile?: string;
  variantError?: string;
  generationId?: string;
  requestId?: string;
  remoteStatus?: string;
  creditsCharged?: number;
  creditsRefunded?: number;
  files: string[];
  error?: string;
  /** Set when the job went no further than asking the person for something first. */
  blocked?: GenexBlocked;
  creditsQuoted?: number;
  createdAt: string;
  use?: {
    stage: GenexUseStage;
    inspectionId: string;
    observedAt: string;
    loadedFiles: string[];
    consoleAvailable: boolean;
    verification: GenexUseVerification;
    audio?: AudioPlaybackEvidence[];
    note?: string;
  };
  approval?: {
    sourceId: string;
    images: Array<{ label: string; dataUrl: string }>;
    sourceFaceCount?: number;
    remeshFaces?: number;
  };
}
export interface GenexStatus {
  credentialState?: "locked" | "unlocked" | "failed";
  connected: boolean;
  enabled: boolean;
  identity: string | null;
  operations: string[];
  unlimited?: boolean;
  accountVerified?: boolean;
  balance: number | null;
  allowance: unknown;
  lanes: unknown;
  legal?: { accepted: boolean; requiredVersion?: string; acceptUrl: string };
  error?: string;
  jobs: GenexJob[];
  authorization?: { userCode: string; verifyUrl: string; expiresAt: number };
}
export interface GenexRequest {
  operation: string;
  prompt?: string;
  id?: string;
  options?: Record<string, string | number | boolean | Array<string | number>>;
}

/** One publish attempt. Studio owns the record; the Genex CLI owns the hosted project it acts on. */
export interface GenexPublishJob {
  id: string;
  kind: GenexPublishKind;
  state: GenexPublishJobState;
  phase: GenexPublishPhase;
  deployment?: { id: string; digest: string; files: Array<{ path: string; sha256: string; bodySha256?: string }> };
  expectedStagingRevision?: string;
  stagingUrl?: string;
  uploadedAt?: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  checkError?: string;
  checkCount?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  export?: { files: number };
  /** The name a gallery publish lists the game under. */
  title?: string;
  /** The sign-in SDK version this upload ships, as the game's package.json names it. */
  embedSdkVersion?: string;
  /** How many times this attempt uploaded the build: a draft that fails its test is uploaded once more. */
  uploads?: number;
}
/**
 * How a Genex cover send ended (`GenexCoverSent.kind`). The first five are the CLI's own answers
 * (`genex cover <file> --json` `kind`); the rest are Studio's: no shot to send, a frame Genex
 * already answered for, the owner's own pick holding, no hosted project yet, and a publish in the
 * way. Persisted: never rename one.
 */
export const GenexCoverOutcome = {
  Applied: "applied",
  Outranked: "outranked",
  Rejected: "rejected",
  Invalid: "invalid",
  Failed: "failed",
  None: "none",
  Unchanged: "unchanged",
  KeptOwner: "kept_owner",
  NotHosted: "not_hosted",
  Busy: "busy",
} as const;
export type GenexCoverOutcome = (typeof GenexCoverOutcome)[keyof typeof GenexCoverOutcome];

/** The cover tool plugin.json declares (`genex__cover`): its kept shot is the card the chat shows. */
export const GENEX_COVER_TOOL = "cover";

/** The tool plugin.json declares for every generation (`genex__asset`): its `operation` says what it makes. */
export const GENEX_ASSET_TOOL = "asset";

/** How many characters of a generation's id Genex puts in the names of its output files. */
const GENERATION_IN_NAME = 8;

/**
 * Whether a Genex output file is the provider's unprocessed source of another. Genex names each
 * output after its generation and its role code (`…-cmv6qk2b-walk-animation-a1-source-glb.glb`),
 * and a role with a `source` part is the copy from before Genex rigged or retargeted it.
 */
export function isGenexSourceOutput(file: string, generationId: string | null | undefined): boolean {
  if (!generationId) return false;
  const name = file.split("/").pop() ?? "";
  const marker = `-${generationId.slice(0, GENERATION_IN_NAME)}-`;
  const at = name.indexOf(marker);
  if (at < 0) return false;
  const role = name.slice(at + marker.length).replace(/\.[^.]+$/, "");
  return role.split("-").includes("source");
}

/** A delivered file as far as folding sources needs it. */
type Output = { file: string; kind: string; source?: string; generationId?: string };

/**
 * The files to show, less each Genex source copy whose generation also delivered a finished model:
 * the copy is still in the game, it is just never a second card of the same thing. A source that
 * came alone is shown.
 */
export function withoutGenexSources<T extends Output>(files: readonly T[]): T[] {
  const isSource = (file: T) =>
    file.source === GENEX_PLUGIN_ID && file.kind === "model" && isGenexSourceOutput(file.file, file.generationId);
  const finished = new Set(
    files.filter((file) => file.kind === "model" && file.generationId && !isSource(file)).map((f) => f.generationId),
  );
  return files.filter((file) => !(isSource(file) && finished.has(file.generationId)));
}

/** What genex__cover does: photograph the genex-cover demo and keep it, record the genex-clip demo, or report. */
export const GenexCoverOperation = { Shoot: "shoot", Status: "status", Clip: "clip" } as const;
export type GenexCoverOperation = (typeof GenexCoverOperation)[keyof typeof GenexCoverOperation];

/** The folder of the Genex plugin's storage that holds one folder per game's cover, `covers/<project>/`. */
export const GENEX_COVERS_DIR = "covers";

/** The kept shot's image beside its record in `covers/<project>/`, named by its type. */
export const GENEX_COVER_SHOT_FILE = {
  [StillMimeType.Png]: "shot.png",
  [StillMimeType.Jpeg]: "shot.jpg",
} as const satisfies Record<StillMimeType, string>;

/** The folder beside the kept shot that holds the recent frames as `<sha256>.png|jpg`, listed in `candidates.json`. */
export const GENEX_COVER_CANDIDATES_DIR = "candidates";

/** The kept cover clip's video beside its record (`clip.json`) in `covers/<project>/`, named by its type. */
export const GENEX_COVER_CLIP_FILE = {
  "video/webm": "clip.webm",
  "video/mp4": "clip.mp4",
} as const;

/** Mirror of Genex's cover upload limit (the CLI's `COVER_MAX_BYTES`, the API's `COVER_MAX_UPLOAD_BYTES`). */
export const GENEX_COVER_MAX_BYTES = 8 * 1024 * 1024;

/** The game's Genex cover shot the plugin keeps (`covers/<project>/shot.json`), beside its image. */
export interface GenexCoverShot {
  sha256: string;
  width: number;
  height: number;
  mimeType: StillMimeType;
  bytes: number;
  source: CaptureSource;
  stats: StillExposure;
  takenAt: string;
  /** Who staged the frame: the game's genex-cover demo, or Studio's plain frame of a game with none. Absent: the demo. */
  origin?: GenexCoverOrigin;
  /** The person picked this frame among the candidates: Studio and a publish shoot no new one over it. */
  pinned?: boolean;
}

/** Who staged a kept cover frame (`GenexCoverShot.origin`). Persisted: never rename one. */
export const GenexCoverOrigin = {
  /** The game's own `genex-cover` demo. */
  Demo: "demo",
  /** Studio's plain frame of the game as it loads, for a game with no genex-cover demo yet. */
  Studio: "studio",
} as const;
export type GenexCoverOrigin = (typeof GenexCoverOrigin)[keyof typeof GenexCoverOrigin];

/** Genex's luma numbers on a refused frame, as the CLI reports them (0–1). */
export interface GenexCoverFrameStats {
  mean: number;
  std: number;
  darkShare: number;
}

/**
 * The game's last cover answer, kept in `covers/<project>/sent.json`: a send's outcome, or the
 * owner's pick a status check heard of (`kept_owner`, no `sha256`). It decides whether a frame is
 * sent again.
 */
export interface GenexCoverSent {
  kind: GenexCoverOutcome;
  at: string;
  /** The frame this answer is about; absent when there was none. */
  sha256?: string;
  /** The publish whose trailing step sent it; absent for genex__cover-set. */
  jobId?: string;
  coverUrl?: string | null;
  coverSource?: string | null;
  reason?: string;
  stats?: GenexCoverFrameStats | null;
  /** What the person and the agent are told about it: a publish shows these as its warnings. */
  lines?: string[];
  /** For `unchanged`: the answer Genex gave these bytes when they were sent. */
  settled?: GenexCoverOutcome;
}

/** Answers that mean the owner chose the game's cover on genex.games: that choice stands. */
const OWNER_CHOSE = new Set<GenexCoverOutcome>([GenexCoverOutcome.KeptOwner, GenexCoverOutcome.Outranked]);

/** Whether the last send found the owner's own cover, then or when these bytes were first sent. */
export function ownerChoseCover(last: GenexCoverSent | null | undefined): boolean {
  if (!last) return false;
  return [last.kind, last.settled].some((kind) => kind !== undefined && OWNER_CHOSE.has(kind));
}

/** The game's Genex cover as the plugin reports it: the kept shot, the last send, and whether one runs. */
export interface GenexCoverRecord {
  shot: GenexCoverShot | null;
  last: GenexCoverSent | null;
  /** A send is running for this game right now. */
  sending: boolean;
  /** The recent frames the person can flip between, newest first, the kept shot among them. Absent from older plugins. */
  candidates?: GenexCoverShot[];
  /** The kept genex-clip recording, or null; absent from a plugin older than clips. */
  clip?: GenexCoverClip | null;
  /** How the last clip send went; null before any. */
  clipLast?: GenexCoverSent | null;
}

/** The game's kept cover clip (`covers/<project>/clip.json`), beside its video: five seconds of real play. */
export interface GenexCoverClip {
  sha256: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  durationMs: number;
  /** Share of sampled frame pairs that differ: a frozen recording is near 0. */
  motion: number;
  takenAt: string;
}

/** What Studio knows about this game's Genex pages. Never a credential, never the user's game folder. */
export interface GenexPublishState {
  version: 1;
  project: string;
  connected: boolean;
  terms?: { accepted: boolean; acceptUrl: string };
  slug?: string;
  projectId?: string;
  /** The name Studio last listed the game under; absent when Studio never sent one. */
  title?: string;
  status?: GenexHostedStatus;
  draftUrl?: string;
  galleryUrl?: string;
  playUrl?: string;
  readyDraft?: { revision: string; url: string; digest: string; verifiedAt: string };
  lastExportAt?: string;
  lastPreviewAt?: string;
  lastPublishAt?: string;
  lastError?: string;
  /** Non-blocking conditions: reported, never a refusal. Missing git or git-lfs is a refusal, not one of these. */
  warnings?: string[];
  job?: GenexPublishJob;
  /**
   * The game's Genex cover, which publish-status answers beside the record and never stores in it.
   * Absent from a Genex plugin older than covers.
   */
  cover?: GenexCoverRecord;
  /**
   * The game's Mac and Windows apps as its last publish sent them, answered beside the record like
   * the cover. Absent from a Genex plugin older than native builds.
   */
  native?: GenexNativeRecord;
}

/** One app a publish sent: live for desktop players under `version`. */
export interface GenexNativeSent {
  platform: string;
  arch: string;
  version: string;
  sizeBytes: number;
  publishedAt: string;
}

/** One app a publish could not send, and Genex's or the CLI's words for why. */
export interface GenexNativeFailure {
  platform: string;
  arch: string;
  error: string;
}

/** How Genex answered the listing of a game that has only apps. Wire values: never rename one. */
export const GenexListingState = { Published: "published", Held: "held", Refused: "refused" } as const;
export type GenexListingState = (typeof GenexListingState)[keyof typeof GenexListingState];

/** Genex's answer to listing a game that has only apps: listed, held for review, or refused, and why. */
export interface GenexNativeListing {
  state: GenexListingState;
  detail: string | null;
}

/**
 * A publish's apps (`genex native publish`): they go after the web build is public, one at a time,
 * and an app that fails never fails the publish. `supported` is false while Studio's pinned CLI is
 * older than native builds: the dialog then says they are coming soon and nothing is sent.
 */
export interface GenexNativeRecord {
  supported: boolean;
  /** Apps are being sent now. */
  sending: boolean;
  /** The publish the record belongs to; absent before any. */
  jobId?: string;
  sent: GenexNativeSent[];
  failed: GenexNativeFailure[];
  /** A game with only apps is listed with its first app that goes: Genex's answer. */
  listing?: GenexNativeListing;
}
