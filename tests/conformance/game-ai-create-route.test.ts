/**
 * The Create Live route (D1, `src/main/game-ai/create-route.ts`): a game in the Live human preview
 * asks play-time AI with a same-origin POST, and every hostile request is refused before play-time
 * AI hears of it. Each refusal row asserts its status, that no CORS header is sent, and that the
 * service was never called (no side effect).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DRIVE_QUIET_MS,
  ROUTE_MAX_BODY_BYTES,
  answerCreateRoute,
  createDriveWatch,
  createRouteEnabled,
  createRouteGate,
  previewAiContext,
  type CreateRouteHost,
  type RoutePage,
} from "../../src/main/game-ai/create-route.ts";
import {
  HttpRouteKind,
  LIVE_PREVIEW_PARTITION,
  gameRequestAllowed,
  previewNavigationAllowed,
  routeGame,
  routeHttp,
} from "../../src/main/page-serve.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import {
  AiBridgeOp,
  AiErrorCode,
  AiOp,
  AiSource,
  AiProvenance,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import type { AiBridgeMessage } from "../../src/shared/game-ai-bridge.ts";
import { AiRouteEvent } from "../../src/shared/game-ai-bridge.ts";
import { PLAY_AI_BURST, PLAY_AI_MAX_PENDING, PLAY_AI_WINDOW_MS } from "../../src/shared/play-ai.ts";
import { AiPickPolicy, type GameAiSettingsView } from "../../src/shared/game-ai-views.ts";
import type { GameAiCaller } from "../../src/main/game-ai/types.ts";

const ORIGIN = "game://pond-life";
const ROUTE = `${ORIGIN}/__genex/ai/v1/`;

/** A call the bridge reader takes. */
const CALL = {
  v: 1,
  op: AiOp.Ask,
  site: "turn.resolve",
  ticket: "ticket-0001",
  grantId: "grant-0001",
  system: null,
  prompt: "Resolve the turn.",
  untrusted: {},
  memory: null,
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  tier: "fast",
  authority: "local",
  maxOutputTokens: 256,
  stream: false,
} as const;

const SAY = { ...CALL, op: AiOp.Say, schema: null, stream: true } as const;

const ANSWER = {
  v: GAME_AI_WIRE_VERSION,
  ok: true,
  ticket: CALL.ticket,
  value: { ok: true },
  source: AiSource.Local,
  provenance: AiProvenance.Unverified,
  latencyMs: 12,
  cached: false,
} as const;

function settingsView(createRouteEnabled: boolean): GameAiSettingsView {
  return {
    pick: AiPickPolicy.Best,
    signedIn: false,
    balanceCredits: null,
    pro: null,
    autoTopUp: null,
    dailyAlertCredits: 500,
    keepForBuildingPercent: 50,
    openRouterMonthlyMicros: null,
    createRouteEnabled,
    allowPlan: false,
    shareFitCounts: false,
  };
}

interface Recorded {
  calls: Array<{ caller: GameAiCaller; message: AiBridgeMessage }>;
  abandoned: string[];
}

/** A host whose service records what reached it and answers each op. */
function fakeHost(
  options: {
    now?: () => number;
    enabled?: boolean;
    answer?: (message: AiBridgeMessage, onDelta?: (text: string) => void) => Promise<unknown>;
  } = {},
): { host: CreateRouteHost; seen: Recorded } {
  const seen: Recorded = { calls: [], abandoned: [] };
  const answer =
    options.answer ??
    (async (message: AiBridgeMessage) => {
      if (message.op === AiBridgeOp.Hello) return { v: GAME_AI_WIRE_VERSION, on: true };
      if (message.op === AiBridgeOp.Call) return ANSWER;
      if (message.op === AiBridgeOp.Cancel) return { canceled: true };
      return { view: null, code: null };
    });
  const handle = async (caller: GameAiCaller, message: AiBridgeMessage, onDelta?: (text: string) => void) => {
    seen.calls.push({ caller, message });
    return answer(message, onDelta);
  };
  const host: CreateRouteHost = {
    clock: { now: options.now ?? (() => 1_000_000) },
    settings: { view: async () => settingsView(options.enabled ?? true) },
    service: {
      // The fake answers each op with the shape the test names.
      handle: handle as CreateRouteHost["service"]["handle"],
      abandon: (channel) => {
        seen.abandoned.push(channel);
      },
    },
    game: async (project) => ({ title: `${project} title`, ownGame: true }),
  };
  return { host, seen };
}

const LIVE: RoutePage = {
  project: "pond-life",
  loaded: "pond-life",
  context: AiContext.CreateLive,
  driving: false,
  channel: "7",
};

function post(op: string, body: unknown, headers: Record<string, string> = {}, base = ROUTE): Request {
  return new Request(`${base}${op}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A body that streams in chunks with no declared length. */
function chunked(op: string, chunks: number, size: number): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(size)));
    },
  });
  return new Request(`${ROUTE}${op}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

function assertNoCors(response: Response, what: string): void {
  for (const [name] of response.headers) assert.ok(!name.startsWith("access-control-"), `${what}: ${name}`);
}

async function answer(request: Request, page: RoutePage = LIVE, host = fakeHost()) {
  const response = await answerCreateRoute(request, page, host.host, createRouteGate(host.host.clock));
  return { response, seen: host.seen };
}

describe("the route's place on the game's own origin (HttpRouteKind.HostAi)", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("names the route for a path under the prefix, on game: and on the game's loopback port", () => {
    assert.deepEqual(routeGame("game://pond-life/__genex/ai/v1/call"), {
      route: HttpRouteKind.HostAi,
      project: "pond-life",
    });
    assert.deepEqual(routeHttp("http://localhost:41234/__genex/ai/v1/hello", ports), {
      route: HttpRouteKind.HostAi,
      project: "pond-life",
    });
    assert.deepEqual(routeGame("game://pond-life/index.html"), { route: HttpRouteKind.Serve, project: "pond-life" });
    assert.deepEqual(routeGame("game://pond-life/__genex/other"), { route: HttpRouteKind.Serve, project: "pond-life" });
    assert.deepEqual(routeHttp("http://localhost:41235/__genex/ai/v1/hello", ports), { route: HttpRouteKind.Deny });
    assert.deepEqual(routeGame("https://pond-life/__genex/ai/v1/hello"), { route: HttpRouteKind.Deny });
  });

  it("leaves what the partition may request or navigate to exactly as it was", () => {
    for (const url of ["game://pond-life/__genex/ai/v1/call", "http://localhost:41234/__genex/ai/v1/call"]) {
      assert.equal(gameRequestAllowed(url, ports, "POST"), true, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), true, url);
    }
    assert.equal(gameRequestAllowed("http://localhost:41235/__genex/ai/v1/call", ports, "POST"), false);
  });
});

describe("the context comes from the partition, never from the page", () => {
  const rows: Array<[string, string, boolean, AiContext]> = [
    ["the Live human preview", LIVE_PREVIEW_PARTITION, false, AiContext.CreateLive],
    ["Live's partition rendering offscreen", LIVE_PREVIEW_PARTITION, true, AiContext.HarnessRun],
    ["a facet", "game-preview-facet-1", true, AiContext.HarnessRun],
    ["a facet on screen", "game-preview-facet-2", false, AiContext.HarnessRun],
    ["a near-miss name", "game-preview-", false, AiContext.HarnessRun],
    ["a persisted look-alike", `persist:${LIVE_PREVIEW_PARTITION}`, false, AiContext.HarnessRun],
    ["an e2e fixture", "visibility-foreground", false, AiContext.HarnessRun],
  ];
  for (const [what, partition, offscreen, context] of rows)
    it(what, () => assert.equal(previewAiContext(partition, offscreen), context));
});

describe("the kill switch (createRouteEnabled)", () => {
  it("reads Settings, off by default, and an unreadable store is off", async () => {
    assert.equal(await createRouteEnabled(fakeHost({ enabled: true }).host), true);
    assert.equal(await createRouteEnabled(fakeHost({ enabled: false }).host), false);
    const broken = fakeHost().host;
    broken.settings = {
      view: async () => {
        throw new Error("disk gone");
      },
    };
    assert.equal(await createRouteEnabled(broken), false);
  });
});

/** A call whose prompt alone passes the body cap. */
const BIG = JSON.stringify({ ...CALL, prompt: "x".repeat(ROUTE_MAX_BODY_BYTES) });

/** Hostile requests: what each is, the request, the status it gets, and the page it comes from. */
const HOSTILE: Array<[string, () => Request, number, RoutePage?]> = [
  ["GET", () => new Request(`${ROUTE}hello`, { headers: { origin: ORIGIN } }), 405],
  ["HEAD", () => new Request(`${ROUTE}hello`, { method: "HEAD", headers: { origin: ORIGIN } }), 405],
  [
    "PUT",
    () =>
      new Request(`${ROUTE}hello`, {
        method: "PUT",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "null",
      }),
    405,
  ],
  ["DELETE", () => new Request(`${ROUTE}hello`, { method: "DELETE", headers: { origin: ORIGIN } }), 405],
  [
    "an OPTIONS preflight",
    () =>
      new Request(`${ROUTE}call`, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    403,
  ],
  ["a foreign Origin", () => post("hello", null, { origin: "https://attacker.example" }), 403],
  ["another game's Origin", () => post("hello", null, { origin: "game://other-game" }), 403],
  ["Origin null (a sandboxed frame or a data: page)", () => post("hello", null, { origin: "null" }), 403],
  ["Origin with a trailing slash", () => post("hello", null, { origin: `${ORIGIN}/` }), 403],
  ["Origin in other letters", () => post("hello", null, { origin: "GAME://pond-life" }), 403],
  [
    "a missing Origin",
    () =>
      new Request(`${ROUTE}hello`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" }),
    403,
  ],
  ["a cross-site fetch metadata", () => post("hello", null, { "sec-fetch-site": "cross-site" }), 403],
  ["a same-site (not same-origin) fetch", () => post("hello", null, { "sec-fetch-site": "same-site" }), 403],
  [
    // A frame of another library game inside the shown one: its own origin, but not the game shown.
    "another project than the preview shows (cross-project)",
    () => post("hello", null, { origin: "game://other-game" }, "game://other-game/__genex/ai/v1/"),
    403,
    { ...LIVE, project: "other-game" },
  ],
  ["a stopped preview", () => post("hello", null), 403, { ...LIVE, loaded: null }],
  [
    "text/plain (a simple request with no preflight)",
    () => post("hello", "null", { "content-type": "text/plain" }),
    415,
  ],
  ["a form post", () => post("hello", "null", { "content-type": "application/x-www-form-urlencoded" }), 415],
  ["multipart", () => post("hello", "null", { "content-type": "multipart/form-data; boundary=x" }), 415],
  ["JSON in another charset", () => post("hello", "null", { "content-type": "application/json; charset=latin1" }), 415],
  ["a JSON look-alike type", () => post("hello", "null", { "content-type": "application/jsonx" }), 415],
  [
    "no content type",
    () => new Request(`${ROUTE}hello`, { method: "POST", headers: { origin: ORIGIN }, body: new Uint8Array([110]) }),
    415,
  ],
  ["a 201 KiB body", () => post("call", BIG), 413],
  [
    "a declared length past the cap",
    () => post("hello", "null", { "content-length": String(ROUTE_MAX_BODY_BYTES + 1) }),
    413,
  ],
  ["a chunked body that grows past the cap", () => chunked("call", 300, 1024), 413],
  ["bad JSON", () => post("call", "{not json"), 400],
  ["an empty body", () => post("hello", ""), 400],
  [
    "bytes that are not UTF-8",
    () =>
      new Request(`${ROUTE}hello`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: new Uint8Array([0xff, 0xfe, 0x6e]),
      }),
    400,
  ],
  ["an unknown op", () => post("eval", null), 404],
  ["an op with more path", () => post("call/extra", CALL), 404],
  ["an encoded op", () => post("budget%2Eactive", null), 404],
  ["the prefix alone", () => post("", null), 404],
  ["a body where the op takes null", () => post("hello", {}), 400],
  ["a call with an extra key", () => post("call", { ...CALL, price: 0 }), 400],
  ["a call naming its own payer", () => post("call", { ...CALL, door: "byok" }), 400],
  ["a prototype key", () => post("call", `{"__proto__":{"polluted":true},${JSON.stringify(CALL).slice(1)}`), 400],
  ["a call with a wrong version", () => post("call", { ...CALL, v: 2 }), 400],
  ["a cancel with a malformed ticket", () => post("cancel", { ticket: "../x" }), 400],
  ["a budget request with no tiers", () => post("budget.request", { v: 1, requires: "ai", tiers: [] }), 400],
];

describe("hostile requests are refused with no side effect", () => {
  for (const [what, request, status, page] of HOSTILE) {
    it(what, async () => {
      const { response, seen } = await answer(request(), page ?? LIVE);
      assert.equal(response.status, status);
      assertNoCors(response, what);
      assert.deepEqual(seen.calls, [], "the service never heard of it");
      assert.deepEqual(seen.abandoned, []);
      if (status !== 405) {
        const body = (await response.json()) as { v: number; code: string };
        assert.equal(body.v, GAME_AI_WIRE_VERSION);
        assert.equal(typeof body.code, "string");
      }
    });
  }

  it("says which method it takes", async () => {
    const { response } = await answer(new Request(`${ROUTE}hello`, { headers: { origin: ORIGIN } }));
    assert.equal(response.headers.get("allow"), "POST");
  });

  it("refuses a body past the cap with the prompt-too-large code", async () => {
    const { response } = await answer(post("call", BIG));
    assert.deepEqual(await response.json(), { v: GAME_AI_WIRE_VERSION, code: AiErrorCode.TooLarge });
  });
});

describe("an accepted request reaches play-time AI as the game the preview shows", () => {
  it("derives the caller from the page, never from the body", async () => {
    const { response, seen } = await answer(post("hello", null));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertNoCors(response, "hello");
    assert.deepEqual(await response.json(), { v: GAME_AI_WIRE_VERSION, on: true });
    assert.deepEqual(seen.calls, [
      {
        caller: {
          game: "create:pond-life",
          title: "pond-life title",
          context: AiContext.CreateLive,
          ownGame: true,
          replaying: false,
          channel: "7",
        },
        message: { op: AiBridgeOp.Hello, body: null },
      },
    ]);
  });

  it("answers a call with the service's answer, read field by field", async () => {
    const { response, seen } = await answer(post("call", CALL, { "content-type": "application/json; charset=UTF-8" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ANSWER);
    assert.deepEqual(seen.calls[0]?.message, { op: AiBridgeOp.Call, body: CALL });
  });

  it("takes the game's loopback origin exactly", async () => {
    const base = "http://localhost:41234/__genex/ai/v1/";
    const ok = await answer(post("hello", null, { origin: "http://localhost:41234" }, base));
    assert.equal(ok.response.status, 200);
    const other = await answer(post("hello", null, { origin: "http://127.0.0.1:41234" }, base));
    assert.equal(other.response.status, 403);
    assert.deepEqual(other.seen.calls, []);
  });

  it("takes a same-origin fetch's metadata", async () => {
    const { response } = await answer(post("hello", null, { "sec-fetch-site": "same-origin" }));
    assert.equal(response.status, 200);
  });

  it("answers a service failure as a typed refusal for a call and a 500 for anything else", async () => {
    const failing = () =>
      fakeHost({
        answer: async () => {
          throw new Error("broken");
        },
      });
    const call = await answer(post("call", CALL), LIVE, failing());
    assert.equal(call.response.status, 200);
    assert.deepEqual(await call.response.json(), {
      v: GAME_AI_WIRE_VERSION,
      ok: false,
      ticket: CALL.ticket,
      code: AiErrorCode.Provider,
      retryAfterMs: null,
    });
    const hello = await answer(post("hello", null), LIVE, failing());
    assert.equal(hello.response.status, 500);
    assert.deepEqual(await hello.response.json(), { v: GAME_AI_WIRE_VERSION, code: AiErrorCode.Provider });
  });
});

describe("only the Live human preview reaches play-time AI; everywhere else answers ai_off", () => {
  const off: Array<[string, string, unknown, unknown]> = [
    ["hello", AiBridgeOp.Hello, null, { v: GAME_AI_WIRE_VERSION, on: false }],
    ["doors", AiBridgeOp.Doors, null, { on: false, door: null }],
    [
      "call",
      AiBridgeOp.Call,
      CALL,
      { v: GAME_AI_WIRE_VERSION, ok: false, ticket: CALL.ticket, code: AiErrorCode.Off, retryAfterMs: null },
    ],
    ["cancel", AiBridgeOp.Cancel, { ticket: CALL.ticket }, { canceled: false }],
    ["budget.active", AiBridgeOp.BudgetActive, null, { view: null, code: AiErrorCode.Off }],
    [
      "budget.request",
      AiBridgeOp.BudgetRequest,
      { v: 1, requires: "ai", tiers: ["fast"] },
      { view: null, code: AiErrorCode.Off },
    ],
    ["budget.stop", AiBridgeOp.BudgetStop, null, { stopped: false }],
  ];
  for (const [what, op, body, expected] of off) {
    it(`a facet or offscreen window: ${what}`, async () => {
      const { response, seen } = await answer(post(op, body), { ...LIVE, context: AiContext.HarnessRun });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      assert.deepEqual(seen.calls, []);
    });
  }

  it("suspends Live's budgets while a machine drives it, and still lets a call be canceled", async () => {
    const driven = { ...LIVE, driving: true };
    const call = await answer(post("call", CALL), driven);
    assert.equal(((await call.response.json()) as { code: string }).code, AiErrorCode.Off);
    assert.deepEqual(call.seen.calls, []);
    const request = await answer(post("budget.request", { v: 1, requires: "ai", tiers: ["fast"] }), driven);
    assert.deepEqual(await request.response.json(), { view: null, code: AiErrorCode.Off });
    assert.deepEqual(request.seen.calls, []);
    const cancel = await answer(post("cancel", { ticket: CALL.ticket }), driven);
    assert.deepEqual(await cancel.response.json(), { canceled: true });
    assert.equal(cancel.seen.calls[0]?.message.op, AiBridgeOp.Cancel);
  });
});

describe("a streamed call answers as server-sent events", () => {
  it("sends the text so far, then the reply, then ends", async () => {
    const host = fakeHost({
      answer: async (_message, onDelta) => {
        onDelta?.("Once");
        onDelta?.("Once upon");
        return { ...ANSWER, value: "Once upon a time" };
      },
    });
    const { response } = await answer(post("call", SAY), LIVE, host);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assertNoCors(response, "stream");
    const text = await response.text();
    assert.equal(
      text,
      [
        `event: ${AiRouteEvent.Delta}\ndata: {"text":"Once"}\n\n`,
        `event: ${AiRouteEvent.Delta}\ndata: {"text":"Once upon"}\n\n`,
        `event: ${AiRouteEvent.Reply}\ndata: ${JSON.stringify({ ...ANSWER, value: "Once upon a time" })}\n\n`,
      ].join(""),
    );
  });

  it("cancels the call when the page drops the stream", async () => {
    let finish: (value: unknown) => void = () => {};
    const host = fakeHost({
      answer: (message) =>
        message.op === AiBridgeOp.Cancel
          ? Promise.resolve({ canceled: true })
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    const { response, seen } = await answer(post("call", SAY), LIVE, host);
    await response.body?.cancel();
    assert.deepEqual(seen.calls.at(-1)?.message, { op: AiBridgeOp.Cancel, body: { ticket: SAY.ticket } });
    finish(ANSWER);
  });
});

describe("a page's requests are bounded", () => {
  it(`refuses a request past ${PLAY_AI_BURST} in one window, then takes them again`, async () => {
    let now = 5_000_000;
    const { host, seen } = fakeHost({ now: () => now });
    const gate = createRouteGate(host.clock);
    for (let i = 0; i < PLAY_AI_BURST; i += 1)
      assert.equal((await answerCreateRoute(post("hello", null), LIVE, host, gate)).status, 200);
    const over = await answerCreateRoute(post("hello", null), LIVE, host, gate);
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), { v: GAME_AI_WIRE_VERSION, code: AiErrorCode.RateLimited });
    assert.equal(seen.calls.length, PLAY_AI_BURST);
    now += PLAY_AI_WINDOW_MS;
    assert.equal((await answerCreateRoute(post("hello", null), LIVE, host, gate)).status, 200);
  });

  it(`answers a call past ${PLAY_AI_MAX_PENDING} unanswered with grant_concurrency`, async () => {
    let now = 0;
    const waiting: Array<(value: unknown) => void> = [];
    let holding = true;
    const { host, seen } = fakeHost({
      now: () => now,
      answer: () =>
        holding
          ? new Promise((resolve) => {
              waiting.push(resolve);
            })
          : Promise.resolve(ANSWER),
    });
    const gate = createRouteGate(host.clock);
    const held: Promise<Response>[] = [];
    for (let i = 0; i < PLAY_AI_MAX_PENDING; i += 1) {
      now += PLAY_AI_WINDOW_MS;
      held.push(answerCreateRoute(post("call", CALL), LIVE, host, gate));
    }
    while (seen.calls.length < PLAY_AI_MAX_PENDING) await new Promise((resolve) => setImmediate(resolve));
    now += PLAY_AI_WINDOW_MS;
    const busy = await answerCreateRoute(post("call", CALL), LIVE, host, gate);
    assert.equal(busy.status, 200);
    assert.equal(((await busy.json()) as { code: string }).code, AiErrorCode.Concurrency);
    assert.equal(seen.calls.length, PLAY_AI_MAX_PENDING);
    holding = false;
    for (const resolve of waiting) resolve(ANSWER);
    await Promise.all(held);
    now += PLAY_AI_WINDOW_MS;
    assert.equal((await answerCreateRoute(post("call", CALL), LIVE, host, gate)).status, 200);
    assert.equal(seen.calls.length, PLAY_AI_MAX_PENDING + 1);
  });
});

describe("a machine driving the preview suspends its budgets (createDriveWatch)", () => {
  it("holds while a drive runs and for a quiet spell after the last one", () => {
    let now = 10_000;
    const watch = createDriveWatch({ now: () => now });
    assert.equal(watch.driving(), false);
    const first = watch.begin();
    assert.equal(first.started, true);
    const nested = watch.begin();
    assert.equal(nested.started, false, "already suspended");
    nested.end();
    first.end();
    assert.equal(watch.driving(), true);
    now += AI_DRIVE_QUIET_MS - 1;
    assert.equal(watch.driving(), true);
    now += 1;
    assert.equal(watch.driving(), false);
    assert.equal(watch.begin().started, true, "a new drive suspends again");
  });

  it("never lets a clock that went backwards lengthen the quiet spell", () => {
    let now = 50_000;
    const watch = createDriveWatch({ now: () => now });
    watch.begin().end();
    now -= 60_000;
    assert.equal(watch.driving(), true, "a jump back still counts as just driven");
    now += AI_DRIVE_QUIET_MS;
    assert.equal(watch.driving(), false, "and the spell ends one quiet spell later");
  });

  it("ends a drive once, however often it is ended", () => {
    let now = 0;
    const watch = createDriveWatch({ now: () => now });
    const a = watch.begin();
    const b = watch.begin();
    a.end();
    a.end();
    now += AI_DRIVE_QUIET_MS * 2;
    assert.equal(watch.driving(), true, "b still drives");
    b.end();
    now += AI_DRIVE_QUIET_MS;
    assert.equal(watch.driving(), false);
  });
});
