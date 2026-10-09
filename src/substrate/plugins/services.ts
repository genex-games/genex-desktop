import { deliverAssetFiles } from "../genex-delivery.ts";
import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { PluginService, type PluginBinding } from "../../shared/plugins.ts";
import type { ExportResult } from "../game-export.ts";
import type { GenexGameManifest } from "../../shared/genex.ts";
import { readGenexGameManifest } from "../genex-game-manifest.ts";
import { SecretStore } from "../secrets.ts";
import { atomicWriteJson } from "../fsx.ts";
import { createHash } from "node:crypto";
import type { EngineLinkHost } from "./engine-links.ts";
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
  GamesUnavailable: "Games unavailable",
  RunsUnavailable: "Runs unavailable",
  NotMadeHere: "A link may name only a game this plugin made, and only from outside another game",
  Unknown: "Unknown plugin service",
} as const;

/** One service call: the plugin, its storage root, the backend's untyped arguments and the bound game. */
interface ServiceCall {
  id: string;
  root: string;
  args: any;
  binding?: PluginBinding;
}
type AssetLimits = { fileBytes: number; projectBytes: number };

/** A path under a dotfile folder, `node_modules`, or an agent instruction file. */
const isProtectedProjectPath = (relative: string) =>
  relative.split("/").some((part) => part.startsWith(".") || PROTECTED_SEGMENTS.includes(part));

const isMissing = (error: NodeJS.ErrnoException) => error.code === "ENOENT";

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

export class PluginServices {
  readonly dataRoot: string;
  readonly adoptedRoots: Record<string, string>;
  readonly observe: (binding: PluginBinding, files: string[]) => Promise<unknown>;
  constructor(
    dataRoot: string,
    adoptedRoots: Record<string, string>,
    observe: (binding: PluginBinding, files: string[]) => Promise<unknown>,
  ) {
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
  async call(id: string, method: string, args: any, binding?: PluginBinding): Promise<unknown> {
    const root = this.root(id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const handler = Object.hasOwn(this.#handlers, method) ? this.#handlers[method] : undefined;
    if (!handler) throw new Error(MESSAGE.Unknown);
    return handler({ id, root, args, binding });
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
  async #observeFiles({ args, binding }: ServiceCall): Promise<unknown> {
    const inWorktree =
      binding && args.project === binding.project && path.resolve(args.root) === path.resolve(binding.directory);
    if (!binding || !inWorktree) throw new Error(MESSAGE.OutsideWorktree);
    if (!Array.isArray(args.files) || args.files.length > MAX_OBSERVED_FILES) throw new Error(MESSAGE.InvalidAssetList);
    for (const file of args.files)
      await containedReal(binding.directory, file).catch((e: NodeJS.ErrnoException) => {
        if (isMissing(e)) throw new Error(MESSAGE.NotInWorkspace(file));
        throw e;
      });
    return this.observe(binding, args.files);
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
