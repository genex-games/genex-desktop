/**
 * The `stills-game` dev fixture: a game no observer draws (a Blender scene, no web page) whose
 * finished Loop kept the lead's two renders as proof, so Live shows them; and a Blender game with no
 * run, whose Live has no picture yet.
 */
import assert from "node:assert/strict";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { seedStillsGame } from "../../src/main/dev/fixture-stills.ts";
import { buildHistory, projectBuildGraph, stageRunGraph } from "../../src/renderer/build-progress.ts";
import { latestCaptures } from "../../src/renderer/live-views.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { tmpDir } from "../helpers/tmp.ts";

const START = Date.UTC(2026, 0, 1, 9, 0, 0);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** A core that keeps each chat's log and makes each empty game's folder. */
async function fakeCore() {
  const runs = await tmpDir("studio-stills-fixture-runs-");
  const games = await tmpDir("studio-stills-fixture-games-");
  const log: EventEnvelope[] = [];
  const core = {
    layout: { runs },
    games: {
      makeEmpty: async (name: string) => {
        const dir = path.join(games, name);
        await mkdir(dir, { recursive: true });
        return { name, dir };
      },
    },
    threadForGame: async (name: string) => `thread-${name}`,
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
  return { core, log, runs, games };
}

it("the Blender game's last Loop kept the lead's renders, which Live shows; the other Blender game has none", async () => {
  const { core, log, runs, games } = await fakeCore();
  await seedStillsGame(core as never);
  assert.deepEqual((await readdir(games)).sort(), ["fixture-pass", "fixture-valley"]);
  await access(path.join(games, "fixture-valley", "art", "valley.blend"));
  await assert.rejects(access(path.join(games, "fixture-valley", "index.html")), "no web page");
  assert.deepEqual(
    log.map((event) => event.thread_id).filter((t) => t !== "thread-fixture-valley"),
    [],
    "no run elsewhere",
  );

  const thread = "thread-fixture-valley";
  const history = buildHistory(log, thread);
  const shown = projectBuildGraph(log, thread, [], runs, history.at(-1)?.runId);
  const pictures = latestCaptures(stageRunGraph(log, thread, runs, shown, history));
  assert.deepEqual(
    pictures.map((picture) => picture.name),
    ["renders/ridge.png", "renders/lake.png"],
  );
  for (const picture of pictures) {
    assert.ok(
      !path.relative(runs, picture.file).startsWith(".."),
      "kept inside the runs folder, where Live reads stills",
    );
    assert.deepEqual((await readFile(picture.file)).subarray(0, 4), PNG_SIGNATURE, "a picture");
  }
});
