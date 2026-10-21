/**
 * What the Game mods plugin says: to the agent (its tools' answers) and to the person (the Live
 * card, the toolbar button and the panel's facts). Agent text names the next tool to call; the
 * person's text is one plain line that names the game.
 */
import { BUILT_WITH_NAME, type BuiltWith } from "./fingerprint.ts";
import { STORE_NAME, type GameStore } from "./find-games.ts";
import { type InstallDone, type InstallUndone, type RemoveDone, SavesKept } from "./install.ts";
import { ModRefusal, type ModTarget } from "./mod-link.ts";

/** The most games one `find-games` answer lists. */
export const MAX_LISTED_GAMES = 60;

/** One game as `find-games` lists it, for the agent. */
export function gameLine(game: ModTarget): string {
  const facts = [`id ${game.id}`, STORE_NAME[game.store]];
  if (game.builtWith) facts.push(BUILT_WITH_NAME[game.builtWith]);
  if (game.antiCheat.length) facts.push(`ships ${game.antiCheat.join(", ")}: no mods`);
  else if (game.refusal === ModRefusal.Online) facts.push("online game: no mods");
  else if (game.refusal === ModRefusal.Unchecked) facts.push("too big to check for anti-cheat: no mods");
  else if (game.mods) facts.push("Genex knows its mods folder");
  return `- ${game.name} · ${facts.join(" · ")}`;
}

/** The agent's words, by tool. */
export const AGENT = {
  NoGames:
    "No game is installed on this computer by Steam, the Epic Games Launcher or the Minecraft Launcher. Genex only makes mods for games the person has installed: ask them to install the game first.",
  Listed: (lines: string[], more: number) =>
    [
      `Games installed on this computer${more ? ` (the first ${lines.length})` : ""}:`,
      ...lines,
      'Next: mods__use-game {"game": "<id>"} for the game the person named. A game not listed is not installed here: say so, and ask them to install it first.',
    ].join("\n"),
  NoMatch: (name: string, lines: string[]) =>
    [`No installed game is called "${name}". The games installed on this computer:`, ...lines].join("\n"),
  NoGameHere: "This tool needs an open Genex game: the mod is made in it.",
  UnknownGame: (id: string) => `No installed game has the id "${id}". Call mods__find-games and use an id it lists.`,
  Refused: (game: ModTarget) => {
    if (game.antiCheat.length)
      return `Genex makes no mod for ${game.name}: it ships ${game.antiCheat.join(", ")}, and changing a game with anti-cheat can get the person banned. Tell them so in one line, and offer the game's own mod tools if it has any (its Workshop or level editor), or another game.`;
    if (game.refusal === ModRefusal.Unchecked)
      return `Genex makes no mod for ${game.name}: its folder is too big to check for anti-cheat, so Genex can't rule out a ban. Tell them so in one line, and offer the game's own mod tools if it has any, or another game.`;
    return `Genex makes no mod for ${game.name}: it is an online game, and changing its files breaks its rules and can get the person's account banned. Tell them so in one line, and offer another game.`;
  },
  OtherGame: (name: string) =>
    `This project is already a mod of ${name}. A mod of another game lives in a project of its own: tell the person to start one from home and ask there.`,
  Linked: (game: ModTarget) =>
    [
      `This project is now a mod of ${game.name} (${STORE_NAME[game.store]}); genex-mod.json at its root says so.`,
      `The game's folder: ${game.folder}`,
      game.mods
        ? `Its mods folder: ${game.mods}`
        : "Genex knows no mods folder for it: its mods go in the game's own folder (into: game).",
      game.saves ? `Its saves: ${game.saves} (copied aside before the first install).` : "",
      game.builtWith ? `Made with ${BUILT_WITH_NAME[game.builtWith]}.` : "",
      game.route ? `Route: ${game.route}` : "",
      'Read mods__skill {"name": "game-mods"} before you start. Build the mod in this project; mods__install puts it in the game.',
    ]
      .filter(Boolean)
      .join("\n"),
  NotLinked: "This project is not a mod of a game yet: call mods__find-games, then mods__use-game.",
  Gone: (name: string) => `${name} is not installed on this computer anymore. Tell the person; nothing was changed.`,
  Installed: (name: string, done: InstallDone) =>
    [
      done.before ? `Took the earlier version out first. ${removedWords(name, done.before)}` : "",
      `Copied ${files(done.copied)} into ${done.folder}${done.replaced ? `, keeping the ${files(done.replaced, "game file")} they replaced` : ""}. Remove mod puts the game back as it was.`,
      SAVES_SAID[done.saves],
      "Next: mods__play opens the game. Look at it with app_look (save a picture as shots/game.jpg), and play it with the computer tool when computer control is on.",
    ]
      .filter(Boolean)
      .join("\n"),
  InstallRefused: (why: string) => `${why} Nothing was copied.`,
  InstallUndone: (error: InstallUndone) =>
    [
      error.before ? `The earlier version was taken out, but the new one couldn't go in: ${error.message}` : "",
      error.before ? "" : `The install stopped part way (${error.message}), and Genex undid what it had copied.`,
      error.stuck
        ? `${files(error.stuck)} couldn't be undone; Remove mod takes ${error.stuck === 1 ? "it" : "them"} out once the game's folder is reachable.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  Removed: (name: string, done: RemoveDone) => `${removedWords(name, done)} Its saves stay as they are.`,
  NothingToRemove: (name: string) => `Nothing of this mod is in ${name}.`,
  Opened: (game: ModTarget) =>
    `Opened ${game.name} through ${STORE_NAME[game.store]}. It takes a moment to start: then look at its window with app_look.`,
  CantOpen: (name: string) => `Genex can't open ${name} here: ask the person to start it from their launcher.`,
  UnknownTool: (name: string) => `Unknown Game mods tool: ${name}`,
  UnknownAction: (name: string) => `Unknown Game mods action: ${name}`,
} as const;

/** A count of files, in words. */
const files = (count: number, noun = "file") => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What a removal did, in a sentence or two: what went, what came back, what it left and why. */
function removedWords(name: string, done: RemoveDone): string {
  const said = [
    `Took the mod out of ${name}: removed ${files(done.removed)} and put back ${done.restored} of the game's own.`,
  ];
  if (done.changed)
    said.push(
      `${files(done.changed)} the game or the person changed since ${done.changed === 1 ? "was" : "were"} left as ${done.changed === 1 ? "it is" : "they are"}.`,
    );
  if (done.skipped)
    said.push(
      `${files(done.skipped)} couldn't be reached safely (a link in the game's folder) and ${done.skipped === 1 ? "stays" : "stay"} recorded with ${done.skipped === 1 ? "its" : "their"} originals; Remove mod tries again.`,
    );
  return said.join(" ");
}

/** The install card's words, for one call: the game by name, and what the install replaces. */
export const CARD = {
  Install: (name: string, replaced: number, replacesEarlier: boolean) => {
    const earlier = replacesEarlier ? " It first takes out the version you put in before." : "";
    if (!replaced) return `Put this mod into ${name}?${earlier} Remove mod takes it out again.`;
    const them = replaced === 1 ? "it" : "them";
    return `Put this mod into ${name}? It replaces ${replaced} of the game's own files; Genex keeps ${them}, and Remove mod puts ${them} back.${earlier}`;
  },
} as const;

/** What the install answer says of the saves. */
const SAVES_SAID: Record<SavesKept, string> = {
  [SavesKept.Copied]: "The game's saves were copied aside first; the person can put them back from the Mod button.",
  [SavesKept.TooBig]:
    "The game's saves were too big to copy aside: tell the person to back them up before playing with the mod.",
  [SavesKept.None]: "",
  [SavesKept.Before]: "",
};

/** The person's words: the Live card, the toolbar button and the panel. */
export const PERSON = {
  Store: (store: GameStore) => STORE_NAME[store],
  BuiltWith: (built: BuiltWith | null) => (built ? BUILT_WITH_NAME[built] : null),
  InGame: (name: string, files: number) => `Mod for ${name} · in the game, ${files} file${files === 1 ? "" : "s"}`,
  NotInGame: (name: string) => `Mod for ${name} · not in the game yet`,
  Gone: (name: string) => `${name} isn't installed on this computer now`,
  Lost: "Ask the chat which game this mod is for",
  Play: (name: string) => `Play ${name}`,
} as const;
