/**
 * Steer: a message sent while the game chat's own turn works reaches that turn instead of
 * waiting for it to end. The queue hands it over, the host puts it into the session answering
 * the chat — read mid-turn by an engine that can, or by interrupting and resuming the same
 * session — and the log records where it was read, so the chat shows it there.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import type { DelegateRequest, DelegateResult, SteerMessage } from "../../src/substrate/engines/types.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { steeredCall } from "../../src/harness-seed/loop/chat-steer.ts";
import { handleUserMessage } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { steeredTurnPrompt, withSteers } from "../../src/harness-seed/loop/chat-steer-prompts.ts";

const rigs: Rig[] = [];
after(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {});
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const until = async (check: () => boolean) => {
  for (let n = 0; n < 2000; n++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("did not settle");
};
const ok = (summary: string, sessionId: string, extra: Partial<DelegateResult> = {}): DelegateResult => ({
  ok: true,
  summary,
  sessionId,
  turns: 1,
  usage: {},
  durationMs: 1,
  engine: "fixture",
  ...extra,
});
const stopped = (
  sessionId: string | undefined,
  turns: number,
  extra: Partial<DelegateResult> = {},
): DelegateResult => ({
  ok: false,
  summary: "",
  stopReason: "stopped",
  ...(sessionId ? { sessionId } : {}),
  turns,
  usage: {},
  durationMs: 1,
  engine: "fixture",
  ...extra,
});
const whenAborted = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
const custom = (events: EventEnvelope[], type: string) =>
  events.filter((e) => e.data.type === "custom" && e.data.event_type === type);
const payloadOf = (event: EventEnvelope | undefined): any => (event?.data as any)?.payload;

/** The queue with a host whose sessions cannot take input mid-turn: `engine.steer` interrupts. */
function interruptingQueue(run: (action: any, steer: any) => Promise<unknown>) {
  const events: any[] = [],
    artifacts = new Map<string, unknown>(),
    interrupts: Array<() => void> = [];
  let interrupt = () => {};
  const host = {
    call: async (method: string, p: any) => {
      if (method === "events.append")
        for (const data of p.batch)
          events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
      if (method === "events.list") return events;
      if (method === "artifact.write") artifacts.set(p.artifactId, p.value);
      if (method === "artifact.read") return artifacts.get(p.artifactId);
      if (method === "engine.steer") {
        interrupts.push(interrupt);
        interrupt();
        return { how: "interrupt", accepted: p.messages.map((m: any) => m.id) };
      }
    },
    notify: () => {},
  };
  const queue = new MessageQueue(host as never, run);
  const send = (text: string, extra: object = {}) =>
    queue.enqueue({ type: "user_message", threadId: "chat", text, ...extra });
  const state = (text: string) => [...messageQueueState(events).messages.values()].find((m) => m.action?.text === text);
  return {
    queue,
    events,
    send,
    state,
    interrupts,
    onInterrupt: (fn: () => void) => {
      interrupt = fn;
    },
  };
}

describe("steered session: an engine without input mid-turn is interrupted and resumed", () => {
  it("resumes the same session with the message in front, recorded as delivered before the resume", async () => {
    const calls: any[] = [],
      started = deferred(),
      results: any[] = [];
    const q = interruptingQueue(async (action, steer) => {
      if (action.text !== "build a pond") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          resume: "prior",
          images: [],
          call: async (prompt, resume, images) => {
            calls.push({ prompt, resume, images, logged: q.events.length });
            if (calls.length === 1) {
              const cut = deferred();
              q.onInterrupt(() => cut.resolve());
              started.resolve();
              await cut.promise;
              return stopped("s1", 2);
            }
            return ok("Pond with ducks.", "s1");
          },
        }),
      );
    });
    await q.send("build a pond");
    await started.promise;
    await q.send("and ducks", { stills: [{ label: "duck", mimeType: "image/png", data: "synthetic" }] });
    await until(() => q.state("build a pond")?.state === "handled");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, "s1", "the same session, not a fresh one");
    assert.equal(calls[1].prompt, steeredTurnPrompt(["and ducks"]));
    assert.deepEqual(calls[1].images, [{ label: "duck", mimeType: "image/png", data: "synthetic" }]);
    const delivered = custom(q.events, "coordinator_message_delivered");
    assert.equal(delivered.length, 1);
    assert.deepEqual(
      { ...payloadOf(delivered[0]), messageId: undefined },
      { messageId: undefined, into: q.state("build a pond")!.messageId, how: "interrupt" },
    );
    assert.ok(q.events.indexOf(delivered[0]) < calls[1].logged, "recorded where it was read: before the resumed leg");
    assert.equal(q.state("and ducks")!.state, "delivered");
    assert.equal(results[0].summary, "Pond with ducks.");
    assert.equal(results[0].turns, 3);
    q.queue.stop();
  });

  it("a session cut before it read its prompt gets that prompt again, with the message after it", async () => {
    for (const cutOff of ["no session", "before start"] as const) {
      const calls: any[] = [],
        started = deferred();
      const q = interruptingQueue(async (action, steer) => {
        if (action.text !== "build a pond") return;
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          resume: "prior",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume });
            if (calls.length > 1) return ok("done", "s2");
            const cut = deferred();
            q.onInterrupt(() => cut.resolve());
            started.resolve();
            await cut.promise;
            if (cutOff === "before start")
              throw Object.assign(new Error("stopped before the contractor started"), { kind: "aborted" });
            return stopped(undefined, 0);
          },
        });
      });
      await q.send("build a pond");
      await started.promise;
      await q.send("and ducks");
      await until(() => q.state("build a pond")?.state === "handled");
      assert.deepEqual(calls[1], { prompt: withSteers("PROMPT", ["and ducks"]), resume: "prior" }, cutOff);
      assert.equal(q.state("and ducks")!.state, "delivered");
      q.queue.stop();
    }
  });

  it("Stop, a leg that finished first, or an interview that already asked its question: the message waits for its own turn", async () => {
    for (const ending of ["stop", "finished", "question"] as const) {
      const seen: string[] = [],
        started = deferred(),
        results: any[] = [];
      const ctx = { cancelled: false };
      const q = interruptingQueue(async (action, steer) => {
        seen.push(action.text);
        if (action.text !== "build a pond") return;
        results.push(
          await steeredCall(ctx, steer, {
            prompt: "PROMPT",
            call: async () => {
              const cut = deferred();
              q.onInterrupt(() => cut.resolve());
              started.resolve();
              await cut.promise;
              if (ending === "stop") {
                ctx.cancelled = true;
                return stopped("s1", 3);
              }
              if (ending === "finished") return ok("Done before the interrupt landed.", "s1");
              return stopped("s1", 1, { studioToolCalls: [{ name: "ask_user", args: { question: "Where?" } }] });
            },
          }),
        );
      });
      await q.send("build a pond");
      await started.promise;
      await q.send("and ducks");
      await until(() => seen.length === 2);
      assert.deepEqual(seen, ["build a pond", "and ducks"], ending);
      assert.equal(custom(q.events, "coordinator_message_delivered").length, 0, ending);
      if (ending === "stop") assert.equal(results[0].stopReason, "stopped", "a Stop still reads as a Stop");
      if (ending === "question")
        assert.deepEqual(
          [results[0].ok, results[0].studioToolCalls.length],
          [true, 1],
          "the question is still recorded",
        );
      await until(() => q.state("and ducks")?.state === "handled");
      q.queue.stop();
    }
  });

  it("a message sent while the turn is still being prepared goes into its first prompt", async () => {
    const calls: any[] = [],
      preparing = deferred(),
      prepared = deferred();
    const q = interruptingQueue(async (action, steer) => {
      if (action.text !== "build a pond") return;
      preparing.resolve();
      await prepared.promise;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        resume: "prior",
        images: [{ label: "pond", mimeType: "image/png", data: "p" }],
        call: async (prompt, resume, images) => {
          calls.push({ prompt, resume, images, logged: q.events.length });
          return ok("done", "prior");
        },
      });
    });
    await q.send("build a pond");
    await preparing.promise;
    await q.send("and ducks", { stills: [{ label: "duck", mimeType: "image/png", data: "d" }] });
    assert.equal(q.state("and ducks")!.state, "queued", "no session to hand it to yet");
    prepared.resolve();
    await until(() => q.state("build a pond")?.state === "handled");
    assert.equal(q.interrupts.length, 0, "nothing was interrupted");
    assert.deepEqual(
      calls.map((c) => [c.prompt, c.resume, c.images.length]),
      [[withSteers("PROMPT", ["and ducks"]), "prior", 2]],
    );
    const delivered = custom(q.events, "coordinator_message_delivered");
    assert.deepEqual(
      delivered.map((e) => payloadOf(e).how),
      ["prompt"],
    );
    assert.ok(q.events.indexOf(delivered[0]) < calls[0].logged);
    assert.equal(q.state("and ducks")!.state, "delivered");
    q.queue.stop();
  });

  it("while the turn is set up for a session a message shows as Sending… and joins its first prompt; a runner that never starts one lets it wait", async () => {
    for (const opens of [true, false]) {
      const calls: any[] = [],
        preparing = deferred(),
        prepared = deferred(),
        seen: string[] = [];
      const q = interruptingQueue(async (action, steer) => {
        seen.push(action.text);
        if (action.text !== "build a pond") return;
        await steer.expect();
        preparing.resolve();
        await prepared.promise;
        if (opens)
          await steeredCall({ cancelled: false }, steer, {
            prompt: "PROMPT",
            call: async (prompt) => {
              calls.push(prompt);
              return ok("done", "s");
            },
          });
      });
      await q.send("build a pond");
      await preparing.promise;
      await q.send("and ducks");
      const receipt = q.events.slice(-3).map((e) => e.data.event_type ?? e.data.type);
      assert.deepEqual(
        receipt,
        ["messages", "coordinator_message_queued", "coordinator_message_steering"],
        "never Queued first",
      );
      prepared.resolve();
      await until(() => seen.length === (opens ? 1 : 2) && q.state("build a pond")?.state === "handled");
      if (opens) {
        assert.deepEqual(calls, [withSteers("PROMPT", ["and ducks"])]);
        assert.equal(q.state("and ducks")!.state, "delivered");
      } else {
        await until(() => q.state("and ducks")?.state === "handled");
        assert.deepEqual(seen, ["build a pond", "and ducks"], "no session took it: it had a turn of its own");
      }
      q.queue.stop();
    }
  });

  it("a message to a run whose engine answers with a session shows Sending… while that session is set up, though the message names no engine", async () => {
    // The run's coordinator is Claude Code; the messages name no engine, so the turn's engine is the run's.
    const events: any[] = [
        {
          id: "0001",
          thread_id: "chat",
          data: {
            type: "custom",
            event_type: "run_started",
            payload: { runId: "r1", project: "pond", engine: "claude-code" },
          },
        },
      ],
      settingUp = deferred(),
      release = deferred();
    const host = {
      call: async (method: string, p: any) => {
        if (method === "events.append")
          for (const data of p.batch)
            events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
        if (method === "events.list") return events;
        if (method === "engine.describe") return [];
        if (method === "turn.begin") {
          // The coordinator's session is being set up: this test ends the turn here.
          settingUp.resolve();
          await release.promise;
          throw new Error("the turn ends here");
        }
      },
      notify: () => {},
    };
    const studio = {
      host,
      cancels: new Set(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ({ cancelled: false, setStatus: () => {} }),
    };
    const queue = new MessageQueue(host as never, (action, steer) => handleUserMessage(studio as never, action, steer));
    const send = (text: string) => queue.enqueue({ type: "user_message", threadId: "chat", text, project: "pond" });
    await send("How is the pond going?");
    await settingUp.promise;
    await send("And ducks");
    assert.deepEqual(
      events.slice(-3).map((e) => e.data.event_type ?? e.data.type),
      ["messages", "coordinator_message_queued", "coordinator_message_steering"],
      "Sending…, never Queued with Remove",
    );
    release.resolve();
    const state = (text: string) =>
      [...messageQueueState(events).messages.values()].find((m) => m.action?.text === text)?.state;
    await until(() => state("And ducks") === "handled");
    queue.stop();
  });

  it("Stop between an interrupt and the resume: nothing runs after it, and the message waits for its own turn", async () => {
    const calls: any[] = [],
      started = deferred(),
      seen: string[] = [],
      results: any[] = [];
    const ctx = { cancelled: false };
    const q = interruptingQueue(async (action, steer) => {
      seen.push(action.text);
      if (action.text !== "build a pond") return;
      results.push(
        await steeredCall(ctx, steer, {
          prompt: "PROMPT",
          call: async () => {
            calls.push(1);
            const cut = deferred();
            q.onInterrupt(() => {
              ctx.cancelled = true;
              cut.resolve();
            });
            started.resolve();
            await cut.promise;
            return stopped("s1", 2); // the Stop lands as the interrupt returns: after `ours` would have been read
          },
        }),
      );
    });
    await q.send("build a pond");
    await started.promise;
    await q.send("and ducks");
    await until(() => seen.length === 2);
    assert.equal(calls.length, 1, "the session is not resumed after a Stop");
    assert.equal(results[0].stopReason, "stopped");
    assert.equal(custom(q.events, "coordinator_message_delivered").length, 0);
    q.queue.stop();
  });

  it("a Stop before a resumed leg read anything puts the message it was resumed with back in the queue", async () => {
    const calls: any[] = [],
      started = deferred(),
      seen: string[] = [];
    const ctx = { cancelled: false };
    const q = interruptingQueue(async (action, steer) => {
      seen.push(action.text);
      if (action.text !== "build a pond") return;
      await steeredCall(ctx, steer, {
        prompt: "PROMPT",
        call: async () => {
          calls.push(1);
          if (calls.length === 1) {
            const cut = deferred();
            q.onInterrupt(() => cut.resolve());
            started.resolve();
            await cut.promise;
            return stopped("s1", 2);
          }
          ctx.cancelled = true; // stopped while the resumed session was still starting
          return stopped("s1", 0);
        },
      });
    });
    await q.send("build a pond");
    await started.promise;
    await q.send("and ducks");
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ["build a pond", "and ducks"], "never read: answered by a turn of its own");
    assert.deepEqual(
      custom(q.events, "coordinator_message_delivered").map((e) => payloadOf(e).how),
      ["interrupt"],
    );
    await until(() => q.state("and ducks")?.state === "handled");
    q.queue.stop();
  });

  it("a Stop before a later leg read its prompt puts back everything that prompt carried, not only its own messages", async () => {
    const calls: any[] = [],
      preparing = deferred(),
      prepared = deferred(),
      started = deferred(),
      seen: string[] = [];
    const ctx = { cancelled: false };
    const q = interruptingQueue(async (action, steer) => {
      seen.push(action.text);
      if (action.text !== "build a pond") return;
      preparing.resolve();
      await prepared.promise;
      await steeredCall(ctx, steer, {
        prompt: "PROMPT",
        call: async (prompt) => {
          calls.push(prompt);
          if (calls.length === 1) {
            const cut = deferred();
            q.onInterrupt(() => cut.resolve());
            started.resolve();
            await cut.promise;
            return stopped(undefined, 0);
          }
          ctx.cancelled = true; // stopped again before the resent prompt was read
          return stopped(undefined, 0);
        },
      });
    });
    await q.send("build a pond");
    await preparing.promise;
    await q.send("and ducks"); // joins the first prompt
    prepared.resolve();
    await started.promise;
    await q.send("make it run"); // interrupts that leg before it read anything
    await until(() => seen.length === 3);
    assert.equal(calls[1], withSteers(withSteers("PROMPT", ["and ducks"]), ["make it run"]));
    assert.deepEqual(
      seen,
      ["build a pond", "and ducks", "make it run"],
      "neither was read: both get turns of their own, in order",
    );
    q.queue.stop();
  });

  it("messages reach the resumed session in the order they were sent", async () => {
    const calls: any[] = [],
      started = deferred();
    const q: ReturnType<typeof interruptingQueue> = interruptingQueue(async (action, steer) => {
      if (action.text !== "build a pond") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt) => {
          calls.push(prompt);
          if (calls.length === 1) {
            const cut = deferred();
            // The interrupt for the first message lands; a second is sent while the leg winds down.
            q.onInterrupt(() => {
              q.onInterrupt(() => {});
              void q.send("and run").then(() => cut.resolve());
            });
            started.resolve();
            await cut.promise;
            return stopped("s1", 2);
          }
          return ok("done", "s1");
        },
      });
    });
    await q.send("build a pond");
    await started.promise;
    await q.send("and ducks");
    await until(() => q.state("build a pond")?.state === "handled");
    assert.equal(calls.length, 2);
    assert.equal(calls[1], steeredTurnPrompt(["and ducks", "and run"]));
    const textOf = (messageId: string) =>
      q.events.find(
        (r) => r.data.event_type === "coordinator_message_queued" && r.data.payload.messageId === messageId,
      )!.data.payload.action.text;
    assert.deepEqual(
      custom(q.events, "coordinator_message_delivered").map((e) => textOf(payloadOf(e).messageId)),
      ["and ducks", "and run"],
    );
    q.queue.stop();
  });

  it("a resumed leg whose session is gone starts fresh with everything the turn was told", async () => {
    const calls: any[] = [],
      started = deferred();
    const q = interruptingQueue(async (action, steer) => {
      if (action.text !== "build a pond") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        resume: "prior",
        fresh: () => "FRESH",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          if (calls.length === 1) {
            const cut = deferred();
            q.onInterrupt(() => cut.resolve());
            started.resolve();
            await cut.promise;
            return stopped("s1", 2);
          }
          if (calls.length === 2) throw new Error("No conversation found with session ID: s1");
          return ok("done", "s3");
        },
      });
    });
    await q.send("build a pond");
    await started.promise;
    await q.send("and ducks");
    await until(() => q.state("build a pond")?.state === "handled");
    assert.deepEqual(
      calls.map((c) => c.resume),
      ["prior", "s1", null],
    );
    assert.equal(calls[2].prompt, withSteers("FRESH", ["and ducks"]));
    q.queue.stop();
  });

  it("without a steer handle the call runs once, as it always did", async () => {
    const calls: any[] = [];
    const result = await steeredCall({ cancelled: false }, undefined, {
      prompt: "PROMPT",
      resume: "prior",
      images: [{ label: "pond", mimeType: "image/png", data: "p" }],
      fresh: () => "FRESH",
      call: async (prompt, resume, images) => {
        calls.push({ prompt, resume, images: images.length });
        if (calls.length === 1) throw new Error("No conversation found with session ID: prior");
        return ok("done", "s2");
      },
    });
    assert.deepEqual(calls, [
      { prompt: "PROMPT", resume: "prior", images: 1 },
      { prompt: "FRESH", resume: null, images: 1 },
    ]);
    assert.equal(result.summary, "done");
    assert.equal("steered" in result, false, "the result is the engine's, untouched");
  });
});

/** A chat whose game has a finished run: its messages are answered by the run's coordinator. */
async function coordinatorChat(rig: Rig, project: string, engine: string): Promise<string> {
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  await rig.core.append(
    [
      { type: "custom", event_type: "run_started", payload: { runId: "saved", project, engine } },
      { type: "custom", event_type: "run_finished", payload: { runId: "saved", project } },
    ],
    thread,
  );
  return thread;
}
const handledCount = (thread: string, n: number) => (es: EventEnvelope[]) =>
  es.filter(
    (e) => e.thread_id === thread && e.data.type === "custom" && e.data.event_type === "coordinator_message_handled",
  ).length >= n;
const byText = (events: EventEnvelope[], text: string) =>
  [...messageQueueState(events as never).messages.values()].find((m) => (m.action as { text?: string }).text === text)!;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("steer through the host and the harness process", () => {
  it("an engine that reads input mid-turn gets the message in the running session, recorded where it read it", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const thread = await coordinatorChat(rig, "steer-native", "claude-code");
    const calls: DelegateRequest[] = [],
      handed = deferred<SteerMessage>();
    rig.core.engines.register({
      id: "claude-code",
      label: "Claude",
      kind: "delegated",
      steersMidTurn: true,
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        calls.push(request);
        assert.ok(request.steer, "the chat’s own turn is open to steering");
        request.steer.ready((message) => {
          handed.resolve(message);
          return true;
        });
        const message = await handed.promise;
        request.onEvent?.({
          type: "assistant",
          payload: { role: "assistant", parts: [{ type: "text", text: "Looking at the pond." }] },
        });
        request.onEvent?.({ type: "steer_delivered", payload: { id: message.id } });
        request.onEvent?.({
          type: "assistant",
          payload: { role: "assistant", parts: [{ type: "text", text: "Ducks as well, then." }] },
        });
        return ok("The pond has ducks.", "native-session", { steered: [message.id] });
      },
    });
    await rig.core.sendUserMessage("Build a pond", { thread, engine: "claude-code" });
    await waitForLog(rig.core, () => calls.length === 1, 15000);
    await rig.core.sendUserMessage("And ducks", { thread, engine: "claude-code", clientId: "msg_ducks" });
    const events = (await waitForLog(rig.core, handledCount(thread, 1), 15000)).filter((e) => e.thread_id === thread);
    assert.equal(calls.length, 1, "no second session and no turn of its own");
    assert.equal((await handed.promise).text, "And ducks");
    const pond = byText(events, "Build a pond"),
      ducks = byText(events, "And ducks");
    assert.equal(ducks.messageId, "msg_ducks");
    assert.equal(ducks.state, "delivered");
    const delivered = custom(events, "coordinator_message_delivered");
    assert.deepEqual(
      delivered.map((e) => payloadOf(e)),
      [{ messageId: "msg_ducks", into: pond.messageId, how: "native" }],
    );
    // Where it was read: after what the session said before it, before what it said after.
    const said = (text: string) => events.findIndex((e) => JSON.stringify(e.data).includes(text));
    const at = events.indexOf(delivered[0]!);
    assert.ok(said("Looking at the pond.") < at && at < said("Ducks as well, then."));
    assert.equal(custom(events, "coordinator_message_processing").length, 1);
    await settle(300);
    assert.equal(calls.length, 1);
  });

  it("Codex fallback: the session is interrupted and resumed with the message in front, never read as a Stop", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const thread = await coordinatorChat(rig, "steer-codex", "codex");
    const calls: DelegateRequest[] = [],
      started = deferred();
    rig.core.engines.register({
      id: "codex",
      label: "Codex",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        calls.push(request);
        assert.equal(request.steer, undefined, "no input mid-turn: the host interrupts instead");
        if (calls.length === 1) {
          started.resolve();
          await whenAborted(request.signal);
          return stopped("codex-thread", 3);
        }
        assert.equal(request.resume, "codex-thread");
        assert.equal(request.prompt.split("\n\n")[0], steeredTurnPrompt(["Make it run"]).split("\n\n")[0]);
        assert.match(request.prompt, /> Make it run/);
        return ok("Night falls on the pond.", "codex-thread");
      },
    });
    await rig.core.sendUserMessage("Build a pond", { thread, engine: "codex" });
    await started.promise;
    await rig.core.sendUserMessage("Make it run", { thread, engine: "codex" });
    const events = (await waitForLog(rig.core, handledCount(thread, 1), 15000)).filter((e) => e.thread_id === thread);
    assert.equal(calls.length, 2);
    const loopRun = byText(events, "Make it run");
    assert.equal(loopRun.state, "delivered");
    assert.deepEqual(
      custom(events, "coordinator_message_delivered").map((e) => payloadOf(e).how),
      ["interrupt"],
    );
    const text = JSON.stringify(events);
    assert.doesNotMatch(text, /I could not answer that|Could not answer this message|stopped by you/);
    assert.match(text, /Night falls on the pond\./);
    await settle(300);
    assert.equal(calls.length, 2, "the message never gets a turn of its own");
  });

  it("the chat contractor is steered too, Stop still stops, and Rewind withdraws the steered message with its turn", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = "steer-contractor";
    await rig.core.games.scaffold(project);
    const thread = await rig.core.createGameThread(project);
    const calls: DelegateRequest[] = [];
    let handed = deferred<SteerMessage>();
    rig.core.engines.register({
      id: "claude-code",
      label: "Claude",
      kind: "delegated",
      steersMidTurn: true,
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        calls.push(request);
        if (/add a bridge/.test(request.prompt)) return ok("Added a bridge.", "contractor-session");
        if (/Stop me/.test(request.prompt)) {
          request.steer?.ready(() => true);
          await whenAborted(request.signal);
          return stopped("contractor-session", 2, { steered: [] });
        }
        request.steer?.ready((message) => {
          handed.resolve(message);
          return true;
        });
        const message = await handed.promise;
        request.onEvent?.({ type: "steer_delivered", payload: { id: message.id } });
        return ok("Built the pond with ducks.", "contractor-session", { steered: [message.id] });
      },
    });
    await rig.core.sendUserMessage("Build a pond", { thread, engine: "claude-code" });
    await waitForLog(
      rig.core,
      (es) =>
        calls.length === 1 &&
        custom(
          es.filter((e) => e.thread_id === thread),
          "coordinator_message_processing",
        ).length === 1,
      15000,
    );
    await rig.core.sendUserMessage("And ducks", { thread, engine: "claude-code" });
    let events = (await waitForLog(rig.core, handledCount(thread, 1), 15000)).filter((e) => e.thread_id === thread);
    assert.equal(byText(events, "And ducks").state, "delivered");
    assert.equal(calls.length, 1);

    // Stop: what the session had not read goes back to the queue and is answered next.
    handed = deferred<SteerMessage>();
    await rig.core.sendUserMessage("Stop me", { thread, engine: "claude-code" });
    await waitForLog(rig.core, () => calls.length === 2, 15000);
    await rig.core.sendUserMessage("Then add a bridge", { thread, engine: "claude-code" });
    await waitForLog(
      rig.core,
      (es) =>
        custom(
          es.filter((e) => e.thread_id === thread),
          "coordinator_message_steering",
        ).length === 2,
      15000,
    );
    await rig.core.stopThread(thread);
    events = (await waitForLog(rig.core, handledCount(thread, 3), 15000)).filter((e) => e.thread_id === thread);
    const bridge = byText(events, "Then add a bridge");
    assert.equal(bridge.state, "handled", "answered by a turn of its own after the Stop");
    assert.equal(
      custom(events, "coordinator_message_processing").filter((e) => payloadOf(e).messageId === bridge.messageId)
        .length,
      1,
    );
    assert.match(JSON.stringify(events), /Stopped\. Finished edits are preserved/);

    // Rewind: the steered message is a target of its own (flipped: it used to be refused), whose
    // files cannot come back alone, and it leaves with the turn it joined.
    const pond = byText(events, "Build a pond"),
      ducks = byText(events, "And ducks");
    assert.deepEqual((await rig.core.rewindPreview(thread, ducks.eventId!, ducks.messageId)).files, {
      state: "unavailable",
      reason: "joined-answer",
    });
    const rewound = await rig.core.rewindChat(thread, pond.eventId!, pond.messageId);
    assert.equal(rewound.text, "Build a pond");
    assert.deepEqual(rewound.held, [], "a delivered message does not come back as a waiting follow-up");
  });

  it("a message steered into a turn that continues the build reaches the builder, restated or not", async () => {
    for (const restate of [false, true]) {
      const rig = await startRig();
      rigs.push(rig);
      const thread = await coordinatorChat(rig, `steer-continue-${restate}`, "claude-code");
      const builders: DelegateRequest[] = [],
        handed = deferred<SteerMessage>();
      let started = 0;
      rig.core.engines.register({
        id: "claude-code",
        label: "Claude",
        kind: "delegated",
        steersMidTurn: true,
        status: async () => ({ code: "ready", detail: "" }),
        models: async () => [],
        delegate: async (request) => {
          if (!request.coordinator) {
            builders.push(request);
            return ok("Built it.", "builder");
          }
          started++;
          request.steer?.ready((message) => {
            handed.resolve(message);
            return true;
          });
          await request.onLiveTool!("continue_build", { text: "Make the sky red" });
          const message = await handed.promise;
          request.onEvent?.({ type: "steer_delivered", payload: { id: message.id } });
          if (restate) await request.onLiveTool!("continue_build", { text: "Make the sky red and add rain" });
          return ok("On it.", "coordinator", { steered: [message.id] });
        },
      });
      await rig.core.sendUserMessage("Make the sky red", { thread, engine: "claude-code" });
      await waitForLog(rig.core, () => started === 1, 15000);
      await rig.core.sendUserMessage("And add rain", { thread, engine: "claude-code" });
      await waitForLog(rig.core, handledCount(thread, 1), 20000);
      assert.equal(builders.length, 1, `restated: ${restate}`);
      assert.match(builders[0]!.prompt, /Make the sky red/);
      assert.match(builders[0]!.prompt, /add rain/i, "the steered request is built, not only answered");
      assert.equal(
        (builders[0]!.prompt.match(/add rain/gi) ?? []).length,
        1,
        "once, whether or not the coordinator restated it",
      );
    }
  });

  it("a replayed turn that continues the build hands the builder what it had read, once", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const thread = await coordinatorChat(rig, "steer-replay-continue", "codex");
    const builders: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "Codex",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        if (!request.coordinator) {
          builders.push(request);
          return ok("Built it.", "builder");
        }
        await request.onLiveTool!("continue_build", { text: "Make the sky red" });
        return ok("On it.", "coordinator");
      },
    });
    const action = (messageId: string, text: string) => ({
      messageId,
      type: "user_message",
      threadId: thread,
      project: "steer-replay-continue",
      text,
      engine: "codex",
    });
    await rig.core.append(
      [
        { type: "messages", messages: [{ role: "user", content: "Make the sky red" }] },
        {
          type: "custom",
          event_type: "coordinator_message_queued",
          payload: { messageId: "sky", action: action("sky", "Make the sky red") },
        },
        { type: "custom", event_type: "coordinator_message_processing", payload: { messageId: "sky" } },
        { type: "messages", messages: [{ role: "user", content: "And add rain" }] },
        {
          type: "custom",
          event_type: "coordinator_message_queued",
          payload: { messageId: "rain", action: action("rain", "And add rain") },
        },
        {
          type: "custom",
          event_type: "coordinator_message_delivered",
          payload: { messageId: "rain", into: "sky", how: "interrupt" },
        },
      ],
      thread,
    );
    await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "crash_restart" } });
    await waitForLog(rig.core, handledCount(thread, 1), 20000);
    assert.equal(builders.length, 1);
    assert.equal(
      (builders[0]!.prompt.match(/And add rain/g) ?? []).length,
      1,
      "carried into the builder once, not twice",
    );
  });

  it("restart: a turn cut short is answered once more with the message it had read, and nothing twice", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const thread = await coordinatorChat(rig, "steer-replay", "codex");
    const prompts: string[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "Codex",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        prompts.push(request.prompt);
        return ok("Pond, ducks and all.", "replayed");
      },
    });
    const action = (messageId: string, text: string) => ({
      messageId,
      type: "user_message",
      threadId: thread,
      project: "steer-replay",
      text,
      engine: "codex",
    });
    await rig.core.append(
      [
        { type: "messages", messages: [{ role: "user", content: "Build a pond" }] },
        {
          type: "custom",
          event_type: "coordinator_message_queued",
          payload: { messageId: "pond", action: action("pond", "Build a pond") },
        },
        { type: "custom", event_type: "coordinator_message_processing", payload: { messageId: "pond" } },
        { type: "messages", messages: [{ role: "user", content: "And ducks" }] },
        {
          type: "custom",
          event_type: "coordinator_message_queued",
          payload: { messageId: "ducks", action: action("ducks", "And ducks") },
        },
        { type: "custom", event_type: "coordinator_message_steering", payload: { messageId: "ducks", into: "pond" } },
        {
          type: "custom",
          event_type: "coordinator_message_delivered",
          payload: { messageId: "ducks", into: "pond", how: "interrupt" },
        },
        { type: "messages", messages: [{ role: "user", content: "Make it run" }] },
        {
          type: "custom",
          event_type: "coordinator_message_queued",
          payload: { messageId: "night", action: action("night", "Make it run") },
        },
        { type: "custom", event_type: "coordinator_message_steering", payload: { messageId: "night", into: "pond" } },
      ],
      thread,
    );
    await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "crash_restart" } });
    await waitForLog(rig.core, handledCount(thread, 2), 15000);
    await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "cold_start" } });
    await settle(300);
    assert.equal(prompts.length, 2, "the cut-short turn once, the unread message once");
    assert.match(prompts[0]!, /LATEST USER MESSAGE:\nBuild a pond/);
    assert.match(prompts[0]!, /address it too:\n> And ducks/, "the message it had read rides with it");
    assert.match(prompts[1]!, /LATEST USER MESSAGE:\nMake it run/);
    const events = await rig.core.store.listEvents(thread);
    assert.deepEqual(
      ["pond", "ducks", "night"].map((id) => messageQueueState(events as never).messages.get(id)!.state),
      ["handled", "delivered", "handled"],
    );
    assert.equal(custom(events, "coordinator_message_delivered").length, 1, "delivered once");
  });
});
