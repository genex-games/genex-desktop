/**
 * What Genex can capture of a project, by its facts (manifest `observers`, API 3). An observer is
 * one of a plugin's own quiet harness tools that hands back pictures of a project holding the facts
 * it names (an editor's viewport, say): evidence a reviewer reads, and the Live view Genex shows for
 * it. Genex's own web preview is the built-in observer of every served web game. A game's observers
 * come from its facts by the same reach rule hooks use (`scopePaths`).
 *
 * Renderer-safe: no Node. Validation is `substrate/plugins/observer-manifest.ts`; the registry lists
 * a game's observers through `observersFor`.
 */
import type { RunScope } from "./custom-events.ts";
import { SECOND_MS } from "./duration.ts";
import type { PluginManifest } from "./plugins.ts";
import { CoreFact, type GameKind, scopePaths, servedFacts } from "./project-facts.ts";

/** The Live views Genex draws for an observer. Manifest values: never rename one. */
export const ObserverLive = {
  Preview: "preview",
  UnrealCard: "unreal-card",
  Stills: "stills",
  /** A plugin's own card: the status its `status` action answers, its latest shot and one button. */
  Card: "card",
} as const;
export type ObserverLive = (typeof ObserverLive)[keyof typeof ObserverLive];

/** The Live views a plugin's observer may name; `preview` is Genex's own. */
export const PLUGIN_OBSERVER_LIVE: ReadonlySet<ObserverLive> = new Set([
  ObserverLive.UnrealCard,
  ObserverLive.Stills,
  ObserverLive.Card,
]);

/** The bundled Unreal plugin's id (`src/plugins/unreal/plugin.json`): the only manifest that may name the Unreal card. */
export const UNREAL_PLUGIN_ID = "unreal";
/** The bundled Unity plugin's id. */
export const UNITY_PLUGIN_ID = "unity";

/** The bundled Unreal plugin's viewport observer (`<plugin>/<id>`): the Unreal card's shots, and Genex's own card's key. */
export const UNREAL_VIEWPORT_OBSERVER = `${UNREAL_PLUGIN_ID}/viewport`;

/** Genex's own web preview, as an observer's id and key. */
export const PREVIEW_OBSERVER = "preview";

/** The lead's proof (files it names at a finish), as an observer's id in a capture record. */
export const PROOF_OBSERVER = "proof";

/** Observer ids Genex keeps for itself: no plugin may declare one. */
export const RESERVED_OBSERVER_IDS: ReadonlySet<string> = new Set([PREVIEW_OBSERVER, PROOF_OBSERVER]);

/** The longest observer key: a plugin id and an observer id with the slash between. */
const OBSERVER_KEY_CHARS = 81;
const OBSERVER_KEY = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Whether a value names a plugin's observer by key (`<plugin>/<id>`): never a path, never Genex's own. */
export function isPluginObserverKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= OBSERVER_KEY_CHARS && OBSERVER_KEY.test(value);
}

/** The longest name an observer may give its Live view's tab (`PluginObserver.label`), in characters. */
export const OBSERVER_LABEL_CHARS = 24;

/**
 * One observer a plugin declares: its id, the facts of the projects it captures, its harness tool,
 * its Live view and the name of that view's tab when a folder has more than one (else the plugin's name).
 */
export interface PluginObserver {
  id: string;
  facts: string[];
  tool: string;
  live?: ObserverLive;
  label?: string;
  /** A card's status: an action of the manifest that asks nothing, answering a `PluginStageCard`. */
  status?: string;
}

/**
 * One observer of a game at one of its folders: `key` is `preview` or `<plugin>/<id>`, `at` the
 * fact's path it observes, `on` whether its plugin is on (Genex's preview always is).
 */
export interface ObserverRef {
  key: string;
  plugin: string | null;
  id: string;
  tool: string | null;
  live: ObserverLive | null;
  at: string;
  on: boolean;
  /** A card's status action, when the observer is one. */
  status?: string;
}

/** An installed plugin as `observersFor` reads it. */
export interface ObservingPlugin {
  id: string;
  enabled: boolean;
  manifest: Pick<PluginManifest, "observers">;
}

const ROOT = ".";

/** Paths in the order observers are listed: the game's root first, then by path. */
const rootFirst = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a === ROOT) return -1;
  if (b === ROOT) return 1;
  return a < b ? -1 : 1;
};

/** One plugin's observers of a game: one ref per folder each observer's facts reach. */
function pluginRefs({ id: plugin, enabled, manifest }: ObservingPlugin, game: GameKind): ObserverRef[] {
  return (manifest.observers ?? []).flatMap((observer) =>
    scopePaths(observer.facts, game)
      .sort(rootFirst)
      .map((at) => ({
        key: `${plugin}/${observer.id}`,
        plugin,
        id: observer.id,
        tool: observer.tool,
        live: observer.live ?? null,
        at,
        on: enabled,
        ...(observer.status ? { status: observer.status } : {}),
      })),
  );
}

/** Genex's own preview of each folder the game is served from as a web game (a game with no kind yet at its root). */
function previewRefs(game: GameKind): ObserverRef[] {
  const sites = servedFacts(game)
    .filter((fact) => fact.id === CoreFact.WebGame)
    .map((fact) => fact.path);
  return [...new Set(sites)].sort(rootFirst).map((at) => ({
    key: PREVIEW_OBSERVER,
    plugin: null,
    id: PREVIEW_OBSERVER,
    tool: null,
    live: ObserverLive.Preview,
    at,
    on: true,
  }));
}

/**
 * A game's observers: each plugin's in plugin order and then declaration order, one per folder its
 * facts reach (`scopePaths`), then Genex's preview once per served web game. Off plugins are listed
 * with `on: false` (their view still shows; they capture nothing).
 */
export function observersFor(plugins: readonly ObservingPlugin[], game: GameKind): ObserverRef[] {
  return [...plugins.flatMap((plugin) => pluginRefs(plugin, game)), ...previewRefs(game)];
}

/** The longest an observer's tool runs (less when the asker waits less: `ObserveContext.withinMs`). */
export const OBSERVE_CALL_MS = 40 * SECOND_MS;

/** Why Genex runs an observer, told to the plugin as `context.observe.why`. Wire values: never rename one. */
export const ObserveWhy = { Finish: "finish" } as const;
export type ObserveWhy = (typeof ObserveWhy)[keyof typeof ObserveWhy];

/** Where a capture's pictures came from. Persisted in `observer_capture.source`: never rename one. */
export const ObserverSource = {
  Preview: "preview",
  Plugin: "plugin",
  Checkpoint: "checkpoint",
  Proof: "proof",
} as const;
export type ObserverSource = (typeof ObserverSource)[keyof typeof ObserverSource];

/** What a plugin's tool is told when Genex runs it as one of its observers: `withinMs` is how long Genex gives this call. */
export interface ObserveContext {
  observer: string;
  runId: string;
  why: ObserveWhy;
  withinMs?: number;
}

/** One picture of a capture, kept as a file with its run. */
export interface CapturedFile {
  name: string;
  file: string;
}

/** One `observer_capture` record: an observer's pictures (and play frames in order) kept with a run; files only, never data. */
export interface ObserverCapturePayload extends RunScope {
  runId: string;
  observer: string;
  label: string;
  source: ObserverSource;
  images: CapturedFile[];
  recording?: CapturedFile[];
  note?: string;
  problem?: string;
  at?: string;
}
