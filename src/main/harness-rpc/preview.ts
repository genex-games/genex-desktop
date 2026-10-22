/** Harness RPC: previews — load, look, drive and measure a game in a window. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BuildTarget,
  GameStack,
  isBuildTarget,
  isGameStack,
  MOBILE_TARGETS,
  stackOf,
} from "../../shared/game-project.ts";
import { hostOf } from "../../shared/game-targets.ts";
import {
  type FrameProfileAnswer,
  ProfileUnavailableReason,
  parseFrameProfileRequest,
  profileUnavailable,
} from "../../shared/frame-profile.ts";
import {
  type CameraPoseResult,
  type EmptySceneResult,
  HostMethod,
  type HarnessHostHandlers,
  type HarnessParams,
  type WitnessResult,
} from "../../shared/harness-api.ts";
import {
  NATIVE_LEASES_MAX,
  NativeError,
  NativeInputKind,
  NativeOp,
  NativeRefusal,
  NativeRunMode,
  parseNativeInput,
} from "../../shared/native-contract.ts";
import type { PreviewInputAction, PreviewTouchAction } from "../../shared/preview-contract.ts";
import { keepPathsOf } from "../../shared/studio-state-shape.ts";
import { availableMemory } from "../../substrate/hardware.ts";
import type { CaptureSurface, PreviewPort } from "../../substrate/preview-port.ts";
import { touchPort } from "../../substrate/native-game-port.ts";
import { previewFrameProfile } from "../../substrate/native-profile.ts";
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
import { hostRefusal } from "../core/native-prepare.ts";
import { keptPreRustNotice } from "../seed-upgrade-notice.ts";
import { seedNightRefusal } from "../../substrate/seed-upgrade.ts";

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
  badFrameProfile: "preview.frameProfile: frames must be 1..240 and mode a GPU timing mode",
  otherPreviewsActive: "other studio previews are active",
  pairNeedsTwoImages: "preview.pair needs two images",
  harnessRestarted: "the harness that asked for this preview window has restarted",
  invalidTarget: (target: string) => `preview.acquire: "${target}" is not a destination`,
  deviceLease: (target: string) =>
    `preview.acquire: the ${target} destination runs only on a device or simulator a person starts from Studio, never in an agent's lease`,
  invalidStacks: (stacks: string) => `preview.acquire: stacks must list stacks the studio knows, not ${stacks}`,
  harnessPredatesNative: (project: string) =>
    `"${project}" is a C++ game, and this preview was borrowed without naming the build it judges: this harness predates native support`,
  harnessPredatesStack: (project: string, stack: string) =>
    `"${project}" is a ${stack} game, and this preview was borrowed by a harness that does not say it serves ${stack} games: this harness predates them`,
  noFrameCounter: "the game's state() reports no frame counter, so a step cannot be witnessed",
  noStep: "the game's step answers no frame counter: only a C++ · raylib game's studio contract can be witnessed",
  touchNotTaken: "preview.input: this preview takes no touch: only a Rust · wgpu game's native run or web page does",
  touchInvalid: "preview.input: a touch outside its shape (a finite x and y, a uint32 id, a phase)",
} as const;

/** `preview.input`'s actions, a play script's `touch` among them. */
type InputList = ReadonlyArray<PreviewInputAction | PreviewTouchAction>;

/** The actions as a page takes them, or null when one is a touch. */
function touchless(actions: InputList): PreviewInputAction[] | null {
  const plain: PreviewInputAction[] = [];
  for (const action of actions) {
    if (action.type === NativeInputKind.Touch) return null;
    plain.push(action);
  }
  return plain;
}

/** What `preview.input` answers: whether it was applied, how many actions, and the surface's size. */
type InputAnswer = { ok: boolean; applied: number; width: number; height: number };

/**
 * `preview.input` on one port. A call that holds a touch reaches a native run (its `input` op; a
 * protocol 1 game refuses it there) or, when `pageTakesTouch` (a Rust · wgpu web build, whose page
 * `input` verb takes the op's whole argument), that page's `input` verb. Any other preview refuses
 * the whole call `touch-not-taken` before any action is applied, never applied in part.
 */
export async function routePreviewInput(
  port: PreviewPort,
  actions: InputList,
  options: { pageTakesTouch?: boolean } = {},
): Promise<InputAnswer> {
  const plain = touchless(actions);
  if (plain) return port.input(plain);
  const native = touchPort(port);
  if (native) return native.input(actions);
  if (!options.pageTakesTouch) throw new NativeError(NativeRefusal.TouchNotTaken, MESSAGE.touchNotTaken);
  return pageTouch(port, actions);
}

/**
 * A call with a touch through a Rust web page's `input` verb (`{actions}`, as the native op takes
 * it): checked first, then refused `touch-not-taken` unless the page answered its input (`held`).
 */
async function pageTouch(port: PreviewPort, actions: InputList): Promise<InputAnswer> {
  const checked = parseNativeInput(actions);
  if (!checked) throw new Error(MESSAGE.touchInvalid);
  const answer = await port.studioCall(NativeOp.Input, { actions: checked });
  if (!isRecord(answer) || !Array.isArray(answer.held))
    throw new NativeError(NativeRefusal.TouchNotTaken, MESSAGE.touchNotTaken);
  return { ok: true, applied: checked.length, width: 0, height: 0 };
}

/** Whether `port` shows a Rust · wgpu game's web build: the one page whose `input` verb takes touches. */
async function servesRustPage(core: StudioCore, port: PreviewPort): Promise<boolean> {
  if (touchPort(port)) return false;
  const project = port.status().project;
  if (!project) return false;
  const game = (await core.games.list().catch(() => [])).find((listed) => listed.name === project);
  return game ? stackOf(game.shape) === GameStack.RustWgpu : false;
}

/** How long `preview.witness` steps a game when the call names no `ms`: the evidence pass's own proof step. */
export const WITNESS_DEFAULT_MS = 320;

/** A port's studio contract, as the typed probes read it: `state()` and its verbs, never JavaScript. */
type ProbePort = Pick<PreviewPort, "studioState" | "studioCall">;

/** The draw count of each port's last witnessed step: what `preview.emptyScene` reads when `state()` carries none. */
const LAST_STEP_DRAWS = new WeakMap<ProbePort, number>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A step answer with the C++ runtime's counters (`{frame, simulatedMs, steppedFrames, drawCalls}`). */
function isStepAnswer(value: unknown): value is { frame: number; simulatedMs: number; drawCalls: number } {
  return (
    isRecord(value) &&
    Number.isFinite(value.frame) &&
    Number.isFinite(value.simulatedMs) &&
    Number.isFinite(value.drawCalls)
  );
}

/**
 * `preview.witness`: the game's frame counter, one step of `ms` simulated time, and what the step
 * answered. A native run and the C++ web build answer it through their studio contract; a page whose
 * `state()` or `step` carries no frame counter is refused `unsupported` (the gate's unmeasured).
 */
export async function witnessOf(port: ProbePort, ms: number = WITNESS_DEFAULT_MS): Promise<WitnessResult> {
  const before = await port.studioState();
  const frameBefore = isRecord(before) ? before.frame : undefined;
  if (typeof frameBefore !== "number" || !Number.isFinite(frameBefore)) {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.noFrameCounter);
  }
  const stepped = await port.studioCall(NativeOp.Step, ms);
  if (!isStepAnswer(stepped)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.noStep);
  LAST_STEP_DRAWS.set(port, stepped.drawCalls);
  return { frameBefore, frameAfter: stepped.frame, simulatedMs: stepped.simulatedMs, drawCalls: stepped.drawCalls };
}

/**
 * `preview.emptyScene`: measured exactly when the game's `state().phase` is a string; its draws
 * are `state().__render.drawCalls` when numeric, else the last witnessed step's.
 */
export async function emptySceneOf(port: ProbePort): Promise<EmptySceneResult> {
  const state = await port.studioState();
  const phase = isRecord(state) && typeof state.phase === "string" ? state.phase : null;
  const render = isRecord(state) && isRecord(state.__render) ? state.__render.drawCalls : undefined;
  const drawCalls =
    typeof render === "number" && Number.isFinite(render) ? render : (LAST_STEP_DRAWS.get(port) ?? null);
  return { measured: phase !== null, phase, drawCalls };
}

/**
 * `preview.cameraPose`: measured exactly when the game's `state().camera` exists. The camera's
 * name is the string it reports (or its `name`); the pose is the camera object it reports, else
 * its `cameraPose`, as untrusted JSON.
 */
export async function cameraPoseOf(port: ProbePort): Promise<CameraPoseResult> {
  const state = await port.studioState();
  if (!isRecord(state) || state.camera === undefined) return { measured: false, camera: null, pose: null };
  const reported = state.camera;
  const named = isRecord(reported) ? reported.name : reported;
  const camera = typeof named === "string" ? named : null;
  return { measured: true, camera, pose: isRecord(reported) ? reported : (state.cameraPose ?? null) };
}

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
    // The harness's own loop writes the judge's rubric itself: an engine judge's brief opens its first answer.
    computerTools: (grant, root, outDir, session) =>
      core._computerToolsFor(grant, root, outDir, session, { judgeBrief: true }),
    runOfGame: (project, runId) => core._runOfGame(project, runId),
  });
  COMPUTERS.set(x, made);
  return made;
}

/**
 * Forget the computers on windows a harness that ended had leased, stopping what each started (a
 * Play Protocol game's process, an editor's play): its own `preview.release` never comes.
 */
export async function forgetHarnessComputers(x: CoreInternals, handles: readonly string[]): Promise<void> {
  const computers = COMPUTERS.get(x);
  if (!computers) return;
  await Promise.all(handles.map((handle) => computers.forget(handle).catch(() => {})));
}

/** A still named by its bytes or by a path the previews may read. */
type StillSource = { base64?: string; path?: string } | null | undefined;

/** A method run in the window the harness means (`inHarnessWindow`). */
function routedIn(x: CoreInternals) {
  return <P extends { handle?: string }, R>(fn: (p: P) => Promise<R>) =>
    (p: P): Promise<R> =>
      inHarnessWindow(x, p?.handle, { mirror: true }, (handle) => fn(withHandle(p, handle)));
}

/** The typed probes a native run answers over `state()` and `step`, routed by handle like the rest. */
function typedProbes(x: CoreInternals) {
  const routed = routedIn(x);
  return {
    [HostMethod.PreviewWitness]: routed(async (p: HarnessParams<typeof HostMethod.PreviewWitness>) =>
      witnessOf(x.previews.preview(p?.handle), p?.ms ?? WITNESS_DEFAULT_MS),
    ),
    [HostMethod.PreviewEmptyScene]: routed(async (p: HarnessParams<typeof HostMethod.PreviewEmptyScene>) =>
      emptySceneOf(x.previews.preview(p?.handle)),
    ),
    [HostMethod.PreviewCameraPose]: routed(async (p: HarnessParams<typeof HostMethod.PreviewCameraPose>) =>
      cameraPoseOf(x.previews.preview(p?.handle)),
    ),
  } satisfies Partial<HarnessHostHandlers>;
}

/** `preview.input` on the call's port: a touch reaches a native run or a Rust web build's `input` verb. */
async function previewInput(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewInput>) {
  const port = x.previews.preview(p?.handle);
  const actions = Array.isArray(p?.actions) ? p.actions : [];
  const pageTakesTouch = touchless(actions) === null && (await servesRustPage(core, port));
  return routePreviewInput(port, actions, { pageTakesTouch });
}

export function previewRpc(core: StudioCore, x: CoreInternals) {
  const routed = routedIn(x);
  return {
    // — preview (the senses) — every method takes an optional `handle`. Omitted (or the live
    // view) means the stand-in wherever this build has hidden windows: the live view is the
    // person's, and only their own action changes it. A load or reload there offers Live the
    // change instead (`PreviewService.offerLive`), and the stage's Reload applies it.
    [HostMethod.PreviewLoad]: async (p) =>
      inHarnessWindow(x, p?.handle, { mirror: false }, async (handle) => {
        await refuseUntargetedNative(core, x, p.project, handle);
        const url = await x.previews.loadPreview(withHandle(p, handle));
        await offerStandIn(x, handle);
        return url;
      }),
    [HostMethod.PreviewProfile]: async (p) => profile(core, x, p),
    [HostMethod.PreviewFrameProfile]: async (p) => frameProfile(x, p),
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
      previewInput(core, x, p),
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
    [HostMethod.PreviewAcquire]: async (p) => acquire(core, x, p),
    [HostMethod.PreviewRelease]: async (p) => {
      x.profileSources.delete(p.handle);
      forgetStacks(x, p.handle);
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
    ...typedProbes(x),
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
    // The stage's own window is one lease; any other (a window, or a native game running) skews the sample.
    const pool = x.previews.pool();
    if (pool.leaseCount + pool.nativeLeaseCount > 1) return { sessionId: null, reason: MESSAGE.otherPreviewsActive };
  }
  return port.profile(p);
}

/**
 * `preview.frameProfile`: the frame profile of the game a lease holds, by its handle alone (a native
 * run's `profile` op, a Rust web page's `__studio.profile`), never the person's live view; `no-run`
 * for a handle that names no lease.
 */
async function frameProfile(
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.PreviewFrameProfile>,
): Promise<FrameProfileAnswer> {
  const pool = x.previewPool;
  if (!pool?.leaseOf(p.handle)) return profileUnavailable(ProfileUnavailableReason.NoRun);
  const request = parseFrameProfileRequest(p);
  if (!request) throw new Error(MESSAGE.badFrameProfile);
  return previewFrameProfile(pool.port(p.handle), request);
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
  // A native capture's provenance (seq, digest, camera, run, build) is saved beside its frame, so a
  // saved picture is never shown as a build it is not.
  if (p?.runId && shot.provenance) {
    await core.saveRunArtifact(p.runId, `${label}.provenance.json`, Buffer.from(JSON.stringify(shot.provenance)));
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

/**
 * Whether this host has a game box for its own OS for an agent's headless run: what a native lease
 * and a judging target need. A box that opens only Play windows offers neither.
 */
function gameBoxOf(core: StudioCore): boolean {
  return core.sandbox?.gameBoxAvailable(NativeRunMode.Headless) === true;
}

/**
 * Why this host refuses a native lease for `target`, or null: a refusal for want of a game box
 * carries the box's own reason for an agent's headless run (`no-headless-build` on Windows and Linux).
 */
function leaseRefusal(core: StudioCore, target: BuildTarget): NativeError | null {
  const refused = hostRefusal(hostOf(process.platform), target, gameBoxOf(core));
  if (refused?.refusal !== NativeRefusal.NoGameBox) return refused;
  return new NativeError(refused.refusal, refused.message, null, core.sandbox?.gameBox(NativeRunMode.Headless) ?? null);
}

/**
 * The build a lease names: absent, or a host-native or web destination. A phone destination is
 * refused `not-runnable-here` (containment stage 1: no agent-driven device run), anything else as
 * no destination, before any lease exists.
 */
function acquireTarget(p: HarnessParams<typeof HostMethod.PreviewAcquire> | null | undefined): BuildTarget | undefined {
  const raw: unknown = p?.target;
  if (raw === undefined) return undefined;
  const phone = MOBILE_TARGETS.find((target) => target === raw);
  if (phone) throw new NativeError(NativeRefusal.NotRunnableHere, MESSAGE.deviceLease(phone));
  if (!isBuildTarget(raw)) throw new Error(MESSAGE.invalidTarget(String(raw)));
  return raw;
}

/** The stacks a lease's harness declared it serves (`preview.acquire {stacks}`), by lease handle, per core. */
const DECLARED_STACKS = new WeakMap<CoreInternals, Map<string, readonly GameStack[]>>();

/** The stacks the lease `handle` declared; none for a lease whose harness declared none. */
function declaredStacks(x: CoreInternals, handle: string): readonly GameStack[] {
  return DECLARED_STACKS.get(x)?.get(handle) ?? [];
}

/** Remember what the lease `handle` declared; a lease that declared nothing is remembered as nothing. */
function declareStacks(x: CoreInternals, handle: string, stacks: readonly GameStack[] | undefined): void {
  const declared = DECLARED_STACKS.get(x) ?? new Map<string, readonly GameStack[]>();
  DECLARED_STACKS.set(x, declared);
  if (stacks) declared.set(handle, stacks);
}

/** Forget what a released lease declared. */
function forgetStacks(x: CoreInternals, handle: string): void {
  DECLARED_STACKS.get(x)?.delete(handle);
}

/** The stacks a lease declares: absent (a harness from before Rust), or a list of known stacks; anything else is refused before any lease exists. */
function acquireStacks(
  p: HarnessParams<typeof HostMethod.PreviewAcquire> | null | undefined,
): readonly GameStack[] | undefined {
  const raw: unknown = p?.stacks;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every(isGameStack)) throw new Error(MESSAGE.invalidStacks(JSON.stringify(raw)));
  return Object.freeze([...raw]);
}

/**
 * Stacks a harness serves only once it says so: a Rust game reaches a lease only from a harness
 * that declared `rust-wgpu`. Raylib's backstop is the lease's target, as it always was.
 */
const DECLARED_STACK_ONLY: ReadonlySet<GameStack> = new Set([GameStack.RustWgpu]);

/**
 * The §2.10 backstop: a lease borrowed without a target, loading a C++ game, is a harness from
 * before native support (every fresh caller names one); a lease whose harness did not declare a
 * Rust game's stack is a harness from before Rust; and a Rust game's lease, declared or not, on a
 * harness workspace that kept a part a Rust night runs from before Rust (`seedNightRefusal`), is
 * refused naming those modules. All refused typed, before anything builds.
 */
async function refuseUntargetedNative(
  core: StudioCore,
  x: CoreInternals,
  project: string,
  handle: string | undefined,
): Promise<void> {
  if (handle === undefined || handle === LIVE_HANDLE || handle === STAND_IN_HANDLE) return;
  const lease = x.previewPool?.leaseOf(handle);
  if (!lease) return;
  const declared = declaredStacks(x, handle);
  const game = (await core.games.list().catch(() => [])).find((listed) => listed.name === project);
  if (!game) return;
  const stack = stackOf(game.shape);
  if (stack === GameStack.RaylibCpp && lease.target === null) {
    throw new NativeError(NativeRefusal.HarnessPredatesNative, MESSAGE.harnessPredatesNative(project));
  }
  await refuseKeptPreRust(core, stack);
  if (DECLARED_STACK_ONLY.has(stack) && !declared.includes(stack)) {
    throw new NativeError(NativeRefusal.HarnessPredatesNative, MESSAGE.harnessPredatesStack(project, stack));
  }
}

/**
 * A night on `stack` refused by the harness workspace (seed-upgrade.ts `seedNightRefusal`): a Rust
 * night whose parts the agent kept from before Rust is never routed to the three.js rows, and the
 * refusal names each kept module (the notice M3.7 shows with its re-take remedy).
 */
async function refuseKeptPreRust(core: StudioCore, stack: GameStack): Promise<void> {
  const dirs = {
    seedDir: path.join(core.options.paths.resources, "harness-seed"),
    workspaceDir: core.layout.harnessWs,
  };
  const notice = keptPreRustNotice(await seedNightRefusal(stack, dirs));
  if (notice) throw new NativeError(NativeRefusal.HarnessPredatesNative, notice.text);
}

async function acquire(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewAcquire>) {
  const target = acquireTarget(p);
  const stacks = acquireStacks(p);
  const native = target !== undefined && target !== BuildTarget.Web;
  const refused = native ? leaseRefusal(core, target) : null;
  if (refused) throw refused;
  const boot = x.harnessBoot;
  const lease = await x.previews.pool().acquire({
    label: p?.label ?? "facet",
    purpose: p?.purpose === OPTIMIZATION_PURPOSE ? OPTIMIZATION_PURPOSE : undefined,
    owner: `harness:${boot}`,
    ...(target ? { target } : {}),
  });
  // The harness that asked died while the window was opening: nobody is left to release it.
  if (boot !== x.harnessBoot) {
    await x.previewPool?.release(lease.handle);
    throw new Error(MESSAGE.harnessRestarted);
  }
  declareStacks(x, lease.handle, stacks);
  return { handle: lease.handle };
}

async function capacity(core: StudioCore, x: CoreInternals) {
  // Memory rides along: six windows of a big game is not a number the pool
  // knows; whoever starts workers reads the free memory beside the free slots.
  const memory = await availableMemory();
  // The host and its game box pick a C++ game's judging target; native leases have their own budget.
  const host = hostOf(process.platform);
  const gameBox = gameBoxOf(core);
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
      host,
      native: { gameBox: gameBox && pool.native, leases: pool.nativeLeaseCount, max: NATIVE_LEASES_MAX },
      workers,
    };
  } catch {
    const native = { gameBox: false, leases: 0, max: NATIVE_LEASES_MAX };
    return { max: 0, inUse: 0, free: 0, live: false, headless: false, memory, host, native, workers };
  }
}
