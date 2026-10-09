/**
 * The turn loop and full self-modification.
 *
 * Three properties are asserted here because everything else leans on them:
 *  1. the prompt is materialised from the event log every round (no hidden conversation state);
 *  2. the tool registry is rebuilt every round, so a tool the studio writes mid-turn is callable
 *     on the next one — "the studio installs a new tool mid-run and uses it" (M4);
 *  3. an engine that throttles is survived by falling back to a local engine (M2).
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EngineError, type Engine } from "../../src/substrate/engines/types.ts";
import { nameFromAsk, runTurn } from "../../src/harness-seed/loop/turn-loop.ts";
import { loadSkills } from "../../src/harness-seed/loop/skills.ts";
import { SecretStore, plaintextBackend } from "../../src/substrate/secrets.ts";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import type { FakeReply } from "../helpers/fake-ollama.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import { EventKind, MessageUsageSource } from "../../src/shared/event-log.ts";
import { repeatedBuildUsages } from "../../src/shared/eval-lane.ts";

/** The seed the rig's harness workspace is copied from, skills included. */
const SEED = path.resolve("src/harness-seed");
/** The line every vendored Genex card body carries after its preface (`scripts/refresh-genex-skills.ts`). */
const VENDORED_CARD_MARKER = "<!-- upstream ";

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

async function turnRig(replies: FakeReply[]): Promise<Rig> {
  const rig = await startRig({
    replies: [...replies, ...Array.from({ length: 6 }, () => ({ text: "ok" }) as FakeReply)],
  });
  rigs.push(rig);
  return rig;
}

describe("turn loop", () => {
  it("materialises the prompt from the event log, including tool results", async () => {
    const rig = await turnRig([
      { toolCalls: [{ id: "c1", name: "list_games", arguments: {} }], text: "Checking." },
      { text: "There are no games yet." },
    ]);
    await rig.core.sendUserMessage("what games exist?");
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.equal(completions.length, 2);

    // Round 2's prompt is rebuilt from the log: user message, assistant tool call, tool result.
    const second = completions[1]!.body as {
      messages: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const roles = second.messages.map((m) => m.role);
    assert.ok(roles.includes("system"), "identity and rules are injected every round");
    assert.ok(roles.includes("user"));
    assert.ok(second.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls)));
    assert.ok(second.messages.some((m) => m.role === "tool" && m.tool_call_id === "c1"));

    // The system prompt carries skill indexes, never bodies: Studio's own skills by name and
    // description (read with read_skill), a plugin's file skills by summary (read with its
    // `<plugin>__skill` tool).
    const system = String(second.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /## Your skills/);
    // The slugs the seed actually ships. `game-contract` was named here until M4.8a retired it
    // (it was a stale second copy of docs/CONTRACT.md that no run code read).
    assert.match(system, /facet-decomposition/);
    assert.match(system, /\(director\)/);
    for (const skill of await loadSkills(SEED)) {
      assert.ok(
        !system.includes(skill.body.slice(0, 200)),
        `the ${skill.slug} skill's body is fetched on demand, not pasted in`,
      );
    }
    assert.match(system, /\[genex\/genex-threejs-multiplayer\] [^\n]* Read it with genex__skill/);
    assert.ok(
      !system.includes(VENDORED_CARD_MARKER),
      "a plugin's file skill bodies are fetched on demand, not pasted in",
    );

    // Tools are advertised every round.
    assert.ok((second.tools ?? []).some((tool) => tool.function.name === "list_games"));
    assert.ok((second.tools ?? []).some((tool) => tool.function.name === "press_keys"));
    assert.ok((second.tools ?? []).some((tool) => tool.function.name === "screenshot"));
  });

  it("a screenshot puts pixels on the next model round, not a path in the log", async () => {
    const { countImages } = await import("../helpers/fake-ollama.ts");
    const rig = await turnRig([
      { toolCalls: [{ id: "c1", name: "screenshot", arguments: {} }], text: "Looking." },
      { text: "I see the scene." },
    ]);
    await rig.core.sendUserMessage("take a screenshot");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.equal(completions.length, 2);
    const second = completions[1]!.body as { messages: Array<{ role: string; content?: unknown }> };
    assert.ok(countImages(second.messages) >= 1, "the model must receive the JPEG, not a file path");

    const result = events.find((e) => e.data.type === "tool_result")?.data as {
      result: { content: string; details?: { base64?: string } };
    };
    assert.match(result.result.content, /Captured/);
    assert.equal(result.result.details?.base64, undefined, "pixels must not be written into the event log");
    assert.ok(result.result.content.length < 2_000);
  });

  it("holds the system prompt still for a whole turn, so a local model reuses its cached prefix", async () => {
    // A local model re-reads everything after the first changed token. The system prompt used to
    // be re-read every round (memory, notes, the file list, every tool's description), so one
    // fact remembered or one tool installed mid-turn made the next round re-read the whole turn.
    const rig = await turnRig([
      {
        toolCalls: [
          { id: "c1", name: "remember", arguments: { key: "favourite_genre", value: "racing games" } },
          {
            id: "c2",
            name: "install_tool",
            arguments: {
              filename: "lap-tools.mjs",
              reason: "I keep timing laps by hand",
              title: "Time laps for you",
              summary: ["I can now time the current lap myself."],
              contents: `export const tools = [{
                 name: "time_lap",
                 description: "time the current lap",
                 parameters: { type: "object", properties: {} },
                 async execute() { return "41.2 s"; },
               }];`,
            },
          },
        ],
        text: "Noting that and adding a tool.",
      },
      { text: "Done." },
    ]);
    await rig.core.sendUserMessage("remember I like racing games and add a lap timer");
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 45_000, "turn_ended");

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.equal(completions.length, 2);
    const system = (round: number) =>
      String(
        (completions[round]!.body as { messages: Array<{ role: string; content?: unknown }> }).messages.find(
          (m) => m.role === "system",
        )?.content ?? "",
      );
    assert.equal(system(1), system(0), "round 2 starts from the same system prompt as round 1");
    const second = completions[1]!.body as { tools?: Array<{ function: { name: string; description?: string } }> };
    assert.ok(
      (second.tools ?? []).some((tool) => tool.function.name === "time_lap"),
      "the new tool is still offered",
    );
    const described = (second.tools ?? []).find((tool) => tool.function.name === "list_games")?.function.description;
    assert.ok(described && !system(1).includes(described), "a tool's description is sent once, with its schema");

    // The next turn reads them afresh.
    rig.server.pushReply({ text: "Racing it is." });
    await rig.core.sendUserMessage("what do I like?");
    await waitForLog(
      rig.core,
      (log) => log.filter((e) => e.data.type === "turn_ended").length >= 2,
      30_000,
      "second turn_ended",
    );
    const next = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions")).at(-1)!.body as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    assert.match(String(next.messages.find((m) => m.role === "system")?.content ?? ""), /racing games/);
  });

  it("keeps the log as the only state: a restart resumes the same conversation", async () => {
    const rig = await turnRig([{ text: "Noted." }]);
    await rig.core.sendUserMessage("remember that I like fast games");
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    await rig.core.host.restart();
    rig.server.pushReply({ text: "Still here." });
    await rig.core.sendUserMessage("what did I just say?");
    await waitForLog(
      rig.core,
      (log) => log.filter((e) => e.data.type === "turn_ended").length >= 2,
      30_000,
      "second turn_ended",
    );

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    const last = completions.at(-1)!.body as { messages: Array<{ role: string; content?: unknown }> };
    const text = last.messages.map((m) => String(m.content ?? "")).join("\n");
    assert.match(text, /remember that I like fast games/, "the restarted self still sees the whole conversation");
  });

  it("reports a tool failure to the model instead of ending the turn", async () => {
    const rig = await turnRig([
      { toolCalls: [{ id: "c1", name: "read_file", arguments: { project: "nope", file: "missing.js" } }] },
      { text: "That file does not exist." },
    ]);
    await rig.core.sendUserMessage("read a file that is not there");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    const results = events.filter((e) => e.data.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal((results[0]!.data as { result: { ok: boolean } }).result.ok, false);
    const ended = events.find((e) => e.data.type === "turn_ended")!;
    assert.equal((ended.data as { status: string }).status, "ok", "a failed tool is data, not a crash");
  });

  it("stops a runaway turn at the round limit", async () => {
    // Every reply asks for another tool call: without the guard this would never end.
    const rig = await startRig({
      respond: () => ({ toolCalls: [{ id: `c${Math.random()}`, name: "list_games", arguments: {} }] }),
    });
    rigs.push(rig);
    await rig.core.host.dispatch({
      type: "user_message",
      threadId: rig.core.mainThread,
      text: "loop forever",
    });
    const events = await waitForLog(
      rig.core,
      (log) =>
        log.some((e) => e.data.type === "error" && /stopped after/.test((e.data as { message: string }).message)),
      60_000,
      "round limit",
    );
    assert.ok(events.some((e) => e.data.type === "error"));
  });
});

describe("run deadline inside a turn", () => {
  it("an already-expired deadline ends the turn cleanly without another model call", async () => {
    // The gauntlet's wall clock used to stop at the loop head only: a build turn that started
    // near the wire could keep buying tool rounds long past the budget. The deadline now reads
    // between rounds, so the turn ends where the log already holds everything it did.
    const calls: Array<{ method: string; payload: unknown }> = [];
    const ctx = {
      workspace: "/nonexistent",
      cancelled: false,
      call: async (method: string, payload?: unknown) => {
        calls.push({ method, payload });
        if (method === "engine.describe") {
          return [
            { id: "ollama", label: "Ollama", kind: "direct", status: { code: "ready" }, models: [], defaultModel: "m" },
          ];
        }
        if (method === "turn.append") return {};
        throw new Error(`unexpected substrate call: ${method}`);
      },
      notify: () => {},
      setStatus: () => {},
    };

    const outcome = await runTurn(ctx as never, {
      threadId: "t1",
      turnId: "turn1",
      engine: "ollama",
      deadlineMs: Date.now() - 1,
    });

    assert.equal((outcome as { stopped: string }).stopped, "deadline");
    assert.ok(!calls.some((c) => c.method === "engine.complete"), "an expired clock must not buy another completion");
    const note = calls.find((c) => c.method === "turn.append");
    assert.match(JSON.stringify(note?.payload ?? {}), /wall clock/, "the stop leaves a note in the thread");
  });
});

describe("full self-modification (M4)", () => {
  it("installs a tool mid-turn and calls it on the next round", async () => {
    const rig = await turnRig([
      {
        toolCalls: [
          {
            id: "c1",
            name: "install_tool",
            arguments: {
              filename: "ring-tools.mjs",
              reason: "I keep counting rings by hand",
              title: "Count rings for you",
              summary: ["I can now count the rings in a build myself."],
              contents: `export const tools = [{
                 name: "count_rings",
                 description: "count rings in the current build",
                 parameters: { type: "object", properties: {} },
                 async execute() { return "7 rings"; },
               }];`,
            },
          },
        ],
        text: "Installing a tool for this.",
      },
      { toolCalls: [{ id: "c2", name: "count_rings", arguments: {} }] },
      { text: "There are 7 rings." },
    ]);

    await rig.core.sendUserMessage("count the rings");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      45_000,
      "turn_ended",
    );

    const results = events.filter((e) => e.data.type === "tool_result");
    assert.equal(results.length, 2);
    const second = results[1]!.data as { result: { ok: boolean; content: string } };
    assert.equal(second.result.ok, true);
    assert.equal(second.result.content, "7 rings", "the freshly written tool ran in the same turn");

    // The change is on disk, in the log, and snapshotted on both sides of the write.
    const file = await readFile(path.join(rig.core.layout.harnessWs, "tools", "ring-tools.mjs"), "utf8");
    assert.match(file, /count_rings/);
    const installs = customEvents(events, "tool_installed");
    assert.equal(installs.length, 1);
    assert.equal(installs[0]!.reason, "I keep counting rings by hand");
    assert.ok(installs[0]!.snapshot_id, "a snapshot is taken before the studio edits itself");
    assert.ok(installs[0]!.post_snapshot_id, "a snapshot is taken after the write, so a rewind past it is detectable");
    // PH-5, flipped again by the self-edit gate: the tool module was type-checked and booted in a
    // validation fork before it was written, so its after-snapshot holds code that has run and is
    // a rewind target at once (self-edit-gate.test.ts holds code no fork booted to the old rule).
    assert.equal(
      rig.core.snapshotIndex.get(String(installs[0]!.post_snapshot_id))?.healthy,
      true,
      "code a fork booted is a rewind target",
    );
    assert.notEqual(
      installs[0]!.post_snapshot_id,
      installs[0]!.snapshot_id,
      "before and after are distinct checkpoints",
    );

    // Round 3 advertised the new tool to the model.
    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    const round2 = completions[1]!.body as { tools?: Array<{ function: { name: string } }> };
    assert.ok((round2.tools ?? []).some((tool) => tool.function.name === "count_rings"));
  });

  it("survives a broken tool module by reporting it, not by dying", async () => {
    const rig = await turnRig([
      {
        toolCalls: [
          {
            id: "c1",
            name: "install_tool",
            arguments: {
              filename: "broken-tools.mjs",
              reason: "oops",
              title: "Try a new helper",
              summary: ["I tried adding a helper."],
              contents: "this is not valid javascript !!!",
            },
          },
        ],
      },
      { toolCalls: [{ id: "c2", name: "list_games", arguments: {} }] },
      { text: "I broke a tool; the rest still works." },
    ]);
    await rig.core.sendUserMessage("install something broken");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      45_000,
      "turn_ended",
    );
    assert.equal(rig.core.host.state, "ready", "a syntax error in a tool must not kill the harness");

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    const later = completions.at(-1)!.body as { messages: Array<{ role: string; content?: unknown }> };
    const system = String(later.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /\(BROKEN\) broken-tools\.mjs/, "the studio is told which of its tools is broken");
    assert.ok(events.length > 0);
  });

  it("records a self-edit with its reason for the diff UI", async () => {
    const rig = await turnRig([
      {
        toolCalls: [
          {
            id: "c1",
            name: "write_skill",
            arguments: {
              slug: "threejs-craft",
              reason: "learned that flat shading reads better in screenshots",
              title: "Use flat shading in scenes",
              summary: ["Flat shading reads better in screenshots."],
              contents: "---\nname: three.js craft\ndescription: updated\n---\n\n- Use flatShading.\n",
            },
          },
        ],
      },
      { text: "Skill updated." },
    ]);
    await rig.core.sendUserMessage("write down what you learned");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    const edits = customEvents(events, "skill_edited");
    assert.equal(edits.length, 1);
    assert.match(String(edits[0]!.reason), /flat shading/);
    assert.ok(
      edits[0]!.post_snapshot_id,
      "the post-apply snapshot id rides the same event, so Review can spot a later rewind",
    );
    const skill = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.md"), "utf8");
    assert.match(skill, /Use flatShading/);
  });
});

describe("memory policy", () => {
  it("keeps durable facts and refuses transient ones", async () => {
    const rig = await turnRig([
      {
        toolCalls: [
          { id: "m1", name: "remember", arguments: { key: "taste", value: "Simeon likes fast, punchy games" } },
        ],
      },
      { toolCalls: [{ id: "m2", name: "remember", arguments: { key: "current_task", value: "adding rings" } }] },
      { text: "Noted." },
    ]);
    await rig.core.sendUserMessage("remember some things");
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    const results = events
      .filter((e) => e.data.type === "tool_result")
      .map((e) => (e.data as { result: { ok: boolean; content: string } }).result);
    assert.equal(results[0]!.ok, true);
    assert.equal(results[1]!.ok, false, "a transient key is refused by the memory policy");
    assert.match(results[1]!.content, /durable facts/);

    const memory = (await rig.core.store.readArtifact(rig.core.mainThread, "memory")) as Record<string, string>;
    assert.deepEqual(Object.keys(memory), ["taste"]);
  });
});

describe("engine fallback (M2)", () => {
  it("a throttled engine in plain chat stops out loud instead of silently switching models", async () => {
    const rig = await turnRig([{ text: "Local engine took over." }]);

    // A contractor engine that is ready, but rate-limited the moment it is used.
    let attempts = 0;
    const throttled: Engine = {
      id: "contractor",
      label: "Contractor (throttled)",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "ready" }),
      models: async () => [
        {
          id: "big",
          label: "big",
          contextWindow: 131072,
          maxTokens: 100,
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false,
        },
      ],
      defaultModel: async () => "big",
      complete: async () => {
        attempts++;
        throw new EngineError("rate_limit", "contractor", "usage limit reached; resets at 5pm", 60_000);
      },
    };
    rig.core.engines.register(throttled);
    rig.core.engines.setPreferredOrder(["ollama", "contractor"]);

    await rig.core.sendUserMessage("build something", { engine: "contractor" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      45_000,
      "turn_ended",
    );

    assert.equal(attempts, 1, "the throttled engine was tried once");
    // A user who picked an engine gets that engine or an honest refusal — a reply quietly
    // written by another model under the picked engine's label read as a bait-and-switch.
    assert.equal(customEvents(events, "engine_fallback").length, 0, "plain chat never switches engines");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.match(messages.at(-1)?.content ?? "", /throttled|didn't switch/i);
    assert.notEqual(messages.at(-1)?.content, "Local engine took over.");
  });

  it("a commissioned run still survives a throttle — falling back out loud", async () => {
    const rig = await turnRig([{ text: "Local engine took over." }]);
    let attempts = 0;
    const throttled: Engine = {
      id: "contractor",
      label: "Contractor (throttled)",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "ready" }),
      models: async () => [
        {
          id: "big",
          label: "big",
          contextWindow: 131072,
          maxTokens: 100,
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false,
        },
      ],
      defaultModel: async () => "big",
      complete: async () => {
        attempts++;
        throw new EngineError("rate_limit", "contractor", "usage limit reached; resets at 5pm", 60_000);
      },
    };
    rig.core.engines.register(throttled);
    rig.core.engines.setPreferredOrder(["ollama", "contractor"]);

    await rig.core.sendUserMessage("build something", { engine: "contractor", loop: { hours: 1 } });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      45_000,
      "turn_ended",
    );

    assert.equal(attempts, 1, "the throttled engine was tried once");
    const fallbacks = customEvents(events, "engine_fallback");
    assert.equal(fallbacks.length, 1, "the run falls back rather than dying");
    assert.equal(fallbacks[0]!.from, "contractor");
    assert.equal(fallbacks[0]!.to, "ollama");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    // The swap is announced in the chat itself, then the local engine's reply follows.
    assert.ok(
      messages.some((m) => /continuing the run on ollama/i.test(m.content ?? "")),
      "the fallback is said out loud",
    );
    assert.equal(messages.at(-1)?.content, "Local engine took over.");
  });

  it("a stopped contractor preserves work without starting preview verification", async () => {
    const rig = await turnRig([]);
    rig.core.engines.register({
      id: "stopped-vendor",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async () => ({
        ok: false,
        engine: "stopped-vendor",
        summary: "partial",
        turns: 1,
        durationMs: 1,
        billing: "subscription",
        usage: {},
        stopReason: "stopped",
        sessionId: "preserved-session",
      }),
    });
    await rig.core.sendUserMessage("Build a tiny stopped fixture game", { engine: "stopped-vendor" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30000,
      "turn_ended",
    );
    const serialized = JSON.stringify(events);
    assert.match(serialized, /Stopped\. Finished edits are preserved/);
    assert.doesNotMatch(serialized, /Contractor finished|The game loads clean|build_observation/);
  });

  it("chat with a delegated engine hands the ask to the contractor in a game workspace", async () => {
    const rig = await turnRig([]);
    const briefs: Array<{ prompt: string; cwd: string }> = [];
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request) => {
        briefs.push({ prompt: request.prompt, cwd: request.cwd });
        return {
          ok: true,
          engine: "vendor",
          model: "vendor-large",
          summary: "Built a tiny pong prototype.",
          turns: 3,
          durationMs: 120_000,
          // API billing: real dollars, so the receipt must show them (a subscription hides them).
          billing: "api",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 1.25 },
        };
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );

    // The ask became a brief in a scaffolded game workspace, not an engine.complete call.
    assert.equal(briefs.length, 1);
    const games = await rig.core.games.list();
    assert.equal(games.length, 1);
    assert.equal(games[0]!.name, "tiny-pong");
    assert.ok(briefs[0]!.cwd.endsWith(games[0]!.name), "the contractor works inside the game workspace");
    assert.ok(briefs[0]!.prompt.includes("Build a tiny pong game"));
    assert.ok(briefs[0]!.prompt.includes("CLAUDE.md"), "the brief points at the workspace contract");

    // The transcript reads like a delegate_to_contractor tool call plus a normal reply.
    const requested = events.find((e) => e.data.type === "tool_requested")!;
    assert.equal((requested.data as { request: { name: string } }).request.name, "delegate_to_contractor");
    const result = events.find((e) => e.data.type === "tool_result")!;
    assert.equal((result.data as { result: { ok: boolean } }).result.ok, true);
    const messages = await rig.core.store.listMessages(rig.core.mainThread);

    // Handoff identity stays in diagnostics, without inserting host prose in the conversation.
    assert.ok(!messages.some((m) => m.role === "assistant" && m.content.includes("can't ask questions")));
    assert.ok(
      events.some(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === "contractor_handoff" &&
          (e.data.payload as { engine: string }).engine === "vendor",
      ),
    );

    // The reply is the builder's own words; the receipt (model, cost) stays in the recorded report.
    const last = messages.at(-1)!.content;
    assert.ok(last.startsWith("Built a tiny pong prototype."));
    for (const fact of ["vendor-large", "3 turns", "$1.25"])
      assert.ok(!last.includes(fact), `no per-message receipt: ${fact}`);
    const reply = events.findLast(
      (e) => e.data.type === "messages" && e.data.messages.some((m) => m.role === "assistant"),
    )?.data as { usage?: { model?: string; cost_usd?: number } } | undefined;
    assert.deepEqual([reply?.usage?.model, reply?.usage?.cost_usd], ["vendor-large", 1.25]);
    assert.equal((events.find((e) => e.data.type === "turn_ended")!.data as { status: string }).status, "ok");
  });

  it("a brief goes to the chosen project, and newProject forces a fresh one", async () => {
    const rig = await turnRig([]);
    const briefs: Array<{ cwd: string }> = [];
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async (request) => {
        briefs.push({ cwd: request.cwd });
        return { ok: true, engine: "vendor", summary: "done", turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    rig.core.engines.register(vendor);
    await rig.core.games.scaffold("old-game", { title: "old game" });
    await rig.core.games.scaffold("other-game", { title: "other game" });

    // Explicit project: the brief lands there, not in the newest game.
    await rig.core.sendUserMessage("Add a boss fight to the arena", { engine: "vendor", project: "old-game" });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn 1");
    assert.ok(briefs[0]!.cwd.endsWith("old-game"), "the chosen project wins over the newest one");

    // newProject: a fresh scaffold even though games exist — a new idea never lands in an old game.
    await rig.core.sendUserMessage("Build a chess puzzle game", { engine: "vendor", newProject: true });
    await waitForLog(rig.core, (log) => log.filter((e) => e.data.type === "turn_ended").length >= 2, 30_000, "turn 2");
    assert.ok(briefs[1]!.cwd.endsWith("chess-puzzle"), `scaffolded fresh, got ${briefs[1]!.cwd}`);
    const games = await rig.core.games.list();
    assert.equal(games.length, 3);
  });

  it("refuses a second contractor in the same project while one is building", async () => {
    const rig = await turnRig([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async () => {
        await gate;
        return { ok: true, engine: "vendor", summary: "done", turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    rig.core.engines.register(vendor);
    await rig.core.games.scaffold("pong", { title: "pong" });

    const delegate = rig.core.api()["engine.delegate"] as unknown as (p: {
      engine: string;
      project: string;
      prompt: string;
    }) => Promise<unknown>;
    const first = delegate({ engine: "vendor", project: "pong", prompt: "build it" });
    await assert.rejects(
      () => delegate({ engine: "vendor", project: "pong", prompt: "build it again" }),
      /already building in "pong"/,
      "the second brief is refused, not run concurrently into the same folder",
    );
    release();
    await first;
    // The lock lifts with the build: a follow-up brief goes through.
    await delegate({ engine: "vendor", project: "pong", prompt: "now tweak it" });
  });

  it("a delegation without a time budget gets the studio's chat ceiling, an explicit one passes through", async () => {
    const rig = await turnRig([]);
    const budgets: Array<number | undefined> = [];
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async (request) => {
        budgets.push(request.timeoutMs);
        return { ok: true, engine: "vendor", summary: "done", turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    rig.core.engines.register(vendor);
    await rig.core.games.scaffold("pong", { title: "pong" });

    const delegate = rig.core.api()["engine.delegate"] as unknown as (p: {
      engine: string;
      project: string;
      prompt: string;
      timeoutMs?: number;
    }) => Promise<unknown>;
    await delegate({ engine: "vendor", project: "pong", prompt: "build it" });
    // Six hours: generous slack for a chat build with no commission, but never unbounded.
    assert.equal(budgets[0], 6 * 3_600_000);
    await delegate({ engine: "vendor", project: "pong", prompt: "again", timeoutMs: 123_456 });
    assert.equal(budgets[1], 123_456, "a caller's own budget is not overridden");
  });

  it("a delegated engine conducts the commission interview itself over the MCP bridge", async () => {
    const rig = await turnRig([]);
    const requests: Array<Record<string, unknown>> = [];
    let calls = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request) => {
        calls++;
        // Later calls belong to the launched run's build turns — kill the run instantly so the
        // test only exercises the intake bridge.
        if (calls > 1) throw new EngineError("auth", "vendor", "sign-in expired");
        requests.push(request as never);
        return {
          ok: true,
          engine: "vendor",
          model: "vendor-large",
          summary: "Recap: a cold blue doomer street you walk through. Starting it now.",
          turns: 2,
          durationMs: 30_000,
          billing: "subscription",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            { name: "start_autopilot", args: { goal: "a walkable doomer street", direction: "cold blue dusk" } },
          ],
        };
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("make a russian doomer simulator", { engine: "vendor", autopilot: { hours: 1 } });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );

    // The interview ran ON the picked engine — no borrowed local model, tools bridged in.
    assert.equal(
      requests.length,
      1,
      JSON.stringify(
        events
          .map((e) => e.data)
          .filter((d) => d.type === "turn_ended" || d.type === "messages" || d.type === "tool_result"),
      ),
    );
    const tools = requests[0]!.interviewTools as Array<{ name: string }>;
    assert.equal(tools?.[0]?.name, "start_autopilot");
    // Flipped (step 1): the Loop chat is a contractor that may launch — never an interviewer
    // told a build is owed.
    assert.ok(String(requests[0]!.prompt).includes("It is allowed, not required"), "Loop allows a build");
    assert.ok(!/exactly once|NOT the builder/.test(String(requests[0]!.prompt)), "no brief that forces a launch");

    // The recorded intake call was executed by the harness and the launch is in the story.
    const intake = events.find(
      (e) =>
        e.data.type === "tool_requested" &&
        (e.data as { request: { name: string } }).request.name === "start_autopilot",
    );
    assert.ok(intake, "the intake call shows as a real tool call");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      messages.some((m) => /Recap: a cold blue doomer street/.test(m.content ?? "")),
      "the interviewer's reply reaches the chat",
    );
    assert.ok(
      messages.some((m) => /Building (for up to|until the critics)/.test(m.content ?? "")),
      "the launch is announced",
    );
    assert.ok(
      !messages.some((m) => /local model/.test(m.content ?? "")),
      "no borrowed-model note — the picked engine did the interview",
    );
    assert.ok(
      !messages.some((m) => /conducts the build interview/.test(m.content ?? "")),
      "handoff diagnostics are not assistant prose",
    );
    // Flipped (step 1): the handoff names the launch tool the chat had (`launch`), not `interview: true`.
    assert.ok(
      customEvents(events, "contractor_handoff").some((e) => e.engine === "vendor" && e.launch === "start_autopilot"),
      "the actual engine remains in diagnostic history",
    );
    assert.ok(
      !messages.some((m) => /Claude Code/.test(m.content ?? "")),
      "another engine must never be labelled Claude Code",
    );
  });

  it("records an intake question, waits for an explicit answer, and resumes the same provider session", async () => {
    const rig = await turnRig([]);
    const requests: import("../../src/substrate/engines/types.ts").DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request) => {
        requests.push(request);
        assert.ok(request.interviewTools?.some((tool) => tool.name === "ask_user"));
        return {
          ok: true,
          engine: "vendor",
          sessionId: "intake-question-session",
          turns: 1,
          usage: {},
          summary:
            requests.length === 1 ? "I'll keep the scene small enough to finish." : "A coast at night, understood.",
          studioToolCalls:
            requests.length === 1
              ? [
                  {
                    name: "ask_user",
                    args: {
                      question: "Where should the scene take place?",
                      options: "Ashlands (Recommended) | Open terrain\nTown street | Lanterns and buildings",
                    },
                  },
                  { name: "start_autopilot", args: { goal: "A Morrowind scene", direction: "Morrowind" } },
                ]
              : [],
        };
      },
    });
    await rig.core.sendUserMessage("make a Morrowind scene", { engine: "vendor", autopilot: { hours: 0.25 } });
    const first = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "question turn finished",
    );
    const questions = customEvents(first, "interview_question");
    assert.equal(questions.length, 1);
    assert.equal((questions[0]!.choices as Array<{ label: string }>)[0]!.label, "Ashlands (Recommended)");
    assert.equal(
      customEvents(first, "run_started").length,
      0,
      "asking a question never approves a simultaneous launch",
    );
    await rig.core.sendUserMessage("Actually, a coast at night", { engine: "vendor" });
    const answered = await waitForLog(
      rig.core,
      (log) => log.filter((e) => e.data.type === "turn_ended").length === 2,
      30_000,
      "answer turn finished",
    );
    assert.ok(
      answered
        .filter((e) => e.data.type === "turn_ended")
        .every((e) => e.data.type === "turn_ended" && e.data.status === "ok"),
    );
    assert.ok(
      (await rig.core.store.listMessages(rig.core.mainThread)).some(
        (message) => message.content === "A coast at night, understood.",
      ),
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.resume, "intake-question-session");
    assert.match(requests[1]!.prompt, /Actually, a coast at night/);
  });

  it("launches a recorded intake call even when the engine reports the interview ended badly", async () => {
    // Codex records start_autopilot through the bridge, then its session is reported as failed
    // over a non-fatal notice. The launch must survive the ending — the
    // studio told the contractor "the run starts when your reply ends" — and the chat must not
    // send the user back to a session that believes it already launched.
    const rig = await turnRig([]);
    let calls = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        calls++;
        if (calls > 1) throw new EngineError("auth", "vendor", "sign-in expired");
        return {
          ok: false,
          engine: "vendor",
          summary: "Autopilot is commissioned and will launch now.",
          turns: 7,
          stopReason: "error",
          errorText: "Skill descriptions were shortened to fit the skills context budget.",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            { name: "start_autopilot", args: { goal: "a photoreal MACBA plaza", direction: "after the rain" } },
          ],
        };
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("recreate MACBA", { engine: "vendor", autopilot: { hours: 1 } });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    assert.ok(
      events.some(
        (e) =>
          e.data.type === "tool_requested" &&
          (e.data as { request: { name: string } }).request.name === "start_autopilot",
      ),
      "the recorded call is executed by the harness",
    );
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      // Flipped (step 1): the session, not an interview, ended early; the build starts anyway.
      messages.some((m) => /starting the build anyway/.test(m.content ?? "")),
      "the ending is said, and so is the launch",
    );
    assert.ok(
      messages.some((m) => /Building (for up to|until the critics)/.test(m.content ?? "")),
      "the launch is announced",
    );
    assert.ok(!messages.some((m) => /Send your answer again/.test(m.content ?? "")), "no dead-end prompt to resend");
  });

  it("a throttled contractor chat stops out loud instead of switching to the local loop", async () => {
    const rig = await turnRig([{ text: "Local engine took over the brief." }]);
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        throw new EngineError("rate_limit", "vendor", "usage limit reached; resets at 5pm", 60_000);
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      45_000,
      "turn_ended",
    );

    assert.equal(customEvents(events, "engine_fallback").length, 0, "plain chat never switches engines");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.match(messages.at(-1)?.content ?? "", /throttled|didn't switch/i);
    assert.notEqual(messages.at(-1)?.content, "Local engine took over the brief.");
  });

  it("a contractor auth failure asks for sign-in instead of silently switching to local", async () => {
    const rig = await turnRig([{ text: "Local engine should not take over." }]);
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        throw new EngineError("auth", "vendor", "OAuth session expired — sign in again");
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended" || e.data.type === "error"),
      45_000,
      "turn ended or error",
    );

    assert.equal(customEvents(events, "engine_fallback").length, 0, "auth must not fall back to local");
    const signins = customEvents(events, "needs_signin");
    assert.equal(signins.length, 1);
    assert.equal(signins[0]!.engine, "vendor");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.match(messages.at(-1)?.content ?? "", /sign in/i);
  });

  it("gives up honestly when nothing can take over", async () => {
    const rig = await turnRig([]);
    const dead: Engine = {
      id: "dead",
      label: "Dead engine",
      kind: "direct",
      status: async () => ({ code: "error", detail: "offline" }),
      models: async () => [],
      complete: async () => {
        throw new EngineError("auth", "dead", "not signed in");
      },
    };
    rig.core.engines.register(dead);
    await rig.core.sendUserMessage("try the dead engine", { engine: "dead" });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    const errors = events.filter((e) => e.data.type === "error");
    assert.ok(errors.some((e) => /not signed in/.test((e.data as { message: string }).message)));
    assert.equal(customEvents(events, "engine_fallback").length, 0, "an auth failure is not papered over");
  });
});

describe("chat intake", () => {
  it("names a project from content words and never from punctuation", () => {
    // "make me - a racing thing please" once became `--racing-thing`: the dash survived as a
    // content word and the scaffold rejected the name, throwing out of the whole turn.
    const cases: Array<[ask: string, name: string]> = [
      ["Build a tiny pong game", "tiny-pong"],
      ["Build a chess puzzle game", "chess-puzzle"],
      ["make me - a racing thing please", "racing-thing"],
      ["make a -neon racer", "neon-racer"],
      ["---", "game"],
      ["", "game"],
    ];
    for (const [ask, name] of cases) {
      assert.equal(nameFromAsk(ask), name, `nameFromAsk(${JSON.stringify(ask)})`);
    }
  });

  it("a short ask in a chat bound to a game is an instruction, not smalltalk", async () => {
    const rig = await turnRig([]);
    const briefs: string[] = [];
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async (request) => {
        briefs.push(request.prompt);
        return {
          ok: true,
          engine: "vendor",
          summary: "fog added",
          turns: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    };
    rig.core.engines.register(vendor);
    await rig.core.games.scaffold("pong", { title: "pong" });

    await rig.core.sendUserMessage("add fog", { engine: "vendor", project: "pong" });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    assert.equal(briefs.length, 1, "the short follow-up reached the contractor");
    assert.match(briefs[0]!, /add fog/);
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      !messages.some((m) => m.content?.includes("What should we make?")),
      "a bound chat must never get the smalltalk deflection",
    );
  });

  it("a fresh unbound chat still deflects smalltalk instead of scaffolding", async () => {
    const rig = await turnRig([]);
    let delegations = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async () => {
        delegations++;
        return { ok: true, engine: "vendor", summary: "done", turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("hi", { engine: "vendor" });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    assert.equal(delegations, 0, "'hi' is not a brief");
    assert.equal((await rig.core.games.list()).length, 0, "'hi' must never become a project");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.match(messages.at(-1)?.content ?? "", /What should we make\?/);
  });
});

describe("a Loop chat that does the work itself", () => {
  /** A delegated engine that answers every session with `answer(request)`. */
  function vendorAnswering(
    rig: Rig,
    answer: (request: import("../../src/substrate/engines/types.ts").DelegateRequest) => Promise<unknown>,
  ): void {
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: answer as Engine["delegate"],
    });
  }

  // The plan-only turn that started this (corner-guy) is its incident row in harness-incidents.test.ts.
  it("checks code it changed before asking, and still waits for the answer", async () => {
    const rig = await turnRig([]);
    vendorAnswering(rig, async (request) => {
      await writeFile(path.join(request.cwd, "src/tweak.js"), "export const tweak = 1;\n");
      return {
        ok: true,
        engine: "vendor",
        sessionId: "loop-ask",
        turns: 2,
        usage: {},
        summary: "Fixed the jab timing.",
        studioToolCalls: [{ name: "ask_user", args: { question: "Build the full fight next?" } }],
      };
    });
    await rig.core.sendUserMessage("Fix the jab timing", { engine: "vendor", autopilot: { hours: 1 } });
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");
    assert.equal(customEvents(events, "build_observation").length, 1, "the edit is checked in the preview");
    assert.equal(customEvents(events, "interview_question").length, 1, "the question is recorded");
    assert.equal(customEvents(events, "run_started").length, 0);
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      messages.some((m) => (m.content ?? "").startsWith("Fixed the jab timing.\n\n")),
      "the preview's word follows the reply",
    );
  });

  it("a Loop chat whose session cannot be resumed starts fresh with the same rules", async () => {
    const rig = await turnRig([]);
    const prompts: Array<{ prompt: string; resume?: string }> = [];
    vendorAnswering(rig, async (request) => {
      prompts.push({ prompt: String(request.prompt), resume: request.resume });
      if (request.resume) throw new Error("session not found");
      return {
        ok: true,
        engine: "vendor",
        sessionId: `loop-${prompts.length}`,
        turns: 1,
        usage: {},
        summary: "Answered.",
      };
    });
    await rig.core.sendUserMessage("What engine should this use?", { engine: "vendor", autopilot: { hours: 1 } });
    await waitForLog(rig.core, (log) => log.filter((e) => e.data.type === "turn_ended").length === 1, 30_000, "one");
    await rig.core.sendUserMessage("And for the voice?", { engine: "vendor", autopilot: { hours: 1 } });
    await waitForLog(rig.core, (log) => log.filter((e) => e.data.type === "turn_ended").length === 2, 30_000, "two");
    assert.equal(prompts.length, 3, "first turn, the failed resume, the fresh retry");
    assert.equal(prompts[1]!.resume, "loop-1");
    assert.equal(prompts[2]!.resume, undefined);
    assert.match(prompts[2]!.prompt, /It is allowed, not required/);
    assert.match(prompts[2]!.prompt, /start_autopilot/);
  });

  // A Loop chat may run many turns before (or without) a build: the board used to ride along on
  // every resumed turn, re-sending the same stills to a session that already had them.
  it("the Loop mood board reaches a new session only, and a fresh retry gets it again", async () => {
    const rig = await turnRig([]);
    const calls: Array<{ resume?: string; images: string[] }> = [];
    vendorAnswering(rig, async (request) => {
      calls.push({ resume: request.resume, images: (request.images ?? []).map((image) => image.label) });
      // The third message's saved session is gone: it starts afresh.
      if (request.resume && calls.length === 3) throw new Error("session not found");
      return { ok: true, engine: "vendor", sessionId: `board-${calls.length}`, turns: 1, usage: {}, summary: "Noted." };
    });
    const frames = [
      { label: "board 1", mimeType: "image/png", data: Buffer.from("frame-one").toString("base64") },
      { label: "board 2", mimeType: "image/png", data: Buffer.from("frame-two").toString("base64") },
    ];
    const ended = (count: number) => (log: Array<{ data: { type: string } }>) =>
      log.filter((e) => e.data.type === "turn_ended").length === count;
    await rig.core.sendUserMessage("A foggy harbour at dawn", { engine: "vendor", autopilot: { hours: 1, frames } });
    await waitForLog(rig.core, ended(1), 30_000, "first turn");
    // The composer clears its chips once a message is sent; the thread keeps the board.
    await rig.core.sendUserMessage("What would the boats sound like?", { engine: "vendor", autopilot: { hours: 1 } });
    await waitForLog(rig.core, ended(2), 30_000, "resumed turn");
    await rig.core.sendUserMessage("And the gulls?", { engine: "vendor", autopilot: { hours: 1 } });
    await waitForLog(rig.core, ended(3), 30_000, "fresh retry");
    assert.equal(calls.length, 4, "new session, resumed turn, failed resume, fresh retry");
    assert.deepEqual(calls[0], { resume: undefined, images: ["board 1", "board 2"] }, "a new session gets the board");
    assert.deepEqual(calls[1], { resume: "board-1", images: [] }, "a resumed session already has it");
    assert.equal(calls[2]!.resume, "board-2");
    assert.deepEqual(calls[3], { resume: undefined, images: ["board 1", "board 2"] }, "a fresh start gets it again");
  });
});

describe("delegated build observation", () => {
  // A contractor whose word is always "done" — the probe, not the contractor, decides `ok`.
  async function observedBuildRig(): Promise<Rig> {
    const rig = await turnRig([]);
    let builds = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async (request) => {
        // Exercise a delivered edit. A read-only status turn intentionally skips preview
        // validation; its unchanged files must not accidentally satisfy this build test.
        builds += 1;
        await writeFile(path.join(request.cwd, "src/acceptance.js"), `export const delivered = ${builds};\n`);
        return {
          ok: true,
          engine: "vendor",
          model: "vendor-large",
          summary: "Built a tiny pong prototype.",
          turns: 3,
          durationMs: 120_000,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };
    rig.core.engines.register(vendor);
    return rig;
  }

  async function lastObservation(rig: Rig) {
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );
    return customEvents(events, "build_observation").at(-1)!;
  }

  it("a black screen fails the build even though the contractor reported success", async () => {
    const rig = await observedBuildRig();
    rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0.4, litFraction: 0 };
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });

    const observation = await lastObservation(rig);
    assert.equal(observation.ok, false, "the contractor's word must not outrank the pixels");
    assert.match(String(observation.reason), /black canvas/);
    const detail = observation.observation as { pixels: { litFraction: number } };
    assert.equal(detail.pixels.litFraction, 0);

    // The user hears about the screen in the reply — not only in the log.
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    const last = messages.at(-1)!.content;
    assert.match(last, /fix the black screen/);
    assert.ok(!last.includes("vendor-large"), "no per-message model label");
  });

  it("a lit, moving build passes and carries no reason", async () => {
    const rig = await observedBuildRig();
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const observation = await lastObservation(rig);
    assert.equal(observation.ok, true);
    assert.equal(observation.reason, null);
  });

  it("keeps the delegation's own time, turns and usage, and what the preview's readiness answered", async () => {
    const rig = await observedBuildRig();
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const observation = await lastObservation(rig);
    assert.equal(observation.durationMs, 120_000);
    assert.equal(observation.turns, 3);
    assert.deepEqual(observation.usage, { input_tokens: 10, output_tokens: 5 });
    const ready = observation.ready as { ready?: boolean; via?: string } | null;
    assert.deepEqual([ready?.ready, ready?.via], [true, "shim"]);
  });

  it("marks the reply as the delegation's report, so its build record is not counted again", async () => {
    const rig = await observedBuildRig();
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    await lastObservation(rig);
    const events = await rig.core.listAllEvents();
    const reports = events.filter((e) => e.data.type === EventKind.Messages && e.data.usage);
    assert.deepEqual(
      reports.map((e) => (e.data.type === EventKind.Messages ? e.data.usage_source : null)),
      [MessageUsageSource.Delegation],
      "the turn's one engine call is the contractor's",
    );
    const builds = events.filter((e) => customPayload(e.data, CustomEvent.BuildObservation)?.usage);
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.turn_id, reports[0]?.turn_id);
    assert.deepEqual([...repeatedBuildUsages(events)], [builds[0]?.id]);
  });

  it("records a project's first ready preview once, however many builds follow", async () => {
    const rig = await observedBuildRig();
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const game = String((await lastObservation(rig)).project);
    await rig.core.sendUserMessage("Make the paddles blue", { engine: "vendor", project: game });
    const events = await waitForLog(
      rig.core,
      (log) =>
        customEvents(log, "build_observation").length === 2 &&
        log.filter((e) => e.data.type === "turn_ended").length === 2,
      30_000,
      "second build",
    );
    const projects = customEvents(events, "build_observation").map((observation) => observation.project);
    assert.deepEqual(projects, [game, game], "both builds are of the one game");
    const firsts = customEvents(events, "preview_ready");
    assert.equal(firsts.length, 1, "only the first ready preview is the first");
    const [first] = firsts;
    assert.equal(first?.via, "shim");
    assert.equal(first?.project, projects[0]);
    assert.ok(Number(first?.ms) >= 0);
  });

  it("a preview that reports itself failed records no first preview", async () => {
    const rig = await observedBuildRig();
    rig.preview.evaluations.push({
      match: "clock.boot",
      value: {
        via: "shim",
        ready: false,
        phase: "failed",
        attached: true,
        frames: 0,
        drawCalls: 0,
        pageMs: null,
        reason: "boot threw",
        gesture: { needed: false, done: false, reasons: [] },
      },
    });
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const observation = await lastObservation(rig);
    assert.equal((observation.ready as { ready?: boolean } | null)?.ready, false);
    const events = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(customEvents(events, "preview_ready").length, 0);
  });

  it("a missing studio contract alone does not fail a chat build whose screen is alive", async () => {
    const rig = await observedBuildRig();
    // Chat builds owe no window.__studio — only unattended runs are judged on the contract.
    rig.preview.next = { __missing: true };
    await rig.core.sendUserMessage("Build a tiny pong game", { engine: "vendor" });
    const observation = await lastObservation(rig);
    assert.equal(observation.ok, true);
  });
});

describe("secrets", () => {
  it("refuses to store a secret in the clear unless explicitly allowed", async () => {
    const dir = path.join(await tmpDir("studio-secrets-"), "secrets");
    const strict = new SecretStore({ dir, backend: plaintextBackend() });
    await assert.rejects(() => strict.set("api-key", "sk-test"), /refusing to store a secret/);

    const permissive = new SecretStore({ dir, backend: plaintextBackend(), allowPlaintext: true });
    await permissive.set("api-key", "sk-test");
    assert.equal(await permissive.get("api-key"), "sk-test");
    assert.deepEqual(await permissive.list(), ["api-key"]);
    await permissive.delete("api-key");
    assert.equal(await permissive.get("api-key"), null);
  });

  it("round-trips through a backend and rejects unsafe keys", async () => {
    const dir = path.join(await tmpDir("studio-secrets-"), "secrets");
    const store = new SecretStore({
      dir,
      allowPlaintext: true,
      backend: {
        name: "reversed (pretend encryption)",
        isAvailable: () => true,
        encrypt: (value) => Buffer.from([...Buffer.from(value, "utf8")].reverse()),
        decrypt: (buffer) => Buffer.from([...buffer].reverse()).toString("utf8"),
      },
    });
    await store.set("token", "hello");
    const onDisk = await readFile(path.join(dir, "token.bin"), "utf8");
    assert.equal(onDisk, "olleh", "the value is transformed on disk");
    assert.equal(await store.get("token"), "hello");
    await assert.rejects(() => store.set("../escape", "x"), /invalid secret key/);
  });
});

/** Wait for a stopped run to write its ending, then tear the rig down. */
async function settleRun(rig: Rig): Promise<void> {
  await waitForLog(
    rig.core,
    (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
    20_000,
    "run_finished",
  ).catch(() => {});
  await rig.stop().catch(() => {});
}

describe("intake launch", () => {
  // The chat's folder is the answer to "where is my game". The interviewer only ferries a slug,
  // and the run it won, a second empty folder appeared in the rail with no chat attached: the
  // run built there while the user typed into the chat bound to the first folder.
  it("an intake from a bound chat builds in that chat's folder, whatever slug the interviewer passed", async () => {
    const rig = await turnRig([]);
    let calls = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        calls++;
        // Only the interview matters here; the launched run's own session dies immediately.
        if (calls > 1) throw new EngineError("auth", "vendor", "sign-in expired");
        return {
          ok: true,
          engine: "vendor",
          model: "vendor-large",
          summary: "Recap: talking fish in a cold blue pond. Starting it now.",
          turns: 2,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            {
              name: "start_autopilot",
              args: {
                goal: "a cozy fishing game where the fish talk back",
                direction: "cold blue dusk",
                project: "cold-blue-dusk",
              },
            },
          ],
        };
      },
    };
    rig.core.engines.register(vendor);
    await rig.core.games.scaffold("pond-life", { title: "pond life" });
    const thread = await rig.core.threadForGame("pond-life");

    await rig.core.sendUserMessage("a cozy fishing game where the fish talk back", {
      thread,
      engine: "vendor",
      autopilot: { hours: 1 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_registered"),
      30_000,
      "run_registered",
    );

    try {
      const registered = customEvents(events, "run_registered")[0] as {
        project?: string;
        readiness?: { contract?: string };
      };
      assert.equal(registered.project, "pond-life", "the run builds in the chat's folder, not the interviewer's slug");
      // What the folder needed the moment it was commissioned rides on the run (M2.6): the
      // run's first step is installing the studio contract when the page never loads it.
      assert.equal(registered.readiness?.contract, "loaded", "the studio's own template already loads it");
      const games = await rig.core.games.list();
      assert.deepEqual(
        games.map((g) => g.name),
        ["pond-life"],
        "no second folder was scaffolded for the slug",
      );

      // What the user is owed before walking away: when to come back, and that a pause is survivable.
      const messages = await rig.core.store.listMessages(thread);
      const runLedger = messages.find((m) => /Building until about \d{1,2}:\d\d/.test(m.content ?? ""));
      assert.ok(runLedger, "the launch names a wall-clock end time");
      assert.match(runLedger!.content ?? "", /keep the app open/i);
      assert.match(runLedger!.content ?? "", /resumes itself|tap on Resume/);
      assert.doesNotMatch(
        runLedger!.content ?? "",
        /studio's connection/,
        "and nothing is promised about a connection this game already has",
      );
    } finally {
      // The launched run outlives the assertions; stop it and let it write its own ending
      // here, or those writes race the temp-dir cleanup that runs before the rigs are torn down.
      await rig.core.stopThread(thread).catch(() => {});
      await settleRun(rig);
    }
  });

  it("an unbound chat still takes the folder the loop made for it, not the interviewer's slug", async () => {
    const rig = await turnRig([]);
    let calls = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        calls++;
        if (calls > 1) throw new EngineError("auth", "vendor", "sign-in expired");
        return {
          ok: true,
          engine: "vendor",
          summary: "Recap: talking fish in a cold blue pond. Starting it now.",
          turns: 2,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            {
              name: "start_autopilot",
              args: { goal: "a cozy fishing game where the fish talk back", direction: "cold blue dusk" },
            },
          ],
        };
      },
    };
    rig.core.engines.register(vendor);

    await rig.core.sendUserMessage("a cozy fishing game where the fish talk back", {
      engine: "vendor",
      autopilot: { hours: 1 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_registered"),
      30_000,
      "run_registered",
    );

    try {
      // The first sentence named the folder (nameFromAsk) before a word of the interview; the run
      // and the chat's binding must agree, so exactly one folder exists.
      const games = await rig.core.games.list();
      assert.deepEqual(
        games.map((g) => g.name),
        [nameFromAsk("a cozy fishing game where the fish talk back")],
      );
      const registered = customEvents(events, "run_registered")[0] as { project?: string };
      assert.equal(registered.project, games[0]!.name);
    } finally {
      await rig.core.stopThread(rig.core.mainThread).catch(() => {});
      await settleRun(rig);
    }
  });

  // A throttled Loop chat falls back to the local engine in the folder this turn already made,
  // and a launch recorded there is stamped with it, exactly like a delegated launch.
  it("a Loop chat that falls back to the local engine launches in the chat's folder", async () => {
    const ask = "a lighthouse keeper who talks to whales";
    const rig = await turnRig([
      {
        toolCalls: [
          {
            id: "l1",
            name: "start_autopilot",
            arguments: { goal: ask, direction: "grey sea at dusk", project: "grey-sea-at-dusk" },
          },
        ],
      },
    ]);
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async () => {
        throw new EngineError("rate_limit", "vendor", "usage limit reached; resets at 5pm", 60_000);
      },
    });
    rig.core.engines.setPreferredOrder(["ollama", "vendor"]);

    await rig.core.sendUserMessage(ask, { engine: "vendor", autopilot: { hours: 1 } });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_registered"),
      45_000,
      "run_registered",
    );

    try {
      const fallbacks = customEvents(events, "engine_fallback");
      assert.deepEqual(
        fallbacks.map((f) => [f.from, f.to]),
        [["vendor", "ollama"]],
      );
      const messages = await rig.core.store.listMessages(rig.core.mainThread);
      assert.ok(
        messages.some((m) => /continuing on ollama\.$/.test(m.content ?? "")),
        "a chat's fallback is said without promising a run",
      );
      const games = await rig.core.games.list();
      assert.deepEqual(
        games.map((g) => g.name),
        [nameFromAsk(ask)],
        "no second folder for the local model's slug",
      );
      const registered = customEvents(events, "run_registered")[0] as { project?: string };
      assert.equal(registered.project, nameFromAsk(ask), "the run builds in the chat's folder");
    } finally {
      await rig.core.stopThread(rig.core.mainThread).catch(() => {});
      await settleRun(rig);
    }
  });
});
