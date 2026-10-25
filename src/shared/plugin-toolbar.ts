import type { PluginInfo, PluginToolbarItem, PluginToolbarStatus } from "./plugins.ts";
import { CoreFact, type GameKind, scopeReaches } from "./project-facts.ts";
import { UiEvent } from "./ui-events.ts";

/**
 * One button contributed to the stage strip; `key` is the value of `data-plugin-toolbar`.
 * `outOfScope`: its `facts` don't reach the open game, so it shows only while its status says
 * `shown` (`visibleToolbarEntries`), but is still asked for that status.
 */
export interface PluginToolbarEntry {
  key: string;
  plugin: PluginInfo;
  item: PluginToolbarItem;
  outOfScope?: true;
}
const TONES = new Set(["ok", "warn", "err", "info"]);

/** Whether an item's `facts` reach the open game: always for an unscoped item, never without a game. */
const inScope = (item: PluginToolbarItem, project: string | null | undefined, game: GameKind | undefined): boolean =>
  !item.facts || Boolean(project && game && scopeReaches(item.facts, game));

/**
 * The buttons of the current project: enabled, installed plugins only; items that need a project
 * wait for one; an item scoped to facts that don't reach `game` comes marked `outOfScope`.
 */
export function toolbarItems(
  plugins: readonly PluginInfo[],
  project: string | null | undefined,
  game?: GameKind,
): PluginToolbarEntry[] {
  const entries: PluginToolbarEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.removed || plugin.unlisted) continue;
    for (const item of plugin.manifest.toolbar ?? []) {
      if (item.requiresProject !== false && !project) continue;
      const key = `${plugin.manifest.id}:${item.id}`;
      entries.push(inScope(item, project, game) ? { key, plugin, item } : { key, plugin, item, outOfScope: true });
    }
  }
  return entries;
}

/** The buttons the strip draws: every one in scope, and one out of scope only while its status says `shown`. */
export function visibleToolbarEntries(
  entries: readonly PluginToolbarEntry[],
  status: Readonly<Record<string, PluginToolbarStatus | undefined>>,
): PluginToolbarEntry[] {
  return entries.filter((entry) => !entry.outOfScope || status[entry.key]?.shown === true);
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const clean = String(value).replace(/\s+/g, " ").trim().slice(0, max);
  return clean || undefined;
};

/** A plugin's own `plugin.event` value addressed to its toolbar: `{kind: "toolbar", item?, …status}`. */
export function isToolbarEvent(value: unknown): value is { kind: "toolbar"; item?: unknown } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "toolbar";
}

/** Sanitize a status returned by a plugin action or pushed through a `plugin.event` of kind `toolbar`. */
export function toolbarStatusFrom(value: unknown): PluginToolbarStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>,
    status: PluginToolbarStatus = {};
  const badge = text(raw.badge, 16),
    title = text(raw.title, 120);
  if (badge !== undefined) status.badge = badge;
  if (title !== undefined) status.title = title;
  if (raw.disabled !== undefined) status.disabled = Boolean(raw.disabled);
  if (raw.attention !== undefined) status.attention = Boolean(raw.attention);
  if (raw.dot !== undefined) status.dot = Boolean(raw.dot);
  if (raw.shown !== undefined) status.shown = Boolean(raw.shown);
  if (typeof raw.tone === "string" && TONES.has(raw.tone)) status.tone = raw.tone as PluginToolbarStatus["tone"];
  return status;
}

/** The words a button says while its plugin is behind the version Studio bundles: a badge and its tooltip. */
export interface ToolbarUpdateWords {
  badge: string;
  title: (plugin: string, version: string) => string;
}

/**
 * What a plugin's buttons say while Studio bundles a newer version of it than the one installed:
 * an Update badge naming that version, which the toolbar shows over the plugin's own status. Null
 * once the update is applied or waits for the plugin's sessions to end.
 */
export function toolbarUpdateStatus(plugin: PluginInfo, words: ToolbarUpdateWords): PluginToolbarStatus | null {
  const version = updateDue(plugin);
  if (!version) return null;
  return { badge: words.badge, title: words.title(plugin.manifest.name, version) };
}

/** The bundled version the plugin's buttons send the user to update to, or null when none is due. */
const updateDue = (plugin: PluginInfo): string | null =>
  plugin.availableVersion && !plugin.pendingVersion ? plugin.availableVersion : null;

/**
 * Multiplayer stands beside Publish, only on a game built at least once (`awaitingFirstBuild`) that
 * is not multiplayer already and has something in it (an empty one has nothing to play together),
 * whose page is its own or whose engine takes Genex's multiplayer in its project: an engine's web
 * export (`webFolderOf`) is a build, made again from its project, that the chat never edits, so
 * only an engine whose project carries Genex's multiplayer (`engineMultiplayer`, Godot's addon) gets it.
 */
export const showsMultiplayer = (game: {
  publish: boolean;
  builtOnce: boolean;
  multiplayer: boolean;
  emptyGame: boolean;
  webExport: boolean;
  engineMultiplayer: boolean;
}): boolean =>
  [game.publish, game.builtOnce, !game.multiplayer, !game.emptyGame, !game.webExport || game.engineMultiplayer].every(
    Boolean,
  );

/** The engines whose project takes Genex's multiplayer itself: Godot (its plugin's addon) and Unity (its package). */
const ENGINE_MULTIPLAYER: ReadonlySet<string> = new Set([CoreFact.GodotProject, CoreFact.UnityProject]);

/** Whether the game's engine project takes Genex's multiplayer itself: a Godot or a Unity game. */
export const takesEngineMultiplayer = (game: GameKind): boolean =>
  game.facts.some((fact) => ENGINE_MULTIPLAYER.has(fact.id));

/** What Multiplayer's press does, by where Genex stands. */
export const MultiplayerPress = { SetUp: "set-up", Update: "update", Ask: "ask" } as const;
export type MultiplayerPress = (typeof MultiplayerPress)[keyof typeof MultiplayerPress];

/**
 * Multiplayer's press with `genex`, the Genex plugin while it is on (undefined while off or not
 * installed): bring Genex in, update an older one first as its own buttons do (an older Genex's
 * instructions refuse a game made from the template), or ask the game's chat.
 */
export function multiplayerPress(genex: PluginInfo | undefined): MultiplayerPress {
  if (!genex) return MultiplayerPress.SetUp;
  return updateDue(genex) ? MultiplayerPress.Update : MultiplayerPress.Ask;
}

/**
 * What a button shows: its plugin's own status, or while an update is offered the Update badge
 * over it, as a word in the quiet tone whatever look the plugin's own badge had.
 */
export function shownToolbarStatus(
  own: PluginToolbarStatus | undefined,
  update: PluginToolbarStatus | null,
): PluginToolbarStatus | undefined {
  if (!update) return own;
  const { badge: _badge, tone: _tone, dot: _dot, ...rest } = own ?? {};
  return { ...rest, ...update };
}

/** A button's tooltip lines: a dot's word first, since the dot alone doesn't say it, then the plugin's title. */
export function toolbarTip(status: PluginToolbarStatus | undefined): string[] {
  const word = status?.dot ? status.badge : undefined;
  return [word, status?.title].filter((line): line is string => Boolean(line));
}

/**
 * Whether a `game.changed` payload says the open game's own record changed (its engine link, its
 * title), which a button's status may follow. A build's file writes each carry `file` and are not
 * asked about.
 */
function gameRecordChanged(payload: { project?: string; file?: string } | undefined, project: string | null): boolean {
  if (!payload || !project || payload.file) return false;
  return payload.project === undefined || payload.project === project;
}

/**
 * What a plugin's `toolbar` event changes: one button's status in place, or — when it names no
 * button of this toolbar or carries no status — a refresh of them all. Null for anything else.
 */
function toolbarChange(
  payload: { id: string; event: unknown } | undefined,
  entries: readonly PluginToolbarEntry[],
): { key: string; update: PluginToolbarStatus } | "refresh" | null {
  const raw = payload?.event;
  if (!payload || typeof payload.id !== "string") return null;
  if (!isToolbarEvent(raw)) return null;
  const mine = entries.filter((e) => e.plugin.manifest.id === payload.id);
  if (mine.length === 0) return null;
  const target = typeof raw.item === "string" ? mine.find((e) => e.item.id === raw.item) : undefined;
  const update = toolbarStatusFrom(raw);
  return target && update ? { key: target.key, update } : "refresh";
}

/** What a UI event asks of the toolbar: a re-ask of every status, one button's new status, or nothing. */
export function toolbarReaction(
  event: UiEvent,
  entries: readonly PluginToolbarEntry[],
  project: string | null,
): { key: string; update: PluginToolbarStatus } | "refresh" | null {
  if (event.type === UiEvent.PluginsChanged) return "refresh";
  if (event.type === UiEvent.GameChanged) return gameRecordChanged(event.payload, project) ? "refresh" : null;
  // A turn's tools may have changed what a button says (an engine chosen, a project made).
  if (event.type === UiEvent.DelegationFinished) return project && event.payload.project === project ? "refresh" : null;
  return event.type === UiEvent.PluginEvent ? toolbarChange(event.payload, entries) : null;
}
