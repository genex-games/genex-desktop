/**
 * The build smoke (`--studio-smoke`): loaded by main with a dynamic import only when that flag is
 * set, so no smoke code runs, or is even evaluated, in a normal launch.
 */
import { InteractionSource } from "../../shared/run-summary.ts";
import { type BrowserWindow, app, type WebContents, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPackage } from "../../substrate/plugins/manifest.ts";
import { scanPackage } from "../../substrate/plugins/scan.ts";
import { discoverCodingCli, resolveCodingCli } from "../../substrate/engines/external-cli.ts";
import { runCommand } from "../../substrate/engines/claude-cli.ts";
import { hasLoginEntries, toolchain } from "../../substrate/toolchain.ts";
import { QUEUE_PLACEHOLDER } from "../../renderer/composer-placeholder.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { HarnessState, DispatchActionType } from "../../shared/protocol.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { pushToRenderer } from "../ipc-handle.ts";
import { finishedPayload, startedPayload } from "../plugin-activity.ts";
import type { GamePreview } from "../preview.ts";
import type { StudioCore } from "../studio-core.ts";
import type { DelegateRequest, DelegateResult, Engine } from "../../substrate/engines/types.ts";
import { COMPUTER_SMOKE_GAME, COMPUTER_SMOKE_WEBGPU_GAME } from "./fixture-games.ts";
import type { SmokeReadGates } from "./read-gates.ts";
import { sleep, waitFor as waitUntil } from "./wait.ts";
import { errorMessage } from "../../shared/errors.ts";
import { expectedStatusFlag, flagValue, hasFlag, StudioFlag } from "../dev/launch-flags.ts";
import { RunControlAction } from "../../shared/coordinator.ts";
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind, SnapshotScope } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { HostMethod } from "../../shared/harness-api.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { PluginSourceKind } from "../../shared/plugins.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { CredentialState } from "../../substrate/session-credentials.ts";
import { StudioPlatform } from "../../shared/boot.ts";

/** How long the packaged harness is given to boot and report ready. */
const HARNESS_READY_POLL = { timeoutMs: 30 * SECOND_MS, intervalMs: 250 } as const;
/** How long the renderer is given to hydrate its first thread list (engine probes can take seconds). */
const HYDRATION_POLL = { timeoutMs: 20 * SECOND_MS, intervalMs: 300 } as const;
/** How long a plugin's isolated frame is given to appear or answer, and how often it is asked. */
const PLUGIN_FRAME_POLL = { timeoutMs: 10 * SECOND_MS, intervalMs: 100 } as const;
/** How often a scenario asks the window whether an expression holds yet. */
const WINDOW_POLL_MS = 200;
/** How long the build smoke's window is given, by default, for an expression to hold. */
const BUILD_WAIT_MS = 15 * SECOND_MS;
/** How long the computer smoke's window is given, by default, for an expression to hold. */
const COMPUTER_WAIT_MS = 10 * SECOND_MS;
/** The pause that lets the window paint, and the native preview settle, before a screenshot or a read. */
const SETTLE_MS = 250;

/** A renderer console line main collected, as the smoke reads it. */
export interface RendererConsoleEntry {
  level: string;
  message: string;
  source?: string;
  line?: number;
  at?: string;
}

/** Everything the smoke reads from, or drives in, the booted app. */
export interface SmokeContext {
  core: StudioCore;
  window: BrowserWindow;
  preview: GamePreview;
  /** The smoke's own throwaway userData. */
  testUserData: string;
  resources: string;
  isolatedCodingDiscovery: boolean;
  /** A development build, launch or runtime is present — an ordinary smoke has none. */
  developmentController: boolean;
  rendererConsole: readonly RendererConsoleEntry[];
  smokeReads: SmokeReadGates;
  /** The last rectangle the renderer asked the native game view to take. */
  previewBoundsSeen: { last: { x: number; y: number; width: number; height: number } | null };
  pushUiEvent(event: UiEvent): void;
  /** Whether main is holding the Mac awake for a run. */
  keepAwakeHeld(): boolean;
}

/**
 * Boot the real UI, let it settle, and report what it actually rendered. This is the check that
 * the app a person opens works — the self test exercises the machinery beneath it.
 */
export async function runSmoke(ctx: SmokeContext): Promise<number> {
  const { core, window } = ctx;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
    process.stderr.write(`[smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}\n`);
  };
  /**
   * A check whose answer has to be gone and got — a click, a poll. A throw inside it is that
   * check's failure and nothing more: a control that never mounted used to end the run where it
   * stood, taking every later check with it and reporting them as neither passed nor failed.
   * The detail is a thunk so it is read after the probe, not before.
   */
  const checkAsync = async (
    name: string,
    probe: () => Promise<boolean>,
    detail: () => string = () => "",
  ): Promise<boolean> => {
    try {
      const ok = await probe();
      check(name, ok, detail());
      return ok;
    } catch (err) {
      check(name, false, `threw: ${errorMessage(err)}`);
      return false;
    }
  };
  const smoke: Smoke = { ctx, wc: window.webContents, check, checkAsync };
  try {
    for (const scenario of SCENARIOS) await scenario(smoke);
    if (hasFlag(StudioFlag.BuildSmoke)) await runBuildSmoke(smoke);
    if (hasFlag(StudioFlag.ComputerSmoke)) await runComputerSmoke(smoke);
    await saveWindowShot(smoke);
  } catch (err) {
    check("smoke test ran without throwing", false, (err as Error).stack ?? String(err));
  } finally {
    await core.stop().catch(() => {});
  }
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n__SMOKE_JSON__${JSON.stringify({ checks, failed: failed.length })}__END__\n`);
  return failed.length === 0 ? 0 : 1;
}

/** What every scenario drives and records: the booted app, its window, and the checks. */
interface Smoke {
  ctx: SmokeContext;
  wc: WebContents;
  check(name: string, ok: boolean, detail?: string): void;
  /**
   * A check whose answer has to be gone and got; a throw inside it is that check's failure and
   * nothing more.
   */
  checkAsync(name: string, probe: () => Promise<boolean>, detail?: () => string): Promise<boolean>;
}

/** Why the smoke cannot go on: a hook or value its fixtures promised is missing. */
const MESSAGE = {
  missing: (what: string) => `smoke setup is missing ${what}`,
  coordinatorExpected: "Smoke expected a coordinator; a worker must not launch",
} as const;

/** A value the smoke cannot go on without; a named smoke failure when it is missing. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(MESSAGE.missing(what));
  return value;
}

/** A host API call by method name, as the smoke and the seed's evidence pass make it. */
type HostCall = (method: string, params: unknown) => Promise<unknown>;

/** The harness host API as the smoke calls it; a method the host lacks is a named smoke failure. */
function hostCaller(core: StudioCore): HostCall {
  const methods = core.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  return (method, params) => required(methods[method], method)(params);
}

/** A frame's answer to an expression, or false when the frame is not there. */
async function frameSays(frame: WebFrameMain | undefined, expression: string): Promise<boolean> {
  return frame ? Boolean(await frame.executeJavaScript(expression)) : false;
}

/** The scenarios every smoke runs, in order, before the build and computer smokes. */
const SCENARIOS: Array<(smoke: Smoke) => Promise<void>> = [
  checkBoot,
  checkRenderedWindow,
  checkEnginesAndToolchain,
  checkExternalCliMatrix,
  checkSignInDialogs,
];

/**
 * `--studio-shot=<path>` saves a PNG of the smoke window — how the UI is eyeballed in CI
 * and after restyles, without booting the app by hand.
 */
async function saveWindowShot({ ctx, check }: Smoke): Promise<void> {
  const target = flagValue(StudioFlag.Shot);
  if (target === undefined) return;
  const image = await ctx.window.webContents.capturePage();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(target, image.toPNG());
  check("saved a window screenshot", true, target);
}

/** The harness boots from the packaged resources, in an isolated profile with no dev controller. */
async function checkBoot(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const { core, testUserData } = smoke.ctx;
  const ctx = smoke.ctx;
  // The harness is a sandboxed child process launched from the (asar-unpacked) resources dir —
  // the part most likely to break in a packaged build, so wait for it explicitly rather than
  // sampling a moment and hoping.
  await waitUntil(() => core.host.state === HarnessState.Ready, HARNESS_READY_POLL);
  check(
    "smoke isolates Electron userData and sessionData before ready",
    app.getPath("userData") === path.join(testUserData, "electron") &&
      app.getPath("sessionData") === path.join(testUserData, "session"),
  );
  check(
    "ordinary smoke has no development controller",
    !ctx.developmentController && !existsSync(path.join(testUserData, "controller.json")),
  );
  const ollamaHost = flagValue(StudioFlag.OllamaHost);
  check(
    "smoke forwards its supplied local-model host before initialization",
    !ollamaHost || core.options.ollamaHost === ollamaHost,
  );
  check("the harness reaches ready in this build", core.host.state === HarnessState.Ready, `state=${core.host.state}`);
  check("the harness workspace was seeded from app resources", (await core.host.healthcheck()) === true);
}

/** The window hydrates, styled, with the two-pane Build room and no console errors. */
async function checkRenderedWindow(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const { window, rendererConsole } = smoke.ctx;
  // Wait for the renderer's bootstrap to hydrate the UI (engine probes can take seconds when
  // no Ollama answers) — a fixed nap here once sampled a half-loaded window.
  const wc = window.webContents;
  await waitUntil(
    () => wc.executeJavaScript(`!!document.querySelector('nav [data-thread]')`, true).catch(() => false),
    HYDRATION_POLL,
  );
  const rendered = (await wc.executeJavaScript(
    `JSON.stringify({
         columns: document.querySelectorAll(".column").length,
         modes: [...document.querySelectorAll("[data-mode]")].map((t) => t.textContent),
         brand: document.querySelector(".brand")?.textContent ?? "",
         sidebarFooter: !!document.querySelector(".sidebar-footer"),
         composer: !!document.querySelector(".composer textarea"),
         sidebar: !!document.querySelector('nav [data-thread="studio"]'),
         crashed: document.body.innerText.includes("could not start"),
         // Structure alone once passed on a window that rendered with no stylesheet at all —
         // unreadable dark-on-dark. A resolved token proves the CSS actually reached the page.
         canvasToken: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
         bodyBg: getComputedStyle(document.body).backgroundColor,
         sheets: document.styleSheets.length,
       })`,
    true,
  )) as string;
  const ui = JSON.parse(rendered) as {
    columns: number;
    modes: string[];
    brand: string;
    sidebarFooter: boolean;
    composer: boolean;
    sidebar: boolean;
    crashed: boolean;
    canvasToken: string;
    bodyBg: string;
    sheets: number;
  };
  check(
    "the stylesheet reached the window",
    ui.sheets > 0 && ui.canvasToken.length > 0,
    `sheets=${ui.sheets} --canvas=${ui.canvasToken || "(unset)"}`,
  );
  check(
    "the window is not rendering unstyled",
    ui.bodyBg !== "rgba(0, 0, 0, 0)" && ui.bodyBg !== "rgb(255, 255, 255)",
    `body background=${ui.bodyBg}`,
  );
  check("the window renders the two-pane Build room", ui.columns === 2, `columns=${ui.columns}`);
  check("the chat composer is present", ui.composer);
  check("the project rail renders with the Studio thread", ui.sidebar);
  check("sidebar navigation replaces the Build/Review switch", ui.modes.length === 0 && ui.sidebar, ui.modes.join(","));
  check("the app did not fail to start", !ui.crashed);
  check("the sidebar has no global status footer", !ui.sidebarFooter);

  const errors = rendererConsole.filter((entry) => entry.level === "error" || entry.level === "3");
  check(
    "no renderer console errors",
    errors.length === 0,
    errors
      .map((e) => e.message)
      .join(" | ")
      .slice(0, 300),
  );
}

/** Every engine the picker offers, the build toolchain on PATH, and external CLI discovery. */
async function checkEnginesAndToolchain(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const { core, isolatedCodingDiscovery } = smoke.ctx;
  // Every engine the picker can offer, named — a count would pass for the wrong two.
  const described = (await core.engines.describe()).map((engine) => engine.id).sort();
  check(
    "engines are described for the picker",
    [EngineId.ClaudeCode, EngineId.Codex, EngineId.Ollama].every((id) => described.includes(id)),
    described.join(","),
  );
  // A Finder-launched app is born with launchd's PATH — no Homebrew, no nvm, no Volta — so
  // every `npm run build` the studio ever ran exited 127 and no game with its own build could
  // be shown. The resolved toolchain is what the sandbox hands every process.
  const tools = await toolchain();
  check(
    "the build toolchain is on the studio's PATH",
    Boolean(tools.found.node) && Boolean(tools.found.npm) && hasLoginEntries(tools.path),
    `${tools.fromLoginShell ? "login shell" : "candidate dirs"}: node=${tools.found.node ?? "missing"} npm=${tools.found.npm ?? "missing"}`,
  );
  for (const provider of [EngineId.Codex, EngineId.ClaudeCode] as const) {
    const external = await resolveCodingCli(provider);
    const expected = flagValue(expectedStatusFlag(provider));
    check(
      `${provider} ${isolatedCodingDiscovery ? "isolated fixture" : "live external"} discovery reports actionable status`,
      discoveryAsExpected(external.status.state, expected, isolatedCodingDiscovery),
      JSON.stringify(external.status),
    );
  }
}

/** Answers for the external CLI fixture's arguments: its version, its help texts and a signed-out status. */
const CLI_FIXTURE = {
  version: "fixture-cli 1",
  execHelp: "--json --output-schema --ignore-user-config --skip-git-repo-check",
  execJson: '{"type":"thread.started","thread_id":"external-fixture"}',
  help: "--input-format --output-format --strict-mcp-config --setting-sources --permission-mode --mcp-config --allowedTools --disallowedTools",
  auth: '{"loggedIn":false}',
} as const;

/** The fixture as a POSIX script. */
const CLI_FIXTURE_SH = `#!/bin/sh\ncase "$1" in\n--version) echo "${CLI_FIXTURE.version}";;\nexec) if [ "$2" = "--help" ]; then echo "${CLI_FIXTURE.execHelp}"; else echo '${CLI_FIXTURE.execJson}'; fi;;\n--help) echo "${CLI_FIXTURE.help}";;\nlogin|auth) echo '${CLI_FIXTURE.auth}';;\nesac\n`;

/** The fixture as a Windows command script, the form a global npm CLI takes there. */
const CLI_FIXTURE_CMD = [
  "@echo off",
  'if "%~1"=="--version" goto version',
  'if "%~1"=="--help" goto help',
  'if "%~1"=="exec" goto exec',
  'if "%~1"=="login" goto auth',
  'if "%~1"=="auth" goto auth',
  "exit /b 0",
  ":version",
  `echo ${CLI_FIXTURE.version}`,
  "exit /b 0",
  ":help",
  `echo ${CLI_FIXTURE.help}`,
  "exit /b 0",
  ":exec",
  'if "%~2"=="--help" goto exechelp',
  `echo ${CLI_FIXTURE.execJson}`,
  "exit /b 0",
  ":exechelp",
  `echo ${CLI_FIXTURE.execHelp}`,
  "exit /b 0",
  ":auth",
  `echo ${CLI_FIXTURE.auth}`,
  "exit /b 0",
  "",
].join("\r\n");

/** Install the external CLI fixture as `name` in `dir` (`name.cmd` on Windows); returns its path. */
async function writeCliFixture(dir: string, name: string): Promise<string> {
  const windows = process.platform === StudioPlatform.Windows;
  const file = path.join(dir, windows ? `${name}.cmd` : name);
  await fs.writeFile(file, windows ? CLI_FIXTURE_CMD : CLI_FIXTURE_SH, { mode: 0o755 });
  return file;
}

/** External CLIs resolve outside the package: none, one, then both installed. */
async function checkExternalCliMatrix(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const cliFixtureRoot = await fs.mkdtemp(path.join(app.getPath("temp"), "studio-external-matrix-"));
  try {
    const isolated = {
      loginPath: cliFixtureRoot,
      env: { PATH: "/usr/bin:/bin" },
      standardDirs: [],
      excludedRoots: [],
      home: cliFixtureRoot,
    };
    check(
      "neither external provider installed: installation guidance available",
      (await discoverCodingCli(EngineId.Codex, isolated)).status.state === CodingCliState.Missing &&
        (await discoverCodingCli(EngineId.ClaudeCode, isolated)).status.state === CodingCliState.Missing,
    );
    const codex = await writeCliFixture(cliFixtureRoot, EngineId.Codex);
    check(
      "one external provider installed: only Codex resolves",
      (await discoverCodingCli(EngineId.Codex, isolated)).status.state === CodingCliState.Ready &&
        (await discoverCodingCli(EngineId.ClaudeCode, isolated)).status.state === CodingCliState.Missing,
    );
    await writeCliFixture(cliFixtureRoot, "claude");
    for (const provider of [EngineId.Codex, EngineId.ClaudeCode] as const) {
      const installation = await discoverCodingCli(provider, isolated);
      check(
        `both external providers: ${provider} resolves outside the package`,
        installation.status.state === CodingCliState.Ready &&
          installation.status.path?.startsWith(cliFixtureRoot) === true,
      );
      const auth = await runCommand(
        required(installation.status.path, "the installed CLI's path"),
        provider === EngineId.Codex ? ["login", "status"] : ["auth", "status", "--json"],
        { env: installation.env },
      );
      check(
        `${provider} external fixture status uses resolved executable`,
        auth.code === 0 && auth.stdout.includes("loggedIn"),
      );
    }
    const execution = await runCommand(codex, ["exec", "--json"], {
      env: isolated.env,
    });
    check(
      "external fixture structured execution works from packaged host",
      execution.code === 0 && JSON.parse(execution.stdout).thread_id === "external-fixture",
    );
  } finally {
    await fs.rm(cliFixtureRoot, { recursive: true, force: true });
  }
}

/** The Codex and Claude sign-ins answer through the real preload without an account. */
async function checkSignInDialogs(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const { window } = smoke.ctx;
  // Exercise the real preload subscription and dialog without authenticating an account.
  pushToRenderer(window.webContents, "studio:codex-login", {
    revision: 1,
    visible: true,
    phase: "waiting",
    method: "device",
    hasBrowserUrl: true,
    deviceCode: "ABCD-EFGH",
    lines: ["Sign in with your one-time code."],
  });
  await sleep(150);
  const loginUi = (await window.webContents.executeJavaScript(`({
      dialog: !!document.querySelector('[role="dialog"][data-testid="codex-login-panel"]'),
      code: document.body.innerText.includes('ABCD-EFGH'),
      browser: [...document.querySelectorAll('button')].some(b => b.textContent === 'Open sign-in page'),
      shellInput: !!document.querySelector('[data-testid="codex-login-panel"] input')
    })`)) as { dialog: boolean; code: boolean; browser: boolean; shellInput: boolean };
  check(
    "in-app Codex login shows device flow without shell access",
    loginUi.dialog && loginUi.code && loginUi.browser && !loginUi.shellInput,
  );
  const loginShot = flagValue(StudioFlag.LoginShot);
  if (loginShot) await fs.writeFile(loginShot, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("window.studio.codexLoginDismiss()");
  await sleep(100);
  check(
    "sign-in panel can be dismissed through IPC",
    await window.webContents.executeJavaScript("!document.querySelector('[data-testid=\"codex-login-panel\"]')"),
  );
  // The Claude sign-in's own channel, through the real preload: no login is running, and the
  // card that would show the code box asks main for exactly this.
  const claudeLoginState = (await window.webContents.executeJavaScript("window.studio.claudeLoginState()")) as {
    phase?: string;
  };
  check(
    "the Claude sign-in reports its state through IPC",
    claudeLoginState?.phase === "idle",
    String(claudeLoginState?.phase),
  );
}

/** Every state a live discovery may honestly report: each one tells the user what to do next. */
const ACTIONABLE_DISCOVERY: readonly string[] = Object.values(CodingCliState);

/**
 * Did discovery report what this launch should see? The state the runner expects when it names
 * one; "missing" in an isolated fixture profile; otherwise any actionable state.
 */
function discoveryAsExpected(state: string, expected: string | undefined, isolated: boolean): boolean {
  if (expected) return state === expected;
  if (isolated) return state === CodingCliState.Missing;
  return ACTIONABLE_DISCOVERY.includes(state);
}

/** The build smoke (`--studio-build-smoke`): the Build room end to end on a fixture game. */
async function runBuildSmoke(smoke: Smoke): Promise<void> {
  const buildSmoke = await startBuildSmoke(smoke);
  await checkReadGates(buildSmoke);
  await checkSidebarToggle(buildSmoke);
  await checkModelRoles(buildSmoke);
  await checkChatModelRoles(buildSmoke);
  if (process.env.STUDIO_DISABLE_OS_CREDENTIALS === "1") await checkCredentialedPlugins(buildSmoke);
  await checkEmptyScaffoldEvidence(buildSmoke);
  const asset = await deliverFixtureAsset(buildSmoke);
  await checkAssetsView(buildSmoke, asset.delivered);
  const captureDir = await checkStartNodes(buildSmoke);
  await checkPluginJobInGraph(buildSmoke, asset.assetJobId);
  await checkComposerDuringBuild(buildSmoke);
  await checkStopAndKeepAwake(buildSmoke, await checkInterruptControls(buildSmoke));
  await checkFinishedRun(buildSmoke);
  await checkMorningCardAndHistory(buildSmoke);
  await checkConcurrentPlay(buildSmoke);
  const follow = await checkFollowRounds(buildSmoke);
  await checkRunTimeAndLead(buildSmoke, follow);
  await checkLiveRevisions(buildSmoke, follow);
  await finishOutcomeRun(buildSmoke, await seedOutcomeRun(buildSmoke), captureDir);
  await checkOutcomePanel(buildSmoke);
  await checkPartRows(buildSmoke);
  await checkChecksAndCapture(buildSmoke);
  await checkActivityAndMcp(buildSmoke);
  await captureBuildShot(buildSmoke);
  await checkSharedDesign(buildSmoke);
  await checkChromeAndCursors(buildSmoke);
  await checkGameImage(buildSmoke);
  await checkOverlayFixture(buildSmoke);
  await checkModelPickerOverlay(buildSmoke);
  await checkContextPanelOverlay(buildSmoke);
}

/**
 * Plugins with the OS credential store blocked (`STUDIO_DISABLE_OS_CREDENTIALS=1`): synthetic
 * ciphertext only, so no real account is ever unlocked.
 */
async function checkCredentialedPlugins(buildSmoke: BuildSmoke): Promise<void> {
  await checkPluginsSurface(buildSmoke);
  await checkPluginSearchAndZoom(buildSmoke);
  await checkGenexPanel(buildSmoke);
  await checkLocalPluginToolbar(buildSmoke);
  await checkMarketplaceAndExample(buildSmoke);
  await checkPublishGate(buildSmoke);
}

/** The build smoke's fixture game, its thread and run, and the helpers every scenario uses. */
/** The time the follow smoke's run was given: its status reads "… of 30 min". */
const FOLLOW_RUN_WALL_CLOCK_MS = 30 * MINUTE_MS;
/** How long a follow shot waits for the restored window to paint. */
const FOLLOW_SHOT_SETTLE_MS = 700;
/** Longer than Live's old automatic swap took (five seconds): long enough to see that nothing swaps now. */
const LIVE_STILL_MS = 6 * SECOND_MS;

/** A page script: open a build in Builds, as its result card in the chat does. */
function openBuildScript(runId: string): string {
  return `window.dispatchEvent(new CustomEvent('studio:open-build', { detail: { runId: ${JSON.stringify(runId)} } }))`;
}

/** A page expression: Builds shows this run. */
function selectedRunIs(runId: string): string {
  return `document.querySelector('[data-stage-view]')?.dataset.selectedRun===${JSON.stringify(runId)}`;
}

/** With `--studio-build-shot`, a live moment of the follow smoke is saved beside that shot as evidence. */
async function followShot(buildSmoke: BuildSmoke, name: string): Promise<void> {
  const shot = flagValue(StudioFlag.BuildShot);
  if (!shot) return;
  const { window } = buildSmoke.ctx;
  if (window.isMinimized()) window.restore();
  window.showInactive();
  await sleep(FOLLOW_SHOT_SETTLE_MS);
  await fs.writeFile(path.join(path.dirname(shot), `${name}.png`), (await buildSmoke.wc.capturePage()).toPNG());
}

interface BuildSmoke extends Smoke {
  project: { name: string; dir: string };
  threadId: string;
  runId: string;
  /** Append a custom event of this build's run to its thread. */
  append(eventType: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Poll an expression in the window until it is true; false on timeout. */
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
}

/** What the interrupt checks leave for the Stop checks: the sheet probe and the recorded cancels. */
interface Interrupts {
  sheetOpen: string;
  stopDispatches: string[];
  realDispatch: StudioCore["host"]["dispatch"];
}

/** The run the follow checks drive, and the appender that tags its events. */
interface FollowRun {
  followRun: string;
  followEvent: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
}

/** The run the outcome checks read, and the appender that tags its events. */
interface OutcomeRun {
  outcomeRun: string;
  outcomeEvent: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
}

/** The fixture game and its thread, the scripted coordinator, and the window pointed at them. */
async function startBuildSmoke(smoke: Smoke): Promise<BuildSmoke> {
  const { wc } = smoke;
  const { core } = smoke.ctx;
  const project = await core.games.scaffold("build-preview-smoke", { title: "Build preview smoke" });
  const threadId = await core.threadForGame(project.name);
  const runId = "run_preview_smoke";
  // Script only the coordinator in this isolated smoke app; never call a paid model.
  core.engines.register({
    id: EngineId.Codex,
    label: "Codex",
    kind: EngineKind.Delegated,
    status: async () => ({ code: EngineStatusCode.Ready, detail: "smoke fixture" }),
    models: async () => [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        contextWindow: 200000,
        maxTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
      },
    ],
    complete: async () => ({
      engine: EngineId.Codex,
      model: "gpt-5.6-sol",
      stopReason: "stop",
      message: { role: "assistant", content: "Smoke fixture" },
      usage: {},
    }),
    delegate: async (request) => {
      if (!request.coordinator) throw new Error(MESSAGE.coordinatorExpected);
      await required(request.onLiveTool, "a live tool bridge")("run_status", {});
      return {
        ok: true,
        engine: EngineId.Codex,
        turns: 1,
        usage: {},
        sessionId: "smoke-coordinator",
        summary: "The existing river and cottages builds are still visible. No new build was started.",
      };
    },
  });
  const append = async (event_type: string, payload: Record<string, unknown>) =>
    core.append([{ type: EventKind.Custom, event_type, payload: { runId, ...payload } }], threadId);
  await wc.executeJavaScript(`localStorage.setItem("studio.activeThread", ${JSON.stringify(threadId)})`);
  await wc.executeJavaScript(
    `localStorage.setItem(${JSON.stringify(`studio.model.${threadId}`)}, "codex::gpt-5.6-sol")`,
  );
  const waitFor = (expression: string, timeoutMs = BUILD_WAIT_MS) =>
    waitUntil(
      async () => {
        // This fixture window is hidden: capture advances its compositor so ResizeObserver,
        // media queries and overlay exit animations can settle as they do in a visible app.
        await wc.capturePage().catch(() => {}); // the surface may be replacing itself during reload
        return wc.executeJavaScript(expression).catch(() => false);
      },
      { timeoutMs, intervalMs: WINDOW_POLL_MS },
    );
  return { ...smoke, project, threadId, runId, append, waitFor };
}

/** Delayed and failed IPC reads: empty data and unavailable data must never look alike. */
async function checkReadGates(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { smokeReads } = buildSmoke.ctx;
  // Delay actual IPC reads; empty data and unavailable data must never look alike.
  // Faults persist until the explicit retry: StrictMode may replay mount reads,
  // so a one-shot rejection can be consumed by an already-disposed effect.
  smokeReads.failBootstrap = true;
  wc.reload();
  check(
    "bootstrap failure lifts the startup loader and offers Retry instead of empty games",
    await waitFor(
      `document.body.innerText.includes('Could not load games and chats.')&&!document.body.innerText.includes('No games yet')&&!document.getElementById('app-loader')`,
    ),
  );
  smokeReads.failBootstrap = false;
  let releaseBootstrap!: () => void, releaseThread!: () => void;
  smokeReads.bootstrap = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  smokeReads.thread = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry')?.click()`,
  );
  check(
    "a pending retry keeps the failure up with Retry busy, never Ready or empty games",
    await waitFor(
      `Array.from(document.querySelectorAll('[role="alert"] button')).some(b=>b.textContent==='Retrying…'&&b.disabled)&&!document.body.innerText.includes('No games yet')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Ready')`,
    ),
  );
  releaseBootstrap();
  smokeReads.bootstrap = undefined;
  check(
    "games can load while the chat is still pending",
    await waitFor(
      `!document.body.innerText.includes('Could not load games and chats.')&&!!document.querySelector('[aria-label="Loading conversation…"]')&&!!document.querySelector('nav [data-project]')`,
    ),
  );
  smokeReads.failThread = true;
  releaseThread();
  smokeReads.thread = undefined;
  check(
    "thread read failure offers Retry instead of an empty conversation",
    await waitFor(
      `document.body.innerText.includes('Could not load this chat.')&&Array.from(document.querySelectorAll('[role="alert"] button')).some(b=>b.textContent==='Retry'&&!b.disabled)`,
    ),
  );
}

/** The sidebar hides and comes back, and a failed thread read offers Retry. */
async function checkSidebarToggle(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { smokeReads } = buildSmoke.ctx;
  await wc.executeJavaScript(`document.querySelector('[aria-label="Hide sidebar"]')?.click()`);
  check(
    "chat failure keeps sidebar navigation reachable",
    await waitFor(
      `document.querySelector('[data-studio-state]')?.dataset.sidebarOpen==='false' && !!document.querySelector('[data-chat-header] [aria-label="Show sidebar"]') && !document.querySelector('[data-chat-header]').closest('[inert]')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[aria-label="Show sidebar"]')?.click()`);
  await waitFor(`document.querySelector('[data-studio-state]')?.dataset.sidebarOpen==='true'`);
  smokeReads.failThread = false;
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry')?.click()`,
  );
  check(
    "chat retry completes and leaves nothing pending",
    await waitFor(
      `!document.querySelector('[aria-label="Loading conversation…"]')&&!document.body.innerText.includes('Could not load this chat.')`,
    ),
  );
  check(
    "new project shows an empty-state message outside the canvas",
    await waitFor(`document.body.innerText.includes('Ready for your first idea')`),
  );
}

/** Bonsai as a descriptor fixture, the Studio model menu, and the local models in Settings. */
async function checkModelRoles(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  // Bonsai UI acceptance uses only a descriptor fixture: no weights, runtime or accounts.
  core.engines.register({
    id: EngineId.Bonsai,
    label: "Bonsai · on this Mac",
    kind: EngineKind.Direct,
    supportsSessions: true,
    status: async () => ({ code: EngineStatusCode.Ready, detail: "UI fixture" }),
    models: async () => [
      {
        id: "bonsai-2:27b-pq2_0",
        label: "Bonsai 2 27B · PQ2_0",
        contextWindow: 102400,
        maxTokens: 4096,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
        efforts: [ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High, ReasoningEffort.Max],
        defaultEffort: ReasoningEffort.Low,
      },
    ],
    defaultModel: async () => "bonsai-2:27b-pq2_0",
  });
  pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.Bonsai } });
  // Timed runs start from a game chat's Loop control now; Studio's own chat has one model menu.
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="studio"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-studio-composer] [aria-label="Model settings"]')`);
  await wc.executeJavaScript(`document.querySelector('[data-studio-composer] [aria-label="Model settings"]')?.click()`);
  await waitFor(`!!document.querySelector('[aria-label="Model options"] [data-model-list="planner"]')`);
  check(
    "Studio's model menu offers the ready Bonsai model",
    await waitFor(`!!document.querySelector('[data-model-choice^="bonsai::"]:not(:disabled)')`),
  );
  await wc.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  await waitFor(`!document.querySelector('[aria-label="Model options"]')`);
  await wc.executeJavaScript(`document.querySelector('nav [aria-label="Settings"]')?.click()`);
  await waitFor(`!!document.querySelector('#settings-tab-local')`);
  await wc.executeJavaScript(`document.querySelector('#settings-tab-local')?.click()`);
  // Each row names the model and its variant apart ("Bonsai 2 27B", "PQ2_0").
  check(
    "Bonsai setup offers installed PQ2_0 and downloadable PTQ1_0",
    await waitFor(
      `(()=>{const d=document.querySelector('[data-testid="settings-dialog"]');const row=v=>Array.from(d?.querySelectorAll('span')??[]).find(e=>e.textContent===v)?.closest('.border-b');return !!row('PQ2_0')?.textContent.includes('Installed')&&!!document.querySelector('button[aria-label="Download Bonsai 2 27B PTQ1_0"]');})()`,
    ),
  );
  const setupShot = flagValue(StudioFlag.BuildShot);
  if (setupShot) {
    await wc.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-testid="settings-dialog"] span')).find(e=>e.textContent==='PQ2_0')?.scrollIntoView({block:'center'})`,
    );
    await sleep(300);
    await fs.writeFile(setupShot.replace(/\.png$/, "-downloads.png"), (await wc.capturePage()).toPNG());
  }
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Download Bonsai 2 27B PTQ1_0"]')?.click()`);
  check(
    "model download rejection clears progress and displays its error",
    await waitFor(
      `Array.from(document.querySelectorAll('[role="alert"]')).some(e=>e.textContent.includes('unsupported-in-fixture'))`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-testid="settings-dialog"] [aria-label="Close"]')?.click()`);
  await waitFor(`!document.querySelector('[data-testid="settings-dialog"]')`);
}

/** A game chat picks its builder and judge, and the choice survives a reload. */
async function checkChatModelRoles(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, threadId, waitFor } = buildSmoke;
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="${threadId}"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-chat-composer] [aria-label="Model settings"]')`);
  await wc.executeJavaScript(`document.querySelector('[aria-label="Model settings"]')?.click()`);
  await waitFor(`document.querySelector('[aria-label="Model settings"]')?.getAttribute('aria-expanded')==='true'`);
  await waitFor(`!!document.querySelector('[data-model-view="roles"] [data-role="builder"]')`);
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="builder"]')?.click()`);
  check(
    "Codex workers offer Bonsai",
    await waitFor(`!!document.querySelector('[data-model-list="builder"] [data-model-choice^="bonsai::"]')`),
  );
  await wc.executeJavaScript(`document.querySelector('[data-model-choice^="bonsai::"]')?.click()`);
  check(
    "choosing a local worker preserves its engine/model pair",
    await waitFor(`JSON.parse(localStorage.getItem('studio.roles.codex')||'{}').roles?.engines?.builder==='bonsai'`),
  );
  await wc.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));localStorage.removeItem('studio.roles.codex');localStorage.setItem(${JSON.stringify(`studio.model.${threadId}`)},'bonsai::bonsai-2:27b-pq2_0')`,
  );
  wc.reload();
  check(
    "Bonsai selection restores on reload",
    await waitFor(`document.querySelector('[aria-label="Model settings"]')?.textContent.includes('Bonsai')`),
  );
  await wc.executeJavaScript(`document.querySelector('[aria-label="Model settings"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-model-view="roles"] [data-role="judge"]')`);
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="judge"]')?.click()`);
  check(
    "Bonsai judges offer Codex",
    await waitFor(`!!document.querySelector('[data-model-list="judge"] [data-model-choice^="codex::"]')`),
  );
  const bonsaiShot = flagValue(StudioFlag.BuildShot);
  if (bonsaiShot) {
    await sleep(300);
    await fs.writeFile(bonsaiShot.replace(/\.png$/, "-bonsai.png"), (await wc.capturePage()).toPNG());
  }
  await checkLocalModelRoles(buildSmoke);
  await wc.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));localStorage.setItem(${JSON.stringify(`studio.model.${threadId}`)},'codex::gpt-5.6-sol')`,
  );
  wc.reload();
  check(
    "returning to Codex preserves the project",
    await waitFor(
      `document.body.innerText.includes('Ready for your first idea')&&document.querySelector('[aria-label="Model settings"]')?.textContent.includes('Sol')`,
    ),
  );
}

/**
 * A game chat on a completion-only local engine gives each job its own model: the fake Ollama
 * lists one model that sees and a coding model that cannot, and a reviewer must see.
 */
async function checkLocalModelRoles(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  await wc.executeJavaScript(`localStorage.removeItem('studio.roles.ollama')`);
  await openGameChatOn(buildSmoke, "ollama::coder:7b", "coder");
  check(
    "an Ollama main agent offers Workers and Reviewers",
    await waitFor(`!!document.querySelector('[data-model-view="roles"] [data-role="builder"]')`),
  );
  check(
    "a main agent that cannot see leaves reviewing to the local model that can",
    await waitFor(`JSON.parse(localStorage.getItem('studio.roles.ollama')||'{}').roles?.judge==='qwen3.6:27b'`),
  );
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="judge"]')?.click()`);
  check(
    "Ollama reviewers offer the model that sees and the subscription, and refuse the one that cannot see",
    await waitFor(
      `!!document.querySelector('[data-model-list="judge"] [data-model-choice="ollama::qwen3.6:27b"]:not(:disabled)')&&!!document.querySelector('[data-model-list="judge"] [data-model-choice="ollama::coder:7b"]:disabled')&&!!document.querySelector('[data-model-list="judge"] [data-model-choice^="codex::"]')`,
    ),
  );
  const localShot = flagValue(StudioFlag.BuildShot);
  if (localShot) {
    await sleep(300);
    await fs.writeFile(localShot.replace(/\.png$/, "-ollama-roles.png"), (await wc.capturePage()).toPNG());
  }
  await openGameChatOn(buildSmoke, "codex::gpt-5.6-sol", "Sol");
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="judge"]')?.click()`);
  check(
    "Codex reviewers offer the local model that sees",
    await waitFor(
      `!!document.querySelector('[data-model-list="judge"] [data-model-choice="ollama::qwen3.6:27b"]:not(:disabled)')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="builder"]')?.click()`);
  check(
    "Codex workers offer no Ollama model",
    await waitFor(
      `!!document.querySelector('[data-model-list="builder"] [data-model-choice^="codex::"]')&&!document.querySelector('[data-model-list="builder"] [data-model-choice^="ollama::"]')`,
    ),
  );
}

/** Reload on a model for the game's chat, open that chat itself and its model menu. */
async function openGameChatOn(buildSmoke: BuildSmoke, modelKey: string, shown: string): Promise<void> {
  const { wc, threadId, waitFor } = buildSmoke;
  await wc.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));localStorage.setItem(${JSON.stringify(`studio.model.${threadId}`)},${JSON.stringify(modelKey)})`,
  );
  wc.reload();
  // Open the game's chat itself: the reload is not relied on to land there.
  await waitFor(`!!document.querySelector('nav [data-thread="${threadId}"]')`);
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="${threadId}"]')?.click()`);
  await waitFor(
    `document.querySelector('[data-chat-composer] [aria-label="Model settings"]')?.textContent.includes(${JSON.stringify(shown)})`,
  );
  await wc.executeJavaScript(`document.querySelector('[data-chat-composer] [aria-label="Model settings"]')?.click()`);
}

/** Plugins is a workspace page with bundled Genex, and it hides the native preview. */
async function checkPluginsSurface(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { core, previewBoundsSeen } = buildSmoke.ctx;
  // Synthetic ciphertext only; the OS backend is blocked before Electron import.
  await fs.mkdir(path.join(core.pluginServices.root("genex"), "credentials"), { recursive: true });
  await fs.writeFile(
    path.join(core.pluginServices.root("genex"), "credentials/genex.bin"),
    "fixture-not-a-real-credential",
  );
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Plugins"]').click()`);
  check(
    "Plugins surface opens with bundled Genex, shown as the game dev tools router",
    await waitFor(
      `document.querySelector('[aria-label="Studio plugins"] [data-plugin-row="genex"]')?.textContent.includes('Game dev tools router')`,
    ),
  );
  check(
    "Plugins is a workspace page, not a dialog",
    await waitFor(
      `!!document.querySelector('[data-plugins-page]')&&!document.querySelector('[role="dialog"][aria-label="Studio plugins"]')&&document.querySelector('[data-studio-state]')?.getAttribute('data-room')==='plugins'`,
    ),
  );
  check(
    "Genex row offers one Connect button for a locked account",
    await waitFor(`!!document.querySelector('[data-plugin-row="genex"] [aria-label="Connect Game dev tools router"]')`),
  );
  check(
    "bundled plugins show their pictures: Local Blender its own, Genex the eight tools it routes",
    await waitFor(
      `document.querySelector('[data-plugin-row="blender"] img.extension-icon')?.naturalWidth>0&&(()=>{const marks=[...document.querySelectorAll('[data-plugin-row="genex"] .router-icon img')];return marks.length===8&&marks.every(m=>m.naturalWidth>0);})()`,
    ),
  );
  check(
    "Optional connectors do not demand setup by default",
    await waitFor(
      `!Array.from(document.querySelectorAll('[data-testid="mcp-connectors"] button')).some(b=>b.textContent==='Finish setup')`,
    ),
  );
  check("Plugins page hides the native preview", (previewBoundsSeen.last as { width: number } | null)?.width === 0);
  check(
    "Plugins hides every preserved workspace layer",
    await waitFor(
      `(()=>{const w=document.querySelector('.studio-workspace');return !!w&&w.inert&&getComputedStyle(w).opacity==='0';})()`,
    ),
  );
  check(
    "plugin rows and nested icons use pointer cursors",
    await wc.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-plugins-page] button:enabled, [data-plugins-page] button:enabled svg, [data-plugins-page] button:enabled span')).every(e=>getComputedStyle(e).cursor==='pointer')`,
    ),
  );
}

/** Plugin search, Skills, and the page at 200 percent zoom and compact width. */
async function checkPluginSearchAndZoom(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { window } = buildSmoke.ctx;
  const pluginShot = flagValue(StudioFlag.BuildShot);
  const capturePlugins = async (suffix: string) => {
    if (pluginShot) {
      await wc.capturePage();
      await sleep(SETTLE_MS);
      await fs.writeFile(pluginShot.replace(/\.png$/, `-plugins-${suffix}.png`), (await wc.capturePage()).toPNG());
    }
  };
  await capturePlugins("overview");
  await wc.executeJavaScript(`document.querySelector('[aria-label="Search plugins and MCP servers"]').focus()`);
  wc.insertText("no-such-extension");
  check(
    "plugin search filters plugins and MCP servers",
    await waitFor(
      `!document.querySelector('[data-plugin-row]')&&document.querySelector('[data-plugins-page]')?.textContent.includes('No MCP servers match your search.')`,
    ),
  );
  await capturePlugins("empty-search");
  await wc.executeJavaScript(`document.querySelector('[data-plugins-page] [aria-label="Clear search"]').click()`);
  await wc.executeJavaScript(`document.querySelector('[aria-label="Extensions"] button:nth-child(2)').click()`);
  check(
    "Skills lists actual installed plugin contributions",
    await waitFor(
      `document.querySelector('[data-plugins-page] h1')?.textContent==='Skills'&&document.querySelector('[data-plugins-page]')?.textContent.includes('asset-preference')`,
    ),
  );
  await capturePlugins("skills");
  const [pluginWidth = 0, pluginHeight = 0] = window.getSize();
  const pluginZoom = wc.getZoomFactor();
  window.setSize(1000, 720);
  wc.setZoomFactor(2);
  check(
    "Plugins at 200 percent zoom keeps header actions reachable",
    await waitFor(
      `(()=>{const p=document.querySelector('[data-plugins-page]'),a=p?.querySelector('[aria-label="Add integration"]'),s=p?.querySelector('[aria-label="Show sidebar"]');return !!a&&!!s&&a.getBoundingClientRect().right<=innerWidth&&s.getBoundingClientRect().left>=76&&p.scrollWidth<=p.clientWidth;})()`,
    ),
  );
  check(
    "Skills collapses to a single column at compact width",
    await waitFor(
      `getComputedStyle(document.querySelector('[data-plugins-page] .extensions-grid')).gridTemplateColumns.split(' ').length===1`,
    ),
  );
  await capturePlugins("zoom-200");
  window.setSize(pluginWidth, pluginHeight);
  wc.setZoomFactor(pluginZoom);
}

/**
 * Genex's page draws everything itself: its account card and the tools it routes; its own servers
 * run unseen. No plugin frame is left on it; sensitive actions still need Studio's review.
 */
async function checkGenexPanel(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { core } = buildSmoke.ctx;
  await wc.executeJavaScript(`document.querySelector('[aria-label="Extensions"] button:first-child').click()`);
  await wc.executeJavaScript(`document.querySelector('button[aria-label="View Game dev tools router"]').click()`);
  check("Genex page draws its own account card", await waitFor(`!!document.querySelector('[data-genex-account]')`));
  check(
    "Genex page lists the tools it routes and no Connections",
    await waitFor(
      `!!document.querySelector('[data-genex-tools] [data-genex-tool="meshy"]')&&!document.querySelector('[data-plugin-connections]')`,
    ),
  );
  check(
    "Genex page shows no plugin frame and no per-game numbers",
    await waitFor(
      `!document.querySelector('[data-plugins-page] iframe')&&!document.querySelector('[data-plugins-page]').textContent.includes('Used by this game')`,
    ),
  );
  const rejected = await wc.executeJavaScript(
    `window.studio.pluginAction('genex','disconnect',{}).then(()=>false,e=>String(e).includes('Review this action'))`,
  );
  check("sensitive actions refuse a manufactured approval", rejected);

  let unlockError = "";
  try {
    await core.plugins.action("genex", "unlock", {});
  } catch (e) {
    unlockError = String(e);
  }
  check("blocked credential access reports an actionable error", unlockError.includes("Automatic retries are paused"));
  const locked = await core.plugins.action("genex", "status", {});
  check(
    "failed unlock remains disconnected on the next status refresh",
    !locked.connected && locked.credentialState === CredentialState.Failed,
  );
}

/** A local SDK example: its toolbar button, its isolated frame, and enable/disable events. */
async function checkLocalPluginToolbar(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, threadId, waitFor } = buildSmoke;
  const { core, resources } = buildSmoke.ctx;
  const exampleDir = path.join(resources, "examples/example");
  await core.plugins.installLocal(
    exampleDir,
    "local",
    undefined,
    { kind: PluginSourceKind.Local, directory: exampleDir },
    await scanPackage(exampleDir, await inspectPackage(exampleDir)),
  );
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="${threadId}"]').click()`);
  // The top bar learns about the new plugin from plugins.changed alone: the page is closed,
  // so nothing else is polling the list.
  check(
    "plugin toolbar button appears with the Plugins page closed",
    await waitFor(
      `!document.querySelector('[aria-label="Studio plugins"]')&&!!document.querySelector('[data-plugin-toolbar="example:demo"]')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-plugin-toolbar="example:demo"]')?.click()`);
  check(
    "toolbar panel opens as an isolated frame",
    await waitFor(
      `document.querySelector('[role="dialog"][aria-label="SDK demo"] iframe[sandbox="allow-scripts"]')?.getAttribute('sandbox')==='allow-scripts'`,
    ),
  );
  const toolbarFrame = () => wc.mainFrame.frames.find((f) => f.url.startsWith("studio-plugin://example/"));
  await waitUntil(() => toolbarFrame(), PLUGIN_FRAME_POLL);
  check(
    "toolbar panel frame has no Studio preload or Node",
    await frameSays(
      toolbarFrame(),
      `typeof window.studio==='undefined'&&typeof require==='undefined'&&typeof process==='undefined'`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('[role="dialog"][aria-label="SDK demo"] button[aria-label="Close"]').click()`,
  );
  check(
    "toolbar panel closes from its own button",
    await waitFor(`!document.querySelector('[role="dialog"][aria-label="SDK demo"]')`),
  );
  await core.plugins.setEnabled("example", false);
  check(
    "disabling a plugin removes its toolbar button through the change event",
    await waitFor(`!document.querySelector('[data-plugin-toolbar="example:demo"]')`),
  );
  await core.plugins.setEnabled("example", true);
  check(
    "re-enabling a plugin brings its toolbar button back",
    await waitFor(`!!document.querySelector('[data-plugin-toolbar="example:demo"]')`),
  );
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Plugins"]').click()`);
  check(
    "independent local SDK example appears in plugin inventory",
    await waitFor(
      `document.querySelector('[aria-label="Studio plugins"]')?.textContent.includes('Plugin SDK example')`,
    ),
  );
}

/** The offline marketplace, the GitHub install, and the example's own panel. */
async function checkMarketplaceAndExample(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  // A fixture profile is offline: the catalog offers nothing, so the Marketplace is only Coming soon.
  check(
    "the Marketplace is coming soon in a fixture profile, and lists nothing",
    await waitFor(
      `!!document.querySelector('[aria-label="Studio plugins"] [data-marketplace-soon]')&&!document.querySelector('[aria-label="Studio plugins"] [data-more-plugins]')`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('button[aria-label="Add integration"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))`,
  );
  await waitFor(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(b=>b.textContent==='Install from GitHub…')`,
  );
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='Install from GitHub…').click()`,
  );
  check(
    "the Plugins Add menu opens Install from GitHub for a pasted link",
    await waitFor(`!!document.querySelector('[data-testid="github-install"] input[aria-label="GitHub link"]')`),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-testid="github-install"] input[aria-label="GitHub link"]').focus()`,
  );
  wc.insertText("https://gitlab.com/acme/tools");
  await wc.executeJavaScript(`document.querySelector('[data-testid="github-install"] form').requestSubmit()`);
  check(
    "a link that is not GitHub's is answered in the window, before anything is fetched",
    await waitFor(
      `document.querySelector('[data-testid="github-install"] [role="alert"]')?.textContent.includes('isn’t a link to a GitHub repository')`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-testid="github-install"] button[aria-label="Close"]').click()`,
  );
  await waitFor(`!document.querySelector('[data-testid="github-install"]')`);
  await wc.executeJavaScript(`document.querySelector('button[aria-label="View Plugin SDK example"]').click()`);
  check(
    "the installed example discloses what its code appears to do",
    await waitFor(`document.querySelector('[aria-label="Studio plugins"]')?.textContent.includes('Scan: safe')`),
  );
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('[aria-label="Studio plugins"] button')).find(b=>b.textContent==='SDK demo').click()`,
  );
  let exampleFrame: WebFrameMain | undefined;
  await waitUntil(
    () => (exampleFrame = wc.mainFrame.frames.find((f) => f.url.startsWith("studio-plugin://example/"))),
    PLUGIN_FRAME_POLL,
  );
  if (exampleFrame) await exampleFrame.executeJavaScript(`document.querySelector('#try').click()`);
  const frame = exampleFrame;
  const replied =
    !!frame &&
    (await waitUntil(
      async () =>
        Boolean(
          await frame.executeJavaScript(`document.querySelector('#result').textContent.includes('backend is working')`),
        ),
      PLUGIN_FRAME_POLL,
    ));
  check("independent custom panel invokes its own backend", replied);
}

/** Genex's Publish button, its panel, the native gate, and what disable, remove and restore do. */
async function checkPublishGate(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project, threadId, waitFor } = buildSmoke;
  const { core } = buildSmoke.ctx;
  // Finish the settings flow before opening a stage action; a programmatic click behind
  // its modal can race dismissal and leave the later close aimed at an unmounted dialog.
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="${threadId}"]').click()`);
  check(
    "plugin settings close before the stage publishing flow",
    await waitFor(`!document.querySelector('[aria-label="Studio plugins"]')`),
  );
  // Genex's own top-bar contribution: the button, its panel, and the native gate in front of
  // the confirmed action. No live account is touched — the fixture profile refuses the dialog.
  check(
    "Genex contributes a Publish button to the stage top bar",
    await waitFor(`!!document.querySelector('button[aria-label="Publish game"]')`),
  );
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Publish game"]').click()`);
  check(
    "Studio draws the Publish dialog and reads the game's publishing state",
    await waitFor(
      `!!document.querySelector('[role="dialog"][aria-label="Publish to the web"] [data-genex-publish-status]')&&!document.querySelector('[role="dialog"][aria-label="Publish to the web"] iframe')`,
    ),
  );
  const publishRefused = await wc.executeJavaScript(
    `window.studio.pluginReview('genex','publish-draft',{},${JSON.stringify(project.name)}).then(r=>window.studio.pluginAction('genex','publish-draft',{},${JSON.stringify(project.name)},r.ticket)).then(()=>false,e=>String(e).includes('unsupported-in-fixture'))`,
  );
  check("fixture native policy blocks the publish confirmation", publishRefused);
  await wc.executeJavaScript(
    `document.querySelector('[role="dialog"][aria-label="Publish to the web"] button[aria-label="Close"]').click()`,
  );
  check(
    "Publish closes before changing plugin availability",
    await waitFor(`!document.querySelector('[role="dialog"][aria-label="Publish to the web"]')`),
  );
  await core.plugins.setEnabled("genex", false);
  check(
    "disabled Genex contributes no tools or guidance",
    !core.plugins.tools().some((t) => t.name.startsWith("genex__")) && !core.plugins.guidance().includes("Genex"),
  );
  // Publish stays for every open game: with Genex off it offers to turn Genex on.
  check(
    "disabled Genex leaves a Publish that offers to turn it on",
    await waitFor(`!!document.querySelector('button[aria-label="Publish game"]')`),
  );
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Publish game"]').click()`);
  check(
    "Publish with Genex off asks to turn it on",
    await waitFor(
      `[...document.querySelectorAll('[role="dialog"][aria-label="Publish to the web"] button')].some((b)=>b.textContent.trim()==="Turn on Genex plugin")`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('[role="dialog"][aria-label="Publish to the web"] button[aria-label="Close"]').click()`,
  );
  await core.plugins.remove("genex");
  check(
    "removed Genex retains prior accounting and ciphertext",
    Boolean(await fs.stat(path.join(core.pluginServices.root("genex"), "credentials/genex.bin")).catch(() => null)),
  );
  await core.plugins.restore("genex");
  check(
    "restored Genex brings its own Publish button back",
    await waitFor(
      `!document.querySelector('[data-studio-publish]') && !!document.querySelector('[data-plugin-toolbar="genex:publish"]')`,
    ),
  );
}

/** A fresh project's real evidence, and a started build opening its Builds panel. */
async function checkEmptyScaffoldEvidence(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project, runId, append, waitFor } = buildSmoke;
  const { core, resources, pushUiEvent } = buildSmoke.ctx;
  const callHost = hostCaller(core);
  const observed = (await callHost(HostMethod.PreviewEvaluate, {
    expression: `(() => { const s = window.__studio; const i = s.inspect(); const state = s.state(); return { children: i.scene.children.length, player: state.player, hudItems: state.hud.items.length, phase: state.phase }; })()`,
  })) as { children: number; player: unknown; hudItems: number; phase: string };
  check(
    "fresh project has no stock geometry, player or HUD",
    observed.children === 0 && observed.player === null && observed.hudItems === 0 && observed.phase === "empty",
    JSON.stringify(observed),
  );
  const { pathToFileURL } = await import("node:url");
  const { gatherEvidence } = await import(pathToFileURL(path.join(resources, "harness-seed/loop/gauntlet.ts")).href);
  const context = { call: callHost };
  const request = {
    run: { runId, project: project.name },
    iterationId: "base",
    seed: 1,
    scaffold: true,
    eyes: false,
    audio: false,
  };
  const base = await gatherEvidence(context, request);
  check("real empty base passes infrastructure checks", base.ok && base.emptyScene, JSON.stringify(base.problems));
  const generated = await gatherEvidence(context, { ...request, iterationId: "001", scaffold: false });
  check(
    "real empty canvas fails generated-game checks",
    !generated.ok && !generated.emptyScene,
    JSON.stringify(generated.problems),
  );
  await append(CustomEvent.RunStarted, {
    project: project.name,
    engine: EngineId.Codex,
    model: "sonnet",
    builderEngine: EngineId.ClaudeCode,
    judgeModel: "gpt-5.5",
    goal: "A village beside a river",
  });
  await append(CustomEvent.AutopilotStarted, {
    maxParallel: 2,
    facets: [
      { id: "river", title: "River and bridge", budgetShare: 0.5 },
      { id: "cottages", title: "Timber cottages", budgetShare: 0.5 },
    ],
  });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId } });
  // New work opens Builds once. The user's later tab choices stay theirs.
  check(
    "a running build opens its Builds panel",
    await waitFor(
      `document.querySelector('[data-stage-view]')?.dataset.stageView === 'builds' && !!document.querySelector('[data-stage-action="builds"]')`,
    ),
    await wc.executeJavaScript(
      `JSON.stringify({state:document.querySelector('[data-studio-state]')?.dataset,stage:document.querySelector('[data-stage-view]')?.dataset,actions:[...document.querySelectorAll('[data-stage-action]')].map(e=>e.dataset.stageAction)})`,
    ),
  );
}

/** A real delivery through the Genex plugin's own `assets.deliver`, of a fixture job. */
async function deliverFixtureAsset(buildSmoke: BuildSmoke): Promise<{ assetJobId: string; delivered: string[] }> {
  const { check, project, threadId, waitFor } = buildSmoke;
  const { core } = buildSmoke.ctx;
  // ── the Assets stage ───────────────────────────────────────────────────────────────
  // A real delivery, not a synthetic one: the fixture job is written under the Genex
  // plugin's own storage and handed to the real `assets.deliver` service, so the copy into
  // the game, the host's ledger append and the UI push all happen exactly as they do for a
  // paid generation. The canvas then has to read that very PNG back out of the game
  // through the contained reader — a card with a picture on it is the proof.
  const assetJobId = randomUUID();
  const assetJobDir = path.join(core.pluginServices.root("genex"), "projects", project.name, "jobs", assetJobId);
  await fs.mkdir(path.join(assetJobDir, "output"), { recursive: true });
  await fs.writeFile(
    path.join(assetJobDir, "output/banner.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await fs.writeFile(
    path.join(assetJobDir, "job.json"),
    JSON.stringify({
      id: assetJobId,
      project: project.name,
      operation: "image",
      status: "downloaded",
      files: [],
      createdAt: new Date().toISOString(),
    }),
  );
  const delivered = (await core.pluginServices.call(
    "genex",
    "assets.deliver",
    { output: path.join(assetJobDir, "output"), jobId: assetJobId },
    { project: project.name, directory: project.dir, threadId },
  )) as string[];
  check(
    "Assets tab is offered for a loaded game",
    await waitFor(`!!document.querySelector('[data-stage-action="assets"]')`),
  );
  return { assetJobId, delivered };
}

/** The Assets stage shows the delivered image, the log records it, and Live comes back. */
async function checkAssetsView(buildSmoke: BuildSmoke, delivered: string[]): Promise<void> {
  const { wc, check, checkAsync, project, threadId, waitFor } = buildSmoke;
  const { core, previewBoundsSeen } = buildSmoke.ctx;
  // Forget the last rectangle so the next one is the answer to this click, not the one the
  // empty-scene copy already asked for.
  previewBoundsSeen.last = null;
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="assets"]').click()`);
  await checkAsync(
    "Assets view takes the stage and hides the native game",
    async () => {
      if (!(await waitFor(`document.querySelector('[data-stage-view]')?.dataset.stageView === 'assets'`))) return false;
      return waitUntil(
        () => {
          const seen = previewBoundsSeen.last;
          return seen && seen.width === 0 && seen.height === 0;
        },
        { timeoutMs: 5_000, intervalMs: 100 },
      );
    },
    () => `last bounds=${JSON.stringify(previewBoundsSeen.last)}`,
  );
  check(
    "delivered image renders as an asset card through the contained reader",
    await waitFor(
      `(() => { const card = document.querySelector('[data-asset-card$="/banner.png"]'); const img = card && card.querySelector('img'); return !!img && img.complete && img.naturalWidth === 1 && card.dataset.assetSource === 'genex'; })()`,
    ),
    delivered.join(" · "),
  );
  const assetLog = await core.store.listEvents(threadId);
  check(
    "delivery is recorded in the project's log",
    assetLog.some((event) => {
      if (event.data.type !== EventKind.Custom || event.data.event_type !== CustomEvent.AssetDelivered) return false;
      const files = (event.data.payload as { files?: Array<{ file?: string }> }).files;
      return (
        Array.isArray(files) && files.some((row) => typeof row.file === "string" && row.file.endsWith("/banner.png"))
      );
    }),
  );
  if (flagValue(StudioFlag.AssetsSmokeDir)) {
    const { assetPreviewSmoke } = await import("./asset-preview-smoke.ts");
    await assetPreviewSmoke(
      wc,
      core,
      project.name,
      required(flagValue(StudioFlag.AssetsSmokeDir), StudioFlag.AssetsSmokeDir),
      check,
      waitFor,
    );
  }
}

/** The start, the parallel nodes and the base failure appear before any verdict. */
async function checkStartNodes(buildSmoke: BuildSmoke): Promise<string> {
  const { wc, check, runId, append, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  // The stage goes back to the game before the Builds checks below, which start from Live.
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="live"]').click()`);
  check(
    "leaving Assets gives the stage back to the game",
    await waitFor(`document.querySelector('[data-stage-view]')?.dataset.stageView === 'live'`),
  );
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="builds"]').click()`);
  check(
    "the status line says the starting point is being built",
    await waitFor(
      `document.querySelector('[data-testid="build-status"]')?.textContent.includes('building the starting point')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-graph-node="start"]')?.click()`);
  check(
    "the start opens before the base has any screenshots",
    await waitFor(`!!document.querySelector('[data-graph-panel="start"] [data-testid="build-capture"]')`),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-graph-panel="start"] [data-panel-row="technical-details"]')?.click()`,
  );
  check(
    "the start names the cross-provider builder",
    await waitFor(`document.querySelector('[data-graph-panel="start"]')?.textContent.includes('Claude Code · sonnet')`),
  );
  await append(CustomEvent.AutopilotBase, { ok: false, error: "Camera views were identical" });
  await append(CustomEvent.DirectorWorker, { workerId: "river", title: "River and bridge", state: "running" });
  check(
    "a running single-session worker says it is working",
    await waitFor(`document.querySelector('[data-graph-node="session:river"]')?.textContent.includes('Working')`),
  );
  await append(CustomEvent.FacetBuildStarted, { facetId: "river", facetTitle: "River and bridge", iteration: 1 });
  await append(CustomEvent.FacetBuildStarted, { facetId: "cottages", facetTitle: "Timber cottages", iteration: 1 });
  const captureDir = path.join(core.layout.runs, runId, "facet_river/self/iter_001");
  await fs.mkdir(captureDir, { recursive: true });
  await fs.writeFile(
    path.join(captureDir, "c1_default.jpg"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId } });
  check(
    "parallel nodes and base failure appear before any verdict",
    await waitFor(
      `(()=>{const t=document.querySelector('[data-testid="build-status"]')?.textContent??'';return t.includes('2 parts working')&&t.includes('the starting point failed')&&document.querySelector('[data-graph-node="start"]')?.textContent.includes('Start failed')&&document.querySelector('[data-graph-panel="start"]')?.textContent.includes('Camera views were identical');})()`,
    ),
  );
  check(
    "active node displays its saved capture through IPC",
    await waitFor(`!!document.querySelector('[data-graph-node="step:river:1"] img')`),
  );
  return captureDir;
}

/** A plugin's asset job hangs under the part that asked for it. */
async function checkPluginJobInGraph(buildSmoke: BuildSmoke, assetJobId: string): Promise<void> {
  const { check, project, threadId, runId, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  // The two records the host writes for every plugin tool call, built by the very functions
  // that write them in production and carrying this run's attribution: the graph has to draw
  // the job under the part that asked for it rather than floating it loose in the run.
  const assetCall = startedPayload({
    callId: randomUUID(),
    pluginId: "genex",
    pluginName: "Genex Tools",
    tool: "asset",
    toolName: "genex__asset",
    args: { operation: "image", prompt: "A painted banner over the bridge" },
    project: project.name,
    threadId,
    runId,
    facetId: "river",
    iteration: 1,
    engine: EngineId.Codex,
    role: "builder",
  });
  await core.append(
    [{ type: EventKind.Custom, event_type: CustomEvent.PluginToolStarted, payload: assetCall }],
    threadId,
  );
  await core.append(
    [
      {
        type: EventKind.Custom,
        event_type: CustomEvent.PluginTool,
        payload: finishedPayload(assetCall, { result: { id: assetJobId, generationId: "gen-smoke" } }, 0, 120),
      },
    ],
    threadId,
  );
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId } });
  check(
    "a plugin's asset job appears in the graph under the part that asked for it",
    await waitFor(
      `(() => { const node = document.querySelector('[data-graph-node="assets"]'); if (!node || !node.textContent.includes('Making 1')) return false; node.click(); const panel = document.querySelector('[data-graph-panel="assets"]')?.textContent || ""; return panel.includes('Genex Tools') && panel.includes('Part 1') && panel.includes('Making'); })()`,
    ),
  );
  pushUiEvent({
    type: UiEvent.HarnessStatus,
    payload: {
      threadId,
      status: `run ${runId}`,
      all: { [threadId]: { status: `run ${runId}`, since: Date.now() } },
    },
  });
  check(
    "running build shows only Stop in an empty composer",
    await waitFor(
      `!document.querySelector('[data-promptbar] button[aria-label="Send"]') && !!document.querySelector('[data-promptbar] button[aria-label="Stop"]') && document.querySelector('textarea[aria-label="Prompt"]')?.placeholder.includes(${JSON.stringify(QUEUE_PLACEHOLDER)})`,
    ),
  );
}

/** The composer during a build: Stop, then Send for a follow-up that starts no new run. */
async function checkComposerDuringBuild(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, threadId, waitFor } = buildSmoke;
  const { core } = buildSmoke.ctx;
  check(
    "a running build's Mode is disabled and dimmed like the composer's disabled icons",
    await waitFor(
      `(() => { const mode = document.querySelector('[data-promptbar] button[aria-label="Mode"]'); return mode?.disabled === true && getComputedStyle(mode).opacity === '0.45'; })()`,
    ),
  );
  await wc.executeJavaScript(
    `(() => { const input = document.querySelector('textarea[aria-label="Prompt"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Is the river ready?'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  check(
    "follow-up Send replaces Stop during a build",
    await waitFor(
      `document.querySelector('[data-promptbar] button[aria-label="Send"]')?.disabled === false && !document.querySelector('[data-promptbar] button[aria-label="Stop"]')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Send"]').click()`);
  check(
    "coordinator answers while the existing build graph remains visible",
    await waitFor(
      `document.body.innerText.includes('No new build was started.') && !!document.querySelector('[data-graph-node="step:river:1"] img') && document.querySelector('[data-testid="build-status"]')?.textContent.includes('2 parts working')`,
    ),
  );
  const chatEvents = await core.store.listEvents(threadId);
  check(
    "chat follow-up did not commission another run",
    chatEvents.filter((e) => e.data.type === EventKind.Custom && e.data.event_type === CustomEvent.RunStarted)
      .length === 1 &&
      !chatEvents.some((e) => e.data.type === EventKind.Custom && e.data.event_type === CustomEvent.RunRegistered),
  );
}

/** The model menu, Escape and Wrap up over a running build. */
async function checkInterruptControls(buildSmoke: BuildSmoke): Promise<Interrupts> {
  const { wc, check, checkAsync, threadId, runId, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  const ctx = buildSmoke.ctx;
  // Both chat controls interrupt their own thread immediately. The run is a fixture,
  // so observe the real cancellation route without starting background builders.
  const stopDispatches: string[] = [];
  const realDispatch = core.host.dispatch.bind(core.host);
  core.host.dispatch = async (action, timeoutMs) => {
    if (action.type === DispatchActionType.Cancel) stopDispatches.push(String(action.threadId));
    return realDispatch(action, timeoutMs);
  };
  const sheetOpen = `!!document.querySelector('[data-testid="confirm-stop"]')`;
  await checkAsync("the model menu opens over a running build", async () => {
    await wc.executeJavaScript(`document.querySelector('[aria-label="Model settings"]')?.click()`);
    return waitFor(`!!document.querySelector('[data-slot="popover-content"][aria-label="Model options"]')`);
  });
  await checkAsync("Escape closes the menu and leaves the run running", async () => {
    await wc.executeJavaScript(
      `document.querySelector('[data-slot="popover-content"][aria-label="Model options"] button')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    if (
      !(await waitFor(
        `document.querySelector('[aria-label="Model settings"]')?.getAttribute('aria-expanded')==='false'`,
      ))
    )
      return false;
    await wc.capturePage();
    return (
      (await waitFor(`!document.querySelector('[data-slot="popover-content"][aria-label="Model options"]')`)) &&
      stopDispatches.length === 0
    );
  });
  // The coordinator's finish tool remains separate from interruption.
  await checkAsync("Wrap up asks the run to finish instead of stopping it", async () => {
    await wc.executeJavaScript(`window.studio.finishRun(${JSON.stringify(runId)}, ${JSON.stringify(threadId)})`);
    const log = await core.store.listEvents(threadId);
    return (
      log.some(
        (e) =>
          e.data.type === EventKind.Custom &&
          e.data.event_type === CustomEvent.RunControl &&
          (e.data.payload as { action?: string }).action === RunControlAction.Finish,
      ) && stopDispatches.length === 0
    );
  });
  await checkAsync("the chat says the build is finishing", () =>
    waitFor(`document.querySelector('[data-build-status]')?.textContent.includes('Finishing up')`),
  );
  pushUiEvent({
    type: UiEvent.HarnessStatus,
    payload: {
      threadId,
      status: `run ${runId}`,
      all: { [threadId]: { status: `run ${runId}`, since: Date.now() } },
    },
  });
  await checkAsync("composer Stop remains available without duplicate status or sidebar controls", () =>
    waitFor(
      `!!document.querySelector('[data-promptbar] button[aria-label="Stop"]') && !document.querySelector('[role="status"] button[aria-label="Stop"]') && !document.querySelector('.sidebar-footer')`,
    ),
  );
  check(
    "a building game's dot sits where its ⋯ appears",
    await waitFor(
      `(() => { const row = document.querySelector('nav [data-game="${buildSmoke.project.name}"]'); const dot = row?.querySelector('.sidebar-game-status')?.getBoundingClientRect(), menu = row?.querySelector('.sidebar-game-menu')?.getBoundingClientRect(); return !!dot && !!menu && dot.width > 0 && Math.abs((dot.left + dot.width / 2) - (menu.left + menu.width / 2)) < 1 && Math.abs((dot.top + dot.height / 2) - (menu.top + menu.height / 2)) < 1 && !row.querySelector('.sidebar-pin'); })()`,
    ),
  );
  pushUiEvent({ type: UiEvent.RunKeepawake, payload: { runId } });
  check("a running build holds the Mac awake", ctx.keepAwakeHeld());
  return { sheetOpen, stopDispatches, realDispatch };
}

/** Stop interrupts its own thread; keep-awake holds until the run settles. */
async function checkStopAndKeepAwake(
  buildSmoke: BuildSmoke,
  { sheetOpen, stopDispatches, realDispatch }: Interrupts,
): Promise<void> {
  const { wc, check, checkAsync, threadId, runId, waitFor } = buildSmoke;
  const { core, window, pushUiEvent } = buildSmoke.ctx;
  const ctx = buildSmoke.ctx;
  // Wait for the actual dispatch, including the composer's short post-send guard.
  const pressStop = async (selector: string) => {
    const before = stopDispatches.length,
      until = Date.now() + 8_000;
    do {
      await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
      for (let poll = 0; poll < 6; poll++) {
        if (stopDispatches.length > before)
          return stopDispatches.length === before + 1 && stopDispatches.at(-1) === threadId;
        await sleep(100);
      }
    } while (Date.now() < until);
    return false;
  };
  for (const [name, selector] of [["the composer", '[data-promptbar] button[aria-label="Stop"]']] as const) {
    pushUiEvent({
      type: UiEvent.HarnessStatus,
      payload: {
        threadId,
        status: `run ${runId}`,
        all: { [threadId]: { status: `run ${runId}`, since: Date.now() } },
      },
    });
    await checkAsync(
      `Stop in ${name} immediately interrupts its own chat`,
      async () => (await pressStop(selector)) && (await waitFor(`!${sheetOpen}`)),
      () => stopDispatches.join(","),
    );
  }
  check("the Mac is still held awake while the stopped build settles", ctx.keepAwakeHeld());
  pushUiEvent({ type: UiEvent.RunSettled, payload: { runId } });
  check("the blocker is released when the run settles", !ctx.keepAwakeHeld());
  core.host.dispatch = realDispatch;
  // Hand the thread back the way the harness would: idle, so the rest of the smoke sees a
  // finished chat rather than one this section left permanently busy.
  pushUiEvent({
    type: UiEvent.HarnessStatus,
    payload: { threadId, status: "idle", all: { [threadId]: { status: "idle", since: Date.now() } } },
  });

  const buildShot = flagValue(StudioFlag.BuildShot);
  if (buildShot) {
    if (window.isMinimized()) window.restore();
    window.showInactive();
    await sleep(500);
    await fs.writeFile(buildShot, (await wc.capturePage()).toPNG());
  }
}

/** A finished run: progress gone, the judge named in activity, the last look, Mode back on the chat's own Loop. */
async function checkFinishedRun(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, runId, append, waitFor } = buildSmoke;
  const { pushUiEvent } = buildSmoke.ctx;
  await append(CustomEvent.RunFinished, { victory: false, stoppedBecause: "test complete" });
  pushUiEvent({ type: UiEvent.RunFinished, payload: { runId } });
  check(
    "finished run leaves active progress",
    await waitFor(`document.querySelector('[data-testid="build-status"]')?.textContent.includes('No new build')`),
  );
  // Model attribution remains inspectable in activity details; routine trace is collapsed.
  await wc.executeJavaScript(`document.querySelector('[data-chat-scroll]')?.focus()`);
  wc.sendInputEvent({ type: "keyDown", keyCode: "Home" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Home" });
  await waitFor(`document.querySelector('[data-chat-scroll]').scrollTop<80`);
  await wc.executeJavaScript(
    `document.querySelectorAll('[data-work-log] > button[aria-expanded="false"]').forEach(button=>button.click())`,
  );
  check(
    "expanded activity names the model that judges",
    await waitFor(`document.body.innerText.includes('reviewing without being told which build is which')`),
  );
  await wc.executeJavaScript(`document.querySelector('[data-chat-scroll]')?.focus()`);
  wc.sendInputEvent({ type: "keyDown", keyCode: "End" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "End" });
  await append(CustomEvent.DirectorVerdict, {
    pass: "close",
    at: new Date().toISOString(),
    build: { head: null, worker: null, round: null },
    because: "the river build ran and the judge preferred it to the one you had",
  });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId } });
  await wc.executeJavaScript(`document.querySelector('[data-graph-node="final"]')?.click()`);
  check(
    "the build's panel shows the last look at the build, not the run's progress line",
    await waitFor(
      `document.querySelector('[data-graph-panel="final"]')?.textContent.includes('the reviewer preferred it to the one you had')`,
    ),
  );
  await waitFor(`document.querySelector('button[aria-label="Mode"]')?.disabled === false`);
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Mode"]')?.click()`);
  check(
    "a finished chat's Mode opens on its own Loop, with no new-build choice",
    await waitFor(
      `!!document.querySelector('[aria-label="Mode options"] [aria-label="Loop time limit"]') && !/new build/i.test(document.querySelector('[aria-label="Mode options"]')?.textContent ?? 'new build') && getComputedStyle(document.querySelector('button[aria-label="Mode"]')).opacity === '1'`,
    ),
  );
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
}

/** The morning card, and the earlier build opened from its chat card. */
async function checkMorningCardAndHistory(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project, runId, append, waitFor } = buildSmoke;
  const { pushUiEvent } = buildSmoke.ctx;
  // The morning card is the run's whole report to the user; its copy is unit-tested in
  // morning-words.ts, but only a real window proves the card mounts at all.
  check(
    "the run's morning card is in the chat",
    await waitFor(`!!document.querySelector('[data-testid="morning-card"]')`),
  );
  await append(CustomEvent.RunStarted, {
    runId: "empty-replacement",
    project: project.name,
    goal: "An accidental empty run",
  });
  await append(CustomEvent.RunFinished, { runId: "empty-replacement", stoppedBecause: "test complete" });
  pushUiEvent({ type: UiEvent.RunFinished, payload: { runId: "empty-replacement" } });
  // An earlier build opens from its result card in the chat (the card sends this same event).
  check(
    "a finished build's chat card offers Open in Builds",
    await waitFor(`!!document.querySelector('button[data-open-build="empty-replacement"]')`),
  );
  await wc.executeJavaScript(openBuildScript(runId));
  check(
    "opening the earlier build restores its facet graph",
    await waitFor(
      `document.body.innerText.includes('River and bridge') && document.querySelector('[data-stage-view]')?.dataset.selectedRun === ${JSON.stringify(runId)} && Array.from(document.querySelectorAll('[data-testid="build-status"] button')).some(b => b.textContent === 'Show latest')`,
    ),
  );
}

/** Real Git worktrees and native navigation: Play and Live loads overlap without errors. */
async function checkConcurrentPlay(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project } = buildSmoke;
  const { core } = buildSmoke.ctx;
  // Real Git worktrees and native navigation: overlapping requests must not abort each other.
  core.snapshots.register({ name: project.name, dir: project.dir });
  const playSnapshot = await core.snapshots.snapshot({
    scope: SnapshotScope.Game,
    gameWorkspace: project.name,
    reason: "preview concurrency fixture",
  });
  const playHead = playSnapshot.git.game;
  check("preview fixture has a real revision", typeof playHead === "string" && playHead.length === 40);
  const playResults = await wc.executeJavaScript(
    `Promise.all([window.studio.showBuild(${JSON.stringify(project.name)},${JSON.stringify(playHead)}),window.studio.showBuild(${JSON.stringify(project.name)},${JSON.stringify(playHead)}),window.studio.loadPreview(${JSON.stringify(project.name)})]).then(()=>true).catch(e=>String(e))`,
  );
  check(
    "concurrent Play and Live loads complete without worktree or navigation errors",
    playResults === true,
    String(playResults),
  );
  const replayResult = await wc.executeJavaScript(
    `window.studio.showBuild(${JSON.stringify(project.name)},${JSON.stringify(playHead)}).then(()=>true).catch(e=>String(e))`,
  );
  check("repeated Play reopens the existing scratch location safely", replayResult === true, String(replayResult));
}

/** Parallel rounds stay in view; moving the canvas offers Jump to now. */
async function checkFollowRounds(buildSmoke: BuildSmoke): Promise<FollowRun> {
  const { wc, check, project, append, waitFor } = buildSmoke;
  const { pushUiEvent } = buildSmoke.ctx;
  // Follow uses saved run events, not provider calls. Exercise parallel rounds in the real UI.
  const followRun = "run_follow_smoke";
  const followEvent = (type: string, payload: Record<string, unknown>) =>
    append(type, { ...payload, runId: followRun, project: project.name });
  await followEvent(CustomEvent.RunStarted, {
    goal: "Follow active rounds",
    mode: "director",
    budgets: { wallClockMs: FOLLOW_RUN_WALL_CLOCK_MS },
  });
  await followEvent(CustomEvent.AutopilotStarted, { director: true, maxParallel: 2, facets: [] });
  for (const id of ["water", "fish"]) {
    await followEvent(CustomEvent.DirectorWorker, { workerId: id, title: id, state: "running", mode: "loop" });
    await followEvent(CustomEvent.FacetBuildStarted, { facetId: id, facetTitle: id, iteration: 1 });
  }
  await followEvent(CustomEvent.FacetBuildStarted, { facetId: "water", facetTitle: "water", iteration: 2 });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  await waitFor(`(()=>{${openBuildScript(followRun)};return ${selectedRunIs(followRun)};})()`);
  // A live run keeps its work in view until the user moves the canvas; then "Jump to now" brings it back.
  const inView = (id: string) =>
    `(()=>{const n=document.querySelector('[data-graph-node="${id}"]')?.getBoundingClientRect(),v=document.querySelector('[data-zoom]')?.getBoundingClientRect();return !!n&&!!v&&n.width>0&&n.left>=v.left&&n.right<=v.right&&n.top>=v.top&&n.bottom<=v.bottom;})()`;
  check(
    "live work is in view without opening anything",
    await waitFor(
      `${inView("step:water:2")}&&!document.querySelector('[data-graph-panel]')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Jump to now')`,
    ),
  );
  await followEvent(CustomEvent.FacetBuildStarted, { facetId: "fish", facetTitle: "fish", iteration: 2 });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  check(
    "a parallel part's new work stays in view too",
    await waitFor(`${inView("step:fish:2")}&&${inView("step:water:2")}`),
  );
  // The zoom pill names the canvas's zoom; opening a node keeps it.
  const zoomLabel = `document.querySelector('[aria-label^="Zoom "][aria-label$="%"]')?.getAttribute('aria-label')`;
  const zoomBefore = await wc.executeJavaScript(zoomLabel);
  await wc.executeJavaScript(`document.querySelector('[data-graph-node="step:water:1"]')?.click()`);
  check(
    "selecting a node opens its card in place without zooming the canvas",
    await waitFor(
      `!!document.querySelector('[data-graph-panel="step:water:1"]')&&${inView("step:water:1")}&&${zoomLabel}===${JSON.stringify(zoomBefore)}`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-zoom]')?.dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true,cancelable:true}))`,
  );
  check(
    "moving the canvas closes the card where it is and offers Jump to now",
    await waitFor(
      `!document.querySelector('[data-graph-panel]')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Jump to now')`,
    ),
  );
  await followEvent(CustomEvent.FacetBuildStarted, { facetId: "water", facetTitle: "water", iteration: 3 });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Jump to now')?.click()`,
  );
  check(
    "Jump to now brings the newest work back into view",
    await waitFor(
      `${inView("step:water:3")}&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Jump to now')`,
    ),
  );
  return { followRun, followEvent };
}

/** The build's time against its budget, and the lead's node while every part waits for it. */
async function checkRunTimeAndLead(buildSmoke: BuildSmoke, { followRun, followEvent }: FollowRun): Promise<void> {
  const { check, waitFor } = buildSmoke;
  const { pushUiEvent } = buildSmoke.ctx;
  await followShot(buildSmoke, "follow-working");
  check(
    "the build's time is told against the time it was given on the stage, and as its cap in the chat",
    await waitFor(
      `document.querySelector('[data-testid="build-status"]')?.textContent.includes(' of 30 min')&&!!document.querySelector('[data-build-progress]')&&!!document.querySelector('[data-build-status]')?.textContent.includes('up to 30m')&&!document.querySelector('[data-build-activity],[data-worker-state]')`,
    ),
  );
  // Every part judged and done, nothing merged yet: the lead has the run, and the graph says so.
  const rounds = [
    ["water", 1],
    ["water", 2],
    ["water", 3],
    ["fish", 1],
    ["fish", 2],
  ] as const;
  for (const [id, n] of rounds) {
    await followEvent(CustomEvent.FacetIteration, {
      facetId: id,
      facetTitle: id,
      iteration: n,
      winner: "challenger",
      satisfied: false,
      verdictSource: "checks",
      reason: "checks accepted",
      shots: [],
      flags: [],
      diffs: {},
    });
  }
  for (const id of ["water", "fish"]) {
    await followEvent(CustomEvent.DirectorWorker, { workerId: id, title: id, state: "done", mode: "loop" });
  }
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  check(
    "between parts the lead's node keeps the run from looking finished",
    await waitFor(
      `!!document.querySelector('[data-graph-node="lead"]')&&document.querySelector('[data-testid="build-status"]')?.textContent.includes('the lead is working on the next step')&&!document.body.innerText.includes('an earlier build is ready to play')`,
    ),
  );
  await followShot(buildSmoke, "follow-lead");
}

/**
 * The empty scaffold takes the run's first healthy build by itself; after that Live never
 * changes while it is watched: a later build, a checkpoint and a changed folder light Reload, and
 * Reload (or leaving Live) brings them in.
 */
async function checkLiveRevisions(buildSmoke: BuildSmoke, { followRun, followEvent }: FollowRun): Promise<void> {
  const { wc, check, waitFor, project } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  // Real tiny Three.js revisions exercise the stage's rules against native loads.
  const liveMain = path.join(project.dir, "src/main.js");
  const emptyMain = await fs.readFile(liveMain, "utf8");
  const playableMain = emptyMain
    .replace(
      "const scene = new THREE.Scene();",
      "const scene = new THREE.Scene(); const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0x44cc88})); cube.position.z=-3; scene.add(cube);",
    )
    .replace('phase: "empty"', 'phase: "playing"');
  await fs.writeFile(liveMain, playableMain);
  const firstPlayable = (
    await core.snapshots.snapshot({
      scope: SnapshotScope.Game,
      gameWorkspace: project.name,
      reason: "incremental first playable",
    })
  ).git.game;
  await followEvent(CustomEvent.IntegrationMerge, {
    facetId: "water",
    head: firstPlayable,
    commit: firstPlayable,
    conflict: false,
  });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  check(
    "a build just merged is being checked, not ready to play, until it has run",
    await waitFor(
      `document.querySelector('[data-graph-node="final"]')?.textContent.includes('Checking it starts')&&!document.querySelector('[data-graph-node="lead"]')&&document.querySelector('[data-testid="build-status"]')?.textContent.includes('checking the new build starts')`,
    ),
  );
  await followShot(buildSmoke, "follow-checking");
  await followEvent(CustomEvent.IntegrationHealth, { head: firstPlayable, ok: true, problems: [] });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="live"]').click()`);
  check(
    "first healthy integrated revision automatically becomes playable",
    await waitFor(
      `!!document.querySelector('[data-stage-view]')?.dataset.shownBuild&&!document.querySelector('[data-stage-empty="building"]')`,
      15000,
    ),
  );
  await fs.writeFile(liveMain, playableMain.replace("0x44cc88", "0x4488cc"));
  const nextPlayable = (
    await core.snapshots.snapshot({
      scope: SnapshotScope.Game,
      gameWorkspace: project.name,
      reason: "incremental next playable",
    })
  ).git.game;
  await followEvent(CustomEvent.IntegrationMerge, {
    facetId: "water",
    head: nextPlayable,
    commit: nextPlayable,
    conflict: false,
  });
  await followEvent(CustomEvent.IntegrationHealth, { head: nextPlayable, ok: true, problems: [] });
  pushUiEvent({ type: UiEvent.AutopilotFacet, payload: { runId: followRun } });
  await checkLiveStaysStill(buildSmoke, { firstPlayable, nextPlayable, liveMain });
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="builds"]').click()`);
  await followEvent(CustomEvent.RunFinished, { stoppedBecause: "UI acceptance complete" });
}

/** Live's loads the page has seen since `countLiveLoads` (main says `preview.identity` loading for each). */
const LIVE_LOADS = "window.__smokeLiveLoads";
/** Of those, the ones that have finished (`preview.identity` in any state but loading). */
const LIVE_SETTLED = "window.__smokeLiveSettled";

/** Start counting Live's loads, and their ends, in the page. */
async function countLiveLoads(wc: WebContents): Promise<void> {
  const identity = JSON.stringify(UiEvent.PreviewIdentity);
  await wc.executeJavaScript(
    `${LIVE_LOADS}=0;${LIVE_SETTLED}=0;window.studio.onEvent(e=>{if(e.type!==${identity}||!e.payload)return;if(e.payload.state==="loading")${LIVE_LOADS}++;else ${LIVE_SETTLED}++;});true`,
  );
}

/** Reload's state on the stage strip, as the person sees it: its reason and its accessible name. */
const reloadState = (reason: string | null, label?: string): string =>
  reason
    ? `(()=>{const b=document.querySelector('[data-stage-reload="behind"]');return !!b&&b.dataset.behindReason===${JSON.stringify(reason)}${label ? `&&b.getAttribute('aria-label')===${JSON.stringify(label)}` : ""};})()`
    : `!!document.querySelector('[data-stage-reload=""]')`;

/**
 * A game on screen in Live never updates on its own when code changes: only Reload is
 * highlighted, with a changed tooltip. A later healthy build and a
 * builder's checkpoint light Reload while Live is on screen and load nothing; Reload plays the
 * build; leaving Live for Builds brings the changed game folder in.
 */
async function checkLiveStaysStill(
  buildSmoke: BuildSmoke,
  {
    firstPlayable,
    nextPlayable,
    liveMain,
  }: { firstPlayable: string | undefined; nextPlayable: string | undefined; liveMain: string },
): Promise<void> {
  const { wc, check, project, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  const shown = (head: string | undefined) =>
    `document.querySelector('[data-stage-view]')?.dataset.shownBuild===${JSON.stringify(head ?? "")}`;
  await countLiveLoads(wc);
  check(
    "a later healthy build lights Reload instead of replacing Live",
    await waitFor(reloadState("build", "A new build is ready — reload to play it")),
  );
  await wc.executeJavaScript(`document.querySelector('[data-stage-reload]')?.focus();true`);
  await followShot(buildSmoke, "reload-behind");
  await wc.executeJavaScript(`document.activeElement?.blur();true`);
  await sleep(LIVE_STILL_MS);
  check(
    "while Live is watched the new build does not load by itself",
    Boolean(await wc.executeJavaScript(`${shown(firstPlayable)}&&${LIVE_LOADS}===0`)),
    String(
      await wc.executeJavaScript(
        `document.querySelector('[data-stage-view]')?.dataset.shownBuild+" loads="+${LIVE_LOADS}`,
      ),
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-stage-reload]').click()`);
  check(
    "Reload plays the waiting build and goes quiet",
    await waitFor(`${shown(nextPlayable)}&&${reloadState(null)}`, 20000),
  );
  // A builder's checkpoint after the game folder changed: the note rides on Reload, Live stays.
  await fs.writeFile(liveMain, (await fs.readFile(liveMain, "utf8")).replace("0x4488cc", "0xcc8844"));
  await core.snapshots.snapshot({
    scope: SnapshotScope.Game,
    gameWorkspace: project.name,
    reason: "a builder's checkpoint",
  });
  await countLiveLoads(wc);
  pushUiEvent({
    type: UiEvent.DelegationCheckpoint,
    payload: { project: project.name, cwd: core.games.dirFor(project.name), note: "the cube turned orange" },
  });
  check(
    "a checkpoint lights Reload with the builder's note and loads nothing",
    (await waitFor(reloadState("changed", "The game changed — reload to see it: the cube turned orange"))) &&
      Boolean(await wc.executeJavaScript(`${LIVE_LOADS}===0`)),
  );
  // Out of sight, what waits goes in, so Live is current when the person comes back. Live then
  // shows the game folder, so Reload may offer the run's newest build again, never the change.
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="builds"]').click()`);
  const changedGone = `!document.querySelector('[data-behind-reason="changed"]')`;
  check(
    "leaving Live for Builds brings the changed game in",
    // Settled too: the next checks read a Builds panel that a late Live update would redraw.
    await waitFor(`${changedGone}&&${LIVE_LOADS}>0&&${LIVE_SETTLED}>=${LIVE_LOADS}`, 20000),
    String(
      await wc.executeJavaScript(
        `JSON.stringify({loads:${LIVE_LOADS},settled:${LIVE_SETTLED},reload:document.querySelector('[data-stage-reload]')?.getAttribute('aria-label')})`,
      ),
    ),
  );
}

/** An outcome run of six tasks, a failed check and incomplete interaction evidence. */
async function seedOutcomeRun(buildSmoke: BuildSmoke): Promise<OutcomeRun> {
  const { project, append } = buildSmoke;
  // Outcome reporting acceptance: synthetic metadata only, no agent/provider request.
  const outcomeRun = "run_outcome_smoke";
  const outcomeEvent = (type: string, payload: Record<string, unknown>) =>
    append(type, { ...payload, runId: outcomeRun, project: project.name });
  await outcomeEvent(CustomEvent.RunStarted, { goal: "Outcome reporting fixture", mode: "director" });
  await outcomeEvent(CustomEvent.AutopilotBase, { ok: true, commit: "base", empty: true });
  for (let i = 1; i <= 6; i++) {
    await outcomeEvent(CustomEvent.DirectorWorker, {
      workerId: `task-${i}`,
      title: `Delivered task ${i}`,
      state: "done",
      mode: i > 4 ? "single" : "loop",
      ...(i === 6 ? { replaces: "task-5" } : {}),
    });
    if (i <= 4)
      await outcomeEvent(CustomEvent.FacetIteration, {
        facetId: `task-${i}`,
        iteration: 1,
        winner: i === 4 ? "incumbent" : "challenger",
        verdictSource: "judge",
      });
    await outcomeEvent(CustomEvent.IntegrationMerge, {
      facetId: `task-${i}`,
      head: `head-${i}`,
      commit: `source-${i}`,
      conflict: false,
    });
  }
  await outcomeEvent(CustomEvent.FacetIteration, {
    facetId: "task-1",
    iteration: 2,
    winner: null,
    verdictSource: "stopped",
    reason: "Director stopped the follow-up after integration",
  });
  await outcomeEvent(CustomEvent.DirectorVerdict, {
    pass: "judge",
    build: { head: "head-6" },
    measured: {
      planned: [
        { id: "movement", pass: true },
        { id: "world", pass: true },
        { id: "hud", pass: true },
        { id: "detail", pass: true },
      ],
    },
    seen: { question: "Is the requested first-person view confirmed?", answer: false },
  });
  await outcomeEvent(CustomEvent.RunInteractionEvidence, {
    head: "head-6",
    label: "Dialogue walkthrough",
    status: "incomplete",
    source: InteractionSource.IndependentPlaytester,
  });
  return { outcomeRun, outcomeEvent };
}

/** The outcome run's judged capture, its landing and its learning. */
async function finishOutcomeRun(
  buildSmoke: BuildSmoke,
  { outcomeRun, outcomeEvent }: OutcomeRun,
  captureDir: string,
): Promise<void> {
  const { check, waitFor } = buildSmoke;
  const { core, pushUiEvent } = buildSmoke.ctx;
  const outcomeJudgeDir = path.join(core.layout.runs, outcomeRun, "director", "judge_1");
  await fs.mkdir(outcomeJudgeDir, { recursive: true });
  const outcomeCapture = path.join(outcomeJudgeDir, "fixture.png");
  await fs.copyFile(path.join(captureDir, "c1_default.jpg"), outcomeCapture);
  await fs.writeFile(
    path.join(outcomeJudgeDir, "verdict.json"),
    JSON.stringify({
      head: "head-6",
      answer: {
        question: "Is the requested first-person view confirmed?",
        yes: false,
        note: "Fixture observation on head-6",
        camera: "default",
      },
      shots: [{ camera: "default", path: outcomeCapture }],
    }),
  );
  await outcomeEvent(CustomEvent.RunFinished, { landed: true, integrationHead: "head-6", baseCommit: "base" });
  await outcomeEvent(CustomEvent.RunLearning, { state: "running" });
  pushUiEvent({ type: UiEvent.RunFinished, payload: { runId: outcomeRun } });
  check(
    "the new outcome run opens in Builds",
    await waitFor(`(()=>{${openBuildScript(outcomeRun)};return ${selectedRunIs(outcomeRun)};})()`),
  );
}

/** The delivery's panel: its hidden details, counts, failed check and follow-up. */
async function checkOutcomePanel(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  await waitFor(`!!document.querySelector('[data-graph-node="final"]')`);
  await wc.executeJavaScript(`document.querySelector('[data-graph-node="final"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-graph-panel="final"]')`);
  await wc.executeJavaScript(
    `document.querySelector('[data-graph-panel="final"] [data-panel-row="technical-details"]')?.click()`,
  );
  check(
    "chat outcome hides technical details by default",
    await waitFor(
      `!!document.querySelector('[data-chat-outcome]')&&!document.querySelector('[data-chat-outcome-details]')`,
    ),
  );
  // Counts belong to Builds, not to the chat's card (it names the delivery and its capture).
  check(
    "the build's technical details carry the recorded integration and evaluated-attempt counts",
    await waitFor(
      `(()=>{const t=document.querySelector('[data-graph-panel="final"] [data-testid="build-details"]')?.textContent??'';return t.includes('6 recorded integrations')&&t.includes('4 evaluated attempts (3 accepted, 1 rejected)')&&!document.querySelector('[data-chat-outcome]')?.textContent.includes('recorded integrations');})()`,
    ),
    String(
      await wc.executeJavaScript(
        `(document.querySelector('[data-graph-panel="final"]')?.textContent??'no final panel').slice(0,500)`,
      ),
    ),
  );
  check(
    "delivery keeps its failed check in the status line",
    await waitFor(
      `(()=>{const t=document.querySelector('[data-testid="build-status"]')?.textContent??'';return t.includes('Live in your game')&&t.includes('1 check failed');})()`,
    ),
  );
  // The recorded checks sit under the technical details opened above.
  check(
    "delivery retains failed visual and incomplete interaction evidence",
    await waitFor(
      `(()=>{const t=document.querySelector('[data-graph-panel="final"]')?.textContent??'';return t.includes('A visual question failed.')&&t.includes('Independent interaction coverage is incomplete');})()`,
    ),
  );
  check(
    "the lead's stopped follow-up hangs below the line it followed",
    await waitFor(
      `(()=>{const a=document.querySelector('[data-graph-node="step:task-1:1"]')?.getBoundingClientRect(),b=document.querySelector('[data-graph-node="step:task-1:2"]')?.getBoundingClientRect();return !!a&&!!b&&b.top>a.bottom&&!!document.querySelector('[data-graph-row="task-1"]');})()`,
    ),
  );
}

/** A replaced worker stays one part; parts open from the keyboard. */
async function checkPartRows(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  // A part built in one session is its one node (no label over it); one built in steps has its label.
  await wc.executeJavaScript(
    `(document.querySelector('[data-graph-row="task-5"]')??document.querySelector('[data-graph-node="session:task-5"]'))?.click()`,
  );
  await waitFor(`!!document.querySelector('[data-graph-panel="part:task-5"],[data-graph-panel="session:task-5"]')`);
  await wc.executeJavaScript(
    `document.querySelector(':is([data-graph-panel="part:task-5"],[data-graph-panel="session:task-5"]) [data-panel-row="technical-details"]')?.click()`,
  );
  check(
    "a replaced single worker stays one part with its replacement named",
    await waitFor(
      `document.querySelector('[data-graph-panel="part:task-5"],[data-graph-panel="session:task-5"]')?.textContent.includes('task-5 → task-6')&&!document.querySelector('[data-graph-row="task-6"],[data-graph-node="session:task-6"]')`,
    ),
  );
  wc.focus();
  await wc.executeJavaScript(`document.querySelector('[data-graph-row="task-1"]')?.focus()`);
  check(
    "a part's label accepts keyboard focus",
    await waitFor(`document.activeElement===document.querySelector('[data-graph-row="task-1"]')`),
  );
  wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  wc.sendInputEvent({ type: "char", keyCode: "\r" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  check(
    "a part opens from the keyboard",
    await waitFor(`!!document.querySelector('[data-graph-panel="part:task-1"]')`),
  );
  check(
    "graph controls have the pointer cursor",
    await waitFor(
      `[...document.querySelectorAll('[data-testid="build-status"] button,[data-graph-node],[data-graph-row],[data-graph-gate]')].every(b=>getComputedStyle(b).cursor==='pointer')&&document.querySelectorAll('[data-graph-gate]').length>0`,
    ),
  );
}

/** Checks name the failed question, and its capture loads through the host. */
async function checkChecksAndCapture(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  await wc.executeJavaScript(`document.querySelector('[data-graph-node="final"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-graph-panel="final"]')`);
  await wc.executeJavaScript(
    `document.querySelectorAll('[data-graph-panel="final"] [data-panel-row][aria-expanded="false"]').forEach(b=>b.click())`,
  );
  check(
    "checks show the failed question on its own revision",
    await waitFor(
      `document.body.innerText.includes('Is the requested first-person view confirmed?')&&document.body.innerText.includes('head-6')&&document.body.innerText.includes('failed · visual')`,
    ),
  );
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='View capture').at(-1)?.click()`,
  );
  check(
    "check capture loads through the protected host reader",
    await waitFor(
      `Array.from(document.querySelectorAll('img[alt="Recorded check capture"]')).some(i=>i.complete&&i.naturalWidth===1)&&document.body.innerText.includes('Fixture observation on head-6')`,
    ),
  );
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Close capture').forEach(b=>b.click())`,
  );
  check(
    "learning remains separate from delivered build",
    await waitFor(
      `document.querySelector('[data-graph-panel="final"]')?.textContent.includes('Studio learning: running — separate from game execution.')&&document.querySelector('[data-testid="build-status"]')?.textContent.includes('Live in your game')`,
    ),
  );
}

/** Activity reports the build; the Plugins page lists Genex's MCP server. */
async function checkActivityAndMcp(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, threadId, waitFor } = buildSmoke;
  // Activity gives a run its result only; counts and checks stay in the game's Builds tab.
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="studio"]')?.click()`);
  check(
    "Activity reports the delivered build the chat reported",
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="review-panel"] [data-activity-kind="run"]')).some(r=>r.textContent.includes('Outcome reporting fixture')&&r.textContent.includes('New build'))&&!document.querySelector('[data-testid="review-panel"] [data-testid="run-outcome"]')`,
    ),
  );
  // The Plugins page lists the servers a person added; a fixture profile adds none. Genex's own
  // servers live on its page, and a search still finds them there, saying whose they are.
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Plugins"]').click()`);
  check(
    "MCP servers lists only the servers you added, with no hidden-row switch",
    await waitFor(
      `(()=>{const c=document.querySelector('[data-testid="mcp-connectors"]');if(!c)return false;const t=c.textContent||'';return t.includes('Connect any MCP server')&&!t.includes('Show disabled')&&!c.querySelector('[data-plugin-server]')&&!c.querySelector('[role="alert"]');})()`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[aria-label="Search plugins and MCP servers"]').focus()`);
  wc.insertText("creator");
  check(
    "a search finds a plugin's own server and names the plugin it is part of",
    await waitFor(
      `document.querySelector('[data-testid="mcp-connectors"] [data-plugin-server="creator"]')?.textContent.includes('Part of Game dev tools router')`,
    ),
  );
  await wc.executeJavaScript(`document.querySelector('[data-plugins-page] [aria-label="Clear search"]').click()`);
  await wc.executeJavaScript(`document.querySelector('nav [data-thread="${threadId}"]')?.click()`);
  check(
    "returning from Studio preserves the selected run",
    await waitFor(`${selectedRunIs("run_outcome_smoke")}&&!!document.querySelector('[data-graph-row="task-1"]')`),
  );
}

/** `--studio-build-shot`: the Build room as the build smoke leaves it. */
async function captureBuildShot(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { window } = buildSmoke.ctx;
  const buildShot = flagValue(StudioFlag.BuildShot);
  if (buildShot) {
    const shotPath = buildShot;
    await fs.writeFile(shotPath, (await wc.capturePage()).toPNG());
    await wc.executeJavaScript(`document.querySelector('[data-graph-panel] button[title="Close (Esc)"]')?.click()`);
    await waitFor(`!document.querySelector('[data-graph-panel]')`);
    await wc.executeJavaScript(`document.querySelector('button[title="Fit everything (0)"]')?.click()`);
    await fs.writeFile(shotPath.replace(/\.png$/, "-overview.png"), (await wc.capturePage()).toPNG());
    window.setSize(1000, 720);
    check(
      "small window keeps the status line within its panel",
      await waitFor(
        `(()=>{const e=document.querySelector('[data-testid="build-status"]');if(!e)return false;const r=e.getBoundingClientRect();return r.right<=innerWidth&&r.left>=0&&r.width>200;})()`,
      ),
    );
    await fs.writeFile(shotPath.replace(/\.png$/, "-small.png"), (await wc.capturePage()).toPNG());
  }
}

/** Shared design acceptance on this real fixture, at four sizes and zooms. */
async function checkSharedDesign(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, threadId } = buildSmoke;
  // Shared design acceptance runs on this real fixture, not just the specimen gallery.
  await wc.executeJavaScript(
    `document.querySelector('nav [data-thread="${threadId}"]')?.click(); document.querySelector('[data-stage-action="live"]')?.click()`,
  );
  for (const [width, height, zoom] of [
    [1440, 900, 1],
    [1080, 680, 1],
    [1800, 900, 1],
    [1440, 900, 2],
  ]) {
    await checkDesignAt(buildSmoke, width, height, zoom);
    await checkReviewAt(buildSmoke, width, height, zoom);
  }
}

/** The Build room at one size and zoom. */
async function checkDesignAt(buildSmoke: BuildSmoke, width: number, height: number, zoom: number): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { window } = buildSmoke.ctx;
  const buildShot = flagValue(StudioFlag.BuildShot);
  window.setSize(width, height);
  wc.setZoomFactor(zoom);
  await wc.capturePage();
  check(
    `viewport applied ${width}×${height} at ${zoom * 100}%`,
    await waitFor(`Math.abs(innerWidth-${width / zoom})<=2 && Math.abs(innerHeight-${height / zoom})<=2`),
  );
  check(
    `sidebar layout settles ${width}/${zoom}`,
    await waitFor(
      `document.querySelector('[data-studio-state]')?.dataset.compact === String(innerWidth <= 900) && !document.querySelector('.studio-shell').getAnimations().some(a=>a.playState==='running') && !document.querySelector('.studio-sidebar').getAnimations().some(a=>a.playState==='running')`,
    ),
  );
  const layout = await wc.executeJavaScript(
    `(()=>{const p=document.querySelector('[aria-label="Prompt"]');const s=document.querySelector('[data-promptbar] button[aria-label="Send"]');if(!p||!s)return null;const r=p.getBoundingClientRect(),b=s.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,prompt:r.width,sendRight:b.right,sendBottom:b.bottom,font:getComputedStyle(p).fontFamily};})()`,
  );
  check(
    `Genex layout ${width}×${height} at ${zoom * 100}%`,
    Boolean(
      layout &&
        layout.scroll <= layout.width &&
        layout.prompt > 80 &&
        layout.sendRight <= layout.width &&
        layout.sendBottom <= layout.height,
    ),
    JSON.stringify(layout),
  );
  if (buildShot)
    await fs.writeFile(buildShot.replace(/\.png$/, `-design-${width}-${zoom}.png`), (await wc.capturePage()).toPNG());
}

/** Review at one size and zoom, and the sidebar drawer at 200 percent. */
async function checkReviewAt(buildSmoke: BuildSmoke, width: number, height: number, zoom: number): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { previewBoundsSeen } = buildSmoke.ctx;
  const buildShot = flagValue(StudioFlag.BuildShot);
  await waitFor(`!document.querySelector('[role="dialog"], [role="menu"], [data-slot="popover-content"]')`);
  await wc.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true}))`);
  await waitFor(`!!document.querySelector('[data-testid="review-panel"]')`);
  await wc.capturePage();
  check(
    `Studio keeps chat visible and hides the native preview at ${width}/${zoom}`,
    (await waitFor(
      `document.querySelector('[data-room="studio"]') && document.querySelector('[data-chat-header]')?.getBoundingClientRect().width > 200 && getComputedStyle(document.querySelector('[data-chat-header]')).visibility === 'visible'`,
    )) && (previewBoundsSeen.last as { width: number } | null)?.width === 0,
  );
  const reviewLayout = await wc.executeJavaScript(
    `(()=>{const p=document.querySelector('[data-testid="review-panel"]');const f=document.querySelector('[data-studio-learned], [data-activity-empty]');if(!p||!f)return null;const r=f.getBoundingClientRect();return {width:innerWidth,height:innerHeight,panelWidth:p.clientWidth,panelScroll:p.scrollWidth,sectionWidth:r.width,sectionLeft:r.left,sectionRight:r.right,scroll:document.documentElement.scrollWidth};})()`,
  );
  check(
    `Review layout ${width}×${height} at ${zoom * 100}%`,
    Boolean(
      reviewLayout &&
        reviewLayout.scroll <= reviewLayout.width &&
        reviewLayout.panelScroll <= reviewLayout.panelWidth + 1 &&
        reviewLayout.sectionWidth > 200 &&
        reviewLayout.sectionLeft >= 0 &&
        reviewLayout.sectionRight <= reviewLayout.width,
    ),
    JSON.stringify(reviewLayout),
  );
  if (buildShot)
    await fs.writeFile(buildShot.replace(/\.png$/, `-review-${width}-${zoom}.png`), (await wc.capturePage()).toPNG());
  if (zoom === 2) {
    await wc.executeJavaScript(`document.querySelector('[aria-label="Show sidebar"]')?.click()`);
    check(
      "compact sidebar opens as a keyboard-accessible drawer",
      await waitFor(
        `document.querySelector('[data-studio-state]')?.dataset.sidebarOpen === 'true' && document.querySelector('main').inert && document.activeElement?.getAttribute('aria-label')==='Hide sidebar' && !document.querySelector('.studio-sidebar').getAnimations().some(a=>a.playState==='running') && document.querySelector('.studio-sidebar').getBoundingClientRect().left===0`,
      ),
    );
    if (buildShot)
      await fs.writeFile(buildShot.replace(/\.png$/, "-sidebar-drawer.png"), (await wc.capturePage()).toPNG());
    await wc.executeJavaScript(`document.querySelector('[aria-label="Hide sidebar"]')?.click()`);
    check(
      "compact sidebar closes and restores toggle focus",
      await waitFor(
        `document.querySelector('[data-studio-state]')?.dataset.sidebarOpen === 'false' && !document.querySelector('main').inert && document.activeElement?.getAttribute('aria-label')==='Show sidebar'`,
      ),
    );
  }
  await wc.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',metaKey:true}))`);
  await waitFor(`!!document.querySelector('[aria-label="Prompt"]')`);
}

/** Back at 1440×900: Export and Plugins where they belong, and pointer cursors. */
async function checkChromeAndCursors(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { window } = buildSmoke.ctx;
  wc.setZoomFactor(1);
  window.setSize(1440, 900);
  await wc.capturePage();
  await waitFor(`innerWidth===1440 && innerHeight===900`);
  check(
    "Export sits in the game chat header menu and Plugins belongs to the sidebar",
    await wc.executeJavaScript(
      `!!document.querySelector('[data-chat-header] [aria-label="Chat actions"]') && !!document.querySelector('nav [aria-label="Plugins"]') && !document.querySelector('[data-stage-strip] [aria-label="Export game"], [data-stage-strip] [aria-label="Plugins"]')`,
    ),
  );
  check(
    "Genex wordmark is accessible and navigation uses pointer cursors",
    await wc.executeJavaScript(
      `!!document.querySelector('svg[role="img"][aria-label="Genex"]') && Array.from(document.querySelectorAll('nav button:not(:disabled), nav button:not(:disabled) svg')).every(e=>getComputedStyle(e).cursor==='pointer')`,
    ),
  );
}

/** The game image dialog normalizes, previews, saves and refuses executable formats. */
async function checkGameImage(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project, waitFor } = buildSmoke;
  const { core } = buildSmoke.ctx;
  // Exercise local image normalization and the typed persistence boundary. The native
  // picker itself remains a foreground manual gate; this uses an owned synthetic file.
  await wc.executeJavaScript(`document.querySelector('nav [data-game="${project.name}"] .sidebar-game-menu')?.focus()`);
  wc.sendInputEvent({ type: "keyDown", keyCode: "Down" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Down" });
  await waitFor(`!!document.querySelector('[data-game-action="cover"]')`);
  await wc.executeJavaScript(`document.querySelector('[data-game-action="cover"]')?.click()`);
  check(
    "game image dialog opens with the existing cover",
    await waitFor(
      `!!document.querySelector('[aria-label="Choose game image"]') && document.querySelector('.game-cover-preview img')?.naturalWidth > 0`,
    ),
  );
  await wc.executeJavaScript(
    `(async()=>{const c=document.createElement('canvas');c.width=32;c.height=16;const ctx=c.getContext('2d');ctx.fillStyle='#839fb5';ctx.fillRect(0,0,32,16);const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));const data=new DataTransfer();data.items.add(new File([blob],'fixture-cover.png',{type:'image/png'}));const input=document.querySelector('[aria-label="Choose game image"]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  check(
    "game image is normalized and previewed before save",
    await waitFor(
      `document.querySelector('.game-cover-preview img')?.naturalWidth===256 && Array.from(document.querySelectorAll('[role="dialog"] button')).some(b=>b.textContent==='Save image'&&!b.disabled)`,
    ),
  );
  await wc.executeJavaScript(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>b.textContent==='Save image')?.click()`,
  );
  check(
    "game image save persists through IPC and closes the dialog",
    (await waitFor(
      `!document.querySelector('[aria-label="Choose game image"]') && document.querySelector('nav [data-game="${project.name}"] img')?.naturalWidth===256`,
    )) && (await core.games.presentation(project.name)).cover?.kind === "image",
    await wc.executeJavaScript(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? ''`),
  );
  check(
    "game image IPC refuses executable image formats",
    await wc.executeJavaScript(
      `window.studio.updateGame(${JSON.stringify(project.name)},{cover:{kind:'image',dataUrl:'data:image/svg+xml,<svg/>'}}).then(()=>false,()=>true)`,
    ),
  );
}

/** A rendered game for the overlay checks, with Live selected and visible. */
async function checkOverlayFixture(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, project, waitFor } = buildSmoke;
  const { preview, previewBoundsSeen } = buildSmoke.ctx;
  // Earlier checks intentionally use an empty scaffold, whose DOM empty state
  // hides native bounds. Give overlay acceptance a genuinely rendered game.
  await fs.writeFile(path.join(project.dir, "src", "main.js"), COMPUTER_SMOKE_GAME);
  await wc.executeJavaScript(`window.studio.loadPreview(${JSON.stringify(project.name)})`);
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="live"]')?.click()`);
  check(
    "overlay fixture has loaded its scene",
    await waitFor(`window.studio.previewState().then(s=>s.phase==='playing')`),
    JSON.stringify(await preview.studioState()),
  );
  await preview.studioCall("step", 16.67);
  const overlayCapture = await preview.screenshotWithStats();
  check(
    "overlay fixture has a nonblank captured scene",
    overlayCapture.stats.litFraction > 0.1 && (overlayCapture.stats.contrast ?? 0) > 1,
    JSON.stringify({
      source: overlayCapture.stats.source,
      litFraction: overlayCapture.stats.litFraction,
      contrast: overlayCapture.stats.contrast,
    }),
  );
  check(
    "overlay checks select Live first",
    await waitFor(`document.querySelector('[data-stage-action="live"]')?.getAttribute('aria-selected')==='true'`),
  );
  await wc.capturePage();
  await sleep(SETTLE_MS);
  check(
    "overlay checks start with a visible native game",
    (previewBoundsSeen.last?.width ?? 0) > 0,
    JSON.stringify({
      bounds: previewBoundsSeen.last,
      dom: await wc.executeJavaScript(
        `({empty:document.body.innerText.includes('Your project starts here'),dialogs:[...document.querySelectorAll('[data-slot="dialog-content"]')].map(e=>e.getAttribute('aria-label')),slot:document.querySelector('[data-preview-slot]')?.getBoundingClientRect().toJSON()})`,
      ),
    }),
  );
}

/** The model picker opens above the native game and closes cleanly. */
async function checkModelPickerOverlay(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { previewBoundsSeen } = buildSmoke.ctx;
  await wc.executeJavaScript(`document.querySelector('[aria-label="Model settings"]')?.click()`);
  check(
    "Genex model picker opens above native preview",
    await waitFor(`!!document.querySelector('[data-slot="popover-content"][aria-label="Model options"]')`),
  );
  await sleep(SETTLE_MS);
  check(
    "chat model picker keeps native game visible",
    (previewBoundsSeen.last?.width ?? 0) > 0,
    JSON.stringify(previewBoundsSeen.last),
  );
  await wc.executeJavaScript(`document.querySelector('[data-model-view="roles"] [data-role="planner"]')?.click()`);
  check(
    "Genex model list focuses a named model without search",
    await waitFor(
      `document.activeElement?.matches('[data-model-choice]') && !document.querySelector('[aria-label="Search models"]')`,
    ),
  );
  await wc.executeJavaScript(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`,
  );
  check(
    "Genex model Escape returns to root",
    await waitFor(
      `!!document.querySelector('[data-model-view="roles"]')&&!document.querySelector('[data-model-list]')`,
    ),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-slot="popover-content"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`,
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-slot="popover-content"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`,
  );
  check(
    "Genex model Escape closes picker",
    await waitFor(`document.querySelector('[aria-label="Model settings"]')?.getAttribute('aria-expanded')==='false'`),
  );
  await wc.capturePage();
  check(
    "Genex model exit animation unmounts its portal",
    await waitFor(`!document.querySelector('[data-slot="popover-content"][aria-label="Model options"]')`),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-promptbar] button[aria-label="Context and usage"]')?.click()`,
  );
  check(
    "context panel opens alongside Live",
    await waitFor(`!!document.querySelector('[data-slot="popover-content"][aria-label="Context and usage"]')`),
  );
  await wc.capturePage();
  await sleep(SETTLE_MS);
  check(
    "context panel leaves native game visible",
    (previewBoundsSeen.last?.width ?? 0) > 0,
    JSON.stringify(previewBoundsSeen.last),
  );
}

/** The context panel beside Live, overlapping it, and moved off it. */
async function checkContextPanelOverlay(buildSmoke: BuildSmoke): Promise<void> {
  const { wc, check, waitFor } = buildSmoke;
  const { previewBoundsSeen } = buildSmoke.ctx;
  // Exercise the native layering boundary with the actual mounted panel. Moving
  // its positioner simulates collision placement/pane resizing, not a fake view.
  await wc.executeJavaScript(
    `(()=>{const p=document.querySelector('[data-slot="popover-content"][aria-label="Context and usage"]').parentElement;const r=document.querySelector('[data-preview-slot]').getBoundingClientRect();p.dataset.originalStyle=p.getAttribute('style')??'';p.style.setProperty('position','fixed','important');p.style.setProperty('inset','auto','important');p.style.setProperty('left',(r.left+20)+'px','important');p.style.setProperty('top',(r.top+20)+'px','important');p.style.setProperty('transform','none','important');})()`,
  );
  await wc.capturePage();
  await sleep(SETTLE_MS);
  check(
    "overlapping panel still yields native game bounds",
    (previewBoundsSeen.last as { width: number } | null)?.width === 0,
    JSON.stringify(previewBoundsSeen.last),
  );
  await wc.executeJavaScript(
    `(()=>{const p=document.querySelector('[data-slot="popover-content"][aria-label="Context and usage"]').parentElement;p.setAttribute('style',p.dataset.originalStyle);})()`,
  );
  await wc.capturePage();
  await sleep(SETTLE_MS);
  check(
    "moving panel off Live restores game without closing it",
    (previewBoundsSeen.last?.width ?? 0) > 0,
    JSON.stringify(previewBoundsSeen.last),
  );
  await wc.executeJavaScript(
    `document.querySelector('[data-slot="popover-content"][aria-label="Context and usage"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`,
  );
  check(
    "Escape closes context panel",
    await waitFor(`!document.querySelector('[data-slot="popover-content"][aria-label="Context and usage"]')`),
  );
}

/** The computer smoke (`--studio-computer-smoke`): the computer tool, WebGPU workers and a scripted director. */
async function runComputerSmoke(smoke: Smoke): Promise<void> {
  const { check } = smoke;
  const privateShows: number[] = [];
  const watchPrivateWindow = (_event: Electron.Event, win: BrowserWindow) => {
    win.on("show", () => privateShows.push(win.id));
    win.on("focus", () => privateShows.push(win.id));
    win.on("restore", () => privateShows.push(win.id));
    win.on("enter-full-screen", () => privateShows.push(win.id));
  };
  app.on("browser-window-created", watchPrivateWindow);
  const computerSmoke = await openComputerSmoke(smoke);
  const results = await runComputerSession(computerSmoke);
  checkComputerTool(computerSmoke, results);
  checkAgentScreen(computerSmoke, results);
  await checkSetupReplay(computerSmoke, results);
  checkWebGpuWorker(computerSmoke, await runWebGpuSession(computerSmoke));
  await checkScriptedDirector(computerSmoke);
  app.removeListener("browser-window-created", watchPrivateWindow);
  check(
    "private capture and worker windows never show or take focus",
    privateShows.length === 0,
    JSON.stringify(privateShows),
  );
}

/** The computer smoke's fixture game, open in the window, and the host calls it drives. */
interface ComputerSmoke extends Smoke {
  project: { name: string; dir: string };
  runId: string;
  waitFor(expression: string, ms?: number): Promise<boolean>;
  callHost: HostCall;
}

/** What a scripted session saw, by name, for the checks to read afterwards. */
type Seen = Record<string, unknown>;

/** What the scripted director saw, read loosely: its tool results are JSON of several shapes. */
type DirectorSeen = Record<string, any>;

/**
 * The computer tool over a real hidden window: a fixture game with a map picker
 * on I, a click that chooses the map, W that moves the player — driven end to end
 * through engine.delegate with a scripted contractor, exactly as a run's builder is.
 */
async function openComputerSmoke(smoke: Smoke): Promise<ComputerSmoke> {
  const { wc } = smoke;
  const { core } = smoke.ctx;
  const project = await core.games.scaffold("computer-smoke", { title: "Computer smoke" });
  await fs.writeFile(path.join(project.dir, "src", "main.js"), COMPUTER_SMOKE_GAME);
  const runId = "run_computer_smoke";
  // The builder's screen shows on its part's node in Builds: open this game on a run whose part
  // "build" is at work, with the stage on Builds.
  const smokeThread = await core.threadForGame(project.name);
  const part = { runId, project: project.name, facetId: "build", facetTitle: "Smoke builder", iteration: 1 };
  await core.append(
    [
      { type: EventKind.Custom, event_type: CustomEvent.RunStarted, payload: { runId, project: project.name } },
      { type: EventKind.Custom, event_type: CustomEvent.FacetBuildStarted, payload: part },
    ],
    smokeThread,
  );
  await wc.executeJavaScript(`localStorage.setItem("studio.activeThread", ${JSON.stringify(smokeThread)})`);
  await wc.executeJavaScript(`localStorage.setItem("studio.previewView", "builds")`);
  wc.reload();
  await waitUntil(() => wc.executeJavaScript(`!!document.querySelector('nav [data-thread]')`).catch(() => false), {
    timeoutMs: BUILD_WAIT_MS,
    intervalMs: WINDOW_POLL_MS,
  });
  const waitFor = (expression: string, ms = COMPUTER_WAIT_MS) =>
    waitUntil(() => wc.executeJavaScript(expression).catch(() => false), { timeoutMs: ms, intervalMs: WINDOW_POLL_MS });
  return { ...smoke, project, runId, waitFor, callHost: hostCaller(core) };
}

/** The game state a `computer state` call printed, parsed; the raw text when it would not parse. */
function stateOf(result: unknown): Record<string, unknown> {
  const text = typeof result === "string" ? result : String((result as { text?: string })?.text ?? "");
  const start = text.indexOf("{");
  const noteAt = text.indexOf("\nnote:");
  const body = text.slice(start, noteAt > start ? noteAt : undefined).trim();
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf("}") + 1));
  } catch {
    return { __unparsed: text.slice(0, 200) };
  }
}

/** The text of a tool result. */
function asText(r: unknown): string {
  return typeof r === "string" ? r : String((r as { text?: string })?.text ?? "");
}

/** How many images a tool result carries. */
function images(r: unknown): number {
  return ((r as { images?: unknown[] })?.images ?? []).length;
}

/** A scripted Codex stand-in whose delegate is `delegate`; never a paid model. */
function scriptedCodex(
  delegate: Engine["delegate"],
  options: { models?: Awaited<ReturnType<Engine["models"]>>; content?: string } = {},
): Engine {
  return {
    id: EngineId.Codex,
    label: "Codex",
    kind: EngineKind.Delegated,
    status: async () => ({ code: EngineStatusCode.Ready, detail: "smoke fixture" }),
    models: async () => options.models ?? [],
    complete: async () => ({
      engine: EngineId.Codex,
      model: "gpt-5.6-sol",
      stopReason: "stop",
      message: { role: "assistant", content: options.content ?? "" },
      usage: {},
    }),
    delegate,
  };
}

/** The builder's first session: every computer action once, then a second session that replays a setup. */
async function runComputerSession(computerSmoke: ComputerSmoke): Promise<Seen> {
  const { project, runId, callHost } = computerSmoke;
  const { core } = computerSmoke.ctx;
  const results: Seen = {};
  core.engines.register(
    scriptedCodex(
      async (request) => {
        const computer = (args: Record<string, unknown>) =>
          required(request.onLiveTool, "a live tool bridge")("computer", args);
        const iteration = request.selfCapture?.iteration ?? 0;
        if (iteration === 1) await driveComputer(computerSmoke, request, results);
        else {
          // The requested state, replayed by the studio before the agent's first action.
          results.setupState = stateOf(await computer({ action: "state" }));
          results.setupShot = await computer({ action: "screenshot" });
        }
        return {
          ok: true,
          engine: EngineId.Codex,
          turns: 1,
          usage: {},
          sessionId: `smoke-${iteration}`,
          summary: "done",
        };
      },
      {
        models: [
          {
            id: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            contextWindow: 200000,
            maxTokens: 8192,
            supportsTools: true,
            supportsVision: true,
            supportsThinking: true,
          },
        ],
        content: "Smoke fixture",
      },
    ),
  );
  await callHost(HostMethod.PreviewLoad, { project: project.name });
  await sleep(1000);
  results.liveGpu = await callHost(HostMethod.PreviewEvaluate, {
    expression: `(async () => { const secure = isSecureContext; if (!navigator.gpu) return { secure, gpu: false }; const adapter = await navigator.gpu.requestAdapter().catch(() => null); return { secure, gpu: true, adapter: !!adapter, device: adapter ? !!(await adapter.requestDevice().catch(() => null)) : false }; })()`,
  }).catch((err: Error) => ({ error: err.message }));
  await callHost(HostMethod.EngineDelegate, {
    engine: EngineId.Codex,
    prompt: "smoke",
    project: project.name,
    selfCapture: {
      project: project.name,
      root: project.dir,
      runId,
      facetId: "build",
      iteration: 1,
      label: "Smoke builder",
    },
  });
  return results;
}

/** Every computer action once, in the order a player's session would use them. */
async function driveComputer(computerSmoke: ComputerSmoke, request: DelegateRequest, results: Seen): Promise<void> {
  const { waitFor, callHost } = computerSmoke;
  const { core } = computerSmoke.ctx;
  const computer = (args: Record<string, unknown>) =>
    required(request.onLiveTool, "a live tool bridge")("computer", args);
  results.tools = (request.liveTools ?? []).map((t) => t.name);
  results.shot = await computer({ action: "screenshot" });
  results.uiNode = await waitFor(`!!document.querySelector('[data-graph-node][data-agent-screen] img')`);
  results.state0 = stateOf(await computer({ action: "state" }));
  results.key = await computer({ action: "key", text: "i" });
  results.state1 = stateOf(await computer({ action: "state" }));
  results.click = await computer({ action: "left_click", coordinate: "800,300" });
  results.state2 = stateOf(await computer({ action: "state" }));
  results.hold = await computer({ action: "hold_key", text: "w", duration: 0.6 });
  results.state3 = stateOf(await computer({ action: "state" }));
  results.type = await computer({ action: "type", text: "abc" });
  results.state4 = stateOf(await computer({ action: "state" }));
  results.zoom = await computer({ action: "zoom", region: "380,200,580,400" });
  results.camera = await computer({ action: "camera", text: "top" });
  results.screens = core.agentScreens();
  // WebGPU inside an offscreen worker window, versus the live view — games may be WebGPU.
  const gpuProbe = `(async () => { const secure = isSecureContext; if (!navigator.gpu) return { secure, gpu: false }; const adapter = await navigator.gpu.requestAdapter().catch(() => null); if (!adapter) return { secure, gpu: true, adapter: false }; const device = await adapter.requestDevice().catch(() => null); const canvas = document.createElement("canvas"); const ctx = canvas.getContext("webgpu"); return { secure, gpu: true, adapter: true, device: !!device, canvasContext: !!ctx, features: [...adapter.features].length }; })()`;
  const handle = results.screens && (results.screens as Array<{ handle: string }>)[0]?.handle;
  results.workerGpu = handle
    ? await callHost(HostMethod.PreviewEvaluate, { expression: gpuProbe, handle }).catch((err: Error) => ({
        error: err.message,
      }))
    : { error: "no handle" };
  results.capture = await required(request.onCapture, "a capture hook")({ cameras: "default,top" });
  results.cursor = await computer({ action: "cursor_position" });
  await captureComputerShot(computerSmoke);
}

/** `--studio-computer-shot=<png>`: the studio window with the working node's card open on its screen. */
async function captureComputerShot({ wc, ctx }: ComputerSmoke): Promise<void> {
  const shot = flagValue(StudioFlag.ComputerShot);
  if (!shot) return;
  const { window } = ctx;
  if (window.isMinimized()) window.restore();
  window.showInactive();
  await wc.executeJavaScript(`document.querySelector('[data-graph-node][data-agent-screen]')?.click()`).catch(() => {});
  await sleep(600);
  await fs.writeFile(shot, (await wc.capturePage()).toPNG());
  await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`).catch(() => {});
}

/** What the builder's computer session saw: the tool, both WebGPU probes, and each action's effect. */
function checkComputerTool({ check }: ComputerSmoke, results: Seen): void {
  check(
    "the builder holds the computer tool",
    Array.isArray(results.tools) && (results.tools as string[]).includes("computer"),
    JSON.stringify(results.tools),
  );
  check("WebGPU in the live view (informational)", true, JSON.stringify(results.liveGpu));
  check("WebGPU in an offscreen worker window (informational)", true, JSON.stringify(results.workerGpu));
  check(
    "game pages retain a secure origin in Live and worker views",
    (results.liveGpu as { secure?: boolean })?.secure === true &&
      (results.workerGpu as { secure?: boolean })?.secure === true,
  );
  check(
    "screenshot returns the picture and saves it",
    images(results.shot) === 1 && /s1_screen\.jpg/.test(asText(results.shot)),
    asText(results.shot).slice(0, 160),
  );
  check("the agent's screen appears on its part's node in Builds while the session runs", results.uiNode === true);
  const s0 = results.state0 as Record<string, unknown>;
  check(
    "the fixture boots on the street map",
    (s0.maps as { activeId?: string })?.activeId === "street",
    JSON.stringify(s0).slice(0, 200),
  );
  const s1 = results.state1 as Record<string, unknown>;
  check(
    "key i opens the map picker (a real keydown reached the page)",
    s1.picker === true && s1.lastKey === "i",
    JSON.stringify({ picker: s1.picker, lastKey: s1.lastKey, typed: s1.typed }),
  );
  const s2 = results.state2 as Record<string, unknown>;
  const choseMacba = (s2.maps as { activeId?: string })?.activeId === "macba" && s2.clicks === 1;
  check(
    "a pixel click on the right half chooses the MACBA map",
    choseMacba && Array.isArray(s2.clickAt) && (s2.clickAt as number[])[0] === 800,
    JSON.stringify({
      map: (s2.maps as { activeId?: string })?.activeId,
      clicks: s2.clicks,
      clickAt: s2.clickAt,
      picker: s2.picker,
    }),
  );
  const s3 = results.state3 as Record<string, unknown>;
  check(
    "holding W moves the player (the game's own update loop saw the key)",
    Number((s3.player as { x?: number })?.x) > 0.3,
    JSON.stringify(s3.player),
  );
  const s4 = results.state4 as Record<string, unknown>;
  // "w" first: the held W above was a keystroke too, as it should be.
  check("type delivers each character exactly once", s4.typed === "wabc", JSON.stringify(s4.typed));
  check(
    "zoom returns a magnified crop",
    images(results.zoom) === 1 && /region 380,200,580,400/.test(asText(results.zoom)),
    asText(results.zoom).slice(0, 160),
  );
  check(
    "camera jumps to a registered studio camera",
    images(results.camera) === 1 && !/WARNING/.test(asText(results.camera)),
    asText(results.camera).slice(0, 160),
  );
}

/** The agent's screen in the strip, the cameras capture took, and the window gone with the session. */
function checkAgentScreen({ check, ctx }: ComputerSmoke, results: Seen): void {
  const screens = results.screens as Array<{
    label: string;
    role: string;
    cursor: { x: number; y: number };
    jpeg: string;
    caption: string | null;
  }>;
  const [screen] = screens;
  const carriesTheDeed =
    screens.length === 1 &&
    screen?.label === "Smoke builder" &&
    screen.role === "builder" &&
    screen.cursor.x === 800 &&
    screen.jpeg.length > 1000;
  check(
    "the agent screen carries the last frame, the cursor and the deed",
    carriesTheDeed,
    JSON.stringify(screens.map((s) => ({ label: s.label, cursor: s.cursor, caption: s.caption }))),
  );
  const captured = asText(results.capture);
  check(
    "capture still takes every named camera through the same window",
    /c1_default\.jpg/.test(captured) && /c1_top\.jpg/.test(captured) && /camera verified/.test(captured),
    asText(results.capture).slice(0, 300),
  );
  check(
    "cursor_position reports where the click left the mouse",
    asText(results.cursor) === "X=800, Y=300",
    asText(results.cursor),
  );
  check("the window closes with the session", ctx.core.agentScreens().length === 0);
}

/** A requested state (the picker opened, MACBA chosen) lands before the agent's first look. */
async function checkSetupReplay({ project, runId, callHost, check }: ComputerSmoke, results: Seen): Promise<void> {
  const setup = {
    actions: [
      { type: "press", combo: "i" },
      { type: "wait", ms: 100 },
      { type: "click", x: 800, y: 300, px: true },
    ],
    verify: { path: "maps.activeId", equals: "macba" },
    note: "I opens the picker, the right card is MACBA",
  };
  await callHost(HostMethod.EngineDelegate, {
    engine: EngineId.Codex,
    prompt: "smoke",
    project: project.name,
    selfCapture: {
      project: project.name,
      root: project.dir,
      runId,
      facetId: "build",
      iteration: 2,
      label: "Smoke builder",
      setup,
    },
  });
  const ss = results.setupState as Record<string, unknown>;
  check(
    "the requested-state setup lands before the agent's first look",
    (ss.maps as { activeId?: string })?.activeId === "macba" && !/NOT REACHED/.test(asText(results.setupShot)),
    JSON.stringify(ss).slice(0, 200),
  );
}

/** A WebGPU game in an offscreen worker window: it renders, it captures, it plays. */
async function runWebGpuSession({ callHost, ctx }: ComputerSmoke): Promise<Seen> {
  const { core } = ctx;
  const gpuProject = await core.games.scaffold("webgpu-smoke", { title: "WebGPU smoke" });
  await fs.writeFile(path.join(gpuProject.dir, "src", "main.js"), COMPUTER_SMOKE_WEBGPU_GAME);
  const gpu: Seen = {};
  core.engines.register(
    scriptedCodex(async (request) => {
      const computer = (args: Record<string, unknown>) =>
        required(request.onLiveTool, "a live tool bridge")("computer", args);
      gpu.shot = await computer({ action: "screenshot" });
      gpu.state0 = stateOf(await computer({ action: "state" }));
      gpu.hold = await computer({ action: "hold_key", text: "w", duration: 0.5 });
      gpu.state1 = stateOf(await computer({ action: "state" }));
      gpu.capture = await required(request.onCapture, "a capture hook")({ cameras: "default" });
      gpu.console = await computer({ action: "console" });
      const gpuHandle = core.agentScreens()[0]?.handle;
      gpu.firstStack = gpuHandle
        ? await callHost(HostMethod.PreviewEvaluate, {
            expression: "window.__firstStack || null",
            handle: gpuHandle,
          }).catch((err: Error) => err.message)
        : null;
      return { ok: true, engine: EngineId.Codex, turns: 1, usage: {}, sessionId: "gpu", summary: "done" };
    }),
  );
  await callHost(HostMethod.EngineDelegate, {
    engine: EngineId.Codex,
    prompt: "smoke",
    project: gpuProject.name,
    selfCapture: {
      project: gpuProject.name,
      root: gpuProject.dir,
      runId: "run_webgpu_smoke",
      facetId: "build",
      iteration: 1,
      label: "WebGPU builder",
    },
  });
  return gpu;
}

function checkWebGpuWorker({ check }: ComputerSmoke, gpu: Seen): void {
  const g0 = gpu.state0 as Record<string, unknown>;
  check(
    "a WebGPU game runs in the offscreen window (backend webgpu, frames advancing)",
    g0.backend === "webgpu" && Number(g0.frame) > 0 && !(g0 as { error?: unknown }).error,
    JSON.stringify(g0).slice(0, 220),
  );
  const lit = /litFraction ([0-9.]+)/.exec(asText(gpu.shot));
  check(
    "a WebGPU frame captures with light in it (not black)",
    images(gpu.shot) === 1 && !!lit && Number(lit[1]) > 0.3,
    asText(gpu.shot).slice(0, 200),
  );
  const g1 = gpu.state1 as Record<string, unknown>;
  check("holding W moves the WebGPU player", Number((g1.player as { x?: number })?.x) > 0.3, JSON.stringify(g1.player));
  check(
    "capture photographs the WebGPU camera and verifies it",
    /camera verified/.test(asText(gpu.capture)) && !/failed/.test(asText(gpu.capture)),
    asText(gpu.capture).slice(0, 220),
  );
  check(
    "no console errors in the WebGPU game",
    /none/.test(asText(gpu.console)),
    `${asText(gpu.console).slice(0, 200)} | first rejection: ${String(gpu.firstStack).slice(0, 700)}`,
  );
}

/**
 * The director: a run on this Electron — the real harness child, real offscreen
 * windows, the dispatch that answers — with a scripted director that looks, starts a
 * single worker, integrates, shows and finishes; its screen is the lead's node in Builds meanwhile.
 */
async function checkScriptedDirector(computerSmoke: ComputerSmoke): Promise<void> {
  const { wc, waitFor } = computerSmoke;
  const { core } = computerSmoke.ctx;
  const dirProject = await core.games.scaffold("director-smoke", { title: "Director smoke" });
  await fs.writeFile(path.join(dirProject.dir, "src", "main.js"), COMPUTER_SMOKE_GAME);
  const dirThread = await core.threadForGame(dirProject.name);
  await wc.executeJavaScript(`localStorage.setItem("studio.activeThread", ${JSON.stringify(dirThread)})`);
  wc.reload();
  await waitFor(`!!document.querySelector('nav [data-thread]')`, 15_000);
  const dir: DirectorSeen = {};
  core.engines.register(
    scriptedCodex(
      async (request) => {
        if (request.director) return directLoopRun(computerSmoke, request, dir);
        await fs.writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 1;\n");
        dir.workerShot = await required(request.onLiveTool, "a live tool bridge")("computer", { action: "screenshot" });
        return { ok: true, engine: EngineId.Codex, turns: 2, usage: {}, sessionId: "sign", summary: "sign added" };
      },
      { content: "{}" },
    ),
  );
  const dirRunId = core.newRunId();
  await core.dispatchRun({
    runId: dirRunId,
    goal: "a sign on the street",
    project: dirProject.name,
    mode: "autopilot",
    engine: EngineId.Codex,
    reference: { name: "sign", shots: [] },
    budgets: { wallClockMs: 10 * 60_000 },
  });
  const dirFinished = (await core.listAllEvents())
    .filter((e) => e.data.type === EventKind.Custom && e.data.event_type === CustomEvent.RunFinished)
    .map((e) => (e.data as { payload: Record<string, unknown> }).payload)
    .find((p) => p.runId === dirRunId);
  checkDirectorLoopRun(computerSmoke, dir);
  checkDirectorLanding(computerSmoke, dir, dirFinished, dirProject.dir);
}

/** The scripted director's run: look, plan, one worker, integrate, show, finish. */
async function directLoopRun(
  { wc, waitFor }: ComputerSmoke,
  request: DelegateRequest,
  dir: DirectorSeen,
): Promise<DelegateResult> {
  const call = (name: string, args: Record<string, unknown>) =>
    required(request.onLiveTool, "a live tool bridge")(name, args);
  dir.look = await call("look", { target: "integration" });
  dir.state = stateOf(await call("computer", { action: "state" }));
  dir.chatFrame = await waitFor(`!!document.querySelector('[data-build-status] img')?.naturalWidth`);
  // No part works yet, so the lead has the run: its node in Builds is its own screen.
  await wc.executeJavaScript(`document.querySelector('[data-stage-action="builds"]')?.click()`);
  dir.uiCard = await waitFor(`!!document.querySelector('[data-graph-node="lead"][data-agent-screen] img')`);
  // The run says what it is for before a builder starts (M3.8): worker_start refuses until plan has been called.
  await call("plan", {
    summary: "This run: a sign on the street.",
    workers: JSON.stringify([
      {
        id: "sign",
        title: "Sign",
        seam: "the street sign",
        owns: "src/sign.js",
        done: ["a sign stands on the street"],
        minutes: 3,
      },
    ]),
  });
  dir.started = JSON.parse(
    asText(
      await call("worker_start", {
        id: "sign",
        title: "Sign",
        brief: "add a sign to the street",
        mode: "single",
        minutes: "3",
      }),
    ),
  );
  for (let i = 0; i < 30; i++) {
    dir.waited = JSON.parse(asText(await call("wait", { seconds: "3", worker: "sign" })));
    if (dir.waited.status?.workers?.[0]?.state !== "running") break;
  }
  dir.lookWorker = await call("look", { target: "sign" });
  dir.integrated = JSON.parse(asText(await call("integrate", { worker: "sign" })));
  dir.shown = asText(await call("show", { target: "integration" }));
  dir.finished = asText(await call("finish", { summary: "a sign on the street", land: "yes" }));
  return { ok: true, engine: EngineId.Codex, turns: 9, usage: {}, sessionId: "director", summary: "run done" };
}

/** What the director saw and did during the run. */
function checkDirectorLoopRun({ check }: ComputerSmoke, dir: DirectorSeen): void {
  check(
    "the director's window shows the integration worktree with the game running in it",
    /the window now shows integration/.test(asText(dir.look)) &&
      (dir.state?.maps as { activeId?: string })?.activeId === "street",
    `${asText(dir.look).slice(0, 120)} | ${JSON.stringify(dir.state).slice(0, 160)}`,
  );
  check("the director's screen is the lead's node in Builds while it works", dir.uiCard === true);
  check("the director's current view is the build row's picture in chat", dir.chatFrame === true);
  check(
    "the worker built in a worktree of its own, with hands",
    dir.started?.mode === "single" &&
      images(dir.workerShot) === 1 &&
      dir.waited?.status?.workers?.[0]?.state === "done",
    JSON.stringify({ started: dir.started, worker: dir.waited?.status?.workers?.[0] }).slice(0, 300),
  );
  check(
    "look points the director's window at the worker's build",
    /the window now shows sign/.test(asText(dir.lookWorker)),
    asText(dir.lookWorker).slice(0, 120),
  );
  check(
    "integrate merged the worker and the health pass loaded the integrated build",
    dir.integrated?.merged === true && dir.integrated?.health?.ok === true,
    JSON.stringify(dir.integrated).slice(0, 300),
  );
  check(
    "show offered the integrated build on Live's Reload",
    /Live's Reload now offers integration/.test(dir.shown ?? ""),
    String(dir.shown),
  );
}

/** How the run ended: landed in the live folder, closed as the director's, every window gone. */
function checkDirectorLanding(
  { check, ctx }: ComputerSmoke,
  dir: DirectorSeen,
  dirFinished: Record<string, unknown> | undefined,
  dirProjectDir: string,
): void {
  check(
    "finish landed the integration branch in the live folder",
    dirFinished?.landed === true &&
      existsSync(path.join(dirProjectDir, "src", "sign.js")) &&
      /is live in the game folder/.test(dir.finished ?? ""),
    `${JSON.stringify({ landed: dirFinished?.landed, stoppedBecause: dirFinished?.stoppedBecause })} | ${String(dir.finished).slice(0, 160)}`,
  );
  check(
    "the run closed as the director's, mode director",
    dirFinished?.mode === "director" && dirFinished?.stoppedBecause === "the director finished the run",
    JSON.stringify(dirFinished ?? null)?.slice(0, 200),
  );
  check("every window closed with the run", ctx.core.agentScreens().length === 0);
}
