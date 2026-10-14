/** Real Linux-host acceptance. Owned CI state only; no provider calls or developer store. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { layoutFor, prewarmDenyWrites, studioBaseDenyWrites } from "../src/main/core/layout.ts";
import {
  createPrewarmSandbox,
  execHost,
  probeCommandLineTools,
  ToolchainService,
} from "../src/main/core/toolchains.ts";
import { CppBuildPurpose, CppBuilds } from "../src/main/cpp-build.ts";
import { StudioPlatform } from "../src/shared/boot.ts";
import { cppSetupTargets } from "../src/shared/cpp-setup.ts";
import { BuildTarget, GameStack } from "../src/shared/game-project.ts";
import { GameBoxProblem, NativeRunMode } from "../src/shared/native-contract.ts";
import {
  PrewarmState,
  REQUIRED_COMPONENTS,
  servedToolchainHost,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
} from "../src/shared/toolchain.ts";
import { GameWorkspaces, ScaffoldCaller } from "../src/substrate/game-workspace.ts";
import { admitCrossOutput } from "../src/substrate/native-cross-admission.ts";
import {
  linuxArchiveName,
  linuxExportName,
  windowsArchiveName,
  windowsExportName,
} from "../src/substrate/native-export-archive.ts";
import { exportLinuxTarball, exportWindowsZip } from "../src/substrate/native-export-desktop.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../src/substrate/spawn.ts";
import { type InstallDeps, readReceipts } from "../src/substrate/toolchain-store/install.ts";
import { lockFolder, PREWARM_FILE } from "../src/substrate/toolchain-store/locate.ts";
import { isPinned, TOOLCHAIN_MANIFEST } from "../src/substrate/toolchain-store/manifest.ts";
import { bundleAngle } from "./bundle-angle.mjs";
import { bundleLinuxSysroot } from "./bundle-linux-sysroot.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "./electron-runtime.mjs";
import { sourceIdentity } from "./studio-dev/files.mjs";
import { AcceptanceJournal, finishAcceptance } from "./cpp-linux-evidence.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(REPO, ".studio-dev/evidence/cpp-linux-host");
const exec = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Limit this acceptance runner's network to the production manifest's exact pinned archives. */
export function pinnedToolchainFetch(host: ToolchainHost, fetcher: InstallDeps["fetch"] = fetch): InstallDeps["fetch"] {
  const urls = new Set(
    TOOLCHAIN_MANIFEST.filter((entry) => (entry.host === host || entry.host === null) && isPinned(entry)).flatMap(
      (entry) => entry.archives.map((archive) => archive.url),
    ),
  );
  return async (url, init) => {
    assert.ok(urls.has(url), "not a pinned Linux toolchain archive");
    return fetcher(url, init);
  };
}

type Report = Record<string, unknown>;
interface Acceptance {
  root: string;
  userData: string;
  layout: ReturnType<typeof layoutFor>;
  resources: string;
  sandbox: ProcessSandbox;
  report: Report;
  commands: Array<Report>;
  jobs: Array<Report>;
  downloads: string[];
  journal: AcceptanceJournal;
  signal: AbortSignal;
}

const recordedRun =
  (context: Acceptance, owner: string, run: (request: RunRequest) => Promise<RunResult>) =>
  async (request: RunRequest) => {
    assert.deepEqual(request.policy?.allowedDomains ?? [], [], "build and probe commands must not open the network");
    const facts = {
      owner,
      label: request.label,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    };
    context.report.activeCommand = facts;
    context.journal.checkpoint("command-start", facts);
    try {
      const result = await run({
        ...request,
        signal: request.signal ? AbortSignal.any([context.signal, request.signal]) : context.signal,
      });
      context.commands.push({
        ...facts,
        ...result,
        stdout: result.stdout.slice(-65_536),
        stderr: result.stderr.slice(-65_536),
      });
      context.report.activeCommand = null;
      context.journal.checkpoint("command-result", {
        ...facts,
        code: result.code,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      assert.equal(result.sandboxed, true, `${owner} must use the production process sandbox`);
      return result;
    } catch (error) {
      context.journal.checkpoint("command-error", { ...facts, error: String(error) });
      throw error;
    }
  };

function managedTools(context: Acceptance): ToolchainService {
  const { layout, resources, sandbox: mainSandbox, jobs, downloads } = context;
  const download = pinnedToolchainFetch(ToolchainHost.LinuxX64);
  return new ToolchainService({
    store: layout.toolchains,
    host: ToolchainHost.LinuxX64,
    resources,
    emit: (job) => {
      jobs.push({ ...job });
      context.journal.checkpoint("toolchain-job", { ...job });
    },
    run: recordedRun(context, "probe", (request) => mainSandbox.run(request)),
    exec: execHost,
    probeClt: () => probeCommandLineTools(execHost, process.platform),
    fetch: async (url, init) => {
      downloads.push(url);
      context.journal.checkpoint("download-start", { url });
      const response = await download(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([context.signal, init.signal]) : context.signal,
      });
      context.journal.checkpoint("download-response", { url, status: response.status });
      return response;
    },
    prewarmSandbox: async () => {
      context.journal.checkpoint("prewarm-sandbox-start");
      const prewarm = await createPrewarmSandbox({
        scratchDir: path.join(layout.scratch, "toolchain-prewarm"),
        secretPaths: [],
        readableRoots: [resources],
        alongside: mainSandbox,
      });
      context.journal.checkpoint("prewarm-sandbox-ready");
      return { run: recordedRun(context, "prewarm", prewarm.run), dispose: prewarm.dispose };
    },
    prewarmDenyWrite: prewarmDenyWrites(layout),
  });
}

async function verifySetup(context: Acceptance, tools: ToolchainService) {
  const { layout, report, downloads, commands, jobs } = context;
  assert.equal(await tools.currentLock(), null);
  assert.deepEqual(await readReceipts(layout.toolchains), []);
  context.journal.phase("first-single-target-setup");
  const first = await tools.install([BuildTarget.Linux]);
  assert.equal(first.phase, ToolchainInstallPhase.Installed, JSON.stringify(first));
  assert.deepEqual(first.unavailable ?? [], []);
  const lock = await tools.currentLock();
  assert.ok(lock);
  const targets = cppSetupTargets(ToolchainHost.LinuxX64);
  assert.deepEqual(targets, [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]);
  const required: ToolchainId[] = [...new Set(targets.flatMap((target) => REQUIRED_COMPONENTS[target]))].sort();
  assert.deepEqual(Object.keys(lock.entries).sort(), required);
  const expectedDownloads = TOOLCHAIN_MANIFEST.filter(
    (entry) => required.includes(entry.id) && (entry.host === ToolchainHost.LinuxX64 || entry.host === null),
  ).flatMap((entry) => entry.archives.map((archive) => archive.url));
  assert.deepEqual(
    [...downloads].sort(),
    expectedDownloads.sort(),
    "each required pinned archive must download exactly once",
  );
  assert.equal(lock.entries[ToolchainId.AngleMac], undefined);
  const status = await tools.status();
  for (const target of targets) assert.equal(status.prewarm?.[target], PrewarmState.Ready);
  report.firstSetup = { requested: [BuildTarget.Linux], prepared: targets, lock, status };
  const receipts = await readReceipts(layout.toolchains);
  const prewarmFile = path.join(lockFolder(layout.toolchains, lock), PREWARM_FILE);
  const prewarmBefore = await readFile(prewarmFile);
  const downloadsBefore = downloads.length;
  const commandsBefore = commands.length;
  const jobsBefore = jobs.length;
  context.journal.phase("repeat-target-setup");
  for (const target of [BuildTarget.Windows, BuildTarget.Web]) {
    const freshService = managedTools(context);
    const repeat = await freshService.install([target]);
    assert.equal(repeat.phase, ToolchainInstallPhase.Installed, JSON.stringify(repeat));
    assert.equal((await freshService.currentLock())?.digest, lock.digest);
  }
  assert.deepEqual(await readReceipts(layout.toolchains), receipts);
  assert.equal(digest(await readFile(prewarmFile)), digest(prewarmBefore));
  assert.equal(downloads.length - downloadsBefore, 0);
  assert.equal(commands.length - commandsBefore, 0);
  assert.ok(!jobs.slice(jobsBefore).some((job) => job.phase === ToolchainInstallPhase.Prewarming));
  report.reuse = {
    requested: [BuildTarget.Windows, BuildTarget.Web],
    freshServices: true,
    downloads: 0,
    commands: 0,
    receiptsUnchanged: true,
    prewarmUnchanged: true,
    lock: lock.digest,
  };

  return { lock, targets };
}

async function starterBuild(
  context: Acceptance,
  tools: ToolchainService,
  setup: Awaited<ReturnType<typeof verifySetup>>,
) {
  const { layout, root, userData, report } = context;
  const { lock, targets } = setup;
  context.journal.phase("create-starter");
  const games = new GameWorkspaces({
    root: layout.gamesRoot,
    templateDir: path.join(REPO, "src/game-template"),
    cppTemplateDir: path.join(REPO, "src/game-template-cpp"),
    vendorDir: path.join(REPO, "src/vendor"),
    indexFile: path.join(userData, "projects.json"),
    userData,
    homeDir: root,
    platform: process.platform,
  });
  const selected = [BuildTarget.Web, BuildTarget.Linux];
  // Raylib creation is retired for every caller but the host itself (M6.3); this host check
  // exercises the kept raylib lane, so it names itself internal as the fixtures do.
  const game = await games.create("Linux C++ starter", {
    stack: GameStack.RaylibCpp,
    targets: selected,
    caller: ScaffoldCaller.Internal,
  });
  assert.deepEqual(game.destinations, { stack: GameStack.RaylibCpp, targets: selected });
  const destinations = { stack: GameStack.RaylibCpp, targets: [...targets] };
  await games.setDestinations(game.name, destinations.targets);
  report.creation = { selected, created: game.destinations, addedForCrossBuild: BuildTarget.Windows };
  const builds = new CppBuilds({
    root: layout.cppBuilds,
    run: recordedRun(context, "build", (request) => context.sandbox.run(request)),
    locate: (wanted, requested) => tools.locate(wanted, requested),
    currentLock: () => tools.currentLock(),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [layout.toolchains, layout.nativeRuns],
    writeLock: (project, digest) => games.writeNativeLock(project, digest),
    writeCheck: (project, target, check) => games.writeNativeCheck(project, target, check),
  });
  const located = await tools.locate(lock, targets);
  assert.ok(located.ok, JSON.stringify(located));
  const outputs: Partial<Record<BuildTarget, string>> = {};
  const buildFacts: Record<string, unknown> = {};
  report.builds = buildFacts;
  for (const target of targets) {
    context.journal.phase(`build-${target}`);
    const started = performance.now();
    const outcome = await builds.ensure({
      project: game.name,
      dir: game.dir,
      shape: game.shape,
      target,
      destinations,
      purpose: CppBuildPurpose.Live,
      lock: null,
      recordLock: true,
    });
    buildFacts[target] = { ...outcome, ms: Math.round(performance.now() - started) };
    assert.ok(outcome.ok, JSON.stringify(outcome.problem));
    assert.ok(outcome.output);
    outputs[target] = outcome.output;
  }
  return { game, located, outputs };
}

async function desktopExports(context: Acceptance, starter: Awaited<ReturnType<typeof starterBuild>>) {
  const { layout, report } = context;
  const { game, located, outputs } = starter;
  context.journal.phase("desktop-admission-and-export");
  const exports: Record<string, unknown> = {};
  report.exports = exports;
  await mkdir(layout.exports, { recursive: true });
  for (const target of [BuildTarget.Linux, BuildTarget.Windows] as const) {
    const out = outputs[target];
    context.journal.phase(`admission-and-export-${target}`);
    const cross = located.toolchain.cross?.[target];
    assert.ok(out && cross && located.toolchain.zig && located.toolchain.raylibSource);
    const admission = await admitCrossOutput({ target, out, angle: cross.angle });
    assert.ok(admission.ok, JSON.stringify(admission));
    const request = {
      title: game.title,
      game: game.dir,
      out,
      angle: cross.angle,
      zig: path.dirname(located.toolchain.zig),
      raylib: located.toolchain.raylibSource,
      archive: path.join(
        layout.exports,
        target === BuildTarget.Linux
          ? linuxArchiveName(linuxExportName(game.title))
          : windowsArchiveName(windowsExportName(game.title)),
      ),
      builtOn: StudioPlatform.Linux,
      ranOnTarget: false,
      secretValues: [],
    };
    let exported;
    if (target === BuildTarget.Linux) {
      assert.ok(cross.sysroot && cross.sysrootManifestSha256);
      exported = await exportLinuxTarball({
        ...request,
        sysroot: { dir: cross.sysroot, manifestSha256: cross.sysrootManifestSha256 },
      });
    } else exported = await exportWindowsZip(request);
    const archive = await readFile(exported.archive.file);
    assert.equal(archive.length, exported.archive.bytes);
    assert.equal(digest(archive), exported.archive.sha256);
    const evidenceFile = path.join(EVIDENCE, path.basename(exported.archive.file));
    await copyFile(exported.archive.file, evidenceFile);
    exports[target] = { admission: admission.facts, ...exported, evidenceFile, ranOnTarget: false };
  }
}

async function browserCheck(context: Acceptance, outputs: Partial<Record<BuildTarget, string>>) {
  const { root, report } = context;
  context.journal.phase("browser-state-and-capture");
  assert.ok(outputs[BuildTarget.Web]);
  const browser = await exec(
    resolveElectron(REPO),
    fixtureElectronArgs([
      path.join(REPO, "scripts/ci-cpp-linux-browser.cjs"),
      outputs[BuildTarget.Web],
      path.join(root, "browser-profile"),
      EVIDENCE,
    ]),
    { cwd: REPO, env: fixtureElectronEnv(), timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  report.browser = JSON.parse(await readFile(path.join(EVIDENCE, "browser.json"), "utf8"));
  report.browserProcess = { stdout: browser.stdout, stderr: browser.stderr, exitCode: 0 };
}

function nativePlayRefusal(context: Acceptance) {
  const { report } = context;
  context.journal.phase("protected-native-play-refusal");
  const windowRefusal = context.sandbox.gameBox(NativeRunMode.Window);
  const headlessRefusal = context.sandbox.gameBox(NativeRunMode.Headless);
  assert.ok(windowRefusal, "this Xvfb runner cannot claim protected Wayland Native Play");
  assert.equal(headlessRefusal, GameBoxProblem.NoHeadlessBuild);
  report.nativePlay = {
    passed: false,
    windowRefusal,
    headlessRefusal,
    reason: "No protected native run was performed.",
  };
}

async function main(): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const report: Report = {
    source: sourceIdentity(REPO),
    github: { sha: process.env.GITHUB_SHA, head: process.env.CI_HEAD_SHA, run: process.env.GITHUB_RUN_ID },
    platform: process.platform,
    arch: process.arch,
    provider: "none",
    startedAt: new Date().toISOString(),
    stage: "host",
    passed: false,
  };
  const journal = new AcceptanceJournal(EVIDENCE, report);
  const abort = new AbortController();
  const interrupted = () => {
    const reason = "Acceptance interrupted within the unchanged 45-minute CI budget";
    report.error = reason;
    journal.interrupt("SIGTERM");
    abort.abort(new Error(reason));
  };
  process.once("SIGTERM", interrupted);
  let sandbox: ProcessSandbox | undefined;
  try {
    assert.equal(process.env.GITHUB_ACTIONS, "true", "run only on a disposable GitHub Actions runner");
    assert.equal(process.platform, StudioPlatform.Linux);
    assert.equal(process.arch, "x64");
    assert.equal(servedToolchainHost(process.platform, process.arch), ToolchainHost.LinuxX64);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "genex-cpp-linux-host-")));
    const userData = path.join(root, "userData");
    const layout = layoutFor(userData);
    const resources = path.join(root, "resources");
    report.ownedRoot = root;
    journal.phase("bundled-resources");
    await bundleAngle({ resources, root: REPO, release: true });
    await bundleLinuxSysroot({ resources, root: REPO });
    await mkdir(layout.gamesRoot, { recursive: true });
    journal.phase("production-sandbox-create");
    sandbox = await ProcessSandbox.create({
      writableRoots: [layout.gamesRoot],
      scratchDir: layout.scratch,
      secretPaths: [],
      readableRoots: [resources],
      denyWrite: studioBaseDenyWrites(layout, []),
    });
    const context: Acceptance = {
      root,
      userData,
      layout,
      resources,
      sandbox,
      report,
      commands: [],
      jobs: [],
      downloads: [],
      journal,
      signal: abort.signal,
    };
    Object.assign(report, { commands: context.commands, jobs: context.jobs, downloads: context.downloads });
    const tools = managedTools(context);
    const setup = await verifySetup(context, tools);
    const starter = await starterBuild(context, tools, setup);
    await desktopExports(context, starter);
    await browserCheck(context, starter.outputs);
    nativePlayRefusal(context);
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    await finishAcceptance(journal, async () => {
      await sandbox?.dispose();
    });
    process.removeListener("SIGTERM", interrupted);
    if (report.passed !== true) process.exitCode = 1;
    console.log(
      JSON.stringify({ passed: report.passed, stage: report.stage, evidence: EVIDENCE, error: report.error }),
    );
    // A hanging proxy's handles cannot retain this owned CI process after its bounded failure.
    if (!(report.cleanup as Report)?.completed) process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
