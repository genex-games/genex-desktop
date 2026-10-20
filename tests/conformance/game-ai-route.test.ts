/**
 * The pay-model resolver (`src/shared/game-ai-route.ts`): one pure table that picks the one door a
 * call goes to, or why none. A free model starts with no tap only on this Mac or a free OpenCode
 * model, ready, outside a leaderboard and with AI on; everything else waits for a person's yes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiAuthority, AiConsent, AiDoor, AiErrorCode, AiGrantStatus, AiProvenance } from "../../src/shared/game-ai.ts";
import {
  AiContext,
  type DoorReadiness,
  isLegalDoor,
  LEGAL_DOORS,
  type RouteInput,
  routeCall,
  silentStartAllowed,
} from "../../src/shared/game-ai-route.ts";

const ready = (door: AiDoor, more: Partial<DoorReadiness> = {}): DoorReadiness => ({
  door,
  ready: true,
  json: true,
  loading: false,
  maxInputTokens: 32_000,
  ...more,
});

const ALL_READY = Object.values(AiDoor).map((door) => ready(door));

const base = (more: Partial<RouteInput> = {}): RouteInput => ({
  context: AiContext.DesktopPlay,
  replaying: false,
  aiOff: false,
  grant: null,
  choice: null,
  authority: AiAuthority.Local,
  leaderboard: false,
  needsJson: true,
  promptTokens: 100,
  planUnlocked: false,
  doors: ALL_READY,
  ...more,
});

const active = (door: AiDoor) => ({ door, status: AiGrantStatus.Active });

describe("routeCall", () => {
  const rows: Array<[string, Partial<RouteInput>, ReturnType<typeof routeCall>]> = [
    ["AI off answers off, even replaying", { aiOff: true, replaying: true }, { ok: false, code: AiErrorCode.Off }],
    [
      "a replay answers from its tape",
      { replaying: true, grant: active(AiDoor.Byok) },
      { ok: true, door: AiDoor.Tape, provenance: AiProvenance.Replay, start: null },
    ],
    [
      "a ready model on this Mac starts with no tap",
      { choice: { door: AiDoor.Local, free: true } },
      { ok: true, door: AiDoor.Local, provenance: AiProvenance.Unverified, start: AiConsent.Silent },
    ],
    [
      "a free OpenCode model starts with no tap",
      { choice: { door: AiDoor.OpenCode, free: true } },
      { ok: true, door: AiDoor.OpenCode, provenance: AiProvenance.Unverified, start: AiConsent.Silent },
    ],
    [
      "a paid OpenCode model waits for a yes",
      { choice: { door: AiDoor.OpenCode, free: false } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a key waits for a yes",
      { choice: { door: AiDoor.Byok, free: false } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    ["no choice at all waits for a yes", {}, { ok: false, code: AiErrorCode.ConsentRequired }],
    [
      "a leaderboard game never starts silently",
      { leaderboard: true, choice: { door: AiDoor.Local, free: true } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a shared answer never starts silently",
      { authority: AiAuthority.Shared, choice: { door: AiDoor.Local, free: true } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a model on this Mac still loading does not start silently",
      { choice: { door: AiDoor.Local, free: true }, doors: [ready(AiDoor.Local, { loading: true })] },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a free door not legal here does not start silently",
      { context: AiContext.HarnessRun, choice: { door: AiDoor.OpenCode, free: true } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a granted key answers in Play",
      { grant: active(AiDoor.Byok) },
      { ok: true, door: AiDoor.Byok, provenance: AiProvenance.Unverified, start: null },
    ],
    [
      "Genex credits go through the platform lane",
      { grant: active(AiDoor.GenexCredits) },
      { ok: false, code: AiErrorCode.PlatformDoor },
    ],
    [
      "the watcher's plan goes through the platform lane",
      { grant: active(AiDoor.PlanWatcher) },
      { ok: false, code: AiErrorCode.PlatformDoor },
    ],
    ["the plan door is not legal in Play", { grant: active(AiDoor.Plan) }, { ok: false, code: AiErrorCode.NoFunding }],
    ["a tape is not a door in Play", { grant: active(AiDoor.Tape) }, { ok: false, code: AiErrorCode.NoFunding }],
    [
      "a harness run never reaches a key",
      { context: AiContext.HarnessRun, grant: active(AiDoor.Byok) },
      { ok: false, code: AiErrorCode.NoFunding },
    ],
    [
      "a leaderboard session needs a verified door",
      { leaderboard: true, grant: active(AiDoor.Local) },
      { ok: false, code: AiErrorCode.NeedsVerified },
    ],
    [
      "a shared answer needs a verified door",
      { authority: AiAuthority.Shared, grant: active(AiDoor.Byok) },
      { ok: false, code: AiErrorCode.NeedsVerified },
    ],
    [
      "the creator's development credits are verified",
      { context: AiContext.CreateLive, authority: AiAuthority.Shared, grant: active(AiDoor.GenexDev) },
      { ok: true, door: AiDoor.GenexDev, provenance: AiProvenance.Verified, start: null },
    ],
    [
      "the plan needs its unlock in Create",
      { context: AiContext.CreateLive, grant: active(AiDoor.Plan) },
      { ok: false, code: AiErrorCode.PlanNotAllowed },
    ],
    [
      "the unlocked plan answers in Create",
      { context: AiContext.CreateLive, planUnlocked: true, grant: active(AiDoor.Plan) },
      { ok: true, door: AiDoor.Plan, provenance: AiProvenance.Unverified, start: null },
    ],
    [
      "a resting plan waits",
      { grant: { door: AiDoor.Byok, status: AiGrantStatus.WaitingForPlan } },
      { ok: false, code: AiErrorCode.WaitingForPlan },
    ],
    [
      "a paused grant waits for the person",
      { grant: { door: AiDoor.Byok, status: AiGrantStatus.Paused } },
      { ok: false, code: AiErrorCode.Paused },
    ],
    [
      "a grant turned off answers off",
      { grant: { door: AiDoor.Local, status: AiGrantStatus.Off } },
      { ok: false, code: AiErrorCode.Off },
    ],
    [
      "a replaced grant needs a new yes",
      { grant: { door: AiDoor.Byok, status: AiGrantStatus.Replaced } },
      { ok: false, code: AiErrorCode.ConsentRequired },
    ],
    [
      "a door that is not listed is down",
      { grant: active(AiDoor.Byok), doors: [] },
      { ok: false, code: AiErrorCode.DoorUnavailable },
    ],
    [
      "a loading model says so",
      { grant: active(AiDoor.Local), doors: [ready(AiDoor.Local, { loading: true })] },
      { ok: false, code: AiErrorCode.LocalLoading },
    ],
    [
      "a door without JSON is down for a JSON call",
      { grant: active(AiDoor.Local), doors: [ready(AiDoor.Local, { json: false })] },
      { ok: false, code: AiErrorCode.DoorUnavailable },
    ],
    [
      "a door without JSON answers a text call",
      { grant: active(AiDoor.Local), needsJson: false, doors: [ready(AiDoor.Local, { json: false })] },
      { ok: true, door: AiDoor.Local, provenance: AiProvenance.Unverified, start: null },
    ],
    [
      "a prompt over the door's window is too large",
      { grant: active(AiDoor.Local), promptTokens: 40_000 },
      { ok: false, code: AiErrorCode.TooLarge },
    ],
  ];
  for (const [what, input, decision] of rows) it(what, () => assert.deepEqual(routeCall(base(input)), decision));

  it("never routes to a door the context does not list", () => {
    for (const context of Object.values(AiContext)) {
      for (const door of Object.values(AiDoor)) {
        const decision = routeCall(base({ context, grant: active(door), planUnlocked: true }));
        if (decision.ok) assert.ok(isLegalDoor(context, decision.door), `${context} → ${door}`);
      }
    }
  });

  it("keeps the platform doors out of every host context", () => {
    for (const doors of Object.values(LEGAL_DOORS)) {
      const legal: readonly AiDoor[] = doors;
      assert.ok(!legal.includes(AiDoor.GenexCredits) && !legal.includes(AiDoor.PlanWatcher));
    }
  });

  it("allows a silent start only with no grant", () => {
    assert.equal(silentStartAllowed(base({ choice: { door: AiDoor.Local, free: true } })), true);
    assert.equal(
      silentStartAllowed(base({ choice: { door: AiDoor.Local, free: true }, grant: active(AiDoor.Local) })),
      false,
    );
  });
});
