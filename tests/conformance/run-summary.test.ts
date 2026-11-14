import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildVersion,
  inGameVersion,
  RunSummaryAccumulator,
  summarizeRun,
  summaryOutcome,
  type OutcomeView,
  type RunSummary,
} from "../../src/shared/run-summary.ts";
import { outcomeTitle } from "../../src/renderer/words.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
const events: EventEnvelope[] = JSON.parse(
  readFileSync(new URL("../fixtures/village-outcome.json", import.meta.url), "utf8"),
);
const summarize = (input = events) => summarizeRun(input, "fixture-village", "run_village");
test("village: six integrations, four evaluated attempts, closing delivery retains failed visual evidence", () => {
  const s = summarize();
  assert.equal(s.counts.integrations, 6);
  assert.equal(s.counts.accepted, 3);
  assert.equal(s.counts.rejected, 1);
  assert.equal(s.landed, true);
  assert.match(outcomeTitle(summaryOutcome(s)), /Checks need attention/);
  assert.equal(
    s.evidence.filter((e) => e.head === s.head && e.category === "structural" && e.status === "passed").length,
    4,
  );
  assert.equal(
    s.evidence.filter((e) => e.head === s.head && e.category === "visual" && e.status === "failed").length,
    1,
  );
  assert.ok(s.tasks.some((t) => t.integrations > 0 && t.attempts.some((a) => a.state === "stopped")));
  assert.ok(s.tasks.some((t) => t.workers.includes("camera-follow-fix2") && t.workers.includes("camera-follow-fix")));
  assert.ok(s.counts.completedUnevaluated > 0);
});
test("replay, duplicate transport and shuffled input do not change counts", () => {
  assert.deepEqual(summarize([...events, ...events].reverse()), summarize());
});
test("partial history stays explicit and other projects do not contaminate results", () => {
  assert.equal(
    summarize(events.filter((e) => e.data.type !== "custom" || e.data.event_type !== "run_started")).completeHistory,
    false,
  );
  const foreign = events.map((e) => ({
    ...e,
    id: "foreign-" + e.id,
    data: {
      ...e.data,
      ...(e.data.type === "custom" ? { payload: { ...(e.data.payload as object), project: "another" } } : {}),
    },
  }));
  assert.deepEqual(summarize([...events, ...foreign]), summarize());
});
test("new revision does not inherit passing or failing evidence from old head", () => {
  const tail: EventEnvelope = {
    ...events.at(-1)!,
    id: "new",
    created_at: "2026-09-18T00:00:00Z",
    data: {
      type: "custom",
      event_type: "integration_merge",
      payload: {
        runId: "run_village",
        head: "new-head",
        facetId: "camera-follow-fix2",
        conflict: false,
      },
    },
  };
  assert.equal(
    outcomeTitle(summaryOutcome(summarize([...events, tail]))),
    "Run finished · Newer integrated build not delivered",
  );
});
function extra(type: string, payload: Record<string, unknown>, index = 0): EventEnvelope {
  return {
    id: `extra-${index}`,
    thread_id: "fixture-thread",
    session_id: null,
    turn_id: null,
    created_at: `2026-09-19T00:00:${String(index).padStart(2, "0")}Z`,
    data: {
      type: "custom",
      event_type: type,
      payload: { runId: "run_village", project: "fixture-village", ...payload },
    },
  };
}
test("no-op, duplicate operation and conflicting merges are not integrations", () => {
  const head = summarize().head;
  const s = summarize([
    ...events,
    extra("integration_merge", { head, conflict: false }),
    extra("integration_merge", { head: "bad", conflict: true }, 1),
    extra("integration_merge", { head: "noop", previousHead: "noop", conflict: false }, 2),
  ]);
  assert.equal(s.counts.integrations, 6);
});
test("learning has no effect on completed execution or delivery", () => {
  const s = summarize([...events, extra("run_learning", { state: "running" })]);
  assert.equal(s.execution, "completed");
  assert.equal(s.learning, "running");
  assert.equal(s.landed, true);
  const failed = summarize([...events, extra("run_learning", { state: "failed" })]);
  assert.equal(failed.execution, "completed");
  assert.equal(failed.learning, "failed");
});
test("incomplete playtest stays separate from structural passes", () => {
  const head = summarize().head;
  const s = summarize([
    ...events,
    extra("run_interaction_evidence", {
      head,
      status: "incomplete",
      label: "Open and advance dialogue",
      source: "independent-playtester",
    }),
  ]);
  assert.equal(s.evidence.find((e) => e.category === "interaction")?.status, "incomplete");
  assert.equal(
    s.evidence.filter((e) => e.head === head && e.category === "structural" && e.status === "passed").length,
    4,
  );
});
test("a judge that played keeps what its result rests on and where its trace is; a forged objective is dropped", () => {
  const head = summarize().head;
  const s = summarize([
    ...events,
    extra("run_interaction_evidence", {
      head,
      status: "passed",
      label: "Reach the race",
      source: "hands-on-judge",
      objective: "studio-verified",
      trace: "/runs/r/facet_integration/playtest/iter_001/trace.jsonl",
    }),
    extra("run_interaction_evidence", {
      head,
      status: "passed",
      label: "Feels fast",
      source: "hands-on-judge",
      objective: "trust me",
      trace: 7,
    }),
  ]);
  const [verified, forged] = s.evidence.filter((e) => e.category === "interaction");
  assert.equal(verified?.objective, "studio-verified");
  assert.match(String(verified?.trace), /trace\.jsonl$/);
  assert.equal(forged?.objective, undefined);
  assert.equal(forged?.trace, undefined);
});
test("unknown stop reason, explicit failed and superseded states retain their meaning", () => {
  const s = summarize([
    extra("run_started", {}),
    extra("director_worker", { workerId: "a", state: "stopped", mode: "single" }, 1),
    extra("director_worker", { workerId: "b", state: "failed", mode: "single" }, 2),
    extra("director_worker", { workerId: "c", state: "superseded", mode: "single" }, 3),
  ]);
  assert.equal(s.counts.stopped, 1);
  assert.equal(s.counts.failed, 1);
  assert.equal(s.counts.superseded, 1);
  assert.equal(s.tasks[0]?.reason, null);
});
test("replacement identifiers are explicit; equal titles alone never combine tasks", () => {
  const s = summarize([
    extra("director_worker", {
      workerId: "a",
      title: "Same",
      mode: "single",
      state: "done",
    }),
    extra("director_worker", { workerId: "b", title: "Same", mode: "single", state: "done" }, 1),
  ]);
  assert.equal(s.tasks.length, 2);
});
test("failed and cancelled execution remain distinct from delivered work", () => {
  for (const state of ["failed", "cancelled"]) {
    const s = summarize([
      ...events,
      extra("run_finished", {
        executionStatus: state,
        landed: false,
        integrationHead: "retained-head",
      }),
    ]);
    assert.equal(s.execution, state);
    assert.match(outcomeTitle(summaryOutcome(s)), new RegExp(`Run ${state}`));
    assert.equal(s.counts.integrations, 6);
  }
});

test("landing records its source separately from the resulting project commit", () => {
  const s = summarize([
    ...events,
    extra("run_finished", { landed: true, integrationHead: "judged", deliveredHead: "project-merge" }),
  ]);
  assert.equal(s.head, "judged");
  assert.equal(s.deliveredSourceHead, "judged");
  assert.equal(s.deliveredHead, "project-merge");
  assert.equal(
    s.evidence.some((e) => e.head === "project-merge"),
    false,
    "a merge commit is not independently judged",
  );
});

test("distinct changes back to an earlier head count, replayed operation IDs do not", () => {
  const s = summarize([
    extra("run_started", {}),
    extra("autopilot_base", { commit: "base" }, 1),
    extra("integration_merge", { head: "a", previousHead: "base", operationId: "one", conflict: false }, 2),
    extra("integration_merge", { head: "base", previousHead: "a", operationId: "two", conflict: false }, 3),
    extra("integration_merge", { head: "a", previousHead: "base", operationId: "three", conflict: false }, 4),
    extra("integration_merge", { head: "base", previousHead: "a", operationId: "two", conflict: false }, 5),
  ]);
  assert.equal(s.counts.integrations, 3);
  assert.equal(s.head, "a");
});

test("an unanswered same-revision recheck does not resolve a failed observation", () => {
  const s = summarize([
    extra("run_visual_evidence", { head: "a", question: "Is the sign visible?", answer: false }),
    extra("run_visual_evidence", { head: "a", question: "Is the sign visible?", answer: null }, 1),
  ]);
  assert.equal(s.evidence[0]?.status, "failed");
  assert.match(s.evidence[0]?.note ?? "", /Later recheck unknown/);
});
test("comparative preference is not a requirement failure", () => {
  const s = summarize([
    extra("director_verdict", { build: { head: "a" }, seen: { pick: "incumbent" } }),
    extra("run_finished", { landed: true, integrationHead: "a" }, 1),
  ]);
  assert.equal(s.evidence[0]?.category, "comparison");
  assert.equal(outcomeTitle(summaryOutcome(s)), "Build delivered · Verification incomplete");
});

test("final provider failure is retained instead of the generic stopped reason", () => {
  const s = summarize([
    extra(
      "run_finished",
      {
        executionStatus: "failed",
        stoppedBecause: "the run hit a problem",
        failure: { message: "request exceeds context size" },
      },
      1,
    ),
  ]);
  assert.equal(s.reason, "request exceeds context size");
  const historical = summarize([
    extra(
      "run_finished",
      {
        executionStatus: "failed",
        failure: {
          message: JSON.stringify({
            error: { code: 400, message: "request (16440 tokens) exceeds context (16384 tokens)" },
          }),
        },
      },
      1,
    ),
  ]);
  assert.equal(historical.reason, "request (16440 tokens) exceeds context (16384 tokens)");
});

test("the outcome is three fields, and every surface phrases the same three", () => {
  const base = summarize();
  const at = (patch: Partial<RunSummary>): RunSummary => ({ ...base, ...patch });
  const integrated = { head: "h2", base: "h1" };
  const cases: Array<[string, RunSummary, OutcomeView, { full: string; chat: string; card: string }]> = [
    [
      "unknown",
      at({ execution: "unknown" }),
      { state: "unknown", delivered: "none", verification: "attention" },
      { full: "Run status unavailable", chat: "Build status unavailable", card: "Build status unavailable" },
    ],
    [
      "failed with a build",
      at({ execution: "failed", ...integrated, evidence: [] }),
      { state: "failed", delivered: "available", verification: "incomplete" },
      {
        full: "Run failed · Integrated build available",
        chat: "Build failed",
        card: "Build failed · Integrated build available",
      },
    ],
    [
      "cancelled",
      at({ execution: "cancelled", head: "h1", base: "h1", evidence: [] }),
      { state: "cancelled", delivered: "none", verification: "incomplete" },
      { full: "Run cancelled", chat: "Build cancelled", card: "Build stopped" },
    ],
    [
      "running",
      at({ execution: "running", ...integrated, evidence: [] }),
      { state: "running", delivered: "available", verification: "incomplete" },
      {
        full: "Building · Earlier build available",
        chat: "Building · Earlier build available",
        card: "Building · Earlier build available",
      },
    ],
    [
      "paused",
      at({ execution: "paused", ...integrated, evidence: [] }),
      { state: "paused", delivered: "available", verification: "incomplete" },
      {
        full: "Run paused · Integrated build available",
        chat: "Build paused",
        card: "Build paused · Integrated build available",
      },
    ],
    [
      "superseded",
      at({ execution: "completed", landed: true, deliveredSourceHead: "old", head: "new" }),
      { state: "finished", delivered: "superseded", verification: "incomplete" },
      {
        full: "Run finished · Newer integrated build not delivered",
        chat: "Newer integrated build not delivered",
        card: "Newer integrated build not delivered",
      },
    ],
    [
      "delivered, checks failed",
      base,
      { state: "finished", delivered: "delivered", verification: "attention" },
      {
        full: "Build delivered · Checks need attention",
        chat: "Changes are live · Checks need attention",
        card: "Changes are live · Checks need attention",
      },
    ],
    [
      "delivered, checks incomplete",
      at({ evidence: [] }),
      { state: "finished", delivered: "delivered", verification: "incomplete" },
      {
        full: "Build delivered · Verification incomplete",
        chat: "Changes are live",
        card: "Changes are live · Checks incomplete",
      },
    ],
    [
      "nothing delivered",
      at({ landed: false, evidence: [] }),
      { state: "finished", delivered: "none", verification: "incomplete" },
      { full: "Run finished · No build delivered", chat: "No new build", card: "No new build" },
    ],
  ];
  for (const [name, summary, view, words] of cases) {
    assert.deepEqual(summaryOutcome(summary), view, name);
    assert.deepEqual(
      { full: outcomeTitle(view), chat: outcomeTitle(view, "chat"), card: outcomeTitle(view, "card") },
      words,
      name,
    );
  }
});

test("incremental summaries match the full fold after every append without recounting reads", () => {
  const accumulator = new RunSummaryAccumulator("fixture-village", "run_village");
  const ordered = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (let at = 0; at < ordered.length; at++) {
    const event = ordered[at];
    if (!event) continue;
    accumulator.append(event);
    const expected = summarize(ordered.slice(0, at + 1));
    assert.deepEqual(accumulator.summary(), expected);
    assert.deepEqual(accumulator.summary(), expected, "reading twice cannot count attempts twice");
  }
});

/** A run's own record, as the log keeps it. */
function runEvent(id: string, at: string, eventType: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    id,
    created_at: at,
    data: { type: "custom", event_type: eventType, payload: { runId: "run_village", ...payload } },
  };
}

/** The lead's own words in the log: a delegated builder's assistant text. */
function leadSaid(id: string, at: string, text: string, extra: Record<string, unknown> = {}): EventEnvelope {
  return runEvent(id, at, "delegated.claude-code", {
    kind: "assistant",
    role: "planner",
    data: { role: "assistant", parts: [{ type: "text", text }] },
    ...extra,
  });
}

test("the lead's own words and its plan are the summary's, newest last; a worker's or a reviewer's words are not the lead's", () => {
  const said = [
    runEvent("plan", "2026-09-17T10:00:00Z", "autopilot_decision", {
      decision: "dispatch: 3 workers",
      plain: "I'm painting the three places first, then the light.",
    }),
    leadSaid("a", "2026-09-17T10:01:00Z", "Рисую три места."),
    leadSaid("w", "2026-09-17T10:02:00Z", "worker chatter", { workerId: "places" }),
    leadSaid("j", "2026-09-17T10:02:30Z", "a reviewer's take", { role: "judge" }),
    leadSaid("b", "2026-09-17T10:03:00Z", "  Код игры написан.\n\nСейчас запускаю её.  "),
    leadSaid("empty", "2026-09-17T10:04:00Z", "   "),
  ];
  const lead = summarize([...events, ...said]).lead;
  assert.equal(lead?.plan, "I'm painting the three places first, then the light.");
  assert.deepEqual(lead?.said, [
    { at: "2026-09-17T10:01:00Z", text: "Рисую три места." },
    { at: "2026-09-17T10:03:00Z", text: "Код игры написан. Сейчас запускаю её." },
  ]);
});

test("the lead keeps only its latest few lines, each cut to one readable length", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    leadSaid(`l${i}`, `2026-09-17T10:${String(10 + i).padStart(2, "0")}:00Z`, `line ${i} ${"x".repeat(400)}`),
  );
  const said = summarize([...events, ...many]).lead?.said ?? [];
  assert.equal(said.length, 5);
  assert.match(said.at(-1)?.text ?? "", /^line 11 /);
  assert.ok(said.every((line) => line.text.length <= 241));
});

test("the lead's plan steps come with the run's start, a save point may name them again, and junk is dropped", () => {
  const started = runEvent("reg", "2026-09-17T09:59:00Z", "run_registered", {
    steps: ["Три места", "  Люди и звуки ", 7, "", "Код игры", "Свет и чудеса"],
  });
  assert.deepEqual(summarize([...events, started]).steps, ["Три места", "Люди и звуки", "Код игры", "Свет и чудеса"]);
  const replanned = runEvent("sp", "2026-09-17T10:30:00Z", "facet_iteration", {
    facetId: "lead",
    iteration: 1,
    label: "Три места",
    steps: ["Три места", "Код игры", "Свет"],
  });
  assert.deepEqual(summarize([...events, started, replanned]).steps, ["Три места", "Код игры", "Свет"]);
  assert.equal(summarize().steps, undefined, "a run whose lead named no plan has none");
});

test("the build's title comes with its registration, cleaned to one short line", () => {
  const registered = runEvent("reg-t", "2026-09-17T09:59:00Z", "run_registered", {
    title: ' "Три места,\n свет и чудеса" ',
  });
  assert.equal(summarize([...events, registered]).title, "Три места, свет и чудеса");
  assert.equal(summarize().title, undefined);
});

test("a build that reached the game is a version, numbered by the game's builds that did before it", () => {
  const finished = (id: string, at: string, runId: string, landed: boolean, project = "fixture-village") =>
    ({
      thread_id: "t1",
      session_id: null,
      turn_id: null,
      id,
      created_at: at,
      data: { type: "custom", event_type: "run_finished", payload: { runId, project, landed } },
    }) as EventEnvelope;
  const log = [
    finished("f1", "2026-09-17T10:00:00Z", "run_a", true),
    finished("f2", "2026-09-17T11:00:00Z", "run_b", false),
    finished("f3", "2026-09-17T12:00:00Z", "run_other_game", true, "another"),
    finished("f4", "2026-09-17T13:00:00Z", "run_c", true),
    finished("f4b", "2026-09-17T13:05:00Z", "run_c", true),
  ];
  assert.equal(buildVersion(log, "fixture-village", "run_a"), 1);
  assert.equal(
    buildVersion(log, "fixture-village", "run_c"),
    2,
    "a run that did not land and another game's are no versions",
  );
  assert.equal(buildVersion(log, "fixture-village", "run_b"), null);
  assert.equal(buildVersion(log, "fixture-village", "run_new"), null);
  const relanded = [...log, finished("f5", "2026-09-17T14:00:00Z", "run_a", true)];
  assert.equal(buildVersion(relanded, "fixture-village", "run_a"), 3, "landed again later, it is the newest version");
  assert.equal(buildVersion(relanded, "fixture-village", "run_c"), 2, "an earlier number never moves");
});

test("a finished build says its version only once it is in the game with no failed check", () => {
  const clean = {
    ...summarize(),
    execution: "completed",
    landed: true,
    profile: "open",
    evidence: [],
    version: 2,
  } as RunSummary;
  assert.equal(inGameVersion(clean), 2);
  assert.equal(inGameVersion({ ...clean, landed: false }), null);
  assert.equal(inGameVersion({ ...clean, version: undefined }), null);
});
