/**
 * After a publish, Genex closes the game's Roblox Studio itself as the publish turn ends, as the
 * person asked: only the Studio whose command line opened this game's place (its file, or its
 * published place id), once per publish, and never a turn that published nothing. A Mac runs one
 * Studio per place, so another place's Studio stays open. Over the fake Mac.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createRobloxBackend, RobloxAction, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import { CLOSE_MARK_MS } from "../../src/plugins/roblox/studio-close.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";

const ON_A_MAC = { skip: process.platform === "win32" && "the fake Mac helper is POSIX-only" };
const REMOTE = { placeId: "7781440219", universeId: "2650912" };
const STUDIO = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio";

/** A published game whose place file is linked, over a Mac whose open Studios run `commands` by pid. */
async function publishedGame(commands: (file: string) => Record<number, string>) {
  const mac = await robloxMac();
  const game = await makeGame(mac, "sky-race", "Sky Race");
  const file = path.join(game.directory, "sky-race.rbxlx");
  await writeFile(file, "<roblox/>");
  const host = hostFor(mac, game, { assist: () => ({ started: true }) });
  await host.context.host("game.engine.link" as never, { project: file, remote: REMOTE } as never);
  const running = commands(file);
  const quits: string[] = [];
  const run = mac.deps.run;
  mac.deps.run = async (program, args) => {
    if (program === "/usr/bin/pgrep") return { code: 0, stdout: `${Object.keys(running).join("\n")}\n` };
    if (program === "/bin/ps") return { code: 0, stdout: `${running[Number(args.at(-1))] ?? ""}\n` };
    if (program === "/usr/bin/osascript") quits.push(String(args.at(-1)));
    return run(program, args);
  };
  const backend = createRobloxBackend(mac.deps);
  const turnEnds = () =>
    backend.tool?.(RobloxTool.CloseAfterPublish, {}, { ...host.context, hook: { on: HookEvent.TurnEnd } });
  const publish = async () => {
    await backend.action?.(RobloxAction.PublishUpdate, {}, host.context);
    await backend.tool?.(RobloxTool.PublishResult, { published: true }, host.context);
  };
  return { mac, file, quits, turnEnds, publish };
}

describe("closing the game's Studio once its publish is done", ON_A_MAC, () => {
  it("quits only the Studio holding this game's place as the publish turn ends, once", async () => {
    const { quits, turnEnds, publish } = await publishedGame((file) => ({
      94330: `${STUDIO} --task EditPlace --placeId 123407532662045 --universeId 10773117051`,
      92718: `${STUDIO} --task EditFile --localPlaceFile ${file}`,
      92719: `${STUDIO} --task EditPlace --placeId ${REMOTE.placeId} --universeId ${REMOTE.universeId}`,
    }));
    await turnEnds();
    assert.deepEqual(quits, [], "a turn that published nothing closes nothing");
    await publish();
    await turnEnds();
    assert.deepEqual(quits.sort(), ["92718", "92719"], "its file's Studio and its published place's");
    await turnEnds();
    assert.equal(quits.length, 2, "the next turn's end closes nothing more");
  });

  const strangers: Array<{ name: string; command: (file: string) => string }> = [
    { name: "a longer place id", command: () => `${STUDIO} --task EditPlace --placeId ${REMOTE.placeId}0` },
    { name: "a file beside the game's", command: (file) => `${STUDIO} --task EditFile --localPlaceFile ${file}.bak` },
    { name: "a Studio with no place", command: () => STUDIO },
    { name: "another program naming the place", command: (file) => `/bin/cat ${file}` },
  ];
  for (const row of strangers) {
    it(`leaves ${row.name} open`, async () => {
      const { quits, turnEnds, publish } = await publishedGame((file) => ({ 5001: row.command(file) }));
      await publish();
      await turnEnds();
      assert.deepEqual(quits, []);
    });
  }

  it("closes nothing once the publish is older than its limit", async () => {
    const { mac, quits, turnEnds, publish } = await publishedGame((file) => ({
      92718: `${STUDIO} --task EditFile --localPlaceFile ${file}`,
    }));
    await publish();
    mac.advance(CLOSE_MARK_MS + 1);
    await turnEnds();
    assert.deepEqual(quits, []);
  });
});
