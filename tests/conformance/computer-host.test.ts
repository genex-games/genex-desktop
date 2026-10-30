/**
 * The computer tool's host through the real core over the fake preview: a builder's
 * delegation carries `computer` beside `capture`; both load the workspace through the served
 * entry (a game with its own build is built first, or every worker frame shows `src/main.ts`
 * served as text); the window stays loaded between actions; every
 * action updates the coalesced agent screen.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { PreviewService } from "../../src/main/core/previews.ts";
import { unservedPreviews, type CoreInternals } from "../../src/main/core/internals.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { READY_PROBE, awaitReady, readySnapshot, type ReadySnapshot } from "../../src/substrate/preview-ready.ts";
import { customEvents, makeFakePreview, startRig, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

async function builtFolder(): Promise<string> {
  const dir = path.join(await tmpDir("studio-computer-"), "skate");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), '<!doctype html><script type="module" src="/src/main.ts"></script>');
  await writeFile(path.join(dir, "src", "main.ts"), "export {};\n");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "skate",
      type: "module",
      scripts: { build: "mkdir -p dist && cp index.html dist/index.html" },
    }),
  );
  await writeFile(
    path.join(dir, "studio.json"),
    JSON.stringify({
      name: "skate",
      title: "skate",
      createdAt: "",
      contractVersion: 1,
      entry: "dist/index.html",
      main: "src/main.ts",
      build: "mkdir -p dist && cp index.html dist/index.html",
    }),
  );
  return dir;
}

function fakeEngine(rig: Rig, id: string, delegate: (request: DelegateRequest) => Promise<DelegateResult>): void {
  rig.core.engines.register({
    id,
    label: id,
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: id,
      stopReason: "stop",
    }),
    delegate,
  } as never);
}

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** The probe, run against a hand-made `window` — the branch it takes is the whole point of it. */
function probe(win: Record<string, unknown>): ReadySnapshot {
  return new Function("window", `return ${READY_PROBE};`)(win) as ReadySnapshot;
}

/** One boot answer from a page that carries the shim. */
function booting(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    via: "shim",
    ready: false,
    phase: "boot",
    attached: false,
    frames: 0,
    drawCalls: 0,
    pageMs: null,
    reason: null,
    gesture: { needed: false, done: false, reasons: [] },
    ...extra,
  };
}

/**
 * A port with scripted answers and an injected clock: `awaitReady` is pure over a PreviewPort,
 * so a run's worth of waiting costs a test nothing.
 */
function scriptedPort(answers: Array<unknown>, options: { loadError?: string | null; crashed?: boolean } = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const inputs: unknown[][] = [];
  const asked: number[] = [];
  let index = 0;
  const port = {
    async load() {
      return "game://x/index.html";
    },
    async reload() {},
    async screenshot() {
      return Buffer.alloc(0);
    },
    async evaluate() {
      asked.push(clock);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    },
    async studioState() {
      return {};
    },
    async studioCall() {
      return { ok: true };
    },
    async input(actions: unknown[]) {
      inputs.push(actions);
      return { ok: true, applied: actions.length, width: 960, height: 600 };
    },
    consoleEntries() {
      return [];
    },
    status() {
      return {
        project: "x",
        url: "game://x/index.html",
        crashed: options.crashed === true,
        unresponsive: false,
        loadError: options.loadError ?? null,
        consoleErrors: 0,
      };
    },
  } as unknown as PreviewPort;
  return {
    port,
    inputs,
    sleeps,
    asked,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
}

describe("booted means booted", () => {
  it("reads the shim's snapshot, and never asks the game", () => {
    // The shim answers first, and it is the only signal that measures the PAGE's own boot.
    const shim = probe({
      __studioClock: {
        boot: () => ({
          ready: true,
          phase: "ready",
          attached: true,
          since: 1_400,
          at: 1_200,
          frames: 90,
          drawCalls: 42,
          gesture: { needed: false, done: true, reasons: [] },
        }),
      },
    });
    assert.equal(shim.via, "shim");
    assert.equal(shim.ready, true);
    assert.equal(shim.pageMs, 1_200);
    assert.equal(shim.attached, true);
    // `window.__studioReady` stays a PROMISE and nothing reads fields off it, and a boot() that
    // hands back a thenable is rejected as a snapshot source.
    const promised = probe({ __studioReady: Promise.resolve({ ready: true }) });
    assert.equal(promised.via, "none");
    const thenable = probe({ __studioClock: { boot: () => Promise.resolve({ ready: true }) } });
    assert.equal(thenable.via, "none");
    // Flipped from a "contract" fallback: the game's own window.__studio is never read.
    const game = probe({ __studio: { state: () => ({ frame: 3 }) } });
    assert.equal(game.via, "none");
    assert.equal(game.ready, false);
    assert.equal(probe({}).via, "none");
  });

  it("polls immediately, gives up at the budget, and never throws at a page that is going away", async () => {
    // An already-up page costs nothing where it used to cost a flat 1.5 s.
    const up = scriptedPort([booting({ ready: true, phase: "ready", pageMs: 120 })]);
    const first = await awaitReady(up.port, { timeoutMs: 2_000, now: up.now, sleep: up.sleep });
    assert.equal(first.ready, true);
    assert.equal(first.polls, 1);
    assert.equal(first.ms, 0);
    assert.equal(first.pageMs, 120);
    assert.equal(up.sleeps.length, 0, "an up page is not slept on");
    // A page that comes up on the fourth ask says so.
    const slow = scriptedPort([booting(), booting(), booting(), booting({ ready: true, phase: "ready" })]);
    const fourth = await awaitReady(slow.port, { timeoutMs: 2_000, now: slow.now, sleep: slow.sleep });
    assert.equal(fourth.ready, true);
    assert.equal(fourth.polls, 4);
    assert.equal(fourth.ms, 300);
    // A load error is the port's answer, not something to wait out.
    const broken = scriptedPort([booting()], { loadError: "SyntaxError: unexpected token" });
    const failed = await awaitReady(broken.port, { timeoutMs: 2_000, now: broken.now, sleep: broken.sleep });
    assert.equal(failed.ready, false);
    assert.equal(failed.timedOut, false);
    assert.equal(failed.polls, 0);
    assert.equal(failed.reason, "SyntaxError: unexpected token");
    // A page that reports itself booting for ever times out at exactly the budget.
    const never = scriptedPort([booting()]);
    const out = await awaitReady(never.port, { timeoutMs: 2_000, now: never.now, sleep: never.sleep });
    assert.equal(out.timedOut, true);
    assert.equal(out.ms, 2_000);
    assert.equal(out.via, "shim");
    // A page that says it failed is a build defect, reported the moment it says so.
    const dead = scriptedPort([booting({ phase: "failed", reason: "the game's boot threw: THREE is not defined" })]);
    const stopped = await awaitReady(dead.port, { timeoutMs: 2_000, now: dead.now, sleep: dead.sleep });
    assert.equal(stopped.timedOut, false);
    assert.equal(stopped.phase, "failed");
    assert.match(stopped.reason!, /THREE is not defined/);
    // `evaluate` rejects in two entirely ordinary ways while a page boots — a navigating frame
    // and a disposed one. Neither may throw out of here: #loadServed's callers skip the setup,
    // the screen and the first frame on a failure, and that would blind every worker.
    const gone = scriptedPort([
      () => {
        throw new Error("Script failed to execute");
      },
    ]);
    const snapshot = await readySnapshot(gone.port);
    assert.equal(snapshot.via, "none");
    assert.equal(snapshot.ready, false);
    const silent = await awaitReady(gone.port, { timeoutMs: 20_000, now: gone.now, sleep: gone.sleep });
    assert.equal(silent.via, "none");
    assert.equal(silent.timedOut, false);
    assert.equal(silent.ms, 1_500, "a page with no readiness signal gets the old blind wait and no more");
  });

  it("knocks once, and only on a page that says it is waiting for a gesture", async () => {
    const blocked = scriptedPort([
      booting({ gesture: { needed: true, done: false, reasons: ["the title screen waits for a click"] } }),
    ]);
    const result = await awaitReady(blocked.port, { timeoutMs: 4_000, now: blocked.now, sleep: blocked.sleep });
    assert.equal(blocked.inputs.length, 1, "exactly one knock");
    const actions = blocked.inputs[0] as Array<{ type: string }>;
    assert.deepEqual(
      actions.map((a) => a.type),
      ["move", "click"],
    );
    assert.equal(result.gesture.needed, true);
    assert.equal(result.gesture.done, true);
    assert.deepEqual(result.gesture.reasons, ["the title screen waits for a click"]);
    assert.equal(result.timedOut, true);
    // A page that never asks is never clicked into: the knock is a real click in a real game.
    const quiet = scriptedPort([booting()]);
    await awaitReady(quiet.port, { timeoutMs: 4_000, now: quiet.now, sleep: quiet.sleep });
    assert.equal(quiet.inputs.length, 0);
    // …and a caller that forbids it is obeyed.
    const forbidden = scriptedPort([booting({ gesture: { needed: true, done: false, reasons: [] } })]);
    await awaitReady(forbidden.port, { timeoutMs: 4_000, gesture: false, now: forbidden.now, sleep: forbidden.sleep });
    assert.equal(forbidden.inputs.length, 0);
  });
});

describe("the computer tool's host", () => {
  it("parallel initial state and console requests share one preview navigation", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = await rig.core.adoptProject(await builtFolder());
    const load = rig.preview.load.bind(rig.preview);
    let loads = 0;
    rig.preview.load = async (...args) => {
      loads++;
      return load(...args);
    };
    fakeEngine(rig, "codex", async (request) => {
      const results = await Promise.all(
        ["state", "console"].map((action) => request.onLiveTool!("computer", { action })),
      );
      assert.equal(results.length, 2);
      assert.equal(loads, 1, "concurrent inspection must not reload or abort the same window");
      return { ok: true, engine: "codex", turns: 1, usage: {}, summary: "observed" };
    });
    await (rig.core.api()["engine.delegate"] as Function)({
      engine: "codex",
      project: project.name,
      prompt: "fixture",
      selfCapture: { project: project.name, root: project.dir },
    });
  });

  it("gives a builder hands over its own build, loaded through the served entry, and shows the screen", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = await rig.core.adoptProject(await builtFolder());
    const dir = project.dir;
    assert.equal(project.built, true);
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    let seen: DelegateRequest | null = null;
    const answers: Record<string, LiveToolResult> = {};
    rig.preview.next = {
      version: 1,
      frame: 0,
      phase: "playing",
      maps: { activeId: "street" },
      player: { x: 0, y: 0, z: 0, yaw: 0 },
    };
    fakeEngine(rig, "codex", async (request) => {
      seen = request;
      assert.ok(
        request.liveTools?.some((t) => t.name === "computer"),
        "the builder has the computer tool",
      );
      assert.ok(request.onCapture, "and capture");
      assert.notEqual(request.readOnly, true, "a builder is not read-only");
      answers.shot = await request.onLiveTool!("computer", { action: "screenshot" });
      answers.state = await request.onLiveTool!("computer", { action: "state" });
      answers.key = await request.onLiveTool!("computer", { action: "key", text: "i" });
      answers.click = await request.onLiveTool!("computer", { action: "left_click", coordinate: "480,300" });
      answers.bad = await request.onLiveTool!("computer", { action: "fly" });
      answers.capture = await request.onCapture!({ cameras: "default" });
      answers.after = await request.onLiveTool!("computer", { action: "cursor_position" });
      return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "s1", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "build",
      project: project.name,
      selfCapture: { project: project.name, root: dir, runId: "run_c", facetId: "plaza", iteration: 1, label: "Plaza" },
    });
    assert.ok(seen);
    // Loaded through the served entry: the build ran and its output folder was served — in the
    // studio's own shadow, so the folder the user owns keeps whatever dist/ they built there.
    assert.ok(rig.preview.loadRoot?.includes(path.join("scratch", "builds")), rig.preview.loadRoot ?? "no root");
    assert.ok(await stat(path.join(rig.preview.loadRoot!, "index.html")), "the build ran before the window loaded");
    assert.equal(await stat(path.join(dir, "dist")).catch(() => null), null, "and not inside the game folder");
    const shot = answers.shot as { text: string; images?: Array<{ mimeType: string }> };
    assert.match(shot.text, /s1_screen\.jpg/);
    assert.equal(shot.images?.[0]?.mimeType, "image/jpeg", "a screenshot comes back as a picture");
    assert.ok(await stat(shot.text.split(" — ")[0]!), "and is saved beside the facet's captures");
    // Flipped (phase 5): the browser window reads no state off the game.
    assert.match(text(answers.state!), /state is not available/);
    assert.match(text(answers.key!), /OK — key i/);
    assert.match(text(answers.click!), /left click at 480,300/);
    assert.match(text(answers.bad!), /no action "fly"/);
    assert.match(text(answers.capture!), /c1_default\.jpg/);
    assert.match(text(answers.after!), /^X=\d+, Y=\d+$/);
    // The window was loaded once for the session and once more by capture — never per action.
    assert.equal(rig.preview.loads.length, 2, `loads: ${rig.preview.loads.join(", ")}`);
    const pressed = rig.preview.inputs as Array<{ type: string }>;
    assert.ok(
      pressed.some((a) => a.type === "press"),
      "the key became a press",
    );
    assert.ok(
      pressed.some((a) => a.type === "click" && (a as { px?: boolean }).px === true),
      "the click landed in pixels",
    );
    // The agent's screen opens immediately; rapid actions share a card update, then the session closes.
    const frames = rig.events.filter((e) => e.type === "preview.frame");
    assert.ok(frames.length >= 1, "the agent screen receives its initial picture before the session closes");
    const first = frames[0]!.payload as {
      label: string;
      role: string;
      facetId: string;
      jpeg: string;
      cursor: { x: number; y: number };
      act?: { deed: string };
    };
    assert.equal(first.label, "Plaza");
    assert.deepEqual(first.act, { deed: "load" }, "the first picture is the game opening, as a code the graph words");
    assert.equal(first.role, "builder");
    assert.equal(first.facetId, "plaza");
    assert.ok(first.jpeg.length > 0);
    const screens = rig.events
      .filter((e) => e.type === "preview.screen")
      .map((e) => (e.payload as { state: string }).state);
    assert.deepEqual(screens, ["opened", "closed"]);
    const closedAt = rig.events.findIndex(
      (event) => event.type === "preview.screen" && (event.payload as { state: string }).state === "closed",
    );
    assert.equal(
      rig.events.slice(closedAt + 1).some((event) => event.type === "preview.frame"),
      false,
      "a closed session never publishes a late card",
    );
    assert.equal(rig.core.agentScreens().length, 0, "nothing is left on screen after the session");
  });

  it("replays the requested setup's input before the first look", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = await rig.core.games.scaffold("setup-smoke", { title: "setup" });
    const dir = project.dir;
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    let first: LiveToolResult = "";
    fakeEngine(rig, "codex", async (request) => {
      first = await request.onLiveTool!("computer", { action: "screenshot" });
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "s2", summary: "done" };
    });
    const setup = {
      actions: [
        { type: "tap", keys: ["i"] },
        { type: "click", x: 480, y: 300, px: true },
      ],
      verify: { path: "maps.activeId", equals: "macba" },
      note: "I opens the picker",
    };
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "build",
      project: project.name,
      selfCapture: { project: project.name, root: dir, runId: "run_s", facetId: "build", iteration: 1, setup },
    });
    const setupInputs = rig.preview.inputs.slice(0, 2) as Array<{ type: string }>;
    assert.deepEqual(
      setupInputs.map((a) => a.type),
      ["tap", "click"],
      "the setup ran before the agent's first action",
    );
    // Flipped from a REQUESTED STATE NOT REACHED note: the game's state is never read.
    assert.doesNotMatch(text(first), /NOT REACHED/);
  });

  it("photographs the surface the worker asked for, and names it in the answer (M4.5)", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = await rig.core.games.scaffold("surface-smoke", { title: "surface" });
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    // A zoom that records the surface it was asked for; `zoom` gains its options in lane A.
    const zooms: Array<Record<string, unknown> | undefined> = [];
    (rig.preview as unknown as { zoom?: unknown }).zoom = async (
      region: [number, number, number, number],
      _quality?: number,
      opts?: Record<string, unknown>,
    ) => {
      zooms.push(opts);
      return { jpeg: await rig.preview.screenshot(), width: 480, height: 300, region };
    };
    const answers: Record<string, LiveToolResult> = {};
    fakeEngine(rig, "codex", async (request) => {
      answers.screen = await request.onLiveTool!("computer", { action: "screenshot", surface: "screen" });
      answers.canvas = await request.onLiveTool!("computer", { action: "screenshot", surface: "canvas" });
      answers.plain = await request.onLiveTool!("computer", { action: "screenshot" });
      answers.zoom = await request.onLiveTool!("computer", {
        action: "zoom",
        region: "0,0,100,100",
        surface: "screen",
      });
      answers.odd = await request.onLiveTool!("computer", { action: "screenshot", surface: "true" });
      answers.capture = await request.onCapture!({ cameras: "default" });
      return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "s-surface", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "build",
      project: project.name,
      selfCapture: { project: project.name, root: project.dir, runId: "run_surface", facetId: "build", iteration: 1 },
    });
    delete (rig.preview as unknown as { zoom?: unknown }).zoom;

    // "screen" is the studio's "page"; "canvas" is itself; nothing asked lets the studio pick.
    // The screen card's own picture of the loaded build (`auto`) comes before the worker's shots.
    const asked = rig.preview.captureOpts.map((o) => o.surface);
    const first = asked.indexOf("page");
    assert.deepEqual(
      asked.slice(first, first + 3),
      ["page", "canvas", "auto"],
      JSON.stringify(rig.preview.captureOpts),
    );
    assert.ok(
      asked.slice(0, first).every((surface) => surface === "auto"),
      "the card never asks for a surface of its own choosing",
    );
    assert.deepEqual(zooms, [{ surface: "page" }], "the zoom takes the same surface as the shot");
    // The surface is named on the line the model reads, so a frame is never mistaken for the
    // other one — a DOM menu photographed as a canvas is what this milestone exists for.
    assert.match(text(answers.screen!), /\(screen\)/);
    assert.match(text(answers.canvas!), /\(canvas\)/);
    assert.match(text(answers.zoom!), /\(screen\)/);
    // A surface nobody has is a note above the answer, never a refusal that costs a turn.
    assert.match(
      text(answers.odd!),
      /^surface "true" is not screen or canvas — the studio picked the surface itself\n/,
    );
    assert.ok(typeof answers.odd !== "string" && answers.odd!.images?.length, "and the picture still comes back");
    // The capture tool photographs the page as the player sees it, DOM included.
    assert.equal(rig.preview.captureOpts.at(-1)?.surface, "page");
    assert.match(text(answers.capture!), /c1_default\.jpg/);
  });

  it("never lends the director's session the window the user is watching, even with the pool full", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 0, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("borrow-smoke", { title: "borrow" });
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const threadId = rig.core.mainThread;
    const handles: string[] = [];
    const liveLoads = rig.preview.loads.length;
    fakeEngine(rig, "codex", async (request) => {
      await request.onLiveTool!("computer", { action: "screenshot" });
      for (const screen of rig.core.agentScreens()) handles.push(screen.handle);
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "d1", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "direct",
      project: project.name,
      threadId,
      director: { runId: "run_borrow", threadId, project: project.name, root: project.dir, setup: null, tools: [] },
    });
    assert.equal(handles.length, 1, JSON.stringify(handles));
    assert.notEqual(handles[0], "live", "a window of its own, not the user's");
    assert.equal(rig.preview.loads.length, liveLoads, "nothing was loaded into the user's window");
    assert.deepEqual(customEvents(await rig.core.listAllEvents(), "director_window"), []);
  });
});

describe("what a load waits for", () => {
  /** A scaffolded game whose studio.json declares how long it takes to boot. */
  async function bootGame(rig: Rig, name: string, bootMs: number): Promise<{ dir: string; name: string }> {
    const project = await rig.core.games.scaffold(name, { title: name });
    const file = path.join(project.dir, "studio.json");
    const meta = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...meta, bootMs }, null, 2));
    return { dir: project.dir, name: project.name };
  }

  it("photographs a page that never reported itself ready, and says so — a note, not a refusal", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await bootGame(rig, "slow-boot", 1_000);
    // The page carries the shim and keeps saying it is still booting.
    rig.preview.evaluations.push({ match: "__studioClock", value: booting() });
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    let captured = "";
    fakeEngine(rig, "codex", async (request) => {
      captured = text(await request.onCapture!({ cameras: "default" }));
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "s", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "build",
      project: game.name,
      selfCapture: { project: game.name, root: game.dir, runId: "run_b", facetId: "build", iteration: 1 },
    });
    // Refusing here would skip the setup script, the screen and every frame — exactly the
    // shape this milestone exists for would go unlooked-at.
    assert.ok(!/failed to load/.test(captured), captured);
    assert.match(captured, /c1_default\.jpg/, "the frames were taken anyway");
    assert.match(captured, /the page has not reported itself ready after 1s — you are looking at whatever it drew/);
    const screens = rig.events
      .filter((e) => e.type === "preview.screen")
      .map((e) => (e.payload as { state: string }).state);
    assert.ok(screens.includes("opened"), "the worker's screen was opened all the same");
  });

  it("answers preview.ready over the substrate RPC — a host call, not an agent tool", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await bootGame(rig, "ready-rpc", 1_000);
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    assert.ok(api["preview.ready"], "preview.ready resolves through core.api()");
    await api["preview.load"]!({ project: game.name });
    rig.preview.evaluations.push({
      match: "__studioClock",
      value: booting({ ready: true, phase: "ready", pageMs: 240, attached: true }),
    });
    const ready = (await api["preview.ready"]!({})) as {
      ready: boolean;
      pageMs: number | null;
      via: string;
      polls: number;
    };
    assert.deepEqual(
      { ready: ready.ready, pageMs: ready.pageMs, via: ready.via, polls: ready.polls },
      { ready: true, pageMs: 240, via: "shim", polls: 1 },
    );
  });

  it("refuses a page that says it failed to boot, and one that has left the address the studio serves", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await bootGame(rig, "dead-boot", 1_000);
    rig.preview.evaluations.push({
      match: "__studioClock",
      value: booting({ phase: "failed", reason: "the game's boot threw: Cannot read properties of undefined" }),
    });
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    let captured = "";
    fakeEngine(rig, "codex", async (request) => {
      captured = text(await request.onCapture!({ cameras: "default" }));
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "s", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "build",
      project: game.name,
      selfCapture: { project: game.name, root: game.dir, runId: "run_d", facetId: "build", iteration: 1 },
    });
    assert.match(captured, /your build failed to load: the game's boot threw: Cannot read properties of undefined/);

    // A game that navigates to its own dev server has walked out of the studio's sight: the
    // shim, the clock and the cameras are all on the page the studio served, not on that one.
    const stray = await bootGame(rig, "stray-boot", 1_000);
    rig.preview.evaluations.length = 0;
    rig.preview.evaluations.push({ match: "__studioClock", value: booting({ ready: true, phase: "ready" }) });
    const status = rig.preview.status.bind(rig.preview);
    rig.preview.status = () => ({ ...status(), url: "http://localhost:5173/" });
    let escaped = "";
    fakeEngine(rig, "codex2", async (request) => {
      escaped = text(await request.onCapture!({ cameras: "default" }));
      return { ok: true, engine: "codex2", turns: 1, usage: {}, sessionId: "s", summary: "done" };
    });
    await api["engine.delegate"]!({
      engine: "codex2",
      prompt: "build",
      project: stray.name,
      selfCapture: { project: stray.name, root: stray.dir, runId: "run_x", facetId: "build", iteration: 1 },
    });
    rig.preview.status = status;
    assert.match(
      escaped,
      /your build failed to load: the page left game:\/\/stray-boot for http:\/\/localhost:5173, which the studio does not serve/,
    );
  });
});

describe("a setup, as builders and the computer tool first see it", () => {
  it("replays the setup's input and asks the game nothing: no begin, no state", async () => {
    const calls: string[] = [];
    const port = {
      async studioState() {
        calls.push("state");
        return {};
      },
      async studioCall(method: string) {
        calls.push(method);
        return { ok: true };
      },
      async input() {
        calls.push("input");
        return { ok: true, applied: 1, width: 960, height: 600 };
      },
      consoleEntries: () => [],
    } as unknown as PreviewPort;
    const service = new PreviewService(
      { emit: () => {} } as unknown as StudioCore,
      unservedPreviews() as CoreInternals,
    );
    const sleep = async () => {};
    assert.equal(await service.applySetup(port, null, { sleep }), null);
    assert.deepEqual(calls, ["start"], "only the studio's own clock is started");
    calls.length = 0;
    const note = await service.applySetup(
      port,
      { actions: [{ type: "tap", keys: ["i"] }], verify: { path: "flow.playing", equals: true } },
      { sleep },
    );
    assert.equal(note, null);
    assert.deepEqual(calls, ["start", "input"]);
  });
});
