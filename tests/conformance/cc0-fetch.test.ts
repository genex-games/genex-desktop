/**
 * The CC0 fetch core (`src/substrate/cc0-fetch.ts`): a pinned zip's listed members are written
 * beside it, each verified by size and sha256; a hostile zip (a climbing, absolute, nested or
 * linked entry, a duplicate, a bomb past the caps, a member that inflates past its header) is
 * refused whole with nothing written; a link planted in the cache is never written through; an
 * md5 the source publishes is cross-checked; and a download stops at the manifest's size, follows
 * no redirect and names its caller. The network is a stub or a local server here.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type ZipAttributes, zipSync } from "fflate";
import {
  CC0,
  Cc0Error,
  Cc0Refusal,
  cachedPath,
  checkManifest,
  fetchFile,
  httpsDownload,
  type ManifestAsset,
  type ManifestFile,
  md5,
  sha256,
  unpackedMembers,
  verified,
  ZIP_LIMITS,
  type ZipLimits,
  type ZipMember,
} from "../../src/substrate/cc0-fetch.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ZIP_URL = "https://ambientcg.com/get?file=Bricks076C_1K-JPG.zip";
const COLOR = new TextEncoder().encode("the colour map, repeated ".repeat(64));
const NORMAL = new TextEncoder().encode("the normal map");
const PREVIEW = new TextEncoder().encode("a preview nobody asked for");
const UNIX = 3;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

type Entries = Record<string, Uint8Array | [Uint8Array, ZipAttributes]>;

function zipOf(entries: Entries): Uint8Array {
  return zipSync(entries, { level: 6 });
}

const GOOD_ENTRIES: Entries = {
  "Bricks_Color.jpg": COLOR,
  "Bricks_NormalGL.jpg": NORMAL,
  "Bricks_Preview.png": PREVIEW,
};

function member(name: string, bytes: Uint8Array, over: Partial<ZipMember> = {}): ZipMember {
  return {
    map: name.includes("Color") ? "diff" : "nor_gl",
    name,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...over,
  };
}

function members(): ZipMember[] {
  return [member("Bricks_Color.jpg", COLOR), member("Bricks_NormalGL.jpg", NORMAL)];
}

function zipFile(zip: Uint8Array, over: Partial<ManifestFile> = {}): ManifestFile {
  return {
    map: "zip",
    name: "Bricks076C_1K-JPG.zip",
    url: ZIP_URL,
    bytes: zip.byteLength,
    sha256: sha256(zip),
    members: members(),
    ...over,
  };
}

function asset(files: ManifestFile[]): ManifestAsset {
  return { id: "Bricks076C", kind: "texture", licence: CC0, files };
}

async function refusalOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Cc0Error) return error.code;
    throw error;
  }
  return undefined;
}

async function setup(file: ManifestFile) {
  const raw = await tmpDir("cc0-fetch-");
  const target = cachedPath(raw, asset([file]), file);
  return { raw, target, folder: path.dirname(target) };
}

async function filesUnder(folder: string): Promise<string[]> {
  return existsSync(folder) ? (await readdir(folder)).sort() : [];
}

/** Sets a central header's declared expanded size (the local header keeps its own). */
function withDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let at = 0; at + 46 <= out.byteLength; at += 1) {
    const isCentral = view.getUint32(at, true) === 0x02014b50;
    const nameLength = isCentral ? view.getUint16(at + 28, true) : 0;
    if (isCentral && new TextDecoder().decode(out.subarray(at + 46, at + 46 + nameLength)) === name) {
      view.setUint32(at + 24, size, true);
      return out;
    }
  }
  throw new Error(`no central header for ${name}`);
}

/** Flips one byte of `name`'s stored data so its CRC-32 no longer matches. */
function withFlippedByte(zip: Uint8Array, offset: number): Uint8Array {
  const out = zip.slice();
  out[offset] = (out[offset] ?? 0) ^ 0xff;
  return out;
}

describe("a pinned zip's listed members", () => {
  it("are written beside the zip, verified; an unlisted member is left in the zip", async () => {
    const zip = zipOf(GOOD_ENTRIES);
    const file = zipFile(zip);
    const { target, folder } = await setup(file);
    await fetchFile(file, target, false, async () => zip);
    assert.deepEqual(await filesUnder(folder), ["Bricks076C_1K-JPG.zip", "Bricks_Color.jpg", "Bricks_NormalGL.jpg"]);
    assert.deepEqual(new Uint8Array(await readFile(path.join(folder, "Bricks_Color.jpg"))), COLOR);
    assert.deepEqual(new Uint8Array(await readFile(target)), zip);
  });

  it("are restored from the cached zip without a download when one changes on disk", async () => {
    const zip = zipOf(GOOD_ENTRIES);
    const file = zipFile(zip);
    const { target, folder } = await setup(file);
    await fetchFile(file, target, false, async () => zip);
    await writeFile(path.join(folder, "Bricks_NormalGL.jpg"), "corrupted");
    let asked = 0;
    await fetchFile(file, target, false, async () => {
      asked += 1;
      return zip;
    });
    assert.equal(asked, 0);
    assert.deepEqual(new Uint8Array(await readFile(path.join(folder, "Bricks_NormalGL.jpg"))), NORMAL);
  });

  it("are read from a stored (uncompressed) entry as well as a deflated one", () => {
    const zip = zipSync({ "Bricks_Color.jpg": [COLOR, { level: 0 }], "Bricks_NormalGL.jpg": NORMAL });
    const read = unpackedMembers(zip, members(), false, ZIP_LIMITS);
    assert.deepEqual(
      read.map((entry) => entry.digest),
      [sha256(COLOR), sha256(NORMAL)],
    );
  });

  it("refuses an unpinned member without --pin, writing nothing, and records its digest with it", async () => {
    const zip = zipOf(GOOD_ENTRIES);
    const file = zipFile(zip, { members: [member("Bricks_Color.jpg", COLOR, { sha256: null })] });
    const { target, folder } = await setup(file);
    assert.equal(await refusalOf(() => fetchFile(file, target, false, async () => zip)), Cc0Refusal.Unpinned);
    assert.deepEqual(await filesUnder(folder), []);
    await fetchFile(file, target, true, async () => zip);
    assert.equal(file.members?.[0]?.sha256, sha256(COLOR));
  });

  const refusedMembers: [string, ZipMember, string][] = [
    ["a member the zip lacks", member("Bricks_Roughness.jpg", COLOR), Cc0Refusal.ZipMemberMissing],
    [
      "a member whose sha256 differs",
      member("Bricks_Color.jpg", COLOR, { sha256: sha256(NORMAL) }),
      Cc0Refusal.HashMismatch,
    ],
    [
      "a member of another size",
      member("Bricks_Color.jpg", COLOR, { bytes: COLOR.byteLength + 1 }),
      Cc0Refusal.SizeMismatch,
    ],
  ];
  for (const [what, listed, code] of refusedMembers) {
    it(`refuses ${what} with nothing written, the zip included`, async () => {
      const zip = zipOf(GOOD_ENTRIES);
      const file = zipFile(zip, { members: [member("Bricks_NormalGL.jpg", NORMAL), listed] });
      const { target, folder } = await setup(file);
      assert.equal(await refusalOf(() => fetchFile(file, target, false, async () => zip)), code);
      assert.deepEqual(await filesUnder(folder), []);
    });
  }
});

const LINK_ENTRY: [Uint8Array, ZipAttributes] = [
  new TextEncoder().encode("/etc/passwd"),
  { os: UNIX, attrs: (S_IFLNK | 0o777) << 16 },
];
const FOLDER_ENTRY: [Uint8Array, ZipAttributes] = [new Uint8Array(), { os: UNIX, attrs: (S_IFDIR | 0o755) << 16 }];
/** Caps small enough for a test zip to pass them. */
const SMALL_LIMITS: ZipLimits = { maxEntries: 4, maxExpandedBytes: 4096 };
/** Each hostile zip, and the refusal it gets. */
const HOSTILE: [string, () => Uint8Array, string][] = [
  ["a climbing entry (zip-slip)", () => zipOf({ ...GOOD_ENTRIES, "../x": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  [
    "an entry climbing out of a folder",
    () => zipOf({ ...GOOD_ENTRIES, "a/../../x": NORMAL }),
    Cc0Refusal.ZipUnsafeEntry,
  ],
  ["an absolute entry", () => zipOf({ ...GOOD_ENTRIES, "/etc/cron.d/x": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  ["a backslash entry", () => zipOf({ ...GOOD_ENTRIES, "..\\x": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  ["a nested entry", () => zipOf({ ...GOOD_ENTRIES, "maps/x.jpg": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  ["a hidden entry", () => zipOf({ ...GOOD_ENTRIES, ".x": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  ["an entry with a NUL", () => zipOf({ ...GOOD_ENTRIES, "x\0.jpg": NORMAL }), Cc0Refusal.ZipUnsafeEntry],
  [
    "a symlink entry under a plain name",
    () => zipOf({ ...GOOD_ENTRIES, "Bricks_Link.jpg": LINK_ENTRY }),
    Cc0Refusal.ZipUnsafeEntry,
  ],
  [
    "a folder entry under a plain name",
    () => zipOf({ ...GOOD_ENTRIES, maps: FOLDER_ENTRY }),
    Cc0Refusal.ZipUnsafeEntry,
  ],
  [
    "two entries one disk would merge",
    () => zipOf({ ...GOOD_ENTRIES, "BRICKS_COLOR.JPG": NORMAL }),
    Cc0Refusal.ZipUnsafeEntry,
  ],
  [
    "more entries than the cap",
    () => zipOf({ ...GOOD_ENTRIES, "b.jpg": NORMAL, "c.jpg": NORMAL }),
    Cc0Refusal.ZipTooManyEntries,
  ],
  [
    "a bomb past the expanded cap",
    () => zipOf({ ...GOOD_ENTRIES, "bomb.bin": new Uint8Array(64 * 1024) }),
    Cc0Refusal.ZipTooLarge,
  ],
  [
    "a member that inflates past its declared size",
    () =>
      withDeclaredSize(
        zipOf({ "Bricks_Color.jpg": new Uint8Array(256 * 1024), "Bricks_NormalGL.jpg": NORMAL }),
        "Bricks_Color.jpg",
        1024,
      ),
    Cc0Refusal.ZipTooLarge,
  ],
  [
    "a member whose CRC-32 differs",
    () =>
      withFlippedByte(
        zipSync({ "Bricks_Color.jpg": [COLOR, { level: 0 }], "Bricks_NormalGL.jpg": NORMAL }),
        30 + 16 + 3,
      ),
    Cc0Refusal.ZipInvalid,
  ],
  [
    "bytes that are not a zip",
    () => new TextEncoder().encode("not a zip at all, only some text"),
    Cc0Refusal.ZipInvalid,
  ],
  ["a truncated zip", () => zipOf(GOOD_ENTRIES).subarray(0, 40), Cc0Refusal.ZipInvalid],
];
describe("a hostile zip is refused whole, with nothing written", () => {
  for (const [what, make, code] of HOSTILE) {
    it(`refuses ${what}`, async () => {
      const zip = make();
      assert.equal(await refusalOf(() => unpackedMembers(zip, members(), false, SMALL_LIMITS)), code);
    });
  }

  it("refuses an encrypted entry", async () => {
    const zip = zipOf(GOOD_ENTRIES);
    const view = new DataView(zip.buffer);
    for (let at = 0; at + 4 <= zip.byteLength; at += 1) {
      if (view.getUint32(at, true) === 0x02014b50) view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true);
    }
    assert.equal(await refusalOf(() => unpackedMembers(zip, members(), false, ZIP_LIMITS)), Cc0Refusal.ZipInvalid);
  });

  it("refuses a pinned zip with a climbing entry through fetchFile, and writes neither the zip nor a member", async () => {
    const zip = zipOf({ ...GOOD_ENTRIES, "../escape.jpg": NORMAL });
    const file = zipFile(zip);
    const { raw, target, folder } = await setup(file);
    assert.equal(await refusalOf(() => fetchFile(file, target, false, async () => zip)), Cc0Refusal.ZipUnsafeEntry);
    assert.deepEqual(await filesUnder(folder), []);
    assert.deepEqual(await filesUnder(raw), []);
    assert.equal(existsSync(path.join(raw, "escape.jpg")), false);
  });

  it("refuses a regular entry by its Unix mode only when it is not a file", () => {
    const zip = zipOf({
      "Bricks_Color.jpg": [COLOR, { os: UNIX, attrs: (S_IFREG | 0o644) << 16 }],
      "Bricks_NormalGL.jpg": NORMAL,
    });
    assert.equal(unpackedMembers(zip, members(), false, ZIP_LIMITS).length, 2);
  });
});

describe("the manifest's zip and md5 rows", () => {
  it("accepts a zip row with its members and a published md5", () => {
    const zip = zipOf(GOOD_ENTRIES);
    checkManifest({ assets: [asset([zipFile(zip, { md5: md5(zip) })])] });
  });

  const rows: [string, (zip: Uint8Array) => ManifestFile, string][] = [
    ["a zip with no members listed", (zip) => zipFile(zip, { members: [] }), Cc0Refusal.ManifestInvalid],
    [
      "a member with a climbing name",
      (zip) => zipFile(zip, { members: [member("../x.jpg", COLOR)] }),
      Cc0Refusal.UnsafeName,
    ],
    [
      "a member with a malformed digest",
      (zip) => zipFile(zip, { members: [member("a.jpg", COLOR, { sha256: "abc" })] }),
      Cc0Refusal.ManifestInvalid,
    ],
    [
      "a member named like the zip",
      (zip) => zipFile(zip, { members: [member("bricks076c_1k-jpg.ZIP", COLOR)] }),
      Cc0Refusal.ManifestInvalid,
    ],
    ["a malformed md5", (zip) => zipFile(zip, { md5: "not-an-md5" }), Cc0Refusal.ManifestInvalid],
  ];
  for (const [what, make, code] of rows) {
    it(`refuses ${what}`, async () => {
      assert.equal(await refusalOf(() => checkManifest({ assets: [asset([make(zipOf(GOOD_ENTRIES))])] })), code);
    });
  }

  it("cross-checks a published md5 before the sha256 pin", async () => {
    const zip = zipOf(GOOD_ENTRIES);
    assert.equal(verified(zipFile(zip, { md5: md5(zip) }), zip, false), sha256(zip));
    assert.equal(
      await refusalOf(() => verified(zipFile(zip, { md5: md5(COLOR) }), zip, false)),
      Cc0Refusal.HashMismatch,
    );
    assert.equal(
      await refusalOf(() => verified(zipFile(zip, { md5: md5(COLOR), sha256: null }), zip, true)),
      Cc0Refusal.HashMismatch,
    );
  });
});

describe("a link planted in the cache is never written through", () => {
  const BYTES = new TextEncoder().encode("a CC0 texture");
  const plain: ManifestFile = {
    map: "diff",
    name: "dirt_diff_1k.jpg",
    url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/dirt/dirt_diff_1k.jpg",
    bytes: BYTES.byteLength,
    sha256: sha256(BYTES),
  };

  it("replaces a link at the side file and leaves its target as it was", async () => {
    const { raw, target, folder } = await setup(plain);
    const outside = path.join(raw, "outside.txt");
    await writeFile(outside, "untouched");
    await mkdir(folder, { recursive: true });
    await symlink(outside, `${target}.partial`);
    await fetchFile({ ...plain }, target, false, async () => BYTES);
    assert.equal(await readFile(outside, "utf8"), "untouched");
    assert.deepEqual(new Uint8Array(await readFile(target)), BYTES);
  });

  it("refuses an asset folder that is a link out of the cache, writing nothing there", async () => {
    const { raw, target, folder } = await setup(plain);
    const elsewhere = await tmpDir("cc0-fetch-elsewhere-");
    await mkdir(raw, { recursive: true });
    await symlink(elsewhere, folder);
    assert.equal(
      await refusalOf(() => fetchFile({ ...plain }, target, false, async () => BYTES)),
      Cc0Refusal.UnsafeName,
    );
    assert.deepEqual(await filesUnder(elsewhere), []);
  });
});

describe("a download", () => {
  const BODY = new TextEncoder().encode("twelve bytes");
  let server: Server;
  let base = "";
  let userAgent: string | undefined;

  before(async () => {
    server = createServer((request, response) => {
      userAgent = request.headers["user-agent"];
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/file" }).end();
        return;
      }
      if (request.url === "/missing") {
        response.writeHead(404).end();
        return;
      }
      if (request.url === "/chunked") {
        response.writeHead(200);
        response.write(BODY);
        response.end(BODY);
        return;
      }
      response.writeHead(200, { "content-length": BODY.byteLength }).end(BODY);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("answers the body and names its caller", async () => {
    assert.deepEqual(await httpsDownload(new URL(`${base}/file`), BODY.byteLength, "genex-test"), BODY);
    assert.equal(userAgent, "genex-test");
  });

  const refused: [string, string, number, string][] = [
    ["a redirect", "/redirect", BODY.byteLength, Cc0Refusal.DownloadFailed],
    ["an HTTP error", "/missing", BODY.byteLength, Cc0Refusal.DownloadFailed],
    ["a declared length past the manifest's size", "/file", BODY.byteLength - 1, Cc0Refusal.SizeMismatch],
    ["a streamed body past the manifest's size", "/chunked", BODY.byteLength + 1, Cc0Refusal.SizeMismatch],
  ];
  for (const [what, route, maxBytes, code] of refused) {
    it(`refuses ${what}`, async () => {
      assert.equal(await refusalOf(() => httpsDownload(new URL(`${base}${route}`), maxBytes, "genex-test")), code);
    });
  }

  it("passes the manifest's size to the download", async () => {
    const file: ManifestFile = {
      map: "diff",
      name: "a.jpg",
      url: "https://dl.polyhaven.org/a.jpg",
      bytes: 7,
      sha256: null,
    };
    const { target } = await setup(file);
    let cap = 0;
    await fetchFile(file, target, true, async (_url, maxBytes) => {
      cap = maxBytes;
      return new Uint8Array(7);
    });
    assert.equal(cap, 7);
  });
});
