/**
 * Builds Android's libcolyseus for a dev toolchain from the pinned source (MP-1b, owner decision
 * G12), with the store's own checks (`toolchain-store/colyseus-android.ts`): each downloaded input
 * verified against its pin and its entries checked, unpacked into one component folder, then two
 * offline builds through the pinned NDK, laid out in `<tools/colyseus>/aarch64-linux-android` only
 * when they are byte-equal. That is the folder `rust-env.ts` names in `GENEX_COLYSEUS_LIB_DIR` and
 * `cross-net.sh` links against.
 *
 *   node scripts/toolchains/colyseus-android.ts <downloads> <component> <ndk> <tools/colyseus> <work>
 *
 * `<downloads>` holds this host's inputs under their pinned file names. zig runs unsandboxed here,
 * as the other dev toolchain helpers do (`zig build --system` fetches nothing); in the app the
 * same request goes through `ProcessSandbox` with no network. A refusal is one line on stderr and
 * exit 78; the destination is left as it was.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { toolchainHostOf } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import {
  buildColyseusAndroid,
  colyseusBuildInputs,
  installColyseusBuildInput,
} from "../../src/substrate/toolchain-store/colyseus-android.ts";

/** The exit code of a refusal (EX_CONFIG), as the other toolchain helpers use. */
const REFUSED_EXIT = 78;
const USAGE =
  "usage: node scripts/toolchains/colyseus-android.ts <downloads> <component> <ndk> <tools/colyseus> <work>";
/** How much of zig's output the helper keeps for a refusal. */
const OUTPUT_TAIL_CHARS = 64 * 1024;

/** Runs a request's command with only its own environment (unsandboxed: a dev toolchain helper). */
function runUnsandboxed(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - started;
      const facts = { timedOut: false, truncated: false, sandboxed: false, command: request.command };
      resolve({ code, signal, stdout, stderr, durationMs, ...facts, cwd: request.cwd });
    });
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const [downloads, component, ndk, dest, work] = argv.map((arg) => path.resolve(arg));
  if (argv.length !== 5 || !downloads || !component || !ndk || !dest || !work) throw new Error(USAGE);
  const host = toolchainHostOf(process.platform, process.arch);
  const inputs = host === null ? null : colyseusBuildInputs(host);
  if (inputs === null) throw new Error(`no zig is pinned for ${process.platform}-${process.arch}`);
  for (const input of inputs) await installColyseusBuildInput(path.join(downloads, input), input, component);
  const started = Date.now();
  const built = await buildColyseusAndroid({ component, ndk, dest, work }, { run: runUnsandboxed });
  const record = { ...built, folder: path.join(dest, built.triple), rounds: 2, ms: Date.now() - started };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`colyseus-android: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(REFUSED_EXIT);
  });
}
