/**
 * A chunked native build's manifest and chunks are hostile input until they match what the catalog
 * names: a manifest is read only when every rule of the `genex-chunks` contract holds, a stored
 * chunk only by a codec the app knows, never past its stated size, and only when its sha256 is the
 * manifest's. Both come from a build host and nowhere else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  assertManifestOf,
  CHUNK_MAX_BYTES,
  decodeChunk,
  fetchChunk,
  fetchManifest,
  MANIFEST_CHUNKS_MAX,
  MANIFEST_FILES_MAX,
  MANIFEST_MAX_BYTES,
  ManifestEntryKind,
  parseManifest,
  sha256Hex,
  slicesOf,
} from "../../src/main/play/native-chunks.ts";
import { InstallError } from "../../src/main/play/native-download.ts";
import type { StallClock } from "../../src/main/play/remix.ts";
import {
  type ChunkedBuild,
  InstallFailure,
  NATIVE_INSTALL_MAX_BYTES,
  NativeArch,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { hostileChunks, hostileManifests, noise, soundGame } from "../helpers/chunk-hostile.ts";
import {
  type ChunkedGame,
  type ChunkItem,
  chunkedGame,
  chunkFetch,
  sealManifest,
  storedChunk,
} from "../helpers/chunk-store.ts";

const HOST = "builds.example.test";
const HOSTS: ReadonlySet<string> = new Set([HOST]);
const FOLDER = `https://${HOST}/games/dust-runners/native/chunks/`;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A chunked Linux build's row for `game`. */
const rowOf = (game: ChunkedGame, overrides: Partial<ChunkedBuild> = {}): ChunkedBuild => ({
  platform: NativePlatform.Linux,
  arch: NativeArch.X64,
  version: "1.0",
  sizeBytes: game.sizeBytes,
  installedBytes: game.installedBytes,
  sha256: game.sha256,
  chunksUrl: FOLDER,
  entry: "Dust Runners/Dust.x86_64",
  publishedAt: "2026-11-12T00:00:00.000Z",
  ...overrides,
});

const failsWith = (failure: InstallFailure) => (error: unknown) =>
  error instanceof InstallError && error.failure === failure;

/** What `run` throws, as the install failure it is (or the error's text when it is none). */
function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof InstallError ? error.failure : String(error);
  }
  return "accepted";
}

const never = new AbortController().signal;

describe("a chunked build's manifest", () => {
  it("reads a sound manifest: its entries in order, its files and chunks placed in the stream", () => {
    const game = chunkedGame(soundGame());
    const manifest = parseManifest(game.manifestBytes);
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.kind, entry.path]),
      [
        [ManifestEntryKind.File, "Dust Runners/Dust.x86_64"],
        [ManifestEntryKind.File, "Dust Runners/Dust_Data/empty.cfg"],
        [ManifestEntryKind.File, "Dust Runners/Dust_Data/level0"],
        [ManifestEntryKind.Dir, "Dust Runners/Empty"],
        [ManifestEntryKind.File, "Dust Runners/UnityPlayer.so"],
        [ManifestEntryKind.Link, "Dust Runners/current"],
      ],
    );
    assert.equal(manifest.streamBytes, 228);
    assert.deepEqual(
      manifest.stream.map((file) => [file.path, file.offset, file.size, file.exec]),
      [
        ["Dust Runners/Dust.x86_64", 0, 64, true],
        ["Dust Runners/Dust_Data/level0", 64, 100, false],
        ["Dust Runners/UnityPlayer.so", 164, 64, false],
      ],
      "an empty file holds none of the stream",
    );
    assert.deepEqual(
      manifest.chunks.map((chunk) => [chunk.offset, chunk.size]),
      [
        [0, 64],
        [64, 64],
        [128, 64],
        [192, 36],
      ],
    );
    assert.doesNotThrow(() => assertManifestOf(manifest, rowOf(game)));
  });

  it("refuses each manifest that breaks a rule of the contract, whole", () => {
    const sound = chunkedGame(soundGame()).manifest;
    const cases = hostileManifests(sound);
    assert.ok(cases.length > 80, "the table covers every rule");
    for (const [why, bytes, failure] of cases) {
      assert.equal(
        failureOf(() => parseManifest(bytes)),
        failure,
        why,
      );
    }
  });

  it("reads a manifest at each cap, and a program flag either way", () => {
    const hash = "a".repeat(64);
    const atCaps = sealManifest({
      format: "genex-chunks",
      version: 1,
      files: [
        { path: "a", size: CHUNK_MAX_BYTES, exec: false },
        { path: `b/${"e".repeat(1022)}`, link: "e".repeat(1024) },
      ],
      chunks: [{ hash, size: CHUNK_MAX_BYTES }],
    });
    assert.equal(parseManifest(atCaps.bytes).streamBytes, CHUNK_MAX_BYTES);
    assert.ok(MANIFEST_FILES_MAX === 200_000 && MANIFEST_CHUNKS_MAX === 100_000, "the contract's caps");
    assert.ok(MANIFEST_MAX_BYTES === 64 * MIB && CHUNK_MAX_BYTES === 16 * MIB, "the contract's sizes");
  });

  it("reads names that only look like a climb, and folders that differ in case alone", () => {
    const items: ChunkItem[] = [
      { path: "..data/level0", data: "level" },
      { path: "Game/lib/a.so", data: "a" },
      { path: "game/Lib/b.so", data: "b" },
      { path: "latest", link: "..data" },
      { path: "Game/up", link: "../..data/level0" },
      { path: "Game/...", data: "dots" },
    ];
    const manifest = parseManifest(chunkedGame(items).manifestBytes);
    assert.deepEqual(
      manifest.entries.map((entry) => entry.path),
      ["..data/level0", "Game/...", "Game/lib/a.so", "Game/up", "game/Lib/b.so", "latest"],
    );
  });

  it("refuses a game past the largest one the app installs", () => {
    const count = NATIVE_INSTALL_MAX_BYTES / CHUNK_MAX_BYTES + 1;
    const huge = sealManifest({
      format: "genex-chunks",
      version: 1,
      files: [{ path: "a", size: count * CHUNK_MAX_BYTES }],
      chunks: Array.from({ length: count }, () => ({ hash: "a".repeat(64), size: CHUNK_MAX_BYTES })),
    });
    assert.equal(NATIVE_INSTALL_MAX_BYTES, 64 * GIB);
    assert.equal(
      failureOf(() => parseManifest(huge.bytes)),
      InstallFailure.TooLarge,
    );
  });

  it("is a build's only when it is exactly the size its row states and holds its entry", () => {
    const game = chunkedGame(soundGame());
    const manifest = parseManifest(game.manifestBytes);
    const mac = { platform: NativePlatform.Mac, arch: NativeArch.Universal } as const;
    const cases: Array<[string, Partial<ChunkedBuild>, string]> = [
      ["a row that states less", { installedBytes: game.installedBytes - 1 }, InstallFailure.TooLarge],
      ["a row that states more", { installedBytes: game.installedBytes + 1 }, InstallFailure.UnsafeArchive],
      ["an entry the manifest lacks", { entry: "Dust Runners/Other.x86_64" }, InstallFailure.EntryMissing],
      ["an entry that is a link", { entry: "Dust Runners/current" }, InstallFailure.EntryMissing],
      ["an entry that is a folder", { entry: "Dust Runners/Empty" }, InstallFailure.EntryMissing],
      ["an entry that is a folder of files", { entry: "Dust Runners/Dust_Data" }, InstallFailure.EntryMissing],
      ["a Mac app the manifest lacks", { ...mac, entry: "Dust Runners.app" }, InstallFailure.EntryMissing],
      ["a Mac app that is one file", { ...mac, entry: "Dust Runners/Dust.x86_64" }, InstallFailure.EntryMissing],
      ["a Mac app with files inside it", { ...mac, entry: "Dust Runners" }, "accepted"],
    ];
    for (const [why, overrides, expected] of cases) {
      assert.equal(
        failureOf(() => assertManifestOf(manifest, rowOf(game, overrides))),
        expected,
        why,
      );
    }
  });

  it("is downloaded from the build's chunk folder and kept only when it is the one the row names", async () => {
    const game = chunkedGame(soundGame());
    const store = chunkFetch(new Map([[FOLDER, game.objects]]));
    const read = await fetchManifest({ fetch: store.fetchImpl, hosts: HOSTS }, rowOf(game), never);
    assert.deepEqual(store.asked, [`${FOLDER}${game.sha256}.manifest.json`]);
    assert.deepEqual(read.bytes, game.manifestBytes, "its exact bytes, for the next update");
    assert.equal(read.manifest.chunks.length, 4);
    const other = rowOf(game, { sha256: "0".repeat(64) });
    const swapped = chunkFetch(new Map([[FOLDER, new Map([[`${other.sha256}.manifest.json`, game.manifestBytes]])]]));
    await assert.rejects(
      fetchManifest({ fetch: swapped.fetchImpl, hosts: HOSTS }, other, never),
      failsWith(InstallFailure.Checksum),
      "another manifest under the row's name",
    );
    const hosts: ReadonlySet<string> = new Set(["other.example.test"]);
    const refused = chunkFetch(new Map([[FOLDER, game.objects]]));
    await assert.rejects(
      fetchManifest({ fetch: refused.fetchImpl, hosts }, rowOf(game), never),
      failsWith(InstallFailure.Network),
    );
    assert.deepEqual(refused.asked, [], "a folder off the build hosts is never asked");
  });
});

describe("a stored chunk", () => {
  const raw = noise(4096, 7);

  it("decodes as stored or deflated to exactly the bytes the manifest names", async () => {
    const chunk = { hash: await sha256Hex(raw), size: raw.length };
    assert.deepEqual(await decodeChunk(storedChunk(raw, "raw"), chunk), raw);
    assert.deepEqual(await decodeChunk(storedChunk(raw, "deflate"), chunk), raw);
    const zeros = Buffer.alloc(MIB);
    const packed = storedChunk(zeros);
    assert.ok(packed.length < 2048, "a chunk that deflates is stored deflated");
    assert.deepEqual(await decodeChunk(packed, { hash: await sha256Hex(zeros), size: zeros.length }), zeros);
  });

  it("refuses each stored object that is not the chunk", async () => {
    const chunk = { hash: await sha256Hex(raw), size: raw.length };
    for (const [why, stored, failure] of hostileChunks(raw)) {
      await assert.rejects(decodeChunk(stored, chunk), failsWith(failure), why);
    }
  });

  it("is downloaded from the chunk folder, never more than its size and a codec byte", async () => {
    const game = chunkedGame([{ path: "Dust Runners/Dust.x86_64", data: raw }], raw.length);
    const build = rowOf(game);
    const [chunk] = parseManifest(game.manifestBytes).chunks;
    assert.ok(chunk);
    const store = chunkFetch(new Map([[FOLDER, game.objects]]));
    assert.deepEqual(await fetchChunk({ fetch: store.fetchImpl, hosts: HOSTS }, build, chunk, never), raw);
    assert.deepEqual(store.asked, [`${FOLDER}${chunk.hash}.bin`]);
    const body = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
      new Response(new Uint8Array(bytes), { headers });
    const stored = storedChunk(raw, "raw");
    const answers: Array<[string, () => Response, InstallFailure]> = [
      ["an HTTP error", () => new Response("no", { status: 500 }), InstallFailure.Network],
      ["a missing chunk", () => new Response(null, { status: 404 }), InstallFailure.Network],
      [
        "a partial answer nobody asked for",
        () => new Response(new Uint8Array(stored), { status: 206 }),
        InstallFailure.Network,
      ],
      ["an answer that says it is longer", () => body(stored, { "content-length": "999999" }), InstallFailure.TooLarge],
      ["an answer longer than a chunk can be", () => body(Buffer.concat([stored, stored])), InstallFailure.TooLarge],
      [
        "an answer cut short",
        () => body(stored.subarray(0, 100), { "content-length": String(stored.length) }),
        InstallFailure.Network,
      ],
      ["an answer cut short that does not say so", () => body(stored.subarray(0, 100)), InstallFailure.Checksum],
      [
        "a redirect off the build hosts",
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/chunk.bin" } }),
        InstallFailure.Network,
      ],
      [
        "a redirect to plain http",
        () => new Response(null, { status: 302, headers: { location: `http://${HOST}/chunk.bin` } }),
        InstallFailure.Network,
      ],
    ];
    for (const [why, answer, failure] of answers) {
      const hostile = chunkFetch(new Map([[FOLDER, game.objects]]), () => answer());
      const deps = { fetch: hostile.fetchImpl, hosts: HOSTS };
      await assert.rejects(fetchChunk(deps, build, chunk, never), failsWith(failure), why);
      assert.deepEqual(hostile.asked, [`${FOLDER}${chunk.hash}.bin`], `${why}: nowhere else is asked`);
    }
  });
});

describe("a chunk's download", () => {
  it("is given up once it stops moving, as an archive's is", async () => {
    const raw = noise(4096, 7);
    const game = chunkedGame([{ path: "Dust Runners/Dust.x86_64", data: raw }], raw.length);
    const [chunk] = parseManifest(game.manifestBytes).chunks;
    assert.ok(chunk);
    const timers: Array<() => void> = [];
    const stallClock: StallClock = {
      setTimeout: (fire) => {
        timers.push(fire);
        return timers.length - 1;
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") timers[handle] = () => undefined;
      },
    };
    let started = () => {};
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Five bytes, then silence: the body neither ends nor fails until the request is stopped.
    const silent = chunkFetch(new Map([[FOLDER, game.objects]]), (_, signal) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(raw.subarray(0, 5));
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          started();
        },
      });
      return new Response(body);
    });
    const done = fetchChunk({ fetch: silent.fetchImpl, hosts: HOSTS, stallClock }, rowOf(game), chunk, never);
    const failed = assert.rejects(done, failsWith(InstallFailure.Stalled));
    await sent;
    await tick();
    timers.at(-1)?.();
    await failed;
  });
});

describe("a span of a chunked build's stream", () => {
  it("covers runs of the files it crosses, in order, and no empty file", () => {
    const game = chunkedGame(soundGame(), 150);
    const manifest = parseManifest(game.manifestBytes);
    const runs = manifest.chunks.map((chunk) =>
      slicesOf(manifest, chunk).map((slice) => [slice.file.path, slice.fileOffset, slice.spanOffset, slice.length]),
    );
    assert.deepEqual(runs, [
      [
        ["Dust Runners/Dust.x86_64", 0, 0, 64],
        ["Dust Runners/Dust_Data/level0", 0, 64, 86],
      ],
      [
        ["Dust Runners/Dust_Data/level0", 86, 0, 14],
        ["Dust Runners/UnityPlayer.so", 0, 14, 64],
      ],
    ]);
    assert.deepEqual(
      slicesOf(manifest, { offset: 163, size: 2 }).map((slice) => [slice.file.path, slice.fileOffset, slice.length]),
      [
        ["Dust Runners/Dust_Data/level0", 99, 1],
        ["Dust Runners/UnityPlayer.so", 0, 1],
      ],
      "a span across a boundary starts in the file that holds its first byte",
    );
    assert.throws(() => slicesOf(manifest, { offset: 220, size: 16 }), "a span past the stream is no chunk");
  });
});
