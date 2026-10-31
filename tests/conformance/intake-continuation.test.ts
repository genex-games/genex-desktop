import { test } from "node:test";
import assert from "node:assert/strict";
import { startRig, waitForLog } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";

for (const mode of ["autopilot", "loop"] as const)
  test(`${mode}: approving interview with keep going retains launch authority`, async () => {
    const rig = await startRig();
    try {
      const calls: DelegateRequest[] = [];
      rig.core.engines.register({
        id: "codex",
        label: "Codex fixture",
        kind: "delegated",
        status: async () => ({ code: "ready", detail: "" }),
        models: async () => [],
        complete: async () => {
          throw new Error("Unexpected completion");
        },
        delegate: async (request) => {
          calls.push(request);
          return {
            ok: true,
            summary: calls.length === 1 ? "Use a cozy lake setting?" : "Launch tool available.",
            sessionId: "intake-session",
            turns: 1,
            usage: {},
            durationMs: 1,
            engine: "codex",
          };
        },
      });
      await rig.core.games.scaffold("fishing-intake");
      const thread = await rig.core.createGameThread("fishing-intake");
      const options = { thread, engine: "codex", model: "gpt-5.6-sol", [mode]: { hours: 1 } };
      await rig.core.sendUserMessage("Create a fishing game", options);
      await waitForLog(rig.core, (events) =>
        events.some((e) => e.data.type === "custom" && e.data.event_type === "contractor_session"),
      );
      await rig.core.sendUserMessage("yeah! nice recommendations! keep going", options);
      await waitForLog(
        rig.core,
        (events) =>
          events.filter((e) => e.data.type === "custom" && e.data.event_type === "contractor_session").length === 2,
      );
      assert.equal(calls.length, 2);
      const tool = mode === "autopilot" ? "start_autopilot" : "start_unattended_run";
      for (const call of calls)
        assert.ok(
          call.interviewTools?.some((t) => t.name === tool),
          "intake tool must survive approval follow-up",
        );
      assert.equal(calls[1]!.resume, "intake-session");
      // Flipped (step 1): the resumed Loop chat is a contractor that may launch, not an interviewer.
      // Flipped (Loop phase 5): it may start the Loop, which it leads itself.
      assert.match(calls[1]!.prompt, /Loop is on: you may start the Loop/);
    } finally {
      await rig.stop();
    }
  });
