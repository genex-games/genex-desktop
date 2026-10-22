import path from "node:path";
import { fileURLToPath } from "node:url";
import { GenexTools, type RemixChoice } from "./adapter.ts";
import { COVER_CLIP } from "./clip.ts";
import { nativeUploads } from "./native-publish.ts";
import { type CoverCamera, CoverOperation, COVER_STILL, MESSAGE as COVER_MESSAGE } from "./cover.ts";
import { SessionCredentials } from "../../substrate/session-credentials.ts";
import {
  GenexAction,
  GenexHostedStatus,
  type GenexJob,
  GenexJobStatus,
  GenexOperation,
  GenexPluginEvent,
  GenexPublishJobState,
  GenexPublishKind,
  type GenexPublishState,
  GenexPublishStatusOperation,
} from "../../shared/genex.ts";
import { t } from "../../shared/i18n.ts";
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

/**
 * The backend's words. What a person reads (the approval review, an action's refusal) is a
 * function, translated when said; the agent's tool refusals stay English.
 */
const MESSAGE = {
  ApprovalGone: () => t("Character approval no longer available"),
  ChooseCandidate: () => t("Choose candidate 1, 2, or 3"),
  FinalizeReview: () => t("Review all views. Approve a separate 10,000-face rigging copy."),
  /** The review's question, which the native confirmation asks again without the picture. */
  PreviewReview: (candidate: number) =>
    t("Approve candidate {candidate} for your character’s 3D preview?", { candidate }),
  /** The caption under the one picture a preview's review shows. */
  ApprovingCandidate: (candidate: number) => t("Approving candidate {candidate}", { candidate }),
  ProjectRequired: "A project is required",
  BadPublishOperation: "Publish operation must be 'draft' or 'gallery'",
  OpenProject: () => t("Open a project"),
  UnknownAction: () => t("Unknown Genex action"),
  OutsideInvocation: "A Genex host call ran outside a plugin invocation",
} as const;

/** The captions of a remesh review's views, by the view each picture shows (`approvalLabels`). */
const VIEW_CAPTION: Record<string, () => string> = {
  front: () => t("front"),
  back: () => t("back"),
  left: () => t("left"),
  right: () => t("right"),
};

/** A remesh view's caption in the person's words; a view Studio has no words for keeps its name. */
const viewCaption = (view: string) => (Object.hasOwn(VIEW_CAPTION, view) ? VIEW_CAPTION[view]() : view);

/**
 * The publish toolbar item's status: no badge, only its tooltip, and whether the game has
 * something to publish (`attention`), which Studio draws in the accent.
 */
const PUBLISH_STATUS = {
  Uploading: (phase: string) => ({ title: t("Publishing this game ({phase})", { phase }), attention: false }),
  Failed: () => ({ title: t("The last publish failed. Open Publish to read why."), attention: true }),
  Live: () => ({ title: t("This game is listed in the Genex gallery"), attention: false }),
  Draft: () => ({ title: t("This game has an unlisted draft page"), attention: true }),
  Unpublished: () => ({ title: t("Publish this game with a playable link"), attention: true }),
} as const satisfies Record<string, (phase: string) => PluginToolbarStatus>;

/** Publish's status for a game's publish state: uploading, failed, listed, drafted, or never published. */
export function publishButtonStatus(state: GenexPublishState): PluginToolbarStatus {
  const job = state.job?.state;
  if (job === GenexPublishJobState.Running || job === GenexPublishJobState.Unresolved)
    return PUBLISH_STATUS.Uploading(state.job?.phase ?? "");
  if (job === GenexPublishJobState.Failed) return PUBLISH_STATUS.Failed();
  if (state.status === GenexHostedStatus.Published) return PUBLISH_STATUS.Live();
  if (state.slug) return PUBLISH_STATUS.Draft();
  return PUBLISH_STATUS.Unpublished();
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
/**
 * A publish's remixing: the dialog's choice when it sent one (an agent's publish sends none and keeps
 * the person's last choice), and the game's folder its project is staged from.
 */
function remixChoice(args: Args, ctx: Invocation): RemixChoice {
  return {
    ...(typeof args.remix === "boolean" ? { allowed: args.remix } : {}),
    ...(ctx.directory ? { gameDir: ctx.directory } : {}),
  };
}

function coverCamera(ctx: Invocation, service: Service, invokedAt: number): CoverCamera | undefined {
  const { project, directory } = ctx;
  if (!project || !directory) return undefined;
  return {
    invokedAt,
    shoot: (view) => {
      const still = view ? { ...stillSize(COVER_STILL), camera: view.camera } : { ...COVER_STILL };
      return service(PluginService.Observe, { project, root: directory, files: [], still });
    },
    record: () => service(PluginService.Observe, { project, root: directory, files: [], clip: { ...COVER_CLIP } }),
  };
}

/** A still's size and byte limit without its view, for another view at the same size. */
const stillSize = ({ width, height, maxBytes }: typeof COVER_STILL) => ({ width, height, maxBytes });

/** The agent's cover tool: shoot the genex-cover demo, or report the cover. Asks nothing, uploads nothing. */
function coverTool(genex: GenexTools, project: string, args: Args, camera: CoverCamera | undefined) {
  if (args.operation === CoverOperation.Shoot && camera) return genex.coverShoot(project, camera);
  if (args.operation === CoverOperation.Clip && camera) return genex.coverClip(project, camera);
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
      : await genex.publishGallery(project, exportStage, undefined, camera, [], remixChoice(args, ctx));
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
      {
        // While the generation waits on Genex's terms, the app reads the account again and offers Review.
        termsPending: (pending) =>
          ctx.host(PluginService.EventsEmit, { kind: GenexPluginEvent.Terms, pending }).then(
            () => {},
            () => {},
          ),
      },
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

type ApprovalImage = NonNullable<GenexJob["approval"]>["images"][number];

/**
 * A preview's review: only the candidate this approval names, captioned as the one being approved,
 * so nobody approves one picture while looking at another. The person compares the candidates on
 * the Genex page before choosing; the number shown here is the one the approval ticket binds.
 */
function previewReview(images: ApprovalImage[], candidate: unknown) {
  if (typeof candidate !== "number") throw new Error(MESSAGE.ChooseCandidate());
  const chosen = images.find((image) => image.label === String(candidate));
  if (!chosen) throw new Error(MESSAGE.ChooseCandidate());
  return {
    images: [{ label: MESSAGE.ApprovingCandidate(candidate), dataUrl: chosen.dataUrl }],
    message: MESSAGE.PreviewReview(candidate),
  };
}

/** The approval dialog's evidence: a remesh's every view or a preview's chosen candidate, and what approving does. */
async function approvalReview(genex: GenexTools, args: Args, ctx: Invocation) {
  const status = await genex.status(ctx.project);
  const job = status.jobs.find((j) => j.id === args.id);
  const pending = job?.status === GenexJobStatus.ApprovalRequired && job.approval?.images?.length;
  if (!job?.approval || !pending) throw new Error(MESSAGE.ApprovalGone());
  if (job.operation === GenexOperation.CharacterFinalize) {
    const images = job.approval.images.map((image) => ({ ...image, label: viewCaption(image.label) }));
    return { images, message: MESSAGE.FinalizeReview() };
  }
  return previewReview(job.approval.images, args.candidate);
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
    if (!ctx.project) throw new Error(MESSAGE.OpenProject());
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
  [GenexAction.TermsStatus]: (genex) => genex.termsStatus(),
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
  [GenexAction.PublishGallery]: async (genex, args, ctx, service, invokedAt) => {
    if (!ctx.project) throw new Error(MESSAGE.OpenProject());
    // The dialog names the game's apps by their place in its folder; only real builds inside it go.
    const apps = ctx.directory ? await nativeUploads(ctx.directory, args.native) : [];
    const exportStage = () => service(PluginService.ExportStage, {});
    const camera = coverCamera(ctx, service, invokedAt);
    return genex.publishGallery(ctx.project, exportStage, args.title, camera, apps, remixChoice(args, ctx));
  },
  [GenexAction.PublishApps]: async (genex, args, ctx, service, invokedAt) => {
    if (!ctx.project) throw new Error(MESSAGE.OpenProject());
    const apps = ctx.directory ? await nativeUploads(ctx.directory, args.native) : [];
    const camera = coverCamera(ctx, service, invokedAt);
    return genex.publishAppsOnly(ctx.project, apps, args.title, camera, remixChoice(args, ctx));
  },
  [GenexAction.PublishAllowUpload]: withProject((genex, project, args) =>
    genex.publishAllowNewUpload(project, String(args.jobId ?? "")),
  ),
  [GenexAction.PublishOpen]: withProject((genex, project, args) => genex.publishLinks(project, args.target)),
  [GenexAction.CoverAuto]: withProject((genex, project, _args, _service, camera) => genex.coverAuto(project, camera)),
  [GenexAction.CoverPick]: withProject((genex, project, args) => genex.coverPick(project, args.sha256)),
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
      embedSdk: path.join(path.dirname(fileURLToPath(import.meta.url)), "embed-sdk"),
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
        if (!run) throw new Error(MESSAGE.UnknownAction());
        return run(g, args, ctx, service, invokedAt);
      }),
  };
}
