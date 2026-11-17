// The yard every scene of this game stands in: sky, light, ground, a fixed camera and the frame loop.
import * as THREE from "three";

const GROUND_SIZE = 24;
const CAMERA_POSITION = new THREE.Vector3(2.5, 1.55, 4.0);
const CAMERA_TARGET = new THREE.Vector3(0, 0.98, 0);

/** A lit yard drawn into the page. `run(update)` starts the frame loop; `update` gets the seconds since the last frame. */
export function createStage() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfd8e3);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7c8794, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new THREE.MeshStandardMaterial({ color: 0x9aa7b5 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x6f7c8a, 0x8a96a3));

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(CAMERA_TARGET);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  const run = (update) =>
    renderer.setAnimationLoop(() => {
      update(clock.getDelta());
      renderer.render(scene, camera);
    });
  return { scene, run };
}
