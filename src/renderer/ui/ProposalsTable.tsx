/**
 * Studio's suggested changes to how it builds, as one review block: each row is included by its
 * check mark, expands to what changes in plain words, and keeps the exact edit one step further
 * in. The footer applies or discards every included suggestion at once.
 */
import type { JSX, ReactNode } from "react";
import { useId, useState } from "react";
import type { StagedProposal } from "../types.ts";
import { type DiffLine, DiffTone, editDiff } from "../edit-diff.ts";
import { SUGGESTION_WORDS } from "../words.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./icons.tsx";
import { proposalTitle } from "../../shared/skill-words.ts";

/** A suggestion's include box: filled, with a check, while the suggestion is included. */
function IncludedMark({ included }: { included: boolean }): JSX.Element {
  return (
    <span aria-hidden className="include-mark" data-on={included || undefined}>
      {included ? <Icon name="check" size={12} strokeWidth={3} /> : null}
    </span>
  );
}

/** The mark in a diff line's gutter; a gap of unchanged lines is drawn by theme.css. */
const DIFF_SIGN: Record<DiffTone, string> = {
  [DiffTone.Add]: "+",
  [DiffTone.Del]: "−",
  [DiffTone.Ctx]: " ",
  [DiffTone.Gap]: "",
};

/**
 * A diff, one row per line, wrapped to the width it is given so it scrolls only down; theme.css
 * tints added lines green and removed ones red.
 */
export function DiffLines({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <div className="diff-lines text-chat-sub">
      {lines.map((line, index) => (
        <div key={index} className="diff-line" data-tone={line.tone}>
          <span aria-hidden className="diff-sign">
            {DIFF_SIGN[line.tone]}
          </span>
          <span className="diff-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** A chevron that turns with its disclosure; the shared body below animates the height. */
export function TurningChevron({ open, size = 15 }: { open: boolean; size?: number }): JSX.Element {
  return (
    <Icon
      name="chevron-down"
      size={size}
      className={`shrink-0 text-ink-3 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    />
  );
}

/** Height and opacity follow `open`; children mount on first open and stay for the closing motion. */
export function DisclosureBody({
  id,
  open,
  children,
}: {
  id: string;
  open: boolean;
  children: ReactNode;
}): JSX.Element {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    <div id={id} className="disclosure-body" data-open={open}>
      <div>{seen ? children : null}</div>
    </div>
  );
}

/** The instruction file, the proposer's own notes and the diff: for people who want the detail. */
export function ExactEdit({
  file,
  notes,
  lines,
  inline = false,
}: {
  file: string;
  notes?: string;
  lines: DiffLine[];
  inline?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const frame = (
    <div className={`${inline ? "" : "mt-2 "}overflow-hidden rounded-[10px] bg-tooltip shadow-hairline`}>
      <div className="border-b border-line px-2.5 py-2 font-mono text-micro text-ink-3">{file}</div>
      {notes && (
        <p className="border-b border-line px-2.5 py-2 text-chat-sub text-ink-3 [overflow-wrap:anywhere]">{notes}</p>
      )}
      <div className="max-h-80 overflow-y-auto overflow-x-hidden">
        <DiffLines lines={lines} />
      </div>
    </div>
  );
  // With nothing else to read in the row, the edit itself is the content: no extra click.
  if (inline)
    return (
      <div data-exact-edit className="w-full min-w-0">
        {frame}
      </div>
    );
  return (
    <div data-exact-edit className="w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="chat-disclosure cursor-pointer whitespace-nowrap text-chat-sub"
      >
        {SUGGESTION_WORDS.seeExactEdit}
        <TurningChevron open={open} size={14} />
      </button>
      <DisclosureBody id={id} open={open}>
        {frame}
      </DisclosureBody>
    </div>
  );
}

export function SuggestionReview({
  proposals,
  busy,
  onApply,
  onDiscard,
}: {
  proposals: StagedProposal[];
  busy: boolean;
  onApply: (indices: number[]) => void;
  onDiscard: (indices: number[]) => void;
}): JSX.Element {
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const id = useId();
  const flip = (set: Set<number>, index: number) => {
    const next = new Set(set);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  };
  const included = proposals.map((_, i) => i).filter((i) => !excluded.has(i));

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-suggestions
      className="overflow-hidden rounded-card bg-surface shadow-card"
    >
      <header className="flex flex-col gap-0.5 border-b border-line px-4 py-3">
        <h2 id={`${id}-title`} className="font-medium text-ink">
          {SUGGESTION_WORDS.title(proposals.length)}
        </h2>
        <p className="text-chat-sub text-ink-3">{SUGGESTION_WORDS.subtitle}</p>
      </header>
      {proposals.map((proposal, index) => {
        const on = !excluded.has(index);
        const open = expanded.has(index);
        const title = proposalTitle(proposal);
        const summary = proposal.summary?.filter(Boolean) ?? [];
        return (
          <div
            key={`${proposal.skill}-${proposal.at}-${index}`}
            data-suggestion
            className="border-b border-line transition-[background-color] duration-200 motion-reduce:transition-none"
            style={{ background: on ? "color-mix(in srgb, var(--green) 8%, transparent)" : undefined }}
          >
            <div className="flex min-w-0 items-start gap-0.5 px-2 py-1.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={SUGGESTION_WORDS.include(title)}
                onClick={() => setExcluded((current) => flip(current, index))}
                className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-control"
              >
                <IncludedMark included={on} />
              </button>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${id}-${index}`}
                onClick={() => setExpanded((current) => flip(current, index))}
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-control py-1.5 pr-1.5 pl-1 text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`font-medium transition-colors duration-200 ${on ? "text-ink" : "text-ink-3"}`}>
                    {title}
                  </span>
                  {!open && (
                    <span className="truncate text-chat-sub text-ink-3">
                      {summary[0] ?? SUGGESTION_WORDS.fallbackSummary}
                    </span>
                  )}
                </span>
                <span className="flex h-[22px] items-center">
                  <TurningChevron open={open} />
                </span>
              </button>
            </div>
            <DisclosureBody id={`${id}-${index}`} open={open}>
              <div className="flex flex-col gap-3.5 pr-5 pb-4 pl-[52px]">
                {summary.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-chat-sub text-ink-3">{SUGGESTION_WORDS.whatChanges}</p>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
                      {summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <ExactEdit
                  inline={!summary.length}
                  file={proposal.file}
                  notes={proposal.rationale}
                  lines={editDiff(proposal.currentText ?? "", proposal.proposedText ?? "")}
                />
              </div>
            </DisclosureBody>
          </div>
        );
      })}
      <footer className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <span className="text-chat-sub text-ink-3">{SUGGESTION_WORDS.selected(included.length, proposals.length)}</span>
        <span className="flex items-center gap-1.5">
          <Button variant="ghost" disabled={busy || included.length === 0} onClick={() => onDiscard(included)}>
            {SUGGESTION_WORDS.discard}
          </Button>
          <Button variant="default" disabled={busy || included.length === 0} onClick={() => onApply(included)}>
            {SUGGESTION_WORDS.apply(included.length)}
          </Button>
        </span>
      </footer>
    </section>
  );
}
