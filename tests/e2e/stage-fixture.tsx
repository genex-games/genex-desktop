/**
 * The stage strip over a compiled game, with the real strip over a fake host API: a Rust · wgpu
 * game and a C++ · raylib game, each standing or building, with the store's status for Rust tools
 * ready or missing, and Live's embedded run of the Rust game's Mac build (none, drawn, or ended).
 * `run-stage-ui.mjs` drives it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import type { LiveView } from "../../src/renderer/live-views.ts";
import { LiveRun } from "../../src/renderer/panels/stage/live-run.ts";
import { StageStrip } from "../../src/renderer/panels/stage/StageStrip.tsx";
import type { LaneRuns } from "../../src/renderer/panels/stage/destinations.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { nativeStoreFor } from "../../src/renderer/state/native.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import type { GameProject } from "../../src/renderer/types.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, type CompiledStack, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeRunMode, type NativeRunState } from "../../src/shared/native-contract.ts";
import { ObserverLive, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";
import { STACK_REQUIRED_COMPONENTS, ToolchainHost, type ToolchainStatus } from "../../src/shared/toolchain.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const TARGETS = [BuildTarget.Web, BuildTarget.Mac];
/** Live's one view of a compiled game: Genex's preview at the root, as PreviewPanel gives it. */
const COMPILED_VIEW: LiveView = { live: ObserverLive.Preview, at: ".", observer: PREVIEW_OBSERVER };
const KIND_OF = { [GameStack.RustWgpu]: ProjectKind.RustWgpu, [GameStack.RaylibCpp]: ProjectKind.RaylibCpp } as const;

/** A compiled game made for Browser and Mac. */
function game(stack: CompiledStack): GameProject {
  const name = stack === GameStack.RustWgpu ? "pond" : "pong-cpp";
  const kind = KIND_OF[stack];
  return {
    name,
    dir: `/Users/fixture/AI Games/${name}`,
    title: name,
    createdAt: "2026-10-07T00:00:00.000Z",
    pathLabel: `~/AI Games/${name}`,
    library: true,
    shape: { entry: "index.html", main: "src/main", build: null, install: null, own: false, kind, serve: "." },
    built: false,
    destinations: { stack, targets: TARGETS },
    facts: [],
  };
}

/** The store's status, with every Rust tool in under the Rust lock or none of them. */
function toolchain(rustReady: boolean): ToolchainStatus {
  const rust = [...new Set(TARGETS.flatMap((target) => STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu][target]))];
  const entries = Object.fromEntries(rust.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return {
    host: ToolchainHost.MacArm64,
    clt: { present: true, version: "16.4" },
    installed: rustReady ? rust.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })) : [],
    lock: null,
    stackLocks: { [GameStack.RustWgpu]: rustReady ? { version: 1, entries, digest: "1".repeat(64) } : null },
    job: null,
    storeBytes: 0,
  };
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({});
window.studio = fake.api;
studio().session.setState({ status: SessionStatus.Ready, welcoming: false });
initializeAppearance();

/** What the strip shows: the game's stack, whether a Mac build runs, whether its Rust tools are in, and Live's Mac run. */
interface Scene {
  stack: CompiledStack;
  building: boolean;
  rustReady: boolean;
  /** Live's embedded run of the game's Mac build; absent: none this session. */
  macRun?: NativeRunState;
}

/** Live's embedded run of `project`'s Mac build in the native store: `state`, or none. */
function embedRun(project: string, state: NativeRunState | undefined): void {
  const store = nativeStoreFor(studio().api);
  const status = state
    ? {
        project,
        runId: "fixture-embed",
        target: BuildTarget.Mac,
        state,
        mode: NativeRunMode.Embedded,
        pid: null,
        backend: null,
        refusal: null,
        problem: null,
        exit: null,
        owner: null,
        startedAt: "2026-10-23T00:00:00.000Z",
        endedAt: null,
      }
    : null;
  store.setState((now) => ({ ...now, embeds: { ...now.embeds, [project]: { view: null, status, failed: false } } }));
}
let show: (scene: Scene) => void = () => {};
Object.assign(window, {
  test: {
    show: (scene: Scene) => show(scene),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
  },
});

function Fixture() {
  const [scene, setScene] = useState<Scene>({ stack: GameStack.RustWgpu, building: false, rustReady: true });
  show = setScene;
  const loaded = game(scene.stack);
  embedRun(loaded.name, scene.macRun);
  const runs: LaneRuns = scene.building ? { [BuildTarget.Mac]: 1 } : {};
  return (
    <div className="flex h-screen flex-col bg-canvas">
      <StageStrip
        loaded={loaded}
        project={loaded.name}
        hasBuilds={false}
        buildsLive={false}
        beside={null}
        stageView={StageView.Live}
        live={{ views: [COMPILED_VIEW], shown: COMPILED_VIEW }}
        onTab={() => {}}
        behind={null}
        onReload={() => {}}
        run={{ state: LiveRun.Running, toggle: () => {} }}
        fullScreen={{ offered: false, enter: () => {} }}
        gameControls
        sound={{ on: true, toggle: () => {} }}
        emptyGame={false}
        livePreview
        plugins={[]}
        onNotice={() => {}}
        onToolbarOpen={() => {}}
        buildProblem={null}
        runs={runs}
        toolchain={toolchain(scene.rustReady)}
        liveView={null}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
