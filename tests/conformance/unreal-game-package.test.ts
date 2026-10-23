/**
 * Packaging an Unreal game as the app its players install (`unreal__package-game`): BuildCookRun's
 * words for this computer's system, RunUAT.bat's line on Windows with every path whole in quotes,
 * Unreal's work saved before the package, the app found where Publish looks, and a failed package's
 * error lines with none of the computer's paths. RunUAT and the editor are stand-ins.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
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
  type GamePackageStatus,
  packageErrors,
  type RunUat,
  uatEnv,
  uatLaunch,
} from "../../src/plugins/unreal/game-package.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

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
  options: { answers?: boolean; saved?: boolean; platform?: NodeJS.Platform; toolchain?: string } = {},
) {
  const launches: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const saves: string[] = [];
  const deps: GamePackageDeps = {
    platform: options.platform ?? "darwin",
    engine: async () => ({ version: "5.8", directory: ENGINE }),
    linuxToolchain: async () => options.toolchain,
    project: async () => project,
    xcode: async () => ({ state: XcodeState.Ready }),
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
  };
  return { deps, launches, saves, envs };
}

/** `package-status` until the job is no longer running. */
async function settled(status: () => Promise<GamePackageStatus>): Promise<GamePackageStatus> {
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
    const done = await settled(() => tools.handlers["package-status"]({}, context, "/storage"));
    assert.equal(done.state, GamePackageState.Done, done.line);
    assert.equal(done.app, "unreal/Builds/Mac/Dust-Mac-Shipping.app");
    assert.deepEqual(saves, ["dust"], "the open Unreal saved first");
    assert.equal(launches.length, 1);
    // After a restart, the app on disk is still named.
    const fresh = createGamePackageTools(deps);
    const idle = await fresh.handlers["package-status"]({}, context, "/storage");
    assert.deepEqual(idle, {
      state: GamePackageState.Idle,
      system: "Mac",
      app: "unreal/Builds/Mac/Dust-Mac-Shipping.app",
    });
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

  it("knows Epic's Linux toolchain for each Unreal Genex makes games with", () => {
    for (const version of ["5.7", "5.8"])
      assert.deepEqual(linuxToolchainFor(version), {
        name: "v26_clang-20.1.8-rockylinux8",
        url: "https://cdn.unrealengine.com/CrossToolchain_Linux/v26_clang-20.1.8-rockylinux8.exe",
      });
    for (const version of ["5.9", "4.27", "", "5.8.1"]) assert.equal(linuxToolchainFor(version), null, version);
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
    assert.deepEqual(idle, { state: GamePackageState.Idle, system: "Linux", app: "unreal/Builds/Linux/Dust.sh" });
    const own = await createGamePackageTools(deps).handlers["package-status"]({}, context, "/s");
    assert.deepEqual(own, { state: GamePackageState.Idle, system: "Windows" }, "Windows' own build folder is apart");
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
