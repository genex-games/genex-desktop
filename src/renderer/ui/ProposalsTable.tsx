/**
 * The parts Harness Activity shows a change to Studio's own files with: its diff, line by line, a
 * disclosure that turns and opens, and the exact edit one step further in.
 */
import type { JSX, ReactNode } from "react";
import { useId, useState } from "react";
import { type DiffLine, DiffTone } from "../edit-diff.ts";
import { SUGGESTION_WORDS } from "../words.ts";
import { Icon } from "./icons.tsx";

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
