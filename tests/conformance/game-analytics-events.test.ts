/**
 * The Events tab of a game's analytics, end to end: what main reads of genex.games' answer (a
 * hostile body is refused or loses its bad rows, and what is not known stays null), the saved
 * funnel it reads after a save, the fixture launch's made-up answer for every period, option and
 * kind of game, what the tab derives for display, and the tab's face as React's server renderer
 * draws it from the plain renderer build.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureEvents } from "../../src/main/dev/fixture-game-analytics/fixture-events.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  gameSample,
  ownSamples,
  SampleKind,
  type SampleSource,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isCursor, isRecord } from "../../src/main/play/gallery.ts";
import { eventName, propertyName, toEventFunnel } from "../../src/main/play/game-analytics/funnels.ts";
import { funnelDraftOf } from "../../src/main/play/game-analytics/asked.ts";
import { toEventsReport } from "../../src/main/play/game-analytics/report-events.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import {
  type AnalyticsWindow,
  AutoEvent,
  EVENT_LIMITS,
  type EventFunnel,
  type EventsReport,
  FUNNEL_DAYS_MAX,
  FUNNEL_STEPS_MAX,
  FUNNELS_MAX,
  GameReport,
  type GameReportOptions,
  KnownEvent,
  PropertyKind,
} from "../../src/shared/game-analytics.ts";
import { AnalyticsSaveRefusal, FUNNEL_NAME_MAX, PROPERTY_NAME_MAX } from "../../src/shared/game-analytics-asks.ts";
import { CodedError } from "../../src/shared/errors.ts";
import { formatList, setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";
import { formatAgo, formatDay } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { EventsReportProps, ReportAnswer } from "../../src/renderer/play/game-analytics/report-props.ts";

const DAYS = 7;
const WINDOW: AnalyticsWindow = { days: DAYS, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" };

const fill = <T>(value: T, length: number): T[] => Array.from({ length }, () => value);

/** `value` with what is at `path` replaced (or taken out, for undefined), nothing else touched. */
function withAt<Value>(value: Value, path: readonly (string | number)[], next: unknown): Value {
  const [key, ...rest] = path;
  if (key === undefined) return next as Value;
  const copy = (Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) }) as Record<
    string | number,
    unknown
  >;
  copy[key] = withAt(copy[key], rest, next);
  if (rest.length === 0 && next === undefined && !Array.isArray(copy)) delete copy[key];
  return copy as Value;
}

/** A saved funnel as genex.games answers it, well formed. */
const funnelData = (): EventFunnel => ({
  id: "fn_first-purchase",
  name: "First purchase",
  withinDays: 7,
  steps: [
    { event: "level_start", property: null, value: null, players: 741 },
    { event: "level_complete", property: "level", value: "1", players: 674 },
    { event: "purchase", property: null, value: null, players: 41 },
  ],
  typicalDay: 2,
});

/** An Events report as genex.games answers it for a week, every part of it well formed. */
const eventsData = (): EventsReport => ({
  lastAt: "2026-11-17T11:59:48.000Z",
  total: 3472,
  custom: [
    { name: "level_complete", count: 2790, players: 674, firstSeenOn: "2026-10-02" },
    { name: "shop_open", count: 682, players: 246, firstSeenOn: null },
  ],
  automatic: [
    { name: AutoEvent.PlayStart, count: 3372, players: 1002, firstSeenOn: "2026-05-01" },
    { name: AutoEvent.Purchase, count: 83, players: 41, firstSeenOn: null },
  ],
  detail: {
    name: "level_complete",
    automatic: false,
    firstSeenOn: "2026-10-02",
    count: { now: 2790, before: 1605 },
    players: { now: 674, before: 399 },
    everyone: 930,
    daily: [310, 420, 380, 400, 410, 430, 440],
    splitBy: "level",
    split: [
      { value: "1", count: 1500, players: 674 },
      { value: "2", count: 1290, players: 560 },
    ],
    properties: [
      { name: "level", facts: { kind: PropertyKind.Number, min: 1, max: 8, median: 3, p90: 6 } },
      { name: "time_s", facts: { kind: PropertyKind.Number, min: 8.5, max: 1840, median: 74, p90: 212 } },
      { name: "offset_x", facts: { kind: PropertyKind.Number, min: -40, max: 12.5, median: -3, p90: 9 } },
      {
        name: "difficulty",
        facts: {
          kind: PropertyKind.Text,
          top: [
            { value: "normal", share: 0.71 },
            { value: "hard", share: 0.29 },
          ],
        },
      },
      { name: "retry", facts: { kind: PropertyKind.Flag, yes: 0.31 } },
    ],
  },
  funnels: [funnelData()],
});

describe("a saved funnel as main reads it", () => {
  it("reads every part of a well-formed funnel as it was sent", () => {
    assert.deepEqual(toEventFunnel(funnelData()), funnelData());
    const bare = { ...funnelData(), typicalDay: null };
    assert.deepEqual(toEventFunnel(bare), bare, "nobody reached the end yet: the typical day stays unknown");
    assert.equal(toEventFunnel(bare)?.typicalDay, null);
  });

  it("is not a funnel when a part is missing or is not what it should be", () => {
    const step = { event: "level_start", property: null, value: null, players: 5 };
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no id", ["id"], undefined],
      ["an id that is a number", ["id"], 14],
      ["an id that is a path", ["id"], "../links/1"],
      ["an id with a space", ["id"], "first purchase"],
      ["an id too long", ["id"], "f".repeat(65)],
      ["no name", ["name"], undefined],
      ["an empty name", ["name"], "  "],
      ["a name of only control characters", ["name"], "‮\u0007"],
      ["a name too long", ["name"], "n".repeat(FUNNEL_NAME_MAX + 1)],
      ["a name that is a list", ["name"], ["First purchase"]],
      ["no window", ["withinDays"], undefined],
      ["a window of no days", ["withinDays"], 0],
      ["a negative window", ["withinDays"], -7],
      ["a window of half a day", ["withinDays"], 1.5],
      ["a window too long", ["withinDays"], FUNNEL_DAYS_MAX + 1],
      ["a window as text", ["withinDays"], "7"],
      ["no steps", ["steps"], undefined],
      ["steps that are not a list", ["steps"], { 0: step }],
      ["an empty list of steps", ["steps"], []],
      ["more steps than a funnel has", ["steps"], fill(step, FUNNEL_STEPS_MAX + 1)],
      ["a step that is text", ["steps", 1], "level_complete"],
      ["a step with no event", ["steps", 1, "event"], undefined],
      ["a step whose event is not a name", ["steps", 0, "event"], "Level Start"],
      ["a step whose event starts with a digit", ["steps", 0, "event"], "1st_level"],
      ["a step whose event is too long", ["steps", 0, "event"], "e".repeat(EVENT_LIMITS.nameLength + 1)],
      ["a property with no value", ["steps", 1, "value"], null],
      ["a value with no property", ["steps", 1, "property"], null],
      ["a property left out", ["steps", 0, "property"], undefined],
      ["a property too long", ["steps", 1, "property"], "p".repeat(PROPERTY_NAME_MAX + 1)],
      ["a value too long", ["steps", 1, "value"], "v".repeat(EVENT_LIMITS.textLength + 1)],
      ["a value that is a number", ["steps", 1, "value"], 1],
      ["no players at a step", ["steps", 2, "players"], undefined],
      ["negative players", ["steps", 2, "players"], -1],
      ["half a player", ["steps", 0, "players"], 740.5],
      ["players as text", ["steps", 0, "players"], "741"],
      ["a typical day left out", ["typicalDay"], undefined],
      ["a negative typical day", ["typicalDay"], -1],
      ["a typical day and a half", ["typicalDay"], 1.5],
      ["a typical day after the window closed", ["typicalDay"], 8],
      ["a later step reached by more players than the one before", ["steps", 1, "players"], 742],
      ["the last step reached by more players than the first", ["steps", 2, "players"], 900],
    ];
    for (const [name, path, value] of broken)
      assert.equal(toEventFunnel(withAt(funnelData(), path, value)), null, name);
    const level = withAt(funnelData(), ["steps", 1, "players"], 741);
    assert.equal(
      toEventFunnel(level)?.steps[1]?.players,
      741,
      "a step everyone reached holds as many as the one before",
    );
    for (const body of [null, undefined, [], "funnel", 7]) assert.equal(toEventFunnel(body), null);
  });

  it("cleans the words a creator or a game wrote", () => {
    const funnel = toEventFunnel({
      ...funnelData(),
      name: " First‮ purchase\u0007 ",
      steps: [{ event: "level_complete", property: " le‏vel ", value: "‭hard\u0000", players: 3 }],
    });
    assert.equal(funnel?.name, "First purchase");
    assert.deepEqual(funnel?.steps, [{ event: "level_complete", property: "level", value: "hard", players: 3 }]);
  });

  it("knows an event's name and a property's name from anything else", () => {
    const names: Array<[unknown, string | undefined]> = [
      ["level_complete", "level_complete"],
      ["a", "a"],
      ["e".repeat(EVENT_LIMITS.nameLength), "e".repeat(EVENT_LIMITS.nameLength)],
      [" level_2 ", "level_2"],
      ["e".repeat(EVENT_LIMITS.nameLength + 1), undefined],
      ["Level_Complete", undefined],
      ["level complete", undefined],
      ["level-complete", undefined],
      ["_level", undefined],
      ["2fast", undefined],
      ["уровень", undefined],
      ["", undefined],
      [null, undefined],
      [42, undefined],
    ];
    for (const [value, expected] of names) assert.equal(eventName(value), expected, JSON.stringify(value));
    assert.equal(propertyName(" time_s "), "time_s");
    assert.equal(propertyName("Time (s)"), "Time (s)", "a property is named in plain words");
    assert.equal(propertyName("p".repeat(PROPERTY_NAME_MAX + 1)), undefined);
    assert.equal(propertyName("‮"), undefined);
    assert.equal(propertyName(7), undefined);
  });
});

describe("the Events report as main reads it", () => {
  const read = (data: unknown) => toEventsReport(data, WINDOW);

  it("reads every part of a well-formed answer as it was sent", () => {
    assert.deepEqual(read(eventsData()), eventsData());
  });

  it("is not a report when a fixed part is missing or is not what it should be", () => {
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no last time", ["lastAt"], undefined],
      ["a last time in words", ["lastAt"], "12 s ago"],
      ["a last time with no zone", ["lastAt"], "2026-11-17T11:59:48"],
      ["a last time that is a number", ["lastAt"], 1_794_916_788_000],
      ["no total", ["total"], undefined],
      ["a negative total", ["total"], -1],
      ["a fractional total", ["total"], 3472.5],
      ["a total as text", ["total"], "3,472"],
      ["a total that is not finite", ["total"], Number.POSITIVE_INFINITY],
      ["no list of the game's events", ["custom"], undefined],
      ["the game's events as a record", ["custom"], { level_complete: 2790 }],
      ["no list of Genex's events", ["automatic"], null],
      ["no detail at all", ["detail"], undefined],
      ["a detail that is a name", ["detail"], "level_complete"],
      ["a detail that is a list", ["detail"], []],
      ["a detail with no name", ["detail", "name"], undefined],
      ["a detail whose name is not an event's", ["detail", "name"], "Level Complete"],
      ["a detail whose name is too long", ["detail", "name"], "e".repeat(EVENT_LIMITS.nameLength + 1)],
      ["a detail that does not say whose it is", ["detail", "automatic"], undefined],
      ["whose it is in words", ["detail", "automatic"], "no"],
      ["a first day that is not a day", ["detail", "firstSeenOn"], "Oct 2"],
      ["a first day that does not exist", ["detail", "firstSeenOn"], "2026-02-30"],
      ["a first day left out", ["detail", "firstSeenOn"], undefined],
      ["no count", ["detail", "count"], undefined],
      ["a count that is a number", ["detail", "count"], 2790],
      ["a negative count", ["detail", "count", "now"], -1],
      ["a fractional count before", ["detail", "count", "before"], 1604.5],
      ["a count as text", ["detail", "count", "now"], "2790"],
      ["no players", ["detail", "players"], undefined],
      ["negative players before", ["detail", "players", "before"], -3],
      ["players that are null", ["detail", "players", "now"], null],
      ["nobody to divide by left out", ["detail", "everyone"], undefined],
      ["a fractional everyone", ["detail", "everyone"], 929.5],
      ["more players sent it than played at all", ["detail", "players", "now"], 931],
      ["everyone fewer than the players who sent it", ["detail", "everyone"], 673],
      ["no days", ["detail", "daily"], undefined],
      ["a day short", ["detail", "daily"], fill(400, DAYS - 1)],
      ["a day long", ["detail", "daily"], fill(400, DAYS + 1)],
      ["the days of another period", ["detail", "daily"], fill(100, 30)],
      ["a negative day", ["detail", "daily", 3], -4],
      ["half an event on a day", ["detail", "daily", 0], 0.5],
      ["a day that is null", ["detail", "daily", 6], null],
      ["days that are not a list", ["detail", "daily"], { 0: 310 }],
      ["a split by a number", ["detail", "splitBy"], 5],
      ["a split by nothing said", ["detail", "splitBy"], undefined],
      ["a split by a name too long", ["detail", "splitBy"], "p".repeat(PROPERTY_NAME_MAX + 1)],
      ["no split values", ["detail", "split"], undefined],
      ["split values that are not a list", ["detail", "split"], "1"],
      ["no properties", ["detail", "properties"], undefined],
      ["properties that are a record", ["detail", "properties"], { level: "number" }],
      ["no funnels", ["funnels"], undefined],
      ["funnels that are not a list", ["funnels"], { first: funnelData() }],
    ];
    for (const [name, path, value] of broken) assert.equal(read(withAt(eventsData(), path, value)), null, name);
    for (const body of [null, undefined, [], "events", 0]) assert.equal(read(body), null);
  });

  it("keeps what is not known as null, never as zero or as nothing", () => {
    const quiet = read({ ...eventsData(), lastAt: null, detail: null, funnels: [] }) ?? assert.fail();
    assert.equal(quiet.lastAt, null, "no event yet");
    assert.equal(quiet.detail, null, "no event to detail");
    const report = read(eventsData()) ?? assert.fail();
    assert.equal(report.custom[1]?.firstSeenOn, null);
    assert.equal(report.automatic[1]?.firstSeenOn, null);
    const unseen = read(withAt(eventsData(), ["detail", "firstSeenOn"], null)) ?? assert.fail();
    assert.equal(unseen.detail?.firstSeenOn, null);
    const whole = read(withAt(eventsData(), ["detail", "splitBy"], null)) ?? assert.fail();
    assert.equal(whole.detail?.splitBy, null);
    assert.deepEqual(whole.detail?.split, [], "an event split by nothing has no values");
    const unreached = read(withAt(eventsData(), ["funnels", 0, "typicalDay"], null)) ?? assert.fail();
    assert.equal(unreached.funnels[0]?.typicalDay, null);
    assert.deepEqual(unreached.funnels[0]?.steps[0], {
      event: "level_start",
      property: null,
      value: null,
      players: 741,
    });
  });

  it("drops the events it cannot trust and keeps the rest", () => {
    const row = (name: unknown, over: object = {}) => ({ name, count: 10, players: 4, firstSeenOn: null, ...over });
    const report =
      read({
        ...eventsData(),
        custom: [
          row(" level‮_fail\u0007 "),
          row("Level Start"),
          row("level-start"),
          row("9lives"),
          row("e".repeat(EVENT_LIMITS.nameLength + 1)),
          row(AutoEvent.Purchase),
          row(404),
          row("negative", { count: -1 }),
          row("fractional", { players: 0.5 }),
          row("as_text", { count: "10" }),
          row("first_day_in_words", { firstSeenOn: "last week" }),
          row("no_players", { players: undefined }),
          "level_complete",
          null,
          row("level_fail", { count: 99 }),
          row("shop_open"),
        ],
        automatic: [
          row(AutoEvent.PlayStart),
          row("ad_view"),
          row("level_complete"),
          row(AutoEvent.Install, { players: -2 }),
          row(AutoEvent.PlayStart, { count: 1 }),
          row(AutoEvent.Share),
        ],
      }) ?? assert.fail();
    assert.deepEqual(report.custom, [row("level_fail"), row("shop_open")]);
    assert.deepEqual(report.automatic, [row(AutoEvent.PlayStart), row(AutoEvent.Share)]);
  });

  it("drops the split values and the properties it cannot trust and keeps the rest", () => {
    const facts = { kind: PropertyKind.Number, min: 1, max: 8, median: 3, p90: 6 };
    const top = [{ value: "normal", share: 0.71 }];
    const detail = {
      ...eventsData().detail,
      split: [
        { value: " norm‮al\u0000 ", count: 7, players: 5 },
        { value: "", count: 7, players: 5 },
        { value: "v".repeat(EVENT_LIMITS.textLength + 1), count: 7, players: 5 },
        { value: 3, count: 7, players: 5 },
        { value: "negative", count: -7, players: 5 },
        { value: "fractional", count: 7, players: 2.5 },
        { value: "normal", count: 1, players: 1 },
        "hard",
        { value: "hard", count: 3, players: 2 },
      ],
      properties: [
        { name: " le‮vel ", facts },
        { name: "level", facts: { ...facts, max: 99 } },
        { name: "p".repeat(PROPERTY_NAME_MAX + 1), facts },
        { name: 7, facts },
        { name: "no_facts" },
        { name: "of_a_kind_unknown", facts: { kind: "date", first: "2026-10-02" } },
        { name: "upside_down", facts: { ...facts, min: 9 } },
        { name: "median_past_the_top", facts: { ...facts, median: 9 } },
        { name: "nine_in_ten_under_the_median", facts: { ...facts, p90: 2 } },
        { name: "not_finite", facts: { ...facts, max: Number.POSITIVE_INFINITY } },
        { name: "not_a_number", facts: { ...facts, median: Number.NaN } },
        { name: "as_text", facts: { ...facts, min: "1" } },
        { name: "no_top", facts: { kind: PropertyKind.Text } },
        { name: "share_over_one", facts: { kind: PropertyKind.Text, top: [{ value: "normal", share: 71 }] } },
        {
          name: "difficulty",
          facts: {
            kind: PropertyKind.Text,
            top: [
              ...top,
              { value: "normal", share: 0.1 },
              { value: "nega‮tive", share: -0.1 },
              { value: " ha\u0007rd ", share: 0.29 },
              { value: "", share: 0.1 },
              { value: "v".repeat(EVENT_LIMITS.textLength + 1), share: 0.1 },
              "easy",
            ],
          },
        },
        { name: "yes_over_one", facts: { kind: PropertyKind.Flag, yes: 1.2 } },
        { name: "yes_in_words", facts: { kind: PropertyKind.Flag, yes: "31%" } },
        { name: "retry", facts: { kind: PropertyKind.Flag, yes: 0 } },
      ],
    };
    const report = read({ ...eventsData(), detail }) ?? assert.fail();
    assert.deepEqual(report.detail?.split, [
      { value: "normal", count: 7, players: 5 },
      { value: "hard", count: 3, players: 2 },
    ]);
    assert.deepEqual(report.detail?.properties, [
      { name: "level", facts },
      { name: "share_over_one", facts: { kind: PropertyKind.Text, top: [] } },
      { name: "difficulty", facts: { kind: PropertyKind.Text, top: [...top, { value: "hard", share: 0.29 }] } },
      { name: "retry", facts: { kind: PropertyKind.Flag, yes: 0 } },
    ]);
    assert.equal(
      report.detail?.properties[3]?.facts.kind === PropertyKind.Flag && report.detail.properties[3].facts.yes,
      0,
    );
  });

  it("drops a funnel it cannot read and keeps the rest", () => {
    const report =
      read({
        ...eventsData(),
        funnels: [
          { ...funnelData(), id: "bad id" },
          { ...funnelData(), withinDays: 0 },
          { ...funnelData(), steps: [] },
          "fn_1",
          funnelData(),
          { ...funnelData(), name: "The same again" },
          { ...funnelData(), id: "fn_2", name: " Second‮ " },
        ],
      }) ?? assert.fail();
    assert.deepEqual(
      report.funnels.map((funnel) => [funnel.id, funnel.name]),
      [
        ["fn_first-purchase", "First purchase"],
        ["fn_2", "Second"],
      ],
    );
  });

  it("keeps no more rows than a page can show", () => {
    const many = 5000;
    const names = Array.from({ length: many }, (_, index) => `event_${index}`);
    const detail = {
      ...eventsData().detail,
      split: names.map((value) => ({ value, count: 1, players: 1 })),
      properties: names.map((name) => ({ name, facts: { kind: PropertyKind.Flag, yes: 0.5 } })),
    };
    const report =
      read({
        ...eventsData(),
        custom: names.map((name) => ({ name, count: 1, players: 1, firstSeenOn: null })),
        automatic: fill(Object.values(AutoEvent), 50)
          .flat()
          .map((name) => ({ name, count: 1, players: 1, firstSeenOn: null })),
        detail,
        funnels: names.map((id) => ({ ...funnelData(), id })),
      }) ?? assert.fail();
    assert.equal(report.custom.length, EVENT_LIMITS.names, "as many names as a game may use");
    assert.equal(report.custom[0]?.name, "event_0", "the first ones sent");
    assert.equal(report.automatic.length, Object.values(AutoEvent).length, "each of Genex's own events once");
    assert.ok((report.detail?.split.length ?? many) <= 50, `${report.detail?.split.length} split values`);
    assert.equal(report.detail?.properties.length, EVENT_LIMITS.properties);
    assert.equal(report.funnels.length, FUNNELS_MAX);
    const wordy = withAt(
      eventsData(),
      ["detail", "properties"],
      [
        {
          name: "difficulty",
          facts: { kind: PropertyKind.Text, top: names.map((value) => ({ value, share: 0.0001 })) },
        },
      ],
    );
    const facts = read(wordy)?.detail?.properties[0]?.facts;
    assert.ok(facts?.kind === PropertyKind.Text && facts.top.length <= 20, "a property's most common values only");
  });
});

describe("the fixture account's Events report", () => {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const author = { id: "fx-simeon-m", name: "Simeon M" };
  const items = [
    { slug: "lost-cathedral", title: "Lost Cathedral", thumbnailUrl: null, playsCount: 2682, online: null, author },
    { slug: "stick-steel", title: "Stick & Steel", thumbnailUrl: null, playsCount: 2431, online: 6, author },
    {
      slug: "skate",
      title: "SKATE",
      thumbnailUrl: null,
      playsCount: 5285,
      online: 8,
      author,
      builds: [{ platform: "macos" }],
    },
  ];
  /** The fixture games by the kind of game each is. */
  const SLUG = {
    [SampleKind.Rich]: "skate",
    [SampleKind.Steady]: "lost-cathedral",
    [SampleKind.Young]: "stick-steel",
  } as const satisfies Record<SampleKind, string>;
  const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
  const full = fixtureAccountToken(FixtureAccount.Full);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full) => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  /** The fixture's Events answer to a question, as it is sent and as the real parser reads it. */
  const ask = (slug: string, days: StatsPeriod, options: GameReportOptions = {}, token = full) => {
    const query = { slug, report: GameReport.Events, days, ...options };
    const name = `${slug} over ${days} days ${JSON.stringify(options)}`;
    const answer = createFixtureGameAnalytics({ now: () => NOW }).answer(
      reportRoute(query),
      { method: "GET", token },
      catalog,
    );
    assert.equal(answer?.status, 200, name);
    const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${name} does not read`);
    if (read.report !== GameReport.Events) assert.fail(name);
    const sent = isRecord(answer?.body) ? answer.body.data : undefined;
    return { read, data: read.data, sent: JSON.parse(JSON.stringify(sent)), name };
  };
  const eventsOf = (slug: string, days: StatsPeriod, options: GameReportOptions = {}) => ask(slug, days, options).data;
  const kinds = Object.values(SampleKind);

  it("answers a report the real parser reads, for every kind of game and period, exactly as it was made", () => {
    for (const kind of kinds) {
      for (const days of STATS_PERIODS) {
        const { data, sent, name } = ask(SLUG[kind], days);
        assert.deepEqual(data, sent, `${name} loses nothing`);
        assert.equal(sampleOf(SLUG[kind], days).kind, kind, name);
        assert.ok(data.automatic.length > 0, `${name}: Genex counts something`);
        if (data.detail) assert.equal(data.detail.daily.length, days, name);
      }
    }
  });

  it("details any listed event, split by any of its properties, for every kind of game and period", () => {
    let asked = 0;
    for (const kind of kinds) {
      for (const days of STATS_PERIODS) {
        const listed = eventsOf(SLUG[kind], days);
        for (const row of [...listed.custom, ...listed.automatic]) {
          const { data, sent, name } = ask(SLUG[kind], days, { event: row.name });
          const detail = data.detail ?? assert.fail(`${name}: no detail`);
          assert.deepEqual(data, sent, `${name} loses nothing`);
          assert.equal(detail.name, row.name, name);
          assert.equal(detail.automatic, listed.automatic.includes(row), name);
          assert.deepEqual(
            [detail.count.now, detail.players.now],
            [row.count, row.players],
            `${name}: its row's numbers`,
          );
          assert.equal(detail.firstSeenOn, row.firstSeenOn, name);
          assert.equal(sum(detail.daily), detail.count.now, `${name}: the days sum to the count`);
          assert.equal(detail.splitBy, detail.properties[0]?.name ?? null, `${name}: split by its first property`);
          for (const property of detail.properties) {
            const split = ask(SLUG[kind], days, { event: row.name, splitBy: property.name });
            const by = split.data.detail ?? assert.fail(`${split.name}: no detail`);
            assert.deepEqual(split.data, split.sent, `${split.name} loses nothing`);
            assert.deepEqual([by.name, by.splitBy], [row.name, property.name], split.name);
            assert.ok(by.split.length > 0, `${split.name}: has values`);
            assert.equal(
              sum(by.split.map((value) => value.count)),
              by.count.now,
              `${split.name}: values sum to the count`,
            );
            assert.deepEqual(
              by.split.map((value) => value.count),
              by.split.map((value) => value.count).toSorted((a, b) => b - a),
              `${split.name}: most first`,
            );
            assert.ok(
              by.split.every((value) => value.players <= value.count && value.players <= by.players.now),
              `${split.name}: no more players than events, or than the event has`,
            );
            asked += 1;
          }
        }
      }
    }
    assert.ok(asked > 60, `${asked} splits asked`);
  });

  it("gives its richest game the events the page was designed with, over 30 days", () => {
    const data = eventsOf("skate", 30);
    assert.deepEqual(
      data.custom.map((row) => [row.name, row.count, row.players]),
      [
        ["lantern_lit", 96_540, 6870],
        [KnownEvent.LevelStart, 41_260, 7410],
        [KnownEvent.LevelComplete, 27_930, 6740],
        ["powerup_used", 22_310, 3940],
        [KnownEvent.LevelFail, 18_470, 4880],
        ["shop_open", 6820, 2460],
        ["skin_equipped", 2140, 1120],
        [KnownEvent.TutorialComplete, 1930, 1930],
      ],
    );
    assert.equal(data.total, 217_400, "the game's own events");
    assert.equal(data.total, sum(data.custom.map((row) => row.count)));
    assert.equal(data.lastAt, new Date(NOW - 12_000).toISOString(), "twelve seconds ago");
    assert.equal(data.detail?.name, data.custom[0]?.name, "the first of its own, when none is asked for");

    const detail = eventsOf("skate", 30, { event: KnownEvent.LevelComplete }).detail ?? assert.fail();
    assert.deepEqual([detail.count.now, detail.players.now, detail.everyone], [27_930, 6740, 9300]);
    assert.equal(Math.round((detail.count.now / detail.count.before - 1) * 100), 74, "the design's +74%");
    assert.equal(Math.round((detail.players.now / detail.players.before - 1) * 100), 69, "the design's +69%");
    assert.equal(detail.automatic, false);
    assert.deepEqual(
      detail.properties.map((property) => [property.name, property.facts.kind]),
      [
        ["level", PropertyKind.Number],
        ["time_s", PropertyKind.Number],
        ["deaths", PropertyKind.Number],
        ["lantern_count", PropertyKind.Number],
        ["difficulty", PropertyKind.Text],
      ],
    );
    assert.deepEqual(detail.properties[0]?.facts, { kind: PropertyKind.Number, min: 1, max: 8, median: 3, p90: 6 });
    assert.deepEqual(detail.properties[4]?.facts, {
      kind: PropertyKind.Text,
      top: [
        { value: "normal", share: 0.71 },
        { value: "hard", share: 0.29 },
      ],
    });
    assert.equal(detail.splitBy, "level");
    assert.deepEqual(
      detail.split.map((value) => [value.value, value.count]),
      [
        ["1", 7330],
        ["2", 5960],
        ["3", 4880],
        ["4", 3010],
        ["5", 2450],
        ["6", 1890],
        ["7", 1480],
        ["8", 930],
      ],
    );
    assert.equal(detail.split[0]?.players, 6740, "everyone who finished a level finished the first");
    const difficulty = eventsOf("skate", 30, { event: KnownEvent.LevelComplete, splitBy: "difficulty" }).detail;
    assert.deepEqual(
      difficulty?.split.map((value) => [value.value, Math.round((value.count / 27_930) * 100)]),
      [
        ["normal", 71],
        ["hard", 29],
      ],
    );
  });

  it("keeps one saved funnel, First purchase, under the same id over every period", () => {
    const funnel = eventsOf("skate", 30).funnels[0] ?? assert.fail("no funnel");
    assert.equal(eventsOf("skate", 30).funnels.length, 1);
    assert.equal(funnel.name, "First purchase");
    assert.ok(isCursor(funnel.id), "an id main takes back for a removal");
    assert.deepEqual(
      funnel.steps.map((step) => [step.event, step.property, step.value, step.players]),
      [
        [KnownEvent.LevelStart, null, null, 7410],
        [KnownEvent.LevelComplete, "level", "1", 6740],
        ["shop_open", null, null, 2460],
        [AutoEvent.Purchase, null, null, 412],
      ],
    );
    assert.deepEqual([funnel.withinDays, funnel.typicalDay], [7, 2]);
    for (const days of STATS_PERIODS) {
      const [other] = eventsOf("skate", days).funnels;
      assert.equal(other?.id, funnel.id, `${days} days`);
      const reached = other?.steps.map((step) => step.players) ?? [];
      assert.deepEqual(
        reached,
        reached.toSorted((a, b) => b - a),
        `${days} days: fewer players at each step`,
      );
      assert.equal(reached.at(-1), sampleOf("skate", days).payers.now, `${days} days: the last step is who paid`);
    }
    for (const kind of [SampleKind.Steady, SampleKind.Young])
      assert.deepEqual(eventsOf(SLUG[kind], 30).funnels, [], `${kind}: no events of its own to follow`);
  });

  it("counts what Genex counts by itself from the game's sample, so it agrees with the other reports", () => {
    for (const kind of kinds) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(SLUG[kind], days);
        const name = `${SLUG[kind]} over ${days} days`;
        const data = eventsOf(SLUG[kind], days);
        const rowOf = (event: AutoEvent) => data.automatic.find((row) => row.name === event);
        assert.deepEqual(
          [rowOf(AutoEvent.PlayStart)?.count, rowOf(AutoEvent.PlayStart)?.players],
          [sample.plays.now, sample.players.now],
          `${name}: a play_start for each play`,
        );
        assert.equal(rowOf(AutoEvent.Purchase)?.count ?? 0, sample.purchases.now, `${name}: purchases`);
        assert.equal(rowOf(AutoEvent.Purchase)?.players ?? 0, sample.payers.now, `${name}: who paid`);
        assert.equal(rowOf(AutoEvent.Install)?.count ?? 0, sample.installs?.now ?? 0, `${name}: installs`);
        assert.ok((rowOf(AutoEvent.PlayEnd)?.count ?? 0) <= sample.plays.now, `${name}: no more ends than plays`);
        assert.deepEqual(
          data.automatic.map((row) => row.count),
          data.automatic.map((row) => row.count).toSorted((a, b) => b - a),
          `${name}: most counted first`,
        );
        const start = eventsOf(SLUG[kind], days, { event: AutoEvent.PlayStart }).detail ?? assert.fail(name);
        assert.deepEqual(start.daily, sample.plays.daily, `${name}: play_start per day is plays per day`);
        assert.deepEqual(start.count, { now: sample.plays.now, before: sample.plays.before }, name);
        assert.equal(start.everyone, sample.players.now, `${name}: everyone who played`);
        assert.equal(start.automatic, true, name);
        const end = eventsOf(SLUG[kind], days, { event: AutoEvent.PlayEnd }).detail ?? assert.fail(name);
        const seconds = end.properties.find((property) => property.name === "seconds")?.facts;
        assert.ok(seconds?.kind === PropertyKind.Number, name);
        assert.equal(seconds.median, sample.medianPlaySeconds.now, `${name}: the median play is one number`);
      }
    }
  });

  it("has games with only what Genex counts: a young one, and one whose SDK is too old to send events", () => {
    for (const kind of [SampleKind.Young, SampleKind.Steady]) {
      for (const days of STATS_PERIODS) {
        const data = eventsOf(SLUG[kind], days);
        assert.deepEqual(data.custom, [], `${kind}, ${days} days`);
        assert.deepEqual([data.lastAt, data.total, data.detail], [null, 0, null], `${kind}, ${days} days`);
      }
    }
    const young = eventsOf(SLUG[SampleKind.Young], 30);
    const names = young.automatic.map((row) => row.name);
    assert.ok(names.includes(AutoEvent.PlayStart) && names.includes(AutoEvent.GameReady), "somebody played");
    assert.ok(!names.includes(AutoEvent.Purchase), "nobody paid yet");
    assert.ok(!names.includes(AutoEvent.Install), "no app build");
    const start = eventsOf(SLUG[SampleKind.Young], 30, { event: AutoEvent.PlayStart }).detail ?? assert.fail();
    assert.deepEqual(start.count, { now: 20, before: 0 });
    assert.equal(sum(start.daily.slice(0, -3)), 0, "nothing before it was published");
  });

  it("answers what it shows by default for an event or a property it does not have", () => {
    const usual = eventsOf("skate", 30);
    assert.deepEqual(eventsOf("skate", 30, { event: "no_such_event" }), usual);
    assert.deepEqual(eventsOf("skate", 30, { splitBy: "no such property" }), usual);
    const complete = eventsOf("skate", 30, { event: KnownEvent.LevelComplete });
    assert.deepEqual(eventsOf("skate", 30, { event: KnownEvent.LevelComplete, splitBy: "color" }), complete);
    assert.deepEqual(eventsOf(SLUG[SampleKind.Young], 7, { event: KnownEvent.LevelStart }).detail, null);
  });

  it("is silent where nobody played: no events, no detail, and a funnel nobody entered", () => {
    const quiet = fixtureEvents(sampleOf("skate", 7, FixtureAccount.Quiet), {});
    assert.deepEqual([quiet.custom, quiet.automatic, quiet.detail], [[], [], null]);
    assert.deepEqual([quiet.lastAt, quiet.total], [null, 0]);
    assert.deepEqual(
      quiet.funnels.map((funnel) => [funnel.id, funnel.typicalDay, funnel.steps.map((step) => step.players)]),
      [["fx-funnel-first-purchase", null, [0, 0, 0, 0]]],
    );
    assert.deepEqual(toEventsReport(JSON.parse(JSON.stringify(quiet)), sampleOf("skate", 7).window), quiet);
    const month = fixtureEvents(sampleOf("skate", 30, FixtureAccount.Quiet), {});
    assert.equal(month.custom.length, 8, "it sent events before it went quiet");
    assert.equal(month.lastAt, "2026-11-03T21:14:09.000Z", "the last one on its last busy day");
  });

  it("is the same answer for the same game on the same day, and its own for each game", () => {
    assert.deepEqual(eventsOf("skate", 30), eventsOf("skate", 30));
    const placeOf = (kind: SampleKind) =>
      eventsOf(SLUG[kind], 30, { event: AutoEvent.PlayStart }).detail?.properties.find(
        (property) => property.name === "place",
      )?.facts;
    assert.notDeepEqual(placeOf(SampleKind.Steady), placeOf(SampleKind.Young), "each game's own details");
  });
});

// ── What the tab derives and draws ────────────────────────────────────────────────────────────

type Answer = ReportAnswer<typeof GameReport.Events>;

/** What the tests reach in the renderer build: the tab's view model, form model, parts and React's server renderer. */
interface EventsBundle {
  view: typeof import("../../src/renderer/play/game-analytics/events-view.ts");
  DeltaKind: typeof import("../../src/renderer/play/game-analytics/kit/index.ts").DeltaKind;
  form: typeof import("../../src/renderer/play/game-analytics/events-funnel-form.ts");
  EventsReport: (props: EventsReportProps) => ReactElement;
  EventsFace: (props: Record<string, unknown>) => ReactElement;
  EventsListSection: (props: Record<string, unknown>) => ReactElement;
  FunnelEditor: (props: Record<string, unknown>) => ReactElement;
  RemoveAsk: (props: Record<string, unknown>) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The Events tab as the plain renderer build compiles it. */
async function eventsBundle(): Promise<EventsBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/events-view.ts";',
        'export { DeltaKind } from "./src/renderer/play/game-analytics/kit/index.ts";',
        'export * as form from "./src/renderer/play/game-analytics/events-funnel-form.ts";',
        'export { EventsFace, EventsReport } from "./src/renderer/play/game-analytics/EventsReport.tsx";',
        'export { EventsListSection } from "./src/renderer/play/game-analytics/events-list.tsx";',
        'export { FunnelEditor } from "./src/renderer/play/game-analytics/events-funnel-editor.tsx";',
        'export { RemoveAsk } from "./src/renderer/play/game-analytics/events-funnels.tsx";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("the Events tab's view and face", () => {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  let bundle: EventsBundle;
  before(async () => {
    bundle = await eventsBundle();
  });
  // The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
  beforeEach(() => setLocale(Locale.Japanese, {}));
  after(() => setLocale(Locale.English, {}));

  const sourceOf = (kind: SampleKind): SampleSource => ({
    slug: "lantern-run",
    title: "Lantern Run",
    coverUrl: null,
    plays: 30_000,
    playingNow: 38,
    hasAppBuild: kind === SampleKind.Rich,
    kind,
    dormant: false,
  });
  /** The fixture's answer for a game, as it crosses the wire and the real parser. */
  function answerOf(kind: SampleKind, options: GameReportOptions = {}, days: StatsPeriod = 30): Answer {
    const sample = gameSample(sourceOf(kind), days, NOW);
    const data = toEventsReport(JSON.parse(JSON.stringify(fixtureEvents(sample, options))), sample.window);
    assert.ok(data, `the ${kind} game's ${days} days parse`);
    return { report: GameReport.Events, game: sample.game, window: sample.window, data };
  }
  const withData = (answer: Answer, data: Partial<EventsReport>): Answer => ({
    ...answer,
    data: { ...answer.data, ...data },
  });
  const viewOf = (answer: Answer, options: GameReportOptions = {}, query = "", now = NOW) =>
    bundle.view.eventsView(answer, options, query, now);
  const words = (markup: string): string =>
    markup
      .replace(/<[^>]*>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const sectionOf = (markup: string, id: string): string =>
    new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";
  const noop = (): void => {};
  const pending = async (): Promise<never> => assert.fail("nothing is saved by drawing");
  const props = (answer: Answer, options: GameReportOptions = {}): EventsReportProps => ({
    slug: answer.game.slug,
    refreshing: false,
    stale: false,
    now: NOW,
    onOpenTab: noop,
    answer,
    options,
    onOptions: noop,
    onSaveFunnel: pending,
    onRemoveFunnel: pending,
  });
  const draw = (answer: Answer, options: GameReportOptions = {}): string =>
    bundle.renderToStaticMarkup(bundle.createElement(bundle.EventsReport, props(answer, options)));

  /** The function a prop of an element holds. */
  function handler(own: Record<string, unknown> | undefined, name: string): (argument: unknown) => void {
    const held = own?.[name];
    if (typeof held !== "function") assert.fail(`no ${name}`);
    return (argument) => held(argument);
  }

  /** The element tree under `node`, every element that `matches`. */
  function findAll(node: unknown, matches: (props: Record<string, unknown>) => boolean): Record<string, unknown>[] {
    if (Array.isArray(node)) return node.flatMap((child) => findAll(child, matches));
    if (!isRecord(node) || !isRecord(node.props)) return [];
    const own = matches(node.props) ? [node.props] : [];
    return [...own, ...findAll(node.props.children, matches)];
  }

  describe("the strip", () => {
    it("tells that events arrive, when the last came and how many the game's own are", () => {
      const strip = viewOf(answerOf(SampleKind.Rich)).strip;
      assert.deepEqual(strip, {
        arrival: bundle.view.Arrival.Arriving,
        status: "Receiving your events",
        last: `Last one ${formatAgo(new Date(NOW - 12_000).toISOString(), NOW)}`,
        counted: "217,400 events in this period, under 8 names",
      });
    });

    it("judges arrival by the clock it is given and nothing else", () => {
      const { arrivalOf, Arrival } = bundle.view;
      const last = "2026-11-17T12:00:00.000Z";
      const at = Date.parse(last);
      assert.equal(arrivalOf(last, at + 15 * 60_000), Arrival.Arriving, "on the edge");
      assert.equal(arrivalOf(last, at + 15 * 60_000 + 1), Arrival.Quiet);
      assert.equal(arrivalOf(last, at - 5000), Arrival.Arriving, "a clock behind the server's");
      assert.equal(arrivalOf(null, at), Arrival.None);
      assert.equal(arrivalOf("not a time", at), Arrival.Quiet, "never arriving on a time that cannot be read");
      const later = viewOf(answerOf(SampleKind.Rich), {}, "", NOW + 3_600_000).strip;
      assert.equal(later.arrival, Arrival.Quiet);
      assert.equal(later.status, "No event in a while");
      assert.equal(later.last, `Last one ${formatAgo(new Date(NOW - 12_000).toISOString(), NOW + 3_600_000)}`);
    });

    it("says only what is known for a game that sends no events of its own", () => {
      const strip = viewOf(answerOf(SampleKind.Young)).strip;
      assert.deepEqual(strip, {
        arrival: bundle.view.Arrival.None,
        status: "Your game sends no events yet",
        last: null,
        counted: null,
      });
    });

    it("counts one event and one name in the singular", () => {
      const one = withData(answerOf(SampleKind.Rich), {
        total: 1,
        custom: [{ name: "level_start", count: 1, players: 1, firstSeenOn: null }],
      });
      assert.equal(viewOf(one).strip.counted, "1 event in this period, under 1 name");
    });
  });

  describe("the list", () => {
    it("gives each event's count, players and events per player, the game's own first", () => {
      const { list } = viewOf(answerOf(SampleKind.Rich));
      assert.deepEqual(
        list.custom.slice(0, 3).map((row) => [row.name, row.count, row.players, row.perPlayer?.toFixed(2)]),
        [
          ["lantern_lit", 96_540, 6870, "14.05"],
          ["level_start", 41_260, 7410, "5.57"],
          ["level_complete", 27_930, 6740, "4.14"],
        ],
      );
      assert.equal(list.noOwn, false);
      assert.equal(list.sdkReady, true);
      const sample = gameSample(sourceOf(SampleKind.Rich), 30, NOW);
      const auto = (name: string) => list.automatic.find((row) => row.name === name);
      assert.equal(auto(AutoEvent.PlayStart)?.count, sample.plays.now, "Genex's count of plays is the sample's");
      assert.equal(auto(AutoEvent.Purchase)?.players, sample.payers.now);
    });

    it("keeps a per-player number unknown where nobody sent the event", () => {
      const odd = withData(answerOf(SampleKind.Rich), {
        custom: [{ name: "level_start", count: 5, players: 0, firstSeenOn: null }],
      });
      assert.equal(viewOf(odd).list.custom[0]?.perPlayer, null);
    });

    it("filters by name as it is typed, in either case and with spaces for underscores", () => {
      const answer = answerOf(SampleKind.Rich);
      const names = (query: string) => {
        const { list } = viewOf(answer, {}, query);
        return [...list.custom, ...list.automatic].map((row) => row.name);
      };
      assert.deepEqual(names("level"), ["level_start", "level_complete", "level_fail"]);
      assert.deepEqual(names("  LEVEL c "), ["level_complete"]);
      assert.deepEqual(names("play"), ["play_start", "play_end"]);
      assert.equal(names("").length, answer.data.custom.length + answer.data.automatic.length);
      assert.equal(viewOf(answer, {}, "level").list.noMatch, false);
      const none = viewOf(answer, {}, "zzz").list;
      assert.deepEqual([none.custom, none.automatic, none.noMatch], [[], [], true]);
      assert.equal(bundle.view.searchTerm("  Level  Complete "), "level_complete");
    });

    it("marks the event asked for, else the one the answer details, and asks for a press as the shell reads it", () => {
      const answer = answerOf(SampleKind.Rich);
      assert.equal(viewOf(answer).selected, "lantern_lit");
      assert.equal(viewOf(answer, { event: "level_fail" }).selected, "level_fail", "at once, before the answer lands");
      assert.equal(viewOf(withData(answer, { detail: null })).selected, null);
      assert.deepEqual(bundle.view.eventAsked("level_fail"), { event: "level_fail", splitBy: undefined });
      assert.deepEqual(bundle.view.splitAsked("difficulty"), { splitBy: "difficulty" });
    });

    it("tells a game with no events of its own from one whose SDK cannot send them", () => {
      const young = answerOf(SampleKind.Young);
      assert.deepEqual(
        [viewOf(young).list.noOwn, viewOf(young).list.sdkReady, viewOf(young).list.custom],
        [true, true, []],
      );
      const old = { ...young, game: { ...young.game, eventsReady: false } };
      assert.equal(viewOf(old).list.sdkReady, false);
    });
  });

  describe("the detail", () => {
    const complete = () => answerOf(SampleKind.Rich, { event: KnownEvent.LevelComplete });
    const detailOf = (answer: Answer, options: GameReportOptions = {}) =>
      viewOf(answer, options).detail ?? assert.fail("no detail");

    it("has the four numbers, each in its own writing, with how they moved", () => {
      const detail = detailOf(complete());
      assert.equal(detail.name, "level_complete");
      assert.equal(detail.note, "Sent when a player finishes a level.");
      assert.equal(detail.firstSeen, `First seen ${formatDay(complete().data.detail?.firstSeenOn)}.`);
      assert.deepEqual(
        detail.tiles.map((tile) => [tile.id, tile.value, tile.note]),
        [
          ["count", "27,930", undefined],
          ["players", "6,740", undefined],
          ["per-player", "4.1", undefined],
          ["share", "72.5%", "of 9,300 players"],
        ],
      );
      const [count, players, perPlayer] = detail.tiles.map((tile) => tile.delta);
      const own = complete().data.detail ?? assert.fail("no detail");
      assert.deepEqual(count, {
        kind: bundle.DeltaKind.Percent,
        now: 27_930,
        before: own.count.before,
        neutral: true,
      });
      assert.deepEqual(players, {
        kind: bundle.DeltaKind.Percent,
        now: 6740,
        before: own.players.before,
        neutral: true,
      });
      assert.equal(perPlayer?.kind, bundle.DeltaKind.Amount);
      assert.equal(perPlayer?.kind === bundle.DeltaKind.Amount && perPlayer.format(0.3), "+0.3");
      assert.equal(
        perPlayer?.neutral,
        true,
        "more of an event is not good news by itself: a fail or a death is one too",
      );
    });

    it("keeps what cannot be known as a dash and never as zero", () => {
      const answer = complete();
      const detail = answer.data.detail ?? assert.fail();
      const nobody = withData(answer, {
        detail: { ...detail, players: { now: 0, before: 0 }, everyone: 0 },
      });
      const tiles = detailOf(nobody).tiles;
      assert.deepEqual(
        tiles.map((tile) => [tile.id, tile.value]),
        [
          ["count", "27,930"],
          ["players", "0"],
          ["per-player", null],
          ["share", null],
        ],
      );
      const [, , perPlayer] = tiles.map((tile) => tile.delta);
      assert.deepEqual([perPlayer?.now, perPlayer?.before], [null, null]);
    });

    it("draws one count a day for each day of the period, under the period's own dates", () => {
      for (const days of STATS_PERIODS) {
        const detail = detailOf(answerOf(SampleKind.Rich, { event: KnownEvent.LevelComplete }, days));
        assert.equal(detail.series.length, 1);
        assert.equal(detail.series[0]?.values.length, days);
        assert.equal(detail.labels.length, days);
        assert.equal(detail.labels.at(-1), formatDay("2026-11-17"));
      }
    });

    it("splits by the property the answer chose, and by the one asked for at once", () => {
      const asked = detailOf(complete());
      assert.equal(asked.split?.property, "level");
      assert.deepEqual(
        asked.split?.options.map((option) => option.value),
        ["level", "time_s", "deaths", "lantern_count", "difficulty"],
      );
      assert.equal(
        asked.split?.options.every((option) => option.mask),
        true,
        "the game's own words",
      );
      assert.deepEqual(asked.split?.items[0], { id: "1", label: "1", value: 7330, detail: "6,740 players" });
      assert.equal(asked.split?.total, 27_930);

      const picked = detailOf(complete(), { splitBy: "difficulty" });
      assert.equal(picked.split?.property, "difficulty", "the press shows before the answer lands");
      assert.equal(picked.split?.label, "Events by difficulty");
      const stale = detailOf(complete(), { splitBy: "color" });
      assert.equal(stale.split?.property, "level", "a property the event does not have is not shown as picked");

      const differentSplit = answerOf(SampleKind.Rich, { event: KnownEvent.LevelComplete, splitBy: "difficulty" });
      assert.deepEqual(
        detailOf(differentSplit).split?.items.map((item) => [item.label, item.value]),
        [
          ["normal", 19_830],
          ["hard", 8100],
        ],
      );
    });

    it("has no split for an event with no property", () => {
      const answer = complete();
      const detail = answer.data.detail ?? assert.fail();
      const bare = withData(answer, { detail: { ...detail, properties: [], splitBy: null, split: [] } });
      assert.equal(detailOf(bare).split, null);
      assert.deepEqual(detailOf(bare).properties, []);
    });

    it("says what arrived in each property by its kind", () => {
      const rows = detailOf(complete()).properties;
      assert.deepEqual(
        rows.map((row) => [row.name, row.kind, row.arrived]),
        [
          ["level", "Number", "1 to 8, median 3, 9 in 10 under 6"],
          ["time_s", "Number", "9 to 1,840, median 74, 9 in 10 under 212"],
          ["deaths", "Number", "0 to 31, median 2, 9 in 10 under 7"],
          ["lantern_count", "Number", "0 to 24, median 11, 9 in 10 under 19"],
          ["difficulty", "Text", formatList(["normal 71%", "hard 29%"])],
        ],
      );
      const { factsOf, propertyNumber } = bundle.view;
      assert.equal(factsOf({ kind: PropertyKind.Flag, yes: 0.31 }), "True in 31% of events");
      assert.equal(
        factsOf({ kind: PropertyKind.Flag, yes: 0.004 }),
        "True in 0.4% of events",
        "a rare one keeps a decimal",
      );
      assert.equal(propertyNumber(-3), "−3");
      assert.equal(propertyNumber(2.4), "2.4");
      assert.equal(propertyNumber(2.456), "2.46");
      assert.equal(propertyNumber(1840), "1,840");
      assert.equal(propertyNumber(12.5), "12.5");
    });

    it("lists the five most common values of a text property and counts the rest", () => {
      const top = ["a", "b", "c", "d", "e", "f", "g"].map((value) => ({ value, share: 0.1 }));
      assert.equal(
        bundle.view.factsOf({ kind: PropertyKind.Text, top }),
        `${formatList(["a 10%", "b 10%", "c 10%", "d 10%", "e 10%"])}, and 2 more`,
      );
      assert.equal(
        bundle.view.factsOf({ kind: PropertyKind.Text, top: top.slice(0, 5) }),
        formatList(["a 10%", "b 10%", "c 10%", "d 10%", "e 10%"]),
      );
      assert.equal(bundle.view.factsOf({ kind: PropertyKind.Text, top: [] }), "");
    });

    it("lets a language put a value's share before it", () => {
      setLocale(Locale.Spanish, { "{value} {share}": "{share} de {value}" });
      try {
        const top = [
          { value: "red", share: 0.4 },
          { value: "blue", share: 0.35 },
        ];
        const written = bundle.view.factsOf({ kind: PropertyKind.Text, top });
        assert.match(written, /^40\s?% de red\b/);
        assert.match(written, /35\s?% de blue$/);
      } finally {
        setLocale(Locale.Japanese, {});
      }
    });

    it("describes the events Genex counts, and leaves a game's own event without a sentence", () => {
      const auto = detailOf(answerOf(SampleKind.Rich, { event: AutoEvent.Purchase }));
      assert.equal(auto.automatic, true);
      assert.equal(auto.note, "Counted when a player buys something with Nex.");
      const own = detailOf(answerOf(SampleKind.Rich, { event: "shop_open" }));
      assert.equal(own.note, null);
      assert.equal(viewOf(withData(answerOf(SampleKind.Rich), { detail: null })).detail, null);
    });
  });

  describe("the funnels", () => {
    it("lists each step with the players who reached it, what narrows it, and how it ended", () => {
      const { funnels } = viewOf(answerOf(SampleKind.Rich));
      assert.equal(funnels.funnels.length, 1);
      const [funnel] = funnels.funnels;
      assert.equal(funnel?.name, "First purchase");
      assert.equal(funnel?.within, "Players who did every step in order within 7 days.");
      assert.equal(funnel?.outcome, "5.6% reach the end, typically on day 2.");
      assert.deepEqual(
        funnel?.steps.map((step) => [step.label, step.qualifier, step.count]),
        [
          ["level_start", undefined, 7410],
          ["level_complete", "level = 1", 6740],
          ["shop_open", undefined, 2460],
          ["purchase", undefined, 412],
        ],
      );
      assert.equal(new Set(funnel?.steps.map((step) => step.id)).size, 4, "each step keeps its own place");
    });

    it("words a funnel's end by what is known of it", () => {
      const base = funnelData();
      const outcome = (over: Partial<EventFunnel>) => bundle.view.funnelOf({ ...base, ...over }).outcome;
      assert.equal(outcome({ typicalDay: null }), "5.5% reach the end.");
      assert.equal(outcome({ typicalDay: 0 }), "5.5% reach the end, typically the same day.");
      const nobody = base.steps.map((step) => ({ ...step, players: 0 }));
      assert.equal(outcome({ steps: nobody, typicalDay: null }), "Nobody has done the first step in these days.");
      assert.equal(outcome({ steps: base.steps.slice(0, 1) }), null, "one step has no end to reach");
      assert.equal(
        bundle.view.funnelOf({ ...base, withinDays: 1 }).within,
        "Players who did every step in order within 1 day.",
      );
    });

    it("offers the names the list has as steps, and stops at the most a game keeps", () => {
      const answer = answerOf(SampleKind.Rich);
      const { events, full } = viewOf(answer).funnels;
      assert.deepEqual(
        events,
        [...answer.data.custom, ...answer.data.automatic].map((row) => row.name),
      );
      assert.equal(full, false);
      const many = Array.from({ length: FUNNELS_MAX }, (_, index) => ({ ...funnelData(), id: `fn_${index}` }));
      assert.equal(viewOf(withData(answer, { funnels: many })).funnels.full, true);
      assert.equal(viewOf(withData(answer, { funnels: many.slice(1) })).funnels.full, false);
    });
  });

  describe("the funnel form's model", () => {
    const events = ["level_start", "level_complete", "purchase"];
    const formOf = (over: Record<string, unknown> = {}, step: Record<string, unknown> = {}) => {
      const form = bundle.form.emptyFunnelForm("level_start");
      return {
        ...form,
        name: "First purchase",
        ...over,
        steps: form.steps.map((one) => ({ ...one, ...step })),
      };
    };
    const issuesOf = (over: Record<string, unknown> = {}, step: Record<string, unknown> = {}) =>
      bundle.form.funnelFormIssues(formOf(over, step), events).map((issue) => [issue.field, issue.step, issue.problem]);
    const { FormField: Field, FormProblem: Problem } = {
      FormField: { Name: "name", Days: "days", Event: "event", Property: "property", Value: "value" },
      FormProblem: {
        Empty: "empty",
        TooLong: "too_long",
        Characters: "characters",
        NotWhole: "not_whole",
        OutOfRange: "out_of_range",
        Pair: "pair",
        UnknownEvent: "unknown_event",
      },
    } as const;

    it("starts as one step on the event in view, a week long, with no name", () => {
      const form = bundle.form.emptyFunnelForm("level_start");
      assert.deepEqual(form.steps, [{ key: 0, event: "level_start", property: "", value: "" }]);
      assert.deepEqual([form.name, form.days], ["", "7"]);
    });

    it("adds steps up to the most a funnel has and takes them out down to one", () => {
      let form = bundle.form.emptyFunnelForm("level_start");
      assert.equal(bundle.form.canRemoveStep(form), false);
      assert.equal(bundle.form.removeStep(form, 0), form, "the only step stays");
      for (let step = 1; step < FUNNEL_STEPS_MAX; step++) form = bundle.form.addStep(form, "purchase");
      assert.equal(form.steps.length, FUNNEL_STEPS_MAX);
      assert.equal(bundle.form.canAddStep(form), false);
      assert.equal(bundle.form.addStep(form, "purchase"), form, "a full funnel takes no more");
      assert.equal(new Set(form.steps.map((step) => step.key)).size, FUNNEL_STEPS_MAX, "each step keeps its own key");
      const without = bundle.form.removeStep(form, 3);
      assert.deepEqual(
        without.steps.map((step) => step.key),
        [0, 1, 2, 4, 5, 6, 7],
      );
      const changed = bundle.form.changeStep(without, 4, { value: "x" });
      assert.deepEqual(
        changed.steps.map((step) => step.value),
        ["", "", "", "x", "", "", ""],
      );
    });

    it("holds every field to the limits main refuses by", () => {
      assert.deepEqual(issuesOf(), [], "a good form has none");
      assert.deepEqual(issuesOf({ name: "" }), [[Field.Name, null, Problem.Empty]]);
      assert.deepEqual(issuesOf({ name: "   " }), [[Field.Name, null, Problem.Empty]], "spaces are nothing");
      assert.deepEqual(issuesOf({ name: "n".repeat(FUNNEL_NAME_MAX) }), [], "the longest name");
      assert.deepEqual(issuesOf({ name: "n".repeat(FUNNEL_NAME_MAX + 1) }), [[Field.Name, null, Problem.TooLong]]);
      assert.deepEqual(issuesOf({ name: ` ${"n".repeat(FUNNEL_NAME_MAX)} ` }), [], "spaces around do not count");
      assert.deepEqual(issuesOf({ name: "a‮b" }), [[Field.Name, null, Problem.Characters]], "text turned around");
      assert.deepEqual(issuesOf({ name: "a\u0007b" }), [[Field.Name, null, Problem.Characters]], "a control");
      assert.deepEqual(issuesOf({ name: "a\tb" }), [[Field.Name, null, Problem.Characters]]);
      assert.deepEqual(issuesOf({ name: "a b" }), [[Field.Name, null, Problem.Characters]]);
      for (const [days, problem] of [
        ["", Problem.Empty],
        ["0", Problem.OutOfRange],
        [String(FUNNEL_DAYS_MAX + 1), Problem.OutOfRange],
        ["2.5", Problem.NotWhole],
        ["-3", Problem.NotWhole],
        ["1e1", Problem.NotWhole],
        ["abc", Problem.NotWhole],
        ["99999999999999999999", Problem.OutOfRange],
      ] as const)
        assert.deepEqual(issuesOf({ days }), [[Field.Days, null, problem]], `days ${JSON.stringify(days)}`);
      for (const days of ["1", String(FUNNEL_DAYS_MAX), " 7 "]) assert.deepEqual(issuesOf({ days }), [], days);
      assert.deepEqual(issuesOf({}, { event: "no_such_event" }), [[Field.Event, 0, Problem.UnknownEvent]]);
      assert.deepEqual(issuesOf({}, { event: "" }), [[Field.Event, 0, Problem.UnknownEvent]]);
    });

    it("sends a step's property and value both or neither", () => {
      assert.deepEqual(issuesOf({}, { property: "level", value: "1" }), []);
      assert.deepEqual(issuesOf({}, { property: "level", value: "  " }), [[Field.Value, 0, Problem.Pair]]);
      assert.deepEqual(issuesOf({}, { property: " ", value: "1" }), [[Field.Property, 0, Problem.Pair]]);
      assert.deepEqual(issuesOf({}, { property: "  ", value: "" }), [], "blank both is neither");
      const longProperty = "p".repeat(PROPERTY_NAME_MAX + 1);
      assert.deepEqual(issuesOf({}, { property: longProperty, value: "1" }), [[Field.Property, 0, Problem.TooLong]]);
      assert.deepEqual(issuesOf({}, { property: "p".repeat(PROPERTY_NAME_MAX), value: "1" }), []);
      const longValue = "v".repeat(EVENT_LIMITS.textLength + 1);
      assert.deepEqual(issuesOf({}, { property: "level", value: longValue }), [[Field.Value, 0, Problem.TooLong]]);
      assert.deepEqual(issuesOf({}, { property: "level", value: "v".repeat(EVENT_LIMITS.textLength) }), []);
      assert.deepEqual(issuesOf({}, { property: "le‎vel", value: "1" }), [[Field.Property, 0, Problem.Characters]]);
      assert.deepEqual(issuesOf({}, { property: "level", value: "1\n2" }), [[Field.Value, 0, Problem.Characters]]);
    });

    it("reports every problem, step by step, in the order the fields are shown", () => {
      let form = formOf({ name: "", days: "0" });
      form = bundle.form.addStep(form, "purchase");
      form = bundle.form.changeStep(form, 1, { event: "gone", property: "level" });
      assert.deepEqual(
        bundle.form.funnelFormIssues(form, events).map((issue) => [issue.field, issue.step, issue.problem]),
        [
          [Field.Name, null, Problem.Empty],
          [Field.Days, null, Problem.OutOfRange],
          [Field.Event, 1, Problem.UnknownEvent],
          [Field.Value, 1, Problem.Pair],
        ],
      );
      assert.equal(
        bundle.form.issueOf(bundle.form.funnelFormIssues(form, events), Field.Value, 1)?.problem,
        Problem.Pair,
      );
      assert.equal(bundle.form.issueOf([], Field.Value, 1), null);
    });

    it("writes the funnel it saves trimmed, with null for a step that names no property, and main takes it", () => {
      let form = formOf({ name: "  First purchase ", days: " 7 " });
      form = bundle.form.addStep(form, "level_complete");
      form = bundle.form.changeStep(form, 1, { property: " level ", value: " 1 " });
      form = bundle.form.addStep(form, "purchase");
      const check = bundle.form.checkFunnelForm(form, events);
      assert.ok("draft" in check, "no issue");
      assert.deepEqual(check.draft, {
        name: "First purchase",
        withinDays: 7,
        steps: [
          { event: "level_start", property: null, value: null },
          { event: "level_complete", property: "level", value: "1" },
          { event: "purchase", property: null, value: null },
        ],
      });
      assert.deepEqual(funnelDraftOf(check.draft), check.draft, "what main's own check accepts, unchanged");
      const longest = bundle.form.checkFunnelForm(
        formOf(
          { name: "n".repeat(FUNNEL_NAME_MAX), days: String(FUNNEL_DAYS_MAX) },
          { property: "p".repeat(PROPERTY_NAME_MAX), value: "v".repeat(EVENT_LIMITS.textLength) },
        ),
        events,
      );
      assert.ok("draft" in longest);
      assert.deepEqual(funnelDraftOf(longest.draft), longest.draft, "the limits are main's own");
      const refused = bundle.form.checkFunnelForm(formOf({ name: "" }), events);
      assert.ok("issues" in refused && !("draft" in refused), "nothing is written for a form with a problem");
    });
  });

  describe("the face", () => {
    it("draws the rich game's month: the strip, the list, the event in full and the funnel", () => {
      const answer = answerOf(SampleKind.Rich, { event: KnownEvent.LevelComplete });
      const markup = draw(answer, { event: KnownEvent.LevelComplete });
      assert.match(markup, /data-game-analytics-report="events"/);
      assert.match(markup, /data-game-analytics-events-strip="arriving"/);
      const ago = formatAgo(new Date(NOW - 12_000).toISOString(), NOW);
      assert.ok(
        words(markup).startsWith(
          `Receiving your events Last one ${ago} 217,400 events in this period, under 8 names Watch events arrive`,
        ),
      );
      assert.match(markup, /data-game-analytics-open="sdk"/);

      const list = sectionOf(markup, "events");
      assert.match(list, /data-game-analytics-events-search/);
      assert.match(list, /data-analytics-mask/);
      assert.match(list, /data-game-analytics-events-group="mine"/);
      assert.match(list, /data-game-analytics-events-group="automatic"/);
      assert.match(words(list), /Your events/);
      assert.match(words(list), /Counted by Genex, no code/);
      assert.equal(
        (list.match(/data-game-analytics-row="/g) ?? []).length,
        answer.data.custom.length + answer.data.automatic.length,
        "a row for each event, and the headings are none",
      );
      assert.match(list, /<div role="row"[^>]*data-game-analytics-row="level_complete"[^>]*data-selected="true"/);
      assert.match(list, /aria-pressed="true"[^>]*>\s*<span[^>]*>level_complete/);

      const detail = sectionOf(markup, "detail");
      assert.match(detail, /data-game-analytics-event="level_complete"/);
      assert.ok(
        words(detail).startsWith(
          `level_complete Sent when a player finishes a level. First seen ${formatDay(answer.data.detail?.firstSeenOn)}.`,
        ),
      );
      assert.match(words(detail), /Count 27,930/);
      assert.match(words(detail), /Players who sent it 72\.5% of 9,300 players/);
      assert.match(detail, /data-game-analytics-switch="split"/);
      assert.match(detail, /data-game-analytics-option="difficulty"/);
      assert.match(detail, /data-game-analytics-bars="split"/);
      assert.match(detail, /data-game-analytics-table="event-properties"/);
      assert.ok(words(detail).includes(`difficulty Text ${formatList(["normal 71%", "hard 29%"])}`));

      const funnels = sectionOf(markup, "funnels");
      assert.match(
        words(funnels),
        /First purchase Players who did every step in order within 7 days\. 5\.6% reach the end, typically on day 2\./,
      );
      assert.match(funnels, /data-game-analytics-funnel="fx-funnel-first-purchase"/);
      assert.match(words(funnels), /level_complete level = 1 6,740/);
      assert.match(funnels, /data-game-analytics-new-funnel/);
      assert.match(funnels, /data-game-analytics-remove-funnel="fx-funnel-first-purchase"/);
      assert.doesNotMatch(funnels, /data-game-analytics-funnel-form/, "the form opens on a press");
    });

    it("marks the event picked even while its answer is on its way", () => {
      const markup = draw(answerOf(SampleKind.Rich), { event: KnownEvent.LevelFail });
      assert.match(sectionOf(markup, "events"), /data-game-analytics-row="level_fail"[^>]*data-selected="true"/);
      assert.match(
        sectionOf(markup, "detail"),
        /data-game-analytics-event="lantern_lit"/,
        "the answer held is the one before",
      );
    });

    it("keeps the game's own words out of usage recordings wherever they sit in a control", () => {
      const markup = draw(answerOf(SampleKind.Rich));
      const list = sectionOf(markup, "events");
      assert.match(list, /data-analytics-mask="true"[^>]*>lantern_lit/);
      assert.doesNotMatch(
        list.slice(list.indexOf('data-game-analytics-events-group="automatic"')),
        /data-analytics-mask="true"[^>]*>play_start/,
        "the names Genex counts are Genex's own",
      );
      assert.match(sectionOf(markup, "detail"), /<h2[^>]*data-analytics-mask="true"[^>]*>lantern_lit/);
      assert.match(sectionOf(markup, "funnels"), /<h3[^>]*data-analytics-mask="true"[^>]*>First purchase/);
    });

    it("tells a game with no events of its own how to start, and shows what Genex counts", () => {
      const markup = draw(answerOf(SampleKind.Young));
      assert.match(markup, /data-game-analytics-events-strip="none"/);
      assert.match(words(markup), /Your game sends no events yet/);
      assert.doesNotMatch(markup, /Watch events arrive/, "the note carries the way to the SDK tab");
      const list = sectionOf(markup, "events");
      assert.match(list, /data-game-analytics-events-start="ready"/);
      assert.match(words(list), /Your game has not sent an event yet\./);
      assert.match(list, /<button[^>]*data-game-analytics-open="sdk"[^>]*>See how to add events</);
      assert.doesNotMatch(list, /data-game-analytics-events-group="mine"/);
      assert.match(list, /data-game-analytics-events-group="automatic"/);
      assert.match(list, /data-game-analytics-row="play_start"/);
      assert.equal(sectionOf(markup, "detail"), "", "nothing to detail");
      assert.match(words(sectionOf(markup, "funnels")), /No funnels yet\./);
    });

    it("says an SDK too old to send events needs updating", () => {
      const young = answerOf(SampleKind.Young);
      const markup = draw({ ...young, game: { ...young.game, eventsReady: false } });
      assert.match(sectionOf(markup, "events"), /data-game-analytics-events-start="old-sdk"/);
      assert.match(words(markup), /The SDK in your published game is too old to send events\. See how to update it/);
    });

    it("shows a dash where a number cannot be known and not a zero", () => {
      const answer = answerOf(SampleKind.Rich, { event: KnownEvent.LevelComplete });
      const detail = answer.data.detail ?? assert.fail();
      const nobody = withData(answer, { detail: { ...detail, players: { now: 0, before: 0 }, everyone: 0 } });
      const markup = sectionOf(draw(nobody, { event: KnownEvent.LevelComplete }), "detail");
      assert.match(markup, /data-game-analytics-tile="per-player"[^>]*>.*?data-missing="true"[^>]*>—</);
      assert.match(markup, /data-game-analytics-tile="share"[^>]*>.*?data-missing="true"[^>]*>—</);
    });

    it("stops offering a new funnel at the most a game keeps, and says why", () => {
      const answer = answerOf(SampleKind.Rich);
      const many = Array.from({ length: FUNNELS_MAX }, (_, index) => ({ ...funnelData(), id: `fn_${index}` }));
      const funnels = sectionOf(draw(withData(answer, { funnels: many })), "funnels");
      assert.doesNotMatch(funnels, /data-game-analytics-new-funnel/);
      assert.match(words(funnels), /A game keeps up to 20 funnels\. Remove one to make another\./);
      assert.equal((funnels.match(/data-game-analytics-funnel-card=/g) ?? []).length, FUNNELS_MAX);
    });

    it("offers no new funnel while there is no event to start one with", () => {
      const nothing = withData(answerOf(SampleKind.Young), {
        custom: [],
        automatic: [],
        detail: null,
        lastAt: null,
        total: 0,
      });
      const markup = draw(nothing);
      assert.doesNotMatch(markup, /data-game-analytics-new-funnel/);
      assert.match(words(markup), /No event has that name|Your game has not sent an event yet\./);
    });

    it("draws the list's search and presses as the shell asks for them", () => {
      const answer = answerOf(SampleKind.Rich);
      const calls: unknown[] = [];
      const list = bundle.EventsListSection({
        list: viewOf(answer).list,
        query: "lev",
        selected: "level_start",
        onQuery: (query: string) => calls.push(["query", query]),
        onPick: (name: string) => calls.push(["pick", name]),
        onOpenSdk: () => calls.push(["sdk"]),
      });
      const [input] = findAll(list, (own) => own["data-game-analytics-events-search"] === true);
      assert.equal(input?.value, "lev", "the search shows what was typed");
      handler(input, "onChange")({ target: { value: "level_" } });
      const [mine] = findAll(list, (own) => own.id === "events-mine");
      handler(mine, "onSelect")({ name: "level_fail" });
      assert.deepEqual(calls, [
        ["query", "level_"],
        ["pick", "level_fail"],
      ]);
      assert.equal(mine?.selectedId, "level_start");
    });
  });

  describe("the form and the question beside a funnel", () => {
    const events = ["level_start", "purchase"];
    const editor = (over: Record<string, unknown> = {}) =>
      bundle.renderToStaticMarkup(
        bundle.createElement(bundle.FunnelEditor, {
          events,
          firstEvent: "level_start",
          onSave: pending,
          onSaved: noop,
          onCancel: noop,
          ...over,
        }),
      );

    it("opens on one step, with no problem shown before one is made", () => {
      const markup = editor();
      assert.match(markup, /data-game-analytics-funnel-form/);
      assert.match(
        words(markup),
        /New funnel Name Within how many days Steps Players have to do these in order\. Step 1 Event/,
      );
      assert.equal((markup.match(/data-game-analytics-form-step=/g) ?? []).length, 1);
      assert.match(markup, /<input[^>]*value="7"/);
      assert.match(
        markup,
        /<option value="level_start" selected="">level_start<\/option>|<option selected="" value="level_start">/,
      );
      assert.doesNotMatch(markup, /data-game-analytics-problem/, "an empty name waits for the first try to save");
      assert.match(markup, /<button[^>]*disabled=""[^>]*data-game-analytics-remove-step="0"/, "the only step stays");
      assert.match(markup, /data-game-analytics-add-step/);
      assert.match(markup, /data-game-analytics-save-funnel/);
      const fields = markup.match(/<input[^>]*data-game-analytics-field="(?:name|property-0|value-0)"[^>]*>/g) ?? [];
      assert.equal(fields.length, 3);
      assert.ok(
        fields.every((field) => field.includes("data-analytics-mask")),
        "what is typed is kept out of recordings",
      );
    });

    it("says to remove a funnel first when genex.games refused the save because the game keeps no more", () => {
      assert.equal(
        bundle.view.funnelRefusal(new CodedError(AnalyticsSaveRefusal.Limit, "full")),
        `A game keeps up to ${FUNNELS_MAX} funnels. Remove one to make another.`,
      );
      for (const error of [new Error("offline"), null, { code: "limit" }])
        assert.equal(
          bundle.view.funnelRefusal(error),
          "Genex couldn’t save this funnel. Check the steps and try again.",
          String(error),
        );
    });

    it("says at once that a name or a value is too long, as main would refuse it", () => {
      const form = bundle.form.changeStep(
        { ...bundle.form.emptyFunnelForm("level_start"), name: "n".repeat(FUNNEL_NAME_MAX + 1) },
        0,
        { property: "level", value: "v".repeat(EVENT_LIMITS.textLength + 1) },
      );
      const markup = editor({ initial: form });
      assert.equal((markup.match(/data-game-analytics-problem="too_long"/g) ?? []).length, 2);
      assert.match(words(markup), /This can be up to 80 characters\./);
      assert.match(words(markup), /This can be up to 200 characters\./);
      assert.match(markup, /aria-invalid="true"/);
    });

    it("takes no step past the most a funnel has", () => {
      let form = bundle.form.emptyFunnelForm("level_start");
      for (let step = 1; step < FUNNEL_STEPS_MAX; step++) form = bundle.form.addStep(form, "purchase");
      const markup = editor({ initial: form });
      assert.equal((markup.match(/data-game-analytics-form-step=/g) ?? []).length, FUNNEL_STEPS_MAX);
      assert.doesNotMatch(markup, /data-game-analytics-add-step/);
      assert.doesNotMatch(markup, /data-game-analytics-remove-step="0"[^>]*disabled/);
    });

    it("asks before a funnel goes, in its own place, and says what failed", () => {
      const ask = (removal: string) =>
        bundle.renderToStaticMarkup(bundle.createElement(bundle.RemoveAsk, { removal, onYes: noop, onKeep: noop }));
      assert.match(words(ask("asking")), /Remove this funnel\? Keep it Remove funnel/);
      assert.match(ask("asking"), /data-game-analytics-remove-keep/);
      assert.match(ask("asking"), /data-game-analytics-remove-yes/);
      assert.match(words(ask("failed")), /Couldn’t remove it\. Try again\. Keep it Remove funnel/);
      const removing = ask("removing");
      assert.match(words(removing), /Removing…/);
      assert.match(
        removing,
        /<button[^>]*disabled=""[^>]*data-game-analytics-remove-keep|data-game-analytics-remove-keep[^>]*disabled=""/,
      );
    });
  });
});
