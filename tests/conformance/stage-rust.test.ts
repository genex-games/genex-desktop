/**
 * A Rust · wgpu game on the stage strip (`src/renderer/panels/stage/destinations.ts`): its
 * destinations get badges like a C++ game's, a running build names the Rust build stage, its Mac
 * build is shown by Live (it has no window of its own) and the Mac badge says In Live only while Live
 * draws it (`macRun`), and what its tools need is read from the
 * Rust components under the Rust lock, never from the C++ store. `run-stage-ui.mjs` renders it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BadgeFacts,
  BadgeState,
  destinationBadges,
  NO_RUNS,
  ToolsNeed,
  toolsNeeds,
} from "../../src/renderer/panels/stage/destinations.ts";
import { DESTINATION_WORDS } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { DestinationBadge } from "../../src/shared/game-targets.ts";
import { NativeRunState } from "../../src/shared/native-contract.ts";
import {
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainHost,
  type ToolchainId,
  type ToolchainStatus,
} from "../../src/shared/toolchain.ts";

const { Web, Mac } = BuildTarget;
const { RaylibCpp, RustWgpu } = GameStack;
const RUST = [...new Set([Web, Mac].flatMap((target) => STACK_REQUIRED_COMPONENTS[RustWgpu][target]))];
const CPP = [...new Set([Web, Mac].flatMap((target) => REQUIRED_COMPONENTS[target]))];

/** A Mac's store holding `ids`, with the Rust lock naming `locked` (absent: the host said nothing of Rust). */
function store(ids: readonly ToolchainId[], locked?: readonly ToolchainId[]): ToolchainStatus {
  const entries = Object.fromEntries((locked ?? []).map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return {
    host: ToolchainHost.MacArm64,
    clt: { present: true, version: null },
    installed: ids.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })),
    lock: null,
    job: null,
    storeBytes: 0,
    ...(locked ? { stackLocks: { [RustWgpu]: { version: 1, entries, digest: "0".repeat(64) } } } : {}),
  };
}

const ON_MAC = { host: StudioPlatform.Mac, gameBox: true, failed: null } as const;

/** The Mac badge of a Browser and Mac game standing on `facts`. */
const macBadge = (facts: BadgeFacts) => destinationBadges([Web, Mac], facts).find((badge) => badge.target === Mac);

describe("the stage strip for a Rust · wgpu game", () => {
  it("a running build names the Rust build stage out loud and never says C++", () => {
    const badges = destinationBadges([Web, Mac], { ...ON_MAC, runs: { [Mac]: 1 }, stack: RustWgpu });
    const mac = badges.find((badge) => badge.target === Mac);
    assert.equal(mac?.state, BadgeState.Building);
    assert.equal(mac?.loud, true);
    assert.equal(mac?.why, DESTINATION_WORDS.buildStage[RustWgpu]);
    assert.match(DESTINATION_WORDS.buildStage[RustWgpu], /Rust/);
    for (const badge of badges) assert.doesNotMatch(`${badge.text} ${badge.why ?? ""}`, /C\+\+/);
  });

  it("a C++ game's running build names its own stage", () => {
    const [badge] = destinationBadges([Web], { ...ON_MAC, runs: { [Web]: 1 }, stack: RaylibCpp });
    assert.equal(badge.why, DESTINATION_WORDS.buildStage[RaylibCpp]);
  });

  it("with no Mac build yet, its Mac badge never says In Live: Native builds it", () => {
    for (const macRun of [undefined, null, NativeRunState.Refused]) {
      const mac = macBadge({ ...ON_MAC, runs: NO_RUNS, stack: RustWgpu, macRun });
      assert.equal(mac?.state, BadgeState.NotBuilt, `embedded run ${String(macRun)}`);
      assert.equal(mac?.text, DESTINATION_WORDS.badge[DestinationBadge.NotBuilt]);
      assert.equal(mac?.why, DESTINATION_WORDS.nativeNotBuiltWhy);
      assert.equal(mac?.loud, false);
      assert.doesNotMatch(`${mac?.text} ${mac?.why}`, /In Live/);
    }
  });

  it("while Live draws its Mac build, the Mac badge says In Live · Native", () => {
    for (const macRun of [
      NativeRunState.Admitting,
      NativeRunState.Starting,
      NativeRunState.Ready,
      NativeRunState.Paused,
    ]) {
      const mac = macBadge({ ...ON_MAC, runs: NO_RUNS, stack: RustWgpu, macRun });
      assert.equal(mac?.state, BadgeState.InLive, macRun);
      assert.equal(mac?.text, DESTINATION_WORDS.inLiveNative);
    }
  });

  it("once Live's Mac run ended, its Mac build stands Built, a choice of Native away", () => {
    for (const macRun of [
      NativeRunState.Stopping,
      NativeRunState.Stopped,
      NativeRunState.Crashed,
      NativeRunState.Killed,
    ]) {
      const mac = macBadge({ ...ON_MAC, runs: NO_RUNS, stack: RustWgpu, macRun });
      assert.equal(mac?.state, BadgeState.Built, macRun);
      assert.equal(mac?.why, DESTINATION_WORDS.nativeBuiltWhy);
    }
  });

  it("a running Mac build still says Building, whatever Live's last run was", () => {
    const mac = macBadge({ ...ON_MAC, runs: { [Mac]: 1 }, stack: RustWgpu, macRun: NativeRunState.Stopped });
    assert.equal(mac?.state, BadgeState.Building);
  });

  it("a C++ game's Mac build keeps its own window, never Live's", () => {
    const cpp = destinationBadges([Mac], { ...ON_MAC, runs: NO_RUNS, stack: RaylibCpp });
    assert.equal(cpp[0]?.state, BadgeState.OwnWindow, "a C++ game keeps its own window");
  });

  it("its tools need is read from the Rust components, even when every C++ tool is installed", () => {
    const need = toolsNeeds([Web, Mac], { problems: [], status: store(CPP, []), stack: RustWgpu });
    assert.deepEqual(need, { [Web]: ToolsNeed.Install, [Mac]: ToolsNeed.Install });
  });

  it("with its Rust tools in under the Rust lock, no destination needs tools, whatever the C++ store holds", () => {
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [], status: store(RUST, RUST), stack: RustWgpu }), {});
  });

  it("a host that says nothing of the Rust lock leaves the word to the build problems", () => {
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [], status: store(RUST), stack: RustWgpu }), {});
  });
});
