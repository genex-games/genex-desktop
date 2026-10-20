/**
 * Play-time AI's own folder (`userData/game-ai`: grants, settings, the ledger) is a protected path
 * (`StudioCore.#protectedPaths`): no agent process may write it, so no agent can grant itself AI or
 * raise a limit, and no game may be created inside it — through a link either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { GAME_AI_DIR } from "../../src/main/game-ai/types.ts";
import { coreLite } from "../helpers/core-lite.ts";

const posixOnly = process.platform === "win32" && "POSIX links";

describe("play-time AI's protected folder", () => {
  it("is out of reach of every agent process: no read, no write", async () => {
    const { core, userData } = await coreLite();
    const own = path.join(userData, GAME_AI_DIR);
    assert.ok(core.sandbox.policy.denyWrite.includes(own), "no agent writes its own grants or limits");
    assert.ok(core.sandbox.policy.denyRead.includes(own), "nor reads what the person spends");
    assert.ok(!core.sandbox.policy.allowWrite.some((root) => own.startsWith(root)), "inside no writable root");
  });

  it("refuses a game inside userData/game-ai, also through a link, before anything is written", {
    skip: posixOnly,
  }, async () => {
    // A launch without the development policy, as the normal profile runs.
    const { core, userData } = await coreLite({ executionPolicy: { runBackgroundImprovement: false } });
    const own = path.join(userData, GAME_AI_DIR);
    await mkdir(path.join(own, "inner"), { recursive: true });
    const elsewhere = path.join(path.dirname(userData), "pointer");
    await symlink(own, elsewhere);
    for (const parent of [own, path.join(own, "inner"), elsewhere]) {
      await assert.rejects(core.gameLocation(parent), /can't create games there/, parent);
      await assert.rejects(core.createGame("Grant Myself AI", { parent }), /can't create games there/, parent);
    }
    assert.deepEqual(await readdir(own), ["inner"]);
    assert.deepEqual(await readdir(path.join(own, "inner")), []);
  });
});
