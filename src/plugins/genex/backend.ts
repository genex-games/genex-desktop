import path from "node:path";
import { fileURLToPath } from "node:url";
import { GenexTools } from "./adapter.ts";
import { type CoverCamera, CoverOperation, COVER_STILL, MESSAGE as COVER_MESSAGE } from "./cover.ts";
import { SessionCredentials } from "../../substrate/session-credentials.ts";
import {
  GenexAction,
  GenexHostedStatus,
  GenexJobStatus,
  GenexOperation,
  GenexPublishJobState,
  GenexPublishKind,
  type GenexPublishState,
  GenexPublishStatusOperation,
} from "../../shared/genex.ts";
import { PluginService } from "../../shared/plugins.ts";
import type { PluginContext, PluginToolbarStatus } from "../../plugin-sdk/index.d.ts";
import type { GenexObserver } from "../../substrate/genex-outcomes.ts";

type Args = Record<string, any>;
/** One invocation's binding (`PluginContext`); fixtures may leave out the signal and call id. */
type Invocation = Omit<Partial<PluginContext>, "host"> & { host: Service };
type Service = (method: string, args?: unknown) => Promise<unknown>;

/** The publish phase announced before a publish job exists, or when none started. */
const PublishAnnouncement = { Requested: "requested", Idle: "idle" } as const;

/** The agent tools this plugin declares in plugin.json (the rest are asset tools). */
const GenexToolName = {
  PublishStatus: "publish-status",
  Publish: "publish",
  Cover: "cover",
  CoverSet: "cover-set",
} as const;

const MESSAGE = {
  ApprovalGone: "Character approval no longer available",
  FinalizeReview: "Review all views. Approve a separate 10,000-face rigging copy.",
  PreviewReview: (candidate: unknown) => `Review all candidates. Selected candidate: ${candidate}`,
  ProjectRequired: "A project is required",
  BadPublishOperation: "Publish operation must be 'draft' or 'gallery'",
  OpenProject: "Open a project",
  UnknownAction: "Unknown Genex action",
  OutsideInvocation: "A Genex host call ran outside a plugin invocation",
} as const;

/**
 * The publish toolbar item's status: no badge, only its tooltip, and whether the game has
 * something to publish (`attention`), which Studio draws in the accent.
 */
const PUBLISH_STATUS = {
  Uploading: (phase: string) => ({ title: `Publishing this game (${phase})`, attention: false }),
  Failed: { title: "The last publish failed. Open Publish to read why.", attention: true },
  Live: { title: "This game is listed in the Genex gallery", attention: false },
  Draft: { title: "This game has an unlisted draft page", attention: true },
  Unpublished: { title: "Publish this game with a playable link", attention: true },
} as const satisfies Record<string, PluginToolbarStatus | ((phase: string) => PluginToolbarStatus)>;

/** Publish's status for a game's publish state: uploading, failed, listed, drafted, or never published. */
export function publishButtonStatus(state: GenexPublishState): PluginToolbarStatus {
  const job = state.job?.state;
  if (job === GenexPublishJobState.Running || job === GenexPublishJobState.Unresolved)
    return PUBLISH_STATUS.Uploading(state.job?.phase ?? "");
  if (job === GenexPublishJobState.Failed) return PUBLISH_STATUS.Failed;
  if (state.status === GenexHostedStatus.Published) return PUBLISH_STATUS.Live;
  if (state.slug) return PUBLISH_STATUS.Draft;
  return PUBLISH_STATUS.Unpublished;
}

/** A publish-status call: wait on the running upload, or read (and with `check`, re-check) the record. */
function publishStatusFor(genex: GenexTools, project: string, args: Args) {
  return args.operation === GenexPublishStatusOperation.Wait
    ? genex.publishWait(project, args.jobId)
    : genex.publishView(project, args.operation === GenexPublishStatusOperation.Check);
}

/**
 * The host's camera on the bound game for this invocation, begun at `invokedAt`: a still of its
 * genex-cover demo through `observe`, which answers only while the invocation lasts. None unbound.
 */
function coverCamera(ctx: Invocation, service: Service, invokedAt: number): CoverCamera | undefined {
  const { project, directory } = ctx;
  if (!project || !directory) return undefined;
  return {
    invokedAt,
    shoot: () => service(PluginService.Observe, { project, root: directory, files: [], still: { ...COVER_STILL } }),
  };
}

/** The agent's cover tool: shoot the genex-cover demo, or report the cover. Asks nothing, uploads nothing. */
function coverTool(genex: GenexTools, project: string, args: Args, camera: CoverCamera | undefined) {
  if (args.operation === CoverOperation.Shoot && camera) return genex.coverShoot(project, camera);
  if (args.operation === CoverOperation.Status) return genex.coverStatus(project);
  throw new Error(COVER_MESSAGE.BadOperation);
}

const isPublishKind = (value: unknown) => value === GenexPublishKind.Draft || value === GenexPublishKind.Gallery;

/** The agent's publish tool: announce, run the export, the cover shot and the upload start, then report the phase. */
async function publishTool(
  genex: GenexTools,
  project: string,
  args: Args,
  ctx: Invocation,
  service: Service,
  camera: CoverCamera | undefined,
) {
  if (!isPublishKind(args.operation)) throw new Error(MESSAGE.BadPublishOperation);
  await ctx.host(PluginService.EventsEmit, {
    kind: "publish",
    operation: args.operation,
    phase: PublishAnnouncement.Requested,
  });
  await ctx.host(PluginService.EventsEmit, { kind: "toolbar", item: "publish", attention: false }).catch(() => {});
  // The export runs inside this invocation: a detached upload gets no answer from host services.
  const exportStage = () => service(PluginService.ExportStage, {});
  const state =
    args.operation === GenexPublishKind.Draft
      ? await genex.publishDraft(project, exportStage, camera)
      : await genex.publishGallery(project, exportStage, undefined, camera);
  await ctx
    .host(PluginService.EventsEmit, {
      kind: "publish",
      operation: args.operation,
      phase: state.job?.phase ?? PublishAnnouncement.Idle,
      jobId: state.job?.id,
    })
    .catch(() => {});
  return state;
}

/** The agent's asset tool: run one Genex request and announce how it ended. */
async function assetTool(genex: GenexTools, project: string, directory: string, args: Args, ctx: Invocation) {
  await ctx.host(PluginService.EventsEmit, { operation: args.operation, status: GenexJobStatus.Requested });
  try {
    const result = (await genex.execute(
      project,
      directory,
      {
        operation: args.operation,
        prompt: args.prompt,
        id: args.id,
        options: typeof args.options === "string" ? JSON.parse(args.options) : (args.options ?? {}),
      },
      ctx.signal,
      false,
      ctx.threadId,
    )) as Record<string, unknown>;
    await ctx.host(PluginService.EventsEmit, {
      operation: args.operation,
      status: result.status ?? "complete",
      id: result.id,
      generationId: result.generationId,
    });
    return result;
  } catch (error) {
    await ctx
      .host(PluginService.EventsEmit, {
        operation: args.operation,
        status: GenexJobStatus.Failed,
        error: String(error),
      })
      .catch(() => {});
    throw error;
  }
}

/** One agent tool call on a bound game; any name the plugin declares that is not here is an asset tool. */
function runTool(
  genex: GenexTools,
  name: string,
  args: Args,
  ctx: Invocation & { project: string; directory: string },
  service: Service,
  invokedAt: number,
) {
  const camera = coverCamera(ctx, service, invokedAt);
  if (name === GenexToolName.PublishStatus) return publishStatusFor(genex, ctx.project, args);
  if (name === GenexToolName.Publish) return publishTool(genex, ctx.project, args, ctx, service, camera);
  if (name === GenexToolName.Cover) return coverTool(genex, ctx.project, args, camera);
  if (name === GenexToolName.CoverSet) return genex.coverSet(ctx.project);
  return assetTool(genex, ctx.project, ctx.directory, args, ctx);
}

/** The approval dialog's evidence: every candidate or view image, and what approving does. */
async function approvalReview(genex: GenexTools, args: Args, ctx: Invocation) {
  const status = await genex.status(ctx.project);
  const job = status.jobs.find((j) => j.id === args.id);
  const pending = job?.status === GenexJobStatus.ApprovalRequired && job.approval?.images?.length;
  if (!job?.approval || !pending) throw new Error(MESSAGE.ApprovalGone);
  return {
    images: job.approval.images,
    message:
      job.operation === GenexOperation.CharacterFinalize
        ? MESSAGE.FinalizeReview
        : MESSAGE.PreviewReview(args.candidate),
  };
}

/** One user action; `invokedAt` is when its invocation began, which a publish's cover shot is measured from. */
type Action = (
  genex: GenexTools,
  args: Args,
  ctx: Invocation,
  service: Service,
  invokedAt: number,
) => Promise<unknown> | unknown;

/** Wrap an action that needs a bound game; `camera` photographs it while the invocation lasts. */
const withProject =
  (
    run: (genex: GenexTools, project: string, args: Args, service: Service, camera?: CoverCamera) => Promise<unknown>,
  ): Action =>
  (genex, args, ctx, service, invokedAt) => {
    if (!ctx.project) throw new Error(MESSAGE.OpenProject);
    return run(genex, ctx.project, args, service, coverCamera(ctx, service, invokedAt));
  };

/** The user actions the panels, the Plugins dialog and the toolbar may invoke. */
const ACTIONS: Record<string, Action> = {
  [GenexAction.Status]: (genex, _args, ctx) => genex.status(ctx.project),
  [GenexAction.AssetBadge]: (genex) => genex.setupBadge(),
  [GenexAction.Unlock]: (genex) => genex.unlock(),
  [GenexAction.Connect]: async (genex, _args, ctx) => {
    await genex.unlock();
    const status = await genex.status(ctx.project);
    return status.connected ? { connected: true } : genex.connect();
  },
  [GenexAction.Terms]: async (genex, _args, ctx) => {
    const status = await genex.status(ctx.project);
    return { verifyUrl: status.legal?.acceptUrl };
  },
  [GenexAction.Disconnect]: (genex) => genex.disconnect(),
  [GenexAction.CancelConnect]: (genex, _args, ctx) => {
    genex.cancelConnect();
    return genex.status(ctx.project);
  },
  [GenexAction.Approve]: withProject((genex, project, args) => genex.approve(project, args.id, args.candidate)),
  [GenexAction.PublishStatus]: withProject((genex, project, args) => publishStatusFor(genex, project, args)),
  [GenexAction.PublishDraft]: withProject((genex, project, _args, service, camera) =>
    genex.publishDraft(project, () => service(PluginService.ExportStage, {}), camera),
  ),
  [GenexAction.PublishGallery]: withProject((genex, project, args, service, camera) =>
    genex.publishGallery(project, () => service(PluginService.ExportStage, {}), args.title, camera),
  ),
  [GenexAction.PublishAllowUpload]: withProject((genex, project, args) =>
    genex.publishAllowNewUpload(project, String(args.jobId ?? "")),
  ),
  [GenexAction.PublishOpen]: withProject((genex, project, args) => genex.publishLinks(project, args.target)),
  [GenexAction.PublishBadge]: async (genex, args, ctx) => {
    if (!ctx.project) return {};
    return publishButtonStatus(
      await genex.publishStatus(ctx.project, args.operation === GenexPublishStatusOperation.Check),
    );
  },
};

export async function activate() {
  return createGenexPlugin();
}
/** Source-level fixture seam. Never reachable from panel or agent arguments. */
export async function createGenexPlugin(api?: string) {
  let genex: GenexTools | undefined;
  let initialization: Promise<GenexTools> | undefined;
  let current: any;
  const service: Service = (method, args = {}) => current.host(method, args);
  const create = async () => {
    const root = await service(PluginService.StorageRoot);
    const credentials = new SessionCredentials({
      get: () => service(PluginService.CredentialsRead) as Promise<string | null>,
      set: (token) => service(PluginService.CredentialsWrite, { token }) as Promise<void>,
      clear: () => service(PluginService.CredentialsClear) as Promise<void>,
    });
    const lease = await service(PluginService.CredentialsSession);
    if (typeof lease === "string" && lease) credentials.restore(lease);
    genex = new GenexTools(String(root), api, {
      credentials,
      deliver: async (output, _root, jobId) =>
        service(PluginService.AssetsDeliver, { output, jobId }) as Promise<string[]>,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs"),
      observe: async (project, root, files) =>
        service(PluginService.Observe, { project, root, files }) as ReturnType<GenexObserver>,
    });
    await genex.init();
    return genex;
  };
  async function ready(ctx: any) {
    current = ctx;
    initialization ??= create().catch((error) => {
      initialization = undefined;
      genex = undefined;
      throw error;
    });
    return initialization;
  }
  // Context is carried through AsyncLocalStorage so parallel jobs never borrow another worker's authority.
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const contexts = new AsyncLocalStorage<Invocation>();
  const scoped = <T>(ctx: Invocation, fn: () => Promise<T>) => contexts.run(ctx, fn);
  current = {
    host: (method: string, args: unknown) => {
      const invocation = contexts.getStore();
      // Only a scoped call carries authority; outside one there is none to borrow.
      if (!invocation) throw new TypeError(MESSAGE.OutsideInvocation);
      return invocation.host(method, args);
    },
  };
  const initial = current;
  return {
    review: (name: string, args: Args, ctx: Invocation) =>
      scoped(ctx, async () => {
        if (name !== "approve") return {};
        return approvalReview(await ready(initial), args, ctx);
      }),
    tool: (name: string, args: Args, ctx: Invocation) =>
      scoped(ctx, async () => {
        // The host's ceiling for this call runs from here; a publish's cover shot must fit inside it.
        const invokedAt = Date.now();
        const g = await ready(initial);
        const { project, directory } = ctx;
        if (!project || !directory) throw new Error(MESSAGE.ProjectRequired);
        return runTool(g, name, args, { ...ctx, project, directory }, service, invokedAt);
      }),
    action: (name: string, args: Args, ctx: Invocation) =>
      scoped(ctx, async () => {
        const invokedAt = Date.now();
        const g = await ready(initial);
        const run = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
        if (!run) throw new Error(MESSAGE.UnknownAction);
        return run(g, args, ctx, service, invokedAt);
      }),
  };
}
