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
 * asking) and, with STUDIO_EXPECT_SIGNED=1, the Developer ID signature and Gatekeeper's verdict.
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
import { verifyPackagedPluginResources } from "./packaged-plugin-resources.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const { appBundle, bin, resourcesDir } = packagedApp(root);
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
const forbidden = /(?:^|\/)node_modules\/(?:@openai\/codex(?:-[^/]+)?|@anthropic-ai\/claude-agent-sdk-[^/]+)(?:\/|$)/;
const unpacked = posixEntries(await readdir(`${archive}.unpacked`, { recursive: true }));
for (const check of await verifyPackagedPluginResources({
  root,
  resources: path.join(`${archive}.unpacked`, "dist", "resources"),
}))
  addCheck(check.name, check.ok, check.detail);
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
  const exempt = /disable-library-validation|device\.(?:camera|audio-input)/.test(entitlements.text);
  addCheck("signed entitlements carry no library-validation or device exemptions", entitlements.ok && !exempt);
}
