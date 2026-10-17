/**
 * Each game's link to an engine project, kept by the host for a `game-engine` plugin, to a project
 * of the engine it declares (`engine` in its manifest, whose `projectFiles` say what a project file
 * is), with the published game's ids when the project lives at the engine's service. The record
 * that routes the plugin's calls lives in the plugin's own storage (`links/<game>.json`), where its
 * MCP servers read it and agents can't write; the game's studio.json gets a mirror for the brief,
 * the UI and the harness (`substrate/game-engine-binding.ts`). A link is made by real path, the
 * chat it came from (the game's own chat for a link made in the panel) gets one line with Undo, and
 * a refused link changes nothing on disk.
 */
import { mkdir, rm } from "node:fs/promises";
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
import { projectFileOf, restoreEngineBinding, stillThere, writeEngineBinding } from "../game-engine-binding.ts";

/** A game id as it names a link file: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The longest name a link may give its project for the chat's line. */
const MAX_LINK_NAME = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;

const MESSAGE = {
  GameRequired: "Project required",
  InvalidGame: "Invalid game",
  NoEngine: "This plugin declares no engine, so it can't link a game to a project.",
  Stale: "This link already changed, so there is nothing to undo.",
} as const;

/** A game's link as a plugin reads it: the binding plus the project's name. */
export type EngineLink = EngineBinding & { name: string };

/** Undo was asked for a link that is no longer the game's current one. */
export class EngineLinkStale extends Error {
  constructor() {
    super(MESSAGE.Stale);
    this.name = "EngineLinkStale";
  }
}

/** What a link file holds: the current link and the one it replaced, or when Undo left the game with none. */
type LinkRecord = { link?: EngineBinding; previous?: EngineBinding; unlinkedAt?: string };

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

const linkFile = (root: string, game: string) => path.join(root, ENGINE_LINKS_FOLDER, `${game}.json`);

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
  return { ...(link ? { link } : {}), ...(previous ? { previous } : {}), ...(unlinkedAt ? { unlinkedAt } : {}) };
}

async function writeRecord(root: string, game: string, record: LinkRecord): Promise<void> {
  await mkdir(path.join(root, ENGINE_LINKS_FOLDER), { recursive: true, mode: 0o700 });
  const body = record.link
    ? { ...record.link, ...(record.previous ? { previous: record.previous } : {}) }
    : { unlinkedAt: record.unlinkedAt };
  await atomicWriteJson(linkFile(root, game), body);
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
 * dropped), and whether the first call made it.
 */
type LinkArgs = { project: string; remote?: EngineRemote; name?: string; auto: boolean };

function linkArgs(args: unknown): LinkArgs {
  const fields = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const remote = parseEngineRemote(fields.remote);
  const name = linkName(fields.name);
  return {
    project: typeof fields.project === "string" ? fields.project : "",
    ...(remote ? { remote } : {}),
    ...(name ? { name } : {}),
    auto: fields.auto === true,
  };
}

/** The chat's line for a new link: the game, the project, and the one it replaced. */
function linkedRecord(
  pluginId: string,
  game: string,
  linked: EngineBinding,
  context: { engine: EngineDeclaration; title?: string; previous?: EngineBinding; auto: boolean; name?: string },
): CustomEventRecord {
  const { engine, title, previous, auto } = context;
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
  });
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
    const same = await alreadyLinked(before?.link, project, asked.remote, engine);
    if (same) return asLink(same, engine, asked.name);
    const title = await gameTitle(deps.gameDir(game));
    const written = await writeEngineBinding(deps.gameDir(game), project, engine.id, deps.catalog(), {
      now: deps.now,
      ...(asked.remote ? { remote: asked.remote } : {}),
    });
    const linked = written.binding;
    const previous = before?.link;
    try {
      await writeRecord(deps.root(pluginId), game, { link: linked, ...(previous ? { previous } : {}) });
      const context = {
        engine,
        ...(title ? { title } : {}),
        ...(previous ? { previous } : {}),
        ...(asked.name ? { name: asked.name } : {}),
        auto: asked.auto,
      };
      await deps.append(
        linkedRecord(pluginId, game, linked, context),
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
    const current = await holding((await record(pluginId, game, engine))?.link, engine);
    return current ? asLink(current, engine) : null;
  }

  /**
   * Takes back the link made at `linkedAt`: the project it replaced comes back (when it still
   * holds), else the game is left with no link. A link that has changed since is refused.
   */
  async function undo(pluginId: string, project: string, linkedAt: string, threadId?: string): Promise<void> {
    const game = gameOf(project);
    const engine = deps.catalog().get(pluginId);
    const current = engine ? await record(pluginId, game, engine) : undefined;
    if (!engine || !current?.link || current.link.linkedAt !== linkedAt) throw new EngineLinkStale();
    const restored = await holding(current.previous, engine);
    await restoreEngineBinding(deps.gameDir(game), restored);
    const next: LinkRecord = restored ? { link: restored } : { unlinkedAt: deps.now().toISOString() };
    await writeRecord(deps.root(pluginId), game, next);
    if (threadId)
      await deps.append(
        customEventData(CustomEvent.EngineLinkUndone, {
          pluginId,
          project: game,
          linkedAt,
          ...(restored ? { restored: projectName(restored.project, engine.projectFiles) } : {}),
        }),
        threadId,
      );
    deps.changed(game);
  }

  /** Puts the plugin's steps card in the chat the call came from; false without a chat. */
  async function steps(pluginId: string, binding: PluginBinding | undefined): Promise<boolean> {
    const game = gameOf(binding?.project);
    if (!binding?.threadId) return false;
    await deps.append(customEventData(CustomEvent.EngineSteps, { pluginId, project: game }), binding.threadId);
    return true;
  }

  return { link, read, steps, undo };
}

/** The link service a host keeps. */
export type EngineLinks = ReturnType<typeof createEngineLinks>;
