import {
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { t } from "../../shared/i18n.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { Icon } from "./icons.tsx";
import { effortLabel } from "./ModelMenu.tsx";

const HELP = t(
  "How long models think before they act. One setting for the main agent, workers and reviewers; each model uses the closest level it supports.",
);

/** The effort slider's keys: arrows and Page keys step one stop, Home and End jump to the ends. */
const SLIDER_STEPS: ReadonlyMap<string, number> = new Map([
  ["ArrowLeft", -1],
  ["ArrowDown", -1],
  ["PageDown", -1],
  ["ArrowRight", 1],
  ["ArrowUp", 1],
  ["PageUp", 1],
]);

/** The stop a key moves the slider to (unclamped; the pick clamps it), or null for any other key. */
function sliderTarget(key: string, index: number, last: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return last;
  const step = SLIDER_STEPS.get(key);
  return step === undefined ? null : index + step;
}

/** One effort for every role, chosen on a Faster–Smarter scale of the orchestrator's own levels. */
export function ComposerEffort({
  efforts,
  value,
  onChange,
  disabled = false,
  onClosed,
}: {
  efforts: string[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  onClosed?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const slider = useRef<HTMLDivElement>(null);
  const [first] = efforts;
  if (first === undefined) return null;
  const current = value && efforts.includes(value) ? value : first;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClosed?.();
      }}
    >
      <PopoverTrigger
        render={<button type="button" />}
        disabled={disabled}
        aria-label={t("Effort: {effort}", { effort: effortLabel(current) })}
        className="composer-text-button composer-effort shrink-0"
      >
        {effortLabel(current)}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="picker-panel w-[280px] max-w-(--available-width) px-3 pt-2.5 pb-3"
        aria-label={t("Effort")}
        initialFocus={slider}
      >
        <div className="effort-head">
          <span className="text-ink-3">{t("Effort")}</span>
          <span>{effortLabel(current)}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="effort-help" aria-label={t("About effort")}>
                <Icon name="help" size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-[240px]">
              {HELP}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="effort-ends" aria-hidden>
          <span>{t("Faster")}</span>
          <span>{t("Smarter")}</span>
        </div>
        <EffortSlider track={slider} efforts={efforts} value={current} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

/** A stepped slider: a stop per level, the thumb snaps to the nearest, arrows move one level. */
function EffortSlider({
  track,
  efforts,
  value,
  onChange,
}: {
  track: RefObject<HTMLDivElement | null>;
  efforts: string[];
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const index = Math.max(0, efforts.indexOf(value));
  const last = efforts.length - 1;
  const at = (step: number) => (last ? step / last : 0.5);
  const pick = (step: number) => {
    const next = efforts[Math.max(0, Math.min(last, step))];
    if (next !== undefined && next !== value) onChange(next);
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !last) return;
    // The thumb's centre travels between the first and last stop, which sit half a thumb inside the track.
    const inset = 13,
      span = Math.max(1, rect.width - inset * 2);
    pick(Math.round(((event.clientX - rect.left - inset) / span) * last));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = sliderTarget(event.key, index, last);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    pick(target);
  };
  return (
    <div
      ref={track}
      className="effort-track"
      data-effort-slider
      role="slider"
      tabIndex={0}
      aria-label={t("Effort")}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={effortLabel(value)}
      onKeyDown={keys}
      style={{ "--effort-at": at(index) } as CSSProperties}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
      }}
    >
      <span className="effort-fill" aria-hidden />
      {efforts.map((level, step) => (
        <span
          key={level}
          className="effort-stop"
          data-passed={step < index || undefined}
          style={{ "--effort-at": at(step) } as CSSProperties}
          aria-hidden
        />
      ))}
      <span className="effort-thumb" aria-hidden />
    </div>
  );
}
