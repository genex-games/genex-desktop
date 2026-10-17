/**
 * A part's play test (`unreal/parts/<Part>/test.json`): what the editor queue does after it applies
 * the part — hold the player's inputs, wait, take play shots, check what the game shows. Builders
 * write it, so it is checked before the queue runs anything, and a bad one is refused with every
 * problem named, not run halfway.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PART_TEST_LIMITS, PartStepKind, parsePartTest } from "../../src/plugins/unreal/part-test.ts";

describe("a part's play test", () => {
  it("reads holds, waits, shots and checks in order", () => {
    const parsed = parsePartTest({
      warmupSeconds: 3,
      steps: [
        { hold: "MoveForward", x: 1, seconds: 2 },
        { wait: 0.5 },
        { shot: "walk" },
        { expect: { actor: "Lantern_0", exists: true } },
        { expect: { player: "speedKmh", atLeast: 1 } },
      ],
    });
    assert.ok(parsed.ok);
    assert.equal(parsed.test.warmupSeconds, 3);
    assert.deepEqual(
      parsed.test.steps.map((s) => s.kind),
      [PartStepKind.Hold, PartStepKind.Wait, PartStepKind.Shot, PartStepKind.Expect, PartStepKind.Expect],
    );
    assert.deepEqual(parsed.test.steps[0], { kind: PartStepKind.Hold, name: "MoveForward", x: 1, y: 0, seconds: 2 });
    assert.deepEqual(parsed.test.shots, ["walk"]);
  });

  it("reads the live builder's settle, drive and tag check, its frames named after its shots", () => {
    const parsed = parsePartTest({
      steps: [
        { settle: 8 },
        { shot: "spawn" },
        { drive: 20, frames: 4 },
        { shot: "ride" },
        { expect: { tag: "genex:track", exists: true } },
      ],
    });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("\n"));
    assert.deepEqual(parsed.test.steps, [
      { kind: PartStepKind.Settle, seconds: 8 },
      { kind: PartStepKind.Shot, name: "spawn" },
      { kind: PartStepKind.Drive, seconds: 20, frames: 4 },
      { kind: PartStepKind.Shot, name: "ride" },
      { kind: PartStepKind.Expect, check: { tag: "genex:track", exists: true } },
    ]);
    assert.deepEqual(parsed.test.shots, ["spawn", "drive-1", "drive-2", "drive-3", "drive-4", "ride"]);
    const noFrames = parsePartTest({ steps: [{ drive: 5 }] });
    assert.ok(noFrames.ok);
    assert.deepEqual(noFrames.test.steps, [{ kind: PartStepKind.Drive, seconds: 5, frames: 0 }]);
  });

  it("numbers a second drive's frames on from the first's", () => {
    const parsed = parsePartTest({
      steps: [
        { drive: 4, frames: 2 },
        { drive: 4, frames: 1 },
      ],
    });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.test.shots, ["drive-1", "drive-2", "drive-3"]);
  });

  it("refuses a settle, drive or tag check past the editor's limits", () => {
    const { settleSeconds, driveSeconds, driveFrames, shots } = PART_TEST_LIMITS;
    const cases: Array<[string, unknown, RegExp]> = [
      ["a settle longer than the limit", { steps: [{ settle: settleSeconds + 0.5 }] }, /settle/],
      ["a settle of no time", { steps: [{ settle: 0 }] }, /settle/],
      ["a settle that is text", { steps: [{ settle: "8" }] }, /settle/],
      ["a drive longer than the limit", { steps: [{ drive: driveSeconds + 1 }] }, /drive/],
      ["a drive of no time", { steps: [{ drive: 0 }] }, /drive/],
      ["a drive with too many frames", { steps: [{ drive: 10, frames: driveFrames + 1 }] }, /frames/],
      ["a drive with a part of a frame", { steps: [{ drive: 10, frames: 1.5 }] }, /frames/],
      ["a drive with fewer than no frames", { steps: [{ drive: 10, frames: -1 }] }, /frames/],
      [
        "a drive's frames and the shots past the shot limit",
        { steps: [{ drive: 10, frames: driveFrames }, { shot: "ride" }] },
        new RegExp(`at most ${shots} shots`),
      ],
      ["a shot named as a frame it collides with", { steps: [{ drive: 4, frames: 1 }, { shot: "drive-1" }] }, /twice/],
      [
        "settles and drives past the playing limit",
        { steps: [{ drive: driveSeconds }, { drive: driveSeconds }, { settle: settleSeconds }] },
        /seconds/,
      ],
      ["a tag that isn't a genex: tag", { steps: [{ expect: { tag: "terrain", exists: true } }] }, /expect/],
      ["a tag with only the prefix", { steps: [{ expect: { tag: "genex:", exists: true } }] }, /expect/],
      ["a tag with a space", { steps: [{ expect: { tag: "genex:dirt track", exists: true } }] }, /expect/],
      ["a tag check with another key", { steps: [{ expect: { tag: "genex:t", exists: true, actor: "A" } }] }, /expect/],
      ["a tag check without exists", { steps: [{ expect: { tag: "genex:t" } }] }, /expect/],
    ];
    for (const [label, raw, problem] of cases) {
      const parsed = parsePartTest(raw);
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.problems.join("\n"), problem, label);
    }
  });

  it("gives a part without a test one shot after the warm-up", () => {
    const parsed = parsePartTest(undefined);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.test.steps, [{ kind: PartStepKind.Shot, name: "still" }]);
  });

  it("refuses a test it can't run, naming every problem", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["not an object", "steps", /object/],
      ["steps not a list", { steps: {} }, /steps/],
      ["unknown step", { steps: [{ jump: 1 }] }, /step 1/],
      ["hold without a name", { steps: [{ hold: "", seconds: 1 }] }, /step 1/],
      ["hold too long", { steps: [{ hold: "W", seconds: 999 }] }, /seconds/],
      ["axis out of range", { steps: [{ hold: "W", x: 4 }] }, /x/],
      ["shot name with a path", { steps: [{ shot: "../evil" }] }, /shot/],
      ["shot twice", { steps: [{ shot: "a" }, { shot: "a" }] }, /twice/],
      ["unknown check", { steps: [{ expect: { actor: "A", glows: true } }] }, /expect/],
      ["negative wait", { steps: [{ wait: -1 }] }, /wait/],
      ["warm-up too long", { warmupSeconds: 120, steps: [] }, /warm/],
      ["too many steps", { steps: Array.from({ length: PART_TEST_LIMITS.steps + 1 }, () => ({ wait: 0 })) }, /steps/],
      [
        "too many shots",
        { steps: Array.from({ length: PART_TEST_LIMITS.shots + 1 }, (_, i) => ({ shot: `s${i}` })) },
        /shots/,
      ],
      [
        "too much playing",
        { steps: Array.from({ length: 10 }, () => ({ wait: PART_TEST_LIMITS.seconds / 5 })) },
        /seconds/,
      ],
    ];
    for (const [label, raw, problem] of cases) {
      const parsed = parsePartTest(raw);
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.problems.join("\n"), problem, label);
    }
  });
});
