/** What fills the stage's rectangle when it is not the running game: setup, the loader, an empty game, Builds, Assets or a file. */
import type { JSX } from "react";
import { type RunGraph as RunGraphModel, runBuilding, runIdOf } from "../../run-graph.ts";
import { readyToPlay } from "../../run-steps.ts";
import { openSettings, SettingsSection } from "../../settings-navigation.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { useRunSummary } from "../../use-run-summary.ts";
import { PlayButton } from "../run-graph/chrome.tsx";
import { StageLoading } from "./LiveLoaderArt.tsx";
import { PlannerArt } from "./PlannerArt.tsx";

/** The stage with nothing to play yet: the shared empty state over the stage's hatch. */
export function StageEmpty({
  art,
  title,
  subtitle,
  action,
}: {
  art: "none" | "idea" | "building" | "stopped";
  title: string;
  subtitle: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div
      data-stage-empty={art}
      className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8 animate-in fade-in-0 duration-200"
    >
      <EmptyState art={art === "none" ? "idea" : art} title={title} subtitle={subtitle} action={action} />
    </div>
  );
}

/** No game is open: teach setup when nothing can run yet, else point at the sidebar. */
export function NoGame({ showSetup }: { showSetup: boolean }): JSX.Element {
  if (!showSetup)
    return <StageEmpty art="none" title="Your game appears here" subtitle="Start or open a game from the sidebar." />;
  return (
    <div className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8">
      <ModelSetup />
    </div>
  );
}

/** Nothing can build yet: connect a coding account or download a local model. */
export function ModelSetup(): JSX.Element {
  return (
    <div data-model-setup className="flex w-[560px] max-w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5 px-0.5">
        <div className="text-heading font-medium tracking-[-0.2px]">Choose a coding model</div>
        <div className="text-body-sm leading-relaxed text-ink-2">
          Connect a coding account or use a local model. You can switch later.
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="default" onClick={() => openSettings(SettingsSection.Providers)}>
          Connect a provider
        </Button>
        <Button onClick={() => openSettings(SettingsSection.Local)}>Download a local model</Button>
      </div>
    </div>
  );
}

/**
 * A run is building in its builders' own copies. Once it has a build ready to play, the one thing
 * a person waiting here wants is to press Play latest; until then, the way to watch it being made.
 */
function BuildingGame({
  graph,
  project,
  onWatch,
  onPlay,
}: {
  graph: RunGraphModel;
  project: string | null;
  onWatch: () => void;
  onPlay: (head: string) => Promise<void>;
}): JSX.Element {
  const head = readyToPlay(graph, useRunSummary(project, runIdOf(graph)));
  return (
    <StageEmpty
      art="building"
      title="Building your game"
      subtitle={head ? "The latest build is ready to play." : "It shows up here as soon as it runs."}
      action={
        head ? (
          <PlayButton label="Play latest" onPlay={() => onPlay(head)} />
        ) : (
          <Button variant="outline" onClick={onWatch}>
            Watch progress
          </Button>
        )
      }
    />
  );
}

/**
 * The game's folder has nothing in it yet. While a run is going, this folder being empty is not the
 * whole story: the work is happening in the builders' own copies, and the user is one click from
 * watching it — or, once a build is ready, from playing it.
 */
export function EmptyGame({
  graph,
  project,
  onWatch,
  onPlay,
}: {
  graph: RunGraphModel | null;
  project: string | null;
  onWatch: () => void;
  onPlay: (head: string) => Promise<void>;
}): JSX.Element {
  if (runBuilding(graph)) return <BuildingGame graph={graph} project={project} onWatch={onWatch} onPlay={onPlay} />;
  return (
    <StageEmpty art="idea" title="Ready for your first idea" subtitle="Describe your game in the chat to begin." />
  );
}

/**
 * The build is being planned and there is nothing to draw yet: the welcome's Planner writes it,
 * from `since` when the planning began earlier than this stage did.
 */
export function PlanningBuild({ since }: { since?: number }): JSX.Element {
  return (
    <div data-stage-planning className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8">
      <div className="flex flex-col items-center gap-3.5">
        <PlannerArt since={since} />
        <span role="status" className="text-name font-medium text-ink">
          Planning the build
        </span>
      </div>
    </div>
  );
}

/** While the page asked for loads, the native view is out of sight: the loader says so, then fades. */
export function LiveLoading({ leaving }: { leaving: boolean }): JSX.Element {
  return (
    <div data-live-loading className="absolute inset-0 grid place-items-center p-8">
      <StageLoading label="Loading game" leaving={leaving} />
    </div>
  );
}

/**
 * The person stopped the game. While a run builds, the stage is what it is for a building game
 * (the crane, Play latest or Watch progress); otherwise it says the game is stopped, with Play.
 */
export function StoppedGame({
  graph,
  project,
  onWatch,
  onPlay,
  onResume,
}: {
  graph: RunGraphModel | null;
  project: string | null;
  onWatch: () => void;
  onPlay: (head: string) => Promise<void>;
  onResume: () => void;
}): JSX.Element {
  if (runBuilding(graph)) return <BuildingGame graph={graph} project={project} onWatch={onWatch} onPlay={onPlay} />;
  return (
    <StageEmpty art="stopped" title="Game stopped" subtitle="" action={<PlayButton label="Play" onPlay={onResume} />} />
  );
}
