/**
 * What the renderer asks a game's analytics with, checked: the sender is a browser, so every field
 * is read as unknown and either comes back as the value main will build a route or a body from, or
 * throws before anything is asked of genex.games. The IPC handlers (`ipc/game-analytics.ts`) and the
 * client (`read.ts`) both go through these, so a question is judged by one rule wherever it enters.
 */
import {
  Attribution,
  CAMPAIGN_TAG_MAX,
  CampaignField,
  type CampaignTags,
  campaignTag,
  CohortSize,
  EVENT_LIMITS,
  EVENT_NAME,
  type EventFunnelDraft,
  type EventFunnelStep,
  type EventOrigin,
  FUNNEL_DAYS_MAX,
  FUNNEL_STEPS_MAX,
  type GameReport,
  type GameReportQuery,
  isEventOrigin,
  isGameReport,
  RetentionMode,
  SegmentBy,
  SourceBreakdown,
} from "../../../shared/game-analytics.ts";
import { FUNNEL_NAME_MAX, PROPERTY_NAME_MAX } from "../../../shared/game-analytics-asks.ts";
import { isPlaySlug } from "../../../shared/play.ts";
import { type StatsPeriod, isStatsPeriod } from "../../../shared/play-stats.ts";
import { isCursor, isRecord } from "../gallery.ts";
import { line, oneOf } from "./kit.ts";

/** A malformed call from Studio's own renderer: stays English for its developer. */
const MESSAGE = {
  BadQuery: "Not a question about a game's analytics",
  BadSlug: "Not a game address",
  BadReport: "Not a report a game has",
  BadPeriod: "Not a stats period",
  BadOption: (name: string) => `Not a value of the ${name} option`,
  BadEvent: "Not an event name",
  BadProperty: "Not an event property name",
  BadOrigin: "Not a place events come from",
  BadTags: "Not the tags of a campaign link",
  BadFunnel: "Not a funnel",
  BadId: "Not a saved link or funnel",
} as const;

const isBreakdown = oneOf(SourceBreakdown);
const isAttribution = oneOf(Attribution);
const isCampaignField = oneOf(CampaignField);
const isRetentionMode = oneOf(RetentionMode);
const isCohortSize = oneOf(CohortSize);
const isSegmentBy = oneOf(SegmentBy);

/** An event name as genex.games takes one: its shape and its length. */
const isEventName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= EVENT_LIMITS.nameLength && EVENT_NAME.test(value);

/**
 * Words a person typed, trimmed: undefined when they are not text, are empty, are longer than `max`
 * or hold a character that turns text around or controls a terminal (never quietly taken out here:
 * what is sent is what was typed).
 */
function typed(value: unknown, max: number): string | undefined {
  const clean = line(value, max);
  return typeof value === "string" && clean === value.trim() ? clean : undefined;
}

/** An event property's name: a short line of plain words. */
const isPropertyName = (value: unknown): value is string =>
  typeof value === "string" && typed(value, PROPERTY_NAME_MAX) === value;

/** The game's slug, or a refusal. */
export function slugOf(value: unknown): string {
  if (!isPlaySlug(value)) throw new Error(MESSAGE.BadSlug);
  return value;
}

/** The period, or a refusal. */
export function periodOf(value: unknown): StatsPeriod {
  if (!isStatsPeriod(value)) throw new Error(MESSAGE.BadPeriod);
  return value;
}

/** Where the events come from, or a refusal. */
export function originOf(value: unknown): EventOrigin {
  if (!isEventOrigin(value)) throw new Error(MESSAGE.BadOrigin);
  return value;
}

/** A saved link's or funnel's id as genex.games hands them out, or a refusal. */
export function savedIdOf(value: unknown): string {
  if (!isCursor(value)) throw new Error(MESSAGE.BadId);
  return value;
}

function reportOf(value: unknown): GameReport {
  if (!isGameReport(value)) throw new Error(MESSAGE.BadReport);
  return value;
}

/** An option that was given, checked by `is`; undefined when it was left out. */
function option<Value>(value: unknown, is: (value: unknown) => value is Value, refusal: string): Value | undefined {
  if (value === undefined) return undefined;
  if (!is(value)) throw new Error(refusal);
  return value;
}

/** A report's question with every field checked and nothing else kept, or a refusal. */
export function reportQueryOf(value: unknown): GameReportQuery {
  if (!isRecord(value)) throw new Error(MESSAGE.BadQuery);
  const breakdown = option(value.breakdown, isBreakdown, MESSAGE.BadOption("breakdown"));
  const attribution = option(value.attribution, isAttribution, MESSAGE.BadOption("attribution"));
  const campaignBy = option(value.campaignBy, isCampaignField, MESSAGE.BadOption("campaignBy"));
  const mode = option(value.mode, isRetentionMode, MESSAGE.BadOption("mode"));
  const cohort = option(value.cohort, isCohortSize, MESSAGE.BadOption("cohort"));
  const segmentBy = option(value.segmentBy, isSegmentBy, MESSAGE.BadOption("segmentBy"));
  const event = option(value.event, isEventName, MESSAGE.BadEvent);
  const splitBy = option(value.splitBy, isPropertyName, MESSAGE.BadProperty);
  return {
    slug: slugOf(value.slug),
    report: reportOf(value.report),
    days: periodOf(value.days),
    ...(breakdown === undefined ? {} : { breakdown }),
    ...(attribution === undefined ? {} : { attribution }),
    ...(campaignBy === undefined ? {} : { campaignBy }),
    ...(mode === undefined ? {} : { mode }),
    ...(cohort === undefined ? {} : { cohort }),
    ...(segmentBy === undefined ? {} : { segmentBy }),
    ...(event === undefined ? {} : { event }),
    ...(splitBy === undefined ? {} : { splitBy }),
  };
}

/** A tag as it is saved, or undefined when what was typed is not one. */
function tagOf(value: unknown): string | undefined {
  const words = typed(value, CAMPAIGN_TAG_MAX);
  return words === undefined ? undefined : campaignTag(words) || undefined;
}

/** A tag a link may leave out: null when it was, undefined when what was typed is not a tag. */
function optionalTagOf(value: unknown): string | null | undefined {
  const blank = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  return blank ? null : tagOf(value);
}

/** A campaign link's tags as genex.games keeps them (lower case, spaces as underscores), or a refusal. */
export function campaignTagsOf(value: unknown): CampaignTags {
  if (!isRecord(value)) throw new Error(MESSAGE.BadTags);
  const source = tagOf(value.source);
  const medium = tagOf(value.medium);
  const campaign = tagOf(value.campaign);
  const content = optionalTagOf(value.content);
  const term = optionalTagOf(value.term);
  const named = source !== undefined && medium !== undefined && campaign !== undefined;
  if (!named || content === undefined || term === undefined) throw new Error(MESSAGE.BadTags);
  return { source, medium, campaign, content, term };
}

/** A funnel's step: an event, alone or with one property at one value. */
function stepOf(value: unknown): EventFunnelStep | undefined {
  if (!isRecord(value) || !isEventName(value.event)) return undefined;
  const { event } = value;
  const bare = (value.property ?? null) === null && (value.value ?? null) === null;
  if (bare) return { event, property: null, value: null };
  const text = typed(value.value, EVENT_LIMITS.textLength);
  return isPropertyName(value.property) && text !== undefined
    ? { event, property: value.property, value: text }
    : undefined;
}

/** A funnel's steps, each one checked, or undefined when the list is not one a funnel may have. */
function stepsOf(value: unknown): EventFunnelStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > FUNNEL_STEPS_MAX) return undefined;
  const steps = value.map(stepOf);
  return steps.every((step): step is EventFunnelStep => step !== undefined) ? steps : undefined;
}

/** A funnel as the creator wrote it, checked, or a refusal. */
export function funnelDraftOf(value: unknown): EventFunnelDraft {
  if (!isRecord(value)) throw new Error(MESSAGE.BadFunnel);
  const name = typed(value.name, FUNNEL_NAME_MAX);
  const steps = stepsOf(value.steps);
  const { withinDays } = value;
  const days = typeof withinDays === "number" && Number.isSafeInteger(withinDays) ? withinDays : 0;
  if (name === undefined || steps === undefined || days < 1 || days > FUNNEL_DAYS_MAX)
    throw new Error(MESSAGE.BadFunnel);
  return { name, withinDays: days, steps };
}
