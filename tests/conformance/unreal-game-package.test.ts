/**
 * Packaging an Unreal game as the app its players install (`unreal__package-game`): BuildCookRun's
 * words for this computer's system, RunUAT.bat's line on Windows with every path whole in quotes,
 * Unreal's work saved before the package, the app found where Publish looks, and a failed package's
 * error lines with none of the computer's paths; and, with two Unreals installed, the package made
 * by the one the game's own project names. RunUAT and the editor are stand-ins.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import {
  buildCookRunArgs,
  linuxToolchainFor,
  PackageSystem,
  createGamePackageTools,
  type GamePackageDeps,
  GamePackageState,
  GamePackageToolName,
  type GamePackageAnswer,
  packageErrors,
  type RunUat,
  type UatLaunch,
  uatLaunch,
} from "../../src/plugins/unreal/game-package.ts";
import { MacEntitlement, type MacEntitlements, systemMacSigner } from "../../src/substrate/mac-entitlements.ts";
import { uatEnv } from "../../src/plugins/unreal/program-env.ts";
import { VisualStudioState } from "../../src/plugins/unreal/visual-studio.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { unrealBackendFixture } from "../helpers/unreal-fake-engine.ts";

const ENGINE = "/Users/Shared/Epic Games/UE_5.8";
const PACKAGED = "BuildCookRun time: 12.00 s\nBUILD SUCCESSFUL\nAutomationTool exiting with ExitCode=0 (Success)";

/** A game folder with its Unreal project in `unreal/`. */
async function gameWithProject() {
  const game = await tmpDir("unreal-package-");
  const project = path.join(game, "unreal", "Dust.uproject");
  await mkdir(path.dirname(project), { recursive: true });
  await writeFile(project, "{}");
  return { game, project };
}

/** A call's context in `game`. */
const contextIn = (game: string): PluginContext =>
  ({ project: "dust", directory: game, host: async () => undefined }) as unknown as PluginContext;

/** Deps over a project, an editor that answers or not, and a RunUAT the test scripts; every launch and save recorded. */
function depsFor(
  project: string,
  runUat: RunUat,
  options: {
    answers?: boolean;
    saved?: boolean;
    platform?: NodeJS.Platform;
    toolchain?: string;
    visualStudio?: VisualStudioState;
    /** The engine the game is packaged with, where a test needs one whose files it wrote. */
    engine?: { version: string; directory: string };
    /** The emsdk folder the computer's variables name. */
    emsdk?: string;
    /** The packaged Mac app's entitlements as its signature reads, or the failure reading them. */
    entitlements?: MacEntitlements | Error;
  } = {},
) {
  const launches: string[][] = [];
  const signed: Array<{ app: string; entitlements: MacEntitlements }> = [];
  let current = options.entitlements ?? {};
  const envs: Array<Record<string, string> | undefined> = [];
  const saves: string[] = [];
  const deps: GamePackageDeps = {
    platform: options.platform ?? "darwin",
    engine: async () => options.engine ?? { version: "5.8", directory: ENGINE },
    linuxToolchain: async () => options.toolchain,
    emsdk: async () => options.emsdk,
    project: async () => project,
    xcode: async () => ({ state: XcodeState.Ready }),
    visualStudio: async () => ({ state: options.visualStudio ?? VisualStudioState.Ready }),
    editorAnswers: async () => options.answers ?? false,
    save: async (_storage, game) => {
      saves.push(game);
      return options.saved === false ? { saved: false, dirty: ["/Game/Maps/Main"] } : { saved: true, dirty: [] };
    },
    now: () => 0,
    runUat: async (launch, run) => {
      launches.push([launch.file, ...launch.args]);
      envs.push(launch.env);
      return runUat(launch, run);
    },
    macSigner: {
      read: async () => {
        if (current instanceof Error) throw current;
        return current;
      },
      sign: async (app, entitlements) => {
        signed.push({ app, entitlements });
        current = entitlements;
      },
    },
  };
  return { deps, launches, saves, envs, signed };
}

/** `package-status` until the job is no longer running. */
async function settled(status: () => Promise<GamePackageAnswer>): Promise<GamePackageAnswer> {
  for (;;) {
    const now = await status();
    if (now.state !== GamePackageState.Running) return now;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("packaging an Unreal game", () => {
  it("asks BuildCookRun for a Shipping app of this system, staged where Publish looks", () => {
    const args = buildCookRunArgs({
      projectFile: "/g/unreal/Dust.uproject",
      stagingDir: "/g/unreal/Builds",
      engineDir: ENGINE,
      platform: "darwin",
    });
    for (const word of ["BuildCookRun", "-platform=Mac", "-clientconfig=Shipping", "-build", "-cook", "-pak"])
      assert.ok(args.includes(word), word);
    // UAT's archive copies a Mac app without its game content: the staged app is the whole game.
    assert.ok(!args.some((arg) => arg.startsWith("-archive")));
    assert.ok(args.includes("-stagingdirectory=/g/unreal/Builds"));
    assert.ok(args.includes(`-unrealexe=${ENGINE}/Engine/Binaries/Mac/UnrealEditor-Cmd`));
    const windows = buildCookRunArgs({
      projectFile: "C:\\Games\\Dust\\unreal\\Dust.uproject",
      stagingDir: "C:\\Games\\Dust\\unreal\\Builds",
      engineDir: "C:\\Program Files\\Epic Games\\UE_5.8",
      platform: "win32",
    });
    assert.ok(windows.includes("-platform=Win64"));
    assert.ok(
      windows.includes(
        "-unrealexe=C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe",
      ),
    );
    assert.throws(() =>
      buildCookRunArgs({ projectFile: "/p", stagingDir: "/a", engineDir: ENGINE, platform: "linux" }),
    );
  });

  it("packs an app's content compressed and leaves its debug files out, and a web build as before", () => {
    const game = { projectFile: "/g/unreal/Dust.uproject", stagingDir: "/g/unreal/Builds", engineDir: ENGINE };
    for (const platform of ["darwin", "win32"] as const) {
      const app = buildCookRunArgs({ ...game, platform });
      // Players download the staged app: compressed paks and no symbol files make it smaller.
      assert.ok(app.includes("-compressed"), `${platform} -compressed`);
      assert.ok(app.includes("-nodebuginfo"), `${platform} -nodebuginfo`);
      const web = buildCookRunArgs({ ...game, platform, system: PackageSystem.Web });
      assert.deepEqual(
        web.filter((word) => word === "-compressed" || word === "-nodebuginfo"),
        [],
        `${platform}'s web build is packaged as before`,
      );
    }
  });

  it("starts RunUAT.bat through cmd.exe with every path whole in quotes, and refuses what quotes can't hold", () => {
    const engine = "C:\\Program Files\\Epic Games\\UE_5.8";
    const args = ["BuildCookRun", "-project=C:\\Games\\Dust & Co\\unreal\\Dust.uproject", "-nop4"];
    const launch = uatLaunch(engine, args, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    assert.equal(launch.file, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(launch.verbatim, true);
    assert.deepEqual(launch.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(
      launch.args[4],
      `""${engine}\\Engine\\Build\\BatchFiles\\RunUAT.bat" BuildCookRun -project="C:\\Games\\Dust & Co\\unreal\\Dust.uproject" -nop4"`,
    );
    for (const hostile of ["-project=C:\\100%\\Dust.uproject", '-project=C:\\a"b\\Dust.uproject', "-project=C:\\x!y"])
      assert.throws(() => uatLaunch(engine, [hostile], "win32", {}), hostile);
    const mac = uatLaunch(ENGINE, ["BuildCookRun"], "darwin");
    assert.deepEqual([mac.file, ...mac.args], [`${ENGINE}/Engine/Build/BatchFiles/RunUAT.sh`, "BuildCookRun"]);
  });

  it("saves Unreal's work first, then names the Mac app the stage holds", async () => {
    const { game, project } = await gameWithProject();
    const { deps, launches, saves } = depsFor(
      project,
      async (launch) => {
        const staging = launch.args.find((arg) => arg.startsWith("-stagingdirectory="))?.split("=")[1] ?? "";
        const app = path.join(staging, "Mac", "Dust-Mac-Shipping.app", "Contents");
        await mkdir(app, { recursive: true });
        return { code: 0, output: PACKAGED, timedOut: false };
      },
      { answers: true },
    );
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    assert.deepEqual(await tools.handlers["package-game"]({}, context, "/storage"), { started: true, system: "Mac" });
    assert.deepEqual(
      await tools.handlers["package-status"]({}, context, "/storage"),
      { state: GamePackageState.Running, system: "Mac", jobRunning: true },
      "Genex reads that the package runs, to wake the chat when it ends",
    );
    const done = await settled(() => tools.handlers["package-status"]({}, context, "/storage"));
    assert.equal(done.state, GamePackageState.Done, done.line);
    assert.equal(done.app, "unreal/Builds/Mac/Dust-Mac-Shipping.app");
    assert.equal(done.jobRunning, false);
    assert.deepEqual(saves, ["dust"], "the open Unreal saved first");
    assert.equal(launches.length, 1);
    // After a restart, the app on disk is still named.
    const fresh = createGamePackageTools(deps);
    const idle = await fresh.handlers["package-status"]({}, context, "/storage");
    assert.deepEqual(idle, {
      state: GamePackageState.Idle,
      system: "Mac",
      app: "unreal/Builds/Mac/Dust-Mac-Shipping.app",
      jobRunning: false,
    });
  });

  // The owner's published Mac build said "Couldn't reach the arena" forever: Unreal 5.8 signs a
  // Shipping Mac app with Sandbox.NoNet.entitlements (App Sandbox, no network), so macOS refused every
  // DNS lookup ("Sandbox restriction") and the sign-in and the join never left the computer.
  it("lets a sandboxed Mac app reach the network, and leaves an app that already can as it is", async () => {
    const stagesMac: RunUat = async (launch) => {
      const staging = launch.args.find((arg) => arg.startsWith("-stagingdirectory="))?.split("=")[1] ?? "";
      await mkdir(path.join(staging, "Mac", "Dust-Mac-Shipping.app", "Contents"), { recursive: true });
      return { code: 0, output: PACKAGED, timedOut: false };
    };
    const sandboxOnly = { [MacEntitlement.AppSandbox]: true, [MacEntitlement.GetTaskAllow]: true };
    const cases: Array<[string, MacEntitlements, MacEntitlements | null]> = [
      ["Unreal's Shipping default", sandboxOnly, { ...sandboxOnly, [MacEntitlement.NetworkClient]: true }],
      [
        "a sandbox that turns the network off",
        { ...sandboxOnly, [MacEntitlement.NetworkClient]: false },
        { ...sandboxOnly, [MacEntitlement.NetworkClient]: true },
      ],
      ["no sandbox", {}, null],
      ["a sandbox with the network", { [MacEntitlement.AppSandbox]: true, [MacEntitlement.NetworkClient]: true }, null],
    ];
    for (const [why, entitlements, expected] of cases) {
      const { game, project } = await gameWithProject();
      const { deps, signed } = depsFor(project, stagesMac, { entitlements });
      const tools = createGamePackageTools(deps);
      const context = contextIn(game);
      await tools.handlers["package-game"]({}, context, "/s");
      const done = await settled(() => tools.handlers["package-status"]({}, context, "/s"));
      assert.equal(done.state, GamePackageState.Done, `${why}: ${done.line}`);
      assert.equal(done.app, "unreal/Builds/Mac/Dust-Mac-Shipping.app", why);
      assert.deepEqual(
        signed.map((one) => one.entitlements),
        expected ? [expected] : [],
        why,
      );
      for (const one of signed) assert.equal(path.basename(one.app), "Dust-Mac-Shipping.app", why);
    }
  });

  it("fails a Mac package loudly when its app can't be given the network", async () => {
    const stagesMac: RunUat = async (launch) => {
      const staging = launch.args.find((arg) => arg.startsWith("-stagingdirectory="))?.split("=")[1] ?? "";
      await mkdir(path.join(staging, "Mac", "Dust-Mac-Shipping.app", "Contents"), { recursive: true });
      return { code: 0, output: PACKAGED, timedOut: false };
    };
    const { game, project } = await gameWithProject();
    const { deps } = depsFor(project, stagesMac, { entitlements: new Error("codesign exited 1") });
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    await tools.handlers["package-game"]({}, context, "/s");
    const failed = await settled(() => tools.handlers["package-status"]({}, context, "/s"));
    assert.equal(failed.state, GamePackageState.Failed);
    assert.match(failed.line ?? "", /network/);
    assert.equal(failed.app, undefined, "an app that can't go online is not offered to Publish");
  });

  it("packages nothing when Unreal answers but can't save, or when the Mac has no Xcode", async () => {
    const { game, project } = await gameWithProject();
    const { deps, launches } = depsFor(project, async () => ({ code: 0, output: PACKAGED, timedOut: false }), {
      answers: true,
      saved: false,
    });
    const context = contextIn(game);
    await assert.rejects(createGamePackageTools(deps).handlers["package-game"]({}, context, "/s"), /couldn't save/);
    const noXcode = { ...deps, xcode: async () => ({ state: XcodeState.Missing }) };
    await assert.rejects(createGamePackageTools(noXcode).handlers["package-game"]({}, context, "/s"), /needs Xcode/);
    assert.equal(launches.length, 0);
    assert.deepEqual(await readdir(path.join(game, "unreal")), ["Dust.uproject"], "no build folder was made");
  });

  it("reads a failed package as its error lines, with none of the computer's paths", async () => {
    const { game, project } = await gameWithProject();
    const unreal = path.dirname(project);
    const output = [
      "Running AutomationTool...",
      `LogCook: Error: ${unreal}/Content/Maps/Main.umap: Missing class BP_Car`,
      `${ENGINE}/Engine/Source/Runtime/Core/Private/Foo.cpp(12): error C2065: 'x': undeclared identifier`,
      "Result: Success - 0 error(s), 3 warning(s)",
      "AutomationTool exiting with ExitCode=25 (Error_UnknownCookFailure)",
    ].join("\n");
    const { deps } = depsFor(project, async () => ({ code: 25, output, timedOut: false }));
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    await tools.handlers["package-game"]({}, context, "/s");
    const failed = await settled(() => tools.handlers["package-status"]({}, context, "/s"));
    assert.equal(failed.state, GamePackageState.Failed);
    assert.equal(failed.errors?.length, 3);
    assert.ok(
      failed.errors?.every((line) => !line.includes(game) && !line.includes(ENGINE)),
      failed.errors?.join("\n"),
    );
    assert.ok(failed.errors?.some((line) => line.includes("Missing class BP_Car")));
  });

  it("stops a running package, and refuses a build folder that is a link", async () => {
    const { game, project } = await gameWithProject();
    let ended = false;
    const { deps } = depsFor(
      project,
      (_launch, { signal }) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            ended = true;
            resolve({ code: null, output: "", timedOut: false });
          }),
        ),
    );
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    await tools.handlers["package-game"]({}, context, "/s");
    assert.deepEqual(await tools.handlers["package-game"]({ stop: true }, context, "/s"), { stopped: true });
    const stopped = await settled(() => tools.handlers["package-status"]({}, context, "/s"));
    assert.equal(stopped.state, GamePackageState.Stopped);
    assert.ok(ended);

    const linked = await gameWithProject();
    const outside = await tmpDir("unreal-package-outside-");
    await writeFile(path.join(outside, "keep.txt"), "the person's");
    await symlink(outside, path.join(path.dirname(linked.project), "Builds"));
    const second = depsFor(linked.project, async () => ({ code: 0, output: PACKAGED, timedOut: false }));
    await assert.rejects(
      createGamePackageTools(second.deps).handlers["package-game"]({}, contextIn(linked.game), "/s"),
      /isn't a plain folder/,
    );
    assert.deepEqual(await readdir(outside), ["keep.txt"], "nothing was removed through the link");
    assert.equal(second.launches.length, 0);
  });

  it("hands RunUAT Windows' system folders and names, and never a credential", () => {
    const parent = {
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData",
      NUMBER_OF_PROCESSORS: "4",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
    };
    const windows = uatEnv(parent, "win32");
    assert.equal(windows["ProgramFiles(x86)"], "C:\\Program Files (x86)");
    assert.equal(windows.ProgramData, "C:\\ProgramData");
    assert.equal(windows.NUMBER_OF_PROCESSORS, "4");
    assert.equal(windows.LOCALAPPDATA, "C:\\Users\\a\\AppData\\Local");
    assert.ok(!Object.values(windows).includes("secret"));
    const mac = uatEnv({ PATH: "/usr/bin", HOME: "/Users/a", ProgramData: "x", OPENAI_API_KEY: "secret" }, "darwin");
    assert.deepEqual(mac, { HOME: "/Users/a", PATH: "/usr/bin" });
  });

  it("keeps a summary's counts out of the error lines", () => {
    assert.deepEqual(
      packageErrors("Result: Success - 0 error(s)\nall good\ndone", (t) => t),
      ["Result: Success - 0 error(s)", "all good", "done"],
    );
  });
});

/** The folder Epic's installer makes for Unreal 5.7 and 5.8's Linux cross-compile toolchain, in `root`. */
async function toolchainIn(root: string, name = "v26_clang-20.1.8-rockylinux8"): Promise<string> {
  const dir = path.join(root, "UnrealToolchains", name);
  await mkdir(path.join(dir, "x86_64-unknown-linux-gnu"), { recursive: true });
  return dir;
}

/** A RunUAT stand-in that stages a Linux package of Dust: its starter script and its program. */
const stagesLinux: RunUat = async (launch) => {
  // On Windows the arguments are one cmd.exe line, each path whole in quotes.
  const line = launch.args.join(" ");
  const found = /-stagingdirectory=(?:"([^"]+)"|(\S+))/.exec(line);
  const staging = found?.[1] ?? found?.[2] ?? "";
  const linux = path.join(staging, "Linux");
  await mkdir(path.join(linux, "Dust", "Binaries", "Linux"), { recursive: true });
  await writeFile(path.join(linux, "Dust.sh"), "#!/bin/sh");
  await writeFile(path.join(linux, "Dust", "Binaries", "Linux", "Dust-Linux-Shipping"), "\x7fELF");
  return { code: 0, output: PACKAGED, timedOut: false };
};

describe("packaging an Unreal game with C++ on Windows", () => {
  it("refuses while Microsoft's C++ tools aren't ready, naming the tool that installs them; a game in Blueprints packages", async () => {
    const { game, project } = await gameWithProject();
    await writeFile(project, JSON.stringify({ FileVersion: 3, Modules: [{ Name: "Dust", Type: "Runtime" }] }));
    const missing = depsFor(project, stagesLinux, { platform: "win32", visualStudio: VisualStudioState.Missing });
    await assert.rejects(
      createGamePackageTools(missing.deps).handlers["package-game"]({}, contextIn(game), "/s"),
      /This game has C\+\+.*Visual Studio Build Tools \(Visual Studio: missing\)\. Call unreal__install-unreal/,
    );
    assert.deepEqual([missing.launches, missing.saves], [[], []], "nothing saved or run");
    assert.deepEqual(await readdir(path.join(game, "unreal")), ["Dust.uproject"], "no build folder was made");
    const ready = depsFor(project, stagesLinux, { platform: "win32", visualStudio: VisualStudioState.Ready });
    const started = await createGamePackageTools(ready.deps).handlers["package-game"]({}, contextIn(game), "/s");
    assert.deepEqual(started, { started: true, system: "Windows" });
    const blueprints = await gameWithProject();
    const plain = depsFor(blueprints.project, stagesLinux, {
      platform: "win32",
      visualStudio: VisualStudioState.Missing,
    });
    const context = contextIn(blueprints.game);
    assert.deepEqual(await createGamePackageTools(plain.deps).handlers["package-game"]({}, context, "/s"), {
      started: true,
      system: "Windows",
    });
  });
});

describe("packaging an Unreal game for Linux on Windows", () => {
  it("asks BuildCookRun for Linux, cooked by Windows' own editor, only from Windows", () => {
    const windows = {
      projectFile: "C:\\Games\\Dust\\unreal\\Dust.uproject",
      stagingDir: "C:\\Games\\Dust\\unreal\\Builds",
      engineDir: "C:\\Program Files\\Epic Games\\UE_5.8",
      platform: "win32" as const,
    };
    const linux = buildCookRunArgs({ ...windows, system: PackageSystem.Linux });
    assert.ok(linux.includes("-platform=Linux"));
    assert.ok(
      linux.includes("-unrealexe=C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe"),
    );
    assert.ok(buildCookRunArgs(windows).includes("-platform=Win64"), "Windows' own app stays the default");
    const mac = { projectFile: "/p", stagingDir: "/a", engineDir: ENGINE, platform: "darwin" as const };
    assert.throws(() => buildCookRunArgs({ ...mac, system: PackageSystem.Linux }), /can't package/);
    assert.throws(() => buildCookRunArgs({ ...windows, system: PackageSystem.Mac }), /can't package/);
  });

  it("knows Epic's Linux toolchain for each Unreal a game is packaged with, and none for any other", () => {
    for (const version of ["5.7", "5.8", "5.9"])
      assert.deepEqual(
        linuxToolchainFor(version),
        {
          name: "v26_clang-20.1.8-rockylinux8",
          url: "https://cdn.unrealengine.com/CrossToolchain_Linux/v26_clang-20.1.8-rockylinux8.exe",
        },
        version,
      );
    for (const version of ["6.0", "5.10", "4.27", "", "5.8.1", "5.9.0"])
      assert.equal(linuxToolchainFor(version), null, version);
  });

  it("packages the Linux app with the toolchain handed to RunUAT, staged where Publish looks", async () => {
    const { game, project } = await gameWithProject();
    const toolchain = await toolchainIn(await tmpDir("toolchain-"));
    const { deps, launches, envs } = depsFor(project, stagesLinux, { platform: "win32", toolchain });
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    const linux = { system: PackageSystem.Linux };
    assert.deepEqual(await tools.handlers["package-game"](linux, context, "/s"), { started: true, system: "Linux" });
    const done = await settled(() => tools.handlers["package-status"](linux, context, "/s"));
    assert.equal(done.state, GamePackageState.Done, done.line);
    assert.equal(done.app, "unreal/Builds/Linux/Dust.sh");
    assert.ok(launches[0]?.some((arg) => arg.includes("-platform=Linux")));
    assert.deepEqual(envs, [{ LINUX_MULTIARCH_ROOT: toolchain }], "RunUAT finds the toolchain the installer set");
    const idle = await createGamePackageTools(deps).handlers["package-status"](linux, context, "/s");
    assert.deepEqual(idle, {
      state: GamePackageState.Idle,
      system: "Linux",
      app: "unreal/Builds/Linux/Dust.sh",
      jobRunning: false,
    });
    const own = await createGamePackageTools(deps).handlers["package-status"]({}, context, "/s");
    assert.deepEqual(
      own,
      { state: GamePackageState.Idle, system: "Windows", jobRunning: false },
      "Windows' own build folder is apart",
    );
  });

  it("refuses a system this computer can't make, and a toolchain that isn't the right one, packaging nothing", async () => {
    const { game, project } = await gameWithProject();
    const root = await tmpDir("toolchain-");
    const right = await toolchainIn(root);
    const older = await toolchainIn(root, "v25_clang-18.1.0-rockylinux8");
    const link = path.join(root, "linked");
    await symlink(right, link);
    const context = contextIn(game);
    const cases: Array<[string, { platform: NodeJS.Platform; toolchain?: string }, Record<string, unknown>, RegExp]> = [
      ["Linux on a Mac", { platform: "darwin", toolchain: right }, { system: "linux" }, /can't package/],
      ["a Mac app on Windows", { platform: "win32", toolchain: right }, { system: "mac" }, /can't package/],
      ["a system that isn't one", { platform: "win32", toolchain: right }, { system: "../linux" }, /can't package/],
      ["a system that isn't a word", { platform: "win32", toolchain: right }, { system: 7 }, /can't package/],
      ["no toolchain", { platform: "win32" }, { system: "linux" }, /v26_clang-20\.1\.8-rockylinux8\.exe/],
      ["another Unreal's toolchain", { platform: "win32", toolchain: older }, { system: "linux" }, /v26_clang/],
      [
        "a relative toolchain path",
        { platform: "win32", toolchain: "UnrealToolchains\\v26_clang-20.1.8-rockylinux8" },
        { system: "linux" },
        /v26_clang/,
      ],
      ["a toolchain behind a link", { platform: "win32", toolchain: link }, { system: "linux" }, /v26_clang/],
      [
        "a toolchain on a network share",
        { platform: "win32", toolchain: "\\\\server\\v26_clang-20.1.8-rockylinux8" },
        { system: "linux" },
        /v26_clang/,
      ],
      [
        "a toolchain cmd.exe can't carry",
        { platform: "win32", toolchain: path.join(root, "100%", "v26_clang-20.1.8-rockylinux8") },
        { system: "linux" },
        /v26_clang/,
      ],
      [
        "a toolchain that isn't there",
        { platform: "win32", toolchain: path.join(root, "gone", "v26_clang-20.1.8-rockylinux8") },
        { system: "linux" },
        /v26_clang/,
      ],
    ];
    for (const [why, options, args, refusal] of cases) {
      const { deps, launches, saves } = depsFor(project, stagesLinux, { ...options, answers: true });
      await assert.rejects(createGamePackageTools(deps).handlers["package-game"](args, context, "/s"), refusal, why);
      assert.deepEqual([launches, saves], [[], []], `${why}: nothing saved or launched`);
    }
    assert.deepEqual(await readdir(path.join(game, "unreal")), ["Dust.uproject"], "no build folder was made");
  });
});

/** RunUAT's program in an engine's folder on a Mac, and the headless editor BuildCookRun cooks with. */
const uatOf = (engineDir: string) => [
  path.join(engineDir, "Engine", "Build", "BatchFiles", "RunUAT.sh"),
  `-unrealexe=${path.join(engineDir, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd")}`,
];

/**
 * The open game packaged through the plugin's backend on a Mac with Unreal 5.8 and 5.9: its project's
 * `.uproject` is `uproject` when given, else names `association`. Answers how RunUAT was started.
 */
/** An engine folder as an Unreal 5.9 install that lists the web platform (or, with `web` false, only a Mac). */
async function engineFor(web: boolean) {
  const directory = await tmpDir("unreal-package-engine-");
  const line = (platform: string) =>
    `+InstalledPlatformConfigurations=(PlatformName="${platform}", Configuration="Shipping", PlatformType="Game", ProjectType="Any")`;
  await mkdir(path.join(directory, "Engine", "Config"), { recursive: true });
  await writeFile(
    path.join(directory, "Engine", "Config", "BaseEngine.ini"),
    `[InstalledPlatforms]\nHasInstalledPlatformInfo=true\n${line("Mac")}\n${web ? line("Wasm") : ""}\n`,
  );
  await mkdir(path.join(directory, "Engine", "Platforms", "Wasm", "Config"), { recursive: true });
  await writeFile(
    path.join(directory, "Engine", "Platforms", "Wasm", "Config", "Wasm_SDK.json"),
    '{ "MainVersion": "6.0.10", "MinVersion": "6.0.10", "MaxVersion": "6.0.10" }',
  );
  return { version: "5.9", directory };
}

/** An emsdk folder whose emscripten is `version`. */
async function emsdkOf(version: string) {
  const root = await tmpDir("unreal-package-emsdk-");
  await mkdir(path.join(root, "upstream", "emscripten"), { recursive: true });
  await writeFile(path.join(root, "upstream", "emscripten", "emscripten-version.txt"), `"${version}"\n`);
  return root;
}

/** A RunUAT stand-in that stages Dust's web build: the page, its scripts and the game's module. */
const stagesWeb: RunUat = async (launch) => {
  const line = launch.args.join(" ");
  const found = /-stagingdirectory=(?:"([^"]+)"|(\S+))/.exec(line);
  const site = path.join(found?.[1] ?? found?.[2] ?? "", "Wasm");
  await mkdir(path.join(site, "Dust", "Binaries", "Wasm"), { recursive: true });
  await writeFile(path.join(site, "index.html"), "<!doctype html>");
  await writeFile(path.join(site, "wasm-manifest.json"), "{}");
  await writeFile(path.join(site, "Dust", "Binaries", "Wasm", "Dust.wasm"), "\0asm");
  return { code: 0, output: PACKAGED, timedOut: false };
};

/** Dust with its C++ module, as a web build needs. */
async function gameWithCpp() {
  const made = await gameWithProject();
  await writeFile(made.project, JSON.stringify({ FileVersion: 3, Modules: [{ Name: "Dust", Type: "Runtime" }] }));
  return made;
}

describe("packaging an Unreal game for the web", () => {
  const web = { system: PackageSystem.Web };

  it("asks BuildCookRun for a Shipping web build with IoStore containers, from a Mac or Windows", () => {
    const mac = { projectFile: "/g/unreal/Dust.uproject", stagingDir: "/g/unreal/Builds", engineDir: ENGINE };
    for (const platform of ["darwin", "win32"] as const) {
      const args = buildCookRunArgs({ ...mac, platform, system: PackageSystem.Web });
      for (const word of ["-platform=Wasm", "-clientconfig=Shipping", "-build", "-cook", "-stage", "-pak", "-iostore"])
        assert.ok(args.includes(word), `${platform} ${word}`);
    }
    assert.ok(!buildCookRunArgs({ ...mac, platform: "darwin" }).includes("-iostore"), "a Mac app stays as it was");
  });

  it("asks for the package step, which writes the page's file list, and for no Brotli copies", () => {
    const game = { projectFile: "/g/unreal/Dust.uproject", stagingDir: "/g/unreal/Builds", engineDir: ENGINE };
    for (const platform of ["darwin", "win32"] as const) {
      const args = buildCookRunArgs({ ...game, platform, system: PackageSystem.Web });
      // Unreal writes wasm-manifest.json and moves the files no host may serve only in its package step.
      assert.ok(args.includes("-package"), `${platform} -package`);
      // Genex's hosts serve each file as it is, so a .br copy of each would only double the upload.
      assert.ok(args.includes("-WasmNoBrotli"), `${platform} -WasmNoBrotli`);
      const own = buildCookRunArgs({ ...game, platform });
      assert.deepEqual(
        own.filter((word) => word === "-package" || word === "-WasmNoBrotli"),
        [],
        `${platform}'s own app is packaged as before`,
      );
    }
  });

  it("asks Unreal to split the content into files, each small enough for a host that caps a file's size", () => {
    const game = { projectFile: "/g/unreal/Dust.uproject", stagingDir: "/g/unreal/Builds", engineDir: ENGINE };
    for (const platform of ["darwin", "win32"] as const) {
      // Without it the cook writes no chunk lists, and the whole game's content is one file.
      assert.ok(buildCookRunArgs({ ...game, platform, system: PackageSystem.Web }).includes("-manifests"), platform);
      assert.ok(!buildCookRunArgs({ ...game, platform }).includes("-manifests"), `${platform}'s own app stays whole`);
    }
    const linux = buildCookRunArgs({ ...game, platform: "win32", system: PackageSystem.Linux });
    assert.ok(!linux.includes("-manifests"), "a Linux app stays whole");
  });

  it("makes the site the game's web version in web/, with the checked emsdk handed to RunUAT", async () => {
    const { game, project } = await gameWithCpp();
    const emsdk = await emsdkOf("6.0.10");
    const { deps, launches, envs } = depsFor(project, stagesWeb, { engine: await engineFor(true), emsdk });
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    assert.deepEqual(await tools.handlers["package-game"](web, context, "/s"), { started: true, system: "Wasm" });
    const done = await settled(() => tools.handlers["package-status"](web, context, "/s"));
    assert.equal(done.state, GamePackageState.Done, done.line);
    assert.equal(done.app, "web/index.html");
    assert.equal(done.line, "The web build was made in 0 s.");
    assert.ok(launches[0]?.includes("-platform=Wasm"));
    assert.deepEqual(envs[0], { WASM_EMSDK_ROOT: emsdk });
    assert.deepEqual((await readdir(path.join(game, "web"))).sort(), ["Dust", "index.html", "wasm-manifest.json"]);
    // The project says its page adds the isolation headers itself: Genex's hosts send none. The page
    // waits for a click, which a browser needs before it plays sound or gives the game the mouse,
    // and draws at two device pixels a CSS pixel, sharp on a Retina screen.
    assert.match(
      await readFile(path.join(game, "unreal", "Config", "DefaultEngine.ini"), "utf8"),
      /\[\/Script\/WasmTargetPlatform\.WasmTargetSettings\]\nbInjectIsolationHeaders=True\nStartMode=Click\nMaxDevicePixelRatio=2\.0\n/,
    );
    // And its content comes in files a host takes one by one: set for the web alone, before the cook reads it.
    assert.equal(
      await readFile(path.join(game, "unreal", "Config", "Wasm", "WasmGame.ini"), "utf8"),
      "[/Script/UnrealEd.ProjectPackagingSettings]\nbGenerateChunks=True\nMaxChunkSize=262144000\n",
    );
    assert.deepEqual((await readdir(path.join(game, "unreal", "Config"))).sort(), ["DefaultEngine.ini", "Wasm"]);
    // After a restart the build in web/ is still named, with nothing to say of a site the host takes.
    const later = await createGamePackageTools(deps).handlers["package-status"](web, context, "/s");
    assert.deepEqual([later.state, later.app, later.line], [GamePackageState.Idle, "web/index.html", undefined]);
  });

  it("says which file of a finished web build is past the host's limits, before any upload and after a restart", async () => {
    const { game, project } = await gameWithCpp();
    /** A site whose content came in one file just past the host's 500 MiB (a sparse file: no disk is used). */
    const stagesOneBigFile: RunUat = async (launch, options) => {
      const outcome = await stagesWeb(launch, options);
      const found = /-stagingdirectory=(?:"([^"]+)"|(\S+))/.exec(launch.args.join(" "));
      const paks = path.join(found?.[1] ?? found?.[2] ?? "", "Wasm", "Dust", "Content", "Paks");
      await mkdir(paks, { recursive: true });
      await writeFile(path.join(paks, "pakchunk0-Wasm.ucas"), "");
      await truncate(path.join(paks, "pakchunk0-Wasm.ucas"), 500 * 1024 * 1024 + 9);
      return outcome;
    };
    const emsdk = await emsdkOf("6.0.10");
    const { deps } = depsFor(project, stagesOneBigFile, { engine: await engineFor(true), emsdk });
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    await tools.handlers["package-game"](web, context, "/s");
    const done = await settled(() => tools.handlers["package-status"](web, context, "/s"));
    // The build is made and is the game's web version; its line says what to fix before Publish.
    assert.deepEqual([done.state, done.app], [GamePackageState.Done, "web/index.html"]);
    const past =
      "The site is past Genex hosting's usual limits: web/Dust/Content/Paks/pakchunk0-Wasm.ucas is 501 MB, and a file may be 500 MB at most.";
    assert.equal(done.line, `The web build was made in 0 s. ${past}`);
    // After a restart the build's own line is gone; the build in web/ still says it.
    const later = await createGamePackageTools(deps).handlers["package-status"](web, context, "/s");
    assert.deepEqual([later.state, later.app, later.line], [GamePackageState.Idle, "web/index.html", past]);
    // With more files past the limit, the line names the largest and counts the rest (one at the limit is inside it).
    const paks = path.join(game, "web", "Dust", "Content", "Paks");
    const status = async (file: string, extra: number) => {
      await writeFile(path.join(paks, file), "");
      await truncate(path.join(paks, file), 500 * 1024 * 1024 + extra);
      return (await createGamePackageTools(deps).handlers["package-status"](web, context, "/s")).line;
    };
    assert.equal(await status("pakchunk1-Wasm.ucas", 0), past);
    const largest = "web/Dust/Content/Paks/pakchunk0-Wasm.ucas is 501 MB, and a file may be 500 MB at most";
    assert.equal(
      await status("pakchunk2-Wasm.ucas", 1),
      `The site is past Genex hosting's usual limits: ${largest} (1 more file is past that).`,
    );
    assert.equal(
      await status("pakchunk3-Wasm.ucas", 1),
      `The site is past Genex hosting's usual limits: ${largest} (2 more files are past that).`,
    );
  });

  it("packages nothing, and names no path of this computer, when the project's config can't be written safely", async () => {
    const { game, project } = await gameWithCpp();
    const outside = await tmpDir("unreal-package-outside-");
    await mkdir(path.join(game, "unreal", "Config"));
    await symlink(outside, path.join(game, "unreal", "Config", "Wasm"), "dir");
    const emsdk = await emsdkOf("6.0.10");
    const { deps, launches } = depsFor(project, stagesWeb, { engine: await engineFor(true), emsdk });
    const tools = createGamePackageTools(deps);
    const failure = await tools.handlers["package-game"](web, contextIn(game), "/s").then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /couldn't write the web build's settings.*unreal\/Config.*packaged nothing/);
    assert.ok(!failure.message.includes(game) && !failure.message.includes(outside), failure.message);
    assert.deepEqual([launches, await readdir(outside)], [[], []]);
    // No half of the settings is left behind: the config Genex could have written stays unwritten.
    assert.deepEqual(await readdir(path.join(game, "unreal", "Config")), ["Wasm"]);
    // The game's slot is free again: nothing reads as a package still running.
    const status = await tools.handlers["package-status"](web, contextIn(game), "/s");
    assert.deepEqual([status.state, status.jobRunning], [GamePackageState.Idle, false]);
  });

  it("never makes a staged page without its file list the game's web version", async () => {
    const { game, project } = await gameWithCpp();
    const pageOnly: RunUat = async (launch) => {
      const found = /-stagingdirectory=(?:"([^"]+)"|(\S+))/.exec(launch.args.join(" "));
      const site = path.join(found?.[1] ?? found?.[2] ?? "", "Wasm");
      await mkdir(site, { recursive: true });
      await writeFile(path.join(site, "index.html"), "<!doctype html>");
      return { code: 0, output: PACKAGED, timedOut: false };
    };
    const emsdk = await emsdkOf("6.0.10");
    const { deps } = depsFor(project, pageOnly, { engine: await engineFor(true), emsdk });
    const tools = createGamePackageTools(deps);
    const context = contextIn(game);
    await tools.handlers["package-game"](web, context, "/s");
    const done = await settled(() => tools.handlers["package-status"](web, context, "/s"));
    assert.equal(done.state, GamePackageState.Failed, done.line);
    assert.match(done.line ?? "", /no Wasm app is in the build folder/);
    // A web/ with no file list would read as someone else's folder and refuse every later build.
    assert.deepEqual(await readdir(game), ["unreal"]);
  });

  it("refuses, saving and running nothing, while web/ holds anything but an Unreal web build", async () => {
    const { game, project } = await gameWithCpp();
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "index.html"), "<p>a mockup</p>");
    const emsdk = await emsdkOf("6.0.10");
    const { deps, launches, saves } = depsFor(project, stagesWeb, {
      answers: true,
      engine: await engineFor(true),
      emsdk,
    });
    await assert.rejects(
      createGamePackageTools(deps).handlers["package-game"](web, contextIn(game), "/s"),
      /web\/ folder holds other files/,
    );
    assert.deepEqual([launches, saves], [[], []]);
    assert.equal(await readFile(path.join(game, "web", "index.html"), "utf8"), "<p>a mockup</p>");
  });

  const refusals: Array<{
    name: string;
    cpp?: boolean;
    engine?: boolean;
    emsdk?: () => Promise<string | undefined>;
    says: RegExp;
  }> = [
    {
      name: "an Unreal whose install has no web platform",
      engine: false,
      says: /Unreal 5\.9 on this computer can't build for the web/,
    },
    {
      name: "a game in Blueprints only",
      cpp: false,
      says: /needs the game's C\+\+ module.*unreal__add-cpp-module/,
    },
    {
      name: "no emsdk named",
      emsdk: async () => undefined,
      says: /emscripten 6\.0\.10.*emsdk install 6\.0\.10.*WASM_EMSDK_ROOT/,
    },
    {
      name: "an emsdk of another emscripten",
      emsdk: () => emsdkOf("6.0.11"),
      says: /emscripten 6\.0\.10/,
    },
  ];
  for (const refusal of refusals)
    it(`refuses, saving and running nothing, with ${refusal.name}`, async () => {
      const { game, project } = refusal.cpp === false ? await gameWithProject() : await gameWithCpp();
      const emsdk = refusal.emsdk ? await refusal.emsdk() : await emsdkOf("6.0.10");
      const engine = await engineFor(refusal.engine !== false);
      const { deps, launches, saves } = depsFor(project, stagesWeb, { answers: true, engine, emsdk });
      await assert.rejects(
        createGamePackageTools(deps).handlers["package-game"](web, contextIn(game), "/s"),
        refusal.says,
      );
      assert.deepEqual([launches, saves], [[], []]);
      assert.deepEqual(await readdir(path.join(game, "unreal")), ["Dust.uproject"], "no build folder was made");
    });

  it("an Unreal older than the web platform is told so, not sent for emscripten", async () => {
    const { game, project } = await gameWithCpp();
    const { deps } = depsFor(project, stagesWeb, { emsdk: await emsdkOf("6.0.10") });
    await assert.rejects(
      createGamePackageTools(deps).handlers["package-game"](web, contextIn(game), "/s"),
      /Unreal 5\.8 on this computer can't build for the web/,
    );
  });
});

async function packagedWithTwoUnreals(association: string, uproject?: string) {
  const launches: UatLaunch[] = [];
  const runUat: RunUat = async (launch) => {
    launches.push(launch);
    return { code: 0, output: PACKAGED, timedOut: false };
  };
  const f = await unrealBackendFixture({ older: true, programs: { runUat } });
  const project = await f.linkProject(association);
  if (uproject !== undefined) await writeFile(project, uproject);
  await f.call(GamePackageToolName.PackageGame, {});
  await settled(() => f.call(GamePackageToolName.PackageStatus, {}) as Promise<GamePackageAnswer>);
  const [launch] = launches;
  const cooksWith = launch?.args.find((arg) => arg.startsWith("-unrealexe="));
  return { older: f.older?.directory ?? "", newer: f.engine.directory, started: [launch?.file, cooksWith] };
}

describe("packaging an Unreal game where two Unreals are installed", () => {
  it("packages a game with the Unreal its own project names, the older one or the newer", async () => {
    const older = await packagedWithTwoUnreals("5.8");
    assert.deepEqual(older.started, uatOf(older.older), "a 5.8 game is built and cooked by 5.8");
    const newer = await packagedWithTwoUnreals("5.9");
    assert.deepEqual(newer.started, uatOf(newer.newer), "a 5.9 game by 5.9");
  });

  const newest: Array<[string, string, string?]> = [
    ["names an Unreal that isn't installed", "5.10"],
    ["names a source build by its id", "{2E6C4A1B-0D4F-4B63-9B5E-0F3C1A7D9E52}"],
    ["names no engine", ""],
    ["can't be read", "5.8", "not a project file"],
  ];
  for (const [why, association, uproject] of newest)
    it(`packages with the newest Unreal a game whose project ${why}`, async () => {
      const packaged = await packagedWithTwoUnreals(association, uproject);
      assert.deepEqual(packaged.started, uatOf(packaged.newer));
    });
});

describe("a Mac app's network entitlement, through codesign", () => {
  it("adds network.client to an ad hoc sandboxed app and keeps its other entitlements", {
    skip: process.platform !== "darwin" && "codesign is macOS's",
  }, async () => {
    const app = path.join(await tmpDir("unreal-entitlements-"), "Mini.app");
    await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
    await copyFile("/usr/bin/true", path.join(app, "Contents", "MacOS", "mini"));
    await writeFile(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>games.genex.mini</string><key>CFBundleExecutable</key><string>mini</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`,
    );
    const noNet = path.join(path.dirname(app), "NoNet.entitlements");
    await writeFile(
      noNet,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>\n`,
    );
    const signedNoNet = spawnSync("codesign", ["--force", "--sign", "-", "--entitlements", noNet, app], {
      encoding: "utf8",
    });
    assert.equal(signedNoNet.status, 0, signedNoNet.stderr);
    assert.deepEqual(await systemMacSigner.read(app), { [MacEntitlement.AppSandbox]: true });

    await systemMacSigner.sign(app, { [MacEntitlement.AppSandbox]: true, [MacEntitlement.NetworkClient]: true });
    assert.deepEqual(await systemMacSigner.read(app), {
      [MacEntitlement.AppSandbox]: true,
      [MacEntitlement.NetworkClient]: true,
    });
    const verify = spawnSync("codesign", ["--verify", "--strict", app], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
  });
});
