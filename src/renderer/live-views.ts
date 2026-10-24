/**
 * Which view Live shows for the game on the stage, picked by the folder's facts from its observers
 * (`shared/observers.ts` `observersFor`) that have a view: the Unreal project the game's engine link
 * names first (Genex's own layout keeps it in `unreal/`, beside any site), then the game's root,
 * then the Unreal card, Genex's preview and a plugin's pictures in that order, then by folder. An
 * Unreal project always shows the Unreal card (Genex draws it from the facts alone: with the plugin off,
 * removed, older, or the plugin list not read yet), a web game or a game with no kind yet its
 * preview, which no plugin's pictures take over, and a folder no observer draws (Godot, Blender,
 * files of its own) the latest pictures its runs kept. A plugin's pictures count only while it is
 * on, and never from a package the person has not allowed. A folder with more than one kind of
 * view (a web game and an Unreal project) has a view of each, the first the default: the stage strip
 * shows a tab per view, named by what it shows (`liveViewLabel`), and remembers the last one chosen
 * per game (`chosenLiveView`).
 *
 * Pure, so the rules are tested without a DOM; `PreviewPanel` reads them each render.
 */
import {
  type CapturedFile,
  ObserverLive,
  type ObserverRef,
  observersFor,
  PREVIEW_OBSERVER,
  UNREAL_VIEWPORT_OBSERVER,
} from "../shared/observers.ts";
import { customRecord } from "../shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../shared/event-log.ts";
import type { PluginManifest } from "../shared/plugins.ts";
import {
  CoreFact,
  type FactRef,
  FactSource,
  type FolderHolds,
  type ProjectFactSource,
} from "../shared/project-facts.ts";
import { RunState } from "../shared/run-state.ts";
import type { HistoryEntry } from "./build-progress.ts";
import { type CaptureInfo, GraphNodeKind, type IterationNode, type RunGraph, thumbShot } from "./run-graph.ts";
import { STAGE_WORDS, savedByLead } from "./words.ts";

/** The view Live shows: which one, the folder it shows, and the observer it comes from (none for the pictures). */
export interface LiveView {
  live: ObserverLive;
  at: string;
  observer: string | null;
}

/** A fact as Live's view reads it: what and where, and who found it when known (an engine link's Unreal project wins). */
type LiveFact = FactRef & { source?: ProjectFactSource };

/** The game as Live's view reads it: its facts and what its folder holds. */
export type LiveGame = { facts?: readonly LiveFact[]; holds?: FolderHolds } | null | undefined;

/** An installed plugin as Live's view reads it: its id, name and observers, on or off, whether it was removed or is an unlisted package. */
export interface LivePlugin {
  manifest: Pick<PluginManifest, "id" | "observers"> & Partial<Pick<PluginManifest, "name">>;
  enabled: boolean;
  removed?: boolean;
  unlisted?: boolean;
}

const ROOT = ".";
/** No game on the stage: Live's own empty states belong to the preview. */
const NO_GAME: LiveView = { live: ObserverLive.Preview, at: ROOT, observer: PREVIEW_OBSERVER };
/** A folder no observer draws. */
const STILLS: LiveView = { live: ObserverLive.Stills, at: ROOT, observer: null };

/** In one folder, which view comes first: an engine's card (Unreal's, a plugin's), Genex's preview, then a plugin's pictures. */
const VIEW_RANK: Record<ObserverLive, number> = {
  [ObserverLive.UnrealCard]: 0,
  [ObserverLive.Card]: 0,
  [ObserverLive.Preview]: 1,
  [ObserverLive.Stills]: 2,
};

/** The views a plugin draws from its own observer: they show only while the plugin is on, one per observer. */
const PLUGIN_DRAWN: ReadonlySet<ObserverLive> = new Set([ObserverLive.Stills, ObserverLive.Card]);

/** The game's root before any other folder. */
const rootFirst = (a: string, b: string): number => Number(b === ROOT) - Number(a === ROOT);

/** Whether an observer's view counts: a plugin's pictures or card only while the plugin is on. */
const counts = (ref: ObserverRef): boolean => ref.live !== null && (ref.on || !PLUGIN_DRAWN.has(ref.live));

/** Genex's own Unreal card at each folder holding an Unreal project, so the card never waits on the plugin. */
function unrealCards(facts: readonly FactRef[]): ObserverRef[] {
  const paths = facts.filter((fact) => fact.id === CoreFact.UnrealProject).map((fact) => fact.path);
  return [...new Set(paths)].map((at) => ({
    key: UNREAL_VIEWPORT_OBSERVER,
    plugin: null,
    id: UNREAL_VIEWPORT_OBSERVER,
    tool: null,
    live: ObserverLive.UnrealCard,
    at,
    on: true,
  }));
}

/** The folders of the engine projects (Unreal, Godot) the game's engine link names. */
const linkedFolders = (facts: readonly LiveFact[]): string[] =>
  facts.filter((fact) => fact.source === FactSource.Link).map((fact) => fact.path);

/** The views that are an engine's card: Genex's Unreal card and a plugin's own. */
const CARDS: ReadonlySet<ObserverLive | null> = new Set([ObserverLive.UnrealCard, ObserverLive.Card]);

/** Which views are one: of Genex's own, one per kind; a plugin's pictures or card, one per observer. */
const viewIdentity = (ref: ObserverRef): string =>
  ref.live !== null && PLUGIN_DRAWN.has(ref.live) ? `${ref.live}:${ref.key}` : String(ref.live);

/**
 * Live's views of a game, the default first (see the module's header): the first-ranked observer of
 * each kind of view, so two Unreal projects make one Unreal view, and each plugin observer's
 * pictures a view of their own, named by its own label; the latest pictures when no observer draws
 * the folder.
 */
export function liveViewsFor(game: LiveGame, plugins: readonly LivePlugin[]): LiveView[] {
  if (!game) return [NO_GAME];
  const installed = plugins
    .filter((plugin) => !plugin.removed && !plugin.unlisted)
    .map(({ manifest, enabled }) => ({ id: manifest.id, enabled, manifest }));
  const facts = game.facts ?? [];
  const refs = [...observersFor(installed, { facts, holds: game.holds }), ...unrealCards(facts)].filter(counts);
  const linked = new Set(linkedFolders(facts));
  const owned = (ref: ObserverRef) => Number(CARDS.has(ref.live) && linked.has(ref.at));
  const rank = (ref: ObserverRef) => VIEW_RANK[ref.live as ObserverLive];
  const order = (a: ObserverRef, b: ObserverRef) =>
    owned(b) - owned(a) || rootFirst(a.at, b.at) || rank(a) - rank(b) || a.at.localeCompare(b.at);
  const views = new Map<string, LiveView>();
  for (const ref of refs.sort(order))
    if (ref.live && !views.has(viewIdentity(ref)))
      views.set(viewIdentity(ref), { live: ref.live, at: ref.at, observer: ref.key });
  return views.size > 0 ? [...views.values()] : [STILLS];
}

/** Live's view of a game: the first of its views (see the module's header), else its latest pictures. */
export function liveViewFor(game: LiveGame, plugins: readonly LivePlugin[]): LiveView {
  return liveViewsFor(game, plugins)[0] ?? STILLS;
}

/** The view a game's Live shows: the one remembered (an observer key) while the folder still has it, else the default. */
export function chosenLiveView(views: readonly LiveView[], remembered: unknown): LiveView {
  const chosen = typeof remembered === "string" ? views.find((view) => view.observer === remembered) : undefined;
  return chosen ?? views[0] ?? STILLS;
}

/**
 * A view's tab name: Genex's own views name themselves ("Web game", "Unreal"); a plugin's pictures
 * take its observer's `label`, else the plugin's name. The latest pictures of a folder no observer
 * draws are only ever Live's one view.
 */
export function liveViewLabel(view: LiveView, plugins: readonly LivePlugin[]): string {
  if (view.live === ObserverLive.Preview) return STAGE_WORDS.tabs.webGame;
  if (view.live === ObserverLive.UnrealCard) return STAGE_WORDS.tabs.unreal;
  const [pluginId, observerId] = view.observer?.split("/") ?? [];
  const manifest = plugins.find((plugin) => plugin.manifest.id === pluginId)?.manifest;
  const observer = manifest?.observers?.find((declared) => declared.id === observerId);
  return observer?.label ?? manifest?.name ?? STAGE_WORDS.tabs.live;
}

/** How many earlier runs Live looks back through for pictures. */
const EARLIER_RUNS_MAX = 8;

/** Whether a run's graph has the pictures a Live view shows: the Unreal card's shot, or a capture's pictures. */
export function hasLivePictures(graph: RunGraph | null, view: LiveView): boolean {
  if (!graph) return false;
  const card = view.live === ObserverLive.UnrealCard || view.live === ObserverLive.Card;
  if (card) return view.observer !== null && latestShot(graph, view.observer) !== null;
  return latestCaptures(graph, view.observer ?? undefined).length > 0;
}

/**
 * The run whose pictures Live shows: the stage's run when it has some, else the newest of the runs
 * before it (`runs`, oldest first; at most `EARLIER_RUNS_MAX` looked at) that does, so a new run
 * that took none yet hides no earlier picture. The stage's run when none has any.
 */
export function picturesGraph(
  shown: RunGraph | null,
  runs: readonly string[],
  graphOf: (runId: string) => RunGraph | null,
  view: LiveView,
): RunGraph | null {
  if (hasLivePictures(shown, view)) return shown;
  const shownRun = shown?.runId ?? null;
  const at = shownRun === null ? runs.length : runs.indexOf(shownRun);
  const earlier = runs
    .slice(0, at < 0 ? runs.length : at)
    .slice(-EARLIER_RUNS_MAX)
    .reverse();
  for (const runId of earlier) {
    const graph = graphOf(runId);
    if (hasLivePictures(graph, view)) return graph;
  }
  return shown;
}

/** A finished run's graph as `settledGraphOf` keeps it, under the key it was kept by. */
export type SettledGraphs = Map<string, { key: string; graph: RunGraph | null }>;

/**
 * `graphOf` for `picturesGraph` that projects a finished run once: its graph is kept in `cache` under
 * `keyOf(runId)` (null for a run that may still change, which is projected each time), so a new
 * batch of the thread's log does not fold every earlier run again. A finished run reopened gets
 * another key, and with it a fresh graph.
 */
export function settledGraphOf(
  cache: SettledGraphs,
  graphOf: (runId: string) => RunGraph | null,
  keyOf: (runId: string) => string | null,
): (runId: string) => RunGraph | null {
  return (runId) => {
    const key = keyOf(runId);
    if (key === null) return graphOf(runId);
    const kept = cache.get(runId);
    if (kept?.key === key) return kept.graph;
    const graph = graphOf(runId);
    cache.set(runId, { key, graph });
    return graph;
  };
}

/** The run states whose graph changes only through new records that name the run: finished, or paused. */
const SETTLED_STATES: ReadonlySet<string> = new Set([RunState.Finished, RunState.Paused]);

/**
 * The key `settledGraphOf` keeps a run's graph by: its newest record's id once the run is finished
 * or paused (a reopened or resumed run's newer records give it a new key), else null.
 */
export function settledKeys(events: readonly EventEnvelope[], history: readonly HistoryEntry[]) {
  const newest = new Map<string, string>();
  for (const event of events) {
    const runId = event.data.type === EventKind.Custom ? customRecord(event.data)?.payload.runId : null;
    if (typeof runId === "string") newest.set(runId, event.id);
  }
  const settled = new Set(history.filter((entry) => SETTLED_STATES.has(entry.state)).map((entry) => entry.runId));
  return (runId: string): string | null => (settled.has(runId) ? (newest.get(runId) ?? null) : null);
}

/** The run's newest capture (of one observer, when named), or null without one. */
export function latestCapture(graph: RunGraph | null | undefined, observer?: string): CaptureInfo | null {
  const captures = graph?.captures ?? [];
  return captures.findLast((capture) => observer === undefined || capture.observer === observer) ?? null;
}

/** The pictures of the run's newest capture (of one observer, when named); none without one. */
export function latestCaptures(graph: RunGraph | null | undefined, observer?: string): CapturedFile[] {
  return latestCapture(graph, observer)?.files ?? [];
}

/** A round's place in the log: its verdict's, else its first record's. */
const placeOf = (node: IterationNode): number => node.judgedSeq ?? node.startedSeq;

/** The newest round the lead saved itself (a save point), by its place in the log. */
function newestSavePoint(graph: RunGraph): IterationNode | null {
  let newest: IterationNode | null = null;
  for (const node of graph.nodes) {
    if (node.kind !== GraphNodeKind.Iteration || !savedByLead(node.verdictSource)) continue;
    if (!newest || placeOf(node) > placeOf(newest)) newest = node;
  }
  return newest;
}

/** The Unreal card's shot: the observer's newest capture, else the newest save point's still, as a run file path. */
export function latestShot(graph: RunGraph | null | undefined, observer: string): string | null {
  if (!graph) return null;
  const [captured] = latestCaptures(graph, observer);
  if (captured) return captured.file;
  const saved = newestSavePoint(graph);
  return saved ? (thumbShot(saved)?.path ?? null) : null;
}
