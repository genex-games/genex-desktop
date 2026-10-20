/**
 * The vendored genex-multiplayer crate (`native/genex-rust/crates/genex-multiplayer`) is held to its
 * `PROVENANCE.toml`: every listed file present with its sha256 and size, none added, none missing,
 * no link, and, with the declared rewrites undone and the declared local files left out, the
 * folder hashes to the upstream git tree the pin names. The crate is copied from genex-demo byte for byte (no fork): a fix goes upstream
 * first and arrives as a new pin.
 *
 * The walk never follows a link and never reads a listed path that would leave the folder: a
 * hostile provenance or tree is refused with no read through it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { cp, lstat, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isTable, parseTomlDocument, type TomlTable, type TomlValue } from "../../src/substrate/genex-toml.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const VENDORED = path.join(REPO, "native", "genex-rust", "crates", "genex-multiplayer");
const PROVENANCE_FILE = "PROVENANCE.toml";
const PROVENANCE_SCHEMA = 1;
/** The genex-demo commit and the crate folder's git tree there, as the pin records them. */
const PINNED_COMMIT = "8cd1477a2a120937a1c79fc1c98b99cef3fcc145";
const PINNED_TREE = "d25b243dbf124e33d8fcfa56fe133a1bdd7a337e";
const GIT_FILE_MODE = "100644";
const GIT_TREE_MODE = "40000";
const SKIP_LINKS = process.platform === "win32" ? "symbolic links need privileges on Windows" : false;

/** Why a vendored folder differs from its provenance. Wire values: the rows match them. */
const Drift = {
  /** PROVENANCE.toml is missing, a link, or not the schema below. */
  Provenance: "provenance-invalid",
  /** A listed path is absolute, has a `..`, `.` or empty segment, or a backslash. */
  Escapes: "path-escapes",
  /** An entry of the folder is a link (or not a regular file or folder). */
  Link: "not-a-file",
  Missing: "missing",
  Added: "added",
  Changed: "changed",
  /** A declared rewrite does not apply once, or undoing it is not the upstream bytes. */
  Rewrite: "rewrite-mismatch",
  /** With the rewrites undone, the folder's git tree is not the pinned one. */
  Tree: "tree-mismatch",
} as const;
type Drift = (typeof Drift)[keyof typeof Drift];

interface Finding {
  code: Drift;
  path: string;
}

/** What the check reads through: a test spies on it to prove no read goes through a link. */
interface VendoredIo {
  lstat: (file: string) => Promise<Stats>;
  readdir: (dir: string) => Promise<string[]>;
  readFile: (file: string) => Promise<Buffer>;
}

const realIo: VendoredIo = { lstat, readdir: (dir) => readdir(dir), readFile: (file) => readFile(file) };

interface ListedFile {
  path: string;
  sha256: string;
  bytes: number;
  /** A file this repository adds beside the upstream folder (`local = true`): held to its row, left out of the tree. */
  local: boolean;
}

interface Rewrite {
  file: string;
  upstream: string;
  vendored: string;
  upstreamSha256: string;
}

interface Provenance {
  commit: string;
  tree: string;
  files: ListedFile[];
  rewrites: Rewrite[];
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A folder-relative path as the provenance lists it: `/`-separated, no empty, `.` or `..` segment, never absolute. */
function plainRelative(rel: string): boolean {
  if (rel.startsWith("/") || /[\\\0]/.test(rel) || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function text(value: TomlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function listedFile(row: TomlValue): ListedFile | null {
  if (!isTable(row)) return null;
  const rel = text(row.path);
  const digest = text(row.sha256);
  const bytes = row.bytes;
  const local = row.local ?? false;
  if (rel === null || digest === null || !HEX64.test(digest) || typeof bytes !== "number") return null;
  return typeof local === "boolean" ? { path: rel, sha256: digest, bytes, local } : null;
}

function rewrite(row: TomlValue): Rewrite | null {
  if (!isTable(row)) return null;
  const [file, upstream, vendored, upstreamSha256] = [row.file, row.upstream, row.vendored, row.upstream_sha256].map(
    text,
  );
  if (file === null || upstream === null || vendored === null || upstreamSha256 === null) return null;
  return HEX64.test(upstreamSha256) ? { file, upstream, vendored, upstreamSha256 } : null;
}

function rows<T>(value: TomlValue | undefined, read: (row: TomlValue) => T | null): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed = value.map(read);
  return parsed.every((row) => row !== null) ? (parsed as T[]) : null;
}

/** The provenance document's shape, or null when it is not schema 1. */
function provenanceOf(document: TomlTable): Provenance | null {
  const commit = text(document.commit);
  const tree = text(document.tree);
  if (document.schema !== PROVENANCE_SCHEMA || commit === null || tree === null) return null;
  if (!HEX40.test(commit) || !HEX40.test(tree)) return null;
  const files = rows(document.file, listedFile);
  const rewrites = rows(document.rewrite, rewrite);
  if (files === null || rewrites === null || files.length === 0) return null;
  return { commit, tree, files, rewrites };
}

async function readProvenance(folder: string, io: VendoredIo): Promise<Provenance | null> {
  const file = path.join(folder, PROVENANCE_FILE);
  const info = await io.lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  try {
    return provenanceOf(parseTomlDocument((await io.readFile(file)).toString("utf8")));
  } catch {
    return null;
  }
}

/** Every regular file under `folder` (relative, `/`-separated), and every entry that is not one; links are never followed. */
async function walk(folder: string, io: VendoredIo, rel = ""): Promise<{ files: string[]; refused: string[] }> {
  const files: string[] = [];
  const refused: string[] = [];
  for (const name of (await io.readdir(path.join(folder, rel))).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    const info = await io.lstat(path.join(folder, child));
    if (info.isDirectory()) {
      const inner = await walk(folder, io, child);
      files.push(...inner.files);
      refused.push(...inner.refused);
    } else if (info.isFile()) files.push(child);
    else refused.push(child);
  }
  return { files, refused };
}

/** The git object id of `body` stored as `kind`. */
function gitId(kind: "blob" | "tree", body: Buffer): Buffer {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body]))
    .digest();
}

/** The git tree id of a folder given as relative path to blob id, as `git write-tree` computes it. */
function gitTree(blobs: ReadonlyMap<string, Buffer>): string {
  const children = new Map<string, Map<string, Buffer>>();
  const entries: { name: string; mode: string; id: Buffer }[] = [];
  for (const [rel, id] of blobs) {
    const slash = rel.indexOf("/");
    if (slash === -1) {
      entries.push({ name: rel, mode: GIT_FILE_MODE, id });
      continue;
    }
    const dir = rel.slice(0, slash);
    const inner = children.get(dir) ?? new Map<string, Buffer>();
    inner.set(rel.slice(slash + 1), id);
    children.set(dir, inner);
  }
  for (const [name, inner] of children)
    entries.push({ name, mode: GIT_TREE_MODE, id: Buffer.from(gitTree(inner), "hex") });
  // git orders a tree's entries by name, a folder's name compared as if it ended in "/".
  const key = (entry: { name: string; mode: string }) => (entry.mode === GIT_TREE_MODE ? `${entry.name}/` : entry.name);
  entries.sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const body = Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.id]));
  return gitId("tree", body).toString("hex");
}

/** `bytes` with a declared rewrite undone, or null when the vendored text is not there exactly once. */
function undo(bytes: Buffer, change: Rewrite): Buffer | null {
  const body = bytes.toString("utf8");
  const at = body.indexOf(change.vendored);
  if (at === -1 || body.indexOf(change.vendored, at + 1) !== -1) return null;
  return Buffer.from(body.slice(0, at) + change.upstream + body.slice(at + change.vendored.length));
}

/** The upstream bytes of each file (rewrites undone), or the findings when a rewrite does not undo to them. */
function upstreamBytes(contents: ReadonlyMap<string, Buffer>, provenance: Provenance): Finding[] | Map<string, Buffer> {
  const upstream = new Map(contents);
  const findings: Finding[] = [];
  for (const change of provenance.rewrites) {
    const bytes = contents.get(change.file);
    const undone = bytes === undefined ? null : undo(bytes, change);
    if (undone === null || sha256(undone) !== change.upstreamSha256)
      findings.push({ code: Drift.Rewrite, path: change.file });
    else upstream.set(change.file, undone);
  }
  return findings.length > 0 ? findings : upstream;
}

/** The ways `folder` differs from its PROVENANCE.toml; empty when it is the pinned crate. */
async function checkVendored(folder: string, io: VendoredIo = realIo): Promise<Finding[]> {
  const provenance = await readProvenance(folder, io);
  if (provenance === null) return [{ code: Drift.Provenance, path: PROVENANCE_FILE }];
  const escaping = provenance.files.map((file) => file.path).filter((rel) => !plainRelative(rel));
  const escapingRewrites = provenance.rewrites.map((change) => change.file).filter((rel) => !plainRelative(rel));
  if (escaping.length + escapingRewrites.length > 0)
    return [...escaping, ...escapingRewrites].map((rel) => ({ code: Drift.Escapes, path: rel }));

  const { files, refused } = await walk(folder, io);
  const found = new Set(files.filter((rel) => rel !== PROVENANCE_FILE));
  const listed = new Map(provenance.files.map((file) => [file.path, file]));
  const findings: Finding[] = [
    ...refused.map((rel) => ({ code: Drift.Link, path: rel })),
    ...[...listed.keys()].filter((rel) => !found.has(rel)).map((rel) => ({ code: Drift.Missing, path: rel })),
    ...[...found].filter((rel) => !listed.has(rel)).map((rel) => ({ code: Drift.Added, path: rel })),
  ];
  const contents = new Map<string, Buffer>();
  for (const file of provenance.files) {
    if (!found.has(file.path)) continue;
    const bytes = await io.readFile(path.join(folder, file.path));
    contents.set(file.path, bytes);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      findings.push({ code: Drift.Changed, path: file.path });
  }
  if (findings.length > 0) return findings;

  const upstream = upstreamBytes(contents, provenance);
  if (Array.isArray(upstream)) return upstream;
  const local = new Set(provenance.files.filter((file) => file.local).map((file) => file.path));
  const blobs = new Map(
    [...upstream].filter(([rel]) => !local.has(rel)).map(([rel, bytes]) => [rel, gitId("blob", bytes)]),
  );
  return gitTree(blobs) === provenance.tree ? [] : [{ code: Drift.Tree, path: "." }];
}

/** A copy of the vendored crate to break, in a fresh folder. */
async function vendoredCopy(): Promise<string> {
  const copy = path.join(await tmpDir("rust-vendored-mp-"), "genex-multiplayer");
  await cp(VENDORED, copy, { recursive: true });
  return copy;
}

/** The real io, recording every path read. */
function spiedIo(): VendoredIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    lstat,
    readdir: (dir) => readdir(dir),
    readFile: async (file) => {
      reads.push(file);
      return readFile(file);
    },
  };
}

async function editProvenance(folder: string, edit: (body: string) => string): Promise<void> {
  const file = path.join(folder, PROVENANCE_FILE);
  await writeFile(file, edit(await readFile(file, "utf8")));
}

describe("the vendored genex-multiplayer crate is the pinned upstream folder", () => {
  it("pins the genex-demo commit and crate tree the design names", async () => {
    const provenance = await readProvenance(VENDORED, realIo);
    assert.ok(provenance, "PROVENANCE.toml is schema 1");
    assert.deepEqual([provenance.commit, provenance.tree], [PINNED_COMMIT, PINNED_TREE]);
  });

  it("matches PROVENANCE.toml file by file, and hashes to the upstream git tree with its rewrites undone", async () => {
    assert.deepEqual(await checkVendored(VENDORED), []);
  });

  it("finds a one-byte change, naming the file", async () => {
    const copy = await vendoredCopy();
    const file = path.join(copy, "src", "interp.rs");
    const bytes = await readFile(file);
    bytes[100] = bytes[100] === 0x20 ? 0x21 : 0x20;
    await writeFile(file, bytes);
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Changed, path: "src/interp.rs" }]);
  });

  it("finds an added file and a missing file", async () => {
    const copy = await vendoredCopy();
    await writeFile(path.join(copy, "src", "patch.rs"), "pub fn fork() {}\n");
    await rm(path.join(copy, "examples", "smoke.rs"));
    assert.deepEqual(await checkVendored(copy), [
      { code: Drift.Missing, path: "examples/smoke.rs" },
      { code: Drift.Added, path: "src/patch.rs" },
    ]);
  });

  it("finds a file changed together with its row: the tree no longer is the upstream one", async () => {
    const copy = await vendoredCopy();
    const file = path.join(copy, "build.rs");
    const changed = Buffer.concat([await readFile(file), Buffer.from("// local fix\n")]);
    await writeFile(file, changed);
    await editProvenance(copy, (body) =>
      body
        .replace("f8c751f7ae414e8ec46c472a7443d6fe7f918c6e94a39333a40d6c114a73da46", sha256(changed))
        .replace("bytes = 6677", `bytes = ${changed.length}`),
    );
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Tree, path: "." }]);
  });

  it("finds a manifest edit beyond the declared edition rewrite", async () => {
    const copy = await vendoredCopy();
    const file = path.join(copy, "Cargo.toml");
    const changed = Buffer.from((await readFile(file, "utf8")).replace('edition = "2021"', 'edition = "2024"'));
    await writeFile(file, changed);
    await editProvenance(copy, (body) =>
      body.replace("a9ffddbeaf0460118a22a17eb124e04326c39dc75ae210f6af55aeb99c74fbf1", sha256(changed)),
    );
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Rewrite, path: "Cargo.toml" }]);
  });

  it("holds the declared local clippy.toml to its row, and leaves it out of the upstream tree", async () => {
    const provenance = await readProvenance(VENDORED, realIo);
    assert.deepEqual(
      provenance?.files.filter((file) => file.local).map((file) => file.path),
      ["clippy.toml"],
    );
    const copy = await vendoredCopy();
    await writeFile(path.join(copy, "clippy.toml"), "disallowed-types = []\n");
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Changed, path: "clippy.toml" }]);
    await editProvenance(copy, (body) => body.replace("local = true", "local = false"));
    await writeFile(path.join(copy, "clippy.toml"), await readFile(path.join(VENDORED, "clippy.toml")));
    assert.deepEqual(
      await checkVendored(copy),
      [{ code: Drift.Tree, path: "." }],
      "an undeclared addition moves the tree",
    );
  });

  it("refuses a provenance that is missing or not schema 1", async () => {
    const copy = await vendoredCopy();
    await editProvenance(copy, (body) => body.replace("schema = 1", "schema = 2"));
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Provenance, path: PROVENANCE_FILE }]);
    await rm(path.join(copy, PROVENANCE_FILE));
    assert.deepEqual(await checkVendored(copy), [{ code: Drift.Provenance, path: PROVENANCE_FILE }]);
  });
});

describe("a hostile vendored folder or provenance is refused with no read through it", () => {
  const ESCAPING = ["../outside.rs", "/etc/hosts", "src/../../outside.rs", "src\\..\\..\\outside.rs", "./src/lib.rs"];

  for (const hostile of ESCAPING)
    it(`refuses the listed path ${JSON.stringify(hostile)} before reading any listed file`, async () => {
      const copy = await vendoredCopy();
      await writeFile(path.join(path.dirname(copy), "outside.rs"), "pub fn outside() {}\n");
      await editProvenance(copy, (body) => body.replace('path = "src/web.rs"', `path = ${JSON.stringify(hostile)}`));
      const io = spiedIo();
      assert.deepEqual(await checkVendored(copy, io), [{ code: Drift.Escapes, path: hostile }]);
      assert.deepEqual(io.reads, [path.join(copy, PROVENANCE_FILE)], "only the provenance itself was read");
    });

  it("refuses a rewrite naming a path outside the folder, reading nothing else", async () => {
    const copy = await vendoredCopy();
    await editProvenance(copy, (body) => body.replace('file = "Cargo.toml"', 'file = "../Cargo.toml"'));
    const io = spiedIo();
    assert.deepEqual(await checkVendored(copy, io), [{ code: Drift.Escapes, path: "../Cargo.toml" }]);
    assert.deepEqual(io.reads, [path.join(copy, PROVENANCE_FILE)]);
  });

  it("refuses a listed file that is a link, never reading through it", { skip: SKIP_LINKS }, async () => {
    const copy = await vendoredCopy();
    const target = path.join(path.dirname(copy), "elsewhere.rs");
    await writeFile(target, await readFile(path.join(copy, "src", "stamp.rs")));
    await rm(path.join(copy, "src", "stamp.rs"));
    await symlink(target, path.join(copy, "src", "stamp.rs"));
    const io = spiedIo();
    assert.deepEqual(await checkVendored(copy, io), [
      { code: Drift.Link, path: "src/stamp.rs" },
      { code: Drift.Missing, path: "src/stamp.rs" },
    ]);
    assert.equal(
      io.reads.some((file) => file.endsWith("stamp.rs") || file === target),
      false,
      "nothing was read through the link",
    );
  });

  it("refuses a linked folder, never walking into it", { skip: SKIP_LINKS }, async () => {
    const copy = await vendoredCopy();
    const elsewhere = path.join(path.dirname(copy), "native-elsewhere");
    await cp(path.join(copy, "src", "native"), elsewhere, { recursive: true });
    await rm(path.join(copy, "src", "native"), { recursive: true });
    await symlink(elsewhere, path.join(copy, "src", "native"));
    const io = spiedIo();
    const findings = await checkVendored(copy, io);
    assert.deepEqual(findings[0], { code: Drift.Link, path: "src/native" });
    assert.deepEqual(
      findings.slice(1).map((finding) => finding.code),
      [Drift.Missing, Drift.Missing, Drift.Missing, Drift.Missing, Drift.Missing],
    );
    assert.equal(
      io.reads.some((file) => file.includes(`${path.sep}native${path.sep}`) || file.startsWith(elsewhere)),
      false,
      "nothing under the linked folder was read",
    );
  });

  it("refuses a provenance file that is a link, reading nothing", { skip: SKIP_LINKS }, async () => {
    const copy = await vendoredCopy();
    const outside = path.join(path.dirname(copy), "provenance-elsewhere.toml");
    await cp(path.join(copy, PROVENANCE_FILE), outside);
    await rm(path.join(copy, PROVENANCE_FILE));
    await symlink(outside, path.join(copy, PROVENANCE_FILE));
    const io = spiedIo();
    assert.deepEqual(await checkVendored(copy, io), [{ code: Drift.Provenance, path: PROVENANCE_FILE }]);
    assert.deepEqual(io.reads, []);
  });
});

describe("the tree id is git's", () => {
  it("orders a folder as if its name ended in a slash, as git write-tree does", () => {
    const blobs = new Map([
      ["a-b", gitId("blob", Buffer.from("x\n"))],
      ["a/b", gitId("blob", Buffer.from("y\n"))],
      ["a.c", gitId("blob", Buffer.from(""))],
    ]);
    // `git write-tree` of a-b ("x\n"), a/b ("y\n") and an empty a.c prints this id.
    assert.equal(gitTree(blobs), "15ed736206e2f38abc66df0a70c0a4ea1838dd8b");
  });
});
