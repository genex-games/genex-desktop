/**
 * Hostile chunked builds for the native installer's tests: every way a manifest can break a rule
 * of the `genex-chunks` contract, and every way a stored chunk can be other than the manifest says,
 * each with the install failure it must end as. A real publish writes none of them.
 */
import { InstallFailure } from "../../src/shared/play-native.ts";
import { type ChunkItem, sealManifest, storedChunk, type WireManifest } from "./chunk-store.ts";

/** One hostile manifest: why it is refused, its bytes, and the failure it is. */
export type HostileManifest = [why: string, bytes: Buffer, failure: InstallFailure];

const MIB = 1024 ** 2;
const CHUNK_MAX_BYTES = 16 * MIB;
const MANIFEST_MAX_BYTES = 64 * MIB;
const MANIFEST_FILES_MAX = 200_000;
const MANIFEST_CHUNKS_MAX = 100_000;
const NAME_MAX_CHARS = 1024;

/** A 64-bit little-endian ELF program's header for x64: what a Linux build's entry must be. */
export function elfX64(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(0x3e, 18);
  return bytes;
}

/** `length` bytes that differ from one `seed` to the next and do not deflate to nothing. */
export function noise(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = (seed + 1) * 2654435761;
  for (let at = 0; at < length; at++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[at] = state >>> 24;
  }
  return bytes;
}

/**
 * A small Linux game with one of everything a manifest lists: a program, files in a folder, an
 * empty file, an empty folder and a link. Its entry is `Dust Runners/Dust.x86_64`.
 */
export const soundGame = (): ChunkItem[] => [
  { path: "Dust Runners/Dust.x86_64", data: elfX64(), exec: true },
  { path: "Dust Runners/Dust_Data/level0", data: noise(100, 1) },
  { path: "Dust Runners/Dust_Data/empty.cfg", data: "" },
  { path: "Dust Runners/Empty", dir: true },
  { path: "Dust Runners/UnityPlayer.so", data: noise(64, 2) },
  { path: "Dust Runners/current", link: "Dust_Data" },
];

const SOUND_ENTRY = "Dust Runners/Dust.x86_64";

type Change = (manifest: WireManifest) => void;

/** `sound` after `change`, as any value: the change may leave it no manifest at all. */
function changed(sound: WireManifest, change: Change): unknown {
  const copy = structuredClone(sound);
  change(copy);
  return copy;
}

/** `manifest` with `entry` added where a sorted manifest would have it. */
function add(manifest: WireManifest, entry: Record<string, unknown>): void {
  manifest.files.push(entry);
  manifest.files.sort((a, b) => Number(String(a.path) > String(b.path)) - Number(String(a.path) < String(b.path)));
}

/** The first entry of `manifest` that `is`, to change in place. */
function first(manifest: WireManifest, is: (entry: Record<string, unknown>) => boolean): Record<string, unknown> {
  const found = manifest.files.find(is);
  if (!found) throw new Error("the sound manifest has no such entry");
  return found;
}

const aFile = (entry: Record<string, unknown>) => typeof entry.size === "number";
const aLink = (entry: Record<string, unknown>) => entry.link !== undefined;
const aFolder = (entry: Record<string, unknown>) => entry.dir !== undefined;

/** Paths no manifest may name (rule 3), each added as an empty file. */
const BAD_PATHS: Array<[string, unknown]> = [
  ["an empty path", ""],
  ["an absolute path", "/etc/passwd"],
  ["an empty segment", "Dust Runners//evil"],
  ["a trailing slash", "Dust Runners/evil/"],
  ["a `.` segment", "Dust Runners/./evil"],
  ["a `..` segment", "Dust Runners/../../evil"],
  ["a path that is only `..`", ".."],
  ["a backslash", "Dust Runners\\evil"],
  ["a drive", "C:/evil"],
  ["a colon", "Dust Runners/evil:stream"],
  ["a star", "Dust Runners/*"],
  ["a question mark", "Dust Runners/evil?"],
  ["a quote", 'Dust Runners/"evil"'],
  ["an angle bracket", "Dust Runners/<evil"],
  ["a closing angle bracket", "Dust Runners/evil>"],
  ["a pipe", "Dust Runners/evil|more"],
  ["a control character", "Dust Runners/evil\nmore"],
  ["a NUL", "Dust Runners/evil\0"],
  ["a DEL", "Dust Runners/evil\x7f"],
  ["a path past the cap", `Dust Runners/${"e".repeat(NAME_MAX_CHARS)}`],
  ["a path that is not text", 7],
];

/** Link targets no manifest may name (rule 6), each on a link at `Dust Runners/zz`. */
const BAD_LINKS: Array<[string, unknown]> = [
  ["an empty link", ""],
  ["an absolute link", "/etc"],
  ["a link to a drive", "C:evil"],
  ["a link with a backslash", "..\\..\\evil"],
  ["a link with a control character", "Dust_Data\nevil"],
  ["a link past the cap", "e".repeat(NAME_MAX_CHARS + 1)],
  ["a link out of the game", "../../evil"],
  ["a link climbing out through a folder", "Dust_Data/../../../evil"],
  ["a link to the game's root", ".."],
  ["a link that climbs out and names a `..` sibling", "../../..data"],
  ["a link that is not text", 3],
];

/** Each rule a manifest's own fields can break, as a change to a sound one. */
const CHANGES: Array<[string, Change, InstallFailure]> = [
  ["another format", (m) => Object.assign(m, { format: "genex-tar" }), InstallFailure.UnsafeArchive],
  ["a later version", (m) => Object.assign(m, { version: 2 }), InstallFailure.NeedsUpdate],
  [
    "a later version with keys this one lacks",
    (m) => Object.assign(m, { version: 3, deltas: [] }),
    InstallFailure.NeedsUpdate,
  ],
  ["version zero", (m) => Object.assign(m, { version: 0 }), InstallFailure.UnsafeArchive],
  ["a version that is text", (m) => Object.assign(m, { version: "1" }), InstallFailure.UnsafeArchive],
  ["a fractional version", (m) => Object.assign(m, { version: 1.5 }), InstallFailure.UnsafeArchive],
  ["an unknown key", (m) => Object.assign(m, { signature: "abc" }), InstallFailure.UnsafeArchive],
  ["an unknown key in a file", (m) => Object.assign(first(m, aFile), { mode: 0o4755 }), InstallFailure.UnsafeArchive],
  ["an unknown key in a link", (m) => Object.assign(first(m, aLink), { hard: true }), InstallFailure.UnsafeArchive],
  [
    "an unknown key in a folder",
    (m) => Object.assign(first(m, aFolder), { mode: 0o777 }),
    InstallFailure.UnsafeArchive,
  ],
  ["an unknown key in a chunk", (m) => Object.assign(m.chunks[0] ?? {}, { codec: 1 }), InstallFailure.UnsafeArchive],
  ["no files", (m) => Object.assign(m, { files: [] }), InstallFailure.UnsafeArchive],
  ["files that are no list", (m) => Object.assign(m, { files: { path: "a" } }), InstallFailure.UnsafeArchive],
  ["no chunks", (m) => Object.assign(m, { chunks: [] }), InstallFailure.UnsafeArchive],
  ["chunks that are no list", (m) => Object.assign(m, { chunks: "all" }), InstallFailure.UnsafeArchive],
  ["an entry that is no object", (m) => Object.assign(m, { files: [...m.files, "zz"] }), InstallFailure.UnsafeArchive],
  ["files out of order", (m) => m.files.reverse(), InstallFailure.UnsafeArchive],
  ["the same path twice", (m) => add(m, { path: SOUND_ENTRY, size: 0 }), InstallFailure.UnsafeArchive],
  [
    "the same path in another case",
    (m) => add(m, { path: SOUND_ENTRY.toUpperCase(), size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  ["an entry inside a file", (m) => add(m, { path: `${SOUND_ENTRY}/evil`, size: 0 }), InstallFailure.UnsafeArchive],
  [
    "an entry inside a link",
    (m) => add(m, { path: "Dust Runners/current/evil", size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  [
    "an entry inside an empty folder",
    (m) => add(m, { path: "Dust Runners/Empty/evil", size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  ["a link deep inside a file", (m) => add(m, { path: `${SOUND_ENTRY}/a/b`, link: "c" }), InstallFailure.UnsafeArchive],
  [
    "an entry inside a file spelled in another case",
    (m) => add(m, { path: `${SOUND_ENTRY.toLowerCase()}/evil`, size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  [
    "an entry inside a link spelled in another case",
    (m) => add(m, { path: "DUST RUNNERS/CURRENT/evil", size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  [
    "an entry inside an empty folder spelled in another case",
    (m) => add(m, { path: "dust runners/empty/evil", size: 0 }),
    InstallFailure.UnsafeArchive,
  ],
  ["a link at the root that leaves the game", (m) => add(m, { path: "zz", link: ".." }), InstallFailure.UnsafeArchive],
  ["a link at the root to the root", (m) => add(m, { path: "zz", link: "." }), InstallFailure.UnsafeArchive],
  [
    "a folder that says it is none",
    (m) => Object.assign(first(m, aFolder), { dir: false }),
    InstallFailure.UnsafeArchive,
  ],
  [
    "a file that is also a link",
    (m) => Object.assign(first(m, aFile), { link: "current" }),
    InstallFailure.UnsafeArchive,
  ],
  ["a folder that is also a file", (m) => Object.assign(first(m, aFolder), { size: 0 }), InstallFailure.UnsafeArchive],
  ["a link that is also a folder", (m) => Object.assign(first(m, aLink), { dir: true }), InstallFailure.UnsafeArchive],
  ["a file with no size", (m) => add(m, { path: "zz" }), InstallFailure.UnsafeArchive],
  ["a negative size", (m) => add(m, { path: "zz", size: -1 }), InstallFailure.UnsafeArchive],
  ["a fractional size", (m) => add(m, { path: "zz", size: 0.5 }), InstallFailure.UnsafeArchive],
  ["a size that is text", (m) => add(m, { path: "zz", size: "0" }), InstallFailure.UnsafeArchive],
  ["a size past what a number holds", (m) => add(m, { path: "zz", size: 2 ** 60 }), InstallFailure.UnsafeArchive],
  ["a program flag that is text", (m) => add(m, { path: "zz", size: 0, exec: "yes" }), InstallFailure.UnsafeArchive],
  ["a chunk that is no object", (m) => Object.assign(m, { chunks: [...m.chunks, 64] }), InstallFailure.UnsafeArchive],
  [
    "a chunk hash in capitals",
    (m) => Object.assign(m.chunks[0] ?? {}, { hash: "A".repeat(64) }),
    InstallFailure.UnsafeArchive,
  ],
  ["a short chunk hash", (m) => Object.assign(m.chunks[0] ?? {}, { hash: "abc" }), InstallFailure.UnsafeArchive],
  [
    "a chunk hash that is a path",
    (m) => Object.assign(m.chunks[0] ?? {}, { hash: `../${"a".repeat(61)}` }),
    InstallFailure.UnsafeArchive,
  ],
  ["an empty chunk", (m) => m.chunks.push({ hash: "a".repeat(64), size: 0 }), InstallFailure.UnsafeArchive],
  ["a fractional chunk", (m) => Object.assign(m.chunks[0] ?? {}, { size: 1.5 }), InstallFailure.UnsafeArchive],
  [
    "a chunk past the cap",
    (m) => Object.assign(m.chunks[0] ?? {}, { size: CHUNK_MAX_BYTES + 1 }),
    InstallFailure.UnsafeArchive,
  ],
  [
    "chunks longer than the files",
    (m) => m.chunks.push({ hash: "a".repeat(64), size: 1 }),
    InstallFailure.UnsafeArchive,
  ],
  ["chunks shorter than the files", (m) => m.chunks.pop(), InstallFailure.UnsafeArchive],
  ["files longer than the chunks", (m) => add(m, { path: "zz", size: 1 }), InstallFailure.UnsafeArchive],
];

/** The caps a manifest may not pass (rule 2), each `too-large`. */
function pastCaps(sound: WireManifest): HostileManifest[] {
  const manyFiles = Array.from({ length: MANIFEST_FILES_MAX + 1 }, (_, index) => ({
    path: `f/${String(index).padStart(6, "0")}`,
    size: 0,
  }));
  const manyChunks = Array.from({ length: MANIFEST_CHUNKS_MAX + 1 }, () => ({ hash: "a".repeat(64), size: 1 }));
  return [
    ["more files than allowed", sealManifest({ ...sound, files: manyFiles }).bytes, InstallFailure.TooLarge],
    ["more chunks than allowed", sealManifest({ ...sound, chunks: manyChunks }).bytes, InstallFailure.TooLarge],
    ["a manifest past its size cap", Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20), InstallFailure.TooLarge],
  ];
}

/** Bytes that are no manifest at all. */
function notManifests(sound: WireManifest): HostileManifest[] {
  const text = JSON.stringify(sound);
  return [
    ["bytes that are not JSON", Buffer.from("PK\u0003\u0004 a zip, not a manifest"), InstallFailure.UnsafeArchive],
    ["a list", sealManifest([sound]).bytes, InstallFailure.UnsafeArchive],
    [
      "a byte-order mark",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
      InstallFailure.UnsafeArchive,
    ],
    [
      "bytes that are not UTF-8",
      Buffer.from(text.replace("Dust Runners", "Dust\xffRunners"), "latin1"),
      InstallFailure.UnsafeArchive,
    ],
    ["nothing", Buffer.alloc(0), InstallFailure.UnsafeArchive],
  ];
}

/**
 * Every way `sound` (the manifest of {@link soundGame}) can break a rule of the contract: each
 * must be refused whole, whatever else in it is right.
 */
export function hostileManifests(sound: WireManifest): HostileManifest[] {
  const sealed = (why: string, change: Change, failure: InstallFailure): HostileManifest => [
    why,
    sealManifest(changed(sound, change)).bytes,
    failure,
  ];
  return [
    ...CHANGES.map(([why, change, failure]) => sealed(why, change, failure)),
    ...BAD_PATHS.map(([why, at]) => sealed(why, (m) => add(m, { path: at, size: 0 }), InstallFailure.UnsafeArchive)),
    ...BAD_LINKS.map(([why, link]) =>
      sealed(why, (m) => add(m, { path: "Dust Runners/zz", link }), InstallFailure.UnsafeArchive),
    ),
    ...notManifests(sound),
    ...pastCaps(sound),
  ];
}

/** One hostile stored chunk: why it is refused, what the folder holds in the chunk's place, and the failure it is. */
export type HostileChunk = [why: string, stored: Buffer, failure: InstallFailure];

/** Every way a stored object can be other than the chunk `raw` the manifest names. */
export function hostileChunks(raw: Buffer): HostileChunk[] {
  const flipped = Buffer.from(raw);
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  const longer = Buffer.concat([raw, Buffer.from([1])]);
  const deflated = storedChunk(raw, "deflate");
  return [
    ["a chunk one byte short", storedChunk(raw.subarray(1), "raw"), InstallFailure.Checksum],
    ["a chunk one byte long", storedChunk(longer, "raw"), InstallFailure.Checksum],
    ["a chunk of other bytes", storedChunk(flipped, "raw"), InstallFailure.Checksum],
    ["other bytes, deflated", storedChunk(flipped, "deflate"), InstallFailure.Checksum],
    ["a codec this app does not know", Buffer.concat([Buffer.from([2]), raw]), InstallFailure.NeedsUpdate],
    [
      "a deflate stream that expands past the chunk",
      storedChunk(Buffer.alloc(MIB), "deflate"),
      InstallFailure.TooLarge,
    ],
    ["one byte too many, deflated", storedChunk(longer, "deflate"), InstallFailure.TooLarge],
    ["a deflate stream cut short", deflated.subarray(0, deflated.length - 3), InstallFailure.Checksum],
    ["a deflate stream that is noise", Buffer.concat([Buffer.from([1]), noise(40, 9)]), InstallFailure.Checksum],
    ["only a codec byte", Buffer.from([0]), InstallFailure.Checksum],
    ["nothing", Buffer.alloc(0), InstallFailure.Checksum],
  ];
}
