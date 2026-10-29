/**
 * The Genex Library catalog (`src/shared/genex-library.ts`): the schema the plugin, the pack build
 * and the runtime share. A valid catalog parses; each malformed or hostile row is refused
 * `catalog-invalid` naming its fault; search matches any word; a delivery takes the untiered files
 * and one tier; the delivery folder is the same UUID-shaped name the Rust facade computes; and the
 * shipped catalog itself parses.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  deliveryFiles,
  LIBRARY_BUDGET_TRIANGLES,
  LibraryBudget,
  type LibraryCatalog,
  LibraryError,
  LibraryKind,
  LibraryRefusal,
  LibraryTier,
  libraryFolder,
  packFileName,
  parseLibraryCatalog,
  searchLibrary,
} from "../../src/shared/genex-library.ts";

const SHA = "a".repeat(64);
const MD5 = "b".repeat(32);
const source = (id: string) => ({
  site: "polyhaven",
  id,
  page: `https://polyhaven.com/a/${id}`,
  authors: ["Rob Tuytel"],
});

function material(slug: string, extra: Record<string, unknown> = {}) {
  return {
    id: `material/${slug}`,
    kind: "material",
    name: "Asphalt 02",
    category: "asphalt",
    tags: ["road", "street", "urban"],
    licence: "CC0-1.0",
    source: source(slug),
    material: { tileMetres: 2, tiers: ["2k", "4k"] },
    upstream: [{ role: "diff", tier: "2k", url: "https://dl.polyhaven.org/x.jpg", bytes: 10, md5: MD5 }],
    build: {
      pack: "2026.10.29",
      files: [
        { name: "entry.json", sha256: SHA, bytes: 100 },
        { name: "preview.jpg", sha256: SHA, bytes: 100 },
        { name: "albedo.2k.jpg", tier: "2k", sha256: SHA, bytes: 100 },
        { name: "albedo.2k.ktx2", tier: "2k", sha256: SHA, bytes: 100 },
        { name: "albedo.4k.jpg", tier: "4k", sha256: SHA, bytes: 100 },
      ],
    },
    ...extra,
  };
}

const bench = {
  id: "model/painted_wooden_bench",
  kind: "model",
  name: "Painted Wooden Bench",
  category: "bench",
  tags: ["seat", "park", "street furniture"],
  licence: "CC0-1.0",
  source: source("painted_wooden_bench"),
  model: { budget: "prop", sizeMetres: [1.17, 0.89, 0.5], tier: "2k", sourceTriangles: 630 },
  build: {
    pack: "2026.10.29",
    triangles: 630,
    files: [
      { name: "entry.json", sha256: SHA, bytes: 1 },
      { name: "model.glb", sha256: SHA, bytes: 1 },
    ],
  },
};

const birch = {
  id: "vegetation/birch_winter",
  kind: "vegetation",
  name: "Birch, winter",
  category: "tree",
  tags: ["birch", "tree", "winter", "bare"],
  licence: "CC0-1.0",
  source: { site: "generated", id: "birch-winter", page: "https://genex.games/library", authors: ["Genex"] },
  slot: { generator: "aaa-vegetation", brief: "bare winter birch, 12-18 m", budget: "tree", sizeMetres: [6, 15, 6] },
};

const catalogOf = (...entries: unknown[]) => ({ schema: 1, pack: { version: "2026.10.29", baseUrl: null }, entries });
const valid = (): LibraryCatalog => parseLibraryCatalog(catalogOf(material("asphalt_02"), bench, birch));

function refusedInvalid(value: unknown, fault: RegExp) {
  assert.throws(
    () => parseLibraryCatalog(value),
    (error: unknown) =>
      error instanceof LibraryError && error.code === LibraryRefusal.CatalogInvalid && fault.test(error.message),
  );
}

describe("Genex Library catalog schema", () => {
  it("parses a catalog of a material, a model and an open vegetation slot", () => {
    const catalog = valid();
    assert.deepEqual(
      catalog.entries.map((entry) => entry.kind),
      [LibraryKind.Material, LibraryKind.Model, LibraryKind.Vegetation],
    );
    assert.equal(catalog.pack.baseUrl, null);
  });

  const hostile: Array<[string, unknown, RegExp]> = [
    ["another schema", { ...catalogOf(), schema: 2 }, /schema 2/],
    ["an id that climbs", catalogOf(material("asphalt_02", { id: "material/../x" })), /<kind>\/<slug>/],
    ["an id with a third segment", catalogOf(material("asphalt_02", { id: "material/a/b" })), /<kind>\/<slug>/],
    [
      "an id whose prefix is another kind",
      catalogOf(material("asphalt_02", { id: "model/asphalt_02" })),
      /<kind>\/<slug>/,
    ],
    ["an unknown kind", catalogOf(material("asphalt_02", { kind: "sound" })), /kind/],
    ["a licence that is not CC0", catalogOf(material("asphalt_02", { licence: "CC-BY-4.0" })), /licence/],
    [
      "a page that is not https",
      catalogOf(material("asphalt_02", { source: { ...source("x"), page: "http://polyhaven.com" } })),
      /page/,
    ],
    [
      "a page with credentials",
      catalogOf(material("asphalt_02", { source: { ...source("x"), page: "https://a:b@polyhaven.com" } })),
      /page/,
    ],
    ["no tags", catalogOf(material("asphalt_02", { tags: [] })), /tags/],
    [
      "a material with a model block too",
      catalogOf(material("asphalt_02", { model: bench.model })),
      /exactly its material block/,
    ],
    [
      "tiers out of order",
      catalogOf(material("asphalt_02", { material: { tileMetres: 2, tiers: ["4k", "2k"] } })),
      /tiers/,
    ],
    ["an unknown tier", catalogOf(material("asphalt_02", { material: { tileMetres: 2, tiers: ["8k"] } })), /tiers/],
    [
      "a tile of zero metres",
      catalogOf(material("asphalt_02", { material: { tileMetres: 0, tiers: ["2k"] } })),
      /tileMetres/,
    ],
    [
      "a pack file name that climbs",
      catalogOf(
        material("asphalt_02", {
          build: { pack: "2026.10.29", files: [{ name: "../entry.json", sha256: SHA, bytes: 1 }] },
        }),
      ),
      /name/,
    ],
    [
      "a pack file with a slash",
      catalogOf(
        material("asphalt_02", {
          build: { pack: "2026.10.29", files: [{ name: "a/entry.json", sha256: SHA, bytes: 1 }] },
        }),
      ),
      /name/,
    ],
    [
      "a short sha256",
      catalogOf(
        material("asphalt_02", {
          build: { pack: "2026.10.29", files: [{ name: "entry.json", sha256: "abc", bytes: 1 }] },
        }),
      ),
      /sha256/,
    ],
    [
      "a build without entry.json",
      catalogOf(
        material("asphalt_02", {
          build: { pack: "2026.10.29", files: [{ name: "preview.jpg", sha256: SHA, bytes: 1 }] },
        }),
      ),
      /entry\.json/,
    ],
    [
      "a file listed twice",
      catalogOf(
        material("asphalt_02", {
          build: {
            pack: "2026.10.29",
            files: [
              { name: "entry.json", sha256: SHA, bytes: 1 },
              { name: "entry.json", sha256: SHA, bytes: 1 },
            ],
          },
        }),
      ),
      /twice/,
    ],
    [
      "an upstream md5 of the wrong length",
      catalogOf(
        material("asphalt_02", { upstream: [{ role: "diff", url: "https://dl.polyhaven.org/x", bytes: 1, md5: "x" }] }),
      ),
      /md5/,
    ],
    [
      "an upstream URL that is not https",
      catalogOf(
        material("asphalt_02", { upstream: [{ role: "diff", url: "file:///etc/passwd", bytes: 1, md5: MD5 }] }),
      ),
      /url/,
    ],
    [
      "a model over its budget",
      catalogOf({ ...bench, build: { ...bench.build, triangles: LIBRARY_BUDGET_TRIANGLES[LibraryBudget.Prop] + 1 } }),
      /over its budget/,
    ],
    ["the same id twice", catalogOf(material("asphalt_02"), material("asphalt_02")), /twice/],
    [
      "a published pack on plain http",
      { ...catalogOf(), pack: { version: "2026.10.29", baseUrl: "http://example.com" } },
      /baseUrl/,
    ],
  ];
  for (const [name, value, fault] of hostile) it(`refuses ${name}`, () => refusedInvalid(value, fault));
});

describe("Genex Library search and delivery", () => {
  it("matches any word of the query, best first, and narrows by kind", () => {
    const catalog = valid();
    assert.deepEqual(
      searchLibrary(catalog, { query: "park bench" }).map((hit) => hit.id),
      ["model/painted_wooden_bench"],
    );
    assert.deepEqual(
      searchLibrary(catalog, { query: "winter road" }).map((hit) => hit.id),
      ["vegetation/birch_winter", "material/asphalt_02"],
      "either word finds an entry; a name match (winter) outranks a tag match (road)",
    );
    assert.deepEqual(searchLibrary(catalog, { query: "road", kind: LibraryKind.Model }), []);
    assert.equal(searchLibrary(catalog, { query: "birch" })[0]?.status, "slot-open");
    assert.equal(searchLibrary(catalog, { query: "asph" })[0]?.id, "material/asphalt_02", "a prefix matches");
  });

  it("delivers the untiered files and one tier, 2k by default", () => {
    const catalog = valid();
    const asked = deliveryFiles(catalog, "material/asphalt_02");
    assert.equal(asked.tier, LibraryTier.TwoK);
    assert.deepEqual(
      asked.files.map((file) => file.name),
      ["entry.json", "preview.jpg", "albedo.2k.jpg", "albedo.2k.ktx2"],
    );
    assert.deepEqual(
      deliveryFiles(catalog, "material/asphalt_02", LibraryTier.FourK).files.map((file) => file.name),
      ["entry.json", "preview.jpg", "albedo.4k.jpg"],
    );
    assert.equal(deliveryFiles(catalog, "model/painted_wooden_bench").tier, null);
  });

  const refusals: Array<[string, string, LibraryTier | undefined, LibraryRefusal]> = [
    ["an unknown id", "material/nothing", undefined, LibraryRefusal.UnknownEntry],
    ["an open slot", "vegetation/birch_winter", undefined, LibraryRefusal.SlotOpen],
    ["a tier it lacks", "material/asphalt_02", LibraryTier.OneK, LibraryRefusal.TierUnavailable],
  ];
  for (const [name, id, tier, code] of refusals) {
    it(`refuses ${name} with ${code}`, () => {
      assert.throws(
        () => deliveryFiles(valid(), id, tier),
        (error: unknown) => error instanceof LibraryError && error.code === code,
      );
    });
  }

  it("refuses an entry the pack has not built", () => {
    const { build: _build, ...unbuilt } = material("asphalt_02");
    assert.throws(
      () => deliveryFiles(parseLibraryCatalog(catalogOf(unbuilt)), "material/asphalt_02"),
      (error: unknown) => error instanceof LibraryError && error.code === LibraryRefusal.NotBuilt,
    );
  });

  it("names each entry's delivery folder as the Rust facade does (shared vectors)", () => {
    const vectors: Array<[string, string]> = [
      ["material/asphalt_02", "08082baa-906b-49a8-ea9f-1ff424475e8b"],
      ["model/painted_wooden_bench", "b545ae2d-dfe9-38f7-41af-202237a3a7a6"],
      ["sky/kloofendal_48d_partly_cloudy_puresky", "176302c6-21fa-d28a-0c2a-fdde1a6f8c77"],
      ["vegetation/birch_winter", "931cb11b-235a-f893-bc62-4df34cb900e0"],
    ];
    for (const [id, folder] of vectors) assert.equal(libraryFolder(id), folder);
    assert.match(libraryFolder("material/asphalt_02"), /^[a-f0-9-]{36}$/, "a plugin delivery's job id shape");
    assert.equal(packFileName("material/asphalt_02", "albedo.2k.jpg"), "material.asphalt_02.albedo.2k.jpg");
  });

  it("parses the shipped catalog", async () => {
    const file = path.resolve(import.meta.dirname, "../../src/plugins/library/catalog.json");
    const catalog = parseLibraryCatalog(JSON.parse(await readFile(file, "utf8")));
    assert.ok(catalog.entries.length >= 60, `${catalog.entries.length} entries`);
    const kinds = new Set(catalog.entries.map((entry) => entry.kind));
    assert.deepEqual([...kinds].sort(), Object.values(LibraryKind).sort());
  });
});
