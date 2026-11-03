import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../../scripts/electron-runtime.mjs";
import { writeJson } from "../../../scripts/studio-dev/files.mjs";
import { allocateProfile, assertStopped, removeProfile } from "../../../scripts/studio-dev/ownership.mjs";
import { checkoutRoot, ensurePlaywrightBuild, PLAYWRIGHT_BUILD_ID, playwrightMainPath } from "./build.ts";

/** Named fixture ids this suite launches. Values match `FixtureName`. */
export const PlaywrightFixture = {
  AppBasics: "app-basics",
  FirstLaunch: "first-launch",
} as const;
export type PlaywrightFixture = (typeof PlaywrightFixture)[keyof typeof PlaywrightFixture];

/** Fields this suite reads from a `studio:dev` fixture owner. */
interface Owner {
  profileId: string;
  ownerId: string;
  root: string;
}

/** One Playwright-driven Electron session in a disposable fixture profile. */
export interface StudioSession {
  app: ElectronApplication;
  window: Page;
  owner: Owner;
  consoleErrors: string[];
  pageErrors: string[];
}

const READY_MS = 90_000;
const LAUNCH_MS = 120_000;

/** Console noise that is not a fatal renderer failure. */
const IGNORABLE_CONSOLE = [
  "Download the React DevTools",
  "Autofill.enable",
  "SharedArrayBuffer",
  "was preloaded using link preload",
];

function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function linuxChromiumFlags(): string[] {
  if (process.platform !== "linux") return [];
  return ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
}

function ignorable(message: string): boolean {
  return IGNORABLE_CONSOLE.some((part) => message.includes(part));
}

/** A new disposable fixture profile for `fixture`. */
export function allocateFixtureOwner(fixture: PlaywrightFixture, profileId?: string): Owner {
  const id = profileId ?? `pw-${randomUUID().slice(0, 8)}`;
  return allocateProfile(checkoutRoot(), id, "fixture", fixture);
}

/**
 * Allocate a disposable fixture profile, point it at the shared playwright-e2e build,
 * and launch Electron through Playwright `_electron`.
 */
export async function launchStudio(options: {
  fixture: PlaywrightFixture;
  profileId?: string;
  reuse?: Owner;
  env?: Record<string, string>;
}): Promise<StudioSession> {
  ensurePlaywrightBuild();
  const checkout = checkoutRoot();
  const owner = options.reuse ?? allocateFixtureOwner(options.fixture, options.profileId);
  writeJson(path.join(owner.root, "launch.json"), {
    version: 1,
    profileId: owner.profileId,
    ownerId: owner.ownerId,
    buildId: PLAYWRIGHT_BUILD_ID,
  });
  const env = stringEnv({
    ...fixtureElectronEnv(),
    STUDIO_FIXTURE_INTERACTIVE: "1",
    ...options.env,
  });
  const args = fixtureElectronArgs([
    ...linuxChromiumFlags(),
    playwrightMainPath(),
    `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
  ]);
  const app = await electron.launch({
    executablePath: resolveElectron(checkout),
    args,
    cwd: checkout,
    env,
    timeout: LAUNCH_MS,
    colorScheme: null,
  });
  let window: Page;
  try {
    window = await app.firstWindow({ timeout: READY_MS });
  } catch (error) {
    const log = path.join(owner.root, "core", "logs", "studio.log");
    const tail = fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-4_000) : "(no studio.log)";
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nstudio.log tail:\n${tail}`);
  }
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!ignorable(text)) consoleErrors.push(text);
  });
  window.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await window.waitForLoadState("domcontentloaded");
  return { app, window, owner, consoleErrors, pageErrors };
}

/** Quit Electron and drop a dead lease so the same profile can relaunch. */
export async function stopStudio(session: StudioSession): Promise<void> {
  try {
    await session.app.close();
  } finally {
    assertStopped(session.owner);
  }
}

/** Stop, then delete the disposable fixture profile. */
export async function disposeStudio(session: StudioSession): Promise<void> {
  await stopStudio(session);
  removeProfile(session.owner);
}

/** Wait until the shell has a sidebar game or the first-launch welcome. */
export async function waitForShell(page: Page): Promise<void> {
  const game = page.locator('[data-game="fixture-game"]');
  const welcome = page.locator('[data-onboarding-action="next"]');
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await game.or(welcome).or(settings).first().waitFor({ timeout: READY_MS });
}

/** Fatal renderer failures collected during the session. */
export function fatalRendererProblems(session: StudioSession): string[] {
  return [...session.pageErrors, ...session.consoleErrors];
}

/** Write a usage-file that makes the Pi fixture look signed out (no network). */
export function writePiSignedOutUsage(owner: Owner): string {
  const file = path.join(owner.root, "fixture-usage.json");
  fs.writeFileSync(file, JSON.stringify({ pi: "signed_out" }), { mode: 0o600 });
  return file;
}

/** Documented credential env vars; the suite never sends them on the wire. */
export function declaredPiCredentials(): { present: boolean; names: string[] } {
  const names = ["GENEX_E2E_PI_API_KEY", "GENEX_E2E_PI_HOME"].filter((name) => Boolean(process.env[name]));
  return { present: names.length > 0, names };
}
