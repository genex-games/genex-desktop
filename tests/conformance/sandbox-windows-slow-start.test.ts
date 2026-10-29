/**
 * The Windows sandbox starts when one setup step is slow or refused once: the real srt-win
 * backend and the real folder entries, no mocks.
 *
 * - Windows can refuse the egress check's start of srt-win as the sandbox user
 *   (CreateProcessWithLogonW, ERROR_ACCESS_DENIED) while that user cannot open the program yet,
 *   and start it seconds later with nothing changed. The start waits and tries again.
 * - A first grant on a large folder passes its entries down for longer than any start should
 *   wait. The start waits for it only within a budget, and the rest is passed down after it.
 *
 * Its own file, with the refused start first: srt-win's egress check runs once per process.
 * Windows only, on a machine whose sandbox is provisioned (the Windows CI job does that and sets
 * GENEX_WINDOWS_SANDBOX=ready).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { editFolderOwn, FolderAceOp, GrantAccess } from "../../src/substrate/windows-folder-ace.ts";
import {
  ancestorGrants,
  groupSidOnce,
  insideWindowsPath,
  ownAclEntries,
  sandboxSidOnce,
  srtAncestorGrantee,
  srtSandboxGroup,
  srtWinPath,
  WindowsSandboxSession,
} from "../../src/substrate/windows-sandbox.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  return false;
}
const SKIP = skipReason();

const TEST_TIMEOUT_MS = 600_000;
/** The pauses before each new start after a refused one, short enough for a test. */
const LOGON_PAUSES_MS = [4_000, 8_000];
/** How long the test start waits for a grant outside the folders it needs: well under the walk below. */
const GRANT_BUDGET_MS = 1_000;
/** The large folder: enough files that passing an entry down them takes seconds on the runner. */
const HEAVY_FOLDERS = 150;
const HEAVY_FILES = 200;
/** How long the walk after the start may take to finish here. */
const WALK_DEADLINE_MS = 300_000;
const POLL_MS = 500;
/** srt-win's own folder, whose Visual C++ runtime DLLs go with it wherever it is copied. */
const RUNTIME_DLLS = ["vcruntime140.dll", "vcruntime140_1.dll"];

const vendored = srtWinPath();
const cleanup: Array<() => Promise<void>> = [];

after(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
});

/** The walks this process's record of Genex's own entries under `root` still lists. */
function walksLeft(root: string): string[] {
  const record = path.join(root, "own", `${process.pid}.json`);
  if (!existsSync(record)) return [];
  const { walks } = JSON.parse(readFileSync(record, "utf8")) as { walks?: string[] };
  return walks ?? [];
}

/** A folder of the test's own under `%LOCALAPPDATA%`, in the profile like a per-user install. */
function profileFolder(name: string): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dir = path.join(local, `genex-test-${name}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(() => removeTree(dir));
  return realpathSync.native(dir);
}

/** srt-win copied into `dir`, which nothing has granted the sandbox user yet. */
function srtWinIn(dir: string): string {
  const exe = path.join(dir, "srt-win.exe");
  copyFileSync(vendored, exe);
  for (const dll of RUNTIME_DLLS) {
    const from = path.join(path.dirname(vendored), dll);
    if (existsSync(from)) copyFileSync(from, path.join(dir, dll));
  }
  return exe;
}

/** A session over the real srt-win runtime, Genex's own entries and the folder entries above the roots. */
async function realSession(options: {
  root: string;
  log: (line: string) => void;
  grantBudgetMs?: number;
  urgent?: (dir: string) => boolean;
}) {
  const srt = await import("@anthropic-ai/sandbox-runtime");
  const own = ownAclEntries(path.join(options.root, "own"), {
    sid: groupSidOnce(() => srtSandboxGroup(vendored)),
    log: options.log,
    ...(options.grantBudgetMs === undefined ? {} : { grantBudgetMs: options.grantBudgetMs }),
    ...(options.urgent ? { urgent: options.urgent } : {}),
  });
  const ancestors = ancestorGrants(path.join(options.root, "above"), {
    sid: sandboxSidOnce(() => srtAncestorGrantee(vendored)),
  });
  const session = new WindowsSandboxSession({
    runtime: srt.SandboxManager,
    profile: realpathSync.native(os.homedir()),
    ancestors,
    own,
    launchDirs: [],
    logonRetryMs: LOGON_PAUSES_MS,
    walkDelayMs: 0,
    log: options.log,
  });
  cleanup.push(async () => {
    await session.dispose();
    await own.revokeAll();
  });
  return { session, own };
}

/** The runtime config a `ProcessSandbox` with `workspace` would hand the session, with srt-win at `srtWin`. */
async function configFor(root: string, workspace: string, srtWin: string): Promise<SandboxRuntimeConfig> {
  const sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    enabled: false,
  });
  return { ...sandbox.toRuntimeConfig(sandbox.policy), windows: { srtWin: { path: srtWin } } };
}

describe("Windows sandbox: a start with a slow or refused step", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("starts again after a pause when Windows refused srt-win's start as the sandbox user", async () => {
    const root = realpathSync.native(await tmpDir("genex-refused-start-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    // srt-win in a new install folder in the profile, which the sandbox user cannot open yet.
    const install = profileFolder("install");
    const srtWin = srtWinIn(install);
    const group = await srtSandboxGroup(vendored);
    assert.ok(group, "the sandbox users' group");
    const logged: string[] = [];
    let opened: Promise<unknown> | null = null;
    const { session } = await realSession({
      root,
      log: (line) => {
        logged.push(line);
        // Once Windows refused, the folder opens to the sandbox user, as it did seconds later.
        if (line.startsWith("egress check: Windows refused") && !opened) {
          opened = editFolderOwn([
            {
              dir: install,
              sid: group,
              op: FolderAceOp.Own,
              deny: null,
              guard: false,
              grant: GrantAccess.Read,
              allows: true,
            },
          ]);
        }
      },
    });
    const started = performance.now();
    await session.join(
      {},
      { grants: { write: [workspace], read: [] }, config: await configFor(root, workspace, srtWin) },
    );
    const took = Math.round(performance.now() - started);
    console.log(`started in ${took} ms:\n${logged.join("\n")}`);
    assert.ok(opened, "Windows refused the first start, as a new install's can be");
    assert.ok(session.applied, "and the start went on once it no longer did");
  });

  it("does not wait for a large folder's walk past its budget, and passes it down after the start", async () => {
    const root = realpathSync.native(await tmpDir("genex-heavy-start-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    // A large toolchain in the profile, as a conda or a Python with its packages is.
    const heavy = profileFolder("toolchain");
    const seeded = performance.now();
    for (let folder = 0; folder < HEAVY_FOLDERS; folder++) {
      const dir = path.join(heavy, "lib", `package-${folder}`);
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < HEAVY_FILES; file++) writeFileSync(path.join(dir, `module-${file}.py`), "x = 1\n");
    }
    const deep = path.join(heavy, "lib", `package-${HEAVY_FOLDERS - 1}`, `module-${HEAVY_FILES - 1}.py`);
    console.log(`seeded ${HEAVY_FOLDERS * HEAVY_FILES} files in ${Math.round(performance.now() - seeded)} ms`);
    const logged: string[] = [];
    const { session } = await realSession({
      root,
      log: (line) => logged.push(line),
      grantBudgetMs: GRANT_BUDGET_MS,
      // The start needs its own folders in full; the toolchain can come after.
      urgent: (dir) => insideWindowsPath(root, dir),
    });
    const config = await configFor(root, workspace, vendored);
    const started = performance.now();
    await session.join({}, { grants: { write: [workspace], read: [heavy] }, config });
    const took = Math.round(performance.now() - started);
    const left = walksLeft(root);
    console.log(`started in ${took} ms, ${left.length} walk(s) after the start:\n${logged.join("\n")}`);
    assert.ok(
      left.some((dir) => insideWindowsPath(dir, heavy) && insideWindowsPath(heavy, dir)),
      `the large folder is passed down after the start (left: ${JSON.stringify(left)})`,
    );
    const walkStarted = performance.now();
    while (walksLeft(root).length > 0) {
      assert.ok(performance.now() - walkStarted < WALK_DEADLINE_MS, "the walk after the start finishes");
      await sleep(POLL_MS);
    }
    const walked = Math.round(performance.now() - walkStarted);
    const entries = execFileSync("icacls", [deep], { encoding: "utf8", windowsHide: true });
    console.log(`passed down after the start in ${walked} ms; the deepest file:\n${entries}`);
    assert.match(entries, /sandbox-runtime-users:\(I\)\(RX\)/, "the deepest file inherited the grant");
  });
});
