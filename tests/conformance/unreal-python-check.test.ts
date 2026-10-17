/**
 * A part's `apply.py` is checked before the editor queue runs it: parsed by Python (never
 * run), and every `unreal.<Name>` and `unreal.<Class>.<member>` it reads checked against the names
 * the user's own engine exports. Runs with any Python 3 here; the product uses Unreal's own.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { checkPython, PythonProblemCode } from "../../src/plugins/unreal/python-check.ts";
import { tmpDir } from "../helpers/tmp.ts";

function python(): string | undefined {
  try {
    execFileSync("python3", ["-c", "import ast"], { stdio: "ignore" });
    return "python3";
  } catch {
    return undefined;
  }
}
const PYTHON = python();
const skip = !PYTHON || process.platform === "win32" ? "needs python3 (the product uses Unreal's own)" : false;

const NAMES = {
  EditorAssetLibrary: ["delete_directory", "save_directory"],
  Vector: ["x", "y", "z"],
  load_asset: null,
  StaticMeshComponent: ["set_editor_property"],
  Actor: ["get_component_by_class"],
  PrimitiveComponent: ["generate_overlap_events", "set_editor_property"],
};

async function names() {
  const dir = await tmpDir("studio-python-check-");
  const file = path.join(dir, "python-names.json");
  await writeFile(file, JSON.stringify(NAMES));
  return { dir, file };
}

describe("checking a part's apply.py", { skip }, () => {
  it("passes a script whose unreal names all exist, without running it", async () => {
    const { dir, file } = await names();
    const marker = path.join(dir, "ran");
    const source = `import unreal\nopen(${JSON.stringify(marker)}, "w")\nunreal.EditorAssetLibrary.save_directory("/Game/Parts/X")\nv = unreal.Vector(1, 2, 3)\n`;
    const problems = await checkPython({ python: PYTHON ?? "", names: file }, source);
    assert.deepEqual(problems, []);
    assert.equal((await readdir(dir)).includes("ran"), false, "parsed, never run");
  });

  it("names a syntax error with its line", async () => {
    const { file } = await names();
    const problems = await checkPython({ python: PYTHON ?? "", names: file }, "x = 1\nif x\n  pass\n");
    assert.equal(problems[0]?.code, PythonProblemCode.Syntax);
    assert.equal(problems[0]?.line, 2);
  });

  it("names an unreal name the engine doesn't have, with the one it meant", async () => {
    const { file } = await names();
    const source =
      "import unreal\nunreal.EditorAssetLibrary.delete_folder('/Game/X')\nunreal.EditorAssetLib.save_directory('/Game')\n";
    const problems = await checkPython({ python: PYTHON ?? "", names: file }, source);
    assert.deepEqual(
      problems.map((p) => [p.code, p.line, p.suggestions?.[0]]),
      [
        [PythonProblemCode.UnknownName, 2, "delete_directory"],
        [PythonProblemCode.UnknownName, 3, "EditorAssetLibrary"],
      ],
    );
  });

  it("names a method no engine object has, or one the object's own class lacks", async () => {
    const { file } = await names();
    const source = [
      "import unreal",
      "import math",
      "box = actor.get_component_by_class(unreal.StaticMeshComponent)",
      "box.set_generate_overlap_events(True)",
      "mesh = unreal.StaticMeshComponent()",
      'mesh.set_editor_property("x", 1)',
      'thing.save_directory("/Game")',
      "thing.make_it_glow()",
      "math.sqrt(2)",
      "genex.place(unreal.Vector(0, 0, 0))",
      "found = []",
      "found.append(1)",
      "def helper():",
      "    pass",
      "obj.helper()",
      '",".join(["a"])',
      "other = make()",
      "other = unreal.StaticMeshComponent()",
      "other.save_directory('/Game')",
      "import os",
      "os.path.dirname('/Game/x')",
    ].join("\n");
    const problems = await checkPython({ python: PYTHON ?? "", names: file }, source);
    assert.deepEqual(
      problems.map((p) => [p.code, p.line]),
      [
        [PythonProblemCode.UnknownName, 4],
        [PythonProblemCode.UnknownName, 8],
      ],
    );
    assert.match(problems[0]?.message ?? "", /set_generate_overlap_events/);
    assert.match(problems[0]?.message ?? "", /StaticMeshComponent/, "names the class it checked against");
    assert.match(
      problems[0]?.message ?? "",
      /set_editor_property\("generate_overlap_events"/,
      "a property is set with set_editor_property",
    );
  });
});

describe("apply.py's genex calls", { skip }, () => {
  it("knows the genex module's names, its imports among them, before the engine exported any", async () => {
    const source = [
      "bike = genex.import_model('assets/blender/job/model.glb', 'DirtBike')",
      "hum = genex.import_sound('assets/hum.wav', 'Hum')",
      "decal = genex.import_texture('unreal/parts/Bike/decal.png', 'Decal')",
      "genex.place(bike, (0, 0, 0), 'DirtBike_0')",
      "print(genex.part, genex.folder)",
      "genex.save()",
    ].join("\n");
    for (const list of [(await names()).file, null])
      assert.deepEqual(await checkPython({ python: PYTHON ?? "", names: list }, source), [], `names: ${list}`);
  });

  it("names a genex name the module doesn't have, with the one it meant", async () => {
    const { file } = await names();
    const source = "x = 1\nbike = genex.import_mesh('assets/blender/job/model.glb', 'DirtBike')\ngenex.spawn(bike)\n";
    const problems = await checkPython({ python: PYTHON ?? "", names: file }, source);
    assert.deepEqual(
      problems.map((p) => [p.code, p.line, p.suggestions?.[0]]),
      [
        [PythonProblemCode.UnknownName, 2, "import_model"],
        [PythonProblemCode.UnknownName, 3, undefined],
      ],
    );
    assert.match(problems[0]?.message ?? "", /genex\.import_mesh/);
  });
});

describe("apply.py in a game with C++", { skip }, () => {
  it("lets a C++ part's apply.py load its classes, and leaves what they add unverified", async () => {
    const { dir } = await names();
    const file = path.join(dir, "names-with-load-class.json");
    await writeFile(file, JSON.stringify({ ...NAMES, load_class: null }));
    const source = [
      "import unreal",
      "cls = unreal.load_class(None, '/Script/Rush.BikeCamera')",
      "also = unreal.BikeCamera",
      "cdo = unreal.BikeCamera.get_default_object()",
      "bike = genex.place(cls, (0, 0, 0), 'Bike')",
      "bike.set_top_speed(50)",
    ].join("\n");
    const cpp = { module: "Rush", classes: ["BikeCamera", "LapTimer"] };
    const problems = await checkPython({ python: PYTHON ?? "", names: file, cpp }, source);
    assert.deepEqual(
      problems.filter((p) => p.code !== PythonProblemCode.Unverified),
      [],
      JSON.stringify(problems),
    );
    assert.ok(problems.some((p) => p.line === 6 && /set_top_speed/.test(p.message)));
    const blueprintGame = await checkPython({ python: PYTHON ?? "", names: file }, source);
    assert.deepEqual(
      blueprintGame.map((p) => [p.code, p.line]),
      [
        [PythonProblemCode.UnknownName, 3],
        [PythonProblemCode.UnknownName, 4],
        [PythonProblemCode.UnknownName, 6],
      ],
      "without C++ those names don't exist",
    );
  });

  it("leaves a method unverified only on what the parts' own C++ classes made, in a C++ game", async () => {
    const { dir } = await names();
    const file = path.join(dir, "names-with-load-class.json");
    await writeFile(file, JSON.stringify({ ...NAMES, load_class: null }));
    const cpp = { module: "Rush", classes: ["BikeCamera"] };
    const bike = "cls = unreal.load_class(None, '/Script/Rush.BikeCamera')";
    const rows: Array<[string, string[], PythonProblemCode]> = [
      [
        "an object spawned from a loaded C++ class",
        [bike, "b = genex.place(cls, (0, 0, 0), 'Bike')", "b.set_top_speed(5)"],
        PythonProblemCode.Unverified,
      ],
      [
        "a chain of names bound from one",
        [bike, "b = genex.place(cls, (0, 0, 0), 'Bike')", "c = b", "c.set_top_speed(5)"],
        PythonProblemCode.Unverified,
      ],
      ["the C++ class made directly", ["b = unreal.BikeCamera()", "b.set_top_speed(5)"], PythonProblemCode.Unverified],
      [
        "a call made on the spot",
        ["genex.place(unreal.BikeCamera, (0, 0, 0), 'Bike').set_top_speed(5)"],
        PythonProblemCode.Unverified,
      ],
      [
        "an object found some other way",
        ["b = genex.blueprint('BP_Bike', 'Actor')", "b.set_top_sped(5)"],
        PythonProblemCode.UnknownName,
      ],
      ["a name never bound", ["b.set_top_sped(5)"], PythonProblemCode.UnknownName],
      [
        "a class loaded by a path that isn't the parts' C++",
        [
          "cls = unreal.load_class(None, '/Script/Engine.PointLight')",
          "b = genex.place(cls, (0, 0, 0), 'Light')",
          "b.set_intensty(5)",
        ],
        PythonProblemCode.UnknownName,
      ],
      [
        "a class of another module",
        [
          "cls = unreal.load_class(None, '/Script/Other.BikeCamera')",
          "b = genex.place(cls, (0, 0, 0), 'Bike')",
          "b.set_top_speed(5)",
        ],
        PythonProblemCode.UnknownName,
      ],
    ];
    for (const [label, lines, code] of rows) {
      const source = ["import unreal", ...lines].join("\n");
      const problems = await checkPython({ python: PYTHON ?? "", names: file, cpp }, source);
      const last = lines.length + 1;
      assert.deepEqual(
        problems.map((p) => [p.code, p.line]),
        [[code, last]],
        `${label}: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("tells a C++ game's builder that load_class is the reliable way to reach its classes", async () => {
    const { file } = await names();
    const cpp = { module: "Rush", classes: ["BikeCamera"] };
    const problems = await checkPython({ python: PYTHON ?? "", names: file, cpp }, "import unreal\nunreal.BikeCam\n");
    assert.equal(problems[0]?.code, PythonProblemCode.UnknownName);
    assert.match(problems[0]?.message ?? "", /unreal\.load_class\(None, '\/Script\/Rush\.BikeCam'\)/);
  });
});

describe("apply.py before names or Python", { skip }, () => {
  it("only parses when there is no names list yet", async () => {
    const problems = await checkPython({ python: PYTHON ?? "", names: null }, "import unreal\nunreal.Nope.x\n");
    assert.deepEqual(problems, []);
  });

  it("reports a Python that can't run as one problem, not a crash", async () => {
    const dir = await tmpDir("studio-python-missing-");
    await mkdir(dir, { recursive: true });
    const problems = await checkPython({ python: path.join(dir, "no-python"), names: null }, "x = 1\n");
    assert.equal(problems[0]?.code, PythonProblemCode.Unavailable);
  });
});
