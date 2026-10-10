import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
/** Empty scaffold, live node preview and health UI through the real app; no paid model calls. */
import { spawn } from "node:child_process";
import path from "node:path";
import { startFakeOllama } from "../helpers/fake-ollama.ts";
/** The run controls the build smoke must always exercise: the composer Stop and the keep-awake hold. */
const REQUIRED_CHECKS = [
  "running build shows only Stop in an empty composer",
  "Escape closes the menu and leaves the run running",
  "Wrap up asks the run to finish instead of stopping it",
  "Stop in the composer immediately interrupts its own chat",
  "a running build holds the Mac awake",
  "the Mac is still held awake while the stopped build settles",
  "the blocker is released when the run settles",
];
// Two local models: one that sees, and a coding model that cannot, for the local roles checks.
const server = await startFakeOllama({
  respond: () => ({ text: "Smoke fixture" }),
  models: [
    {
      name: "qwen3.6:27b",
      size: 17_000_000_000,
      capabilities: ["completion", "tools", "vision"],
      contextLength: 262144,
    },
    { name: "coder:7b", size: 4_000_000_000, capabilities: ["completion", "tools"], contextLength: 32768 },
  ],
});
try {
  const args = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--studio-build-shot=") || arg.startsWith("--studio-assets-smoke-dir="));
  const packaged = process.argv.includes("--packaged");
  const executable = packaged
    ? path.resolve(process.env.STUDIO_PACKAGE_DIR ?? "out/Genex-darwin-arm64", "Genex.app/Contents/MacOS/genex")
    : resolveElectron();
  const child = spawn(
    executable,
    fixtureElectronArgs([
      ...(packaged ? [] : ["."]),
      "--studio-smoke",
      "--studio-build-smoke",
      `--ollama-host=${server.host}`,
      ...args,
    ]),
    { env: fixtureElectronEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (args.some((arg) => arg.startsWith("--studio-assets-smoke-dir="))) process.stderr.write(chunk);
  });
  console.log("Checking empty projects and automatic build previews in an isolated app…");
  // Includes model setup, role switching and reload recovery as well as build/asset flows.
  const timer = setTimeout(() => child.kill("SIGKILL"), 420_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
  const match = /__SMOKE_JSON__([\s\S]*?)__END__/.exec(stdout);
  if (!match) throw new Error(`No smoke report (exit ${code}). ${stderr.slice(-6000)}`);
  const report = JSON.parse(match[1]);
  if (report.failed) {
    // The failed predicate and fixture DOM explain a timeout; the final check name alone does not.
    const diagnostics = stderr.match(/\[build-smoke timeout\][^\n]*\n[^\n]*/g) ?? [];
    for (const diagnostic of diagnostics) console.error(diagnostic);
  }
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  console.log(`${report.checks.length - report.failed}/${report.checks.length} checks passed`);
  // A smoke that stopped running a check would pass without it: these must be in every report.
  const missing = REQUIRED_CHECKS.filter((name) => !report.checks.some((check) => check.name.includes(name)));
  for (const name of missing) console.log(`✖ required check missing from the report: ${name}`);
  process.exitCode = report.failed === 0 && code === 0 && missing.length === 0 ? 0 : 1;
} finally {
  await server.close();
}
