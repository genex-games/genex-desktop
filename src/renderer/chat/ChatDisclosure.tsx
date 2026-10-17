import { useId, useRef, useState, type ReactNode, type HTMLAttributes } from "react";
import { Icon } from "../ui/icons.tsx";
import { useSteadyLabel, useTextFade, useWidthGlide } from "../ui/label-motion.ts";
import { Presence } from "../ui/Presence.tsx";

/** Shared reading and expansion grammar for work, outcomes and learning: the body opens and closes in place. */
export function ChatDisclosure({
  label,
  children,
  lead,
  suffix,
  open: controlled,
  onToggle,
  frame = true,
  triggerLabel,
  wraps = false,
  className = "",
  ...props
}: {
  label: ReactNode;
  children: ReactNode;
  /** What leads the heading, before its words (a work group's plugin icons). */
  lead?: ReactNode;
  suffix?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  frame?: boolean;
  triggerLabel?: string;
  /** Words that must be read whole (a judge's verdict) wrap instead of trailing off. */
  wraps?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "onToggle">) {
  const [expanded, setExpanded] = useState(false);
  const open = controlled ?? expanded;
  const id = useId();
  // New words ("Worked on 3 steps") stay a second before the next, and fade in as the label's width
  // glides to them, the chevron along.
  const labelBox = useRef<HTMLSpanElement>(null);
  const words = useSteadyLabel(typeof label === "string" ? label : "");
  useTextFade(labelBox, words);
  useWidthGlide(labelBox, words);
  return (
    <div {...props} className={`min-w-0 text-chat text-ink-2 ${className}`}>
      <button
        type="button"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle ?? (() => setExpanded((value) => !value))}
        className="chat-disclosure"
        data-wraps={wraps || undefined}
      >
        {lead}
        <span ref={labelBox} className={wraps ? "min-w-0 [text-wrap:pretty]" : "min-w-0 truncate"}>
          {typeof label === "string" ? words : label}
        </span>
        {suffix}
        <Icon name="chevron-right" size={14} className={`chat-chevron ${open ? "rotate-90" : ""}`} />
      </button>
      <Presence>
        {open
          ? [
              {
                key: "body",
                node: (
                  <div id={id} className={frame ? "chat-tool-frame" : undefined}>
                    {children}
                  </div>
                ),
              },
            ]
          : []}
      </Presence>
    </div>
  );
}
