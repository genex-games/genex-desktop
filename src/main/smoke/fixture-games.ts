/**
 * The computer-smoke fixture: a game with a map picker on I, a click that picks the map, W
 * that moves the player, and state that reports all of it: a game that boots into the wrong map,
 * in forty lines.
 */
export const COMPUTER_SMOKE_GAME = `import * as THREE from "three";
import { installStudio } from "./studio.js";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2a3a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
box.userData.tag = "player";
scene.add(box);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x334455 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
ground.userData.tag = "ground";
scene.add(ground);
const player = { x: 0, y: 0, z: 0, yaw: 0 };
const state = { clicks: 0, map: "street", picker: false, typed: "", lastKey: "", clickAt: null };
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
addEventListener("keydown", (e) => {
  state.lastKey = e.key;
  if (e.key === "i") state.picker = !state.picker;
  else if (e.key.length === 1) state.typed += e.key;
});
renderer.domElement.addEventListener("click", (e) => {
  state.clicks++;
  state.clickAt = [e.clientX, e.clientY];
  if (state.picker) { state.map = e.clientX < innerWidth / 2 ? "street" : "macba"; state.picker = false; }
});
const cameras = {
  default() { camera.position.set(0, 3, 8); camera.lookAt(0, 0, 0); },
  top() { camera.position.set(0, 12, 0.01); camera.lookAt(0, 0, 0); },
};
cameras.default();
installStudio({
  canvas: renderer.domElement, scene, renderer, camera, input: { pointerLock: false }, player: () => player,
  reset() { player.x = 0; state.clicks = 0; state.map = "street"; state.picker = false; cameras.default(); },
  update(dt, ctx) {
    if (ctx.keys.has("KeyW")) player.x += 2 * dt;
    box.position.x = player.x;
    box.material.color.setHex(state.map === "macba" ? 0x44ccff : 0xff8800);
  },
  render() { renderer.render(scene, camera); },
  probes() { return { phase: "playing", player, clicks: state.clicks, clickAt: state.clickAt, maps: { activeId: state.map }, picker: state.picker, typed: state.typed, lastKey: state.lastKey }; },
  cameras,
});
`;

/** The same fixture on three.js's WebGPU renderer: proves an offscreen worker window renders and captures WebGPU. */
export const COMPUTER_SMOKE_WEBGPU_GAME = `import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { installStudio } from "./studio.js";
window.addEventListener("unhandledrejection", (e) => { if (!window.__firstStack) { window.__firstStack = String(e.reason?.stack ?? e.reason); } });
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2a3a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
box.userData.tag = "player";
scene.add(box);
const player = { x: 0, y: 0, z: 0, yaw: 0 };
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
const cameras = { default() { camera.position.set(0, 3, 8); camera.lookAt(0, 0, 0); } };
cameras.default();
installStudio({
  canvas: renderer.domElement, scene, renderer, camera, input: { pointerLock: false }, player: () => player,
  reset() { player.x = 0; cameras.default(); },
  update(dt, ctx) { if (ctx.keys.has("KeyW")) player.x += 2 * dt; box.position.x = player.x; box.rotation.y += dt; },
  render() { return renderer.renderAsync(scene, camera); },
  probes() { return { phase: "playing", player, backend: renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl" }; },
  cameras,
});
`;
