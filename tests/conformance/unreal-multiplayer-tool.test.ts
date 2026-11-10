/**
 * `unreal__multiplayer` puts Genex's GenexMultiplayer plugin, as the app ships it, into the game's
 * Unreal project and turns it on, then adds the Colyseus core it links: on a Mac the pinned release,
 * downloaded once by the backend and checked by sha256 before it is unpacked. A download that isn't
 * the pinned one is never used, Windows (no published core yet) gets the plugin and a note, and a
 * link anywhere on the way refuses the call with nothing written.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { readUnrealMultiplayerPin, UNREAL_MULTIPLAYER_DIR } from "../../scripts/vendor-unreal-multiplayer.ts";
import {
  addMultiplayer,
  type ColyseusCoreRelease,
  type UnrealMultiplayerDeps,
  type Unzip,
} from "../../src/plugins/unreal/multiplayer-tools.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ARCHIVE = Buffer.from("a stand-in for Colyseus.xcframework.zip");
const RELEASE: ColyseusCoreRelease = {
  version: "0.18.10",
  url: "https://example.invalid/Colyseus.xcframework.zip",
  sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
};
const SLICE = "Colyseus.xcframework/macos-arm64_x86_64";
const LIBRARY = "!<arch>\nlibcolyseus";
const UPROJECT = `{\n\t"FileVersion": 3,\n\t"EngineAssociation": "5.8",\n\t"Plugins": []\n}\n`;

/** A Mac (or `platform`) whose network answers `body` and whose unzip lays out the release's macOS slice. */
function deps(platform: NodeJS.Platform, body: Buffer = ARCHIVE) {
  const fetched: string[] = [];
  const unzipped: string[] = [];
  const unzip: Unzip = async (_zip, pattern, into) => {
    unzipped.push(pattern);
    const slice = path.join(into, SLICE);
    await mkdir(path.join(slice, "Headers", "colyseus"), { recursive: true });
    await writeFile(path.join(slice, "libcolyseus.a"), LIBRARY);
    await writeFile(path.join(slice, "Headers", "colyseus.h"), "// colyseus\n");
    await writeFile(path.join(slice, "Headers", "colyseus", "client.h"), "// client\n");
  };
  const value: UnrealMultiplayerDeps = {
    platform,
    core: RELEASE,
    unzip,
    fetch: (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
    }) as typeof fetch,
  };
  return { value, fetched, unzipped };
}

/** An Unreal project in a game folder, beside a folder outside it and the plugin's storage. */
async function project() {
  const root = await tmpDir("studio-unreal-mp-tool-");
  const dir = path.join(root, "game", "unreal");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "Duel.uproject");
  await writeFile(file, UPROJECT);
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "theirs");
  return { root, dir, file, outside, storage: path.join(root, "storage") };
}

/** Every file below `dir` with its bytes, relative and `/`-separated. */
async function files(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(path.relative(dir, full).split(path.sep).join("/"), await readFile(full));
  }
  return out;
}

const signal = () => new AbortController().signal;

describe("unreal__multiplayer adds Genex's Unreal plugin and the core it links", () => {
  it("copies the shipped plugin byte for byte, turns it on and places the pinned Mac core", async () => {
    const fx = await project();
    const mac = deps("darwin");
    const answer = await addMultiplayer(mac.value, fx.storage, fx.file, signal());
    const pin = await readUnrealMultiplayerPin();
    assert.deepEqual(answer.sdk, { source: pin.source, commit: pin.commit, tree: pin.tree });
    assert.deepEqual(answer.core, { ready: true });
    assert.equal(answer.enabled, true);
    const plugin = path.join(fx.dir, "Plugins", "GenexMultiplayer");
    const installed = await files(plugin);
    for (const [rel, bytes] of await files(UNREAL_MULTIPLAYER_DIR))
      assert.ok(installed.get(rel)?.equals(bytes), `${rel} is the shipped file`);
    const core = "Source/ThirdParty/ColyseusNative";
    assert.equal(installed.get(`${core}/lib/Mac/libcolyseus.a`)?.toString(), LIBRARY);
    assert.equal(installed.get(`${core}/include/colyseus/client.h`)?.toString(), "// client\n");
    assert.match(installed.get(`${core}/LICENSE`)?.toString() ?? "", /MIT License/);
    const uproject = JSON.parse(await readFile(fx.file, "utf8"));
    assert.deepEqual(uproject.Plugins, [{ Name: "GenexMultiplayer", Enabled: true }]);
    assert.deepEqual(mac.fetched, [RELEASE.url]);
    const again = await addMultiplayer(mac.value, fx.storage, fx.file, signal());
    assert.deepEqual(again.core, { ready: true });
    assert.equal(again.enabled, false, "already on");
    assert.deepEqual(mac.fetched, [RELEASE.url], "the checked core is kept and not downloaded again");
  });

  it("never uses a download that isn't the pinned core, and still adds the plugin", async () => {
    const fx = await project();
    const tampered = deps("darwin", Buffer.from("something else"));
    const answer = await addMultiplayer(tampered.value, fx.storage, fx.file, signal());
    assert.equal(answer.core.ready, false);
    assert.match("why" in answer.core ? answer.core.why : "", /isn't the one it pins/);
    assert.deepEqual(tampered.unzipped, [], "nothing of it was unpacked");
    const plugin = path.join(fx.dir, "Plugins", "GenexMultiplayer");
    assert.equal(await lstat(path.join(plugin, "Source/ThirdParty/ColyseusNative/lib")).catch(() => null), null);
    assert.ok((await lstat(path.join(plugin, "GenexMultiplayer.uplugin"))).isFile());
    assert.deepEqual(await readdir(path.join(fx.storage, "multiplayer")), [], "the download is gone");
  });

  it("on Windows adds the plugin and says the core is missing, downloading nothing", async () => {
    const fx = await project();
    const windows = deps("win32");
    const answer = await addMultiplayer(windows.value, fx.storage, fx.file, signal());
    assert.equal(answer.core.ready, false);
    assert.match("why" in answer.core ? answer.core.why : "", /no Windows build of the Colyseus core/);
    assert.deepEqual(windows.fetched, []);
    assert.ok((await lstat(path.join(fx.dir, "Plugins", "GenexMultiplayer", "GenexMultiplayer.uplugin"))).isFile());
  });

  it("refuses a link on the way, writing nothing in the project or where the link leads", async () => {
    const cases: Array<[string, (fx: Awaited<ReturnType<typeof project>>) => Promise<void>]> = [
      ["Plugins is a link", (fx) => symlink(fx.outside, path.join(fx.dir, "Plugins"))],
      [
        "Plugins/GenexMultiplayer is a link",
        async (fx) => {
          await mkdir(path.join(fx.dir, "Plugins"));
          await symlink(fx.outside, path.join(fx.dir, "Plugins", "GenexMultiplayer"));
        },
      ],
      [
        "a plugin file is a link",
        async (fx) => {
          const plugin = path.join(fx.dir, "Plugins", "GenexMultiplayer");
          await mkdir(plugin, { recursive: true });
          await symlink(path.join(fx.outside, "keep.txt"), path.join(plugin, "GenexMultiplayer.uplugin"));
        },
      ],
      [
        "a plugin folder is a link",
        async (fx) => {
          const plugin = path.join(fx.dir, "Plugins", "GenexMultiplayer");
          await mkdir(plugin, { recursive: true });
          await symlink(fx.outside, path.join(plugin, "Source"));
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const fx = await project();
      await arrange(fx);
      const before = [...(await files(path.join(fx.dir, "Plugins"))).keys()];
      const mac = deps("darwin");
      await assert.rejects(addMultiplayer(mac.value, fx.storage, fx.file, signal()), /is a link/, name);
      assert.deepEqual([...(await files(fx.outside)).keys()], ["keep.txt"], `${name}: nothing new outside`);
      assert.equal(await readFile(path.join(fx.outside, "keep.txt"), "utf8"), "theirs", name);
      assert.equal(await readFile(fx.file, "utf8"), UPROJECT, `${name}: the .uproject is unchanged`);
      const written = [...(await files(path.join(fx.dir, "Plugins"))).keys()];
      assert.deepEqual(written, before, `${name}: no plugin file was written`);
      assert.deepEqual(mac.fetched, [], `${name}: nothing downloaded`);
    }
  });
});
