/** The surface words a computer tool speaks: what the model asks for and what it is told it got. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodedJpeg, requestedSurface, surfaceWord } from "../../src/main/core/capture.ts";

describe("capture surface words", () => {
  it("names the page a screen, the canvas a canvas, and nothing else at all", () => {
    assert.equal(surfaceWord("page"), "screen");
    assert.equal(surfaceWord("canvas"), "canvas");
    assert.equal(surfaceWord("auto"), null);
    assert.equal(surfaceWord(null), null);
    assert.equal(surfaceWord("toString" as never), null);
  });

  it("reads a request's surface, letting the studio pick when none or an unknown one is named", () => {
    assert.equal(requestedSurface({ surface: "screen" }), "page");
    assert.equal(requestedSurface({ surface: "canvas" }), "canvas");
    assert.equal(requestedSurface({}), "auto");
    assert.equal(requestedSurface({ surface: "desk" as never }), "auto");
    assert.equal(requestedSurface({ surface: "constructor" as never }), "auto");
  });

  it("answers an encoded still as its path, base64 and byte count", () => {
    assert.deepEqual(encodedJpeg(Buffer.from("jpeg"), "/runs/a/shot.jpg"), {
      path: "/runs/a/shot.jpg",
      base64: Buffer.from("jpeg").toString("base64"),
      bytes: 4,
    });
  });
});

describe("a capture asked for at a size (the judging size, plan 2 Track D)", () => {
  const STATS = { width: 960, height: 540 } as never;
  /** A port that records how it was asked, and draws `size` or refuses it. */
  function port(sized: "draws" | "refuses" | "absent") {
    const asked: Array<{ how: string; size?: unknown; lens?: unknown }> = [];
    const plain = async () => {
      asked.push({ how: "plain" });
      return { jpeg: Buffer.from("plain"), stats: STATS, surface: "canvas" as const };
    };
    const at = async (size: { width: number; height: number }, _quality?: number, lens?: unknown) => {
      asked.push({ how: "sized", size, lens });
      if (sized === "refuses") throw new Error("unsupported: this game draws its world size only");
      return { jpeg: Buffer.from("sized"), stats: { ...size } as never, surface: "canvas" as const };
    };
    return {
      asked,
      port: {
        screenshot: async () => Buffer.from("plain"),
        screenshotWithStats: plain,
        ...(sized === "absent" ? {} : { screenshotAt: at }),
      } as never,
    };
  }
  const size = { width: 3840, height: 2160 };
  const lens = { depthOfField: false, motionBlur: false };

  it("draws at the size with the asked lens when the port can", async () => {
    const { captureSurface } = await import("../../src/main/core/capture.ts");
    const sized = port("draws");
    const shot = await captureSurface(sized.port, 80, "canvas", { size, lens });
    assert.equal(shot.jpeg.toString(), "sized");
    assert.deepEqual(sized.asked, [{ how: "sized", size, lens }]);
  });

  it("takes the plain capture when the game refuses the size, and when the port has no sized capture", async () => {
    const { captureSurface } = await import("../../src/main/core/capture.ts");
    const refused = port("refuses");
    assert.equal((await captureSurface(refused.port, 80, "canvas", { size, lens })).jpeg.toString(), "plain");
    assert.deepEqual(
      refused.asked.map((call) => call.how),
      ["sized", "plain"],
    );
    const web = port("absent");
    assert.equal((await captureSurface(web.port, 80, "canvas", { size, lens })).jpeg.toString(), "plain");
    const unsized = port("draws");
    await captureSurface(unsized.port, 80, "canvas");
    assert.deepEqual(
      unsized.asked.map((call) => call.how),
      ["plain"],
      "no size asked: the plain capture",
    );
  });
});
