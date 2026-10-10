import { previewVisibility } from "./preview-visibility.ts";
import {
  CaptureSource,
  CaptureSurface,
  type PreviewGone,
  PreviewConsoleSource,
  previewGone,
} from "../shared/preview-contract.ts";
import { PreviewProfiler, type ProfileRequest } from "../substrate/preview-profiler.ts";
/**
 * Game preview.
 *
 * A `WebContentsView` with its **own session partition, no preload and no IPC bridge**: game code
 * has no path back into the app, which matters because the games are written by an agent that
 * rewrites its own instructions. All interaction is one-way, from the main process, through
 * `webContents` APIs.
 *
 * These are also the studio's senses. Screenshots, console output, crash signals and
 * `window.__studio.state()` are what turn "it renders" into something a critic can judge.
 */
import {
  type BaseWindow,
  type CustomScheme,
  type NativeImage,
  type Session,
  WebContentsView,
  nativeImage,
  net,
  protocol,
  session,
} from "electron";
import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  HttpRouteKind,
  HttpStatus,
  MAX_REWRITE_BYTES,
  confinePreviewContents,
  gameRequestAllowed,
  previewNavigationAllowed,
  rewriteGameHtml,
  routeHttp,
  servableProject,
  servedLocation,
  servedRelative,
  shouldRewrite,
  SHIM_PATH,
  textResponse,
  THREE_HOOK_PATH,
  threeHookModule,
  tooLargeNote,
} from "./page-serve.ts";
import { PAGE_DISPATCH } from "./page-dispatch.ts";
import { anchoredBounds } from "./preview-anchor.ts";
import { gameViewPreferences } from "./game-view.ts";
import { capActions, type PreviewInputAction } from "../substrate/preview-input.ts";
import { applyInputAction, type PageDispatch } from "./preview-input-driver.ts";
import { cropImageFile, diffImageFiles, encodedImageStats, pairJpeg, resizeToJpeg } from "./preview-images.ts";
import { DEFAULT_SHOT_QUALITY, encodeStill, stillFit } from "./core/capture.ts";
import {
  ATTACH_PROBE,
  GL_PROBE,
  PAGE_CAPTURE,
  PAGE_CAPTURE_TIMEOUT_MS,
  type PageCaptureInfo,
  STATE_MAX_CHARS,
  TRUSTED_PROBE,
  pageEvaluation,
  studioStateExpression,
} from "./preview-page-scripts.ts";
import { StateShape } from "../shared/studio-state-shape.ts";
import {
  computePixelStats,
  exposureStats,
  isEffectivelyBlack,
  type PixelDiff,
  type PixelStats,
} from "../substrate/pixel-stats.ts";
import { chooseCapture, probePageUi, resolveSurface, type PageUi } from "../substrate/page-ui.ts";
import type {
  CropRect,
  PageAttachReport,
  PreviewStillAnswer,
  PreviewStillRequest,
  ShimOptions,
} from "../substrate/preview-port.ts";
import { SECOND_MS } from "../shared/duration.ts";
import type { PreviewPixelStats } from "./studio-core.ts";
import { errorMessage } from "../shared/errors.ts";
import { setTimeout as delay } from "node:timers/promises";

/** What the preview's console tells the agent about the game view, and why a call is refused. */
const MESSAGE = {
  renderGone: (reason: string) => `render process gone: ${reason}`,
  unresponsive: "game loop is unresponsive",
  blocked: (what: string) => `the studio blocked ${what}: games run offline in the preview`,
  pageSurfaceFallback: (reason: string | null) =>
    `the page surface could not be photographed${reason === null ? "" : ` (${reason})`}; the canvas was photographed instead`,
  noFrame: "the page produced no frame to photograph",
  compositorRetry: (reason: string) =>
    `screenshot found no compositor frame; retrying once without changing window visibility (${reason})`,
  notMethodName: (method: string) => `not a studio method name: ${method}`,
  consoleUnavailable: "Console observation unavailable; no console-clean claim is possible",
  closed: "this game window was closed",
} as const;

export type { PageCaptureInfo };

export interface PreviewConsoleEntry {
  at: number;
  level: string;
  message: string;
  source?: string;
  line?: number;
}

export interface PreviewStatus {
  project: string | null;
  url: string | null;
  crashed: boolean;
  /** Why the renderer went away while `crashed`; null while it runs. */
  gone: PreviewGone | null;
  unresponsive: boolean;
  loadError: string | null;
  consoleErrors: number | null;
  consoleAvailable: boolean;
}

/** The Live stage's readiness probe; `page` is null while a navigation is under way or the page did not answer. */
export interface PreviewLiveStatus {
  project: string | null;
  navigating: boolean;
  /** The person stopped the game: its page is gone until Play (`resume`) brings it back. */
  stopped: boolean;
  loadError: string | null;
  crashed: boolean;
  page: { complete: boolean; resources: number; state: Record<string, unknown> | null } | null;
}

export interface GamePreviewOptions {
  /** Root of the game workspaces; `game://<project>/…` resolves inside it. */
  gamesRoot: string;
  /** Vendored libraries served at `game://<project>/vendor/…`. */
  vendorDir: string;
  partition?: string;
  consoleLimit?: number;
  /** GPU-backed offscreen surface for bounded, hidden profiling. */
  offscreen?: boolean;
  /** Live lookup for folders that don't sit under `gamesRoot`. */
  resolveRoot?: (project: string) => string;
  /** An agent's window: silent from the moment it is made. The user hears only the game on Live. */
  muted?: boolean;
  /** The app's default page-shim settings; a single `load` may override any of them. */
  shim?: Partial<ShimOptions>;
}

const SCHEME = "game";
/** What a stopped game's view holds: an empty page, allowed by the game partition (`data:`). */
const STOPPED_PAGE = "data:text/html;charset=utf-8,";
/** The pause before the one compositor retry a failed capture gets. */
const COMPOSITOR_RETRY_MS = 250;
/** The longest a capture waits for the page to present two frames. */
const FRAME_WAIT_MS = 400;
/** The longest the Live stage's readiness probe waits for the page to answer. */
const LIVE_PROBE_MS = 500;
/**
 * The longest a still waits for the page's own read of its canvas before it photographs the
 * compositor instead: a full-size PNG takes the page longer to encode than a look's frame.
 */
const STILL_PAGE_CAPTURE_TIMEOUT_MS = 5 * SECOND_MS;
/** The long side of the downscale a still's exposure is measured on. */
const STILL_STATS_MAX_PX = 160;
/** JPEG quality of the small preview that comes with a still. */
const STILL_PREVIEW_QUALITY = 80;

/**
 * Loopback ports for games served as `http://localhost:<port>/` — module-wide, because every
 * preview on the partition shares one protocol handler. A game with its own shape (a bundler's
 * output, a platform SDK) expects the origin a local preview would have: the Genex SDK's
 * local-test mode, for one, accepts only a loopback origin. Same files, same containment.
 */
const loopbackPorts = new Map<number, string>();
export function loopbackPortFor(project: string): number {
  let hash = 2166136261;
  for (const ch of project) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  let port = 40000 + (hash % 20000);
  while (loopbackPorts.has(port) && loopbackPorts.get(port) !== project) port = 40000 + ((port - 40000 + 1) % 20000);
  loopbackPorts.set(port, project);
  return port;
}

/** Register all privileged schemes together before ready: another call replaces the secure list. */
export function registerGameScheme(otherSchemes: CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    ...otherSchemes,
  ]);
}

const CARD_STATS_SAMPLES = 4096;

export class GamePreview {
  readonly options: GamePreviewOptions;
  #view: WebContentsView | null = null;
  readonly #visibility = previewVisibility((visible) => {
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.setVisible(visible);
  });
  #session: Session | null = null;
  /**
   * Closed for good (`destroy`): a pooled window's lease ended. Anything still waiting on its page
   * when it closed is refused rather than given a new view, which would leak a renderer and leave
   * this window's handlers serving the next window opened on the same partition.
   */
  #closed = false;
  #observed = false;
  #renderingVisible = true;
  /** Whether the speakers are off: from the start for an agent's window, as `setAudioMuted` says for Live. */
  #audioMuted: boolean;
  #requestedBounds: Electron.Rectangle | null = null;
  /** Full screen: the whole window, whatever the stage's slot measures. */
  #fill: Electron.Rectangle | null = null;
  /** The stopped game's address, kept for `resume`; null while the game runs. */
  #stoppedUrl: string | null = null;
  #visibleBounds: Electron.Rectangle = { x: 0, y: 0, width: 960, height: 600 };
  /** The stage's slot as last measured, and the window size it was measured in. */
  #slot: { bounds: Electron.Rectangle; viewport: Electron.Size | null } | null = null;
  /** The host window's content size now, which can be ahead of the slot's measurement. */
  #content: Electron.Size | null = null;
  #console: PreviewConsoleEntry[] = [];
  #consoleAvailable = false;
  #project: string | null = null;
  /** A load or reload this port started and has not seen finish: the page on screen is not the one asked for. */
  #navigating = false;
  #crashed = false;
  /** Why the renderer went away, from Electron's own reason; cleared with `#crashed`. */
  #gone: PreviewGone | null = null;
  #unresponsive = false;
  #loadError: string | null = null;
  #captureRecoveries = 0;
  /** What the page said about the last picture it took (or declined to take) — M4.9a. */
  #pageCaptureInfo: PageCaptureInfo | null = null;
  /**
   * The page-surface fallback says so once per load, not once per capture: the evidence pass
   * reads this same console ring buffer, and a window that cannot be composited would otherwise
   * push out every line the game itself wrote.
   */
  #pageSurfaceNoted = false;
  #pointer = { x: 0, y: 0 };
  /**
   * Whether Chromium's `sendInputEvent` reaches the page (a trusted DOM event arrived after
   * the first native one). null = not yet known. When it does, the synthetic DOM events are
   * withheld — sending both delivered every key three times (native, plus a synthetic on
   * window and on document) and a picker toggled by "i" flipped shut again (computer smoke).
   */
  #nativeDelivery: boolean | null = null;
  /** When set, `game://<project>/` is served from this directory instead of gamesRoot. */
  #rootOverride: { project: string; dir: string } | null = null;
  /**
   * The real folder the page was loaded from (M1). Serving checks containment against this, not
   * against the root re-resolved per request: a worktree swapped for a link after the load serves
   * nothing.
   */
  #pinnedRoot: { project: string; dir: string; real: string | null } | null = null;
  /** The entry this port loaded — the primary rule for which response receives the studio shim. */
  #entryPath: string | null = null;
  /** This load's shim overrides (the boot budget is the one that changes per game). */
  #shimLoad: Partial<ShimOptions> | null = null;
  /** Whether this build's vendor directory carries the shim bundle at all. */
  #shimPresent: boolean | null = null;
  /** Origins whose blocked request or navigation this load has already noted on the game's console. */
  #blockedNoted = new Set<string>();
  /** How the studio reached this page's `three`, recorded when the entry was rewritten. */
  #reach: { reach: string; hooked: Record<string, string> } = { reach: "none", hooked: {} };

  #profiler = new PreviewProfiler(
    (s) => this.evaluate(s),
    async () => {
      const manifest = JSON.parse(await readFile(path.join(this.options.vendorDir, "VERSION.json"), "utf8"));
      return String(manifest.three);
    },
  );

  async profile(request: ProfileRequest) {
    const result = (await this.#profiler.profile(request)) as {
      state?: string;
      sample?: { configuration: Record<string, unknown> };
    };
    if (result.state === "finished" && result.sample) {
      result.sample.configuration.surface = this.options.offscreen ? "electron-gpu-offscreen" : "electron-window";
      result.sample.configuration.frameRateLimit = this.options.offscreen ? 60 : null;
    }
    return result;
  }
  invalidateProfile(reason: string) {
    return this.#profiler.invalidate(reason);
  }

  constructor(options: GamePreviewOptions) {
    this.options = options;
    this.#audioMuted = options.muted ?? false;
  }

  get view(): WebContentsView | null {
    return this.#view;
  }

  /** Create the view and install the protocol handler on its partition. */
  create(): WebContentsView {
    if (this.#closed) throw new Error(MESSAGE.closed);
    if (this.#view) return this.#view;
    const partition = this.options.partition ?? "game-preview";
    const gameSession = session.fromPartition(partition);
    this.#session = gameSession;

    // The game never gets to ask for the camera, the mic, or anything else. Pointer lock (and
    // fullscreen, which some engines request alongside it) is the one exception: first-person
    // mouse-look is core gameplay, and denying it silently killed look controls for the user.
    const HUMAN_INPUT_PERMISSIONS = new Set(this.options.offscreen ? ["pointerLock"] : ["pointerLock", "fullscreen"]);
    gameSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(HUMAN_INPUT_PERMISSIONS.has(permission)),
    );
    gameSession.setPermissionCheckHandler((_wc, permission) => HUMAN_INPUT_PERMISSIONS.has(permission));

    if (!gameSession.protocol.isProtocolHandled(SCHEME)) {
      gameSession.protocol.handle(SCHEME, (request) => this.#serve(request));
    }
    // http://localhost:<port>/ is the same server under the origin a bundled game expects; any
    // other http request is a 403.
    if (!gameSession.protocol.isProtocolHandled("http")) {
      gameSession.protocol.handle("http", (request) => this.#serveLoopback(request));
    }
    // A game runs offline (SECUI-3): the partition may reach the studio's own server and nothing
    // else, so what an agent wrote into a game cannot leave the machine when the studio loads it.
    gameSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = gameRequestAllowed(details.url, loopbackPorts, details.method);
      if (!allowed) this.#noteBlocked("request", details.url);
      callback(allowed ? {} : { cancel: true });
    });

    const view = new WebContentsView({
      // Sandboxed, no preload, no on-device speech (`game-view.ts`).
      webPreferences: gameViewPreferences(gameSession, this.options.offscreen ?? false),
    });
    view.setBackgroundColor("#05070d");
    const wc = view.webContents;
    if (this.options.offscreen) wc.setFrameRate(60);
    if (this.#audioMuted) wc.setAudioMuted(true);
    confinePreviewContents(wc);
    wc.on("did-start-navigation", () => {
      void this.#profiler.invalidate("navigation changed");
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    // The page stays on game:// or its loopback origin: a remote page inside the studio's chrome,
    // which has no URL bar, is a sign-in form nobody can tell from the studio's own (SECUI-3).
    wc.on("will-navigate", (event) => {
      if (previewNavigationAllowed(event.url, loopbackPorts, { mainFrame: true })) return;
      event.preventDefault();
      this.#noteBlocked("navigation", event.url);
    });
    wc.on("will-frame-navigate", (event) => {
      if (previewNavigationAllowed(event.url, loopbackPorts, { mainFrame: event.isMainFrame })) return;
      event.preventDefault();
      this.#noteBlocked("navigation", event.url);
    });
    wc.on("console-message", (details) => {
      if (typeof details?.message !== "string") {
        this.#consoleAvailable = false;
        return;
      }
      this.#consoleAvailable = true;
      if (details.message === "__studio_console_channel_probe__") return;
      this.#push({
        at: Date.now(),
        level: String(details.level),
        message: details.message,
        ...(details.sourceId ? { source: details.sourceId } : {}),
        ...(details.lineNumber ? { line: details.lineNumber } : {}),
      });
    });
    wc.on("render-process-gone", (_event, details) => {
      this.#crashed = true;
      this.#gone = previewGone(details.reason);
      // Typed as the studio's own line: the crash is read off status(), never as an error the build logged.
      this.#push({
        at: Date.now(),
        level: "error",
        message: MESSAGE.renderGone(details.reason),
        source: PreviewConsoleSource.WindowGone,
      });
    });
    wc.on("unresponsive", () => {
      this.#unresponsive = true;
      this.#push({ at: Date.now(), level: "error", message: MESSAGE.unresponsive });
    });
    wc.on("responsive", () => {
      this.#unresponsive = false;
    });
    wc.on("did-fail-load", (_event, code, description, url) => {
      if (code === -3) return; // aborted, e.g. superseded navigation
      this.#loadError = `${description} (${code}) for ${url}`;
      this.#push({ at: Date.now(), level: "error", message: this.#loadError });
    });
    // At commit the new document exists and its module scripts are still being fetched: the
    // probe installed here sees the renderer's own getContext. The load-end install is the
    // idempotent fallback for a page that beat it.
    wc.on("did-navigate", () => void this.#installGlProbe());
    wc.on("did-finish-load", () => {
      this.#syncAnimationVisibility();
      this.#loadError = null;
      this.#crashed = false;
      this.#gone = null;
      void wc.executeJavaScript('console.debug("__studio_console_channel_probe__")').catch(() => {
        this.#consoleAvailable = false;
      });
      void this.#installGlProbe();
    });

    this.#view = view;
    this.#visibility.refresh();
    return view;
  }

  attachTo(window: BaseWindow, bounds: Electron.Rectangle): void {
    const view = this.create();
    window.contentView.addChildView(view);
    view.setBounds(bounds);
  }

  /** The stage's slot, measured in a window of `viewport` size (null: place it as measured). */
  setBounds(bounds: Electron.Rectangle, viewport: Electron.Size | null = null): void {
    this.#slot = { bounds, viewport };
    this.#placeSlot();
  }

  /** The host window's content area changed size: carry the slot along until it is measured again. */
  followWindow(content: Electron.Size): void {
    this.#content = content;
    if (this.#slot) this.#placeSlot();
  }

  #placeSlot(): void {
    const slot = this.#slot;
    if (!slot) return;
    void this.#profiler.invalidate("preview resized");
    const bounds = anchoredBounds(slot.bounds, slot.viewport, this.#content);
    this.#requestedBounds = bounds;
    if (bounds.width > 0 && bounds.height > 0) this.#visibleBounds = bounds;
    this.#applyBounds();
  }

  /** Preserve the observation size when the stage moves the live view out of sight. */
  setObserved(observed: boolean): void {
    this.#observed = observed;
    this.#applyBounds();
  }

  /** Full screen: cover `bounds` (the window's content) until called with null, then the slot again. */
  fill(bounds: Electron.Rectangle | null): void {
    this.#fill = bounds;
    if (bounds) this.#view?.setBounds(bounds);
    else this.#applyBounds();
  }

  #applyBounds(): void {
    if (this.#fill) {
      this.#view?.setBounds(this.#fill);
      return;
    }
    const bounds = this.#requestedBounds;
    if (!bounds) return;
    const observingHidden = this.#observed && (bounds.width === 0 || bounds.height === 0);
    this.#view?.setBounds(
      observingHidden
        ? { ...this.#visibleBounds, x: -this.#visibleBounds.width, y: -this.#visibleBounds.height }
        : bounds,
    );
  }

  /** Record stage/observer visibility independently of an occluding HTML modal. */
  setVisible(visible: boolean): void {
    this.#renderingVisible = visible;
    this.#visibility.setVisible(visible);
    this.#syncAnimationVisibility();
  }

  #syncAnimationVisibility(): void {
    const wc = this.#view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    void wc.executeJavaScript(`window.__studioAnimation?.setVisible(${this.#renderingVisible})`).catch(() => {});
  }

  /** Live's speakers: the page keeps playing, and its audio graph keeps running, either way. */
  setAudioMuted(muted: boolean): void {
    this.#audioMuted = muted;
    const wc = this.#view?.webContents;
    if (wc && !wc.isDestroyed() && wc.isAudioMuted() !== muted) wc.setAudioMuted(muted);
  }

  /** Native child views must stay below an HTML sign-in dialog until it closes. */
  setOccluded(occluded: boolean): void {
    this.#visibility.setOccluded(occluded);
  }

  /** Serve files from the project folder, refusing anything that escapes it. */
  async #serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return this.#serveFile(url.hostname, url.pathname, request);
  }

  async #serveLoopback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeHttp(url, loopbackPorts);
    // Never re-fetched from the main process: that sent a game's plain-http beacon off the machine.
    if (route.route === HttpRouteKind.Deny) return textResponse(HttpStatus.Forbidden);
    return this.#serveFile(route.project, url.pathname, request);
  }

  /** One console line per blocked origin per load: the harness reads why a game's request failed. */
  #noteBlocked(kind: "request" | "navigation", raw: string): void {
    let origin = raw;
    try {
      const url = new URL(raw);
      origin = url.origin !== "null" ? url.origin : url.protocol;
    } catch {
      /* not a URL: note it as given */
    }
    const key = `${kind} ${origin}`;
    if (this.#blockedNoted.has(key)) return;
    this.#blockedNoted.add(key);
    const what = kind === "request" ? `a network request to ${origin}` : `a navigation to ${origin}`;
    this.#push({
      at: Date.now(),
      level: "warning",
      message: MESSAGE.blocked(what),
    });
  }

  async #serveFile(project: string, pathname: string, request?: Request): Promise<Response> {
    const relative = servedRelative(pathname);
    if (relative === null) return textResponse(HttpStatus.BadRequest);
    if (!servableProject(project)) return textResponse(HttpStatus.Forbidden);
    // The wrapper module for this page's `three`: generated, never read off the disk. Its query
    // string carries the real module's URL, which the page's own import map named.
    if (relative === THREE_HOOK_PATH) return this.#serveThreeHook(request);
    // Containment on real paths: a game (or a link planted in it) must not reach the harness
    // workspace or the user's disk (SECUI-2). A missing file is a 404.
    const served = await servedLocation(relative, {
      vendor: this.options.vendorDir,
      gameRoot: () => this.#gameRoot(project),
      liveRoot: () => this.#liveRoot(project),
      pinnedGameRoot: () => this.#pinnedFor(project),
    });
    if (!served.ok) return textResponse(served.status);
    const target = served.path;
    try {
      const response = await net.fetch(pathToFileURL(target).toString());
      // Never cached: these are local files a contractor is actively rewriting. The first kiosk
      // build was invisible for 20 minutes because the session cached the scaffold-time template
      // and served it through every checkpoint and every Reload click.
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      const documentUrl = request?.url ?? `${SCHEME}://${project}/${relative}`;
      const rewritten = await this.#rewriteDocument(response, relative, target, documentUrl, request);
      if (rewritten !== null) {
        // The body changed length; a stale content-length truncates the page.
        headers.delete("content-length");
        return new Response(rewritten, { status: response.status, headers });
      }
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return textResponse(HttpStatus.NotFound);
    }
  }

  /**
   * The studio's own code goes onto the page here, on the response — so a worker who deletes
   * the tag from index.html gets it back on the next serve. Returns null for every response
   * that is left byte-identical, which is all of them but the entry document.
   */
  async #rewriteDocument(
    response: Response,
    relative: string,
    target: string,
    documentUrl: string,
    request?: Request,
  ): Promise<string | null> {
    const isEntry = this.#entryPath !== null && samePath(relative, this.#entryPath);
    const dest = request?.headers.get("sec-fetch-dest") ?? null;
    // The cheap verdict first: every asset, every module, every fetch a game makes is decided
    // here without touching the disk again.
    if (!shouldRewrite(response.headers.get("content-type"), relative, isEntry, dest, null)) return null;
    if (!(await this.#shimAvailable())) return null;
    // Content-Length is rarely present on a file:// response; the size comes from the file.
    let bytes: number | null = null;
    try {
      bytes = (await stat(target)).size;
    } catch {
      /* an unstatable file is rewritten on trust: it came out of the project folder */
    }
    if (bytes !== null && bytes > MAX_REWRITE_BYTES) {
      this.#push({ at: Date.now(), level: "warning", message: tooLargeNote(relative, bytes) });
      return null;
    }
    const html = await response.text();
    const result = rewriteGameHtml(html, { shim: this.#shimOptions(), documentUrl });
    for (const note of result.notes) this.#push({ at: Date.now(), level: "warning", message: note });
    if (isEntry) this.#reach = { reach: result.reach, hooked: result.hooked };
    return result.injected ? result.html : html;
  }

  /**
   * `/vendor/studio/three-hook.js?key=three&real=<url>` — the module the page's import map now
   * names for `three`. It re-exports the real module (so the page still has exactly one three)
   * and hands the namespace to the hook, which wraps every renderer class it exports.
   */
  #serveThreeHook(request?: Request): Response {
    const query = request ? new URL(request.url).searchParams : null;
    const body = threeHookModule(query?.get("real") ?? "", query?.get("key") ?? "three");
    if (!body) return textResponse(HttpStatus.BadRequest, "the studio's three wrapper needs an absolute module URL");
    return new Response(body, {
      status: HttpStatus.Ok,
      headers: { "content-type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /** A vendor directory built before the shim existed serves every page unchanged, not a 404. */
  async #shimAvailable(): Promise<boolean> {
    if (this.#shimPresent === null) {
      this.#shimPresent = await stat(path.resolve(this.options.vendorDir, SHIM_PATH.slice("vendor/".length)))
        .then(() => true)
        .catch(() => false);
      // The studio's own console, not the game's: a rig with a bare vendor directory is the
      // studio's problem, and the game's console is evidence a judge reads.
      if (!this.#shimPresent)
        console.warn(
          "the studio shim is not in this build's vendor directory; the studio cannot pace this page's clock",
        );
    }
    return this.#shimPresent;
  }

  /** The options this page's shim is installed with: the app's default under this load's own. */
  #shimOptions(): Partial<ShimOptions> {
    return { ...(this.options.shim ?? {}), ...(this.#shimLoad ?? {}) };
  }

  /** The real root pinned at load, while the preview still serves that same root for `project`. */
  #pinnedFor(project: string): string | null {
    const pinned = this.#pinnedRoot;
    if (pinned?.project !== project) return null;
    return pinned.dir === path.resolve(this.#gameRoot(project)) ? pinned.real : null;
  }

  #gameRoot(project: string): string {
    if (this.#rootOverride?.project === project) return this.#rootOverride.dir;
    return this.#liveRoot(project);
  }

  /** The game's own folder, whatever worktree the preview is showing instead. */
  #liveRoot(project: string): string {
    try {
      if (this.options.resolveRoot) return this.options.resolveRoot(project);
    } catch {
      /* unknown name — fall through to the library path, which 404s cleanly */
    }
    return path.resolve(this.options.gamesRoot, project);
  }

  /**
   * Serve `game://<project>/`. Pass `root` to play a review worktree; omit it to return to the
   * live folder. Same hostname either way, so relative URLs and `/vendor` keep working.
   */
  async load(
    project: string,
    entry = "index.html",
    root?: string,
    options: { loopback?: boolean; shim?: Partial<ShimOptions> } = {},
  ): Promise<string> {
    this.#nativeDelivery = null;
    this.#pageSurfaceNoted = false;
    this.#stoppedUrl = null;
    this.#entryPath = String(entry ?? "index.html").split(/[?#]/)[0] ?? "index.html";
    this.#shimLoad = options.shim ?? null;
    this.#reach = { reach: "none", hooked: {} };
    await this.#profiler.invalidate("source loaded");
    const view = this.create();
    this.#navigating = true;
    // Entries cached before no-store shipped would otherwise outlive it.
    await this.#session?.clearCache().catch(() => {});
    this.#project = project;
    this.#rootOverride = root ? { project, dir: path.resolve(root) } : null;
    const servedDir = path.resolve(this.#gameRoot(project));
    this.#pinnedRoot = { project, dir: servedDir, real: await realpath(servedDir).catch(() => null) };
    this.#loadError = null;
    this.#crashed = false;
    this.#gone = null;
    this.#console = [];
    this.#blockedNoted.clear();
    this.#consoleAvailable = false;
    const url = options.loopback
      ? `http://localhost:${loopbackPortFor(project)}/${entry}`
      : `${SCHEME}://${project}/${entry}`;
    try {
      await view.webContents.loadURL(url);
    } finally {
      this.#navigating = false;
    }
    return url;
  }

  /**
   * Stop the game: a blank page takes its place, so none of its scripts, frames or sound run, and
   * its address is kept for `resume`. The view, its session and its place on the stage stay.
   */
  async stop(): Promise<void> {
    const wc = this.#view?.webContents;
    if (!wc || wc.isDestroyed() || this.#stoppedUrl !== null) return;
    this.#stoppedUrl = wc.getURL();
    await this.#profiler.invalidate("preview stopped");
    this.#navigating = true;
    try {
      await wc.loadURL(STOPPED_PAGE);
    } finally {
      this.#navigating = false;
    }
  }

  /** Play a stopped game again: its page from the top, as it was served. Nothing to do while it runs. */
  async resume(): Promise<void> {
    const url = this.#stoppedUrl;
    const wc = this.#view?.webContents;
    if (url === null || !wc || wc.isDestroyed()) return;
    this.#stoppedUrl = null;
    this.#nativeDelivery = null;
    this.#pageSurfaceNoted = false;
    this.#console = [];
    this.#blockedNoted.clear();
    this.#consoleAvailable = false;
    this.#loadError = null;
    this.#navigating = true;
    try {
      await wc.loadURL(url);
    } finally {
      this.#navigating = false;
    }
  }

  async reload(): Promise<void> {
    // Reload on a stopped game plays it: reloading the blank page would show nothing.
    if (this.#stoppedUrl !== null) return this.resume();
    this.#nativeDelivery = null;
    this.#pageSurfaceNoted = false;
    await this.#profiler.invalidate("preview reloaded");
    if (!this.#view) return;
    this.#console = [];
    this.#blockedNoted.clear();
    this.#consoleAvailable = false;
    this.#loadError = null;
    // The user pressing Reload means "show me what is on disk NOW" — never a cached copy.
    this.#navigating = true;
    const wc = this.#view.webContents;
    wc.reloadIgnoringCache();
    await new Promise<void>((resolve) => {
      const done = () => {
        wc.off("did-finish-load", done);
        wc.off("did-fail-load", done);
        this.#navigating = false;
        resolve();
      };
      wc.once("did-finish-load", done);
      wc.once("did-fail-load", done);
    });
  }

  /** JPEG because these go straight into a vision model's context. */
  async screenshot(quality = DEFAULT_SHOT_QUALITY): Promise<Buffer> {
    await this.#profiler.invalidate("screenshot during sample");
    return (await this.#capture()).image.toJPEG(quality);
  }

  /** A card-sized photograph using bounded statistics and a single JPEG encode. */
  async screenshotCard(quality: number, maxPx: number): Promise<Buffer | null> {
    await this.#profiler.invalidate("screenshot during sample");
    const shot = await this.#capture({ surface: CaptureSurface.Auto }, CARD_STATS_SAMPLES);
    const size = shot.image.getSize();
    const stats =
      shot.stats ??
      computePixelStats(shot.image.toBitmap(), size.width, size.height, { maxSamples: CARD_STATS_SAMPLES });
    if (isEffectivelyBlack(stats)) return null;
    const scale = Math.min(1, maxPx / Math.max(size.width, size.height));
    const image =
      scale < 1
        ? shot.image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good",
          })
        : shot.image;
    return image.toJPEG(quality);
  }

  /**
   * One capture serving both the vision model and the arithmetic: the JPEG the critic looks
   * at and the pixel stats that say whether there was anything to look at. Same frame by
   * construction — two captures could straddle a render and disagree.
   */
  async screenshotWithStats(
    quality = DEFAULT_SHOT_QUALITY,
    opts: { page?: boolean; surface?: CaptureSurface } = {},
  ): Promise<{ jpeg: Buffer; stats: PreviewPixelStats; surface: CaptureSurface }> {
    await this.#profiler.invalidate("screenshot during sample");
    const { image, source, info, stats: measured } = await this.#capture(opts);
    const size = image.getSize();
    // `auto` already measured this exact frame to decide whether the canvas eye was the broken
    // one; measuring it twice would be the same arithmetic over the same bitmap.
    const stats = measured ?? computePixelStats(image.toBitmap(), size.width, size.height);
    let canvas = true;
    try {
      canvas = Boolean(await this.evaluate("!!document.querySelector('canvas')"));
    } catch {
      /* an unreachable page defaults to true — a black screen should still be suspect */
    }
    return {
      jpeg: image.toJPEG(quality),
      stats: {
        ...stats,
        canvas,
        source,
        composited: info?.composited === true,
        drawCalls: typeof info?.drawCalls === "number" ? info.drawCalls : null,
        captureReason: typeof info?.reason === "string" ? info.reason : null,
        kind: (info?.kind as PreviewPixelStats["kind"]) ?? null,
        // Who took the picture, and by which rung. A frame the game supplied is evidence about
        // the game's own claim, not about its canvas, and a check that counts draws must know.
        provenance: info?.provenance === "shim" || info?.provenance === "game" ? info.provenance : null,
        ladder: Array.isArray(info?.ladder) ? info.ladder.slice(0, 8).map((rung) => String(rung)) : null,
      },
      // What was PHOTOGRAPHED, not how it was read: a compositor frame is the whole page, and
      // the page's own end-of-frame read is the canvas.
      surface: source === CaptureSource.Compositor ? CaptureSurface.Page : CaptureSurface.Canvas,
    };
  }

  /** Where the synthetic mouse is, in view pixels — the cursor a live viewer draws over the frame. */
  pointer(): { x: number; y: number } {
    if (this.#pointer.x === 0 && this.#pointer.y === 0) {
      const bounds = this.#view?.getBounds();
      if (bounds) return { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };
    }
    return { ...this.#pointer };
  }

  /**
   * Did this page load's input arrive as a real, TRUSTED event? `null` until the first input of
   * the load has been probed, then whatever the page's own listener saw. A gesture that is not
   * trusted grants no user activation, so pointer lock, `AudioContext.resume()` and a title
   * screen waiting for a click all stay where they are.
   */
  trustedInput(): boolean | null {
    return this.#nativeDelivery;
  }

  /** The view's size in pixels — the coordinate space of every screenshot it returns. */
  viewSize(): { width: number; height: number } {
    const bounds = this.#view?.getBounds();
    return { width: Math.max(1, Math.round(bounds?.width ?? 0)), height: Math.max(1, Math.round(bounds?.height ?? 0)) };
  }

  /**
   * A fresh capture, cropped to `region` (pixels, origin top-left) and scaled up so a small
   * control reads at full size — the computer tool's `zoom`. Coordinates stay those of the
   * whole frame; the caption says which part this is.
   */
  async zoom(
    region: [number, number, number, number],
    quality = 85,
    opts: { page?: boolean; surface?: CaptureSurface } = {},
  ): Promise<{ jpeg: Buffer; width: number; height: number; region: [number, number, number, number] }> {
    await this.#profiler.invalidate("zoom during sample");
    const { image } = await this.#capture(opts);
    const size = image.getSize();
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
    const x0 = clamp(Math.min(region[0], region[2]), size.width - 1);
    const y0 = clamp(Math.min(region[1], region[3]), size.height - 1);
    const x1 = clamp(Math.max(region[0], region[2]), size.width);
    const y1 = clamp(Math.max(region[1], region[3]), size.height);
    const rect = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    let cropped = image.crop(rect);
    // Up to 2× so the model gets real pixels, never a blurry blow-up of a tiny patch.
    const scale = Math.min(2, size.width / rect.width, size.height / rect.height);
    if (scale > 1.05)
      cropped = cropped.resize({
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
        quality: "best",
      });
    const out = cropped.getSize();
    return { jpeg: cropped.toJPEG(quality), width: out.width, height: out.height, region: [x0, y0, x1, y1] };
  }

  /**
   * A plugin's still: the canvas as the page draws it now, never larger than asked, as a PNG or
   * the best JPEG that fits `maxBytes` (`encodeStill`), with its exposure measured on a small
   * downscale and a JPEG preview. The page's own read gets a longer budget than a look's, and the
   * compositor is the fallback exactly as for any canvas capture.
   */
  async still(request: PreviewStillRequest): Promise<PreviewStillAnswer> {
    await this.#profiler.invalidate("still during sample");
    const shot = await this.#captureCanvas(STILL_PAGE_CAPTURE_TIMEOUT_MS);
    const taken = shot.image.getSize();
    const size = stillFit(taken, request);
    // A compositor frame on a Retina display holds more pixels than its size says; resizing it to
    // the size it reports is what makes the encoded image that size.
    const resize =
      shot.source === CaptureSource.Compositor || size.width !== taken.width || size.height !== taken.height;
    const image = resize ? shot.image.resize({ ...size, quality: "best" }) : shot.image;
    const encoded = encodeStill(
      { png: () => image.toPNG(), jpeg: (quality) => image.toJPEG(quality) },
      request.maxBytes,
    );
    if ("tooLarge" in encoded) return encoded;
    return {
      still: {
        image: encoded.data,
        mimeType: encoded.mimeType,
        ...size,
        source: shot.source,
        stats: stillExposure(image, size),
        preview: scaledTo(image, size, request.previewMaxPx).toJPEG(STILL_PREVIEW_QUALITY),
      },
    };
  }

  /**
   * The whole surface question in one place (M4.5a). `canvas` is what the game draws, `page` is
   * the compositor frame with every DOM element on it — the menu, the loader, the HTML HUD —
   * and `auto` asks the page what it looks like before it decides. Only `auto` costs a probe,
   * and the probe can never fail a capture: every rung of the ladder falls toward a picture.
   */
  async #capture(
    opts: { page?: boolean; surface?: CaptureSurface } = {},
    maxSamples?: number,
  ): Promise<{ image: NativeImage; source: CaptureSource; info: PageCaptureInfo | null; stats?: PixelStats }> {
    const asked = resolveSurface(opts);
    const chosen = await chooseCapture(asked, {
      pageUi: () => this.pageUi(),
      canvas: () => this.#captureCanvas(),
      page: () => this.#capturePageSurface(),
      measure: (shot) => {
        const size = shot.image.getSize();
        return computePixelStats(
          shot.image.toBitmap(),
          size.width,
          size.height,
          maxSamples ? { maxSamples } : undefined,
        );
      },
    });
    return chosen.stats ? { ...chosen.shot, stats: chosen.stats } : chosen.shot;
  }

  /**
   * What the page's own DOM paints over the game. `null` means the page could not be probed —
   * never that it has no UI. This is the second eye: a car select, a pause screen or a loader
   * that lives in the DOM is invisible to a canvas read, and used to be judged as a black frame.
   */
  async pageUi(): Promise<PageUi | null> {
    if (!this.#view) return null;
    return probePageUi((expression) => this.evaluate(expression));
  }

  /**
   * The page surface: the compositor's frame, which is the only thing that sees the DOM.
   *
   * It NEVER restores a hidden window. The evidence pass takes a user-view frame every pass now,
   * and un-hiding the user's window once a pass (or once a camera) to get a nicety is not a
   * trade the studio makes. An offscreen port does attempt it — offscreen rendering paints its
   * own frames — and falls back like any other. A page frame is a nicety; an unattended run
   * must never depend on one, so a failure ends at the page's own canvas read, not at an error.
   */
  async #capturePageSurface(): Promise<{
    image: NativeImage;
    source: CaptureSource;
    info: PageCaptureInfo | null;
  }> {
    const view = this.create();
    const compositor = async (): Promise<NativeImage | null> => {
      await this.#awaitPresent();
      const image = await view.webContents.capturePage();
      return image.isEmpty() ? null : image;
    };
    let failure: unknown = null;
    try {
      const first = await compositor();
      if (first) return { image: first, source: CaptureSource.Compositor, info: null };
    } catch (err) {
      failure = err;
    }
    try {
      // The failed request itself wakes the compositor on an occluded window, so one paced
      // retry is worth it here exactly as it is on the canvas path.
      try {
        view.webContents.invalidate();
      } catch {
        /* offscreen-only in some Electron versions — the timed retry still stands alone */
      }
      await sleep(COMPOSITOR_RETRY_MS);
      const second = await compositor();
      if (second) return { image: second, source: CaptureSource.Compositor, info: null };
    } catch (err) {
      failure = err;
    }
    const fallback = await this.#capturePageSide();
    if (!this.#pageSurfaceNoted) {
      this.#pageSurfaceNoted = true;
      this.#push({
        at: Date.now(),
        level: "warning",
        message: MESSAGE.pageSurfaceFallback(failure ? errorMessage(failure) : null),
      });
    }
    if (fallback) return { image: fallback.image, source: CaptureSource.Page, info: fallback.info };
    throw failure ?? new Error(MESSAGE.noFrame);
  }

  /**
   * Capture must never change native window visibility. A lost compositor surface gets one
   * paced retry without restoring, showing or focusing its host. If both capture paths fail,
   * report unavailable evidence rather than exposing a hidden window for a screenshot.
   */
  async #captureCanvas(
    pageTimeoutMs = PAGE_CAPTURE_TIMEOUT_MS,
  ): Promise<{ image: NativeImage; source: CaptureSource; info: PageCaptureInfo | null }> {
    const view = this.create();
    // First choice: ask the page itself. `__studio.capture()` re-renders and reads the WebGL
    // canvas in one JS turn, so the pixels never touch the compositor — a window that is
    // covered, on another Space, or on a sleeping display photographs exactly the same. One
    // occluded run lost every first-iteration build to "display surface not available".
    const pageShot = await this.#capturePageSide(pageTimeoutMs);
    if (pageShot) return { image: pageShot.image, source: CaptureSource.Page, info: pageShot.info };
    const declined = this.#pageCaptureInfo;
    await this.#awaitPresent();
    try {
      return { image: await view.webContents.capturePage(), source: CaptureSource.Compositor, info: declined };
    } catch (err) {
      // Occluded windows can lose their compositor surface too. The failed request can wake
      // the compositor, so allow one paced retry without changing the user's window state.
      this.#captureRecoveries++;
      this.#push({
        at: Date.now(),
        level: "warning",
        message: MESSAGE.compositorRetry(errorMessage(err)),
      });
      try {
        view.webContents.invalidate();
      } catch {
        /* offscreen-only in some Electron versions — the timed retry still stands alone */
      }
      await sleep(COMPOSITOR_RETRY_MS);
      await this.#awaitPresent();
      return { image: await view.webContents.capturePage(), source: CaptureSource.Compositor, info: declined };
    }
  }

  /**
   * The page's own end-of-frame photograph — the whole frame the player sees, read inside the
   * page in the same JS turn as the draw and composited over the page's background (M4.9a).
   * The studio prefers it because it works on a covered window, and it is raced against a
   * main-side timeout: a wedged page must degrade to the compositor, never block every caller.
   */
  async #capturePageSide(
    timeoutMs = PAGE_CAPTURE_TIMEOUT_MS,
  ): Promise<{ image: NativeImage; info: PageCaptureInfo | null } | null> {
    const view = this.#view;
    if (!view) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = { timedOut: true } as const;
      const payload = await Promise.race([
        view.webContents.executeJavaScript(PAGE_CAPTURE, true),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (payload === timedOut) {
        this.#pageCaptureInfo = { reason: "the page did not answer the capture within its budget" };
        return null;
      }
      const answer = payload as { image?: unknown; info?: PageCaptureInfo | null } | null;
      this.#pageCaptureInfo = answer && typeof answer === "object" ? (answer.info ?? null) : null;
      const dataUrl = answer?.image;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
      const image = nativeImage.createFromDataURL(dataUrl);
      return image.isEmpty() ? null : { image, info: this.#pageCaptureInfo };
    } catch {
      this.#pageCaptureInfo = { reason: "the page-side capture threw" };
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `capturePage()` returns the compositor's last *presented* frame, not the canvas. A WebGL
   * draw made synchronously (a `debugCamera` switch on a paused game) isn't presented until the
   * next compositor commit, so a capture racing it grabs the previous camera's pixels — one run
   * lost 10 of 36 iterations to "close.jpg ≡ default.jpg". Two rAFs guarantee the draw was
   * committed and presented; the timeout keeps a hidden window (no rAF) from hanging a capture.
   */
  async #awaitPresent(): Promise<void> {
    const view = this.#view;
    if (!view) return;
    try {
      // `rafReal` is the pristine animation frame the shim captured at document start: waiting
      // on the patched one would wait for a clock the studio itself has frozen. A page that
      // never booted has neither, and says so at once instead of paying 400 ms per camera.
      await Promise.race([
        view.webContents.executeJavaScript(
          `(() => {
            const raf = window.__studioClock ? window.__studioClock.rafReal : null;
            const step = raf ? (cb) => raf(cb) : (cb) => requestAnimationFrame(cb);
            if (!raf && document.readyState === "loading") return true;
            return new Promise((r) => step(() => step(() => r(true))));
          })()`,
          true,
        ),
        sleep(FRAME_WAIT_MS),
      ]);
    } catch {
      /* an unbooted page has no rAF to wait on — capture proceeds as before */
    }
  }

  get captureRecoveries(): number {
    return this.#captureRecoveries;
  }

  /**
   * Evaluate in the game's main world. The result is untrusted data — it is produced by code the
   * agent wrote — so it is size-capped and only ever handled as JSON.
   */
  async evaluate(expression: string, maxChars = 64_000): Promise<unknown> {
    const view = this.create();
    // `Promise.resolve` first: an expression that evaluates to a promise (a `fetch`, an async
    // probe) must be awaited *before* serialising, otherwise every async probe silently returns
    // `{}` and any check built on it passes without testing anything.
    const raw = (await view.webContents.executeJavaScript(pageEvaluation(expression), true)) as string | undefined;
    if (raw === undefined) return undefined;
    const text = String(raw);
    if (text.length > maxChars) {
      return { [StateShape.Truncated]: true, length: text.length, head: text.slice(0, maxChars) };
    }
    return JSON.parse(text);
  }

  /**
   * What the Live stage needs before it uncovers the native view: whose page is loaded, whether a
   * navigation is still under way, and whether the page's own requests have settled. Frames are
   * no signal here — a view kept out of sight while it loads does not animate until it is shown.
   */
  async liveStatus(): Promise<PreviewLiveStatus> {
    const wc = this.#view?.webContents;
    const base = {
      project: this.#project,
      loadError: this.#loadError,
      crashed: this.#crashed,
      stopped: this.#stoppedUrl !== null,
    };
    if (!wc || wc.isDestroyed()) return { ...base, navigating: false, page: null };
    if (this.#navigating || wc.isLoading()) return { ...base, navigating: true, page: null };
    const probe = `(() => { let state = null; try { const full = window.__studio ? window.__studio.state() : null; state = full ? { phase: full.phase, drawCalls: full.drawCalls } : null; } catch {} return { complete: document.readyState === "complete", resources: performance.getEntriesByType("resource").length, state }; })()`;
    const page = (await Promise.race([
      this.evaluate(probe).catch(() => null),
      delay(LIVE_PROBE_MS, null),
    ])) as PreviewLiveStatus["page"];
    const answered = page !== null && typeof page === "object" && "complete" in page;
    return { ...base, navigating: false, page: answered ? page : null };
  }

  /**
   * `window.__studio.state()` — the structural probe that complements screenshots. Bounded by
   * structure in the page (`boundStudioState`): a state past {@link STATE_MAX_CHARS} loses its
   * largest lists to stubs, never the tail of its text, and the `keep` paths are cut last.
   */
  async studioState(options?: { keep?: readonly string[] }): Promise<unknown> {
    return this.evaluate(studioStateExpression(STATE_MAX_CHARS, options?.keep));
  }

  /**
   * Is this game connected to the studio, and how? The page half comes from the hook — what it
   * wrapped, what it has seen rendered, which scene and camera the last judged frame used — and
   * the studio's half from the serve layer, which knows how it reached the page's `three` and
   * whether the load failed before any of it ran.
   */
  async attachReport(): Promise<PageAttachReport> {
    const page = (await this.evaluate(ATTACH_PROBE)) as Record<string, unknown> | null;
    const answered = page && typeof page === "object" && !("__error" in page);
    const base: Record<string, unknown> = answered
      ? (page as Record<string, unknown>)
      : { contract: "none", shim: false, reason: "the page did not answer the studio's attach probe" };
    const status = this.status();
    return {
      ...base,
      reach: this.#reach.reach,
      hooked: this.#reach.hooked,
      loadError: status.loadError,
      consoleErrors: status.consoleErrors,
    } as PageAttachReport;
  }

  /**
   * WebGL errors the page console never sees (they live in the GPU process). The hook is
   * installed on every load; an empty list means a clean context, not a missing probe.
   */
  async gpuErrors(): Promise<string[]> {
    const value = await this.evaluate("window.__studioGl ? window.__studioGl.errors() : []");
    return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
  }

  async #installGlProbe(): Promise<void> {
    const view = this.#view;
    if (!view) return;
    try {
      await view.webContents.executeJavaScript(GL_PROBE, true);
    } catch {
      /* a game that is still booting will get the probe on the next load */
    }
  }

  async studioCall(method: string, arg?: unknown): Promise<unknown> {
    await this.#profiler.invalidate(`studio ${method} during sample`);
    // The method name is interpolated into page JS: only a plain identifier may travel.
    if (!/^[A-Za-z_$][\w$]*$/.test(method)) throw new Error(MESSAGE.notMethodName(method));
    const argument = arg === undefined ? "" : JSON.stringify(arg);
    return this.evaluate(
      `(window.__studio && typeof window.__studio.${method} === "function") ? window.__studio.${method}(${argument}) : { __missing: true }`,
    );
  }

  /**
   * A `vision` check looks at one crop of the exact frame that was judged, so the crop is cut
   * from the saved JPEG rather than re-captured — two captures could straddle a render.
   */
  async cropImage(
    file: string,
    crop: CropRect,
    quality?: number,
  ): Promise<{ jpeg: Buffer; width: number; height: number }> {
    return cropImageFile(file, crop, quality);
  }

  /**
   * Challenger-vs-incumbent difference on the same camera: the number that says "nothing
   * visibly changed" before a judge is paid to look, plus a heatmap of where it did.
   */
  async diffImages(fileA: string, fileB: string): Promise<{ diff: PixelDiff; heatmap: Buffer | null }> {
    return diffImageFiles(fileA, fileB);
  }

  /** Pixel stats of an encoded still (JPEG/PNG/WebP/GIF) — a reference gets the same numbers a capture does. */
  async statsOf(data: Buffer): Promise<{ stats: PreviewPixelStats; width: number; height: number }> {
    const { stats, width, height } = encodedImageStats(data);
    return { stats: { ...stats, canvas: false }, width, height };
  }

  /** Re-encode as JPEG with the long side capped — reference stills at judge/builder size. */
  async resizeImage(data: Buffer, maxPx: number, quality?: number): Promise<Buffer> {
    return resizeToJpeg(data, maxPx, quality);
  }

  /**
   * LEFT | RIGHT composite: both images fitted into `height`-tall boxes of the same width,
   * on black, with a 4-px divider — the pair image a judge or builder compares.
   */
  async pairImages(left: Buffer, right: Buffer, opts: { height?: number; quality?: number } = {}): Promise<Buffer> {
    return pairJpeg(left, right, opts);
  }

  /**
   * Drive the game the way a player does: keys, clicks, look. Chromium `sendInputEvent` plus
   * DOM events plus `__studio.injectInput`, so a paused `step()` playthrough still sees WASD.
   */
  async input(actions: PreviewInputAction[]): Promise<{ ok: boolean; applied: number; width: number; height: number }> {
    await this.#profiler.invalidate("input during sample");
    const view = this.create();
    const bounds = view.getBounds();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    if (this.#pointer.x === 0 && this.#pointer.y === 0) {
      this.#pointer = { x: Math.round(width / 2), y: Math.round(height / 2) };
    }
    try {
      // Focusing a hidden observation view can order its native host window onto macOS.
      // Offscreen input has native delivery probing and DOM fallback; it needs no OS focus.
      if (!this.options.offscreen) view.webContents.focus();
    } catch {
      /* a background window can still take DOM events */
    }
    // Before the first native event of this page: the listener that will say whether it arrived.
    if (this.#nativeDelivery === null) {
      await view.webContents.executeJavaScript(TRUSTED_PROBE, true).catch(() => {});
    }

    const plan = capActions(actions);
    let applied = 0;
    for (const action of plan) {
      await this.#applyInput(view, action, width, height);
      applied++;
    }
    return { ok: true, applied, width, height };
  }

  async #applyInput(view: WebContentsView, action: PreviewInputAction, width: number, height: number): Promise<void> {
    const wc = view.webContents;
    await applyInputAction(
      {
        width,
        height,
        send: (event) => {
          try {
            wc.sendInputEvent(event);
          } catch {
            /* JS dispatch below is the reliable path when the OS will not focus us */
          }
        },
        dispatch: (payload) => this.#dispatchPage(payload),
        stepClock: (ms) => this.#stepClock(ms),
        pointer: () => this.#pointer,
        movePointer: (point) => {
          this.#pointer = point;
        },
      },
      action,
    );
  }

  /** Advance the page's own loop by hand — the frozen-clock stand-in for a real sleep. */
  async #stepClock(ms: number): Promise<void> {
    const view = this.#view;
    if (!view) return;
    try {
      await view.webContents.executeJavaScript(
        `(() => { const c = window.__studioClock; return c && typeof c.step === "function" ? c.step(${Math.round(ms)}) : null; })()`,
        true,
      );
    } catch {
      /* a page that has not booted yet has no clock to step; the next input retries */
    }
  }

  async #dispatchPage(payload: PageDispatch): Promise<void> {
    const view = this.#view;
    if (!view) return;
    // Native delivery, once proven, makes the synthetic DOM copies a duplicate: keep only the
    // studio's own injection (held keys, look) so a paused step() playthrough still sees them.
    if (this.#nativeDelivery === null && payload.dom?.length) await this.#probeNativeDelivery(view);
    // Native delivery, once proven, makes a synthetic copy of the SAME event type a duplicate;
    // the page decides that per type, because it is the only side that knows what it heard.
    const send: PageDispatch = this.#nativeDelivery === true ? { ...payload, native: true } : payload;
    try {
      await view.webContents.executeJavaScript(`(${PAGE_DISPATCH})(${JSON.stringify(send)})`, true);
    } catch {
      /* a page that has not booted yet will miss this beat; the next input retries */
    }
  }

  /** Did the native event just sent arrive as a trusted DOM event? Asked once per page. */
  async #probeNativeDelivery(view: WebContentsView): Promise<void> {
    try {
      // The native event is already in flight; give the page a beat to hear it.
      await sleep(40);
      const seen = await view.webContents.executeJavaScript("window.__studioTrustedInput === true", true);
      this.#nativeDelivery = seen === true;
    } catch {
      this.#nativeDelivery = null;
    }
  }

  consoleEntries(sinceMs = 0): PreviewConsoleEntry[] {
    const entries = this.#console.filter((entry) => entry.at >= sinceMs);
    return this.#consoleAvailable
      ? entries
      : [
          ...entries,
          {
            at: Date.now(),
            level: "error",
            message: MESSAGE.consoleUnavailable,
            source: PreviewConsoleSource.Observation,
          },
        ];
  }

  /** A line the studio itself puts on the game's console — a build that failed before the page could load. */
  note(level: string, message: string, options: { loadError?: boolean } = {}): void {
    this.#push({ at: Date.now(), level, message });
    if (options.loadError) this.#loadError = message;
  }

  status(): PreviewStatus {
    return {
      project: this.#project,
      url: this.#view?.webContents.getURL() ?? null,
      crashed: this.#crashed,
      gone: this.#gone,
      unresponsive: this.#unresponsive,
      loadError: this.#loadError,
      consoleErrors: this.#consoleAvailable ? this.#console.filter((entry) => entry.level === "error").length : null,
      consoleAvailable: this.#consoleAvailable,
    };
  }

  #push(entry: PreviewConsoleEntry): void {
    this.#console.push(entry);
    const limit = this.options.consoleLimit ?? 500;
    if (this.#console.length > limit) this.#console.splice(0, this.#console.length - limit);
  }

  async destroy(): Promise<void> {
    void this.#profiler.invalidate("preview disposed");
    this.#closed = true;
    this.#view?.webContents.close();
    this.#view = null;
    const retired = this.#session;
    this.#session = null;
    if (retired) {
      retired.protocol.unhandle(SCHEME);
      retired.protocol.unhandle("http");
      retired.webRequest.onBeforeRequest(null);
      retired.setPermissionRequestHandler(null);
      retired.setPermissionCheckHandler(null);
      await retired.clearStorageData();
      await retired.clearCache();
    }
  }

  /**
   * Pooled headless ports get their teardown injected by whoever made the hosting window
   * (PreviewPort.dispose). The visible view never sets one — the pool refuses to dispose "live".
   */
  dispose?: () => Promise<void> | void;

  /**
   * Pooled headless ports get their resize injected the same way (PreviewPort.setViewSize): the
   * hosting window and this view at one size, or null for the size the window opened at.
   */
  setViewSize?: (size: { width: number; height: number } | null) => void;

  get sessionRef(): Session | null {
    return this.#session;
  }
}

/** `image` (of `size`) scaled down so its long side is at most `maxPx`; never scaled up. */
function scaledTo(image: NativeImage, size: { width: number; height: number }, maxPx: number): NativeImage {
  const scale = Math.min(1, maxPx / Math.max(size.width, size.height));
  if (scale >= 1) return image;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good",
  });
}

/** A still's exposure, measured on a downscale of it (`exposureStats`). */
function stillExposure(image: NativeImage, size: { width: number; height: number }) {
  const small = scaledTo(image, size, STILL_STATS_MAX_PX);
  const measured = small.getSize();
  return exposureStats(small.toBitmap(), measured.width, measured.height);
}

/** Wait `ms`; a negative wait is none. */
function sleep(ms: number): Promise<void> {
  return delay(Math.max(0, ms));
}

/** Two served paths naming the same file — `dist/index.html`, `/dist/index.html`, `./dist/index.html`. */
function samePath(a: string, b: string): boolean {
  const clean = (value: string) =>
    String(value ?? "")
      .replace(/^[./]+/, "")
      .replace(/\/+/g, "/");
  return clean(a) === clean(b);
}
