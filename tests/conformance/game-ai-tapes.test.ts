/**
 * Saved playtests on disk (`main/game-ai/tapes.ts`): a game's tapes in `<game>/ai/tapes/*.jsonl`,
 * listed, read and recorded with every path realpath-contained in the game's folder. A tape is
 * agent-writable game content, so the hostile table covers names, links (to the folder, to a file,
 * outside the game), a FIFO and a tape over its cap, each with no side effect outside the game.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGameAiTapes } from "../../src/main/game-ai/tapes.ts";
import { AiDoor, AiOp } from "../../src/shared/game-ai.ts";
import { AI_TAPE_MAX_BYTES, TAPE_WIRE_VERSION, tapeLineText, type TapeLine } from "../../src/shared/game-ai-tape.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX = process.platform !== "win32";

function line(n: number, site = "turn.resolve"): TapeLine {
  return {
    v: TAPE_WIRE_VERSION,
    key: "a".repeat(64),
    n,
    site,
    op: AiOp.Ask,
    value: { move: `m${n}` },
    source: AiDoor.Local,
    model: "qwen3:8b",
    latencyFrames: 12,
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}

async function gameFolder() {
  const root = await tmpDir("game-ai-tapes-");
  const game = path.join(root, "Crowns");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, "ai", "tapes"), { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, game, outside };
}

describe("saved playtests on disk", () => {
  it("records a demo, lists it with its calls and sites, and reads its lines back", async () => {
    const { game } = await gameFolder();
    const tapes = createGameAiTapes();
    const recording = await tapes.record(game, "opening");
    await recording.append(line(0));
    await recording.append(line(1, "npc.say"));
    await recording.close();
    await recording.append(line(2));
    const read = await tapes.read(game, "opening");
    assert.deepEqual(
      read.map((row) => row.n),
      [0, 1],
      "a line after close is not kept",
    );
    const [summary] = await tapes.list(game);
    assert.equal(summary?.name, "opening");
    assert.equal(summary?.calls, 2);
    assert.deepEqual(summary?.sites, ["npc.say", "turn.resolve"]);
    assert.equal(summary?.rejected, 0);
    assert.ok(summary && summary.bytes > 0 && summary.recordedAt !== null);
  });

  it("lists a game with no tapes folder as no tapes, and counts a tape's damaged lines", async () => {
    const root = await tmpDir("game-ai-tapes-empty-");
    assert.deepEqual(await createGameAiTapes().list(root), []);
    const { game } = await gameFolder();
    await writeFile(path.join(game, "ai", "tapes", "mixed.jsonl"), `${tapeLineText(line(0))}not json\n{"v":9}\n`);
    await writeFile(path.join(game, "ai", "tapes", "Not A Tape.jsonl"), tapeLineText(line(0)));
    await writeFile(path.join(game, "ai", "tapes", "notes.txt"), "hello");
    const listed = await createGameAiTapes().list(game);
    assert.deepEqual(
      listed.map((tape) => [tape.name, tape.calls, tape.rejected]),
      [["mixed", 1, 2]],
    );
  });

  it("refuses a demo name that is not one, before touching the disk", async () => {
    const { game, root } = await gameFolder();
    const tapes = createGameAiTapes();
    for (const name of ["../escape", "a/b", "", ".hidden", "Upper", "x".repeat(65), "a\u0000b", "a\\b"]) {
      await assert.rejects(tapes.read(game, name), `read ${JSON.stringify(name)}`);
      await assert.rejects(tapes.record(game, name), `record ${JSON.stringify(name)}`);
    }
    assert.deepEqual((await readdir(path.join(game, "ai", "tapes"))).sort(), []);
    assert.deepEqual((await readdir(root)).sort(), ["Crowns", "outside"]);
  });

  it("never reads or writes through a link out of the game", { skip: !POSIX && "POSIX links" }, async () => {
    const { root, outside } = await gameFolder();
    const game = path.join(root, "Linked");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(outside, "stolen.jsonl"), tapeLineText(line(0)));
    await symlink(outside, path.join(game, "ai"));
    const tapes = createGameAiTapes();
    await assert.rejects(tapes.list(game), "the ai folder is a link out");
    await assert.rejects(tapes.read(game, "stolen"));
    await assert.rejects(tapes.record(game, "planted"));
    assert.deepEqual((await readdir(outside)).sort(), ["stolen.jsonl"], "nothing was written outside");
  });

  it("refuses a tape that is a link, a FIFO or over its cap", { skip: !POSIX && "POSIX links and FIFOs" }, async () => {
    const { game, outside } = await gameFolder();
    const dir = path.join(game, "ai", "tapes");
    await writeFile(path.join(outside, "secret.jsonl"), tapeLineText(line(0)));
    await symlink(path.join(outside, "secret.jsonl"), path.join(dir, "linked.jsonl"));
    execFileSync("mkfifo", [path.join(dir, "pipe.jsonl")]);
    await writeFile(path.join(dir, "huge.jsonl"), "x".repeat(AI_TAPE_MAX_BYTES + 1));
    const tapes = createGameAiTapes();
    for (const name of ["linked", "pipe", "huge"]) await assert.rejects(tapes.read(game, name), name);
    assert.deepEqual(await tapes.list(game), [], "none of them is listed");
    const recording = await tapes.record(game, "linked");
    await recording.append(line(0));
    await assert.rejects(recording.close(), "a recording never writes through a planted link");
    assert.equal(await readFile(path.join(outside, "secret.jsonl"), "utf8"), tapeLineText(line(0)));
  });
});
