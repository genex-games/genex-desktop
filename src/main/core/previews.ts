/**
 * The core's previews: the pool of observation ports, what each handle serves (and rebuilds), the
 * captures and computer sessions agents look through, the agent screens on the stage, and a run's
 * builds played or landed. Composed by `StudioCore`; its state stays in the core.
 */
import {
  genexJobDir,
  isGenexInspectionFile,
  readContainedImage,
  readGenexCoverShot,
  readGenexJobs,
} from "../game-assets.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { ensureDir } from "../../substrate/fsx.ts";
import {
  TEMPLATE_SHAPE,
  isImageFile,
  nestedForLanding,
  versionNestedForLanding,
  type GameProject,
} from "../../substrate/game-workspace.ts";
import type { HarnessParams, HarnessResult } from "../../shared/harness-api.ts";
import { genexOutputFile, isGenexRef } from "../../shared/genex-ref.ts";
import { type ProjectAssetRead, ProjectAssetScope } from "../../shared/game-assets.ts";
import { resetToolchain } from "../../substrate/toolchain.ts";
import { buildFailureNote, servedAfterBuild } from "../game-build.ts";
import type { BuildProblem, InstallResult } from "../../shared/build-problem.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { claudeFolderChanges, git } from "../../substrate/snapshots.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import type { Revision } from "../../shared/optimization.ts";
import { capActions } from "../../substrate/preview-input.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import { LIVE_HANDLE, PreviewPool, STAND_IN_HANDLE } from "../../substrate/preview-pool.ts";
import { awaitReady, bootBudget, unlockGesture, type ReadyResult } from "../../substrate/preview-ready.ts";
import { COMPUTER_VIEW, setupReached, type PreviewSetup } from "../../substrate/computer-tool.ts";
import {
  type AgentScreen,
  type AgentScreenEvent,
  type AgentScreenFrame,
  type ScreenAct,
  ScreenDeed,
} from "../../shared/agent-screen.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { CAMERA_SETTLE_MS, DEFAULT_SHOT_QUALITY, DEFAULT_STILL_QUALITY, captureSurface, tookPage } from "./capture.ts";
import { PreviewIdentityState, type ServedRoot } from "./internals.ts";
import { iterationDir, safePathSegment } from "./run-shots.ts";
import { readyNote, servedKey, strayPage } from "./page-report.ts";
import type { SessionPort } from "./session-port.ts";
import { serial } from "./serial.ts";
import { isInside, samePath, toPosixRelative } from "../../substrate/paths.ts";
import { isEffectivelyBlack } from "../../substrate/pixel-stats.ts";
import { errorMessage } from "../../shared/errors.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { ReadyPhase, CaptureSurface, GameClock, GameFront } from "../../shared/preview-contract.ts";
import { StateShape, keepPathsOf } from "../../shared/studio-state-shape.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { LiveGate, type LiveOffer } from "./live-gate.ts";
import type { LiveBehindEvent } from "../../shared/live-behind.ts";
import type { GameSoundRequest } from "../../shared/game-sound.ts";
import { liveAudible, type LiveSound } from "../game-sound.ts";

/** The most cameras one capture photographs. */
const MAX_CAPTURE_CAMERAS = 8;
/** How many times a capture asks a registered camera to switch before it says the switch is dead. */
const CAMERA_SWITCH_ATTEMPTS = 3;
/** How many of the page's console errors a capture answer quotes. */
const CONSOLE_ERRORS_QUOTED = 3;
/** JPEG quality of a fresh frame for an agent's screen card. */
const FRAME_QUALITY = 60;
const FRAME_MIN_INTERVAL_MS = SECOND_MS;
type PendingFrame = {
  at: number;
  running: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  next?: () => Promise<void>;
};
/** One action's picture, if it took one, and what it did: the log's sentence and its code. */
interface FrameDeed {
  jpeg: Buffer | null;
  caption: string | null;
  act: ScreenAct | null;
}
/** An agent screen card's picture: its width in pixels and its JPEG quality. */
const CARD_WIDTH_PX = 640;
const CARD_QUALITY = 62;
/** How long a setup script may let the page settle, and how long it waits when it does not say. */
const SETUP_SETTLE_MAX_MS = 10_000;
const SETUP_SETTLE_DEFAULT_MS = 400;
/** After `__studio.begin()`, how often the window is asked whether the game is in play, and for how long (wall time: it runs). */
const PLAY_POLL_MS = 200;
const PLAY_WAIT_MS = 5 * SECOND_MS;
/** How much of the page's state a setup note quotes. */
const SETUP_STATE_EXCERPT_CHARS = 240;
/** The most reference stills one call returns, their long side, and the largest file read. */
const REFERENCE_MAX_STILLS = 12;
const REFERENCE_MAX_PX = 1024;
const STILL_MAX_PX = 4096;
const REFERENCE_MAX_MB = 16;
const REFERENCE_MAX_BYTES = REFERENCE_MAX_MB * 1024 * 1024;
/** How much of a merge's error a landing refusal quotes. */
const MERGE_ERROR_EXCERPT_CHARS = 200;
/** Windows a session never takes by name: the person's Live, and the stand-in every harness call shares. */
const SHARED_WINDOWS: ReadonlySet<string> = new Set([LIVE_HANDLE, STAND_IN_HANDLE]);
/** A commit the user may show or land: a hex hash, abbreviated or whole. */
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i;
/** Files under `references/` that are notes about the stills, never stills. */
const REFERENCE_NOTE = /\.(md|txt|json)$/i;
/** How long the stand-in stays open once the harness stops using it: a game in it keeps running. */
const STAND_IN_IDLE_MS = 2 * MINUTE_MS;

/** Errors the user reads when a build cannot be shown or landed, and why a reference is no still. */
const MESSAGE = {
  noPreview: "no preview is attached (headless mode)",
  benchRefused: (page: string, why: string) =>
    `capture did not load the bench page "${page}": ${why}. Nothing was loaded. A bench page is a .html file inside this workspace, such as bench/<part>.html.`,
  benchUnnamed: "no page was named",
  benchNotHtml: "it is not a .html page",
  benchOutside: "it is outside this workspace",
  benchMissing: "there is no such file",
  benchBuilt:
    "this game is served from its build output, not from this workspace, so a bench page cannot load; capture the game",
  benchCaptured: (entry: string, workspace: string) => `Captured the bench page ${entry} (workspace ${workspace}):`,
  benchAfter:
    "Read the image files above to actually look at them. The window shows the bench page now: the computer tool loads your game again on its next action. Capture the game itself before you finish.",
  profilingNeedsStage: "profiling requires a stage preview",
  previewChanged: "The selected preview changed while this build was preparing. Open the build again when ready.",
  noGameInSnapshot: "that snapshot has no game to play",
  sessionEnded: "the session ended before its window opened",
  viewportNeedsLease: "preview.viewport sizes one leased window: name its handle (never Live or the stand-in)",
  viewportInSession: (handle: string) =>
    `preview window ${handle} is a computer session's: its view stays the size the agent plays at`,
  notRunArtefact: (file: string) => `not a run artefact: ${file}`,
  notStill: (file: string) => `not a run artefact or a reference still: ${file}`,
  notCommitHash: (commit: string) => `"${commit}" is not a commit hash`,
  notInHistory: (commit: string, project: string) => `commit ${commit} is not in "${project}"'s history`,
  claudeFolder: (commit: string, files: string[]) =>
    `build ${commit} changes the game's .claude folder (${files.join(", ")}), Claude Code's own settings, so it was not landed`,
  contractorBuilding: (project: string) =>
    `a contractor is building in "${project}" right now — wait for it to finish before landing a build`,
  uncommittedEdits: (files: number) =>
    `the game folder has uncommitted edits (${files} file(s)) — commit or discard them before landing a build`,
  landingConflicted: (revision: string, excerpt: string) =>
    `landing ${revision} conflicted with the game folder; nothing was changed (${excerpt})`,
  noSuchGame: (project: string) => `there is no game called "${project}"`,
  stillUnreadable: "unreadable",
  stillTooLarge: `larger than ${REFERENCE_MAX_MB} MB`,
  stillNotJudgeable: (what: string) => `${what} — the reviewers cannot read it; re-save as JPEG or PNG`,
} as const;

/** A reference file that could not become a still, and why. */
interface SkippedStill {
  file: string;
  why: string;
}

/** The page's own report of the camera it rendered, or null when it says nothing. */
function renderedCamera(state: unknown): string | null {
  const camera = (state as { camera?: unknown } | null)?.camera;
  return typeof camera === "string" ? camera : null;
}

/** The only kind of page a bench capture loads. */
const BENCH_EXTENSION = ".html";

/**
 * A bench page a capture may load in place of the game, checked by its real path: an existing
 * `.html` file inside the workspace, never a link out of it. Answers the served entry relative to
 * the workspace, or the sentence that refuses it; a refused page is never loaded.
 */
async function benchEntry(root: string, page: string): Promise<{ entry: string } | { refusal: string }> {
  const refuse = (why: string) => ({ refusal: MESSAGE.benchRefused(page, why) });
  const named = page.trim();
  if (!named) return refuse(MESSAGE.benchUnnamed);
  if (path.extname(named).toLowerCase() !== BENCH_EXTENSION) return refuse(MESSAGE.benchNotHtml);
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot || path.isAbsolute(named) || !isInside(realRoot, path.resolve(realRoot, named)))
    return refuse(MESSAGE.benchOutside);
  const real = await realpath(path.resolve(realRoot, named)).catch(() => null);
  if (!real) return refuse(MESSAGE.benchMissing);
  if (!isInside(realRoot, real) || samePath(realRoot, real)) return refuse(MESSAGE.benchOutside);
  if (path.extname(real).toLowerCase() !== BENCH_EXTENSION) return refuse(MESSAGE.benchNotHtml);
  const file = await stat(real).catch(() => null);
  if (!file?.isFile()) return refuse(MESSAGE.benchMissing);
  return { entry: toPosixRelative(path.relative(realRoot, real)) };
}

/** Whose screen a capture's frames land on: the session's window, labelled for the worker. */
function captureScreen(
  sc: NonNullable<DelegateRequest["selfCapture"]>,
  session: SessionPort,
  role: AgentScreen["role"],
): AgentScreen {
  return {
    handle: session.handle() ?? LIVE_HANDLE,
    label: sc.label ?? sc.facetId ?? sc.project,
    project: sc.project,
    runId: sc.runId ?? null,
    facetId: sc.facetId ?? null,
    role,
  };
}

/**
 * The cameras one capture shoots. Unasked, a worker's capture shoots its own part's cameras (the
 * grant's), not every one the game registers; a bench page shoots its default view.
 */
function camerasForShot(
  sc: NonNullable<DelegateRequest["selfCapture"]>,
  bench: { entry: string } | null,
  asked: string | undefined,
  known: readonly string[],
): string[] {
  if (bench) return camerasToCapture(asked, []);
  // The grant comes from the agent-editable seed: anything but a list of names is no grant.
  const granted: unknown = sc.cameras;
  const own = Array.isArray(granted)
    ? granted.filter((camera): camera is string => typeof camera === "string" && camera !== "").join(",")
    : "";
  return camerasToCapture(asked ?? (own || undefined), known);
}

/** The capture tool's answer: what was shot, the console's errors, the load's note and what the window shows now. */
function captureAnswer({
  bench,
  root,
  lines,
  errors,
  setupNote,
}: {
  bench: { entry: string } | null;
  root: string;
  lines: readonly string[];
  errors: Parameters<typeof consoleErrorsLine>[0];
  setupNote: string | null;
}): string {
  const workspace = path.basename(root);
  return [
    bench ? MESSAGE.benchCaptured(bench.entry, workspace) : `Captured your CURRENT build (workspace ${workspace}):`,
    ...lines,
    consoleErrorsLine(errors),
    ...(setupNote ? [`note: ${setupNote}`] : []),
    bench
      ? MESSAGE.benchAfter
      : "Read the image files above to actually look at them. The window keeps running this build — the computer tool continues from here.",
  ].join("\n");
}

/** The cameras a capture photographs: the ones asked for, else the page's own, else `default`. */
function camerasToCapture(asked: string | undefined, known: readonly string[]): string[] {
  const named = (asked ?? "")
    .split(",")
    .map((camera) => camera.trim())
    .filter(Boolean);
  if (named.length) return named.slice(0, MAX_CAPTURE_CAMERAS);
  if (known.length) return known.slice(0, MAX_CAPTURE_CAMERAS);
  return ["default"];
}

/** The highest capture number already on disk in a facet's iteration folder. */
async function lastCaptureNumber(outDir: string): Promise<number> {
  let highest = 0;
  for (const name of await readdir(outDir).catch(() => [])) {
    const m = /^c(\d+)_/.exec(name);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest;
}

/** A capture answer's line for one camera's frame. */
function capturedLine(
  camera: string,
  file: string,
  shot: Awaited<ReturnType<typeof captureSurface>>,
  verified: boolean,
  warning: string,
): string {
  const { stats } = shot;
  const measured = stats
    ? ` (litFraction ${stats.litFraction.toFixed(2)}, meanLuma ${Math.round(stats.meanLuma)})`
    : "";
  return `- ${camera} → ${file}${measured}${tookPage(shot) ? " [page]" : ""}${verified ? " [camera verified]" : ""}${warning}`;
}

/** The capture answer's console line: the last few errors since the load, or none. */
function consoleErrorsLine(errors: ReadonlyArray<{ message: string }>): string {
  if (!errors.length) return "console errors since load: none";
  const quoted = errors
    .slice(-CONSOLE_ERRORS_QUOTED)
    .map((entry) => entry.message)
    .join(" | ");
  return `console errors since load (${errors.length}): ${quoted}`;
}

/** What a setup's `verify` expected, as its note names it. */
function expectedValue(verify: NonNullable<PreviewSetup["verify"]>): string {
  return "equals" in verify ? JSON.stringify(verify.equals) : "set";
}

/**
 * Point the page at a camera and read back the one it rendered. The capture proves which camera
 * it rendered: `state().camera` after the switch, retried up to three times — a frame from the
 * previous camera under this camera's name cost a builder its iteration.
 */
async function placeCamera(port: PreviewPort, camera: string, placeable: boolean): Promise<string | null> {
  let actual: string | null = null;
  const attempts = placeable ? CAMERA_SWITCH_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (placeable) await port.studioCall("debugCamera", camera).catch(() => null);
    await sleep(CAMERA_SETTLE_MS);
    actual = renderedCamera(await port.studioState().catch(() => null));
    const nothingToRetry = !placeable || actual === null || actual === camera;
    if (nothingToRetry) break;
  }
  return actual;
}

/** The address a load answers with when the build had nothing to serve. */
function unservedUrl(p: { project: string; entry?: string | undefined }): string {
  return `game://${p.project}/${p.entry ?? "index.html"}`;
}

/** A setup's demo, run; the note when the page refused it. */
async function runSetupDemo(port: PreviewPort, demo: string | undefined): Promise<string | null> {
  if (!demo) return null;
  const result = (await port
    .studioCall("demo", demo)
    .catch((err) => ({ ok: false, reason: String(errorMessage(err)) }))) as {
    ok?: boolean;
    reason?: string;
  } | null;
  const refused = result !== null && typeof result === "object" && result.ok === false;
  if (!refused) return null;
  return `setup demo "${demo}" did not run: ${result.reason ?? "unknown"}`;
}

/** Whether the state bounder left an elision stub on `path` or one of its parents: the value was not read. */
function elidedAlong(state: unknown, path: string): boolean {
  let current: unknown = state;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[key];
    const stub = current !== null && typeof current === "object" && !Array.isArray(current);
    if (stub && typeof (current as Record<string, unknown>)[StateShape.Elided] === "string") return true;
  }
  return false;
}

/**
 * The note for a setup whose `verify` the page's state does not meet, or null. The verified path
 * is kept whole when the state is over budget; one the bounder still cut is unmeasured, not missed.
 */
async function setupVerifyNote(port: PreviewPort, setup: PreviewSetup): Promise<string | null> {
  if (!setup.verify) return null;
  const keep = keepPathsOf([setup.verify.path]);
  const state = await port.studioState(keep.length ? { keep } : undefined).catch(() => null);
  if (elidedAlong(state, setup.verify.path)) return null;
  if (setupReached(setup.verify, state) !== false) return null;
  const value = JSON.stringify(state).slice(0, SETUP_STATE_EXCERPT_CHARS);
  return `REQUESTED STATE NOT REACHED: ${setup.verify.path} is not ${expectedValue(setup.verify)} after the setup script (${setup.note ?? "no note"}); state: ${value}`;
}

/** A setup's demo and input actions, then the settle it asked for; what went wrong goes on `notes`. */
async function replaySetup(
  port: PreviewPort,
  setup: PreviewSetup,
  notes: string[],
  wait: (ms: number) => Promise<unknown>,
): Promise<void> {
  const demoNote = await runSetupDemo(port, setup.demo);
  if (demoNote) notes.push(demoNote);
  if (Array.isArray(setup.actions) && setup.actions.length) {
    await port
      .input(capActions(setup.actions))
      .catch((err) => notes.push(`setup input failed: ${String(errorMessage(err))}`));
  }
  await wait(Math.min(SETUP_SETTLE_MAX_MS, setup.settleMs ?? SETUP_SETTLE_DEFAULT_MS));
}

/** `state().flow.playing`: true or false for a game that reports a front-end, null for one that does not. */
function flowPlaying(state: unknown): boolean | null {
  const flow = state !== null && typeof state === "object" ? (state as { flow?: unknown }).flow : null;
  const playing = flow !== null && typeof flow === "object" ? (flow as { playing?: unknown }).playing : null;
  return typeof playing === "boolean" ? playing : null;
}

/** Whether a setup replays anything a page must settle after: `{ begin: false }` alone replays nothing. */
function replaysSomething(setup: PreviewSetup): boolean {
  const acts = Array.isArray(setup.actions) && setup.actions.length > 0;
  return Boolean(setup.gesture || setup.demo || setup.verify || acts);
}

/**
 * Past the game's own title, menu and countdown into play, the way every judge sees it: only for a
 * game that says it is not in play (`state().flow.playing === false`), never when the setup keeps
 * the front-end (`begin: false`, the worker that builds it and the playtester). `begin()` leaves the
 * game paused, so the window is started again, before any setup is replayed. The note when play
 * was not reached, or null.
 */
async function beginPlay(
  port: PreviewPort,
  setup: PreviewSetup | null | undefined,
  wait: (ms: number) => Promise<unknown>,
): Promise<string | null> {
  if (setup?.begin === false) return null;
  if (flowPlaying(await port.studioState().catch(() => null)) !== false) return null;
  const began = (await port.studioCall(GameFront.Begin).catch(() => null)) as { ok?: unknown } | null;
  if (began?.ok !== true)
    return "this game shows a title, menu or countdown and has no __studio.begin(), so the frames show its front-end — give config.begin";
  await port.studioCall(GameClock.Start).catch(() => null);
  for (let waited = 0; waited < PLAY_WAIT_MS; waited += PLAY_POLL_MS) {
    if (flowPlaying(await port.studioState().catch(() => null)) === true) return null;
    await wait(PLAY_POLL_MS);
  }
  return `the game did not reach play within ${PLAY_WAIT_MS / SECOND_MS} s of __studio.begin() (state().flow.playing is still false)`;
}

/** A still resized to `maxPx` on its long side as JPEG, or null when the preview cannot. */
async function resizedStill(preview: PreviewPort | null, data: Buffer, maxPx: number): Promise<Buffer | null> {
  if (!preview?.resizeImage) return null;
  try {
    return await preview.resizeImage(data, maxPx, DEFAULT_STILL_QUALITY);
  } catch {
    return null;
  }
}

/** Whether two paths name one folder once links are resolved; false when either cannot be read. */
async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  return left !== null && right !== null && samePath(left, right);
}

function invalidStillSize(maxPx: number | undefined): boolean {
  return maxPx !== undefined && (!Number.isInteger(maxPx) || maxPx < 1 || maxPx > STILL_MAX_PX);
}

/**
 * What an agent-screen frame reads of a target: a picture, its size and the pointer. Every preview
 * port is one; a Play Protocol game's target is adapted to it (`computer-tools.ts`).
 */
export type FramePort = Pick<
  PreviewPort,
  "screenshot" | "screenshotCard" | "screenshotWithStats" | "resizeImage" | "viewSize" | "pointer"
>;

export class PreviewService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;
  /** What waits for Live's Reload (`live-gate.ts`). */
  readonly #live: LiveGate;
  /** Harness calls in the stand-in right now, and the timer that closes it once none has come for a while. */
  #standInUses = 0;
  #standInIdle: NodeJS.Timeout | null = null;
  readonly #frames = new Map<string, PendingFrame>();
  #stageVisible = true;
  /** The person watches a game in Live, whatever briefly covers it (the renderer's `watchingLive`). */
  #liveWatched = true;
  /** Sessions looking through Live itself: only where this build opens no hidden windows. */
  #liveObservers = 0;
  /** What the Live game's sound depends on, bar the stage and the agents that `#applySound` reads. */
  #sound: Pick<LiveSound, "on" | "foreground"> = { on: true, foreground: true };
  /** Pooled windows a computer session plays in, by how many sessions hold each: none changes size. */
  readonly #sessionWindows = new Map<string, number>();

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
    this.#live = new LiveGate({
      emit: (event) => core.emit(UiEvent.LiveBehind, event),
      gameDir: (project) => core.games.dirFor(project),
      showing: () => x.servedRoots.get(LIVE_HANDLE),
      showingHead: (project) => (x.runPreview.project === project ? x.runPreview.head : null),
    });
  }

  /** Apply stage visibility without suspending an agent's observation. */
  async setStageVisible(visible: boolean, watching = visible): Promise<void> {
    this.#stageVisible = visible;
    this.#liveWatched = watching;
    this.#updateVisibility();
  }

  /**
   * Whether a show or landing the person asked for may load Live itself: Live, holding this game
   * (or none yet), is out of their sight. While they watch it, a dialog or a popover over it
   * included, only Reload changes it (`live-gate.ts`).
   */
  liveOutOfSight(project: string): boolean {
    return !this.#liveWatched && !this.liveHoldsAnother(project);
  }

  /** Live holds a game other than this one: nothing of this one is shown or offered there. */
  liveHoldsAnother(project: string): boolean {
    const holds = this.#x.servedRoots.get(LIVE_HANDLE)?.project;
    return holds !== undefined && holds !== project;
  }

  /** Re-evaluate observation after a run starts or settles. */
  refreshVisibility(): void {
    this.#updateVisibility();
  }

  #updateVisibility(): void {
    // A run's harness looks through Live only where this build opens no hidden windows
    // (`harnessWindow`); elsewhere it has the stand-in, and a hidden Live rests during a run.
    const runLooksAtLive = this.#x.activeRunIds.size > 0 && !this.#core.options.createHeadlessPreview;
    const observed = this.#liveObservers > 0 || runLooksAtLive;
    const preview = this.#optionalPreview();
    preview?.setObserved?.(observed);
    preview?.setVisible?.(this.#stageVisible || observed);
    this.#applySound();
  }

  /** The user's switch. */
  setSound(request: GameSoundRequest): void {
    this.#sound = { ...this.#sound, on: request.on };
    this.#applySound();
  }

  /** Genex came to the front or went behind another app: a game in the background is not heard. */
  setForeground(foreground: boolean): void {
    this.#sound = { ...this.#sound, foreground };
    this.#applySound();
  }

  /** Live is heard only while it is the user's own game, on screen, in front, with the switch on. */
  #applySound(): void {
    const lent = this.#liveObservers > 0;
    this.#optionalPreview()?.setAudioMuted?.(!liveAudible({ ...this.#sound, lent, shown: this.#stageVisible }));
  }

  /**
   * A builder's checkpoint in `cwd`. It never reloads Live (`live-gate.ts`): the game folder, or
   * the build folder Live serves when the checkpoint is in that one, is offered to Live's Reload.
   */
  async checkpointPreview(project: string, cwd: string, note: string | null): Promise<void> {
    const served = this.#x.servedRoots.get(LIVE_HANDLE);
    const servedRoot = served?.project === project ? served.root : null;
    const inServed = servedRoot !== null && (await sameRealPath(servedRoot, cwd));
    await this.offerLive({ project, root: inServed ? servedRoot : null, note });
  }

  /**
   * Lazy on purpose: the app attaches the visible preview to `options.preview` *after*
   * constructing the core (the window does not exist yet), so the pool can only form on first
   * use. Tests that inject a preview up front take the same path.
   */
  pool(): PreviewPool {
    if (!this.#x.previewPool) {
      if (!this.#core.options.preview) throw new Error(MESSAGE.noPreview);
      this.#x.previewPool = new PreviewPool({
        live: this.#core.options.preview,
        ...(this.#core.options.createHeadlessPreview
          ? { createHeadless: this.#core.options.createHeadlessPreview }
          : {}),
        max: this.#core.options.previewPoolMax ?? this.#x.settings.agentsMax,
      });
    }
    return this.#x.previewPool;
  }

  async previewRevision(project: string, root: string | null): Promise<string | null> {
    const dir = root ?? this.#core.games.dirFor(project);
    try {
      if ((await git(dir, ["status", "--porcelain"])).trim()) return null;
      return (await git(dir, ["rev-parse", "HEAD"])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Where the preview serves a project from. The studio's own shape serves the folder as it is.
   * A game with its own build is built first — in a shadow under the app's scratch, never in the
   * folder the user owns — and its output is served, so `/assets/…` inside the built page
   * resolves where the bundler put it.
   *
   * When the build fails, the *live* stage falls back to the last output that worked and says
   * why (`buildProblem`); a judged load gets nothing, because scoring a stale page is scoring a
   * build the run never produced.
   */
  async servedEntry(
    project: string,
    root: string | null,
    entry: string | undefined,
    port: PreviewPort,
    options: { fallback?: boolean } = {},
  ): Promise<{ entry: string; root: string | undefined; loopback: boolean; stale: string | null } | null> {
    const descriptor = (await this.#core.games.list().catch(() => [] as GameProject[])).find((g) => g.name === project);
    const shape = descriptor?.shape ?? TEMPLATE_SHAPE;
    const loopback = descriptor?.built === true;
    const base = root ?? this.#core.games.dirFor(project);
    const outcome = await this.#core.builds.ensure({ project, dir: base, shape });
    const note = outcome.problem ? buildFailureNote(outcome.problem) : null;
    if (note) port.note?.("error", note, { loadError: true });
    // The live folder is the one the user is looking at, so it is the one whose trouble the
    // stage reports; a worktree's build failure belongs to the run that made it.
    if (root === null) {
      if (outcome.problem) this.#x.buildProblems.set(project, outcome.problem);
      else this.#x.buildProblems.delete(project);
    }
    const served = servedAfterBuild(outcome, { fallback: options.fallback === true });
    if (!served) return null;
    // Serving the source folder itself needs no override: the preview resolves the project on
    // its own, and a review worktree keeps the root its caller passed.
    const asSource = path.resolve(served.dir) === path.resolve(base);
    return {
      entry: entry ?? (asSource ? shape.entry : path.basename(shape.entry)),
      root: asSource ? (root ?? undefined) : served.dir,
      loopback,
      stale: served.stale ? note : null,
    };
  }

  /** `preview.load`: serve a game (or a checked worktree of it) into a preview, one load per handle at a time. */
  loadPreview(p: HarnessParams<"preview.load">): Promise<string> {
    const handle = p.handle ?? LIVE_HANDLE;
    return serial(this.#x.previewOperations, handle, async () => {
      const profiling = Boolean(p.candidateId && p.revision);
      const checkedRoot = await this.#x.assertHarnessRoot(p.project, profiling ? null : p.root);
      this.#x.profileSources.delete(handle);
      const port = this.preview(p.handle);
      if (p.candidateId && p.revision)
        return this.#loadCandidate(p, { candidateId: p.candidateId, revision: p.revision }, port);
      return this.#loadServedPreview(p, handle, checkedRoot, port);
    });
  }

  /** A profiling load: an optimizer candidate's frozen revision, on a stage preview only. */
  async #loadCandidate(
    p: HarnessParams<"preview.load">,
    candidate: { candidateId: string; revision: Revision },
    port: PreviewPort,
  ): Promise<string> {
    const source = await this.#core.candidates.source(candidate.candidateId, candidate.revision);
    const onStage = p.handle === LIVE_HANDLE || p.handle === STAND_IN_HANDLE;
    const stageHandle = p.handle && !onStage ? p.handle : null;
    if (source.project !== p.project || !stageHandle) throw new Error(MESSAGE.profilingNeedsStage);
    const served = await this.servedEntry(p.project, source.root, p.entry, port);
    const url = served
      ? await port.load(p.project, served.entry, served.root, { loopback: served.loopback })
      : unservedUrl(p);
    this.#x.profileSources.set(stageHandle, candidate);
    return url;
  }

  async #loadServedPreview(
    p: HarnessParams<"preview.load">,
    handle: string,
    checkedRoot: string | null,
    port: PreviewPort,
  ): Promise<string> {
    const remembered = { project: p.project, root: checkedRoot, entry: p.entry, loaded: null as string | null };
    this.#x.servedRoots.set(handle, remembered);
    const isLive = handle === LIVE_HANDLE;
    const revisionBefore = isLive ? await this.previewRevision(p.project, checkedRoot) : null;
    const print = isLive ? await this.#live.printBefore(p.project, checkedRoot) : undefined;
    if (isLive)
      this.#showIdentity({ project: p.project, head: null, state: PreviewIdentityState.Loading, error: null });
    try {
      const served = await this.servedEntry(p.project, checkedRoot, p.entry, port, { fallback: isLive });
      if (!served) return unservedUrl(p);
      const url = await port.load(p.project, served.entry, served.root, { loopback: served.loopback });
      // Only now is Live current: a load that failed leaves what waited for Reload waiting.
      if (isLive) await this.#live.loaded(p.project, { print, root: checkedRoot });
      remembered.loaded = servedKey(served);
      if (isLive) await this.#identifyLoaded(p.project, checkedRoot, served.stale, revisionBefore);
      // Loading clears the port's error, and the build is still broken: the agent loop and the
      // judges read that flag, so the failure is put back on the page the user can see.
      if (served.stale) port.note?.("error", served.stale, { loadError: true });
      return url;
    } catch (error) {
      if (isLive)
        this.#showIdentity({
          project: p.project,
          head: null,
          state: PreviewIdentityState.Failed,
          error: String(error),
        });
      throw error;
    }
  }

  /** What the live stage shows now, for the stage's identity strip. */
  #showIdentity(identity: CoreInternals["runPreview"]): void {
    this.#x.runPreview = identity;
    this.#core.emit(UiEvent.PreviewIdentity, this.#x.runPreview);
  }

  /** The live stage loaded: its head, when the folder did not move under the load and the build is not stale. */
  async #identifyLoaded(
    project: string,
    root: string | null,
    stale: string | null,
    revisionBefore: string | null,
  ): Promise<void> {
    const after = await this.previewRevision(project, root);
    const unchanged = !stale && after === revisionBefore;
    this.#showIdentity({
      project,
      head: unchanged ? after : null,
      state: stale ? PreviewIdentityState.Stale : PreviewIdentityState.Loaded,
      error: stale ?? null,
    });
  }

  preview(handle?: string): PreviewPort {
    return this.pool().port(handle);
  }

  /** A saved run artefact, and only that: the crop/diff RPCs never open a path outside `runs/`. */
  async runFile(file: string): Promise<string> {
    const runsRoot = await realpath(this.#core.layout.runs);
    const resolved = await realpath(String(file ?? ""));
    if (!isInside(runsRoot, resolved)) {
      throw new Error(MESSAGE.notRunArtefact(file));
    }
    return resolved;
  }

  /** A run artefact or a project reference still — the two places a pair/stats RPC may read from. */
  async stillFile(file: string): Promise<string> {
    try {
      return await this.runFile(file);
    } catch {
      const resolved = await realpath(String(file ?? ""));
      const games = await this.#core.games.list();
      for (const game of games) {
        const refs = await realpath(path.join(game.dir, "references")).catch(() => null);
        if (refs && isInside(refs, resolved)) return resolved;
      }
      throw new Error(MESSAGE.notStill(file));
    }
  }

  /**
   * A bench page for this project, or the sentence that refuses it. The page is served from the
   * workspace itself, so a game the preview serves from elsewhere (its build's output, a serve
   * folder) is refused up front: the page is not there, and a failed load would read as a broken
   * build.
   */
  async #benchFor(project: string, root: string, page: string): Promise<{ entry: string } | { refusal: string }> {
    const descriptor = (await this.#core.games.list().catch(() => [] as GameProject[])).find((g) => g.name === project);
    const shape = descriptor?.shape ?? TEMPLATE_SHAPE;
    const servedElsewhere = descriptor?.built === true || shape.build !== null || (shape.serve ?? ".") !== ".";
    if (servedElsewhere) return { refusal: MESSAGE.benchRefused(page, MESSAGE.benchBuilt) };
    return benchEntry(root, page);
  }

  /**
   * Builder eyes: renders the contractor's own workspace in a pooled hidden preview and saves
   * frames it can Read mid-turn — the counter to a whole run of coding blind (44% acceptance).
   * One lease per call, held only for the seconds of the capture, so three parallel facets and
   * the evidence pass share the pool without starving each other. Never throws: the tool
   * reports failure as text, because a broken capture must not end a build.
   */
  captureFor(
    sc: NonNullable<DelegateRequest["selfCapture"]>,
    root: string,
    outBase: string,
    session: SessionPort,
    /** The director's capture follows its window: whatever build `look` last pointed it at. */
    currentRoot: () => string = () => root,
    /** Whose screen the frames land on (the card's role must not flip to "builder" on a capture). */
    role: AgentScreen["role"] = "builder",
  ): NonNullable<DelegateRequest["onCapture"]> {
    let sequence = 0;
    let sequenceSeeded = false;
    return async ({ cameras, page } = {}) => {
      // A bench page is checked before anything is touched: a refused one loads nothing.
      const bench = page === undefined ? null : await this.#benchFor(sc.project, currentRoot(), String(page));
      if (bench && "refusal" in bench) return bench.refusal;
      const outDir = iterationDir(outBase, sc.iteration);
      await ensureDir(outDir);
      // The counter continues from what is already on disk, so a review-fix turn (a second
      // delegation in the same iteration) never overwrites the baseline frames.
      if (!sequenceSeeded) {
        sequenceSeeded = true;
        sequence = Math.max(sequence, await lastCaptureNumber(outDir));
      }
      const call = ++sequence;
      const port = await session.get();
      const loaded = await this.#loadForCapture(port, sc, session, { target: currentRoot(), bench });
      if ("problem" in loaded)
        return `your build failed to load: ${loaded.problem} — fix that before polishing anything.`;
      const screen = captureScreen(sc, session, role);
      this.openScreen(screen);
      const registered = await port.studioCall("cameras").catch(() => null);
      const known = Array.isArray(registered) ? registered.map(String) : [];
      const lines: string[] = [];
      for (const camera of camerasForShot(sc, bench, cameras, known))
        lines.push(await this.#captureCamera(port, screen, { outDir, call, camera, known }));
      const errors = port.consoleEntries(0).filter((entry) => entry.level === "error");
      return captureAnswer({ bench, root, lines, errors, setupNote: loaded.setupNote });
    };
  }

  /**
   * The session's window for a capture: a fresh load of the workspace (edits included) through
   * the served entry — a game with its own build is built first — then the setup script. A bench
   * page loads through the same served root and skips the setup: it mounts one module, and the
   * game's script has nothing there to replay. The window stays loaded for the computer tool
   * after a capture of the build; after a bench page the computer tool loads the game again.
   */
  async #loadForCapture(
    port: PreviewPort,
    sc: NonNullable<DelegateRequest["selfCapture"]>,
    session: SessionPort,
    { target, bench }: { target: string; bench: { entry: string } | null },
  ): Promise<{ problem: string } | { setupNote: string | null }> {
    const loaded = await this.loadServed(port, sc.project, target, bench?.entry ?? sc.entry);
    if (loaded.problem) {
      session.loaded = null;
      return { problem: loaded.problem };
    }
    const applied = bench ? null : await this.applySetup(port, sc.setup);
    session.loaded = bench ? null : { root: target, at: Date.now() };
    // A page the studio never heard report itself ready is still photographed — the frames
    // just come with the sentence that says what they are worth.
    return { setupNote: [loaded.note, applied].filter(Boolean).join("; ") || null };
  }

  /** One camera's frame of a capture, saved beside the facet's others; its line of the answer. */
  async #captureCamera(
    port: PreviewPort,
    screen: AgentScreen,
    shot: { outDir: string; call: number; camera: string; known: readonly string[] },
  ): Promise<string> {
    const { outDir, call, camera, known } = shot;
    try {
      const placeable = known.includes(camera) || camera.startsWith("eye:");
      const actual = await placeCamera(port, camera, placeable);
      const switchIsDead = placeable && actual !== null && actual !== camera;
      const warning = switchIsDead
        ? ` — WARNING: the build rendered camera "${actual}" instead; your debugCamera("${camera}") does not switch`
        : "";
      // `auto`: a game whose menu, car-select or HUD lives in the DOM is invisible to a
      // canvas-only eye, and the builder is the one who has to see what it built.
      const frame = await captureSurface(port, DEFAULT_SHOT_QUALITY, CaptureSurface.Auto);
      const file = path.join(outDir, `c${call}_${safePathSegment(camera)}.jpg`);
      await writeFile(file, frame.jpeg);
      await this.frame(port, screen, frame.jpeg, `capture ${camera}`, { deed: ScreenDeed.Look });
      return capturedLine(camera, file, frame, actual === camera, warning);
    } catch (err) {
      return `- ${camera} → capture failed: ${errorMessage(err)}`;
    }
  }

  // ── the computer: one pooled window per session ──────────────────────────────

  /**
   * One preview port for a whole delegation: the facet's idle observation lease when the
   * harness gave one, otherwise a lease of the session's own — taken on first use, released by
   * the delegation's finally. `loaded` remembers what the window shows so `capture` (reload +
   * shots) and `computer` (keep playing) agree on when a reload is due.
   *
   * A session never takes the person's window: a handle the harness named for it is honoured only
   * for a pooled window, never Live or the stand-in every harness call shares, and when every
   * pooled window is leased it gets one past the pool's ceiling for its own length, or waits for one
   * (`OVERFLOW_WINDOWS_MAX`) until it ends. Only a build with no hidden windows at all (the test
   * rigs) has nothing but the live view to lend.
   */
  sessionPortFor(options: { handle?: string; label: string }): SessionPort {
    let port: PreviewPort | null = null;
    let lease: { handle: string } | null = null;
    let handle: string | null = null;
    let taking: Promise<PreviewPort> | null = null;
    let observing = false;
    const ended = new AbortController();
    const named = options.handle && !SHARED_WINDOWS.has(options.handle) ? options.handle : null;
    let held: string | null = null;
    const hold = (window: string): void => {
      held = window;
      this.#holdSessionWindow(window);
    };
    if (named) {
      try {
        port = this.pool().port(named);
        handle = named;
        // The computer tool plays at the facet size: a window the harness resized for a look is put back.
        this.pool().restoreSize(named);
        hold(named);
      } catch {
        port = null;
      }
    }
    const take = async (): Promise<PreviewPort> => {
      const pool = this.pool();
      if (!pool.headless) {
        handle = LIVE_HANDLE;
        port = pool.port();
        // Live keeps simulating while this session looks through it, even off the stage.
        observing = true;
        this.#liveObservers++;
        this.#updateVisibility();
        return port;
      }
      const { label } = options;
      const taken = await pool
        .acquire({ label })
        .catch(() => pool.acquire({ label, overflow: true, signal: ended.signal }));
      // The session ended while its window was opening: nobody will give this one back.
      if (ended.signal.aborted) {
        await pool.release(taken.handle).catch(() => {});
        throw new Error(MESSAGE.sessionEnded);
      }
      lease = taken;
      handle = taken.handle;
      hold(taken.handle);
      port = pool.port(taken.handle);
      return port;
    };
    const session: SessionPort = {
      loaded: null,
      handle: () => handle,
      get: async () => {
        if (port) return port;
        taking ??= take().finally(() => {
          taking = null;
        });
        return taking;
      },
      release: async () => {
        ended.abort();
        if (lease)
          await this.pool()
            .release(lease.handle)
            .catch(() => {});
        lease = null;
        if (handle) this.closeScreen(handle);
        if (held) this.#dropSessionWindow(held);
        held = null;
        port = null;
        if (observing) {
          observing = false;
          this.#liveObservers--;
          this.#updateVisibility();
        }
      },
    };
    return session;
  }

  #holdSessionWindow(handle: string): void {
    this.#sessionWindows.set(handle, (this.#sessionWindows.get(handle) ?? 0) + 1);
  }

  #dropSessionWindow(handle: string): void {
    const held = (this.#sessionWindows.get(handle) ?? 0) - 1;
    if (held > 0) this.#sessionWindows.set(handle, held);
    else this.#sessionWindows.delete(handle);
  }

  /**
   * `preview.viewport`: one leased window at another size for a look (`PreviewPool.resize`),
   * back at the facet size when the lease is released. Refused, with nothing moved, for no
   * handle, Live, the stand-in and a window a computer session plays in, so the computer tool's
   * view of a worker's or the lead's window never changes size.
   */
  viewport(p: HarnessParams<"preview.viewport">): HarnessResult<"preview.viewport"> {
    const handle = p?.handle;
    if (typeof handle !== "string" || SHARED_WINDOWS.has(handle)) throw new Error(MESSAGE.viewportNeedsLease);
    if (this.#sessionWindows.has(handle)) throw new Error(MESSAGE.viewportInSession(handle));
    return { handle, ...this.pool().resize(handle, p) };
  }

  /** What the studio asks the page to wait for: the folder's own `bootMs`, or the default. */
  async bootMsFor(project: string): Promise<number> {
    const descriptor = (await this.#core.games.list().catch(() => [] as GameProject[])).find(
      (game) => game.name === project,
    );
    return bootBudget(descriptor?.shape.bootMs);
  }

  /**
   * Load a build into a port the way the judges do: through the served entry, so a game with
   * its own build (Vite, TypeScript) is built first. Loaded raw from `index.html`, such a game
   * serves `src/main.ts` as text and every worker works blind.
   *
   * Then it waits for a FACT instead of the flat 1.5 s it used to sleep: one budget, resolved
   * from `studio.json`'s `bootMs`, given both to the page (so the shim's own bound and this
   * poll expire together) and to `awaitReady`.
   *
   * A page that never reports itself ready is NOT a failure. Every caller here turns a problem
   * into an error string and then skips the setup script, the screen and the first frame — so
   * refusing a slow page would blind the scout and every computer-tool worker on exactly the
   * shape this milestone exists for. A timeout is a NOTE on the caller's answer. Refusal is
   * reserved for a real load error, a page that reports that it FAILED to boot, and a page that
   * has left the address the studio serves — the last being the boundary that stops a game
   * escaping the studio by running its own dev server on its own port.
   */
  async loadServed(
    port: PreviewPort,
    project: string,
    root: string | null,
    entry?: string,
    forceLoopback = false,
  ): Promise<LoadedServed> {
    const served = await this.servedEntry(project, root, entry, port);
    if (!served) return { problem: port.status().loadError ?? "the game's build failed", note: null, ready: null };
    const budgetMs = await this.bootMsFor(project);
    // `shim.readyMs` is the same number: one budget, so the page and the studio give up together.
    const loaded = await port.load(project, served.entry, served.root, {
      loopback: served.loopback || forceLoopback,
      shim: { readyMs: budgetMs },
    });
    const ready = await awaitReady(port, { timeoutMs: budgetMs });
    const status = port.status();
    if (status.loadError) return { problem: status.loadError, note: null, ready };
    const stray = strayPage(loaded, status.url);
    if (stray) return { problem: stray, note: null, ready };
    if (ready.phase === ReadyPhase.Failed)
      return { problem: ready.reason ?? "the page reported that it failed to boot", note: null, ready };
    return { problem: null, note: readyNote(ready), ready };
  }

  /**
   * Play, then the requested state, reached the way a player reaches it — before anyone looks.
   * A game with a title, menu or countdown is put past it the way every judge sees it
   * (`beginPlay`), with no setup at all as much as with one, unless the setup keeps the front-end
   * (`begin: false`) or the window is the playtester's (`keepFrontEnd`: it meets the real menu
   * whatever an older seed sends). The run's setup script is replayed after that, from the state
   * the scout recorded it in: its window was begun too. Returns a note when it did not land, never
   * throws: a wrong state is something to tell the worker, not a reason to stop looking.
   * `options.sleep` is the wall clock's wait, injectable for a test.
   */
  async applySetup(
    port: PreviewPort,
    setup: PreviewSetup | null | undefined,
    options: { sleep?: (ms: number) => Promise<unknown>; keepFrontEnd?: boolean } = {},
  ): Promise<string | null> {
    const wait = options.sleep ?? ((ms: number) => sleep(ms));
    // The knock comes first, before the clock is even started: a trusted click is what grants
    // user activation, and a title screen waiting for one is not "started" until it has it.
    if (setup?.gesture) {
      const at = setup.gesture === true ? null : setup.gesture;
      await unlockGesture(port, at, at?.keys).catch(() => null);
    }
    await port.studioCall(GameClock.Start).catch(() => null);
    const notes: string[] = [];
    const playNote = options.keepFrontEnd === true ? null : await beginPlay(port, setup, wait);
    if (playNote) notes.push(playNote);
    if (setup && replaysSomething(setup)) await replaySetup(port, setup, notes, wait);
    const verifyNote = setup ? await setupVerifyNote(port, setup) : null;
    if (verifyNote) notes.push(verifyNote);
    return notes.length ? notes.join("; ") : null;
  }

  openScreen(screen: AgentScreen): void {
    if (this.#x.screens.has(screen.handle)) return;
    this.#x.screens.set(screen.handle, screen);
    const event: AgentScreenEvent = { ...screen, state: "opened", at: Date.now() };
    this.#core.emit(UiEvent.PreviewScreen, event);
  }

  closeScreen(handle: string): void {
    const frame = this.#frames.get(handle);
    if (frame) {
      frame.closed = true;
      clearTimeout(frame.timer);
      this.#frames.delete(handle);
    }
    // A released window forgets what it served; Live and the stand-in keep theirs (the stand-in
    // shows it again when the harness next looks, `#mirrorIntoStandIn`).
    if (!SHARED_WINDOWS.has(handle)) this.#x.servedRoots.delete(handle);
    const screen = this.#x.screens.get(handle);
    if (!screen) return;
    this.#x.screens.delete(handle);
    const { jpeg: _jpeg, ...meta } = screen as AgentScreenFrame;
    const event: AgentScreenEvent = {
      handle: meta.handle,
      label: meta.label,
      project: meta.project,
      runId: meta.runId,
      facetId: meta.facetId,
      role: meta.role,
      state: "closed",
      at: Date.now(),
    };
    this.#core.emit(UiEvent.PreviewScreen, event);
  }

  /** A new picture of a worker's window, downscaled for its node, with the cursor and the deed. */
  async frame(
    port: FramePort,
    screen: AgentScreen,
    jpeg: Buffer | null,
    caption: string | null,
    act: ScreenAct | null = null,
  ): Promise<void> {
    let state = this.#frames.get(screen.handle);
    if (!state) {
      state = { at: -Infinity, running: false, closed: false };
      this.#frames.set(screen.handle, state);
    }
    const current = state;
    const capture = () => this.#captureFrame(port, screen, { jpeg, caption, act }, current);
    current.next = capture;
    if (current.running || current.timer) return;
    const remaining = FRAME_MIN_INTERVAL_MS - (Date.now() - current.at);
    if (remaining > 0) {
      current.timer = setTimeout(() => void this.#flushFrame(current), remaining);
      current.timer.unref?.();
      return;
    }
    await this.#flushFrame(current);
  }

  async #flushFrame(state: PendingFrame): Promise<void> {
    state.timer = undefined;
    if (state.closed || state.running || !state.next) return;
    const capture = state.next;
    state.next = undefined;
    state.running = true;
    state.at = Date.now();
    try {
      await capture();
    } finally {
      state.running = false;
      if (!state.closed && state.next) {
        state.timer = setTimeout(() => void this.#flushFrame(state), FRAME_MIN_INTERVAL_MS);
        state.timer.unref?.();
      }
    }
  }

  async #captureFrame(port: FramePort, screen: AgentScreen, deed: FrameDeed, state: PendingFrame): Promise<void> {
    const { jpeg } = deed;
    try {
      if (!jpeg && port.screenshotCard) {
        const card = await port.screenshotCard(CARD_QUALITY, CARD_WIDTH_PX);
        if (card && !state.closed) this.#publishFrame(port, screen, card, deed);
        return;
      }
      let shot = jpeg;
      if (!shot && port.screenshotWithStats) {
        // `auto` reads the compositor when the canvas read is black. A frame that is still black
        // (a page between loads) shows nothing of the game: the card keeps its last picture.
        const captured = await port.screenshotWithStats(FRAME_QUALITY, { surface: CaptureSurface.Auto });
        if (isEffectivelyBlack(captured.stats)) return;
        shot = captured.jpeg;
      }
      shot ??= await port.screenshot(FRAME_QUALITY);
      const small = port.resizeImage ? await port.resizeImage(shot, CARD_WIDTH_PX, CARD_QUALITY) : shot;
      if (!state.closed) this.#publishFrame(port, screen, small, deed);
    } catch {
      /* a lost frame is a stale card, never a failed action */
    }
  }

  #publishFrame(port: FramePort, screen: AgentScreen, jpeg: Buffer, { caption, act }: FrameDeed): void {
    const size = port.viewSize?.() ?? COMPUTER_VIEW;
    const cursor = port.pointer?.() ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
    const frame: AgentScreenFrame = {
      ...screen,
      jpeg: jpeg.toString("base64"),
      width: size.width,
      height: size.height,
      cursor,
      caption,
      ...(act ? { act } : {}),
      at: Date.now(),
    };
    this.#x.screens.set(screen.handle, frame);
    this.#core.emit(UiEvent.PreviewFrame, frame);
  }

  async showBuild(project: string, commit: string): Promise<{ dir: string; commit: string }> {
    if (!COMMIT_HASH.test(String(commit ?? ""))) throw new Error(MESSAGE.notCommitHash(commit));
    const projectDir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(projectDir);
    this.#core.snapshots.register({ name: project, dir: projectDir });
    const resolved = (await git(projectDir, ["rev-parse", "--verify", `${commit}^{commit}`]).catch(() => "")).trim();
    if (!resolved) throw new Error(MESSAGE.notInHistory(commit, project));
    // Prepare an independent revision. A failed build must never delete the currently served one.
    const showDir = path.join(
      this.#core.layout.scratch,
      "show",
      `${project}-${resolved.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    );
    await ensureDir(path.dirname(showDir));
    await this.#core.snapshots.worktreeAt(project, resolved, showDir, await this.nestedPolicy(projectDir));
    const previous = this.#x.servedRoots.get(LIVE_HANDLE);
    // A preview candidate may never borrow the user's Live window.
    let candidateHandle: string | undefined;
    let liveAttempted = false;
    try {
      const lease = await this.pool().acquire({ label: `preview-candidate:${project}` });
      candidateHandle = lease.handle;
      const port = this.pool().port(lease.handle);
      const candidate = await this.loadServed(port, project, showDir);
      if (candidate.problem) throw new Error(candidate.problem);
      if (this.#x.servedRoots.get(LIVE_HANDLE) !== previous) throw new Error(MESSAGE.previewChanged);
      liveAttempted = true;
      await this.loadPreview({ project, root: showDir });
    } catch (error) {
      if (liveAttempted && previous)
        await this.loadPreview({ project: previous.project, root: previous.root, entry: previous.entry }).catch(
          () => {},
        );
      await this.#core.snapshots.removeWorktree(project, showDir).catch(() => {});
      await rm(showDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      if (candidateHandle) await this.pool().release(candidateHandle);
    }
    await this.#core.games.touch(project).catch(() => {});
    return { dir: showDir, commit: resolved };
  }

  /** Whether the studio may version this game's own nested repositories inside a fork of it. */
  async nestedPolicy(projectDir: string): Promise<{ versionNested: boolean }> {
    return { versionNested: await this.#core.games.nestedConsent(projectDir).catch(() => false) };
  }

  /**
   * The project's reference stills as frames: every image under `references/`, sniffed
   * (the bytes decide), resized to `maxPx` on the long side when the preview can, at most
   * `max`. Unreadable files are listed in `skipped` with what they turned out to be.
   */
  async referenceStills(
    project: string,
    { max = REFERENCE_MAX_STILLS, maxPx = REFERENCE_MAX_PX }: { max?: number; maxPx?: number } = {},
  ): Promise<{ frames: ReferenceFrame[]; skipped: SkippedStill[] }> {
    const dir = path.join(this.#core.games.dirFor(project), "references");
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    const frames: ReferenceFrame[] = [];
    const skipped: SkippedStill[] = [];
    const preview = this.#optionalPreview();
    for (const name of entries) {
      if (frames.length >= Math.max(1, max)) break;
      if (REFERENCE_NOTE.test(name)) continue;
      const still = await this.#referenceStill(dir, name, preview, maxPx);
      if ("why" in still) skipped.push(still);
      else frames.push(still);
    }
    return { frames, skipped };
  }

  /** One reference still as a frame, or why it cannot be one. */
  async #referenceStill(
    dir: string,
    name: string,
    preview: PreviewPort | null,
    maxPx: number,
  ): Promise<ReferenceFrame | SkippedStill> {
    const data = await readFile(path.join(dir, name)).catch(() => null);
    if (!data || data.length === 0) return { file: name, why: MESSAGE.stillUnreadable };
    if (data.length > REFERENCE_MAX_BYTES) return { file: name, why: MESSAGE.stillTooLarge };
    const sniffed = sniffImage(data);
    if (!sniffed) {
      const why = MESSAGE.stillNotJudgeable(describeUnknownImage(data));
      this.#core.options.onLog?.(`[core] reference skipped: ${name} is ${why}`, "stderr");
      return { file: name, why };
    }
    const resized = await resizedStill(preview, data, maxPx);
    return {
      label: name.replace(/\.[^.]+$/, ""),
      mimeType: resized ? "image/jpeg" : sniffed.mimeType,
      data: (resized ?? data).toString("base64"),
    };
  }

  /** The live preview, or null when the studio runs headless. */
  #optionalPreview(): PreviewPort | null {
    try {
      return this.preview();
    } catch {
      return null;
    }
  }

  /** Every open agent screen with its last frame — what a freshly opened window asks for. */
  agentScreens(): AgentScreenFrame[] {
    return [...this.#x.screens.values()].filter(
      (s): s is AgentScreenFrame => typeof (s as AgentScreenFrame).jpeg === "string",
    );
  }

  async readProjectAsset(p: ProjectAssetRead): Promise<{ mimeType: string; data: string } | null> {
    if (!p || typeof p.project !== "string") return null;
    const resize = this.#resizeTo(p.maxPx);
    // The game's kept Genex cover shot: its place is the host's, from the game's name alone.
    if (p.scope === ProjectAssetScope.GenexCover)
      return readGenexCoverShot(this.#core.layout.engineHomes, p.project, resize);
    if (typeof p.file !== "string") return null;
    if (p.scope === ProjectAssetScope.GenexInspection) {
      const dir = genexJobDir(this.#core.layout.engineHomes, p.project, String(p.jobId ?? ""));
      if (!dir || !isGenexInspectionFile(p.file)) return null;
      return readContainedImage(dir, p.file, { prefixes: [], ...resize });
    }
    if (isGenexRef(p.file)) return this.#readGenexOutput(p.project, p.file, resize);
    return readContainedImage(this.#core.games.dirFor(p.project), p.file, resize);
  }

  /** A downscale to `maxPx` for an image read, when one is asked for and the preview can. */
  #resizeTo(maxPx: number | undefined): { resize?: (data: Buffer) => Promise<Buffer> } {
    const preview = this.#optionalPreview();
    const shrink = preview?.resizeImage;
    const px = typeof maxPx === "number" && maxPx > 0 ? maxPx : null;
    if (!px || !shrink) return {};
    return { resize: (data: Buffer) => shrink.call(preview, data, px, DEFAULT_STILL_QUALITY) };
  }

  /** An image a Genex job this project owns produced, named by its `genex:` reference. */
  async #readGenexOutput(
    project: string,
    ref: string,
    resize: { resize?: (data: Buffer) => Promise<Buffer> },
  ): Promise<{ mimeType: string; data: string } | null> {
    const output = genexOutputFile(ref);
    const dir = output && genexJobDir(this.#core.layout.engineHomes, project, output.jobId);
    if (!output || !dir) return null;
    const jobs = await readGenexJobs(this.#core.layout.engineHomes, project);
    if (!jobs.some((job) => job.id === output.jobId)) return null;
    return readContainedImage(path.join(dir, "output"), output.file, { prefixes: [], ...resize });
  }

  async readRunStill(filePath: string, maxPx?: number): Promise<{ mimeType: string; data: string } | null> {
    if (typeof filePath !== "string" || !filePath) return null;
    const [runsRoot, resolved] = await Promise.all([
      realpath(this.#core.layout.runs).catch(() => null),
      realpath(filePath).catch(() => null),
    ]);
    if (!runsRoot || !resolved) return null;
    if (!isInside(runsRoot, resolved)) return null;
    if (!isImageFile(resolved)) return null;
    const metadata = await stat(resolved).catch(() => null);
    if (!metadata?.isFile() || metadata.size > REFERENCE_MAX_BYTES) return null;
    if (invalidStillSize(maxPx)) return null;
    const data = await readFile(resolved);
    if (data.length > REFERENCE_MAX_BYTES) return null;
    // The bytes name the type: a renamed file renders as what it is or not at all.
    const sniffed = sniffImage(data);
    if (!sniffed) return null;
    const resized = maxPx ? await resizedStill(this.#optionalPreview(), data, maxPx) : null;
    const output = resized ?? data;
    if (output.length > REFERENCE_MAX_BYTES) return null;
    return { mimeType: resized ? "image/jpeg" : sniffed.mimeType, data: output.toString("base64") };
  }

  /**
   * Load a game snapshot in the preview without touching the live folder or the harness.
   * The working copy is a detached git worktree under scratch, so Play is not a rollback.
   */
  async playGameSnapshot(snapshotId: string, project: string): Promise<{ dir: string; snapshotId: string }> {
    const record = this.#core.snapshotIndex.get(snapshotId);
    if (!record?.git.game) throw new Error(MESSAGE.noGameInSnapshot);
    await this.#core.assertProjectAllowed(this.#core.games.dirFor(project));
    this.#core.snapshots.register({ name: project, dir: this.#core.games.dirFor(project) });
    const playDir = path.join(this.#core.layout.scratch, "review-play", project);
    await this.#core.snapshots.removeWorktree(project, playDir);
    await rm(playDir, { recursive: true, force: true });
    await ensureDir(path.dirname(playDir));
    await this.#core.snapshots.worktreeAt(
      project,
      record.git.game,
      playDir,
      await this.nestedPolicy(this.#core.games.dirFor(project)),
    );
    await this.preview().load(project, "index.html", playDir);
    await this.#live.loaded(project, { print: undefined, root: playDir });
    return { dir: playDir, snapshotId };
  }

  /**
   * Make a build live: merge it into the game folder (the branch the user plays from) and load
   * it. Refuses a dirty game folder and a merge that conflicts — the user's edits are never
   * overwritten from here, and since M2.7 nowhere else either: the run's own landing refuses
   * the same way and leaves the build on its ref for this button to land. A landing nobody on the
   * stage asked for (`offerLive`: a harness's `land_build` with no message of the person's waiting
   * on it) lands the same, and only offers the landed folder to Live's Reload.
   */
  async landBuild(
    project: string,
    commit: string,
    { asker, offerLive = false }: { asker?: AbortController; offerLive?: boolean } = {},
  ): Promise<{ commit: string; how: "merged" | "already" }> {
    if (!COMMIT_HASH.test(String(commit ?? ""))) throw new Error(MESSAGE.notCommitHash(commit));
    const projectDir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(projectDir);
    this.#core.snapshots.register({ name: project, dir: projectDir });
    // The chat's own session asking to land (a run control) holds the folder while it waits for
    // this answer: it is not a contractor building there. Anyone else in the folder is.
    const building = [...this.#x.activeDelegations.entries()].some(
      ([cwd, delegation]) => path.resolve(cwd) === path.resolve(projectDir) && delegation.abort !== asker,
    );
    if (building) throw new Error(MESSAGE.contractorBuilding(project));
    const resolved = (await git(projectDir, ["rev-parse", "--verify", `${commit}^{commit}`]).catch(() => "")).trim();
    if (!resolved) throw new Error(MESSAGE.notInHistory(commit, project));
    // A build never brings Claude Code's project settings or hooks: the person's own session in
    // the game loads them, and nothing a run or the harness made may choose them.
    const settings = await claudeFolderChanges(projectDir, "HEAD", resolved);
    if (settings.length) throw new Error(MESSAGE.claudeFolder(resolved.slice(0, 10), settings));
    // The dirty check first, and only then the conversion. Converting renames the nested game's
    // `.git` and commits — a refusal after that left the folder half-converted with nothing
    // landed. A path the conversion is about to absorb reads modified only because it has not
    // happened yet, so it is not what "the user has uncommitted edits" means here.
    const absorbed = await nestedForLanding(projectDir, resolved);
    const dirty = dirtyOutside((await git(projectDir, ["status", "--porcelain"]).catch(() => "")).trim(), absorbed);
    if (dirty.length > 0) {
      throw new Error(MESSAGE.uncommittedEdits(dirty.length));
    }
    // The conversion happens only with the consent the Open Game sheet recorded — the one place
    // the studio touches somebody else's version history.
    const versioned = await versionNestedForLanding(projectDir, resolved, {
      consent: await this.#core.games.nestedConsent(projectDir),
    });
    if (versioned.length > 0)
      this.#core.options.onLog?.(
        `[core] versioned ${versioned.join(", ")} in "${project}" before landing ${resolved.slice(0, 10)}`,
        "stdout",
      );
    const already = await git(projectDir, ["merge-base", "--is-ancestor", resolved, "HEAD"])
      .then(() => true)
      .catch(() => false);
    if (!already) {
      try {
        // No identity flags: `git()` already commits as the studio (snapshots.ts GIT_ENV), and
        // an env identity beats a `-c user.name`, so the pair here only ever looked like a
        // second committer.
        await git(projectDir, ["merge", "--no-ff", "-m", `studio: landed build ${resolved.slice(0, 10)}`, resolved]);
      } catch (err) {
        await git(projectDir, ["merge", "--abort"]).catch(() => {});
        throw new Error(
          MESSAGE.landingConflicted(
            resolved.slice(0, 10),
            String(errorMessage(err)).slice(0, MERGE_ERROR_EXCERPT_CHARS),
          ),
        );
      }
    }
    if (offerLive) await this.offerLive({ project, root: null });
    else await this.loadPreview({ project });
    await this.#core.games.touch(project).catch(() => {});
    return { commit: resolved, how: already ? "already" : "merged" };
  }

  /** Why the stage cannot show this game's own build — null when the last build was fine. */
  buildProblem(project: string): BuildProblem | null {
    return this.#x.buildProblems.get(project) ?? null;
  }

  /**
   * Install the game's packages, in the user's own folder. This is the
   * only thing the studio ever opens the network for, it happens because the user pressed a
   * button, and it opens exactly one domain for exactly this command.
   */
  async installPackages(project: string): Promise<InstallResult> {
    const descriptor = (await this.#core.games.list()).find((game) => game.name === project);
    if (!descriptor) throw new Error(MESSAGE.noSuchGame(project));
    const result = await this.#core.builds.install({ project, dir: descriptor.dir, shape: descriptor.shape });
    if (result.ok) this.#x.buildProblems.delete(project);
    return result;
  }

  /** `preview.reload`: what is on disk now — a rebuild for a game with its own build — one load per handle at a time. */
  reloadPreview(p: HarnessParams<"preview.reload">): Promise<HarnessResult<"preview.reload">> {
    const handle = p?.handle ?? LIVE_HANDLE;
    return serial(this.#x.previewOperations, handle, async () => {
      if (handle === LIVE_HANDLE) {
        this.#showIdentity({
          ...this.#x.runPreview,
          head: null,
          state: PreviewIdentityState.RevisionUnverified,
          error: null,
        });
      }
      const port = this.preview(p?.handle);
      const last = this.#x.servedRoots.get(handle);
      const print = handle === LIVE_HANDLE && last ? await this.#live.printBefore(last.project, last.root) : undefined;
      // Reload means "what is on disk NOW" — for a game with its own build, that is a rebuild.
      const rebuilt = last ? await this.#rebuildServed(port, last, handle, p?.retry === true) : false;
      if (!rebuilt) await port.reload();
      if (last && handle === LIVE_HANDLE) await this.#live.loaded(last.project, { print, root: last.root });
      return true;
    });
  }

  /** The person's Stop: Live's game stops running, after any load of it already under way. */
  stopLive(): Promise<void> {
    return serial(this.#x.previewOperations, LIVE_HANDLE, async () => {
      await this.#optionalPreview()?.stop?.();
    });
  }

  /** The person's Play on a stopped Live: the same page again. */
  playLive(): Promise<void> {
    return serial(this.#x.previewOperations, LIVE_HANDLE, async () => {
      await this.#optionalPreview()?.resume?.();
    });
  }

  // ── Live's gate: only the person changes what Live shows (`live-gate.ts`) ───────────────────

  /**
   * Something would have changed Live — a checkpoint, a rewind, the harness loading the game or a
   * build in the stand-in. It waits for the person's Reload instead (`live.behind`).
   */
  offerLive(offer: LiveOffer): Promise<void> {
    return this.#live.offer(offer);
  }

  /**
   * A build to show that nobody on the stage asked for (a harness's `show_build` with no message of
   * the person's waiting on it): checked as `showBuild` checks it, then offered to Live's Reload,
   * which plays it. Answers the commit it resolved to.
   */
  async offerBuild(project: string, commit: string): Promise<string> {
    if (!COMMIT_HASH.test(String(commit ?? ""))) throw new Error(MESSAGE.notCommitHash(commit));
    const projectDir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(projectDir);
    const resolved = (await git(projectDir, ["rev-parse", "--verify", `${commit}^{commit}`]).catch(() => "")).trim();
    if (!resolved) throw new Error(MESSAGE.notInHistory(commit, project));
    await this.#live.offer({ project, root: null, commit: resolved });
    return resolved;
  }

  /** What waits for Live's Reload for this game, and the build Live shows: what the stage reads on mount. */
  liveState(project: string): LiveBehindEvent {
    return this.#live.state(project);
  }

  /**
   * The person's Reload: what waits for Live, when something does, else what is on disk now. A
   * waiting build that can no longer be played is dropped, so the next Reload is a plain one.
   */
  async reloadLive(p: { retry?: boolean } = {}): Promise<void> {
    const waiting = this.#live.waiting;
    if (!waiting) {
      await this.reloadPreview({ retry: p.retry === true });
      return;
    }
    try {
      if (waiting.commit) await this.showBuild(waiting.project, waiting.commit);
      else await this.loadPreview({ project: waiting.project, ...(waiting.root ? { root: waiting.root } : {}) });
    } catch (error) {
      this.#live.clear();
      throw error;
    }
  }

  /**
   * The window a harness call means. It named one: that one. It named none, or the live view: the
   * stand-in wherever this build can open hidden windows (the live view otherwise), opened on
   * first use; `mirror` puts in a fresh stand-in what it last showed, else what Live shows, so a
   * look without a load sees the same game the person does. Pair with `harnessWindowDone`.
   */
  async harnessWindow(named: string | undefined, { mirror }: { mirror: boolean }): Promise<string | undefined> {
    if (named !== undefined && named !== LIVE_HANDLE) return named;
    const pool = this.pool();
    if (!pool.headless) return named;
    this.#standInUses++;
    this.#holdStandIn();
    try {
      const { opened } = await pool.standIn();
      if (opened && mirror) await this.#mirrorIntoStandIn();
    } catch (error) {
      this.harnessWindowDone(STAND_IN_HANDLE);
      throw error;
    }
    return STAND_IN_HANDLE;
  }

  /** A harness call in `handle` is over; the stand-in closes once none has come for a while. */
  harnessWindowDone(handle: string | undefined): void {
    if (handle !== STAND_IN_HANDLE) return;
    this.#standInUses = Math.max(0, this.#standInUses - 1);
    if (this.#standInUses > 0) return;
    this.#holdStandIn();
    this.#standInIdle = setTimeout(() => {
      this.#standInIdle = null;
      if (this.#standInUses === 0) void this.closeStandIn();
    }, STAND_IN_IDLE_MS);
    this.#standInIdle.unref?.();
  }

  /** Close the stand-in now; what it showed is put back in it when the harness next looks. */
  async closeStandIn(): Promise<void> {
    this.#holdStandIn();
    this.closeScreen(STAND_IN_HANDLE);
    await this.#x.previewPool?.closeStandIn();
  }

  #holdStandIn(): void {
    if (this.#standInIdle) clearTimeout(this.#standInIdle);
    this.#standInIdle = null;
  }

  /** What the stand-in last showed, else what Live shows; a folder that is gone since gives way to the next. */
  async #mirrorIntoStandIn(): Promise<void> {
    for (const shown of [this.#x.servedRoots.get(STAND_IN_HANDLE), this.#x.servedRoots.get(LIVE_HANDLE)]) {
      if (!shown) continue;
      const loaded = await this.loadPreview({
        project: shown.project,
        handle: STAND_IN_HANDLE,
        ...(shown.root ? { root: shown.root } : {}),
        ...(shown.entry ? { entry: shown.entry } : {}),
      }).then(
        () => true,
        () => false,
      );
      if (loaded) return;
    }
  }

  /**
   * Rebuild what a port last served: true when that settled the reload, false when the port
   * still shows the right folder and a plain reload is due.
   */
  async #rebuildServed(port: PreviewPort, last: ServedRoot, handle: string, retry: boolean): Promise<boolean> {
    // "Try again" on the build-failure strip. The memo answers an unchanged tree with the
    // identical three lines, and the machine is exactly what changed: the user installed
    // Node, or ran the install in Terminal, neither of which git can see. So the memo goes,
    // and the PATH is resolved from the login shell again rather than from boot.
    if (retry) {
      resetToolchain();
      this.#core.builds.forget(last.root ?? this.#core.games.dirFor(last.project));
    }
    const served = await this.servedEntry(last.project, last.root, last.entry, port, {
      fallback: handle === LIVE_HANDLE,
    });
    if (!served) return true;
    // A different folder from the one the port is showing — the stage fell back to the last
    // build that worked, or the build that had nothing to show now builds — so it is loaded
    // rather than reloaded. `port.reload()` re-loads the URL the page already has, and after
    // a failed load that is the previous game's page, or nothing at all.
    const key = servedKey(served);
    if (!served.stale && last.loaded === key) return false;
    await port.load(last.project, served.entry, served.root, { loopback: served.loopback });
    last.loaded = key;
    if (served.stale) port.note?.("error", served.stale, { loadError: true });
    return true;
  }
}

/**
 * The porcelain lines that are not a nested repository this landing is about to absorb. Such a
 * path reads modified only because the conversion has not happened yet, so counting it as the
 * user's own uncommitted work would refuse every landing that needs one.
 */
export function dirtyOutside(status: string, absorbed: string[]): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const renamedTo = line.slice(3).split(" -> ").at(-1) ?? "";
      const rel = renamedTo.replace(/^"|"$/g, "").replace(/\/$/, "");
      return !absorbed.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
    });
}

/** What a served load produced: a refusal, a note for the worker's answer, and what was waited for. */
export interface LoadedServed {
  problem: string | null;
  note: string | null;
  ready: ReadyResult | null;
}
