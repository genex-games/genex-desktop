/**
 * Get Roblox Studio from nothing: Roblox's own installer is downloaded only over HTTPS from
 * setup.rbxcdn.com and only up to its size cap, checked as signed by Roblox (codesign and Roblox's
 * team id on a Mac, Authenticode and Roblox's signer on Windows), and only then run. Every hostile
 * shape runs nothing and leaves no temporary folder behind. After the installer, Genex waits for
 * Studio, lets the person sign in in the installer's own Studio (which closes by itself), sets
 * Studio up while it is closed, and opens it again once. Programs, the network and time are fakes.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { HELPER_FILE, type SetupDone, setUp, setupPaths } from "../../src/plugins/roblox/setup.ts";
import type { Launch } from "../../src/plugins/roblox/studio-launch.ts";
import type { LocateStat, Run } from "../../src/plugins/roblox/studio-locate.ts";
import { STUDIO_MAC_APP } from "../../src/plugins/roblox/studio-locate.ts";
import {
  ALLOWED_HOST,
  type AfterInstallDeps,
  afterInstall,
  INSTALL_WAIT_MS,
  INSTALLER,
  type InstallCommandResult,
  type InstallDeps,
  InstallError,
  InstallPhase,
  InstallRefusal,
  installStudio,
  MAX_INSTALLER_BYTES,
  SIGN_IN_WAIT_MS,
  signedByRoblox,
} from "../../src/plugins/roblox/studio-install.ts";
import { shippedHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;
const CODESIGN = "/usr/bin/codesign";
const HDIUTIL = "/usr/bin/hdiutil";
const SPCTL = "/usr/sbin/spctl";
const MAC_OPEN = "/usr/bin/open";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ROBLOX_TEAM = "2CFABCH843";
const ROBLOX_SUBJECT = "CN=Roblox Corporation, O=Roblox Corporation, L=San Mateo, S=California, C=US";
const INSTALLER_BYTES = Buffer.from("roblox installer bytes");

/** One program call as the fake computer saw it. */
interface Call {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  visible?: boolean;
}

/** How the fake computer answers: each knob turns one check hostile. */
interface Script {
  dmgSigned?: boolean;
  dmgTeam?: string;
  appSigned?: boolean;
  appTeam?: string;
  /**
   * Signed by a certificate no Apple root vouches for, whose subject names Roblox's team: codesign
   * accepts it against its own designated requirement and prints that team, and refuses it only
   * against Genex's requirement (`-R`).
   */
  dmgSelfSigned?: boolean;
  appSelfSigned?: boolean;
  /** Gatekeeper (`spctl`) accepts the installer app: Developer ID, notarized. */
  appAssessed?: boolean;
  /** The mounted DMG holds Roblox's installer app. */
  hasApp?: boolean;
  authenticode?: { status: string; subject: string };
  installerCode?: number;
}

function codesignDetails(team: string) {
  return [
    "Executable=/Volumes/RobloxStudioInstaller/RobloxStudioInstaller.app/Contents/MacOS/RobloxStudioInstaller",
    "Identifier=com.roblox.RobloxStudioInstaller",
    "Format=app bundle with Mach-O universal (x86_64 arm64)",
    `TeamIdentifier=${team}`,
  ].join("\n");
}

/** A computer that records every program it is asked to run and answers per `script`. */
function fakeComputer(script: Script = {}) {
  const calls: Call[] = [];
  const answer = (code: number, stdout = "", stderr = ""): InstallCommandResult => ({ code, stdout, stderr });
  const run: InstallDeps["run"] = async (file, args, options) => {
    calls.push({ file, args: [...args], env: options.env, visible: options.visible });
    if (file === CODESIGN) {
      const onApp = args.some((arg) => arg.endsWith(".app"));
      const signed = onApp ? (script.appSigned ?? true) : (script.dmgSigned ?? true);
      const team = onApp ? (script.appTeam ?? ROBLOX_TEAM) : (script.dmgTeam ?? ROBLOX_TEAM);
      const selfSigned = onApp ? script.appSelfSigned : script.dmgSelfSigned;
      const requirement = args.find((arg) => arg.startsWith("-R="));
      const anchored = requirement?.includes("anchor apple generic") && requirement.includes(`"${team}"`);
      if (args.includes("--verify") && !signed) return answer(1, "", "code object is not signed at all");
      if (args.includes("--verify") && requirement && (selfSigned || !anchored))
        return answer(3, "", "test-requirement: code failed to satisfy specified code requirement(s)");
      if (args.includes("--verify")) return answer(0);
      return answer(0, "", codesignDetails(team));
    }
    if (file === HDIUTIL && args[0] === "attach") {
      const mount = args[args.indexOf("-mountpoint") + 1] ?? "";
      if (script.hasApp ?? true) await mkdir(path.join(mount, "RobloxStudioInstaller.app"), { recursive: true });
      return answer(0);
    }
    if (file === HDIUTIL) return answer(0);
    if (file === SPCTL) return (script.appAssessed ?? true) ? answer(0, "", "accepted") : answer(3, "", "rejected");
    if (file === POWERSHELL) {
      const signature = script.authenticode ?? { status: "Valid", subject: ROBLOX_SUBJECT };
      return answer(0, JSON.stringify(signature));
    }
    // Roblox's installer itself: `open -W` on a Mac, the program on Windows.
    return answer(script.installerCode ?? 0);
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
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** A body that streams `chunks` with no length given. */
function streamed(chunks: number, size: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

async function installDeps(platform: NodeJS.Platform, fetchFn: typeof fetch, run: InstallDeps["run"]) {
  const tempRoot = await tmpDir("roblox-install-");
  const deps: InstallDeps = {
    platform,
    env: platform === "win32" ? { SystemRoot: "C:\\Windows" } : {},
    fetch: fetchFn,
    run,
    tempRoot,
  };
  return { deps, tempRoot };
}

/** Whether Roblox's installer was ever started. */
const installerRan = (calls: Call[]) =>
  calls.some((call) => call.file === MAC_OPEN || call.file.endsWith("RobloxStudioInstaller.exe"));

async function refusal(promise: Promise<unknown>): Promise<InstallError> {
  const error = await promise.then(
    () => assert.fail("the install went on"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof InstallError, String(error));
  assert.doesNotMatch(error.message, BANNED_WORDS);
  return error;
}

const MAC_URL = INSTALLER.darwin.url;
const WINDOWS_URL = INSTALLER.win32.url;

describe("Roblox's installer: where it comes from", () => {
  it("is Roblox's own per-system link on setup.rbxcdn.com, over HTTPS", () => {
    assert.equal(ALLOWED_HOST, "setup.rbxcdn.com");
    assert.equal(MAC_URL, "https://setup.rbxcdn.com/mac/RobloxStudio.dmg");
    assert.equal(WINDOWS_URL, "https://setup.rbxcdn.com/RobloxStudioInstaller.exe");
    assert.equal(MAX_INSTALLER_BYTES, 64 * 1024 * 1024);
  });
});

describe("a Windows signer is Roblox's only by a whole CN or O of Roblox's name", () => {
  const ROWS: Array<[string, boolean]> = [
    [ROBLOX_SUBJECT, true],
    ['CN="Roblox Corporation", O="Roblox Corporation", C=US', true],
    ["O=Roblox Corporation", true],
    ["CN=Evil, OU=Roblox Corporation, C=US", false],
    ["CN=Roblox Corporation Ltd, O=Elsewhere", false],
    ["CN=Not Roblox Corporation, O=Elsewhere", false],
    ['CN="Evil, O=Roblox Corporation", O=Elsewhere', false],
    ["CN=Evil\\, O=Roblox Corporation", false],
    ["CN=Evil\\2C O=Roblox Corporation", false],
    ["", false],
  ];
  for (const [subject, roblox] of ROWS)
    it(`${roblox ? "accepts" : "refuses"} ${JSON.stringify(subject)}`, () => {
      assert.equal(signedByRoblox(subject), roblox);
    });
});

describe("Get Roblox Studio refuses every hostile shape, running nothing and keeping no temporary folder", () => {
  const abortedMidway = () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(1024));
        // The person presses Stop once the first bytes are in; the rest never comes.
        queueMicrotask(() => controller.abort());
      },
    });
    return { controller, body };
  };

  type Row = {
    name: string;
    platform: NodeJS.Platform;
    routes?: (url: string) => Record<string, () => Response>;
    script?: Script;
    url?: string;
    code: InstallRefusal;
    abort?: boolean;
  };
  const rows: Row[] = [
    {
      name: "an http: link",
      platform: "darwin",
      url: "http://setup.rbxcdn.com/mac/RobloxStudio.dmg",
      code: InstallRefusal.NotHttps,
    },
    {
      name: "a redirect to another host",
      platform: "darwin",
      routes: (url) => ({ [url]: () => redirect("https://downloads.example.com/RobloxStudio.dmg") }),
      code: InstallRefusal.OtherHost,
    },
    {
      name: "a redirect to a lookalike host",
      platform: "darwin",
      routes: (url) => ({ [url]: () => redirect("https://setup.rbxcdn.com.evil.test/mac/RobloxStudio.dmg") }),
      code: InstallRefusal.OtherHost,
    },
    {
      name: "a redirect down to http",
      platform: "win32",
      routes: (url) => ({ [url]: () => redirect("http://setup.rbxcdn.com/RobloxStudioInstaller.exe") }),
      code: InstallRefusal.NotHttps,
    },
    {
      name: "a body that says it is over the cap",
      platform: "darwin",
      routes: (url) => ({
        [url]: () => ok(streamed(1, 16), { "content-length": String(MAX_INSTALLER_BYTES + 1) }),
      }),
      code: InstallRefusal.TooLarge,
    },
    {
      name: "a body with no length that then runs over the cap",
      platform: "win32",
      routes: (url) => ({ [url]: () => ok(streamed(65, 1024 * 1024)) }),
      code: InstallRefusal.TooLarge,
    },
    { name: "a DMG codesign refuses", platform: "darwin", script: { dmgSigned: false }, code: InstallRefusal.Unsigned },
    {
      name: "a DMG signed by another team",
      platform: "darwin",
      script: { dmgTeam: "ABCDE12345" },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "an installer app codesign refuses",
      platform: "darwin",
      script: { appSigned: false },
      code: InstallRefusal.Unsigned,
    },
    {
      name: "an installer app signed by another team",
      platform: "darwin",
      script: { appTeam: "2CFABCH84" },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "a DMG self-signed with Roblox's team in its certificate",
      platform: "darwin",
      script: { dmgSelfSigned: true },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "an installer app self-signed with Roblox's team in its certificate",
      platform: "darwin",
      script: { appSelfSigned: true },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "an installer app Gatekeeper rejects",
      platform: "darwin",
      script: { appAssessed: false },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "a DMG missing Roblox's installer app",
      platform: "darwin",
      script: { hasApp: false },
      code: InstallRefusal.NoInstaller,
    },
    {
      name: "an installer Authenticode calls NotSigned",
      platform: "win32",
      script: { authenticode: { status: "NotSigned", subject: "" } },
      code: InstallRefusal.Unsigned,
    },
    {
      name: "an installer signed validly by someone else",
      platform: "win32",
      script: { authenticode: { status: "Valid", subject: "CN=Not Roblox Corporation Ltd, O=Elsewhere, C=US" } },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "an installer whose subject hides Roblox's name behind an escaped comma",
      platform: "win32",
      script: { authenticode: { status: "Valid", subject: "CN=Evil\\, O=Roblox Corporation, C=US" } },
      code: InstallRefusal.WrongSigner,
    },
    {
      name: "an installer whose signature was tampered with",
      platform: "win32",
      script: { authenticode: { status: "HashMismatch", subject: ROBLOX_SUBJECT } },
      code: InstallRefusal.Unsigned,
    },
    { name: "a Stop pressed mid-download", platform: "darwin", abort: true, code: InstallRefusal.Cancelled },
  ];

  for (const row of rows)
    it(`refuses ${row.name}`, async () => {
      const url = row.url ?? INSTALLER[row.platform === "win32" ? "win32" : "darwin"].url;
      const stopped = row.abort ? abortedMidway() : undefined;
      const body = stopped?.body;
      const routes = body ? { [url]: () => ok(body) } : (row.routes?.(url) ?? { [url]: () => ok() });
      const { fetchFn } = fakeFetch(routes);
      const computer = fakeComputer(row.script);
      const { deps, tempRoot } = await installDeps(row.platform, fetchFn, computer.run);
      const error = await refusal(
        installStudio(deps, {
          signal: (stopped?.controller ?? new AbortController()).signal,
          ...(row.url ? { url: row.url } : {}),
        }),
      );
      assert.equal(error.code, row.code, error.message);
      assert.equal(installerRan(computer.calls), false, "Roblox's installer never ran");
      assert.deepEqual(await readdir(tempRoot), [], "the temporary folder is gone");
      const attached = computer.calls.some((call) => call.file === HDIUTIL && call.args[0] === "attach");
      const detached = computer.calls.some((call) => call.file === HDIUTIL && call.args[0] === "detach");
      assert.equal(detached, attached, "a DMG Genex attached is always detached");
    });

  it("an installer that exits with an error is a plain refusal, with the DMG detached and the folder gone", async () => {
    const { fetchFn } = fakeFetch({ [MAC_URL]: () => ok() });
    const computer = fakeComputer({ installerCode: 1 });
    const { deps, tempRoot } = await installDeps("darwin", fetchFn, computer.run);
    const error = await refusal(installStudio(deps, { signal: new AbortController().signal }));
    assert.equal(error.code, InstallRefusal.InstallerFailed);
    assert.ok(computer.calls.some((call) => call.file === HDIUTIL && call.args[0] === "detach"));
    assert.deepEqual(await readdir(tempRoot), []);
  });

  it("a download that runs out of its own time is a failed download, not the person's Stop", async () => {
    const { fetchFn } = fakeFetch({ [MAC_URL]: () => ok(streamed(4, 1024)) });
    const computer = fakeComputer();
    const { deps, tempRoot } = await installDeps("darwin", fetchFn, computer.run);
    deps.timeout = () => AbortSignal.abort(new DOMException("late", "TimeoutError"));
    const error = await refusal(installStudio(deps, { signal: new AbortController().signal }));
    assert.equal(error.code, InstallRefusal.DownloadFailed);
    assert.equal(installerRan(computer.calls), false);
    assert.deepEqual(await readdir(tempRoot), []);
  });

  it("refuses a system Roblox Studio doesn't run on before fetching anything", async () => {
    const { fetchFn, asked } = fakeFetch({});
    const computer = fakeComputer();
    const { deps } = await installDeps("linux", fetchFn, computer.run);
    const error = await refusal(installStudio(deps, { signal: new AbortController().signal }));
    assert.equal(error.code, InstallRefusal.Unsupported);
    assert.deepEqual(asked, []);
    assert.deepEqual(computer.calls, []);
  });
});

describe("Get Roblox Studio on a Mac and on Windows", () => {
  it("on a Mac: downloads, checks the DMG and the app as Roblox's, runs the installer and detaches, in that order", async () => {
    const { fetchFn, asked } = fakeFetch({
      [MAC_URL]: () => ok(INSTALLER_BYTES, { "content-length": String(INSTALLER_BYTES.length) }),
    });
    const computer = fakeComputer();
    const { deps, tempRoot } = await installDeps("darwin", fetchFn, computer.run);
    const phases: string[] = [];
    let downloaded: Buffer | undefined;
    const run = computer.run;
    deps.run = async (file, args, options) => {
      if (file === CODESIGN && !downloaded) downloaded = await readFile(args[args.length - 1] ?? "");
      return run(file, args, options);
    };
    await installStudio(deps, { signal: new AbortController().signal, onPhase: (phase) => phases.push(phase) });

    assert.deepEqual(asked, [MAC_URL]);
    assert.deepEqual(downloaded, INSTALLER_BYTES, "codesign checked the bytes Roblox sent");
    const steps = computer.calls.map((call) => `${path.basename(call.file)} ${call.args[0]}`);
    // Flipped: Gatekeeper's assessment of the installer app was added after its codesign checks.
    assert.deepEqual(steps, [
      "codesign --verify",
      "codesign -dv",
      "hdiutil attach",
      "codesign --verify",
      "codesign -dv",
      "spctl --assess",
      "open -W",
      "hdiutil detach",
    ]);
    for (const verify of computer.calls.filter((call) => call.file === CODESIGN && call.args[0] === "--verify"))
      assert.ok(
        verify.args.some((arg) => arg.startsWith("-R=anchor apple generic") && arg.includes(`"${ROBLOX_TEAM}"`)),
        "codesign checks Apple's chain to Roblox's team, not the signature's own requirement",
      );
    const attach = computer.calls[2];
    for (const flag of ["-nobrowse", "-readonly", "-mountpoint"]) assert.ok(attach?.args.includes(flag), flag);
    const open = computer.calls[6];
    assert.equal(open?.args.at(-1)?.endsWith(path.join("RobloxStudioInstaller.app")), true);
    assert.equal(open?.visible, true, "the person sees Roblox's installer");
    assert.deepEqual(phases, [InstallPhase.Downloading, InstallPhase.Checking, InstallPhase.Installing]);
    assert.deepEqual(await readdir(tempRoot), []);
  });

  it("on Windows: checks Authenticode with the path outside the command text, then runs the installer", async () => {
    const { fetchFn } = fakeFetch({
      [WINDOWS_URL]: () => redirect("https://setup.rbxcdn.com/RobloxStudioInstaller.exe?v=2"),
      "https://setup.rbxcdn.com/RobloxStudioInstaller.exe?v=2": () => ok(),
    });
    const computer = fakeComputer();
    const { deps, tempRoot } = await installDeps("win32", fetchFn, computer.run);
    await installStudio(deps, { signal: new AbortController().signal });

    assert.deepEqual(
      computer.calls.map((call) => call.file),
      [POWERSHELL, computer.calls[1]?.file],
    );
    const check = computer.calls[0];
    const installer = computer.calls[1]?.file ?? "";
    assert.ok(installer.endsWith("RobloxStudioInstaller.exe"), installer);
    assert.deepEqual(check?.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(check?.args.length, 4, "the command and nothing after it");
    assert.ok(!check?.args.some((arg) => arg.includes(installer)), "the path is never part of the command");
    assert.equal(check?.env?.GENEX_INSTALLER, installer, "PowerShell reads the path from its own variable");
    assert.match(check?.args[3] ?? "", /Get-AuthenticodeSignature -LiteralPath \$env:GENEX_INSTALLER/);
    assert.deepEqual(computer.calls[1]?.args, []);
    assert.equal(computer.calls[1]?.visible, true);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

/** A computer for after the installer: when Studio appears, runs, closes, and what was opened. */
interface Timeline {
  /** When the app appears; never when undefined. */
  installedAt?: number;
  /** The installer's Studio runs over [from, to); `to` undefined: it stays open. */
  firstStudio?: { from: number; to?: number };
  /** How long Studio opened by Genex runs before closing again (the sign-in quit once more). */
  reopenedRunsFor?: number;
}

function afterDeps(timeline: Timeline, setUpStep: (running: boolean) => Promise<string>) {
  let clock = 0;
  const opened: Launch[] = [];
  const setUps: boolean[] = [];
  let reopened: { from: number; to: number } | undefined;
  const installed = () => timeline.installedAt !== undefined && clock >= timeline.installedAt;
  const running = () => {
    const first = timeline.firstStudio;
    const inFirst = first !== undefined && clock >= first.from && (first.to === undefined || clock < first.to);
    const inReopened = reopened !== undefined && clock >= reopened.from && clock < reopened.to;
    return inFirst || inReopened;
  };
  const run: Run = async (file) => {
    if (file === "/usr/bin/plutil") return { code: 0, stdout: "0.743.0.7431133\n" };
    if (file === "/usr/bin/pgrep") return running() ? { code: 0, stdout: "4530\n" } : { code: 1, stdout: "" };
    throw new Error(`spawn ${file} ENOENT`);
  };
  const files = new Set([`${STUDIO_MAC_APP}/Contents/MacOS/RobloxStudio`, `${STUDIO_MAC_APP}/Contents/Info.plist`]);
  const deps: AfterInstallDeps = {
    platform: "darwin",
    env: {},
    home: "/Users/maker",
    run,
    fs: {
      async lstat(file): Promise<LocateStat | undefined> {
        if (file === "/Applications") return { file: false, directory: true, link: false, mtimeMs: 0 };
        if (!installed()) return undefined;
        if (file === STUDIO_MAC_APP) return { file: false, directory: true, link: false, mtimeMs: 0 };
        if (files.has(file)) return { file: true, directory: false, link: false, mtimeMs: 0 };
        return undefined;
      },
      realpath: async (file) => file,
      readdir: async () => [],
    },
    open: async (launch) => {
      opened.push(launch);
      reopened = { from: clock, to: clock + (timeline.reopenedRunsFor ?? Number.POSITIVE_INFINITY) };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    setUp: async () => {
      setUps.push(running());
      return setUpStep(running());
    },
  };
  return { deps, opened, setUps, clock: () => clock };
}

describe("after Roblox's installer: sign-in, Set up while Studio is closed, Studio opened again", () => {
  const signal = () => new AbortController().signal;

  it("waits for the installer's Studio to close after sign-in, sets up while it is closed, and opens Studio once", async () => {
    const after = afterDeps({ installedAt: 4_000, firstStudio: { from: 6_000, to: 90_000 } }, async () => "Set up.");
    const phases: string[] = [];
    const done = await afterInstall(after.deps, { signal: signal(), onPhase: (phase) => phases.push(phase) });
    assert.deepEqual(after.setUps, [false], "Set up ran once, while Studio was closed");
    assert.ok(after.clock() >= 90_000, "Set up waited for the installer's Studio to close by itself");
    assert.deepEqual(after.opened, [{ file: "/usr/bin/open", args: ["-a", STUDIO_MAC_APP] }]);
    assert.equal(done.reopened, true);
    assert.equal(done.version, "0.743.0.7431133");
    assert.match(done.message, /Set up\./);
    assert.doesNotMatch(done.message, BANNED_WORDS);
    assert.deepEqual(phases, [
      InstallPhase.WaitingForStudio,
      InstallPhase.SigningIn,
      InstallPhase.SettingUp,
      InstallPhase.Opening,
    ]);
  });

  it("opens Studio once and never again when that Studio closes too: no reopen loop", async () => {
    const after = afterDeps(
      { installedAt: 0, firstStudio: { from: 2_000, to: 30_000 }, reopenedRunsFor: 5_000 },
      async () => "Set up.",
    );
    await afterInstall(after.deps, { signal: signal() });
    // The clock runs on past the reopened Studio's own close; nothing opens it again.
    await after.deps.sleep(60_000);
    assert.equal(after.opened.length, 1);
  });

  it("with no account settings yet, still adds the helper and leaves the MCP switch step open", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const root = await tmpDir("roblox-after-install-");
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Documents", "Roblox"), { recursive: true });
    await mkdir(path.join(home, "Library", "Roblox"), { recursive: true });
    let done: SetupDone | undefined;
    const after = afterDeps({ installedAt: 0, firstStudio: { from: 0, to: 10_000 } }, async (running) => {
      done = await setUp({
        paths: setupPaths("darwin", { HOME: home }, home),
        helper: await shippedHelper(),
        storage: path.join(root, "storage"),
        running: async () => running,
        now: () => 0,
      });
      return "Helper added.";
    });
    await afterInstall(after.deps, { signal: signal() });
    assert.ok((await lstat(path.join(home, "Documents", "Roblox", "Plugins", HELPER_FILE))).isFile());
    assert.equal(done?.switches.files, 0, "no settings file was made or guessed");
    assert.equal(after.opened.length, 1);
  });

  it("when the app never appears, stops at the deadline with a plain message and opens nothing", async () => {
    const after = afterDeps({}, async () => "Set up.");
    const error = await refusal(afterInstall(after.deps, { signal: signal() }));
    assert.equal(error.code, InstallRefusal.NotInstalled);
    assert.ok(after.clock() >= INSTALL_WAIT_MS, "it waited the whole install wait, not longer");
    assert.ok(after.clock() < INSTALL_WAIT_MS + 10_000);
    assert.deepEqual(after.setUps, []);
    assert.deepEqual(after.opened, []);
  });

  it("when the installer's Studio stays open, never closes it: a plain note to sign in, nothing set up", async () => {
    const after = afterDeps({ installedAt: 0, firstStudio: { from: 1_000 } }, async () => "Set up.");
    const error = await refusal(afterInstall(after.deps, { signal: signal() }));
    assert.equal(error.code, InstallRefusal.StillOpen);
    assert.match(error.message, /sign in/i);
    assert.ok(after.clock() >= SIGN_IN_WAIT_MS);
    assert.deepEqual(after.setUps, []);
    assert.deepEqual(after.opened, []);
  });

  it("when Studio never opens by itself, sets up at once while it is closed and opens it once", async () => {
    const after = afterDeps({ installedAt: 0 }, async () => "Set up.");
    await afterInstall(after.deps, { signal: signal() });
    assert.deepEqual(after.setUps, [false]);
    assert.equal(after.opened.length, 1);
  });

  it("a Stop while waiting ends the wait with nothing set up or opened", async () => {
    const controller = new AbortController();
    const after = afterDeps({ installedAt: 0, firstStudio: { from: 0 } }, async () => "Set up.");
    const sleep = after.deps.sleep;
    after.deps.sleep = async (ms) => {
      await sleep(ms);
      if (after.clock() >= 20_000) controller.abort();
    };
    const error = await refusal(afterInstall(after.deps, { signal: controller.signal }));
    assert.equal(error.code, InstallRefusal.Cancelled);
    assert.deepEqual(after.setUps, []);
    assert.deepEqual(after.opened, []);
  });
});

describe("the installer's temporary folder", () => {
  it("holds the download only while it runs", async () => {
    const { fetchFn } = fakeFetch({ [MAC_URL]: () => ok() });
    const computer = fakeComputer();
    const { deps, tempRoot } = await installDeps("darwin", fetchFn, computer.run);
    const seen: string[][] = [];
    const run = computer.run;
    deps.run = async (file, args, options) => {
      if (file === MAC_OPEN) seen.push(await readdir(tempRoot));
      return run(file, args, options);
    };
    await installStudio(deps, { signal: new AbortController().signal });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.length, 1, "one private folder while the installer runs");
    assert.deepEqual(await readdir(tempRoot), []);
    await writeFile(path.join(tempRoot, "kept.txt"), "the root itself is the caller's");
    assert.deepEqual(await readdir(tempRoot), ["kept.txt"]);
  });
});
