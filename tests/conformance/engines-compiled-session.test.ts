/**
 * A compiled game's session on each engine (M3.13): the per-stack record (`compiledSessionOf`)
 * every engine reads instead of switching on C++. One row per engine for a Rust · wgpu session —
 * cargo on PATH, a read-only store and CARGO_HOME, its own target folder writable and nothing else
 * — and one per engine characterizing a C++ · raylib session as it was before the record existed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GameStack } from "../../src/shared/game-project.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { absoluteRule } from "../../src/substrate/engines/claude-permissions.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import {
  executeLocalTool,
  LOCAL_TOOL_LIMITS,
  LocalTool,
  localToolDefinitions,
} from "../../src/substrate/engines/local-session-tools.ts";
import {
  CLAUDE_CAPTURE_TOOL,
  CLAUDE_CPP_CAPTURE_TOOL,
  CLAUDE_RUST_CAPTURE_TOOL,
  CODEX_CAPTURE_TOOL,
  CODEX_CPP_CAPTURE_TOOL,
  CODEX_RUST_CAPTURE_TOOL,
  CPP_COMMAND_TIMEOUT_MS,
  type CppSession,
  compiledSessionOf,
  cppShellNote,
  RUST_COMMAND_TIMEOUT_MS,
  RUST_SHELL_CHECK,
  type RustSession,
  RustSessionVariable,
  rustShellNote,
} from "../../src/substrate/engines/studio-tool-prompts.ts";
import { computerToolDescription } from "../../src/substrate/computer-tool-prompts.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import type { RunRequest } from "../../src/substrate/spawn.ts";

/** One request per kind of game, each in a store and a game folder of its own. */
interface Sessions {
  root: string;
  store: string;
  cwd: string;
  rust: RustSession;
  cpp: CppSession;
  requests: { rust: DelegateRequest; cpp: DelegateRequest; three: DelegateRequest };
}

/** A Rust session, a C++ (web) session and a Three.js request, as the host hands them to an engine. */
async function sessions(): Promise<Sessions> {
  const root = await tmpDir("studio-compiled-session-");
  const store = path.join(root, "store");
  const cwd = path.join(root, "game");
  const own = path.join(root, "scratch", "rust-sessions", "ferris", "web-abc-def");
  const targetDir = path.join(own, "target");
  for (const dir of [store, cwd, targetDir]) await mkdir(dir, { recursive: true });
  const lock = path.join(store, "locks", "abc");
  const rust: RustSession = {
    store,
    path: [path.join(lock, "sysroot", "bin")],
    env: {
      CARGO_HOME: path.join(lock, "cargo-home"),
      CARGO_TARGET_DIR: targetDir,
      CARGO_BUILD_TARGET: "wasm32-unknown-unknown",
      CARGO_ENCODED_RUSTFLAGS: "-Funsafe_code",
      CARGO_NET_OFFLINE: "true",
      RUSTC: path.join(lock, "sysroot", "bin", "rustc"),
      [RustSessionVariable.Manifest]: path.join(own, "Cargo.toml"),
    },
    commandTimeoutMs: RUST_COMMAND_TIMEOUT_MS,
    targetDir,
  };
  const cpp: CppSession = {
    store,
    env: {
      GENEX_CMAKE: path.join(lock, "genex-web.cmake"),
      EM_CONFIG: path.join(lock, "emscripten.config"),
      EM_CACHE: path.join(root, "scratch", "cpp-sessions", "pong", "em-cache"),
    },
    path: [path.join(store, "cmake", "bin"), path.join(store, "ninja")],
    commandTimeoutMs: CPP_COMMAND_TIMEOUT_MS,
  };
  const base = { prompt: "go", cwd } as DelegateRequest;
  return {
    root,
    store,
    cwd,
    rust,
    cpp,
    requests: {
      rust: { ...base, extraReads: [targetDir, store], rust },
      cpp: { ...base, extraReads: [path.dirname(cpp.env.EM_CACHE ?? ""), store], cpp },
      three: { ...base, extraReads: [] },
    },
  };
}

describe("the compiled session record", () => {
  it("is the stack's own: its shell, the folders it writes, its capture and shell words; none for Three.js", async () => {
    const { rust, cpp, requests } = await sessions();
    const forRust = compiledSessionOf(requests.rust);
    assert.ok(forRust, "a Rust request has a compiled session");
    assert.equal(forRust.stack, GameStack.RustWgpu);
    assert.equal(forRust.shell, rust);
    assert.deepEqual(forRust.writes, [rust.targetDir], "a Rust session writes its own target folder");
    assert.deepEqual(forRust.localWrites, [rust.targetDir], "on a local engine too");
    assert.equal(forRust.claudeCapture, CLAUDE_RUST_CAPTURE_TOOL);
    assert.equal(forRust.codexCapture, CODEX_RUST_CAPTURE_TOOL);
    assert.equal(forRust.shellNote, rustShellNote(rust));

    const forCpp = compiledSessionOf(requests.cpp);
    assert.ok(forCpp, "a C++ request has a compiled session");
    assert.equal(forCpp.stack, GameStack.RaylibCpp);
    assert.equal(forCpp.shell, cpp);
    assert.deepEqual(forCpp.writes, [cpp.env.EM_CACHE], "Codex's Emscripten-cache grant stays C++'s");
    assert.deepEqual(forCpp.localWrites, [], "a local engine's C++ commands gain no write, as before");
    assert.equal(forCpp.claudeCapture, CLAUDE_CPP_CAPTURE_TOOL);
    assert.equal(forCpp.codexCapture, CODEX_CPP_CAPTURE_TOOL);
    assert.equal(forCpp.shellNote, cppShellNote(cpp));

    assert.equal(compiledSessionOf(requests.three), null, "a Three.js session has none");
    assert.notEqual(CLAUDE_RUST_CAPTURE_TOOL.description, CLAUDE_CAPTURE_TOOL.description);
    assert.notEqual(CODEX_RUST_CAPTURE_TOOL.description, CODEX_CAPTURE_TOOL.description);
  });

  it("tells a Rust session the check that works without a Cargo.toml in its folder, and nothing when nothing was set", async () => {
    const { rust, store } = await sessions();
    const told = rustShellNote(rust);
    assert.ok(told.includes(RUST_SHELL_CHECK.check), told);
    assert.ok(RUST_SHELL_CHECK.check.includes("--offline") && RUST_SHELL_CHECK.check.includes("--locked"));
    assert.ok(RUST_SHELL_CHECK.check.includes(`$${RustSessionVariable.Manifest}`), "the host's manifest");
    for (const said of ["CARGO_HOME", "CARGO_TARGET_DIR", `${RUST_COMMAND_TIMEOUT_MS} ms`, `(${store}) is read-only`])
      assert.ok(told.includes(said), `a Rust session is told of ${said}`);
    const none = rustShellNote({ ...rust, path: [], env: {}, targetDir: null });
    assert.match(none, /check only with the capture tool/);
    for (const unsaid of [RUST_SHELL_CHECK.check, "CARGO_TARGET_DIR", "first on PATH"])
      assert.equal(none.includes(unsaid), false, `an unprewarmed session is not told of ${unsaid}`);
  });

  it("gives the computer tool's reload line per stack: C++ as before, Rust its own lane", () => {
    const view = { width: 960, height: 540 };
    const cameras = "";
    const asBefore = computerToolDescription({ role: "builder", view, cameras, cpp: true });
    assert.equal(computerToolDescription({ role: "builder", view, cameras, stack: GameStack.RaylibCpp }), asBefore);
    const rust = computerToolDescription({ role: "builder", view, cameras, stack: GameStack.RustWgpu });
    assert.match(rust, /rebuilds this Rust · wgpu game through its own lane/);
    assert.doesNotMatch(rust, /C\+\+/);
    assert.doesNotMatch(
      computerToolDescription({ role: "playtester", view, cameras, stack: GameStack.RustWgpu }),
      /reload/,
    );
  });
});

/** The parts of the options Claude Code's SDK is handed that a compiled session changes. */
interface ClaudeOptions {
  env: Record<string, string | undefined>;
  additionalDirectories?: string[];
  sandbox: { filesystem: { denyWrite: string[] } };
  settings: { permissions: { deny: string[] } };
}

/** A Claude Code engine whose SDK records the options of every session it is asked to start. */
async function claudeEngine(root: string, seen: ClaudeOptions[]): Promise<ClaudeCodeEngine> {
  const queryFn = ((params: { prompt: string; options?: ClaudeOptions }) => {
    if (params.options) seen.push(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 };
      },
    };
  }) as never;
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    queryFn,
  });
}

/** What a Codex engine was handed per session: its environment, prompt and the folders its sandbox writes. */
interface CodexSeen {
  env: Record<string, string>;
  prompt: string;
  writes: string[];
}

const WRITABLE_ROOTS = "sandbox_workspace_write.writable_roots=";

async function codexEngine(root: string, seen: CodexSeen[]): Promise<CodexEngine> {
  const execFn: CodexExec = (invocation) => {
    const roots = invocation.argv.find((arg) => arg.startsWith(WRITABLE_ROOTS)) ?? `${WRITABLE_ROOTS}[]`;
    seen.push({
      env: invocation.env,
      prompt: invocation.prompt,
      writes: JSON.parse(roots.slice(WRITABLE_ROOTS.length)) as string[],
    });
    return (async function* () {
      yield { type: "thread.started", thread_id: "compiled-1" };
      yield { type: "item.completed", item: { id: "a", type: "agent_message", text: "ok" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  };
  const home = path.join(root, "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  return new CodexEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    executable: "/fake/codex",
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn,
  });
}

/** Runs one command through a local engine's tools for `request`; answers what the sandbox was asked to run. */
async function localRun(request: DelegateRequest): Promise<RunRequest> {
  const runs: RunRequest[] = [];
  const sandbox = {
    toolPath: async () => ["/login/bin", "/usr/bin"].join(path.delimiter),
    run: async (run: RunRequest) => {
      runs.push(run);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const context = {
    request,
    cwd: request.cwd,
    signal: new AbortController().signal,
    resolveFile: async () => request.cwd,
    sandbox: sandbox as never,
    forbidden: ["/forbidden"],
    deniedWrites: ["/denied"],
    label: "local:test",
    seenReads: new Map(),
    studioToolCalls: [],
  };
  const call = { name: LocalTool.RunCommand, arguments: { command: "cargo --version" } };
  await executeLocalTool(call as never, localToolDefinitions(request, false), context);
  const [run] = runs;
  assert.ok(run, "the command ran");
  return run;
}

/** The variables a compiled session sets, by stack: neither stack's leak into the other's or a Three.js session. */
const RUST_VARIABLES = ["CARGO_HOME", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", RustSessionVariable.Manifest];
const CPP_VARIABLES = ["GENEX_CMAKE", "EM_CONFIG", "EM_CACHE"];

describe("a Rust · wgpu game's session on each engine", () => {
  it("Claude Code: cargo first on PATH, the store's CARGO_HOME, its own target folder the only folder it writes, the store read-only", async () => {
    const { root, store, rust, requests } = await sessions();
    const seen: ClaudeOptions[] = [];
    const engine = await claudeEngine(root, seen);
    await engine.delegate(requests.rust);
    const [options] = seen;
    assert.ok(options, "the session started");
    for (const name of RUST_VARIABLES) assert.equal(options.env[name], rust.env[name], name);
    assert.ok(String(options.env.PATH).startsWith([...rust.path, ""].join(path.delimiter)), options.env.PATH);
    assert.equal(options.env.BASH_DEFAULT_TIMEOUT_MS, String(RUST_COMMAND_TIMEOUT_MS));
    assert.equal(options.env.BASH_MAX_TIMEOUT_MS, String(RUST_COMMAND_TIMEOUT_MS));
    for (const name of CPP_VARIABLES) assert.equal(options.env[name], undefined, `no ${name}`);
    const writable = (options.additionalDirectories ?? []).filter((dir) => dir !== store);
    assert.deepEqual(writable, [rust.targetDir], "its own target folder and nothing else besides its workspace");
    assert.ok(
      options.sandbox.filesystem.denyWrite.includes(store),
      "its shell never writes the store (CARGO_HOME in it)",
    );
    assert.ok(options.settings.permissions.deny.includes(absoluteRule("Edit", store)), "nor its file tools");
  });

  it("Codex: the same shell, told how to check, and writing its run folder and its own target folder alone", async () => {
    const { root, store, rust, requests } = await sessions();
    const seen: CodexSeen[] = [];
    const engine = await codexEngine(root, seen);
    await engine.delegate(requests.rust);
    const [session] = seen;
    assert.ok(session, "the session started");
    for (const name of RUST_VARIABLES) assert.equal(session.env[name], rust.env[name], name);
    assert.ok(String(session.env.PATH).startsWith([...rust.path, ""].join(path.delimiter)), session.env.PATH);
    for (const name of CPP_VARIABLES) assert.equal(session.env[name], undefined, `no ${name}`);
    assert.ok(session.prompt.includes(rustShellNote(rust)), "the session is told what its shell has");
    assert.equal(session.prompt.includes("C++ TOOLCHAIN"), false);
    assert.equal(session.writes.length, 2, JSON.stringify(session.writes));
    assert.equal(session.writes[1], rust.targetDir, "its run folder, then its own target folder");
    assert.equal(session.writes.includes(store), false, "never the store");
  });

  it("a local engine: cargo first on PATH for the Rust timeout, the store never written, its target folder writable", async () => {
    const { store, rust, requests } = await sessions();
    const run = await localRun(requests.rust);
    assert.equal(run.timeoutMs, RUST_COMMAND_TIMEOUT_MS);
    assert.deepEqual(run.env, { ...rust.env, PATH: [...rust.path, "/login/bin", "/usr/bin"].join(path.delimiter) });
    assert.deepEqual(run.policy, {
      denyRead: ["/forbidden"],
      denyWrite: ["/denied", store],
      allowWrite: [rust.targetDir],
    });
  });
});

describe("a C++ · raylib game's session on each engine, as it was", () => {
  it("Claude Code: the lock's environment, the C++ timeout, a read-only store; no Rust variable", async () => {
    const { root, store, cpp, requests } = await sessions();
    const seen: ClaudeOptions[] = [];
    const engine = await claudeEngine(root, seen);
    await engine.delegate(requests.cpp);
    await engine.delegate(requests.three);
    const [options, three] = seen;
    assert.ok(options && three, "both sessions started");
    for (const name of CPP_VARIABLES) assert.equal(options.env[name], cpp.env[name], name);
    assert.ok(String(options.env.PATH).startsWith([...cpp.path, ""].join(path.delimiter)), options.env.PATH);
    assert.equal(options.env.BASH_DEFAULT_TIMEOUT_MS, String(CPP_COMMAND_TIMEOUT_MS));
    assert.equal(options.env.BASH_MAX_TIMEOUT_MS, String(CPP_COMMAND_TIMEOUT_MS));
    for (const name of RUST_VARIABLES) assert.equal(options.env[name], undefined, `no ${name}`);
    assert.deepEqual(options.additionalDirectories, requests.cpp.extraReads);
    assert.ok(options.sandbox.filesystem.denyWrite.includes(store));
    assert.ok(options.settings.permissions.deny.includes(absoluteRule("Edit", store)));
    for (const name of [...CPP_VARIABLES, ...RUST_VARIABLES, "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"])
      assert.equal(three.env[name], undefined, `a Three.js session has no ${name}`);
    assert.equal(three.sandbox.filesystem.denyWrite.includes(store), false);
    assert.equal(three.settings.permissions.deny.includes(absoluteRule("Edit", store)), false);
  });

  it("Codex: its Emscripten cache is its one extra write, its note the C++ one; Three.js writes its run folder alone", async () => {
    const { root, cpp, requests } = await sessions();
    const seen: CodexSeen[] = [];
    const engine = await codexEngine(root, seen);
    await engine.delegate(requests.cpp);
    await engine.delegate(requests.three);
    const [session, three] = seen;
    assert.ok(session && three, "both sessions started");
    for (const name of CPP_VARIABLES) assert.equal(session.env[name], cpp.env[name], name);
    for (const name of RUST_VARIABLES) assert.equal(session.env[name], undefined, `no ${name}`);
    assert.ok(session.prompt.includes(cppShellNote(cpp)));
    assert.equal(session.prompt.includes("RUST TOOLCHAIN"), false);
    assert.deepEqual(session.writes.slice(1), [cpp.env.EM_CACHE]);
    assert.equal(three.writes.length, 1, "a Three.js session writes its run folder alone");
    assert.equal(three.prompt.includes("TOOLCHAIN"), false);
  });

  it("a local engine: exactly the run it was given before; Three.js keeps its two minutes and no environment", async () => {
    const { store, cpp, requests } = await sessions();
    const run = await localRun(requests.cpp);
    assert.equal(run.timeoutMs, CPP_COMMAND_TIMEOUT_MS);
    assert.deepEqual(run.env, { ...cpp.env, PATH: [...cpp.path, "/login/bin", "/usr/bin"].join(path.delimiter) });
    assert.deepEqual(run.policy, { denyRead: ["/forbidden"], denyWrite: ["/denied", store] });
    const three = await localRun(requests.three);
    assert.equal(three.timeoutMs, LOCAL_TOOL_LIMITS.commandTimeoutMs);
    assert.equal(three.env, undefined);
    assert.deepEqual(three.policy, { denyRead: ["/forbidden"], denyWrite: ["/denied"] });
  });
});
