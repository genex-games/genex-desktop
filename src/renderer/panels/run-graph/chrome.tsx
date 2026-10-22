/** The Builds tab's bar of the chat's builds, its Play button, and the zoom pill in the canvas corner. */
import type { JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { RunState } from "../../../shared/run-state.ts";
import { buildWhen, type HistoryEntry, historyLabel, isNewestBuild } from "../../build-progress.ts";
import type { statusLine } from "../../run-steps.ts";
import { Button } from "../../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Elapsed } from "../../ui/LoadingState.tsx";
import { isRovingKey, RovingAxis, rovingTarget } from "../../ui/roving-focus.ts";
import { useMoreBelow } from "../../ui/scroll-fade.ts";
import { StatusOrb } from "../../ui/StatusOrb.tsx";
import { BUILD_TABS_WORDS as WORDS } from "../../words.ts";
import { BuildBarShape, buildBarShape, newestFirst, PLAY_ROOM_PX } from "./bar-shape.ts";

/** The chat's builds as the bar's tabs: which one is on show, and the way to show another. */
export interface BuildTabs {
  /** Oldest first, as `buildHistory` reads them. */
  builds: readonly HistoryEntry[];
  /** The build on show: its key in the history. */
  open: string | null;
  onOpen: (runId: string) => void;
}

/** A tab's name: what the person asked for it, else what the history calls it ("This Loop"). */
function tabName(builds: readonly HistoryEntry[], build: HistoryEntry): string {
  return build.ask || historyLabel(build, { newest: isNewestBuild(builds, build) });
}

/** How a build stands, before its name: the status line's loader while it works, a bare ✓ once done, a dot while paused. */
function TabMark({ state }: { state: string }): JSX.Element {
  if (state === RunState.Running) return <StatusOrb />;
  if (state === RunState.Finished) return <Icon name="check" size={12} strokeWidth={2.6} className="shrink-0" />;
  return <span aria-hidden="true" className="build-tab-dot" />;
}

/** Arrow keys, Home and End move along the tabs and open the tab they land on. */
function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  builds: readonly HistoryEntry[],
  index: number,
  onOpen: (runId: string) => void,
): void {
  if (!isRovingKey(event.key, RovingAxis.Horizontal)) return;
  event.preventDefault();
  const next = rovingTarget(event.key, index, builds.length, RovingAxis.Horizontal) ?? index;
  const target = builds[next];
  if (target) onOpen(target.runId);
  const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs?.[next]?.focus();
}

/** One build's tab: its mark, its name, and while it works its clock, shimmering as the chat's does. */
function BuildTab({
  build,
  name,
  open,
  title,
  onOpen,
  onKeyDown,
}: {
  build: HistoryEntry;
  name: string;
  open: boolean;
  title: string;
  onOpen: (runId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={open}
      tabIndex={open ? 0 : -1}
      data-build-tab={build.runId}
      title={title}
      onClick={() => onOpen(build.runId)}
      onKeyDown={onKeyDown}
      className="build-tab"
    >
      <TabMark state={build.state} />
      <span className="min-w-0 truncate">{name}</span>
      <BuildClock build={build} />
    </button>
  );
}

/** The tabs on one track; the open one is kept in view when the row outgrows the bar. */
function BuildTabTrack({ tabs, said }: { tabs: BuildTabs; said: string }): JSX.Element {
  const { builds, open, onOpen } = tabs;
  const track = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = track.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !tab) return;
    const end = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < row.scrollLeft) row.scrollLeft = tab.offsetLeft;
    else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth;
  }, [open, builds.length]);
  return (
    <div ref={track} role="tablist" aria-label={WORDS.tabs} className="build-tabs surface-glass">
      {builds.map((build, index) => {
        const name = tabName(builds, build);
        const isOpen = build.runId === open;
        return (
          <BuildTab
            key={build.runId}
            build={build}
            name={name}
            open={isOpen}
            title={isOpen ? `${name}\n${said}` : name}
            onOpen={onOpen}
            onKeyDown={(event) => moveTab(event, builds, index, onOpen)}
          />
        );
      })}
    </div>
  );
}

/** A working build's clock, shimmering as the chat's does; nothing once it stops. */
function BuildClock({ build }: { build: HistoryEntry }): JSX.Element | null {
  if (build.state !== RunState.Running || build.since === null) return null;
  return (
    <span className="build-tab-clock chat-status-shimmer">
      <Elapsed since={build.since} />
    </span>
  );
}

/** One build in the picker's list: its mark, its whole name on one line, and when it started (its clock while it works). */
function BuildRow({ build, name }: { build: HistoryEntry; name: string }): JSX.Element {
  return (
    <DropdownMenuRadioItem
      indicator={false}
      value={build.runId}
      data-build-row={build.runId}
      title={name}
      className="build-row"
    >
      <span className="build-row-mark">
        <TabMark state={build.state} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {build.state === RunState.Running && build.since !== null ? (
        <BuildClock build={build} />
      ) : (
        <span className="build-row-when">{buildWhen(build.startedAt)}</span>
      )}
    </DropdownMenuRadioItem>
  );
}

/**
 * On opening, the list shows the open build's row: scrolled into view above the fade, and focused
 * when the list was opened from the keyboard, so the arrows go on from there. `attach` is the
 * list's ref, which also keeps its fade on while more rows lie below.
 */
function useOpenRowShown() {
  const list = useRef<HTMLDivElement | null>(null);
  const moreBelow = useMoreBelow<HTMLDivElement>();
  // One callback for the list's life: an inline one would re-attach the fade's watchers on every render.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      list.current = node;
      const detach = moreBelow(node);
      return () => {
        list.current = null;
        if (typeof detach === "function") detach();
      };
    },
    [moreBelow],
  );
  const byKeyboard = useRef(false);
  const onOpenChange = (isOpen: boolean): void => {
    if (!isOpen) return;
    // A frame later Radix has mounted the list and focused it (or its first row); take over from there.
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>('[data-state="checked"]');
      row?.scrollIntoView({ block: "nearest" });
      if (byKeyboard.current) row?.focus({ preventScroll: true });
    });
  };
  const trigger = {
    onPointerDown: (): void => {
      byKeyboard.current = false;
    },
    onKeyDown: (): void => {
      byKeyboard.current = true;
    },
  };
  return { attach, onOpenChange, trigger };
}

/**
 * Past three builds (or with too little room for three readable tabs) the bar holds one picker: the
 * open build's mark, whole name and clock, then ⌄ and how many builds the chat has. Its list drops
 * under it, newest first, the open build's row filled.
 */
function BuildPicker({ tabs, said }: { tabs: BuildTabs; said: string }): JSX.Element {
  const { builds, open, onOpen } = tabs;
  const shown = builds.find((build) => build.runId === open) ?? builds.at(-1);
  const name = shown ? tabName(builds, shown) : "";
  const { attach, onOpenChange, trigger } = useOpenRowShown();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          {...trigger}
          data-build-picker={shown?.runId}
          title={`${name}\n${said}`}
          aria-label={WORDS.picker(name, builds.length)}
          className="build-picker surface-glass"
        >
          {shown ? <TabMark state={shown.state} /> : null}
          <span className="min-w-0 truncate">{name}</span>
          {shown ? <BuildClock build={shown} /> : null}
          <span className="build-picker-count">
            <Icon name="chevron-down" size={14} />
            {builds.length}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={attach} align="start" className="build-picker-menu">
        <DropdownMenuRadioGroup value={open ?? ""} onValueChange={onOpen}>
          {newestFirst(builds).map((build) => (
            <BuildRow key={build.runId} build={build} name={tabName(builds, build)} />
          ))}
        </DropdownMenuRadioGroup>
        <span aria-hidden="true" data-list-fade className="build-picker-fade" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An element's width, kept as it resizes; unbounded until it is first measured. */
function useRoom(): [number, (element: HTMLElement | null) => (() => void) | undefined] {
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    let frame = 0;
    // The width is taken a frame later: set inside the observer's callback, it can swap the tabs for
    // the picker and resize the bar again in the same frame, which Chromium reports as a renderer
    // error ("ResizeObserver loop completed with undelivered notifications") on a slower machine.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRoom(element.clientWidth));
    });
    observer.observe(element);
    setRoom(element.clientWidth);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return [room, measure];
}

/**
 * When the bar swaps its tabs for the picker (or back) while one of them has focus, focus goes to
 * the control that takes its place instead of falling to the page.
 */
function useFocusFollows(slot: RefObject<HTMLDivElement | null>, picker: boolean): void {
  const shown = useRef(picker);
  const follow = useRef(false);
  if (shown.current !== picker) {
    // Read while rendering, before the swap takes the focused control out of the page.
    follow.current = Boolean(slot.current?.contains(document.activeElement));
    shown.current = picker;
  }
  useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    const next = picker ? "[data-build-picker]" : '[role="tab"][aria-selected="true"]';
    slot.current?.querySelector<HTMLElement>(next)?.focus();
  }, [picker, slot]);
}

/**
 * The bar over the graph: the chat's builds and Play. Up to three builds are tabs on one track, the
 * newest on the right; more, or a panel too narrow for their names, are one picker. Play keeps
 * its place at the right end whatever the left holds. The open build's status ("Building · 9 of
 * 30 min · 2 parts working") is its tab's or the picker's tooltip and what a screen reader hears.
 */
export function BuildStatus({
  status,
  tabs,
  action,
}: {
  status: ReturnType<typeof statusLine>;
  tabs: BuildTabs;
  action: ReactNode;
}): JSX.Element {
  const said = status.rest ? `${status.strong} · ${status.rest}` : status.strong;
  const [width, measure] = useRoom();
  const picker = buildBarShape(tabs.builds.length, width - PLAY_ROOM_PX) === BuildBarShape.Picker;
  const slot = useRef<HTMLDivElement>(null);
  useFocusFollows(slot, picker);
  return (
    <div
      ref={measure}
      data-testid="build-status"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2"
    >
      <div ref={slot} className="flex min-w-0 flex-1 items-center">
        {picker ? <BuildPicker tabs={tabs} said={said} /> : <BuildTabTrack tabs={tabs} said={said} />}
      </div>
      {action}
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}

/** Play the run's build in Live; it says Opening… until Live has it. */
export function PlayButton({
  label,
  quiet = false,
  onPlay,
}: {
  label: string;
  quiet?: boolean;
  onPlay: () => Promise<void> | void;
}): JSX.Element {
  const [opening, setOpening] = useState(false);
  return (
    <Button
      variant={quiet ? "secondary" : "default"}
      disabled={opening}
      onClick={async () => {
        setOpening(true);
        try {
          await onPlay();
        } finally {
          setOpening(false);
        }
      }}
    >
      <Icon name="play" size={13} />
      {opening ? t("Opening…") : label}
    </Button>
  );
}

const ICON_BUTTON =
  "inline-flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";
const TEXT_BUTTON =
  "h-[26px] cursor-pointer rounded-[7px] px-2.5 font-mono text-xs text-ink-2 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";

/** Zoom out, the zoom level, zoom in, fit everything, and — while a run is live — jump back to its work. */
export function ZoomPill({
  pct,
  onOut,
  onIn,
  onFit,
  onNow,
}: {
  pct: number;
  onOut: () => void;
  onIn: () => void;
  onFit: () => void;
  onNow: (() => void) | null;
}): JSX.Element {
  return (
    <div
      className="absolute bottom-3 left-3 z-[3] flex h-8 items-center gap-0.5 rounded-[11px] bg-surface px-[3px] shadow-card"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label={t("Zoom out")} title={t("Zoom out")} className={ICON_BUTTON} onClick={onOut}>
        <Icon name="minus" size={13} />
      </button>
      <span
        className="w-10 text-center font-mono text-xs text-ink-3 tabular-nums"
        aria-label={t("Zoom {percent}%", { percent: pct })}
      >
        {pct}%
      </span>
      <button type="button" aria-label={t("Zoom in")} title={t("Zoom in")} className={ICON_BUTTON} onClick={onIn}>
        <Icon name="plus" size={13} />
      </button>
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line-strong" />
      <button type="button" title={t("Fit everything (0)")} className={TEXT_BUTTON} onClick={onFit}>
        {t("Fit")}
      </button>
      {onNow ? (
        <button type="button" className={`${TEXT_BUTTON} text-accent-ink`} onClick={onNow}>
          {t("Jump to now")}
        </button>
      ) : null}
    </div>
  );
}
