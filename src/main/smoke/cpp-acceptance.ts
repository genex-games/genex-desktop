/**
 * Shipped Linux Home/chooser/creation acceptance, only inside --studio-smoke's isolated profile.
 * C++ · raylib creation is retired (M6.3): the chooser and Create game's IPC must not offer or make
 * one, and the C++ projects this acceptance checks are made by the host-internal caller.
 */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { BuildTarget, CreationRefusal, GameStack, type GameProject } from "../../shared/game-project.ts";
import { ToolchainHost, type ToolchainStatus } from "../../shared/toolchain.ts";
import { errorMessage } from "../../shared/errors.ts";
import { creationRefusal, ScaffoldCaller } from "../../substrate/game-workspace.ts";
import { isInside } from "../../substrate/paths.ts";
import { flagValue, StudioFlag } from "../dev/launch-flags.ts";
import type { SmokeContext } from "./run-smoke.ts";
import { waitFor } from "./wait.ts";

type Context = Pick<
  SmokeContext,
  "core" | "window" | "testUserData" | "resources" | "developmentController" | "rendererConsole"
>;
const WAIT = { timeoutMs: 15_000, intervalMs: 50 } as const;
const DIALOG = '[data-testid="create-game-dialog"]';
/** What the chooser says when it makes a Rust game (`words.ts`). */
const MADE_IN_RUST = "Made in Rust · wgpu";
/** How many Escapes may close the chooser: its setup sheet first, then the dialog. */
const ESCAPES = 3;
/** True once no finite animation (a dialog's entrance, a view transition) is still running. */
const SETTLED =
  "!document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)";

function createDriver(ctx: Context) {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const screenshots: string[] = [];
  const wc = ctx.window.webContents;
  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true);
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    process.stderr.write(`[cpp-package] ${ok ? "PASS" : "FAIL"} ${name}\n`);
    if (!ok) throw new Error(name);
  };
  const until = async (name: string, expression: string) => {
    check(
      name,
      await waitFor(async () => {
        await wc.capturePage();
        return js<boolean>(expression).catch(() => false);
      }, WAIT),
    );
  };
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const press = (selector: string, text: string) =>
    js(
      `Array.from(document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
    );
  const shot = async (suffix: string) => {
    const base = flagValue(StudioFlag.Shot);
    if (!base) return;
    const file = path.join(path.dirname(base), `${path.basename(base, path.extname(base))}-${suffix}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Home ⇄ game is a view transition that paints the composer above everything while it runs:
    // capture the settled screen, not a frame of it (looping loaders never settle, so are left out).
    await waitFor(() => js<boolean>(SETTLED).catch(() => false), WAIT);
    await fs.writeFile(file, (await wc.capturePage()).toPNG());
    screenshots.push(path.basename(file));
  };
  const targets = () =>
    js<Array<{ target: string; checked: boolean; disabled: boolean }>>(
      `Array.from(document.querySelectorAll('${DIALOG} [data-create-game-destination]')).map(e=>({target:e.dataset.createGameDestination,checked:e.checked,disabled:e.disabled}))`,
    );
  const pressEscape = () => {
    wc.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
  };
  return { ctx, wc, js, check, until, click, press, shot, targets, pressEscape, checks, screenshots };
}
type Driver = ReturnType<typeof createDriver>;

/** These checks create source projects. Compiling and running games is a separate acceptance. */
export async function runCppAcceptance(ctx: Context): Promise<number> {
  const d = createDriver(ctx);
  let initial: ToolchainStatus | null = null;
  try {
    initial = await verifyLaunch(d);
    await verifyChooserOffersNoRaylib(d);
    await verifyCreateRefusesRaylib(d);
    await createProject(d, "Package Browser Cpp", [BuildTarget.Web]);
    await createProject(d, "Package Linux Cpp", [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]);
    await verifyIsolation(d);
    await d.shot("created");
  } catch (error) {
    d.checks.push({ name: "C++ packaged acceptance completed", ok: false, detail: errorMessage(error) });
    await d.shot("failure").catch(() => {});
  }
  return writeReport(d, initial);
}

async function verifyLaunch(d: Driver): Promise<ToolchainStatus> {
  const { ctx, check, js, until, wc } = d;
  check("acceptance runs on Linux x64", process.platform === "linux" && process.arch === "x64");
  check("the actual packaged app has no developer controller", app.isPackaged && !ctx.developmentController);
  check(
    "core roots belong to the owned smoke profile",
    isInside(ctx.testUserData, ctx.core.games.root) && isInside(ctx.testUserData, ctx.core.layout.toolchains),
  );
  check("smoke starts with an empty game library", (await ctx.core.games.list()).length === 0);
  ctx.window.setPosition(0, 0);
  ctx.window.showInactive();
  wc.setBackgroundThrottling(false);
  await until(
    "fresh packaged launch renders Home",
    "!!document.querySelector('[data-home] [data-home-composer] textarea')",
  );
  check("normal New game begins at Home", !(await js<boolean>(`!!document.querySelector('${DIALOG}')`)));
  const engines = await js<Array<{ label: string }>>("window.studio.engines()");
  check(
    "all configured engines are offline fixtures",
    engines.length > 0 && engines.every((engine) => engine.label.includes("[fixture]")),
  );
  check(
    "packaged Home renders Linux's compiled-game entry",
    await js<boolean>("!!document.querySelector('[data-home-cpp]')"),
  );
  check(
    "the shipped stylesheet reaches Home",
    await js<boolean>(
      "document.styleSheets.length>0 && getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().length>0",
    ),
  );
  await d.shot("home");
  const initial = await js<ToolchainStatus>("window.studio.toolchainStatus()");
  check("real toolchain IPC identifies the supported Linux host", initial.host === ToolchainHost.LinuxX64);
  check(
    "fresh toolchain store has no installed tools or job",
    initial.installed.length === 0 && initial.lock === null && initial.job === null,
  );
  return initial;
}

/**
 * The shipped chooser offers no C++ · raylib: no raylib choice and no C++ words. Rust · wgpu is
 * released on the Linux Studio (M6.4), so the chooser starts on it, Three.js beside it, and no box
 * is checked but Browser; its setup sheet may open over it, so Escape closes the sheet, then the chooser.
 */
async function verifyChooserOffersNoRaylib(d: Driver): Promise<void> {
  await d.click("[data-home-cpp]");
  await d.until("Home's compiled entry opens the shipped chooser", `!!document.querySelector('${DIALOG}')`);
  await d.until(
    "the chooser starts on Rust · wgpu once the store answers",
    `document.querySelector('${DIALOG}').innerText.includes(${JSON.stringify(MADE_IN_RUST)})`,
  );
  d.check(
    "the chooser offers no raylib choice and never names C++",
    await d.js<boolean>(
      `!document.querySelector('${DIALOG} [data-create-game-stack="${GameStack.RaylibCpp}"]') && !document.querySelector('${DIALOG}').innerText.includes('C++')`,
    ),
  );
  const boxes = await d.targets();
  d.check(
    "the chooser starts on Browser alone: no desktop box is ticked for the person",
    boxes.every((box) => box.checked === (box.target === BuildTarget.Web)),
  );
  await d.shot("chooser");
  for (let pressed = 0; pressed < ESCAPES; pressed++) {
    if (!(await d.js<boolean>(`!!document.querySelector('${DIALOG}')`))) break;
    d.pressEscape();
    await waitFor(() => d.js<boolean>(`!document.querySelector('[data-toolchain-sheet]')`).catch(() => false), WAIT);
  }
  await d.until("Escape closes the chooser", `!document.querySelector('${DIALOG}')`);
}

/** Create game's real IPC refuses raylib by stack and by bare desktop destinations, and makes nothing. */
async function verifyCreateRefusesRaylib(d: Driver): Promise<void> {
  for (const options of [
    { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] },
    { targets: [BuildTarget.Web, BuildTarget.Linux] },
  ]) {
    // The typed code the IPC refuses with, and the real IPC's rejection: its words cross the
    // context bridge, its code does not, so no check reads them.
    const rejected = await d.js<boolean>(
      `window.studio.createGame('Package Refused', ${JSON.stringify(options)}).then(()=>false,()=>true)`,
    );
    d.check(
      `Create game's IPC refuses ${JSON.stringify(options)}`,
      creationRefusal(options) === CreationRefusal.RaylibCreationRetired && rejected,
    );
  }
  d.check("a refused create leaves the library empty", (await d.ctx.core.games.list()).length === 0);
}

/** A raylib project made the only way one still is: by the host-internal caller, as fixtures make theirs. */
async function createProject(d: Driver, title: string, selected: readonly BuildTarget[]): Promise<void> {
  const name = title.toLowerCase().replaceAll(" ", "-");
  await d.ctx.core.games.scaffold(name, {
    title,
    stack: GameStack.RaylibCpp,
    targets: selected,
    caller: ScaffoldCaller.Internal,
  });
  const game = (await d.ctx.core.games.list()).find((item) => item.title === title);
  d.check("real GameWorkspaces lists the created game", Boolean(game));
  if (!game) throw new Error("GameWorkspaces did not return the created game");
  await verifyProject(d, game, selected);
}

async function verifyProject(d: Driver, game: GameProject, selected: readonly BuildTarget[]): Promise<void> {
  const dir = await fs.realpath(game.dir);
  d.check(
    "created project stays inside this smoke's game root",
    isInside(await fs.realpath(d.ctx.core.games.root), dir),
  );
  const record = JSON.parse(await fs.readFile(path.join(dir, "studio.json"), "utf8"));
  d.check("created project records C++ even for Browser only", record.stack === GameStack.RaylibCpp);
  d.check(
    "persisted destinations equal the person's selection",
    JSON.stringify(record.targets) === JSON.stringify(selected),
  );
  await fs.stat(path.join(dir, "CMakeLists.txt"));
  await fs.stat(path.join(dir, "src/main.cpp"));
  d.check("packaged C++ template is present in the new project", true);
  const listed = await d.js<GameProject[]>("window.studio.games()");
  const throughIpc = listed.find((item) => item.name === game.name);
  d.check(
    "preload games IPC returns persisted C++ destinations",
    throughIpc?.destinations?.stack === GameStack.RaylibCpp &&
      JSON.stringify(throughIpc.destinations.targets) === JSON.stringify(selected),
  );
}

async function verifyIsolation(d: Driver): Promise<void> {
  const status = await d.js<ToolchainStatus>("window.studio.toolchainStatus()");
  d.check(
    "creation never installs tools or starts an install job",
    status.installed.length === 0 && status.lock === null && status.job === null,
  );
  d.check(
    "both C++ projects persist through real games IPC",
    (await d.js<GameProject[]>("window.studio.games()")).length === 2,
  );
  const refused = await d.js<boolean>(
    "window.studio.toolchainInstall(['web','windows','linux']).then(()=>false,e=>String(e).includes('unsupported-in-fixture'))",
  );
  d.check("packaged smoke preserves the native download refusal", refused);
  const afterRefusal = await d.js<ToolchainStatus>("window.studio.toolchainStatus()");
  d.check(
    "refused installation leaves the fresh store untouched",
    afterRefusal.installed.length === 0 && afterRefusal.lock === null && afterRefusal.job === null,
  );
  const errors = d.ctx.rendererConsole.filter((entry) => entry.level === "error" || entry.level === "3");
  d.check(
    "packaged renderer has no console errors",
    errors.length === 0,
    errors
      .map((entry) => entry.message)
      .join(" | ")
      .slice(0, 500),
  );
}

function writeReport(d: Driver, initial: ToolchainStatus | null): number {
  const failed = d.checks.filter((entry) => !entry.ok).length;
  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    version: app.getVersion(),
    packaged: app.isPackaged,
    checks: d.checks,
    failed,
    screenshots: d.screenshots,
    toolchainHost: initial?.host ?? null,
    bundledIds: initial?.downloads?.filter((entry) => entry.bundled).map((entry) => entry.id) ?? [],
    sourceCreation: failed === 0 ? "passed" : "failed",
    gameBuild: "unverified; separate real Linux toolchain acceptance",
  };
  process.stdout.write(`\n__CPP_PACKAGE_JSON__${JSON.stringify(report)}__END__\n`);
  return failed ? 1 : 0;
}
