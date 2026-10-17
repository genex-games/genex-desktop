/**
 * The drawing on a card while its asset is made, the Genex account's (Settings, Publish) and
 * Multiplayer's. What it promises: every kind draws, inside the card's drawing area at every moment
 * (it never grows past the card), the beam sweeps up and down the subject leaving the part above it
 * faint, a still frame is built with no beam, and the same moment always draws the same frame.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ART_HEIGHT, ART_WIDTH, MakingDrawing, type MakingFrame, makingFrame } from "../../src/renderer/making-art.ts";

const DRAWINGS = Object.values(MakingDrawing);
/** Moments across two whole sweeps, so every pose and beam height is seen. */
const MOMENTS = Array.from({ length: 41 }, (_, i) => i * 0.17);

/** Every line end and fill corner of a frame, as [x, y]. */
function pointsOf(frame: MakingFrame): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const ends of frame.lines) for (let i = 0; i + 1 < ends.length; i += 2) points.push([ends[i]!, ends[i + 1]!]);
  for (const poly of [...frame.fill, ...frame.face]) for (const [x, y] of poly) points.push([x, y]);
  return points;
}
const lineCount = (frame: MakingFrame): number => frame.lines.reduce((total, ends) => total + ends.length / 4, 0);

describe("the making drawing", () => {
  it("draws every kind inside the card's drawing area at every moment", () => {
    for (const drawing of DRAWINGS)
      for (const t of MOMENTS) {
        const frame = makingFrame(drawing, t, false);
        assert.ok(lineCount(frame) > 20, `${drawing} draws at ${t}`);
        for (const [x, y] of pointsOf(frame)) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y), `${drawing} at ${t}: a finite point`);
          assert.ok(x >= 8 && x <= ART_WIDTH - 8, `${drawing} at ${t}: x ${x} stays clear of the sides`);
          assert.ok(
            y >= 18 && y <= ART_HEIGHT - 4,
            `${drawing} at ${t}: y ${y} stays below the chip and above the label`,
          );
        }
      }
  });

  it("keeps each subject small: about half the card's drawing area", () => {
    for (const drawing of DRAWINGS) {
      const points = pointsOf(makingFrame(drawing, 1, true));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      assert.ok(width <= 72 && height <= 62, `${drawing} is ${width.toFixed(0)}×${height.toFixed(0)}`);
    }
  });

  it("sweeps the beam over the subject, from below it to above it and back", () => {
    for (const drawing of DRAWINGS) {
      const beams = MOMENTS.map((t) => makingFrame(drawing, t, false).beam);
      assert.ok(
        beams.every((beam) => beam !== null && Number.isFinite(beam)),
        drawing,
      );
      const ys = pointsOf(makingFrame(drawing, 0, false)).map(([, y]) => y);
      const [low, high] = [Math.max(...beams.map(Number)), Math.min(...beams.map(Number))];
      assert.ok(low >= Math.max(...ys) - 6 && high <= Math.min(...ys) + 6, `${drawing}'s beam crosses all of it`);
      assert.equal(makingFrame(drawing, 0, false).builtFrom, makingFrame(drawing, 0, false).beam);
    }
  });

  it("leaves the part above the beam faint, not gone", () => {
    for (const drawing of DRAWINGS) {
      // Half a sweep in, the beam is near the top: most of the drawing is built.
      const low = makingFrame(drawing, 0.4, false);
      const faintLines = low.lines[0]!.length + low.lines[1]!.length;
      assert.ok(faintLines > 0, `${drawing} keeps a faint part above the beam`);
    }
  });

  it("draws a still frame fully built, with no beam", () => {
    for (const drawing of DRAWINGS) {
      const still = makingFrame(drawing, 2, true);
      assert.equal(still.beam, null);
      assert.equal(still.builtFrom, 0);
      const moving = makingFrame(drawing, 0, false);
      const bright = (frame: MakingFrame) => frame.lines[4]!.length + frame.lines[5]!.length;
      assert.ok(bright(still) >= bright(moving), `${drawing}'s still is at least as built as a moving frame`);
    }
  });

  it("draws the same frame for the same moment, and survives a moment that is not a number", () => {
    for (const drawing of DRAWINGS) {
      assert.deepEqual(makingFrame(drawing, 1.25, false), makingFrame(drawing, 1.25, false));
      assert.ok(lineCount(makingFrame(drawing, Number.NaN, false)) > 0);
    }
  });

  it("fills a solid's silhouette and a mark's face", () => {
    for (const drawing of [MakingDrawing.Character, MakingDrawing.Model, MakingDrawing.Texture])
      assert.ok(makingFrame(drawing, 1, false).fill.length > 0, drawing);
    for (const drawing of [
      MakingDrawing.Image,
      MakingDrawing.Video,
      MakingDrawing.Sound,
      MakingDrawing.Account,
      MakingDrawing.Multiplayer,
      MakingDrawing.Remix,
    ])
      assert.ok(makingFrame(drawing, 1, false).face.length >= 2, `${drawing}'s face has its inner outlines`);
  });
});
