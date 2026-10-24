/** The Loop's time limit: shown as hours and minutes, typed in any of the shapes people write. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, limitWords, parseDuration, shortDuration } from "../../src/renderer/ui/loop-duration.ts";

describe("the Loop's time limit", () => {
  it("shows hours and minutes, dropping a zero part", () => {
    assert.deepEqual([150, 120, 45, 60, 0, 1440].map(formatDuration), [
      "2 h 30 m",
      "2 h",
      "45 m",
      "1 h",
      "0 m",
      "24 h",
    ]);
  });

  it("spells a limit out in words for the Mode caption", () => {
    assert.deepEqual([30, 60, 120, 105, 61, 1440].map(limitWords), [
      "30 minutes",
      "1 hour",
      "2 hours",
      "1 hour 45 minutes",
      "1 hour 1 minute",
      "24 hours",
    ]);
  });

  it("writes a compact limit for the Mode button", () => {
    assert.deepEqual([30, 60, 120, 105, 150, 1440].map(shortDuration), ["30m", "1h", "2h", "1h45", "2h30", "24h"]);
  });

  it("reads a clock, units, or bare hours, rounded to five minutes", () => {
    const cases: Array<[string, number | null]> = [
      ["1:45", 105],
      ["2h 30m", 150],
      ["2 h", 120],
      ["90m", 90],
      ["1.5", 90],
      ["1.5h", 90],
      ["  2H  ", 120],
      ["47m", 45],
      ["48m", 50],
    ];
    for (const [text, minutes] of cases) assert.equal(parseDuration(text), minutes, text);
  });

  it("keeps a typed limit within fifteen minutes and a day", () => {
    assert.equal(parseDuration("5m"), 15);
    assert.equal(parseDuration("30h"), 1440);
  });

  it("refuses what is not a time, or no time at all", () => {
    for (const text of ["", "soon", "0", "0m", "0:00", "h"]) assert.equal(parseDuration(text), null, text);
  });
});
