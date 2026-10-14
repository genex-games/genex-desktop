/**
 * Runs only inside the fixture Electron launched by run-cpp-web-ui.mjs (the `cpp-game` fixture).
 *
 * The plan's five M1 steps for a C++ · raylib game in Live, on the real app with the real C++
 * lane and the real sandbox: create one from the dialog (Browser and Mac), see the web build,
 * edit and see it rebuilt, see a compile error's diagnostic, and resize the slot. On the fixture
 * store, tools installed but not prepared read as set-up (ACC-01) and Live builds again the moment
 * the Toolchain sheet is Ready, with the sheet still open (ACC-02). Then the Mac-only game's status
 * card and the destination badges. With `--cpp-store=dev` the fixture's store is the developer's
 * real one, so the lane builds the real template with the real emcc.
 */
import { app, BrowserWindow, webContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("cpp-out");
const store = arg("cpp-store") ?? "fixture";
const launch = JSON.parse(fs.readFileSync(arg("studio-dev-launch"), "utf8"));
const profile = path.dirname(arg("studio-dev-launch"));
/** The core's own folder (its cpp-builds holds the lane's build folders), as the profile's owner record names it. */
const coreRoot = JSON.parse(fs.readFileSync(path.join(profile, "owner.json"), "utf8")).core;
const main = arg("cpp-main");
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const REAL = store === "dev";
/** How long one build may take before a step gives up: the stub is instant, a cold emcc build is not. */
const BUILD_WAIT_MS = REAL ? 15 * 60_000 : 60_000;
const STEP_WAIT_MS = 30_000;
/** How long the game page has to answer one question from the driver. */
const PAGE_ANSWER_MS = 5_000;
/** The colour the committed wasm fixture clears its canvas to (`make-wasm-fixture.sh`). */
const FIXTURE_CLEAR = [240, 84, 30];
/** The clang line the fixture's stub cmake prints for GENEX_FORCE_ERROR (`fixture-toolchains.ts`). */
const FORCED_PLACE = "src/main.cpp:12:5";
const FORCED_MESSAGE = "use of undeclared identifier 'GENEX_FORCE_ERROR'";
/** The line the compile-error step adds, and the column clang reports for it. */
const FORCED_LINE = "int x = GENEX_FORCE_ERROR;";
const FORCED_COLUMN = FORCED_LINE.indexOf("GENEX_FORCE_ERROR") + 1;
/** The least share of the game view the real template must draw over the page's background. */
const MIN_DRAWN_SHARE = 0.05;
/** The template's starter scene calls itself empty (Live then shows the first-idea card); an edit makes it a game. */
const EMPTY_PHASE = 'probes.set("phase", "empty")';
const PLAYING_PHASE = 'probes.set("phase", "playing")';
const NEW_GAME = "Rally";
const NEW_NAME = "rally";

const checks = [];
const timings = {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "✔" : "✖"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
let win, wc;
const js = (code) => wc.executeJavaScript(code, true);

/** Poll `probe` until it answers truthy or `ms` pass; answers the last value. */
async function until(probe, ms = STEP_WAIT_MS) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await probe().catch(() => false);
    if (value) return value;
    await wait(150);
  }
  return value;
}
const present = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`);
/** Until every animation on the page has finished: a dialog is captured as it settles, never mid-fade. */
const settled = () => until(() => js('document.getAnimations().every((a) => a.playState !== "running")'), 5_000);

async function click(selector) {
  await until(() => js("!document.activeViewTransition"));
  const point = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  await wait(250);
}

async function key(name, code = name) {
  const windowsVirtualKeyCode = { Escape: 27, Enter: 13 }[name] ?? 0;
  for (const type of ["keyDown", "keyUp"]) {
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode });
  }
  await wait(200);
}

/** The last picture taken of the game view, saved beside the studio's own capture. */
let lastGameCapture = null;

async function capture(name) {
  fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
  if (lastGameCapture) fs.writeFileSync(path.join(out, `${name}-game.png`), lastGameCapture.toPNG());
  lastGameCapture = null;
}

/** The Live game view: the one child view that is not the studio page and has an area. */
function gameView() {
  return (
    win.contentView.children.find(
      (view) => view.webContents && view.webContents !== wc && view.getVisible() && view.getBounds().width > 0,
    ) ?? null
  );
}
/** `work`, or a rejection naming `what` once {@link PAGE_ANSWER_MS} pass: a page that never answers fails its step. */
async function answered(work, what) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${PAGE_ANSWER_MS} ms`)), PAGE_ANSWER_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * The Live page: the game view on the stage, or (while the stage covers it, as it covers a fresh
 * template's empty scene) the page Live loaded for the new game.
 */
function livePage() {
  const shown = gameView()?.webContents;
  if (shown) return shown;
  const prefix = `game://${NEW_NAME}/`;
  return (
    webContents.getAllWebContents().find((page) => !page.isDestroyed() && page.getURL().startsWith(prefix)) ?? null
  );
}
const gameJs = async (code) => {
  const page = livePage();
  if (!page) throw new Error("no Live page");
  return answered(page.executeJavaScript(code, true), "the game page");
};

/** What the main process can see of the game view without asking the page. */
function gameViewFacts() {
  const view = gameView();
  if (!view) return { view: false, children: win.contentView.children.length };
  const pid = view.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
  return {
    url: view.webContents.getURL(),
    bounds: view.getBounds(),
    crashed: view.webContents.isCrashed(),
    loading: view.webContents.isLoading(),
    windowVisible: win.isVisible(),
    cpu: metric?.cpu?.percentCPUUsage ?? null,
  };
}
const gameUrl = () => gameView()?.webContents.getURL() ?? "";
const liveUrl = () => livePage()?.getURL() ?? "";

/** A click in the middle of the game view, as the person's mouse would make it. */
async function clickGame() {
  const view = gameView();
  if (!view) return;
  const { width, height } = view.getBounds();
  const at = { x: Math.round(width / 2), y: Math.round(height / 2) };
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "mouseMove", ...at });
  for (const type of ["mouseDown", "mouseUp"]) {
    view.webContents.sendInputEvent({ type, ...at, button: "left", clickCount: 1 });
  }
  await wait(300);
}

/**
 * How much of the game view is drawn by the game: the share of sampled pixels that differ from
 * the page's own background, and the share close to `colour` (either byte order: `toBitmap` is
 * the platform's native order).
 */
async function drawn(colour) {
  const view = gameView();
  if (!view) return { share: 0, colourShare: 0, size: null };
  const image = await answered(
    view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
    "the game view's capture",
  );
  const { width, height } = image.getSize();
  lastGameCapture = image;
  const bitmap = image.toBitmap();
  const background = await gameJs(
    "(() => { const c = getComputedStyle(document.body).backgroundColor.match(/\\d+/g) || [0,0,0]; return c.slice(0,3).map(Number); })()",
  ).catch(() => [0, 0, 0]);
  let differs = 0;
  let near = 0;
  let samples = 0;
  const close = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 12);
  for (let y = Math.floor(height / 20); y < height; y += Math.max(1, Math.floor(height / 10))) {
    for (let x = Math.floor(width / 20); x < width; x += Math.max(1, Math.floor(width / 10))) {
      const at = (y * width + x) * 4;
      const bgra = [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
      const rgba = [bitmap[at], bitmap[at + 1], bitmap[at + 2]];
      samples++;
      if (!close(bgra, background) && !close(rgba, background)) differs++;
      if (colour && (close(bgra, colour) || close(rgba, colour))) near++;
    }
  }
  const middle = ((Math.floor(height / 2) * width + Math.floor(width / 2)) * 4) | 0;
  const centre = [...bitmap.subarray(middle, middle + 4)];
  return { share: differs / samples, colourShare: near / samples, size: { width, height }, centre, background };
}

const canvasSize = () =>
  gameJs(
    "(() => { const c = document.querySelector('canvas'); return c ? { width: c.width, height: c.height, css: Math.round(c.getBoundingClientRect().width * devicePixelRatio) } : null; })()",
  );

const buildProblem = (project) => js(`window.studio.buildProblem(${JSON.stringify(project)})`);
const games = () => js("window.studio.games()");

async function gameDir(name) {
  return (await games()).find((game) => game.name === name)?.dir ?? null;
}

async function openGame(name) {
  await until(() => present(`[data-project="${name}"]`));
  await click(`[data-project="${name}"]`);
  await until(async () => (await js("document.querySelector('[data-studio-state]')?.dataset.project")) === name);
}

/** Live shows `name`'s web build: the view is on `game://<name>/index.html`, and a canvas is there. */
async function liveShows(name, ms = BUILD_WAIT_MS) {
  return until(
    async () =>
      liveUrl().startsWith(`game://${name}/index.html`) && (await gameJs("!!document.querySelector('canvas')")),
    ms,
  );
}

async function reloadLive() {
  await click("[data-stage-reload]");
}

/** Step 1: a C++ game from the dialog, Browser and Mac ticked. */
async function createFromDialog() {
  await click('[aria-keyshortcuts="Meta+N Control+N"]');
  await until(() => present('[data-testid="create-game-dialog"]'));
  await click('[aria-label="Game name"]');
  await wc.debugger.sendCommand("Input.insertText", { text: NEW_GAME });
  check(
    "the dialog starts with Browser ticked",
    await js(`document.querySelector('[data-create-game-destination="web"]').checked`),
  );
  await click('[data-create-game-destination="macos"]');
  // The fixture's store has no Mac ANGLE, so choosing C++ opens the Toolchain sheet: close it.
  if (await until(() => present("[data-toolchain-sheet]"), 3_000)) {
    await settled();
    await capture("toolchain-sheet");
    await key("Escape");
    await until(async () => !(await present("[data-toolchain-sheet]")), 5_000);
  }
  check("Mac is ticked", await js(`document.querySelector('[data-create-game-destination="macos"]').checked`));
  await capture("create-dialog");
  const started = Date.now();
  await click('[data-testid="create-game-dialog"] button[type="submit"]');
  const opened = await until(
    async () => (await js("document.querySelector('[data-studio-state]')?.dataset.project")) === NEW_NAME,
  );
  check("the new game opens", opened);
  const created = (await games()).find((game) => game.name === NEW_NAME);
  check(
    "it is a C++ game for the browser and the Mac",
    created?.shape?.kind === "raylib-cpp" &&
      JSON.stringify(created?.destinations?.targets) === JSON.stringify(["web", "macos"]),
    created ? { kind: created.shape?.kind, destinations: created.destinations } : null,
  );
  return started;
}

/** The served page: the shim and its clock, no studio import map, the wasm and data types, nothing covering the canvas. */
async function servedPageChecks() {
  const page = await gameJs(`(async () => {
    const type = async (file) => { const r = await fetch(file); return r.ok ? r.headers.get("content-type") : null; };
    return {
      map: !!document.querySelector('script[type="importmap"]'),
      shim: !!document.querySelector("script[data-studio-shim]"),
      wasm: await type("index.wasm"),
      data: await type("index.data"),
      clock: typeof window.__studioClock,
      contract: typeof window.__studio,
      // The shell's own "Click to start" (for a page outside Genex): inside Genex it must not be drawn.
      overlay: (() => {
        const start = document.getElementById("genex-start");
        return start ? getComputedStyle(start).display !== "none" : false;
      })(),
    };
  })()`);
  check("the page has the shim and no studio import map", page.shim && !page.map, page);
  check("the shim's clock runs on the page", page.clock === "object", page);
  check("no shell overlay covers the canvas inside Genex", page.overlay === false, page);
  check("index.wasm is served as application/wasm", page.wasm === "application/wasm", page);
  if (page.data !== null) check("index.data is served as octet-stream", page.data === "application/octet-stream", page);
}

/** Step 2: Live loads the web build from the lane's out/, served as the C++ lane serves it. */
async function liveLoadsWebBuild(started) {
  const shown = await liveShows(NEW_NAME);
  timings[REAL ? "createToLiveRealEmccMs" : "createToLiveMs"] = Date.now() - started;
  check("Live loads the lane's index.html", shown, {
    ...gameViewFacts(),
    url: liveUrl(),
    problem: await buildProblem(NEW_NAME),
  });
  if (shown) await servedPageChecks();
}

/** Step 2, seen: once the game has something to show, Live puts it on the stage and its canvas is drawn. */
async function canvasOnStage() {
  const onStage = await until(async () => gameView() !== null && gameUrl().startsWith(`game://${NEW_NAME}/`));
  check("Live shows the game on the stage", onStage, gameViewFacts());
  if (!onStage) return;
  const colour = REAL ? null : FIXTURE_CLEAR;
  // So this measures the canvas, a covering shell overlay is taken off (servedPageChecks reports it).
  await gameJs('document.getElementById("genex-start")?.remove()');
  // The person's first click, which inside Genex is what lets the game start its audio.
  await clickGame();
  const painted = await until(async () => {
    const seen = await drawn(colour);
    // The fixture fills its canvas with one colour; the real template draws a scene, not the page's black.
    const drawnEnough = colour ? seen.share > 0.5 && seen.colourShare > 0.5 : seen.share > MIN_DRAWN_SHARE;
    return drawnEnough ? seen : false;
  }, BUILD_WAIT_MS);
  check("the canvas is drawn, not the page background", Boolean(painted), painted || (await drawn(colour)));
  await capture("live-web-build");
}

/** The lane's out/ for a game, from its build folder in the profile's cpp-builds. */
function outputOf(name) {
  const root = path.join(coreRoot, "cpp-builds");
  const folder = fs.readdirSync(root).find((entry) => entry.startsWith(`${name}-`));
  if (!folder) return null;
  const target = fs.readdirSync(path.join(root, folder)).find((entry) => entry.startsWith("web-"));
  return target ? path.join(root, folder, target, "out") : null;
}

/** Step 3: an edit to src/main.cpp is rebuilt, and Live refreshes. */
async function editRebuilds() {
  const dir = await gameDir(NEW_NAME);
  const main = path.join(dir, "src", "main.cpp");
  const source = fs.readFileSync(main, "utf8");
  const output = outputOf(NEW_NAME);
  const builtBefore = fs.statSync(path.join(output, "index.html")).mtimeMs;
  const pageBefore = await gameJs("performance.timeOrigin");
  // The person's first idea: the template's scene stops calling itself empty, so Live shows it.
  const edited = `${source.replace(EMPTY_PHASE, PLAYING_PHASE)}\n// an edit from the L4 runner\n`;
  fs.writeFileSync(main, edited);
  const started = Date.now();
  await reloadLive();
  const rebuilt = await until(
    async () => fs.statSync(path.join(output, "index.html")).mtimeMs > builtBefore,
    BUILD_WAIT_MS,
  );
  const refreshed = await until(
    async () => (await gameJs("performance.timeOrigin")) !== pageBefore && (await liveShows(NEW_NAME, 5_000)),
  );
  timings.editToLiveMs = Date.now() - started;
  check("the edit rebuilt the game", rebuilt);
  check("Live refreshed with the new build", refreshed);
  return edited;
}

/** Step 4: a forced compile error shows clang's diagnostic on the stage. */
async function compileErrorShown(source) {
  const main = path.join(await gameDir(NEW_NAME), "src", "main.cpp");
  fs.writeFileSync(main, `${source}\n${FORCED_LINE}\n`);
  // The stub prints a fixed line; real clang names the line the edit added.
  const place = REAL ? `src/main.cpp:${source.split("\n").length + 1}:${FORCED_COLUMN}` : FORCED_PLACE;
  await reloadLive();
  const shown = await until(() => present("[data-build-problem]"), BUILD_WAIT_MS);
  const text = shown ? await js("document.querySelector('[data-build-problem]').textContent") : "";
  check("the stage says the game did not build", shown);
  check(
    "the stage shows the clang diagnostic by file, line and message",
    text.includes(place) && text.includes(FORCED_MESSAGE),
    { expected: place, text },
  );
  const problem = await buildProblem(NEW_NAME);
  check(
    "the problem carries the parsed diagnostic",
    problem?.diagnostics?.[0]?.file === "src/main.cpp",
    problem?.diagnostics,
  );
  check("Live keeps showing the last build that worked", problem?.showingLastBuild === true);
  await capture("compile-error");
  fs.writeFileSync(main, source);
  await reloadLive();
  check(
    "fixing the error clears the problem",
    await until(async () => !(await present("[data-build-problem]")), BUILD_WAIT_MS),
  );
}

/**
 * A build Live cannot start for want of tools offers the Toolchain sheet, and its badge says Needs
 * tools, not Build failed. Fixture store only: the developer's dev store is shared and never touched.
 */
async function toolsMissingOffersSheet() {
  if (REAL) return;
  const lock = path.join(coreRoot, "toolchains", "current-lock.json");
  const aside = `${lock}.aside`;
  fs.renameSync(lock, aside);
  try {
    await reloadLive();
    check(
      "a build with its tools missing offers Install tools",
      await until(() => present("[data-build-install-tools]")),
    );
    check(
      "the Browser badge says Needs tools, not Build failed",
      await until(() => present('[data-stage-destination="web"][data-destination-state="needs-tools"]')),
    );
    check(
      "no made-up command line for a build that never started",
      !(await js("document.querySelector('[data-build-problem]')?.textContent.includes('(exit')")),
    );
    await click("[data-build-install-tools]");
    check("Install tools opens the Toolchain sheet", await until(() => present("[data-toolchain-sheet]")));
    await settled();
    await capture("install-tools-sheet");
    await key("Escape");
    await until(async () => !(await present("[data-toolchain-sheet]")), 5_000);
  } finally {
    fs.renameSync(aside, lock);
  }
  await reloadLive();
  check(
    "with the tools back, the strip clears",
    await until(async () => !(await present("[data-build-problem]")), BUILD_WAIT_MS),
  );
}

/** The lock's prewarm record in the fixture's own store (never the developer's shared one). */
function prewarmRecord() {
  const store = path.join(coreRoot, "toolchains");
  if (fs.lstatSync(store).isSymbolicLink())
    throw new Error("the profile's store is a link: never touch a shared store");
  const lock = JSON.parse(fs.readFileSync(path.join(store, "current-lock.json"), "utf8"));
  return path.join(store, "locks", lock.digest.slice(0, 12), "prewarm.json");
}

/** Tells the open Toolchain sheet an install ended, as the host does, so it reads the store again. */
function installEnded() {
  const at = new Date().toISOString();
  wc.send("studio:event", {
    type: "toolchain.install",
    payload: { phase: "installed", entry: null, completed: 1, total: 1, startedAt: at, finishedAt: at },
  });
}

/**
 * ACC-01 and ACC-02 on the fixture store: with the tools installed and their first build not
 * prepared, the card and the strip say set-up (never "aren't installed") and the Mac chip does not
 * claim its own window; once the sheet reads Ready, Live builds again without the sheet closing.
 */
async function unpreparedToolsSetUp() {
  if (REAL) return;
  const record = prewarmRecord();
  const aside = `${record}.aside`;
  fs.renameSync(record, aside);
  try {
    // Rebuilt the way the stage's own retry does: after the tools-missing step the stage's Reload
    // button is ignored while an earlier Live load it started is still pending (wave-4 follow-up).
    await js("window.studio.reloadPreview()");
    const button = await until(async () => {
      const text = await js("document.querySelector('[data-build-install-tools]')?.textContent ?? ''");
      return text === "Set up" ? text : false;
    });
    check("tools installed but not prepared offer Set up", Boolean(button), {
      button: await js("document.querySelector('[data-build-install-tools]')?.textContent ?? null"),
    });
    const strip = await js("document.querySelector('[data-build-problem]')?.textContent ?? ''");
    check(
      "the card says set-up, never that the tools aren't installed",
      /not set up yet/.test(strip) && !/aren’t installed/.test(strip),
      strip,
    );
    check(
      "the Browser badge says Needs set-up",
      await until(() => present('[data-stage-destination="web"][data-destination-state="needs-set-up"]')),
    );
    // The badges follow the store's status, read again once the build said its tools stopped it.
    const macState = () =>
      js(`document.querySelector('[data-stage-destination="macos"]')?.dataset.destinationState ?? null`);
    const mac = await until(async () => {
      const state = await macState();
      return state !== null && state !== "own-window" ? state : false;
    });
    check("the Mac chip does not claim its own window meanwhile", Boolean(mac), mac || (await macState()));
    await capture("tools-unprepared");
    await click("[data-build-install-tools]");
    check("Set up opens the Toolchain sheet", await until(() => present("[data-toolchain-sheet]")));
    fs.renameSync(aside, record);
    installEnded();
    check(
      "once the sheet is Ready, Live builds again with the sheet still open",
      await until(
        async () => !(await present("[data-build-problem]")) && (await present("[data-toolchain-sheet]")),
        BUILD_WAIT_MS,
      ),
      { problem: await buildProblem(NEW_NAME) },
    );
    await key("Escape");
    await until(async () => !(await present("[data-toolchain-sheet]")), 5_000);
  } finally {
    if (fs.existsSync(aside)) fs.renameSync(aside, record);
  }
}

/** Step 5: resizing the Live slot resizes the canvas. */
async function canvasFollowsSlot() {
  const before = await canvasSize();
  const bounds = gameView()?.getBounds();
  await click('[aria-label="Hide sidebar"]');
  const after = await until(async () => {
    const size = await canvasSize();
    return size && size.width !== before?.width && Math.abs(size.width - size.css) <= 2 ? size : false;
  });
  check("the Live slot got wider", (gameView()?.getBounds().width ?? 0) > (bounds?.width ?? 0), {
    before: bounds,
    after: gameView()?.getBounds(),
  });
  check("the canvas's drawing buffer follows the slot", Boolean(after), {
    before,
    after: after || (await canvasSize()),
  });
  await capture("slot-resized");
  await click('[aria-label="Show sidebar"]');
}

/**
 * The Mac-only game's Live slot shows the status card, and the stage names every destination. Where
 * Live can show its Mac build, that is its default (Native): Web shows the card.
 */
async function macOnlyStatusCard() {
  await openGame("pong-mac");
  if (await until(() => present("[data-stage-native-view]"), 5_000)) {
    check(
      "a Mac-only game shows its Mac build in Live by default",
      (await js(`document.querySelector('[data-stage-native-view="native"]')?.getAttribute('aria-pressed')`)) ===
        "true",
    );
    await click('[data-stage-native-view="web"]');
  }
  const card = await until(() => present("[data-stage-live-status]"));
  check("pong-mac's Live slot shows the status card", card);
  check("no web page is loaded for it", !gameUrl().startsWith("game://pong-mac/"), gameUrl());
  check("no game view covers the card", gameView() === null, gameView()?.getBounds());
  check("the stage names the Mac destination", await until(() => present('[data-stage-destination="macos"]')));
  const problem = await buildProblem("pong-mac");
  check("the reason is typed: not a destination", problem?.reason === "not-a-destination", problem);
  await capture("mac-only-status-card");
  await openGame("pong-cpp");
  const badges = await until(
    async () =>
      (await present('[data-stage-destination="web"]')) && (await present('[data-stage-destination="macos"]')),
  );
  check("pong-cpp shows both destination badges", badges);
}

await import(pathToFileURL(main).href);

async function acceptance() {
  try {
    for (let n = 0; n < 600 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    if (!fs.existsSync(path.join(profile, "controller.json"))) throw new Error("Owned app never became ready");
    win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await until(() => present("[data-studio-state]"), 60_000);
    const errors = [];
    wc.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    check(
      "the fixture seeded both C++ games",
      await until(
        async () => (await present('[data-project="pong-cpp"]')) && (await present('[data-project="pong-mac"]')),
      ),
    );
    // The same five steps on either store: the fixture's stub builds at once, the real store runs emcc.
    const started = await createFromDialog();
    await liveLoadsWebBuild(started);
    const source = await editRebuilds();
    await canvasOnStage();
    await compileErrorShown(source);
    await toolsMissingOffersSheet();
    await unpreparedToolsSetUp();
    await canvasFollowsSlot();
    await macOnlyStatusCard();
    check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    check("cpp web acceptance completed", false, String(error.stack));
    if (wc) await capture("failure").catch(() => {});
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          outputDigest: build.outputDigest,
          profile: launch.profileId,
          fixture: "cpp-game",
          store,
          providers: "fixture (no provider calls)",
          electron: process.versions.electron,
          timings,
          checks,
        },
        null,
        2,
      ),
    );
    app.quit();
  }
}
void acceptance();
