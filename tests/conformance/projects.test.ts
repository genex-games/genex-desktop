/**
 * Folders-as-projects: a game can live anywhere on disk, chats nest inside it, stills in
 * `references/` reach the model as pictures, and forgetting an external folder does not delete it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { countImages } from "../helpers/fake-ollama.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { GameWorkspaces, slugFromName, tildePath, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { ownNotes, ownRules } from "../../src/substrate/game-workspace-prompts.ts";
import { ensureRepo } from "../../src/substrate/snapshots.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { TargetRefusal } from "../../src/shared/game-targets.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";

const exec = promisify(execFile);

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("project folders", () => {
  it("an adopted game's rules and notes keep what its folder says as written, `$` patterns included", () => {
    const shape = {
      ...RAYLIB_SHAPE,
      kind: ProjectKind.ThreeVite,
      main: "src/$'main.js",
      build: "vite build --base=$$x$&",
    };
    const rules = ownRules("M:__ENTRY_MAIN__|B:__BUILD_LINE__", shape);
    assert.equal(rules, "M:src/$'main.js|B:it is built with `vite build --base=$$x$&`");
    const notes = ownNotes("T:__GAME_TITLE__|P:__SEEDED_PITCH__", "x$'y$`z", shape, {
      file: "README.md",
      text: "costs $& or $$5",
    });
    assert.ok(notes.startsWith("T:x$'y$`z|P:"), notes);
    assert.ok(notes.includes("> costs $& or $$5"), notes);
  });

  it("slugFromName and tildePath are what the sidebar shows", () => {
    assert.equal(slugFromName("My Cool Game"), "my-cool-game");
    assert.equal(tildePath("/Users/simeon/coding/rift", "/Users/simeon"), "~/coding/rift");
  });

  it("adopts a folder anywhere, keeps the user's stills, and its web starter brings the missing game files", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-project-"), "mood-board");
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "references"), { recursive: true });
    await writeFile(path.join(dir, "references", "mood.png"), PNG_1x1);
    await writeFile(path.join(dir, "notes-from-me.txt"), "rainy neon streets");

    const project = await rig.core.adoptProject(dir);
    assert.equal(project.library, false);
    assert.match(project.pathLabel, /mood-board/);
    assert.equal(project.dir, await realpath(dir));
    // A folder of notes and stills starts with no kind; its web starter is written once picked.
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8").catch(() => null), null);
    await rig.core.games.start(project.name, ProjectStarter.Web);
    assert.ok(await readFile(path.join(dir, "index.html"), "utf8"));
    // The assets door (AG-930): a scaffolded or adopted game gets the folder, the loader and the git attributes.
    assert.match(await readFile(path.join(dir, "assets", "README.md"), "utf8"), /studio's own tools/);
    assert.match(await readFile(path.join(dir, ".gitattributes"), "utf8"), /\*\.glb binary/);
    assert.match(await readFile(path.join(dir, "src", "assets.js"), "utf8"), /export async function loadAsset/);
    assert.match(await readFile(path.join(dir, "docs", "CONTRACT.md"), "utf8"), /## Assets/);
    assert.equal(await readFile(path.join(dir, "notes-from-me.txt"), "utf8"), "rainy neon streets");
    assert.ok((await rig.core.games.list()).some((g) => g.name === project.name));
    assert.ok((await rig.core.games.recents()).some((g) => g.name === project.name));
  });

  it("a game reuses its conversation instead of creating additional chats", async () => {
    const rig = await startRig({ replies: [{ text: "On it." }] });
    rigs.push(rig);
    await rig.core.games.scaffold("arena", { title: "arena" });
    // Static tripwire: the scaffold must ship a game that runs on load. `running = false` means
    // a frozen screen until someone calls start() — and nobody in the pipeline does.
    assert.match(
      await readFile(path.join(rig.core.games.dirFor("arena"), "src", "studio.js"), "utf8"),
      // Anchored to the declaration — start() always contains a bare `running = true`.
      /let\s+running\s*=\s*true/,
    );
    const first = await rig.core.threadForGame("arena");
    await rig.core.sendUserMessage("add a dash", { thread: first });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "first chat");

    const second = await rig.core.createGameThread("arena");
    assert.equal(second, first);
    assert.equal(await rig.core.threadForGame("arena"), second, "the folder keeps its canonical chat");
    const firstRecord = await rig.core.store.getRecord(first);
    assert.equal((firstRecord.metadata as { project?: string }).project, "arena");
    assert.equal((firstRecord.metadata as { archived?: boolean }).archived, undefined);
  });

  it("forgetting an external folder leaves the files on disk", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-project-keep-"), "keep-me");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "precious.txt"), "do not delete");
    const project = await rig.core.adoptProject(dir);
    const forgotten = await rig.core.archiveGame(project.name);
    assert.equal(forgotten.trash, false);
    assert.equal(await readFile(path.join(dir, "precious.txt"), "utf8"), "do not delete");
    assert.ok(!(await rig.core.games.list()).some((g) => g.name === project.name));
  });

  it("read_file of a still puts pixels on the next model round", async () => {
    const rig = await startRig({
      replies: [
        {
          toolCalls: [{ id: "c1", name: "read_file", arguments: { project: "refs", file: "references/mood.png" } }],
          text: "Looking.",
        },
        { text: "Rainy neon. Got it." },
      ],
    });
    rigs.push(rig);
    await rig.core.games.scaffold("refs", { title: "refs" });
    await writeFile(path.join(rig.core.games.dirFor("refs"), "references", "mood.png"), PNG_1x1);
    const threadId = await rig.core.threadForGame("refs");
    await rig.core.sendUserMessage("look at the reference still", { thread: threadId });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(completions.length >= 2);
    const second = completions[1]!.body as { messages: Array<{ role: string; content?: unknown }> };
    assert.ok(countImages(second.messages) >= 1, "the model must receive the PNG, not a file path");

    const result = events.find((e) => e.data.type === "tool_result")?.data as {
      result: { content: string; details?: { data?: string } };
    };
    assert.match(result.result.content, /Attached|picture/i);
    assert.ok(!JSON.stringify(result.result).includes(PNG_1x1.toString("base64")), "pixels stay out of the log");

    const first = completions[0]!.body as { messages: Array<{ role: string; content?: unknown }> };
    const system = String(first.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /references\/mood\.png/);
    assert.match(system, /This project's folder/);
  });

  it("a first message that names an existing folder works in that folder, not a new library copy", async () => {
    const rig = await startRig({ replies: [{ text: "I'll work in this folder." }] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-named-ws-"), "blame-megastructure-game");
    await mkdir(path.join(dir, "ref"), { recursive: true });
    await writeFile(path.join(dir, "ref", "main.png"), PNG_1x1);

    const threadId = await rig.core.createGameThread();
    await rig.core.sendUserMessage(`make a megastructure. refs in ${dir}/ref`, { thread: threadId });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const record = await rig.core.store.getRecord(threadId);
    const project = (record.metadata as { project?: string }).project;
    assert.ok(project);
    assert.equal(await realpath(rig.core.games.dirFor(project!)), await realpath(dir));
    assert.ok(!(await rig.core.games.list()).some((g) => g.library && g.name !== project));
  });

  it("named stills outside the project are readable without copying, and read_file defaults to this chat's folder", async () => {
    const outside = path.join(await tmpDir("studio-stills-out-"), "ref");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "main.png"), PNG_1x1);

    const rig = await startRig({
      replies: [
        {
          toolCalls: [{ id: "c1", name: "read_file", arguments: { file: path.join(outside, "main.png") } }],
          text: "Looking.",
        },
        { text: "Grey concrete. Got it." },
      ],
    });
    rigs.push(rig);
    await rig.core.games.scaffold("inside", { title: "inside" });
    const threadId = await rig.core.threadForGame("inside");
    await rig.core.sendUserMessage(`keep going. stills are in ${outside}`, { thread: threadId });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(completions.length >= 2);
    const first = completions[0]!.body as { messages: Array<{ role: string; content?: unknown }> };
    const system = String(first.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /You are working in /);
    assert.match(system, /do not copy/i);
    const second = completions[1]!.body as { messages: Array<{ role: string; content?: unknown }> };
    assert.ok(countImages(second.messages) >= 1, "the named still must arrive as pixels");
  });
});

/** The CMake project the studio scaffolds. */
const GENEX_CMAKE = "cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n";
const CONTRACT_MAIN = '#include "studio.h"\nint main() {\n  studio::install({});\n}\n';
/** A hand-written raylib project in C++17 that builds every source in src/. */
const GLOBBING_RAYLIB_CMAKE = `cmake_minimum_required(VERSION 3.28)
project(pong CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(raylib 6.0 REQUIRED)
file(GLOB SRC src/*.c src/*.cpp)
add_executable(pong \${SRC})
target_link_libraries(pong raylib)
`;

/** The fixed shape of every C++ · raylib folder. */
const RAYLIB_SHAPE = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

/** Write `files` (relative path → text) under `dir`. */
async function writeTree(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

/** A stand-in for `src/game-template-cpp` until the C++ template lands, with the files adoption must withhold. */
const CPP_TEMPLATE: Record<string, string> = {
  ".gitignore": "build/\nCMakeCache.txt\nCMakeFiles/\ndist/\n.studio/\n",
  "CMakeLists.txt": GENEX_CMAKE,
  "src/main.cpp": CONTRACT_MAIN,
  "src/studio.h": "namespace studio { struct Game {}; void install(Game game); }\n",
  "src/studio.cpp": '#include "studio.h"\nvoid studio::install(Game) {}\n',
  "src/session.cpp": "// a raylib-free runtime unit\n",
  "web/shell.html": "<!doctype html><title>__GAME_TITLE__</title>\n",
  "assets/README.md": "# Assets\n",
  "references/README.md": "# References\n",
  "CLAUDE.md": "# Rules for a C++ game\n",
  "CLAUDE.own.md": "# Rules for a C++ game of its own\n",
  "NOTES.md": "# __GAME_TITLE__\n",
  "NOTES.own.md": "# __GAME_TITLE__ (its own)\n",
  "docs/CONTRACT.md": "# The C++ contract\n",
};

/** The C++ template the app ships, runtime and all. */
const SHIPPED_CPP_TEMPLATE = path.resolve(import.meta.dirname, "../..", "src", "game-template-cpp");

/** `[first, <empty>, last]`: a list with an empty slot, which a renderer's structured clone carries as it is. */
function gapped(first: string, last: string): string[] {
  const list: string[] = [];
  list[0] = first;
  list[2] = last;
  return list;
}

/** A library with both templates, on an injected host; the C++ one is the stand-in unless `cppTemplateDir` names another. */
async function nativeWorkspaces(platform: string = StudioPlatform.Mac, cppTemplateDir?: string) {
  const base = await tmpDir("studio-native-projects-");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(path.resolve(import.meta.dirname, "../.."), "src", "game-template"),
    cppTemplateDir: cppTemplateDir ?? (await writeTree(path.join(base, "game-template-cpp"), CPP_TEMPLATE)),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform,
  });
  return { games, base };
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

/** What a studio.json holds. */
async function studioJson(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8")) as Record<string, unknown>;
}

/** Bytes a sandbox-denied JSON file outside the game carries, which must never land in the game. */
const OUTSIDE_TOKEN = "sk-host-only-secret-41f7";

/** What an agent process can put at studio.json's name, pointing at a JSON file it cannot read itself. */
const PLANTED_STUDIO_JSON: ReadonlyArray<{ name: string; plant: (at: string, outside: string) => Promise<void> }> = [
  {
    name: "a link to a JSON file outside the game",
    plant: async (at, outside) => {
      await rm(at, { force: true });
      await symlink(outside, at);
    },
  },
  {
    name: "a dangling link",
    plant: async (at, outside) => {
      await rm(at, { force: true });
      await symlink(`${outside}.missing`, at);
    },
  },
  {
    name: "a folder",
    plant: async (at) => {
      await rm(at, { force: true });
      await mkdir(at);
    },
  },
];

/** Every entry under `dir` outside `.git`, links not followed: a link's target, a file's bytes, or a folder. */
async function treeFacts(dir: string): Promise<Array<[string, string]>> {
  const listed: Array<[string, string]> = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full).split(path.sep).join("/");
    if (rel.split("/")[0] === ".git") continue;
    const info = await lstat(full);
    if (info.isSymbolicLink()) listed.push([rel, `link -> ${await readlink(full)}`]);
    else if (info.isFile()) listed.push([rel, (await readFile(full)).toString("base64")]);
    else listed.push([rel, "(folder)"]);
  }
  return listed.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Whether any regular file under `dir` (links not followed) holds `text`. */
async function holds(dir: string, text: string): Promise<boolean> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if ((await readFile(path.join(entry.parentPath, entry.name), "utf8")).includes(text)) return true;
  }
  return false;
}

/** `git status --porcelain` in `dir`. */
async function porcelain(dir: string): Promise<string> {
  return (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout.trim();
}

const BROWSER_FILES = ["index.html", "src/main.js", "src/studio.js"];

describe("a C++ · raylib game's folder", () => {
  it("scaffold writes the C++ template and the studio.json of a C++ game", async () => {
    const { games } = await nativeWorkspaces();
    const project = await games.scaffold("pong", {
      title: "Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Mac, BuildTarget.Web],
    });
    for (const [rel, text] of Object.entries(CPP_TEMPLATE)) {
      const written = await readFile(path.join(project.dir, rel), "utf8").catch(() => null);
      if (rel.endsWith(".own.md")) assert.equal(written, null, `${rel} is a source, never a project file`);
      // The template's ignore rules are topped up with the studio's own, never rewritten.
      else if (rel === ".gitignore") assert.ok(written?.startsWith(text), String(written));
      else assert.equal(written, text.replaceAll("__GAME_TITLE__", "Pong"), rel);
    }
    const files = (await bytesIn(project.dir)).map(([rel]) => rel);
    for (const browserFile of BROWSER_FILES) assert.ok(!files.includes(browserFile), browserFile);
    const { createdAt, ...meta } = await studioJson(project.dir);
    assert.match(String(createdAt), /^\d{4}-\d\d-\d\dT/);
    // Key for key, in order, as the C++ game's studio.json is specified.
    assert.deepEqual(Object.entries(meta), [
      ["name", "pong"],
      ["title", "Pong"],
      ["contractVersion", 1],
      ["stack", GameStack.RaylibCpp],
      ["targets", [BuildTarget.Web, BuildTarget.Mac]],
      ["entry", "index.html"],
      ["main", "src/main.cpp"],
      ["build", null],
      ["own", false],
      ["kind", ProjectKind.RaylibCpp],
      ["serve", "."],
    ]);
    assert.deepEqual(project.shape, RAYLIB_SHAPE);
    assert.equal(project.built, false);
    assert.deepEqual(project.destinations, {
      stack: GameStack.RaylibCpp,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });

    // Scaffolding it again returns the game as it is; asking for the other stack is refused.
    const before = await bytesIn(project.dir);
    assert.equal(
      (await games.scaffold("pong", { stack: GameStack.RaylibCpp, caller: ScaffoldCaller.Internal })).dir,
      project.dir,
    );
    assert.equal((await games.scaffold("pong")).dir, project.dir);
    await assert.rejects(
      games.scaffold("pong", { stack: GameStack.ThreeJs }),
      (error: { code?: string }) => error.code === TargetRefusal.StackIsFixed,
    );
    assert.deepEqual(await bytesIn(project.dir), before);
  });

  it("a C++ game made without destinations plays in the browser and on the computer it was made on", async () => {
    for (const [platform, own] of [
      [StudioPlatform.Mac, BuildTarget.Mac],
      [StudioPlatform.Linux, BuildTarget.Linux],
      [StudioPlatform.Windows, BuildTarget.Windows],
    ] as const) {
      const { games } = await nativeWorkspaces(platform);
      const project = await games.scaffold("pong", { stack: GameStack.RaylibCpp, caller: ScaffoldCaller.Internal });
      assert.deepEqual(project.destinations?.targets, [BuildTarget.Web, own], platform);
      assert.deepEqual((await studioJson(project.dir)).targets, [BuildTarget.Web, own], platform);
    }
  });

  it("adopting a hand-written raylib folder copies no browser file and none of the studio's C++, keeps every byte it had, and records where it plays", async () => {
    const { games, base } = await nativeWorkspaces(StudioPlatform.Mac, SHIPPED_CPP_TEMPLATE);
    const own = {
      // A build that globs its sources: any .cpp the studio dropped into src/ would join it.
      "CMakeLists.txt": GLOBBING_RAYLIB_CMAKE,
      "src/main.cpp": '#include "raylib.h"\nint main() { InitWindow(800, 450, "pong"); }\n',
      "src/paddle.cpp": "int paddle_speed() { return 4; }\n",
      "README.md": "# Pong\n",
    };
    const dir = await writeTree(path.join(base, "handmade"), own);
    const before = await bytesIn(dir);
    const promised = await games.plannedWrites(dir);
    const project = await games.adopt(dir);
    const after = await bytesIn(dir);
    for (const [rel, bytes] of before) assert.equal(after.find(([name]) => name === rel)?.[1], bytes, rel);
    const added = after.filter(([rel, bytes]) => bytes !== "(folder)" && !before.some(([name]) => name === rel));
    const addedFiles = added.map(([rel]) => rel).sort();
    for (const browserFile of BROWSER_FILES) assert.ok(!addedFiles.includes(browserFile), browserFile);
    // No studio runtime lands in a CMake project that never asked for it, and no second entry beside its own.
    for (const withheld of ["src/studio.h", "src/studio.cpp", "web/shell.html", "docs/CONTRACT.md", "src/main.cpp"]) {
      assert.ok(!addedFiles.includes(withheld), `${withheld}: ${addedFiles.join(", ")}`);
    }
    assert.deepEqual(addedFiles, promised.filter((file) => file !== ".git").sort(), "the sheet's list is what landed");
    // src/ holds exactly the game's own sources: none of the studio's runtime units (C++20) joins its glob.
    const sources = after.map(([rel]) => rel).filter((rel) => rel.startsWith("src/"));
    assert.deepEqual(sources, ["src/main.cpp", "src/paddle.cpp"]);
    // Its rules and notes are written for the game that is here, not the scaffold the studio would have made.
    const ownPage = (name: string) => readFile(path.join(SHIPPED_CPP_TEMPLATE, name), "utf8");
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    assert.equal(claude, ownRules(await ownPage("CLAUDE.own.md"), RAYLIB_SHAPE));
    assert.notEqual(claude, await ownPage("CLAUDE.md"));
    const notes = await readFile(path.join(dir, "NOTES.md"), "utf8");
    assert.equal(
      notes,
      ownNotes(await ownPage("NOTES.own.md"), "handmade", RAYLIB_SHAPE, { file: "README.md", text: own["README.md"] }),
    );
    // A C++ game is built by the studio, never served as written: its notes say how it really runs.
    assert.doesNotMatch(notes, /runs as written|serves `index\.html`/);
    assert.match(notes, /C\+\+ toolchain/);
    const meta = await studioJson(dir);
    assert.equal(meta.stack, GameStack.RaylibCpp);
    assert.deepEqual(meta.targets, [BuildTarget.Web, BuildTarget.Mac]);
    assert.equal(meta.own, false);
    assert.equal(meta.kind, ProjectKind.RaylibCpp);
    assert.deepEqual(project.shape, RAYLIB_SHAPE);
    assert.equal(project.built, false);

    // Opening it again writes nothing more.
    const opened = await bytesIn(dir);
    await games.adopt(dir);
    assert.deepEqual(await bytesIn(dir), opened);

    // A folder that already names its destinations keeps them, and what else its studio.json says.
    const noted = await writeTree(path.join(base, "noted"), {
      "CMakeLists.txt": GENEX_CMAKE,
      "src/main.cpp": CONTRACT_MAIN,
      "studio.json": JSON.stringify({ note: "mine", targets: [BuildTarget.Windows] }),
    });
    const kept = await games.adopt(noted);
    const notedMeta = await studioJson(noted);
    assert.equal(notedMeta.note, "mine");
    assert.deepEqual(notedMeta.targets, [BuildTarget.Windows]);
    assert.equal(notedMeta.own, false);
    assert.deepEqual(kept.destinations, { stack: GameStack.RaylibCpp, targets: [BuildTarget.Windows] });
  });

  it("setDestinations adds a destination to a raylib game, and refuses the desktop to a Three.js game, writing nothing", async () => {
    const { games } = await nativeWorkspaces();
    const pong = await games.scaffold("pong", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    const { targets: _before, ...unchanged } = await studioJson(pong.dir);
    const updated = await games.setDestinations("pong", [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows]);
    const expected = [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows];
    assert.deepEqual(updated.destinations, { stack: GameStack.RaylibCpp, targets: expected });
    const { targets, ...rest } = await studioJson(pong.dir);
    assert.deepEqual(targets, expected);
    assert.deepEqual(rest, unchanged, "only the destinations moved");

    // A Three.js game plays in the browser: the Mac would change its stack, which never changes.
    const arena = await games.scaffold("arena");
    const arenaBefore = await bytesIn(arena.dir);
    await assert.rejects(
      games.setDestinations("arena", [BuildTarget.Web, BuildTarget.Mac]),
      (error: { code?: string }) => error.code === TargetRefusal.StackIsFixed,
    );
    assert.deepEqual(await bytesIn(arena.dir), arenaBefore);

    // Destinations the studio does not know are refused before anything is written.
    const pongBefore = await bytesIn(pong.dir);
    const refused: unknown[] = [
      [],
      ["playstation"],
      [BuildTarget.Web, BuildTarget.Web],
      ["__proto__"],
      BuildTarget.Mac,
      Array.from({ length: 40 }, () => BuildTarget.Web),
      [BuildTarget.Web, 1],
      new Array(1),
      gapped(BuildTarget.Web, BuildTarget.Windows),
    ];
    for (const bad of refused) {
      await assert.rejects(games.setDestinations("pong", bad as BuildTarget[]), JSON.stringify(bad));
    }
    assert.deepEqual(await bytesIn(pong.dir), pongBefore);
  });

  it("records the toolchain lock a build used in the host's library, never in the game's folder", async () => {
    const { games, base } = await nativeWorkspaces();
    const pong = await games.scaffold("pong", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web],
    });
    const arena = await games.scaffold("arena");
    await ensureRepo(pong.dir);
    const before = { pong: await bytesIn(pong.dir), arena: await bytesIn(arena.dir) };
    const digest = "0123456789abcdef".repeat(4);
    await games.writeNativeLock("pong", digest);
    assert.deepEqual(await games.nativeLocks(), [digest]);
    assert.deepEqual(await bytesIn(pong.dir), before.pong, "the game's own tree is byte-identical");
    assert.equal(await porcelain(pong.dir), "", "nothing a landing would read as the person's own edits");
    // The record is the host's, so it outlives the process that wrote it.
    const reread = new GameWorkspaces({
      root: games.root,
      templateDir: games.templateDir,
      vendorDir: games.vendorDir,
      indexFile: games.indexFile,
      userData: path.join(base, "userData"),
      homeDir: base,
      platform: StudioPlatform.Mac,
    });
    assert.deepEqual(await reread.nativeLocks(), [digest]);

    await assert.rejects(games.writeNativeLock("arena", digest), "a Three.js game has no C++ toolchain");
    for (const bad of ["", "../../etc/passwd", digest.toUpperCase(), digest.slice(1), `${digest}0`]) {
      await assert.rejects(games.writeNativeLock("pong", bad), bad);
    }
    assert.deepEqual(await games.nativeLocks(), [digest]);
    assert.deepEqual({ pong: await bytesIn(pong.dir), arena: await bytesIn(arena.dir) }, before);
  });

  /**
   * studio.json sits in a folder every agent process can write. A link planted at its name must
   * never carry a file the host can read and the sandbox cannot into the game: recording a lock
   * leaves the link, and what it points at, exactly as they were.
   */
  for (const planting of PLANTED_STUDIO_JSON) {
    it(`records a lock with studio.json ${planting.name}, and copies nothing into the game`, async () => {
      const { games, base } = await nativeWorkspaces();
      const pong = await games.scaffold("pong", {
        stack: GameStack.RaylibCpp,
        caller: ScaffoldCaller.Internal,
        targets: [BuildTarget.Web],
      });
      const secret = path.join(base, "outside", "keys.json");
      await mkdir(path.dirname(secret), { recursive: true });
      await writeFile(secret, JSON.stringify({ access_token: OUTSIDE_TOKEN }));
      await planting.plant(path.join(pong.dir, "studio.json"), secret);
      const before = await treeFacts(pong.dir);
      await games.writeNativeLock("pong", "0123456789abcdef".repeat(4)).catch(() => {});
      assert.deepEqual(await treeFacts(pong.dir), before, "the game's tree, links included, is as it was");
      assert.equal(await readFile(secret, "utf8"), JSON.stringify({ access_token: OUTSIDE_TOKEN }));
      assert.equal(await holds(pong.dir, OUTSIDE_TOKEN), false, "the outside file's bytes never reach the game");
    });

    it(`refuses to update studio.json ${planting.name}: setDestinations writes nothing`, async () => {
      const { games, base } = await nativeWorkspaces();
      const pong = await games.scaffold("pong", {
        stack: GameStack.RaylibCpp,
        caller: ScaffoldCaller.Internal,
        targets: [BuildTarget.Web],
      });
      const secret = path.join(base, "outside", "keys.json");
      await mkdir(path.dirname(secret), { recursive: true });
      await writeFile(secret, JSON.stringify({ access_token: OUTSIDE_TOKEN }));
      await planting.plant(path.join(pong.dir, "studio.json"), secret);
      const before = await treeFacts(pong.dir);
      await assert.rejects(games.setDestinations("pong", [BuildTarget.Web, BuildTarget.Mac]));
      assert.deepEqual(await treeFacts(pong.dir), before);
      assert.equal(await readFile(secret, "utf8"), JSON.stringify({ access_token: OUTSIDE_TOKEN }));
      assert.equal(await holds(pong.dir, OUTSIDE_TOKEN), false);
    });
  }

  it("adopting a C++ folder whose studio.json is a link to a file outside refuses, and writes nothing through it", async () => {
    const { games, base } = await nativeWorkspaces();
    const dir = await writeTree(path.join(base, "elsewhere", "pong"), {
      "CMakeLists.txt": GENEX_CMAKE,
      "src/main.cpp": CONTRACT_MAIN,
    });
    const secret = path.join(base, "outside", "keys.json");
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, JSON.stringify({ access_token: OUTSIDE_TOKEN }));
    await symlink(secret, path.join(dir, "studio.json"));
    await assert.rejects(games.adopt(dir));
    assert.equal(await readFile(secret, "utf8"), JSON.stringify({ access_token: OUTSIDE_TOKEN }));
    assert.equal(await holds(dir, OUTSIDE_TOKEN), false);
    assert.equal(await readlink(path.join(dir, "studio.json")), secret, "the link is left as it was");
  });

  it("chooses a game's bundle id once, keeps it across a restart and a move that leaves a link behind, and never reads one the game wrote", {
    skip: process.platform === "win32" && "POSIX links",
  }, async () => {
    const { games, base } = await nativeWorkspaces();
    const pong = await games.scaffold("pong", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    // Ids the game itself spells, anywhere in its folder, are agent-written: never read.
    const planted = "games.genex.game.aaaaaaaaaaaa";
    const meta = await studioJson(pong.dir);
    await writeFile(
      path.join(pong.dir, "studio.json"),
      JSON.stringify({ ...meta, bundleId: planted, native: { bundleId: planted } }),
    );
    await mkdir(path.join(pong.dir, "Game.app", "Contents"), { recursive: true });
    await writeFile(path.join(pong.dir, "Game.app", "Contents", "Info.plist"), `<string>${planted}</string>`);
    const before = await bytesIn(pong.dir);

    const first = await games.bundleIdFor("pong");
    const expected = `games.genex.game.${createHash("sha256")
      .update(await realpath(pong.dir))
      .digest("hex")
      .slice(0, 12)}`;
    assert.equal(first, expected);
    assert.equal(await games.bundleIdFor("pong"), first, "chosen once");
    assert.equal((await games.presentation("pong")).native?.bundleId, first, "kept in the host's library");
    assert.deepEqual(await bytesIn(pong.dir), before, "nothing written into the game");

    // A restart reads it back from the library index.
    const reopened = () =>
      new GameWorkspaces({
        root: games.root,
        templateDir: games.templateDir,
        vendorDir: games.vendorDir,
        indexFile: games.indexFile,
        userData: path.join(base, "userData"),
        homeDir: base,
        platform: StudioPlatform.Mac,
      });
    assert.equal(await reopened().bundleIdFor("pong"), first);

    // The folder moves and a link is left where it was: the library re-keys by real path through
    // that link, so the id stays though the new real path hashes differently. A move with no link
    // left is a new library entry (a new id, as covers and threads are new): a known limit.
    const moved = path.join(base, "moved", "pong");
    await mkdir(path.dirname(moved), { recursive: true });
    await rename(pong.dir, moved);
    await symlink(moved, pong.dir);
    const afterMove = reopened();
    assert.equal(await afterMove.bundleIdFor("pong"), first);
    assert.notEqual(
      createHash("sha256")
        .update(await realpath(pong.dir))
        .digest("hex")
        .slice(0, 12),
      first.slice(-12),
    );
  });

  it("replaces a library bundle id that is not one the studio chose, and refuses a game that is not C++", async () => {
    const { games } = await nativeWorkspaces();
    const pong = await games.scaffold("pong", {
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    const index = JSON.parse(await readFile(games.indexFile, "utf8").catch(() => "{}")) as Record<string, unknown>;
    const key = await realpath(pong.dir);
    const presentation = {
      ...(index.presentation as Record<string, unknown> | undefined),
      [key]: { native: { bundleId: "com.apple.finder" } },
    };
    await writeFile(games.indexFile, JSON.stringify({ version: 1, aliases: {}, recents: [], ...index, presentation }));
    const fresh = new GameWorkspaces({
      root: games.root,
      templateDir: games.templateDir,
      vendorDir: games.vendorDir,
      indexFile: games.indexFile,
      userData: games.userData,
      homeDir: games.homeDir,
      platform: StudioPlatform.Mac,
    });
    assert.match(await fresh.bundleIdFor("pong"), /^games\.genex\.game\.[0-9a-f]{12}$/);
    await games.scaffold("arena");
    await assert.rejects(games.bundleIdFor("arena"), "a Three.js game has no Mac bundle");
    assert.equal((await games.presentation("arena")).native, undefined);
  });

  it("upgradeContract leaves a raylib game's tree byte-identical", async () => {
    const { api, gamesRoot } = await coreLite();
    const dir = await writeTree(path.join(gamesRoot, "pong"), {
      "CMakeLists.txt": GENEX_CMAKE,
      "src/main.cpp": CONTRACT_MAIN,
      "studio.json": JSON.stringify({
        name: "pong",
        title: "Pong",
        contractVersion: 1,
        stack: GameStack.RaylibCpp,
        targets: [BuildTarget.Web, BuildTarget.Mac],
        entry: "index.html",
        main: "src/main.cpp",
        build: null,
        own: false,
        kind: ProjectKind.RaylibCpp,
        serve: ".",
        native: { lock: null },
      }),
    });
    const before = await bytesIn(dir);
    const upgrade = api()["game.upgradeContract"] as (p: { project: string }) => Promise<unknown>;
    const result = (await upgrade({ project: "pong" })) as { upgraded: boolean; reason?: unknown };
    assert.equal(result.upgraded, false);
    assert.equal(typeof result.reason, "string");
    assert.deepEqual(await bytesIn(dir), before, "no JavaScript contract, companion or page lands in a C++ game");
  });
});
