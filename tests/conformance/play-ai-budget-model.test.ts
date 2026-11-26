/**
 * A native game's AI budget on its page, as pure decisions and the store behind them: what the
 * line says for each answer and phase, the sheet's steps from the quote to an approval or a
 * failure with its next step, when the count is read again, and that the page shows only what
 * genex.games answered (a failed read changes nothing; nothing reads as approved before it is).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUDGET_REFRESH_MS,
  BudgetLine,
  budgetAfterChange,
  budgetAfterRead,
  budgetLine,
  canApprove,
  liveBudget,
  refreshesBudget,
  SHEET_OPENING,
  SheetFailure,
  SheetNext,
  SheetStep,
  sheetAnswered,
  sheetApproving,
  sheetFailureOf,
  sheetLimitChosen,
  sheetNext,
  sheetOpened,
  watchBudget,
} from "../../src/renderer/play/ai-budget-model.ts";
import { GamePhase } from "../../src/renderer/play/native-model.ts";
import { createAiBudgetStore } from "../../src/renderer/state/ai-budget.ts";
import { AI_BUDGET_WORDS } from "../../src/renderer/words.ts";
import {
  type AiBudgetDeclared,
  AiBudgetPeriod,
  type AiBudgetQuote,
  type AiBudgetRead,
  AiBudgetRefusal,
  AiBudgetStatus,
  type AiBudgetView,
  limitOffered,
} from "../../src/shared/play-ai-budget.ts";

const DECLARED: AiBudgetDeclared = {
  models: ["GPT-5 mini"],
  judge: false,
  voice: false,
  estimate: { period: AiBudgetPeriod.Session, credits: 80 },
  available: true,
};
const LIVE: AiBudgetView = {
  status: AiBudgetStatus.Active,
  limitCredits: 100,
  spentCredits: 15,
  heldCredits: 0,
  remainingCredits: 85,
  expiresAt: "2026-11-25T12:00:00.000Z",
  stopping: false,
};
const QUOTE: AiBudgetQuote = {
  perCallMaxCredits: 4,
  estimate: null,
  limit: { minCredits: 10, maxCredits: 500, stepCredits: 10, defaultCredits: 100 },
  replaces: false,
  expiresAt: "2026-11-24T12:05:00.000Z",
};
const read = (overrides: Partial<AiBudgetRead> = {}): AiBudgetRead => ({
  signedOut: false,
  declared: DECLARED,
  current: null,
  ...overrides,
});
const OFFERING = [GamePhase.Install, GamePhase.Ready, GamePhase.Update, GamePhase.Playing];
const LIVE_STATUSES: AiBudgetStatus[] = [
  AiBudgetStatus.Active,
  AiBudgetStatus.SuspendedInsufficientFunds,
  AiBudgetStatus.WaitingForPlan,
];
const ENDED_STATUSES = Object.values(AiBudgetStatus).filter((status) => !LIVE_STATUSES.includes(status));

describe("The AI budget's line on a game's page", () => {
  it("is nothing for a game that declared nothing, before a read, and on a web game's page", () => {
    for (const phase of OFFERING) {
      assert.equal(budgetLine(undefined, true, phase).line, BudgetLine.None);
      assert.equal(budgetLine(null, true, phase).line, BudgetLine.None);
      assert.equal(budgetLine(read({ declared: null }), true, phase).line, BudgetLine.None);
      assert.equal(budgetLine(read(), false, phase).line, BudgetLine.None, "no native build");
    }
  });

  it("is nothing while the page offers no Play: installing, failed, or not for this computer", () => {
    for (const phase of [GamePhase.Installing, GamePhase.Failed, GamePhase.Elsewhere]) {
      assert.equal(budgetLine(read(), true, phase).line, BudgetLine.None, phase);
      assert.equal(budgetLine(read({ current: LIVE }), true, phase).line, BudgetLine.None, phase);
    }
  });

  it("offers Set AI budget for a declared budget nobody approved, signing in first when signed out", () => {
    for (const phase of OFFERING) {
      const view = budgetLine(read(), true, phase);
      assert.deepEqual([view.line, view.signIn, view.current], [BudgetLine.Offer, false, null], phase);
    }
    assert.equal(budgetLine(read({ signedOut: true }), true, GamePhase.Ready).signIn, true);
  });

  it("offers nothing to press for a model that is not served, or for voice", () => {
    const off = read({ declared: { ...DECLARED, available: false } });
    assert.equal(budgetLine(off, true, GamePhase.Ready).line, BudgetLine.Unavailable);
    const voice = read({ declared: { ...DECLARED, voice: true } });
    assert.equal(budgetLine(voice, true, GamePhase.Ready).line, BudgetLine.Voice);
    const both = read({ declared: { ...DECLARED, voice: true, available: false } });
    assert.equal(budgetLine(both, true, GamePhase.Ready).line, BudgetLine.Voice);
  });

  it("shows a running budget, with Change only while the game is not played", () => {
    for (const status of LIVE_STATUSES) {
      const running = read({ current: { ...LIVE, status } });
      for (const phase of [GamePhase.Install, GamePhase.Ready, GamePhase.Update]) {
        const view = budgetLine(running, true, phase);
        assert.deepEqual([view.line, view.canChange, view.current?.remainingCredits], [BudgetLine.Live, true, 85]);
      }
      const playing = budgetLine(running, true, GamePhase.Playing);
      assert.deepEqual([playing.line, playing.canChange], [BudgetLine.Live, false], status);
    }
  });

  it("keeps Stop but not Change where a new budget could not be set", () => {
    const cases: AiBudgetRead[] = [
      read({ current: LIVE, declared: null }),
      read({ current: LIVE, declared: { ...DECLARED, available: false } }),
      read({ current: LIVE, declared: { ...DECLARED, voice: true } }),
      read({ current: { ...LIVE, stopping: true } }),
    ];
    for (const one of cases) {
      const view = budgetLine(one, true, GamePhase.Ready);
      assert.deepEqual([view.line, view.canChange], [BudgetLine.Live, false]);
    }
  });

  it("reads a budget that ended as none", () => {
    for (const status of ENDED_STATUSES) {
      const ended = read({ current: { ...LIVE, status } });
      assert.equal(liveBudget(ended), null, status);
      assert.equal(budgetLine(ended, true, GamePhase.Ready).line, BudgetLine.Offer, status);
    }
  });
});

describe("What the page keeps of a budget", () => {
  it("keeps what the game declared when the app signs out, and drops the budget", () => {
    const kept = budgetAfterRead(read({ current: LIVE }), { signedOut: true, declared: null, current: null });
    assert.deepEqual(kept, { signedOut: true, declared: DECLARED, current: null });
    const unknown = budgetAfterRead(undefined, { signedOut: true, declared: null, current: null });
    assert.equal(budgetLine(unknown, true, GamePhase.Ready).line, BudgetLine.None, "nothing is known signed out");
  });

  it("takes genex.games' answer whole once signed in", () => {
    const signedOut = { signedOut: true, declared: DECLARED, current: null };
    assert.deepEqual(budgetAfterRead(signedOut, read({ declared: null })), read({ declared: null }));
  });

  it("shows an approved budget, and none once it is stopped", () => {
    assert.deepEqual(budgetAfterChange(read(), LIVE), read({ current: LIVE }));
    const stopped = budgetAfterChange(read({ current: LIVE }), { ...LIVE, status: AiBudgetStatus.Stopped });
    assert.deepEqual(stopped, read());
    assert.deepEqual(budgetAfterChange(read({ current: LIVE }), null), read());
    const finishing = budgetAfterChange(read({ current: LIVE }), { ...LIVE, stopping: true });
    assert.equal(finishing.current?.stopping, true, "a stop that waits for a started call still shows");
  });
});

describe("Reading a running budget again", () => {
  it("only while a budget runs and its game is being played", () => {
    assert.equal(refreshesBudget(read({ current: LIVE }), GamePhase.Playing), true);
    assert.equal(refreshesBudget(read({ current: LIVE }), GamePhase.Ready), false);
    assert.equal(refreshesBudget(read(), GamePhase.Playing), false);
    assert.equal(refreshesBudget(undefined, GamePhase.Playing), false);
    const ended = read({ current: { ...LIVE, status: AiBudgetStatus.Exhausted } });
    assert.equal(refreshesBudget(ended, GamePhase.Playing), false);
  });

  it("reads every half minute and when the window comes back, until it is stopped", () => {
    let reads = 0;
    const timers: Array<{ ms: number; tick: () => void }> = [];
    const focus: Array<() => void> = [];
    const stop = watchBudget({
      read: () => {
        reads += 1;
      },
      every: (ms, tick) => {
        const timer = { ms, tick };
        timers.push(timer);
        return () => void timers.splice(timers.indexOf(timer), 1);
      },
      focused: (listener) => {
        focus.push(listener);
        return () => void focus.splice(focus.indexOf(listener), 1);
      },
    });
    assert.equal(reads, 0, "the page's own read came first");
    assert.deepEqual(
      timers.map((timer) => timer.ms),
      [BUDGET_REFRESH_MS],
    );
    assert.equal(BUDGET_REFRESH_MS, 30_000);
    timers[0]?.tick();
    timers[0]?.tick();
    focus[0]?.();
    assert.equal(reads, 3);
    stop();
    assert.deepEqual([timers.length, focus.length], [0, 0], "nothing is left running");
  });
});

describe("The sheet that sets an AI budget", () => {
  const asking = () => sheetOpened({ quote: QUOTE });

  it("opens loading, then asks with the quote's default limit", () => {
    assert.deepEqual(SHEET_OPENING, { step: SheetStep.Loading, quote: null, limitCredits: 0, failure: null });
    assert.equal(canApprove(SHEET_OPENING), false);
    const sheet = asking();
    assert.deepEqual([sheet.step, sheet.limitCredits, sheet.failure], [SheetStep.Ask, 100, null]);
    assert.equal(canApprove(sheet), true);
    assert.equal(sheetNext(sheet), SheetNext.None);
  });

  it("starts on an offered limit even when the default sits between steps", () => {
    const odd = { ...QUOTE, limit: { ...QUOTE.limit, defaultCredits: 104 } };
    assert.equal(sheetOpened({ quote: odd }).limitCredits, 100);
  });

  it("only ever holds a limit the quote offers", () => {
    let sheet = asking();
    for (const value of [-1, 0, 9, 14, 15, 250, 499, 500, 501, 1e9, Number.NaN, Number.POSITIVE_INFINITY, 33.3]) {
      sheet = sheetLimitChosen(sheet, value);
      assert.equal(limitOffered(QUOTE.limit, sheet.limitCredits), true, `${value} → ${sheet.limitCredits}`);
    }
    assert.equal(sheetLimitChosen(asking(), 250).limitCredits, 250);
    const sending = sheetApproving(asking());
    assert.equal(sheetLimitChosen(sending, 250).limitCredits, 100, "the limit is settled once Approve is pressed");
  });

  it("is approved only when genex.games says a budget is running", () => {
    const sending = sheetApproving(asking());
    assert.equal(sending.step, SheetStep.Approving);
    assert.equal(canApprove(sending), false, "Approve is sent once");
    assert.equal(sheetAnswered(sending, { current: LIVE }).step, SheetStep.Approved);
    for (const status of ENDED_STATUSES) {
      const answered = sheetAnswered(sending, { current: { ...LIVE, status } });
      assert.deepEqual([answered.step, answered.failure], [SheetStep.Ask, SheetFailure.Other], status);
    }
    assert.equal(sheetAnswered(asking(), { current: LIVE }).step, SheetStep.Ask, "an answer nobody waits for");
  });

  it("gives every refusal one sentence", () => {
    const table: Array<[AiBudgetRefusal, SheetFailure]> = [
      [AiBudgetRefusal.InsufficientCredits, SheetFailure.Credits],
      [AiBudgetRefusal.CreditsUnverified, SheetFailure.Email],
      [AiBudgetRefusal.QuoteExpired, SheetFailure.Expired],
      [AiBudgetRefusal.QuoteMismatch, SheetFailure.Expired],
      [AiBudgetRefusal.BillingPolicyMismatch, SheetFailure.Expired],
      [AiBudgetRefusal.GrantNotFound, SheetFailure.Expired],
      [AiBudgetRefusal.GenerationPaused, SheetFailure.Paused],
      [AiBudgetRefusal.ProviderUnavailable, SheetFailure.Paused],
      [AiBudgetRefusal.ModelNotAvailable, SheetFailure.Unavailable],
      [AiBudgetRefusal.NotDeclared, SheetFailure.Unavailable],
      [AiBudgetRefusal.GameUnavailable, SheetFailure.Unavailable],
      [AiBudgetRefusal.ProjectNotFound, SheetFailure.Unavailable],
      [AiBudgetRefusal.Voice, SheetFailure.Unavailable],
      [AiBudgetRefusal.SignedOut, SheetFailure.SignedOut],
      [AiBudgetRefusal.SessionRevoked, SheetFailure.SignedOut],
      [AiBudgetRefusal.InvalidLimit, SheetFailure.Other],
      [AiBudgetRefusal.LimitBelowCallCeiling, SheetFailure.Other],
      [AiBudgetRefusal.CredentialScope, SheetFailure.Other],
      [AiBudgetRefusal.Unknown, SheetFailure.Other],
    ];
    assert.deepEqual(table.map(([refused]) => refused).sort(), Object.values(AiBudgetRefusal).sort());
    for (const [refused, failure] of table) assert.equal(sheetFailureOf(refused), failure, refused);
  });

  it("keeps the quote over a refusal it outlives, with that refusal's next step", () => {
    const sending = sheetApproving(asking());
    const table: Array<[AiBudgetRefusal, SheetFailure, SheetNext]> = [
      [AiBudgetRefusal.InsufficientCredits, SheetFailure.Credits, SheetNext.GetCredits],
      [AiBudgetRefusal.CreditsUnverified, SheetFailure.Email, SheetNext.None],
      [AiBudgetRefusal.GenerationPaused, SheetFailure.Paused, SheetNext.None],
      [AiBudgetRefusal.SessionRevoked, SheetFailure.SignedOut, SheetNext.SignIn],
      [AiBudgetRefusal.InvalidLimit, SheetFailure.Other, SheetNext.None],
    ];
    for (const [refused, failure, next] of table) {
      const sheet = sheetAnswered(sending, { refused });
      assert.deepEqual([sheet.step, sheet.failure, sheet.limitCredits], [SheetStep.Ask, failure, 100], refused);
      assert.equal(canApprove(sheet), true, "Approve is the way to try again");
      assert.equal(sheetNext(sheet), next, refused);
    }
    const unanswered = sheetAnswered(sending, null);
    assert.deepEqual([unanswered.step, unanswered.failure], [SheetStep.Ask, SheetFailure.Other]);
    assert.equal(sheetApproving(unanswered).failure, null, "the sentence goes when Approve is pressed again");
  });

  it("drops a quote that ended, and offers a fresh one", () => {
    const sending = sheetApproving(asking());
    const expired = sheetAnswered(sending, { refused: AiBudgetRefusal.QuoteExpired });
    assert.deepEqual([expired.step, expired.quote, expired.failure], [SheetStep.Failed, null, SheetFailure.Expired]);
    assert.equal(canApprove(expired), false);
    assert.equal(sheetNext(expired), SheetNext.TryAgain);
    const gone = sheetAnswered(sending, { refused: AiBudgetRefusal.GameUnavailable });
    assert.deepEqual([gone.step, sheetNext(gone)], [SheetStep.Failed, SheetNext.None]);
  });

  it("says why no quote could be opened, with the next step", () => {
    const table: Array<[AiBudgetRefusal | null, SheetFailure, SheetNext]> = [
      [AiBudgetRefusal.GenerationPaused, SheetFailure.Paused, SheetNext.None],
      [AiBudgetRefusal.ModelNotAvailable, SheetFailure.Unavailable, SheetNext.None],
      [AiBudgetRefusal.SignedOut, SheetFailure.SignedOut, SheetNext.SignIn],
      [AiBudgetRefusal.Unknown, SheetFailure.Other, SheetNext.TryAgain],
      [null, SheetFailure.Other, SheetNext.TryAgain],
    ];
    for (const [refused, failure, next] of table) {
      const sheet = sheetOpened(refused ? { refused } : null);
      assert.deepEqual([sheet.step, sheet.quote, sheet.failure], [SheetStep.Failed, null, failure]);
      assert.equal(sheetNext(sheet), next);
      assert.equal(sheetApproving(sheet), sheet, "nothing to approve");
    }
  });
});

describe("The AI budget store", () => {
  type Api = Parameters<typeof createAiBudgetStore>[0];
  const unused = async (): Promise<never> => {
    throw new Error("not called");
  };
  const api = (overrides: Partial<Api>): Api => ({
    playAiBudget: unused,
    playAiBudgetOpen: unused,
    playAiBudgetConfirm: unused,
    playAiBudgetStop: unused,
    ...overrides,
  });

  it("keeps a game's read by its address, and what it had when a read fails", async () => {
    let answer: AiBudgetRead | null = read();
    const store = createAiBudgetStore(
      api({
        playAiBudget: async () => {
          if (!answer) throw new Error("offline");
          return answer;
        },
      }),
    );
    await store.read("iron-tide");
    assert.deepEqual(store.getState().games, { "iron-tide": read() });
    answer = null;
    await store.read("iron-tide");
    await store.read("frigate");
    assert.deepEqual(store.getState().games, { "iron-tide": read() }, "a failed read is not an error box");
  });

  it("makes reads of one game under way one read", async () => {
    let asked = 0;
    const store = createAiBudgetStore(
      api({
        playAiBudget: async () => {
          asked += 1;
          return read();
        },
      }),
    );
    await Promise.all([store.read("iron-tide"), store.read("iron-tide"), store.read("frigate")]);
    assert.equal(asked, 2);
    await store.read("iron-tide");
    assert.equal(asked, 3);
  });

  it("shows an approval only once genex.games answered it, and reads again after a refusal", async () => {
    let reads = 0;
    let confirmed: { current: AiBudgetView } | { refused: AiBudgetRefusal } | null = { current: LIVE };
    const store = createAiBudgetStore(
      api({
        playAiBudget: async () => {
          reads += 1;
          return read();
        },
        playAiBudgetConfirm: async () => {
          if (!confirmed) throw new Error("offline");
          return confirmed;
        },
      }),
    );
    await store.read("iron-tide");
    const pending = store.confirm("iron-tide", 100);
    assert.equal(store.getState().games["iron-tide"]?.current, null, "nothing is assumed while it is sent");
    assert.deepEqual(await pending, { current: LIVE });
    assert.deepEqual(store.getState().games["iron-tide"]?.current, LIVE);
    assert.equal(reads, 1);
    confirmed = { refused: AiBudgetRefusal.InsufficientCredits };
    assert.deepEqual(await store.confirm("iron-tide", 100), confirmed);
    assert.equal(reads, 2, "what genex.games holds is read, not guessed");
    confirmed = null;
    assert.equal(await store.confirm("iron-tide", 100), null);
    assert.equal(reads, 3);
  });

  it("drops a stopped budget, and answers a call that failed with null", async () => {
    const store = createAiBudgetStore(
      api({
        playAiBudget: async () => read({ current: LIVE }),
        playAiBudgetStop: async () => ({ current: { ...LIVE, status: AiBudgetStatus.Stopped } }),
        playAiBudgetOpen: async () => {
          throw new Error("offline");
        },
      }),
    );
    await store.read("iron-tide");
    await store.stop("iron-tide");
    assert.equal(store.getState().games["iron-tide"]?.current, null);
    assert.equal(await store.open("iron-tide"), null);
  });
});

/**
 * A person read "198 of 200 credits left" as what one call had cost (2026-11-25): a budget holds
 * each running call's ceiling, so 200 with one call in flight is used 0, on hold 2, left 198. The
 * page never prints a bare pair of numbers; these are the words each number stands under.
 */
describe("The AI budget's words", () => {
  it("names the limit, and what is on hold only while something is", () => {
    assert.equal(AI_BUDGET_WORDS.limitLine(200, 0), "Limit 200 credits");
    assert.equal(AI_BUDGET_WORDS.limitLine(1, 0), "Limit 1 credit");
    assert.equal(AI_BUDGET_WORDS.limitLine(200, 2), "Limit 200 credits · 2 on hold for requests still running");
    assert.equal(AI_BUDGET_WORDS.used, "Used");
    assert.equal(AI_BUDGET_WORDS.left, "Left");
  });
  it("asks one question, and its button repeats what it allows", () => {
    assert.equal(AI_BUDGET_WORDS.title("Iron Tide"), "Let Iron Tide use AI?");
    assert.equal(AI_BUDGET_WORDS.allow(240), "Allow 240 credits");
    assert.equal(AI_BUDGET_WORDS.allow(1), "Allow 1 credit");
    assert.equal(AI_BUDGET_WORDS.notNow, "Not now");
  });
  it("says the state as words, on and off with the same verb", () => {
    assert.equal(AI_BUDGET_WORDS.off, "AI is off in this game");
    assert.equal(AI_BUDGET_WORDS.on, "AI is on");
    assert.equal(AI_BUDGET_WORDS.turnOn, "Turn AI on");
    assert.equal(AI_BUDGET_WORDS.turnOff, "Turn AI off");
    assert.match(AI_BUDGET_WORDS.paused, /paused.*not enough Genex credits/);
  });
});
