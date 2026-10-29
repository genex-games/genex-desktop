/**
 * When a tool changes what a project is: guarded, snapshotted and recorded, and the same session
 * goes on with the tools for it. A plugin tool that declares `makes` is refused while a run of the
 * game is going; otherwise Genex snapshots the game first, records what the call replaced as
 * `portedFrom` (the web files stay as the reference, not as a kind), and tells the session to end
 * its reply. The chat's turn whose served facts changed then goes on by itself in the same session,
 * with a brief and tools for the new kind.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { factsReadyPrompt } from "../../src/harness-seed/loop/project-prompts.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { gitFile } from "../helpers/git.ts";
import { personAllowsLocalTools } from "../helpers/plugins.ts";

const PLUGIN = "porter";
const KIND = "garden-project";
const MADE = "Garden.gardenproj";
/** The tool that makes the kind and answers in words, one that answers with an object, and one that makes nothing. */
const MAKE = `${PLUGIN}__make-garden`;
const MAKE_RECORD = `${PLUGIN}__make-garden-record`;
const MAKE_NOTHING = `${PLUGIN}__make-nothing`;
/** What the tool that makes nothing answers. */
const NOTHING_ANSWER = "The garden needs a name first.";

/**
 * A local plugin whose tools make a garden project in the bound game's folder: its `detect` knows
 * the file, its two tools declare `makes`, and its backend notes each call in `calls`.
 */
async function porterPackage(calls: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-porter-plugin-"));
  const maker = (name: string) => ({
    name,
    description: "Make this game a garden project.",
    parameters: { type: "object", properties: {} },
    makes: [KIND],
  });
  const manifest = {
    apiVersion: 3,
    id: PLUGIN,
    version: "1.0.0",
    name: "Porter",
    publisher: "Genex tests",
    description: "Makes garden projects.",
    backend: "backend.mjs",
    capabilities: [],
    detect: [{ fact: KIND, files: ["**/*.gardenproj"] }],
    tools: [maker("make-garden"), maker("make-garden-record"), maker("make-nothing")],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      await appendFile(${JSON.stringify(calls)}, name + "\\n");
      if (name === "make-nothing") return ${JSON.stringify(NOTHING_ANSWER)};
      await writeFile(path.join(ctx.directory, ${JSON.stringify(MADE)}), "{}\\n");
      return name === "make-garden" ? "Made the garden project." : { made: true };
    },
  };
}\n`,
  );
  return dir;
}

/** A core with the porter plugin installed and turned on by the person, and where its calls are noted. */
async function porterCore(): Promise<{
  lite: CoreLite;
  calls: string;
  invoke: (project: string, name?: string) => Promise<unknown>;
  changed: string[];
}> {
  const changed: string[] = [];
  const lite = await coreLite({
    onUiEvent: (event) => {
      if (event.type === UiEvent.GameChanged) changed.push((event.payload as { project: string }).project);
    },
  });
  const calls = path.join(await mkdtemp(path.join(os.tmpdir(), "studio-porter-calls-")), "calls.log");
  await lite.core.plugins.installLocal(await porterPackage(calls), PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(PLUGIN, true);
  // The person allows its tools: these cases are about the kind change, not the card.
  personAllowsLocalTools(lite.core.plugins);
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const invoke = async (project: string, name = MAKE) => {
    const threadId = await lite.core.createGameThread(project);
    return api["plugins.invoke"]!({ project, threadId, name, args: {} });
  };
  return { lite, calls, invoke, changed };
}

/** Close a porter core: a core-lite never started leaves its plugin backend to the test. */
async function closeCore(lite: CoreLite): Promise<void> {
  lite.core.plugins.cancel();
  await lite.close();
}

/** The backend's noted calls, by tool name. */
const callsIn = (file: string) =>
  readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [] as string[],
  );

/** The game snapshots the log holds, oldest first. */
async function gameSnapshots(lite: CoreLite) {
  return (await lite.core.listAllEvents()).flatMap((event) =>
    event.data.type === EventKind.SnapshotCreated && event.data.git.game ? [event.data.git.game] : [],
  );
}

/** A game's studio.json `portedFrom`, by id and path; none recorded is an empty list. */
async function portedFrom(lite: CoreLite, project: string) {
  const meta = JSON.parse(await readFile(path.join(lite.core.games.dirFor(project), "studio.json"), "utf8"));
  return ((meta.portedFrom ?? []) as Array<{ id: string; path: string }>).map(({ id, path: where }) => ({
    id,
    path: where,
  }));
}

/** A game's listed facts, by id and path. */
async function listedFacts(lite: CoreLite, project: string) {
  return (await lite.core.games.factsOf(project)).map(({ id, path: where }) => ({ id, path: where }));
}

const WEB_AT_ROOT = { id: "web-game", path: "." };

describe("a tool that makes a kind of project", () => {
  it("a tool that makes a kind is refused while the game's run is going, and nothing runs", async () => {
    const { lite, calls, invoke } = await porterCore();
    try {
      const project = "busy";
      await lite.core.games.scaffold(project);
      lite.core.pluginServices.runningGames = async () => [
        { project, directory: lite.core.games.dirFor(project), title: project },
      ];
      const answer = (await invoke(project)) as { refused?: string; message?: string };
      assert.equal(answer.refused, "run_going");
      assert.match(String(answer.message), /run/);
      assert.deepEqual(await callsIn(calls), [], "the backend never ran");
      assert.deepEqual(await gameSnapshots(lite), [], "no snapshot");
      assert.deepEqual(await portedFrom(lite, project), []);
    } finally {
      await closeCore(lite);
    }
  });

  it("it takes a snapshot first and records what it replaced", async () => {
    const { lite, calls, invoke } = await porterCore();
    try {
      const project = "pond";
      await lite.core.games.scaffold(project);
      const dir = lite.core.games.dirFor(project);
      const page = await readFile(path.join(dir, "index.html"), "utf8");
      await invoke(project);
      assert.deepEqual(await callsIn(calls), ["make-garden"]);
      const snapshots = await gameSnapshots(lite);
      assert.equal(snapshots.length, 1, "one game snapshot");
      const inSnapshot = await gitFile(["cat-file", "-e", `${snapshots[0]}:${MADE}`], { cwd: dir }).then(
        () => true,
        () => false,
      );
      assert.equal(inSnapshot, false, "taken before the tool wrote its project");
      assert.deepEqual(await portedFrom(lite, project), [WEB_AT_ROOT]);
      assert.deepEqual(await listedFacts(lite, project), [{ id: KIND, path: "." }], "only the new kind is listed");
      assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), page, "the web files stay as they were");
    } finally {
      await closeCore(lite);
    }
  });

  it("a port replaces only the web game it takes the place of: Blender files and sub-projects keep counting", async () => {
    const { lite, invoke } = await porterCore();
    try {
      const project = "orchard";
      await lite.core.games.scaffold(project);
      const dir = lite.core.games.dirFor(project);
      await mkdir(path.join(dir, "art"), { recursive: true });
      await writeFile(path.join(dir, "art", "tree.blend"), "BLENDER");
      await mkdir(path.join(dir, "tools", "level"), { recursive: true });
      await writeFile(path.join(dir, "tools", "level", "project.godot"), "config_version=5\n");
      await invoke(project);
      assert.deepEqual(await portedFrom(lite, project), [WEB_AT_ROOT], "only the web game is the reference");
      assert.deepEqual(await listedFacts(lite, project), [
        { id: KIND, path: "." },
        { id: "blender-assets", path: "art" },
        { id: "godot-project", path: "tools/level" },
      ]);
    } finally {
      await closeCore(lite);
    }
  });

  it("a port never writes through a studio.json link to a file outside the game", async () => {
    const { lite, invoke } = await porterCore();
    try {
      const project = "linked-record";
      await lite.core.games.scaffold(project);
      const dir = lite.core.games.dirFor(project);
      const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "studio-port-victim-")), "victim.json");
      const victim = `${JSON.stringify({ keep: true })}\n`;
      await writeFile(outside, victim);
      await rm(path.join(dir, "studio.json"));
      await symlink(outside, path.join(dir, "studio.json"));
      await invoke(project).catch(() => null);
      assert.equal(await readFile(outside, "utf8"), victim, "the outside file is byte-identical");
    } finally {
      await closeCore(lite);
    }
  });

  it("on an untouched starter the starter becomes the reference", async () => {
    const { lite, invoke } = await porterCore();
    try {
      await lite.core.games.scaffold("starter");
      await lite.core.games.rememberScaffold("starter");
      assert.deepEqual(await listedFacts(lite, "starter"), [], "an untouched starter has no kind yet");
      await invoke("starter");
      assert.deepEqual(await portedFrom(lite, "starter"), [WEB_AT_ROOT]);
      assert.deepEqual(await listedFacts(lite, "starter"), [{ id: KIND, path: "." }]);

      await lite.core.games.makeEmpty("bare");
      await invoke("bare");
      assert.deepEqual(await portedFrom(lite, "bare"), [], "an empty game replaced nothing");
      assert.deepEqual(await listedFacts(lite, "bare"), [{ id: KIND, path: "." }]);
    } finally {
      await closeCore(lite);
    }
  });

  it("a call that made none of its kinds answers as it did, records nothing and tells the app nothing", async () => {
    const { lite, calls, invoke, changed } = await porterCore();
    try {
      await lite.core.games.scaffold("unnamed");
      changed.length = 0;
      assert.equal(await invoke("unnamed", MAKE_NOTHING), NOTHING_ANSWER, "exactly the backend's answer");
      assert.deepEqual(await callsIn(calls), ["make-nothing"]);
      assert.deepEqual(await portedFrom(lite, "unnamed"), [], "no portedFrom");
      assert.deepEqual(await listedFacts(lite, "unnamed"), [WEB_AT_ROOT], "still a web game");
      assert.deepEqual(changed, [], "no GameChanged");
    } finally {
      await closeCore(lite);
    }
  });

  it("a port, start_web_game and game.start each tell the app once that the game changed", async (t) => {
    const { lite, invoke, changed } = await porterCore();
    t.after(async () => {
      await lite.core.mcp.close().catch(() => {});
      await closeCore(lite);
    });
    await lite.core.games.scaffold("ported");
    changed.length = 0;
    await invoke("ported");
    assert.deepEqual(changed, ["ported"], "a port");

    const started = await lite.core.createGame("Started Here");
    changed.length = 0;
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.GameStart]!({ project: started.name, starter: ProjectStarter.Web });
    assert.deepEqual(changed, [started.name], "game.start");

    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        await request.onLiveTool?.(ProjectTool.StartWebGame, {});
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const live = await lite.core.createGame("Started Live");
    const threadId = await lite.core.threadForGame(live.name);
    changed.length = 0;
    await api["engine.delegate"]!({ engine: "claude-code", project: live.name, threadId, prompt: "a kite game" });
    assert.deepEqual(
      changed.filter((project) => project === live.name),
      [live.name],
      "start_web_game",
    );
    assert.deepEqual(await listedFacts(lite, live.name), [WEB_AT_ROOT], "the starter was written");

    // A session that gives a game with no kind its kind by writing files itself: its end tells the app.
    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        await writeFile(path.join(String(request.cwd), "index.html"), "<!doctype html><title>kite</title>\n");
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const written = await lite.core.createGame("Written Here");
    const writtenThread = await lite.core.threadForGame(written.name);
    changed.length = 0;
    await api["engine.delegate"]!({
      engine: "claude-code",
      project: written.name,
      threadId: writtenThread,
      prompt: "a kite",
    });
    assert.deepEqual(await listedFacts(lite, written.name), [WEB_AT_ROOT], "the session wrote a web page");
    assert.deepEqual(
      changed.filter((project) => project === written.name),
      [written.name],
      "files the session wrote",
    );
    // A turn on a game that already had its kind tells the app nothing.
    changed.length = 0;
    await api["engine.delegate"]!({
      engine: "claude-code",
      project: written.name,
      threadId: writtenThread,
      prompt: "more",
    });
    assert.deepEqual(
      changed.filter((project) => project === written.name),
      [],
      "a game with a kind",
    );
  });

  it("its answer tells the session to end its reply", async () => {
    const { lite, invoke } = await porterCore();
    try {
      await lite.core.games.scaffold("words");
      const said = String(await invoke("words"));
      assert.match(said, /^Made the garden project\./, "the tool's own answer comes first");
      assert.match(said, /garden-project/);
      assert.match(said, /End your reply now/);

      await lite.core.games.scaffold("record");
      const answer = (await invoke("record", MAKE_RECORD)) as { made?: boolean; genex?: string };
      assert.equal(answer.made, true, "the tool's own answer stays");
      assert.match(String(answer.genex), /End your reply now/);
    } finally {
      await closeCore(lite);
    }
  });
});

const CLAUDE = "claude-code";
const NAME = "pond";
const TURN = { threadId: "thread-1", turnId: "turn-1", text: "port it", engine: CLAUDE, engineLabel: "Claude Code" };
const GODOT = [{ id: "godot-project", path: ".", source: "core" }];
const WEB = [{ id: "web-game", path: ".", source: "core" }];

/** A descriptor as `game.list` answers it, with `facts` (and, with none, what the folder `holds`). */
const game = (facts: unknown[], holds?: string) => ({
  name: NAME,
  title: NAME,
  dir: `/games/${NAME}`,
  shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
  built: false,
  facts,
  ...(holds ? { holds } : {}),
});

/**
 * One chat turn whose game lists `before` until the builder ran and `after` once it has. The
 * second leg's resume fails (the session is gone) when `resumeFails`, so the fresh brief is sent.
 */
async function turnOn(options: {
  before: unknown[];
  after: unknown[];
  afterHolds?: string;
  turn?: Record<string, unknown>;
  answer?: Record<string, unknown>;
  resumeFails?: boolean;
}) {
  let built = false;
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [built ? game(options.after, options.afterHolds) : game(options.before)],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": (p) => {
        const first = !built;
        built = true;
        if (!first && p.resume && options.resumeFails) throw new Error("session not found");
        return {
          ok: true,
          engine: CLAUDE,
          turns: 1,
          usage: {},
          sessionId: first ? "s1" : String(p.resume ?? "s2"),
          summary: first ? "Ported it." : "Built the first scene.",
          ...(first ? options.answer : {}),
        };
      },
    },
  });
  await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, ...options.turn } as never);
  return recorder.paramsOf("engine.delegate");
}

describe("the end of a turn that changed what the project is", () => {
  it("a turn whose project changed kind goes on in the same session with a brief for the new kind", async () => {
    const delegated = await turnOn({ before: WEB, after: GODOT });
    assert.equal(delegated.length, 2, "one build, then one continuation");
    assert.deepEqual(
      [delegated[1]?.resume, delegated[1]?.prompt],
      ["s1", factsReadyPrompt([{ id: "godot-project", path: "." }])],
    );
    assert.equal(Boolean(delegated[1]?.selfCapture), false, "no web capture for a Godot project");

    const fresh = await turnOn({ before: WEB, after: GODOT, resumeFails: true });
    assert.equal(fresh.length, 3, "the resume failed, so a fresh session was started");
    const brief = String(fresh[2]?.prompt);
    assert.equal(fresh[2]?.resume ?? null, null);
    assert.ok(brief.includes(factsReadyPrompt([{ id: "godot-project", path: "." }])), "the fresh brief goes on");
    assert.ok(!brief.includes("window.__studio"), "the fresh brief is for the new kind, not the web game");

    const rows: Record<string, Parameters<typeof turnOn>[0]> = {
      "a game with no kind that took the web starter": { before: [], after: WEB },
      "a game with no kind whose turn wrote files no rule knows": { before: [], after: [], afterHolds: "own-files" },
      "unchanged facts": { before: WEB, after: WEB },
      "a run's turn": { before: WEB, after: GODOT, turn: { runId: "run-1" } },
      "a stopped turn": { before: WEB, after: GODOT, answer: { stopReason: "stopped" } },
      "a failed turn": { before: WEB, after: GODOT, answer: { ok: false, errorText: "it broke" } },
    };
    for (const [label, row] of Object.entries(rows)) assert.equal((await turnOn(row)).length, 1, label);
  });

  it("a switch sent while the session goes on with the new kind still switches it: the Loop turned on reaches it", async () => {
    const log: Array<{ id: string; data: Record<string, unknown> }> = [];
    let legs = 0;
    let cut = () => {};
    let going = () => {};
    const continuing = new Promise<void>((resolve) => {
      going = resolve;
    });
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.append": (p) => {
          for (const data of p.batch as Array<Record<string, unknown>>)
            log.push({ id: String(log.length + 1).padStart(6, "0"), data });
          return null;
        },
        "events.list": () => log,
        "events.messages": () => [{ role: "user", content: TURN.text }],
        "game.contentStamp": () => ({ all: "a", source: "a" }),
        "game.list": () => [legs > 0 ? game(GODOT) : game(WEB)],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
        "engine.describe": () => [{ id: CLAUDE, label: "Claude Code", kind: "delegated" }],
        "preview.ready": () => ({ ready: false }),
        "engine.steer": (p) => {
          cut();
          return { how: "interrupt", accepted: (p.messages as Array<{ id: string }>).map((m) => m.id) };
        },
        "engine.delegate": async () => {
          legs += 1;
          const reply = { ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s1", summary: "Done." };
          if (legs !== 2) return reply;
          // The session going on with the new kind works until the person's message cuts it.
          const cutNow = new Promise<void>((resolve) => {
            cut = resolve;
          });
          going();
          await cutNow;
          return { ...reply, ok: false, stopReason: "stopped", turns: 2, summary: "" };
        },
      },
    });
    const host = { call: (method: string, p: Record<string, unknown>) => recorder.ctx.call(method, p), notify() {} };
    const queue = new MessageQueue(host as never, (action, steer) =>
      runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, asked: action, steer } as never),
    );
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      queue.enqueue({ type: "user_message", threadId: TURN.threadId, text, engine: CLAUDE, ...extra });
    try {
      await send("port it");
      await continuing;
      await send("make it in the loop", { autopilot: {} });
      for (let n = 0; n < 2000 && legs < 3; n++) await new Promise((resolve) => setImmediate(resolve));
      const delegated = recorder.paramsOf("engine.delegate");
      assert.equal(delegated.length, 3, "the session went on after the cut");
      const prompt = String(delegated[2]?.prompt);
      assert.ok(prompt.startsWith("While you were working, the user changed how you work"), prompt);
      assert.match(prompt, /make it in the loop/);
      const loopMessage = [...messageQueueState(log as never).messages.values()].find(
        (m) => m.action?.text === "make it in the loop",
      );
      assert.equal(loopMessage?.state, "delivered");
    } finally {
      cut();
      queue.stop();
    }
  });

  it("with Loop on, the session that goes on starts the build with its launch tool instead of building it itself", async () => {
    const delegated = await turnOn({ before: WEB, after: GODOT, turn: { autopilot: { roles: {} } } });
    assert.equal(delegated.length, 2, "one turn, then one continuation");
    const prompt = String(delegated[1]?.prompt);
    assert.equal(prompt, factsReadyPrompt([{ id: "godot-project", path: "." }], "mcp__studio__start_autopilot"));
    assert.ok(prompt.includes("mcp__studio__start_autopilot"), "it names the launch tool as this engine calls it");
    assert.ok(!prompt.includes("Go on with what you said you would build first"), "it is not told to build itself");
  });
});
