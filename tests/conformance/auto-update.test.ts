/**
 * Auto-update checks update.electronjs.org only from a released build: packaged, on a platform
 * that service serves (macOS, Windows), outside developer and test launches, and only once the
 * release switch is on (it stays off until the repository is public). A downloaded update is
 * announced in the studio window, which offers the restart; before the studio is up it is one
 * notification that restarts the app when clicked. The restart asks first while a run is active.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { UpdateAction, UpdateCheckStatus } from "../../src/shared/app-update.ts";
import {
  AUTO_UPDATE_ENABLED,
  InstallCheck,
  type PeriodicUpdateOptions,
  UpdateMode,
  askUpdater,
  createUpdateChecker,
  startAutoUpdate,
  updateCheckNote,
  UPDATE_REPO,
  type UpdateAnnouncerDeps,
  type UpdateCheckerDeps,
  type UpdateLaunch,
  UpdateSkip,
  autoUpdateDecision,
  createUpdateAnnouncer,
  FIRST_RUN_CHECK_DELAY_MS,
  firstCheckDelay,
  installedFromGenexRepository,
  releaseVersion,
  watchInstaller,
} from "../../src/main/auto-update.ts";
import { openStudioLog } from "../../src/main/logs.ts";

import { ReleaseCheckKind } from "../../src/main/release-check.ts";
import { tmpDir } from "../helpers/tmp.ts";

const require = createRequire(import.meta.url);

const released: UpdateLaunch = {
  enabled: true,
  packaged: true,
  platform: "darwin",
  developerLaunch: false,
  testLaunch: false,
  productName: "Genex",
  systemPackages: false,
};

test("the first check waits out Squirrel's hold on a fresh install, and runs at once otherwise", () => {
  assert.equal(firstCheckDelay(["C:\\genex\\app-0.1.14\\Genex.exe", "--squirrel-firstrun"]), FIRST_RUN_CHECK_DELAY_MS);
  assert.ok(FIRST_RUN_CHECK_DELAY_MS > 0);
  assert.equal(firstCheckDelay(["C:\\genex\\app-0.1.14\\Genex.exe"]), 0);
  assert.equal(firstCheckDelay(["/Applications/Genex.app/Contents/MacOS/Genex"]), 0);
});

test("a renamed fork cannot consume the official update feed", () => {
  assert.deepEqual(autoUpdateDecision({ ...released, productName: "My Studio" }), {
    start: false,
    reason: "identity",
  });
});

test("a released macOS or Windows build installs updates; a Linux build is told about them", () => {
  assert.deepEqual(autoUpdateDecision(released), { start: true, mode: UpdateMode.Install });
  assert.deepEqual(autoUpdateDecision({ ...released, platform: "win32" }), { start: true, mode: UpdateMode.Install });
  assert.deepEqual(autoUpdateDecision({ ...released, platform: "linux" }), { start: true, mode: UpdateMode.Notify });
});

test("a Linux copy installed from the Genex package repository is updated by the system", () => {
  const linux = { ...released, platform: "linux" as const };
  assert.deepEqual(autoUpdateDecision({ ...linux, systemPackages: true }), { start: true, mode: UpdateMode.System });
  assert.deepEqual(autoUpdateDecision({ ...released, systemPackages: true }), {
    start: true,
    mode: UpdateMode.Install,
  });
});

test("only the packaged executable with the Genex repository configured counts as a repository install", () => {
  const configured =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);
  const exec = "/usr/lib/genex/genex";
  assert.equal(installedFromGenexRepository(exec, configured("/etc/apt/sources.list.d/genex.list")), true);
  assert.equal(installedFromGenexRepository(exec, configured("/etc/yum.repos.d/genex.repo")), true);
  assert.equal(installedFromGenexRepository(exec, configured()), false, "a .deb installed before the repository");
  assert.equal(
    installedFromGenexRepository("/home/me/Genex-linux-x64/genex", configured("/etc/apt/sources.list.d/genex.list")),
    false,
    "a .zip copy beside a repository install still needs the notice",
  );
});

test("every other launch stays off, and says why", () => {
  const cases: [Partial<UpdateLaunch>, UpdateSkip][] = [
    [{ enabled: false }, UpdateSkip.Disabled],
    [{ packaged: false }, UpdateSkip.Unpackaged],
    [{ platform: "freebsd" }, UpdateSkip.Platform],
    [{ developerLaunch: true }, UpdateSkip.DeveloperLaunch],
    [{ testLaunch: true }, UpdateSkip.TestLaunch],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(autoUpdateDecision({ ...released, ...change }), { start: false, reason }, JSON.stringify(change));
  }
});

test("the release switch is on, so a released build checks for updates", () => {
  assert.equal(AUTO_UPDATE_ENABLED, true);
  assert.deepEqual(autoUpdateDecision({ ...released, enabled: AUTO_UPDATE_ENABLED }), {
    start: true,
    mode: UpdateMode.Install,
  });
});

test("the update feed reads the repository the releases are published to", () => {
  const forge = require("../../forge.config.cjs");
  const github = forge.publishers.find(
    (publisher: { name: string }) => publisher.name === "@electron-forge/publisher-github",
  );
  const { owner, name } = github.config.repository;
  assert.equal(`${owner}/${name}`, UPDATE_REPO, "forge.config.cjs publishers");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.repository.url, `git+https://github.com/${UPDATE_REPO}.git`, "package.json repository");
});

test("the version comes from the release's name, whatever the feed calls it", () => {
  const cases: [string, string | null][] = [
    // update.electronjs.org answers with the GitHub release's title, which release.yml writes so.
    ["Genex 0.2.0", "0.2.0"],
    ["v0.2.0", "0.2.0"],
    // Squirrel.Windows names the bare version.
    ["0.3.0-rc.2", "0.3.0-rc.2"],
    ["", null],
    ["Spring release", null],
  ];
  for (const [name, version] of cases) assert.equal(releaseVersion(name), version, name);
});

/** An announcer over recorders: what it told whom, and the clicks its notifications wait on. */
function announcer(change: Partial<UpdateAnnouncerDeps> = {}) {
  const log: string[] = [];
  const clicks: (() => void)[] = [];
  const updates = createUpdateAnnouncer({
    studioUp: () => true,
    announce: (update) => log.push(`announce ${update.version}`),
    notify: (note, onClick) => {
      log.push(`notify ${note.title}: ${note.body}`);
      clicks.push(onClick);
    },
    confirmRestart: async () => true,
    quitAndInstall: () => log.push("quit and install"),
    openRelease: (url) => log.push(`open ${url}`),
    ...change,
  });
  return { updates, log, clicks };
}

test("a downloaded update is announced in the studio window and waits there for a restart", () => {
  const { updates, log } = announcer();
  assert.equal(updates.ready(), null);
  updates.downloaded("Genex 0.2.0");
  assert.deepEqual(updates.ready(), { version: "0.2.0", action: UpdateAction.Restart });
  assert.deepEqual(log, ["announce 0.2.0"], "no notification while the window can say it");
});

test("before the studio is up, the update is one notification that names the version once", async () => {
  const { updates, log, clicks } = announcer({ studioUp: () => false });
  updates.downloaded("Genex 0.2.0");
  assert.deepEqual(log, [
    "notify Update ready — restart: Genex 0.2.0 is downloaded. Click to restart now, or it installs the next time you quit.",
  ]);
  clicks[0]?.();
  await setImmediate();
  assert.deepEqual(log.slice(1), ["quit and install"], "the click restarts into it");
  const unnamed = announcer({ studioUp: () => false });
  unnamed.updates.downloaded("");
  assert.deepEqual(unnamed.log, [
    "notify Update ready — restart: A new version of Genex is downloaded. Click to restart now, or it installs the next time you quit.",
  ]);
});

test("restart installs only a downloaded update, and only once the person agrees", async () => {
  let agree = false;
  const { updates, log } = announcer({ confirmRestart: async () => agree });
  assert.equal(await updates.restart(), false, "nothing downloaded");
  updates.downloaded("0.2.0");
  log.length = 0;
  assert.equal(await updates.restart(), false, "the person kept the run going");
  assert.deepEqual(log, []);
  agree = true;
  assert.equal(await updates.restart(), true);
  assert.deepEqual(log, ["quit and install"]);
});

test("a second restart while the first still asks does not ask again", async () => {
  let answer: (agree: boolean) => void = () => {};
  let asked = 0;
  const { updates, log } = announcer({
    confirmRestart: () => {
      asked++;
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  updates.downloaded("0.2.0");
  log.length = 0;
  const first = updates.restart();
  assert.equal(await updates.restart(), false);
  answer(true);
  assert.equal(await first, true);
  assert.equal(asked, 1);
  assert.deepEqual(log, ["quit and install"]);
});

const PAGE = "https://github.com/genex-games/genex-desktop/releases/tag/v0.2.0";

test("a published release Linux cannot install is offered for download, once per version", async () => {
  const { updates, log } = announcer();
  updates.available({ version: "0.2.0", url: PAGE });
  updates.available({ version: "0.2.0", url: PAGE });
  assert.deepEqual(updates.ready(), { version: "0.2.0", action: UpdateAction.Download });
  assert.deepEqual(log, ["announce 0.2.0"], "a later check of the same release says nothing new");
  assert.equal(await updates.restart(), false, "nothing downloaded to install");
  assert.equal(updates.download(), true);
  assert.deepEqual(log.slice(1), [`open ${PAGE}`]);
});

test("before the studio is up, a downloadable release is one notification that opens its page", () => {
  const { updates, log, clicks } = announcer({ studioUp: () => false });
  updates.available({ version: "0.2.0", url: PAGE });
  assert.deepEqual(log, ["notify Genex 0.2.0 is available: Click to open its download page."]);
  clicks[0]?.();
  assert.deepEqual(log.slice(1), [`open ${PAGE}`]);
});

test("download opens nothing while no downloadable release waits", () => {
  const { updates, log } = announcer();
  assert.equal(updates.download(), false);
  updates.downloaded("Genex 0.2.0");
  assert.equal(updates.download(), false, "a downloaded update installs by restart, not a page");
  assert.deepEqual(log, ["announce 0.2.0"]);
});

/** A stand-in for Electron's autoUpdater: records checks and lets a test emit its events. */
function fakeUpdater(onCheck: (emit: (event: string) => void) => void = () => {}) {
  type Listener = (() => void) & { original?: () => void };
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  };
  let checks = 0;
  const updater = {
    once(event: string, listener: () => void) {
      const wrapped: Listener = () => {
        listeners.get(event)?.delete(wrapped);
        listener();
      };
      wrapped.original = listener;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(wrapped);
      return updater;
    },
    removeListener(event: string, listener: () => void) {
      for (const held of [...(listeners.get(event) ?? [])]) {
        if (held === listener || held.original === listener) listeners.get(event)?.delete(held);
      }
      return updater;
    },
    checkForUpdates() {
      checks++;
      onCheck(emit);
    },
  };
  const listening = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { updater, emit, checks: () => checks, listening };
}

test("asking the installer maps each answer of the updater, and leaves no listener behind", async () => {
  const cases: [string, InstallCheck][] = [
    ["update-not-available", InstallCheck.None],
    ["update-available", InstallCheck.Found],
    ["update-downloaded", InstallCheck.Downloaded],
    ["error", InstallCheck.Failed],
  ];
  for (const [event, expected] of cases) {
    const fake = fakeUpdater((emit) => emit(event));
    assert.equal(await askUpdater(fake.updater, { timeoutMs: 1000 }), expected, event);
    assert.equal(fake.listening(), 0, event);
  }
});

test("an updater that never answers, or throws, fails the check instead of hanging", async () => {
  const silent = fakeUpdater();
  assert.equal(await askUpdater(silent.updater, { timeoutMs: 5 }), InstallCheck.Failed);
  assert.equal(silent.listening(), 0);
  const throwing = fakeUpdater(() => {
    throw new Error("Update URL is not set");
  });
  assert.equal(await askUpdater(throwing.updater, { timeoutMs: 1000 }), InstallCheck.Failed);
  assert.equal(throwing.listening(), 0);
});

/** Squirrel.Mac's refusal of a check asked while another runs, as Electron reports it. */
function busyError(): Error {
  return Object.assign(new Error("The command is disabled and cannot be executed"), {
    code: 1,
    domain: "RACCommandErrorDomain",
  });
}

/**
 * A stand-in for Squirrel.Mac behind Electron's autoUpdater: one check at a time, its download
 * included, and a check asked while one runs refused at once with an error. The test plays the
 * running check: `found` starts its download, `end` gives its last answer.
 */
function squirrel() {
  type Listener = ((...args: unknown[]) => void) & { original?: (...args: unknown[]) => void };
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  const add = (event: string, listener: Listener) => {
    const held = listeners.get(event) ?? new Set<Listener>();
    held.add(listener);
    listeners.set(event, held);
  };
  let running = false;
  let checks = 0;
  const updater = {
    on(event: string, listener: (...args: unknown[]) => void) {
      add(event, listener);
      return updater;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped: Listener = (...args) => {
        listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      wrapped.original = listener;
      add(event, wrapped);
      return updater;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      for (const held of [...(listeners.get(event) ?? [])]) {
        if (held === listener || held.original === listener) listeners.get(event)?.delete(held);
      }
      return updater;
    },
    checkForUpdates() {
      checks++;
      if (running) return emit("error", busyError());
      running = true;
      emit("checking-for-update");
    },
  };
  return {
    updater,
    found: () => emit("update-available"),
    end: (event: string, ...args: unknown[]) => {
      running = false;
      emit(event, ...args);
    },
    checks: () => checks,
  };
}

test("Check for Updates during the background download says it is downloading, and asks Squirrel nothing", async () => {
  const mac = squirrel();
  const installer = watchInstaller(mac.updater, { timeoutMs: 1000 });
  mac.updater.checkForUpdates(); // the check at launch
  mac.found();
  assert.equal(await installer.ask(), InstallCheck.Found);
  assert.equal(mac.checks(), 1, "a second check is refused, which read as offline");
});

test("while the background check still asks the feed, Check for Updates takes its answer", async () => {
  const mac = squirrel();
  const installer = watchInstaller(mac.updater, { timeoutMs: 1000 });
  mac.updater.checkForUpdates();
  const answer = installer.ask();
  mac.end("update-not-available");
  assert.equal(await answer, InstallCheck.None);
  assert.equal(mac.checks(), 1);
});

test("a check Squirrel refuses as busy waits for the running one instead of failing", async () => {
  // Electron reports a check a moment after it starts, so a click can land in between.
  const mac = squirrel();
  mac.updater.checkForUpdates();
  const answer = askUpdater(mac.updater, { timeoutMs: 1000 });
  mac.found();
  assert.equal(await answer, InstallCheck.Found);
});

test("once a version is downloaded, Check for Updates asks Squirrel nothing more", async () => {
  // Asked again, Squirrel re-requests the same zip; answered 304, Electron reports no update and
  // forgets the downloaded one, so Relaunch would close the windows and install nothing.
  const mac = squirrel();
  const installer = watchInstaller(mac.updater, { timeoutMs: 1000 });
  mac.updater.checkForUpdates();
  mac.found();
  mac.end("update-downloaded", {}, "", "Genex 0.2.0");
  assert.equal(await installer.ask(), InstallCheck.Downloaded);
  mac.end("error", new Error("No update available, can't quit and install"));
  assert.equal(await installer.ask(), InstallCheck.Downloaded, "it still installs at the next quit");
  assert.equal(mac.checks(), 1);
});

test("an hourly check refused during the download leaves the download in view", async () => {
  const mac = squirrel();
  const installer = watchInstaller(mac.updater, { timeoutMs: 1000 });
  mac.updater.checkForUpdates();
  mac.found();
  mac.updater.checkForUpdates(); // update-electron-app's hourly check, refused
  assert.equal(await installer.ask(), InstallCheck.Found);
  assert.equal(mac.checks(), 2);
});

test("after the background check ends, Check for Updates asks again, and a real failure still fails", async () => {
  const mac = squirrel();
  const installer = watchInstaller(mac.updater, { timeoutMs: 1000 });
  mac.updater.checkForUpdates();
  mac.end("error", new Error("The Internet connection appears to be offline."));
  const current = installer.ask();
  assert.equal(mac.checks(), 2);
  mac.end("update-not-available");
  assert.equal(await current, InstallCheck.None);
  const failing = installer.ask();
  mac.end("error", new Error("The Internet connection appears to be offline."));
  assert.equal(await failing, InstallCheck.Failed);
});

/** startAutoUpdate over a stand-in for update-electron-app, writing into a real studio log. */
async function periodicChecks() {
  const dir = await tmpDir("auto-update-");
  const log = openStudioLog(dir, { home: "/Users/someone", now: () => new Date(0) });
  const downloaded: string[] = [];
  let given: PeriodicUpdateOptions | null = null;
  let stopped = 0;
  await startAutoUpdate(
    { log: (line) => log.write("update", line), downloaded: (name) => downloaded.push(name) },
    async (options) => {
      given = options;
      return { stopUpdates: () => stopped++ };
    },
  );
  assert.ok(given, "update-electron-app was started");
  const options: PeriodicUpdateOptions = given;
  return { options, downloaded, stopped: () => stopped, lines: () => log.tail(10) };
}

test("the update log keeps what the updater says, its errors included, and never throws", async () => {
  const rig = await periodicChecks();
  const { logger } = rig.options;
  logger.log("feedURL", "https://update.electronjs.org/genex-games/genex-desktop/darwin-arm64/0.1.0");
  logger.log("requestHeaders", { "User-Agent": "update-electron-app/3.3.0" });
  logger.log("updater error");
  assert.doesNotThrow(() => logger.log(busyError()));
  logger.log("update-downloaded", [{}, "## What's Changed", "Genex 0.2.0"]);
  const at = "1970-01-01T00:00:00.000Z [update]";
  assert.deepEqual(rig.lines(), [
    `${at} feedURL https://update.electronjs.org/genex-games/genex-desktop/darwin-arm64/0.1.0`,
    `${at} requestHeaders`,
    `${at} updater error`,
    `${at} The command is disabled and cannot be executed`,
    `${at} update-downloaded`,
  ]);
});

test("once a version downloads, the hourly checks stop and the window hears of it", async () => {
  const rig = await periodicChecks();
  rig.options.onNotifyUser({ releaseName: "Genex 0.2.0" });
  assert.equal(rig.stopped(), 1, "an hourly check would make Electron forget the download");
  assert.deepEqual(rig.downloaded, ["Genex 0.2.0"]);
});

/** A checker over an announcer, a scripted installer and a scripted release check. */
function checker(
  decision: ReturnType<typeof autoUpdateDecision>,
  answers: { install?: InstallCheck; release?: Awaited<ReturnType<UpdateCheckerDeps["latestRelease"]>> } = {},
) {
  const rig = announcer();
  let asked = 0;
  const { check } = createUpdateChecker({
    decision,
    current: "0.1.0",
    updates: rig.updates,
    askInstaller: async () => {
      asked++;
      return answers.install ?? InstallCheck.None;
    },
    latestRelease: async () => {
      asked++;
      return answers.release ?? { kind: ReleaseCheckKind.Current };
    },
  });
  return { check, rig, asked: () => asked };
}

test("check for updates on macOS: current, downloading, or the update already waiting", async () => {
  const install = { start: true, mode: UpdateMode.Install } as const;
  const current = await checker(install).check();
  assert.deepEqual(current, { status: UpdateCheckStatus.Current, current: "0.1.0", update: null });
  const found = await checker(install, { install: InstallCheck.Found }).check();
  assert.equal(found.status, UpdateCheckStatus.Downloading);
  const failed = await checker(install, { install: InstallCheck.Failed }).check();
  assert.equal(failed.status, UpdateCheckStatus.Failed);
  const waiting = checker(install);
  waiting.rig.updates.downloaded("Genex 0.2.0");
  assert.deepEqual(await waiting.check(), {
    status: UpdateCheckStatus.Waiting,
    current: "0.1.0",
    update: { version: "0.2.0", action: UpdateAction.Restart },
  });
  assert.equal(waiting.asked(), 0, "nothing to ask while a download waits");
});

test("check for updates on Linux finds the release and offers its download", async () => {
  const notify = { start: true, mode: UpdateMode.Notify } as const;
  const { check, rig } = checker(notify, {
    release: { kind: ReleaseCheckKind.Newer, release: { version: "0.2.0", url: PAGE } },
  });
  assert.deepEqual(await check(), {
    status: UpdateCheckStatus.Waiting,
    current: "0.1.0",
    update: { version: "0.2.0", action: UpdateAction.Download },
  });
  assert.deepEqual(rig.log, ["announce 0.2.0"]);
  const failed = checker(notify, { release: { kind: ReleaseCheckKind.Failed, reason: "offline" } });
  assert.equal((await failed.check()).status, UpdateCheckStatus.Failed);
});

test("check for updates on a repository install asks nobody and points at the system's updates", async () => {
  const { check, asked } = checker({ start: true, mode: UpdateMode.System });
  assert.deepEqual(await check(), { status: UpdateCheckStatus.System, current: "0.1.0", update: null });
  assert.equal(asked(), 0);
  const note = updateCheckNote({ status: UpdateCheckStatus.System, current: "0.1.0", update: null });
  assert.equal(note.act, null);
  assert.match(note.detail, /apt|dnf/);
});

test("a build that never checks answers off without asking anyone, unless an update already waits", async () => {
  const { check, asked, rig } = checker({ start: false, reason: UpdateSkip.DeveloperLaunch });
  assert.deepEqual(await check(), { status: UpdateCheckStatus.Off, current: "0.1.0", update: null });
  assert.equal(asked(), 0);
  rig.updates.downloaded("Genex 0.2.0");
  assert.equal((await check()).status, UpdateCheckStatus.Waiting, "the update-ready fixture's stand-in");
});

test("two checks at once ask once", async () => {
  const { check, asked } = checker({ start: true, mode: UpdateMode.Install });
  const [first, second] = await Promise.all([check(), check()]);
  assert.deepEqual(first, second);
  assert.equal(asked(), 1);
});

test("the menu's answer names the versions and offers the one next step", () => {
  const current = updateCheckNote({ status: UpdateCheckStatus.Current, current: "0.1.0", update: null });
  assert.equal(current.act, null);
  assert.match(current.message, /0\.1\.0/);
  const download = updateCheckNote({
    status: UpdateCheckStatus.Waiting,
    current: "0.1.0",
    update: { version: "0.2.0", action: UpdateAction.Download },
  });
  assert.equal(download.act, UpdateAction.Download);
  assert.match(download.message, /0\.2\.0/);
  const restart = updateCheckNote({
    status: UpdateCheckStatus.Waiting,
    current: "0.1.0",
    update: { version: "0.2.0", action: UpdateAction.Restart },
  });
  assert.equal(restart.act, UpdateAction.Restart);
  for (const status of [UpdateCheckStatus.Downloading, UpdateCheckStatus.Off, UpdateCheckStatus.Failed]) {
    assert.equal(updateCheckNote({ status, current: "0.1.0", update: null }).act, null, status);
  }
});
