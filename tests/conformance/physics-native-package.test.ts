/**
 * What `scripts/physics-native.ts` ships and what it refuses to ship.
 *
 * - Unit rows (any host): a binary is refused for an absolute path of the build machine, an
 *   imported socket call, and on Linux for anything but an x86_64 glibc executable needing glibc
 *   ≤ 2.28 with no `DT_RPATH` and no `DT_RUNPATH` (synthetic ELF images, `tests/helpers/elf.ts`).
 * - Package rows read the built `.studio-dev/build/physics-native/` and its tarball in
 *   `.studio-dev/dist/` (`node scripts/physics-native.ts`), and skip without them
 *   (`GENEX_REQUIRE_TOOLCHAINS=1` makes their absence a failure): the tarball's sha256 file, its
 *   exact file list, the manifest's exact dependency, `binaries.json` against each binary, the
 *   size report, and each binary passing the refusals above (for Linux: glibc ≤ 2.28, no RPATH).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { binaryRefusals, NativeTarget, networkImports } from "../../scripts/physics-native.ts";
import { writeElf } from "../helpers/elf.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const PACKAGE = path.join(REPO, ".studio-dev/build/physics-native");
const PHYSICS_MANIFEST = path.join(REPO, "native/genex-rust/crates/genex-physics/js/package.json");
const BINARY = "genex-physics-room";
/** Every file the tarball may hold, under npm's `package/` folder (a built target's binary at least). */
const ALLOWED = [
  "CONTRACT.md",
  "LICENSE",
  "README.md",
  "THIRD-PARTY-NOTICES.md",
  "binaries.json",
  "index.d.ts",
  "native.d.ts",
  "native.js",
  "package.json",
  `native/${NativeTarget.DarwinArm64}/${BINARY}`,
  `native/${NativeTarget.LinuxX64Gnu}/${BINARY}`,
];
/** What the binary may weigh: about 3 MB stripped; a debug build or a lost `strip` is several times that. */
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const NEEDLES = ["/build/repo"];
/** A Rust binary linked for glibc 2.28 with no search path, as zigbuild writes one. */
const GOOD_LINUX = { needed: ["libgcc_s.so.1", "libc.so.6"], runpath: [] as string[] };

describe("the native binary's refusals", () => {
  it("finds an imported socket call in either spelling, and nothing in a clean string table", () => {
    const table = (names: string[]) => new Uint8Array(Buffer.from(`\0${names.join("\0")}\0`, "latin1"));
    assert.deepEqual(networkImports(table(["read", "socket", "write"])), ["socket"]);
    assert.deepEqual(networkImports(table(["_read", "_connect", "_getaddrinfo"])), ["connect", "getaddrinfo"]);
    assert.deepEqual(networkImports(table(["read", "sockets_of_the_world", "rebind"])), []);
  });

  const linuxRows: [string, Parameters<typeof writeElf>[0], RegExp | undefined][] = [
    ["a glibc 2.28 executable with no search path", GOOD_LINUX, undefined],
    ["a DT_RUNPATH, even $ORIGIN", { ...GOOD_LINUX, runpath: ["$ORIGIN"] }, /DT_RUNPATH/],
    ["a DT_RPATH", { ...GOOD_LINUX, rpath: ["/opt/lib"] }, /rpath/i],
    [
      "a glibc symbol above 2.28",
      { ...GOOD_LINUX, versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.34"] }] },
      /2\.34/,
    ],
    ["an aarch64 executable", { ...GOOD_LINUX, machine: 183 }, /machine/i],
    ["a library outside glibc", { ...GOOD_LINUX, needed: ["libssl.so.3", "libc.so.6"] }, /libssl/],
  ];
  for (const [name, spec, refused] of linuxRows) {
    it(`${refused ? "refuses" : "admits"} a Linux binary with ${name}`, () => {
      const found = binaryRefusals(writeElf(spec).bytes, NativeTarget.LinuxX64Gnu, NEEDLES);
      if (refused === undefined) assert.deepEqual(found, []);
      else
        assert.ok(
          found.some((reason) => refused.test(reason)),
          found.join("; "),
        );
    });
  }

  it("refuses a binary holding a build path or a home folder, on either target", () => {
    const withPath = Buffer.concat([writeElf(GOOD_LINUX).bytes, Buffer.from("\0/build/repo/src/main.rs\0")]);
    assert.match(binaryRefusals(withPath, NativeTarget.LinuxX64Gnu, NEEDLES).join(";"), /local paths/);
    const mac = Buffer.from("\0\0\0panicked at /Users/someone/x.rs\0_socket\0", "latin1");
    const reasons = binaryRefusals(mac, NativeTarget.DarwinArm64, NEEDLES).join(";");
    assert.match(reasons, /local paths/);
    assert.match(reasons, /network calls: socket/);
  });
});

/** The newest tarball of this package in `.studio-dev/dist/`, by the manifest's version. */
function tarball(): string {
  const { version } = JSON.parse(readFileSync(PHYSICS_MANIFEST, "utf8")) as { version: string };
  return path.join(REPO, ".studio-dev/dist", `genex-ai-physics-native-${version}.tgz`);
}

function needsBuild(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "binaries.json")) && existsSync(tarball())) return {};
  const missing = `the native physics package (${PACKAGE} and its tarball; node scripts/physics-native.ts)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("the built @genex-ai/physics-native package", needsBuild(), () => {
  it("has a sha256 file naming its tarball's digest, and only the allowed files", () => {
    const file = tarball();
    assert.equal(readFileSync(`${file}.sha256`, "utf8"), `${sha256(readFileSync(file))}  ${path.basename(file)}\n`);
    const listed = execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.replace(/^package\//, ""))
      .sort();
    const unexpected = listed.filter((name) => !ALLOWED.includes(name));
    assert.deepEqual(unexpected, [], "no file outside the allowed list (no node_modules, no size report)");
    assert.ok(
      listed.some((name) => name.endsWith(BINARY)),
      "at least one binary",
    );
    for (const name of ALLOWED.filter((name) => !name.startsWith("native/"))) assert.ok(listed.includes(name), name);
  });

  it("depends on exactly the @genex-ai/physics of its own version", () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    const physics = JSON.parse(readFileSync(PHYSICS_MANIFEST, "utf8"));
    assert.equal(manifest.name, "@genex-ai/physics-native");
    assert.equal(manifest.version, physics.version);
    assert.deepEqual(manifest.dependencies, { [physics.name]: physics.version });
  });

  it("lists each binary's sha256 and size, each passing the refusals, within its size budget", () => {
    const listed = JSON.parse(readFileSync(path.join(PACKAGE, "binaries.json"), "utf8")) as Record<
      string,
      { sha256: string; bytes: number }
    >;
    const size = JSON.parse(readFileSync(path.join(PACKAGE, "size.json"), "utf8"));
    assert.ok(Object.keys(listed).length > 0);
    for (const [target, entry] of Object.entries(listed)) {
      const relative = `native/${target}/${BINARY}`;
      const bytes = readFileSync(path.join(PACKAGE, relative));
      assert.equal(sha256(bytes), entry.sha256, target);
      assert.equal(bytes.length, entry.bytes, target);
      assert.ok(bytes.length < MAX_BINARY_BYTES, `${target}: ${bytes.length} bytes`);
      assert.equal(size.files[relative].bytes, bytes.length, `${target}: the size report`);
      const needles = [REPO, os.homedir()];
      assert.deepEqual(binaryRefusals(bytes, target as NativeTarget, needles), [], target);
    }
  });

  it("ships a Linux x64 binary needing glibc 2.28 at most, with no RPATH", (t) => {
    const linux = path.join(PACKAGE, "native", NativeTarget.LinuxX64Gnu, BINARY);
    if (!existsSync(linux)) {
      t.skip("built without --target linux-x64-gnu");
      return;
    }
    assert.deepEqual(binaryRefusals(readFileSync(linux), NativeTarget.LinuxX64Gnu, [REPO, os.homedir()]), []);
  });
});
