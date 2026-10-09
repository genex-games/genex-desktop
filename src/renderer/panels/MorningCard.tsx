import { LearningSummary } from "../chat/LearningSummary.tsx";
/**
 * The morning card — the last thing a run writes into the chat, and usually the first thing
 * the user reads.
 *
 * What it replaced: "RUN · ended after 21 iterations — the director finished the run", under
 * thirty judge cards, over a run that had built, merged and judged a game. Everything here is
 * the answer to one of the three questions a person actually has at 8 am — what happened, what
 * does it look like now, and can I play it.
 */
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import type { RunSummary } from "../../shared/run-summary.ts";
import { useRunSummary } from "../use-run-summary.ts";
import { RunOutcome } from "./RunOutcome.tsx";
import { MorningAction, morningWords } from "../morning-words.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import { problemWords } from "../words.ts";
import { ResultButton as Button } from "../ui/ResultButton.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { FileText } from "../ui/FileText.tsx";
import { AssetResults } from "../chat/AssetResults.tsx";
import type { AssetDeliveredPayload } from "../../shared/game-assets.ts";
import { Presence, type PresenceChild } from "../ui/Presence.tsx";

/** How long a finished build's card keeps the place of a result that has not come yet. */
const RESULT_WAIT_MS = 3 * SECOND_MS;
/** The key the result and its kept place share, so the result lands in that place without moving. */
const RESULT_KEY = "result";

/** Whether a missing result may still come: for its first moments, and never once it has. */
function useResultWait(arrived: boolean): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (arrived) return;
    const timer = setTimeout(() => setExpired(true), RESULT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [arrived]);
  return !arrived && !expired;
}

/** The result's card, its silent place while it may still come, or nothing. */
function resultPlace(
  outcome: RunSummary | null,
  waiting: boolean,
  card: (summary: RunSummary) => ReactNode,
): PresenceChild[] {
  if (outcome) return [{ key: RESULT_KEY, node: card(outcome) }];
  return waiting ? [{ key: RESULT_KEY, node: <div aria-hidden className="build-card-place" /> }] : [];
}

export interface MorningCardProps {
  runId?: string | null;
  rounds: number;
  kept: number;
  undone: number;
  landed: boolean | null;
  /** the run is paused: Resume is the card's own primary action, not a grey line under it */
  paused?: boolean;
  /** the provider failure that paused it (the close's `limit.kind`), when one did */
  pausedOn?: string | null;
  stoppedBecause?: string | null;
  /** the run's report to the user, when it wrote one */
  summary: string | null;
  /** the plain sentence the close wrote about landing, when it wrote one */
  landingLine?: string | null;
  /** what the studio itself took from the run — its own ledger's one line, when it had one */
  learned?: string | null;
  project: string | null;
  /** the merged build, when the run left one that is not the live game */
  commit: string | null;
  before: string | null;
  after: string | null;
  /** what the run generated in its own workspace; only the files now in the game show */
  assets?: AssetDeliveredPayload[];
  /** stopped with a follow-up waiting: that message answers "what next", so the card only shows the result */
  handedOff?: boolean;
  onShowLive?: () => void;
  onOpenAssets?: () => void;
  onOpenStudio?: () => void;
  onResume?: () => void;
  onNotice?: Notify;
}

export function MorningCard({
  runId = null,
  rounds,
  kept,
  undone,
  landed,
  paused = false,
  pausedOn = null,
  stoppedBecause,
  summary,
  landingLine,
  learned,
  project,
  commit,
  after,
  assets,
  handedOff = false,
  onShowLive,
  onOpenAssets,
  onOpenStudio,
  onResume,
  onNotice,
}: MorningCardProps): JSX.Element {
  const outcome = useRunSummary(project, runId);
  const waiting = useResultWait(outcome !== null);
  const words = morningWords({
    rounds,
    kept,
    undone,
    landed,
    paused,
    pausedOn,
    // The sentence and the buttons read the same fact: a build exists only if there is one to open.
    hasBuild: Boolean(project && commit),
    stoppedBecause: stoppedBecause ?? null,
    summary,
    landingLine: landingLine ?? null,
    learned: learned ?? null,
  });
  const outcomeHasPlayback = Boolean(project && outcome?.head && outcome.head !== outcome.base);
  const actions = handedOff
    ? []
    : words.actions.filter((action) => {
        const plays = action === MorningAction.Play || action === MorningAction.PlayBuild;
        if (outcomeHasPlayback && plays) return false;
        if (action !== MorningAction.Play || !outcome) return true;
        return Boolean(outcome.head) || outcome.landed === true;
      });
  // A landed build the outcome already plays speaks for itself; the "because" line would repeat it.
  const showBecause = !handedOff && !(outcomeHasPlayback && outcome?.landed === true);
  const showLive = (): void => {
    // A landed build is already the game folder; loading it puts the stage back on the real
    // thing after a run in which a merged build may have been shown from a worktree.
    if (project) void window.studio.loadPreview(project).catch((err) => onNotice?.(problemWords(err), ToastTone.Error));
    onShowLive?.();
  };
  const button = (action: MorningAction): JSX.Element | null => {
    if (action === MorningAction.Resume) {
      return (
        <Button
          key={action}
          title="Pick the build up where it left off"
          data-run-resume={runId ?? undefined}
          onClick={() => onResume?.()}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
          Resume
        </Button>
      );
    }
    if (action === MorningAction.Play) {
      return (
        <Button key={action} onClick={showLive}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
          Play
        </Button>
      );
    }
    if (!project || !commit) return null;
    return (
      <Button
        key={action}
        title="Load this build in the Live tab from a copy; your game folder stays as it is"
        onClick={() => {
          void window.studio.showBuild(project, commit).catch((err) => onNotice?.(problemWords(err), ToastTone.Error));
          onShowLive?.();
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
        Play
      </Button>
    );
  };
  return (
    <div data-testid="morning-card" className="flex min-w-0 flex-col gap-1.5">
      {words.summary && <Markdown text={words.summary} />}
      {/* The result loads after the card shows: its place is kept, silently, while it may still come, so
          nothing moves when it lands; a result that never comes closes the place, a late one opens in it. */}
      <Presence>
        {resultPlace(outcome, waiting, (summary) => (
          <RunOutcome
            conversation
            capturePath={after}
            summary={summary}
            onPlay={() => {
              if (project && summary.head)
                return window.studio
                  .showBuild(project, summary.head)
                  .then(() => onShowLive?.())
                  .catch((error) => onNotice?.(String(error), ToastTone.Error));
            }}
          />
        ))}
      </Presence>
      {assets?.length ? <AssetResults deliveries={assets} onOpenAssets={onOpenAssets} /> : null}
      {showBecause && (
        <div className="text-chat text-ink-3">
          <FileText text={words.because} />
        </div>
      )}
      {words.learned ? (
        <div data-testid="morning-learned">
          <LearningSummary text={words.learned} onOpenStudio={onOpenStudio} />
        </div>
      ) : null}
      {actions.length > 0 && <div className="flex flex-wrap gap-1.5">{actions.map(button)}</div>}
    </div>
  );
}
