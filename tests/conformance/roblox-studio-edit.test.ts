/**
 * Roblox Studio back at its editor before a publish: Studio publishes from its editor, never from a
 * play test, so a test running in the game's Studio is ended by Genex and waited out, as Studio's
 * own state says. A place edited from Roblox shows a NetworkClient in Explorer while editing; only
 * Studio's mode decides.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backToEdit } from "../../src/plugins/roblox/studio-edit.ts";

const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit";
const PLAYING =
  "- Current Studio Mode: Play\n- Available DataModels: Edit, Client, Server\n- Focused DataModel in the viewport: Client";

/** A Studio that answers its state from `states` in turn (the last one repeats), and records each call. */
function studioSaying(states: Array<string | Error>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let read = 0;
  const studio = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name !== "get_studio_state") return { content: [{ type: "text", text: "ok" }] };
      const state = states[Math.min(read++, states.length - 1)];
      if (state instanceof Error) throw state;
      return { content: [{ type: "text", text: state }] };
    },
  };
  return { studio, calls, stops: () => calls.filter((call) => call.name === "start_stop_play") };
}

const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => void (at += ms) };
};

describe("Studio back at its editor before a publish", () => {
  it("leaves an editing Studio alone", async () => {
    const editing = studioSaying([EDITING]);
    assert.equal(await backToEdit({ studio: editing.studio, studioId: "s1", ...clock() }), true);
    assert.deepEqual(editing.stops(), []);
  });

  it("ends a running play test and waits until Studio is editing again", async () => {
    const playing = studioSaying([PLAYING, PLAYING, EDITING]);
    assert.equal(await backToEdit({ studio: playing.studio, studioId: "s1", ...clock() }), true);
    assert.deepEqual(
      playing.stops().map((call) => call.args),
      [{ studio_id: "s1", is_start: false }],
      "the test is ended once, in the game's own Studio",
    );
  });

  it("says so when Studio is still testing after its time", async () => {
    const stuck = studioSaying([PLAYING]);
    const time = clock();
    assert.equal(await backToEdit({ studio: stuck.studio, studioId: "s1", ...time }), false);
    assert.ok(time.now() >= 30_000, "it waited Studio's whole time");
  });

  it("asks nothing of a Studio it can't reach or that can't say, and ends nothing", async () => {
    const silent = studioSaying([new Error("Studio isn't answering")]);
    assert.equal(await backToEdit({ studio: silent.studio, studioId: "s1", ...clock() }), true);
    assert.deepEqual(silent.stops(), []);
    assert.equal(await backToEdit({ studio: undefined, studioId: "s1", ...clock() }), true);
    const unbound = studioSaying([PLAYING]);
    assert.equal(await backToEdit({ studio: unbound.studio, studioId: undefined, ...clock() }), true);
    assert.deepEqual(unbound.calls, []);
  });
});
