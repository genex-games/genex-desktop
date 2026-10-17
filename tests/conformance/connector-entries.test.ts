/**
 * A connector call reads in the chat as one row that says what happened: the host's own records
 * (`connector_tool_started`, `connector_tool`) make the row, the agent's mirror of the same call
 * is not a second one, and nothing becomes a narration line that splits the work. The row says
 * the step in words ("Wrote Blueprint BP_Lamp"), a failure is one error line with its first
 * sentence, the work's heading names the plugin it worked in, play views go up to the work's
 * strip, and a delivery sits under the work that made it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Entry, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { chatWorkState } from "../../src/renderer/chat/chat-work-state.ts";
import {
  type ActivityItem,
  activitySummary,
  conversationEntries,
  stripShots,
  WORK_KIND,
} from "../../src/renderer/chat/conversation-entries.ts";
import { currentWorkLabel } from "../../src/renderer/chat/current-work.ts";
import type { ToolChipRow } from "../../src/renderer/ui/ToolChips.tsx";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

let clock = 0;
const event = (data: EventData): EventEnvelope => {
  clock += 1;
  return {
    id: String(clock).padStart(6, "0"),
    thread_id: "game",
    turn_id: "turn",
    session_id: null,
    created_at: new Date(clock * 1000).toISOString(),
    data,
  };
};
const custom = (event_type: string, payload: unknown) => event({ type: "custom", event_type, payload });

const UNREAL = { connectorId: "unreal-editor", pluginId: "unreal", connectorName: "Unreal Editor" };
const BLUEPRINTS = "editor_toolset.toolsets.blueprint.BlueprintTools";
const APP = "EditorToolset.EditorAppToolset";
const LAMP = { graph: { refPath: "/Game/Valley/BP_Lamp.BP_Lamp:EventGraph" } };

/** One Unreal call through Epic's gateway, as the agent's mirror and the host's two records show it. */
function unrealCall(
  callId: string,
  toolset: string,
  toolName: string,
  args: Record<string, unknown>,
  end: { ok: boolean; error?: string; captures?: string[] } | null,
): EventEnvelope[] {
  const call = { ...UNREAL, callId, tool: "call_tool", exposedName: "call_tool", toolset, toolName, args };
  const mirror = custom("delegated.claude-code", {
    delegationId: "chat",
    kind: "assistant",
    role: "planner",
    data: {
      parts: [
        { type: "tool_use", id: `toolu_${callId}`, name: "mcp__studio__unreal-editor__call_tool", input: toolset },
      ],
    },
  });
  const started = custom("connector_tool_started", call);
  if (!end) return [mirror, started];
  const answered = custom("delegated.claude-code", {
    delegationId: "chat",
    kind: "user",
    data: { parts: [{ type: "tool_result", tool_use_id: `toolu_${callId}`, content: "done" }] },
  });
  return [mirror, started, answered, custom("connector_tool", { ...call, durationMs: 1200, result: "ok", ...end })];
}

const rowsOf = (entries: Entry[]): ToolChipRow[] => entries.flatMap((e) => (e.kind === EntryKind.Tools ? e.rows : []));

function onlyWork(entries: Entry[]) {
  const shown = conversationEntries(entries);
  const work = shown.filter((e) => e.kind === WORK_KIND);
  assert.equal(work.length, 1, `one work group, saw ${shown.map((e) => e.kind).join(", ")}`);
  const [group] = work;
  assert.ok(group?.kind === WORK_KIND);
  return { shown, group };
}

const toolRows = (items: ActivityItem[]): ToolChipRow[] => items.flatMap((i) => (i.kind === "tool" ? [i.tool] : []));

describe("a connector call in the chat", () => {
  it("is one row the host's records make and complete, never a narration line", () => {
    const entries = toEntries(unrealCall("c1", BLUEPRINTS, "write_graph_dsl", LAMP, { ok: true }));
    assert.equal(entries.filter((e) => e.kind === EntryKind.System || e.kind === EntryKind.Activity).length, 0);
    const rows = rowsOf(entries);
    assert.equal(rows.length, 1, "the agent's own mirror of the call is not a second row");
    assert.equal(rows[0]?.label, "Wrote Blueprint BP_Lamp");
    assert.equal(rows[0]?.state, "succeeded");
    const { group } = onlyWork(entries);
    assert.equal(activitySummary(group.items), "Worked in Unreal · 1 step");
  });

  it("names its action in the live status while it runs", () => {
    const entries = toEntries(unrealCall("c1", BLUEPRINTS, "write_graph_dsl", LAMP, null));
    const { group } = onlyWork(entries);
    assert.equal(toolRows(group.items)[0]?.state, "running");
    assert.equal(
      currentWorkLabel({ phase: "tool", label: "Running a tool" }, null, false, group.items),
      "Writing BP_Lamp in Unreal",
    );
  });

  it("says what its common tools did, and names an unknown tool by its toolset", () => {
    const calls = [
      unrealCall(
        "a",
        "editor_toolset.toolsets.scene.SceneTools",
        "add_to_scene_from_asset",
        {
          asset_path: "/Game/Valley/Meshes/Barrel",
          name: "Barrel_3",
        },
        { ok: true },
      ),
      unrealCall("b", APP, "StartPIE", { options: { bSimulate: false } }, { ok: true }),
      unrealCall("c", APP, "CaptureEditorImage", {}, { ok: true }),
      unrealCall(
        "d",
        "editor_toolset.toolsets.asset.AssetTools",
        "save_assets",
        { asset_paths: ["/a", "/b"] },
        { ok: true },
      ),
      unrealCall("e", BLUEPRINTS, "get_node_infos", {}, { ok: true }),
    ];
    const labels = rowsOf(toEntries(calls.flat())).map((row) => row.label);
    assert.deepEqual(labels, [
      "Placed Barrel_3",
      "Played the level",
      "Took a screenshot",
      "Saved 2 assets",
      "BlueprintTools · get_node_infos",
    ]);
  });

  it("fails as one error line with its first sentence; the whole text keeps its lines for the detail", () => {
    const error =
      "AssertionError: The node could not be created / Math|Vector|Normal(Vector) does not exist\n  in: (event EventTick)\n[Unreal project: Valley]";
    const entries = toEntries([
      ...unrealCall("a", BLUEPRINTS, "write_graph_dsl", LAMP, { ok: false, error }),
      ...unrealCall("b", BLUEPRINTS, "write_graph_dsl", LAMP, { ok: true }),
    ]);
    const [failed] = rowsOf(entries);
    assert.equal(failed?.failed, true);
    assert.equal(
      failed?.label,
      "Couldn't write BP_Lamp: AssertionError: The node could not be created / Math|Vector|Normal(Vector) does not exist",
    );
    assert.deepEqual(
      failed?.detail?.map((line) => line.text),
      error.split("\n"),
      "the full text, line by line, never flattened",
    );
    const { group } = onlyWork(entries);
    assert.equal(toolRows(group.items).length, 2, "a failure does not split the work");
  });

  it("clips a long first sentence to about 120 characters", () => {
    const traceback = `line 4: RuntimeError: Script error in ${BLUEPRINTS}.create:\nUnable to create asset EUA_ValleyBridge at /Game/Valley/Editor\n${"  File <script>, line 7, in run\n".repeat(40)}`;
    const [row] = rowsOf(
      toEntries(
        unrealCall("a", BLUEPRINTS, "create", { asset_name: "EUA_ValleyBridge" }, { ok: false, error: traceback }),
      ),
    );
    assert.ok(row?.label.startsWith("Couldn't make Blueprint EUA_ValleyBridge: line 4: RuntimeError:"), row?.label);
    assert.ok((row?.label.length ?? 0) <= 121, `${row?.label.length}`);
    assert.ok(row?.label.endsWith("…"));
    assert.doesNotMatch(row?.label ?? "", /\n/);
  });

  it("sends at most three play views up to the work's strip; the rest stay in their rows", () => {
    const shot = (id: string, tool: string, path: string) =>
      unrealCall(id, APP, tool, {}, { ok: true, captures: [`.studio/captures/${path}.png`] });
    const entries = toEntries([
      ...shot("rest", "CaptureEditorImage", "rest"),
      ...unrealCall("play", APP, "StartPIE", {}, { ok: true }),
      ...shot("p1", "CaptureEditorImage", "p1"),
      ...shot("p2", "CaptureEditorImage", "p2"),
      ...shot("cam", "CaptureViewport", "cam"),
      ...shot("p3", "CaptureEditorImage", "p3"),
      ...shot("p4", "CaptureEditorImage", "p4"),
      ...unrealCall("stop", APP, "StopPIE", {}, { ok: true }),
      ...shot("after", "CaptureEditorImage", "after"),
    ]);
    const { group } = onlyWork(entries);
    assert.deepEqual(stripShots(group.items), [
      ".studio/captures/p2.png",
      ".studio/captures/p3.png",
      ".studio/captures/p4.png",
    ]);
    const shots = toolRows(group.items).flatMap((row) => row.shots ?? []);
    assert.deepEqual(
      shots.filter((s) => !s.play).map((s) => s.path),
      [".studio/captures/rest.png", ".studio/captures/cam.png", ".studio/captures/after.png"],
      "the editor at rest and the editor camera are never play views",
    );
  });

  it("names every plugin a group worked in, and keeps a delivery under the group that made it", () => {
    const blender = {
      callId: "m1",
      pluginId: "blender",
      pluginName: "Local Blender",
      tool: "model",
      toolName: "blender__model",
    };
    const entries = toEntries([
      custom("plugin_tool_started", blender),
      custom("asset_delivered", {
        project: "game",
        source: "blender",
        jobId: "barrel",
        at: "now",
        workspace: "game",
        files: [{ file: "assets/blender/barrel/render.png", kind: "image", bytes: 42 }],
      }),
      custom("plugin_tool", { ...blender, ok: true }),
      ...unrealCall("u1", BLUEPRINTS, "write_graph_dsl", LAMP, { ok: true }),
    ]);
    const { shown, group } = onlyWork(entries);
    assert.deepEqual(
      shown.map((e) => e.kind),
      [WORK_KIND],
      "the delivery is not its own block",
    );
    assert.deepEqual(
      group.deliveries?.map((d) => d.jobId),
      ["barrel"],
    );
    assert.equal(activitySummary(group.items), "Worked in Blender and Unreal · 2 steps");
  });

  it("keeps work with results in the transcript while the chat works, so its pictures and files stay in view", () => {
    const entries = toEntries([
      ...unrealCall("play", APP, "StartPIE", {}, { ok: true }),
      ...unrealCall("p1", APP, "CaptureEditorImage", {}, { ok: true, captures: [".studio/captures/p1.png"] }),
      ...unrealCall("next", BLUEPRINTS, "write_graph_dsl", LAMP, null),
    ]);
    const state = chatWorkState({
      status: "",
      run: null,
      activeRunId: null,
      busy: true,
      sending: false,
      answering: false,
      working: true,
      planWorking: false,
      revisingPlan: false,
      stopping: false,
      questionsWaiting: false,
      readingEntries: conversationEntries(entries),
    });
    assert.equal(state.currentDetails, null);
    assert.equal(
      currentWorkLabel({ phase: "tool", label: "Running a tool" }, null, false, state.workItems),
      "Writing BP_Lamp in Unreal",
      "the live status still names the running step",
    );
  });

  it("reads an older record (no start, no toolset) as one row too", () => {
    const entries = toEntries([
      custom("delegated.claude-code", {
        delegationId: "chat",
        kind: "assistant",
        data: {
          parts: [{ type: "tool_use", id: "toolu_old", name: "mcp__studio__unreal-editor__call_tool", input: APP }],
        },
      }),
      custom("connector_tool", {
        connectorId: "unreal-editor",
        tool: "call_tool",
        exposedName: "call_tool",
        ok: false,
        error: "No answer",
      }),
    ]);
    assert.equal(entries.filter((e) => e.kind === EntryKind.System).length, 0);
    const rows = rowsOf(entries);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.failed, true);
  });

  it("is one row on the local harness's path as well", () => {
    const call = { connectorId: "echo", callId: "e1", tool: "echo", exposedName: "echo", args: { text: "hi" } };
    const entries = toEntries([
      event({ type: "tool_requested", tool_call_id: "t1", request: { name: "echo__echo", arguments: { text: "hi" } } }),
      custom("connector_tool_started", call),
      custom("connector_tool", { ...call, ok: true, durationMs: 3, result: "hi" }),
      event({ type: "tool_result", tool_call_id: "t1", result: { ok: true, content: "hi" } }),
    ]);
    assert.deepEqual(
      rowsOf(entries).map((row) => row.key),
      ["e1"],
      "the host's record is the row; the session's own request is not a second one",
    );
    assert.equal(entries.filter((e) => e.kind === EntryKind.System).length, 0);
  });
});
