/**
 * The Player report inbox's channels (`main/ipc/game-ai-inbox.ts`) driven through the real typed
 * `handle()` with a recording host: a library game's name and a report's id are read before the
 * host hears anything, and every hostile payload is refused with no call made.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerGameAiInboxIpc } from "../../src/main/ipc/game-ai-inbox.ts";
import type { GameAiInboxHost } from "../../src/main/game-ai/types.ts";
import { ChannelClass, classifyChannel } from "../../src/main/dev/native-policy.ts";
import { STUDIO_INVOKE_CHANNELS } from "../../src/shared/ipc-channels.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const studio = { sender: "studio", senderFrame: "main-frame" };
const INBOX_CHANNELS = Object.keys(STUDIO_INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("studio:ai-reports."),
);

function registered() {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  const heard: Array<[string, unknown[]]> = [];
  const host: GameAiInboxHost = {
    inbox: async (...args) => {
      heard.push(["inbox", args]);
      return [];
    },
    inboxFix: async (...args) => {
      heard.push(["inboxFix", args]);
      return { ok: true, tape: "report-0001-x" };
    },
  };
  registerGameAiInboxIpc(handle, host);
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { listeners, invoke, heard };
}

describe("the Player report inbox's registrar", () => {
  it("registers both inbox channels of the map, fixture-safe", () => {
    const { listeners } = registered();
    assert.deepEqual([...listeners.keys()].sort(), [...INBOX_CHANNELS].sort());
    assert.equal(INBOX_CHANNELS.length, 2);
    for (const channel of INBOX_CHANNELS) assert.equal(classifyChannel(channel), ChannelClass.FixtureSafe, channel);
  });

  it("hands the host a library name and a report id as read", async () => {
    const { invoke, heard } = registered();
    assert.equal((await invoke("studio:ai-reports.inbox", { project: "Lantern Run" })).ok, true);
    assert.equal((await invoke("studio:ai-reports.fix", { project: "lantern-run", id: "report-0001" })).ok, true);
    assert.deepEqual(heard, [
      ["inbox", ["Lantern Run"]],
      ["inboxFix", ["lantern-run", "report-0001"]],
    ]);
  });

  const hostile: Array<[string, unknown]> = [
    ["studio:ai-reports.inbox", undefined],
    ["studio:ai-reports.inbox", {}],
    ["studio:ai-reports.inbox", { project: 7 }],
    ["studio:ai-reports.inbox", { project: "" }],
    ["studio:ai-reports.inbox", { project: "." }],
    ["studio:ai-reports.inbox", { project: ".." }],
    ["studio:ai-reports.inbox", { project: "../someone-else" }],
    ["studio:ai-reports.inbox", { project: "a/b" }],
    ["studio:ai-reports.inbox", { project: "a\\b" }],
    ["studio:ai-reports.inbox", { project: "/etc" }],
    ["studio:ai-reports.inbox", { project: " padded " }],
    ["studio:ai-reports.inbox", { project: "nul\u0000" }],
    ["studio:ai-reports.inbox", { project: "x".repeat(256) }],
    ["studio:ai-reports.fix", { project: "lantern-run" }],
    ["studio:ai-reports.fix", { project: "lantern-run", id: "../../etc/passwd" }],
    ["studio:ai-reports.fix", { project: "lantern-run", id: "r1" }],
    ["studio:ai-reports.fix", { project: "lantern-run", id: "report 0001" }],
    ["studio:ai-reports.fix", { project: "lantern-run", id: "x".repeat(101) }],
    ["studio:ai-reports.fix", { project: "lantern-run", id: 1234567890 }],
    ["studio:ai-reports.fix", { project: "a/b", id: "report-0001" }],
    ["studio:ai-reports.fix", { project: "..", id: "report-0001" }],
  ];
  for (const [channel, payload] of hostile) {
    it(`refuses ${channel} ${JSON.stringify(payload)} before the host hears it`, async () => {
      const { invoke, heard } = registered();
      const answer = await invoke(channel, payload);
      assert.equal(answer.ok, false);
      assert.deepEqual(heard, []);
    });
  }
});
