import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Activate, PluginContext, PluginScalar } from "../../plugin-sdk/index.d.ts";
import type { PluginNativeResult } from "../../plugin-sdk/index.d.ts";
import { STUDIO_BLENDER_RESULT } from "./wrapper.ts";

/**
 * The host services this plugin calls, by their public SDK names. Kept here rather than imported
 * from Studio, so the example stays SDK-only for authors who copy it.
 */
const HostService = {
  AssetsDeliver: "assets.deliver",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
  NativeRun: "native.run",
  NativeJobs: "native.jobs",
  NativeResult: "native.result",
  ProjectRead: "project.read",
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
} as const;
/** The native job state a finished model run reports. */
const JOB_COMPLETED = "completed";
/** The runtime state of a Blender that runs here. */
const RUNTIME_READY = "ready";

/** The native runtime every call of this plugin names. */
const BLENDER = { runtime: "blender" } as const;
/** An asset name: lowercase, digits and dashes, so it is safe as a file name and a CLI value. */
const ASSET_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An asset name as agents write it: also capitals and underscores, which become an {@link ASSET_SLUG}. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** The renders a model job may leave for the agent to inspect. */
const RENDER_FILES = ["render.png", "render-front.png"];
/** Where a script lives when the call names none: `assets/src/<name>.py`. */
const SCRIPT_FOLDER = "assets/src";

/** The most game files one job may read beside its script and model. */
export const MAX_EXTRA_INPUTS = 8;
/** The compose recipe's input slots: a model and every extra input (plugin.json declares as many). */
const INPUT_SLOTS = MAX_EXTRA_INPUTS + 1;
const MIB = 1024 * 1024;
/** The largest one extra input may be. */
const MAX_INPUT_BYTES = 32 * MIB;
/** The largest a job's extra inputs may be together. */
const MAX_INPUTS_BYTES = 64 * MIB;
/** The longest game path an extra input may have, so all of them fit the job's `inputs` value. */
const MAX_INPUT_PATH_CHARS = 120;
/**
 * The folders extra inputs come from, and the one a script's own modules live in: a web game's
 * asset folders, and a Godot game's project (`godot/`, where Genex delivers into its `assets/`).
 */
const INPUT_ROOTS = ["assets/", "public/assets/", "godot/assets/"];
const MODULE_ROOT = `${SCRIPT_FOLDER}/`;
const MODULE_EXTENSION = ".py";
/** The kinds of file a script may read: its modules, data, pictures and models. */
const INPUT_EXTENSIONS = new Set([MODULE_EXTENSION, ".json", ".png", ".jpg", ".jpeg", ".glb"]);
/** One plain path segment: no leading dot, space, backslash or other punctuation. */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
/** Segments a job never reads, whatever the folder: dependencies, agent files and key material. */
const PROTECTED_SEGMENTS = new Set(["node_modules", "AGENTS.md", "CLAUDE.md"]);
const SECRET_NAME = /^(credentials|secrets|id_rsa|id_ed25519)(\.|$)/i;
/** The label the compose job's `inputs` value gives the model's slot. */
const MODEL_SLOT = "model";
/** A control character or a backslash: never in a path a native job is handed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are refused.
const CONTROL_OR_BACKSLASH = /[\x00-\x1f\\]/;
/** How much of a refused script a refusal quotes back. */
const QUOTE_CHARS = 60;

/** The setup actions plugin.json declares. */
const BlenderAction = { Status: "status", Install: "install", CancelInstall: "cancel-install" } as const;
/** The agent tools plugin.json declares. */
const BlenderTool = { Status: "status", Retrieve: "retrieve", Model: "model", Install: "install" } as const;
/**
 * The native jobs plugin.json declares: a new model from a script, a transform of an existing one,
 * or either with extra game files the script reads.
 */
const BlenderJob = { Model: "model", Transform: "transform", Compose: "compose" } as const;
/** The job's `rig` value: whether armatures and their actions go into the GLB. */
const RigValue = { On: "1", Off: "0" } as const;
/**
 * The engines this plugin guides by name: as studio.json's `engine.kind` names them (absent: the
 * web), and Unity, by the Unity project in the game's folder.
 */
const GameEngine = { Web: "web", Unreal: "unreal", Unity: "unity" } as const;
type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];
/** How the host spells an engine's id (`shared/game-engine.ts` `ENGINE_ID`); any other spelling links no engine. */
const ENGINE_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** The engine a game builds in: one this plugin guides by name, or any other engine's id. */
type EngineKind = GameEngine | string;
/** The game's own record, where a game linked to an engine names it. */
const STUDIO_JSON = "studio.json";
/** Where a game holds its Unity project's version file: the game is the project, or it is in unity/. */
const UNITY_VERSION_FILES = ["ProjectSettings/ProjectVersion.txt", "unity/ProjectSettings/ProjectVersion.txt"];
/** A Godot project's settings file, in the folder Genex delivered a Godot game's files into. */
const GODOT_PROJECT_FILE = "project.godot";
/** The folder delivered files land in, inside the delivery's root (`assets/<plugin>/<job>/`). */
const DELIVERED_FOLDER = "assets/";

const MESSAGE = {
  UnknownAction: "Unknown Blender action",
  UnknownOperation: "Unknown Blender operation",
  NoRecordedJob: "No recorded job in this project",
  BadSlug:
    "Use an asset name of letters, digits, dashes or underscores, at most 40, starting with a letter or digit (snake_case and capitals become lowercase with dashes).",
  JobFailed: (id: string, reason: string) => `Blender job ${id}: ${reason}`,
  NoExport: "no completed export",
  InputsNeedGame: "Extra inputs need a game: call this from a game's chat.",
  TooManyInputs: `Pass at most ${MAX_EXTRA_INPUTS} extra inputs.`,
  SameInputName: "Two inputs share a file name; a job takes each file name once.",
  InputsTooLarge: `The extra inputs are more than ${MAX_INPUTS_BYTES / MIB} MiB together.`,
  InputPath: (file: string) =>
    `Input ${file}: name a file by its plain path inside this game (letters, digits, dots, dashes and underscores; no dotfiles or parent folders; at most ${MAX_INPUT_PATH_CHARS} characters).`,
  InputPlace: (file: string) =>
    `Input ${file}: inputs are .py modules in ${MODULE_ROOT}, or .json, .png, .jpg or .glb files under assets/, public/assets/ or godot/assets/.`,
  InputProtected: (file: string) => `Input ${file}: dependencies, agent files and key material are never inputs.`,
  InputMissing: (file: string) => `Input ${file} does not exist in this game.`,
  InputLink: (file: string) => `Input ${file} goes through a symbolic link; name the file itself.`,
  InputNotFile: (file: string) => `Input ${file} is not a file.`,
  InputTooLarge: (file: string) => `Input ${file} is more than ${MAX_INPUT_BYTES / MIB} MiB.`,
  ScriptNotPath: (script: string) =>
    `script takes the path of a bpy script in this game, such as ${SCRIPT_FOLDER}/house.py, never code: write the script to that file first, then pass its path (${JSON.stringify(clip(script))} is no such path).`,
  ScriptMissing: (file: string) =>
    `No script at ${file}: write the bpy script to that file first (a regular file, not a link), then call blender__model again with its path as script.`,
  Renamed: (name: string, slug: string) => `The asset name ${name} became ${slug}.`,
  WebGuidance:
    "Files are relative to the game workspace. Load model.glb with GLTFLoader at its returned asset path (omit public/ in a built app URL). Inspect these renders, integrate the mesh into the scene, then use the preview to verify visible use. A delivered file alone is not integration proof.",
  UnrealGuidance:
    "Files are relative to the game folder. Inspect these renders first, then import model.glb into Unreal with the editor's import tools: Blender metres become Unreal centimetres (x100), +Z stays up and +X stays forward, so model with the pivot at the base and the front along +X. Look at it in the level from the player's view: a delivered file alone is not integration proof.",
  EngineGuidance:
    "Files are relative to the game folder. Inspect these renders first, then bring model.glb in with the engine's own import tools: Blender's +Z is up and one unit is a metre, so check the model's scale and which way it faces once it is in. Look at it in the game from the player's view: a delivered file alone is not integration proof.",
  GodotGuidance: (resPath: string) =>
    `Files are relative to the game folder; the model is inside the Godot project as ${resPath}. Inspect these renders first, then use it in a scene: an ext_resource of type PackedScene with that path, instanced as a node (or load(...).instantiate() in GDScript). Godot imports it on godot__check. Blender metres are Godot metres and +Z up becomes +Y up; model with the pivot at the base. Look at it with godot__screenshot from the player's view: a delivered file alone is not integration proof.`,
  UnityGuidance:
    "Files are relative to the game folder, beside its Unity project. Inspect these renders first, then bring model.glb into the project: Unity reads .glb only through the glTFast package (com.unity.cloud.gltfast), so add it with the editor's package_add when the project lacks it, then call import_asset with the delivered file as source (a path relative to the Unity project) and a path under Assets/. Blender metres are Unity metres and +Z up becomes +Y up; model with the pivot at the base and check which way it faces in the scene. Look at it with capture_game_view from the player's view: a delivered file alone is not integration proof.",
  NotReady: (detail: string) =>
    `Local Blender can't run on this Mac: ${detail} Tell the user in your next reply, since they may want Blender used: Genex can download the Blender it pins (about 350 MB) into its own storage and leaves their Blender as it is. Call blender__install to ask them (they confirm it on a card, and the download takes a few minutes), or they press Download Blender in Settings, Plugins, Local Blender. Until blender__status reads ready, don't make these models another way without saying so.`,
  InstallStarted:
    "The download of the Blender Genex pins has started in Genex's storage; the user's own Blender stays as it is. Call blender__status until its runtime reads ready (a few minutes), then model.",
  UnrealJoin: (meshes: number) =>
    `This file holds ${meshes} meshes: Unreal imports one mesh per file best, so join them unless a part must move on its own.`,
  RigLeftOut: (armatures: number) =>
    `The scene's ${armatures === 1 ? "armature was" : `${armatures} armatures were`} left out: pass rig to export armatures with their actions.`,
} as const;

type ToolArgs = Record<string, PluginScalar>;
/** One native job request, as `native.run` takes it. */
type NativeRequest = { job: string; inputs: Record<string, string>; values: Record<string, string> };

// Agents get durable IDs and delivered relative paths. Host output roots/logs belong to setup.
const publicJob = (job: PluginNativeResult) => ({
  id: job.id,
  state: job.state,
  runtime: job.runtime,
  version: job.version,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt,
  files: job.files,
  exitCode: job.exitCode,
});

/** The wrapper's JSON result line from a job's stdout, when it printed one. */
function blenderResult(job: PluginNativeResult) {
  const line = job.stdout?.split("\n").findLast((l) => l.startsWith(STUDIO_BLENDER_RESULT));
  return line ? JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length)) : null;
}

/** The source model a transform started from, recorded with the delivery. */
function derivedFrom(args: ToolArgs, job: PluginNativeResult) {
  return args.model ? { derivedFrom: { file: String(args.model), sha256: job.inputs?.model?.sha256 } } : {};
}

/** The job's renders as inline images for the agent to inspect. */
async function renderImages(job: PluginNativeResult) {
  const images = [];
  for (const file of RENDER_FILES)
    if (job.files.includes(file))
      images.push({
        label: file,
        mimeType: "image/png",
        data: (await readFile(path.join(job.output, file))).toString("base64"),
      });
  return images;
}

/** The asset's name as a slug: `Wall_Panel` becomes `wall-panel`; anything else unusable is refused. */
function assetSlug(name: string): string {
  if (!ASSET_NAME.test(name)) throw new Error(MESSAGE.BadSlug);
  const slug = name.toLowerCase().replace(/_/g, "-").replace(/-+/g, "-").replace(/-$/, "");
  if (!ASSET_SLUG.test(slug)) throw new Error(MESSAGE.BadSlug);
  return slug;
}

/** Whether `relative` names a regular file in the game, without following a link. */
async function isGameFile(directory: string | undefined, relative: string): Promise<boolean> {
  if (!directory) return false;
  const info = await lstat(path.join(directory, relative)).catch(() => null);
  return Boolean(info?.isFile());
}

/** The script the call names, or the one at its asset name: `assets/src/<name>.py` as written, else its slug's. */
async function namedScript(args: ToolArgs, name: string, slug: string, directory: string | undefined): Promise<string> {
  if (args.script) return String(args.script);
  const written = `${SCRIPT_FOLDER}/${name}.py`;
  const slugged = `${SCRIPT_FOLDER}/${slug}.py`;
  if (slugged === written || (await isGameFile(directory, written))) return written;
  return (await isGameFile(directory, slugged)) ? slugged : written;
}

/**
 * The script to run: the one named, else `assets/src/<name>.py` with the name as written, else with
 * its slug when only that file exists. Code passed as the script, a path the host would refuse, and
 * (in a game) a path that is no regular file there are refused here with what script takes, before
 * anything runs; a missing script is reported by the name as written. The host checks it again.
 */
async function scriptFor(args: ToolArgs, name: string, slug: string, directory: string | undefined): Promise<string> {
  const script = await namedScript(args, name, slug, directory);
  if (!isRelativePath(script)) throw new Error(MESSAGE.ScriptNotPath(script));
  if (directory && !(await isGameFile(directory, script))) {
    const looksLikePath = isPlainPath(script) && script.endsWith(MODULE_EXTENSION);
    throw new Error(looksLikePath ? MESSAGE.ScriptMissing(script) : MESSAGE.ScriptNotPath(script));
  }
  return script;
}

/** The shape a native job's input path must have: relative, `/`-separated, no control character, backslash, `.` or `..`. */
function isRelativePath(file: string): boolean {
  if (!file || CONTROL_OR_BACKSLASH.test(file) || path.isAbsolute(file)) return false;
  return file.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

/** `text` cut to a short quote, for a refusal that repeats what it was given. */
function clip(text: string): string {
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text;
}

/** A plain relative path of plain segments, short enough to label a job slot. */
function isPlainPath(relative: string): boolean {
  return relative.length <= MAX_INPUT_PATH_CHARS && relative.split("/").every((s) => PATH_SEGMENT.test(s));
}

/** A module under `assets/src/`, or data, a picture or a model under the game's asset folders. */
function isInputPlace(relative: string): boolean {
  const extension = path.posix.extname(relative).toLowerCase();
  if (!INPUT_EXTENSIONS.has(extension)) return false;
  if (extension === MODULE_EXTENSION) return relative.startsWith(MODULE_ROOT);
  return INPUT_ROOTS.some((root) => relative.startsWith(root));
}

const isProtectedSegment = (segment: string) => PROTECTED_SEGMENTS.has(segment) || SECRET_NAME.test(segment);

/**
 * One extra input's size, after checking it is a regular file inside the game reached through no
 * symbolic link at all. The host checks it again when it stages the file; this check only reads.
 */
async function gameInputBytes(directory: string, relative: string): Promise<number> {
  if (!isPlainPath(relative)) throw new Error(MESSAGE.InputPath(relative));
  if (!isInputPlace(relative)) throw new Error(MESSAGE.InputPlace(relative));
  const segments = relative.split("/");
  if (segments.some(isProtectedSegment)) throw new Error(MESSAGE.InputProtected(relative));
  let at = await realpath(directory);
  for (const segment of segments) {
    at = path.join(at, segment);
    const info = await lstat(at).catch(() => null);
    if (!info) throw new Error(MESSAGE.InputMissing(relative));
    if (info.isSymbolicLink()) throw new Error(MESSAGE.InputLink(relative));
  }
  const file = await lstat(at);
  if (!file.isFile()) throw new Error(MESSAGE.InputNotFile(relative));
  if (file.size > MAX_INPUT_BYTES) throw new Error(MESSAGE.InputTooLarge(relative));
  return file.size;
}

/** The comma-separated extra inputs a call names, each checked; any refusal refuses the call. */
async function extraInputs(raw: PluginScalar | undefined, directory: string | undefined): Promise<string[]> {
  const files = String(raw ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  if (!files.length) return [];
  if (!directory) throw new Error(MESSAGE.InputsNeedGame);
  if (files.length > MAX_EXTRA_INPUTS) throw new Error(MESSAGE.TooManyInputs);
  if (new Set(files.map((file) => path.posix.basename(file))).size !== files.length)
    throw new Error(MESSAGE.SameInputName);
  let total = 0;
  for (const file of files) total += await gameInputBytes(directory, file);
  if (total > MAX_INPUTS_BYTES) throw new Error(MESSAGE.InputsTooLarge);
  return files;
}

/**
 * The native job for a call. With extra inputs it is the compose recipe, whose fixed slots take the
 * model (if any) and the inputs; the host stages every declared slot, so an unused one carries the
 * script again, and the `inputs` value names the slots that are real, in order.
 */
function nativeRequest(args: ToolArgs, script: string, slug: string, extras: string[]): NativeRequest {
  const values = { name: slug, rig: args.rig === true ? RigValue.On : RigValue.Off };
  const model = args.model ? String(args.model) : "";
  if (!extras.length && !model) return { job: BlenderJob.Model, inputs: { script }, values };
  if (!extras.length) return { job: BlenderJob.Transform, inputs: { script, model }, values };
  const real = model ? [model, ...extras] : extras;
  const inputs: Record<string, string> = { script };
  for (let slot = 0; slot < INPUT_SLOTS; slot++) inputs[`input${slot + 1}`] = real[slot] ?? script;
  const labels = model ? [MODEL_SLOT, ...extras] : extras;
  return { job: BlenderJob.Compose, inputs, values: { ...values, inputs: labels.join(",") } };
}

/** The delivered model's `res://` path when it landed in a Godot project (a folder holding project.godot), else null. */
async function godotPath(ctx: PluginContext, files: readonly string[]): Promise<string | null> {
  const model = files.find((file) => file.endsWith(".glb")) ?? files[0];
  const at = model?.indexOf(DELIVERED_FOLDER) ?? -1;
  if (!model || at < 0) return null;
  const project = model.slice(0, at);
  const read = await ctx.host(HostService.ProjectRead, { path: `${project}${GODOT_PROJECT_FILE}` }).catch(() => null);
  return typeof read === "string" ? `res://${model.slice(at)}` : null;
}

/** Whether the game's folder has the file at `file`, read through the host. */
async function holdsFile(ctx: PluginContext, file: string): Promise<boolean> {
  return typeof (await ctx.host(HostService.ProjectRead, { path: file }).catch(() => null)) === "string";
}

/** The engine studio.json links the game to, by its id: none with no record, one that doesn't read, or a kind no engine id spells. */
async function linkedEngine(ctx: PluginContext): Promise<string | undefined> {
  try {
    const kind: unknown = JSON.parse(await ctx.host(HostService.ProjectRead, { path: STUDIO_JSON }))?.engine?.kind;
    return typeof kind === "string" && ENGINE_ID.test(kind) ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** The engine the game builds in: the one its studio.json links, else Unity by its project's version file, else the web. */
async function gameEngine(ctx: PluginContext): Promise<EngineKind> {
  const linked = await linkedEngine(ctx);
  if (linked) return linked;
  for (const file of UNITY_VERSION_FILES) if (await holdsFile(ctx, file)) return GameEngine.Unity;
  return GameEngine.Web;
}

/**
 * What to do with the delivery: Godot's `res://` path when it landed in a Godot project, the web's
 * loader, Unreal's units, Unity's glTF import, or any other engine's own import.
 */
function deliveryGuidance(engine: EngineKind, resPath: string | null): string {
  if (resPath) return MESSAGE.GodotGuidance(resPath);
  if (engine === GameEngine.Web) return MESSAGE.WebGuidance;
  if (engine === GameEngine.Unity) return MESSAGE.UnityGuidance;
  return engine === GameEngine.Unreal ? MESSAGE.UnrealGuidance : MESSAGE.EngineGuidance;
}

/** Blender's state on this Mac, with what to tell the user when it can't run. */
async function runtimeStatus(ctx: PluginContext) {
  const runtime = await ctx.host(HostService.RuntimeDetect, BLENDER);
  return runtime?.state === RUNTIME_READY ? { runtime } : { runtime, next: MESSAGE.NotReady(runtime?.detail ?? "") };
}

/** A failed job's error, or why Blender can't run here and what to tell the user, when that is the reason. */
async function jobError(ctx: PluginContext, error: unknown): Promise<unknown> {
  const status = await runtimeStatus(ctx).catch(() => null);
  return status?.next ? new Error(status.next) : error;
}

/** What to do with the delivery in this engine (a Godot project when `resPath` names it), and what the file holds that needs a word. */
function guidanceFor(
  engine: EngineKind,
  stats: { meshCount?: number; armatures?: unknown[] },
  rig: boolean,
  resPath: string | null = null,
): string {
  const notes: string[] = [deliveryGuidance(engine, resPath)];
  const meshes = stats.meshCount ?? 0;
  if (engine === GameEngine.Unreal && meshes > 1) notes.push(MESSAGE.UnrealJoin(meshes));
  const armatures = stats.armatures?.length ?? 0;
  if (!rig && armatures) notes.push(MESSAGE.RigLeftOut(armatures));
  return notes.join(" ");
}

/** Run a model, transform or compose job, deliver its files into the game and record the delivery. */
async function model(args: ToolArgs, ctx: PluginContext) {
  const name = String(args.name ?? "");
  const slug = assetSlug(name);
  const extras = await extraInputs(args.inputs, ctx.directory);
  const script = await scriptFor(args, name, slug, ctx.directory);
  const job = await ctx.host(HostService.NativeRun, nativeRequest(args, script, slug, extras)).catch(async (error) => {
    throw await jobError(ctx, error);
  });
  const result = blenderResult(job);
  if (job.state !== JOB_COMPLETED || !result?.ok)
    throw new Error(MESSAGE.JobFailed(job.id, result?.error || job.stderr || job.reason || MESSAGE.NoExport));
  const files = await ctx.host(HostService.AssetsDeliver, { output: job.output, jobId: job.id });
  await ctx.host(HostService.JobsWrite, {
    id: job.id,
    value: { id: job.id, files, ...derivedFrom(args, job), deliveredAt: new Date().toISOString() },
  });
  const images = await renderImages(job);
  const { renders: _privateRenderPaths, ...stats } = result;
  const guidance = guidanceFor(await gameEngine(ctx), stats, args.rig === true, await godotPath(ctx, files));
  return {
    jobId: job.id,
    provider: "Local Blender",
    runtimeVersion: job.version,
    status: "downloaded",
    name: slug,
    ...(slug === name ? {} : { renamed: MESSAGE.Renamed(name, slug) }),
    files,
    stats,
    images,
    ...derivedFrom(args, job),
    guidance,
  };
}

/** Local modeling uses only public SDK services; no import from Studio core. */
export const activate: Activate = () => ({
  async action(name, _args, ctx) {
    if (name === BlenderAction.Status)
      return {
        runtime: await ctx.host(HostService.RuntimeDetect, BLENDER),
        installation: await ctx.host(HostService.RuntimeInstallation, BLENDER),
        jobs: await ctx.host(HostService.NativeJobs),
      };
    if (name === BlenderAction.Install) return ctx.host(HostService.RuntimeInstall, BLENDER);
    if (name === BlenderAction.CancelInstall) return ctx.host(HostService.RuntimeCancelInstall, BLENDER);
    throw new Error(MESSAGE.UnknownAction);
  },
  async tool(name, args, ctx) {
    if (name === BlenderTool.Status)
      return { ...(await runtimeStatus(ctx)), jobs: (await ctx.host(HostService.NativeJobs)).map(publicJob) };
    if (name === BlenderTool.Install) {
      await ctx.host(HostService.RuntimeInstall, BLENDER);
      return { status: "downloading", next: MESSAGE.InstallStarted };
    }
    if (name === BlenderTool.Retrieve) {
      const job = await ctx.host(HostService.NativeResult, { id: String(args.id) });
      if (!job) throw new Error(MESSAGE.NoRecordedJob);
      return { ...publicJob(job), delivery: await ctx.host(HostService.JobsRead, { id: job.id }) };
    }
    if (name !== BlenderTool.Model) throw new Error(MESSAGE.UnknownOperation);
    return model(args, ctx);
  },
});
