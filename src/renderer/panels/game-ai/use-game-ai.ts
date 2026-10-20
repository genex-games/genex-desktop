/**
 * What the creator surfaces of play-time AI read from main, kept fresh by `UiEvent.GameAi`: a
 * game's model menu (re-read when main says its AI changed), and the card or stop main pushes for
 * it. A read that fails keeps what was shown and says why.
 */
import { useCallback, useEffect, useState } from "react";
import type { AiGameKey } from "../../../shared/game-ai.ts";
import {
  type AiConsentTicket,
  type AiModelMenu,
  type AiStopCard,
  type GameAiNotice,
  GameAiNoticeKind,
} from "../../../shared/game-ai-views.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { problemWords } from "../../words.ts";

/** Call `listener` with every play-time AI notice main pushes, while mounted. */
export function useGameAiNotices(listener: (notice: GameAiNotice) => void): void {
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type === UiEvent.GameAi) listener(event.payload);
      }),
    [listener],
  );
}

/** A game's model menu: null until read, read again whenever main says the game's AI changed. */
export function useAiMenu(game: AiGameKey | null): {
  menu: AiModelMenu | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [menu, setMenu] = useState<AiModelMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!game) return;
    try {
      // A main without play-time AI wired answers nothing: the surfaces then stay as they were.
      setMenu((await window.studio.gameAiMenu(game)) ?? null);
      setError(null);
    } catch (cause) {
      setError(problemWords(cause));
    }
  }, [game]);
  useEffect(() => {
    setMenu(null);
    void refresh();
  }, [refresh]);
  useGameAiNotices(
    useCallback(
      (notice: GameAiNotice) => {
        if (notice.kind === GameAiNoticeKind.Changed && (notice.game === null || notice.game === game)) void refresh();
      },
      [game, refresh],
    ),
  );
  return { menu, error, refresh };
}

/** The first-use card and the stop main pushed for one game, until it is answered, closed or changed. */
export function useAiPending(game: AiGameKey | null): {
  consent: AiConsentTicket | null;
  stop: AiStopCard | null;
  clearConsent: () => void;
  clearStop: () => void;
} {
  const [consent, setConsent] = useState<AiConsentTicket | null>(null);
  const [stop, setStop] = useState<AiStopCard | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another game is the trigger; its card and stop are not this one's
  useEffect(() => {
    setConsent(null);
    setStop(null);
  }, [game]);
  useGameAiNotices(
    useCallback(
      (notice: GameAiNotice) => {
        if (notice.kind === GameAiNoticeKind.Consent && notice.consent.game === game) setConsent(notice.consent);
        if (notice.kind === GameAiNoticeKind.ConsentClosed)
          setConsent((shown) => (shown?.ticket === notice.ticket ? null : shown));
        if (notice.kind === GameAiNoticeKind.Stop && notice.card.game === game) setStop(notice.card);
        if (notice.kind === GameAiNoticeKind.Changed && (notice.game === null || notice.game === game)) setStop(null);
      },
      [game],
    ),
  );
  return {
    consent,
    stop,
    clearConsent: useCallback(() => setConsent(null), []),
    clearStop: useCallback(() => setStop(null), []),
  };
}
