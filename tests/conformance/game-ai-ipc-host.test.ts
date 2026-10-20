/**
 * The host the play-time AI registrar delegates to (`createGameAiIpcHost`, `main/game-ai/service.ts`),
 * driven through the real registrar and typed `handle()`: a pick that needs no card grants at once
 * and one that does opens the card; turning a game off and on; Settings' Games list with this
 * month's money; taking the plan away stopping its games; saved playtests through the library's
 * folder; and checkout opening only on genex.games.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGameAiIpcHost } from "../../src/main/game-ai/service.ts";
import type { GameAiModelCheck, GameAiReports } from "../../src/main/game-ai/types.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerGameAiIpc } from "../../src/main/ipc/game-ai.ts";
import {
  AiConsent,
  AiDoor,
  AiFunding,
  AiGrantStatus,
  AiOp,
  AiProvenance,
  AiRequirement,
} from "../../src/shared/game-ai.ts";
import { AiReportFailure, AiReportReason } from "../../src/shared/game-ai-report.ts";
import { AiConsentKind, AiCreditProductKind, AiPause, GameAiNoticeKind } from "../../src/shared/game-ai-views.ts";
import { PlayAiNote } from "../../src/shared/play-bar.ts";
import { TAPE_WIRE_VERSION, type TapeLine, tapeLineText } from "../../src/shared/game-ai-tape.ts";
import { BYOK_HAIKU, LOCAL_QWEN, menuOf, menuRow, PLAN_HAIKU } from "../helpers/game-ai-fakes.ts";
import { CROWNS, MOSS, rig, type RigOptions } from "../helpers/game-ai-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const studio = { sender: "studio", senderFrame: "main-frame" };
const GENEX = "https://genex.games";
/** Where genex.games' checkout for a pack or Pro hands the person (a Stripe Checkout session). */
const STRIPE = "https://checkout.stripe.com";

/** Report and check stand-ins: every call recorded, never reached here. */
function others() {
  const asked: string[] = [];
  const refuse = (name: string) => async () => {
    asked.push(name);
    throw new Error(`${name} belongs to another area`);
  };
  const reports: GameAiReports = { preview: refuse("preview"), send: refuse("send"), automatic: refuse("automatic") };
  const check: GameAiModelCheck = {
    start: refuse("start"),
    state: refuse("state"),
    stop: refuse("stop"),
    recommend: refuse("recommend"),
    publishFacts: refuse("publishFacts"),
  };
  return { asked, reports, check };
}

async function hosted(
  options: { checkoutUrl?: string; balance?: number | null; rig?: RigOptions; reports?: Partial<GameAiReports> } = {},
) {
  const r = await rig(options.rig);
  const library = await tmpDir("game-ai-ipc-host-");
  const opened: string[] = [];
  const { asked, reports: refused, check } = others();
  const reports = { ...refused, ...options.reports };
  const host = createGameAiIpcHost({
    service: r.service,
    grants: r.grants,
    settings: r.settings,
    tapes: r.tapes,
    ledger: r.ledger,
    platform: {
      packs: async () => [{ id: "pack_500", credits: 500, priceCents: 550 }],
      balanceCredits: async () => options.balance ?? null,
      checkoutUrl: async () => options.checkoutUrl ?? `${GENEX}/checkout/pack_500`,
    },
    reports,
    check,
    projectFolder: async (project) => {
      if (project !== "Moss Garden") throw new Error("not a game in the library");
      return path.join(library, project);
    },
    titleOf: async (game) => (game === CROWNS ? "Crowns of 1444" : "Moss Garden"),
    openExternal: async (url) => void opened.push(url),
    checkoutOrigins: [GENEX, STRIPE],
  });
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  registerGameAiIpc(handle, host);
  const invoke = async (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, channel);
    return listener(studio, payload);
  };
  return { ...r, host, invoke, opened, asked, library };
}

describe("the play-time AI IPC host", () => {
  it("grants a free pick at once, and opens the card for a key's first use", async () => {
    const h = await hosted();
    assert.deepEqual(await h.host.pick(CROWNS, LOCAL_QWEN), { ok: true, model: LOCAL_QWEN });
    assert.equal(h.grants.live(CROWNS)?.consent, AiConsent.Menu);
    const paid = await h.host.pick(CROWNS, BYOK_HAIKU);
    assert.equal(paid.ok, false);
    assert.equal(!paid.ok && paid.consent.kind, AiConsentKind.Key);
    assert.ok(h.notices.notices.some((notice) => notice.kind === GameAiNoticeKind.Consent));
    assert.deepEqual(h.grants.live(CROWNS)?.model, LOCAL_QWEN, "nothing changes before the person's yes");
    h.consents.close(CROWNS);
  });

  it("turns a game's AI off and on", async () => {
    const h = await hosted();
    await h.host.pick(CROWNS, LOCAL_QWEN);
    await h.host.enable(CROWNS, false);
    assert.equal(h.grants.live(CROWNS)?.status, AiGrantStatus.Off);
    await h.host.enable(CROWNS, true);
    assert.equal(h.grants.live(CROWNS)?.status, AiGrantStatus.Active);
  });

  it("lists every game holding a grant, with this month's money only on credits or a key", async () => {
    const h = await hosted();
    await h.grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    await h.grants.grant(MOSS, LOCAL_QWEN, AiConsent.Silent, AiRequirement.Optional);
    const entry = {
      at: new Date(h.clock.now()).toISOString(),
      grantId: null,
      site: "turn.resolve",
      model: "m",
      provenance: AiProvenance.Unverified,
      code: null,
      repaired: false,
      usage: null,
      latencyMs: 10,
    };
    await h.ledger.append({ ...entry, game: CROWNS, door: AiDoor.Byok, costMicros: 7_000 });
    await h.ledger.append({ ...entry, game: MOSS, door: AiDoor.Local, costMicros: 0 });
    const { games } = await h.host.activity();
    const crowns = games.find((row) => row.game === CROWNS);
    const moss = games.find((row) => row.game === MOSS);
    assert.equal(crowns?.title, "Crowns of 1444");
    assert.equal(crowns?.monthMicros, 7_000);
    assert.equal(moss?.monthMicros, 0);
    assert.equal(moss?.consent, AiConsent.Silent);
  });

  it("stops every game on the plan when the person takes the plan away", async () => {
    const h = await hosted();
    await h.host.saveSettings({ allowPlan: true });
    await h.grants.grant(MOSS, PLAN_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const view = await h.host.saveSettings({ allowPlan: false });
    assert.equal(view.allowPlan, false);
    assert.equal(h.grants.live(MOSS), null);
    assert.equal(h.grants.consented(MOSS, AiDoor.Plan), false);
  });

  it("lists a library game's saved playtests through its folder, and refuses any other name", async () => {
    const h = await hosted();
    const dir = path.join(h.library, "Moss Garden", "ai", "tapes");
    await mkdir(dir, { recursive: true });
    const line: TapeLine = {
      v: TAPE_WIRE_VERSION,
      key: "b".repeat(64),
      n: 0,
      site: "npc.say",
      op: AiOp.Say,
      value: "Hello",
      source: AiDoor.Local,
      model: null,
      latencyFrames: 1,
      usage: null,
    };
    await writeFile(path.join(dir, "opening.jsonl"), tapeLineText(line));
    const answer = await h.invoke("studio:game-ai.tapes", { project: "Moss Garden" });
    assert.ok(answer.ok);
    assert.deepEqual(
      (answer.ok ? (answer.value as Array<{ name: string }>) : []).map((tape) => tape.name),
      ["opening"],
    );
    for (const project of ["Elsewhere", "../Moss Garden", "/etc"]) {
      assert.equal((await h.invoke("studio:game-ai.tapes", { project })).ok, false, project);
    }
  });

  it("opens checkout only on genex.games or its Stripe checkout, over https", async () => {
    const h = await hosted();
    await h.host.checkout({ kind: AiCreditProductKind.Pack, packId: "pack_500" });
    assert.deepEqual(h.opened, [`${GENEX}/checkout/pack_500`]);
    const stripe = await hosted({ checkoutUrl: `${STRIPE}/c/pay/cs_test_a1` });
    await stripe.host.checkout({ kind: AiCreditProductKind.Pro });
    assert.deepEqual(stripe.opened, [`${STRIPE}/c/pay/cs_test_a1`]);
    for (const url of [
      "https://genex.games.evil.example/checkout",
      "http://genex.games/checkout",
      "https://checkout.stripe.com.evil.example/c/pay/cs_1",
      "http://checkout.stripe.com/c/pay/cs_1",
      "https://user@checkout.stripe.com/c/pay/cs_1",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const elsewhere = await hosted({ checkoutUrl: url });
      await assert.rejects(elsewhere.host.checkout({ kind: AiCreditProductKind.Pro }), url);
      assert.deepEqual(elsewhere.opened, [], url);
    }
    assert.deepEqual(await h.host.credits(), [{ id: "pack_500", credits: 500, priceCents: 550 }]);
  });

  it("puts Report sent on the game's pill once genex.games took the Report, and nothing when it did not", async () => {
    const sent = await hosted({ reports: { send: async () => ({ ok: true, id: "report_0001" }) } });
    await sent.invoke("studio:game-ai.report", { game: CROWNS, reason: AiReportReason.Harmful, note: null });
    assert.equal(sent.bars.at(-1)?.game, CROWNS);
    assert.equal(sent.bars.at(-1)?.note, PlayAiNote.ReportSent);
    const failed = await hosted({ reports: { send: async () => ({ ok: false, failure: AiReportFailure.Offline }) } });
    await failed.invoke("studio:game-ai.report", { game: CROWNS, reason: AiReportReason.Harmful, note: null });
    assert.ok(!failed.bars.some((bar) => bar.note === PlayAiNote.ReportSent));
  });

  it("puts Added N credits on the pill once the balance rises after checkout, once", async () => {
    let balance = 100;
    const genex = () => ({ signedIn: true, balanceCredits: balance, recommended: null, recommendedLabel: null });
    const h = await hosted({
      balance: 100,
      rig: { menu: (game) => menuOf(game, [menuRow(LOCAL_QWEN, AiFunding.Free)], { genex: genex() }) },
    });
    await h.host.checkout({ kind: AiCreditProductKind.Pack, packId: "pack_500" });
    await h.host.menu(CROWNS);
    assert.ok(!h.bars.some((bar) => bar.note === PlayAiNote.CreditsAdded), "nothing came yet");
    balance = 600;
    await h.host.menu(CROWNS);
    const added = h.bars.filter((bar) => bar.note === PlayAiNote.CreditsAdded);
    assert.equal(added.length, 1);
    assert.equal(added[0]?.addedCredits, 500);
    balance = 900;
    await h.host.menu(CROWNS);
    assert.equal(h.bars.filter((bar) => bar.note === PlayAiNote.CreditsAdded).length, 1, "once per checkout");
  });

  it("lets a game paused at its daily alert go on, and refuses any payload out of shape with no change", async () => {
    const h = await hosted({
      rig: {
        settings: { dailyAlertCredits: 1 },
        scripts: { [AiDoor.Byok]: [{ text: '{"ok":true}', model: "m", usage: null, costMicros: 12_000 }] },
      },
    });
    await h.grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const live = h.grants.live(CROWNS);
    assert.ok(live);
    await h.grants.setStatus(live.id, AiGrantStatus.Paused);
    for (const payload of [
      undefined,
      { game: CROWNS },
      { game: CROWNS, pause: "forever" },
      { game: "../etc", pause: AiPause.DailyAlert },
      { game: 7, pause: AiPause.DailyAlert },
      { game: CROWNS, pause: AiPause.DailyAlert.toUpperCase() },
    ]) {
      const result = await h.invoke("studio:game-ai.resume", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      assert.equal(h.grants.live(CROWNS)?.status, AiGrantStatus.Paused, JSON.stringify(payload));
    }
    const result = await h.invoke("studio:game-ai.resume", { game: CROWNS, pause: AiPause.DailyAlert });
    assert.equal(result.ok, true);
    assert.equal(h.grants.live(CROWNS)?.status, AiGrantStatus.Active);
  });

  it("hands Reports and the model check to their own parts", async () => {
    const h = await hosted();
    await assert.rejects(h.host.reportPreview(CROWNS));
    await assert.rejects(h.host.check("Moss Garden"));
    await assert.rejects(h.host.publishFacts("Moss Garden"));
    assert.deepEqual(h.asked, ["preview", "start", "publishFacts"]);
  });
});
