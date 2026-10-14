/**
 * Create game's "Where will people play?" (`src/renderer/create-game-destinations.ts`): the boxes
 * the person ticks, the compiled stack the dialog makes (Rust · wgpu where offered, never
 * C++ · raylib since M6.3) and the host decide what is refused or only labelled here, the exact
 * `createGame` call the dialog makes, and when the Toolchain sheet opens.
 * The dialog itself is a `.tsx` the conformance runner cannot load; `run-create-game-ui.mjs` drives it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  GameStack,
  StackDefaultSwitch,
} from "../../src/shared/game-project.ts";
import { TargetRefusal } from "../../src/shared/game-targets.ts";
import {
  type ToolchainDownload,
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainHost,
  ToolchainId,
  type ToolchainStatus,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import { sheetView, sizeWords } from "../../src/renderer/panels/toolchain-view.ts";
import { TOOLCHAIN_WORDS } from "../../src/renderer/words.ts";
import {
  asksToolchains,
  browserOnlyRefusal,
  compiledChoice,
  createGameArgs,
  DEFAULT_DESTINATION_CHECKS,
  destinationChoice,
  NOTHING_OFFERED,
  rustSetupReady,
  sheetOffer,
  shownStack,
  type StackGate,
  stackOffer,
} from "../../src/renderer/create-game-destinations.ts";
import { DESTINATION_WORDS } from "../../src/renderer/words.ts";

const { Web, Mac, Windows, Linux } = BuildTarget;
const { RaylibCpp, RustWgpu, ThreeJs } = GameStack;
/**
 * The phone boxes Create game does not list: not a destination this dialog makes (a Rust game names
 * a phone later). Flipped (M6 review): they were `stack-gated`, which stopped being true when M6.4
 * released Rust creation.
 */
const MOBILE_UNLISTED = {
  [BuildTarget.Ios]: TargetRefusal.NotADestination,
  [BuildTarget.Android]: TargetRefusal.NotADestination,
};
const PARENT = "/Users/fixture/Projects";
/** What the browser build of a C++ game needs, and what a Mac build adds. */
const WEB = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource];
const MAC = [...WEB, ToolchainId.AngleMac];
const ALL = [...new Set(BUILD_TARGETS.flatMap((target) => REQUIRED_COMPONENTS[target]))];
/** What a Rust · wgpu game's Browser and Mac builds need, in table order. */
const RUST_SETUP: readonly ToolchainId[] = [
  ...new Set([Web, Mac].flatMap((target) => STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu][target])),
];

const EMSDK_BYTES = 356 * 1024 * 1024;
const ZIG_BYTES = 52_238_004;

/** What the bundled ANGLE builds copy from the app's resources (`native/angle/bundle-lock.json`). */
const ANGLE_MAC_BYTES = 7_053_062;
const ANGLE_WINDOWS_BYTES = 11_994_569;
const ANGLE_LINUX_BYTES = 17_376_008;
const RESERVE_BYTES = 256 * 1024 * 1024;

/** The downloads every host's status lists for the ANGLE builds Genex ships: copied, never downloaded. */
const BUNDLED_ANGLE: readonly ToolchainDownload[] = [
  { id: ToolchainId.AngleMac, version: "c5bf49e78850", bytes: 0, diskBytes: ANGLE_MAC_BYTES, bundled: true },
  { id: ToolchainId.AngleWindows, version: "c5bf49e78850", bytes: 0, diskBytes: ANGLE_WINDOWS_BYTES, bundled: true },
  { id: ToolchainId.AngleLinux, version: "c5bf49e78850", bytes: 0, diskBytes: ANGLE_LINUX_BYTES, bundled: true },
];

/**
 * As a Mac's store answers before Windows or Linux is set up: the Mac's own tools are in,
 * Emscripten and zig have pinned downloads, the Windows and Linux ANGLE builds come with Genex,
 * and only the Linux headers are pinned but not published. `linuxHeaders`: a store that holds them
 * (the developer's, or once Genex publishes them).
 */
function onMac(linuxHeaders = false): ToolchainStatus {
  const installed = MAC.filter((id) => id !== ToolchainId.Emsdk);
  return {
    ...store(linuxHeaders ? [...installed, ToolchainId.LinuxSysroot] : installed),
    downloads: [
      { id: ToolchainId.Emsdk, version: "6.0.10", bytes: EMSDK_BYTES, diskBytes: 5 * EMSDK_BYTES },
      { id: ToolchainId.Zig, version: "0.16.0", bytes: ZIG_BYTES, diskBytes: 5 * ZIG_BYTES },
      ...BUNDLED_ANGLE,
    ],
    freeBytes: 40 * 1024 * 1024 * 1024,
    reserveBytes: RESERVE_BYTES,
    unhosted: linuxHeaders ? [] : [{ id: ToolchainId.LinuxSysroot, reason: ToolchainUnhosted.NotPublished }],
  };
}

/** A store holding `ids` at one version, on an Apple silicon Mac with or without the Command Line Tools. */
function store(ids: readonly ToolchainId[], clt = true): ToolchainStatus {
  return {
    host: ToolchainHost.MacArm64,
    clt: { present: clt, version: null },
    installed: ids.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })),
    lock: null,
    job: null,
    storeBytes: 0,
  };
}

/** An online Apple-silicon Mac whose store has answered and whose build makes Rust games: where Rust · wgpu is offered. */
const RUST_HOST: StackGate = {
  platform: StudioPlatform.Mac,
  toolchainHost: ToolchainHost.MacArm64,
  rustCreation: true,
  online: true,
};

/** The compiled stack the dialog makes on a host, or none (a browser game). */
type CompiledStackOrNone = CompiledStack | undefined;

describe("create game destinations", () => {
  // Flipped (M6.3): this row made a C++ · raylib game on Linux; raylib creation is retired, so the
  // Linux Studio's compiled game is Rust · wgpu, with the same boxes refused and labelled.
  it("Linux Rust creation keeps the chosen Browser and Linux destinations, with Mac refused and Windows selectable", () => {
    const choice = destinationChoice([Web, Linux, Mac], RustWgpu, StudioPlatform.Linux);
    assert.deepEqual(choice.targets, [Web, Linux]);
    assert.equal(choice.disabled[Windows], null);
    assert.equal(choice.notes[Windows], TargetRefusal.NotRunnableHere);
    assert.equal(choice.disabled[Mac], TargetRefusal.MacBuildsNeedAMac);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong", { stack: RustWgpu, targets: [Web, Linux] }]);
  });
  it("Browser is the default, and alone with no compiled stack it sends no stack: a Three.js game, called as before", () => {
    assert.deepEqual(DEFAULT_DESTINATION_CHECKS, [Web]);
    const choice = destinationChoice([Web], undefined, StudioPlatform.Mac);
    assert.equal(choice.stack, undefined);
    assert.deepEqual(choice.targets, [Web]);
    assert.equal(shownStack(choice), GameStack.ThreeJs);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong"]);
    assert.deepEqual(createGameArgs("Space Pong", choice, PARENT), ["Space Pong", { parent: PARENT }]);
  });

  // Flipped (M6.3): ticking Mac used to flip the stack to raylib-cpp. With no compiled stack
  // offered (a packaged build, offline, an Intel Mac) a desktop box now implies nothing: refused.
  it("with no compiled stack offered, a desktop box is refused and never implies a stack", () => {
    const choice = destinationChoice([Web, Mac], undefined, StudioPlatform.Mac);
    assert.equal(choice.stack, undefined);
    assert.equal(choice.disabled[Mac], TargetRefusal.StackGated);
    assert.deepEqual(choice.targets, [Web]);
    assert.equal(shownStack(choice), ThreeJs);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong"]);
    assert.deepEqual(createGameArgs("Pong", choice, PARENT), ["Pong", { parent: PARENT }]);
  });

  // Flipped (M6.3): any desktop box used to mean raylib-cpp.
  it("no desktop box implies a stack, with or without Browser; offline the refusal says so", () => {
    for (const desktop of [Mac, Windows, Linux]) {
      for (const checked of [[desktop], [Web, desktop]]) {
        const choice = destinationChoice(checked, undefined, StudioPlatform.Mac);
        assert.equal(choice.stack, undefined, desktop);
        assert.equal(choice.disabled[desktop], TargetRefusal.StackGated, desktop);
        assert.ok(!choice.targets.includes(desktop), desktop);
      }
      const offline = destinationChoice([desktop], undefined, StudioPlatform.Mac, TargetRefusal.ToolchainOffline);
      assert.equal(offline.disabled[desktop], TargetRefusal.ToolchainOffline, desktop);
      assert.equal(createGameArgs("Pong", offline), null, `${desktop}: nothing to create`);
    }
  });

  // Flipped (M6.3): the C++ override sent raylib-cpp with [web]; the compiled entry is Rust now.
  it("where Rust is offered, Browser alone sends rust-wgpu with [web]", () => {
    const choice = destinationChoice([Web], RustWgpu, StudioPlatform.Mac);
    assert.equal(choice.stack, RustWgpu);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong", { stack: RustWgpu, targets: [Web] }]);
  });

  // Flipped (M6.3): the dialog opened on C++ · raylib; it opens on the stack its offer starts on.
  it("on a Mac the dialog opens with Browser ticked, on Rust where offered, and Mac offered", () => {
    const { initial } = stackOffer(RUST_HOST);
    assert.equal(initial, RustWgpu);
    const choice = destinationChoice(DEFAULT_DESTINATION_CHECKS, initial, StudioPlatform.Mac);
    assert.equal(choice.disabled[Mac], null, "Mac can be ticked");
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong", { stack: RustWgpu, targets: [Web] }]);
    assert.deepEqual(createGameArgs("Pong", destinationChoice([Web, Mac], initial, StudioPlatform.Mac)), [
      "Pong",
      { stack: RustWgpu, targets: [Web, Mac] },
    ]);
  });

  it("targets keep the table's order once each, whatever order the boxes were ticked in", () => {
    assert.deepEqual(destinationChoice([Linux, Mac, Web, Mac], RustWgpu, StudioPlatform.Mac).targets, [
      Web,
      Mac,
      Linux,
    ]);
  });

  it("off a Mac the Mac box is disabled with mac-builds-need-a-mac, and a stray Mac is never sent", () => {
    const linux = destinationChoice([Web, Mac], RustWgpu, StudioPlatform.Linux);
    assert.equal(linux.disabled[Mac], TargetRefusal.MacBuildsNeedAMac);
    assert.deepEqual(linux.targets, [Web]);
    assert.deepEqual(createGameArgs("Pong", linux), ["Pong", { stack: RustWgpu, targets: [Web] }]);
    for (const target of [Web, Windows, Linux]) assert.equal(linux.disabled[target], null, `linux ${target}`);
    // Windows builds no compiled stack: the dialog makes a browser game there.
    const windows = destinationChoice([Web, Mac], undefined, StudioPlatform.Windows);
    assert.equal(windows.disabled[Mac], TargetRefusal.MacBuildsNeedAMac);
    assert.deepEqual(windows.targets, [Web]);
    assert.equal(windows.stack, undefined, "without Mac the game is a browser game");
    assert.deepEqual(createGameArgs("Pong", windows), ["Pong"]);
  });

  it("Windows and Linux on a Mac carry not-runnable-here; Browser and Mac carry nothing and nothing is disabled", () => {
    const choice = destinationChoice([Web], RustWgpu, StudioPlatform.Mac);
    assert.deepEqual(choice.notes, {
      [Web]: null,
      [Mac]: null,
      [Windows]: TargetRefusal.NotRunnableHere,
      [Linux]: TargetRefusal.NotRunnableHere,
      ...MOBILE_UNLISTED,
    });
    assert.deepEqual(choice.disabled, { [Web]: null, [Mac]: null, [Windows]: null, [Linux]: null, ...MOBILE_UNLISTED });
  });

  it("on Linux the Windows box is the cross-build; on Windows, which makes no compiled game, both are refused", () => {
    const linux = destinationChoice([Web], RustWgpu, StudioPlatform.Linux);
    assert.equal(linux.notes[Windows], TargetRefusal.NotRunnableHere);
    assert.equal(linux.notes[Linux], null);
    const windows = destinationChoice([Web], undefined, StudioPlatform.Windows);
    assert.equal(windows.disabled[Windows], TargetRefusal.StackGated);
    assert.equal(windows.disabled[Linux], TargetRefusal.StackGated);
    assert.equal(windows.disabled[Web], null);
  });

  it("the host matrix: each host's refused boxes and notes, for the stack the dialog makes there", () => {
    const rows: Array<
      [StudioPlatform, CompiledStackOrNone, Record<string, string | null>, Record<string, string | null>]
    > = [
      [
        StudioPlatform.Mac,
        RustWgpu,
        { [Web]: null, [Mac]: null, [Windows]: null, [Linux]: null, ...MOBILE_UNLISTED },
        {
          [Web]: null,
          [Mac]: null,
          [Windows]: TargetRefusal.NotRunnableHere,
          [Linux]: TargetRefusal.NotRunnableHere,
          ...MOBILE_UNLISTED,
        },
      ],
      [
        StudioPlatform.Windows,
        undefined,
        {
          [Web]: null,
          [Mac]: TargetRefusal.MacBuildsNeedAMac,
          [Windows]: TargetRefusal.StackGated,
          [Linux]: TargetRefusal.StackGated,
          ...MOBILE_UNLISTED,
        },
        { [Web]: null, [Mac]: null, [Windows]: null, [Linux]: null, ...MOBILE_UNLISTED },
      ],
      [
        StudioPlatform.Linux,
        RustWgpu,
        { [Web]: null, [Mac]: TargetRefusal.MacBuildsNeedAMac, [Windows]: null, [Linux]: null, ...MOBILE_UNLISTED },
        { [Web]: null, [Mac]: null, [Windows]: TargetRefusal.NotRunnableHere, [Linux]: null, ...MOBILE_UNLISTED },
      ],
    ];
    for (const [host, chosen, disabled, notes] of rows) {
      const choice = destinationChoice([Web, Mac, Windows, Linux], chosen, host);
      assert.deepEqual(choice.disabled, disabled, host);
      assert.deepEqual(choice.notes, notes, host);
      const ticked = BUILD_TARGETS.filter((target) => disabled[target] === null);
      assert.deepEqual(choice.targets, ticked, `${host}: every box it builds for is sent`);
    }
  });

  it("an unknown host disables nothing it cannot judge for a compiled game, and says no desktop build runs here", () => {
    const choice = destinationChoice([Web, Mac], RustWgpu, null);
    assert.deepEqual(choice.targets, [Web, Mac]);
    for (const target of BUILD_TARGETS) assert.equal(choice.disabled[target], null, target);
    for (const target of [Mac, Windows, Linux]) assert.equal(choice.notes[target], TargetRefusal.NotRunnableHere);
    const browser = destinationChoice([Web, Mac], undefined, null);
    assert.deepEqual(browser.targets, [Web], "with no compiled stack, only the browser");
  });

  it("nothing checked means no call, with or without a compiled stack; a blank name means no call", () => {
    assert.deepEqual(destinationChoice([], undefined, StudioPlatform.Mac).targets, []);
    assert.equal(createGameArgs("Pong", destinationChoice([], undefined, StudioPlatform.Mac)), null);
    assert.equal(createGameArgs("Pong", destinationChoice([], RustWgpu, StudioPlatform.Mac)), null);
    assert.equal(createGameArgs("Pong", destinationChoice([Mac], RustWgpu, StudioPlatform.Linux)), null);
    assert.equal(createGameArgs("   ", destinationChoice([Web], undefined, StudioPlatform.Mac)), null);
    assert.deepEqual(createGameArgs("  Pong ", destinationChoice([Web], undefined, StudioPlatform.Mac)), ["Pong"]);
  });

  it("no choice the dialog can make sends C++ · raylib, on any host, gate or set of boxes", () => {
    const hosts = [...Object.values(StudioPlatform), null];
    const gates: StackGate[] = [];
    for (const platform of hosts)
      for (const toolchainHost of [...Object.values(ToolchainHost), null, undefined])
        for (const rustCreation of [true, false])
          for (const online of [true, false]) gates.push({ platform, toolchainHost, rustCreation, online });
    const subsets = (1 << BUILD_TARGETS.length) - 1;
    for (const gate of gates) {
      const offer = stackOffer(gate);
      assert.ok(!(offer.stacks as readonly GameStack[]).includes(RaylibCpp), JSON.stringify(gate));
      for (let mask = 0; mask <= subsets; mask++) {
        const checked = BUILD_TARGETS.filter((_target, bit) => mask & (1 << bit));
        const choice = destinationChoice(
          checked,
          compiledChoice(offer.initial),
          gate.platform,
          browserOnlyRefusal(offer),
        );
        const args = createGameArgs("Pong", choice);
        assert.ok(!JSON.stringify(args ?? []).includes(RaylibCpp), `${JSON.stringify(gate)} ${checked.join("+")}`);
      }
    }
  });
});

// Flipped (M6.3): these rows held the C++ setup the dialog offered for an implied raylib game.
// The dialog makes Rust · wgpu now, so its sheet rows are Rust's; the C++ sheet's own view is
// still held below (`sheetView`), for existing raylib games.
describe("the Toolchain sheet from Create game", () => {
  it("offers the complete Rust setup on the first compiled choice without adding game destinations", () => {
    const choice = destinationChoice([Web], RustWgpu, StudioPlatform.Mac);
    const offered = sheetOffer(store([]), choice, NOTHING_OFFERED);
    assert.equal(offered?.stack, RustWgpu);
    assert.deepEqual(offered?.components, RUST_SETUP);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong", { stack: RustWgpu, targets: [Web] }]);
    assert.equal(
      sheetOffer(store([]), destinationChoice([Web, Mac], RustWgpu, StudioPlatform.Mac), offered!),
      null,
      "switching targets does not offer the same setup again",
    );
  });

  it("a store answer for a choice that stopped being compiled opens nothing", () => {
    // The offer withdrawn before the store answered (an Intel Mac): the latest choice is a browser game.
    assert.equal(sheetOffer(store([]), destinationChoice([Web], undefined, StudioPlatform.Mac), NOTHING_OFFERED), null);
    assert.equal(sheetOffer(store([]), destinationChoice([], RustWgpu, StudioPlatform.Mac), NOTHING_OFFERED), null);
  });

  it("the store is asked when a compiled choice reaches a destination it has not been asked about", () => {
    const choice = (checked: readonly BuildTarget[], rust = true) =>
      destinationChoice(checked, rust ? RustWgpu : undefined, StudioPlatform.Mac);
    assert.equal(asksToolchains(choice([Web], false), []), false, "a browser game asks nothing");
    assert.equal(asksToolchains(choice([Web]), []), true, "the compiled entry asks for the browser build");
    assert.equal(asksToolchains(choice([Web, Mac]), [Web]), true);
    assert.equal(asksToolchains(choice([Web, Mac]), [Web, Mac]), false, "asked already");
    assert.equal(asksToolchains(choice([Mac]), [Web, Mac]), false, "unticking asks nothing");
    assert.equal(asksToolchains(choice([Web, Mac, Linux]), [Web, Mac]), true);
    assert.equal(asksToolchains(choice([Mac, Windows], false), []), false, "refused boxes build nothing");
    assert.equal(
      asksToolchains(destinationChoice([Mac], RustWgpu, StudioPlatform.Linux), []),
      false,
      "a refused box builds nothing",
    );
  });
});

describe("the Toolchain sheet with the ANGLE builds Genex ships", () => {
  it("the sheet lists zig and ANGLE for Windows, which comes with Genex, and the Linux headers it has not published", () => {
    const view = sheetView(onMac(), null, [Web, Windows, Linux]);
    // Flipped (wave 6, owner decision 19:05): Genex ships ANGLE for Windows and Linux, so only the
    // Linux headers wait; Windows installs (zig and its ANGLE are listed), Linux waits with its own.
    assert.deepEqual(
      view.rows.map((row) => [row.id, row.download?.bytes ?? null, row.unhosted, sizeWords(row.download)]),
      [
        [ToolchainId.Emsdk, EMSDK_BYTES, null, TOOLCHAIN_WORDS.size(EMSDK_BYTES)],
        [ToolchainId.Zig, ZIG_BYTES, null, TOOLCHAIN_WORDS.size(ZIG_BYTES)],
        [ToolchainId.AngleWindows, 0, null, TOOLCHAIN_WORDS.included],
        [ToolchainId.LinuxSysroot, null, ToolchainUnhosted.NotPublished, TOOLCHAIN_WORDS.unavailable],
      ],
    );
    assert.equal(TOOLCHAIN_WORDS.included, "Included with Genex");
    assert.equal(
      view.need,
      5 * EMSDK_BYTES + 5 * ZIG_BYTES + ANGLE_WINDOWS_BYTES + RESERVE_BYTES,
      "Emscripten and zig unpacked, ANGLE's copy, and the reserve",
    );
    assert.equal(view.unpinned, 0, "every missing part is pinned");
    assert.deepEqual(view.notYet, [Linux]);
    assert.equal(TOOLCHAIN_WORDS.notYet(view.notYet), "Linux isn’t available yet");
    assert.equal(TOOLCHAIN_WORDS.notYet([Windows, Linux]), "Windows and Linux aren’t available yet");
    assert.equal(view.canInstall, true);
  });

  it("zig and ANGLE for Linux wait with Linux: listed only for a destination the install can finish", () => {
    const linux = sheetView(onMac(), null, [Web, Linux]);
    assert.deepEqual(
      linux.rows.map((row) => row.id),
      [ToolchainId.Emsdk, ToolchainId.LinuxSysroot],
      "only Linux needs zig and its ANGLE",
    );
    assert.deepEqual(linux.notYet, [Linux]);
    assert.equal(linux.need, 5 * EMSDK_BYTES + RESERVE_BYTES);
    const windows = sheetView(onMac(), null, [Windows]);
    assert.deepEqual(
      windows.rows.map((row) => [row.id, sizeWords(row.download)]),
      [
        [ToolchainId.Zig, TOOLCHAIN_WORDS.size(ZIG_BYTES)],
        [ToolchainId.AngleWindows, TOOLCHAIN_WORDS.included],
      ],
    );
    assert.deepEqual([windows.notYet, windows.canInstall], [[], true], "Windows alone installs now");
    assert.deepEqual(sheetView(onMac(), null, [Web]).notYet, [], "the browser build waits on nothing");
    assert.equal(sheetView(onMac(), null, [Linux]).canInstall, false, "Linux alone has nothing it can finish");
  });

  it("with the Linux headers in the store, ANGLE for Linux is listed too, included with Genex, and nothing waits", () => {
    const view = sheetView(onMac(true), null, [Windows, Linux]);
    assert.deepEqual(
      view.rows.map((row) => [row.id, sizeWords(row.download)]),
      [
        [ToolchainId.Zig, TOOLCHAIN_WORDS.size(ZIG_BYTES)],
        [ToolchainId.AngleWindows, TOOLCHAIN_WORDS.included],
        [ToolchainId.AngleLinux, TOOLCHAIN_WORDS.included],
      ],
    );
    assert.deepEqual(view.notYet, []);
    assert.equal(view.need, 5 * ZIG_BYTES + ANGLE_WINDOWS_BYTES + ANGLE_LINUX_BYTES + RESERVE_BYTES);
  });

  it("no ANGLE row ever says Not available yet, on any host, for any choice of destinations", () => {
    const angle = new Set<ToolchainId>([ToolchainId.AngleMac, ToolchainId.AngleWindows, ToolchainId.AngleLinux]);
    // Off a Mac the store lists the same bundled ANGLE builds (a destination artifact serves every
    // host); Linux and Windows hosts have no pinned CMake, Ninja or Emscripten yet.
    const elsewhere = (host: ToolchainHost): ToolchainStatus => ({
      ...store([]),
      host,
      downloads: [
        { id: ToolchainId.Zig, version: "0.16.0", bytes: ZIG_BYTES, diskBytes: 5 * ZIG_BYTES },
        ...BUNDLED_ANGLE,
      ],
      unhosted: [{ id: ToolchainId.LinuxSysroot, reason: ToolchainUnhosted.NotPublished }],
    });
    const statuses: Array<[string, ToolchainStatus]> = [
      ["mac", onMac()],
      ["mac with the Linux headers", onMac(true)],
      ["linux", elsewhere(ToolchainHost.LinuxX64)],
      ["windows", elsewhere(ToolchainHost.WindowsX64)],
    ];
    const subsets = (1 << BUILD_TARGETS.length) - 1;
    for (const [name, status] of statuses)
      for (let mask = 1; mask <= subsets; mask++) {
        const targets = BUILD_TARGETS.filter((_target, bit) => mask & (1 << bit));
        for (const row of sheetView(status, null, targets).rows.filter((listed) => angle.has(listed.id))) {
          assert.equal(sizeWords(row.download), TOOLCHAIN_WORDS.included, `${name} ${targets.join("+")} ${row.id}`);
          assert.equal(row.unhosted, null, `${name} ${targets.join("+")} ${row.id}`);
        }
      }
  });
});

describe("the stacks Create game offers (Rust · wgpu behind main's creation gate; never C++ · raylib)", () => {
  // Flipped (M6.3): C++ · raylib was offered and was the starting stack, with Rust · wgpu an
  // explicit choice beside it; raylib creation is retired, so Rust · wgpu is the one compiled
  // stack and, where offered, the one the dialog starts on (the M6.0 host default).
  it("on an Intel Mac or offline nothing compiled is offered: a browser game, and the desktop boxes say why", () => {
    const intel = stackOffer({ ...RUST_HOST, toolchainHost: null });
    assert.deepEqual(
      { ...intel },
      { stacks: [], unoffered: TargetRefusal.StackGated },
      "no toolchain host is pinned for an Intel Mac",
    );
    assert.equal(
      shownStack(destinationChoice(DEFAULT_DESTINATION_CHECKS, compiledChoice(intel.initial), StudioPlatform.Mac)),
      ThreeJs,
    );
    const offline = stackOffer({ ...RUST_HOST, online: false });
    assert.deepEqual(
      { ...offline },
      { stacks: [], unoffered: TargetRefusal.ToolchainOffline },
      "a first Rust setup downloads",
    );
    const choice = destinationChoice(
      [Web, Mac],
      compiledChoice(offline.initial),
      StudioPlatform.Mac,
      offline.unoffered,
    );
    assert.equal(choice.disabled[Mac], TargetRefusal.ToolchainOffline);
    assert.deepEqual(createGameArgs("Pong", choice), ["Pong"]);
  });

  it("C++ · raylib is never offered, on any host, in any build, online or not", () => {
    for (const toolchainHost of [...Object.values(ToolchainHost), null, undefined])
      for (const platform of [...Object.values(StudioPlatform), null])
        for (const rustCreation of [true, false])
          for (const online of [true, false]) {
            const offer = stackOffer({ platform, toolchainHost, rustCreation, online });
            const label = `${platform} ${toolchainHost} ${rustCreation} ${online}`;
            assert.ok(!(offer.stacks as readonly GameStack[]).includes(RaylibCpp), label);
            assert.notEqual(offer.initial, RaylibCpp, label);
          }
  });

  // Flipped (M6.4): "a packaged build hides Rust on every host". Main's creation gate decides now
  // (`main/core/stack-gate.ts`): open in a release build where the Rust lane runs, closed elsewhere.
  it("a build whose creation gate is closed hides Rust on every host", () => {
    for (const toolchainHost of [...Object.values(ToolchainHost), null, undefined])
      for (const platform of [...Object.values(StudioPlatform), null]) {
        const offer = stackOffer({ platform, toolchainHost, rustCreation: false, online: true });
        assert.deepEqual(offer, { stacks: [], unoffered: TargetRefusal.StackGated }, `${platform} ${toolchainHost}`);
      }
  });

  // Flipped (M6 review): where Rust is offered the dialog listed it alone, so it could not make a
  // Three.js game; Three.js is listed beside it now, and the dialog still starts on Rust as shipped.
  it("an open gate offers Rust where its lane runs and starts on it, trusting the platform until the store answers", () => {
    assert.deepEqual(stackOffer(RUST_HOST), { stacks: [ThreeJs, RustWgpu], initial: RustWgpu });
    // Flipped (M6.3): before the store answered Rust was not offered; it is the compiled entry's
    // only stack now, so the platform's row is trusted as the C++ entry's was, and the store's
    // answer withdraws it where nothing is pinned (the Intel Mac row above).
    assert.deepEqual(stackOffer({ ...RUST_HOST, toolchainHost: undefined }), {
      stacks: [ThreeJs, RustWgpu],
      initial: RustWgpu,
    });
    const rows: Array<[StackGate, string]> = [
      [{ ...RUST_HOST, platform: StudioPlatform.Windows, toolchainHost: ToolchainHost.WindowsX64 }, "Windows"],
      [{ ...RUST_HOST, platform: StudioPlatform.Windows, toolchainHost: undefined }, "Windows before the store"],
      [{ ...RUST_HOST, platform: null }, "an unknown platform"],
    ];
    for (const [gate, why] of rows) assert.deepEqual(stackOffer(gate).stacks, [], why);
    const linux = { ...RUST_HOST, platform: StudioPlatform.Linux, toolchainHost: ToolchainHost.LinuxX64 };
    assert.deepEqual(
      stackOffer(linux),
      { stacks: [ThreeJs, RustWgpu], initial: RustWgpu },
      "the Linux Studio's Rust row",
    );
  });

  it("where Rust is offered, Three.js is a choice too, and it makes a browser game whose desktop boxes say why (M6 review)", () => {
    const offer = stackOffer(RUST_HOST);
    const choice = destinationChoice(
      [Web, Mac],
      compiledChoice(ThreeJs),
      StudioPlatform.Mac,
      browserOnlyRefusal(offer),
    );
    assert.equal(choice.stack, undefined);
    assert.equal(choice.disabled[Mac], TargetRefusal.NotADestination);
    assert.equal(shownStack(choice), ThreeJs);
    assert.deepEqual(createGameArgs("Cube", choice), ["Cube"]);
  });

  it("offline with Rust's setup already installed, Rust is still offered; without it, a browser game (M6 review)", () => {
    // `defaultStackFor` keeps Rust offline once its toolchain is here; the dialog now agrees.
    const ready = stackOffer({ ...RUST_HOST, online: false, rustToolchainReady: true });
    assert.deepEqual(ready, { stacks: [ThreeJs, RustWgpu], initial: RustWgpu });
    const choice = destinationChoice([Web, Mac], compiledChoice(ready.initial), StudioPlatform.Mac);
    assert.deepEqual(createGameArgs("Pond", choice), ["Pond", { stack: RustWgpu, targets: [Web, Mac] }]);
    for (const rustToolchainReady of [false, undefined]) {
      const gate: StackGate = { ...RUST_HOST, online: false };
      if (rustToolchainReady !== undefined) gate.rustToolchainReady = rustToolchainReady;
      assert.deepEqual(
        stackOffer(gate),
        { stacks: [], unoffered: TargetRefusal.ToolchainOffline },
        `${rustToolchainReady}`,
      );
    }
    assert.deepEqual(
      stackOffer({ ...RUST_HOST, online: false, rustToolchainReady: true, rustCreation: false }),
      { stacks: [], unoffered: TargetRefusal.ToolchainOffline },
      "an installed toolchain never opens a closed gate",
    );
  });

  it("the switch reverted starts on Three.js with Rust · wgpu one choice away, and never offers raylib (M6 review)", () => {
    const offer = stackOffer({ ...RUST_HOST, stackDefault: StackDefaultSwitch.ThreeJs });
    assert.deepEqual(offer, { stacks: [ThreeJs, RustWgpu], initial: ThreeJs });
    const start = destinationChoice(
      DEFAULT_DESTINATION_CHECKS,
      compiledChoice(offer.initial),
      StudioPlatform.Mac,
      browserOnlyRefusal(offer),
    );
    assert.deepEqual(createGameArgs("Cube", start), ["Cube"], "a Three.js browser game, called as always");
    const rust = destinationChoice([Web, Mac], compiledChoice(RustWgpu), StudioPlatform.Mac);
    assert.deepEqual(createGameArgs("Pond", rust), ["Pond", { stack: RustWgpu, targets: [Web, Mac] }]);
    assert.deepEqual(stackOffer({ ...RUST_HOST, stackDefault: StackDefaultSwitch.HostConditional }).initial, RustWgpu);
  });

  it("Rust's setup is ready when the store holds every component its host's setup prepares, Apple's tools included (M6 review)", () => {
    const entries = Object.fromEntries(RUST_SETUP.map((id) => [id, { version: "1", sha12: "000000000000" }]));
    const ready: ToolchainStatus = {
      ...store(RUST_SETUP),
      stackLocks: { [RustWgpu]: { version: 1, entries, digest: "0".repeat(64) } },
    };
    assert.equal(rustSetupReady(ready), true);
    assert.equal(rustSetupReady(store([])), false, "nothing installed");
    assert.equal(rustSetupReady({ ...ready, host: null }), false, "a host with no pinned Rust setup");
    assert.equal(
      rustSetupReady({ ...ready, clt: { present: false, version: null }, xcode: { present: false, version: null } }),
      false,
    );
  });

  it("the Rust · wgpu choice sends its stack and only the destinations its lane builds here", () => {
    const choice = destinationChoice([Web, Mac, Windows], RustWgpu, StudioPlatform.Mac);
    assert.equal(choice.stack, RustWgpu);
    assert.deepEqual(choice.targets, [Web, Mac, Windows]);
    assert.deepEqual(choice.disabled, { [Web]: null, [Mac]: null, [Windows]: null, [Linux]: null, ...MOBILE_UNLISTED });
    assert.deepEqual(choice.notes, {
      [Web]: null,
      [Mac]: null,
      [Windows]: TargetRefusal.NotRunnableHere,
      [Linux]: TargetRefusal.NotRunnableHere,
      ...MOBILE_UNLISTED,
    });
    assert.deepEqual(createGameArgs("Pond", choice), ["Pond", { stack: RustWgpu, targets: [Web, Mac, Windows] }]);
    assert.deepEqual(createGameArgs("Pond", destinationChoice([Web], RustWgpu, StudioPlatform.Mac)), [
      "Pond",
      { stack: RustWgpu, targets: [Web] },
    ]);
  });

  it("a Rust · wgpu choice asks the store for its own setup, and its sheet offers Rust components, never a C++ one", () => {
    const rust = destinationChoice([Web, Mac], RustWgpu, StudioPlatform.Mac);
    assert.equal(asksToolchains(rust, []), true);
    assert.equal(asksToolchains(rust, [Web, Mac]), false, "asked already for Rust");
    const cppInstalled = store([...new Set([...MAC, ToolchainId.Emsdk])]);
    const offer = sheetOffer(cppInstalled, rust, NOTHING_OFFERED);
    assert.equal(offer?.stack, RustWgpu);
    assert.deepEqual(offer?.components, RUST_SETUP);
    const cpp: readonly ToolchainId[] = ALL;
    assert.ok(!offer?.components.some((id) => cpp.includes(id)), "no C++ component is offered for a Rust game");
    assert.equal(sheetOffer(cppInstalled, rust, offer ?? NOTHING_OFFERED), null, "offered once per dialog");
  });

  it("a Rust · wgpu choice whose tools are in under the Rust lock opens nothing", () => {
    const rust = destinationChoice([Web, Mac], RustWgpu, StudioPlatform.Mac);
    const entries = Object.fromEntries(RUST_SETUP.map((id) => [id, { version: "1", sha12: "000000000000" }]));
    const ready: ToolchainStatus = {
      ...store(RUST_SETUP),
      stackLocks: { [RustWgpu]: { version: 1, entries, digest: "0".repeat(64) } },
    };
    assert.equal(sheetOffer(ready, rust, NOTHING_OFFERED), null);
  });

  it("a Rust choice offers Apple's tools for Mac when neither they nor Xcode are here, and not when Xcode is", () => {
    const rust = destinationChoice([Web, Mac], RustWgpu, StudioPlatform.Mac);
    assert.equal(sheetOffer(store(RUST_SETUP, false), rust, NOTHING_OFFERED)?.clt, true);
    const withXcode: ToolchainStatus = { ...store(RUST_SETUP, false), xcode: { present: true, version: "26.6" } };
    assert.equal(sheetOffer(withXcode, rust, NOTHING_OFFERED), null, "Xcode's copy of the tools builds for Mac");
  });

  it("offers Rust · wgpu on darwin-arm64 and linux-x64, pinned per host, never on win32-x64", () => {
    const platformOf = {
      [ToolchainHost.MacArm64]: StudioPlatform.Mac,
      [ToolchainHost.LinuxX64]: StudioPlatform.Linux,
      [ToolchainHost.WindowsX64]: StudioPlatform.Windows,
    } as const;
    // Literals, never read from the tables the dialog reads: the plan's red-first row names
    // darwin-arm64 and linux-x64. Flipped (M4.0): linux-x64 is offered since its Rust row landed.
    const expected = {
      [ToolchainHost.MacArm64]: true,
      [ToolchainHost.LinuxX64]: true,
      [ToolchainHost.WindowsX64]: false,
    } as const satisfies Record<ToolchainHost, boolean>;
    for (const host of Object.values(ToolchainHost)) {
      const offered = stackOffer({ ...RUST_HOST, platform: platformOf[host], toolchainHost: host }).stacks.includes(
        RustWgpu,
      );
      assert.equal(offered, expected[host], host);
    }
    assert.equal(
      stackOffer({ ...RUST_HOST, platform: StudioPlatform.Windows, toolchainHost: ToolchainHost.WindowsX64 }).stacks
        .length,
      0,
      "win32-x64 never: no compiled lane runs on Windows",
    );
  });

  it("each compiled stack names itself in the dialog's line; Three.js stays the browser line", () => {
    assert.equal(
      DESTINATION_WORDS.stackLine(RaylibCpp),
      "Made in C++ · raylib: one game, built for every place you pick.",
    );
    assert.equal(
      DESTINATION_WORDS.stackLine(RustWgpu),
      "Made in Rust · wgpu: one game, built for every place you pick.",
    );
    assert.equal(DESTINATION_WORDS.stackLine(ThreeJs), "Made in Three.js for the browser.");
  });
});
