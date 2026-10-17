import { RunCapture } from "../chat/RunCapture.tsx";
import { ResultButton } from "../ui/ResultButton.tsx";
import type { JSX } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { summaryCounts, summaryOutcome, type RunSummary } from "../../shared/run-summary.ts";
import { plural } from "../../shared/skill-words.ts";
import { CHECK_WORDS, outcomeTitle } from "../words.ts";
import { Icon } from "../ui/icons.tsx";
import { CHECK_MARKS, checkGroups, checkMeta, checkNote, checkTitle } from "../outcome-checks.ts";
import { FileText } from "../ui/FileText.tsx";
import { openBuildGraph } from "../open-build.ts";
import { workedShortWords } from "../run-steps.ts";
import { BuildCard } from "../chat/BuildCard.tsx";

/** Did the run leave a build of its own (a head that moved past where it started)? */
const hasNewBuild = (summary: RunSummary): boolean => Boolean(summary.head) && summary.head !== summary.base;

/**
 * The chat card's one name for the build. A stopped build's card says so in its own line, next to
 * Resume; this card only names the build. A finished run whose merged build did not reach the game
 * is not "no new build": it is not live yet.
 */
function chatOutcomeTitle(summary: RunSummary): string {
  const newBuild = hasNewBuild(summary);
  const stopped = summary.execution === ExecutionStatus.Paused || summary.execution === ExecutionStatus.Cancelled;
  if (stopped) return newBuild ? "Latest build" : "No new build";
  const view = summaryOutcome(summary);
  if (view.state === "finished" && view.delivered === "none" && newBuild) return "Not live yet";
  return outcomeTitle(view, "chat");
}

/**
 * The card's second line: the checks that failed, the parts that went in, and how long it took.
 * Failed checks lead, so a narrow chat's ellipsis never hides them; the card itself opens Builds,
 * so they need no pointer there.
 */
function outcomeLine(summary: RunSummary, failedChecks: number, duration: string | null): string {
  const added = summary.tasks.filter((task) => task.integrations > 0).length;
  return [
    failedChecks ? `${plural(failedChecks, "check")} failed` : "",
    added ? `${plural(added, "part")} added` : "",
    duration ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function PlayButton({ onPlay }: { onPlay: () => void | Promise<void> }): JSX.Element {
  const [playing, setPlaying] = useState(false);
  return (
    <ResultButton
      className="w-fit"
      disabled={playing}
      onClick={async () => {
        setPlaying(true);
        try {
          await onPlay();
        } finally {
          setPlaying(false);
        }
      }}
    >
      <Icon name="play" size={12} className="fill-current" />
      {playing ? "Opening…" : "Play"}
    </ResultButton>
  );
}

/**
 * The build's outcome as the chat tells it — the same card the running build was, now finished:
 * its picture, what happened, one line of what went in and how long it took, and Play on the
 * right. The whole card opens the build on Builds, so nothing wraps under it on a narrow chat.
 */
export function RunOutcome({
  summary,
  onPlay,
  capturePath,
}: {
  summary: RunSummary;
  /** kept for callers that name the chat form; it is the only form */
  conversation?: boolean;
  capturePath?: string | null;
  onPlay?: () => void | Promise<void>;
}): JSX.Element {
  const current = summary.evidence.filter((e) => e.head === summary.head);
  const title = chatOutcomeTitle(summary);
  const failed = current.filter((e) => e.status === "failed");
  const still = summary.captures?.current ?? capturePath ?? current.findLast((e) => e.capture)?.capture;
  const line = outcomeLine(summary, failed.length, workedShortWords(summary.worked));
  return (
    <section data-testid="run-outcome" data-chat-outcome className="flex min-w-0 flex-col gap-2 text-chat text-ink-3">
      {/* How this build was made: its graph on Builds, the one way back to an earlier build. */}
      <BuildCard
        data-outcome-card
        title={title || "Build finished"}
        open={{ runId: summary.runId, onClick: () => openBuildGraph(summary.runId) }}
        {...(still ? { picture: <RunCapture key={still} path={still} compact /> } : {})}
        {...(line
          ? {
              line: (
                <p className={`m-0 truncate text-chat-sub ${failed.length ? "text-orange" : "text-ink-3"}`}>{line}</p>
              ),
            }
          : {})}
        {...(onPlay && hasNewBuild(summary) ? { aside: <PlayButton onPlay={onPlay} /> } : {})}
      />
      {summary.execution === ExecutionStatus.Failed && summary.reason && (
        <p role="alert" className="break-words text-orange">
          <FileText text={summary.reason} />
        </p>
      )}
    </section>
  );
}

type Evidence = RunSummary["evidence"][number];

/** How much of a revision id the outcome shows. */
const HEAD_CHARS = 10;

/** What the interaction checks on this revision say, the worst first; one with no revision is said too. */
const INTERACTION_WORDS: Array<[Evidence["status"], string]> = [
  ["failed", "An independent interaction check failed."],
  ["incomplete", "Independent interaction coverage is incomplete."],
  ["unknown", "Independent interaction coverage is unknown."],
  ["passed", "Recorded interaction check passed."],
];

function interactionWords(summary: RunSummary, current: Evidence[]): string {
  const interaction = current.filter((e) => e.category === "interaction");
  const said = INTERACTION_WORDS.find(([status]) => interaction.some((e) => e.status === status));
  if (said) return said[1];
  const unplaced = summary.evidence
    .filter((e) => e.category === "interaction")
    .some((e) => e.head === null && e.status === "incomplete");
  if (unplaced) return "An independent interaction test was incomplete; its revision was not recorded.";
  return "Independent interaction coverage is unavailable for this revision.";
}

/**
 * What the checks can and cannot say about the build on offer, in one or two sentences. A missing
 * interaction check is a limit of the evidence, and it is said, not left out.
 */
export function coverageWords(summary: RunSummary): string {
  const current = summary.evidence.filter((e) => e.head === summary.head);
  const passed = current.filter((e) => e.category === "structural" && e.status === "passed").length;
  const visual = current.some((e) => e.category === "visual" && e.status === "failed")
    ? " A visual question failed."
    : "";
  return `${passed} structural check${passed === 1 ? "" : "s"} passed.${visual} ${interactionWords(summary, current)}`;
}

/**
 * A check's title, clamped to three lines; Show all appears only when the clamp actually hides
 * words (a judge's whole question), measured on the rendered text, never guessed from its length.
 */
function CheckTitle({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && !open) setClamped(node.scrollHeight > node.clientHeight);
  }, [text, open]);
  return (
    <>
      <span ref={ref} className={`text-ink [overflow-wrap:anywhere] ${open ? "" : "line-clamp-3"}`}>
        {text}
      </span>
      {(clamped || open) && (
        <button
          type="button"
          aria-expanded={open}
          className="w-fit cursor-pointer text-micro text-ink-3 hover:text-ink-2"
          onClick={() => setOpen(!open)}
        >
          {open ? CHECK_WORDS.showLess : CHECK_WORDS.showAll}
        </button>
      )}
    </>
  );
}

/**
 * One check: its state's mark, what was checked, the state in words with who checked and what it
 * rests on, the checker's note, and its capture when it has one.
 */
function EvidenceRow({ e, onCapture }: { e: Evidence; onCapture: (image: string | null) => void }): JSX.Element {
  const capture = e.capture;
  const mark = CHECK_MARKS[e.status];
  const note = checkNote(e);
  return (
    <div data-check-status={e.status} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5">
      <Icon name={mark.icon} size={14} strokeWidth={2} className={`mt-[3px] ${mark.tone}`} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <CheckTitle text={checkTitle(e)} />
        <span className={`text-micro ${e.status === "failed" ? "text-red" : "text-ink-3"}`}>{checkMeta(e)}</span>
        {note && <span className="text-ink-3 [overflow-wrap:anywhere]">{note}</span>}
        {capture && (
          <button
            type="button"
            className="w-fit cursor-pointer text-accent-ink hover:underline"
            onClick={() =>
              void window.studio
                .readRunStill(capture)
                .then((image) => onCapture(image ? `data:${image.mimeType};base64,${image.data}` : null))
            }
          >
            View capture
          </button>
        )}
      </div>
    </div>
  );
}

/** One group of checks: this build's, or an earlier build's under its own heading. */
function CheckGroup({
  label,
  rows,
  onCapture,
}: {
  label: string | null;
  rows: readonly Evidence[];
  onCapture: (image: string | null) => void;
}): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3">
      {label && <h4 className="text-micro text-ink-3">{label}</h4>}
      {rows.map((e) => (
        <EvidenceRow key={`${e.head}:${e.category}:${e.label}`} e={e} onCapture={onCapture} />
      ))}
    </section>
  );
}

/** Every recorded check, this build's first and failures first, with its capture when it has one. */
export function OutcomeChecks({ summary }: { summary: RunSummary }): JSX.Element {
  const [capture, setCapture] = useState<string | null>(null);
  useEffect(() => setCapture(null), [summary.runId, summary.head]);
  const groups = checkGroups(summary.evidence, summary.head);
  return (
    <div data-outcome-checks className="flex flex-col gap-5 text-body-sm text-ink-2 select-text">
      <div className="flex flex-col gap-1">
        <p>{coverageWords(summary)}</p>
        {!summary.completeHistory && (
          <p className="text-ink-3">History incomplete — counts describe recorded events.</p>
        )}
      </div>
      {summary.evidence.length === 0 ? (
        <p className="text-ink-3">No checks recorded.</p>
      ) : (
        <>
          <CheckGroup
            label={groups.earlier.length ? CHECK_WORDS.thisBuild : null}
            rows={groups.current}
            onCapture={setCapture}
          />
          <CheckGroup label={CHECK_WORDS.earlierBuilds} rows={groups.earlier} onCapture={setCapture} />
        </>
      )}
      {capture && (
        <figure className="flex flex-col gap-1">
          <button
            type="button"
            className="w-fit cursor-pointer text-accent-ink hover:underline"
            onClick={() => setCapture(null)}
          >
            Close capture
          </button>
          <img src={capture} alt="Recorded check capture" className="max-h-80 w-full rounded-control object-contain" />
        </figure>
      )}
    </div>
  );
}

/** Counts and revision identifiers: what a person checking the build's paper trail wants. */
export function OutcomeDetails({ summary }: { summary: RunSummary }): JSX.Element {
  return (
    <div
      data-testid="build-details"
      className="flex flex-col gap-1.5 font-mono text-micro text-ink-2 select-text [overflow-wrap:anywhere]"
    >
      <p>{summaryCounts(summary)}</p>
      <p className="text-ink-3">Available revision: {summary.head?.slice(0, HEAD_CHARS) ?? "none recorded"}</p>
      {summary.landed === true && (
        <p className="text-ink-3">
          Delivered revision: {summary.deliveredHead?.slice(0, HEAD_CHARS) ?? "commit not recorded"} · from integration{" "}
          {summary.deliveredSourceHead?.slice(0, HEAD_CHARS) ?? "unknown"}
        </p>
      )}
      <p className="text-ink-3">
        Live is showing:{" "}
        {summary.preview?.project === summary.project
          ? (summary.preview.head?.slice(0, HEAD_CHARS) ?? `revision unknown (${summary.preview.state})`)
          : "another project or no recorded preview"}
        {summary.preview?.error ? ` — ${summary.preview.error}` : ""}
      </p>
      {summary.learning && <p>Studio learning: {summary.learning} — separate from game execution.</p>}
    </div>
  );
}
