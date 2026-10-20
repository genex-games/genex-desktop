/**
 * Play-time AI for a Godot game played in the person's own editor: `genex_ai.gd` leaves each `ai`
 * line as `.godot/genex/ai-in-<rid>.json`, and Studio's relay channel (`godotAiChannel` in
 * `editor-bridge.ts`) takes them out while the editor's heartbeat says a scene plays, beats
 * `ai-relay.json` so the game knows it is relayed, and hands the answers back as whole
 * `ai-out-<order>.json` files. Nothing is read or written through a link, and a file that is not a
 * line of its own name is taken out unread.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AiBridgeOp, GAME_AI_WIRE_VERSION } from "../../src/shared/game-ai.ts";
import { PLAY_AI_MAX_LINE_CHARS, PlayAiOp, type PlayAiOutgoing, PlayEvent } from "../../src/shared/play-protocol.ts";
import {
  AI_PULL_MAX_FILES,
  AI_RELAY_BEAT,
  BRIDGE_FOLDER,
  type BridgeClock,
  godotAiChannel,
  HEARTBEAT_FRESH_MS,
} from "../../src/plugins/godot/editor-bridge.ts";
import { tmpDir } from "../helpers/tmp.ts";

const signal = new AbortController().signal;
const helloLine = (rid: string) => ({ event: PlayEvent.Ai, rid, op: AiBridgeOp.Hello, body: null });

/** A Godot project with the addon's bridge folder, an editor beating at `at`, and a clock held there. */
async function project(beat: { playing: boolean } | null = { playing: true }) {
  const root = await realpath(await tmpDir("studio-godot-ai-"));
  const folder = path.join(root, BRIDGE_FOLDER);
  await mkdir(folder, { recursive: true });
  const clock: BridgeClock & { at: number } = { at: 1_000_000, now: () => clock.at, sleep: async () => {} };
  if (beat) await writeFile(path.join(folder, "editor.json"), JSON.stringify({ at: clock.at, ...beat }));
  const queue = (rid: string, line: unknown = helloLine(rid)) =>
    writeFile(path.join(folder, `ai-in-${rid}.json`), typeof line === "string" ? line : JSON.stringify(line));
  return { root, folder, clock, queue, channel: godotAiChannel(root, clock) };
}

describe("the Godot editor's AI relay channel", () => {
  it("takes out each line the game queued, oldest first, and beats the relay file", async () => {
    const game = await project();
    await game.queue("gdai-00000002");
    await game.queue("gdai-00000001");
    assert.deepEqual(await game.channel.pull(signal), [helloLine("gdai-00000001"), helloLine("gdai-00000002")]);
    assert.deepEqual((await readdir(game.folder)).sort(), [AI_RELAY_BEAT, "editor.json"]);
    assert.deepEqual(JSON.parse(await readFile(path.join(game.folder, AI_RELAY_BEAT), "utf8")), { at: game.clock.at });
  });

  it("answers no play while no scene plays, or the editor stopped beating, and beats nothing", async () => {
    const idle = await project({ playing: false });
    await idle.queue("gdai-00000001");
    assert.equal(await idle.channel.pull(signal), null);
    const stale = await project();
    stale.clock.at += HEARTBEAT_FRESH_MS + 1;
    assert.equal(await stale.channel.pull(signal), null);
    const closed = await project(null);
    assert.equal(await closed.channel.pull(signal), null);
    for (const game of [idle, stale, closed]) assert.ok(!(await readdir(game.folder)).includes(AI_RELAY_BEAT));
    assert.ok((await readdir(idle.folder)).includes("ai-in-gdai-00000001.json"), "a line waits for the play");
  });

  it(`takes at most ${AI_PULL_MAX_FILES} lines in one pull and leaves the rest for the next`, async () => {
    const game = await project();
    for (let i = 0; i < AI_PULL_MAX_FILES + 2; i++) await game.queue(`gdai-${String(i).padStart(8, "0")}`);
    assert.equal((await game.channel.pull(signal))?.length, AI_PULL_MAX_FILES);
    assert.equal((await game.channel.pull(signal))?.length, 2);
  });

  const unread: Array<[string, (game: Awaited<ReturnType<typeof project>>) => Promise<void>]> = [
    ["a file that is not JSON", (game) => game.queue("gdai-00000001", "{not json")],
    ["a line naming another rid", (game) => game.queue("gdai-00000001", helloLine("gdai-00000002"))],
    ["a JSON array", (game) => game.queue("gdai-00000001", [helloLine("gdai-00000001")])],
    [
      "a file over the cap",
      (game) =>
        game.queue("gdai-00000001", { ...helloLine("gdai-00000001"), pad: "x".repeat(3 * PLAY_AI_MAX_LINE_CHARS) }),
    ],
  ];
  for (const [name, plant] of unread) {
    it(`takes out ${name} unread`, async () => {
      const game = await project();
      await plant(game);
      assert.deepEqual(await game.channel.pull(signal), []);
      assert.ok(!(await readdir(game.folder)).includes("ai-in-gdai-00000001.json"));
    });
  }

  it("never reads through a link, and takes out only the link, never what it points at", async () => {
    const game = await project();
    const outside = await tmpDir("studio-godot-ai-outside-");
    const secret = path.join(outside, "line.json");
    await writeFile(secret, JSON.stringify(helloLine("gdai-00000001")));
    await symlink(secret, path.join(game.folder, "ai-in-gdai-00000001.json"));
    assert.deepEqual(await game.channel.pull(signal), []);
    assert.deepEqual(await readdir(outside), ["line.json"]);
    assert.ok(!(await readdir(game.folder)).includes("ai-in-gdai-00000001.json"));
  });

  it("leaves alone what is not a line file: other names, short rids and folders", async () => {
    const game = await project();
    const kept = ["ai-in-short.json", "ai-in-gdai-00000001.json.partial", "ask-00ff.json", "ai-in-../x.json"];
    for (const name of kept.slice(0, 3)) await writeFile(path.join(game.folder, name), "{}");
    await mkdir(path.join(game.folder, "ai-in-gdai-00000009.json"));
    assert.deepEqual(await game.channel.pull(signal), []);
    const left = await readdir(game.folder);
    for (const name of [...kept.slice(0, 3), "ai-in-gdai-00000009.json"]) assert.ok(left.includes(name), name);
  });

  it("refuses a bridge folder, or a Godot cache, that is a link: no play, nothing written there", async () => {
    for (const what of ["the bridge folder", "Godot's cache"]) {
      const game = await project();
      const outside = await tmpDir("studio-godot-ai-link-");
      const beat = JSON.stringify({ at: game.clock.at, playing: true });
      await mkdir(path.join(outside, "genex"), { recursive: true });
      await writeFile(path.join(outside, "editor.json"), beat);
      await writeFile(path.join(outside, "genex", "editor.json"), beat);
      await writeFile(
        path.join(outside, "genex", "ai-in-gdai-00000001.json"),
        JSON.stringify(helloLine("gdai-00000001")),
      );
      await writeFile(path.join(outside, "ai-in-gdai-00000001.json"), JSON.stringify(helloLine("gdai-00000001")));
      const cache = path.join(game.root, ".godot");
      await rm(cache, { recursive: true, force: true });
      if (what === "Godot's cache") await symlink(outside, cache);
      else {
        await mkdir(cache);
        await symlink(outside, path.join(cache, "genex"));
      }
      assert.equal(await game.channel.pull(signal), null, what);
      const reply: PlayAiOutgoing = {
        op: PlayAiOp.Reply,
        args: { rid: "gdai-00000001", reply: { v: GAME_AI_WIRE_VERSION, on: true } },
      };
      assert.equal(await game.channel.push([reply], signal), false, what);
      assert.deepEqual((await readdir(outside)).sort(), ["ai-in-gdai-00000001.json", "editor.json", "genex"], what);
      assert.deepEqual((await readdir(path.join(outside, "genex"))).sort(), [
        "ai-in-gdai-00000001.json",
        "editor.json",
      ]);
    }
  });

  it("hands the answers back as whole files whose names sort in the order they were given", async () => {
    const game = await project();
    const items = [
      { op: PlayAiOp.Delta, args: { rid: "gdai-00000001", text: "Once" } },
      { op: PlayAiOp.Reply, args: { rid: "gdai-00000002", reply: { v: GAME_AI_WIRE_VERSION, on: true } } },
      { op: PlayAiOp.Reply, args: { rid: "gdai-00000001", reply: { v: GAME_AI_WIRE_VERSION, on: false } } },
    ] as const;
    assert.equal(await game.channel.push(items.slice(0, 2), signal), true);
    assert.equal(await game.channel.push(items.slice(2), signal), true);
    const outs = (await readdir(game.folder)).filter((name) => name.startsWith("ai-out-")).sort();
    assert.equal(outs.length, 3);
    assert.ok(
      outs.every((name) => name.endsWith(".json")),
      "no partial file is left",
    );
    const read = await Promise.all(
      outs.map(async (name) => JSON.parse(await readFile(path.join(game.folder, name), "utf8"))),
    );
    assert.deepEqual(read, items);
  });
});
