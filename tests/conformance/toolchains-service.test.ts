/**
 * The toolchain service (`main/core/toolchains.ts`) and its IPC (`main/ipc/toolchain.ts`): the one
 * install job, joining and cancelling it, the sandbox prewarm runs in, pruning, the Command Line
 * Tools install, the checks a renderer's install request passes before any work, and the rules the
 * Toolchain sheet shows them by (`renderer/panels/toolchain-view.ts`). The store substrate is faked
 * here (it has its own suite, `toolchain-store.test.ts`): what these rows prove is what the
 * service runs, in which order, and what it never runs.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createPrewarmSandbox,
  type HostExec,
  type PrewarmSandbox,
  ToolchainService,
  type ToolchainServiceOptions,
  type ToolchainStoreOps,
  XCODE_SELECT,
} from "../../src/main/core/toolchains.ts";
import {
  FIXTURE_CPP_GAMES,
  FIXTURE_FORCED_ERROR,
  FIXTURE_TOOLCHAIN_STORE_ENV,
  fixtureWebOutput,
  linkFixtureToolchainStore,
  seedCppGame,
  seedFixtureToolchainStore,
  stubCmake,
} from "../../src/main/dev/fixture-toolchains.ts";
import { toolchainRefusal } from "../../src/main/cpp-build.ts";
import { registerToolchainIpc } from "../../src/main/ipc/toolchain.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { sheetView, unhostedHere } from "../../src/renderer/panels/toolchain-view.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { BUILD_TARGETS, BuildTarget } from "../../src/shared/game-project.ts";
import {
  servedToolchainHost,
  ArchiveFormat,
  REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  ToolchainProblem,
  ToolchainPruneRefusal,
  type ToolchainEntry,
  type ToolchainInstallJob,
  type ToolchainLock,
  type ToolchainStatus,
  missingFor,
  PrewarmState,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import {
  type InstallDeps,
  installComponents,
  ReceiptSource,
  readReceipts,
  type ToolchainReceipt,
} from "../../src/substrate/toolchain-store/install.ts";
import { crateCheckFolders } from "../../src/substrate/toolchain-store/crate-check-store.ts";
import { currentLock, locateToolchain, lockFolder, PREWARM_FILE } from "../../src/substrate/toolchain-store/locate.ts";
import { TOOLCHAIN_MANIFEST } from "../../src/substrate/toolchain-store/manifest.ts";
import { PREWARMED_TARGETS, prewarmPolicy } from "../../src/substrate/toolchain-store/prewarm.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOW = Date.parse("2026-10-01T04:00:00.000Z");
const GB = 1024 ** 3;
/** The fixture's stubs are shell scripts, and the real-sandbox rows need macOS's or Linux's sandbox. */
const POSIX_ONLY = process.platform === "win32" ? { skip: "POSIX shell scripts and sandbox backends" } : {};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The parts an emsdk entry unpacks, one archive each: Emscripten's own install, its Node and its Python. */
const EMSDK_PARTS = ["install", "node", "python"];

/** One pinned (or unpinned) manifest entry for this Mac: one 1000-byte archive per part it needs. */
function entry(id: ToolchainId, version: string, pinned = true): ToolchainEntry {
  const parts = id === ToolchainId.Emsdk ? EMSDK_PARTS : [""];
  return {
    id,
    version,
    host: ToolchainHost.MacArm64,
    target: null,
    licence: "test",
    archives: parts.map((into) => ({
      url: `https://downloads.test/${id}-${version}${into ? `-${into}` : ""}.tar.gz`,
      bytes: 1000,
      sha256: pinned ? sha(`${id}@${version}/${into}`) : null,
      format: ArchiveFormat.TarGz,
      strip: 1,
      into,
    })),
  };
}

/** Browser and Mac, pinned; Windows and Linux have nothing in this manifest yet. */
const MANIFEST: readonly ToolchainEntry[] = [
  entry(ToolchainId.Cmake, "4.4.3"),
  entry(ToolchainId.Ninja, "1.13.2"),
  entry(ToolchainId.Emsdk, "6.0.10"),
  entry(ToolchainId.RaylibSource, "6.0"),
  entry(ToolchainId.AngleMac, "c5bf49e78850"),
];

const sha12Of = (item: ToolchainEntry) =>
  item.local
    ? item.local.manifestSha256.slice(0, 12)
    : sha(item.archives.map((archive) => archive.sha256 ?? "").join("\n")).slice(0, 12);

/** A component Genex built and pinned by its folder's manifest, with no download yet (ANGLE). */
function localEntry(id: ToolchainId, target: BuildTarget): ToolchainEntry {
  return {
    id,
    version: "c5bf49e78850",
    host: null,
    target,
    licence: "test",
    archives: [],
    local: {
      manifestSha256: sha(`${id} manifest.json`),
      manifestBytes: 2048,
      files: 12,
      bytes: 9_000_000,
      reason: ToolchainUnhosted.NotPublished,
    },
  };
}

/** Browser pinned for download, and the Mac's ANGLE pinned as a local artifact only, as the shipped manifest has them. */
const LOCAL_ANGLE_MANIFEST: readonly ToolchainEntry[] = [
  ...MANIFEST.filter((item) => item.id !== ToolchainId.AngleMac),
  localEntry(ToolchainId.AngleMac, BuildTarget.Mac),
];

/** What the fake substrate saw. */
interface Calls {
  installed: ToolchainId[][];
  prewarmed: Array<{ lock: ToolchainLock; targets: readonly BuildTarget[] }>;
  pruned: Array<ReadonlySet<string>>;
  fetched: string[];
}

/** A fake store substrate: every row replaces what it needs. */
function fakeStore(options: { manifest?: readonly ToolchainEntry[]; receipts?: ToolchainReceipt[] } = {}) {
  const manifest = options.manifest ?? MANIFEST;
  const calls: Calls = { installed: [], prewarmed: [], pruned: [], fetched: [] };
  const state: { current: ToolchainLock | null; receipts: ToolchainReceipt[] } = {
    current: null,
    receipts: options.receipts ?? [],
  };
  const ops: ToolchainStoreOps = {
    manifest,
    manifestEntry: (id, host) =>
      manifest.find((item) => item.id === id && (item.host === host || item.host === null)) ?? null,
    entrySha12: sha12Of,
    lockOf: (entries) => ({ version: 1, entries, digest: sha(JSON.stringify(Object.entries(entries).sort())) }),
    referencedVersions: (locks) =>
      new Set(
        locks.flatMap((lock) => Object.entries(lock.entries).map(([id, pin]) => `${id}/${pin?.version}-${pin?.sha12}`)),
      ),
    async installComponents(_store, entries, deps) {
      calls.installed.push(entries.map((item) => item.id));
      for (const phase of [
        ToolchainInstallPhase.Downloading,
        ToolchainInstallPhase.Verifying,
        ToolchainInstallPhase.Extracting,
        ToolchainInstallPhase.Probing,
      ])
        deps.onJob({ phase, entry: entries[0]?.id ?? null, completed: 0, total: entries.length, startedAt: "x" });
      return {
        phase: ToolchainInstallPhase.Installed,
        entry: null,
        completed: entries.length,
        total: entries.length,
        startedAt: "x",
      };
    },
    async prewarm(_store, lock, targets) {
      calls.prewarmed.push({ lock, targets });
      return { lock: lock.digest, recipe: "recipe12", outputs: [], at: new Date(NOW).toISOString() };
    },
    readReceipts: async () => state.receipts,
    async pruneStore(_store, keep) {
      calls.pruned.push(keep);
      return { removed: 1, bytes: 4096 };
    },
    currentLock: async () => state.current,
    async writeCurrentLock(_store, lock) {
      state.current = lock;
    },
    locateToolchain: async () => ({ ok: false, missing: [] }),
  };
  return { ops, calls, state };
}

/** The folders no prewarm command may write besides the store: the games root, scratch and runs. */
const PREWARM_DENY = ["/studio/workspaces/games", "/studio/scratch", "/studio/runs"];

/** A recording prewarm sandbox: what ran in it, and whether it was let go. */
interface FakePrewarmSandbox extends PrewarmSandbox {
  runs: RunRequest[];
  disposed: boolean;
}

/** A sandboxed run that exited 0 with nothing to say. */
function ranOk(request: RunRequest): RunResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: request.command,
    cwd: request.cwd,
  };
}

function fakePrewarmSandbox(): FakePrewarmSandbox {
  const box: FakePrewarmSandbox = {
    runs: [],
    disposed: false,
    run: async (request) => {
      box.runs.push(request);
      return ranOk(request);
    },
    dispose: async () => {
      box.disposed = true;
    },
  };
  return box;
}

/** A service over a fresh temp store and the fake substrate; `emitted` is every job it announced. */
async function service(ops: ToolchainStoreOps, calls: Calls, overrides: Partial<ToolchainServiceOptions> = {}) {
  const store = await tmpDir("toolchain-store-");
  const emitted: ToolchainInstallJob[] = [];
  const execs: Array<[string, readonly string[]]> = [];
  const sandboxes: FakePrewarmSandbox[] = [];
  const exec: HostExec = async (file, args) => {
    execs.push([file, args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const toolchains = new ToolchainService({
    store,
    host: ToolchainHost.MacArm64,
    emit: (job) => emitted.push(job),
    run: async () => {
      throw new Error("no sandboxed run in these rows");
    },
    exec,
    probeClt: async () => ({ present: true, version: null }),
    ops,
    fetch: async (url) => {
      calls.fetched.push(url);
      throw new Error("no network in these rows");
    },
    freeBytes: async () => 40 * GB,
    prewarmSandbox: async () => {
      const box = fakePrewarmSandbox();
      sandboxes.push(box);
      return box;
    },
    prewarmDenyWrite: PREWARM_DENY,
    now: () => NOW,
    ...overrides,
  });
  return { toolchains, store, emitted, execs, sandboxes };
}

const phases = (jobs: readonly ToolchainInstallJob[]) => jobs.map((job) => job.phase);

describe("one C++ setup for every supported destination", () => {
  const manifest = [
    ...MANIFEST,
    ...[ToolchainId.Zig, ToolchainId.AngleWindows, ToolchainId.AngleLinux, ToolchainId.LinuxSysroot].map((id) =>
      entry(id, "1"),
    ),
  ];

  it("a first Windows request prepares the complete host set, and a later Mac request reuses the exact receipts and prewarm", async () => {
    const { ops, calls, state } = fakeStore({ manifest });
    const originalInstall = ops.installComponents;
    ops.installComponents = async (store, entries, deps) => {
      const done = await originalInstall(store, entries, deps);
      state.receipts.push(...entries.map((item) => receipt(item.id, item.version, sha12Of(item), 1)));
      return done;
    };
    const originalWarm = ops.prewarm;
    const warmed = new Set<string>();
    ops.prewarm = async (store, lock, targets, deps) => {
      const done = await originalWarm(store, lock, targets, deps);
      warmed.add(lock.digest);
      return done;
    };
    ops.locateToolchain = async (_store, lock) =>
      warmed.has(lock.digest)
        ? { ok: true, toolchain: { lock, cmake: "", ninja: "", emscripten: null, genexCmake: {} } }
        : { ok: false, missing: [] };
    const { toolchains } = await service(ops, calls, { probeClt: async () => ({ present: true, version: null }) });
    assert.equal((await toolchains.install([BuildTarget.Windows])).phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(Object.keys(state.current?.entries ?? {}).sort(), manifest.map((item) => item.id).sort());
    assert.deepEqual(
      calls.prewarmed.map((call) => call.targets),
      [PREWARMED_TARGETS],
      "the complete fake Mac lock prewarms the destinations this runner can build",
    );
    await toolchains.install([BuildTarget.Mac]);
    assert.equal(calls.installed.length, 1, "no second download or copy");
    assert.equal(calls.prewarmed.length, 1, "no second first build");
  });

  it("Windows then Mac requests join one complete install without dropping the later destination", async () => {
    const { ops, calls, state } = fakeStore({ manifest });
    const held = gate();
    const install = ops.installComponents;
    ops.installComponents = async (store, entries, deps) => {
      held.started.resolve();
      await held.release.promise;
      return install(store, entries, deps);
    };
    const { toolchains } = await service(ops, calls, { probeClt: async () => ({ present: true, version: null }) });
    const first = toolchains.install([BuildTarget.Windows]);
    await held.started.promise;
    const second = toolchains.install([BuildTarget.Mac]);
    held.release.resolve();
    assert.deepEqual(await first, await second);
    assert.equal(calls.installed.length, 1);
    assert.ok(state.current?.entries[ToolchainId.AngleMac], "Mac was included before joining");
    assert.ok(state.current?.entries[ToolchainId.Emsdk], "cross-only games still have the judges' browser tools");
  });

  it("missing Apple tools leave Mac unprepared while Browser, Windows and Linux finish", async () => {
    const { ops, calls, state } = fakeStore({ manifest });
    const { toolchains } = await service(ops, calls, { probeClt: async () => ({ present: false, version: null }) });
    const job = await toolchains.install([BuildTarget.Windows]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(job.unavailable, [BuildTarget.Mac]);
    assert.deepEqual(
      calls.prewarmed.map((call) => call.targets),
      [[BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]],
    );
    assert.ok(state.current?.entries[ToolchainId.AngleMac], "managed Mac parts are installed once too");
    const status = await toolchains.status();
    assert.equal(
      sheetView(status, null, [BuildTarget.Mac]).ready,
      false,
      "Mac cannot be called ready without Apple's SDK",
    );
  });

  it("a Linux host prepares Browser, Windows and Linux without probing Apple's SDK", async () => {
    const { ops, calls, state } = fakeStore({
      manifest: manifest.map((item) => ({ ...item, host: ToolchainHost.LinuxX64 })),
    });
    const { toolchains } = await service(ops, calls, {
      host: ToolchainHost.LinuxX64,
      probeClt: async () => {
        throw new Error("Linux setup must not ask for Apple's SDK");
      },
    });
    assert.equal((await toolchains.install([BuildTarget.Linux])).phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(
      calls.prewarmed.map((call) => call.targets),
      [[BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]],
    );
    assert.equal(state.current?.entries[ToolchainId.AngleMac], undefined);
    assert.ok(state.current?.entries[ToolchainId.AngleWindows], "Windows cross-build parts are available too");
  });

  it("a failed preparation retains the current lock and retries using the pins already installed", async () => {
    const { ops, calls, state } = fakeStore({ manifest });
    const prior = ops.lockOf({ [ToolchainId.Cmake]: { version: "old", sha12: "000000000000" } });
    state.current = prior;
    const install = ops.installComponents;
    ops.installComponents = async (store, entries, deps) => {
      const done = await install(store, entries, deps);
      state.receipts.push(...entries.map((item) => receipt(item.id, item.version, sha12Of(item), 1)));
      return done;
    };
    const warm = ops.prewarm;
    let fail = true;
    ops.prewarm = async (...args) => {
      if (fail) throw new ToolchainError(ToolchainProblem.Prewarm, "failed fixture first build");
      return warm(...args);
    };
    const { toolchains } = await service(ops, calls);
    assert.equal((await toolchains.install([BuildTarget.Windows])).phase, ToolchainInstallPhase.Failed);
    assert.deepEqual(state.current, prior, "the previous usable lock survives");
    fail = false;
    assert.equal((await toolchains.install([BuildTarget.Mac])).phase, ToolchainInstallPhase.Installed);
    assert.equal(calls.installed.length, 1, "retry does not download pins already installed");
    assert.deepEqual(Object.keys(state.current?.entries ?? {}).sort(), manifest.map((item) => item.id).sort());
  });
});

const RUNNING: ReadonlySet<string> = new Set([
  ToolchainInstallPhase.Preflight,
  ToolchainInstallPhase.Downloading,
  ToolchainInstallPhase.Verifying,
  ToolchainInstallPhase.Extracting,
  ToolchainInstallPhase.Probing,
  ToolchainInstallPhase.Prewarming,
]);

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** An install stage that holds until the row releases it, and says when it started. */
function gate() {
  return { started: deferred(), release: deferred() };
}

function receipt(id: ToolchainId, version: string, sha12: string, bytes: number): ToolchainReceipt {
  return {
    id,
    version,
    sha256: `${sha12}${"0".repeat(52)}`,
    sha12,
    bytes,
    host: ToolchainHost.MacArm64,
    target: null,
    source: ReceiptSource.Archive,
    installedAt: new Date(NOW).toISOString(),
  };
}

async function absent(file: string): Promise<boolean> {
  return lstat(file).then(
    () => false,
    () => true,
  );
}

describe("ToolchainService.status", () => {
  it("reports the Command Line Tools from the injected probe, installed versions from receipts, the lock and the store's size", async () => {
    const cmake = MANIFEST[0];
    assert.ok(cmake);
    const { ops, calls, state } = fakeStore({
      receipts: [receipt(ToolchainId.Cmake, "4.4.3", sha12Of(cmake), 89_000_000)],
    });
    state.current = ops.lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: sha12Of(cmake) } });
    for (const clt of [
      { present: false, version: null },
      { present: true, version: "26.0.0.0.1.1757719676" },
    ]) {
      const { toolchains, store } = await service(ops, calls, { probeClt: async () => clt });
      await mkdir(path.join(store, "cmake", `4.4.3-${sha12Of(cmake)}`), { recursive: true });
      await writeFile(path.join(store, "cmake", `4.4.3-${sha12Of(cmake)}`, "bin"), Buffer.alloc(1000));
      await writeFile(path.join(store, "current-lock.json"), Buffer.alloc(24));
      const status = await toolchains.status();
      assert.deepEqual(status.clt, clt);
      assert.equal(status.host, ToolchainHost.MacArm64);
      assert.deepEqual(status.installed, [
        { id: ToolchainId.Cmake, version: "4.4.3", sha12: sha12Of(cmake), bytes: 89_000_000 },
      ]);
      assert.deepEqual(status.lock, state.current);
      assert.equal(status.job, null, "no install has run");
      assert.equal(status.storeBytes, 1024, "every file under the store, counted once");
    }
  });

  it("reports the running job while an install is under way, and the finished one after", async () => {
    const { ops, calls } = fakeStore();
    const held = gate();
    const install = ops.installComponents;
    ops.installComponents = async (store, entries, deps) => {
      deps.onJob({
        phase: ToolchainInstallPhase.Downloading,
        entry: ToolchainId.Cmake,
        completed: 10,
        total: 100,
        startedAt: "x",
      });
      held.started.resolve();
      await held.release.promise;
      return install(store, entries, deps);
    };
    const { toolchains } = await service(ops, calls);
    const running = toolchains.install([BuildTarget.Web]);
    await held.started.promise;
    const during = await toolchains.status();
    assert.equal(during.job?.phase, ToolchainInstallPhase.Downloading);
    assert.equal(during.job?.completed, 10);
    held.release.resolve();
    const finished = await running;
    assert.equal(finished.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual((await toolchains.status()).job, finished);
  });
});

describe("ToolchainService.status: prewarm and unhosted parts", () => {
  /** The cpp-game fixture's store (every Browser part installed and prewarmed) under a real service. */
  async function seededService() {
    const store = path.join(await tmpDir("toolchain-prewarm-"), "toolchains");
    await mkdir(store);
    const lock = await seedFixtureToolchainStore(store, { webOutput: fixtureWebOutput() });
    assert.ok(lock);
    const toolchains = new ToolchainService({
      store,
      host: ToolchainHost.MacArm64,
      emit: () => {},
      run: async () => {
        throw new Error("status runs nothing");
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeClt: async () => ({ present: true, version: null }),
    });
    const record = path.join(lockFolder(store, lock), PREWARM_FILE);
    return { toolchains, store, lock, record };
  }

  it(
    "a store whose prewarm.json was written for another recipe reports it stale, and the sheet's Browser needs setting up again",
    POSIX_ONLY,
    async () => {
      const { toolchains, record } = await seededService();
      const fresh = await toolchains.status();
      assert.equal(fresh.prewarm?.[BuildTarget.Web], PrewarmState.Ready);
      assert.deepEqual(missingFor(fresh, [BuildTarget.Web]).prewarm, []);
      const prewarmed = JSON.parse(await readFile(record, "utf8"));
      await writeFile(record, JSON.stringify({ ...prewarmed, recipe: "000000000000" }));
      const stale = await toolchains.status();
      assert.equal(stale.prewarm?.[BuildTarget.Web], PrewarmState.Stale);
      assert.deepEqual(missingFor(stale, [BuildTarget.Web]), {
        clt: false,
        components: [],
        prewarm: [BuildTarget.Web],
      });
    },
  );

  it(
    "a lock folder with no prewarm.json reports it missing; a store with no lock reports nothing",
    POSIX_ONLY,
    async () => {
      const { toolchains, store, record } = await seededService();
      await rm(record);
      assert.equal((await toolchains.status()).prewarm?.[BuildTarget.Web], PrewarmState.Missing);
      await rm(path.join(store, "current-lock.json"));
      assert.equal((await toolchains.status()).prewarm, undefined, "no current lock, no prewarm to judge");
    },
  );

  it(
    "locate says a lock folder prewarmed by an older Genex is stale, and one never prewarmed is not",
    POSIX_ONLY,
    async () => {
      const { toolchains, lock, record } = await seededService();
      const prewarmed = JSON.parse(await readFile(record, "utf8"));
      await writeFile(record, JSON.stringify({ ...prewarmed, recipe: "000000000000" }));
      const stale = await toolchains.locate(lock, [BuildTarget.Web]);
      assert.equal(stale.ok, false);
      assert.deepEqual(stale.ok ? null : [stale.needsPrewarm, stale.stale], [true, true]);
      await rm(record);
      const never = await toolchains.locate(lock, [BuildTarget.Web]);
      assert.deepEqual(never.ok ? null : [never.needsPrewarm, never.stale], [true, undefined]);
    },
  );

  it(
    "an installed store whose first build was never prepared asks to be set up, not installed; an older Genex's asks to be set up again",
    POSIX_ONLY,
    async () => {
      const { toolchains, lock, record } = await seededService();
      const prewarmed = JSON.parse(await readFile(record, "utf8"));
      await rm(record);
      const never = await toolchains.locate(lock, [BuildTarget.Web]);
      assert.equal(never.ok ? null : toolchainRefusal(never), BuildProblemCode.ToolchainUnprepared);
      await writeFile(record, JSON.stringify({ ...prewarmed, recipe: "000000000000" }));
      const stale = await toolchains.locate(lock, [BuildTarget.Web]);
      assert.equal(stale.ok ? null : toolchainRefusal(stale), BuildProblemCode.ToolchainStale);
    },
  );

  it("locate says a missing part Genex has published no download of is not hosted; a downloadable one is only missing", async () => {
    const { ops, calls } = fakeStore({ manifest: LOCAL_ANGLE_MANIFEST });
    let missing: ToolchainId[] = [ToolchainId.AngleMac];
    ops.locateToolchain = async () => ({ ok: false, missing });
    const { toolchains } = await service(ops, calls);
    const lock = ops.lockOf({});
    const angle = await toolchains.locate(lock, [BuildTarget.Mac]);
    assert.equal(angle.ok ? null : angle.notHosted, true);
    missing = [ToolchainId.Cmake, ToolchainId.AngleMac];
    const both = await toolchains.locate(lock, [BuildTarget.Mac]);
    assert.equal(both.ok ? null : both.notHosted, true, "installing the rest still builds no Mac game");
    missing = [ToolchainId.Emsdk];
    const emsdk = await toolchains.locate(lock, [BuildTarget.Web]);
    assert.equal(emsdk.ok ? null : emsdk.notHosted, undefined);
  });

  it("names the local-only parts this computer's destinations need, and none it already holds", async () => {
    const { ops, calls } = fakeStore({ manifest: LOCAL_ANGLE_MANIFEST });
    const { toolchains } = await service(ops, calls);
    assert.deepEqual((await toolchains.status()).unhosted, [
      { id: ToolchainId.AngleMac, reason: ToolchainUnhosted.NotPublished },
    ]);
    const angle = LOCAL_ANGLE_MANIFEST.find((item) => item.id === ToolchainId.AngleMac);
    assert.ok(angle);
    const held = fakeStore({
      manifest: LOCAL_ANGLE_MANIFEST,
      receipts: [receipt(ToolchainId.AngleMac, angle.version, sha12Of(angle), 9_000_000)],
    });
    const holding = await service(held.ops, held.calls);
    assert.deepEqual((await holding.toolchains.status()).unhosted, [], "the developer's store holds it already");
    assert.deepEqual(calls.fetched, [], "status fetches nothing");
  });
});

describe("ToolchainService.install with local-only parts", () => {
  it("a Mac request with unavailable ANGLE still prepares Browser and reports every unfinished destination", async () => {
    const { ops, calls, state } = fakeStore({ manifest: LOCAL_ANGLE_MANIFEST });
    const { toolchains } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Mac]);
    assert.deepEqual(
      [job.phase, job.problem, job.entry, job.unavailable],
      [ToolchainInstallPhase.Installed, undefined, null, [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux]],
    );
    assert.deepEqual(calls.fetched, [], "never fetched");
    assert.deepEqual(calls.installed, [[...REQUIRED_COMPONENTS[BuildTarget.Web]]], "Browser still installs");
    assert.ok(state.current?.entries[ToolchainId.Emsdk], "Browser's lock is committed");
    calls.installed.length = 0;
    const both = await toolchains.install([BuildTarget.Web, BuildTarget.Mac]);
    assert.deepEqual(
      [both.phase, both.unavailable],
      [ToolchainInstallPhase.Installed, [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux]],
    );
    assert.deepEqual(calls.installed, [[...REQUIRED_COMPONENTS[BuildTarget.Web]]], "Browser's parts only");
  });

  it("an install for the Mac whose local ANGLE the store already holds sets it up again, fetching nothing", async () => {
    const receipts = REQUIRED_COMPONENTS[BuildTarget.Mac].map((id) => {
      const item = LOCAL_ANGLE_MANIFEST.find((candidate) => candidate.id === id);
      assert.ok(item, id);
      return receipt(id, item.version, sha12Of(item), 1000);
    });
    const { ops, calls, state } = fakeStore({ manifest: LOCAL_ANGLE_MANIFEST, receipts });
    const { toolchains } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Mac]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    assert.deepEqual(job.unavailable, [BuildTarget.Windows, BuildTarget.Linux]);
    assert.deepEqual(
      [calls.fetched, calls.installed],
      [[], [[ToolchainId.Emsdk]]],
      "only Browser's missing part installs",
    );
    assert.ok(state.current?.entries[ToolchainId.AngleMac], "the lock names the local ANGLE");
  });
});

describe("ToolchainService.install", () => {
  it("installs every available destination, prewarms, writes the current lock and emits every phase in order", async () => {
    const { ops, calls, state } = fakeStore();
    const { toolchains, emitted } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Web]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(calls.installed, [
      [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource, ToolchainId.AngleMac],
    ]);
    assert.deepEqual(phases(emitted), [
      ToolchainInstallPhase.Preflight,
      ToolchainInstallPhase.Downloading,
      ToolchainInstallPhase.Verifying,
      ToolchainInstallPhase.Extracting,
      ToolchainInstallPhase.Probing,
      ToolchainInstallPhase.Prewarming,
      ToolchainInstallPhase.Installed,
    ]);
    assert.deepEqual(emitted.at(-1), job, "the last announcement is the finished job");
    assert.equal(job.startedAt, new Date(NOW).toISOString());
    assert.equal(job.finishedAt, new Date(NOW).toISOString());
    assert.deepEqual(
      Object.keys(state.current?.entries ?? {}),
      [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource, ToolchainId.AngleMac],
      "the current lock names what was installed",
    );
    assert.deepEqual(
      calls.prewarmed.map((call) => [call.lock, call.targets]),
      [[state.current, PREWARMED_TARGETS.filter((target) => target === BuildTarget.Web || target === BuildTarget.Mac)]],
    );
    assert.deepEqual(calls.fetched, [], "the fake substrate fetched nothing itself");
  });

  it("the complete setup skips what is already installed at the pinned version", async () => {
    const cmake = MANIFEST[0];
    assert.ok(cmake);
    const { ops, calls, state } = fakeStore({
      receipts: [receipt(ToolchainId.Cmake, "4.4.3", sha12Of(cmake), 1)],
    });
    const { toolchains } = await service(ops, calls);
    await toolchains.install();
    assert.deepEqual(calls.installed, [
      [ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource, ToolchainId.AngleMac],
    ]);
    // Flipped (the Mac lane): an Apple silicon Mac prewarms its own outputs beside Browser's.
    assert.deepEqual(
      calls.prewarmed[0]?.targets,
      PREWARMED_TARGETS.filter((target) => target === BuildTarget.Web || target === BuildTarget.Mac),
      "Browser's lock outputs, and the Mac's where this computer prewarms them",
    );
    assert.deepEqual(Object.keys(state.current?.entries ?? {}), [
      ToolchainId.Cmake,
      ToolchainId.Ninja,
      ToolchainId.Emsdk,
      ToolchainId.RaylibSource,
      ToolchainId.AngleMac,
    ]);
  });

  it("prewarms only what the new lock can build and is not prewarmed yet", async () => {
    const macOnly = fakeStore();
    const mac = await service(macOnly.ops, macOnly.calls);
    assert.equal((await mac.toolchains.install([BuildTarget.Mac])).phase, ToolchainInstallPhase.Installed);
    // Even a Mac-only game prepares the Browser judge and every available host destination.
    const macPrewarmed = PREWARMED_TARGETS.includes(BuildTarget.Mac);
    assert.deepEqual(
      macOnly.calls.prewarmed.map((call) => call.targets),
      macPrewarmed ? [[BuildTarget.Web, BuildTarget.Mac]] : [[BuildTarget.Web]],
      "a Mac request prepares Browser too",
    );
    assert.ok(macOnly.state.current?.entries[ToolchainId.AngleMac], "its lock is still written");
    assert.equal(
      phases(mac.emitted).includes(ToolchainInstallPhase.Prewarming),
      true,
      "Browser still prewarms when this runner cannot prepare the native Mac outputs",
    );

    const warm = fakeStore();
    const located: Array<readonly BuildTarget[]> = [];
    warm.ops.locateToolchain = async (_store, lock, targets) => {
      located.push(targets);
      return { ok: true, toolchain: { lock, cmake: "", ninja: "", emscripten: null, genexCmake: {} } };
    };
    const again = await service(warm.ops, warm.calls);
    assert.equal((await again.toolchains.install([BuildTarget.Web])).phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(located, [
      PREWARMED_TARGETS.filter((target) => target === BuildTarget.Web || target === BuildTarget.Mac),
    ]);
    assert.deepEqual(warm.calls.prewarmed, [], "a lock whose outputs are already there is not prewarmed again");
  });

  it("a second install joins the running job: the substrate installs once", async () => {
    const { ops, calls } = fakeStore();
    const held = gate();
    const install = ops.installComponents;
    ops.installComponents = async (store, entries, deps) => {
      held.started.resolve();
      await held.release.promise;
      return install(store, entries, deps);
    };
    const { toolchains, emitted } = await service(ops, calls);
    const first = toolchains.install([BuildTarget.Web]);
    await held.started.promise;
    const second = toolchains.install([BuildTarget.Web, BuildTarget.Mac]);
    held.release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls.installed.length, 1, "one install ran");
    assert.equal(phases(emitted).filter((phase) => phase === ToolchainInstallPhase.Preflight).length, 1);
    // Once it has finished, Try again starts a new job.
    await toolchains.install([BuildTarget.Web]);
    assert.equal(calls.installed.length, 2);
  });
});

describe("ToolchainService.install failures", () => {
  it("an unpinned shared compiler tool refuses the complete setup before any fetch or write", async () => {
    const manifest = MANIFEST.map((item) =>
      item.id === ToolchainId.Cmake ? entry(item.id, item.version, false) : item,
    );
    const { ops, calls, state } = fakeStore({ manifest });
    const { toolchains, emitted } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Mac]);
    assert.deepEqual(
      [job.phase, job.problem, job.entry],
      [ToolchainInstallPhase.Failed, ToolchainProblem.Unpinned, ToolchainId.Cmake],
    );
    assert.deepEqual(calls.fetched, []);
    assert.deepEqual(calls.installed, []);
    assert.deepEqual(calls.prewarmed, []);
    assert.equal(state.current, null);
    assert.deepEqual(phases(emitted), [ToolchainInstallPhase.Preflight, ToolchainInstallPhase.Failed]);
  });

  /**
   * A destination installs once every component it needs is pinned; one that is not yet waits,
   * named, and never holds back the others. A game made for Browser and Mac gets its Browser
   * tools while ANGLE for Mac has no pin.
   */
  it("installs the destinations that are pinned and names the rest unavailable", async () => {
    const unpinned = MANIFEST.map((item) =>
      item.id === ToolchainId.AngleMac ? entry(ToolchainId.AngleMac, "c5bf49e78850", false) : item,
    );
    for (const targets of [[BuildTarget.Web, BuildTarget.Mac], undefined]) {
      const { ops, calls, state } = fakeStore({ manifest: unpinned });
      const { toolchains } = await service(ops, calls);
      const job = await toolchains.install(targets);
      assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(targets));
      assert.deepEqual(job.unavailable, [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux]);
      assert.deepEqual(calls.installed, [[...REQUIRED_COMPONENTS[BuildTarget.Web]]], "Browser's components");
      assert.deepEqual(
        Object.keys(state.current?.entries ?? {}).sort(),
        [...REQUIRED_COMPONENTS[BuildTarget.Web]].sort(),
      );
    }
  });

  it("a computer with no pinned toolchain fails unsupported-host and runs nothing", async () => {
    const { ops, calls } = fakeStore();
    const { toolchains } = await service(ops, calls, { host: null });
    const job = await toolchains.install([BuildTarget.Web]);
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(job.problem, ToolchainProblem.UnsupportedHost);
    assert.deepEqual(calls.installed, []);
  });

  it("a substrate failure ends the job failed with its typed problem, and writes no lock", async () => {
    const rows = [
      { name: "integrity at install", where: "install", problem: ToolchainProblem.Integrity },
      { name: "a failed prewarm", where: "prewarm", problem: ToolchainProblem.Prewarm },
    ] as const;
    for (const row of rows) {
      const { ops, calls, state } = fakeStore();
      const failure = new ToolchainError(row.problem, "fake failure");
      if (row.where === "install")
        ops.installComponents = async () => {
          throw failure;
        };
      else
        ops.prewarm = async () => {
          throw failure;
        };
      const { toolchains, emitted, store } = await service(ops, calls);
      const job = await toolchains.install([BuildTarget.Web]);
      assert.equal(job.phase, ToolchainInstallPhase.Failed, row.name);
      assert.equal(job.problem, row.problem, row.name);
      assert.equal(state.current, null, `${row.name}: no lock written`);
      assert.equal(emitted.at(-1)?.phase, ToolchainInstallPhase.Failed, row.name);
      assert.ok(await absent(path.join(store, ".staging")), `${row.name}: no staging left`);
    }
  });
});

describe("ToolchainService prewarm sandbox", () => {
  /** A fake prewarm that runs one command through what it is given, as the real one runs each step. */
  function recordingPrewarm(ops: ToolchainStoreOps, calls: Calls, given: Array<readonly string[]>): void {
    ops.prewarm = async (store, lock, targets, deps) => {
      given.push(deps.denyWrite);
      await deps.run({ command: "true", cwd: store, label: "prewarm:raylib-configure" });
      calls.prewarmed.push({ lock, targets });
      return { lock: lock.digest, recipe: "recipe12", outputs: [], at: new Date(NOW).toISOString() };
    };
  }

  it("prewarm runs in its own sandbox, never the core's, with the games root, scratch and runs denied, and lets it go after", async () => {
    const { ops, calls } = fakeStore();
    const given: Array<readonly string[]> = [];
    recordingPrewarm(ops, calls, given);
    const { toolchains, sandboxes } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Web]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    assert.deepEqual(given, [PREWARM_DENY], "the deny list reaches prewarm as given");
    assert.equal(sandboxes.length, 1, "one sandbox for the one prewarm");
    assert.deepEqual(
      sandboxes[0]?.runs.map((request) => request.label),
      ["prewarm:raylib-configure"],
      "the prewarm's command ran in it",
    );
    assert.equal(sandboxes[0]?.disposed, true, "and it was let go");
  });

  it("a release build prewarms and locates with the headless platform its resources ship; source and developer builds with the checkout's", async () => {
    const resources = await tmpDir("packaged-resources-");
    const shipped = path.join(resources, "native", "raylib-platform", "rcore_genex_headless.c");
    const rows: Array<{ releaseBuild?: boolean; expected: string | undefined }> = [
      { releaseBuild: true, expected: shipped },
      { releaseBuild: false, expected: undefined },
      { expected: undefined },
    ];
    for (const row of rows) {
      const { ops, calls } = fakeStore();
      const located: Array<string | undefined> = [];
      const prewarmed: Array<string | undefined> = [];
      ops.locateToolchain = async (_store, _lock, _targets, options) => {
        located.push(options?.headlessPlatform);
        return { ok: false, missing: [], needsPrewarm: true };
      };
      ops.prewarm = async (_store, lock, targets, deps) => {
        prewarmed.push(deps.headlessPlatform);
        calls.prewarmed.push({ lock, targets });
        return { lock: lock.digest, recipe: "recipe12", outputs: [], at: new Date(NOW).toISOString() };
      };
      const { toolchains } = await service(ops, calls, { resources, releaseBuild: row.releaseBuild });
      const job = await toolchains.install([BuildTarget.Web, BuildTarget.Mac]);
      assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
      const lock = await toolchains.currentLock();
      assert.ok(lock);
      await toolchains.locate(lock, [BuildTarget.Mac]);
      await toolchains.status();
      const label = JSON.stringify(row);
      assert.deepEqual(prewarmed, [row.expected], label);
      assert.ok(located.length >= 3, label);
      assert.deepEqual(new Set(located), new Set([row.expected]), label);
    }
  });

  it("a failed prewarm lets its sandbox go too", async () => {
    const { ops, calls } = fakeStore();
    ops.prewarm = async () => {
      throw new ToolchainError(ToolchainProblem.Prewarm, "fake failure");
    };
    const { toolchains, sandboxes } = await service(ops, calls);
    const job = await toolchains.install([BuildTarget.Web]);
    assert.equal(job.problem, ToolchainProblem.Prewarm);
    assert.deepEqual(
      sandboxes.map((box) => box.disposed),
      [true],
    );
  });

  it("refuses to prewarm, running nothing and writing no lock, without its sandbox or a deny list", async () => {
    const rows: Array<{ name: string; overrides: Partial<ToolchainServiceOptions> }> = [
      { name: "no prewarm sandbox", overrides: { prewarmSandbox: undefined } },
      { name: "an empty deny list", overrides: { prewarmDenyWrite: [] } },
      { name: "no deny list", overrides: { prewarmDenyWrite: undefined } },
    ];
    for (const row of rows) {
      const { ops, calls, state } = fakeStore();
      const { toolchains, sandboxes, store } = await service(ops, calls, row.overrides);
      const job = await toolchains.install([BuildTarget.Web]);
      assert.equal(job.phase, ToolchainInstallPhase.Failed, row.name);
      assert.equal(job.problem, ToolchainProblem.Prewarm, row.name);
      assert.deepEqual(calls.prewarmed, [], `${row.name}: nothing prewarmed`);
      assert.deepEqual(sandboxes, [], `${row.name}: no sandbox was made`);
      assert.equal(state.current, null, `${row.name}: no lock written`);
      assert.ok(await absent(path.join(store, ".staging")), `${row.name}: no staging left`);
    }
  });
});

describe("ToolchainService prewarm under the real sandboxes", () => {
  it(
    "prewarm writes its staging and nothing else, which the core's sandbox cannot write at all",
    POSIX_ONLY,
    async () => {
      const root = await realpath(await tmpDir("toolchain-prewarm-real-"));
      const layout = {
        store: path.join(root, "toolchains"),
        games: path.join(root, "workspaces", "games"),
        scratch: path.join(root, "scratch"),
        runs: path.join(root, "runs"),
      };
      for (const dir of Object.values(layout)) await mkdir(dir, { recursive: true });
      await mkdir(path.join(layout.store, ToolchainId.Cmake));
      // The core's sandbox as studio-core builds it: the games root and runs writable, the store denied.
      const core = await ProcessSandbox.create({
        writableRoots: [layout.games, layout.runs],
        scratchDir: layout.scratch,
        secretPaths: [],
        denyWrite: [layout.store],
      });
      after(() => core.dispose());
      const escapes = [
        path.join(layout.games, "evil"),
        path.join(layout.scratch, "evil"),
        path.join(layout.runs, "evil"),
        path.join(layout.store, ToolchainId.Cmake, "evil"),
        path.join(layout.store, "current-lock.json"),
      ];
      const quote = (value: string) => `'${value}'`;
      /** One command that writes the staging folder, then tries every folder prewarm must never write. */
      const writes = (staging: string) =>
        [
          `echo ok > ${quote(path.join(staging, "probe"))} && echo staging-ok`,
          ...escapes.map((file, index) => `echo x > ${quote(file)} && echo escaped-${index}`),
          "true",
        ].join("; ");
      const outcomes: RunResult[] = [];
      const { ops, calls } = fakeStore();
      // The real prewarm's shape: it stages `.staging/<lock>`, then runs each command under the overlay that opens only it.
      ops.prewarm = async (store, lock, _targets, deps) => {
        const staging = path.join(store, ".staging", lock.digest);
        await mkdir(staging, { recursive: true });
        const policy = prewarmPolicy(store, lock.digest, deps.denyWrite);
        const outcome = await deps.run({ command: writes(staging), cwd: staging, policy, label: "prewarm:probe" });
        outcomes.push(outcome);
        if (!outcome.stdout.includes("staging-ok")) throw new ToolchainError(ToolchainProblem.Prewarm, outcome.stderr);
        return { lock: lock.digest, recipe: "recipe12", outputs: [], at: new Date(NOW).toISOString() };
      };
      const toolchains = new ToolchainService({
        store: layout.store,
        host: ToolchainHost.MacArm64,
        emit: () => {},
        run: (request) => core.run(request),
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        probeClt: async () => ({ present: true, version: null }),
        ops,
        prewarmSandbox: () =>
          createPrewarmSandbox({ scratchDir: path.join(layout.scratch, "toolchain-prewarm"), secretPaths: [] }),
        prewarmDenyWrite: [layout.games, layout.scratch, layout.runs],
        now: () => NOW,
      });
      const job = await toolchains.install([BuildTarget.Web]);
      assert.equal(job.phase, ToolchainInstallPhase.Installed, outcomes.map((outcome) => outcome.stderr).join("\n"));
      assert.equal(outcomes[0]?.sandboxed, true);
      assert.deepEqual(outcomes[0]?.stdout.trim().split("\n"), ["staging-ok"], outcomes[0]?.stderr);
      assert.equal(calls.fetched.length, 0);
      for (const file of escapes) assert.equal(existsSync(file), false, `${file} was not written`);

      // Why prewarm has a sandbox of its own: the core's denies the store, and an overlay never lifts a deny.
      const lock = ops.lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "0c5d65251c14" } });
      const staging = path.join(layout.store, ".staging", lock.digest);
      await mkdir(staging, { recursive: true });
      const blocked = await core.run({
        command: writes(staging),
        cwd: staging,
        policy: prewarmPolicy(layout.store, lock.digest, [layout.games, layout.scratch, layout.runs]),
      });
      assert.equal(blocked.sandboxed, true);
      assert.deepEqual(blocked.stdout.trim().split("\n").filter(Boolean), [], blocked.stderr);
    },
  );
});

describe("ToolchainService.cancel", () => {
  /** Stages a partial download (or prewarm), then waits for the abort as the real substrate does. */
  const aborts = {
    throws: async (store: string, signal: AbortSignal | undefined, name: string, started: () => void) => {
      await mkdir(path.join(store, ".staging", name), { recursive: true });
      await writeFile(path.join(store, ".staging", name, "partial.bin"), "half");
      started();
      await new Promise<void>((_, reject) => {
        const aborted = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) aborted();
        signal?.addEventListener("abort", aborted, { once: true });
      });
    },
  };
  const rows: Array<{ name: string; stage: (ops: ToolchainStoreOps, started: () => void) => void }> = [
    {
      name: "during a download that throws on abort",
      stage: (ops, started) => {
        ops.installComponents = async (store, _entries, deps: InstallDeps) => {
          await aborts.throws(store, deps.signal, "cmake-abc", started);
          throw new Error("unreachable");
        };
      },
    },
    {
      name: "during a download that answers a cancelled job",
      stage: (ops, started) => {
        ops.installComponents = async (store, _entries, deps: InstallDeps) => {
          await aborts.throws(store, deps.signal, "cmake-abc", started).catch(() => {});
          return { phase: ToolchainInstallPhase.Cancelled, entry: null, completed: 0, total: 1, startedAt: "x" };
        };
      },
    },
    {
      name: "during prewarm",
      stage: (ops, started) => {
        ops.prewarm = async (store, lock, _targets, deps) => {
          await aborts.throws(store, deps.signal, lock.digest, started);
          throw new Error("unreachable");
        };
      },
    },
  ];
  for (const row of rows) {
    it(`ends the job cancelled and leaves no staging dir: ${row.name}`, async () => {
      const { ops, calls, state } = fakeStore();
      const started = deferred();
      row.stage(ops, () => started.resolve());
      const { toolchains, emitted, store } = await service(ops, calls);
      const running = toolchains.install([BuildTarget.Web]);
      await started.promise;
      assert.equal(await toolchains.cancel(), true);
      const job = await running;
      assert.equal(job.phase, ToolchainInstallPhase.Cancelled);
      assert.equal(emitted.at(-1)?.phase, ToolchainInstallPhase.Cancelled);
      assert.ok(await absent(path.join(store, ".staging")), "no staging dir is left");
      assert.equal(state.current, null, "a cancelled install writes no lock");
      assert.equal(RUNNING.has((await toolchains.status()).job?.phase ?? ""), false);
    });
  }

  it("answers false when no install runs", async () => {
    const { ops, calls } = fakeStore();
    const { toolchains, emitted } = await service(ops, calls);
    assert.equal(await toolchains.cancel(), false);
    assert.deepEqual(emitted, []);
  });
});

describe("ToolchainService.prune", () => {
  const cmake = MANIFEST[0];
  assert.ok(cmake);
  const current = (ops: ToolchainStoreOps) =>
    ops.lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: sha12Of(cmake) } });

  it("keeps every version the current lock and every game's lock name", async () => {
    const { ops, calls, state } = fakeStore();
    state.current = current(ops);
    const { toolchains } = await service(ops, calls);
    const lock = state.current;
    assert.deepEqual(await toolchains.prune([lock.digest, lock.digest]), { removed: 1, bytes: 4096 });
    // Flipped: the crate checker's current pins are kept too (they are in no lock).
    assert.deepEqual(
      [...(calls.pruned[0] ?? [])],
      [`cmake/4.4.3-${sha12Of(cmake)}`, ...crateCheckFolders(ToolchainHost.MacArm64)],
    );
  });

  it("removes nothing when it cannot know what a game needs, and says why", async () => {
    const rows: Array<{
      name: string;
      refused: ToolchainPruneRefusal;
      prepare: (ctx: {
        ops: ToolchainStoreOps;
        state: { current: ToolchainLock | null };
      }) => readonly string[] | undefined;
    }> = [
      { name: "no current lock yet", refused: ToolchainPruneRefusal.NoLock, prepare: () => [] },
      {
        name: "a game built with an older lock the store cannot read",
        refused: ToolchainPruneRefusal.UnknownGameLock,
        prepare: ({ ops, state }) => {
          state.current = current(ops);
          return [sha("an older lock")];
        },
      },
      {
        name: "nobody said which locks the games hold",
        refused: ToolchainPruneRefusal.UnknownGameLock,
        prepare: ({ ops, state }) => {
          state.current = current(ops);
          return undefined;
        },
      },
    ];
    for (const row of rows) {
      const { ops, calls, state } = fakeStore();
      const { toolchains } = await service(ops, calls);
      const games = row.prepare({ ops, state });
      assert.deepEqual(await toolchains.prune(games), { removed: 0, bytes: 0, refused: row.refused }, row.name);
      assert.deepEqual(calls.pruned, [], `${row.name}: the store was not pruned`);
    }
  });

  it("prunes a person's own store through a link like any folder", async () => {
    const linked = fakeStore();
    linked.state.current = current(linked.ops);
    const target = await tmpDir("toolchain-other-disk-");
    const parent = await tmpDir("toolchain-link-");
    const store = path.join(parent, "toolchains");
    await symlink(target, store);
    const { toolchains } = await service(linked.ops, linked.calls, { store });
    assert.deepEqual(await toolchains.prune([]), { removed: 1, bytes: 4096 });
    assert.equal(linked.calls.pruned.length, 1);
  });

  it("removes nothing while an install or another prune runs", async () => {
    const busy = fakeStore();
    busy.state.current = current(busy.ops);
    const held = gate();
    busy.ops.installComponents = async () => {
      held.started.resolve();
      await held.release.promise;
      throw new ToolchainError(ToolchainProblem.Download, "stop");
    };
    const running = await service(busy.ops, busy.calls);
    const job = running.toolchains.install([BuildTarget.Web]);
    await held.started.promise;
    const busyAnswer = { removed: 0, bytes: 0, refused: ToolchainPruneRefusal.Busy };
    assert.deepEqual(await running.toolchains.prune([]), busyAnswer);
    assert.deepEqual(busy.calls.pruned, [], "nothing is pruned under a running install");
    held.release.resolve();
    await job;

    const twice = fakeStore();
    twice.state.current = current(twice.ops);
    const pruning = gate();
    const prune = twice.ops.pruneStore;
    twice.ops.pruneStore = async (store, keep) => {
      pruning.started.resolve();
      await pruning.release.promise;
      return prune(store, keep);
    };
    const one = await service(twice.ops, twice.calls);
    const first = one.toolchains.prune([]);
    await pruning.started.promise;
    assert.deepEqual(
      await one.toolchains.prune([]),
      busyAnswer,
      "a second prune waits for nothing and removes nothing",
    );
    pruning.release.resolve();
    assert.deepEqual(await first, { removed: 1, bytes: 4096 });
  });
});

describe("ToolchainService.plan", () => {
  it("lists this computer's pinned downloads with their sizes, and the store disk's free bytes", async () => {
    const manifest = [
      ...MANIFEST.map((item) =>
        item.id === ToolchainId.RaylibSource ? entry(ToolchainId.RaylibSource, "6.0", false) : item,
      ),
      { ...entry(ToolchainId.Zig, "0.16.0"), host: ToolchainHost.LinuxX64 },
      { ...entry(ToolchainId.AngleWindows, "c5bf49e78850"), host: null, target: BuildTarget.Windows },
    ];
    const { ops, calls } = fakeStore({ manifest });
    const { toolchains } = await service(ops, calls);
    const plan = await toolchains.plan();
    assert.deepEqual(
      plan.downloads.map(({ id, version, bytes }) => ({ id, version, bytes })),
      [
        { id: ToolchainId.Cmake, version: "4.4.3", bytes: 1000 },
        { id: ToolchainId.Ninja, version: "1.13.2", bytes: 1000 },
        { id: ToolchainId.Emsdk, version: "6.0.10", bytes: 3000 },
        { id: ToolchainId.AngleMac, version: "c5bf49e78850", bytes: 1000 },
        { id: ToolchainId.AngleWindows, version: "c5bf49e78850", bytes: 1000 },
      ],
    );
    assert.equal(plan.freeBytes, 40 * GB);
    const unknown = await service(ops, calls, {
      host: null,
      freeBytes: async () => Promise.reject(new Error("no disk")),
    });
    const none = await unknown.toolchains.plan();
    assert.deepEqual([none.downloads, none.freeBytes], [[], null]);
  });
});

describe("the Toolchain sheet's rules", () => {
  const WEB: readonly ToolchainId[] = REQUIRED_COMPONENTS[BuildTarget.Web];
  const PIN = { version: "1.0", sha12: "aaaaaaaaaaaa" };

  /** A status: Apple's tools present, nothing installed, no lock and no job, unless the row says otherwise. */
  function sheetStatus(overrides: Partial<ToolchainStatus> = {}): ToolchainStatus {
    return {
      host: ToolchainHost.MacArm64,
      clt: { present: true, version: null },
      installed: [],
      lock: null,
      job: null,
      storeBytes: 0,
      ...overrides,
    };
  }
  const installed = (ids: readonly ToolchainId[]) => ids.map((id) => ({ id, ...PIN, bytes: 1 }));
  function lockNaming(ids: readonly ToolchainId[]): ToolchainLock {
    const entries: ToolchainLock["entries"] = {};
    for (const id of ids) entries[id] = PIN;
    return { version: 1, entries, digest: sha(ids.join(",")) };
  }
  const ended = (phase: ToolchainInstallPhase, problem?: ToolchainProblem): ToolchainInstallJob => ({
    phase,
    entry: null,
    completed: 0,
    total: 0,
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    ...(problem ? { problem } : {}),
  });

  it("a first install whose prewarm failed is not ready, and Try again works", () => {
    const failed = ended(ToolchainInstallPhase.Failed, ToolchainProblem.Prewarm);
    const view = sheetView(sheetStatus({ installed: installed(WEB), job: failed }), failed, [BuildTarget.Web]);
    assert.deepEqual(view.components, [], "every component is on disk");
    assert.equal(view.ready, false, "but no lock names them, so no build can locate them");
    assert.equal(view.canInstall, true);
    assert.equal(view.retry, true);
  });

  it("a lock that does not name a destination's component is not ready, even with that component on disk", () => {
    const status = sheetStatus({ installed: installed([...WEB, ToolchainId.AngleMac]), lock: lockNaming(WEB) });
    const view = sheetView(status, null, [BuildTarget.Web, BuildTarget.Mac]);
    assert.equal(view.ready, false);
    assert.equal(view.canInstall, true);
    assert.equal(view.retry, false);
  });

  it("is ready once the current lock names every component at the installed pins", () => {
    const view = sheetView(sheetStatus({ installed: installed(WEB), lock: lockNaming(WEB) }), null, [BuildTarget.Web]);
    assert.equal(view.ready, true);
    assert.equal(view.canInstall, false);
  });

  it("starts nothing while a job runs or where no toolchain is pinned, and Apple's tools are no reason to install", () => {
    const running = { ...ended(ToolchainInstallPhase.Downloading), finishedAt: undefined };
    assert.equal(sheetView(sheetStatus(), running, [BuildTarget.Web]).canInstall, false, "a job runs");
    assert.equal(sheetView(sheetStatus({ host: null }), null, [BuildTarget.Web]).canInstall, false, "no host");
    const mac = [...WEB, ToolchainId.AngleMac];
    const noClt = sheetStatus({
      clt: { present: false, version: null },
      installed: installed(mac),
      lock: lockNaming(mac),
    });
    const view = sheetView(noClt, null, [BuildTarget.Mac]);
    assert.deepEqual([view.cltMissing, view.ready, view.canInstall], [true, false, false]);
    const needsMacBuild = { ...noClt, prewarm: { [BuildTarget.Mac]: PrewarmState.Missing } };
    assert.equal(
      sheetView(needsMacBuild, null, [BuildTarget.Mac]).canInstall,
      false,
      "preparing Mac waits for the separate Apple prerequisite",
    );
    assert.equal(
      sheetView(
        { ...needsMacBuild, prewarm: { ...needsMacBuild.prewarm, [BuildTarget.Web]: PrewarmState.Stale } },
        null,
        [BuildTarget.Web, BuildTarget.Mac],
      ).canInstall,
      true,
      "Browser preparation can still run while Mac waits",
    );
  });

  /**
   * A component with no pin has no download: Install would only end failed/unpinned, so the sheet
   * says so beside it, never offers Install for it alone, and counts no disk for it.
   */
  it("marks a component with no download unavailable, and offers Install only for a destination that can install", () => {
    const pinned = (ids: readonly ToolchainId[]) =>
      ids.map((id) => ({ id, version: "1.0", bytes: 1000, diskBytes: 8000 }));
    const raylibUnpinned = WEB.filter((id) => id !== ToolchainId.RaylibSource);
    const web = sheetView(
      sheetStatus({ downloads: pinned(raylibUnpinned), freeBytes: 10_000_000, reserveBytes: 5 }),
      null,
      [BuildTarget.Web],
    );
    assert.deepEqual(web.unavailable, [ToolchainId.RaylibSource]);
    assert.equal(web.canInstall, false, "Browser cannot install without raylib");
    const mac = sheetView(sheetStatus({ downloads: pinned(WEB), freeBytes: 10_000_000, reserveBytes: 5 }), null, [
      BuildTarget.Web,
      BuildTarget.Mac,
    ]);
    assert.deepEqual(mac.unavailable, [ToolchainId.AngleMac]);
    assert.equal(mac.canInstall, true, "Browser installs; Mac waits for its pin");
    assert.equal(mac.need, 4 * 8000 + 5, "the disk counts the downloads, never the unpinned one");
    const after = sheetView(
      sheetStatus({ downloads: pinned(WEB), installed: installed(WEB), lock: lockNaming(WEB) }),
      null,
      [BuildTarget.Web, BuildTarget.Mac],
    );
    assert.deepEqual(
      [after.unavailable, after.canInstall],
      [[ToolchainId.AngleMac], false],
      "Browser's are in: nothing left to install",
    );
    const nothing = sheetView(sheetStatus({ downloads: [], freeBytes: 10_000_000, reserveBytes: 5 }), null, [
      BuildTarget.Web,
    ]);
    assert.equal(nothing.disk, null, "no disk line for the reserve alone");
    assert.equal(nothing.canInstall, false);
  });

  it("offers Set up again for a destination whose tools are in but whose first build is stale or missing", () => {
    for (const state of [PrewarmState.Stale, PrewarmState.Missing]) {
      const status = sheetStatus({
        installed: installed(WEB),
        lock: lockNaming(WEB),
        prewarm: { [BuildTarget.Web]: state },
      });
      const view = sheetView(status, null, [BuildTarget.Web]);
      assert.deepEqual(view.prewarm, [{ target: BuildTarget.Web, state }], state);
      assert.deepEqual([view.ready, view.canInstall, view.setUpAgain], [false, true, true], state);
      assert.deepEqual(view.components, [], `${state}: nothing to download`);
    }
    const ready = sheetStatus({
      installed: installed(WEB),
      lock: lockNaming(WEB),
      prewarm: { [BuildTarget.Web]: PrewarmState.Ready },
    });
    const view = sheetView(ready, null, [BuildTarget.Web]);
    assert.deepEqual([view.prewarm, view.ready, view.canInstall, view.setUpAgain], [[], true, false, false]);
    const macToo = sheetStatus({
      installed: installed(WEB),
      lock: lockNaming(WEB),
      prewarm: { [BuildTarget.Web]: PrewarmState.Stale },
      unhosted: [{ id: ToolchainId.AngleMac, reason: ToolchainUnhosted.NotPublished }],
    });
    const both = sheetView(macToo, null, [BuildTarget.Web, BuildTarget.Mac]);
    assert.deepEqual(
      [both.unavailable, both.canInstall, both.setUpAgain],
      [[ToolchainId.AngleMac], true, true],
      "nothing it lacks can be downloaded: Install only sets Browser up again",
    );
    const running = { ...ended(ToolchainInstallPhase.Prewarming), finishedAt: undefined };
    const stale = sheetStatus({
      installed: installed(WEB),
      lock: lockNaming(WEB),
      prewarm: { [BuildTarget.Web]: PrewarmState.Stale },
    });
    assert.equal(sheetView(stale, running, [BuildTarget.Web]).canInstall, false, "not while a job runs");
  });

  it("says a part Genex has not published is not available yet, and why, instead of a size", () => {
    const downloads = WEB.map((id) => ({ id, version: "1.0", bytes: 1000, diskBytes: 8000 }));
    const status = sheetStatus({
      downloads,
      freeBytes: 10_000_000,
      reserveBytes: 5,
      unhosted: [{ id: ToolchainId.AngleMac, reason: ToolchainUnhosted.NotPublished }],
    });
    const view = sheetView(status, null, [BuildTarget.Web, BuildTarget.Mac]);
    const angle = view.rows.find((row) => row.id === ToolchainId.AngleMac);
    assert.deepEqual(angle, { id: ToolchainId.AngleMac, download: null, unhosted: ToolchainUnhosted.NotPublished });
    assert.deepEqual(view.unavailable, [ToolchainId.AngleMac]);
    assert.equal(view.unpinned, 0, "not counted as a tool with no pin");
    assert.equal(view.need, 4 * 8000 + 5, "the disk counts the downloads only");
    const cmake = view.rows.find((row) => row.id === ToolchainId.Cmake);
    assert.deepEqual(cmake, { id: ToolchainId.Cmake, download: downloads[0], unhosted: null });
    const unpinned = sheetView(sheetStatus({ downloads: downloads.slice(1) }), null, [BuildTarget.Web]);
    assert.deepEqual(
      [unpinned.rows[0], unpinned.unpinned],
      [{ id: ToolchainId.Cmake, download: null, unhosted: null }, 1],
      "a part with no pin keeps the unpinned reason",
    );
  });

  it("Settings lists the parts this computer's own games need with no download yet, not another OS's", () => {
    const unhosted = [
      { id: ToolchainId.AngleMac, reason: ToolchainUnhosted.NotPublished },
      { id: ToolchainId.AngleWindows, reason: ToolchainUnhosted.NotPublished },
    ];
    const status = sheetStatus({ unhosted });
    assert.deepEqual(unhostedHere(status, StudioPlatform.Mac), [unhosted[0]], "the Mac's");
    assert.deepEqual(unhostedHere(status, StudioPlatform.Windows), [unhosted[1]], "Windows' own");
    assert.deepEqual(unhostedHere(status, null), [], "Browser needs none of them");
    assert.deepEqual(unhostedHere(sheetStatus(), StudioPlatform.Mac), []);
  });

  it("asks for the disk space the install itself checks for, not just the download sizes", async () => {
    const manifest = WEB.map((id, index) => entry(id, `1.${index}`));
    const { ops, calls } = fakeStore({ manifest });
    const { toolchains } = await service(ops, calls);
    const view = sheetView(sheetStatus(await toolchains.plan()), null, [BuildTarget.Web]);
    assert.deepEqual(view.components, WEB);
    const rows = [
      { free: view.need - 1, problem: ToolchainProblem.DiskSpace },
      { free: view.need, problem: ToolchainProblem.Download },
    ];
    for (const row of rows) {
      const fetched: string[] = [];
      const job = await installComponents(await tmpDir("toolchain-disk-"), manifest, {
        fetch: async (url) => {
          fetched.push(url);
          throw new Error("no network in these rows");
        },
        run: async () => {
          throw new Error("nothing is probed in these rows");
        },
        freeBytes: async () => row.free,
        onJob: () => {},
      });
      assert.equal(job.problem, row.problem, `${row.free} bytes free, the sheet said ${view.need} are needed`);
      assert.equal(fetched.length, row.problem === ToolchainProblem.DiskSpace ? 0 : 1);
    }
  });
});

describe("ToolchainService.installClt", () => {
  it("runs exactly /usr/bin/xcode-select --install through the injected exec, and nothing off a Mac", async () => {
    const { ops, calls } = fakeStore();
    const mac = await service(ops, calls);
    assert.equal(await mac.toolchains.installClt(), true);
    assert.deepEqual(mac.execs, [[XCODE_SELECT, ["--install"]]]);
    assert.equal(XCODE_SELECT, "/usr/bin/xcode-select");

    const refused = await service(ops, calls, {
      exec: async (file, args) => {
        refused.execs.push([file, args]);
        return { code: 1, stdout: "", stderr: "xcode-select: note: Command line tools are already installed." };
      },
    });
    assert.equal(await refused.toolchains.installClt(), false, "Apple's tool said no");

    for (const host of [ToolchainHost.LinuxX64, ToolchainHost.WindowsX64, null]) {
      const other = await service(ops, calls, { host });
      assert.equal(await other.toolchains.installClt(), false, String(host));
      assert.deepEqual(other.execs, [], `${host}: nothing ran`);
    }
  });
});

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;

/** The five channels over a recording service; `listed` are the games the library lists. */
function toolchainIpc(games: Pick<GameWorkspaces, "nativeLocks"> = { nativeLocks: async () => [] }) {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  const installs: Array<readonly BuildTarget[] | undefined> = [];
  const prunes: Array<readonly string[] | undefined> = [];
  const toolchains = {
    status: async () => ({ host: ToolchainHost.MacArm64, storeBytes: 7 }),
    plan: async () => ({
      downloads: [{ id: ToolchainId.Cmake, version: "4.4.3", bytes: 1000, diskBytes: 8000 }],
      freeBytes: 99,
      reserveBytes: 5,
    }),
    install: async (targets?: readonly BuildTarget[]) => {
      installs.push(targets);
      return { phase: ToolchainInstallPhase.Installed };
    },
    cancel: async () => false,
    prune: async (games?: readonly string[]) => {
      prunes.push(games);
      return { removed: 0, bytes: 0 };
    },
    installClt: async () => false,
  };
  registerToolchainIpc(handle, { toolchains, games } as never);
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main-frame" }, payload);
  };
  return { invoke, installs, prunes, channels: [...listeners.keys()] };
}

describe("toolchain IPC", () => {
  it("registers the seven channels", () => {
    // Flipped (M5.0): the phones' install and the Android licence join the five older channels.
    assert.deepEqual(toolchainIpc().channels.sort(), [
      "studio:toolchain.acceptAndroidLicence",
      "studio:toolchain.cancel",
      "studio:toolchain.install",
      "studio:toolchain.installClt",
      "studio:toolchain.installMobile",
      "studio:toolchain.prune",
      "studio:toolchain.status",
    ]);
  });

  it("answers the status with this computer's download sizes and free disk, for the Toolchain sheet", async () => {
    const result = await toolchainIpc().invoke("studio:toolchain.status");
    assert.deepEqual(result, {
      ok: true,
      value: {
        host: ToolchainHost.MacArm64,
        storeBytes: 7,
        downloads: [{ id: ToolchainId.Cmake, version: "4.4.3", bytes: 1000, diskBytes: 8000 }],
        freeBytes: 99,
        reserveBytes: 5,
      },
    });
  });

  it("refuses a malformed install request with no job started", async () => {
    const hostile: Array<{ name: string; payload: unknown }> = [
      { name: "a bare string", payload: { targets: "macos" } },
      { name: "no destination", payload: { targets: [] } },
      {
        name: "five entries",
        payload: { targets: ["web", "macos", "windows", "linux", "web"] },
      },
      { name: "a number among them", payload: { targets: ["web", 1] } },
      { name: "a prototype key", payload: { targets: ["__proto__"] } },
      { name: "a duplicate", payload: { targets: ["web", "web"] } },
      { name: "an unknown destination", payload: { targets: ["android"] } },
      { name: "a null list", payload: { targets: null } },
      { name: "a payload that is a string", payload: "macos" },
      { name: "a payload that is a list", payload: ["web"] },
    ];
    const ipc = toolchainIpc();
    for (const row of hostile) {
      const result = await ipc.invoke("studio:toolchain.install", row.payload);
      assert.equal(result.ok, false, row.name);
    }
    assert.deepEqual(ipc.installs, [], "no install started");
  });

  it("passes a well-formed request through, and no destinations as the default", async () => {
    const ipc = toolchainIpc();
    for (const payload of [undefined, {}, { targets: ["web"] }, { targets: ["web", "macos", "windows", "linux"] }]) {
      const result = await ipc.invoke("studio:toolchain.install", payload);
      assert.equal(result.ok, true, JSON.stringify(payload));
    }
    assert.deepEqual(ipc.installs, [undefined, undefined, ["web"], ["web", "macos", "windows", "linux"]]);
  });

  it("prunes with the lock each listed game's last build recorded in the host's library, never one a game folder claims", async () => {
    const root = await realpath(await tmpDir("toolchain-games-"));
    const digest = sha("the current lock");
    const raylib = "cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n";
    const library = path.join(root, "library");
    for (const name of ["pong-cpp", "pong-odd", "claims"]) {
      await mkdir(path.join(library, name, "src"), { recursive: true });
      await writeFile(path.join(library, name, "CMakeLists.txt"), raylib);
      await writeFile(path.join(library, name, "src", "main.cpp"), "int main() {}\n");
    }
    // studio.json is the game's own (an agent can write it): a lock it names is never trusted.
    await writeFile(
      path.join(library, "claims", "studio.json"),
      JSON.stringify({ stack: "raylib-cpp", native: { lock: sha("a lock an agent wrote") } }),
    );
    const index = path.join(root, "projects.json");
    await writeFile(
      index,
      JSON.stringify({
        version: 1,
        aliases: {},
        recents: [],
        presentation: { [path.join(library, "pong-odd")]: { native: { lock: "../../etc/passwd" } } },
      }),
    );
    const games = new GameWorkspaces({
      root: library,
      templateDir: path.join(root, "template"),
      vendorDir: path.join(root, "vendor"),
      indexFile: index,
      userData: root,
      homeDir: root,
    });
    await games.writeNativeLock("pong-cpp", digest);
    const ipc = toolchainIpc(games);
    const result = await ipc.invoke("studio:toolchain.prune");
    assert.equal(result.ok, true);
    assert.deepEqual(ipc.prunes, [[digest]]);
  });
});

const execFileAsync = promisify(execFile);

/** Runs a stub; a non-zero exit is an answer, not a throw. */
async function runStub(
  file: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A tree entry's identity: a link's target, a file's digest, or that it is a folder. */
async function entryKind(entry: { isSymbolicLink(): boolean; isFile(): boolean }, file: string): Promise<string> {
  if (entry.isSymbolicLink()) return `-> ${await readlink(file)}`;
  return entry.isFile() ? sha(await readFile(file, "latin1")) : "dir";
}

/** Every entry under `dir` with its identity, as a sorted list, to compare two trees. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const rows: string[] = [];
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name);
    rows.push(`${path.relative(dir, file)} ${await entryKind(entry, file)}`);
  }
  return rows.sort();
}

describe("the cpp-game fixture's stub cmake", () => {
  it(
    "its stub cmake records the source at configure, serves the committed web build, and fails like clang on GENEX_FORCE_ERROR",
    POSIX_ONLY,
    async () => {
      const root = await tmpDir("fixture-stub-");
      const web = fixtureWebOutput();
      const served = (await readdir(web)).filter((name) => name.startsWith("index.")).sort();
      assert.ok(served.includes("index.html") && served.includes("index.wasm"), "the committed emcc output");
      const cmake = path.join(root, "tool dir", "cmake");
      await mkdir(path.dirname(cmake), { recursive: true });
      await writeFile(cmake, stubCmake(web));
      await chmod(cmake, 0o755);
      const source = path.join(root, "my game's $(src)");
      const bin = path.join(root, "build dir", "web-abc");
      await mkdir(path.join(source, "src"), { recursive: true });
      await writeFile(path.join(source, "src", "main.cpp"), "int main() { return 0; }\n");

      const unconfigured = await runStub(cmake, ["--build", bin, "-j4"]);
      assert.notEqual(unconfigured.code, 0, "a build dir that was never configured fails");
      assert.deepEqual(await tree(root).then((rows) => rows.filter((row) => row.startsWith("build dir"))), []);

      const configure = await runStub(cmake, [
        "-S",
        source,
        "-B",
        bin,
        "-G",
        "Ninja",
        "-DCMAKE_MAKE_PROGRAM=/x/ninja",
        "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
      ]);
      assert.equal(configure.code, 0, configure.stderr);
      assert.equal(await readFile(path.join(bin, ".stub-source"), "utf8"), `${source}\n`);

      const build = await runStub(cmake, ["--build", bin, "-j4"]);
      assert.equal(build.code, 0, build.stderr);
      assert.deepEqual((await readdir(path.join(bin, "out"))).sort(), served);
      for (const name of served)
        assert.deepEqual(
          await readFile(path.join(bin, "out", name)),
          await readFile(path.join(web, name)),
          `${name} byte-identical`,
        );

      await writeFile(path.join(source, "src", "main.cpp"), "int main() { GENEX_FORCE_ERROR; }\n");
      const failed = await runStub(cmake, ["--build", bin, "-j4"]);
      assert.equal(failed.code, 1);
      assert.ok(failed.stdout.split("\n").includes(FIXTURE_FORCED_ERROR), failed.stdout);
      assert.equal(FIXTURE_FORCED_ERROR, "src/main.cpp:12:5: error: use of undeclared identifier 'GENEX_FORCE_ERROR'");
    },
  );
});

describe("the cpp-game fixture's seeded store", () => {
  it(
    "is seeded in the layout the store locates, with one CMake no lock names, and prunes to what the lock names",
    POSIX_ONLY,
    async () => {
      const store = path.join(await tmpDir("fixture-store-"), "toolchains");
      await mkdir(store);
      const lock = await seedFixtureToolchainStore(store, { webOutput: fixtureWebOutput() });
      assert.ok(lock);
      assert.deepEqual(await currentLock(store), lock);
      const located = await locateToolchain(store, lock, [BuildTarget.Web]);
      assert.ok(located.ok, JSON.stringify(located));
      const stub = await runStub(located.toolchain.cmake, ["--version"]);
      assert.match(stub.stdout, /genex fixture stub/);
      const versions = (await readReceipts(store)).map((item) => `${item.id}/${item.version}`).sort();
      assert.deepEqual(versions, ["cmake/4.4.2", "cmake/4.4.3", "emsdk/6.0.10", "ninja/1.13.2", "raylib/6.0"]);
      // A second launch reseeds the same store and lock.
      assert.deepEqual(await seedFixtureToolchainStore(store, { webOutput: fixtureWebOutput() }), lock);

      const toolchains = new ToolchainService({
        store,
        host: ToolchainHost.MacArm64,
        emit: () => {},
        run: async () => {
          throw new Error("prune runs nothing");
        },
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        probeClt: async () => ({ present: true, version: null }),
      });
      const pruned = await toolchains.prune([]);
      assert.equal(pruned.removed, 1);
      assert.deepEqual(
        (await readReceipts(store)).map((item) => `${item.id}/${item.version}`).sort(),
        ["cmake/4.4.3", "emsdk/6.0.10", "ninja/1.13.2", "raylib/6.0"],
        "the old CMake went; everything the lock names stayed",
      );
      assert.ok((await locateToolchain(store, lock, [BuildTarget.Web])).ok, "it still locates after pruning");
    },
  );
});

describe("the cpp-game fixture's link to the developer's store", () => {
  it("links to an absolute directory outside the profile, and otherwise changes nothing", POSIX_ONLY, async () => {
    const root = await realpath(await tmpDir("fixture-link-"));
    const real = path.join(root, "dev-store");
    await mkdir(real);
    await writeFile(path.join(real, "keep.txt"), "the developer's store");
    const file = path.join(root, "a-file");
    await writeFile(file, "not a folder");
    const profile = path.join(root, "profile");
    const store = path.join(profile, "toolchains");
    await mkdir(path.join(profile, "workspaces"), { recursive: true });
    // The store as a fixture launch leaves it: seeded, so a link may replace it.
    assert.ok(await seedFixtureToolchainStore(store, { webOutput: fixtureWebOutput() }));
    await symlink(store, path.join(root, "store-link"));
    const hostile = [
      { name: "a relative path", target: "dev-store" },
      { name: "a missing folder", target: path.join(root, "absent") },
      { name: "a file", target: file },
      { name: "an empty value", target: "" },
      { name: "the store itself", target: store },
      { name: "the store through a link beside it", target: path.join(root, "store-link") },
      { name: "a folder inside the store", target: path.join(store, ToolchainId.Cmake) },
      { name: "the profile it lives in", target: profile },
      { name: "another folder of the profile", target: path.join(profile, "workspaces") },
      { name: "an ancestor of the profile", target: root },
      { name: "the filesystem root", target: path.parse(root).root },
    ];
    for (const row of hostile) {
      const before = await tree(root);
      assert.equal(await linkFixtureToolchainStore(store, row.target), false, row.name);
      assert.deepEqual(await tree(root), before, `${row.name}: nothing changed`);
    }
    // A store the fixture did not seed is never replaced, even by a good target, nor seeded over.
    const foreign = path.join(root, "other-profile", "toolchains");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "someone-elses.txt"), "x");
    const before = await tree(root);
    assert.equal(await linkFixtureToolchainStore(foreign, real), false);
    assert.equal(await seedFixtureToolchainStore(foreign, { webOutput: fixtureWebOutput() }), null);
    assert.deepEqual(await tree(root), before, "a foreign store is left as it was");

    // The seeded store becomes a link; a later launch may point it elsewhere.
    assert.equal(await linkFixtureToolchainStore(store, real), true);
    assert.equal(await readlink(store), real);
    assert.deepEqual(await readdir(store), ["keep.txt"]);
    const other = path.join(root, "other-store");
    await mkdir(other);
    assert.equal(await linkFixtureToolchainStore(store, other), true);
    assert.equal(await readlink(store), other);
    assert.deepEqual(await readdir(real), ["keep.txt"], "relinking never touches the store it pointed at");
    // Naming the link itself is naming where it points, which is outside the profile.
    assert.equal(await linkFixtureToolchainStore(store, store), true);
    assert.equal(await readlink(store), other);
  });

  it(
    "a store linked to the developer's is never pruned, and the developer's store is left as it was",
    POSIX_ONLY,
    async () => {
      const root = await realpath(await tmpDir("fixture-shared-"));
      const dev = path.join(root, "dev-store");
      await mkdir(dev);
      const devLock = await seedFixtureToolchainStore(dev, { webOutput: fixtureWebOutput() });
      assert.ok(devLock);
      const store = path.join(root, "profile", "toolchains");
      await mkdir(store, { recursive: true });
      const toolchains = new ToolchainService({
        store,
        host: ToolchainHost.MacArm64,
        emit: () => {},
        run: async () => {
          throw new Error("prune runs nothing");
        },
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        probeClt: async () => ({ present: true, version: null }),
      });
      // What seedCppGame reads of the core: the games it lists (both fixture games exist), the store and its service.
      const games = FIXTURE_CPP_GAMES.map((game) => ({ name: game.name, dir: path.join(root, game.name) }));
      const core = { games: { list: async () => games }, layout: { toolchains: store }, toolchains };
      await seedCppGame(core as never, { [FIXTURE_TOOLCHAIN_STORE_ENV]: dev });
      assert.equal(await readlink(store), dev);
      const before = await tree(dev);
      assert.deepEqual(await toolchains.prune([]), { removed: 0, bytes: 0, refused: ToolchainPruneRefusal.Shared });
      assert.deepEqual(await tree(dev), before, "the developer's store, old CMake included, is as it was");
    },
  );
});

describe("the toolchain host the studio serves", () => {
  it("is this computer's manifest host on a Mac and on Linux, and none on Windows, whose grants are session-wide", () => {
    const rows: Array<[string, string, ToolchainHost | null]> = [
      ["darwin", "arm64", ToolchainHost.MacArm64],
      ["linux", "x64", ToolchainHost.LinuxX64],
      ["win32", "x64", null],
      ["darwin", "x64", null],
      ["freebsd", "x64", null],
    ];
    for (const [platform, arch, host] of rows)
      assert.equal(servedToolchainHost(platform, arch), host, `${platform}-${arch}`);
  });
});

describe("ToolchainService: the Windows and Linux destinations", () => {
  /** The real manifest's parts a developer's store holds as local artifacts: Genex built them. */
  const UNPUBLISHED = [ToolchainId.AngleWindows, ToolchainId.AngleLinux, ToolchainId.LinuxSysroot];
  /** ANGLE and the Linux headers are copied from the app, with no network request. */
  const BUNDLED_CROSS = [ToolchainId.AngleWindows, ToolchainId.AngleLinux, ToolchainId.LinuxSysroot];
  const CROSS: BuildTarget[] = [BuildTarget.Windows, BuildTarget.Linux];

  it("a fresh status lists bundled ANGLE and Linux headers with no unhosted destination", async () => {
    const toolchains = new ToolchainService({
      store: await tmpDir("toolchain-user-store-"),
      host: ToolchainHost.MacArm64,
      emit: () => {},
      run: async () => {
        throw new Error("status runs nothing");
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeClt: async () => ({ present: true, version: null }),
      freeBytes: async () => 40 * GB,
      fetch: async () => {
        throw new Error("status fetches nothing");
      },
    });
    const status = { ...(await toolchains.status()), ...(await toolchains.plan()) };
    assert.deepEqual(status.unhosted, []);
    const zig = status.downloads.find((download) => download.id === ToolchainId.Zig);
    assert.deepEqual(zig && [zig.version, zig.bytes], ["0.16.0", 52_238_004]);
    for (const id of BUNDLED_CROSS) {
      const component = status.downloads.find((download) => download.id === id);
      assert.deepEqual(component && [component.bytes, component.bundled], [0, true], id);
    }
    const view = sheetView(status, null, CROSS);
    assert.deepEqual(view.unavailable, []);
    assert.deepEqual(view.notYet, []);
    assert.equal(view.canInstall, true);
  });

  it("a cross-only request prepares the complete real-manifest set, including bundled Linux headers", async () => {
    const { ops, calls, state } = fakeStore({ manifest: TOOLCHAIN_MANIFEST });
    const { toolchains } = await service(ops, calls);
    const job = await toolchains.install(CROSS);
    assert.deepEqual([job.phase, job.unavailable], [ToolchainInstallPhase.Installed, undefined]);
    assert.deepEqual(calls.installed, [[...new Set(BUILD_TARGETS.flatMap((target) => REQUIRED_COMPONENTS[target]))]]);
    assert.deepEqual(calls.fetched, []);
    assert.deepEqual(
      calls.prewarmed.map((call) => call.targets),
      [PREWARMED_TARGETS],
    );
    assert.ok(state.current?.entries[ToolchainId.LinuxSysroot]);
  });

  it("a store holding bundled cross artifacts downloads only the missing compiler and Browser parts", async () => {
    const receipts = UNPUBLISHED.map((id) => {
      const item = TOOLCHAIN_MANIFEST.find((candidate) => candidate.id === id);
      assert.ok(item, id);
      return receipt(id, item.version, sha12Of(item), 1000);
    });
    const { ops, calls, state } = fakeStore({ manifest: TOOLCHAIN_MANIFEST, receipts });
    const { toolchains } = await service(ops, calls);
    const job = await toolchains.install(CROSS);
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.equal(job.unavailable, undefined);
    assert.deepEqual(calls.installed, [
      [
        ToolchainId.Cmake,
        ToolchainId.Ninja,
        ToolchainId.Emsdk,
        ToolchainId.RaylibSource,
        ToolchainId.AngleMac,
        ToolchainId.Zig,
      ],
    ]);
    assert.deepEqual(
      calls.prewarmed.map((call) => call.targets),
      [PREWARMED_TARGETS],
    );
    assert.deepEqual(
      Object.keys(state.current?.entries ?? {}).sort(),
      [...new Set(BUILD_TARGETS.flatMap((target) => REQUIRED_COMPONENTS[target]))].sort(),
    );
  });

  it("status judges Windows' and Linux' prewarm beside the web's and the Mac's", async () => {
    const { ops, calls, state } = fakeStore();
    state.current = ops.lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "aaaaaaaaaaaa" } });
    const asked: BuildTarget[][] = [];
    ops.locateToolchain = async (_store, _lock, targets) => {
      asked.push([...targets]);
      return { ok: false, missing: [ToolchainId.Zig] };
    };
    const { toolchains } = await service(ops, calls);
    const status = await toolchains.status();
    assert.deepEqual(Object.keys(status.prewarm ?? {}), PREWARMED_TARGETS.map(String));
    assert.deepEqual(
      asked,
      PREWARMED_TARGETS.map((target) => [target]),
    );
    for (const target of PREWARMED_TARGETS) assert.equal(status.prewarm?.[target], PrewarmState.Missing, target);
  });
});
