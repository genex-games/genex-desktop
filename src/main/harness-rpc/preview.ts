/** Harness RPC: previews — load, look, drive and measure a game in a window. */
import { HostMethod, type HarnessHostHandlers, type HarnessParams } from "../../shared/harness-api.ts";
import { availableMemory } from "../../substrate/hardware.ts";
import { CaptureSurface } from "../../shared/preview-contract.ts";
import { LIVE_HANDLE, STAND_IN_HANDLE } from "../../substrate/preview-pool.ts";
import { awaitReady, bootBudget } from "../../substrate/preview-ready.ts";
import { observeBuild } from "../../substrate/build-probe.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { DEFAULT_STILL_QUALITY, DEFAULT_SHOT_QUALITY, captureSurface, encodedJpeg } from "../core/capture.ts";

/** What the harness reads when a preview call is refused or cannot be served. */
const MESSAGE = {
  harnessRestarted: "the harness that asked for this preview window has restarted",
} as const;

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
    [HostMethod.PreviewReload]: async (p) =>
      inHarnessWindow(x, p?.handle, { mirror: true }, async (handle) => {
        const reloaded = await x.previews.reloadPreview(withHandle(p, handle));
        await offerStandIn(x, handle);
        return reloaded;
      }),
    [HostMethod.PreviewScreenshot]: routed(async (p: HarnessParams<typeof HostMethod.PreviewScreenshot>) =>
      screenshot(core, x, p),
    ),
    // A crop only works on an encoded still; no page is touched, so it needs no window of its own.
    // It is cut from a saved frame, never re-captured.
    [HostMethod.PreviewCrop]: async (p) => crop(core, x, p),
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
    // What the person's own window is showing right now: their game folder, or a build they
    // chose to play. `status()` carries the project but not the root, and the root is the whole
    // difference between "your game folder" and "that build".
    [HostMethod.PreviewShowing]: async () => x.servedRoots.get(LIVE_HANDLE) ?? null,
    [HostMethod.PreviewObserve]: routed(async (p: HarnessParams<typeof HostMethod.PreviewObserve>) =>
      observeBuild(x.previews.preview(p?.handle)),
    ),
    [HostMethod.PreviewAcquire]: async (p) => acquire(x, p),
    [HostMethod.PreviewRelease]: async (p) => {
      await x.previewPool?.release(p.handle);
      return true;
    },
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

async function screenshot(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewScreenshot>) {
  const preview = x.previews.preview(p?.handle);
  const quality = p?.quality ?? DEFAULT_SHOT_QUALITY;
  // Stats ride along with the JPEG so the critic gets a ground truth the image cannot
  // lie about; a preview without the capability still yields the picture, stats null.
  // `surface` asks for the whole page, the canvas, or whichever the preview judges the
  // game to live on; a caller that names none gets the preview's judgement, as the builder's
  // `capture` does. `page: true` is a permanent alias of `page` — an installed harness
  // workspace is an agent-editable copy of the seed and may keep sending it for ever.
  const asked: CaptureSurface = p?.surface ?? (p?.page ? CaptureSurface.Page : CaptureSurface.Auto);
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

async function acquire(x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewAcquire>) {
  const boot = x.harnessBoot;
  const lease = await x.previews.pool().acquire({
    label: p?.label ?? "facet",
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
  // The Settings ceiling the host holds every chat's workers to (`delegation.ts` `#assertWorkerRoom`).
  const workers = core.settings.buildersMax;
  try {
    const pool = x.previews.pool();
    return {
      max: pool.max,
      inUse: pool.leaseCount,
      free: Math.max(0, pool.max - pool.leaseCount),
      live: Boolean(core.options.preview),
      headless: Boolean(core.options.createHeadlessPreview),
      memory,
      workers,
    };
  } catch {
    return { max: 0, inUse: 0, free: 0, live: false, headless: false, memory, workers };
  }
}
