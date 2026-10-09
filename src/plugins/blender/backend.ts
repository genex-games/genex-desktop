import { readFile } from "node:fs/promises";
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
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
} as const;
/** The native job state a finished model run reports. */
const JOB_COMPLETED = "completed";

/** The native runtime every call of this plugin names. */
const BLENDER = { runtime: "blender" } as const;
/** An asset name: lowercase, digits and dashes, so it is safe as a file name and a CLI value. */
const ASSET_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The renders a model job may leave for the agent to inspect. */
const RENDER_FILES = ["render.png", "render-front.png"];

/** The setup actions plugin.json declares. */
const BlenderAction = { Status: "status", Install: "install", CancelInstall: "cancel-install" } as const;
/** The agent tools plugin.json declares. */
const BlenderTool = { Status: "status", Retrieve: "retrieve", Model: "model" } as const;
/** The native jobs plugin.json declares: a new model from a script, or a transform of an existing one. */
const BlenderJob = {
  Model: "model",
  Transform: "transform",
  ModelFbx: "model-fbx",
  TransformFbx: "transform-fbx",
} as const;
/** GLB is the existing default; FBX adds an importable model for native Unity projects. */
const BlenderFormat = { Glb: "glb", Fbx: "fbx" } as const;

const MESSAGE = {
  UnknownAction: "Unknown Blender action",
  UnknownOperation: "Unknown Blender operation",
  NoRecordedJob: "No recorded job in this project",
  BadSlug: "Use a lowercase asset name with digits and dashes.",
  BadFormat: "Use format glb or fbx.",
  JobFailed: (id: string, reason: string) => `Blender job ${id}: ${reason}`,
  NoExport: "no completed export",
  Guidance:
    "Files are relative to the game workspace. Load model.glb with GLTFLoader at its returned asset path (omit public/ in a built app URL). Inspect these renders, integrate the mesh into the scene, then use the preview to verify visible use. A delivered file alone is not integration proof.",
  FbxGuidance:
    "Files are relative to the game workspace. Import the returned model.fbx with the Unity asset tools, instantiate it in a saved scene, inspect its scale and materials, then capture the Unity camera to verify visible use. GLB and two inspection renders are also retained. A delivered file alone is not integration proof.",
} as const;

type ToolArgs = Record<string, PluginScalar>;

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

/** Choose only the reviewed recipe for the requested export format and staged inputs. */
function modelRecipe(args: ToolArgs): string {
  const format = args.format ?? BlenderFormat.Glb;
  if (format === BlenderFormat.Glb) return args.model ? BlenderJob.Transform : BlenderJob.Model;
  if (format === BlenderFormat.Fbx) return args.model ? BlenderJob.TransformFbx : BlenderJob.ModelFbx;
  throw new Error(MESSAGE.BadFormat);
}

/** Run a model or transform job, deliver its files into the game and record the delivery. */
async function model(args: ToolArgs, ctx: PluginContext) {
  const slug = String(args.name ?? "");
  if (!ASSET_SLUG.test(slug)) throw new Error(MESSAGE.BadSlug);
  const job = await ctx.host(HostService.NativeRun, {
    job: modelRecipe(args),
    inputs: {
      script: String(args.script || `assets/src/${slug}.py`),
      ...(args.model ? { model: String(args.model) } : {}),
    },
    values: { name: slug },
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
  return {
    jobId: job.id,
    provider: "Local Blender",
    runtimeVersion: job.version,
    status: "downloaded",
    files,
    stats,
    images,
    ...derivedFrom(args, job),
    guidance: args.format === BlenderFormat.Fbx ? MESSAGE.FbxGuidance : MESSAGE.Guidance,
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
      return {
        runtime: await ctx.host(HostService.RuntimeDetect, BLENDER),
        jobs: (await ctx.host(HostService.NativeJobs)).map(publicJob),
      };
    if (name === BlenderTool.Retrieve) {
      const job = await ctx.host(HostService.NativeResult, { id: String(args.id) });
      if (!job) throw new Error(MESSAGE.NoRecordedJob);
      return { ...publicJob(job), delivery: await ctx.host(HostService.JobsRead, { id: job.id }) };
    }
    if (name !== BlenderTool.Model) throw new Error(MESSAGE.UnknownOperation);
    return model(args, ctx);
  },
});
