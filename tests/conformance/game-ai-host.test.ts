/**
 * Play-time AI composed for one profile (`main/game-ai/host.ts`): one service behind Play's bridge,
 * the Create Live route, native games and the IPC host; what it keeps loaded on start and kept
 * across a restart of the same profile; a build reaching the queue and the watcher once per change;
 * a Genex sign-in that changes stopping the credits grants; a library name that is not a real
 * folder of the library refused before anything is read; and dispose stopping the watcher.
 * genex.games, the engines and the library are stand-ins; nothing opens a socket.
 */
import { describe, it } from "node:test";
import { PlayEvent } from "../../src/shared/play-protocol.ts";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGameAi, type GameAiHostDeps, payerDoorOf, screenedByStand } from "../../src/main/game-ai/host.ts";
import { EngineId } from "../../src/shared/providers.ts";
import type { GalleryRequest } from "../../src/main/play/gallery.ts";
import { GRANTS_FILE } from "../../src/main/game-ai/budgets.ts";
import { AiWatcherState, GAME_AI_DIR } from "../../src/main/game-ai/types.ts";
import {
  AiBridgeOp,
  AiConsent,
  AiDoor,
  AiGrantStatus,
  AiRequirement,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { AiPickPolicy, GameAiNoticeKind, type GameAiNotice } from "../../src/shared/game-ai-views.ts";
import { heldClock } from "../helpers/game-ai-fakes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const OWN = "Moss Garden";
const DEV_MODEL = { door: AiDoor.GenexDev, engine: "genex", model: "anthropic/claude-haiku-4.5" } as const;

async function composed(
  options: { userData?: string; token?: () => string | undefined; editors?: GameAiHostDeps["editors"] } = {},
) {
  const userData = options.userData ?? (await tmpDir("game-ai-host-"));
  const library = await tmpDir("game-ai-host-library-");
  const gameDir = path.join(library, OWN);
  await mkdir(gameDir, { recursive: true });
  const outside = await tmpDir("game-ai-host-outside-");
  await symlink(outside, path.join(library, "Linked"));
  await writeFile(path.join(library, "a-file"), "not a folder");
  const watcher = { started: 0, stopped: 0, building: [] as boolean[] };
  const notices: GameAiNotice[] = [];
  const sent: string[] = [];
  let token = options.token ?? (() => "creator-token-1");
  const request: GalleryRequest = async (route) => {
    sent.push(route);
    if (route === "/api/credits/me") return { status: 200, body: { spendable: 900 } };
    return { status: 404, body: { error: "not_found" } };
  };
  const deps: GameAiHostDeps = {
    userData,
    clock: heldClock(),
    engines: () => null,
    calls: { admitGame: () => ({ ok: true }), recordGame: () => undefined },
    record: async () => undefined,
    notify: (notice) => void notices.push(notice),
    drawPill: () => undefined,
    genex: { request, token: async () => token() },
    openExternal: async () => undefined,
    checkoutOrigins: ["https://genex.games"],
    assertNative: () => undefined,
    library: {
      list: async () => [
        { name: OWN, dir: gameDir, title: "Moss Garden, the game" },
        { name: "Linked", dir: path.join(library, "Linked"), title: "Linked" },
        { name: "A file", dir: path.join(library, "a-file"), title: "A file" },
        { name: "Gone", dir: path.join(library, "gone"), title: "Gone" },
      ],
      playProject: async (project) => (project === OWN ? "proj_moss" : null),
    },
    capture: async () => null,
    watcher: {
      state: () => ({ state: AiWatcherState.Off, runners: [], resetsAt: null }),
      start: async () => void (watcher.started += 1),
      stop: async () => void (watcher.stopped += 1),
      nudge: () => undefined,
      building: (on) => void watcher.building.push(on),
    },
    demos: { play: async () => ({ ended: true, digests: [], status: null, missed: [], consoleErrors: 0 }) },
    queue: { slotWaitMs: 50, buildWaitMs: 20 },
    ...(options.editors ? { editors: options.editors } : {}),
  };
  const host = createGameAi(deps);
  await host.start();
  return {
    host,
    userData,
    watcher,
    notices,
    sent,
    setToken: (next: () => string | undefined) => {
      token = next;
    },
  };
}

describe("play-time AI for one profile", () => {
  it("answers Play's bridge, Create Live's route and a native game with the same service", async () => {
    const c = await composed();
    const ownCaller = {
      game: `create:${OWN}` as const,
      title: OWN,
      context: AiContext.CreateLive,
      ownGame: true,
      replaying: false,
      channel: "7",
    };
    await c.host.ipc.enable(ownCaller.game, false);
    const hello = { op: AiBridgeOp.Hello, body: null } as const;
    assert.deepEqual(await c.host.play.handle(ownCaller, hello), { v: GAME_AI_WIRE_VERSION, on: false });
    assert.deepEqual(await c.host.createRoute.service.handle(ownCaller, hello), { v: GAME_AI_WIRE_VERSION, on: false });
    const native = c.host.native({ name: OWN, title: OWN }, false);
    const nativeCaller = native.callerFor({ cwd: "/tmp", channel: "job-1" });
    assert.ok(nativeCaller);
    assert.equal(nativeCaller.context, AiContext.Native);
    assert.deepEqual(await native.service.handle(nativeCaller, hello), { v: GAME_AI_WIRE_VERSION, on: false });
    assert.deepEqual(await c.host.createRoute.game(OWN), { title: "Moss Garden, the game", ownGame: true });
  });

  it("keeps what the person set across a restart of the same profile", async () => {
    const first = await composed();
    await first.host.ipc.saveSettings({ pick: AiPickPolicy.FreeOnly, createRouteEnabled: true });
    await first.host.ipc.enable(`create:${OWN}`, false);
    await first.host.dispose();
    const again = await composed({ userData: first.userData });
    const view = await again.host.ipc.settings();
    assert.equal(view.pick, AiPickPolicy.FreeOnly);
    assert.equal(view.createRouteEnabled, true);
    assert.equal(view.signedIn, true);
    assert.equal(view.balanceCredits, 900);
    const hello = await again.host.service.handle(
      {
        game: `create:${OWN}`,
        title: OWN,
        context: AiContext.CreateLive,
        ownGame: true,
        replaying: false,
        channel: "1",
      },
      { op: AiBridgeOp.Hello, body: null },
    );
    assert.deepEqual(hello, { v: GAME_AI_WIRE_VERSION, on: false }, "the game's AI stays off");
  });

  it("starts the watcher with play-time AI, tells it and the queue of a build once per change, and stops it on dispose", async () => {
    const c = await composed();
    assert.equal(c.watcher.started, 1);
    c.host.building(true);
    c.host.building(true);
    c.host.building(false);
    assert.deepEqual(c.watcher.building, [true, false]);
    await c.host.dispose();
    assert.equal(c.watcher.stopped, 1);
  });

  it("relays its linked editors once started, a person's play off by default (D1), and stops them on dispose", async () => {
    const queued: unknown[][] = [[{ event: PlayEvent.Ai, rid: "rid-00000001", op: AiBridgeOp.Hello, body: null }]];
    const pushed: unknown[] = [];
    let pulls = 0;
    const channel = {
      pull: async () => {
        pulls += 1;
        return queued.shift() ?? [];
      },
      push: async (items: readonly unknown[]) => {
        pushed.push(...items);
        return true;
      },
    };
    const c = await composed({
      editors: {
        targets: async () => [{ key: "godot-project:/g", game: { name: OWN, title: OWN }, cwd: "/g", channel }],
        runningGames: async () => new Set(),
      },
    });
    for (let i = 0; i < 500 && pushed.length === 0; i++) await nextTurn();
    assert.ok(pulls > 0, "the editor is pulled once play-time AI starts");
    const reply = (pushed[0] as { args: { reply: { on: boolean } } } | undefined)?.args.reply;
    assert.equal(reply?.on, false, "Create Live answers ai_off while AI in your playtests is off");
    await c.host.dispose();
    const after = pulls;
    for (let i = 0; i < 50; i++) await nextTurn();
    assert.equal(pulls, after, "nothing is pulled after dispose");
  });

  it("stops the credits grants when the Genex account Studio is signed in as changes", async () => {
    const userData = await tmpDir("game-ai-host-");
    const game = `create:${OWN}` as const;
    await mkdir(path.join(userData, GAME_AI_DIR), { recursive: true });
    await writeFile(
      path.join(userData, GAME_AI_DIR, GRANTS_FILE),
      JSON.stringify({
        v: 1,
        grants: [
          {
            id: "g_credits0001",
            game,
            door: AiDoor.GenexDev,
            model: DEV_MODEL,
            status: AiGrantStatus.Active,
            consent: AiConsent.Card,
            consentedAt: "2026-10-20T09:00:00.000Z",
            lastUsedAt: null,
            spentMicros: 0,
            todayMicros: 0,
            day: "2026-10-20",
            monthMicros: 0,
            month: "2026-10",
            requires: AiRequirement.Optional,
          },
        ],
        consents: [{ game, door: AiDoor.GenexDev }],
        off: [],
        alerts: {},
      }),
    );
    const c = await composed({ userData });
    assert.equal((await c.host.ipc.activity()).games.find((row) => row.game === game)?.on, true);
    // The same account read again changes nothing.
    await c.host.ipc.settings();
    assert.ok((await c.host.ipc.activity()).games.some((row) => row.game === game));
    c.setToken(() => "creator-token-2");
    await c.host.ipc.settings();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await c.host.ipc.activity()).games.find((row) => row.game === game),
      undefined,
      "the grant agreed under the other account no longer spends",
    );
    assert.ok(c.notices.some((notice) => notice.kind === GameAiNoticeKind.Changed));
  });

  it("refuses a name that is not a real folder of the library before anything is read", async () => {
    const c = await composed();
    for (const project of ["Linked", "A file", "Gone", "Elsewhere", "../Moss Garden"]) {
      await assert.rejects(c.host.ipc.tapes(project), project);
      await assert.rejects(c.host.ipc.check(project), project);
      await assert.rejects(c.host.ipc.publishFacts(project), project);
      await assert.rejects(c.host.harness.tapes(project, { root: null }), project);
      await assert.rejects(c.host.inbox.inbox(project), project);
    }
    assert.deepEqual(await c.host.ipc.tapes(OWN), []);
  });

  it("names the door each payer's change stops: a key, a plan account, OpenCode's sign-in", () => {
    assert.equal(payerDoorOf(EngineId.OpenRouter), AiDoor.Byok);
    assert.equal(payerDoorOf(EngineId.ClaudeCode), AiDoor.Plan);
    assert.equal(payerDoorOf(EngineId.OpenCode), AiDoor.OpenCode);
    for (const engine of [EngineId.Codex, EngineId.Ollama, "nothing", ""])
      assert.equal(payerDoorOf(engine), null, engine);
  });

  it("lets shared text through only from a door genex.games screens (D6)", async () => {
    for (const door of Object.values(AiDoor)) {
      const screened = door === AiDoor.GenexDev || door === AiDoor.GenexCredits;
      assert.equal(await screenedByStand("hello all", door), screened, door);
    }
  });
});
