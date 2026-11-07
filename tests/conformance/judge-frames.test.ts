/**
 * The Loop's judge (`judge`, second-opinion.ts) reads motion from frames with their times. A sword
 * duel's lead asked it about stills for 17 rounds while the fighters slid, then handed it a contact
 * sheet of twelve tiny frames with the interval only in the question; the judge could not see a foot
 * riding along with the body. A motion strip's poses file now hands each frame over at full size, in
 * order, and the judge is told every picture's place and game time (an engine sends a picture's bytes
 * without its label). Pictures without times reach it exactly as before. Whatever a lead names, the
 * judge reads only files inside the project's folder: a strip or a frame outside it is refused and
 * no model is asked. The strip reading lives beside the judge and takes from it only what every
 * shipped judge has, so the open lead's tools still load beside a second-opinion.ts the agent edited
 * and kept from an older seed.
 */
import assert from "node:assert/strict";
import { cp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { openHandler } from "../../src/harness-seed/loop/director/open/tools.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { JUDGE_FRAMES_REFUSALS, judgedPictures } from "../../src/harness-seed/loop/judge-frames.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);
const CAPTURES = path.join("unreal", "Saved", "Genex", "captures");
const STRIP = path.join(CAPTURES, "strip-1.json");

/** A game folder with a three-frame motion strip of the duel in its captures, and a folder outside it. */
async function gameWithStrip() {
  const root = await tmpDir("judge-frames-");
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, CAPTURES), { recursive: true });
  await mkdir(outside, { recursive: true });
  const files = [0, 1, 2].map((i) => path.join(game, CAPTURES, `strip-1-${i}.png`));
  for (const file of files) await writeFile(file, PNG);
  const frames = [12, 12.033, 12.066].map((gameSeconds) => ({ gameSeconds, pawn: [0, 0, 90] }));
  await writeFile(path.join(game, STRIP), JSON.stringify({ frames, files, intervalS: 0.03 }));
  await writeFile(path.join(game, "still.png"), PNG);
  await writeFile(path.join(outside, "secret.png"), PNG);
  return { game, outside, files, frames };
}

/** The open lead's judge, on a run whose engine answers "Yes, the feet slide." and records what it was asked. */
function judgeOn(projectDir: string, handler: typeof openHandler = openHandler) {
  const asked: Array<Record<string, any>> = [];
  const loopRun = {
    ctx: {
      cancelled: false,
      call: async (method: string, params: Record<string, any>) => {
        assert.equal(method, HostMethod.EngineComplete);
        asked.push(params);
        return { message: { content: "Yes, the feet slide." } };
      },
    },
    toolCalls: 0,
    open: { halted: false },
    state: { finished: false, finish: null },
    projectDir,
    run: { runId: "run-judge", engine: "claude-code" },
  };
  const judge = (args: Record<string, unknown>) => handler(loopRun as never)("judge", args);
  return { judge, asked };
}

describe("the judge reads motion from frames with their times", () => {
  it("a motion strip's frames reach the judge in order, at full size, each with its game time and the gap before it", async () => {
    const { game } = await gameWithStrip();
    const { judge, asked } = judgeOn(game);
    const answer = await judge({ question: "Do the feet stay planted while the body walks?", strip: STRIP });
    assert.equal(answer, "Second opinion: Yes, the feet slide.");
    const [call] = asked;
    assert.equal(call?.messages[0].images.length, 3);
    const content = String(call?.messages[0].content);
    assert.match(content, /^Do the feet stay planted while the body walks\?\n\n/);
    assert.match(content, /Picture 1: frame 0 of the strip, at 12\.000 s game time\./);
    assert.match(content, /Picture 2: frame 1 of the strip, at 12\.033 s game time, 0\.033 s after the one before\./);
    assert.match(content, /Picture 3: frame 2 of the strip, at 12\.066 s game time/);
    assert.match(content, /frames of the game in motion/);
  });

  it("pictures a lead times read as frames; a strip's frames come first, then the pictures", async () => {
    const { game } = await gameWithStrip();
    const { judge, asked } = judgeOn(game);
    await judge({ question: "Does the swing play through?", pictures: "still.png", times: "20.5", strip: STRIP });
    const content = String(asked[0]?.messages[0].content);
    assert.equal(asked[0]?.messages[0].images.length, 4);
    assert.match(content, /Picture 4: still\.png, at 20\.500 s game time/);
  });

  it("pictures without times reach the judge exactly as before: the question alone", async () => {
    const { game } = await gameWithStrip();
    const { judge, asked } = judgeOn(game);
    await judge({ question: "Is the menu readable?", pictures: "still.png" });
    assert.equal(asked[0]?.messages[0].content, "Is the menu readable?");
    assert.equal(asked[0]?.messages[0].images.length, 1);
  });

  it("a frame that never landed (the play ended mid-strip) is left out, and the frames that did reach the judge", async () => {
    const { game: real, files: realFiles, frames } = await gameWithStrip();
    // Unreal names the frames by the game folder as it was opened, here through a link to it.
    const game = path.join(path.dirname(real), "game-link");
    await symlink(real, game);
    const files = realFiles.map((file) => path.join(game, path.relative(real, file)));
    const pending = path.join(game, CAPTURES, "strip-1-3.png");
    const record = { frames: [...frames, { gameSeconds: 12.1 }], files: [...files, pending] };
    await writeFile(path.join(game, CAPTURES, "strip-cut.json"), JSON.stringify(record));
    const { judge, asked } = judgeOn(game);
    await judge({ question: "Do the feet slide?", strip: path.join(CAPTURES, "strip-cut.json") });
    assert.equal(asked[0]?.messages[0].images.length, 3);
    assert.doesNotMatch(String(asked[0]?.messages[0].content), /frame 3/);
    await writeFile(path.join(game, CAPTURES, "strip-none.json"), JSON.stringify({ frames: [{}], files: [pending] }));
    const none = judgeOn(game);
    const answer = await none.judge({ question: "Do the feet slide?", strip: path.join(CAPTURES, "strip-none.json") });
    assert.match(String(answer), /no frames yet/);
    assert.equal(none.asked.length, 0);
  });

  it("frames past the size a model takes are left out from the end, and the lead and the judge are told", async () => {
    const { game } = await gameWithStrip();
    const big = path.join(game, CAPTURES, "big.png");
    await writeFile(big, Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]));
    const files = [0, 1, 2, 3].map(() => big);
    const frames = [0, 1, 2, 3].map((i) => ({ gameSeconds: i * 0.1 }));
    await writeFile(path.join(game, CAPTURES, "strip-big.json"), JSON.stringify({ frames, files }));
    const { judge, asked } = judgeOn(game);
    const answer = await judge({ question: "Does it run?", strip: path.join(CAPTURES, "strip-big.json") });
    assert.equal(asked[0]?.messages[0].images.length, 2, "two 7 MB frames fit in 20 MB, a third doesn't");
    assert.match(String(answer), /2 later frames of the strip were left out/);
    assert.match(String(asked[0]?.messages[0].content), /2 later frames were left out/);
  });
});

describe("the judge reads nothing outside the project's folder and asks no model when it refuses", () => {
  it("refuses each hostile strip, frame or time, and no engine is called", async () => {
    const { game, outside } = await gameWithStrip();
    await writeFile(path.join(outside, "strip.json"), JSON.stringify({ files: [path.join(outside, "secret.png")] }));
    await symlink(path.join(outside, "strip.json"), path.join(game, "linked.json"));
    await writeFile(
      path.join(game, "leaks.json"),
      JSON.stringify({ files: [path.join(outside, "secret.png")], frames: [{ gameSeconds: 1 }] }),
    );
    await writeFile(path.join(game, "climbs.json"), JSON.stringify({ files: ["../outside/secret.png"] }));
    await writeFile(path.join(game, "climbs-to-none.json"), JSON.stringify({ files: ["../outside/none.png"] }));
    await writeFile(path.join(game, "commas.json"), JSON.stringify({ files: ["still.png,../outside/secret.png"] }));
    await writeFile(path.join(game, "nulls.json"), JSON.stringify({ files: [null, 7] }));
    await symlink(outside, path.join(game, "door"));
    await writeFile(path.join(game, "through-door.json"), JSON.stringify({ files: ["door/none.png"] }));
    await writeFile(path.join(game, "broken.json"), "{ not json");
    await writeFile(path.join(game, "empty.json"), JSON.stringify({ files: [], frames: [] }));
    await writeFile(path.join(game, "strip.txt"), "{}");
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["a strip outside the folder", { strip: "../outside/strip.json" }, /not a file in the project's folder/],
      [
        "a strip by its absolute path outside",
        { strip: path.join(outside, "strip.json") },
        /not a file in the project's folder/,
      ],
      ["a link out of the folder", { strip: "linked.json" }, /not a file in the project's folder/],
      ["a strip whose frames are outside", { strip: "leaks.json" }, /secret\.png.*not a file in the project's folder/],
      ["a frame that climbs out", { strip: "climbs.json" }, /not a file in the project's folder/],
      ["a missing frame outside", { strip: "climbs-to-none.json" }, /not a file in the project's folder/],
      ["a frame that names two pictures", { strip: "commas.json" }, /not one picture's path/],
      ["frames that are no paths", { strip: "nulls.json" }, /not one picture's path/],
      [
        "a missing frame in a linked folder outside",
        { strip: "through-door.json" },
        /not a file in the project's folder/,
      ],
      ["a strip that is not JSON", { strip: "broken.json" }, /could not be read/],
      ["a strip with no frames yet", { strip: "empty.json" }, /no frames yet/],
      ["a strip that is no .json", { strip: "strip.txt" }, /\.json poses file/],
      ["a missing strip", { strip: "gone.json" }, /not a file in the project's folder/],
      ["fewer times than pictures", { pictures: "still.png,still.png", times: "1" }, /1 times for 2 pictures/],
      ["a time that is no number", { pictures: "still.png", times: "soon" }, /1 times for 1 pictures/],
      [
        "a blank time, which is no 0 s",
        { pictures: "still.png,still.png,still.png", times: "1,,3" },
        /2 times for 3 pictures/,
      ],
    ];
    for (const [label, args, refusal] of cases) {
      const { judge, asked } = judgeOn(game);
      const answer = await judge({ question: "Does it slide?", ...args });
      assert.match(String(answer), refusal, label);
      assert.equal(asked.length, 0, `${label}: no model is asked`);
    }
  });

  it("names its refusals in the tool's own words", async () => {
    const { game } = await gameWithStrip();
    const read = await judgedPictures(game, { strip: "strip.txt" });
    assert.deepEqual(read, {
      refused: JUDGE_FRAMES_REFUSALS.badStrip("strip.txt", "not a motion strip's .json poses file"),
    });
  });
});

describe("the open lead's tools beside a judge kept from an older seed", () => {
  it("load and hand the judge a strip's frames when second-opinion.ts has only what every shipped judge has", async () => {
    const root = await tmpDir("judge-kept-");
    const seed = path.join(root, "seed");
    await cp(path.resolve("src/harness-seed"), seed, { recursive: true });
    const loop = path.join(seed, "loop");
    await rename(path.join(loop, "second-opinion.ts"), path.join(loop, "second-opinion-shipped.ts"));
    // The names the judge has shipped with since the open Loop first had one: an agent's kept copy has these and no more.
    await writeFile(
      path.join(loop, "second-opinion.ts"),
      'export { askSecondOpinion, pictureFile, picturesIn, SECOND_OPINION_TOOL, SECOND_OPINION_WORDS, secondOpinionSpec } from "./second-opinion-shipped.ts";\n',
    );
    const tools = await import(pathToFileURL(path.join(loop, "director", "open", "tools.ts")).href);
    const { game } = await gameWithStrip();
    const { judge, asked } = judgeOn(game, tools.openHandler);
    const answer = await judge({ question: "Do the feet stay planted?", strip: STRIP });
    assert.equal(answer, "Second opinion: Yes, the feet slide.");
    assert.equal(asked[0]?.messages[0].images.length, 3);
  });
});
