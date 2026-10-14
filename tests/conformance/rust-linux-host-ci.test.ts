/**
 * The Rust · wgpu runtime's Linux and Windows CI rows (M4.4): `scripts/ci/rust-linux-host.ts` owns
 * every check the workflows run on a Linux runner, so the rows here drive it on any host with no
 * GPU, no bubblewrap and no runner:
 *
 * - the step table and the four workflow files (rust-linux-host.yml, native-destinations.yml's
 *   `rust-linux` job, linux-userns.yml and release.yml) are held to each other: every workflow calls
 *   its steps once, in order, and no step-level `if:` can skip one; a workflow that drops, doubles,
 *   reorders or conditions a call is refused `workflow-drift`;
 * - windows.yml's Rust WARP row runs only on an owner dispatch (or the `windows-smoke` label), builds
 *   the gnullvm binary and its decoy `dxcompiler.dll` on Linux first and runs rust-spike's
 *   `windows-warp` step (D3D12 WARP adapter, FXC still the compiler) on the Windows job;
 * - the box row's verdicts: a receipt that is not tier core, not Vulkan or not a software adapter and
 *   a capture that is blank, mis-sized or whose digest is not its bytes' each have their typed code;
 * - a bundle whose pins do not all verify is refused, and a Rust bundle is assembled only from a
 *   verified SwiftShader runtime and a plain executable (hostile inputs leave nothing behind);
 * - the creation fixture scaffolds a Rust game from the template a package ships, through the
 *   product's own workspace, and refuses a package without one.
 *
 * The real row (the pins of a bundle made from the developer's pinned Linux ANGLE build) skips
 * without `GENEX_DEV_TOOLCHAINS`' build; `GENEX_REQUIRE_TOOLCHAINS=1` makes the skip a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { LinuxVulkanFile } from "../../src/substrate/native-runtime-files.ts";
import type { SwiftShaderRuntime } from "../../src/substrate/toolchain-store/swiftshader-bundle.ts";
import {
  assembleBundle,
  BOX_BUBBLEWRAP_SETUP,
  boxFailureDetail,
  checkBoxBubblewrap,
  checkBoxCapture,
  checkBoxReceipt,
  checkWindowsWorkflow,
  checkWorkflow,
  createFixtureGame,
  fnv1a64,
  judgeBundleChecks,
  RustLinuxHostCode,
  RustLinuxHostError,
  STEP_TABLE,
  StepId,
  WORKFLOW_ROWS,
  workflowJobs,
} from "../../scripts/ci/rust-linux-host.ts";
import { ArtifactFault } from "../../src/substrate/toolchain-store/artifact.ts";
import { AngleTarget, type BundleCheck, copyAngleTarget } from "../../src/substrate/toolchain-store/bundled.ts";
import { bundleLinuxSysroot } from "../../scripts/bundle-linux-sysroot.mjs";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "ci", "rust-linux-host.ts");
const WORKFLOWS = path.join(REPO, ".github", "workflows");
const REFUSAL_PREFIX = "genex-rust-linux-host: ";
const SCRIPT_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const NO_ERROR = "no error";
const SIDE = 16;
const SWIFTSHADER_ADAPTER = "SwiftShader Device (Subzero)";
const TEMPLATE = path.join(REPO, "src", "game-template");
const RUST_TEMPLATE = path.join(REPO, "src", "game-template-rust");
const REAL = needsTools("angleLinux");

const workflowText = (file: string) => readFile(path.join(WORKFLOWS, file), "utf8");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env }, maxBuffer: MAX_OUTPUT_BYTES, timeout: SCRIPT_TIMEOUT_MS, cwd: REPO },
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
    assert.ok(error instanceof RustLinuxHostError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof RustLinuxHostError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

/** BGRA bytes: a gradient (many colours) or one flat colour (blank). */
function bgra(kind: "gradient" | "blank"): Uint8Array {
  const bytes = new Uint8Array(SIDE * SIDE * 4);
  if (kind === "blank") return bytes;
  for (let i = 0; i < SIDE * SIDE; i++) bytes.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  return bytes;
}

const goodReceipt = { tier: "core", backend: "vulkan", adapter: SWIFTSHADER_ADAPTER, nativeEnhanced: [] };

/** A verified runtime of fake bytes: the assembler takes what it is handed and refuses what is missing. */
function fakeRuntime(omit?: LinuxVulkanFile): SwiftShaderRuntime {
  const files = {
    [LinuxVulkanFile.VulkanLoader]: Buffer.from("loader"),
    [LinuxVulkanFile.SwiftShader]: Buffer.from("swiftshader"),
    [LinuxVulkanFile.SwiftShaderIcd]: Buffer.from('{"ICD":{"library_path":"./libvk_swiftshader.so"}}'),
  } as Record<LinuxVulkanFile, Buffer>;
  if (omit) delete (files as Partial<Record<LinuxVulkanFile, Buffer>>)[omit];
  return { files, licences: { SwiftShader: [], VulkanLoader: [] } };
}

// ---- the step table and the workflows -------------------------------------------------------

describe("the step table", () => {
  it("names the four Linux rows in run order, each with a title and the flags it needs", () => {
    assert.deepEqual(
      STEP_TABLE.map((step) => step.id),
      [StepId.BundlePins, StepId.FixtureCreation, StepId.AssembleBundle, StepId.HeadlessBox],
    );
    for (const step of STEP_TABLE) assert.ok(step.title.length > 20, step.id);
  });

  it("is printed as JSON by --table", async () => {
    const run = await runScript(["--table"]);
    assert.equal(run.code, 0, run.stderr);
    const printed = JSON.parse(run.stdout) as { steps: Array<{ id: string }>; workflows: Array<{ file: string }> };
    assert.deepEqual(
      printed.steps.map((step) => step.id),
      STEP_TABLE.map((step) => step.id),
    );
    assert.deepEqual(
      printed.workflows.map((row) => row.file),
      WORKFLOW_ROWS.map((row) => row.file),
    );
  });

  it("assigns the .deb job the creation row and the packaged acceptance, and the others the pins", () => {
    const byFile = Object.fromEntries(WORKFLOW_ROWS.map((row) => [row.file, row]));
    assert.deepEqual(byFile["rust-linux-host.yml"]?.steps, [
      StepId.BundlePins,
      StepId.FixtureCreation,
      StepId.AssembleBundle,
      StepId.HeadlessBox,
    ]);
    assert.deepEqual(byFile["rust-linux-host.yml"]?.external, [
      BOX_BUBBLEWRAP_SETUP,
      "tests/e2e/run-rust-packaged-ui.mjs",
    ]);
    assert.deepEqual(byFile["native-destinations.yml"]?.steps, [
      StepId.BundlePins,
      StepId.AssembleBundle,
      StepId.HeadlessBox,
    ]);
    assert.deepEqual(byFile["native-destinations.yml"]?.external, [BOX_BUBBLEWRAP_SETUP]);
    assert.deepEqual(byFile["linux-userns.yml"]?.steps, [StepId.BundlePins]);
    assert.deepEqual(byFile["release.yml"]?.steps, [StepId.BundlePins]);
  });
});

describe("each workflow calls its steps once, in order, unskippably", () => {
  for (const row of WORKFLOW_ROWS) {
    it(`${row.file} (${row.job}) matches the table`, async () => {
      checkWorkflow(row.file, await workflowText(row.file));
    });
  }

  it("runs the packaged Rust acceptance beside the table's steps in the .deb job", async () => {
    const jobs = workflowJobs(await workflowText("rust-linux-host.yml"));
    const deb = jobs.find((job) => job.name === "deb");
    assert.ok(deb);
    assert.equal(deb.steps.filter((step) => step.run.includes("tests/e2e/run-rust-packaged-ui.mjs")).length, 1);
  });

  const call = (id: string) => new RegExp(`^.*scripts/ci/rust-linux-host\\.ts --step ${id}.*\\n`, "m");
  const setupRun = new RegExp(`^ *run: [^\\n]*${BOX_BUBBLEWRAP_SETUP}.*\\n`, "m");
  const mutations: Array<{ name: string; file: string; mutate: (text: string) => string; code: string }> = [
    {
      name: "drops the pins call",
      file: "linux-userns.yml",
      mutate: (text) => text.replace(call(StepId.BundlePins), ""),
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "calls the pins twice",
      file: "release.yml",
      mutate: (text) => text.replace(call(StepId.BundlePins), (line) => line + line),
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "runs the box before the bundle is assembled",
      file: "rust-linux-host.yml",
      mutate: (text) => {
        const assemble = call(StepId.AssembleBundle).exec(text)?.[0] ?? "";
        const box = call(StepId.HeadlessBox).exec(text)?.[0] ?? "";
        return text.replace(assemble, "@@A@@").replace(box, assemble).replace("@@A@@", box);
      },
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "skips the box under a step condition",
      file: "native-destinations.yml",
      mutate: (text) =>
        text.replace(
          /( {6}- name: [^\n]*\n)( {8}run: [^\n]*rust-linux-host\.ts --step headless-box)/,
          "$1        if: github.ref == 'refs/heads/dev'\n$2",
        ),
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "drops the pinned bubblewrap the box needs",
      file: "native-destinations.yml",
      mutate: (text) => text.replace(setupRun, ""),
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "builds the pinned bubblewrap only after the box ran",
      file: "rust-linux-host.yml",
      mutate: (text) => {
        const setup = setupRun.exec(text)?.[0] ?? "";
        const box = call(StepId.HeadlessBox).exec(text)?.[0] ?? "";
        return text.replace(setup, "@@S@@").replace(box, setup).replace("@@S@@", box);
      },
      code: RustLinuxHostCode.WorkflowDrift,
    },
    {
      name: "calls a step the table does not have",
      file: "linux-userns.yml",
      mutate: (text) => text.replace(`--step ${StepId.BundlePins}`, "--step bundle-pinz"),
      code: RustLinuxHostCode.UnknownStep,
    },
  ];
  for (const row of mutations) {
    it(`refuses a copy of ${row.file} that ${row.name}`, async () => {
      const mutated = row.mutate(await workflowText(row.file));
      assert.ok(mutated !== (await workflowText(row.file)), "the mutation changed nothing");
      assert.equal(
        codeOf(() => checkWorkflow(row.file, mutated)),
        row.code,
      );
    });
  }

  it("refuses a workflow file the table does not know", () => {
    assert.equal(
      codeOf(() => checkWorkflow("other.yml", "jobs:\n")),
      RustLinuxHostCode.UnknownStep,
    );
  });

  it("refuses a table job the workflow does not have", () => {
    assert.equal(
      codeOf(() => checkWorkflow("release.yml", "name: Release\njobs:\n  other:\n    runs-on: ubuntu-24.04\n")),
      RustLinuxHostCode.WorkflowDrift,
    );
  });
});

describe("the Windows WARP row (windows.yml)", () => {
  it("runs only on an owner dispatch or the windows-smoke label, and builds before it runs", async () => {
    checkWindowsWorkflow(await workflowText("windows.yml"));
  });

  it("keeps the existing gate off the Rust row's dispatch and off label events", async () => {
    const jobs = workflowJobs(await workflowText("windows.yml"));
    const gate = jobs.find((job) => job.name === "windows");
    assert.ok(gate);
    assert.match(gate.ifCondition ?? "", /rust_warp/);
    assert.match(gate.ifCondition ?? "", /labeled/);
  });

  const edits: Array<{ name: string; mutate: (text: string) => string }> = [
    {
      name: "the WARP job runs on every pull request",
      mutate: (text) => text.replace(/( {2}rust-warp:\n(?: {4}#[^\n]*\n)*) {4}if:[^\n]*\n/, "$1"),
    },
    {
      name: "the WARP job does not wait for the build",
      mutate: (text) => text.replace(/ {4}needs: rust-warp-build\n/, ""),
    },
    {
      name: "the WARP step is missing",
      mutate: (text) => text.replace(/^.*rust-spike\.ts --step windows-warp.*\n/m, ""),
    },
    {
      name: "the build never makes the decoy (cross-builds)",
      mutate: (text) => text.replace(/^.*rust-spike\.ts --step cross-builds.*\n/m, ""),
    },
    {
      name: "the WARP job is on a Linux runner",
      mutate: (text) => text.replace(/( {2}rust-warp:\n(?:.*\n)*? {4}runs-on: )windows-[\w.]+/, "$1ubuntu-24.04"),
    },
  ];
  for (const edit of edits) {
    it(`refuses a copy where ${edit.name}`, async () => {
      const original = await workflowText("windows.yml");
      const mutated = edit.mutate(original);
      assert.ok(mutated !== original, "the mutation changed nothing");
      assert.equal(
        codeOf(() => checkWindowsWorkflow(mutated)),
        RustLinuxHostCode.WorkflowDrift,
      );
    });
  }
});

// ---- the box row's verdicts -----------------------------------------------------------------

describe("the headless box row's receipt", () => {
  it("accepts tier core on Vulkan over a software adapter", () => {
    assert.equal(
      codeOf(() => checkBoxReceipt(goodReceipt)),
      NO_ERROR,
    );
    for (const adapter of ["llvmpipe (LLVM 17.0.6, 256 bits)", "SwiftShader Device (LLVM 10.0.0)"])
      assert.equal(
        codeOf(() => checkBoxReceipt({ ...goodReceipt, adapter })),
        NO_ERROR,
        adapter,
      );
  });

  const rows: Array<{ name: string; receipt: unknown; code: string }> = [
    { name: "no receipt", receipt: undefined, code: RustLinuxHostCode.BadRecord },
    { name: "a receipt that is not an object", receipt: "core", code: RustLinuxHostCode.BadRecord },
    {
      name: "a downlevel tier",
      receipt: { ...goodReceipt, tier: "downlevel" },
      code: RustLinuxHostCode.NotCoreTier,
    },
    { name: "a GL backend", receipt: { ...goodReceipt, backend: "gl" }, code: RustLinuxHostCode.WrongBackend },
    { name: "Metal on Linux", receipt: { ...goodReceipt, backend: "metal" }, code: RustLinuxHostCode.WrongBackend },
    {
      name: "a hardware adapter (the row proves the software path)",
      receipt: { ...goodReceipt, adapter: "NVIDIA GeForce RTX 4090" },
      code: RustLinuxHostCode.NotSoftwareAdapter,
    },
    { name: "an unnamed adapter", receipt: { ...goodReceipt, adapter: "" }, code: RustLinuxHostCode.BadRecord },
  ];
  for (const row of rows)
    it(`refuses ${row.name} with ${row.code}`, () => {
      assert.equal(
        codeOf(() => checkBoxReceipt(row.receipt)),
        row.code,
      );
    });
});

describe("the headless box row's capture", () => {
  const shot = (bytes: Uint8Array, overrides: Partial<{ width: number; height: number; digest: string }> = {}) => ({
    width: SIDE,
    height: SIDE,
    digest: fnv1a64(bytes),
    ...overrides,
  });

  it("accepts a drawn frame whose digest is its bytes'", () => {
    const bytes = bgra("gradient");
    assert.equal(
      codeOf(() => checkBoxCapture(shot(bytes), bytes)),
      NO_ERROR,
    );
  });

  it("refuses a blank frame (a clear and nothing drawn)", () => {
    const bytes = bgra("blank");
    assert.equal(
      codeOf(() => checkBoxCapture(shot(bytes), bytes)),
      RustLinuxHostCode.BlankCapture,
    );
  });

  it("refuses bytes that are not width × height × 4", () => {
    const bytes = bgra("gradient");
    assert.equal(
      codeOf(() => checkBoxCapture(shot(bytes, { width: SIDE + 1 }), bytes)),
      RustLinuxHostCode.BadRecord,
    );
  });

  it("refuses a digest that is not the file's", () => {
    const bytes = bgra("gradient");
    assert.equal(
      codeOf(() => checkBoxCapture(shot(bytes, { digest: "0".repeat(16) }), bytes)),
      RustLinuxHostCode.DigestMismatch,
    );
  });
});

describe("the box's bubblewrap", () => {
  it("accepts 0.8 and later, which have --disable-userns", () => {
    for (const text of ["bubblewrap 0.8.0", "bubblewrap 0.11.2\n", "bubblewrap 1.0"])
      assert.equal(
        codeOf(() => checkBoxBubblewrap(text)),
        NO_ERROR,
        text,
      );
  });

  const rows: Array<{ name: string; text: string | null }> = [
    { name: "Ubuntu 22.04's 0.6.1 (no --disable-userns)", text: "bubblewrap 0.6.1" },
    { name: "a bubblewrap that does not run", text: null },
    { name: "an unreadable version line", text: "bwrap: Unknown option --version" },
  ];
  for (const row of rows)
    it(`refuses ${row.name} as tool-missing, naming what it read`, () => {
      assert.equal(
        codeOf(() => checkBoxBubblewrap(row.text)),
        RustLinuxHostCode.ToolMissing,
      );
      try {
        checkBoxBubblewrap(row.text);
      } catch (error) {
        assert.ok(error instanceof RustLinuxHostError);
        assert.match(error.detail, /0\.8/);
        assert.ok(error.detail.includes(JSON.stringify(row.text)), error.detail);
      }
    });
});

describe("a box that fails says what the game and bubblewrap wrote", () => {
  it("adds the last lines of stderr to the failure", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    lines.push("bwrap: Unknown option --disable-userns");
    const detail = boxFailureDetail("the game exited before it said it was ready (exit 1)", lines);
    assert.ok(detail.startsWith("the game exited before it said it was ready (exit 1)"), detail);
    assert.ok(detail.includes("bwrap: Unknown option --disable-userns"), detail);
    assert.ok(!detail.includes("line 0\n"), "the tail is bounded");
  });

  it("bounds a single long line", () => {
    const detail = boxFailureDetail("failed", ["x".repeat(100_000)]);
    assert.ok(detail.length < 2_000, String(detail.length));
  });

  it("leaves the failure alone when nothing was written", () => {
    assert.equal(boxFailureDetail("failed", []), "failed");
  });
});

describe("the box step refuses before it starts anything", () => {
  it("names a bundle that is not there as tool-missing, typed on stderr with exit 1", async () => {
    const missing = path.join(await tmpDir("rlh-box-"), "no-bundle");
    const run = await runScript(["--step", StepId.HeadlessBox, "--bundle", missing]);
    assert.equal(run.code, 1);
    assert.equal(refusal(run)?.code, RustLinuxHostCode.ToolMissing);
  });

  it("refuses a step the table does not have, and a step without its flags", async () => {
    const unknown = await runScript(["--step", "teleport"]);
    assert.equal(unknown.code, 1);
    assert.equal(refusal(unknown)?.code, RustLinuxHostCode.UnknownStep);
    const bare = await runScript(["--step", StepId.BundlePins]);
    assert.equal(bare.code, 1);
    assert.equal(refusal(bare)?.code, RustLinuxHostCode.Usage);
  });
});

// ---- the pins -------------------------------------------------------------------------------

describe("the bundle pins", () => {
  const good = (target: AngleTarget): BundleCheck => ({ target, ok: true, folder: `/r/${target}`, files: 3, bytes: 9 });
  const targets: AngleTarget[] = Object.values(AngleTarget);

  it("accepts every pinned build verified", () => {
    assert.equal(
      codeOf(() => judgeBundleChecks(targets.map(good), targets)),
      NO_ERROR,
    );
  });

  it("refuses a build whose bytes do not match its pin, naming it", () => {
    const checks = targets.map(
      (target, index): BundleCheck =>
        index === 0
          ? { target, ok: false, folder: "/r", fault: ArtifactFault.FileDigest, detail: "libvulkan altered" }
          : good(target),
    );
    assert.equal(
      codeOf(() => judgeBundleChecks(checks, targets)),
      RustLinuxHostCode.BundlePinRefused,
    );
  });

  it("refuses a bundle that lacks a pinned build, and one that repeats a build", () => {
    assert.equal(
      codeOf(() => judgeBundleChecks(targets.slice(1).map(good), targets)),
      RustLinuxHostCode.BundlePinRefused,
    );
    assert.equal(
      codeOf(() => judgeBundleChecks([...targets.map(good), good(AngleTarget.MacArm64Metal)], targets)),
      RustLinuxHostCode.BundlePinRefused,
    );
  });

  it("refuses a resources folder that holds nothing, typed through the CLI", async () => {
    const empty = await tmpDir("rlh-pins-");
    const run = await runScript([
      "--step",
      StepId.BundlePins,
      "--resources",
      empty,
      "--evidence",
      path.join(empty, "e"),
    ]);
    assert.equal(run.code, 1);
    assert.equal(refusal(run)?.code, RustLinuxHostCode.BundlePinRefused);
  });

  it("holds a bundle made from the pinned Linux ANGLE build to every pin (developer toolchains)", REAL, async () => {
    const angle = devTool("angleLinux");
    assert.ok("path" in angle);
    const resources = path.join(await realpath(await tmpDir("rlh-pins-real-")), "resources");
    await copyAngleTarget(angle.path, resources, AngleTarget.LinuxX64Vulkan);
    await bundleLinuxSysroot({ resources });
    const run = await runScript([
      "--step",
      StepId.BundlePins,
      "--resources",
      resources,
      "--evidence",
      path.join(resources, "..", "e"),
    ]);
    // The Mac and Windows builds are not in this store: the Linux build verifies, the rest are named.
    assert.equal(run.code, 1);
    const said = refusal(run);
    assert.equal(said?.code, RustLinuxHostCode.BundlePinRefused);
    assert.match(said?.detail ?? "", /macos-arm64-metal/);
    assert.match(said?.detail ?? "", /windows-x64-d3d11/);
    assert.doesNotMatch(said?.detail ?? "", /linux-x64-vulkan/);
  });
});

// ---- assembling the bundle ------------------------------------------------------------------

describe("the Rust bundle the box runs", () => {
  async function pondIn(dir: string): Promise<string> {
    const pond = path.join(dir, "pond");
    await writeFile(pond, "\x7fELF-pond");
    await chmod(pond, 0o755);
    return pond;
  }

  it("is the game, the Vulkan loader, SwiftShader and its ICD at the top, from verified bytes alone", async () => {
    const dir = await tmpDir("rlh-bundle-");
    const out = path.join(dir, "bundle");
    const made = await assembleBundle({ pond: await pondIn(dir), out, runtime: fakeRuntime() });
    assert.deepEqual((await readdir(out)).sort(), ["game", ...Object.values(LinuxVulkanFile)].sort());
    assert.deepEqual(made.files.sort(), ["game", ...Object.values(LinuxVulkanFile)].sort());
    assert.equal((await stat(path.join(out, "game"))).mode & 0o777, 0o755);
    assert.equal(await readFile(path.join(out, "game"), "utf8"), "\x7fELF-pond");
    assert.equal((await readFile(path.join(out, LinuxVulkanFile.SwiftShader))).toString(), "swiftshader");
  });

  const hostile: Array<{
    name: string;
    code: string;
    setup: (dir: string) => Promise<{ pond: string; out: string; runtime: SwiftShaderRuntime }>;
  }> = [
    {
      name: "a pond that is not there",
      code: RustLinuxHostCode.ToolMissing,
      setup: async (dir) => ({ pond: path.join(dir, "absent"), out: path.join(dir, "bundle"), runtime: fakeRuntime() }),
    },
    {
      name: "a pond that is a link",
      code: RustLinuxHostCode.BadRecord,
      setup: async (dir) => {
        const real = await pondIn(dir);
        const link = path.join(dir, "linked");
        await symlink(real, link);
        return { pond: link, out: path.join(dir, "bundle"), runtime: fakeRuntime() };
      },
    },
    {
      name: "a pond that is a folder",
      code: RustLinuxHostCode.BadRecord,
      setup: async (dir) => {
        const folder = path.join(dir, "folder");
        await mkdir(folder);
        return { pond: folder, out: path.join(dir, "bundle"), runtime: fakeRuntime() };
      },
    },
    {
      name: "an output folder that already exists",
      code: RustLinuxHostCode.BadRecord,
      setup: async (dir) => {
        const out = path.join(dir, "bundle");
        await mkdir(out);
        return { pond: await pondIn(dir), out, runtime: fakeRuntime() };
      },
    },
    {
      name: "a runtime without its ICD manifest",
      code: RustLinuxHostCode.BundlePinRefused,
      setup: async (dir) => ({
        pond: await pondIn(dir),
        out: path.join(dir, "bundle"),
        runtime: fakeRuntime(LinuxVulkanFile.SwiftShaderIcd),
      }),
    },
  ];
  for (const row of hostile)
    it(`refuses ${row.name} (${row.code}) and writes nothing`, async () => {
      const dir = await tmpDir("rlh-bundle-hostile-");
      const request = await row.setup(dir);
      const before = (await readdir(dir)).sort();
      assert.equal(await codeOfAsync(() => assembleBundle(request)), row.code);
      const after = (await readdir(dir)).sort();
      assert.deepEqual(after, before, "nothing was added beside the refused request");
      if (row.name !== "an output folder that already exists")
        assert.equal(existsSync(request.out), false, "no output folder");
      else assert.deepEqual(await readdir(request.out), [], "the planted folder is untouched");
    });

  it("leaves a link planted where the output goes alone", async () => {
    const dir = await tmpDir("rlh-bundle-link-");
    const elsewhere = path.join(dir, "elsewhere");
    await mkdir(elsewhere);
    const out = path.join(dir, "bundle");
    await symlink(elsewhere, out);
    assert.equal(
      await codeOfAsync(async () => assembleBundle({ pond: await pondIn(dir), out, runtime: fakeRuntime() })),
      RustLinuxHostCode.BadRecord,
    );
    assert.deepEqual(await readdir(elsewhere), []);
    assert.ok((await lstat(out)).isSymbolicLink());
  });
});

// ---- the creation fixture -------------------------------------------------------------------

describe("the creation fixture", () => {
  it("scaffolds a Rust game for the web and Linux from the template a package ships, with no placeholder left", async () => {
    const root = await tmpDir("rlh-fixture-");
    const facts = await createFixtureGame({ templateDir: TEMPLATE, rustTemplateDir: RUST_TEMPLATE, root });
    assert.equal(facts.stack, "rust-wgpu");
    assert.deepEqual(facts.targets, ["web", "linux"]);
    assert.equal(facts.title, "Rust fixture");
    assert.ok(facts.files.includes("genex.toml"));
    assert.ok(facts.files.includes("src/main.rs"));
    const manifest = await readFile(path.join(facts.dir, "genex.toml"), "utf8");
    assert.match(manifest, /title = "Rust fixture"/);
    assert.doesNotMatch(manifest, /__GAME_TITLE__/);
  });

  it("refuses a package whose Rust template is missing, creating no game", async () => {
    const root = await tmpDir("rlh-fixture-missing-");
    const absent = path.join(root, "no-template");
    assert.equal(
      await codeOfAsync(() => createFixtureGame({ templateDir: TEMPLATE, rustTemplateDir: absent, root })),
      RustLinuxHostCode.FixtureRefused,
    );
    assert.equal(existsSync(path.join(root, "games")), false, "no games folder was made");
  });

  it("runs as a step: the record lands beside the other evidence", async () => {
    const root = await tmpDir("rlh-fixture-step-");
    const run = await runScript([
      "--step",
      StepId.FixtureCreation,
      "--templates",
      path.join(REPO, "src"),
      "--evidence",
      path.join(root, "evidence"),
    ]);
    assert.equal(run.code, 0, run.stderr);
    const record = JSON.parse(await readFile(path.join(root, "evidence", `${StepId.FixtureCreation}.json`), "utf8"));
    assert.equal(record.status, "pass");
    assert.equal(record.stack, "rust-wgpu");
  });
});
