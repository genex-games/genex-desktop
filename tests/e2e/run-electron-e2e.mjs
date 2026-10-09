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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeOllama, stateFixtureBuild } from "../helpers/fake-ollama.ts";
import { packagedApp } from "./packaged-app.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const show = process.argv.includes("--show");
const keep = process.argv.includes("--keep");

/** A small but real game: keeps the studio contract, adds its own probe. */
const GAME_SOURCE = `import * as THREE from "three";
import { installStudio } from "./studio.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080b14);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
scene.add(new THREE.DirectionalLight(0xffffff, 2.4).translateY(6), new THREE.HemisphereLight(0x88aaff, 0x101018, 0.8));

const rings = new THREE.Group();
scene.add(rings);
const ship = new THREE.Mesh(
  new THREE.ConeGeometry(0.4, 1.2, 8),
  new THREE.MeshStandardMaterial({ color: 0x6ee7ff, flatShading: true }),
);
ship.rotation.x = Math.PI / 2;
scene.add(ship);

const state = { score: 0, phase: "flying", z: 0, smokeRevision: 0 };

function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// Every camera travels with the ship: the run's critic screenshots them after ~30s of
// simulated play, and cameras parked at the origin would all frame the same empty background —
// byte-identical JPEGs, which the evidence pass rightly reads as a dead debugCamera.
const cameras = {
  default: () => { camera.position.set(0, 2.5, ship.position.z + 7); camera.lookAt(0, 0, ship.position.z - 6); },
  close: () => { camera.position.set(1.6, 1.2, ship.position.z + 3); camera.lookAt(ship.position); },
  wide: () => { camera.position.set(-9, 6, ship.position.z + 11); camera.lookAt(0, 0, ship.position.z - 6); },
  top: () => { camera.position.set(0, 16, ship.position.z + 0.001); camera.lookAt(0, 0, ship.position.z); },
};

installStudio({
  reset(seed) {
    state.score = 0; state.phase = "flying"; state.z = 0;
    ship.position.set(0, 0, 0);
    rings.clear();
    let a = seed >>> 0;
    const rng = () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < 14; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.4, 0.12, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xffd166, flatShading: true }),
      );
      ring.position.set((rng() - 0.5) * 6, (rng() - 0.5) * 3, -6 - i * 7);
      rings.add(ring);
    }
    cameras.default();
  },
  update(dt) {
    state.z -= dt * 12;
    ship.position.z = state.z;
    camera.position.z = state.z + 7;
    for (const ring of [...rings.children]) {
      ring.rotation.z += dt;
      if (Math.abs(ring.position.z - ship.position.z) < 0.6) { rings.remove(ring); state.score += 25; }
    }
    if (rings.children.length === 0) state.phase = "cleared";
  },
  render() { renderer.render(scene, camera); },
  probes() {
    return { score: state.score, phase: state.phase, smokeRevision: state.smokeRevision, entities: { rings: rings.children.length },
             shipZ: Number(ship.position.z.toFixed(3)), drawCalls: renderer.info.render.calls };
  },
  cameras,
});
`;

/** Give authored smoke builds distinct state and pixels so a blind fixture can compare them. */
const smokeGameSource = (revision) =>
  GAME_SOURCE.replace("smokeRevision: 0", `smokeRevision: ${revision}`).replace(
    "0x080b14",
    `0x${(0x080b14 + revision * 0x010100).toString(16)}`,
  );

const replies = [
  {
    toolCalls: [{ id: "call_new", name: "new_game", arguments: { name: "selftest", title: "Self Test" } }],
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
  { toolCalls: [{ id: "call_state", name: "game_state", arguments: {} }] },
  { text: "Done — a ring-flying prototype is running in the preview." },
];

// The self test also exercises SkillOpt-free paths only; extra replies keep any additional
// round (e.g. a retry) from hanging the run.
for (let i = 0; i < 6; i++) replies.push({ text: "Nothing further." });

/**
 * Content-aware responder for the Loop commission the self test sends: it plays the intake
 * clerk, the builder, the blind judge and the reference panel. Keyed on prompt text because the
 * judge's candidates are shuffled — a fixed reply cannot say "pick the challenger"; the
 * responder reads the authored smoke state from the evidence. Anything it
 * does not recognise returns null and falls through to the scripted chat replies above.
 */
let commissioned = false;
let autopilotCommissioned = false;
let loopBuilds = 0;
let facetBuilds = 0;
let baseBuilds = 0;
const respond = (request) => {
  const text = request.messages.map((m) => m.content).join("\n");

  if (text.includes("Final optimization specialist"))
    return { text: "No safe change is justified for this smoke fixture." };
  if (text.includes("Optimization preservation review"))
    return {
      text: JSON.stringify({
        status: "unavailable",
        reasons: ["Smoke responder cannot prove preservation"],
        summary: "Keep the verified baseline",
      }),
    };

  // Autopilot's decomposer: the only prompt carrying the engine hint.
  if (text.includes("ENGINE HINT: maxParallel")) {
    return {
      text: JSON.stringify({
        facets: [
          { id: "water", title: "Water", brief: "dark harbor water with slow swell", budgetShare: 0.5 },
          { id: "mist", title: "Mist", brief: "dawn mist and warm light", budgetShare: 0.5 },
        ],
        game: { mouseLook: false, keyboardMove: false },
        integrationNotes: "one shared palette",
        assumptions: ["chose a warm dawn palette — no reference colours given"],
      }),
    };
  }

  // v2 loop: the base builder's one turn (no tools needed for the smoke), and the playtester
  // answering the integration facet's play check — both keyed on their own prompt text.
  if (text.includes("You are the BASE BUILDER")) {
    baseBuilds++;
    return baseBuilds % 2
      ? {
          toolCalls: [
            {
              id: "call_base",
              name: "write_file",
              arguments: { project: "misty-harbor", file: "src/main.js", contents: smokeGameSource(10) },
            },
          ],
          text: "Build a playable baseline.",
        }
      : { text: "Base ready." };
  }
  if (text.includes("QUESTIONS TO ANSWER AT THE END")) {
    return {
      text: JSON.stringify({
        answers: { "integration-play": { answer: "yes", note: "walked" } },
        report: "scripted play",
      }),
    };
  }

  // Autopilot's per-facet critic — must be matched BEFORE the generic BUILD A/B judge:
  // both prompts carry the two builds, only this one names the facet under judgement.
  if (text.includes("THE FACET UNDER JUDGEMENT")) {
    const letter = stateFixtureBuild(request);
    return {
      text: JSON.stringify({
        pick: letter,
        satisfied: true,
        biggest_gap: "",
        reason: "scripted facet critic",
      }),
    };
  }

  // Blind head-to-head: compare authored state, independent of the shuffled letter.
  if (text.includes("BUILD A") && text.includes("BUILD B")) {
    const letter = stateFixtureBuild(request);
    return {
      text: JSON.stringify({
        facets: { works: letter, visuals: letter, feel: letter, play: letter },
        biggest_gap: "the water needs more shimmer",
        reason: "scripted facets",
      }),
    };
  }

  // Reference panel: three votes for the build — the victory exit is the only fast honest way
  // out of a run whose hours clamp to at least half an hour of wall clock.
  if (text.includes("THE BUILD") && text.includes("REFERENCE:")) {
    return {
      text: JSON.stringify({
        looks: "build",
        plays: "build",
        better: "Clear moving ship and readable ring silhouettes",
        biggest_gap: "nothing left",
        reason: "scripted panel",
      }),
    };
  }

  // Autopilot intake: interview done in one breath, commission the run.
  if (text.includes("Autopilot is ON") && !autopilotCommissioned) {
    autopilotCommissioned = true;
    return {
      toolCalls: [
        {
          id: "call_autopilot",
          name: "start_autopilot",
          arguments: {
            goal: "a misty harbor scene at dawn",
            direction: "misty harbor at dawn",
            project: "misty-harbor",
          },
        },
      ],
      text: "Commissioning Autopilot.",
    };
  }

  // Autopilot facet builders: the proven game, once per facet, then done.
  if (text.includes("You are building ONE FACET")) {
    facetBuilds++;
    if (facetBuilds % 2 === 1) {
      return {
        toolCalls: [
          {
            id: `call_facet_${facetBuilds}`,
            name: "write_file",
            arguments: { project: "misty-harbor", file: "src/main.js", contents: smokeGameSource(20 + facetBuilds) },
          },
        ],
        text: "Building this facet.",
      };
    }
    return { text: "Done with this facet iteration." };
  }

  // Loop-on intake: commission the run instead of chatting.
  if (text.includes("Loop is ON") && !commissioned) {
    commissioned = true;
    return {
      toolCalls: [
        {
          id: "call_loop",
          name: "start_unattended_run",
          arguments: {
            goal: "a neon ring game over dark water",
            direction: "neon rings over dark water",
            project: "neon-rings",
          },
        },
      ],
      text: "Commissioning the run.",
    };
  }

  // Builder turns inside the run: the proven game, then done. Keyed on the brief's own opening
  // line (gauntlet or facet), not a loose phrase — "unattended run" alone once matched the
  // operating-rules prose that rides in every prompt.
  if (text.includes("You are in an unattended run (") || text.includes("You are building ONE FACET")) {
    loopBuilds++;
    if (loopBuilds % 2 === 1) {
      return {
        toolCalls: [
          {
            id: `call_build_${loopBuilds}`,
            name: "write_file",
            arguments: { project: "neon-rings", file: "src/main.js", contents: smokeGameSource(loopBuilds) },
          },
        ],
        text: "Building the first playable.",
      };
    }
    return { text: "Done with this iteration." };
  }

  // Post-run self-improvement: propose nothing, so the pass (and run.settled behind it) is quick.
  if (text.includes("SKILL FILE (")) return { text: '{"edits":[],"rationale":"nothing"}' };

  return null;
};

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
  respond,
});

const packaged = process.argv.includes("--packaged");
// The package this machine makes (out/Genex-<platform>-<arch>, or STUDIO_PACKAGE_DIR).
const electron = packaged ? packagedApp(root).bin : resolveElectron(root);
const appArgs = packaged ? [] : ["."];
const args = [...appArgs, "--studio-selftest", `--ollama-host=${server.host}`];
if (show) args.push("--show");
if (keep) args.push("--keep-userdata");

console.log(`launching electron self test (model server at ${server.host})…`);
const child = spawn(electron, fixtureElectronArgs(args), {
  env: fixtureElectronEnv(),
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

const match = /__SELFTEST_JSON__([\s\S]*?)__END__/.exec(stdout);
if (!match) {
  console.error(`\ne2e: no report was produced (exit ${code})`);
  process.exit(1);
}
const report = JSON.parse(match[1]);
console.log("\n── e2e checks (headless self test) ──");
for (const check of report.checks) {
  console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
}

// Only the wire can prove this one: the composer's commission once reached the harness as a
// plain chat delegation, and every in-app check still passed. The model must have been briefed
// with "Loop is ON" — that briefing exists only on the commission path.
const loopReached = server.requests.some(
  (r) => r.path.startsWith("/v1/chat/completions") && JSON.stringify(r.body).includes("Loop is ON"),
);
console.log(
  `${loopReached ? "✔" : "✖"} the commission reached the harness as a Loop commission, not a chat delegation`,
);

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

const total = report.checks.length + 1 + (smokeMatch ? JSON.parse(smokeMatch[1]).checks.length : 0);
const failedTotal = report.failed + (loopReached ? 0 : 1) + smokeFailed;
console.log(`\n${total - failedTotal}/${total} e2e checks passed`);
process.exit(failedTotal === 0 && code === 0 && smokeCode === 0 ? 0 : 1);
