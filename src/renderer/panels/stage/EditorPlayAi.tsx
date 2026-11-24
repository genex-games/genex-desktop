/**
 * Play-time models for a game played in the Unreal editor. Main names Live's practice helper to
 * the editor while Live's view of the stage's game is the Unreal card (`previewAiEditor`), whichever
 * stage tab is open, as a web game's page keeps its helper behind another tab. Live's AI bar then
 * speaks for the editor's play, with one line more: a play keeps the helper it began with.
 */
import { type JSX, useEffect } from "react";
import { PreviewAiMode } from "../../../shared/preview-ai.ts";
import { usePreviewAi } from "../../state/hooks.ts";
import { UNREAL_WORDS } from "../../words.ts";
import { PreviewAiBar } from "./PreviewAiBar.tsx";

/** Tell main while Live's view of `project` is its Unreal card (`onCard`), and when it is so no longer. */
export function useEditorPlayAi(project: string | null, onCard: boolean): void {
  useEffect(() => {
    if (!project || !onCard) return;
    void window.studio.previewAiEditor(project, true).catch(() => {});
    return () => {
      void window.studio.previewAiEditor(project, false).catch(() => {});
    };
  }, [project, onCard]);
}

/** Under Live's AI bar on the Unreal card, while the bar shows: when a choice in it reaches the game. */
function EditorPlayAiNote({ project }: { project: string | null }): JSX.Element | null {
  const mode = usePreviewAi((s) => (project ? s.games[project]?.mode : undefined));
  if (mode === undefined || mode === PreviewAiMode.None) return null;
  return (
    <p data-editor-play-ai-note className="shrink-0 border-b border-line bg-surface px-3 pb-1.5 text-xs text-ink-3">
      {UNREAL_WORDS.playAiNote}
    </p>
  );
}

/** Live's AI bar above the web preview and above the Unreal card, the card's with its line about the next Play. */
export function StageAiBar({
  project,
  on,
}: {
  project: string | null;
  on: { previewOnStage: boolean; cardOnStage: boolean };
}): JSX.Element | null {
  if (!on.previewOnStage && !on.cardOnStage) return null;
  return (
    <>
      <PreviewAiBar project={project} />
      {on.cardOnStage ? <EditorPlayAiNote project={project} /> : null}
    </>
  );
}
