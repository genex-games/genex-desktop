/**
 * A plugin manifest's `observers` (API 3, `shared/observers.ts`): what Genex can capture of a
 * project with the facts each names, through one of the plugin's own tools only the harness calls,
 * that asks nothing and runs no host program, and the Live view it shows. Checked here and kept in
 * canonical form.
 */
import {
  OBSERVER_LABEL_CHARS,
  ObserverLive,
  PLUGIN_OBSERVER_LIVE,
  type PluginObserver,
  RESERVED_OBSERVER_IDS,
  UNREAL_PLUGIN_ID,
} from "../../shared/observers.ts";
import type { PluginManifest } from "../../shared/plugins.ts";
import { isFactId } from "../../shared/project-facts.ts";
import { quietHarnessTool } from "./hook-manifest.ts";
import { RESERVED_TOOLBAR_LABELS } from "./reserved-labels.ts";

/** How much the section may declare. */
const LIMIT = { Observers: 8, Facts: 8 } as const;

/** An observer's id: lowercase letters, digits and dashes, starting with a letter, at most 40. */
const OBSERVER_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** What a publisher reads when the section is refused. */
const MESSAGE = {
  NeedsApi3: "observers requires apiVersion 3",
  NotList: `Invalid observers (a list of at most ${LIMIT.Observers} entries)`,
  InvalidObserver: (at: string) =>
    `Invalid observers entry ${at} (id: lowercase letters, digits and dashes, starting with a letter, at most 40, not ${[...RESERVED_OBSERVER_IDS].join(" or ")}; facts: 1-${LIMIT.Facts} fact ids, each once; tool: a tool of this manifest only the harness calls, that asks nothing and runs no host program; live: ${[...PLUGIN_OBSERVER_LIVE].join(" or ")}, ${ObserverLive.UnrealCard} only for the Unreal plugin; status: for a ${ObserverLive.Card} only, an action of this manifest that asks nothing; label: 1-${OBSERVER_LABEL_CHARS} printable characters on one line, not blank, not one of the stage strip's own names)`,
  DuplicateObserver: (id: string) => `Invalid observers: ${id} is declared twice`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** How an entry is named in a refusal: its id when it has one, else its place in the list. */
const nameOf = (entry: unknown, index: number): string =>
  isRecord(entry) && typeof entry.id === "string" && entry.id ? JSON.stringify(entry.id) : `#${index + 1}`;

/** 1-8 distinct fact ids, or undefined. */
function factList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMIT.Facts) return undefined;
  if (!value.every(isFactId) || new Set(value).size !== value.length) return undefined;
  return [...value];
}

/** Whether `live` is a view this manifest may name: absent, or a plugin's view (the Unreal card only for Unreal). */
function liveAllowed(live: unknown, m: Pick<PluginManifest, "id">): live is ObserverLive | undefined {
  if (live === undefined) return true;
  if (!PLUGIN_OBSERVER_LIVE.has(live as ObserverLive)) return false;
  return live !== ObserverLive.UnrealCard || m.id === UNREAL_PLUGIN_ID;
}

/** Whether `status` fits the view: a card names an action of the manifest that asks nothing; any other view names none. */
function statusAllowed(
  status: unknown,
  live: unknown,
  m: Pick<PluginManifest, "actions">,
): status is string | undefined {
  if (live !== ObserverLive.Card) return status === undefined;
  const action = typeof status === "string" ? m.actions.find((a) => a.name === status) : undefined;
  return action !== undefined && action.confirmation === undefined;
}

/** A tab name's characters: none a control, format, line or paragraph separator (no line break, no bidi override). */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

/**
 * The names the stage strip gives Genex's own Live views when a folder has more than one (the
 * renderer's `STAGE_WORDS.tabs`, held to this list by plugin-observers.test.ts).
 */
const GENEX_VIEW_LABELS = ["Web game", "Unreal"] as const;

/**
 * Whether a label repeats, in any case, a name the stage strip already shows: its own buttons'
 * (the toolbar's reserved labels) or Genex's own Live views'.
 */
function reservedLabel(label: string): boolean {
  const lower = label.trim().toLowerCase();
  return [...RESERVED_TOOLBAR_LABELS, ...GENEX_VIEW_LABELS].some((name) => name.toLowerCase() === lower);
}

/** Whether `label` is a name this observer's tab may show: absent, or a short printable line that isn't blank or taken. */
function labelAllowed(label: unknown): label is string | undefined {
  if (label === undefined) return true;
  if (typeof label !== "string" || [...label].length > OBSERVER_LABEL_CHARS) return false;
  return PRINTABLE.test(label) && label.trim() !== "" && !reservedLabel(label);
}

/** Whether an observer's id is well formed and not one Genex keeps. */
const isObserverId = (id: unknown): id is string =>
  typeof id === "string" && OBSERVER_ID.test(id) && !RESERVED_OBSERVER_IDS.has(id);

/** One observer in canonical form, its unknown keys dropped; throws when it could not be run or shown. */
function pluginObserver(entry: unknown, index: number, m: PluginManifest, canonical: PluginManifest): PluginObserver {
  const at = nameOf(entry, index);
  if (!isRecord(entry) || !isObserverId(entry.id)) throw new Error(MESSAGE.InvalidObserver(at));
  const facts = factList(entry.facts);
  const tool = quietHarnessTool(canonical.tools, entry.tool);
  if (!facts || !tool) throw new Error(MESSAGE.InvalidObserver(at));
  if (!liveAllowed(entry.live, m) || !labelAllowed(entry.label)) throw new Error(MESSAGE.InvalidObserver(at));
  if (!statusAllowed(entry.status, entry.live, m)) throw new Error(MESSAGE.InvalidObserver(at));
  const observer: PluginObserver = { id: entry.id, facts, tool: tool.name };
  if (entry.live !== undefined) observer.live = entry.live;
  if (entry.label !== undefined) observer.label = entry.label;
  if (entry.status !== undefined) observer.status = entry.status;
  return observer;
}

/**
 * The manifest's `observers` in canonical form (keys `id, facts, tool, live, label` only), checked against
 * its canonical tools; throws on API 1 or 2, on more than eight, on a duplicate id and on anything
 * malformed.
 */
export function validateObservers(m: PluginManifest, canonical: PluginManifest): PluginObserver[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3);
  if (!Array.isArray(m.observers) || m.observers.length > LIMIT.Observers) throw new Error(MESSAGE.NotList);
  const seen = new Set<string>();
  return m.observers.map((entry, index) => {
    const observer = pluginObserver(entry, index, m, canonical);
    if (seen.has(observer.id)) throw new Error(MESSAGE.DuplicateObserver(JSON.stringify(observer.id)));
    seen.add(observer.id);
    return observer;
  });
}
