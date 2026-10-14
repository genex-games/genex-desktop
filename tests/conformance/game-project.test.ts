/**
 * The stack, kind and destination vocabularies (`shared/game-project.ts`) and the per-stack
 * tables beside them: which stack a kind is, where each stack can play, which stacks compile,
 * which lock file a compiled stack keeps and what each host can build per stack. The Rust · wgpu
 * stack and the mobile destinations are vocabulary first: until their lanes land nothing accepts
 * a mobile destination as input. Since raylib creation was retired (M6) the stack destinations imply
 * is Rust · wgpu beyond the browser and Three.js for the browser alone, never raylib.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ALL_BUILD_TARGETS,
  BUILD_TARGETS,
  BuildTarget,
  GameStack,
  isBuildTarget,
  isCompiledStack,
  isGameStack,
  MOBILE_TARGETS,
  ProjectKind,
  STACK_OF_KIND,
  STACK_TARGETS,
  stackForTargets,
  stackOf,
} from "../../src/shared/game-project.ts";
import { HOST_MATRIX, STACK_HOST_MATRIX, TargetRefusal } from "../../src/shared/game-targets.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import { DestinationError, GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  LOCK_FILE_OF_STACK,
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainId,
} from "../../src/shared/toolchain.ts";

// Compile-time rows: an exhaustive table that forgets a member does not typecheck. If one of
// these stops being an error (a member was removed), `npm run typecheck` fails on the directive.
// @ts-expect-error a stack table without rust-wgpu is incomplete
const STACK_TABLE_WITHOUT_RUST: Record<GameStack, number> = { [GameStack.ThreeJs]: 1, [GameStack.RaylibCpp]: 2 };
// @ts-expect-error a destination table without the mobile destinations is incomplete
const TARGET_TABLE_WITHOUT_MOBILE: Record<BuildTarget, number> = { web: 1, macos: 2, windows: 3, linux: 4 };
// @ts-expect-error a kind table without the Rust kind is incomplete
const KIND_TABLE_WITHOUT_RUST: Record<ProjectKind, number> = {
  "studio-template": 1,
  "three-vite": 2,
  "three-modules": 3,
  canvas2d: 4,
  phaser: 5,
  "engine-export": 6,
  "own-script": 7,
  "raylib-cpp": 8,
};

describe("the Rust · wgpu stack and the mobile destinations in the vocabulary", () => {
  it("spells each new member in its wire value", () => {
    assert.equal(GameStack.RustWgpu, "rust-wgpu");
    assert.equal(ProjectKind.RustWgpu, "rust-wgpu");
    assert.equal(BuildTarget.Ios, "ios");
    assert.equal(BuildTarget.Android, "android");
    assert.deepEqual(MOBILE_TARGETS, ["ios", "android"]);
    assert.deepEqual(ALL_BUILD_TARGETS, ["web", "macos", "windows", "linux", "ios", "android"]);
    // The compile-time tables above exist to fail the typecheck; reading them keeps them used.
    assert.equal(Object.keys(STACK_TABLE_WITHOUT_RUST).length, 2);
    assert.equal(Object.keys(TARGET_TABLE_WITHOUT_MOBILE).length, 4);
    assert.equal(Object.keys(KIND_TABLE_WITHOUT_RUST).length, 8);
  });

  it("knows rust-wgpu as a stack, and nothing that only looks like one", () => {
    assert.equal(isGameStack("rust-wgpu"), true);
    for (const stack of Object.values(GameStack)) assert.equal(isGameStack(stack), true, stack);
    for (const hostile of ["rust", "Rust-Wgpu", "rust-wgpu ", "", null, 1, {}, ["rust-wgpu"], "constructor"])
      assert.equal(isGameStack(hostile), false, String(hostile));
  });

  it("accepts as input only the destinations the studio offers today: mobile ones are vocabulary only", () => {
    assert.deepEqual(BUILD_TARGETS, ["web", "macos", "windows", "linux"]);
    for (const target of BUILD_TARGETS) assert.equal(isBuildTarget(target), true, target);
    for (const target of MOBILE_TARGETS) assert.equal(isBuildTarget(target), false, target);
  });
});

/** The stack a kind is expected to be: raylib and Rust are their own, every other kind is a browser game. */
function expectedStack(kind: ProjectKind): GameStack {
  if (kind === ProjectKind.RaylibCpp) return GameStack.RaylibCpp;
  if (kind === ProjectKind.RustWgpu) return GameStack.RustWgpu;
  return GameStack.ThreeJs;
}

describe("per-stack tables", () => {
  it("names the stack of every kind", () => {
    for (const kind of Object.values(ProjectKind)) {
      assert.equal(STACK_OF_KIND[kind], expectedStack(kind), kind);
      assert.equal(stackOf({ kind }), expectedStack(kind), kind);
    }
  });

  it("names where each stack can play: Three.js in the browser, raylib on web and desktop, Rust everywhere", () => {
    assert.deepEqual(STACK_TARGETS[GameStack.ThreeJs], [BuildTarget.Web]);
    // Raylib's row is its own four, not BUILD_TARGETS, so a phone lane landing cannot widen it.
    assert.deepEqual(STACK_TARGETS[GameStack.RaylibCpp], [
      BuildTarget.Web,
      BuildTarget.Mac,
      BuildTarget.Windows,
      BuildTarget.Linux,
    ]);
    assert.deepEqual(STACK_TARGETS[GameStack.RustWgpu], ALL_BUILD_TARGETS);
  });

  it("calls raylib and Rust compiled stacks, and Three.js not", () => {
    assert.equal(isCompiledStack(GameStack.RaylibCpp), true);
    assert.equal(isCompiledStack(GameStack.RustWgpu), true);
    assert.equal(isCompiledStack(GameStack.ThreeJs), false);
  });

  it("implies Rust · wgpu for any desktop destination and Three.js otherwise; raylib is never implied", () => {
    const subsets = (1 << BUILD_TARGETS.length) - 1;
    for (let mask = 1; mask <= subsets; mask++) {
      const targets = BUILD_TARGETS.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const desktop = targets.some((target) => target !== BuildTarget.Web);
      // Flipped (M6.0): desktop destinations implied C++ · raylib until its creation was retired.
      assert.equal(stackForTargets(targets), desktop ? GameStack.RustWgpu : GameStack.ThreeJs, targets.join("+"));
    }
    // Flipped (M6.0): naming raylib for a browser game forced it; now the destinations decide.
    assert.equal(stackForTargets([BuildTarget.Web], GameStack.RaylibCpp), GameStack.ThreeJs);
    assert.equal(stackForTargets([BuildTarget.Web], GameStack.RustWgpu), GameStack.RustWgpu);
  });

  it("gives each compiled stack its own lock file, raylib's unchanged", () => {
    assert.equal(LOCK_FILE_OF_STACK[GameStack.RaylibCpp], "current-lock.json");
    assert.equal(LOCK_FILE_OF_STACK[GameStack.RustWgpu], "current-lock.rust-wgpu.json");
  });

  it("names the Rust components in their wire spelling, and raylib still needs the same ones", () => {
    assert.equal(ToolchainId.Rust, "rust");
    assert.equal(ToolchainId.RustStdWasm, "rust-std-wasm32");
    assert.equal(ToolchainId.WasmBindgen, "wasm-bindgen");
    assert.equal(ToolchainId.Binaryen, "binaryen");
    assert.equal(ToolchainId.RustVendor, "rust-vendor");
    assert.equal(STACK_REQUIRED_COMPONENTS[GameStack.RaylibCpp], REQUIRED_COMPONENTS);
    for (const target of MOBILE_TARGETS) assert.deepEqual(REQUIRED_COMPONENTS[target], [], target);
    const rust = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu];
    for (const target of [BuildTarget.Web, BuildTarget.Mac]) assert.ok(rust[target].includes(ToolchainId.Rust), target);
    assert.ok(rust[BuildTarget.Web].includes(ToolchainId.WasmBindgen));
  });

  it("keeps raylib's host matrix, and lets Rust build only where its lane runs: a Mac and the Linux Studio", () => {
    assert.equal(STACK_HOST_MATRIX[GameStack.RaylibCpp], HOST_MATRIX);
    // Flipped (M4.0): the Windows and Linux destinations joined a Mac's row, and the Linux Studio got its own.
    // Flipped (M5.9): a Mac builds both phones, the Linux Studio Android; nothing runs a phone build.
    assert.deepEqual(STACK_HOST_MATRIX[GameStack.RustWgpu][StudioPlatform.Mac], {
      build: [
        BuildTarget.Web,
        BuildTarget.Mac,
        BuildTarget.Windows,
        BuildTarget.Linux,
        BuildTarget.Ios,
        BuildTarget.Android,
      ],
      run: [BuildTarget.Web, BuildTarget.Mac],
    });
    // Flipped (M4 review): the Linux Studio runs no Rust Linux build until one is prepared and boxed.
    assert.deepEqual(STACK_HOST_MATRIX[GameStack.RustWgpu][StudioPlatform.Linux], {
      build: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Android],
      run: [BuildTarget.Web],
    });
    assert.deepEqual(STACK_HOST_MATRIX[GameStack.RustWgpu][StudioPlatform.Windows], { build: [], run: [] });
    for (const host of Object.values(StudioPlatform))
      assert.deepEqual(STACK_HOST_MATRIX[GameStack.ThreeJs][host], {
        build: [BuildTarget.Web],
        run: [BuildTarget.Web],
      });
  });
});

describe("the new refusals", () => {
  it("spells kind-unsupported, stack-gated and toolchain-offline once, shared by the native refusals", () => {
    assert.equal(TargetRefusal.KindUnsupported, "kind-unsupported");
    assert.equal(TargetRefusal.StackGated, "stack-gated");
    assert.equal(TargetRefusal.ToolchainOffline, "toolchain-offline");
    assert.equal(NativeRefusal.KindUnsupported, TargetRefusal.KindUnsupported);
    assert.equal(NativeRefusal.StackGated, TargetRefusal.StackGated);
    assert.equal(NativeRefusal.ToolchainOffline, TargetRefusal.ToolchainOffline);
  });
});

describe("asking for a Rust game before its lane lands", () => {
  const repo = path.resolve(import.meta.dirname, "../..");

  async function library() {
    const base = await tmpDir("studio-rust-gated-");
    const root = path.join(base, "library");
    const games = new GameWorkspaces({
      root,
      templateDir: path.join(repo, "src", "game-template"),
      vendorDir: path.join(base, "vendor"),
      indexFile: path.join(base, "projects.json"),
      userData: path.join(base, "userData"),
      homeDir: base,
      platform: "darwin",
    });
    return { games, root };
  }

  const gated = (error: unknown) => error instanceof DestinationError && error.code === TargetRefusal.StackGated;

  it("is refused stack-gated and makes no folder, never a Three.js game in its place", async () => {
    const { games, root } = await library();
    for (const targets of [undefined, [BuildTarget.Web], [BuildTarget.Web, BuildTarget.Mac]])
      await assert.rejects(games.create("Pond", { stack: GameStack.RustWgpu, ...(targets ? { targets } : {}) }), gated);
    await assert.rejects(games.scaffold("pond", { stack: GameStack.RustWgpu }), gated);
    const made = await readdir(root).catch(() => []);
    assert.deepEqual(made, []);
  });
});
