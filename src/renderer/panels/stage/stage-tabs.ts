/**
 * The stage strip's tabs: Live, Builds once there is a build to draw, Shop once the game sells
 * something, Assets, and a file opened
 * beside. A folder with more than one Live view (`liveViewsFor`: a web game and an Unreal project)
 * gets a tab per view in Live's place, each named by what it shows ("Web game", "Unreal"); a folder
 * with one keeps the bar exactly as it was. The default view's tab keeps Live's key, so the strip's
 * selector for it never changes.
 *
 * Pure, so the rules are tested without a DOM; `StageStrip` draws them and `PreviewPanel` acts on a press.
 */
import { ObserverLive, PREVIEW_OBSERVER } from "../../../shared/observers.ts";
import { type LiveView, liveViewLabel, type LivePlugin } from "../../live-views.ts";
import { type BesideTarget, besideName } from "../../open-beside.ts";
import { StageView } from "../../stage.ts";
import type { IconName } from "../../ui/icons.tsx";
import { STAGE_WORDS } from "../../words.ts";

/** A tab name longer than this is shortened in the middle, keeping this much of its start and end. */
const TAB_NAME_MAX = 26;
const TAB_NAME_HEAD = 14;
const TAB_NAME_TAIL = 10;

/**
 * What starts the key of a Live view's tab other than the default's: `live-unreal-card`,
 * `live-preview`, and for a plugin's pictures or card its observer key too,
 * `live-stills-<plugin>/<observer>`, `live-card-<plugin>/<observer>`.
 */
const LIVE_TAB_PREFIX = `${StageView.Live}-`;

/** The stage views whose tab is the view itself. */
const PLAIN_VIEWS: readonly StageView[] = [StageView.Builds, StageView.Shop, StageView.Assets, StageView.File];

/** A tab's key, also its `data-stage-action`: a stage view, or a Live view other than the default. */
export type StageTabKey =
  | StageView
  | `${typeof StageView.Live}-${ObserverLive}`
  | `${typeof StageView.Live}-${typeof ObserverLive.Stills | typeof ObserverLive.Card}-${string}`;

/** One tab of the strip's view switcher: its key, its name and, for a file opened beside, its glyph. */
export interface StageTab {
  key: StageTabKey;
  label: string;
  icon?: IconName;
}

/** What a tab press means: the stage view, and for a Live tab the observer key of its view (null for the pictures). */
export type TabChoice = { view: typeof StageView.Live; live: string | null } | { view: StageView };

/** A tab keeps its width: a long file name is shortened in the middle, the full name is the viewer's title. */
function shortName(name: string): string {
  return name.length > TAB_NAME_MAX ? `${name.slice(0, TAB_NAME_HEAD)}…${name.slice(-TAB_NAME_TAIL)}` : name;
}

/**
 * A Live view's tab key: Live's own for the default view (the first), else Live's with the view's
 * kind, and for a plugin's pictures or card (one view per observer) with its observer key as well.
 */
function liveTabKey(view: LiveView, index: number): StageTabKey {
  if (index === 0) return StageView.Live;
  if (!view.observer) return `${StageView.Live}-${view.live}`;
  if (view.live === ObserverLive.Stills || view.live === ObserverLive.Card)
    return `${StageView.Live}-${view.live}-${view.observer}`;
  return `${StageView.Live}-${view.live}`;
}

/** The same Live view: of the same kind, from the same observer. */
const sameView = (a: LiveView, b: LiveView): boolean => a.live === b.live && a.observer === b.observer;

/** Live's tabs: one named Live for a folder with one view, else one per view named by what it shows. */
function liveTabs(views: readonly LiveView[], plugins: readonly LivePlugin[]): StageTab[] {
  if (views.length < 2) return [{ key: StageView.Live, label: STAGE_WORDS.tabs.live }];
  return views.map((view, index) => ({ key: liveTabKey(view, index), label: liveViewLabel(view, plugins) }));
}

/**
 * The view switcher's tabs: Live's (one per view), Builds once there is a build to draw, Shop once
 * the game sells something, Assets, and a file opened beside.
 */
export function stageTabs({
  views,
  plugins,
  hasBuilds,
  buildsLive,
  hasShop = false,
  beside,
}: {
  views: readonly LiveView[];
  plugins: readonly LivePlugin[];
  hasBuilds: boolean;
  buildsLive: boolean;
  hasShop?: boolean;
  beside: BesideTarget | null;
}): StageTab[] {
  const builds: StageTab[] = hasBuilds
    ? [{ key: StageView.Builds, label: `${STAGE_WORDS.tabs.builds}${buildsLive ? " ●" : ""}` }]
    : [];
  const shop: StageTab[] = hasShop ? [{ key: StageView.Shop, label: STAGE_WORDS.tabs.shop }] : [];
  const file: StageTab[] = beside
    ? [{ key: StageView.File, label: shortName(besideName(beside)), icon: beside.kind === "image" ? "image" : "file" }]
    : [];
  return [
    ...liveTabs(views, plugins),
    ...builds,
    ...shop,
    { key: StageView.Assets, label: STAGE_WORDS.tabs.assets },
    ...file,
  ];
}

/** The glyph of each kind of Live view, where the folded views name it; a plugin's pictures or card shows the plugin's own picture instead. */
const LIVE_GLYPH = {
  [ObserverLive.Preview]: "window",
  [ObserverLive.UnrealCard]: "unreal",
  [ObserverLive.Stills]: "image",
  [ObserverLive.Card]: "computer",
} as const satisfies Record<ObserverLive, IconName>;

/** The Live view a tab shows: the view the press on it chooses, or none for a tab that isn't Live's. */
function tabView(key: StageTabKey, views: readonly LiveView[]): LiveView | null {
  const choice = tabChoice(key, views);
  if (!choice || !("live" in choice)) return null;
  return views.find((view) => view.observer === choice.live) ?? views[0] ?? null;
}

/** A tab's glyph where the folded views list it (`StageStrip`): a file's own, Builds' graph, Assets' tiles, a Live view's kind. */
export function tabGlyph(tab: StageTab, views: readonly LiveView[]): IconName {
  if (tab.icon) return tab.icon;
  if (tab.key === StageView.Builds) return "graph";
  if (tab.key === StageView.Assets) return "assets";
  if (tab.key === StageView.Shop) return "layers";
  return LIVE_GLYPH[tabView(tab.key, views)?.live ?? ObserverLive.Preview];
}

/** The plugin whose observer a tab's Live view is (`<plugin>/<observer>`), for its picture; null for Genex's own preview. */
export function tabPluginId(tab: StageTab, views: readonly LiveView[]): string | null {
  const view = tabView(tab.key, views);
  if (!view?.observer || view.live === ObserverLive.Preview) return null;
  return view.observer.split("/")[0] || null;
}

/** The tab drawn as current: the chosen Live view's while Live is on the stage, else the stage view's. */
export function activeStageTab(stageView: StageView, views: readonly LiveView[], chosen: LiveView): StageTabKey {
  if (stageView !== StageView.Live) return stageView;
  const index = views.findIndex((view) => sameView(view, chosen));
  return index < 0 ? StageView.Live : liveTabKey(chosen, index);
}

/** What a press on the tab `key` means, or null for a key none of the folder's tabs has. */
export function tabChoice(key: string, views: readonly LiveView[]): TabChoice | null {
  if (key === StageView.Live) return { view: StageView.Live, live: views[0]?.observer ?? null };
  if (key.startsWith(LIVE_TAB_PREFIX)) {
    const index = views.findIndex((view, at) => at > 0 && liveTabKey(view, at) === key);
    const view = views[index];
    return view ? { view: StageView.Live, live: view.observer } : null;
  }
  const plain = PLAIN_VIEWS.find((view) => view === key);
  return plain ? { view: plain } : null;
}

/** The view a web build put on the stage needs: the folder's Web game view, or null when it has none (its view stays). */
export function liveViewForBuild(views: readonly LiveView[]): LiveView | null {
  return views.find((view) => view.live === ObserverLive.Preview) ?? null;
}

/**
 * The view to remember for `game` when a web build of it goes on the stage: the stage's own game
 * by its views (its Web game view, or none when its folder has no web game), another game by
 * Genex's preview, whose views aren't read here. Null for anything that names no game.
 */
export function webBuildView(game: unknown, stageProject: string | null, views: readonly LiveView[]): string | null {
  if (typeof game !== "string" || !game) return null;
  if (game !== stageProject) return PREVIEW_OBSERVER;
  return liveViewForBuild(views)?.observer ?? null;
}
