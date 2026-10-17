/**
 * The `unreal-game` dev fixture: the fixture game linked to a stand-in Unreal project, with one
 * finished run whose viewport observer kept a shot, so Live's Unreal card has a picture to show.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { seedUnrealGame } from "../../src/main/dev/fixture-unreal.ts";
import { buildHistory, projectBuildGraph, stageRunGraph } from "../../src/renderer/build-progress.ts";
import { latestShot } from "../../src/renderer/live-views.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { UNREAL_PLUGIN_ID } from "../../src/shared/observers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const THREAD = "thread-fixture-game";
const START = Date.UTC(2026, 0, 1, 9, 0, 0);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** The Unreal plugin's viewport observer, as its manifest names it. */
const VIEWPORT = `${UNREAL_PLUGIN_ID}/viewport`;

/** A core that keeps the chat's log and answers the plugin and engine-link calls the fixture makes. */
async function fakeCore() {
  const runs = await tmpDir("studio-unreal-game-fixture-runs-");
  const log: EventEnvelope[] = [];
  const calls: string[] = [];
  const core = {
    layout: { runs },
    plugins: { setEnabled: async (id: string, on: boolean) => void calls.push(`plugin ${id} ${on}`) },
    engineLinks: {
      link: async (id: string) => void calls.push(`link ${id}`),
      steps: async (id: string) => void calls.push(`steps ${id}`),
    },
    append: async (events: EventData[], threadId: string) => {
      for (const data of events)
        log.push({
          id: `e${String(log.length + 1).padStart(5, "0")}`,
          thread_id: threadId,
          session_id: null,
          turn_id: null,
          created_at: new Date(START + (log.length + 1) * 1000).toISOString(),
          data,
        } as EventEnvelope);
      return threadId;
    },
  };
  return { core, log, calls, runs };
}

it("the Unreal game's last run kept a viewport shot that Live's card shows", async () => {
  const { core, log, calls, runs } = await fakeCore();
  const dir = await tmpDir("studio-unreal-game-fixture-game-");
  await seedUnrealGame(core as never, { name: "fixture-game", dir }, THREAD);
  assert.deepEqual(calls, [`plugin ${UNREAL_PLUGIN_ID} true`, `link ${UNREAL_PLUGIN_ID}`, `steps ${UNREAL_PLUGIN_ID}`]);

  const history = buildHistory(log, THREAD);
  const shown = projectBuildGraph(log, THREAD, [], runs, history.at(-1)?.runId);
  const graph = stageRunGraph(log, THREAD, runs, shown, history);
  const shot = latestShot(graph, VIEWPORT);
  assert.ok(shot, "the card has a shot");
  assert.ok(!path.relative(runs, shot).startsWith(".."), "kept inside the runs folder, where Live reads stills");
  const bytes = await readFile(shot);
  assert.deepEqual(bytes.subarray(0, 4), PNG_SIGNATURE, "a picture");
});
