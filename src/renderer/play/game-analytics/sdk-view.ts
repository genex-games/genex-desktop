/**
 * What the SDK tab shows, decided without React: the events Genex counts, the code sample, the
 * names that fill in reports, the events arriving now as rows (how long ago, name, properties,
 * player), the dropped events with the sentence that says what to send instead, and the rules
 * written from the limits genex.games sent. The clock is always the caller's: nothing here reads it.
 */
import {
  AutoEvent,
  type DroppedEvents,
  ENGAGED_SECONDS,
  EVENT_NAME,
  type EventLimits,
  EventOrigin,
  KnownEvent,
  type RecentEvent,
} from "../../../shared/game-analytics.ts";
import { formatAgo, formatSeconds } from "./kit/index.ts";
import { PAGE_WORDS } from "./page-words.ts";
import { SDK_WORDS as WORDS } from "./sdk-words.ts";
import { AnalyticsTab } from "./tabs.ts";

/** The package a game imports the SDK from. */
export const SDK_PACKAGE = "@genex-ai/embed-sdk";
/** The property the level events carry, and the one the match events carry: names the reports read. */
const LEVEL_PROPERTY = "level";
const PLAYERS_PROPERTY = "players";

const AUTO_EVENTS: ReadonlySet<string> = new Set(Object.values(AutoEvent));

/** Whether an event is one Genex counts itself, not one the game sends. */
export const isAutoEvent = (name: string): boolean => AUTO_EVENTS.has(name);

/** An event Genex counts with no code, and what it counts. */
export interface AutoRow {
  id: AutoEvent;
  detail: string;
}

/** Every event Genex counts, in the contract's order, one line each. */
export function autoRows(): AutoRow[] {
  return Object.values(AutoEvent).map((id) => ({ id, detail: WORDS.counted.events[id] }));
}

/** The code a game adds to send its own events: one `track`, one `setPlayer`, with their comments. */
export function sdkSample(): string {
  const { track, player } = WORDS.own.sample;
  return [
    `import { track, setPlayer } from "${SDK_PACKAGE}";`,
    "",
    `// ${track}`,
    `track("${KnownEvent.LevelComplete}", { level: 4, time_s: 74, deaths: 2 });`,
    "",
    `// ${player}`,
    `setPlayer({ difficulty: "hard", skin: "storm" });`,
  ].join("\n");
}

/** Names that draw a report when a game sends them: the report each fills and the property it reads. */
export interface KnownGroup {
  id: string;
  names: readonly KnownEvent[];
  /** What the names are "with": the property the report reads; null when it reads none. */
  withProperty: string | null;
  detail: string;
}

/** The known names grouped by what they do together, each group with the report it fills. */
export function knownGroups(): KnownGroup[] {
  const report = (tab: AnalyticsTab): string => PAGE_WORDS.tabs[tab];
  const withProperty = (property: string): string => WORDS.known.withProperty(property);
  return [
    {
      id: "levels",
      names: [KnownEvent.LevelStart, KnownEvent.LevelComplete, KnownEvent.LevelFail],
      withProperty: withProperty(LEVEL_PROPERTY),
      detail: WORDS.known.levels(report(AnalyticsTab.Engagement)),
    },
    {
      id: "tutorial",
      names: [KnownEvent.TutorialComplete],
      withProperty: null,
      detail: WORDS.known.tutorial(formatSeconds(ENGAGED_SECONDS, 0), report(AnalyticsTab.Acquisition)),
    },
    {
      id: "matches",
      names: [KnownEvent.MatchStart, KnownEvent.MatchEnd],
      withProperty: withProperty(PLAYERS_PROPERTY),
      detail: WORDS.known.matches(report(AnalyticsTab.Engagement)),
    },
  ];
}

/** An event that arrived, as a row of the list. */
export interface EventLine {
  /** Tells it from the others in the list, even one of the same name, player and second. */
  id: string;
  /** How long before the clock it arrived. */
  ago: string;
  name: string;
  /** Genex's own event, not the game's: the list sets it quieter. */
  automatic: boolean;
  properties: RecentEvent["properties"];
  /** Every property, one to a line: what a row that is cut short is read from. */
  summary: string;
  /** The label that names nobody ("US · computer"). */
  player: string;
}

/** The newest events as rows, in the order sent (newest first). */
export function eventLines(recent: readonly RecentEvent[], now: number): EventLine[] {
  const seen = new Map<string, number>();
  return recent.map((event) => {
    const base = `${event.at}|${event.name}|${event.player}`;
    const before = seen.get(base) ?? 0;
    seen.set(base, before + 1);
    return {
      id: before === 0 ? base : `${base}#${before}`,
      ago: formatAgo(event.at, now),
      name: event.name,
      automatic: isAutoEvent(event.name),
      properties: event.properties,
      summary: event.properties.map((property) => `${property.name} ${property.value}`).join("\n"),
      player: event.player,
    };
  });
}

/** What the list says while it has no event, for the origin shown: the published game also says when its last one came. */
export function liveEmpty(origin: EventOrigin, lastAt: string | null, now: number): string {
  if (origin === EventOrigin.Preview) return WORDS.live.emptyPreview;
  return lastAt ? WORDS.live.emptyPublishedSince(formatAgo(lastAt, now)) : WORDS.live.emptyPublished;
}

/**
 * A name the game could send in place of one that was dropped for being a bad name: lower case,
 * every run of other characters one underscore, cut to the limit. Null when that is no name
 * either (it starts with a digit, nothing of it is left) or is one Genex counts itself.
 */
export function suggestName(name: string, nameLength: number): string | null {
  const suggestion = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, nameLength)
    .replace(/_+$/, "");
  const usable = EVENT_NAME.test(suggestion) && suggestion !== name && !isAutoEvent(suggestion);
  return usable ? suggestion : null;
}

/** A dropped event, as a row: its name as the game sent it, what to send instead, and how many. */
export interface DroppedLine {
  id: string;
  name: string;
  sentence: string;
  count: string;
  /** How long before the clock the last one was dropped. */
  last: string;
}

/** The dropped events as rows, in the order sent (most dropped first). */
export function droppedLines(dropped: readonly DroppedEvents[], limits: EventLimits, now: number): DroppedLine[] {
  return dropped.map((row) => {
    const suggestion = suggestName(row.name, limits.nameLength);
    return {
      id: JSON.stringify([row.name, row.reason, row.property]),
      name: row.name,
      sentence: WORDS.dropped.reasons[row.reason]({ name: row.name, property: row.property, suggestion, limits }),
      count: WORDS.dropped.count(row.count),
      last: WORDS.dropped.last(formatAgo(row.lastAt, now)),
    };
  });
}

/** What an event is held to, as a line of the Rules: its name and the sentences that say it. */
export interface RuleLine {
  id: string;
  term: string;
  details: string[];
}

/** The rules, written from the limits genex.games sent; `used` is how many names the game has used. */
export function ruleLines(limits: EventLimits, used: number): RuleLine[] {
  const { terms } = WORDS.rules;
  const names = [WORDS.rules.names(limits.nameLength, limits.names)];
  if (used > 0) names.push(WORDS.rules.namesUsed(used, limits.names));
  return [
    { id: "names", term: terms.names, details: names },
    {
      id: "properties",
      term: terms.properties,
      details: [WORDS.rules.properties(limits.properties, limits.textLength)],
    },
    { id: "delivery", term: terms.delivery, details: [WORDS.rules.delivery(limits.batchSeconds)] },
    { id: "players", term: terms.players, details: [WORDS.rules.players] },
    { id: "kept", term: terms.kept, details: [WORDS.rules.kept(limits.keptDays)] },
  ];
}
