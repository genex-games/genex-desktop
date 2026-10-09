/** Runs only inside the fixture Electron launched by run-settings-ui.mjs. */
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("settings-out");
const launch = JSON.parse(fs.readFileSync(arg("studio-dev-launch"), "utf8"));
const profile = path.dirname(arg("studio-dev-launch"));
const main = arg("settings-main");
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) console.error(name, detail ?? "");
};
let win, wc;
const js = (code) => wc.executeJavaScript(code, true);
const until = async (code) => {
  for (let n = 0; n < 120; n++) {
    if (await js(code).catch(() => false)) return true;
    await wait(50);
  }
  return false;
};
const centerOf = (selector) =>
  js(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
  );
const hover = async (selector) =>
  wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await centerOf(selector)) });
const click = async (selector) => {
  const point = await centerOf(selector);
  await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await wait(300);
};
const key = async (name) => {
  const key = name === "Right" ? "ArrowRight" : name;
  const code = key;
  const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27, ArrowRight: 39 }[key] ?? 0;
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode,
    modifiers: 0,
    ...(key === "Enter" ? { text: "\r" } : {}),
  });
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
    modifiers: 0,
  });
  await wait(250);
};
const capture = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
const replace = (channel, handler) => {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (...args) => ({ ok: true, value: await handler(...args) }));
};
const emit = (type, payload) => wc.send("studio:event", { type, payload });
const nativeVisible = () =>
  win.contentView.children.some(
    (view) => view.webContents && view.webContents !== wc && view.getVisible() && view.getBounds().width > 0,
  );
/** Where the native game view paints over the page, in the page's own pixels. */
const nativeBounds = () =>
  win.contentView.children.find((view) => view.webContents && view.webContents !== wc)?.getBounds() ?? null;
const TOOLTIP = '[data-slot="tooltip-content"]';
/** The open tooltip's box once its opening animation is over, or null when none opened. */
const openTooltip = async () => {
  if (!(await until(`!!document.querySelector('${TOOLTIP}')`))) return null;
  await wait(400);
  return js(
    `(() => { const r=document.querySelector('${TOOLTIP}').getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}; })()`,
  );
};
const overlaps = (box, view) =>
  box.right > view.x && box.left < view.x + view.width && box.bottom > view.y && box.top < view.y + view.height;
await import(pathToFileURL(main).href);
async function acceptance() {
  try {
    for (let n = 0; n < 300 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    if (!fs.existsSync(path.join(profile, "controller.json"))) throw new Error("Owned app never became ready");
    win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await until(`!!document.querySelector('[aria-label="Settings"]')`);
    const errors = [];
    wc.on("console-message", (_event, ...args) => {
      if (args[0] === 3) errors.push(args[1]);
    });
    const initial = await js(`JSON.stringify({...document.querySelector('[data-studio-state]').dataset})`);
    await click('[aria-label="Prompt"]');
    await wc.debugger.sendCommand("Input.insertText", { text: "Keep this unsent idea" });
    // Live shows the game once its page has loaded and settled, a moment after the window is ready.
    for (let n = 0; n < 200 && !nativeVisible(); n++) await wait(50);
    check("fixture has a native Live game", nativeVisible());
    // The native game view paints over the whole page, tooltips included: a tooltip that reached
    // over the stage would be cut off where the game begins, so it keeps beside it.
    await hover('[aria-label="Chat actions"]');
    const tip = await openTooltip();
    const game = nativeBounds();
    check("a tooltip beside Live keeps off the native game", tip && game && !overlaps(tip, game), { tip, game });
    await hover('[aria-label="Prompt"]');
    await until(`!document.querySelector('${TOOLTIP}')`);
    await capture("sidebar");
    const nav = await js(`Array.from(document.querySelectorAll('.sidebar-action')).map(e=>e.textContent.trim())`);
    check(
      "Settings is fourth after New game, Plugins and Harness",
      nav.slice(0, 4).join("|") === "New game|Plugins|Harness|Settings",
      nav,
    );
    await click('[aria-label="Settings"]');
    check(
      "sidebar opens Model Providers",
      await until(`document.querySelector('#settings-tab-providers')?.getAttribute('aria-selected')==='true'`),
    );
    check("dialog initially focuses selected tab", await js(`document.activeElement.id==='settings-tab-providers'`));
    check("modal hides native game", !nativeVisible());
    check(
      "both provider controls are present",
      await js(
        `!!document.querySelector('[aria-label="Claude Code"]') && !!document.querySelector('[aria-label="Codex"]')`,
      ),
    );
    check(
      "enabled controls and nested icons use pointer",
      await js(
        `Array.from(document.querySelectorAll('[data-testid="settings-dialog"] button:not(:disabled),[data-testid="settings-dialog"] button:not(:disabled) svg')).every(e=>getComputedStyle(e).cursor==='pointer')`,
      ),
    );
    check(
      "section heading uses readable foreground",
      await js(
        `getComputedStyle(document.querySelector('[data-testid="settings-dialog"] h2')).color === getComputedStyle(document.body).color`,
      ),
    );
    check(
      "header is sans and navigation mono",
      await js(
        `getComputedStyle(document.querySelector('[data-testid="settings-dialog"] h2')).fontFamily.includes('Zalando') && getComputedStyle(document.querySelector('#settings-tab-local')).fontFamily.includes('Geist Mono')`,
      ),
    );
    await capture("providers-initial");
    const bounds = () =>
      js(
        `(()=>{const r=document.querySelector('[data-testid="settings-dialog"]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
      );
    const providersBounds = await bounds();
    const sectionBounds = [];
    for (const section of ["games", "appearance", "local", "providers", "harness", "permissions"]) {
      await click("#settings-tab-" + section);
      sectionBounds.push({ section, bounds: await bounds() });
    }
    check(
      "all Settings tabs keep the Appearance width, height and position",
      providersBounds[2] === 860 &&
        sectionBounds.every((s) => s.bounds.every((n, i) => Math.abs(n - providersBounds[i]) < 1)),
      sectionBounds,
    );

    for (let n = 0; n < 18; n++) await key("Tab");
    check("Tab stays within Settings", await js(`!!document.activeElement.closest('[data-testid="settings-dialog"]')`));
    await js(`document.querySelector('#settings-tab-providers').focus()`);
    await key("Right");
    check(
      "arrow selects Local Models",
      await js(
        `document.activeElement.id==='settings-tab-local' && document.querySelector('#settings-tab-local').getAttribute('aria-selected')==='true'`,
      ),
    );
    check(
      "Local Models shows downloads without provider cards",
      await until(
        `document.querySelector('#settings-panel-local')?.textContent.includes('Download') && !document.querySelector('[aria-label="Claude Code"]')`,
      ),
    );
    await capture("local-models");
    await click("#settings-panel-local button:not(:disabled)");
    check(
      "download failure stays recoverable",
      await until(
        `document.querySelector('#settings-panel-local [role="alert"]')?.textContent.includes('unsupported-in-fixture')`,
      ),
    );
    check(
      "download failure re-enables download",
      await js(`!!document.querySelector('#settings-panel-local button:not(:disabled)')`),
    );
    // A synthetic durable host job establishes reopen/hydration without downloading weights.
    const model = "bonsai-2:27b-pq2_0";
    const job = { model, active: true, phase: "download", completed: 40, total: 100 };
    replace("studio:model-install.status", () => job);
    emit("model.install", job);
    await wait(100);
    await click("#settings-tab-providers");
    await click("#settings-tab-local");
    check(
      "switching sections hydrates current download",
      await until(`document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='40'`),
    );
    await key("Escape");
    check(
      "Escape dismisses and restores sidebar focus",
      await until(
        `!document.querySelector('[data-testid="settings-dialog"]') && document.activeElement.getAttribute('aria-label')==='Settings'`,
      ),
    );
    check("native game returns after dismissal", nativeVisible());
    await click('[aria-label="Settings"]');
    check(
      "reopening hydrates current download",
      await until(`document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='40'`),
    );
    let cancelled = false;
    replace("studio:cancel-model-download", () => {
      cancelled = true;
      Object.assign(job, { active: false, phase: "cancelled" });
      emit("model.install", job);
      return true;
    });
    await click('#settings-panel-local [role="status"] button');
    check(
      "Cancel download invokes host and offers Resume at the saved share",
      cancelled &&
        (await until(
          `!document.querySelector('[aria-label^="Downloading "]') && document.querySelector('[aria-label^="Resume downloading"]') && document.querySelector('[aria-label^="Downloaded part of"]')?.getAttribute('aria-valuenow')==='40'`,
        )),
    );
    const reason = "Lost the connection to the download server.";
    emit("model.install", { ...job, phase: "failed", error: reason });
    check(
      "a failed download says why on its own row, once",
      await until(
        `[...document.querySelectorAll('#settings-panel-local [role="alert"]')].map((e) => e.textContent).join('|')===${JSON.stringify(reason)} && !!document.querySelector('[aria-label^="Resume downloading"]')`,
      ),
    );
    await capture("local-models-resume");
    await click("#settings-tab-providers");
    // Exercise the existing authentication handlers through the actual new controls, with synthetic results.
    const engines = await js("window.studio.engines()");
    engines.push({
      id: "bonsai",
      label: "Bonsai",
      kind: "direct",
      status: { code: "ready", detail: "Installed fixture" },
      models: [{ id: model, label: "Bonsai 2 27B · PQ2_0" }],
    });
    const account = (
      source,
      cli = { state: "ready", version: "2.1.280", path: "/Users/fixture/.local/bin/claude" },
    ) => ({
      source,
      afterSignOut: source === "isolated" ? "terminal" : "signed-out",
      cli,
    });
    const providers = engines.map((engine) =>
      ["codex", "claude-code"].includes(engine.id)
        ? { ...engine, status: { code: "needs_login", detail: "Sign in to connect" }, account: account("none") }
        : engine,
    );
    replace("studio:engines", () => providers);
    const signIns = [];
    replace("studio:subscription.signin", (_event, value) => {
      signIns.push(value.engine);
      return { started: false, error: "Fixture sign-in unavailable. Try again." };
    });
    emit("engines.changed", {});
    await click("#settings-tab-local");
    check(
      "installed model disables downloading again",
      await until(
        `Array.from(document.querySelectorAll('#settings-panel-local button')).some(b=>b.textContent==='Installed'&&b.disabled&&getComputedStyle(b).cursor!=='pointer')`,
      ),
    );
    // The cancelled download above is still the host's last job for this model.
    check(
      "a fully downloaded model shows no saved-share bar from an earlier stopped download",
      !(await js(`!!document.querySelector('[aria-label="Downloaded part of Bonsai 2 27B PQ2_0"]')`)),
    );
    await capture("local-installed");
    const removed = [];
    replace("studio:models.remove", (_event, value) => {
      removed.push(value.model);
      replace("studio:engines", () => providers.filter((engine) => engine.id !== "bonsai"));
      emit("engines.changed", {});
      return true;
    });
    const trash = `[aria-label="Delete Bonsai 2 27B PQ2_0"]`;
    await click(trash);
    check(
      "Delete asks first, with focus on Cancel and nothing deleted",
      removed.length === 0 &&
        (await until(
          `document.activeElement?.dataset.modelDelete==='cancel' && document.querySelector('#settings-panel-local').textContent.includes('Delete it from this Mac?')`,
        )),
    );
    await capture("local-delete-ask");
    await key("Enter");
    check(
      "Cancel keeps the model and returns focus to its Delete button",
      removed.length === 0 && (await until(`document.activeElement?.matches(${JSON.stringify(trash)})`)),
    );
    await click(trash);
    await click('[data-model-delete="confirm"]');
    check(
      "Delete removes the model through the host and the row offers Download again",
      (await until(`!!document.querySelector('[aria-label="Download Bonsai 2 27B PQ2_0"]')`)) &&
        removed.join("|") === model,
      removed,
    );
    check(
      "focus stays inside Settings once the deleted row changes",
      await js(`!!document.activeElement?.closest('[data-testid="settings-dialog"]')`),
    );
    replace("studio:engines", () => providers);
    emit("engines.changed", {});
    await click("#settings-tab-providers");
    await until(
      `document.querySelector('[aria-label="Claude Code"] [data-variant="default"]')?.textContent==='Sign in'`,
    );
    check(
      "signed-out rows offer one Sign in action and name the plan",
      await js(
        `['Claude Code','Codex'].every(n=>{const r=document.querySelector('[aria-label="'+n+'"]');return r.textContent.includes('Not connected')&&r.querySelectorAll('button').length===1;}) && document.querySelector('[aria-label="Codex"]').textContent.includes('ChatGPT Plus or Pro')`,
      ),
    );
    await capture("model-providers");
    await click('[aria-label="Claude Code"] [data-variant="default"]');
    await click('[aria-label="Codex"] [data-variant="default"]');
    check("connection buttons invoke Claude Code and Codex", signIns.join("|") === "claude-code|codex", signIns);
    check(
      "connection errors retain retry controls",
      await js(
        `document.querySelector('[aria-label="Codex"]').textContent.includes('Try again') && !document.querySelector('[aria-label="Codex"] [data-variant="default"]').disabled`,
      ),
    );
    await capture("provider-error");
    // Connected through Studio's own login, plus a provider whose CLI is gone.
    const connected = providers.map((engine) =>
      engine.id === "claude-code"
        ? {
            ...engine,
            status: { code: "ready", detail: "signed in for Studio only" },
            usage: { measuredAt: new Date().toISOString(), plan: "max", windows: [] },
            account: account("isolated"),
          }
        : engine.id === "codex"
          ? {
              ...engine,
              status: { code: "not_installed", detail: "missing" },
              account: account("none", { state: "missing" }),
            }
          : engine,
    );
    replace("studio:engines", () => connected);
    emit("engines.changed", {});
    check(
      "connected row shows version beside the name and one account line",
      await until(
        `(()=>{const r=document.querySelector('[aria-label="Claude Code"]');return r.querySelector('h3').nextElementSibling?.textContent==='2.1.280' && r.textContent.includes('Max plan · Signed in for Studio only') && r.textContent.includes('Connected');})()`,
      ),
    );
    check(
      "a connected row's status sits on a plate and a fresh model list adds no line or buttons",
      await js(
        `(()=>{const r=document.querySelector('[aria-label="Claude Code"]');return r.querySelector('.status-plate[data-tone="connected"]')?.textContent==='Connected' && !r.querySelector('[data-model-catalog]') && !Array.from(r.querySelectorAll('button')).some(b=>['Refresh models','Update Claude Code'].includes(b.textContent));})()`,
      ),
    );
    check(
      "missing CLI offers Install and a recheck, never a path picker",
      await js(
        `(()=>{const r=document.querySelector('[aria-label="Codex"]');return r.textContent.includes('Not installed') && Array.from(r.querySelectorAll('button')).map(b=>b.textContent).join('|')==='Install Codex|Check again';})()`,
      ),
    );
    check(
      "providers never show file paths or executable choices",
      await js(
        `(()=>{const t=document.querySelector('#settings-panel-providers').textContent;return ['Choose executable','CLI installation','engine-homes','/Users/'].every(w=>!t.includes(w));})()`,
      ),
    );
    await click('[aria-label="Claude Code account"]');
    check(
      "account menu offers recheck, the CLI update, another account and the Terminal login",
      await until(
        `Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent).join('|')==='Check connectionAlso refreshes the model list|Update Claude CodeYou have 2.1.280|Use a different account…Your Terminal login stays as it is|Switch back to your Terminal loginSigns Studio out of this account'`,
      ),
    );
    await capture("provider-account-menu");
    await key("Escape");
    check(
      "Escape closes the account menu before the dialog",
      await until(
        `!document.querySelector('[role="menu"]') && !!document.querySelector('[data-testid="settings-dialog"]')`,
      ),
    );
    await capture("providers-connected");
    await key("Escape");
    // The model list's Add more models route restores the stable composer trigger.
    await click('[aria-label="Model settings"]');
    await click('[data-role="planner"]');
    const add = await js(
      `Array.from(document.querySelectorAll('[data-model-list] button')).find(b=>b.textContent==='Add more models')?.outerHTML`,
    );
    check("the model list offers Add more models", Boolean(add));
    await js(
      `Array.from(document.querySelectorAll('[data-model-list] button')).find(b=>b.textContent==='Add more models')?.focus()`,
    );
    await key("Enter");
    check(
      "Add more models opens Model Providers",
      await until(`document.querySelector('#settings-tab-providers')?.getAttribute('aria-selected')==='true'`),
    );
    await key("Escape");
    check(
      "model settings route restores composer trigger focus",
      await until(
        `!document.querySelector('[data-testid="settings-dialog"]') && document.activeElement.getAttribute('aria-label')==='Model settings'`,
      ),
    );
    check(
      "unsent composer draft is preserved",
      await js(`document.querySelector('[aria-label="Prompt"]').value==='Keep this unsent idea'`),
    );
    check(
      "workspace selection is preserved",
      initial === (await js(`JSON.stringify({...document.querySelector('[data-studio-state]').dataset})`)),
    );
    await click('[aria-label="Settings"]');
    win.setMinimumSize(0, 0);
    win.setContentSize(1000, 720);
    wc.setZoomFactor(2);
    await wait(350);
    check(
      "200% zoom switches navigation to a horizontal row",
      await js(`getComputedStyle(document.querySelector('.settings-layout')).flexDirection==='column'`),
    );
    check(
      "compact dialog fits without horizontal overflow",
      await js(
        `(()=>{const d=document.querySelector('[data-testid="settings-dialog"]'),p=document.querySelector('[role="tabpanel"]'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&p.scrollWidth<=p.clientWidth+1;})()`,
      ),
    );
    await capture("settings-200-percent");
    await click("#settings-tab-local");
    check(
      "local downloads remain reachable at 200% zoom",
      await js(
        `!!document.querySelector('#settings-panel-local button') && document.querySelector('#settings-panel-local').scrollWidth<=document.querySelector('#settings-panel-local').clientWidth+1`,
      ),
    );
    await capture("local-models-200-percent");
    wc.setZoomFactor(1);
    win.setContentSize(860, 720);
    await wait(300);
    await capture("settings-compact-window");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await key("Escape");
    await click('[aria-label="Show sidebar"]');
    await click('[aria-label="Settings"]');
    check(
      "Settings opens from the compact sidebar drawer",
      await until(`!!document.querySelector('[data-testid="settings-dialog"]')`),
    );
    check(
      "reduced motion disables dialog animation",
      await js(
        `parseFloat(getComputedStyle(document.querySelector('[data-testid="settings-dialog"]')).animationDuration)<0.001`,
      ),
    );
    await key("Escape");
    check(
      "compact dismissal restores the drawer entry",
      await until(`document.activeElement.getAttribute('aria-label')==='Settings'`),
    );
    check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    check("settings acceptance completed", false, String(error.stack));
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
          providers: "fixture with synthetic connection/download states",
          electron: process.versions.electron,
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
