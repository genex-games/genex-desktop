/**
 * The native run card (`src/renderer/panels/stage/native-card.ts`): what the card over Live says
 * about a C++ game's own Mac window in each state, which buttons it offers (Stop, Restart, Bring
 * to front, Install tools), and why a run was refused. The card itself is `.tsx`;
 * `run-native-card-ui.mjs` drives it in the app over the `native-game` fixture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { troubleWords } from "../../src/renderer/panels/stage/build-trouble.ts";
import { NativeCardAction, nativeCardView } from "../../src/renderer/panels/stage/native-card.ts";
import { BUILD_PROBLEM_WORDS, DESTINATION_WORDS, NATIVE_WORDS } from "../../src/renderer/words.ts";
import { type BuildProblem, BuildProblemCode, DiagnosticTool } from "../../src/shared/build-problem.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { DestinationBadge } from "../../src/shared/game-targets.ts";
import {
  GameBoxProblem,
  NativeBackend,
  NativeRefusal,
  NativeRunMode,
  type NativeRunStatus,
  NativeRunState,
} from "../../src/shared/native-contract.ts";

/** The person's window run of pong-mac in `state`. */
function windowRun(state: NativeRunState, extra: Partial<NativeRunStatus> = {}): NativeRunStatus {
  return {
    project: "pong-mac",
    runId: "run-1",
    target: BuildTarget.Mac,
    state,
    mode: NativeRunMode.Window,
    pid: 4242,
    backend: NativeBackend.MetalAngle,
    refusal: null,
    problem: null,
    exit: null,
    owner: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: null,
    ...extra,
  };
}

/** The Mac build's problem, as the lane reports it. */
function macProblem(reason: BuildProblemCode): BuildProblem {
  return {
    project: "pong-mac",
    command: "",
    code: null,
    lines: [],
    needsInstall: false,
    install: null,
    showingLastBuild: false,
    at: "2026-10-01T00:00:00.000Z",
    reason,
    target: BuildTarget.Mac,
  };
}

const { Stop, Restart, Front, InstallTools, SetUpTools, FinishSetUp, TryAgain } = NativeCardAction;

describe("the native run card", () => {
  it("says each state in words and offers what that state can do", () => {
    const expected: Record<NativeRunState, { actions: NativeCardAction[]; busy: boolean }> = {
      [NativeRunState.Building]: { actions: [Stop], busy: true },
      [NativeRunState.Admitting]: { actions: [Stop], busy: true },
      [NativeRunState.Starting]: { actions: [Stop], busy: true },
      [NativeRunState.Ready]: { actions: [Front, Stop], busy: false },
      [NativeRunState.Paused]: { actions: [Front, Stop], busy: false },
      [NativeRunState.Stopping]: { actions: [], busy: true },
      [NativeRunState.Stopped]: { actions: [Restart], busy: false },
      [NativeRunState.Crashed]: { actions: [Restart], busy: false },
      [NativeRunState.Killed]: { actions: [Restart], busy: false },
      [NativeRunState.Refused]: { actions: [TryAgain], busy: false },
    };
    for (const state of Object.values(NativeRunState)) {
      const view = nativeCardView(windowRun(state));
      assert.ok(view, state);
      assert.equal(view.state, state);
      assert.equal(view.title, NATIVE_WORDS.state[state], state);
      assert.deepEqual({ actions: view.actions, busy: view.busy }, expected[state], state);
    }
  });

  it("shows nothing without a run, or for a run that is not the person's window", () => {
    assert.equal(nativeCardView(null), null);
    assert.equal(nativeCardView(windowRun(NativeRunState.Ready, { mode: NativeRunMode.Headless })), null);
    assert.equal(nativeCardView(windowRun(NativeRunState.Ready, { mode: NativeRunMode.Embedded })), null);
  });

  it("a running or stopped game needs no explanation", () => {
    for (const state of [NativeRunState.Ready, NativeRunState.Stopped, NativeRunState.Starting])
      assert.equal(nativeCardView(windowRun(state))?.detail, null, state);
  });

  it("a crash offers Restart and says how the game ended", () => {
    const signalled = nativeCardView(
      windowRun(NativeRunState.Crashed, { exit: { code: null, signal: "SIGSEGV" }, pid: null }),
    );
    assert.deepEqual(signalled?.actions, [Restart]);
    assert.equal(signalled?.detail, NATIVE_WORDS.crashed(null, "SIGSEGV"));
    const coded = nativeCardView(windowRun(NativeRunState.Crashed, { exit: { code: 3, signal: null } }));
    assert.equal(coded?.detail, NATIVE_WORDS.crashed(3, null));
    const killed = nativeCardView(windowRun(NativeRunState.Killed));
    assert.deepEqual([killed?.actions, killed?.detail], [[Restart], NATIVE_WORDS.killed]);
    const overMemory = nativeCardView(windowRun(NativeRunState.Killed, { refusal: NativeRefusal.MemoryCap }));
    assert.equal(overMemory?.detail, NATIVE_WORDS.refusal[NativeRefusal.MemoryCap], "the reason outranks the force");
  });

  it("its heading says Playing on Mac while the window is on its way or runs, and stops saying so once it ended", () => {
    // A refused run never opened a window: its heading is Play on Mac, not the window's (below).
    const ended = new Set<NativeRunState>([NativeRunState.Stopped, NativeRunState.Crashed, NativeRunState.Killed]);
    const endedHeadings = new Set<string>();
    for (const state of Object.values(NativeRunState)) {
      const heading = nativeCardView(windowRun(state))?.heading ?? "";
      if (state === NativeRunState.Refused) {
        assert.equal(heading, DESTINATION_WORDS.playOnMac, "no window opened: the heading is what was asked");
        continue;
      }
      if (!ended.has(state)) {
        assert.equal(heading, NATIVE_WORDS.title, state);
        continue;
      }
      assert.ok(heading.length > 0, state);
      assert.doesNotMatch(heading, /playing/i, `${state}: nothing plays any more`);
      assert.doesNotMatch(heading, new RegExp(NATIVE_WORDS.state[state], "i"), `${state}: said once`);
      endedHeadings.add(heading);
    }
    assert.equal(endedHeadings.size, 1, "one heading for every ended run");
  });

  it("a failed Mac build shows the build's problem in the build strip's words, and Install tools when its tools are missing", () => {
    const missing = macProblem(BuildProblemCode.ToolchainMissing);
    const noTools = nativeCardView(
      windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem: missing, pid: null }),
    );
    assert.equal(noTools?.problem, missing);
    assert.equal(noTools?.detail, troubleWords(missing), "the card says why in the strip's words");
    assert.deepEqual(noTools?.actions, [InstallTools, TryAgain]);
    const failed = macProblem(BuildProblemCode.CommandFailed);
    const broken = nativeCardView(
      windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem: failed }),
    );
    assert.equal(broken?.problem, failed);
    assert.deepEqual(broken?.actions, [TryAgain], "a compile error is fixed in the code, not by tools");
    const unexplained = nativeCardView(windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed }));
    assert.deepEqual([unexplained?.problem, unexplained?.detail], [null, NATIVE_WORDS.buildFailed]);
  });

  it("a failed Mac build says the build failed and offers Try again, the build strip's word; a run that ran offers Restart", () => {
    const failed = nativeCardView(
      windowRun(NativeRunState.Refused, {
        refusal: NativeRefusal.BuildFailed,
        problem: macProblem(BuildProblemCode.CommandFailed),
        pid: null,
      }),
    );
    assert.equal(failed?.title, NATIVE_WORDS.refusal[NativeRefusal.BuildFailed]);
    assert.notEqual(failed?.heading, "Mac window", "no window ever opened");
    assert.deepEqual(failed?.actions, [TryAgain]);
    assert.doesNotMatch(
      NATIVE_WORDS.buildFailed,
      /Play on Mac again|Restart/,
      "the fallback names the button the card offers",
    );
    for (const state of [NativeRunState.Stopped, NativeRunState.Crashed, NativeRunState.Killed])
      assert.deepEqual(nativeCardView(windowRun(state))?.actions, [Restart], state);
  });

  it("a Mac part Genex has published no download of offers neither Install tools nor Try again, and says it is not published", () => {
    const notHosted = macProblem(BuildProblemCode.ToolchainNotHosted);
    const view = nativeCardView(
      windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem: notHosted, pid: null }),
    );
    assert.deepEqual(view?.actions, [], "nothing the person can install or retry helps");
    assert.equal(view?.detail, BUILD_PROBLEM_WORDS[BuildProblemCode.ToolchainNotHosted]);
    assert.match(view?.detail ?? "", /hasn’t published/);
  });

  it("a prewarm from an older Genex offers Set up again, not Install tools", () => {
    const stale = macProblem(BuildProblemCode.ToolchainStale);
    const view = nativeCardView(
      windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem: stale, pid: null }),
    );
    assert.deepEqual(view?.actions, [SetUpTools, TryAgain]);
    assert.equal(view?.detail, BUILD_PROBLEM_WORDS[BuildProblemCode.ToolchainStale]);
  });

  it("Details holds the game's log only for a run that crashed, was killed or was refused without a build problem", () => {
    const expected: Partial<Record<NativeRunState, boolean>> = {
      [NativeRunState.Stopped]: false,
      [NativeRunState.Crashed]: true,
      [NativeRunState.Killed]: true,
      [NativeRunState.Refused]: true,
      [NativeRunState.Ready]: false,
    };
    for (const [state, log] of Object.entries(expected))
      assert.equal(nativeCardView(windowRun(state as NativeRunState))?.log, log, state);
    const failedBuild = nativeCardView(
      windowRun(NativeRunState.Refused, {
        refusal: NativeRefusal.BuildFailed,
        problem: macProblem(BuildProblemCode.CommandFailed),
      }),
    );
    assert.equal(failedBuild?.log, false, "a failed build shows its own Details");
  });

  it("refusal words exist for every NativeRefusal, and a refused run says its own", () => {
    for (const refusal of Object.values(NativeRefusal)) {
      const words = NATIVE_WORDS.refusal[refusal];
      assert.ok(typeof words === "string" && words.length > 0, refusal);
      if (refusal === NativeRefusal.BuildFailed) continue;
      const view = nativeCardView(windowRun(NativeRunState.Refused, { refusal }));
      assert.equal(view?.detail, words, refusal);
      assert.deepEqual(view?.actions, [TryAgain], refusal);
      assert.equal(view?.problem, null, refusal);
    }
  });
});

describe("the native run card after a failed Mac build (ACC-04)", () => {
  it("a failed Mac build never uses the web last-good sentence: it says the Mac build failed, its clang line, and Try again", () => {
    for (const fields of [
      { showingLastBuild: true },
      { showingLastBuild: false },
      { needsInstall: true, install: "npm install" },
      { reason: undefined },
    ]) {
      const problem: BuildProblem = {
        ...macProblem(BuildProblemCode.CommandFailed),
        command: "cmake --build",
        code: 1,
        diagnostics: [
          {
            tool: DiagnosticTool.Clang,
            file: "src/main.cpp",
            line: 58,
            column: 150,
            message: "use of undeclared identifier 'platform'",
          },
        ],
        ...fields,
      };
      const view = nativeCardView(
        windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem, pid: null }),
      );
      const words = [view?.heading, view?.title, view?.detail].join(" · ");
      assert.equal(view?.title, NATIVE_WORDS.refusal[NativeRefusal.BuildFailed], JSON.stringify(fields));
      assert.equal(view?.detail, NATIVE_WORDS.buildFailed, JSON.stringify(fields));
      assert.doesNotMatch(words, /last working build|newest changes|packages/i, "the web build's sentences are Live's");
      assert.equal(view?.problem, problem, "its Details carry the clang line");
      assert.deepEqual(view?.actions, [TryAgain]);
    }
  });

  it("tools installed but not set up for the Mac offer Set up, then Try again", () => {
    const unprepared = macProblem(BuildProblemCode.ToolchainUnprepared);
    const view = nativeCardView(
      windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, problem: unprepared, pid: null }),
    );
    assert.deepEqual(view?.actions, [FinishSetUp, TryAgain]);
    assert.equal(view?.detail, BUILD_PROBLEM_WORDS[BuildProblemCode.ToolchainUnprepared]);
  });

  it("an ended window's heading is the shared words' Mac window", () => {
    for (const state of [NativeRunState.Stopped, NativeRunState.Crashed, NativeRunState.Killed])
      assert.equal(nativeCardView(windowRun(state))?.heading, NATIVE_WORDS.ended, state);
  });
});

describe("the native run card on Windows and Linux", () => {
  it("a computer with no usable game box says why in the box's words, over the refusal's", () => {
    for (const box of Object.values(GameBoxProblem)) {
      const view = nativeCardView(
        windowRun(NativeRunState.Refused, { target: BuildTarget.Linux, refusal: NativeRefusal.NoGameBox, box }),
      );
      assert.equal(view?.detail, NATIVE_WORDS.box[box], box);
      assert.deepEqual(view?.actions, [TryAgain], `${box}: no window ever opened`);
    }
    const none = nativeCardView(windowRun(NativeRunState.Refused, { refusal: NativeRefusal.NoGameBox, box: null }));
    assert.equal(none?.detail, NATIVE_WORDS.refusal[NativeRefusal.NoGameBox], "no box problem: the refusal's words");
  });

  it("an ended window's heading names the host's own destination: Windows window, Linux window; a Mac's stays Mac window", () => {
    const ended = [NativeRunState.Stopped, NativeRunState.Crashed, NativeRunState.Killed];
    for (const state of ended) {
      assert.equal(nativeCardView(windowRun(state, { target: BuildTarget.Windows }))?.heading, "Windows window", state);
      assert.equal(nativeCardView(windowRun(state, { target: BuildTarget.Linux }))?.heading, "Linux window", state);
      assert.equal(nativeCardView(windowRun(state))?.heading, "Mac window", `${state}: byte-identical on a Mac`);
    }
    for (const target of [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux])
      assert.equal(
        nativeCardView(windowRun(NativeRunState.Stopped, { target }))?.heading,
        NATIVE_WORDS.windowTitle[target],
        target,
      );
  });

  it("a Windows or Linux run never says Mac: its window while it runs, its destination when no window opened", () => {
    for (const target of [BuildTarget.Windows, BuildTarget.Linux]) {
      for (const state of Object.values(NativeRunState)) {
        const view = nativeCardView(windowRun(state, { target }));
        const words = [view?.heading, view?.title, view?.detail].join(" · ");
        assert.doesNotMatch(words, /\bMac\b/, `${target} ${state}: ${words}`);
      }
      const running = nativeCardView(windowRun(NativeRunState.Ready, { target }));
      assert.equal(running?.heading, NATIVE_WORDS.windowTitle[target], `${target}: the window that plays`);
      assert.equal(running?.title, NATIVE_WORDS.state[NativeRunState.Ready]);
      const building = nativeCardView(windowRun(NativeRunState.Building, { target }));
      assert.equal(building?.title, DESTINATION_WORDS.badge[DestinationBadge.Building], `${target}: building, unnamed`);
      const refused = nativeCardView(windowRun(NativeRunState.Refused, { target, refusal: NativeRefusal.BuildFailed }));
      assert.equal(refused?.heading, DESTINATION_WORDS.label[target], `${target}: no window ever opened`);
      assert.equal(refused?.title, NATIVE_WORDS.state[NativeRunState.Refused]);
      assert.equal(refused?.detail, NATIVE_WORDS.buildFailedFor(target));
    }
  });

  it("a Mac run's words stay as they were", () => {
    const mac = (state: NativeRunState, extra: Partial<NativeRunStatus> = {}) =>
      nativeCardView(windowRun(state, extra));
    assert.equal(mac(NativeRunState.Ready)?.heading, "Playing on Mac");
    assert.equal(mac(NativeRunState.Building)?.title, "Building for Mac");
    const failed = mac(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed });
    assert.deepEqual([failed?.heading, failed?.title], ["Play on Mac", "The Mac build failed."]);
  });

  it("a failed Windows or Linux build with no problem names its destination; a Mac one keeps Play on Mac's words", () => {
    for (const target of [BuildTarget.Windows, BuildTarget.Linux]) {
      const view = nativeCardView(windowRun(NativeRunState.Refused, { target, refusal: NativeRefusal.BuildFailed }));
      assert.equal(view?.detail, NATIVE_WORDS.buildFailedFor(target), target);
    }
    assert.equal(NATIVE_WORDS.buildFailedFor(BuildTarget.Windows), "The Windows build failed.");
    const mac = nativeCardView(windowRun(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed }));
    assert.equal(mac?.detail, NATIVE_WORDS.buildFailed);
  });
});
