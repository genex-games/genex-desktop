/**
 * Each game's link to an engine project, kept by the host for a `game-engine` plugin, to a project
 * of the engine it declares (`engine` in its manifest, whose `projectFiles` say what a project file
 * is), with the published game's ids when the project lives at the engine's service. The record
 * that routes the plugin's calls lives in the plugin's own storage (`links/<game>.json`), where its
 * MCP servers read it and agents can't write; the game's studio.json gets a mirror for the brief,
 * the UI and the harness (`substrate/game-engine-binding.ts`). A link is made by real path, the
 * chat it came from (the game's own chat for a link made in the panel) gets one line with Undo, and
 * a refused link changes nothing on disk. A link that also set its project up (`setUp`) keeps that
 * in its record, and its Undo has the plugin take the set-up back first (`undoSetUp`), unless
 * another game's current link names the same project: that game builds in it too, so only the link
 * is undone.
 *
 * The link follows the game: a game this Genex never linked (no link file, not even an Undo's
 * `unlinkedAt`) whose studio.json mirrors a link another Genex made (a game opened from its folder,
 * from another profile) is adopted on its first plugin call or read: the plugin's record is written
 * from the mirror, without `setUp` (this Genex set nothing up) and with no chat line (there is nothing
 * to undo). Only a mirror of that plugin's engine whose project file is a regular file at exactly
 * its real path inside the game's own real folder is adopted.
 */
import { link as hardLink, lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CustomEvent, type CustomEventRecord, customEventData } from "../../shared/custom-events.ts";
import {
  type EngineBinding,
  type EngineCatalog,
  type EngineDeclaration,
  type EngineRemote,
  parseEngineBinding,
  parseEngineRemote,
  projectName,
  sameRemote,
} from "../../shared/game-engine.ts";
import { ENGINE_LINKS_FOLDER, type PluginBinding } from "../../shared/plugins.ts";
import { atomicWriteJson, readJsonIfExists } from "../fsx.ts";
import {
  projectFileOf,
  readEngineBinding,
  restoreEngineBinding,
  stillThere,
  writeEngineBinding,
} from "../game-engine-binding.ts";
import { isBelow } from "../paths.ts";
import { t } from "../../shared/i18n.ts";

/** A game id as it names a link file: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The longest name a link may give its project for the chat's line. */
const MAX_LINK_NAME = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What a link refuses with. Undo is the person's, so its words are functions, in their language; a
 * link is a plugin's call, so its refusals stay English for the plugin and the model behind it.
 */
const MESSAGE = {
  GameRequired: "Project required",
  InvalidGame: "Invalid game",
  NoEngine: "This plugin declares no engine, so it can't link a game to a project.",
  Stale: () => t("This link already changed, so there is nothing to undo."),
  NoSetUpUndo: () => t("Genex can't take back this project's set-up here, so the link stays."),
} as const;

/** A game's link as a plugin reads it: the binding plus the project's name. */
export type EngineLink = EngineBinding & { name: string };

/** Undo was asked for a link that is no longer the game's current one. */
export class EngineLinkStale extends Error {
  constructor() {
    super(MESSAGE.Stale());
    this.name = "EngineLinkStale";
  }
}

/**
 * What a link file holds: the current link, the one it replaced and whether making it set its
 * project up, or when Undo left the game with none.
 */
type LinkRecord = { link?: EngineBinding; previous?: EngineBinding; setUp?: boolean; unlinkedAt?: string };

/**
 * What the link service needs from the host: storage, game folders, the chat log, a change signal,
 * the time, and the engines the installed plugins declare.
 */
export type EngineLinkDeps = {
  root(pluginId: string): string;
  gameDir(project: string): string;
  append(record: CustomEventRecord, threadId: string): Promise<void>;
  changed(project: string): void;
  /** The game's own chat: where a link made outside a chat (the panel) is told. */
  gameThread(project: string): Promise<string>;
  now(): Date;
  /**
   * The engines the installed plugins declare (on or off), by id: a plugin links games to its own
   * (`engine.id` is its id), and a game's record names one of them.
   */
  catalog(): EngineCatalog;
  /**
   * Has the plugin take back the set-up a link of `game` made on `project` (its real path); throws
   * the plugin's reason when it refuses. Without it, such a link's Undo is refused.
   */
  undoSetUp?(pluginId: string, game: string, project: string): Promise<void>;
};

/** The services a `game-engine` plugin calls (`game.engine.*`); the host answers them through this. */
export type EngineLinkHost = {
  link(pluginId: string, binding: PluginBinding | undefined, args: unknown): Promise<EngineLink>;
  read(pluginId: string, binding: PluginBinding | undefined): Promise<EngineLink | null>;
  steps(pluginId: string, binding: PluginBinding | undefined): Promise<boolean>;
};

function gameOf(project: string | undefined): string {
  if (project === undefined) throw new Error(MESSAGE.GameRequired);
  if (!GAME_ID.test(project)) throw new Error(MESSAGE.InvalidGame);
  return project;
}

const LINK_FILE_EXTENSION = ".json";
const STUDIO_JSON = "studio.json";
const linkFile = (root: string, game: string) => path.join(root, ENGINE_LINKS_FOLDER, `${game}${LINK_FILE_EXTENSION}`);

/** A catalog of the one engine a plugin declares: what its own link records may name. */
const own = (engine: EngineDeclaration): EngineCatalog => new Map([[engine.id, engine]]);

/** The game's link record (links to the plugin's own engine only), or undefined when the plugin never linked it. */
async function readRecord(root: string, game: string, engine: EngineDeclaration): Promise<LinkRecord | undefined> {
  const raw = await readJsonIfExists<Record<string, unknown>>(linkFile(root, game)).catch(() => null);
  if (!raw || typeof raw !== "object") return undefined;
  const link = parseEngineBinding(raw, own(engine));
  const previous = parseEngineBinding(raw.previous, own(engine));
  const unlinkedAt = typeof raw.unlinkedAt === "string" ? raw.unlinkedAt : undefined;
  if (!link && !unlinkedAt) return undefined;
  const setUp = Boolean(link) && raw.setUp === true;
  return {
    ...(link ? { link } : {}),
    ...(previous ? { previous } : {}),
    ...(setUp ? { setUp } : {}),
    ...(unlinkedAt ? { unlinkedAt } : {}),
  };
}

async function writeRecord(root: string, game: string, record: LinkRecord): Promise<void> {
  await mkdir(path.join(root, ENGINE_LINKS_FOLDER), { recursive: true, mode: 0o700 });
  const body = record.link
    ? {
        ...record.link,
        ...(record.previous ? { previous: record.previous } : {}),
        ...(record.setUp ? { setUp: true } : {}),
      }
    : { unlinkedAt: record.unlinkedAt };
  await atomicWriteJson(linkFile(root, game), body);
}

/** Whether the plugin keeps any file for the game's link: a link, an Undo's `unlinkedAt`, or one it can't read. */
async function hasRecordFile(root: string, game: string): Promise<boolean> {
  return (await lstat(linkFile(root, game)).catch(() => null)) !== null;
}

/**
 * Writes the game's first link record, refusing when a record appeared meanwhile (a link made at the
 * same moment wins): written whole beside it, then linked into place, which fails on any file there.
 */
async function createRecord(root: string, game: string, record: LinkRecord): Promise<boolean> {
  const folder = path.join(root, ENGINE_LINKS_FOLDER);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const staged = path.join(folder, `.${game}.${randomUUID()}.adopt`);
  await atomicWriteJson(staged, record.link);
  try {
    await hardLink(staged, linkFile(root, game));
    return true;
  } catch {
    return false;
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}

/**
 * The link the game's studio.json mirrors for `engine` when this Genex may adopt it: of that
 * engine, its project still a regular file at exactly the real path recorded, inside the game's own
 * real folder. Undefined otherwise.
 */
async function adoptable(dir: string, engine: EngineDeclaration): Promise<EngineBinding | undefined> {
  const mirror = await readEngineBinding(dir, own(engine)).catch(() => undefined);
  if (!mirror) return undefined;
  const folder = await realpath(dir).catch(() => undefined);
  return folder && isBelow(folder, mirror.project) ? mirror : undefined;
}

/** The recorded binding while its project is still a regular file of the engine's kind at exactly that real path. */
async function holding(
  binding: EngineBinding | undefined,
  engine: EngineDeclaration,
): Promise<EngineBinding | undefined> {
  if (!binding) return undefined;
  return (await stillThere(binding, own(engine))) ? binding : undefined;
}

/**
 * The game's current link when it already names `project` with the same published ids and still
 * holds: linking it again changes nothing.
 */
async function alreadyLinked(
  current: EngineBinding | undefined,
  project: string,
  remote: EngineRemote | undefined,
  engine: EngineDeclaration,
): Promise<EngineBinding | undefined> {
  if (current?.project !== project || !sameRemote(current.remote, remote)) return undefined;
  return holding(current, engine);
}

/** The game's title as its studio.json names it, for the chat line. */
async function gameTitle(dir: string): Promise<string | undefined> {
  const meta = await readJsonIfExists<{ title?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  return typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : undefined;
}

const asLink = (binding: EngineBinding, engine: EngineDeclaration, name?: string): EngineLink => ({
  ...binding,
  name: name ?? projectName(binding.project, engine.projectFiles),
});

/** A name a link gives its project: one plain line of at most {@link MAX_LINK_NAME} characters, else none. */
function linkName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && name.length <= MAX_LINK_NAME && !CONTROL.test(name) ? name : undefined;
}

/**
 * What a link call asks for: the project file (its shape checked here, its real path when the link
 * is written), the published game's ids (ids of any other shape are dropped and the link is still
 * made), the project's name as people know it when the file's name isn't (any other shape is
 * dropped), whether the first call made it, and whether the plugin set the project up to make it.
 */
type LinkArgs = { project: string; remote?: EngineRemote; name?: string; auto: boolean; setUp: boolean };

function linkArgs(args: unknown): LinkArgs {
  const fields = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const remote = parseEngineRemote(fields.remote);
  const name = linkName(fields.name);
  return {
    project: typeof fields.project === "string" ? fields.project : "",
    ...(remote ? { remote } : {}),
    ...(name ? { name } : {}),
    auto: fields.auto === true,
    setUp: fields.setUp === true,
  };
}

/** What a new link's chat line says beside the link itself. */
type LinkedContext = {
  engine: EngineDeclaration;
  title?: string;
  previous?: EngineBinding;
  auto: boolean;
  setUp: boolean;
  name?: string;
};

/** The chat's line for a new link: the game, the project, the one it replaced, and whether it set the project up. */
function linkedRecord(
  pluginId: string,
  game: string,
  linked: EngineBinding,
  context: LinkedContext,
): CustomEventRecord {
  const { engine, title, previous, auto, setUp } = context;
  return customEventData(CustomEvent.EngineLinked, {
    pluginId,
    project: game,
    ...(title ? { title } : {}),
    engine: linked.kind,
    label: engine.label,
    file: linked.project,
    name: context.name ?? projectName(linked.project, engine.projectFiles),
    linkedAt: linked.linkedAt,
    ...(previous ? { previous: projectName(previous.project, engine.projectFiles) } : {}),
    ...(auto ? { auto } : {}),
    ...(setUp ? { setUp } : {}),
  });
}

/** What a new link's line says beside it: what the call asked, the game's title and the link it replaced. */
function linkedContext(
  engine: EngineDeclaration,
  asked: LinkArgs,
  title: string | undefined,
  previous: EngineBinding | undefined,
): LinkedContext {
  return {
    engine,
    ...(title ? { title } : {}),
    ...(previous ? { previous } : {}),
    ...(asked.name ? { name: asked.name } : {}),
    auto: asked.auto,
    setUp: asked.setUp,
  };
}

/** The record a new link writes: the link, the one it replaced, and whether making it set its project up. */
const newRecord = (link: EngineBinding, previous: EngineBinding | undefined, setUp: boolean): LinkRecord => ({
  link,
  ...(previous ? { previous } : {}),
  ...(setUp ? { setUp } : {}),
});

/** The games other than `game` the plugin keeps a link file for, by the id each file is named after. */
async function otherGames(root: string, game: string): Promise<string[]> {
  const files = await readdir(path.join(root, ENGINE_LINKS_FOLDER)).catch(() => []);
  const ids = files
    .filter((file) => file.endsWith(LINK_FILE_EXTENSION))
    .map((file) => file.slice(0, -LINK_FILE_EXTENSION.length));
  return ids.filter((id) => id !== game && GAME_ID.test(id));
}

/**
 * Whether another game's current link names `project` (both real paths, as links are stored): that
 * game builds in it too, so its set-up stays.
 */
async function linkedElsewhere(
  root: string,
  game: string,
  project: string,
  engine: EngineDeclaration,
): Promise<boolean> {
  for (const other of await otherGames(root, game))
    if ((await readRecord(root, other, engine))?.link?.project === project) return true;
  return false;
}

/** What Undo did with the set-up a link made: took it back, or kept it for another game's link. */
const SetUpUndo = { Undone: "undone", Kept: "kept" } as const;
type SetUpUndo = (typeof SetUpUndo)[keyof typeof SetUpUndo];

/**
 * Has the plugin take back the set-up the game's current link made; null for a link that set
 * nothing up, and `Kept` for a project another game's current link names, whose set-up stays.
 */
async function takeBackSetUp(
  deps: EngineLinkDeps,
  pluginId: string,
  game: string,
  { current, engine }: { current: LinkRecord; engine: EngineDeclaration },
): Promise<SetUpUndo | null> {
  if (!current.setUp || !current.link) return null;
  if (await linkedElsewhere(deps.root(pluginId), game, current.link.project, engine)) return SetUpUndo.Kept;
  if (!deps.undoSetUp) throw new Error(MESSAGE.NoSetUpUndo());
  await deps.undoSetUp(pluginId, game, current.link.project);
  return SetUpUndo.Undone;
}

/** The chat's record that Undo took the link made at `linkedAt` back, with what it restored and whose set-up it took back. */
function undoneRecord(
  pluginId: string,
  game: string,
  linkedAt: string,
  names: { restored?: string; setUpUndone?: string; setUpKept?: string },
): CustomEventRecord {
  return customEventData(CustomEvent.EngineLinkUndone, {
    pluginId,
    project: game,
    linkedAt,
    ...(names.restored ? { restored: names.restored } : {}),
    ...(names.setUpUndone ? { setUpUndone: names.setUpUndone } : {}),
    ...(names.setUpKept ? { setUpKept: names.setUpKept } : {}),
  });
}

/**
 * Adopts the link the game brought in its studio.json for `pluginId`'s engine when the plugin
 * keeps no record of the game at all: the adopted binding, else undefined.
 */
async function adoptFor(
  deps: EngineLinkDeps,
  pluginId: string,
  game: string,
  engine: EngineDeclaration,
): Promise<EngineBinding | undefined> {
  const root = deps.root(pluginId);
  if (await hasRecordFile(root, game)) return undefined;
  const mirror = await adoptable(deps.gameDir(game), engine);
  if (!mirror || !(await createRecord(root, game, { link: mirror }))) return undefined;
  deps.changed(game);
  return mirror;
}

/**
 * Adopts the link a game brought from another Genex (see the module's header), for the plugin
 * whose engine its studio.json names. A game id that isn't a plain folder name adopts nothing.
 */
async function adoptMirror(deps: EngineLinkDeps, project: string): Promise<void> {
  if (!GAME_ID.test(project)) return;
  const meta = await readJsonIfExists<{ engine?: unknown }>(path.join(deps.gameDir(project), STUDIO_JSON)).catch(
    () => null,
  );
  const kind = parseEngineBinding(meta?.engine, deps.catalog())?.kind;
  const engine = kind ? deps.catalog().get(kind) : undefined;
  if (engine) await adoptFor(deps, engine.id, project, engine);
}

/** The link service a host wires to `game.engine.*`, plus Undo. */
export function createEngineLinks(deps: EngineLinkDeps) {
  /** The engine `pluginId` declares; a plugin that declares none links nothing. */
  function engineOf(pluginId: string): EngineDeclaration {
    const engine = deps.catalog().get(pluginId);
    if (!engine) throw new Error(MESSAGE.NoEngine);
    return engine;
  }
  const record = (pluginId: string, game: string, engine: EngineDeclaration) =>
    readRecord(deps.root(pluginId), game, engine);

  async function link(pluginId: string, binding: PluginBinding | undefined, args: unknown): Promise<EngineLink> {
    const game = gameOf(binding?.project);
    const engine = engineOf(pluginId);
    const asked = linkArgs(args);
    const project = await projectFileOf(asked.project, engine);
    const before = await record(pluginId, game, engine);
    // A link that set its project up is always a new one: its line carries that set-up's Undo.
    const same = asked.setUp ? undefined : await alreadyLinked(before?.link, project, asked.remote, engine);
    if (same) return asLink(same, engine, asked.name);
    const title = await gameTitle(deps.gameDir(game));
    const written = await writeEngineBinding(deps.gameDir(game), project, engine.id, deps.catalog(), {
      now: deps.now,
      ...(asked.remote ? { remote: asked.remote } : {}),
    });
    const linked = written.binding;
    const previous = before?.link;
    try {
      await writeRecord(deps.root(pluginId), game, newRecord(linked, previous, asked.setUp));
      await deps.append(
        linkedRecord(pluginId, game, linked, linkedContext(engine, asked, title, previous)),
        binding?.threadId ?? (await deps.gameThread(game)),
      );
    } catch (error) {
      // A link the chat never heard of is no link: both records go back to what they were.
      await takeBack(pluginId, game, { binding: written.previous, record: before }).catch(() => undefined);
      throw error;
    }
    deps.changed(game);
    return asLink(linked, engine, asked.name);
  }

  /** Puts a game's studio.json binding and its link record back as they were before a link that failed part-way. */
  async function takeBack(
    pluginId: string,
    game: string,
    was: { binding: EngineBinding | undefined; record: LinkRecord | undefined },
  ): Promise<void> {
    await restoreEngineBinding(deps.gameDir(game), was.binding);
    if (was.record) await writeRecord(deps.root(pluginId), game, was.record);
    else await rm(linkFile(deps.root(pluginId), game), { force: true });
  }

  async function read(pluginId: string, binding: PluginBinding | undefined): Promise<EngineLink | null> {
    const game = gameOf(binding?.project);
    const engine = deps.catalog().get(pluginId);
    if (!engine) return null;
    const stored = (await record(pluginId, game, engine))?.link ?? (await adoptFor(deps, pluginId, game, engine));
    const current = await holding(stored, engine);
    return current ? asLink(current, engine) : null;
  }

  /**
   * Takes back the link made at `linkedAt`: the project it replaced comes back (when it still
   * holds), else the game is left with no link. A link that has changed since is refused. A link
   * that set its project up has the plugin take that back first, unless another game's current
   * link names that project; when the plugin refuses, the link stays and its reason is thrown.
   */
  async function undo(pluginId: string, project: string, linkedAt: string, threadId?: string): Promise<void> {
    const game = gameOf(project);
    const engine = deps.catalog().get(pluginId);
    const current = engine ? await record(pluginId, game, engine) : undefined;
    if (!engine || !current?.link || current.link.linkedAt !== linkedAt) throw new EngineLinkStale();
    const name = (binding: EngineBinding | undefined) =>
      binding ? projectName(binding.project, engine.projectFiles) : undefined;
    const setUp = await takeBackSetUp(deps, pluginId, game, { current, engine });
    const setUpName = setUp ? name(current.link) : undefined;
    const setUpNames = setUp === SetUpUndo.Kept ? { setUpKept: setUpName } : { setUpUndone: setUpName };
    const restored = await holding(current.previous, engine);
    await restoreEngineBinding(deps.gameDir(game), restored);
    const next: LinkRecord = restored ? { link: restored } : { unlinkedAt: deps.now().toISOString() };
    await writeRecord(deps.root(pluginId), game, next);
    if (threadId)
      await deps.append(undoneRecord(pluginId, game, linkedAt, { restored: name(restored), ...setUpNames }), threadId);
    deps.changed(game);
  }

  /** Puts the plugin's steps card in the chat the call came from; false without a chat. */
  async function steps(pluginId: string, binding: PluginBinding | undefined): Promise<boolean> {
    const game = gameOf(binding?.project);
    if (!binding?.threadId) return false;
    await deps.append(customEventData(CustomEvent.EngineSteps, { pluginId, project: game }), binding.threadId);
    return true;
  }

  /** Adopts the engine link `project` brought in its studio.json from another Genex, when this one has none. */
  const adopt = (project: string): Promise<void> => adoptMirror(deps, project);

  return { link, read, steps, undo, adopt };
}

/** The link service a host keeps. */
export type EngineLinks = ReturnType<typeof createEngineLinks>;
