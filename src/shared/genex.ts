import type { AudioPlaybackEvidence } from "./audio-observation.ts";
import { type CaptureSource, type StillExposure, StillMimeType } from "./preview-contract.ts";

/** The bundled Genex plugin's id: the host's own Genex surfaces (its page, the promo) look it up by this. */
export const GENEX_PLUGIN_ID = "genex";

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
  Disconnect: "disconnect",
  CancelConnect: "cancel-connect",
  Approve: "approve",
  PublishStatus: "publish-status",
  PublishDraft: "publish-draft",
  PublishGallery: "publish-gallery",
  PublishAllowUpload: "publish-allow-upload",
  PublishOpen: "publish-open",
  PublishBadge: "publish-badge",
} as const;

/**
 * The Genex SDK packages a game may add, each at the exact version Studio installs. The agent names
 * a package; the version always comes from here. Multiplayer's card asks for `^0.16.0`.
 */
export const GENEX_GAME_PACKAGES = {
  "@genex-ai/multiplayer": "0.16.1",
  "@genex-ai/embed-sdk": "0.30.0",
} as const;
/** A Genex SDK package a game may add. */
export type GenexGamePackage = keyof typeof GENEX_GAME_PACKAGES;
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
  deployment?: { id: string; digest: string; files: Array<{ path: string; sha256: string }> };
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

/** What genex__cover does: photograph the genex-cover demo and keep it, or report the cover's state. */
export const GenexCoverOperation = { Shoot: "shoot", Status: "status" } as const;
export type GenexCoverOperation = (typeof GenexCoverOperation)[keyof typeof GenexCoverOperation];

/** The folder of the Genex plugin's storage that holds one folder per game's cover, `covers/<project>/`. */
export const GENEX_COVERS_DIR = "covers";

/** The kept shot's image beside its record in `covers/<project>/`, named by its type. */
export const GENEX_COVER_SHOT_FILE = {
  [StillMimeType.Png]: "shot.png",
  [StillMimeType.Jpeg]: "shot.jpg",
} as const satisfies Record<StillMimeType, string>;

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
}

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

/** The game's Genex cover as the plugin reports it: the kept shot, the last send, and whether one runs. */
export interface GenexCoverRecord {
  shot: GenexCoverShot | null;
  last: GenexCoverSent | null;
  /** A send is running for this game right now. */
  sending: boolean;
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
}
