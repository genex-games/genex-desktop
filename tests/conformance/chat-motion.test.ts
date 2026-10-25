/**
 * How the chat moves, as pure rules: a status label stays long enough to read, what comes and goes
 * opens and closes in place (and keeps its place while it closes), and a saved message continues
 * the opening its placeholder began instead of starting over.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { continuedEntrance } from "../../src/renderer/chat/transcript-motion.ts";
import { PresencePhase, presenceDone, presenceList } from "../../src/renderer/ui/presence-list.ts";
import { sizeGlide } from "../../src/renderer/ui/motion.ts";
import { heldStatus, LABEL_DWELL_MS, steadyLabel } from "../../src/renderer/ui/label-motion.ts";
import { clockWords } from "../../src/renderer/words.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";

describe("a status label stays long enough to read", () => {
  it("shows the first label at once", () => {
    assert.deepEqual(steadyLabel(null, "Sending", 1000), { shown: { text: "Sending", since: 1000 }, wakeAt: null });
  });

  it("keeps a label until it has been read, then shows the newest one, skipping those in between", () => {
    const sending = { text: "Sending", since: 1000 };
    assert.deepEqual(steadyLabel(sending, "Working", 1070), { shown: sending, wakeAt: 1000 + LABEL_DWELL_MS });
    assert.deepEqual(steadyLabel(sending, "Thinking", 1100), { shown: sending, wakeAt: 1000 + LABEL_DWELL_MS });
    assert.deepEqual(steadyLabel(sending, "Thinking", 1000 + LABEL_DWELL_MS), {
      shown: { text: "Thinking", since: 1000 + LABEL_DWELL_MS },
      wakeAt: null,
    });
  });

  it("changes at once when the shown label has been up long enough, and never for the same words", () => {
    const thinking = { text: "Thinking", since: 0 };
    assert.deepEqual(steadyLabel(thinking, "Reading the code", 5000), {
      shown: { text: "Reading the code", since: 5000 },
      wakeAt: null,
    });
    assert.deepEqual(steadyLabel(thinking, "Thinking", 10), { shown: thinking, wakeAt: null });
  });

  it("keeps every label on show for at least a second", () => {
    const sending = { text: "Sending", since: 0 };
    assert.equal(steadyLabel(sending, "Thinking", SECOND_MS - 1).shown, sending);
    assert.equal(steadyLabel(sending, "Thinking", SECOND_MS).shown.text, "Thinking");
  });
});

describe("the status line holds its words, their clock and their waiting together", () => {
  const thinking = { label: "Thinking", since: 1000, waiting: false };

  it("keeps the shown words' start and waiting while newer words wait their turn", () => {
    const asking = { label: "Waiting for your answer", since: 5000, waiting: true };
    assert.equal(heldStatus(thinking, "Thinking", asking), thinking);
  });

  it("starts again when new words come on show", () => {
    const tool = { label: "Running a tool", since: 5000, waiting: false };
    assert.equal(heldStatus(thinking, "Running a tool", tool), tool);
  });

  it("keeps the clock running while the same words stay, whatever start the work reports", () => {
    assert.equal(heldStatus(thinking, "Thinking", { ...thinking, since: 7000 }), thinking);
  });

  it("follows the work's waiting while the same words stay", () => {
    assert.deepEqual(heldStatus(thinking, "Thinking", { label: "Thinking", since: 7000, waiting: true }), {
      ...thinking,
      waiting: true,
    });
  });
});

describe("the status clock shows whole seconds, from the first", () => {
  it("shows nothing under a second", () => {
    assert.equal(clockWords(0), "");
    assert.equal(clockWords(SECOND_MS - 1), "");
  });

  it("counts seconds, then minutes and seconds, then hours and minutes", () => {
    assert.equal(clockWords(SECOND_MS), "1s");
    assert.equal(clockWords(65 * SECOND_MS), "1m\u00a05s");
    assert.equal(clockWords(2 * HOUR_MS + 10 * MINUTE_MS), "2h\u00a010m");
  });

  // The clock's figures are tabular, and the house font's tabular set widens a plain space to a
  // figure's width ("2m   23s"); a no-break space keeps a word space's width and the clock on one line.
  it("joins its two parts with a no-break space, never a plain one", () => {
    for (const ms of [143 * SECOND_MS, 59 * MINUTE_MS, 3 * HOUR_MS + 5 * MINUTE_MS]) {
      assert.doesNotMatch(clockWords(ms), / /);
      assert.match(clockWords(ms), /^\d+[hm]\u00a0\d+[ms]$/);
    }
  });
});

describe("what comes and goes opens and closes in place", () => {
  const item = (key: string, value = key) => ({ key, value });

  it("opens what arrives and shows a first paint at once", () => {
    assert.deepEqual(presenceList([], [item("a")], true), [{ key: "a", value: "a", phase: PresencePhase.Open }]);
    assert.deepEqual(presenceList([], [item("a")], false), [{ key: "a", value: "a", phase: PresencePhase.Shown }]);
  });

  it("keeps what leaves where it was while it closes, with its last value", () => {
    const shown = [
      { key: "a", value: "a", phase: PresencePhase.Shown },
      { key: "b", value: "b", phase: PresencePhase.Shown },
      { key: "c", value: "c", phase: PresencePhase.Shown },
    ];
    assert.deepEqual(presenceList(shown, [item("a", "a2"), item("c")], true), [
      { key: "a", value: "a2", phase: PresencePhase.Shown },
      { key: "b", value: "b", phase: PresencePhase.Close },
      { key: "c", value: "c", phase: PresencePhase.Shown },
    ]);
  });

  it("follows a new order once, each item kept as it was", () => {
    const shown = [
      { key: "a", value: "a", phase: PresencePhase.Shown },
      { key: "b", value: "b", phase: PresencePhase.Shown },
    ];
    assert.deepEqual(presenceList(shown, [item("b"), item("a")], true), [
      { key: "b", value: "b", phase: PresencePhase.Shown },
      { key: "a", value: "a", phase: PresencePhase.Shown },
    ]);
  });

  it("swaps a slot's content: the old closes above the new as it opens", () => {
    const status = [{ key: "status", value: "Thinking", phase: PresencePhase.Shown }];
    assert.deepEqual(presenceList(status, [item("build")], true), [
      { key: "status", value: "Thinking", phase: PresencePhase.Close },
      { key: "build", value: "build", phase: PresencePhase.Open },
    ]);
  });

  it("removes at once without motion, and reopens what comes back while it closes", () => {
    const closing = [{ key: "a", value: "a", phase: PresencePhase.Close }];
    assert.deepEqual(presenceList([{ key: "a", value: "a", phase: PresencePhase.Shown }], [], false), []);
    assert.deepEqual(presenceList(closing, [], true), closing, "still closing");
    assert.deepEqual(presenceList(closing, [item("a")], true), [{ key: "a", value: "a", phase: PresencePhase.Open }]);
  });

  it("drops at once what something else took over in place, closing only the rest", () => {
    const shown = [
      { key: "saved", value: "saved", phase: PresencePhase.Shown },
      { key: "failed", value: "failed", phase: PresencePhase.Shown },
    ];
    assert.deepEqual(
      presenceList(shown, [], true, (key) => key === "saved"),
      [{ key: "failed", value: "failed", phase: PresencePhase.Close }],
    );
  });

  it("settles an opening as shown and drops a closing one once its motion ends", () => {
    const items = [
      { key: "a", value: "a", phase: PresencePhase.Open },
      { key: "b", value: "b", phase: PresencePhase.Close },
    ];
    assert.deepEqual(presenceDone(items, "a"), [
      { key: "a", value: "a", phase: PresencePhase.Shown },
      { key: "b", value: "b", phase: PresencePhase.Close },
    ]);
    assert.deepEqual(presenceDone(items, "b"), [{ key: "a", value: "a", phase: PresencePhase.Open }]);
    assert.equal(presenceDone(items, "missing"), items, "nothing to settle: the same list");
  });
});

describe("a saved message continues the opening its placeholder began", () => {
  it("continues an opening still under way, and starts none once it has finished", () => {
    assert.equal(continuedEntrance(1000, 1080), 80);
    assert.equal(continuedEntrance(1000, 1000), 0);
    assert.equal(continuedEntrance(1000, 5000), null);
    assert.equal(continuedEntrance(undefined, 1000), null);
  });
});

describe("a size follows its content", () => {
  it("glides from the size shown, carrying on from mid-glide", () => {
    assert.deepEqual(sizeGlide(22, 44), { from: 22, to: 44 });
    assert.deepEqual(sizeGlide(30.5, 44), { from: 30.5, to: 44 }, "a glide under way carries on");
  });
});

describe("a label's width follows its words", () => {
  it("glides to the new words' width from the width shown, so what follows it slides along", () => {
    assert.deepEqual(sizeGlide(118, 162), { from: 118, to: 162 });
    assert.deepEqual(sizeGlide(162, 118), { from: 162, to: 118 });
  });

  it("takes its first width, and a width it already shows, at once", () => {
    assert.equal(sizeGlide(null, 118), null);
    assert.equal(sizeGlide(118.2, 118), null);
  });
});
