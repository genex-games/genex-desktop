/**
 * `unreal__multiplayer` puts Genex's GenexMultiplayer plugin, as the app ships it, into the game's
 * Unreal project and turns it on, then adds the Colyseus core it links: on a Mac the pinned release,
 * downloaded once by the backend and checked by sha256 before it is unpacked. A download that isn't
 * the pinned one is never used. On Windows the app's own pinned Win64 core is placed, each file
 * checked by sha256 first, never downloaded; a shipped core that isn't the pinned one, or a link in
 * its way, adds nothing of it. A link anywhere on the plugin's way refuses the call with nothing written.
 *
 * A copy an older Genex put into a game named Unreal 5.8.0 in its descriptor, so any other Unreal
 * asks before loading it. `unpinMultiplayerEngine` takes that one field out of the game's copy and
 * leaves every other byte, a prebuilt plugin and anything reached through a link as they are.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { readUnrealMultiplayerPin, UNREAL_MULTIPLAYER_DIR } from "../../scripts/vendor-unreal-multiplayer.ts";
import {
  addMultiplayer,
  type ColyseusCoreRelease,
  type UnrealMultiplayerDeps,
  SHIPPED_MULTIPLAYER,
  type Unzip,
  unpinMultiplayerEngine,
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
/** The pinned Win64 core (genex-demo's `fetch-colyseus.sh`: the reproducible build of v0.18.10). */
const WIN64_DLL_SHA256 = "d19d0daf7c28d6caecf5cc236af74367938239b7d1638290f2d472f2332f4bce";
const WIN64_LIB_SHA256 = "0e11320c53ae587c0ba56a4fb32ac1050f096174e59d8809eaef41a4c7534d87";
const CORE = "Source/ThirdParty/ColyseusNative";
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
const LINKS = process.platform === "win32" && "links need privileges on Windows";

type Fixture = Awaited<ReturnType<typeof project>>;

const sha256 = (bytes: Buffer | undefined) =>
  createHash("sha256")
    .update(bytes ?? Buffer.alloc(0))
    .digest("hex");

/** `file` with its last byte changed. */
async function flipLastByte(file: string): Promise<void> {
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(file, bytes);
}

/** The shipped Win64 core's pin with its `files` changed by `change`. */
async function editPin(shipped: string, change: (files: Record<string, string>) => Record<string, string>) {
  const file = path.join(shipped, "colyseus-win64", "vendor.json");
  const pin = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...pin, files: change(pin.files) }));
}

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

  it("on a Mac also places the Win64 core the app ships, so Genex can build the game for Windows", async () => {
    const fx = await project();
    const mac = deps("darwin");
    const answer = await addMultiplayer(mac.value, fx.storage, fx.file, signal());
    assert.deepEqual(answer.core, { ready: true });
    assert.deepEqual(answer.windows, { ready: true });
    assert.deepEqual(mac.fetched, [RELEASE.url], "only the Mac release is downloaded");
    const installed = await files(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE));
    assert.equal(installed.get("lib/Mac/libcolyseus.a")?.toString(), LIBRARY, "the Mac core is kept");
    assert.equal(sha256(installed.get("lib/Win64/colyseus.dll")), WIN64_DLL_SHA256);
    assert.equal(sha256(installed.get("lib/Win64/colyseus.lib")), WIN64_LIB_SHA256);
    assert.match(installed.get("THIRD-PARTY-NOTICES-Win64")?.toString() ?? "", /Mbed TLS/);
    assert.match(installed.get("LICENSE")?.toString() ?? "", /MIT License/);
  });

  it("on a Mac keeps the Mac core when the shipped Win64 core isn't the pinned one, and says so", async () => {
    const fx = await project();
    const shipped = path.join(fx.root, "shipped");
    await cp(SHIPPED_MULTIPLAYER, shipped, { recursive: true });
    await flipLastByte(path.join(shipped, "colyseus-win64", "lib/Win64/colyseus.dll"));
    const mac = deps("darwin");
    const answer = await addMultiplayer({ ...mac.value, shipped }, fx.storage, fx.file, signal());
    assert.deepEqual(answer.core, { ready: true }, "the game still builds on this Mac");
    assert.equal(answer.windows?.ready, false);
    assert.match(answer.windows && "why" in answer.windows ? answer.windows.why : "", /isn't the one it pins/);
    const installed = await files(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE));
    assert.equal(installed.get("lib/Mac/libcolyseus.a")?.toString(), LIBRARY);
    assert.equal(
      installed.has("lib/Win64/colyseus.dll") || installed.has("lib/Win64/colyseus.lib"),
      false,
      "no Win64 file was written",
    );
  });

  it("never uses a download that isn't the pinned core, and still adds the plugin", async () => {
    const fx = await project();
    const tampered = deps("darwin", Buffer.from("something else"));
    const answer = await addMultiplayer(tampered.value, fx.storage, fx.file, signal());
    assert.equal(answer.core.ready, false);
    assert.match("why" in answer.core ? answer.core.why : "", /isn't the one it pins/);
    assert.deepEqual(tampered.unzipped, [], "nothing of it was unpacked");
    const plugin = path.join(fx.dir, "Plugins", "GenexMultiplayer");
    assert.equal(await lstat(path.join(plugin, "Source/ThirdParty/ColyseusNative/lib/Mac")).catch(() => null), null);
    assert.ok((await lstat(path.join(plugin, "GenexMultiplayer.uplugin"))).isFile());
    assert.deepEqual(await readdir(path.join(fx.storage, "multiplayer")), [], "the download is gone");
  });

  it("on Windows places the Win64 core the app ships, checked by sha256, downloading nothing", async () => {
    const fx = await project();
    const windows = deps("win32");
    const answer = await addMultiplayer(windows.value, fx.storage, fx.file, signal());
    assert.deepEqual(answer.core, { ready: true });
    assert.deepEqual(windows.fetched, []);
    const installed = await files(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE));
    assert.equal(sha256(installed.get("lib/Win64/colyseus.dll")), WIN64_DLL_SHA256);
    assert.equal(sha256(installed.get("lib/Win64/colyseus.lib")), WIN64_LIB_SHA256);
    for (const [rel, bytes] of await files(path.join(SHIPPED_MULTIPLAYER, "colyseus-win64")))
      if (rel !== "vendor.json") assert.ok(installed.get(rel)?.equals(bytes), `${rel} is the shipped file`);
    assert.ok(installed.has("include/colyseus.h") && installed.has("include/colyseus/client.h"));
    assert.match(installed.get("LICENSE")?.toString() ?? "", /MIT License/);
    assert.match(installed.get("THIRD-PARTY-NOTICES-Win64")?.toString() ?? "", /Mbed TLS/);
  });

  it("on Windows never places a shipped core that isn't the pinned one, nor through a link", async () => {
    const win64 = "colyseus-win64";
    const cases: Array<[string, RegExp, (shipped: string, fx: Fixture) => Promise<void>]> = [
      [
        "a changed dll byte",
        /isn't the one it pins/,
        (s) => flipLastByte(path.join(s, win64, "lib/Win64/colyseus.dll")),
      ],
      [
        "a changed header",
        /isn't the one it pins/,
        (s) => writeFile(path.join(s, win64, "include/colyseus.h"), "//\n"),
      ],
      ["a pinned file missing", /isn't the one it pins/, (s) => rm(path.join(s, win64, "lib/Win64/colyseus.lib"))],
      [
        "a re-pinned dll that isn't Genex's",
        /isn't the one it pins/,
        async (s) => {
          await writeFile(path.join(s, win64, "lib/Win64/colyseus.dll"), "MZ other");
          await editPin(s, (files) => ({ ...files, "lib/Win64/colyseus.dll": sha256(Buffer.from("MZ other")) }));
        },
      ],
      [
        "a pinned path outside the core",
        /isn't the one it pins/,
        async (s) => {
          await writeFile(path.join(s, "outside.h"), "// x\n");
          await editPin(s, (files) => ({ ...files, "include/../../outside.h": sha256(Buffer.from("// x\n")) }));
        },
      ],
      [
        "ColyseusNative/lib is a link",
        /is a link/,
        async (_s, fx) => {
          await mkdir(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE), { recursive: true });
          await symlink(fx.outside, path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE, "lib"));
        },
      ],
      [
        "ColyseusNative/include/colyseus is a link",
        /is a link/,
        async (_s, fx) => {
          await mkdir(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE, "include"), { recursive: true });
          await symlink(fx.outside, path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE, "include", "colyseus"));
        },
      ],
    ];
    for (const [name, why, arrange] of cases) {
      const fx = await project();
      const shipped = path.join(fx.root, "shipped");
      await cp(SHIPPED_MULTIPLAYER, shipped, { recursive: true });
      await arrange(shipped, fx);
      const windows = deps("win32");
      const answer = await addMultiplayer({ ...windows.value, shipped }, fx.storage, fx.file, signal());
      assert.equal(answer.core.ready, false, name);
      assert.match("why" in answer.core ? answer.core.why : "", why, name);
      assert.deepEqual(windows.fetched, [], `${name}: nothing downloaded`);
      assert.deepEqual([...(await files(fx.outside)).keys()], ["keep.txt"], `${name}: nothing new outside`);
      const core = [...(await files(path.join(fx.dir, "Plugins", "GenexMultiplayer", CORE))).keys()];
      assert.deepEqual(core, ["ColyseusNative.Build.cs"], `${name}: no core file was written`);
    }
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

/** The descriptor an older Genex copied into a game: Unreal's own layout (tabs), naming the engine it was written for. */
const PINNED_DESCRIPTOR = [
  "{",
  '\t"FileVersion": 3,',
  '\t"VersionName": "0.1.0",',
  '\t"FriendlyName": "Genex Multiplayer",',
  '\t"EngineVersion": "5.8.0",',
  '\t"CanContainContent": false,',
  '\t"Installed": false,',
  '\t"Modules": [',
  '\t\t{ "Name": "GenexMultiplayer", "Type": "Runtime", "PlatformAllowList": [ "Mac", "Win64", "Linux" ] }',
  "\t]",
  "}",
  "",
].join("\n");
const ENGINE_LINE = '\t"EngineVersion": "5.8.0",\n';
const DESCRIPTOR = "Plugins/GenexMultiplayer/GenexMultiplayer.uplugin";

/** A game whose project holds the plugin's descriptor as `text`. */
async function gameWithDescriptor(text: string | Buffer = PINNED_DESCRIPTOR) {
  const fx = await project();
  const file = path.join(fx.dir, ...DESCRIPTOR.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return { ...fx, descriptor: file };
}

describe("A game's copy of the multiplayer plugin stops naming an engine version", () => {
  it("takes out the one line and leaves every other byte, so Unreal 5.9 loads the plugin without asking", async () => {
    const fx = await gameWithDescriptor();
    assert.equal(await unpinMultiplayerEngine(fx.file), true);
    assert.equal(await readFile(fx.descriptor, "utf8"), PINNED_DESCRIPTOR.replace(ENGINE_LINE, ""));
    assert.equal(await unpinMultiplayerEngine(fx.file), false, "a second call has nothing to do");
  });

  it("keeps Windows line endings and a byte order mark", async () => {
    const windows = `\uFEFF${PINNED_DESCRIPTOR.replaceAll("\n", "\r\n")}`;
    const fx = await gameWithDescriptor(windows);
    assert.equal(await unpinMultiplayerEngine(fx.file), true);
    assert.equal(await readFile(fx.descriptor, "utf8"), windows.replace(ENGINE_LINE.replace("\n", "\r\n"), ""));
  });

  /** Layouts the line can't simply be cut from, and the indentation each is written back in (Unreal's tabs when it has none). */
  const reshaped: Array<[string, string, string]> = [
    ["the field is the last one", '{\n  "FileVersion": 3,\n  "EngineVersion": "5.8.0"\n}\n', "  "],
    ["the file is one line", '{"FileVersion":3,"EngineVersion":"5.8.0","Installed":false}', "\t"],
    [
      "a nested object names the field too",
      '{\n\t"Notes": {\n\t\t"EngineVersion": "5.8.0",\n\t\t"a": 1\n\t},\n\t"EngineVersion": "5.8.0",\n\t"FileVersion": 3\n}\n',
      "\t",
    ],
  ];
  for (const [name, text, indent] of reshaped)
    it(`when ${name}, the descriptor is the same JSON without the field, in the file's own indentation`, async () => {
      const fx = await gameWithDescriptor(text);
      assert.equal(await unpinMultiplayerEngine(fx.file), true);
      const written = await readFile(fx.descriptor, "utf8");
      const { EngineVersion: _engine, ...rest } = JSON.parse(text);
      assert.equal(written, `${JSON.stringify(rest, null, indent)}${text.endsWith("\n") ? "\n" : ""}`);
    });

  /** Descriptors and folders the repair leaves exactly as they are, answering false. */
  const untouched: Array<{ name: string; links?: boolean; arrange: (fx: Fixture) => Promise<unknown> }> = [
    { name: "the game has no multiplayer plugin", arrange: async () => {} },
    {
      name: "the descriptor names no engine",
      arrange: (fx) => plant(fx, PINNED_DESCRIPTOR.replace(ENGINE_LINE, "")),
    },
    {
      name: "a prebuilt plugin, whose binaries are for the engine it names",
      arrange: (fx) => plant(fx, PINNED_DESCRIPTOR.replace('"Installed": false', '"Installed": true')),
    },
    { name: "the descriptor isn't JSON", arrange: (fx) => plant(fx, `${PINNED_DESCRIPTOR}}`) },
    { name: "the descriptor is a list", arrange: (fx) => plant(fx, '[{"EngineVersion": "5.8.0"}]') },
    {
      name: "the descriptor is larger than any descriptor",
      arrange: (fx) => plant(fx, PINNED_DESCRIPTOR.replace("Genex Multiplayer", "x".repeat(1024 * 1024))),
    },
    {
      name: "the descriptor is a folder",
      arrange: (fx) => mkdir(path.join(fx.dir, ...DESCRIPTOR.split("/")), { recursive: true }),
    },
    {
      name: "the descriptor is a link to a file outside the project",
      links: true,
      arrange: async (fx) => {
        await writeFile(path.join(fx.outside, "theirs.uplugin"), PINNED_DESCRIPTOR);
        await mkdir(path.join(fx.dir, "Plugins", "GenexMultiplayer"), { recursive: true });
        await symlink(path.join(fx.outside, "theirs.uplugin"), path.join(fx.dir, ...DESCRIPTOR.split("/")));
      },
    },
    {
      name: "the plugin's folder is a link to one outside the project",
      links: true,
      arrange: async (fx) => {
        await writeFile(path.join(fx.outside, "GenexMultiplayer.uplugin"), PINNED_DESCRIPTOR);
        await mkdir(path.join(fx.dir, "Plugins"), { recursive: true });
        await symlink(fx.outside, path.join(fx.dir, "Plugins", "GenexMultiplayer"));
      },
    },
    {
      name: "Plugins is a link to a folder outside the project",
      links: true,
      arrange: async (fx) => {
        const plugin = path.join(fx.outside, "GenexMultiplayer");
        await mkdir(plugin, { recursive: true });
        await writeFile(path.join(plugin, "GenexMultiplayer.uplugin"), PINNED_DESCRIPTOR);
        await symlink(fx.outside, path.join(fx.dir, "Plugins"));
      },
    },
  ];
  /** The descriptor `text` in the game's own plugin folder. */
  async function plant(fx: Fixture, text: string): Promise<void> {
    const file = path.join(fx.dir, ...DESCRIPTOR.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  for (const row of untouched)
    it(`leaves everything as it is when ${row.name}`, { skip: row.links ? LINKS : false }, async () => {
      const fx = await project();
      await row.arrange(fx);
      const witness = [await files(fx.dir), await files(fx.outside)];
      assert.equal(await unpinMultiplayerEngine(fx.file), false);
      assert.deepEqual([await files(fx.dir), await files(fx.outside)], witness, "no file changed, none appeared");
    });
});
