/**
 * A run's sub-agent (`engine.delegate` with `attribution` and `toolAllow`): a session in a copy of
 * the game that does one small job with a few plugin tools. It is offered only the plugin tools and
 * connectors its allowlist names (by name or name prefix); a call to anything else is refused with
 * nothing run, asked or recorded; and every plugin call it makes, and every file it delivers, is
 * recorded under its run and its own part, so its asset cards land on its node in the Builds graph.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import type { McpLiveTool } from "../../src/shared/mcp.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const PROJECT = "kit-bash";
const RUN = "run_sub";
const AGENT = "agent-2";
const DELIVERED = "assets/agents/2/rail.glb";
/** What each stand-in Genex job is quoted. */
const JOB_CREDITS = 40;

/** Connectors a session in this game could see: the engine's editor and a hosted Blender. */
const CONNECTOR_TOOLS: McpLiveTool[] = ["unreal-editor__call_tool", "genex-blender__run_code"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  inputSchema: { type: "object", properties: {} },
}));

/** What one fixture session saw and what its calls did. */
interface Session {
  offered: string[];
  prompt: string;
  answers: Array<{ name: string; ok: boolean; message: string }>;
}

let lite: CoreLite;
let threadId: string;
let worktree: string;
const sessions: Session[] = [];
/** The calls that reached a plugin backend or a connector, by name. */
const reached: string[] = [];
/** The names the next fixture session calls. */
let toCall: string[] = [];

before(async () => {
  lite = await coreLite();
  const { core } = lite;
  for (const id of ["blender", "genex", "unreal"]) await core.plugins.setEnabled(id, true);
  await core.games.scaffold(PROJECT);
  threadId = await core.createGameThread(PROJECT);
  worktree = path.join(core.layout.scratch, "autopilot", RUN, AGENT);
  await mkdir(worktree, { recursive: true });
  // No account, no Unreal and no Blender on a test machine: the backends and connectors are stood in
  // for, so the test sees exactly which calls would have reached them.
  core.mcp.toolsFor = async () => CONNECTOR_TOOLS;
  core.mcp.owns = (name: string) => CONNECTOR_TOOLS.some((tool) => tool.name === name);
  core.mcp.tool = (async (name: string) => {
    reached.push(name);
    return "connector answered";
  }) as typeof core.mcp.tool;
  let jobs = 0;
  core.plugins.tool = (async (name: string, _args: Record<string, unknown>, binding: PluginBinding) => {
    reached.push(name);
    // A Genex job as the asset tool answers it once queued: its id and the credits it was quoted.
    if (name === "genex__asset") return { id: `job-${++jobs}`, status: "queued", creditsQuoted: JOB_CREDITS };
    // A Blender model delivered inside the call, as the plugin's host service records it.
    if (name === "blender__model") {
      await mkdir(path.join(binding.directory, "assets", "agents", "2"), { recursive: true });
      await writeFile(path.join(binding.directory, DELIVERED), "glTF");
      await core.pluginServices.onDelivered?.("blender", { jobId: "job-1", files: [DELIVERED] }, binding);
    }
    return { ok: true };
  }) as typeof core.plugins.tool;
  core.engines.register({
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      const session: Session = {
        offered: (request.liveTools ?? []).map((t) => t.name),
        prompt: request.prompt,
        answers: [],
      };
      for (const name of toCall) {
        try {
          await request.onLiveTool?.(name, {});
          session.answers.push({ name, ok: true, message: "" });
        } catch (err) {
          session.answers.push({ name, ok: false, message: (err as Error).message });
        }
      }
      sessions.push(session);
      return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
});

after(() => lite.close());

/** One sub-agent session in its worktree, calling `names`. */
async function subAgent(names: string[], extra: Record<string, unknown> = {}): Promise<Session> {
  toCall = names;
  reached.length = 0;
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  await api["engine.delegate"]?.({
    engine: "claude-code",
    project: PROJECT,
    threadId,
    cwd: worktree,
    prompt: "Model a rail kit",
    timeoutMs: 60_000,
    attribution: { runId: RUN, agentId: AGENT },
    toolAllow: ["blender__"],
    ...extra,
  });
  const session = sessions.at(-1);
  assert.ok(session, "the fixture engine ran");
  return session;
}

/** The custom records the game's chat holds of `type`, newest last. */
async function records(type: string): Promise<Array<Record<string, unknown>>> {
  const events: EventEnvelope[] = await lite.core.store.listEvents(threadId);
  return events.flatMap((e) =>
    e.data.type === "custom" && e.data.event_type === type ? [e.data.payload as Record<string, unknown>] : [],
  );
}

describe("a sub-agent's tool allowlist", () => {
  it("offers only the plugin tools and connectors it names", async () => {
    const session = await subAgent([], { toolAllow: ["blender__", "genex__asset"] });
    const plugins = lite.core.plugins.list().map((p) => p.manifest);
    const blender = plugins.find((m) => m.id === "blender")?.tools.map((t) => `blender__${t.name}`) ?? [];
    assert.ok(blender.length > 0);
    for (const name of [...blender, "genex__asset"]) assert.ok(session.offered.includes(name), `offers ${name}`);
    for (const name of session.offered) {
      const named = name.startsWith("blender__") || name.startsWith("genex__asset");
      // A plugin it may use keeps its skill reader: reading how to use a plugin is never an action.
      assert.ok(named || name === "genex__skill", `${name} is offered only when the allowlist names it`);
    }
    for (const name of [
      "unreal-editor__call_tool",
      "genex-blender__run_code",
      "genex__publish",
      "genex__cli",
      "genex__cli-paid",
      "genex__package",
      "unreal__check-part",
      "set_game_cover",
    ])
      assert.ok(!session.offered.includes(name), `never offers ${name}`);
  });

  it("keeps the brief to the plugins it may use", async () => {
    const session = await subAgent([], { toolAllow: ["blender__"] });
    assert.doesNotMatch(session.prompt, /genex__/, "no Genex guidance for a Blender-only agent");
    assert.doesNotMatch(session.prompt, /unreal-editor__|unreal__/, "no Unreal guidance either");
  });

  it("refuses a call to anything it does not name, and nothing is run, asked or recorded", async () => {
    const hostile = [
      "unreal-editor__call_tool",
      "unreal-editor__list_toolsets",
      "genex-blender__run_code",
      "genex__publish",
      "genex__publish-status",
      "genex__cli",
      "genex__cli-paid",
      "genex__package",
      "genex__asset",
      "unreal__save-all",
      "unreal__check-part",
      "unreal__new-game",
      "set_game_cover",
      "BLENDER__model",
      " blender__model",
      "blender_model",
      "__blender__model",
    ];
    const before = {
      started: (await records(CustomEvent.PluginToolStarted)).length,
      connector: (await records(CustomEvent.ConnectorToolStarted)).length,
      consent: (await records(CustomEvent.PluginConsent)).length,
    };
    const session = await subAgent(hostile);
    assert.deepEqual(
      session.answers.map((a) => `${a.name}: ${a.ok ? "ran" : a.message}`),
      hostile.map((name) => `${name}: Unknown tool: ${name}`),
    );
    assert.deepEqual(reached, [], "no backend or connector was reached");
    assert.equal((await records(CustomEvent.PluginToolStarted)).length, before.started);
    assert.equal((await records(CustomEvent.ConnectorToolStarted)).length, before.connector);
    assert.equal((await records(CustomEvent.PluginConsent)).length, before.consent);
  });

  it("refuses everything when the allowlist is not a list of names", async () => {
    for (const toolAllow of ["blender__", { blender: true }, null, 7]) {
      const session = await subAgent(["blender__model"], { toolAllow });
      assert.deepEqual(
        session.offered.filter((name) => name.includes("__")),
        [],
        `${JSON.stringify(toolAllow)} offers no plugin tool`,
      );
      assert.equal(session.answers[0]?.ok, false, `${JSON.stringify(toolAllow)} runs nothing`);
    }
    assert.deepEqual(reached, []);
  });

  it("an empty name allows nothing, never everything", async () => {
    const session = await subAgent(["genex__asset"], { toolAllow: ["", "blender__"] });
    assert.ok(!session.offered.includes("genex__asset"));
    assert.equal(session.answers[0]?.ok, false);
  });
});

describe("a sub-agent's attribution", () => {
  it("records each plugin call it makes under its run and its own part, as a builder's", async () => {
    const session = await subAgent(["blender__status", "blender__model"]);
    assert.deepEqual(
      session.answers.map((a) => a.ok),
      [true, true],
    );
    const started = (await records(CustomEvent.PluginToolStarted)).slice(-2);
    assert.deepEqual(
      started.map((s) => [s.toolName, s.runId, s.facetId, s.role]),
      [
        ["blender__status", RUN, AGENT, "builder"],
        ["blender__model", RUN, AGENT, "builder"],
      ],
    );
    const finished = (await records(CustomEvent.PluginTool)).slice(-2);
    assert.deepEqual(
      finished.map((f) => [f.runId, f.facetId]),
      [
        [RUN, AGENT],
        [RUN, AGENT],
      ],
    );
  });

  it("records a file it delivers under its run and its own part", async () => {
    await subAgent(["blender__model"]);
    const delivered = (await records(CustomEvent.AssetDelivered)).at(-1);
    assert.equal(delivered?.runId, RUN);
    assert.equal(delivered?.facetId, AGENT);
    assert.equal(delivered?.workspace, "build");
  });

  it("is a builder's session, never the chat's reply", async () => {
    await subAgent([]);
    const activity = (await records(CustomEvent.SessionActivity)).at(-1);
    assert.equal(activity?.role, "builder");
    assert.equal(activity?.runId, RUN);
    assert.equal(activity?.facetId, AGENT);
  });
});

describe("a run's Genex credit cap", () => {
  const paid = (runId: string, agentId: string, creditCap: unknown) => ({
    toolAllow: ["genex__asset"],
    attribution: { runId, agentId },
    creditCap,
  });

  it("refuses the run's next paid job, with no Genex call, once its jobs have committed the cap", async () => {
    const calls = ["genex__asset", "genex__asset", "genex__asset", "genex__asset"];
    const first = await subAgent(calls, paid("run_cap", "agent-1", 100));
    assert.deepEqual(
      first.answers.map((a) => a.ok),
      [true, true, true, false],
      "40 + 40 + 40 crosses 100",
    );
    assert.match(first.answers[3]?.message ?? "", /120 of its 100 Genex credits/);
    assert.equal(reached.filter((name) => name === "genex__asset").length, 3, "the fourth never reached Genex");
  });

  it("counts every session of the run against its cap, and no other run's", async () => {
    await subAgent(["genex__asset", "genex__asset", "genex__asset"], paid("run_shared", "agent-1", 100));
    const next = await subAgent(["genex__asset"], paid("run_shared", "agent-2", 100));
    assert.equal(next.answers[0]?.ok, false, "the run's next sub-agent finds the cap spent");
    assert.deepEqual(reached, []);
    const other = await subAgent(["genex__asset"], paid("run_elsewhere", "agent-1", 100));
    assert.equal(other.answers[0]?.ok, true);
  });

  it("refuses every paid job when the cap it was sent is not a whole number of credits", async () => {
    for (const cap of ["lots", -5, 1.5, Number.NaN]) {
      const session = await subAgent(["genex__asset"], paid(`run_bad_${String(cap)}`, "agent-1", cap));
      assert.equal(session.answers[0]?.ok, false, String(cap));
      assert.deepEqual(reached, [], String(cap));
    }
  });
});
