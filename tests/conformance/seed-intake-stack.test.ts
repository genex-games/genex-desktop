/**
 * Retiring C++ · raylib creation in the harness seed (M6.6): every seed intake that makes a game
 * folder asks a desktop destination for a Rust · wgpu game, never for raylib; the tools the model
 * reads stop offering raylib; and a harness workspace that kept an intake from before Rust games
 * is refused, typed and with the "re-take the seed copy" remedy, before any folder exists, so it
 * never gets a Rust folder the host would then refuse to lease to it.
 *
 * The current seed's callers are driven through their public functions with a recording ctx that
 * stops right after `game.scaffold`. A kept copy is the module as the pre-Rust seed shipped it
 * (read from Git), laid into a harness workspace and imported from there, so it links against the
 * current seed exactly as it would in the app.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runAutopilot } from "../../src/harness-seed/loop/autopilot.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { runDirector } from "../../src/harness-seed/loop/director.ts";
import { runGauntlet } from "../../src/harness-seed/loop/gauntlet.ts";
import { ProjectStarter } from "../../src/harness-seed/loop/folder-facts.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { EngineId } from "../../src/harness-seed/loop/model-roles.ts";
import { BuildTarget, NativeNightRefusal, ProjectKind } from "../../src/harness-seed/loop/native-contract.ts";
import { templateShapeFor } from "../../src/harness-seed/loop/native-loop.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import type { HarnessCtx, HarnessTool, Run, ToolCtx } from "../../src/harness-seed/types/harness.d.ts";
import { CreationRefusal, GameStack } from "../../src/shared/game-project.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The seed the app ships, as the tests read it. */
const SEED = path.resolve(import.meta.dirname, "../../src/harness-seed");
/**
 * The seed a harness workspace kept modules from before Rust games: origin/dev at cf4b2c56, the
 * public seed the compiled stacks were ported onto. Its modules lack `SERVES_RUST`.
 */
const PRE_RUST_SEED = "cf4b2c56";
/** Why the rows that read the pre-Rust seed from Git do not run: that commit is not in every clone. */
const preRustMissing = commitInClone(PRE_RUST_SEED) ? false : `not run: ${PRE_RUST_SEED} is not in this clone`;
/** The sentinel a recording ctx throws right after the scaffold, so the caller goes no further. */
const STOP_AFTER_SCAFFOLD = "stopped after the scaffold";
/** The words every re-take remedy carries, beside the module it names. */
const RETAKE = /re-take the seed copy/i;

/** Desktop intakes, with and without the browser: each is a Rust · wgpu game now, as raylib's once were. */
const DESKTOP_INTAKES: readonly BuildTarget[][] = [
  [BuildTarget.Mac],
  [BuildTarget.Mac, BuildTarget.Web],
  [BuildTarget.Windows, BuildTarget.Linux],
  [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
];

/** A ctx that answers lists empty and anything else null, and stops the work at `game.scaffold`. */
function scaffoldRecorder(): CtxRecorder {
  return ctxRecorder({
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [],
      [HostMethod.EventsList]: () => [],
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.PluginsTools]: () => ({ guidance: "" }),
      [HostMethod.GameScaffold]: () => {
        throw new Error(STOP_AFTER_SCAFFOLD);
      },
    },
  });
}

/** A night's run, with the destinations its intake chose. */
function nightRun(targets: readonly string[]): Run {
  return {
    runId: "run_intake",
    goal: "a pong you can play on the Mac",
    project: "pong",
    reference: { name: "pong", shots: [], kind: "direction" },
    budgets: { wallClockMs: HOUR_MS },
    targets: [...targets],
  } as Run;
}

/** The scaffold calls a caller made, whatever became of the work after them. */
async function scaffoldsOf(recorder: CtxRecorder, work: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  await work().catch((error: unknown) => {
    if ((error as Error)?.message !== STOP_AFTER_SCAFFOLD) throw error;
  });
  return recorder.paramsOf(HostMethod.GameScaffold);
}

/** The chat's studio, as launchFromIntake reads it. */
function chatStudio(recorder: CtxRecorder) {
  return {
    host: recorder.ctx.host,
    cancels: new Set(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
  };
}

/** A tool of `list` by name. */
function toolNamed(list: readonly HarnessTool[], name: string): HarnessTool {
  const tool = list.find((t) => t.name === name);
  assert.ok(tool, `${name} is a tool`);
  return tool;
}

/** Every seed intake that makes a game folder, driven to its scaffold with an intake's destinations. */
const INTAKES: Array<{ caller: string; scaffold: (targets: readonly string[]) => Promise<Record<string, unknown>[]> }> =
  [
    {
      caller: "tools/game-tools.ts new_game",
      scaffold: (targets) => {
        const recorder = scaffoldRecorder();
        const tool = toolNamed(gameTools, "new_game");
        const args = { name: "pong", title: "Pong", targets };
        return scaffoldsOf(recorder, async () => tool.execute(args, recorder.ctx as unknown as ToolCtx));
      },
    },
    {
      caller: "chat-dispatch.ts launchFromIntake",
      scaffold: (targets) => {
        const recorder = scaffoldRecorder();
        const spec = { goal: "a pong you can play on the Mac", project: "pong", targets };
        return scaffoldsOf(recorder, () =>
          launchFromIntake(
            chatStudio(recorder) as never,
            recorder.ctx as unknown as HarnessCtx,
            { threadId: "t1", text: "make pong" },
            spec,
          ),
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
      caller: "gauntlet.ts runGauntlet",
      scaffold: (targets) => {
        const recorder = scaffoldRecorder();
        return scaffoldsOf(recorder, () =>
          runGauntlet(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run: nightRun(targets) }),
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
      caller: "delegated-turn.ts runDelegatedTurn",
      scaffold: (targets) => {
        const recorder = scaffoldRecorder();
        const options = {
          threadId: "t1",
          turnId: "turn-1",
          engine: EngineId.ClaudeCode,
          engineLabel: "Claude Code",
          text: "make a pong game I can play on my Mac",
          targets,
        };
        return scaffoldsOf(recorder, () => runDelegatedTurn(recorder.ctx as unknown as HarnessCtx, options));
      },
    },
  ];

describe("the current seed's intake makes a desktop game in Rust · wgpu", () => {
  for (const { caller, scaffold } of INTAKES) {
    it(`${caller} asks a desktop intake for kind rust-wgpu with its destinations, never raylib`, async () => {
      for (const targets of DESKTOP_INTAKES) {
        const [params] = await scaffold(targets);
        assert.ok(params, `it scaffolded for ${targets.join(",")}`);
        assert.equal(params.kind, ProjectKind.RustWgpu, targets.join(","));
        assert.deepEqual(params.targets, targets);
      }
    });

    it(`${caller} still asks nothing new for a browser intake`, async () => {
      const [params] = await scaffold([BuildTarget.Web]);
      assert.ok(params, "it scaffolded");
      // The runs and the chat launch name the web starter, as before Rust games; new_game and a
      // chat turn name no kind.
      const namesNoKind = caller === "tools/game-tools.ts new_game" || caller.startsWith("delegated-turn.ts");
      assert.equal(params.kind, namesNoKind ? undefined : ProjectStarter.Web, JSON.stringify(params));
      assert.equal("targets" in params, false, JSON.stringify(params));
    });
  }

  it("a night planned before its desktop folder exists plans with the Rust template's shape", () => {
    assert.equal(templateShapeFor([BuildTarget.Mac])?.kind, ProjectKind.RustWgpu);
    assert.equal(templateShapeFor([BuildTarget.Mac])?.main, "src/main.rs");
    assert.equal(templateShapeFor([BuildTarget.Web]), null);
  });

  it("the tools the model reads never offer a C++ · raylib game", () => {
    for (const name of ["new_game", "start_unattended_run", "start_autopilot"]) {
      const tool = toolNamed(gameTools, name);
      const read = JSON.stringify({ description: tool.description, parameters: tool.parameters });
      assert.doesNotMatch(read, /raylib|C\+\+/i, name);
    }
  });
});

/** A copy of the seed in a folder of its own, with `kept` modules replaced by the pre-Rust seed's own copies. */
async function seedKeeping(kept: readonly string[]): Promise<string> {
  const dir = path.join(await tmpDir("seed-intake-kept-"), "harness-seed");
  await cp(SEED, dir, { recursive: true });
  for (const rel of kept) await writeFile(path.join(dir, rel), await preRustCopy(rel));
  return dir;
}

/** Whether `commit` is in the clone the tests run from. */
function commitInClone(commit: string): boolean {
  try {
    execFileSync("git", ["-C", SEED, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The module at `rel` as the pre-Rust seed shipped it. */
async function preRustCopy(rel: string): Promise<string> {
  return (await gitFile(["show", `${PRE_RUST_SEED}:src/harness-seed/${rel}`], { cwd: SEED })).stdout as string;
}

describe("a chat launcher beside parts kept from before Rust games", () => {
  it("refuses a desktop intake typed, naming the kept module and its re-take, before any folder exists", {
    skip: preRustMissing,
  }, async () => {
    const dir = await seedKeeping(["tools/preview-tools.ts"]);
    const kept = await import(pathToFileURL(path.join(dir, "loop/chat-dispatch.ts")).href);
    const recorder = scaffoldRecorder();
    const spec = { goal: "a pong you can play on the Mac", project: "pong", targets: [BuildTarget.Mac] };
    await assert.rejects(
      kept.launchFromIntake(chatStudio(recorder), recorder.ctx, { threadId: "t1", text: "make pong" }, spec),
      (error: Error & { code?: string; modules?: string[] }) => {
        assert.equal(error.code, NativeNightRefusal.RustPartsMissing);
        assert.deepEqual(error.modules, ["tools/preview-tools.ts"]);
        assert.match(error.message, /tools\/preview-tools\.ts/);
        assert.match(error.message, RETAKE);
        return true;
      },
    );
    assert.deepEqual(recorder.paramsOf(HostMethod.GameScaffold), [], "no folder was asked for");
  });

  it("still launches a browser intake beside them", { skip: preRustMissing }, async () => {
    const dir = await seedKeeping(["tools/preview-tools.ts"]);
    const kept = await import(pathToFileURL(path.join(dir, "loop/chat-dispatch.ts")).href);
    const recorder = scaffoldRecorder();
    const spec = { goal: "a pong in the browser", project: "pong", targets: [BuildTarget.Web] };
    const scaffolds = await scaffoldsOf(recorder, () =>
      kept.launchFromIntake(chatStudio(recorder), recorder.ctx, { threadId: "t1", text: "make pong" }, spec),
    );
    assert.equal(scaffolds.length, 1);
  });
});

/** A real core whose harness workspace keeps `kept` modules from the pre-Rust seed, and its new_game. */
async function hostKeeping(kept: readonly string[]) {
  const lite = await coreLite();
  const workspace = lite.core.layout.harnessWs;
  for (const rel of kept) await writeFile(path.join(workspace, rel), await preRustCopy(rel));
  const table = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  const call = async (method: string, params: unknown) => {
    // A headless core has no preview to load the new game into: what is asked of it is the scaffold.
    if (method === HostMethod.PreviewLoad) return null;
    const handler = table[method];
    assert.ok(handler, `${method} is a host method`);
    return handler(params);
  };
  const toolsModule = await import(pathToFileURL(path.join(workspace, "tools/game-tools.ts")).href);
  const newGame = toolNamed(toolsModule.tools, "new_game");
  const ctx = { project: null, call, notify() {}, setStatus() {} } as unknown as ToolCtx;
  const folders = async () => (await readdir(lite.gamesRoot)).filter((name) => !name.startsWith("."));
  return { ...lite, call, newGame, ctx, folders };
}

/** Assert `work` is refused with `code`, naming `module` and its re-take. */
async function refusedWithRetake(work: Promise<unknown>, code: string, module: string): Promise<void> {
  await assert.rejects(work, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, error.message);
    assert.ok(error.message.includes(module), error.message);
    assert.match(error.message, RETAKE);
    return true;
  });
}

describe("the host refuses a kept pre-Rust intake before any folder exists", () => {
  // A raylib request from a workspace that kept a pre-Rust game-tools.ts: no seed before Rust asked
  // for raylib itself, so the request is the one an older harness would send.
  it("game.scaffold from a workspace keeping a pre-Rust game-tools.ts, by raylib kind or bare desktop destinations, is refused with the re-take", {
    skip: preRustMissing,
  }, async (t) => {
    const host = await hostKeeping(["tools/game-tools.ts"]);
    t.after(host.close);
    const byKind = { name: "pong", kind: ProjectKind.RaylibCpp, targets: [BuildTarget.Mac] };
    const byTargets = { name: "pong", targets: [BuildTarget.Mac, BuildTarget.Web] };
    for (const params of [byKind, byTargets]) {
      await refusedWithRetake(
        host.call(HostMethod.GameScaffold, params),
        CreationRefusal.RaylibCreationRetired,
        "tools/game-tools.ts",
      );
    }
    assert.deepEqual(await host.folders(), [], "no folder was made");
  });

  it("a kept pre-Rust game-tools.ts on the current loop never gets a Rust folder its harness could not lease", {
    skip: preRustMissing,
  }, async (t) => {
    const host = await hostKeeping(["tools/game-tools.ts"]);
    t.after(host.close);
    // The pre-Rust new_game names no destination, so a desktop ask reaches the host as no stack at all.
    await host.newGame.execute({ name: "pong", targets: [BuildTarget.Mac] }, host.ctx);
    for (const name of await host.folders()) {
      const meta = JSON.parse(await readFile(path.join(host.gamesRoot, name, "studio.json"), "utf8"));
      assert.notEqual(meta.stack, GameStack.RustWgpu, `${name} is no Rust folder`);
    }
  });

  it("the current seed's new_game makes a desktop game a Rust · wgpu folder", async (t) => {
    const host = await hostKeeping([]);
    t.after(host.close);
    await host.newGame.execute({ name: "pong", targets: [BuildTarget.Mac] }, host.ctx);
    const meta = JSON.parse(await readFile(path.join(host.gamesRoot, "pong", "studio.json"), "utf8"));
    assert.equal(meta.stack, GameStack.RustWgpu);
    assert.equal(meta.kind, ProjectKind.RustWgpu);
    await rm(path.join(host.gamesRoot, "pong"), { recursive: true, force: true });
  });
});
