/**
 * The Toolchain sheet per stack and Settings → Toolchains, with the real components over a fake
 * host API: a C++ store, and Rust · wgpu setups (Command Line Tools without Xcode, kept harness
 * parts to re-take, everything ready, and the phones: Xcode 26 with the iOS SDK and the person's
 * Android SDK whose licence they accept in the sheet). `run-toolchain-ui.mjs` drives it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { ToolchainSheet } from "../../src/renderer/panels/ToolchainSheet.tsx";
import { ToolchainsSection } from "../../src/renderer/panels/ToolchainsSection.tsx";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { type BuildTarget, type CompiledStack, GameStack } from "../../src/shared/game-project.ts";
import { SeedRetakeRefusal } from "../../src/shared/seed-retake.ts";
import { setupTargets } from "../../src/shared/stack-setup.ts";
import {
  type AndroidSetupStatus,
  REQUIRED_COMPONENTS,
  RUST_MOBILE_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainStatus,
  UserSideState,
  XcodeStatus,
} from "../../src/shared/toolchain.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const MIB = 1024 * 1024;
const HOST = ToolchainHost.MacArm64;
/** Where the fake re-take says it kept the agent's edit. */
const PATCH = "~/Library/Application Support/Genex/updates/seed-retake-fixture/loop/judge.ts.patch";

/** Every component a stack's setup prepares on this Mac. */
function componentsOf(stack: CompiledStack): ToolchainId[] {
  const table = stack === GameStack.RaylibCpp ? REQUIRED_COMPONENTS : STACK_REQUIRED_COMPONENTS[stack];
  return [...new Set(setupTargets(stack, HOST).flatMap((target) => table[target]))];
}

/** The setups the runner switches between. */
const SCENARIOS = {
  /** Apple's Command Line Tools, no Xcode, no Rust tools, two harness parts kept from before Rust games. */
  rustCltOnly: { clt: true, xcode: false, rust: false, kept: ["loop/judge.ts", "loop/review.ts"] },
  /** Xcode only (its copy of the tools), every Rust tool in under the Rust lock, nothing kept. */
  rustReady: { clt: false, xcode: true, rust: true, kept: [] as string[] },
  /** A C++ store missing Emscripten. */
  cpp: { clt: true, xcode: false, rust: false, kept: [] as string[] },
  /** Every Rust tool in, Xcode 26 with its iOS SDK, and the person's Android SDK with its licence not yet accepted. */
  rustPhones: { clt: true, xcode: true, rust: true, kept: [] as string[], phones: true },
} as const;
type Scenario = keyof typeof SCENARIOS;

let scenario: Scenario = "rustCltOnly";
let kept: string[] = [...SCENARIOS[scenario].kept];
/** Whether the person accepted the Android SDK licence in this scenario. */
let licenceAccepted = false;

/** The phones' store parts, each with a pinned download. */
const PHONE_STORE_PARTS = [
  ToolchainId.RustStdIos,
  ToolchainId.RustStdIosSim,
  ToolchainId.RustStdAndroid,
  ToolchainId.Bundletool,
  ToolchainId.Jdk,
];

/** The person's Android SDK: its platform and Build-Tools in, another NDK revision. */
function androidSetup(): AndroidSetupStatus {
  return {
    sdk: true,
    licenceAccepted,
    parts: {
      [ToolchainId.AndroidSdk]: UserSideState.Ready,
      [ToolchainId.AndroidBuildTools]: UserSideState.Ready,
      [ToolchainId.AndroidNdk]: UserSideState.OtherVersion,
    },
  };
}

/** The phones' facts for a scenario that has them: Xcode 26 ready, Android's SDK and the store's downloads. */
function phoneFacts(): Partial<ToolchainStatus> {
  if (!("phones" in SCENARIOS[scenario])) return {};
  const downloads = PHONE_STORE_PARTS.map((id) => ({ id, version: "1", bytes: 48 * MIB, diskBytes: 160 * MIB }));
  return {
    xcode: { present: true, version: "26.6", iosSdk: "26.5", status: XcodeStatus.Ready },
    android: androidSetup(),
    downloads,
  };
}

/** The store's answer for the current scenario. */
function toolchainStatus(): ToolchainStatus {
  const facts = SCENARIOS[scenario];
  const rust = componentsOf(GameStack.RustWgpu);
  const cpp = componentsOf(GameStack.RaylibCpp).filter((id) => id !== ToolchainId.Emsdk);
  const installed = facts.rust ? [...cpp, ...rust] : cpp;
  const entries = Object.fromEntries(rust.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return {
    host: HOST,
    clt: { present: facts.clt, version: facts.clt ? "16.4" : null },
    xcode: { present: facts.xcode, version: facts.xcode ? "26.6" : null },
    installed: installed.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 120 * MIB })),
    lock: null,
    stackLocks: { [GameStack.RustWgpu]: facts.rust ? { version: 1, entries, digest: "1".repeat(64) } : null },
    keptPreRust: [...kept],
    job: null,
    storeBytes: 2200 * MIB,
    downloads: [{ id: ToolchainId.Emsdk, version: "6.0.10", bytes: 356 * MIB, diskBytes: 1800 * MIB }],
    freeBytes: 40 * 1024 * MIB,
    reserveBytes: 256 * MIB,
    unhosted: [],
    ...phoneFacts(),
  };
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({
  toolchainStatus: async () => toolchainStatus(),
  retakeSeedModule: async (module) => {
    if (module !== "loop/judge.ts") return { ok: false, module, code: SeedRetakeRefusal.PatchExists };
    kept = kept.filter((item) => item !== module);
    return { ok: true, module, patchFile: PATCH, keptFile: PATCH.replace(/\.patch$/, "") };
  },
  toolchainAcceptAndroidLicence: async () => {
    licenceAccepted = true;
    return true;
  },
  toolchainInstallMobile: async (target) => ({
    phase: ToolchainInstallPhase.Preflight,
    entry: null,
    completed: 0,
    total: RUST_MOBILE_COMPONENTS[target].length,
    startedAt: "2026-10-07T00:00:00.000Z",
  }),
});
window.studio = fake.api;
const app = studio();
app.session.setState({ status: SessionStatus.Ready, welcoming: false, developer: true });
initializeAppearance();

/** What the page shows: the sheet for a stack, or Settings → Toolchains. */
type View = { kind: "sheet"; stack: CompiledStack } | { kind: "settings" };
let show: (view: View) => void = () => {};

Object.assign(window, {
  test: {
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    /** Opens `view` over `next`'s setup, from a fresh remount. */
    show: (view: View, next: Scenario) => {
      scenario = next;
      kept = [...SCENARIOS[next].kept];
      licenceAccepted = false;
      fake.calls.length = 0;
      show(view);
    },
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
  },
});

function Fixture() {
  const [view, setView] = useState<View & { key: number }>({ kind: "settings", key: 0 });
  show = (next) => setView((current) => ({ ...next, key: current.key + 1 }));
  if (view.kind === "settings")
    return (
      <div key={view.key} data-fixture-settings className="mx-auto max-w-2xl p-6">
        <ToolchainsSection />
      </div>
    );
  const targets: BuildTarget[] = [...setupTargets(view.stack, HOST)];
  return <ToolchainSheet key={view.key} open targets={targets} stack={view.stack} onClose={() => {}} />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
