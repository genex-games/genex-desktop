/**
 * A native game's AI budget on its page (docs/play.md, "AI budget"): its block under the primary
 * one, and the sheet that turns AI on before Play. Every state has one shape, the website's
 * (genex.games' "A game's AI budget"): the state or the question as words ("AI is off in this
 * game", "AI is on", "Let {game} use AI?"), at most one sentence, the amount as the largest thing,
 * everything else behind one closed Details, one button that leads and one quiet one. A running
 * budget's numbers are never a bare pair: Used and Left stand under their own words over one bar,
 * and credits on hold for calls still running are named under it. A game that declared nothing, or
 * whose budget could not be read, shows nothing. Every number is genex.games' own, and nothing
 * reads as approved before genex.games says it is (`ai-budget-model.ts` decides,
 * `state/ai-budget.ts` reads and sends).
 */
import type { JSX } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PlayGameDetail } from "../../shared/play.ts";
import { type AiBudgetDeclared, AiBudgetStatus, type AiBudgetView } from "../../shared/play-ai-budget.ts";
import { useAiBudget, usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { AI_BUDGET_WORDS } from "../words.ts";
import {
  BudgetLine,
  type BudgetSheet,
  budgetLine,
  canApprove,
  offersBudget,
  refreshesBudget,
  SHEET_OPENING,
  SheetFailure,
  SheetNext,
  SheetStep,
  sheetAnswered,
  sheetApproving,
  sheetLimitChosen,
  sheetNext,
  sheetOpened,
  watchBudget,
} from "./ai-budget-model.ts";
import { GamePhase, type GameStanding } from "./native-model.ts";
import { useGenexSignIn } from "./use-genex-sign-in.ts";
import { useGetCredits } from "./use-get-credits.ts";

const WORDS = AI_BUDGET_WORDS;

/** Reads the game's budget when its page offers it, when the account changes and when play starts or ends. */
function useBudgetRead(slug: string, offered: boolean, playing: boolean): void {
  const account = usePeople((s) => s.me?.id ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the account and the game starting or ending are what ask for the read.
  useEffect(() => {
    if (offered) void studio().aiBudget.read(slug);
  }, [slug, offered, account, playing]);
}

/** Reads a running budget again every half minute, and when the window comes back, while `active`. */
function useBudgetWatch(slug: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return watchBudget({
      read: () => void studio().aiBudget.read(slug),
      every: (ms, tick) => {
        const timer = window.setInterval(tick, ms);
        return () => window.clearInterval(timer);
      },
      focused: (listener) => {
        window.addEventListener("focus", listener);
        return () => window.removeEventListener("focus", listener);
      },
    });
  }, [slug, active]);
}

/** What a failure offers next, as one button; nothing when Cancel (or Approve) is all there is. */
function NextStep({ sheet, onTryAgain }: { sheet: BudgetSheet; onTryAgain: () => void }): JSX.Element | null {
  const getCredits = useGetCredits();
  const { busy, signIn } = useGenexSignIn();
  const next = sheetNext(sheet);
  if (next === SheetNext.None) return null;
  const press = { [SheetNext.GetCredits]: getCredits, [SheetNext.TryAgain]: onTryAgain, [SheetNext.SignIn]: signIn };
  const label = {
    [SheetNext.GetCredits]: WORDS.getCredits,
    [SheetNext.TryAgain]: WORDS.tryAgain,
    [SheetNext.SignIn]: WORDS.signIn,
  };
  return (
    <Button
      variant="secondary"
      disabled={next === SheetNext.SignIn && busy}
      data-ai-budget-next={next}
      onClick={press[next]}
    >
      {label[next]}
    </Button>
  );
}

/** The sheet's sentence for a failure; over an open quote, its next step sits with it, under Approve's facts. */
function SheetProblem({ sheet, onTryAgain }: { sheet: BudgetSheet; onTryAgain: () => void }): JSX.Element | null {
  if (!sheet.failure) return null;
  return (
    <div role="alert" className="flex flex-col items-start gap-2" data-ai-budget-failure={sheet.failure}>
      <p className="text-dialog-body text-foreground">{WORDS.failure[sheet.failure]}</p>
      {sheet.quote && <NextStep sheet={sheet} onTryAgain={onTryAgain} />}
    </div>
  );
}

/** The limit, the sheet's centre: the amount as its largest thing, the slider that chooses it under it. */
function LimitControl({
  sheet,
  onChoose,
}: {
  sheet: BudgetSheet;
  onChoose: (value: number) => void;
}): JSX.Element | null {
  const id = useId();
  if (!sheet.quote) return null;
  const { minCredits, maxCredits, stepCredits } = sheet.quote.limit;
  const value = WORDS.limitValue(sheet.limitCredits);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-dialog-sub text-muted-foreground">
        {WORDS.limit}
      </label>
      <output htmlFor={id} className="ai-budget-amount" data-ai-budget-value>
        {value}
      </output>
      <input
        id={id}
        type="range"
        className="w-full cursor-pointer accent-(--accent-ink) disabled:cursor-not-allowed"
        min={minCredits}
        max={maxCredits}
        step={stepCredits}
        value={sheet.limitCredits}
        aria-valuetext={value}
        disabled={sheet.step !== SheetStep.Ask}
        data-ai-budget="limit"
        onChange={(event) => onChoose(Number(event.target.value))}
      />
    </div>
  );
}

/** Under the limit, the one fact that helps choose it: the game's own estimate, when it gave one. */
function QuoteEstimate({ sheet, declared }: { sheet: BudgetSheet; declared: AiBudgetDeclared }): JSX.Element | null {
  const estimate = sheet.quote?.estimate ?? declared.estimate;
  if (!sheet.quote || !estimate) return null;
  return (
    <p className="text-dialog-sub" data-ai-budget-estimate>
      {WORDS.estimate[estimate.period](estimate.credits)}
    </p>
  );
}

/** The unusual fact as a short tag; its whole sentence is under Details. */
function QuoteTags({ sheet }: { sheet: BudgetSheet }): JSX.Element | null {
  if (!sheet.quote?.replaces) return null;
  return (
    <p className="ai-budget-tag" data-ai-budget-replaces>
      {WORDS.replacesTag}
    </p>
  );
}

/** Everything the sheet used to open with, closed under one word: what it uses, one call's most, what it replaces, when it ends. */
function QuoteDetails({ sheet, declared }: { sheet: BudgetSheet; declared: AiBudgetDeclared }): JSX.Element | null {
  const { quote } = sheet;
  if (!quote) return null;
  const uses = WORDS.uses(declared.models, declared.judge);
  return (
    <details className="settings-disclosure ai-budget-details" data-ai-budget="details">
      <summary>{WORDS.details}</summary>
      <div className="flex flex-col gap-2 pt-2">
        {uses && <p>{uses}</p>}
        <p>{WORDS.perCall(quote.perCallMaxCredits)}</p>
        {quote.replaces && <p>{WORDS.replaces}</p>}
        <p>{WORDS.ends}</p>
      </div>
    </details>
  );
}

/** The sheet's steps for the game `slug`: the quote opened on mount, a limit chosen, Approve sent once. */
function useBudgetSheet(slug: string, onApproved: () => void) {
  const [sheet, setSheet] = useState<BudgetSheet>(SHEET_OPENING);
  // The latest quote asked for: an answer to an earlier ask, or after the sheet closed, lands nowhere.
  const asked = useRef(0);
  const open = useCallback(() => {
    const ask = ++asked.current;
    setSheet(SHEET_OPENING);
    void studio()
      .aiBudget.open(slug)
      .then((opened) => {
        if (ask === asked.current) setSheet(sheetOpened(opened));
      });
  }, [slug]);
  useEffect(() => {
    open();
    return () => {
      asked.current += 1;
    };
  }, [open]);
  const approve = (): void => {
    if (!canApprove(sheet)) return;
    const ask = asked.current;
    const sending = sheetApproving(sheet);
    setSheet(sending);
    void studio()
      .aiBudget.confirm(slug, sheet.limitCredits)
      .then((confirmed) => {
        if (ask !== asked.current) return;
        const next = sheetAnswered(sending, confirmed);
        if (next.step === SheetStep.Approved) onApproved();
        else setSheet(next);
      });
  };
  const choose = (value: number): void => setSheet((current) => sheetLimitChosen(current, value));
  return { sheet, open, approve, choose };
}

/** The sheet that turns a game's AI on: the question, who pays, the limit, Details, Allow and Not now. */
function AiBudgetSheet({
  game,
  declared,
  onClose,
}: {
  game: PlayGameDetail;
  declared: AiBudgetDeclared;
  onClose: () => void;
}): JSX.Element {
  const { sheet, open, approve, choose } = useBudgetSheet(game.slug, onClose);
  const account = usePeople((s) => s.me?.id ?? null);
  // The account as the sheet last saw it while it asked for a sign-in; undefined while it does not.
  const seen = useRef<string | null | undefined>(undefined);
  // Signed in from the sheet: a quote belongs to its sign-in, so a new one is opened.
  useEffect(() => {
    if (sheet.failure !== SheetFailure.SignedOut) {
      seen.current = undefined;
      return;
    }
    const before = seen.current;
    seen.current = account;
    if (before !== undefined && account && account !== before) open();
  }, [account, sheet.failure, open]);
  const approving = sheet.step === SheetStep.Approving;
  return (
    <DialogSurface
      title={WORDS.title(game.title)}
      description={WORDS.what}
      size="md"
      testId="ai-budget-sheet"
      dismissible={!approving}
      onDismiss={onClose}
    >
      <div
        className="flex flex-col gap-3 text-dialog-body text-muted-foreground"
        data-ai-budget="sheet"
        data-ai-budget-step={sheet.step}
      >
        {sheet.step === SheetStep.Loading && <p role="status">{WORDS.loading}</p>}
        <LimitControl sheet={sheet} onChoose={choose} />
        <QuoteEstimate sheet={sheet} declared={declared} />
        <QuoteTags sheet={sheet} />
        <SheetProblem sheet={sheet} onTryAgain={open} />
        <QuoteDetails sheet={sheet} declared={declared} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={approving} data-ai-budget="cancel" onClick={onClose}>
          {WORDS.notNow}
        </Button>
        {sheet.quote ? (
          <Button variant="play-fill" busy={approving} data-ai-budget="approve" onClick={approve}>
            {approving ? WORDS.allowing : WORDS.allow(sheet.limitCredits)}
          </Button>
        ) : (
          // With no quote to approve, the way on is the sheet's second button.
          <NextStep sheet={sheet} onTryAgain={open} />
        )}
      </div>
    </DialogSurface>
  );
}

/** A running budget's numbers: Used and Left under their own words over one bar, the limit and what is on hold under it. */
function BudgetMeter({ current }: { current: AiBudgetView }): JSX.Element {
  const { limitCredits, spentCredits, heldCredits, remainingCredits } = current;
  // The bar's empty part is what is left, so the picture and the Left number cannot disagree.
  const taken = limitCredits > 0 ? Math.min(1, Math.max(0, (limitCredits - remainingCredits) / limitCredits)) : 0;
  return (
    <div className="game-budget-meter" data-ai-budget="meter">
      <dl className="game-budget-numbers">
        <div>
          <dt>{WORDS.used}</dt>
          <dd data-ai-budget-used>{WORDS.amount(spentCredits)}</dd>
        </div>
        <div>
          <dt>{WORDS.left}</dt>
          <dd data-ai-budget-left>{WORDS.amount(remainingCredits)}</dd>
        </div>
      </dl>
      <div className="game-budget-bar" aria-hidden>
        <span style={{ inlineSize: `${taken * 100}%` }} />
      </div>
      <p className="game-budget-limit" data-ai-budget-limit>
        {WORDS.limitLine(limitCredits, heldCredits)}
      </p>
    </div>
  );
}

/** A running budget: its state as words, Turn AI off (asked once, in place) and Change limit, then its numbers. */
function LiveLine({
  slug,
  current,
  onChange,
}: {
  slug: string;
  current: AiBudgetView;
  /** Opens the sheet again; absent while a new budget cannot be set. */
  onChange?: () => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const getCredits = useGetCredits();
  const stop = (): void => {
    setAsking(false);
    setStopping(true);
    void studio()
      .aiBudget.stop(slug)
      .then((stopped) => {
        if (!stopped || "refused" in stopped) studio().notify(WORDS.stopFailed, ToastTone.Error);
      })
      .finally(() => setStopping(false));
  };
  if (stopping || current.stopping) return <span role="status">{WORDS.stopping}</span>;
  if (asking)
    return (
      <div className="game-budget-head">
        <span className="game-budget-state">{WORDS.stopAsk}</span>
        <button type="button" className="game-budget-link" data-ai-budget="stop-confirm" onClick={stop}>
          {WORDS.turnOff}
        </button>
        <button type="button" className="game-budget-link" data-ai-budget="stop-keep" onClick={() => setAsking(false)}>
          {WORDS.stopKeep}
        </button>
      </div>
    );
  // Out of credits: one way forward, and no meter, whose limit beside an empty balance would read as credits to spend.
  const paused = current.status === AiBudgetStatus.SuspendedInsufficientFunds;
  return (
    <>
      <div className="game-budget-head">
        <span className="game-budget-state" data-ai-budget-state={paused ? "paused" : "on"}>
          {paused ? WORDS.paused : WORDS.on}
        </span>
        {paused && (
          <button type="button" className="game-budget-link" data-ai-budget="get-credits" onClick={getCredits}>
            {WORDS.getCredits}
          </button>
        )}
        <button type="button" className="game-budget-link" data-ai-budget="stop" onClick={() => setAsking(true)}>
          {WORDS.turnOff}
        </button>
        {onChange && (
          <button type="button" className="game-budget-link" data-ai-budget="change" onClick={onChange}>
            {WORDS.change}
          </button>
        )}
      </div>
      {!paused && <BudgetMeter current={current} />}
    </>
  );
}

/** The AI budget of the game on this page: its block under the primary one, and its sheet. */
export function AiBudget({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element | null {
  const read = useAiBudget((s) => s.games[game.slug]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { busy, signIn } = useGenexSignIn();
  const native = game.native !== undefined;
  const { phase } = standing;
  useBudgetRead(game.slug, offersBudget(native, phase), phase === GamePhase.Playing);
  useBudgetWatch(game.slug, refreshesBudget(read, phase));
  const view = budgetLine(read, native, phase);
  if (view.line === BudgetLine.None) return null;
  const declared = read?.declared ?? null;
  return (
    <>
      <div className="game-primary-note game-budget" data-ai-budget="line" data-ai-budget-line={view.line}>
        {view.line === BudgetLine.Offer && (
          <div className="game-budget-head">
            <span className="game-budget-state">{WORDS.off}</span>
            <Button
              variant="secondary"
              className="game-budget-set"
              disabled={view.signIn && busy}
              data-ai-budget="set"
              onClick={view.signIn ? signIn : () => setSheetOpen(true)}
            >
              {WORDS.turnOn}
            </Button>
          </div>
        )}
        {view.line === BudgetLine.Unavailable && <span>{WORDS.unavailable}</span>}
        {view.line === BudgetLine.Voice && <span>{WORDS.voice}</span>}
        {view.current && (
          <LiveLine
            slug={game.slug}
            current={view.current}
            {...(view.canChange ? { onChange: () => setSheetOpen(true) } : {})}
          />
        )}
      </div>
      {sheetOpen && declared && <AiBudgetSheet game={game} declared={declared} onClose={() => setSheetOpen(false)} />}
    </>
  );
}
