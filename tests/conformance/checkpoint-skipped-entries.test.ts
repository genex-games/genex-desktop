/**
 * The chat says when a rewind left files as they were because they were too large to save: which
 * files, with their sizes. A message's checkpoint that left them out says nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryKind, SystemTag, toEntries } from "../../src/renderer/chat-entries.ts";
import { sizeWords } from "../../src/shared/byte-size.ts";
import { SkippedBy } from "../../src/shared/chat-rewind.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

const MB = 1024 ** 2;

const skipped = (id: number, payload: Record<string, unknown>): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data: { type: "custom", event_type: CustomEvent.CheckpointSkipped, payload },
});
const lines = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.System && entry.tag === SystemTag.Checkpoint ? [entry] : [],
  );
const files = (...sizes: Array<[string, number]>) => sizes.map(([file, bytes]) => ({ file, bytes }));

describe("files too large to save, in the chat", () => {
  it("adds no line for a message's checkpoint, whatever it left out", () => {
    const limits = { fileLimitBytes: 50 * MB, changeLimitBytes: 1024 * MB };
    const big = files(["a.glb", 34.8 * MB], ["b.glb", 34 * MB], ["c.glb", 33 * MB]);
    // Flipped: an older version's checkpoint record read "Rewind can’t bring back 1 file that is
    // too large to save: Dust2_Flythrough.mp4 (50.8 MB)." Nothing was lost yet, and nothing the
    // person could do brought it back: only a rewind that leaves files as they are names them.
    assert.deepEqual(
      lines([
        skipped(1, { by: SkippedBy.Checkpoint, files: files(["Dust2_Flythrough.mp4", 50.8 * MB]) }),
        skipped(2, { files: big, total: 50, ...limits }),
        skipped(3, { files: files(["a.bin", 2 * MB]), total: 80 }),
      ]),
      [],
    );
  });

  it("says a rewind left them as they are, with their sizes, and stands on its own", () => {
    const [line] = lines([
      skipped(1, {
        by: SkippedBy.Rewind,
        files: files(["Content/Hero.uasset", 120 * MB], ["audio/Theme.wav", 64 * MB]),
      }),
    ]);
    assert.equal(
      line?.text,
      "These files were too large to save, so the rewind left them as they are: Hero.uasset (120 MB), Theme.wav (64 MB).",
    );
    assert.equal(line?.attention, true, "never folded away with routine lines");
  });

  it("says a rewind left them as they are, and counts past three names", () => {
    const five = files(["a.bin", 5 * MB], ["b.bin", 4 * MB], ["c.bin", 3 * MB], ["d.bin", 2 * MB], ["e.bin", MB]);
    const [line] = lines([skipped(1, { by: SkippedBy.Rewind, files: five })]);
    assert.equal(
      line?.text,
      "These files were too large to save, so the rewind left them as they are: a.bin (5 MB), b.bin (4 MB), c.bin (3 MB) and 2 more.",
    );
    const [one] = lines([skipped(1, { by: SkippedBy.Rewind, files: files(["big.uasset", 60 * MB]) })]);
    assert.equal(one?.text, "This file was too large to save, so the rewind left it as it is: big.uasset (60 MB).");
    const [listed] = lines([skipped(1, { by: SkippedBy.Rewind, files: files(["a.bin", 2 * MB]), total: 80 })]);
    assert.equal(
      listed?.text,
      "These files were too large to save, so the rewind left them as they are: a.bin (2 MB) and 79 more.",
      "a record that lists some of its files counts them all",
    );
  });

  it("names a file the rewind found gone without a size", () => {
    const [line] = lines([skipped(1, { by: SkippedBy.Rewind, files: files(["intro.mp4", 60 * MB], ["gone.mp4", 0]) })]);
    assert.equal(
      line?.text,
      "These files were too large to save, so the rewind left them as they are: intro.mp4 (60 MB), gone.mp4.",
    );
  });

  it("adds no line for a partial record", () => {
    assert.deepEqual(lines([skipped(1, {}), skipped(2, { by: SkippedBy.Rewind, files: [] })]), []);
    assert.deepEqual(
      lines([skipped(3, { by: SkippedBy.Rewind, files: [{ file: 7 }, "x"] })]),
      [],
      "entries it cannot read are left out",
    );
  });

  it("says a size in the largest unit it reaches", () => {
    assert.deepEqual([12, 80 * 1024, 50 * MB + 1, 1.5 * 1024 * MB, 6.1 * 1024 * MB].map(sizeWords), [
      "12 bytes",
      "80 KB",
      "50 MB",
      "1.5 GB",
      "6.1 GB",
    ]);
  });
});
