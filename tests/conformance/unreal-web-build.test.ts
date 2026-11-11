/**
 * What an Unreal game's web build needs of this computer (`web-build.ts`): an engine whose install
 * lists the web (Wasm) platform, and the emscripten that engine names. Read from the engine's own
 * files and an emsdk folder, written here as small stand-ins. And what Genex sets in the project
 * before the build: the page's own isolation headers, and content split into files a host takes.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  emscriptenFor,
  emsdkHolds,
  engineBuildsWeb,
  ensureWebSettings,
  HOST_LIMITS,
  HostLimit,
  placeWebBuild,
  siteExcess,
  WEB_CHUNK_BYTES,
  WebFolder,
  webFolderOf,
} from "../../src/plugins/unreal/web-build.ts";
import { tmpDir } from "../helpers/tmp.ts";

const platformLine = (platform: string, more = "") =>
  `+InstalledPlatformConfigurations=(PlatformName="${platform}", Configuration="Shipping", PlatformType="Game"${more}, ProjectType="Any", bCanBeDisplayed=False)`;
const INSTALLED = "[InstalledPlatforms]\nHasInstalledPlatformInfo=true\n";

/** An engine folder whose `BaseEngine.ini` is `ini`, with the web platform's SDK file when `sdk` is given. */
async function engineWith(ini: string, sdk?: string) {
  const engine = await tmpDir("unreal-web-engine-");
  await mkdir(path.join(engine, "Engine", "Config"), { recursive: true });
  await writeFile(path.join(engine, "Engine", "Config", "BaseEngine.ini"), ini);
  if (sdk !== undefined) {
    await mkdir(path.join(engine, "Engine", "Platforms", "Wasm", "Config"), { recursive: true });
    await writeFile(path.join(engine, "Engine", "Platforms", "Wasm", "Config", "Wasm_SDK.json"), sdk);
  }
  return engine;
}
const SDK = '{\n\t"MainVersion": "6.0.10",\n\t"MinVersion": "6.0.10",\n\t"MaxVersion": "6.0.10"\n}\n';

describe("an Unreal that builds for the web", () => {
  it("is an install that lists a Shipping game for the web platform", async () => {
    const lists = await engineWith(`${INSTALLED}${platformLine("Mac")}\n${platformLine("Wasm")}\n`, SDK);
    assert.equal(await engineBuildsWeb(lists), true);
  });

  it("is not an install that lists other platforms only, whatever its web folder holds", async () => {
    const mac = await engineWith(`${INSTALLED}${platformLine("Mac")}\n${platformLine("Android")}\n`, SDK);
    assert.equal(await engineBuildsWeb(mac), false);
  });

  it("needs the file its web entry requires", async () => {
    const required = ', RequiredFile="Engine/Binaries/Wasm/UnrealGame-Wasm-Shipping.target"';
    const engine = await engineWith(`${INSTALLED}${platformLine("Wasm", required)}\n`, SDK);
    assert.equal(await engineBuildsWeb(engine), false);
    await mkdir(path.join(engine, "Engine", "Binaries", "Wasm"), { recursive: true });
    await writeFile(path.join(engine, "Engine", "Binaries", "Wasm", "UnrealGame-Wasm-Shipping.target"), "{}");
    assert.equal(await engineBuildsWeb(engine), true);
  });

  const others: Array<[string, string]> = [
    ["a Development entry alone", platformLine("Wasm").replace("Shipping", "Development")],
    ["an editor entry", platformLine("Wasm").replace('"Game"', '"Editor"')],
    ["a platform whose name only starts the same", platformLine("WasmSimulator")],
    ["a line in a comment", `;${platformLine("Wasm")}`],
    ["a required file outside the engine", platformLine("Wasm", ', RequiredFile="../../../etc/hosts"')],
  ];
  for (const [name, line] of others)
    it(`is not an install with ${name}`, async () => {
      assert.equal(await engineBuildsWeb(await engineWith(`${INSTALLED}${line}\n`, SDK)), false);
    });

  it("an engine with no installed-platform list builds what its folders hold: the web platform's own", async () => {
    assert.equal(await engineBuildsWeb(await engineWith("[Core.System]\n", SDK)), true);
    assert.equal(await engineBuildsWeb(await engineWith("[Core.System]\n")), false);
    assert.equal(await engineBuildsWeb(path.join(await tmpDir("unreal-web-none-"), "missing")), false);
  });
});

describe("the emscripten an Unreal builds web games with", () => {
  it("is the main version its web platform names, and none where it names none", async () => {
    assert.equal(await emscriptenFor(await engineWith("", SDK)), "6.0.10");
    for (const sdk of ["", "{}", '{"MainVersion": 6}', '{"MainVersion": "6.0.10; rm -rf ~"}', "not json"])
      assert.equal(await emscriptenFor(await engineWith("", sdk)), undefined, sdk);
    assert.equal(await emscriptenFor(await engineWith("")), undefined);
  });

  /** An emsdk folder whose emscripten says it is `version`, as its version file is written. */
  async function emsdk(text: string) {
    const root = await tmpDir("unreal-web-emsdk-");
    await mkdir(path.join(root, "upstream", "emscripten"), { recursive: true });
    await writeFile(path.join(root, "upstream", "emscripten", "emscripten-version.txt"), text);
    return root;
  }

  it("is held by an emsdk folder whose emscripten is that version, quoted or not", async () => {
    assert.equal(await emsdkHolds(await emsdk('"6.0.10"\n'), "6.0.10"), true);
    assert.equal(await emsdkHolds(await emsdk("6.0.10"), "6.0.10"), true);
  });

  it("is not held by another version, a relative or missing folder, or a folder that is a link", async () => {
    assert.equal(await emsdkHolds(await emsdk('"6.0.11"\n'), "6.0.10"), false);
    assert.equal(await emsdkHolds(await emsdk('"16.0.10"\n'), "6.0.10"), false);
    assert.equal(await emsdkHolds("emsdk", "6.0.10"), false);
    assert.equal(await emsdkHolds("", "6.0.10"), false);
    assert.equal(await emsdkHolds(path.join(await tmpDir("unreal-web-gone-"), "emsdk"), "6.0.10"), false);
    const real = await emsdk('"6.0.10"\n');
    const link = path.join(await tmpDir("unreal-web-link-"), "emsdk");
    await symlink(real, link, "dir");
    assert.equal(await emsdkHolds(link, "6.0.10"), false);
  });
});

describe("the game's web folder for an Unreal web build", () => {
  /** A game folder, and a staged site in it as Unreal leaves one. */
  async function gameWithSite() {
    const game = await tmpDir("unreal-web-game-");
    const staged = path.join(game, "unreal", "Builds", "Wasm");
    await mkdir(path.join(staged, "Dust", "Binaries", "Wasm"), { recursive: true });
    await writeFile(path.join(staged, "index.html"), "<!doctype html>");
    await writeFile(path.join(staged, "wasm-manifest.json"), "{}");
    await writeFile(path.join(staged, "Dust", "Binaries", "Wasm", "Dust.wasm"), "\0asm");
    return { game, staged };
  }

  it("is free when missing, the game's own when it holds an Unreal web build, and taken otherwise", async () => {
    const { game } = await gameWithSite();
    assert.equal(await webFolderOf(game), WebFolder.Free);
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "index.html"), "<p>a mockup</p>");
    assert.equal(await webFolderOf(game), WebFolder.Taken);
    await writeFile(path.join(game, "web", "wasm-manifest.json"), "{}");
    assert.equal(await webFolderOf(game), WebFolder.Ours);
  });

  it("a link named web is taken, and so is a file", async () => {
    const linked = await gameWithSite();
    await symlink(linked.staged, path.join(linked.game, "web"), "dir");
    assert.equal(await webFolderOf(linked.game), WebFolder.Taken);
    const file = await gameWithSite();
    await writeFile(path.join(file.game, "web"), "");
    assert.equal(await webFolderOf(file.game), WebFolder.Taken);
  });

  it("the staged site becomes web/, replacing an earlier Unreal web build whole", async () => {
    const { game, staged } = await gameWithSite();
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "wasm-manifest.json"), "{}");
    await writeFile(path.join(game, "web", "old.pak"), "old");
    assert.equal(await placeWebBuild(game, staged), path.join(game, "web", "index.html"));
    assert.deepEqual((await readdir(path.join(game, "web"))).sort(), ["Dust", "index.html", "wasm-manifest.json"]);
    assert.deepEqual(await readdir(path.dirname(staged)), [], "the stage moved, it was not copied");
  });

  it("never replaces a web folder that holds anything else: the site stays where Unreal staged it", async () => {
    const { game, staged } = await gameWithSite();
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "index.html"), "<p>a mockup</p>");
    assert.equal(await placeWebBuild(game, staged), undefined);
    assert.equal(await readFile(path.join(game, "web", "index.html"), "utf8"), "<p>a mockup</p>");
    assert.deepEqual((await readdir(staged)).sort(), ["Dust", "index.html", "wasm-manifest.json"]);
  });
});

describe("the page settings that let an Unreal web build run on a plain host, start on a click and draw sharp", () => {
  const SECTION = "[/Script/WasmTargetPlatform.WasmTargetSettings]";
  /** Unreal's own defaults: no headers added, a game that starts by itself, one device pixel a CSS pixel. */
  const PAGE = ["bInjectIsolationHeaders=True", "StartMode=Click", "MaxDevicePixelRatio=2.0"];
  const config = (project: string) => path.join(project, "Config", "DefaultEngine.ini");
  /** A project folder whose `Config/DefaultEngine.ini` is `text`; none when undefined. */
  async function projectWith(text?: string) {
    const project = await tmpDir("unreal-web-project-");
    if (text !== undefined) {
      await mkdir(path.join(project, "Config"));
      await writeFile(config(project), text);
    }
    return project;
  }

  it("are added to a project without them, in their own section, the rest kept byte for byte", async () => {
    const before = "[/Script/Engine.RendererSettings]\r\nr.RayTracing=False\r\n";
    const project = await projectWith(before);
    await ensureWebSettings(project);
    assert.equal(await readFile(config(project), "utf8"), `${before}\r\n${SECTION}\r\n${PAGE.join("\r\n")}\r\n`);
    const none = await projectWith();
    await ensureWebSettings(none);
    assert.equal(await readFile(config(none), "utf8"), `${SECTION}\n${PAGE.join("\n")}\n`);
  });

  it("join the section when the project has it, after its last setting", async () => {
    const project = await projectWith(`${SECTION}\nStartMode=Click\n\n[Other]\nA=1\n`);
    await ensureWebSettings(project);
    assert.equal(
      await readFile(config(project), "utf8"),
      `${SECTION}\nStartMode=Click\nbInjectIsolationHeaders=True\nMaxDevicePixelRatio=2.0\n\n[Other]\nA=1\n`,
    );
  });

  it("leave a project that already says either way as it is", async () => {
    for (const value of ["True", "False", "true"]) {
      const text = `${SECTION}\nbInjectIsolationHeaders=${value}\nStartMode=Auto\nMaxDevicePixelRatio=1.0\n`;
      const project = await projectWith(text);
      await ensureWebSettings(project);
      assert.equal(await readFile(config(project), "utf8"), text, value);
    }
    // Each setting on its own: the project's way to start stays, and only what it doesn't say is added.
    const startsItself = await projectWith(`${SECTION}\nstartmode=Auto\n`);
    await ensureWebSettings(startsItself);
    assert.equal(
      await readFile(config(startsItself), "utf8"),
      `${SECTION}\nstartmode=Auto\nbInjectIsolationHeaders=True\nMaxDevicePixelRatio=2.0\n`,
    );
  });
});

describe("the settings that split an Unreal web build's content into files a host takes", () => {
  const SECTION = "[/Script/UnrealEd.ProjectPackagingSettings]";
  /** Half of the 500 MiB Genex's hosting takes per file: Unreal measures a chunk before it is packed. */
  const SPLIT = "bGenerateChunks=True\nMaxChunkSize=262144000";
  const config = (project: string) => path.join(project, "Config", "Wasm", "WasmGame.ini");
  /** A project folder whose web-only `Config/Wasm/WasmGame.ini` is `text`; none when undefined. */
  async function projectWith(text?: string) {
    const project = await tmpDir("unreal-web-chunks-");
    if (text !== undefined) {
      await mkdir(path.dirname(config(project)), { recursive: true });
      await writeFile(config(project), text);
    }
    return project;
  }

  it("go into the project's web-only config, which no Mac or Windows package reads", async () => {
    const project = await projectWith();
    await ensureWebSettings(project);
    assert.equal(await readFile(config(project), "utf8"), `${SECTION}\n${SPLIT}\n`);
    const configs = (await readdir(path.join(project, "Config"))).sort();
    assert.deepEqual(configs, ["DefaultEngine.ini", "Wasm"], "no game config of every platform's");
    await ensureWebSettings(project);
    assert.equal(await readFile(config(project), "utf8"), `${SECTION}\n${SPLIT}\n`, "a second build adds nothing");
  });

  it("join the project's own web settings, every other line kept byte for byte", async () => {
    const before = '[/Script/UnrealEd.ProjectPackagingSettings]\r\n+DirectoriesToNeverCook=(Path="/Game/Movies")\r\n';
    const project = await projectWith(`${before}\r\n[Other]\r\nA=1\r\n`);
    await ensureWebSettings(project);
    assert.equal(
      await readFile(config(project), "utf8"),
      `${before}${SPLIT.replace("\n", "\r\n")}\r\n\r\n[Other]\r\nA=1\r\n`,
    );
  });

  it("leave what the project already says, either way, and add only what it doesn't say", async () => {
    for (const own of ["bGenerateChunks=False\nMaxChunkSize=450000000", "bgeneratechunks=true\nMAXCHUNKSIZE=1"]) {
      const text = `${SECTION}\n${own}\n`;
      const project = await projectWith(text);
      await ensureWebSettings(project);
      assert.equal(await readFile(config(project), "utf8"), text, own);
    }
    const sized = await projectWith(`${SECTION}\nMaxChunkSize=450000000\n`);
    await ensureWebSettings(sized);
    assert.equal(await readFile(config(sized), "utf8"), `${SECTION}\nMaxChunkSize=450000000\nbGenerateChunks=True\n`);
    // The same keys in another section are not the packaging settings.
    const elsewhere = await projectWith("[Other]\nbGenerateChunks=False\nMaxChunkSize=1\n");
    await ensureWebSettings(elsewhere);
    assert.equal(
      await readFile(config(elsewhere), "utf8"),
      `[Other]\nbGenerateChunks=False\nMaxChunkSize=1\n\n${SECTION}\n${SPLIT}\n`,
    );
  });

  it("leave a key the project adds to or takes away with Unreal's marks: it has said what it wants there", async () => {
    for (const own of ["+bGenerateChunks=False\n-MaxChunkSize=1", "!MaxChunkSize=ClearArray\n.bGenerateChunks=True"]) {
      const text = `${SECTION}\n${own}\n`;
      const project = await projectWith(text);
      await ensureWebSettings(project);
      assert.equal(await readFile(config(project), "utf8"), text, own);
    }
  });

  it("are the web's own: what the project says for every platform stays, and the web build is still split", async () => {
    const everyPlatform = `${SECTION}\nbGenerateChunks=False\nMaxChunkSize=0\n`;
    const project = await projectWith();
    await mkdir(path.join(project, "Config"));
    await writeFile(path.join(project, "Config", "DefaultGame.ini"), everyPlatform);
    await ensureWebSettings(project);
    assert.equal(await readFile(path.join(project, "Config", "DefaultGame.ini"), "utf8"), everyPlatform);
    assert.equal(await readFile(config(project), "utf8"), `${SECTION}\n${SPLIT}\n`);
  });
});

describe("the project settings of a web build go into the project's own plain files, all or none", () => {
  const OWN = "[Other]\nA=1\n";
  const ENGINE_CONFIG = ["Config", "DefaultEngine.ini"] as const;
  const WEB_CONFIG = ["Config", "Wasm", "WasmGame.ini"] as const;

  /** Every file below `dir` with its text and every folder, by path; a link is neither and is not followed. */
  async function filesBelow(dir: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isFile()) found[path.relative(dir, file)] = await readFile(file, "utf8");
      if (entry.isDirectory()) found[path.relative(dir, file)] = "a folder";
    }
    return found;
  }

  /** What stands where a config or its folder belongs, planted in `project`; a link leads into `outside`. */
  const IN_THE_WAY: ReadonlyArray<{ name: string; plant: (project: string, outside: string) => Promise<void> }> = [
    {
      name: "a Config folder that is a link",
      plant: async (project, outside) => {
        await mkdir(path.join(outside, "Wasm"));
        await writeFile(path.join(outside, "DefaultEngine.ini"), OWN);
        await writeFile(path.join(outside, "Wasm", "WasmGame.ini"), OWN);
        await symlink(outside, path.join(project, "Config"), "dir");
      },
    },
    {
      name: "a Config/Wasm folder that is a link",
      plant: async (project, outside) => {
        await writeFile(path.join(outside, "WasmGame.ini"), OWN);
        await mkdir(path.join(project, "Config"));
        await writeFile(path.join(project, ...ENGINE_CONFIG), OWN);
        await symlink(outside, path.join(project, "Config", "Wasm"), "dir");
      },
    },
    {
      name: "a Config/DefaultEngine.ini that is a link",
      plant: async (project, outside) => {
        await writeFile(path.join(outside, "DefaultEngine.ini"), OWN);
        await mkdir(path.join(project, "Config", "Wasm"), { recursive: true });
        await writeFile(path.join(project, ...WEB_CONFIG), OWN);
        await symlink(path.join(outside, "DefaultEngine.ini"), path.join(project, ...ENGINE_CONFIG));
      },
    },
    {
      name: "a Config/Wasm/WasmGame.ini that is a link",
      plant: async (project, outside) => {
        await writeFile(path.join(outside, "WasmGame.ini"), OWN);
        await mkdir(path.join(project, "Config", "Wasm"), { recursive: true });
        await writeFile(path.join(project, ...ENGINE_CONFIG), OWN);
        await symlink(path.join(outside, "WasmGame.ini"), path.join(project, ...WEB_CONFIG));
      },
    },
    {
      name: "a file named Config",
      plant: async (project) => {
        await writeFile(path.join(project, "Config"), "not a folder");
      },
    },
    {
      name: "a file named Config/Wasm",
      plant: async (project) => {
        await mkdir(path.join(project, "Config"));
        await writeFile(path.join(project, ...ENGINE_CONFIG), OWN);
        await writeFile(path.join(project, "Config", "Wasm"), "not a folder");
      },
    },
  ];

  for (const hostile of IN_THE_WAY) {
    it(`${hostile.name} is refused, and nothing is written or made: in the project or where a link leads`, async () => {
      const project = await tmpDir("unreal-web-linked-");
      const outside = await tmpDir("unreal-web-outside-");
      await hostile.plant(project, outside);
      const before = { project: await filesBelow(project), outside: await filesBelow(outside) };
      await assert.rejects(ensureWebSettings(project));
      assert.deepEqual({ project: await filesBelow(project), outside: await filesBelow(outside) }, before);
    });
  }
});

describe("what of a web build's site Genex's hosting won't take", () => {
  /** Small stand-ins for the host's limits, so no test writes hundreds of megabytes. */
  const LIMITS = { FileBytes: 10, SiteBytes: 25, Files: 4 } as const;
  /** A site folder holding `files`, each of the given size in bytes. */
  async function siteOf(files: Record<string, number>) {
    const site = await tmpDir("unreal-web-site-");
    for (const [file, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(site, file)), { recursive: true });
      await writeFile(path.join(site, file), Buffer.alloc(bytes));
    }
    return site;
  }

  it("is nothing for a site inside every limit, each met exactly", async () => {
    const site = await siteOf({ "index.html": 5, "Dust/a.ucas": 10, "Dust/b.ucas": 5, "Dust/c.utoc": 5 });
    assert.deepEqual(await siteExcess(site, LIMITS), []);
  });

  it("is the largest file past the file limit, by its path in the site, and how many more are past it", async () => {
    const one = await siteOf({ "index.html": 1, "Dust/Paks/a.ucas": 10, "Dust/Paks/b.ucas": 12 });
    assert.deepEqual(await siteExcess(one, LIMITS), [
      { limit: HostLimit.File, amount: 12, file: "Dust/Paks/b.ucas", others: 0 },
    ]);
    // Splitting the largest alone would leave the next one past the limit: the count says so.
    const three = await siteOf({ "Dust/Paks/a.ucas": 11, "Dust/Paks/b.ucas": 12, "Dust/Paks/c.ucas": 11 });
    assert.deepEqual((await siteExcess(three, { ...LIMITS, SiteBytes: 100 }))[0], {
      limit: HostLimit.File,
      amount: 12,
      file: "Dust/Paks/b.ucas",
      others: 2,
    });
  });

  it("is the whole site's size and its number of files, each past its limit", async () => {
    const site = await siteOf({ "a.pak": 6, "b.pak": 6, "c.pak": 6, "d.pak": 6, "e.pak": 2 });
    assert.deepEqual(await siteExcess(site, LIMITS), [
      { limit: HostLimit.Site, amount: 26 },
      { limit: HostLimit.Files, amount: 5 },
    ]);
  });

  it("never follows or counts a link, and says nothing of a folder that isn't there", async () => {
    const site = await siteOf({ "index.html": 1 });
    const outside = await siteOf({ "huge.ucas": 100, "1": 1, "2": 1, "3": 1, "4": 1 });
    await symlink(outside, path.join(site, "Linked"), "dir");
    await symlink(path.join(outside, "huge.ucas"), path.join(site, "huge.ucas"));
    assert.deepEqual(await siteExcess(site, LIMITS), []);
    assert.deepEqual(await siteExcess(path.join(site, "missing"), LIMITS), []);
  });

  it("measures by the host's own limits, and the split leaves every file room under the largest", () => {
    assert.deepEqual(HOST_LIMITS, { FileBytes: 500 * 1024 * 1024, SiteBytes: 2 * 1024 * 1024 * 1024, Files: 200 });
    assert.equal(WEB_CHUNK_BYTES, HOST_LIMITS.FileBytes / 2);
  });
});
