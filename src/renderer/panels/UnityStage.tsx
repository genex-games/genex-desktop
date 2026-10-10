import { type JSX, useEffect, useState } from "react";
import type { GameProject } from "../../shared/game-project.ts";
import type { PluginInfo, PluginPanelDocument } from "../../shared/plugins.ts";
import { UNITY_PLUGIN_ID, UNITY_PROJECT_PANEL } from "../../shared/unity.ts";
import type { BesideTarget } from "../open-beside.ts";
import { StageView } from "../stage.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../ui/ComposerAddMenu.tsx";
import { problemWords } from "../words.ts";
import { AssetsCanvas } from "./AssetsCanvas.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { PluginPanelHost } from "./PluginPanelHost.tsx";

const MESSAGE = {
  Loading: "Opening Unity workspace…",
  Disabled: "Enable the Unity plugin to connect this project to its Editor.",
  Workspace: "Unity workspace",
  Plugins: "Open plugins",
  Assets: "Assets",
  Folder: "Show project folder",
};

interface Props {
  game: GameProject;
  plugins: PluginInfo[];
  view: StageView;
  onView(view: StageView): void;
  onNotice: Notify;
  threadId: string | null;
  beside?: BesideTarget | null;
  onCloseBeside?: () => void;
}

/** The native Editor's panel replaces the browser preview; the previous browser game gives up its surface. */
export function UnityStage({
  game,
  plugins,
  view,
  onView,
  onNotice,
  threadId,
  beside,
  onCloseBeside,
}: Props): JSX.Element {
  const plugin = plugins.find((candidate) => candidate.manifest.id === UNITY_PLUGIN_ID && candidate.enabled);
  const [document, setDocument] = useState<PluginPanelDocument | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const version = plugin?.manifest.version;
  useEffect(() => {
    void window.studio.previewBounds({ x: 0, y: 0, width: 0, height: 0, watching: false });
    let current = true;
    setDocument(null);
    setProblem(null);
    if (version)
      window.studio.pluginPanel(UNITY_PLUGIN_ID, UNITY_PROJECT_PANEL).then(
        (next) => {
          if (current) setDocument(next);
        },
        (error) => {
          if (current) setProblem(problemWords(error));
        },
      );
    return () => {
      current = false;
    };
  }, [version]);
  const files = view === StageView.File && beside;
  return (
    <section data-unity-stage className="column flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-15 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="min-w-32 flex-1 basis-32 truncate text-sm" title={game.pathLabel}>
          {game.title}
        </span>
        <Button
          variant={view === StageView.Assets ? "pill" : "outline"}
          aria-pressed={view !== StageView.Assets}
          onClick={() => onView(StageView.Live)}
        >
          {MESSAGE.Workspace}
        </Button>
        <Button
          variant={view === StageView.Assets ? "outline" : "pill"}
          aria-pressed={view === StageView.Assets}
          onClick={() => onView(StageView.Assets)}
        >
          {MESSAGE.Assets}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void window.studio.revealProject(game.name).catch(notifyProblem(onNotice))}
        >
          {MESSAGE.Folder}
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-base">
        {view === StageView.Assets ? <AssetsCanvas project={game.name} onNotice={onNotice} /> : null}
        {files ? (
          <FileViewer threadId={threadId} target={files} onClose={() => onCloseBeside?.()} onNotice={onNotice} />
        ) : null}
        {view !== StageView.Assets && !files ? (
          <UnityWorkspace key={game.name} plugin={plugin} document={document} project={game.name} problem={problem} />
        ) : null}
      </div>
    </section>
  );
}

function UnityWorkspace({
  plugin,
  document,
  project,
  problem,
}: {
  plugin?: PluginInfo;
  document: PluginPanelDocument | null;
  project: string;
  problem: string | null;
}): JSX.Element {
  if (plugin && document)
    return <PluginPanelHost plugin={plugin} document={document} project={project} className="h-full w-full border-0" />;
  return (
    <div className="flex h-full flex-col items-start justify-center gap-4 p-8" role="status">
      <p className="text-sm text-ink-2">{problem ?? (plugin ? MESSAGE.Loading : MESSAGE.Disabled)}</p>
      {!plugin || problem ? (
        <Button
          onClick={() =>
            window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: UNITY_PLUGIN_ID } }))
          }
        >
          {MESSAGE.Plugins}
        </Button>
      ) : null}
    </div>
  );
}
