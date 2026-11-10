/**
 * The Unity multiplayer package Studio ships is the Genex SDK's `sdks/unity` at one pinned commit:
 * every vendored file is the bytes `vendor.json` records for that pin, nothing more and nothing
 * less, and the pin is the one the plugin names. It carries the server-authoritative client
 * (`GenexAuthority`) beside the relay client relay games already use, under the assembly name the
 * plugin's link.xml keeps from stripping.
 *
 * The refresh that writes it copies the SDK from git at the pin, minus its test projects and native
 * physics core, and refuses another package, another version or a link, writing nothing then; its
 * check names every file a hand edit added, removed or changed.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkUnityMultiplayer,
  isExcluded,
  refreshUnityMultiplayer,
  sha256,
  UnityVendorError,
  type UnityVendorRecord,
  VENDOR_RECORD,
  VENDORED_PACKAGE,
} from "../../scripts/refresh-unity-multiplayer.ts";
import { MULTIPLAYER_PACKAGE_SOURCE } from "../../src/plugins/unity/multiplayer.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Every file under a folder, by its path inside it; none when it is missing. */
async function filesUnder(folder: string, inside = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(folder, inside), { withFileTypes: true }).catch(() => [])) {
    const name = inside ? `${inside}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await filesUnder(folder, name)));
    else names.push(name);
  }
  return names.sort();
}

const readRecord = async (file = VENDOR_RECORD) => JSON.parse(await readFile(file, "utf8")) as UnityVendorRecord;

describe("the Unity multiplayer package Studio ships", () => {
  it("is the pinned SDK, file for file, and the pin the plugin names", async () => {
    const record = await readRecord();
    assert.equal(MULTIPLAYER_PACKAGE_SOURCE, `${record.repository}@${record.commit}`);
    const vendored = await filesUnder(VENDORED_PACKAGE);
    assert.deepEqual(vendored, Object.keys(record.files).sort(), "no file added or missing since the refresh");
    for (const name of vendored)
      assert.equal(sha256(await readFile(path.join(VENDORED_PACKAGE, name))), record.files[name], `${name} changed`);
    const manifest = JSON.parse(await readFile(path.join(VENDORED_PACKAGE, "package.json"), "utf8"));
    assert.equal(manifest.version, record.version);
    assert.ok(!vendored.some(isExcluded), "no test project or native core");
  });

  it("carries the server-room client beside the relay client, in the assembly link.xml keeps", async () => {
    const files = Object.keys((await readRecord()).files);
    for (const name of [
      // Server-authoritative rooms (protocol 4): the session, its UDP channel and the presets it predicts with.
      "Runtime/Core/Authority/GenexAuthoritySession.cs",
      "Runtime/Core/Authority/FastUdp.cs",
      "Runtime/Core/Authority/Presets.cs",
      "Runtime/WebGL/GenexFastWeb.jslib",
      // The relay (protocol 3), as relay games and the unity-multiplayer skill use it.
      "Runtime/Core/GenexSession.cs",
      "Runtime/Core/GenexMultiplayer.cs",
      "Runtime/Core/GenexMatchmaker.cs",
      "Runtime/Core/GenexNativeIdentity.cs",
      "Runtime/Unity/GenexPump.cs",
      "Runtime/Unity/GenexWebGL.cs",
      "Runtime/WebGL/GenexEmbed.jslib",
    ])
      assert.ok(files.includes(name), name);
    const assembly = JSON.parse(
      await readFile(path.join(VENDORED_PACKAGE, "Runtime/Genex.Multiplayer.asmdef"), "utf8"),
    );
    assert.equal(assembly.name, "Genex.Multiplayer");
  });
});

/** A genex-demo-shaped repository with a Unity package at `version`, committed; answers the commit. */
async function sdkRepo(version: string, name = "com.genex.multiplayer") {
  const repo = await tmpDir("studio-unity-sdk-");
  const files: Record<string, string> = {
    "sdks/unity/package.json": JSON.stringify({ name, version }),
    "sdks/unity/package.json.meta": "guid: 1",
    "sdks/unity/README.md": "# Genex Multiplayer for Unity",
    "sdks/unity/.gitignore": "Tests~/GenexSmoke/bin/",
    "sdks/unity/Runtime/Core/Authority/GenexAuthoritySession.cs": "namespace Genex.Multiplayer.Authority {}",
    "sdks/unity/Runtime/Plugins.meta": "guid: 2",
    "sdks/unity/Runtime/Plugins/GenexPhysics/macOS/libgenex_physics_capi.dylib": "native",
    "sdks/unity/Samples~/Quickstart/GenexQuickstart.cs": "class Q {}",
    "sdks/unity/Tests~/GenexSmoke/Program.cs": "class P {}",
    "apps/other/file.ts": "outside the package",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  }
  return { repo, commit: await commitAll(repo) };
}

/** Commit everything in `repo` as a fixture author; answers the commit. */
async function commitAll(repo: string): Promise<string> {
  const author = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
  await gitFile(["init", "-q"], { cwd: repo });
  await gitFile(["add", "-A"], { cwd: repo });
  await gitFile([...author, "commit", "-q", "-m", "sdk"], { cwd: repo });
  return (await gitFile(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
}

describe("refreshing the vendored package", () => {
  it("copies the package at the pin minus its tests and native core, and records each file", async () => {
    const { repo, commit } = await sdkRepo("0.8.0");
    const out = await tmpDir("studio-unity-vendor-");
    const target = path.join(out, "com.genex.multiplayer");
    const recordFile = path.join(out, "vendor.json");
    await mkdir(target);
    await writeFile(path.join(target, "Stale.cs"), "from the last pin");
    const record = await refreshUnityMultiplayer({ from: repo, commit, version: "0.8.0", target, record: recordFile });
    assert.deepEqual(await filesUnder(target), [
      "README.md",
      "Runtime/Core/Authority/GenexAuthoritySession.cs",
      "Samples~/Quickstart/GenexQuickstart.cs",
      "package.json",
      "package.json.meta",
    ]);
    assert.equal(record.commit, commit);
    assert.deepEqual(await readRecord(recordFile), record);
    assert.equal(record.files["README.md"], sha256(Buffer.from("# Genex Multiplayer for Unity")));
    assert.deepEqual(await checkUnityMultiplayer({ from: repo, target, record: recordFile }), []);
  });

  it("names every file a hand edit added, removed or changed", async () => {
    const { repo, commit } = await sdkRepo("0.8.0");
    const out = await tmpDir("studio-unity-vendor-");
    const target = path.join(out, "com.genex.multiplayer");
    const recordFile = path.join(out, "vendor.json");
    await refreshUnityMultiplayer({ from: repo, commit, version: "0.8.0", target, record: recordFile });
    await writeFile(path.join(target, "README.md"), "edited by hand");
    await writeFile(path.join(target, "Extra.cs"), "class E {}");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(target, "package.json.meta"));
    assert.deepEqual(await checkUnityMultiplayer({ from: repo, target, record: recordFile }), [
      "added Extra.cs",
      "changed README.md",
      "missing package.json.meta",
    ]);
  });

  it("refuses another version, another package, a commit it lacks or a link, and writes nothing", async () => {
    const cases: Array<[string, () => Promise<{ repo: string; commit: string }>, string]> = [
      ["another version", () => sdkRepo("0.9.0"), "0.8.0"],
      ["another package", () => sdkRepo("0.8.0", "com.other.package"), "0.8.0"],
      ["a commit it lacks", async () => ({ ...(await sdkRepo("0.8.0")), commit: "0".repeat(40) }), "0.8.0"],
      [
        "a link in the package",
        async () => {
          const { repo } = await sdkRepo("0.8.0");
          await symlink("/etc/hosts", path.join(repo, "sdks/unity/Runtime/hosts.cs"));
          return { repo, commit: await commitAll(repo) };
        },
        "0.8.0",
      ],
    ];
    for (const [name, arrange, version] of cases) {
      const { repo, commit } = await arrange();
      const out = await tmpDir("studio-unity-vendor-");
      const target = path.join(out, "com.genex.multiplayer");
      await mkdir(target);
      await writeFile(path.join(target, "Kept.cs"), "the current copy");
      await assert.rejects(
        refreshUnityMultiplayer({ from: repo, commit, version, target, record: path.join(out, "vendor.json") }),
        UnityVendorError,
        name,
      );
      assert.deepEqual(await filesUnder(out), ["com.genex.multiplayer/Kept.cs"], `${name}: nothing written`);
    }
  });
});
