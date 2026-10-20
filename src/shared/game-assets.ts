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
import { type CompiledStack, GameStack, isCompiledStack } from "./game-project.ts";

import type { ImportIssue } from "./asset-db.ts";
import type { CharacterFacts } from "./character-facts.ts";
import type { CallMaking, MakingJob } from "./asset-making.ts";
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
  /**
   * What a Rust game's import step does with the file, found when it was delivered (or first
   * listed) and imported into the import cache ahead of any build. Absent for a file the import
   * step does not know and for every other stack's game.
   */
  import?: ProjectAssetImport;
}

/** Where a file's delivery-time import stands. Wire values in `assets.inventory`: never rename one. */
export const AssetImportStatus = {
  /** Not imported yet (this version of the file): the import has started or is queued. */
  Pending: "pending",
  /** The game loads the file, as it is or through the outputs its import wrote. */
  Ready: "ready",
  /** The import step refused the file: `refusal` says why, and builds leave it out. */
  Refused: "refused",
} as const;
export type AssetImportStatus = (typeof AssetImportStatus)[keyof typeof AssetImportStatus];

/** A Rust game's file as its import step sees it (`ProjectAsset.import`). */
export interface ProjectAssetImport {
  status: AssetImportStatus;
  /** Set when `status` is `refused`. */
  refusal?: AssetImportRefusal;
  /**
   * What the import noticed without refusing the file: glTF validator warnings
   * (`validation-warning`, detail `<CODE> <pointer>`), then the validation report's checks of the
   * GLB it wrote (material ranges, the triangle budget; detail a JSON pointer or the numbers).
   */
  issues?: ImportIssue[];
  /** A rigged GLB's clips, joints, humanoid coverage and skinned levels (C-23); absent for any other file. */
  character?: CharacterFacts;
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
  /** `refused`: the file landed, but the game's stack cannot load its format (`stackAcceptsAsset`). */
  files: Array<{ file: string; bytes: number; kind: AssetKind; refused?: AssetRefusal }>;
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
 * saved inspection frame, or the game's kept Genex cover shot in the Genex plugin's storage. Wire
 * values: never rename one.
 */
export const ProjectAssetScope = {
  Game: "game",
  GenexInspection: "genex-inspection",
  GenexCover: "genex-cover",
} as const;
export type ProjectAssetScope = (typeof ProjectAssetScope)[keyof typeof ProjectAssetScope];

/**
 * What `readProjectAsset` is asked for. A file of the game (or of a Genex job) is named by the
 * caller; the Genex cover shot never is: the host builds its place from the game's name alone.
 * `maxPx` asks for a downscale.
 */
export type ProjectAssetRead =
  | {
      project: string;
      file: string;
      maxPx?: number;
      scope?: typeof ProjectAssetScope.Game | typeof ProjectAssetScope.GenexInspection;
      jobId?: string;
    }
  | { project: string; scope: typeof ProjectAssetScope.GenexCover; maxPx?: number };

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
}

/** How the app shows a file: the viewer it opens in, or none (unknown files stay metadata). */
export type AssetPreviewMode = "image" | "audio" | "video" | "model" | "texture" | "text" | "unsupported";

/** How a compiled stack takes a format. Wire values: never rename one. */
export const AssetSupport = {
  /** The game loads the file as it is. */
  Loads: "loads",
  /** The studio's import step converts it first (Rust · wgpu: OBJ, STL and PLY to GLB; Opus and AAC to OGG). */
  Converts: "converts",
  /** The game cannot use it: a delivered file is marked refused. */
  Refused: "refused",
} as const;
export type AssetSupport = (typeof AssetSupport)[keyof typeof AssetSupport];

/** How each compiled stack takes one format. Three.js loads whatever the browser loads, so it has no column. */
export type StackAssetSupport = Readonly<Record<CompiledStack, AssetSupport>>;

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
  /** An equirectangular HDR map a Rust · wgpu game lights its scene with (its environment). */
  environment?: true;
  /**
   * How each compiled stack takes it: raylib 6.0 as Genex builds it (its `config.h`, `raudio.c`
   * and model loaders), and the Rust · wgpu runtime with the studio's import step (plan "Game services").
   */
  stacks: StackAssetSupport;
}

/** Why a file is refused for a game's stack. Sent to the renderer: never rename a value. */
export const AssetRefusal = {
  /** A C++ · raylib game cannot load this format. */
  UnsupportedByRaylib: "unsupported-by-raylib",
  /** A Rust · wgpu game cannot load this format, and the import step does not convert it. */
  UnsupportedByRust: "unsupported-by-rust",
} as const;
export type AssetRefusal = (typeof AssetRefusal)[keyof typeof AssetRefusal];

/**
 * Why the import step refused a file. The two stack refusals are `AssetRefusal`'s own values (the
 * renderer words them); the rest are the importer's. Wire values: never rename one.
 */
export const AssetImportRefusal = {
  /** A C++ · raylib game cannot load the format. */
  UnsupportedByRaylib: AssetRefusal.UnsupportedByRaylib,
  /** A Rust · wgpu game cannot load the format, and the import step does not convert it. */
  UnsupportedByRust: AssetRefusal.UnsupportedByRust,
  /** The name breaks the asset-path rule (`isSafeAssetPath`): absolute, climbing, a device name. */
  UnsafePath: "unsafe-path",
  /** The name resolves outside the game folder once its links are followed, or is a link itself. */
  EscapesGame: "escapes-game",
  /** Nothing is there. */
  Missing: "missing",
  /** A folder, a FIFO, a socket or a device: not a regular file. */
  NotRegularFile: "not-regular-file",
  /** Larger than the importer reads. */
  TooLarge: "too-large",
  /** The bytes are not the format the name says, or are damaged. */
  Malformed: "malformed",
  /** The glTF requires an extension the runtime does not read, even after the import step. */
  UnsupportedExtension: "unsupported-extension",
  /** The step needs a tool the store does not carry (an audio encoder). */
  ConverterMissing: "converter-missing",
  /** The importer failed, timed out, or answered something the host does not accept. */
  ImporterFailed: "importer-failed",
  /** The glTF validator found an error in the file: the first codes it named are in the detail. */
  ValidationFailed: "validation-failed",
} as const;
export type AssetImportRefusal = (typeof AssetImportRefusal)[keyof typeof AssetImportRefusal];

/** Whether `code` is one of the import step's refusals (a receipt's word is checked against it). */
export function isAssetImportRefusal(code: unknown): code is AssetImportRefusal {
  return typeof code === "string" && (Object.values(AssetImportRefusal) as string[]).includes(code);
}

/** The refusal each compiled stack marks a file it cannot use with. */
const STACK_ASSET_REFUSAL = {
  [GameStack.RaylibCpp]: AssetRefusal.UnsupportedByRaylib,
  [GameStack.RustWgpu]: AssetRefusal.UnsupportedByRust,
} as const satisfies Record<CompiledStack, AssetRefusal>;

const { Loads, Converts, Refused } = AssetSupport;
/** Both compiled stacks load it. */
const BOTH = { [GameStack.RaylibCpp]: Loads, [GameStack.RustWgpu]: Loads } as const satisfies StackAssetSupport;
/** raylib refuses it; the Rust runtime loads it. */
const RUST_ONLY = { [GameStack.RaylibCpp]: Refused, [GameStack.RustWgpu]: Loads } as const satisfies StackAssetSupport;
/** raylib refuses it; the Rust import step converts it. */
const RUST_CONVERTS = {
  [GameStack.RaylibCpp]: Refused,
  [GameStack.RustWgpu]: Converts,
} as const satisfies StackAssetSupport;
/** raylib loads it; the Rust import step converts it. */
const RAYLIB_LOADS_RUST_CONVERTS = {
  [GameStack.RaylibCpp]: Loads,
  [GameStack.RustWgpu]: Converts,
} as const satisfies StackAssetSupport;
/** Only raylib loads it. */
const RAYLIB_ONLY = {
  [GameStack.RaylibCpp]: Loads,
  [GameStack.RustWgpu]: Refused,
} as const satisfies StackAssetSupport;
/** Neither compiled stack can use it. */
const NEITHER = { [GameStack.RaylibCpp]: Refused, [GameStack.RustWgpu]: Refused } as const satisfies StackAssetSupport;

const image = (
  mime: string,
  stacks: StackAssetSupport,
  extra: { raster?: boolean; texture?: true } = {},
): AssetFormat => ({
  kind: "image",
  preview: "image",
  mime,
  raster: extra.raster ?? false,
  ...(extra.texture ? { texture: true } : {}),
  stacks,
});
const as = (kind: AssetKind, preview: AssetPreviewMode, mime: string, stacks: StackAssetSupport): AssetFormat => ({
  kind,
  preview,
  mime,
  raster: false,
  stacks,
});
/** A format Chromium shows in no viewer (raylib's own containers and trackers). */
const unshown = (kind: AssetKind, stacks: StackAssetSupport): AssetFormat =>
  as(kind, "unsupported", "application/octet-stream", stacks);

/**
 * Every file format the studio knows, by lowercase extension: one table for the inventory's kind,
 * the preview's viewer, the reader's MIME type, the thumbnail reader and how each compiled stack
 * takes it. A new format is one row here (see docs/agent/recipes.md, "Asset format"). Anything
 * else is `other` and unsupported.
 */
export const ASSET_FORMATS: Readonly<Record<string, AssetFormat>> = Object.freeze({
  png: image("image/png", BOTH, { raster: true, texture: true }),
  // JPEG loads in raylib too: the Genex prebuild turns SUPPORT_FILEFORMAT_JPG on.
  jpg: image("image/jpeg", BOTH, { raster: true, texture: true }),
  jpeg: image("image/jpeg", BOTH, { raster: true, texture: true }),
  webp: image("image/webp", RUST_ONLY, { raster: true, texture: true }),
  gif: image("image/gif", BOTH, { raster: true }),
  // The Rust runtime's `image` build has no AVIF or SVG decoder.
  avif: image("image/avif", NEITHER),
  svg: image("image/svg+xml", NEITHER),
  bmp: image("image/bmp", BOTH, { texture: true }),
  // High-dynamic-range and GPU textures are images, shown on a plane by the model viewer.
  // raylib 6.0 ships SUPPORT_FILEFORMAT_HDR 0 and reads neither EXR nor KTX2; the Rust runtime keeps all three.
  // A Radiance `.hdr` is also the Rust runtime's environment map format (image-based lighting).
  hdr: { ...as("image", "texture", "image/vnd.radiance", RUST_ONLY), environment: true },
  exr: as("image", "texture", "image/x-exr", RUST_ONLY),
  ktx2: as("image", "texture", "image/ktx2", RUST_ONLY),
  // raylib's own texture containers: DDS and QOI (the Rust runtime's `image` reads both too).
  dds: unshown("image", BOTH),
  qoi: unshown("image", BOTH),
  glb: as("model", "model", "model/gltf-binary", BOTH),
  gltf: as("model", "model", "model/gltf+json", BOTH),
  // OBJ, STL and PLY become GLB in the Rust import step; FBX is refused there.
  obj: as("model", "model", "text/plain", RAYLIB_LOADS_RUST_CONVERTS),
  fbx: as("model", "model", "application/octet-stream", NEITHER),
  stl: as("model", "model", "application/octet-stream", RUST_CONVERTS),
  ply: as("model", "model", "application/octet-stream", RUST_CONVERTS),
  // An authoring app's own files: listed by name, opened in that app.
  blend: as("model", "unsupported", "application/octet-stream", NEITHER),
  // raylib's own model formats beside glTF and OBJ.
  iqm: unshown("model", RAYLIB_ONLY),
  m3d: unshown("model", RAYLIB_ONLY),
  vox: unshown("model", RAYLIB_ONLY),
  mp3: as("audio", "audio", "audio/mpeg", BOTH),
  wav: as("audio", "audio", "audio/wav", BOTH),
  ogg: as("audio", "audio", "audio/ogg", BOTH),
  // raudio matches `.ogg` only, and has no Opus, AAC or (as Genex builds it) FLAC decoder. The Rust
  // runtime decodes Ogg and FLAC with symphonia, and its import step turns Opus and AAC into OGG.
  oga: as("audio", "audio", "audio/ogg", RUST_ONLY),
  opus: as("audio", "audio", "audio/ogg", RUST_CONVERTS),
  m4a: as("audio", "audio", "audio/mp4", RUST_CONVERTS),
  aac: as("audio", "audio", "audio/aac", RUST_CONVERTS),
  flac: as("audio", "audio", "audio/flac", RUST_ONLY),
  // raudio's own formats: QOA, and the XM and MOD trackers. The Rust runtime refuses them.
  qoa: unshown("audio", RAYLIB_ONLY),
  xm: unshown("audio", RAYLIB_ONLY),
  mod: unshown("audio", RAYLIB_ONLY),
  // Neither compiled runtime plays video.
  mp4: as("video", "video", "video/mp4", NEITHER),
  webm: as("video", "video", "video/webm", NEITHER),
  mov: as("video", "video", "video/quicktime", NEITHER),
  ogv: as("video", "video", "video/ogg", NEITHER),
  // A model's companions and plain data: readable as text, not assets of their own kind. An MTL
  // goes into the GLB its OBJ becomes in the Rust import step.
  mtl: as("other", "text", "text/plain", RAYLIB_LOADS_RUST_CONVERTS),
  json: as("other", "text", "application/json", BOTH),
  txt: as("other", "text", "text/plain", BOTH),
  csv: as("other", "text", "text/plain", BOTH),
  atlas: as("other", "text", "text/plain", BOTH),
  bin: as("other", "unsupported", "application/octet-stream", BOTH),
  // Unreal's packages and levels: only the editor reads them.
  uasset: as("other", "unsupported", "application/octet-stream", NEITHER),
  umap: as("other", "unsupported", "application/octet-stream", NEITHER),
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

/** An HDR environment map a Rust · wgpu game can light its scene with, by extension. */
export function isEnvironmentAsset(file: string): boolean {
  return assetFormat(file)?.environment === true;
}

/** A sound the game can play, by extension: the files whose playback an asset check observes. */
export function isAudioFile(file: string): boolean {
  return assetKind(file) === "audio";
}

/**
 * How a game of `stack` takes `file`, by its row: null for a format the table does not know (it
 * stays metadata). Three.js loads every known format.
 */
export function stackAssetSupport(stack: GameStack, file: string): AssetSupport | null {
  const format = assetFormat(file);
  if (!format) return null;
  return isCompiledStack(stack) ? format.stacks[stack] : AssetSupport.Loads;
}

/**
 * Whether a game of `stack` can use `file`, by its row: null when it can (loaded or converted at
 * import, and for a format the table does not know, which stays metadata), else why not.
 * Three.js refuses nothing.
 */
export function stackAcceptsAsset(stack: GameStack, file: string): AssetRefusal | null {
  if (!isCompiledStack(stack)) return null;
  return stackAssetSupport(stack, file) === AssetSupport.Refused ? STACK_ASSET_REFUSAL[stack] : null;
}
