/** The production stage and panel with synthetic bridge replies; never opens an Editor or account. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import manifest from "../../src/plugins/unity/plugin.json" with { type: "json" };
import type { GameProject } from "../../src/shared/game-project.ts";
import { PluginHealth, PluginSourceKind, type PluginInfo, type PluginManifest } from "../../src/shared/plugins.ts";
import { UnityStage } from "../../src/renderer/panels/UnityStage.tsx";
import { ChatPanelHeader } from "../../src/renderer/chat/ChatPanelHeader.tsx";
import type { ChatParts } from "../../src/renderer/chat/use-chat-panel.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

declare const UNITY_PANEL_HTML: string;
type Mode = "disabled" | "loading" | "error" | "ready";
const scene = { name: "Fixture scene", dirty: false };
let mode: Mode = "disabled";
let ready = false;
let compiling = false;
let playing = false;
let paused = false;
let resolvePanel: ((value: { html: string; title: string; url: string }) => void) | undefined;
const actions: Array<{ name: string; args: unknown; project?: string }> = [];
const jobs = new Map<string, Record<string, unknown>>();
const headerActions: Array<{ name: string; project?: string }> = [];
const panel = {
  html: UNITY_PANEL_HTML,
  title: "Unity fixture panel",
  url: `data:text/html;charset=utf-8,${encodeURIComponent(UNITY_PANEL_HTML)}`,
};
const editor = { version: "6000.5.5f1", executable: "C:/fixture/Unity.exe" };
const api = fakeStudioApi({
  pluginPanel: async () => {
    if (mode === "error") throw new Error("Synthetic panel loading failure");
    if (mode === "loading")
      return new Promise((resolve) => {
        resolvePanel = resolve;
      });
    return panel;
  },
  pluginReview: async () => ({ ticket: "fixture-ticket", message: "Synthetic confirmation" }),
  pluginAction: async (_plugin, name, args, project) => {
    actions.push({ name, args, project });
    if (name === "connect") ready = true;
    if (name === "disconnect") ready = false;
    if (name === "status")
      return {
        ready,
        editors: [editor],
        projectRoot: `C:/fixture/${project ?? "Alpha"}`,
        detail: "Open the selected project in Unity, then connect.",
        editor: {
          unityVersion: editor.version,
          isCompiling: compiling,
          isUpdating: false,
          isPlaying: playing,
          isPaused: paused,
          isChangingPlayMode: false,
          activeScene: scene,
        },
      };
    if (name === "play") playing = true;
    if (name === "stop") {
      playing = false;
      paused = false;
    }
    if (name === "pause") paused = Boolean((args as { paused: boolean }).paused);
    if (name === "hierarchy")
      return { items: [{ id: "fixture-camera", name: "Camera <literal>", active: true, depth: 0 }], nextOffset: null };
    if (name === "scenes") return { scenes: [scene] };
    if (name === "build-scenes")
      return { supportedTargets: ["StandaloneWindows64"], activeTarget: "StandaloneWindows64" };
    if (name === "inspect-object")
      return { name: "Camera <literal>", position: [1, 2, 3], components: [{ type: "UnityEngine.Camera" }] };
    if (name === "console") return { entries: [{ type: "warning", message: "Fixture warning <literal>" }] };
    if (name === "verify") return { healthy: true };
    if (name === "assets") return { items: [{ path: "Assets/Tower.glb", type: "GameObject" }], nextOffset: null };
    if (name === "inspect-asset") return { path: "Assets/Tower.glb", type: "GameObject", bytes: 4096 };
    if (name === "capture-camera")
      return {
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      };
    if (name === "run-tests" || name === "build-player") {
      const job = {
        id: `fixture-job-${jobs.size}`,
        kind: name === "run-tests" ? "tests" : "build",
        state: "queued",
        cancelSupported: name === "run-tests",
      };
      jobs.set(job.id, job);
      return job;
    }
    const id = (args as { id?: string })?.id;
    if (name === "cancel-job" && id) {
      const job = jobs.get(id);
      if (job) job.state = "cancelled";
      return job;
    }
    if (name === "job-status" && id) return jobs.get(id);
    return { ok: true };
  },
});
window.studio = api.api;

function game(name: string): GameProject {
  return {
    name,
    dir: `C:/fixture/${name}`,
    title: `${name} · Очень длинное название проекта Unity для проверки переноса`,
    createdAt: "2026-10-09",
    pathLabel: `C:/fixture/${name}`,
    library: false,
    built: false,
    shape: {
      kind: "unity",
      entry: "ProjectSettings/ProjectVersion.txt",
      main: "Assets",
      build: null,
      install: null,
      own: true,
      serve: ".",
    },
  };
}
let chooseMode: (value: Mode) => void = () => {};
let chooseGame: (value: string) => void = () => {};
let chooseHeader: (value: "unity" | "browser") => void = () => {};
function Fixture() {
  const [currentMode, setMode] = useState<Mode>(mode);
  const [selected, setSelected] = useState("Alpha");
  const [view, setView] = useState<StageView>(StageView.Live);
  const [headerKind, setHeaderKind] = useState<"unity" | "browser">("unity");
  chooseHeader = setHeaderKind;
  chooseMode = (value) => {
    mode = value;
    setMode(value);
    if (value === "ready") resolvePanel?.(panel);
  };
  chooseGame = setSelected;
  const plugin: PluginInfo = {
    manifest: { ...(manifest as PluginManifest), version: currentMode === "error" ? "0.1.1" : "0.1.0" },
    source: PluginSourceKind.Bundled,
    enabled: currentMode !== "disabled",
    removed: false,
    health: PluginHealth.Ready,
    state: currentMode === "disabled" ? "disabled" : "enabled",
  };
  const folder = game(selected);
  if (headerKind === "browser") folder.shape.kind = "studio-template";
  // Only fields read by the production header are needed; no chat/provider hooks run here.
  const headerParts = {
    props: {
      sidebarHidden: false,
      onToggleSidebar: () => {},
      onShowLive: () => headerActions.push({ name: "show-live" }),
      onRename: () => {},
    },
    chat: {
      project: selected,
      threadId: "fixture-thread",
      folder,
      chatTitle: folder.title,
      isStudioThread: false,
      isDraft: false,
    },
    composer: { compact: { compacting: false, compactNow: () => {} } },
  } as unknown as ChatParts;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ChatPanelHeader
        {...headerParts}
        chatExport={{
          exporting: false,
          exportGame: (project) => () => headerActions.push({ name: "browser-export", project }),
        }}
      />
      <UnityStage
        game={game(selected)}
        plugins={[plugin]}
        view={view}
        onView={setView}
        onNotice={() => {}}
        threadId={null}
      />
    </div>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Fixture root is missing");
createRoot(container).render(<Fixture />);
Object.assign(window, {
  unityFixture: {
    mode: (value: Mode) => chooseMode(value),
    project: (name: string) => chooseGame(name),
    header: (kind: "unity" | "browser") => chooseHeader(kind),
    headerActions: () => headerActions,
    compiling: (value: boolean) => {
      compiling = value;
      window.dispatchEvent(new Event("focus"));
    },
    connection: (value: boolean) => {
      ready = value;
    },
    finishJob: (id: string) => {
      const job = jobs.get(id);
      if (job) {
        job.state = "completed";
        job.result = { result: "Succeeded", outputPath: `Builds/Genex/${id}/Game.exe` };
      }
    },
    actions: () => actions,
    calls: () => api.calls,
  },
});
