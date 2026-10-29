/**
 * The person's Plays, timed (`src/main/core/play-timings.ts`, lane PW): a clock per Play whose
 * stages are marked as they end, the lane's own marks through its sink, one Studio log line when
 * the Play ends, and the last few records kept for diagnostics.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAY_TIMINGS_KEPT, PlayTimings } from "../../src/main/core/play-timings.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { PlayStage, playTimingLine } from "../../src/shared/play-timing.ts";

/** A clock a test moves by hand. */
function handClock(start = 10_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("a Play's clock", () => {
  it("marks each stage with when it ended after the click and its own length, the lane's through its sink", () => {
    const time = handClock();
    const lines: string[] = [];
    const timings = new PlayTimings({ now: time.now, log: (line) => lines.push(line) });
    const clock = timings.start({ project: "ferris", target: BuildTarget.Web, commit: "a".repeat(40) });
    time.advance(120);
    clock.mark(PlayStage.Copy);
    time.advance(5_000);
    clock.sink(PlayStage.BuildQueue, 4_000);
    clock.sink(PlayStage.BuildStep, 1_000, "build");
    time.advance(300);
    clock.mark(PlayStage.Served);
    time.advance(700);
    clock.end(PlayStage.FirstFrame);
    const [record] = timings.recent();
    assert.ok(record);
    assert.deepEqual(
      record.marks.map((mark) => [mark.stage, mark.at, mark.ms, mark.detail]),
      [
        [PlayStage.Request, 0, 0, null],
        [PlayStage.Copy, 120, 120, null],
        [PlayStage.BuildQueue, 5_120, 4_000, null],
        [PlayStage.BuildStep, 5_120, 1_000, "build"],
        [PlayStage.Served, 5_420, 300, null],
        [PlayStage.FirstFrame, 6_120, 700, null],
      ],
    );
    assert.equal(record.totalMs, 6_120);
    assert.deepEqual(lines, [`[play] ${playTimingLine(record)}`]);
    assert.match(lines[0] ?? "", /ferris web aaaaaaaaaaaa 6120ms: request \+0ms \(0ms\) · copy \+120ms/);
  });

  it("ends once: a mark after the end, or a second end, changes nothing and logs nothing more", () => {
    const time = handClock();
    const lines: string[] = [];
    const timings = new PlayTimings({ now: time.now, log: (line) => lines.push(line) });
    const clock = timings.start({ project: "ferris", target: BuildTarget.Mac, commit: null });
    clock.end(PlayStage.Failed, "the Mac build failed");
    clock.mark(PlayStage.Served);
    clock.end(PlayStage.FirstFrame);
    assert.equal(lines.length, 1);
    assert.deepEqual(
      timings.recent()[0]?.marks.map((mark) => mark.stage),
      [PlayStage.Request, PlayStage.Failed],
    );
  });

  it("keeps the last Plays only, and a running Play is not among them", () => {
    const timings = new PlayTimings({ now: handClock().now });
    const running = timings.start({ project: "running", target: BuildTarget.Web, commit: null });
    for (let i = 0; i < PLAY_TIMINGS_KEPT + 3; i++)
      timings.start({ project: `game-${i}`, target: BuildTarget.Web, commit: null }).end(PlayStage.FirstFrame);
    const kept = timings.recent();
    assert.equal(kept.length, PLAY_TIMINGS_KEPT);
    assert.equal(kept[0]?.project, "game-3");
    assert.ok(!kept.some((timing) => timing.project === "running"));
    assert.equal(running.timing().totalMs, null);
  });
});
