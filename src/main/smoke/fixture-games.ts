/**
 * The computer smoke's fixture games, and how the smoke hears from them. Each is a plain three.js
 * page with its own loop: nothing on it is the studio's. The studio drives it from outside (real
 * keys and clicks through the computer tool) and the smoke learns what the game did the way any
 * web game's own backend would: the game posts its state to a server on this machine
 * ({@link startGameReports}) whenever the player changed it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The largest report a fixture game posts, in bytes: more is not a report of these games. */
const MAX_REPORT_BYTES = 16 * 1024;

/** One report a fixture game posted: `boot` once per page load, `state` after the player changed something. */
export interface GameReport {
  game: string;
  kind: "boot" | "state" | "rejection";
  [field: string]: unknown;
}

/** The smoke's end of the reports: where the games post, and what each has said. */
export interface GameReports {
  url: string;
  /** Every report a game posted, oldest first. */
  of(game: string): GameReport[];
  /** The last state a game reported, or null before it reported any. */
  latest(game: string): GameReport | null;
  close(): Promise<void>;
}

/** A loopback server the fixture games post their reports to. */
export async function startGameReports(): Promise<GameReports> {
  const reports: GameReport[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REPORT_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      const report = parseReport(Buffer.concat(chunks).toString("utf8"));
      if (report) reports.push(report);
      response.writeHead(204, { "access-control-allow-origin": "*" });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const of = (game: string) => reports.filter((report) => report.game === game);
  return {
    url: `http://127.0.0.1:${port}/report`,
    of,
    latest: (game) => of(game).findLast((report) => report.kind === "state") ?? null,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A posted body as a report, or null when it is not one. */
function parseReport(body: string): GameReport | null {
  try {
    const parsed = JSON.parse(body) as Partial<GameReport> | null;
    return parsed && typeof parsed.game === "string" && typeof parsed.kind === "string" ? (parsed as GameReport) : null;
  } catch {
    return null;
  }
}

/**
 * The page's side of the reports: `report(fields)`, and a boot report saying what the page could
 * reach. With no server to post to, `report` does nothing: the game is only something to look at.
 */
function reporter(url: string | null, game: string): string {
  if (url === null) return "const report = () => {};\n";
  return `const REPORT_URL = ${JSON.stringify(url)};
const report = (fields) =>
  fetch(REPORT_URL, { method: "POST", mode: "no-cors", body: JSON.stringify({ game: ${JSON.stringify(game)}, ...fields }) }).catch(() => {});
addEventListener("unhandledrejection", (e) => report({ kind: "rejection", stack: String(e.reason?.stack ?? e.reason) }));
async function gpuReach() {
  if (!navigator.gpu) return { gpu: false };
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (!adapter) return { gpu: true, adapter: false };
  const device = await adapter.requestDevice().catch(() => null);
  const canvas = document.createElement("canvas");
  return { gpu: true, adapter: true, device: !!device, canvasContext: !!canvas.getContext("webgpu") };
}
gpuReach().then((gpu) => report({ kind: "boot", secure: isSecureContext, gpu }));
`;
}

/**
 * The computer smoke's game: a map picker on I, a click that picks the map, W that moves the
 * player, every key typed kept: a game that boots into the wrong map, in fifty lines.
 */
export function computerSmokeGame(reportUrl: string | null, game: string): string {
  return `import * as THREE from "three";
${reporter(reportUrl, game)}
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.style.margin = "0";
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2a3a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 3, 8);
camera.lookAt(0, 0, 0);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
scene.add(box);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x334455 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
scene.add(ground);
const player = { x: 0 };
const keys = new Set();
const state = { clicks: 0, map: "street", picker: false, typed: "", lastKey: "", clickAt: null };
const share = () =>
  report({ kind: "state", player: { ...player }, maps: { activeId: state.map }, clicks: state.clicks, clickAt: state.clickAt, picker: state.picker, typed: state.typed, lastKey: state.lastKey });
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
addEventListener("keydown", (e) => {
  keys.add(e.code);
  state.lastKey = e.key;
  if (e.key === "i") state.picker = !state.picker;
  else if (e.key.length === 1) state.typed += e.key;
  share();
});
addEventListener("keyup", (e) => keys.delete(e.code));
renderer.domElement.addEventListener("click", (e) => {
  state.clicks++;
  state.clickAt = [e.clientX, e.clientY];
  if (state.picker) { state.map = e.clientX < innerWidth / 2 ? "street" : "macba"; state.picker = false; }
  share();
});
let last = performance.now();
let sharedX = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (keys.has("KeyW")) player.x += 2 * dt;
  box.position.x = player.x;
  box.material.color.setHex(state.map === "macba" ? 0x44ccff : 0xff8800);
  renderer.render(scene, camera);
  if (Math.abs(player.x - sharedX) > 0.05) { sharedX = player.x; share(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
share();
`;
}

/** The same game on three.js's WebGPU renderer: proves an offscreen worker window renders and captures WebGPU. */
export function computerSmokeWebGpuGame(reportUrl: string, game: string): string {
  return `import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
${reporter(reportUrl, game)}
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.style.margin = "0";
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2a3a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 3, 8);
camera.lookAt(0, 0, 0);
const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
scene.add(box);
const backend = renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl";
const player = { x: 0 };
const keys = new Set();
let frames = 0;
const share = () => report({ kind: "state", backend, frame: frames, player: { ...player } });
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
let last = performance.now();
let sharedX = 0;
async function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (keys.has("KeyW")) player.x += 2 * dt;
  box.position.x = player.x;
  box.rotation.y += dt;
  await renderer.renderAsync(scene, camera);
  frames++;
  if (frames === 10 || Math.abs(player.x - sharedX) > 0.05) { sharedX = player.x; share(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
`;
}
