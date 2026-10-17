/**
 * The builders' gate: a part enters the editor queue only when its own files pass, checked
 * without Unreal — its declaration (`part.json`), each Blueprint's text against the node reference
 * and the Blueprints the game's other parts declare, and its play test. Every problem is named with
 * its file and line, so a builder can fix them all in one go.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXEC_PIN, type ReferenceData } from "../../src/plugins/unreal/blueprint-reference.ts";
import { checkPart, PartProblemCode, type PartFiles } from "../../src/plugins/unreal/part-check.ts";
import { parsePartManifest } from "../../src/plugins/unreal/part-manifest.ts";

const X = EXEC_PIN;
const REFERENCE: ReferenceData = {
  version: 1,
  engine: "5.8.3",
  common: [
    "Math|Random|RandomFloatinRange",
    "Rendering|Components|Light|SetIntensity",
    "Transformation|AddLocalRotation",
    "Math|Rotator|MakeRotator",
    "Development|PrintString",
  ],
  contexts: { "Actor/EventGraph": ["AddEvent|EventBeginPlay", "AddEvent|EventTick"] },
  pins: {
    "AddEvent|EventTick": {
      inputs: [],
      outputs: [
        ["then", X],
        ["DeltaSeconds", "float"],
      ],
    },
  },
};

const LANTERN = {
  title: "Lantern",
  goal: "Two flickering lanterns light the path.",
  blueprints: [
    {
      name: "BP_Lantern",
      base: "Actor",
      components: [
        { name: "Body", class: "StaticMeshComponent" },
        { name: "Light", class: "PointLightComponent", parent: "Body" },
      ],
      variables: [{ name: "Flicker", type: "float" }],
      functions: [],
    },
  ],
};
const GOOD_TEXT = `(event EventTick (DeltaSeconds)
  (Rendering|Components|Light|SetIntensity :self (Variables|Default|GetLight) :NewIntensity (Math|Random|RandomFloatinRange 2000.0 5000.0)))`;

const files = (overrides: Partial<PartFiles> = {}): PartFiles => ({
  manifest: LANTERN,
  dsl: { "BP_Lantern.dsl": GOOD_TEXT },
  test: { steps: [{ shot: "lanterns" }] },
  hasApply: true,
  ...overrides,
});
const codes = (result: ReturnType<typeof checkPart>) => result.problems.map((p) => p.code);

describe("a part's declaration", () => {
  it("reads Blueprints with their base, components, variables and functions", () => {
    const parsed = parsePartManifest(LANTERN);
    assert.ok(parsed.ok);
    assert.equal(parsed.part.blueprints[0]?.base, "Actor");
    assert.deepEqual(
      parsed.part.blueprints[0]?.components.map((c) => c.name),
      ["Body", "Light"],
    );
  });

  it("refuses names that are paths and bases the reference doesn't cover", () => {
    const bad = (blueprint: Record<string, unknown>) =>
      parsePartManifest({ ...LANTERN, blueprints: [{ ...LANTERN.blueprints[0], ...blueprint }] });
    const cases: Array<[string, ReturnType<typeof parsePartManifest>, RegExp]> = [
      ["not an object", parsePartManifest([]), /object/],
      ["no blueprints list", parsePartManifest({ title: "x", goal: "y" }), /blueprints/],
      ["a path for a name", bad({ name: "../BP_Evil" }), /name/],
      ["spaces in a name", bad({ name: "BP Lantern" }), /name/],
      ["an unknown base", bad({ base: "Object" }), /base/],
      ["a component name with a slash", bad({ components: [{ name: "A/B", class: "X" }] }), /component/],
      ["a parent that isn't declared", bad({ components: [{ name: "A", class: "X", parent: "Nope" }] }), /parent/],
      ["a variable without a type", bad({ variables: [{ name: "V" }] }), /variable/],
      [
        "two Blueprints with one name",
        parsePartManifest({ ...LANTERN, blueprints: [LANTERN.blueprints[0], LANTERN.blueprints[0]] }),
        /twice/,
      ],
    ];
    for (const [label, parsed, problem] of cases) {
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.problems.join("\n"), problem, label);
    }
  });
});

describe("the builders' gate", () => {
  it("passes a part whose files are right", () => {
    const result = checkPart("Lantern", files(), REFERENCE, []);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  it("names a wrong node with its file, line and the name it meant", () => {
    const text = `(event EventTick (DeltaSeconds)\n  (Math|Random|RandomFloatRange 1.0 2.0))`;
    const result = checkPart("Lantern", files({ dsl: { "BP_Lantern.dsl": text } }), REFERENCE, []);
    assert.equal(result.ok, false);
    const [problem] = result.problems;
    assert.equal(problem?.file, "BP_Lantern.dsl");
    assert.equal(problem?.line, 2);
    assert.ok(problem?.suggestions?.includes("Math|Random|RandomFloatinRange"));
  });

  it("reports Blueprint text that doesn't parse as a problem, not a crash", () => {
    const result = checkPart("Lantern", files({ dsl: { "BP_Lantern.dsl": "(event EventTick" } }), REFERENCE, []);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0]?.file, "BP_Lantern.dsl");
  });

  it("refuses text for a Blueprint the part doesn't declare, a missing declaration, test or apply.py", () => {
    assert.ok(
      codes(checkPart("Lantern", files({ dsl: { "BP_Other.dsl": GOOD_TEXT } }), REFERENCE, [])).includes(
        PartProblemCode.Undeclared,
      ),
    );
    assert.ok(
      codes(checkPart("Lantern", files({ manifest: undefined }), REFERENCE, [])).includes(PartProblemCode.Manifest),
    );
    assert.ok(
      codes(checkPart("Lantern", files({ test: { steps: [{ jump: 1 }] } }), REFERENCE, [])).includes(
        PartProblemCode.Test,
      ),
    );
    assert.ok(codes(checkPart("Lantern", files({ hasApply: false }), REFERENCE, [])).includes(PartProblemCode.Apply));
  });

  it("refuses a Blueprint another part already declares", () => {
    const other = parsePartManifest(LANTERN);
    assert.ok(other.ok);
    const result = checkPart("Lantern2", files(), REFERENCE, [{ part: "Lantern", blueprints: other.part.blueprints }]);
    assert.ok(codes(result).includes(PartProblemCode.Owned));
  });

  it("knows the nodes of the Blueprints other parts declare", () => {
    const other = parsePartManifest({
      title: "Player",
      goal: "",
      blueprints: [
        {
          name: "BP_Player",
          base: "Character",
          components: [],
          variables: [{ name: "Health", type: "float" }],
          functions: [],
        },
      ],
    });
    assert.ok(other.ok);
    const text = `(event EventBeginPlay\n  (Development|PrintString :InString "hi"))`;
    const result = checkPart("Lantern", files({ dsl: { "BP_Lantern.dsl": text } }), REFERENCE, [
      { part: "Player", blueprints: other.part.blueprints },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });
});

describe("the gate before the engine exported its node reference", () => {
  it("only parses Blueprint text, and says so without failing the part", () => {
    const result = checkPart("Lantern", files(), null, []);
    assert.equal(result.ok, true);
    assert.equal(result.unverified, 1);
    assert.match(result.problems[0]?.message ?? "", /only parsed/);
    const broken = checkPart("Lantern", files({ dsl: { "BP_Lantern.dsl": "(event" } }), null, []);
    assert.equal(broken.ok, false, "text that doesn't parse still fails");
  });
});
