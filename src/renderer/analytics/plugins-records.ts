/**
 * What the plugins area hears without a click, mapped to event properties: an agent's plugin
 * suggestion and consent card from the log (the answer, or a card that closed unanswered, is the
 * chat area's), a plugin failing and the plugin index from main. Each
 * mapper is total and pure: whatever the record holds, only enums, switches and counts come out.
 */
import {
  type PluginChange,
  PluginChangeReason,
  type PluginConsentEvent,
  PluginFailure,
  type PluginIndexView,
  type PluginInfo,
  PluginTier,
  StudioConsentSource,
} from "../../shared/plugins.ts";
import { PluginOffer, type PluginSuggestedPayload } from "../../shared/project-tools.ts";
import { type SuggestionState, suggestionState } from "../chat/plugin-suggestion.ts";
import { type CommunityView, communityView } from "../panels/plugins/labels.ts";
import { type CountBucket, countBucket, oneOf } from "./properties.ts";
import { pluginRef, refFromList } from "./plugins-ref.ts";

/** Whose consent card asks: a plugin, a connector, or the studio itself (computer control). */
export const ConsentCardSource = {
  Plugin: "plugin",
  Connector: "connector",
  StudioDesktop: StudioConsentSource.Desktop,
  StudioComputerSetting: StudioConsentSource.ComputerSetting,
} as const;
export type ConsentCardSource = (typeof ConsentCardSource)[keyof typeof ConsentCardSource];

type ListedPlugin = Pick<PluginInfo, "manifest" | "source" | "enabled" | "removed" | "unlisted">;

const OFFERS: ReadonlySet<unknown> = new Set(Object.values(PluginOffer));
const STUDIO_SOURCES: ReadonlySet<unknown> = new Set(Object.values(StudioConsentSource));

/** `plugin_suggestion_shown`'s properties. */
export type SuggestionShownProperties = {
  plugin_ref: string;
  offer: PluginOffer | null;
  /** What the card offered when it was shown: Turn on, Install…, or already On. */
  state: SuggestionState;
};

/** A `plugin_suggested` record as an event, or null for one that names no plugin. */
export function suggestionShownProperties(
  payload: Partial<PluginSuggestedPayload>,
  list: readonly ListedPlugin[],
): SuggestionShownProperties | null {
  const id = payload.pluginId;
  if (typeof id !== "string" || !id) return null;
  const offer = OFFERS.has(payload.offer) ? (payload.offer ?? null) : null;
  return { plugin_ref: refFromList(list, id), offer, state: suggestionState(list, id) };
}

/** `consent_card_shown`'s properties. */
export type ConsentCardShownProperties = {
  source: ConsentCardSource;
  /** The plugin's reference; null for a connector (its id is the person's own) and the studio's cards. */
  plugin_ref: string | null;
  always_offered: boolean;
  chat_offered: boolean;
  has_input: boolean;
  has_export_review: boolean;
  files_bucket: CountBucket;
};

/** Whose card it is: the studio's own, an installed plugin's, or (any other id) a connector's. */
function consentSource(id: string, list: readonly ListedPlugin[]): ConsentCardSource {
  if (STUDIO_SOURCES.has(id))
    return id === StudioConsentSource.Desktop
      ? ConsentCardSource.StudioDesktop
      : ConsentCardSource.StudioComputerSetting;
  return list.some((p) => p.manifest.id === id) ? ConsentCardSource.Plugin : ConsentCardSource.Connector;
}

/** A `plugin_consent` record as `consent_card_shown`, or null unless it is a card just asked. */
export function consentCardShownProperties(
  payload: Partial<PluginConsentEvent>,
  list: readonly ListedPlugin[],
): ConsentCardShownProperties | null {
  if (payload.state !== "pending" || typeof payload.pluginId !== "string") return null;
  const source = consentSource(payload.pluginId, list);
  const plugin = list.find((p) => p.manifest.id === payload.pluginId);
  const review = payload.exportReview;
  const files = (review?.included?.length ?? 0) + (review?.excluded?.length ?? 0);
  return {
    source,
    plugin_ref: plugin && source === ConsentCardSource.Plugin ? pluginRef(payload.pluginId, plugin.source) : null,
    always_offered: payload.alwaysOffered === true,
    chat_offered: payload.chatOffered === true,
    has_input: payload.input !== undefined,
    has_export_review: review !== undefined,
    files_bucket: countBucket(files),
  };
}

/** `plugin_failed`'s properties. */
export type PluginFailedProperties = {
  plugin_ref: string;
  /** How it failed (its backend exited or failed to start, a reload was refused); null when main said nothing typed. */
  failure: PluginFailure | null;
};

/**
 * A plugin failing while it ran (`plugins.changed` with reason failed), as `plugin_failed`, its
 * failure re-checked against `PluginFailure`; null for any other change.
 */
export function pluginFailedProperties(
  change: Partial<PluginChange>,
  list: readonly ListedPlugin[],
): PluginFailedProperties | null {
  if (change.reason !== PluginChangeReason.Failed || typeof change.id !== "string") return null;
  return { plugin_ref: refFromList(list, change.id), failure: oneOf(PluginFailure, change.failure) };
}

/** `plugin_index_loaded`'s properties. */
export type IndexLoadedProperties = {
  stale: boolean;
  /** The last read failed; why is English only, so it is not sent. */
  failed: boolean;
  community_entries: number;
  community_view: CommunityView;
};

/** A read of the plugin index as `plugin_index_loaded`. */
export function indexLoadedProperties(index: PluginIndexView): IndexLoadedProperties {
  const community = index.entries.filter((entry) => entry.tier === PluginTier.Community).length;
  return {
    stale: index.stale,
    failed: Boolean(index.error),
    community_entries: community,
    community_view: communityView({ index, entries: community }),
  };
}

/** Whether two reads of the index say the same: an hourly read that changed nothing is not sent again. */
export const sameIndexRead = (a: IndexLoadedProperties | null, b: IndexLoadedProperties): boolean =>
  a !== null &&
  a.stale === b.stale &&
  a.failed === b.failed &&
  a.community_entries === b.community_entries &&
  a.community_view === b.community_view;
