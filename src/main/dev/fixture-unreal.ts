/**
 * The unreal-game fixture: the fixture game linked to a stand-in Unreal project inside its own
 * folder, with the Unreal plugin on. Its chat shows the link line (with Undo) and offers the steps
 * card, whose rows come live from the real plugin on this machine. One finished run kept a shot of
 * the editor's viewport as the plugin's viewport observer does at a save point, so Live's Unreal
 * card shows a picture. No Unreal is installed or opened: the project file and the shot are
 * stand-ins, and opening the project is native, so a fixture refuses it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent } from "../../shared/custom-events.ts";
import { ObserverSource, UNREAL_PLUGIN_ID } from "../../shared/observers.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { runDir } from "../core/run-shots.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb } from "./fixture-kit.ts";

/** The stand-in project: an Unreal project file as Unreal 5.8 writes a new Blueprint one. */
const PROJECT_FILE = path.join("unreal", "FixtureGame.uproject");
const PROJECT = { FileVersion: 3, EngineAssociation: "5.8", Category: "", Description: "" };

/** The finished run whose save point kept the viewport's shot. */
const RUN_ID = "fixture-unreal-run";
const GOAL = "A lantern-lit valley at dusk the player walks through.";
/** The plugin's viewport observer (its manifest's `observers[0].id`), and where Genex keeps its pictures in a run. */
const VIEWPORT = `${UNREAL_PLUGIN_ID}/viewport`;
const VIEWPORT_FOLDER = path.join("observers", `${UNREAL_PLUGIN_ID}-viewport`);
const SHOT_NAME = "Hero camera";
/** The stand-in shot's colors: dusk over the valley. */
const DUSK: readonly [Rgb, Rgb] = [
  [96, 104, 140],
  [36, 32, 40],
];

/** Links the game to its stand-in project and offers the steps card in its chat. */
export async function seedUnrealGame(core: StudioCore, project: { name: string; dir: string }, threadId: string) {
  const file = path.join(project.dir, PROJECT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(PROJECT, null, 2)}\n`);
  await core.plugins.setEnabled(UNREAL_PLUGIN_ID, true);
  const binding = { project: project.name, directory: project.dir, threadId };
  await core.engineLinks.link(UNREAL_PLUGIN_ID, binding, { project: file, auto: true });
  await core.engineLinks.steps(UNREAL_PLUGIN_ID, binding);
  await seedViewportShot(core, project.name, threadId);
}

/** A finished run whose save point kept a stand-in shot as the viewport observer's capture. */
async function seedViewportShot(core: StudioCore, project: string, threadId: string): Promise<void> {
  const dir = path.join(runDir(core.layout.runs, RUN_ID), VIEWPORT_FOLDER);
  const file = path.join(dir, "1-hero-camera.png");
  await mkdir(dir, { recursive: true });
  await writeFile(file, gradientShot(...DUSK));
  const run = fixtureRun({ runId: RUN_ID, project });
  await core.append(
    [
      run(CustomEvent.RunStarted, { goal: GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
      run(CustomEvent.ObserverCapture, {
        observer: VIEWPORT,
        label: SHOT_NAME,
        source: ObserverSource.Checkpoint,
        images: [{ name: SHOT_NAME, file }],
      }),
      run(CustomEvent.RunFinished, {
        landed: true,
        executionStatus: ExecutionStatus.Completed,
        summary: "The valley's lanterns are lit and the path is walkable.",
      }),
    ],
    threadId,
  );
}
