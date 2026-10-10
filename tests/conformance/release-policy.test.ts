import assert from "node:assert/strict";
import { test } from "node:test";
import {
  releaseIntent,
  assertDraftTarget,
  assertStableDownloads,
  assertUpdateFeedAssets,
  distributionPlatforms,
} from "../../scripts/release-policy.mjs";
import { copyStableDownloads } from "../../scripts/release-downloads.mjs";
import { releaseArtifacts, verifyReleaseArtifacts } from "../../scripts/release-manifest.mjs";
import { uploadRelease } from "../../scripts/upload-release.mjs";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import { createHash } from "node:crypto";

const MACOS = ["darwin", "arm64"];
const LINUX = ["linux", "x64"];
const WINDOWS = ["win32", "x64"];

/** One zip and its provenance per platform, plus the inventory: what the publish job downloads. */
async function releaseFixture(directory: string, expected: Record<string, string>, platforms: string[][]) {
  for (const [platform, arch] of platforms) {
    const file = `${platform}.zip`;
    await writeFile(path.join(directory, file), platform);
    const manifest = {
      ...expected,
      platform,
      arch,
      signed: platform !== "linux",
      artifacts: [
        {
          file,
          sha256: createHash("sha256")
            .update(platform ?? "")
            .digest("hex"),
        },
      ],
    };
    await writeFile(path.join(directory, `PROVENANCE-${platform}-${arch}.json`), JSON.stringify(manifest));
  }
  await writeFile(
    path.join(directory, "SBOM.cyclonedx.json"),
    JSON.stringify({ bomFormat: "CycloneDX", components: [] }),
  );
}

const expected = { version: "0.1.0", source: "a".repeat(40), electron: "43.7.6", lockfileSha256: "b".repeat(64) };

test("distribution verifies each platform's source, signing and package bytes before upload", async () => {
  const directory = await tmpDir();
  const platforms = [MACOS, LINUX, WINDOWS];
  await releaseFixture(directory, expected, platforms);
  await verifyReleaseArtifacts(directory, expected, platforms);
  await writeFile(path.join(directory, "win32.zip"), "changed");
  await assert.rejects(verifyReleaseArtifacts(directory, expected, platforms), /hash/);
  await writeFile(path.join(directory, "win32.zip"), "win32");
  const file = path.join(directory, "PROVENANCE-darwin-arm64.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const patch of [{ source: "another source" }, { signed: false }]) {
    await writeFile(file, JSON.stringify({ ...manifest, ...patch }));
    await assert.rejects(verifyReleaseArtifacts(directory, expected, platforms), /provenance|signing/);
  }
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(path.join(directory, "extra.zip"), "unreviewed");
  await assert.rejects(verifyReleaseArtifacts(directory, expected, platforms), /unlisted/);
});

test("a macOS-first draft verifies macOS and Linux and refuses Windows packages it does not list", async () => {
  const directory = await tmpDir();
  const platforms = distributionPlatforms({ macos: true, windows: false });
  await releaseFixture(directory, expected, platforms);
  await verifyReleaseArtifacts(directory, expected, platforms);
  await writeFile(path.join(directory, "win32.zip"), "unsigned");
  await assert.rejects(verifyReleaseArtifacts(directory, expected, platforms), /unlisted/);
});

const candidate = { version: "0.1.0-rc.1", refType: "branch", refName: "dev", publish: false, mainAncestor: false };

/** What the makers name the assets update.electronjs.org serves installed copies from. */
const FEED_ASSETS = ["Genex-darwin-arm64-0.2.0.zip", "Genex-Setup.exe", "RELEASES", "genex-0.2.0-full.nupkg"];
/** The version-free names releases/latest/download/<name> links use while Windows does not ship. */
const STABLE_DOWNLOADS = ["Genex.dmg", "Genex-linux-amd64.deb", "Genex-linux-x86_64.rpm", "Genex-linux-x64.zip"];

/** A release folder holding the update feed's assets and the version-free downloads. */
async function writeFeedAssets(directory: string): Promise<void> {
  for (const name of [...FEED_ASSETS, ...STABLE_DOWNLOADS]) await writeFile(path.join(directory, name), name);
}

test("an unsigned build-only candidate is allowed from dev without publication", () => {
  assert.deepEqual(releaseIntent(candidate), { tag: "v0.1.0-rc.1", publish: false, prerelease: true });
});

test("publication requires a matching tag from main history, or a manual main candidate", () => {
  const tag = { ...candidate, refType: "tag", refName: "v0.1.0-rc.1", mainAncestor: true };
  assert.equal(releaseIntent(tag).publish, true);
  for (const change of [{ refName: "v0.1.0" }, { mainAncestor: false }])
    assert.throws(() => releaseIntent({ ...tag, ...change }));
  assert.throws(() => releaseIntent({ ...candidate, publish: true }));
  assert.equal(releaseIntent({ ...candidate, refName: "main", publish: true, mainAncestor: true }).publish, true);
});

test("published releases and a different draft source are immutable", () => {
  assertDraftTarget({ isDraft: true, targetCommitish: "abc" }, "abc");
  assert.throws(() => assertDraftTarget({ isDraft: false, targetCommitish: "abc" }, "abc"), /published/);
  assert.throws(() => assertDraftTarget({ isDraft: true, targetCommitish: "def" }, "abc"), /source/);
});

test("a draft distributes signed macOS with Linux, and Windows only once it is signed", () => {
  assert.deepEqual(distributionPlatforms({ macos: true, windows: true }), [MACOS, LINUX, WINDOWS]);
  assert.deepEqual(distributionPlatforms({ macos: true, windows: false }), [MACOS, LINUX]);
  for (const windows of [true, false])
    assert.throws(() => distributionPlatforms({ macos: false, windows }), /signed macOS/);
});

test("a release carries every asset update.electronjs.org serves installed copies from", () => {
  assertUpdateFeedAssets([...FEED_ASSETS, "Genex-0.2.0-arm64.dmg", "SHA256SUMS"]);
  for (const name of FEED_ASSETS)
    assert.throws(() => assertUpdateFeedAssets(FEED_ASSETS.filter((other) => other !== name)), /update feed/, name);
  // The service picks the macOS zip by -darwin- and -arm64 in its name; an Intel zip serves no Apple Silicon copy.
  const intel = FEED_ASSETS.map((name) => name.replace("-arm64", "-x64"));
  assert.throws(() => assertUpdateFeedAssets(intel), /macOS/);
});

test("a macOS-first release needs only the macOS feed asset; Windows' join once Windows ships", () => {
  const [macZip, ...windowsAssets] = FEED_ASSETS;
  assertUpdateFeedAssets([macZip ?? "", "Genex-0.2.0-arm64.dmg"], { windows: false });
  assert.throws(() => assertUpdateFeedAssets(windowsAssets, { windows: false }), /macOS/);
  assert.throws(() => assertUpdateFeedAssets([macZip ?? ""], { windows: true }), /Windows/);
});

test("artifact provenance hashes regular packages and refuses links without modifying files", async () => {
  const dir = await tmpDir();
  await mkdir(path.join(dir, "platform"));
  await writeFile(path.join(dir, "platform", "fixture.zip"), "package");
  await writeFile(path.join(dir, "private.txt"), "outside");
  const rows = await releaseArtifacts(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.file, "platform/fixture.zip");
  assert.match(rows[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  await symlink(path.join(dir, "private.txt"), path.join(dir, "leak.zip"));
  await assert.rejects(releaseArtifacts(dir), /symlink/);
  assert.equal(await readFile(path.join(dir, "private.txt"), "utf8"), "outside");
});

test("draft upload validates artifacts before remote writes and never replaces public assets", async () => {
  const directory = await tmpDir();
  const calls: string[][] = [];
  let releases: unknown[] = [];
  let existing = { isDraft: false, targetCommitish: "source" };
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return "source\n";
    if (args[1] === "list") return JSON.stringify(releases);
    if (args[1] === "view") return JSON.stringify(existing);
    return "";
  };
  const candidate = {
    version: "0.1.0-rc.1",
    repo: "fixture/repo",
    source: "source",
    macos: true,
    windows: true,
    directory,
    run,
  };
  await assert.rejects(uploadRelease(candidate), /No release artifacts/);
  assert.equal(calls.length, 0);
  await writeFile(path.join(directory, "fixture.zip"), "package");
  await assert.rejects(uploadRelease(candidate), /update feed/);
  assert.equal(calls.length, 0, "a release installed copies cannot update from is never drafted");
  await writeFeedAssets(directory);
  await uploadRelease(candidate);
  assert.deepEqual(
    calls.map((args) => (args[0] === "api" ? "api" : args[1])),
    ["api", "list", "create", "upload"],
  );
  assert.ok(calls[2]?.includes("--draft"));
  assert.ok(calls[2]?.includes("--prerelease"));
  assert.ok(calls[2]?.includes("--verify-tag"));
  assert.ok(!calls[3]?.includes("--clobber"));
  calls.length = 0;
  releases = [{ tagName: "v0.1.0-rc.1" }];
  await assert.rejects(uploadRelease(candidate), /published/);
  assert.deepEqual(
    calls.map((args) => (args[0] === "api" ? "api" : args[1])),
    ["api", "list", "view"],
  );
  calls.length = 0;
  existing = { isDraft: true, targetCommitish: "another-source" };
  await assert.rejects(uploadRelease(candidate), /different source/);
  assert.deepEqual(
    calls.map((args) => (args[0] === "api" ? "api" : args[1])),
    ["api", "list", "view"],
  );
  calls.length = 0;
  await symlink(path.join(directory, "fixture.zip"), path.join(directory, "outside.zip"));
  await assert.rejects(uploadRelease(candidate), /regular files/);
  assert.equal(calls.length, 0);
});

test("draft upload refuses unsigned macOS before any remote call and proceeds without Windows signing", async () => {
  const directory = await tmpDir();
  for (const name of [FEED_ASSETS[0] ?? "", ...STABLE_DOWNLOADS]) await writeFile(path.join(directory, name), name);
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return "source\n";
    return "[]";
  };
  const candidate = { version: "0.1.0-rc.3", repo: "fixture/repo", source: "source", directory, run };
  await assert.rejects(uploadRelease({ ...candidate, macos: false, windows: true }), /signed macOS/);
  assert.equal(calls.length, 0);
  await uploadRelease({ ...candidate, macos: true, windows: false });
  assert.deepEqual(
    calls.map((args) => (args[0] === "api" ? "api" : args[1])),
    ["api", "list", "create", "upload"],
  );
});

test("draft creation refuses a missing or mismatched remote tag before writing", async () => {
  const directory = await tmpDir();
  await writeFeedAssets(directory);
  const calls: string[][] = [];
  const candidate = { version: "0.1.0", repo: "fixture/repo", source: "source", macos: true, windows: true, directory };
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return "another-source\n";
    return "[]";
  };
  await assert.rejects(uploadRelease({ ...candidate, run }), /tag.*source/);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["api"],
  );
  calls.length = 0;
  const missing = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") throw new Error("Not Found");
    return "[]";
  };
  await assert.rejects(uploadRelease({ ...candidate, run: missing }), /Not Found/);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["api"],
  );
});

/** Node's default output buffer for execFileSync, which the upload's `gh` calls run under. */
const EXEC_FILE_MAX_BUFFER = 1024 * 1024;

test("a tag on a commit whose diff runs to megabytes still resolves to its source", async () => {
  const directory = await tmpDir();
  await writeFeedAssets(directory);
  const calls: string[][] = [];
  // gh api answers a commit with every file's patch; a release merge's patches overflow the buffer
  // unless the call asks for the sha alone.
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] !== "api") return "[]";
    const filter = args.indexOf("--jq");
    if (filter !== -1 && args[filter + 1] === ".sha") return "source\n";
    const reply = JSON.stringify({ sha: "source", files: [{ patch: "+".repeat(2 * EXEC_FILE_MAX_BUFFER) }] });
    if (reply.length > EXEC_FILE_MAX_BUFFER)
      throw Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS" });
    return reply;
  };
  await uploadRelease({
    version: "0.1.5",
    repo: "fixture/repo",
    source: "source",
    macos: true,
    windows: false,
    directory,
    run,
  });
  assert.deepEqual(
    calls.map((args) => (args[0] === "api" ? "api" : args[1])),
    ["api", "list", "create", "upload"],
  );
});

/** What the Linux makers write under out/make, laid out as the 0.1.3 release's provenance lists it. */
const LINUX_MAKE = {
  "deb/x64/genex_0.2.0_amd64.deb": "deb",
  "rpm/x64/genex-0.2.0-1.x86_64.rpm": "rpm",
  "zip/linux/x64/Genex-linux-x64-0.2.0.zip": "linux zip",
};
/** What the macOS makers write under out/make. */
const MACOS_MAKE = { "dmg/arm64/Genex.dmg": "dmg", "zip/darwin/arm64/Genex-darwin-arm64-0.2.0.zip": "darwin zip" };
/** Each version-free Linux copy, beside the versioned package it duplicates. */
const LINUX_COPIES = {
  "deb/x64/Genex-linux-amd64.deb": "deb/x64/genex_0.2.0_amd64.deb",
  "rpm/x64/Genex-linux-x86_64.rpm": "rpm/x64/genex-0.2.0-1.x86_64.rpm",
  "zip/linux/x64/Genex-linux-x64.zip": "zip/linux/x64/Genex-linux-x64-0.2.0.zip",
};

/** A make output folder holding `files` (relative path to contents). */
async function writeMake(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  }
}

/** Every entry under `root` with its kind and, for files, its contents: what a refusal must leave as it was. */
async function listing(root: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) rows.push(`link ${path.relative(root, file)}`);
    else if (stat.isFile()) rows.push(`file ${path.relative(root, file)} ${await readFile(file, "utf8")}`);
    else rows.push(`dir ${path.relative(root, file)}`);
  }
  return rows.sort();
}

test("a Linux make gains byte-identical version-free copies beside its versioned packages", async () => {
  const root = await tmpDir();
  await writeMake(root, LINUX_MAKE);
  await copyStableDownloads(root);
  const rows: Array<{ file: string; sha256: string }> = await releaseArtifacts(root);
  const hashes = new Map(rows.map((row) => [row.file, row.sha256]));
  assert.deepEqual([...hashes.keys()].sort(), [...Object.keys(LINUX_MAKE), ...Object.keys(LINUX_COPIES)].sort());
  for (const [copy, versioned] of Object.entries(LINUX_COPIES)) assert.equal(hashes.get(copy), hashes.get(versioned));
  // A second run (a retried step) replaces its own copies and still leaves one of each.
  await writeFile(path.join(root, "deb/x64/genex_0.2.0_amd64.deb"), "rebuilt deb");
  await copyStableDownloads(root);
  assert.equal(await readFile(path.join(root, "deb/x64/Genex-linux-amd64.deb"), "utf8"), "rebuilt deb");
  assert.equal((await releaseArtifacts(root)).length, 6);
});

test("the version-free copies reach the draft through provenance, verification and upload", async () => {
  const [macos, linux, upload] = [await tmpDir(), await tmpDir(), await tmpDir()];
  await writeMake(macos, MACOS_MAKE);
  await writeMake(linux, LINUX_MAKE);
  await copyStableDownloads(linux);
  const platforms = distributionPlatforms({ macos: true, windows: false });
  // As each platform job records provenance and the publish job flattens the packages into upload/.
  for (const [[platform, arch], root] of [
    [MACOS, macos],
    [LINUX, linux],
  ] as const) {
    const artifacts = await releaseArtifacts(root);
    const manifest = { ...expected, platform, arch, signed: platform !== "linux", artifacts };
    await writeFile(path.join(upload, `PROVENANCE-${platform}-${arch}.json`), JSON.stringify(manifest));
    for (const { file } of artifacts)
      await writeFile(path.join(upload, path.basename(file)), await readFile(path.join(root, file)));
  }
  await writeFile(path.join(upload, "SBOM.cyclonedx.json"), JSON.stringify({ bomFormat: "CycloneDX", components: [] }));
  await verifyReleaseArtifacts(upload, expected, platforms);
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return args[0] === "api" ? `${expected.source}\n` : "[]";
  };
  const candidate = { version: "0.2.0", repo: "fixture/repo", source: expected.source, directory: upload, run };
  await uploadRelease({ ...candidate, macos: true, windows: false });
  const uploaded = (calls.find((args) => args[1] === "upload") ?? []).map((arg) => path.basename(arg));
  // The versioned names the updater and existing links use stay beside the copies.
  const versioned = [...Object.keys(MACOS_MAKE), ...Object.keys(LINUX_MAKE)].map((file) => path.basename(file));
  for (const name of [...STABLE_DOWNLOADS, ...versioned]) assert.ok(uploaded.includes(name), name);
});

test("version-free copies refuse a make they cannot copy faithfully, writing nothing", async () => {
  const cases: Array<[string, (root: string, outside: string) => Promise<void>, RegExp]> = [
    ["a package is missing", (root) => rm(path.join(root, "rpm/x64/genex-0.2.0-1.x86_64.rpm")), /one \.rpm/],
    [
      "a stale version sits beside the package",
      (root) => writeFile(path.join(root, "deb/x64/genex_0.1.9_amd64.deb"), "old"),
      /one \.deb/,
    ],
    [
      "the package is a link",
      async (root, outside) => {
        await rm(path.join(root, "zip/linux/x64/Genex-linux-x64-0.2.0.zip"));
        await symlink(path.join(outside, "secret"), path.join(root, "zip/linux/x64/Genex-linux-x64-0.2.0.zip"));
      },
      /regular file/,
    ],
    [
      "the version-free name is a link out of the make",
      (root, outside) => symlink(path.join(outside, "secret"), path.join(root, "deb/x64/Genex-linux-amd64.deb")),
      /regular file/,
    ],
    [
      "a maker folder is a link out of the make",
      async (root, outside) => {
        await mkdir(path.join(outside, "rpm"));
        await writeFile(path.join(outside, "rpm", "genex-0.2.0-1.x86_64.rpm"), "rpm");
        await rm(path.join(root, "rpm/x64"), { recursive: true });
        await symlink(path.join(outside, "rpm"), path.join(root, "rpm/x64"));
      },
      /link/,
    ],
  ];
  for (const [name, arrange, refusal] of cases) {
    const [root, outside] = [await tmpDir(), await tmpDir()];
    await writeMake(root, LINUX_MAKE);
    await writeFile(path.join(outside, "secret"), "outside");
    await arrange(root, outside);
    const before = [await listing(root), await listing(outside)];
    await assert.rejects(copyStableDownloads(root), refusal, name);
    assert.deepEqual([await listing(root), await listing(outside)], before, name);
  }
});

test("a draft carries every version-free download; Windows' installer joins once Windows ships", () => {
  assertStableDownloads([...STABLE_DOWNLOADS, "SHA256SUMS"], { windows: false });
  for (const name of STABLE_DOWNLOADS)
    assert.throws(
      () =>
        assertStableDownloads(
          STABLE_DOWNLOADS.filter((other) => other !== name),
          { windows: false },
        ),
      /Download links/,
      name,
    );
  assert.throws(() => assertStableDownloads(STABLE_DOWNLOADS, { windows: true }), /Genex-Setup\.exe/);
  assertStableDownloads([...STABLE_DOWNLOADS, "Genex-Setup.exe"], { windows: true });
});

test("draft upload refuses a release missing a version-free download before any remote call", async () => {
  const directory = await tmpDir();
  await writeFeedAssets(directory);
  await rm(path.join(directory, "Genex-linux-x64.zip"));
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return "[]";
  };
  const candidate = { version: "0.2.0", repo: "fixture/repo", source: "source", directory, run };
  await assert.rejects(uploadRelease({ ...candidate, macos: true, windows: false }), /Genex-linux-x64\.zip/);
  assert.equal(calls.length, 0);
});
