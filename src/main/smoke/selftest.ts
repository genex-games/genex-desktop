/**
 * In-app end-to-end self test (`electron . --studio-selftest`).
 *
 * Everything below the model is real: the real substrate, the real sandbox, the real harness
 * child process, the real Chromium preview, the real `game://` protocol, real screenshots. Only
 * the model is scripted — the runner points the local engine at a small OpenAI-compatible server
 * so the assertions are about the studio's behaviour rather than a model's mood.
 *
 * Prints a JSON report to stdout and exits non-zero if any check fails.
 */
import { BrowserWindow, app } from "electron";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GamePreview } from "../preview.ts";
import { OllamaEngine } from "../../substrate/engines/ollama.ts";
import { toPosixRelative } from "../../substrate/paths.ts";
import { StudioCore } from "../studio-core.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import { CustomEvent, type CustomEventType } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { UiEvent, type UiEventOf } from "../../shared/ui-events.ts";
import { HarnessState } from "../../shared/protocol.ts";
import { randomUUID } from "node:crypto";
import { sleep, waitFor } from "./wait.ts";
import { errorMessage } from "../../shared/errors.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { flagValue, hasFlag, StudioFlag } from "../dev/launch-flags.ts";

/** The self test's window: shown (capturePage needs a compositor surface), parked off-screen unless `--show`. */
const WINDOW = { width: 1024, height: 768, backgroundColor: "#05070d" } as const;
const PARKED_X = -4000;
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
/** How long each stage of the self test may take. */
const TURN_TIMEOUT_MS = 90 * SECOND_MS;
const RESTART_TIMEOUT_MS = 45 * SECOND_MS;
const RESTART_LOG_TIMEOUT_MS = 5 * SECOND_MS;
const RUN_START_TIMEOUT_MS = 60 * SECOND_MS;
const RUN_FINISH_TIMEOUT_MS = 180 * SECOND_MS;
const RUN_SETTLE_TIMEOUT_MS = 60 * SECOND_MS;
const AUTOPILOT_FINISH_TIMEOUT_MS = 240 * SECOND_MS;
/** A scaffolded game must draw a new frame on its own within this long. */
const ANIMATION_DEADLINE_MS = 5 * SECOND_MS;
const POLL_MS = 200;
/** A real screenshot is at least this big. */
const MIN_SHOT_BYTES = 5_000;
/** The vendored three.js is at least this big: an export that carries it is self-contained. */
const MIN_THREE_BYTES = 100_000;

/**
 * Two stills make a commission kind="reference", and the blind-panel victory that unlocks is the
 * only fast honest exit — hours clamp to >=0.5h, so a wall-clock exit cannot fit here.
 */
const STILL = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const LOOP_FRAMES = [
  { label: "night", mimeType: "image/jpeg", data: STILL },
  { label: "rings", mimeType: "image/jpeg", data: STILL },
];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the self test owns, so its cleanup can reach whatever got made before a failure. */
interface Owned {
  core: StudioCore | null;
  window: BrowserWindow | null;
  /** The folder the Open Game checks pick, kept here so the cleanup below can find it. */
  pickedFolder: string | null;
}

/** What every stage of the self test reads and records into. */
interface SelfTest {
  core: StudioCore;
  preview: GamePreview;
  userData: string;
  /**
   * In production these events drive the window and keep-awake — run.settled is what lets the
   * Mac nap again — so the self test collects them instead of swallowing them.
   */
  uiEvents: UiEvent[];
  owned: Owned;
  check(name: string, ok: boolean, detail?: string): void;
}

export async function runSelfTest(options: { resources: string; userData?: string }): Promise<number> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
    // As it happens, like the smoke's: a self test that dies midway still shows how far it got.
    process.stderr.write(`[selftest] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 300)}` : ""}\n`);
  };
  const uiEvents: UiEvent[] = [];
  const userDataFlag = flagValue(StudioFlag.UserData);
  const userData = options.userData || userDataFlag || (await mkdtemp(path.join(os.tmpdir(), "studio-selftest-")));
  const keepUserData = hasFlag(StudioFlag.KeepUserData);
  const owned: Owned = { core: null, window: null, pickedFolder: null };

  try {
    const { core, preview } = await bootStudio(options.resources, userData, uiEvents, owned);
    check("harness boots inside the sandbox", core.host.state === HarnessState.Ready, `state=${core.host.state}`);
    const t: SelfTest = { core, preview, userData, uiEvents, owned, check };
    for (const stage of STAGES) await stage(t);
  } catch (err) {
    check("self test ran without throwing", false, (err as Error).stack ?? String(err));
  } finally {
    await owned.core?.stop().catch(() => {});
    owned.window?.destroy();
    if (!keepUserData && !userDataFlag) await rm(userData, { recursive: true, force: true }).catch(() => {});
    // The picked folder stands in for a folder the user owns, so it lives outside userData —
    // and is taken away here, once the core that registered it has stopped.
    if (!keepUserData) await rm(owned.pickedFolder ?? "", { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n__SELFTEST_JSON__${JSON.stringify({ checks, failed: failed.length })}__END__\n`);
  return failed.length === 0 ? 0 : 1;
}

/** Every stage, in order: each proves one part, and the last two prove the product. */
const STAGES: Array<(t: SelfTest) => Promise<void>> = [
  checkFullTurn,
  checkPreviewContract,
  checkAssetUse,
  checkSpeechProbe,
  checkGlbAsset,
  checkHeldInput,
  checkContainment,
  // Before the open-game sheet: on Windows opening a folder outside the grants queues a sandbox
  // regrant for the harness's next stop, which the guardian restart would then pay inside its own
  // deadline. The restart deadline times the restart, not that regrant.
  checkSelfModification,
  checkWatchdog,
  checkOpenGameSheet,
  checkExport,
  checkLoopCommission,
  checkAutopilot,
];

/** The window, the preview and the core with its harness started. */
async function bootStudio(resources: string, userData: string, uiEvents: UiEvent[], owned: Owned) {
  // capturePage() needs a compositor surface, so the window has to be *shown*. Unless the
  // operator asked to watch (--show), it is shown inactive and parked off the visible desktop,
  // which keeps the test honest (real GPU frames) without hijacking the screen.
  const visible = hasFlag(StudioFlag.Show);
  const window = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    ...(visible ? {} : { x: PARKED_X, y: 0, skipTaskbar: true, focusable: false }),
    show: false,
    backgroundColor: WINDOW.backgroundColor,
  });
  owned.window = window;
  if (visible) window.show();
  else window.showInactive();

  const preview = new GamePreview({
    gamesRoot: path.join(userData, "workspaces", "games"),
    vendorDir: path.join(resources, "vendor"),
  });
  const ollamaHost = flagValue(StudioFlag.OllamaHost) ?? DEFAULT_OLLAMA_HOST;
  const core = new StudioCore({
    paths: { userData, resources },
    preview,
    execPath: process.execPath,
    runAsNode: true,
    ollamaHost,
    engines: [new OllamaEngine({ host: ollamaHost })],
    executionPolicy: { runBackgroundImprovement: false },
    onUiEvent: (event) => uiEvents.push(event),
    onLog: (line, stream) => process.stderr.write(`[selftest:${stream}] ${line}\n`),
  });
  owned.core = core;
  await core.init();
  preview.attachTo(window, { x: 0, y: 0, width: WINDOW.width, height: WINDOW.height });
  await core.start();
  return { core, preview };
}

/** A full turn: model → tools → workspace → preview. */
async function checkFullTurn({ core, check }: SelfTest): Promise<void> {
  const finished = waitForEvent(core, (event) => event.data.type === EventKind.TurnEnded, TURN_TIMEOUT_MS);
  await core.sendUserMessage("Build me a small three.js game called selftest.");
  const turnEnded = await finished;
  check("a chat turn completes end to end", turnEnded !== null, turnEnded ? "turn_ended seen" : "timed out");

  const games = await core.games.list();
  check(
    "the agent created a game project",
    games.some((g) => g.name === "selftest"),
    games.map((g) => g.name).join(","),
  );

  const events = await core.store.listEvents(core.mainThread);
  const toolResults = events.filter((e) => e.data.type === EventKind.ToolResult);
  check("tools ran and were logged", toolResults.length >= 2, `${toolResults.length} tool results`);
  const wroteFile = events.some((e) => e.data.type === EventKind.ToolRequested && e.data.request.name === "write_file");
  check("the agent wrote a game file", wroteFile);
}

/** The preview: protocol, contract, determinism, screenshots. */
async function checkPreviewContract({ preview, check }: SelfTest): Promise<void> {
  await preview.load("selftest");
  await sleep(1_500);
  const state = (await preview.studioState()) as Record<string, unknown>;
  // The v2 contract reports version 2; a v1 game (an older folder) still boots and is judged.
  check(
    "game://  serves the project and the game boots",
    state?.version === 1 || state?.version === 2,
    JSON.stringify(state)?.slice(0, 160),
  );
  check("no runtime error in the game", !state?.error, JSON.stringify(state?.error ?? null));
  await checkAnimatesUnstarted({ preview, check }, state);
  // A contractor rewrites these files while the preview watches — a cached copy once hid a
  // finished game behind the scaffold template for 20 minutes.
  const cacheHeader = (await preview.view?.webContents.executeJavaScript(
    `fetch("studio.json").then((r) => r.headers.get("cache-control"))`,
  )) as string | null;
  check("game://  responses are never cached", cacheHeader === "no-store", String(cacheHeader));

  const runA = await deterministicRun(preview, 42);
  const runB = await deterministicRun(preview, 42);
  check(
    "identical seeds produce identical runs (comparability)",
    JSON.stringify(runA) === JSON.stringify(runB),
    `${JSON.stringify(runA)} vs ${JSON.stringify(runB)}`,
  );
  const runC = await deterministicRun(preview, 99);
  check("different seeds diverge", JSON.stringify(runA) !== JSON.stringify(runC));

  const cameras = (await preview.evaluate("window.__studio.cameras()")) as string[];
  check("named debug cameras exist", Array.isArray(cameras) && cameras.length >= 3, String(cameras));

  const shot = await preview.screenshot(80);
  const isJpeg = shot.length > 3 && shot[0] === 0xff && shot[1] === 0xd8;
  check(
    "screenshots capture real pixels",
    isJpeg && shot.length > MIN_SHOT_BYTES,
    `${shot.length} bytes, jpeg=${isJpeg}`,
  );
  const glProbe = await preview.evaluate("Boolean(window.__studioGl)");
  check("the WebGL error probe is installed in the game page", glProbe === true, String(glProbe));
  const gpu = await preview.gpuErrors();
  check("gpuErrors returns a list (empty means a clean context)", Array.isArray(gpu), JSON.stringify(gpu));
}

/**
 * Every stepped check below would pass on a game that boots paused — and that game would
 * still ship a frozen screen, because nothing in the pipeline calls start().
 */
async function checkAnimatesUnstarted(
  { preview, check }: Pick<SelfTest, "preview" | "check">,
  state: Record<string, unknown>,
): Promise<void> {
  const frameBefore = Number((state as { frame?: unknown })?.frame ?? NaN);
  // Wait for an observed automatic frame, rather than assuming the macOS compositor
  // schedules this background surface inside a single 400ms interval. Never step/start it.
  let frameAfter = frameBefore;
  const animationDeadline = Date.now() + ANIMATION_DEADLINE_MS;
  while (!(frameAfter > frameBefore) && Date.now() < animationDeadline) {
    await sleep(100);
    const stateAfter = (await preview.studioState()) as { frame?: unknown } | null;
    frameAfter = Number(stateAfter?.frame ?? NaN);
  }
  check(
    "a scaffolded game animates without anyone calling start()",
    frameAfter > frameBefore,
    `frame ${frameBefore} -> ${frameAfter}`,
  );
}

/** A delivered Genex job's folder, as the plugin writes one after a download. */
async function writeDeliveredJob(core: StudioCore, operation: string, files: string[]): Promise<string> {
  const id = randomUUID();
  const dir = path.join(core.pluginServices.root("genex"), "projects/asset-use-fixture/jobs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      project: "asset-use-fixture",
      operation,
      status: "downloaded",
      files,
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

/**
 * Real Chromium resource timing and capture, with an explicitly synthetic delivered job.
 * No Genex service or coding account participates in this fixture.
 */
async function checkAssetUse(t: SelfTest): Promise<void> {
  const { core, check } = t;
  await core.games.scaffold("asset-use-fixture");
  const assetRoot = core.games.dirFor("asset-use-fixture");
  await mkdir(path.join(assetRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(assetRoot, "assets/banner.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="orange"/></svg>',
  );
  const entry = path.join(assetRoot, "src/main.js");
  await writeFile(
    entry,
    `const banner=new Image();banner.src='./assets/banner.svg';banner.style.cssText='position:fixed;top:20px;left:20px;z-index:10';document.body.append(banner);await banner.decode();\n${await readFile(entry, "utf8")}`,
  );
  const assetJobId = await writeDeliveredJob(core, "image", ["assets/banner.svg"]);
  const assetInspection = (await core.plugins.tool(
    "genex__asset",
    { operation: "inspect_use", id: assetJobId },
    { project: "asset-use-fixture", directory: assetRoot },
  )) as { use?: { stage: string }; images?: Array<{ data: string }> };
  check(
    "Genex assetInspection observes a delivered asset loading in real Chromium",
    assetInspection.use?.stage === "integrated",
    JSON.stringify(assetInspection.use),
  );
  check(
    "Genex assetInspection returns a real frame without claiming visual verification",
    Boolean(assetInspection.images?.[0]?.data) && assetInspection.use?.stage !== "verified",
  );
  await checkAudioEvidence(t, assetRoot, entry);
}

/** Per-file audio: another audible asset must not turn a silent/paused one into a pass. */
async function checkAudioEvidence({ core, check }: SelfTest, assetRoot: string, entry: string): Promise<void> {
  for (const name of ["tone", "silent", "muted", "paused"])
    await writeFile(path.join(assetRoot, `assets/${name}.wav`), wave(name === "silent"));
  await writeFile(path.join(assetRoot, "assets/broken.wav"), "invalid audio fixture");
  const audioSetup = `for(const name of ['tone','silent','muted','paused','broken']){const a=document.createElement('audio');a.src='./assets/'+name+'.wav';a.loop=true;a.preload='auto';a.volume=0.02;a.muted=name==='muted';document.body.append(a);a.load();if(name!=='paused')a.play().catch(()=>{});}
`;
  await writeFile(entry, audioSetup + (await readFile(entry, "utf8")));
  for (const [name, expected] of [
    ["tone", "playing"],
    ["silent", "silent"],
    ["muted", "muted"],
    ["paused", "paused"],
    ["broken", "failed"],
  ] as const) {
    const id = await writeDeliveredJob(core, "sfx", [`assets/${name}.wav`]);
    console.info(`audio acceptance start: ${name}`);
    const result = (await core.plugins.tool(
      "genex__asset",
      { operation: "inspect_use", id },
      { project: "asset-use-fixture", directory: assetRoot },
    )) as { use?: { stage: string; audio?: Array<{ state: string }> } };
    console.info(`audio acceptance result: ${name} ${JSON.stringify(result.use)}`);
    const verifiedOnlyForTone = (result.use?.stage === "verified") === (name === "tone");
    check(
      `Genex audio ${name}: per-file ${expected} evidence`,
      result.use?.audio?.[0]?.state === expected && verifiedOnlyForTone,
      JSON.stringify(result.use),
    );
  }
}

/** Five seconds of a 440 Hz tone (or of silence) as a 16-bit mono WAV. */
function wave(silent = false): Buffer {
  const rate = 22050;
  const frames = rate * 5;
  const b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    b.writeInt16LE(silent ? 0 : Math.round(3000 * Math.sin((i * 2 * Math.PI * 440) / rate)), 44 + i * 2);
  return b;
}

/**
 * On-device speech: a page probing it keeps its renderer.
 * Each call below got the whole game renderer killed for a bad Mojo message until
 * GAME_DISABLED_BLINK_FEATURES (game-view.ts) took the members away, and Chromium ignores a feature name it
 * no longer knows, so this is the check that notices an Electron upgrade renaming one. The
 * frame is another site, so it runs in its own renderer process, whose death `crashed` never
 * reports: only its delayed message proves it lived.
 */
async function checkSpeechProbe({ preview, userData, check }: SelfTest): Promise<void> {
  const speechRoot = path.join(userData, "workspaces", "games");
  const speechProbe = `const seen = [], options = { langs: ["en-US"], processLocally: true }, C = window.SpeechRecognition;
      for (const name of ["available", "install"]) try { C[name](options); seen.push(name + ": called"); } catch (error) { seen.push(name + ": " + error.name); }
      const recognizer = new C(); recognizer.lang = "en-US"; recognizer.processLocally = true;
      recognizer.onerror = (event) => seen.push("start: " + event.error);
      try { recognizer.start(); } catch (error) { seen.push("start: " + error.name); }`;
  await mkdir(path.join(speechRoot, "speech-probe-frame"), { recursive: true });
  await mkdir(path.join(speechRoot, "speech-probe"), { recursive: true });
  await writeFile(
    path.join(speechRoot, "speech-probe-frame", "index.html"),
    `<script>addEventListener("load", () => { ${speechProbe}; setTimeout(() => parent.postMessage({ speechFrame: seen }, "*"), 500); });</script>`,
  );
  await writeFile(
    path.join(speechRoot, "speech-probe", "index.html"),
    `<script>addEventListener("message", (event) => { if (event.data?.speechFrame) window.speechFrame = event.data.speechFrame; });
      addEventListener("load", () => setTimeout(() => { ${speechProbe}; window.speech = seen; }, 200));</script>
      <iframe src="game://speech-probe-frame/" allow="on-device-speech-recognition"></iframe>`,
  );
  await preview.load("speech-probe");
  await sleep(2_000);
  const speechCrashed = preview.status().crashed;
  // A dead renderer never answers executeJavaScript, so only a live one is asked.
  const speech = speechCrashed
    ? null
    : ((await preview.evaluate("({ page: window.speech, frame: window.speechFrame })")) as {
        page?: string[];
        frame?: string[];
      } | null);
  check("a page probing on-device speech recognition keeps its renderer", !speechCrashed, JSON.stringify(speech));
  check(
    "on-device speech members are absent in the page and in a cross-site frame",
    [speech?.page, speech?.frame].every((seen) =>
      ["available: TypeError", "install: TypeError"].every((entry) => seen?.includes(entry)),
    ),
    JSON.stringify(speech),
  );
  await rm(path.join(speechRoot, "speech-probe"), { recursive: true, force: true });
  await rm(path.join(speechRoot, "speech-probe-frame"), { recursive: true, force: true });
  await preview.load("selftest");
}

/** Assets (AG-930): a .glb in assets/ loads through src/assets.js and is tagged for checks. */
async function checkGlbAsset({ core, preview, check }: SelfTest): Promise<void> {
  const assetsDir = path.join(core.games.dirFor("selftest"), "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "tri.glb"), minimalGlb());
  const loaded = (await preview.evaluate(
    `import("/src/assets.js").then((m) => m.loadAsset("tri", { tag: "tri" })).then((g) => { let meshes = 0; g.traverse((o) => { if (o.isMesh && o.userData.asset === "tri") meshes++; }); return { tag: g.userData.tag, asset: g.userData.asset, meshes }; }).catch((err) => ({ error: String(err && err.message || err) }))`,
  )) as { tag?: string; asset?: string; meshes?: number; error?: string };
  check(
    "a .glb in assets/ loads through src/assets.js, tagged and stamped for scene checks",
    loaded?.tag === "tri" && loaded?.asset === "tri" && (loaded?.meshes ?? 0) >= 1,
    JSON.stringify(loaded),
  );
}

async function checkHeldInput({ preview, check }: SelfTest): Promise<void> {
  await preview.studioCall("seed", 1);
  await preview.input([{ type: "down", keys: ["w"] }]);
  const held = (await preview.evaluate(
    "window.__studio && window.__studio.state ? window.__studio.state().held : null",
  )) as unknown;
  const heldList = Array.isArray(held) ? held.map(String) : [];
  check(
    "preview input reaches the game (held keys)",
    heldList.some((key) => /^(KeyW|w|W)$/.test(key)),
    `held=${JSON.stringify(heldList)}`,
  );
  await preview.input([{ type: "up", keys: ["w"] }]);
}

/** Containment: the game cannot escape its folder. */
async function checkContainment({ preview, userData, check }: SelfTest): Promise<void> {
  // Control first: if this does not come back 200, the probe itself is broken and every
  // containment assertion below would be vacuous.
  const control = await fetchThroughPreview(preview, "game://selftest/index.html");
  check("the containment probe works (control fetch succeeds)", control.status === 200, `status ${control.status}`);

  const escaped = await fetchThroughPreview(preview, "game://selftest/../../../../etc/passwd");
  check("path traversal out of the game folder is refused", escaped.status >= 400, `status ${escaped.status}`);
  const encoded = await fetchThroughPreview(preview, "game://selftest/%2e%2e%2f%2e%2e%2fsecrets/engine.json");
  check("percent-encoded traversal is refused too", encoded.status >= 400, `status ${encoded.status}`);
  const otherProject = await fetchThroughPreview(preview, "game://selftest/../harness/loop/main.ts");
  check("a game cannot read the harness workspace", otherProject.status >= 400, `status ${otherProject.status}`);
  const secretUrl = `game://selftest/${path.relative(path.join(userData, "workspaces", "games", "selftest"), path.join(userData, "secrets"))}`;
  const secretFetch = await fetchThroughPreview(preview, secretUrl);
  check("the secrets directory is unreachable from a game", secretFetch.status >= 400, `status ${secretFetch.status}`);
}

/**
 * The Open Game sheet: looking is not opening. The folder a user picks is read before anything
 * is written to it, and what the sheet promises is exactly what lands. This is the whole reason
 * picking and opening were split: the studio used to scaffold its template into the folder the
 * dialog returned, which wraps a real game in a subfolder in an empty project.
 */
async function checkOpenGameSheet(t: SelfTest): Promise<void> {
  const { core, check } = t;
  const picked = await mkdtemp(path.join(os.tmpdir(), "studio-open-"));
  t.owned.pickedFolder = picked;
  const inner = await writeWreckage(picked);
  const beforeLook = await filesUnder(picked);
  const inspection = await core.inspectFolder(picked);
  check(
    "looking inside a folder writes nothing into it",
    JSON.stringify(await filesUnder(picked)) === JSON.stringify(beforeLook),
    beforeLook.join(","),
  );
  const offered = inspection.candidates.find((candidate) => candidate.rel === "wreckage");
  check(
    "the game one folder down is what the sheet offers",
    inspection.suggested === "wreckage" && offered?.shape.kind === "three-vite",
    `suggested=${inspection.suggested} kind=${offered?.shape.kind ?? "none"}`,
  );
  const beforeOpen = await filesUnder(inner);
  const beforeParent = (await filesUnder(picked)).filter((file) => !file.startsWith("wreckage"));
  const openedGame = await core.adoptProject(picked, { subdir: "wreckage" });
  const written = (await filesUnder(inner)).filter((file) => !beforeOpen.includes(file)).sort();
  const promised = [...(offered?.preflight.writes ?? [])].sort();
  const writtenOutside = (await filesUnder(picked)).filter(
    (file) => !file.startsWith("wreckage") && !beforeParent.includes(file),
  );
  check(
    "opening writes exactly the files the sheet promised, and only into the game",
    JSON.stringify(written) === JSON.stringify(promised) && writtenOutside.length === 0,
    `${written.join(",")} vs ${(offered?.preflight.writes ?? []).join(",")}`,
  );
  const keptAsItIs =
    openedGame.dir === (await realpath(inner)) && openedGame.shape.main === "src/main.js" && openedGame.built;
  check(
    "the game the studio opened is the nested one, kept as it is",
    keptAsItIs,
    `${openedGame.dir} main=${openedGame.shape.main}`,
  );
  await checkOpenedPages(t, inner);
}

/** Somebody's own three.js + vite game, one folder down in the picked folder; its path. */
async function writeWreckage(picked: string): Promise<string> {
  const inner = path.join(picked, "wreckage");
  await mkdir(path.join(inner, "src"), { recursive: true });
  await writeFile(
    path.join(inner, "index.html"),
    `<!doctype html><div id="app"></div><script type="module" src="/src/main.js"></script>`,
  );
  await writeFile(
    path.join(inner, "src", "main.js"),
    `import * as THREE from "three";\nexport const scene = new THREE.Scene();\n`,
  );
  await writeFile(
    path.join(inner, "package.json"),
    JSON.stringify({
      name: "wreckage",
      type: "module",
      scripts: { build: "vite build" },
      dependencies: { three: "^0.169.0" },
    }),
  );
  return inner;
}

/** Every file under a folder, with git's own bookkeeping collapsed into the repository it is. */
async function filesUnder(dir: string): Promise<string[]> {
  const found = await readdir(dir, { recursive: true, withFileTypes: true });
  return [
    ...new Set(
      found
        .filter((entry) => entry.isFile())
        .map((entry) =>
          toPosixRelative(path.relative(dir, path.join(entry.parentPath, entry.name))).replace(
            /(^|\/)\.git\/.*$/,
            "$1.git",
          ),
        ),
    ),
  ].sort();
}

/**
 * …and the pages it was given describe that game. The template's own say "This project
 * starts empty" and "Empty project", and a contractor that read them in somebody's real
 * game built as if it were.
 */
async function checkOpenedPages({ check }: SelfTest, inner: string): Promise<void> {
  const openedRules = await readFile(path.join(inner, "CLAUDE.md"), "utf8").catch(() => "");
  const openedNotes = await readFile(path.join(inner, "NOTES.md"), "utf8").catch(() => "");
  const contractPage = await stat(path.join(inner, "docs", "CONTRACT.md")).catch(() => null);
  const rulesDescribeTheGame =
    !/starts empty/.test(openedRules) &&
    // `npm run build`: the command the shape recorded for this folder's own build script.
    /npm run build/.test(openedRules) &&
    /src\/studio\.d\.ts/.test(openedRules);
  check(
    "no page in the opened game claims the game is empty",
    rulesDescribeTheGame && !/Empty project/.test(openedNotes) && contractPage === null,
    `${openedRules.slice(0, 90).replace(/\n/g, " ")} | ${openedNotes.slice(0, 60).replace(/\n/g, " ")} | contract=${contractPage ? "written" : "none"}`,
  );
}

/** Self-modification: edit, restart, verify, and the log tells the story. */
async function checkSelfModification({ core, check }: SelfTest): Promise<void> {
  const versionBefore = core.host.harnessVersion;
  const toolPath = path.join(core.layout.harnessWs, "tools", "selftest-tools.ts");
  await writeFile(
    toolPath,
    `export const tools = [{
         name: "selftest_probe",
         description: "installed by the self test",
         parameters: { type: "object", properties: {} },
         async execute() { return "probe ok"; },
       }];\n`,
  );
  const restarted = await core.requestSelfRestart("self test: verify the guardian path", 100);
  await waitFor(() => core.pendingUpdateId === null && core.host.state === HarnessState.Ready, {
    timeoutMs: RESTART_TIMEOUT_MS,
    intervalMs: POLL_MS,
  });
  check(
    "the guardian restarts the harness with new code",
    core.host.state === HarnessState.Ready,
    `state=${core.host.state}`,
  );
  check("the restart is fingerprinted as a different self", core.host.harnessVersion !== versionBefore);
  const journalEntries = await core.journal.pending();
  check(
    "the durable update record was completed",
    journalEntries.length === 0,
    `${journalEntries.length} still queued`,
  );
  // Readiness and durable restart publication are separate async steps.
  const restartLogged = await waitForAll(
    core,
    (log) => customEvents(log, CustomEvent.RebuildAndRestartStudio).length > 0,
    RESTART_LOG_TIMEOUT_MS,
    "restart publication",
  );
  check("the reborn agent can read its own restart from the log", Boolean(restartLogged), restarted.updateId);
}

/** Watchdog: a self-edit that cannot load is rewound without a human. */
async function checkWatchdog({ core, check }: SelfTest): Promise<void> {
  await core.snapshot("harness", "self test: known good", undefined, true);
  await writeFile(path.join(core.layout.harnessWs, "loop", "main.ts"), "throw new Error('deliberately broken');\n");
  await core.recover("self test: simulated broken self-edit");
  check("the watchdog restores a healthy self", core.host.state === HarnessState.Ready, `state=${core.host.state}`);
  const restoredOk = await core.host.healthcheck();
  check("the restored harness passes a healthcheck", restoredOk);
  const mainAfter = await readFile(path.join(core.layout.harnessWs, "loop", "main.ts"), "utf8");
  check("the broken edit is gone from the workspace", !mainAfter.includes("deliberately broken"));
  const restoreLogged = (await core.store.listEvents(core.mainThread)).some(
    (e) =>
      e.data.type === EventKind.WorkspaceRestored ||
      (e.data.type === EventKind.Custom && e.data.event_type === CustomEvent.HarnessReseeded),
  );
  check("the rewind is visible in the log for the morning report", restoreLogged);
}

/** Export: nothing trapped. */
async function checkExport({ core, userData, check }: SelfTest): Promise<void> {
  const exported = await core.games.export("selftest", path.join(userData, "exports", "selftest"));
  const exportedIndex = await readFile(path.join(exported.dir, "index.html"), "utf8");
  const vendorStat = await stat(path.join(exported.dir, "vendor", "three.module.js"));
  check(
    "export produces a self-contained, relatively-linked bundle",
    exportedIndex.includes('"./vendor/three.module.js"') && vendorStat.size > MIN_THREE_BYTES,
    `${vendorStat.size} bytes of three.js`,
  );
}

/**
 * The decisive one: a Loop commission through the real app. Everything above proves the parts;
 * this proves the product — composer Loop in, real run, real screenshots, real blind verdicts,
 * artifacts on disk, and the app told when to sleep.
 */
async function checkLoopCommission(t: SelfTest): Promise<void> {
  const { core, uiEvents, check } = t;
  const loopThread = await core.createGameThread();
  // Phrasing matters: a continue-ask ("keep going…") resumes the dialogue instead of
  // commissioning a run, even with Loop on.
  await core.sendUserMessage("I want a neon ring game over dark water", {
    thread: loopThread,
    loop: { hours: 2, frames: LOOP_FRAMES },
  });

  const startedLog = await waitForAll(
    core,
    (log) => customEvents(log, CustomEvent.RunStarted).length > 0,
    RUN_START_TIMEOUT_MS,
    "run_started",
  );
  const runId = String(customEvents(startedLog ?? [], CustomEvent.RunStarted)[0]?.runId ?? "");
  check("a Loop commission starts a real run", runId !== "", runId || "no run_started within 60s");

  // run.settled is the true end of the run — report.json and the self-improvement pass both
  // land before it — so wait for it once, then everything below only has to look.
  const finishedLog = runId
    ? await waitForAll(
        core,
        (log) => customEvents(log, CustomEvent.RunFinished).length > 0,
        RUN_FINISH_TIMEOUT_MS,
        "run_finished",
      )
    : null;
  if (runId)
    await waitFor(() => uiEvents.some((event) => event.type === UiEvent.RunSettled), {
      timeoutMs: RUN_SETTLE_TIMEOUT_MS,
      intervalMs: POLL_MS,
    });
  const afterRun = finishedLog ?? (await core.listAllEvents());

  const iterations = customEvents(afterRun, CustomEvent.RunIteration);
  check(
    "the run iterates and judges blind",
    iterations.some((iteration) => iteration.winner === "challenger"),
    `winners=${iterations.map((iteration) => String(iteration.winner)).join(",") || "none"}`,
  );
  const artifacts = runId ? await runArtifacts(path.join(t.userData, "runs", runId)) : null;
  check("run artifacts land under userData/runs", artifacts?.ok ?? false, artifacts?.detail ?? "no run to inspect");
  check("run_finished lands in the log", customEvents(afterRun, CustomEvent.RunFinished).length > 0);

  const settledPayload = uiEvents.find(
    (event): event is UiEventOf<typeof UiEvent.RunSettled> => event.type === UiEvent.RunSettled,
  )?.payload;
  check(
    "run.finished and run.settled notify the app",
    uiEvents.some((event) => event.type === UiEvent.RunFinished) && settledPayload?.runId === runId,
    `settled runId=${String(settledPayload?.runId ?? "none")}`,
  );
}

/** The first round's verdict and screenshots, and a report that says the run won. */
async function runArtifacts(runDir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await stat(path.join(runDir, "iter_001", "verdict.json"));
    const shots = (await readdir(path.join(runDir, "iter_001", "screenshots"))).filter((name) => name.endsWith(".jpg"));
    const runReport = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8")) as {
      victory?: boolean;
    };
    return {
      ok: shots.length >= 1 && runReport.victory === true,
      detail: `${shots.length} screenshot(s), victory=${String(runReport.victory)}`,
    };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
}

/** Autopilot through the real app: interview → facets → integrate → global verdict. */
async function checkAutopilot({ core, check }: SelfTest): Promise<void> {
  const autopilotThread = await core.createGameThread();
  await core.sendUserMessage("I want a misty harbor scene at dawn", {
    thread: autopilotThread,
    // Two stills = the mood board and a "reference" bar; no hours = run until satisfied.
    autopilot: { frames: LOOP_FRAMES },
  });
  const apStarted = await waitForAll(
    core,
    (log) => customEvents(log, CustomEvent.AutopilotStarted).length > 0,
    RUN_START_TIMEOUT_MS,
    "autopilot_started",
  );
  const apPlan = customEvents(apStarted ?? [], CustomEvent.AutopilotStarted)[0];
  const apRunId = String(apPlan?.runId ?? "");
  check(
    "an Autopilot commission decomposes into facets",
    (apPlan?.facets as unknown[] | undefined)?.length === 2,
    JSON.stringify(apPlan?.facets ?? null),
  );
  const apFinished = apRunId
    ? await waitForAll(
        core,
        (log) => customEvents(log, CustomEvent.RunFinished).some((r) => r.runId === apRunId),
        AUTOPILOT_FINISH_TIMEOUT_MS,
        "autopilot run_finished",
      )
    : null;
  const apLog = apFinished ?? (await core.listAllEvents());
  checkAutopilotOutcome(check, apLog, apRunId);
}

function checkAutopilotOutcome(check: SelfTest["check"], apLog: EventEnvelope[], apRunId: string): void {
  const facetIterations = customEvents(apLog, CustomEvent.FacetIteration);
  const facetIds = new Set(facetIterations.map((i) => String(i.facetId)));
  check(
    "both facets iterate under their own verifiers",
    facetIds.has("water") && facetIds.has("mist"),
    `facets=${[...facetIds].join(",")}`,
  );
  // v2: the shared base is built first, and the merged build gets its own integration facet.
  check(
    "the shared base commit is built before the facets fork",
    customEvents(apLog, CustomEvent.AutopilotBase).length === 1,
  );
  check(
    "the merged build gets an integration facet with a playtested scoreboard",
    facetIds.has("integration"),
    `facets=${[...facetIds].join(",")}`,
  );
  check("an assumption becomes a decision card", customEvents(apLog, CustomEvent.AutopilotDecision).length >= 1);
  const apReport = customEvents(apLog, CustomEvent.RunFinished).find((r) => r.runId === apRunId);
  check(
    "the autopilot run closes with a global verdict",
    Boolean(apReport && (apReport.globalVerdict as { pick?: string } | undefined)?.pick === "challenger"),
    JSON.stringify(apReport?.globalVerdict ?? null),
  );
  const optimization = customEvents(apLog, CustomEvent.OptimizationUpdated).filter((r) => r.runId === apRunId);
  check(
    "Autopilot publishes a durable Optimization outcome before its final result",
    optimization.length > 0 && Boolean((apReport?.optimization as { outcome?: string } | undefined)?.outcome),
    JSON.stringify(apReport?.optimization ?? null),
  );
  check(
    "the autopilot run wins its reference panel",
    apReport?.victory === true,
    String(apReport?.stoppedBecause ?? ""),
  );
}

async function deterministicRun(preview: GamePreview, seed: number): Promise<unknown> {
  await preview.studioCall("seed", seed);
  // seed() pauses in the current template, but a game scaffolded before that hardening runs
  // live — and one wall-clock RAF between step() calls makes identical seeds diverge.
  await preview.studioCall("pause");
  for (let i = 0; i < 5; i++) await preview.studioCall("step", 960);
  const state = (await preview.studioState()) as Record<string, unknown>;
  // fps depends on wall clock; the simulation itself must not.
  const { fps: _fps, ...deterministic } = state ?? {};
  return deterministic;
}

async function fetchThroughPreview(preview: GamePreview, url: string): Promise<{ status: number }> {
  const result = (await preview.evaluate(
    `fetch(${JSON.stringify(url)}).then(r => ({status: r.status})).catch(() => ({status: 599}))`,
  )) as { status?: number } | undefined;
  // executeJavaScript resolves promises, but a rejected fetch yields undefined.
  return { status: result?.status ?? 599 };
}

/**
 * Run events land in the thread the run belongs to — the game's thread — where the
 * studio-thread watcher above cannot see them. Poll the merged log instead, in its global
 * order. Returns null on timeout so one late event fails its own check, not the whole test.
 */
async function waitForAll(
  core: StudioCore,
  predicate: (events: EventEnvelope[]) => boolean,
  timeoutMs: number,
  label: string,
): Promise<EventEnvelope[] | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await core.listAllEvents();
    if (predicate(events)) return events;
    if (Date.now() > deadline) {
      console.error(`selftest: timed out waiting for ${label}`);
      return null;
    }
    await sleep(200);
  }
}

/** Payloads of one custom event type, from wherever in the log they landed. */
function customEvents(events: EventEnvelope[], eventType: CustomEventType): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.data.type === EventKind.Custom && event.data.event_type === eventType)
    .map((event) => (event.data as { payload?: Record<string, unknown> }).payload ?? {});
}

function waitForEvent(
  core: StudioCore,
  predicate: (event: EventEnvelope) => boolean,
  timeoutMs: number,
): Promise<EventEnvelope | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.close();
      resolve(null);
    }, timeoutMs);
    const subscription = core.store.watch(core.mainThread, (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      subscription.close();
      resolve(event);
    });
  });
}

export { app };

/**
 * The smallest valid GLB: one triangle, one node, no materials — enough for `GLTFLoader` to
 * parse and for `src/assets.js` to tag (AG-930). Built by hand so the e2e needs no Blender.
 */
function minimalGlb(): Buffer {
  const positions = Buffer.alloc(36);
  for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) positions.writeFloatLE(v, i * 4);
  const bin = positions;
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "ai-game-studio selftest" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "tri" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  });
  const pad = (b: Buffer, fill: number): Buffer =>
    b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]);
  const jsonChunk = pad(Buffer.from(json, "utf8"), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (body: Buffer, type: string): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(jsonChunk, "JSON"), chunk(binChunk, "BIN\0")]);
}
