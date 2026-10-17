/** The Builds tab's state inks: a step's glyph and the card's status. Colour means state and nothing else. */
import type { JSX, ReactNode } from "react";
import { STATE_TONE, StepState, Tone } from "../../run-steps.ts";
import { Icon, type IconName } from "../../ui/icons.tsx";

/** The ink of each state; colour means state and nothing else. */
export const TONE: Record<Tone, string> = {
  [Tone.Green]: "var(--green)",
  [Tone.Red]: "var(--red)",
  [Tone.Accent]: "var(--accent)",
  [Tone.Orange]: "var(--orange)",
  [Tone.Muted]: "var(--ink-3)",
};

/** The slow pulse of anything still being worked on or looked at. */
export const WORKING_PULSE = "gate-pulse 1.6s ease-in-out infinite";

/** A dot is this fraction of the glyph size it stands in for. */
const DOT_SCALE = 0.6;

/** The finished states draw a glyph; the others are a dot, pulsing while work is in hand. */
const STATE_ICON: Partial<Record<StepState, { name: IconName; strokeWidth: number }>> = {
  [StepState.InBuild]: { name: "check", strokeWidth: 2.6 },
  [StepState.Kept]: { name: "check", strokeWidth: 2.6 },
  [StepState.Delivered]: { name: "check", strokeWidth: 2.6 },
  [StepState.Undone]: { name: "undo", strokeWidth: 2.4 },
  [StepState.NotInBuild]: { name: "stop", strokeWidth: 2.4 },
  [StepState.NotDelivered]: { name: "stop", strokeWidth: 2.4 },
  [StepState.Paused]: { name: "pause", strokeWidth: 2.4 },
};

/** A step's state as one small glyph in its tone. */
export function StateGlyph({ state, size = 10 }: { state: StepState; size?: number }): JSX.Element {
  const tone = TONE[STATE_TONE[state]];
  const icon = STATE_ICON[state];
  if (icon)
    return (
      <span style={{ color: tone }}>
        <Icon name={icon.name} size={size} strokeWidth={icon.strokeWidth} />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size * DOT_SCALE,
        height: size * DOT_SCALE,
        background: tone,
        animation: state === StepState.Waiting ? undefined : WORKING_PULSE,
      }}
    />
  );
}

const STATUS_GLYPH: Partial<Record<Tone, IconName>> = {
  [Tone.Green]: "check",
  [Tone.Red]: "undo",
  [Tone.Muted]: "stop",
};

/** A card's one status in words, its glyph in the state's ink — the same mark the node carries. */
export function Status({
  tone,
  meta = null,
  children,
}: {
  tone: Tone;
  meta?: string | null;
  children: ReactNode;
}): JSX.Element {
  const glyph = STATUS_GLYPH[tone];
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-body-sm text-ink-2">
      <span className="inline-flex shrink-0" style={{ color: TONE[tone] }}>
        {glyph ? (
          <Icon name={glyph} size={11} strokeWidth={2.4} />
        ) : (
          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: "currentColor" }} />
        )}
      </span>
      <span className="truncate">
        {children}
        {meta ? <span className="text-ink-3"> · {meta}</span> : null}
      </span>
    </span>
  );
}
