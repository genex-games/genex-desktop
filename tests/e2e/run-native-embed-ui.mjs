/**
 * Live's Web | Native view (M5a L4), in an owned `studio:dev` fixture profile over the
 * `native-game` fixture, with no provider calls and no game process: the fixture's scripted
 * registry answers `nativeEmbed` with a ready embedded run that draws no frames, and says the
 * input, resizes and sight it then receives in that run's `native.log` (`fixture-native-runs.ts`).
 * `npm run test:ui -- native-embed-ui` checks:
 *
 * - pong-cpp (Browser + Mac) has Web | Native, Web by default; Native mounts the canvas, takes the
 *   web game view off the stage (zero bounds), embeds at the slot's size and shows Pop out;
 * - a window resize reaches `nativeResize` at the slot's new size; a click captures, a key press
 *   reaches `nativeInput` as a keydown, Esc releases, and nothing is sent while released;
 * - Assets hides Live and the fixture records the pause, Live shows it again;
 * - Stop in Native ends the embedded run and the stage says the game is stopped; Play embeds again;
 * - light and dark screenshots at 1440 and 1100 px;
 * - Pop out unembeds and asks for the Mac window (the fixture policy refuses Play on Mac, so the
 *   refusal toast is the proof it was asked), and Live is back on Web;
 * - pong-mac (Mac only) plays in Live by default once its own window is gone;
 * - a Three.js game created from the dialog has no toggle;
 * - the host refusing embedding for the session hides the toggle and says why once.
 *
 * Real frames, IME and gamepads are not in the fixture: the integrator's live check covers frames.
 * This file is both the runner (under Node) and the driver Electron runs (under Electron).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
/** The scripted registry's fixture. */
const FIXTURE = "native-game";
const RUN_TIMEOUT_MS = 6 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const STEP_WAIT_MS = 30_000;
/** How long a released canvas is watched for input that must not be sent. */
const QUIET_MS = 1_000;
/** The Three.js game the run creates from the dialog. */
const THREE_GAME = "Paper Plane";
const THREE_NAME = "paper-plane";

/** Builds the app (or reuses `options.buildId`), launches it in a fresh `native-game` profile with this file as its driver. */
export async function runNativeEmbedDriver(options = {}) {
  const { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } = await import(
    "../../scripts/electron-runtime.mjs"
  );
  const { writeJson } = await import("../../scripts/studio-dev/files.mjs");
  const { allocateProfile, assertStopped } = await import("../../scripts/studio-dev/ownership.mjs");
  const id = `native-embed-${randomUUID().slice(0, 8)}`;
  const buildId = options.buildId ?? `b-${randomUUID()}`;
  const owner = allocateProfile(root, id, "fixture", FIXTURE);
  const out = path.join(root, ".studio-dev/evidence", id);
  fs.mkdirSync(out, { recursive: true });
  if (!options.buildId) {
    const built = await run(
      process.execPath,
      ["scripts/build.mjs", `--dev-build=${buildId}`],
      process.env,
      BUILD_TIMEOUT_MS,
    );
    if (built !== 0) throw new Error("the native embed L4 build failed");
  }
  const env = fixtureElectronEnv();
  delete env.GENEX_FIXTURE_TOOLCHAIN_STORE;
  writeJson(path.join(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
  const code = await run(
    resolveElectron(root),
    fixtureElectronArgs([
      SELF,
      `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
      `--embed-main=${path.join(root, ".studio-dev/builds", buildId, "main/main.mjs")}`,
      `--embed-out=${out}`,
    ]),
    env,
    RUN_TIMEOUT_MS,
  );
  const reportFile = path.join(out, "report.json");
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : { checks: [] };
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.ok ? "" : ` — ${JSON.stringify(check.detail)}`}`);
  console.log(`native embed L4: ${report.checks.filter((check) => check.ok).length}/${report.checks.length}`);
  console.log(reportFile);
  assertStopped(owner);
  return { ok: code === 0 && report.checks.length > 0 && report.checks.every((check) => check.ok), report };
}

async function run(exe, args, env, timeoutMs) {
  const child = spawn(exe, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));
  try {
    return await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── the driver, inside the fixture Electron ─────────────────────────────────────────────────

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Page script: keeps every `native.status` and `native.log` the page hears, for the checks to read. */
const RECORD_EVENTS = `(() => {
  if (window.__embedL4) return true;
  window.__embedL4 = { statuses: [], logs: [] };
  window.studio.onEvent((event) => {
    if (event.type === "native.status") window.__embedL4.statuses.push(event.payload);
    if (event.type === "native.log") window.__embedL4.logs.push(...event.payload.lines.map((line) => ({ project: event.payload.project, runId: event.payload.runId, line })));
  });
  return true;
})()`;

/** Everything the driver's steps share: the window, its page, the checks and where evidence goes. */
function driverContext(electron) {
  const launchFile = arg("studio-dev-launch");
  const ctx = {
    electron,
    out: arg("embed-out"),
    launch: JSON.parse(fs.readFileSync(launchFile, "utf8")),
    profile: path.dirname(launchFile),
    main: arg("embed-main"),
    checks: [],
    win: null,
    wc: null,
  };
  ctx.check = (name, ok, detail) => {
    ctx.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? "✔" : "✖"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  };
  ctx.js = (code) => ctx.wc.executeJavaScript(code, true);
  ctx.present = (selector) => ctx.js(`!!document.querySelector(${JSON.stringify(selector)})`);
  ctx.text = (selector) => ctx.js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  ctx.until = async (probe, ms = STEP_WAIT_MS) => {
    const end = Date.now() + ms;
    let value;
    while (Date.now() < end) {
      value = await probe().catch(() => false);
      if (value) return value;
      await wait(150);
    }
    return value;
  };
  ctx.settled = () =>
    ctx.until(() => ctx.js('document.getAnimations().every((a) => a.playState !== "running")'), 5_000);
  ctx.capture = async (name) => {
    // A parked fixture window may return its previous compositor surface after a theme/size
    // change. Show this owned window without focus, then wait for the new frame before capture.
    if (ctx.win.isMinimized()) ctx.win.restore();
    ctx.win.showInactive();
    await ctx.js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await ctx.settled();
    fs.writeFileSync(path.join(ctx.out, `${name}.png`), (await ctx.wc.capturePage()).toPNG());
  };
  ctx.click = async (selector) => {
    await ctx.until(() => ctx.js("!document.activeViewTransition"));
    const point = await ctx.js(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await ctx.wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    await wait(250);
  };
  /** One key pressed and let go, as a keyboard sends it (`text` for a printable key). */
  ctx.key = async ({ key, code, keyCode, text }) => {
    await ctx.wc.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      ...(text ? { text } : {}),
    });
    await ctx.wc.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
    await wait(200);
  };
  ctx.theme = async (scheme) => {
    await ctx.wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    const switched = await ctx.until(
      () => ctx.js(`document.documentElement.dataset.theme === ${JSON.stringify(scheme)}`),
      5_000,
    );
    if (!switched) throw new Error(`the window never switched to ${scheme}`);
  };
  ctx.openGame = async (name) => {
    await ctx.until(() => ctx.present(`[data-project="${name}"]`));
    await ctx.click(`[data-project="${name}"]`);
    await ctx.until(
      async () => (await ctx.js("document.querySelector('[data-studio-state]')?.dataset.project")) === name,
    );
  };
  /** The Live web game view: the one child view that is not the studio page and has an area. */
  ctx.gameView = () =>
    ctx.win.contentView.children.find(
      (view) => view.webContents && view.webContents !== ctx.wc && view.getVisible() && view.getBounds().width > 0,
    ) ?? null;
  ctx.logs = (project) =>
    ctx.js(`window.__embedL4.logs.filter((l) => l.project === ${JSON.stringify(project)}).map((l) => l.line)`);
  ctx.statuses = (project) =>
    ctx.js(
      `window.__embedL4.statuses.filter((s) => s.project === ${JSON.stringify(project)} && s.mode === "embedded")`,
    );
  ctx.toasts = () => ctx.js(`[...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? "")`);
  return ctx;
}

/**
 * The ring the canvas asks the game for: its CSS size in device pixels and the screen's ratio, as
 * main turns the embed size into a surface (`ringSizeFor`; no cap reached at these window sizes).
 */
const CANVAS_RING = `(() => {
  const c = document.querySelector('[data-stage-native-canvas]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const dpr = devicePixelRatio;
  return { width: Math.round(Math.round(r.width) * dpr), height: Math.round(Math.round(r.height) * dpr), dpr };
})()`;

/** A log line naming `ring` the way the fixture writes a surface (`resize: WxH @dpr`, `embed: WxH @dpr`). */
const names = (line, verb, ring) => line === `${verb}: ${ring.width}x${ring.height} @${ring.dpr}`;

/** Web | Native on a Browser + Mac game: the toggle, Native's canvas, the web view off the stage, the embed. */
async function nativeView(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-cpp");
  check("pong-cpp offers Web | Native", await ctx.until(() => ctx.present('[data-stage-native-view="native"]')));
  check(
    "Web is the default for a game with a Browser build",
    (await ctx.js(`document.querySelector('[data-stage-native-view="web"]')?.getAttribute('aria-pressed')`)) === "true",
  );
  await ctx.click('[data-stage-native-view="native"]');
  check("Native mounts Live's canvas", await ctx.until(() => ctx.present("[data-stage-native-canvas]")));
  check(
    "the embedded run is ready: Click to play",
    await ctx.until(() => ctx.present('[data-stage-native-canvas="playing"] [data-stage-native-capture]')),
    { canvas: await ctx.js(`document.querySelector('[data-stage-native-canvas]')?.dataset.stageNativeCanvas`) },
  );
  check("the web game view leaves the stage (zero bounds)", await ctx.until(async () => ctx.gameView() === null), {
    view: ctx.gameView()?.getBounds() ?? null,
  });
  check(
    "Pop out takes Play on Mac's place",
    (await ctx.present("[data-stage-native-popout]")) && !(await ctx.present("[data-stage-native-play]")),
  );
  const embedded = await ctx.until(async () => (await ctx.statuses("pong-cpp")).find((s) => s.state === "ready"));
  check("nativeEmbed answered a ready embedded run", Boolean(embedded), await ctx.statuses("pong-cpp"));
  const size = await ctx.js(CANVAS_RING);
  const embedLine = await ctx.until(async () =>
    (await ctx.logs("pong-cpp")).find((line) => names(line, "embed", size)),
  );
  check("nativeEmbed was asked for the slot's size", Boolean(embedLine), { size, logs: await ctx.logs("pong-cpp") });
}

/** Resizing the window reaches `nativeResize` at the slot's new size. */
async function resizeReachesGame(ctx) {
  const { check } = ctx;
  ctx.win.setContentSize(1100, 900);
  await wait(500);
  const size = await ctx.js(CANVAS_RING);
  const line = await ctx.until(async () => (await ctx.logs("pong-cpp")).find((entry) => names(entry, "resize", size)));
  check("a resize reaches nativeResize at the slot's new size", Boolean(line), {
    size,
    logs: await ctx.logs("pong-cpp"),
  });
  ctx.win.setContentSize(1440, 900);
  await wait(500);
}

/** A click captures; a key reaches `nativeInput` as a keydown; Esc releases; nothing is sent while released. */
async function captureAndRelease(ctx) {
  const { check } = ctx;
  const inputs = async () => (await ctx.logs("pong-cpp")).filter((line) => line.startsWith("input:"));
  await ctx.click("[data-stage-native-capture]");
  check(
    "a click captures the keyboard and mouse",
    await ctx.until(() => ctx.present("[data-stage-native-canvas][data-captured]")),
  );
  check("the release hint says how to give them back", await ctx.present("[data-stage-native-hint]"));
  const before = (await inputs()).length;
  await ctx.key({ key: "w", code: "KeyW", keyCode: 87, text: "w" });
  const sent = await ctx.until(async () => (await inputs()).slice(before).find((line) => /\bdown\b/.test(line)));
  check("a key press reaches nativeInput as a keydown", Boolean(sent), await inputs());
  await ctx.capture("native-embed-captured");
  await ctx.key({ key: "Escape", code: "Escape", keyCode: 27 });
  check("Esc releases", await ctx.until(async () => !(await ctx.present("[data-stage-native-canvas][data-captured]"))));
  check("Click to play is back", await ctx.present("[data-stage-native-capture]"));
  await wait(QUIET_MS);
  const released = (await inputs()).length;
  await ctx.key({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
  await wait(QUIET_MS);
  check("nothing is sent while released", (await inputs()).length === released, await inputs());
}

/** Assets hides Live: the fixture records the pause; Live shows it again. */
async function hiddenLivePauses(ctx) {
  const { check } = ctx;
  const sight = async () => (await ctx.logs("pong-cpp")).filter((line) => line === "hidden" || line === "shown");
  const before = (await sight()).length;
  await ctx.click('[data-stage-action="assets"]');
  check(
    "hiding Live pauses the embedded run",
    await ctx.until(async () => (await sight()).slice(before).includes("hidden")),
    await sight(),
  );
  check("the canvas stays mounted while hidden (its run is kept)", await ctx.present("[data-stage-native-canvas]"));
  await ctx.click('[data-stage-action="live"]');
  check(
    "Live shown again resumes it",
    await ctx.until(async () => (await sight()).slice(before).includes("shown")),
    await sight(),
  );
}

/** Stop in Native ends the embedded run and says the game is stopped; Play embeds it again. */
async function stopEndsNative(ctx) {
  const { check } = ctx;
  const ended = async () =>
    (await ctx.statuses("pong-cpp")).filter((s) => ["stopping", "stopped"].includes(s.state)).length;
  const readies = async () => (await ctx.statuses("pong-cpp")).filter((s) => s.state === "ready").length;
  const endedBefore = await ended();
  const readyBefore = await readies();
  await ctx.click('button[aria-label="Stop game"]');
  check(
    "Stop in Native ends the embedded run",
    await ctx.until(async () => (await ended()) > endedBefore),
    await ctx.statuses("pong-cpp"),
  );
  check(
    "Stop takes Live's canvas away",
    await ctx.until(async () => !(await ctx.present("[data-stage-native-canvas]"))),
  );
  check("the stage says the game is stopped", await ctx.until(() => ctx.present('[data-stage-empty="stopped"]')));
  await ctx.click('button[aria-label="Play game"]');
  check("Play mounts the canvas again", await ctx.until(() => ctx.present("[data-stage-native-canvas]")));
  check(
    "Play embeds a new run",
    await ctx.until(async () => (await readies()) > readyBefore),
    await ctx.statuses("pong-cpp"),
  );
  check(
    "Click to play is back on the new run",
    await ctx.until(() => ctx.present('[data-stage-native-canvas="playing"] [data-stage-native-capture]')),
  );
}

/** Native in both themes at the two supported widths. */
async function screenshots(ctx) {
  for (const width of [1440, 1100]) {
    ctx.win.setContentSize(width, 900);
    await wait(400);
    for (const scheme of ["light", "dark"]) {
      await ctx.theme(scheme);
      await ctx.capture(`native-embed-${width}-${scheme}`);
    }
  }
  ctx.win.setContentSize(1440, 900);
  await ctx.theme("light");
}

/** Pop out: unembed, Web again, and Play on Mac asked for (the fixture policy refuses it, which is said). */
async function popOut(ctx) {
  const { check } = ctx;
  const toasts = await ctx.toasts();
  await ctx.click("[data-stage-native-popout]");
  check(
    "Pop out ends the embedded run",
    await ctx.until(async () =>
      (await ctx.statuses("pong-cpp")).some((s) => ["stopping", "stopped"].includes(s.state)),
    ),
    await ctx.statuses("pong-cpp"),
  );
  check(
    "Live is back on Web, with no canvas",
    await ctx.until(async () => !(await ctx.present("[data-stage-native-canvas]"))),
  );
  check(
    "the toggle says Web",
    (await ctx.js(`document.querySelector('[data-stage-native-view="web"]')?.getAttribute('aria-pressed')`)) === "true",
  );
  const asked = await ctx.until(async () => {
    const now = await ctx.toasts();
    return now.length > toasts.length && now.some((text) => /fixture|live profile/i.test(text)) ? now : false;
  }, 10_000);
  check(
    "Pop out asked for the Mac window (refused by the fixture policy, and said)",
    Boolean(asked),
    await ctx.toasts(),
  );
}

/** pong-mac has no Browser build: once its own window is gone, Live shows its Mac build by default. */
async function macOnlyDefaultsToNative(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-mac");
  if (await ctx.until(() => ctx.present('[data-stage-native-action="stop"]'), 10_000)) {
    check("while its own window plays, Live shows no second copy", !(await ctx.present("[data-stage-native-canvas]")));
    await ctx.click('[data-stage-native-action="stop"]');
  }
  check(
    "a Mac-only game shows its Mac build in Live by default",
    await ctx.until(() => ctx.present("[data-stage-native-canvas]")),
  );
  check(
    "its toggle says Native",
    (await ctx.js(`document.querySelector('[data-stage-native-view="native"]')?.getAttribute('aria-pressed')`)) ===
      "true",
  );
}

/**
 * A Three.js game, created from the dialog, has no Web | Native. New game is Home; the dialog is
 * Home's compiled entry, on Three.js when it offers a choice of stacks (a browser game otherwise).
 */
async function threeJsHasNoToggle(ctx) {
  const { check } = ctx;
  await ctx.click('[aria-keyshortcuts="Meta+N Control+N"]');
  await ctx.until(() => ctx.present("[data-home-cpp]"));
  await ctx.click("[data-home-cpp]");
  await ctx.until(() => ctx.present('[data-testid="create-game-dialog"]'));
  if (await ctx.until(() => ctx.present("[data-toolchain-sheet]"), 2_000)) {
    await ctx.key({ key: "Escape", code: "Escape", keyCode: 27 });
    await ctx.until(async () => !(await ctx.present("[data-toolchain-sheet]")));
  }
  if (await ctx.present('[data-create-game-stack="three-js"]')) await ctx.click('[data-create-game-stack="three-js"]');
  await ctx.click('[aria-label="Game name"]');
  await ctx.wc.debugger.sendCommand("Input.insertText", { text: THREE_GAME });
  await ctx.click('[data-testid="create-game-dialog"] button[type="submit"]');
  const opened = await ctx.until(
    async () => (await ctx.js("document.querySelector('[data-studio-state]')?.dataset.project")) === THREE_NAME,
  );
  check("a Three.js game opens", opened);
  await ctx.until(() => ctx.present("[data-stage-strip]"));
  check("a Three.js game has no Web | Native", !(await ctx.present("[data-stage-native-view]")));
}

/** The host refusing embedding for the session hides the toggle everywhere and says why once. */
async function unsupportedHidesToggle(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-cpp");
  await ctx.until(() => ctx.present('[data-stage-native-view="native"]'));
  await ctx.click('[data-stage-native-view="native"]');
  await ctx.until(() => ctx.present("[data-stage-native-canvas]"));
  const toasts = await ctx.toasts();
  const at = new Date().toISOString();
  ctx.wc.send("studio:event", {
    type: "native.status",
    payload: {
      project: "pong-cpp",
      runId: "",
      target: "macos",
      state: "refused",
      mode: "embedded",
      pid: null,
      backend: null,
      refusal: "embed-unsupported",
      problem: null,
      exit: null,
      owner: null,
      startedAt: at,
      endedAt: at,
    },
  });
  check(
    "embedding refused for the session hides the toggle",
    await ctx.until(async () => !(await ctx.present("[data-stage-native-view]"))),
  );
  check(
    "Live is back on the web build",
    await ctx.until(async () => !(await ctx.present("[data-stage-native-canvas]"))),
  );
  check("Play on Mac is the way on", await ctx.present("[data-stage-native-play]"));
  const said = await ctx.until(async () => {
    const now = await ctx.toasts();
    return now.length > toasts.length && now.some((text) => /can’t show the game inside Live/.test(text)) ? now : false;
  }, 10_000);
  check("why is said once", Boolean(said), await ctx.toasts());
  await ctx.openGame("pong-mac");
  check("no other game offers it either", !(await ctx.present("[data-stage-native-view]")));
}

async function drive() {
  const electron = await import("electron");
  const ctx = driverContext(electron);
  const build = JSON.parse(fs.readFileSync(path.resolve(ctx.main, "../../build.json"), "utf8"));
  await import(pathToFileURL(ctx.main).href);
  const errors = [];
  try {
    for (let n = 0; n < 600 && !fs.existsSync(path.join(ctx.profile, "controller.json")); n++) await wait(100);
    if (!fs.existsSync(path.join(ctx.profile, "controller.json"))) throw new Error("Owned app never became ready");
    ctx.win = electron.BrowserWindow.getAllWindows()[0];
    ctx.wc = ctx.win.webContents;
    if (!ctx.wc.debugger.isAttached()) ctx.wc.debugger.attach("1.3");
    await ctx.until(() => ctx.present("[data-studio-state]"), 60_000);
    ctx.wc.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    ctx.win.setContentSize(1440, 900);
    await ctx.js(RECORD_EVENTS);
    ctx.check(
      "the fixture seeded both C++ games",
      await ctx.until(
        async () =>
          (await ctx.present('[data-project="pong-cpp"]')) && (await ctx.present('[data-project="pong-mac"]')),
      ),
    );
    await nativeView(ctx);
    await resizeReachesGame(ctx);
    await captureAndRelease(ctx);
    await hiddenLivePauses(ctx);
    await stopEndsNative(ctx);
    await screenshots(ctx);
    await popOut(ctx);
    await macOnlyDefaultsToNative(ctx);
    await threeJsHasNoToggle(ctx);
    await unsupportedHidesToggle(ctx);
    ctx.check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    ctx.check("native embed acceptance completed", false, String(error.stack));
    if (ctx.wc) await ctx.capture("failure").catch(() => {});
  } finally {
    fs.writeFileSync(
      path.join(ctx.out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          profile: ctx.launch.profileId,
          fixture: FIXTURE,
          providers: "fixture (no provider calls, no game process, no frames)",
          electron: process.versions.electron,
          checks: ctx.checks,
        },
        null,
        2,
      ),
    );
    electron.app.quit();
  }
}

if (process.versions.electron) void drive();
else if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  const at = process.argv.indexOf("--build-id");
  const { ok } = await runNativeEmbedDriver(at >= 0 ? { buildId: process.argv[at + 1] } : {});
  if (!ok) process.exitCode = 1;
}
