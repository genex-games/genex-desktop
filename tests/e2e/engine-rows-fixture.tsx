/**
 * A Rust game's engine rows (extension ladder level 5) under the real stage strip, over a fake host
 * API: `pond` builds with Genex's engine and is untrusted, `cove` runs its own ejected copy and is
 * trusted, and `pong-cpp` is a C++ game with no engine button. Eject answers the refusal the test
 * sets (`eject-needs-mac` by default); give-back and trust answer done. `run-engine-rows-ui.mjs`
 * drives it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { EngineRows, useEngineRows } from "../../src/renderer/panels/stage/EngineRows.tsx";
import type { LiveView } from "../../src/renderer/live-views.ts";
import { LiveRun } from "../../src/renderer/panels/stage/live-run.ts";
import { StageStrip } from "../../src/renderer/panels/stage/StageStrip.tsx";
import { StageView } from "../../src/renderer/stage.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import type { GameProject } from "../../src/renderer/types.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { type EngineState, ExtensionRefusal } from "../../src/shared/game-conformance.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { ObserverLive, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const TARGETS = [BuildTarget.Web, BuildTarget.Mac];
/** Live's one view of a compiled game: Genex's preview at the root, as PreviewPanel gives it. */
const COMPILED_VIEW: LiveView = { live: ObserverLive.Preview, at: ".", observer: PREVIEW_OBSERVER };

/** A game made for Browser and Mac. */
function game(name: string, rust: boolean): GameProject {
  const kind = rust ? ProjectKind.RustWgpu : ProjectKind.RaylibCpp;
  const stack = rust ? GameStack.RustWgpu : GameStack.RaylibCpp;
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

const GAMES: Record<string, GameProject> = {
  pond: game("pond", true),
  cove: game("cove", true),
  "pong-cpp": game("pong-cpp", false),
};
const STATES: Record<string, EngineState> = {
  pond: { project: "pond", ejectedFrom: null, trusted: false },
  cove: { project: "cove", ejectedFrom: "0.1.0", trusted: true },
};
let ejectRefusal: ExtensionRefusal | null = ExtensionRefusal.EjectNeedsMac;

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({
  engineState: async (project) => {
    const state = STATES[project];
    if (!state) throw new Error(`${project} is not a Rust game in the library`);
    return state;
  },
  engineEject: async (project) =>
    ejectRefusal
      ? { project, ok: false, refusal: ejectRefusal, ejectedFrom: null }
      : { project, ok: true, refusal: null, ejectedFrom: "0.1.0" },
  engineUneject: async (project) => ({ project, ok: true, refusal: null, ejectedFrom: null }),
  engineSetTrust: async (project, trusted) => ({ project, ok: true, refusal: null, trusted }),
});
window.studio = fake.api;
studio().session.setState({ status: SessionStatus.Ready, welcoming: false });
initializeAppearance();

let show: (name: string) => void = () => {};
Object.assign(window, {
  test: {
    show: (name: string) => show(name),
    ejectAnswers: (refusal: ExtensionRefusal | null) => {
      ejectRefusal = refusal;
    },
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
  },
});

function Fixture() {
  const [name, setName] = useState("pond");
  show = setName;
  const loaded = GAMES[name] ?? null;
  const engine = useEngineRows(loaded);
  if (!loaded) return null;
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
        sound={{ on: true, toggle: () => {} }}
        engine={engine}
        emptyGame={false}
        livePreview
        plugins={[]}
        onNotice={() => {}}
        onToolbarOpen={() => {}}
        buildProblem={null}
        runs={{}}
        toolchain={null}
        liveView={null}
      />
      {engine?.open ? <EngineRows game={loaded} onNotice={() => {}} /> : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
