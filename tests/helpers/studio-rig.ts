/**
 * Headless studio rig: a real {@link StudioCore} — real event log, real sandbox, real harness
 * child process, real git snapshots — with a scripted model server and a fake preview.
 *
 * This is what lets the run loop and the self-improvement loop be tested for real without
 * Electron and without a GPU: they are harness code driven through the actual RPC boundary.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { OllamaEngine } from "../../src/substrate/engines/ollama.ts";
import {
  StudioCore,
  type PreviewPixelStats,
  type PreviewPort,
  type StudioCoreOptions,
} from "../../src/main/studio-core.ts";
import { startFakeOllama, type FakeOllama, type FakeOllamaOptions } from "./fake-ollama.ts";
import { makeResources } from "./resources.ts";
import { closeBeforeCleanup, tmpDir } from "./tmp.ts";

export { makeResources };

export interface FakePreview extends PreviewPort {
  /** What `state()` will report next; tests mutate this to simulate a better or broken build. */
  next: Record<string, unknown>;
  /** What the next capture's pixel stats claim; tests darken this to simulate a black screen. */
  pixelStatsNext: PreviewPixelStats;
  loads: string[];
  /** Last `root` passed to `load`, or null when serving the live folder. */
  loadRoot: string | null;
  /** Last `entry` passed to `load` — the page inside that root, so a wrong root is visible. */
  loadEntry: string | null;
  reloads: number;
  screenshots: number;
  consoleLines: Array<{ at: number; level: string; message: string }>;
  /** Lines the *studio* put on the game's console (`note`) — a build that failed before the page could load. */
  notes: Array<{ level: string; message: string; loadError: boolean }>;
  calls: Array<{ method: string; arg: unknown }>;
  inputs: unknown[];
  /** Demo names `preview.call {method:"demos"}` reports; unset means the game declares none. */
  demoNames?: string[];
  /** Camera names `preview.call {method:"cameras"}` reports; unset means the classic trio only. */
  cameraNames?: string[];
  /**
   * Answers for `preview.evaluate` (scene checks) keyed by a substring of the expression; a
   * miss returns `next` (the state) — exactly what a page without the v2 contract would do.
   */
  evaluations: Array<{ match: string; value: unknown }>;
  /** Extra `__studio` methods the fake game exposes (`eye`, `inspect`, `audio`, …). */
  studioMethods: Record<string, (arg: unknown) => unknown>;
  /** Every crop and diff the loop asked for, so a test can prove a vision check looked at a crop. */
  crops: Array<{ file: string; crop: unknown }>;
  diffs: Array<{ a: string; b: string }>;
  /** What the next diff reports; tests set diffFraction 0 to simulate an invisible change. */
  diffNext: { diffFraction: number; meanAbsDiff: number; grid: number[]; compared: number };
  /**
   * What a `user-view` vs canvas diff reports. Kept apart from {@link FakePreview.diffNext}:
   * that one is 0.4 so a vision check sees a real change, and an evidence pass reading 0.4 here
   * would keep a `user:view` frame and raise the mismatch warning on every rig run.
   */
  userViewDiffNext: { diffFraction: number; meanAbsDiff: number; grid: number[]; compared: number };
  /** What `preview.pageUi` reports; null means a studio that cannot see outside the canvas. */
  pageUiNext: { entries: string[]; coverage: number; canvas: unknown; viewport: unknown; uiPrimary: boolean } | null;
  pageUi?(): Promise<unknown>;
  /** The options every `screenshotWithStats` was called with, so a test can prove the surface. */
  captureOpts: Array<Record<string, unknown>>;
  /** The options every `studioState` read was given (`undefined` for a read with none). */
  stateOpts: Array<{ keep?: readonly string[] } | undefined>;
  /** Stats `statsOf` reports for reference stills; unset means the same as a capture. */
  referenceStatsNext?: PreviewPixelStats;
  /** Every pair image the loop asked for. */
  pairs: Array<{ left: number; right: number }>;
}

export function makeFakePreview(): FakePreview {
  const held = new Set<string>();
  // Each read of the step witness moves the page's own counters, the way a stepped page does.
  let witnessTicks = 0;
  const preview: FakePreview = {
    // A player that answers the harness-owned input checks the way the template does: held
    // WASD moves it on step(), an injected look turns its yaw.
    next: {
      version: 1,
      seed: 1,
      frame: 0,
      fps: 60,
      score: 0,
      phase: "playing",
      entities: {},
      player: { x: 0, y: 0, z: 0, yaw: 0 },
    },
    pixelStatsNext: { width: 800, height: 600, sampled: 480_000, meanLuma: 42, litFraction: 0.6, canvas: true },
    loads: [],
    loadRoot: null,
    loadEntry: null,
    reloads: 0,
    screenshots: 0,
    consoleLines: [],
    notes: [],
    calls: [],
    inputs: [],
    evaluations: [],
    studioMethods: {},
    crops: [],
    diffs: [],
    pairs: [],
    diffNext: { diffFraction: 0.4, meanAbsDiff: 30, grid: new Array(9).fill(0.4), compared: 1000 },
    userViewDiffNext: { diffFraction: 0.001, meanAbsDiff: 1, grid: new Array(9).fill(0.001), compared: 1000 },
    pageUiNext: null,
    captureOpts: [],
    stateOpts: [],
    async load(project, entry, root) {
      preview.loads.push(project);
      preview.loadRoot = root ?? null;
      preview.loadEntry = entry ?? null;
      return `game://${project}/${entry ?? "index.html"}`;
    },
    async reload() {
      preview.reloads++;
    },
    async screenshot() {
      preview.screenshots++;
      // A real-looking JPEG header keeps size assertions meaningful. The body carries the
      // capture counter because real frames never repeat byte-for-byte — identical bytes
      // across cameras is the evidence pass's signal for a dead debugCamera.
      const body = Buffer.alloc(8_192, 7);
      body.writeUInt32BE(preview.screenshots, 0);
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), body]);
    },
    async screenshotWithStats(quality, opts) {
      preview.captureOpts.push({ ...((opts as Record<string, unknown>) ?? {}) });
      return { jpeg: await preview.screenshot(), stats: preview.pixelStatsNext };
    },
    async pageUi() {
      return preview.pageUiNext;
    },
    async evaluate(expression) {
      const hit = preview.evaluations.find((entry) => String(expression).includes(entry.match));
      if (hit) return hit.value;
      // The studio's own two questions, answered the way a live page answers them. Without
      // these every rig load pays the 1.5 s silent grace and every evidence pass reports a
      // page that does not ride the studio's clock. A test that wants either answer different
      // pushes its own `evaluations` entry, which is looked at first.
      if (String(expression).includes("studio step witness")) {
        witnessTicks++;
        return {
          steppedFrames: witnessTicks * 8,
          drawCalls: witnessTicks * 40,
          now: witnessTicks * 320,
          canvas: true,
          simulatedMs: witnessTicks * 320,
        };
      }
      // `pageMs: null` on purpose: this fake measured no boot, so the run record keeps exactly
      // the shape it has always had (`verdict.test.ts` asserts the key set of `observed`, and
      // `readyAfterMs` only enters it when the studio really timed a page coming up).
      if (String(expression).includes("clock.boot")) {
        return {
          via: "shim",
          ready: true,
          phase: "ready",
          attached: true,
          frames: 1,
          drawCalls: 1,
          pageMs: null,
          reason: null,
          gesture: { needed: false, done: false, reasons: [] },
        };
      }
      // The template's own answers to the harness-owned screen checks: no DOM UI, one HUD quad.
      if (String(expression).includes("domUi().length === 0") || String(expression).includes("count('hud') === 1"))
        return { value: true };
      return preview.next;
    },
    async studioState(options) {
      preview.stateOpts.push(options);
      return preview.next;
    },
    async studioCall(method, arg) {
      preview.calls.push({ method, arg });
      if (method === "demos") return preview.demoNames ?? { ok: true };
      if (method === "cameras") return preview.cameraNames ?? { ok: true };
      if (method === "seed") {
        held.clear();
        preview.next = { ...preview.next, seed: arg, frame: 0, player: { x: 0, y: 0, z: 0, yaw: 0 } };
      }
      if (method === "step") {
        const player = {
          ...((preview.next.player as { x: number; y: number; z: number; yaw: number } | undefined) ?? {
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
          }),
        };
        if ([...held].some((k) => /^(w|a|s|d|key[wasd])$/i.test(k))) player.x += 1;
        preview.next = { ...preview.next, frame: Number(preview.next.frame ?? 0) + 60, player };
      }
      if (method === "start") preview.next = { ...preview.next, running: true };
      if (method === "pause") preview.next = { ...preview.next, running: false };
      if (method === "debugCamera" && preview.cameraNames && !preview.cameraNames.includes(String(arg))) {
        return { ok: false, available: preview.cameraNames };
      }
      if (["seed", "step", "start", "pause", "debugCamera", "demos", "demo", "cameras"].includes(method))
        return { ok: true };
      const extra = preview.studioMethods[method];
      return extra ? extra(arg) : { __missing: true };
    },
    async cropImage(file, crop) {
      preview.crops.push({ file, crop });
      const jpeg = await preview.screenshot();
      return { jpeg, width: 100, height: 100 };
    },
    async diffImages(a, b) {
      preview.diffs.push({ a, b });
      const answer = /user-view/.test(a) || /user-view/.test(b) ? preview.userViewDiffNext : preview.diffNext;
      return { diff: { ...answer, grid: [...answer.grid] }, heatmap: null };
    },
    // Reference stills get the fake's current stats; pairs and resizes are byte-level stand-ins.
    async statsOf(data) {
      return { stats: preview.referenceStatsNext ?? preview.pixelStatsNext, width: 800, height: 600 };
    },
    async resizeImage(data) {
      return data;
    },
    async pairImages(left, right) {
      preview.pairs.push({ left: left.length, right: right.length });
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), left.subarray(0, 64), right.subarray(0, 64)]);
    },
    async input(actions) {
      preview.inputs.push(...(actions ?? []));
      for (const action of (actions ?? []) as Array<{ type: string; keys?: string[]; dx?: number }>) {
        if (action.type === "down") for (const key of action.keys ?? []) held.add(key);
        if (action.type === "up") for (const key of action.keys ?? []) held.delete(key);
        if (action.type === "look") {
          const player = {
            ...((preview.next.player as { x: number; y: number; z: number; yaw: number } | undefined) ?? {
              x: 0,
              y: 0,
              z: 0,
              yaw: 0,
            }),
          };
          player.yaw += (Number(action.dx) || 0) * 0.01;
          preview.next = { ...preview.next, player };
        }
      }
      return { ok: true, applied: actions?.length ?? 0, width: 800, height: 600 };
    },
    // Kept apart from `consoleLines` and `next.__loadError`, which in this rig say what the
    // *game* did: a note the studio wrote must not be counted as the game's own error by an
    // evidence pass. What a caller can assert here is that the studio said it at all.
    note(level, message, options) {
      preview.notes.push({ level, message, loadError: options?.loadError === true });
    },
    consoleEntries() {
      return preview.consoleLines;
    },
    async gpuErrors() {
      return [];
    },
    status() {
      return {
        project: preview.loads.at(-1) ?? null,
        url: null,
        crashed: false,
        unresponsive: false,
        loadError: (preview.next.__loadError as string) ?? null,
        consoleErrors: preview.consoleLines.filter((entry) => entry.level === "error").length,
      };
    },
  };
  return preview;
}

export interface Rig {
  core: StudioCore;
  preview: FakePreview;
  server: FakeOllama;
  userData: string;
  events: Array<{ type: string; payload: unknown }>;
  logs: string[];
  stop: () => Promise<void>;
}

export async function startRig(
  options: FakeOllamaOptions = {},
  core: Partial<
    Pick<
      StudioCoreOptions,
      | "previewPoolMax"
      | "createHeadlessPreview"
      | "sandbox"
      | "consentTimeoutMs"
      | "rewindBuildStop"
      | "jobSpawn"
      | "jobProbe"
    >
  > = {},
): Promise<Rig> {
  const resources = await makeResources();
  // Real, not /var/folders behind the /private link: the studio sends a contractor to the real
  // path of the worktree it checked (M1), exactly as it does under ~/Library in the app.
  const userData = path.join(await realpath(await tmpDir("studio-rig-")), "userData");
  // The rig declares configured capacity; /api/show alone only reports a theoretical maximum.
  const server = await startFakeOllama({
    loaded: [{ name: "qwen3.6:27b", context_length: 262144 }],
    ...options,
  });
  const preview = makeFakePreview();
  const events: Array<{ type: string; payload: unknown }> = [];
  const logs: string[] = [];

  const studio = new StudioCore({
    paths: { userData, resources },
    preview,
    execPath: process.execPath,
    ollamaHost: server.host,
    // Select the scripted local provider before start; tests never probe ambient accounts.
    engines: [new OllamaEngine({ host: server.host })],
    onUiEvent: (event) => events.push(event),
    onLog: (line) => logs.push(line),
    // Opt-in for a machine whose Linux sandbox cannot start (a container without user
    // namespaces): the rig runs the harness unsandboxed, so containment cases prove nothing there.
    ...(process.env.STUDIO_RIG_UNSANDBOXED === "1" ? { sandbox: false } : {}),
    ...core,
  });
  try {
    await studio.init();
    await studio.start();
  } catch (error) {
    await studio.stop().catch(() => {});
    await server.close();
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await studio.stop();
    await server.close();
  };
  // Before the temp directories go, not after: the rig's userData lives in one of them.
  closeBeforeCleanup(stop);

  return { core: studio, preview, server, userData, events, logs, stop };
}

/**
 * Wait until a predicate over the studio's whole log holds, or fail loudly. The whole log,
 * because work lands in the thread it belongs to — runs and builds in their game's thread,
 * studio business in the studio thread — and a test should see the story wherever it happened.
 */
export async function waitForLog(
  core: StudioCore,
  predicate: (events: Awaited<ReturnType<StudioCore["store"]["listEvents"]>>) => boolean,
  timeoutMs = 60_000,
  label = "condition",
): Promise<Awaited<ReturnType<StudioCore["store"]["listEvents"]>>> {
  const deadline = Date.now() + timeoutMs;
  let events = await core.listAllEvents();
  while (Date.now() < deadline) {
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 150));
    events = await core.listAllEvents();
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function customEvents(
  events: Awaited<ReturnType<StudioCore["store"]["listEvents"]>>,
  eventType: string,
): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.data.type === "custom" && event.data.event_type === eventType)
    .map((event) => (event.data as { payload: Record<string, unknown> }).payload ?? {});
}
