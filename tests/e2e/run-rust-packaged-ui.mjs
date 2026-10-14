/**
 * Launch the actual Linux .deb payload, without installing it, in an owned fixture profile and run
 * the Rust · wgpu payload acceptance in it (`--studio-rust-acceptance`, src/main/smoke/rust-acceptance.ts):
 * the template and lock line the package ships, a cold Rust store, Rust · wgpu the default stack and
 * Rust creation released in a release build (M6.4), raylib creation refused. Requires the current package (a .deb under out/make/deb, or
 * STUDIO_RUST_DEB). No providers or downloads. Run under xvfb-run -a on CI. Building a Rust game is
 * the lane's acceptance; creating one from the shipped template is scripts/ci/rust-linux-host.ts's
 * `fixture-creation` row, run against the same extracted payload.
 */
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile } from "@electron/asar";
import { fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { packagedApp } from "./packaged-app.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidence = path.join(root, ".studio-dev/evidence/rust-packaged-ui");
const run = promisify(execFile);
const deadlineMs = 120_000;
const report = {
  checks: [],
  failed: 1,
  rustCreation: "unverified",
  gameBuild: "unverified; the Rust toolchain lanes' acceptance",
};
let ownedRoot = null;
let child = null;
let timer = null;
let stdout = "";
let stderr = "";
const stopOwnedLaunch = () => {
  if (!child?.pid) return;
  // This Linux-only runner starts its own process group, including the harness child.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const sha256 = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const findDebs = async (dir) => {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findDebs(file)));
    else if (entry.isFile() && entry.name.endsWith(".deb")) found.push(file);
  }
  return found;
};
try {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Rust .deb acceptance requires Linux x64");
  const candidates = process.env.STUDIO_RUST_DEB
    ? [path.resolve(process.env.STUDIO_RUST_DEB)]
    : await findDebs(path.join(root, "out/make/deb"));
  if (candidates.length !== 1)
    throw new Error(`Name one current .deb with STUDIO_RUST_DEB; found ${candidates.length}`);
  const deb = candidates[0];
  const { stdout: fields } = await run("dpkg-deb", ["--field", deb, "Package", "Architecture", "Version"]);
  const metadata = Object.fromEntries(
    fields
      .trim()
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  );
  if (!/^[a-z0-9][a-z0-9+.-]*$/.test(metadata.Package ?? "") || metadata.Architecture !== "amd64")
    throw new Error("The selected .deb does not name a Linux amd64 package");
  ownedRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "genex-rust-package-")));
  await fs.writeFile(
    path.join(ownedRoot, "ownership.json"),
    JSON.stringify({ runner: import.meta.url, pid: process.pid, createdAt: new Date().toISOString() }),
  );
  const extracted = path.join(ownedRoot, "deb");
  await run("dpkg-deb", ["--extract", deb, extracted]);
  const app = packagedApp(root, { env: { STUDIO_PACKAGE_DIR: path.join(extracted, "usr/lib", metadata.Package) } });
  const archive = path.join(app.resourcesDir, "app.asar");
  const appVersion = JSON.parse(extractFile(archive, "package.json").toString("utf8")).version;
  const profile = path.join(ownedRoot, "profile");
  const home = path.join(ownedRoot, "home");
  for (const dir of [profile, home]) await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  report.package = {
    name: metadata.Package,
    version: metadata.Version,
    appVersion,
    architecture: metadata.Architecture,
    deb: { name: path.basename(deb), sha256: await sha256(deb) },
    archiveSha256: await sha256(archive),
    executableSha256: await sha256(app.bin),
    payload: "extracted .deb; no system installation",
  };
  report.host = { platform: process.platform, arch: process.arch, node: process.versions.node };
  report.isolation = {
    profile: "owned temporary empty root",
    home: "owned empty home",
    providers: "offline fixture engines",
    nativePolicy: "existing smoke refusals",
    sharedStores: false,
  };
  const env = fixtureElectronEnv();
  // A CI job can carry dev-store, eval or provider endpoints; this lane must not borrow any.
  for (const key of Object.keys(env)) {
    if (/^(GENEX_|STUDIO_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|OLLAMA_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    STUDIO_DISABLE_OS_CREDENTIALS: "1",
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: "0",
    STUDIO_LIVE_CLAUDE_CLI: "0",
    STUDIO_LIVE_OLLAMA: "0",
  });
  child = spawn(app.bin, fixtureElectronArgs(["--studio-smoke", "--studio-rust-acceptance", `--userdata=${profile}`]), {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    stopOwnedLaunch();
  }, deadlineMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  timer = null;
  report.exit = { ...exit, timedOut, deadlineMs };
  const match = /__RUST_PACKAGE_JSON__([\s\S]*?)__END__/.exec(stdout);
  if (!match)
    throw new Error(`The .deb app produced no Rust acceptance report (exit ${exit.code}, signal ${exit.signal})`);
  Object.assign(report, JSON.parse(match[1]));
  report.checks.push({
    name: "the actual .deb app exits successfully before the deadline",
    ok: exit.code === 0 && !timedOut,
  });
  report.checks.push({
    name: "the app reports the .deb version and packaged identity",
    ok: report.packaged === true && report.version === appVersion,
  });
  report.checks.push({
    name: "the shipped Rust payload passes its acceptance and a release build makes Rust games, never raylib ones",
    ok:
      report.rustCreation === "released" &&
      report.raylibCreation === "retired" &&
      report.stackDefault === "rust-wgpu" &&
      typeof report.genexVersion === "string",
    detail: `rustCreation=${report.rustCreation} raylibCreation=${report.raylibCreation} default=${report.stackDefault} genex=${report.genexVersion}`,
  });
  report.failed = report.checks.filter((check) => !check.ok).length;
  if (report.failed) process.exitCode = 1;
} catch (error) {
  report.checks.push({ name: "Linux .deb Rust acceptance runner completed", ok: false, detail: String(error) });
  report.failed = report.checks.filter((check) => !check.ok).length;
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    stopOwnedLaunch();
    await new Promise((resolve) => child.once("close", resolve));
  }
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(evidence, "app.log"), `${stdout}\n${stderr}`);
  if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true });
}
for (const check of report.checks)
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
console.log(`${report.checks.length - report.failed}/${report.checks.length} Rust .deb UI checks passed`);
