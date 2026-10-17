import { deliverAssetFiles } from "../genex-delivery.ts";
import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  ENGINE_ASSIST_TASK_MAX_CHARS,
  type EngineAssistAnswer,
  EngineAssistRefusal,
  PLUGIN_CLIP_DEFAULT_BYTES,
  PLUGIN_CLIP_DEFAULT_FPS,
  PLUGIN_CLIP_DEFAULT_SECONDS,
  PLUGIN_CLIP_MAX_BYTES,
  PLUGIN_CLIP_MAX_FPS,
  PLUGIN_CLIP_MAX_SECONDS,
  PLUGIN_CLIP_MIN_BYTES,
  PLUGIN_CLIP_MIN_FPS,
  PLUGIN_CLIP_MIN_SECONDS,
  PLUGIN_STILL_DEFAULT_BYTES,
  PLUGIN_STILL_MAX_BYTES,
  PLUGIN_STILL_MIN_BYTES,
  PLUGIN_STILL_VIEW_NAME,
  PluginService,
  type PluginBinding,
  type PluginClipOrder,
  type PluginStillOrder,
} from "../../shared/plugins.ts";
import { VIEWPORT_MAX, VIEWPORT_MIN } from "../preview-pool.ts";
import type { ExportResult } from "../game-export.ts";
import type { GenexGameManifest } from "../../shared/genex.ts";
import { readGenexGameManifest } from "../genex-game-manifest.ts";
import { SecretStore } from "../secrets.ts";
import { atomicWriteJson } from "../fsx.ts";
import { createHash } from "node:crypto";
import type { EngineLinkHost } from "./engine-links.ts";
import type { PluginInvocation } from "./process.ts";
import { assertRelativePath, containedReal, isBelow, isInside, toPosixRelative } from "../paths.ts";

const MAX_CREDENTIAL_CHARS = 65536;
const MAX_PROJECT_WRITE_CHARS = 2_000_000;
const MAX_OBSERVED_FILES = 1000;
/** The longest reason a plugin may give a snapshot: Rewind lists it as one line. */
const MAX_SNAPSHOT_REASON_CHARS = 200;
/** A game a plugin makes is titled in one plain line of at most this many characters. */
const MAX_GAME_TITLE_CHARS = 80;
/** A project name: it becomes a folder under the plugin's storage, so it can never be a path. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
const JOB_REFERENCE = /^[a-zA-Z0-9_-]{1,100}$/;
/** Project path segments a plugin may never read or write: dotfiles, dependencies and agent instructions. */
const PROTECTED_SEGMENTS = ["node_modules", "AGENTS.md", "CLAUDE.md"];

const MESSAGE = {
  InvalidCredential: "Invalid credential",
  ProjectRequired: "Project required",
  SourceEscapes: "Asset source escapes plugin storage",
  TargetEscapes: "Asset target escapes the game",
  Symlink: "Asset directory contains a symlink",
  NotRegular: "Asset is not a regular file",
  FileTooLarge: (limit: number) => `Asset exceeds ${limit} bytes per file; simplify it before delivery`,
  InvalidRoots: "Invalid saved delivery roots",
  ProjectTooLarge: (limit: number) =>
    `Plugin assets exceed ${limit} bytes across this project's workspaces; remove unused assets before delivery`,
  InvalidProjectName: "Invalid project name",
  ExportUnavailable: "Export unavailable",
  OutsideWorktree: "Observation is outside authorized worktree",
  InvalidAssetList: "Invalid asset list",
  NotInWorkspace: (file: string) => `Asset file is not in this workspace: ${file}`,
  ProtectedPath: "Protected project path",
  InvalidWrite: "Invalid project write",
  PathEscapes: "Path escapes project",
  SymlinkOutput: "Symlink output refused",
  InvalidJobReference: "Invalid job reference",
  EngineLinksUnavailable: "Engine links unavailable",
  InvalidSnapshotReason: `Invalid snapshot reason: one plain line of at most ${MAX_SNAPSHOT_REASON_CHARS} characters`,
  SnapshotsUnavailable: "Snapshots unavailable",
  InvalidGameTitle: `Invalid game title: one plain line of at most ${MAX_GAME_TITLE_CHARS} characters`,
  InvalidAssistTask: `Invalid task: one plain line of at most ${ENGINE_ASSIST_TASK_MAX_CHARS} characters`,
  GamesUnavailable: "Games unavailable",
  RunsUnavailable: "Runs unavailable",
  NotMadeHere: "A link may name only a game this plugin made, and only from outside another game",
  InvalidObservation: "Invalid observation: give { project, root, files }",
  InvalidStill: (why: string) => `Invalid still: ${why}`,
  InvalidClip: (why: string) => `Invalid clip: ${why}`,
  Unknown: "Unknown plugin service",
} as const;

/** Why a still request is refused, in the words of {@link MESSAGE.InvalidStill}. */
const STILL_REFUSAL = {
  NotObject: "it must be an object",
  UnknownKey: (key: string) => `unknown key ${JSON.stringify(key)}`,
  OneView: "name exactly one of demo or camera",
  ViewName: "a view name is 1–64 letters, digits, ':', '_' or '-', starting with a letter or digit",
  Side: (side: string, min: number, max: number) => `${side} must be a whole number from ${min} to ${max}`,
  Bytes: `maxBytes must be a whole number from ${PLUGIN_STILL_MIN_BYTES} to ${PLUGIN_STILL_MAX_BYTES}`,
  Files: "a still observes no files: send files: []",
} as const;
/** The keys a still request may carry. */
const STILL_KEYS = new Set(["demo", "camera", "width", "height", "maxBytes"]);

/** Why a clip request is refused, in the words of {@link MESSAGE.InvalidClip}. */
const CLIP_REFUSAL = {
  NotObject: "it must be an object",
  UnknownKey: (key: string) => `unknown key ${JSON.stringify(key)}`,
  Demo: "name the demo that stages it: 1–64 letters, digits, ':', '_' or '-', starting with a letter or digit",
  Side: STILL_REFUSAL.Side,
  Seconds: `seconds must be a number from ${PLUGIN_CLIP_MIN_SECONDS} to ${PLUGIN_CLIP_MAX_SECONDS}`,
  Fps: `fps must be a whole number from ${PLUGIN_CLIP_MIN_FPS} to ${PLUGIN_CLIP_MAX_FPS}`,
  Bytes: `maxBytes must be a whole number from ${PLUGIN_CLIP_MIN_BYTES} to ${PLUGIN_CLIP_MAX_BYTES}`,
  Files: "a clip observes no files: send files: []",
  Both: "ask for a still or a clip, not both",
} as const;
/** The keys a clip request may carry. */
const CLIP_KEYS = new Set(["demo", "width", "height", "seconds", "fps", "maxBytes"]);

/**
 * One service call: the plugin, its storage root, the backend's untyped arguments, the bound game,
 * and the call of the plugin's it was made on behalf of (absent for the host's own requests).
 */
interface ServiceCall {
  id: string;
  root: string;
  args: any;
  binding?: PluginBinding;
  invocation?: PluginInvocation;
}
type AssetLimits = { fileBytes: number; projectBytes: number };

/** A path under a dotfile folder, `node_modules`, or an agent instruction file. */
const isProtectedProjectPath = (relative: string) =>
  relative.split("/").some((part) => part.startsWith(".") || PROTECTED_SEGMENTS.includes(part));

const isMissing = (error: NodeJS.ErrnoException) => error.code === "ENOENT";

const isWholeWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** The one view a still names, as `{demo}` or `{camera}`; refused unless exactly one is a valid name. */
function stillView(still: Record<string, unknown>): { demo: string } | { camera: string } {
  const demo = still.demo;
  const camera = still.camera;
  if ((demo === undefined) === (camera === undefined)) throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.OneView));
  const name = demo ?? camera;
  if (typeof name !== "string" || !PLUGIN_STILL_VIEW_NAME.test(name))
    throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.ViewName));
  return demo === undefined ? { camera: name } : { demo: name };
}

/**
 * A plugin's still request, checked field by field and rebuilt from its known keys, so nothing
 * unchecked reaches the host: one view by a plain name, whole-pixel sides a pooled window can take,
 * and a byte limit (defaulted) within the host's bounds. Throws before anything else runs.
 */
export function stillOrder(raw: unknown): PluginStillOrder {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.NotObject));
  const still = raw as Record<string, unknown>;
  const unknown = Object.keys(still).find((key) => !STILL_KEYS.has(key));
  if (unknown !== undefined) throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.UnknownKey(unknown)));
  const view = stillView(still);
  if (!isWholeWithin(still.width, VIEWPORT_MIN.width, VIEWPORT_MAX.width))
    throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.Side("width", VIEWPORT_MIN.width, VIEWPORT_MAX.width)));
  if (!isWholeWithin(still.height, VIEWPORT_MIN.height, VIEWPORT_MAX.height))
    throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.Side("height", VIEWPORT_MIN.height, VIEWPORT_MAX.height)));
  const maxBytes = still.maxBytes === undefined ? PLUGIN_STILL_DEFAULT_BYTES : still.maxBytes;
  if (!isWholeWithin(maxBytes, PLUGIN_STILL_MIN_BYTES, PLUGIN_STILL_MAX_BYTES))
    throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.Bytes));
  return { ...view, width: still.width, height: still.height, maxBytes };
}

const isNumberWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** A clip's whole-pixel sides, each within what a pooled window can take. */
function clipSides(clip: Record<string, unknown>): { width: number; height: number } {
  const { width, height } = clip;
  if (!isWholeWithin(width, VIEWPORT_MIN.width, VIEWPORT_MAX.width))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Side("width", VIEWPORT_MIN.width, VIEWPORT_MAX.width)));
  if (!isWholeWithin(height, VIEWPORT_MIN.height, VIEWPORT_MAX.height))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Side("height", VIEWPORT_MIN.height, VIEWPORT_MAX.height)));
  return { width, height };
}

/** A clip's length, rate and byte limit, each defaulted when absent and refused when out of bounds. */
function clipPacing(clip: Record<string, unknown>): { seconds: number; fps: number; maxBytes: number } {
  const seconds = clip.seconds === undefined ? PLUGIN_CLIP_DEFAULT_SECONDS : clip.seconds;
  if (!isNumberWithin(seconds, PLUGIN_CLIP_MIN_SECONDS, PLUGIN_CLIP_MAX_SECONDS))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Seconds));
  const fps = clip.fps === undefined ? PLUGIN_CLIP_DEFAULT_FPS : clip.fps;
  if (!isWholeWithin(fps, PLUGIN_CLIP_MIN_FPS, PLUGIN_CLIP_MAX_FPS))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Fps));
  const maxBytes = clip.maxBytes === undefined ? PLUGIN_CLIP_DEFAULT_BYTES : clip.maxBytes;
  if (!isWholeWithin(maxBytes, PLUGIN_CLIP_MIN_BYTES, PLUGIN_CLIP_MAX_BYTES))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Bytes));
  return { seconds, fps, maxBytes };
}

/**
 * A plugin's clip request, checked field by field and rebuilt from its known keys, so nothing
 * unchecked reaches the host: the demo that stages it by a plain name, whole-pixel sides a pooled
 * window can take, and a length, rate and byte limit (each defaulted) within the host's bounds.
 * Throws before anything else runs.
 */
export function clipOrder(raw: unknown): PluginClipOrder {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.NotObject));
  const clip = raw as Record<string, unknown>;
  const unknown = Object.keys(clip).find((key) => !CLIP_KEYS.has(key));
  if (unknown !== undefined) throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.UnknownKey(unknown)));
  const demo = clip.demo;
  if (typeof demo !== "string" || !PLUGIN_STILL_VIEW_NAME.test(demo))
    throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Demo));
  return { demo, ...clipSides(clip), ...clipPacing(clip) };
}

/** The still or the clip an `observe` asks for, each checked, never both and never beside files. */
function observedView(args: { still?: unknown; clip?: unknown; files: unknown[] }): {
  still?: PluginStillOrder;
  clip?: PluginClipOrder;
} {
  if (args.still !== undefined && args.clip !== undefined) throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Both));
  if (args.clip !== undefined) {
    const clip = clipOrder(args.clip);
    if (args.files.length) throw new Error(MESSAGE.InvalidClip(CLIP_REFUSAL.Files));
    return { clip };
  }
  if (args.still === undefined) return {};
  const still = stillOrder(args.still);
  if (args.files.length) throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.Files));
  return { still };
}

function requireBinding(binding: PluginBinding | undefined): PluginBinding {
  if (!binding) throw new Error(MESSAGE.ProjectRequired);
  return binding;
}

/** A character Rewind could not show on one line: a control character, a line break included. */
const isControl = (char: string) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** A snapshot reason as Rewind lists it: one plain line of text, trimmed; anything else is refused. */
function snapshotReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  const plain = reason.length > 0 && reason.length <= MAX_SNAPSHOT_REASON_CHARS && ![...reason].some(isControl);
  if (!plain) throw new Error(MESSAGE.InvalidSnapshotReason);
  return reason;
}

/** A setup task a plugin hands to the chat: one plain line, trimmed, of at most {@link ENGINE_ASSIST_TASK_MAX_CHARS} characters. */
function assistTask(value: unknown): string {
  const task = typeof value === "string" ? value.trim() : "";
  const plain = task.length > 0 && task.length <= ENGINE_ASSIST_TASK_MAX_CHARS && ![...task].some(isControl);
  if (!plain) throw new Error(MESSAGE.InvalidAssistTask);
  return task;
}

/** Whether a call is Genex's own step: a moment's or an observer's, never the person's nor an agent's. */
const isGenexStep = (invocation: PluginInvocation | undefined, binding: PluginBinding | undefined): boolean =>
  !invocation || Boolean(binding?.hook || binding?.observe);

/**
 * Whether a call is the person's own: a plugin action they pressed, or a tool call whose own card
 * they approved (the host sets `confirmed`). A Genex moment's or an observer's step is never theirs.
 */
function isPersonsCall(invocation: PluginInvocation | undefined, binding: PluginBinding | undefined): boolean {
  if (!invocation || isGenexStep(invocation, binding)) return false;
  if (invocation.method === "action") return true;
  return invocation.method === "tool" && invocation.confirmed === true;
}

/** A game title a plugin asked for: one plain line, trimmed, of at most {@link MAX_GAME_TITLE_CHARS} characters. */
function gameTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  const plain = title.length > 0 && title.length <= MAX_GAME_TITLE_CHARS && ![...title].some(isControl);
  if (!plain) throw new Error(MESSAGE.InvalidGameTitle);
  return title;
}

/** Bytes of regular files under `dir` (none when it is missing); any link or special file is refused. */
async function directoryBytes(dir: string, fileLimit: number | undefined): Promise<number> {
  const entries = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (isMissing(e)) return [];
    throw e;
  });
  let bytes = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(MESSAGE.Symlink);
    if (info.isDirectory()) bytes += await directoryBytes(file, fileLimit);
    else if (info.isFile()) {
      if (fileLimit !== undefined && info.size > fileLimit) throw new Error(MESSAGE.FileTooLarge(fileLimit));
      bytes += info.size;
    } else throw new Error(MESSAGE.NotRegular);
  }
  return bytes;
}

/** The delivery roots recorded for this project, so a quota counts every workspace it delivered to. */
async function savedDeliveryRoots(rootFile: string): Promise<string[]> {
  const previous = JSON.parse(
    await readFile(rootFile, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (isMissing(e)) return "[]";
      throw e;
    }),
  ) as string[];
  if (!Array.isArray(previous) || previous.some((p) => typeof p !== "string" || !path.isAbsolute(p)))
    throw new Error(MESSAGE.InvalidRoots);
  return previous;
}

async function credentialStore(root: string) {
  return SecretStore.open(path.join(root, "credentials"));
}

async function readProjectFile({ args, binding }: ServiceCall) {
  const bound = requireBinding(binding);
  assertRelativePath(args.path);
  if (isProtectedProjectPath(args.path)) throw new Error(MESSAGE.ProtectedPath);
  return readFile(await containedReal(bound.directory, args.path), "utf8");
}

async function writeProjectFile({ args, binding }: ServiceCall) {
  if (!binding || typeof args.text !== "string" || args.text.length > MAX_PROJECT_WRITE_CHARS)
    throw new Error(MESSAGE.InvalidWrite);
  assertRelativePath(args.path);
  if (isProtectedProjectPath(args.path)) throw new Error(MESSAGE.ProtectedPath);
  const parent = await realpath(path.dirname(path.join(binding.directory, args.path)));
  const base = await realpath(binding.directory);
  if (!isInside(base, parent)) throw new Error(MESSAGE.PathEscapes);
  const dest = path.join(parent, path.basename(args.path));
  const resolved = await realpath(dest).catch(() => dest);
  if (resolved !== dest) throw new Error(MESSAGE.SymlinkOutput);
  await writeFile(dest, args.text);
  return { file: args.path };
}

/** The file a job reference is kept in, after checking the id and creating its folder. */
async function jobReferenceFile({ root, args }: ServiceCall): Promise<string> {
  if (!JOB_REFERENCE.test(args.id)) throw new Error(MESSAGE.InvalidJobReference);
  const dir = path.join(root, "references");
  await mkdir(dir, { recursive: true });
  return path.join(dir, `${args.id}.json`);
}

/**
 * The host's look at the bound game. A clip comes as the fourth argument, and only then: a call
 * with no clip is the three-argument call it always was.
 */
export type PluginObserve = (
  binding: PluginBinding,
  files: string[],
  still?: PluginStillOrder,
  clip?: PluginClipOrder,
) => Promise<unknown>;

export class PluginServices {
  readonly dataRoot: string;
  readonly adoptedRoots: Record<string, string>;
  /** The host's look at the bound game: its loaded files, (with `still`) one named view, or (with `clip`) a recorded moment. */
  readonly observe: PluginObserve;
  constructor(dataRoot: string, adoptedRoots: Record<string, string>, observe: PluginObserve) {
    this.dataRoot = dataRoot;
    this.adoptedRoots = adoptedRoots;
    this.observe = observe;
  }
  onEvent: ((id: string, event: unknown, binding?: PluginBinding) => void) | undefined;
  /** Host ledger hook after files land in the game; awaited, failures swallowed so delivery never fails on bookkeeping. */
  onDelivered:
    | ((id: string, delivered: { jobId: string; files: string[] }, binding: PluginBinding) => Promise<void>)
    | undefined;
  /** Host export: writes the public copy of the bound game into `target`. Unset → `export.stage` reports 'Export unavailable'. */
  exportStage: ((binding: PluginBinding, target: string, pluginId: string) => Promise<ExportResult>) | undefined;
  assetRoot: ((binding: PluginBinding) => Promise<string>) | undefined;
  assetLimits: ((id: string) => AssetLimits | undefined) | undefined;
  /** Host engine links (`game.engine.*`). Unset → those services report 'Engine links unavailable'. */
  engineLinks: EngineLinkHost | undefined;
  /** Host snapshots (`game.snapshot`): a game snapshot of the bound game. Unset → 'Snapshots unavailable'. */
  gameSnapshot: ((binding: PluginBinding, reason: string) => Promise<{ snapshotId: string }>) | undefined;
  /** Host games (`game.create`): makes a Genex game with this title; its name and folder. Unset → 'Games unavailable'. */
  gameCreate: ((title: string) => Promise<{ project: string; directory: string }>) | undefined;
  /**
   * Host assists (`game.engine.assist`): hands a setup task to the bound game's chat. Never reached
   * from a Genex moment or an observer; `asked` says whether the person made the call (a press, or a
   * card they approved). Unset, every call answers `unavailable`.
   */
  engineAssist:
    | ((
        pluginId: string,
        binding: PluginBinding | undefined,
        task: string,
        call: { asked: boolean; signal?: AbortSignal },
      ) => Promise<EngineAssistAnswer>)
    | undefined;
  /**
   * Host assists' reach (`game.engine.canAssist`): whether Do it for me can run for the plugin on this
   * computer. Unset, it never can.
   */
  engineCanAssist: ((pluginId: string) => Promise<boolean>) | undefined;
  /** Host runs (`game.engine.runs`): the games whose run is going now. Unset → 'Runs unavailable'. */
  runningGames: (() => Promise<Array<{ project: string; directory: string; title: string }>>) | undefined;
  /** The games each plugin made through `game.create` while this host runs, by name, with their folders. */
  #madeGames = new Map<string, Map<string, string>>();
  #deliveries = new Map<string, Promise<unknown>>();
  root(id: string) {
    return this.adoptedRoots[id] ?? path.join(this.dataRoot, id);
  }
  /** Each service this host answers. Capability checks happen before a call reaches here. */
  #handlers: Record<string, (call: ServiceCall) => Promise<unknown>> = {
    [PluginService.StorageRoot]: async ({ root }) => root,
    [PluginService.EventsEmit]: async ({ id, args, binding }) => {
      this.onEvent?.(id, args, binding);
      return true;
    },
    [PluginService.CredentialsRead]: async ({ id, root }) => (await credentialStore(root)).get(id),
    [PluginService.CredentialsWrite]: async ({ id, root, args }) => {
      const store = await credentialStore(root);
      if (typeof args.token !== "string" || args.token.length > MAX_CREDENTIAL_CHARS)
        throw new Error(MESSAGE.InvalidCredential);
      return store.set(id, args.token);
    },
    [PluginService.CredentialsClear]: async ({ id, root }) => (await credentialStore(root)).delete(id),
    [PluginService.AssetsDeliver]: (call) => this.#deliver(call),
    [PluginService.ExportStage]: (call) => this.#exportStage(call),
    [PluginService.Observe]: (call) => this.#observeFiles(call),
    [PluginService.ProjectRead]: readProjectFile,
    [PluginService.ProjectWrite]: writeProjectFile,
    [PluginService.GameEngineLink]: ({ id, args, binding }) =>
      this.#engine().link(id, this.#linkBinding(id, args, binding), args),
    [PluginService.GameCreate]: ({ id, args }) => this.#createGame(id, args?.title),
    [PluginService.GameEngineRead]: ({ id, binding }) => this.#engine().read(id, requireBinding(binding)),
    [PluginService.GameEngineSteps]: ({ id, binding }) => this.#engine().steps(id, requireBinding(binding)),
    [PluginService.GameSnapshot]: ({ args, binding }) => this.#gameSnapshot(requireBinding(binding), args?.reason),
    [PluginService.GameEngineRuns]: ({ id }) => this.#engineRuns(id),
    [PluginService.GameEngineAssist]: (call) => this.#assist(call),
    [PluginService.GameEngineCanAssist]: async ({ id }) => (this.engineCanAssist ? this.engineCanAssist(id) : false),
    [PluginService.JobsRead]: async (call) =>
      JSON.parse(await readFile(await jobReferenceFile(call), "utf8").catch(() => "null")),
    [PluginService.JobsWrite]: async (call) => {
      await writeFile(await jobReferenceFile(call), JSON.stringify(call.args.value));
      return true;
    },
  };
  /** A game snapshot of the bound game under the plugin's reason, checked before anything is taken. */
  async #gameSnapshot(binding: PluginBinding, reason: unknown): Promise<{ snapshotId: string }> {
    const checked = snapshotReason(reason);
    if (!this.gameSnapshot) throw new Error(MESSAGE.SnapshotsUnavailable);
    return this.gameSnapshot(binding, checked);
  }
  /**
   * Do it for me: a Genex moment's or an observer's step answers `not-person` and nothing happens;
   * any other call reaches the host with a task it can show verbatim, marked `asked` when it is the
   * person's own (`isPersonsCall`), and the host decides whose unasked call may start one.
   */
  async #assist({ id, args, binding, invocation }: ServiceCall): Promise<EngineAssistAnswer> {
    if (isGenexStep(invocation, binding)) return { started: false, reason: EngineAssistRefusal.NotPerson };
    const task = assistTask(args?.task);
    if (!this.engineAssist) return { started: false, reason: EngineAssistRefusal.Unavailable };
    const asked = isPersonsCall(invocation, binding);
    return this.engineAssist(id, binding, task, {
      asked,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
  }
  /** The games whose run is going now that this plugin linked to a project, with that project. */
  async #engineRuns(id: string): Promise<Array<{ game: string; title: string; project: string }>> {
    if (!this.runningGames) throw new Error(MESSAGE.RunsUnavailable);
    const runs: Array<{ game: string; title: string; project: string }> = [];
    for (const game of await this.runningGames()) {
      const binding = { project: game.project, directory: game.directory };
      const link = await this.#engine()
        .read(id, binding)
        .catch(() => null);
      if (link) runs.push({ game: game.project, title: game.title, project: link.project });
    }
    return runs;
  }
  /** A game the plugin asked for, made by the host and remembered as the plugin's to link. */
  async #createGame(id: string, title: unknown): Promise<{ project: string; directory: string }> {
    const checked = gameTitle(title);
    if (!this.gameCreate) throw new Error(MESSAGE.GamesUnavailable);
    const made = await this.gameCreate(checked);
    const games = this.#madeGames.get(id) ?? new Map<string, string>();
    games.set(made.project, made.directory);
    this.#madeGames.set(id, games);
    return made;
  }

  /**
   * The game a link is for: the bound game, or (`game` named, from outside any game) one this very
   * plugin made through `game.create`; anything else is refused before the link is made.
   */
  #linkBinding(id: string, args: unknown, binding: PluginBinding | undefined): PluginBinding {
    const game = args && typeof args === "object" ? (args as { game?: unknown }).game : undefined;
    if (game === undefined) return requireBinding(binding);
    const directory = typeof game === "string" ? this.#madeGames.get(id)?.get(game) : undefined;
    if (directory === undefined || binding?.project) throw new Error(MESSAGE.NotMadeHere);
    return { ...binding, project: game as string, directory };
  }

  #engine(): EngineLinkHost {
    if (!this.engineLinks) throw new Error(MESSAGE.EngineLinksUnavailable);
    return this.engineLinks;
  }
  async call(
    id: string,
    method: string,
    args: any,
    binding?: PluginBinding,
    invocation?: PluginInvocation,
  ): Promise<unknown> {
    const root = this.root(id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const handler = Object.hasOwn(this.#handlers, method) ? this.#handlers[method] : undefined;
    if (!handler) throw new Error(MESSAGE.Unknown);
    return handler({ id, root, args, binding, ...(invocation ? { invocation } : {}) });
  }
  /** Deliver files, one delivery at a time per plugin and project. */
  async #deliver(call: ServiceCall): Promise<unknown> {
    const binding = requireBinding(call.binding);
    // Concurrent workers share one quota check and delivery boundary for this project/plugin.
    const key = `${call.id}:${binding.project}`;
    const operation = (this.#deliveries.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#deliverNow(call, binding));
    this.#deliveries.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#deliveries.get(key) === operation) this.#deliveries.delete(key);
    }
  }
  async #deliverNow({ id, root, args }: ServiceCall, binding: PluginBinding): Promise<string[]> {
    const source = await realpath(String(args.output));
    const base = await realpath(root);
    if (!isBelow(base, source)) throw new Error(MESSAGE.SourceEscapes);
    const limits = this.assetLimits?.(id);
    const target = this.assetRoot ? await this.assetRoot(binding) : binding.directory;
    await mkdir(target, { recursive: true });
    const canonicalTarget = await realpath(target);
    const canonicalGame = await realpath(binding.directory);
    if (!isInside(canonicalGame, canonicalTarget)) throw new Error(MESSAGE.TargetEscapes);
    const beforeCopy = limits ? await projectQuota(id, root, binding, source, canonicalTarget, limits) : undefined;
    const delivered = await deliverAssetFiles(source, canonicalTarget, args.jobId, id, {
      reuseExisting: true,
      beforeCopy,
    });
    const files = delivered.map((file) =>
      toPosixRelative(path.relative(canonicalGame, path.join(canonicalTarget, file))),
    );
    if (this.onDelivered) {
      try {
        await this.onDelivered(id, { jobId: String(args.jobId), files }, binding);
      } catch {}
    }
    return files;
  }
  /** The public copy, plus what the game's package.json tells Genex (the copy itself carries no package.json). */
  async #exportStage({ id, root, binding }: ServiceCall): Promise<ExportResult & { genex?: GenexGameManifest }> {
    const bound = requireBinding(binding);
    if (!PROJECT_NAME.test(bound.project)) throw new Error(MESSAGE.InvalidProjectName);
    if (!this.exportStage) throw new Error(MESSAGE.ExportUnavailable);
    const target = path.join(root, "publish", bound.project, "dist");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const result = await this.exportStage(bound, target, id);
    const genex = await readGenexGameManifest(bound.directory);
    return genex ? { ...result, genex } : result;
  }
  /**
   * `observe`: every argument is checked before the host looks: the bound game's own project and
   * root, a bounded list of files that exist inside it, and a still or a clip request (if any, never
   * both) with no files.
   */
  async #observeFiles({ args, binding }: ServiceCall): Promise<unknown> {
    if (args === null || typeof args !== "object" || typeof args.root !== "string")
      throw new Error(MESSAGE.InvalidObservation);
    const inWorktree =
      binding && args.project === binding.project && path.resolve(args.root) === path.resolve(binding.directory);
    if (!binding || !inWorktree) throw new Error(MESSAGE.OutsideWorktree);
    if (!Array.isArray(args.files) || args.files.length > MAX_OBSERVED_FILES) throw new Error(MESSAGE.InvalidAssetList);
    const { still, clip } = observedView(args);
    for (const file of args.files)
      await containedReal(binding.directory, file).catch((e: NodeJS.ErrnoException) => {
        if (isMissing(e)) throw new Error(MESSAGE.NotInWorkspace(file));
        throw e;
      });
    if (clip) return this.observe(binding, [], undefined, clip);
    return this.observe(binding, args.files, still);
  }
}

/**
 * Check the per-file limit now and return the per-project check that runs just before copying.
 * Host-authorized delivery roots are remembered across chats, worktrees and restart; the check
 * counts files that still exist, not a second generation/credit ledger.
 */
async function projectQuota(
  id: string,
  root: string,
  binding: PluginBinding,
  source: string,
  canonicalTarget: string,
  limits: AssetLimits,
): Promise<(newBytes: number) => Promise<void>> {
  const projectHash = createHash("sha256").update(binding.project).digest("hex");
  const rootFile = path.join(root, "delivery-roots", `${projectHash}.json`);
  const roots = [...new Set([...(await savedDeliveryRoots(rootFile)), canonicalTarget])];
  await directoryBytes(source, limits.fileBytes);
  let existing = 0;
  for (const directory of roots) existing += await directoryBytes(path.join(directory, "assets", id), undefined);
  return async (newBytes) => {
    if (existing + newBytes > limits.projectBytes) throw new Error(MESSAGE.ProjectTooLarge(limits.projectBytes));
    await atomicWriteJson(rootFile, roots);
  };
}
