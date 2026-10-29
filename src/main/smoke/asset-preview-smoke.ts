/** Optional local-file acceptance, invoked only by the isolated Build smoke app. */
import { cp, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import type { StudioCore } from "../studio-core.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { pressStageView } from "./stage-views.ts";
import { sleep } from "./wait.ts";

/** A thumbnail is rendered in the background; a heavy model takes a while. */
const THUMBNAIL_TIMEOUT_MS = 60 * SECOND_MS;
/** How long an opened preview has to become ready or say why not. */
const OPEN_TIMEOUT_MS = 20 * SECOND_MS;
/** A frame is given this long to draw before it is captured or compared. */
const SETTLE_MS = 250;
const ORBIT_SETTLE_MS = 200;
/** Every n-th byte of a capture is sampled for distinct colours. */
const PIXEL_STRIDE = 160;
/** A model shows more distinct colours than this; a texture more than one. */
const MIN_MODEL_COLORS = 12;
const MIN_TEXTURE_COLORS = 1;
/** A paused animation moves less than this between two reads. */
const PAUSED_DRIFT = 0.12;

/** Files every run of this smoke opens in the 3D viewer, and the ones only a local sample adds. */
const MODEL_FILES = [
  "animated.glb",
  "animated.gltf",
  "animated.fbx",
  "model.obj",
  "model.stl",
  "model.ply",
  "texture.hdr",
  "texture.exr",
  "texture.ktx2",
  "compressed.glb",
];
const THUMBNAIL_FILES = ["animated.glb", "tone.wav", "video.mp4"];

const PREVIEW = '[data-testid="asset-preview"]';

/** What the smoke drives and records. */
interface AssetSmoke {
  wc: WebContents;
  dir: string;
  check: (name: string, ok: boolean, detail?: string) => void;
  waitFor: (expression: string, timeoutMs?: number) => Promise<boolean>;
}

/** A capture of the viewer's canvas and where it was taken. */
interface Capture {
  bounds: { x: number; y: number; width: number; height: number };
  pixels: Buffer;
}

export async function assetPreviewSmoke(
  wc: WebContents,
  core: StudioCore,
  project: string,
  dir: string,
  check: (name: string, ok: boolean, detail?: string) => void,
  waitFor: (expression: string, timeoutMs?: number) => Promise<boolean>,
) {
  const smoke: AssetSmoke = { wc, dir, check, waitFor };
  await copyViewerFiles(core, project, dir);
  await showAssets(smoke);
  const retainedModel = await exists(dir, "retained.glb");
  const retainedAudio = await exists(dir, "retained.mp3");
  for (const file of [...MODEL_FILES, ...(retainedModel ? ["retained.glb"] : [])]) await checkModel(smoke, file);
  const mediaFiles = [
    "tone.wav",
    ...(retainedAudio ? ["retained.mp3"] : []),
    "video.mp4",
    "animated.gif",
    "notes.json",
  ];
  for (const file of mediaFiles) await checkMedia(smoke, file);
  await wc.executeJavaScript(`document.querySelector('[data-asset-card="assets/viewer/broken.glb"] button').click()`);
  check(
    "corrupt model has actionable error instead of endless loading",
    await waitFor(`document.querySelector('${PREVIEW} [role="alert"]')?.textContent.includes('valid GLB')`),
  );
  await closePreview(smoke);
}

async function copyViewerFiles(core: StudioCore, project: string, dir: string): Promise<void> {
  const output = path.join(core.games.dirFor(project), "assets", "viewer");
  await mkdir(output, { recursive: true });
  await cp(dir, output, {
    recursive: true,
    filter: (source) => !path.basename(source).startsWith("evidence-") && !source.endsWith(".py"),
  });
}

/** Open the Assets stage and wait for the copied files and their thumbnails. */
async function showAssets({ wc, check, waitFor }: AssetSmoke): Promise<void> {
  await pressStageView(wc, "live");
  await pressStageView(wc, "assets");
  check(
    "viewer files appear in Assets",
    await waitFor(`!!document.querySelector('[data-asset-card="assets/viewer/animated.glb"]')`),
  );
  for (const file of THUMBNAIL_FILES)
    check(
      `Assets card renders a real thumbnail for ${file}`,
      await waitFor(
        `document.querySelector('[data-asset-card="assets/viewer/${file}"] [data-thumbnail-state="ready"]')!==null`,
        THUMBNAIL_TIMEOUT_MS,
      ),
    );
}

function exists(dir: string, file: string): Promise<boolean> {
  return access(path.join(dir, file)).then(
    () => true,
    () => false,
  );
}

/** Open a file's preview; whether it became ready (rather than showing an error). */
async function openPreview({ wc, waitFor }: AssetSmoke, file: string): Promise<boolean> {
  await wc.executeJavaScript(`document.querySelector('[data-asset-card="assets/viewer/${file}"] button').click()`);
  await waitFor(
    `!!document.querySelector('${PREVIEW} [data-preview-ready="true"], ${PREVIEW} [role="alert"]')`,
    OPEN_TIMEOUT_MS,
  );
  return wc.executeJavaScript(`!!document.querySelector('${PREVIEW} [data-preview-ready="true"]')`);
}

async function closePreview({ wc, waitFor }: AssetSmoke): Promise<void> {
  await wc.executeJavaScript(`document.querySelector('${PREVIEW} button[aria-label="Close"]').click()`);
  await waitFor(`!document.querySelector('${PREVIEW}')`);
}

/** The viewer's animations bar, and its clip buttons. */
const CLIPS = `${PREVIEW} [role="group"][aria-label="Animations"] button[aria-pressed]`;

/** A model or texture in the 3D viewer: it loads, draws, orbits and animates. */
async function checkModel(smoke: AssetSmoke, file: string): Promise<void> {
  const { wc, check } = smoke;
  const ok = await openPreview(smoke, file);
  const error = await wc.executeJavaScript(`document.querySelector('${PREVIEW} [role="alert"]')?.textContent??''`);
  check(`local viewer loads ${file}`, ok, error);
  if (ok) {
    const capture = await checkRendered(smoke, file);
    if (file === "animated.glb") await checkOrbit(smoke, capture);
    if (file.startsWith("animated.")) await checkAnimation(smoke, file);
  }
  await closePreview(smoke);
}

/** Capture the viewer's canvas, check it drew something, and keep it as evidence. */
async function checkRendered(smoke: AssetSmoke, file: string): Promise<Capture> {
  const { wc, dir, check } = smoke;
  await sleep(SETTLE_MS);
  const bounds = await wc.executeJavaScript(
    `(()=>{const r=document.querySelector('${PREVIEW} canvas').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})()`,
  );
  const image = await wc.capturePage(bounds);
  const pixels = image.toBitmap();
  const colors = new Set<string>();
  for (let i = 0; i < pixels.length; i += PIXEL_STRIDE) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  const least = file.startsWith("texture.") ? MIN_TEXTURE_COLORS : MIN_MODEL_COLORS;
  check(`${file} renders visible pixels`, colors.size > least, `${colors.size} sampled colors`);
  await writeFile(path.join(dir, `evidence-${file}.png`), image.toPNG());
  if (file === "retained.glb")
    await writeFile(path.join(dir, "evidence-model-dialog.png"), (await wc.capturePage()).toPNG());
  return { bounds, pixels };
}

/** Drag across the model: the orbit control must change the view; then a double-click resets it. */
async function checkOrbit({ wc, check }: AssetSmoke, { bounds, pixels }: Capture): Promise<void> {
  const x = bounds.x + Math.round(bounds.width / 2);
  const y = bounds.y + Math.round(bounds.height / 2);
  wc.sendInputEvent({ type: "mouseDown", button: "left", x, y, clickCount: 1 });
  wc.sendInputEvent({ type: "mouseMove", x: x + 90, y: y + 30 });
  wc.sendInputEvent({ type: "mouseUp", button: "left", x: x + 90, y: y + 30, clickCount: 1 });
  await sleep(ORBIT_SETTLE_MS);
  const moved = await wc.capturePage(bounds);
  check("3D orbit pointer changes the rendered view", !moved.toBitmap().equals(pixels));
  await wc.executeJavaScript(
    `document.querySelector('${PREVIEW} canvas').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
  );
}

/** An animated model offers its clips and opens playing the first; its play button pauses it. */
async function checkAnimation(smoke: AssetSmoke, file: string): Promise<void> {
  const { wc, check, waitFor } = smoke;
  const count = await wc.executeJavaScript(`document.querySelectorAll('${CLIPS}').length`);
  check(`${file} exposes embedded animation`, count > 0);
  if (count === 0) return;
  const animationTime = `Number(document.querySelector('${PREVIEW} canvas').dataset.animationTime)`;
  check(`${file} animation advances`, await waitFor(`${animationTime}>.2`));
  await wc.executeJavaScript(`document.querySelector('${PREVIEW} button[aria-label^="Pause"]').click()`);
  const before = await wc.executeJavaScript(animationTime);
  await sleep(SETTLE_MS);
  const after = await wc.executeJavaScript(animationTime);
  check(`${file} animation pauses`, Math.abs(after - before) < PAUSED_DRIFT);
}

/** A media file decodes; audio and video also play, and closing stops and releases them. */
async function checkMedia(smoke: AssetSmoke, file: string): Promise<void> {
  const { wc, dir, check, waitFor } = smoke;
  check(
    `media viewer decodes ${file}`,
    await openPreview(smoke, file),
    await wc.executeJavaScript(`document.querySelector('[role="alert"]')?.textContent??''`),
  );
  if (!/\.(wav|mp3|mp4)$/.test(file)) {
    await closePreview(smoke);
    return;
  }
  const result = await wc.executeJavaScript(
    `(async()=>{const m=document.querySelector('${PREVIEW} audio,${PREVIEW} video');window.__assetTestMedia=m;try{await m.play();return true;}catch(e){return String(e);}})()`,
    true,
  );
  if (file === "retained.mp3") {
    await sleep(SETTLE_MS);
    await writeFile(path.join(dir, "evidence-audio-dialog.png"), (await wc.capturePage()).toPNG());
  }
  check(`${file} starts playback`, result === true, String(result));
  check(`${file} playback advances`, await waitFor(`window.__assetTestMedia.currentTime>.1`));
  await closePreview(smoke);
  check(
    `${file} close stops and releases media`,
    await wc.executeJavaScript(`window.__assetTestMedia.paused&&!window.__assetTestMedia.getAttribute('src')`),
  );
}
