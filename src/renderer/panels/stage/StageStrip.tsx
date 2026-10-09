/**
 * The stage strip: one addressable row, so a check can prove every control in it stays uniquely
 * labelled — `control.ts` refuses an ambiguous selector at run time. The game's name and folder
 * live in the chat header; the rest of this strip drags the window.
 */
import type { JSX } from "react";
import { SOUND_SHORTCUT } from "../../../shared/game-sound.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import { kindChip } from "../../../shared/shape-words.ts";
import type { BesideTarget } from "../../open-beside.ts";
import type { LiveBehind, StageView } from "../../stage.ts";
import type { GameProject } from "../../types.ts";
import { cn } from "../../ui/cn.ts";
import { Icon } from "../../ui/icons.tsx";
import { Shortcut } from "../../ui/Shortcut.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { ViewSwitcher } from "../../ui/view-switcher.tsx";
import { liveBehindLabel, liveBehindWords, STAGE_WORDS } from "../../words.ts";
import { besideName } from "../FileViewer.tsx";
import type { Notify } from "../../state/toasts.ts";
import { PluginToolbar } from "../PluginToolbar.tsx";
import { LiveRun } from "./live-run.ts";

/** A tab name longer than this is shortened in the middle, keeping this much of its start and end. */
const TAB_NAME_MAX = 26;
const TAB_NAME_HEAD = 14;
const TAB_NAME_TAIL = 10;

/** A tab keeps its width: a long file name is shortened in the middle, the full name is the viewer's title. */
function shortName(name: string): string {
  return name.length > TAB_NAME_MAX ? `${name.slice(0, TAB_NAME_HEAD)}…${name.slice(-TAB_NAME_TAIL)}` : name;
}

/** The view switcher's tabs: Live, Builds once there is a build to draw, Assets, and a file opened beside. */
function viewItems(hasBuilds: boolean, buildsLive: boolean, beside: BesideTarget | null) {
  const label = (key: StageView): string => {
    if (key === "live") return "Live";
    if (key === "assets") return "Assets";
    return `Builds${buildsLive ? " ●" : ""}`;
  };
  const views: StageView[] = ["live", ...(hasBuilds ? ["builds" as const] : []), "assets"];
  return [
    ...views.map((key) => ({ key, label: label(key) })),
    ...(beside
      ? [
          {
            key: "file" as const,
            label: shortName(besideName(beside)),
            icon: <Icon name={beside.kind === "image" ? "image" : "file"} size={13} />,
          },
        ]
      : []),
  ];
}

/**
 * Reload. While Live is behind — the game changed, a build is ready — it carries the accent dot
 * and tint and says what it would bring; Live itself never changes until it is pressed. A new
 * reason breathes the ring once (`key`), except under reduced motion (theme.css).
 */
function ReloadButton({ behind, onReload }: { behind: LiveBehind | null; onReload: () => void }): JSX.Element {
  const label = behind ? liveBehindLabel(behind.reason, behind.note) : "Reload game";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={behind ? `${behind.reason}:${behind.head ?? ""}` : "current"}
          type="button"
          aria-label={label}
          data-stage-reload={behind ? "behind" : ""}
          data-behind-reason={behind?.reason}
          onClick={onReload}
          className={cn(
            "grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors duration-(--duration-quick) enabled:active:scale-[0.96]",
            // The glass's own background would cover the tint, so a lit Reload trades it for the tint.
            // Its glyph takes the ink: the accent on its own tint falls under 3:1, dimmer than unlit.
            behind ? "border border-transparent bg-accent-tint text-ink" : "surface-glass text-foreground",
          )}
        >
          <Icon name="reload" size={15} />
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="right" sideOffset={6} data-stage-reload-tip="">
        {behind ? liveBehindWords(behind.reason) : "Reload game"}
        {behind?.note ? <span className="block max-w-72 opacity-75">{behind.note}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The strip's icon buttons: a 32px glass square with a 15px glyph in the text colour, faded when disabled. */
const STRIP_ICON_BUTTON =
  "surface-glass grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-foreground transition-colors duration-(--duration-quick) enabled:active:scale-[0.96] disabled:cursor-default disabled:opacity-50";

/** What Play/Stop says for each state of the game. */
const RUN_LABEL = {
  [LiveRun.Running]: STAGE_WORDS.stop,
  [LiveRun.Stopping]: STAGE_WORDS.stopping,
  [LiveRun.Stopped]: STAGE_WORDS.play,
  [LiveRun.Starting]: STAGE_WORDS.starting,
} as const satisfies Record<LiveRun, string>;

/** The glyph inside Play/Stop: what a press does, or a spinner while one is under way. */
function RunGlyph({ run }: { run: LiveRun }): JSX.Element {
  if (run === LiveRun.Running) return <Icon name="stop" size={15} />;
  if (run === LiveRun.Stopped) return <Icon name="play" size={15} />;
  return (
    <span className="size-[13px] animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />
  );
}

/** Play/Stop: one button that stops the game (it then costs the machine nothing) and plays it again. */
function RunButton({ run, onToggle }: { run: LiveRun; onToggle: () => void }): JSX.Element {
  const busy = run === LiveRun.Starting || run === LiveRun.Stopping;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={RUN_LABEL[run]}
          aria-busy={busy}
          aria-disabled={busy}
          data-stage-run={run}
          onClick={busy ? undefined : onToggle}
          className={cn(STRIP_ICON_BUTTON, busy && "cursor-default")}
        >
          {/* Keyed by state, so each glyph fades and grows in as it takes the last one's place. */}
          <span key={run} className="grid place-items-center animate-in fade-in-0 zoom-in-75 duration-150">
            <RunGlyph run={run} />
          </span>
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="right" sideOffset={6}>
        {RUN_LABEL[run]}
      </TooltipContent>
    </Tooltip>
  );
}

/** Full screen: the game over the whole screen; holding Esc, or the button in its corner, brings it back. */
function FullScreenButton({ offered, onEnter }: { offered: boolean; onEnter: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={STAGE_WORDS.fullScreen}
          data-stage-full-screen=""
          disabled={!offered}
          onClick={onEnter}
          className={STRIP_ICON_BUTTON}
        >
          <Icon name="expand" size={15} />
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="left" sideOffset={6}>
        {STAGE_WORDS.fullScreen}
      </TooltipContent>
    </Tooltip>
  );
}

/** The Live game's sound: one speaker, crossed out while it is off. */
function SoundButton({ on, onToggle }: { on: boolean; onToggle: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Game sound"
          aria-pressed={on}
          data-stage-sound={on ? "on" : "off"}
          onClick={onToggle}
          className={STRIP_ICON_BUTTON}
        >
          <Icon name={on ? "speaker" : "speaker-off"} size={15} />
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="left" sideOffset={6}>
        <span className="flex items-center gap-2">
          {on ? "Mute game" : "Unmute game"}
          <Shortcut>{SOUND_SHORTCUT}</Shortcut>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The strip over the stage: what the folder is, the view switcher, Play/Stop and Reload, then at
 * its end the game's sound, full screen and plugin buttons. An earlier build opens from its result
 * card in the chat, not from here.
 */
export function StageStrip({
  loaded,
  project,
  hasBuilds,
  buildsLive,
  beside,
  stageView,
  onView,
  behind,
  onReload,
  run,
  fullScreen,
  sound,
  emptyGame,
  plugins,
  onNotice,
  onToolbarOpen,
}: {
  loaded: GameProject | null;
  project: string | null;
  hasBuilds: boolean;
  buildsLive: boolean;
  beside: BesideTarget | null;
  stageView: StageView;
  onView: (view: StageView) => void;
  /** What waits for Live's Reload, when anything does. */
  behind: LiveBehind | null;
  onReload: () => void;
  /** Play/Stop (`live-run.ts`). */
  run: { state: LiveRun; toggle: () => void };
  /** Full screen, offered while the running game is on the stage. */
  fullScreen: { offered: boolean; enter: () => void };
  /** The Live game's sound switch (`game-sound.ts`). */
  sound: { on: boolean; toggle: () => void };
  /** The game has nothing in it yet: no plugin button's action is due. */
  emptyGame: boolean;
  plugins: PluginInfo[];
  onNotice: Notify;
  onToolbarOpen: (open: boolean) => void;
}): JSX.Element {
  return (
    <div
      data-stage-strip=""
      className="titlebar-drag window-controls-end flex min-h-12 max-h-30 shrink-0 flex-wrap items-center gap-2 overflow-auto border-b border-line bg-canvas ps-3 pe-2 py-1.5"
    >
      {/* What this folder is, from its own evidence — so nobody has to guess why the stage is
          showing a built page, and an engine export says so before a run is asked for. */}
      {loaded?.built ? (
        <span
          data-stage-kind={loaded.shape.kind}
          title={`The studio found this and keeps it as it is: ${loaded.shape.main}`}
          className="no-drag shrink-0 rounded-control bg-inset px-1.5 py-0.5 text-micro text-ink-3"
        >
          {kindChip(loaded.shape.kind)}
        </span>
      ) : null}
      {/* One segmented group for every loaded game; Builds joins it once there is a build to
          draw, and Assets is always there — a game with no build still has files. Plugin buttons
          follow it as siblings, so they are there for a game with no build either. */}
      {project ? (
        <ViewSwitcher
          className="no-drag shrink-0"
          label="Game view"
          dataAttribute="data-stage-action"
          items={viewItems(hasBuilds, buildsLive, beside)}
          active={stageView}
          onSelect={onView}
        />
      ) : null}
      {/* Siblings, not a group: every gap between the strip's controls drags the window. */}
      {project ? <RunButton run={run.state} onToggle={run.toggle} /> : null}
      {project ? <ReloadButton behind={behind} onReload={onReload} /> : null}
      <span className="min-w-0 flex-1 self-stretch" />
      {project ? <SoundButton on={sound.on} onToggle={sound.toggle} /> : null}
      {project ? <FullScreenButton offered={fullScreen.offered} onEnter={fullScreen.enter} /> : null}
      <PluginToolbar
        plugins={plugins}
        project={project}
        emptyGame={emptyGame}
        onNotice={onNotice}
        onOpenChange={onToolbarOpen}
      />
    </div>
  );
}
