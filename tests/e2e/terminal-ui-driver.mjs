/** Real app + native PTY, synthetic fixed command only. No user shell or provider account. */
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("terminal-out"),
  main = arg("terminal-main");
const launch = JSON.parse(fs.readFileSync(arg("studio-dev-launch"), "utf8"));
const profile = path.dirname(arg("studio-dev-launch"));
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [],
  errors = [],
  timings = {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** How many times the resize check asks the PTY its size before it calls the resize lost. */
const RESIZE_ASKS = 20;
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) console.error(name, detail ?? "");
};
let win, wc;
const js = (code) => wc.executeJavaScript(code, true);
/** Poll a renderer expression (a string) or a main-side probe (a function) until it holds. */
const until = async (probe) => {
  for (let n = 0; n < 200; n++) {
    const held = Promise.resolve().then(() => (typeof probe === "function" ? probe() : js(probe)));
    if (await held.catch(() => false)) return true;
    await wait(50);
  }
  return false;
};
const text = () => js(`document.querySelector('[data-terminal-dock]')?.textContent ?? ''`);
const key = async (key, modifiers = 0, code = key) => {
  const windowsVirtualKeyCode = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, Tab: 9, c: 67 }[key] ?? 0;
  const params = { key, code, windowsVirtualKeyCode, modifiers };
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
    ...params,
    type: "keyDown",
    ...(key === "Enter" ? { text: "\r" } : {}),
  });
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
};
/**
 * The centre of `selector` once a click there reaches it. Its box can be laid out before the page
 * hit-tests it there (just after start-up, or as a reply arrives): a click at that moment lands on
 * the page behind it, as the prompt's did, and focuses nothing.
 */
const clickPoint = async (selector) => {
  const probe = `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); const x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2); return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null; })()`;
  let point = null;
  await until(async () => {
    point = await js(probe);
    return point;
  });
  if (!point) throw new Error(`Nothing at ${selector} takes a click`);
  return point;
};
const click = async (selector) => {
  const point = await clickPoint(selector);
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
  await wait(100);
};
const command = async (value) => {
  await js(
    `document.querySelector('[data-terminal-dock] [data-terminal-view]:not([hidden]) .xterm-helper-textarea')?.focus()`,
  );
  await wc.debugger.sendCommand("Input.insertText", { text: value });
  await key("Enter");
};
/**
 * Ask the PTY its rows until it reports more than `rows`. It hears of a resize only once the dock
 * has grown and the view refitted, which a slow runner does after any fixed wait would end. Each
 * ask is numbered so its answer is found even after earlier ones scrolled out of view.
 */
const rowsAbove = async (rows) => {
  const asked = [];
  for (let n = 1; n <= RESIZE_ASKS; n++) {
    await command(`size-${n}`);
    const answer = `size-${n}:`;
    if (!(await until(async () => (await text()).includes(answer)))) break;
    const reported = Number((await text()).split(answer)[1].match(/^\s*(\d+)/)?.[1]);
    asked.push(reported);
    if (reported > rows) return { grew: true, asked };
  }
  return { grew: false, asked };
};
const capture = async (name) => {
  await wait(200);
  fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
};
const replace = (channel, handler) => {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, payload) => ({ ok: true, value: await handler(payload) }));
};
const fixtureDir = path.join(profile, "terminal fixture");
fs.mkdirSync(fixtureDir, { recursive: true });
const script = path.join(fixtureDir, "fixture.sh");
fs.writeFileSync(
  script,
  String.raw`#!/bin/sh
stty -echo
trap 'printf "\nINTERRUPTED\n"' INT
printf '\033[32mReady — fixture terminal\033[0m\n'
while IFS= read -r line; do
  case "$line" in
    ping) printf 'PONG\n';;
    size) printf 'SIZE:'; stty size;;
    size-*) printf '%s:' "$line"; stty size;;
    burst) awk 'BEGIN {for(i=0;i<12000;i++) print "load-test-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789"; print "BURST_DONE"}';;
    tree) /bin/sh -c 'trap "" TERM HUP; while :; do sleep 1; done' & printf 'CHILD:%s\n' "$!";;
    exit) exit 0;;
    *) printf 'INPUT:%s\n' "$line";;
  esac
done
`,
);
const fixture = (project) => ({
  file: "/bin/sh",
  args: [script],
  cwd: fixtureDir,
  env: { HOME: fixtureDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  title: "Fixture game",
  kind: "shell",
  project,
});
async function acceptance() {
  // main.mjs is the boot entry (compile cache, then app.mjs); the app's exports live in app.mjs.
  await import(pathToFileURL(main));
  const { terminals } = await import(new URL("./app.mjs", pathToFileURL(main)).href);
  await app.whenReady();
  try {
    for (let n = 0; n < 200 && !win; n++) {
      win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Dev"));
      if (!win) await wait(50);
    }
    if (!win) throw new Error("No fixture window");
    // X11 does not allocate a capture/paint surface for the parked macOS fixture position.
    // This owned fixture is displayed only inside the Linux runner's Xvfb desktop.
    if (process.platform === "linux") {
      win.setPosition(0, 0);
      win.showInactive();
    }
    wc = win.webContents;
    wc.setBackgroundThrottling(false);
    wc.on("console-message", (details) => {
      if (details.level === 3) errors.push(details.message);
    });
    // The fixture reloads the window onto its game thread before its runtime starts
    // (controller.json): a Prompt on the page before that reload is gone a moment later.
    const started = () => fs.existsSync(path.join(profile, "controller.json"));
    const promptReady = `(()=>{const p=document.querySelector('[aria-label="Prompt"]');return p&&!p.disabled&&!p.closest('[inert]')&&getComputedStyle(p).visibility==='visible';})()`;
    if (!(await until(async () => started() && (await js(promptReady)))))
      throw new Error("Fixture did not become ready");
    await js(
      `document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`,
    );
    wc.debugger.attach("1.3");
    const native = () => win.contentView.children.find((view) => view.webContents && view.webContents !== wc);
    const nativeVisible = () => {
      const view = native();
      return Boolean(view?.getVisible() && view.getBounds().width > 0);
    };
    // Main hides the game view whenever the stage covers it; a hide between two reads is a blink
    // the reads alone would miss, so every hide is timed.
    let lastHidden = -1;
    const gameView = native();
    if (gameView) {
      const setVisible = gameView.setVisible.bind(gameView);
      gameView.setVisible = (visible) => {
        if (!visible) lastHidden = performance.now();
        return setVisible(visible);
      };
    }
    const shownSince = (since) => ({ visible: nativeVisible(), hiddenSince: lastHidden >= since });
    await click('[aria-label="Prompt"]');
    await wc.debugger.sendCommand("Input.insertText", { text: "Preserve this draft" });
    if (!(await until(`document.querySelector('[aria-label="Prompt"]').value==='Preserve this draft'`)))
      throw new Error("Fixture could not enter the initial draft");
    check(
      "terminal code is lazy before opening",
      await js(`!performance.getEntriesByType('resource').some(r=>r.name.includes('TerminalView'))`),
    );
    const before = await js(`document.querySelector('[aria-label="Prompt"]').getBoundingClientRect().top`);
    const blocked = await js(
      `window.studio.terminalOpen('fixture-game').then(()=>false,e=>e.message.includes('unsupported-in-fixture'))`,
    );
    check("fixture blocks the actual project shell", blocked);
    replace("studio:terminal.open", (payload) => terminals.open(fixture(payload.project)));
    // Live keeps the game view hidden behind its loader until the page settles; only a game
    // already on the stage can show whether the terminal leaves it there.
    if (!(await until(nativeVisible))) throw new Error("Fixture game did not reach the stage");
    const start = performance.now();
    await click('[aria-label="Toggle terminal"]');
    check(
      "native PTY displays output",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('Ready')`),
      terminals.list(),
    );
    timings.openToOutputMs = Math.round(performance.now() - start);
    const chatAfter = await js(
      `({top:document.querySelector('[aria-label="Prompt"]').getBoundingClientRect().top,draft:document.querySelector('[aria-label="Prompt"]').value})`,
    );
    check(
      "terminal shrinks the chat and preserves its draft",
      chatAfter.top < before && chatAfter.draft === "Preserve this draft",
      { before, ...chatAfter },
    );
    const beside = shownSince(start);
    check("game remains visible beside terminal", beside.visible && !beside.hiddenSince, beside);
    if (native()) {
      check(
        "game has no terminal bridge",
        await native().webContents.executeJavaScript(`typeof window.studio === 'undefined'`),
      );
      // A hidden view has no surface to capture, and the throw would cut the remaining checks.
      if (beside.visible)
        fs.writeFileSync(path.join(out, "game.png"), (await native().webContents.capturePage()).toPNG());
    }
    await command("hello 🌱");
    check(
      "Unicode input reaches the process",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('INPUT:hello 🌱')`),
    );
    await command("size");
    check(
      "terminal reports its fitted dimensions",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('SIZE:')`),
    );
    const sizeBefore = Number((await text()).match(/SIZE:\s*(\d+)\s+(\d+)/)?.[1]);
    await js(`document.querySelector('[aria-label="Terminal height"]').focus()`);
    await key("ArrowUp");
    await key("ArrowUp");
    const resized = await rowsAbove(sizeBefore);
    check("keyboard resize reaches the PTY", resized.grew, resized.asked);
    await capture("terminal");
    const id = terminals.list()[0].id;
    await click('[aria-label="Hide terminal"]');
    check(
      "Hide restores chat space and focus without stopping",
      (await js(
        `document.querySelector('[data-terminal-dock]').hidden && document.activeElement.hasAttribute('data-terminal-toggle') && document.querySelector('[aria-label="Prompt"]').getBoundingClientRect().top >= ${before - 1}`,
      )) && terminals.list()[0].phase === "running",
    );
    // A reply offers a command; Run starts it without opening the dock, its output shows under the
    // block, and when it ends the chat reports its exit code and last lines as the next message.
    replace("studio:terminal.run", (payload) =>
      terminals.open({
        ...fixture(payload.project),
        // Like a real install, it is still tidying up for a moment after its last line.
        args: [
          "-c",
          "printf '\\033[34m==>\\033[0m Downloading ffmpeg\\n\\033[34m==>\\033[0m Pouring ffmpeg--7.1.arm64_sequoia.bottle.tar.gz\\n/opt/homebrew/Cellar/ffmpeg/7.1: 285 files, 52.3MB\\n'; sleep 0.5",
        ],
        kind: "command",
        title: payload.command,
        command: payload.command,
      }),
    );
    await click('[aria-label="Prompt"]');
    await js(`(() => { const p = document.querySelector('[aria-label="Prompt"]'); p.select(); })()`);
    await wc.debugger.sendCommand("Input.insertText", { text: "fixture:command convert the engine sounds" });
    await key("Enter");
    check(
      "a reply offers its one-line command with Run and Copy",
      await until(
        `!!document.querySelector('[data-command-run] button[aria-label="Run in terminal"]') && !!document.querySelector('[data-command-run] button[aria-label="Copy command"]')`,
      ),
    );
    await click('[data-command-run] button[aria-label="Run in terminal"]');
    check(
      "the command's output shows under its block while the dock stays hidden",
      await until(
        `document.querySelector('[data-command-output]')?.textContent.includes('Pouring ffmpeg') && document.querySelector('[data-terminal-dock]').hidden`,
      ),
      terminals.list(),
    );
    // Its last lines show before it has exited: read its exit code once the session has ended.
    await until(() => terminals.list().some((session) => session.kind === "command" && session.phase === "exited"));
    const ran = terminals.list().find((session) => session.kind === "command");
    check(
      "a finished command reports its exit code and plain last lines",
      ran?.exitCode === 0 && ran?.output?.at(-1) === "/opt/homebrew/Cellar/ffmpeg/7.1: 285 files, 52.3MB",
      ran,
    );
    check(
      "the chat tells the agent how the command went, without a bubble, and the same session answers",
      (await until(
        `[...document.querySelectorAll('[data-chat-entry]')].some((e) => e.textContent.includes('A coast at night, understood.'))`,
      )) &&
        !(await js(
          `[...document.querySelectorAll('[data-chat-entry]')].some((e) => e.textContent.includes('I ran this in the terminal'))`,
        )),
    );
    await capture("command-run");
    if (ran) terminals.remove(ran.id);
    await terminals.write(id, "ping\r");
    await click('[aria-label="Toggle terminal"]');
    check(
      "reopen retains output and the same process",
      (await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('PONG')`)) &&
        terminals.list()[0].id === id,
    );
    await js(`document.querySelector('.xterm-helper-textarea').focus()`);
    await key("Escape", 8);
    check(
      "Shift+Escape reaches terminal controls",
      await js(`document.activeElement.getAttribute('aria-label')==='Hide terminal'`),
    );
    const burstAt = performance.now();
    await command("burst");
    await click('[aria-label="Prompt"]');
    await wc.debugger.sendCommand("Input.insertText", { text: " during output" });
    check(
      "chat stays responsive while output streams",
      await js(`document.querySelector('[aria-label="Prompt"]').value.endsWith(' during output')`),
    );
    check(
      "large output completes with bounded scrollback",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('BURST_DONE')`),
      (await text()).slice(-300),
    );
    await capture("after-burst");
    timings.burstMs = Math.round(performance.now() - burstAt);
    const during = shownSince(burstAt);
    check("game stays visible during output", during.visible && !during.hiddenSince, during);
    await command("tree");
    check(
      "fixture starts an owned child",
      await until(`/CHILD:[0-9]+/.test(document.querySelector('[data-terminal-dock]')?.textContent)`),
    );
    const childPid = Number((await text()).match(/CHILD:(\d+)/)?.[1]);
    await js(
      `Array.from(document.querySelectorAll('[data-terminal-dock] button')).find(b=>b.textContent==='Stop').click()`,
    );
    check(
      "Stop settles the process",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('Process stopped')`),
    );
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    check(
      "Stop also reaps a child that ignores TERM and HUP",
      Number.isInteger(childPid) && childPid > 1 && !childAlive,
      { childPid },
    );
    check(
      "enabled controls and nested icons have pointer cursors",
      await js(
        `Array.from(document.querySelectorAll('[data-terminal-dock] button:not(:disabled),[data-terminal-dock] button:not(:disabled) svg')).every(e=>getComputedStyle(e).cursor==='pointer')`,
      ),
    );
    await click('[aria-label="Settings"]');
    const urls = [];
    const login = terminals.open({
      ...fixture(undefined),
      kind: "claude-login",
      title: "Claude Code sign-in",
      args: [
        "-c",
        'printf "Open https://claude.com/oauth?state=private&code_challenge=hidden\\nPaste code > "; read code; printf "Finished\\n"',
      ],
      onUrl: (url) => urls.push(url),
    });
    check(
      "managed sign-in reveals terminal outside Settings",
      await until(
        `!document.querySelector('[data-testid="settings-dialog"]') && !document.querySelector('[data-terminal-dock]').hidden && document.querySelector('[data-terminal-dock]')?.textContent.includes('Paste code >')`,
      ),
    );
    check(
      "sign-in URL stays out of rendered output and session metadata",
      !(await text()).includes("code_challenge") &&
        !JSON.stringify(terminals.list()).includes("private") &&
        urls.length === 1,
    );
    wc.send("studio:claude-login", { phase: "terminal", revision: 100, hasBrowserUrl: true });
    let browserOpened = false;
    replace("studio:claude-login.browser", () => {
      browserOpened = true;
    });
    await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('Open the sign-in page')`);
    await js(
      `Array.from(document.querySelectorAll('[data-terminal-dock] button')).find(b=>b.textContent==='Open the sign-in page').click()`,
    );
    check("sign-in pane can open its private browser link", browserOpened);
    await wait(200);
    check(
      "sign-in terminal owns input focus after Settings closes",
      await js(`document.activeElement.classList.contains('xterm-helper-textarea')`),
    );
    await capture("sign-in");
    await terminals.stop(login.id);
    wc.send("studio:claude-login", { phase: "cancelled", revision: 101, hasBrowserUrl: false });
    win.setMinimumSize(0, 0);
    win.setContentSize(1000, 800);
    wc.setZoomFactor(2);
    await wait(300);
    check(
      "dock controls fit at 200% zoom",
      await js(
        `(()=>{const d=document.querySelector('[data-terminal-dock]'),r=d.getBoundingClientRect(),b=d.querySelector('[aria-label="Hide terminal"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&b.bottom<=innerHeight+1&&b.right<=r.right+1&&document.documentElement.scrollWidth<=innerWidth;})()`,
      ),
    );
    check(
      "shortened chat keeps its composer scrollable",
      await js(
        `(()=>{const c=document.querySelector('[data-chat-composer]'),r=c.getBoundingClientRect(),p=c.parentElement.getBoundingClientRect();return r.top>=p.top-1&&r.bottom<=p.bottom+1&&getComputedStyle(c).overflowY==='auto';})()`,
      ),
    );
    await capture("terminal-200-percent");
    wc.setZoomFactor(1);
    win.setContentSize(1080, 800);
    await wait(100);
    await terminals.dispose();
    await until(`!document.querySelector('[data-terminal-view]')`);
    await click('[aria-label="Open project terminal"]');
    check(
      "new session can start after cleanup",
      await until(`document.querySelector('[data-terminal-dock]')?.textContent.includes('Ready')`),
      terminals.list(),
    );
    await capture("after-cleanup");
    await js(
      `window.dispatchEvent(new StorageEvent('storage',{key:'studio.appearance.v1',newValue:JSON.stringify({version:1,mode:'light',codeFont:'system'})}))`,
    );
    await wait(200);
    check(
      "open terminal follows appearance without restarting",
      (await js(
        `(()=>{const rows=document.querySelector('.xterm-rows');const span=document.createElement('span');span.style.color='var(--foreground)';document.body.append(span);const match=getComputedStyle(rows).color===getComputedStyle(span).color;span.remove();return document.documentElement.dataset.theme==='light'&&match;})()`,
      )) && terminals.list()[0]?.phase === "running",
    );
    await capture("terminal-light");
    const loaded = new Promise((resolve) => wc.once("did-finish-load", resolve));
    wc.reload();
    await loaded;
    check(
      "renderer reload cleans terminal processes",
      await until(
        `!!document.querySelector('[aria-label="Prompt"]') && window.studio.terminalList().then(list=>list.length===0)`,
      ),
    );
    check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    check("terminal acceptance completed", false, String(error.stack));
    if (wc) await capture("failure").catch(() => {});
  } finally {
    await terminals.dispose();
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          outputDigest: build.outputDigest,
          profile: launch.profileId,
          providers: "fixture; fixed /bin/sh script, no account access",
          electron: process.versions.electron,
          platform: process.platform,
          arch: process.arch,
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
