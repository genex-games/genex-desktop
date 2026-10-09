import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "./electron-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  allocateProfile,
  validateProfile,
  devRoot,
  assertStopped,
  pidExists,
  slug,
  removeProfile,
} from "./studio-dev/ownership.mjs";
import { writeJson, readVersion, safeChild } from "./studio-dev/files.mjs";
import { request } from "./studio-dev/client.ts";
import { parseStudioDevArgs, parseOperation } from "./studio-dev/args.ts";
import { freshMachineEnv, freshMachineShell, linkKeychains } from "./studio-dev/fresh-machine.ts";
import { gamesRootWarnings, liveEnvStripped, liveLaunchEnv } from "./studio-dev/live-env.ts";
import { FIXTURE_NAMES } from "../src/main/dev/fixtures.ts";
import { setTimeout as delay } from "node:timers/promises";
export const checkout = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
function descriptor(owner: any) {
  const d = readVersion(safeChild(owner.root, "controller.json"));
  if (d.ownerId !== owner.ownerId || d.profileId !== owner.profileId) throw new Error("wrong descriptor owner");
  return d;
}
async function command(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => process.stderr.write(b));
    child.stderr.on("data", (b) => process.stderr.write(b));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
  });
}
/** How long a stopped app may take to exit, and how often it is checked. */
const STOP_TIMEOUT_MS = 30_000;
const STOP_POLL_MS = 100;
/** How long a launched app may take to report ready, and how often it is asked. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 200;

export async function stopProfile(id: string) {
  const owner = validateProfile(checkout, id);
  const d = descriptor(owner);
  const identity = await request(d, { method: "status", params: {} });
  if (identity.pid !== d.pid || identity.startedAt !== d.startedAt || identity.profileId !== id)
    throw new Error("wrong live process identity");
  const result = await request(d, { method: "stop", params: {} });
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (pidExists(d.pid) && Date.now() < deadline) await delay(STOP_POLL_MS);
  if (pidExists(d.pid)) throw new Error("shutdown timeout; ownership retained, no process signalled");
  assertStopped(owner);
  return { ...result, exited: true, instanceId: d.instanceId };
}

/** The named fixture a fixture-provider profile starts from (app-basics unless named); none otherwise. */
function fixtureFor(providers: string, named: string | undefined): string | null {
  if (providers !== "fixture") return null;
  const fixture = named ?? "app-basics";
  if (!(FIXTURE_NAMES as readonly string[]).includes(fixture))
    throw new Error(`unknown named fixture; one of ${FIXTURE_NAMES.join(", ")}`);
  return fixture;
}

/** Refuses a profile whose app is still running, naming the running identity when it answers. */
async function assertNotRunning(owner: any) {
  try {
    assertStopped(owner);
  } catch (e) {
    let identity;
    try {
      identity = await request(descriptor(owner), { method: "status", params: {} });
    } catch {}
    throw new Error(
      `${(e as Error).message}${identity ? `; already-running identity: ${JSON.stringify(identity)}` : ""}`,
    );
  }
}

/** Takes the profile's startup claim, clearing one a dead process left behind. */
function claimStartup(owner: any): string {
  const claim = safeChild(owner.root, "starting.json");
  if (fs.existsSync(claim)) {
    const previous = readVersion(claim);
    if (pidExists(previous.pid)) throw new Error("profile startup is already owned by a live process");
    fs.unlinkSync(claim);
  }
  fs.writeFileSync(claim, JSON.stringify({ version: 1, pid: process.pid }), { flag: "wx", mode: 0o600 });
  return claim;
}

/** What `shell` tells the terminal before and after the fresh-machine account's shell. */
const MESSAGE = {
  shellOpen: (profile: string, home: string) =>
    `Terminal of the new account in fresh-machine profile ${profile} (HOME=${home}). Install and sign in here; exit to leave.`,
} as const;

/** Whether a profile launches with the caller's own environment (less its agent session's variables). */
const launchesLive = (owner: { providers?: string; freshMachine?: boolean }): boolean =>
  owner.providers !== "fixture" && owner.freshMachine !== true;

/**
 * The environment a launch starts with: scrubbed for fixtures, the caller's without its agent
 * session's variables for a live profile (`studio-dev/live-env.ts`), a new account's for a fresh
 * machine.
 */
export function launchEnv(owner: any, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (owner.providers === "fixture") return fixtureElectronEnv(parent);
  if (launchesLive(owner)) return liveLaunchEnv(parent);
  // The temporary folder may have been emptied since; macOS finds the login keychain through HOME.
  fs.mkdirSync(owner.home, { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") linkKeychains(owner.home);
  return freshMachineEnv(parent, { home: owner.home, secureStorage: owner.secureStorage });
}

/** What a live profile's start and status add: the variables the launch dropped, and the warnings. */
function liveNotes(owner: any, launched: boolean) {
  if (!launchesLive(owner)) return {};
  return {
    ...(launched ? { envStripped: liveEnvStripped(process.env) } : {}),
    warnings: gamesRootWarnings(owner.games),
  };
}

/**
 * How an owned build is built: a fixture profile's also counts React commits for its checks; a
 * live one does not, since profiling every render slows the app a person is using.
 */
export function devBuildArgs(buildId: string, providers: string): string[] {
  const args = ["scripts/build.mjs", `--dev-build=${buildId}`];
  return providers === "fixture" ? [...args, "--commit-counts"] : args;
}

/** Builds a dev build and starts the app on it, detached, with its output in a fresh log folder. */
async function launchApp(owner: any, id: string, providers: string) {
  const buildId = `b-${randomUUID()}`;
  await command(process.execPath, devBuildArgs(buildId, providers));
  writeJson(safeChild(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
  const logRoot = safeChild(devRoot(checkout), `evidence/launch-${buildId}`);
  fs.mkdirSync(logRoot, { mode: 0o700 });
  const out = fs.openSync(path.join(logRoot, "stdout.log"), "wx", 0o600);
  const err = fs.openSync(path.join(logRoot, "stderr.log"), "wx", 0o600);
  const executable = resolveElectron(checkout);
  const launchArgs = [
    path.join(checkout, `.studio-dev/builds/${buildId}/main/main.mjs`),
    `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
  ];
  const fixture = providers === "fixture";
  const child = spawn(executable, fixture ? fixtureElectronArgs(launchArgs) : launchArgs, {
    cwd: checkout,
    detached: true,
    stdio: ["ignore", out, err],
    env: launchEnv(owner),
  });
  writeJson(safeChild(owner.root, "attempt.json"), {
    version: 1,
    buildId,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    launchLogs: logRoot,
  });
  fs.closeSync(out);
  fs.closeSync(err);
  const launch: { child: typeof child; buildId: string; logRoot: string; spawnError?: Error } = {
    child,
    buildId,
    logRoot,
  };
  child.on("error", (e) => {
    launch.spawnError = e;
  });
  child.unref();
  return launch;
}

/** Waits until the launched build answers ready, or fails with what it last said. */
async function awaitReady(owner: any, launched: Awaited<ReturnType<typeof launchApp>>) {
  const { child, buildId, logRoot } = launched;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "waiting for actual readiness";
  while (Date.now() < deadline) {
    if (launched.spawnError) throw launched.spawnError;
    if (child.exitCode !== null) throw new Error(`development app exited (${child.exitCode}); inspect ${logRoot}`);
    try {
      const identity = await request(descriptor(owner), { method: "status", params: {} });
      if (identity.buildId === buildId && identity.readiness === "ready") return { ...identity, launchLogs: logRoot };
    } catch (e) {
      last = (e as Error).message;
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(`readiness timeout: ${last}; inspect ${logRoot}; profile retained for diagnosis`);
}

export async function startProfile(
  id: string,
  options: { reuse?: boolean; providers?: string; fixture?: string; freshMachine?: boolean } = {},
) {
  slug(id);
  const providers = options.providers ?? "fixture";
  const fixture = fixtureFor(providers, options.fixture);
  const owner = allocateProfile(checkout, id, providers, fixture, options.reuse, options.freshMachine === true);
  await assertNotRunning(owner);
  const claim = claimStartup(owner);
  try {
    return { ...(await awaitReady(owner, await launchApp(owner, id, providers))), ...liveNotes(owner, true) };
  } catch (e) {
    writeJson(safeChild(owner.root, "failure.json"), {
      version: 1,
      at: new Date().toISOString(),
      error: (e as Error).message,
    });
    throw e;
  } finally {
    fs.unlinkSync(claim);
  }
}

/** Removes a stopped, disposable profile; its evidence stays. */
function cleanProfile(owner: any, id: string) {
  assertStopped(owner);
  if (fs.existsSync(safeChild(owner.root, "starting.json"))) throw new Error("profile startup ownership unresolved");
  if (owner.retention !== "disposable") throw new Error("retained profile: clean refused");
  removeProfile(owner);
  fs.unlinkSync(safeChild(devRoot(checkout), `owners/${id}.json`));
  return { cleaned: id, evidencePreserved: true };
}

/** Opens the fresh-machine profile's own terminal in this one and returns when it exits. */
async function openShell(owner: any) {
  const shell = freshMachineShell(owner, process.env);
  if (process.platform === "darwin") linkKeychains(shell.cwd);
  process.stderr.write(`${MESSAGE.shellOpen(owner.profileId, shell.cwd)}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(shell.file, shell.args, { cwd: shell.cwd, env: shell.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { profileId: owner.profileId, shell: "exited", code };
}

/** The live app's status, or what the profile's files say about an app that does not answer. */
async function profileStatus(owner: any, id: string) {
  try {
    return { ...(await request(descriptor(owner), { method: "status", params: {} })), ...liveNotes(owner, false) };
  } catch (e) {
    const attemptFile = safeChild(owner.root, "attempt.json");
    const failureFile = safeChild(owner.root, "failure.json");
    const attempt = fs.existsSync(attemptFile) ? readVersion(attemptFile) : null;
    return {
      version: 1,
      profileId: id,
      providers: owner.providers,
      readiness: "not-ready",
      processMayExist: attempt?.pid ? pidExists(attempt.pid) : null,
      attempt,
      lastFailure: fs.existsSync(failureFile) ? readVersion(failureFile) : (e as Error).message,
      ...liveNotes(owner, false),
      roots: {
        electron: owner.electron,
        session: owner.session,
        core: owner.core,
        games: owner.games,
        ...(owner.freshMachine === true ? { home: owner.home } : {}),
      },
    };
  }
}

export async function main(args = process.argv.slice(2)) {
  const cli = parseStudioDevArgs(args);
  const id = cli.profile;
  if (cli.command === "fixtures") return { fixtures: [...FIXTURE_NAMES] };
  if (cli.command === "start")
    return startProfile(id, {
      reuse: cli.reuse,
      providers: cli.providers,
      fixture: cli.fixture,
      freshMachine: cli.freshMachine,
    });
  const owner = validateProfile(checkout, id);
  if (cli.command === "stop") return stopProfile(id);
  if (cli.command === "restart") {
    await stopProfile(id);
    return startProfile(id, {
      reuse: true,
      providers: owner.providers,
      fixture: owner.fixture,
      freshMachine: owner.freshMachine === true,
    });
  }
  if (cli.command === "clean") return cleanProfile(owner, id);
  if (cli.command === "shell") return openShell(owner);
  if (cli.command === "status") return profileStatus(owner, id);
  // capture/snapshot/logs/ui/diagnostics: one validated operation, inline or from a file/stdin.
  const d = descriptor(owner);
  const requestSource = cli.requestFile === "-" ? 0 : (cli.requestFile as string);
  return request(d, cli.operation ?? parseOperation(fs.readFileSync(requestSource, "utf8")));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exitCode = e.code === "missing-prerequisite" ? 2 : 1;
    });
