/**
 * The stage strip: one addressable row, so a check can prove every control in it stays uniquely
 * labelled — `control.ts` refuses an ambiguous selector at run time. The game's name and folder
 * live in the chat header; the rest of this strip drags the window.
 */
import { type JSX, useEffect, useState } from "react";
import type { BuildProblem } from "../../../shared/build-problem.ts";
import {
  type BuildTarget,
  type CompiledStack,
  destinationsOf,
  isCompiledStack,
  playsInOwnWindow,
  stackOf,
} from "../../../shared/game-project.ts";
import { SOUND_SHORTCUT } from "../../../shared/game-sound.ts";
import { hostOf } from "../../../shared/game-targets.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import type { FactRef } from "../../../shared/project-facts.ts";
import { kindChip } from "../../../shared/shape-words.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import type { LiveView } from "../../live-views.ts";
import type { BesideTarget } from "../../open-beside.ts";
import { hostPlatform } from "../../platform.ts";
import type { LiveBehind, StageView } from "../../stage.ts";
import type { GameProject } from "../../types.ts";
import { cn } from "../../ui/cn.ts";
import { Icon } from "../../ui/icons.tsx";
import { Shortcut } from "../../ui/Shortcut.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { ViewSwitcher } from "../../ui/view-switcher.tsx";
import type { ToolchainStatus } from "../../../shared/toolchain.ts";
import { DESTINATION_WORDS, liveBehindLabel, liveBehindWords, NATIVE_WORDS, STAGE_WORDS } from "../../words.ts";
import { nativeCommands, useNative, useNativeRun } from "../../state/hooks.ts";
import { nativeEmbedOf, NativeView } from "../../state/native.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { PluginToolbar } from "../PluginToolbar.tsx";
import { reconciledProblem } from "./build-trouble.ts";
import { DestinationBadges } from "./DestinationBadges.tsx";
import type { EngineRowsToggle } from "./EngineRows.tsx";
import { nativeCardView } from "./native-card.ts";
import {
  type BadgeFacts,
  destinationBadges,
  hasGameBox,
  type LaneRuns,
  laneRuns,
  liveBuildFailure,
  NO_RUNS,
  nativeRunFailure,
  playOnMacReason,
  playOnMacRefusal,
  playOnMacShown,
  stagePhase,
  toolsNeeds,
} from "./destinations.ts";
import { LiveRun } from "./live-run.ts";
import { activeStageTab, type StageTab, type StageTabKey, stageTabs } from "./stage-tabs.ts";

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

/** The engine button's own words. */
const MESSAGE = {
  engine: "Game engine",
  showEngine: "Engine settings",
  hideEngine: "Hide engine settings",
} as const;

/** The strip's engine button for a Rust game: opens and closes its engine rows above the stage. */
function EngineButton({ engine }: { engine: EngineRowsToggle }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={MESSAGE.engine}
          aria-pressed={engine.open}
          data-stage-engine={engine.open ? "open" : "closed"}
          onClick={engine.toggle}
          className={cn("no-drag", STRIP_ICON_BUTTON)}
        >
          <Icon name="code" size={15} />
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="left" sideOffset={6}>
        {engine.open ? MESSAGE.hideEngine : MESSAGE.showEngine}
      </TooltipContent>
    </Tooltip>
  );
}

/** The game's running C++ builds, counted from `build.progress`, forgotten when another game takes the stage. */
export function useLaneRuns(project: string | null): LaneRuns {
  const [runs, setRuns] = useState<LaneRuns>(NO_RUNS);
  useEffect(() => {
    setRuns(NO_RUNS);
    if (!project) return;
    return window.studio.onEvent((event) => {
      if (event.type !== UiEvent.BuildProgress) return;
      // `laneRuns` hands back the same object for anything that changes nothing, so a printed line does not redraw.
      setRuns((current) => laneRuns(current, event.payload, project));
    });
  }, [project]);
  return runs;
}

/**
 * Play on Mac: on a Mac, for a C++ game with Mac among its destinations (`playOnMacShown`), it opens
 * the game's Mac build in its own window; the native run card then says how it runs. While the
 * window is on its way it waits. Where it cannot open, it stays disabled with its reason as its
 * tooltip, which focus opens too, so a keyboard reaches it. `gameBox` is the same fact the badges read.
 */
function PlayOnMac({
  project,
  targets,
  gameBox,
  onNotice,
}: {
  project: string;
  targets: readonly BuildTarget[];
  gameBox: boolean;
  onNotice: Notify;
}): JSX.Element {
  const refusal = playOnMacRefusal(targets, gameBox);
  const { status } = useNativeRun(project);
  if (refusal === null) {
    const busy = nativeCardView(status)?.busy === true;
    return (
      <button
        type="button"
        data-stage-native-play=""
        data-refusal=""
        disabled={busy}
        onClick={() => void nativeCommands().play(project).catch(notifyProblem(onNotice))}
        className="surface-glass no-drag inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg px-2.5 text-body-sm text-ink-2 transition-colors duration-(--duration-quick) hover:text-control-text-hover enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {DESTINATION_WORDS.playOnMac}
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          data-stage-native-play=""
          data-refusal={refusal ?? ""}
          className="surface-glass no-drag inline-flex h-8 shrink-0 cursor-default items-center rounded-lg px-2.5 text-body-sm text-ink-3 opacity-60"
        >
          {DESTINATION_WORDS.playOnMac}
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="right" sideOffset={6} className="max-w-72">
        {playOnMacReason(refusal)}
      </TooltipContent>
    </Tooltip>
  );
}

/** Live's Web | Native choice for a game whose Mac build Live can show, and Pop out to its own window. */
export interface LiveViewChoice {
  view: NativeView;
  onChoose: (view: NativeView) => void;
  /** Unembed, show Web, and open the Mac window; null for a game with no window of its own (a Rust game). */
  onPopOut: (() => void) | null;
}

/** Web | Native: which build Live shows. */
function NativeViewToggle({ choice }: { choice: LiveViewChoice }): JSX.Element {
  return (
    <ViewSwitcher
      className="no-drag shrink-0"
      label={NATIVE_WORDS.embed.toggleLabel}
      dataAttribute="data-stage-native-view"
      items={[
        { key: NativeView.Web, label: NATIVE_WORDS.embed.web },
        { key: NativeView.Native, label: NATIVE_WORDS.embed.native },
      ]}
      active={choice.view}
      onSelect={choice.onChoose}
    />
  );
}

/** Pop out: the Mac build Live shows goes to its own window (the native run card follows it). */
function PopOut({ onPopOut }: { onPopOut: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-stage-native-popout=""
          onClick={onPopOut}
          className="surface-glass no-drag inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg px-2.5 text-body-sm text-ink-2 transition-colors duration-(--duration-quick) hover:text-control-text-hover active:scale-[0.96]"
        >
          {NATIVE_WORDS.embed.popOut}
        </button>
      </TooltipTrigger>
      {/* Beside, not below, as the strip's other tooltips. */}
      <TooltipContent side="right" sideOffset={6}>
        {NATIVE_WORDS.embed.popOutLabel}
      </TooltipContent>
    </Tooltip>
  );
}

/** The strip's Mac control: Pop out while Live shows the Mac build, else Play on Mac. */
function MacControl({
  project,
  targets,
  gameBox,
  liveView,
  onNotice,
}: {
  project: string;
  targets: readonly BuildTarget[];
  gameBox: boolean;
  liveView: LiveViewChoice | null;
  onNotice: Notify;
}): JSX.Element {
  if (liveView?.view === NativeView.Native && liveView.onPopOut) return <PopOut onPopOut={liveView.onPopOut} />;
  return <PlayOnMac project={project} targets={targets} gameBox={gameBox} onNotice={onNotice} />;
}

/**
 * What the badges know beyond the lane's runs: Live's build failure, the person's Mac run's
 * failure (its window, or Live's embedded run), and what each destination's tools need, from the
 * store's status once read and from the build problems until then (reconciled with the store).
 */
function useBadgeFacts(
  project: string | null,
  targets: readonly BuildTarget[],
  buildProblem: BuildProblem | null,
  toolchain: ToolchainStatus | null,
  stack: CompiledStack | undefined,
): Pick<BadgeFacts, "failed" | "runFailed" | "tools"> {
  const windowRun = useNativeRun(project).status;
  const embedRun = useNative((state) => nativeEmbedOf(state, project).status);
  const macProblems = [windowRun?.problem, embedRun?.problem].map((problem) =>
    problem ? reconciledProblem(problem, toolchain) : null,
  );
  return {
    failed: liveBuildFailure(buildProblem),
    runFailed: nativeRunFailure(windowRun) ?? nativeRunFailure(embedRun),
    tools: toolsNeeds(targets, {
      problems: [buildProblem, ...macProblems],
      status: toolchain,
      ...(stack ? { stack } : {}),
    }),
  };
}

/** A compiled game's stack (C++ or Rust), whose destinations get badges naming its build stage; else undefined. */
function compiledStackOf(loaded: GameProject | null): CompiledStack | undefined {
  if (!loaded) return undefined;
  const stack = stackOf(loaded.shape);
  return isCompiledStack(stack) ? stack : undefined;
}

/**
 * What this folder is, from its own evidence — so nobody has to guess why the stage is showing a
 * built page, and an engine export says so before a run is asked for. A compiled game (C++ or
 * Rust) always says so, naming its stack: Genex builds it, so it is not `built` (its own), yet it
 * is not the Three.js default either.
 */
function KindChip({ loaded }: { loaded: GameProject }): JSX.Element | null {
  const stack = stackOf(loaded.shape);
  const compiled = isCompiledStack(stack);
  if (!loaded.built && !compiled) return null;
  return (
    <span
      data-stage-kind={loaded.shape.kind}
      title={
        compiled
          ? DESTINATION_WORDS.stackLine(stack)
          : `The studio found this and keeps it as it is: ${loaded.shape.main}`
      }
      className="no-drag shrink-0 rounded-control bg-inset px-1.5 py-0.5 text-micro text-ink-3"
    >
      {kindChip(loaded.shape.kind)}
    </span>
  );
}

/** What the destination badges read beyond the game: its build problem, running Live builds and toolchain status. */
interface DestinationFacts {
  buildProblem: BuildProblem | null;
  runs: LaneRuns;
  toolchain: ToolchainStatus | null;
}

/**
 * Web | Native with Play on Mac or Pop out, and a compiled game's destination badges: siblings in
 * the strip, after Play/Stop and Reload, so those sit where they do for every game.
 */
function DestinationControls({
  loaded,
  project,
  game,
  liveView,
  onNotice,
}: {
  loaded: GameProject | null;
  project: string | null;
  game: DestinationFacts;
  liveView: LiveViewChoice | null;
  onNotice: Notify;
}): JSX.Element {
  const { buildProblem, runs, toolchain } = game;
  const compiled = compiledStackOf(loaded);
  const targets = loaded ? destinationsOf(loaded).targets : [];
  const host = hostOf(hostPlatform());
  const gameBox = hasGameBox(host);
  /** The game Play on Mac opens, when the strip shows it: never one with no window of its own (a Rust game). */
  const ownWindow = loaded !== null && playsInOwnWindow(stackOf(loaded.shape));
  const macPlay = ownWindow && playOnMacShown(targets, host) ? project : null;
  const facts = useBadgeFacts(macPlay, targets, buildProblem, toolchain, compiled);
  return (
    <>
      {liveView ? <NativeViewToggle choice={liveView} /> : null}
      {macPlay ? (
        <MacControl project={macPlay} targets={targets} gameBox={gameBox} liveView={liveView} onNotice={onNotice} />
      ) : null}
      {compiled && loaded ? (
        <DestinationBadges
          badges={destinationBadges(targets, {
            host,
            gameBox,
            runs,
            ...facts,
            checks: loaded.nativeChecks,
            stack: compiled,
          })}
          phase={stagePhase(runs, facts.failed)}
        />
      ) : null}
    </>
  );
}

/**
 * The strip over the stage: what the folder is, the view switcher, Play/Stop and Reload, Web |
 * Native with Play on Mac or Pop out, a compiled game's destinations, then at its end a Rust game's
 * engine button, the game's sound, full screen and plugin buttons. An earlier build opens from its
 * result card in the chat, not from here. An Unreal game plays in Unreal, not in a web page here,
 * so it has none of the web game's controls and no Publish: there is no web build to put online.
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
  engine = null,
  emptyGame,
  livePreview,
  plugins,
  onNotice,
  onToolbarOpen,
  buildProblem,
  runs,
  toolchain,
  liveView,
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
  /** A Rust game's engine button (`useEngineRows`); null or absent hides it. */
  engine?: EngineRowsToggle | null;
  /** The game has nothing in it yet: no plugin button's action is due. */
  emptyGame: boolean;
  /** Live shows the game's web preview (`live-views.ts`): only then do Run, Reload, Sound and Full screen show. */
  livePreview: boolean;
  plugins: PluginInfo[];
  onNotice: Notify;
  onToolbarOpen: (open: boolean) => void;
  /** The live folder's build problem (`useBuildProblem`), reconciled with the store: Live's Build failed and its tools. */
  buildProblem: BuildProblem | null;
  /** The game's running Live builds (`useLaneRuns`). */
  runs: LaneRuns;
  /** The C++ toolchain store's status, once read: what each destination's tools need. */
  toolchain: ToolchainStatus | null;
  /** Web | Native, for a game whose Mac build Live can show here; null hides the toggle. */
  liveView: LiveViewChoice | null;
}): JSX.Element {
  const destinations = loaded ? destinationsOf(loaded).targets : null;
  return (
    <div
      data-stage-strip=""
      className="titlebar-drag window-controls-end flex min-h-12 max-h-30 shrink-0 flex-wrap items-center gap-2 overflow-auto border-b border-line bg-canvas ps-3 pe-2 py-1.5"
    >
      {loaded ? <KindChip loaded={loaded} /> : null}
      {/* One segmented group for every loaded game; Builds joins it once there is a build to
          draw, and Assets is always there — a game with no build still has files. Plugin buttons
          end the strip, so they are there for a game with no build either. */}
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
      {/* Siblings, not a group: every gap between the strip's controls drags the window. */}
      {livePreview ? <RunButton run={run.state} onToggle={run.toggle} /> : null}
      {livePreview ? <ReloadButton behind={behind} onReload={onReload} /> : null}
      <DestinationControls
        loaded={loaded}
        project={project}
        game={{ buildProblem, runs, toolchain }}
        liveView={liveView}
        onNotice={onNotice}
      />
      <span className="min-w-0 flex-1 self-stretch" />
      {project && engine ? <EngineButton engine={engine} /> : null}
      {livePreview ? <SoundButton on={sound.on} onToggle={sound.toggle} /> : null}
      {livePreview ? <FullScreenButton offered={fullScreen.offered} onEnter={fullScreen.enter} /> : null}
      <PluginToolbar
        plugins={plugins}
        project={project}
        destinations={destinations}
        facts={loaded?.facts ?? NO_FACTS}
        holds={loaded?.holds}
        emptyGame={emptyGame}
        onNotice={onNotice}
        onOpenChange={onToolbarOpen}
      />
    </div>
  );
}
