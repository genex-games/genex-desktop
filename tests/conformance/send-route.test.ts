import { test } from "node:test";
import assert from "node:assert/strict";
import { sentAsNote } from "../../src/renderer/chat/send-route.ts";
import type { FollowScroll } from "../../src/renderer/chat/use-follow-scroll.ts";
import type { ReplyingAbout } from "../../src/renderer/chat/use-reply-about.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const about = { threadId: "game", runId: "run_1", label: "Tall mountain · try 5", placeholder: "", active: true };

function replying(): { reply: ReplyingAbout; dropped: string[] } {
  const dropped: string[] = [];
  return { reply: { about, drop: (threadId) => dropped.push(threadId) }, dropped };
}

const follow = { jumpToLatest: () => {} } as unknown as FollowScroll;

test("a reply about a build with words goes to the build as a note", async () => {
  const fake = fakeStudioApi();
  Object.assign(globalThis, { window: { studio: fake.api } });
  const { reply, dropped } = replying();
  assert.equal(await sentAsNote(reply, "game", "Make the peak snowier", () => {}, follow), true);
  assert.deepEqual(
    fake.callsOf("runFeedback").map(([request]) => request.text),
    ["Make the peak snowier"],
  );
  assert.deepEqual(dropped, ["game"]);
});

test("pictures sent with no words go to the chat, which can carry them, not to the build as an empty note", async () => {
  const fake = fakeStudioApi();
  Object.assign(globalThis, { window: { studio: fake.api } });
  const { reply, dropped } = replying();
  assert.equal(await sentAsNote(reply, "game", "  ", () => {}, follow), false);
  assert.deepEqual(fake.callsOf("runFeedback"), []);
  assert.deepEqual(dropped, [], "the chip stays for the next message with words");
});
