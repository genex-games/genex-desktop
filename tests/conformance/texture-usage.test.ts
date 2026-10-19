/**
 * Texture usage resolution (C-10, owner call C1): which usage a loose texture is encoded as, and
 * what decided it, in a fixed order: a genex.toml `[[texture]]` row, then the material slot a
 * model samples it from, then the asset's provenance role, then the kind a Live run observed;
 * otherwise it is not encoded and ships as the source image with `usage-unknown`. A weaker source
 * that disagrees raises `usage-conflict`. A file's name never decides anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAssetLock, resolveAssetLock, serializeAssetLock } from "../../src/main/asset-db.ts";
import { type AssetLockEntry, AssetOrigin, ImportIssueCode, TextureUsageSource } from "../../src/shared/asset-db.ts";
import { TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import {
  gltfImageSlots,
  MaterialSlot,
  mergeImageSlots,
  observedUsages,
  referencedImageSlots,
  resolveTextureUsage,
  resolveTextureUsages,
  type TextureUsageFacts,
  tomlTextureUsages,
  usageLockFacts,
} from "../../src/substrate/asset-import/texture-usage.ts";

const SHA = "a".repeat(64);
const BARK_NORMAL = "assets/textures/bark-normal.png";

describe("texture usage: nothing said, nothing encoded", () => {
  it("leaves assets/textures/bark-normal.png unencoded with usage-unknown when no row, slot, role or observation names it", () => {
    const resolved = resolveTextureUsage({ path: BARK_NORMAL });
    assert.deepEqual(resolved, {
      path: BARK_NORMAL,
      usage: null,
      source: null,
      issues: [{ code: ImportIssueCode.UsageUnknown }],
    });
  });

  it("never reads a usage from a file name: names that say normal, roughness or albedo resolve only from their facts", () => {
    for (const file of [
      "assets/rock_normal.png",
      "assets/T_Rock_N.png",
      "assets/rock-roughness.jpg",
      "assets/albedo.png",
    ]) {
      assert.equal(resolveTextureUsage({ path: file }).usage, null, file);
    }
    const named = resolveTextureUsage({
      path: BARK_NORMAL,
      provenance: { origin: AssetOrigin.Genex, role: "basecolor" },
    });
    assert.equal(named.usage, TextureUsage.Color, "the job's role, not the -normal in the name");
  });

  it("ignores a role its origin does not define, and a role of another origin's vocabulary", () => {
    const facts: TextureUsageFacts[] = [
      { path: BARK_NORMAL, provenance: { origin: AssetOrigin.Genex, role: "sketch" } },
      { path: BARK_NORMAL, provenance: { origin: AssetOrigin.Genex, role: "nor_gl" } },
      { path: BARK_NORMAL, provenance: { origin: AssetOrigin.Cc0, role: "normal" } },
      { path: BARK_NORMAL, provenance: { origin: AssetOrigin.Agent, role: "normal" } },
      { path: BARK_NORMAL, provenance: { origin: AssetOrigin.Cc0, role: "__proto__" } },
      { path: BARK_NORMAL, slots: ["toString", "unknownTexture"] },
    ];
    for (const fact of facts) {
      assert.deepEqual(
        resolveTextureUsage(fact).issues,
        [{ code: ImportIssueCode.UsageUnknown }],
        JSON.stringify(fact),
      );
    }
  });
});

describe("texture usage: the conflict table resolves in order", () => {
  const P = "assets/t.png";
  const genex = (role: string) => ({ origin: AssetOrigin.Genex, role });
  const cc0 = (role: string) => ({ origin: AssetOrigin.Cc0, role });
  const conflict = (detail: string) => ({ code: ImportIssueCode.UsageConflict, detail });
  const rows: Array<{
    name: string;
    facts: Omit<TextureUsageFacts, "path">;
    usage: string;
    source: string;
    issues: object[];
  }> = [
    { name: "a row alone", facts: { toml: TextureUsage.Data }, usage: "data", source: "toml", issues: [] },
    {
      name: "a slot alone",
      facts: { slots: [MaterialSlot.NormalTexture] },
      usage: "normal",
      source: "material-slot",
      issues: [],
    },
    { name: "a role alone", facts: { provenance: cc0("nor_gl") }, usage: "normal", source: "provenance", issues: [] },
    {
      name: "an observation alone",
      facts: { observed: TextureUsage.Color },
      usage: "color",
      source: "observed",
      issues: [],
    },
    {
      name: "every source agreeing",
      facts: {
        toml: TextureUsage.Color,
        slots: [MaterialSlot.BaseColorTexture],
        provenance: cc0("diff"),
        observed: TextureUsage.Color,
      },
      usage: "color",
      source: "toml",
      issues: [],
    },
    {
      name: "a row over a slot",
      facts: { toml: TextureUsage.Data, slots: [MaterialSlot.NormalTexture] },
      usage: "data",
      source: "toml",
      issues: [conflict("material-slot:normal")],
    },
    {
      name: "a slot over a role",
      facts: { slots: [MaterialSlot.NormalTexture], provenance: genex("basecolor") },
      usage: "normal",
      source: "material-slot",
      issues: [conflict("provenance:color")],
    },
    {
      name: "a role over an observation",
      facts: { provenance: cc0("arm"), observed: TextureUsage.Color },
      usage: "data",
      source: "provenance",
      issues: [conflict("observed:color")],
    },
    {
      name: "a row over two weaker sources that disagree with it",
      facts: { toml: TextureUsage.Normal, slots: [MaterialSlot.EmissiveTexture], provenance: cc0("rough") },
      usage: "normal",
      source: "toml",
      issues: [conflict("material-slot:color"), conflict("provenance:data")],
    },
    {
      name: "two slots of one usage (a packed occlusion and metallic-roughness map)",
      facts: { slots: [MaterialSlot.OcclusionTexture, MaterialSlot.MetallicRoughnessTexture] },
      usage: "data",
      source: "material-slot",
      issues: [],
    },
    {
      name: "slots that disagree among themselves: normal, then color, then data, never the order the file lists them",
      facts: {
        slots: [MaterialSlot.BaseColorTexture, MaterialSlot.MetallicRoughnessTexture, MaterialSlot.NormalTexture],
      },
      usage: "normal",
      source: "material-slot",
      issues: [conflict("material-slot:color"), conflict("material-slot:data")],
    },
    {
      name: "an extension slot (clearcoat's normal map) over a role",
      facts: { slots: [MaterialSlot.ClearcoatNormalTexture], provenance: cc0("diff") },
      usage: "normal",
      source: "material-slot",
      issues: [conflict("provenance:color")],
    },
  ];
  for (const row of rows) {
    it(`${row.name}: ${row.usage} from ${row.source}`, () => {
      const resolved = resolveTextureUsage({ path: P, ...row.facts });
      assert.deepEqual(resolved, { path: P, usage: row.usage, source: row.source, issues: row.issues });
    });
  }

  it("is the same answer whatever order the slots come in", () => {
    const slots = [MaterialSlot.MetallicRoughnessTexture, MaterialSlot.NormalTexture, MaterialSlot.BaseColorTexture];
    const first = resolveTextureUsage({ path: P, slots });
    assert.deepEqual(resolveTextureUsage({ path: P, slots: [...slots].reverse() }), first);
  });
});

describe("texture usage: the material slots a glTF samples each image from", () => {
  /** A glTF with two materials over five textures, two images external and two embedded. */
  const gltf = {
    images: [
      { uri: "bark.png" },
      { uri: "../textures/bark%20n.png" },
      { bufferView: 0, mimeType: "image/png" },
      { bufferView: 1, mimeType: "image/webp" },
      { uri: "rough.png" },
    ],
    textures: [
      { source: 0 },
      { source: 1 },
      { source: 2, extensions: { EXT_texture_webp: { source: 3 } } },
      { source: 4 },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 3 } },
        normalTexture: { index: 1 },
        occlusionTexture: { index: 3 },
      },
      {
        emissiveTexture: { index: 2 },
        extensions: { KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 1 } } },
      },
    ],
  };

  it("names every slot of every image, extension slots and extension image sources included", () => {
    const slots = gltfImageSlots(gltf);
    assert.deepEqual(
      [...slots.entries()],
      [
        [0, [MaterialSlot.BaseColorTexture]],
        [1, [MaterialSlot.ClearcoatNormalTexture, MaterialSlot.NormalTexture]],
        [2, [MaterialSlot.EmissiveTexture]],
        [3, [MaterialSlot.EmissiveTexture]],
        [4, [MaterialSlot.MetallicRoughnessTexture, MaterialSlot.OcclusionTexture]],
      ],
    );
  });

  it("resolves the loose files a model references against the model's folder, inside its asset folder", () => {
    const loose = referencedImageSlots("assets/models/tree.gltf", gltf);
    assert.deepEqual(
      [...loose.entries()],
      [
        ["assets/models/bark.png", [MaterialSlot.BaseColorTexture]],
        ["assets/models/rough.png", [MaterialSlot.MetallicRoughnessTexture, MaterialSlot.OcclusionTexture]],
        ["assets/textures/bark n.png", [MaterialSlot.ClearcoatNormalTexture, MaterialSlot.NormalTexture]],
      ],
    );
    const fromPublic = referencedImageSlots("public/assets/tree.gltf", { ...gltf, images: [{ uri: "bark.png" }] });
    assert.deepEqual([...fromPublic.keys()], ["public/assets/bark.png"]);
  });

  // Hostile input: each reference is dropped (no slot reaches any path), and nothing is read.
  const hostileUris: Array<[string, string]> = [
    ["climbing out of the asset folder", "../../index.png"],
    ["climbing out from the asset folder's top", "../../../etc/passwd.png"],
    ["an absolute path", "/etc/x.png"],
    ["a file URL", "file:///etc/x.png"],
    ["an https URL", "https://example.com/x.png"],
    ["a data URI", "data:image/png;base64,AAAA"],
    ["a backslash path", "..\\..\\x.png"],
    ["a NUL byte", "x%00.png"],
    ["an encoded climb", "%2E%2E/%2E%2E/x.png"],
    ["a broken escape", "x%zz.png"],
    ["an empty uri", ""],
    ["a uri of the wrong type", 7 as unknown as string],
  ];
  for (const [name, uri] of hostileUris) {
    it(`drops a reference that is ${name}`, () => {
      const doc = { images: [{ uri }], textures: [{ source: 0 }], materials: [{ normalTexture: { index: 0 } }] };
      assert.equal(referencedImageSlots("assets/models/tree.gltf", doc).size, 0);
    });
  }

  it("drops every reference of a model outside an asset folder", () => {
    assert.equal(referencedImageSlots("src/tree.gltf", gltf).size, 0);
    assert.equal(referencedImageSlots("../assets/tree.gltf", gltf).size, 0);
  });
});

describe("texture usage: a malformed glTF names no slot", () => {
  const hostileDocs: Array<[string, unknown]> = [
    ["not an object", "materials"],
    ["materials of the wrong shape", { materials: { normalTexture: { index: 0 } } }],
    [
      "a texture index past the end",
      { images: [{}], textures: [{ source: 0 }], materials: [{ normalTexture: { index: 4 } }] },
    ],
    [
      "a negative texture index",
      { images: [{}], textures: [{ source: 0 }], materials: [{ normalTexture: { index: -1 } }] },
    ],
    ["a fractional index", { images: [{}], textures: [{ source: 0 }], materials: [{ normalTexture: { index: 0.5 } }] }],
    [
      "an image index past the end",
      { images: [{}], textures: [{ source: 9 }], materials: [{ normalTexture: { index: 0 } }] },
    ],
    [
      "an index as a string",
      { images: [{}], textures: [{ source: "0" }], materials: [{ normalTexture: { index: "0" } }] },
    ],
    [
      "a slot of an unknown extension",
      {
        images: [{}],
        textures: [{ source: 0 }],
        materials: [{ extensions: { X_mine: { normalTexture: { index: 0 } } } }],
      },
    ],
  ];
  for (const [name, doc] of hostileDocs) {
    it(`names no slot for ${name}`, () => {
      assert.equal(gltfImageSlots(doc).size, 0);
    });
  }
});

describe("texture usage: a game's textures, and what the lock records", () => {
  it("merges the slots of every model that references one file, each slot once", () => {
    const merged = mergeImageSlots([
      new Map([["assets/bark.png", [MaterialSlot.NormalTexture]]]),
      new Map([
        ["assets/bark.png", [MaterialSlot.BaseColorTexture, MaterialSlot.NormalTexture]],
        ["assets/a.png", [MaterialSlot.OcclusionTexture]],
      ]),
    ]);
    assert.deepEqual(
      [...merged.entries()],
      [
        ["assets/a.png", [MaterialSlot.OcclusionTexture]],
        ["assets/bark.png", [MaterialSlot.BaseColorTexture, MaterialSlot.NormalTexture]],
      ],
    );
  });

  it("maps [[texture]] rows (under assets/) to the lock's game-relative paths", () => {
    const rows = tomlTextureUsages([
      { path: "textures/flow.png", usage: TextureUsage.Data },
      { path: "ui/badge.webp", usage: TextureUsage.Color },
    ]);
    assert.deepEqual(
      [...rows.entries()],
      [
        ["assets/textures/flow.png", TextureUsage.Data],
        ["assets/ui/badge.webp", TextureUsage.Color],
      ],
    );
  });

  it("resolves every texture of a game from its rows, models, roles and observations", () => {
    const resolved = resolveTextureUsages(
      ["assets/flow.png", "assets/models/bark.png", "assets/sky.png", BARK_NORMAL],
      {
        toml: [{ path: "flow.png", usage: TextureUsage.Data }],
        slots: referencedImageSlots("assets/models/tree.gltf", {
          images: [{ uri: "bark.png" }],
          textures: [{ source: 0 }],
          materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        }),
        provenance: new Map([["assets/models/bark.png", { origin: AssetOrigin.Cc0, role: "nor_gl" }]]),
        observed: new Map([["assets/sky.png", TextureUsage.Color]]),
      },
    );
    assert.deepEqual(
      resolved.map((row) => [row.path, row.usage, row.source, row.issues.map((issue) => issue.code)]),
      [
        ["assets/flow.png", "data", "toml", []],
        ["assets/models/bark.png", "color", "material-slot", ["usage-conflict"]],
        ["assets/sky.png", "color", "observed", []],
        [BARK_NORMAL, null, null, ["usage-unknown"]],
      ],
    );
  });

  it("records the resolved usage and its source in genex-assets.lock, and usage-unknown with no usage", () => {
    const resolved = resolveTextureUsages(["assets/flow.png", BARK_NORMAL], {
      toml: [{ path: "flow.png", usage: TextureUsage.Data }],
      observed: new Map([["assets/flow.png", TextureUsage.Color]]),
    });
    const facts = resolved.map((row) => ({
      path: row.path,
      sha256: SHA,
      kind: "image" as const,
      ...usageLockFacts(row),
    }));
    const { lock } = resolveAssetLock(parseAssetLock(null), facts, { newId: counter() });
    const read = parseAssetLock(serializeAssetLock(lock));
    const byPath = new Map(read.entries.map((entry) => [entry.path, entry]));
    assert.deepEqual(byPath.get("assets/flow.png")?.settings, { usage: "data", usageSource: TextureUsageSource.Toml });
    assert.deepEqual(byPath.get("assets/flow.png")?.issues, [
      { code: ImportIssueCode.UsageConflict, detail: "observed:color" },
    ]);
    assert.deepEqual(byPath.get(BARK_NORMAL)?.settings, {});
    assert.deepEqual(byPath.get(BARK_NORMAL)?.issues, [{ code: ImportIssueCode.UsageUnknown }]);
  });

  it("carries a Live observation the lock recorded into the next import, and nothing a stronger source decided", () => {
    const row = (path: string, usage: string, usageSource: string): AssetLockEntry =>
      ({ path, settings: { usage, usageSource } }) as AssetLockEntry;
    const observed = observedUsages([
      row("assets/sky.png", "color", TextureUsageSource.Observed),
      row("assets/flow.png", "data", TextureUsageSource.Toml),
      row("assets/odd.png", "albedo", TextureUsageSource.Observed),
    ]);
    assert.deepEqual([...observed.entries()], [["assets/sky.png", TextureUsage.Color]]);
  });
});

/** Lock ids `0000000000000001`, `…2`, … so a test's lock is the same every run. */
function counter(): () => string {
  let next = 0;
  return () => (++next).toString(16).padStart(16, "0");
}
