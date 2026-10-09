import { deliverAssetFiles } from "../genex-delivery.ts";
import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  PLUGIN_STILL_DEFAULT_BYTES,
  PLUGIN_STILL_MAX_BYTES,
  PLUGIN_STILL_MIN_BYTES,
  PLUGIN_STILL_VIEW_NAME,
  PluginService,
  type PluginBinding,
  type PluginStillOrder,
} from "../../shared/plugins.ts";
import { VIEWPORT_MAX, VIEWPORT_MIN } from "../preview-pool.ts";
import type { ExportResult } from "../game-export.ts";
import type { GenexGameManifest } from "../../shared/genex.ts";
import { readGenexGameManifest } from "../genex-game-manifest.ts";
import { SecretStore } from "../secrets.ts";
import { atomicWriteJson } from "../fsx.ts";
import { createHash } from "node:crypto";
import { assertRelativePath, containedReal, isBelow, isInside, toPosixRelative } from "../paths.ts";

const MAX_CREDENTIAL_CHARS = 65536;
const MAX_PROJECT_WRITE_CHARS = 2_000_000;
const MAX_OBSERVED_FILES = 1000;
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
  InvalidObservation: "Invalid observation: give { project, root, files }",
  InvalidStill: (why: string) => `Invalid still: ${why}`,
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

function requireBinding(binding: PluginBinding | undefined): PluginBinding {
  if (!binding) throw new Error(MESSAGE.ProjectRequired);
  return binding;
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
  /** The host's look at the bound game: its loaded files, or (with `still`) one named view. */
  readonly observe: (binding: PluginBinding, files: string[], still?: PluginStillOrder) => Promise<unknown>;
  constructor(
    dataRoot: string,
    adoptedRoots: Record<string, string>,
    observe: (binding: PluginBinding, files: string[], still?: PluginStillOrder) => Promise<unknown>,
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
    [PluginService.JobsRead]: async (call) =>
      JSON.parse(await readFile(await jobReferenceFile(call), "utf8").catch(() => "null")),
    [PluginService.JobsWrite]: async (call) => {
      await writeFile(await jobReferenceFile(call), JSON.stringify(call.args.value));
      return true;
    },
  };
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
  /**
   * `observe`: every argument is checked before the host looks: the bound game's own project and
   * root, a bounded list of files that exist inside it, and a still request (if any) with no files.
   */
  async #observeFiles({ args, binding }: ServiceCall): Promise<unknown> {
    if (args === null || typeof args !== "object" || typeof args.root !== "string")
      throw new Error(MESSAGE.InvalidObservation);
    const inWorktree =
      binding && args.project === binding.project && path.resolve(args.root) === path.resolve(binding.directory);
    if (!binding || !inWorktree) throw new Error(MESSAGE.OutsideWorktree);
    if (!Array.isArray(args.files) || args.files.length > MAX_OBSERVED_FILES) throw new Error(MESSAGE.InvalidAssetList);
    const still = args.still === undefined ? undefined : stillOrder(args.still);
    if (still && args.files.length) throw new Error(MESSAGE.InvalidStill(STILL_REFUSAL.Files));
    for (const file of args.files)
      await containedReal(binding.directory, file).catch((e: NodeJS.ErrnoException) => {
        if (isMissing(e)) throw new Error(MESSAGE.NotInWorkspace(file));
        throw e;
      });
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
