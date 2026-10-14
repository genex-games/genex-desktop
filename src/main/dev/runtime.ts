import type { PerformanceRecorder, watchEventLoop } from "../performance.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { applyGraphFixture } from "./fixture-graph-control.ts";
import { measureWindowResize } from "./window-resize.ts";
import { UiEvent } from "../../shared/ui-events.ts";
/**
 * The developer control's runtime inside a developer launch: a Unix socket that takes one
 * request line per connection from `scripts/studio-dev`, checks its instance and capability,
 * performs the operation against the studio window or the game view, and answers one line.
 */
import { app, type BrowserWindow, type WebContents, type WebContentsView } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  buildInputs,
  sourceIdentity,
  filesBelow,
  fingerprints,
  digest,
  safeChild,
  writeJson,
} from "../../../scripts/studio-dev/files.mjs";
import { DesktopControl } from "./control.ts";
import { listRuns } from "./runs.ts";
import { Diagnostics } from "./diagnostics.ts";
import {
  DEV_PROTOCOL_VERSION,
  DevError,
  DevErrorCode,
  type DevFailure,
  DevLogSurface,
  DevMethod,
  DevReadiness,
  type DevResponse,
  DevSurface,
  devRefusal,
  envelopeSchema,
  MAX_REQUEST_BYTES,
  NativeCaptureFrame,
  type Operation,
  operationSchema,
} from "./protocol.ts";
import type { LaunchContext } from "./launch-context.ts";
import { DevProviders, FIXTURE_VERSION } from "./fixture-kit.ts";
import type { StudioCore } from "../studio-core.ts";
import type { GamePreview } from "../preview.ts";
import type { NativeGamePort } from "../../substrate/native-game-port.ts";
import { errorMessage } from "../../shared/errors.ts";
import { secretRedactor } from "../../shared/redact.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { HarnessState } from "../../shared/protocol.ts";
import { NativeOp } from "../../shared/native-contract.ts";
import type { RenderSettingsChange } from "../../shared/render-quality.ts";

/** Why the developer runtime cannot start, or cannot reach a native run. */
const MESSAGE = {
  socketPathTooLong: "temporary IPC path too long",
  nativeUnsupported: (method: string) => `${method} has no native counterpart: a native game has no web contents`,
  noOpenGame: "open a C++ game in the studio first",
  noNativeRun: "start the open game first (Play, or an agent's run)",
  nativeViewHidden: "show the game's Native view in Live to capture what it shows",
  frameNotNative: "--frame names a native capture's frame; use it with --surface native",
} as const;
/** JPEG quality of a native surface capture. */
const NATIVE_CAPTURE_QUALITY = 90;

/** The studio-dev record format (`ready.json`, `controller.json`, …); `readVersion` checks it. */
const RECORD_VERSION = 1;
/** A socket path longer than this does not fit macOS's `sockaddr_un`. */
const MAX_SOCKET_PATH_BYTES = 102;
/** `stop` tears down after this, so its own reply leaves first. */
const STOP_REPLY_GRACE_MS = 100;
/** An idle client connection is dropped after this. */
const CLIENT_IDLE_MS = 35 * SECOND_MS;
/** An operation answers `timeout` after this; it may still finish. */
const OPERATION_TIMEOUT_MS = 30 * SECOND_MS;
/** Let pushed fixture events reach the renderer before the second counter snapshot. */
const FIXTURE_PUBLISH_SETTLE_MS = SECOND_MS;
/** The most bytes of log text or entries one `logs` answer carries. */
const LOG_BUDGET_BYTES = 64 * 1024;
/** The most entries a log source is read for; a list this long may have been cut at the source. */
const LOG_SOURCE_LIMIT = 200;
/** How long `runs` waits for the window to name its chat before listing without it. */
const SELECTION_WAIT_MS = 2 * SECOND_MS;
/** What ends a request line. */
const NEWLINE = 0x0a;

/** Every string of a value, redacted, as plain JSON: what the dev control hands another agent. */
export const sanitizer =
  (redact: (text: string) => string) =>
  (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "string" ? redact(v) : v)));

/** What main hands the runtime. */
interface RuntimeParts {
  ctx: LaunchContext;
  core: StudioCore;
  win: BrowserWindow;
  preview: GamePreview;
  logs: () => unknown[];
  harnessLogs: () => unknown[];
  authVisible: () => boolean;
  shutdown: () => Promise<void>;
  readonly performance?: () => Readonly<
    ReturnType<PerformanceRecorder["snapshot"]> & {
      platform: NodeJS.Platform;
      arch: string;
      isPackaged: boolean;
      react: string;
      loop?: ReturnType<ReturnType<typeof watchEventLoop>["snapshot"]>;
    }
  >;
}

/** One running control: its parts, its socket and what it has seen. */
interface Runtime extends RuntimeParts {
  sanitize: (value: unknown) => unknown;
  /** The studio window's Native view as composited (a `--surface native --frame live` capture). */
  liveNativeView(): Promise<LiveNativeView | null>;
  /** This instance's evidence folder. */
  root: string;
  /** The private folder the socket lives in. */
  transport: string;
  socket: string;
  capability: string;
  control: DesktopControl;
  diagnostics: Diagnostics;
  sockets: Set<net.Socket>;
  server: net.Server | null;
  busy: boolean;
  lastFailure: unknown;
  stopping: boolean;
}

export async function startRuntime(
  ctx: LaunchContext,
  core: StudioCore,
  win: BrowserWindow,
  preview: GamePreview,
  logs: () => unknown[],
  harnessLogs: () => unknown[],
  authVisible: () => boolean,
  shutdown: () => Promise<void>,
  performance?: RuntimeParts["performance"],
) {
  const rt = await openRuntime({ ctx, core, win, preview, logs, harnessLogs, authVisible, shutdown, performance });
  const server = net.createServer((client) => serveClient(rt, client));
  rt.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(rt.socket, () => resolve());
  });
  await fsp.chmod(rt.socket, 0o600);
  await publishIdentity(rt);
  return { status: () => status(rt), stop: () => stop(rt) };
}

async function openRuntime(parts: RuntimeParts): Promise<Runtime> {
  // The credentials Studio holds (its environment's tokens, unlocked connector, OAuth and plugin
  // account values) by value, then anything token-shaped: the same redactor the event log uses.
  const sanitize = sanitizer(secretRedactor(() => parts.core.knownSecretValues()));
  const root = safeChild(parts.ctx.checkout, `.studio-dev/evidence/${parts.ctx.instanceId}`);
  await fsp.mkdir(root, { mode: 0o700 });
  const transport = await fsp.mkdtemp(path.join(os.tmpdir(), "ags-"));
  await fsp.chmod(transport, 0o700);
  const socket = path.join(transport, "s");
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) throw new Error(MESSAGE.socketPathTooLong);
  const control = new DesktopControl();
  return {
    ...parts,
    sanitize,
    liveNativeView: () => liveNativeViewOf(parts.win),
    root,
    transport,
    socket,
    capability: randomBytes(32).toString("hex"),
    control,
    diagnostics: new Diagnostics(root, control),
    sockets: new Set(),
    server: null,
    busy: false,
    lastFailure: null,
    stopping: false,
  };
}

/** `ready.json` in the evidence folder, and the socket and capability the CLI connects with. */
async function publishIdentity(rt: Runtime): Promise<void> {
  const { ctx } = rt;
  const publicIdentity = await status(rt);
  writeJson(path.join(rt.root, "ready.json"), publicIdentity);
  writeJson(safeChild(ctx.root, "controller.json"), {
    version: RECORD_VERSION,
    instanceId: ctx.instanceId,
    profileId: ctx.profileId,
    ownerId: ctx.ownerId,
    pid: process.pid,
    startedAt: ctx.startedAt,
    socket: rt.socket,
    capability: rt.capability,
  });
}

/** The webContents a surface names: the studio window, or the game view once a game is loaded. */
function surfaceContents(rt: Runtime, surface: DevSurface): WebContents {
  if (surface === DevSurface.Native)
    throw new DevError(DevErrorCode.UnsupportedSurface, MESSAGE.nativeUnsupported(surface));
  if (surface === DevSurface.Desktop) {
    if (rt.win.isDestroyed()) throw new DevError(DevErrorCode.UnsupportedSurface, "desktop window closed");
    return rt.win.webContents;
  }
  const view = loadedGameView(rt.preview);
  if (!view) throw new DevError(DevErrorCode.MissingPrerequisite, "load a game in Live first");
  return view.webContents;
}

function loadedGameView(preview: GamePreview): WebContentsView | null {
  if (!preview.status().project) return null;
  const view = preview.view;
  if (!view || view.webContents.isDestroyed()) return null;
  return view;
}

async function status(rt: Runtime) {
  const { ctx, core, win } = rt;
  const manifest = ctx.manifest;
  const now = sourceIdentity(ctx.checkout);
  return {
    version: RECORD_VERSION,
    instanceId: ctx.instanceId,
    profileId: ctx.profileId,
    buildId: manifest.buildId,
    pid: process.pid,
    startedAt: ctx.startedAt,
    electron: process.versions.electron,
    checkout: ctx.checkout,
    sha: manifest.sha,
    branch: manifest.branch,
    dirty: manifest.dirty,
    sourceDigest: manifest.sourceDigest,
    currentSourceDigest: now.sourceDigest,
    outputDigest: manifest.outputDigest,
    resourcesDigest: manifest.resourcesDigest,
    dependencies: manifest.dependencies,
    stale: buildIsStale(ctx, now),
    roots: {
      electron: app.getPath("userData"),
      session: app.getPath("sessionData"),
      core: ctx.core,
      games: ctx.games,
    },
    providers: ctx.providers,
    fixture: ctx.fixture,
    fixtureVersion: ctx.providers === DevProviders.Fixture ? FIXTURE_VERSION : null,
    readiness: isReady(rt) ? DevReadiness.Ready : DevReadiness.NotReady,
    harness: harnessIdentity(core.layout.harnessWs, ctx.buildRoot),
    selection: await selection(rt),
    window: {
      title: win.isDestroyed() ? null : win.getTitle(),
      visible: !win.isDestroyed() && win.isVisible(),
      focused: !win.isDestroyed() && win.isFocused(),
      backgroundThrottling: win.isDestroyed() ? null : win.webContents.getBackgroundThrottling(),
    },
    lastFailure: rt.lastFailure,
    evidenceRoot: rt.root,
    performance: rt.performance?.(),
  };
}

/** Has the source, a dependency or the built output changed since this build was published? */
function buildIsStale(
  ctx: LaunchContext,
  now: Pick<ReturnType<typeof sourceIdentity>, "sourceDigest" | "dependencies">,
): boolean {
  const manifest = ctx.manifest;
  const currentOutput = digest(
    fingerprints(
      ctx.buildRoot,
      filesBelow(ctx.buildRoot).filter((f: string) => f !== "build.json"),
    ),
  );
  const sourceChanged = now.sourceDigest !== manifest.sourceDigest;
  const dependenciesChanged =
    JSON.stringify({ ...now.dependencies, node: null }) !== JSON.stringify({ ...manifest.dependencies, node: null });
  return sourceChanged || dependenciesChanged || currentOutput !== manifest.outputDigest;
}

function isReady(rt: Runtime): boolean {
  if (rt.stopping || rt.win.isDestroyed()) return false;
  return rt.core.host.state === HarnessState.Ready;
}

/** The shipped harness seed against the harness the agent runs, and the harness's git state. */
function harnessIdentity(harnessWs: string, buildRoot: string) {
  const seedDir = path.join(buildRoot, "resources/harness-seed");
  const seed = fingerprints(seedDir, filesBelow(seedDir));
  const runtime = fingerprints(harnessWs, filesBelow(harnessWs));
  const divergent = [...new Set([...Object.keys(seed), ...Object.keys(runtime)])].filter((f) => seed[f] !== runtime[f]);
  return {
    shippedDigest: digest(seed),
    runtimeDigest: digest(runtime),
    sha: harnessGit(harnessWs, "rev-parse", "HEAD"),
    dirty: !!harnessGit(harnessWs, "status", "--porcelain"),
    divergentPaths: divergent,
  };
}

function harnessGit(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** What the studio window has selected: its state and stage datasets. */
async function selection(rt: Runtime) {
  if (rt.win.isDestroyed()) return null;
  const s = await rt.control.inspect(rt.win.webContents, { snapshot: true, limit: 1 });
  return { ...s.state, ...s.stage };
}

/** Whether an operation names the native surface: a C++ game's own run instead of a web contents. */
export function asksNative(op: Operation): boolean {
  const params: object = op.params;
  return "surface" in params && params.surface === DevSurface.Native;
}

/** Native-surface operations: what each does to the run's port. */
const NATIVE_METHODS: ReadonlySet<DevMethod> = new Set([
  DevMethod.GameState,
  DevMethod.GameRenderSettings,
  DevMethod.GameInput,
  DevMethod.Capture,
  DevMethod.Logs,
]);

/** Refuses `UnsupportedSurface` for a native-surface operation with no native counterpart (a profile, a heap, keys, scrolls). */
export function refuseNativeOperation(op: Operation): void {
  if (asksNative(op) && !NATIVE_METHODS.has(op.method))
    throw new DevError(DevErrorCode.UnsupportedSurface, MESSAGE.nativeUnsupported(op.method));
}

/** What a native operation does to a run's port. */
export type NativeSurfacePort = Pick<
  NativeGamePort,
  "studioState" | "input" | "screenshotWithStats" | "consoleEntries"
> & {
  /** The run's `renderSettings` op (a read without `set`). */
  call(op: typeof NativeOp.RenderSettings, arg: { set?: RenderSettingsChange }): Promise<unknown>;
};

/** What a `--surface native` operation reaches: the open game, the registry's ports, the evidence folder and the redactor. */
export interface NativeSurfaceRuntime {
  /** The studio window's Native view as composited (what the person sees), or null when it is not shown. */
  liveNativeView(): Promise<LiveNativeView | null>;
  preview: { status(): { project: string | null } };
  core: {
    runPreviewIdentity(): { project: string | null };
    nativeRuns: { portOf(project: string): NativeSurfacePort | null };
  };
  diagnostics: { destination(name: string): Promise<string> };
  sanitize(value: unknown): unknown;
}

/** The open game's native run: its Play window, else its newest agent run. */
function nativePortOf(rt: NativeSurfaceRuntime): NativeSurfacePort {
  const project = rt.preview.status().project ?? rt.core.runPreviewIdentity().project;
  if (!project) throw new DevError(DevErrorCode.MissingPrerequisite, MESSAGE.noOpenGame);
  const port = rt.core.nativeRuns.portOf(project);
  if (!port) throw new DevError(DevErrorCode.MissingPrerequisite, MESSAGE.noNativeRun);
  return port;
}

/** An operation on the native surface: the run's state, input, a capture or its console. */
export async function performNative(rt: NativeSurfaceRuntime, op: Operation) {
  refuseNativeOperation(op);
  const port = nativePortOf(rt);
  switch (op.method) {
    case DevMethod.GameState:
      return port.studioState();
    case DevMethod.GameRenderSettings:
      return port.call(NativeOp.RenderSettings, op.params.set ? { set: op.params.set } : {});
    case DevMethod.GameInput:
      return port.input(op.params.actions);
    case DevMethod.Capture:
      return captureNative(rt, port, op.params);
    case DevMethod.Logs:
      return nativeLogs(rt, port, op.params);
    default:
      throw new DevError(DevErrorCode.UnsupportedSurface, MESSAGE.nativeUnsupported(op.method));
  }
}

/** The Native view's pixels as the studio window composited them. */
export interface LiveNativeView {
  png: Buffer;
  dimensions: { width: number; height: number };
}

type NativeCaptureParams = Extract<Operation, { method: typeof DevMethod.Capture }>["params"];

/**
 * A capture of the native run, saved beside the other captures. `pinned` (the default) is the run's
 * own capture op, a JPEG of the pinned capture profile; `live` is the studio window's Native view,
 * the frame the person sees with their preset and panel applied (a PNG).
 */
async function captureNative(rt: NativeSurfaceRuntime, port: NativeSurfacePort, params: NativeCaptureParams) {
  if (params.frame === NativeCaptureFrame.Live) return captureLiveNative(rt, params.name);
  const shot = await port.screenshotWithStats(NATIVE_CAPTURE_QUALITY);
  const file = await rt.diagnostics.destination(`${DevSurface.Native}-${params.name}.jpg`);
  await fsp.writeFile(file, shot.jpeg, { flag: "wx", mode: 0o600 });
  return {
    file,
    surface: DevSurface.Native,
    frame: NativeCaptureFrame.Pinned,
    dimensions: { width: shot.stats.width, height: shot.stats.height },
    capturedAt: new Date().toISOString(),
  };
}

async function captureLiveNative(rt: NativeSurfaceRuntime, name: string) {
  const view = await rt.liveNativeView();
  if (!view) throw new DevError(DevErrorCode.MissingPrerequisite, MESSAGE.nativeViewHidden);
  const file = await rt.diagnostics.destination(`${DevSurface.Native}-${name}.png`);
  await fsp.writeFile(file, view.png, { flag: "wx", mode: 0o600 });
  return {
    file,
    surface: DevSurface.Native,
    frame: NativeCaptureFrame.Live,
    dimensions: view.dimensions,
    capturedAt: new Date().toISOString(),
  };
}

/** The selector of Live's Native view canvas (`NativeLiveCanvas`), whose box a live capture crops to. */
const NATIVE_CANVAS_SELECTOR = "[data-stage-native-canvas] canvas";

/** The studio window cropped to the Native view's canvas, or null when no Native view is shown. */
async function liveNativeViewOf(win: BrowserWindow): Promise<LiveNativeView | null> {
  if (win.isDestroyed()) return null;
  const box: unknown = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(NATIVE_CANVAS_SELECTOR)})?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; })()`,
  );
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n)))
    return null;
  const [x, y, width, height] = box.map((n: number) => Math.round(n));
  if (width <= 0 || height <= 0) return null;
  const image = await win.webContents.capturePage({ x, y, width, height }, { stayHidden: true, stayAwake: true });
  if (image.isEmpty()) return null;
  return { png: image.toPNG(), dimensions: image.getSize() };
}

/** The native run's console (its stderr and fatal events), in the logs answer's shape and budget. */
function nativeLogs(rt: NativeSurfaceRuntime, port: NativeSurfacePort, params: LogsParams) {
  return { surface: DevSurface.Native, ...logPage(rt.sanitize, port.consoleEntries(), params) };
}

async function perform(rt: Runtime, op: Operation) {
  if (op.method === DevMethod.Status) return status(rt);
  if (op.method === DevMethod.Stop) return requestStop(rt);
  if (op.method === DevMethod.Runs) return listRuns(rt.core.store, { activeThread: await activeThread(rt) });
  assertActionable(rt, op);
  if (asksNative(op)) return performNative(rt, op);
  const { diagnostics } = rt;
  switch (op.method) {
    case DevMethod.FixtureGraph:
      return fixtureGraph(rt, op.params.action);
    case DevMethod.GameState:
      surfaceContents(rt, DevSurface.Game);
      return rt.preview.studioState();
    case DevMethod.GameRenderSettings:
      surfaceContents(rt, DevSurface.Game);
      return rt.preview.studioCall(NativeOp.RenderSettings, op.params.set ? { set: op.params.set } : {});
    case DevMethod.GameInput:
      surfaceContents(rt, DevSurface.Game);
      return rt.preview.input(op.params.actions);
    case DevMethod.WindowResize:
      return resizeWindow(rt, op.params);
    case DevMethod.Capture:
      return captureSurface(rt, op.params);
    case DevMethod.Logs:
      return readLogs(rt, op.params);
    case DevMethod.CpuStart:
      return diagnostics.cpuStart(surfaceContents(rt, op.params.surface), op.params.profileId);
    case DevMethod.CpuStop:
      return diagnostics.cpuStop(surfaceContents(rt, op.params.surface), op.params.profileId, op.params.surface);
    case DevMethod.MainCpuStart:
      return diagnostics.mainCpuStart(op.params.profileId);
    case DevMethod.MainCpuStop:
      return diagnostics.mainCpuStop(op.params.profileId);
    case DevMethod.Heap:
      return diagnostics.heap(surfaceContents(rt, op.params.surface), op.params.name, op.params.surface);
    case DevMethod.TraceStart:
      return diagnostics.traceStart(op.params.traceId, op.params.durationMs, op.params.categories);
    case DevMethod.TraceStop:
      return diagnostics.traceStop(op.params.traceId);
    default: {
      const surface = "surface" in op.params ? op.params.surface : DevSurface.Desktop;
      return rt.control.action(surfaceContents(rt, surface), op);
    }
  }
}

/** Refuse to act on a harness that is not ready, under a sign-in sheet, or on a stale build. */
function assertActionable(rt: Runtime, op: Operation): void {
  const refused = devRefusal(op.method, {
    ready: rt.core.host.state === HarnessState.Ready,
    authVisible: rt.authVisible(),
    stale: () => buildIsStale(rt.ctx, buildInputs(rt.ctx.checkout)),
  });
  if (refused) throw refused;
}

/** The chat the studio window shows, as its state dataset names it; null when the window cannot say. */
async function activeThread(rt: Runtime): Promise<string | null> {
  // A window that does not answer (a renderer reloading after a crash) must not cost the run list.
  const shown = await Promise.race([selection(rt).catch(() => null), sleep(SELECTION_WAIT_MS).then(() => null)]);
  return typeof shown?.activeThread === "string" ? shown.activeThread : null;
}

function requestStop(rt: Runtime) {
  rt.stopping = true;
  setTimeout(
    () =>
      void stop(rt).catch((e) => {
        rt.lastFailure = String(e);
        writeJson(path.join(rt.ctx.root, "failure.json"), { version: RECORD_VERSION, error: String(e) });
      }),
    STOP_REPLY_GRACE_MS,
  );
  return { stopping: true, interruptedOwnWork: rt.core.budget.userInFlight > 0 };
}

type CaptureParams = Extract<Operation, { method: typeof DevMethod.Capture }>["params"];

async function captureSurface(rt: Runtime, params: CaptureParams) {
  if (params.frame !== undefined) throw new DevError(DevErrorCode.InvalidRequest, MESSAGE.frameNotNative);
  if (params.surface === DevSurface.Game && !gameViewShown(rt.preview))
    throw new DevError(DevErrorCode.MissingPrerequisite, "select Live to capture the current game surface");
  const target = surfaceContents(rt, params.surface);
  const file = await rt.diagnostics.destination(`${params.surface}-${params.name}.png`);
  const image = await target.capturePage(undefined, { stayHidden: true, stayAwake: true });
  if (image.isEmpty()) throw new DevError(DevErrorCode.MissingPrerequisite, "selected surface has no compositor frame");
  await fsp.writeFile(file, image.toPNG(), { flag: "wx", mode: 0o600 });
  return {
    file,
    surface: params.surface,
    dimensions: image.getSize(),
    scale: image.getSize().width / surfaceWidth(rt, params.surface),
    zoom: target.getZoomFactor(),
    visible: rt.win.isVisible(),
    focused: rt.win.isFocused(),
    capturedAt: new Date().toISOString(),
  };
}

type WindowResizeParams = Extract<Operation, { method: typeof DevMethod.WindowResize }>["params"];
/** Measure how Live's view follows a stepped resize of the studio window; Live must show a game. */
function resizeWindow(rt: Runtime, params: WindowResizeParams) {
  const view = rt.preview.view;
  if (!view || !gameViewShown(rt.preview))
    throw new DevError(DevErrorCode.UnsupportedSurface, "window.resize needs a game shown in Live");
  return measureWindowResize(rt.win, view, params);
}

/** Is the game view on screen with an area to capture? */
function gameViewShown(preview: GamePreview): boolean {
  const bounds = preview.view?.getBounds();
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

function surfaceWidth(rt: Runtime, surface: DevSurface): number {
  if (surface === DevSurface.Desktop) return rt.win.getContentBounds().width;
  return rt.preview.view?.getBounds().width ?? 0;
}

type LogsParams = Extract<Operation, { method: typeof DevMethod.Logs }>["params"];

async function readLogs(rt: Runtime, params: LogsParams) {
  if (params.surface === DevLogSurface.Stdout || params.surface === DevLogSurface.Stderr)
    return readLaunchStream(rt, params.surface);
  const all = await logEntries(rt, params.surface);
  const page = logPage(rt.sanitize, all, params);
  // A source read to its limit may have been cut where it was read.
  return { surface: params.surface, ...page, truncated: page.truncated || all.length >= LOG_SOURCE_LIMIT };
}

/**
 * One page of log entries from `cursor`, redacted, within `LOG_BUDGET_BYTES`: an entry past the
 * budget is named (its size), not sent. `truncated` when entries follow or one was left out.
 */
function logPage(sanitize: (value: unknown) => unknown, all: readonly unknown[], params: LogsParams) {
  const end = params.cursor + params.limit;
  const entries: unknown[] = [];
  let bytes = 0;
  let truncated = all.length > end;
  for (const entry of all.slice(params.cursor, end)) {
    const clean = sanitize(entry);
    const size = Buffer.byteLength(JSON.stringify(clean));
    if (bytes + size > LOG_BUDGET_BYTES) {
      entries.push({ omitted: true, bytes: size, reason: "bounded log budget" });
      truncated = true;
      continue;
    }
    entries.push(clean);
    bytes += size;
  }
  return { entries, nextCursor: Math.min(all.length, end), truncated };
}

async function logEntries(rt: Runtime, surface: DevLogSurface): Promise<unknown[]> {
  if (surface === DevLogSurface.Desktop) return rt.logs();
  if (surface === DevLogSurface.Game) return rt.preview.consoleEntries();
  if (surface === DevLogSurface.Harness) return rt.harnessLogs();
  return rt.core.listAllEvents(undefined, LOG_SOURCE_LIMIT);
}

/** The tail of this launch's own stdout or stderr, redacted. */
async function readLaunchStream(rt: Runtime, surface: typeof DevLogSurface.Stdout | typeof DevLogSurface.Stderr) {
  const { ctx } = rt;
  const file = safeChild(ctx.checkout, `.studio-dev/evidence/launch-${ctx.manifest.buildId}/${surface}.log`);
  const handle = await fsp.open(file, "r");
  try {
    const bytes = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(bytes, LOG_BUDGET_BYTES));
    await handle.read(buffer, 0, buffer.length, Math.max(0, bytes - buffer.length));
    return {
      surface,
      text: rt.sanitize(buffer.toString()),
      truncated: bytes > buffer.length,
      bytes,
    };
  } finally {
    await handle.close();
  }
}

/** One connection: read one request line, answer it once, ignore anything after. */
function serveClient(rt: Runtime, client: net.Socket): void {
  rt.sockets.add(client);
  client.once("close", () => rt.sockets.delete(client));
  client.setTimeout(CLIENT_IDLE_MS, () => client.destroy());
  let buffer = Buffer.alloc(0);
  let used = false;
  client.on("data", (chunk) => {
    if (used) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_REQUEST_BYTES) {
      used = true;
      const tooLarge: DevResponse = {
        version: DEV_PROTOCOL_VERSION,
        requestId: "invalid",
        ok: false,
        error: { code: DevErrorCode.InvalidRequest, message: "request too large" },
      };
      client.end(`${JSON.stringify(tooLarge)}\n`);
      return;
    }
    const newline = buffer.indexOf(NEWLINE);
    if (newline < 0) return;
    used = true;
    void answer(rt, client, buffer.subarray(0, newline).toString());
  });
}

/** What one request has got so far: its id once parsed, and whether it was already answered. */
interface Exchange {
  requestId: string;
  replied: boolean;
}

async function answer(rt: Runtime, client: net.Socket, line: string): Promise<void> {
  const exchange: Exchange = { requestId: "invalid", replied: false };
  const reply = (r: DevResponse) => {
    if (!client.destroyed) client.end(`${JSON.stringify(r)}\n`);
  };
  let timer: NodeJS.Timeout | undefined;
  let ownedBusy = false;
  try {
    const op = admit(rt, line, exchange);
    if (rt.busy) throw new DevError(DevErrorCode.Busy, "an operation is still executing");
    rt.busy = true;
    ownedBusy = true;
    timer = setTimeout(() => {
      exchange.replied = true;
      const error = { code: DevErrorCode.Timeout, message: "operation timed out; inspect status before retrying" };
      reply({ version: DEV_PROTOCOL_VERSION, requestId: exchange.requestId, ok: false, error });
    }, OPERATION_TIMEOUT_MS);
    const value = await perform(rt, op);
    if (!exchange.replied)
      reply({ version: DEV_PROTOCOL_VERSION, requestId: exchange.requestId, ok: true, value: rt.sanitize(value) });
  } catch (e) {
    const failure: DevFailure & { at: string } = {
      at: new Date().toISOString(),
      code: e instanceof DevError ? e.code : DevErrorCode.InvalidRequest,
      message: errorMessage(e),
    };
    rt.lastFailure = failure;
    if (!exchange.replied)
      reply({ version: DEV_PROTOCOL_VERSION, requestId: exchange.requestId, ok: false, error: failure });
  } finally {
    if (timer) clearTimeout(timer);
    if (ownedBusy) rt.busy = false;
  }
}

/** The operation a request line asks for, once its instance and capability check out. */
function admit(rt: Runtime, line: string, exchange: Exchange): Operation {
  const envelope = envelopeSchema.parse(JSON.parse(line));
  exchange.requestId = envelope.requestId;
  if (envelope.instanceId !== rt.ctx.instanceId) throw new DevError(DevErrorCode.WrongInstance);
  if (!sameCapability(envelope.capability, rt.capability))
    throw new DevError(DevErrorCode.WrongInstance, "invalid capability");
  return operationSchema.parse({ method: envelope.method, params: envelope.params });
}

function sameCapability(offered: string, held: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(held);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function stop(rt: Runtime): Promise<void> {
  rt.stopping = true;
  await rt.diagnostics.stop();
  await rt.shutdown();
  writeJson(path.join(rt.root, "stopped.json"), {
    version: RECORD_VERSION,
    instanceId: rt.ctx.instanceId,
    stoppedAt: new Date().toISOString(),
  });
  for (const client of rt.sockets) client.destroy();
  const server = rt.server;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(rt.transport, { recursive: true, force: true });
  // The CLI removes the lease only after observing actual process exit.
  app.exit(0);
}

/** Fixed graph stimuli are fixture-only; snapshots are the existing DOM inspector's counters. */
async function fixtureGraph(
  rt: Runtime,
  action: Extract<Operation, { method: typeof DevMethod.FixtureGraph }>["params"]["action"],
) {
  const wc = surfaceContents(rt, DevSurface.Desktop);
  const sample = async () => (await rt.control.inspect(wc, { performanceOnly: true })).performance;
  const before = await sample();
  const result = await applyGraphFixture(rt.ctx, action, {
    thread: () => rt.core.threadForGame("fixture-game"),
    events: (thread) => rt.core.store.listEvents(thread),
    append: (events, thread) => rt.core.append(events, thread),
    frame: (frame) => rt.core.emit(UiEvent.PreviewFrame, frame),
    close: (frame) => rt.core.emit(UiEvent.PreviewScreen, { ...frame, state: "closed" }),
    changed: () => rt.core.emit(UiEvent.GameChanged, { project: "fixture-game" }),
  });
  await sleep(FIXTURE_PUBLISH_SETTLE_MS);
  return { ...result, rendererPid: wc.getOSProcessId(), before, after: await sample() };
}
