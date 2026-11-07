/**
 * What Do it for me installs itself on Windows: Epic's launcher, downloaded only over HTTPS from
 * Epic's own hosts and only up to its size cap, checked as signed by Epic Games Inc. (Authenticode),
 * and only then run with Windows Installer; Microsoft's Visual C++ runtime from the engine's own
 * copy, checked as signed by Microsoft Corporation; and Microsoft's Visual Studio Build Tools,
 * downloaded the same way from Microsoft's own hosts and checked as signed by Microsoft. Every
 * hostile shape runs nothing and leaves no temporary folder behind. Programs and the network are fakes.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BUILD_TOOLS_RUN_MS,
  buildToolsArgs,
  EPIC_INSTALLER_URL,
  type EpicCommandResult,
  type EpicInstallDeps,
  EpicInstallError,
  EpicInstallPhase,
  EpicInstallRefusal,
  hasUnrealRuntime,
  installBuildTools,
  installEpicLauncher,
  installUnrealRuntime,
  MAX_INSTALLER_BYTES,
  runtimeInstaller,
  signedBy,
} from "../../src/plugins/unreal/epic-install.ts";
import { BUILD_TOOLS_URL, BuildToolsPlan } from "../../src/plugins/unreal/visual-studio.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MSIEXEC = "C:\\Windows\\System32\\msiexec.exe";
const CDN =
  "https://epicgames-download1.akamaized.net/Builds/UnrealEngineLauncher/Installers/Windows/EpicInstaller-20.3.3.msi";
const EPIC_SUBJECT =
  "CN=Epic Games Inc., O=Epic Games Inc., L=Cary, S=North Carolina, C=US, SERIALNUMBER=D03752763, OID.2.5.4.15=Private Organization";
const MICROSOFT_SUBJECT = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const INSTALLER_BYTES = Buffer.from("epic installer bytes");

/** One program call as the fake computer saw it. */
type Call = { file: string; args: string[]; env?: NodeJS.ProcessEnv; visible?: boolean };

/** A computer that records every program it runs: Authenticode answers `signature`, an installer `installerCode`. */
function fakeComputer(script: { signature?: { status: string; subject: string }; installerCode?: number } = {}) {
  const calls: Call[] = [];
  /** Each program's time limit, in the order they ran. */
  const limits: number[] = [];
  const run: EpicInstallDeps["run"] = async (file, args, options): Promise<EpicCommandResult> => {
    calls.push({ file, args: [...args], env: options.env, visible: options.visible });
    limits.push(options.timeoutMs);
    if (file === POWERSHELL)
      return { code: 0, stdout: JSON.stringify(script.signature ?? { status: "Valid", subject: EPIC_SUBJECT }) };
    return { code: script.installerCode ?? 0, stdout: "" };
  };
  return { calls, run, limits };
}

/** A fetch that answers `routes` by URL and records every URL asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    assert.equal(init?.redirect, "manual", "each redirect is checked by Genex, not followed blindly");
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  }) as typeof fetch;
  return { fetchFn, asked };
}

const ok = (body: BodyInit = INSTALLER_BYTES, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });
const redirect = (location: string) => new Response(null, { status: 303, headers: { location } });
/** Epic's real shape: its launcher link sends the download to its CDN. */
const EPIC_ROUTES = { [EPIC_INSTALLER_URL]: () => redirect(CDN), [CDN]: () => ok() };

async function installDeps(fetchFn: typeof fetch, run: EpicInstallDeps["run"], platform: NodeJS.Platform = "win32") {
  const tempRoot = await tmpDir("epic-install-");
  const deps: EpicInstallDeps = { platform, env: { SystemRoot: "C:\\Windows" }, fetch: fetchFn, run, tempRoot };
  return { deps, tempRoot };
}

async function refusal(promise: Promise<unknown>): Promise<EpicInstallRefusal> {
  const error = await promise.then(
    () => assert.fail("the install went on"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof EpicInstallError, String(error));
  assert.ok(error.message.length > 0, "said in plain words");
  return error.code;
}

const stillGoing = () => ({ signal: new AbortController().signal });
const installerRan = (calls: Call[]) => calls.some((call) => call.file === MSIEXEC);

describe("Epic's launcher, installed for the person on Windows", () => {
  it("downloads Epic's installer through Epic's CDN, checks Epic signed it, runs it with Windows Installer, and removes its folder", async () => {
    const computer = fakeComputer();
    const network = fakeFetch(EPIC_ROUTES);
    const { deps, tempRoot } = await installDeps(network.fetchFn, computer.run);
    const phases: EpicInstallPhase[] = [];
    await installEpicLauncher(deps, { ...stillGoing(), onPhase: (phase) => phases.push(phase) });
    assert.deepEqual(network.asked, [EPIC_INSTALLER_URL, CDN]);
    assert.deepEqual(phases, [EpicInstallPhase.Downloading, EpicInstallPhase.Checking, EpicInstallPhase.Installing]);
    const [check, install] = computer.calls;
    assert.equal(check?.file, POWERSHELL);
    const msi = check?.env?.GENEX_INSTALLER ?? "";
    assert.ok(
      msi.startsWith(tempRoot) && msi.endsWith("EpicInstaller.msi"),
      "the downloaded file, in a private folder",
    );
    assert.ok(
      !check?.args.join(" ").includes(msi),
      "the path reaches PowerShell through its environment, never the command",
    );
    assert.deepEqual(install, {
      file: MSIEXEC,
      args: ["/i", msi, "/passive", "/norestart"],
      env: undefined,
      visible: true,
    });
    assert.deepEqual(await readdir(tempRoot), [], "the temporary folder is gone");
  });

  it("counts Windows Installer's restart-needed exit as installed, and the person's No as no permission", async () => {
    const restart = fakeComputer({ installerCode: 3010 });
    await installEpicLauncher((await installDeps(fakeFetch(EPIC_ROUTES).fetchFn, restart.run)).deps, stillGoing());
    const no = fakeComputer({ installerCode: 1602 });
    const { deps } = await installDeps(fakeFetch(EPIC_ROUTES).fetchFn, no.run);
    assert.equal(await refusal(installEpicLauncher(deps, stillGoing())), EpicInstallRefusal.NoPermission);
    const broken = fakeComputer({ installerCode: 1603 });
    const failed = await installDeps(fakeFetch(EPIC_ROUTES).fetchFn, broken.run);
    assert.equal(await refusal(installEpicLauncher(failed.deps, stillGoing())), EpicInstallRefusal.InstallerFailed);
  });

  const hostile: Array<
    [
      string,
      Record<string, () => Response>,
      EpicInstallRefusal,
      Partial<{ signature: { status: string; subject: string } }>,
    ]
  > = [
    [
      "a redirect to another host",
      { [EPIC_INSTALLER_URL]: () => redirect("https://evil.example/EpicInstaller.msi") },
      EpicInstallRefusal.OtherHost,
      {},
    ],
    [
      "a redirect over plain HTTP",
      { [EPIC_INSTALLER_URL]: () => redirect(CDN.replace("https:", "http:")) },
      EpicInstallRefusal.NotHttps,
      {},
    ],
    [
      "a redirect to an Epic host on another port",
      { [EPIC_INSTALLER_URL]: () => redirect(CDN.replace(".net/", ".net:8443/")) },
      EpicInstallRefusal.OtherHost,
      {},
    ],
    [
      "a download that says it is bigger than any installer",
      { [EPIC_INSTALLER_URL]: () => ok(INSTALLER_BYTES, { "content-length": String(MAX_INSTALLER_BYTES + 1) }) },
      EpicInstallRefusal.TooLarge,
      {},
    ],
    [
      "a failed download",
      { [EPIC_INSTALLER_URL]: () => new Response("nope", { status: 500 }) },
      EpicInstallRefusal.DownloadFailed,
      {},
    ],
    [
      "an unsigned installer",
      EPIC_ROUTES,
      EpicInstallRefusal.Unsigned,
      { signature: { status: "NotSigned", subject: "" } },
    ],
    [
      "a signature that doesn't verify",
      EPIC_ROUTES,
      EpicInstallRefusal.Unsigned,
      { signature: { status: "HashMismatch", subject: EPIC_SUBJECT } },
    ],
    [
      "an installer someone else signed",
      EPIC_ROUTES,
      EpicInstallRefusal.WrongSigner,
      { signature: { status: "Valid", subject: "CN=Evil Corp" } },
    ],
  ];
  for (const [name, routes, code, script] of hostile)
    it(`runs nothing for ${name}, and leaves no folder`, async () => {
      const computer = fakeComputer(script);
      const { deps, tempRoot } = await installDeps(fakeFetch(routes).fetchFn, computer.run);
      assert.equal(await refusal(installEpicLauncher(deps, stillGoing())), code);
      assert.equal(installerRan(computer.calls), false);
      assert.deepEqual(await readdir(tempRoot), []);
    });

  it("stops at the person's Stop before anything runs, and refuses off Windows", async () => {
    const computer = fakeComputer();
    const { deps } = await installDeps(fakeFetch(EPIC_ROUTES).fetchFn, computer.run);
    const stopped = new AbortController();
    stopped.abort();
    assert.equal(await refusal(installEpicLauncher(deps, { signal: stopped.signal })), EpicInstallRefusal.Cancelled);
    const mac = await installDeps(fakeFetch(EPIC_ROUTES).fetchFn, computer.run, "darwin");
    assert.equal(await refusal(installEpicLauncher(mac.deps, stillGoing())), EpicInstallRefusal.Unsupported);
    assert.deepEqual(computer.calls, []);
  });

  it("reads a signer's name exactly, and refuses a subject with an escape", () => {
    assert.equal(signedBy(EPIC_SUBJECT, "Epic Games Inc."), true);
    assert.equal(signedBy('CN="Epic Games Inc.", C=US', "Epic Games Inc."), true);
    assert.equal(signedBy("CN=Epic Games Inc. Ltd, O=Other", "Epic Games Inc."), false);
    assert.equal(signedBy("CN=Evil\\, O=Epic Games Inc.", "Epic Games Inc."), false);
    assert.equal(signedBy("OU=Epic Games Inc.", "Epic Games Inc."), false);
  });
});

describe("Microsoft's Visual C++ runtime, from Unreal's own copy", () => {
  /** An engine folder with its runtime installer, unless `withInstaller` is false. */
  async function engine(withInstaller = true) {
    const folder = path.join(await tmpDir("epic-runtime-"), "UE_5.8");
    if (withInstaller) {
      await mkdir(path.dirname(runtimeInstaller(folder)), { recursive: true });
      await writeFile(runtimeInstaller(folder), "MZ");
    } else await mkdir(folder, { recursive: true });
    return folder;
  }

  it("checks Microsoft signed it, then runs it quietly with Windows' own prompt", async () => {
    const computer = fakeComputer({ signature: { status: "Valid", subject: MICROSOFT_SUBJECT } });
    const { deps } = await installDeps(fakeFetch({}).fetchFn, computer.run);
    const folder = await engine();
    await installUnrealRuntime(deps, folder, stillGoing());
    assert.equal(computer.calls[0]?.env?.GENEX_INSTALLER, runtimeInstaller(folder));
    assert.deepEqual(computer.calls[1], {
      file: runtimeInstaller(folder),
      args: ["/install", "/passive", "/norestart"],
      env: undefined,
      visible: true,
    });
  });

  it("counts a newer runtime already there as installed", async () => {
    const computer = fakeComputer({ signature: { status: "Valid", subject: MICROSOFT_SUBJECT }, installerCode: 1638 });
    await installUnrealRuntime(
      (await installDeps(fakeFetch({}).fetchFn, computer.run)).deps,
      await engine(),
      stillGoing(),
    );
  });

  it("runs nothing when the engine has no copy, or one Microsoft didn't sign", async () => {
    const computer = fakeComputer({ signature: { status: "Valid", subject: EPIC_SUBJECT } });
    const { deps } = await installDeps(fakeFetch({}).fetchFn, computer.run);
    assert.equal(
      await refusal(installUnrealRuntime(deps, await engine(false), stillGoing())),
      EpicInstallRefusal.NoInstaller,
    );
    assert.deepEqual(computer.calls, []);
    assert.equal(
      await refusal(installUnrealRuntime(deps, await engine(), stillGoing())),
      EpicInstallRefusal.WrongSigner,
    );
    assert.equal(computer.calls.length, 1, "only the signature check ran");
  });

  it("finds the runtime only when each of its files is a plain file in System32", async () => {
    const system32 = await tmpDir("epic-system32-");
    assert.equal(await hasUnrealRuntime(system32), false);
    for (const name of ["msvcp140.dll", "vcruntime140.dll"]) await writeFile(path.join(system32, name), "MZ");
    await mkdir(path.join(system32, "vcruntime140_1.dll"));
    assert.equal(await hasUnrealRuntime(system32), false, "a folder by that name is no runtime");
    const complete = await tmpDir("epic-system32-");
    for (const name of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"])
      await writeFile(path.join(complete, name), "MZ");
    assert.equal(await hasUnrealRuntime(complete), true);
  });
});

describe("Microsoft's Visual Studio Build Tools, installed for the person on Windows", () => {
  const MICROSOFT_CDN =
    "https://download.visualstudio.microsoft.com/download/pr/6bd63d7f-1818-4e03-a552-9feb11496c19/972d771c/vs_BuildTools.exe";
  /** Microsoft's real shape: its aka.ms link sends the download to its download host. */
  const MICROSOFT_ROUTES = { [BUILD_TOOLS_URL]: () => redirect(MICROSOFT_CDN), [MICROSOFT_CDN]: () => ok() };
  const MICROSOFT_SIGNED = { signature: { status: "Valid", subject: MICROSOFT_SUBJECT } };
  const BUILD_TOOLS_PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";
  const COMPONENTS = [
    "--add",
    "Microsoft.VisualStudio.Workload.VCTools",
    "--add",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "--add",
    "Microsoft.VisualStudio.Component.Windows11SDK.22621",
    "--add",
    "Microsoft.Net.Component.4.8.SDK",
  ];
  const ranInstaller = (calls: Call[]) => calls.some((call) => call.file.endsWith("vs_BuildTools.exe"));

  it("downloads Microsoft's installer through Microsoft's host, checks Microsoft signed it, and installs the C++ tools", async () => {
    const computer = fakeComputer(MICROSOFT_SIGNED);
    const network = fakeFetch(MICROSOFT_ROUTES);
    const { deps, tempRoot } = await installDeps(network.fetchFn, computer.run);
    const phases: EpicInstallPhase[] = [];
    const job = { plan: BuildToolsPlan.Install };
    await installBuildTools(deps, job, { ...stillGoing(), onPhase: (phase) => phases.push(phase) });
    assert.deepEqual(network.asked, [BUILD_TOOLS_URL, MICROSOFT_CDN]);
    assert.deepEqual(phases, [EpicInstallPhase.Downloading, EpicInstallPhase.Checking, EpicInstallPhase.Installing]);
    const [check, install] = computer.calls;
    const installer = check?.env?.GENEX_INSTALLER ?? "";
    assert.equal(check?.file, POWERSHELL);
    assert.ok(installer.startsWith(tempRoot) && installer.endsWith("vs_BuildTools.exe"), "in a private folder");
    assert.deepEqual(install, {
      file: installer,
      args: ["--passive", "--norestart", "--wait", "--nocache", ...COMPONENTS],
      env: undefined,
      visible: true,
    });
    assert.equal(computer.limits[1], BUILD_TOOLS_RUN_MS, "the installer has its own, longer limit");
    assert.deepEqual(await readdir(tempRoot), [], "the temporary folder is gone");
  });

  it("adds the C++ tools to the Build Tools install there, or updates it", () => {
    const at = { installPath: BUILD_TOOLS_PATH };
    assert.deepEqual(buildToolsArgs({ plan: BuildToolsPlan.Modify, ...at }), [
      "modify",
      "--installPath",
      BUILD_TOOLS_PATH,
      "--channelId",
      "VisualStudio.17.Release",
      ...COMPONENTS,
      "--passive",
      "--norestart",
      "--wait",
    ]);
    assert.deepEqual(buildToolsArgs({ plan: BuildToolsPlan.Update, ...at }), [
      "update",
      "--installPath",
      BUILD_TOOLS_PATH,
      "--passive",
      "--norestart",
      "--wait",
    ]);
  });

  it("adds them on the Build Tools install's own channel, and refuses a job with no plan", () => {
    const ltsc = {
      plan: BuildToolsPlan.Modify,
      installPath: BUILD_TOOLS_PATH,
      channelId: "VisualStudio.17.Release.LTSC.17.12",
    };
    assert.deepEqual(buildToolsArgs(ltsc).slice(3, 5), ["--channelId", "VisualStudio.17.Release.LTSC.17.12"]);
    assert.throws(() => buildToolsArgs({ installPath: BUILD_TOOLS_PATH }), EpicInstallError);
  });

  const installPaths: Array<[string, string | undefined]> = [
    ["no install to change", undefined],
    ["a relative path", "..\\Users\\me"],
    ["a path with a quote", 'C:\\VS" --remove x'],
  ];
  for (const [shape, installPath] of installPaths)
    it(`downloads and runs nothing for a change of ${shape}`, async () => {
      const computer = fakeComputer(MICROSOFT_SIGNED);
      const network = fakeFetch(MICROSOFT_ROUTES);
      const { deps, tempRoot } = await installDeps(network.fetchFn, computer.run);
      const job = { plan: BuildToolsPlan.Modify, ...(installPath === undefined ? {} : { installPath }) };
      assert.equal(await refusal(installBuildTools(deps, job, stillGoing())), EpicInstallRefusal.InstallerFailed);
      assert.deepEqual([network.asked, computer.calls], [[], []]);
      assert.deepEqual(await readdir(tempRoot), []);
    });

  const codes: Array<[number, EpicInstallRefusal | "installed"]> = [
    [0, "installed"],
    [3010, "installed"],
    [1641, "installed"],
    [1602, EpicInstallRefusal.NoPermission],
    [5004, EpicInstallRefusal.NoPermission],
    [740, EpicInstallRefusal.NoPermission],
    [1618, EpicInstallRefusal.InstallerBusy],
    [8006, EpicInstallRefusal.InstallerBusy],
    [5003, EpicInstallRefusal.Offline],
    [-1073720687, EpicInstallRefusal.Offline],
    [3221246609, EpicInstallRefusal.Offline],
    [1, EpicInstallRefusal.InstallerFailed],
  ];
  for (const [code, outcome] of codes)
    it(`reads the installer's exit ${code} as ${outcome}`, async () => {
      const computer = fakeComputer({ ...MICROSOFT_SIGNED, installerCode: code });
      const { deps } = await installDeps(fakeFetch(MICROSOFT_ROUTES).fetchFn, computer.run);
      const install = installBuildTools(deps, { plan: BuildToolsPlan.Install }, stillGoing());
      if (outcome === "installed") await install;
      else assert.equal(await refusal(install), outcome);
    });

  const hostile: Array<[string, Record<string, () => Response>, EpicInstallRefusal, RegExp | null, object]> = [
    [
      "a redirect to another host",
      { [BUILD_TOOLS_URL]: () => redirect("https://evil.example/vs_BuildTools.exe") },
      EpicInstallRefusal.OtherHost,
      /^Microsoft's download led somewhere other than Microsoft/,
      MICROSOFT_SIGNED,
    ],
    [
      "a redirect to Epic's CDN",
      { [BUILD_TOOLS_URL]: () => redirect(CDN) },
      EpicInstallRefusal.OtherHost,
      /Microsoft/,
      MICROSOFT_SIGNED,
    ],
    [
      "a redirect over plain HTTP",
      { [BUILD_TOOLS_URL]: () => redirect(MICROSOFT_CDN.replace("https:", "http:")) },
      EpicInstallRefusal.NotHttps,
      /^Microsoft's download link wasn't secure/,
      MICROSOFT_SIGNED,
    ],
    [
      "a failed download",
      { [BUILD_TOOLS_URL]: () => new Response("nope", { status: 503 }) },
      EpicInstallRefusal.DownloadFailed,
      /^Microsoft's installer didn't download/,
      MICROSOFT_SIGNED,
    ],
    [
      "an unsigned installer",
      MICROSOFT_ROUTES,
      EpicInstallRefusal.Unsigned,
      null,
      { signature: { status: "NotSigned", subject: "" } },
    ],
    ["an installer Epic signed", MICROSOFT_ROUTES, EpicInstallRefusal.WrongSigner, null, {}],
  ];
  for (const [name, routes, code, words, script] of hostile)
    it(`runs nothing for ${name}, and leaves no folder`, async () => {
      const computer = fakeComputer(script);
      const { deps, tempRoot } = await installDeps(fakeFetch(routes).fetchFn, computer.run);
      const install = installBuildTools(deps, { plan: BuildToolsPlan.Install }, stillGoing());
      const error = await install.then(
        () => assert.fail("the install went on"),
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof EpicInstallError);
      assert.equal(error.code, code);
      if (words) assert.match(error.message, words, "said of Microsoft, not Epic");
      assert.equal(ranInstaller(computer.calls), false);
      assert.deepEqual(await readdir(tempRoot), []);
    });

  it("stops at the person's Stop before anything runs, and refuses off Windows", async () => {
    const computer = fakeComputer(MICROSOFT_SIGNED);
    const { deps } = await installDeps(fakeFetch(MICROSOFT_ROUTES).fetchFn, computer.run);
    const stopped = new AbortController();
    stopped.abort();
    const job = { plan: BuildToolsPlan.Install };
    assert.equal(await refusal(installBuildTools(deps, job, { signal: stopped.signal })), EpicInstallRefusal.Cancelled);
    const mac = await installDeps(fakeFetch(MICROSOFT_ROUTES).fetchFn, computer.run, "darwin");
    assert.equal(await refusal(installBuildTools(mac.deps, job, stillGoing())), EpicInstallRefusal.Unsupported);
    assert.deepEqual(computer.calls, []);
  });
});
