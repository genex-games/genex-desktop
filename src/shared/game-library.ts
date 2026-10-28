import { validateCoverSurface } from "./cover-shader.ts";
import { coverKeySeed, coverRecipeFromSeed, validateCoverRecipe, type CoverRecipe } from "./cover-recipe.ts";
import { t } from "./i18n.ts";
/** Host-owned presentation metadata. Folder identity and game files never change on rename. */
export type CoverStyle = "world" | "relic" | "city";
export type LegacyShaderCover = {
  kind: "shader";
  version: 1 | 2;
  surface: string;
  seed: number;
  poster: string;
  custom: boolean;
};
export type GameCover =
  | { kind: "procedural"; seed: number; style: CoverStyle; palette: number }
  | { kind: "image"; dataUrl: string }
  | LegacyShaderCover
  | CoverRecipe;
/** What a sphere draws: a recipe, or a legacy custom GLSL surface. */
export type DisplayCover = CoverRecipe | LegacyShaderCover;
export interface GameLibraryEntry {
  title?: string;
  pinned?: boolean;
  removed?: boolean;
  /** Folder trust is host metadata; project files cannot grant it. */
  trustProjectSettings?: boolean;
  /**
   * A copy of someone else's game (a Play remix) whose setup scripts the person has not trusted:
   * its packages install with none of them. Host metadata, like the trust above.
   */
  guardScripts?: boolean;
  cover?: GameCover;
  primaryThreadId?: string;
  /** The folder's content stamp as New game made it (`GameProject.scaffoldStamp`). */
  scaffoldStamp?: string;
  /** The title waits for the game's first idea; any title given since clears it. */
  provisional?: boolean;
  /** New game made it and no answer has ended with it built yet (`GameProject.awaitingFirstBuild`). */
  awaitingFirstBuild?: boolean;
}
export interface GameUpdate {
  title?: string;
  pinned?: boolean;
  cover?: GameCover;
}

/** The palette a brief's setting suggests (cold, green, hot), first match wins. */
const BRIEF_PALETTES: ReadonlyArray<readonly [RegExp, number]> = [
  [/ice|snow|winter|space|лед|снег/i, 1],
  [/forest|garden|village|fish|лес|дерев/i, 2],
  [/fire|desert|sun|огонь|пустын/i, 3],
];
const PALETTE_COUNT = 4;

/** Only a numeric seed and visual direction are saved, never a second copy of the brief. */
export function coverFromBrief(brief: string, style: CoverStyle = "world"): Extract<GameCover, { kind: "procedural" }> {
  const seed = coverKeySeed(brief.normalize("NFKC"));
  const suggested = BRIEF_PALETTES.find(([setting]) => setting.test(brief));
  const palette = suggested ? suggested[1] : seed % PALETTE_COUNT;
  return { kind: "procedural", seed, style, palette };
}

/**
 * Why a game, or a folder for one, was refused: making one, choosing where, opening a folder,
 * renaming, pinning, a new cover, removing one, or moving the games folder. Each value is also the
 * refusal's code across IPC (`shared/error-codes.ts`), beside the words a person reads.
 */
export const WorkspaceRefusal = {
  InvalidTitle: "game_title_invalid",
  InvalidCover: "game_cover_invalid",
  CoverUnreadable: "game_cover_unreadable",
  CoverTooLarge: "game_cover_too_large",
  FolderGone: "game_folder_gone",
  InvalidPin: "game_pin_invalid",
  /** A chat or a contractor is still working in the game. */
  WorkRunning: "game_work_running",
  BuildRunning: "game_build_running",
  GameNotFound: "game_not_found",
  /** The whole disk, the app's own data, a Claude Code folder, or a folder this launch protects. */
  LocationRefused: "location_refused",
  LocationGone: "location_gone",
  LocationNotFolder: "location_not_folder",
  InsideGame: "location_inside_game",
  RootNotEmpty: "games_root_not_empty",
  SubdirIsPath: "folder_subdir_is_path",
  NoSuchSubdir: "folder_no_such_subdir",
  /** The home folder, the disk, the Library folder, the app's data or the games folder itself. */
  BannedFolder: "folder_banned",
  AppFolder: "folder_of_app",
  InvalidName: "project_name_invalid",
  /** A folder picker asked for with no window to show it over. */
  NoWindow: "picker_no_window",
} as const;
export type WorkspaceRefusal = (typeof WorkspaceRefusal)[keyof typeof WorkspaceRefusal];

/** Why an export of a game's public copy stopped, as its code across IPC beside the words. */
export const ExportRefusal = {
  NeedsBuild: "export_needs_build",
  BuildFailed: "export_build_failed",
  FilesUndeclared: "export_files_undeclared",
  FilesInvalid: "export_files_invalid",
  TargetInsideGame: "export_target_inside_game",
  TargetNotFolder: "export_target_not_folder",
  TargetNotExport: "export_target_not_export",
  PublicPathInvalid: "export_public_path_invalid",
  PublicPathMissing: "export_public_path_missing",
  Symlink: "export_symlink",
  NotAFile: "export_not_a_file",
  /** A public file holds a credential Studio keeps. */
  SecretLeaked: "export_secret_leaked",
  NoEntry: "export_no_entry",
  ScopedImportMap: "export_scoped_import_map",
  UnresolvedModule: "export_unresolved_module",
  MissingReference: "export_missing_reference",
} as const;
export type ExportRefusal = (typeof ExportRefusal)[keyof typeof ExportRefusal];

/**
 * A refusal with its code, for this module: it cannot import `CodedError` (`shared/errors.ts`
 * lists this module's vocabularies), and `errorCode` reads any thrown value's `code`.
 */
const refused = (code: WorkspaceRefusal, words: string): Error => Object.assign(new Error(words), { code });

export function validateGameTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) {
    throw refused(WorkspaceRefusal.InvalidTitle, t("Enter a game name between 1 and 80 characters."));
  }
  return value.trim();
}

/** The largest data URL a cover may save (an upload, or a legacy shader's poster). */
const MAX_COVER_DATA_URL = 750_000;
const COVER_STYLES: readonly string[] = ["world", "relic", "city"] satisfies CoverStyle[];

const isSeed = (seed: number): boolean => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;

/** A legacy custom shader's own fields, before its surface is checked. */
function isLegacyShaderShape(cover: GameCover): cover is LegacyShaderCover {
  if (cover?.kind !== "shader") return false;
  const knownVersion = cover.version === 1 || cover.version === 2;
  const poster =
    typeof cover.poster === "string" &&
    cover.poster.length <= MAX_COVER_DATA_URL &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(cover.poster);
  return knownVersion && typeof cover.custom === "boolean" && isSeed(cover.seed) && poster;
}

function isProceduralCover(cover: GameCover): boolean {
  if (cover?.kind !== "procedural") return false;
  const palette = Number.isInteger(cover.palette) && cover.palette >= 0 && cover.palette < PALETTE_COUNT;
  return isSeed(cover.seed) && COVER_STYLES.includes(cover.style) && palette;
}

function isImageCover(cover: GameCover): boolean {
  return (
    cover?.kind === "image" &&
    typeof cover.dataUrl === "string" &&
    cover.dataUrl.length <= MAX_COVER_DATA_URL &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(cover.dataUrl)
  );
}

/** Throws unless the cover is one the library can save and draw. */
export function validateGameCover(cover: GameCover): void {
  if (cover?.kind === "recipe") {
    validateCoverRecipe(cover);
    return;
  }
  if (isLegacyShaderShape(cover)) {
    validateCoverSurface(cover.surface);
    return;
  }
  if (isProceduralCover(cover) || isImageCover(cover)) return;
  throw refused(WorkspaceRefusal.InvalidCover, t("Choose a PNG, JPEG or WebP image, or a valid cover recipe."));
}

const UNKEYED_COVER: CoverRecipe = { kind: "recipe", family: "clouds", palette: "genex", seed: 23, placeholder: true };

/**
 * What a cover draws, without mutating saved artwork or the game index. Records from before
 * recipes (none saved, or the old shared default) get a look of their own from their seed or
 * game key, so no two old games look alike. Uploads and procedural art stay images.
 */
export function displayCover(cover?: GameCover, key?: string): DisplayCover | undefined {
  if (!cover) return key === undefined ? UNKEYED_COVER : coverRecipeFromSeed(coverKeySeed(key));
  if (cover.kind === "recipe") return cover;
  if (cover.kind !== "shader") return undefined;
  return cover.custom ? cover : coverRecipeFromSeed(cover.seed);
}

/** Placeholders and legacy defaults may be replaced once by the builder's own choice. */
export function replaceableCover(cover?: GameCover): boolean {
  if (!cover) return true;
  if (cover.kind === "image") return false;
  if (cover.kind === "shader") return !cover.custom;
  if (cover.kind === "recipe") return cover.placeholder === true;
  return true;
}

/** Stable identity of what a sphere draws, for clocks and stills. */
export function coverSignature(cover: DisplayCover): string {
  if (cover.kind === "recipe") {
    const look = cover.hue === undefined ? cover.palette : `@${cover.hue}`;
    return `recipe:${cover.family}:${look}:${cover.seed}:${cover.motion ?? ""}`;
  }
  return `shader:${cover.version}:${cover.seed}:${coverKeySeed(cover.surface)}`;
}
