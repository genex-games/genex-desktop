/**
 * The Genex cover as its own step: once a run lands its build, the chat's agent is asked to make
 * the game's cover in one message the transcript leaves out, sent with the person's engine, model
 * and effort but never their Loop, so it starts no build. Once per landed run; never for a close
 * that landed nothing, and not ahead of a message the person wrote after the close.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { coverStepAsk, coverStepRuns } from "../../src/main/core/cover-step.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import { coreLite } from "../helpers/core-lite.ts";

const THREAD = "t1";
const PERSON = {
  type: "user_message",
  threadId: THREAD,
  text: "a night street race",
  engine: "claude-code",
  model: "opus",
  effort: "xhigh",
  autopilot: { hours: 1 },
  loop: { hours: 1 },
  project: "racer",
  projectDir: "/games/racer",
};

let seq = 0;
const custom = (event_type: string, payload: Record<string, unknown>): EventEnvelope => ({
  id: String(++seq).padStart(6, "0"),
  thread_id: THREAD,
  turn_id: null,
  session_id: null,
  created_at: new Date(seq * 1000).toISOString(),
  data: { type: "custom", event_type, payload },
});
const queued = (messageId: string, action: Record<string, unknown>) =>
  custom("coordinator_message_queued", { messageId, action });
const closed = (runId: string, payload: Record<string, unknown> = { landed: true }) =>
  custom("run_finished", { runId, project: "racer", ...payload });

describe("the Genex cover as a step after a landed build", () => {
  it("asks the chat's agent for the cover with the person's engine, model and effort, never their Loop, hidden from the chat", () => {
    const events = [queued("m1", PERSON), closed("r1")];
    assert.deepEqual(coverStepRuns(events), ["r1"]);
    const ask = coverStepAsk(THREAD, events, "r1");
    assert.ok(ask);
    assert.match(ask.text, /genex__skill \{"name":"cover"\}/, "the agent reads the cover skill then");
    assert.deepEqual(ask.options, {
      engine: "claude-code",
      model: "opus",
      effort: "xhigh",
      thread: THREAD,
      origin: MessageOrigin.CoverStep,
    });
    assert.ok(isChatReport(ask.options as Record<string, unknown>), "the transcript leaves it out");
  });

  it("asks nothing for a close that landed nothing", () => {
    for (const payload of [
      { landed: false },
      {},
      { landed: true, paused: true },
      { landed: true, executionStatus: "paused" },
    ]) {
      const events = [queued("m1", PERSON), closed("r2", payload)];
      assert.equal(coverStepAsk(THREAD, events, "r2"), null, JSON.stringify(payload));
    }
    assert.deepEqual(coverStepRuns([closed("r3", { landed: false })]), []);
  });

  it("asks once per landed run", () => {
    const first = [queued("m1", PERSON), closed("r4")];
    const ask = coverStepAsk(THREAD, first, "r4");
    assert.ok(ask);
    const asked = [...first, queued("m2", { type: "user_message", threadId: THREAD, text: ask.text, ...ask.options })];
    assert.equal(coverStepAsk(THREAD, asked, "r4"), null);
  });

  it("waits behind a message the person wrote after the close", () => {
    const events = [queued("m1", PERSON), closed("r5"), queued("m3", { ...PERSON, text: "make it rain" })];
    assert.equal(coverStepAsk(THREAD, events, "r5"), null);
  });

  it("asks nothing in a chat where the person never wrote", () => {
    assert.equal(coverStepAsk(THREAD, [closed("r6")], "r6"), null);
  });
});

describe("the core asks for the cover when a build lands", () => {
  type Sent = { text: string; options: { origin?: string; thread?: string } };

  async function landedIn(genexOn: boolean): Promise<Sent[]> {
    const { core } = await coreLite();
    await core.games.scaffold("racer", { title: "Racer" });
    await core.plugins.setEnabled(GENEX_PLUGIN_ID, genexOn);
    const threadId = await core.threadForGame("racer");
    const sent: Sent[] = [];
    core.sendUserMessage = (async (text: string, options: Sent["options"]) => {
      sent.push({ text, options });
    }) as never;
    const person = { ...PERSON, threadId };
    await core.append(
      [{ type: "custom", event_type: "coordinator_message_queued", payload: { messageId: "m1", action: person } }],
      threadId,
    );
    await core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: "r1", project: "racer", landed: true } }],
      threadId,
    );
    // The ask is sent off the append's path; give it the moment it takes.
    for (let tries = 0; tries < 50 && sent.length === 0; tries++) await sleep(20);
    return sent;
  }

  it("a web game with Genex on gets one hidden ask for its cover", async () => {
    const sent = await landedIn(true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.options.origin, MessageOrigin.CoverStep);
  });

  it("with Genex off nothing is asked", async () => {
    assert.deepEqual(await landedIn(false), []);
  });
});
