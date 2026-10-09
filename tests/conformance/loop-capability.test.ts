/**
 * Capability handshake — a Loop commission must never reach a loop that predates it.
 *
 * The harness is the agent's own code, so what it can dispatch is a fact about the loaded copy,
 * not about the app: an old (or hand-rolled) loop simply does not know the `loop` field on
 * user_message and would run the commission as a plain chat turn — the user wakes to nothing.
 * The handshake makes that impossible: the loaded self declares its capabilities in the ready
 * message, and a Loop send to a self that never claimed "loop" is refused loudly in the thread
 * instead of being silently downgraded.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HarnessCapability } from "../../src/shared/protocol.ts";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

/**
 * The seed's loop as it stood before the composer Loop existed: user_message answered as a plain
 * chat turn, no loop branches, no capabilities property. Self-contained rather than derived from
 * git history — what matters is the shape (handles chat, claims nothing), not the exact vintage.
 */
const PRE_LOOP_HARNESS = `export async function createStudio(host) {
  return {
    status: () => "idle",
    healthcheck: async () => ({ ok: true }),
    async dispatch(action) {
      if (action.type === "user_message") {
        await host.call("events.append", {
          threadId: action.threadId,
          batch: [{ type: "messages", messages: [{ role: "assistant", content: "plain chat: " + action.text }] }],
        });
      }
    },
  };
}
`;

describe("loop capability handshake", () => {
  it("the shipped seed claims its dispatch features through the ready message", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const claimed = [
      HarnessCapability.Loop,
      HarnessCapability.RunStart,
      HarnessCapability.RunStop,
      HarnessCapability.Skillopt,
      HarnessCapability.Compact,
    ];
    for (const name of claimed) {
      assert.equal(rig.core.host.hasCapability(name), true, `the seed must claim ${name}`);
    }
  });

  it("a Loop commission to a pre-loop harness is refused in the thread, never downgraded", async () => {
    const rig = await startRig();
    rigs.push(rig);

    // The agent rewrote its loop from scratch (or a stale copy survived an upgrade): the file
    // loads and chats fine, but knows nothing of Loop and claims nothing.
    await writeFile(path.join(rig.core.layout.harnessWs, "loop", "main.ts"), PRE_LOOP_HARNESS);
    await rig.core.host.restart();
    assert.equal(rig.core.host.state, "ready");
    assert.deepEqual(rig.core.host.capabilities, [], "a harness that claims nothing has nothing");

    const threadId = await rig.core.createGameThread();
    const brief = "a rainy city with neon puddles";
    await rig.core.sendUserMessage(brief, { thread: threadId, loop: { hours: 2 } });

    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "error"),
      15_000,
      "the refusal in the thread",
    );
    const refusal = events.find((e) => e.data.type === "error")!.data as { message: string };
    assert.match(refusal.message, /Loop|predates|seed/);

    // The composer already cleared the draft — the brief must survive in the log, before the
    // refusal that explains it.
    const messages = await rig.core.store.listMessages(threadId);
    assert.ok(
      messages.some((m) => m.role === "user" && m.content === brief),
      "the user's text is in the log",
    );

    // Never downgraded: the stale self never saw the commission as a chat turn, no run was
    // started, and no model was ever consulted.
    assert.ok(
      !messages.some((m) => String(m.content).startsWith("plain chat:")),
      "the commission must not become a plain chat delegation",
    );
    assert.equal(customEvents(events, "run_started").length, 0, "no run may ever start");
    assert.equal(
      rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions")).length,
      0,
      "no interview, no delegation",
    );
    assert.ok(
      rig.events.some((e) => e.type === "chat.error"),
      "the open window is told, not just the log",
    );

    // Only Loop is gated: the same stale self still gets plain chat.
    await rig.core.sendUserMessage("hello there", { thread: threadId });
    await waitForLog(
      rig.core,
      (log) =>
        log.some(
          (e) => e.data.type === "messages" && e.data.messages.some((m) => m.content === "plain chat: hello there"),
        ),
      15_000,
      "plain chat reaching the stale harness",
    );
  });

  it("a build whose jobs cross to a local engine reaches only a harness whose every part serves it, never one that would misroute", async () => {
    const rig = await startRig();
    rigs.push(rig);
    assert.equal(
      rig.core.host.hasCapability(HarnessCapability.LocalRoles),
      true,
      "the shipped seed serves local roles",
    );

    // The agent edited its scout before local roles existed: the upgrade kept its copy, which has no
    // marker and would ask Ollama for a session.
    const scout = path.join(rig.core.layout.harnessWs, "loop", "scout.ts");
    const kept = (await readFile(scout, "utf8")).replace("export const SERVES_LOCAL_ROLES = true;", "");
    await writeFile(scout, kept);
    await rig.core.host.restart();
    assert.equal(rig.core.host.state, "ready");
    assert.equal(rig.core.host.hasCapability(HarnessCapability.LocalRoles), false);
    assert.equal(rig.core.host.hasCapability(HarnessCapability.Autopilot), true, "everything else is still served");

    const threadId = await rig.core.createGameThread();
    const brief = "a marsh at dusk";
    await rig.core.sendUserMessage(brief, {
      thread: threadId,
      engine: "claude-code",
      model: "opus",
      autopilot: { hours: 1, roles: { planner: "opus", builder: "opus", judge: "vl", engines: { judge: "ollama" } } },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "error"),
      15_000,
      "the refusal in the thread",
    );
    const refusal = events.find((e) => e.data.type === "error")!.data as { message: string };
    assert.match(refusal.message, /local model/);
    const messages = await rig.core.store.listMessages(threadId);
    assert.ok(
      messages.some((m) => m.role === "user" && m.content === brief),
      "the brief is in the log",
    );
    assert.equal(customEvents(events, "run_started").length, 0, "no run may start on a part that misroutes");
    assert.ok(
      rig.events.some((e) => e.type === "chat.error"),
      "the open window is told",
    );
  });
});
