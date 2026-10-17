/**
 * An asset card while its asset is being made, in the spot the asset will land: the kind's drawing
 * built by a sweeping beam, the tool making it (top left), a spinner and how long it has run (top
 * right), then the kind and the prompt, cut to one line; hovering a cut prompt shows it whole beside
 * the card. A job that waits on the
 * person (a character's candidates, a remesh) wears the accent ring and its Approve button; one
 * that queued or stopped short is grey and still.
 */
import { createContext, type JSX, use, useEffect, useMemo, useRef, useState } from "react";
import { type MakingJob, MakingPhase } from "../../shared/asset-making.ts";
import {
  CLOCK_TICK_MS,
  elapsedWords,
  type MakingSource,
  type MakingTool,
  type MakingView,
  makingView,
} from "../asset-making.ts";
import { usePlugins } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { MAKING_WORDS } from "../words.ts";
import { MakingArt } from "./MakingArt.tsx";

/** What a job waiting on the person offers: its candidates (null is a remesh) and their pictures. */
export interface MakingChoice {
  candidates: Array<number | null>;
  pictures: Partial<Record<number, string>>;
}
/** The open game's reviews, when Genex's status has been read: each job's choice, and how to approve one. */
export interface MakingReviews {
  choiceOf: (jobId: string) => MakingChoice | null;
  approve: (jobId: string, candidate: number | null) => void;
  /** An approval is on its way: every Approve waits for it. */
  busy: boolean;
}
/** The reviews the canvas has read, or null before (or without) Genex. */
export const MakingReviewsContext = createContext<MakingReviews | null>(null);

/** The installed plugins as the person knows them, by id: their names and pictures, for the cards they make. */
export function usePluginSources(): ReadonlyMap<string, MakingSource> {
  const list = usePlugins((s) => s.list);
  return useMemo(
    () =>
      new Map(
        list.map((plugin) => [
          plugin.manifest.id,
          { name: plugin.manifest.name, ...(plugin.iconUrl ? { icon: plugin.iconUrl } : {}) },
        ]),
      ),
    [list],
  );
}

/** A stable number in [0, 1) from a job id, so each card's loop starts at its own point. */
function offsetOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return hash / 9973;
}
/** How far into its loop a card starts, in seconds. */
const OFFSET_RANGE_S = 3.4;

/** The time now, moving on every second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function ToolChip({ tool }: { tool: MakingTool }): JSX.Element {
  return (
    <span data-making-tool={tool.name} className="making-chip asset-glass">
      {tool.mark && <img src={tool.mark} alt="" draggable={false} className="making-chip-mark" />}
      <span className="truncate">{tool.name}</span>
    </span>
  );
}

/** A small spinner and how long the job has run; just the spinner when it never said when it started. */
function RunningClock({ startedAt }: { startedAt: number | null }): JSX.Element {
  const now = useNow(true);
  const clock = elapsedWords(startedAt, now);
  return (
    <span data-making-clock className="making-corner font-mono tabular-nums" aria-hidden="true">
      <svg aria-hidden="true" className="making-spinner" width="10" height="10" viewBox="0 0 10 10" fill="none">
        <circle cx="5" cy="5" r="3.8" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.3" />
        <path d="M5 1.2a3.8 3.8 0 0 1 3.8 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {clock}
    </span>
  );
}

/** The prompt in one line; when the line cuts it, hovering it shows it whole beside the card, its arrow on the line. */
function PromptLine({ prompt }: { prompt: string }): JSX.Element {
  const line = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // A prompt the line shows whole needs no tooltip repeating it.
  const cut = () => (line.current ? line.current.scrollWidth > line.current.clientWidth : false);
  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && cut())}>
      <TooltipTrigger asChild>
        <span ref={line} data-making-prompt className="making-prompt">
          {prompt}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" sideOffset={10} className="making-tooltip">
        {prompt}
      </TooltipContent>
    </Tooltip>
  );
}

/** The kind (shimmering while it is made, or what became of the job) over the prompt. */
function CardLabel({ card }: { card: MakingView }): JSX.Element {
  const shimmer = card.phase === MakingPhase.Making;
  return (
    <div className="making-label">
      <span
        data-making-title
        className={`making-title ${shimmer ? "chat-status-shimmer" : ""}`}
        data-tone={card.phase === MakingPhase.Failed ? "failed" : undefined}
      >
        {card.title}
      </span>
      {card.prompt && <PromptLine prompt={card.prompt} />}
    </div>
  );
}

/** A preview's candidates as small numbered tabs, when it offers more than one. */
function CandidateTabs({
  choice,
  shown,
  onShow,
}: {
  choice: MakingChoice;
  shown: number | null;
  onShow: (candidate: number) => void;
}): JSX.Element | null {
  const numbered = choice.candidates.filter((candidate): candidate is number => candidate !== null);
  if (numbered.length < 2) return null;
  return (
    <div role="group" aria-label={MAKING_WORDS.candidates} className="making-corner making-tabs">
      {numbered.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={candidate === shown}
          aria-label={MAKING_WORDS.candidate(candidate)}
          className="making-tab"
          onClick={() => onShow(candidate)}
        >
          {candidate}
        </button>
      ))}
    </div>
  );
}

/** A job that waits on the person: the chosen candidate's picture (else the drawing) and Approve. */
function ReviewFace({ jobId, card, offset }: { jobId: string; card: MakingView; offset: number }): JSX.Element {
  const reviews = use(MakingReviewsContext);
  const choice = reviews?.choiceOf(jobId) ?? null;
  const first = choice?.candidates[0] ?? null;
  const [shown, setShown] = useState<number | null>(first);
  const candidate = choice?.candidates.includes(shown) ? shown : first;
  const picture = candidate === null ? undefined : choice?.pictures[candidate];
  return (
    <>
      {picture ? (
        <img src={picture} alt={MAKING_WORDS.candidate(candidate ?? 0)} draggable={false} className="making-picture" />
      ) : (
        <MakingArt drawing={card.drawing} still offset={offset} className="making-art-slot" />
      )}
      <ToolChip tool={card.tool} />
      {choice && <CandidateTabs choice={choice} shown={candidate} onShow={setShown} />}
      <div className="making-actions">
        <Button
          variant="default"
          data-making-approve
          aria-label={MAKING_WORDS.approveLabel(candidate)}
          disabled={!reviews || !choice || reviews.busy}
          className="w-full"
          onClick={() => reviews?.approve(jobId, candidate)}
        >
          {reviews?.busy ? MAKING_WORDS.approving : MAKING_WORDS.approve}
        </Button>
      </div>
    </>
  );
}

/** The phases drawn grey and still: the job waits for its tool, or ended without its files. */
const RESTING: ReadonlySet<MakingPhase> = new Set([
  MakingPhase.Queued,
  MakingPhase.Failed,
  MakingPhase.Stopped,
  MakingPhase.Unsure,
  MakingPhase.NotFetched,
  MakingPhase.NotInGame,
]);

function CardFace({ card, offset }: { card: MakingView; offset: number }): JSX.Element {
  const resting = RESTING.has(card.phase);
  return (
    <>
      <MakingArt drawing={card.drawing} still={resting} offset={offset} className="making-art-slot" />
      <ToolChip tool={card.tool} />
      {card.phase === MakingPhase.Making && <RunningClock startedAt={card.startedAt} />}
      {card.phase === MakingPhase.Queued && <span className="making-corner font-mono">{MAKING_WORDS.queued}</span>}
      <CardLabel card={card} />
    </>
  );
}

/** One job with no file in the game yet, as its card; `plugin` is the plugin it came from, as the person knows it. */
export function MakingCard({ job, plugin }: { job: MakingJob; plugin?: MakingSource }): JSX.Element {
  const card = useMemo(() => makingView(job, plugin), [job, plugin]);
  const id = job.jobId;
  const offset = offsetOf(id) * OFFSET_RANGE_S;
  const review = card.phase === MakingPhase.Review;
  return (
    <div
      role="group"
      aria-label={card.label}
      data-asset-pending={id}
      data-making={card.phase}
      className="making-card"
      // A press on a review's controls is theirs: it never starts a pan of the canvas.
      onPointerDown={review ? (event) => event.stopPropagation() : undefined}
    >
      {review ? <ReviewFace jobId={id} card={card} offset={offset} /> : <CardFace card={card} offset={offset} />}
    </div>
  );
}
