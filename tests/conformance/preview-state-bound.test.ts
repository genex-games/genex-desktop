/**
 * The studio reads `__studio.state()` as a bounded structure, never as a cut string
 * (AUDIT-STATE-STUB): an 82 KB state came back as
 * `{__truncated, length, head}` and every probe of every facet read the stub. A state over the
 * budget now loses its largest lists to typed stubs and keeps every scalar; a state under it is
 * returned byte for byte as before. The bounder runs in the page from its own source, so these
 * tests run that source too (in a `node:vm` context, through the same evaluation wrapper).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  STATE_MAX_CHARS,
  boundStudioState,
  pageEvaluation,
  stateBoundOptions,
  studioStateExpression,
} from "../../src/main/preview-page-scripts.ts";
import { ElidedKind, MAX_KEEP_PATHS, StateShape, keepPathsOf } from "../../src/shared/studio-state-shape.ts";

/** The expression the studio evaluated before the bounder: the state, whole. */
const UNBOUNDED = "window.__studio ? window.__studio.state() : { __missing: true }";

type AnyRecord = Record<string, any>;

/**
 * What the page's evaluation hands the host: the exact text `evaluate()` parses, or how the
 * evaluation failed (a state the page cannot serialise fails it, outside the `{__error}` handler).
 */
async function pageText(expression: string, studio: unknown): Promise<string> {
  const window = studio === undefined ? {} : { __studio: studio };
  try {
    return (await runInNewContext(pageEvaluation(expression), { window })) as string;
  } catch (err) {
    return `rejected: ${(err as Error).name}: ${(err as Error).message}`;
  }
}

const ids = (count: number, prefix = "hud.speedo.segment.") =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
const bound = (state: unknown, keep: string[] = [], maxChars = STATE_MAX_CHARS) =>
  boundStudioState(state, stateBoundOptions(maxChars, keep)) as AnyRecord;
const chars = (value: unknown) => JSON.stringify(value).length;
const stub = (kind: string, length: number) => ({ [StateShape.Elided]: kind, length });
const stubShape = (value: AnyRecord) => ({ [StateShape.Elided]: value[StateShape.Elided], length: value.length });

describe("a state over the budget is bounded by structure", () => {
  it("cuts the 6,000-id HUD list and keeps every probe the board reads", () => {
    const state = {
      phase: "racing",
      player: { x: 12.5, z: -3, yaw: 1.2, speed: 41.7 },
      hud: { items: ids(6000), crosshair: true, flash: null },
      __render: { drawCalls: 212, triangles: 180_000 },
    };
    assert.ok(chars(state) > 82_000, "the fixture is the size the report measured");
    const out = bound(state);
    assert.ok(chars(out) <= STATE_MAX_CHARS, `bounded to ${chars(out)} chars`);
    assert.equal(out.phase, "racing");
    assert.deepEqual(out.player, state.player);
    assert.deepEqual(out.__render, state.__render);
    assert.equal(out.hud.crosshair, true);
    assert.equal(out.hud.flash, null);
    assert.deepEqual(stubShape(out.hud.items), stub(ElidedKind.Array, 6000));
    assert.equal(out.hud.items.chars, chars(state.hud.items));
    assert.deepEqual(out[StateShape.Cut], { chars: chars(state), paths: ["hud.items"] });
  });

  it("returns a state under the budget unchanged, with no cut marker", () => {
    const state = { phase: "menu", hud: { items: ids(40) }, player: { x: 1, y: 2 } };
    const out = bound(state);
    assert.deepEqual(out, state);
    assert.equal(StateShape.Cut in out, false);
  });

  it("is deterministic: the larger list goes first, and a tie goes by path whatever the key order", () => {
    const list = ids(1500);
    const tied = { b: list, a: list, score: 3 };
    const swapped = { a: list, b: list, score: 3 };
    const out = bound(tied);
    assert.deepEqual(out[StateShape.Cut].paths, ["a"]);
    assert.deepEqual(out.b, list);
    assert.equal(JSON.stringify(bound(swapped)), JSON.stringify(bound({ a: list, b: list, score: 3 })));
    assert.equal(JSON.stringify(bound(tied)), JSON.stringify(out), "the same state bounds the same way twice");
    const bigger = bound({ small: ids(1400), big: ids(1600), score: 3 });
    assert.deepEqual(bigger[StateShape.Cut].paths, ["big"]);
  });

  it("falls back to the object that holds the bulk when no list is left to cut, keeping its siblings", () => {
    const tiles = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, i * 1.5]));
    const out = bound({ world: { tiles, name: "dunes" }, player: { x: 1, z: 2 } });
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.deepEqual(stubShape(out.world.tiles), stub(ElidedKind.Object, 5000));
    assert.equal(out.world.name, "dunes");
    assert.deepEqual(out.player, { x: 1, z: 2 });
    assert.deepEqual(out[StateShape.Cut].paths, ["world.tiles"]);
  });

  it("cuts the map of many medium lists whole instead of spending every cut on its lists", () => {
    const path = Array.from({ length: 120 }, (_, i) => Math.round(i * 13.37 * 100) / 100);
    for (const count of [600, 1500, 4000]) {
      const agents = Object.fromEntries(Array.from({ length: count }, (_, i) => [`car${i}`, { lap: i % 3, path }]));
      const state = { phase: "racing", player: { x: 4.5 }, agents };
      const out = bound(state);
      assert.ok(chars(out) <= STATE_MAX_CHARS, `${count} agents bounded to ${chars(out)} chars`);
      assert.equal(out.phase, "racing");
      assert.deepEqual(out.player, { x: 4.5 });
      assert.deepEqual(stubShape(out.agents), stub(ElidedKind.Object, count));
      assert.deepEqual(out[StateShape.Cut].paths, ["agents"], "no list cut is spent inside the map it then cuts");
    }
  });
});

describe("keep: the paths a board reads survive the cut", () => {
  const state = () => ({
    race: { cars: ids(1600, "car.livery.number."), lap: 2 },
    hud: { items: ids(1200) },
    phase: "racing",
  });

  it("cuts the largest list when nothing is kept", () => {
    assert.deepEqual(bound(state())[StateShape.Cut].paths, ["race.cars"]);
  });

  it("keeps race.cars whole even when it is the largest subtree, and cuts the next one instead", () => {
    const out = bound(state(), ["race.cars"]);
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.deepEqual(out.race.cars, state().race.cars);
    assert.deepEqual(out[StateShape.Cut].paths, ["hud.items"]);
  });

  it("cuts a kept list last, only when nothing else brings the state under the budget", () => {
    const out = bound(state(), ["race.cars", "hud.items"]);
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.deepEqual(out[StateShape.Cut].paths, ["race.cars"]);
    assert.deepEqual(out.hud.items, state().hud.items);
  });

  it("reads keep paths only through the host's validation, so a hostile keep reaches nothing", async () => {
    const text = await pageText(studioStateExpression(STATE_MAX_CHARS, ["__proto__.polluted", "race.cars"]), {
      state: state,
    });
    const out = JSON.parse(text) as AnyRecord;
    assert.deepEqual(out[StateShape.Cut].paths, ["hud.items"]);
    assert.equal(({} as AnyRecord).polluted, undefined);
  });
});

describe("hostile states: bounded or answered exactly as before, never a prototype change", () => {
  it("cuts a single string over the budget to a string stub", () => {
    const out = bound({ log: "x".repeat(100_000), score: 1 });
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.deepEqual(stubShape(out.log), stub(ElidedKind.String, 100_000));
    assert.equal(out.score, 1);
  });

  it("bounds deep nesting with one cut, without overflowing the stack", () => {
    let deep: AnyRecord = { v: 1 };
    for (let i = 0; i < 2_000; i++) deep = { a: deep, pad: "p".repeat(24) };
    const out = bound({ deep, score: 1 });
    assert.ok(chars(out) <= STATE_MAX_CHARS, `bounded to ${chars(out)} chars`);
    assert.equal(out.score, 1);
    assert.equal(out.deep.pad, "p".repeat(24));
    assert.equal(out[StateShape.Cut].paths.length, 1, "the deepest value that is enough is cut, once");
  });

  it("hands back nesting too deep to serialise untouched, without throwing", () => {
    let deep: AnyRecord = { v: 1 };
    for (let i = 0; i < 10_000; i++) deep = { a: deep };
    const state = { deep, score: 1 };
    assert.equal(bound(state), state);
  });

  it("cuts under __proto__ and constructor keys as plain data", () => {
    const state = JSON.parse(
      JSON.stringify({ x: 1 }).replace(
        "{",
        `{"__proto__":{"items":${JSON.stringify(ids(3000))}},"constructor":{"prototype":${JSON.stringify(ids(3000))}},`,
      ),
    );
    const out = bound(state);
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(({} as AnyRecord).items, undefined);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.equal(out.x, 1);
    assert.deepEqual(out[StateShape.Cut].paths.sort(), ["__proto__.items", "constructor.prototype"]);
  });

  it("answers a state that is not an object with a stub at the root", () => {
    const out = bound(ids(6000));
    assert.ok(chars(out) <= STATE_MAX_CHARS);
    assert.deepEqual(stubShape(out), stub(ElidedKind.Array, 6000));
  });

  const sameAsBefore: Array<[string, unknown]> = [
    ["a cycle", { state: () => cyclic() }],
    [
      "a throwing getter",
      {
        state: () => ({
          get boom() {
            throw new Error("no");
          },
        }),
      },
    ],
    [
      "a throwing state()",
      {
        state: () => {
          throw new Error("broken");
        },
      },
    ],
    ["no __studio", undefined],
    ["no state() method", {}],
    ["state() answers undefined", { state: () => undefined }],
    ["state() answers a promise", { state: async () => ({ phase: "menu", n: 1 }) }],
    ["nesting too deep to serialise", { state: () => tooDeep() }],
  ];
  for (const [name, studio] of sameAsBefore) {
    it(`answers ${name} exactly as before`, async () => {
      assert.equal(await pageText(studioStateExpression(), studio), await pageText(UNBOUNDED, studio));
    });
  }
});

function cyclic(): AnyRecord {
  const node: AnyRecord = { id: 1 };
  node.self = node;
  return node;
}

function tooDeep(): AnyRecord {
  let deep: AnyRecord = { v: 1 };
  for (let i = 0; i < 100_000; i++) deep = { a: deep };
  return { deep };
}

describe("byte identity under the budget", () => {
  const states: Array<[string, unknown]> = [
    ["plain", { phase: "menu", score: 0, player: { x: 1.25, z: -0, yaw: Math.PI } }],
    ["integer-like and unicode keys", { 10: "ten", 2: "two", b: "β", é: ["ü", " ", "\u0000"] }],
    [
      "non-JSON values",
      { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, fn: () => 1, undef: undefined, d: new Date(0) },
    ],
    ["toJSON", { v: { toJSON: () => ({ shown: true }) } }],
    ["just under the budget", { blob: "y".repeat(STATE_MAX_CHARS - 20) }],
    ["a top-level array", [1, 2, { a: [3] }]],
    ["a scalar", 42],
  ];
  for (const [name, state] of states) {
    it(`reads ${name} byte for byte as the unbounded read did`, async () => {
      const studio = { state: () => state };
      assert.equal(await pageText(studioStateExpression(), studio), await pageText(UNBOUNDED, studio));
    });
  }
});

describe("keepPathsOf: the host's validation of preview.state's keep", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const table: Array<[string, unknown, string[]]> = [
    ["absent", undefined, []],
    ["a string", "race.cars", []],
    ["an array-like object", { 0: "race.cars", length: 1 }, []],
    ["non-strings", [1, null, {}, ["race"], true], []],
    ["empty and malformed paths", ["", ".race", "race.", "race..cars"], []],
    ["prototype segments", ["__proto__.polluted", "a.constructor", "prototype", "x.__proto__"], []],
    ["an over-long path", ["a".repeat(121)], []],
    [
      "10,000 entries",
      Array.from({ length: 10_000 }, (_, i) => `p${i}`),
      Array.from({ length: MAX_KEEP_PATHS }, (_, i) => `p${i}`),
    ],
    ["duplicates", ["race.cars", "race.cars", "hud.items"], ["race.cars", "hud.items"]],
    ["well-formed paths", ["race.cars", "state.player.x", "cars.0.x"], ["race.cars", "state.player.x", "cars.0.x"]],
  ];
  for (const [name, raw, kept] of table) {
    it(`keeps ${kept.length ? kept.length : "no"} path(s) of ${name}`, () => {
      assert.deepEqual(keepPathsOf(raw), kept);
      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
      assert.equal(({} as AnyRecord).polluted, undefined);
    });
  }
});
