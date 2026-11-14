import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationEntries, activitySummary } from "../../src/renderer/chat/conversation-entries.ts";
import { buildCaption, currentWorkLabel } from "../../src/renderer/chat/current-work.ts";

test("one activity trail preserves chronology without swallowing replies, failures, approvals or assets", () => {
  const rows = conversationEntries([
    { kind: "activity", id: "a", rows: [{ text: "Read the brief" }] },
    { kind: "tools", id: "b", rows: [{ key: "read", icon: "read", label: "Read a file", state: "failed" }] },
    { kind: "thinking", id: "c", text: "A supplied reasoning summary" },
    { kind: "assistant", id: "d", text: "The optional texture is missing." },
    { kind: "system", id: "e", tag: "ERROR", text: "Cannot save" },
    { kind: "action", id: "f", tag: "ASK", action: "consent", text: "Allow access?", pending: true },
    { kind: "assets", id: "g", delivery: { project: "game", source: "Images", jobId: "cover", at: "now", files: [] } },
    { kind: "tools", id: "h", rows: [{ key: "build", icon: "run", label: "Run build", state: "unknown" }] },
    { kind: "user", id: "i", text: "Try again" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["work", "assistant", "system", "action", "assets", "work", "user"],
  );
  assert.equal(rows[0]!.kind, "work");
  if (rows[0]!.kind === "work") {
    assert.deepEqual(
      rows[0]!.items.map((item) => item.kind),
      ["note", "tool", "thought"],
    );
    const item = rows[0]!.items[1]!;
    assert.equal(item.kind, "tool");
    if (item.kind === "tool") assert.equal(item.tool.state, "failed");
  }
});

test("history without a tool result never becomes a running or successful tool", () => {
  assert.equal(
    activitySummary([
      {
        kind: "tool",
        id: "a",
        tool: { key: "a", icon: "run", label: "Run build", activeLabel: "Building", state: "unknown" },
      },
    ]),
    "Worked on 1 step",
  );
  assert.equal(
    activitySummary([
      {
        kind: "tool",
        id: "a",
        tool: { key: "a", icon: "run", label: "Run build", activeLabel: "Building", state: "running" },
      },
    ]),
    "Building",
  );
});

test("explicit reply and tool phases win over the background build status", () => {
  const run = { tasks: [{ title: "Wooden bridge", state: "running" }] } as Parameters<typeof currentWorkLabel>[1];
  assert.equal(currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, false), "Wooden bridge");
  assert.equal(currentWorkLabel({ phase: "responding", label: "Writing a reply" }, run, false), "Writing a reply");
  assert.equal(currentWorkLabel({ phase: "tool", label: "Creating an image" }, run, false), "Creating an image");
  assert.equal(
    currentWorkLabel({ phase: "waiting", label: "Waiting for your answer" }, run, false),
    "Waiting for your answer",
  );
  assert.equal(currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, true), "Finishing up");
});

test("current tools change the live heading without masking decisions or replies", () => {
  const tool = (label: string, state: "running" | "succeeded") => [
    { kind: "tool" as const, id: "1", tool: { key: "1", icon: "read" as const, label, activeLabel: label, state } },
  ];
  const run = { tasks: [{ title: "Wooden bridge", state: "running" }] } as Parameters<typeof currentWorkLabel>[1];
  assert.equal(
    currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, false, tool("Reading", "running")),
    "Reading the code",
  );
  assert.equal(
    currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, false, tool("Editing", "running")),
    "Editing the game",
  );
  assert.equal(
    currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, false, tool("Reading", "succeeded")),
    "Wooden bridge",
  );
  assert.equal(
    currentWorkLabel({ phase: "waiting", label: "Waiting for your answer" }, run, false, tool("Reading", "running")),
    "Waiting for your answer",
  );
  assert.equal(
    currentWorkLabel({ phase: "tool", label: "Generating the sky" }, run, false, tool("Reading", "running")),
    "Generating the sky",
  );
});

test("plan generation names the phase and starting yields to actual build activity", () => {
  assert.equal(
    currentWorkLabel({ phase: "working", label: "Working" }, null, false, [], "generating"),
    "Preparing your plan",
  );
  assert.equal(currentWorkLabel({ phase: "idle", label: "Idle" }, null, false, [], "starting"), "Starting your build");
  const run = { tasks: [{ title: "Wooden bridge", state: "running" }] } as Parameters<typeof currentWorkLabel>[1];
  assert.equal(currentWorkLabel({ phase: "thinking", label: "Thinking" }, run, false, [], "starting"), "Wooden bridge");
  assert.equal(
    currentWorkLabel({ phase: "responding", label: "Writing a reply" }, null, false, [], "starting"),
    "Writing a reply",
  );
});

test("the build card says one thing at a time: the part at work, else what the lead is doing", () => {
  type Run = Parameters<typeof buildCaption>[1];
  const one = {
    tasks: [
      { title: "Seyda Neen villagers", state: "running" },
      { title: "Gnarled mossy trees", state: "done" },
    ],
  } as Run;
  const two = {
    tasks: [
      { title: "Seyda Neen villagers", state: "running" },
      { title: "Signposts", state: "running" },
    ],
  } as Run;
  const none = { tasks: [{ title: "Gnarled mossy trees", state: "done" }] } as Run;
  assert.equal(buildCaption({ phase: "tool", label: "Running a tool" }, one, false), "Seyda Neen villagers · working");
  assert.equal(
    buildCaption({ phase: "thinking", label: "Thinking" }, two, false),
    "Seyda Neen villagers and 1 more · working",
  );
  assert.equal(buildCaption({ phase: "thinking", label: "Thinking" }, none, false), "Planning the next step");
  assert.equal(
    buildCaption({ phase: "tool", label: "Running a tool" }, none, false),
    "Working on the build",
    'never the bare "Running a tool"',
  );
  assert.equal(buildCaption({ phase: "tool", label: "Generating the sky" }, none, false), "Generating the sky");
  assert.equal(buildCaption({ phase: "thinking", label: "Thinking" }, one, true), "Finishing up");
});

test("between parts, and on a tool with no name, the build card says what the lead last said in its own words", () => {
  type Run = Parameters<typeof buildCaption>[1];
  const said = {
    tasks: [{ title: "Gnarled mossy trees", state: "done" }],
    lead: {
      plan: null,
      said: [
        { at: "t1", text: "Рисую три места." },
        { at: "t2", text: "Код игры написан." },
      ],
    },
  } as Run;
  assert.equal(buildCaption({ phase: "thinking", label: "Thinking" }, said, false), "Код игры написан.");
  assert.equal(buildCaption({ phase: "tool", label: "Running a tool" }, said, false), "Код игры написан.");
  assert.equal(buildCaption({ phase: "tool", label: "Generating the sky" }, said, false), "Generating the sky");
});
