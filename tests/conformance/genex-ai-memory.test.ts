/**
 * `ai.memory()`: a rolling memory a game hands its calls. It keeps its last lines within bounds and
 * saves with the game; a restored snapshot is the player's to edit, so it is read as hostile input
 * and a refusal leaves the memory exactly as it was.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCompaction,
  createMemory,
  keepOf,
  MEMORY_DEFAULT_KEEP,
  MEMORY_MAX_KEEP,
  MEMORY_MAX_LINE_CHARS,
  MEMORY_MAX_ROLE_CHARS,
} from "../../src/page/ai/memory.ts";

const noCompact = () => {};

describe("a game's memory", () => {
  it("keeps its last `keep` lines, oldest first, and carries them as one text", () => {
    const memory = createMemory("chronicle", 3, noCompact);
    assert.equal(memory.text(), null);
    for (const word of ["a", "b", "c", "d"]) memory.remember("narrator", word);
    assert.deepEqual(
      memory.lines().map((line) => line.text),
      ["b", "c", "d"],
    );
    assert.equal(memory.text(), "narrator: b\nnarrator: c\nnarrator: d");
  });

  it("cuts an over-long role and line, and forgets a blank one", () => {
    const memory = createMemory("m", 4, noCompact);
    memory.remember("r".repeat(MEMORY_MAX_ROLE_CHARS + 9), "t".repeat(MEMORY_MAX_LINE_CHARS + 50));
    memory.remember("  ", "said");
    memory.remember("who", "   ");
    const [line] = memory.lines();
    assert.equal(memory.lines().length, 1);
    assert.equal(line?.role.length, MEMORY_MAX_ROLE_CHARS);
    assert.equal(line?.text.length, MEMORY_MAX_LINE_CHARS);
  });

  it("bounds the keep a game asks for", () => {
    assert.equal(keepOf(undefined), MEMORY_DEFAULT_KEEP);
    assert.equal(keepOf(Number.NaN), MEMORY_DEFAULT_KEEP);
    assert.equal(keepOf("5"), MEMORY_DEFAULT_KEEP);
    assert.equal(keepOf(0), 1);
    assert.equal(keepOf(-4), 1);
    assert.equal(keepOf(2.9), 2);
    assert.equal(keepOf(1e9), MEMORY_MAX_KEEP);
  });

  it("saves and restores itself", () => {
    const memory = createMemory("chronicle", 5, noCompact);
    memory.remember("king", "war");
    const saved = JSON.parse(JSON.stringify(memory.snapshot()));
    const again = createMemory("chronicle", 5, noCompact);
    assert.equal(again.restore(saved), true);
    assert.deepEqual(again.lines(), memory.lines());
  });

  it("folds a compaction's summary in place of the lines it summarized", () => {
    const memory = createMemory("m", 6, noCompact);
    for (const word of ["a", "b"]) memory.remember("x", word);
    const summarized = [...memory.lines()];
    memory.remember("x", "c");
    applyCompaction(memory, summarized, "a then b", "summary");
    assert.deepEqual(
      memory.lines().map((line) => `${line.role}:${line.text}`),
      ["summary:a then b", "x:c"],
    );
  });
});

describe("a restored snapshot is hostile input", () => {
  const proto = JSON.parse('{"v":1,"name":"m","lines":[],"__proto__":{"polluted":true}}');
  const ROWS: Array<[string, unknown]> = [
    ["not an object", "m"],
    ["null", null],
    ["an array", [1, 2]],
    ["another version", { v: 2, name: "m", lines: [] }],
    ["another memory's", { v: 1, name: "other", lines: [] }],
    ["lines not a list", { v: 1, name: "m", lines: "a" }],
    [
      "too many lines",
      { v: 1, name: "m", lines: Array.from({ length: MEMORY_MAX_KEEP + 1 }, () => ({ role: "a", text: "b" })) },
    ],
    ["a line not an object", { v: 1, name: "m", lines: ["x"] }],
    ["a role not text", { v: 1, name: "m", lines: [{ role: 1, text: "b" }] }],
    ["a text not text", { v: 1, name: "m", lines: [{ role: "a", text: { toString: () => "b" } }] }],
    ["a class instance", Object.assign(new (class Snapshot {})(), { v: 1, name: "m", lines: [] })],
  ];

  for (const [name, raw] of ROWS) {
    it(`refuses ${name} and keeps what it had`, () => {
      const memory = createMemory("m", 4, noCompact);
      memory.remember("kept", "line");
      assert.equal(memory.restore(raw), false);
      assert.deepEqual(memory.lines(), [{ role: "kept", text: "line" }]);
    });
  }

  it("never copies a prototype key", () => {
    const memory = createMemory("m", 4, noCompact);
    memory.restore(proto);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
