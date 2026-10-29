// The import step's accessor bounds (B8): a GLB merged or edited by hand often keeps the `min`/`max`
// its source declared, or drops them, and the glTF gate then refused the whole file
// (`ACCESSOR_MAX_MISMATCH`), so it left the build without a word. Bounds are a fact of the data:
// the step writes them from the data before the gate, reports the repair as a warning, and leaves
// everything it cannot read (sparse, external, overrunning) to the gate as before.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { importGltf } from "../../src/substrate/asset-import/gltf-decompress.ts";
import { GltfImportError } from "../../src/substrate/asset-import/gltf-json.ts";
import { AssetImportRefusal } from "../../src/substrate/asset-import/import-plan.ts";
import { GltfIssueCode } from "../../src/substrate/asset-import/validate.ts";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures poke at untyped glTF JSON.
type Json = Record<string, any>;

/** A quad: accessor 0 POSITION (4 vertices, x and y 0 to 1), accessor 1 its six indices. */
function quad(): Uint8Array {
  return meshToGlb({
    name: "quad",
    materials: [],
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: Uint32Array.from([0, 1, 2, 2, 1, 3]),
      },
    ],
  });
}

/** `glb` with its JSON and binary chunk changed by `edit`. */
function edited(glb: Uint8Array, edit: (json: Json, bin: Uint8Array) => void): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const copy = bin.slice();
  edit(json, copy);
  return writeGlb(json, copy);
}

/** A quad with a one-channel animation whose key times (accessor 2) say nothing of their bounds. */
function animated(): Uint8Array {
  const { json, bin } = readGlb(quad()) as { json: Json; bin: Uint8Array };
  const times = Float32Array.from([0, 0.5, 1.25]);
  const values = Float32Array.from([0, 0, 0, 0, 1, 0, 0, 2, 0]);
  const grown = new Uint8Array(bin.byteLength + times.byteLength + values.byteLength);
  grown.set(bin);
  grown.set(new Uint8Array(times.buffer), bin.byteLength);
  grown.set(new Uint8Array(values.buffer), bin.byteLength + times.byteLength);
  json.buffers[0].byteLength = grown.byteLength;
  json.bufferViews.push({ buffer: 0, byteOffset: bin.byteLength, byteLength: times.byteLength });
  json.bufferViews.push({ buffer: 0, byteOffset: bin.byteLength + times.byteLength, byteLength: values.byteLength });
  const views = json.bufferViews.length;
  json.accessors.push({ bufferView: views - 2, componentType: 5126, count: 3, type: "SCALAR" });
  json.accessors.push({ bufferView: views - 1, componentType: 5126, count: 3, type: "VEC3" });
  const keys = json.accessors.length;
  json.animations = [
    {
      name: "Bob",
      samplers: [{ input: keys - 2, output: keys - 1, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
    },
  ];
  return writeGlb(json, grown);
}

const accessorsOf = (glb: Uint8Array): Json[] => (readGlb(glb).json as Json).accessors;

async function refusal(bytes: Uint8Array): Promise<GltfImportError> {
  try {
    await importGltf(bytes, "glb");
  } catch (error) {
    assert.ok(error instanceof GltfImportError, String(error));
    return error;
  }
  assert.fail("the file was imported");
}

describe("accessor bounds are written from the data at import", () => {
  it("a POSITION max the data disagrees with is rewritten, and the repair is a warning at that accessor", async () => {
    const stale = edited(quad(), (json) => {
      json.accessors[0].max = [5, 5, 5];
    });
    const imported = await importGltf(stale, "glb");
    assert.deepEqual(accessorsOf(imported.bytes)[0].max, [1, 1, 0]);
    assert.deepEqual(accessorsOf(imported.bytes)[0].min, [0, 0, 0]);
    assert.ok(
      imported.issues.some((issue) => issue.code === GltfIssueCode.BoundsRepaired && issue.pointer === "/accessors/0"),
      JSON.stringify(imported.issues),
    );
  });

  it("a POSITION accessor without bounds gets them", async () => {
    const bare = edited(quad(), (json) => {
      delete json.accessors[0].min;
      delete json.accessors[0].max;
    });
    const imported = await importGltf(bare, "glb");
    assert.deepEqual(accessorsOf(imported.bytes)[0].max, [1, 1, 0]);
  });

  it("an animation's key times without bounds get them (a hand-merged clip)", async () => {
    const merged = animated();
    const imported = await importGltf(merged, "glb");
    const keys = accessorsOf(imported.bytes)[2];
    assert.deepEqual([keys.min, keys.max], [[0], [1.25]]);
  });

  it("a file whose bounds hold is kept byte for byte, with no repair issue", async () => {
    const valid = quad();
    const imported = await importGltf(valid, "glb");
    assert.deepEqual(imported.bytes, valid);
    assert.ok(!imported.issues.some((issue) => issue.code === GltfIssueCode.BoundsRepaired));
  });
});

describe("what the repair cannot read is left to the gate", () => {
  const hostile: Array<[string, (json: Json) => void]> = [
    [
      "an accessor whose view ends past the BIN chunk",
      (json) => {
        json.accessors[0].max = [5, 5, 5];
        json.bufferViews[json.accessors[0].bufferView].byteLength = 1 << 20;
      },
    ],
    [
      "an accessor that names a view that does not exist",
      (json) => {
        json.accessors[0].max = [5, 5, 5];
        json.accessors[0].bufferView = 99;
      },
    ],
    [
      "a sparse accessor with wrong bounds",
      (json) => {
        json.accessors[0].max = [5, 5, 5];
        json.accessors[0].sparse = {
          count: 1,
          indices: { bufferView: 1, componentType: 5125 },
          values: { bufferView: 0 },
        };
      },
    ],
  ];
  for (const [what, edit] of hostile) {
    it(`${what} is still refused validation-failed`, async () => {
      const error = await refusal(edited(quad(), edit));
      assert.equal(error.code, AssetImportRefusal.ValidationFailed, error.message);
    });
  }
});
