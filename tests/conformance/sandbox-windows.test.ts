/**
 * Sandbox conformance on Windows: the **real** srt-win backend with Git Bash, no mocks.
 *
 * The same boundary `sandbox.test.ts` asserts on macOS, from both sides, as hostile-input
 * tables: writes outside the grants and reads anywhere else in the profile fail and leave nothing
 * behind; a domain nobody allowed is refused while an allowed one answers; the host reaches a
 * server inside the sandbox; the studio's environment stays out; a kill ends the whole tree; and
 * an Electron-as-Node boot from `%LOCALAPPDATA%` (where the installed app lives) runs Git.
 *
 * Windows only, on a machine whose sandbox is provisioned (the Windows CI job does that and sets
 * GENEX_WINDOWS_SANDBOX=ready). `windows-sandbox.test.ts` covers the same rules everywhere with fakes.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { HarnessInbox } from "../../src/substrate/harness-inbox.ts";
import { SandboxLaunchCode, SandboxLaunchError } from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox, killChild } from "../../src/substrate/spawn.ts";
import { granteeOf, sandboxGroupOf, srtWinPath } from "../../src/substrate/windows-sandbox.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  return false;
}
const SKIP = skipReason();

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BOOTSTRAP = path.join(REPO, "src", "harness-boot", "bootstrap.mjs");
const FIXTURE_OK = path.join(REPO, "tests", "fixtures", "harness-ok");
const FAKE_PLAY_GAME = path.join(REPO, "tests", "fixtures", "fake-play-game.mjs");
const ELECTRON_DIST = path.join(REPO, "node_modules", "electron", "dist");
const RUN_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
const HEARTBEAT_WAIT_MS = 30_000;
const KILL_SETTLE_MS = 4_000;
const SECRET = "profile-secret-content";
const OPEN = "readable-beside-the-secret";
/** BUILTIN\Guests, a SID nothing here runs as: its entry only marks what a walk rewrites. */
const GUESTS = "S-1-5-32-546";

/** A value for Git Bash: forward slashes, single-quoted. */
const q = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
const curl = (url: string, flags = "") => `curl -sS -m 15 ${flags} -o /dev/null -w '%{http_code}' ${q(url)}`;

let sandbox: ProcessSandbox;
let workspace: string;
let scratch: string;
let secrets: string;
let profileDir: string;
let electronInstall: string;
/** A folder in the profile outside every grant that the sandbox user may read, and the denied folder in it. */
let deniedHome: string;
let deniedKeys: string;
/** A denied folder directly in the profile, and a folder beside it that kept what it inherited elsewhere. */
let profileSecret: string;
let movedProbe: string;
/** The sandbox users' group, which Genex's own denies name; null where srt-win stamps every deny. */
let sandboxGroup: string | null = null;

/** A path's own DACL as SDDL, read through icacls, which saves it without changing anything. */
function sddl(target: string): string {
  const file = path.join(os.tmpdir(), `genex-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync("icacls", [target, "/save", file], { stdio: "ignore" });
  const text = readFileSync(file, "utf16le");
  rmSync(file, { force: true });
  return text;
}

before(async () => {
  if (SKIP) return;
  // Long names, as the app's own folders have: `os.tmpdir()` can be spelled with an 8.3 name.
  const root = realpathSync.native(await tmpDir("genex-sandbox-win-"));
  workspace = path.join(root, "workspace");
  scratch = path.join(root, "scratch");
  secrets = path.join(workspace, ".secrets");
  // Ungranted places in the real user's profile, the shape of ~/Documents and %LOCALAPPDATA%.
  profileDir = path.join(os.homedir(), `genex-sandbox-probe-${process.pid}`);
  electronInstall = path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    `genex-sandbox-probe-${process.pid}`,
    "app-0.0.0",
  );
  await mkdir(secrets, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(secrets, "token.txt"), SECRET);
  await writeFile(path.join(profileDir, "private.txt"), SECRET);
  if (existsSync(ELECTRON_DIST)) await cp(ELECTRON_DIST, electronInstall, { recursive: true });
  // Readable to the sandbox user the way another srt host's grant would make it: only the deny on
  // `keys` keeps the token in it closed.
  const srt = await import("@anthropic-ai/sandbox-runtime");
  const status = await srt.getWindowsSandboxUserStatusAsync({ srtWin: srt.resolveSrtWin({ path: srtWinPath() }) });
  sandboxGroup = sandboxGroupOf(status);
  deniedHome = path.join(root, "denied-home");
  deniedKeys = path.join(deniedHome, "keys");
  await mkdir(deniedKeys, { recursive: true });
  await writeFile(path.join(deniedHome, "open.txt"), OPEN);
  await writeFile(path.join(deniedKeys, "token.txt"), SECRET);
  execFileSync("icacls", [deniedHome, "/grant", `*${granteeOf(status)}:(OI)(CI)(RX)`], { stdio: "ignore" });
  // srt-win's stamp of a deny walked everything under its parent, here the whole profile; a folder
  // moved in keeps what it inherited where it was made until such a walk works it out again.
  profileSecret = path.join(os.homedir(), `genex-deny-direct-${process.pid}`);
  movedProbe = path.join(os.homedir(), `genex-moved-probe-${process.pid}`);
  await mkdir(profileSecret, { recursive: true });
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(elsewhere);
  execFileSync("icacls", [elsewhere, "/grant", `*${GUESTS}:(OI)(CI)(RA)`], { stdio: "ignore" });
  await mkdir(path.join(elsewhere, "moved"));
  await rename(path.join(elsewhere, "moved"), movedProbe);
  sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: scratch,
    secretPaths: [secrets, deniedKeys, profileSecret],
    readableRoots: [electronInstall],
  });
});

after(async () => {
  if (SKIP) return;
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
  await rm(profileDir, { recursive: true, force: true });
  await removeTree(profileSecret);
  await removeTree(movedProbe);
  await rm(path.dirname(electronInstall), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

const inside = (command: string, extra: Partial<Parameters<ProcessSandbox["run"]>[0]> = {}) =>
  sandbox.run({ command, cwd: workspace, timeoutMs: RUN_TIMEOUT_MS, ...extra });

describe("Windows sandbox: identity and files", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("runs Git Bash commands as the sandbox user", async () => {
    const result = await inside("echo hello-sandbox; whoami");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.sandboxed, true);
    assert.match(result.stdout, /hello-sandbox/);
    assert.match(result.stdout, /srt-sandbox/i);
  });

  it("writes inside the workspace and uses its own scratch folder as TMPDIR", async () => {
    const result = await inside('printf built > artifact.txt && printf tmp > "$TMPDIR/probe.txt" && cat artifact.txt');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(workspace, "artifact.txt"), "utf8"), "built");
    assert.equal(await readFile(path.join(sandbox.scratchDir, "probe.txt"), "utf8"), "tmp");
  });

  it("refuses every write outside the grants and leaves no file", async () => {
    const targets = [
      path.join(profileDir, "escaped.txt"),
      path.join(os.homedir(), `genex-escaped-${process.pid}.txt`),
      `C:\\genex-escaped-${process.pid}.txt`,
      `C:\\Users\\Public\\genex-escaped-${process.pid}.txt`,
      path.join(workspace, "..", `escaped-${process.pid}.txt`),
      path.join(os.tmpdir(), `genex-escaped-${process.pid}.txt`),
    ];
    for (const target of targets) {
      const result = await inside(`printf escaped > ${q(target)}`);
      assert.notEqual(result.code, 0, `${target} must not be writable`);
      assert.equal(existsSync(target), false, `${target} must not exist`);
    }
  });

  it("refuses reads of the profile and of the secret paths inside a writable root", async () => {
    const files = [path.join(profileDir, "private.txt"), path.join(secrets, "token.txt")];
    for (const file of files) {
      const result = await inside(`cat ${q(file)}`);
      assert.notEqual(result.code, 0, `${file} must not be readable: ${result.stdout} ${result.stderr}`);
      assert.ok(!result.stdout.includes(SECRET), `${file} leaked`);
    }
    const folders = [
      os.homedir(),
      profileDir,
      secrets,
      path.join(process.env.APPDATA ?? os.homedir(), "Microsoft"),
      process.env.LOCALAPPDATA ?? os.homedir(),
    ];
    for (const folder of folders) {
      const listing = await inside(`ls -A ${q(folder)}`);
      assert.equal(listing.stdout.trim(), "", `${folder} must not be listable: ${listing.stderr}`);
    }
  });

  it("refuses a denied folder in the profile even where the folder above it lets the sandbox user read", async () => {
    const open = await inside(`cat ${q(path.join(deniedHome, "open.txt"))}`);
    assert.equal(open.stdout, OPEN, `the folder above is readable, so the deny is what holds: ${open.stderr}`);
    const token = await inside(`cat ${q(path.join(deniedKeys, "token.txt"))}`);
    assert.notEqual(token.code, 0, `the token must not be readable: ${token.stdout}`);
    assert.ok(!token.stdout.includes(SECRET), "the token leaked");
    const listing = await inside(`ls -A ${q(deniedKeys)}`);
    assert.equal(listing.stdout.trim(), "", `the denied folder must not be listable: ${listing.stderr}`);
  });

  it("denies a folder directly in the profile without rewriting anything else in the profile", async (t) => {
    if (!sandboxGroup) return t.skip("no sandbox users' group here: srt-win stamps every deny");
    assert.match(sddl(profileSecret), new RegExp(`\\(D;OICI;FA;;;${sandboxGroup}\\)`), "denied, passed down");
    // SDDL spells FILE_DELETE_CHILD (0x40) DT, the directory-service "delete tree" right of the same bit.
    assert.match(
      sddl(os.homedir()),
      new RegExp(`\\(D;;(?:0x40|DT);;;${sandboxGroup}\\)`),
      "guarded by the profile alone",
    );
    assert.match(
      sddl(movedProbe),
      /\(A;[A-Z]*ID[A-Z]*;(?:0x80|LO);;;BG\)/,
      "nothing else in the profile was rewritten",
    );
  });

  it("refuses a per-run write outside the session's grants before starting anything", async () => {
    await assert.rejects(
      inside("true", { policy: { allowWrite: [profileDir] } }),
      (error: unknown) => error instanceof SandboxLaunchError && error.code === SandboxLaunchCode.NotGranted,
    );
  });

  it("a per-run write deny on a folder binds that run only (the type gate's shape)", async () => {
    const gated = path.join(workspace, "gated");
    await mkdir(gated, { recursive: true });
    await writeFile(path.join(gated, "kept.txt"), "original");
    const policy = { denyWrite: [gated] };
    const attempts: Array<[string, string, string]> = [
      ["a new file", "printf new > gated/new.txt", path.join(gated, "new.txt")],
      ["a nested folder", "mkdir gated/sub", path.join(gated, "sub")],
    ];
    for (const [label, command, target] of attempts) {
      const denied = await inside(command, { policy });
      assert.notEqual(denied.code, 0, `${label} must not be writable`);
      assert.equal(existsSync(target), false, `${label} must not exist`);
    }
    const overwrite = await inside("printf changed > gated/kept.txt", { policy });
    assert.notEqual(overwrite.code, 0, "an existing file must not be writable");
    const removal = await inside("rm -f gated/kept.txt", { policy });
    assert.notEqual(removal.code, 0, "an existing file must not be removable");
    assert.equal(await readFile(path.join(gated, "kept.txt"), "utf8"), "original");
    const sibling = await inside("printf beside > beside-gated.txt", { policy });
    assert.equal(sibling.code, 0, `the rest of the workspace stays writable: ${sibling.stderr}`);
    const later = await inside("printf later > gated/later.txt");
    assert.equal(later.code, 0, `the deny ends with its run: ${later.stderr}`);
    assert.equal(await readFile(path.join(gated, "later.txt"), "utf8"), "later");
  });

  it("a folder opened later becomes writable after one regrant", async () => {
    const later = path.join(realpathSync.native(await tmpDir("genex-sandbox-later-")), "game");
    await mkdir(later, { recursive: true });
    sandbox.allowWrite(later);
    const result = await sandbox.run({ command: "printf later > late.txt", cwd: later, timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(later, "late.txt"), "utf8"), "later");
  });
});

describe("Windows sandbox: stdio", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("pipes a run's stdin to the command", async () => {
    const result = await inside("cat", { stdin: "from-the-host\n" });
    assert.equal(result.stdout, "from-the-host\n", result.stderr);
  });

  it("hands a long-lived process its input, as OpenCode's brief must reach `opencode run`", async () => {
    const { child } = await sandbox.spawnLongLived({ command: "cat", cwd: workspace, stdin: "the brief\n" });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
    assert.equal(output, "the brief\n");
  });

  it("drives a Play Protocol game it started, its requests reaching the game through the input relay", async () => {
    const launched = await launchGameBridge({
      sandbox,
      command: `${q(process.execPath)} ${q(FAKE_PLAY_GAME)}`,
      cwd: workspace,
      stopGraceMs: 2_000,
    });
    try {
      assert.equal(launched.target.hello?.protocol, 3);
    } finally {
      await launched.stop();
    }
  });

  it("boots the harness bootstrap and hears it over the loopback inbox (stdin does not reach it)", async () => {
    const harness = path.join(workspace, "inbox-harness");
    await cp(FIXTURE_OK, harness, { recursive: true });
    const inbox = await HarnessInbox.open();
    const { child } = await sandbox.spawnLongLived({
      command: `${q(process.execPath)} ${q(BOOTSTRAP)}`,
      cwd: harness,
      env: { HARNESS_WS: harness, NODE_OPTIONS: "", ...inbox.env() },
    });
    try {
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      inbox.write(`${JSON.stringify({ kind: "shutdown", graceMs: 1_000 })}\n`);
      assert.equal(await inbox.connect(() => child.exitCode === null), true, "the host reached the inbox");
      const code = await new Promise((resolve) => child.once("exit", resolve));
      assert.match(output, /"kind":"ready"/);
      assert.equal(code, 0, "the harness shut down when asked over the inbox");
    } finally {
      inbox.close();
      killChild(child);
    }
  });
});

describe("Windows sandbox: environment", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("hands over the caller's variables and nothing of the studio's", async () => {
    process.env.GENEX_SANDBOX_PROBE_TOKEN = "studio-token-leak";
    try {
      const result = await inside('env; printf "own=%s" "$OWN_VALUE"', { env: { OWN_VALUE: "it's $(not run)" } });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!result.stdout.includes("studio-token-leak"), "a studio variable reached the sandbox");
      assert.match(result.stdout, /own=it's \$\(not run\)/);
      assert.ok(!result.stdout.includes(`USERPROFILE=${os.homedir()}`), "the child has its own profile");
    } finally {
      delete process.env.GENEX_SANDBOX_PROBE_TOKEN;
    }
  });

  it("runs Node and Git from a workspace under AppData (the realpath and git walks)", async () => {
    await writeFile(path.join(workspace, "mod.cjs"), 'module.exports = "mod-ok";');
    const node = await inside(`node -e 'console.log(require("./mod.cjs"))'`);
    assert.equal(node.stdout.trim(), "mod-ok", node.stderr);
    const git = await inside(
      "git init -q repo && cd repo && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.invalid commit -q -m first && git log --oneline",
    );
    assert.equal(git.code, 0, git.stderr);
    assert.match(git.stdout, /first/);
  });

  it("still opens a workspace under AppData after another srt host stamps and restores beside it", async (t) => {
    // Claude Code 2.1 runs sandbox-runtime's own Windows sandbox as the same srt-sandbox user, so
    // its grants, deny stamps and their cleanup land on the folders above Genex's grants.
    const srt = await import("@anthropic-ai/sandbox-runtime");
    const srtWin = srt.resolveSrtWin({ path: srtWinPath() });
    const status = await srt.getWindowsSandboxUserStatusAsync({ srtWin });
    t.diagnostic(`sandbox user ${status.sid}, group ${status.groupSid}, in group ${status.inSandboxGroup}`);
    const appData = path.join(os.homedir(), "AppData");
    const local = process.env.LOCALAPPDATA ?? path.join(appData, "Local");
    const tag = `genex-other-host-${process.pid}`;
    const theirs = [path.join(appData, tag), path.join(local, tag), path.join(os.homedir(), tag)];
    for (const dir of theirs) await mkdir(dir, { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    assert.ok(status.sid, "the sandbox user has a SID");
    const acl = { sandboxUserSid: status.sid, holderPid: holder.pid, srtWin };
    try {
      srt.grantWindowsAcl({ ...acl, read: [theirs[2]], write: [theirs[1]] });
      srt.stampWindowsAcl({ ...acl, denyRead: [theirs[0]], denyWrite: [] });
      srt.restoreWindowsAcl(acl);
      srt.revokeWindowsAcl(acl);
    } finally {
      holder.kill();
      for (const dir of theirs) await removeTree(dir);
    }
    t.diagnostic(execFileSync("icacls", [appData], { encoding: "utf8" }));
    await writeFile(path.join(workspace, "after-other.cjs"), 'module.exports = "after-other-ok";');
    const node = await inside(`node -e 'console.log(require("./after-other.cjs"))'`);
    assert.equal(node.stdout.trim(), "after-other-ok", node.stderr);
  });

  it("opens each folder above the workspace by handle, as Node's stat does before Windows 11 24H2", async () => {
    // Without GetFileInformationByName (Windows 10, Windows 11 before 24H2), libuv's stat opens
    // the path with FILE_READ_ATTRIBUTES, and CreateFileW adds SYNCHRONIZE to every synchronous
    // open: a folder that grants only read attributes refuses it, and the harness's realpath of
    // its own entry fails with EPERM on AppData. A newer Windows asks by name and never opens it.
    const above: string[] = [];
    for (let dir = path.dirname(workspace); dir !== os.homedir() && dir !== path.dirname(dir); dir = path.dirname(dir))
      above.unshift(dir);
    const probe = await inside(powershellCommand(openFoldersScript(above)));
    assert.equal(probe.code, 0, probe.stderr);
    const refused = probe.stdout.split(/\r?\n/).filter((line) => line.startsWith("refused"));
    assert.deepEqual(refused, [], probe.stdout);
    assert.equal(probe.stdout.match(/^opened /gm)?.length, above.length, probe.stdout);
  });

  it("boots an Electron-as-Node entry installed under %LOCALAPPDATA%, which spawns Git", {
    skip: existsSync(ELECTRON_DIST) ? false : "no Electron binary in node_modules",
  }, async () => {
    const entry = path.join(electronInstall, "boot.mjs");
    await writeFile(
      entry,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], execFileSync("git", ["--version"], { encoding: "utf8" }));',
      ].join("\n"),
    );
    const out = path.join(workspace, "boot.txt");
    const exe = path.join(electronInstall, "electron.exe");
    const result = await inside(`export ELECTRON_RUN_AS_NODE=1; ${q(exe)} ${q(entry)} ${q(out)}`, {
      env: { NODE_OPTIONS: "" },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await readFile(out, "utf8"), /git version/);
  });
});

/** Windows PowerShell running `script`, from Git Bash inside the sandbox. */
function powershellCommand(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `${q("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded} < /dev/null`;
}

/**
 * Open each folder as libuv's stat does without GetFileInformationByName: CreateFileW for read
 * attributes with backup semantics, synchronous. Prints `opened <dir>` or `refused <error> <dir>`.
 */
function openFoldersScript(dirs: readonly string[]): string {
  const list = dirs.map((dir) => `'${dir.replaceAll("'", "''")}'`).join(", ");
  return `
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'GenexOpen'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('GenexOpen').DefineType('GenexOpen', 'Public, Class')
$import = [Runtime.InteropServices.DllImportAttribute]
$fields = [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('CharSet'))
$values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
foreach ($native in @(
    @('CreateFileW', [IntPtr], [Type[]]@([string], [int], [int], [IntPtr], [int], [int], [IntPtr])),
    @('CloseHandle', [bool], [Type[]]@([IntPtr])))) {
  $method = $type.DefineMethod($native[0], 'Public, Static, PinvokeImpl', $native[1], $native[2])
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($import.GetConstructor([Type[]]@([string])), [object[]]@('kernel32.dll'), [Reflection.PropertyInfo[]]@(), [object[]]@(), $fields, $values)
  $method.SetCustomAttribute($attribute)
}
$api = $type.CreateType()
foreach ($dir in @(${list})) {
  $handle = $api::CreateFileW($dir, 0x80, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($handle -eq [IntPtr](-1)) { "refused $code $dir" } else { [void]$api::CloseHandle($handle); "opened $dir" }
}
`;
}

/** A dual-stack HTTP server on the host's loopback. */
async function hostServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => response.end("host-ok"));
  await new Promise<void>((resolve) => server.listen(0, "::", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function hostGet(url: string): Promise<string | undefined> {
  return await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.text(),
    () => undefined,
  );
}

describe("Windows sandbox: network", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("refuses a domain nobody allowed, at the proxy and around it", async () => {
    const table: Array<[string, string]> = [
      ["through the proxy", curl("http://genex-sandbox-probe.invalid/")],
      ["around the proxy", curl("https://example.com/", "--noproxy '*'")],
    ];
    for (const [label, command] of table) {
      const result = await inside(command);
      assert.notEqual(result.stdout.trim(), "200", `${label}: ${result.stdout} ${result.stderr}`);
    }
    assert.equal((await inside(curl("http://genex-sandbox-probe.invalid/"))).stdout.trim(), "403");
  });

  it("opens a per-run domain for that run only", async () => {
    const probe = curl("http://genex-overlay-probe.invalid/");
    const opened = await inside(probe, { policy: { allowedDomains: ["genex-overlay-probe.invalid"] } });
    assert.equal(opened.stdout.trim(), "502", `the proxy let it through to DNS: ${opened.stderr}`);
    assert.equal((await inside(probe)).stdout.trim(), "403", "closed again after the run");
  });

  it("reaches an allowed registry over HTTPS with curl and with Node's fetch", async () => {
    const policy = { allowedDomains: ["registry.npmjs.org"] };
    const viaCurl = await inside(curl("https://registry.npmjs.org/left-pad"), { policy });
    assert.equal(viaCurl.stdout.trim(), "200", viaCurl.stderr);
    const viaNode = await inside(
      `node -e 'fetch("https://registry.npmjs.org/left-pad").then(r=>console.log(r.status),e=>console.log(e.cause?.code??e.message))'`,
      { policy },
    );
    assert.equal(viaNode.stdout.trim(), "200", viaNode.stderr);
  });

  it("reaches a host server through the proxy only when localhost is allowed", async () => {
    const server = await hostServer();
    try {
      const url = `http://localhost:${server.port}/`;
      assert.equal((await inside(curl(url), { policy: { allowedDomains: ["localhost"] } })).stdout.trim(), "200");
      assert.notEqual((await inside(curl(url))).stdout.trim(), "200", "not without the allowance");
      const direct = await inside(curl(`http://127.0.0.1:${server.port}/`, "--noproxy '*'"));
      assert.notEqual(direct.stdout.trim(), "200", "never around the proxy");
    } finally {
      await server.close();
    }
  });

  it("lets the host preview a server running inside the sandbox", async () => {
    const port = await freePort();
    const script = `require("http").createServer((q,s)=>s.end("inside-ok")).listen(${port},"127.0.0.1")`;
    const { child } = await sandbox.spawnLongLived({ command: `node -e ${q(script)}`, cwd: workspace });
    try {
      const deadline = Date.now() + HEARTBEAT_WAIT_MS;
      let body: string | undefined;
      while (!body && Date.now() < deadline) {
        body = await hostGet(`http://127.0.0.1:${port}/`);
        if (!body) await sleep(500);
      }
      assert.equal(body, "inside-ok");
    } finally {
      killChild(child);
    }
  });
});

/** Lines a heartbeat file has, 0 when it does not exist yet. */
async function beats(file: string): Promise<number> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
}

/** Wait until `file` has at least `count` beats, or the wait runs out. */
async function beatsReach(file: string, count: number): Promise<number> {
  const deadline = Date.now() + HEARTBEAT_WAIT_MS;
  while ((await beats(file)) < count && Date.now() < deadline) await sleep(250);
  return beats(file);
}

describe("Windows sandbox: kill", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  /** A Node process in the workspace that appends a line to `name` five times a second. */
  const heartbeat = (name: string) => `node -e 'setInterval(()=>require("fs").appendFileSync("${name}", "b\\n"),200)'`;

  it("a timeout ends the whole tree", async () => {
    const file = path.join(workspace, "timeout.hb");
    const run = inside(`${heartbeat("timeout.hb")} & wait`, { timeoutMs: 6_000 });
    assert.ok((await beatsReach(file, 3)) >= 3, "the heartbeat started");
    const result = await run;
    assert.equal(result.timedOut, true);
    const atKill = await beats(file);
    await sleep(KILL_SETTLE_MS);
    assert.equal(await beats(file), atKill, "nothing keeps beating after the kill");
  });

  it("killing a long-lived process ends its children", async () => {
    const file = path.join(workspace, "long.hb");
    const { child } = await sandbox.spawnLongLived({ command: `${heartbeat("long.hb")} & wait`, cwd: workspace });
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
      assert.ok((await beatsReach(file, 3)) >= 3, "the heartbeat started");
    } finally {
      killChild(child);
    }
    await exited;
    const atKill = await beats(file);
    await sleep(KILL_SETTLE_MS);
    assert.equal(await beats(file), atKill, "the grandchild went with it");
  });
});
