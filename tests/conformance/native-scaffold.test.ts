/**
 * The harness side of a C++ · raylib game. Its creation is retired (owner decision 2026-10-06,
 * M6.3): `game.scaffold` and Create game's IPC refuse a new one `raylib-creation-retired`, whether
 * the request names the kind or only desktop destinations, and write nothing; an existing raylib
 * game is still returned, validated, exported and given destinations, and the host-internal
 * caller (`ScaffoldCaller.Internal`: tests, fixtures, smoke) still scaffolds one.
 * `game.validate` names its problems with typed codes, and `game.upgradeContract` leaves its C++
 * contract alone. The game's title is filled into its window title and its page title, escaped
 * for each: whatever the title, the C++ still compiles to that title and the page gains no tag.
 * Driven through the core's substrate table, as the harness calls it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ExportRefusal } from "../../src/shared/game-export-contract.ts";
import { hostOf, hostTarget, TargetRefusal } from "../../src/shared/game-targets.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import {
  BuildTarget,
  CreationRefusal,
  GameStack,
  GameValidationCode,
  ProjectKind,
} from "../../src/shared/game-project.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";
import { type GamesIpcDeps, registerGamesIpc } from "../../src/main/ipc/games.ts";
import type { IpcHandle } from "../../src/main/ipc/registrar.ts";
import { CreationError, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { type CoreApi, type CoreLiteOptions, coreLite } from "../helpers/core-lite.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { macClangSkip } from "../helpers/macho.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
/** The shipped templates, as a scaffold copies them. */
const TEMPLATES = path.resolve(import.meta.dirname, "../../src");

/** A stand-in for `src/game-template-cpp`, used only while the resources hold no C++ template of their own. */
const CPP_TEMPLATE: Record<string, string> = {
  "CMakeLists.txt": "cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n",
  "src/main.cpp": '#include "studio.h"\nint main() {\n  studio::install({});\n}\n',
  "CLAUDE.md": "# Rules for a C++ game\n",
  "CLAUDE.own.md": "# Rules for a C++ game of its own\n",
  "NOTES.md": "# __GAME_TITLE__\n",
  "NOTES.own.md": "# __GAME_TITLE__ (its own)\n",
  "docs/CONTRACT.md": "# The C++ contract\n",
};

/** A core whose resources hold a C++ template: the shipped one once it lands, the stand-in until then. */
async function studio(options: CoreLiteOptions = {}) {
  const resources = await makeResources();
  const cpp = path.join(resources, "game-template-cpp");
  if (!(await stat(cpp).catch(() => null))) {
    for (const [rel, text] of Object.entries(CPP_TEMPLATE)) {
      await mkdir(path.dirname(path.join(cpp, rel)), { recursive: true });
      await writeFile(path.join(cpp, rel), text);
    }
  }
  // Real, not /var/folders behind the /private link: the owned games root is checked by its real path.
  const lite = await coreLite({
    ...options,
    resources,
    gamesRoot: await realpath(await tmpDir("studio-native-scaffold-")),
  });
  return { ...lite, call: harness(lite.api()) };
}

/** One harness method by name, called with params the way the harness sends them. */
function harness(api: CoreApi) {
  const table = api as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  return (method: string, params: unknown): Promise<unknown> => {
    const handler = table[method];
    assert.ok(handler, `${method} is a host method`);
    return handler(params);
  };
}

/**
 * A C++ · raylib game made the only way one still is: through the host-internal caller, as the
 * fixtures and tests make theirs.
 */
function raylibGame(
  core: CoreLiteApi,
  name: string,
  targets: readonly BuildTarget[] = [BuildTarget.Web],
  title?: string,
): Promise<GameProject> {
  return core.games.scaffold(name, {
    ...(title === undefined ? {} : { title }),
    stack: GameStack.RaylibCpp,
    targets,
    caller: ScaffoldCaller.Internal,
  });
}

/** The core a test drives. */
type CoreLiteApi = Awaited<ReturnType<typeof studio>>["core"];

/** A refusal of a new raylib game, with its typed code. */
const retired = (error: unknown) =>
  error instanceof CreationError && error.code === CreationRefusal.RaylibCreationRetired;

/**
 * Create game's IPC handler as main registers it, over `createGame`, which records what reached
 * the core: the raw handler, so a refusal keeps its typed code (the wire carries only its words).
 */
function createIpc(createGame: (title: string, options: unknown) => Promise<unknown>) {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const handle = ((channel: string, fn: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, fn);
  }) as unknown as IpcHandle;
  registerGamesIpc(handle, {
    core: { createGame },
    runSummaryReader: {},
    pushUiEvent: () => {},
  } as unknown as GamesIpcDeps);
  const create = handlers.get("studio:game.create");
  assert.ok(create, "studio:game.create is registered");
  return create;
}

/** Every entry under `dir` outside `.git`, with a regular file's bytes. */
async function bytesIn(dir: string): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const listed: Array<[string, string]> = [];
  for (const entry of entries) {
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (rel.split("/")[0] === ".git") continue;
    listed.push([rel, entry.isFile() ? (await readFile(path.join(dir, rel))).toString("base64") : "(folder)"]);
  }
  return listed.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** What `game.validate` answers. */
interface Validation {
  ok: boolean;
  problems: string[];
  codes?: string[];
}

describe("raylib-cpp creation is retired on the host (M6.3)", () => {
  // Flipped (M6.3): `game.scaffold {kind: raylib-cpp}` used to write the C++ template; it is now
  // refused typed and the template is written only by the host-internal caller.
  it("game.scaffold refuses a new C++ · raylib game by kind, typed, and writes nothing", async () => {
    const { call, gamesRoot } = await studio();
    for (const targets of [undefined, [BuildTarget.Web], [BuildTarget.Web, BuildTarget.Mac]]) {
      await assert.rejects(
        call("game.scaffold", {
          name: "pong",
          title: "Pong",
          kind: ProjectKind.RaylibCpp,
          ...(targets ? { targets } : {}),
        }),
        retired,
        JSON.stringify(targets),
      );
    }
    assert.deepEqual(await readdir(gamesRoot), [], "no folder");
  });

  it("game.scaffold refuses bare desktop destinations, as a pre-Rust caller sent them, typed, and writes nothing", async () => {
    const { call, gamesRoot } = await studio({ developmentStacks: true });
    const rows: BuildTarget[][] = [
      [BuildTarget.Mac],
      [BuildTarget.Web, BuildTarget.Mac],
      [BuildTarget.Windows, BuildTarget.Linux],
      [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
    ];
    for (const targets of rows) {
      await assert.rejects(call("game.scaffold", { name: "pong", targets }), retired, targets.join("+"));
    }
    assert.deepEqual(await readdir(gamesRoot), [], "no folder, even with the development gate open");
  });

  it("the refusal tells a kept pre-Rust harness to re-take its seed copy", async () => {
    const { call } = await studio();
    await assert.rejects(call("game.scaffold", { name: "pong", kind: ProjectKind.RaylibCpp }), (error: Error) => {
      assert.ok(retired(error));
      assert.match(error.message, /re-take/i);
      assert.match(error.message, /rust-wgpu/);
      return true;
    });
  });

  it("the internal caller still scaffolds a C++ · raylib game for the destinations named", async () => {
    const { core, gamesRoot } = await studio();
    const project = await raylibGame(core, "pong", [BuildTarget.Web, BuildTarget.Mac], "Pong");
    const dir = path.join(gamesRoot, "pong");
    assert.equal(project.dir, dir);
    assert.match(await readFile(path.join(dir, "CMakeLists.txt"), "utf8"), /genex_add_game\(/);
    assert.match(await readFile(path.join(dir, "src", "main.cpp"), "utf8"), /studio::install\(/);
    const files = (await bytesIn(dir)).map(([rel]) => rel);
    for (const browserFile of ["index.html", "src/main.js", "src/studio.js"]) {
      assert.ok(!files.includes(browserFile), browserFile);
    }
    const meta = JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8"));
    assert.deepEqual(
      [meta.stack, meta.targets, meta.kind, meta.own],
      [GameStack.RaylibCpp, [BuildTarget.Web, BuildTarget.Mac], ProjectKind.RaylibCpp, false],
    );
    assert.equal(project.shape.kind, ProjectKind.RaylibCpp);
    assert.deepEqual(project.destinations, { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] });

    // Without targets the game plays in the browser and on this computer.
    const bare = await core.games.scaffold("bare", { stack: GameStack.RaylibCpp, caller: ScaffoldCaller.Internal });
    const host = hostOf(process.platform);
    assert.deepEqual(bare.destinations?.targets, host ? [BuildTarget.Web, hostTarget(host)] : [BuildTarget.Web]);
  });

  it("the library refuses a new raylib game for the harness and the person, and makes one only for the internal caller", async () => {
    const { core, gamesRoot } = await studio();
    for (const caller of [ScaffoldCaller.Harness, ScaffoldCaller.Person]) {
      await assert.rejects(
        core.games.scaffold("pong", { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web], caller }),
        retired,
        caller,
      );
      await assert.rejects(
        core.games.create("Pong", { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web], caller }),
        retired,
        caller,
      );
    }
    assert.deepEqual(await readdir(gamesRoot), [], "no folder");
    const made = await core.games.create("Pong", { stack: GameStack.RaylibCpp, caller: ScaffoldCaller.Internal });
    assert.equal(made.shape.kind, ProjectKind.RaylibCpp);
  });

  it("with the IPC check bypassed, the library still refuses Create game's raylib, and a call naming no caller is not the host (M6 review)", async () => {
    const { core, gamesRoot } = await studio();
    await assert.rejects(core.createGame("Pong", { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] }), retired);
    await assert.rejects(core.games.create("Pong", { stack: GameStack.RaylibCpp }), retired);
    await assert.rejects(core.games.scaffold("pong", { stack: GameStack.RaylibCpp }), retired);
    assert.deepEqual(await readdir(gamesRoot), [], "no folder");
  });

  it("an existing raylib game named by kind or by bare desktop destinations is returned as it is", async () => {
    const { call, core, gamesRoot } = await studio();
    await raylibGame(core, "pong", [BuildTarget.Web, BuildTarget.Mac]);
    const before = await bytesIn(path.join(gamesRoot, "pong"));
    for (const params of [
      { kind: ProjectKind.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
      { kind: ProjectKind.RaylibCpp },
      { targets: [BuildTarget.Web, BuildTarget.Mac] },
      {},
    ]) {
      const again = (await call("game.scaffold", { name: "pong", ...params })) as GameProject;
      assert.equal(again.shape.kind, ProjectKind.RaylibCpp, JSON.stringify(params));
    }
    assert.deepEqual(await bytesIn(path.join(gamesRoot, "pong")), before, "nothing rewritten");
  });

  it("adding Linux to an existing raylib game still works", async () => {
    const { core, gamesRoot } = await studio();
    await raylibGame(core, "pong", [BuildTarget.Web, BuildTarget.Mac]);
    const grown = await core.games.setDestinations("pong", [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Linux]);
    assert.deepEqual(grown.destinations, {
      stack: GameStack.RaylibCpp,
      targets: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Linux],
    });
    const meta = JSON.parse(await readFile(path.join(gamesRoot, "pong", "studio.json"), "utf8"));
    assert.deepEqual(meta.targets, [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Linux]);
  });

  it("Create game's IPC refuses raylib by stack and by bare desktop destinations before the core is asked", async () => {
    const asked: unknown[] = [];
    const create = createIpc(async (title, options) => {
      asked.push([title, options]);
      return { name: "made" };
    });
    const refused: Array<Record<string, unknown>> = [
      { stack: GameStack.RaylibCpp },
      { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] },
      { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
      { targets: [BuildTarget.Mac] },
      { targets: [BuildTarget.Web, BuildTarget.Linux] },
      { targets: [BuildTarget.Windows], parent: "/Users/fixture/Projects" },
    ];
    for (const fields of refused) {
      await assert.rejects(create({ title: "Pong", ...fields }), retired, JSON.stringify(fields));
    }
    assert.deepEqual(asked, [], "the core was never asked");
    const allowed: Array<Record<string, unknown>> = [
      {},
      { targets: [BuildTarget.Web] },
      { stack: GameStack.ThreeJs, targets: [BuildTarget.Web] },
      { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
    ];
    for (const fields of allowed) await create({ title: "Pong", ...fields });
    assert.equal(asked.length, allowed.length, "Three.js and Rust · wgpu creation reach the core");
  });
});

describe("the harness checks a C++ · raylib game", () => {
  it("game.scaffold with the web starter, by either name, makes the browser game it always made", async () => {
    const { call, gamesRoot } = await studio();
    for (const [name, params] of [
      ["starter", { kind: ProjectStarter.Web }],
      ["template", { kind: ProjectKind.StudioTemplate }],
    ] as const) {
      const project = (await call("game.scaffold", { name, ...params })) as GameProject;
      assert.ok(await readFile(path.join(gamesRoot, name, "index.html"), "utf8"), name);
      assert.equal(project.shape.kind, ProjectKind.StudioTemplate, name);
      assert.deepEqual(project.destinations, { stack: GameStack.ThreeJs, targets: [BuildTarget.Web] }, name);
    }
    // FLIPPED for empty new projects: without a kind the folder is empty and its first message
    // picks its kind (new-project-empty's rows), where it used to get the browser game.
    for (const [name, params] of [
      ["plain", {}],
      ["nulled", { kind: null }],
    ] as const) {
      await call("game.scaffold", { name, ...params });
      assert.ok(!(await readdir(path.join(gamesRoot, name))).includes("index.html"), `${name}: no starter`);
    }
  });

  it("game.scaffold with the studio template refuses an existing C++ game as stack-is-fixed, writing nothing", async () => {
    const { call, core, gamesRoot } = await studio();
    await raylibGame(core, "pong");
    const before = await bytesIn(path.join(gamesRoot, "pong"));
    await assert.rejects(
      call("game.scaffold", { name: "pong", kind: ProjectKind.StudioTemplate }),
      (error: { code?: unknown }) => error.code === TargetRefusal.StackIsFixed,
    );
    assert.deepEqual(await bytesIn(path.join(gamesRoot, "pong")), before);
    // Named without a kind, the game is returned as it is: the harness's own calls name none.
    const again = (await call("game.scaffold", { name: "pong" })) as GameProject;
    assert.equal(again.shape.kind, ProjectKind.RaylibCpp);
    assert.deepEqual(await bytesIn(path.join(gamesRoot, "pong")), before);
  });

  it("game.scaffold refuses any other kind with the words it always used, and makes no folder", async () => {
    const { call, gamesRoot } = await studio();
    for (const kind of ["unity", ProjectKind.ThreeVite, ProjectKind.EngineExport, "__proto__"]) {
      await assert.rejects(
        call("game.scaffold", { name: "refused", kind }),
        { message: "Only browser-game scaffolding is supported in this build." },
        kind,
      );
    }
    assert.ok(!(await readdir(gamesRoot)).includes("refused"));
  });

  it("game.validate names a C++ game's problems with codes, and never asks it for index.html", async () => {
    const { call, core, gamesRoot } = await studio();
    await raylibGame(core, "pong");
    const dir = path.join(gamesRoot, "pong");
    const healthy = (await call("game.validate", { project: "pong" })) as Validation;
    assert.deepEqual([healthy.ok, healthy.codes], [true, []], healthy.problems.join(" / "));

    await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
    const removed = (await call("game.validate", { project: "pong" })) as Validation;
    assert.deepEqual(removed.codes, [GameValidationCode.NativeContractRemoved]);

    await rm(path.join(dir, "CMakeLists.txt"));
    const broken = (await call("game.validate", { project: "pong" })) as Validation;
    assert.deepEqual(broken.codes, [GameValidationCode.NativeMissingCMake, GameValidationCode.NativeContractRemoved]);
    assert.equal(broken.ok, false);
    assert.equal(broken.problems.length, broken.codes?.length);
    assert.ok(!broken.problems.some((problem) => /index\.html/.test(problem)), broken.problems.join(" / "));
  });

  it("game.export refuses a C++ game it has no build of as build-failed, and exports nothing", async () => {
    const { call, core } = await studio();
    await raylibGame(core, "pong");
    const exportsBefore = await readdir(core.layout.exports).catch(() => []);
    await assert.rejects(
      call("game.export", { project: "pong" }),
      (error: { code?: unknown }) => error.code === ExportRefusal.BuildFailed,
    );
    assert.deepEqual(await readdir(core.layout.exports).catch(() => []), exportsBefore, "nothing under exports");
  });

  it("game.upgradeContract leaves a C++ game as it is, and says so", async () => {
    const { call, core, gamesRoot } = await studio();
    await raylibGame(core, "pong");
    const dir = path.join(gamesRoot, "pong");
    const before = await bytesIn(dir);
    const result = (await call("game.upgradeContract", { project: "pong" })) as { upgraded: boolean; reason?: string };
    assert.equal(result.upgraded, false);
    assert.equal(typeof result.reason, "string");
    assert.deepEqual(await bytesIn(dir), before);
  });
});

describe("a Rust · wgpu game is scaffolded only behind the development gate", () => {
  /** What the library was asked, or why it was not: the library itself is not exercised here. */
  const LIBRARY_REACHED = "the library was asked";

  it("a release build refuses game.scaffold {kind: rust-wgpu} as stack-gated before the library is asked", async (t) => {
    const { call, core, gamesRoot } = await studio({ developmentStacks: false });
    const asked = t.mock.method(core.games, "scaffold");
    for (const targets of [undefined, [BuildTarget.Web, BuildTarget.Mac]]) {
      await assert.rejects(
        call("game.scaffold", { name: "ferris", kind: ProjectKind.RustWgpu, ...(targets ? { targets } : {}) }),
        (error: { code?: unknown }) => error.code === TargetRefusal.StackGated,
      );
    }
    assert.equal(asked.mock.callCount(), 0, "nothing reached the library");
    assert.ok(!(await readdir(gamesRoot)).includes("ferris"), "no folder");
  });

  it("a development build hands the library a rust-wgpu scaffold for the named destinations", async (t) => {
    const { call, core } = await studio({ developmentStacks: true });
    const asked = t.mock.method(core.games, "scaffold", async () => {
      throw new Error(LIBRARY_REACHED);
    });
    await assert.rejects(
      call("game.scaffold", {
        name: "ferris",
        title: "Ferris",
        kind: ProjectKind.RustWgpu,
        targets: [BuildTarget.Web, BuildTarget.Mac],
      }),
      { message: LIBRARY_REACHED },
    );
    await assert.rejects(call("game.scaffold", { name: "crab", kind: ProjectKind.RustWgpu }), {
      message: LIBRARY_REACHED,
    });
    // Flipped (M6.3): the harness's scaffold now names its caller, so the library refuses raylib for it.
    assert.deepEqual(
      asked.mock.calls.map((made) => made.arguments),
      [
        [
          "ferris",
          {
            title: "Ferris",
            stack: GameStack.RustWgpu,
            targets: [BuildTarget.Web, BuildTarget.Mac],
            caller: ScaffoldCaller.Harness,
          },
        ],
        ["crab", { stack: GameStack.RustWgpu, caller: ScaffoldCaller.Harness }],
      ],
    );
  });

  it("a harness workspace that kept a Rust night's part from before Rust games gets no Rust folder: refused, naming its re-take", async () => {
    const { call, core, gamesRoot } = await studio({ developmentStacks: true });
    const kept = "loop/gauntlet.ts";
    await writeFile(path.join(core.layout.harnessWs, kept), "// edited before Rust games\nexport {};\n");
    await assert.rejects(call("game.scaffold", { name: "ferris", kind: ProjectKind.RustWgpu }), (error: Error) => {
      assert.equal((error as Error & { code?: unknown }).code, NativeRefusal.HarnessPredatesNative);
      assert.ok(error.message.includes(kept), error.message);
      assert.match(error.message, /re-take the seed copy/i);
      return true;
    });
    assert.ok(!(await readdir(gamesRoot)).includes("ferris"), "no folder");
  });

  it("a development build scaffolds a rust-wgpu game from the shipped template, and a release build's library refuses one", async () => {
    const { call, gamesRoot } = await studio({ developmentStacks: true });
    const project = (await call("game.scaffold", {
      name: "ferris",
      title: "Ferris",
      kind: ProjectKind.RustWgpu,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    })) as GameProject;
    const dir = path.join(gamesRoot, "ferris");
    assert.equal(project.dir, dir);
    assert.equal(project.shape.kind, ProjectKind.RustWgpu);
    assert.deepEqual(project.destinations, { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] });
    assert.match(await readFile(path.join(dir, "genex.toml"), "utf8"), /^title = "Ferris"$/m);
    assert.match(await readFile(path.join(dir, "src", "main.rs"), "utf8"), /genex::install\(game\)/);
    const files = (await bytesIn(dir)).map(([rel]) => rel);
    for (const notShipped of ["index.html", "CMakeLists.txt", "Cargo.toml"]) {
      assert.ok(!files.includes(notShipped), notShipped);
    }

    const release = await studio({ developmentStacks: false });
    await assert.rejects(release.core.games.create("Ferris", { stack: GameStack.RustWgpu }), {
      code: TargetRefusal.StackGated,
    });
    assert.deepEqual(await readdir(release.gamesRoot), [], "no folder");
  });
});

/** Titles a harness may hand `game.scaffold`, which takes any text an agent writes. */
const TITLES: Array<[string, string]> = [
  ["a quote", 'a"b'],
  ["a backslash", "a\\b"],
  ["a newline", "x\ny"],
  ["a tab and a control character before a hex digit", "a\tb\u0001F"],
  ["a closing title tag and a script", "</title><script>alert(1)</script>"],
  ["an ampersand and an apostrophe", "Tom & Jerry's"],
  ["trigraph-like question marks", "what??!"],
  ["300 characters", "T".repeat(300)],
  ["an emoji", "Rocket 🚀 Run"],
  ["replacement patterns a string replace expands", "x$'y$`z$&w$$v"],
];

/** The C string literal (or adjacent literals) assigned to `game.title` in a scaffolded main.cpp. */
function titleLiteral(main: string): string {
  const line = /^\s*game\.title = (".*");$/m.exec(main);
  assert.ok(line?.[1], "main.cpp sets game.title from one line");
  return line[1];
}

/** The text a page's `<title>` holds, with its HTML entities read back. */
function pageTitle(html: string): string {
  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)];
  assert.equal(titles.length, 1, "one title element");
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return (titles[0]?.[1] ?? "").replace(/&(amp|lt|gt|quot|#39);/g, (entity) => entities[entity] ?? entity);
}

describe("a new game's title in its window and its page", () => {
  for (const [label, title] of TITLES) {
    it(`${label}: the page gains no tag and reads the title back; NOTES gets it as written`, async () => {
      const { core, gamesRoot } = await studio();
      await raylibGame(core, "titled", [BuildTarget.Web], title);
      const dir = path.join(gamesRoot, "titled");
      const shell = await readFile(path.join(dir, "web", "shell.html"), "utf8");
      const template = await readFile(path.join(TEMPLATES, "game-template-cpp", "web", "shell.html"), "utf8");
      const tags = (html: string) => [...html.matchAll(/<\/?[a-z][^>]*>/gi)].map((tag) => tag[0].split(/\s|>/)[0]);
      assert.deepEqual(tags(shell), tags(template), "the same elements as the template's page");
      assert.equal(pageTitle(shell), title);
      assert.equal(
        await readFile(path.join(dir, "NOTES.md"), "utf8"),
        (await readFile(path.join(TEMPLATES, "game-template-cpp", "NOTES.md"), "utf8")).replaceAll(
          "__GAME_TITLE__",
          () => title,
        ),
      );
      assert.ok(!titleLiteral(await readFile(path.join(dir, "src", "main.cpp"), "utf8")).includes("__GAME_TITLE__"));
    });

    it(`${label}: a Three.js scaffold is as it always was`, async () => {
      const { call, gamesRoot } = await studio();
      await call("game.scaffold", { name: "browser", title, kind: ProjectStarter.Web });
      for (const file of ["index.html", "NOTES.md"]) {
        const template = await readFile(path.join(TEMPLATES, "game-template", file), "utf8");
        assert.equal(
          await readFile(path.join(gamesRoot, "browser", file), "utf8"),
          template.replaceAll("__GAME_TITLE__", () => title),
          file,
        );
      }
    });
  }

  it("the scaffolded main.cpp compiles with real clang and its window title is the title, byte for byte", {
    skip: macClangSkip(),
    ...needsTools("raylib", "angleMac"),
    timeout: 120_000,
  }, async () => {
    const raylib = devTool("raylib");
    const angle = devTool("angleMac");
    assert.ok("path" in raylib && "path" in angle);
    const { core, gamesRoot } = await studio();
    const out = await tmpDir("native-scaffold-title-");
    for (const [index, [label, title]] of TITLES.entries()) {
      const name = `titled-${index}`;
      await raylibGame(core, name, [BuildTarget.Web], title);
      const src = path.join(gamesRoot, name, "src");
      await execFileAsync("/usr/bin/xcrun", [
        "clang++",
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fsyntax-only",
        "-DGRAPHICS_API_OPENGL_ES3",
        "-DGENEX_AUDIO_RATE_HZ=48000",
        "-DPLATFORM_DESKTOP_GLFW",
        "-isystem",
        path.join(raylib.path, "src"),
        "-isystem",
        path.join(angle.path, "include"),
        "-I",
        src,
        path.join(src, "main.cpp"),
      ]);
      // The literal itself, compiled and printed: exactly the title's bytes.
      const probe = path.join(out, `${name}.cpp`);
      const literal = titleLiteral(await readFile(path.join(src, "main.cpp"), "utf8"));
      await writeFile(probe, `#include <cstdio>\nint main() { std::fputs(${literal}, stdout); return 0; }\n`);
      await execFileAsync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-Werror", probe, "-o", `${probe}.bin`]);
      const { stdout } = await execFileAsync(`${probe}.bin`, [], { encoding: "buffer" });
      assert.equal(Buffer.from(stdout).toString("utf8"), title, label);
    }
  });
});
