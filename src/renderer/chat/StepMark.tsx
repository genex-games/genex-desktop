/** The round mark beside a line of the chat's step lists: ticked once its step is done, an empty ring before. */
import type { JSX } from "react";
import { Icon } from "../ui/icons.tsx";

/** A step's mark: a tick on the accent's tint when done, else an empty ring. Decorative; the words say it. */
export function StepMark({ done }: { done: boolean }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${done ? "bg-accent-primary/12 text-accent-ink" : "border border-line"}`}
    >
      {done ? <Icon name="check" size={11} /> : null}
    </span>
  );
}
