/**
 * Play-time AI's cards (`main/game-ai/approvals.ts`): a ticket per card shown on a trusted surface,
 * one pending per game, a lapse after five minutes that counts as a decline, a cooldown after a
 * decline, a commit inside the card's first 600 ms refused, the native step asserted before a yes
 * spends plan or money, and a model chosen with Change that cannot be used here refused.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CONSENT_INPUT_DELAY_MS,
  DECLINE_COOLDOWN_MS,
  consentTicket,
  createGameAiConsents,
} from "../../src/main/game-ai/approvals.ts";
import { AiRefusal } from "../../src/main/game-ai/refusal.ts";
import { GameAiNativeStep, type GameAiCaller } from "../../src/main/game-ai/types.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { AiErrorCode, type AiGameKey, type AiModelRef } from "../../src/shared/game-ai.ts";
import {
  AiConsentKind,
  AiConsentRefusal,
  GameAiNoticeKind,
  type AiConsentTicket,
} from "../../src/shared/game-ai-views.ts";
import { BYOK_HAIKU, heldClock, LOCAL_QWEN, noticeLog, PLAN_HAIKU } from "../helpers/game-ai-fakes.ts";

const CROWNS: AiGameKey = "play:proj_crowns";

const caller = (game: AiGameKey = CROWNS): GameAiCaller => ({
  game,
  title: "Crowns of 1444",
  context: AiContext.DesktopPlay,
  ownGame: false,
  replaying: false,
  channel: "wc:7",
});

function setup(options: { usable?: (model: AiModelRef) => boolean; native?: boolean; ttlMs?: number } = {}) {
  const clock = heldClock();
  const log = noticeLog();
  const asserted: string[] = [];
  const consents = createGameAiConsents({
    clock,
    notify: log.notify,
    assertNative: (step) => {
      asserted.push(step);
      if (options.native === false) throw new Error("native step refused in a fixture profile");
    },
    usable: async (_game, model) => options.usable?.(model) ?? true,
    ttlMs: options.ttlMs,
  });
  const card = (kind: AiConsentKind, model: AiModelRef | null, game: AiGameKey = CROWNS): AiConsentTicket =>
    consentTicket(clock, {
      game,
      title: "Crowns of 1444",
      kind,
      model,
      modelLabel: model?.model ?? null,
      balanceCredits: null,
      keepForBuildingPercent: null,
      localDownloadBytes: null,
      maxCredits: null,
    });
  return { clock, log, asserted, consents, card };
}

describe("play-time AI cards", () => {
  it("shows a card, takes the person's yes after the input delay, and asserts the native step first", async () => {
    const { clock, log, asserted, consents, card } = setup();
    const ticket = card(AiConsentKind.Plan, PLAN_HAIKU);
    const asked = consents.ask(caller(), ticket);
    assert.deepEqual(log.notices[0], { kind: GameAiNoticeKind.Consent, consent: ticket });
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    const result = await consents.answer({ ticket: ticket.ticket, approve: true, model: null, unranked: false });
    assert.deepEqual(result, { ok: true, model: PLAN_HAIKU });
    assert.deepEqual(asserted, [GameAiNativeStep.ApprovePlan]);
    assert.deepEqual(await asked, { ticket: ticket.ticket, approve: true, model: PLAN_HAIKU, unranked: false });
    assert.deepEqual(log.notices.at(-1), { kind: GameAiNoticeKind.ConsentClosed, ticket: ticket.ticket });
  });

  it("asserts the paid step for a key or credits, and none for a free model chosen with Change", async () => {
    const { clock, asserted, consents, card } = setup();
    const key = card(AiConsentKind.Key, BYOK_HAIKU);
    void consents.ask(caller(), key);
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await consents.answer({ ticket: key.ticket, approve: true, model: null, unranked: false });
    assert.deepEqual(asserted, [GameAiNativeStep.ApprovePaid]);
    const plan = card(AiConsentKind.Plan, PLAN_HAIKU);
    const asked = consents.ask(caller(), plan);
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await consents.answer({ ticket: plan.ticket, approve: true, model: LOCAL_QWEN, unranked: false });
    assert.equal((await asked).model, LOCAL_QWEN);
    assert.deepEqual(asserted, [GameAiNativeStep.ApprovePaid], "a free model spends nothing");
  });

  it("spends nothing when the native step is refused, and keeps the card open", async () => {
    const { clock, consents, card } = setup({ native: false });
    const ticket = card(AiConsentKind.Credits, BYOK_HAIKU);
    void consents.ask(caller(), ticket);
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await assert.rejects(consents.answer({ ticket: ticket.ticket, approve: true, model: null, unranked: false }));
    const declined = await consents.answer({ ticket: ticket.ticket, approve: false, model: null, unranked: false });
    assert.deepEqual(declined, { ok: true, model: null }, "the card was still open to decline");
  });

  it("refuses a commit inside the card's first 600 ms, and keeps the card", async () => {
    const { clock, consents, card } = setup();
    const ticket = card(AiConsentKind.Plan, PLAN_HAIKU);
    void consents.ask(caller(), ticket);
    clock.advance(CONSENT_INPUT_DELAY_MS - 1);
    const early = await consents.answer({ ticket: ticket.ticket, approve: true, model: null, unranked: false });
    assert.deepEqual(early, { ok: false, code: AiConsentRefusal.TooSoon });
    clock.advance(2);
    assert.equal(
      (await consents.answer({ ticket: ticket.ticket, approve: true, model: null, unranked: false })).ok,
      true,
    );
  });

  it("answers an unknown, answered or lapsed ticket as expired, with no side effect", async () => {
    const { clock, asserted, consents, card } = setup({ ttlMs: 30 });
    const ticket = card(AiConsentKind.Plan, PLAN_HAIKU);
    const asked = consents.ask(caller(), ticket);
    await sleep(60);
    assert.deepEqual(await asked, { ticket: ticket.ticket, approve: false, model: null, unranked: false }, "lapsed");
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    for (const raw of [ticket.ticket, "t_unknownticket"]) {
      const result = await consents.answer({ ticket: raw, approve: true, model: null, unranked: false });
      assert.deepEqual(result, { ok: false, code: AiConsentRefusal.Expired });
    }
    assert.deepEqual(asserted, [], "nothing was asserted, nothing spent");
  });

  it("keeps one pending card per game, and cools down after a decline", async () => {
    const { clock, consents, card } = setup();
    const first = card(AiConsentKind.Plan, PLAN_HAIKU);
    void consents.ask(caller(), first);
    await assert.rejects(consents.ask(caller(), card(AiConsentKind.Key, BYOK_HAIKU)), (error: unknown) => {
      return error instanceof AiRefusal && error.code === AiErrorCode.ConsentPending;
    });
    const other = consents.ask(caller("play:proj_other"), card(AiConsentKind.Key, BYOK_HAIKU, "play:proj_other"));
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    await consents.answer({ ticket: first.ticket, approve: false, model: null, unranked: false });
    await assert.rejects(consents.ask(caller(), card(AiConsentKind.Plan, PLAN_HAIKU)), (error: unknown) => {
      return error instanceof AiRefusal && error.code === AiErrorCode.ConsentDeclined && error.retryAfterMs !== null;
    });
    clock.advance(DECLINE_COOLDOWN_MS + 1);
    const again = card(AiConsentKind.Plan, PLAN_HAIKU);
    void consents.ask(caller(), again);
    consents.close("play:proj_other");
    assert.equal((await other).approve, false, "closing a game declines its card");
    consents.close(CROWNS);
  });

  it("refuses a model chosen with Change that cannot be used here, and keeps the card", async () => {
    const { clock, consents, card } = setup({ usable: (model) => model !== BYOK_HAIKU });
    const ticket = card(AiConsentKind.Plan, PLAN_HAIKU);
    void consents.ask(caller(), ticket);
    clock.advance(CONSENT_INPUT_DELAY_MS + 1);
    const refused = await consents.answer({ ticket: ticket.ticket, approve: true, model: BYOK_HAIKU, unranked: false });
    assert.deepEqual(refused, { ok: false, code: AiConsentRefusal.Unavailable });
    assert.equal(
      (await consents.answer({ ticket: ticket.ticket, approve: true, model: null, unranked: false })).ok,
      true,
    );
  });

  it("closes a game's card without a cooldown when the game leaves", async () => {
    const { log, consents, card } = setup();
    const ticket = card(AiConsentKind.Plan, PLAN_HAIKU);
    const asked = consents.ask(caller(), ticket);
    consents.close(CROWNS);
    assert.equal((await asked).approve, false);
    assert.deepEqual(log.notices.at(-1), { kind: GameAiNoticeKind.ConsentClosed, ticket: ticket.ticket });
    void consents.ask(caller(), card(AiConsentKind.Plan, PLAN_HAIKU));
    consents.close(CROWNS);
  });
});
