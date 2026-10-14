import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeResources, startRig, type Rig } from "../helpers/studio-rig.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { nameFromIdea } from "../../src/main/core/game-naming.ts";
import type { GameName, GameNameRequest } from "../../src/shared/game-project.ts";
import { GameWorkspaces, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { coverFromBrief, validateGameCover } from "../../src/shared/game-library.ts";
import { gameCoverSvg } from "../../src/shared/game-cover.ts";
import { librarySearch } from "../../src/renderer/game-search.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { DestinationBadge } from "../../src/shared/game-targets.ts";
import { type DestinationCheck, NativeRefusal } from "../../src/shared/native-contract.ts";
let rig: Rig;
before(async () => {
  rig = await startRig({ replies: [] });
});
after(async () => {
  await rig?.stop();
});
describe("game-first library", () => {
  it("reserves duplicate names without overwriting folders and creates exactly one conversation", async () => {
    const first = await rig.core.createGame("Snow Temple");
    await writeFile(path.join(first.dir, "keep.txt"), "owner content");
    const next = await rig.core.createGame("Snow Temple");
    assert.notEqual(next.name, first.name);
    assert.equal(await readFile(path.join(first.dir, "keep.txt"), "utf8"), "owner content");
    const ids = await Promise.all(Array.from({ length: 5 }, () => rig.core.threadForGame(first.name)));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await rig.core.createGameThread(first.name), ids[0]);
    assert.equal(
      (await rig.core.store.listThreads()).filter((t) => (t.metadata as { project?: string })?.project === first.name)
        .length,
      1,
    );
  });
  it("rename/pin/cover survive restart; removal keeps library files and re-adding restores history", async () => {
    const game = await rig.core.createGame("Neon Harbor");
    const thread = await rig.core.threadForGame(game.name);
    await rig.core.append([{ type: "messages", messages: [{ role: "user", content: "Preserve my history" }] }], thread);
    const cover = coverFromBrief("Neon Harbor");
    await rig.core.updateGame(game.name, { title: "Harbor at dusk", pinned: true, cover });
    const before = await readFile(path.join(game.dir, "studio.json"), "utf8");
    await rig.core.removeGame(game.name);
    assert.ok(!(await rig.core.games.list()).some((g) => g.name === game.name));
    assert.equal(await readFile(path.join(game.dir, "studio.json"), "utf8"), before);
    const restarted = new GameWorkspaces(rig.core.games);
    const [library, presentation] = await Promise.all([restarted.list(), restarted.presentation(game.name)]);
    assert.ok(!library.some((g) => g.name === game.name));
    assert.equal(presentation.primaryThreadId, thread);
    assert.deepEqual(presentation.cover, cover);
    const restored = await rig.core.adoptProject(game.dir);
    assert.equal(restored.name, game.name);
    assert.equal(restored.title, "Harbor at dusk");
    assert.equal(restored.pinned, true);
    assert.deepEqual(restored.cover, cover);
    assert.equal((await rig.core.games.presentation(game.name)).primaryThreadId, thread);
    assert.ok((await rig.core.store.listEvents(thread)).some((e) => e.data.type === "messages"));
  });
  it("a game made Untitled by a greeting takes its first idea's name in place, never over the person's own", async () => {
    const replies: Record<string, GameName> = {
      "Hi there": { title: "Untitled game", provisional: true },
      "A cozy island fishing game": { title: "Island Angler" },
    };
    const asked: string[] = [];
    const changed: string[] = [];
    const namer = {
      games: rig.core.games,
      name: async (request: GameNameRequest) => {
        asked.push(request.prompt);
        return replies[request.prompt] ?? { title: "Wrong", provisional: true };
      },
      changed: (project: string) => void changed.push(project),
    };
    const game = await rig.core.createGame("Untitled game", { provisional: true });
    assert.equal(game.provisional, true);
    assert.equal(await nameFromIdea(namer, game.name, { prompt: "Hi there" }), false, "small talk keeps waiting");
    assert.equal(await nameFromIdea(namer, game.name, { prompt: "A cozy island fishing game" }), true);
    const named = (await rig.core.games.list()).find((g) => g.name === game.name);
    assert.deepEqual(
      { title: named?.title, provisional: named?.provisional, dir: named?.dir },
      { title: "Island Angler", provisional: undefined, dir: game.dir },
      "renamed in place: the folder stays",
    );
    assert.deepEqual(changed, [game.name]);
    assert.equal(await nameFromIdea(namer, game.name, { prompt: "Add a lantern" }), false, "named once");

    const own = await rig.core.createGame("Untitled game", { provisional: true });
    await rig.core.updateGame(own.name, { title: "My Island" });
    asked.length = 0;
    assert.equal(await nameFromIdea(namer, own.name, { prompt: "A cozy island fishing game" }), false);
    assert.deepEqual(asked, [], "a name the person gave is theirs");
    assert.equal((await rig.core.games.list()).find((g) => g.name === own.name)?.title, "My Island");
  });
  it("chooses a canonical legacy conversation without deleting the others", async () => {
    const game = await rig.core.createGame("Archive planet");
    const primary = await rig.core.threadForGame(game.name);
    const old = await rig.core.store.createThread({
      title: "Earlier idea",
      metadata: { kind: "game", project: game.name },
    });
    assert.equal(await rig.core.threadForGame(game.name), primary);
    assert.equal((await rig.core.store.getRecord(old)).title, "Earlier idea");
  });
  it("keeps the look a game was born with and never replaces a custom image", async () => {
    const game = await rig.core.createGame("First brief");
    const cover = (await rig.core.games.presentation(game.name)).cover;
    assert.equal(cover?.kind, "recipe");
    assert.deepEqual(game.cover, cover);
    await rig.core.games.ensureCover(game.name);
    assert.deepEqual((await rig.core.games.presentation(game.name)).cover, cover);
    const uploaded = { kind: "image" as const, dataUrl: "data:image/png;base64,aGVsbG8=" };
    await rig.core.games.update(game.name, { cover: uploaded });
    await rig.core.games.ensureCover(game.name);
    assert.deepEqual((await rig.core.games.presentation(game.name)).cover, uploaded);
    assert.throws(() => validateGameCover({ kind: "image", dataUrl: 'data:image/svg+xml,<svg onload="alert(1)"/>' }));
  });
  it("a game New game made carries its folder's stamp as made, which the folder keeps until something is built", async () => {
    const api = rig.core.api();
    const listed = async (name: string) => (await api["game.list"]()).find((g) => g.name === name);
    const stampNow = async (project: string) => {
      const stamps = await api["game.contentStamp"]({ project, split: true });
      return typeof stamps === "string" ? stamps : stamps?.all;
    };
    const made = await rig.core.createGame("City Circuit");
    const stamp = (await listed(made.name))?.scaffoldStamp;
    assert.ok(stamp, "the harness reads it from game.list");
    assert.equal(made.scaffoldStamp, stamp, "New game answers it too");
    assert.equal(await stampNow(made.name), stamp, "nothing built yet");
    const restarted = new GameWorkspaces(rig.core.games);
    assert.equal((await restarted.list()).find((g) => g.name === made.name)?.scaffoldStamp, stamp, "kept by the index");
    // New game makes an empty folder: the first build writes the game's first file.
    await writeFile(path.join(made.dir, "main.js"), "// the first build\n");
    assert.notEqual(await stampNow(made.name), stamp, "a build changes the folder, never the stamp it was made with");
    const adopted = await rig.core.adoptProject(await tmpDir("opened-game-"));
    assert.equal((await listed(adopted.name))?.scaffoldStamp, undefined, "a folder the user opened has none");
  });
  it("creates new games in a chosen folder while existing games keep their folders, names and chats", async () => {
    const original = rig.core.games.root;
    const old = await rig.core.createGame("Old shelf");
    const thread = await rig.core.threadForGame(old.name);
    const chosen = path.join(path.dirname(rig.userData), "chosen games");
    await mkdir(chosen);
    await rig.core.setGamesRoot(chosen);
    assert.equal(rig.core.layout.gamesRoot, chosen);
    assert.deepEqual(JSON.parse(await readFile(path.join(rig.userData, "games-root.json"), "utf8")), { dir: chosen });
    const fresh = await rig.core.createGame("New shelf");
    assert.equal(path.dirname(fresh.dir), chosen);
    const listed = await new GameWorkspaces(rig.core.games).list();
    assert.equal(listed.find((game) => game.name === old.name)?.dir, old.dir);
    assert.ok(listed.some((game) => game.name === fresh.name));
    assert.equal(await rig.core.threadForGame(old.name), thread);
    // Every folder in the root is listed as a game, so a folder holding anything else is refused.
    const busy = path.join(path.dirname(rig.userData), "busy");
    await mkdir(path.join(busy, "photos"), { recursive: true });
    await assert.rejects(rig.core.setGamesRoot(busy), /empty folder/);
    await assert.rejects(rig.core.setGamesRoot(path.join(fresh.dir, "levels")), /outside your games/);
    assert.equal(rig.core.games.root, chosen);
    // Going back is allowed: the old folder holds only this library's games.
    await rig.core.setGamesRoot(original);
    const back = await rig.core.games.list();
    assert.equal(back.find((game) => game.name === old.name)?.dir, old.dir);
    assert.equal(back.find((game) => game.name === fresh.name)?.dir, fresh.dir);
  });
  it("a restart keeps creating games in the chosen folder", async (t) => {
    const root = await tmpDir("games-root-");
    const userData = path.join(root, "userData");
    const chosen = path.join(root, "chosen");
    await mkdir(userData);
    await mkdir(chosen);
    await writeFile(path.join(userData, "games-root.json"), JSON.stringify({ dir: chosen }));
    const core = new StudioCore({
      paths: { userData, resources: await makeResources() },
      gamesRoot: path.join(root, "default"),
      engines: [],
    });
    await core.init();
    t.after(() => core.stop());
    assert.equal(core.layout.gamesRoot, chosen);
    assert.equal(path.dirname((await core.createGame("Returns here")).dir), chosen);
  });
  it("search ranks titles and prefixes, handles Cyrillic and prototype-like words, and omits removed games", async () => {
    const a = await rig.core.createGame("Moon racer"),
      b = await rig.core.createGame("Racer constructor"),
      c = await rig.core.createGame("Лунный лес");
    const corpus = librarySearch([a, b, c], [], {});
    assert.equal(corpus.search("moon rac")[0]?.game?.name, a.name);
    assert.equal(corpus.search("constructor")[0]?.game?.name, b.name);
    assert.equal(corpus.search("лун")[0]?.game?.name, c.name);
    assert.deepEqual(corpus.search("zzyyxxmissing"), []);
  });
  it("artwork is deterministic, bounded and never embeds the brief as executable SVG", () => {
    const cover = coverFromBrief("<script>alert(1)</script> ice");
    assert.equal(gameCoverSvg(cover), gameCoverSvg(cover));
    assert.ok(gameCoverSvg(cover).length < 20000);
    assert.doesNotMatch(gameCoverSvg(cover), /<script|onload|href=/);
    assert.notEqual(gameCoverSvg(), gameCoverSvg(cover));
  });
});

/** A library on a Mac with the shipped C++ template: one raylib game and one Three.js game. */
async function nativeLibrary() {
  const base = await tmpDir("studio-native-checks-");
  const repo = path.resolve(import.meta.dirname, "../..");
  const options = {
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "game-template"),
    cppTemplateDir: path.join(repo, "src", "game-template-cpp"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: StudioPlatform.Mac,
  };
  const games = new GameWorkspaces(options);
  const targets = [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux];
  const pong = await games.scaffold("pong", { stack: GameStack.RaylibCpp, caller: ScaffoldCaller.Internal, targets });
  const arena = await games.scaffold("arena");
  return { games, pong, arena, options };
}

const NATIVE_CHECK: DestinationCheck = {
  badge: DestinationBadge.NotRunHere,
  lock: "0123456789ab",
  at: "2026-10-01T11:00:00.000Z",
};

describe("a destination check the build lane records", () => {
  it("is kept in the host's library by the game's real path and shown as the game's nativeChecks", async () => {
    const { games, options } = await nativeLibrary();
    await games.writeNativeCheck("pong", BuildTarget.Windows, NATIVE_CHECK);
    const failed = { ...NATIVE_CHECK, badge: DestinationBadge.Failed, refusal: NativeRefusal.ForeignImport };
    await games.writeNativeCheck("pong", BuildTarget.Linux, failed);
    const listed = (await games.list()).find((game) => game.name === "pong");
    assert.deepEqual(listed?.nativeChecks, { [BuildTarget.Windows]: NATIVE_CHECK, [BuildTarget.Linux]: failed });
    assert.equal((await games.list()).find((game) => game.name === "arena")?.nativeChecks, undefined);
    // The record is the host's, so it outlives the process that wrote it.
    const reread = new GameWorkspaces(options);
    const again = (await reread.list()).find((game) => game.name === "pong");
    assert.deepEqual(again?.nativeChecks, listed?.nativeChecks);
  });

  it("an unchanged check writes nothing", async () => {
    const { games, options } = await nativeLibrary();
    await games.writeNativeCheck("pong", BuildTarget.Windows, NATIVE_CHECK);
    const before = await readFile(options.indexFile, "utf8");
    await writeFile(options.indexFile, before.replace(/\n?$/, "\n\n"));
    const marked = await readFile(options.indexFile, "utf8");
    await games.writeNativeCheck("pong", BuildTarget.Windows, { ...NATIVE_CHECK });
    assert.equal(await readFile(options.indexFile, "utf8"), marked, "the index was not saved again");
  });

  const REFUSED: ReadonlyArray<[string, string, string, unknown]> = [
    ["a Three.js game", "arena", BuildTarget.Windows, NATIVE_CHECK],
    ["an unknown game", "nowhere", BuildTarget.Windows, NATIVE_CHECK],
    ["a name that climbs out", "../pong", BuildTarget.Windows, NATIVE_CHECK],
    ["a destination Genex does not know", "pong", "ios", NATIVE_CHECK],
    ["the browser, which has no desktop check", "pong", BuildTarget.Web, NATIVE_CHECK],
    ["a badge the stage does not know", "pong", BuildTarget.Windows, { ...NATIVE_CHECK, badge: "pass" }],
    ["a lock that is not 12 hex", "pong", BuildTarget.Windows, { ...NATIVE_CHECK, lock: "../x" }],
    ["a time that is no date", "pong", BuildTarget.Windows, { ...NATIVE_CHECK, at: "yesterday" }],
    ["a refusal the host does not know", "pong", BuildTarget.Linux, { ...NATIVE_CHECK, refusal: "rm -rf" }],
    ["no check at all", "pong", BuildTarget.Linux, null],
  ];
  for (const [label, name, target, check] of REFUSED)
    it(`refuses ${label} and writes nothing`, async () => {
      const { games, options } = await nativeLibrary();
      await games.writeNativeCheck("pong", BuildTarget.Windows, NATIVE_CHECK);
      const before = await readFile(options.indexFile, "utf8").catch(() => null);
      await assert.rejects(games.writeNativeCheck(name, target as BuildTarget, check as DestinationCheck));
      assert.equal(await readFile(options.indexFile, "utf8").catch(() => null), before, "index bytes unchanged");
    });

  it("drops a check planted in the library file that is not one, and keeps the valid ones", async () => {
    const { games, pong, options } = await nativeLibrary();
    await games.writeNativeCheck("pong", BuildTarget.Windows, NATIVE_CHECK);
    const index = JSON.parse(await readFile(options.indexFile, "utf8"));
    const key = Object.keys(index.presentation).find((dir) => dir.endsWith(`${path.sep}${path.basename(pong.dir)}`));
    assert.ok(key, "the library keys the game by its real path");
    // JSON.parse makes "__proto__" an own key, as a planted file would.
    const planted = JSON.parse(`{"__proto__": ${JSON.stringify(NATIVE_CHECK)}}`);
    index.presentation[key].native.checks = Object.assign(planted, {
      [BuildTarget.Windows]: NATIVE_CHECK,
      [BuildTarget.Linux]: { ...NATIVE_CHECK, lock: "../../etc" },
      [BuildTarget.Mac]: { ...NATIVE_CHECK, badge: "pass" },
      [BuildTarget.Web]: NATIVE_CHECK,
      ios: NATIVE_CHECK,
    });
    await writeFile(options.indexFile, JSON.stringify(index));
    const reread = new GameWorkspaces(options);
    const listed = (await reread.list()).find((game) => game.name === "pong");
    assert.deepEqual(listed?.nativeChecks, { [BuildTarget.Windows]: NATIVE_CHECK });
  });
});
