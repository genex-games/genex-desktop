/**
 * An asset being made, in the words every plugin and every surface share: the kind of asset a job
 * makes and where the job is. Main fills them in for the Assets inventory (`ProjectAssets.jobs`),
 * the chat reads them off a call's own record, and a plugin declares the kind its tools make
 * (`PluginToolAsset`, on a tool or an MCP server's tool). The renderer names and draws each kind
 * (`renderer/asset-making.ts`); nothing here is a sentence.
 *
 * Genex is the one plugin Studio knows by name: its operations and job statuses map here, from its
 * own records, so its cards need no declaration.
 */
import { HOUR_MS } from "./duration.ts";
import { GENEX_PLUGIN_ID, GenexJobStatus, GenexOperation } from "./genex.ts";

/** What a job makes. A plugin manifest names these: never rename a value. */
export const MakingKind = {
  Character: "character",
  Creature: "creature",
  Model: "model",
  RiggedModel: "rigged-model",
  Animation: "animation",
  Image: "image",
  Texture: "texture",
  Video: "video",
  SoundEffect: "sound-effect",
  Music: "music",
  Voice: "voice",
} as const;
export type MakingKind = (typeof MakingKind)[keyof typeof MakingKind];

/** Whether a word a plugin wrote is a kind Studio draws. */
export const isMakingKind = (value: unknown): value is MakingKind =>
  typeof value === "string" && (Object.values(MakingKind) as string[]).includes(value);

/** Where a job is, as every surface shows it. Also a making card's `data-making`. */
export const MakingPhase = {
  /** Asked for; the tool has not taken it yet. */
  Queued: "queued",
  /** The tool is making it. */
  Making: "making",
  /** It waits for the person to choose. */
  Review: "review",
  /** The tool finished; the files were never fetched. */
  NotFetched: "not-fetched",
  /** Its files were delivered and the game no longer holds them (or holds them only in a build). */
  NotInGame: "not-in-game",
  Failed: "failed",
  Stopped: "stopped",
  /** Its request never got an answer: it may or may not be running. */
  Unsure: "unsure",
} as const;
export type MakingPhase = (typeof MakingPhase)[keyof typeof MakingPhase];

/** The phases of a job still on its way: the clock runs, or it waits on the tool or the person. */
export const isUnderWay = (phase: MakingPhase): boolean =>
  phase === MakingPhase.Making || phase === MakingPhase.Queued || phase === MakingPhase.Review;

/**
 * What a call of a tool makes, as its tool declares it: a plugin tool in its manifest
 * (`tools[].asset`, API 3), an MCP server's tool in its listing (`_meta["genex/asset"]`,
 * {@link MCP_ASSET_META}). `prompt` names the argument that says what to make, when one does;
 * `tool` names the outside service doing the work, when the plugin or server is a front for one.
 * It only says what a call is shown as; it grants nothing.
 */
export interface PluginToolAsset {
  kind: MakingKind;
  prompt?: string;
  tool?: string;
}

/** The key of an MCP tool listing's `_meta` that declares what a call of the tool makes. */
export const MCP_ASSET_META = "genex/asset";

/** How long a declaration's argument name and tool name may be. */
const ASSET_ARG_MAX = 64;
const ASSET_TOOL_MAX = 40;

const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * A tool's declaration of what it makes, in canonical form, or null when it is not one: an unknown
 * kind, or a prompt or tool that is not a short name. Nothing else of the value is kept.
 */
export function readToolAsset(value: unknown): PluginToolAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isMakingKind(raw.kind)) return null;
  if (raw.prompt !== undefined && !shortText(raw.prompt, ASSET_ARG_MAX)) return null;
  if (raw.tool !== undefined && !shortText(raw.tool, ASSET_TOOL_MAX)) return null;
  return {
    kind: raw.kind,
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...(typeof raw.tool === "string" ? { tool: raw.tool.trim() } : {}),
  };
}

/**
 * What one call makes, as the host stamps it on the call's own record (`plugin_tool_started`,
 * `connector_tool_started`) so every reader shows it alike: the kind, the outside tool, and the
 * prompt it was asked with, cut to {@link CALL_PROMPT_MAX}.
 */
export interface CallMaking {
  kind: MakingKind;
  tool?: string;
  prompt?: string;
}

/** The longest prompt a call's record keeps; a longer one is cut with an ellipsis. */
export const CALL_PROMPT_MAX = 1000;

/** A prompt as a record keeps it: whole up to the cap, else cut with an ellipsis; none when blank. */
export function keptPrompt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length > CALL_PROMPT_MAX ? `${value.slice(0, CALL_PROMPT_MAX - 1)}…` : value;
}

/** What a call makes, from its tool's declaration and the call's own arguments. */
export function callMaking(declared: PluginToolAsset, args: Record<string, unknown>): CallMaking {
  const prompt = keptPrompt(args[declared.prompt ?? "prompt"]);
  return {
    kind: declared.kind,
    ...(declared.tool ? { tool: declared.tool } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/** What a call of Genex's own asset tool makes: its operation's kind and routed tool; null for a lookup. */
export function genexCallMaking(args: Record<string, unknown>): CallMaking | null {
  const made = genexMaking(typeof args.operation === "string" ? args.operation : null);
  if (!made) return null;
  const prompt = keptPrompt(args.prompt);
  return { kind: made.kind, ...(made.tool ? { tool: made.tool } : {}), ...(prompt ? { prompt } : {}) };
}

/**
 * Genex's calls that look something up rather than make it (a status, a catalog, a character's
 * clips): never a job of their own. A wait is not one: it picks up a generation already asked for.
 */
export const GENEX_LOOKUPS: ReadonlySet<string> = new Set([
  GenexOperation.Status,
  GenexOperation.AnimationsSearch,
  GenexOperation.CharacterMotions,
]);

/** The tools Genex routes its lanes to, as they are named on its page. Wire values: never rename one. */
export const GenexTool = {
  Tripo: "tripo",
  Meshy: "meshy",
  Uthana: "uthana",
  GptImage: "gpt-image",
  NanoBanana: "nano-banana",
  MiniMax: "minimax",
  Blender: "blender",
  ElevenLabs: "elevenlabs",
  Publishing: "publishing",
} as const;
export type GenexTool = (typeof GenexTool)[keyof typeof GenexTool];

/** What one Genex operation makes, and the tool it is routed to (null: no one tool, Genex itself). */
export interface GenexMaking {
  kind: MakingKind;
  tool: GenexTool | null;
}

const making = (kind: MakingKind, tool: GenexTool | null): GenexMaking => ({ kind, tool });
const ModelByTripo = making(MakingKind.Model, GenexTool.Tripo);
const CharacterByMeshy = making(MakingKind.Character, GenexTool.Meshy);
const Animation = making(MakingKind.Animation, null);

/** Every Genex operation that makes an asset. Tool arguments are its keys: never rename one. */
const GENEX_MAKES: Partial<Record<string, GenexMaking>> = {
  [GenexOperation.Model]: ModelByTripo,
  [GenexOperation.ModelImport]: ModelByTripo,
  [GenexOperation.ModelSegment]: ModelByTripo,
  [GenexOperation.ModelRig]: making(MakingKind.RiggedModel, GenexTool.Tripo),
  [GenexOperation.ModelAnimate]: making(MakingKind.Animation, GenexTool.Tripo),
  [GenexOperation.Character]: CharacterByMeshy,
  [GenexOperation.CharacterPreview]: CharacterByMeshy,
  [GenexOperation.CharacterFinalize]: CharacterByMeshy,
  [GenexOperation.CharacterImport]: making(MakingKind.Character, GenexTool.Uthana),
  [GenexOperation.Creature]: making(MakingKind.Creature, GenexTool.Meshy),
  [GenexOperation.CharacterAnimate]: Animation,
  [GenexOperation.CreatureAnimate]: Animation,
  [GenexOperation.Image]: making(MakingKind.Image, GenexTool.GptImage),
  [GenexOperation.Texture]: making(MakingKind.Texture, GenexTool.NanoBanana),
  [GenexOperation.Video]: making(MakingKind.Video, GenexTool.MiniMax),
  [GenexOperation.Sfx]: making(MakingKind.SoundEffect, GenexTool.ElevenLabs),
  [GenexOperation.Music]: making(MakingKind.Music, GenexTool.ElevenLabs),
  [GenexOperation.Voice]: making(MakingKind.Voice, GenexTool.ElevenLabs),
};

/** What a Genex operation makes, or null for a call that makes nothing (or one Studio does not know). */
export function genexMaking(operation: string | null | undefined): GenexMaking | null {
  // The plugin's word, never an inherited name (`constructor`) read off the table.
  if (!operation || !Object.hasOwn(GENEX_MAKES, operation)) return null;
  return GENEX_MAKES[operation] ?? null;
}

/** Genex's word for a job, as a phase. */
const GENEX_PHASE: Partial<Record<string, MakingPhase>> = {
  [GenexJobStatus.Requested]: MakingPhase.Queued,
  [GenexJobStatus.Submitting]: MakingPhase.Queued,
  [GenexJobStatus.Accepted]: MakingPhase.Making,
  [GenexJobStatus.Generating]: MakingPhase.Making,
  [GenexJobStatus.ApprovalRequired]: MakingPhase.Review,
  [GenexJobStatus.Generated]: MakingPhase.NotFetched,
  [GenexJobStatus.Downloaded]: MakingPhase.NotInGame,
  [GenexJobStatus.Failed]: MakingPhase.Failed,
  [GenexJobStatus.RetrievalFailed]: MakingPhase.Failed,
  [GenexJobStatus.Stopped]: MakingPhase.Stopped,
  [GenexJobStatus.Canceled]: MakingPhase.Stopped,
  [GenexJobStatus.Unresolved]: MakingPhase.Unsure,
} satisfies Partial<Record<GenexJobStatus, MakingPhase>>;

/**
 * How long a Genex job may say it is still being made before Studio stops believing it: its
 * slowest lanes take about half an hour, so a job that still says so long after was finished or
 * lost without its record hearing. It then reads as not confirmed, and its clock stops.
 */
export const GENEX_MAKING_MAX_MS = 2 * HOUR_MS;

/** What else Studio knows of a Genex job: it delivered files the game no longer holds, and how long ago it started. */
export interface GenexJobFacts {
  delivered?: boolean;
  /** How long ago the job started, in milliseconds; absent when it did not say. */
  ageMs?: number | null;
}

/**
 * Where a Genex job is, from its own word for it; a word Studio does not know is still being made.
 * A job that delivered files the game no longer holds is never still being made, and one that has
 * said so for longer than any lane takes is not confirmed.
 */
export function genexPhase(status: string | null | undefined, facts: GenexJobFacts = {}): MakingPhase {
  const word = status ?? "";
  const phase = Object.hasOwn(GENEX_PHASE, word) ? GENEX_PHASE[word] : undefined;
  if (facts.delivered && (!phase || phase === MakingPhase.Making)) return MakingPhase.NotInGame;
  const said = phase ?? MakingPhase.Making;
  const outlived = (facts.ageMs ?? 0) > GENEX_MAKING_MAX_MS;
  if (outlived && (said === MakingPhase.Making || said === MakingPhase.Queued)) return MakingPhase.Unsure;
  return said;
}

/** Genex's words for a job that ended without making anything: one it refused before starting has no card. */
const ENDED_UNMADE: ReadonlySet<string> = new Set([
  GenexJobStatus.Failed,
  GenexJobStatus.Canceled,
  GenexJobStatus.Stopped,
]);

/** Whether a Genex job ended without making its asset: failed, canceled or stopped. */
export const genexEndedUnmade = (status: string | null | undefined): boolean => ENDED_UNMADE.has(status ?? "");

/**
 * A Genex request that ended before Genex started a generation for it (no `generationId`), such as
 * one it could not quote: nothing was ever on its way, and the call that asked already said why.
 */
export const genexRefused = (job: { status?: string | null; generationId?: string | null }): boolean =>
  !job.generationId && genexEndedUnmade(job.status);

/**
 * A Genex job that gets a card: not an approved review (its run goes on in a new job), not a call
 * that makes nothing, and not a request Genex refused (`genexRefused`). A record that names no
 * operation is still shown, as an asset.
 */
export function genexJobShown(job: { operation?: string; status?: string; generationId?: string }): boolean {
  if (job.status === GenexJobStatus.Approved || genexRefused(job)) return false;
  return !job.operation || genexMaking(job.operation) !== null;
}

/**
 * One job still on its way, as the Assets inventory lists it and every surface reads it. `source` is
 * the plugin id (or `genex`), or a connector's id for a server no plugin ships; `sourceName` how the
 * person knows it. `tool` is the outside service doing the work, when known (a `GenexTool`, or a
 * plugin's own word). `kind` absent: an asset of a kind the plugin did not say. A call making an
 * asset is its own job while it runs: its `jobId` is the call's id.
 */
export interface MakingJob {
  source: string;
  sourceName?: string;
  jobId: string;
  at?: string;
  kind?: MakingKind;
  phase: MakingPhase;
  tool?: string;
  prompt?: string;
  /** The plugin's own word for the job and its own name for what was asked: kept for its own page. */
  pluginStatus?: string;
  operation?: string;
  /** It delivered files earlier that the game no longer holds. */
  delivered?: boolean;
}

/** Whether a source is Genex's own: its jobs are read from its records, never from its calls. */
export const isGenexSource = (source: string): boolean => source === GENEX_PLUGIN_ID;
