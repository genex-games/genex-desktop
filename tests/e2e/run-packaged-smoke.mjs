import { fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
 * On a host the Rust store pins (macOS arm64, Linux x64) it also launches the Rust payload acceptance
 * (`--studio-rust-acceptance`, src/main/smoke/rust-acceptance.ts) and adds its checks, and requires
 * what M6 ships there: Rust · wgpu as the default stack, Rust creation released in a fixture
 * profile, and no C++ · raylib creation offered or made.
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
import { verifyAngleBundle } from "../../src/substrate/toolchain-store/bundled.ts";
import {
  bundledLinuxSysrootFolder,
  LINUX_SYSROOT_BUNDLE_PIN,
  verifyLinuxSysrootFolder,
} from "../../src/substrate/toolchain-store/linux-sysroot-bundle.ts";
import { RUST_PAYLOAD, rustPayloadChecks } from "../../scripts/rust-payload.ts";

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
/**
 * A C++ toolchain's programs, by file name: the toolchain store installs them on the user's machine,
 * so the package never carries one (Electron's own ANGLE, the TS7 compiler and node-pty are not named).
 */
const TOOLCHAIN_PROGRAM =
  /^(?:cmake|ctest|cpack|ninja|emcc|em\+\+|emar|wasm-ld|wasm-opt|zig|clang(?:\+\+|-\d+)?|python3?(?:\.\d+)?|node)(?:\.exe)?$/i;
/** ANGLE's two libraries: in the payload only as the pinned copies under `dist/resources/angle/`. */
const ANGLE_LIBRARY = /^lib(?:EGL|GLESv2)\.(?:dylib|dll|so)$/;
const ANGLE_HOME = "/dist/resources/angle/";
/** What a C++ game is built and run from, in the package. */
const CPP_TEMPLATE = "/dist/resources/game-template-cpp/CMakeLists.txt";
const HEADLESS_PLATFORM = ["dist", "resources", "native", "raylib-platform", "rcore_genex_headless.c"];
const FRAMES_ADDON = ["dist", "resources", "native", "genex-frames.node"];
const MAIN_BUNDLE = ["dist", "main", "main.mjs"];
/** Hosts the Rust store pins a sysroot for (`rust-recipe.json`): where the Rust acceptance launches. */
const RUST_ACCEPTANCE_HOSTS = new Set(["darwin-arm64", "linux-x64"]);
/** How long the Rust acceptance launch may take before it is killed. */
const RUST_ACCEPTANCE_TIMEOUT_MS = 120_000;
/** Where the Rust acceptance's report and log land (package.yml uploads `.studio-dev/evidence`). */
const RUST_EVIDENCE = path.join(root, ".studio-dev", "evidence", "rust-packaged");

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
await nativeChecks();
await rustAcceptance();
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
 * C++ games: the package carries no toolchain program and no ANGLE outside its pinned folder, and
 * does carry the C++ template, the raylib recipe (inlined into the main bundle), the headless
 * raylib platform byte for byte, and the frames addon when this build made one.
 */
async function nativeChecks() {
  const payload = [...entries, ...unpacked.map((entry) => `/${entry}`)];
  // Listings name folders too (`@types/node`): only a leaf, a file, can be a program.
  const folders = new Set(payload.map((entry) => path.posix.dirname(entry)));
  const strays = payload.filter((entry) => {
    const name = path.posix.basename(entry);
    const named = TOOLCHAIN_PROGRAM.test(name) || (ANGLE_LIBRARY.test(name) && !entry.includes(ANGLE_HOME));
    return named && !folders.has(entry);
  });
  addCheck(
    "package carries no C++ toolchain program and no ANGLE outside its pinned folder",
    strays.length === 0,
    strays.slice(0, 5).join(", "),
  );
  addCheck("package carries the C++ · raylib game template", entries.includes(CPP_TEMPLATE));
  const recipe = JSON.parse(
    await readFile(path.join(root, "src", "substrate", "toolchain-store", "recipe.json"), "utf8"),
  );
  const main = extractFile(archive, path.join(...MAIN_BUNDLE)).toString("utf8");
  const unshipped = [...Object.keys(recipe), ...Object.keys(recipe.raylibConfig)].filter((key) => !main.includes(key));
  addCheck("main bundle carries the raylib recipe", unshipped.length === 0, unshipped.slice(0, 5).join(", "));
  const platform = await readFile(path.join(root, "native", "raylib-platform", "rcore_genex_headless.c"));
  const shipped = entries.includes(`/${HEADLESS_PLATFORM.join("/")}`)
    ? extractFile(archive, path.join(...HEADLESS_PLATFORM))
    : null;
  addCheck("package carries the headless raylib platform byte for byte", Boolean(shipped?.equals(platform)));
  if (!entries.includes(`/${FRAMES_ADDON.join("/")}`))
    console.log("genex-frames.node is absent: this build made none, so Live shows no embedded Mac game");
  // Every Genex build ships the pinned ANGLE for macOS, Windows and Linux, each file its pinned
  // bytes (a Mac library the signing walk re-signed is restored through signatures.json first).
  const angleChecks = await verifyAngleBundle(path.join(`${archive}.unpacked`, "dist", "resources"));
  addCheck(
    "package bundles the pinned ANGLE for macOS, Windows and Linux with matching digests",
    angleChecks.length === 3 && angleChecks.every((check) => check.ok),
    angleChecks
      .map((check) => (check.ok ? `${check.target} ${check.files} files` : `${check.target}: ${check.fault}`))
      .join(", "),
  );
  await rustChecks(payload, main);
  try {
    const folder = bundledLinuxSysrootFolder(path.join(`${archive}.unpacked`, "dist", "resources"));
    await verifyLinuxSysrootFolder(folder);
    addCheck(
      "package bundles the pinned Linux build headers with matching digests",
      true,
      `${LINUX_SYSROOT_BUNDLE_PIN.files} files`,
    );
  } catch (error) {
    addCheck("package bundles the pinned Linux build headers with matching digests", false, String(error));
  }
}

/**
 * Rust · wgpu games: the package carries the Rust template and the lock line byte for byte, the
 * pinned crate policy, no Rust compiler or cargo program, and the Rust pins inlined into the main
 * bundle (scripts/rust-payload.ts).
 */
async function rustChecks(payload, main) {
  const shippedPath = path.join("dist", "resources", ...RUST_PAYLOAD.lock.resource.split("/"));
  const shippedLock = entries.includes(`/${shippedPath.split(path.sep).join("/")}`)
    ? extractFile(archive, shippedPath)
    : null;
  const recipe = JSON.parse(
    await readFile(path.join(root, "src", "substrate", "toolchain-store", "rust-recipe.json"), "utf8"),
  );
  const policyPath = path.join("dist", "resources", ...RUST_PAYLOAD.policy.resource.split("/"));
  const shippedPolicy = entries.includes(`/${policyPath.split(path.sep).join("/")}`)
    ? extractFile(archive, policyPath)
    : null;
  const checks = rustPayloadChecks({
    entries: payload,
    shippedLock,
    shippedPolicy,
    sourceLock: await readFile(path.join(root, ...RUST_PAYLOAD.lock.source.split("/"))),
    mainBundle: main,
    recipe,
  });
  for (const check of checks) addCheck(check.name, check.ok, check.detail);
}

/**
 * The packaged app's own Rust acceptance, in a throwaway smoke profile with fixture engines: the
 * shipped template and lock line read back, a cold Rust store, the host-conditional default, a Rust
 * game made through the real creation IPC and raylib refused. Its checks join this report prefixed
 * `rust:`, with the M6 release's own requirements on what it reports.
 */
async function rustAcceptance() {
  if (!RUST_ACCEPTANCE_HOSTS.has(target)) {
    console.log(`Rust acceptance skipped: the Rust store pins no sysroot for ${target}`);
    return;
  }
  const lane = spawn(bin, fixtureElectronArgs(["--studio-smoke", "--studio-rust-acceptance"]), {
    env: fixtureElectronEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  lane.stdout.setEncoding("utf8");
  lane.stdout.on("data", (chunk) => {
    out += chunk;
  });
  lane.stderr.setEncoding("utf8");
  lane.stderr.on("data", (chunk) => {
    err = (err + chunk).slice(-8000);
  });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => lane.kill("SIGKILL"), RUST_ACCEPTANCE_TIMEOUT_MS);
    lane.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    lane.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const reported = /__RUST_PACKAGE_JSON__([\s\S]*?)__END__/.exec(out);
  await mkdir(RUST_EVIDENCE, { recursive: true });
  await writeFile(path.join(RUST_EVIDENCE, "app.log"), `${out}\n${err}`);
  if (reported) await writeFile(path.join(RUST_EVIDENCE, "report.json"), `${reported[1]}\n`);
  if (!reported) {
    addCheck("rust: the packaged Rust acceptance reports", false, `exit=${exitCode} ${err.slice(-500)}`);
    return;
  }
  const rust = JSON.parse(reported[1]);
  for (const check of rust.checks) addCheck(`rust: ${check.name}`, check.ok, check.detail);
  addCheck("rust: the packaged Rust acceptance exits 0", exitCode === 0, `exit=${exitCode}`);
  addCheck("rust: Rust · wgpu is this host's default stack", rust.stackDefault === "rust-wgpu", rust.stackDefault);
  addCheck(
    "rust: the release makes Rust games and never a C++ · raylib one",
    rust.rustCreation === "released" && rust.raylibCreation === "retired",
    `rustCreation=${rust.rustCreation} raylibCreation=${rust.raylibCreation}`,
  );
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
  const addon = path.join(`${archive}.unpacked`, ...FRAMES_ADDON);
  if (!unpacked.includes(FRAMES_ADDON.join("/"))) return;
  const signer = await outcome("codesign", ["-dv", addon]);
  const team = /TeamIdentifier=([A-Z0-9]{10})/.exec(signer.text)?.[1];
  addCheck(
    "the frames addon is signed by the app's team",
    signer.ok && Boolean(team),
    signer.text.trim().split("\n").at(-1),
  );
}
