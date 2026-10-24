/**
 * Where the viewer bar's layer lies: the bar's strip across the window's top for as long as a game is
 * open, the whole window while Comments or a purchase sheet is open, and put away while the game's page
 * holds the screen in full screen (a purchase sheet still covers it then). Nothing the bar's page says
 * puts the layer away under a sheet, and closing the viewer forgets all of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BarLayout, barLayout } from "../../src/main/play/bar-layout.ts";

const NO_HOLD = { comments: false };
const COMMENTS = { comments: true };

/** A layout recording where it lays the layer, a game already open in it. */
function opened() {
  const log: string[] = [];
  const layer = barLayout({ place: (layout) => log.push(`place ${layout}`) });
  layer.opened();
  return { layer, log };
}

describe("Play bar's layer", () => {
  it("lies in the bar's strip as soon as a game opens, and stays there", () => {
    const log: string[] = [];
    const layer = barLayout({ place: (layout) => log.push(`place ${layout}`) });
    assert.equal(layer.layout(), BarLayout.Hidden, "no game: no layer");
    layer.opened();
    assert.deepEqual(log, [`place ${BarLayout.Bar}`]);
    layer.opened();
    layer.hold(NO_HOLD);
    assert.deepEqual(log, [`place ${BarLayout.Bar}`], "nothing moves it while nothing covers the window");
  });

  it("covers the whole window for Comments and goes back to the strip after", () => {
    const { layer, log } = opened();
    log.length = 0;
    layer.hold(COMMENTS);
    assert.equal(layer.covering(), true);
    assert.equal(layer.comments(), true);
    layer.hold(NO_HOLD);
    assert.deepEqual(log, [`place ${BarLayout.Full}`, `place ${BarLayout.Bar}`]);
    assert.equal(layer.covering(), false);
  });

  it("lets no hold from the bar's page collapse the layer while a purchase sheet is open", () => {
    const { layer, log } = opened();
    layer.hold(COMMENTS);
    layer.sheet(true);
    log.length = 0;
    layer.hold(NO_HOLD);
    assert.equal(layer.layout(), BarLayout.Full);
    assert.deepEqual(log, [], "Comments closing leaves the sheet's layer");
    assert.equal(layer.covering(), true);
  });

  it("puts the layer back where the bar is once the sheet closes", () => {
    const strip = opened();
    strip.layer.sheet(true);
    strip.log.length = 0;
    strip.layer.sheet(false);
    assert.deepEqual(strip.log, [`place ${BarLayout.Bar}`]);

    const comments = opened();
    comments.layer.hold(COMMENTS);
    comments.layer.sheet(true);
    comments.log.length = 0;
    comments.layer.sheet(false);
    assert.deepEqual(comments.log, [], "Comments still covers the window");
    assert.equal(comments.layer.layout(), BarLayout.Full);
  });

  it("is put away while the game's page is full screen, and comes back to the strip after", () => {
    const { layer, log } = opened();
    log.length = 0;
    layer.fullScreen(true);
    assert.equal(layer.isFullScreen(), true);
    assert.equal(layer.layout(), BarLayout.Hidden, "the game has the whole screen");
    layer.fullScreen(false);
    assert.deepEqual(log, [`place ${BarLayout.Hidden}`, `place ${BarLayout.Bar}`]);
  });

  it("covers a full-screen game for its purchase sheet, and leaves it the screen once the sheet closes", () => {
    const { layer, log } = opened();
    layer.fullScreen(true);
    log.length = 0;
    layer.sheet(true);
    layer.sheet(false);
    assert.deepEqual(log, [`place ${BarLayout.Full}`, `place ${BarLayout.Hidden}`]);
  });

  it("forgets Comments, the sheet and full screen when the viewer closes", () => {
    const { layer } = opened();
    layer.hold(COMMENTS);
    layer.sheet(true);
    layer.fullScreen(true);
    layer.close();
    assert.equal(layer.covering(), false);
    assert.equal(layer.isFullScreen(), false);
    assert.equal(layer.layout(), BarLayout.Hidden);
    layer.opened();
    assert.equal(layer.layout(), BarLayout.Bar, "the next game's bar is the strip again");
  });
});
