/**
 * part.json has two readers: Genex's gate (`part-manifest.ts`, check-part and run-part) and the
 * Genex editor helper inside Unreal (`part_files.py`, apply_part). A part the gate passes and the
 * helper refuses, or builds from another class, wastes a builder's work in the editor queue, so
 * the same declarations go through both here: each is accepted or refused by both, and an accepted
 * one gets the same base and C++ parent from both.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { parsePartManifest } from "../../src/plugins/unreal/part-manifest.ts";

const HELPER_PYTHON = path.resolve("src/plugins/unreal/GenexEditorHelper/Content/Python");
const PYTHON_TIMEOUT_MS = 30_000;
const skip = process.platform === "win32" ? "the helper's tests run on POSIX" : false;

/** Each declaration through the helper's reader: its Blueprints' [name, base, parent], or null when refused. */
const HELPER_READER = `
import json, sys
from genex_loop import part_files
from genex_loop.errors import Refused
answers = []
for raw in json.load(sys.stdin):
    try:
        _title, _goal, blueprints = part_files.parse_manifest(raw)
        answers.append([[b.name, b.base, getattr(b, "parent", None)] for b in blueprints])
    except Refused:
        answers.append(None)
print(json.dumps(answers))
`;

function helperReads(rows: unknown[]): Array<Array<[string, string, string | null]> | null> {
  const run = spawnSync("python3", ["-c", HELPER_READER], {
    input: JSON.stringify(rows),
    encoding: "utf8",
    timeout: PYTHON_TIMEOUT_MS,
    env: { ...process.env, PYTHONPATH: HELPER_PYTHON, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function gateReads(raw: unknown): Array<[string, string, string | null]> | null {
  const parsed = parsePartManifest(raw);
  return parsed.ok ? parsed.part.blueprints.map((b) => [b.name, b.base, b.parent ?? null]) : null;
}

const part = (fields: Record<string, unknown>, blueprint: Record<string, unknown>) => ({
  title: "Bike",
  goal: "",
  ...fields,
  blueprints: [{ name: "BP_Bike", ...blueprint }],
});

const ROWS: Array<[string, unknown]> = [
  ["an engine base", part({}, { base: "Actor" })],
  ["a C++ parent by its bare name", part({ cpp: ["BikeCamera"] }, { parent: "BikeCamera" })],
  ["a C++ parent with its A prefix", part({ cpp: ["BikeCamera"] }, { parent: "ABikeCamera" })],
  ["a C++ parent with its U prefix", part({ cpp: ["BikeLogic"] }, { parent: "UBikeLogic" })],
  [
    "a C++ parent and the base its nodes are checked against",
    part({ cpp: ["Rider"] }, { parent: "Rider", base: "Character" }),
  ],
  ["a parent the part's cpp doesn't list", part({ cpp: ["BikeCamera"] }, { parent: "LapTimer" })],
  ["a parent without any cpp", part({}, { parent: "BikeCamera" })],
  ["a parent given as a path", part({ cpp: ["BikeCamera"] }, { parent: "/Script/Rush.BikeCamera" })],
  ["no base and no parent", part({}, {})],
  ["an unknown base beside a parent", part({ cpp: ["BikeCamera"] }, { parent: "BikeCamera", base: "Object" })],
  ["cpp that isn't a list", part({ cpp: "BikeCamera" }, { base: "Actor" })],
  ["a cpp name with a path", part({ cpp: ["../BikeCamera"] }, { base: "Actor" })],
  ["a cpp name listed twice", part({ cpp: ["BikeCamera", "BikeCamera"] }, { base: "Actor" })],
  ["thirteen cpp classes", part({ cpp: Array.from({ length: 13 }, (_, i) => `Class${i}`) }, { base: "Actor" })],
  ["twelve cpp classes", part({ cpp: Array.from({ length: 12 }, (_, i) => `Class${i}`) }, { base: "Actor" })],
];

describe("part.json read the same by the gate and the editor helper", { skip }, () => {
  it("accepts and refuses the same declarations, with the same base and C++ parent", () => {
    const helper = helperReads(ROWS.map(([, raw]) => raw));
    for (const [i, [label, raw]] of ROWS.entries())
      assert.deepEqual(helper[i], gateReads(raw), `${label}: helper ${JSON.stringify(helper[i])}`);
  });
});
