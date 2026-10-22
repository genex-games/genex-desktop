import { previewBytes } from "./asset-bytes.ts";
/** Trusted local viewer. Asset URLs are provided by the contained host reader; network is denied. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  assetCompanion,
  assetExtension,
  assetPreviewMode,
  loadFailure,
  PreviewFailure,
  PreviewFileError,
} from "../shared/asset-preview.ts";
import { assetFormat } from "../shared/game-assets.ts";

/** The most memory a model's own files may take in the preview. */
const RESOURCE_LIMIT_BYTES = 100 * 1024 * 1024;
/** The most external buffers and images a glTF may name. */
const MAX_GLTF_RESOURCES = 128;
/** The most sibling textures an FBX preview reads. */
const MAX_FBX_TEXTURES = 64;
/** How long decoding may take before the preview gives up. */
const DECODE_TIMEOUT_MS = 30000;
/** How often the animation clock is reported. */
const TIME_REPORT_MS = 100;
/** The longest step one frame advances an animation, in seconds. */
const MAX_FRAME_STEP_S = 0.1;
/** An OBJ material library's texture keys. */
const MTL_TEXTURE_KEY = /^(map_\w+|bump|disp|decal|norm)$/i;

const MESSAGE = {
  notGlb: "This file is not a valid GLB model.",
  glbIncomplete: "The GLB model metadata is incomplete.",
  missingResource: (name) => `Missing local model resource: ${name}. Keep its textures and buffers beside the model.`,
  undecodable: (name) => `Could not decode model resource: ${name}`,
  decoderFailed: (message) => `Texture decoder failed: ${message}`,
  closed: "Preview closed.",
  resourcesTooLarge: "Model resources exceed the 100 MiB preview memory limit. The original files are unchanged.",
  texturesTooLarge: "Model resources exceed the preview memory limit.",
  badBounds: "The model has invalid geometry bounds.",
  contextLost: "The graphics context was lost. Close and reopen this preview.",
  tooManyResources: "This model has too many external resources for an in-app preview.",
  oneMaterialLibrary: "Preview supports one material library per OBJ. Export GLB to preserve this model’s materials.",
  timedOut: "Preview decoding timed out. Try an optimized GLB or a standard image export.",
  motionsTooLarge: "Animation files exceed the preview memory limit.",
};

const fileName = (url) => url.split("/").pop();

function gltfDocument(bytes, ext) {
  if (ext === "gltf") return JSON.parse(new TextDecoder().decode(bytes));
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || data.getUint32(0, true) !== 0x46546c67) throw new PreviewFileError(MESSAGE.notGlb);
  const length = data.getUint32(12, true);
  if (data.getUint32(16, true) !== 0x4e4f534a || length + 20 > bytes.length)
    throw new PreviewFileError(MESSAGE.glbIncomplete);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)).replace(/\0+$/, ""));
}

/**
 * The canvas: sRGB output, filmic tone mapping, focusable and labelled for the preview's controls.
 * It is clear where nothing is drawn, so the model sits on the page's own colour in either theme.
 */
function createRenderer(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.setAttribute("aria-label", "Interactive asset preview");
  renderer.domElement.tabIndex = 0;
  host.append(renderer.domElement);
  return renderer;
}

/** The scene the asset sits in: a room environment, two lights, and an orbiting camera. */
function createStage(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  camera.position.set(3, 2, 4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.listenToKeyEvents(renderer.domElement);
  const environment = new RoomEnvironment(),
    pmrem = new THREE.PMREMGenerator(renderer),
    env = pmrem.fromScene(environment);
  environment.dispose();
  pmrem.dispose();
  scene.environment = env.texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 5, 4);
  scene.add(light);
  return { scene, camera, controls, env };
}

/** The loading manager: every URL a loader asks for must be a resource this preview read itself. */
function createManager(v) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("data:")) return url;
    // FBX can create embedded-texture URLs itself; release those on close too.
    if (url.startsWith("blob:")) {
      v.ownedURLs.add(url);
      return url;
    }
    if (v.urls.has(url)) return v.urls.get(url);
    throw new PreviewFileError(MESSAGE.missingResource(fileName(url)));
  });
  manager.onError = (url) => {
    if (!v.disposed) v.onError(new Error(MESSAGE.undecodable(fileName(url))), PreviewFailure.File);
  };
  return manager;
}

/** The KTX2 loader, decoding in the packaged Basis worker. */
function createKtx(v, renderer) {
  const ktx = new KTX2Loader()
    .setTranscoderPath(new URL("./decoders/basis/", location.href).href)
    .detectSupport(renderer);
  // A blob worker inherits the renderer CSP. Basis's Emscripten bindings need dynamic
  // function creation, so execute only the packaged decoder in its own dedicated worker.
  const initKtx = ktx.init.bind(ktx);
  ktx.init = () =>
    initKtx().then(() => {
      ktx.workerPool.setWorkerCreator(() => {
        const worker = new Worker(new URL("./decoders/basis/worker.js", location.href));
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          if (!v.disposed) v.onError(new Error(MESSAGE.decoderFailed(event.message)), PreviewFailure.Interrupted);
          ktx.dispose();
        });
        const transcoderBinary = ktx.transcoderBinary.slice(0);
        worker.postMessage({ type: "init", config: ktx.workerConfig, transcoderBinary }, [transcoderBinary]);
        return worker;
      });
    });
  return ktx;
}

/** An object URL for bytes this preview read, revoked when it closes. */
function urlFor(v, bytes, mime) {
  if (v.disposed) throw new Error(MESSAGE.closed);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  v.ownedURLs.add(url);
  return url;
}

/** Read one resource a model names beside itself, within the preview's memory. */
async function resource(v, uri) {
  if (uri.startsWith("data:")) return;
  if (v.urls.has(uri)) return;
  const result = await v.read(assetCompanion(v.file, uri));
  if (v.disposed) return;
  const bytes = previewBytes(result.data);
  v.resourceBytes += bytes.length;
  if (v.resourceBytes > RESOURCE_LIMIT_BYTES) throw new PreviewFileError(MESSAGE.resourcesTooLarge);
  v.urls.set(uri, urlFor(v, bytes, result.mimeType));
}

/** A mesh's materials, as a list whether it has one or several. */
const materialsOf = (node) => (Array.isArray(node.material) ? node.material : [node.material]).filter(Boolean);

/** Dispose an object's geometry and materials; its textures are kept for the viewer to dispose. */
function disposeObject(v, value) {
  value?.traverse((node) => {
    node.geometry?.dispose();
    for (const material of materialsOf(node)) {
      for (const field of Object.values(material)) if (field?.isTexture) v.textures.add(field);
      material.dispose();
    }
  });
}

/** How far back the camera must stand, looking at `center`, to see every corner of the box. */
function framingDistance(camera, box, center) {
  const inverse = camera.quaternion.clone().invert(),
    tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
    tanH = tanV * camera.aspect;
  let distance = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const point = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
        distance = Math.max(distance, Math.abs(point.y) / tanV + point.z, Math.abs(point.x) / tanH + point.z);
      }
  return distance;
}

/** Frame the object: face it (a texture head on), stand back far enough, and bound the orbit to its size. */
function fit(v) {
  const { object, camera, controls } = v;
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()),
    center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.001);
  if (!Number.isFinite(radius)) throw new PreviewFileError(MESSAGE.badBounds);
  const direction = v.isTexture ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0.65, 1.3).normalize();
  camera.position.copy(center).add(direction);
  camera.lookAt(center);
  const distance = Math.max(framingDistance(camera, box, center) * 1.15, radius * 0.1);
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(radius / 10000, 0.00001);
  camera.far = Math.max(radius * 1000, distance * 10);
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 100;
  controls.update();
}

/** Keep the canvas the host's size; draw every frame, stepping the animation and reporting its clock. */
function startLoop(v) {
  const { host, renderer, camera, controls, scene } = v;
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  let previous = performance.now(),
    lastReport = 0;
  function tick(now) {
    if (v.disposed) return;
    v.frame = requestAnimationFrame(tick);
    const delta = Math.min((now - previous) / 1000, MAX_FRAME_STEP_S);
    previous = now;
    if (v.mixer && v.playing) v.mixer.update(delta * v.speed);
    controls.update();
    renderer.render(scene, camera);
    if (now - lastReport > TIME_REPORT_MS) {
      lastReport = now;
      v.onTime(v.action?.time ?? 0);
      renderer.domElement.dataset.animationTime = String(v.action?.time ?? 0);
    }
  }
  v.frame = requestAnimationFrame(tick);
  return resize;
}

/** A glTF or GLB: its external buffers and images first, then the scene and its animations. */
async function loadGltf(v, bytes, ext) {
  const doc = gltfDocument(bytes, ext);
  const uris = [...(doc.buffers ?? []), ...(doc.images ?? [])].map((item) => item.uri).filter(Boolean);
  if (uris.length > MAX_GLTF_RESOURCES) throw new PreviewFileError(MESSAGE.tooManyResources);
  for (const uri of uris) await resource(v, uri);
  if (v.disposed) return undefined;
  const loader = new GLTFLoader(v.manager)
    .setDRACOLoader(v.draco)
    .setKTX2Loader(v.ktx)
    .setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(ext === "gltf" ? new TextDecoder().decode(bytes) : bytes.buffer, "");
  v.clips = gltf.animations;
  return gltf.scene;
}

/** An OBJ's one material library, with every texture it names read beside it. */
async function objMaterials(v, library) {
  const mtlFile = assetCompanion(v.file, library);
  const mtl = await v.read(mtlFile);
  const source = new TextDecoder().decode(previewBytes(mtl.data));
  const materials = new MTLLoader(v.manager).parse(source, "");
  for (const info of Object.values(materials.materialsInfo))
    for (const [key, value] of Object.entries(info)) {
      if (!MTL_TEXTURE_KEY.test(key)) continue;
      const uri = materials.getTextureParams(value, {}).url;
      const target = assetCompanion(mtlFile, uri);
      const tex = await v.read(target);
      const data = previewBytes(tex.data);
      v.resourceBytes += data.length;
      if (v.resourceBytes > RESOURCE_LIMIT_BYTES) throw new PreviewFileError(MESSAGE.texturesTooLarge);
      v.urls.set(uri, urlFor(v, data, tex.mimeType));
    }
  materials.preload();
  return materials;
}

async function loadObj(v, bytes) {
  const text = new TextDecoder().decode(bytes),
    loader = new OBJLoader(v.manager);
  const mtls = [...text.matchAll(/^mtllib\s+(.+)$/gm)].map((match) => match[1].trim());
  if (mtls.length > 1) throw new PreviewFileError(MESSAGE.oneMaterialLibrary);
  if (mtls.length) loader.setMaterials(await objMaterials(v, mtls[0]));
  return loader.parse(text);
}

/** An FBX, with the textures beside it (FBX names them by its own paths, so read what is there). */
async function loadFbx(v, bytes) {
  const { file } = v;
  const folder = file.slice(0, file.lastIndexOf("/") + 1);
  const siblings = v.companions.filter((name) => name.startsWith(folder) && assetFormat(name)?.texture === true);
  for (const sibling of siblings.slice(0, MAX_FBX_TEXTURES))
    await resource(v, sibling.slice(file.lastIndexOf("/") + 1));
  const loaded = new FBXLoader(v.manager).parse(bytes.buffer, "");
  v.clips = loaded.animations ?? [];
  return loaded;
}

/** An STL or PLY: bare geometry, shaded in a neutral material (with its vertex colours when it has them). */
function loadScan(bytes, ext) {
  const geometry = ext === "stl" ? new STLLoader().parse(bytes.buffer) : new PLYLoader().parse(bytes.buffer);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xcbd2dd, vertexColors: !!geometry.attributes.color, roughness: 0.65 }),
  );
}

/** A KTX2, HDR or EXR texture, shown flat on a plane of its aspect, facing the camera. */
async function loadTexture(v, bytes, ext, mimeType) {
  let texture;
  if (ext === "ktx2") texture = await v.ktx.loadAsync(urlFor(v, bytes, mimeType));
  else {
    const parsed = ext === "hdr" ? new RGBELoader().parse(bytes.buffer) : new EXRLoader().parse(bytes.buffer);
    texture = new THREE.DataTexture(
      parsed.data,
      parsed.width,
      parsed.height,
      parsed.format ?? THREE.RGBAFormat,
      parsed.type,
    );
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.needsUpdate = true;
  }
  v.textures.add(texture);
  const aspect = texture.image.width / texture.image.height;
  v.controls.enableRotate = false;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(aspect, 1),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
}

/** The asset as a scene object, by its format; undefined when the preview closed while reading. */
function loadObject(v, bytes, ext, mimeType) {
  if (ext === "glb" || ext === "gltf") return loadGltf(v, bytes, ext);
  if (ext === "obj") return loadObj(v, bytes);
  if (ext === "fbx") return loadFbx(v, bytes);
  if (ext === "stl" || ext === "ply") return loadScan(bytes, ext);
  return loadTexture(v, bytes, ext, mimeType);
}

/**
 * The clips of one animation-only file (a rig and its clips, nothing to draw), named for the viewer.
 * They move the model by its bones' names; a file that cannot be read adds none.
 */
async function motionClips(v, motion) {
  try {
    const result = await v.read(motion.file);
    if (v.disposed) return [];
    const bytes = previewBytes(result.data);
    v.resourceBytes += bytes.length;
    if (v.resourceBytes > RESOURCE_LIMIT_BYTES) throw new PreviewFileError(MESSAGE.motionsTooLarge);
    const ext = assetExtension(motion.file);
    const gltf = await new GLTFLoader(v.manager)
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(ext === "gltf" ? new TextDecoder().decode(bytes) : bytes.buffer, "");
    return gltf.animations.map((clip, index, all) => {
      clip.name = all.length > 1 ? `${motion.name} ${index + 1}` : motion.name;
      return clip;
    });
  } catch {
    return [];
  }
}

/** Put the loaded object on stage, frame it, and report its animations and triangle count. */
function show(v, loaded) {
  const { camera, controls } = v;
  v.object = loaded;
  v.scene.add(loaded);
  v.mixer = new THREE.AnimationMixer(loaded);
  fit(v);
  if (v.isTexture) {
    camera.position.copy(controls.target).add(new THREE.Vector3(0, 0, camera.position.distanceTo(controls.target)));
    controls.update();
  }
  let triangles = 0;
  loaded.traverse((node) => {
    if (node.isMesh) triangles += (node.geometry.index?.count ?? node.geometry.attributes.position?.count ?? 0) / 3;
  });
  v.renderer.domElement.dataset.ready = "true";
  v.onReady({
    clips: v.clips.map((clip, index) => ({ name: clip.name || `Animation ${index + 1}`, duration: clip.duration })),
    triangles: Math.round(triangles),
  });
}

async function load(v) {
  const result = await v.read(v.file);
  if (v.disposed) return;
  const bytes = previewBytes(result.data);
  v.resourceBytes = bytes.length;
  const ext = assetExtension(v.file);
  const loaded = await loadObject(v, bytes, ext, result.mimeType);
  // A glTF whose resources were still arriving when the preview closed has nothing to show.
  if (loaded === undefined && v.disposed) return;
  for (const motion of v.motions) v.clips = [...v.clips, ...(await motionClips(v, motion))];
  if (v.disposed) {
    disposeObject(v, loaded);
    for (const texture of v.textures) texture.dispose();
    return;
  }
  show(v, loaded);
}

/** Close the preview: stop drawing, and release every object, texture, decoder and URL it made. */
function dispose(v, resize) {
  v.disposed = true;
  clearTimeout(v.loadTimer);
  cancelAnimationFrame(v.frame);
  resize.disconnect();
  v.controls.dispose();
  v.mixer?.stopAllAction();
  if (v.object) v.mixer?.uncacheRoot(v.object);
  disposeObject(v, v.object);
  for (const texture of v.textures) {
    texture.dispose();
    texture.image?.close?.();
  }
  v.env.dispose();
  v.draco.dispose();
  v.ktx.dispose();
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
  for (const url of v.ownedURLs) URL.revokeObjectURL(url);
}

/** What the preview panel drives: framing, a snapshot, and the animation's play, speed, clip and time. */
function viewerControls(v, resize) {
  const { host, renderer, camera } = v;
  return {
    fit: () => fit(v),
    snapshot() {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      fit(v);
      renderer.render(v.scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    play(value) {
      v.playing = value;
    },
    speed(value) {
      v.speed = value;
    },
    clip(index) {
      v.mixer?.stopAllAction();
      v.action = index >= 0 && v.clips[index] ? v.mixer.clipAction(v.clips[index]) : null;
      v.action?.reset().play();
      v.mixer?.update(0);
      v.playing = false;
      v.onTime(0);
    },
    seek(value) {
      if (!v.action) return;
      v.action.time = value;
      v.mixer.update(0);
      v.onTime(value);
    },
    dispose: () => dispose(v, resize),
  };
}

/**
 * A viewer for `file` in `host`. `motions` are animation-only files of the same rig, each `{file,
 * name}`: their clips play on the model after its own. `onError(error, failure)` names why as a
 * `PreviewFailure`: the file itself, or something around it that may pass.
 */
export function createAssetViewer(
  host,
  {
    file,
    read,
    companions,
    motions = /** @type {Array<{ file: string, name: string }>} */ ([]),
    onReady,
    onError,
    onTime,
  },
) {
  const renderer = createRenderer(host);
  const v = {
    host,
    file,
    read,
    companions,
    motions,
    onReady,
    onError,
    onTime,
    disposed: false,
    frame: 0,
    mixer: null,
    action: null,
    clips: [],
    playing: false,
    speed: 1,
    object: null,
    isTexture: assetPreviewMode(file) === "texture",
    urls: new Map(),
    ownedURLs: new Set(),
    textures: new Set(),
    resourceBytes: 0,
    renderer,
    ...createStage(renderer),
  };
  v.manager = createManager(v);
  v.draco = new DRACOLoader().setDecoderPath(new URL("./decoders/draco/gltf/", location.href).href);
  v.ktx = createKtx(v, renderer);
  const resize = startLoop(v);
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    if (!v.disposed) onError(new Error(MESSAGE.contextLost), PreviewFailure.Interrupted);
  });
  v.loadTimer = setTimeout(() => {
    if (!v.disposed) {
      onError(new Error(MESSAGE.timedOut), PreviewFailure.Interrupted);
      v.ktx.dispose();
    }
  }, DECODE_TIMEOUT_MS);
  void load(v)
    .catch((error) => {
      if (!v.disposed) onError(error, loadFailure(error));
    })
    .finally(() => clearTimeout(v.loadTimer));
  return viewerControls(v, resize);
}
