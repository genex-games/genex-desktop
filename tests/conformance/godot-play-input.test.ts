/**
 * What an agent asks a Godot play to do, checked before Godot starts: key timelines written as
 * people write them ("right 1.5, space, wait 1") become frames the play script reads, and anything
 * else is refused with words the agent can act on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  frameAt,
  keysArg,
  keysEnd,
  PlayInputError,
  readKeys,
  recordingShots,
  ShotCameras,
  shotsArg,
} from "../../src/plugins/godot/play-input.ts";

describe("a Godot play's keys", () => {
  it("reads a timeline into frames at 60 a second: holds, taps and waits", () => {
    const presses = readKeys("right 1.5, space, wait 1, a 0.25");
    assert.deepEqual(presses, [
      { key: "right", start: 0, length: 90 },
      { key: "space", start: 90, length: 6 },
      { key: "a", start: 156, length: 15 },
    ]);
    assert.equal(keysArg(presses), "right@0:90;space@90:6;a@156:15");
    assert.equal(keysEnd(presses), 172);
    assert.deepEqual(readKeys("  "), []);
  });

  it("refuses keys, numbers and lengths it can't press, before Godot runs", () => {
    const refused = [
      "jump 1",
      "right -1",
      "right 1 2",
      "right 1e3",
      "space;rm -rf",
      "ctrl+c",
      "wait 61",
      "right 30, left 31",
      Array.from({ length: 33 }, () => "space").join(","),
      "right\u0000",
    ];
    for (const keys of refused) assert.throws(() => readKeys(keys), PlayInputError, keys);
  });

  it("spreads a recording's frames up to its moment, the last one at it", () => {
    assert.deepEqual(recordingShots(3, 3), [
      { frame: 60, cameras: ShotCameras.First },
      { frame: 120, cameras: ShotCameras.First },
      { frame: 180, cameras: ShotCameras.First },
    ]);
    assert.equal(frameAt(0.001), 1);
    assert.equal(
      shotsArg([{ frame: 180, cameras: ShotCameras.All }, ...recordingShots(1, 2)]),
      "180:all;30:first;60:first",
    );
  });
});
