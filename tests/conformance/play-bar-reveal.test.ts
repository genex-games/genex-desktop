/**
 * The viewer bar's reveal under a purchase sheet: the sheet covers the whole window over the dimmed
 * game, in the bar's layer, without raising the bar itself; while it is open nothing the bar's page
 * says, and no fade, puts the layer away, and closing it leaves the layer where the bar is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BAR_FADE_MS, BAR_LINGER_MS, BAR_SHOWN_MS, BarLayout, barReveal } from "../../src/main/play/bar-reveal.ts";
import { type PlayBarHold, PlayBarOverlay } from "../../src/shared/play-bar.ts";

const NO_HOLD: PlayBarHold = { held: false, overlay: null };
const COMMENTS: PlayBarHold = { held: true, overlay: PlayBarOverlay.Comments };

/** A reveal over a clock the test moves, recording what it shows and where it lays the layer. */
function reveal() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const log: string[] = [];
  const made = barReveal({
    clock: {
      setTimeout: (run, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (id) => void timers.delete(id as number),
    },
    shown: (up) => log.push(`shown ${up}`),
    place: (layout) => log.push(`place ${layout}`),
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { reveal: made, log, advance };
}

/** A reveal whose game is playing and whose bar has faded and been put away. */
function faded() {
  const made = reveal();
  made.reveal.pinned();
  made.reveal.playing();
  made.advance(BAR_SHOWN_MS);
  made.advance(BAR_FADE_MS);
  assert.equal(made.reveal.layout(), BarLayout.Hidden);
  made.log.length = 0;
  return made;
}

describe("Play bar's reveal under a purchase sheet", () => {
  it("lays the layer over the whole window for the sheet without raising the bar", () => {
    const { reveal: bar, log } = faded();
    bar.sheet(true);
    assert.deepEqual(log, [`place ${BarLayout.Full}`]);
    assert.equal(bar.up(), false, "the bar does not pop up for the sheet");
    assert.equal(bar.covering(), true);
  });

  it("keeps the layer over the window when the sheet opens while the bar fades", () => {
    const { reveal: bar, log, advance } = reveal();
    bar.pinned();
    bar.playing();
    advance(BAR_SHOWN_MS);
    assert.deepEqual(log.slice(-1), ["shown false"], "the fade has begun");
    bar.sheet(true);
    advance(BAR_FADE_MS);
    assert.equal(bar.layout(), BarLayout.Full);
    assert.ok(!log.includes(`place ${BarLayout.Hidden}`));
  });

  it("keeps the layer over the window through the bar's own fade while the sheet is open", () => {
    const { reveal: bar, log, advance } = faded();
    bar.sheet(true);
    bar.reveal();
    assert.equal(bar.up(), true, "the top edge still brings the bar back");
    advance(BAR_SHOWN_MS);
    advance(BAR_FADE_MS);
    assert.equal(bar.up(), false);
    assert.equal(bar.layout(), BarLayout.Full);
    assert.ok(!log.includes(`place ${BarLayout.Hidden}`));
    assert.ok(!log.includes(`place ${BarLayout.Bar}`), "never shrunk to the bar's strip under the sheet");
  });

  it("lets no hold from the bar's page collapse the layer while the sheet is open", () => {
    const { reveal: bar, log, advance } = faded();
    bar.hold(COMMENTS);
    bar.sheet(true);
    log.length = 0;
    bar.hold(NO_HOLD);
    advance(BAR_LINGER_MS);
    advance(BAR_FADE_MS);
    assert.equal(bar.layout(), BarLayout.Full);
    assert.ok(!log.some((line) => line.startsWith("place ")), "Comments closing leaves the sheet's layer");
    assert.equal(bar.covering(), true);
  });

  it("puts the layer back where the bar is once the sheet closes", () => {
    const hidden = faded();
    hidden.reveal.sheet(true);
    hidden.log.length = 0;
    hidden.reveal.sheet(false);
    assert.deepEqual(hidden.log, [`place ${BarLayout.Hidden}`], "the bar is down: the game has the window");
    assert.equal(hidden.reveal.covering(), false);

    const up = faded();
    up.reveal.reveal();
    up.reveal.sheet(true);
    up.log.length = 0;
    up.reveal.sheet(false);
    assert.deepEqual(up.log, [`place ${BarLayout.Bar}`], "the bar is up: its strip");

    const comments = faded();
    comments.reveal.hold(COMMENTS);
    comments.reveal.sheet(true);
    comments.log.length = 0;
    comments.reveal.sheet(false);
    assert.deepEqual(comments.log, [], "Comments still covers the window");
    assert.equal(comments.reveal.layout(), BarLayout.Full);
  });

  it("forgets the sheet when the viewer closes", () => {
    const { reveal: bar } = faded();
    bar.sheet(true);
    bar.close();
    assert.equal(bar.covering(), false);
    assert.equal(bar.layout(), BarLayout.Hidden);
    bar.pinned();
    assert.equal(bar.layout(), BarLayout.Bar, "the next game's bar is the strip again");
  });

  it("says the window is covered while Comments or the sheet is open", () => {
    const { reveal: bar } = faded();
    assert.equal(bar.covering(), false);
    bar.hold(COMMENTS);
    assert.equal(bar.covering(), true);
    bar.hold(NO_HOLD);
    assert.equal(bar.covering(), false);
  });
});
