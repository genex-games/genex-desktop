/**
 * Reading what Godot printed, over its real words (recorded from Godot 4.6.1 into
 * `tests/fixtures/godot-cli/`): every problem once with its project file and line, the engine's
 * own sandbox noise left out, and the lines Genex's check and capture scripts print.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  checkedCount,
  isError,
  ProblemKind,
  problemLines,
  readProblems,
  playedFrames,
  savedShots,
} from "../../src/plugins/godot/godot-output.ts";

const fixture = (name: string) => readFileSync(`tests/fixtures/godot-cli/${name}`, "utf8");

describe("Godot's output, read", () => {
  it("names each parse error once with its file and line, and the engine's load failure without a place", () => {
    const problems = readProblems(fixture("check-parse-errors.log"));
    assert.deepEqual(problemLines(problems), [
      'bad.gd:3: Parse Error: Cannot assign a value of type "String" as "int".',
      'bad.gd:3: Parse Error: Cannot assign a value of type String to variable "x" with specified type int.',
      'bad.gd:4: Parse Error: Function "undefined_call()" not found in base self.',
      'ERROR: Failed to load script "res://bad.gd" with error "Parse error".',
    ]);
    assert.equal(problems[0]?.kind, ProblemKind.ScriptError);
    assert.ok(problems.every(isError));
    assert.equal(checkedCount(fixture("check-parse-errors.log")), 6);
  });

  it("places a runtime error at the line that raised it, not in its backtrace", () => {
    assert.deepEqual(readProblems(fixture("run-null-call.log")), [
      {
        kind: ProblemKind.ScriptError,
        message: "Invalid call. Nonexistent function 'boom' in base 'Nil'.",
        file: "crash.gd",
        line: 4,
      },
    ]);
  });

  it("leaves out the sandbox's certificate noise, which is never the project's", () => {
    assert.deepEqual(readProblems(fixture("sandbox-noise.log")), []);
  });

  it("says a check that never finished loaded nothing, and reads the stills and frames a play saved", () => {
    assert.equal(checkedCount(fixture("run-null-call.log")), null);
    assert.deepEqual(savedShots(fixture("capture.log")), [
      { name: "HeroCamera", frame: 30, file: "/storage/shots/s-30-0.png" },
      { name: "HeroCamera", frame: 100, file: "/storage/shots/s-100-0.png" },
      { name: "HeroCamera", frame: 180, file: "/storage/shots/s-180-0.png" },
    ]);
    assert.equal(playedFrames(fixture("capture.log")), 200);
    assert.equal(playedFrames(fixture("run-null-call.log")), null);
  });

  it("counts a warning as no error", () => {
    const [warning] = readProblems("WARNING: Unused variable.\n   at: GDScript::reload (res://player.gd:12)\n");
    assert.equal(warning?.line, 12);
    assert.equal(warning && isError(warning), false);
  });
});
