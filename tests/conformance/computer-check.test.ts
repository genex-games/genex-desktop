/**
 * The computer's `check` (B6): a builder's edits compiled through its game's build lane, with no
 * reload. Bodycam's builder paid a full rebuild and page boot per compiler error, so it wrote its
 * own clippy script into the lane's build folder. Here the real `PreviewService` and computer tools
 * run over a recording lane: the check reaches the lane as a check of the session's own folder, the
 * answer is the build problem's note (or that it compiles clean), and the window is never opened.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { computerTools } from "../../src/main/core/computer-tools.ts";
import { type CoreInternals, unservedPreviews } from "../../src/main/core/internals.ts";
import { PreviewService } from "../../src/main/core/previews.ts";
import type { SessionPort } from "../../src/main/core/session-port.ts";
import {
  type BuildOutcome,
  type GameBuildGame,
  type GameBuildLane,
  GameBuildLanes,
  type GameBuildOptions,
} from "../../src/main/game-build.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { TEMPLATE_SHAPE } from "../../src/substrate/project-shape.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** What the lane was asked, per call. */
interface LaneCall {
  dir: string;
  target: BuildTarget;
  purpose: CppBuildPurpose;
  check: boolean;
}

/** A clippy failure as the Rust lane reports one: the command keeps its environment, the lines the first error. */
function clippyFailed(project: string): BuildOutcome {
  return {
    ok: false,
    output: null,
    lastGood: null,
    ran: true,
    problem: {
      project,
      command: "exec '/usr/bin/env' '-i' 'GENEX_RENDER_TOML=[render]' cargo clippy",
      code: 101,
      lines: ["error[E0308]: mismatched types", "  --> src/main.rs:3:9"],
      needsInstall: false,
      install: null,
      showingLastBuild: false,
      skippedScripts: null,
      at: new Date(0).toISOString(),
      reason: BuildProblemCode.CommandFailed,
    },
  };
}

/** The previews and a builder's computer over one game folder and a lane that answers `answer`. */
async function builderComputer(shape: GameBuildGame["shape"], answer: (project: string) => BuildOutcome) {
  const calls: LaneCall[] = [];
  const lane: GameBuildLane = {
    ensure: async (game, target, purpose, options: GameBuildOptions = {}) => {
      calls.push({ dir: game.dir, target, purpose, check: options.check === true });
      return answer(game.project);
    },
    cancelAll: () => {},
    cancelGame: () => {},
    sweep: async () => 0,
  };
  const root = path.join(await tmpDir("computer-check-"), "worker-1");
  const core = {
    emit: () => {},
    games: { list: async () => [{ name: "bodycam", shape }], dirFor: () => "/games/bodycam" },
    toolchains: { currentLock: async () => null },
  } as unknown as StudioCore;
  const x = { ...unservedPreviews(), gameBuilds: new GameBuildLanes({ [GameStack.RustWgpu]: lane }) };
  const previews = new PreviewService(core, x as unknown as CoreInternals);
  const opened: string[] = [];
  const sessionPort = {
    loaded: null,
    handle: () => "w1",
    get: async () => {
      opened.push("window");
      throw new Error("a check opens no window");
    },
    release: async () => {},
  } as unknown as SessionPort;
  const outDir = await tmpDir("computer-check-out-");
  const tools = computerTools(previews, { project: "bodycam" } as never, root, outDir, sessionPort);
  return { tools, calls, root, opened };
}

describe("the computer's check compiles a builder's edits through the lane, with no reload (B6)", () => {
  it("checks the session's folder as a check of its web build, answers the first error, and opens no window", async () => {
    const rust = { ...TEMPLATE_SHAPE, kind: ProjectKind.RustWgpu };
    const { tools, calls, root, opened } = await builderComputer(rust, clippyFailed);
    const answer = text(await tools.onLiveTool("computer", { action: "check" }));
    assert.deepEqual(calls, [{ dir: root, target: BuildTarget.Web, purpose: CppBuildPurpose.Judging, check: true }]);
    assert.match(answer, /^the game's build failed \(exit 101\):\nerror\[E0308\]: mismatched types/);
    assert.ok(!answer.includes("GENEX_RENDER_TOML"), answer);
    assert.deepEqual(opened, []);
  });

  it("says a clean check compiles clean and that nothing was reloaded", async () => {
    const rust = { ...TEMPLATE_SHAPE, kind: ProjectKind.RustWgpu };
    const clean = (): BuildOutcome => ({ ok: true, output: null, lastGood: null, problem: null, ran: true });
    const { tools, opened } = await builderComputer(rust, clean);
    assert.match(text(await tools.onLiveTool("computer", { action: "check" })), /worker-1 compiles clean.*reload/);
    assert.deepEqual(opened, []);
  });

  it("tells a page game it has nothing to compile, building nothing", async () => {
    const { tools, calls, opened } = await builderComputer(TEMPLATE_SHAPE, clippyFailed);
    assert.match(text(await tools.onLiveTool("computer", { action: "check" })), /no compile step/);
    assert.deepEqual(calls, []);
    assert.deepEqual(opened, []);
  });
});
