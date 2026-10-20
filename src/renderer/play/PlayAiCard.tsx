/**
 * Genex's own cards over the game, hung under the AI pill: the one-sentence first-use card
 * (`V3-First`: "Crowns of 1444 will use Claude Haiku 4.5 on your Claude plan." Play, Change ▾) and
 * the stop cards (`V3-Stops`: one card, one way on). A card takes no answer in its first 600 ms, so a
 * click meant for the game never lands on it, and a held key's repeats do nothing. Esc or a click
 * outside sets it aside: the pill then says "AI · Choose" and opens it again.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, KeyboardEvent } from "react";
import { useRef } from "react";
import { AiStopReason } from "../../shared/game-ai-views.ts";
import { Icon } from "../ui/icons.tsx";
import { PLAY_AI_WORDS, type PlayAiCardWords } from "../words.ts";
import {
  type AiCard,
  AiCardKind,
  type CardActions,
  ConsentAction,
  commitReady,
  consentActions,
  StopAction,
  stopActions,
} from "./ai-model.ts";

/** What a card's buttons do, by the kind of card. */
export interface AiCardHandlers {
  consent(action: ConsentAction): void;
  stop(action: StopAction): void;
}

/** Buttons that open the model menu wear its chevron ("Change ▾"). */
const OPENS_MENU: ReadonlySet<string> = new Set([ConsentAction.Change, StopAction.Change, StopAction.UseAnother]);

/** A button as the card draws it. */
interface CardButtonWords {
  action: string;
  label: string;
  act: () => void;
}

/** A card's words and its buttons, the primary first. */
interface CardWords extends PlayAiCardWords {
  primary: CardButtonWords;
  secondary: CardButtonWords | null;
}

/** Each of a card's buttons with its words and what it does. */
function buttons<A extends string>(actions: CardActions<A>, label: (action: A) => string, act: (action: A) => void) {
  const button = (action: A): CardButtonWords => ({ action, label: label(action), act: () => act(action) });
  return { primary: button(actions.primary), secondary: actions.secondary === null ? null : button(actions.secondary) };
}

/** A card's words and its buttons. */
function cardWords(card: AiCard, platform: string, on: AiCardHandlers): CardWords {
  if (card.kind === AiCardKind.Consent) {
    const { consent } = card;
    const label = (action: ConsentAction) => PLAY_AI_WORDS.consentAction(action, consent, platform);
    return { ...PLAY_AI_WORDS.consent(consent, platform), ...buttons(consentActions(consent), label, on.consent) };
  }
  const label = (action: StopAction) => PLAY_AI_WORDS.stopAction(action, card.card);
  return { ...PLAY_AI_WORDS.stop(card.card, platform), ...buttons(stopActions(card.card), label, on.stop) };
}

/** A held Enter or Space repeats its press: only a fresh one acts. */
const holdRepeats = (event: KeyboardEvent<HTMLButtonElement>): void => {
  if (event.repeat) event.preventDefault();
};

/** The card for `card`, at `place` under the pill; `problem` says why an answer did nothing. */
export function PlayAiCard({
  card,
  place,
  platform,
  problem,
  busy,
  on,
  onSetAside,
}: {
  card: AiCard;
  place: { top: number; right: number };
  platform: string;
  problem: string | null;
  busy: boolean;
  on: AiCardHandlers;
  onSetAside: () => void;
}): JSX.Element {
  const words = cardWords(card, platform, on);
  // The card is drawn anew for each card (`key`): its first moments are counted from here.
  const shownAt = useRef(Date.now());
  const press = (button: CardButtonWords): void => {
    if (busy || !commitReady(shownAt.current, Date.now())) return;
    button.act();
  };
  // Not answering: it retries by itself, and its line shimmers while it does.
  const retrying = card.kind === AiCardKind.Stop && card.card.reason === AiStopReason.NotAnswering;
  const { primary, secondary } = words;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onSetAside()}>
      <Dialog.Portal>
        <Dialog.Content
          className="play-ai-card"
          style={{ top: place.top, right: place.right }}
          aria-describedby="play-ai-card-small"
          data-play-ai-card={card.kind === AiCardKind.Consent ? card.consent.kind : card.card.reason}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLElement>("[data-ai-primary]")?.focus();
          }}
        >
          <Dialog.Title className="play-ai-card-line" data-busy={retrying ? true : undefined}>
            {words.line.map((part, at) => (at % 2 === 1 ? <b key={at}>{part}</b> : <span key={at}>{part}</span>))}
          </Dialog.Title>
          <p id="play-ai-card-small" className="play-ai-card-small">
            {words.small}
          </p>
          {problem && (
            <p className="play-ai-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="play-ai-card-acts">
            <CardButton button={primary} primary busy={busy} onPress={press} />
            {secondary && <CardButton button={secondary} busy={busy} onPress={press} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One of a card's two buttons. */
function CardButton({
  button,
  primary = false,
  busy,
  onPress,
}: {
  button: CardButtonWords;
  primary?: boolean;
  busy: boolean;
  onPress: (button: CardButtonWords) => void;
}): JSX.Element {
  const opensMenu = OPENS_MENU.has(button.action);
  return (
    <button
      type="button"
      className="play-ai-button"
      data-primary={primary ? true : undefined}
      data-ai-primary={primary ? true : undefined}
      data-ai-action={button.action}
      aria-haspopup={opensMenu ? "menu" : undefined}
      aria-disabled={busy ? true : undefined}
      onKeyDown={holdRepeats}
      onClick={() => onPress(button)}
    >
      {button.label}
      {opensMenu && <Icon name="chevron-down" size={12} strokeWidth={2} />}
    </button>
  );
}
