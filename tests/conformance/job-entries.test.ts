/**
 * Background work in the chat: one line per job that says what runs and how it ended, in plain
 * words, with Stop while it runs. A missing macOS permission is one line offering Open Privacy
 * settings for each pane it needs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { runningLine } from "../../src/renderer/chat/job-lines.ts";
import type { ToolChipRow } from "../../src/renderer/ui/ToolChips.tsx";
import { jobRunningLine, openPaneSettings, privacySettingsTitle, TRANSCRIPT_WORDS } from "../../src/renderer/words.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { JobTool } from "../../src/shared/jobs.ts";

const JOB_ID = "0f3c9a52-7d41-4c1e-9b8e-2a6f1d0c4b17";
const COMMAND = "UnrealBuildTool -Mode=Build ValleyEditor Mac Development";
const STARTED_AT = "2026-01-01T12:00:00.000Z";
const ENDED_AT = "2026-01-01T12:04:00.000Z";
/** Words the person never reads on a job's line. */
const INTERNAL_WORDS = /isolation|seat|lock|sandbox|\bbox\b|scope/i;

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, eventType: string, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: eventType, payload });
const started = (id: number, payload: Record<string, unknown> = {}) =>
  custom(id, "job_started", {
    jobId: JOB_ID,
    project: "valley",
    title: "Unreal build",
    command: COMMAND,
    cwd: ".",
    startedAt: STARTED_AT,
    role: "chat",
    deadlineAt: "2026-01-01T14:00:00.000Z",
    ...payload,
  });
const ended = (id: number, payload: Record<string, unknown> = {}) =>
  custom(id, "job_ended", {
    jobId: JOB_ID,
    project: "valley",
    title: "Unreal build",
    state: "succeeded",
    exitCode: 0,
    signal: null,
    endedAt: ENDED_AT,
    durationMs: 4 * MINUTE_MS,
    tail: `${COMMAND}\nscope sandbox seat lock`,
    ...payload,
  });
const access = (id: number, missing: unknown) => custom(id, "app_look_access", { project: "valley", missing });

type ActionEntry = Extract<ReturnType<typeof toEntries>[number], { kind: typeof EntryKind.Action }>;
const linesOf = (events: EventEnvelope[], action: EntryAction): ActionEntry[] =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.Action && entry.action === action ? [entry] : []));
const jobLines = (events: EventEnvelope[]) => linesOf(events, EntryAction.Job);
/** Every tool row the chat draws, wherever it sits. */
const toolRows = (events: EventEnvelope[]): ToolChipRow[] =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.Tools ? entry.rows : []));

describe("background work in the chat", () => {
  it("a started job is one line with Stop, and its end rewrites that line with the outcome", () => {
    const [running] = jobLines([started(1)]);
    assert.equal(running?.text, "In the background: Unreal build");
    assert.deepEqual(running?.job, { project: "valley", jobId: JOB_ID, startedAt: STARTED_AT });
    assert.equal(jobRunningLine(running.text, 4), "In the background: Unreal build · 4 min");
    const after = jobLines([started(1), ended(2)]);
    assert.equal(after.length, 1, "the end rewrites the line, it adds none");
    assert.equal(after[0]?.text, "In the background: Unreal build · finished · 4 min");
    assert.equal(after[0]?.job, undefined, "no Stop once it ended");
  });

  it("a job's end rewrites its own line and leaves another job's line running", () => {
    const [jobA, jobB, jobC] = ["job-a", "job-b", "job-c"];
    const lines = jobLines([
      started(1, { jobId: jobA, title: "Unreal build" }),
      started(2, { jobId: jobB, title: "Asset bake" }),
      ended(3, { jobId: jobA, title: "Unreal build" }),
      ended(4, { jobId: jobC, title: "Shader compile", state: "failed" }),
    ]);
    assert.deepEqual(
      lines.map((line) => [line.text, line.job?.jobId]),
      [
        ["In the background: Unreal build · finished · 4 min", undefined],
        ["In the background: Asset bake", jobB],
        ["In the background: Shader compile · failed · 4 min", undefined],
      ],
    );
  });

  it("a running line counts the minutes since its start, from the time it is given", () => {
    const [running] = jobLines([started(1)]);
    const start = Date.parse(STARTED_AT);
    assert.equal(runningLine(running, start + 4 * MINUTE_MS), "In the background: Unreal build · 4 min");
    assert.equal(runningLine(running, start + 20 * SECOND_MS), "In the background: Unreal build · just started");
    assert.equal(
      runningLine(running, start - 5 * MINUTE_MS),
      "In the background: Unreal build · just started",
      "a clock behind the start never reads as negative minutes",
    );
    for (const startedAt of ["", "not a date"]) {
      const [line] = jobLines([started(1, { startedAt })]);
      assert.equal(runningLine(line, start + 4 * MINUTE_MS), "In the background: Unreal build", startedAt);
    }
    const [done] = jobLines([started(1), ended(2)]);
    assert.equal(runningLine(done, start + 9 * MINUTE_MS), "In the background: Unreal build · finished · 4 min");
  });

  it("each way a job ends reads as its own plain words", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: "succeeded" }, "finished · 4 min"],
      [{ state: "failed", exitCode: 2 }, "failed · 4 min"],
      [{ state: "stopped", stoppedBy: "person" }, "stopped"],
      [{ state: "stopped", stoppedBy: "agent" }, "stopped"],
      [{ state: "timed_out" }, "stopped at its time limit"],
      [{ state: "stopped", stoppedBy: "quit" }, "stopped when Genex closed"],
      [{ state: "interrupted" }, "stopped when Genex closed"],
      [{ state: "stopped", stoppedBy: "scope_ended" }, "stopped when its work ended"],
      [{ state: "succeeded", durationMs: 65 * MINUTE_MS }, "finished · 1 h 5 min"],
      [{ state: "succeeded", durationMs: 5_000 }, "finished · under a minute"],
    ];
    for (const [payload, status] of cases) {
      const [line] = jobLines([started(1), ended(2, payload)]);
      assert.equal(line?.text, `In the background: Unreal build · ${status}`, JSON.stringify(payload));
    }
  });

  it("a line names the worker that started it and never an internal word", () => {
    const worker = { role: "worker", worker: { id: "w-3f2a", title: "Scene builder" }, runId: "run_9x" };
    const [running] = jobLines([started(1, worker)]);
    assert.equal(running?.text, "In the background: Unreal build · Scene builder");
    assert.equal(jobRunningLine(running.text, 4), "In the background: Unreal build · Scene builder · 4 min");
    const outcomes = ["succeeded", "failed", "stopped", "timed_out", "interrupted"].flatMap((state) =>
      jobLines([started(1, worker), ended(2, { state, worker: worker.worker })]),
    );
    const words = [
      running.text,
      jobRunningLine(running.text, 4),
      ...outcomes.map((line) => line.text),
      TRANSCRIPT_WORDS.jobStop,
      TRANSCRIPT_WORDS.jobStopTitle,
    ];
    for (const text of words) {
      assert.ok(!text.includes(JOB_ID) && !text.includes("w-3f2a") && !text.includes("run_9x"), `no id: ${text}`);
      assert.ok(!text.includes("UnrealBuildTool") && !text.includes(COMMAND), `no command: ${text}`);
      assert.doesNotMatch(text, INTERNAL_WORDS, text);
    }
  });

  it("an end without a title or worker is named as its start was", () => {
    const worker = { role: "worker", worker: { id: "w1", title: "Scene builder" } };
    const [named] = jobLines([started(1, worker), ended(2)]);
    assert.equal(named?.text, "In the background: Unreal build · Scene builder · finished · 4 min");
    for (const title of [undefined, ""]) {
      const [line] = jobLines([started(1, worker), ended(2, { title, worker: { id: "w1", title: "Other" } })]);
      assert.equal(line?.text, "In the background: Unreal build · Other · finished · 4 min", String(title));
    }
  });

  it("a job's end recorded twice still reads as one line", () => {
    const lines = jobLines([started(1), ended(2), ended(3, { state: "interrupted" })]);
    assert.deepEqual(
      lines.map((line) => line.text),
      ["In the background: Unreal build · finished · 4 min"],
    );
    const unseen = jobLines([ended(2), ended(3)]);
    assert.equal(unseen.length, 1, "an end without its start on the page, recorded twice, is one line too");
  });

  it("a job tool's row names the job by its title, never its command or id", () => {
    for (const name of [JobTool.Start, `mcp__studio__${JobTool.Start}`]) {
      const rows = toolRows([
        event(1, {
          type: "tool_requested",
          tool_call_id: "call-1",
          request: { name, arguments: { title: "Unreal build", command: COMMAND } },
        }),
        event(2, {
          type: "tool_result",
          tool_call_id: "call-1",
          result: { ok: true, content: `Job ${JOB_ID} (Unreal build) started` },
        }),
      ]);
      assert.equal(rows.length, 1, name);
      const [row] = rows;
      assert.equal(row?.chip, "Unreal build", name);
      for (const text of [row?.label ?? "", row?.chip ?? ""]) {
        assert.ok(!text.includes("UnrealBuildTool") && !text.includes(JOB_ID), `${name}: ${text}`);
      }
    }
    const [untitled] = toolRows([
      event(1, {
        type: "tool_requested",
        tool_call_id: "call-2",
        request: { name: JobTool.Start, arguments: { command: COMMAND } },
      }),
    ]);
    assert.equal(untitled?.chip, undefined, "no title, no chip: never the command");
  });

  it("a chat engine's mirrored job start names the job by its title, never its command", () => {
    const mirrored = (id: number, callId: string, input: Record<string, unknown>) =>
      custom(id, "delegated.claude-code", {
        kind: "assistant",
        role: "planner",
        delegationId: "d1",
        data: { parts: [{ type: "tool_use", id: callId, name: `mcp__studio__${JobTool.Start}`, input }] },
      });
    const [titled, untitled] = toolRows([
      mirrored(1, "call-1", { title: "Unreal build", command: COMMAND }),
      mirrored(2, "call-2", { command: COMMAND }),
    ]);
    assert.equal(titled?.chip, "Unreal build");
    for (const text of [titled?.label ?? "", titled?.chip ?? "", untitled?.label ?? ""])
      assert.ok(!text.includes("UnrealBuildTool"), text);
    assert.equal(untitled?.chip, undefined, "no title, no chip: never the command");
  });

  it("a tool named like an object's own member is an ordinary row", () => {
    const names = [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "mcp__foo__constructor",
      "mcp__foo____proto__",
    ];
    for (const [index, name] of names.entries()) {
      const requested = event(index + 1, {
        type: "tool_requested",
        tool_call_id: `call-${index}`,
        request: { name, arguments: { path: "src/game.ts" } },
      });
      const mirrored = custom(index + 100, "delegated.claude-code", {
        kind: "assistant",
        role: "planner",
        delegationId: "d1",
        data: { parts: [{ type: "tool_use", id: `use-${index}`, name, input: { path: "src/game.ts" } }] },
      });
      const rows = toolRows([requested, mirrored]);
      assert.deepEqual(
        rows.map((row) => row.chip),
        ["src/game.ts", "src/game.ts"],
        name,
      );
    }
  });

  it("an end whose start is not on this page is a line of its own, naming its worker", () => {
    const [line] = jobLines([ended(5, { state: "failed", worker: { id: "w1", title: "Scene builder" } })]);
    assert.equal(line?.text, "In the background: Unreal build · Scene builder · failed · 4 min");
    assert.equal(line?.job, undefined, "an ended job offers no Stop");
  });

  it("a missing permission is one line offering Open Privacy settings for each pane", () => {
    const [screen] = linesOf([access(1, ["screen"])], EntryAction.AppAccess);
    assert.equal(screen?.text, "Genex can't see app windows yet: allow Screen Recording for Genex in System Settings.");
    assert.deepEqual(screen?.appAccess, ["screen"]);
    const [both] = linesOf([access(1, ["screen", "accessibility"])], EntryAction.AppAccess);
    assert.equal(
      both?.text,
      "Genex can't see app windows yet: allow Screen Recording and Accessibility for Genex in System Settings.",
    );
    assert.deepEqual(both?.appAccess, ["screen", "accessibility"]);
    assert.equal(TRANSCRIPT_WORDS.openPrivacySettings, "Open Privacy settings");
    assert.equal(openPaneSettings("accessibility"), "Open Accessibility settings", "two buttons say which is which");
    assert.equal(
      privacySettingsTitle("screen"),
      "Opens System Settings → Privacy & Security → Screen Recording",
      "not Genex's own Settings → Privacy",
    );
  });

  it("reads an old or partial payload without throwing", () => {
    const partial = [
      custom(1, "job_started", {}),
      custom(2, "job_ended", {}),
      custom(3, "job_started", { title: 7, jobId: null }),
      custom(4, "job_ended", { jobId: "other", title: "Bake", state: "melted" }),
      access(5, "screen"),
      access(6, ["camera"]),
      access(7, []),
    ];
    const entries = toEntries(partial);
    const jobs = entries.flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Job ? [entry.text] : [],
    );
    assert.deepEqual(jobs, ["In the background: Bake · ended"], "a line with a title reads plainly; none without");
    assert.equal(linesOf(partial, EntryAction.AppAccess).length, 0, "no line without a known pane");
    const [noStop] = jobLines([started(1, { project: undefined })]);
    assert.equal(noStop?.text, "In the background: Unreal build");
    assert.equal(noStop?.job, undefined, "no Stop without the game it belongs to");
  });
});
