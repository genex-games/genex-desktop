/**
 * C++ parts: part.json lists the UCLASS names a part defines (`cpp`, without the A or U
 * prefix) and its C++ lives in `unreal/Source/<Module>/Parts/<Part>/` of the builder's copy. The
 * gate refuses C++ without the game's module, where it can't compile, a class no header declares,
 * C++ files part.json doesn't list and changes outside the part's own folder; a Blueprint may take
 * one of the part's classes as its parent, and nodes it inherits are "unverified", never errors.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXEC_PIN, type ReferenceData } from "../../src/plugins/unreal/blueprint-reference.ts";
import { Severity } from "../../src/plugins/unreal/blueprint-check.ts";
import {
  CppSupport,
  checkPart,
  type PartCpp,
  type PartFiles,
  PartProblemCode,
} from "../../src/plugins/unreal/part-check.ts";
import { MAX_CPP_CLASSES, parsePartManifest } from "../../src/plugins/unreal/part-manifest.ts";

const REFERENCE: ReferenceData = {
  version: 1,
  engine: "5.8.3",
  common: ["Development|PrintString"],
  contexts: { "Actor/EventGraph": ["AddEvent|EventBeginPlay", "AddEvent|EventTick"] },
  pins: { "AddEvent|EventBeginPlay": { inputs: [], outputs: [["then", EXEC_PIN]] } },
};

const BIKE = {
  title: "Bike camera",
  goal: "The camera rides the bike's front.",
  cpp: ["BikeCamera"],
  blueprints: [{ name: "BP_BikeCamera", parent: "BikeCamera" }],
};

const HEADER = [
  "#pragma once",
  '#include "GameFramework/Actor.h"',
  '#include "BikeCamera.generated.h"',
  "",
  'UCLASS(Blueprintable, meta=(DisplayName="Bike camera"))',
  "class DIRTTRACK_API ABikeCamera : public AActor",
  "{",
  "\tGENERATED_BODY()",
  "};",
].join("\n");

const FOLDER = "unreal/Source/DirtTrack/Parts/Bike";

const cppFiles = (overrides: Partial<PartCpp> = {}): PartCpp => ({
  module: "DirtTrack",
  folder: FOLDER,
  files: { "BikeCamera.h": HEADER, "BikeCamera.cpp": '#include "BikeCamera.h"\n' },
  problems: [],
  outside: [],
  ...overrides,
});

const files = (overrides: Partial<PartFiles> = {}): PartFiles => ({
  manifest: BIKE,
  dsl: { "BP_BikeCamera.dsl": '(event EventBeginPlay\n  (Development|PrintString :InString "hi"))' },
  test: { steps: [{ shot: "bike" }] },
  hasApply: true,
  cpp: cppFiles(),
  ...overrides,
});

const ready = { cppSupport: CppSupport.Ready };
const errors = (result: ReturnType<typeof checkPart>) => result.problems.filter((p) => p.severity === Severity.Error);
const cppErrors = (result: ReturnType<typeof checkPart>) =>
  errors(result).filter((p) => p.code === PartProblemCode.Cpp || p.code === PartProblemCode.Owned);

describe("part.json's C++ classes", () => {
  it("are read without their prefix, and absent means none", () => {
    const parsed = parsePartManifest(BIKE);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.part.cpp, ["BikeCamera"]);
    const blueprintOnly = parsePartManifest({ title: "x", goal: "", blueprints: [] });
    assert.ok(blueprintOnly.ok);
    assert.deepEqual(blueprintOnly.part.cpp, []);
  });

  it("refuses a list that isn't one of identifiers, is too long or names a class twice", () => {
    const rows: Array<[string, unknown, RegExp]> = [
      ["not a list", "BikeCamera", /cpp/],
      ["a path", ["../Evil"], /cpp #1/],
      ["a file name", ["BikeCamera.h"], /cpp #1/],
      ["a space", ["Bike Camera"], /cpp #1/],
      ["empty", [""], /cpp #1/],
      ["a number", [7], /cpp #1/],
      ["a leading digit", ["2Fast"], /cpp #1/],
      ["too long a name", ["X".repeat(65)], /cpp #1/],
      ["twice", ["BikeCamera", "BikeCamera"], /BikeCamera.*twice/],
      ["too many", Array.from({ length: MAX_CPP_CLASSES + 1 }, (_, i) => `Class${i}`), /at most 12/],
    ];
    for (const [label, cpp, problem] of rows) {
      const parsed = parsePartManifest({ ...BIKE, cpp, blueprints: [] });
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.problems.join("\n"), problem, label);
    }
  });
});

describe("a Blueprint whose parent is one of the part's C++ classes", () => {
  it("names the class with or without its prefix, and is an Actor unless it says otherwise", () => {
    for (const parent of ["BikeCamera", "ABikeCamera"]) {
      const parsed = parsePartManifest({ ...BIKE, blueprints: [{ name: "BP_BikeCamera", parent }] });
      assert.ok(parsed.ok, parent);
      assert.equal(parsed.part.blueprints[0]?.parent, "BikeCamera", parent);
      assert.equal(parsed.part.blueprints[0]?.base, "Actor", parent);
    }
    const pawn = parsePartManifest({ ...BIKE, blueprints: [{ name: "BP_Bike", parent: "BikeCamera", base: "Pawn" }] });
    assert.ok(pawn.ok);
    assert.equal(pawn.part.blueprints[0]?.base, "Pawn");
  });

  it("refuses a parent that isn't one of the part's classes, and still needs a base without one", () => {
    const rows: Array<[string, Record<string, unknown>, RegExp]> = [
      ["an undeclared class", { name: "BP_X", parent: "Wheel" }, /parent Wheel isn't one of the part's C\+\+ classes/],
      ["a path", { name: "BP_X", parent: "../BikeCamera" }, /parent/],
      ["another prefix", { name: "BP_X", parent: "FBikeCamera" }, /parent/],
      ["no base and no parent", { name: "BP_X" }, /base/],
      ["a bad base beside a parent", { name: "BP_X", parent: "BikeCamera", base: "Object" }, /base/],
    ];
    for (const [label, blueprint, problem] of rows) {
      const parsed = parsePartManifest({ ...BIKE, blueprints: [blueprint] });
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.problems.join("\n"), problem, label);
    }
  });

  it("makes the nodes it inherits from C++ unverified, never errors", () => {
    const text = [
      "(event EventBeginPlay",
      "  (Variables|Genex|SetBoost :Boost 2.0)",
      '  (Development|PrintStrin :InString "hi"))',
      "(event OnLapFinished)",
    ].join("\n");
    const result = checkPart("Bike", files({ dsl: { "BP_BikeCamera.dsl": text } }), REFERENCE, [], [], ready);
    assert.deepEqual(errors(result), [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
    assert.equal(result.unverified, 3);
    assert.ok(result.problems.every((p) => p.severity === Severity.Unverified));
  });

  it("a Blueprint without a C++ parent still fails on a node that doesn't exist", () => {
    const manifest = { ...BIKE, blueprints: [{ name: "BP_BikeCamera", base: "Actor" }] };
    const text = '(event EventBeginPlay\n  (Development|PrintStrin :InString "hi"))';
    const result = checkPart("Bike", files({ manifest, dsl: { "BP_BikeCamera.dsl": text } }), REFERENCE, [], [], ready);
    assert.equal(result.ok, false);
  });

  it("another Blueprint reaching the C++ child's members through it is unverified there too", () => {
    const manifest = {
      ...BIKE,
      blueprints: [
        { name: "BP_BikeCamera", parent: "BikeCamera" },
        { name: "BP_Hud", base: "Actor" },
      ],
    };
    const hud =
      "(event EventBeginPlay\n  (Development|PrintString :InString (Class|BPBikeCamera|GetBoost :self self)))";
    const result = checkPart("Bike", files({ manifest, dsl: { "BP_Hud.dsl": hud } }), REFERENCE, [], [], ready);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });
});

describe("the gate on a part's C++", () => {
  it("passes C++ whose classes are declared, in a game with its module, where C++ compiles", () => {
    const result = checkPart("Bike", files(), REFERENCE, [], [], ready);
    assert.deepEqual(errors(result), []);
  });

  it("finds a UCLASS declared as a U-class, with or without an API macro and with comments between", () => {
    const header = "UCLASS()\n// the lap counter\nclass ULapCounter : public UActorComponent\n{ GENERATED_BODY() };";
    const manifest = { ...BIKE, cpp: ["BikeCamera", "LapCounter"] };
    const cpp = cppFiles({ files: { "BikeCamera.h": HEADER, "Public/LapCounter.h": header } });
    assert.deepEqual(cppErrors(checkPart("Bike", files({ manifest, cpp }), REFERENCE, [], [], ready)), []);
  });

  it("says the game has no C++ module yet, and to write the part in Blueprints and Python or wait", () => {
    const result = checkPart("Bike", files({ cpp: cppFiles({ module: undefined }) }), REFERENCE, [], [], ready);
    const [problem] = cppErrors(result);
    assert.equal(cppErrors(result).length, 1);
    assert.match(problem?.message ?? "", /^This game has no C\+\+ module yet;/);
    assert.match(problem?.message ?? "", /Blueprints/);
  });

  it("says C++ can't compile on this computer, and why", () => {
    const rows: Array<[CppSupport, RegExp]> = [
      [CppSupport.NotMac, /Mac/],
      [CppSupport.NoXcode, /Xcode/],
    ];
    for (const [cppSupport, why] of rows) {
      const problems = cppErrors(checkPart("Bike", files(), REFERENCE, [], [], { cppSupport }));
      assert.equal(problems.length, 1, cppSupport);
      assert.match(problems[0]?.message ?? "", why, cppSupport);
      assert.match(problems[0]?.message ?? "", /Blueprints/, cppSupport);
    }
  });

  it("names a declared class no header declares with UCLASS", () => {
    const rows: Array<[string, Record<string, string>]> = [
      ["no files", {}],
      ["only a source", { "BikeCamera.cpp": "class ABikeCamera {};" }],
      ["no UCLASS", { "BikeCamera.h": "class DIRTTRACK_API ABikeCamera : public AActor {};" }],
      ["another class", { "BikeCamera.h": HEADER.replace("ABikeCamera", "ABikeCam") }],
      ["an F prefix", { "BikeCamera.h": HEADER.replace("ABikeCamera", "FBikeCamera") }],
      ["only in a comment of a source", { "BikeCamera.cpp": `/*\n${HEADER}\n*/` }],
    ];
    for (const [label, texts] of rows) {
      const problems = cppErrors(
        checkPart("Bike", files({ cpp: cppFiles({ files: texts }) }), REFERENCE, [], [], ready),
      );
      assert.equal(problems.length, 1, label);
      assert.match(problems[0]?.message ?? "", /BikeCamera/, label);
      assert.match(problems[0]?.message ?? "", /DIRTTRACK_API/, label);
    }
  });

  it("refuses C++ files part.json doesn't list a class for", () => {
    const manifest = { ...BIKE, cpp: undefined, blueprints: [{ name: "BP_BikeCamera", base: "Actor" }] };
    const problems = cppErrors(checkPart("Bike", files({ manifest }), REFERENCE, [], [], ready));
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.message ?? "", /cpp/);
    const none = checkPart("Bike", files({ manifest, cpp: cppFiles({ files: {} }) }), REFERENCE, [], [], ready);
    assert.deepEqual(cppErrors(none), [], "no C++ files, no C++ problem");
  });

  it("names every file the folder can't hold and every change outside the part's own folder", () => {
    const cpp = cppFiles({
      problems: [{ file: `${FOLDER}/notes.txt`, message: "only .h and .cpp files" }],
      outside: ["unreal/Source/DirtTrack/DirtTrack.Build.cs", "unreal/Source/DirtTrack/Parts/Hud/Hud.h"],
    });
    const problems = cppErrors(checkPart("Bike", files({ cpp }), REFERENCE, [], [], ready));
    assert.deepEqual(
      problems.map((p) => p.file),
      ["unreal/Source/DirtTrack/DirtTrack.Build.cs", "unreal/Source/DirtTrack/Parts/Hud/Hud.h", `${FOLDER}/notes.txt`],
    );
    assert.match(problems[0]?.message ?? "", /outside/);
  });

  it("refuses a C++ class another part already defines", () => {
    const others = [{ part: "Camera", blueprints: [], cpp: ["BikeCamera"] }];
    const problems = cppErrors(checkPart("Bike", files(), REFERENCE, others, [], ready));
    assert.deepEqual(
      problems.map((p) => p.code),
      [PartProblemCode.Owned],
    );
  });

  it("a Blueprint-only part in a Blueprint game has no C++ problem, wherever it runs", () => {
    const manifest = { ...BIKE, cpp: [], blueprints: [{ name: "BP_BikeCamera", base: "Actor" }] };
    for (const cppSupport of Object.values(CppSupport)) {
      const result = checkPart("Bike", files({ manifest, cpp: undefined }), REFERENCE, [], [], { cppSupport });
      assert.deepEqual(cppErrors(result), [], cppSupport);
    }
  });
});
