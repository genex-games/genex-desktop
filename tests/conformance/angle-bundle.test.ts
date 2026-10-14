/**
 * Every Genex build ships the pinned ANGLE for all three desktop targets (owner decision
 * 2026-10-01): `native/angle/bundle-lock.json` pins each build by its `manifest.json`,
 * `scripts/bundle-angle.mjs` verifies the sources and copies them into the app's resources (all or
 * nothing in a release build), and the toolchain store installs ANGLE from that copy, verified
 * again, never from a download. A Developer ID build re-signs the Mac libraries, so the bundle
 * keeps their original signatures and the store restores the pinned bytes before it checks them.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AngleBundleError, angleSources, bundleAngle, fetchArgv } from "../../scripts/bundle-angle.mjs";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  ToolchainProblem,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import {
  ArtifactError,
  ArtifactFault,
  restoreSigned,
  SIGNATURES_FILE,
  signatureRecord,
} from "../../src/substrate/toolchain-store/artifact.ts";
import {
  ANGLE_COMPONENT,
  ANGLE_TARGETS,
  AngleTarget,
  appResourcesDir,
  BUNDLE_LOCK,
  type BundleLock,
  BundleState,
  bundledFolder,
  bundledState,
  isBundled,
  parseBundleLock,
  verifyAngleBundle,
} from "../../src/substrate/toolchain-store/bundled.ts";
import {
  installBundledArtifact,
  installComponents,
  ReceiptSource,
  readReceipts,
} from "../../src/substrate/toolchain-store/install.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const COMMIT = BUNDLE_LOCK.commit;
const COMMIT12 = COMMIT.slice(0, 12);
const MAC = AngleTarget.MacArm64Metal;
const POSIX_ONLY = process.platform === "win32" ? { skip: "FIFOs and symlinks are POSIX" } : {};
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---------- a synthetic Mach-O, signed and re-signed ----------

const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const SEGMENT_BYTES = 72;
const CODE_SIGNATURE_BYTES = 16;
const HEADER_BYTES = 32 + SEGMENT_BYTES + CODE_SIGNATURE_BYTES;
/** Where the load commands keep what signing rewrites: __LINKEDIT's filesize and the signature's datasize. */
const LINKEDIT_FILESIZE_AT = 32 + 48;
const DATAOFF_AT = 32 + SEGMENT_BYTES + 8;
const DATASIZE_AT = DATAOFF_AT + 4;

/** A thin arm64 dylib's shape: header, __LINKEDIT, LC_CODE_SIGNATURE, `code`, then `signature` at a 16-aligned offset. */
function machO(code: Buffer, signature: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(6, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(SEGMENT_BYTES + CODE_SIGNATURE_BYTES, 20);
  header.writeUInt32LE(LC_SEGMENT_64, 32);
  header.writeUInt32LE(SEGMENT_BYTES, 36);
  header.write("__LINKEDIT", 40, "latin1");
  const codeLimit = Math.ceil((HEADER_BYTES + code.length) / 16) * 16;
  header.writeBigUInt64LE(BigInt(HEADER_BYTES), 32 + 40);
  header.writeBigUInt64LE(BigInt(codeLimit - HEADER_BYTES + signature.length), LINKEDIT_FILESIZE_AT);
  header.writeUInt32LE(LC_CODE_SIGNATURE, 32 + SEGMENT_BYTES);
  header.writeUInt32LE(CODE_SIGNATURE_BYTES, 32 + SEGMENT_BYTES + 4);
  header.writeUInt32LE(codeLimit, DATAOFF_AT);
  header.writeUInt32LE(signature.length, DATASIZE_AT);
  const padding = Buffer.alloc(codeLimit - HEADER_BYTES - code.length);
  return Buffer.concat([header, code, padding, signature]);
}

/** What a signing walk does to `signed`: a new signature in place of the old, its sizes rewritten in the load commands. */
function resign(signed: Buffer, signature: Buffer): Buffer {
  const codeLimit = signed.readUInt32LE(DATAOFF_AT);
  const head = Buffer.from(signed.subarray(0, codeLimit));
  head.writeUInt32LE(signature.length, DATASIZE_AT);
  head.writeBigUInt64LE(BigInt(codeLimit - HEADER_BYTES + signature.length), LINKEDIT_FILESIZE_AT);
  return Buffer.concat([head, signature]);
}

const EGL = machO(Buffer.from("egl code ".repeat(40)), Buffer.from("adhoc-signature-egl"));
const GLES = machO(Buffer.from("gles code ".repeat(90)), Buffer.from("adhoc-signature-gles"));

// ---------- synthetic ANGLE builds and their lock ----------

/** Each target's files, as angle.yml stages them (libraries, headers, licences). */
const FILES: Record<AngleTarget, Record<string, Buffer>> = {
  [AngleTarget.MacArm64Metal]: {
    "libEGL.dylib": EGL,
    "libGLESv2.dylib": GLES,
    "include/EGL/egl.h": Buffer.from("/* egl.h */\n"),
    "licenses/angle.txt": Buffer.from("ANGLE BSD-3-Clause\n"),
  },
  [AngleTarget.WindowsX64D3d11]: {
    "libEGL.dll": Buffer.from("MZ egl dll"),
    "libGLESv2.dll": Buffer.from("MZ gles dll"),
    "d3dcompiler_47.dll": Buffer.from("MZ d3dcompiler"),
    "licenses/angle.txt": Buffer.from("ANGLE BSD-3-Clause\n"),
  },
  [AngleTarget.LinuxX64Vulkan]: {
    "libEGL.so": Buffer.from("\x7fELF egl"),
    "libGLESv2.so": Buffer.from("\x7fELF gles"),
    "vk_swiftshader_icd.json": Buffer.from("{}\n"),
    "licenses/SwiftShader.txt": Buffer.from("Apache-2.0\n"),
  },
};

/** angle.yml's `manifest.json` for `files`. */
function manifestOf(target: string, files: Record<string, Buffer>, commit = COMMIT): Buffer {
  const listed = Object.fromEntries(
    Object.entries(files).map(([rel, bytes]) => [rel, { sha256: sha256(bytes), size: bytes.length }]),
  );
  const manifest = { schema: 1, target, commit, builtAt: "2026-09-30T22:39:46Z", files: listed };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** The pin of a manifest and its files. */
function pinOf(manifest: Buffer, files: Record<string, Buffer>) {
  return {
    manifestSha256: sha256(manifest),
    manifestBytes: manifest.length,
    files: Object.keys(files).length,
    bytes: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
  };
}

/** A lock pinning the synthetic builds, with `target`'s pin taken from `manifest` when given. */
function lockFor(overrides: Partial<Record<AngleTarget, Buffer>> = {}): BundleLock {
  const targets = Object.fromEntries(
    ANGLE_TARGETS.map((target) => {
      const manifest = overrides[target] ?? manifestOf(target, FILES[target]);
      return [target, pinOf(manifest, FILES[target])];
    }),
  );
  const lock = parseBundleLock({ schema: 1, commit: COMMIT, run: BUNDLE_LOCK.run, targets });
  assert.ok(lock, "the synthetic lock parses");
  return lock;
}

/** Writes one build the way `gh run download` lays an artifact out: `<source>/angle-<target>-<commit12>/`. */
async function writeBuild(folder: string, target: AngleTarget, manifest = manifestOf(target, FILES[target])) {
  for (const [rel, bytes] of Object.entries(FILES[target])) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), bytes, {
      mode: rel.endsWith(".txt") || rel.endsWith(".h") ? 0o644 : 0o755,
    });
  }
  await writeFile(path.join(folder, "manifest.json"), manifest);
}

/** A temp checkout's worth of folders: angle.yml's downloaded artifacts, an app's resources, a store, and somewhere outside. */
async function fixture() {
  const root = await realpath(await tmpDir("angle-bundle-"));
  const source = path.join(root, "angle-artifacts");
  const resources = path.join(root, "dist", "resources");
  const store = path.join(root, "store");
  const outside = path.join(root, "outside");
  for (const target of ANGLE_TARGETS) await writeBuild(path.join(source, `angle-${target}-${COMMIT12}`), target);
  await mkdir(resources, { recursive: true });
  await mkdir(store, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "GENEX_OUTSIDE_SECRET");
  return { root, source, resources, store, outside, macSource: path.join(source, `angle-${MAC}-${COMMIT12}`) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Every file under `dir` with its sha256 (a link as its target text), so "nothing changed" is one comparison. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    if (entry.isSymbolicLink()) out[rel] = "link";
    else if (entry.isFile()) out[rel] = sha256(await readFile(full));
    else if (!entry.isDirectory()) out[rel] = "special";
  }
  return out;
}

/** The silent sink a dev-mode bundle warns into. */
function warnings(): { lines: string[]; warn: (line: string) => void } {
  const lines: string[] = [];
  return { lines, warn: (line) => lines.push(line) };
}

/** The synthetic Mac ANGLE as a store entry, bundled by `lock`. */
function macEntry(lock: BundleLock): ToolchainEntry {
  const pin = lock.targets[MAC];
  return {
    id: ToolchainId.AngleMac,
    version: COMMIT12,
    host: null,
    target: BuildTarget.Mac,
    archives: [],
    licence: "BSD-3-Clause",
    local: { ...pin, reason: ToolchainUnhosted.NotPublished },
  };
}

// ---------- the lock ----------

describe("the bundle lock", () => {
  it("names native/angle/recipe.json's commit and exactly its build targets", async () => {
    const recipe = JSON.parse(await readFile(path.join(REPO, "native/angle/recipe.json"), "utf8"));
    assert.equal(BUNDLE_LOCK.commit, recipe.angle.commit);
    assert.deepEqual(Object.keys(recipe.targets).sort(), [...ANGLE_TARGETS].sort());
    assert.deepEqual(Object.keys(BUNDLE_LOCK.targets).sort(), [...ANGLE_TARGETS].sort());
  });

  it("pins every ANGLE entry of the store's manifest, which the app therefore bundles", () => {
    for (const target of ANGLE_TARGETS) {
      const entry = manifestEntry(ANGLE_COMPONENT[target], ToolchainHost.MacArm64);
      assert.ok(entry?.local, target);
      assert.equal(entry.version, COMMIT12);
      const { reason: _reason, ...pin } = entry.local;
      assert.deepEqual(pin, BUNDLE_LOCK.targets[target], `${target}'s store pin is the lock's`);
      assert.equal(isBundled(entry), true, `${target} is bundled`);
    }
  });

  it("names the angle.yml run its artifacts come from", () => {
    assert.equal(BUNDLE_LOCK.run.workflow, "angle.yml");
    assert.ok(BUNDLE_LOCK.run.id > 0);
    assert.match(BUNDLE_LOCK.run.expires, /^\d{4}-\d{2}-\d{2}$/);
  });

  const good = { schema: 1, commit: COMMIT, run: BUNDLE_LOCK.run, targets: BUNDLE_LOCK.targets };
  const malformed: Array<[string, unknown]> = [
    ["another schema", { ...good, schema: 2 }],
    ["a short commit", { ...good, commit: COMMIT12 }],
    ["no run", { ...good, run: undefined }],
    ["a target missing", { ...good, targets: { [MAC]: BUNDLE_LOCK.targets[MAC] } }],
    [
      "an extra target",
      { ...good, targets: { ...BUNDLE_LOCK.targets, "android-arm64-vulkan": BUNDLE_LOCK.targets[MAC] } },
    ],
    [
      "a digest that is not sha256",
      { ...good, targets: { ...BUNDLE_LOCK.targets, [MAC]: { ...BUNDLE_LOCK.targets[MAC], manifestSha256: "abc" } } },
    ],
    [
      "a negative size",
      { ...good, targets: { ...BUNDLE_LOCK.targets, [MAC]: { ...BUNDLE_LOCK.targets[MAC], bytes: -1 } } },
    ],
  ];
  for (const [name, value] of malformed)
    it(`refuses a lock with ${name}`, () => {
      assert.equal(parseBundleLock(value), null);
    });

  it("an ANGLE entry with another pin is not bundled", () => {
    const lock = lockFor();
    const entry = macEntry(lock);
    const { local } = entry;
    assert.ok(local);
    assert.equal(isBundled(entry, lock), true);
    assert.equal(isBundled({ ...entry, local: { ...local, manifestSha256: "f".repeat(64) } }, lock), false);
    assert.equal(isBundled({ ...entry, version: "000000000000" }, lock), false);
    assert.equal(isBundled({ ...entry, id: ToolchainId.Ninja }, lock), false);
  });
});

describe("where the app's resources are", () => {
  const rows: Array<[string, string, string]> = [
    [
      "from source: the checkout's last build",
      "/repo/src/substrate/toolchain-store/bundled.ts",
      "/repo/dist/resources",
    ],
    ["from the main bundle", "/repo/dist/main/main.mjs", "/repo/dist/resources"],
    ["from a developer build", "/repo/.studio-dev/builds/b1/main/main.mjs", "/repo/.studio-dev/builds/b1/resources"],
    [
      "from a packaged app: the unpacked copy",
      "/Applications/Genex.app/Contents/Resources/app.asar/dist/main/main.mjs",
      "/Applications/Genex.app/Contents/Resources/app.asar.unpacked/dist/resources",
    ],
  ];
  for (const [name, file, resources] of rows)
    it(name, POSIX_ONLY, () => {
      assert.equal(appResourcesDir(pathToFileURL(file).href), resources);
    });
});

// ---------- bundling ----------

describe("bundling ANGLE into the app's resources (scripts/bundle-angle.mjs)", () => {
  it("copies every build, verified, with its manifest and the Mac libraries' signatures", async () => {
    const made = await fixture();
    const lock = lockFor();
    const result = await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    assert.deepEqual(
      result.copied.map((copy: { target: string }) => copy.target),
      [...ANGLE_TARGETS],
    );
    assert.deepEqual(result.skipped, []);
    for (const target of ANGLE_TARGETS) {
      const folder = bundledFolder(made.resources, target, lock);
      assert.equal(folder, path.join(made.resources, "angle", target, COMMIT12));
      const expected = Object.fromEntries(Object.entries(FILES[target]).map(([rel, bytes]) => [rel, sha256(bytes)]));
      const held = await tree(folder);
      assert.equal(held["manifest.json"], sha256(manifestOf(target, FILES[target])));
      const signatures = held[SIGNATURES_FILE];
      delete held["manifest.json"];
      delete held[SIGNATURES_FILE];
      assert.deepEqual(held, expected, `${target} holds exactly its listed files`);
      assert.equal(signatures !== undefined, target === MAC, "only the Mac build has signed libraries");
    }
    const records = JSON.parse(
      await readFile(path.join(bundledFolder(made.resources, MAC, lock), SIGNATURES_FILE), "utf8"),
    );
    assert.deepEqual(Object.keys(records.files).sort(), ["libEGL.dylib", "libGLESv2.dylib"]);
    const checks = await verifyAngleBundle(made.resources, lock);
    assert.ok(
      checks.every((check) => check.ok),
      JSON.stringify(checks),
    );
    assert.deepEqual(
      await readdir(path.join(made.resources, "angle")),
      [...ANGLE_TARGETS].sort(),
      "no staging is left",
    );
  });

  it("replaces an earlier bundle whole, and nothing else under resources/angle survives", async () => {
    const made = await fixture();
    const lock = lockFor();
    await mkdir(path.join(made.resources, "angle", "stale-target"), { recursive: true });
    await writeFile(path.join(made.resources, "angle", "stale-target", "old.dylib"), "old");
    await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    const first = await tree(made.resources);
    await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    assert.deepEqual(await tree(made.resources), first);
    assert.equal(existsSync(path.join(made.resources, "angle", "stale-target")), false);
  });

  it("reads a developer's cache when no artifact folder is named", async () => {
    const root = await realpath(await tmpDir("angle-dev-cache-"));
    const sources = angleSources({ root, source: null, lock: lockFor() });
    assert.deepEqual(sources, {
      [AngleTarget.MacArm64Metal]: path.join(root, ".studio-dev", "toolchains", "angle-macos-arm64-metal", COMMIT12),
      [AngleTarget.WindowsX64D3d11]: path.join(root, ".studio-dev", "toolchains", "angle-windows-x64-d3d11", COMMIT12),
      [AngleTarget.LinuxX64Vulkan]: path.join(root, ".studio-dev", "toolchains", "angle-linux-x64-vulkan", COMMIT12),
    });
    const named = angleSources({ root, source: "/ci/angle", lock: lockFor() });
    assert.equal(named[MAC], path.join("/ci/angle", `angle-${MAC}-${COMMIT12}`));
  });

  it("a developer build without one target warns, skips it and bundles the rest", async () => {
    const made = await fixture();
    const lock = lockFor();
    await rm(made.macSource, { recursive: true });
    const { lines, warn } = warnings();
    const result = await bundleAngle({ resources: made.resources, release: false, source: made.source, lock, warn });
    assert.deepEqual(result.skipped, [
      { target: MAC, fault: ArtifactFault.Missing, detail: result.skipped[0]?.detail },
    ]);
    assert.ok(
      lines.some((line) => line.includes(MAC)),
      "the warning names the target",
    );
    assert.equal(existsSync(bundledFolder(made.resources, MAC, lock)), false);
    assert.equal(existsSync(bundledFolder(made.resources, AngleTarget.LinuxX64Vulkan, lock)), true);
  });

  it("a release build without one target fails closed and bundles nothing", async () => {
    const made = await fixture();
    const lock = lockFor();
    await rm(made.macSource, { recursive: true });
    await assert.rejects(
      () => bundleAngle({ resources: made.resources, release: true, source: made.source, lock }),
      (error: unknown) =>
        error instanceof AngleBundleError &&
        error.problems.length === 1 &&
        error.problems[0]?.target === MAC &&
        error.problems[0]?.fault === ArtifactFault.Missing,
    );
    assert.equal(existsSync(path.join(made.resources, "angle")), false);
  });

  it("refuses a lock whose commit is not native/angle/recipe.json's, in either mode", async () => {
    const made = await fixture();
    const lock = { ...lockFor(), commit: "0".repeat(40) };
    for (const release of [true, false])
      await assert.rejects(
        () => bundleAngle({ resources: made.resources, release, source: made.source, lock }),
        /recipe/,
      );
    assert.equal(existsSync(path.join(made.resources, "angle")), false);
  });

  /** Sources the bundle refuses, each with its fault; `lock` re-pins the Mac build where the manifest itself changes. */
  const HOSTILE: Array<{
    name: string;
    fault: ArtifactFault;
    only?: { skip?: string };
    make: (made: Fixture) => Promise<BundleLock | undefined>;
  }> = [
    {
      name: "a tampered library (same size, other bytes)",
      fault: ArtifactFault.FileDigest,
      make: async (made) => {
        const tampered = Buffer.from(GLES);
        tampered[HEADER_BYTES + 3] ^= 0xff;
        await writeFile(path.join(made.macSource, "libGLESv2.dylib"), tampered);
        return undefined;
      },
    },
    {
      name: "an unlisted extra file",
      fault: ArtifactFault.Unlisted,
      make: async (made) => {
        await writeFile(path.join(made.macSource, "include", "EGL", "extra.h"), "/* not in the manifest */");
        return undefined;
      },
    },
    {
      name: "a signatures.json in a build's own folder",
      fault: ArtifactFault.Unlisted,
      make: async (made) => {
        await writeFile(path.join(made.macSource, SIGNATURES_FILE), "{}");
        return undefined;
      },
    },
    {
      name: "a listed library that is a link out of the folder",
      fault: ArtifactFault.NotRegular,
      only: POSIX_ONLY,
      make: async (made) => {
        await rm(path.join(made.macSource, "libEGL.dylib"));
        await symlink(path.join(made.outside, "secret.txt"), path.join(made.macSource, "libEGL.dylib"));
        return undefined;
      },
    },
    {
      name: "a build folder that is itself a link to a good copy",
      fault: ArtifactFault.NotRegular,
      only: POSIX_ONLY,
      make: async (made) => {
        const elsewhere = path.join(made.outside, "mac-copy");
        await writeBuild(elsewhere, MAC);
        await rm(made.macSource, { recursive: true });
        await symlink(elsewhere, made.macSource);
        return undefined;
      },
    },
    {
      name: "a FIFO where a listed file should be",
      fault: ArtifactFault.NotRegular,
      only: POSIX_ONLY,
      make: async (made) => {
        await rm(path.join(made.macSource, "libEGL.dylib"));
        await execFileAsync("mkfifo", [path.join(made.macSource, "libEGL.dylib")]);
        return undefined;
      },
    },
    {
      name: "a build with no manifest.json",
      fault: ArtifactFault.Missing,
      make: async (made) => {
        await rm(path.join(made.macSource, "manifest.json"));
        return undefined;
      },
    },
    {
      name: "a manifest.json that is not the locked one",
      fault: ArtifactFault.ManifestDigest,
      make: async (made) => {
        await appendFile(path.join(made.macSource, "manifest.json"), " ");
        return undefined;
      },
    },
    {
      name: "a manifest of another ANGLE commit (pinned as such)",
      fault: ArtifactFault.Origin,
      make: async (made) => {
        const other = manifestOf(MAC, FILES[MAC], "1".repeat(40));
        await writeFile(path.join(made.macSource, "manifest.json"), other);
        return lockFor({ [MAC]: other });
      },
    },
    {
      name: "the Windows build where the Mac one should be (pinned as such)",
      fault: ArtifactFault.Origin,
      make: async (made) => {
        const other = manifestOf(AngleTarget.WindowsX64D3d11, FILES[MAC]);
        await writeFile(path.join(made.macSource, "manifest.json"), other);
        return lockFor({ [MAC]: other });
      },
    },
  ];

  for (const row of HOSTILE) {
    it(`a release build refuses ${row.name}: it fails closed and copies nothing`, row.only ?? {}, async () => {
      const made = await fixture();
      const lock = (await row.make(made)) ?? lockFor();
      const outsideBefore = await tree(made.outside);
      await assert.rejects(
        () => bundleAngle({ resources: made.resources, release: true, source: made.source, lock }),
        (error: unknown) =>
          error instanceof AngleBundleError &&
          error.problems.some(
            (problem: { target: string; fault: string }) => problem.target === MAC && problem.fault === row.fault,
          ),
      );
      assert.equal(existsSync(path.join(made.resources, "angle")), false, "no partial copy");
      assert.deepEqual(await tree(made.outside), outsideBefore, "nothing outside was touched");
    });

    it(
      `a developer build refuses ${row.name}: it skips that build and copies the others whole`,
      row.only ?? {},
      async () => {
        const made = await fixture();
        const lock = (await row.make(made)) ?? lockFor();
        const { warn } = warnings();
        const result = await bundleAngle({
          resources: made.resources,
          release: false,
          source: made.source,
          lock,
          warn,
        });
        assert.deepEqual(
          result.skipped.map((skip: { target: string; fault: string }) => [skip.target, skip.fault]),
          [[MAC, row.fault]],
        );
        assert.equal(
          existsSync(path.join(made.resources, "angle", MAC)),
          false,
          "no partial copy of the refused build",
        );
        assert.deepEqual((await readdir(path.join(made.resources, "angle"))).sort(), [
          AngleTarget.LinuxX64Vulkan,
          AngleTarget.WindowsX64D3d11,
        ]);
      },
    );
  }

  it("the CLI's --fetch downloads exactly the lock's run, by artifact name", () => {
    assert.deepEqual(fetchArgv(BUNDLE_LOCK, "/tmp/angle"), [
      "run",
      "download",
      String(BUNDLE_LOCK.run.id),
      "--repo",
      BUNDLE_LOCK.run.repository,
      "--dir",
      "/tmp/angle",
      "--pattern",
      `angle-*-${COMMIT12}`,
    ]);
  });
});

// ---------- the Mac libraries' signatures ----------

describe("a Mac library the app's signing re-signed", () => {
  it("is restored to its pinned bytes from its signature record", () => {
    const record = signatureRecord(EGL);
    assert.ok(record);
    const resigned = resign(EGL, Buffer.from("a much longer Developer ID signature with certificates ".repeat(8)));
    assert.notEqual(sha256(resigned), sha256(EGL));
    assert.deepEqual(restoreSigned(resigned, record), EGL);
  });

  it("has no record when it is not a signed thin 64-bit Mach-O", () => {
    assert.equal(signatureRecord(Buffer.from("MZ a windows dll")), null);
    assert.equal(signatureRecord(Buffer.from("\x7fELF a linux library")), null);
    const unsigned = Buffer.from(EGL);
    unsigned.writeUInt32LE(0x1b, 32 + SEGMENT_BYTES);
    assert.equal(signatureRecord(unsigned), null, "no LC_CODE_SIGNATURE");
  });

  it("verifies in a packaged app once restored, and is refused when its code changed too", async () => {
    const made = await fixture();
    const lock = lockFor();
    await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    const bundled = path.join(bundledFolder(made.resources, MAC, lock), "libGLESv2.dylib");
    await writeFile(bundled, resign(GLES, Buffer.from("developer-id-signature ".repeat(20))));
    assert.ok((await verifyAngleBundle(made.resources, lock)).every((check) => check.ok));
    const patched = resign(GLES, Buffer.from("developer-id-signature"));
    patched[HEADER_BYTES + 1] ^= 0xff;
    await writeFile(bundled, patched);
    const mac = (await verifyAngleBundle(made.resources, lock)).find((check) => check.target === MAC);
    assert.deepEqual(mac && !mac.ok ? mac.fault : null, ArtifactFault.FileDigest);
  });

  it(
    "is restored after a real codesign of the pinned libEGL.dylib",
    process.platform === "darwin" ? needsTools("angleMac") : { skip: "codesign is macOS-only" },
    async () => {
      const found = devTool("angleMac");
      assert.ok("path" in found);
      const manifest = JSON.parse(await readFile(path.join(found.path, "manifest.json"), "utf8"));
      const original = await readFile(path.join(found.path, "libEGL.dylib"));
      assert.equal(sha256(original), manifest.files["libEGL.dylib"].sha256);
      const record = signatureRecord(original);
      assert.ok(record, "the pinned library is a signed thin Mach-O");
      const copy = path.join(await tmpDir("angle-codesign-"), "libEGL.dylib");
      await copyFile(path.join(found.path, "libEGL.dylib"), copy);
      const entitlements = path.join(REPO, "build", "entitlements.mac.plist");
      await execFileAsync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
        "--timestamp=none",
        copy,
      ]);
      const resigned = await readFile(copy);
      assert.notEqual(sha256(resigned), sha256(original), "codesign rewrote it");
      const restored = restoreSigned(resigned, record);
      assert.ok(restored);
      assert.equal(sha256(restored), manifest.files["libEGL.dylib"].sha256);
    },
  );
});

// ---------- the store ----------

describe("installing ANGLE from the app's resources", () => {
  /** A fixture whose resources already hold the synthetic bundle. */
  async function bundledFixture() {
    const made = await fixture();
    const lock = lockFor();
    await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    return { ...made, lock, entry: macEntry(lock) };
  }

  it("copies the verified bundle into <id>/<commit12>-<sha12> with a bundled receipt, and a second install writes nothing", async () => {
    const made = await bundledFixture();
    const at = Date.UTC(2026, 9, 1);
    const installed = await installBundledArtifact(made.store, made.entry, made.resources, {
      lock: made.lock,
      now: () => at,
    });
    const sha12 = made.lock.targets[MAC].manifestSha256.slice(0, 12);
    assert.equal(installed, path.join(made.store, ToolchainId.AngleMac, `${COMMIT12}-${sha12}`));
    for (const [rel, bytes] of Object.entries(FILES[MAC]))
      assert.equal(sha256(await readFile(path.join(installed, rel))), sha256(bytes), rel);
    assert.equal(existsSync(path.join(installed, SIGNATURES_FILE)), false, "the store holds the pinned files only");
    const receipt = JSON.parse(await readFile(path.join(installed, "receipt.json"), "utf8"));
    assert.deepEqual(receipt, {
      id: ToolchainId.AngleMac,
      version: COMMIT12,
      sha256: made.lock.targets[MAC].manifestSha256,
      sha12,
      bytes: made.lock.targets[MAC].bytes,
      host: null,
      target: BuildTarget.Mac,
      source: ReceiptSource.Bundled,
      installedAt: new Date(at).toISOString(),
    });
    const before = await tree(made.store);
    assert.equal(await installBundledArtifact(made.store, made.entry, made.resources, { lock: made.lock }), installed);
    assert.deepEqual(await tree(made.store), before);
  });

  it("installs the pinned bytes of a library the app's signing re-signed", async () => {
    const made = await bundledFixture();
    const bundled = path.join(bundledFolder(made.resources, MAC, made.lock), "libEGL.dylib");
    await writeFile(bundled, resign(EGL, Buffer.from("developer-id ".repeat(30))));
    const installed = await installBundledArtifact(made.store, made.entry, made.resources, { lock: made.lock });
    assert.deepEqual(await readFile(path.join(installed, "libEGL.dylib")), EGL);
  });

  /** Bundles the store refuses, each with its fault and the problem the install job reports. */
  const REFUSED: Array<{
    name: string;
    fault: ArtifactFault;
    problem: ToolchainProblem;
    only?: { skip?: string };
    make: (folder: string, outside: string) => Promise<void>;
  }> = [
    {
      name: "a tampered bundled library",
      fault: ArtifactFault.FileDigest,
      problem: ToolchainProblem.Integrity,
      make: async (folder) => {
        const tampered = Buffer.from(EGL);
        tampered[HEADER_BYTES + 5] ^= 0xff;
        await writeFile(path.join(folder, "libEGL.dylib"), tampered);
      },
    },
    {
      name: "a tampered header",
      fault: ArtifactFault.FileDigest,
      problem: ToolchainProblem.Integrity,
      make: async (folder) => appendFile(path.join(folder, "include", "EGL", "egl.h"), "#define EVIL 1\n"),
    },
    {
      name: "an extra file in the bundle",
      fault: ArtifactFault.Unlisted,
      problem: ToolchainProblem.Archive,
      make: async (folder) => writeFile(path.join(folder, "libEvil.dylib"), "evil"),
    },
    {
      name: "a bundled library that is a link out",
      fault: ArtifactFault.NotRegular,
      problem: ToolchainProblem.Archive,
      only: POSIX_ONLY,
      make: async (folder, outside) => {
        await rm(path.join(folder, "libGLESv2.dylib"));
        await symlink(path.join(outside, "secret.txt"), path.join(folder, "libGLESv2.dylib"));
      },
    },
    {
      name: "a malformed signatures.json",
      fault: ArtifactFault.ManifestShape,
      problem: ToolchainProblem.Integrity,
      make: async (folder) => writeFile(path.join(folder, SIGNATURES_FILE), '{"files":{"libEGL.dylib":{"header":1}}}'),
    },
    {
      name: "a bundle whose manifest.json was swapped",
      fault: ArtifactFault.ManifestDigest,
      problem: ToolchainProblem.Integrity,
      make: async (folder) => appendFile(path.join(folder, "manifest.json"), "\n"),
    },
  ];

  for (const row of REFUSED)
    it(`refuses ${row.name} with a typed fault, leaving the store as it was`, row.only ?? {}, async () => {
      const made = await bundledFixture();
      await row.make(bundledFolder(made.resources, MAC, made.lock), made.outside);
      const before = await tree(made.store);
      await assert.rejects(
        () => installBundledArtifact(made.store, made.entry, made.resources, { lock: made.lock }),
        (error: unknown) =>
          error instanceof ArtifactError && error.fault === row.fault && error.problem === row.problem,
      );
      assert.deepEqual(await tree(made.store), before, "the store is byte-identical");
      assert.equal(existsSync(path.join(made.store, ".staging")), false, "no staging is left");
    });

  it("a developer build made without the Mac ANGLE says so, typed, and installs nothing", async () => {
    const made = await fixture();
    const lock = lockFor();
    const entry = macEntry(lock);
    assert.equal(await bundledState(made.resources, entry, lock), BundleState.Missing);
    await assert.rejects(
      () => installBundledArtifact(made.store, entry, made.resources, { lock }),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.Missing,
    );
    assert.deepEqual(await tree(made.store), {});
    await bundleAngle({ resources: made.resources, release: true, source: made.source, lock });
    assert.equal(await bundledState(made.resources, entry, lock), BundleState.Present);
    assert.equal(await bundledState(made.resources, { ...entry, id: ToolchainId.Ninja }, lock), null, "not bundled");
  });

  it("an ANGLE the app does not bundle is still not hosted", async () => {
    const made = await bundledFixture();
    const { local } = made.entry;
    assert.ok(local);
    const other = { ...made.entry, local: { ...local, manifestSha256: "e".repeat(64) } };
    await assert.rejects(
      () => installBundledArtifact(made.store, other, made.resources, { lock: made.lock }),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.NotHosted,
    );
  });
});

describe("an install job with the shipped manifest's Mac ANGLE", () => {
  const angle = manifestEntry(ToolchainId.AngleMac, ToolchainHost.MacArm64);
  const deps = (resources: string, fetched: string[]) => ({
    resources,
    fetch: async (url: string) => {
      fetched.push(url);
      return new Response(null, { status: 404 });
    },
    run: async () => {
      throw new Error("nothing runs");
    },
    freeBytes: async () => 1024 ** 4,
    onJob: () => {},
  });

  it("from a build made without it: fails typed before any fetch, the store unchanged", async () => {
    assert.ok(angle);
    const store = await realpath(await tmpDir("angle-job-store-"));
    const resources = await realpath(await tmpDir("angle-job-resources-"));
    const fetched: string[] = [];
    const job = await installComponents(store, [angle], deps(resources, fetched));
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(job.problem, ToolchainProblem.NotBundled, "named for what is missing, never not-hosted");
    assert.deepEqual(fetched, []);
    assert.deepEqual(await tree(store), {});
  });

  it(
    "from a build that bundles it: installs it, fetching nothing, and the store holds it at the lock's pin",
    needsTools("angleMac", "angleWindows", "angleLinux"),
    async () => {
      assert.ok(angle);
      const root = await realpath(await tmpDir("angle-job-"));
      const resources = path.join(root, "resources");
      const store = path.join(root, "store");
      await mkdir(store, { recursive: true });
      const toolchains = path.dirname(path.dirname(devToolPath("angleMac")));
      const result = await bundleAngle({ resources, release: true, lock: BUNDLE_LOCK, toolchains });
      assert.equal(result.copied.length, ANGLE_TARGETS.length);
      const fetched: string[] = [];
      const entries = [ToolchainId.AngleMac, ToolchainId.AngleWindows, ToolchainId.AngleLinux].map((id) => {
        const entry = manifestEntry(id, ToolchainHost.MacArm64);
        assert.ok(entry);
        return entry;
      });
      const job = await installComponents(store, entries, deps(resources, fetched));
      assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
      assert.deepEqual(fetched, []);
      const receipts = await readReceipts(store);
      assert.deepEqual(
        receipts.map((receipt) => [receipt.id, receipt.sha12, receipt.source]).sort(),
        entries.map((entry) => [entry.id, entry.local?.manifestSha256.slice(0, 12), ReceiptSource.Bundled]).sort(),
      );
      const info = await lstat(path.join(store, ToolchainId.AngleMac));
      assert.ok(info.isDirectory());
    },
  );
});

function devToolPath(name: "angleMac"): string {
  const found = devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}
