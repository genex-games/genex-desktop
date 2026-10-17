/**
 * New Roblox game's place file: `<name>.rbxlx` (XML, so its changes read well in save points),
 * written from the Baseplate template the plugin ships into the game folder. The bytes go into a
 * hidden temporary file beside the place first and the place gets its name only once they are all
 * there, so a write that stops part-way leaves no place and no temporary file. A place that is
 * already there is never overwritten, and a game folder that is a link is refused with nothing
 * written.
 */
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** New places are XML place files. */
export const PLACE_EXTENSION = ".rbxlx";
/** The shipped template, beside the plugin's backend. */
export const TEMPLATE_FILE = path.join("templates", "baseplate.rbxlx");
/** The template beside this module: its source folder, or the built backend's folder the build copies it into. */
export const SHIPPED_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), TEMPLATE_FILE);
/** The longest name a new place gets, before its extension. */
const MAX_SLUG = 40;
/** A plain place name: a letter or digit first, then letters, digits, dashes, underscores or spaces. */
const PLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}\.rbxlx$/;
/** Windows device names, which no file may be called. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** The name given when a title holds no letter or digit. */
const FALLBACK_SLUG = "place";
/** How many numbered names are tried before giving up on finding a free one. */
const MAX_SUFFIX = 999;

/** Why a place wasn't written. Wire values: never rename. */
export const CreatePlaceRefusal = {
  BadName: "bad-name",
  Exists: "exists",
  /** The game folder is a link. */
  Linked: "linked",
  NotFolder: "not-folder",
} as const;
export type CreatePlaceRefusal = (typeof CreatePlaceRefusal)[keyof typeof CreatePlaceRefusal];

const MESSAGE = {
  [CreatePlaceRefusal.BadName]: (name: string) => `${JSON.stringify(name)} isn't a plain .rbxlx place name.`,
  [CreatePlaceRefusal.Exists]: (name: string) => `${name} is already in this game's folder, so Genex leaves it.`,
  [CreatePlaceRefusal.Linked]: (folder: string) => `${folder} is a link, so Genex writes no place there.`,
  [CreatePlaceRefusal.NotFolder]: (folder: string) => `${folder} isn't a folder.`,
} as const;

/** A place that wasn't written, and why. */
export class CreatePlaceError extends Error {
  readonly code: CreatePlaceRefusal;
  constructor(code: CreatePlaceRefusal, subject: string) {
    super(MESSAGE[code](subject));
    this.name = "CreatePlaceError";
    this.code = code;
  }
}

/** Writes the place's bytes into the temporary file; tests stand in for a write that stops. */
export type WritePlace = (temp: string, bytes: Buffer) => Promise<void>;

/** What a new place needs: the game folder, the place's name, the template and, for tests, the write. */
export interface CreatePlaceOptions {
  folder: string;
  name: string;
  template: string;
  write?: WritePlace;
}

const writeNew: WritePlace = (temp, bytes) => writeFile(temp, bytes, { flag: "wx", mode: 0o644 });

/** A title as a place's file name: small letters, digits and dashes, never a Windows device name. */
export function placeSlug(title: string): string {
  const plain = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  if (!plain) return FALLBACK_SLUG;
  return WINDOWS_DEVICE.test(plain) ? `${plain}-${FALLBACK_SLUG}` : plain;
}

const isPlaceName = (name: string) =>
  PLACE_NAME.test(name) && !WINDOWS_DEVICE.test(name.slice(0, -PLACE_EXTENSION.length));

const taken = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** The place name for `title` in `folder`: the title's, or the next numbered one free there. */
export async function suggestName(folder: string, title: string): Promise<string> {
  const slug = placeSlug(title);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = `${n === 1 ? slug : `${slug}-${n}`}${PLACE_EXTENSION}`;
    if (!(await taken(path.join(folder, name)))) return name;
  }
  throw new CreatePlaceError(CreatePlaceRefusal.Exists, `${slug}${PLACE_EXTENSION}`);
}

/** The game folder by its real path; a link or anything but a folder is refused. */
async function realFolder(folder: string): Promise<string> {
  const info = await lstat(folder).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new CreatePlaceError(CreatePlaceRefusal.Linked, folder);
  if (!info?.isDirectory()) throw new CreatePlaceError(CreatePlaceRefusal.NotFolder, folder);
  return realpath(folder);
}

/**
 * Writes the template into `folder` as `name` and answers the place's real path. The place appears
 * whole or not at all; one already there (a link too) is never touched.
 */
export async function createPlace(options: CreatePlaceOptions): Promise<string> {
  const { name } = options;
  if (!isPlaceName(name)) throw new CreatePlaceError(CreatePlaceRefusal.BadName, name);
  const folder = await realFolder(options.folder);
  const target = path.join(folder, name);
  if (await taken(target)) throw new CreatePlaceError(CreatePlaceRefusal.Exists, name);
  const bytes = await readFile(options.template);
  const temp = path.join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await (options.write ?? writeNew)(temp, bytes);
    // Checked again right before the rename: a place that appeared meanwhile is still never replaced.
    if (await taken(target)) throw new CreatePlaceError(CreatePlaceRefusal.Exists, name);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return target;
}
