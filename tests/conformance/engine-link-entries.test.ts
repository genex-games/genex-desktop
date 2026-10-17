/**
 * The chat says when a game starts building in an engine project, in one line with Undo: "Fog
 * Valley now builds in Unreal · Valley". Undo belongs to the newest link only; once taken back the
 * line says so, and an older line keeps its words but loses Undo.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const linked = (id: number, payload: Record<string, unknown>) =>
  event(id, {
    type: "custom",
    event_type: "engine_linked",
    payload: {
      pluginId: "unreal",
      project: "valley",
      engine: "unreal",
      file: "/Users/me/Documents/Unreal Projects/Valley/Valley.uproject",
      name: "Valley",
      title: "Fog Valley",
      linkedAt: `2026-10-04T12:00:0${id}.000Z`,
      ...payload,
    },
  });
const undone = (id: number, payload: Record<string, unknown>) =>
  event(id, {
    type: "custom",
    event_type: "engine_link_undone",
    payload: { pluginId: "unreal", project: "valley", ...payload },
  });

const links = (entries: ReturnType<typeof toEntries>) =>
  entries.filter((e) => e.kind === EntryKind.Action && e.action === EntryAction.EngineLink);

describe("a game's engine link in its chat", () => {
  it("is one line naming the game, the engine and the project, with Undo", () => {
    const [line] = links(toEntries([linked(1, {})]));
    assert.ok(line?.kind === EntryKind.Action);
    assert.equal(line.text, "Fog Valley now builds in Unreal · Valley");
    assert.deepEqual(line.engineLink, { project: "valley", pluginId: "unreal", linkedAt: "2026-10-04T12:00:01.000Z" });
    assert.equal(line.outcome, undefined);
  });

  it("says when Undo took it back, and Undo is gone", () => {
    const [line] = links(toEntries([linked(1, {}), undone(2, { linkedAt: "2026-10-04T12:00:01.000Z" })]));
    assert.ok(line?.kind === EntryKind.Action);
    assert.equal(line.engineLink, undefined);
    assert.equal(line.outcome, "Undone. Fog Valley is a web game again.");
    const [back] = links(
      toEntries([linked(1, {}), undone(2, { linkedAt: "2026-10-04T12:00:01.000Z", restored: "Mist" })]),
    );
    assert.ok(back?.kind === EntryKind.Action);
    assert.equal(back.outcome, "Undone. Fog Valley builds in Mist again.");
  });

  it("keeps Undo on the newest link only", () => {
    const [first, second] = links(toEntries([linked(1, {}), linked(2, { name: "Mist", previous: "Valley" })]));
    assert.ok(first?.kind === EntryKind.Action && second?.kind === EntryKind.Action);
    assert.equal(first.engineLink, undefined);
    assert.equal(second.engineLink?.linkedAt, "2026-10-04T12:00:02.000Z");
    assert.equal(second.text, "Fog Valley now builds in Unreal · Mist");
  });

  it("names any engine by the label its plugin declares", () => {
    const toy = {
      pluginId: "toy-engine",
      engine: "toy-engine",
      label: "Toy",
      name: "Garden",
      file: "/p/Garden.toyproj",
    };
    const [line] = links(toEntries([linked(1, toy)]));
    assert.ok(line?.kind === EntryKind.Action);
    assert.equal(line.text, "Fog Valley now builds in Toy · Garden");
  });

  it("reads an old or partial record without failing, naming the game plainly", () => {
    const [line] = links(toEntries([linked(1, { title: undefined, linkedAt: undefined })]));
    assert.ok(line?.kind === EntryKind.Action);
    assert.equal(line.text, "This game now builds in Unreal · Valley");
    assert.equal(line.engineLink, undefined, "no Undo without the link's time");
  });
});
