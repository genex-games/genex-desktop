/**
 * The AI pill: the chat's model button, in the Play bar (`V3-Pill`). It names the model the game
 * uses, or "Credits" with the balance (orange when low), "AI · Choose" with Play's blue edge while a
 * card waits, and "AI off"; a free model says Free after its name, a leaderboard game on a model
 * that does not count says Unranked. While a reply is on its way the name shimmers. A note main
 * sends ("AI is on · …", "Report sent") is worn in place of the label and fades on its own, as the
 * bar's other buttons wear theirs. The narrow bar shows the model's shorter name. A press opens the
 * model menu, or the card that waits.
 */
import type { JSX, Ref } from "react";
import { useRef } from "react";
import type { PlayAiBar } from "../../shared/play-bar.ts";
import { Icon } from "../ui/icons.tsx";
import { PLAY_AI_WORDS } from "../words.ts";
import { NoteLook } from "./play-model.ts";
import { noteDone, PillName, PillValue, type PillView, pillView, type ShownNote } from "./ai-model.ts";

const WORDS = PLAY_AI_WORDS.pill;

/** The pill's name: the model's, whole and short, or one of its words. */
function PillNameText({ view }: { view: PillView }): JSX.Element {
  switch (view.name) {
    case PillName.Off:
      return <>{WORDS.off}</>;
    case PillName.Choose:
      return <>{WORDS.choose}</>;
    case PillName.Credits:
      return <>{WORDS.credits}</>;
    default:
      return (
        <>
          <span className="play-ai-pill-full">{view.label}</span>
          <span className="play-ai-pill-short">{view.short}</span>
        </>
      );
  }
}

/** The quieter word after the name: Free, the balance or Unranked. */
function PillValueText({ view }: { view: PillView }): JSX.Element | null {
  switch (view.value) {
    case PillValue.Free:
      return <span className="play-ai-pill-value">{WORDS.free}</span>;
    case PillValue.Unranked:
      return <span className="play-ai-pill-value">{WORDS.unranked}</span>;
    case PillValue.Balance:
      return (
        <span className="play-ai-pill-value" data-warn={view.warn ? true : undefined}>
          {PLAY_AI_WORDS.credits(view.balance ?? 0)}
        </span>
      );
    default:
      return null;
  }
}

/** How the pill wears a note: a done one with a check, as Share wears Link copied. */
const lookOf = (note: ShownNote): NoteLook => (noteDone(note.note) ? NoteLook.Done : NoteLook.Said);

/** The last words a note wore, kept while it folds away so they leave with it. */
function useLastWords(words: string | null): string {
  const last = useRef("");
  if (words) last.current = words;
  return last.current;
}

/** The pill for the game's AI as main drew it, `open` while its menu or card is out. */
export function PlayAiPill({
  ai,
  note,
  platform,
  open,
  pill,
  onPress,
}: {
  ai: PlayAiBar;
  note: ShownNote | null;
  platform: string;
  open: boolean;
  pill: Ref<HTMLButtonElement>;
  onPress: () => void;
}): JSX.Element {
  const view = pillView(ai);
  const worn = note ? PLAY_AI_WORDS.note(ai, platform) : null;
  const said = useLastWords(worn);
  return (
    <button
      ref={pill}
      type="button"
      className="play-viewer-bar-pill play-ai-pill"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-busy={view.busy ? true : undefined}
      aria-label={worn ?? WORDS.aria(view)}
      data-play-ai-pill={view.name}
      data-attention={view.attention ? true : undefined}
      data-off={view.name === PillName.Off ? true : undefined}
      data-open={open ? true : undefined}
      data-note={note ? lookOf(note) : undefined}
      onClick={onPress}
    >
      <span className="play-bar-icon">
        <Icon name="sparkle" size={16} />
        <Icon name="check" size={16} className="play-bar-check" />
      </span>
      <span className="play-bar-label" data-shown={worn ? undefined : true}>
        <span>
          <span className="play-ai-pill-name" data-busy={view.busy ? true : undefined}>
            <PillNameText view={view} />
          </span>
          <PillValueText view={view} />
        </span>
      </span>
      <span className="play-bar-label" data-shown={worn ? true : undefined} aria-hidden={!worn}>
        <span>{said}</span>
      </span>
      <Icon name="chevron-down" size={12} strokeWidth={2} className="play-ai-pill-chevron" />
    </button>
  );
}
