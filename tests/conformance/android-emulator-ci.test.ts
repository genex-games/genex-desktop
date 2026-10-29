/**
 * The CI emulator boot (`scripts/ci/android-emulator.sh`, used by rust-mobile.yml's 16 KB emulator
 * job and native-destinations.yml's rust-android job) against stub Android tools: the AVD folder is
 * named for avdmanager and the emulator alike, and every way the emulator can fail to boot ends the
 * script within its deadline with the emulator's own log, never an unbounded wait. The emulator is
 * the pinned build (37.2.12, the last one CI's smoke passed on; 37.2.13 stalled the app before its
 * first resume, #539): a runner's other build is replaced from the pinned archive, held to its sha256.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "ci", "android-emulator.sh");
const SCRIPT_TIMEOUT_MS = 60 * SECOND_MS;
const BOOT_SECONDS = "4";
/** A failing boot ends well before the job would, and soon after its deadline. */
const FAST_FAIL_MS = 15 * SECOND_MS;
const SKIP = { skip: process.platform === "win32" ? "bash script (Linux CI)" : false };
/** The emulator build the script pins (scripts/ci/android-emulator.sh EMULATOR_BUILD). */
const PINNED_BUILD = "16428233";
/** The build GitHub's runners shipped on 10-29 (#539's stalled rust-android). */
const RUNNER_BUILD = "16740729";

/** How the stub avdmanager and emulator behave. */
const Stub = {
  Boots: "boots",
  UnknownAvd: "unknown-avd",
  NeverBoots: "never-boots",
  AvdElsewhere: "avd-elsewhere",
} as const;
type Stub = (typeof Stub)[keyof typeof Stub];

const AVDMANAGER = `#!/usr/bin/env bash
echo "avdmanager $*" >> "$STUB_DIR/calls.log"
cat > /dev/null
if [ "$STUB_MODE" = ${Stub.AvdElsewhere} ] || [ -z "\${ANDROID_AVD_HOME:-}" ]; then
  mkdir -p "$STUB_DIR/xdg/avd"; touch "$STUB_DIR/xdg/avd/genex-ci.ini"
else
  touch "$ANDROID_AVD_HOME/genex-ci.ini"
fi`;

const EMULATOR = `#!/usr/bin/env bash
if [ "$1" = -version ]; then echo "Android emulator version 37.2.12.0 (stub)"; exit 0; fi
echo "emulator $* avd-home=\${ANDROID_AVD_HOME:-}" >> "$STUB_DIR/calls.log"
[ -f "\${ANDROID_AVD_HOME:-/nowhere}/$2.ini" ] || { echo "ERROR | Unknown AVD name [$2]"; exit 1; }
case "$STUB_MODE" in
  ${Stub.UnknownAvd}) echo "ERROR | Unknown AVD name [$2]"; exit 1;;
  ${Stub.Boots}) sleep 1; touch "$STUB_DIR/booted"; exec sleep 30;;
  *) echo "INFO | booting"; exec sleep 30;;
esac`;

const ADB = `#!/usr/bin/env bash
[ "$1 $2 $3" = "shell getprop sys.boot_completed" ] || exit 1
[ -f "$STUB_DIR/booted" ] && echo 1 || echo
exit 0`;

interface Run {
  code: number | null;
  out: string;
  ms: number;
  dir: string;
  evidence: string;
  avdHome: string;
}

async function tool(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${text}\n`);
  await chmod(file, 0o755);
}

/** A finished script's exit code: 0 without an error, null when it was killed. */
function exitCode(error: { code?: unknown } | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

async function stopEmulator(evidence: string): Promise<void> {
  const pid = Number((await readFile(path.join(evidence, "emulator.pid"), "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** An emulator folder as an SDK holds it: the stub binary and the package's build id. */
async function emulatorFolder(parent: string, build: string): Promise<void> {
  await tool(path.join(parent, "emulator", "emulator"), EMULATOR);
  await writeFile(path.join(parent, "emulator", "source.properties"), `Pkg.Revision=37.2\nPkg.BuildId=${build}\n`);
}

/** The pinned archive as Google serves it (an `emulator/` folder), its file URL and sha256. */
async function pinnedArchive(dir: string): Promise<{ url: string; sha256: string }> {
  const staging = path.join(dir, "archive");
  await emulatorFolder(staging, PINNED_BUILD);
  const zip = path.join(dir, `emulator-linux_x64-${PINNED_BUILD}.zip`);
  execFileSync("zip", ["-qr", zip, "emulator"], { cwd: staging });
  return {
    url: `file://${zip}`,
    sha256: createHash("sha256")
      .update(await readFile(zip))
      .digest("hex"),
  };
}

interface BootOptions {
  /** The build the runner's SDK ships; the pinned one unless a test says otherwise. */
  installed?: string;
  /** The archive the script downloads and the sha256 it holds it to. */
  archive?: { url: string; sha256: string };
}

async function boot(mode: Stub, options: BootOptions = {}): Promise<Run> {
  const dir = await tmpDir("android-emulator-");
  const sdk = path.join(dir, "sdk");
  await tool(path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"), AVDMANAGER);
  await emulatorFolder(sdk, options.installed ?? PINNED_BUILD);
  await tool(path.join(sdk, "platform-tools", "adb"), ADB);
  const archive = options.archive ?? (await pinnedArchive(dir));
  const evidence = path.join(dir, "evidence");
  const avdHome = path.join(dir, "runner-temp", "android-avd");
  const started = Date.now();
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      "bash",
      [SCRIPT, evidence],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          ANDROID_HOME: sdk,
          AVD_IMAGE: "system-images;android-36;google_apis_ps16k;x86_64",
          RUNNER_TEMP: path.join(dir, "runner-temp"),
          GENEX_EMULATOR_BOOT_SECONDS: BOOT_SECONDS,
          STUB_DIR: dir,
          STUB_MODE: mode,
          GENEX_EMULATOR_URL: archive.url,
          GENEX_EMULATOR_SHA256: archive.sha256,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: exitCode(error), out: `${stdout}${stderr}` });
      },
    );
  });
  const ms = Date.now() - started;
  await stopEmulator(evidence);
  return { ...result, ms, dir, evidence, avdHome };
}

const calls = async (run: Run) => (await readFile(path.join(run.dir, "calls.log"), "utf8").catch(() => "")).trim();

describe("the CI emulator boot", SKIP, () => {
  it("makes the AVD in the folder the emulator reads, boots it and leaves it running", async () => {
    const run = await boot(Stub.Boots);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /the emulator booted/);
    assert.ok((await calls(run)).includes(`avd-home=${run.avdHome}`), await calls(run));
    assert.match(await readFile(path.join(run.evidence, "emulator.txt"), "utf8"), /Android emulator version/);
  });

  it("fails at once, with the emulator's log, when the emulator exits before it boots", async () => {
    const run = await boot(Stub.UnknownAvd);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /exited before it booted/);
    assert.match(run.out, /Unknown AVD name \[genex-ci\]/);
    assert.ok(run.ms < FAST_FAIL_MS, `${run.ms} ms`);
  });

  it("fails at its deadline, with the emulator's log, when the emulator never finishes booting", async () => {
    const run = await boot(Stub.NeverBoots);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /did not finish booting within 4s/);
    assert.match(run.out, /INFO \| booting/);
    assert.ok(run.ms < FAST_FAIL_MS, `${run.ms} ms`);
  });

  it("replaces a runner's other emulator build with the pinned one, held to its sha256, and boots it", async () => {
    const run = await boot(Stub.Boots, { installed: RUNNER_BUILD });
    assert.equal(run.code, 0, run.out);
    const properties = await readFile(path.join(run.dir, "sdk", "emulator", "source.properties"), "utf8");
    assert.match(properties, new RegExp(`Pkg.BuildId=${PINNED_BUILD}`));
    assert.match(run.out, /the emulator booted/);
  });

  it("refuses an archive that is not the pinned one, and leaves the runner's emulator as it was", async () => {
    const dir = await tmpDir("android-emulator-archive-");
    const { url } = await pinnedArchive(dir);
    const run = await boot(Stub.Boots, { installed: RUNNER_BUILD, archive: { url, sha256: "0".repeat(64) } });
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /not the pinned emulator/);
    const properties = await readFile(path.join(run.dir, "sdk", "emulator", "source.properties"), "utf8");
    assert.match(properties, new RegExp(`Pkg.BuildId=${RUNNER_BUILD}`));
    assert.ok(!(await calls(run)).includes("emulator -avd"), await calls(run));
  });

  it("refuses an AVD made anywhere but the named folder, before any emulator starts", async () => {
    const run = await boot(Stub.AvdElsewhere);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /made no genex-ci\.ini in ANDROID_AVD_HOME/);
    assert.ok(!(await calls(run)).includes("emulator -avd"), await calls(run));
  });
});
