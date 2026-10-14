/**
 * Shipped Rust · wgpu payload acceptance, only inside --studio-smoke's isolated profile: the
 * packaged app's resources hold a Rust template the workspace reader accepts and a lock line a game's
 * lock derives from, and the store starts cold for the Rust stack (no lock, no job). Since M6.4 a
 * release build on a host the Rust lane runs on makes Rust · wgpu games: the default stack here is
 * Rust (the shipped host-conditional switch), Create game starts on it and never offers C++ ·
 * raylib, the real creation IPC makes a Rust game from the shipped template (downloading nothing)
 * and refuses a raylib one by stack and by bare desktop destinations. The package's bytes (no cargo
 * or rustc, the lock line byte for byte) are checked outside the app by
 * `tests/e2e/run-packaged-smoke.mjs`; building and running a Rust game is the toolchain lanes'
 * acceptance, never this one.
 */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { BuildTarget, CreationRefusal, GameStack, type GameProject, ProjectKind } from "../../shared/game-project.ts";
import { CreationError, creationRefusal } from "../../substrate/game-workspace.ts";
import {
  LOCK_FILE_OF_STACK,
  type StackDefault,
  StackDefaultReason,
  ToolchainId,
  type ToolchainStatus,
  toolchainHostOf,
} from "../../shared/toolchain.ts";
import { readGenexToml } from "../../substrate/genex-toml.ts";
import { isInside } from "../../substrate/paths.ts";
import { manifestEntry } from "../../substrate/toolchain-store/manifest.ts";
import { RUST_LOCK_LINE_FILE, rustPayloadDir } from "../core/rust-lane.ts";
import { developmentStacksOpen } from "../core/stack-gate.ts";
import { stackDefaultHere } from "../project-policy.ts";
import { gameCargoLock, genexReleaseOf } from "../rust-manifest.ts";
import type { SmokeContext } from "./run-smoke.ts";
import { waitFor } from "./wait.ts";

type Context = Pick<
  SmokeContext,
  "core" | "window" | "testUserData" | "resources" | "developmentController" | "rendererConsole"
>;
const WAIT = { timeoutMs: 15_000, intervalMs: 50 } as const;
/** Where the payload sits in resources (`scripts/rust-payload.ts` ships it). */
const RUST_TEMPLATE = "game-template-rust";
const RUST_TITLE = "Package Rust Pond";
const REFUSED_TITLE = "Package Raylib Refused";
const DIALOG = '[data-testid="create-game-dialog"]';
/** What the chooser says when it makes a Rust game (`words.ts`), as the create-dialog e2e reads it. */
const MADE_IN_RUST = "Made in Rust · wgpu";
/** How many Escapes may close the chooser: its setup sheet first, then the dialog. */
const ESCAPES = 3;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function createDriver(ctx: Context) {
  const checks: Check[] = [];
  const wc = ctx.window.webContents;
  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true);
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    process.stderr.write(`[rust-package] ${ok ? "PASS" : "FAIL"} ${name}\n`);
    if (!ok) throw new Error(name);
  };
  const seen = (expression: string) =>
    waitFor(async () => {
      await wc.capturePage();
      return js<boolean>(expression).catch(() => false);
    }, WAIT);
  const until = async (name: string, expression: string) => check(name, await seen(expression));
  const pressEscape = () => {
    wc.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
  };
  return { ctx, js, check, until, seen, pressEscape, checks };
}
type Driver = ReturnType<typeof createDriver>;

/** What the acceptance learned besides its checks, for the report. */
interface Findings {
  genexVersion: string | null;
  stackDefault: StackDefault | null;
}

/** These checks read the shipped payload, the default and the creation gate; they never install or build anything. */
export async function runRustAcceptance(ctx: Context): Promise<number> {
  const d = createDriver(ctx);
  const found: Findings = { genexVersion: null, stackDefault: null };
  try {
    await verifyLaunch(d);
    found.genexVersion = await verifyPayload(d);
    await verifyColdStore(d);
    found.stackDefault = verifyDefault(d);
    await verifyChooser(d);
    await verifyCreation(d);
    await verifyRendererClean(d);
  } catch (error) {
    d.checks.push({ name: "Rust packaged acceptance completed", ok: false, detail: errorMessage(error) });
  }
  return writeReport(d, found);
}

async function verifyLaunch(d: Driver): Promise<void> {
  const { ctx, check, js, until } = d;
  const host = toolchainHostOf(process.platform, process.arch);
  check(
    "acceptance runs on a host the Rust store pins a sysroot for",
    host !== null && manifestEntry(ToolchainId.Rust, host) !== null,
    `${process.platform}-${process.arch}`,
  );
  check("the actual packaged app has no developer controller", app.isPackaged && !ctx.developmentController);
  check(
    "core roots belong to the owned smoke profile",
    isInside(ctx.testUserData, ctx.core.games.root) && isInside(ctx.testUserData, ctx.core.layout.toolchains),
  );
  check("smoke starts with an empty game library", (await ctx.core.games.list()).length === 0);
  ctx.window.showInactive();
  ctx.window.webContents.setBackgroundThrottling(false);
  await until(
    "fresh packaged launch renders Home",
    "!!document.querySelector('[data-home] [data-home-composer] textarea')",
  );
  const engines = await js<Array<{ label: string }>>("window.studio.engines()");
  check(
    "all configured engines are offline fixtures",
    engines.length > 0 && engines.every((engine) => engine.label.includes("[fixture]")),
  );
}

/** The template the workspace scaffolds from, and a game lock derived from the shipped lock line; the pinned genex. */
async function verifyPayload(d: Driver): Promise<string> {
  const { ctx, check } = d;
  const manifest = await readGenexToml(path.join(ctx.resources, RUST_TEMPLATE));
  check(
    "the shipped Rust template's genex.toml passes the workspace reader",
    manifest.ok,
    manifest.ok ? undefined : `${manifest.code}: ${manifest.detail}`,
  );
  if (!manifest.ok) throw new Error("no Rust template manifest");
  await fs.stat(path.join(ctx.resources, RUST_TEMPLATE, "src", "main.rs"));
  check("the shipped Rust template has its entry point", true);
  const lockLine = path.join(rustPayloadDir(ctx.resources), RUST_LOCK_LINE_FILE);
  const baseLock = await fs.readFile(lockLine, "utf8").catch(() => "");
  const genexVersion = genexReleaseOf(baseLock);
  check("the shipped Rust lock line pins a genex release", genexVersion !== null);
  if (genexVersion === null) throw new Error("no genex in the lock line");
  const lock = gameCargoLock(manifest.manifest, { genexVersion, baseLock });
  check(
    "a game lock derives from the shipped lock line with no host path in it",
    lock.ok && !lock.text.includes(ctx.resources) && !lock.text.includes(ctx.testUserData),
    lock.ok ? undefined : `${lock.code}: ${lock.detail}`,
  );
  return genexVersion;
}

/** Nothing installs or locks the Rust stack in a fresh package; the store answers without a job. */
async function verifyColdStore(d: Driver): Promise<void> {
  const { ctx, check, js } = d;
  check("a fresh package's store holds no Rust lock", !(await storeHoldsRustLock(ctx)));
  const status = await js<ToolchainStatus>("window.studio.toolchainStatus()");
  check(
    "the fresh store has no installed tools or job",
    status.installed.length === 0 && status.lock === null && status.job === null,
  );
}

/** Whether the profile's store holds a current Rust lock. */
async function storeHoldsRustLock(ctx: Context): Promise<boolean> {
  const store = await fs.readdir(ctx.core.layout.toolchains).catch((): string[] => []);
  return store.includes(LOCK_FILE_OF_STACK[GameStack.RustWgpu]);
}

/**
 * The switch this profile's settings hold (none in a fresh package: the shipped one) makes Rust ·
 * wgpu the default here, and the release build's creation gate is open. The renderer's side, the
 * chooser starting on Rust, is {@link verifyChooser}.
 */
function verifyDefault(d: Driver): StackDefault {
  const { ctx, check } = d;
  check("the release build's Rust creation gate is open on this host", developmentStacksOpen(ctx.core.options));
  const setting = ctx.core.settings.stackDefault;
  check("a fresh package's settings hold no stackDefault switch (the shipped one)", setting === undefined, setting);
  const online = stackDefaultHere({ setting, online: true, rustToolchainReady: false });
  check(
    "the stored switch makes Rust · wgpu this host's default stack",
    online.stack === GameStack.RustWgpu && online.why === StackDefaultReason.HostLane,
    JSON.stringify(online),
  );
  const offline = stackDefaultHere({ setting, online: false, rustToolchainReady: false });
  check(
    "an offline first launch defaults to Three.js (toolchain-offline)",
    offline.stack === GameStack.ThreeJs && offline.why === StackDefaultReason.ToolchainOffline,
    JSON.stringify(offline),
  );
  return online;
}

/** Home's compiled entry opens a chooser that starts on Rust · wgpu, Three.js beside it, and never offers C++ · raylib. */
async function verifyChooser(d: Driver): Promise<void> {
  const { js, check, until } = d;
  await js(`document.querySelector('[data-home-cpp]').click()`);
  await until("Home's compiled entry opens the shipped chooser", `!!document.querySelector('${DIALOG}')`);
  await until(
    "the chooser starts on Rust · wgpu once the store answers",
    `document.querySelector('${DIALOG}').innerText.includes(${JSON.stringify(MADE_IN_RUST)})`,
  );
  const radio = (stack: GameStack) => `document.querySelector('${DIALOG} [data-create-game-stack="${stack}"]')`;
  check(
    "the chooser starts on the Rust · wgpu choice, offers Three.js beside it and never C++ · raylib",
    await js<boolean>(
      `!!${radio(GameStack.RustWgpu)}?.checked && !!${radio(GameStack.ThreeJs)} && !${radio(GameStack.RaylibCpp)} && !document.querySelector('${DIALOG}').innerText.includes('C++')`,
    ),
  );
  for (let pressed = 0; pressed < ESCAPES; pressed++) {
    if (!(await js<boolean>(`!!document.querySelector('${DIALOG}')`))) break;
    d.pressEscape();
    await d.seen(`!document.querySelector('[data-toolchain-sheet]') || !document.querySelector('${DIALOG}')`);
  }
  await until("Escape closes the chooser", `!document.querySelector('${DIALOG}')`);
}

/**
 * The real creation IPC makes a Rust game from the shipped template and installs nothing; it refuses
 * C++ · raylib by stack and by bare desktop destinations and writes nothing for either.
 */
async function verifyCreation(d: Driver): Promise<void> {
  const { ctx, check, js } = d;
  const made = await js<GameProject | null>(
    `window.studio.createGame(${JSON.stringify(RUST_TITLE)},{stack:${JSON.stringify(GameStack.RustWgpu)},targets:[${JSON.stringify(BuildTarget.Web)},${JSON.stringify(BuildTarget.Mac)}]}).catch(()=>null)`,
  );
  check("the real creation IPC makes a Rust · wgpu game", made?.shape?.kind === ProjectKind.RustWgpu, made?.name);
  const game = (await ctx.core.games.list()).find((listed) => listed.name === made?.name);
  check(
    "the Rust game is in the smoke profile's library",
    game !== undefined && isInside(ctx.core.games.root, game.dir),
  );
  const manifest = game ? await readGenexToml(game.dir) : null;
  check("the new game's genex.toml passes the workspace reader", manifest?.ok === true);
  check("creating a Rust game downloads and locks nothing", !(await storeHoldsRustLock(ctx)));
  const before = (await ctx.core.games.list()).length;
  for (const options of [
    { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] },
    { targets: [BuildTarget.Web, BuildTarget.Mac] },
  ]) {
    // The typed code the IPC refuses with (`creationRefusal`), and that the real IPC rejects: the
    // rejection's words cross the context bridge, its code does not, so no check reads them.
    const code = creationRefusal(options);
    const rejected = await js<boolean>(
      `window.studio.createGame(${JSON.stringify(REFUSED_TITLE)},${JSON.stringify(options)}).then(()=>false,()=>true)`,
    );
    check(
      `the real creation IPC refuses raylib for ${JSON.stringify(options)}`,
      code === CreationRefusal.RaylibCreationRetired && rejected,
      String(code),
    );
  }
  // Behind the IPC check, the library refuses Create game's raylib by its typed code too.
  const library = await ctx.core
    .createGame(REFUSED_TITLE, { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] })
    .then(
      () => null,
      (error: unknown) => (error instanceof CreationError ? error.code : errorMessage(error)),
    );
  check(
    "the library refuses Create game's raylib with raylib-creation-retired",
    library === CreationRefusal.RaylibCreationRetired,
    String(library),
  );
  check("a refused raylib creation leaves no game", (await ctx.core.games.list()).length === before);
}

/** The renderer logged no error through the whole acceptance. */
async function verifyRendererClean(d: Driver): Promise<void> {
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

function writeReport(d: Driver, found: Findings): number {
  const failed = d.checks.filter((entry) => !entry.ok).length;
  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    version: app.getVersion(),
    packaged: app.isPackaged,
    checks: d.checks,
    failed,
    genexVersion: found.genexVersion,
    stackDefault: found.stackDefault?.stack ?? null,
    rustCreation: failed === 0 ? "released" : "unverified",
    raylibCreation: failed === 0 ? "retired" : "unverified",
    gameBuild: "unverified; the Rust toolchain lanes' acceptance",
  };
  process.stdout.write(`\n__RUST_PACKAGE_JSON__${JSON.stringify(report)}__END__\n`);
  return failed ? 1 : 0;
}
