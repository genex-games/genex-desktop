/**
 * What the stage's build-problem strip says (`src/renderer/panels/stage/build-trouble.ts`): the
 * sentence by the problem's typed reason, today's sentences for a failed command (and for a reason
 * this renderer does not know), and the C++ lane's first diagnostics, each once, where it points.
 * The strip itself is a `.tsx` the conformance runner cannot load.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DIAGNOSTICS_SHOWN,
  detailLines,
  diagnosticPlace,
  problemReason,
  shownDiagnostics,
  TroubleAction,
  troubleAction,
  troubleWords,
} from "../../src/renderer/panels/stage/build-trouble.ts";
import { BUILD_PROBLEM_WORDS, NATIVE_WORDS } from "../../src/renderer/words.ts";
import {
  type BuildDiagnostic,
  type BuildProblem,
  BuildProblemCode,
  DiagnosticTool,
} from "../../src/shared/build-problem.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";

/** A build problem with `fields` over a plain failed command. */
function problem(fields: Partial<BuildProblem> = {}): BuildProblem {
  return {
    project: "pong-cpp",
    command: "cmake --build",
    code: 1,
    lines: [],
    needsInstall: false,
    install: null,
    showingLastBuild: false,
    at: "2026-10-01T00:00:00.000Z",
    ...fields,
  };
}

/** A clang error at `file:line:column`. */
function clang(file: string | null, line: number | null, column: number | null, message: string): BuildDiagnostic {
  return { tool: DiagnosticTool.Clang, file, line, column, message };
}

const SENTENCE = {
  install: "Its packages aren’t installed yet.",
  lastBuild: "Showing the last working build. The newest changes aren’t included.",
  fix: "Fix the build error, then try again.",
} as const;

describe("build trouble words", () => {
  it("a typed reason says its own sentence", () => {
    for (const reason of Object.values(BuildProblemCode)) {
      if (reason === BuildProblemCode.CommandFailed) continue;
      // Without its gate fields, a gate refusal says only its own sentence.
      assert.equal(troubleWords(problem({ reason })), BUILD_PROBLEM_WORDS[reason], reason);
    }
  });

  it("a failed command keeps today's sentences: packages, the last working build, or the error to fix", () => {
    const failed = { reason: BuildProblemCode.CommandFailed } as const;
    assert.equal(troubleWords(problem({ ...failed, needsInstall: true, install: "npm install" })), SENTENCE.install);
    assert.equal(troubleWords(problem({ ...failed, showingLastBuild: true })), SENTENCE.lastBuild);
    assert.equal(troubleWords(problem(failed)), SENTENCE.fix);
  });

  it("no reason (a problem from before reasons) or one this renderer does not know reads as a failed command", () => {
    assert.equal(problemReason(problem()), BuildProblemCode.CommandFailed);
    assert.equal(troubleWords(problem({ showingLastBuild: true })), SENTENCE.lastBuild);
    for (const reason of ["no-such-reason", "__proto__", "constructor", "toString", ""]) {
      const unknown = problem({ reason: reason as BuildProblemCode });
      assert.equal(problemReason(unknown), BuildProblemCode.CommandFailed, reason);
      assert.equal(troubleWords(unknown), SENTENCE.fix, reason);
    }
  });
});

describe("a build the safety check refused", () => {
  const refused = (refusal: string, file = "game") =>
    problem({
      command: "",
      code: null,
      reason: BuildProblemCode.GateRefused,
      target: BuildTarget.Linux,
      gate: { refusal: refusal as NativeRefusal, file },
    });

  it("says the gate refused it, then the refusal in words", () => {
    assert.equal(
      troubleWords(refused(NativeRefusal.ImportsLibGl)),
      `${BUILD_PROBLEM_WORDS[BuildProblemCode.GateRefused]} ${NATIVE_WORDS.refusal[NativeRefusal.ImportsLibGl]}`,
    );
    assert.equal(troubleAction(refused(NativeRefusal.ImportsLibGl)), TroubleAction.TryAgain);
  });

  it("puts the file it refused behind Details, and no made-up command line", () => {
    assert.deepEqual(detailLines(refused(NativeRefusal.ImportsOpengl32, "game.exe"), null), [
      "Safety check: game.exe (imports-opengl32)",
    ]);
  });

  it("a refusal this renderer does not know says only the gate sentence, and Details still name the file", () => {
    for (const refusal of ["no-such-refusal", "__proto__", "constructor", ""]) {
      assert.equal(troubleWords(refused(refusal)), BUILD_PROBLEM_WORDS[BuildProblemCode.GateRefused], refusal);
      assert.equal(detailLines(refused(refusal, "lib/x.so"), null).length, 1, refusal);
    }
  });
});

describe("build diagnostics", () => {
  it("a diagnostic points where a compiler would print it, as much of it as is known", () => {
    assert.equal(diagnosticPlace(clang("src/main.cpp", 12, 5, "x")), "src/main.cpp:12:5");
    assert.equal(diagnosticPlace(clang("src/main.cpp", 12, null, "x")), "src/main.cpp:12");
    assert.equal(diagnosticPlace(clang("CMakeLists.txt", null, null, "x")), "CMakeLists.txt");
    assert.equal(diagnosticPlace(clang("src/main.cpp", 0, 0, "x")), "src/main.cpp:0:0");
    assert.equal(diagnosticPlace(clang(null, 3, 1, "x")), null);
  });

  it("an error in a shared header, printed once per file that includes it, is listed once", () => {
    const header = clang("src/studio.h", 4, 10, "unknown type name 'Vec2'");
    const other = clang("src/hud.cpp", 20, 3, "expected ';'");
    assert.deepEqual(shownDiagnostics([header, { ...header }, other, { ...header }]), [header, other]);
  });

  it("the same message from another tool, or at another place, is its own line", () => {
    const at = clang("src/main.cpp", 1, 1, "error");
    const moved = clang("src/main.cpp", 2, 1, "error");
    const cmake = { ...at, tool: DiagnosticTool.CMake };
    assert.deepEqual(shownDiagnostics([at, moved, cmake]), [at, moved, cmake]);
  });

  it(`no more than ${DIAGNOSTICS_SHOWN} are shown, in the order the lane parsed them`, () => {
    const five = [1, 2, 3, 4, 5].map((line) => clang("src/main.cpp", line, 1, `error ${line}`));
    assert.deepEqual(shownDiagnostics(five), five.slice(0, DIAGNOSTICS_SHOWN));
    assert.deepEqual(shownDiagnostics([]), []);
  });
});

describe("what the strip offers", () => {
  it("tools missing opens the Toolchain sheet; packages missing installs them; anything else builds again", () => {
    assert.equal(troubleAction(problem({ reason: BuildProblemCode.ToolchainMissing })), TroubleAction.InstallTools);
    assert.equal(
      troubleAction(problem({ reason: BuildProblemCode.ToolchainStale })),
      TroubleAction.SetUpTools,
      "tools set up by an older Genex are set up again, not installed",
    );
    assert.equal(troubleAction(problem({ needsInstall: true, install: "npm install" })), TroubleAction.InstallPackages);
    for (const reason of [
      BuildProblemCode.CommandFailed,
      BuildProblemCode.InSourceBuild,
      BuildProblemCode.UnsupportedHost,
    ])
      assert.equal(troubleAction(problem({ reason })), TroubleAction.TryAgain, reason);
  });
});

describe("what Details shows", () => {
  it("the command and how it ended, only for a command that ran", () => {
    assert.deepEqual(detailLines(problem({ lines: ["ld: oops"] }), null), ["cmake --build (exit 1)", "ld: oops"]);
    assert.deepEqual(
      detailLines(problem({ command: "cmake --build", code: null, reason: BuildProblemCode.Cancelled }), null),
      ["cmake --build (exit stopped)"],
    );
  });

  it("no made-up command line for a build that never started: only the facts it gave", () => {
    const refused = problem({ command: "", code: null, reason: BuildProblemCode.ToolchainMissing, lines: ["emsdk"] });
    assert.deepEqual(detailLines(refused, null), ["emsdk"]);
    assert.deepEqual(detailLines({ ...refused, lines: [] }, null), [], "nothing to show: no Details at all");
  });

  it("a failed package install comes first, then the build's own", () => {
    const failed = problem({ needsInstall: true, install: "npm install", lines: ["missing three"] });
    assert.deepEqual(detailLines(failed, ["ERR! 404"]), [
      "npm install failed",
      "ERR! 404",
      "",
      "cmake --build (exit 1)",
      "missing three",
    ]);
  });
});
