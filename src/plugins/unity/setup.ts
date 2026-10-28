/**
 * Set up Unity: the one change an existing Unity project needs before Genex's agents can reach its
 * editor, applied so nobody edits a manifest by hand. It adds Unity's Pipeline package to the
 * project's `Packages/manifest.json`; Unity downloads it when the project is next opened, or as
 * soon as its open editor comes forward. Everything else in the manifest stays as it is.
 *
 * Setup never writes through a link out of the project, keeps a copy of the manifest in the
 * plugin's storage before its first change, and records what it added, so Undo takes back exactly
 * that line and only while it is still as Genex wrote it: a version the person chose since stays.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  isJsonObject,
  pathExists,
  readJsonIfExists,
  readRegularFile,
} from "../../substrate/fsx.ts";
import { containedReal } from "../../substrate/paths.ts";
import { isUnity6 } from "./editors.ts";
import { PIPELINE_PACKAGE, PIPELINE_VERSION } from "./pipeline.ts";

/** A project's package manifest, relative to the project. */
const MANIFEST_FILE = "Packages/manifest.json";
/** The most of a manifest Genex reads: a large project's is a few kilobytes. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** The folder in the plugin's storage holding each game's setup record and its manifest's copy. */
const SETUP_FOLDER = "setup";
/** A game id as Genex names a game's record: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** Why a project was not set up. Wire values: never rename one. */
export const SetupRefusal = {
  /** The project was last saved with an editor older than Unity 6. */
  NeedsUnity6: "needs-unity-6",
  /** The project has no package manifest: Unity has never opened it. */
  NoManifest: "no-manifest",
  /** The manifest is no plain file of the project, or does not parse as one. */
  Unreadable: "unreadable",
  InvalidGame: "invalid-game",
} as const;
export type SetupRefusal = (typeof SetupRefusal)[keyof typeof SetupRefusal];

/** A refused setup, with a code its caller words. */
export class SetupError extends Error {
  readonly code: SetupRefusal;
  constructor(code: SetupRefusal) {
    super(code);
    this.name = "SetupError";
    this.code = code;
  }
}

/** The project a setup changes, and where its record goes. */
export interface SetupPlace {
  root: string;
  editorVersion?: string;
  storage: string;
  game: string;
}

/** What Genex added to a project, kept so Undo takes back exactly that. */
interface SetupRecord {
  root: string;
  package: string;
  version: string;
  at: string;
}

/** A manifest as read: where it is by real path, and its fields. */
export interface Manifest {
  file: string;
  fields: Record<string, unknown>;
  dependencies: Record<string, unknown>;
}

const recordFile = (place: SetupPlace): string => path.join(place.storage, SETUP_FOLDER, `${place.game}.json`);
const copyOfManifest = (place: SetupPlace): string =>
  path.join(place.storage, SETUP_FOLDER, place.game, "manifest.json");

/** Reads the project's manifest by real path inside the project, or says why it can't be changed. */
export async function readManifest(root: string): Promise<Manifest> {
  const file = await containedReal(root, MANIFEST_FILE).catch(() => undefined);
  if (!file) {
    const there = await pathExists(path.join(root, ...MANIFEST_FILE.split("/")));
    throw new SetupError(there ? SetupRefusal.Unreadable : SetupRefusal.NoManifest);
  }
  const text = await readRegularFile(file, MANIFEST_MAX_BYTES).catch(() => undefined);
  let fields: unknown;
  try {
    fields = text ? JSON.parse(text.toString("utf8")) : undefined;
  } catch {
    fields = undefined;
  }
  if (!isJsonObject(fields)) throw new SetupError(SetupRefusal.Unreadable);
  const dependencies = fields.dependencies ?? {};
  if (!isJsonObject(dependencies)) throw new SetupError(SetupRefusal.Unreadable);
  return { file, fields, dependencies };
}

/** Writes the manifest back with these dependencies, sorted by name as Unity keeps them. */
export async function writeManifest(manifest: Manifest, dependencies: Record<string, unknown>): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));
  await atomicWriteText(manifest.file, `${JSON.stringify({ ...manifest.fields, dependencies: sorted }, null, 2)}\n`);
}

/** The Pipeline package's version a project already asks for, if it asks for one. */
export async function pipelineVersionOf(root: string): Promise<string | undefined> {
  const version = (await readManifest(root)).dependencies[PIPELINE_PACKAGE];
  return typeof version === "string" ? version : undefined;
}

/** Keeps a copy of the manifest before Genex's first change to it; a copy already kept stays. */
async function keepCopy(place: SetupPlace, manifest: Manifest): Promise<void> {
  const copy = copyOfManifest(place);
  if (await pathExists(copy)) return;
  await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
  await copyFile(manifest.file, copy);
}

/**
 * Adds the Pipeline package to the project's manifest. A project that already asks for it is left
 * as it is (`changed: false`, with the version it asks for). Throws {@link SetupError} with
 * nothing changed for a project older than Unity 6 or a manifest that can't be read.
 */
export async function setUpProject(
  place: SetupPlace,
  now: () => Date = () => new Date(),
): Promise<{ changed: boolean; version: string }> {
  if (!GAME_ID.test(place.game)) throw new SetupError(SetupRefusal.InvalidGame);
  if (!isUnity6(place.editorVersion)) throw new SetupError(SetupRefusal.NeedsUnity6);
  const manifest = await readManifest(place.root);
  const asked = manifest.dependencies[PIPELINE_PACKAGE];
  if (typeof asked === "string") return { changed: false, version: asked };
  await keepCopy(place, manifest);
  const record: SetupRecord = {
    root: place.root,
    package: PIPELINE_PACKAGE,
    version: PIPELINE_VERSION,
    at: now().toISOString(),
  };
  await atomicWriteJson(recordFile(place), record);
  await writeManifest(manifest, { ...manifest.dependencies, [PIPELINE_PACKAGE]: PIPELINE_VERSION });
  return { changed: true, version: PIPELINE_VERSION };
}

/** The record of what Genex added to this project, when it added something. */
async function readRecord(place: SetupPlace): Promise<SetupRecord | undefined> {
  if (!GAME_ID.test(place.game)) return undefined;
  const record = await readJsonIfExists<unknown>(recordFile(place)).catch(() => null);
  if (!isJsonObject(record) || record.root !== place.root || record.package !== PIPELINE_PACKAGE) return undefined;
  if (typeof record.version !== "string") return undefined;
  return { root: place.root, package: PIPELINE_PACKAGE, version: record.version, at: String(record.at ?? "") };
}

/**
 * Takes back what setup added: the Pipeline package's line, while it is still the version Genex
 * wrote. A project Genex never set up, or one whose line the person changed since, is left as it
 * is (`changed: false`); the record goes either way.
 */
export async function undoSetup(place: SetupPlace): Promise<{ changed: boolean }> {
  const record = await readRecord(place);
  if (!record) return { changed: false };
  const manifest = await readManifest(place.root);
  const ours = manifest.dependencies[PIPELINE_PACKAGE] === record.version;
  if (ours) {
    const { [PIPELINE_PACKAGE]: _taken, ...rest } = manifest.dependencies;
    await writeManifest(manifest, rest);
  }
  await rm(recordFile(place), { force: true });
  return { changed: ours };
}
