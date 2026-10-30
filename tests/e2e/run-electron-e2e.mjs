import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
/**
 * End-to-end runner: starts a scripted model server, launches the real Electron app in self-test
 * mode, and reports what the studio actually did.
 *
 * Everything except the model is real — real substrate, real sandbox, real harness process, real
 * Chromium preview, real screenshots. The model is scripted so the assertions are about the
 * studio's behaviour rather than a model's mood.
 *
 *   node tests/e2e/run-electron-e2e.mjs [--show] [--keep]
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_WORKER_COMMAND, CLAUDE_WORKER_PROOF, startFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { startFakeOllama } from "../helpers/fake-ollama.ts";
import { packagedApp } from "./packaged-app.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const show = process.argv.includes("--show");
const keep = process.argv.includes("--keep");
/**
 * `--userdata=<dir>`: run the self test on that data folder and keep it, as the release canary's
 * upgrade mode does on the profile an earlier release left; by default a folder of its own.
 */
const givenUserData = process.argv.find((arg) => arg.startsWith("--userdata="))?.slice("--userdata=".length);
// `--claude-worker`: the self test also runs one Claude Code worker on the real CLI, its model the
// scripted Anthropic stand-in below (the release canary asks for it; it needs a machine that has
// or may install the CLI).
const claudeWorker = process.argv.includes("--claude-worker");

/** A small but real game: its own loop, its own rendering, nothing of the studio's on its page. */
const GAME_SOURCE = `import * as THREE from "three";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.style.margin = "0";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080b14);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
scene.add(new THREE.DirectionalLight(0xffffff, 2.4).translateY(6), new THREE.HemisphereLight(0x88aaff, 0x101018, 0.8));

const rings = new THREE.Group();
scene.add(rings);
for (let i = 0; i < 14; i++) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.12, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xffd166, flatShading: true }),
  );
  ring.position.set(Math.sin(i * 1.7) * 3, Math.cos(i * 2.3) * 1.5, -6 - i * 7);
  rings.add(ring);
}
const ship = new THREE.Mesh(
  new THREE.ConeGeometry(0.4, 1.2, 8),
  new THREE.MeshStandardMaterial({ color: 0x6ee7ff, flatShading: true }),
);
ship.rotation.x = Math.PI / 2;
scene.add(ship);

function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  ship.position.z -= dt * 12;
  camera.position.set(0, 2.5, ship.position.z + 7);
  camera.lookAt(0, 0, ship.position.z - 6);
  for (const ring of rings.children) ring.rotation.z += dt;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
`;

const replies = [
  {
    toolCalls: [{ id: "call_new", name: "new_game", arguments: { name: "selftest", title: "Self Test", kind: "web" } }],
    text: "Creating the project.",
  },
  {
    toolCalls: [
      {
        id: "call_write",
        name: "write_file",
        arguments: { project: "selftest", file: "src/main.js", contents: GAME_SOURCE },
      },
    ],
    text: "Writing the game.",
  },
  { toolCalls: [{ id: "call_reload", name: "reload_preview", arguments: {} }] },
  { toolCalls: [{ id: "call_console", name: "console_log", arguments: {} }] },
  { text: "Done — a ring-flying prototype is running in the preview." },
];

// Extra replies keep any additional round (e.g. a retry) from hanging the run.
for (let i = 0; i < 6; i++) replies.push({ text: "Nothing further." });

const server = await startFakeOllama({
  models: [
    {
      name: "qwen3.6:27b",
      size: 17_000_000_000,
      capabilities: ["completion", "tools", "vision"],
      contextLength: 262144,
    },
  ],
  loaded: [{ name: "qwen3.6:27b", context_length: 262144 }],
  replies,
});

const packaged = process.argv.includes("--packaged");
// The package this machine makes (out/Genex-<platform>-<arch>, or STUDIO_PACKAGE_DIR).
const electron = packaged ? packagedApp(root).bin : resolveElectron(root);
const appArgs = packaged ? [] : ["."];
// The self test's own data folder, named here so its log can be shown when a check fails: on a
// machine only the release canary reaches, that log is the one account of what the core did.
// Windows' temp folder can be spelled with 8.3 names (GENEXO~1), which the app's folders never are.
const userData = givenUserData ?? realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "studio-selftest-")));
const args = [...appArgs, "--studio-selftest", `--ollama-host=${server.host}`, `--userdata=${userData}`];
if (show) args.push("--show");
const anthropic = claudeWorker ? await startFakeAnthropic({ command: CLAUDE_WORKER_COMMAND }) : null;
if (anthropic) args.push(`--claude-worker-check=${CLAUDE_WORKER_PROOF.file}`);
// The scripted Anthropic stand-in, and a dummy token so the CLI starts signed in to nothing real.
const claudeEnv = anthropic
  ? {
      ANTHROPIC_BASE_URL: anthropic.baseUrl,
      CLAUDE_CODE_OAUTH_TOKEN: "selftest-fake-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }
  : {};

console.log(`launching electron self test (model server at ${server.host})…`);
const child = spawn(electron, fixtureElectronArgs(args), {
  env: { ...fixtureElectronEnv(), ...claudeEnv },
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    console.error("\ne2e timed out after 8 minutes — killing electron");
    child.kill("SIGKILL");
  }, 8 * 60_000);
  child.on("exit", (exitCode) => {
    clearTimeout(timer);
    resolve(exitCode ?? 1);
  });
});

await server.close();
if (anthropic) {
  console.log(`Claude worker's shell: ${anthropic.calledShell() ?? "never called"}`);
  console.log(`Claude worker's command answered: ${anthropic.shellResult() ?? "nothing"}`);
  await anthropic.close();
}

/** How much of the self test's log a failed run prints. */
const LOG_TAIL_LINES = 300;

/** Print the end of the self test's log, then drop its data folder unless asked to keep it. */
async function settleUserData(failed) {
  if (failed) {
    const log = await readFile(path.join(userData, "logs", "studio.log"), "utf8").catch(() => "");
    const tail = log.split(/\r?\n/).slice(-LOG_TAIL_LINES).join("\n");
    console.log(`\n── the self test's log (last ${LOG_TAIL_LINES} lines) ──\n${tail || "(no log)"}`);
  }
  if (!keep && !givenUserData) await rm(userData, { recursive: true, force: true }).catch(() => {});
}

const match = /__SELFTEST_JSON__([\s\S]*?)__END__/.exec(stdout);
if (!match) {
  console.error(`\ne2e: no report was produced (exit ${code})`);
  await settleUserData(true);
  process.exit(1);
}
const report = JSON.parse(match[1]);
await settleUserData(report.failed > 0);
console.log("\n── e2e checks (headless self test) ──");
for (const check of report.checks) {
  console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
}

// ── phase 2: boot the real app and check the window a person actually sees ──────────────────
console.log("\nlaunching the real app (smoke)…");
const smokeServer = await startFakeOllama({
  models: [{ name: "qwen3.6:27b", size: 17_000_000_000, capabilities: ["completion", "tools"] }],
});
const smokeArgs = [...appArgs, "--studio-smoke", `--ollama-host=${smokeServer.host}`];
const smoke = spawn(electron, fixtureElectronArgs(smokeArgs), {
  env: fixtureElectronEnv(),
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let smokeOut = "";
smoke.stdout.setEncoding("utf8");
smoke.stdout.on("data", (chunk) => {
  smokeOut += chunk;
});
smoke.stderr.setEncoding("utf8");
smoke.stderr.on("data", (chunk) => process.stderr.write(chunk));
const smokeCode = await new Promise((resolve) => {
  const timer = setTimeout(() => smoke.kill("SIGKILL"), 120_000);
  smoke.on("exit", (exitCode) => {
    clearTimeout(timer);
    resolve(exitCode ?? 1);
  });
});
await smokeServer.close();

const smokeMatch = /__SMOKE_JSON__([\s\S]*?)__END__/.exec(smokeOut);
let smokeFailed = 1;
if (smokeMatch) {
  const smokeReport = JSON.parse(smokeMatch[1]);
  smokeFailed = smokeReport.failed;
  console.log("\n── e2e checks (real window) ──");
  for (const check of smokeReport.checks) {
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
  }
} else {
  console.error("smoke: no report was produced");
}

const total = report.checks.length + (smokeMatch ? JSON.parse(smokeMatch[1]).checks.length : 0);
const failedTotal = report.failed + smokeFailed;
console.log(`\n${total - failedTotal}/${total} e2e checks passed`);
process.exit(failedTotal === 0 && code === 0 && smokeCode === 0 ? 0 : 1);
