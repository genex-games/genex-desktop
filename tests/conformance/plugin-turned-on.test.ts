/**
 * A plugin the agent suggested and the person turned on from its card: the chat goes on by itself,
 * telling the agent behind the scenes, so nobody has to type "go on". A press that installs (which
 * opens Genex's own review first) or that fails says nothing to the agent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pressSuggestion, SuggestionState } from "../../src/renderer/chat/plugin-suggestion.ts";
import { MessageOrigin, isChatReport } from "../../src/shared/protocol.ts";

/** A plugin API that records what the card asked for, and fails when told to. */
function api(fails = false) {
  const asked: string[] = [];
  return {
    asked,
    pluginEnable: async (id: string, on: boolean) => {
      asked.push(`enable ${id} ${on}`);
      if (fails) throw new Error("could not turn it on");
    },
    pluginInstall: async (id: string) => {
      asked.push(`install ${id}`);
    },
  };
}

describe("pressing a suggested plugin's button", () => {
  it("turns it on, then tells the agent once so the chat goes on", async () => {
    const studio = api();
    const told: string[] = [];
    await pressSuggestion(studio, SuggestionState.TurnOn, { pluginId: "unity", name: "Unity" }, (name) => {
      told.push(name);
    });
    assert.deepEqual(studio.asked, ["enable unity true"]);
    assert.deepEqual(told, ["Unity"]);
  });

  it("says nothing to the agent when it installs or fails", async () => {
    const installing = api();
    const told: string[] = [];
    const onTurnedOn = (name: string) => {
      told.push(name);
    };
    await pressSuggestion(installing, SuggestionState.Install, { pluginId: "toy", name: "Toy" }, onTurnedOn);
    assert.deepEqual(installing.asked, ["install toy"]);
    const failing = api(true);
    await assert.rejects(
      pressSuggestion(failing, SuggestionState.TurnOn, { pluginId: "unity", name: "Unity" }, onTurnedOn),
      /could not turn it on/,
    );
    assert.deepEqual(told, [], "an install is reviewed first and a failure is the person's to see");
  });

  it("is a message the chat writes itself, which the transcript leaves out", () => {
    assert.equal(isChatReport({ origin: MessageOrigin.PluginTurnedOn }), true);
  });
});
