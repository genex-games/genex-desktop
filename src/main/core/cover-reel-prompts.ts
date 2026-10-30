/**
 * What the session building a game made as an app (Unity, Godot, Unreal) is told about its cover:
 * Genex cannot photograph a game that runs as its own program, so its cover is read from files in
 * the folder `cover-reel.ts` reads. Facts only: where, what size, and the engine's own way to render.
 * Model-facing.
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
  [CoreFact.UnityProject]: `In Unity, an editor script can play a scene with Time.captureFramerate = ${CLIP_FRAMES_FPS}, render a camera into a RenderTexture (1920x1080 for the picture, 960x540 for the frames) and save each with Texture2D.EncodeToPNG.`,
  [CoreFact.GodotProject]: `In Godot, Movie Maker renders frame by frame at a fixed rate, for example godot --path <project> --write-movie <game folder>/${FRAMES}/frame.png --fixed-fps ${CLIP_FRAMES_FPS} --resolution 960x540 --quit-after ${CLIP_FRAMES} <scene>; a picture is one viewport image (get_viewport().get_texture().get_image().save_png) at 1920x1080.`,
  [CoreFact.UnrealProject]: `In Unreal, HighResShot 1920x1080 in Play In Editor makes a picture (in Saved/Screenshots), and the Movie Render Queue on a Level Sequence makes frames: PNG sequence, ${CLIP_FRAMES_FPS} fps, 960x540.`,
};

/**
 * The cover facts for a session that owns the build of a game made as an app in `engine`: which
 * files Genex reads, their size, and the engine's own way to render them.
 */
export function appCoverGuidance(engine: AppEngineFact): string {
  return [
    `GAME COVER: Genex shows this game with one 16:9 picture and, when there is one, five seconds of play (its gallery card, its page, the Publish window). Genex cannot capture a game that runs as an app, so it reads them from ${FOLDER}/ in the game folder (Genex's own folder: never in git or a build), made however you like:`,
    `- ${FOLDER}/${PICTURE}: one 1920x1080 picture of the game.`,
    `- ${FRAMES}/0001.png onward (optional): ${CLIP_FRAMES} frames (five seconds at ${CLIP_FRAMES_FPS} frames a second) of the game, 960x540; one ${CLIP_VIDEO_NAMES.join(" or ")} of the same works too.`,
    HOW[engine],
    "Genex Publish takes the cover from these files; replacing them replaces the cover.",
  ].join("\n");
}
