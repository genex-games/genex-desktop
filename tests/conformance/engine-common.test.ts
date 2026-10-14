/** The helpers the Claude Code and Codex engines share (src/substrate/engines/common.ts). */
import assert from "node:assert/strict";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { absoluteRule } from "../../src/substrate/engines/claude-permissions.ts";
import { after, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  abortControllerFor,
  clip,
  COMPLETE_TIMEOUT_MS,
  hasCredentials,
  interruption,
  partialDelegateResult,
} from "../../src/substrate/engines/common.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { fixtureWebOutput, seedFixtureToolchainStore } from "../../src/main/dev/fixture-toolchains.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import {
  executeLocalTool,
  LOCAL_TOOL_LIMITS,
  LocalTool,
  localToolDefinitions,
} from "../../src/substrate/engines/local-session-tools.ts";
import {
  CPP_COMMAND_TIMEOUT_MS,
  CPP_SHELL_BUILD,
  type CppSession,
  cppShellEnv,
  cppShellNote,
} from "../../src/substrate/engines/studio-tool-prompts.ts";
import { cppSessionFor } from "../../src/main/core/delegation.ts";
import { lockFolder, locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { DEV_TOOLCHAINS, devStoreLock, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import type { RunRequest } from "../../src/substrate/spawn.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

it("clips long trace text and says how much was cut", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("0123456789", 10), "0123456789");
  assert.equal(clip("0123456789abc", 10), "0123456789… [3 more chars]");
});

it("gives a deadline a controller that follows the caller's signal", () => {
  assert.equal(abortControllerFor().signal.aborted, false, "no signal still yields a controller");
  const caller = new AbortController();
  const follower = abortControllerFor(caller.signal);
  assert.equal(follower.signal.aborted, false);
  caller.abort();
  assert.equal(follower.signal.aborted, true);
  assert.equal(
    abortControllerFor(AbortSignal.abort()).signal.aborted,
    true,
    "an already-aborted signal aborts at once",
  );
  const own = new AbortController();
  const independent = abortControllerFor(own.signal);
  independent.abort();
  assert.equal(own.signal.aborted, false, "the deadline aborting never aborts the caller");
});

it("keeps one completion ceiling for both engines", () => {
  assert.equal(COMPLETE_TIMEOUT_MS, 15 * 60_000);
});

it("tells a user's stop from a spent time budget", () => {
  assert.deepEqual(interruption(true), { stopReason: "stopped", errorText: "stopped by you" });
  assert.deepEqual(interruption(false), { stopReason: "deadline", errorText: "time budget exhausted" });
  assert.deepEqual(interruption(undefined), interruption(false), "no signal means the deadline stopped it");
});

it("reports a build cut short as an outcome that keeps what it did", () => {
  const usage = { engine: "codex", input_tokens: 10 };
  const calls = [{ name: "start_autopilot", args: { goal: "x" } }];
  const result = partialDelegateResult(
    "codex",
    { stopReason: "deadline", errorText: "time budget exhausted" },
    {
      summary: "half a game",
      usage,
      turns: 4,
      startedAt: Date.now() - 1_000,
      sessionId: "s-1",
      model: "gpt-x",
      requestedModel: undefined,
      cliVersion: "1.2.3",
      cliPath: "/usr/local/bin/codex",
      studioToolCalls: calls,
    },
  );
  const { durationMs, ...rest } = result;
  assert.ok(typeof durationMs === "number" && durationMs >= 1_000);
  assert.deepEqual(rest, {
    ok: false,
    summary: "half a game",
    usage,
    turns: 4,
    engine: "codex",
    stopReason: "deadline",
    errorText: "time budget exhausted",
    billing: "subscription",
    sessionId: "s-1",
    model: "gpt-x",
    cliPath: "/usr/local/bin/codex",
    cliVersion: "1.2.3",
    studioToolCalls: calls,
  });
  const bare = partialDelegateResult(
    "claude-code",
    { stopReason: "stopped", errorText: "stopped by you" },
    { summary: "", usage, turns: 0, startedAt: Date.now(), studioToolCalls: [] },
  );
  assert.equal("studioToolCalls" in bare, false, "no recorded calls, no empty list");
  assert.equal("sessionId" in bare, false);
});

it("detects a sign-in by the credential file or anything beside it, never by reading it", async () => {
  const empty = await tmpDir("studio-engine-home-");
  assert.equal(await hasCredentials(empty, ".credentials.json"), false);
  assert.equal(await hasCredentials(path.join(empty, "missing"), ".credentials.json"), false);
  const withFile = await tmpDir("studio-engine-home-");
  await writeFile(path.join(withFile, ".credentials.json"), "not read");
  assert.equal(await hasCredentials(withFile, ".credentials.json"), true);
  const withJson = await tmpDir("studio-engine-home-");
  await writeFile(path.join(withJson, "settings.json"), "{}");
  assert.equal(await hasCredentials(withJson, "auth.json"), true);
  const withDir = await tmpDir("studio-engine-home-");
  await mkdir(path.join(withDir, "projects"));
  assert.equal(await hasCredentials(withDir, "auth.json"), true);
});

it("ownership recovery state alone never selects an empty coding-provider login", async () => {
  const home = await tmpDir("studio-engine-runtime-");
  await mkdir(path.join(home, "ownership-locks"));
  assert.equal(await hasCredentials(home, "auth.json"), false);
  await writeFile(path.join(home, "auth.json"), "not opened");
  assert.equal(await hasCredentials(home, "auth.json"), true);
});

// ── a C++ · raylib game's session ──────────────────────────────────────────────────────────

/** A delegated engine that records each request it is handed and answers at once. */
function recordingEngine(seen: DelegateRequest[]) {
  return {
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      return { ok: true, engine: "claude-code", sessionId: "s", turns: 1, usage: {}, summary: "" };
    },
  };
}

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

/** A harness method of a core, called as the harness calls it; a method the core lacks fails the row. */
function harnessCall(core: StudioCore): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const api = core.api() as unknown as Record<
    string,
    ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  >;
  return (method, params) => {
    const answer = api[method];
    assert.ok(answer, `the core answers ${method}`);
    return answer(params);
  };
}

/** The request the recording engine was handed last. */
function lastRequest(seen: readonly DelegateRequest[]): DelegateRequest {
  const request = seen.at(-1);
  assert.ok(request, "the engine was handed a request");
  return request;
}

/** Every entry under `dir` (links not followed) with its size and mtime: a folder that was written differs. */
async function listing(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  const described = await Promise.all(
    entries.map(async (rel) => {
      const info = await lstat(path.join(dir, rel));
      return `${rel}:${info.size}:${info.mtimeMs}`;
    }),
  );
  return described.sort();
}

/** What a C++ session's environment and timeout look like, for one store: the rows below share it. */
interface CppFacts {
  store: string;
  env: Record<string, string>;
  path: string[];
  commandTimeoutMs: number;
}

/** A C++ session as the engines read it, in a store of its own. */
async function cppRequest(): Promise<{ request: DelegateRequest; facts: CppFacts }> {
  const root = await tmpDir("studio-cpp-session-");
  const store = path.join(root, "store");
  const cwd = path.join(root, "game");
  await mkdir(store, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const facts: CppFacts = {
    store,
    env: {
      GENEX_CMAKE: path.join(store, "locks", "abc", "genex-web.cmake"),
      EM_CONFIG: path.join(store, "locks", "abc", "emscripten.config"),
      EM_CACHE: path.join(cwd, ".studio", "em-cache"),
    },
    path: [path.join(store, "cmake", "bin"), path.join(store, "ninja")],
    commandTimeoutMs: CPP_COMMAND_TIMEOUT_MS,
  };
  return { request: { prompt: "go", cwd, extraReads: [store], cpp: facts } as DelegateRequest, facts };
}

describe("a C++ · raylib game's session", () => {
  it("reads the toolchain store, builds with the lock's environment and gets the C++ command timeout; a Three.js session is as before", async () => {
    const lite = await coreLite();
    lites.push(lite);
    const { core } = lite;
    const lock = await seedFixtureToolchainStore(core.layout.toolchains, { webOutput: fixtureWebOutput() });
    assert.ok(lock, "the fixture store is seeded");
    const store = await realpath(core.layout.toolchains);
    // The store's prewarmed Emscripten cache, with a file a session must find in its own copy.
    const storeCache = path.join(lockFolder(store, lock), "em-cache");
    await writeFile(path.join(storeCache, "sysroot", "prewarmed.txt"), "built once, by the prewarm");
    const storeBefore = await listing(storeCache);
    const seen: DelegateRequest[] = [];
    core.engines.register(recordingEngine(seen) as never);
    await core.games.scaffold("arena");
    await core.games.scaffold("pong", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    const call = harnessCall(core);
    const delegated = async (project: string) => {
      const threadId = await core.threadForGame(project);
      await call("engine.delegate", { engine: "claude-code", prompt: "go", project, threadId });
      return lastRequest(seen);
    };

    const cpp = await delegated("pong");
    const session = cpp.cpp as CppFacts | undefined;
    assert.ok(session, "a C++ session is handed its toolchain");
    assert.equal(session.store, store);
    assert.ok((cpp.extraReads ?? []).includes(store), "the store is readable");
    assert.equal(session.commandTimeoutMs, CPP_COMMAND_TIMEOUT_MS);
    assert.equal(CPP_COMMAND_TIMEOUT_MS, 10 * MINUTE_MS);
    const { GENEX_CMAKE, EM_CONFIG, EM_CACHE } = session.env;
    assert.ok(GENEX_CMAKE && isInside(store, GENEX_CMAKE) && GENEX_CMAKE.endsWith("genex-web.cmake"), GENEX_CMAKE);
    assert.ok(EM_CONFIG && isInside(store, EM_CONFIG), EM_CONFIG);
    assert.ok(EM_CACHE && !isInside(store, EM_CACHE), `the Emscripten cache is never the store's: ${EM_CACHE}`);
    // Flipped (ACC-09): the cache was `<game>/.studio/em-cache`, 600 MB in the person's game folder
    // (its backups and sync). It is the session's own in the core's scratch, one folder per game.
    const sessionFolder = path.join(await realpath(core.layout.scratch), "cpp-sessions", "pong");
    assert.equal(EM_CACHE, path.join(sessionFolder, "em-cache"), "the session's own, in the core's scratch");
    assert.ok(!isInside(path.resolve(cpp.cwd), EM_CACHE), "never in the game folder");
    assert.deepEqual(
      (cpp.extraReads ?? []).filter((dir) => dir !== store),
      [sessionFolder],
      "besides the store, the session reaches exactly that folder, which its sandbox writes",
    );
    // A copy of the prewarmed cache, so the first emcc does not rebuild the sysroot; the store is only read.
    assert.equal(await readFile(path.join(EM_CACHE, "sysroot", "prewarmed.txt"), "utf8"), "built once, by the prewarm");
    await writeFile(path.join(EM_CACHE, "sysroot", "built-by-the-session.txt"), "x");
    assert.deepEqual(await listing(storeCache), storeBefore, "the store's cache is unchanged");
    const studio = await readdir(path.dirname(EM_CACHE));
    assert.equal(studio.filter((name) => name.startsWith(".em-cache-")).length, 0, "no half-made clone is left");
    // emcc starts its Python with -E, which ignores PYTHONDONTWRITEBYTECODE: only -B keeps
    // `__pycache__` out of the store, which a person's own (unsandboxed) shell could write.
    const located = await locateToolchain(store, lock, [BuildTarget.Web]);
    assert.ok(located.ok && located.toolchain.emscripten, "the fixture store locates the web");
    if (process.platform === StudioPlatform.Windows) {
      assert.equal(
        session.env.EMSDK_PYTHON,
        located.toolchain.emscripten.python,
        "Windows uses emsdk’s Python executable",
      );
    } else {
      await writeFile(located.toolchain.emscripten.python, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
      const { EMSDK_PYTHON } = session.env;
      assert.ok(
        EMSDK_PYTHON && isInside(path.resolve(cpp.cwd), EMSDK_PYTHON),
        `emsdk's Python as the session runs it: ${EMSDK_PYTHON}`,
      );
      const { stdout: argv } = await execFileAsync(EMSDK_PYTHON, ["-E", "emcc.py"]);
      assert.equal(argv.trim(), "-B -E emcc.py", "emcc's Python writes no bytecode");
    }
    assert.equal("PATH" in session.env, false, "PATH is the engine's to compose, ahead of the login PATH");
    assert.ok(session.path.length > 0 && session.path.every((dir) => isInside(store, dir)), "the store's tools");

    const three = await delegated("arena");
    assert.equal(three.cpp, undefined, "a Three.js session has no C++ toolchain");
    assert.equal((three.extraReads ?? []).includes(store), false, "nor the store");
  });

  it("runs a local engine's commands with that environment, the store's tools first, for ten minutes", async () => {
    const { request, facts } = await cppRequest();
    const runs: RunRequest[] = [];
    const sandbox = {
      toolPath: async () => ["/login/bin", "/usr/bin"].join(path.delimiter),
      run: async (run: RunRequest) => {
        runs.push(run);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const context = (req: DelegateRequest) => ({
      request: req,
      cwd: req.cwd,
      signal: new AbortController().signal,
      resolveFile: async () => req.cwd,
      sandbox: sandbox as never,
      forbidden: [],
      deniedWrites: [],
      label: "local:test",
      seenReads: new Map(),
      studioToolCalls: [],
    });
    const call = { name: LocalTool.RunCommand, arguments: { command: "cmake --version" } };
    await executeLocalTool(call as never, localToolDefinitions(request, false), context(request));
    const three = { ...request, cpp: undefined };
    await executeLocalTool(call as never, localToolDefinitions(three, false), context(three));
    const [cpp, js] = runs;
    assert.equal(cpp?.timeoutMs, CPP_COMMAND_TIMEOUT_MS);
    assert.equal(cpp?.env?.GENEX_CMAKE, facts.env.GENEX_CMAKE);
    assert.equal(cpp?.env?.EM_CACHE, facts.env.EM_CACHE);
    assert.equal(cpp?.env?.PATH, [...facts.path, "/login/bin", "/usr/bin"].join(path.delimiter));
    assert.ok(cpp?.policy?.denyWrite?.includes(facts.store), "the store is never written");
    assert.equal(js?.timeoutMs, LOCAL_TOOL_LIMITS.commandTimeoutMs, "a Three.js command keeps its two minutes");
    assert.equal(js?.env, undefined, "and the environment it always had");
  });
});

/** The parts of the options Claude Code's SDK is handed that a C++ session changes. */
interface ClaudeOptions {
  env: Record<string, string | undefined>;
  additionalDirectories: string[];
  sandbox: { filesystem: { denyWrite: string[] } };
  settings: { permissions: { deny: string[] } };
}

describe("a C++ · raylib game's session on each coding engine", () => {
  it("gives Claude Code's shell that environment ahead of the login PATH, the C++ timeout and a read-only store", async () => {
    const { request, facts } = await cppRequest();
    const seen: ClaudeOptions[] = [];
    const queryFn = ((params: { prompt: string; options?: ClaudeOptions }) => {
      if (params.options) seen.push(params.options);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 };
        },
      };
    }) as never;
    const root = await tmpDir("studio-cpp-claude-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn,
    });
    await engine.delegate(request);
    await engine.delegate({ ...request, cpp: undefined, extraReads: [] });
    const [cpp, js] = seen;
    assert.equal(cpp?.env.GENEX_CMAKE, facts.env.GENEX_CMAKE);
    assert.equal(cpp?.env.EM_CONFIG, facts.env.EM_CONFIG);
    assert.ok(String(cpp?.env.PATH).startsWith([...facts.path, ""].join(path.delimiter)), cpp?.env.PATH);
    assert.equal(cpp?.env.BASH_DEFAULT_TIMEOUT_MS, String(CPP_COMMAND_TIMEOUT_MS));
    assert.equal(cpp?.env.BASH_MAX_TIMEOUT_MS, String(CPP_COMMAND_TIMEOUT_MS));
    assert.ok(cpp?.additionalDirectories.includes(facts.store), "the store is readable");
    assert.ok(cpp?.sandbox.filesystem.denyWrite.includes(facts.store), "and its shell never writes it");
    assert.ok(cpp?.settings.permissions.deny.includes(absoluteRule("Edit", facts.store)), "nor its file tools");
    for (const key of ["GENEX_CMAKE", "EM_CONFIG", "EM_CACHE", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"])
      assert.equal(js?.env[key], undefined, `a Three.js session has no ${key}`);
  });

  it("hands Codex that environment ahead of the login PATH", async () => {
    const { request, facts } = await cppRequest();
    const seen: Array<Record<string, string>> = [];
    const prompts: string[] = [];
    const execFn: CodexExec = (invocation) => {
      seen.push(invocation.env);
      prompts.push(invocation.prompt);
      return (async function* () {
        yield { type: "thread.started", thread_id: "cpp-1" };
        yield { type: "item.completed", item: { id: "a", type: "agent_message", text: "ok" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    };
    const root = await tmpDir("studio-cpp-codex-");
    const home = path.join(root, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
    await engine.delegate(request);
    await engine.delegate({ ...request, cpp: undefined, extraReads: [] });
    const [cpp, js] = seen;
    assert.equal(cpp?.GENEX_CMAKE, facts.env.GENEX_CMAKE);
    assert.equal(cpp?.EM_CACHE, facts.env.EM_CACHE);
    assert.ok(String(cpp?.PATH).startsWith([...facts.path, ""].join(path.delimiter)), cpp?.PATH);
    assert.equal(js?.GENEX_CMAKE, undefined);
    assert.ok(prompts[0]?.includes(cppShellNote(facts)), "the C++ session is told what its shell has");
    assert.equal(prompts[1]?.includes("C++ TOOLCHAIN"), false, "a Three.js session is told nothing of it");
  });
});

describe("what a Codex session is told of its C++ shell", () => {
  it("tells a Codex session only what its shell was given, and the configure line that works with it", () => {
    const store = "/store";
    const base = { store, commandTimeoutMs: CPP_COMMAND_TIMEOUT_MS };
    const unprewarmed: CppSession = { ...base, path: [], env: {} };
    const web: CppSession = {
      ...base,
      path: ["/store/cmake/bin", "/store/ninja", "/store/emsdk/emscripten"],
      env: {
        GENEX_CMAKE: "/store/locks/a/genex-web.cmake",
        CMAKE_GENERATOR: "Ninja",
        CMAKE_TOOLCHAIN_FILE: "/store/emsdk/Emscripten.cmake",
        EM_CONFIG: "/store/locks/a/emscripten.config",
        EM_CACHE: "/game/.studio/em-cache",
      },
    };
    const mac: CppSession = {
      ...base,
      path: ["/store/cmake/bin", "/store/ninja"],
      env: { GENEX_CMAKE: "/store/locks/a/genex-macos.cmake", CMAKE_GENERATOR: "Ninja" },
    };
    const none = cppShellNote(unprewarmed);
    assert.match(none, /build only with the capture tool/, "nothing set: capture is the only build");
    for (const unsaid of ["first on PATH", "GENEX_CMAKE", "EM_CONFIG", "EM_CACHE", "emcc", CPP_SHELL_BUILD.configure])
      assert.equal(none.includes(unsaid), false, `an unprewarmed session is not told of ${unsaid}`);
    const forWeb = cppShellNote(web);
    for (const said of ["CMake, Ninja and emcc", "GENEX_CMAKE", "CMAKE_TOOLCHAIN_FILE", "EM_CONFIG", "EM_CACHE"])
      assert.ok(forWeb.includes(said), `a web session is told of ${said}`);
    assert.ok(forWeb.includes(CPP_SHELL_BUILD.configure) && forWeb.includes(CPP_SHELL_BUILD.build), "and how to build");
    assert.ok(forWeb.includes(`${CPP_COMMAND_TIMEOUT_MS} ms`), "and for how long a command may run");
    const forMac = cppShellNote(mac);
    assert.ok(forMac.includes("CMake and Ninja") && forMac.includes(CPP_SHELL_BUILD.configure), forMac);
    for (const unsaid of ["emcc", "EM_CONFIG", "EM_CACHE", "CMAKE_TOOLCHAIN_FILE"])
      assert.equal(forMac.includes(unsaid), false, `a Mac session is not told of ${unsaid}`);
    for (const note of [none, forWeb, forMac]) assert.ok(note.includes(`(${store}) is read-only`), note);
  });
});

/** A core with the fixture toolchain store and a recording engine; `asks` makes the engine one a person answers. */
async function cppCore(asks = false) {
  const lite = await coreLite();
  lites.push(lite);
  const { core } = lite;
  // No harness in a lite core: a dispatch reaches nothing, and a message is still the person's.
  core.host.dispatch = async () => undefined;
  const lock = await seedFixtureToolchainStore(core.layout.toolchains, { webOutput: fixtureWebOutput() });
  assert.ok(lock, "the fixture store is seeded");
  const store = await realpath(core.layout.toolchains);
  const seen: DelegateRequest[] = [];
  core.engines.register({ ...recordingEngine(seen), permissionPrompts: asks } as never);
  await core.games.scaffold("pong", {
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Web],
  });
  const call = harnessCall(core);
  return {
    core,
    call,
    seen,
    store,
    storeCache: path.join(lockFolder(store, lock), "em-cache"),
    game: core.games.dirFor("pong"),
  };
}

/** The cache's place for the game "pong" in a core's scratch, and the folders on the way to it. */
async function cachePlace(core: StudioCore) {
  const sessions = path.join(await realpath(core.layout.scratch), "cpp-sessions");
  const folder = path.join(sessions, "pong");
  return { sessions, folder, cache: path.join(folder, "em-cache") };
}

describe("a C++ session's own Emscripten cache, outside the game folder", () => {
  it("is made by rename where a link or file was planted on its way, never through it: what the link pointed at is untouched", async () => {
    const { core, call, seen, storeCache } = await cppCore();
    const threadId = await core.threadForGame("pong");
    const outside = await tmpDir("studio-cpp-cache-outside-");
    await writeFile(path.join(outside, "keep.txt"), "keep me\n");
    const { sessions, folder, cache } = await cachePlace(core);
    const hostile: Array<[string, () => Promise<unknown>]> = [
      [
        "em-cache is a link to a folder outside",
        () => mkdir(folder, { recursive: true }).then(() => symlink(outside, cache)),
      ],
      [
        "em-cache is a link to the store's cache",
        () => mkdir(folder, { recursive: true }).then(() => symlink(storeCache, cache)),
      ],
      [
        "em-cache is a dangling link",
        () => mkdir(folder, { recursive: true }).then(() => symlink(path.join(outside, "gone"), cache)),
      ],
      ["em-cache is a file", () => mkdir(folder, { recursive: true }).then(() => writeFile(cache, "a file"))],
      [
        "the game's session folder is a link to a folder outside",
        () => mkdir(sessions, { recursive: true }).then(() => symlink(outside, folder)),
      ],
      ["the sessions folder is a link to a folder outside", () => symlink(outside, sessions)],
    ];
    for (const [label, plant] of hostile) {
      await rmEntry(sessions);
      await plant();
      const outsideBefore = await listing(outside);
      const storeBefore = await listing(storeCache);
      await call("engine.delegate", { engine: "claude-code", prompt: "go", project: "pong", threadId });
      const session = seen.at(-1)?.cpp as CppSession | undefined;
      assert.equal(session?.env.EM_CACHE, cache, `${label}: the session gets its cache`);
      for (const dir of [sessions, folder, cache]) {
        const found = await lstat(dir);
        assert.ok(found.isDirectory() && !found.isSymbolicLink(), `${label}: ${dir} is a folder of its own`);
      }
      assert.equal(await realpath(cache), cache, label);
      assert.deepEqual(await listing(outside), outsideBefore, `${label}: nothing written outside`);
      assert.deepEqual(await listing(storeCache), storeBefore, `${label}: nor into the store`);
    }
  });

  it("leaves a game's old .studio/em-cache as it is, and no longer uses it", async () => {
    const { core, call, seen, game } = await cppCore();
    const threadId = await core.threadForGame("pong");
    const old = path.join(game, ".studio", "em-cache");
    await mkdir(path.join(old, "sysroot"), { recursive: true });
    await writeFile(path.join(old, "sysroot", "from-an-earlier-session.txt"), "x");
    const before = await listing(old);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project: "pong", threadId });
    assert.equal(seen.at(-1)?.cpp?.env.EM_CACHE, (await cachePlace(core)).cache);
    assert.deepEqual(await listing(old), before, "never removed or written: it is in the person's folder");
  });
});

describe("a C++ session's -B Python, in the workspace's .studio", () => {
  it("gives no web environment where its -B Python cannot be written: a .studio that is not a plain folder", {
    skip: process.platform === StudioPlatform.Windows && "Windows uses emsdk’s Python, not a POSIX shell wrapper",
  }, async () => {
    const { core, call, seen, storeCache, game } = await cppCore();
    const threadId = await core.threadForGame("pong");
    const outside = await tmpDir("studio-cpp-outside-");
    const studio = path.join(game, ".studio");
    const hostile: Array<[string, () => Promise<unknown>]> = [
      [".studio is a link to a folder outside", () => symlink(outside, studio)],
      [".studio is a file", () => writeFile(studio, "a file")],
    ];
    for (const [label, plant] of hostile) {
      await rmEntry(studio);
      await plant();
      const outsideBefore = await listing(outside);
      const storeBefore = await listing(storeCache);
      const planted = await lstat(studio);
      await call("engine.delegate", { engine: "claude-code", prompt: "go", project: "pong", threadId });
      const session = seen.at(-1)?.cpp as CppSession | undefined;
      assert.ok(session, `${label}: still a C++ session`);
      assert.deepEqual(session.env, {}, `${label}: no environment emcc would run with`);
      assert.deepEqual(session.path, [], label);
      assert.deepEqual(await listing(outside), outsideBefore, `${label}: nothing written outside`);
      assert.deepEqual(await listing(storeCache), storeBefore, `${label}: nor into the store`);
      assert.deepEqual(await lstat(studio), planted, `${label}: what was planted is left as it was`);
    }
    await rmEntry(studio);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project: "pong", threadId });
    assert.equal(
      seen.at(-1)?.cpp?.env.EM_CACHE,
      (await cachePlace(core)).cache,
      "a plain folder gets its environment again",
    );
  });

  it("writes its -B Python by rename: a link planted at its name is replaced, never written through", {
    skip: process.platform === StudioPlatform.Windows && "Windows uses emsdk’s Python, not a POSIX shell wrapper",
  }, async () => {
    const { core, call, seen, game } = await cppCore();
    const threadId = await core.threadForGame("pong");
    const outside = await tmpDir("studio-cpp-python-outside-");
    const victim = path.join(outside, "victim.sh");
    await writeFile(victim, "keep me\n");
    await mkdir(path.join(game, ".studio"), { recursive: true });
    const wrapper = path.join(game, ".studio", "emsdk-python");
    await symlink(victim, wrapper);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project: "pong", threadId });
    assert.equal(seen.at(-1)?.cpp?.env.EMSDK_PYTHON, wrapper, "the session runs the workspace's wrapper");
    assert.equal(await readFile(victim, "utf8"), "keep me\n", "the link's target is untouched");
    assert.ok((await lstat(wrapper)).isFile(), "the link itself was replaced by the wrapper");
  });

  it("is handed to a session the person answers, without the store among the folders it may write", async () => {
    const { core, call, seen, store } = await cppCore(true);
    const threadId = await core.createGameThread("pong");
    await core.sendUserMessage("Make it jump", { thread: threadId, clientId: "msg-cpp-1", engine: "claude-code" });
    await call("engine.delegate", {
      engine: "claude-code",
      project: "pong",
      threadId,
      prompt: "Make it jump",
      chatTurn: { messageId: "msg-cpp-1" },
    });
    const request = seen.at(-1);
    assert.ok(request?.permissions, "the person answers this session");
    assert.ok(request.cpp?.env.GENEX_CMAKE, "it still builds with the C++ environment");
    assert.equal(
      (request.extraReads ?? []).includes(store),
      false,
      "the store is no folder Accept edits or Auto writes",
    );
    assert.ok(
      (request.extraReads ?? []).includes(path.dirname(request.cpp?.env.EM_CACHE ?? "")),
      "its own cache's folder is, so emcc can fill it",
    );
  });
});

/** Remove a planted entry: a link itself, never what it points at. */
async function rmEntry(entry: string): Promise<void> {
  await rm(entry, { recursive: true, force: true });
}

const execFileAsync = promisify(execFile);
/** The starter template the studio scaffolds a C++ game from. */
const TEMPLATE = path.resolve(import.meta.dirname, "../../src/game-template-cpp");
/** A configure and a first build of the template from the prewarmed cache: well under a minute here. */
const REAL_BUILD_TIMEOUT_MS = 10 * MINUTE_MS;

describe("a C++ session's shell, on the developer's real toolchain store", () => {
  it("configures and builds the starter template with nothing but a web session's environment and the line it is told", {
    ...needsTools("devStore"),
    ...needsPrewarmed(BuildTarget.Web),
    timeout: REAL_BUILD_TIMEOUT_MS,
  }, async () => {
    const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
    const lock = await devStoreLock();
    assert.ok(lock, "the dev store has a lock");
    const located = await locateToolchain(store, lock, [BuildTarget.Web]);
    assert.ok(located.ok, JSON.stringify(located));
    const storeCache = path.join(lockFolder(store, lock), "em-cache");
    const before = await listing(storeCache);
    const root = await realpath(await tmpDir("studio-cpp-session-real-"));
    const game = path.join(root, "game");
    await cp(TEMPLATE, game, { recursive: true });
    const scratch = path.join(root, "scratch");
    await mkdir(scratch);
    const session = await cppSessionFor(store, located.toolchain, BuildTarget.Web, game, { scratch, game: "game" });
    assert.ok(session.env.EM_CACHE && isInside(scratch, session.env.EM_CACHE), "the session's own cache, in scratch");
    assert.ok(!isInside(game, session.env.EM_CACHE), "not in the game folder");
    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-c", `${CPP_SHELL_BUILD.configure} && ${CPP_SHELL_BUILD.build}`],
      { cwd: game, env: cppShellEnv(session, process.env.PATH), timeout: REAL_BUILD_TIMEOUT_MS, maxBuffer: 64 << 20 },
    );
    for (const file of ["index.html", "index.js", "index.wasm"])
      assert.ok((await lstat(path.join(game, "build", "out", file))).isFile(), `${file}\n${stdout.slice(-2000)}`);
    assert.deepEqual(await listing(storeCache), before, "the store's cache is only read");
  });
});
