/**
 * The game's AI in the bar's layer: the pill in the bar, and what it opens over the game, one at a
 * time like Comments (main lays the layer over the window first): the model menu, a first-use or stop
 * card, Get credits and Report. A card main asks for opens by itself over nothing else; set aside, it
 * waits on the pill. Change on a first-use card opens the menu, and the model picked there answers
 * the card. Every spend still waits for a card's yes (with main's native step) or checkout in the
 * browser.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import {
  type AiConsentAnswer,
  type AiConsentTicket,
  type AiStopCard,
  GameAiNoticeKind,
} from "../../shared/game-ai-views.ts";
import type { AiGameKey, AiModelRef } from "../../shared/game-ai.ts";
import { PlayControl } from "../../shared/play.ts";
import { type PlayAiBar, PlayBarOverlay } from "../../shared/play-bar.ts";
import { hostPlatform } from "../platform.ts";
import { PLAY_AI_WORDS } from "../words.ts";
import {
  AiCardKind,
  type AiCards,
  afterAnswer,
  cardKey,
  cardsAfter,
  ConsentAction,
  consentAnswer,
  overlayForCard,
  pickRequest,
  pillOpens,
  placeUnder,
  StopAction,
  withoutStop,
} from "./ai-model.ts";
import { PlayAiCard } from "./PlayAiCard.tsx";
import { PlayAiCredits } from "./PlayAiCredits.tsx";
import { type AiMenuActions, PlayAiMenu } from "./PlayAiMenu.tsx";
import { PlayAiPill } from "./PlayAiPill.tsx";
import { PlayAiReport } from "./PlayAiReport.tsx";
import type { BarApi } from "./PlayBarPage.tsx";
import type { SendControl } from "./PlayViewerBar.tsx";
import { useAiCards, useAiNote } from "./use-play-ai.ts";

/** How the layer opens and closes its overlays (`PlayBarPage.tsx`). */
export interface BarOverlays {
  overlay: PlayBarOverlay | null;
  /** Opens one, once main has laid the layer over the window. */
  open(overlay: PlayBarOverlay): Promise<void>;
  close(): void;
}

/** What the AI's overlays share: the game, its calls, and how the bar reports back. */
interface AiContext {
  api: BarApi;
  game: AiGameKey;
  overlays: BarOverlays;
  send: SendControl;
  cards: AiCards;
  setCards: (change: (cards: AiCards) => AiCards) => void;
  setProblem: (problem: string | null) => void;
}

/** Answers a first-use card, and says why it did nothing when it did. */
function answerCard(ctx: AiContext, answer: AiConsentAnswer, setBusy: (busy: boolean) => void): Promise<boolean> {
  setBusy(true);
  ctx.setProblem(null);
  return ctx.api
    .gameAiAnswer(answer)
    .then(
      (result) => {
        const { problem } = afterAnswer(ctx.cards, answer.ticket, result);
        ctx.setCards((held) => afterAnswer(held, answer.ticket, result).cards);
        ctx.setProblem(problem ? PLAY_AI_WORDS.unavailable : null);
        return result.ok;
      },
      () => {
        ctx.setProblem(PLAY_AI_WORDS.answerFailed);
        return false;
      },
    )
    .finally(() => setBusy(false));
}

/** Uses a model in the game now, or shows the first-use card it needs first. */
function pickModel(ctx: AiContext, model: AiModelRef): void {
  ctx.setProblem(null);
  ctx.api.gameAiPick(ctx.game, model).then(
    (result) => {
      if (result.ok) {
        ctx.setCards((held) => withoutStop(held, ctx.game));
        ctx.overlays.close();
        return;
      }
      ctx.setCards((held) => cardsAfter(held, { kind: GameAiNoticeKind.Consent, consent: result.consent }));
      void ctx.overlays.open(PlayBarOverlay.AiCard);
    },
    () => ctx.setProblem(PLAY_AI_WORDS.answerFailed),
  );
}

/** Turns the game's AI on or off. */
function enableAi(ctx: AiContext, on: boolean, then: () => void): void {
  ctx.setProblem(null);
  ctx.api.gameAiEnable(ctx.game, on).then(then, () => ctx.setProblem(PLAY_AI_WORDS.answerFailed));
}

/** What a stop card's button does: every one settles the card, then goes its way on. */
function stopActed(ctx: AiContext, card: AiStopCard, action: StopAction): void {
  const settle = (): void => ctx.setCards((held) => withoutStop(held, card.game));
  const openThen = (overlay: PlayBarOverlay) => (): void => void ctx.overlays.open(overlay).then(settle);
  const leave = (): void => {
    settle();
    void ctx.api.playClose().catch(() => undefined);
  };
  const ways: Record<StopAction, () => void> = {
    [StopAction.GetCredits]: openThen(PlayBarOverlay.AiCredits),
    [StopAction.Change]: openThen(PlayBarOverlay.AiMenu),
    [StopAction.UseAnother]: openThen(PlayBarOverlay.AiMenu),
    [StopAction.UseAlternative]: () => card.alternative && pickModel(ctx, card.alternative),
    [StopAction.TurnOn]: () => enableAi(ctx, true, settle),
    [StopAction.StopToday]: leave,
    [StopAction.BackToPlay]: leave,
    [StopAction.Ok]: settle,
    [StopAction.KeepPlaying]: settle,
    [StopAction.Keep]: settle,
  };
  ways[action]();
}

/** The pill's state and the overlays' actions for the game whose AI main drew as `ai`. */
function usePlayAi(api: BarApi, ai: PlayAiBar | null, overlays: BarOverlays, send: SendControl) {
  const game = ai?.game ?? null;
  const { cards, setCards, card } = useAiCards(api, game);
  const note = useAiNote(ai);
  const pill = useRef<HTMLButtonElement>(null);
  const [setAside, setSetAside] = useState<string | null>(null);
  const [changing, setChanging] = useState<AiConsentTicket | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another game starts with nothing set aside or in hand.
  useEffect(() => {
    setSetAside(null);
    setChanging(null);
    setProblem(null);
  }, [game]);
  const { overlay, open, close } = overlays;
  const key = card ? cardKey(card) : null;
  // A card that comes opens itself; one that goes takes its overlay with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card is known by its key.
  useEffect(() => {
    const next = overlayForCard(overlay, card, setAside);
    if (next === overlay) return;
    if (next) void open(next);
    else close();
  }, [overlay, key, setAside, open, close]);
  const ctx: AiContext | null = game ? { api, game, overlays, send, cards, setCards, setProblem } : null;
  return {
    game,
    card,
    note,
    pill,
    setAside,
    setSetAside,
    changing,
    setChanging,
    problem,
    setProblem,
    busy,
    setBusy,
    ctx,
  };
}

type PlayAi = ReturnType<typeof usePlayAi>;

/** What a first-use card's button does. */
function consentActed(ai: PlayAi, ctx: AiContext, consent: AiConsentTicket, action: ConsentAction): void {
  if (action === ConsentAction.Change) {
    ai.setChanging(consent);
    void ctx.overlays.open(PlayBarOverlay.AiMenu);
    return;
  }
  if (action === ConsentAction.SignIn) {
    ctx.send(PlayControl.Install);
    return;
  }
  const answer = consentAnswer(consent, action);
  if (answer) void answerCard(ctx, answer, ai.setBusy);
}

/** The menu's rows' actions. */
function menuActions(ai: PlayAi, ctx: AiContext): AiMenuActions {
  return {
    pick: (model) => {
      const request = pickRequest(ai.changing, model);
      if ("pick" in request) {
        pickModel(ctx, request.pick);
        return;
      }
      void answerCard(ctx, request.answer, ai.setBusy).then((ok) => {
        if (!ok) return;
        ai.setChanging(null);
        ctx.overlays.close();
      });
    },
    signIn: () => ctx.send(PlayControl.Install),
    enable: (on) => enableAi(ctx, on, ctx.overlays.close),
    report: () => void ctx.overlays.open(PlayBarOverlay.AiReport),
    credits: () => void ctx.overlays.open(PlayBarOverlay.AiCredits),
    addModels: () => ctx.send(PlayControl.AiModels),
  };
}

/** Where what hangs from the pill goes, measured now. */
function placeOf(pill: HTMLButtonElement | null): { top: number; right: number } {
  return placeUnder(pill?.getBoundingClientRect() ?? null, window.innerWidth);
}

/** What the pill opens, over the game. */
function AiOverlay({ ai, ctx, changed }: { ai: PlayAi; ctx: AiContext; changed: number }): JSX.Element | null {
  const platform = hostPlatform();
  const { overlay, close } = ctx.overlays;
  const done = (): void => {
    ai.setChanging(null);
    ai.setProblem(null);
    close();
  };
  if (overlay === PlayBarOverlay.AiMenu)
    return (
      <PlayAiMenu
        api={ctx.api}
        game={ctx.game}
        changed={changed}
        pill={ai.pill}
        platform={platform}
        problem={ai.problem}
        actions={menuActions(ai, ctx)}
        onClose={done}
      />
    );
  if (overlay === PlayBarOverlay.AiCredits)
    return <PlayAiCredits api={ctx.api} place={placeOf(ai.pill.current)} onClose={done} />;
  if (overlay === PlayBarOverlay.AiReport) return <PlayAiReport api={ctx.api} game={ctx.game} onClose={done} />;
  if (overlay !== PlayBarOverlay.AiCard || !ai.card) return null;
  const { card } = ai;
  const on = {
    consent: (action: ConsentAction) => card.kind === AiCardKind.Consent && consentActed(ai, ctx, card.consent, action),
    stop: (action: StopAction) => card.kind === AiCardKind.Stop && stopActed(ctx, card.card, action),
  };
  return (
    <PlayAiCard
      key={cardKey(card)}
      card={card}
      place={placeOf(ai.pill.current)}
      platform={platform}
      problem={ai.problem}
      busy={ai.busy}
      on={on}
      onSetAside={() => {
        ai.setSetAside(cardKey(card));
        done();
      }}
    />
  );
}

/** The game's AI in the layer: the pill for the bar, and what it opens. */
export function usePlayAiLayer(api: BarApi, ai: PlayAiBar | null, overlays: BarOverlays, send: SendControl) {
  const state = usePlayAi(api, ai, overlays, send);
  const { ctx, card } = state;
  const opened = overlays.overlay !== null && overlays.overlay !== PlayBarOverlay.Comments;
  const press = (): void => {
    if (!opened) {
      void overlays.open(pillOpens(card));
      return;
    }
    if (overlays.overlay === PlayBarOverlay.AiCard && card) state.setSetAside(cardKey(card));
    state.setChanging(null);
    overlays.close();
  };
  const pill = ai ? (
    <PlayAiPill ai={ai} note={state.note} platform={hostPlatform()} open={opened} pill={state.pill} onPress={press} />
  ) : null;
  const overlay = ctx ? <AiOverlay ai={state} ctx={ctx} changed={ctx.cards.changed} /> : null;
  return { pill, overlay };
}
