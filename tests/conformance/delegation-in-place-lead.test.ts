/**
 * A Loop's lead that works in its game folder: seated by the host's own finding, asking in the chat's
 * mode, the chat's bookmark, its run's consent and no window unless the Loop is web.
 * Real core, fake delegated engine, no harness.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { leadToolsNote, mainAgentReachNote } from "../../src/main/core/delegation-prompts.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import { engineMode, PermissionMode, type ToolPermissionEvent } from "../../src/shared/permissions.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type {
  DelegateRequest,
  DelegateResult,
  LiveToolResult,
  PermissionAsk,
  PermissionReply,
} from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { Changes, until } from "../helpers/worker-chat.ts";

const ENGINE = "claude-code";
/** An engine that cannot ask about every call (Codex's own modes), as the world registers it too. */
const QUIET_ENGINE = "codex";
/** An engine Genex carries no worker seat on (a direct one), as the world registers it too. */
const DIRECT_ENGINE = "direct-fixture";
const RUN_ID = "run_open";
/** A connector call no run's consent covers waits for a card: this short a wait declines it instead. */
const CONSENT_WAIT_MS = 3_000;
/** A session's question nobody answers is withdrawn after this long: a seat granted in error fails, never hangs. */
const ASK_BOUND_MS = 8_000;
/** No test here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };
/** The engine connector of the game's engine plugin, by the name a session calls it. */
const ENGINE_PLUGIN = "unreal";
const CONNECTOR_TOOL = {
  name: `${ENGINE_PLUGIN}__editor_call`,
  description: "Call the editor",
  parameters: { type: "object", properties: {} },
  inputSchema: { type: "object", properties: {} },
};
const PLUGIN_TOOL = {
  name: "fixture__deliver",
  description: "Deliver",
  parameters: { type: "object", properties: {} },
};
const READ_DESKTOP: Omit<PermissionAsk, "toolUseId"> = {
  tool: "Read",
  input: { file_path: "/Users/me/Desktop/notes.txt" },
  always: [],
};

/** The host calls these tests make, as the harness calls them. */
type Api = Record<"engine.delegate" | "engine.abort", (params: unknown) => Promise<unknown>>;

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/**
 * A core with a Godot project opened as a game, its chat, and a delegated engine that asks about its
 * calls. Each session runs `during` with its request, then answers with the session id named.
 */
async function inPlaceWorld() {
  const root = await realpath(await tmpDir("in-place-lead-"));
  const places = path.join(root, "places");
  await mkdir(places);
  /** The core announced something (a card, a restart): a test waiting for one reads again. */
  const told = new Changes();
  const announced: string[] = [];
  const lite = await coreLite({
    gamesRoot: path.join(root, "games"),
    executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    consentTimeoutMs: CONSENT_WAIT_MS,
    onUiEvent: (event) => {
      announced.push(event.type);
      told.notify();
    },
  });
  lites.push(lite);
  const { core } = lite;
  // No harness in a lite core: a dispatch reaches nothing.
  core.host.dispatch = async () => undefined;
  const seen: DelegateRequest[] = [];
  const state = { sessionId: "", during: async (_request: DelegateRequest) => {} };
  for (const [id, permissionPrompts, kind] of [
    [ENGINE, true, "delegated"],
    [QUIET_ENGINE, false, "delegated"],
    [DIRECT_ENGINE, false, "direct"],
  ] as const)
    core.engines.register({
      id,
      label: "fixture",
      kind,
      supportsSessions: true,
      permissionPrompts,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
        seen.push(request);
        request.onEvent?.({ type: "system", payload: { subtype: "init", session_id: state.sessionId } });
        await state.during(request);
        return { ok: true, engine: id, sessionId: state.sessionId, turns: 1, usage: {}, summary: "" };
      },
    } as never);
  const godot = await core.adoptProject(await copyProject(Project.GodotGame, await mkdtemp(path.join(places, "p-"))));
  const threadId = await core.threadForGame(godot.name);
  const api = core.api() as unknown as Api;
  /** One turn of a session in the game folder, delegated in `thread`. */
  const delegate = async (
    sessionId: string,
    extra: Record<string, unknown>,
    { thread = threadId, game = godot.name, engine = ENGINE }: { thread?: string; game?: string; engine?: string } = {},
  ) => {
    state.sessionId = sessionId;
    await api["engine.delegate"]({ engine, prompt: "go", project: game, threadId: thread, ...extra });
    const request = seen.at(-1);
    assert.ok(request, "the engine was handed the turn");
    return request;
  };
  const bookmark = async (thread = threadId) =>
    ((await core.store.getRecord(thread)).metadata as { contractor?: { sessionId?: string } } | undefined)?.contractor
      ?.sessionId;
  const cards = async (thread = threadId): Promise<ToolPermissionEvent[]> =>
    (await core.store.listEvents(thread)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === CustomEvent.ToolPermission
        ? [custom.payload as unknown as ToolPermissionEvent]
        : [];
    });
  return { core, api, godot, threadId, seen, state, delegate, bookmark, cards, told, announced };
}

/**
 * A run's start on the record of a chat, as the harness writes it when a run begins: going, unless
 * `started` is false (registered only). A lead in place is seated only for a run that is going.
 */
async function recordRun(core: CoreLite["core"], game: string, runId: string, threadId: string, started = true) {
  const payload = { runId, project: game, mode: "director" };
  const batch = [
    { type: "custom", event_type: CustomEvent.RunRegistered, payload },
    ...(started ? [{ type: "custom", event_type: CustomEvent.RunStarted, payload: { runId, project: game } }] : []),
  ];
  await core.append(batch as never, threadId);
}

/** A run's end on the record of a chat (`completed`, or `paused` for a Resume), as the harness writes it. */
async function recordEnd(core: CoreLite["core"], game: string, runId: string, threadId: string, status: string) {
  const payload = { runId, project: game, executionStatus: status };
  await core.append([{ type: "custom", event_type: CustomEvent.RunFinished, payload }] as never, threadId);
}

/** A Loop's lead in its game folder, answering its chat: the brief an open Loop's turn carries. */
function inPlaceBrief(
  threadId: string,
  game: string,
  root: string,
  runId = RUN_ID,
  extra: Record<string, unknown> = {},
) {
  return {
    chatTurn: { messageId: runId },
    director: { runId, threadId, project: game, root, setup: null, tools: [], chatSession: true, inPlace: true },
    ...extra,
  };
}

/**
 * The session asks once, if it was handed a way to; the answer it got, if any. A question nobody
 * answers is withdrawn after `ASK_BOUND_MS`, so a seat granted in error fails its test, never hangs it.
 */
function asksOnce(world: Awaited<ReturnType<typeof inPlaceWorld>>, answers: Array<PermissionReply | undefined>) {
  world.state.during = async (request) => {
    const asks = request.leadAsks ?? request.permissions;
    const withdrawn = AbortSignal.timeout(ASK_BOUND_MS);
    answers.push(
      asks ? await asks.ask({ toolUseId: "tu", ...READ_DESKTOP }, withdrawn).catch(() => undefined) : undefined,
    );
  };
}

/** The first card not in `known`, once the core has announced it. */
async function nextCard(world: Awaited<ReturnType<typeof inPlaceWorld>>, known: Set<string>) {
  let card: ToolPermissionEvent | undefined;
  await until(world.told, async () => {
    card = (await world.cards()).find((row) => !known.has(row.requestId));
    return card !== undefined;
  });
  return card ?? null;
}

describe("a Loop's lead in its game folder", () => {
  it("seats a Loop's lead in its game folder, writing there and asking in the chat's mode", TEST_TIMEOUT, async () => {
    const world = await inPlaceWorld();
    const { core, godot, threadId, delegate } = world;
    await recordRun(core, godot.name, RUN_ID, threadId);
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    const answers: Array<PermissionReply | undefined> = [];
    asksOnce(world, answers);
    const known = new Set((await world.cards()).map((row) => row.requestId));
    const turn = delegate("lead-1", inPlaceBrief(threadId, godot.name, godot.dir));
    const card = await nextCard(world, known);
    assert.ok(card, "its question is a card in the chat");
    assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), true);
    const request = await turn;
    assert.equal(path.resolve(request.cwd), path.resolve(godot.dir), "it sits in the game folder");
    assert.equal(path.resolve(String(request.director?.root)), path.resolve(godot.dir), "and leads it");
    assert.equal(request.readOnly, undefined, "it writes there");
    assert.ok(request.leadAsks, "it asks as the chat's lead");
    assert.equal(request.permissions, undefined, "never as a chat turn of its own");
    assert.deepEqual(answers, [{ decision: "allow" }], "the person's answer reached it");
  });

  it("the chat's bookmark follows an in-place lead that is the chat's own session", TEST_TIMEOUT, async () => {
    const { core, godot, threadId, delegate, bookmark } = await inPlaceWorld();
    await recordRun(core, godot.name, RUN_ID, threadId);
    await delegate("chat-1", {});
    assert.equal(await bookmark(), "chat-1");
    await delegate("lead-fresh", inPlaceBrief(threadId, godot.name, godot.dir));
    assert.equal(await bookmark(), "lead-fresh", "a fresh session of the chat's lead becomes its bookmark");
    const notTheChats = inPlaceBrief(threadId, godot.name, godot.dir);
    notTheChats.director.chatSession = false;
    await delegate("lead-other", notTheChats);
    assert.equal(await bookmark(), "lead-fresh", "a lead that is not the chat's leaves the bookmark alone");
  });
});

describe("a Loop's lead in place has its run's tools on the game folder", () => {
  it(
    "its run's consent covers its engine connector, and its plugin tools act on the game folder with no note about a build it leads",
    TEST_TIMEOUT,
    async () => {
      const world = await inPlaceWorld();
      const { core, state, delegate } = world;
      // A game linked to its engine's project: its engine plugin's connector drives that editor.
      const valley = await core.games.scaffold("valley");
      const projects = await realpath(await tmpDir("in-place-uproject-"));
      const uproject = path.join(projects, "Valley", "Valley.uproject");
      await mkdir(path.dirname(uproject), { recursive: true });
      await writeFile(uproject, '{"FileVersion":3}\n');
      await core.engineLinks.link(
        ENGINE_PLUGIN,
        { project: valley.name, directory: valley.dir },
        { project: uproject },
      );
      const threadId = await core.threadForGame(valley.name);
      await recordRun(core, valley.name, RUN_ID, threadId, true);
      // The harness holds the studio awake for the run: it is going.
      core.host.options.onNotify?.(UiEvent.RunKeepawake, { runId: RUN_ID });
      // The plugin and connector registries, stood in for at their boundary.
      const bindings: Array<{ tool: string; directory?: string }> = [];
      core.plugins.snapshot = (() => ({
        tools: [PLUGIN_TOOL],
        guidance: "",
        applied: { plugins: [], skills: [] },
      })) as never;
      core.plugins.tool = (async (tool: string, _args: unknown, binding: { directory?: string }) => {
        bindings.push({ tool, ...(binding.directory ? { directory: binding.directory } : {}) });
        return "delivered";
      }) as never;
      core.mcp.toolsFor = (async () => [CONNECTOR_TOOL]) as never;
      core.mcp.owns = ((name: string) => name === CONNECTOR_TOOL.name) as never;
      core.mcp.ownerOf = ((id: string) => (id === ENGINE_PLUGIN ? ENGINE_PLUGIN : undefined)) as never;
      core.mcp.tool = (async () => "found") as never;
      // Nobody saved "always allow" for the editor's tool.
      core.mcp.toolAutoApproved = (async () => false) as never;
      const heard: string[] = [];
      state.during = async (request) => {
        for (const name of [PLUGIN_TOOL.name, CONNECTOR_TOOL.name])
          heard.push(
            await Promise.resolve(request.onLiveTool?.(name, {})).then(
              (result) => (result === undefined ? "no handler" : text(result)),
              (error: unknown) => `refused: ${String(error)}`,
            ),
          );
      };
      const request = await delegate("lead-1", inPlaceBrief(threadId, valley.name, valley.dir), {
        thread: threadId,
        game: valley.name,
      });
      assert.ok(request.leadAsks, "the chat's lead, in place");
      assert.deepEqual(heard, ["delivered", "found"], "its editor call needed no card: the run covers it");
      assert.deepEqual(bindings, [{ tool: PLUGIN_TOOL.name, directory: valley.dir }], "its plugin acts on the game");
      assert.equal(request.prompt.includes(leadToolsNote()), false, "no note about a build it leads elsewhere");
      assert.equal(request.onCheckpoint, undefined, "Genex's save points are its, never the chat's checkpoint");
    },
  );
});

describe("a Loop's lead's window and seat", () => {
  it("only a web Loop's lead is lent the preview window", TEST_TIMEOUT, async () => {
    const { core, godot, threadId, delegate } = await inPlaceWorld();
    const pond = await core.games.scaffold("pond");
    const pondChat = await core.threadForGame(pond.name);
    // A web Loop's lead: read-only in the game folder, leading its run's integration worktree.
    const worktree = path.join(core.layout.scratch, "autopilot", "run_web", "integration");
    await mkdir(path.dirname(worktree), { recursive: true });
    core.snapshots.register({ name: pond.name, dir: pond.dir });
    await core.snapshots.worktreeAt(pond.name, "HEAD", worktree);
    await recordRun(core, pond.name, "run_web", pondChat);
    const webBrief = {
      chatTurn: { messageId: "run_web" },
      readOnly: true,
      director: {
        runId: "run_web",
        threadId: pondChat,
        project: pond.name,
        root: worktree,
        setup: null,
        tools: [],
        chatSession: true,
      },
    };
    const web = await delegate("web-lead", webBrief, { thread: pondChat, game: pond.name });
    const names = (request: DelegateRequest) => (request.liveTools ?? []).map((tool) => tool.name);
    assert.ok(names(web).includes("look"), `the web lead looks through its window: ${names(web).join(", ")}`);
    await recordRun(core, godot.name, RUN_ID, threadId);
    const open = await delegate("open-lead", inPlaceBrief(threadId, godot.name, godot.dir));
    assert.ok(open.leadAsks, "the open lead is seated in place");
    for (const name of ["look", "computer"])
      assert.equal(names(open).includes(name), false, `the open lead has no ${name}: ${names(open).join(", ")}`);
    // The window follows the run's own profile, never the folder's facts read at the turn.
    const kindOf = core.games.kindOf.bind(core.games);
    core.games.kindOf = (async () => {
      throw new Error("the folder can't be read just now");
    }) as never;
    const unread = await delegate(
      "web-lead-unread",
      { ...webBrief, chatTurn: { messageId: "run_web" } },
      {
        thread: pondChat,
        game: pond.name,
      },
    );
    assert.ok(names(unread).includes("look"), "a web lead whose folder can't be read keeps its window");
    core.games.kindOf = (async () => ({ facts: [{ id: "web-game", path: "." }] })) as never;
    const nowWeb = await delegate("open-lead-web", inPlaceBrief(threadId, godot.name, godot.dir));
    assert.ok(nowWeb.leadAsks, "still seated in place");
    assert.equal(names(nowWeb).includes("look"), false, "an open Loop's folder that reads as web lends no window");
    core.games.kindOf = kindOf;
  });

  it("drops an in-place seat it cannot place, leaving the session unattended", TEST_TIMEOUT, async () => {
    const world = await inPlaceWorld();
    const { core, godot, threadId, delegate, bookmark } = world;
    const game = godot.name;
    await recordRun(core, game, RUN_ID, threadId);
    await delegate("chat-1", {});
    const other = await core.games.scaffold("other");
    await recordRun(core, other.name, "run_theirs", await core.threadForGame(other.name));
    const secondChat = await core.store.createThread({
      title: "Second chat",
      metadata: { kind: ThreadKind.Game, project: game },
    });
    await recordRun(core, game, "run_second", secondChat);
    // This game's chat the person closed, with a run of its own still going.
    const archivedChat = await core.store.createThread({
      title: "Closed chat",
      metadata: { kind: ThreadKind.Game, project: game, archived: true },
    });
    await recordRun(core, game, "run_archived", archivedChat);
    for (const [runId, status] of [
      ["run_done", "completed"],
      ["run_paused", "paused"],
    ] as const) {
      await recordRun(core, game, runId, threadId, true);
      await recordEnd(core, game, runId, threadId, status);
    }
    const link = path.join(core.layout.scratch, "autopilot", RUN_ID, "to-live");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(godot.dir, link);
    const hostile: Array<[string, Record<string, unknown>, string?]> = [
      ["root another game's folder", inPlaceBrief(threadId, game, other.dir)],
      ["root a link in scratch to this game's folder", inPlaceBrief(threadId, game, link)],
      ["root a subfolder of the game", inPlaceBrief(threadId, game, path.join(godot.dir, "scenes"))],
      ["in place and read-only", inPlaceBrief(threadId, game, godot.dir, RUN_ID, { readOnly: true })],
      ["a run of another game", inPlaceBrief(threadId, game, godot.dir, "run_theirs")],
      ["a run started in another chat of this game", inPlaceBrief(threadId, game, godot.dir, "run_second")],
      ["a run nobody started", inPlaceBrief(threadId, game, godot.dir, "run_ghost")],
      ["a run of this chat that finished", inPlaceBrief(threadId, game, godot.dir, "run_done")],
      ["a run of this chat that paused", inPlaceBrief(threadId, game, godot.dir, "run_paused")],
      ["a grant naming another chat", inPlaceBrief(secondChat, game, godot.dir)],
      ["a grant naming another chat and its own run", inPlaceBrief(secondChat, game, godot.dir, "run_second")],
      [
        "a running run of a chat the person closed",
        inPlaceBrief(archivedChat, game, godot.dir, "run_archived"),
        archivedChat,
      ],
    ];
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    const answers: Array<PermissionReply | undefined> = [];
    asksOnce(world, answers);
    const before = (await world.cards()).length;
    const seats: Array<Record<string, unknown>> = [];
    // A refused seat runs as a plain unattended session: no director, no run's job tools, no window.
    const RUN_TOOLS = /^(look|computer|job_)/;
    for (const [n, [label, brief, thread]] of hostile.entries()) {
      const request = await delegate(`hostile-${n}`, brief, { thread: thread ?? threadId });
      seats.push({
        label,
        asks: Boolean(request.leadAsks),
        permissions: Boolean(request.permissions),
        bookmark: await bookmark(),
        director: request.director === undefined ? "none" : "granted",
        runTools: (request.liveTools ?? []).map((tool) => tool.name).filter((name) => RUN_TOOLS.test(name)),
      });
    }
    assert.deepEqual(
      seats,
      hostile.map(([label]) => ({
        label,
        asks: false,
        permissions: false,
        bookmark: "chat-1",
        director: "none",
        runTools: [],
      })),
      "no way to ask, no director grant or run tools, and the chat's bookmark untouched",
    );
    assert.equal((await world.cards()).length, before, "no card");
    assert.equal(await bookmark(secondChat), undefined, "nor a bookmark in the other chat");
    assert.equal(await bookmark(archivedChat), undefined, "nor in the closed one");
  });
});

describe("a Loop's lead in place on an engine that cannot ask about every call", () => {
  it(
    "follows the chat's mode as that engine honours it, in a Plan chat and in a Manual one, and asks the chat",
    TEST_TIMEOUT,
    async () => {
      const world = await inPlaceWorld();
      const { core, godot, threadId, delegate } = world;
      await recordRun(core, godot.name, RUN_ID, threadId);
      const brief = inPlaceBrief(threadId, godot.name, godot.dir);
      const seats: Array<{ mode: unknown; leadAsks: boolean }> = [];
      for (const mode of [PermissionMode.Plan, PermissionMode.Manual]) {
        await core.setPermissionMode(threadId, mode);
        const request = await delegate(`quiet-${mode}`, brief, { engine: QUIET_ENGINE });
        seats.push({ mode: request.permissions?.mode, leadAsks: Boolean(request.leadAsks) });
        assert.equal(path.resolve(request.cwd), path.resolve(godot.dir), "it still sits in the game folder");
      }
      assert.deepEqual(seats, [
        { mode: PermissionMode.Plan, leadAsks: false },
        { mode: engineMode(QUIET_ENGINE, PermissionMode.Manual), leadAsks: false },
      ]);
      // Its question is a card in the chat, answered by the person.
      const answers: Array<PermissionReply | undefined> = [];
      asksOnce(world, answers);
      const known = new Set((await world.cards()).map((row) => row.requestId));
      const turn = delegate("quiet-asks", brief, { engine: QUIET_ENGINE });
      const card = await nextCard(world, known);
      assert.ok(card, "its question is a card in the chat");
      assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), true);
      await turn;
      assert.deepEqual(answers, [{ decision: "allow" }]);
    },
  );

  it(
    "keeps the fence the chat's own session on that engine keeps, and is never told it reaches the whole Mac",
    TEST_TIMEOUT,
    async () => {
      const { core, godot, threadId, delegate } = await inPlaceWorld();
      const other = await core.games.scaffold("other");
      await recordRun(core, godot.name, RUN_ID, threadId, true);
      await core.setPermissionMode(threadId, PermissionMode.Manual);
      const chat = await delegate("quiet-chat", {}, { engine: QUIET_ENGINE });
      const lead = await delegate("quiet-lead", inPlaceBrief(threadId, godot.name, godot.dir), {
        engine: QUIET_ENGINE,
      });
      assert.ok(lead.permissions, "the lead is seated in place");
      for (const [label, request] of [
        ["the chat's own session", chat],
        ["the lead in place", lead],
      ] as const) {
        assert.ok(
          (request.denyReads ?? []).map((dir) => path.resolve(dir)).includes(path.resolve(other.dir)),
          `${label} is denied the other game`,
        );
        assert.equal(request.prompt.includes(mainAgentReachNote()), false, `${label} is not told it reaches the Mac`);
      }
    },
  );

  it("a seat the host cannot place there is still unattended", TEST_TIMEOUT, async () => {
    const { core, godot, threadId, delegate } = await inPlaceWorld();
    await recordRun(core, godot.name, RUN_ID, threadId);
    await core.setPermissionMode(threadId, PermissionMode.Plan);
    const request = await delegate("quiet-ghost", inPlaceBrief(threadId, godot.name, godot.dir, "run_ghost"), {
      engine: QUIET_ENGINE,
    });
    assert.equal(request.permissions, undefined);
    assert.equal(request.leadAsks, undefined);
  });
});

describe("a Loop's workers beside its lead in place", () => {
  it(
    "a worker of its run on an engine Genex does not seat starts while the lead's turn holds the folder",
    TEST_TIMEOUT,
    async () => {
      const { core, api, godot, threadId, state, delegate } = await inPlaceWorld();
      await recordRun(core, godot.name, RUN_ID, threadId, true);
      core.host.options.onNotify?.(UiEvent.RunKeepawake, { runId: RUN_ID });
      const outcomes: string[] = [];
      let nested = false;
      state.during = async () => {
        if (nested) return;
        nested = true;
        const worker = { engine: DIRECT_ENGINE, prompt: "list the scenes", project: godot.name, threadId };
        const asked = { ...worker, readOnly: true, worker: { id: "w1", title: "Survey", runId: RUN_ID } };
        outcomes.push(
          await api["engine.delegate"](asked).then(
            () => "started",
            (error: unknown) => `refused: ${String(error)}`,
          ),
        );
      };
      await delegate("lead-1", inPlaceBrief(threadId, godot.name, godot.dir));
      assert.deepEqual(outcomes, ["started"]);
    },
  );

  it("no other worker takes a key of its own beside the session that holds the folder", TEST_TIMEOUT, async () => {
    const world = await inPlaceWorld();
    const { core, api, godot, threadId, state, seen, delegate } = world;
    const game = godot.name;
    await recordRun(core, game, RUN_ID, threadId, true);
    await recordRun(core, game, "run_done", threadId, true);
    await recordEnd(core, game, "run_done", threadId, "completed");
    const other = await core.games.scaffold("other");
    await recordRun(core, other.name, "run_theirs", await core.threadForGame(other.name), true);
    const secondChat = await core.store.createThread({
      title: "Second chat",
      metadata: { kind: ThreadKind.Game, project: game },
    });
    await recordRun(core, game, "run_second", secondChat, true);
    const notesThread = await core.store.createThread({ title: "Notes" });
    const workerOf = (runId: string, extra: Record<string, unknown> = {}, engine: string = DIRECT_ENGINE) => ({
      engine,
      prompt: "hostile worker",
      project: game,
      threadId,
      worker: { id: "w9", title: "Survey", runId },
      ...extra,
    });
    const beside = async (
      holder: () => Promise<unknown>,
      asked: Record<string, unknown>,
      first?: () => Promise<void>,
    ) => {
      let outcome = "";
      let nested = false;
      state.during = async () => {
        if (nested) return;
        nested = true;
        await first?.();
        outcome = await api["engine.delegate"](asked).then(
          () => "started",
          (error: unknown) => `refused: ${String(error)}`,
        );
      };
      await holder();
      state.during = async () => {};
      return outcome;
    };
    const lead = () => delegate("lead-1", inPlaceBrief(threadId, game, godot.dir));
    const chatTurn = () => delegate("chat-1", {});
    // The run ends while its lead's turn still holds the folder: a worker of it is one no more.
    const endsRun = () => recordEnd(core, game, RUN_ID, threadId, "completed");
    const hostile: Array<[string, () => Promise<unknown>, Record<string, unknown>, (() => Promise<void>)?]> = [
      // Runs no lead in place of their own was seated for: refused by more than one guard.
      ["a run nobody started, no lead's", lead, workerOf("run_ghost")],
      ["a run of this chat that finished, no lead's", lead, workerOf("run_done")],
      ["another game's run, no lead's", lead, workerOf("run_theirs")],
      ["a run of another chat of this game, no lead's", lead, workerOf("run_second")],
      ["an engine Genex seats, whose seat was refused", lead, workerOf("run_done", {}, ENGINE)],
      // The lead's own run, each refused by one guard alone: the chat it was started in, then that it is going.
      ["the lead's own run, asked from another chat of this game", lead, workerOf(RUN_ID, { threadId: secondChat })],
      [
        "the lead's own run, asked from a thread that is no game chat",
        lead,
        workerOf(RUN_ID, { threadId: notesThread }),
      ],
      [
        "a worker brief carrying an in-place lead's grant",
        lead,
        workerOf(RUN_ID, inPlaceBrief(threadId, game, godot.dir)),
      ],
      ["its own run, while the person's chat turn holds the folder", chatTurn, workerOf(RUN_ID)],
      // Last: the lead's run is over from here on.
      ["the lead's own run, once it ended under the lead's turn", lead, workerOf(RUN_ID), endsRun],
    ];
    const outcomes: Array<[string, boolean]> = [];
    for (const [label, holder, asked, first] of hostile) {
      const outcome = await beside(holder, asked, first);
      const busy = holder === lead ? /^refused: .*its lead's turn holds the folder/ : /^refused: .*already building/;
      outcomes.push([label, busy.test(outcome)]);
    }
    assert.deepEqual(
      outcomes,
      hostile.map(([label]) => [label, true]),
      "each is refused while the folder is held",
    );
    assert.equal(
      seen.filter((request) => request.prompt.includes("hostile worker")).length,
      0,
      "no hostile session reached the engine",
    );
  });
});

describe("a Loop's unseated worker and the game folder's key", () => {
  it(
    "a worker of its run started while its lead rests keeps its own key: the lead's next turn goes on, the person's turn in another chat waits",
    TEST_TIMEOUT,
    async () => {
      const { core, api, godot, threadId, state, delegate } = await inPlaceWorld();
      const game = godot.name;
      await recordRun(core, game, RUN_ID, threadId, true);
      core.host.options.onNotify?.(UiEvent.RunKeepawake, { runId: RUN_ID });
      const secondChat = await core.store.createThread({
        title: "Second chat",
        metadata: { kind: ThreadKind.Game, project: game },
      });
      // The lead's first turn: the host seats it in place, then it rests.
      await delegate("lead-1", inPlaceBrief(threadId, game, godot.dir));
      // Its worker starts while the lead rests, and works until the test lets it end.
      let release = () => {};
      const working = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begin = () => {};
      const begun = new Promise<void>((resolve) => {
        begin = resolve;
      });
      state.during = async (request) => {
        if (!request.prompt.includes("survey the scenes")) return;
        begin();
        await working;
      };
      const worker = api["engine.delegate"]({
        engine: DIRECT_ENGINE,
        prompt: "survey the scenes",
        project: game,
        threadId,
        readOnly: true,
        worker: { id: "w1", title: "Survey", runId: RUN_ID },
      });
      await begun;
      const outcome = (call: Promise<unknown>) =>
        call.then(
          () => "started",
          (error: unknown) => `refused: ${String(error)}`,
        );
      const leadAgain = await outcome(delegate("lead-2", inPlaceBrief(threadId, game, godot.dir)));
      const person = await outcome(delegate("second-1", {}, { thread: secondChat }));
      release();
      await worker;
      assert.equal(leadAgain, "started", "the lead's next turn is not refused for its own worker");
      assert.match(person, /^refused: .*Loop has a worker/, "the person's turn elsewhere waits for the worker");
    },
  );
});

describe("a planned restart of the harness", () => {
  it(
    "ends a lead in place that holds the game folder, as it ends the harness's writers there",
    TEST_TIMEOUT,
    async () => {
      const { core, godot, threadId, state, delegate, told, announced } = await inPlaceWorld();
      await recordRun(core, godot.name, RUN_ID, threadId, true);
      let aborted = false;
      let begin = () => {};
      const begun = new Promise<void>((resolve) => {
        begin = resolve;
      });
      state.during = async (request) => {
        begin();
        // Writing in the folder until it is told to stop (or the test's bound passes).
        await sleep(10_000, undefined, { signal: request.signal }).catch(() => {});
        aborted = request.signal?.aborted === true;
      };
      const turn = delegate("lead-1", inPlaceBrief(threadId, godot.name, godot.dir)).catch(() => {});
      await begun;
      const { restart, healthcheck } = core.host;
      core.host.restart = (async () => {}) as never;
      core.host.healthcheck = (async () => true) as never;
      try {
        await core.requestSelfRestart("test", 0);
        await turn;
        // The applied update's own record is written after the restart: it lands before the stubs go.
        await until(told, () => announced.includes(UiEvent.SelfmodRestarted));
      } finally {
        core.host.restart = restart;
        core.host.healthcheck = healthcheck;
      }
      assert.equal(aborted, true, "the lead's session in the folder was ended, not left writing");
    },
  );
});

describe("Genex's pause of an open Loop reaches only its lead", () => {
  it(
    "an abort addressed to a run's lead in place never reaches another chat's session in the folder",
    TEST_TIMEOUT,
    async () => {
      const { core, api, godot, threadId, state, delegate } = await inPlaceWorld();
      await recordRun(core, godot.name, RUN_ID, threadId, true);
      const answers: unknown[] = [];
      const signals: AbortSignal[] = [];
      state.during = async (request) => {
        if (request.signal) signals.push(request.signal);
        answers.push(await api["engine.abort"]({ cwd: godot.dir, lead: RUN_ID }));
      };
      await delegate("chat-1", {});
      assert.deepEqual(answers, [{ aborted: 0 }], "the person's own turn is no lead of the run");
      assert.equal(signals[0]?.aborted, false, "and is never cut");
      await delegate("lead-1", inPlaceBrief(threadId, godot.name, godot.dir));
      assert.deepEqual(answers.at(-1), { aborted: 1 }, "the run's lead in place is");
      assert.equal(signals.at(-1)?.aborted, true);
    },
  );
});
