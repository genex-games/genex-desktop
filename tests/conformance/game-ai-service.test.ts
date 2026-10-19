/**
 * `GameAiService` (`main/game-ai/service.ts`) over real grants, settings, queue, ledger, cache and
 * cards, with scripted doors: the admission table (each refusal with no side effect — nothing
 * reserved, run, counted or logged), the silent free start, the one repair and D7 (an unusable reply
 * and its repair cost nothing), billing, moderation of shared text (D6), the cache, replay, Stop,
 * abandon and a payer change aborting in-flight calls, Genex's pick and its one card, and the ops
 * every bridge sends.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CONSENT_INPUT_DELAY_MS, createGameAiConsents } from "../../src/main/game-ai/approvals.ts";
import { createGameAiGrants, createGameAiSettings } from "../../src/main/game-ai/budgets.ts";
import { createGameAiCache } from "../../src/main/game-ai/cache.ts";
import { createFixtureDoor } from "../../src/main/game-ai/doors/fixture.ts";
import { createTapeDoor } from "../../src/main/game-ai/doors/tape.ts";
import { createGameAiLedger } from "../../src/main/game-ai/ledger.ts";
import { createGameAiQueue } from "../../src/main/game-ai/queue.ts";
import { AiRefusal } from "../../src/main/game-ai/refusal.ts";
import { createGameAiService, menuOffers, pickModel } from "../../src/main/game-ai/service.ts";
import { createGameAiTapes } from "../../src/main/game-ai/tapes.ts";
import {
  AiWatcherState,
  type AiDoorAnswer,
  type GameAiCaller,
  type GameAiDoorImpl,
  type GenexAiPlatform,
} from "../../src/main/game-ai/types.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import {
  AiAuthority,
  AiBridgeOp,
  AiConsent,
  AiDoor,
  AiErrorCode,
  AiFunding,
  AiGrantStatus,
  AiOp,
  AiProvenance,
  AiRequirement,
  AiTier,
  GAME_AI_WIRE_VERSION,
  type AiCallAnswer,
  type AiCallRequest,
  type AiGameKey,
  type AiModelRef,
} from "../../src/shared/game-ai.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { callKey, callKeyInput, TAPE_WIRE_VERSION } from "../../src/shared/game-ai-tape.ts";
import {
  AiConsentKind,
  AiModelTag,
  AiPickPolicy,
  AiStopReason,
  GameAiNoticeKind,
  type AiModelMenu,
  type GameAiSettingsPatch,
} from "../../src/shared/game-ai-views.ts";
import { type PlayAiBar, PlayAiNote, PlayAiPhase } from "../../src/shared/play-bar.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import {
  BYOK_HAIKU,
  callCounter,
  CREDITS_HAIKU,
  heldClock,
  LOCAL_QWEN,
  menuOf,
  menuRow,
  noticeLog,
  PLAN_HAIKU,
  type ScriptedRun,
  scriptedDoor,
} from "../helpers/game-ai-fakes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CROWNS: AiGameKey = "play:proj_crowns";
const MOSS: AiGameKey = "create:Moss Garden";
const SCHEMA = {
  type: "object",
  properties: { move: { type: "string" } },
  required: ["move"],
  additionalProperties: false,
};
const GOOD: AiDoorAnswer = {
  text: '{"move":"march"}',
  model: "m",
  usage: { inputTokens: 300, outputTokens: 20 },
  costMicros: 4_000,
};
const BAD: AiDoorAnswer = {
  text: "I think Burgundy marches.",
  model: "m",
  usage: { inputTokens: 300, outputTokens: 20 },
  costMicros: 4_000,
};

let tickets = 0;
function call(patch: Partial<AiCallRequest> = {}): AiCallRequest {
  tickets += 1;
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "turn.resolve",
    ticket: `t_${String(tickets).padStart(8, "0")}`,
    grantId: "g_placeholder",
    system: "You narrate a 1444 Europe.",
    prompt: "What does Burgundy do?",
    untrusted: {},
    memory: null,
    schema: SCHEMA,
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 200,
    stream: false,
    ...patch,
  };
}

function caller(patch: Partial<GameAiCaller> = {}): GameAiCaller {
  return {
    game: CROWNS,
    title: "Crowns of 1444",
    context: AiContext.DesktopPlay,
    ownGame: false,
    replaying: false,
    channel: "wc:1",
    ...patch,
  };
}

const LOCAL_ROW = menuRow(LOCAL_QWEN, AiFunding.Free);
const BYOK_ROW = menuRow(BYOK_HAIKU, AiFunding.Key);
const PLAN_ROW = menuRow(PLAN_HAIKU, AiFunding.Plan);

/** genex.games, unused by these tests: every call refuses. */
function noPlatform(): GenexAiPlatform {
  const offline = () => Promise.reject(new Error("offline"));
  return {
    balanceCredits: offline,
    packs: offline,
    checkoutUrl: offline,
    autoTopUp: offline,
    setAutoTopUp: offline,
    confirmTerms: offline,
    answerConfirm: offline,
    deviceFundingAllowed: offline,
    sendReport: offline,
    sendFitCounts: offline,
  };
}

interface RigOptions {
  menu?: (game: AiGameKey) => AiModelMenu;
  scripts?: Partial<Record<AiDoor, ScriptedRun[]>>;
  ready?: Partial<Record<AiDoor, boolean>>;
  settings?: GameAiSettingsPatch;
  moderate?: (text: string) => Promise<boolean>;
  worstMicros?: number;
}

async function rig(options: RigOptions = {}) {
  const dir = await tmpDir("game-ai-service-");
  const clock = heldClock();
  const settings = createGameAiSettings({ file: path.join(dir, "settings.json"), platform: noPlatform() });
  await settings.load();
  if (options.settings) await settings.save(options.settings);
  const calls = callCounter();
  const grantsFile = path.join(dir, "grants.json");
  const grants = createGameAiGrants({ file: grantsFile, clock, calls, limits: () => settings.limits() });
  await grants.load();
  const ledger = createGameAiLedger({ dir, clock, record: () => undefined });
  const notices = noticeLog();
  const bars: PlayAiBar[] = [];
  const menuFor = options.menu ?? ((game: AiGameKey) => menuOf(game, [LOCAL_ROW, BYOK_ROW, PLAN_ROW]));
  const consents = createGameAiConsents({
    clock,
    notify: notices.notify,
    assertNative: () => undefined,
    usable: async (game, model) => menuOffers(menuFor(game), model) !== null,
  });
  const door = (id: AiDoor) =>
    scriptedDoor(id, options.scripts?.[id] ?? [], {
      ready: { ready: options.ready?.[id] ?? true },
      worstMicros: options.worstMicros ?? 50_000,
    });
  const local = door(AiDoor.Local);
  const byok = door(AiDoor.Byok);
  const plan = door(AiDoor.Plan);
  const dev = door(AiDoor.GenexDev);
  const tape = createTapeDoor();
  const doors = new Map<AiDoor, GameAiDoorImpl>([
    [AiDoor.Local, local],
    [AiDoor.Byok, byok],
    [AiDoor.Plan, plan],
    [AiDoor.GenexDev, dev],
    [AiDoor.Tape, tape],
    [AiDoor.Fixture, createFixtureDoor()],
  ]);
  const service = createGameAiService({
    clock,
    grants,
    queue: createGameAiQueue({ slotWaitMs: 200, buildWaitMs: 50 }),
    doors,
    ledger,
    cache: createGameAiCache({ clock }),
    tapes: createGameAiTapes(),
    platform: noPlatform(),
    watcher: {
      state: () => ({ state: AiWatcherState.Off, runners: [], resetsAt: null }),
      start: async () => undefined,
      stop: async () => undefined,
      nudge: () => undefined,
      building: () => undefined,
    },
    consents,
    settings,
    assertNative: () => undefined,
    notify: notices.notify,
    drawPill: (_game, bar) => void bars.push(bar),
    menu: async (game) => menuFor(game),
    moderate: options.moderate ?? (async () => true),
  });
  const ask = (request: AiCallRequest, who = caller(), onDelta?: (text: string) => void) =>
    service.handle(who, { op: AiBridgeOp.Call, body: request }, onDelta);
  return {
    service,
    grants,
    grantsFile,
    calls,
    ledger,
    notices,
    bars,
    clock,
    consents,
    ask,
    local,
    byok,
    plan,
    dev,
    tape,
    settings,
  };
}

const doorRuns = (r: Awaited<ReturnType<typeof rig>>) =>
  r.local.runs.length + r.byok.runs.length + r.plan.runs.length + r.dev.runs.length;

function refusal(answer: AiCallAnswer): AiErrorCode | null {
  return answer.ok ? null : answer.code;
}

/** The game's grant on `model`, as a person's yes would leave it. */
async function granted(r: Awaited<ReturnType<typeof rig>>, model: AiModelRef, game: AiGameKey = CROWNS) {
  return r.grants.grant(game, model, AiConsent.Card, AiRequirement.Optional);
}

describe("play-time AI service: admission", () => {
  it("refuses with no side effect: nothing reserved, run, counted or logged", async () => {
    type Row = {
      label: string;
      setup?: (r: Awaited<ReturnType<typeof rig>>) => Promise<unknown>;
      request?: Partial<AiCallRequest>;
      who?: Partial<GameAiCaller>;
      code: AiErrorCode;
      options?: RigOptions;
    };
    const rows: Row[] = [
      {
        label: "a schema outside the dialect",
        request: { schema: { type: "object", properties: { a: { type: "date" } } } },
        code: AiErrorCode.InvalidSchema,
      },
      { label: "AI off for the game", setup: (r) => r.grants.setOn(CROWNS, false), code: AiErrorCode.Off },
      {
        label: "a paid first use with no yes",
        options: { menu: (game) => menuOf(game, [BYOK_ROW]) },
        code: AiErrorCode.ConsentRequired,
      },
      {
        label: "a plan first use with no yes",
        options: { menu: (game) => menuOf(game, [PLAN_ROW]) },
        code: AiErrorCode.ConsentRequired,
      },
      {
        label: "a free model not ready",
        options: { menu: (game) => menuOf(game, [LOCAL_ROW]), ready: { [AiDoor.Local]: false } },
        code: AiErrorCode.ConsentRequired,
      },
      {
        label: "a key in a harness run",
        setup: (r) => granted(r, BYOK_HAIKU),
        who: { context: AiContext.HarnessRun },
        code: AiErrorCode.NoFunding,
      },
      {
        label: "a shared answer on an unverified door",
        setup: (r) => granted(r, LOCAL_QWEN),
        request: { authority: AiAuthority.Shared },
        code: AiErrorCode.NeedsVerified,
      },
      {
        label: "a leaderboard on an unverified door",
        setup: (r) => granted(r, LOCAL_QWEN),
        options: { menu: (game) => menuOf(game, [LOCAL_ROW], { leaderboard: true }) },
        code: AiErrorCode.NeedsVerified,
      },
      {
        label: "the plan outside its unlock",
        setup: (r) => granted(r, PLAN_HAIKU, MOSS),
        who: { game: MOSS, context: AiContext.CreateLive, ownGame: true },
        code: AiErrorCode.PlanNotAllowed,
      },
      {
        label: "the granted door down",
        setup: (r) => granted(r, BYOK_HAIKU),
        options: { ready: { [AiDoor.Byok]: false } },
        code: AiErrorCode.DoorUnavailable,
      },
      {
        label: "a paused game",
        setup: async (r) => r.grants.setStatus((await granted(r, BYOK_HAIKU)).id, AiGrantStatus.Paused),
        code: AiErrorCode.Paused,
      },
    ];
    for (const row of rows) {
      const r = await rig(row.options);
      await row.setup?.(r);
      const before = await readFile(r.grantsFile, "utf8").catch(() => "");
      const answer = await r.ask(call(row.request), caller(row.who));
      assert.equal(refusal(answer), row.code, row.label);
      assert.equal(doorRuns(r), 0, `${row.label}: no door ran`);
      assert.equal(await readFile(r.grantsFile, "utf8").catch(() => ""), before, `${row.label}: nothing reserved`);
      assert.equal(r.calls.calls.size, 0, `${row.label}: nothing counted`);
      assert.deepEqual(await r.ledger.recent(10), [], `${row.label}: nothing logged`);
    }
  });

  it("never lets a game reach another game's grant by naming it", async () => {
    const r = await rig({ menu: (game) => menuOf(game, [BYOK_ROW]) });
    const theirs = await granted(r, BYOK_HAIKU, MOSS);
    const answer = await r.ask(call({ grantId: theirs.id }));
    assert.equal(refusal(answer), AiErrorCode.ConsentRequired, "the caller's game holds no grant");
    assert.equal(r.grants.live(MOSS)?.spentMicros, 0);
  });

  it("refuses a second call on a ticket still running", async () => {
    const r = await rig({ scripts: { [AiDoor.Local]: [async () => (await sleep(30), GOOD)] } });
    const request = call();
    const first = r.ask(request);
    await sleep(5);
    assert.equal(refusal(await r.ask(request)), AiErrorCode.BadRequest);
    assert.ok((await first).ok);
  });
});

describe("play-time AI service: a call", () => {
  it("starts a free, ready model with no tap and tells the pill", async () => {
    const r = await rig({ scripts: { [AiDoor.Local]: [GOOD] } });
    const answer = await r.ask(call());
    assert.ok(answer.ok);
    assert.deepEqual(answer.value, { move: "march" });
    assert.equal(answer.source, AiDoor.Local);
    assert.equal(answer.provenance, AiProvenance.Unverified);
    const grant = r.grants.live(CROWNS);
    assert.equal(grant?.consent, AiConsent.Silent);
    assert.ok(r.notices.notices.some((notice) => notice.kind === GameAiNoticeKind.Changed));
    assert.ok(r.bars.some((bar) => bar.note === PlayAiNote.FirstUse && bar.model?.model === LOCAL_QWEN.model));
    assert.equal(r.bars.at(-1)?.phase, PlayAiPhase.Ready);
    const sent = r.local.runs[0];
    assert.equal(sent?.game, CROWNS);
    assert.equal(sent?.repair, null);
  });

  it("repairs a reply once and charges neither the bad reply nor its repair (D7)", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [BAD, GOOD] } });
    await granted(r, BYOK_HAIKU);
    const answer = await r.ask(call());
    assert.ok(answer.ok);
    assert.equal(r.byok.runs.length, 2);
    assert.equal(r.byok.runs[1]?.repair?.previous, BAD.text);
    assert.match(r.byok.runs[1]?.repair?.problem ?? "", /JSON/);
    assert.equal(r.grants.live(CROWNS)?.spentMicros, 0, "D7");
    const [line] = await r.ledger.recent(1);
    assert.equal(line?.repaired, true);
    assert.equal(line?.costMicros, 0);
  });

  it("answers invalid_output after the repair, charging nothing and logging the outcome", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [BAD, BAD] } });
    await granted(r, BYOK_HAIKU);
    assert.equal(refusal(await r.ask(call())), AiErrorCode.InvalidOutput);
    assert.equal(r.byok.runs.length, 2, "one repair, never more");
    assert.equal(r.grants.live(CROWNS)?.spentMicros, 0);
    assert.equal((await r.ledger.recent(1))[0]?.code, AiErrorCode.InvalidOutput);
  });

  it("charges a usable reply what it cost, and logs ids, counts and money only", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [GOOD] } });
    const grant = await granted(r, BYOK_HAIKU);
    const answer = await r.ask(call({ untrusted: { chat: "my secret plan" } }));
    assert.ok(answer.ok);
    assert.equal(r.grants.live(CROWNS)?.spentMicros, 4_000);
    assert.equal(r.calls.tokens.get(CROWNS), 320);
    const [line] = await r.ledger.recent(1);
    assert.equal(line?.grantId, grant.id);
    assert.equal(line?.costMicros, 4_000);
    assert.ok(!JSON.stringify(line).includes("secret"));
  });

  it("tells the game a door's failure by its kind, never its text, and charges nothing", async () => {
    const r = await rig({
      scripts: {
        [AiDoor.Byok]: [new EngineError(EngineFailureKind.RateLimit, "openrouter", "429 key sk-or-v1-abc", 7_000)],
      },
    });
    await granted(r, BYOK_HAIKU);
    const answer = await r.ask(call());
    assert.equal(refusal(answer), AiErrorCode.RateLimited);
    assert.equal(!answer.ok && answer.retryAfterMs, 7_000);
    assert.ok(!JSON.stringify(answer).includes("sk-or"));
    assert.equal(r.grants.live(CROWNS)?.spentMicros, 0);
  });

  it("moderates text other players will see, and charges nothing it refuses (D6)", async () => {
    const shared = call({ authority: AiAuthority.Shared });
    const devCaller = caller({ game: MOSS, context: AiContext.CreateLive, ownGame: true });
    const devModel: AiModelRef = { door: AiDoor.GenexDev, engine: "genex", model: "anthropic/claude-haiku-4.5" };
    for (const moderate of [async () => false, async () => Promise.reject(new Error("classifier down"))]) {
      const r = await rig({ scripts: { [AiDoor.GenexDev]: [GOOD] }, moderate });
      await granted(r, devModel, MOSS);
      assert.equal(refusal(await r.ask({ ...shared, ticket: `${shared.ticket}x` }, devCaller)), AiErrorCode.Moderated);
      assert.equal(r.grants.live(MOSS)?.spentMicros, 0);
    }
    const passes = await rig({ scripts: { [AiDoor.GenexDev]: [GOOD] } });
    await granted(passes, devModel, MOSS);
    const answer = await passes.ask(shared, devCaller);
    assert.ok(answer.ok);
    assert.equal(answer.provenance, AiProvenance.Verified);
  });

  it("answers the same call again from the cache, from the same door only", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [GOOD], [AiDoor.Local]: [GOOD] } });
    await granted(r, BYOK_HAIKU);
    const request = call();
    assert.ok((await r.ask(request)).ok);
    const again = await r.ask({ ...request, ticket: "t_again001" });
    assert.ok(again.ok && again.cached);
    assert.equal(r.byok.runs.length, 1);
    await granted(r, LOCAL_QWEN);
    const local = await r.ask({ ...request, ticket: "t_again002" });
    assert.ok(local.ok && !local.cached, "another door's answer is never served");
    assert.equal(r.local.runs.length, 1);
  });

  it("replays from the loaded tape with no grant, no hold and no live call", async () => {
    const r = await rig();
    const request = call();
    const key = await callKey(callKeyInput(request));
    r.tape.load(MOSS, [
      {
        v: TAPE_WIRE_VERSION,
        key,
        n: 0,
        site: request.site,
        op: AiOp.Ask,
        value: { move: "hold" },
        source: AiDoor.Local,
        model: "qwen3:8b",
        latencyFrames: 2,
        usage: null,
      },
    ]);
    const harness = caller({ game: MOSS, context: AiContext.HarnessRun, replaying: true });
    const answer = await r.ask(request, harness);
    assert.ok(answer.ok);
    assert.deepEqual(answer.value, { move: "hold" });
    assert.equal(answer.provenance, AiProvenance.Replay);
    assert.equal(refusal(await r.ask(call(), harness)), AiErrorCode.Unrecorded, "a miss is never a live call");
    assert.equal(doorRuns(r), 0);
    assert.equal(r.grants.live(MOSS), null);
  });

  it("streams a say's text as it arrives", async () => {
    const r = await rig({
      scripts: {
        [AiDoor.Local]: [async () => ({ text: "Hail, traveller.", model: "m", usage: null, costMicros: 0 })],
      },
    });
    const said: string[] = [];
    const answer = await r.ask(call({ op: AiOp.Say, schema: null, stream: true }), caller(), (text) => said.push(text));
    assert.ok(answer.ok);
    assert.equal(answer.value, "Hail, traveller.");
  });
});

describe("play-time AI service: stops", () => {
  /** A door that answers only when its call is aborted. */
  const untilAborted: ScriptedRun = (_call, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new EngineError(EngineFailureKind.Aborted, "fake", "stopped")), {
        once: true,
      });
    });

  it("Stop turns the game's AI off and aborts its calls within a second", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [untilAborted] } });
    await granted(r, BYOK_HAIKU);
    const running = r.ask(call());
    await sleep(5);
    const stopped = Date.now();
    await r.service.stop(CROWNS);
    assert.equal(refusal(await running), AiErrorCode.Canceled);
    assert.ok(Date.now() - stopped < 1_000);
    assert.equal(refusal(await r.ask(call())), AiErrorCode.Off);
    assert.equal(r.bars.at(-1)?.phase, PlayAiPhase.Off);
    assert.equal(r.grants.live(CROWNS)?.spentMicros, 0);
  });

  it("a page that goes away abandons its calls, and only its own", async () => {
    // Each game's call answers as its own: the abandoned page's waits, the other page's answers.
    const byGame: ScriptedRun = (run, signal) => (run.game === CROWNS ? untilAborted : async () => GOOD)(run, signal);
    const r = await rig({ scripts: { [AiDoor.Byok]: [byGame, byGame] } });
    await granted(r, BYOK_HAIKU);
    await granted(r, BYOK_HAIKU, MOSS);
    const gone = r.ask(call());
    await sleep(5);
    r.service.abandon("wc:1");
    assert.equal(refusal(await gone), AiErrorCode.Canceled);
    assert.ok((await r.ask(call(), caller({ game: MOSS, channel: "wc:2" }))).ok, "another page plays on");
  });

  it("a payer change stops every grant naming the door and aborts its calls", async () => {
    const r = await rig({ scripts: { [AiDoor.Byok]: [untilAborted] } });
    await granted(r, BYOK_HAIKU);
    const running = r.ask(call());
    await sleep(5);
    await r.service.payerChanged(AiDoor.Byok);
    assert.equal(refusal(await running), AiErrorCode.Canceled);
    assert.equal(r.grants.live(CROWNS), null);
    assert.equal(r.grants.consented(CROWNS, AiDoor.Byok), false);
  });

  it("shows the plan-resting card with its reset, once a minute at most", async () => {
    const r = await rig({
      scripts: {
        [AiDoor.Plan]: [
          new AiRefusal(AiErrorCode.WaitingForPlan, 60_000),
          new AiRefusal(AiErrorCode.WaitingForPlan, 60_000),
        ],
      },
      settings: { allowPlan: true },
    });
    const owner = caller({ game: MOSS, context: AiContext.CreateLive, ownGame: true });
    await granted(r, PLAN_HAIKU, MOSS);
    assert.equal(refusal(await r.ask(call(), owner)), AiErrorCode.WaitingForPlan);
    await r.ask(call(), owner);
    const stops = r.notices.notices.filter((notice) => notice.kind === GameAiNoticeKind.Stop);
    assert.equal(stops.length, 1);
    const card = stops[0]?.kind === GameAiNoticeKind.Stop ? stops[0].card : null;
    assert.equal(card?.reason, AiStopReason.PlanResting);
    assert.equal(card?.resetsAt, new Date(r.clock.now() + 60_000).toISOString());
    assert.deepEqual(card?.alternative, LOCAL_QWEN, "a free model to go on with");
  });

  it("pauses a game at its daily alert and shows the card", async () => {
    const r = await rig({
      scripts: { [AiDoor.Byok]: [{ ...GOOD, costMicros: 12_000 }] },
      settings: { dailyAlertCredits: 1 },
    });
    await granted(r, BYOK_HAIKU);
    assert.ok((await r.ask(call())).ok);
    assert.equal(r.grants.live(CROWNS)?.status, AiGrantStatus.Paused);
    const card = r.notices.notices.find((notice) => notice.kind === GameAiNoticeKind.Stop);
    assert.equal(card?.kind === GameAiNoticeKind.Stop && card.card.reason, AiStopReason.DailyAlert);
    assert.equal(refusal(await r.ask(call())), AiErrorCode.Paused);
  });
});

describe("play-time AI service: Genex picks, and asks once", () => {
  it("picks the last model used, then the maker's pick, then free, plan, key, credits", () => {
    const best = { ...BYOK_ROW, tag: AiModelTag.Best };
    const menu = menuOf(CROWNS, [PLAN_ROW, BYOK_ROW, LOCAL_ROW]);
    assert.deepEqual(pickModel(menu, AiPickPolicy.Best, AiContext.DesktopPlay)?.model, LOCAL_QWEN, "free first");
    assert.deepEqual(
      pickModel({ ...menu, current: PLAN_HAIKU }, AiPickPolicy.Best, AiContext.CreateLive)?.model,
      PLAN_HAIKU,
      "last used",
    );
    assert.deepEqual(
      pickModel(menuOf(CROWNS, [LOCAL_ROW, best]), AiPickPolicy.Best, AiContext.DesktopPlay)?.model,
      BYOK_HAIKU,
      "the maker's pick",
    );
    assert.deepEqual(
      pickModel(menuOf(CROWNS, [BYOK_ROW, PLAN_ROW]), AiPickPolicy.Best, AiContext.CreateLive)?.model,
      PLAN_HAIKU,
      "plan before key",
    );
    assert.equal(
      pickModel(menuOf(CROWNS, [BYOK_ROW]), AiPickPolicy.FreeOnly, AiContext.DesktopPlay),
      null,
      "free only",
    );
    const credits = menuOf(CROWNS, [], {
      genex: { signedIn: true, balanceCredits: 300, recommended: CREDITS_HAIKU, recommendedLabel: "Haiku 4.5" },
    });
    assert.deepEqual(
      pickModel(credits, AiPickPolicy.Best, AiContext.DesktopPlay)?.model,
      CREDITS_HAIKU,
      "credits last",
    );
    assert.equal(
      pickModel(menuOf(CROWNS, [{ ...LOCAL_ROW, ready: false }]), AiPickPolicy.Best, AiContext.DesktopPlay),
      null,
      "never a model that is not ready",
    );
    assert.equal(
      pickModel(menuOf(CROWNS, [PLAN_ROW]), AiPickPolicy.Best, AiContext.DesktopPlay),
      null,
      "never the plan in Play",
    );
  });

  it("grants a free model on request with no card", async () => {
    const r = await rig();
    const answer = await r.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Ai,
      tiers: [AiTier.Fast],
    });
    assert.equal(answer.code, null);
    assert.equal(answer.view?.door, AiDoor.Local);
    assert.ok(!r.notices.notices.some((notice) => notice.kind === GameAiNoticeKind.Consent));
  });

  it("asks once before a key is used, and not again for that game and door", async () => {
    const r = await rig({ menu: (game) => menuOf(game, [BYOK_ROW]) });
    const asked = r.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Optional,
      tiers: [AiTier.Fast],
    });
    await sleep(5);
    const card = r.notices.notices.find((notice) => notice.kind === GameAiNoticeKind.Consent);
    assert.ok(card?.kind === GameAiNoticeKind.Consent);
    assert.equal(card.consent.kind, AiConsentKind.Key);
    assert.equal(card.consent.title, "Crowns of 1444");
    assert.ok(!JSON.stringify(card).includes("price"), "no price on the card");
    assert.ok(r.bars.some((bar) => bar.phase === PlayAiPhase.NeedsYou));
    r.clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    assert.deepEqual(
      await r.consents.answer({ ticket: card.consent.ticket, approve: true, model: null, unranked: false }),
      { ok: true, model: BYOK_HAIKU },
    );
    const answer = await asked;
    assert.equal(answer.view?.door, AiDoor.Byok);
    assert.equal(r.grants.live(CROWNS)?.consent, AiConsent.Card);
    await r.grants.grant(CROWNS, LOCAL_QWEN, AiConsent.Menu, AiRequirement.Optional);
    const before = r.notices.notices.length;
    const back = await r.service.pick(CROWNS, BYOK_HAIKU);
    assert.deepEqual(back, { ok: true, model: BYOK_HAIKU }, "the door was agreed to before");
    assert.ok(!r.notices.notices.slice(before).some((notice) => notice.kind === GameAiNoticeKind.Consent));
  });

  it("answers a declined card as declined, with no grant", async () => {
    const r = await rig({ menu: (game) => menuOf(game, [BYOK_ROW]) });
    const asked = r.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Optional,
      tiers: [AiTier.Fast],
    });
    await sleep(5);
    const card = r.notices.notices.find((notice) => notice.kind === GameAiNoticeKind.Consent);
    assert.ok(card?.kind === GameAiNoticeKind.Consent);
    r.clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await r.consents.answer({ ticket: card.consent.ticket, approve: false, model: null, unranked: false });
    assert.deepEqual(await asked, { view: null, code: AiErrorCode.ConsentDeclined });
    assert.equal(r.grants.live(CROWNS), null);
  });

  it("asks a leaderboard game first, and plays it unranked on the person's free model", async () => {
    const r = await rig({
      menu: (game) => menuOf(game, [LOCAL_ROW], { leaderboard: true }),
      scripts: { [AiDoor.Local]: [GOOD] },
    });
    const asked = r.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Optional,
      tiers: [AiTier.Fast],
    });
    await sleep(5);
    const card = r.notices.notices.find((notice) => notice.kind === GameAiNoticeKind.Consent);
    assert.ok(card?.kind === GameAiNoticeKind.Consent);
    assert.equal(card.consent.kind, AiConsentKind.Leaderboard);
    r.clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await r.consents.answer({ ticket: card.consent.ticket, approve: true, model: null, unranked: true });
    assert.equal((await asked).view?.door, AiDoor.Local);
    assert.ok((await r.ask(call())).ok, "unranked: the free model's answer counts for this player only");
    assert.equal(r.bars.at(-1)?.unranked, true);
  });

  it("shows the set-up card for a game that needs AI when nothing is set up", async () => {
    const r = await rig({ menu: (game) => menuOf(game, []) });
    const asked = r.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Ai,
      tiers: [AiTier.Fast],
    });
    await sleep(5);
    const card = r.notices.notices.find((notice) => notice.kind === GameAiNoticeKind.Consent);
    assert.ok(card?.kind === GameAiNoticeKind.Consent);
    assert.equal(card.consent.kind, AiConsentKind.SetUp);
    r.consents.close(CROWNS);
    assert.equal((await asked).code, AiErrorCode.ConsentDeclined);
    const optional = await rig({ menu: (game) => menuOf(game, []) });
    const quiet = await optional.service.requestGrant(caller(), {
      v: GAME_AI_WIRE_VERSION,
      requires: AiRequirement.Optional,
      tiers: [AiTier.Fast],
    });
    assert.equal(quiet.code, AiErrorCode.DoorUnavailable, "a game that works without AI plays on");
  });

  it("refuses a pick of a model the menu does not offer ready", async () => {
    const r = await rig();
    await assert.rejects(r.service.pick(CROWNS, { door: AiDoor.Byok, engine: "openrouter", model: "x/not-offered" }));
    assert.equal(r.grants.live(CROWNS), null);
  });
});

describe("play-time AI service: the bridge's ops", () => {
  it("answers hello, doors, the active grant, cancel and the game's own stop", async () => {
    const r = await rig({ scripts: { [AiDoor.Local]: [GOOD] } });
    const who = caller();
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.Hello, body: null }), {
      v: GAME_AI_WIRE_VERSION,
      on: true,
    });
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.Doors, body: null }), { on: true, door: null });
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.BudgetActive, body: null }), {
      view: null,
      code: null,
    });
    await r.ask(call());
    const active = await r.service.handle(who, { op: AiBridgeOp.BudgetActive, body: null });
    assert.equal(active.view?.door, AiDoor.Local);
    assert.deepEqual(Object.keys(active.view ?? {}).sort(), [
      "door",
      "id",
      "planResetsAt",
      "planUsedPercent",
      "spentMicros",
      "status",
    ]);
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.Cancel, body: { ticket: "t_notmine01" } }), {
      canceled: false,
    });
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.BudgetStop, body: null }), { stopped: true });
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.Hello, body: null }), {
      v: GAME_AI_WIRE_VERSION,
      on: false,
    });
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.BudgetActive, body: null }), {
      view: null,
      code: AiErrorCode.Off,
    });
    await r.service.enable(CROWNS);
    assert.deepEqual(await r.service.handle(who, { op: AiBridgeOp.Doors, body: null }), {
      on: true,
      door: AiDoor.Local,
    });
  });
});
