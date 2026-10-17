/**
 * Genex checks builders' Blueprint text without Unreal, against a node reference exported from the
 * user's own engine. The tokenizer reads text exactly as Epic's `blueprint_dsl.py` does, and the
 * checker refuses what Epic's transpiler would refuse. Common Blueprint mistakes are in the table
 * below; each must be caught, with the right name suggested, and correct text must pass untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BaseClass,
  type BlueprintDecl,
  createNodeLookup,
  EXEC_PIN,
  GraphKind,
  type ReferenceData,
} from "../../src/plugins/unreal/blueprint-reference.ts";
import {
  CONSTRUCTION_GRAPH,
  checkGraphWrite,
  type GraphWrite,
  graphKindOf,
  ProblemCode,
  Severity,
  splitByGraph,
  suggestNodes,
} from "../../src/plugins/unreal/blueprint-check.ts";
import { AtomKind, BlueprintTextError, parseBlueprintText, tokenize } from "../../src/plugins/unreal/blueprint-text.ts";

const X = EXEC_PIN;

/** A small reference in the shape the editor exports: names per context plus the pins read so far. */
const REFERENCE: ReferenceData = {
  version: 1,
  engine: "5.8.3",
  common: [
    "Math|Integer|Min(Integer)",
    "Math|Float|Min(Float)",
    "Math|Vector|Normalize",
    "Math|Vector|MakeVector",
    "Math|Rotator|MakeRotator",
    "Math|Random|RandomFloatinRange",
    "Utilities|Struct|MakeLinearColor",
    "Math|Color|MakeColor",
    "Components|Sphere|GetScaledSphereRadius",
    "Class|SphereCollision|GetSphereRadius",
    "Class|AudioComponent|SetVolumeMultiplier",
    "Class|CharacterMovementComponent|SetMaxWalkSpeed",
    "Rendering|Material|SetVectorParameterValue",
    "Rendering|Material|SetVectorParameterValueonMaterials",
    "Rendering|Components|Light|SetIntensity",
    "Transformation|GetActorLocation",
    "Transformation|AddLocalRotation",
    "Development|PrintString",
    "Input|MouseEvents|LeftMouseButton",
    "Game|GetPlayerPawn",
    "Utilities|IsValid",
    "Utilities|FlowControl|Switch|SwitchonInt",
  ],
  contexts: {
    "Actor/EventGraph": ["AddEvent|EventBeginPlay", "AddEvent|EventTick", "AddEvent|Game|Damage|EventAnyDamage"],
    "Character/EventGraph": ["AddEvent|EventBeginPlay", "AddEvent|EventTick", "AddEvent|Game|Damage|EventAnyDamage"],
    "HUD/EventGraph": ["AddEvent|EventBeginPlay", "AddEvent|EventReceiveDrawHUD", "HUD|DrawRect"],
  },
  pins: {
    "AddEvent|EventTick": {
      inputs: [],
      outputs: [
        ["then", X],
        ["DeltaSeconds", "float"],
      ],
    },
    "AddEvent|EventBeginPlay": { inputs: [], outputs: [["then", X]] },
    "AddEvent|EventReceiveDrawHUD": {
      inputs: [],
      outputs: [
        ["then", X],
        ["SizeX", "int"],
        ["SizeY", "int"],
      ],
    },
    "Class|AudioComponent|SetVolumeMultiplier": {
      inputs: [
        ["execute", X],
        ["VolumeMultiplier", "float"],
        ["self", "Audio Component"],
      ],
      outputs: [
        ["then", X],
        ["Output_Get", "float"],
      ],
    },
    "Class|CharacterMovementComponent|SetMaxWalkSpeed": {
      inputs: [
        ["execute", X],
        ["MaxWalkSpeed", "float"],
        ["self", "Character Movement Component"],
      ],
      outputs: [
        ["then", X],
        ["Output_Get", "float"],
      ],
    },
    "Rendering|Material|SetVectorParameterValue": {
      inputs: [
        ["execute", X],
        ["Collection", "Material Parameter Collection"],
        ["ParameterName", "Name"],
        ["ParameterValue", "Linear Color"],
      ],
      outputs: [["then", X]],
    },
    "Rendering|Components|Light|SetIntensity": {
      inputs: [
        ["execute", X],
        ["self", "Light Component"],
        ["NewIntensity", "float"],
      ],
      outputs: [["then", X]],
    },
    "Math|Random|RandomFloatinRange": {
      inputs: [
        ["Min", "float"],
        ["Max", "float"],
      ],
      outputs: [["ReturnValue", "float"]],
    },
    "Utilities|IsValid": {
      inputs: [
        ["exec", X],
        ["InputObject", "Object"],
      ],
      outputs: [
        ["Is Valid", X],
        ["Is Not Valid", X],
      ],
    },
    "Development|PrintString": {
      inputs: [
        ["execute", X],
        ["InString", "string"],
        ["Duration", "float"],
      ],
      outputs: [["then", X]],
    },
  },
};

const WANDERER: BlueprintDecl = {
  name: "BP_Wanderer",
  base: BaseClass.Character,
  variables: [
    { name: "Health", type: "float" },
    { name: "Dt", type: "float" },
  ],
  components: [
    { name: "Lamp", class: "AudioComponent" },
    { name: "Light", class: "PointLightComponent" },
  ],
  functions: [{ name: "HandleDark" }, { name: "Clamp", inputs: ["Value"], outputs: ["Out"] }],
};
const HUD: BlueprintDecl = { name: "BP_ValleyHUD", base: BaseClass.HUD, variables: [], components: [], functions: [] };

function check(text: string, graph = "EventGraph", decl: BlueprintDecl = WANDERER) {
  const write: GraphWrite = { blueprint: decl.name, graph, text };
  const others = [WANDERER, HUD].filter((d) => d !== decl);
  return checkGraphWrite(write, createNodeLookup(REFERENCE, decl.base, graphKindOf(graph), decl, others), decl);
}
const errors = (text: string, graph?: string, decl?: BlueprintDecl) =>
  check(text, graph, decl).filter((p) => p.severity === Severity.Error);

test("Blueprint text is tokenized exactly as Epic's tokenizer reads it", () => {
  const atoms = tokenize(
    '(Utilities|Operators|Equal(==) :"Array Element" TRUE 1_000 .5 e5 inf "a\\"b" ; note\n Math|Trig|Sin(Degrees))',
  );
  const word = (t: (typeof atoms)[number]) => {
    if (t.kind === "open" || t.kind === "close") return t.kind;
    return "text" in t ? `${t.kind}:${t.text}` : `${t.kind}:${t.value}`;
  };
  const words = atoms.map(word);
  assert.deepEqual(words, [
    "open",
    "symbol:Utilities|Operators|Equal(==)",
    "symbol::Array Element",
    "bool:true",
    "number:1000",
    "number:0.5",
    "symbol:e5",
    `${AtomKind.Number}:NaN`,
    'string:a"b',
    "symbol:Math|Trig|Sin(Degrees)",
    "close",
  ]);
});

test("Blueprint text that Epic's parser refuses is refused with its line", () => {
  const cases: [string, string, number][] = [
    ['(event EventTick\n  (Development|PrintString "hi")', "Unclosed parenthesis", 1],
    ["(event EventTick)\n)", "Unexpected )", 2],
    ['(event EventTick\n  (Development|PrintString "hi))', "unterminated string literal", 2],
  ];
  for (const [text, message, line] of cases) {
    assert.throws(
      () => parseBlueprintText(text),
      (error: unknown) => {
        assert.ok(error instanceof BlueprintTextError);
        assert.equal(error.message, message);
        assert.equal(error.line, line, text);
        return true;
      },
    );
  }
  const [problem] = check('(event EventTick\n  (Development|PrintString "x")');
  assert.equal(problem?.code, ProblemCode.Syntax);
});

/** Common Blueprint mistakes, each with what Epic says and what Genex says instead. */
const MISTAKES: {
  what: string;
  text: string;
  graph?: string;
  decl?: BlueprintDecl;
  code: ProblemCode;
  suggest?: string;
}[] = [
  {
    what: "construction script as an event",
    text: '(event UserConstructionScript\n  (Development|PrintString "x"))',
    graph: CONSTRUCTION_GRAPH,
    code: ProblemCode.UnknownEvent,
  },
  {
    what: "construction script entry named after its graph",
    text: '(fn UserConstructionScript ()\n  (Development|PrintString "x"))',
    graph: CONSTRUCTION_GRAPH,
    code: ProblemCode.FunctionGraph,
  },
  {
    what: "a key used as an event",
    text: '(event Input|MouseEvents|LeftMouseButton (Key)\n  (Development|PrintString "x"))',
    code: ProblemCode.KeyEvent,
  },
  {
    what: "a function written into the EventGraph",
    text: '(fn HandleDark ()\n  (Development|PrintString "x"))',
    code: ProblemCode.FunctionGraph,
  },
  {
    what: "a guessed setter pin",
    text: "(event EventTick (DeltaSeconds)\n  (Class|CharacterMovementComponent|SetMaxWalkSpeed :self self :NewMaxWalkSpeed 470.0))",
    code: ProblemCode.UnknownPin,
    suggest: "MaxWalkSpeed",
  },
  {
    what: "Math|Integer|Min without its type",
    text: "(event EventTick (DeltaSeconds)\n  (bind m (Math|Integer|Min 1 2)))",
    code: ProblemCode.UnknownNode,
    suggest: "Math|Integer|Min(Integer)",
  },
  {
    what: "ReceiveAnyDamage, the C++ name",
    text: '(event ReceiveAnyDamage\n  (Development|PrintString "x"))',
    code: ProblemCode.UnknownEvent,
    suggest: "Game|Damage|EventAnyDamage",
  },
  {
    what: "another guessed setter pin",
    text: "(event EventTick (DeltaSeconds)\n  (Class|AudioComponent|SetVolumeMultiplier :self (Variables|Default|GetLamp) :NewVolumeMultiplier 1.0))",
    code: ProblemCode.UnknownPin,
    suggest: "VolumeMultiplier",
  },
  {
    what: "an asset path bound to a name",
    text: '(event EventTick (DeltaSeconds)\n  (bind font "/Engine/EngineFonts/Roboto.Roboto"))',
    code: ProblemCode.LiteralBind,
  },
  {
    what: "MakeLinearColor in the wrong category",
    text: "(event EventReceiveDrawHUD (SizeX SizeY)\n  (HUD|DrawRect :RectColor (Math|Color|MakeLinearColor :R 1.0)))",
    decl: HUD,
    code: ProblemCode.UnknownNode,
    suggest: "Utilities|Struct|MakeLinearColor",
  },
  {
    what: "the material collection setter on a material",
    text: '(event EventTick (DeltaSeconds)\n  (Rendering|Material|SetVectorParameterValue :self self :ParameterName "Color"))',
    code: ProblemCode.UnknownPin,
  },
  {
    what: "a sphere radius getter that does not exist",
    text: "(event EventTick (DeltaSeconds)\n  (bind r (Class|SphereComponent|GetSphereRadius :self self)))",
    code: ProblemCode.UnknownNode,
    suggest: "Components|Sphere|GetScaledSphereRadius",
  },
  {
    what: "Normal(Vector), which is Normalize",
    text: "(event EventTick (DeltaSeconds)\n  (bind n (Math|Vector|Normal(Vector) (Transformation|GetActorLocation))))",
    code: ProblemCode.UnknownNode,
    suggest: "Math|Vector|Normalize",
  },
  {
    what: "a function whose graph is another",
    text: '(fn SetAnim ()\n  (Development|PrintString "x"))',
    graph: "HandleDark",
    code: ProblemCode.FunctionGraph,
  },
  {
    what: "an undeclared function parameter",
    text: "(fn Clamp (Value Min)\n  (return Value))",
    graph: "Clamp",
    code: ProblemCode.FunctionParam,
  },
];

test("each common Blueprint mistake is caught before Unreal, with the right suggestion", () => {
  for (const row of MISTAKES) {
    const found = errors(row.text, row.graph, row.decl);
    const hit = found.find((p) => p.code === row.code);
    assert.ok(hit, `${row.what}: expected ${row.code}, got ${JSON.stringify(found.map((p) => p.code))}`);
    if (row.suggest) {
      const said = `${hit.message} ${hit.suggestions.join(" ")}`;
      assert.ok(said.includes(row.suggest), `${row.what}: suggestion ${row.suggest} missing from "${said}"`);
    }
  }
});

test("correct Blueprint text passes: events, functions, continuations, loops and project members", () => {
  const text = [
    "(event EventTick (DeltaSeconds)",
    "  (Rendering|Components|Light|SetIntensity :self (Variables|Default|GetLight) :NewIntensity (Math|Random|RandomFloatinRange 2000.0 5000.0))",
    "  (Variables|Default|SetDt DeltaSeconds)",
    "  (Utilities|IsValid self",
    '    (:"Is Valid" (Development|PrintString "ok"))',
    '    (:"Is Not Valid" (Development|PrintString "no"))))',
    "",
    "(event EventBeginPlay",
    '  (for i (range 3) (Development|PrintString :InString "tick" :Duration 1.0))',
    "  (switch int 2 (:0 (CallFunction|HandleDark)) (:Default)))",
  ].join("\n");
  assert.deepEqual(errors(text), []);
  const hud = [
    "(event EventReceiveDrawHUD (SizeX SizeY)",
    "  (bind st (Utilities|Casting|CastToBP_Wanderer :Object (Game|GetPlayerPawn 0))",
    "    (:then (Class|BPWanderer|SetHealth :self st :Health (- (Class|BPWanderer|GetHealth :self st) 1.0)))",
    "    (:CastFailed)))",
  ].join("\n");
  assert.deepEqual(errors(hud, "EventGraph", HUD), []);
  const after = '(event EventBeginPlay\n  (Utilities|IsValid self (:"Is Valid"))\n  (Development|PrintString "x"))';
  assert.equal(
    errors(after)[0]?.code,
    ProblemCode.Unreachable,
    "a call with exec continuations ends the flow, as in Epic's DSL",
  );
  assert.deepEqual(errors("(fn Clamp (Value)\n  (if (< Value 0.0) (return 0.0) (else (return Value))))", "Clamp"), []);
});

test("a node whose pins are not known yet is checked by name and left unverified, never failed", () => {
  const problems = check(
    "(event EventTick (DeltaSeconds)\n  (Transformation|AddLocalRotation :self self :Whatever 1.0))",
  );
  assert.deepEqual(problems, []);
  const loose = check(
    "(event EventBeginPlay\n  (Utilities|IsValid self (:Valid (Development|PrintString _anything))))",
  );
  assert.ok(loose.some((p) => p.code === ProblemCode.UnknownExecPin && p.severity === Severity.Error));
});

test("scope follows the transpiler: unbound names, rebinding, unreachable code and quoted paths", () => {
  const cases: [string, ProblemCode][] = [
    ["(event EventBeginPlay\n  (Development|PrintString Speed))", ProblemCode.Undefined],
    ["(event EventTick (DeltaSeconds)\n  (bind DeltaSeconds (Transformation|GetActorLocation)))", ProblemCode.Rebind],
    ['(event EventBeginPlay\n  (return)\n  (Development|PrintString "x"))', ProblemCode.Unreachable],
    ["(event EventBeginPlay\n  (Development|PrintString /Game/Thing))", ProblemCode.UnquotedPath],
    ["(event EventBeginPlay\n  (if))", ProblemCode.Shape],
    ["(event EventBeginPlay\n  (break))", ProblemCode.Shape],
    ['(event EventBeginPlay\n  (switch string "a" (:a)))', ProblemCode.Unsupported],
    ['(Development|PrintString "x")', ProblemCode.TopForm],
  ];
  for (const [text, code] of cases)
    assert.ok(
      errors(text).some((p) => p.code === code),
      `${code}: ${text}`,
    );
});

test("a Blueprint's text splits into the EventGraph and one function graph per (fn ...)", () => {
  const text =
    '; header\n(event EventBeginPlay)\n(fn Clamp (Value)\n  (return "(not a form)"))\n(event EventTick (DeltaSeconds))';
  const writes = splitByGraph("BP_Wanderer", text);
  assert.deepEqual(
    writes.map((w) => [w.graph, w.text]),
    [
      [GraphKind.Event, "(event EventBeginPlay)\n\n(event EventTick (DeltaSeconds))"],
      ["Clamp", '(fn Clamp (Value)\n  (return "(not a form)"))'],
    ],
  );
});

test("suggestions prefer the same title, then the same event, then the same category", () => {
  const names = REFERENCE.common;
  assert.equal(suggestNodes("Math|Color|MakeLinearColor", names)[0], "Utilities|Struct|MakeLinearColor");
  assert.equal(suggestNodes("Math|Integer|Min", names)[0], "Math|Integer|Min(Integer)");
  assert.deepEqual(suggestNodes("Nothing|Like|ThisAtAll", names), []);
});
