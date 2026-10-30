/**
 * The bundled Genex Library plugin (`src/plugins/library/`): `library__search` answers from the
 * catalog alone; `library__add` installs an entry's files from a pack (a local folder, or the
 * published release through an allowlisted host), checks each file's size and sha256 before
 * writing, delivers the asked tier through the host's own `deliverAssetFiles` into
 * `assets/library/<folder>/` and records the provenance. Every hostile pack row (a tampered file,
 * a wrong size, a link, a host off the list) delivers nothing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { createLibraryPlugin, type LibraryDelivery, LibraryTool } from "../../src/plugins/library/backend.ts";
import { LIBRARY_HOSTS, type LibraryNet, packUrl } from "../../src/plugins/library/install.ts";
import { createLibraryNet } from "../../src/plugins/library/net.ts";
import {
  type LibraryCatalog,
  LibraryError,
  LibraryRefusal,
  libraryFolder,
  packFileName,
  parseLibraryCatalog,
} from "../../src/shared/genex-library.ts";
import { deliverAssetFiles } from "../../src/substrate/genex-delivery.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "../../src/plugins/library");
const PACK = "2026.10.29";
const ID = "material/asphalt_02";
const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The pack's files of one material: name, tier, bytes. */
const FILES: Array<[string, string | undefined, Uint8Array]> = [
  ["entry.json", undefined, encode('{"schema":1}')],
  ["albedo.2k.jpg", "2k", encode("albedo 2k")],
  ["albedo.2k.ktx2", "2k", encode("albedo 2k basis")],
  ["albedo.4k.jpg", "4k", encode("albedo 4k")],
];

function catalogOf(baseUrl: string | null = null): LibraryCatalog {
  return parseLibraryCatalog({
    schema: 1,
    pack: { version: PACK, baseUrl },
    entries: [
      {
        id: ID,
        kind: "material",
        name: "Asphalt 02",
        category: "asphalt",
        tags: ["road", "street"],
        licence: "CC0-1.0",
        source: {
          site: "polyhaven",
          id: "asphalt_02",
          page: "https://polyhaven.com/a/asphalt_02",
          authors: ["Rob Tuytel"],
        },
        material: { tileMetres: 2, tiers: ["2k", "4k"] },
        build: {
          pack: PACK,
          files: FILES.map(([name, tier, bytes]) => ({
            name,
            ...(tier ? { tier } : {}),
            sha256: sha256(bytes),
            bytes: bytes.byteLength,
          })),
        },
      },
    ],
  });
}

/** A pack folder as the build script writes it: `<folder>/<pack>/<flat name>`. */
async function packFolder(root: string, override: Record<string, Uint8Array> = {}): Promise<string> {
  const dir = path.join(root, "pack");
  await mkdir(path.join(dir, PACK), { recursive: true });
  for (const [name, , bytes] of FILES)
    await writeFile(path.join(dir, PACK, packFileName(ID, name)), override[name] ?? bytes);
  return dir;
}

interface Host {
  ctx: PluginContext;
  game: string;
  records: Map<string, LibraryDelivery>;
}

/** A host for one game: storage, the pack folder setting, the real delivery and a jobs store. */
async function hostFor(root: string, folder: string | null, withGame = true): Promise<Host> {
  const game = path.join(root, "game");
  const storage = path.join(root, "storage");
  await mkdir(game, { recursive: true });
  await mkdir(storage, { recursive: true });
  const records = new Map<string, LibraryDelivery>();
  const host = async (method: string, args?: Record<string, unknown>) => {
    if (method === "storage.root") return storage;
    if (method === "settings.read") return { "pack-folder": folder ?? "" };
    if (method === "assets.deliver")
      return deliverAssetFiles(String(args?.output), game, String(args?.jobId), "library", { reuseExisting: true });
    if (method === "jobs.write") return records.set(String(args?.id), args?.value as LibraryDelivery);
    throw new Error(`unexpected host call ${method}`);
  };
  const ctx = {
    ...(withGame ? { directory: game, project: "g" } : {}),
    signal: new AbortController().signal,
    callId: 1,
    host,
  } as unknown as PluginContext;
  return { ctx, game, records };
}

const noNet: LibraryNet = {
  download() {
    throw new Error("the network is not reached");
  },
};

async function refusedWith(promise: Promise<unknown>, code: LibraryRefusal) {
  await assert.rejects(promise, (error: Error) => error.message.startsWith(`library ${code}:`));
}

describe("Genex Library plugin", () => {
  it("declares its tools and exactly the hosts its network reaches", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(path.join(PLUGIN_DIR, "plugin.json"), "utf8")));
    assert.equal(manifest.id, "library");
    assert.deepEqual(
      manifest.tools.map((tool) => tool.name),
      Object.values(LibraryTool),
    );
    const declared = JSON.parse(await readFile(path.join(PLUGIN_DIR, "plugin.json"), "utf8")).network.hosts;
    assert.deepEqual([...declared].sort(), [...LIBRARY_HOSTS].sort());
  });

  it("searches the catalog without a game, an install or the network", async () => {
    const plugin = await createLibraryPlugin({ net: noNet, catalog: catalogOf() });
    const answer = (await plugin.tool?.(LibraryTool.Search, { query: "wet road" }, {} as PluginContext)) as {
      results: Array<{ id: string; status: string; tiers: string[] }>;
    };
    assert.deepEqual(
      answer.results.map((hit) => [hit.id, hit.status, hit.tiers]),
      [[ID, "ready", ["2k", "4k"]]],
    );
    await refusedWith(
      plugin.tool?.(LibraryTool.Search, { query: "x", kind: "sound" }, {} as PluginContext) ?? Promise.resolve(),
      LibraryRefusal.BadRequest,
    );
  });

  it("installs from a local pack and delivers the asked tier into assets/library/<folder>/", async () => {
    const root = await tmpDir();
    const host = await hostFor(root, await packFolder(root));
    const plugin = await createLibraryPlugin({ net: noNet, catalog: catalogOf() });
    const answer = (await plugin.tool?.(LibraryTool.Add, { id: ID } as Record<string, PluginScalar>, host.ctx)) as {
      files: string[];
      use: string;
      tier: string;
    };
    const folder = `assets/library/${libraryFolder(ID)}`;
    assert.equal(answer.tier, "2k");
    assert.deepEqual(
      answer.files,
      ["entry.json", "albedo.2k.jpg", "albedo.2k.ktx2"].map((name) => `${folder}/${name}`),
    );
    assert.deepEqual((await readdir(path.join(host.game, folder))).sort(), [
      "albedo.2k.jpg",
      "albedo.2k.ktx2",
      "entry.json",
    ]);
    assert.deepEqual(await readFile(path.join(host.game, folder, "albedo.2k.jpg")), Buffer.from("albedo 2k"));
    assert.match(answer.use, /gfx\.assets\(\)\.library\("material\/asphalt_02"\)/);
    const record = host.records.get(libraryFolder(ID));
    assert.equal(record?.licence, "CC0-1.0");
    assert.deepEqual(record?.authors, ["Rob Tuytel"]);
    assert.equal(record?.files.length, 3);
    assert.deepEqual(await readdir(path.join(root, "storage", "jobs")), [], "the staged folder is removed");
    await plugin.tool?.(LibraryTool.Add, { id: ID, tier: "4k" }, host.ctx);
    assert.ok(existsSync(path.join(host.game, folder, "albedo.4k.jpg")), "a second tier lands beside the first");
  });

  const hostile: Array<[string, (root: string) => Promise<string>, LibraryRefusal]> = [
    [
      "a tampered file",
      (root) => packFolder(root, { "albedo.2k.jpg": encode("albedo 2X") }),
      LibraryRefusal.DigestMismatch,
    ],
    [
      "a file of another size",
      (root) => packFolder(root, { "albedo.2k.jpg": encode("albedo 2k!") }),
      LibraryRefusal.SizeMismatch,
    ],
    [
      "a link in the pack folder",
      async (root) => {
        const dir = await packFolder(root);
        const at = path.join(dir, PACK, packFileName(ID, "albedo.2k.jpg"));
        await writeFile(path.join(root, "outside.jpg"), "albedo 2k");
        await import("node:fs/promises").then((fs) => fs.rm(at));
        await symlink(path.join(root, "outside.jpg"), at);
        return dir;
      },
      LibraryRefusal.DownloadFailed,
    ],
  ];
  for (const [name, make, code] of hostile) {
    it(`delivers nothing from ${name} (${code})`, async () => {
      const root = await tmpDir();
      const host = await hostFor(root, await make(root));
      const plugin = await createLibraryPlugin({ net: noNet, catalog: catalogOf() });
      await refusedWith(plugin.tool?.(LibraryTool.Add, { id: ID }, host.ctx) ?? Promise.resolve(), code);
      assert.equal(existsSync(path.join(host.game, "assets")), false);
    });
  }

  it("refuses an add with no game, and one with no pack published or set", async () => {
    const root = await tmpDir();
    const plugin = await createLibraryPlugin({ net: noNet, catalog: catalogOf() });
    await refusedWith(
      plugin.tool?.(LibraryTool.Add, { id: ID }, (await hostFor(root, null, false)).ctx) ?? Promise.resolve(),
      LibraryRefusal.NoGame,
    );
    await refusedWith(
      plugin.tool?.(LibraryTool.Add, { id: ID }, (await hostFor(root, null)).ctx) ?? Promise.resolve(),
      LibraryRefusal.Unpublished,
    );
  });

  it("downloads a published pack once, by its pack version, and reuses the stored copy", async () => {
    const root = await tmpDir();
    const asked: string[] = [];
    const bytesOf = new Map(FILES.map(([name, , bytes]) => [packFileName(ID, name), bytes]));
    const net: LibraryNet = {
      async download(url, maxBytes) {
        asked.push(url.href);
        const bytes = bytesOf.get(path.posix.basename(url.pathname)) ?? new Uint8Array(0);
        assert.ok(bytes.byteLength <= maxBytes);
        return bytes;
      },
    };
    const plugin = await createLibraryPlugin({
      net,
      catalog: catalogOf("https://github.com/genex-games/genex-library/releases/download/{pack}"),
    });
    const host = await hostFor(root, null);
    await plugin.tool?.(LibraryTool.Add, { id: ID }, host.ctx);
    assert.deepEqual(asked, [
      `https://github.com/genex-games/genex-library/releases/download/${PACK}/material.asphalt_02.entry.json`,
      `https://github.com/genex-games/genex-library/releases/download/${PACK}/material.asphalt_02.albedo.2k.jpg`,
      `https://github.com/genex-games/genex-library/releases/download/${PACK}/material.asphalt_02.albedo.2k.ktx2`,
    ]);
    await plugin.tool?.(LibraryTool.Add, { id: ID }, (await hostFor(root, null)).ctx);
    assert.equal(asked.length, 3, "the stored copies matched their pins");
  });

  it("never builds a URL off the library hosts, and its network refuses one", async () => {
    for (const base of [
      "https://example.com/pack",
      "http://github.com/x",
      "https://user:pw@github.com/x",
      "https://github.com:8443/x",
    ]) {
      assert.throws(
        () => packUrl(base, PACK, "x"),
        (error: unknown) => error instanceof LibraryError && error.code === LibraryRefusal.DownloadFailed,
      );
    }
    let fetched = 0;
    const net = createLibraryNet({
      fetch: (async () => {
        fetched++;
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      net.download(new URL("https://github.com/a"), 10),
      (error: unknown) => error instanceof LibraryError,
    );
    assert.equal(fetched, 1, "the redirect off the list is never followed");
  });

  it("fails a redirect with no Location at once, naming why", async () => {
    let fetched = 0;
    const net = createLibraryNet({
      fetch: (async () => {
        fetched++;
        return new Response(null, { status: 302 });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      net.download(new URL("https://github.com/a"), 10),
      (error: unknown) => error instanceof LibraryError && /no Location/.test(error.message),
    );
    assert.equal(fetched, 1, "the same URL is never asked again");
  });

  it("leaves no .part file behind when installing a file fails", async () => {
    const root = await tmpDir();
    const host = await hostFor(root, await packFolder(root));
    // A folder where the 2k albedo goes: its write succeeds, the rename onto it fails.
    const installed = path.join(root, "storage", "pack", PACK, libraryFolder(ID));
    await mkdir(path.join(installed, "albedo.2k.jpg", "blocked"), { recursive: true });
    const plugin = await createLibraryPlugin({ net: noNet, catalog: catalogOf() });
    await assert.rejects(
      plugin.tool?.(LibraryTool.Add, { id: ID } as Record<string, PluginScalar>, host.ctx) as Promise<unknown>,
    );
    const left = (await readdir(installed)).filter((name) => name.endsWith(".part"));
    assert.deepEqual(left, [], "the half-installed copy is removed");
  });
});
