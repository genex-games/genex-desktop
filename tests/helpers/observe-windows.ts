/**
 * Fake preview windows for a plugin's `observe` with a `still` or a `clip`: Live and the pooled
 * windows a real core leases, each writing what it was asked into its own log (the pooled ones
 * also into one shared log, in order, beside the pool's `acquire`), and a page whose answers the
 * test scripts. `observeHost` puts a real core over them; the clocks here run only when the test
 * says so.
 */
import { setImmediate } from "node:timers/promises";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginBinding, PluginClip, PluginStill, PluginStillProblem } from "../../src/shared/plugins.ts";
import { PluginClipMimeType } from "../../src/shared/plugins.ts";
import { ReadyPhase, ReadyVia, StillMimeType } from "../../src/shared/preview-contract.ts";
import type {
  PreviewClipAnswer,
  PreviewClipRequest,
  PreviewPort,
  PreviewStillAnswer,
  PreviewStillRequest,
} from "../../src/substrate/preview-port.ts";
import { coreLite } from "./core-lite.ts";
import { tmpDir } from "./tmp.ts";
import { CLIP_HUD_OFF } from "../../src/main/core/view-clip.ts";

/** What a fake page answers: its demos, the demo and camera calls, its load, its still and its clip. */
export interface PageScript {
  demos?: unknown;
  demo?: unknown;
  cameras?: unknown;
  eyes?: unknown;
  debugCamera?: unknown;
  loadError?: string;
  /** Runs inside the load; a load that never settles is a page that never arrives. */
  load?: () => Promise<void>;
  still?: (request: PreviewStillRequest) => Promise<PreviewStillAnswer>;
  clip?: (request: PreviewClipRequest) => Promise<PreviewClipAnswer>;
  /** A port that predates `still()`. */
  noStill?: boolean;
  /** A port that predates `clip()`. */
  noClip?: boolean;
  /** Told each time the studio asks the page whether it is ready. */
  onReadyProbe?: () => void;
  /** Runs inside each `__studio` call before it answers; one that waits is a page slow to answer that call. */
  answering?: (method: string) => Promise<void> | undefined;
}

/** The frame a fake port photographs. */
export const FRAME = {
  image: Buffer.from("png-bytes"),
  mimeType: StillMimeType.Png,
  width: 1920,
  height: 1080,
  source: "page",
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.95 },
  preview: Buffer.from("jpeg-preview"),
} as const;

/** The recording a fake port makes. */
export const TAKE = {
  video: Buffer.from("mp4-bytes"),
  mimeType: PluginClipMimeType.Mp4,
  width: 1280,
  height: 720,
  durationMs: 5000,
  poster: Buffer.from("jpeg-poster"),
  motion: 0.85,
} as const;

function pageAnswer(page: PageScript, method: string, arg: unknown): unknown {
  if (method === "demos") return page.demos ?? ["hero-shot"];
  if (method === "demo") return page.demo ?? { ok: true, demo: arg, result: null };
  if (method === "cameras") return page.cameras ?? ["default", "close"];
  if (method === "eyes") return page.eyes ?? ["eye:spawn", "eye:here", "eye:down"];
  if (method === "debugCamera") return page.debugCamera ?? { ok: true, camera: arg };
  return { ok: true };
}

/** A fake window: what it was asked, in order, and every call it got once it had been given back. */
export type FakePort = PreviewPort & {
  log: string[];
  asked: PreviewStillRequest[];
  clips: PreviewClipRequest[];
  /** Each page it loaded: its entry, and the folder it was served from when not the game's own. */
  loads: Array<{ entry: string | undefined; root: string | undefined }>;
  late: string[];
};
/** A still's answer as a plugin reads it: one of the two fields is set. */
export type StillAnswer = { still?: PluginStill; stillProblem?: PluginStillProblem };
/** A clip's answer as a plugin reads it: one of the two fields is set. */
export type ClipAnswer = { clip?: PluginClip; clipProblem?: PluginStillProblem };

/** The capture methods a fake window has unless the page says it predates them. */
function captures(page: PageScript, note: (entry: string) => void, touch: (method: string) => void, port: FakePort) {
  return {
    ...(page.noStill
      ? {}
      : {
          async still(request: PreviewStillRequest) {
            touch("still");
            note("still");
            port.asked.push(request);
            return page.still ? page.still(request) : { still: { ...FRAME } };
          },
        }),
    ...(page.noClip
      ? {}
      : {
          async clip(request: PreviewClipRequest) {
            touch("clip");
            note("clip");
            port.clips.push(request);
            return page.clip ? page.clip(request) : { clip: { ...TAKE } };
          },
        }),
  };
}

/** Live and the pooled windows, over one scripted page. */
export function windows(page: PageScript = {}) {
  const log: string[] = [];
  const port = (id: string): FakePort => {
    const own: string[] = [];
    const late: string[] = [];
    let gone = false;
    const note = (entry: string) => {
      own.push(entry);
      if (id !== "live") log.push(entry);
    };
    /** A real preview builds itself a new view to answer a call once it is closed: here it is only written down. */
    const touch = (method: string) => {
      if (gone) late.push(method);
    };
    let url: string | null = null;
    let loadError: string | null = null;
    const fake = {
      log: own,
      asked: [] as PreviewStillRequest[],
      clips: [] as PreviewClipRequest[],
      loads: [] as FakePort["loads"],
      late,
      async load(_project: string, entry?: string, root?: string) {
        touch("load");
        note("load");
        fake.loads.push({ entry, root });
        await page.load?.();
        url = `http://localhost:4173/${entry ?? "index.html"}`;
        loadError = page.loadError ?? null;
        return url;
      },
      async reload() {
        touch("reload");
        note("reload");
      },
      async screenshot() {
        touch("screenshot");
        note("screenshot");
        return Buffer.alloc(0);
      },
      async evaluate(expression?: string) {
        touch("evaluate");
        if (expression === CLIP_HUD_OFF) {
          note("hud:off");
          return null;
        }
        page.onReadyProbe?.();
        return { via: ReadyVia.Shim, ready: true, phase: ReadyPhase.Ready };
      },
      async studioState() {
        touch("studioState");
        return {};
      },
      async studioCall(method: string, arg?: unknown) {
        touch(`studioCall:${method}`);
        note(arg === undefined ? `call:${method}` : `call:${method}:${String(arg)}`);
        await page.answering?.(method);
        return pageAnswer(page, method, arg);
      },
      async input() {
        touch("input");
        note("input");
        return { ok: true, applied: 0, width: 0, height: 0 };
      },
      consoleEntries: () => [],
      status: () => {
        touch("status");
        return {
          project: null,
          url,
          crashed: false,
          unresponsive: false,
          loadError,
          consoleErrors: 0,
          consoleAvailable: true,
        };
      },
      setViewSize(size: { width: number; height: number } | null) {
        note(size ? `resize:${size.width}x${size.height}` : "restore");
      },
      async dispose() {
        note("release");
        gone = true;
      },
    } as unknown as FakePort;
    Object.assign(fake, captures(page, note, touch, fake));
    return fake;
  };
  const live = port("live");
  const made: FakePort[] = [];
  const create = async () => {
    log.push("acquire");
    const pooled = port(`pooled-${made.length}`);
    made.push(pooled);
    return pooled;
  };
  return { log, live, made, create };
}

/** The budget's clock: resolves once `ms` have passed and rejects when `signal` aborts. */
export type BudgetWait = (ms: number, signal: AbortSignal) => Promise<unknown>;

/** A real core over fake windows, and a plugin's still or clip of a game outside its library. */
export async function observeHost(
  page: PageScript = {},
  options: { hidden?: boolean; preview?: boolean; wait?: BudgetWait; inLibrary?: boolean } = {},
) {
  const w = windows(page);
  const lite = await coreLite({
    ...(options.preview === false ? {} : { preview: w.live }),
    ...(options.hidden === false ? {} : { createHeadlessPreview: w.create }),
    previewPoolMax: 4,
    ...(options.wait ? { pluginStill: { wait: options.wait }, pluginClip: { wait: options.wait } } : {}),
  });
  // A game in the library is one the core knows the kind of; any other is outside it.
  const game = options.inLibrary
    ? path.join(lite.gamesRoot, "game")
    : path.join(await realpath(await tmpDir("studio-still-game-")), "game");
  await mkdir(game);
  await writeFile(path.join(game, "index.html"), "<canvas></canvas>");
  const binding: PluginBinding = { project: "game", directory: game };
  const observe = (extra: Record<string, unknown>) =>
    lite.core.pluginServices.call("example", "observe", { project: "game", root: game, files: [], ...extra }, binding);
  const still = async (request: unknown): Promise<StillAnswer> => observe({ still: request }) as Promise<StillAnswer>;
  const clip = async (request: unknown): Promise<ClipAnswer> => observe({ clip: request }) as Promise<ClipAnswer>;
  return { ...w, still, clip, game, scratch: lite.core.layout.scratch };
}

/** The budget on a clock the test holds: it runs out only when the test says so. */
export function heldClock() {
  const timers: Array<{ ms: number; fire: () => void }> = [];
  return {
    wait: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        timers.push({ ms, fire: resolve });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    asked: () => timers.map((timer) => timer.ms),
    fire: () => timers[0]?.fire(),
  };
}

/** A gate the test opens: `started` once the page reached it, `arrive()` lets the page go on. */
function gate() {
  let started: () => void = () => {};
  let arrive: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = () => {
    started();
    return new Promise<void>((resolve) => {
      arrive = resolve;
    });
  };
  return { reached, wait, arrive: () => arrive() };
}

/** A page whose load starts and then waits for the test to let it arrive. */
export function lateLoad() {
  const g = gate();
  const script: PageScript = { load: g.wait };
  return { script, started: g.reached, arrive: g.arrive };
}

/** A page that answers `__studio.<method>` only when the test lets it. */
export function lateAnswer(method: string) {
  const g = gate();
  const script: PageScript = { answering: (called) => (called === method ? g.wait() : undefined) };
  return { script, started: g.reached, arrive: g.arrive };
}

/** A page whose recording starts and then waits for the test to let it end. */
export function lateClip() {
  const g = gate();
  const script: PageScript = {
    clip: async () => {
      await g.wait();
      return { clip: { ...TAKE } };
    },
  };
  return { script, started: g.reached, arrive: g.arrive };
}

/** Every call a host's windows got after they were given back. */
export const usedAfterRelease = (made: FakePort[]) => made.flatMap((window) => window.late);

/** Let everything a page's late answer leads to run: it is all promise steps, no timers. */
export async function settle() {
  await setImmediate();
  await setImmediate();
}
