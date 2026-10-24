/**
 * The Luau checks' programs (luau-lsp, selene, StyLua) and luau-lsp's Roblox type definitions:
 * found where the person keeps them (PATH, Rokit, Aftman, Foreman) or where Add Luau checks put
 * them (the plugin's storage); downloaded only from the pinned GitHub releases, each checked by size
 * and sha256 before anything is unpacked, all or nothing. A download that is redirected off GitHub,
 * is larger than pinned or whose bytes don't match leaves nothing behind. The sourcemap luau-lsp
 * reads is the game's `src/` in Rojo's format. Disk, network and programs are fakes or temporary
 * folders; nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { checkScripts, luauFinish } from "../../src/plugins/roblox/check-scripts.ts";
import {
  addLuauChecks,
  findTools,
  LUAU_HOSTS,
  type LuauAsset,
  LuauAddError,
  LuauAddRefusal,
  LuauPlatform,
  LuauTool,
  luauPlatform,
  MAX_LUAU_ASSET_BYTES,
  missingAssets,
  PINNED,
  type PinnedAsset,
  pinnedFor,
  ROBLOX_TYPES,
} from "../../src/plugins/roblox/luau-tools.ts";
import { scriptFiles, sourcemapOf } from "../../src/plugins/roblox/sourcemap.ts";
import type { InstallCommandResult, InstallRun } from "../../src/plugins/roblox/studio-install.ts";
import { type LocateStat, systemLocateFs } from "../../src/plugins/roblox/studio-locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;
const FIXTURE = path.resolve("tests/fixtures/roblox-luau");
const HOME = "/Users/maker";
const STORAGE = "/Users/maker/Library/Genex/plugins/roblox";

const assetName = (asset: PinnedAsset) => path.posix.basename(new URL(asset.url).pathname);

describe("the pinned releases", () => {
  it("picks each computer's own assets: Apple silicon, Intel Macs and Windows x64", () => {
    const names = (platform: LuauPlatform) => pinnedFor(platform).map((asset) => `${asset.asset} ${assetName(asset)}`);
    assert.deepEqual(names(LuauPlatform.MacArm64), [
      "luau-lsp luau-lsp-macos.zip",
      "selene selene-0.32.0-macos.zip",
      "stylua stylua-macos-aarch64.zip",
      "roblox-types globalTypes.None.d.luau",
    ]);
    assert.deepEqual(
      names(LuauPlatform.MacX64),
      ["luau-lsp luau-lsp-macos.zip", "stylua stylua-macos-x86_64.zip", "roblox-types globalTypes.None.d.luau"],
      "selene ships no Intel Mac build, so an Intel Mac gets none",
    );
    assert.deepEqual(names(LuauPlatform.WindowsX64), [
      "luau-lsp luau-lsp-win64.zip",
      "selene selene-0.32.0-windows.zip",
      "stylua stylua-windows-x86_64.zip",
      "roblox-types globalTypes.None.d.luau",
    ]);
  });

  it("names the computer by system and processor; Windows on Arm runs the x64 build, Linux gets none", () => {
    const rows: Array<[NodeJS.Platform, string, LuauPlatform | undefined]> = [
      ["darwin", "arm64", LuauPlatform.MacArm64],
      ["darwin", "x64", LuauPlatform.MacX64],
      ["win32", "x64", LuauPlatform.WindowsX64],
      ["win32", "arm64", LuauPlatform.WindowsX64],
      ["win32", "ia32", undefined],
      ["linux", "x64", undefined],
    ];
    for (const [platform, arch, expected] of rows)
      assert.equal(luauPlatform(platform, arch), expected, `${platform} ${arch}`);
  });

  it("pins every asset by version, size and sha256 on GitHub over HTTPS, under the size cap", () => {
    const versions = { "luau-lsp": "1.70.1", selene: "0.32.0", stylua: "2.6.0", "roblox-types": "1.70.1" };
    for (const asset of PINNED) {
      const url = new URL(asset.url);
      assert.equal(url.protocol, "https:", asset.url);
      assert.ok(LUAU_HOSTS.includes(url.hostname), asset.url);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.url);
      assert.ok(asset.bytes > 0 && asset.bytes <= MAX_LUAU_ASSET_BYTES, asset.url);
      assert.equal(asset.version, versions[asset.asset], asset.url);
      assert.ok(asset.url.includes(asset.version), `${asset.url} names its version`);
    }
    assert.equal(ROBLOX_TYPES.asset, "roblox-types");
  });
});

/** A disk that has `files` (each a program) and `links` (each to a program), and nothing else. */
function fakeDisk(files: string[], links: Record<string, string> = {}) {
  const looked: string[] = [];
  const stat = (file: boolean, link = false): LocateStat => ({ file, directory: !file && !link, link, mtimeMs: 0 });
  return {
    looked,
    fs: {
      async lstat(file: string) {
        looked.push(file);
        if (files.includes(file)) return stat(true);
        if (file in links) return stat(false, true);
        if (files.some((each) => each.startsWith(`${file}/`) || each.startsWith(`${file}\\`))) return stat(false);
        return undefined;
      },
      async realpath(file: string) {
        return links[file] ?? file;
      },
    },
  };
}

const MAC = { platform: "darwin" as const, home: HOME };
const WINDOWS_HOME = "C:\\Users\\maker";
const WINDOWS_STORAGE = "C:\\Users\\maker\\AppData\\Roaming\\Genex\\plugins\\roblox";
const WINDOWS = { platform: "win32" as const, home: WINDOWS_HOME };

describe("finding the programs", () => {
  it("finds each program where the person keeps it, and Genex's own in its storage", async () => {
    const rows: Array<{ name: string; files: string[]; env: NodeJS.ProcessEnv; tool: LuauTool; at: string }> = [
      {
        name: "on PATH",
        files: ["/opt/homebrew/bin/stylua"],
        env: { PATH: "/usr/bin:/opt/homebrew/bin" },
        tool: LuauTool.StyLua,
        at: "/opt/homebrew/bin/stylua",
      },
      {
        name: "Rokit",
        files: [`${HOME}/.rokit/bin/selene`],
        env: {},
        tool: LuauTool.Selene,
        at: `${HOME}/.rokit/bin/selene`,
      },
      {
        name: "Aftman",
        files: [`${HOME}/.aftman/bin/luau-lsp`],
        env: {},
        tool: LuauTool.LuauLsp,
        at: `${HOME}/.aftman/bin/luau-lsp`,
      },
      {
        name: "Foreman",
        files: [`${HOME}/.foreman/bin/stylua`],
        env: {},
        tool: LuauTool.StyLua,
        at: `${HOME}/.foreman/bin/stylua`,
      },
      {
        name: "plugin storage",
        files: [`${STORAGE}/luau/selene-0.32.0/selene`],
        env: {},
        tool: LuauTool.Selene,
        at: `${STORAGE}/luau/selene-0.32.0/selene`,
      },
    ];
    for (const row of rows) {
      const disk = fakeDisk(row.files);
      const found = await findTools({ ...MAC, env: row.env, fs: disk.fs }, STORAGE);
      assert.deepEqual(Object.keys(found.programs), [row.tool], row.name);
      assert.equal(found.programs[row.tool]?.file, row.at, row.name);
      assert.equal(found.programs[row.tool]?.ours, row.name === "plugin storage", row.name);
    }
  });

  it("prefers the person's own program to Genex's, and follows a link only to a file", async () => {
    const disk = fakeDisk([`${STORAGE}/luau/stylua-2.6.0/stylua`, "/opt/homebrew/Cellar/selene/0.32.0/bin/selene"], {
      "/opt/homebrew/bin/selene": "/opt/homebrew/Cellar/selene/0.32.0/bin/selene",
      "/usr/local/bin/stylua": "/usr/local/nothing",
    });
    const env = { PATH: "/usr/local/bin:/opt/homebrew/bin" };
    const found = await findTools({ ...MAC, env, fs: disk.fs }, STORAGE);
    assert.equal(found.programs.selene?.file, "/opt/homebrew/bin/selene");
    assert.equal(found.programs.stylua?.file, `${STORAGE}/luau/stylua-2.6.0/stylua`, "a link to nothing doesn't count");
  });

  it("skips PATH entries that aren't absolute and folders named like a program", async () => {
    const disk = fakeDisk(["./bin/selene", "/tools/luau-lsp/inside"]);
    const found = await findTools({ ...MAC, env: { PATH: ".:./bin::/tools" }, fs: disk.fs }, STORAGE);
    assert.deepEqual(found.programs, {});
    assert.ok(!disk.looked.some((file) => !path.isAbsolute(file)), "nothing relative is ever looked at");
  });

  it("on Windows reads Path with semicolons and finds the .exe", async () => {
    const files = [
      "C:\\Tools\\stylua.exe",
      `${WINDOWS_HOME}\\.rokit\\bin\\selene.exe`,
      `${WINDOWS_STORAGE}\\luau\\luau-lsp-1.70.1\\luau-lsp.exe`,
    ];
    const disk = fakeDisk(files);
    const found = await findTools({ ...WINDOWS, env: { Path: "C:\\Windows;C:\\Tools" }, fs: disk.fs }, WINDOWS_STORAGE);
    assert.equal(found.programs.stylua?.file, "C:\\Tools\\stylua.exe");
    assert.equal(found.programs.selene?.file, `${WINDOWS_HOME}\\.rokit\\bin\\selene.exe`);
    assert.equal(found.programs["luau-lsp"]?.file, `${WINDOWS_STORAGE}\\luau\\luau-lsp-1.70.1\\luau-lsp.exe`);
  });

  it("takes Roblox's type definitions only from Genex's storage, and lists what is still missing", async () => {
    const defs = `${STORAGE}/luau/roblox-types-1.70.1/globalTypes.None.d.luau`;
    const disk = fakeDisk(["/usr/local/bin/luau-lsp", defs]);
    const found = await findTools({ ...MAC, env: { PATH: "/usr/local/bin" }, fs: disk.fs }, STORAGE);
    assert.equal(found.definitions, defs);
    assert.deepEqual(
      missingAssets(found, LuauPlatform.MacArm64).map((asset) => asset.asset),
      ["selene", "stylua"],
    );
    const none = await findTools({ ...MAC, env: {}, fs: fakeDisk([]).fs }, STORAGE);
    assert.equal(none.definitions, undefined);
    assert.equal(missingAssets(none, LuauPlatform.MacArm64).length, 4);
  });

  it("with none found, answers a plain note and checks nothing; the finish is never held for it", async () => {
    const ran: string[] = [];
    const answer = await checkScripts(
      {
        run: async (file) => void ran.push(file) as never,
        storage: STORAGE,
        platform: "darwin",
        tools: { programs: {} },
      },
      { folder: path.join(FIXTURE, "game"), all: true },
    );
    assert.equal(answer.ran.length, 0);
    assert.deepEqual(ran, []);
    assert.match(answer.message, /Luau checks aren't added/);
    assert.doesNotMatch(answer.message, BANNED_WORDS);
    const finish = luauFinish(answer);
    assert.equal(finish.block, undefined, "no checks is a note, not a failure");
    assert.match(finish.note ?? "", /Luau checks aren't added/);
  });
});

/** A small asset: its bytes and its pin. */
function synthetic(asset: LuauAsset, body: string, archive: boolean): { pin: PinnedAsset; bytes: Buffer } {
  const bytes = Buffer.from(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = archive ? `${asset}-test.zip` : "globalTypes.None.d.luau";
  const pin: PinnedAsset = {
    asset,
    version: "9.9.9",
    platform: LuauPlatform.MacArm64,
    url: `https://github.com/example/${asset}/releases/download/9.9.9/${file}`,
    sha256,
    bytes: bytes.length,
  };
  return { pin, bytes };
}

const SYNTHETIC = [
  synthetic("luau-lsp", "luau-lsp zip bytes", true),
  synthetic("selene", "selene zip bytes", true),
  synthetic("stylua", "stylua zip bytes", true),
  synthetic("roblox-types", "declare game: DataModel", false),
];

const ok = (body: BodyInit, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const releaseAsset = (pin: PinnedAsset) =>
  `https://release-assets.githubusercontent.com/github-production-release-asset/1/${pin.asset}?sig=x`;

/** GitHub as Genex meets it: each release asset redirected once to GitHub's asset host; `override` turns one hostile. */
function fakeGitHub(override: Record<string, () => Response> = {}) {
  const asked: string[] = [];
  const routes: Record<string, () => Response> = {};
  for (const { pin, bytes } of SYNTHETIC) {
    if (pin.url.endsWith(".zip")) {
      routes[pin.url] = () => redirect(releaseAsset(pin));
      routes[releaseAsset(pin)] = () => ok(new Uint8Array(bytes), { "content-length": String(bytes.length) });
    } else routes[pin.url] = () => ok(new Uint8Array(bytes));
  }
  Object.assign(routes, override);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    assert.equal(init?.redirect, "manual", "each redirect is checked by Genex");
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  }) as typeof fetch;
  return { fetchFn, asked };
}

/** ditto (a Mac) unpacking each synthetic archive as the program it holds; selene's warm-up recorded. */
function fakeUnzip(options: { empty?: boolean } = {}) {
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const run: InstallRun = async (file, args, runOptions): Promise<InstallCommandResult> => {
    calls.push({ file, args: [...args], env: runOptions.env });
    if (file === "/usr/bin/ditto") {
      const archive = args[2] ?? "";
      const into = args[3] ?? "";
      const tool = path.basename(archive).replace(/-test\.zip$/, "");
      if (!options.empty) await writeFile(path.join(into, tool), `#!/bin/sh\necho ${tool}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** Every file below `dir`, relative, links not followed. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string, rel: string) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(next);
      if (entry.isDirectory()) await walk(path.join(at, entry.name), next);
    }
  };
  await walk(dir, "");
  return out.sort();
}

async function addDeps(fetchFn: typeof fetch, run: InstallRun) {
  const storage = await tmpDir("roblox-luau-add-");
  return {
    storage,
    deps: { platform: "darwin" as const, env: {}, fetch: fetchFn, run, storage, signal: new AbortController().signal },
  };
}

async function refused(promise: Promise<unknown>): Promise<LuauAddError> {
  const error = await promise.then(
    () => assert.fail("the download went on"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof LuauAddError, String(error));
  assert.doesNotMatch(error.message, BANNED_WORDS);
  return error;
}

describe("Add Luau checks", () => {
  it("downloads, checks and unpacks every asset into the plugin's storage, then warms selene's Roblox library there", async () => {
    const github = fakeGitHub();
    const unzip = fakeUnzip();
    const { storage, deps } = await addDeps(github.fetchFn, unzip.run);
    const added = await addLuauChecks(
      deps,
      SYNTHETIC.map((each) => each.pin),
    );
    assert.deepEqual(added.assets, ["luau-lsp", "selene", "stylua", "roblox-types"]);
    assert.deepEqual(await tree(path.join(storage, "luau")), [
      "home",
      "luau-lsp-9.9.9",
      "luau-lsp-9.9.9/luau-lsp",
      "roblox-types-9.9.9",
      "roblox-types-9.9.9/globalTypes.None.d.luau",
      "selene-9.9.9",
      "selene-9.9.9/selene",
      "stylua-9.9.9",
      "stylua-9.9.9/stylua",
      "warm",
      "warm/selene.toml",
      "warm/warm.luau",
    ]);
    if (process.platform !== "win32")
      assert.equal((await stat(path.join(storage, "luau", "selene-9.9.9", "selene"))).mode & 0o777, 0o755);
    const ditto = unzip.calls.filter((call) => call.file === "/usr/bin/ditto");
    assert.equal(ditto.length, 3, "each archive is unpacked once, after its bytes matched");
    for (const call of ditto) assert.deepEqual(call.args.slice(0, 2), ["-x", "-k"]);
    const warm = unzip.calls.find((call) => call.file === path.join(storage, "luau", "selene-9.9.9", "selene"));
    assert.ok(warm, "selene runs once to fetch Roblox's library while the person is adding the checks");
    assert.equal(warm.env?.HOME, path.join(storage, "luau", "home"), "into Genex's storage, never the person's caches");
    assert.ok(github.asked.some((url) => url.startsWith("https://release-assets.githubusercontent.com/")));
  });

  const HOSTILE: Array<{ name: string; reason: LuauAddRefusal; override: () => Record<string, () => Response> }> = [
    {
      name: "a sha256 that doesn't match",
      reason: LuauAddRefusal.Mismatch,
      override: () => {
        const { pin, bytes } = SYNTHETIC[1] as (typeof SYNTHETIC)[number];
        const other = Buffer.from(bytes);
        other[0] = (other[0] ?? 0) ^ 0xff;
        return { [releaseAsset(pin)]: () => ok(new Uint8Array(other)) };
      },
    },
    {
      name: "a declared size past the pin",
      reason: LuauAddRefusal.TooLarge,
      override: () => {
        const { pin, bytes } = SYNTHETIC[0] as (typeof SYNTHETIC)[number];
        return { [releaseAsset(pin)]: () => ok(new Uint8Array(bytes), { "content-length": String(bytes.length + 1) }) };
      },
    },
    {
      name: "more bytes than pinned, with no size declared",
      reason: LuauAddRefusal.TooLarge,
      override: () => {
        const { pin, bytes } = SYNTHETIC[2] as (typeof SYNTHETIC)[number];
        return { [releaseAsset(pin)]: () => ok(new Uint8Array(bytes.length * 4)) };
      },
    },
    {
      name: "a redirect to another host",
      reason: LuauAddRefusal.OtherHost,
      override: () => {
        const { pin } = SYNTHETIC[0] as (typeof SYNTHETIC)[number];
        return { [pin.url]: () => redirect("https://release-assets.example.com/luau-lsp.zip") };
      },
    },
    {
      name: "a redirect to a look-alike host",
      reason: LuauAddRefusal.OtherHost,
      override: () => {
        const { pin } = SYNTHETIC[2] as (typeof SYNTHETIC)[number];
        return { [pin.url]: () => redirect("https://release-assets.githubusercontent.com.example.net/x") };
      },
    },
    {
      name: "a redirect down to http",
      reason: LuauAddRefusal.NotHttps,
      override: () => {
        const { pin } = SYNTHETIC[1] as (typeof SYNTHETIC)[number];
        return { [pin.url]: () => redirect("http://release-assets.githubusercontent.com/selene.zip") };
      },
    },
  ];

  for (const row of HOSTILE)
    it(`leaves nothing behind for ${row.name}`, async () => {
      const github = fakeGitHub(row.override());
      const unzip = fakeUnzip();
      const { storage, deps } = await addDeps(github.fetchFn, unzip.run);
      const error = await refused(
        addLuauChecks(
          deps,
          SYNTHETIC.map((each) => each.pin),
        ),
      );
      assert.equal(error.code, row.reason);
      assert.deepEqual(
        await tree(path.join(storage, "luau")),
        [],
        "no program, no definitions and no temporary folder",
      );
      assert.deepEqual(unzip.calls, [], "nothing is unpacked or run before every download matched its pin");
      const found = await findTools({ platform: "darwin", env: {}, home: HOME, fs: systemLocateFs }, storage);
      assert.deepEqual(found.programs, {});
    });

  it("leaves nothing behind when an archive doesn't hold its program", async () => {
    const { storage, deps } = await addDeps(fakeGitHub().fetchFn, fakeUnzip({ empty: true }).run);
    const error = await refused(
      addLuauChecks(
        deps,
        SYNTHETIC.map((each) => each.pin),
      ),
    );
    assert.equal(error.code, LuauAddRefusal.Unpack);
    assert.deepEqual(await tree(path.join(storage, "luau")), []);
  });

  it("refuses a pin that isn't on GitHub before asking the network anything", async () => {
    const github = fakeGitHub();
    const { storage, deps } = await addDeps(github.fetchFn, fakeUnzip().run);
    const pin = { ...(SYNTHETIC[0] as (typeof SYNTHETIC)[number]).pin, url: "https://example.com/luau-lsp.zip" };
    const error = await refused(addLuauChecks(deps, [pin]));
    assert.equal(error.code, LuauAddRefusal.OtherHost);
    assert.deepEqual(github.asked, []);
    assert.deepEqual(await tree(path.join(storage, "luau")), []);
  });

  it("stops when the person stops it, keeping nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { storage, deps } = await addDeps(fakeGitHub().fetchFn, fakeUnzip().run);
    const error = await refused(
      addLuauChecks(
        { ...deps, signal: controller.signal },
        SYNTHETIC.map((each) => each.pin),
      ),
    );
    assert.equal(error.code, LuauAddRefusal.Cancelled);
    assert.deepEqual(await tree(path.join(storage, "luau")), []);
  });

  it("answers in plain words on a computer no release is built for", async () => {
    const { deps } = await addDeps(fakeGitHub().fetchFn, fakeUnzip().run);
    const error = await refused(addLuauChecks({ ...deps, platform: "linux" }));
    assert.equal(error.code, LuauAddRefusal.Unsupported);
  });

  it("refuses a storage whose luau folder is a link, writing nothing through it", async (t) => {
    if (process.platform === "win32") return t.skip("making a link needs rights the Windows runner may lack");
    const { symlink } = await import("node:fs/promises");
    const { storage, deps } = await addDeps(fakeGitHub().fetchFn, fakeUnzip().run);
    const elsewhere = await tmpDir("roblox-luau-elsewhere-");
    await symlink(elsewhere, path.join(storage, "luau"));
    const error = await refused(
      addLuauChecks(
        deps,
        SYNTHETIC.map((each) => each.pin),
      ),
    );
    assert.equal(error.code, LuauAddRefusal.Linked);
    assert.deepEqual(await tree(elsewhere), []);
    assert.ok((await lstat(path.join(storage, "luau"))).isSymbolicLink());
  });
});

describe("the sourcemap", () => {
  it("is the game's src/ in Rojo's format, matching the recorded fixture", async () => {
    const files = await scriptFiles(path.join(FIXTURE, "game"));
    assert.deepEqual(files, [
      "ReplicatedStorage/Round/Timer.luau",
      "ReplicatedStorage/Round/init.luau",
      "ReplicatedStorage/Shared/Util.luau",
      "ServerScriptService/Main.server.luau",
      "ServerScriptService/Odd%3AName.server.luau",
      "StarterPlayer/StarterPlayerScripts/Input.client.luau",
    ]);
    const expected = JSON.parse(await readFile(path.join(FIXTURE, "sourcemap.json"), "utf8"));
    assert.deepEqual(sourcemapOf(files), expected);
  });

  it("lists no script through a linked src/ or a linked folder inside it", async (t) => {
    if (process.platform === "win32") return t.skip("making a link needs rights the Windows runner may lack");
    const { symlink, cp } = await import("node:fs/promises");
    const game = await tmpDir("roblox-sourcemap-");
    await symlink(path.join(FIXTURE, "game", "src"), path.join(game, "src"));
    assert.deepEqual(await scriptFiles(game), [], "a src/ that is a link is refused whole");
    const other = await tmpDir("roblox-sourcemap-");
    await cp(path.join(FIXTURE, "game", "src"), path.join(other, "src"), { recursive: true });
    await mkdir(path.join(other, "outside", "Deep"), { recursive: true });
    await writeFile(path.join(other, "outside", "Deep", "Evil.luau"), "return 1\n");
    await symlink(path.join(other, "outside"), path.join(other, "src", "ServerStorage"));
    assert.ok(
      !(await scriptFiles(other)).some((file) => file.startsWith("ServerStorage/")),
      "a linked folder isn't walked",
    );
  });
});
