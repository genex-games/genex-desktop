import * as THREE from "three";
import { createLook } from "./look.js";

// Corridor: walk a lit corridor, look around with the mouse. `three` is a bare specifier that
// the bundler resolves into the bundle — this game's THREE is its own copy, not the studio's.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06080c);
scene.fog = new THREE.Fog(0x06080c, 6, 42);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.7, 8);

scene.add(new THREE.AmbientLight(0x30465e, 1.4));

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x35424f, roughness: 0.85 });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x1a222c, roughness: 0.95 });

const floor = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 60), floorMaterial);
floor.position.set(0, -0.1, -18);
scene.add(floor);

const ceiling = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 60), wallMaterial);
ceiling.position.set(0, 3.4, -18);
scene.add(ceiling);

for (const side of [-1, 1]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.5, 60), wallMaterial);
  wall.position.set(side * 3, 1.75, -18);
  scene.add(wall);
}

// Lamps down the corridor: something to walk past, so a moved player is visible in a frame.
const lamps: THREE.PointLight[] = [];
for (let i = 0; i < 8; i += 1) {
  const z = 6 - i * 6;
  const lamp = new THREE.PointLight(0xffcf9b, 22, 14, 2);
  lamp.position.set(0, 3.1, z);
  scene.add(lamp);
  lamps.push(lamp);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.28, 0.3, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe3bb, emissive: 0xffb264, emissiveIntensity: 2 }),
  );
  shade.position.set(0, 3.25, z);
  scene.add(shade);
}

const crate = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 1.2, 1.2),
  new THREE.MeshStandardMaterial({ color: 0x8a6a3f, roughness: 0.8 }),
);
crate.position.set(1.4, 0.6, -12);
scene.add(crate);

const look = createLook(renderer.domElement);
const held = new Set<string>();
addEventListener("keydown", (event) => held.add(event.code));
addEventListener("keyup", (event) => held.delete(event.code));
addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const WALK = 3.4;
const forward = new THREE.Vector3();
const right = new THREE.Vector3();

// A THREE.Clock loop: getDelta() reads performance.now() through three's own wrapper, so the
// studio can only pace this game by owning the clock the page reads, not by asking the page.
const clock = new THREE.Clock();

function frame(): void {
  const dt = Math.min(0.05, clock.getDelta());

  camera.rotation.set(look.pitch, look.yaw, 0, "YXZ");
  forward.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
  right.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));

  let ahead = 0;
  let side = 0;
  if (held.has("KeyW") || held.has("ArrowUp")) ahead += 1;
  if (held.has("KeyS") || held.has("ArrowDown")) ahead -= 1;
  if (held.has("KeyD") || held.has("ArrowRight")) side += 1;
  if (held.has("KeyA") || held.has("ArrowLeft")) side -= 1;
  if (ahead !== 0 || side !== 0) {
    const length = Math.hypot(ahead, side);
    camera.position.addScaledVector(forward, (ahead / length) * WALK * dt);
    camera.position.addScaledVector(right, (side / length) * WALK * dt);
    camera.position.x = Math.max(-2.5, Math.min(2.5, camera.position.x));
    camera.position.z = Math.max(-46, Math.min(9, camera.position.z));
  }

  crate.rotation.y += dt * 0.6;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
