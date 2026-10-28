/**
 * What Do it for me installs itself on Windows: Epic's launcher, downloaded only over HTTPS from
 * Epic's own hosts and only up to its size cap, checked as signed by Epic Games Inc. (Authenticode),
 * and only then run with Windows Installer; and Microsoft's Visual C++ runtime from the engine's own
 * copy, checked as signed by Microsoft Corporation. Every hostile shape runs nothing and leaves no
 * temporary folder behind. Programs and the network are fakes.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EPIC_INSTALLER_URL,
  type EpicCommandResult,
  type EpicInstallDeps,
  EpicInstallError,
  EpicInstallPhase,
  EpicInstallRefusal,
  hasUnrealRuntime,
  installEpicLauncher,
  installUnrealRuntime,
  MAX_INSTALLER_BYTES,
  runtimeInstaller,
  signedBy,
} from "../../src/plugins/unreal/epic-install.ts";
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
  const run: EpicInstallDeps["run"] = async (file, args, options): Promise<EpicCommandResult> => {
    calls.push({ file, args: [...args], env: options.env, visible: options.visible });
    if (file === POWERSHELL)
      return { code: 0, stdout: JSON.stringify(script.signature ?? { status: "Valid", subject: EPIC_SUBJECT }) };
    return { code: script.installerCode ?? 0, stdout: "" };
  };
  return { calls, run };
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
