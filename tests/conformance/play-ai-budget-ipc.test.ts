/**
 * The AI budget's IPC and its fixture: the four calls are named channels registered through the
 * real typed `handle()`, classified fixture-safe, and checked at the boundary (a payload that is not
 * exactly the call's own never reaches the budget client); the preload sends each in the shape main
 * reads; and a fixture launch answers all four from its own data, so every state of the page's line
 * and sheet is reachable with no socket.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFixtureAiBudget,
  FIXTURE_BUDGET_GAMES,
  FIXTURE_BUDGET_TTL_MS,
  FIXTURE_CALL_CREDITS,
  FIXTURE_HELD_CREDITS,
  FIXTURE_SPEND_EVERY_MS,
  FixtureBudgetCase,
} from "../../src/main/dev/fixture-ai-budget.ts";
import { FIXTURE_ACCOUNT_TOKEN, FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { ChannelClass, classifyChannel } from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { type AiBudgetIpcDeps, registerAiBudgetIpc } from "../../src/main/ipc/play-ai-budget.ts";
import { AiBudgetRoute, playAiBudget } from "../../src/main/play/ai-budget.ts";
import { type GalleryRequest, isRecord, PlayRoute, SignInNeeded } from "../../src/main/play/gallery.ts";
import { type BridgeIpc, createStudioBridge } from "../../src/preload/studio-bridge.ts";
import { AiBudgetRefusal, AiBudgetStatus, type AiBudgetView } from "../../src/shared/play-ai-budget.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const STUDIO: IpcSender = { sender: "studio", senderFrame: "studio-main-frame" };
const CHANNELS = [
  "studio:play.ai-budget",
  "studio:play.ai-budget-open",
  "studio:play.ai-budget-confirm",
  "studio:play.ai-budget-stop",
] as const;

const LIVE: AiBudgetView = {
  status: AiBudgetStatus.Active,
  limitCredits: 100,
  spentCredits: 0,
  heldCredits: 0,
  remainingCredits: 100,
  expiresAt: "2026-11-25T12:00:00.000Z",
  stopping: false,
};
const READ = { signedOut: false, declared: null, current: LIVE };

/** The registrar over a recording budget client, in a fixture profile; `signedOut` makes every call throw as signed out. */
function rig(signedOut = false) {
  const listeners = new Map<string, Listener>();
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    <T>(name: string, answer: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args]);
      if (signedOut) throw new SignInNeeded();
      return answer;
    };
  const budget: AiBudgetIpcDeps["budget"] = {
    status: record("status", READ),
    open: record("open", { refused: AiBudgetRefusal.GenerationPaused }),
    confirm: record("confirm", { current: LIVE }),
    stop: record("stop", { current: null }),
  };
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: true, isStudioUi: (event) => event === STUDIO },
  );
  registerAiBudgetIpc(handle, { budget });
  const invoke = async (channel: string, payload: unknown): Promise<IpcResult> => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(STUDIO, payload);
  };
  return { invoke, calls, listeners };
}

describe("The AI budget's channels", () => {
  it("registers the four calls, each fixture-safe", () => {
    const { listeners } = rig();
    assert.deepEqual([...listeners.keys()].sort(), [...CHANNELS].sort());
    for (const channel of CHANNELS) assert.equal(classifyChannel(channel), ChannelClass.FixtureSafe, channel);
  });

  it("hands each well-formed call to the budget client with exactly its arguments", async () => {
    const { invoke, calls } = rig();
    const table: Array<[string, unknown, [string, ...unknown[]], unknown]> = [
      ["studio:play.ai-budget", { slug: "iron-tide" }, ["status", "iron-tide"], READ],
      [
        "studio:play.ai-budget-open",
        { slug: "iron-tide" },
        ["open", "iron-tide"],
        { refused: AiBudgetRefusal.GenerationPaused },
      ],
      [
        "studio:play.ai-budget-confirm",
        { slug: "iron-tide", limitCredits: 250 },
        ["confirm", "iron-tide", 250],
        { current: LIVE },
      ],
      ["studio:play.ai-budget-stop", { slug: "iron-tide" }, ["stop", "iron-tide"], { current: null }],
    ];
    for (const [channel, payload, call, value] of table) {
      assert.deepEqual(await invoke(channel, payload), { ok: true, value }, channel);
      assert.deepEqual(calls.at(-1), call, channel);
    }
  });

  it("tells a signed-out app by its answer, not by an error", async () => {
    const { invoke } = rig(true);
    assert.deepEqual(await invoke("studio:play.ai-budget", { slug: "iron-tide" }), {
      ok: true,
      value: { signedOut: true, declared: null, current: null },
    });
    const refused = { ok: true, value: { refused: AiBudgetRefusal.SignedOut } };
    assert.deepEqual(await invoke("studio:play.ai-budget-open", { slug: "iron-tide" }), refused);
    assert.deepEqual(await invoke("studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: 50 }), refused);
    assert.deepEqual(await invoke("studio:play.ai-budget-stop", { slug: "iron-tide" }), refused);
  });

  it("refuses a malformed payload before the budget client hears of it", async () => {
    const { invoke, calls } = rig();
    const slugs: unknown[] = [undefined, null, "", "../etc", "Iron Tide", "a/b", 42, ["iron-tide"], { slug: "x" }];
    const hostile: Array<[string, unknown]> = [
      ...CHANNELS.flatMap(
        (channel): Array<[string, unknown]> => [
          [channel, undefined],
          [channel, null],
          [channel, "iron-tide"],
          [channel, ["iron-tide"]],
          [channel, {}],
          ...slugs.map((slug): [string, unknown] => [channel, { slug, limitCredits: 100 }]),
        ],
      ),
      ["studio:play.ai-budget", { slug: "iron-tide", projectId: "cm1" }],
      ["studio:play.ai-budget-open", { slug: "iron-tide", grantId: "g1" }],
      ["studio:play.ai-budget-stop", { slug: "iron-tide", limitCredits: 100 }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide" }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: 100, voice: true }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: 100, quoteId: "q" }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: "100" }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: 10.5 }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: Number.NaN }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: Number.POSITIVE_INFINITY }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: 2 ** 60 }],
      ["studio:play.ai-budget-confirm", { slug: "iron-tide", limitCredits: null }],
    ];
    for (const [channel, payload] of hostile) {
      const result = await invoke(channel, payload);
      assert.equal(result.ok, false, `${channel} ${JSON.stringify(payload)}`);
    }
    assert.deepEqual(calls, []);
  });

  it("the preload sends each call in the shape main reads", async () => {
    const { invoke, calls } = rig();
    const ipc: BridgeIpc = { invoke, on: () => {}, off: () => {} };
    const api = createStudioBridge(ipc);
    assert.deepEqual(await api.playAiBudget("iron-tide"), READ);
    await api.playAiBudgetOpen("iron-tide");
    assert.deepEqual(await api.playAiBudgetConfirm("iron-tide", 250), { current: LIVE });
    assert.deepEqual(await api.playAiBudgetStop("iron-tide"), { current: null });
    assert.deepEqual(calls, [
      ["status", "iron-tide"],
      ["open", "iron-tide"],
      ["confirm", "iron-tide", 250],
      ["stop", "iron-tide"],
    ]);
  });
});

/** The slug of the fixture game for a case. */
function gameOf(kase: FixtureBudgetCase): string {
  const found = Object.entries(FIXTURE_BUDGET_GAMES).find(([, value]) => value === kase);
  assert.ok(found, kase);
  return found[0];
}

/** The budget client over the fixture launch's own answers, signed in as `token`. */
function fixtureBudget(token: string | undefined = FIXTURE_ACCOUNT_TOKEN) {
  const routes: string[] = [];
  const request: GalleryRequest = (route, init) => {
    routes.push(route);
    return fixturePlayRequest(route, init);
  };
  const budget = playAiBudget({
    request,
    token: async () => token,
    now: Date.now,
    project: async (slug) => {
      const answer = await fixturePlayRequest(PlayRoute.world(slug), { method: "GET" });
      const item = isRecord(answer.body) && isRecord(answer.body.item) ? answer.body.item : {};
      return String(item.id ?? "");
    },
  });
  return { budget, routes };
}

describe("AI budgets in a fixture launch", () => {
  it("one native game declares a budget nobody approved yet, another declares none", async () => {
    const { budget } = fixtureBudget();
    const asking = await budget.status(gameOf(FixtureBudgetCase.Ask));
    assert.equal(asking.signedOut, false);
    assert.equal(asking.current, null);
    assert.deepEqual(asking.declared?.models, ["Gemini 2.5 Flash", "GPT-5 mini"]);
    assert.deepEqual([asking.declared?.judge, asking.declared?.voice, asking.declared?.available], [true, false, true]);
    assert.deepEqual(await budget.status("dust-runners"), { signedOut: false, declared: null, current: null });
    assert.deepEqual(await budget.open("dust-runners"), { refused: AiBudgetRefusal.NotDeclared });
  });

  it("opens a quote, approves it into a running budget the next read reports, and stops it", async () => {
    const { budget } = fixtureBudget();
    const slug = gameOf(FixtureBudgetCase.Ask);
    const opened = await budget.open(slug);
    assert.ok("quote" in opened);
    assert.equal(opened.quote.replaces, false);
    const { defaultCredits } = opened.quote.limit;
    const approved = await budget.confirm(slug, defaultCredits);
    assert.ok("current" in approved);
    assert.deepEqual(
      [approved.current.status, approved.current.limitCredits, approved.current.remainingCredits],
      [AiBudgetStatus.Active, defaultCredits, defaultCredits],
    );
    assert.equal((await budget.status(slug)).current?.status, AiBudgetStatus.Active);
    const again = await budget.open(slug);
    assert.ok("quote" in again);
    assert.equal(again.quote.replaces, true, "approving again would replace the running budget");
    const stopped = await budget.stop(slug);
    assert.ok("current" in stopped);
    assert.equal(stopped.current?.status, AiBudgetStatus.Stopped);
    assert.equal((await budget.status(slug)).current, null);
    assert.deepEqual(await budget.stop(slug), { current: null }, "nothing left to stop");
  });

  it("has a game for each failure the sheet words", async () => {
    const { budget } = fixtureBudget();
    const poor = gameOf(FixtureBudgetCase.Poor);
    const quoted = await budget.open(poor);
    assert.ok("quote" in quoted);
    assert.deepEqual(await budget.confirm(poor, quoted.quote.limit.defaultCredits), {
      refused: AiBudgetRefusal.InsufficientCredits,
    });
    assert.deepEqual(await budget.open(gameOf(FixtureBudgetCase.Paused)), {
      refused: AiBudgetRefusal.GenerationPaused,
    });
    const unavailable = gameOf(FixtureBudgetCase.Unavailable);
    assert.equal((await budget.status(unavailable)).declared?.available, false);
    assert.deepEqual(await budget.open(unavailable), { refused: AiBudgetRefusal.ModelNotAvailable });
  });

  it("lets one game's first approval find its quote lapsed, and the next go through", async () => {
    const { budget } = fixtureBudget();
    const slug = gameOf(FixtureBudgetCase.Expire);
    const first = await budget.open(slug);
    assert.ok("quote" in first);
    assert.equal(first.quote.estimate, null, "this game gave no estimate");
    const limit = first.quote.limit.minCredits + first.quote.limit.stepCredits;
    assert.deepEqual(await budget.confirm(slug, limit), { refused: AiBudgetRefusal.QuoteExpired });
    assert.ok("quote" in (await budget.open(slug)));
    const approved = await budget.confirm(slug, limit);
    assert.ok("current" in approved);
    assert.equal(approved.current.limitCredits, limit);
    await budget.stop(slug);
  });

  it("answers a signed-out launch and an ended sign-in with a 401, and opens no other route", async () => {
    const ended = fixtureBudget(fixtureAccountToken(FixtureAccount.Ended));
    await assert.rejects(ended.budget.status(gameOf(FixtureBudgetCase.Ask)), SignInNeeded);
    const route = AiBudgetRoute.budget("fx0004");
    assert.equal((await fixturePlayRequest(route, { method: "GET" })).status, 401);
    assert.equal((await fixturePlayRequest(route, { method: "POST", token: "someone-else" })).status, 401);
    const { budget, routes } = fixtureBudget();
    await budget.status(gameOf(FixtureBudgetCase.Ask));
    assert.ok(routes.every((asked) => asked.startsWith("/api/runtime/projects/")));
  });
});

describe("The fixture's budget answers", () => {
  const PROJECT = "fx-game";
  const TOKEN = { token: FIXTURE_ACCOUNT_TOKEN };

  /** One launch's budgets over a clock the test moves, for the game of `kase`. */
  function launch(kase: FixtureBudgetCase = FixtureBudgetCase.Ask) {
    const clock = { now: 1_800_000_000_000 };
    const fixture = createFixtureAiBudget({
      now: () => clock.now,
      slugOf: (projectId) => (projectId === PROJECT ? gameOf(kase) : null),
    });
    const call = (route: string, method: "GET" | "POST", body?: unknown) => {
      const answer = fixture.answer(route, { method, ...TOKEN, ...(body === undefined ? {} : { body }) });
      assert.ok(answer, route);
      return { status: answer.status, body: isRecord(answer.body) ? answer.body : {} };
    };
    /** Open a quote and approve it with `limitCredits`. */
    const approve = (limitCredits: number, extra: Record<string, unknown> = {}) => {
      const quote = call(AiBudgetRoute.budget(PROJECT), "POST").body;
      const terms = isRecord(quote.terms) ? quote.terms : {};
      const body = { quoteId: quote.quoteId, funding: "credits", billingPolicy: terms.billingPolicy, limitCredits };
      return call(AiBudgetRoute.confirm(PROJECT, String(quote.id)), "POST", { ...body, ...extra });
    };
    return { clock, fixture, call, approve };
  }

  it("leaves every other route to the rest of the fixture", () => {
    const { fixture } = launch();
    for (const route of ["/api/gallery", "/api/coin/balance", "/api/runtime/grants/g1"])
      assert.equal(fixture.answer(route, { method: "GET", ...TOKEN }), null, route);
    assert.equal(fixture.answer(AiBudgetRoute.budget("unknown"), { method: "GET", ...TOKEN })?.status, 404);
    assert.equal(fixture.answer(`${AiBudgetRoute.budget(PROJECT)}/x/y/z`, { method: "POST", ...TOKEN })?.status, 404);
  });

  it("spends a running budget as time passes, until it is used up", () => {
    const { clock, call, approve } = launch();
    assert.equal(approve(6).status, 200);
    /** What the running budget has spent, holds for a call still running, and has left; null once none runs. */
    const amounts = (): unknown[] | null => {
      const { current } = call(AiBudgetRoute.budget(PROJECT), "GET").body;
      return isRecord(current) ? [current.spentCredits, current.heldCredits, current.remainingCredits] : null;
    };
    assert.deepEqual(amounts(), [0, 0, 6], "nothing is on hold before the first call");
    clock.now += FIXTURE_SPEND_EVERY_MS;
    // Used, on hold and left are three numbers that add up to the limit: the page shows each under its word.
    assert.deepEqual(amounts(), [
      FIXTURE_CALL_CREDITS,
      FIXTURE_HELD_CREDITS,
      6 - FIXTURE_CALL_CREDITS - FIXTURE_HELD_CREDITS,
    ]);
    clock.now += FIXTURE_SPEND_EVERY_MS;
    assert.equal(amounts(), null, "a budget that spent its limit is no longer running");
  });

  it("ends a running budget after its day", () => {
    const { clock, call, approve } = launch();
    approve(2000);
    clock.now += FIXTURE_BUDGET_TTL_MS;
    assert.equal(call(AiBudgetRoute.budget(PROJECT), "GET").body.current, null);
    assert.equal(call(AiBudgetRoute.stop(PROJECT), "POST").status, 404);
  });

  it("refuses an approval genex.games would refuse", () => {
    const { approve, call } = launch();
    const table: Array<[string, number, Record<string, unknown>, number, string]> = [
      ["a limit under the least", 3, {}, 400, AiBudgetRefusal.InvalidLimit],
      ["a limit over the most", 2001, {}, 400, AiBudgetRefusal.InvalidLimit],
      ["a voice key", 100, { voice: true }, 400, "invalid_request"],
      ["another quote's id", 100, { quoteId: "00000000-0000-4000-8000-999999999999" }, 409, "quote_mismatch"],
      ["another billing policy", 100, { billingPolicy: "other" }, 409, "billing_policy_mismatch"],
      ["coin for credits", 100, { funding: "coins" }, 400, "invalid_request"],
    ];
    for (const [why, limit, extra, status, error] of table) {
      const answer = approve(limit, extra);
      assert.deepEqual([answer.status, answer.body.error], [status, error], why);
    }
    assert.equal(call(AiBudgetRoute.confirm(PROJECT, "fxb-0"), "POST", {}).status, 404, "no such quote");
    assert.equal(call(AiBudgetRoute.budget(PROJECT), "GET").body.current, null, "nothing was approved");
  });
});
