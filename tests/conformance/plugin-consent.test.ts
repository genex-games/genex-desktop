/**
 * Plugin consent ledger — every way a question can be settled, and that each one settles it once —
 * and the run's own consent: the Unreal Loop's live builder calls its game's engine connector with
 * no card, and nothing else does.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it, test } from "node:test";
import { PluginConsent } from "../../src/main/plugin-consent.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { ConsentChoice, consentChoices, consentTitle } from "../../src/renderer/chat/consent-card.ts";
import { COMPUTER_SETTING_CARD_WORDS } from "../../src/renderer/words.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { STUDIO_CONSENT_NAMES, StudioConsentSource } from "../../src/shared/plugins.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { coreLite } from "../helpers/core-lite.ts";

const ask = (
  consent: PluginConsent,
  consentId: string,
  extra: { project?: string; threadId?: string; signal?: AbortSignal } = {},
) =>
  consent.request({
    consentId,
    pluginId: "genex",
    tool: "genex__publish",
    project: extra.project ?? "game",
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });

test("the user's answer settles the question, either way", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000, now: () => 1_000 });
  const approved = ask(consent, "c1", { threadId: "t1" });
  const declined = ask(consent, "c2", { threadId: "t1" });
  assert.deepEqual(
    consent.pending().map((p) => [p.consentId, p.expiresAt]),
    [
      ["c1", 11_000],
      ["c2", 11_000],
    ],
  );
  assert.equal(consent.resolve("c1", true), true);
  assert.equal(consent.resolve("c2", false), true);
  assert.deepEqual(await approved, { approved: true, by: "user" });
  assert.deepEqual(await declined, { approved: false, by: "user" });
  assert.deepEqual(consent.pending(), []);
});

test("nobody answering declines on the user's behalf", async () => {
  const consent = new PluginConsent({ timeoutMs: 20 });
  assert.deepEqual(await ask(consent, "c1"), { approved: false, by: "timeout" });
  assert.equal(consent.resolve("c1", true), false, "a click after the timeout changes nothing");
});

test("a turn's end and a game's Stop withdraw only the questions in their scope", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  const inTurn = ask(consent, "c1", { project: "game", threadId: "t1" });
  const otherTurn = ask(consent, "c2", { project: "game", threadId: "t2" });
  const otherGame = ask(consent, "c3", { project: "other", threadId: "t3" });
  const unbound = ask(consent, "c4", { project: "game" });
  assert.equal(consent.cancel({ threadId: "t1" }, "turn"), 1);
  assert.deepEqual(await inTurn, { approved: false, by: "turn" });
  assert.deepEqual(
    consent.pending().map((p) => p.consentId),
    ["c2", "c3", "c4"],
  );
  assert.equal(consent.cancel({ project: "game" }, "stop"), 2);
  assert.deepEqual(await otherTurn, { approved: false, by: "stop" });
  assert.deepEqual(await unbound, { approved: false, by: "stop" });
  assert.deepEqual(
    consent.pending().map((p) => p.consentId),
    ["c3"],
  );
  assert.equal(consent.cancel({}, "stop"), 1, "an empty scope is the shutdown path: everything goes");
  assert.deepEqual(await otherGame, { approved: false, by: "stop" });
  assert.equal(consent.cancel({}, "stop"), 0);
});

test("an unknown or already settled id resolves to false; a repeat answer is idempotent", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  assert.equal(consent.resolve("nope", true), false);
  const answer = ask(consent, "c1");
  assert.equal(consent.resolve("c1", false), true);
  assert.equal(consent.resolve("c1", true), false);
  assert.deepEqual(await answer, { approved: false, by: "user" });
  await assert.rejects(Promise.all([ask(consent, "dup"), ask(consent, "dup")]), /already pending/);
});

test("the turn's abort signal withdraws its question as a stop", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  const controller = new AbortController();
  const answer = ask(consent, "c1", { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await answer, { approved: false, by: "stop" });
  assert.equal(consent.resolve("c1", true), false);
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await ask(consent, "c2", { signal: already.signal }), { approved: false, by: "stop" });
  assert.deepEqual(consent.pending(), []);
});

test("the studio's card that turns computer control on names its source and asks Turn on or Not now", () => {
  assert.equal(STUDIO_CONSENT_NAMES[StudioConsentSource.ComputerSetting], "Computer control");
  const payload = {
    consentId: "c-setting",
    pluginId: StudioConsentSource.ComputerSetting,
    pluginName: STUDIO_CONSENT_NAMES[StudioConsentSource.ComputerSetting],
    tool: `${StudioConsentSource.ComputerSetting}__computer_control`,
    args: {},
    project: "garden",
    prompt: "Turn on computer control for every chat?",
    state: "pending",
  };
  const [card] = toEntries([
    {
      id: "000001",
      thread_id: "t1",
      turn_id: "turn",
      session_id: null,
      created_at: new Date(1).toISOString(),
      data: { type: "custom", event_type: "plugin_consent", payload },
    },
  ]) as Array<Parameters<typeof consentChoices>[0]>;
  assert.ok(card);
  assert.equal(card.consentSource, "Computer control");
  assert.equal(consentTitle(card), COMPUTER_SETTING_CARD_WORDS.title);
  assert.match(consentTitle(card), /every chat/);
  assert.deepEqual(
    consentChoices(card).map((choice) => [choice.id, choice.label]),
    [
      [ConsentChoice.Once, COMPUTER_SETTING_CARD_WORDS.turnOn.label],
      [ConsentChoice.Decline, COMPUTER_SETTING_CARD_WORDS.notNow.label],
    ],
  );
  // Any other card keeps its own words and Allow once / Don't allow.
  const plugin = { ...card, consentSourceId: "genex", consentSource: "Genex", consentPrompt: "Publish?" };
  assert.equal(consentTitle(plugin), "Publish?");
  assert.deepEqual(
    consentChoices(plugin).map((choice) => choice.label),
    ["Allow once", "Don't allow"],
  );
});

// ── the run's own consent ────────────────────────────────────────────────────────────────

const SERVER = path.resolve("tests/fixtures/mcp/plugin-server.mjs");
const ENGINE = "claude-code";
/** A card nobody answers declines this fast here, so every row that asks ends quickly. */
const CONSENT_TIMEOUT_MS = 300;
const ENGINE_PLUGIN = "enginedemo";
const RIVAL_PLUGIN = "rivaldemo";
const OTHER_PLUGIN = "otherdemo";
const ENGINE_CONNECTOR = `${ENGINE_PLUGIN}-editor__echo`;
const RIVAL_CONNECTOR = `${RIVAL_PLUGIN}-editor__echo`;
const OTHER_CONNECTOR = `${OTHER_PLUGIN}-editor__echo`;
const GAME_ENGINE = "game-engine";

type Game = "valley" | "plain";

/**
 * One session's call. `label` is the text it sends, which finds its records; `director` names the
 * run its grant is for (and, when it differs, the game the grant says); none is the chat's own session.
 */
interface Row {
  label: string;
  game: Game;
  connector: string;
  director?: { runId: string; project?: string };
  /** The chat the delegation names: the game's own (default), none, or another chat of the same game. */
  chat?: "none" | "other";
}

/** What one session's connector call came to: its answer, whether a card asked, whether it went out. */
interface Outcome {
  answer: string;
  asked: boolean;
  called: boolean;
}

/**
 * A local plugin with one MCP server (`editor`, echoing), with the capabilities it is granted; one
 * with `game-engine` declares an engine of its own whose projects are Unreal project files.
 */
async function connectorPackage(id: string, capabilities: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `studio-${id}-`));
  const manifest = {
    apiVersion: 3,
    id,
    version: "1.0.0",
    name: `Demo ${id}`,
    publisher: "Studio tests",
    description: "An editor connector.",
    backend: "backend.mjs",
    capabilities,
    ...(capabilities.includes(GAME_ENGINE)
      ? {
          engine: {
            id,
            label: `Demo ${id}`,
            projectFiles: [".uproject"],
            fact: "unreal-project",
            projectInFolder: true,
          },
        }
      : {}),
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    mcpServers: [
      {
        id: "editor",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage:project",
        description: "Echoes.",
      },
    ],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "backend.mjs"), "export async function activate(){return {};}\n");
  await cp(SERVER, path.join(dir, "server.mjs"));
  return dir;
}

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/**
 * An engine game (`valley`, linked to the engine plugin's Unreal project) and a web game (`plain`),
 * each with a chat in Auto. Runs: one of each game held awake; one of `valley` that finished while its
 * pass still holds it; one of `valley` the harness no longer holds; one held awake that nobody started.
 * Plugins: the engine plugin, another engine plugin that never linked `valley`, and a plugin with a
 * plain connector. Each `call` delegates one session that calls one connector tool during its turn.
 */
async function consentWorld() {
  const lite = await coreLite({
    gamesRoot: await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-run-consent-"))),
    consentTimeoutMs: CONSENT_TIMEOUT_MS,
  });
  const { core } = lite;
  let pending: Row | undefined;
  let answer = "";
  core.engines.register({
    id: ENGINE,
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      const { connector = "", label = "" } = pending ?? {};
      answer = await Promise.resolve(request.onLiveTool?.(connector, { text: label })).then(
        (result) => (result === undefined ? "no handler" : text(result)),
        (error: unknown) => `refused: ${String(error)}`,
      );
      return { ok: true, engine: ENGINE, sessionId: "s", turns: 1, usage: {}, summary: "" };
    },
  } as never);
  // From GitHub, so a run's own consent may cover their servers (a local plugin's server asks every call).
  const fromGithub = (id: string) => ({ kind: "github" as const, repo: `studio-tests/${id}`, sha: "a".repeat(40) });
  await core.plugins.installLocal(
    await connectorPackage(ENGINE_PLUGIN, [GAME_ENGINE]),
    "github",
    [GAME_ENGINE],
    fromGithub(ENGINE_PLUGIN),
  );
  await core.plugins.installLocal(
    await connectorPackage(RIVAL_PLUGIN, [GAME_ENGINE]),
    "github",
    [GAME_ENGINE],
    fromGithub(RIVAL_PLUGIN),
  );
  await core.plugins.installLocal(await connectorPackage(OTHER_PLUGIN, []), "github", [], fromGithub(OTHER_PLUGIN));
  // Loaded from folders, they start off: the person turns them on.
  for (const id of [ENGINE_PLUGIN, RIVAL_PLUGIN, OTHER_PLUGIN]) await core.plugins.setEnabled(id, true);
  const valley = await core.games.scaffold("valley");
  const plain = await core.games.scaffold("plain");
  const dirs: Record<Game, string> = { valley: valley.dir, plain: plain.dir };
  const threads: Record<Game, string> = {
    valley: await core.threadForGame("valley"),
    plain: await core.threadForGame("plain"),
  };
  const otherChat = await core.store.createThread({
    title: "Second chat",
    metadata: { kind: "game", project: "valley" },
  });
  // Manual, where a connector's card asks: Auto sends a plugin connector's calls with none.
  for (const threadId of [...Object.values(threads), otherChat])
    await core.setPermissionMode(threadId, PermissionMode.Manual);
  const projects = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-run-consent-uproject-")));
  await mkdir(path.join(projects, "Valley"));
  const uproject = path.join(projects, "Valley", "Valley.uproject");
  await writeFile(uproject, '{"FileVersion":3}\n');
  await core.engineLinks.link(ENGINE_PLUGIN, { project: "valley", directory: valley.dir }, { project: uproject });
  const record = (game: Game, event_type: string, runId: string) =>
    core.append(
      [{ type: "custom", event_type, payload: { runId, project: game, goal: "a dirt track" } }],
      threads[game],
    );
  await record("valley", "run_started", "run_valley");
  await record("plain", "run_started", "run_plain");
  await record("valley", "run_started", "run_done");
  await record("valley", "run_finished", "run_done");
  await record("valley", "run_started", "run_quiet");
  for (const runId of ["run_valley", "run_plain", "run_done", "run_ghost"])
    core.host.options.onNotify?.("run.keepawake", { runId });
  const customs = async (type: string) =>
    (await core.listAllEvents()).flatMap((event) =>
      event.data.type === "custom" && event.data.event_type === type
        ? [event.data.payload as { args?: { text?: string }; state?: string }]
        : [],
    );
  const call = async (row: Row): Promise<Outcome> => {
    pending = row;
    const { label, game, director } = row;
    const threadId = threads[game];
    const named = row.chat === "other" ? otherChat : threadId;
    const project = director?.project ?? game;
    const grant = director && { runId: director.runId, threadId, project, root: dirs[game], setup: null, tools: [] };
    const delegate = core.api()["engine.delegate"] as (params: unknown) => Promise<unknown>;
    await delegate({
      engine: ENGINE,
      prompt: "step",
      project: game,
      ...(row.chat === "none" ? {} : { threadId: named }),
      ...(grant ? { director: grant, chatTurn: { messageId: grant.runId } } : {}),
    });
    const asked = (await customs("plugin_consent")).some((c) => c.state === "pending" && c.args?.text === label);
    const called = (await customs("connector_tool_started")).some((c) => c.args?.text === label);
    return { answer, asked, called };
  };
  const close = async () => {
    core.plugins.cancel();
    await core.mcp.close();
    await lite.close();
  };
  return { core, threads, call, close };
}

/** Every session that must still ask: each lifts exactly one condition of the live builder's call. */
const STILL_ASKS: Row[] = [
  { label: "another game's run", game: "valley", connector: ENGINE_CONNECTOR, director: { runId: "run_plain" } },
  { label: "a finished run", game: "valley", connector: ENGINE_CONNECTOR, director: { runId: "run_done" } },
  {
    label: "a run the harness no longer holds",
    game: "valley",
    connector: ENGINE_CONNECTOR,
    director: { runId: "run_quiet" },
  },
  { label: "a run nobody started", game: "valley", connector: ENGINE_CONNECTOR, director: { runId: "run_ghost" } },
  { label: "another connector", game: "valley", connector: OTHER_CONNECTOR, director: { runId: "run_valley" } },
  {
    label: "another engine plugin's connector",
    game: "valley",
    connector: RIVAL_CONNECTOR,
    director: { runId: "run_valley" },
  },
  { label: "a web game", game: "plain", connector: ENGINE_CONNECTOR, director: { runId: "run_plain" } },
  {
    label: "a grant naming another game",
    game: "valley",
    connector: ENGINE_CONNECTOR,
    director: { runId: "run_valley", project: "plain" },
  },
  { label: "the chat's own session", game: "valley", connector: ENGINE_CONNECTOR },
];

describe("the run's own consent for the game's engine connector", () => {
  let world: Awaited<ReturnType<typeof consentWorld>> | undefined;
  after(async () => world?.close());

  it("covers the live builder of an active run of this game: no card, and the call goes out", async () => {
    world ??= await consentWorld();
    const live: Row = {
      label: "live builder",
      game: "valley",
      connector: ENGINE_CONNECTOR,
      director: { runId: "run_valley" },
    };
    assert.deepEqual(await world.call(live), { answer: "live builder", asked: false, called: true });
  });

  it("covers nothing else: each of these still asks, and nothing is called", async () => {
    world ??= await consentWorld();
    const seen: Array<{ label: string; asked: boolean; called: boolean; refused: boolean }> = [];
    for (const row of STILL_ASKS) {
      const { answer, asked, called } = await world.call(row);
      seen.push({ label: row.label, asked, called, refused: answer.startsWith("refused:") });
    }
    assert.deepEqual(
      seen,
      STILL_ASKS.map(({ label }) => ({ label, asked: true, called: false, refused: true })),
    );
  });

  it("never lifts Plan mode: the live builder's call is refused with no card and no call", async () => {
    world ??= await consentWorld();
    await world.core.setPermissionMode(world.threads.valley, PermissionMode.Plan);
    const planning: Row = {
      label: "while planning",
      game: "valley",
      connector: ENGINE_CONNECTOR,
      director: { runId: "run_valley" },
    };
    const outcome = await world.call(planning);
    await world.core.setPermissionMode(world.threads.valley, PermissionMode.Manual);
    assert.equal(outcome.asked, false, "no card: Plan answers it");
    assert.equal(outcome.called, false);
    assert.match(outcome.answer, /refused: .*Plan mode/);
  });

  it("never covers a delegation that names no chat or another chat of the game while the run's chat plans: nothing is called", async () => {
    world ??= await consentWorld();
    await world.core.setPermissionMode(world.threads.valley, PermissionMode.Plan);
    const rows: Row[] = [
      {
        label: "no chat named",
        game: "valley",
        connector: ENGINE_CONNECTOR,
        director: { runId: "run_valley" },
        chat: "none",
      },
      {
        label: "another chat of the game",
        game: "valley",
        connector: ENGINE_CONNECTOR,
        director: { runId: "run_valley" },
        chat: "other",
      },
    ];
    const seen: Array<{ label: string; called: boolean; covered: boolean }> = [];
    for (const row of rows) {
      const { answer, called } = await world.call(row);
      seen.push({ label: row.label, called, covered: answer === row.label });
    }
    await world.core.setPermissionMode(world.threads.valley, PermissionMode.Manual);
    assert.deepEqual(
      seen,
      rows.map(({ label }) => ({ label, called: false, covered: false })),
    );
  });
});
