/**
 * The phone exports as the core binds them (M5 integration): a Rust game's iPhone and Android
 * exports are offered where the host builds them, the export request and `game.export` accept a
 * phone, the core's services build the Simulator app on its own lane and the device build and the
 * Android package through the seam at the Rust lock, the packaging tools come from the person's SDK
 * and the store, and the menu labels a phone export untested on real devices and opens the sheet.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { exportAndroidGame } from "../../src/main/core/android-export-run.ts";
import {
  androidExportDeps,
  androidPackageTools,
  iosExportDeps,
  type MobileExportServices,
} from "../../src/main/core/mobile-export-deps.ts";
import { exportDestinationOf, type MobileExportGameRequest } from "../../src/main/core/native-export-run.ts";
import type { BuildOutcome, GameBuildGame } from "../../src/main/game-build.ts";
import { MobileBuild } from "../../src/main/rust-build-mobile.ts";
import { exportCaveat, exportDestinationsFor, exportOpensSheet } from "../../src/renderer/chat/use-chat-export.ts";
import { EXPORT_WORDS } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  exportsTo,
  MobileArtifact,
} from "../../src/shared/game-export-contract.ts";
import {
  BuildTarget,
  type GameProject,
  GameStack,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import { STACK_HOST_MATRIX } from "../../src/shared/game-targets.ts";
import { HARNESS_PARAM_SCHEMAS } from "../../src/shared/harness-api.ts";
import { setupTargets } from "../../src/shared/stack-setup.ts";
import { type ToolchainLock, ToolchainHost } from "../../src/shared/toolchain.ts";
import { NoticeRefusal } from "../../src/substrate/rust-notices.ts";

const { Web, Mac, Windows, Linux, Ios, Android } = BuildTarget;

const RUST_LOCK = { digest: "r".repeat(64) } as unknown as ToolchainLock;
const RAYLIB_LOCK = { digest: "c".repeat(64) } as unknown as ToolchainLock;

function rustGame(targets: BuildTarget[] = [Web, Ios, Android]): GameProject {
  return {
    name: "pond",
    dir: "/games/pond",
    title: "Pond",
    shape: { kind: ProjectKind.RustWgpu } as ProjectShape,
    destinations: { stack: GameStack.RustWgpu, targets },
  } as unknown as GameProject;
}

/** A lane outcome: built into `out` with one admitted file, or failed. */
function outcome(out: string | null): BuildOutcome {
  if (out === null) return { ok: false, output: null, lastGood: null, problem: null, ran: true };
  const receipt = { outputs: [{ path: "game", sha256: "a".repeat(64), bytes: 1 }] };
  return {
    ok: true,
    output: out,
    lastGood: out,
    problem: null,
    ran: true,
    rust: { refusal: null, diagnostics: [], receipt },
  } as unknown as BuildOutcome;
}

/** The core's services with recording lanes; every tool and probe answers what the row sets. */
function services(overrides: Partial<MobileExportServices> = {}) {
  const asked: Array<{ lane: string; target: BuildTarget; lock: ToolchainLock | null | undefined }> = [];
  const record = (lane: string) => async (game: GameBuildGame, target: BuildTarget) => {
    asked.push({ lane, target, lock: game.lock });
    return outcome(`/rust-builds/${lane}/out`);
  };
  const seam = record("seam");
  const base: MobileExportServices = {
    host: StudioPlatform.Mac,
    games: { bundleIdFor: async () => "games.genex.game.g0123456789ab" },
    gameBuilds: {
      ensure: async (game, target, purpose) => ({
        stack: GameStack.RustWgpu,
        target,
        purpose,
        refusal: null,
        outcome: await seam(game, target),
      }),
    },
    simulatorLane: { ensure: record("simulator") },
    toolchains: {
      currentLock: async (stack = GameStack.RaylibCpp) => (stack === GameStack.RustWgpu ? RUST_LOCK : RAYLIB_LOCK),
    },
    xcode: async () => ({ present: true, version: "26.6", iosSdk: "26.5", simulatorSdk: "26.5" }),
    androidSdk: async () => null,
    storeTools: async () => null,
    notices: async () => ({ ok: true, notices: [] }),
    sandboxFor: async () => assert.fail("no tool runs in these rows"),
    exportsRoot: "/exports",
    stagingRoot: "/export-staging",
    signingRoot: "/signing",
    secretPaths: ["/secrets", "/signing-keys/android-debug"],
    forbiddenRoots: ["/games"],
    keyHome: "/signing-keys/android-debug",
    home: "/home",
    env: {},
    secretValues: () => [],
    phonePackages: { admit: async () => assert.fail("no export in these rows reaches packaging") },
  };
  return { asked, services: { ...base, ...overrides } };
}

describe("a Rust game's phone exports are offered where the host builds them", () => {
  it("the export-run table exports a Rust game to both phones, and still never a C++ or three.js phone", () => {
    for (const target of [Ios, Android]) {
      assert.equal(exportsTo(GameStack.RustWgpu, target), true, target);
      assert.equal(exportsTo(GameStack.RaylibCpp, target), false, target);
      assert.equal(exportsTo(GameStack.ThreeJs, target), false, target);
    }
  });

  it("a Mac builds both phones and the Linux Studio Android; neither runs a phone build", () => {
    const rust = STACK_HOST_MATRIX[GameStack.RustWgpu];
    const macBuilds: readonly BuildTarget[] = rust[StudioPlatform.Mac].build;
    const linuxBuilds: readonly BuildTarget[] = rust[StudioPlatform.Linux].build;
    assert.ok(macBuilds.includes(Ios) && macBuilds.includes(Android));
    assert.ok(linuxBuilds.includes(Android) && !linuxBuilds.includes(Ios));
    for (const host of Object.values(StudioPlatform)) {
      const runs: readonly BuildTarget[] = rust[host].run;
      assert.ok(!runs.includes(Ios) && !runs.includes(Android), host);
    }
  });

  it("the menu offers a Rust game's phones on a Mac and Android on the Linux Studio, only where the game names them", () => {
    const game = rustGame([Web, Ios, Android]);
    assert.deepEqual(exportDestinationsFor(game, StudioPlatform.Mac), [Web, Ios, Android]);
    assert.deepEqual(exportDestinationsFor(game, StudioPlatform.Linux), [Web, Android]);
    assert.deepEqual(exportDestinationsFor(game, StudioPlatform.Windows), []);
    assert.deepEqual(exportDestinationsFor(rustGame([Web, Mac]), StudioPlatform.Mac), [Web]);
  });

  it("setup never prepares a phone: the phone rows do, with the person's own tools", () => {
    for (const host of Object.values(ToolchainHost)) {
      const prepared = setupTargets(GameStack.RustWgpu, host);
      assert.ok(!prepared.includes(Ios) && !prepared.includes(Android), host);
    }
    assert.ok(setupTargets(GameStack.RustWgpu, ToolchainHost.MacArm64).includes(Web));
  });

  it("an export request and game.export accept a phone; anything else is refused before anything runs", () => {
    assert.equal(exportDestinationOf(Ios), Ios);
    assert.equal(exportDestinationOf(Android), Android);
    for (const odd of ["iphone", "", 3, null])
      assert.throws(
        () => exportDestinationOf(odd),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.NotADestination,
      );
    const schema = HARNESS_PARAM_SCHEMAS["game.export"];
    for (const destination of [Ios, Android, Web, Windows, Linux])
      assert.equal(schema.safeParse({ project: "pond", destination }).success, true, destination);
    assert.equal(schema.safeParse({ project: "pond", destination: "iphone" }).success, false);
  });
});

describe("the core's phone export services", () => {
  it("builds a Simulator app on the Simulator lane and an IPA's device build through the seam, at the Rust lock", async () => {
    const { asked, services: s } = services();
    const deps = iosExportDeps(s);
    const simulator = await deps.build(rustGame(), MobileBuild.IosSimulator);
    const device = await deps.build(rustGame(), MobileBuild.IosDevice);
    assert.deepEqual(asked, [
      { lane: "simulator", target: Ios, lock: RUST_LOCK },
      { lane: "seam", target: Ios, lock: RUST_LOCK },
    ]);
    assert.equal(simulator?.out, "/rust-builds/simulator/out");
    assert.equal(device?.out, "/rust-builds/seam/out");
    assert.equal(path.basename(device?.buildLock ?? ""), "Cargo.lock");
    assert.equal(device?.outputs.length, 1);
  });

  it("answers no iPhone build when the lane's build failed", async () => {
    const { services: s } = services({ simulatorLane: { ensure: async () => outcome(null) } });
    assert.equal(await iosExportDeps(s).build(rustGame(), MobileBuild.IosSimulator), null);
  });

  it("an Android export builds through the seam at the Rust lock, never the C++ lock", async () => {
    const { asked, services: s } = services({
      gameBuilds: {
        ensure: async (game, target, purpose) => {
          asked.push({ lane: "seam", target, lock: game.lock });
          return { stack: GameStack.RustWgpu, target, purpose, refusal: null, outcome: outcome(null) };
        },
      },
    });
    const deps = { ...androidExportDeps(s), tools: async () => ({}) } as unknown as Parameters<
      typeof exportAndroidGame
    >[1];
    const request: MobileExportGameRequest = {
      destination: Android,
      game: rustGame(),
      targetDir: "/exports/pond.android",
      signing: { kind: ExportSigning.AndroidDebug },
      artifact: MobileArtifact.ApkDev,
      person: false,
    };
    await assert.rejects(
      exportAndroidGame(request, deps),
      (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.BuildFailed,
    );
    assert.deepEqual(asked, [{ lane: "seam", target: Android, lock: RUST_LOCK }]);
  });

  it("an Android export on a host Studio does not build for is refused lane-missing", () => {
    assert.equal(androidExportDeps(services({ host: null }).services), undefined);
  });

  it("the packaging tools are the person's Build-Tools and platform with the store's JDK and bundletool; none when one is missing", async () => {
    const sdk = {
      root: "/sdk",
      licenceAccepted: true,
      platformJar: "/sdk/platforms/android-36/android.jar",
      platforms: ["android-36"],
      buildTools: { version: "36.0.0", dir: "/sdk/build-tools/36.0.0" },
      buildToolsVersions: ["36.0.0"],
      ndk: null,
      ndkVersions: [],
      sdkmanager: null,
    };
    const store = {
      java: "/store/jdk/Contents/Home/bin/java",
      bundletool: "/store/bundletool/bundletool.jar",
      std: [],
    };
    const { services: s } = services({ androidSdk: async () => sdk, storeTools: async () => store });
    assert.deepEqual(await androidPackageTools(s), {
      aapt2: "/sdk/build-tools/36.0.0/aapt2",
      zipalign: "/sdk/build-tools/36.0.0/zipalign",
      apksigner: "/sdk/build-tools/36.0.0/apksigner",
      androidJar: "/sdk/platforms/android-36/android.jar",
      javaHome: "/store/jdk/Contents/Home",
      bundletoolJar: "/store/bundletool/bundletool.jar",
    });
    const rows: Array<Partial<MobileExportServices>> = [
      { androidSdk: async () => null, storeTools: async () => store },
      { androidSdk: async () => ({ ...sdk, buildTools: null }), storeTools: async () => store },
      { androidSdk: async () => ({ ...sdk, platformJar: null }), storeTools: async () => store },
      { androidSdk: async () => sdk, storeTools: async () => null },
      { androidSdk: async () => sdk, storeTools: async () => ({ ...store, bundletool: null }) },
      { androidSdk: async () => assert.fail("the probe threw"), storeTools: async () => store },
    ];
    for (const [index, row] of rows.entries())
      assert.equal(await androidPackageTools(services(row).services), null, `row ${index}`);
  });

  it("after an update moved the Rust lock on, a phone export's tools and notices come from the game's own lock (M6 review)", async () => {
    const RETAINED = { digest: "n".repeat(64) } as unknown as ToolchainLock;
    const toolsAt: Array<ToolchainLock | null> = [];
    const noticesAt: Array<{ target: BuildTarget; lock: ToolchainLock | null }> = [];
    const { services: s } = services({
      // The store's current Rust lock is RUST_LOCK (N+1); the game recorded RETAINED (N).
      toolchains: {
        currentLock: async (stack = GameStack.RaylibCpp, project?: string) => {
          if (stack !== GameStack.RustWgpu) return RAYLIB_LOCK;
          return project === "pond" ? RETAINED : RUST_LOCK;
        },
      },
      storeTools: async (_target, lock) => {
        toolsAt.push(lock);
        return null;
      },
      notices: async (target, _buildLock, lock) => {
        noticesAt.push({ target, lock });
        return { ok: true, notices: [] };
      },
    });
    const android = androidExportDeps(s);
    assert.ok(android);
    assert.equal(await android.tools(rustGame()), null);
    await android.notices(rustGame(), "/rust-builds/seam/out");
    await iosExportDeps(s).notices(rustGame(), {
      out: "/rust-builds/seam/out",
      outputs: [],
      buildLock: "/rust-builds/seam/out/Cargo.lock",
    });
    assert.deepEqual(toolsAt, [RETAINED]);
    assert.deepEqual(noticesAt, [
      { target: Android, lock: RETAINED },
      { target: Ios, lock: RETAINED },
    ]);
  });

  it("a notice that cannot be made refuses the Android package missing-notice", async () => {
    const { services: s } = services({
      notices: async () => ({ ok: false, refusal: NoticeRefusal.LockInvalid, detail: "x" }),
    });
    const deps = androidExportDeps(s);
    await assert.rejects(
      deps?.notices(rustGame(), "/rust-builds/seam/out") ?? Promise.resolve(),
      (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.MissingNotice,
    );
  });
});

describe("the export menu's phone items", () => {
  it("label a phone export untested on real devices until the owner's device rows run", () => {
    const game = rustGame();
    assert.equal(EXPORT_WORDS.untestedOnRealDevices, "Untested on real devices");
    for (const target of [Ios, Android]) assert.equal(exportCaveat(game, target), EXPORT_WORDS.untestedOnRealDevices);
    assert.equal(exportCaveat(game, Web), null);
  });

  it("a phone opens the export sheet; every other destination exports at once", () => {
    assert.equal(exportOpensSheet(Ios), true);
    assert.equal(exportOpensSheet(Android), true);
    for (const target of [Web, Mac, Windows, Linux]) assert.equal(exportOpensSheet(target), false, target);
    assert.equal(exportOpensSheet(undefined), false);
  });
});
