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
  previewAiBarKind,
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
    assert.equal(previewAiBarKind(undefined, false), PreviewAiBarKind.Hidden);
    assert.equal(previewAiBarKind(state({}), false), PreviewAiBarKind.Hidden);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Practice }), false), PreviewAiBarKind.Practice);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Practice }), true), PreviewAiBarKind.Confirm);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Live }), false), PreviewAiBarKind.Live);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.CapReached }), false), PreviewAiBarKind.CapReached);
    assert.equal(previewAiBarKind(state({ mode: PreviewAiMode.Unavailable }), false), PreviewAiBarKind.Unavailable);
  });

  it("asks for the microphone first, even in a game that calls no model", () => {
    assert.equal(previewAiBarKind(state({ mic: PreviewMicAsk.Asking }), false), PreviewAiBarKind.Mic);
    assert.equal(previewAiBarKind(state({ mic: PreviewMicAsk.Allowed }), false), PreviewAiBarKind.Hidden);
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
    assert.equal(PREVIEW_AI_WORDS.live(12, 100), "Real AI · 12 of 100 credits");
    assert.equal(PREVIEW_AI_WORDS.addMore(100), "Add 100 more");
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
    const before = store.getState();
    store.heard(state({ mode: PreviewAiMode.Live, capCredits: 300, chargedCredits: 4 }));
    assert.equal(store.getState(), before, "the same state twice changes nothing");
  });
});
