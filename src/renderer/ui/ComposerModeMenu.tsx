import { useState } from "react";
import { t } from "../../shared/i18n.ts";
import type { LoopSetting } from "../loop-setting.ts";
import { UNREAL_WORDS } from "../words.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { PickerCaption, PickerSegmented, pickerItem } from "./PickerPanel.tsx";
import { Icon } from "./icons.tsx";
import {
  durationText,
  formatDuration,
  limitWords,
  MAX_LOOP_MINUTES,
  MIN_LOOP_MINUTES,
  MINUTES_PER_HOUR,
  parseDuration,
  shortDuration,
} from "./loop-duration.ts";

const PRESETS = [0.5, 1, 2];
const STEP_MINUTES = 15;
/** Custom opens on this many hours when no limit was set. */
const CUSTOM_START = 3;

/** The Loop control's segments besides the presets (whose value is their hours). */
const LoopChoice = {
  Off: "off",
  UntilSatisfied: "inf",
  Custom: "custom",
} as const;
type Choice = (typeof LoopChoice)[keyof typeof LoopChoice] | `${number}`;

/** The segment the Loop control shows: off, no time limit, a preset, or custom. */
function loopChoice(loopOn: boolean, hours: number | null, custom: boolean): Choice {
  if (!loopOn) return LoopChoice.Off;
  if (hours === null) return LoopChoice.UntilSatisfied;
  return custom || !PRESETS.includes(hours) ? LoopChoice.Custom : `${hours}`;
}

/** The Loop a pick sets, from the one it replaces: Off keeps the saved time, Custom starts from it. */
function chosenLoop(next: Choice, current: LoopSetting): LoopSetting {
  if (next === LoopChoice.Off) return { ...current, on: false };
  if (next === LoopChoice.UntilSatisfied) return { on: true, hours: null };
  // Custom starts from the current time limit, so fine-tuning a preset is one click away.
  if (next === LoopChoice.Custom) return { on: true, hours: current.hours ?? CUSTOM_START };
  return { on: true, hours: Number(next) };
}

/**
 * What the menu says about the Loop: its state, its caption, and the trigger's label with the
 * compact time limit before it. Off, the trigger says Auto; on, it says ∞ Loop or, say, 2h Loop.
 * Loop allows a build and never orders one: the agent makes a small change itself.
 */
function loopWords(loopOn: boolean, minutes: number | null) {
  if (!loopOn) return { state: t("Off"), caption: t("Does what you ask, then stops."), label: "Auto", time: null };
  if (minutes === null)
    return {
      state: t("No time limit"),
      caption: t("A team of AIs builds and tests your idea until it’s done."),
      label: "Loop",
      time: null,
    };
  const limit = limitWords(minutes);
  return {
    state: limit,
    caption: t("A team of AIs builds and tests your idea for up to {limit}.", { limit }),
    label: "Loop",
    time: shortDuration(minutes),
  };
}

/** The custom limit's stepper: fifteen minutes either way, or a time typed in. */
function CustomLimit({
  minutes,
  draft,
  onDraft,
  onCommit,
  onMinutes,
}: {
  minutes: number;
  draft: string | null;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onMinutes: (minutes: number) => void;
}) {
  return (
    <div className="picker-stepper picker-expand">
      <button
        type="button"
        aria-label={t("15 minutes less")}
        disabled={minutes <= MIN_LOOP_MINUTES}
        onClick={() => onMinutes(minutes - STEP_MINUTES)}
      >
        <Icon name="minus" />
      </button>
      <input
        type="text"
        aria-label={t("Custom time limit")}
        value={draft ?? formatDuration(minutes)}
        spellCheck={false}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
      />
      <button
        type="button"
        aria-label={t("15 minutes more")}
        disabled={minutes >= MAX_LOOP_MINUTES}
        onClick={() => onMinutes(minutes + STEP_MINUTES)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** The Loop's segments: Off, ∞, the presets and Custom. While the game can't run a Loop, only Off can be picked. */
function loopOptions(unavailable: boolean) {
  const loop = { disabled: unavailable };
  return [
    { value: LoopChoice.Off, label: t("Off") },
    {
      value: LoopChoice.UntilSatisfied,
      // The prompt bar's own ∞, which mono would draw flat; the hidden ∞ is its text.
      label: (
        <>
          <Icon name="infinity" />
          <span className="sr-only">∞</span>
        </>
      ),
      title: t("No time limit"),
      ...loop,
    },
    { value: "0.5" as const, label: durationText(30), ...loop },
    { value: "1" as const, label: durationText(MINUTES_PER_HOUR), ...loop },
    { value: "2" as const, label: durationText(2 * MINUTES_PER_HOUR), ...loop },
    { value: LoopChoice.Custom, label: t("Custom"), ...loop },
  ];
}

/**
 * One Loop control: Off, no time limit, a preset or a custom time. Without `onChange` the
 * Loop is shown, not changed (a build already owns it). With `loopUnavailable` (a game whose
 * engine needs its project in the game folder and finds it elsewhere) it shows Off, offers Off
 * alone and says why. Plan mode lives in Add (`ComposerAddMenu`).
 */
export function ComposerModeMenu({
  value,
  onChange,
  disabled,
  loopUnavailable = false,
  unavailableWhy,
}: {
  value: LoopSetting;
  onChange?: (next: LoopSetting) => void;
  disabled?: boolean;
  loopUnavailable?: boolean;
  /** Why there is no Loop, when the game can say (its project and where it is). */
  unavailableWhy?: string;
}) {
  const { on: loopOn, hours } = value;
  const timed = hours !== null;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const choice = loopChoice(loopOn, hours, custom);
  const minutes = timed ? Math.round(hours * MINUTES_PER_HOUR) : null;
  // One setting per pick: two setters in a row would lose the first to a stale closure.
  const pick = (next: Choice) => {
    // Off is already the Loop shown, and a pick would overwrite the one the chat keeps for later.
    if (loopUnavailable) return;
    setDraft(null);
    setCustom(next === LoopChoice.Custom);
    onChange?.(chosenLoop(next, value));
  };
  const setMinutes = (minutesNow: number) => {
    setDraft(null);
    const clamped = Math.min(MAX_LOOP_MINUTES, Math.max(MIN_LOOP_MINUTES, minutesNow));
    onChange?.({ ...value, hours: clamped / MINUTES_PER_HOUR });
  };
  const commit = () => {
    if (draft === null) return;
    const parsed = parseDuration(draft);
    if (parsed !== null) setMinutes(parsed);
    else setDraft(null);
  };
  const { state, caption, label, time } = loopWords(loopOn, minutes);
  const customLimit = choice === LoopChoice.Custom ? minutes : null;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          const customHours = loopOn && timed && !PRESETS.includes(hours);
          setCustom(customHours);
          setDraft(null);
        }
      }}
    >
      <PopoverTrigger
        render={<button type="button" />}
        aria-label={t("Mode")}
        disabled={disabled}
        className="composer-text-button composer-mode shrink-0"
        data-announce
      >
        {/* ∞ mounts as it is picked, so it draws itself once (data-announce); a limit leads with its time.
            Either gives way when the model's name needs the room (`toolbar-fit.ts`). */}
        {loopOn && !timed && <Icon name="infinity" className="composer-mode-limit" />}
        {time && (
          <>
            <span className="composer-mode-time composer-mode-limit">{time}</span>{" "}
          </>
        )}
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="picker-panel mode-panel w-[376px] max-w-(--available-width) p-1.5"
        aria-label={t("Mode options")}
      >
        <div className={pickerItem}>
          <span className="flex-1">{t("Loop mode")}</span>
          <span className="text-[12px] leading-4 text-ink-3">{state}</span>
        </div>
        <div className="px-1 pb-1">
          {onChange && (
            <PickerSegmented<Choice>
              label={t("Loop time limit")}
              value={choice}
              onChange={pick}
              options={loopOptions(loopUnavailable)}
            />
          )}
          {onChange && customLimit !== null && (
            <CustomLimit
              minutes={customLimit}
              draft={draft}
              onDraft={setDraft}
              onCommit={commit}
              onMinutes={setMinutes}
            />
          )}
          <PickerCaption>
            {loopUnavailable ? (unavailableWhy ?? UNREAL_WORDS.loopUnavailable(null, "")) : caption}
          </PickerCaption>
        </div>
      </PopoverContent>
    </Popover>
  );
}
