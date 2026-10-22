/**
 * The composer's permissions pill: Claude Code's permission modes for this chat, in its own order
 * and words. Digits pick while the panel is open, as in Claude Code's menu. Every engine has the
 * pill; a mode the chat's engine does not honour stays in the list, unavailable, with the reason
 * (`unavailableModeReason`). Bypass asks once more: nothing stops it outside the game folder, and
 * Rewind brings back only that folder (the words name this Mac, or this computer elsewhere:
 * `bypassPermissionsWords`).
 */
import { type KeyboardEvent, type RefObject, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import {
  permissionModeWords,
  PERMISSION_MODES,
  PermissionMode,
  type PermissionMode as PermissionModeType,
  UnavailableModeReason,
  unavailableModeReason,
} from "../../shared/permissions.ts";
import { EngineId, providerInfo } from "../../shared/providers.ts";
import { hostPlatform } from "../platform.ts";
import { bypassPermissionsWords } from "../words.ts";
import { Button } from "./Button.tsx";
import { DialogSurface } from "./dialog.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { cn } from "./cn.ts";
import { ComposerTip, PickerLabel, pickerRow } from "./PickerPanel.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { RovingAxis, rovingTarget } from "./roving-focus.ts";
import { Shortcut } from "./Shortcut.tsx";

/** The pill's and the panel's own words. */
const WORDS = {
  permissions: t("Permissions"),
  panel: t("Permission modes"),
  autoTip: t("Auto permissions"),
  autoUnavailableTip: t("Auto isn’t available for this model, so Claude asks first"),
  autoUnavailable: t("Not on this plan or model"),
  sandboxedAuto: t("Never asks, stays sandboxed"),
  recommended: t("Recommended"),
  bypassTitle: t("Bypass permissions?"),
  cancel: t("Cancel"),
  bypass: t("Bypass permissions"),
} as const;

/**
 * Why the chat's engine does not honour a mode, naming the engine. The row is already dimmed, so
 * its one line says only why. Every description fits one line of the 360px panel (about 30
 * characters); a longer one is cut with an ellipsis and shown whole on hover.
 */
const UNAVAILABLE_WORDS: Record<UnavailableModeReason, (engine: string) => string> = {
  [UnavailableModeReason.CannotAsk]: (engine) => t("{engine} can’t stop to ask yet", { engine }),
  [UnavailableModeReason.AlwaysSandboxed]: (engine) => t("{engine} always uses its sandbox", { engine }),
};

/** What a mode does where the chat's engine works otherwise than Claude Code, by engine. */
const ENGINE_MODE_WORDS: Partial<Record<string, Partial<Record<PermissionModeType, string>>>> = {
  [EngineId.Codex]: {
    [PermissionMode.Auto]: t("Game folder only, no network"),
    [PermissionMode.Bypass]: t("Runs outside its sandbox"),
  },
};

/** One glyph per mode, so the pill says which one is on even where the bar has no room for words. */
const MODE_ICONS: Record<PermissionModeType, IconName> = {
  [PermissionMode.Auto]: "shield",
  [PermissionMode.Manual]: "help",
  [PermissionMode.AcceptEdits]: "rename",
  [PermissionMode.Plan]: "plan",
  [PermissionMode.Bypass]: "shield-off",
};

/** The rows of the panel that can be picked, by their mode. */
const MODE_ROW = "[data-permission-mode]:not(:disabled)";
const DIGIT = /^[1-9]$/;

/** Up/Down/Home/End move focus between the rows, like a menu. */
function moveFocus(event: KeyboardEvent<HTMLElement>): boolean {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(MODE_ROW)];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next = rovingTarget(event.key, index, rows.length, RovingAxis.Vertical);
  if (next === null || !rows.length) return false;
  event.preventDefault();
  rows[next]?.focus();
  return true;
}

/** The mode a digit picks while the panel is open, or none: never one the engine does not honour. */
function digitMode(event: KeyboardEvent<HTMLElement>, engine: string): PermissionModeType | undefined {
  const modified = event.metaKey || event.ctrlKey || event.altKey;
  if (modified || !DIGIT.test(event.key)) return undefined;
  const mode = PERMISSION_MODES[Number(event.key) - 1];
  return mode && !unavailableModeReason(engine, mode) ? mode : undefined;
}

/** What a mode does on the chat's engine: its own words where it works otherwise than Claude Code. */
function modeDescription(option: PermissionModeType, engine: string, autoUnavailable: boolean): string {
  const own = ENGINE_MODE_WORDS[engine]?.[option];
  if (own) return own;
  if (option !== PermissionMode.Auto) return permissionModeWords()[option].description;
  if (engine !== EngineId.ClaudeCode) return WORDS.sandboxedAuto;
  return autoUnavailable ? WORDS.autoUnavailable : permissionModeWords()[option].description;
}

/** Why the chat's engine does not honour a mode, in the menu's words, or null when it does. */
function unavailableWords(option: PermissionModeType, engine: string): string | null {
  const reason = unavailableModeReason(engine, option);
  return reason ? UNAVAILABLE_WORDS[reason](providerInfo(engine)?.label ?? engine) : null;
}

/** What the pill says the mode is: Auto by its tooltip alone, any other mode by name. */
function pillLabel(mode: PermissionModeType, autoUnavailable: boolean): string {
  if (mode !== PermissionMode.Auto) return permissionModeWords()[mode].label;
  return autoUnavailable ? WORDS.autoUnavailableTip : WORDS.autoTip;
}

/**
 * One mode's row: its glyph, its name (Auto is recommended), what it does on the chat's engine (or
 * why that engine does not honour it) on one line, and at the end its digit, or a check when it
 * is on. The glyph and the end sit on the name's line.
 */
function ModeRow({
  option,
  index,
  current,
  autoUnavailable,
  engine,
  onPick,
}: {
  option: PermissionModeType;
  index: number;
  current: boolean;
  autoUnavailable: boolean;
  engine: string;
  onPick: (mode: PermissionModeType) => void;
}) {
  const words = permissionModeWords()[option];
  const auto = option === PermissionMode.Auto;
  const unavailable = unavailableWords(option, engine);
  const description = unavailable ?? modeDescription(option, engine, autoUnavailable);
  const digit = String(index + 1);
  return (
    <button
      type="button"
      data-permission-mode={option}
      aria-pressed={current}
      aria-keyshortcuts={unavailable ? undefined : digit}
      disabled={unavailable !== null}
      className={cn(pickerRow, "items-start")}
      onClick={() => onPick(option)}
    >
      <span className="flex h-5 shrink-0 items-center">
        <Icon name={MODE_ICONS[option]} className={option === PermissionMode.Bypass ? "text-orange" : "text-ink-2"} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <span className="truncate">{words.label}</span>
          {auto && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-[6px] bg-accent-tint px-1.5 font-mono text-micro text-[color-mix(in_srgb,var(--accent-ink)_70%,var(--ink))]">
              {WORDS.recommended}
            </span>
          )}
        </span>
        <span data-permission-description title={description} className="truncate text-chat-sub text-ink-3">
          {description}
        </span>
      </span>
      {/* The end holds the digit, or the check on the mode that is on; an unavailable row keeps its room. */}
      <span className="flex h-5 min-w-[22px] shrink-0 items-center justify-center text-ink-3">
        {current && <Icon name="check" className="text-ink" />}
        {!current && !unavailable && (
          <span aria-hidden>
            <Shortcut>{digit}</Shortcut>
          </span>
        )}
      </span>
    </button>
  );
}

/** Bypass asks once more; Cancel has the focus. */
function BypassConfirm({
  trigger,
  onCancel,
  onConfirm,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <DialogSurface
      title={WORDS.bypassTitle}
      initialFocus={cancel}
      returnFocus={trigger}
      description={bypassPermissionsWords(hostPlatform())}
      onDismiss={onCancel}
    >
      <div className="flex justify-end gap-2">
        <Button ref={cancel} variant="ghost" onClick={onCancel}>
          {WORDS.cancel}
        </Button>
        <Button data-bypass-confirm variant="destructive" onClick={onConfirm}>
          {WORDS.bypass}
        </Button>
      </div>
    </DialogSurface>
  );
}

/**
 * The panel stays over the chat: beside it the native game would cover whatever spilled over. Its
 * boundary is the page left of the prompt bar's right edge.
 */
function chatSide(trigger: HTMLElement | null) {
  const bar = trigger?.closest("[data-promptbar]")?.getBoundingClientRect();
  return bar ? { x: 0, y: 0, width: Math.ceil(bar.right) + 1, height: window.innerHeight } : undefined;
}

/** The permission modes for this chat, as its engine honours them. */
export function ComposerPermissionMenu({
  mode,
  onMode,
  autoUnavailable = false,
  engine,
  disabled = false,
}: {
  mode: PermissionModeType;
  onMode: (mode: PermissionModeType) => void;
  autoUnavailable?: boolean;
  /** The chat's engine (`EngineId`): the modes it does not honour are listed, unavailable. */
  engine: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The confirmation takes focus from the closing panel; the trigger gets it back after.
  const asking = useRef(false);
  const pick = (next: PermissionModeType): void => {
    asking.current = next === PermissionMode.Bypass && next !== mode;
    setOpen(false);
    if (asking.current) setConfirming(true);
    else if (next !== mode) onMode(next);
  };
  const settle = (bypass: boolean): void => {
    asking.current = false;
    setConfirming(false);
    if (bypass) onMode(PermissionMode.Bypass);
  };
  const label = pillLabel(mode, autoUnavailable);
  // Auto and Bypass need no words: their shields (Bypass's in orange) and the tooltip say it. Any
  // other mode is a choice the person made, so the pill names it while the bar has room (theme.css).
  const quiet = mode === PermissionMode.Auto || mode === PermissionMode.Bypass;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <ComposerTip hidden={open || confirming} align="start" content={label}>
          <PopoverTrigger
            ref={trigger}
            render={<button type="button" />}
            aria-label={WORDS.permissions}
            aria-description={label}
            disabled={disabled}
            data-mode={mode}
            className={`composer-text-button composer-permission ${quiet ? "shrink-0" : "min-w-0"}`}
          >
            <Icon name={MODE_ICONS[mode]} />
            {!quiet && (
              <span data-fit className="composer-permission-label truncate">
                {label}
              </span>
            )}
          </PopoverTrigger>
        </ComposerTip>
        <PopoverContent
          ref={setPanel}
          side="top"
          align="start"
          sideOffset={8}
          collisionBoundary={chatSide(trigger.current)}
          collisionAvoidance={{ side: "none", align: "shift" }}
          className="picker-panel w-[360px] max-w-(--available-width) p-1.5"
          aria-label={WORDS.panel}
          initialFocus={() => panel?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? true}
          finalFocus={() => !asking.current}
          onKeyDown={(event) => {
            if (moveFocus(event)) return;
            const chosen = digitMode(event, engine);
            if (!chosen) return;
            event.preventDefault();
            pick(chosen);
          }}
        >
          <PickerLabel first>{WORDS.permissions}</PickerLabel>
          {PERMISSION_MODES.map((option, index) => (
            <ModeRow
              key={option}
              option={option}
              index={index}
              current={option === mode}
              autoUnavailable={autoUnavailable}
              engine={engine}
              onPick={pick}
            />
          ))}
        </PopoverContent>
      </Popover>
      {confirming && <BypassConfirm trigger={trigger} onCancel={() => settle(false)} onConfirm={() => settle(true)} />}
    </>
  );
}
