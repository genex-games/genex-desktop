/**
 * A run's inbox read from the log (`loop/run-inbox.ts`): what a session hands over and whether the
 * user asked to wrap up come from the run's durable events, so a resumed session neither hands a
 * steer over again nor honours a wrap-up asked of an earlier session. Fake `ctx`, no host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wait } from "../../src/harness-seed/loop/director/tools.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { createRunInbox } from "../../src/harness-seed/loop/run-inbox.ts";
import type { AnyRecord, HarnessEvent } from "../../src/harness-seed/types/harness.d.ts";

const RUN = "r";
const THREAD = "t";

const custom = (event_type: string, payload: AnyRecord): AnyRecord => ({ type: "custom", event_type, payload });
const steer = (text: string, facetId?: string) =>
  custom("run_steering", { runId: RUN, text, ...(facetId ? { facetId } : {}) });

/** A run's thread: `events.list` answers after the cursor it is given, `events.append` adds with new ids. */
function fakeLog(initial: AnyRecord[]) {
  const events: HarnessEvent[] = [];
  const append = (...batch: AnyRecord[]) => {
    for (const data of batch) events.push({ id: String(events.length + 1).padStart(6, "0"), data } as HarnessEvent);
  };
  append(...initial);
  const ctx = {
    cancelled: false,
    call: async (method: string, p: AnyRecord) => {
      if (method === HostMethod.EventsAppend) return append(...p.batch);
      if (method !== HostMethod.EventsList) throw new Error(`unexpected ${method}`);
      return p.after ? events.slice(events.findIndex((e) => e.id === p.after) + 1) : [...events];
    },
  };
  /** The texts handed over in the records from `from` on, with where they went. */
  const deliveredSince = (from: number) =>
    events
      .slice(from)
      .filter((e) => e.data?.event_type === "run_steering_delivered")
      .map((e) => `${e.data.payload.text}→${e.data.payload.facetId}`);
  return { events, append, ctx, deliveredSince };
}

describe("a run's inbox, read from the log", () => {
  it("a resumed session hands over only what no earlier session did, and forgets an earlier wrap-up", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("A"), steer("B", "boss")]);
    const first = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await first.steering(undefined), ["A"]);
    assert.deepEqual(await first.addressed(), [{ facetId: "boss", text: "B" }]);
    assert.deepEqual(log.deliveredSince(0), ["A→build", "B→boss"]);

    // Wrapped up, paused, and resumed with a new instruction (`resume_run`).
    log.append(
      custom("run_control", { runId: RUN, action: "finish" }),
      custom("autopilot_paused", { runId: RUN }),
      steer("C"),
      custom("run_registered", { runId: RUN, resumed: true }),
    );
    const resumedAt = log.events.length;
    const second = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.equal(await second.finishing(), false, "the wrap-up was asked of the session before the resume");
    assert.deepEqual(await second.backlog(), ["C"], "only C is still unread");
    assert.deepEqual(await second.addressed(), [], "B already reached its worker");
    assert.deepEqual(log.deliveredSince(resumedAt), []);
    // The cumulative answer facet briefs and the gauntlet read stays as it was…
    assert.deepEqual(await second.steering(undefined), ["A", "C"]);
    // …but only C is recorded as handed over now.
    assert.deepEqual(log.deliveredSince(resumedAt), ["C→build"]);

    log.append(custom("run_control", { runId: RUN, action: "finish" }));
    assert.equal(await second.finishing(), true, "a wrap-up asked of this session counts");
  });

  it("a steer is handed over once when only new ones are asked for", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("A")]);
    const inbox = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await inbox.steering(undefined, true, { onlyNew: true }), ["A"]);
    assert.deepEqual(await inbox.steering(undefined, true, { onlyNew: true }), []);
    log.append(steer("D"));
    assert.deepEqual(await inbox.steering(undefined, true, { onlyNew: true }), ["D"]);
    assert.deepEqual(log.deliveredSince(0), ["A→build", "D→build"]);
  });

  it("after a Resume, the new inbox tells an earlier session's steer once more but hands it over no second time", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("A")]);
    const first = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await first.steering(undefined, true, { onlyNew: true }), ["A"]);

    log.append(custom("autopilot_paused", { runId: RUN }), custom("run_registered", { runId: RUN, resumed: true }));
    const resumedAt = log.events.length;
    // The resumed run's director may be a fresh session that never heard A.
    const second = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await second.steering(undefined, true, { onlyNew: true }), ["A"]);
    assert.deepEqual(await second.steering(undefined, true, { onlyNew: true }), [], "once per inbox");
    assert.deepEqual(log.deliveredSince(resumedAt), [], "the first session already handed A over");
  });

  it("the lead's wait says USER SAYS once per steer", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("make the sky red")]);
    const lead = waitingLead(log);
    await wait(lead.loopRun as never, { seconds: 5 });
    await wait(lead.loopRun as never, { seconds: 5 });
    assert.deepEqual(lead.userSays(), ["USER SAYS: make the sky red"]);
  });

  it("a lead that restarts in a fresh session after a Resume still hears the user's earlier instruction", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("make the sky red")]);
    await wait(waitingLead(log).loopRun as never, { seconds: 5 });

    log.append(custom("autopilot_paused", { runId: RUN }), custom("run_registered", { runId: RUN, resumed: true }));
    // The resumed run could not resume the old session: its brief names no instruction.
    const resumed = waitingLead(log);
    await wait(resumed.loopRun as never, { seconds: 5 });
    await wait(resumed.loopRun as never, { seconds: 5 });
    assert.deepEqual(resumed.userSays(), ["USER SAYS: make the sky red"]);
  });
});

/** A run whose lead only waits, on its own inbox; every wait wakes on its first pass. */
function waitingLead(log: ReturnType<typeof fakeLog>) {
  const notes: Array<{ at: number; seq: number; text: string }> = [];
  const note = (text: string) => notes.push({ at: Date.now(), seq: notes.length + 1, text });
  const hour = Date.now() + 60 * 60 * 1000;
  const loopRun = {
    ctx: log.ctx,
    inbox: createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN }),
    note,
    notesSince: (seq: number) => notes.filter((entry) => entry.seq > seq),
    // Something always happened, so a wait never sleeps.
    routeUserSteers: async () => note("tick"),
    ledgerLines: () => [],
    softDeadline: hour,
    finalDeadline: hour,
    waitSeq: 0,
    state: { integrationHead: null, integrationHealthy: null, ledger: [], workers: new Map() },
  };
  const userSays = () => notes.filter((entry) => entry.text.startsWith("USER SAYS:")).map((entry) => entry.text);
  return { loopRun, userSays };
}
