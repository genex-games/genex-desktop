/**
 * The editor AI relays main keeps running (`main/game-ai/editor-relays.ts`, `editor-targets.ts`):
 * one per engine editor a library game is linked to. A line the game's SDK queued in Godot's
 * `.godot/genex/` folder, or in Unity's `GenexAiRelay` behind the editor's Pipeline server, is
 * answered through the relay; a person's play answers `ai_off` while Settings' "AI in your
 * playtests" is off (D1); a game unlinked is stopped. A link that leads out of the game's folder is
 * never relayed.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BRIDGE_FOLDER, godotAiChannel } from "../../src/plugins/godot/editor-bridge.ts";
import { AiRelayCode, unityAiChannel } from "../../src/plugins/unity/ai-relay.ts";
import { type EditorAiTarget, editorAiRelays } from "../../src/main/game-ai/editor-relays.ts";
import { editorAiTargets } from "../../src/main/game-ai/editor-targets.ts";
import { AiBridgeOp, AiErrorCode, GAME_AI_WIRE_VERSION } from "../../src/shared/game-ai.ts";
import { CoreFact, FactSource } from "../../src/shared/project-facts.ts";
import { PlayAiOp, PlayEvent } from "../../src/shared/play-protocol.ts";
import { fixtureAiService } from "../helpers/ai-fixture-service.ts";
import { editor, json, openProject } from "../helpers/unity-editor-stand-in.ts";
import { tmpDir } from "../helpers/tmp.ts";

const helloLine = (rid: string) => ({ event: PlayEvent.Ai, rid, op: AiBridgeOp.Hello, body: null });

/** A pause the relays take that lets the event loop turn, so a tick follows the last at once. */
const turn = async (_ms: number, signal: AbortSignal) => {
  if (!signal.aborted) await nextTurn();
};

/** Wait until `done` says so, a few hundred turns at most. */
async function until(done: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await done()) return;
    await nextTurn();
  }
  assert.fail(`timed out: ${what}`);
}

/** A Godot project whose editor beats that a scene plays, as the addon writes its heartbeat. */
async function godotProject() {
  const root = await realpath(await tmpDir("studio-editor-relays-godot-"));
  const folder = path.join(root, BRIDGE_FOLDER);
  await mkdir(folder, { recursive: true });
  const beat = () => writeFile(path.join(folder, "editor.json"), JSON.stringify({ at: Date.now(), playing: true }));
  await beat();
  return { root, folder, beat };
}

function relaysOver(targets: () => EditorAiTarget[], createRoute = true, running: string[] = []) {
  const fixture = fixtureAiService();
  const relays = editorAiRelays({
    service: fixture.service,
    targets: async () => targets(),
    runningGames: async () => new Set(running),
    createRouteEnabled: () => createRoute,
    pollMs: 1,
    syncMs: 1,
    sleep: turn,
  });
  return { relays, fixture };
}

describe("main's editor AI relays", () => {
  it("answers a line Godot's SDK queued, through the editor's own folder", async () => {
    const game = await godotProject();
    const clock = { now: () => Date.now(), sleep: async () => {} };
    const target: EditorAiTarget = {
      key: `godot:${game.root}`,
      game: { name: "pax", title: "Pax" },
      cwd: game.root,
      channel: godotAiChannel(game.root, clock),
    };
    const { relays, fixture } = relaysOver(() => [target]);
    await relays.sync();
    await writeFile(path.join(game.folder, "ai-in-gdai-00000001.json"), JSON.stringify(helloLine("gdai-00000001")));
    const answered = async () => (await readdir(game.folder)).some((name) => name.startsWith("ai-out-"));
    await until(answered, "the answer file");
    await relays.stop();
    const out = (await readdir(game.folder)).find((name) => name.startsWith("ai-out-")) ?? "";
    assert.deepEqual(JSON.parse(await readFile(path.join(game.folder, out), "utf8")), {
      op: PlayAiOp.Reply,
      args: { rid: "gdai-00000001", reply: { v: GAME_AI_WIRE_VERSION, on: true } },
    });
    assert.equal(fixture.asked[0]?.caller.game, "create:pax");
  });

  it("answers a line Unity's SDK queued, through the editor's Pipeline server", async () => {
    const root = await openProject();
    let pulls = 0;
    const pushed: string[] = [];
    const stand = editor(
      Array.from({ length: 400 }, () => async (request: { body?: unknown }) => {
        const code = (request.body as { parameters?: { code?: string } } | undefined)?.parameters?.code ?? "";
        if (code === AiRelayCode.Pull) {
          pulls += 1;
          const lines = pulls === 1 ? [JSON.stringify(helloLine("unai-00000001"))] : [];
          return json(200, { success: true, result: { playing: true, lines } });
        }
        pushed.push(code);
        return json(200, { success: true, result: true });
      }),
    );
    const target: EditorAiTarget = {
      key: `unity:${root}`,
      game: { name: "pax", title: "Pax" },
      cwd: root,
      channel: unityAiChannel(root, stand.deps),
    };
    const { relays } = relaysOver(() => [target]);
    await relays.sync();
    await until(() => pushed.length > 0, "the push");
    await relays.stop();
    const base64 = /Push\("([^"]+)"\)/.exec(pushed[0] ?? "")?.[1] ?? "";
    const answers = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    assert.deepEqual(answers, [
      { op: PlayAiOp.Reply, args: { rid: "unai-00000001", reply: { v: GAME_AI_WIRE_VERSION, on: true } } },
    ]);
  });

  it("answers ai_off to a person's editor play while AI in your playtests is off, and asks nothing", async () => {
    const game = await godotProject();
    const target: EditorAiTarget = {
      key: `godot:${game.root}`,
      game: { name: "pax", title: "Pax" },
      cwd: game.root,
      channel: godotAiChannel(game.root, { now: () => Date.now(), sleep: async () => {} }),
    };
    const { relays, fixture } = relaysOver(() => [target], false);
    await relays.sync();
    await writeFile(path.join(game.folder, "ai-in-gdai-00000001.json"), JSON.stringify(helloLine("gdai-00000001")));
    await until(async () => (await readdir(game.folder)).some((name) => name.startsWith("ai-out-")), "the answer");
    await relays.stop();
    const out = (await readdir(game.folder)).find((name) => name.startsWith("ai-out-")) ?? "";
    const reply = JSON.parse(await readFile(path.join(game.folder, out), "utf8")).args.reply;
    assert.ok(reply.on === false || reply.code === AiErrorCode.Off, JSON.stringify(reply));
    assert.equal(fixture.asked.length, 0);
  });

  it("starts a relay for a game linked since, and stops one unlinked", async () => {
    const a = await godotProject();
    const b = await godotProject();
    const clock = { now: () => Date.now(), sleep: async () => {} };
    const target = (root: string, name: string): EditorAiTarget => ({
      key: `godot:${root}`,
      game: { name, title: name },
      cwd: root,
      channel: godotAiChannel(root, clock),
    });
    let linked = [target(a.root, "a")];
    const { relays } = relaysOver(() => linked);
    await relays.sync();
    assert.deepEqual(relays.relayed(), [`godot:${a.root}`]);
    linked = [target(b.root, "b")];
    await relays.sync();
    assert.deepEqual(relays.relayed(), [`godot:${b.root}`]);
    await relays.stop();
    assert.deepEqual(relays.relayed(), []);
  });
});

describe("the editors a library's games are linked to", () => {
  const channels = {
    godot: (dir: string) => ({ engine: "godot", dir }),
    unity: (dir: string) => ({ engine: "unity", dir }),
  };
  const fact = (id: string, where: string) => ({ id, path: where, source: FactSource.Core });

  it("relays each Godot or Unity project inside its game's folder, by its real path", async () => {
    const games = await realpath(await tmpDir("studio-editor-targets-"));
    const pax = path.join(games, "pax");
    await mkdir(path.join(pax, "godot"), { recursive: true });
    const moss = path.join(games, "moss");
    await mkdir(moss, { recursive: true });
    const targets = await editorAiTargets(
      [
        { name: "pax", title: "Pax", dir: pax, facts: [fact(CoreFact.GodotProject, "godot")] },
        { name: "moss", title: "Moss", dir: moss, facts: [fact(CoreFact.UnityProject, ".")] },
        { name: "web", title: "Web", dir: moss, facts: [fact(CoreFact.WebGame, ".")] },
      ],
      channels,
    );
    assert.deepEqual(
      targets.map((target) => [target.key, target.game.name, target.cwd, target.channel]),
      [
        [
          `godot-project:${path.join(pax, "godot")}`,
          "pax",
          path.join(pax, "godot"),
          { engine: "godot", dir: path.join(pax, "godot") },
        ],
        [`unity-project:${moss}`, "moss", moss, { engine: "unity", dir: moss }],
      ],
    );
  });

  it("never relays a project that leads out of its game's folder", async () => {
    const games = await realpath(await tmpDir("studio-editor-targets-hostile-"));
    const outside = path.join(games, "outside");
    await mkdir(outside, { recursive: true });
    const pax = path.join(games, "pax");
    await mkdir(pax, { recursive: true });
    await symlink(outside, path.join(pax, "linked"));
    const hostile = [
      fact(CoreFact.GodotProject, "../outside"),
      fact(CoreFact.GodotProject, "linked"),
      fact(CoreFact.GodotProject, outside),
      fact(CoreFact.UnityProject, "missing"),
      fact(CoreFact.UnityProject, "a\u0000b"),
    ];
    const targets = await editorAiTargets([{ name: "pax", title: "Pax", dir: pax, facts: hostile }], channels);
    assert.deepEqual(targets, []);
  });
});
