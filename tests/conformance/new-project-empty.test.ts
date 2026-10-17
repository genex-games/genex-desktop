/**
 * Every way Genex makes a project makes an empty folder; the web starter comes only from a typed
 * choice. An empty folder holds Genex's bookkeeping (its record, the ignore rules and a repository
 * with its first commit) and lists with no facts: its kind is picked by its first message.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPreviewIpc } from "../../src/main/ipc/preview.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { PROJECT_TOOL_ANSWER } from "../../src/main/core/project-tools-prompts.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { PluginCallBlocker } from "../../src/shared/plugins.ts";
import { CoreFact, FolderHolds, ProjectStarter } from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import { openOptions } from "../../src/shared/shape-words.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { stageFlags } from "../../src/renderer/panels/stage/stage-flags.ts";
import { gameStartedSince, kindPendingGame, StageView } from "../../src/renderer/stage.ts";
import { ObserverLive } from "../../src/shared/observers.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** What Genex keeps in a project of its own: its record, its ignore file and the repository. */
const BOOKKEEPING = [".git", ".gitignore", "studio.json"];
/** The fixture engine every delegation here runs on. */
const ENGINE = "claude-code";

let lite: CoreLite;
/** Folders beside the games folder: chosen parents and folders to open. */
let places: string;
before(async () => {
  const root = await realpath(await tmpDir("studio-new-empty-"));
  places = path.join(root, "places");
  await mkdir(places);
  lite = await coreLite({
    gamesRoot: path.join(root, "games"),
    executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
  });
});
after(async () => {
  lite.core.plugins.cancel();
  await lite.close();
});

const api = () => lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;

/** Whether a file is in a folder. */
const has = (dir: string, file: string) =>
  readFile(path.join(dir, file)).then(
    () => true,
    () => false,
  );

/** The game as the core lists it. */
async function listed(name: string) {
  const game = (await lite.core.games.list()).find((g) => g.name === name);
  assert.ok(game, `${name} is listed`);
  return game;
}

/** A game's facts as id and folder. */
const factRefs = (facts: ReadonlyArray<{ id: string; path: string }>) => facts.map(({ id, path }) => ({ id, path }));

/** A folder holds Genex's bookkeeping and nothing it wrote besides, and lists with no facts. */
async function assertEmptyGame(name: string, why: string, own: string[] = []): Promise<void> {
  const game = await listed(name);
  for (const file of ["index.html", "src/main.js", "CLAUDE.md"]) {
    assert.equal(await has(game.dir, file), false, `${why}: no ${file}`);
  }
  for (const file of ["studio.json", ".gitignore", ".git/HEAD"]) {
    assert.equal(await has(game.dir, file), true, `${why}: ${file}`);
  }
  assert.deepEqual((await readdir(game.dir)).sort(), [...BOOKKEEPING, ...own].sort(), why);
  assert.deepEqual(game.facts, [], `${why}: no kind yet`);
}

/** A fresh folder beside the games folder. */
const placeDir = () => mkdtemp(path.join(places, "place-"));

describe("new projects start empty", () => {
  it("every creation path makes an empty folder that lists with no facts", async () => {
    const made: Array<[string, string, string[]]> = [];
    made.push([(await lite.core.createGame("Kite One")).name, "New game", []]);
    const parent = await placeDir();
    made.push([(await lite.core.createGame("Kite Two", { parent })).name, "New game in a chosen folder", []]);
    made.push([(await lite.core.createGame("Kite Three", { provisional: true })).name, "the Home prompt's game", []]);
    const scaffolded = (await api()[HostMethod.GameScaffold]({ name: "kite-four" })) as { name: string };
    made.push([scaffolded.name, "the harness's game scaffold", []]);
    const gameCreate = lite.core.pluginServices.gameCreate;
    assert.ok(gameCreate, "the plugin service is wired");
    const created = await gameCreate("Kite Five");
    made.push([created.project, "a plugin's game.create", []]);
    const empty = await placeDir();
    made.push([(await lite.core.adoptProject(empty)).name, "opening an empty folder", []]);
    const notes = await placeDir();
    await writeFile(path.join(notes, "README.md"), "# Kite\nA kite game, one day.\n");
    await writeFile(path.join(notes, "idea.txt"), "wind, string, sky\n");
    made.push([(await lite.core.adoptProject(notes)).name, "opening a folder of notes", ["README.md", "idea.txt"]]);
    for (const [name, why, own] of made) await assertEmptyGame(name, why, own);
  });

  it("the web starter is written only when asked", async () => {
    for (const kind of [ProjectStarter.Web, "studio-template"]) {
      const name = `starter-${kind}`;
      await api()[HostMethod.GameScaffold]({ name, kind });
      const game = await listed(name);
      assert.equal(await has(game.dir, "index.html"), true, `kind ${kind} writes the starter`);
      assert.deepEqual(factRefs(game.facts), [{ id: CoreFact.WebGame, path: "." }], kind);
    }
    await assert.rejects(api()[HostMethod.GameScaffold]({ name: "starter-unity", kind: "unity" }));
    assert.equal(
      (await lite.core.games.list()).some((g) => g.name === "starter-unity"),
      false,
      "a kind Genex can't start makes nothing",
    );

    const pending = await lite.core.createGame("Kite Start Here");
    await api()[HostMethod.GameStart]({ project: pending.name, starter: ProjectStarter.Web });
    const started = await listed(pending.name);
    assert.equal(await has(started.dir, "index.html"), true, "game.start writes the starter");
    assert.equal(await has(started.dir, "src/main.js"), true);
    assert.deepEqual(factRefs(started.facts), [{ id: CoreFact.WebGame, path: "." }]);
    // The template's own-shape pages are what Genex writes from, never files of a game.
    for (const source of ["CLAUDE.own.md", "NOTES.own.md"]) {
      assert.equal(await has(started.dir, source), false, `game.start writes no ${source}`);
    }

    const web = await lite.core.games.scaffold("already-web");
    const godot = await lite.core.adoptProject(await copyProject(Project.GodotGame, await placeDir()));
    const unreal = await lite.core.adoptProject(await copyProject(Project.UnrealGame, await placeDir()));
    for (const game of [web, godot, unreal, started]) {
      const before = (await readdir(game.dir)).sort();
      await assert.rejects(
        api()[HostMethod.GameStart]({ project: game.name, starter: ProjectStarter.Web }),
        /already/i,
        `${game.name} has a kind`,
      );
      assert.deepEqual((await readdir(game.dir)).sort(), before, `${game.name}: nothing written`);
    }
    const hostile = await lite.core.createGame("Kite Hostile");
    for (const params of [
      { project: hostile.name, starter: "Web" },
      { project: hostile.name, starter: "../web" },
      { project: hostile.name },
      {},
      { project: "../kite-hostile", starter: ProjectStarter.Web },
    ]) {
      await assert.rejects(api()[HostMethod.GameStart](params), JSON.stringify(params));
    }
    await assertEmptyGame(hostile.name, "a refused start writes nothing");
  });

  it("game.start never writes through a link planted in the game's folder", async () => {
    const outside = await placeDir();
    const victimFile = path.join(outside, "victim.txt");
    const victimJson = path.join(outside, "victim.json");
    const victimDir = path.join(outside, "victim-dir");
    const dangling = path.join(outside, "not-there-yet");
    await writeFile(victimFile, "keep\n");
    await writeFile(victimJson, `${JSON.stringify({ keep: true })}\n`);
    await mkdir(victimDir);
    await writeFile(path.join(victimDir, "kept.txt"), "kept\n");
    const outsideBefore = async () => ({
      file: await readFile(victimFile, "utf8"),
      json: await readFile(victimJson, "utf8"),
      dir: (await readdir(victimDir)).sort(),
      dangling: await has(outside, "not-there-yet"),
    });
    const before = await outsideBefore();
    const rows: Array<[string, string]> = [
      [".gitignore", victimFile],
      ["studio.json", victimJson],
      ["references", victimDir],
      ["src", victimDir],
      [".gitattributes", dangling],
    ];
    for (const [at, target] of rows) {
      const game = await lite.core.createGame(`Kite Link ${at.replace(/\W/g, "")}`);
      await rm(path.join(game.dir, at), { recursive: true, force: true });
      await symlink(target, path.join(game.dir, at));
      await assert.rejects(
        api()[HostMethod.GameStart]({ project: game.name, starter: ProjectStarter.Web }),
        `a link at ${at} is refused`,
      );
      assert.deepEqual(await outsideBefore(), before, `${at}: nothing outside the game changed`);
      assert.equal(await has(game.dir, "index.html"), false, `${at}: no starter written`);
    }
  });

  it("game.scaffold with no kind leaves a game that is already there untouched", async () => {
    const web = await lite.core.games.scaffold("scaffold-again-web");
    const adopted = await lite.core.adoptProject(await copyProject(Project.GodotGame, await placeDir()));
    const linked = await lite.core.games.scaffold("scaffold-again-linked");
    const outside = path.join(await placeDir(), "victim.txt");
    await writeFile(outside, "keep\n");
    await rm(path.join(linked.dir, ".gitignore"));
    await symlink(outside, path.join(linked.dir, ".gitignore"));
    for (const game of [web, adopted, linked]) {
      const listing = (await readdir(game.dir)).sort();
      const record = await readFile(path.join(game.dir, "studio.json"), "utf8").catch(() => null);
      await api()[HostMethod.GameScaffold]({ name: game.name });
      assert.deepEqual((await readdir(game.dir)).sort(), listing, `${game.name}: nothing added`);
      assert.equal(await readFile(path.join(game.dir, "studio.json"), "utf8").catch(() => null), record);
    }
    assert.equal(await readFile(outside, "utf8"), "keep\n", "nothing written through the link");
  });

  it("a folder of its own files of a kind no rule knows has no kind pending, and is never handed the web starter", async () => {
    const pygame = await placeDir();
    await writeFile(path.join(pygame, "main.py"), "import pygame\n");
    await writeFile(path.join(pygame, "player.py"), "class Player:\n    pass\n");
    const notes = await placeDir();
    await writeFile(path.join(notes, "README.md"), "# Moth\nA moth game, one day.\n");
    const own = await listed((await lite.core.adoptProject(pygame)).name);
    const noted = await listed((await lite.core.adoptProject(notes)).name);
    const fresh = await listed((await lite.core.createGame("Kite Holds")).name);
    const table: Array<[string, typeof own, string, boolean]> = [
      ["a folder of Python files", own, FolderHolds.OwnFiles, false],
      ["a folder of notes", noted, FolderHolds.Notes, true],
      ["a new game", fresh, FolderHolds.Nothing, true],
    ];
    for (const [why, game, holds, pending] of table) {
      assert.deepEqual(game.facts, [], `${why}: no facts`);
      assert.equal(game.holds, holds, `${why}: what it holds`);
      assert.equal(kindPendingGame(game), pending, `${why}: Live's first-idea state`);
    }
    const before = (await readdir(own.dir)).sort();
    await assert.rejects(
      api()[HostMethod.GameStart]({ project: own.name, starter: ProjectStarter.Web }),
      /kind/i,
      "game.start refuses a folder of its own files",
    );
    assert.deepEqual((await readdir(own.dir)).sort(), before, "nothing is written beside the Python files");
    await api()[HostMethod.GameStart]({ project: noted.name, starter: ProjectStarter.Web });
    assert.equal(await has(noted.dir, "index.html"), true, "a folder of notes takes the starter when asked");
    assert.equal(await has(noted.dir, "README.md"), true, "and keeps its notes");
  });

  it("assets Genex delivers into a new game keep it without a kind: its first message still decides", async () => {
    const delivered = await lite.core.createGame("Kite Delivered");
    await mkdir(path.join(delivered.dir, "assets", "models"), { recursive: true });
    await writeFile(path.join(delivered.dir, "assets", "models", "kite.glb"), "glTF");
    const bundled = await lite.core.createGame("Kite Bundled");
    await mkdir(path.join(bundled.dir, "public", "assets"), { recursive: true });
    await writeFile(path.join(bundled.dir, "public", "assets", "sky.png"), "PNG");
    for (const game of [delivered, bundled]) {
      const now = await listed(game.name);
      assert.deepEqual(now.facts, [], `${game.name}: no facts`);
      assert.equal(now.holds, FolderHolds.Nothing, `${game.name}: Genex's own output is not the folder's own files`);
      assert.equal(kindPendingGame(now), true, `${game.name}: Live's first-idea state`);
    }
    // A public/ folder with files of the person's own beside the assets is theirs.
    await writeFile(path.join(bundled.dir, "public", "robots.txt"), "User-agent: *\n");
    assert.equal((await listed(bundled.name)).holds, FolderHolds.OwnFiles);
  });

  it("a game folder that can't be read, or is gone, has no kind pending", async () => {
    const locked = await lite.core.createGame("Kite Locked");
    await lite.core.games.start(locked.name, ProjectStarter.Web);
    const gone = await lite.core.createGame("Kite Gone");
    await chmod(locked.dir, 0o000);
    try {
      await assert.rejects(lite.core.games.factsOf(locked.name), "an unreadable folder's facts are not read as none");
      await assert.rejects(lite.core.games.kindOf(locked.name));
      const listedLocked = await listed(locked.name);
      assert.equal(listedLocked.holds, FolderHolds.Unreadable, "the library still lists it");
      assert.equal(kindPendingGame(listedLocked), false, "Live does not show the first-idea state");
      await assert.rejects(api()[HostMethod.GameStart]({ project: locked.name, starter: ProjectStarter.Web }));
    } finally {
      await chmod(locked.dir, 0o755);
    }
    await rm(gone.dir, { recursive: true, force: true });
    await assert.rejects(lite.core.games.factsOf(gone.name), "a folder that is gone has no facts to read");
    await assert.rejects(lite.core.games.kindOf(gone.name));
  });

  it("start_web_game is the chat's own, only while the game has no kind, and waits in Plan", async (t) => {
    const sessions: Array<{ cwd: string | undefined; tools: string[]; answer: unknown }> = [];
    lite.core.engines.register({
      id: ENGINE,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const tools = (request.liveTools ?? []).map((tool) => tool.name);
        const answer = tools.includes(ProjectTool.StartWebGame)
          ? await request.onLiveTool?.(ProjectTool.StartWebGame, {})
          : null;
        sessions.push({ cwd: request.cwd, tools, answer });
        return { ok: true, engine: ENGINE, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    t.after(async () => {
      await lite.core.mcp.close().catch(() => {});
    });
    const delegate = (project: string, threadId: string, extra: Record<string, unknown> = {}) =>
      api()["engine.delegate"]({ engine: ENGINE, project, threadId, prompt: "make a kite game", ...extra });

    // A builder in a worktree of a game with no kind is never handed it.
    const pending = await lite.core.createGame("Kite Builder");
    const pendingThread = await lite.core.threadForGame(pending.name);
    const worktree = path.join(lite.core.layout.scratch, "worktrees", `${pending.name}-part`);
    await mkdir(worktree, { recursive: true });
    await delegate(pending.name, pendingThread, { cwd: worktree });
    assert.equal(sessions.at(-1)?.tools.includes(ProjectTool.StartWebGame), false, "a builder");

    // In Plan mode the chat's own session is handed it, and the call waits for the plan.
    await lite.core.setPermissionMode(pendingThread, PermissionMode.Plan);
    await delegate(pending.name, pendingThread);
    const planned = sessions.at(-1);
    assert.equal(planned?.tools.includes(ProjectTool.StartWebGame), true, "the chat's own session");
    assert.match(String(planned?.answer), new RegExp(PluginCallBlocker.PlanMode));
    await assertEmptyGame(pending.name, "Plan writes nothing");

    // Out of Plan, the call writes the starter; the next turn has a web game and no start tool.
    await lite.core.setPermissionMode(pendingThread, PermissionMode.Auto);
    await delegate(pending.name, pendingThread);
    assert.equal(await has(pending.dir, "index.html"), true, "the starter is written");
    await delegate(pending.name, pendingThread);
    assert.equal(sessions.at(-1)?.tools.includes(ProjectTool.StartWebGame), false, "a web game's chat");

    // A folder of somebody's own files of a kind no rule knows is never offered it.
    const pygame = await placeDir();
    await writeFile(path.join(pygame, "main.py"), "import pygame\n");
    const own = await lite.core.adoptProject(pygame);
    await delegate(own.name, await lite.core.threadForGame(own.name));
    assert.equal(sessions.at(-1)?.tools.includes(ProjectTool.StartWebGame), false, "a folder of its own files");
  });

  it("a local model's start_web_game writes nothing while its chat is in Plan, and the starter once it is not", async (t) => {
    const changed: string[] = [];
    const root = await realpath(await tmpDir("studio-start-plan-"));
    const own = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
      onUiEvent: (event) => {
        if (event.type === UiEvent.GameChanged) changed.push((event.payload as { project: string }).project);
      },
    });
    t.after(async () => {
      own.core.plugins.cancel();
      await own.close();
    });
    const call = own.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const start = (project: string, threadId?: unknown) =>
      call[HostMethod.GameStart]!({
        project,
        starter: ProjectStarter.Web,
        ...(threadId === undefined ? {} : { threadId }),
      });
    /** A game with no kind yet and its chat, in `mode`. */
    const pendingGame = async (title: string, mode: PermissionMode) => {
      const game = await own.core.createGame(title);
      const threadId = await own.core.threadForGame(game.name);
      await own.core.setPermissionMode(threadId, mode);
      return { game, threadId };
    };
    const written = (dir: string) => has(dir, "index.html");

    // In Plan: the Plan answer, nothing written, no GameChanged.
    const { game, threadId } = await pendingGame("Kite Planned", PermissionMode.Plan);
    changed.length = 0;
    assert.deepEqual(await start(game.name, threadId), {
      blocker: PluginCallBlocker.PlanMode,
      message: PROJECT_TOOL_ANSWER.inPlan,
    });
    assert.deepEqual((await readdir(game.dir)).sort(), BOOKKEEPING, "Plan writes nothing");
    assert.deepEqual(changed, [], "no GameChanged");

    // Out of Plan, the same call writes the starter.
    await own.core.setPermissionMode(threadId, PermissionMode.Auto);
    await start(game.name, threadId);
    assert.equal(await written(game.dir), true, "the starter once the chat is out of Plan");
    assert.deepEqual(changed, [game.name], "and the app is told its game changed");

    // Another game's chat in Plan lends this game no Plan answer: the call does what it does with no thread.
    const planned = await pendingGame("Kite Elsewhere", PermissionMode.Plan);
    const { game: open } = await pendingGame("Kite Open", PermissionMode.Auto);
    await start(open.name, planned.threadId);
    assert.equal(await written(open.dir), true, "another game's chat in Plan holds nothing here");
    assert.deepEqual((await readdir(planned.game.dir)).sort(), BOOKKEEPING, "and that game is untouched");
    // A thread of no chat, the studio's own thread, or no thread at all in the shape the handler
    // reads (the harness host refuses those shapes first, harness-api.test.ts) lends none either.
    const nobodies: unknown[] = ["thread-nobody-made", own.core.mainThread, 7, { id: planned.threadId }];
    for (const [index, nobody] of nobodies.entries()) {
      const { game: loose } = await pendingGame(`Kite Loose ${index}`, PermissionMode.Auto);
      await start(loose.name, nobody);
      assert.equal(await written(loose.dir), true, `${JSON.stringify(nobody)}: as with no thread`);
    }
    assert.deepEqual((await readdir(planned.game.dir)).sort(), BOOKKEEPING, "the planned game is still untouched");
  });

  it("a local model's start_web_game names its chat and, held in Plan, says so and loads nothing", async () => {
    const startTool = gameTools.find((tool) => tool.name === ProjectTool.StartWebGame);
    assert.ok(startTool);
    const held = { blocker: PluginCallBlocker.PlanMode, message: PROJECT_TOOL_ANSWER.inPlan };
    for (const [answer, says] of [
      [held, PROJECT_TOOL_ANSWER.inPlan],
      [{ name: "kite" }, "The web starter is in the folder; build on it."],
    ] as const) {
      const host = ctxRecorder({
        threadId: "chat-1",
        extra: { project: "kite" },
        handlers: { [HostMethod.GameStart]: () => answer, [HostMethod.PreviewLoad]: () => ({}) },
      });
      assert.equal(await startTool.execute({}, host.ctx as never), says);
      assert.deepEqual(host.paramsOf(HostMethod.GameStart), [
        { project: "kite", starter: ProjectStarter.Web, threadId: "chat-1" },
      ]);
      assert.equal(
        host.sequence(HostMethod.PreviewLoad).length,
        answer === held ? 0 : 1,
        "Live loads only a written starter",
      );
    }
  });

  it("a Loop launched on a game with no kind starts it as a web game first", async () => {
    for (const [facts, starts, extra] of [
      [[], true, {}],
      [[], true, { holds: FolderHolds.Notes }],
      [[{ id: CoreFact.WebGame, path: ".", source: "core" }], false, {}],
    ] as const) {
      const launch = loopRecorder(facts, extra);
      const studio = studioOf(launch.ctx);
      await assert.rejects(
        launchFromIntake(
          studio as never,
          launch.ctx as never,
          { threadId: "t-1", project: "moth" },
          { goal: "a moth game" },
        ),
      );
      const order = launch.sequence((method) => method === HostMethod.GameStart || method === HostMethod.GameValidate);
      assert.deepEqual(order, starts ? [HostMethod.GameStart, HostMethod.GameValidate] : [HostMethod.GameValidate]);

      const run = loopRecorder(facts, extra);
      const run2 = { runId: "run-1", project: "moth", goal: "g", reference: { name: "r", shots: [] }, budgets: {} };
      await handleRunStart(studioOf(run.ctx) as never, { type: "run_start", threadId: "t-2", run: run2 } as never);
      const started = run.sequence((method) => method === HostMethod.GameStart || method === HostMethod.GameScaffold);
      assert.deepEqual(started, starts ? [HostMethod.GameStart, HostMethod.GameScaffold] : [HostMethod.GameScaffold]);
      if (starts) assert.deepEqual(run.paramsOf(HostMethod.GameStart)[0], { project: "moth", starter: "web" });
    }
  });

  it("a Loop on a folder of its own files of a kind no rule knows says it needs a kind and writes no starter", async () => {
    const launch = loopRecorder([], { holds: FolderHolds.OwnFiles });
    await assert.rejects(
      launchFromIntake(
        studioOf(launch.ctx) as never,
        launch.ctx as never,
        { threadId: "t-1", project: "moth" },
        { goal: "a moth game" },
      ),
      /kind/,
    );
    assert.deepEqual(
      launch.sequence((method) => method === HostMethod.GameStart),
      [],
      "no starter",
    );
    const run = loopRecorder([], { holds: FolderHolds.OwnFiles });
    const run2 = { runId: "run-1", project: "moth", goal: "g", reference: { name: "r", shots: [] }, budgets: {} };
    await handleRunStart(studioOf(run.ctx) as never, { type: "run_start", threadId: "t-2", run: run2 } as never);
    assert.deepEqual(
      run.sequence((method) => method === HostMethod.GameStart || method === HostMethod.GameScaffold),
      [],
      "no starter and no runner",
    );
  });

  it("the Open Game sheet calls an empty folder empty, not files of its own", async () => {
    const inspection = await lite.core.inspectFolder(await placeDir());
    assert.equal(inspection.ownFiles, false);
    const row = openOptions(inspection).find((option) => option.id === ".");
    assert.equal(row?.headline, "an empty folder");
    assert.doesNotMatch(row?.detail ?? "", /starter/);
    assert.deepEqual(row?.writes, ["studio.json", ".gitignore", ".git"], "bookkeeping only");
  });

  it("the Open Game sheet offers an empty folder that already holds Genex's bookkeeping, so it can be opened again", async () => {
    const made = await lite.core.createGame("Kite Reopen");
    await lite.core.games.forget(made.name);
    const notes = await placeDir();
    await writeFile(path.join(notes, "README.md"), "# Kite\n");
    const noted = await lite.core.adoptProject(notes);
    await lite.core.games.forget(noted.name);
    for (const [dir, headline] of [
      [made.dir, "an empty folder"],
      [noted.dir, "an empty folder"],
    ]) {
      const inspection = await lite.core.inspectFolder(dir);
      const rows = openOptions(inspection);
      assert.equal(rows.length, 1, `${dir}: one row to open it by`);
      assert.equal(rows[0]?.id, ".");
      assert.equal(rows[0]?.headline, headline);
      assert.deepEqual(rows[0]?.writes, [], "nothing left to write");
    }
  });

  it("Live shows the first-idea state and loads nothing for a game with no kind", async () => {
    const live = (phase: string | null, drawCalls = 0) => ({
      state: phase ? { phase, drawCalls } : null,
      liveLoad: { project: "kite", pending: false, since: 0 },
      stopped: false,
    });
    const flags = (game: object | null, state = live(null)) =>
      stageFlags({
        view: StageView.Live,
        beside: null,
        graph: null,
        planning: false,
        project: "kite",
        liveView: ObserverLive.Preview,
        pending: kindPendingGame(game),
        live: state,
      });
    assert.equal(kindPendingGame({ facts: [] }), true);
    assert.equal(kindPendingGame({ facts: [{ id: CoreFact.WebGame, path: "." }] }), false);
    assert.equal(kindPendingGame({}), false, "a game listed before facts has a kind");
    assert.equal(kindPendingGame(null), false);

    const pending = flags({ facts: [] });
    assert.equal(pending.showEmpty, true, "the first-idea state");
    assert.equal(pending.liveLoading, false, "no page loads");
    assert.equal(pending.gameStopped, false);
    const web = flags({ facts: [{ id: CoreFact.WebGame, path: ".", source: "core" }] });
    assert.equal(web.showEmpty, false);
    assert.equal(web.liveLoading, true, "a web game's page loads");
    const emptyScene = flags({ facts: [{ id: CoreFact.WebGame, path: ".", source: "core" }] }, live("empty"));
    assert.equal(emptyScene.showEmpty, true, "a web game with an empty scene still shows it");

    // Once its first message starts it, Live loads its page; a new game on the stage loads as before.
    assert.equal(gameStartedSince({ project: "kite", pending: true }, { project: "kite", pending: false }), true);
    assert.equal(gameStartedSince({ project: "kite", pending: true }, { project: "kite", pending: true }), false);
    assert.equal(gameStartedSince({ project: "kite", pending: false }, { project: "kite", pending: false }), false);
    assert.equal(gameStartedSince({ project: "other", pending: true }, { project: "kite", pending: false }), false);

    // The stage's load of a game's page (`studio:preview.load`) loads nothing for one with no kind.
    const loads: string[] = [];
    const port = {
      async load(project: string, entry: string) {
        loads.push(project);
        return `game://${project}/${entry}`;
      },
      status: () => ({ project: null, loadError: null, consoleErrors: [], url: null }),
      async evaluate() {
        return { via: "contract", ready: true, phase: "ready" };
      },
    };
    const stage = await coreLite({
      preview: port as never,
      gamesRoot: await realpath(await tmpDir("studio-live-empty-")),
    });
    try {
      const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
      const handle = createIpcHandle(
        { handle: (channel, listener) => listeners.set(channel, listener) },
        { fixture: true, isStudioUi: () => true },
      );
      registerPreviewIpc(handle, { core: stage.core, preview: () => null, previewBoundsSeen: { last: null } });
      const load = (project: string) =>
        listeners.get("studio:preview.load")?.({ sender: "studio", senderFrame: "main-frame" } as IpcSender, {
          project,
        });
      const pendingGame = await stage.core.createGame("Kite Waiting");
      await load(pendingGame.name);
      assert.deepEqual(loads, [], "no page is loaded for a game with no kind");
      await stage.core.games.start(pendingGame.name, ProjectStarter.Web);
      await load(pendingGame.name);
      assert.deepEqual(loads, [pendingGame.name], "once it is a web game, its page loads");
    } finally {
      await stage.close();
    }
  });
});

/**
 * A recorded harness ctx for a Loop launch on the game "moth", listed with `facts`: the launch stops
 * after its readiness check (a Stop pressed then), and a run stops at its runner's first scaffold.
 */
function loopRecorder(facts: readonly object[], extra: object = {}) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [{ name: "moth", title: "Moth", facts, ...extra }],
      [HostMethod.GameStart]: () => ({ name: "moth" }),
      [HostMethod.GameValidate]: () => ({ ok: true, contract: "loaded", problems: [], warnings: [] }),
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.GameScaffold]: () => {
        throw new Error("the runner began");
      },
    },
  });
  recorder.cancelAfter(HostMethod.GameValidate);
  return recorder;
}

/** The harness's studio state around a recorded ctx: nothing running, nothing stopped. */
function studioOf(ctx: ReturnType<typeof ctxRecorder>["ctx"]) {
  return {
    host: { ...ctx.host, heartbeat: () => {} },
    cancels: new Set<string>(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ctx,
  };
}
