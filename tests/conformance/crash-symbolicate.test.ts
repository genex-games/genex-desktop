/**
 * Crash symbolication (game-systems CRASH-7b): a kept record's raw frames named by the store's
 * `genex-symbolicate` from debug files the host chose, never from a path the record names; a
 * timeout or a refusal keeps the record unsymbolicated without failing intake.
 *
 * The fake-run rows pin the request, the sandbox policy and the hostile parses. The real rows
 * (Mac, behind the pinned Rust toolchain; `GENEX_REQUIRE_TOOLCHAINS=1` makes them required) build
 * the tool from its embedded source and a fixture game whose panic hook prints the anchor and its
 * raw frames as genex-crash does, then symbolicate a Live (dev, debug map) build, an export's kept
 * dSYM and a web symbol map under the real sandbox.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import {
  type CrashRecordV1,
  type CrashSymbols,
  type GameCrashedPayload,
  parseCrashRecord,
} from "../../src/shared/crash-record.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import {
  CRASH_ANCHOR_SYMBOL,
  type CrashDebugFiles,
  crashDebugFiles,
  createCrashSymbolicator,
  parseCrashSymbols,
  parseSymbolicateOutput,
  SYMBOLICATE_TIMEOUT_MS,
  symbolicateCrash,
} from "../../src/main/core/crash-symbolicate.ts";
import { createGameCrashStore, readGameCrashes } from "../../src/main/core/game-crashes.ts";
import { DebugFileKind, keepDebugFiles, WEB_SYMBOL_MAP_FILE } from "../../src/substrate/rust-debug-files.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { prewarmSandboxOptions } from "../../src/substrate/toolchain-store/prewarm.ts";
import { RustToolStep, SYMBOLICATE_MAIN_RS } from "../../src/substrate/toolchain-store/rust-prewarm.ts";
import { DEV_RUST_TOOLCHAIN, needsRustTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const RUN_ID = "0123456789ab";
const AT = Date.parse("2026-10-21T05:00:00.000Z");
const DIGEST = "a".repeat(64);

/** A record whose every text field names a path the host must never open. */
function hostileRecord(): CrashRecordV1 {
  const record = parseCrashRecord({
    format: "genex-crash/1",
    kind: "panic",
    source: "game",
    fatal: true,
    handled: false,
    message: "read /etc/shadow",
    location: { file: "/etc/passwd", line: 1, column: 1 },
    thread: { name: "/etc/master.passwd", main: true },
    frames: [{ ip: "0x1045a3f20" }, { image: 0, offset: "0x40" }, { ip: "0x1045a3e00" }],
    anchor: { ip: "0x1045a0000" },
    images: [{ name: "/private/etc/sudoers", id: "ABCDEF" }],
    wasm: { trap: "unreachable", stack: [{ func: 12, offset: 64 }] },
    context: { destination: "mac", build: "/etc/hosts", flavour: "dev" },
  });
  assert.ok(record);
  return record;
}

const RECORD_PATHS = ["/etc/shadow", "/etc/passwd", "/etc/master.passwd", "/private/etc/sudoers", "/etc/hosts"];

const ok = (stdout: string): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  truncated: false,
  sandboxed: true,
  command: "",
  cwd: "",
});

const FILES: CrashDebugFiles = {
  roots: ["/builds/g/mac.debug/d"],
  debug: ["/builds/g/mac.debug/d/game.dSYM/Contents/Resources/DWARF/game"],
  symbolMap: "/builds/g/web.debug/d/game_bg.symbols",
  sourceRoots: ["/builds/g/mac.stage"],
};

const TOOL_ANSWER = JSON.stringify({
  ok: true,
  frames: [
    {
      foreign: false,
      functions: [
        { function: "crash_here", file: "/builds/g/mac.stage/src/enemy.rs", line: 42, column: 17 },
        { function: "mygame::tick", file: "/builds/g/mac.stage/src/main.rs", line: 9, column: 5 },
      ],
    },
    { foreign: true },
  ],
  funcs: [{ func: 12, name: "mygame::boom" }],
});

describe("crash symbolication: the request carries the host's paths and the record's numbers only", () => {
  it("a record naming a path is never read: no record text reaches the tool's command or request", async () => {
    const calls: RunRequest[] = [];
    const run = async (request: RunRequest) => {
      calls.push(request);
      return ok(TOOL_ANSWER);
    };
    const symbols = await symbolicateCrash(hostileRecord(), FILES, { tool: "/store/tools/genex-symbolicate", run });
    assert.equal(calls.length, 1);
    const [call] = calls;
    for (const named of RECORD_PATHS) {
      assert.ok(!call.command.includes(named), `${named} in the command`);
      assert.ok(!(call.stdin ?? "").includes(named), `${named} in the request`);
    }
    assert.deepEqual((call.stdin ?? "").trim().split("\n"), [
      "root /builds/g/mac.debug/d",
      "debug /builds/g/mac.debug/d/game.dSYM/Contents/Resources/DWARF/game",
      `anchor ${CRASH_ANCHOR_SYMBOL} 0x1045a0000`,
      "frame 0x1045a3f20",
      "frame 0x1045a3e00",
      "map /builds/g/web.debug/d/game_bg.symbols",
      "func 12",
    ]);
    assert.equal(call.label, RustToolStep.Symbolicate);
    assert.equal(call.timeoutMs, SYMBOLICATE_TIMEOUT_MS);
    assert.equal(SYMBOLICATE_TIMEOUT_MS, 20_000);
    assert.deepEqual(call.policy?.allowedDomains, []);
    assert.deepEqual(call.policy?.allowWrite, []);
    // The platform frame between the two ip frames is listed unnamed; the second ip frame is foreign.
    assert.deepEqual(symbols, {
      frames: [
        {
          foreign: false,
          functions: [
            { function: "crash_here", file: "src/enemy.rs", line: 42, column: 17 },
            { function: "mygame::tick", file: "src/main.rs", line: 9, column: 5 },
          ],
        },
        { foreign: false, functions: [] },
        { foreign: true },
      ],
      wasm: [{ func: 12, name: "mygame::boom" }],
    });
  });

  it("nothing to name, no tool, or a host path with a line break runs nothing", async () => {
    const calls: RunRequest[] = [];
    const run = async (request: RunRequest) => {
      calls.push(request);
      return ok(TOOL_ANSWER);
    };
    const record = hostileRecord();
    assert.equal(await symbolicateCrash(record, FILES, { tool: null, run }), null);
    const bare = { ...record, frames: [], wasm: null };
    assert.equal(await symbolicateCrash(bare, FILES, { tool: "/t", run }), null);
    const noAnchor = { ...record, anchor: null, wasm: null };
    assert.equal(await symbolicateCrash(noAnchor, FILES, { tool: "/t", run }), null);
    const broken = { ...FILES, roots: ["/builds/g\nframe 0x1"] };
    assert.equal(await symbolicateCrash(record, broken, { tool: "/t", run }), null);
    const relative = { ...FILES, debug: ["game"] };
    assert.equal(await symbolicateCrash(record, relative, { tool: "/t", run }), null);
    assert.equal(calls.length, 0);
  });
});

describe("crash symbolication: a failure keeps the record unsymbolicated, never failing intake", () => {
  const failures: Array<[string, (request: RunRequest) => Promise<RunResult>]> = [
    ["the 20 s timeout", async () => ({ ...ok(""), code: null, signal: "SIGKILL", timedOut: true })],
    ["a refusal", async () => ({ ...ok('{"ok":false,"stage":"anchor","message":"no anchor"}'), code: 1 })],
    ["output that is not the tool's", async () => ok("Segmentation fault\n")],
    ["a frame count that is not the request's", async () => ok('{"ok":true,"frames":[{"foreign":true}],"funcs":[]}')],
    [
      "the sandbox throwing",
      async () => {
        throw new Error("sandbox gone");
      },
    ],
  ];
  for (const [what, run] of failures)
    it(`${what} gives null`, async () => {
      assert.equal(await symbolicateCrash(hostileRecord(), FILES, { tool: "/t", run }), null);
    });

  it("a timed-out symbolication still keeps and announces the record, symbolicated: false", async () => {
    const game = await realpath(await tmpDir("crash-symbolicate-intake-"));
    const out = path.join(game, "build", "mac.out");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "game"), "exe");
    const digest = createHash("sha256").update("exe").digest("hex");
    const calls: RunRequest[] = [];
    const announced: GameCrashedPayload[] = [];
    const store = createGameCrashStore({
      gameDir: async () => game,
      announce: async (payload) => announced.push(payload),
      now: () => AT,
      symbolicate: createCrashSymbolicator({
        tool: async () => "/store/tools/genex-symbolicate",
        run: async (request) => {
          calls.push(request);
          return { ...ok(""), code: null, timedOut: true };
        },
      }),
    });
    const entry = await store.keep(
      { project: "g", runId: RUN_ID, build: { output: out, exe: "game", digest } },
      hostileRecord(),
    );
    assert.equal(calls.length, 1, "the tool was asked");
    assert.equal(calls[0]?.timeoutMs, SYMBOLICATE_TIMEOUT_MS);
    assert.equal(entry?.symbolicated, false);
    assert.equal(entry?.symbols, undefined);
    assert.equal(announced[0]?.symbolicated, false);
    const listed = await readGameCrashes(game, {});
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0]?.symbolicated, false);
  });

  it("a symbolicated record is kept with its symbols, announced symbolicated and listed with them", async () => {
    const game = await realpath(await tmpDir("crash-symbolicate-kept-"));
    const symbols: CrashSymbols = {
      frames: [{ foreign: false, functions: [{ function: "f", file: "src/main.rs", line: 3, column: 1 }] }],
      wasm: [],
    };
    const announced: GameCrashedPayload[] = [];
    const store = createGameCrashStore({
      gameDir: async () => game,
      announce: async (payload) => announced.push(payload),
      now: () => AT,
      symbolicate: async () => symbols,
    });
    const record = { ...hostileRecord(), frames: [{ ip: "0x1045a3f20" }] };
    const entry = await store.keep({ project: "g", runId: RUN_ID }, record);
    assert.equal(entry?.symbolicated, true);
    assert.deepEqual(entry?.symbols, symbols);
    assert.equal(announced[0]?.symbolicated, true);
    const listed = await readGameCrashes(game, {});
    assert.deepEqual(listed.records[0]?.symbols, symbols);
    // A symbolicator that throws keeps the next record too.
    const throwing = createGameCrashStore({
      gameDir: async () => game,
      announce: async () => {},
      now: () => AT + 1000,
      symbolicate: async () => {
        throw new Error("boom");
      },
    });
    const kept = await throwing.keep({ project: "g", runId: "abcdef012345" }, { ...record, message: "other" });
    assert.equal(kept?.symbolicated, false);
  });

  it("a kept file claiming symbols that do not read back lists the record unsymbolicated", async () => {
    const game = await realpath(await tmpDir("crash-symbolicate-hostile-"));
    const store = createGameCrashStore({ gameDir: async () => game, announce: async () => {}, now: () => AT });
    await store.keep({ project: "g", runId: RUN_ID }, hostileRecord());
    const file = path.join(game, ".studio", "crashes", `${RUN_ID}-1.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stored, symbolicated: true, symbols: { frames: "nope", wasm: [] } }));
    const listed = await readGameCrashes(game, {});
    assert.equal(listed.records[0]?.symbolicated, false);
    assert.equal(listed.records[0]?.symbols, undefined);
  });
});

describe("crash symbolication: the host picks the debug files", () => {
  async function liveBuild() {
    const root = await realpath(await tmpDir("crash-symbolicate-live-"));
    const bin = path.join(root, "g-1", "mac-2");
    await mkdir(`${bin}.out`, { recursive: true });
    await writeFile(path.join(`${bin}.out`, "game"), "exe");
    return { bin, output: `${bin}.out`, digest: createHash("sha256").update("exe").digest("hex") };
  }

  it("a Live build reads its own executable and target folder while the executable has the run's digest", async () => {
    const { bin, output, digest } = await liveBuild();
    assert.deepEqual(await crashDebugFiles({ output, exe: "game", digest }), {
      roots: [output, path.join(bin, "target")],
      debug: [path.join(output, "game")],
      symbolMap: null,
      sourceRoots: [`${bin}.stage`],
    });
    const hostile: Array<[string, Parameters<typeof crashDebugFiles>[0]]> = [
      ["a rebuilt executable (another digest)", { output, exe: "game", digest: DIGEST }],
      ["an executable outside the output", { output, exe: "../mac-2.stage/game", digest }],
      ["an output that is not a build's", { output: bin, exe: "game", digest }],
      ["a digest that is not one", { output, exe: "game", digest: "../x" }],
    ];
    for (const [what, build] of hostile) assert.equal(await crashDebugFiles(build), null, what);
  });

  it("an export reads its kept folder: the dSYM's DWARF file, the unstripped executable or the symbol map", async () => {
    const { bin, output } = await liveBuild();
    const stage = path.join(bin, "debug-src");
    await mkdir(path.join(stage, "game.dSYM", "Contents", "Resources", "DWARF"), { recursive: true });
    await writeFile(path.join(stage, "game.dSYM", "Contents", "Resources", "DWARF", "game-1"), "dwarf");
    await writeFile(path.join(stage, "game.dSYM", "Contents", "Info.plist"), "plist");
    await writeFile(path.join(stage, "game"), "unstripped");
    await writeFile(path.join(stage, WEB_SYMBOL_MAP_FILE), "0:main\n");
    const kinds: Array<[DebugFileKind, string, string]> = [
      [DebugFileKind.Dsym, "game.dSYM", "game.dSYM/Contents/Resources/DWARF/game-1"],
      [DebugFileKind.Unstripped, "game", "game"],
      [DebugFileKind.SymbolMap, WEB_SYMBOL_MAP_FILE, WEB_SYMBOL_MAP_FILE],
    ];
    for (const [index, [kind, source, picked]] of kinds.entries()) {
      const digest = String(index).repeat(64);
      const sources = [{ from: path.join(stage, source), as: source }];
      const keep = { bin, digest, target: "mac", triple: "aarch64-apple-darwin", kind, sources, within: bin };
      assert.ok(await keepDebugFiles({ ...keep, now: () => AT }));
      const files = await crashDebugFiles({ output, exe: "game", digest });
      const folder = path.join(`${bin}.debug`, digest);
      const want = path.join(folder, ...picked.split("/"));
      assert.deepEqual(files?.roots, [folder], kind);
      if (kind === DebugFileKind.SymbolMap) assert.deepEqual([files?.debug, files?.symbolMap], [[], want]);
      else assert.deepEqual([files?.debug, files?.symbolMap], [[want], null], kind);
    }
  });
});

describe("crash symbolication: hostile tool output and kept symbols", () => {
  const record = { ...hostileRecord(), frames: [{ ip: "0x1" }] };
  const answer = (frames: unknown, funcs: unknown = []) => JSON.stringify({ ok: true, frames, funcs });

  it("refuses malformed frames and functions, cuts overlong names and paths", () => {
    const bad = [
      answer([{ foreign: "no" }]),
      answer([{ foreign: false, functions: [{ function: 3, file: null, line: null, column: null }] }]),
      answer([{ foreign: false, functions: [{ function: null, file: null, line: -1, column: null }] }]),
      answer([{ foreign: false }]),
      answer([{ foreign: true }], [{ func: "x", name: null }]),
      answer(Array.from({ length: 200 }, () => ({ foreign: true }))),
      "not json",
      JSON.stringify({ ok: true, frames: [], funcs: "x" }),
    ];
    for (const stdout of bad) assert.equal(parseSymbolicateOutput(stdout, record), null, stdout.slice(0, 80));
    const long = parseSymbolicateOutput(
      answer([
        { foreign: false, functions: [{ function: "f".repeat(5000), file: "p".repeat(5000), line: 1, column: 2 }] },
      ]),
      record,
    );
    const [frame] = long?.frames ?? [];
    assert.ok(frame && !frame.foreign);
    if (frame && !frame.foreign) {
      assert.ok((frame.functions[0]?.function ?? "").length <= 1024);
      assert.ok((frame.functions[0]?.file ?? "").length <= 512);
    }
    assert.equal(parseCrashSymbols({ frames: [], wasm: [{ func: 1, name: null }] })?.wasm[0]?.name, null);
    assert.equal(parseCrashSymbols({ frames: [] }), null);
  });
});

// ---------- real builds ----------

/** The fixture game: its panic hook prints the anchor and the raw frames, as genex-crash records them. */
const FIXTURE_MAIN_RS = `mod frames {
    const ANCHOR_TAG: u64 = 0x6765_6e65_785f_6372;
    #[inline(never)]
    pub fn anchor() -> u64 {
        let tag = std::hint::black_box(ANCHOR_TAG);
        let address = anchor as fn() -> u64 as usize as u64;
        if tag == ANCHOR_TAG { address } else { tag }
    }
}

#[inline(never)]
fn crash_here(values: &[u32], at: usize) -> u32 {
    values[at] + 1
}

fn main() {
    std::panic::set_hook(Box::new(|_| {
        let mut ips = Vec::new();
        backtrace::trace(|frame| {
            ips.push(format!("\\"0x{:x}\\"", frame.ip() as usize));
            true
        });
        println!("{{\\"anchor\\":\\"0x{:x}\\",\\"frames\\":[{}]}}", frames::anchor(), ips.join(","));
    }));
    let values = std::hint::black_box(vec![1, 2, 3]);
    let at = std::hint::black_box(7);
    println!("{}", crash_here(&values, at));
}
`;
const PANIC_LINE = FIXTURE_MAIN_RS.split("\n").findIndex((line) => line.includes("values[at] + 1")) + 1;

/** Crate name genex-crash, so the anchor's path is the real one: genex_crash::frames::anchor. */
const FIXTURE_MANIFEST = `[package]
name = "genex-crash"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
backtrace = { version = "=0.3.76", default-features = false, features = ["std"] }
`;

const TOOL_MANIFEST = `[package]
name = "genex-symbolicate"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
addr2line = { version = "=0.25.1", default-features = false, features = ["std"] }
object = { version = "=0.37.3", default-features = false, features = ["read", "std"] }
rustc-demangle = "=0.1.28"
`;

const REAL_GATE =
  process.platform === "darwin" ? needsRustTools("cargo", "rustc", "vendor") : { skip: "not run: Mach-O rows" };

describe("crash symbolication: real builds (pinned Rust toolchain)", () => {
  const state = { root: "", sandbox: null as ProcessSandbox | null, tool: "", env: {} as Record<string, string> };
  before(async () => {
    if (REAL_GATE.skip) return;
    state.root = await realpath(await tmpDir("crash-symbolicate-real-"));
    const home = path.join(state.root, "cargo-home");
    await mkdir(home, { recursive: true });
    await copyFile(path.join(DEV_RUST_TOOLCHAIN, "cargo-home", "config.toml"), path.join(home, "config.toml"));
    const bin = path.join(DEV_RUST_TOOLCHAIN, "sysroot", "bin");
    state.env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: state.root,
      TMPDIR: state.root,
      CARGO_HOME: home,
      RUSTC: path.join(bin, "rustc"),
      RUSTC_WRAPPER: "",
    };
    state.sandbox = await ProcessSandbox.create(prewarmSandboxOptions(path.join(state.root, "scratch"), []));
    const crate = path.join(state.root, "tool");
    await writeCrate(crate, TOOL_MANIFEST, SYMBOLICATE_MAIN_RS);
    state.tool = await cargoBuild(crate, path.join(state.root, "tool-target"), ["--release"], "genex-symbolicate");
  });
  after(async () => {
    await state.sandbox?.dispose();
    if (state.root) await rm(state.root, { recursive: true, force: true });
  });

  async function writeCrate(dir: string, manifest: string, main: string): Promise<void> {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "Cargo.toml"), manifest);
    await writeFile(path.join(dir, "src", "main.rs"), main);
  }

  async function cargoBuild(crate: string, targetDir: string, args: string[], name: string): Promise<string> {
    const env = { ...state.env, CARGO_TARGET_DIR: targetDir };
    const cargo = path.join(DEV_RUST_TOOLCHAIN, "sysroot", "bin", "cargo");
    const manifest = path.join(crate, "Cargo.toml");
    await execFileAsync(cargo, ["generate-lockfile", "--offline", "--manifest-path", manifest], { env });
    const build = ["build", "--offline", "--locked", "--manifest-path", manifest, ...args];
    await execFileAsync(cargo, build, { env, maxBuffer: 16 * 1024 * 1024 });
    return path.join(targetDir, args.includes("--release") ? "release" : "debug", name);
  }

  /** The fixture's record: its printed anchor and frames, plus one frame far outside the image. */
  async function crashOf(exe: string): Promise<CrashRecordV1> {
    const printed = await execFileAsync(exe).then(
      () => assert.fail("the fixture did not panic"),
      (error: { stdout: string }) => JSON.parse(error.stdout.split("\n")[0] ?? ""),
    );
    const outside = `0x${(BigInt(printed.anchor) + 0x4000_0000_0000n).toString(16)}`;
    const record = parseCrashRecord({
      format: "genex-crash/1",
      kind: "panic",
      source: "game",
      fatal: true,
      handled: false,
      message: "index out of bounds",
      frames: [...printed.frames.map((ip: string) => ({ ip })), { ip: outside }],
      anchor: { ip: printed.anchor },
      context: { destination: "mac", flavour: "dev" },
    });
    assert.ok(record);
    return record;
  }

  const run = (request: RunRequest) => {
    if (!state.sandbox) throw new Error("no sandbox");
    return state.sandbox.run(request);
  };

  function assertPanicSite(symbols: CrashSymbols | null): void {
    assert.ok(symbols, "symbolicated");
    const named = symbols.frames.flatMap((frame) => (frame.foreign ? [] : frame.functions));
    const site = named.find((f) => f.function?.endsWith("crash_here"));
    assert.deepEqual([site?.file, site?.line], ["src/main.rs", PANIC_LINE], JSON.stringify(named.slice(0, 12)));
    assert.deepEqual(symbols.frames.at(-1), { foreign: true }, "the frame outside the image is foreign");
  }

  it("a Live (dev) build symbolicates through the anchor slide and its debug map to src/main.rs:<line>", {
    ...REAL_GATE,
    timeout: 10 * MINUTE_MS,
  }, async () => {
    const bin = path.join(state.root, "builds", "g-1", "mac-2");
    await writeCrate(`${bin}.stage`, FIXTURE_MANIFEST, FIXTURE_MAIN_RS);
    const built = await cargoBuild(`${bin}.stage`, path.join(bin, "target"), [], "genex-crash");
    await mkdir(`${bin}.out`, { recursive: true });
    await copyFile(built, path.join(`${bin}.out`, "game"));
    const digest = createHash("sha256")
      .update(await readFile(built))
      .digest("hex");
    const record = await crashOf(path.join(`${bin}.out`, "game"));
    const files = await crashDebugFiles({ output: `${bin}.out`, exe: "game", digest });
    assert.ok(files);
    const started = Date.now();
    const symbols = await symbolicateCrash(record, files, { tool: state.tool, run });
    console.log(`crash-symbolicate live: ${Date.now() - started} ms for ${record.frames.length} frames`);
    assertPanicSite(symbols);
  });

  it("an export's kept dSYM symbolicates the stripped executable's frames to src/main.rs:<line>", {
    ...REAL_GATE,
    timeout: 10 * MINUTE_MS,
  }, async () => {
    const bin = path.join(state.root, "builds", "g-1", "mac-3");
    await writeCrate(`${bin}.stage`, FIXTURE_MANIFEST, FIXTURE_MAIN_RS);
    const release = [
      "--release",
      "--config",
      'profile.release.debug="line-tables-only"',
      "--config",
      'profile.release.split-debuginfo="packed"',
      "--config",
      'profile.release.strip="debuginfo"',
    ];
    const built = await cargoBuild(`${bin}.stage`, path.join(bin, "target"), release, "genex-crash");
    await mkdir(`${bin}.out`, { recursive: true });
    await copyFile(built, path.join(`${bin}.out`, "game"));
    const digest = createHash("sha256")
      .update(await readFile(built))
      .digest("hex");
    const kept = await keepDebugFiles({
      bin,
      digest,
      target: "mac",
      triple: "aarch64-apple-darwin",
      kind: DebugFileKind.Dsym,
      sources: [{ from: `${built}.dSYM`, as: "game.dSYM" }],
      within: bin,
      now: () => AT,
    });
    assert.ok(kept, "the dSYM is kept");
    // The target folder is gone: only the kept folder can name the frames.
    await rm(path.join(bin, "target"), { recursive: true, force: true });
    const record = await crashOf(path.join(`${bin}.out`, "game"));
    const files = await crashDebugFiles({ output: `${bin}.out`, exe: "game", digest });
    assert.deepEqual(files?.roots, [path.join(`${bin}.debug`, digest)]);
    const started = Date.now();
    const symbols = files ? await symbolicateCrash(record, files, { tool: state.tool, run }) : null;
    console.log(`crash-symbolicate export: ${Date.now() - started} ms for ${record.frames.length} frames`);
    assertPanicSite(symbols);
  });

  it("hostile table: the tool opens nothing outside its roots, links out of a root included", {
    ...REAL_GATE,
    timeout: 2 * MINUTE_MS,
  }, async () => {
    const root = path.join(state.root, "hostile", "root");
    const outside = path.join(state.root, "hostile", "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const secret = path.join(outside, "game.symbols");
    await writeFile(secret, "7:outside_name\n");
    await symlink(secret, path.join(root, "linked.symbols"));
    await symlink(state.tool, path.join(root, "linked-exe"));
    const frames = `anchor ${CRASH_ANCHOR_SYMBOL} 0x1000\nframe 0x1010`;
    const rows = [
      { name: "a debug file outside every root", body: `debug ${state.tool}\n${frames}`, stage: "debug" },
      {
        name: "a debug file linked out of the root",
        body: `debug ${path.join(root, "linked-exe")}\n${frames}`,
        stage: "debug",
      },
      { name: "a symbol map outside every root", body: `map ${secret}\nfunc 7`, stage: "map" },
      {
        name: "a symbol map linked out of the root",
        body: `map ${path.join(root, "linked.symbols")}\nfunc 7`,
        stage: "map",
      },
      { name: "a directive the tool does not know", body: "open /etc/passwd", stage: "usage" },
      { name: "a root that does not exist", body: `root ${path.join(outside, "missing")}`, stage: "usage" },
    ];
    for (const row of rows) {
      const result = await run({
        label: RustToolStep.Symbolicate,
        command: state.tool,
        cwd: root,
        stdin: `root ${root}\n${row.body}\n`,
        timeoutMs: SYMBOLICATE_TIMEOUT_MS,
        policy: { allowedDomains: [], allowWrite: [], allowRead: [root] },
      });
      const answer = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
      assert.equal(result.code, 1, row.name);
      assert.deepEqual([answer.ok, answer.stage], [false, row.stage], `${row.name}: ${result.stdout}`);
      assert.doesNotMatch(result.stdout, /outside_name/, `${row.name}: nothing outside the root is read back`);
    }
  });

  it("a web trap's functions are named and demangled from the kept symbol map", {
    ...REAL_GATE,
    timeout: 2 * MINUTE_MS,
  }, async () => {
    const bin = path.join(state.root, "builds", "g-1", "web-4");
    const stage = path.join(bin, "debug");
    await mkdir(stage, { recursive: true });
    const map = "0:main\n7:_ZN6mygame10crash_here17h0123456789abcdefE\n8:_RNvCs1234_6mygame4tick\n";
    await writeFile(path.join(stage, WEB_SYMBOL_MAP_FILE), map);
    const keep = { bin, digest: DIGEST, target: "web", triple: "wasm32-unknown-unknown", within: bin, now: () => AT };
    const sources = [{ from: path.join(stage, WEB_SYMBOL_MAP_FILE), as: WEB_SYMBOL_MAP_FILE }];
    assert.ok(await keepDebugFiles({ ...keep, kind: DebugFileKind.SymbolMap, sources }));
    const files = await crashDebugFiles({ output: `${bin}.out`, exe: null, digest: DIGEST });
    assert.ok(files);
    const record = {
      ...hostileRecord(),
      frames: [],
      anchor: null,
      wasm: {
        trap: "unreachable" as const,
        stack: [
          { func: 7, offset: 1 },
          { func: 8, offset: 2 },
          { func: 99, offset: 3 },
        ],
      },
    };
    const symbols = await symbolicateCrash(record, files, { tool: state.tool, run });
    assert.deepEqual(symbols, {
      frames: [],
      wasm: [
        { func: 7, name: "mygame::crash_here" },
        { func: 8, name: "mygame::tick" },
        { func: 99, name: null },
      ],
    });
  });
});
