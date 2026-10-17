/**
 * Home: where every launch starts, with nothing selected — one line and one composer whose first
 * message makes a game, named by the model, in the folder the chip under it names.
 *
 * While that game is being made, home becomes the chat and stage it is turning into: the composer
 * glides down into the chat's place, the message sits where the chat will show it, and the stage's
 * Planner starts writing (`launch.ts` holds the steps). Once the game's own chat has the message,
 * home fades away over it, so the swap underneath is never seen.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { GameLocation } from "../../shared/game-project.ts";
import { UserMessage } from "../chat/UserMessage.tsx";
import { chatPlaceholder, HOME_PLACEHOLDER } from "../composer-placeholder.ts";
import { ShowSidebarButton } from "../panels/ChatHeader.tsx";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { HomeBackground } from "../home-backdrop/HomeBackdrop.tsx";
import { PlanningBuild } from "../panels/stage/StageBody.tsx";
import { useEngines, useLaunch, useLibrary, useSessionView, useThreads } from "../state/hooks.ts";
import { type Launch, LaunchPhase } from "../state/launch.ts";
import type { Studio } from "../state/studio.ts";
import { Room, roomOf } from "../state/threads.ts";
import { ToastTone } from "../state/toasts.ts";
import { Icon } from "../ui/icons.tsx";
import { useSteadyLabel } from "../ui/label-motion.ts";
import { pickPromptIdea } from "../prompt-ideas.ts";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { PromptBar, type ComposerExtras } from "../ui/PromptBar.tsx";
import { withViewTransition } from "../ui/view-transition.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";
import { useHomeComposerModel } from "./use-home-composer.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";
import { HomeBackdropButton } from "./HomeBackdropButton.tsx";
import { HomeFolderChip } from "./HomeFolderChip.tsx";
import { StatusOrb } from "../ui/StatusOrb.tsx";

/** Home's words. */
const MESSAGE = {
  title: "Everything you need to ship a game",
  naming: "Naming…",
  namingStatus: "Naming your game…",
  openingStatus: "Opening your game…",
  suggest: "Suggest prompt",
} as const;

/** Home's fade over the game it launched takes 250ms (`--duration-fast`); past this it is done anyway. */
const FADE_FALLBACK_MS = 400;

/** Is home up: the room with nothing open, or a launch on its way to its game. */
function useHomeShown(): { shown: boolean; launch: Launch | null } {
  const room = useThreads(roomOf);
  const launch = useLaunch((s) => s.launch);
  const { ready, welcoming } = useSessionView();
  return { shown: ready && !welcoming && (room === Room.Home || launch !== null), launch };
}

/**
 * Is home covering the chat and stage? Then they are out of reach beneath it, and the native game
 * view stays hidden, until home starts fading over the game it launched.
 */
export function useCoveredByHome(): boolean {
  const atHome = useThreads((s) => roomOf(s) === Room.Home);
  const launch = useLaunch((s) => s.launch?.phase ?? null);
  return (atHome || launch !== null) && launch !== LaunchPhase.Handed;
}

/** Home over the workspace while it is up; nothing otherwise. Under a remix being made it takes nothing. */
export function HomeLayer({
  under,
  ...props
}: {
  app: Studio;
  dialogs: Dialogs;
  chrome: ShellChrome;
  handoff: ComposerHandoff;
  /** A Play remix being made covers it (`RemixLayer`). */
  under: boolean;
}): JSX.Element | null {
  const { shown, launch } = useHomeShown();
  if (!shown) return null;
  return (
    <div className="contents" inert={under}>
      <HomeScreen {...props} launch={launch} />
    </div>
  );
}

function HomeScreen({
  app,
  dialogs,
  chrome,
  handoff,
  launch,
}: {
  app: Studio;
  dialogs: Dialogs;
  chrome: ShellChrome;
  handoff: ComposerHandoff;
  launch: Launch | null;
}): JSX.Element {
  const engines = useEngines((s) => s.list);
  const rootLabel = useLibrary((s) => s.rootLabel);
  const model = useHomeComposerModel(engines, app.engines.refresh);
  const [location, setLocation] = useState<GameLocation | null>(null);
  const [draft, setDraft] = useState("");
  const suggestion = useSuggestion(draft, setDraft, handoff);
  const leaving = launch?.phase === LaunchPhase.Handed;
  useHomeComposerWords(app, handoff, launch === null);
  const finish = (id: string): void => {
    app.launchFinished(id);
    // The message is the chat's now; so is the cursor.
    requestAnimationFrame(() => handoff.composer.current?.focus());
  };
  useFinishWhenGone(launch, finish);
  const send = (text: string, extras?: ComposerExtras): void => {
    const input = {
      text,
      ...(extras ? { extras } : {}),
      modelKey: model.selected,
      effort: model.effort ?? null,
      ...(location ? { parent: location.dir } : {}),
    };
    // The launch's first step is synchronous: home becomes the chat and stage in one frame.
    withViewTransition(() => void app.launchGame(input));
  };
  const composer = (
    <div data-home-composer className="home-composer">
      <PromptBar
        ref={handoff.homeComposer}
        gameMode
        placeholder={launch ? chatPlaceholder({ revisingPlan: false, studio: false, draft: false }) : HOME_PLACEHOLDER}
        model={model.bar}
        busy={launch !== null}
        value={draft}
        onChange={setDraft}
        onSend={send}
        mentionSide="bottom"
      />
    </div>
  );
  if (launch)
    return (
      <LaunchingHome
        launch={launch}
        leaving={leaving}
        sidebarHidden={chrome.sidebarHidden}
        onToggleSidebar={chrome.toggleSidebar}
        onLeft={() => finish(launch.id)}
        composer={composer}
      />
    );
  return (
    <section data-home="" aria-label="Home" className="home-layer">
      {/* Only home at rest has it: the first message's transition fades it out with the rest. */}
      <HomeBackground />
      <div className="home-header titlebar-drag">
        {chrome.sidebarHidden && <ShowSidebarButton onToggle={chrome.toggleSidebar} />}
        <HomeBackdropButton picked={model.selected} />
      </div>
      <div className="home-body">
        <h1 className="home-title">{MESSAGE.title}</h1>
        <div className="home-compose">
          {composer}
          <div className="home-compose-row">
            <HomeFolderChip
              rootLabel={rootLabel}
              location={location}
              onLocation={setLocation}
              onInspect={(inspection) => dialogs.dispatch({ type: "picked", inspection })}
              onProblem={(words) => app.notify(words, ToastTone.Error)}
            />
            {/* Only while the box is empty or still holds a suggestion: it never replaces the user's words. */}
            <button
              type="button"
              data-home-suggest
              className="home-suggest"
              disabled={!suggestion.offered}
              onClick={suggestion.suggest}
            >
              <Icon name="dice" size={15} />
              {MESSAGE.suggest}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Suggest prompt: a random idea in the composer, cursor after it. It is offered while the box is
 * empty or still holds the idea it last put there, so it never replaces the user's own words.
 */
function useSuggestion(draft: string, setDraft: (text: string) => void, handoff: ComposerHandoff) {
  const suggested = useRef<string | null>(null);
  const offered = !draft.trim() || draft === suggested.current;
  const suggest = (): void => {
    const idea = pickPromptIdea(suggested.current);
    suggested.current = idea;
    setDraft(idea);
    requestAnimationFrame(() => handoff.homeComposer.current?.compose(idea));
  };
  return { offered, suggest };
}

/**
 * Home's composer opens with words waiting for it — the welcome's idea, or a launch that failed
 * — else with the cursor in it.
 */
function useHomeComposerWords(app: Studio, handoff: ComposerHandoff, atHome: boolean): void {
  const returned = useLaunch((s) => s.returned);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the handoff is new each render; its refs are not
  useEffect(() => {
    if (!atHome) return;
    const words = returned?.text ?? handoff.takeIdea();
    if (returned) app.returnTaken();
    const frame = requestAnimationFrame(() => {
      if (words) handoff.homeComposer.current?.compose(words);
      else handoff.homeComposer.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [app, atHome, returned]);
}

/**
 * Home goes once the chat has the message: when its fade ends, at once under Reduce Motion, and
 * after the fade's length in any case — a window that is hidden may never end a transition.
 */
function useFinishWhenGone(launch: Launch | null, finish: (id: string) => void): void {
  const handed = launch?.phase === LaunchPhase.Handed ? launch.id : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `finish` is new each render; the launch decides
  useEffect(() => {
    if (!handed) return;
    if (prefersReducedMotion()) {
      finish(handed);
      return;
    }
    const timer = setTimeout(() => finish(handed), FADE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [handed]);
}

/** Home on its way to the game: the chat and stage the launch is becoming, then a fade. */
function LaunchingHome({
  launch,
  leaving,
  sidebarHidden,
  onToggleSidebar,
  onLeft,
  composer,
}: {
  launch: Launch;
  leaving: boolean;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  onLeft: () => void;
  composer: JSX.Element;
}): JSX.Element {
  const named = launch.title !== null;
  // Naming can take a moment or no time at all: each status stays a second, as the chat's do.
  const status = useSteadyLabel(named ? MESSAGE.openingStatus : MESSAGE.namingStatus);
  return (
    <section
      data-home="launching"
      aria-busy="true"
      className="home-layer home-launching"
      data-leaving={leaving || undefined}
      inert={leaving}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onLeft();
      }}
    >
      <div className="home-launch-chat column">
        <div
          className={`titlebar-drag flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-page ps-2.5 pe-2 ${sidebarHidden ? "chat-header-sidebar-hidden" : ""}`}
        >
          {sidebarHidden && <ShowSidebarButton onToggle={onToggleSidebar} />}
          <span className="chat-header-title truncate" data-naming={named ? undefined : ""}>
            {launch.title ?? MESSAGE.naming}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5">
          <UserMessage text={launch.text} />
          {/* The chat's own status line, in its type, with its loader: the chat this becomes. */}
          <div data-chat-status className="chat-status-line">
            <StatusOrb />
            <span role="status" data-shimmer className="chat-status-shimmer">
              {status}
            </span>
          </div>
        </div>
        <div className="min-w-0 shrink-0 px-3.5 pt-1 pb-3.5">{composer}</div>
      </div>
      <div className="home-launch-stage">
        <div className="titlebar-drag min-h-12 shrink-0 border-b border-line bg-canvas" />
        <div className="relative min-h-0 flex-1">
          <PlanningBuild since={launch.at} />
        </div>
      </div>
    </section>
  );
}
