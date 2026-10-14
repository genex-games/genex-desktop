/**
 * The Windows and Linux lane for real: the shipped C++ template cross-built by the real CMake,
 * Ninja and zig from the developer's store (`$GENEX_DEV_TOOLCHAINS/dev-store`, at this worktree's
 * lock: `tests/helpers/dev-toolchains.ts`) under the real `ProcessSandbox`, with the network off and
 * the store write-denied, then admitted by the real PE and ELF gates against the store's ANGLE.
 * Tampered copies of the real outputs are refused, and the store is never written.
 *
 * Skipped where the dev store has no Windows and Linux prewarm for the lock (the CI runners);
 * required under `GENEX_REQUIRE_TOOLCHAINS=1`. The steps run in order on one game. The argv, the
 * timings, each output file's sha256 and the gates' facts go to `.studio-dev/evidence/raylib-W5-LANE/`,
 * with a copy of both `out/` trees under `outputs/`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind, type ProjectShape } from "../../src/shared/game-project.ts";
import { DestinationBadge } from "../../src/shared/game-targets.ts";
import { type DestinationCheck, NATIVE_CROSS_EXECUTABLES, NativeRefusal } from "../../src/shared/native-contract.ts";
import { cppLaneRunsOn, type ToolchainLock } from "../../src/shared/toolchain.ts";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { CppBuildPurpose, CppBuilds, type CppBuildInput } from "../../src/main/cpp-build.ts";
import type { BuildOutcome } from "../../src/main/game-build.ts";
import {
  admitCrossOutput,
  type CrossAdmission,
  type CrossAngle,
  type DesktopTarget,
} from "../../src/substrate/native-cross-admission.ts";
import { highestGlibc, LINUX_GAME_RUNPATH, LINUX_GLIBC_FLOOR, readElf } from "../../src/substrate/native-gate-elf.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { CROSS_TARGETS, crossTargetOf } from "../../src/substrate/toolchain-store/cross-targets.ts";
import { type LocatedToolchain, locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { DEV_TOOLCHAINS, devStoreLock, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { peManifest } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W5-LANE");
/** A cold cross build of the template (configure, and zig's libc and libc++ for the target) per destination. */
const REAL_BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
/** Bytes an asset of the game's own carries, which `out/assets` must hold. */
const PUBLIC_ASSET = "GENEX_PUBLIC_ASSET_5b7e";
/** Bytes a dotfile in `assets/` carries, which `out/assets` must never hold. */
const ENV_SECRET = "GENEX_ENV_SECRET_c41d";
/** The ANGLE import every Windows game names, and the RUNPATH rewrite of the Linux tamper row (same length). */
const WINDOWS_GLES = "libGLESv2.dll";
const OPENGL32_IN_PLACE = "opengl32.dll\0";
const FOREIGN_RUNPATH = "/tmp/xx";
/** `IMAGE_FILE_MACHINE_ARM64`: a PE header machine that is not x64. */
const PE_MACHINE_ARM64 = 0xaa64;
/** Where a PE file says its headers start (`e_lfanew`). */
const PE_LFANEW_AT = 0x3c;
/** Bytes from the PE signature to the COFF header's machine field. */
const PE_SIGNATURE_BYTES = 4;
/** What a build host's own folders look like inside a binary. */
const HOST_FOLDER = "/Users/";
/**
 * How much of each run's output the evidence log keeps: its end, where the errors are (a cold
 * build prints megabytes of zig's own libc++ warnings first).
 */
const EVIDENCE_LOG_TAIL_CHARS = 16 * 1024;
/** Debug files the evidence copy of `out/` leaves out, as an export does: a `.pdb` names the build host's folders. */
const DEBUG_FILE = /\.pdb$/i;
/** The second copy of the starter: a folder named unlike the first (`pong`), of another length. */
const SECOND_COPY = "a-second-copy-of-the-starter";
/** `e_lfanew`'s distance to the COFF header's TimeDateStamp: the signature, then machine and section count. */
const PE_TIMESTAMP_FROM_HEADER = 8;

const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

const CROSS = [BuildTarget.Windows, BuildTarget.Linux] as const;

/** The lane runs on a Mac or Linux host; Windows hosts are refused (`cppLaneRunsOn`). */
const LANE_HOST = cppLaneRunsOn(process.platform) ? {} : { skip: "not run: the C++ lane does not build on Windows" };

/** Every entry under `dir` (links not followed) with its size, mtime and mode: a store that was written differs. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const rel of await readdir(dir, { recursive: true })) {
    const info = await lstat(path.join(dir, rel));
    found.set(rel, `${info.size}:${info.mtimeMs}:${info.mode}`);
  }
  return found;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `dir`, `/`-joined, with its sha256 and size. */
async function treeDigests(dir: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  const found: Record<string, { sha256: string; bytes: number }> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((each) => each.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(file);
    found[path.relative(dir, file).split(path.sep).join("/")] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** `bytes` with every `from` rewritten in place to `to` (the same length), and how many there were. */
function rewritten(bytes: Buffer, from: string, to: string): { bytes: Buffer; count: number } {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to), "an in-place rewrite keeps the length");
  const copy = Buffer.from(bytes);
  const needle = Buffer.from(from);
  let count = 0;
  for (let at = copy.indexOf(needle); at >= 0; at = copy.indexOf(needle, at + needle.length)) {
    copy.write(to, at, "latin1");
    count++;
  }
  return { bytes: copy, count };
}

/** `"2.28"` as comparable numbers. */
const versionParts = (version: string) => version.split(".").map(Number);

function atMost(version: string, ceiling: string): boolean {
  const [a, b] = [versionParts(version), versionParts(ceiling)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x = 0, y = 0] = [a[i], b[i]];
    if (x !== y) return x < y;
  }
  return true;
}

/** One tamper row's answer, for the evidence. */
interface Tampered {
  name: string;
  target: DesktopTarget;
  refusal: NativeRefusal | null;
  file: string | null;
  detail: string | null;
}

/** Everything the steps share: the store, the game, the sandbox, the lane and what they recorded. */
interface RealCrossLane {
  store: string;
  lock: ToolchainLock;
  located: Record<DesktopTarget, LocatedToolchain>;
  root: string;
  game: string;
  sandbox: ProcessSandbox;
  builds: CppBuilds;
  runs: Array<{ request: RunRequest; result: RunResult }>;
  checks: Array<[string, BuildTarget, DestinationCheck]>;
  storeBefore: Map<string, Map<string, string>>;
  timings: Record<string, number>;
  outs: Partial<Record<DesktopTarget, string>>;
  admissions: Partial<Record<DesktopTarget, CrossAdmission>>;
  tampered: Tampered[];
  /** The two Windows builds of the starter in two folders: each game.exe's sha256 and the bytes that differ. */
  reproducible: { first: string; second: string; differing: number; pdbs: string[] } | null;
}

/** The store folders a cross build reads: zig, each ANGLE, the sysroot and the lock folder. */
function readFolders(located: Record<DesktopTarget, LocatedToolchain>): string[] {
  const folders = CROSS.flatMap((target) => {
    const toolchain = located[target];
    const files = toolchain.cross?.[target];
    return [
      path.dirname(toolchain.zig ?? ""),
      files?.angle.dir ?? "",
      files?.sysroot ?? "",
      path.dirname(toolchain.genexCmake[target] ?? ""),
    ];
  });
  return [...new Set(folders.filter((folder) => folder !== "" && folder !== "."))];
}

/** The store's toolchain for one cross destination at `lock`, which the dev store must have prewarmed. */
async function locateFor(store: string, lock: ToolchainLock, target: DesktopTarget): Promise<LocatedToolchain> {
  const found = await locateToolchain(store, lock, [target]);
  assert.ok(found.ok, `${target}: ${JSON.stringify(found)}`);
  return found.toolchain;
}

async function locateCross(store: string, lock: ToolchainLock): Promise<Record<DesktopTarget, LocatedToolchain>> {
  return {
    [BuildTarget.Windows]: await locateFor(store, lock, BuildTarget.Windows),
    [BuildTarget.Linux]: await locateFor(store, lock, BuildTarget.Linux),
  };
}

async function setUp(): Promise<RealCrossLane> {
  const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
  const toolchains = await realpath(DEV_TOOLCHAINS);
  const lock = await devStoreLock();
  assert.ok(lock, "the dev store has a lock for this worktree");
  const located = await locateCross(store, lock);
  const root = await realpath(await tmpDir("cross-lane-real-"));
  const layout = layoutFor(path.join(root, "userData"));
  const game = path.join(root, "games", "pong");
  await cp(TEMPLATE, game, { recursive: true });
  await writeFile(path.join(game, "assets", "genex-public.txt"), PUBLIC_ASSET);
  await writeFile(path.join(game, "assets", ".env"), ENV_SECRET);
  const sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: layout.scratch,
    secretPaths: [],
    denyWrite: [...studioBaseDenyWrites(layout, [game]), store, toolchains],
  });
  const runs: RealCrossLane["runs"] = [];
  const checks: RealCrossLane["checks"] = [];
  const builds = new CppBuilds({
    root: layout.cppBuilds,
    run: async (request) => {
      const result = await sandbox.run(request);
      runs.push({ request, result });
      return result;
    },
    locate: (wanted, targets) => locateToolchain(store, wanted, targets),
    currentLock: () => devStoreLock(),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [store, toolchains, layout.nativeRuns],
    writeLock: async () => {},
    writeCheck: async (project, target, check) => {
      checks.push([project, target, check]);
    },
  });
  const storeBefore = new Map<string, Map<string, string>>();
  for (const folder of readFolders(located)) storeBefore.set(folder, await snapshot(folder));
  return {
    store,
    lock,
    located,
    root,
    game,
    sandbox,
    builds,
    runs,
    checks,
    storeBefore,
    timings: {},
    outs: {},
    admissions: {},
    tampered: [],
    reproducible: null,
  };
}

function input(dir: string, target: DesktopTarget): CppBuildInput {
  return {
    project: "pong",
    dir,
    shape: RAYLIB_SHAPE,
    target,
    destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, ...CROSS] },
    purpose: CppBuildPurpose.Live,
    lock: null,
    recordLock: true,
  };
}

async function timed(work: () => Promise<BuildOutcome>): Promise<{ outcome: BuildOutcome; ms: number }> {
  const started = performance.now();
  const outcome = await work();
  return { outcome, ms: Math.round(performance.now() - started) };
}

/** `target`'s out/ for the game at `dir` (built through the lane now unless an earlier row already did). */
async function builtOut(lane: RealCrossLane, project: string, dir: string, target: DesktopTarget): Promise<string> {
  const earlier = dir === lane.game ? lane.outs[target] : undefined;
  if (earlier) return earlier;
  const { outcome, ms } = await timed(() => lane.builds.ensure({ ...input(dir, target), project }));
  lane.timings[`${target}:${project}`] = ms;
  assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
  return outcome.output ?? "";
}

/** How many bytes differ between two files of one length (every byte past the shorter one counts). */
function differingBytes(a: Buffer, b: Buffer): number {
  let count = Math.abs(a.length - b.length);
  for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) count++;
  return count;
}

/** A PE file's COFF TimeDateStamp, for the evidence of two builds that differ. */
const peTimestamp = (exe: Buffer) => exe.readUInt32LE(exe.readUInt32LE(PE_LFANEW_AT) + PE_TIMESTAMP_FROM_HEADER);

/** The lock's raylib prebuild for a cross destination: `<lock folder>/raylib-<variant>/lib/libraylib.a`. */
function prebuildArchive(lane: RealCrossLane, target: DesktopTarget): string {
  const cross = crossTargetOf(target);
  const module = lane.located[target].genexCmake[target];
  assert.ok(cross && module, `${target} is a prewarmed cross destination`);
  return path.join(path.dirname(module), `raylib-${CROSS_TARGETS[cross].raylib}`, "lib", "libraylib.a");
}

/** The lock's store ANGLE for `target`, which every admission here is checked against. */
function angleOf(lane: RealCrossLane, target: DesktopTarget): CrossAngle {
  const angle = lane.located[target].cross?.[target]?.angle;
  assert.ok(angle, `${target} has a store ANGLE`);
  return angle;
}

/** A copy of `target`'s real `out/`, changed by `tamper`, through the real gate. */
async function tamperedCopy(
  lane: RealCrossLane,
  target: DesktopTarget,
  name: string,
  tamper: (copy: string) => Promise<void>,
): Promise<CrossAdmission> {
  const out = lane.outs[target];
  assert.ok(out, `${target} was built`);
  const copy = path.join(lane.root, "tampered", `${target}-${lane.tampered.length}`);
  await cp(out, copy, { recursive: true });
  await tamper(copy);
  const admission = await admitCrossOutput({ target, out: copy, angle: angleOf(lane, target) });
  lane.tampered.push({
    name,
    target,
    refusal: admission.ok ? null : admission.refusal,
    file: admission.ok ? null : admission.file,
    detail: admission.ok ? null : admission.detail,
  });
  return admission;
}

/** Rewrites the file at `file` through `change`, in place. */
async function rewrite(file: string, change: (bytes: Buffer) => Buffer): Promise<void> {
  await writeFile(file, change(await readFile(file)));
}

async function writeEvidence(lane: RealCrossLane): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const outputs: Record<string, unknown> = {};
  for (const target of CROSS) {
    const out = lane.outs[target];
    if (!out) continue;
    outputs[target] = await treeDigests(out);
    await cp(out, path.join(EVIDENCE, "outputs", target), {
      recursive: true,
      force: true,
      filter: (source) => !DEBUG_FILE.test(source),
    });
  }
  const admissions = Object.fromEntries(
    Object.entries(lane.admissions).map(([target, admission]) => [
      target,
      admission.ok ? { ok: true, facts: admission.facts } : admission,
    ]),
  );
  const evidence = {
    at: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    lock: lane.lock.digest,
    cross: Object.fromEntries(CROSS.map((target) => [target, lane.located[target].cross?.[target] ?? null])),
    zig: lane.located[BuildTarget.Windows].zig ?? null,
    argv: lane.runs.map(({ request }) => request.command),
    env: lane.runs.map(({ request }) => request.env ?? null),
    sandboxed: lane.runs.map(({ result }) => result.sandboxed),
    runMs: lane.runs.map(({ request, result }) => ({ cwd: request.cwd, code: result.code, ms: result.durationMs })),
    timingsMs: lane.timings,
    outputs,
    admissions,
    checks: lane.checks,
    tampered: lane.tampered,
    reproducible: lane.reproducible,
  };
  await writeFile(path.join(EVIDENCE, "cross-lane-real.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const tail = (text: string) => text.slice(-EVIDENCE_LOG_TAIL_CHARS);
  const logs = lane.runs.map(
    ({ request, result }) => `$ ${request.command}\n${tail(result.stdout)}\n${tail(result.stderr)}`,
  );
  await writeFile(path.join(EVIDENCE, "cross-lane-real.log"), `${logs.join("\n---\n")}\n`);
}

describe("the Windows and Linux lane, for real", {
  ...LANE_HOST,
  ...needsTools("devStore", "zig"),
  ...needsPrewarmed(...CROSS),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let lane: RealCrossLane;
  before(async () => {
    lane = await setUp();
  });
  after(async () => {
    if (!lane) return;
    await writeEvidence(lane);
    await lane.sandbox.dispose();
  });

  for (const target of CROSS) {
    it(`cross-builds the starter for ${target} under the sandbox, admits out/ and records the honest check`, async () => {
      const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game, target)));
      lane.timings[`${target}Cold`] = ms;
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
      const out = outcome.output ?? "";
      lane.outs[target] = out;
      assert.ok((await lstat(path.join(out, NATIVE_CROSS_EXECUTABLES[target]))).isFile());
      assert.ok(
        lane.runs.every(({ result }) => result.sandboxed),
        "every run was sandboxed",
      );
      const admission = await admitCrossOutput({ target, out, angle: angleOf(lane, target) });
      lane.admissions[target] = admission;
      assert.equal(admission.ok, true, JSON.stringify(admission));
      const runsHere = process.platform === StudioPlatform.Linux && target === BuildTarget.Linux;
      const badge = runsHere ? DestinationBadge.Built : DestinationBadge.NotRunHere;
      const recorded = lane.checks.filter(([, checked]) => checked === target).map(([, , check]) => check);
      assert.deepEqual(
        recorded.map((check) => [check.badge, check.lock, check.refusal]),
        [[badge, lane.lock.digest.slice(0, 12), undefined]],
      );
    });
  }

  it("copies the game's own assets into out/assets for both, never a dotfile", async () => {
    for (const target of CROSS) {
      const assets = path.join(lane.outs[target] ?? "", "assets");
      assert.equal(await readFile(path.join(assets, "genex-public.txt"), "utf8"), PUBLIC_ASSET, target);
      assert.equal(
        await lstat(path.join(assets, ".env")).catch(() => null),
        null,
        `${target}: assets/.env never lands`,
      );
    }
  });

  it("gives Windows a game.exe that imports ANGLE's libGLESv2.dll, never opengl32.dll, and names no build-host folder", async () => {
    const admission = lane.admissions[BuildTarget.Windows];
    assert.ok(admission?.ok);
    const imports = admission.facts.imports.map((name) => name.toLowerCase());
    assert.ok(imports.includes(WINDOWS_GLES.toLowerCase()), imports.join(", "));
    assert.ok(!imports.includes("opengl32.dll"), imports.join(", "));
    const exe = await readFile(path.join(lane.outs[BuildTarget.Windows] ?? "", NATIVE_CROSS_EXECUTABLES.windows));
    for (const folder of [HOST_FOLDER, lane.root, lane.store, os.homedir()]) {
      assert.equal(exe.includes(folder), false, `game.exe names ${folder}`);
    }
  });

  it("two builds of the starter in two different folders give a byte-identical game.exe, and no game.pdb names either folder", async () => {
    const second = path.join(lane.root, "games", SECOND_COPY);
    await cp(TEMPLATE, second, { recursive: true });
    await writeFile(path.join(second, "assets", "genex-public.txt"), PUBLIC_ASSET);
    const outs = [
      await builtOut(lane, "pong", lane.game, BuildTarget.Windows),
      await builtOut(lane, SECOND_COPY, second, BuildTarget.Windows),
    ];
    assert.notEqual(outs[0], outs[1], "two build folders");
    const [first, other] = await Promise.all(
      outs.map((out) => readFile(path.join(out, NATIVE_CROSS_EXECUTABLES[BuildTarget.Windows]))),
    );
    assert.ok(first && other);
    const pdbs = (await Promise.all(outs.map((out) => readdir(out)))).flat().filter((name) => DEBUG_FILE.test(name));
    lane.reproducible = { first: sha256(first), second: sha256(other), differing: differingBytes(first, other), pdbs };
    assert.equal(
      sha256(other),
      sha256(first),
      `game.exe differs in ${lane.reproducible.differing} bytes (TimeDateStamp ${peTimestamp(first)} vs ${peTimestamp(other)})`,
    );
    assert.deepEqual(pdbs, [], "no debug file beside game.exe names the build folder");
  });

  it("builds from Windows and Linux raylib prebuilds that name no build-host folder", async () => {
    for (const target of CROSS) {
      const archive = await readFile(prebuildArchive(lane, target));
      for (const folder of [HOST_FOLDER, lane.store, os.homedir()])
        assert.equal(archive.includes(folder), false, `${target}'s libraylib.a names ${folder}`);
    }
  });

  it("gives Windows a game.exe whose manifest asks for the UTF-8 code page on Windows 10", async () => {
    const exe = await readFile(path.join(lane.outs[BuildTarget.Windows] ?? "", NATIVE_CROSS_EXECUTABLES.windows));
    const manifest = peManifest(exe);
    assert.ok(manifest, "game.exe has an RT_MANIFEST resource");
    assert.match(manifest, /<activeCodePage[^>]*>UTF-8<\/activeCodePage>/);
    assert.match(manifest, /<supportedOS Id="\{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a\}"\/>/);
  });

  it("gives Linux a stripped game with RUNPATH exactly $ORIGIN, no DT_RPATH, glibc at most 2.28, libGLESv2.so and never libGL", async () => {
    const exe = path.join(lane.outs[BuildTarget.Linux] ?? "", NATIVE_CROSS_EXECUTABLES.linux);
    const bytes = await readFile(exe);
    for (const folder of [HOST_FOLDER, lane.root, lane.store, os.homedir()]) {
      assert.equal(bytes.includes(folder), false, `game names ${folder}`);
    }
    const image = await readElf(exe);
    assert.deepEqual(image.runpath, [LINUX_GAME_RUNPATH]);
    assert.deepEqual(image.rpath, []);
    const glibc = highestGlibc(image);
    assert.ok(glibc && atMost(glibc, LINUX_GLIBC_FLOOR), `newest glibc ${glibc}`);
    assert.ok(image.needed.includes("libGLESv2.so"), image.needed.join(", "));
    assert.deepEqual(
      image.needed.filter((name) => /^libGL(?:X|\.so)/.test(name)),
      [],
      "no desktop OpenGL",
    );
    const admission = lane.admissions[BuildTarget.Linux];
    assert.ok(admission?.ok);
    assert.equal(admission.facts.maxGlibc, glibc);
  });

  it("refuses a game.exe whose libGLESv2.dll import was rewritten to opengl32.dll as imports-opengl32", async () => {
    const admission = await tamperedCopy(lane, BuildTarget.Windows, "import rewritten to opengl32.dll", (copy) =>
      rewrite(path.join(copy, "game.exe"), (bytes) => {
        const changed = rewritten(bytes, WINDOWS_GLES, OPENGL32_IN_PLACE);
        assert.ok(changed.count >= 1, "the import name is in the file");
        return changed.bytes;
      }),
    );
    assert.equal(admission.ok, false);
    assert.equal(admission.ok || admission.refusal, NativeRefusal.ImportsOpengl32);
    assert.equal(admission.ok || admission.file, "game.exe");
  });

  for (const extra of ["foo.dll", "foo.exe"]) {
    it(`refuses an extra ${extra} beside game.exe as extra-pe`, async () => {
      const admission = await tamperedCopy(lane, BuildTarget.Windows, `extra ${extra}`, (copy) =>
        cp(path.join(copy, "game.exe"), path.join(copy, extra)),
      );
      assert.equal(admission.ok || admission.refusal, NativeRefusal.ExtraPe);
      assert.equal(admission.ok || admission.file, extra);
    });
  }

  it("refuses a game.exe whose PE header names another machine than x64 as wrong-machine", async () => {
    const admission = await tamperedCopy(lane, BuildTarget.Windows, "PE machine arm64", (copy) =>
      rewrite(path.join(copy, "game.exe"), (bytes) => {
        const changed = Buffer.from(bytes);
        changed.writeUInt16LE(PE_MACHINE_ARM64, changed.readUInt32LE(PE_LFANEW_AT) + PE_SIGNATURE_BYTES);
        return changed;
      }),
    );
    assert.equal(admission.ok || admission.refusal, NativeRefusal.WrongMachine);
    assert.equal(admission.ok || admission.file, "game.exe");
  });

  it("refuses a game whose RUNPATH was rewritten from $ORIGIN to /tmp/xx as runpath-not-origin", async () => {
    const admission = await tamperedCopy(lane, BuildTarget.Linux, "RUNPATH rewritten to /tmp/xx", (copy) =>
      rewrite(path.join(copy, "game"), (bytes) => {
        const changed = rewritten(bytes, LINUX_GAME_RUNPATH, FOREIGN_RUNPATH);
        assert.ok(changed.count >= 1, "the RUNPATH is in the file");
        return changed.bytes;
      }),
    );
    assert.equal(admission.ok || admission.refusal, NativeRefusal.RunpathNotOrigin);
    assert.equal(admission.ok || admission.file, "game");
  });

  it("admits the store's own libGLESv2.so beside the game, and refuses one that differs from it", async () => {
    const storeCopy = path.join(angleOf(lane, BuildTarget.Linux).dir, "libGLESv2.so");
    const same = await tamperedCopy(lane, BuildTarget.Linux, "the store's libGLESv2.so", (copy) =>
      cp(storeCopy, path.join(copy, "libGLESv2.so")),
    );
    assert.equal(same.ok, true, JSON.stringify(same));
    const differing = await tamperedCopy(
      lane,
      BuildTarget.Linux,
      "a libGLESv2.so differing from the store's",
      async (copy) => {
        await cp(storeCopy, path.join(copy, "libGLESv2.so"));
        await appendFile(path.join(copy, "libGLESv2.so"), "\0");
      },
    );
    assert.equal(differing.ok || differing.refusal, NativeRefusal.ExtraSharedObject);
    assert.equal(differing.ok || differing.file, "libGLESv2.so");
  });

  for (const target of CROSS) {
    it(`refuses a symlink in ${target}'s out/ as symlink`, async () => {
      const admission = await tamperedCopy(lane, target, "a symlink in out/", (copy) =>
        symlink(path.join(lane.root, "games"), path.join(copy, "linked")),
      );
      assert.equal(admission.ok || admission.refusal, NativeRefusal.Symlink);
      assert.equal(admission.ok || admission.file, "linked");
    });
  }

  it("reuses the build folder: a second build of each finds no work and serves the same out/", async () => {
    for (const target of CROSS) {
      const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game, target)));
      lane.timings[`${target}Again`] = ms;
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
      assert.equal(outcome.output, lane.outs[target]);
      assert.match(lane.runs.at(-1)?.result.stdout ?? "", /ninja: no work to do/, target);
    }
  });

  it("says where a real zig compile error is, and keeps the admitted build to fall back on", async () => {
    const main = path.join(lane.game, "src", "main.cpp");
    const source = await readFile(main, "utf8");
    const lines = source.split("\n");
    await writeFile(main, [...lines, "int genex_cross_forced_error = genex_undeclared_identifier;", ""].join("\n"));
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game, BuildTarget.Linux)));
    lane.timings.linuxCompileError = ms;
    await writeFile(main, source);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.lastGood, lane.outs[BuildTarget.Linux], "the admitted out/ is the fallback");
    const [diagnostic] = outcome.problem?.diagnostics ?? [];
    assert.equal(diagnostic?.file, "src/main.cpp");
    assert.equal(diagnostic?.line, lines.length + 1);
    assert.match(diagnostic?.message ?? "", /genex_undeclared_identifier/);
  });

  it("wrote nothing under the store's zig, ANGLE, sysroot or lock folder", async () => {
    for (const [folder, before] of lane.storeBefore) {
      assert.deepEqual(changed(before, await snapshot(folder)), [], `${folder} is unchanged`);
    }
  });
});
