/**
 * Steer's cut, the host's half (`steer-cut.ts`): what a session has in flight, read from its events,
 * and a cut that lands only between tool calls, never inside one — on a clock the test holds, so the
 * cap on a call that never answers is reached without waiting for it.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import { BRIDGE_TOOL_DEADLINE_MS } from "../../src/substrate/engines/studio-bridge.ts";
import {
  cutAtNextStep,
  noteAsking,
  noteEvent,
  STEER_CUT_MAX_WAIT_MS,
  toolsInFlight,
  toolsRunning,
} from "../../src/main/core/steer-cut.ts";
import { ChatActivityPhase } from "../../src/shared/chat-activity.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { OpenCodeEngine, type OpenCodeInvocation } from "../../src/substrate/engines/opencode.ts";
import type { DelegateEvent } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const calls = (...ids: unknown[]): DelegateEvent => ({
  type: "assistant",
  payload: { role: "assistant", parts: ids.map((id) => ({ type: "tool_use", name: "Bash", id, input: "" })) },
});
const answers = (...ids: unknown[]): DelegateEvent => ({
  type: "user",
  payload: { role: "user", parts: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "" })) },
});
const activity = (phase: ChatActivityPhase, engine: string = EngineId.Codex): DelegateEvent => ({
  type: "activity",
  payload: { phase, engine },
});

/** A tracker for `engine` after `events`. */
function after(engine: string, events: DelegateEvent[]) {
  const tools = toolsInFlight(engine);
  for (const event of events) noteEvent(tools, event);
  return tools;
}

/** A clock whose waits the test ends: each stays pending until `pass` reaches its end, or its signal ends it. */
function heldClock() {
  let now = 0;
  const waits = new Set<{ at: number; resolve: () => void }>();
  const asked: number[] = [];
  return {
    asked,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      asked.push(ms);
      return new Promise((resolve, reject) => {
        const wait = { at: now + ms, resolve };
        waits.add(wait);
        signal?.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    async pass(ms: number): Promise<void> {
      now += ms;
      for (const wait of [...waits])
        if (wait.at <= now) {
          waits.delete(wait);
          wait.resolve();
        }
      await settle();
    },
    pending: () => waits.size,
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) await nextTurn();
}

describe("a session's tool calls in flight", () => {
  it("Claude Code's parallel calls: in flight until every one of them is answered", () => {
    const tools = after(EngineId.ClaudeCode, [calls("a", "b")]);
    assert.equal(toolsRunning(tools), true);
    noteEvent(tools, answers("a"));
    assert.equal(toolsRunning(tools), true, "b still runs");
    noteEvent(tools, answers("b"));
    assert.equal(toolsRunning(tools), false);
  });

  it("a subagent's nested calls, which name no parent, balance on their own ids", () => {
    const tools = after(EngineId.ClaudeCode, [calls("task"), calls("inner"), answers("inner")]);
    assert.equal(toolsRunning(tools), true, "the subagent's own call still runs");
    noteEvent(tools, answers("task"));
    assert.equal(toolsRunning(tools), false);
  });

  const hostile: Array<[string, DelegateEvent[], boolean]> = [
    ["an answer to a call never seen", [answers("ghost")], false],
    ["an answer to a call never seen, then a real call", [answers("ghost"), calls("a")], true],
    ["the same answer twice: the second changes nothing", [calls("a", "b"), answers("a"), answers("a")], true],
    ["the same call mirrored twice: one answer ends it", [calls("a"), calls("a"), answers("a")], false],
    ["a call whose answer never comes", [calls("a")], true],
    ["a call with no id", [calls(undefined), calls(""), calls(7), calls(null)], false],
    ["an answer naming no id", [calls("a"), answers(undefined), answers(""), answers(7)], true],
    ["rows with no parts", [{ type: "assistant", payload: { role: "assistant" } }], false],
    ["parts that are not a list", [{ type: "assistant", payload: { parts: "tool_use" } }], false],
    ["parts that are not objects", [{ type: "assistant", payload: { parts: [null, 3, "tool_use"] } }], false],
    ["a payload that is not an object", [{ type: "assistant", payload: null }], false],
    ["a call on a user row is no call", [{ type: "user", payload: { parts: [{ type: "tool_use", id: "a" }] } }], false],
    [
      "a result's id on an assistant row is no answer",
      [calls("a"), { type: "assistant", payload: { parts: [{ type: "tool_result", tool_use_id: "a" }] } }],
      true,
    ],
    ["a session's own thinking: no call", [activity(ChatActivityPhase.Thinking, EngineId.ClaudeCode)], false],
    [
      "Claude Code's activity line never opens a call by itself",
      [activity(ChatActivityPhase.Tool, EngineId.ClaudeCode)],
      false,
    ],
  ];
  for (const [name, events, running] of hostile) {
    it(`${name}: ${running ? "in flight" : "nothing in flight"}, and nothing thrown`, () => {
      assert.equal(toolsRunning(after(EngineId.ClaudeCode, events)), running);
    });
  }

  it("Codex's tool items, mirrored only once they end, are in flight from their start (activity)", () => {
    const tools = after(EngineId.Codex, [activity(ChatActivityPhase.Tool)]);
    assert.equal(toolsRunning(tools), true, "an item started");
    // Its rows arrive together as it completes, after the activity that says so.
    noteEvent(tools, activity(ChatActivityPhase.Thinking));
    noteEvent(tools, calls("item_1"));
    noteEvent(tools, answers("item_1"));
    assert.equal(toolsRunning(tools), false);
  });

  it("a Codex call mirrored with no answer row holds nothing: its activity alone says what is in flight", () => {
    const tools = after(EngineId.Codex, [activity(ChatActivityPhase.Tool), activity(ChatActivityPhase.Thinking)]);
    noteEvent(tools, calls("item_2"));
    assert.equal(toolsRunning(tools), false, "the item completed: a cut never waits the cap for its row");
  });

  it("two Codex items at once: in flight until both completed; a completion with none started opens nothing", () => {
    const tools = after(EngineId.Codex, [
      activity(ChatActivityPhase.Thinking),
      activity(ChatActivityPhase.Tool),
      activity(ChatActivityPhase.Tool),
      activity(ChatActivityPhase.Thinking),
    ]);
    assert.equal(toolsRunning(tools), true, "one item still runs");
    noteEvent(tools, activity(ChatActivityPhase.Thinking));
    assert.equal(toolsRunning(tools), false);
    noteEvent(tools, activity(ChatActivityPhase.Thinking));
    noteEvent(tools, activity(ChatActivityPhase.Tool));
    assert.equal(toolsRunning(tools), true, "never below nothing: the next start counts");
  });
});

describe("OpenCode's step span", () => {
  it("a step is in flight from its step_start until its step_finish: OpenCode reports a tool only once it ended", async () => {
    const root = await tmpDir("steer-cut-opencode-");
    await mkdir(path.join(root, "game"), { recursive: true });
    await writeFile(path.join(root, "game", "main.js"), "export const x = 1;\n");
    const tools = toolsInFlight(EngineId.OpenCode);
    const seen: boolean[] = [];
    const sessionID = "ses_steer_cut";
    const look = () => seen.push(toolsRunning(tools));
    async function* stream(_invocation: OpenCodeInvocation): AsyncGenerator<Record<string, unknown>> {
      look();
      yield { type: "step_start", sessionID, part: { messageID: "m1" } };
      look();
      yield {
        type: "tool_use",
        sessionID,
        part: { tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "ls" }, output: "" } },
      };
      look();
      yield { type: "step_finish", sessionID, part: { reason: "tool-calls", tokens: { input: 1, output: 1 } } };
      look();
      yield { type: "step_start", sessionID, part: { messageID: "m2" } };
      yield { type: "text", sessionID, part: { text: "Done" } };
      look();
      yield { type: "step_finish", sessionID, part: { reason: "stop", tokens: { input: 1, output: 1 } } };
      look();
    }
    const engine = new OpenCodeEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      execFn: stream,
      resolveCli: async () => ({ ready: true, path: "/usr/local/bin/opencode", version: "1.18.34", detail: "ok" }),
      listModels: async () => "",
    });
    const result = await engine.delegate({
      cwd: path.join(root, "game"),
      prompt: "list",
      onEvent: (event) => noteEvent(tools, event),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      seen,
      [false, true, true, false, true, false],
      "before a step, inside it (its tool ended or not), between steps, in the last one, after it",
    );
  });
});

describe("a cut waits for the tools in flight", () => {
  const session = (engine: string = EngineId.ClaudeCode) => {
    const ended = new AbortController();
    return {
      abort: new AbortController(),
      settled: ended.signal,
      tools: toolsInFlight(engine),
      ended: false as boolean,
      cutPending: false as boolean,
      /** Its engine let go: the session's end, before the host marks it ended. */
      letGo() {
        ended.abort();
      },
      end() {
        this.ended = true;
        ended.abort();
      },
    };
  };

  it("lands at once with nothing in flight", () => {
    const running = session();
    cutAtNextStep(running, heldClock().sleep);
    assert.equal(running.abort.signal.aborted, true);
    assert.equal(running.cutPending, false);
  });

  it("waits for both of two parallel calls, then lands as the last one is answered", async () => {
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("a", "b"));
    cutAtNextStep(running, clock.sleep);
    assert.equal(running.cutPending, true);
    noteEvent(running.tools, answers("a"));
    await settle();
    assert.equal(running.abort.signal.aborted, false, "b still runs");
    noteEvent(running.tools, answers("b"));
    await settle();
    assert.equal(running.abort.signal.aborted, true, "cut between tool calls");
    assert.equal(running.cutPending, false);
    assert.equal(clock.pending(), 0, "the cap's wait ended with the cut");
  });

  it("a call that starts in the same tick the last one ends keeps the cut waiting", async () => {
    const running = session();
    noteEvent(running.tools, calls("a"));
    cutAtNextStep(running, heldClock().sleep);
    noteEvent(running.tools, answers("a"));
    noteEvent(running.tools, calls("b"));
    await settle();
    assert.equal(running.abort.signal.aborted, false, "b started before the cut could land");
    noteEvent(running.tools, answers("b"));
    await settle();
    assert.equal(running.abort.signal.aborted, true);
  });

  it("a call waiting for the person's answer to its permission card is not in flight: the cut lands at once", async () => {
    const running = session();
    noteEvent(running.tools, calls("ask"));
    noteAsking(running.tools, "ask", true);
    cutAtNextStep(running, heldClock().sleep);
    assert.equal(running.abort.signal.aborted, true, "never waits for the person to answer the card");

    const working = session();
    noteEvent(working.tools, calls("bash", "ask"));
    cutAtNextStep(working, heldClock().sleep);
    noteAsking(working.tools, "ask", true);
    noteEvent(working.tools, answers("bash"));
    await settle();
    assert.equal(working.abort.signal.aborted, true, "lands once the running call ended, the card still open");

    const answered = session();
    noteEvent(answered.tools, calls("ask"));
    noteAsking(answered.tools, "ask", true);
    noteAsking(answered.tools, "ask", false);
    cutAtNextStep(answered, heldClock().sleep);
    assert.equal(answered.abort.signal.aborted, false, "allowed: the call now runs, and the cut waits for it");
    noteEvent(answered.tools, answers("ask"));
    await settle();
    assert.equal(answered.abort.signal.aborted, true);
  });

  it("a call that never answers is cut anyway once the cap passed, longer than one bridge call may take", async () => {
    assert.ok(STEER_CUT_MAX_WAIT_MS > BRIDGE_TOOL_DEADLINE_MS);
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("stuck"));
    cutAtNextStep(running, clock.sleep);
    assert.deepEqual(clock.asked, [STEER_CUT_MAX_WAIT_MS]);
    await clock.pass(STEER_CUT_MAX_WAIT_MS - 1);
    assert.equal(running.abort.signal.aborted, false);
    await clock.pass(1);
    assert.equal(running.abort.signal.aborted, true, "a stuck id never strands a message");
    assert.equal(running.cutPending, false);
  });

  it("a cut already waiting is the same cut: one cap, one abort", async () => {
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("a"));
    cutAtNextStep(running, clock.sleep);
    cutAtNextStep(running, clock.sleep);
    assert.deepEqual(clock.asked, [STEER_CUT_MAX_WAIT_MS]);
    noteEvent(running.tools, answers("a"));
    await settle();
    assert.equal(running.abort.signal.aborted, true);
  });

  it("Stop while a cut waits aborts at once; the cut lands on nothing after", async () => {
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("a"));
    cutAtNextStep(running, clock.sleep);
    running.abort.abort("stop");
    assert.equal(running.abort.signal.reason, "stop", "Stop is Stop: its own reason, at once");
    noteEvent(running.tools, answers("a"));
    await clock.pass(STEER_CUT_MAX_WAIT_MS);
    assert.equal(running.abort.signal.reason, "stop");
  });

  it("a session that ended while its cut waited is never aborted after, and its cap's wait ends with it", async () => {
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("a"));
    cutAtNextStep(running, clock.sleep);
    running.end();
    await settle();
    assert.equal(clock.pending(), 0);
    noteEvent(running.tools, answers("a"));
    await clock.pass(STEER_CUT_MAX_WAIT_MS);
    assert.equal(running.abort.signal.aborted, false);
  });

  it("a session whose engine let go is never aborted, even before it is marked ended", async () => {
    const running = session();
    const clock = heldClock();
    noteEvent(running.tools, calls("a"));
    cutAtNextStep(running, clock.sleep);
    running.letGo();
    noteEvent(running.tools, answers("a"));
    await clock.pass(STEER_CUT_MAX_WAIT_MS);
    assert.equal(running.abort.signal.aborted, false, "its jobs and calls end with its own end, not a late cut");
  });
});
