/**
 * A Play remix being made, shown in Create from the press (`usePlayRemixes`): the chat it will have,
 * under its title, with its status line and its composer (which takes nothing yet), and its stage
 * with the Remix mark being drawn (`making-art.ts`), the step it is on and the step bar, until the
 * new game opens under it and this fades away. Going elsewhere sets it aside (`remixSetAside`): it
 * fades the same way, and its sidebar row brings it back.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { remixTitle } from "../../shared/play.ts";
import { chatPlaceholder } from "../composer-placeholder.ts";
import { ShowSidebarButton } from "../panels/ChatHeader.tsx";
import { MakingDrawing } from "../making-art.ts";
import { MakingArt } from "../panels/MakingArt.tsx";
import { remixCovers, remixLine, remixSegments } from "../play/remix-model.ts";
import { useEngines, usePlay } from "../state/hooks.ts";
import type { RemixUnderway } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { PromptBar } from "../ui/PromptBar.tsx";
import { StatusOrb } from "../ui/StatusOrb.tsx";
import { StepBar } from "../ui/StepBar.tsx";
import { PLAY_WORDS } from "../words.ts";
import { useHomeComposerModel } from "./use-home-composer.ts";

/** How long the fade over the opened game may take before the layer goes anyway. */
const FADE_FALLBACK_MS = 400;
const WORDS = PLAY_WORDS.making;

/** Whether a remix being made covers the workspace: what is under it takes no focus and shows no game. */
export const useCoveredByRemix = (): boolean => usePlay((s) => remixCovers(s.making));

/** The remix on screen: the one Create shows, or the last one while it fades over what comes next. */
function useShownRemix(): { shown: RemixUnderway | null; leaving: boolean; gone: () => void } {
  const making = usePlay((s) => (remixCovers(s.making) ? s.making : null));
  const [last, setLast] = useState<RemixUnderway | null>(null);
  if (making && making !== last) setLast(making);
  const leaving = !making && last !== null;
  useEffect(() => {
    if (!leaving) return;
    if (prefersReducedMotion()) {
      setLast(null);
      return;
    }
    const timer = setTimeout(() => setLast(null), FADE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return { shown: making ?? last, leaving, gone: () => setLast(null) };
}

/** The remix being made, over the workspace, while there is one. */
export function RemixLayer({
  sidebarHidden,
  onToggleSidebar,
}: {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}): JSX.Element | null {
  const { shown, leaving, gone } = useShownRemix();
  const layer = useRef<HTMLElement>(null);
  const slug = shown?.slug ?? null;
  // The press that started it went with Play: the keyboard starts here, not on the page itself. A
  // frame later, once Play has given way and the workspace takes focus again.
  useEffect(() => {
    if (!slug) return;
    const frame = requestAnimationFrame(() => layer.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [slug]);
  if (!shown) return null;
  const line = remixLine(shown);
  return (
    <section
      ref={layer}
      tabIndex={-1}
      aria-label={remixTitle(shown.title)}
      data-remix-layer={shown.step}
      aria-busy={!leaving}
      className="home-layer home-launching outline-none"
      data-leaving={leaving || undefined}
      inert={leaving}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget) gone();
      }}
    >
      <div className="home-launch-chat column">
        <div
          className={`titlebar-drag flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-page ps-2.5 pe-2 ${sidebarHidden ? "chat-header-sidebar-hidden" : ""}`}
        >
          {sidebarHidden && <ShowSidebarButton onToggle={onToggleSidebar} />}
          <span className="chat-header-title truncate">{remixTitle(shown.title)}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5">
          {/* The chat's own status line, in its type, with its loader: the chat this becomes. */}
          <div data-chat-status className="chat-status-line">
            <StatusOrb />
            <span data-shimmer className="chat-status-shimmer">
              {WORDS.chat(shown.title)}
            </span>
          </div>
        </div>
        <RemixComposer />
      </div>
      <div className="home-launch-stage">
        <div className="titlebar-drag min-h-12 shrink-0 border-b border-line bg-canvas" />
        <div className="relative grid min-h-0 flex-1 place-items-center p-8">
          <div className="remix-stage">
            <MakingArt drawing={MakingDrawing.Remix} still={false} offset={0} className="remix-art" />
            {/* Read out once per step: the megabytes change four times a second and stay on screen. */}
            <span data-shimmer className="chat-status-shimmer text-body-sm">
              <span aria-hidden="true">{line}</span>
              <span role="status" className="sr-only">
                {WORDS.line[shown.step]}
              </span>
            </span>
            <div className="remix-steps">
              <StepBar steps={remixSegments(shown)} label={WORDS.progress} valueText={line} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The composer the new game's chat opens with, shown as it will be and taking nothing until then. */
function RemixComposer(): JSX.Element {
  const engines = useEngines((s) => s.list);
  const model = useHomeComposerModel(engines, () => void studio().engines.refresh());
  return (
    <div className="min-w-0 shrink-0 px-3.5 pt-1 pb-3.5">
      <PromptBar
        gameMode
        disabled
        placeholder={chatPlaceholder({ revisingPlan: false, studio: false, draft: false })}
        model={model.bar}
        onSend={() => {}}
      />
    </div>
  );
}
