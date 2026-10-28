// The interior kit the Rust template ships (`src/game-template-rust/docs/examples/interior-kit/assets/kit/`):
// every GLB passes Studio's import gate, holds one mesh with one material named for its role and no
// texture of its own, each coarser level keeps its piece's part count with fewer triangles, and the
// whole kit stays small enough to ride in every Rust game folder.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { readGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";

const KIT = fileURLToPath(
  new URL("../../src/game-template-rust/docs/examples/interior-kit/assets/kit/", import.meta.url),
);
/** The roles a piece's one material is named for; the game gives each its own material. */
const ROLES = new Set(["plaster", "paint", "concrete", "trim", "props", "glass", "tube"]);
/** The most the kit may weigh: it is copied into every Rust game folder. */
const KIT_BYTES_MAX = 1_500_000;
/** The coarser level's suffix. */
const LOD = "-lod1";

// biome-ignore lint/suspicious/noExplicitAny: the test reads untyped glTF JSON.
type Json = Record<string, any>;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}

const glbs = (): string[] => files(KIT).filter((file) => file.endsWith(".glb"));
const doc = (file: string): Json => readGlb(readFileSync(file)).json as Json;

/** A GLB's parts (primitives) and triangles, from its accessors. */
function counts(json: Json): { parts: number; triangles: number } {
  const primitives = json.meshes.flatMap((mesh: Json) => mesh.primitives);
  const triangles = primitives.reduce(
    (sum: number, primitive: Json) => sum + json.accessors[primitive.indices].count / 3,
    0,
  );
  return { parts: primitives.length, triangles };
}

describe("the interior kit", () => {
  it("ships its pieces, sheets and decals", () => {
    const names = files(KIT).map((file) => path.relative(KIT, file));
    assert.ok(glbs().length >= 40, `${glbs().length} pieces`);
    for (const sheet of ["trim", "props"])
      for (const map of ["color", "normal", "orm"])
        assert.ok(names.includes(`${sheet}_${map}.jpg`), `${sheet}_${map}.jpg`);
    for (const decal of ["peel_edge", "peel_patch", "crack", "leak", "grime_base"])
      assert.ok(names.includes(path.join("decals", `${decal}.png`)), `decals/${decal}.png`);
  });

  it(`weighs at most ${KIT_BYTES_MAX} bytes, every texture a JPEG or a PNG (the formats the native renderer decodes)`, () => {
    const all = files(KIT);
    const bytes = all.reduce((sum, file) => sum + statSync(file).size, 0);
    assert.ok(bytes <= KIT_BYTES_MAX, `${bytes} bytes`);
    for (const file of all) assert.match(path.basename(file), /\.(glb|jpg|png)$/, file);
  });

  it("passes Studio's import gate, piece by piece", async () => {
    for (const file of glbs()) {
      const result = await convertAsset({
        converter: ImportConverter.GltfDecompress,
        ext: "glb",
        name: path.basename(file, ".glb"),
        bytes: Uint8Array.from(readFileSync(file)),
        targets: [BuildTarget.Mac],
      });
      assert.ok(result.ok, `${path.basename(file)}: ${result.ok ? "" : `${result.refusal} ${result.detail}`}`);
      assert.deepEqual(result.issues ?? [], [], `${path.basename(file)} has validator warnings`);
    }
  });

  it("gives each piece one mesh with one material named for its role, and no texture of its own", () => {
    for (const file of glbs()) {
      const json = doc(file);
      const name = path.basename(file);
      assert.equal(json.meshes.length, 1, `${name}: one mesh`);
      assert.equal(json.materials?.length, 1, `${name}: one material`);
      assert.ok(ROLES.has(json.materials[0].name), `${name}: role ${json.materials[0].name}`);
      assert.equal(json.images, undefined, `${name} carries no image: the game gives its material`);
    }
  });

  it("keeps each coarser level's part count and role, with fewer triangles", () => {
    const levels = glbs().filter((file) => file.endsWith(`${LOD}.glb`));
    assert.ok(levels.length >= 5, `${levels.length} coarser levels`);
    for (const level of levels) {
      const base = level.replace(`${LOD}.glb`, ".glb");
      const [fine, coarse] = [doc(base), doc(level)];
      assert.equal(
        counts(coarse).parts,
        counts(fine).parts,
        `${path.basename(level)}: Model::with_levels needs the same parts`,
      );
      assert.equal(coarse.materials[0].name, fine.materials[0].name, path.basename(level));
      assert.ok(counts(coarse).triangles < counts(fine).triangles, `${path.basename(level)} is coarser`);
    }
  });
});
