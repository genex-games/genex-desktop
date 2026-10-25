import { fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { readdir, readFile } from "node:fs/promises";
/**
 * Boot the *packaged* app and check it comes up clean.
 *
 * This is a different question from the dev-mode e2e: in a package the harness bootstrap and the
 * vendored three.js live inside an asar archive, and neither a spawn nor a `file://` fetch works
 * from there. If the unpack/path translation ever regresses, the app still opens — it just never
 * gets a harness — so this asserts readiness explicitly. It also reads the packaged binary's fuses,
 * the sandbox helpers the package carries, on macOS a signature that holds (an ad-hoc local build's
 * too: macOS's folder privacy refuses an app whose signature does not bind its Info.plist without
 * asking) and, with STUDIO_EXPECT_SIGNED=1, the Developer ID signature and Gatekeeper's verdict. On
 * macOS and Windows it also checks the bundled cua-driver: the pinned version, its license, and that
 * it starts embedded from inside the package (on a Mac signed with the app's own identity when
 * STUDIO_EXPECT_SIGNED=1; on Windows carrying cua's own valid signature). On Windows every
 * executable and DLL in the package must find the Visual C++ runtime DLLs it imports beside it.
 *
 *   npm run package && node tests/e2e/run-packaged-smoke.mjs
 *   STUDIO_PACKAGE_DIR=<out/Genex-<platform>-<arch>> overrides the package folder.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listPackage, extractFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { startFakeOllama } from "../helpers/fake-ollama.ts";
import { packagedApp, posixEntries } from "./packaged-app.mjs";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { CUA_DRIVER_RELEASE } from "../../scripts/vendor-cua-driver.ts";
import { GIT_SOURCE_RELEASE, MAC_GIT_FILES } from "../../scripts/vendor-git-for-mac.ts";
import { macOwnGitBin } from "../../src/substrate/git-policy.ts";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import vcRuntime from "../../scripts/package-vc-runtime.cjs";
import { connectCuaDriver, driverEnv, GrantHolder } from "../../src/substrate/cua-driver-client.ts";
import {
  bundledCuaDriver,
  daemonEndpoint,
  embeddedCuaDriver,
  embeddedEnv,
  HOST_BUNDLE_ID,
} from "../../src/substrate/cua-embedded.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const { appBundle, bin, packageDir, resourcesDir } = packagedApp(root);
const expectSigned = process.platform === "darwin" && process.env.STUDIO_EXPECT_SIGNED === "1";
/** The fuses forge.config.cjs flips, as the packaged binary must carry them. */
const EXPECTED_FUSES = {
  RunAsNode: FuseState.ENABLE,
  EnableCookieEncryption: FuseState.ENABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
  GrantFileProtocolExtraPrivileges: FuseState.ENABLE,
};
/** sandbox-runtime helpers by the platform that runs them (scripts/package-prune.cjs). */
const SANDBOX_HELPERS = { seccomp: "linux", "srt-win": "win32" };

const server = await startFakeOllama({
  models: [{ name: "qwen3.6:27b", size: 17_000_000_000, capabilities: ["completion", "tools"] }],
});

console.log(`launching the packaged app…\n  ${bin}`);
const screenshots = process.argv.slice(2).filter((arg) => /^--studio-(?:login-)?shot=/.test(arg));
const child = spawn(bin, fixtureElectronArgs(["--studio-smoke", `--ollama-host=${server.host}`, ...screenshots]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    console.error("packaged smoke timed out — killing");
    child.kill("SIGKILL");
  }, 150_000);
  child.on("exit", (exitCode) => {
    clearTimeout(timer);
    resolve(exitCode ?? 1);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    console.error(`could not launch the packaged app: ${err.message}`);
    console.error("run `npm run package` first");
    resolve(1);
  });
});
await server.close();

const match = /__SMOKE_JSON__([\s\S]*?)__END__/.exec(stdout);
// An app that never reported still gets its package checked below; the run fails either way.
const report = match
  ? JSON.parse(match[1])
  : { checks: [{ name: "packaged app boots and reports", ok: false, detail: "no report was produced" }], failed: 1 };
if (!match && stderr.trim()) console.error(stderr.slice(-3000));
const archive = path.join(resourcesDir, "app.asar");
// asar looks a file up by splitting on the OS separator, so a `/` path misses on Windows.
const bundleReport = JSON.parse(
  extractFile(archive, path.join("dist", "renderer", "bundle-report.json")).toString("utf8"),
);
const productionReact =
  bundleReport.release &&
  bundleReport.react === "production" &&
  !bundleReport.inputs.some((file) => /react.*\/cjs\/.*\.development\.js$/.test(file));
report.checks.push({ name: "packaged renderer contains production React", ok: productionReact });
if (!productionReact) report.failed++;
// Separators are `/` on every OS below: asar and readdir list with backslashes on Windows.
const entries = posixEntries(listPackage(archive));
const projectLicense = extractFile(archive, path.join("dist", "resources", "LICENSE")).toString("utf8");
const sourceNotices = extractFile(
  archive,
  path.join("dist", "resources", "third-party", "PROJECT-SOURCES.md"),
).toString("utf8");
const noticeIndex = extractFile(archive, path.join("dist", "resources", "third-party", "NOTICE.md")).toString("utf8");
addCheck(
  "package preserves the project license and manually attributed copied sources",
  projectLicense === (await readFile(path.join(root, "LICENSE"), "utf8")) &&
    sourceNotices === (await readFile(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8")) &&
    noticeIndex.includes("PROJECT-SOURCES.md"),
);
const pluginCli = entries.some((entry) =>
  entry.includes("/dist/resources/plugins/genex/node_modules/@genex-ai/cli-demo/dist/index.js"),
);
const duplicateCli = entries.some((entry) => entry.startsWith("/node_modules/@genex-ai/cli-demo/"));
report.checks.push({ name: "Genex CLI ships only inside its optional plugin payload", ok: pluginCli && !duplicateCli });
if (!pluginCli || duplicateCli) report.failed++;
const privateEntries = entries.filter((entry) => /^\/\.(studio-dev|claude|codex|agents)(\/|$)/.test(entry));
report.checks.push({
  name: "packaged archive excludes development profiles, capabilities and task artifacts",
  ok: privateEntries.length === 0,
  detail: `${privateEntries.length} private development entries`,
});
if (privateEntries.length) report.failed++;
const cacheEntries = entries.filter((entry) => /^\/node_modules\/\.cache(\/|$)/.test(entry));
addCheck(
  "packaged archive excludes the build's download cache (vendored Git, archives)",
  cacheEntries.length === 0,
  `${cacheEntries.length} cache entries`,
);
const forbidden = /(?:^|\/)node_modules\/(?:@openai\/codex(?:-[^/]+)?|@anthropic-ai\/claude-agent-sdk-[^/]+)(?:\/|$)/;
const unpacked = posixEntries(await readdir(`${archive}.unpacked`, { recursive: true }));
const codingBinaries = [...entries, ...unpacked].filter((entry) => forbidden.test(entry));
report.checks.push({
  name: "archive and unpacked resources contain no coding CLI packages",
  ok: codingBinaries.length === 0,
  detail: codingBinaries.join(", ") || "Codex and Claude native packages absent; JS SDK retained",
});
if (codingBinaries.length) report.failed++;
// forge.config.cjs afterPrune: no other platform's terminal binaries, no Genex CLI-only dependency tree.
const deadWeight = [...entries, ...unpacked].filter(
  (entry) =>
    new RegExp(
      `(?:^|/)node_modules/node-pty/(?:prebuilds/(?!${target}(?:/|$))[^/]+|src|deps|third_party)(?:/|$)|\\.pdb$`,
    ).test(entry) || /^\/?node_modules\/@(?:sentry|opentelemetry)(?:\/|$)/.test(entry),
);
report.checks.push({
  name: "package omits other platforms' terminal binaries and the Genex CLI's own dependency tree",
  ok: deadWeight.length === 0,
  detail: deadWeight.slice(0, 5).join(", "),
});
if (deadWeight.length) report.failed++;
// forge.config.cjs afterPrune: only this platform's and architecture's sandbox-runtime helper.
const foreignHelpers = unpacked.filter((entry) => {
  const match = /node_modules\/@anthropic-ai\/sandbox-runtime\/vendor\/([^/]+)(?:\/([^/]+))?/.exec(entry);
  if (!match) return false;
  const [, helper, arch] = match;
  return SANDBOX_HELPERS[helper] !== process.platform || (arch !== undefined && arch !== process.arch);
});
addCheck(
  "package carries only this platform's sandbox-runtime helper",
  foreignHelpers.length === 0,
  foreignHelpers.slice(0, 5).join(", "),
);
const fuses = await getCurrentFuseWire(bin);
const wrongFuses = Object.entries(EXPECTED_FUSES).filter(([name, state]) => fuses[FuseV1Options[name]] !== state);
addCheck(
  "packaged binary carries the release fuses (run-as-node on, NODE_OPTIONS and --inspect off, asar only)",
  wrongFuses.length === 0,
  wrongFuses.map(([name]) => `${name}=${String.fromCharCode(fuses[FuseV1Options[name]] ?? 63)}`).join(", "),
);
if (process.platform === "darwin") await signatureChecks();
if (process.platform === "darwin") await bundledGitChecks();
if (process.platform === "darwin" || process.platform === "win32") await cuaDriverChecks();
if (process.platform === "win32") await vcRuntimeCheck();
// Keep the fallback in smoke mode if the gate regresses: this negative probe must
// never initialize normal product data merely to prove a packaged flag is refused.
const denied = spawn(bin, fixtureElectronArgs(["--studio-smoke", "--studio-dev-launch=/not-an-owned-launch.json"]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
let denial = "";
denied.stdout.on("data", (chunk) => {
  denial = (denial + chunk).slice(-8000);
});
denied.stderr.on("data", (chunk) => {
  denial = (denial + chunk).slice(-8000);
});
const deniedCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    denied.kill("SIGKILL");
  }, 15_000);
  denied.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  denied.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
});
const refused =
  deniedCode === 1 && denial.includes("Developer launch requires a developer build and owned launch configuration");
report.checks.push({
  name: "packaged developer launch flags are refused before profile initialization",
  ok: refused,
  detail: `exit=${deniedCode}`,
});
if (!refused) report.failed++;
for (const check of report.checks) {
  console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
}
console.log(`\n${report.checks.length - report.failed}/${report.checks.length} packaged-app checks passed`);
process.exit(report.failed === 0 && code === 0 ? 0 : 1);

/** Records one package check on the report. */
function addCheck(name, ok, detail) {
  report.checks.push({ name, ok, ...(detail ? { detail } : {}) });
  if (!ok) report.failed++;
}

/**
 * Windows: every executable, DLL and addon in the package has the Visual C++ runtime DLLs it
 * imports beside it, for its architecture (scripts/package-vc-runtime.cjs). Windows does not
 * include them, so without a copy a program such as srt-win.exe exits 0xC0000135 before it runs;
 * a runner whose Visual Studio installed them in System32 would never show it.
 */
async function vcRuntimeCheck() {
  const gaps = await vcRuntime.missingVcRuntime(packageDir);
  const describe = ({ file, missing, error }) => `${path.relative(packageDir, file)}: ${error ?? missing.join(", ")}`;
  addCheck(
    "every executable and DLL in the package has the Visual C++ runtime it imports beside it",
    gaps.length === 0,
    gaps.slice(0, 5).map(describe).join("; "),
  );
}

/** Whether something accepts connections on a socket or named pipe now. */
function listening(socket) {
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Windows' verdict on a file's Authenticode signature (`Valid` when it holds), by PowerShell. */
async function authenticodeStatus(file) {
  const literal = `'${file.replaceAll("'", "''")}'`;
  const command = `(Get-AuthenticodeSignature -LiteralPath ${literal}).Status`;
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]).catch((error) => ({ stdout: String(error) }));
  return stdout.trim();
}

/** How many cua-driver.exe processes run on this PC. */
async function driverProcessCount() {
  const { stdout } = await promisify(execFile)("tasklist", [
    "/FI",
    "IMAGENAME eq cua-driver.exe",
    "/FO",
    "CSV",
    "/NH",
  ]).catch(() => ({ stdout: "" }));
  return stdout.split("\n").filter((line) => line.toLowerCase().includes("cua-driver.exe")).length;
}

/**
 * On Windows, the bundled driver as the app runs it: its own embedded daemon on a named pipe and
 * the app's client (with its window probe) answer a real call, and stopping leaves no driver behind.
 */
async function windowsDriverCall(driver) {
  const embedded = embeddedCuaDriver({ command: driver, args: [] }, { hostBundleId: HOST_BUNDLE_ID, env: driverEnv() });
  let answered = "";
  try {
    const desktop = await connectCuaDriver(() => embedded.command(), { local: true, holder: GrantHolder.Host });
    try {
      const shot = await desktop.screenshot();
      const focus = await desktop.focus();
      answered = `screenshot ${shot.width}x${shot.height}; in front: ${focus.app?.bundleId ?? "no app"}`;
    } finally {
      await desktop.close();
    }
  } catch (error) {
    answered = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await embedded.stop();
  addCheck(
    "the bundled cua-driver answers a real call over its named pipe",
    answered.startsWith("screenshot"),
    answered,
  );
  await sleep(1000);
  const left = await driverProcessCount();
  addCheck("no cua-driver.exe runs once it stops", left === 0, `${left} running`);
}

/**
 * The cua-driver every macOS and Windows build carries for computer control
 * (scripts/vendor-cua-driver.ts): the pinned version beside its license, and a daemon that starts
 * embedded, as the app starts it, from inside the package (on a socket, or a named pipe on Windows).
 * A Developer ID build signs it with the app's own team; on Windows it carries cua's own signature.
 */
async function cuaDriverChecks() {
  const resources = path.join(resourcesDir, "app.asar.unpacked", "dist", "resources");
  const driver = bundledCuaDriver(resources);
  const dir = path.dirname(driver);
  const version = await readFile(path.join(dir, "VERSION"), "utf8").catch(() => "");
  addCheck(
    "package carries the pinned cua-driver with its license and notices",
    version.trim() === CUA_DRIVER_RELEASE.version &&
      existsSync(path.join(dir, "LICENSE.md")) &&
      existsSync(path.join(dir, "THIRD_PARTY_NOTICES.md")),
    `VERSION ${version.trim() || "missing"}`,
  );
  const endpoint = await daemonEndpoint();
  const daemon = spawn(driver, ["serve", "--embedded", "--socket", endpoint.socket], {
    env: { ...driverEnv(), ...embeddedEnv(HOST_BUNDLE_ID) },
    stdio: "ignore",
    windowsHide: true,
  });
  daemon.on("error", () => {});
  let up = false;
  for (let tries = 0; tries < 100 && !up; tries += 1) {
    up = await listening(endpoint.socket);
    if (!up) await sleep(100);
  }
  daemon.kill("SIGKILL");
  if (endpoint.dir) await rm(endpoint.dir, { recursive: true, force: true });
  addCheck("the bundled cua-driver starts embedded from inside the package", up, driver);
  if (process.platform === "win32") {
    const status = await authenticodeStatus(driver);
    addCheck("the bundled cua-driver carries cua's valid signature", status === "Valid", status);
    await windowsDriverCall(driver);
    return;
  }
  if (!expectSigned) return;
  const run = promisify(execFile);
  const teamOf = async (file) =>
    /^TeamIdentifier=(.+)$/m.exec((await run("codesign", ["-dv", file]).catch((error) => error)).stderr ?? "")?.[1] ??
    "";
  const [driverTeam, appTeam] = [await teamOf(driver), await teamOf(appBundle)];
  addCheck(
    "the bundled cua-driver is signed with the app's own team",
    driverTeam === appTeam,
    `${driverTeam} vs ${appTeam}`,
  );
}

/**
 * The git every macOS build carries for a Mac without Apple's developer tools
 * (scripts/vendor-git-for-mac.ts): the pinned version, run from inside the package as on such a
 * Mac (`DEVELOPER_DIR=/nonexistent` breaks /usr/bin's stand-ins, and no other git is on PATH),
 * with a valid signature on each of its programs; a Developer ID build signs them with the app's team.
 */
async function bundledGitChecks() {
  const run = promisify(execFile);
  const bin = macOwnGitBin(path.join(resourcesDir, "app.asar.unpacked", "dist", "resources"));
  const gitRoot = path.dirname(bin);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    DEVELOPER_DIR: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: os.tmpdir(),
  };
  const said = await run(path.join(bin, "git"), ["--version"], { env }).then(
    ({ stdout }) => stdout.trim(),
    (error) => String(error.stderr ?? error.message).trim(),
  );
  addCheck(
    "package carries the pinned git, which runs from inside it",
    said === `git version ${GIT_SOURCE_RELEASE.version}`,
    said,
  );
  const repo = await mkdtemp(path.join(os.tmpdir(), "packaged-git-"));
  const steps = [
    ["init", "-q", repo],
    ["-C", repo, "commit", "-q", "--allow-empty", "-m", "packaged", "--author", "t <t@t>"],
    ["clone", "-q", repo, `${repo}-clone`],
  ];
  let failed = "";
  for (const args of steps) {
    failed ||= await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { env }).then(
      () => "",
      (error) => `git ${args[0]}: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
  await rm(repo, { recursive: true, force: true });
  await rm(`${repo}-clone`, { recursive: true, force: true });
  addCheck("the bundled git makes a repository, commits and clones it with no developer tools", !failed, failed);
  const programs = MAC_GIT_FILES.programs.map((entry) => path.join(gitRoot, entry));
  const unsigned = [];
  for (const program of programs)
    await run("codesign", ["--verify", "--strict", program]).catch(() =>
      unsigned.push(path.relative(gitRoot, program)),
    );
  addCheck("codesign --verify accepts each of the bundled git's programs", unsigned.length === 0, unsigned.join(", "));
  if (!expectSigned) return;
  const teamOf = async (file) =>
    /^TeamIdentifier=(.+)$/m.exec((await run("codesign", ["-dv", file]).catch((error) => error)).stderr ?? "")?.[1] ??
    "";
  const appTeam = await teamOf(appBundle);
  const others = [];
  for (const program of programs) if ((await teamOf(program)) !== appTeam) others.push(path.relative(gitRoot, program));
  addCheck("the bundled git's programs are signed with the app's own team", others.length === 0, others.join(", "));
}

/**
 * Every macOS build: a strict deep signature named for the app's bundle id. A Developer ID build
 * also: Gatekeeper's acceptance, and no library-validation exemption.
 */
async function signatureChecks() {
  const run = promisify(execFile);
  const outcome = async (file, args) => {
    try {
      const { stdout, stderr } = await run(file, args);
      return { ok: true, text: `${stdout}${stderr}` };
    } catch (error) {
      return { ok: false, text: `${error.stdout ?? ""}${error.stderr ?? error.message}` };
    }
  };
  const verify = await outcome("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
  addCheck("codesign --verify --deep --strict accepts the app", verify.ok, verify.text.trim().split("\n").at(-1));
  const described = await outcome("codesign", ["-dv", appBundle]);
  const signedAs = /^Identifier=(.+)$/m.exec(described.text)?.[1] ?? "";
  const infoPlist = path.join(appBundle, "Contents", "Info.plist");
  const bundleId = (
    await outcome("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist])
  ).text.trim();
  addCheck(
    "the app's signature names its own bundle id and binds its Info.plist",
    signedAs === bundleId && !/Info\.plist=not bound/.test(described.text),
    `signed as ${signedAs || "?"}, bundle id ${bundleId || "?"}`,
  );
  if (!expectSigned) return;
  const gatekeeper = await outcome("spctl", ["-a", "-vv", "-t", "exec", appBundle]);
  const developerId = gatekeeper.ok && /source=Notarized Developer ID/.test(gatekeeper.text);
  addCheck("Gatekeeper accepts the app as a notarized Developer ID build", developerId, gatekeeper.text.trim());
  const entitlements = await outcome("codesign", ["-d", "--entitlements", "-", "--xml", appBundle]);
  // The microphone is Play's voice chat (build/entitlements.mac.plist); nothing else is a device exemption.
  const exempt = /disable-library-validation|device\.(?!audio-input<)/.test(entitlements.text);
  const microphone = /device\.audio-input</.test(entitlements.text);
  addCheck(
    "signed entitlements carry the microphone for Play's voice chat and no other library-validation or device exemption",
    entitlements.ok && microphone && !exempt,
  );
}
