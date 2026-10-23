/**
 * The bundled CC0 library plugin (`src/plugins/cc0/`, C-22): `cc0__fetch` turns a Poly Haven model
 * into one self-contained GLB plus the maps asked for, delivers them through `assets.deliver` and
 * records CC0 provenance whose lock rows carry the licence and each map's role; a curated row is
 * delivered by its sha256 pin; a URL on a host off the allowlist is refused before any download;
 * a sha256 mismatch writes nothing. The network is a stub here, and the delivery is the host's own
 * `deliverAssetFiles` into a temporary game.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { zipSync } from "fflate";
import { type AssetLockFacts, AssetLockState, resolveAssetLock } from "../../src/main/asset-db.ts";
import { createCc0Plugin, Cc0Tool } from "../../src/plugins/cc0/backend.ts";
import type { CuratedManifest } from "../../src/plugins/cc0/curated.ts";
import { packGlb } from "../../src/plugins/cc0/glb.ts";
import {
  API_HOSTS,
  CC0_USER_AGENT,
  type Cc0Net,
  CURATED_HOSTS,
  createCc0Net,
  DOWNLOAD_HOSTS,
  FETCH_HOSTS,
  REDIRECT_HOSTS,
} from "../../src/plugins/cc0/net.ts";
import { type Cc0Delivery, cc0LockFacts } from "../../src/plugins/cc0/provenance.ts";
import { AssetLicence, AssetOrigin, TextureUsageSource } from "../../src/shared/asset-db.ts";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { md5, sha256 } from "../../src/substrate/cc0-fetch.ts";
import { deliverAssetFiles } from "../../src/substrate/genex-delivery.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "../../src/plugins/cc0");
const encode = (text: string) => new TextEncoder().encode(text);

const BIN = new Uint8Array(48).map((_, i) => i);
const DIFF = encode("a colour map ".repeat(40));
const NOR = encode("a normal map ".repeat(30));
const ARM = encode("an arm map ".repeat(20));
const GLTF = encode(
  JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "wooden_crate.bin", byteLength: BIN.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }],
    images: [
      { uri: "textures/wooden_crate_diff_1k.jpg" },
      { uri: "textures/wooden_crate_nor_gl_1k.jpg" },
      { uri: "textures/wooden_crate_arm_1k.jpg" },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
  }),
);
const PH = "https://dl.polyhaven.org/file/ph-assets/Models";
const file = (bytes: Uint8Array, url: string) => ({ size: bytes.byteLength, url, md5: md5(bytes) });

/** Poly Haven's `/files/wooden_crate` in its real shape (trimmed to what a 1k fetch reads). */
function polyHavenFiles(overrides: { diffUrl?: string } = {}) {
  const diffUrl = overrides.diffUrl ?? `${PH}/jpg/1k/wooden_crate/wooden_crate_diff_1k.jpg`;
  return {
    Diffuse: { "1k": { jpg: file(DIFF, diffUrl) } },
    nor_gl: { "1k": { jpg: file(NOR, `${PH}/jpg/1k/wooden_crate/wooden_crate_nor_gl_1k.jpg`) } },
    arm: { "1k": { jpg: file(ARM, `${PH}/jpg/1k/wooden_crate/wooden_crate_arm_1k.jpg`) } },
    gltf: {
      "1k": {
        gltf: {
          ...file(GLTF, `${PH}/gltf/1k/wooden_crate/wooden_crate_1k.gltf`),
          include: {
            "wooden_crate.bin": file(BIN, `${PH}/gltf/8k/wooden_crate/wooden_crate.bin`),
            "textures/wooden_crate_diff_1k.jpg": file(DIFF, diffUrl),
            "textures/wooden_crate_nor_gl_1k.jpg": file(NOR, `${PH}/jpg/1k/wooden_crate/wooden_crate_nor_gl_1k.jpg`),
            "textures/wooden_crate_arm_1k.jpg": file(ARM, `${PH}/jpg/1k/wooden_crate/wooden_crate_arm_1k.jpg`),
          },
        },
      },
    },
  };
}

const INFO = { name: "Wooden Crate", type: 2, authors: { "James Ray Cock": "All" }, polycount: 6576 };

/** A stub network: JSON by URL and bytes by URL, recording every URL it was asked for. */
function stubNet(json: Record<string, unknown>, bytes: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const net: Cc0Net = {
    async json(url) {
      asked.push(url.href);
      if (!(url.href in json)) throw new Error(`no stub JSON for ${url.href}`);
      return json[url.href];
    },
    async download(url) {
      asked.push(url.href);
      const body = bytes[url.href];
      if (!body) throw new Error(`no stub bytes for ${url.href}`);
      return body;
    },
  };
  return { net, asked };
}

function polyHavenBytes(): Record<string, Uint8Array> {
  const files = polyHavenFiles();
  const gltf = files.gltf["1k"].gltf;
  const all: Record<string, Uint8Array> = { [gltf.url]: GLTF };
  const byName: Record<string, Uint8Array> = {
    "wooden_crate.bin": BIN,
    "textures/wooden_crate_diff_1k.jpg": DIFF,
    "textures/wooden_crate_nor_gl_1k.jpg": NOR,
    "textures/wooden_crate_arm_1k.jpg": ARM,
  };
  for (const [name, entry] of Object.entries(gltf.include)) all[entry.url] = byName[name] as Uint8Array;
  return all;
}

/** A host that answers the services the plugin calls: storage, the real delivery, a jobs store. */
async function fakeHost() {
  const game = await tmpDir("cc0-game-");
  const storage = await tmpDir("cc0-storage-");
  const jobs = new Map<string, unknown>();
  const delivered: string[][] = [];
  const ctx: PluginContext = {
    project: "crate-game",
    directory: game,
    stack: "rust-wgpu",
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string, args: Record<string, unknown>) => {
      if (method === "storage.root") return storage;
      if (method === "assets.deliver") {
        const files = await deliverAssetFiles(String(args.output), game, String(args.jobId), "cc0", {
          reuseExisting: true,
        });
        delivered.push(files);
        return files;
      }
      if (method === "jobs.write") {
        jobs.set(String(args.id), args.value);
        return true;
      }
      if (method === "jobs.read") return jobs.get(String(args.id)) ?? null;
      throw new Error(`unexpected host call ${method}`);
    }) as PluginContext["host"],
  };
  return { game, storage, jobs, delivered, ctx };
}

async function call(
  plugin: ReturnType<typeof createCc0Plugin>,
  tool: string,
  args: Record<string, PluginScalar>,
  ctx: PluginContext,
) {
  const activation = await plugin;
  assert.ok(activation.tool);
  return activation.tool(tool, args, ctx) as Promise<Record<string, unknown>>;
}

const FILES_URL = "https://api.polyhaven.com/files/wooden_crate";
const INFO_URL = "https://api.polyhaven.com/info/wooden_crate";

async function nothingWritten(host: Awaited<ReturnType<typeof fakeHost>>) {
  assert.equal(existsSync(path.join(host.game, "assets")), false, "nothing reached the game");
  assert.equal(host.jobs.size, 0, "no record was kept");
  assert.deepEqual(host.delivered, []);
  const left = await readdir(path.join(host.storage, "jobs")).catch(() => []);
  assert.deepEqual(left, [], "no job folder was left in storage");
}

describe("cc0__fetch from Poly Haven", () => {
  it("delivers a self-contained GLB plus the maps asked for, with CC0 lock rows and roles", async () => {
    const host = await fakeHost();
    const { net, asked } = stubNet({ [FILES_URL]: polyHavenFiles(), [INFO_URL]: INFO }, polyHavenBytes());
    const result = await call(
      createCc0Plugin({ net }),
      Cc0Tool.Fetch,
      { source: "polyhaven", id: "wooden_crate", resolution: "1k", maps: "diff,nor_gl,arm" },
      host.ctx,
    );
    assert.equal(new Set(asked).size, asked.length, "each map is downloaded once, though the GLB embeds it too");
    const jobId = String(result.jobId);
    const folder = `assets/cc0/${jobId}`;
    const files = result.files as Array<{ path: string; map: string; sha256: string }>;
    assert.deepEqual(
      files.map((f) => [f.path, f.map]),
      [
        [`${folder}/wooden_crate_1k.glb`, "model"],
        [`${folder}/wooden_crate_diff_1k.jpg`, "diff"],
        [`${folder}/wooden_crate_nor_gl_1k.jpg`, "nor_gl"],
        [`${folder}/wooden_crate_arm_1k.jpg`, "arm"],
      ],
    );
    assert.equal(result.licence, "CC0-1.0");
    assert.equal(result.credit, "Powered by Poly Haven");

    const glb = new Uint8Array(await readFile(path.join(host.game, folder, "wooden_crate_1k.glb")));
    assert.equal(new TextDecoder().decode(glb.subarray(0, 4)), "glTF");
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
    );
    assert.equal(json.buffers.length, 1);
    assert.equal(json.buffers[0].uri, undefined, "the buffer is the GLB's own");
    assert.ok(json.images.every((image: { uri?: string; bufferView?: number }) => image.uri === undefined));
    assert.deepEqual(
      json.images.map((image: { mimeType: string }) => image.mimeType),
      ["image/jpeg", "image/jpeg", "image/jpeg"],
    );
    assert.deepEqual(new Uint8Array(await readFile(path.join(host.game, folder, "wooden_crate_diff_1k.jpg"))), DIFF);

    const record = host.jobs.get(jobId) as Cc0Delivery;
    assert.equal(record.licence, "CC0-1.0");
    assert.deepEqual(record.authors, ["James Ray Cock"]);
    const facts: AssetLockFacts[] = cc0LockFacts(record);
    const { lock } = resolveAssetLock(
      { state: AssetLockState.Missing, text: null, entries: [], derived: [], ignored: [] },
      facts,
      {
        newId: (() => {
          let n = 0;
          return () => (n++).toString(16).padStart(16, "0");
        })(),
      },
    );
    const byPath = new Map(lock.entries.map((row) => [row.path, row]));
    for (const row of lock.entries) {
      assert.equal(row.origin, AssetOrigin.Cc0);
      assert.equal(row.licence, AssetLicence.Cc0);
      assert.equal(row.source?.page, "https://polyhaven.com/a/wooden_crate");
      assert.deepEqual(row.source?.authors, ["James Ray Cock"]);
    }
    assert.deepEqual(byPath.get(`${folder}/wooden_crate_diff_1k.jpg`)?.settings, {
      usage: "color",
      usageSource: TextureUsageSource.Provenance,
    });
    assert.equal(byPath.get(`${folder}/wooden_crate_nor_gl_1k.jpg`)?.settings.usage, "normal");
    assert.equal(byPath.get(`${folder}/wooden_crate_arm_1k.jpg`)?.settings.usage, "data");
    assert.equal(byPath.get(`${folder}/wooden_crate_1k.glb`)?.kind, "model");
    assert.equal(byPath.get(`${folder}/wooden_crate_1k.glb`)?.sha256, sha256(glb));
  });

  it("delivers the GLB alone when no maps are asked for, and a repeat fetch lands in the same folder", async () => {
    const host = await fakeHost();
    const { net } = stubNet({ [FILES_URL]: polyHavenFiles(), [INFO_URL]: INFO }, polyHavenBytes());
    const plugin = createCc0Plugin({ net });
    const args = { source: "polyhaven", id: "wooden_crate", resolution: "1k" };
    const first = await call(plugin, Cc0Tool.Fetch, args, host.ctx);
    const second = await call(plugin, Cc0Tool.Fetch, args, host.ctx);
    assert.equal(first.jobId, second.jobId);
    assert.deepEqual(
      (first.files as Array<{ map: string }>).map((f) => f.map),
      ["model"],
    );
  });

  it("refuses a URL on a host off the allowlist before downloading anything", async () => {
    const host = await fakeHost();
    const evil = "https://evil.example/wooden_crate_diff_1k.jpg";
    const { net, asked } = stubNet(
      { [FILES_URL]: polyHavenFiles({ diffUrl: evil }), [INFO_URL]: INFO },
      polyHavenBytes(),
    );
    await assert.rejects(
      call(
        createCc0Plugin({ net }),
        Cc0Tool.Fetch,
        { source: "polyhaven", id: "wooden_crate", resolution: "1k", maps: "diff" },
        host.ctx,
      ),
      /host-not-allowed/,
    );
    assert.ok(
      asked.every((url) => !url.startsWith("https://dl.polyhaven.org")),
      "no download started",
    );
    assert.ok(!asked.includes(evil));
    await nothingWritten(host);
  });

  it("refuses an id that is not a plain name and a resolution it does not offer, asking nothing", async () => {
    const host = await fakeHost();
    const { net, asked } = stubNet({}, {});
    const hostile: Array<Record<string, PluginScalar>> = [
      { source: "polyhaven", id: "../etc", resolution: "1k" },
      { source: "polyhaven", id: "wooden_crate", resolution: "16k" },
      { source: "elsewhere", id: "wooden_crate", resolution: "1k" },
      { source: "polyhaven", id: "wooden_crate", resolution: "1k", maps: "diff,../x" },
      { source: "polyhaven", id: "wooden_crate", resolution: 1 },
      { source: "curated", id: "Wooden Crate" },
    ];
    for (const args of hostile) {
      await assert.rejects(call(createCc0Plugin({ net }), Cc0Tool.Fetch, args, host.ctx));
    }
    assert.deepEqual(asked, []);
    await nothingWritten(host);
  });
});

const UAL_GLB = encode("glTF-the-universal-animation-library");
const UAL_URL = "https://dl.polyhaven.org/file/curated/UAL_Standard.glb";
function curated(sha: string): CuratedManifest {
  return {
    assets: [
      {
        id: "quaternius-ual",
        kind: "model",
        licence: "CC0-1.0",
        page: "https://quaternius.com/packs/universalanimationlibrary.html",
        authors: ["Quaternius"],
        files: [{ name: "UAL_Standard.glb", url: UAL_URL, bytes: UAL_GLB.byteLength, sha256: sha, map: "model" }],
      },
    ],
    held: [],
  };
}

describe("cc0__fetch from the curated manifest", () => {
  it("delivers a curated row's rigged GLB by its sha256 pin", async () => {
    const host = await fakeHost();
    const { net } = stubNet({}, { [UAL_URL]: UAL_GLB });
    const result = await call(
      createCc0Plugin({ net, curated: curated(sha256(UAL_GLB)) }),
      Cc0Tool.Fetch,
      { source: "curated", id: "quaternius-ual" },
      host.ctx,
    );
    const [only] = result.files as Array<{ path: string; sha256: string }>;
    assert.equal(only?.sha256, sha256(UAL_GLB));
    assert.deepEqual(new Uint8Array(await readFile(path.join(host.game, only?.path ?? ""))), UAL_GLB);
    assert.equal(result.credit, undefined, "only Poly Haven's live results carry its credit");
  });

  it("writes nothing when the bytes differ from the sha256 pin", async () => {
    const host = await fakeHost();
    const { net } = stubNet({}, { [UAL_URL]: UAL_GLB });
    await assert.rejects(
      call(
        createCc0Plugin({ net, curated: curated("0".repeat(64)) }),
        Cc0Tool.Fetch,
        { source: "curated", id: "quaternius-ual" },
        host.ctx,
      ),
      /hash-mismatch/,
    );
    await nothingWritten(host);
  });

  it("answers a held row with its typed reason and fetches nothing", async () => {
    const host = await fakeHost();
    const { net, asked } = stubNet({}, {});
    const manifest: CuratedManifest = { assets: [], held: [{ id: "kenney-prototype-kit", reason: "zip-nested" }] };
    await assert.rejects(
      call(
        createCc0Plugin({ net, curated: manifest }),
        Cc0Tool.Fetch,
        { source: "curated", id: "kenney-prototype-kit" },
        host.ctx,
      ),
      /curated-held: kenney-prototype-kit zip-nested/,
    );
    assert.deepEqual(asked, []);
    await nothingWritten(host);
  });

  it("ships a curated manifest whose rows are CC0, pinned and on the allowlist", async () => {
    const { CURATED } = await import("../../src/plugins/cc0/curated.ts");
    for (const asset of CURATED.assets) {
      assert.equal(asset.licence, "CC0-1.0");
      for (const entry of asset.files) {
        assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        assert.ok(FETCH_HOSTS.has(new URL(entry.url).hostname), entry.url);
      }
    }
  });
});

describe("cc0__fetch from ambientCG", () => {
  it("unpacks the maps of a material's zip under Poly Haven's role names", async () => {
    const host = await fakeHost();
    const zip = zipSync({
      "Bricks076C_1K-JPG_Color.jpg": DIFF,
      "Bricks076C_1K-JPG_NormalGL.jpg": NOR,
      "Bricks076C_1K-JPG_NormalDX.jpg": NOR,
      "Bricks076C_1K-JPG_Roughness.jpg": ARM,
      "Bricks076C_1K-JPG.usdc": BIN,
    });
    const zipUrl = "https://ambientcg.com/get?file=Bricks076C_1K-JPG.zip";
    const listing = {
      foundAssets: [
        {
          assetId: "Bricks076C",
          dataType: "Material",
          displayName: "Bricks 076 C",
          downloadFolders: {
            default: {
              downloadFiletypeCategories: {
                zip: {
                  downloads: [
                    {
                      fullDownloadPath: zipUrl,
                      fileName: "Bricks076C_1K-JPG.zip",
                      size: zip.byteLength,
                      attribute: "1K-JPG",
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    };
    const { net } = stubNet(
      { "https://ambientcg.com/api/v2/full_json?id=Bricks076C&include=downloadData": listing },
      { [zipUrl]: zip },
    );
    const result = await call(
      createCc0Plugin({ net }),
      Cc0Tool.Fetch,
      { source: "ambientcg", id: "Bricks076C", resolution: "1k" },
      host.ctx,
    );
    assert.deepEqual(
      (result.files as Array<{ path: string; map: string }>).map((f) => [path.posix.basename(f.path), f.map]),
      [
        ["Bricks076C_1K-JPG_Color.jpg", "diff"],
        ["Bricks076C_1K-JPG_NormalGL.jpg", "nor_gl"],
        ["Bricks076C_1K-JPG_Roughness.jpg", "rough"],
      ],
    );
    assert.equal(result.credit, undefined);
  });
});

describe("cc0__search", () => {
  it("lists Poly Haven models matching the query, most downloaded first, with the credit line", async () => {
    const host = await fakeHost();
    const { net } = stubNet(
      {
        "https://api.polyhaven.com/assets?t=models": {
          wooden_crate_01: {
            name: "Wooden Crate 01",
            type: 2,
            tags: ["crate"],
            categories: ["containers"],
            download_count: 9,
            polycount: 6576,
            dimensions: [825, 408, 349],
            authors: { "James Ray Cock": "All" },
          },
          wooden_crate_02: {
            name: "Wooden Crate 02",
            type: 2,
            tags: ["crate"],
            categories: ["containers"],
            download_count: 20,
            polycount: 3000,
            authors: { Someone: "All" },
          },
          barrel_01: {
            name: "Barrel",
            type: 2,
            tags: ["barrel"],
            categories: ["containers"],
            download_count: 99,
            authors: { Someone: "All" },
          },
        },
      },
      {},
    );
    const result = await call(
      createCc0Plugin({ net }),
      Cc0Tool.Search,
      { query: "crate", kind: "model", limit: 5 },
      host.ctx,
    );
    assert.deepEqual(
      (result.results as Array<{ id: string }>).map((r) => r.id),
      ["wooden_crate_02", "wooden_crate_01"],
    );
    assert.equal(result.credit, "Powered by Poly Haven");
  });
});

describe("the CC0 plugin's network and package", () => {
  it("declares exactly the hosts it reaches, and names itself with its manifest's version", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(path.join(PLUGIN_DIR, "plugin.json"), "utf8")));
    assert.deepEqual(
      new Set(manifest.network?.hosts),
      new Set([...API_HOSTS, ...DOWNLOAD_HOSTS, ...CURATED_HOSTS, ...REDIRECT_HOSTS]),
    );
    assert.ok(CC0_USER_AGENT.startsWith(`Genex-CC0/${manifest.version} `));
    assert.deepEqual(
      manifest.tools.map((tool) => tool.name),
      [Cc0Tool.Search, Cc0Tool.Fetch],
    );
    assert.ok(
      manifest.tools.every((tool) => tool.confirmation === undefined),
      "a CC0 fetch spends nothing",
    );
  });

  it("follows one redirect only to an allowlisted download host, naming itself on every request", async () => {
    const seen: Array<{ url: string; agent: string | null; redirect: string | undefined }> = [];
    const routes: Record<string, () => Response> = {
      "https://ambientcg.com/get?file=a.zip": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://acg-download.struffelproductions.com/file/a.zip" },
        }),
      "https://acg-download.struffelproductions.com/file/a.zip": () => new Response(encode("zip")),
      "https://ambientcg.com/get?file=b.zip": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/b.zip" } }),
      "https://ambientcg.com/get?file=c.zip": () =>
        new Response(null, { status: 302, headers: { location: "https://acg-download.struffelproductions.com/hop" } }),
      "https://acg-download.struffelproductions.com/hop": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://acg-download.struffelproductions.com/file/a.zip" },
        }),
    };
    const fetchStub = (async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, agent: new Headers(init?.headers).get("user-agent"), redirect: init?.redirect });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route();
    }) as typeof fetch;
    const net = createCc0Net({ fetch: fetchStub });
    assert.deepEqual(await net.download(new URL("https://ambientcg.com/get?file=a.zip"), 16), encode("zip"));
    await assert.rejects(net.download(new URL("https://ambientcg.com/get?file=b.zip"), 16), {
      code: "host-not-allowed",
    });
    await assert.rejects(net.download(new URL("https://ambientcg.com/get?file=c.zip"), 16), {
      code: "download-failed",
    });
    assert.ok(!seen.some((entry) => entry.url.startsWith("https://evil.example")));
    assert.ok(seen.every((entry) => entry.agent === CC0_USER_AGENT && entry.redirect === "manual"));
    await assert.rejects(net.download(new URL("https://acg-download.struffelproductions.com/file/a.zip"), 16), {
      code: "host-not-allowed",
    });
    await assert.rejects(net.json(new URL("https://dl.polyhaven.org/x.json")), { code: "host-not-allowed" });
  });

  it("packs a glTF whose resources it lacks as a refusal, never a GLB with holes", () => {
    assert.throws(() => packGlb(GLTF, new Map([["wooden_crate.bin", BIN]])), { code: "zip-member-missing" });
    assert.throws(() => packGlb(encode('{"asset":{"version":"1.0"}}'), new Map()), { code: "manifest-invalid" });
  });
});

/** The Universal Animation Library as Quaternius uploaded it to OpenGameArt (CC0), served from its file store. */
const UAL_ON_OGA = "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip";

/** A network over a stub `fetch` that answers `routes` and records every request it is asked. */
function recordingNet(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchStub = (async (input: URL | string) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
  return { net: createCc0Net({ fetch: fetchStub }), asked };
}

describe("Quaternius' download host (owner call AN-21)", () => {
  it("downloads the Universal Animation Library from OpenGameArt's file store", async () => {
    const zip = encode("PK the-universal-animation-library");
    const { net, asked } = recordingNet({ [UAL_ON_OGA]: () => new Response(zip) });
    assert.deepEqual(await net.download(new URL(UAL_ON_OGA), zip.byteLength), zip);
    assert.deepEqual(asked, [UAL_ON_OGA]);
  });

  it("refuses every hostile shape of that host before a single request", async () => {
    const hostile = [
      "https://user:secret@opengameart.org/sites/default/files/universal_animation_librarystandard.zip",
      "https://opengameart.org:8443/sites/default/files/universal_animation_librarystandard.zip",
      "http://opengameart.org/sites/default/files/universal_animation_librarystandard.zip",
      "https://www.opengameart.org/sites/default/files/universal_animation_librarystandard.zip",
      "https://opengameart.org.evil.example/sites/default/files/universal_animation_librarystandard.zip",
      "https://evil.example/opengameart.org/sites/default/files/universal_animation_librarystandard.zip",
    ];
    const { net, asked } = recordingNet({});
    for (const url of hostile) {
      await assert.rejects(net.download(new URL(url), 1024), { code: "host-not-allowed" }, url);
    }
    await assert.rejects(net.json(new URL(UAL_ON_OGA)), { code: "host-not-allowed" }, "it lists nothing");
    assert.deepEqual(asked, []);
  });

  it("follows no redirect from it to a host off the list", async () => {
    const { net, asked } = recordingNet({
      [UAL_ON_OGA]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/ual.zip" } }),
    });
    await assert.rejects(net.download(new URL(UAL_ON_OGA), 1024), { code: "host-not-allowed" });
    assert.deepEqual(asked, [UAL_ON_OGA]);
  });

  it("is never reached through an API answer: only a curated row may name it", async () => {
    const host = await fakeHost();
    const oga = "https://opengameart.org/sites/default/files/wooden_crate_diff_1k.jpg";
    const { net, asked } = stubNet({ [FILES_URL]: polyHavenFiles({ diffUrl: oga }), [INFO_URL]: INFO }, {});
    await assert.rejects(
      call(
        createCc0Plugin({ net }),
        Cc0Tool.Fetch,
        { source: "polyhaven", id: "wooden_crate", resolution: "1k", maps: "diff" },
        host.ctx,
      ),
      /host-not-allowed/,
    );
    assert.ok(!asked.includes(oga));
    await nothingWritten(host);
  });

  it("is declared in the plugin's network hosts", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(path.join(PLUGIN_DIR, "plugin.json"), "utf8")));
    assert.ok(manifest.network?.hosts.includes("opengameart.org"));
  });
});
