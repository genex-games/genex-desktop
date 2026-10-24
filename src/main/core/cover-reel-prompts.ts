/**
 * What the session building a game made as an app (Unity, Godot, Unreal) is told about its cover:
 * Studio cannot photograph a game that runs as its own program, so the agent renders the picture and
 * five seconds of play from inside the engine into the folder `cover-reel.ts` reads. Model-facing.
 */
import { CoreFact } from "../../shared/project-facts.ts";
import {
  type AppEngineFact,
  CLIP_FRAMES_FOLDER,
  CLIP_FRAMES_FPS,
  CLIP_VIDEO_NAMES,
  COVER_PICTURE_NAMES,
  GAME_COVER_FOLDER,
} from "./cover-reel.ts";

const FOLDER = GAME_COVER_FOLDER.join("/");
const PICTURE = COVER_PICTURE_NAMES[0];
const FRAMES = `${FOLDER}/${CLIP_FRAMES_FOLDER}`;
/** Five seconds of frames, as the clip Genex shows lasts. */
const CLIP_FRAMES = 5 * CLIP_FRAMES_FPS;

/** The engine's own way to render the picture and the frames, said as a builder in it would. */
const HOW: Readonly<Record<AppEngineFact, string>> = {
  [CoreFact.UnityProject]: `In Unity: an editor script (a menu item under Tools, kept in the project) that plays the main scene with Time.captureFramerate = ${CLIP_FRAMES_FPS}, renders the game camera into a RenderTexture (1920x1080 for the picture, 960x540 for the frames) and saves each with Texture2D.EncodeToPNG; the game drives itself with its own demo or AI input while it records.`,
  [CoreFact.GodotProject]: `In Godot: Movie Maker renders frame by frame at a fixed rate, for example godot --path <project> --write-movie <game folder>/${FRAMES}/frame.png --fixed-fps ${CLIP_FRAMES_FPS} --resolution 960x540 --quit-after ${CLIP_FRAMES} <scene>, with the scene playing itself; the picture is one viewport image (get_viewport().get_texture().get_image().save_png) at 1920x1080.`,
  [CoreFact.UnrealProject]: `In Unreal: HighResShot 1920x1080 from a gameplay camera in Play In Editor for the picture (copied from Saved/Screenshots), and the Movie Render Queue on a short Level Sequence for the frames: PNG sequence, ${CLIP_FRAMES_FPS} fps, 960x540.`,
};

/**
 * The cover guidance for a session that owns the build of a game made as an app in `engine`: what
 * to render, where, when, and the engine's own way to render it.
 */
export function appCoverGuidance(engine: AppEngineFact): string {
  return [
    `GAME COVER: Genex shows this game with one 16:9 picture and five seconds of real play (its gallery card, its page, the Publish window). Studio cannot film a game that runs as an app, so you render both from inside the engine into ${FOLDER}/ in the game folder (Studio's own folder: never in git or a build):`,
    `- ${FOLDER}/${PICTURE}: one 1920x1080 frame of the game playing, in its own world, light and effects, composed to read at card size, with no HUD, menu or debug text.`,
    `- ${FRAMES}/0001.png onward: ${CLIP_FRAMES} frames (five seconds at ${CLIP_FRAMES_FPS} frames a second) of the game playing by itself, 960x540, rendered frame by frame at a fixed 1/${CLIP_FRAMES_FPS} s step, never screen-recorded, HUD hidden, something on screen moving. One ${CLIP_VIDEO_NAMES.join(" or ")} of the same works too.`,
    HOW[engine],
    "WHEN: in the same turn the game first runs and plays (a small side task, never a turn of its own), and again after a big visual change; never every turn. Keep the render script in the project so a rerun is one step, and replace the files rather than adding new names. Look at the picture and a few frames with read_file before you say the cover is ready. Never relight the game or add text or anything it lacks. Studio and Genex Publish take the cover from these files: no Genex tool is needed to make them.",
  ].join("\n");
}
