/**
 * Play-time AI in Play: a published game's page reaches main only through the Play view's preload,
 * as numbered envelopes main attributes per message to the game on screen (`main/game-ai/bridge-play.ts`).
 * A message from a frame inside the page, from another origin, from a page that moved to another
 * game or slug, past a burst, or asking for money without a person's gesture gets nothing done: no
 * bridge call, no card, no genex.games request. The embed-sdk's desktop confirm (D3) draws Genex's
 * card instead of a popup and answers on genex.games only after the person's yes. Play's session
 * refuses an AI vendor's API (D5) with a typed console line, and lets a near miss load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import {
  createGameAiPlayBridge,
  PLAY_AI_GESTURE_MS,
  type PlayAiGame,
  playAiPort,
  type PlayAiPortDeps,
  type PlayBridgeDeps,
  playCallerFor,
} from "../../src/main/game-ai/bridge-play.ts";
import { aiGatewayVerdict, blockedNotes, BLOCKED_NOTES_MAX } from "../../src/main/play/ai-gateway.ts";
import { type GameAiCaller, GameAiNativeStep, type GameAiPlayBridge } from "../../src/main/game-ai/types.ts";
import { installPlayAi, type PlayAiPageWords } from "../../src/preload/play-ai-page.ts";
import { AiVendor } from "../../src/shared/ai-vendors.ts";
import {
  type AiCallRequest,
  AiAuthority,
  AiBridgeOp,
  AiDoor,
  AiErrorCode,
  AiProvenance,
  AiOp,
  AiRequirement,
  AiTier,
  GAME_AI_WIRE_VERSION,
  playGameKey,
} from "../../src/shared/game-ai.ts";
import type { AiBridgeAnswers, AiBridgeBodies, AiBridgeMessage } from "../../src/shared/game-ai-bridge.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import {
  AI_CONSENT_TTL_MS,
  type AiConsentAnswer,
  AiConsentKind,
  type AiConsentTicket,
} from "../../src/shared/game-ai-views.ts";
import {
  GENEX_DESKTOP_BRIDGE_VERSION,
  GENEX_DESKTOP_GLOBAL,
  GenexConfirmKind,
  type GenexDesktopConfirmRequest,
  genexDesktopBridgeOf,
} from "../../src/shared/genex-desktop-bridge.ts";
import {
  PLAY_AI_BURST,
  PLAY_AI_MAX_ENVELOPE_ID,
  PLAY_AI_MAX_PENDING,
  PLAY_AI_WINDOW_MS,
  type PlayAiBlocked,
  type PlayAiDelta,
  type PlayAiReply,
  PlayBridgeOp,
  type GenexDesktopWindow,
} from "../../src/shared/play-ai.ts";

const SLUG = "crowns-1444";
const GAME_ORIGIN = `https://${SLUG}.genex.technology`;
const ADDRESS = `${GAME_ORIGIN}/?genex_r=1#genex_ticket=T1`;
const GAME: PlayAiGame = { projectId: "cm-crowns", title: "Crowns of 1444", address: ADDRESS };
const KEY = playGameKey(GAME.projectId);
const TOP = { url: `${GAME_ORIGIN}/`, top: true };
const CONFIRM: GenexDesktopConfirmRequest = { kind: GenexConfirmKind.Grant, id: "grant_123" };

const call = (ticket = "ticket-0001", over: Partial<AiCallRequest> = {}): AiCallRequest => ({
  v: GAME_AI_WIRE_VERSION,
  op: AiOp.Say,
  site: "npc.line",
  ticket,
  grantId: "grant-0001",
  system: null,
  prompt: "Say hello",
  untrusted: {},
  memory: null,
  schema: null,
  tier: AiTier.Fast,
  authority: AiAuthority.Local,
  maxOutputTokens: 64,
  stream: true,
  ...over,
});
const GRANT_BODY = { v: GAME_AI_WIRE_VERSION, requires: AiRequirement.Ai, tiers: [AiTier.Fast] };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("Play AI: who is calling", () => {
  it("is the game on screen, keyed by its genex.games project id, in desktop Play", () => {
    assert.deepEqual(playCallerFor(GAME, `${GAME_ORIGIN}/level/2?x=1#y`, "41"), {
      game: KEY,
      title: GAME.title,
      context: AiContext.DesktopPlay,
      ownGame: false,
      replaying: false,
      channel: "41",
    });
  });

  const hostile: Array<[string, PlayAiGame | null, string]> = [
    ["no game open", null, `${GAME_ORIGIN}/`],
    ["another game's address (a renamed or reused slug)", GAME, "https://crowns-1445.genex.technology/"],
    ["a subdomain of the game's host", GAME, `https://evil.${SLUG}.genex.technology/`],
    ["plain http on the game's host", GAME, `http://${SLUG}.genex.technology/`],
    ["another port", GAME, `${GAME_ORIGIN}:8443/`],
    ["a user in the address", GAME, `https://x@${SLUG}.genex.technology/`],
    ["the website", GAME, "https://genex.games/play/grant"],
    ["a look-alike host", GAME, `https://${SLUG}.genex.technology.evil.io/`],
    ["about:blank", GAME, "about:blank"],
    ["a blob of the game's origin", GAME, `blob:${GAME_ORIGIN}/9d2c`],
    ["not an address", GAME, "::"],
    ["an empty address", GAME, ""],
    ["a project id with a slash", { ...GAME, projectId: "a/b" }, `${GAME_ORIGIN}/`],
    ["an empty project id", { ...GAME, projectId: "" }, `${GAME_ORIGIN}/`],
    ["an address the viewer never opens", { ...GAME, address: "file:///tmp/game.html" }, "file:///tmp/game.html"],
  ];
  for (const [name, game, url] of hostile)
    it(`refuses ${name}`, () => assert.equal(playCallerFor(game, url, "41"), null));

  it("a fixture launch's stand-in page is the game only at the very address the viewer opened", () => {
    const page = "data:text/html;charset=utf-8,%3Ch1%3ESnowball%3C%2Fh1%3E";
    const fixture: PlayAiGame = { ...GAME, address: page };
    assert.equal(playCallerFor(fixture, page, "7")?.game, KEY);
    assert.equal(playCallerFor(fixture, "data:text/html;charset=utf-8,%3Ch1%3Eother", "7"), null);
  });
});

/** What a fake bridge answers each op with. */
type FakeAnswers = {
  [O in AiBridgeOp]?: (body: AiBridgeBodies[O], onDelta?: (text: string) => void) => Promise<AiBridgeAnswers[O]>;
};

/** A fake of the service's typed `handle`, answering each op from `answers`; any other op throws. */
function handleFrom(answers: FakeAnswers): GameAiPlayBridge["handle"] {
  return async <M extends AiBridgeMessage>(_caller: GameAiCaller, message: M, onDelta?: (text: string) => void) => {
    // A table keyed by op answers that op's body: TypeScript cannot follow the key to its value.
    const answer = answers[message.op] as
      | ((body: M["body"], onDelta?: (text: string) => void) => Promise<AiBridgeAnswers[M["op"]]>)
      | undefined;
    if (!answer) throw new Error(`unexpected ${message.op}`);
    return answer(message.body, onDelta);
  };
}

/** A port over a recording bridge, its clock held by the test. */
function portRig(
  options: {
    bridge?: Partial<Omit<GameAiPlayBridge, "handle">> | null;
    answers?: FakeAnswers;
    game?: PlayAiGame | null;
  } = {},
) {
  let now = 1_000_000;
  let page = `${GAME_ORIGIN}/`;
  let live = true;
  const replies: PlayAiReply[] = [];
  const deltas: PlayAiDelta[] = [];
  const handled: Array<{ caller: GameAiCaller; op: string; body: unknown }> = [];
  const confirms: GenexDesktopConfirmRequest[] = [];
  const abandoned: string[] = [];
  const answer = handleFrom(
    options.answers ?? { [AiBridgeOp.Hello]: async () => ({ v: GAME_AI_WIRE_VERSION, on: true }) },
  );
  const bridge: GameAiPlayBridge = {
    confirm: async (_caller, request) => {
      confirms.push(request);
      return { approved: true };
    },
    abandon: (channel) => abandoned.push(channel),
    ...options.bridge,
    // Every op the bridge is handed is recorded, whatever answers it.
    handle: (caller, message, onDelta) => {
      handled.push({ caller, op: message.op, body: message.body });
      return answer(caller, message, onDelta);
    },
  };
  const deps: PlayAiPortDeps = {
    bridge: options.bridge === null ? null : bridge,
    game: async () => (options.game === undefined ? GAME : options.game),
    pageUrl: () => page,
    live: () => live,
    channel: "41",
    send: { reply: (reply) => replies.push(reply), delta: (delta) => deltas.push(delta) },
    clock: { now: () => now },
  };
  const port = playAiPort(deps);
  return {
    port,
    replies,
    deltas,
    handled,
    confirms,
    abandoned,
    advance: (ms: number) => {
      now += ms;
    },
    moveTo: (url: string) => {
      page = url;
    },
    kill: () => {
      live = false;
    },
    /** A person's click on the game, as main saw it reach the page. */
    click: () => port.input({ type: "mouseDown" }),
  };
}

const hello = (id: number) => ({ id, op: AiBridgeOp.Hello, body: null });

describe("Play AI: the bridge's port", () => {
  it("answers the game's top frame, attributed to the game on screen", async () => {
    const { port, replies, handled } = portRig();
    await port.request(TOP, hello(1), false);
    assert.deepEqual(replies, [{ id: 1, op: AiBridgeOp.Hello, body: { v: GAME_AI_WIRE_VERSION, on: true } }]);
    assert.equal(handled[0]?.caller.game, KEY);
    assert.equal(handled[0]?.caller.channel, "41");
  });

  const dropped: Array<[string, { url: string; top: boolean }, unknown]> = [
    ["a frame inside the page", { url: `${GAME_ORIGIN}/ad.html`, top: false }, hello(1)],
    ["another origin's top frame", { url: "https://evil.io/", top: true }, hello(1)],
    ["a renamed slug's address", { url: "https://crowns-of-1444.genex.technology/", top: true }, hello(1)],
    ["a malformed envelope", TOP, { id: 1, op: AiBridgeOp.Hello, body: null, extra: 1 }],
    ["an envelope with id 0", TOP, { id: 0, op: AiBridgeOp.Hello, body: null }],
    ["an envelope past the last id", TOP, { id: PLAY_AI_MAX_ENVELOPE_ID + 1, op: AiBridgeOp.Hello, body: null }],
    ["an unknown op", TOP, { id: 1, op: "budget.grant", body: null }],
    ["a string", TOP, "hello"],
  ];
  for (const [name, frame, raw] of dropped)
    it(`does nothing for ${name}`, async () => {
      const { port, replies, handled, confirms } = portRig();
      await port.request(frame, raw, true);
      assert.deepEqual([replies, handled, confirms], [[], [], []]);
    });

  it("does nothing while no game's facts are read", async () => {
    const { port, replies, handled } = portRig({ game: null });
    await port.request(TOP, hello(1), false);
    assert.deepEqual([replies, handled], [[], []]);
  });
});

describe("Play AI: the port's limits and gestures", () => {
  it("drops a burst past its window's share unanswered, and hears the page again in the next window", async () => {
    const { port, replies, handled, advance } = portRig();
    for (let id = 1; id <= PLAY_AI_BURST + 3; id += 1) await port.request(TOP, hello(id), false);
    assert.equal(handled.length, PLAY_AI_BURST);
    assert.deepEqual(
      replies.map((reply) => reply.id),
      Array.from({ length: PLAY_AI_BURST }, (_, index) => index + 1),
    );
    advance(PLAY_AI_WINDOW_MS);
    await port.request(TOP, hello(99), false);
    assert.equal(replies.at(-1)?.id, 99);
  });

  it("refuses a grant asked outside a person's gesture without asking anyone", async () => {
    const { port, replies, handled, click, advance } = portRig();
    const ask = (id: number, gesture: unknown) =>
      port.request(TOP, { id, op: AiBridgeOp.BudgetRequest, body: GRANT_BODY }, gesture);
    // The page's own world said a gesture, but main saw no input reach the page.
    await ask(1, true);
    click();
    // Main saw a click, but the page's isolated world saw no activation (or the page forged the bit).
    await ask(2, false);
    await ask(3, "true");
    // A click too long ago.
    advance(PLAY_AI_GESTURE_MS + 1);
    await ask(4, true);
    const refused = { view: null, code: AiErrorCode.NoGesture };
    assert.deepEqual(
      replies,
      [1, 2, 3, 4].map((id) => ({ id, op: AiBridgeOp.BudgetRequest, body: refused })),
    );
    assert.deepEqual(handled, []);
  });

  it("a held Escape is no gesture; a click or a key is", async () => {
    const answer = { view: null, code: AiErrorCode.ConsentDeclined };
    const answers: FakeAnswers = { [AiBridgeOp.BudgetRequest]: async () => answer };
    for (const [input, passes] of [
      [{ type: "keyDown", keyCode: "Escape" }, false],
      [{ type: "mouseMove" }, false],
      [{ type: "rawKeyDown", keyCode: "Space" }, true],
      [{ type: "mouseDown" }, true],
      [{ type: "touchEnd" }, true],
    ] as const) {
      const { port, replies, handled } = portRig({ answers });
      port.input(input);
      await port.request(TOP, { id: 1, op: AiBridgeOp.BudgetRequest, body: GRANT_BODY }, true);
      assert.equal(handled.length, passes ? 1 : 0, JSON.stringify(input));
      assert.deepEqual(replies[0]?.body, passes ? answer : { view: null, code: AiErrorCode.NoGesture });
    }
  });

  it("a Genex confirm outside a gesture is not approved, and genex.games is never asked", async () => {
    const { port, replies, confirms } = portRig();
    await port.request(TOP, { id: 5, op: PlayBridgeOp.GenexConfirm, body: CONFIRM }, true);
    assert.deepEqual(replies, [{ id: 5, op: PlayBridgeOp.GenexConfirm, body: { approved: false } }]);
    assert.deepEqual(confirms, []);
  });

  it("a Genex confirm inside a gesture reaches the bridge with the game on screen", async () => {
    const { port, replies, confirms, click } = portRig();
    click();
    await port.request(TOP, { id: 5, op: PlayBridgeOp.GenexConfirm, body: CONFIRM }, true);
    assert.deepEqual(confirms, [CONFIRM]);
    assert.deepEqual(replies, [{ id: 5, op: PlayBridgeOp.GenexConfirm, body: { approved: true } }]);
  });
});

describe("Play AI: the port's unanswered envelopes", () => {
  it("holds at most a few envelopes unanswered: past them a call answers grant_concurrency, a cancel still goes", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const answers: FakeAnswers = {
      [AiBridgeOp.Cancel]: async () => ({ canceled: true }),
      [AiBridgeOp.Call]: async (body) => {
        const gate = deferred<void>();
        gates.set(body.ticket, gate);
        await gate.promise;
        return {
          v: GAME_AI_WIRE_VERSION,
          ok: true,
          ticket: body.ticket,
          value: "hi",
          source: AiDoor.Local,
          provenance: AiProvenance.Unverified,
          latencyMs: 3,
          cached: false,
        };
      },
    };
    const { port, replies, handled } = portRig({ answers });
    const running: Promise<void>[] = [];
    for (let id = 1; id <= PLAY_AI_MAX_PENDING; id += 1)
      running.push(port.request(TOP, { id, op: AiBridgeOp.Call, body: call(`ticket-000${id}`) }, false));
    await tick();
    await port.request(TOP, { id: 50, op: AiBridgeOp.Call, body: call("ticket-0050") }, false);
    assert.deepEqual(replies, [
      {
        id: 50,
        op: AiBridgeOp.Call,
        body: {
          v: GAME_AI_WIRE_VERSION,
          ok: false,
          ticket: "ticket-0050",
          code: AiErrorCode.Concurrency,
          retryAfterMs: null,
        },
      },
    ]);
    await port.request(TOP, { id: 51, op: AiBridgeOp.Cancel, body: { ticket: "ticket-0001" } }, false);
    assert.deepEqual(replies.at(-1), { id: 51, op: AiBridgeOp.Cancel, body: { canceled: true } });
    for (const gate of gates.values()) gate.resolve();
    await Promise.all(running);
    assert.equal(handled.filter((entry) => entry.op === AiBridgeOp.Call).length, PLAY_AI_MAX_PENDING);
    assert.equal(replies.length, PLAY_AI_MAX_PENDING + 2);
  });

  it("an envelope reusing the id of one still unanswered is dropped", async () => {
    const gate = deferred<void>();
    const answers: FakeAnswers = {
      [AiBridgeOp.Hello]: async () => {
        await gate.promise;
        return { v: GAME_AI_WIRE_VERSION, on: true };
      },
    };
    const { port, replies, handled } = portRig({ answers });
    const first = port.request(TOP, hello(3), false);
    await tick();
    await port.request(TOP, hello(3), false);
    gate.resolve();
    await first;
    assert.equal(handled.length, 1);
    assert.equal(replies.length, 1);
  });
});

describe("Play AI: the port across navigations", () => {
  it("streams a say's text to the envelope that asked, and only while that page is on screen", async () => {
    const gate = deferred<void>();
    let speak: (text: string) => void = () => {};
    const answers: FakeAnswers = {
      [AiBridgeOp.Call]: async (body, onDelta) => {
        speak = onDelta ?? (() => {});
        await gate.promise;
        return {
          v: GAME_AI_WIRE_VERSION,
          ok: false,
          ticket: body.ticket,
          code: AiErrorCode.Canceled,
          retryAfterMs: null,
        };
      },
    };
    const { port, deltas, replies, abandoned } = portRig({ answers });
    const running = port.request(TOP, { id: 9, op: AiBridgeOp.Call, body: call() }, false);
    await tick();
    speak("Hel");
    speak("Hello");
    port.navigating();
    speak("Hello there");
    port.navigated();
    speak("Hello there!");
    gate.resolve();
    await running;
    assert.deepEqual(deltas, [
      { id: 9, text: "Hel" },
      { id: 9, text: "Hello" },
      { id: 9, text: "Hello there" },
    ]);
    // The page that asked is gone: its answer is not handed to the page that replaced it.
    assert.deepEqual(replies, []);
    assert.deepEqual(abandoned, ["41"]);
  });

  it("a page on its way out is not heard; one whose navigation went nowhere is heard again", async () => {
    const { port, replies, handled, abandoned } = portRig();
    port.navigating();
    await port.request(TOP, hello(1), false);
    assert.deepEqual([replies, handled], [[], []]);
    port.stayed();
    await port.request(TOP, hello(2), false);
    assert.equal(replies[0]?.id, 2);
    assert.deepEqual(abandoned, ["41"]);
  });

  it("a gesture does not survive a navigation", async () => {
    const { port, replies, handled, click } = portRig();
    click();
    port.navigating();
    port.navigated();
    await port.request(TOP, { id: 1, op: AiBridgeOp.BudgetRequest, body: GRANT_BODY }, true);
    assert.deepEqual(replies[0]?.body, { view: null, code: AiErrorCode.NoGesture });
    assert.deepEqual(handled, []);
  });

  it("an answer for a page that moved to another game's address is dropped", async () => {
    const gate = deferred<void>();
    const answers: FakeAnswers = {
      [AiBridgeOp.Hello]: async () => {
        await gate.promise;
        return { v: GAME_AI_WIRE_VERSION, on: true };
      },
    };
    const { port, replies, moveTo } = portRig({ answers });
    const running = port.request(TOP, hello(1), false);
    await tick();
    moveTo("https://other-game.genex.technology/");
    gate.resolve();
    await running;
    assert.deepEqual(replies, []);
  });

  it("a view gone abandons its calls and answers nothing more", async () => {
    const { port, replies, handled, abandoned, kill } = portRig();
    kill();
    port.gone();
    await port.request(TOP, hello(1), false);
    assert.deepEqual([replies, handled, abandoned], [[], [], ["41"]]);
  });
});

describe("Play AI: the port with no AI, or a failing one", () => {
  it("with no play-time AI in this studio, every op is answered as off", async () => {
    const { port, replies, click } = portRig({ bridge: null });
    click();
    await port.request(TOP, hello(1), false);
    await port.request(TOP, { id: 2, op: AiBridgeOp.Doors, body: null }, false);
    await port.request(TOP, { id: 3, op: AiBridgeOp.Call, body: call("ticket-0003") }, false);
    await port.request(TOP, { id: 4, op: AiBridgeOp.BudgetActive, body: null }, false);
    await port.request(TOP, { id: 5, op: AiBridgeOp.BudgetRequest, body: GRANT_BODY }, true);
    await port.request(TOP, { id: 6, op: AiBridgeOp.BudgetStop, body: null }, false);
    await port.request(TOP, { id: 7, op: AiBridgeOp.Cancel, body: { ticket: "ticket-0003" } }, false);
    await port.request(TOP, { id: 8, op: PlayBridgeOp.GenexConfirm, body: CONFIRM }, true);
    assert.deepEqual(
      replies.map((reply) => reply.body),
      [
        { v: GAME_AI_WIRE_VERSION, on: false },
        { on: false, door: null },
        { v: GAME_AI_WIRE_VERSION, ok: false, ticket: "ticket-0003", code: AiErrorCode.Off, retryAfterMs: null },
        { view: null, code: AiErrorCode.Off },
        { view: null, code: AiErrorCode.Off },
        { stopped: false },
        { canceled: false },
        { approved: false },
      ],
    );
  });

  it("a bridge that fails answers the page with a refusal instead of leaving it waiting", async () => {
    const answers: FakeAnswers = {
      [AiBridgeOp.Call]: async () => {
        throw new Error("boom");
      },
    };
    const { port, replies } = portRig({ answers });
    await port.request(TOP, { id: 4, op: AiBridgeOp.Call, body: call("ticket-0004") }, false);
    assert.deepEqual(replies[0]?.body, {
      v: GAME_AI_WIRE_VERSION,
      ok: false,
      ticket: "ticket-0004",
      code: AiErrorCode.Provider,
      retryAfterMs: null,
    });
  });
});

/** The confirm bridge over recording fakes, its clock held by the test. */
function confirmRig(over: Partial<PlayBridgeDeps> & { terms?: { maxCredits: number; game: string } | null } = {}) {
  const log: string[] = [];
  const cards: AiConsentTicket[] = [];
  const answers: Array<ReturnType<typeof deferred<AiConsentAnswer>>> = [];
  const caller = playCallerFor(GAME, `${GAME_ORIGIN}/`, "41");
  if (!caller) throw new Error("no caller");
  const deps: PlayBridgeDeps = {
    service: {
      handle: handleFrom({}),
      abandon: (channel) => log.push(`service.abandon ${channel}`),
    },
    platform: {
      confirmTerms: async (request) => {
        log.push(`terms ${request.kind} ${request.id}`);
        return over.terms === undefined ? { maxCredits: 300, game: GAME.projectId } : over.terms;
      },
      answerConfirm: async (request, approved) => {
        log.push(`answer ${request.id} ${approved}`);
        return { approved };
      },
      balanceCredits: async () => 1240,
    },
    consents: {
      ask: (_caller, ticket) => {
        cards.push(ticket);
        const answer = deferred<AiConsentAnswer>();
        answers.push(answer);
        return answer.promise;
      },
      close: (game) => {
        log.push(`close ${game}`);
        for (const answer of answers)
          answer.resolve({ ticket: "closed", approve: false, model: null, unranked: false });
      },
    },
    clock: { now: () => Date.UTC(2026, 9, 20, 12, 0, 0) },
    assertNative: (step) => log.push(`native ${step}`),
    newTicket: () => `card-${cards.length + 1}-0000`,
    ...over,
  };
  const bridge = createGameAiPlayBridge(deps);
  const yes = (index = 0) => {
    const card = cards[index];
    if (card) answers[index]?.resolve({ ticket: card.ticket, approve: true, model: null, unranked: false });
  };
  const no = (index = 0) => {
    const card = cards[index];
    if (card) answers[index]?.resolve({ ticket: card.ticket, approve: false, model: null, unranked: false });
  };
  return { bridge, caller, log, cards, yes, no };
}

describe("Play AI: the embed-sdk's desktop confirm (D3)", () => {
  it("draws Genex's card with genex.games' own terms, and approves there after the person's yes", async () => {
    const { bridge, caller, log, cards, yes } = confirmRig();
    const answer = bridge.confirm(caller, CONFIRM);
    await tick();
    assert.deepEqual(cards, [
      {
        ticket: "card-1-0000",
        game: KEY,
        title: GAME.title,
        kind: AiConsentKind.GenexConfirm,
        model: null,
        modelLabel: null,
        balanceCredits: 1240,
        keepForBuildingPercent: null,
        localDownloadBytes: null,
        maxCredits: 300,
        expiresAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) + AI_CONSENT_TTL_MS).toISOString(),
      },
    ]);
    yes();
    assert.deepEqual(await answer, { approved: true });
    assert.deepEqual(log, ["terms grant grant_123", `native ${GameAiNativeStep.ApprovePaid}`, "answer grant_123 true"]);
  });

  it("a person's no is told to genex.games, and nothing is approved", async () => {
    const { bridge, caller, log, no } = confirmRig();
    const answer = bridge.confirm(caller, CONFIRM);
    await tick();
    no();
    assert.deepEqual(await answer, { approved: false });
    assert.deepEqual(log, ["terms grant grant_123", "answer grant_123 false"]);
  });

  it("an answer to another card approves nothing", async () => {
    const { bridge, caller, log, cards } = confirmRig({
      consents: {
        ask: async (_caller, ticket) => {
          cards.push(ticket);
          return { ticket: "another-card", approve: true, model: null, unranked: false };
        },
        close: () => {},
      },
    });
    assert.deepEqual(await bridge.confirm(caller, CONFIRM), { approved: false });
    assert.equal(log.includes("answer grant_123 true"), false);
  });

  it("a second confirm while one is pending for the game is refused without asking genex.games", async () => {
    const { bridge, caller, log, cards, yes } = confirmRig();
    const first = bridge.confirm(caller, CONFIRM);
    await tick();
    assert.deepEqual(await bridge.confirm(caller, { kind: GenexConfirmKind.Generate, id: "gen_9" }), {
      approved: false,
    });
    assert.equal(cards.length, 1);
    yes();
    assert.deepEqual(await first, { approved: true });
    assert.equal(
      log.some((line) => line.includes("gen_9")),
      false,
    );
  });
});

describe("Play AI: confirms that approve nothing", () => {
  const refusedTerms: Array<[string, { maxCredits: number; game: string } | null]> = [
    ["a grant genex.games does not know", null],
    ["another game's grant", { maxCredits: 300, game: "cm-other" }],
    ["a grant with no credits", { maxCredits: 0, game: GAME.projectId }],
    ["a grant with a broken limit", { maxCredits: Number.NaN, game: GAME.projectId }],
  ];
  for (const [name, terms] of refusedTerms)
    it(`draws no card for ${name}, and answers nothing on genex.games`, async () => {
      const { bridge, caller, log, cards } = confirmRig({ terms });
      assert.deepEqual(await bridge.confirm(caller, CONFIRM), { approved: false });
      assert.deepEqual(cards, []);
      assert.deepEqual(log, ["terms grant grant_123"]);
    });

  it("a launch that may not take native steps never approves on genex.games", async () => {
    const { bridge, caller, log, yes } = confirmRig({
      assertNative: () => {
        throw new Error("native step in a fixture profile");
      },
    });
    const answer = bridge.confirm(caller, CONFIRM);
    await tick();
    yes();
    assert.deepEqual(await answer, { approved: false });
    assert.equal(log.includes("answer grant_123 true"), false);
  });

  it("the game leaving while its card is up closes the card and approves nothing", async () => {
    const { bridge, caller, log, yes } = confirmRig();
    const answer = bridge.confirm(caller, CONFIRM);
    await tick();
    bridge.abandon("41");
    yes();
    assert.deepEqual(await answer, { approved: false });
    assert.deepEqual(log, ["terms grant grant_123", "service.abandon 41", `close ${KEY}`]);
  });

  it("genex.games failing to approve answers not approved", async () => {
    const { bridge, caller, yes } = confirmRig({
      platform: {
        confirmTerms: async () => ({ maxCredits: 300, game: GAME.projectId }),
        answerConfirm: async () => {
          throw new Error("502");
        },
        balanceCredits: async () => null,
      },
    });
    const answer = bridge.confirm(caller, CONFIRM);
    await tick();
    yes();
    assert.deepEqual(await answer, { approved: false });
  });

  it("hands every AI op to the service, and a page going away to it as well", async () => {
    const seen: string[] = [];
    const { bridge, caller } = confirmRig({
      service: {
        handle: handleFrom({
          [AiBridgeOp.Hello]: async () => {
            seen.push(AiBridgeOp.Hello);
            return { v: GAME_AI_WIRE_VERSION, on: true };
          },
        }),
        abandon: (channel) => seen.push(`abandon ${channel}`),
      },
    });
    assert.deepEqual(await bridge.handle(caller, { op: AiBridgeOp.Hello, body: null }), {
      v: GAME_AI_WIRE_VERSION,
      on: true,
    });
    bridge.abandon("41");
    assert.deepEqual(seen, [AiBridgeOp.Hello, "abandon 41"]);
  });
});

describe("Play AI: the gateway to AI vendors (D5)", () => {
  const blocked: Array<[string, AiVendor, string]> = [
    ["https://api.openai.com/v1/chat/completions", AiVendor.OpenAi, "api.openai.com"],
    ["wss://api.openai.com/v1/realtime?model=gpt", AiVendor.OpenAi, "api.openai.com"],
    ["https://API.Anthropic.com./v1/messages", AiVendor.Anthropic, "api.anthropic.com"],
    ["https://openrouter.ai:443/api/v1/chat", AiVendor.OpenRouter, "openrouter.ai"],
    ["https://us-central1-aiplatform.googleapis.com/v1/x", AiVendor.Google, "us-central1-aiplatform.googleapis.com"],
    ["http://generativelanguage.googleapis.com/v1beta", AiVendor.Google, "generativelanguage.googleapis.com"],
    ["ws://fal.run/socket", AiVendor.Fal, "fal.run"],
  ];
  for (const [url, vendor, host] of blocked)
    it(`refuses ${url}`, () =>
      assert.deepEqual(aiGatewayVerdict(url), { code: AiErrorCode.DirectBlocked, vendor, host }));

  const loads = [
    "https://api.openai.com.evil.io/v1",
    "https://notopenai.com/",
    "https://api.openai.co/",
    "https://evil.io/?next=https://api.openai.com/",
    "https://evil.io/api.openai.com/v1",
    "https://api.openai.com@evil.io/",
    "https://crowns-1444.genex.technology/assets/openai.png",
    "https://api.genex.games/api/runtime/generate",
    "https://storage.googleapis.com/bucket/a.png",
    "data:text/html,https://api.openai.com/",
    "blob:https://api.openai.com/9d2c",
    "devtools://devtools/bundled/inspector.html",
    "chrome-extension://abc/openai.com",
    "",
    "::",
  ];
  for (const url of loads) it(`lets ${JSON.stringify(url)} load`, () => assert.equal(aiGatewayVerdict(url), null));

  it("tells a page about each vendor host once until it navigates, and at most a few in all", () => {
    const notes = blockedNotes();
    const openai: PlayAiBlocked = { code: AiErrorCode.DirectBlocked, vendor: AiVendor.OpenAi, host: "api.openai.com" };
    assert.equal(notes.first(openai), true);
    assert.equal(notes.first(openai), false);
    notes.reset();
    assert.equal(notes.first(openai), true);
    for (let index = 1; index < BLOCKED_NOTES_MAX; index += 1)
      assert.equal(notes.first({ ...openai, host: `h${index}.openai.com` }), true);
    assert.equal(notes.first({ ...openai, host: "one-more.openai.com" }), false);
  });
});

/** The bridge the page half put on a stand-in window, as a game sees it. */
const desktopOf = (scope: object): GenexDesktopWindow => Reflect.get(scope, GENEX_DESKTOP_GLOBAL);

/** The page-world half on a stand-in window, its envelopes recorded. */
function pageRig(options: { send?: (envelope: unknown) => void } = {}) {
  const sent: Array<{ id: number; op: string; body: unknown }> = [];
  const errors: unknown[][] = [];
  const scope: Record<string, unknown> = { console: { error: (...args: unknown[]) => errors.push(args) } };
  const words: PlayAiPageWords = {
    global: GENEX_DESKTOP_GLOBAL,
    version: GENEX_DESKTOP_BRIDGE_VERSION,
    confirmOp: PlayBridgeOp.GenexConfirm,
    callOp: AiBridgeOp.Call,
    maxId: PLAY_AI_MAX_ENVELOPE_ID,
    blockedNote: "use genex-ai",
    exhausted: "no more envelopes",
  };
  const control = installPlayAi(
    options.send ?? ((envelope) => sent.push(envelope as { id: number; op: string; body: unknown })),
    words,
    scope,
  );
  if (!control) throw new Error("not installed");
  return { scope, sent, errors, control, words };
}

describe("Play AI: the game's page", () => {
  it("is found by the embed-sdk as its desktop bridge, and a confirm resolves with main's answer", async () => {
    const { scope, sent, control } = pageRig();
    const bridge = genexDesktopBridgeOf(scope);
    assert.ok(bridge);
    const answer = bridge.confirm(CONFIRM);
    assert.deepEqual(sent, [{ id: 1, op: PlayBridgeOp.GenexConfirm, body: CONFIRM }]);
    control.reply({ id: 1, op: PlayBridgeOp.GenexConfirm, body: { approved: true } });
    assert.deepEqual(await answer, { approved: true });
  });

  it("numbers each request and resolves each with its own answer, ignoring answers nobody asked for", async () => {
    const { scope, sent, control } = pageRig();
    const desktop = desktopOf(scope);
    const first = desktop.ai.request(AiBridgeOp.Hello, null);
    const second = desktop.ai.request(AiBridgeOp.Doors, null);
    assert.deepEqual(
      sent.map((envelope) => envelope.id),
      [1, 2],
    );
    control.reply({ id: 7, op: AiBridgeOp.Hello, body: { v: GAME_AI_WIRE_VERSION, on: true } });
    control.reply({ id: 2, op: AiBridgeOp.Doors, body: { on: true, door: "local" } });
    control.reply({ id: 1, op: AiBridgeOp.Hello, body: { v: GAME_AI_WIRE_VERSION, on: true } });
    control.reply({ id: 1, op: AiBridgeOp.Hello, body: { v: GAME_AI_WIRE_VERSION, on: false } });
    assert.deepEqual(await first, { v: GAME_AI_WIRE_VERSION, on: true });
    assert.deepEqual(await second, { on: true, door: "local" });
  });

  it("streams a call's text to the listeners of its ticket until they unsubscribe", async () => {
    const { scope, control } = pageRig();
    const desktop = desktopOf(scope);
    const heard: string[] = [];
    const stop = desktop.ai.onDelta("ticket-0001", (text: string) => heard.push(text));
    desktop.ai.onDelta("ticket-0002", () => {
      throw new Error("a listener of the game's that throws");
    });
    void desktop.ai.request(AiBridgeOp.Call, call("ticket-0001"));
    void desktop.ai.request(AiBridgeOp.Call, call("ticket-0002"));
    control.delta({ id: 1, text: "Hel" });
    control.delta({ id: 2, text: "x" });
    control.delta({ id: 1, text: "Hello" });
    stop();
    control.delta({ id: 1, text: "Hello!" });
    control.delta({ id: 9, text: "nobody" });
    assert.deepEqual(heard, ["Hel", "Hello"]);
  });

  it("writes a refused vendor request to the console with its code", () => {
    const { control, errors } = pageRig();
    control.blocked({ code: AiErrorCode.DirectBlocked, vendor: AiVendor.OpenAi, host: "api.openai.com" });
    assert.deepEqual(errors, [[AiErrorCode.DirectBlocked, "use genex-ai", "api.openai.com", AiVendor.OpenAi]]);
  });

  it("cannot be replaced or deleted by the page, and is installed once", () => {
    const { scope, words } = pageRig();
    const before = Reflect.get(scope, GENEX_DESKTOP_GLOBAL);
    assert.equal(
      Reflect.set(scope, GENEX_DESKTOP_GLOBAL, { version: 1, confirm: async () => ({ approved: true }) }),
      false,
    );
    assert.equal(Reflect.deleteProperty(scope, GENEX_DESKTOP_GLOBAL), false);
    assert.equal(Reflect.get(scope, GENEX_DESKTOP_GLOBAL), before);
    assert.equal(Object.isFrozen(before), true);
    assert.equal(
      installPlayAi(() => {}, words, scope),
      null,
    );
  });

  it("a request the preload cannot carry fails at once instead of waiting forever", async () => {
    const { scope } = pageRig({
      send: () => {
        throw new Error("An object could not be cloned");
      },
    });
    const desktop = desktopOf(scope);
    await assert.rejects(desktop.ai.request(AiBridgeOp.Hello, null));
  });
});
