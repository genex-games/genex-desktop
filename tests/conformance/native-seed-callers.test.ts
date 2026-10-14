/**
 * The harness seed's callers on a C++ · raylib game (M3a): every place a night or a chat makes a
 * game folder asks for the C++ template when the intake chose a desktop destination (and nothing
 * new for a browser one), every union merge of the FACET WIRING block reaches `src/main.cpp`, and
 * every evidence window a raylib game is judged through names the build it judges.
 *
 * Each caller is driven through its own public function with a recording ctx that stops the work
 * right after the call under test, so nothing past it needs a host.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { runAutopilot } from "../../src/harness-seed/loop/autopilot.ts";
import { handleUserMessage, launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { runDirector } from "../../src/harness-seed/loop/director.ts";
import { acquireWindow, withLease } from "../../src/harness-seed/loop/evidence.ts";
import {
  type LoopRun,
  WindowLease,
  withLease as loopRunWithLease,
} from "../../src/harness-seed/loop/director/loop-run.ts";
import { acquireWorkerWindow } from "../../src/harness-seed/loop/director/workers.ts";
import { ProjectStarter } from "../../src/harness-seed/loop/folder-facts.ts";
import { takeIntegration } from "../../src/harness-seed/loop/facet/phases/gate.ts";
import { runGauntlet } from "../../src/harness-seed/loop/gauntlet.ts";
import { shortFailure } from "../../src/harness-seed/loop/git.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { EventKind } from "../../src/harness-seed/loop/run-events.ts";
import { EngineId } from "../../src/harness-seed/loop/model-roles.ts";
import {
  BuildTarget,
  GameStack,
  ProjectKind,
  StudioPlatform,
  TargetRefusal,
} from "../../src/harness-seed/loop/native-contract.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";
import { loopRunRefusal } from "../../src/harness-seed/loop/run-dispatch.ts";
import { GameValidationCode } from "../../src/shared/game-project.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { createToolRegistry } from "../../src/harness-seed/tools/index.ts";
import { templateShapeFor } from "../../src/harness-seed/loop/native-loop.ts";
import { RAYLIB_SHAPE, RUST_SHAPE } from "../../src/substrate/project-shape.ts";
import type { HarnessCtx, Run, ToolCtx } from "../../src/harness-seed/types/harness.d.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { ctxRecorder, type CtxRecorder } from "../helpers/ctx-recorder.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

/** What a desktop intake chose, and what a browser intake chose. */
const DESKTOP = [BuildTarget.Mac, BuildTarget.Web];
const BROWSER = [BuildTarget.Web];

/** The sentinel a recording ctx throws right after the scaffold, so the caller goes no further. */
const STOP_AFTER_SCAFFOLD = "stopped after the scaffold";

/**
 * A ctx that answers lists empty (the game list: `games`) and anything else null, and stops the
 * work at `game.scaffold`.
 */
function scaffoldRecorder(extra: Record<string, unknown> = {}, games: unknown[] = []): CtxRecorder {
  return ctxRecorder({
    unknown: { value: null },
    extra,
    handlers: {
      [HostMethod.GameList]: () => games,
      [HostMethod.EventsList]: () => [],
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.PluginsTools]: () => ({ guidance: "" }),
      [HostMethod.EngineComplete]: () => ({ message: { role: "assistant", content: JSON.stringify(onePlan()) } }),
      [HostMethod.GameScaffold]: () => {
        throw new Error(STOP_AFTER_SCAFFOLD);
      },
    },
  });
}

/** A one-facet plan a planner might answer. */
function onePlan() {
  return {
    facets: [
      {
        id: "court",
        title: "Court",
        intent: "the court the paddles play on",
        owns: ["src/court.cpp"],
        checks: [{ id: "court-lit", kind: "pixel", camera: "default", expr: "meanLuma > 0.1" }],
      },
    ],
    integrationNotes: "",
  };
}

/** A night's run, with the destinations its intake chose. */
function nightRun(targets: readonly string[] | undefined): Run {
  return {
    runId: "run_native",
    goal: "a pong you can play on the Mac",
    project: "pong",
    reference: { name: "pong", shots: [], kind: "direction" },
    budgets: { wallClockMs: HOUR_MS },
    ...(targets ? { targets: [...targets] } : {}),
  } as Run;
}

/** The scaffold calls a caller made, whatever became of the work after them. */
async function scaffoldsOf(recorder: CtxRecorder, work: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  await work().catch((error: unknown) => {
    if ((error as Error)?.message !== STOP_AFTER_SCAFFOLD) throw error;
  });
  return recorder.paramsOf(HostMethod.GameScaffold);
}

/**
 * The callers that name the web starter for a new browser game, as the seed's runs and chat launch
 * always have (a new project is otherwise empty); a chat turn and `new_game` name no kind.
 */
const NAMES_WEB_STARTER: ReadonlySet<string> = new Set([
  "gauntlet.ts runGauntlet",
  "autopilot.ts runAutopilot",
  "director/setup.ts (runDirector)",
  "chat-dispatch.ts launchFromIntake",
]);

/** The kind `caller` asks a new browser game's scaffold for: the web starter, or none. */
function browserKindOf(caller: string): ProjectStarter | undefined {
  return NAMES_WEB_STARTER.has(caller) ? ProjectStarter.Web : undefined;
}

/** The six callers that make a game folder, each driven to its scaffold with an intake's destinations. */
const SCAFFOLD_CALLERS: Array<{
  caller: string;
  scaffold: (targets: readonly string[] | undefined) => Promise<Record<string, unknown>[]>;
}> = [
  {
    caller: "gauntlet.ts runGauntlet",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      return scaffoldsOf(recorder, () =>
        runGauntlet(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run: nightRun(targets) }),
      );
    },
  },
  {
    caller: "autopilot.ts runAutopilot",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      return scaffoldsOf(recorder, () =>
        runAutopilot(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run: nightRun(targets) }),
      );
    },
  },
  {
    caller: "director/setup.ts (runDirector)",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      return scaffoldsOf(recorder, () =>
        runDirector(recorder.ctx as unknown as HarnessCtx, {
          threadId: "t1",
          run: { ...nightRun(targets), directorLoop: "wake" },
        }),
      );
    },
  },
  {
    caller: "chat-dispatch.ts launchFromIntake",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      const studio = {
        host: recorder.ctx.host,
        cancels: new Set(),
        moodBoards: new Map(),
        activeRuns: new Map(),
        startingRuns: new Map(),
        orphanRuns: new Map(),
      };
      const spec = { goal: "a pong you can play on the Mac", project: "pong", ...(targets ? { targets } : {}) };
      return scaffoldsOf(recorder, () =>
        launchFromIntake(
          studio as never,
          recorder.ctx as unknown as HarnessCtx,
          { threadId: "t1", text: "make pong" },
          spec,
        ),
      );
    },
  },
  {
    caller: "delegated-turn.ts runDelegatedTurn",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      const options = {
        threadId: "t1",
        turnId: "turn-1",
        engine: EngineId.ClaudeCode,
        engineLabel: "Claude Code",
        text: "make a pong game I can play on my Mac",
        ...(targets ? { targets } : {}),
      };
      return scaffoldsOf(recorder, () => runDelegatedTurn(recorder.ctx as unknown as HarnessCtx, options));
    },
  },
  {
    caller: "tools/game-tools.ts new_game",
    scaffold: (targets) => {
      const recorder = scaffoldRecorder();
      const tool = gameTools.find((t) => t.name === "new_game");
      assert.ok(tool, "new_game is a tool");
      const args = { name: "pong", title: "Pong", ...(targets ? { targets } : {}) };
      return scaffoldsOf(recorder, async () => tool.execute(args, recorder.ctx as unknown as ToolCtx));
    },
  },
];

describe("scaffold callers on a desktop intake (Rust · wgpu since raylib creation ended)", () => {
  for (const { caller, scaffold } of SCAFFOLD_CALLERS) {
    it(`${caller} passes kind rust-wgpu and the targets for a desktop intake`, async () => {
      const [params] = await scaffold(DESKTOP);
      assert.ok(params, "it scaffolded");
      assert.equal(params.kind, ProjectKind.RustWgpu);
      assert.deepEqual(params.targets, DESKTOP);
    });

    it(`${caller} passes nothing new for a browser intake`, async () => {
      for (const targets of [BROWSER, undefined]) {
        const [params] = await scaffold(targets);
        assert.ok(params, "it scaffolded");
        assert.equal(params.kind, browserKindOf(caller), JSON.stringify(params));
        assert.equal("targets" in params, false, JSON.stringify(params));
      }
    });
  }

  it("hostile destinations are dropped before the host sees them", async () => {
    const newGame = SCAFFOLD_CALLERS.find(({ caller }) => caller.endsWith("new_game"));
    assert.ok(newGame, "new_game is a scaffold caller");
    const [params] = await newGame.scaffold(["macos", "macos", "../etc", 7 as unknown as string, "linux"]);
    assert.deepEqual(params?.targets, [BuildTarget.Mac, BuildTarget.Linux]);
  });
});

describe("a night resumed after raylib creation ended, on the raylib game its run record names (M6 review)", () => {
  /** The game the library lists: the raylib folder a pre-M6 desktop night made. */
  const RAYLIB_PONG = { name: "pong", shape: { kind: ProjectKind.RaylibCpp, main: "src/main.cpp" } };
  const NIGHTS: Array<{ caller: string; run: (ctx: HarnessCtx, run: Run) => Promise<unknown> }> = [
    { caller: "gauntlet.ts runGauntlet", run: (ctx, run) => runGauntlet(ctx, { threadId: "t1", run }) },
    { caller: "autopilot.ts runAutopilot", run: (ctx, run) => runAutopilot(ctx, { threadId: "t1", run }) },
    {
      caller: "director/setup.ts (runDirector)",
      run: (ctx, run) => runDirector(ctx, { threadId: "t1", run: { ...run, directorLoop: "wake" } }),
    },
  ];
  for (const { caller, run } of NIGHTS) {
    it(`${caller} asks for the listed game as it is, never a Rust scaffold its folder would refuse`, async () => {
      const recorder = scaffoldRecorder({}, [RAYLIB_PONG]);
      const [params] = await scaffoldsOf(recorder, () => run(recorder.ctx as unknown as HarnessCtx, nightRun(DESKTOP)));
      assert.ok(params, "it scaffolded");
      assert.equal("kind" in params, false, JSON.stringify(params));
      assert.equal("targets" in params, false, JSON.stringify(params));
    });
  }
});

/** A ctx whose `run.exec` runs the command in the folder it names: real git, no host. */
function localCtx() {
  return {
    workspace: "/nonexistent",
    cancelled: false,
    notify() {},
    setStatus() {},
    call: async (method: string, p: { command: string; cwd: string }) => {
      if (method !== HostMethod.RunExec) return null;
      try {
        const { stdout, stderr } = await promisify(execFile)("sh", ["-c", p.command], {
          cwd: p.cwd,
          maxBuffer: 10_000_000,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
  };
}

/** The C++ template's entry with its FACET WIRING block, and one facet's line in it. */
const MAIN_CPP = (wired: string[]) =>
  [
    '#include "studio.h"',
    "int main() {",
    "  studio::Game game = starterGame();",
    "  // ── FACET WIRING ── one line per facet, nothing else: void wire_<slug>(studio::Game&); wire_<slug>(game);",
    ...wired.map((slug) => `  void wire_${slug}(studio::Game&); wire_${slug}(game);`),
    "  // ── END FACET WIRING ──",
    "  studio::install(std::move(game));",
    "  return 0;",
    "}",
    "",
  ].join("\n");

/** A raylib game whose integration branch wired `dash` and whose facet worktree wired `jump`, on the facet. */
async function twoWirings() {
  const dir = await tmpDir("native-union-");
  const git = async (...args: string[]) => (await gitFile(args, { cwd: dir })).stdout.trim();
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "main.cpp"), MAIN_CPP([]));
  await git("add", "-A");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "integration");
  await writeFile(path.join(dir, "src", "main.cpp"), MAIN_CPP(["dash"]));
  await git("commit", "-qam", "dash");
  const integrationHead = await git("rev-parse", "HEAD");
  await git("checkout", "-q", "main");
  await git("checkout", "-qb", "facet");
  await writeFile(path.join(dir, "src", "main.cpp"), MAIN_CPP(["jump"]));
  await git("commit", "-qam", "jump");
  const facetHead = await git("rev-parse", "HEAD");
  return { dir, git, integrationHead, facetHead };
}

/** The facet loop as the round's integration step reads it, on a game of `shape`; `ownsMain` when the part owns its entry. */
function facetLoop(
  repo: Awaited<ReturnType<typeof twoWirings>>,
  shape: Record<string, unknown>,
  ownShape: boolean,
  ownsMain = false,
) {
  const ctx = localCtx();
  const events: Array<Record<string, unknown>> = [];
  const loop = {
    ctx,
    gitOptions: { label: "facet:jump", timeoutMs: 30_000, failure: shortFailure },
    gitWhere: repo.dir,
    worktree: repo.dir,
    integration: { head: async () => repo.integrationHead },
    mergedIntegration: null as string | null,
    incumbentCommit: repo.facetHead,
    integrationNote: null as string | null,
    appendRun: async (_type: string, payload: Record<string, unknown>) => void events.push(payload),
    facet: { id: "jump" },
    run: { runId: "run_native" },
    git: async (command: string) =>
      String((await ctx.call(HostMethod.RunExec, { command, cwd: repo.dir }))?.stdout ?? "").trim(),
    ownShape,
    ownsMain,
    shape,
  };
  return { loop, events };
}

describe("union merge of the FACET WIRING block in src/main.cpp", () => {
  it("the seed plans a desktop intake's night with the host's own Rust template shape", () => {
    assert.deepEqual(templateShapeFor([BuildTarget.Mac]), RUST_SHAPE);
    assert.equal(templateShapeFor([BuildTarget.Web]), null, "a browser intake keeps the three.js template");
  });

  for (const ownShape of [false, true]) {
    it(`a facet takes the integration head by union merge (raylib, ownShape ${ownShape}): wiring is the template's`, async () => {
      const repo = await twoWirings();
      const { loop, events } = facetLoop(repo, { ...RAYLIB_SHAPE }, ownShape);
      const round: Record<string, unknown> = {};
      await takeIntegration(loop as never, round as never);
      assert.equal(loop.integrationNote, null, String(loop.integrationNote));
      assert.equal(events.at(-1)?.union, true, JSON.stringify(events));
      const merged = await readFile(path.join(repo.dir, "src", "main.cpp"), "utf8");
      assert.match(merged, /wire_dash\(game\);/);
      assert.match(merged, /wire_jump\(game\);/);
      assert.doesNotMatch(merged, /^(<{7}|={7}|>{7})/m);
      assert.equal(await repo.git("status", "--porcelain"), "", "the merge is committed");
    });
  }

  it("a browser game the user brought never union-merges its entry: a conflict in the part's own entry is left to its builder", async () => {
    const repo = await twoWirings();
    const ownGame = {
      entry: "index.html",
      main: "src/main.cpp",
      build: "vite build",
      own: true,
      kind: "three-vite",
      serve: "dist",
    };
    // The part owns the entry: since merges settle by ownership, a conflict in another part's file
    // takes the integration side, so only one of its own is left to its builder.
    const { loop } = facetLoop(repo, ownGame, true, true);
    await takeIntegration(loop as never, {} as never);
    assert.match(String(loop.integrationNote), /could not merge it automatically/);
    assert.match(String(loop.integrationNote), /src\/main\.cpp/);
  });
});

describe("evidence windows for a raylib game name the build they judge", () => {
  /** A Mac host with a game box, as `preview.capacity` reports it. */
  const MAC_HOST = { max: 4, inUse: 0, host: StudioPlatform.Mac, native: { gameBox: true, leases: 0, max: 4 } };
  const raylibGame = (targets: BuildTarget[]) => ({ destinations: { stack: GameStack.RaylibCpp, targets } });
  const leaseRecorder = () =>
    ctxRecorder({
      handlers: {
        [HostMethod.PreviewAcquire]: () => ({ handle: "h1" }),
        [HostMethod.PreviewCapacity]: () => MAC_HOST,
        [HostMethod.PreviewRelease]: () => true,
      },
    });

  const rows: Array<{ game: Record<string, unknown> | undefined; target: string; why: string }> = [
    // FLIPPED back from wave 2's "Mac → Web": the native evidence pass reads native captures.
    { game: raylibGame([BuildTarget.Mac]), target: BuildTarget.Mac, why: "a Mac-only game is judged on its Mac build" },
    { game: raylibGame([BuildTarget.Web, BuildTarget.Mac]), target: BuildTarget.Web, why: "Browser is a destination" },
    { game: raylibGame([BuildTarget.Windows]), target: BuildTarget.Web, why: "a judging-only web build on a Mac" },
    { game: undefined, target: BuildTarget.Web, why: "a Three.js game, as always" },
  ];
  for (const { game, target, why } of rows) {
    it(`acquireWindow names ${target}: ${why}`, async () => {
      const recorder = leaseRecorder();
      const handle = await acquireWindow(recorder.ctx as unknown as HarnessCtx, "evidence", game ? { game } : {});
      assert.equal(handle, "h1");
      assert.deepEqual(
        recorder.paramsOf(HostMethod.PreviewAcquire).map((p) => p.target),
        [target],
      );
    });
  }

  it("the director's own looks and its workers' windows name the night's game's target", async () => {
    // A director night used to lease every window with no game: a worker's acquire named no
    // target, which the host refuses for a raylib game. A Mac-only game's target is its Mac build
    // (FLIPPED back from wave 2's judging-only web build).
    const recorder = leaseRecorder();
    const loopRun = {
      ctx: recorder.ctx,
      pooledWindows: true,
      capacity: MAC_HOST,
      leaseGame: raylibGame([BuildTarget.Mac]),
    } as unknown as LoopRun;
    assert.equal(await loopRunWithLease(loopRun, WindowLease.Judge, async (handle) => handle), "h1");
    assert.equal(await acquireWorkerWindow(loopRun, "dash"), "h1");
    assert.deepEqual(
      recorder.paramsOf(HostMethod.PreviewAcquire).map((p) => [p.target, p.label]),
      [
        [BuildTarget.Mac, WindowLease.Judge],
        [BuildTarget.Mac, "dash"],
      ],
    );
  });

  it("withLease passes the game through to the acquire", async () => {
    const recorder = leaseRecorder();
    const seen = await withLease(recorder.ctx as unknown as HarnessCtx, "judge", async (handle) => handle, {
      game: raylibGame([BuildTarget.Windows]),
    });
    assert.equal(seen, "h1");
    assert.deepEqual(
      recorder.paramsOf(HostMethod.PreviewAcquire).map((p) => p.target),
      [BuildTarget.Web],
    );
  });
});

describe("plugin listings follow the game's stack", () => {
  it("plugins.tools for a C++ · raylib game names no three.js-only skill; a three.js game's and a call naming none still do", async () => {
    const { core, api, close } = await coreLite({});
    try {
      await core.games.scaffold("pong", {
        title: "pong",
        stack: GameStack.RaylibCpp,
        caller: ScaffoldCaller.Internal,
        targets: [BuildTarget.Web],
      });
      await core.games.scaffold("web", { title: "web" });
      const cpp = await api()["plugins.tools"]({ project: "pong" });
      assert.doesNotMatch(cpp.guidance, /genex-threejs-/, "a C++ game's guidance");
      const three = await api()["plugins.tools"]({ project: "web" });
      assert.match(three.guidance, /genex-threejs-multiplayer/);
      const none = await api()["plugins.tools"]({});
      assert.match(none.guidance, /genex-threejs-multiplayer/, "with no game named, every skill");
    } finally {
      await close();
    }
  });

  it("the harness's tool registry asks for its run's game's plugin tools", async () => {
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      handlers: {
        [HostMethod.PluginsTools]: () => ({ tools: [], guidance: "", revision: 1 }),
        [HostMethod.McpTools]: () => ({ tools: [], guidance: "", revision: 1 }),
      },
    });
    await createToolRegistry(recorder.ctx as unknown as HarnessCtx, { project: "pong" });
    assert.deepEqual(recorder.paramsOf(HostMethod.PluginsTools), [{ project: "pong" }]);
  });
});

describe("run_command in a raylib game", () => {
  /** The `run.exec` timeout `run_command` asks for in a game of `kind` when the call names none. */
  async function defaultTimeout(kind: string): Promise<unknown> {
    const recorder = ctxRecorder({
      extra: { project: "pong" },
      handlers: {
        [HostMethod.GameList]: () => [{ name: "pong", dir: "/games/pong", shape: { kind, main: "src/main.cpp" } }],
        [HostMethod.RunExec]: () => ({ code: 0, stdout: "", stderr: "" }),
      },
    });
    const tool = gameTools.find((t) => t.name === "run_command");
    assert.ok(tool, "run_command is a tool");
    await tool.execute({ command: "cmake --build build" }, recorder.ctx as unknown as ToolCtx);
    return recorder.paramsOf(HostMethod.RunExec)[0]?.timeoutMs;
  }

  it("a C++ build gets ten minutes by default; a browser game keeps two", async () => {
    assert.equal(await defaultTimeout(ProjectKind.RaylibCpp), 10 * 60_000);
    assert.equal(await defaultTimeout("studio-template"), 2 * 60_000);
  });
});

describe("the launch tools carry the intake's destinations", () => {
  /** The run a launch tool commissions with `targets`. */
  async function launched(name: string, targets: string[] | undefined): Promise<Record<string, unknown>> {
    const recorder = ctxRecorder({
      extra: { engine: EngineId.ClaudeCode, loop: { hours: 2 }, autopilot: { hours: 2 } },
    });
    const tool = gameTools.find((t) => t.name === name);
    assert.ok(tool, `${name} is a tool`);
    const args = { goal: "a pong for the Mac", direction: "neon arcade", ...(targets ? { targets } : {}) };
    const outcome = (await tool.execute(args, recorder.ctx as unknown as ToolCtx)) as {
      details?: { run?: Record<string, unknown> };
    };
    assert.ok(outcome.details?.run, `${name} commissioned a run`);
    return outcome.details.run;
  }

  for (const name of ["start_unattended_run", "start_autopilot"]) {
    it(`${name} puts a desktop intake's targets on the run, and nothing for a browser one`, async () => {
      assert.deepEqual((await launched(name, ["macos", "web"])).targets, [BuildTarget.Mac, BuildTarget.Web]);
      assert.equal("targets" in (await launched(name, ["web"])), false);
      assert.equal("targets" in (await launched(name, undefined)), false);
    });
  }
});

describe("a desktop destination for a game that already exists", () => {
  /** A host that lists one game of `kind` and records what a chat launch appends and scaffolds. */
  function intakeHost(kind: string) {
    const game = { name: "plaza", dir: "/games/plaza", title: "Plaza", shape: { kind, main: "src/main.js" } };
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        [HostMethod.GameList]: () => [game],
        [HostMethod.GameValidate]: () => ({ contract: "loaded", problems: [], codes: [] }),
        [HostMethod.EventsAppend]: () => true,
      },
    });
    const studio = {
      host: recorder.ctx.host,
      cancels: new Set(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => {
        throw new Error("a refused launch opens no scope");
      },
    };
    return { recorder, studio };
  }

  it("a three.js game asked for the Mac is refused by its code, and nothing is scaffolded or started", async () => {
    const { recorder, studio } = intakeHost("studio-template");
    await assert.rejects(
      launchFromIntake(
        studio as never,
        recorder.ctx as unknown as HarnessCtx,
        { threadId: "t1", project: "plaza" },
        { goal: "the plaza, on my Mac", targets: [BuildTarget.Mac] },
      ),
      { code: TargetRefusal.StackIsFixed },
    );
    assert.deepEqual(recorder.paramsOf(HostMethod.GameScaffold), []);
    assert.equal(studio.activeRuns.size, 0);
  });

  it("the same three.js game asked for the browser launches as always", async () => {
    const { recorder, studio } = intakeHost("studio-template");
    await launchFromIntake(
      studio as never,
      recorder.ctx as unknown as HarnessCtx,
      { threadId: "t1", project: "plaza" },
      { goal: "the plaza", targets: [BuildTarget.Web] },
    );
    const said = recorder.paramsOf(HostMethod.EventsAppend).flatMap((p) => p.batch as Array<Record<string, unknown>>);
    assert.ok(
      said.some((entry) => entry.type === EventKind.Messages),
      "the chat is promised its night",
    );
    assert.deepEqual(recorder.paramsOf(HostMethod.GameScaffold), []);
  });

  it("a chat whose session asks for the Mac on a three.js folder records the refusal's code durably", async () => {
    const log: Array<Record<string, any>> = [];
    const game = { name: "plaza", dir: "/games/plaza", title: "Plaza", shape: { kind: "studio-template" } };
    const launch = {
      name: "start_autopilot",
      args: { goal: "the plaza on my Mac", direction: "dusk", targets: [BuildTarget.Mac] },
    };
    const answers: Record<string, (params: Record<string, any>) => unknown> = {
      [HostMethod.EngineDescribe]: () => [{ id: EngineId.Codex, kind: "delegated", label: "Codex" }],
      [HostMethod.EventsList]: () => [...log],
      [HostMethod.EventsAppend]: (params) => void log.push(...params.batch),
      [HostMethod.TurnBegin]: () => ({ turnId: "turn-1" }),
      [HostMethod.EventsMessages]: () => [{ role: "user", content: "make the plaza for my Mac" }],
      [HostMethod.GameList]: () => [game],
      [HostMethod.GameValidate]: () => ({ contract: "loaded", problems: [], codes: [] }),
      [HostMethod.EngineDelegate]: () => ({
        ok: true,
        engine: EngineId.Codex,
        turns: 1,
        usage: {},
        sessionId: "chat-1",
        summary: "Starting it for the Mac.",
        studioToolCalls: [launch],
      }),
    };
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      heartbeat: () => {},
      call: async (method: string, params: Record<string, any>): Promise<unknown> => answers[method]?.(params) ?? null,
    };
    const studio: Record<string, any> = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
    };
    studio.scoped = () => ({ ...host, host, threadId: "t1", setStatus: () => {}, cancelled: false });
    const action = {
      type: "user_message",
      threadId: "t1",
      text: "make the plaza for my Mac",
      engine: EngineId.Codex,
      project: "plaza",
      messageId: "m1",
      autopilot: { hours: 2 },
    };
    await handleUserMessage(studio as never, action as never);
    const blocked = log.find((entry) => entry.event_type === "run_start_blocked");
    assert.equal(blocked?.payload?.code, TargetRefusal.StackIsFixed, JSON.stringify(log));
    assert.equal(studio.activeRuns.size, 0, "no night was started");
  });
});

/** A compiled or web game as the library lists it: served at its root, of the given kind. */
function listedGame(name: string, kind: string, main: string) {
  return {
    name,
    dir: `/games/${name}`,
    facts: [{ id: "web-game", path: "." }],
    shape: { kind, main, entry: "index.html", build: null },
  };
}

const RUST_GAME = listedGame("ferris", ProjectKind.RustWgpu, "src/main.rs");
const RAYLIB_GAME = listedGame("pong", ProjectKind.RaylibCpp, "src/main.cpp");
const WEB_GAME = listedGame("orbit", ProjectKind.StudioTemplate, "src/main.js");

/** A chat launch of `game`, whose `game.validate` answers `readiness`. */
function launchListed(game: ReturnType<typeof listedGame>, readiness: Record<string, unknown>): Promise<void> {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [game],
      [HostMethod.EventsList]: () => [],
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.GameValidate]: () => readiness,
    },
  });
  const studio = {
    host: recorder.ctx.host,
    cancels: new Set(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
  };
  return launchFromIntake(
    studio as never,
    recorder.ctx as unknown as HarnessCtx,
    { threadId: "t1", text: "go" },
    { goal: "make it better", project: game.name },
  );
}

describe("a compiled folder with nothing to build on is refused at launch, by its codes", () => {
  it("a Rust game whose genex.toml is missing", async () => {
    const readiness = {
      ok: false,
      problems: ["genex.toml is missing"],
      codes: [GameValidationCode.MissingFile],
      missing: [],
      shape: RUST_GAME.shape,
    };
    await assert.rejects(launchListed(RUST_GAME, readiness), /ferris is not ready for a run: genex\.toml is missing/);
  });

  it("a raylib game whose CMakeLists.txt is not a plain file", () => {
    const refused = loopRunRefusal(RAYLIB_GAME, ["CMakeLists.txt is not a plain file"], [], {
      codes: [GameValidationCode.NativeMissingCMake],
    });
    assert.match(String(refused), /CMakeLists\.txt is not a plain file/);
  });

  it("a Rust game's own Cargo.toml is the lane's refusal, not the launch's", () => {
    const refused = loopRunRefusal(RUST_GAME, ["Cargo.toml is the studio's"], [], {
      codes: [GameValidationCode.RustOwnBuildInput],
    });
    assert.equal(refused, null);
  });

  it("a web game is still decided by its missing names alone, never by codes or words", () => {
    const codes = [GameValidationCode.MissingFile];
    assert.equal(loopRunRefusal(WEB_GAME, ["index.html is missing"], [], { codes }), null);
    assert.match(String(loopRunRefusal(WEB_GAME, [], ["index.html"], { codes })), /index\.html is missing/);
  });

  it("an older caller that hands no codes checks nothing", () => {
    assert.equal(loopRunRefusal(RUST_GAME, ["genex.toml is missing"], []), null);
  });

  it("a game a newer Genex made is refused by kind-unsupported, whatever its stack reads as", () => {
    const own = { name: "future", shape: { kind: "own-script", main: "index.html" } };
    const words = "a newer version of Genex made this game, so it opens read-only";
    const refused = loopRunRefusal(own, [words], [], { codes: [GameValidationCode.KindUnsupported] });
    assert.match(String(refused), /future is not ready for a run: a newer version/);
  });
});
