/**
 * Messages without a queue: a message the person sends while the chat's turn works reaches that
 * turn at the session's next step, whatever it changes. One that changes how the turn runs — the
 * Loop switched on or off, its hours, another model, effort or engine — cuts the session there and
 * the turn goes on with that message's settings; a slash command runs as a leg of its own and the
 * turn carries on after it. These drive the runner (chat-steer.ts) through the real queue.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DelegateResult } from "../../src/substrate/engines/types.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { type LegSwitch, steeredCall, type TurnSwitches } from "../../src/harness-seed/loop/chat-steer.ts";
import { steeredTurnPrompt, withSteers } from "../../src/harness-seed/loop/chat-steer-prompts.ts";
import { changesLoop } from "../../src/harness-seed/loop/steer-switch.ts";
import {
  afterCommandPrompt,
  SWITCH_NOTES,
  switchedTurnPrompt,
} from "../../src/harness-seed/loop/steer-switch-prompts.ts";

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
const stopped = (sessionId: string, turns: number, extra: Partial<DelegateResult> = {}): DelegateResult => ({
  ok: false,
  summary: "",
  stopReason: "stopped",
  sessionId,
  turns,
  usage: {},
  durationMs: 1,
  engine: "fixture",
  ...extra,
});

/** The queue over a host whose sessions are cut at their next step to take a message (`engine.steer` interrupts). */
function cuttingQueue(run: (action: any, steer: any) => Promise<unknown>) {
  const events: any[] = [],
    artifacts = new Map<string, unknown>(),
    asked: any[] = [];
  let cut = () => {};
  const host = {
    call: async (method: string, p: any) => {
      if (method === "events.append")
        for (const data of p.batch)
          events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
      if (method === "events.list") return events;
      if (method === "artifact.write") artifacts.set(p.artifactId, p.value);
      if (method === "artifact.read") return artifacts.get(p.artifactId);
      if (method === "engine.steer") {
        asked.push(p);
        cut();
        return { how: "interrupt", accepted: p.messages.map((m: any) => m.id) };
      }
    },
    notify: () => {},
  };
  const queue = new MessageQueue(host as never, run);
  const send = (text: string, extra: object = {}) =>
    queue.enqueue({ type: "user_message", threadId: "chat", text, engine: "claude-code", ...extra });
  const state = (text: string) => [...messageQueueState(events).messages.values()].find((m) => m.action?.text === text);
  return {
    queue,
    events,
    asked,
    send,
    state,
    onCut: (fn: () => void) => {
      cut = fn;
    },
  };
}

/** A leg the host cuts once a message arrives: it ends as stopped, its session kept. */
function legUntilCut(q: ReturnType<typeof cuttingQueue>, started: { resolve(): void }, result: DelegateResult) {
  const cut = deferred();
  q.onCut(() => cut.resolve());
  started.resolve();
  return cut.promise.then(() => result);
}

/**
 * Test switches: the Loop or another engine changes the turn, the Loop as the real rule weighs it
 * against `asked`; each switch leg is recorded by what it runs on.
 */
function switchesFor(calls: any[], applied: any[] = [], asked: Record<string, unknown> = {}): TurnSwitches {
  return {
    changes: (item) => Boolean(item.autopilot) || item.engine === "codex",
    changesLoop: (item) => changesLoop(item, asked),
    takes: () => true,
    apply: async (item): Promise<LegSwitch> => {
      applied.push(item.text);
      const on = item.engine === "codex" ? "codex" : "loop";
      return {
        call: async (prompt, resume, images) => {
          calls.push({ prompt, resume, images, on });
          return ok("switched", on === "codex" ? "c1" : "s1");
        },
        fresh: () => "FRESH BRIEF",
        newSession: on === "codex",
        notes: [on === "codex" ? "CODEX TAKES OVER" : "LOOP IS ON"],
      };
    },
  };
}

describe("a message that changes how the turn runs: the turn goes on with its settings", () => {
  it("Loop switched on mid-answer: the same session goes on at its next step, on the message's settings, told what changed", async () => {
    const calls: any[] = [],
      started = deferred(),
      results: DelegateResult[] = [];
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          resume: "prior",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume, on: "start" });
            return legUntilCut(q, started, stopped("s1", 3));
          },
          switches: switchesFor(calls),
        }),
      );
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("make it in the loop", { autopilot: { roles: {} } });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.equal(q.asked[0].native, false, "never read as words mid-turn");
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1],
      {
        prompt: switchedTurnPrompt(["LOOP IS ON"], steeredTurnPrompt(["make it in the loop"])),
        resume: "s1",
        images: [],
        on: "loop",
      },
      "the same session, on the switched call, the change said first",
    );
    assert.equal(q.state("make it in the loop")!.state, "delivered", "read by this turn: no turn of its own");
    assert.equal(results[0].summary, "switched");
    q.queue.stop();
  });

  it("another engine: a new session starts, told the brief, everything the turn was told, and what changed", async () => {
    const calls: any[] = [],
      started = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        resume: "prior",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume, on: "start" });
          return legUntilCut(q, started, stopped("s1", 3));
        },
        fresh: () => "OLD BRIEF",
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("let codex finish it", { engine: "codex" });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(calls[1], {
      prompt: switchedTurnPrompt(["CODEX TAKES OVER"], withSteers("FRESH BRIEF", ["let codex finish it"])),
      resume: null,
      images: [],
      on: "codex",
    });
    q.queue.stop();
  });

  it("a Loop switch outranks a launch or a question the cut leg recorded: it is dropped, the session told so, and goes on", async () => {
    const calls: any[] = [],
      started = deferred(),
      results: DelegateResult[] = [];
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume, on: "start" });
            const launched = { studioToolCalls: [{ name: "start_autopilot", args: { goal: "old" } }] };
            return legUntilCut(q, started, stopped("s1", 2, launched));
          },
          switches: switchesFor(calls),
        }),
      );
    });
    await q.send("build the boss", { autopilot: { hours: 2 } });
    await started.promise;
    await q.send("no, until it is done", { autopilot: { hours: null } });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.equal(calls.length, 2, "the session went on");
    assert.deepEqual(results[0].studioToolCalls, [], "the launch on the old settings is dropped");
    assert.ok(String(calls[1].prompt).includes(SWITCH_NOTES.dropped(["start_autopilot"])), "and the session is told");
    q.queue.stop();
  });

  it("another engine, model or effort keeps a launch the cut leg recorded: the build starts on the message's settings", async () => {
    const calls: any[] = [],
      applied: string[] = [],
      started = deferred(),
      results: DelegateResult[] = [];
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume, on: "start" });
            const launched = { studioToolCalls: [{ name: "start_autopilot", args: { goal: "boss" } }] };
            return legUntilCut(q, started, stopped("s1", 2, launched));
          },
          switches: switchesFor(calls, applied, { autopilot: { hours: 2 } }),
        }),
      );
    });
    await q.send("build the boss", { autopilot: { hours: 2 } });
    await started.promise;
    await q.send("let codex take it", { engine: "codex", autopilot: { hours: 2 } });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.equal(calls.length, 1, "nothing ran after the launch");
    assert.deepEqual(
      results[0].studioToolCalls?.map((call) => call.name),
      ["start_autopilot"],
      "the launch goes out",
    );
    assert.deepEqual(applied, ["let codex take it"], "the turn goes out on the message's settings");
    assert.equal(calls.length, 1, "no leg runs on them: the turn has ended");
    assert.notEqual(q.state("let codex take it")?.state, "delivered", "its words wait for what comes next");
    q.queue.stop();
  });

  it("a slash command runs as a leg of its own in the same session, then the turn carries on with what came with it", async () => {
    const calls: any[] = [],
      started = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          if (calls.length === 1) return legUntilCut(q, started, stopped("s1", 3));
          return ok(`leg ${calls.length}`, "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("/review");
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(
      calls.slice(1),
      [
        { prompt: "/review", resume: "s1" },
        { prompt: afterCommandPrompt([], true), resume: "s1" },
      ],
      "the command alone, then the work it cut short carried on",
    );
    q.queue.stop();
  });

  it("a command whose leg runs no model turn (/compact) runs once, and the work it cut short carries on", async () => {
    const calls: any[] = [],
      started = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          if (calls.length === 1) return legUntilCut(q, started, stopped("s1", 3));
          // The command's own leg answers with no model turn (a third run answers with one, so a
          // command run again and again ends and the assertion below names it).
          const compacts = calls.filter((c) => c.prompt === "/compact").length;
          if (prompt === "/compact") return ok("Compacted.", "s1", { turns: compacts < 3 ? 0 : 1 });
          return ok("carried on", "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("/compact");
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(
      calls.slice(1).map((c) => c.prompt),
      ["/compact", afterCommandPrompt([], true)],
    );
    q.queue.stop();
  });

  it("a command cut off before it worked (the person wrote again at once) is sent again, then the turn carries on", async () => {
    const calls: any[] = [],
      started = deferred(),
      reviewing = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          if (calls.length === 1) return legUntilCut(q, started, stopped("s1", 3));
          // The command's first leg is cut before its session did anything.
          if (calls.length === 2) return legUntilCut(q, reviewing, stopped("s1", 0));
          return ok(`leg ${calls.length}`, "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("/review");
    await reviewing.promise;
    await q.send("and fog");
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(
      calls.slice(1).map((c) => c.prompt),
      ["/review", "/review", afterCommandPrompt(["and fog"], true)],
    );
    q.queue.stop();
  });

  it("a command sent while the turn was being prepared runs after the turn's own work, which is not carried on again", async () => {
    const calls: any[] = [],
      preparing = deferred(),
      prepared = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steer.expect();
      preparing.resolve();
      await prepared.promise;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          return ok(`leg ${calls.length}`, "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await preparing.promise;
    await q.send("/review");
    prepared.resolve();
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(calls, [
      { prompt: "PROMPT", resume: null },
      { prompt: "/review", resume: "s1" },
    ]);
    q.queue.stop();
  });

  it("Stop before a command runs gives it back: it waits for a turn of its own", async () => {
    const calls: any[] = [],
      started = deferred(),
      seen: string[] = [];
    const ctx = { cancelled: false };
    const q = cuttingQueue(async (action, steer) => {
      seen.push(action.text);
      if (action.text !== "build the boss") return;
      await steeredCall(ctx, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          if (calls.length === 1) {
            const result = await legUntilCut(q, started, stopped("s1", 3));
            ctx.cancelled = true;
            return result;
          }
          return ok("never", "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("/review");
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ["build the boss", "/review"]);
    assert.equal(calls.length, 1, "nothing ran after the Stop");
    q.queue.stop();
  });
});
