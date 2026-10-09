/**
 * What a preview accepts and answers, as data: the capture, pixel, input, setup, readiness and
 * console shapes the harness sends and reads over the substrate RPC (`shared/harness-api.ts`).
 * `substrate/preview-port.ts` and its neighbours re-export them for the code that drives a
 * preview; nothing here runs.
 */

/** The `__studio` verbs that start and pause a game's clock (`src/game-template/src/studio.js`). */
export const GameClock = { Start: "start", Pause: "pause" } as const;
export type GameClock = (typeof GameClock)[keyof typeof GameClock];

/** The `__studio` verb that lets a racing game's own line (`config.steer`) steer the held keys. */
export const GameSteer = { Assist: "assist" } as const;
export type GameSteer = (typeof GameSteer)[keyof typeof GameSteer];

/**
 * Which surface a capture photographs (M4.5/M4.9a). `canvas` is what the game draws, `page` is
 * the whole compositor frame — the DOM menu, the HTML HUD, the loader — and `auto` lets the
 * preview decide from what it can see of the page.
 */
export const CaptureSurface = {
  Canvas: "canvas",
  Page: "page",
  Auto: "auto",
} as const;
export type CaptureSurface = (typeof CaptureSurface)[keyof typeof CaptureSurface];

/**
 * Which path took a picture: `page` is the page's own end-of-frame read of its canvas, which works
 * on a covered window; `compositor` is the window's frame (Electron's `capturePage`).
 */
export const CaptureSource = { Page: "page", Compositor: "compositor" } as const;
export type CaptureSource = (typeof CaptureSource)[keyof typeof CaptureSource];

/** What a capture proved about the frame, plus whether the page even has a canvas to light. */
export interface PreviewPixelStats extends PixelStats {
  canvas: boolean;
  /**
   * Which path took the picture: `page` is the page's own end-of-frame read (M4.9a), which
   * works on a covered window; `compositor` is Electron's `capturePage`, which is what a
   * `surface: "page"` request asks for and what a failed page read falls back to. This says
   * HOW the frame was read, never WHICH surface was asked for — see `screenshotWithStats`.
   */
  source?: "page" | "compositor";
  /** Whether the frame was composited over the resolved page background before it was encoded. */
  composited?: boolean;
  /** Draw calls the page counted for the photographed frame, when the counters were live. */
  drawCalls?: number | null;
  /** Why the page-side read declined, when it did. */
  captureReason?: string | null;
  /** The context the photographed canvas hands out. */
  kind?: "webgl" | "webgl2" | "webgpu" | "2d" | null;
  /**
   * Who took this picture (M4.9a). `shim` is the studio's own end-of-frame read off the canvas;
   * `game` is a picture the build's own `capture()` answered with — the facade delegates
   * `capture()` and `captureInfo()` to the game, so a `game` frame and the draw count beside it
   * are the build's claim about itself, and a check that counts draws must not read them as the
   * canvas's own answer.
   */
  provenance?: "shim" | "game" | null;
  /** Which rungs the page-side capture climbed to get this frame (`frame`, `pump`, `async`, `game`). */
  ladder?: string[] | null;
}

export interface PreviewConsoleEntry {
  at: number;
  level: string;
  message: string;
  source?: string;
  line?: number;
}

/** A crop rectangle as fractions of the frame: [x0, y0, x1, y1], origin top-left. */
export type CropRect = [number, number, number, number];

export interface PixelStats {
  width: number;
  height: number;
  sampled: number;
  /** 0–255, Rec.709. */
  meanLuma: number;
  litFraction: number;
  /** Fraction of sampled pixels per luma bin, low to high; sums to 1. Absent on degraded captures. */
  histogram?: number[];
  /** Mean luma (0–255) of horizontal thirds (top/middle/bottom) and vertical thirds (left/center/right). */
  bands?: { top: number; middle: number; bottom: number; left: number; center: number; right: number };
  /** Mean HSV saturation, 0–1. */
  saturation?: number;
  /** Luma standard deviation, 0–255. */
  contrast?: number;
  /**
   * Mean absolute luma step between horizontally adjacent pixels, 0–255. A smooth gradient
   * sits near 0; fine repeating texture that reads as moiré (a striped ceiling, a noise
   * tiling) pushes it up. The number behind a `moire` pixel check.
   */
  edgeDensity?: number;
  /**
   * 12-bin hue histogram (30° per bin, red first), each pixel weighted by its HSV saturation
   * and the whole normalised to sum 1 — a grey frame contributes nothing. The circular half
   * of the style distance.
   */
  hueHistogram?: number[];
  /** CIE Lab mean and standard deviation over the sample, [L, a, b]. */
  lab?: { mean: [number, number, number]; std: [number, number, number] };
  /** Up to 6 Lab centroids from a seeded, deterministic k-means, heaviest first; weights sum to 1. */
  palette?: Array<{ lab: [number, number, number]; weight: number }>;
  /** Mean luma (0–255) per horizontal sixteenth, top first — the frame's vertical structure. */
  lumaProfile?: number[];
}

export interface PixelDiff {
  /** Fraction of compared pixels whose luma moved by more than DIFF_THRESHOLD. */
  diffFraction: number;
  /** Mean absolute luma difference, 0–255. */
  meanAbsDiff: number;
  /** diffFraction per cell of a 3×3 grid, row-major (top-left first). */
  grid: number[];
  /** Compared pixel count; 0 when the frames could not be compared (size mismatch, empty). */
  compared: number;
}

/**
 * Why a game window's renderer went away (Electron's `render-process-gone`), as one typed code.
 * `killed` and `oom` are the machine's doing (the OS reclaimed memory), not the build's; the
 * harness keeps a copy in `loop/preview-gone.ts`. Wire values: never rename one.
 */
export const PreviewGone = {
  Killed: "killed",
  Oom: "oom",
  Crashed: "crashed",
  LaunchFailed: "launch-failed",
  Abnormal: "abnormal-exit",
  Integrity: "integrity-failure",
} as const;
export type PreviewGone = (typeof PreviewGone)[keyof typeof PreviewGone];

/**
 * The `source` of a line the studio itself puts on a game window's console, beside the page's own
 * (whose `source` is the script URL). `window-gone` is the host's note that the renderer went
 * away: the crash is read off `preview.status`, so the evidence pass never counts this line as an
 * error the build logged. The harness keeps a copy in `loop/preview-gone.ts`. Wire values.
 */
export const PreviewConsoleSource = {
  Observation: "studio:observation",
  WindowGone: "studio:window-gone",
} as const;
export type PreviewConsoleSource = (typeof PreviewConsoleSource)[keyof typeof PreviewConsoleSource];

/**
 * Electron's reasons, each read as a {@link PreviewGone}. An eviction to free memory is the
 * machine's pressure like an out-of-memory kill; a renderer that exits on its own while its page
 * is up has still gone abnormally.
 */
const RENDER_GONE_REASONS: ReadonlyMap<string, PreviewGone> = new Map([
  ["killed", PreviewGone.Killed],
  ["oom", PreviewGone.Oom],
  ["memory-eviction", PreviewGone.Oom],
  ["crashed", PreviewGone.Crashed],
  ["launch-failed", PreviewGone.LaunchFailed],
  ["abnormal-exit", PreviewGone.Abnormal],
  ["clean-exit", PreviewGone.Abnormal],
  ["integrity-failure", PreviewGone.Integrity],
]);

/** Read Electron's `render-process-gone` reason; one a later Electron adds is a plain crash, never the machine's. */
export function previewGone(reason: string): PreviewGone {
  return RENDER_GONE_REASONS.get(reason) ?? PreviewGone.Crashed;
}

/** What `PreviewPort.status()` and the `preview.status` RPC answer. */
export interface PreviewPortStatus {
  project: string | null;
  url: string | null;
  crashed: boolean;
  /**
   * Why the renderer went away while `crashed`; null while it runs. Absent from a port that does
   * not say (a fake, an older port), which reads as no reason given.
   */
  gone?: PreviewGone | null;
  /**
   * The view's size now, in pixels: the space of its captures. A window put at another size by
   * `preview.viewport` reads that size until its lease is released or a computer session takes it
   * (which puts it back at the facet size). Absent from a port that cannot say.
   */
  viewSize?: { width: number; height: number };
  unresponsive: boolean;
  loadError: string | null;
  consoleErrors: number | null;
  consoleAvailable?: boolean;
}

export type PreviewInputAction =
  /** `stepMs` advances the page's own loop between the press and the release, so a game that reads a key inside its frame sees it held (M4.1). It is honoured only while the studio owns the clock. */
  | { type: "tap"; keys: string[]; stepMs?: number }
  | { type: "down"; keys: string[] }
  | { type: "up"; keys: string[] }
  | { type: "hold"; keys: string[]; ms?: number }
  /** `px: true` reads x/y as pixels even when both fall in 0…1; `clicks` 2 = double, 3 = triple; `modifiers` are held for the click; `stepMs` is the tap's, for the press-to-release gap. */
  | {
      type: "click";
      x?: number;
      y?: number;
      button?: "left" | "right" | "middle";
      clicks?: number;
      modifiers?: string[];
      px?: boolean;
      stepMs?: number;
    }
  | { type: "move"; x: number; y: number; px?: boolean }
  /** Press at (fromX, fromY), glide to (x, y), release — a drag the way a player does it. */
  | {
      type: "drag";
      fromX: number;
      fromY: number;
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      px?: boolean;
    }
  | { type: "mousedown"; button?: "left" | "right" | "middle" }
  | { type: "mouseup"; button?: "left" | "right" | "middle" }
  | { type: "look"; dx: number; dy: number }
  /** Wheel at the pointer, or at (x, y) in pixels when given. */
  | { type: "scroll"; dx?: number; dy?: number; x?: number; y?: number }
  /** Type literal text: one keydown/char/keyup per character, the way a keyboard delivers it. */
  | { type: "type"; text: string }
  /** One key or a `+`-joined chord ("ctrl+s", "shift+Return"), `repeat` times. */
  | { type: "press"; combo: string; repeat?: number }
  | { type: "wait"; ms: number };

/**
 * The state a run is about, reached the way a player reaches it, after every load and before
 * anyone looks: the scout writes it (a key that opens the map picker, the click on the map,
 * a demo that does the same), the harness applies it before judges, captures and the computer
 * tool's first frame. `verify` is a probe over `__studio.state()` that says the state landed —
 * without it a run can build and judge the wrong map for hours because nothing checked.
 */
export interface PreviewSetup {
  /**
   * Knock first: a trusted move + click (and optional key tap) before anything else runs, at
   * the view centre or a placed point. It is what grants user activation, so a title screen
   * that waits for a click, a pointer lock and an AudioContext all get what they are waiting
   * for. `true` takes the centre.
   */
  gesture?: true | { x?: number; y?: number; keys?: string[] };
  /** Input actions in order (tap, hold, click, wait …), capped like any script. */
  actions?: PreviewInputAction[];
  /** A `config.demos` entry that reaches the state deterministically — preferred when it exists. */
  demo?: string;
  /** Milliseconds to let the game settle after the script; default 400. */
  settleMs?: number;
  /** A dotted state path and the value it must hold (`equals`), or merely be truthy. */
  verify?: { path: string; equals?: unknown; truthy?: boolean };
  /** One sentence for the log and the briefs: what this reaches and why. */
  note?: string;
  /**
   * A game that reports a front-end (`state().flow.playing === false`) is put into play with
   * `__studio.begin()` by default: by a studio window before the setup is replayed (the scout
   * recorded it in play), by the evidence pass after its seed. `false` keeps its title, menu or
   * countdown on screen for the worker that builds them; the playtester's window always does.
   */
  begin?: boolean;
}

/** The `__studio` verb that takes a game past its title, menu and countdown into play (`config.begin`). */
export const GameFront = { Begin: "begin" } as const;
export type GameFront = (typeof GameFront)[keyof typeof GameFront];

/**
 * The `__studio` verbs that put a named view on screen (`src/game-template/src/studio.js`): the
 * game's demo names, one demo run to its end state, the game's camera names and its built-in eye
 * cameras, and one camera placed.
 */
export const GameView = {
  Demos: "demos",
  Demo: "demo",
  Cameras: "cameras",
  Eyes: "eyes",
  DebugCamera: "debugCamera",
} as const;
export type GameView = (typeof GameView)[keyof typeof GameView];

/** How a still is encoded: lossless PNG, or a high-quality JPEG when the PNG is over its byte limit. */
export const StillMimeType = { Png: "image/png", Jpeg: "image/jpeg" } as const;
export type StillMimeType = (typeof StillMimeType)[keyof typeof StillMimeType];

/**
 * A still's exposure, measured on a small downscale of it. Every number is 0–1: Rec.709 luma of
 * the sRGB bytes as they are (no linearisation), its mean and standard deviation, the share of
 * samples below a luma of 0.10, and the share above the preview's unlit threshold (8 of 255).
 */
export interface StillExposure {
  lumaMean: number;
  lumaStdDev: number;
  nearBlackFraction: number;
  litFraction: number;
}

/** Which signal answered: the studio's own page shim, the game's own contract, or nothing. Wire values. */
export const ReadyVia = {
  Shim: "shim",
  Contract: "contract",
  None: "none",
} as const;
export type ReadyVia = (typeof ReadyVia)[keyof typeof ReadyVia];

/** Where the page says its boot stands. Wire values: the page shim writes them too. */
export const ReadyPhase = {
  Boot: "boot",
  Ready: "ready",
  Failed: "failed",
  Unknown: "unknown",
} as const;
export type ReadyPhase = (typeof ReadyPhase)[keyof typeof ReadyPhase];

/** What the studio waited for, and what it got. `preview.ready` answers with exactly this. */
export interface ReadyResult {
  ready: boolean;
  /** The STUDIO's wait — not the page's boot, which is `pageMs`. */
  ms: number;
  pageMs: number | null;
  /** The wait ended with no ready page and a budget spent — the studio's, or the page's own. */
  timedOut: boolean;
  /** The page said its own boot budget was spent, whatever the studio's clock did. */
  pageTimedOut: boolean;
  budgetMs: number;
  via: ReadyVia;
  phase: ReadyPhase;
  reason: string | null;
  polls: number;
  gesture: { needed: boolean; done: boolean; reasons: string[] };
}

export interface BuildObservation {
  ok: boolean;
  reasons: string[];
  pixels: PreviewPixelStats | null;
  studioMissing: boolean;
  frameBefore: number | null;
  frameAfter: number | null;
  frameAdvanced: boolean;
  running: boolean | null;
  fps: number | null;
}
