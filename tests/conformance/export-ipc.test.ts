/**
 * `studio:export {project, destination?, signing?}` as the studio window sends it: the destination
 * defaults to the browser and must be a build target, the signing passes `parseExportSigning` (a
 * Mac app defaults to ad hoc; the browser folder is never signed), and a refused request builds,
 * spawns and writes nothing. A Mac app is revealed in the file manager, never opened: opening an
 * `.app` launches it. The browser folder still opens as before.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  EXPORT_RUNS,
  ExportError,
  ExportRefusal,
  ExportRun,
  ExportSigning,
  exportsTo,
  GpuQualification,
  gpuQualificationOf,
} from "../../src/shared/game-export-contract.ts";
import {
  ALL_BUILD_TARGETS,
  BUILD_TARGETS,
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import {
  ExportCaller,
  type ExportReveal,
  type ExportRunners,
  exportDestinationOf,
  exportDirFor,
  exportForPerson,
  exportSigningFor,
  runExport,
  withGpuQualification,
} from "../../src/main/core/native-export-run.ts";
import { exportCaveat, exportDestinationsFor, exportNotice } from "../../src/renderer/chat/use-chat-export.ts";
import { EXPORT_WORDS } from "../../src/renderer/words.ts";
import { RustFixtureKind, seedRustFixture } from "../../src/main/dev/fixture-rust.ts";
import { FIXTURE_RUST_GAME } from "../../src/main/dev/fixture-toolchains.ts";
import {
  emptySigningForm,
  type MobileSigningForm,
  mobileExportOptions,
  PasswordSource,
  referenceLabel,
  SigningField,
  signingPayloadOf,
} from "../../src/renderer/panels/export-sheet-view.ts";
import {
  exportForWindow,
  pickSigningReference,
  redactedExportRefusal,
  signingReferencePickerOptions,
} from "../../src/main/export-window.ts";
import { MobileArtifact, SigningReference } from "../../src/shared/game-export-contract.ts";
import { REDACTED } from "../../src/shared/redact.ts";
import { signerPasswordFile } from "../../src/substrate/mobile-sign.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const POSIX = process.platform === "win32" && "POSIX paths";

/** A Windows signature with the person's own certificate, as the export sheet would send it. */
const OWN_CERTIFICATE = {
  kind: "own-certificate",
  storeType: "PKCS12",
  keystore: "/Users/pat/keys/genex.p12",
  alias: "genex",
  timestampUrl: "http://timestamp.sectigo.com",
  password: "correct horse",
};

/** A reveal that records what it was asked to show or open. */
function recordingReveal(): ExportReveal & { shown: string[]; opened: string[] } {
  const shown: string[] = [];
  const opened: string[] = [];
  return {
    shown,
    opened,
    showItemInFolder: (target) => {
      shown.push(target);
    },
    openPath: async (target) => {
      opened.push(target);
      return "";
    },
  };
}

const refusedWith = (code: ExportRefusal) => (error: unknown) => {
  assert.ok(error instanceof ExportError, String(error));
  assert.equal(error.code, code, error.message);
  return true;
};

/** A lite core with a Three.js game and a C++ game for the browser and the Mac, its lane and exporter watched. */
async function studio(t: TestContext) {
  const { core } = await coreLite();
  await core.games.scaffold("pong", { title: "Pong" });
  await core.games.scaffold("pong-cpp", {
    title: "Pong",
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Web, BuildTarget.Mac],
  });
  const ensure = t.mock.method(core.cppBuilds, "ensure");
  const exporter = t.mock.method(core.games, "export");
  const exports = core.layout.exports;
  await mkdir(exports, { recursive: true });
  await writeFile(path.join(exports, "keep.txt"), "kept");
  const untouched = async (label: string) => {
    assert.equal(ensure.mock.callCount(), 0, `${label}: nothing built`);
    assert.equal(exporter.mock.callCount(), 0, `${label}: nothing exported`);
    assert.deepEqual(await readdir(exports), ["keep.txt"], `${label}: nothing written`);
  };
  return { core, ensure, untouched };
}

describe("the export request's checks", () => {
  it("a destination is a build target or a phone; absent is the browser", () => {
    assert.equal(exportDestinationOf(undefined), BuildTarget.Web);
    for (const target of BUILD_TARGETS) assert.equal(exportDestinationOf(target), target);
    // Flipped (M5.9): "ios" and "android" are destinations an export may name; the table refuses a stack without phones.
    for (const target of [BuildTarget.Ios, BuildTarget.Android]) assert.equal(exportDestinationOf(target), target);
    for (const hostile of ["iphone", "IOS", 1, "../web", "", "WEB", null, {}, ["web"], "web\0"]) {
      assert.throws(() => exportDestinationOf(hostile), refusedWith(ExportRefusal.NotADestination), String(hostile));
    }
  });

  it("signing: the browser folder is never signed; a Mac app is ad hoc unless told; the harness never signs as a person", () => {
    assert.deepEqual(exportSigningFor(BuildTarget.Web, undefined, ExportCaller.Person), { kind: ExportSigning.None });
    assert.deepEqual(exportSigningFor(BuildTarget.Mac, undefined, ExportCaller.Person), { kind: ExportSigning.AdHoc });
    assert.deepEqual(exportSigningFor(BuildTarget.Mac, { kind: "adhoc" }, ExportCaller.Harness), {
      kind: ExportSigning.AdHoc,
    });
    const identity = { kind: "developer-id", identity: "Developer ID Application: Pat Example (ABCDE12345)" };
    assert.equal(exportSigningFor(BuildTarget.Mac, identity, ExportCaller.Person).kind, ExportSigning.DeveloperId);
    assert.throws(
      () => exportSigningFor(BuildTarget.Mac, identity, ExportCaller.Harness),
      refusedWith(ExportRefusal.HarnessMayNotSign),
    );
    assert.throws(
      () => exportSigningFor(BuildTarget.Web, { kind: "adhoc" }, ExportCaller.Person),
      refusedWith(ExportRefusal.SigningInvalid),
    );
    for (const hostile of ["adhoc", { kind: "-" }, { kind: "developer-id", identity: "-o runtime" }, null, 1]) {
      assert.throws(
        () => exportSigningFor(BuildTarget.Mac, hostile, ExportCaller.Person),
        refusedWith(ExportRefusal.SigningInvalid),
        JSON.stringify(hostile),
      );
    }
  });

  it("the browser folder and the Mac app go to sibling folders of the exports root", { skip: POSIX }, () => {
    assert.equal(exportDirFor("/x/exports", "pong", BuildTarget.Web), "/x/exports/pong");
    assert.equal(exportDirFor("/x/exports", "pong", BuildTarget.Mac), "/x/exports/pong.mac");
  });

  it("the Windows zip and the Linux tarball go to their own sibling folders", { skip: POSIX }, () => {
    assert.equal(exportDirFor("/x/exports", "pong", BuildTarget.Windows), "/x/exports/pong.windows");
    assert.equal(exportDirFor("/x/exports", "pong", BuildTarget.Linux), "/x/exports/pong.linux");
  });

  it("no destination's folder is another destination's or another game's, whatever their names", {
    skip: POSIX,
  }, () => {
    const names = ["pong", "pong-windows", "pong_linux", "windows", "linux", "pong-mac", "a"];
    const folders = new Map<string, string>();
    for (const name of names)
      for (const destination of Object.values(BuildTarget)) {
        const folder = exportDirFor("/x/exports", name, destination);
        const owner = `${name} for ${destination}`;
        assert.equal(folders.get(folder), undefined, `${owner} shares ${folder} with ${folders.get(folder)}`);
        folders.set(folder, owner);
      }
  });

  it("a game's Mac app folder is never another game's browser folder, whatever their names", { skip: POSIX }, () => {
    // Game names may end in "-mac": "pong" for the Mac and "pong-mac" for the browser shared one
    // folder, and each export replaced the other's.
    const names = ["pong", "pong-mac", "pong_mac", "mac", "pong-mac-mac", "a"];
    for (const mac of names)
      for (const web of names)
        assert.notEqual(
          exportDirFor("/x/exports", mac, BuildTarget.Mac),
          exportDirFor("/x/exports", web, BuildTarget.Web),
          `${mac} for the Mac, ${web} for the browser`,
        );
  });
});

describe("studio:export", { skip: POSIX }, () => {
  it("a hostile destination, signing or project builds, spawns and writes nothing", async (t) => {
    const { core, untouched } = await studio(t);
    const rows: Array<[string, Record<string, unknown>, ExportRefusal | null]> = [
      ["destination ios", { project: "pong-cpp", destination: "ios" }, ExportRefusal.NotADestination],
      ["destination 1", { project: "pong-cpp", destination: 1 }, ExportRefusal.NotADestination],
      ["destination ../web", { project: "pong-cpp", destination: "../web" }, ExportRefusal.NotADestination],
      [
        "signing as a string",
        { project: "pong-cpp", destination: "macos", signing: "adhoc" },
        ExportRefusal.SigningInvalid,
      ],
      [
        "an identity that reads as an option",
        { project: "pong-cpp", destination: "macos", signing: { kind: "developer-id", identity: "--deep" } },
        ExportRefusal.SigningInvalid,
      ],
      [
        "Developer ID without the gate",
        {
          project: "pong-cpp",
          destination: "macos",
          signing: { kind: "developer-id", identity: "Developer ID Application: Pat Example (ABCDE12345)" },
        },
        ExportRefusal.SigningUnavailable,
      ],
      ["a signed browser folder", { project: "pong", signing: { kind: "adhoc" } }, ExportRefusal.SigningInvalid],
      [
        "a Linux tarball signed with a certificate",
        { project: "pong-cpp", destination: "linux", signing: OWN_CERTIFICATE },
        ExportRefusal.SigningInvalid,
      ],
      [
        "a Windows zip signed with Developer ID",
        {
          project: "pong-cpp",
          destination: "windows",
          signing: { kind: "developer-id", identity: "Developer ID Application: Pat Example (ABCDE12345)" },
        },
        ExportRefusal.SigningInvalid,
      ],
      [
        "a Mac app signed with a Windows certificate",
        { project: "pong-cpp", destination: "macos", signing: OWN_CERTIFICATE },
        ExportRefusal.SigningInvalid,
      ],
      [
        "a keystore climbing out",
        { project: "pong-cpp", destination: "windows", signing: { ...OWN_CERTIFICATE, keystore: "../k.p12" } },
        ExportRefusal.SigningInvalid,
      ],
      [
        "a timestamp server off the list",
        {
          project: "pong-cpp",
          destination: "windows",
          signing: { ...OWN_CERTIFICATE, timestampUrl: "http://evil.example" },
        },
        ExportRefusal.SigningInvalid,
      ],
      ["a project climbing out", { project: "../secrets" }, null],
      ["a project that is no string", { project: 7 }, null],
    ];
    for (const [label, payload, code] of rows) {
      const reveal = recordingReveal();
      await assert.rejects(exportForPerson(core, payload, reveal), code ? refusedWith(code) : Error, label);
      await untouched(label);
      assert.deepEqual([reveal.shown, reveal.opened], [[], []], `${label}: nothing shown`);
    }
  });

  it("a Mac app is shown in the file manager, never opened; the browser folder opens", async (t) => {
    const { core } = await coreLite();
    const reveal = recordingReveal();
    const app = path.join(core.layout.exports, "pong-cpp.mac", "Pong.app");
    const exported: Array<[string, string, unknown]> = [];
    t.mock.method(core, "exportPublicCopy", async (project: string, target: string, options: unknown) => {
      exported.push([project, target, options]);
      const mac = (options as { destination?: string }).destination === BuildTarget.Mac;
      const result: ExportResult = mac
        ? { dir: target, files: 1, included: [], excluded: [], destination: BuildTarget.Mac, artifact: app }
        : { dir: target, files: 1, included: ["index.html"], excluded: [] };
      return result;
    });
    await exportForPerson(core, { project: "pong-cpp", destination: "macos" }, reveal);
    assert.deepEqual(reveal.shown, [app]);
    assert.deepEqual(reveal.opened, [], "an .app is never opened: that would launch it");
    await exportForPerson(core, { project: "pong" }, reveal);
    assert.deepEqual(reveal.opened, [path.join(core.layout.exports, "pong")]);
    assert.deepEqual(exported, [
      [
        "pong-cpp",
        path.join(core.layout.exports, "pong-cpp.mac"),
        { destination: BuildTarget.Mac, signing: { kind: ExportSigning.AdHoc }, person: true },
      ],
      [
        "pong",
        path.join(core.layout.exports, "pong"),
        { destination: BuildTarget.Web, signing: { kind: ExportSigning.None }, person: true },
      ],
    ]);
    assert.equal(existsSync(app), false, "the stand-in wrote nothing");
  });

  it("a Windows zip and a Linux tarball reach the core with their own folders, unsigned unless asked", async (t) => {
    const { core } = await coreLite();
    const exported: Array<[string, string, unknown]> = [];
    t.mock.method(core, "exportPublicCopy", async (project: string, target: string, options: unknown) => {
      exported.push([project, target, options]);
      const { destination } = options as { destination: BuildTarget };
      const result: ExportResult = { dir: target, files: 1, included: [], excluded: [], destination };
      return result;
    });
    await exportForPerson(core, { project: "pong-cpp", destination: "windows" }, recordingReveal());
    await exportForPerson(core, { project: "pong-cpp", destination: "linux" }, recordingReveal());
    assert.deepEqual(exported, [
      [
        "pong-cpp",
        path.join(core.layout.exports, "pong-cpp.windows"),
        { destination: BuildTarget.Windows, signing: { kind: ExportSigning.None }, person: true },
      ],
      [
        "pong-cpp",
        path.join(core.layout.exports, "pong-cpp.linux"),
        { destination: BuildTarget.Linux, signing: { kind: ExportSigning.None }, person: true },
      ],
    ]);
  });
});

/** A game of `stack` naming `targets`, as the library lists it. */
function gameOf(stack: GameStack, targets: BuildTarget[], name = "pond"): GameProject {
  const kind = {
    [GameStack.ThreeJs]: ProjectKind.StudioTemplate,
    [GameStack.RaylibCpp]: ProjectKind.RaylibCpp,
    [GameStack.RustWgpu]: ProjectKind.RustWgpu,
  }[stack];
  return {
    name,
    title: "Pond",
    dir: `/x/games/${name}`,
    createdAt: "2026-10-07T00:00:00.000Z",
    pathLabel: `~/AI Games/${name}`,
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    shape: { kind } as ProjectShape,
    built: false,
    destinations: { stack, targets },
  };
}

/** Export steps that record what they were asked and answer a receipt naming the destination. */
function recordingRunners(): ExportRunners & { asked: string[] } {
  const asked: string[] = [];
  const receipt = (dir: string, destination?: BuildTarget): ExportResult => ({
    dir,
    files: 1,
    included: [],
    excluded: [],
    ...(destination ? { destination, artifact: path.join(dir, `pond-${destination}`) } : {}),
  });
  return {
    asked,
    browserFolder: async (_game, targetDir) => {
      asked.push(ExportRun.BrowserFolder);
      return receipt(targetDir);
    },
    compiledWeb: async (_game, targetDir) => {
      asked.push(ExportRun.CompiledWeb);
      return receipt(targetDir);
    },
    macApp: async (request) => {
      asked.push(`${ExportRun.MacApp}:${request.signing.kind}`);
      return receipt(request.targetDir, BuildTarget.Mac);
    },
    desktopArchive: async (request) => {
      asked.push(`${ExportRun.DesktopArchive}:${request.destination}:${request.signing.kind}`);
      return receipt(request.targetDir, request.destination);
    },
    iosApp: async (request) => {
      asked.push(`${ExportRun.IosApp}:${request.signing.kind}`);
      return receipt(request.targetDir, request.destination);
    },
    androidPackage: async (request) => {
      asked.push(`${ExportRun.AndroidPackage}:${request.signing.kind}`);
      return receipt(request.targetDir, request.destination);
    },
  };
}

describe("the export-run dispatch, by stack and destination", () => {
  it("names a run for every stack and every destination; a Rust game exports its browser folder and its phones", () => {
    for (const stack of Object.values(GameStack))
      for (const target of ALL_BUILD_TARGETS)
        assert.ok(Object.values(ExportRun).includes(EXPORT_RUNS[stack][target]), `${stack} ${target}`);
    assert.equal(EXPORT_RUNS[GameStack.ThreeJs][BuildTarget.Web], ExportRun.BrowserFolder);
    for (const target of [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Ios])
      assert.equal(EXPORT_RUNS[GameStack.ThreeJs][target], ExportRun.NotADestination, target);
    assert.equal(EXPORT_RUNS[GameStack.RaylibCpp][BuildTarget.Web], ExportRun.CompiledWeb);
    assert.equal(EXPORT_RUNS[GameStack.RaylibCpp][BuildTarget.Mac], ExportRun.MacApp);
    assert.equal(EXPORT_RUNS[GameStack.RaylibCpp][BuildTarget.Windows], ExportRun.DesktopArchive);
    assert.equal(EXPORT_RUNS[GameStack.RaylibCpp][BuildTarget.Linux], ExportRun.DesktopArchive);
    assert.equal(EXPORT_RUNS[GameStack.RustWgpu][BuildTarget.Web], ExportRun.CompiledWeb);
    // The Mac app and the desktop archives assemble raylib's bundle: a Rust game has no run there yet.
    for (const target of [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux])
      assert.equal(EXPORT_RUNS[GameStack.RustWgpu][target], ExportRun.LaneMissing, target);
    // A Rust game's phones name their own runs (M5.0).
    assert.equal(EXPORT_RUNS[GameStack.RustWgpu][BuildTarget.Ios], ExportRun.IosApp);
    assert.equal(EXPORT_RUNS[GameStack.RustWgpu][BuildTarget.Android], ExportRun.AndroidPackage);
    for (const target of [BuildTarget.Ios, BuildTarget.Android]) {
      assert.equal(EXPORT_RUNS[GameStack.RaylibCpp][target], ExportRun.NotADestination, target);
      // Flipped (M5.9): the phone runs are bound by the core and offered.
      assert.equal(exportsTo(GameStack.RustWgpu, target), true, target);
    }
  });

  it("every destination the export menu offers, for every stack and host, runs an export: none is refused", async () => {
    for (const stack of Object.values(GameStack))
      for (const host of [...Object.values(StudioPlatform), null]) {
        const game = gameOf(stack, [...ALL_BUILD_TARGETS]);
        const offered = exportDestinationsFor(game, host) ?? [BuildTarget.Web];
        for (const destination of offered) {
          const runners = recordingRunners();
          assert.ok(exportsTo(stack, destination), `${stack} ${destination} on ${host}`);
          await runExport(runners, { game, destination, targetDir: "/x/e", person: true });
          assert.equal(runners.asked.length, 1, `${stack} ${destination} on ${host}`);
        }
      }
  });

  it("a Rust Windows or Linux receipt carries gpuQualification untested; its Mac app and browser folder real-gpu", () => {
    const receipt = (destination: BuildTarget): ExportResult => ({
      dir: "/x/e",
      files: 1,
      included: [],
      excluded: [],
      destination,
    });
    for (const destination of [BuildTarget.Windows, BuildTarget.Linux])
      assert.equal(
        withGpuQualification(receipt(destination), GameStack.RustWgpu, destination).gpuQualification,
        GpuQualification.Untested,
      );
    for (const destination of [BuildTarget.Mac, BuildTarget.Web])
      assert.equal(
        withGpuQualification(receipt(destination), GameStack.RustWgpu, destination).gpuQualification,
        GpuQualification.RealGpu,
      );
  });

  it("a Rust browser folder ran on a real GPU; a C++ or three.js export carries none", async () => {
    const rust = gameOf(GameStack.RustWgpu, [BuildTarget.Web, BuildTarget.Mac]);
    const runners = recordingRunners();
    const web = await runExport(runners, { game: rust, destination: BuildTarget.Web, targetDir: "/x/w", person: true });
    assert.equal(web.gpuQualification, GpuQualification.RealGpu);
    const cpp = gameOf(GameStack.RaylibCpp, [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows]);
    for (const destination of [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows]) {
      const result = await runExport(runners, { game: cpp, destination, targetDir: "/x/c", person: true });
      assert.equal("gpuQualification" in result, false, `raylib ${destination}`);
    }
    const three = await runExport(runners, {
      game: gameOf(GameStack.ThreeJs, [BuildTarget.Web]),
      destination: BuildTarget.Web,
      targetDir: "/x/t",
      person: false,
    });
    assert.equal("gpuQualification" in three, false, "three.js");
    assert.deepEqual(runners.asked, [
      "compiled-web",
      "compiled-web",
      "mac-app:adhoc",
      "desktop-archive:windows:none",
      "browser-folder",
    ]);
  });

  it("a refused pair runs nothing: a three.js desktop export, a C++ phone, a Rust desktop app before its lane", async () => {
    const rows: Array<[GameProject, BuildTarget, ExportRefusal]> = [
      [gameOf(GameStack.ThreeJs, [BuildTarget.Web]), BuildTarget.Windows, ExportRefusal.NotADestination],
      [gameOf(GameStack.ThreeJs, [BuildTarget.Web]), BuildTarget.Mac, ExportRefusal.NotADestination],
      [gameOf(GameStack.RaylibCpp, [BuildTarget.Web]), BuildTarget.Ios, ExportRefusal.NotADestination],
      // Flipped (M5.9): a Rust iPhone or Android export runs its phone run (no longer lane-missing).
      [gameOf(GameStack.ThreeJs, [BuildTarget.Web]), BuildTarget.Android, ExportRefusal.NotADestination],
      [gameOf(GameStack.RustWgpu, [BuildTarget.Mac]), BuildTarget.Mac, ExportRefusal.LaneMissing],
      [gameOf(GameStack.RustWgpu, [BuildTarget.Windows]), BuildTarget.Windows, ExportRefusal.LaneMissing],
      [gameOf(GameStack.RustWgpu, [BuildTarget.Linux]), BuildTarget.Linux, ExportRefusal.LaneMissing],
    ];
    for (const [game, destination, code] of rows) {
      const runners = recordingRunners();
      await assert.rejects(
        runExport(runners, { game, destination, targetDir: "/x/e", person: true }),
        refusedWith(code),
        `${stackLabel(game)} ${destination}`,
      );
      assert.deepEqual(runners.asked, [], `${stackLabel(game)} ${destination}: nothing ran`);
    }
  });

  it("the core's export of a Rust game goes through the table: its browser folder's receipt says real-gpu", {
    skip: process.platform === "win32" ? "the fixture's stub tools are POSIX shell scripts" : false,
  }, async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("export-ipc-rust-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const out = path.join(await tmpDir("export-ipc-rust-export-"), "out");
    const result = await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    assert.equal(result.gpuQualification, GpuQualification.RealGpu);
  });
});

/** A game's stack, for a row's label. */
const stackLabel = (game: GameProject) => game.destinations?.stack ?? GameStack.ThreeJs;

describe("the export sheet's GPU label", () => {
  const { Web, Mac, Windows, Linux } = BuildTarget;
  const rust = gameOf(GameStack.RustWgpu, [Linux, Windows, Mac, Web]);

  it("a Rust game lists only what this build exports for it: the browser folder, on a Mac and on the Linux Studio", () => {
    // Flipped (M4 review): the Mac app and the Windows and Linux archives are lane-missing for a Rust game.
    assert.deepEqual(exportDestinationsFor(rust, StudioPlatform.Mac), [Web]);
    assert.deepEqual(exportDestinationsFor(rust, StudioPlatform.Linux), [Web]);
    // A Windows Studio has no Rust lane until the signed launcher; an unknown host builds nothing.
    assert.deepEqual(exportDestinationsFor(rust, StudioPlatform.Windows), []);
    assert.deepEqual(exportDestinationsFor(rust, null), []);
    const phones = gameOf(GameStack.RustWgpu, [Web, BuildTarget.Ios, BuildTarget.Android]);
    // Flipped (M5.9): a Mac exports a Rust game's phones; the Linux Studio its Android package.
    assert.deepEqual(exportDestinationsFor(phones, StudioPlatform.Mac), [Web, BuildTarget.Ios, BuildTarget.Android]);
    assert.deepEqual(exportDestinationsFor(phones, StudioPlatform.Linux), [Web, BuildTarget.Android]);
  });

  it("labels the Rust Windows and Linux destinations untested on real GPUs, and nothing else", () => {
    assert.equal(EXPORT_WORDS.untestedOnRealGpus, "Untested on real GPUs");
    for (const target of [Windows, Linux]) assert.equal(exportCaveat(rust, target), EXPORT_WORDS.untestedOnRealGpus);
    for (const target of [Web, Mac]) assert.equal(exportCaveat(rust, target), null, target);
    const cpp = gameOf(GameStack.RaylibCpp, [Web, Mac, Windows, Linux]);
    for (const target of BUILD_TARGETS) assert.equal(exportCaveat(cpp, target), null, `raylib ${target}`);
    // The label follows the owner's record: it goes when a real-GPU row flips the qualification.
    for (const target of BUILD_TARGETS)
      assert.equal(
        exportCaveat(rust, target) !== null,
        gpuQualificationOf(GameStack.RustWgpu, target) === GpuQualification.Untested,
        target,
      );
  });

  it("the notice after an untested export says so; a Mac app's or a C++ archive's does not", () => {
    const windows: ExportResult = {
      dir: "/x/exports/pond.windows",
      files: 3,
      included: ["game.exe"],
      excluded: [],
      destination: Windows,
      artifact: "/x/exports/pond.windows/Pond-windows-x64.zip",
      gpuQualification: GpuQualification.Untested,
    };
    assert.equal(
      exportNotice(windows, StudioPlatform.Mac),
      `${EXPORT_WORDS.exportedWindows("Pond-windows-x64.zip")} ${EXPORT_WORDS.untestedNotice}`,
    );
    const { gpuQualification: _, ...cppWindows } = windows;
    assert.equal(exportNotice(cppWindows, StudioPlatform.Mac), EXPORT_WORDS.exportedWindows("Pond-windows-x64.zip"));
    const mac: ExportResult = {
      ...windows,
      destination: Mac,
      artifact: "/x/exports/pond.mac/Pond.app",
      gpuQualification: GpuQualification.RealGpu,
    };
    assert.equal(exportNotice(mac, StudioPlatform.Mac), EXPORT_WORDS.exportedMac("Pond"));
  });

  it("an archive made on the Linux Studio says where it was built, never this Mac", () => {
    const linux: ExportResult = {
      dir: "/x/exports/pond.linux",
      files: 3,
      included: ["game"],
      excluded: [],
      destination: Linux,
      artifact: "/x/exports/pond.linux/pond-linux-x64.tar.gz",
      gpuQualification: GpuQualification.Untested,
    };
    const said = exportNotice(linux, StudioPlatform.Linux);
    assert.ok(!said.includes("this Mac"), said);
    assert.ok(said.endsWith(EXPORT_WORDS.untestedNotice), said);
    assert.ok(exportNotice(linux, StudioPlatform.Mac).includes("this Mac"));
  });
});

/** An Apple identity of each iOS signing kind and a profile, as the person fills them in. */
const IOS_DEVELOPMENT = {
  kind: "ios-development",
  identity: "Apple Development: Pat Example (ABCDE12345)",
  provisioningProfile: "/Users/pat/Profiles/pond.mobileprovision",
};
const IOS_DISTRIBUTION = {
  ...IOS_DEVELOPMENT,
  kind: "ios-distribution",
  identity: "Apple Distribution: Pat Example (ABCDE12345)",
};
/** An Android release signing with the person's keystore and its password named by a variable. */
const ANDROID_RELEASE = {
  kind: "android-release",
  keystore: "/Users/pat/keys/release.jks",
  alias: "upload",
  password: { env: "GENEX_KEYSTORE_PASSWORD" },
};

describe("the phone export's options (M5.5)", () => {
  const { Ios, Android } = BuildTarget;

  it("a harness caller cannot select a device, distribution or release signing; the Simulator app and dev APK are its own", () => {
    const personOnly: Array<[typeof Ios | typeof Android, Record<string, unknown>]> = [
      [Ios, IOS_DEVELOPMENT],
      [Ios, IOS_DISTRIBUTION],
      [Android, ANDROID_RELEASE],
    ];
    for (const [target, signing] of personOnly) {
      assert.throws(
        () => exportSigningFor(target, signing, ExportCaller.Harness),
        refusedWith(ExportRefusal.HarnessMayNotSign),
        String(signing.kind),
      );
      assert.equal(exportSigningFor(target, signing, ExportCaller.Person).kind, signing.kind);
    }
    assert.equal(exportSigningFor(Ios, { kind: "adhoc" }, ExportCaller.Harness).kind, ExportSigning.AdHoc);
    assert.equal(
      exportSigningFor(Android, { kind: "android-debug" }, ExportCaller.Harness).kind,
      ExportSigning.AndroidDebug,
    );
  });

  it("the sheet offers each phone's artifacts in order, the person-only ones marked with what they need", () => {
    const ios = mobileExportOptions(Ios);
    assert.deepEqual(
      ios.map((option) => [option.artifact, option.signing, option.personOnly]),
      [
        [MobileArtifact.SimulatorApp, ExportSigning.AdHoc, false],
        [MobileArtifact.Ipa, ExportSigning.IosDevelopment, true],
        [MobileArtifact.Ipa, ExportSigning.IosDistribution, true],
      ],
    );
    assert.deepEqual(ios[1]?.fields, [SigningField.Identity, SigningField.ProvisioningProfile]);
    const android = mobileExportOptions(Android);
    assert.deepEqual(
      android.map((option) => [option.artifact, option.signing, option.personOnly]),
      [
        [MobileArtifact.ApkDev, ExportSigning.AndroidDebug, false],
        [MobileArtifact.Aab, ExportSigning.AndroidRelease, true],
      ],
    );
    assert.deepEqual(android[1]?.fields, [SigningField.Keystore, SigningField.Alias, SigningField.Password]);
    assert.deepEqual(emptySigningForm(Ios).signing, ExportSigning.AdHoc, "the Simulator app first");
    assert.deepEqual(emptySigningForm(Android).signing, ExportSigning.AndroidDebug, "the dev APK first");
  });

  it("the sheet's signing carries a keystore and a password reference, never a password; an incomplete form exports nothing", () => {
    const release: MobileSigningForm = {
      ...emptySigningForm(Android),
      signing: ExportSigning.AndroidRelease,
      keystore: ANDROID_RELEASE.keystore,
      alias: "upload",
      passwordFrom: PasswordSource.Env,
      passwordEnv: "GENEX_KEYSTORE_PASSWORD",
    };
    assert.deepEqual(signingPayloadOf(release), ANDROID_RELEASE);
    const fromFile = { ...release, passwordFrom: PasswordSource.File, passwordFile: "/Users/pat/keys/pass.txt" };
    assert.deepEqual(signingPayloadOf(fromFile), {
      ...ANDROID_RELEASE,
      password: { file: "/Users/pat/keys/pass.txt" },
    });
    assert.ok(!("password" in emptySigningForm(Android)), "the form has no password field at all");
    for (const incomplete of [
      { ...release, keystore: null },
      { ...release, alias: "" },
      { ...release, alias: "-rf" },
      { ...release, passwordEnv: "" },
      { ...release, passwordEnv: "hunter2 secret" },
      { ...fromFile, passwordFile: null },
    ])
      assert.equal(signingPayloadOf(incomplete), null, JSON.stringify(incomplete));
    const device: MobileSigningForm = {
      ...emptySigningForm(Ios),
      signing: ExportSigning.IosDevelopment,
      identity: IOS_DEVELOPMENT.identity,
      provisioningProfile: IOS_DEVELOPMENT.provisioningProfile,
    };
    assert.deepEqual(signingPayloadOf(device), IOS_DEVELOPMENT);
    assert.equal(
      signingPayloadOf({ ...device, identity: IOS_DISTRIBUTION.identity }),
      null,
      "the identity matches the kind",
    );
    assert.equal(signingPayloadOf({ ...device, provisioningProfile: null }), null);
    assert.deepEqual(signingPayloadOf(emptySigningForm(Ios)), { kind: ExportSigning.AdHoc });
    assert.deepEqual(signingPayloadOf(emptySigningForm(Android)), { kind: ExportSigning.AndroidDebug });
  });

  it("a picked file shows by its name only, never the folder that names the person", () => {
    assert.equal(referenceLabel("/Users/pat/keys/release.jks"), "release.jks");
    assert.equal(referenceLabel("C:\\Users\\pat\\keys\\release.jks"), "release.jks");
    assert.equal(referenceLabel(null), null);
  });
});

describe("studio:export.signingReference", () => {
  /** A dialog that records the options it was opened with and answers `filePaths`. */
  function recordingPick(answer: { canceled: boolean; filePaths: string[] }) {
    const asked: unknown[] = [];
    return {
      asked,
      pick: async (options: unknown) => {
        asked.push(options);
        return answer;
      },
    };
  }

  it("opens the native dialog for the kind and answers the picked file's path, never its contents", async () => {
    const dir = await tmpDir("signing-reference-");
    const file = path.join(dir, "keystore-password.txt");
    await writeFile(file, "hunter2-correct-horse");
    const { asked, pick } = recordingPick({ canceled: false, filePaths: [file] });
    const answer = await pickSigningReference({ kind: SigningReference.PasswordFile }, pick);
    assert.equal(answer, file);
    assert.ok(!JSON.stringify(answer).includes("hunter2"), "the password file's contents never reach the window");
    assert.deepEqual(asked, [signingReferencePickerOptions(SigningReference.PasswordFile)]);
    const profile = signingReferencePickerOptions(SigningReference.ProvisioningProfile);
    assert.deepEqual(profile.filters, [{ name: "Provisioning profile", extensions: ["mobileprovision"] }]);
    assert.deepEqual(profile.properties, ["openFile"]);
    assert.deepEqual(signingReferencePickerOptions(SigningReference.Keystore).properties, ["openFile"]);
  });

  it("a cancel answers null; a hostile kind opens nothing; a picked path outside the shape is refused", async () => {
    assert.equal(
      await pickSigningReference({ kind: "keystore" }, recordingPick({ canceled: true, filePaths: [] }).pick),
      null,
    );
    for (const hostile of [{ kind: "ssh-key" }, { kind: ["keystore"] }, null, "keystore", {}]) {
      const { asked, pick } = recordingPick({ canceled: false, filePaths: ["/x/release.jks"] });
      await assert.rejects(pickSigningReference(hostile, pick), refusedWith(ExportRefusal.SigningInvalid));
      assert.equal(asked.length, 0, `${JSON.stringify(hostile)}: no dialog opened`);
    }
    const picked: Array<[string, string]> = [
      [SigningReference.Keystore, "relative/release.jks"],
      [SigningReference.Keystore, "/x/release\njks"],
      [SigningReference.ProvisioningProfile, "/x/pond.p12"],
    ];
    for (const [kind, file] of picked)
      await assert.rejects(
        pickSigningReference({ kind }, recordingPick({ canceled: false, filePaths: [file] }).pick),
        refusedWith(ExportRefusal.SigningInvalid),
        file,
      );
  });
});

describe("an export's refusal reaches the window redacted", { skip: POSIX }, () => {
  /** A core whose export fails saying `said`, as a signer echoing its input would. */
  function failingCore(exports: string, said: string) {
    return {
      layout: { exports },
      exportPublicCopy: async (): Promise<ExportResult> => {
        throw new ExportError(ExportRefusal.SigningFailed, said, { file: "game.exe" });
      },
    };
  }

  /** Whether `error` keeps its typed code and file, and says `secret` nowhere. */
  const redactedOf = (secret: string) => (error: unknown) => {
    assert.ok(error instanceof ExportError, String(error));
    assert.equal(error.code, ExportRefusal.SigningFailed, "the typed code survives");
    assert.equal(error.file, "game.exe");
    assert.ok(!error.message.includes(secret), error.message);
    assert.ok(error.message.includes(REDACTED), error.message);
    return true;
  };

  it("the keystore password named by a variable or a file, or a known secret, never reaches the renderer", async () => {
    const dir = await tmpDir("export-redact-");
    const passwordFile = path.join(dir, "pass.txt");
    await writeFile(passwordFile, "file-secret-0042\n");
    const env = { GENEX_KEYSTORE_PASSWORD: "env-secret-0041" };
    const readPasswordFile = (file: string) => signerPasswordFile(file, [], path.join(dir, "home"));
    const redaction = { env, secretValues: () => ["known-secret-0043"], passwordFile: readPasswordFile };
    const rows: Array<[Record<string, unknown>, string]> = [
      [ANDROID_RELEASE, env.GENEX_KEYSTORE_PASSWORD],
      [{ ...ANDROID_RELEASE, password: { file: passwordFile } }, "file-secret-0042"],
      [ANDROID_RELEASE, "known-secret-0043"],
    ];
    for (const [signing, secret] of rows) {
      const echoed = new ExportError(ExportRefusal.SigningFailed, `jarsigner: bad password (${secret})`, {
        file: "game.exe",
      });
      const payload = { project: "pond", destination: BuildTarget.Android, signing };
      assert.ok(redactedOf(secret)(await redactedExportRefusal(echoed, payload, redaction)), secret);
    }
  });

  it("main reads no file and no variable the renderer names unless the signer itself would: hostile signings", {
    skip: POSIX,
  }, async () => {
    const dir = await realpath(await tmpDir("export-redact-hostile-"));
    const home = path.join(dir, "home");
    const protectedRoot = path.join(home, ".genex");
    for (const folder of [path.join(home, ".android"), path.join(home, ".ssh"), protectedRoot])
      await mkdir(folder, { recursive: true });
    const sshKey = path.join(home, ".ssh", "id_ed25519");
    const debugKey = path.join(home, ".android", "debug.keystore.pass");
    const login = path.join(protectedRoot, "token");
    const linked = path.join(dir, "linked.txt");
    await writeFile(sshKey, "ssh-secret-0051\n");
    await writeFile(debugKey, "android-secret-0052\n");
    await writeFile(login, "genex-secret-0053\n");
    await symlink(login, linked);
    const asked: string[] = [];
    const passwordFile = async (file: string) => {
      asked.push(file);
      return signerPasswordFile(file, [protectedRoot], home);
    };
    const env = { HOME_SECRET: "env-secret-0054" };
    const rows: Array<[string, unknown, string]> = [
      ["an unparsed signing naming an ssh key", { kind: "bogus", password: { file: sshKey } }, "ssh-secret-0051"],
      ["an unparsed signing naming a variable", { kind: "bogus", password: { env: "HOME_SECRET" } }, "env-secret-0054"],
      [
        "a release signing with no alias",
        { ...ANDROID_RELEASE, alias: "", password: { file: sshKey } },
        "ssh-secret-0051",
      ],
      ["a Mac signing carrying a password file", { kind: "ad-hoc", password: { file: sshKey } }, "ssh-secret-0051"],
      ["a password file in ~/.android", { ...ANDROID_RELEASE, password: { file: debugKey } }, "android-secret-0052"],
      ["a password file in a protected root", { ...ANDROID_RELEASE, password: { file: login } }, "genex-secret-0053"],
      ["a link to a protected file", { ...ANDROID_RELEASE, password: { file: linked } }, "genex-secret-0053"],
    ];
    for (const [label, signing, guess] of rows) {
      const echoed = new ExportError(ExportRefusal.SigningFailed, `unknown project ${guess}`, { file: "game.exe" });
      const payload = { project: "pond", destination: BuildTarget.Android, signing };
      const said = await redactedExportRefusal(echoed, payload, { env, secretValues: () => [], passwordFile });
      assert.ok(said.message.includes(guess), `${label}: nothing was read, so a guess is not confirmed`);
    }
    assert.deepEqual(
      asked,
      [debugKey, login, linked],
      "only a parsed release signing's file reaches the signer's own check",
    );
  });

  it("a Windows certificate's typed password a signer echoed is redacted on the way out of studio:export", async () => {
    const dir = await tmpDir("export-redact-");
    const reveal = recordingReveal();
    const core = failingCore(dir, `jsign: keystore password was incorrect (${OWN_CERTIFICATE.password})`);
    const payload = { project: "pond", destination: BuildTarget.Windows, signing: OWN_CERTIFICATE };
    await assert.rejects(
      exportForWindow(core, payload, reveal, { env: {}, secretValues: () => [], passwordFile: async () => null }),
      redactedOf(OWN_CERTIFICATE.password),
    );
    assert.deepEqual([reveal.shown, reveal.opened], [[], []], "a refused export reveals nothing");
  });
});
