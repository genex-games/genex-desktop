/** Home and its explicit compiled-game chooser (Rust behind main's creation gate; never C++), using real shell hooks and a fake host API. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppDialogs, useAppDialogs } from "../../src/renderer/panels/AppDialogs.tsx";
import { HomeLayer } from "../../src/renderer/shell/HomeScreen.tsx";
import { useComposerHandoff } from "../../src/renderer/shell/use-composer-handoff.ts";
import { useNavigation } from "../../src/renderer/shell/use-navigation.ts";
import { useShellChrome } from "../../src/renderer/shell/use-shell-chrome.ts";
import { useShellShortcuts } from "../../src/renderer/shell/use-shell-shortcuts.ts";
import { useWelcomeExit } from "../../src/renderer/shell/use-welcome-exit.ts";
import { useThreads } from "../../src/renderer/state/hooks.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { cppSetupTargets } from "../../src/shared/cpp-setup.ts";
import { type EngineDescriptor, EngineKind, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import {
  type BuildTarget,
  type GameLocation,
  type GameProject,
  GameStack,
  type StackDefaultSwitch,
} from "../../src/shared/game-project.ts";
import { setupTargets as rustSetupTargets } from "../../src/shared/stack-setup.ts";
import {
  PrewarmState,
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainStatus,
} from "../../src/shared/toolchain.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const MIB = 1024 * 1024;
const INSTALLED: readonly ToolchainId[] = [
  ToolchainId.Cmake,
  ToolchainId.Ninja,
  ToolchainId.RaylibSource,
  ToolchainId.AngleMac,
];
let setupFinished = false;
/** Whether the store holds Rust · wgpu's whole setup for this host (an offline Create game may then offer Rust). */
let rustReady = false;
/** The `navigator.onLine` the dialog reads; null: the window's own. */
let onlineOverride: boolean | null = null;
Object.defineProperty(navigator, "onLine", {
  configurable: true,
  get: () => onlineOverride ?? true,
});

/** The Rust components and lock of a store that holds Rust's whole setup on `host`. */
function rustInstalled(host: ToolchainHost) {
  const ids = [
    ...new Set(
      rustSetupTargets(GameStack.RustWgpu, host).flatMap(
        (target) => STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu][target],
      ),
    ),
  ];
  const entries = Object.fromEntries(ids.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return {
    installed: ids.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })),
    lock: { version: 1 as const, entries, digest: "1".repeat(64) },
  };
}

/** Host-accurate managed setup facts; the real sheet decides what to offer and install. */
function toolchainStatus(): ToolchainStatus {
  const host =
    document.documentElement.dataset.platform === StudioPlatform.Linux
      ? ToolchainHost.LinuxX64
      : ToolchainHost.MacArm64;
  const targets = cppSetupTargets(host);
  const components = [...new Set(targets.flatMap((target) => REQUIRED_COMPONENTS[target]))];
  const installed = setupFinished ? components : components.filter((id) => INSTALLED.includes(id));
  const downloads = [
    { id: ToolchainId.Emsdk, version: "6.0.10", bytes: 356 * MIB, diskBytes: 1800 * MIB },
    { id: ToolchainId.Zig, version: "0.16.0", bytes: 52_238_004, diskBytes: 261_190_020 },
    ...(
      [
        [ToolchainId.AngleMac, 7_053_062],
        [ToolchainId.AngleWindows, 11_994_569],
        [ToolchainId.AngleLinux, 17_376_008],
        [ToolchainId.LinuxSysroot, 4_718_276],
      ] as const
    ).map(([id, diskBytes]) => ({ id, version: "fixture", bytes: 0, diskBytes, bundled: true as const })),
  ].filter((row) => components.includes(row.id) && !installed.includes(row.id));
  const entries = Object.fromEntries(installed.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  const rust = rustReady ? rustInstalled(host) : null;
  return {
    host,
    clt: { present: host === ToolchainHost.MacArm64, version: host === ToolchainHost.MacArm64 ? "16.4" : null },
    installed: [
      ...installed.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })),
      ...(rust?.installed ?? []),
    ],
    lock: setupFinished ? { version: 1, entries, digest: "0".repeat(64) } : null,
    job: null,
    storeBytes: setupFinished ? 2200 * MIB : 0,
    downloads,
    freeBytes: 40 * 1024 * MIB,
    reserveBytes: 256 * MIB,
    unhosted: [],
    ...(setupFinished ? { prewarm: Object.fromEntries(targets.map((target) => [target, PrewarmState.Ready])) } : {}),
    // The Rust · wgpu setup beside it: none of its tools yet unless a row installed them, and no Xcode.
    xcode: { present: false, version: null },
    stackLocks: { [GameStack.RustWgpu]: rust?.lock ?? null },
    keptPreRust: [],
  };
}
const ENGINE: EngineDescriptor = {
  id: "fixture",
  label: "Fixture",
  kind: EngineKind.Direct,
  status: { code: EngineStatusCode.Ready, detail: "Fixture" },
  defaultModel: "fixture",
  models: [{ id: "fixture", label: "Fixture", contextWindow: 10000, supportsTools: true, supportsVision: true }],
};
interface SheetSpy {
  opened: number;
  open: boolean;
  targets: BuildTarget[];
  onClose?: (ready: boolean) => void;
}
declare global {
  interface Window {
    __toolchainSheet?: SheetSpy;
  }
}
document.documentElement.dataset.platform = StudioPlatform.Mac;
let nextLocation: GameLocation | Error | null = { dir: "/Users/fixture/Projects", pathLabel: "~/Projects" };
const fake = fakeStudioApi({
  engines: async () => [ENGINE],
  toolchainStatus: async () => toolchainStatus(),
  toolchainInstall: async () => {
    setupFinished = true;
    const job = { phase: ToolchainInstallPhase.Installed, entry: null, completed: 0, total: 0, startedAt: "fixture" };
    fake.emit({ type: UiEvent.ToolchainInstall, payload: job });
    return job;
  },
  pickGameLocation: async () => {
    if (nextLocation instanceof Error) throw nextLocation;
    return nextLocation;
  },
  createGame: async (title) => ({ name: "space-pong", title }) as GameProject,
  nameGame: async () => ({ title: "Browser game" }),
  threadForGame: async (project) => ({
    id: "created-game",
    agent_id: "studio",
    created_at: "",
    updated_at: "",
    latest_event_id: null,
    metadata: { kind: ThreadKind.Game, project },
  }),
});
window.studio = fake.api;
const app = studio();
app.session.setState({ status: SessionStatus.Ready, welcoming: false });
app.engines.setState({ list: [ENGINE] });
app.library.setState({ rootLabel: "~/AI Games" });
initializeAppearance();
let remount = () => {};
let welcome = async (_idea: string | null) => {};
Object.assign(window, {
  test: {
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    remount: () => {
      fake.calls.length = 0;
      window.__toolchainSheet = undefined;
      app.launch.setState({ launch: null, returned: null, planning: null });
      app.goHome();
      remount();
    },
    welcome: (idea: string | null) => {
      app.session.setState({ welcoming: true });
      requestAnimationFrame(() => void welcome(idea).then(() => app.finishWelcome()));
    },
    nextLocation: (location: GameLocation | { error: string } | null) => {
      nextLocation = location && "error" in location ? new Error(location.error) : location;
    },
    platform: (platform: StudioPlatform) => {
      document.documentElement.dataset.platform = platform;
    },
    setupFinished: (ready: boolean) => {
      setupFinished = ready;
    },
    sheet: () => {
      const spy = window.__toolchainSheet;
      return spy ? { opened: spy.opened, open: spy.open, targets: spy.targets } : null;
    },
    closeSheet: (ready: boolean) => window.__toolchainSheet?.onClose?.(ready),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
    /** Main's Rust · wgpu creation gate (open in a developer run, and in a release build where the Rust lane runs). */
    rustCreation: (on: boolean) => app.session.setState({ rustCreation: on }),
    /** The `stackDefault` switch main read from the settings. */
    stackDefault: (value: StackDefaultSwitch) => app.session.setState({ stackDefault: value }),
    /** Whether the store holds Rust's whole setup. */
    rustReady: (ready: boolean) => {
      rustReady = ready;
    },
    /** The computer going offline or back online, as the window's events say. */
    online: (on: boolean) => {
      onlineOverride = on;
      window.dispatchEvent(new Event(on ? "online" : "offline"));
    },
  },
});
function ShellFixture() {
  const dialogs = useAppDialogs();
  const active = useThreads((s) => s.activeThreadId);
  const handoff = useComposerHandoff(true, active);
  const chrome = useShellChrome(app, dialogs, true);
  const navigation = useNavigation(app, chrome, handoff);
  useShellShortcuts(dialogs, chrome, navigation, handoff.homeComposer);
  const exit = useWelcomeExit(app, handoff);
  welcome = exit.readyAfterWelcome;
  return (
    <>
      <button type="button" data-fixture-new onClick={navigation.newGame}>
        New game
      </button>
      <HomeLayer app={app} dialogs={dialogs} chrome={chrome} handoff={handoff} />
      <AppDialogs
        dialogs={dialogs}
        firstAsks={{}}
        onEnterProject={navigation.enterProject}
        onSelectThread={navigation.selectThread}
        onSelectGame={navigation.selectGame}
        onRemoveGame={navigation.removeGame}
      />
    </>
  );
}
function Fixture() {
  const [key, setKey] = useState(0);
  remount = () => setKey((n) => n + 1);
  return <ShellFixture key={key} />;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
