/**
 * An asset card while its asset is being made, in the spot the asset will land: the kind's drawing
 * built by a sweeping beam, the tool making it (top left), a spinner and how long it has run (top
 * right), then the kind and the prompt, cut to one line; hovering a cut prompt shows it whole beside
 * the card. A Genex job on its way shows what it costs in credits beside its kind. A job that waits on
 * the person (a character's candidates, a remesh) wears the accent ring and its Approve button, with
 * what the next step costs, or Get credits when the balance cannot pay for it; one the account had
 * too few credits for offers Get credits, then Make it; one that queued or stopped short is grey
 * and still.
 */
import { createContext, type JSX, use, useEffect, useMemo, useRef, useState } from "react";
import { isGenexSource, type MakingJob, MakingPhase } from "../../shared/asset-making.ts";
import { canAfford, operationPrice } from "../../shared/play-credits.ts";
import {
  CLOCK_TICK_MS,
  elapsedWords,
  kindLook,
  type MakingSource,
  type MakingTool,
  type MakingView,
  makingView,
} from "../asset-making.ts";
import { composeInChat } from "../compose-in-chat.ts";
import { CreditsShard } from "../play/CreditsShard.tsx";
import { useGetCredits } from "../play/use-get-credits.ts";
import { usePeople, usePlugins } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { GENEX_WORDS, MAKING_WORDS } from "../words.ts";
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

/** The phases a card shows its price in: the asset is on its way, so these are the credits it spends. */
const PRICED: ReadonlySet<MakingPhase> = new Set([MakingPhase.Queued, MakingPhase.Making, MakingPhase.Review]);

/**
 * What a Genex job costs as its card shows it: Genex's own quote or charge, else the price list's
 * for its operation. Null for an unlimited account, another plugin's job, or a price nobody named.
 */
function useCardPrice(job: Pick<MakingJob, "source" | "operation" | "credits">): number | null {
  const unlimited = usePeople((s) => s.credits?.unlimited === true);
  const prices = usePeople((s) => s.creditPrices);
  if (unlimited || !isGenexSource(job.source)) return null;
  return job.credits ?? operationPrice(job.operation, prices);
}

/** A price in credits: the shard and the number, said whole to a screen reader. */
function CreditsPrice({ price }: { price: number }): JSX.Element {
  return (
    <span data-making-price={price} className="making-price font-mono tabular-nums">
      <CreditsShard size={11} />
      <span aria-hidden="true">{price}</span>
      <span className="sr-only">{GENEX_WORDS.credits(price)}</span>
    </span>
  );
}

/** The kind (shimmering while it is made, or what became of the job) and its price, over the prompt. */
function CardLabel({
  card,
  price,
  lifted,
}: {
  card: MakingView;
  price?: number | null;
  lifted?: boolean;
}): JSX.Element {
  const shimmer = card.phase === MakingPhase.Making;
  return (
    <div className="making-label" data-lifted={lifted || undefined}>
      <span className="making-title-row">
        <span
          data-making-title
          className={`making-title ${shimmer ? "chat-status-shimmer" : ""}`}
          data-tone={card.phase === MakingPhase.Failed ? "failed" : undefined}
        >
          {card.title}
        </span>
        {price != null && <CreditsPrice price={price} />}
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

/** Get credits in genex.games' dress, in a card's action spot: genex.games' plans in the browser. */
function GetCreditsAction(): JSX.Element {
  const getCredits = useGetCredits();
  return (
    <button
      type="button"
      data-making-get-credits
      className="credits-cta making-cta w-full"
      aria-label={MAKING_WORDS.getCreditsLabel}
      onClick={getCredits}
    >
      {MAKING_WORDS.getCredits}
    </button>
  );
}

/**
 * The balance read again while a card waits on it (`waiting`): once, and whenever the window comes
 * back from the browser, where Get credits sent the person.
 */
function useFreshCredits(waiting: boolean): void {
  useEffect(() => {
    if (!waiting) return;
    const read = (): void => void studio().people.loadCredits();
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [waiting]);
}

/** Whether the account's balance, as last read, pays for a price; an unread balance pays for anything. */
function useAffords(price: number | null): boolean {
  const credits = usePeople((s) => s.credits);
  return credits === null || canAfford(credits, price);
}

/**
 * A job that waits on the person: the chosen candidate's picture (else the drawing) and Approve with
 * what the next step costs. When the balance cannot pay for it, Get credits stands in Approve's place.
 */
function ReviewFace({ job, card, offset }: { job: MakingJob; card: MakingView; offset: number }): JSX.Element {
  const reviews = use(MakingReviewsContext);
  const jobId = job.jobId;
  const choice = reviews?.choiceOf(jobId) ?? null;
  const first = choice?.candidates[0] ?? null;
  const [shown, setShown] = useState<number | null>(first);
  const candidate = choice?.candidates.includes(shown) ? shown : first;
  const picture = candidate === null ? undefined : choice?.pictures[candidate];
  // The review is priced by its next step, never by a quote its job kept from the step before.
  const price = useCardPrice({ source: job.source, operation: job.operation });
  const affords = useAffords(price);
  useFreshCredits(!affords);
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
        {affords ? (
          <Button
            variant="default"
            data-making-approve
            aria-label={MAKING_WORDS.approveLabel(candidate)}
            disabled={!reviews || !choice || reviews.busy}
            className="w-full"
            onClick={() => reviews?.approve(jobId, candidate)}
          >
            {reviews?.busy ? MAKING_WORDS.approving : MAKING_WORDS.approve}
            {!reviews?.busy && price !== null && <CreditsPrice price={price} />}
          </Button>
        ) : (
          <GetCreditsAction />
        )}
      </div>
    </>
  );
}

/**
 * A job the account had too few credits for: its kind still and grey, and Get credits; once the
 * balance read on return from the browser pays for it, Make it asks the chat's agent to make it now.
 */
function NeedsCreditsFace({
  job,
  card,
  offset,
  project,
}: {
  job: MakingJob;
  card: MakingView;
  offset: number;
  project?: string;
}): JSX.Element {
  useFreshCredits(true);
  const credits = usePeople((s) => s.credits);
  const prices = usePeople((s) => s.creditPrices);
  const ready =
    credits !== null && credits.balance !== null && canAfford(credits, operationPrice(job.operation, prices));
  const kind = kindLook(job.kind).label;
  const makeIt = (): void => {
    if (project) composeInChat({ project, text: MAKING_WORDS.makeAgain(kind, card.prompt), send: true });
  };
  return (
    <>
      <MakingArt drawing={card.drawing} still offset={offset} className="making-art-slot" />
      <ToolChip tool={card.tool} />
      <CardLabel card={card} lifted />
      <div className="making-actions">
        {ready && project ? (
          <Button variant="default" data-making-make-it className="w-full" onClick={makeIt}>
            {MAKING_WORDS.makeIt}
          </Button>
        ) : (
          <GetCreditsAction />
        )}
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
  MakingPhase.NeedsCredits,
]);

function CardFace({ job, card, offset }: { job: MakingJob; card: MakingView; offset: number }): JSX.Element {
  const resting = RESTING.has(card.phase);
  const price = useCardPrice(job);
  return (
    <>
      <MakingArt drawing={card.drawing} still={resting} offset={offset} className="making-art-slot" />
      <ToolChip tool={card.tool} />
      {card.phase === MakingPhase.Making && <RunningClock startedAt={card.startedAt} />}
      {card.phase === MakingPhase.Queued && <span className="making-corner font-mono">{MAKING_WORDS.queued}</span>}
      <CardLabel card={card} price={PRICED.has(card.phase) ? price : null} />
    </>
  );
}

/** The face a job's card wears: its review, its wait on credits, or the asset being made. */
function Face({
  job,
  card,
  offset,
  project,
}: {
  job: MakingJob;
  card: MakingView;
  offset: number;
  project?: string;
}): JSX.Element {
  if (card.phase === MakingPhase.Review) return <ReviewFace job={job} card={card} offset={offset} />;
  if (card.phase === MakingPhase.NeedsCredits)
    return <NeedsCreditsFace job={job} card={card} offset={offset} project={project} />;
  return <CardFace job={job} card={card} offset={offset} />;
}

/**
 * One job with no file in the game yet, as its card; `plugin` is the plugin it came from, as the
 * person knows it, and `project` the game whose chat Make it asks.
 */
export function MakingCard({
  job,
  plugin,
  project,
}: {
  job: MakingJob;
  plugin?: MakingSource;
  project?: string;
}): JSX.Element {
  const card = useMemo(() => makingView(job, plugin), [job, plugin]);
  const id = job.jobId;
  const offset = offsetOf(id) * OFFSET_RANGE_S;
  // A press on a review's or a credits wait's controls is theirs: it never starts a pan of the canvas.
  const pressable = card.phase === MakingPhase.Review || card.phase === MakingPhase.NeedsCredits;
  return (
    <div
      role="group"
      aria-label={card.label}
      data-asset-pending={id}
      data-making={card.phase}
      className="making-card"
      onPointerDown={pressable ? (event) => event.stopPropagation() : undefined}
    >
      <Face job={job} card={card} offset={offset} project={project} />
    </div>
  );
}
