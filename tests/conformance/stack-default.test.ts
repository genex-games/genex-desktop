/**
 * The host-conditional default stack (M6.0) and its rollback cases. A new game starts as Rust ·
 * wgpu where its lane runs (an Apple-silicon Mac, the Linux Studio) and as Three.js everywhere
 * else and on an offline first launch (`toolchain-offline`). The default sits behind a settings
 * switch: reverted, Three.js is the default on every host and Rust · wgpu stays creatable as an
 * explicit choice. C++ · raylib creation is never re-enabled by any switch, any host or any set of
 * destinations; existing raylib games are untouched. The named rollback cases: a downgrade opens a
 * Rust game read-only, the Rust lock is read back, an unknown kind stays read-only, the switch
 * reverted.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ALL_BUILD_TARGETS,
  BuildTarget,
  CREATABLE_STACKS,
  CreationRefusal,
  GameStack,
  isCreatableStack,
  parseStackDefaultSwitch,
  ProjectKind,
  SHIPPED_STACK_DEFAULT_SWITCH,
  StackDefaultSwitch,
  stackForTargets,
} from "../../src/shared/game-project.ts";
import { TargetRefusal } from "../../src/shared/game-targets.ts";
import {
  defaultStackFor,
  LOCK_FILE_OF_STACK,
  rustDefaultHost,
  StackDefaultReason,
  ToolchainHost,
} from "../../src/shared/toolchain.ts";
import { developmentStacksOpen } from "../../src/main/core/stack-gate.ts";
import { stackDefaultHere } from "../../src/main/project-policy.ts";
import { DestinationError, GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { readProjectShape } from "../../src/substrate/project-shape.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { registerThreadsIpc } from "../../src/main/ipc/threads.ts";
import type { IpcHandle } from "../../src/main/ipc/registrar.ts";
import type { Bootstrap } from "../../src/shared/studio-api.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { stackOffer } from "../../src/renderer/create-game-destinations.ts";
import { bootstrapReady, initialSession } from "../../src/renderer/state/session.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

/** Every computer the studio may run on, as `process.platform` and `process.arch` name it. */
const COMPUTERS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "freebsd", arch: "x64" },
] as const;

/** The computers where the Rust lane runs and so where Rust · wgpu is the default. */
const RUST_HOME = new Set(["darwin-arm64", "linux-x64"]);

const SWITCHES = Object.values(StackDefaultSwitch);

/** Every non-empty subset of `targets`. */
function* subsets(targets: readonly BuildTarget[]): Generator<BuildTarget[]> {
  for (let mask = 1; mask < 1 << targets.length; mask++) yield targets.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

/** Every host fact the default reads, for every computer. */
function* everyHost() {
  for (const computer of COMPUTERS)
    for (const online of [true, false])
      for (const rustToolchainReady of [true, false]) yield { ...computer, online, rustToolchainReady };
}

/** A library over the real templates, with the development gate for Rust open as a release with Rust has it. */
async function library() {
  const base = await tmpDir("studio-stack-default-");
  const vendorDir = path.join(base, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await writeFile(path.join(vendorDir, "three.module.js"), "export const REVISION = '0';\n");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(REPO, "src", "game-template"),
    rustTemplateDir: path.join(REPO, "src", "game-template-rust"),
    rustCreation: true,
    vendorDir,
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: "darwin",
  });
  return { games, base };
}

/** A digest of every file under `dir`, names and bytes, so "nothing written" is checked whole. */
async function treeDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(rel, entry.name);
      hash.update(child);
      if (entry.isDirectory()) await walk(child);
      else hash.update(await readFile(path.join(dir, child)));
    }
  };
  await walk(".");
  return hash.digest("hex");
}

const refusedWith = (code: string) => (error: unknown) => error instanceof DestinationError && error.code === code;

describe("the default stack per host", () => {
  it("ships the host-conditional switch: Rust · wgpu on an Apple-silicon Mac and the Linux Studio, Three.js elsewhere", () => {
    assert.equal(SHIPPED_STACK_DEFAULT_SWITCH, StackDefaultSwitch.HostConditional);
    for (const computer of COMPUTERS) {
      const home = RUST_HOME.has(`${computer.platform}-${computer.arch}`);
      const chosen = defaultStackFor(StackDefaultSwitch.HostConditional, {
        ...computer,
        online: true,
        rustToolchainReady: false,
      });
      assert.deepEqual(
        chosen,
        home
          ? { stack: GameStack.RustWgpu, why: StackDefaultReason.HostLane }
          : { stack: GameStack.ThreeJs, why: StackDefaultReason.NoLaneHere },
        `${computer.platform}-${computer.arch}`,
      );
    }
    assert.equal(rustDefaultHost("darwin", "arm64"), ToolchainHost.MacArm64);
    assert.equal(rustDefaultHost("linux", "x64"), ToolchainHost.LinuxX64);
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["win32", "x64"],
      ["linux", "arm64"],
    ])
      assert.equal(rustDefaultHost(platform, arch), null, `${platform}-${arch}`);
  });

  it("starts an offline first launch on Three.js with toolchain-offline, and Rust once its toolchain is here", () => {
    for (const computer of COMPUTERS.filter(({ platform, arch }) => RUST_HOME.has(`${platform}-${arch}`))) {
      const first = { ...computer, online: false, rustToolchainReady: false };
      assert.deepEqual(defaultStackFor(StackDefaultSwitch.HostConditional, first), {
        stack: GameStack.ThreeJs,
        why: StackDefaultReason.ToolchainOffline,
      });
      assert.equal(StackDefaultReason.ToolchainOffline, TargetRefusal.ToolchainOffline);
      const later = { ...computer, online: false, rustToolchainReady: true };
      assert.deepEqual(defaultStackFor(StackDefaultSwitch.HostConditional, later), {
        stack: GameStack.RustWgpu,
        why: StackDefaultReason.HostLane,
      });
    }
  });

  it("is decided for this computer from the setting, never from raylib's lane", () => {
    const here = stackDefaultHere({ setting: undefined, online: true, rustToolchainReady: true });
    const expected = defaultStackFor(SHIPPED_STACK_DEFAULT_SWITCH, {
      platform: process.platform,
      arch: process.arch,
      online: true,
      rustToolchainReady: true,
    });
    assert.deepEqual(here, expected);
    const reverted = stackDefaultHere({ setting: StackDefaultSwitch.ThreeJs, online: true, rustToolchainReady: true });
    assert.deepEqual(reverted, { stack: GameStack.ThreeJs, why: StackDefaultReason.SwitchReverted });
  });
});

describe("C++ · raylib creation is retired", () => {
  it("is never a creatable stack, and its refusal is spelled once", () => {
    assert.deepEqual(CREATABLE_STACKS, [GameStack.ThreeJs, GameStack.RustWgpu]);
    assert.equal(isCreatableStack(GameStack.RaylibCpp), false);
    assert.equal(isCreatableStack(GameStack.ThreeJs), true);
    assert.equal(isCreatableStack(GameStack.RustWgpu), true);
    assert.equal(isCreatableStack("rust-bevy"), false);
    assert.equal(CreationRefusal.RaylibCreationRetired, "raylib-creation-retired");
  });

  it("is never what destinations imply: a desktop or phone destination means Rust · wgpu, the browser alone Three.js", () => {
    for (const targets of subsets(ALL_BUILD_TARGETS)) {
      const compiled = targets.some((target) => target !== BuildTarget.Web);
      const implied = compiled ? GameStack.RustWgpu : GameStack.ThreeJs;
      assert.equal(stackForTargets(targets), implied, targets.join("+"));
      // Flipped (M6.0): naming raylib no longer forces it; the destinations decide.
      assert.equal(stackForTargets(targets, GameStack.RaylibCpp), implied, targets.join("+"));
      assert.equal(stackForTargets(targets, GameStack.RustWgpu), GameStack.RustWgpu, targets.join("+"));
    }
  });
});

describe("rollback cases", () => {
  it("switch reverted: Three.js is the default on every host, Rust · wgpu explicit, raylib never", async () => {
    for (const host of everyHost())
      for (const value of SWITCHES) {
        const chosen = defaultStackFor(value, host);
        assert.notEqual(chosen.stack, GameStack.RaylibCpp, `${value} ${JSON.stringify(host)}`);
        assert.ok(isCreatableStack(chosen.stack));
      }
    for (const host of everyHost())
      assert.deepEqual(defaultStackFor(StackDefaultSwitch.ThreeJs, host), {
        stack: GameStack.ThreeJs,
        why: StackDefaultReason.SwitchReverted,
      });
    // A reverted switch keeps Rust · wgpu creatable as an explicit choice.
    const { games } = await library();
    const pond = await games.create("Pond", { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] });
    assert.equal(pond.shape.kind, ProjectKind.RustWgpu);
    assert.deepEqual(pond.destinations, { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] });
    const plain = await games.create("Cube");
    assert.equal(plain.shape.kind, ProjectKind.StudioTemplate);
  });

  it("switch reverted through the product path: settings.json → main's bootstrap → Create game starts on Three.js, Rust one choice away (M6 review)", async () => {
    const lite = await coreLite({ init: false });
    await mkdir(lite.userData, { recursive: true });
    await writeFile(
      path.join(lite.userData, "settings.json"),
      JSON.stringify({ stackDefault: StackDefaultSwitch.ThreeJs }),
    );
    await lite.core.init();
    assert.equal(lite.core.settings.stackDefault, StackDefaultSwitch.ThreeJs, "main reads the stored switch");
    // Saving another setting keeps the switch on disk.
    await lite.core.updateSettings({ learning: false });
    const saved = JSON.parse(await readFile(path.join(lite.userData, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(saved.stackDefault, StackDefaultSwitch.ThreeJs);
    // Main's bootstrap carries it to the renderer.
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const handle = ((channel: string, fn: (payload: unknown) => Promise<unknown>) =>
      handlers.set(channel, fn)) as unknown as IpcHandle;
    registerThreadsIpc(handle, {
      core: lite.core,
      gamesRootLabel: () => "~/AI Games",
      threadStatus: () => ({}),
      pushUiEvent: () => {},
      appendErrorDurably: async () => {},
      smokeReads: null,
      welcome: false,
      developer: false,
      rustCreation: true,
      playWeb: "https://genex.games",
      engines: { bootstrap: async () => [] },
    });
    const bootstrap = handlers.get("studio:bootstrap");
    assert.ok(bootstrap);
    const boot = (await bootstrap(undefined)) as Bootstrap;
    assert.equal(boot.stackDefault, StackDefaultSwitch.ThreeJs);
    // The renderer's session and Create game's offer on a host where Rust is offered.
    const session = bootstrapReady(initialSession(), {
      rustCreation: boot.rustCreation,
      stackDefault: boot.stackDefault,
    });
    const offer = stackOffer({
      platform: StudioPlatform.Mac,
      toolchainHost: ToolchainHost.MacArm64,
      rustCreation: session.rustCreation,
      online: true,
      stackDefault: session.stackDefault,
    });
    assert.deepEqual(offer, { stacks: [GameStack.ThreeJs, GameStack.RustWgpu], initial: GameStack.ThreeJs });
    assert.ok(!(offer.stacks as readonly GameStack[]).includes(GameStack.RaylibCpp));
    await lite.close();
  });

  it("an unset switch reaches no bootstrap field, and Create game starts on Rust where it is offered", async () => {
    const lite = await coreLite();
    assert.equal(lite.core.settings.stackDefault, undefined);
    const session = bootstrapReady(initialSession(), { rustCreation: true });
    assert.equal(session.stackDefault, SHIPPED_STACK_DEFAULT_SWITCH);
    const offer = stackOffer({
      platform: StudioPlatform.Mac,
      toolchainHost: ToolchainHost.MacArm64,
      rustCreation: true,
      online: true,
      stackDefault: session.stackDefault,
    });
    assert.equal(offer.initial, GameStack.RustWgpu);
    await lite.close();
  });

  it("unknown switch value: the shipped default, never raylib", () => {
    for (const value of [undefined, null, "", "raylib-cpp", GameStack.RaylibCpp, 7, { stack: "raylib-cpp" }])
      assert.equal(parseStackDefaultSwitch(value), SHIPPED_STACK_DEFAULT_SWITCH, JSON.stringify(value));
    for (const value of SWITCHES) assert.equal(parseStackDefaultSwitch(value), value);
  });

  // A characterization: no older Studio runs here, so the downgrade is the read an older Studio
  // makes of a kind its vocabulary lacks (the same read as the unknown-kind row below, named for the case).
  it("downgrade (characterized as the kind-unsupported read): a Studio without rust-wgpu opens a Rust game read-only and writes nothing", async () => {
    const { games, base } = await library();
    const pond = await games.create("Pond", { stack: GameStack.RustWgpu });
    const recorded = JSON.parse(await readFile(path.join(pond.dir, "studio.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual([recorded.kind, recorded.stack], [ProjectKind.RustWgpu, GameStack.RustWgpu]);
    // What an older Studio meets: a folder whose recorded kind its own vocabulary lacks. Moved out
    // of the library and re-recorded as a kind this version lacks, it is the same folder to that reader.
    const dir = path.join(base, "older-view");
    await rename(pond.dir, dir);
    await writeFile(path.join(dir, "studio.json"), JSON.stringify({ ...recorded, kind: "rust-wgpu-next" }));
    const shape = await readProjectShape(dir);
    assert.equal(shape.readOnly, TargetRefusal.KindUnsupported);
    assert.deepEqual([shape.build, shape.install], [null, null]);
    const before = await treeDigest(dir);
    const opened = await games.adopt(dir);
    assert.equal(opened.shape.readOnly, TargetRefusal.KindUnsupported);
    await assert.rejects(
      games.setDestinations(opened.name, [BuildTarget.Web]),
      refusedWith(TargetRefusal.KindUnsupported),
    );
    assert.equal(await treeDigest(dir), before);
  });

  it("lock read: a Rust game's lock is its own file and is read back whatever the switch says", async () => {
    assert.equal(LOCK_FILE_OF_STACK[GameStack.RaylibCpp], "current-lock.json");
    assert.notEqual(LOCK_FILE_OF_STACK[GameStack.RustWgpu], LOCK_FILE_OF_STACK[GameStack.RaylibCpp]);
    const { games } = await library();
    const pond = await games.create("Pond", { stack: GameStack.RustWgpu });
    await games.writeNativeLock(pond.name, "b".repeat(64));
    for (const value of SWITCHES) {
      assert.ok(
        isCreatableStack(defaultStackFor(value, { ...COMPUTERS[0], online: true, rustToolchainReady: true }).stack),
      );
      assert.deepEqual(await games.nativeLocks(), ["b".repeat(64)], value);
    }
  });

  it("unknown kind: a newer Genex's game stays read-only, never re-read as the default stack", async () => {
    const base = await tmpDir("studio-stack-default-unknown-");
    const dir = path.join(base, "fjord");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({ name: "fjord", kind: "rust-bevy", stack: "rust-bevy", main: "src/main.rs", build: "cargo run" }),
    );
    await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
    const shape = await readProjectShape(dir);
    assert.equal(shape.readOnly, TargetRefusal.KindUnsupported);
    assert.equal(shape.build, null);
    assert.equal(isCreatableStack("rust-bevy"), false);
  });
});

describe("desktop destinations after the retirement", () => {
  it("make a Rust · wgpu game, never a raylib one", async () => {
    const { games } = await library();
    // The create path's own refusal is M6.3's; here the contract: nothing it reads implies raylib.
    const implied = stackForTargets([BuildTarget.Web, BuildTarget.Linux]);
    assert.equal(implied, GameStack.RustWgpu);
    const made = await games.create("Linux pond", { stack: implied, targets: [BuildTarget.Web, BuildTarget.Linux] });
    assert.equal(made.shape.kind, ProjectKind.RustWgpu);
  });
});

describe("Rust · wgpu creation in a release build (M6.4)", () => {
  const RELEASE_HOSTS = [
    { platform: "darwin", arch: "arm64", open: true },
    { platform: "linux", arch: "x64", open: true },
    { platform: "darwin", arch: "x64", open: false },
    { platform: "win32", arch: "x64", open: false },
    { platform: "linux", arch: "arm64", open: false },
  ] as const;

  it("opens where the Rust lane runs (an Apple-silicon Mac, the Linux Studio) and stays stack-gated elsewhere", () => {
    for (const host of RELEASE_HOSTS) {
      const build = { release: true, platform: host.platform, arch: host.arch };
      assert.equal(developmentStacksOpen({}, build), host.open, `${host.platform}-${host.arch}`);
    }
  });

  it("is open in every developer build, and the core's option overrides the build either way", () => {
    for (const host of RELEASE_HOSTS) {
      const developer = { release: false, platform: host.platform, arch: host.arch };
      assert.equal(developmentStacksOpen({}, developer), true);
      for (const release of [true, false]) {
        const build = { release, platform: host.platform, arch: host.arch };
        assert.equal(developmentStacksOpen({ developmentStacks: false }, build), false);
        assert.equal(developmentStacksOpen({ developmentStacks: true }, build), true);
      }
    }
  });

  it("does not follow the default switch: reverted, Rust · wgpu stays creatable where its lane runs", () => {
    const build = { release: true, platform: "darwin", arch: "arm64" };
    const reverted = defaultStackFor(StackDefaultSwitch.ThreeJs, { ...build, online: true, rustToolchainReady: true });
    assert.equal(reverted.stack, GameStack.ThreeJs);
    assert.equal(developmentStacksOpen({}, build), true);
  });
});
