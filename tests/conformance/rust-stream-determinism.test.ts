/**
 * Streamed simulation state replays bit for bit on every destination this machine can run
 * (game systems STR-28): the facade's `tests/stream_determinism.rs` (a 3000-tick anchor walk over
 * streamed colliders and real genex-nav islands, its ten checkpoint checksums pinned as one digest,
 * and `seed(2)` then `seed(1)` replaying a fresh `seed(1)`) built and run, offline with the pinned
 * toolchain (`scripts/toolchains/rust-env.ts`), for:
 *
 * - the host, where 1 and 8 workers also match the inline builds;
 * - x86_64 macOS under Rosetta on an Apple silicon Mac (skipped elsewhere or without Rosetta);
 * - wasm32 in a headless runner: the release libtest binary instantiated here with every import
 *   refusing, inline builds as the web runs them. Its `main` returns 0 when every row passed; a
 *   failed assert panics, and a panic on wasm32 traps.
 *
 * Linux, Windows, iOS and Android run the same file on their own runners or devices (the owner's
 * rows, named at the gates, not claimed here). Without the toolchain the rows skip, and
 * `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../src/shared/duration.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR || path.join(REPO, ".studio-dev", "spike-toolchain");
const SYSROOT = path.join(TOOLCHAIN_DIR, "sysroot");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** The facade's test file the rows run, by its cargo target name. */
const TEST_TARGET = "stream_determinism";
/** Every row of the test file (the worker row is native only). */
const NATIVE_ROWS = 4;
/** A cold build compiles the facade's whole dependency graph for the triple. */
const BUILD_MS = 30 * MINUTE_MS;
const OUTPUT_BYTES = 64 * 1024 * 1024;
/** The cross triples, in the pinned toolchain's spelling. */
const Triple = {
  X86Mac: "x86_64-apple-darwin",
  Wasm32: "wasm32-unknown-unknown",
} as const;
type Triple = (typeof Triple)[keyof typeof Triple];

const CARGO_TEST = ["cargo", "test", "-p", "genex", "--test", TEST_TARGET, "--offline", "--locked"];

/** Why a row cannot run here (the skip), or nothing; a missing toolchain fails when required. */
function needs(triple?: Triple): { skip?: string } {
  if (!existsSync(path.join(SYSROOT, "bin", "cargo"))) {
    if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: no Rust toolchain at ${SYSROOT}`);
    return { skip: "not run: the Rust toolchain is not installed" };
  }
  if (triple && !existsSync(path.join(SYSROOT, "lib", "rustlib", triple))) {
    if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: the toolchain has no ${triple} std`);
    return { skip: `not run: the toolchain has no ${triple} std` };
  }
  return {};
}

/** Whether this Mac runs x86_64 code under Rosetta. */
async function rosetta(): Promise<boolean> {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false;
  try {
    await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    return true;
  } catch {
    return false;
  }
}

/** Runs `args` through the toolchain helper from the repository; its stdout. */
async function cargo(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [RUST_ENV, "--", ...args], {
    cwd: REPO,
    timeout: BUILD_MS,
    maxBuffer: OUTPUT_BYTES,
  });
  return stdout;
}

/** The libtest summary's passed count, or -1 when the output has no passing summary. */
function passed(stdout: string): number {
  const summary = /^test result: ok\. (\d+) passed; 0 failed/m.exec(stdout);
  return summary ? Number(summary[1]) : -1;
}

/** The executable cargo built for the test target, from its JSON messages. */
function testExecutable(messages: string): string {
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message: unknown = JSON.parse(line);
    const executable = artifactExecutable(message);
    if (executable) return executable;
  }
  throw new Error(`cargo built no ${TEST_TARGET} executable`);
}

/** A compiler-artifact message's executable when it is the test target's. */
function artifactExecutable(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("reason" in message) || message.reason !== "compiler-artifact") return null;
  if (!("target" in message) || typeof message.target !== "object" || message.target === null) return null;
  if (!("name" in message.target) || message.target.name !== TEST_TARGET) return null;
  return "executable" in message && typeof message.executable === "string" ? message.executable : null;
}

/** Instantiates a wasm32 libtest binary with every import refusing and runs its `main`. */
async function runWasmTests(file: string): Promise<unknown> {
  const module = await WebAssembly.compile(await readFile(file));
  const imports: Record<string, Record<string, () => never>> = {};
  for (const wanted of WebAssembly.Module.imports(module)) {
    imports[wanted.module] ??= {};
    imports[wanted.module][wanted.name] = () => {
      throw new Error(`the test called the import ${wanted.module}.${wanted.name}`);
    };
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const main = instance.exports.main;
  if (typeof main !== "function") throw new Error("the libtest binary exports no main");
  return Reflect.apply(main, undefined, [0, 0]);
}

describe("streamed simulation state replays bit for bit across destinations", { timeout: 3 * BUILD_MS }, () => {
  it(
    "the host walk has the pinned digest inline and with 1 and 8 workers, and seed 2 then 1 replays",
    needs(),
    async () => {
      assert.equal(passed(await cargo(CARGO_TEST)), NATIVE_ROWS);
    },
  );

  it("x86_64 under Rosetta reaches the same pinned digest", needs(Triple.X86Mac), async (t) => {
    if (!(await rosetta())) {
      t.skip("not run: needs Rosetta on an Apple silicon Mac");
      return;
    }
    assert.equal(passed(await cargo([...CARGO_TEST, "--target", Triple.X86Mac])), NATIVE_ROWS);
  });

  it(
    "wasm32 with inline builds reaches the same pinned digest in the headless runner",
    needs(Triple.Wasm32),
    async () => {
      // Release, as a web export is built.
      const built = await cargo([
        ...CARGO_TEST,
        "--target",
        Triple.Wasm32,
        "--release",
        "--no-run",
        "--message-format=json",
      ]);
      assert.equal(await runWasmTests(testExecutable(built)), 0, "libtest's main returns 0 when every row passed");
    },
  );
});
