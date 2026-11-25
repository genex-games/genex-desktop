/**
 * Live's AI bar as words: which state it shows for a game, the confirmation's cap in credits and
 * dollars, the meter, and the reason and next step whenever real models are not available. The
 * store keeps each game's state from main's answers and the `preview.ai` event.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capDollars,
  offersRetry,
  PREVIEW_AI_WORDS,
  PreviewAiBarKind,
  PreviewAiConfirm,
  previewAiBarKind,
  retryConfirms,
  unavailableWords,
} from "../../src/renderer/panels/stage/preview-ai-bar.ts";
import { createPreviewAiStore } from "../../src/renderer/state/preview-ai.ts";
import {
  noPreviewAi,
  PreviewAiMode,
  type PreviewAiState,
  PreviewAiUnavailable,
  PreviewMicAsk,
} from "../../src/shared/preview-ai.ts";

const state = (change: Partial<PreviewAiState>): PreviewAiState => ({ ...noPreviewAi("inn"), ...change });

describe("Live's AI bar", () => {
  it("shows nothing for a game that calls no model, and each state for one that does", () => {
    assert.equal(previewAiBarKind(undefined, null), PreviewAiBarKind.Hidden);
    assert.equal(previewAiBarKind(state({}), null), PreviewAiBarKind.Hidden);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Practice }), null), PreviewAiBarKind.Practice);
    assert.equal(
      previewAiBarKind(state({ mode: PreviewAiMode.Practice }), PreviewAiConfirm.Real),
      PreviewAiBarKind.Confirm,
    );
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Live }), null), PreviewAiBarKind.Live);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.CapReached }), null), PreviewAiBarKind.CapReached);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Unavailable }), null), PreviewAiBarKind.Unavailable);
  });

  it("offers a plan of the person's own beside real AI, confirms it, and says which plan answers", () => {
    const claude = { engine: "claude-code", label: "Claude Code" };
    const offered = state({ mode: PreviewAiMode.Practice, plans: [claude] });
    assert.equal(previewAiBarKind(offered, PreviewAiConfirm.Plan), PreviewAiBarKind.PlanConfirm);
    assert.equal(
      previewAiBarKind(state({ mode: PreviewAiMode.Practice }), PreviewAiConfirm.Plan),
      PreviewAiBarKind.Practice,
      "no plan is ready any more: nothing is left to confirm",
    );
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Plan, plan: claude }), null), PreviewAiBarKind.Plan);
    assert.match(
      PREVIEW_AI_WORDS.planConfirm("Claude Code"),
      /Your own Claude Code plan answers.*No Genex credits are spent/,
    );
    assert.match(PREVIEW_AI_WORDS.planConfirm("Claude Code"), /voices stay practice/);
    assert.equal(PREVIEW_AI_WORDS.plan("Claude Code"), "Claude Code answers · your own plan, no credits");
    assert.equal(PREVIEW_AI_WORDS.startingPlan("Codex"), "Starting Codex…");
    assert.match(unavailableWords(PreviewAiUnavailable.PlanNotReady, null), /not signed in or ready/);
    assert.equal(offersRetry(PreviewAiUnavailable.PlanNotReady), true);
    assert.equal(
      retryConfirms(PreviewAiUnavailable.PlanNotReady),
      PreviewAiConfirm.Plan,
      "Try again asks about the plan again",
    );
    assert.equal(retryConfirms(PreviewAiUnavailable.SignedOut), PreviewAiConfirm.Real);
  });

  it("asks for the microphone first, even in a game that calls no model", () => {
    assert.equal(previewAiBarKind(state({ mic: PreviewMicAsk.Asking }), null), PreviewAiBarKind.Mic);
    assert.equal(previewAiBarKind(state({ mic: PreviewMicAsk.Allowed }), null), PreviewAiBarKind.Hidden);
  });

  it("names the cap in credits and dollars, and what was spent of it", () => {
    assert.equal(capDollars(100), "$1");
    assert.equal(capDollars(1000), "$10");
    assert.equal(capDollars(250), "$2.50");
    assert.match(PREVIEW_AI_WORDS.confirm(300), /at most 300 credits \(\$3\) for this play session\.$/);
    assert.match(
      PREVIEW_AI_WORDS.confirm(300, false),
      /at most 300 credits \(\$3\).* added to your Genex account as a private draft; none of its files are uploaded/,
      "a game that is not on Genex: the confirmation says what Start does about it",
    );
    // Never a bare pair of numbers: the one that is used says so, and credits on hold are named.
    assert.equal(PREVIEW_AI_WORDS.live(12, 100), "Real AI is on · used 12 of 100 credits");
    assert.equal(PREVIEW_AI_WORDS.live(12, 100, 3), "Real AI is on · used 12 of 100 credits · 3 on hold");
    assert.equal(PREVIEW_AI_WORDS.addMore(100), "Add 100 more");
  });

  it("speaks for Unreal's own Play on the Unreal card, and never calls it a preview there", () => {
    const editor = [
      PREVIEW_AI_WORDS.practice(true),
      PREVIEW_AI_WORDS.confirm(300, true, true),
      PREVIEW_AI_WORDS.confirm(300, false, true),
      PREVIEW_AI_WORDS.planConfirm("Codex", true),
    ];
    for (const words of editor) {
      assert.match(words, /Play in Unreal/, words);
      assert.doesNotMatch(words, /preview/i, words);
    }
    assert.match(PREVIEW_AI_WORDS.practice(true), /practice answers \(free, made up\)/);
    assert.match(PREVIEW_AI_WORDS.confirm(300, true, true), /at most 300 credits \(\$3\) for this play session\.$/);
    assert.match(PREVIEW_AI_WORDS.confirm(300, false, true), /private draft; none of its files are uploaded\.$/);
    assert.match(
      PREVIEW_AI_WORDS.planConfirm("Codex", true),
      /Your own Codex plan answers.*No Genex credits are spent/,
    );
    // A web game's preview keeps its words.
    assert.equal(PREVIEW_AI_WORDS.practice(), "Practice answers (free, made up)");
    assert.match(PREVIEW_AI_WORDS.confirm(300), /answer in this preview/);
    assert.match(PREVIEW_AI_WORDS.planConfirm("Codex"), /answers in this preview/);
  });

  it("says why real models are not available, and offers a retry only where one can help", () => {
    for (const reason of Object.values(PreviewAiUnavailable)) assert.ok(unavailableWords(reason, null).length > 0);
    assert.match(
      unavailableWords(PreviewAiUnavailable.NoDraft, "Genex did not answer"),
      /could not be added to your Genex account.*\(Genex did not answer\)$/,
    );
    assert.match(unavailableWords(PreviewAiUnavailable.Terms, null), /terms/);
    assert.equal(offersRetry(PreviewAiUnavailable.NoDraft), true);
    assert.equal(offersRetry(PreviewAiUnavailable.Terms), true);
    assert.match(unavailableWords(PreviewAiUnavailable.HelperFailed, "EACCES: no"), /\(EACCES: no\)$/);
    assert.equal(offersRetry(PreviewAiUnavailable.NotHere), false);
    assert.equal(offersRetry(PreviewAiUnavailable.SignedOut), true);
  });
});

describe("the preview AI store", () => {
  it("keeps each game's state from main's answers and its events", async () => {
    const calls: string[] = [];
    const answer = (mode: PreviewAiState["mode"]) => async (project: string) => ({ ...noPreviewAi(project), mode });
    const store = createPreviewAiStore({
      previewAi: answer(PreviewAiMode.Practice),
      previewAiReal: async (project, cap) => {
        calls.push(`real ${project} ${cap}`);
        return { ...noPreviewAi(project), mode: PreviewAiMode.Starting, capCredits: cap };
      },
      previewAiPlan: async (project, engine) => {
        calls.push(`plan ${project} ${engine}`);
        return { ...noPreviewAi(project), mode: PreviewAiMode.Starting, plan: { engine, label: "Claude Code" } };
      },
      previewAiPractice: answer(PreviewAiMode.Practice),
      previewMicAnswer: async (project, allow) => ({
        ...noPreviewAi(project),
        mic: allow ? PreviewMicAsk.Allowed : PreviewMicAsk.Refused,
      }),
    });
    await store.read("inn");
    assert.equal(store.getState().games.inn?.mode, PreviewAiMode.Practice);
    await store.startReal("inn", 300);
    assert.deepEqual(calls, ["real inn 300"]);
    assert.equal(store.getState().games.inn?.capCredits, 300);
    store.heard(state({ mode: PreviewAiMode.Live, capCredits: 300, chargedCredits: 4 }));
    assert.equal(store.getState().games.inn?.chargedCredits, 4);
    await store.startPlan("inn", "claude-code");
    assert.deepEqual(calls.at(-1), "plan inn claude-code");
    assert.equal(store.getState().games.inn?.plan?.label, "Claude Code");
    store.heard(state({ mode: PreviewAiMode.Live, capCredits: 300, chargedCredits: 4 }));
    const before = store.getState();
    store.heard(state({ mode: PreviewAiMode.Live, capCredits: 300, chargedCredits: 4 }));
    assert.equal(store.getState(), before, "the same state twice changes nothing");
  });
});
