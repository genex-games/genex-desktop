/**
 * A Play Protocol game (a Godot game Genex set up) is a native process with a window of its own.
 * Every chat turn on such a game hands its session a `computer`; handing it starts nothing. The game
 * starts on the session's first move, and its release stops it, so talking to a game never opens it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { TargetRuntime } from "../../src/shared/computer-target.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import { shellQuote } from "../../src/substrate/spawn.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FAKE_GAME = path.resolve(import.meta.dirname, "../fixtures/fake-play-game.mjs");
const POSIX_ONLY = process.platform === "win32" ? "the fake game is started by a POSIX shell script" : false;
/** How many times, 20 ms apart, the test looks for a stopped game's pid to be gone. */
const STOP_POLLS = 250;

/** The session's screen: a Play Protocol game draws its own frames, so it never asks for a window. */
const windowless = {
  loaded: null,
  handle: () => "pool:1",
  get: async () => assert.fail("a Play Protocol game has no browser window"),
  release: async () => {},
};

/** A bridge game whose `bin/game` starts the fake game, which writes its pid to `pidFile` once it runs. */
async function bridgeGame(pidFile: string): Promise<string> {
  const dir = await realpath(await tmpDir("bridge-start-game-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_GAME)} "$@"\n`;
  await writeFile(path.join(dir, "bin", "game"), script);
  await chmod(path.join(dir, "bin", "game"), 0o755);
  const play = { command: "bin/game", args: [`--pid-file=${pidFile}`] };
  await writeFile(path.join(dir, "studio.json"), JSON.stringify({ runtime: "bridge", play }));
  return dir;
}

/** The pid the fake game wrote, or null while it never ran. */
const pidIn = async (file: string): Promise<number | null> => {
  const text = await readFile(file, "utf8").catch(() => "");
  return text ? Number(text) : null;
};

describe("a Play Protocol game's computer", { skip: POSIX_ONLY }, () => {
  it("starts nothing when a session is handed it; the first move starts the game and the release stops it", async () => {
    const lite = await coreLite();
    after(() => lite.close());
    const pidFile = path.join(await realpath(await tmpDir("bridge-start-pid-")), "game.pid");
    const root = await bridgeGame(pidFile);
    const grant = { project: "bridge-game", root, handle: "pool:1", role: "builder" as const };
    const tools = await lite.core._computerToolsFor(
      grant,
      root,
      await tmpDir("bridge-start-frames-"),
      windowless as never,
    );
    after(() => tools.release());

    assert.equal(tools.runtime, TargetRuntime.Bridge);
    assert.ok(
      tools.liveTools.some((tool) => tool.name === COMPUTER_TOOL_NAME),
      "the session still gets its computer",
    );
    assert.equal(await pidIn(pidFile), null, "handing the session its computer starts no game");

    await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
    const pid = await pidIn(pidFile);
    assert.ok(pid !== null && running(pid), "the first move starts the game");

    await tools.release();
    for (let i = 0; i < STOP_POLLS && running(pid); i++) await sleep(20);
    assert.equal(running(pid), false, "the release stops it");
  });
});
