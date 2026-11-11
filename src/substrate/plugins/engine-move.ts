/**
 * Move into game, for any engine plugin: the open game's own engine project, which lies in another
 * folder, becomes a folder of the game, where Rewind, Loops and Publish reach it. The folder is
 * renamed on its own disk: nothing is copied and nothing at the target is replaced. A project on
 * another disk, one its editor has open or a Loop is using, one another game builds in too, a
 * folder that isn't only the project's, and a game that already has the target folder are refused
 * before anything moves. The plugin says what a project folder of its engine is and where a game
 * keeps one (`MoveInRules`), and carries what names the project's path after the rename.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInside } from "../paths.ts";

/** Why a project can't move into the open game. */
export const MoveInRefusal = {
  /** No game is open. */
  NoGame: "no-game",
  /** The project isn't the open game's own linked one. */
  NotOwn: "not-own",
  /** It already lies in the game's folder. */
  Inside: "inside",
  /** Its folder holds the game's folder, or the person's home: a folder can't move into itself. */
  HoldsGame: "holds-game",
  /** Its folder isn't only this project's, by the engine's own rule. */
  NotProjectFolder: "not-project-folder",
  /** Another Genex game builds in it too, and its link would name a folder that is gone. */
  Shared: "shared",
  /** Its editor has it open, or a Loop is using it. */
  InUse: "in-use",
  /** The game already has something at the target. */
  Taken: "taken",
  /** It is on another disk than the game: a move would be a long copy. */
  OtherDisk: "other-disk",
} as const;
export type MoveInRefusal = (typeof MoveInRefusal)[keyof typeof MoveInRefusal];

/** What a plugin knows before a move. */
export type MoveInFacts = {
  /** The open game's folder; undefined with no game open. */
  game: string | undefined;
  /** The person's home folder, which never moves. */
  home: string;
  /** The project's folder. */
  directory: string;
  /** The project is the open game's own linked one. */
  own: boolean;
  /** Another Genex game builds in it too. */
  shared: boolean;
  /** Its editor has it open, or a Loop is using it. */
  inUse: boolean;
};

/** An engine's own rules for a move. */
export type MoveInRules = {
  /** The folder of a game that holds this engine's project, such as `unreal`. */
  folder: string;
  /** Whether `folder` holds one project of this engine and nothing else's; it and `home` are real paths. */
  isProjectFolder: (folder: string, home: string) => Promise<boolean>;
};

/** A move that can go ahead (the project's real folder and where it goes), or why it can't. */
export type MoveInPlan = { from: string; target: string } | { refusal: MoveInRefusal };

/** The file every Genex game keeps at its folder's root: a folder with one is a game of its own and never moves. */
const GAME_FILE = "studio.json";

const realOr = (file: string) => realpath(file).catch(() => file);
const refuse = (refusal: MoveInRefusal): MoveInPlan => ({ refusal });

/** Whether two folders are on one disk, so a rename moves one into the other without copying. */
async function sameDisk(a: string, b: string): Promise<boolean> {
  const [one, other] = await Promise.all([stat(a), stat(b)]);
  return one.dev === other.dev;
}

/** Whether the project's folder may move at all: it holds neither the game nor home, is no game itself, and is only the project's. */
async function movable(from: string, game: string, home: string, rules: MoveInRules): Promise<MoveInRefusal | null> {
  if (isInside(game, from)) return MoveInRefusal.Inside;
  if (isInside(from, game) || isInside(from, home)) return MoveInRefusal.HoldsGame;
  // A disk's own root is never a project's folder, whatever it holds.
  if (path.dirname(from) === from) return MoveInRefusal.NotProjectFolder;
  // A game that keeps its project at its own root has no link record, so "shared" never sees it.
  if (await lstat(path.join(from, GAME_FILE)).catch(() => null)) return MoveInRefusal.NotProjectFolder;
  return (await rules.isProjectFolder(from, home)) ? null : MoveInRefusal.NotProjectFolder;
}

/** Decides a move without changing anything: every path is compared by its real place on disk. */
export async function planMoveIn(facts: MoveInFacts, rules: MoveInRules): Promise<MoveInPlan> {
  if (!facts.game) return refuse(MoveInRefusal.NoGame);
  if (!facts.own) return refuse(MoveInRefusal.NotOwn);
  const [game, from, home] = await Promise.all([realOr(facts.game), realOr(facts.directory), realOr(facts.home)]);
  const unmovable = await movable(from, game, home, rules);
  if (unmovable) return refuse(unmovable);
  if (facts.shared) return refuse(MoveInRefusal.Shared);
  if (facts.inUse) return refuse(MoveInRefusal.InUse);
  const target = path.join(game, rules.folder);
  if (await lstat(target).catch(() => null)) return refuse(MoveInRefusal.Taken);
  if (!(await sameDisk(from, game).catch(() => false))) return refuse(MoveInRefusal.OtherDisk);
  return { from, target };
}
