/**
 * The game's AI as the bar's layer holds it: the cards main asks for (its `UiEvent.GameAi` news, and
 * a card a pick needs first), the one the game on screen shows now (a first-use card lapses on its
 * own), and the note the pill wears until its time is up. The decisions are `ai-model.ts`'s.
 */
import { useEffect, useReducer, useState } from "react";
import type { AiGameKey } from "../../shared/game-ai.ts";
import type { PlayAiBar } from "../../shared/play-bar.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import {
  type AiCard,
  type AiCards,
  AiCardKind,
  cardFor,
  cardsAfter,
  NO_CARDS,
  noteFor,
  type ShownNote,
} from "./ai-model.ts";
import type { BarApi } from "./PlayBarPage.tsx";

/** The longest a timer waits in one go (a longer wait overflows and fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Draws again at `at` (null: never), so what depends on the clock moves on by itself. */
function useRedrawAt(at: number | null): void {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(redraw, Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [at]);
}

/** When a first-use card lapses; null for a card that does not. */
function lapsesAt(card: AiCard | null): number | null {
  if (card?.kind !== AiCardKind.Consent) return null;
  const at = Date.parse(card.consent.expiresAt);
  return Number.isFinite(at) ? at : null;
}

/** The cards main asked for, and the one `game` shows now. */
export function useAiCards(api: BarApi, game: AiGameKey | null) {
  const [cards, setCards] = useState<AiCards>(NO_CARDS);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type === UiEvent.GameAi) setCards((held) => cardsAfter(held, event.payload));
      }),
    [api],
  );
  const card = game ? cardFor(cards, game, Date.now()) : null;
  useRedrawAt(lapsesAt(card));
  return { cards, setCards, card };
}

/** The note the pill wears now: main's, for its own time from when it first came. */
export function useAiNote(ai: PlayAiBar | null): ShownNote | null {
  const [shown, setShown] = useState<ShownNote | null>(null);
  const note = noteFor(shown, ai, Date.now());
  // A note is derived from main's news as it comes; its time starts on the draw that first sees it.
  if (note !== shown) setShown(note);
  useRedrawAt(note?.until ?? null);
  return note && Date.now() < note.until ? note : null;
}
