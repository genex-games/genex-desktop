import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import type { EventEmitter } from "node:events";
import path from "node:path";
import { onSoundShortcut } from "../../src/main/game-sound.ts";
import { GamePreview, registerGameScheme } from "../../src/main/preview.ts";
import { PreviewPool } from "../../src/substrate/preview-pool.ts";
import { PreviewConsoleSource, PreviewGone } from "../../src/shared/preview-contract.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "studio-preview-visibility-"));
app.setPath("userData", path.join(root, "profile"));
registerGameScheme();
app.on("window-all-closed", () => {});
const events: unknown[] = [];
const checks: { name: string; ok: boolean }[] = [];
const mark = (event: string, details = {}) => events.push({ at: Date.now(), event, ...details });
const check = (name: string, ok: boolean) => checks.push({ name, ok });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  try {
    await mkdir(path.join(root, "fixture"));
    await writeFile(
      path.join(root, "fixture/index.html"),
      `<canvas width="320" height="200"></canvas><script>
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
    window.framesDrawn=0;window.keys=0;addEventListener('keydown',()=>window.keys++);
    function draw(){framesDrawn++;ctx.fillStyle='#168b85';ctx.fillRect(0,0,320,200);requestAnimationFrame(draw)}draw();
    window.__studio={capture:()=>canvas.toDataURL('image/png')};
  </script>`,
    );
    for (const mode of ["foreground", "background", "hidden", "minimized", "private"]) {
      const offscreen = mode === "private";
      const win = new BrowserWindow({
        width: 320,
        height: 240,
        show: false,
        focusable: !offscreen,
        skipTaskbar: true,
        fullscreenable: !offscreen,
        webPreferences: { offscreen },
      });
      mark("created", { mode, id: win.id });
      const visibility: string[] = [];
      for (const event of ["show", "hide", "focus", "blur", "minimize", "restore", "enter-full-screen"] as const) {
        (win as EventEmitter).on(event, () => {
          visibility.push(event);
          mark(event, { mode, id: win.id });
        });
      }
      const port = new GamePreview({
        gamesRoot: root,
        vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
        partition: `visibility-${mode}`,
        offscreen,
      });
      port.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
      const wc = port.view!.webContents;
      wc.on("did-start-navigation", () => mark("navigation", { mode }));
      mark("bounds", { mode, bounds: port.view!.getBounds() });
      await port.load("fixture");
      if (mode === "foreground" || mode === "minimized") win.show();
      if (mode === "background") win.showInactive();
      if (mode !== "private" && mode !== "hidden") await pause(600);
      if (mode === "minimized") {
        win.minimize();
        await pause(1000);
      }
      visibility.length = 0;
      check(`${mode}: page capture works`, (await port.screenshot()).length > 100);
      check(`${mode}: page capture preserves visibility`, visibility.length === 0);
      // Deterministically reproduce the recovery branch seen when Chromium loses its surface.
      // Keep the real window and compositor; inject only the two unavailable capture signals.
      const execute = wc.executeJavaScript.bind(wc);
      const capture = wc.capturePage.bind(wc);
      wc.executeJavaScript = ((code: string, gesture?: boolean) =>
        code.includes("var readInfo = function")
          ? Promise.resolve(null)
          : execute(code, gesture)) as typeof wc.executeJavaScript;
      let attempts = 0;
      wc.capturePage = (async (...args: Parameters<typeof wc.capturePage>) => {
        attempts++;
        if (attempts === 1) throw new Error("fixture: compositor surface unavailable");
        return capture(...args);
      }) as typeof wc.capturePage;
      visibility.length = 0;
      mark("forced-capture-failure", { mode });
      await port.screenshot().catch((error) => mark("capture-unavailable", { mode, error: String(error) }));
      check(
        `${mode}: recovery never shows, restores or focuses`,
        !visibility.some((e) => ["show", "restore", "focus"].includes(e)),
      );
      check(`${mode}: recovery retries once`, attempts === 2);
      visibility.length = 0;
      wc.capturePage = async () => {
        throw new Error("fixture: permanent capture failure");
      };
      let unavailable = false;
      await port.screenshot().catch(() => {
        unavailable = true;
      });
      check(
        `${mode}: permanent failure is reported without exposing window`,
        unavailable && !visibility.some((e) => ["show", "restore", "focus"].includes(e)),
      );
      wc.executeJavaScript = execute;
      wc.capturePage = capture;
      if (offscreen) {
        visibility.length = 0;
        await port.input([{ type: "press", combo: "w" }]);
        await port.reload();
        check("private: reload capture works", (await port.screenshot()).length > 100);
        check(
          "private: input/reload never expose window",
          !visibility.some((e) => ["show", "restore", "focus"].includes(e)),
        );
      }
      port.destroy();
      win.destroy();
    }
    // Parallel builders/playtesters have separate private windows and input state.
    await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const win = new BrowserWindow({
          width: 320,
          height: 240,
          show: false,
          focusable: false,
          skipTaskbar: true,
          fullscreenable: false,
          webPreferences: { offscreen: true },
        });
        const exposed: string[] = [];
        mark("parallel-created", { index, id: win.id });
        for (const event of ["show", "focus", "restore", "enter-full-screen"] as const) {
          (win as EventEmitter).on(event, () => {
            exposed.push(event);
            mark(event, { index, id: win.id });
          });
        }
        const port = new GamePreview({
          gamesRoot: root,
          vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
          partition: `visibility-parallel-${index}`,
          offscreen: true,
        });
        try {
          port.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
          await port.load("fixture");
          await port.input([{ type: "press", combo: "w" }]);
          check(`parallel ${index}: input delivered`, Number(await port.evaluate("window.keys")) > 0);
          check(`parallel ${index}: capture works`, (await port.screenshot()).length > 100);
          await port.reload();
          check(`parallel ${index}: reload capture works`, (await port.screenshot()).length > 100);
          check(`parallel ${index}: stays private`, exposed.length === 0 && !win.isVisible());
        } finally {
          port.destroy();
          win.destroy();
        }
      }),
    );
    await checkStandIn();
    await checkMutedAgentWindow();
    await checkRendererGone();
  } catch (error) {
    mark("error", { error: String(error) });
    check("fixture completed", false);
  } finally {
    const result = { checks, events, passed: checks.every((c) => c.ok), electron: process.versions.electron };
    await writeFile(process.env.STUDIO_VISIBILITY_REPORT!, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    app.exit(result.passed ? 0 : 1);
  }
}
/**
 * The harness's stand-in: the hidden window the pool opens when a harness call names none. It is
 * made like a builder's window, never shows, and loading, playing and reloading in it never
 * navigates the live view the person is watching (docs/product/builds-live.md).
 */
async function checkStandIn(): Promise<void> {
  const liveWin = new BrowserWindow({ width: 320, height: 240, show: false });
  const live = new GamePreview({
    gamesRoot: root,
    vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
    partition: "visibility-live",
  });
  live.attachTo(liveWin, { x: 0, y: 0, width: 320, height: 200 });
  await live.load("fixture");
  let liveNavigations = 0;
  live.view!.webContents.on("did-start-navigation", () => liveNavigations++);
  const exposed: string[] = [];
  const windows: BrowserWindow[] = [];
  const pool = new PreviewPool({
    live,
    max: 0,
    createHeadless: async () => {
      const win = new BrowserWindow({
        width: 320,
        height: 240,
        show: false,
        focusable: false,
        skipTaskbar: true,
        fullscreenable: false,
        webPreferences: { offscreen: true },
      });
      for (const event of ["show", "focus", "restore", "enter-full-screen"] as const) {
        (win as EventEmitter).on(event, () => {
          exposed.push(event);
          mark(event, { standIn: true, id: win.id });
        });
      }
      windows.push(win);
      const port = new GamePreview({
        gamesRoot: root,
        vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
        partition: "visibility-stand-in",
        offscreen: true,
      });
      port.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
      port.dispose = () => {
        port.destroy();
        if (!win.isDestroyed()) win.destroy();
      };
      return port;
    },
  });
  try {
    const { handle } = await pool.standIn();
    const standIn = pool.port(handle);
    await standIn.load("fixture");
    await standIn.input([{ type: "press", combo: "w" }]);
    await standIn.reload();
    check("stand-in: capture works", (await standIn.screenshot()).length > 100);
    check("stand-in: never shows", exposed.length === 0 && windows.every((win) => !win.isVisible()));
    check("stand-in: the live view never navigates", liveNavigations === 0);
    check("stand-in: takes no builder's window", pool.leaseCount === 0);
  } finally {
    await pool.closeStandIn();
    live.destroy();
    liveWin.destroy();
  }
}

/**
 * An agent's window is silent from the moment it is made, and its own ears still work: the page's
 * analyser measures a tone the speakers never play, as `__studio.audio()` reads one. Live's switch
 * turns the same speakers on and off.
 */
async function checkMutedAgentWindow(): Promise<void> {
  await writeFile(
    path.join(root, "fixture/tone.html"),
    `<script>
    const ctx=new AudioContext(),osc=ctx.createOscillator(),an=ctx.createAnalyser();
    osc.connect(an);an.connect(ctx.destination);osc.start();
    window.rms=()=>{const b=new Float32Array(an.fftSize);an.getFloatTimeDomainData(b);return Math.sqrt(b.reduce((s,v)=>s+v*v,0)/b.length)};
    window.running=()=>ctx.state;
  </script>`,
  );
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true },
  });
  const port = new GamePreview({
    gamesRoot: root,
    vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
    partition: "visibility-muted",
    offscreen: true,
    muted: true,
  });
  try {
    port.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
    await port.load("fixture", "tone.html");
    const wc = port.view!.webContents;
    check("muted: an agent's window is silent from the start", wc.isAudioMuted());
    await pause(800);
    const state = String(await port.evaluate("window.running()"));
    const rms = Number(await port.evaluate("window.rms()"));
    mark("muted-analyser", { state, rms });
    check("muted: its page's audio keeps running", state === "running");
    check("muted: its page's analyser still hears the tone", rms > 0.05);
    port.setAudioMuted(false);
    check("live: the switch turns the speakers on", !wc.isAudioMuted());
    port.setAudioMuted(true);
    check("live: and off again", wc.isAudioMuted());
    // ⌥⌘M while the game has the keyboard reaches the studio, once, and never the page.
    await port.evaluate("(window.keys=0, addEventListener('keydown',()=>window.keys++), true)");
    let toggles = 0;
    onSoundShortcut(wc, () => toggles++);
    wc.sendInputEvent({ type: "keyDown", keyCode: "M", modifiers: ["alt", "meta"] });
    wc.sendInputEvent({ type: "keyUp", keyCode: "M", modifiers: ["alt", "meta"] });
    wc.sendInputEvent({ type: "keyDown", keyCode: "M" });
    await pause(300);
    mark("sound-shortcut", { toggles, pageKeys: Number(await port.evaluate("window.keys")) });
    check("live: ⌥⌘M in the game toggles the sound once", toggles === 1);
    check(
      "live: the game never sees ⌥⌘M, and still gets its own keys",
      Number(await port.evaluate("window.keys")) === 1,
    );
  } finally {
    port.destroy();
    win.destroy();
  }
}
/**
 * A game window whose renderer dies says why (`preview.status` `gone`, beside `crashed`), from
 * Electron's own `render-process-gone` reason, and says nothing once its page is back.
 */
async function checkRendererGone(): Promise<void> {
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true },
  });
  const port = new GamePreview({
    gamesRoot: root,
    vendorDir: path.join(process.cwd(), "dist/resources/vendor"),
    partition: "visibility-gone",
    offscreen: true,
  });
  try {
    port.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
    await port.load("fixture");
    const running = port.status();
    check("gone: a running window gives no reason", !running.crashed && running.gone === null);
    const wc = port.view!.webContents;
    const died = new Promise<string>((resolve) => {
      wc.once("render-process-gone", (_event, details) => resolve(details.reason));
    });
    wc.forcefullyCrashRenderer();
    const reason = await died;
    const dead = port.status();
    mark("renderer-gone", { reason, gone: dead.gone });
    const codes: readonly unknown[] = Object.values(PreviewGone);
    check("gone: a dead window says it crashed", dead.crashed);
    check("gone: and why, as one typed code", codes.includes(dead.gone));
    check(
      "gone: its console line is the studio's own, typed, never an error the build logged",
      port.consoleEntries().some((entry) => entry.source === PreviewConsoleSource.WindowGone),
    );
    await port.reload();
    const back = port.status();
    mark("renderer-back", { crashed: back.crashed, gone: back.gone });
    check("gone: a reloaded window gives no reason again", !back.crashed && back.gone === null);
  } finally {
    port.destroy();
    win.destroy();
  }
}
void main();
