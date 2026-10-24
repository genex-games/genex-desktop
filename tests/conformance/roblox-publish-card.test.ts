/**
 * Studio's publishing card for a Roblox game: a publish the game's chat takes is recorded, and
 * `publish-status` answers where it stands, so the card follows it while the agent clicks it in
 * Roblox Studio. It ends when the agent says so (`publish-result`), when Roblox has the game's place
 * after a first publish, or on its own once the clicking turn can no longer hold computer control.
 * A publish the chat never took leaves no record, and the record is read only as Genex wrote it.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginEngineAssistAnswer } from "../../src/plugin-sdk/index.d.ts";
import { createRobloxBackend, RobloxAction, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import {
  attemptNow,
  endAttempt,
  MAX_DETAIL_CHARS,
  PUBLISH_ATTEMPT_MS,
  readAttempt,
  writeAttempt,
} from "../../src/plugins/roblox/publish-attempt.ts";
import {
  RobloxPublishKind,
  RobloxPublishPhase,
  type RobloxPublishState,
  robloxGameUrl,
} from "../../src/shared/roblox-publish.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ON_A_MAC = { skip: process.platform === "win32" && "the fake Mac helper is POSIX-only" };
const REMOTE = { placeId: "7781440219", universeId: "2650912" };
const GAME = "sky-race";

/** A game whose place file is linked, published on Roblox or never, over a host whose assist answers `answer`. */
async function linkedGame(published: boolean, answer: PluginEngineAssistAnswer = { started: true }) {
  const mac = await robloxMac();
  const game = await makeGame(mac, GAME, "Sky Race");
  const file = path.join(game.directory, "sky-race.rbxlx");
  await writeFile(file, "<roblox/>");
  const host = hostFor(mac, game, { assist: () => answer });
  await host.context.host(
    "game.engine.link" as never,
    { project: file, ...(published ? { remote: REMOTE } : {}) } as never,
  );
  const backend = createRobloxBackend(mac.deps);
  const status = async () =>
    (await backend.action?.(RobloxAction.PublishStatus, {}, host.context)) as RobloxPublishState;
  return { mac, game, file, host, backend, status };
}

describe("the publish record", () => {
  const publishing = { phase: RobloxPublishPhase.Publishing, kind: RobloxPublishKind.Update, at: 1_000 };

  it("reads back as written, and only as one", async () => {
    const storage = await tmpDir("roblox-attempt-");
    await writeAttempt(storage, GAME, { ...publishing, name: "Sky Race" });
    assert.deepEqual(await readAttempt(storage, GAME), { ...publishing, name: "Sky Race" });
    const file = path.join(storage, "publish-attempts", `${GAME}.json`);
    for (const bad of [
      "{",
      "[]",
      JSON.stringify({ ...publishing, phase: "live" }),
      JSON.stringify({ ...publishing, at: "now" }),
    ]) {
      await writeFile(file, bad);
      assert.equal(await readAttempt(storage, GAME), undefined, bad);
    }
  });

  it("is never written or read outside its folder for a game id that isn't one", async () => {
    const storage = await tmpDir("roblox-attempt-");
    for (const game of ["../escape", "a/b", "", ".."]) {
      await writeAttempt(storage, game, publishing);
      assert.equal(await readAttempt(storage, game), undefined, game);
    }
    await mkdir(path.join(storage, "publish-attempts"), { recursive: true });
  });

  it("a first publish under way is published once Roblox has the place; any publish stops past its limit", () => {
    const first = { ...publishing, kind: RobloxPublishKind.First };
    assert.equal(attemptNow(first, true, 2_000).phase, RobloxPublishPhase.Published);
    assert.equal(
      attemptNow(publishing, true, 2_000).phase,
      RobloxPublishPhase.Publishing,
      "an update waits for the agent",
    );
    assert.equal(attemptNow(publishing, false, 1_000 + PUBLISH_ATTEMPT_MS + 1).phase, RobloxPublishPhase.Stopped);
    const ended = { ...publishing, phase: RobloxPublishPhase.Stopped };
    assert.equal(attemptNow(ended, true, 2_000), ended, "an ended one stays as it ended");
  });

  it("ends only while under way, with the agent's words as one plain line", async () => {
    const storage = await tmpDir("roblox-attempt-");
    assert.equal(await endAttempt(storage, GAME, { published: true }, 2_000), false, "nothing under way");
    await writeAttempt(storage, GAME, publishing);
    const detail = `Roblox asks for an age check\n\tin Studio.${"x".repeat(400)}`;
    assert.equal(await endAttempt(storage, GAME, { published: false, detail }, 2_000), true);
    const ended = await readAttempt(storage, GAME);
    assert.equal(ended?.phase, RobloxPublishPhase.Stopped);
    assert.ok(ended?.detail?.startsWith("Roblox asks for an age check in Studio."));
    assert.equal(ended?.detail?.length, MAX_DETAIL_CHARS);
    assert.equal(await endAttempt(storage, GAME, { published: true }, 3_000), false, "an ended one stays ended");
    await writeAttempt(storage, GAME, publishing);
    assert.equal(
      await endAttempt(storage, GAME, { published: true }, 1_000 + PUBLISH_ATTEMPT_MS + 1),
      false,
      "too late",
    );
  });

  it("a place's page on Roblox only for a place id", () => {
    assert.equal(robloxGameUrl("7781440219"), "https://www.roblox.com/games/7781440219");
    for (const bad of [undefined, "", "12a", "../1", "1".repeat(21)]) assert.equal(robloxGameUrl(bad), undefined, bad);
  });
});

describe("publish-status and publish-result through the backend", () => {
  it(
    "a published place's update: under way once the chat takes it, published once the agent says so",
    ON_A_MAC,
    async () => {
      const { host, backend, status } = await linkedGame(true);
      const before = await status();
      assert.deepEqual(
        { linked: before.linked, published: before.published, placeId: before.placeId, attempt: before.attempt },
        { linked: true, published: true, placeId: REMOTE.placeId, attempt: undefined },
      );
      const pressed = (await backend.action?.(RobloxAction.PublishUpdate, {}, host.context)) as { started: boolean };
      assert.equal(pressed.started, true);
      const under = await status();
      assert.equal(under.attempt?.phase, RobloxPublishPhase.Publishing);
      assert.equal(under.attempt?.kind, RobloxPublishKind.Update);
      const said = String(await backend.tool?.(RobloxTool.PublishResult, { published: true }, host.context));
      assert.match(said, /card shows it/);
      assert.equal((await status()).attempt?.phase, RobloxPublishPhase.Published);
      const again = String(await backend.tool?.(RobloxTool.PublishResult, { published: false }, host.context));
      assert.match(again, /No publish is under way/);
      assert.equal((await status()).attempt?.phase, RobloxPublishPhase.Published, "a second word changes nothing");
    },
  );

  it("a first publish carries its name and is published once Roblox has the place", ON_A_MAC, async () => {
    const { host, backend, status, file } = await linkedGame(false);
    const before = await status();
    assert.equal(before.published, false);
    assert.equal(before.name, "Sky Race");
    await backend.action?.(RobloxAction.FirstPublish, { name: "Sky Racers" }, host.context);
    const under = await status();
    assert.deepEqual(
      { phase: under.attempt?.phase, kind: under.attempt?.kind, name: under.attempt?.name },
      { phase: RobloxPublishPhase.Publishing, kind: RobloxPublishKind.First, name: "Sky Racers" },
    );
    // Genex links the game to the published place (relink.ts): Roblox has it now.
    await host.context.host("game.engine.link" as never, { project: file, remote: REMOTE } as never);
    const after = await status();
    assert.equal(after.attempt?.phase, RobloxPublishPhase.Published);
    assert.equal(after.placeId, REMOTE.placeId);
  });

  it("the agent's stop shows its words on the card", ON_A_MAC, async () => {
    const { host, backend, status } = await linkedGame(true);
    await backend.action?.(RobloxAction.PublishUpdate, {}, host.context);
    const detail = "Roblox asks you to verify your age in Studio's publish window.";
    await backend.tool?.(RobloxTool.PublishResult, { published: false, detail }, host.context);
    const after = await status();
    assert.equal(after.attempt?.phase, RobloxPublishPhase.Stopped);
    assert.equal(after.attempt?.detail, detail);
  });

  it("a publish the chat never took leaves no record", ON_A_MAC, async () => {
    const { host, backend, status } = await linkedGame(true, { started: false, reason: "declined" });
    const answer = (await backend.action?.(RobloxAction.PublishUpdate, {}, host.context)) as { started: boolean };
    assert.equal(answer.started, false);
    assert.equal((await status()).attempt, undefined);
  });

  it("a game with no place says so and has nothing under way", ON_A_MAC, async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, GAME, "Sky Race");
    const host = hostFor(mac, game);
    const state = (await createRobloxBackend(mac.deps).action?.(
      RobloxAction.PublishStatus,
      {},
      host.context,
    )) as RobloxPublishState;
    assert.equal(state.linked, false);
    assert.equal(state.published, false);
    assert.equal(state.attempt, undefined);
  });
});
