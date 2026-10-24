/**
 * The build a run's start waits on: before its lead's first turn the harness builds the game
 * (`prepareLoopRun` loads and looks at it; a cold Rust build takes minutes). The chat's build card
 * says so in Live's words, with its clock, counted from `build.progress` of the agents' builds of
 * that game, instead of a line that never moves. Stop ends the run then too.
 */
import { useEffect, useState } from "react";
import { BuildPhase, CppBuildPurpose } from "../../shared/build-problem.ts";
import { UiEvent, type UiEventMap } from "../../shared/ui-events.ts";
import { CLOCK_TICK_MS, elapsedWords } from "../asset-making.ts";
import { SETUP_BUILD_WORDS } from "../words.ts";

/** The agents' builds of the game under way: how many, and since the first began. */
export interface SetupBuild {
  builds: number;
  since: number;
}

/**
 * `state` after one `build.progress` event: an agents' build of `project` (Judging's purpose, the
 * harness's loads and looks) starts on its first event and ends with Done or Failed (a Stop's
 * cancel among them). Live's own builds, exports, printed lines and other games change nothing.
 */
export function setupBuildAfter(
  state: SetupBuild | null,
  event: UiEventMap["build.progress"],
  project: string,
): SetupBuild | null {
  const agents = event.project === project && event.purpose === CppBuildPurpose.Judging;
  if (!agents || event.line !== undefined) return state;
  const ends = event.phase === BuildPhase.Done || event.phase === BuildPhase.Failed;
  if (ends) return state && state.builds > 1 ? { ...state, builds: state.builds - 1 } : null;
  if (!state) return { builds: 1, since: event.at };
  return event.phase === BuildPhase.Configure ? { ...state, builds: state.builds + 1 } : state;
}

/** The build card's line while the start builds, before the lead has parts to show; null otherwise. */
export function setupBuildCaption(input: {
  building: SetupBuild | null;
  leadStarted: boolean;
  now: number;
}): string | null {
  const { building, leadStarted, now } = input;
  if (!building || leadStarted) return null;
  return SETUP_BUILD_WORDS.building(elapsedWords(building.since, now) ?? "");
}

/**
 * The agents' build of `project` under way while `runId` runs, and now, moving on once a second
 * while it builds; forgotten with the run or the game.
 */
export function useSetupBuild(
  project: string | null,
  runId: string | null,
): { building: SetupBuild | null; now: number } {
  const [building, setBuilding] = useState<SetupBuild | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setBuilding(null);
    if (!project || !runId) return;
    return window.studio.onEvent((event) => {
      if (event.type === UiEvent.BuildProgress) setBuilding((state) => setupBuildAfter(state, event.payload, project));
    });
  }, [project, runId]);
  const ticking = building !== null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return { building, now };
}
