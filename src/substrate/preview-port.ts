/**
 * The senses, as the substrate sees them (moved down from studio-core.ts). The only real
 * implementation is Electron's GamePreview; tests satisfy it with a plain object, which is the
 * proof the port carries no Electron dependency.
 */
import type { PageUi, PageUiAnswer } from "./page-ui.ts";
import type { PreviewInputAction } from "./preview-input.ts";
import type { PixelDiff, PixelStats } from "./pixel-stats.ts";
import type {
  CaptureSurface,
  CropRect,
  PreviewConsoleEntry,
  PreviewPixelStats,
  PreviewPortStatus,
} from "../shared/preview-contract.ts";

export type { CaptureSurface, CropRect, PreviewConsoleEntry, PreviewPixelStats, PreviewPortStatus };

/**
 * What the studio's page shim is told when it is served onto a game's page (M4.1). The values
 * live here, in the port, because both sides need them: the main process bakes them into the
 * script tag and the harness passes them per load. `src/page/shim.ts` normalises whatever it
 * receives, so an older seed that sends nothing still gets the defaults.
 */
export interface ShimOptions {
  /** `studio` freezes the page's clock from the first frame; `wall` lets it run until a pause. */
  clock: "wall" | "studio";
  /** One simulated frame. `step(ms)` runs `round(ms / frameMs)` of them. */
  frameMs: number;
  /** How long the shim waits for the page to be ready before it says so and stops waiting. */
  readyMs: number;
  /** No fetch, no XHR and no resource entry for this long counts as quiet. */
  quietMs: number;
  /** Installed as `Math.random` at document start; null leaves the page's own generator alone. */
  seed: number | null;
  /** Report pointer lock as held even where Chromium refuses to grant it (a hidden window). */
  pointerLock: boolean;
  /** Count draw calls at the graphics API. */
  counters: boolean;
  /** Beyond this many outstanding timers the wrapper passes through to the natives. */
  maxTimers: number;
}

/**
 * How this game is connected to the studio, and what the studio can see of it (M4.2a) — the page
 * half of `game.attached`. Read off the renderer hook (what it wrapped, what it has seen
 * rendered, which scene and camera the last judged frame used), never off the game's own claim
 * about itself. `installed` is a game that assigned `window.__studio`; `attached` is a game the
 * studio recognised in the frames it drew, with nothing added to it.
 *
 * Every field but `contract` is optional: the caller (studio-core's `game.attached`) fills the
 * gaps of a page that answered nothing.
 */
export interface PageAttachReport {
  contract: "installed" | "attached" | "none";
  /** How the studio reached the page's three: its own import map, an inserted one, an inline URL. */
  reach?: string | null;
  /** Import-map key → the wrapper URL the studio pointed it at. */
  hooked?: Record<string, string>;
  shim?: boolean;
  hook?: boolean;
  renderer?: string | null;
  scene?: string | null;
  camera?: string | null;
  cameraKind?: string | null;
  cameras?: string[];
  eyes?: string[];
  /** Whether the game reports where its player is — not the pose itself. */
  player?: boolean;
  renders?: number;
  frames?: number;
  scenes?: number;
  /** One line per `three` the studio reached, `<key> r<revision>`. */
  three?: string[];
  reason?: string | null;
  loadError?: string | null;
  consoleErrors?: number;
}

/** One observation port on a game. Implemented by Electron's GamePreview. */
export interface PreviewPort {
  invalidateProfile?(reason: string): Promise<void>;
  profile?(request: import("./preview-profiler.ts").ProfileRequest): Promise<unknown>;
  /** `root` is a playable worktree; omit it to serve the live game folder. `loopback` serves it as http://localhost:<port>/ — what a game with its own shape expects. `shim` overrides the page shim for this load (the boot budget is the one that changes per game). */
  load(
    project: string,
    entry?: string,
    root?: string,
    options?: { loopback?: boolean; shim?: Partial<ShimOptions> },
  ): Promise<string>;
  reload(): Promise<void>;
  /** Optional: the person's Stop — the page is taken off the view until `resume`. */
  stop?(): Promise<void>;
  /** Optional: the person's Play on a stopped page — the same page again, from the top. */
  resume?(): Promise<void>;
  /** Optional: a line the studio itself puts on the game's console — e.g. a build that failed before the page could load. */
  note?(level: string, message: string, options?: { loadError?: boolean }): void;
  screenshot(quality?: number): Promise<Buffer>;
  /** A thumbnail capture with bounded statistics, never used as judged evidence. */
  screenshotCard?(quality: number, maxPx: number): Promise<Buffer | null>;
  /** Whether the stage is showing this view. */
  setVisible?(visible: boolean): void;
  /** Keep simulation alive while an agent observes the hidden stage. */
  setObserved?(observed: boolean): void;
  /** Silence the page's speakers; its own audio graph keeps running, so `__studio.audio()` still measures. */
  setAudioMuted?(muted: boolean): void;
  /**
   * Optional: FakePreview and headless builds compile without it; callers fall back to `screenshot`.
   * `page: true` captures the compositor frame (DOM included) instead of the WebGL canvas; it stays
   * accepted for ever as the alias of `surface: "page"`, because an installed harness workspace may
   * be an older seed. `surface` wins where both are given, and `surface: "auto"` lets the preview
   * decide from what the page looks like. The returned `surface` says what was PHOTOGRAPHED, never
   * what was asked for.
   */
  screenshotWithStats?(
    quality?: number,
    opts?: { page?: boolean; surface?: CaptureSurface },
  ): Promise<{ jpeg: Buffer; stats: PreviewPixelStats; surface?: CaptureSurface }>;
  /**
   * Optional: what the page's own DOM paints over the game — the studio's second eye (M4.5a).
   * The payload is a {@link PageUi}, or null when the page could not be probed, which is not the
   * same as a page with no UI. It is typed as the raw answer because a port may be a fake or an
   * older seed that reports the page's own shape; {@link readPageUi} is the one folder.
   */
  pageUi?(): Promise<PageUiAnswer>;
  evaluate(expression: string): Promise<unknown>;
  /** `keep`: state paths a board reads, cut last when the state is over the studio's budget. */
  studioState(options?: { keep?: readonly string[] }): Promise<unknown>;
  /**
   * Call a `window.__studio` method by name. The classic set is typed; the v2 contract adds
   * `eye`, `inspect` and `audio`, and a game may expose more — the page answers `{__missing}`
   * for anything it does not have.
   */
  studioCall(method: string, arg?: unknown): Promise<unknown>;
  input(actions: PreviewInputAction[]): Promise<{ ok: boolean; applied: number; width: number; height: number }>;
  /** Optional: where the synthetic mouse is, in view pixels — drawn as the cursor on a live agent screen. */
  pointer?(): { x: number; y: number };
  /** Optional: the view's size — the pixel space of its screenshots and of every computer-use coordinate. */
  viewSize?(): { width: number; height: number };
  /**
   * Optional, pooled windows only: take this size (window and view together), or with null the
   * size the window opened at. The pool calls it for one lease (`PreviewPool.resize`), never Live.
   */
  setViewSize?(size: { width: number; height: number } | null): void;
  /** Optional: whether this page load's input arrived as a real, trusted event (user activation). `null` before the first input, or when the port does not say. */
  trustedInput?(): boolean | null;
  /** Optional: what the studio's instrumentation got hold of on the page it just served (M4.2a). The page's own account of itself — read field by field, never spread onto an answer. */
  attachReport?(): Promise<PageAttachReport | null>;
  /** Optional: a fresh capture cropped to `region` (pixels) and scaled up — the computer tool's zoom. */
  zoom?(
    region: [number, number, number, number],
    quality?: number,
    opts?: { page?: boolean; surface?: CaptureSurface },
  ): Promise<{ jpeg: Buffer; width: number; height: number; region: [number, number, number, number] }>;
  consoleEntries(sinceMs?: number): PreviewConsoleEntry[];
  gpuErrors?(): Promise<string[]>;
  status(): PreviewPortStatus;
  /** Optional: crop a saved JPEG (a judged frame) at capture resolution; the crop is what a `vision` check looks at. */
  cropImage?(file: string, crop: CropRect, quality?: number): Promise<{ jpeg: Buffer; width: number; height: number }>;
  /** Optional: compare two saved JPEGs and draw a heatmap of where they differ. */
  diffImages?(fileA: string, fileB: string): Promise<{ diff: PixelDiff; heatmap: Buffer | null }>;
  /** Optional: pixel stats of an encoded image (a reference still) — the same numbers a capture yields. */
  statsOf?(data: Buffer): Promise<{ stats: PixelStats; width: number; height: number }>;
  /** Optional: re-encode an image as JPEG with its long side capped at `maxPx`. */
  resizeImage?(data: Buffer, maxPx: number, quality?: number): Promise<Buffer>;
  /** Optional: LEFT | RIGHT composite of two encoded images at `height` px, JPEG (pair images). */
  pairImages?(left: Buffer, right: Buffer, opts?: { height?: number; quality?: number }): Promise<Buffer>;
  /** Optional teardown for pooled headless ports; the visible view never gets disposed. */
  dispose?(): Promise<void> | void;
}
