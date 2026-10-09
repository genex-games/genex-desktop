/**
 * The paths a board reads, named for `preview.state`'s `keep` so the studio cuts them last
 * (`loop/state-shape.ts`), and the seed's reading of the stubs a bounded state carries.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ElidedKind,
  MAX_KEEP_PATHS,
  StateShape,
  isElidedStub,
  isTruncatedState,
  stateCutOf,
  statePathsNamedByChecks,
} from "../../src/harness-seed/loop/state-shape.ts";
import type { Check } from "../../src/harness-seed/loop/spec.ts";

const probe = (id: string, expr: string, needs?: string[]) =>
  ({ id, kind: "probe", expr, ...(needs ? { needs } : {}) }) as Check;

describe("statePathsNamedByChecks", () => {
  it("names every path a probe reads, as a path of the state, once", () => {
    const checks = [
      probe("keys", "abs(delta('player.x')) > 0 || abs(delta('player.z')) > 0", ["player.x", "player.z"]),
      probe("lap", "state.race.lap >= 2 && early.race.lap < 2"),
      probe("flow", "has('flow.playing') && flow.phase in ['race', 'results']"),
      probe("lead", "len(race.cars) >= 4 && race.cars.lead != null"),
    ];
    assert.deepEqual(statePathsNamedByChecks(checks), [
      "player.x",
      "player.z",
      "race.lap",
      "state.race.lap",
      "flow.phase",
      "race.cars.lead",
    ]);
  });

  it("names a state. path both ways: the scope's alias, or a game's own top-level state field", () => {
    assert.deepEqual(statePathsNamedByChecks([probe("mode", "state.mode == 'race'")]), ["mode", "state.mode"]);
    assert.deepEqual(statePathsNamedByChecks([probe("lap", "early.race.lap < 2")]), ["race.lap"]);
  });

  it("leaves out a list read only through len(), .length or has(): its stub answers those", () => {
    assert.deepEqual(statePathsNamedByChecks([probe("hud", "len(hud.items) >= 1")]), []);
    assert.deepEqual(statePathsNamedByChecks([probe("hud", "hud.items.length >= 1")]), []);
    assert.deepEqual(statePathsNamedByChecks([probe("hud", "has('hud.items')")]), []);
    assert.deepEqual(statePathsNamedByChecks([probe("hud", "hud.items.length >= 1 && player.x > 0")]), ["player.x"]);
    assert.deepEqual(statePathsNamedByChecks([probe("hud", "len(hud.items) >= 1 && hud.items != null")]), [
      "hud.items",
    ]);
  });

  it("reads nothing from checks that are not probes, do not parse or name a prototype", () => {
    const checks = [
      { id: "pix", kind: "pixel", expr: "meanLuma > 0.2" },
      { id: "eye", kind: "vision", ask: "Is the car visible?" },
      probe("broken", "(("),
      probe("proto", "__proto__.x > 0", ["constructor.y", "a.prototype"]),
      probe("scope", "state > 0 && early != null"),
    ] as Check[];
    assert.deepEqual(statePathsNamedByChecks(checks), []);
    assert.deepEqual(statePathsNamedByChecks(null), []);
    assert.deepEqual(statePathsNamedByChecks(undefined), []);
  });

  it("names at most as many paths as the studio honours", () => {
    const many = Array.from({ length: 100 }, (_, i) => probe(`p${i}`, `p${i}.x > 0`));
    const named = statePathsNamedByChecks(many);
    assert.equal(named.length, MAX_KEEP_PATHS);
    assert.equal(named[0], "p0.x");
  });
});

describe("reading a state the studio bounded", () => {
  it("knows a stub, an older studio's text cut, and what a bounded state says it cut", () => {
    const stub = { [StateShape.Elided]: ElidedKind.Array, length: 6000, chars: 168_001 };
    assert.equal(isElidedStub(stub), true);
    assert.equal(isElidedStub([1, 2]), false);
    assert.equal(isElidedStub({ length: 3 }), false);
    assert.equal(isTruncatedState({ [StateShape.Truncated]: true, length: 82_303, head: "{" }), true);
    assert.equal(isTruncatedState({ phase: "menu" }), false);
    assert.deepEqual(stateCutOf({ [StateShape.Cut]: { chars: 90_000, paths: ["hud.items"] } }), {
      chars: 90_000,
      paths: ["hud.items"],
    });
    assert.equal(stateCutOf({ phase: "menu" }), null);
  });
});
