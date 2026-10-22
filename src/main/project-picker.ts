/** The native folder pickers behind New game and home's folder chip: where a game goes, and a folder to open instead. */
import path from "node:path";
import type { OpenDialogOptions } from "electron";
import { t } from "../shared/i18n.ts";

type PickerWords = Pick<OpenDialogOptions, "title" | "buttonLabel" | "message">;

/** Open existing's words, in main's language: the folder chosen is the game. */
function openWords(): PickerWords {
  return {
    title: t("Open project folder"),
    buttonLabel: t("Open"),
    message: t("Choose a folder, or create one. Images and notes inside it are visible to the agent."),
  };
}

/** The location picker's words: the folder chosen is only where the game's own folder is made. */
function locationWords(): PickerWords {
  return {
    title: t("Choose where to create the game"),
    buttonLabel: t("Choose"),
    message: t("The game gets a new folder of its own inside the folder you choose."),
  };
}

/**
 * Open existing: one folder, opening in the games root, with New Folder (`createDirectory`,
 * macOS), so a game can start in a folder made right there.
 */
export function projectPickerOptions(gamesRoot: string): OpenDialogOptions {
  return {
    ...openWords(),
    defaultPath: gamesRoot,
    properties: ["openDirectory", "createDirectory"],
  };
}

/**
 * A new game's location: one folder, with New Folder (macOS). It opens beside the games folder,
 * not inside it: every library-style folder there is a game, so a New Folder made there is one.
 */
export function gameLocationPickerOptions(gamesRoot: string): OpenDialogOptions {
  return {
    ...locationWords(),
    defaultPath: path.dirname(gamesRoot),
    properties: ["openDirectory", "createDirectory"],
  };
}
