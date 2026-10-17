/**
 * The stage strip: one addressable row, so a check can prove every control in it stays uniquely
 * labelled — `control.ts` refuses an ambiguous selector at run time. The game's name and folder
 * live in the chat header; the rest of this strip drags the window.
 */
import { type JSX, useRef } from "react";
import { SOUND_SHORTCUT } from "../../../shared/game-sound.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import type { FactRef } from "../../../shared/project-facts.ts";
import type { LiveView } from "../../live-views.ts";
import type { BesideTarget } from "../../open-beside.ts";
import type { LiveBehind, StageView } from "../../stage.ts";
import type { GameProject } from "../../types.ts";
import { cn } from "../../ui/cn.ts";
import { Icon } from "../../ui/icons.tsx";
import { Shortcut } from "../../ui/Shortcut.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { ViewSwitcher } from "../../ui/view-switcher.tsx";
import { liveBehindLabel, liveBehindWords, STAGE_WORDS } from "../../words.ts";
import type { Notify } from "../../state/toasts.ts";
import { PluginToolbar } from "../PluginToolbar.tsx";
import { LiveRun } from "./live-run.ts";
import { activeStageTab, type StageTab, type StageTabKey, stageTabs } from "./stage-tabs.ts";
import { useStripFold } from "./strip-fold.ts";

/** The facts of a game whose descriptor isn't loaded yet: none, served as a web game. */
const NO_FACTS: readonly FactRef[] = [];

/** The view switcher's items: the strip's tabs (`stage-tabs.ts`), a file's with its glyph. */
const switcherItems = (tabs: readonly StageTab[]) =>
  tabs.map(({ icon, ...tab }) => (icon ? { ...tab, icon: <Icon name={icon} size={13} /> } : tab));

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

/**
 * Play/Stop's dress: the action's own colour on its tint (green to play, red to stop), and the
 * plain glass while a start or stop is under way.
 */
const RUN_LOOK = {
  [LiveRun.Running]: "border border-transparent bg-red-tint text-red",
  [LiveRun.Stopping]: "surface-glass text-foreground",
  [LiveRun.Stopped]: "border border-transparent bg-green-tint text-green",
  [LiveRun.Starting]: "surface-glass text-foreground",
} as const satisfies Record<LiveRun, string>;

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
          className={cn(STRIP_ICON_BUTTON, RUN_LOOK[run], busy && "cursor-default")}
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
 * card in the chat, not from here. An Unreal game plays in Unreal, not in a web page here, so it
 * has none of the web game's controls and no Publish: there is no web build to put online.
 */
export function StageStrip({
  loaded,
  project,
  hasBuilds,
  buildsLive,
  beside,
  stageView,
  live,
  onTab,
  behind,
  onReload,
  run,
  fullScreen,
  sound,
  emptyGame,
  livePreview,
  gameControls,
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
  /** Live's views of the folder (`liveViewsFor`) and the one shown: more than one gets a tab each. */
  live: { views: readonly LiveView[]; shown: LiveView };
  onTab: (key: StageTabKey) => void;
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
  /** Live shows the game's web preview (`live-views.ts`): only then do Run, Reload, Sound and Full screen show. */
  livePreview: boolean;
  /** The game has something to run (`gameControlsShown`): only then do Play/Stop and Sound show. */
  gameControls: boolean;
  plugins: PluginInfo[];
  onNotice: Notify;
  onToolbarOpen: (open: boolean) => void;
}): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // One row, always: once the labelled buttons would overflow it, they fold into icons together.
  const folded = useStripFold(strip, [start, end]);
  return (
    <div
      ref={strip}
      data-stage-strip=""
      data-folded={folded ? "" : undefined}
      className="titlebar-drag window-controls-end flex h-12 shrink-0 flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-line bg-canvas ps-3 pe-2 [scrollbar-width:none]"
    >
      {/* Two groups the fold measures, neither of them no-drag: every gap between the strip's
          controls still drags the window. */}
      <div ref={start} className="flex shrink-0 items-center gap-2">
        {/* One segmented group for every loaded game; Builds joins it once there is a build to
          draw, and Assets is always there — a game with no build still has files. Plugin buttons
          follow it as siblings, so they are there for a game with no build either. */}
        {project ? (
          <ViewSwitcher
            className="no-drag shrink-0"
            label="Game view"
            dataAttribute="data-stage-action"
            items={switcherItems(stageTabs({ views: live.views, plugins, hasBuilds, buildsLive, beside }))}
            active={activeStageTab(stageView, live.views, live.shown)}
            onSelect={onTab}
          />
        ) : null}
        {livePreview && gameControls ? <RunButton run={run.state} onToggle={run.toggle} /> : null}
        {livePreview ? <ReloadButton behind={behind} onReload={onReload} /> : null}
      </div>
      <span className="min-w-0 flex-1 self-stretch" />
      <div ref={end} className="flex shrink-0 items-center gap-2">
        {livePreview && gameControls ? <SoundButton on={sound.on} onToggle={sound.toggle} /> : null}
        {livePreview ? <FullScreenButton offered={fullScreen.offered} onEnter={fullScreen.enter} /> : null}
        <PluginToolbar
          plugins={plugins}
          project={project}
          facts={loaded?.facts ?? NO_FACTS}
          holds={loaded?.holds}
          emptyGame={emptyGame}
          game={{ builtOnce: !loaded?.awaitingFirstBuild, multiplayer: loaded?.multiplayer === true }}
          onNotice={onNotice}
          onOpenChange={onToolbarOpen}
          folded={folded}
        />
      </div>
    </div>
  );
}
