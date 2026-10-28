/**
 * The usage analytics question, asked once per profile (and again only when what analytics collects
 * grows): above the first launch's welcome, whose film waits on its caret, or at the first launch of
 * a version with analytics. Both answers weigh the same, and neither can be skipped. The replay line
 * shows only to an install that records one. See ../analytics/ for what is sent.
 */
import type { JSX } from "react";
import { useRef } from "react";
import { AnalyticsChoice } from "../analytics/consent.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { ANALYTICS_WORDS } from "../words.ts";

/** One line of what is shared: a glyph, its title and one quiet line. */
function ConsentRow({ icon, title, text, muted }: { icon: IconName; title: string; text: string; muted?: boolean }) {
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
      <span className={muted ? "mt-px text-ink-3" : "mt-px text-accent-ink"}>
        <Icon name={icon} size={18} />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-sm font-medium text-ink">{title}</span>
        <span className="text-[13px] leading-[18px] text-ink-3 text-balance">{text}</span>
      </span>
    </li>
  );
}

/** What the question lists and its two answers, the replay line only for an install that records one. */
export function ConsentChoices({
  replay,
  onAnswer,
}: {
  replay: boolean;
  onAnswer: (choice: AnalyticsChoice) => void;
}): JSX.Element {
  return (
    <>
      <ul data-analytics-consent className="flex flex-col gap-3.5">
        <ConsentRow icon="graph" title={ANALYTICS_WORDS.events} text={ANALYTICS_WORDS.eventsWhat} />
        {replay && <ConsentRow icon="video" title={ANALYTICS_WORDS.replay} text={ANALYTICS_WORDS.replayWhat} />}
        <ConsentRow icon="eye-off" title={ANALYTICS_WORDS.never} text={ANALYTICS_WORDS.neverWhat} muted />
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        <p className="text-[13px] leading-[18px] text-ink-3">{ANALYTICS_WORDS.later}</p>
        <div className="flex shrink-0 gap-2">
          <Button data-analytics-choice={AnalyticsChoice.Off} onClick={() => onAnswer(AnalyticsChoice.Off)}>
            {ANALYTICS_WORDS.keep}
          </Button>
          <Button data-analytics-choice={AnalyticsChoice.On} onClick={() => onAnswer(AnalyticsChoice.On)}>
            {ANALYTICS_WORDS.share}
          </Button>
        </div>
      </div>
    </>
  );
}

export function AnalyticsConsent({
  replay,
  onChoice,
}: {
  /** This install records a replay of its first week: the question says so. */
  replay: boolean;
  /** The answer, and how long the question was up. */
  onChoice: (choice: AnalyticsChoice, shownMs: number) => void;
}): JSX.Element {
  const shownAt = useRef(performance.now());
  const answer = (choice: AnalyticsChoice) => onChoice(choice, Math.round(performance.now() - shownAt.current));
  return (
    <DialogSurface
      title={ANALYTICS_WORDS.question}
      description={ANALYTICS_WORDS.lead}
      testId="analytics-consent"
      showClose={false}
      dismissible={false}
      onDismiss={() => {}}
    >
      <ConsentChoices replay={replay} onAnswer={answer} />
    </DialogSurface>
  );
}
