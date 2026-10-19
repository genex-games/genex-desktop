// The import step's glTF gate (C-6): the Khronos validator runs before any decoder, an error refuses
// the file `validation-failed`, severity is decided by code, and the fallback checks refuse the same
// hostile table.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { IMPORT_DECODERS, IMPORTER_TOOLS_ENV, ImportDecoder } from "../../src/substrate/asset-import/decoders.ts";
import { meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { normalizeGltf } from "../../src/substrate/asset-import/gltf-decompress.ts";
import { GltfImportError } from "../../src/substrate/asset-import/gltf-json.ts";
import { AssetImportRefusal, ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import {
  IMPORT_ISSUES_MAX,
  IMPORT_JOB_VERSION,
  parseImportReceipt,
  parseIssues,
} from "../../src/substrate/asset-import/job.ts";
import {
  accessorReport,
  GltfIssueCode,
  GltfIssueSeverity,
  GltfValidatorEngine,
  gateIssues,
  validateGltf,
} from "../../src/substrate/asset-import/validate.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures poke at untyped glTF JSON.
type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLES = path.join(ROOT, "tests", "fixtures", "asset-previews");
const IMPORT = path.join(ROOT, "tests", "fixtures", "asset-import");
const ENGINES = Object.values(GltfValidatorEngine);

/** A quad: accessor 0 POSITION (4 vertices), accessor 1 its six uint16 indices (view 1). */
function quad(extra: Json = {}): Uint8Array {
  return meshToGlb({
    name: "quad",
    materials: [],
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: Uint32Array.from([0, 1, 2, 2, 1, 3]),
        ...extra,
      },
    ],
  });
}

/** `glb` with its JSON and binary chunk changed by `damage`. */
function damaged(glb: Uint8Array, damage: (json: Json, bin: Uint8Array) => void): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const copy = bin.slice();
  damage(json, copy);
  return writeGlb(json, copy);
}

/** The hostile table: what is wrong, the code both engines name, the file. */
const HOSTILE: Array<[string, string, () => Uint8Array]> = [
  [
    "a primitive attribute naming an accessor that does not exist (the gltf #478 shape)",
    GltfIssueCode.UnresolvedReference,
    () => damaged(quad(), (json) => (json.meshes[0].primitives[0].attributes.POSITION = 99)),
  ],
  [
    "an index past the last vertex",
    GltfIssueCode.AccessorIndexOob,
    () =>
      damaged(quad(), (json, bin) => {
        const view = json.bufferViews[json.accessors[1].bufferView];
        new DataView(bin.buffer).setUint16(view.byteOffset, 9, true);
      }),
  ],
  [
    "a buffer view past its buffer",
    GltfIssueCode.BufferViewTooLong,
    () => damaged(quad(), (json) => (json.bufferViews[1].byteLength = 1 << 20)),
  ],
  [
    "an accessor count of 2^31",
    GltfIssueCode.AccessorTooLong,
    () => damaged(quad(), (json) => (json.accessors[0].count = 2 ** 31)),
  ],
  [
    "an accessor starting past its view",
    GltfIssueCode.AccessorTooLong,
    () => damaged(quad(), (json) => (json.accessors[1].byteOffset = 4096)),
  ],
  [
    "a binary chunk shorter than its buffer",
    GltfIssueCode.BufferByteLengthMismatch,
    () => damaged(quad(), (json) => (json.buffers[0].byteLength += 64)),
  ],
];

async function refusalOf(bytes: Uint8Array, ext = "glb") {
  return await convertAsset({
    converter: ImportConverter.GltfDecompress,
    ext,
    name: "x",
    bytes,
    targets: [BuildTarget.Mac],
  });
}

describe("the glTF validation gate", () => {
  for (const [what, code, file] of HOSTILE) {
    it(`${what} is refused validation-failed, naming ${code}`, async () => {
      const result = await refusalOf(file());
      const seen = result.ok ? "accepted" : `${result.refusal}: ${result.detail}`;
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.ValidationFailed, seen);
      assert.match(!result.ok ? result.detail : "", new RegExp(code));
    });
    it(`the fallback checks refuse ${what} with the same code`, async () => {
      await assert.rejects(validateGltf(file(), "glb", GltfValidatorEngine.Accessors), (error: unknown) => {
        assert.ok(error instanceof GltfImportError);
        assert.equal(error.code, AssetImportRefusal.ValidationFailed);
        assert.match(error.message, new RegExp(code));
        return true;
      });
    });
  }

  it("a refusal names at most eight distinct codes", async () => {
    const many = damaged(quad(), (json) => {
      json.meshes[0].primitives[0].attributes = Object.fromEntries(
        Array.from({ length: 12 }, (_, at) => [`TEXCOORD_${at}`, 50 + at]),
      );
    });
    for (const engine of ENGINES) {
      await assert.rejects(validateGltf(many, "glb", engine), (error: GltfImportError) => {
        assert.ok(error.message.split(", ").length <= 8, error.message);
        return error.code === AssetImportRefusal.ValidationFailed;
      });
    }
  });

  it("a valid KHR_materials_volume file passes both engines and is kept", async () => {
    const glb = damaged(quad(), (json) => {
      json.materials = [
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
          extensions: {
            KHR_materials_transmission: { transmissionFactor: 1 },
            KHR_materials_volume: { thicknessFactor: 0.5, attenuationDistance: 2, attenuationColor: [1, 0.9, 0.8] },
          },
        },
      ];
      json.meshes[0].primitives[0].material = 0;
      json.extensionsUsed = ["KHR_materials_transmission", "KHR_materials_volume"];
    });
    for (const engine of ENGINES) assert.deepEqual(await validateGltf(glb, "glb", engine), [], engine);
    const result = await refusalOf(glb);
    assert.ok(result.ok, JSON.stringify(result));
  });

  it("every importer fixture passes both engines", async () => {
    const files = [
      ...["animated.glb", "compressed.glb", "animated.gltf"].map((name) => path.join(SAMPLES, name)),
      ...["quantized.glb", "quantized.plain.glb", "lods-sphere.glb"].map((name) => path.join(IMPORT, name)),
    ];
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(file));
      for (const engine of ENGINES) await validateGltf(bytes, path.extname(file).slice(1), engine);
    }
  });

  it("a damaged GLB is refused by the gate, not by a decoder", async () => {
    const result = await refusalOf(new Uint8Array(await readFile(path.join(SAMPLES, "broken.glb"))));
    const seen = result.ok ? "accepted" : `${result.refusal}: ${result.detail}`;
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.ValidationFailed, seen);
  });
});

describe("severity by code, never by message", () => {
  const report = (messages: Array<{ code: string; severity: number; message?: string }>) => ({
    issues: { numErrors: messages.filter((m) => m.severity === GltfIssueSeverity.Error).length, messages },
  });

  it("the numeric severity decides, whatever the message says", () => {
    const { errors, warnings } = gateIssues(
      report([
        { code: "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE", severity: 1, message: "fatal error: refuse this file" },
        { code: "NODE_LOOP", severity: 0, message: "just a warning, ignore" },
        { code: "UNUSED_OBJECT", severity: 2, message: "error" },
        { code: "SOMETHING_NEW", severity: 7, message: "info" },
      ]),
    );
    assert.deepEqual(
      errors.map((issue) => issue.code),
      ["NODE_LOOP", "SOMETHING_NEW"],
    );
    assert.deepEqual(
      warnings.map((issue) => issue.code),
      ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"],
    );
  });

  it("an overridden code is a warning whatever its reported severity and message", () => {
    const { errors, warnings } = gateIssues(
      report([{ code: "ACCESSOR_WEIGHTS_NON_NORMALIZED", severity: 0, message: "Error: refuse" }]),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      warnings.map((issue) => [issue.code, issue.severity]),
      [["ACCESSOR_WEIGHTS_NON_NORMALIZED", GltfIssueSeverity.Warning]],
    );
  });

  it("the Khronos validator's non-unit normals are a warning, and the file is imported", async () => {
    const glb = quad({ normals: Float32Array.from([0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2]) });
    const warnings = await validateGltf(glb, "glb", GltfValidatorEngine.Khronos);
    assert.ok(
      warnings.some((issue) => issue.code === "ACCESSOR_VECTOR3_NON_UNIT"),
      JSON.stringify(warnings),
    );
    assert.ok((await refusalOf(glb)).ok);
  });
});

describe("the gate reads nothing beyond the bytes it is given", () => {
  it("an external buffer is a warning, never fetched or read", async () => {
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "https://example.invalid/data.bin", byteLength: 12 }],
        bufferViews: [{ buffer: 0, byteLength: 12 }],
      }),
    );
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched++;
      throw new Error("no network");
    };
    try {
      for (const engine of ENGINES) {
        const warnings = await validateGltf(gltf, "gltf", engine);
        assert.ok(
          warnings.some((issue) => issue.code === GltfIssueCode.IoError),
          `${engine}: ${JSON.stringify(warnings)}`,
        );
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(fetched, 0);
  });

  it("the fallback reports in the Khronos report's shape", () => {
    const { issues } = accessorReport(new TextEncoder().encode("not json"), "gltf");
    assert.equal(issues.numErrors, 1);
    assert.equal(issues.messages[0]?.code, GltfIssueCode.InvalidJson);
  });
});

describe("the gate runs before any decoder", {
  skip: process.platform === "win32" && "child process with POSIX paths",
}, () => {
  it("in an importer whose tools folder holds only the validator, a damaged Draco GLB is refused validation-failed", async () => {
    const tools = await tmpDir("genex-validator-only-");
    for (const file of IMPORT_DECODERS[ImportDecoder.GltfValidator].files) {
      const [folder = "", name = ""] = file.split("/");
      await mkdir(path.join(tools, folder), { recursive: true });
      await writeFile(path.join(tools, file), await readFile(path.join(ROOT, "node_modules", folder, name)));
    }
    const draco = new Uint8Array(await readFile(path.join(SAMPLES, "compressed.glb")));
    const hostile = damaged(draco, (json) => (json.meshes[0].primitives[0].attributes.POSITION = 99));
    const input = path.join(tools, "inputs.json");
    await writeFile(input, JSON.stringify([[...hostile], [...draco]]));
    const probe = [
      `import { readFileSync } from "node:fs";`,
      `import { convertAsset } from ${JSON.stringify(path.join(ROOT, "src/substrate/asset-import/convert.ts"))};`,
      `const files = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"));`,
      `const out = [];`,
      `for (const bytes of files) {`,
      `  const r = await convertAsset({ converter: "gltf-decompress", ext: "glb", name: "x", bytes: Uint8Array.from(bytes), targets: ["macos"] });`,
      `  out.push(r.ok ? "ok" : r.refusal + " " + r.detail);`,
      `}`,
      `console.log(JSON.stringify(out));`,
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...process.env, [IMPORTER_TOOLS_ENV]: tools },
      encoding: "utf8",
    });
    const [hostileResult = "", controlResult = ""] = JSON.parse(output.trim().split("\n").at(-1) ?? "[]") as string[];
    assert.match(hostileResult, /^validation-failed .*UNRESOLVED_REFERENCE/);
    // The control: the same file undamaged reaches the Draco decoder, which this tools folder lacks.
    assert.match(controlResult, /^importer-failed .*draco3dgltf.*missing/);
  });
});

describe("the gate's budget (advisory in lanes)", () => {
  it("validates a 1 MB GLB and records the time", async (t) => {
    const side = 220;
    const positions = new Float32Array(side * side * 3);
    for (let i = 0; i < side * side; i++) positions.set([i % side, Math.floor(i / side), 0], i * 3);
    const indices: number[] = [];
    for (let y = 0; y < side - 1; y++)
      for (let x = 0; x < side - 1; x++) {
        const at = y * side + x;
        indices.push(at, at + 1, at + side, at + side, at + 1, at + side + 1);
      }
    const glb = meshToGlb({
      name: "grid",
      materials: [],
      primitives: [{ positions, indices: Uint32Array.from(indices) }],
    });
    assert.ok(glb.byteLength > 1_000_000, `${glb.byteLength} bytes`);
    await validateGltf(glb, "glb");
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      await validateGltf(glb, "glb");
      times.push(performance.now() - start);
    }
    const fallback = performance.now();
    await validateGltf(glb, "glb", GltfValidatorEngine.Accessors);
    t.diagnostic(
      `${glb.byteLength} bytes: Khronos median ${times.sort((a, b) => a - b)[2]?.toFixed(1)} ms, fallback ${(performance.now() - fallback).toFixed(1)} ms`,
    );
  });

  it("normalizeGltf keeps a valid plain GLB byte for byte behind the gate", async () => {
    const glb = quad();
    assert.deepEqual(await normalizeGltf(glb, "glb"), glb);
  });
});

describe("the validator's warnings in the import receipt", () => {
  it("an imported GLB carries its warnings, by code and pointer", async () => {
    const glb = quad({ normals: Float32Array.from([0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2]) });
    const result = await refusalOf(glb);
    assert.ok(result.ok);
    assert.ok(result.issues?.some((issue) => issue.code === "ACCESSOR_VECTOR3_NON_UNIT" && issue.pointer));
    const entry = {
      index: 0,
      ok: true,
      output: "out/0.glb",
      issues: [{ code: "ACCESSOR_VECTOR3_NON_UNIT", pointer: "/accessors/1" }],
    };
    const receipt = parseImportReceipt({ version: IMPORT_JOB_VERSION, files: [entry] });
    assert.deepEqual(receipt?.files[0], entry);
  });

  const hostile: Array<[string, unknown]> = [
    ["more issues than the cap", Array.from({ length: IMPORT_ISSUES_MAX + 1 }, () => ({ code: "UNUSED_OBJECT" }))],
    ["a code that is message text", [{ code: "This object may be unused." }]],
    ["a pointer longer than the cap", [{ code: "UNUSED_OBJECT", pointer: "/".repeat(257) }]],
    ["an issue that is not an object", ["UNUSED_OBJECT"]],
    ["issues that are not a list", { code: "UNUSED_OBJECT" }],
  ];
  for (const [what, issues] of hostile) {
    it(`a receipt line with ${what} is dropped`, () => {
      assert.equal(parseIssues(issues), null);
      const receipt = parseImportReceipt({
        version: IMPORT_JOB_VERSION,
        files: [{ index: 0, ok: true, output: "out/0.glb", issues }],
      });
      assert.deepEqual(receipt?.files, []);
    });
  }
});
