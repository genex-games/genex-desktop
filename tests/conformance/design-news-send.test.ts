/**
 * Notes and picks the person left on the Design board go with their next message in the game's
 * chat: the agent reads them after the person's words, the chat shows the words alone, and once
 * sent they are told, so the next message carries them no more.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { DESIGN_NEWS_HEADING } from "../../src/shared/design-tell-prompts.ts";
import { withoutMentionContext } from "../../src/shared/prompt-mention.ts";
import { DispatchActionType, type DispatchAction, MessageOrigin } from "../../src/shared/protocol.ts";
import { UiEvent, type UiEvent as UiEventRecord } from "../../src/shared/ui-events.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const TOWN = "docs/design/world/town.png";

describe("the Design board's news with the person's next message", () => {
  let lite: CoreLite;
  let core: StudioCore;
  let threadId: string;
  const sent: DispatchAction[] = [];
  const events: UiEventRecord[] = [];

  before(async () => {
    lite = await coreLite({ executionPolicy: {}, onUiEvent: (event) => events.push(event) });
    core = lite.core;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return undefined;
    };
    await core.games.scaffold("bees");
    const town = path.join(core.games.dirFor("bees"), TOWN);
    fs.mkdirSync(path.dirname(town), { recursive: true });
    fs.writeFileSync(town, "PNG");
    threadId = await core.createGameThread("bees");
  });
  after(() => lite.close());

  const texts = () => sent.flatMap((action) => (action.type === DispatchActionType.UserMessage ? [action.text] : []));
  const leaveNote = (id: string, text: string) =>
    core.design.saveMarks("bees", {
      places: {},
      notes: [{ id, text, file: TOWN, x: 10, y: 10, fx: 0.1, fy: 0.9, told: false }],
      picks: {},
      choices: [],
    });

  it("go after the person's words, hidden from the chat, and are told once sent", async () => {
    await leaveNote("n1", "Make the well bigger");
    await core.sendUserMessage("Looks good, keep going", { thread: threadId, clientId: "q-1" });
    const text = texts().at(-1) ?? "";
    assert.ok(text.startsWith(`Looks good, keep going${DESIGN_NEWS_HEADING}`), text);
    assert.match(text, /Town \(docs\/design\/world\/town\.png\), 10% across and 90% down: Make the well bigger/);
    assert.equal(withoutMentionContext(text), "Looks good, keep going", "the chat shows the person's words");
    assert.equal((await core.design.marks("bees")).notes[0]?.told, true);
    assert.ok(
      events.some((event) => event.type === UiEvent.DesignTold),
      "the canvas hears they were sent",
    );

    await core.sendUserMessage("And make it night", { thread: threadId, clientId: "q-2" });
    assert.equal(texts().at(-1), "And make it night", "told notes do not go again");
  });

  it("stay for the person: a message Genex writes itself, or a chat with no game, carries none", async () => {
    await leaveNote("n2", "Fewer trees");
    await core.sendUserMessage("A background job ended", {
      thread: threadId,
      origin: MessageOrigin.JobEnded,
    });
    assert.equal(texts().at(-1), "A background job ended");
    await core.sendUserMessage("hello studio", { thread: core.mainThread });
    assert.ok(!(texts().at(-1) ?? "").includes(DESIGN_NEWS_HEADING));
    assert.equal((await core.design.marks("bees")).notes[0]?.told, false, "still waiting for the person");
    await core.sendUserMessage("Next", { thread: threadId, clientId: "q-3" });
    assert.match(texts().at(-1) ?? "", /Fewer trees/);
  });

  it("go once: two quick sends, or Tell Genex's own save racing a send, never carry the same notes twice", async () => {
    await leaveNote("n3", "A lantern by the well");
    await Promise.all([
      core.sendUserMessage("First", { thread: threadId, clientId: "q-4" }),
      core.sendUserMessage("Second", { thread: threadId, clientId: "q-5" }),
    ]);
    const carried = texts().filter((text) => text.includes("A lantern by the well"));
    assert.equal(carried.length, 1, "one message carries them");

    // Tell Genex marks its notes told, then sends them in its own words: the send must see that save.
    const saved = core.design.saveMarks("bees", {
      places: {},
      notes: [{ id: "n4", text: "Bigger moon", file: TOWN, x: 1, y: 1, told: true }],
      picks: {},
      choices: [],
    });
    const sending = core.sendUserMessage("Bigger moon, please", { thread: threadId, clientId: "q-6" });
    await Promise.all([saved, sending]);
    assert.equal(texts().at(-1), "Bigger moon, please", "the told note is not added again");
  });
});
