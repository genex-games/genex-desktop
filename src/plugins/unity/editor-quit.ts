/**
 * The agent's own `quit-editor`, so a chat never asks the person to quit Unity: the game's editor
 * saves its work through Genex's own save (`saveWork`: each named scene with unsaved work by its
 * path, then the assets), then exits cleanly. The agent's own play is stopped first; the person's
 * play is theirs. An editor that can't be asked, a save Unity refused or a scene that has no file
 * yet leaves the editor open: quitting never loses work. Opening it again is `open-editor`.
 */
import { agentPlaying } from "./agent-play.ts";
import { editorRuns, endEditor, isPlaying, saveWork } from "./editor-life.ts";
import { type Moment, type MomentDeps, stopPlay } from "./editor-moments.ts";
import { editorStatus, PipelineProblem } from "./pipeline.ts";

/** The longest reason a refusal quotes from Unity. */
const MAX_REASON_CHARS = 160;

const MESSAGE = {
  NoProject: "This game's folder holds no Unity project.",
  NotOpen: "Unity doesn't have this game's project open, so there was nothing to quit.",
  Stalled:
    "Unity's main thread runs nothing (a long import, or a dialog nobody answered): Genex can't save its work, so Genex didn't quit it. Call unity__quit-editor again in a minute; if Unity stays so, unity__restart-editor ends it and opens the project again (the user confirms it; unsaved editor work is lost).",
  NotAnswering:
    "Unity doesn't answer yet (it is starting, reloading its scripts or importing): Genex can't save its work, so Genex didn't quit it. Call unity__quit-editor again in a moment; if it keeps saying so, unity__restart-editor ends it and opens the project again (the user confirms it).",
  PersonPlays:
    "The user is playing the game in Unity, and scenes can't be saved while it plays, so Genex didn't quit Unity. Call unity__quit-editor again once their play ends.",
  SaveFailed: (why: string) => `Unity couldn't save its work (${why}), so Genex left Unity open.`,
  Untitled: (count: number) =>
    `${count === 1 ? "A scene" : `${count} scenes`} with unsaved work in Unity ${count === 1 ? "has" : "have"} never been saved: save ${count === 1 ? "it" : "each"} with save_scene and a path under Assets/, then call unity__quit-editor again. Genex left Unity open.`,
  NotEnded: "Genex saved Unity's work, but Unity could not be ended. Call unity__quit-editor again in a moment.",
  Quit: (saved: string) => `${saved}, then quit it. Open it again with unity__open-editor.`,
} as const;

/** What a quit saved, in words: the scenes it wrote, else the assets alone. */
function savedWords(count: number): string {
  if (count === 0) return "Saved Unity's assets";
  return `Saved ${count === 1 ? "1 scene" : `${count} scenes`} in Unity`;
}

/** The first words of a trouble Unity gave, as a reason fits. */
const reasonOf = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").slice(0, MAX_REASON_CHARS);

/**
 * `quit-editor`: the game's editor saved and ended, in words for the agent. A refusal throws and
 * leaves the editor as it was, its work unsaved but never lost.
 */
export async function quitEditor(moment: Moment, deps: MomentDeps): Promise<string> {
  const root = moment.project?.root;
  if (!root) throw new Error(MESSAGE.NoProject);
  if (!(await editorRuns(root, deps))) return MESSAGE.NotOpen;
  const look = await editorStatus(root, deps.pipeline, { signal: moment.signal });
  if (!look.ok) throw new Error(look.problem === PipelineProblem.Stalled ? MESSAGE.Stalled : MESSAGE.NotAnswering);
  if (isPlaying(look.result)) {
    const agents = await agentPlaying(moment.storage, moment.game, deps.now().getTime());
    if (!agents) throw new Error(MESSAGE.PersonPlays);
    await stopPlay(moment, root, deps);
  }
  const saved = await saveWork(root, deps, moment.signal);
  if (saved.trouble) throw new Error(MESSAGE.SaveFailed(reasonOf(saved.trouble.detail ?? saved.trouble.problem)));
  if (saved.untitled > 0) throw new Error(MESSAGE.Untitled(saved.untitled));
  if (!(await endEditor(root, deps))) throw new Error(MESSAGE.NotEnded);
  return MESSAGE.Quit(savedWords(saved.saved.length));
}
