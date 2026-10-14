/**
 * The native run card (M2 L4), in an owned `studio:dev` fixture profile over the `native-game`
 * fixture, with no provider calls and no game process: the fixture's scripted registry runs
 * pong-mac's Mac window. Two suites, one driver:
 *
 * - `card` (`npm run test:ui -- native-card-ui`): Play on Mac is there and enabled; the card says
 *   Running; Bring to front asks `nativeFront`, which the fixture policy refuses, and the refusal is
 *   said without a crash; Stop ends the run and the card says Stopped under the window's heading; a
 *   refused Mac build (announced as the registry would) shows the build's words with the card's
 *   own Install tools and Try again, never the build strip's selectors; a Mac build that failed to
 *   compile says the Mac build failed with its clang line and Try again, never Live's "last working
 *   build" sentence, and the strip's Mac chip says Build failed; light and dark screenshots.
 * - `layout` (run by `run-cpp-web-ui.mjs`): beside the native card, pong-mac's Live status card
 *   keeps its title, drops the sentence the card already says, and clips nothing; Publish is
 *   absent for pong-mac and present for pong-cpp; a store whose `prewarm.json` names another
 *   recipe makes Live's build offer Set up again and the Toolchain sheet offer setting Browser up
 *   again, and ANGLE for Mac says it is not published.
 * - `cross` (`npm run test:ui -- native-card-ui --suite cross`, and run by `run-cpp-web-ui.mjs`):
 *   over the `cross-game` fixture, pong-cross's badges read the checks its library holds: Windows
 *   says Built, not run on this Mac, and Linux says Build failed with the ELF gate's refusal, out
 *   loud on the strip; hovering or focusing the badges shows both in the tooltip; ⋯ → Export game…
 *   lists Export for Browser, Mac, Windows (.zip) and Linux (.tar.gz), and choosing Windows is the
 *   fixture's refusal (`studio:export` is native), said in a toast; light and dark screenshots at
 *   1440 and 1100 px with no word clipped.
 *
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
/** Each suite's fixture: the scripted registry's, or the one whose library holds Windows and Linux checks. */
const FIXTURE_OF = { card: "native-game", layout: "native-game", cross: "cross-game" };
const SUITES = Object.keys(FIXTURE_OF);
/** The window widths the cross suite's badges are seen at, and the themes. */
const CROSS_WIDTHS = [1440, 1100];
const CROSS_THEMES = ["light", "dark"];
const RUN_TIMEOUT_MS = 6 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const STEP_WAIT_MS = 30_000;

/**
 * Builds the app (or reuses `options.buildId`), launches it in a fresh `native-game` profile with
 * this file as its driver, and answers the report. The profile's store is always the fixture's own:
 * the layout suite rewrites its `prewarm.json`, which a linked developer store must never see.
 */
export async function runNativeDriver(suite, options = {}) {
  if (!SUITES.includes(suite)) throw new Error(`--suite takes ${SUITES.join(" or ")}`);
  const { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } = await import(
    "../../scripts/electron-runtime.mjs"
  );
  const { writeJson } = await import("../../scripts/studio-dev/files.mjs");
  const { allocateProfile, assertStopped } = await import("../../scripts/studio-dev/ownership.mjs");
  const id = `native-${suite}-${randomUUID().slice(0, 8)}`;
  const buildId = options.buildId ?? `b-${randomUUID()}`;
  const fixture = FIXTURE_OF[suite];
  const owner = allocateProfile(root, id, "fixture", fixture);
  const out = path.join(root, ".studio-dev/evidence", id);
  fs.mkdirSync(out, { recursive: true });
  if (!options.buildId) {
    const built = await run(
      process.execPath,
      ["scripts/build.mjs", `--dev-build=${buildId}`],
      process.env,
      BUILD_TIMEOUT_MS,
    );
    if (built !== 0) throw new Error("the native card L4 build failed");
  }
  const env = fixtureElectronEnv();
  delete env.GENEX_FIXTURE_TOOLCHAIN_STORE;
  writeJson(path.join(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
  const code = await run(
    resolveElectron(root),
    fixtureElectronArgs([
      SELF,
      `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
      `--native-main=${path.join(root, ".studio-dev/builds", buildId, "main/main.mjs")}`,
      `--native-out=${out}`,
      `--native-suite=${suite}`,
    ]),
    env,
    RUN_TIMEOUT_MS,
  );
  const reportFile = path.join(out, "report.json");
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : { checks: [] };
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.ok ? "" : ` — ${JSON.stringify(check.detail)}`}`);
  console.log(`native ${suite} L4: ${report.checks.filter((check) => check.ok).length}/${report.checks.length}`);
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

/** Everything the driver's steps share: the window, its page, the checks and where evidence goes. */
function driverContext(electron) {
  const launchFile = arg("studio-dev-launch");
  const profile = path.dirname(launchFile);
  const ctx = {
    electron,
    out: arg("native-out"),
    suite: arg("native-suite") ?? "card",
    launch: JSON.parse(fs.readFileSync(launchFile, "utf8")),
    profile,
    coreRoot: JSON.parse(fs.readFileSync(path.join(profile, "owner.json"), "utf8")).core,
    main: arg("native-main"),
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
  ctx.key = async (name) => {
    for (const type of ["keyDown", "keyUp"])
      await ctx.wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: 27,
      });
    await wait(200);
  };
  /** Switches the system scheme the profile follows; a window that does not switch fails the run. */
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
  return ctx;
}

/** A toast saying the fixture profile refused something, since the click. */
async function refusalToast(ctx, before) {
  return ctx.until(async () => {
    const toasts = await ctx.js(`[...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? "")`);
    return toasts.length > before.length && toasts.some((text) => /fixture|live profile/i.test(text)) ? toasts : false;
  }, 10_000);
}

const toastTexts = (ctx) => ctx.js(`[...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? "")`);

/** The card suite: Running, Bring to front refused and said, Stop, Stopped, in both themes. */
async function cardSuite(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-mac");
  const play = "[data-stage-native-play]";
  check("Play on Mac is on the strip", await ctx.until(() => ctx.present(play)));
  check(
    "Play on Mac is enabled on a Mac",
    await ctx.js(
      `(() => { const b=document.querySelector('${play}'); return !!b && !b.disabled && b.getAttribute('aria-disabled')!=='true' && getComputedStyle(b).cursor==='pointer'; })()`,
    ),
  );
  check("the card says the window runs", await ctx.until(() => ctx.present('[data-stage-native-card="ready"]')), {
    card: await ctx.text("[data-stage-native-card]"),
  });
  check(
    "its words are the running state's",
    /Running in its own window/.test(await ctx.text("[data-stage-native-card]")),
  );
  check(
    "Running offers Bring to front and Stop",
    (await ctx.present('[data-stage-native-action="front"]')) &&
      (await ctx.present('[data-stage-native-action="stop"]')),
  );
  await ctx.theme("light");
  await ctx.capture("native-card-running-light");
  await ctx.theme("dark");
  await ctx.capture("native-card-running-dark");
  await ctx.theme("light");
  const before = await toastTexts(ctx);
  await ctx.click('[data-stage-native-action="front"]');
  check("Bring to front's refusal in the fixture is said", await refusalToast(ctx, before), await toastTexts(ctx));
  check("the card keeps running after the refusal", await ctx.present('[data-stage-native-card="ready"]'));
  check("the window still renders", (await ctx.present("[data-stage-strip]")) && !ctx.wc.isCrashed());
  await ctx.click('[data-stage-native-action="stop"]');
  check(
    "Stop ends the run: the card says Stopped",
    await ctx.until(() => ctx.present('[data-stage-native-card="stopped"]')),
    {
      card: await ctx.text("[data-stage-native-card]"),
    },
  );
  check("Stopped offers Restart", await ctx.present('[data-stage-native-action="restart"]'));
  check(
    "a Stop the person asked for has no Details",
    !(await ctx.present('[data-stage-native-card="stopped"] details')),
  );
  const stopped = await ctx.text("[data-stage-native-card]");
  check("an ended run's card no longer says it plays", !/playing/i.test(stopped), stopped);
  await ctx.capture("native-card-stopped-light");
  await ctx.theme("dark");
  await ctx.capture("native-card-stopped-dark");
  await ctx.theme("light");
  await refusedBuild(ctx);
}

/** A refused Mac build of pong-mac whose tools are missing, as the registry announces one. */
function refusedBuildStatus(problem = {}) {
  const at = new Date().toISOString();
  return {
    project: "pong-mac",
    runId: `l4-refused-${randomUUID().slice(0, 8)}`,
    target: "macos",
    state: "refused",
    mode: "window",
    pid: null,
    backend: null,
    refusal: "build-failed",
    problem: {
      project: "pong-mac",
      command: "",
      code: null,
      lines: [],
      needsInstall: false,
      install: null,
      showingLastBuild: false,
      at,
      reason: "toolchain-missing",
      target: "macos",
      ...problem,
    },
    exit: null,
    owner: null,
    startedAt: at,
    endedAt: at,
  };
}

/**
 * The fixture's registry starts nothing, so the refusal is announced the way the registry would
 * (`native.status`). The card says it with its own buttons; Install tools opens the sheet.
 */
async function refusedBuild(ctx) {
  const { check } = ctx;
  ctx.wc.send("studio:event", { type: "native.status", payload: refusedBuildStatus() });
  const card = '[data-stage-native-card="refused"]';
  check("a refused Mac build shows on the card", await ctx.until(() => ctx.present(card)), {
    card: await ctx.text("[data-stage-native-card]"),
  });
  check(
    "it offers the card's own Install tools and Try again",
    (await ctx.present(`${card} [data-stage-native-action="install-tools"]`)) &&
      (await ctx.present(`${card} [data-stage-native-action="try-again"]`)),
  );
  const refused = await ctx.text(card);
  check(
    "it says the Mac build failed, under Play on Mac, not a window",
    /The Mac build failed/.test(refused) && !/Mac window/.test(refused),
    refused,
  );
  const shared = await ctx.js(
    `[...document.querySelectorAll('${card} [data-build-problem], ${card} [data-build-install-tools], ${card} button[aria-label="Try the build again"]')].length`,
  );
  check("the card shares no selector with the build strip", shared === 0, shared);
  check(
    "one Try again on the page, and no Restart: no window ever opened",
    (await ctx.js(`document.querySelectorAll('[data-stage-native-action="try-again"]').length`)) === 1 &&
      (await ctx.js(`document.querySelectorAll('[data-stage-native-action="restart"]').length`)) === 0,
  );
  await ctx.capture("native-card-build-failed-light");
  await ctx.theme("dark");
  await ctx.capture("native-card-build-failed-dark");
  await ctx.theme("light");
  await ctx.click(`${card} [data-stage-native-action="install-tools"]`);
  check("Install tools opens the Toolchain sheet", await ctx.until(() => ctx.present("[data-toolchain-sheet]")));
  await ctx.key("Escape");
  await ctx.until(async () => !(await ctx.present("[data-toolchain-sheet]")), 5_000);
  await macCompileFailed(ctx);
}

/** The clang line a broken src/main.cpp gave the acceptance tester's Mac build (ACC-04). */
const CLANG_LINE = {
  tool: "clang",
  file: "src/main.cpp",
  line: 58,
  column: 150,
  message: "use of undeclared identifier 'platform'; did you mean 'studio::platform'?",
};

/**
 * A Mac build that failed to compile, while Live still had a last good web build (ACC-04): the card
 * says the Mac build failed with its clang line and Try again; never the web strip's sentence about
 * the last working build; the strip's Mac chip says Build failed.
 */
async function macCompileFailed(ctx) {
  const { check } = ctx;
  const failed = refusedBuildStatus({
    command: "cmake --build",
    code: 1,
    reason: "command-failed",
    showingLastBuild: true,
    diagnostics: [CLANG_LINE],
  });
  ctx.wc.send("studio:event", { type: "native.status", payload: failed });
  const card = '[data-stage-native-card="refused"]';
  const said = await ctx.until(async () => {
    const text = await ctx.text(card);
    return text.includes("src/main.cpp:58:150") ? text : false;
  });
  check("a failed Mac build shows its clang line on the card", Boolean(said), await ctx.text(card));
  check(
    "it says the Mac build failed and to fix the error",
    /The Mac build failed/.test(said || "") && /Fix the error, then try again/.test(said || ""),
    said,
  );
  check(
    "never the web build's last-working-build sentence",
    !/last working build|newest changes/i.test(said || ""),
    said,
  );
  check(
    "it offers Try again, and no Install tools",
    (await ctx.present(`${card} [data-stage-native-action="try-again"]`)) &&
      !(await ctx.present(`${card} [data-stage-native-action="install-tools"]`)),
  );
  check(
    "the strip's Mac chip says Build failed",
    await ctx.until(() => ctx.present('[data-stage-destination="macos"][data-destination-state="failed"]')),
    { chip: await ctx.text('[data-stage-destination="macos"]') },
  );
  await ctx.capture("native-card-compile-failed-light");
  await ctx.theme("dark");
  await ctx.capture("native-card-compile-failed-dark");
  await ctx.theme("light");
}

/** How the Live status card's words fit: every line whole, nothing scrolled or cut, and what it says. */
const LIVE_CARD_FIT = `(() => {
  const card = document.querySelector('[data-stage-live-status]');
  if (!card) return null;
  const [title, copy] = ['.empty-state-title', '.empty-state-copy'].map((s) => card.querySelector(s));
  if (!title || !copy) return { missing: true };
  // The sentence under the title is left out when the card keeps its title alone.
  const subtitle = card.querySelector('.empty-state-subtitle');
  const fits = (e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight + 1;
  const nowrap = (e) => getComputedStyle(e).whiteSpace === 'nowrap';
  const words = card.querySelector('.empty-state-words').getBoundingClientRect();
  const slot = card.querySelector('.empty-state-slot').getBoundingClientRect();
  return {
    title: fits(title), subtitle: subtitle ? fits(subtitle) : true, copy: fits(copy),
    ellipsis: nowrap(title) || (subtitle ? nowrap(subtitle) : false),
    lines: subtitle ? Math.round(subtitle.getBoundingClientRect().height / parseFloat(getComputedStyle(subtitle).lineHeight)) : 0,
    overlap: words.bottom > slot.top + 1,
    text: subtitle ? subtitle.textContent : "",
  };
})()`;

/** The layout suite: the Live card beside the native card, Publish per destination, and the stale prewarm sheet. */
async function layoutSuite(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-mac");
  check("pong-mac shows the native card", await ctx.until(() => ctx.present("[data-stage-native-card]")));
  check(
    "pong-mac's Live shows its status card",
    await ctx.until(() => ctx.present('[data-stage-live-status="own-window"]')),
  );
  for (const width of [1440, 1100]) {
    ctx.win.setContentSize(width, 900);
    await wait(400);
    const fit = await ctx.js(LIVE_CARD_FIT);
    const clean = Boolean(fit?.title && fit.subtitle && fit.copy && !fit.ellipsis && !fit.overlap);
    check(`at ${width} px the Live status card's words wrap and none is clipped`, clean, fit);
    check(`at ${width} px the Live status card leaves how the window plays to the native card`, fit?.text === "", fit);
    const tops = await ctx.js(
      `[...document.querySelectorAll('[data-stage-native-action]')].map((b) => Math.round(b.getBoundingClientRect().top))`,
    );
    check(
      `at ${width} px the card's buttons stay together on one row`,
      tops.length > 1 && new Set(tops).size === 1,
      tops,
    );
  }
  await ctx.capture("live-card-beside-native-card");
  check(
    "pong-mac has no Publish: it has no browser build",
    !(await ctx.present('[data-plugin-toolbar="genex:publish"]')),
  );
  await ctx.openGame("pong-cpp");
  check("pong-cpp has Publish", await ctx.until(() => ctx.present('[data-plugin-toolbar="genex:publish"]')));
  await stalePrewarmSheet(ctx);
}

/** A store prewarmed from another recipe: Live's build needs tools, and the sheet offers setting Browser up again. */
async function stalePrewarmSheet(ctx) {
  const { check } = ctx;
  const store = path.join(ctx.coreRoot, "toolchains");
  if (fs.lstatSync(store).isSymbolicLink())
    throw new Error("the profile's store is a link: never rewrite a shared store");
  const lock = JSON.parse(fs.readFileSync(path.join(store, "current-lock.json"), "utf8"));
  const record = path.join(store, "locks", lock.digest.slice(0, 12), "prewarm.json");
  const original = fs.readFileSync(record, "utf8");
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(original), recipe: "000000000000" }));
  try {
    await ctx.click("[data-stage-reload]");
    check(
      "a stale prewarm makes Live's build offer Set up again, in the sheet's words",
      await ctx.until(async () => /Set up again/.test(await ctx.text("[data-build-install-tools]").catch(() => ""))),
      { button: await ctx.text("[data-build-install-tools]").catch(() => null) },
    );
    const strip = await ctx.text("[data-build-problem]").catch(() => "");
    check("the strip says the tools were set up for an older Genex", /older version of Genex/.test(strip), strip);
    await ctx.click("[data-build-install-tools]");
    check(
      "the sheet says Browser must be set up again",
      await ctx.until(() => ctx.present('[data-toolchain-prewarm="stale"]')),
      {
        sheet: await ctx.text("[data-toolchain-sheet]"),
      },
    );
    check(
      "ANGLE for Mac comes with Genex",
      await ctx.until(() =>
        ctx.present(
          '[data-toolchain-download="angle-macos"]:not([data-toolchain-unavailable]):not([data-toolchain-unhosted])',
        ),
      ),
      { row: await ctx.text('[data-toolchain-download="angle-macos"]') },
    );
    check(
      "Install is offered",
      await ctx.js(
        `(() => { const b=document.querySelector('[data-toolchain-install]'); return !!b && !b.disabled; })()`,
      ),
    );
    await ctx.capture("toolchain-sheet-stale-prewarm");
    await ctx.key("Escape");
    await ctx.until(async () => !(await ctx.present("[data-toolchain-sheet]")), 5_000);
  } finally {
    fs.writeFileSync(record, original);
  }
  await ctx.click("[data-stage-reload]");
  check(
    "with the prewarm current again, the strip clears",
    await ctx.until(async () => !(await ctx.present("[data-build-problem]"))),
  );
}

/** What the badges and their tooltip show, measured in the page: each badge's words and whether anything is cut. */
const BADGE_FACTS = `(() => {
  const strip = document.querySelector('[data-stage-strip]');
  const group = document.querySelector('[data-stage-destinations]');
  if (!strip || !group) return null;
  const cut = (e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
  const badges = [...group.querySelectorAll('[data-stage-destination]')].map((b) => ({
    target: b.dataset.stageDestination,
    state: b.dataset.destinationState,
    shown: [...b.children].filter((c) => !c.classList.contains('sr-only')).map((c) => c.textContent).join(''),
    said: b.textContent,
    cut: cut(b),
  }));
  const g = group.getBoundingClientRect(), s = strip.getBoundingClientRect();
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  const t = tip?.getBoundingClientRect();
  // Radix keeps a visually hidden copy for screen readers (role=tooltip, 1 px): only the drawn lines count.
  const drawn = tip ? [...tip.querySelectorAll('li')].filter((li) => !li.closest('[role="tooltip"]')) : [];
  return {
    badges,
    groupInside: g.left >= s.left - 1 && g.right <= s.right + 1,
    tip: tip ? {
      lines: drawn.map((li) => li.innerText.replace(/\\s+/g, ' ').trim()),
      inside: t.left >= 0 && t.top >= 0 && t.right <= innerWidth && t.bottom <= innerHeight,
      cut: drawn.some((li) => cut(li) || [...li.querySelectorAll('span')].some(cut)),
    } : null,
  };
})()`;

/** The words the tooltip must show for pong-cross on a Mac (`words.ts`, typographic apostrophes). */
const CROSS_WORDS = {
  windows: "Windows · Built, not run on this Mac",
  windowsWhy: "Genex built it and checked the program, but this computer can’t run it.",
  linux: "Linux · Build failed",
  linuxWhy: "The build uses OpenGL directly, which Genex doesn’t run on Linux.",
};

/** Points the mouse at the badges, so their tooltip opens as it does for a person; answers when it shows. */
async function hoverBadges(ctx) {
  const point = await ctx.js(
    `(() => { const r=document.querySelector('[data-stage-destinations]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
  );
  await ctx.wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  return ctx.until(() => ctx.present('[data-slot="tooltip-content"]'), 5_000);
}

/** Moves the mouse off the strip and waits for the tooltip to go. */
async function leaveBadges(ctx) {
  await ctx.wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 600 });
  await ctx.until(async () => !(await ctx.present('[data-slot="tooltip-content"]')), 5_000);
}

/** Whether the tooltip's lines name both checks with their reasons. */
function tipSaysChecks(tip) {
  const text = tip?.lines.join(" | ") ?? "";
  return Object.values(CROSS_WORDS).every((words) => text.includes(words));
}

/** One width and theme of the cross suite: the badges, their tooltip on hover, nothing cut, a screenshot. */
async function crossAt(ctx, width, theme) {
  const { check } = ctx;
  ctx.win.setContentSize(width, 900);
  await ctx.theme(theme);
  await wait(300);
  const shown = await hoverBadges(ctx);
  await ctx.settled();
  const facts = await ctx.js(BADGE_FACTS);
  check(`${theme} ${width} px: hovering the badges shows their tooltip`, shown, facts);
  check(`${theme} ${width} px: the tooltip names both checks and why`, tipSaysChecks(facts?.tip), facts?.tip);
  const whole = facts?.groupInside && facts.badges.every((badge) => !badge.cut) && facts.tip?.inside && !facts.tip.cut;
  check(`${theme} ${width} px: no badge or tooltip word is clipped`, whole, facts);
  await ctx.capture(`cross-badges-${theme}-${width}`);
  await leaveBadges(ctx);
}

/** What the Export for list shows: its label, each item's destination and words, and whether any is cut or off screen. */
const EXPORT_FOR = `(() => {
  const menu = document.querySelector('[data-slot="dropdown-menu-content"]');
  if (!menu) return null;
  const items = [...menu.querySelectorAll('[data-chat-export-destination]')];
  const cut = (e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
  const m = menu.getBoundingClientRect();
  return {
    label: [...menu.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((e) => e.textContent.trim()),
    items: items.map((item) => [item.dataset.chatExportDestination, item.textContent.trim()]),
    cut: items.some(cut) || cut(menu),
    inside: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight,
    pointer: items.every((item) => getComputedStyle(item).cursor === 'pointer'),
  };
})()`;

/** The list a Mac offers for a game made for all four destinations, in the create dialog's order (`words.ts`). */
const EXPORT_ITEMS = [
  ["web", "Browser (web folder)"],
  ["macos", "Mac app"],
  ["windows", "Windows (.zip)"],
  ["linux", "Linux (.tar.gz)"],
];

/** Opens the chat header's ⋯ menu and chooses Export game…; answers the Export for list once it shows. */
async function openExportFor(ctx) {
  await ctx.click('[data-chat-header] button[aria-label="Chat actions"]');
  await ctx.until(() => ctx.present('[data-chat-action="export"]'), 5_000);
  await ctx.click('[data-chat-action="export"]');
  await ctx.until(() => ctx.present('[data-chat-export-destination="linux"]'), 5_000);
  await ctx.settled();
  return ctx.js(EXPORT_FOR);
}

/**
 * ⋯ → Export game… on pong-cross: the Export for list at each width and theme, then Windows chosen.
 * `studio:export` is native, so the fixture profile refuses it and the toast says so: nothing is
 * exported, and the window keeps working.
 */
async function crossExport(ctx) {
  const { check } = ctx;
  for (const width of CROSS_WIDTHS)
    for (const theme of CROSS_THEMES) {
      ctx.win.setContentSize(width, 900);
      await ctx.theme(theme);
      await wait(300);
      const list = await openExportFor(ctx);
      check(
        `${theme} ${width} px: Export for lists Browser, Mac, Windows and Linux, in order`,
        JSON.stringify(list?.items) === JSON.stringify(EXPORT_ITEMS) && list?.label.includes("Export for"),
        list,
      );
      check(`${theme} ${width} px: no export item is clipped or off screen`, list && !list.cut && list.inside, list);
      check(`${theme} ${width} px: every export item shows a pointer`, list?.pointer, list);
      await ctx.capture(`cross-export-${theme}-${width}`);
      await ctx.key("Escape");
      await ctx.until(async () => !(await ctx.present("[data-chat-export-destination]")), 5_000);
    }
  await openExportFor(ctx);
  const before = await toastTexts(ctx);
  await ctx.click('[data-chat-export-destination="windows"]');
  check(
    "choosing Windows asks studio:export, which the fixture refuses, and the toast says so",
    await refusalToast(ctx, before),
    await toastTexts(ctx),
  );
  check(
    "the menu closed and the window still renders",
    !(await ctx.present("[data-chat-export-destination]")) &&
      (await ctx.present("[data-stage-strip]")) &&
      !ctx.wc.isCrashed(),
  );
}

/** The cross suite: pong-cross's Windows and Linux badges read their checks, on the strip and in the tooltip. */
async function crossSuite(ctx) {
  const { check } = ctx;
  await ctx.openGame("pong-cross");
  const windows = '[data-stage-destination="windows"][data-destination-state="not-run-here"]';
  const linux = '[data-stage-destination="linux"][data-destination-state="failed"]';
  check("Windows says Built, not run here", await ctx.until(() => ctx.present(windows)));
  check("Linux says Build failed", await ctx.until(() => ctx.present(linux)));
  // Live builds the browser version first (the stub's instant build); the badges are read once it is in.
  await ctx.until(() => ctx.present('[data-stage-destination="web"][data-destination-state="in-live"]'));
  const facts = await ctx.js(BADGE_FACTS);
  const byTarget = Object.fromEntries((facts?.badges ?? []).map((badge) => [badge.target, badge]));
  check(
    "the strip says Linux · Build failed out loud and keeps Windows' standing for the tooltip",
    byTarget.linux?.shown === "Linux · Build failed" && byTarget.windows?.shown === "Windows",
    byTarget,
  );
  check(
    "a screen reader hears each standing and its reason in place",
    byTarget.windows?.said.includes(CROSS_WORDS.windowsWhy) && byTarget.linux?.said.includes(CROSS_WORDS.linuxWhy),
    byTarget,
  );
  check(
    "Browser stays in Live and the unprepared Mac fixture still needs tools",
    byTarget.web?.state === "in-live" && byTarget.macos?.state === "needs-tools",
    byTarget,
  );
  for (const width of CROSS_WIDTHS) for (const theme of CROSS_THEMES) await crossAt(ctx, width, theme);
  // Focus opens the tooltip too: the window is never focused, so focus is emulated.
  await ctx.wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await ctx.js("document.querySelector('[data-stage-destinations]').focus()");
  const focused = await ctx.until(() => ctx.present('[data-slot="tooltip-content"]'), 5_000);
  check("focusing the badges shows the same tooltip", focused && tipSaysChecks((await ctx.js(BADGE_FACTS))?.tip));
  await ctx.wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
  await ctx.js("document.activeElement?.blur()");
  await crossExport(ctx);
}

/** Each suite's steps. */
const SUITE_RUNS = { card: cardSuite, layout: layoutSuite, cross: crossSuite };

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
    ctx.check(
      "the fixture seeded both C++ games",
      await ctx.until(
        async () =>
          (await ctx.present('[data-project="pong-cpp"]')) && (await ctx.present('[data-project="pong-mac"]')),
      ),
    );
    await SUITE_RUNS[ctx.suite](ctx);
    ctx.check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    ctx.check(`native ${ctx.suite} acceptance completed`, false, String(error.stack));
    if (ctx.wc) await ctx.capture("failure").catch(() => {});
  } finally {
    fs.writeFileSync(
      path.join(ctx.out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          profile: ctx.launch.profileId,
          fixture: FIXTURE_OF[ctx.suite],
          suite: ctx.suite,
          providers: "fixture (no provider calls, no game process)",
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
  const at = process.argv.indexOf("--suite");
  const { ok } = await runNativeDriver(at >= 0 ? process.argv[at + 1] : "card");
  if (!ok) process.exitCode = 1;
}
