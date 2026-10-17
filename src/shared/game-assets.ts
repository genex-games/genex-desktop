/**
 * Plugin-neutral asset vocabulary shared by main and the renderer.
 *
 * Two host-owned facts live here. `AssetDeliveredPayload` is the *delivery* record: files that
 * landed inside the game, written by the host after `assets.deliver` returns and after Blender
 * writes a model — a plugin can neither forge nor skip it. `PluginToolStartedPayload` /
 * `PluginToolFinishedPayload` are the *call* record: one pair per plugin tool invocation, on
 * every engine path, carrying worker attribution at the payload top level so the Builds graph
 * (which drops any custom event whose `payload.runId` is not the run's) can see them.
 *
 * `file` is always posix-relative to the game root: the renderer never receives absolute game paths.
 */

import type { CallMaking, MakingJob } from "./asset-making.ts";
import type { GenexBlocked } from "./genex.ts";
import type { CallCutOff } from "./plugins.ts";

export type AssetKind = "image" | "model" | "audio" | "video" | "other";
/** `genex` and `blender` are the two the studio ships; any other value is a plugin id. */
export type AssetSource = "genex" | "blender" | "imported" | (string & {});

export interface AssetAvailability {
  assetId: string;
  generationId?: string;
  originalAvailable: boolean;
  deliveries: Array<{
    workspaceId: string;
    scope: "project" | "integration" | "worker";
    relativePath: string;
    present: boolean;
    revision?: string;
  }>;
  usage: "unverified" | "observed" | "verified";
}

export interface ProjectAsset {
  availability?: AssetAvailability;
  /** Host-issued reference for a retained original; never an arbitrary root. */
  assetRef?: string;
  variants?: Array<{ role: string; url: string; bytes?: number }>;
  preferredFile?: string;
  derivedFrom?: string;
  file: string;
  kind: AssetKind;
  bytes: number;
  mtime: string;
  source: AssetSource;
  jobId?: string;
  generationId?: string;
  operation?: string;
  prompt?: string;
  /**
   * The plugin's own word for the job that made this file (`downloaded`, `failed`,
   * `retrieval_failed`, …). Where the file is lives in `availability`; neither is a sentence.
   */
  pluginStatus?: string;
  at?: string;
  /** Evidence a plugin recorded about the file being loaded by the running game — an observation, never proof. */
  use?: { stage: "unconfirmed" | "integrated" | "verified"; inspectionId?: string; observedAt?: string };
  /** Absolute path of a render PNG under the run folder, readable through `readRunStill`. */
  render?: string | null;
  renderFront?: string | null;
  runId?: string;
  facetId?: string;
  iteration?: number;
}

export interface ProjectAssets {
  project: string;
  assets: ProjectAsset[];
  /**
   * Jobs with no file in the game yet, any plugin's, in the shared words (`shared/asset-making.ts`):
   * what each makes, where it is and who makes it.
   */
  jobs?: MakingJob[];
  /** The walk hit its entry or depth cap: some files under `assets/` are not listed. */
  truncated: boolean;
  skipped: Array<{ file: string; why: string }>;
}

export interface AssetDeliveredPayload {
  project: string;
  source: AssetSource;
  pluginId?: string;
  jobId: string;
  files: Array<{ file: string; bytes: number; kind: AssetKind }>;
  at: string;
  threadId?: string;
  render?: string | null;
  renderFront?: string | null;
  runId?: string;
  facetId?: string;
  iteration?: number;
  /**
   * Where the files landed: the game folder itself, or a build workspace (a Loop run's
   * integration or builder worktree) whose files reach the game only when the build lands.
   * Records written before this field existed say neither; their `runId` is the tell.
   */
  workspace?: "game" | "build";
}

/**
 * A delivery record the chat can show: one that lists its files. A record without that list has
 * nothing to show, and the cards that list a delivery's files would fail on it.
 */
export function isAssetDelivery(delivery: Partial<AssetDeliveredPayload>): delivery is AssetDeliveredPayload {
  return Array.isArray(delivery.files);
}

/** A delivery the game folder does not hold yet: it waits for its build to land. */
export function deliveredToBuild(delivery: Pick<AssetDeliveredPayload, "workspace" | "runId">): boolean {
  return (
    delivery.workspace === "build" ||
    (delivery.workspace === undefined && typeof delivery.runId === "string" && delivery.runId !== "")
  );
}

/**
 * Where `readProjectAsset` reads its one picture: the game's own asset folders, one Genex job's
 * saved inspection frame, the game's kept Genex cover shot (or one of its recent candidates) in the
 * Genex plugin's storage, or the game's kept Genex cover clip beside it. Wire values: never rename one.
 */
export const ProjectAssetScope = {
  Game: "game",
  GenexInspection: "genex-inspection",
  GenexCover: "genex-cover",
  GenexCoverClip: "genex-cover-clip",
} as const;
export type ProjectAssetScope = (typeof ProjectAssetScope)[keyof typeof ProjectAssetScope];

/**
 * What `readProjectAsset` is asked for. A file of the game (or of a Genex job) is named by the
 * caller; the Genex cover shot and clip never are: the host builds their place from the game's name
 * alone, and a cover `candidate` from its 64 lowercase hex digits (the sha256 of its bytes).
 * `maxPx` asks for a downscale of a picture; a clip is answered as it was kept.
 */
export type ProjectAssetRead =
  | {
      project: string;
      file: string;
      maxPx?: number;
      scope?: typeof ProjectAssetScope.Game | typeof ProjectAssetScope.GenexInspection;
      jobId?: string;
    }
  | { project: string; scope: typeof ProjectAssetScope.GenexCover; maxPx?: number; candidate?: string }
  | { project: string; scope: typeof ProjectAssetScope.GenexCoverClip };

/** Which session asked for the tool. There is no `role` on a delegate request; it is derived. */
export type PluginToolRole = "director" | "builder" | "chat";

/** Thread custom event `plugin_tool_started`, appended before the plugin backend is called. */
export interface PluginToolStartedPayload {
  /** Minted at the start and echoed on the finished payload so the two can be paired. */
  callId: string;
  pluginId: string;
  pluginName: string;
  /** The bare tool name, as the plugin declared it (`asset`). */
  tool: string;
  /** The namespaced name the engines call (`genex__asset`). */
  toolName: string;
  /** A digest of the arguments, at most 200 characters; never the raw object. */
  args: string;
  project: string;
  threadId?: string;
  runId?: string;
  facetId?: string;
  iteration?: number;
  engine: string;
  role: PluginToolRole;
  at: string;
  /** What the call makes, when its tool says (or it is Genex's asset tool): the host stamps it. */
  making?: CallMaking;
}

/**
 * The operation a call asked for, read back from its arguments digest (`args`), which the host
 * writes as `key=value` pairs with `operation` always first (`argsDigest`). Null when the call
 * named none: a value that only mentions `operation=` later in the digest is never read as one.
 */
export function digestOperation(args: string | undefined): string | null {
  const [first = ""] = (args ?? "").split(" ");
  return first.startsWith("operation=") ? first.slice("operation=".length) : null;
}

/** Thread custom event `plugin_tool`, appended after the call returns or throws. */
export interface PluginToolFinishedPayload extends PluginToolStartedPayload {
  ok: boolean;
  error?: string;
  /** A digest of the result record, at most 4 KiB, with base64 payloads removed. */
  result: string;
  /** How many images came back with the result — counted before they are stripped from the record. */
  images: number;
  files?: string[];
  jobId?: string;
  generationId?: string;
  durationMs: number;
  /** The installed plugin's version, kept from the API 1 shape of this event. */
  version?: string;
  /** Set when the call was cut off: its outcome is unknown. */
  cutOff?: CallCutOff;
  /** Set when the job went no further than asking the person for something first (Genex's terms). */
  blocked?: GenexBlocked;
}

/** How the app shows a file: the viewer it opens in, or none (unknown files stay metadata). */
export type AssetPreviewMode = "image" | "audio" | "video" | "model" | "texture" | "text" | "unsupported";

export interface AssetFormat {
  /** What the file is, for the inventory and the cards. */
  kind: AssetKind;
  /** Which viewer shows it. */
  preview: AssetPreviewMode;
  /** The type the contained reader serves it as. */
  mime: string;
  /** A plain raster picture the host can byte-check and scale into a thumbnail. */
  raster: boolean;
  /** A picture a model file can name as its texture (preloaded beside an FBX). */
  texture?: true;
}

const image = (mime: string, extra: { raster?: boolean; texture?: true } = {}): AssetFormat => ({
  kind: "image",
  preview: "image",
  mime,
  raster: extra.raster ?? false,
  ...(extra.texture ? { texture: true } : {}),
});
const as = (kind: AssetKind, preview: AssetPreviewMode, mime: string): AssetFormat => ({
  kind,
  preview,
  mime,
  raster: false,
});

/**
 * Every file format the studio knows, by lowercase extension: one table for the inventory's kind,
 * the preview's viewer, the reader's MIME type and the thumbnail reader. A new format is one row
 * here (see docs/agent/recipes.md, "Asset format"). Anything else is `other` and unsupported.
 */
export const ASSET_FORMATS: Readonly<Record<string, AssetFormat>> = Object.freeze({
  png: image("image/png", { raster: true, texture: true }),
  jpg: image("image/jpeg", { raster: true, texture: true }),
  jpeg: image("image/jpeg", { raster: true, texture: true }),
  webp: image("image/webp", { raster: true, texture: true }),
  gif: image("image/gif", { raster: true }),
  avif: image("image/avif"),
  svg: image("image/svg+xml"),
  bmp: image("image/bmp", { texture: true }),
  // High-dynamic-range and GPU textures are images, shown on a plane by the model viewer.
  hdr: as("image", "texture", "image/vnd.radiance"),
  exr: as("image", "texture", "image/x-exr"),
  ktx2: as("image", "texture", "image/ktx2"),
  glb: as("model", "model", "model/gltf-binary"),
  gltf: as("model", "model", "model/gltf+json"),
  obj: as("model", "model", "text/plain"),
  fbx: as("model", "model", "application/octet-stream"),
  stl: as("model", "model", "application/octet-stream"),
  ply: as("model", "model", "application/octet-stream"),
  // An authoring app's own files: listed by name, opened in that app.
  blend: as("model", "unsupported", "application/octet-stream"),
  mp3: as("audio", "audio", "audio/mpeg"),
  wav: as("audio", "audio", "audio/wav"),
  ogg: as("audio", "audio", "audio/ogg"),
  oga: as("audio", "audio", "audio/ogg"),
  opus: as("audio", "audio", "audio/ogg"),
  m4a: as("audio", "audio", "audio/mp4"),
  aac: as("audio", "audio", "audio/aac"),
  flac: as("audio", "audio", "audio/flac"),
  mp4: as("video", "video", "video/mp4"),
  webm: as("video", "video", "video/webm"),
  mov: as("video", "video", "video/quicktime"),
  ogv: as("video", "video", "video/ogg"),
  // A model's companions and plain data: readable as text, not assets of their own kind.
  mtl: as("other", "text", "text/plain"),
  json: as("other", "text", "application/json"),
  txt: as("other", "text", "text/plain"),
  csv: as("other", "text", "text/plain"),
  atlas: as("other", "text", "text/plain"),
  bin: as("other", "unsupported", "application/octet-stream"),
  // Unreal's packages and levels: only the editor reads them.
  uasset: as("other", "unsupported", "application/octet-stream"),
  umap: as("other", "unsupported", "application/octet-stream"),
});

/** The kinds of asset that are media: what an engine's asset folder shows besides its own formats. */
const MEDIA_KINDS: readonly AssetKind[] = ["image", "model", "audio", "video"];

/** The extensions of every media format the studio knows (images, models, audio, video), in table order. */
export const MEDIA_FORMATS: readonly string[] = Object.freeze(
  Object.entries(ASSET_FORMATS)
    .filter(([, format]) => MEDIA_KINDS.includes(format.kind))
    .map(([ext]) => ext),
);

/** Whether a file is media (an image, model, sound or video) by its extension: an asset of its own. */
export const isMediaFile = (file: string): boolean => MEDIA_FORMATS.includes(assetExtension(file));

/** What a model loads beside itself (a glTF's buffers, an OBJ's materials): read wherever models are. */
export const MODEL_COMPANION_FORMATS: readonly string[] = Object.freeze(["bin", "mtl"]);

/** Whether a list of formats names a model, so the model's companions are read beside it. */
export const listsModels = (formats: readonly string[]): boolean =>
  formats.some((format) => Object.hasOwn(ASSET_FORMATS, format) && ASSET_FORMATS[format]?.kind === "model");

/** A file's lowercase extension: the text after its last dot. */
export function assetExtension(file: string): string {
  return (typeof file === "string" ? file : "").split(".").pop()?.toLowerCase() ?? "";
}

/** The row for a file's extension, or null for a format the studio does not know. */
export function assetFormat(file: string): AssetFormat | null {
  const ext = assetExtension(file);
  return Object.hasOwn(ASSET_FORMATS, ext) && typeof file === "string" && file.includes(".")
    ? ASSET_FORMATS[ext]!
    : null;
}

/** What a delivered file is, by extension. The bytes decide only when the file is read. */
export function assetKind(file: string): AssetKind {
  return assetFormat(file)?.kind ?? "other";
}

/** A sound the game can play, by extension: the files whose playback an asset check observes. */
export function isAudioFile(file: string): boolean {
  return assetKind(file) === "audio";
}
