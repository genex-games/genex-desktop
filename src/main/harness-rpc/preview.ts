/** Harness RPC: previews — load, look, drive and measure a game in a window. */
import { readFile } from "node:fs/promises";
import { HostMethod, type HarnessHostHandlers, type HarnessParams } from "../../shared/harness-api.ts";
import { keepPathsOf } from "../../shared/studio-state-shape.ts";
import { availableMemory } from "../../substrate/hardware.ts";
import type { CaptureSurface } from "../../substrate/preview-port.ts";
import { LIVE_HANDLE, STAND_IN_HANDLE } from "../../substrate/preview-pool.ts";
import { awaitReady, bootBudget, unlockGesture } from "../../substrate/preview-ready.ts";
import { observeBuild } from "../../substrate/build-probe.ts";
import { computerRpc } from "../core/computer-rpc.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import {
  DEFAULT_STILL_QUALITY,
  DEFAULT_PAIR_HEIGHT,
  DEFAULT_SHOT_QUALITY,
  NO_PAGE_UI,
  PAIR_QUALITY,
  captureSurface,
  encodedJpeg,
} from "../core/capture.ts";

/** The only stage a profile may be taken for. */
const OPTIMIZATION_STAGE = "optimization";
/** The one purpose a borrowed window may name: a headless window fit for profiling. */
const OPTIMIZATION_PURPOSE = "optimization" satisfies NonNullable<
  HarnessParams<typeof HostMethod.PreviewAcquire>["purpose"]
>;

/** What the harness reads when a preview call is refused or cannot be served. */
const MESSAGE = {
  statsNeedsImage: "preview.statsOf needs base64 or a path",
  noProfiler: "preview has no profiling capability",
  profileSourceMismatch: "profile source/revision mismatch",
  profileRunMismatch: "profile run mismatch",
  otherPreviewsActive: "other studio previews are active",
  pairNeedsTwoImages: "preview.pair needs two images",
  harnessRestarted: "the harness that asked for this preview window has restarted",
} as const;

/** One computer service per core: the harness's leased windows outlive any one `api()` table. */
const COMPUTERS = new WeakMap<CoreInternals, ReturnType<typeof computerRpc>>();

/** The core's `preview.computer` service, made on first use. */
function computersOf(core: StudioCore, x: CoreInternals): ReturnType<typeof computerRpc> {
  const known = COMPUTERS.get(x);
  if (known) return known;
  const made = computerRpc({
    gameDir: (project) => core.games.dirFor(project),
    scratch: () => core.layout.scratch,
    runs: () => core.layout.runs,
    port: (handle) => x.previews.preview(handle),
    computerTools: (grant, root, outDir, session) => core._computerToolsFor(grant, root, outDir, session),
    runOfGame: (project, runId) => core._runOfGame(project, runId),
  });
  COMPUTERS.set(x, made);
  return made;
}

/** A still named by its bytes or by a path the previews may read. */
type StillSource = { base64?: string; path?: string } | null | undefined;

export function previewRpc(core: StudioCore, x: CoreInternals) {
  /** A method run in the window the harness means (`inHarnessWindow`). */
  const routed =
    <P extends { handle?: string }, R>(fn: (p: P) => Promise<R>) =>
    (p: P): Promise<R> =>
      inHarnessWindow(x, p?.handle, { mirror: true }, (handle) => fn(withHandle(p, handle)));
  return {
    // — preview (the senses) — every method takes an optional `handle`. Omitted (or the live
    // view) means the stand-in wherever this build has hidden windows: the live view is the
    // person's, and only their own action changes it. A load or reload there offers Live the
    // change instead (`PreviewService.offerLive`), and the stage's Reload applies it.
    [HostMethod.PreviewLoad]: async (p) =>
      inHarnessWindow(x, p?.handle, { mirror: false }, async (handle) => {
        const url = await x.previews.loadPreview(withHandle(p, handle));
        await offerStandIn(x, handle);
        return url;
      }),
    [HostMethod.PreviewProfile]: async (p) => profile(core, x, p),
    [HostMethod.PreviewReload]: async (p) =>
      inHarnessWindow(x, p?.handle, { mirror: true }, async (handle) => {
        const reloaded = await x.previews.reloadPreview(withHandle(p, handle));
        await offerStandIn(x, handle);
        return reloaded;
      }),
    [HostMethod.PreviewScreenshot]: routed(async (p: HarnessParams<typeof HostMethod.PreviewScreenshot>) =>
      screenshot(core, x, p),
    ),
    // What the page holds outside the canvas: a DOM menu, an HTML HUD, a loader. The evidence
    // pass reads it to decide which surface to photograph, and the check that says a game's
    // UI is primary reads the same numbers. A port that cannot see outside the canvas answers
    // the null-ish shape rather than null, so a caller reads one thing.
    [HostMethod.PreviewPageUi]: routed(async (p: HarnessParams<typeof HostMethod.PreviewPageUi>) => {
      const port = x.previews.preview(p?.handle);
      const ui = port.pageUi ? await port.pageUi().catch(() => null) : null;
      return ui ?? { ...NO_PAGE_UI };
    }),
    // Bounded by structure in the page; `keep` reaches it only through the host's validation,
    // and a malformed one is ignored rather than refused, so an older seed still reads its state.
    [HostMethod.PreviewState]: routed(async (p: HarnessParams<typeof HostMethod.PreviewState>) => {
      const keep = keepPathsOf(p?.keep);
      const port = x.previews.preview(p?.handle);
      return keep.length > 0 ? port.studioState({ keep }) : port.studioState();
    }),
    [HostMethod.PreviewCall]: routed(async (p: HarnessParams<typeof HostMethod.PreviewCall>) =>
      x.previews.preview(p.handle).studioCall(String(p.method), p.arg),
    ),
    // `scene` checks: arbitrary read-only JS over the game's own
    // three.js graph. The result is untrusted JSON, size-capped by the port.
    [HostMethod.PreviewEvaluate]: routed(async (p: HarnessParams<typeof HostMethod.PreviewEvaluate>) => {
      const port = x.previews.preview(p?.handle);
      await port.invalidateProfile?.("external evaluation during sample");
      return port.evaluate(String(p.expression ?? "null"));
    }),
    // Crop, diff, stats and pair only work on encoded stills; no page is touched, so they need no window of their own.
    // A `vision` check's crop is cut from the saved judged frame, never re-captured.
    [HostMethod.PreviewCrop]: async (p) => crop(core, x, p),
    // Challenger vs incumbent on one camera: diff fraction + heatmap, the invisible-diff detector.
    [HostMethod.PreviewDiff]: async (p) => diff(core, x, p),
    [HostMethod.PreviewComputer]: async (p) => computersOf(core, x).call(p),
    [HostMethod.PreviewInput]: routed(async (p: HarnessParams<typeof HostMethod.PreviewInput>) =>
      x.previews.preview(p?.handle).input(Array.isArray(p?.actions) ? p.actions : []),
    ),
    [HostMethod.PreviewConsole]: routed(async (p: HarnessParams<typeof HostMethod.PreviewConsole>) =>
      x.previews.preview(p?.handle).consoleEntries(p?.sinceMs ?? 0),
    ),
    [HostMethod.PreviewGpuErrors]: routed(async (p: HarnessParams<typeof HostMethod.PreviewGpuErrors>) => {
      const preview = x.previews.preview(p?.handle);
      return preview.gpuErrors ? preview.gpuErrors() : [];
    }),
    [HostMethod.PreviewStatus]: routed(async (p: HarnessParams<typeof HostMethod.PreviewStatus>) => {
      const port = x.previews.preview(p?.handle);
      const status = port.status();
      // The size it is at now, so a look `preview.viewport` set and a session put back is visible.
      const viewSize = port.viewSize?.();
      return viewSize ? { ...status, viewSize } : status;
    }),
    // Readiness is a fact the page reports, not a sleep — and a HOST call, not an agent tool:
    // the loop asks over the substrate RPC, so no MCP schema and no bridge entry change.
    [HostMethod.PreviewReady]: routed(async (p: HarnessParams<typeof HostMethod.PreviewReady>) => {
      const shown = x.servedRoots.get(p?.handle ?? LIVE_HANDLE);
      const budgetMs = p?.timeoutMs ?? (shown ? await x.previews.bootMsFor(shown.project) : bootBudget(undefined));
      return awaitReady(x.previews.preview(p?.handle), { timeoutMs: budgetMs, gesture: p?.gesture !== false });
    }),
    // A knock: the trusted click that grants user activation, so a title screen, a pointer
    // lock and an AudioContext all get the gesture a browser only ever gives a real one.
    [HostMethod.PreviewGesture]: routed(async (p: HarnessParams<typeof HostMethod.PreviewGesture>) =>
      unlockGesture(x.previews.preview(p?.handle), gesturePoint(p), p?.keys),
    ),
    // What the person's own window is showing right now: their game folder, or a build they
    // chose to play. `status()` carries the project but not the root, and the root is the whole
    // difference between "your game folder" and "that build".
    [HostMethod.PreviewShowing]: async () => x.servedRoots.get(LIVE_HANDLE) ?? null,
    [HostMethod.PreviewObserve]: routed(async (p: HarnessParams<typeof HostMethod.PreviewObserve>) =>
      observeBuild(x.previews.preview(p?.handle)),
    ),
    [HostMethod.PreviewAcquire]: async (p) => acquire(x, p),
    [HostMethod.PreviewRelease]: async (p) => {
      x.profileSources.delete(p.handle);
      await computersOf(core, x).forget(p.handle);
      await x.previewPool?.release(p.handle);
      return true;
    },
    // One leased window at another size for a look (the art director's), for that lease only.
    [HostMethod.PreviewViewport]: async (p) => x.previews.viewport(p),
    // Pixel stats of an encoded still — the same numbers a capture yields.
    [HostMethod.PreviewStatsOf]: async (p) => {
      const preview = x.previews.preview(p?.handle);
      if (!preview.statsOf) return null;
      const data = await stillBytes(x, p);
      if (!data?.length) throw new Error(MESSAGE.statsNeedsImage);
      return preview.statsOf(data);
    },
    // LEFT | RIGHT composite of a reference still and a build frame.
    [HostMethod.PreviewPair]: async (p) => pair(core, x, p),
    [HostMethod.PreviewScreens]: async () => core.agentScreens(),
    [HostMethod.PreviewCapacity]: async () => capacity(core, x),
  } satisfies Partial<HarnessHostHandlers>;
}

/** The params with the window the harness means in place of the one it named. */
function withHandle<P extends { handle?: string }>(p: P, handle: string | undefined): P {
  return handle === undefined ? p : { ...p, handle };
}

/**
 * Run `fn` in the window a harness call means: the one it named, or for none (or the live view)
 * the stand-in (`PreviewService.harnessWindow`). `mirror`: a call that loads nothing finds in a
 * freshly opened stand-in what Live shows.
 */
async function inHarnessWindow<T>(
  x: CoreInternals,
  named: string | undefined,
  { mirror }: { mirror: boolean },
  fn: (handle: string | undefined) => Promise<T>,
): Promise<T> {
  const handle = await x.previews.harnessWindow(named, { mirror });
  try {
    return await fn(handle);
  } finally {
    x.previews.harnessWindowDone(handle);
  }
}

/** What the harness just loaded in the stand-in is offered to Live, never loaded into it. */
async function offerStandIn(x: CoreInternals, handle: string | undefined): Promise<void> {
  if (handle !== STAND_IN_HANDLE) return;
  const served = x.servedRoots.get(STAND_IN_HANDLE);
  if (served) await x.previews.offerLive({ project: served.project, root: served.root }).catch(() => {});
}

/** Where a knock lands: the numeric coordinates the caller named, and no others. */
function gesturePoint(p: { x?: unknown; y?: unknown } | null | undefined): { x?: number; y?: number } {
  return { ...(typeof p?.x === "number" ? { x: p.x } : {}), ...(typeof p?.y === "number" ? { y: p.y } : {}) };
}

/** A still's bytes: sent inline, or read from a path the previews may read. */
async function stillBytes(x: CoreInternals, source: StillSource): Promise<Buffer | null> {
  if (source?.base64) return Buffer.from(source.base64, "base64");
  if (source?.path) return readFile(await x.previews.stillFile(source.path));
  return null;
}

async function profile(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewProfile>) {
  const port = x.previews.preview(p.handle);
  if (!port.profile) return { state: "unavailable", sessionId: null, reason: MESSAGE.noProfiler, sample: null };
  if (p.action === "begin") {
    const source = x.profileSources.get(p.handle);
    const sameRevision =
      source?.revision.commit === p.expectedRevision.commit && source?.revision.tree === p.expectedRevision.tree;
    if (!source || !sameRevision) throw new Error(MESSAGE.profileSourceMismatch);
    const registered = await core.candidates.source(source.candidateId, p.expectedRevision);
    if (registered.runId !== p.runId || p.stageId !== OPTIMIZATION_STAGE) throw new Error(MESSAGE.profileRunMismatch);
    if (x.previews.pool().leaseCount > 1) return { sessionId: null, reason: MESSAGE.otherPreviewsActive };
  }
  return port.profile(p);
}

async function screenshot(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewScreenshot>) {
  const preview = x.previews.preview(p?.handle);
  const quality = p?.quality ?? DEFAULT_SHOT_QUALITY;
  // Stats ride along with the JPEG so the critic gets a ground truth the image cannot
  // lie about; a preview without the capability still yields the picture, stats null.
  // `surface` asks for the whole page, the canvas, or whichever the preview judges the
  // game to live on. `page: true` is its permanent alias — an installed harness
  // workspace is an agent-editable copy of the seed and may keep sending it for ever.
  const asked: CaptureSurface = p?.surface ?? (p?.page ? "page" : "canvas");
  const shot = await captureSurface(preview, quality, asked);
  const { jpeg, stats } = shot;
  const label = p?.label ?? "shot";
  const saved = p?.runId ? await core.saveRunArtifact(p.runId, `${label}.jpg`, jpeg) : null;
  if (p?.runId && stats) {
    await core.saveRunArtifact(p.runId, `${label}.stats.json`, Buffer.from(JSON.stringify(stats)));
  }
  return { base64: jpeg.toString("base64"), bytes: jpeg.length, path: saved, stats, surface: shot.surface };
}

async function crop(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewCrop>) {
  const preview = x.previews.preview(p?.handle);
  if (!preview.cropImage) return null;
  const source = await x.previews.runFile(p.path);
  const { jpeg, width, height } = await preview.cropImage(source, p.crop, p.quality ?? DEFAULT_STILL_QUALITY);
  const label = p.label ?? "crop";
  const saved = await core.saveRunArtifact(p.runId, `${label}.jpg`, jpeg);
  return { ...encodedJpeg(jpeg, saved), width, height };
}

async function diff(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewDiff>) {
  const preview = x.previews.preview(p?.handle);
  if (!preview.diffImages) return null;
  const [fileA, fileB] = await Promise.all([x.previews.runFile(p.a), x.previews.runFile(p.b)]);
  const { diff, heatmap } = await preview.diffImages(fileA, fileB);
  const heatmapPath = heatmap ? await core.saveRunArtifact(p.runId, `${p.label ?? "diff"}.png`, heatmap) : null;
  return { ...diff, heatmapPath };
}

async function pair(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewPair>) {
  const preview = x.previews.preview(p?.handle);
  if (!preview.pairImages) return null;
  const [left, right] = await Promise.all([stillBytes(x, p?.left), stillBytes(x, p?.right)]);
  if (!left?.length || !right?.length) throw new Error(MESSAGE.pairNeedsTwoImages);
  const jpeg = await preview.pairImages(left, right, {
    height: p?.height ?? DEFAULT_PAIR_HEIGHT,
    quality: PAIR_QUALITY,
  });
  const saved = await core.saveRunArtifact(p.runId, `${p?.label ?? "pair"}.jpg`, jpeg);
  return encodedJpeg(jpeg, saved);
}

async function acquire(x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewAcquire>) {
  const boot = x.harnessBoot;
  const lease = await x.previews.pool().acquire({
    label: p?.label ?? "facet",
    purpose: p?.purpose === OPTIMIZATION_PURPOSE ? OPTIMIZATION_PURPOSE : undefined,
    owner: `harness:${boot}`,
  });
  // The harness that asked died while the window was opening: nobody is left to release it.
  if (boot !== x.harnessBoot) {
    await x.previewPool?.release(lease.handle);
    throw new Error(MESSAGE.harnessRestarted);
  }
  return { handle: lease.handle };
}

async function capacity(core: StudioCore, x: CoreInternals) {
  // Memory rides along: six windows of a big game is not a number the pool
  // knows; whoever starts workers reads the free memory beside the free slots.
  const memory = await availableMemory();
  try {
    const pool = x.previews.pool();
    return {
      max: pool.max,
      inUse: pool.leaseCount,
      free: Math.max(0, pool.max - pool.leaseCount),
      live: Boolean(core.options.preview),
      headless: Boolean(core.options.createHeadlessPreview),
      memory,
    };
  } catch {
    return { max: 0, inUse: 0, free: 0, live: false, headless: false, memory };
  }
}
