/**
 * The Rust spike's CI steps (M0a.13): `scripts/ci/rust-spike.ts` owns every step of
 * `.github/workflows/rust-spike.yml` (the workflow only calls `--step <id>`), so the rows here test
 * the script through its CLI and its exported checks, on any POSIX host and with no GPU:
 *
 * - the step table names every row the plan asks for (build the pond, headless capture on software
 *   Vulkan with the core-adapter assertion, Chrome WebGPU web row, Firefox unsupported-page row,
 *   Electron WebGPU probe, cross builds, the Windows WARP row with the decoy `dxcompiler.dll`) and
 *   the workflow file is held to it, including the dispatch-only Windows job;
 * - a fake `pond` binary stands in for the real one: a blank capture, a digest that is not the
 *   file's, a receipt that is not tier core and an adapter that is not software are each refused
 *   with their typed code; SwiftShader refused falls back to lavapipe, both refused is the plan's
 *   KILL (`no-compliant-software-vulkan`); the Windows row refuses a decoy that was loaded, a
 *   backend that is not D3D12 and a WARP adapter below core (`warp-not-compliant`, the KILL);
 * - the Electron probe record is judged as recorded, not as a kill, when there is no WebGPU.
 *
 * The real row (`--local` on this machine's GPU) needs the spike toolchain (`setup-toolchain.sh`):
 * it skips without it, and `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1` turns that skip into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import {
  cargoArtifact,
  checkCargoTest,
  checkCaptures,
  checkDecoyUnused,
  checkElectronRecord,
  checkReceipt,
  checkUnsupportedShell,
  checkWorkflow,
  compareProbes,
  distinctColours,
  fnv1a64,
  Job,
  SpikeCiCode,
  SpikeCiError,
  STEP_TABLE,
  StepId,
  StepStatus,
  VulkanSource,
  workflowJobs,
} from "../../scripts/ci/rust-spike.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "ci", "rust-spike.ts");
const SPIKE_CARGO = path.join(REPO, ".studio-dev", "spike-toolchain", "sysroot", "bin", "cargo");
const REFUSAL_PREFIX = "genex-spike-ci: ";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SCRIPT_TIMEOUT_MS = 30 * MINUTE_MS;
const POSIX_ONLY = process.platform === "win32" ? { skip: "the fake binaries are POSIX scripts" } : {};
const CAPTURE_SIDE = 16;
const MIN_COLOURS = 16;
const SWIFTSHADER_ADAPTER = "SwiftShader Device (Subzero)";
const LAVAPIPE_ADAPTER = "llvmpipe (LLVM 17.0.6, 256 bits)";
const WARP_ADAPTER = "Microsoft Basic Render Driver";
const NO_ERROR = "no error";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ...env }, maxBuffer: MAX_OUTPUT_BYTES, timeout: SCRIPT_TIMEOUT_MS, cwd: REPO },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** The typed refusal line on stderr, or null. */
function refusal(run: Run): { code: string; detail: string } | null {
  const line = run.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
  return line ? (JSON.parse(line.slice(REFUSAL_PREFIX.length)) as { code: string; detail: string }) : null;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SpikeCiError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SpikeCiError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

/** BGRA bytes: a gradient (many colours) or one flat colour (blank). */
function bgra(kind: "gradient" | "blank"): Uint8Array {
  const bytes = new Uint8Array(CAPTURE_SIDE * CAPTURE_SIDE * 4);
  if (kind === "blank") return bytes;
  for (let i = 0; i < CAPTURE_SIDE * CAPTURE_SIDE; i++) {
    bytes.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  }
  return bytes;
}

function goodReceipt(adapter: string, backend = "vulkan"): Record<string, unknown> {
  return { tier: "core", backend, adapter, nativeEnhanced: [] };
}

/** A fake `pond` (a Node script): the self-test contract of the real one, steered by FAKE_POND_MODE. */
const fakePondSource = (nodePath: string) => `#!${nodePath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const mode = process.env.FAKE_POND_MODE || "good";
const icd = process.env.VK_DRIVER_FILES || "";
const refuse = () => {
  console.error("pond: " + JSON.stringify({ code: "gpu-unsupported", detail: "fake adapter below core" }));
  process.exit(1);
};
if (mode === "refuse-all") refuse();
if (mode === "refuse-swiftshader" && /swiftshader/i.test(icd)) refuse();
if (mode === "crash") { console.error("pond: " + JSON.stringify({ code: "device-failed", detail: "fake" })); process.exit(1); }
if (mode.startsWith("windows")) {
  const first = (process.env.PATH || "").split(path.delimiter)[0];
  if (!fs.existsSync(path.join(first, "dxcompiler.dll"))) { console.error("decoy not first on PATH: " + first); process.exit(3); }
  if (mode === "windows-decoy") fs.writeFileSync(path.join(first, "dxcompiler.dll.loaded"), "loaded");
}
const side = ${CAPTURE_SIDE};
const bytes = Buffer.alloc(side * side * 4);
if (mode !== "blank") for (let i = 0; i < side * side; i++) bytes.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
const fnv = (b) => { let h = 0xcbf29ce484222325n; for (const x of b) h = BigInt.asUintN(64, (h ^ BigInt(x)) * 0x100000001b3n); return h.toString(16).padStart(16, "0"); };
const dir = path.join(get("--state-dir"), "captures");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "1.bgra"), bytes);
const digest = mode === "bad-digest" ? "0".repeat(16) : fnv(bytes);
const ticks = Number(get("--self-test"));
fs.writeFileSync(get("--out"), JSON.stringify({ format: "genex-self-test/1", game: "pond", seed: 1, demo: "cast", ticks, frame: ticks, checksum: "00ff", probes: { fishing: { casts: 1 } }, captures: [{ tick: ticks, width: side, height: side, digest }] }));
const software = /swiftshader/i.test(icd) ? ${JSON.stringify(SWIFTSHADER_ADAPTER)} : ${JSON.stringify(LAVAPIPE_ADAPTER)};
const receipts = {
  downlevel: { tier: "downlevel", backend: "vulkan", adapter: "x", nativeEnhanced: [] },
  gl: { tier: "core", backend: "gl", adapter: "x", nativeEnhanced: [] },
  hardware: { tier: "core", backend: "vulkan", adapter: "Apple M4 Max", nativeEnhanced: [] },
};
const windows = { tier: "core", backend: process.env.FAKE_POND_BACKEND || "d3d12", adapter: ${JSON.stringify(WARP_ADAPTER)}, nativeEnhanced: [] };
const fallback = mode.startsWith("windows") ? windows : { tier: "core", backend: "vulkan", adapter: software, nativeEnhanced: [] };
fs.writeFileSync(get("--receipt"), JSON.stringify(receipts[mode] || fallback));
`;

async function fakePond(dir: string, name = "pond"): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, fakePondSource(process.execPath));
  await chmod(file, 0o755);
  return file;
}

/** A software-Vulkan CLI environment: two ICD manifests that exist (the fake reads only their names). */
async function icdEnv(dir: string, mode: string, swiftshader = true): Promise<NodeJS.ProcessEnv> {
  const swiftshaderIcd = path.join(dir, "vk_swiftshader_icd.json");
  const lavapipeIcd = path.join(dir, "lvp_icd.json");
  await writeFile(swiftshaderIcd, "{}");
  await writeFile(lavapipeIcd, "{}");
  return {
    FAKE_POND_MODE: mode,
    GENEX_SPIKE_SWIFTSHADER_ICD: swiftshader ? swiftshaderIcd : path.join(dir, "absent.json"),
    GENEX_SPIKE_LAVAPIPE_ICD: lavapipeIcd,
  };
}

const headlessArgs = (pond: string, evidence: string) => [
  "--step",
  StepId.HeadlessSoftwareVulkan,
  "--vulkan",
  VulkanSource.Software,
  "--pond",
  pond,
  "--ticks",
  "30",
  "--evidence",
  evidence,
];

async function stepRecord(dir: string, id: string) {
  return JSON.parse(await readFile(path.join(dir, `${id}.json`), "utf8"));
}

describe("the step table", () => {
  it("names every row the plan asks for, in order, with the Windows row on its own job", () => {
    assert.deepEqual(
      STEP_TABLE.map((step) => step.id),
      [
        StepId.Toolchain,
        StepId.BuildPond,
        StepId.FxcExplicit,
        StepId.HeadlessSoftwareVulkan,
        StepId.WebBuild,
        StepId.WebChrome,
        StepId.WebFirefox,
        StepId.ElectronProbe,
        StepId.CrossBuilds,
        StepId.LinuxGlibcFloor,
        StepId.WindowsWarp,
      ],
    );
    for (const step of STEP_TABLE) {
      assert.equal(step.job, step.id === StepId.WindowsWarp ? Job.Windows : Job.Linux, step.id);
      assert.ok(step.title.length > 0, `${step.id} has a title`);
    }
  });

  it("prints as JSON", async () => {
    const run = await runScript(["--table"]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      (JSON.parse(run.stdout) as Array<{ id: string }>).map((step) => step.id),
      STEP_TABLE.map((step) => step.id),
    );
  });
});

describe("the workflow", () => {
  const LINUX_IDS = STEP_TABLE.filter((s) => s.job === Job.Linux && !s.deferred).map((s) => s.id);
  const DISPATCH_ONLY = "github.event_name == 'workflow_dispatch'";
  const callsOf = (ids: string[]) => ids.map((id) => `      - run: node scripts/ci/rust-spike.ts --step ${id}`);
  const jobText = (linux: string[], windows: string[], windowsIf = DISPATCH_ONLY) =>
    [
      "jobs:",
      "  linux:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      ...callsOf(linux),
      "  windows:",
      "    needs: linux",
      `    if: ${windowsIf}`,
      "    runs-on: windows-2025",
      "    steps:",
      ...callsOf(windows),
      "",
    ].join("\n");
  const good = jobText(LINUX_IDS, [StepId.WindowsWarp]);

  it("reads its jobs and the steps each one calls", () => {
    assert.deepEqual(
      workflowJobs(good).map((job) => [job.name, job.stepIds.length]),
      [
        ["linux", LINUX_IDS.length],
        ["windows", 1],
      ],
    );
    assert.equal(
      codeOf(() => checkWorkflow(good)),
      NO_ERROR,
    );
  });

  const WITHOUT_FIREFOX = LINUX_IDS.filter((id) => id !== StepId.WebFirefox);
  const HOSTILE: ReadonlyArray<[string, string, string]> = [
    [
      "a step the table has not got",
      jobText([...LINUX_IDS, "make-coffee"], [StepId.WindowsWarp]),
      SpikeCiCode.UnknownStep,
    ],
    ["a Linux step left out", jobText(WITHOUT_FIREFOX, [StepId.WindowsWarp]), SpikeCiCode.WorkflowDrift],
    ["the Windows step on the Linux job", jobText([...LINUX_IDS, StepId.WindowsWarp], []), SpikeCiCode.WorkflowDrift],
    [
      "a Linux step on the Windows job",
      jobText(LINUX_IDS, [StepId.WindowsWarp, StepId.BuildPond]),
      SpikeCiCode.WorkflowDrift,
    ],
    [
      "a Windows job that runs on every push",
      jobText(LINUX_IDS, [StepId.WindowsWarp], "always()"),
      SpikeCiCode.WorkflowDrift,
    ],
    ["a Windows job with no condition", good.replace(/ {4}if: .*\n/, ""), SpikeCiCode.WorkflowDrift],
    ["a step called twice", jobText([...LINUX_IDS, StepId.BuildPond], [StepId.WindowsWarp]), SpikeCiCode.WorkflowDrift],
    [
      "a Linux step mentioned only in a comment",
      jobText(WITHOUT_FIREFOX, [StepId.WindowsWarp]).replace(
        "    steps:\n",
        `    steps:\n      # node scripts/ci/rust-spike.ts --step ${StepId.WebFirefox}\n`,
      ),
      SpikeCiCode.WorkflowDrift,
    ],
    [
      "a Linux step mentioned only in a step name",
      jobText(WITHOUT_FIREFOX, [StepId.WindowsWarp]).replace(
        "    steps:\n",
        `    steps:\n      - name: rust-spike.ts --step ${StepId.WebFirefox}\n        run: echo skipped\n`,
      ),
      SpikeCiCode.WorkflowDrift,
    ],
    [
      "a step whose own if: can skip its call",
      jobText(LINUX_IDS, [StepId.WindowsWarp]).replace(
        `      - run: node scripts/ci/rust-spike.ts --step ${StepId.BuildPond}\n`,
        `      - if: \${{ false }}\n        run: node scripts/ci/rust-spike.ts --step ${StepId.BuildPond}\n`,
      ),
      SpikeCiCode.WorkflowDrift,
    ],
  ];
  it("reads a call in a block run and keeps a call under if: !cancelled()", () => {
    const text = jobText(WITHOUT_FIREFOX, [StepId.WindowsWarp]).replace(
      "    steps:\n",
      `    steps:\n      - name: Firefox\n        if: \${{ !cancelled() }}\n        run: |\n          echo first\n          node scripts/ci/rust-spike.ts --step ${StepId.WebFirefox} --evidence x\n`,
    );
    assert.equal(
      codeOf(() => checkWorkflow(text)),
      NO_ERROR,
    );
  });

  for (const [name, text, code] of HOSTILE) {
    it(`refuses ${name}`, () => {
      assert.equal(
        codeOf(() => checkWorkflow(text)),
        code,
      );
    });
  }
});

describe("fnv1a64 and the colour count", () => {
  it("matches the published FNV-1a 64 vectors", () => {
    assert.equal(fnv1a64(new Uint8Array()), "cbf29ce484222325");
    assert.equal(fnv1a64(new TextEncoder().encode("a")), "af63dc4c8601ec8c");
  });

  it("counts distinct colours up to a limit and ignores alpha", () => {
    assert.equal(distinctColours(bgra("blank"), MIN_COLOURS), 1);
    assert.equal(distinctColours(bgra("gradient"), MIN_COLOURS), MIN_COLOURS);
    assert.equal(distinctColours(new Uint8Array([1, 2, 3, 0, 1, 2, 3, 255]), MIN_COLOURS), 1);
  });
});

describe("the capability receipt", () => {
  const SOFTWARE = { backends: ["vulkan"], software: true };
  const WARP = { backends: ["d3d12"], software: true };
  const LOCAL = { backends: ["metal"], software: false };
  const TABLE: ReadonlyArray<
    [string, unknown, { backends: string[]; software: boolean; anonymousAdapter?: boolean }, string]
  > = [
    ["tier core on SwiftShader", goodReceipt(SWIFTSHADER_ADAPTER), SOFTWARE, NO_ERROR],
    ["tier core on lavapipe", goodReceipt(LAVAPIPE_ADAPTER), SOFTWARE, NO_ERROR],
    ["tier core on WARP", goodReceipt(WARP_ADAPTER, "d3d12"), WARP, NO_ERROR],
    ["tier core on the Mac's GPU for a local run", goodReceipt("Apple M4 Max", "metal"), LOCAL, NO_ERROR],
    [
      "a tier that is not core",
      { ...goodReceipt(SWIFTSHADER_ADAPTER), tier: "downlevel" },
      SOFTWARE,
      SpikeCiCode.NotCoreTier,
    ],
    ["no tier at all", { backend: "vulkan", adapter: SWIFTSHADER_ADAPTER }, SOFTWARE, SpikeCiCode.NotCoreTier],
    ["a GL backend", goodReceipt(SWIFTSHADER_ADAPTER, "gl"), SOFTWARE, SpikeCiCode.WrongBackend],
    ["Metal where Vulkan is expected", goodReceipt(SWIFTSHADER_ADAPTER, "metal"), SOFTWARE, SpikeCiCode.WrongBackend],
    [
      "a hardware adapter where software is expected",
      goodReceipt("Apple M4 Max"),
      SOFTWARE,
      SpikeCiCode.NotSoftwareAdapter,
    ],
    [
      "an empty adapter name where a browser hides it",
      goodReceipt("", "webgpu"),
      { backends: ["webgpu"], software: false, anonymousAdapter: true },
      NO_ERROR,
    ],
    ["an empty adapter name", goodReceipt(""), SOFTWARE, SpikeCiCode.BadRecord],
    ["a receipt that is not an object", "core", SOFTWARE, SpikeCiCode.BadRecord],
    ["a null receipt", null, SOFTWARE, SpikeCiCode.BadRecord],
  ];
  for (const [name, receipt, expectation, expected] of TABLE) {
    it(`${expected === NO_ERROR ? "accepts" : "refuses"} ${name}`, () => {
      assert.equal(
        codeOf(() => checkReceipt(receipt, expectation)),
        expected,
      );
    });
  }
});

describe("the capture check", () => {
  async function folder(kind: "gradient" | "blank", digest?: string): Promise<{ dir: string; record: unknown }> {
    const home = await tmpDir("spike-ci-captures-");
    const dir = path.join(home, "captures");
    const bytes = bgra(kind);
    await mkdir(dir);
    await writeFile(path.join(dir, "1.bgra"), bytes);
    const capture = { tick: 30, width: CAPTURE_SIDE, height: CAPTURE_SIDE, digest: digest ?? fnv1a64(bytes) };
    return { dir, record: { format: "genex-self-test/1", captures: [capture] } };
  }

  it("accepts a capture with many colours whose digest is the file's", async () => {
    const { dir, record } = await folder("gradient");
    const facts = await checkCaptures(record, dir);
    assert.equal(facts.length, 1);
    assert.ok(facts[0].colours >= MIN_COLOURS);
  });

  it("refuses a blank capture", async () => {
    const { dir, record } = await folder("blank");
    assert.equal(await codeOfAsync(() => checkCaptures(record, dir)), SpikeCiCode.BlankCapture);
  });

  it("refuses a digest that is not the file's", async () => {
    const { dir, record } = await folder("gradient", "0".repeat(16));
    assert.equal(await codeOfAsync(() => checkCaptures(record, dir)), SpikeCiCode.DigestMismatch);
  });

  it("refuses a record with no captures, a missing file and a file of the wrong size", async () => {
    const { dir, record } = await folder("gradient");
    const none = { format: "genex-self-test/1", captures: [] };
    assert.equal(await codeOfAsync(() => checkCaptures(none, dir)), SpikeCiCode.BadRecord);
    const ghost = { format: "genex-self-test/1", captures: [{ tick: 1, width: 4, height: 4, digest: "0".repeat(16) }] };
    assert.equal(await codeOfAsync(() => checkCaptures(ghost, path.join(dir, "nowhere"))), SpikeCiCode.BadRecord);
    const [capture] = (record as { captures: object[] }).captures;
    const wrongSize = { format: "genex-self-test/1", captures: [{ ...capture, width: 8 }] };
    assert.equal(await codeOfAsync(() => checkCaptures(wrongSize, dir)), SpikeCiCode.BadRecord);
  });
});

describe("the small checks", () => {
  it("judges a cargo test run by the tests it ran, not by an exit code alone", () => {
    const ran = "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out";
    const filtered = "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out";
    assert.equal(
      codeOf(() => checkCargoTest(ran)),
      NO_ERROR,
    );
    assert.equal(
      codeOf(() => checkCargoTest(filtered)),
      SpikeCiCode.FxcNotExplicit,
    );
    assert.equal(
      codeOf(() => checkCargoTest("")),
      SpikeCiCode.FxcNotExplicit,
    );
    assert.equal(
      codeOf(() => checkCargoTest("test result: FAILED. 0 passed; 1 failed;")),
      SpikeCiCode.FxcNotExplicit,
    );
  });

  it("finds the artifact cargo reported for a package's target", () => {
    // Cargo's own spellings of a package id: a path package named like its folder (what cargo
    // emits for the pond), the explicit `#name@ver` form, and the legacy `name ver (src)` form.
    const ids = [
      "path+file:///x/native/genex-rust/examples/pond#0.1.0",
      "path+file:///x/native/genex-rust/examples/pond#pond@0.1.0",
      "path+file:///x/lake#pond@0.1.0",
      "pond 0.1.0 (path+file:///x/pond)",
    ];
    for (const pondId of ids) {
      const lines = [
        "not json at all",
        JSON.stringify({ reason: "compiler-message" }),
        JSON.stringify({
          reason: "compiler-artifact",
          package_id: pondId,
          target: { name: "pond", kind: ["bin"] },
          executable: "/t/release/pond",
          filenames: ["/t/release/pond"],
        }),
        JSON.stringify({
          reason: "compiler-artifact",
          package_id: pondId,
          target: { name: "pond_game", kind: ["cdylib", "rlib"] },
          executable: null,
          filenames: ["/t/release/libpond_game.so", "/t/release/libpond_game.rlib"],
        }),
      ].join("\n");
      assert.equal(cargoArtifact(lines, "pond", "pond", "bin"), "/t/release/pond", pondId);
      assert.equal(cargoArtifact(lines, "pond", "pond_game", "cdylib"), "/t/release/libpond_game.so", pondId);
      assert.equal(
        codeOf(() => cargoArtifact(lines, "pond", "nothing", "bin")),
        SpikeCiCode.StepFailed,
      );
    }
  });

  it("never takes another package's artifact for the named one", () => {
    const others = [
      "path+file:///x/examples/notpond#0.1.0",
      "path+file:///x/examples/pond-extra#0.1.0",
      "path+file:///x/pond#lake@0.1.0",
      "registry+https://github.com/rust-lang/crates.io-index#pondx@1.0.0",
      "notpond 0.1.0 (path+file:///x/notpond)",
    ];
    for (const id of others) {
      const line = JSON.stringify({
        reason: "compiler-artifact",
        package_id: id,
        target: { name: "pond", kind: ["bin"] },
        executable: "/t/release/pond",
        filenames: ["/t/release/pond"],
      });
      assert.equal(
        codeOf(() => cargoArtifact(line, "pond", "pond", "bin")),
        SpikeCiCode.StepFailed,
        id,
      );
    }
  });

  it("compares probe fields within a tolerance and every other leaf exactly", () => {
    const native = { fishing: { casts: 1, depth: 2.5 }, name: "pond" };
    const near = { fishing: { casts: 1, depth: 2.5004 }, name: "pond" };
    const far = { fishing: { casts: 1, depth: 2.6 }, name: "pond" };
    const lacking = { fishing: { casts: 1 }, name: "pond" };
    const renamed = { fishing: { casts: 1, depth: 2.5 }, name: "lake" };
    assert.equal(
      codeOf(() => compareProbes(near, native)),
      NO_ERROR,
    );
    for (const other of [far, lacking, renamed]) {
      assert.equal(
        codeOf(() => compareProbes(other, native)),
        SpikeCiCode.ProbesDiffer,
      );
    }
  });

  it("accepts a decoy dxcompiler.dll that was never loaded and refuses one that was", async () => {
    const dir = await tmpDir("spike-ci-decoy-");
    await writeFile(path.join(dir, "dxcompiler.dll"), "decoy");
    assert.equal(
      codeOf(() => checkDecoyUnused(dir)),
      NO_ERROR,
    );
    await writeFile(path.join(dir, "dxcompiler.dll.loaded"), "loaded");
    assert.equal(
      codeOf(() => checkDecoyUnused(dir)),
      SpikeCiCode.DecoyLoaded,
    );
  });
});

describe("the unsupported-page row", () => {
  const unsupported = {
    state: "unsupported",
    code: "gpu-unsupported",
    reason: "no-webgpu",
    limit: null,
    receipt: null,
  };
  const TABLE: ReadonlyArray<[string, unknown, string]> = [
    ["the designed page with no navigator.gpu", unsupported, NO_ERROR],
    [
      "a shell that is running (the browser has WebGPU)",
      { ...unsupported, state: "running" },
      SpikeCiCode.UnsupportedPageMissing,
    ],
    ["a shell stuck starting", { ...unsupported, state: "starting" }, SpikeCiCode.UnsupportedPageMissing],
    ["another refusal code", { ...unsupported, code: "boom" }, SpikeCiCode.UnsupportedPageMissing],
    ["a reason other than no WebGPU", { ...unsupported, reason: "no-adapter" }, SpikeCiCode.UnsupportedPageMissing],
    ["a status that is not an object", "unsupported", SpikeCiCode.UnsupportedPageMissing],
  ];
  for (const [name, status, expected] of TABLE) {
    it(`${expected === NO_ERROR ? "accepts" : "refuses"} ${name}`, () => {
      assert.equal(
        codeOf(() => checkUnsupportedShell(status, [])),
        expected,
      );
    });
  }

  it("refuses a page that fetched the game before it refused", () => {
    const requests = ["/index.html", "/game_bg.wasm"];
    assert.equal(
      codeOf(() => checkUnsupportedShell(unsupported, requests)),
      SpikeCiCode.UnsupportedPageMissing,
    );
  });
});

describe("the Electron WebGPU probe record", () => {
  const attempt = (label: string, outcome: string) => ({
    label,
    switches: label === "with-switches" ? ["enable-unsafe-webgpu"] : [],
    outcome,
    adapter: outcome === "webgpu-core" ? { vendor: "google", architecture: "swiftshader" } : null,
  });
  const record = (attempts: object[], result: string, electron = "43.7.6") => ({
    format: "genex-electron-webgpu/1",
    electron,
    platform: "linux",
    attempts,
    result,
    switches: result === "webgpu-needs-switches" ? ["enable-unsafe-webgpu"] : [],
  });
  const both = (without: string, withSwitches: string) => [
    attempt("without-switches", without),
    attempt("with-switches", withSwitches),
  ];
  const TABLE: ReadonlyArray<[string, unknown, string]> = [
    ["WebGPU with no switches", record(both("webgpu-core", "webgpu-core"), "webgpu-without-switches"), NO_ERROR],
    ["WebGPU only with the switches", record(both("no-webgpu", "webgpu-core"), "webgpu-needs-switches"), NO_ERROR],
    ["no WebGPU at all (recorded, not a kill)", record(both("no-webgpu", "no-webgpu"), "no-webgpu"), NO_ERROR],
    [
      "a result the attempts do not support",
      record(both("no-webgpu", "no-webgpu"), "webgpu-without-switches"),
      SpikeCiCode.BadRecord,
    ],
    ["a missing attempt", record([attempt("without-switches", "no-webgpu")], "no-webgpu"), SpikeCiCode.BadRecord],
    [
      "a different Electron",
      record(both("no-webgpu", "no-webgpu"), "no-webgpu", "42.0.0"),
      SpikeCiCode.ElectronMismatch,
    ],
    ["a record that is not an object", 3, SpikeCiCode.BadRecord],
  ];
  for (const [name, value, expected] of TABLE) {
    it(`${expected === NO_ERROR ? "accepts" : "refuses"} ${name}`, () => {
      assert.equal(
        codeOf(() => checkElectronRecord(value, "43.7.6")),
        expected,
      );
    });
  }
});

describe("the headless capture step on software Vulkan", POSIX_ONLY, () => {
  it("passes on SwiftShader and records the receipt, the provider and the capture facts", async () => {
    const dir = await tmpDir("spike-ci-headless-");
    const pond = await fakePond(dir);
    const evidence = path.join(dir, "evidence");
    const run = await runScript(headlessArgs(pond, evidence), await icdEnv(dir, "good"));
    assert.equal(run.code, 0, run.stderr);
    const record = await stepRecord(evidence, StepId.HeadlessSoftwareVulkan);
    assert.equal(record.status, StepStatus.Pass);
    assert.equal(record.provider, "swiftshader");
    assert.equal(record.receipt.tier, "core");
    assert.equal(record.receipt.adapter, SWIFTSHADER_ADAPTER);
    assert.ok(record.captures[0].colours >= MIN_COLOURS);
  });

  it("falls back to lavapipe when SwiftShader gives no compliant adapter, and says so", async () => {
    const dir = await tmpDir("spike-ci-headless-");
    const pond = await fakePond(dir);
    const evidence = path.join(dir, "evidence");
    const run = await runScript(headlessArgs(pond, evidence), await icdEnv(dir, "refuse-swiftshader"));
    assert.equal(run.code, 0, run.stderr);
    const record = await stepRecord(evidence, StepId.HeadlessSoftwareVulkan);
    assert.equal(record.provider, "lavapipe");
    assert.equal(record.receipt.adapter, LAVAPIPE_ADAPTER);
    assert.equal(record.attempts[0].provider, "swiftshader");
    assert.equal(record.attempts[0].refusal, "gpu-unsupported");
  });

  it("is the KILL when neither provider gives a compliant adapter", async () => {
    const dir = await tmpDir("spike-ci-headless-");
    const pond = await fakePond(dir);
    const run = await runScript(headlessArgs(pond, path.join(dir, "evidence")), await icdEnv(dir, "refuse-all"));
    assert.equal(run.code, 1);
    assert.equal(refusal(run)?.code, SpikeCiCode.NoCompliantSoftwareVulkan);
  });

  it("uses lavapipe alone when SwiftShader is not installed, and refuses when neither is", async () => {
    const dir = await tmpDir("spike-ci-headless-");
    const pond = await fakePond(dir);
    const env = await icdEnv(dir, "good", false);
    const lavapipe = await runScript(headlessArgs(pond, path.join(dir, "e1")), env);
    assert.equal(lavapipe.code, 0, lavapipe.stderr);
    assert.equal((await stepRecord(path.join(dir, "e1"), StepId.HeadlessSoftwareVulkan)).provider, "lavapipe");
    const noIcds = { ...env, GENEX_SPIKE_LAVAPIPE_ICD: path.join(dir, "absent.json") };
    const none = await runScript(headlessArgs(pond, path.join(dir, "e2")), noIcds);
    assert.equal(none.code, 1);
    assert.equal(refusal(none)?.code, SpikeCiCode.ToolMissing);
  });

  const REFUSED: ReadonlyArray<[string, string, string]> = [
    ["a blank capture", "blank", SpikeCiCode.BlankCapture],
    ["a digest that is not the capture file's", "bad-digest", SpikeCiCode.DigestMismatch],
    ["a receipt below tier core", "downlevel", SpikeCiCode.NotCoreTier],
    ["a GL backend", "gl", SpikeCiCode.WrongBackend],
    ["a hardware adapter standing in for software Vulkan", "hardware", SpikeCiCode.NotSoftwareAdapter],
    ["a pond that fails for another reason than the floor", "crash", SpikeCiCode.StepFailed],
  ];
  for (const [name, mode, code] of REFUSED) {
    it(`refuses ${name} with ${code}`, async () => {
      const dir = await tmpDir("spike-ci-headless-");
      const pond = await fakePond(dir);
      const evidence = path.join(dir, "evidence");
      const run = await runScript(headlessArgs(pond, evidence), await icdEnv(dir, mode));
      assert.equal(run.code, 1, run.stdout);
      assert.equal(refusal(run)?.code, code);
      assert.equal((await stepRecord(evidence, StepId.HeadlessSoftwareVulkan)).status, StepStatus.Fail);
    });
  }

  it("refuses a pond binary that does not exist", async () => {
    const dir = await tmpDir("spike-ci-headless-");
    const args = headlessArgs(path.join(dir, "no-pond"), path.join(dir, "evidence"));
    const run = await runScript(args, await icdEnv(dir, "good"));
    assert.equal(run.code, 1);
    assert.equal(refusal(run)?.code, SpikeCiCode.ToolMissing);
  });
});

describe("the Windows WARP step", POSIX_ONLY, () => {
  async function windowsDir(): Promise<string> {
    const dir = await tmpDir("spike-ci-windows-");
    await fakePond(dir, "pond.exe");
    await mkdir(path.join(dir, "decoy"));
    await writeFile(path.join(dir, "decoy", "dxcompiler.dll"), "decoy");
    return dir;
  }
  const args = (dir: string) => [
    "--step",
    StepId.WindowsWarp,
    "--windows-dir",
    dir,
    "--ticks",
    "30",
    "--evidence",
    path.join(dir, "evidence"),
  ];

  it("passes on D3D12 WARP with the decoy on PATH ahead of everything, never loaded", async () => {
    const dir = await windowsDir();
    const run = await runScript(args(dir), { FAKE_POND_MODE: "windows" });
    assert.equal(run.code, 0, run.stderr);
    const record = await stepRecord(path.join(dir, "evidence"), StepId.WindowsWarp);
    assert.equal(record.status, StepStatus.Pass);
    assert.equal(record.receipt.backend, "d3d12");
    assert.equal(record.decoyLoaded, false);
  });

  const REFUSED: ReadonlyArray<[string, NodeJS.ProcessEnv, string]> = [
    ["the decoy was loaded (FXC was not the compiler)", { FAKE_POND_MODE: "windows-decoy" }, SpikeCiCode.DecoyLoaded],
    [
      "a backend that is not D3D12",
      { FAKE_POND_MODE: "windows", FAKE_POND_BACKEND: "vulkan" },
      SpikeCiCode.WrongBackend,
    ],
    ["WARP gives no compliant adapter (the KILL)", { FAKE_POND_MODE: "refuse-all" }, SpikeCiCode.WarpNotCompliant],
  ];
  for (const [name, env, code] of REFUSED) {
    it(`refuses when ${name}`, async () => {
      const dir = await windowsDir();
      const run = await runScript(args(dir), env);
      assert.equal(run.code, 1);
      assert.equal(refusal(run)?.code, code);
    });
  }

  it("refuses a download with no decoy to test against", async () => {
    const dir = await windowsDir();
    await writeFile(path.join(dir, "decoy", "dxcompiler.dll"), "");
    const run = await runScript(args(dir), { FAKE_POND_MODE: "windows" });
    assert.equal(run.code, 1);
    assert.equal(refusal(run)?.code, SpikeCiCode.ToolMissing);
  });
});

describe("usage", () => {
  it("refuses an unknown step and an unknown flag with typed codes", async () => {
    const step = await runScript(["--step", "make-coffee"]);
    assert.equal(step.code, 1);
    assert.equal(refusal(step)?.code, SpikeCiCode.UnknownStep);
    const flag = await runScript(["--bogus"]);
    assert.equal(flag.code, 1);
    assert.equal(refusal(flag)?.code, SpikeCiCode.Usage);
  });
});

const toolchainSkip = (): string | false => {
  if (process.platform === "win32") return "not run: the spike lane is POSIX-only";
  if (existsSync(SPIKE_CARGO)) return false;
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no spike toolchain at ${SPIKE_CARGO}`);
  }
  return "not run: the spike toolchain is not installed";
};

describe("the local run on this machine's GPU", { skip: toolchainSkip() }, () => {
  it("builds the pond, proves FXC is explicit and gets a non-blank tier-core capture", {
    timeout: SCRIPT_TIMEOUT_MS,
  }, async (t) => {
    const dir = await tmpDir("spike-ci-local-");
    const only = [StepId.BuildPond, StepId.FxcExplicit, StepId.HeadlessSoftwareVulkan].join(",");
    const run = await runScript(["--local", "--only", only, "--ticks", "30", "--evidence", dir]);
    const summary = await stepRecord(dir, "summary");
    const headless = summary.rows.find((row: { id: string }) => row.id === StepId.HeadlessSoftwareVulkan);
    if (headless?.status === StepStatus.NotRun && !metalRequired()) {
      t.skip(`not run: ${headless.detail}`);
      return;
    }
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      summary.rows.map((row: { status: string }) => row.status),
      [StepStatus.Pass, StepStatus.Pass, StepStatus.Pass],
    );
    const record = await stepRecord(dir, StepId.HeadlessSoftwareVulkan);
    assert.equal(record.receipt.tier, "core");
    assert.ok(record.captures.at(-1).colours >= MIN_COLOURS);
  });
});
