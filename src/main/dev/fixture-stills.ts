/**
 * The stills-game fixture: two Blender games beside the fixture game, which no observer draws (a
 * scene and its notes, no web page). Pine valley has a finished Loop that kept two pictures its lead
 * named as proof, so Live shows that run's pictures; Mountain pass has no run yet, so its Live says
 * where pictures come from. No Blender is installed or opened: the scenes and the pictures are
 * stand-ins.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent } from "../../shared/custom-events.ts";
import { ObserverSource, PROOF_OBSERVER } from "../../shared/observers.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { runDir } from "../core/run-shots.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb } from "./fixture-kit.ts";

/** The finished Loop whose lead named two renders as proof. */
const RUN_ID = "fixture-stills-run";
const GOAL = "A misty pine valley at dawn, rendered from the ridge and from the lake.";
/** Where the finish check keeps the lead's pictures among the run's artifacts. */
const PROOF_FOLDER = path.join("finish", "proof", "r1");
/** The capture's label, as the finish check writes it. */
const PROOF_LABEL = "The lead's proof";
/** The two stand-in renders: their names and colors. */
const RENDERS: ReadonlyArray<{ name: string; file: string; colors: readonly [Rgb, Rgb] }> = [
  {
    name: "renders/ridge.png",
    file: "1-ridge.png",
    colors: [
      [210, 180, 150],
      [40, 70, 60],
    ],
  },
  {
    name: "renders/lake.png",
    file: "2-lake.png",
    colors: [
      [170, 190, 210],
      [30, 50, 70],
    ],
  },
];
/** The Blender game with pictures, and the one with none yet. */
const VALLEY_GAME = { name: "fixture-valley", title: "Pine valley", scene: "valley.blend" };
const PASS_GAME = { name: "fixture-pass", title: "Mountain pass", scene: "pass.blend" };

/** Adds a Blender game with one finished Loop's pictures, and one with no run. */
export async function seedStillsGame(core: StudioCore): Promise<void> {
  const valley = await blenderGame(core, VALLEY_GAME);
  await seedProofCapture(core, valley.name, await core.threadForGame(valley.name));
  await blenderGame(core, PASS_GAME);
}

/** A game of one stand-in Blender scene and its notes. */
async function blenderGame(core: StudioCore, game: { name: string; title: string; scene: string }) {
  const made = await core.games.makeEmpty(game.name, { title: game.title });
  await mkdir(path.join(made.dir, "art"), { recursive: true });
  await writeFile(path.join(made.dir, "art", game.scene), "BLENDER-v300 stand-in scene\n");
  await writeFile(path.join(made.dir, "NOTES.md"), `# ${game.title}\n\nA Blender scene.\n`);
  return made;
}

/** A finished Loop whose finish check kept the lead's two renders as its proof capture. */
async function seedProofCapture(core: StudioCore, project: string, threadId: string): Promise<void> {
  const dir = path.join(runDir(core.layout.runs, RUN_ID), PROOF_FOLDER);
  await mkdir(dir, { recursive: true });
  const images: Array<{ name: string; file: string }> = [];
  for (const render of RENDERS) {
    const file = path.join(dir, render.file);
    await writeFile(file, gradientShot(...render.colors));
    images.push({ name: render.name, file });
  }
  const run = fixtureRun({ runId: RUN_ID, project });
  await core.append(
    [
      run(CustomEvent.RunStarted, { goal: GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
      run(CustomEvent.ObserverCapture, {
        observer: PROOF_OBSERVER,
        label: PROOF_LABEL,
        source: ObserverSource.Proof,
        images,
      }),
      run(CustomEvent.RunFinished, {
        landed: true,
        executionStatus: ExecutionStatus.Completed,
        summary: "The valley renders from the ridge and from the lake.",
      }),
    ],
    threadId,
  );
}
