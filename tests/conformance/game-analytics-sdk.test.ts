/**
 * The SDK tab, end to end: how main reads a game's events as they arrive (hostile input: the names
 * and values are a game's own words, a row that cannot be trusted is left out, a limit that is not
 * one falls back to the app's own), the status a fixture launch makes up for each origin and kind of
 * game, what the page derives for display, and the page's face as React's server renderer draws it
 * from the plain renderer build.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureEventsStatus } from "../../src/main/dev/fixture-game-analytics/fixture-events-status.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  type GameSample,
  gameSample,
  ownSamples,
  SampleKind,
  type SampleSource,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { toEventsStatus } from "../../src/main/play/game-analytics/events-status.ts";
import { eventsStatusRoute } from "../../src/main/play/game-analytics/routes.ts";
import { formatAgo } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { SdkPageProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  AutoEvent,
  DROPPED_ROWS_MAX,
  DropReason,
  EVENT_LIMITS,
  EVENT_NAME,
  EventOrigin,
  type EventsStatus,
  KnownEvent,
  RECENT_EVENTS_MAX,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";

const SLUG = "lantern-run";
const COVER = "https://cdn.genex.technology/covers/a.webp";

const GAME: EventsStatus["game"] = {
  slug: SLUG,
  title: "Lantern Run",
  coverUrl: COVER,
  playingNow: 38,
  publishedOn: "2026-05-01",
  version: "1.4.0",
  hasAppBuild: true,
  sdkVersion: "0.38.2",
  eventsReady: true,
};

/** A status as genex.games answers it, every part well formed. */
const STATUS: EventsStatus = {
  game: GAME,
  origin: EventOrigin.Published,
  lastAt: "2026-11-17T12:03:48.000Z",
  names: 8,
  recent: [
    {
      at: "2026-11-17T12:03:48.000Z",
      name: "level_complete",
      player: "US · computer",
      properties: [
        { name: "level", value: "4" },
        { name: "time_s", value: "81" },
      ],
    },
    { at: "2026-11-17T12:03:44.000Z", name: "play_start", player: "DE · computer", properties: [] },
  ],
  dropped: [
    {
      name: "Level Complete",
      reason: DropReason.BadName,
      property: null,
      count: 41,
      lastAt: "2026-11-17T11:26:00.000Z",
    },
    {
      name: "powerup_used",
      reason: DropReason.BadValue,
      property: "meta",
      count: 7,
      lastAt: "2026-11-17T09:02:00.000Z",
    },
  ],
  limits: { nameLength: 40, names: 200, properties: 20, textLength: 200, batchSeconds: 5, keptDays: 90 },
};

/** `STATUS` with some of it changed, as untyped JSON. */
const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...STATUS, ...over });
const read = (body: unknown, origin: EventOrigin = EventOrigin.Published): EventsStatus | null =>
  toEventsStatus(body, SLUG, origin);
const EVENT = STATUS.recent[0] ?? assert.fail();
const DROPPED = STATUS.dropped[0] ?? assert.fail();

describe("a game's events as they arrive, as main reads them", () => {
  it("reads a well-formed status exactly as it was sent", () => {
    assert.deepEqual(read(wire()), STATUS);
    const preview = wire({ origin: EventOrigin.Preview, recent: [], dropped: [] });
    assert.deepEqual(read(preview, EventOrigin.Preview), {
      ...STATUS,
      origin: EventOrigin.Preview,
      recent: [],
      dropped: [],
    });
  });

  it("keeps a game with no event yet as null, never as a time", () => {
    assert.equal(read(wire({ lastAt: null, recent: [] }))?.lastAt, null);
  });

  it("answers null for a body that is not this game's status from this origin", () => {
    const table: [string, unknown][] = [
      ["nothing", null],
      ["an empty object", {}],
      ["a list", [wire()]],
      ["text", "ok"],
      ["no game", wire({ game: undefined })],
      ["another game", wire({ game: { ...GAME, slug: "neon-rush" } })],
      ["a game with no title", wire({ game: { ...GAME, title: "" } })],
      ["the other origin echoed", wire({ origin: EventOrigin.Preview })],
      ["an origin the app does not know", wire({ origin: "staging" })],
      ["no origin", wire({ origin: undefined })],
      ["a last time that is a day", wire({ lastAt: "2026-11-17" })],
      ["a last time that is a number", wire({ lastAt: 1_763_380_000_000 })],
      ["no last time", wire({ lastAt: undefined })],
      ["a negative count of names", wire({ names: -1 })],
      ["a fractional count of names", wire({ names: 7.5 })],
      ["a count of names as text", wire({ names: "8" })],
      ["no count of names", wire({ names: undefined })],
      ["events that are not a list", wire({ recent: { 0: EVENT } })],
      ["no events", wire({ recent: undefined })],
      ["dropped rows that are not a list", wire({ dropped: "none" })],
      ["no dropped rows", wire({ dropped: null })],
    ];
    for (const [name, body] of table) assert.equal(read(body), null, name);
    assert.equal(
      read(wire(), EventOrigin.Preview),
      null,
      "asked for the preview's, answered with the published game's",
    );
  });

  it("leaves an event that cannot be trusted out and keeps the rest", () => {
    const recent = [
      EVENT,
      null,
      "level_complete",
      { ...EVENT, at: "12:03:48" },
      { ...EVENT, at: 1_763_380_000_000 },
      { ...EVENT, name: "" },
      { ...EVENT, name: 4 },
      { ...EVENT, name: "n".repeat(500) },
      { ...EVENT, player: null },
      { ...EVENT, player: "p".repeat(500) },
      { ...EVENT, properties: "level 4" },
      { ...EVENT, properties: undefined },
      { ...EVENT, name: "lantern_lit", properties: [] },
    ];
    assert.deepEqual(read(wire({ recent }))?.recent, [EVENT, { ...EVENT, name: "lantern_lit", properties: [] }]);
  });

  it("leaves a property that cannot be trusted out of its event, and keeps one per name", () => {
    const properties = [
      { name: "level", value: "4" },
      { name: "level", value: "5" },
      { name: "", value: "x" },
      { name: "deaths", value: 3 },
      { name: "time_s" },
      "kind dash",
      null,
      { name: "kind", value: "dash" },
    ];
    assert.deepEqual(read(wire({ recent: [{ ...EVENT, properties }] }))?.recent[0]?.properties, [
      { name: "level", value: "4" },
      { name: "kind", value: "dash" },
    ]);
    const many = Array.from({ length: 500 }, (_, index) => ({ name: `p${index}`, value: "1" }));
    const kept = read(wire({ recent: [{ ...EVENT, properties: many }] }))?.recent[0]?.properties ?? assert.fail();
    assert.ok(kept.length <= 50, `${kept.length} properties`);
    assert.equal(kept[0]?.name, "p0", "the first ones sent");
  });

  it("cleans a game's words of the characters that turn text around or control a terminal", () => {
    const event = {
      at: EVENT.at,
      name: "level‮_complete",
      player: "\u0000US · computer\u001b",
      properties: [{ name: "⁦kind⁩", value: "da sh\u0007" }],
    };
    const dropped = { ...DROPPED, name: "Level‮ Complete\u0000", reason: DropReason.BadValue, property: "me‏ta" };
    const status = read(wire({ recent: [event], dropped: [dropped] })) ?? assert.fail();
    assert.deepEqual(status.recent, [
      { at: EVENT.at, name: "level_complete", player: "US · computer", properties: [{ name: "kind", value: "dash" }] },
    ]);
    assert.deepEqual([status.dropped[0]?.name, status.dropped[0]?.property], ["Level Complete", "meta"]);
  });

  it("writes every time as the same moment in UTC", () => {
    const status = read(
      wire({ lastAt: "2026-11-17T14:03:48+02:00", recent: [{ ...EVENT, at: "2026-11-17T07:03:48-05:00" }] }),
    );
    assert.deepEqual([status?.lastAt, status?.recent[0]?.at], ["2026-11-17T12:03:48.000Z", "2026-11-17T12:03:48.000Z"]);
  });

  it("keeps no more events than the newest a page shows", () => {
    const recent = Array.from({ length: RECENT_EVENTS_MAX + 300 }, (_, index) => ({
      ...EVENT,
      name: `event_${index}`,
    }));
    const kept = read(wire({ recent }))?.recent ?? assert.fail();
    assert.equal(kept.length, RECENT_EVENTS_MAX);
    assert.equal(kept[0]?.name, "event_0", "the first ones sent, which are the newest");
  });

  it("leaves a dropped row out when its reason is unknown or a part of it cannot be trusted", () => {
    const dropped = [
      DROPPED,
      { ...DROPPED, reason: "cosmic_rays" },
      { ...DROPPED, reason: undefined },
      { ...DROPPED, name: "" },
      { ...DROPPED, name: 12 },
      { ...DROPPED, name: "other", count: -4 },
      { ...DROPPED, name: "other", count: 1.5 },
      { ...DROPPED, name: "other", count: "41" },
      { ...DROPPED, name: "other", count: 0 },
      { ...DROPPED, name: "other", lastAt: "yesterday" },
      { ...DROPPED, name: "other", lastAt: null },
      { ...DROPPED, name: "other", property: 3 },
      { ...DROPPED, name: "other", property: undefined },
      null,
      { ...DROPPED, name: "shop_open", reason: DropReason.TooFast },
    ];
    assert.deepEqual(read(wire({ dropped }))?.dropped, [
      DROPPED,
      { ...DROPPED, name: "shop_open", reason: DropReason.TooFast },
    ]);
  });

  it("keeps one dropped row per name, reason and property", () => {
    const again = { ...DROPPED, count: 2 };
    const other = { ...DROPPED, reason: DropReason.BadValue, property: "meta" };
    const third = { ...other, property: "kind" };
    assert.deepEqual(read(wire({ dropped: [DROPPED, again, other, third] }))?.dropped, [DROPPED, other, third]);
  });

  it("takes every reason the contract names", () => {
    const dropped = Object.values(DropReason).map((reason, index) => ({ ...DROPPED, name: `event_${index}`, reason }));
    assert.deepEqual(
      read(wire({ dropped }))?.dropped.map((row) => row.reason),
      Object.values(DropReason),
    );
  });

  it("keeps no more dropped rows than a page shows", () => {
    const dropped = Array.from({ length: DROPPED_ROWS_MAX + 300 }, (_, index) => ({
      ...DROPPED,
      name: `Bad ${index}`,
    }));
    const kept = read(wire({ dropped }))?.dropped ?? assert.fail();
    assert.equal(kept.length, DROPPED_ROWS_MAX);
    assert.equal(kept[0]?.name, "Bad 0", "the first ones sent, which were dropped most");
  });

  it("falls back to the app's own limit, field by field, where genex.games sent none it can use", () => {
    const table: [string, unknown, EventsStatus["limits"]][] = [
      ["no limits", undefined, EVENT_LIMITS],
      ["null", null, EVENT_LIMITS],
      ["a list", [40, 200], EVENT_LIMITS],
      ["text", "default", EVENT_LIMITS],
      ["an empty object", {}, EVENT_LIMITS],
      [
        "its own numbers",
        { nameLength: 64, names: 500, properties: 32, textLength: 400, batchSeconds: 2, keptDays: 365 },
        {
          nameLength: 64,
          names: 500,
          properties: 32,
          textLength: 400,
          batchSeconds: 2,
          keptDays: 365,
        },
      ],
      ["one number of its own", { names: 500 }, { ...EVENT_LIMITS, names: 500 }],
      ["a zero", { ...EVENT_LIMITS, nameLength: 0 }, EVENT_LIMITS],
      ["a negative number", { ...EVENT_LIMITS, names: -200 }, EVENT_LIMITS],
      ["a fraction", { ...EVENT_LIMITS, batchSeconds: 2.5, keptDays: 30 }, { ...EVENT_LIMITS, keptDays: 30 }],
      [
        "a number as text",
        { ...EVENT_LIMITS, properties: "20", textLength: 100 },
        { ...EVENT_LIMITS, textLength: 100 },
      ],
      ["not a number", { ...EVENT_LIMITS, keptDays: Number.NaN }, EVENT_LIMITS],
      ["no end", { ...EVENT_LIMITS, textLength: Number.POSITIVE_INFINITY }, EVENT_LIMITS],
      ["a null", { ...EVENT_LIMITS, properties: null }, EVENT_LIMITS],
    ];
    for (const [name, limits, expected] of table) assert.deepEqual(read(wire({ limits }))?.limits, expected, name);
  });
});

describe("the fixture account's events as they arrive", () => {
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
  const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
  const sampleOf = (slug: string, account: FixtureAccount = FixtureAccount.Full, now = NOW): GameSample => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, 30, now);
  };
  /** The status of a game from an origin, on the launch's own clock. */
  const statusOf = (slug: string, origin: EventOrigin, account?: FixtureAccount, now = NOW): EventsStatus =>
    fixtureEventsStatus(sampleOf(slug, account, now), origin, now);
  const automatic: ReadonlySet<string> = new Set(Object.values(AutoEvent));
  const times = (status: EventsStatus): number[] => status.recent.map((event) => Date.parse(event.at));
  const newestFirst = (status: EventsStatus): boolean =>
    times(status).every((at, index, all) => index === 0 || at <= (all[index - 1] ?? 0));

  it("gives its richest game a steady stream of its own and Genex's events, newest first, none ahead of the clock", () => {
    const status = statusOf("skate", EventOrigin.Published);
    assert.equal(sampleOf("skate").kind, SampleKind.Rich);
    assert.deepEqual(
      [status.game, status.origin, status.limits],
      [sampleOf("skate").game, EventOrigin.Published, EVENT_LIMITS],
    );
    assert.ok(
      status.recent.length >= 20 && status.recent.length <= RECENT_EVENTS_MAX,
      `${status.recent.length} events`,
    );
    assert.ok(newestFirst(status));
    assert.ok(times(status).every((at) => at <= NOW));
    assert.ok(NOW - (times(status)[0] ?? 0) < 10 * SECOND_MS, "the newest came a few seconds ago");
    assert.equal(status.lastAt, status.recent[0]?.at);
    const names = new Set(status.recent.map((event) => event.name));
    const own = [...names].filter((name) => !automatic.has(name));
    assert.ok(own.length >= 3, `the game's own events: ${own.join(", ")}`);
    assert.ok(names.size > own.length, "and the ones Genex counts");
    assert.ok(own.length <= status.names, "no more names in the stream than the game has used");
    assert.equal(status.names, 8);
    for (const event of status.recent) {
      assert.match(event.name, EVENT_NAME);
      assert.ok(
        event.properties.every((property) => EVENT_NAME.test(property.name)),
        event.name,
      );
    }
  });

  it("moves its stream with the clock: a read a few seconds later has newer events over the ones before", () => {
    const first = statusOf("skate", EventOrigin.Published);
    const later = statusOf("skate", EventOrigin.Published, FixtureAccount.Full, NOW + 9 * SECOND_MS);
    assert.ok((times(later)[0] ?? 0) > (times(first)[0] ?? 0), "something new arrived");
    const kept = later.recent.findIndex((event) => event.at === first.recent[0]?.at);
    assert.ok(kept > 0, "what was newest moved down");
    assert.deepEqual(later.recent.slice(kept, kept + 5), first.recent.slice(0, 5), "and is the same event it was");
    assert.deepEqual(statusOf("skate", EventOrigin.Published), first, "the same moment is the same answer");
  });

  it("shows what was dropped from the richest game over the last day, as the page was designed", () => {
    const { dropped } = statusOf("skate", EventOrigin.Published);
    assert.deepEqual(
      dropped.map((row) => [row.name, row.reason, row.property, row.count]),
      [
        ["Level Complete", DropReason.BadName, null, 41],
        ["powerup_used", DropReason.BadValue, "meta", 7],
      ],
    );
    for (const row of dropped) {
      const ago = NOW - Date.parse(row.lastAt);
      assert.ok(ago > 0 && ago < DAY_MS, `${row.name}: within the last 24 hours`);
    }
  });

  it("gives the preview a few events from one test, the same on every read, and nothing dropped", () => {
    const status = statusOf("skate", EventOrigin.Preview);
    assert.equal(status.origin, EventOrigin.Preview);
    assert.ok(status.recent.length >= 3 && status.recent.length <= 8, `${status.recent.length} events`);
    assert.ok(newestFirst(status));
    assert.ok(times(status).every((at) => at < NOW));
    assert.equal(status.lastAt, status.recent[0]?.at);
    assert.deepEqual(status.dropped, []);
    assert.ok(
      status.recent.some((event) => !automatic.has(event.name)),
      "the game's own events too",
    );
    const later = statusOf("skate", EventOrigin.Preview, FixtureAccount.Full, NOW + 5 * SECOND_MS);
    assert.deepEqual(later.recent, status.recent, "a test that ended does not move");
  });

  it("gives a game whose build cannot send events only the ones Genex counts", () => {
    for (const origin of Object.values(EventOrigin)) {
      const status = statusOf("lost-cathedral", origin);
      assert.equal(status.game.eventsReady, false);
      assert.ok(status.recent.length > 0, origin);
      assert.deepEqual(
        status.recent.filter((event) => !automatic.has(event.name)),
        [],
        origin,
      );
      assert.deepEqual([status.names, status.dropped], [0, []], origin);
      assert.ok(newestFirst(status));
    }
  });

  it("gives the young game a few of Genex's events, no events of its own and an empty preview", () => {
    const published = statusOf("stick-steel", EventOrigin.Published);
    assert.equal(sampleOf("stick-steel").kind, SampleKind.Young);
    assert.ok(published.recent.length >= 1 && published.recent.length <= 6, `${published.recent.length} events`);
    assert.deepEqual(
      published.recent.filter((event) => !automatic.has(event.name)),
      [],
    );
    assert.ok(
      published.recent.every((event) => event.name !== AutoEvent.Purchase),
      "nobody has paid yet",
    );
    assert.deepEqual([published.names, published.dropped], [0, []]);
    const preview = statusOf("stick-steel", EventOrigin.Preview);
    assert.deepEqual([preview.recent, preview.dropped, preview.lastAt, preview.names], [[], [], null, 0]);
  });

  it("has nothing arriving for a game nobody plays, and remembers when its last event came", () => {
    const status = statusOf("skate", EventOrigin.Published, FixtureAccount.Quiet);
    assert.deepEqual([status.recent, status.dropped], [[], []]);
    const last = Date.parse(status.lastAt ?? assert.fail("no last event"));
    assert.ok(NOW - last > 13 * DAY_MS && NOW - last < 16 * DAY_MS, "two weeks ago");
  });

  it("dates its events by the reports' own lag until it is handed the clock", () => {
    const sample = sampleOf("skate");
    const lagging = fixtureEventsStatus(sample, EventOrigin.Published);
    const computedAt = Date.parse(sample.window.computedAt);
    assert.ok(times(lagging).every((at) => at <= computedAt));
    assert.ok(computedAt - (times(lagging)[0] ?? 0) < 10 * SECOND_MS);
    assert.ok(NOW - computedAt >= MINUTE_MS, "the reports are minutes behind");
  });

  it("answers a status the real parser reads, for every game, origin and account, exactly as it was made", () => {
    const made = createFixtureGameAnalytics({ now: () => NOW });
    for (const account of [FixtureAccount.Full, FixtureAccount.Quiet, FixtureAccount.Fresh]) {
      for (const { slug } of ownSamples(account, catalog)) {
        for (const origin of Object.values(EventOrigin)) {
          const name = `${slug} from ${origin} as ${account}`;
          const answer = made.answer(
            eventsStatusRoute(slug, origin),
            { method: "GET", token: fixtureAccountToken(account) },
            catalog,
          );
          assert.equal(answer?.status, 200, name);
          const status = toEventsStatus(answer?.body, slug, origin, true) ?? assert.fail(`${name} does not read`);
          assert.deepEqual(status, JSON.parse(JSON.stringify(answer?.body)), `${name} loses nothing`);
          // Dated by the reports' own lag, or by the launch's clock once the route hands it to the builder.
          const builds = [undefined, NOW].map((at) => fixtureEventsStatus(sampleOf(slug, account), origin, at));
          assert.ok(
            builds.some((one) => JSON.stringify(one) === JSON.stringify(status)),
            `${name} is what the builder makes`,
          );
        }
      }
    }
  });
});

/** What the tests reach in the renderer build: the tab's view model, its page and React's server renderer. */
interface SdkBundle {
  view: typeof import("../../src/renderer/play/game-analytics/sdk-view.ts");
  SdkPage: (props: SdkPageProps) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The tab as the plain renderer build compiles it. */
async function sdkBundle(): Promise<SdkBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/sdk-view.ts";',
        'export { SdkPage } from "./src/renderer/play/game-analytics/SdkPage.tsx";',
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

/** The moment the fixture answers are made at: the design's own. */
const PAGE_NOW = Date.parse("2026-11-17T12:04:00.000Z");

/** A fixture game of `kind`: the rich one has an app build and sends its own events, the steady one's build cannot. */
const sourceOf = (kind: SampleKind): SampleSource => ({
  slug: SLUG,
  title: "Lantern Run",
  coverUrl: null,
  plays: 30_000,
  playingNow: 38,
  hasAppBuild: kind === SampleKind.Rich,
  kind,
  dormant: false,
});

/** The status a fixture launch gives for a game from an origin, as it crosses the wire and the real parser. */
function madeStatus(kind: SampleKind, origin: EventOrigin = EventOrigin.Published, now = PAGE_NOW): EventsStatus {
  const sample = gameSample(sourceOf(kind), 30, now);
  const wire: unknown = JSON.parse(JSON.stringify(fixtureEventsStatus(sample, origin, now)));
  return toEventsStatus(wire, SLUG, origin, true) ?? assert.fail(`the ${kind} game's ${origin} status does not read`);
}

/** The words a reader meets in `markup`: tags gone, spaces single, the markup's escapes read back. */
const words = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** Every match of `pattern` in `markup`, a line break in it included. */
const matches = (markup: string, pattern: RegExp): string[] => markup.match(new RegExp(pattern.source, "gs")) ?? [];
/** One section of the page, from its opening tag to the next section's: the code sample's own `<section>` is inside it. */
const sectionOf = (markup: string, id: string): string =>
  markup
    .split('<section class="game-analytics-section" ')
    .find((chunk) => chunk.startsWith(`data-game-analytics-section="${id}"`)) ?? "";
/** The rows of the events table, without its heading. */
const eventRows = (markup: string): string[] =>
  matches(
    sectionOf(markup, "live"),
    /<div role="row" class="game-analytics-row" data-game-analytics-row=.*?(?=<div role="row"|<\/div><\/div><p class="game-analytics-section-footnote">)/,
  );

const noop = (): void => {};

let bundle: SdkBundle;
before(async () => {
  bundle = await sdkBundle();
});
// The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
beforeEach(() => setLocale(Locale.Japanese, {}));
after(() => setLocale(Locale.English, {}));

describe("what the SDK tab derives for display", () => {
  const event = (over: Partial<EventsStatus["recent"][number]> = {}): EventsStatus["recent"][number] => ({
    ...EVENT,
    ...over,
  });

  it("lists every event Genex counts with no code, in the contract's order, with a line each", () => {
    const rows = bundle.view.autoRows();
    assert.deepEqual(
      rows.map((row) => row.id),
      Object.values(AutoEvent),
    );
    assert.ok(rows.every((row) => row.detail !== ""));
    assert.equal(new Set(rows.map((row) => row.detail)).size, rows.length, "no two events share a line");
  });

  it("writes a code sample with one import, one track call and one setPlayer call", () => {
    const sample = bundle.view.sdkSample();
    const lines = sample.split("\n");
    assert.equal(lines[0], `import { track, setPlayer } from "${bundle.view.SDK_PACKAGE}";`);
    assert.equal(bundle.view.SDK_PACKAGE, "@genex-ai/embed-sdk");
    assert.equal(lines.filter((line) => line.startsWith("track(")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("setPlayer(")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("//")).length, 2, "each call says when to make it");
    const sent = /^track\("([^"]+)"/m.exec(sample)?.[1] ?? "";
    assert.match(sent, EVENT_NAME, "the sample's own event is a name genex.games takes");
    assert.ok(!(Object.values(AutoEvent) as string[]).includes(sent), "and not one Genex counts itself");
    assert.ok(sample.length < 600);
  });

  it("groups every name that fills in a report exactly once, with the report it fills", () => {
    const groups = bundle.view.knownGroups();
    assert.deepEqual(groups.flatMap((group) => group.names).sort(), Object.values(KnownEvent).sort());
    const byId = Object.fromEntries(groups.map((group) => [group.id, group]));
    assert.deepEqual(byId.levels?.names, [KnownEvent.LevelStart, KnownEvent.LevelComplete, KnownEvent.LevelFail]);
    assert.equal(byId.levels?.withProperty, "with level");
    assert.equal(byId.matches?.withProperty, "with players");
    assert.equal(byId.tutorial?.withProperty, null);
    assert.ok(byId.levels?.detail.endsWith("Engagement"));
    assert.ok(byId.tutorial?.detail.endsWith("Acquisition"));
    assert.ok(byId.tutorial?.detail.includes("30 s"), "the engaged play of the contract");
  });

  it("writes an event's row with how long ago it arrived, from the clock it is given", () => {
    const lines = bundle.view.eventLines(
      [
        event({ at: "2026-11-17T12:03:48.000Z" }),
        event({ at: "2026-11-17T12:03:00.000Z", name: AutoEvent.PlayStart, properties: [] }),
      ],
      PAGE_NOW,
    );
    assert.deepEqual(
      lines.map((line) => [line.ago, line.name, line.automatic, line.player]),
      [
        [formatAgo("2026-11-17T12:03:48.000Z", PAGE_NOW), "level_complete", false, "US · computer"],
        [formatAgo("2026-11-17T12:03:00.000Z", PAGE_NOW), "play_start", true, "US · computer"],
      ],
    );
    assert.equal(lines[0]?.summary, "level 4\ntime_s 81");
    assert.equal(lines[1]?.summary, "");
    const later = bundle.view.eventLines([event()], PAGE_NOW + 5 * MINUTE_MS);
    assert.notEqual(later[0]?.ago, lines[0]?.ago, "the same event is older a later clock");
  });

  it("tells two identical events apart, so a row never shares an id", () => {
    const lines = bundle.view.eventLines([event(), event(), event({ name: "other" }), event()], PAGE_NOW);
    assert.equal(new Set(lines.map((line) => line.id)).size, 4);
    assert.deepEqual(bundle.view.eventLines([], PAGE_NOW), []);
  });

  it("says why the list is empty for the origin shown, and when the last event came for the published game", () => {
    const { live } = { live: bundle.view.liveEmpty };
    assert.match(live(EventOrigin.Published, null, PAGE_NOW), /^No events yet\./);
    assert.equal(
      live(EventOrigin.Published, "2026-11-15T12:04:00.000Z", PAGE_NOW),
      `Nothing arrived lately. The last event came ${formatAgo("2026-11-15T12:04:00.000Z", PAGE_NOW)}.`,
    );
    assert.match(live(EventOrigin.Preview, null, PAGE_NOW), /^No preview events yet\./);
    assert.equal(
      live(EventOrigin.Preview, "2026-11-15T12:04:00.000Z", PAGE_NOW),
      live(EventOrigin.Preview, null, PAGE_NOW),
    );
  });

  it("suggests the name a dropped event could have been sent under, and none when there is no obvious one", () => {
    const table: [string, string, string | null][] = [
      ["Level Complete", "a name with capitals and a space", "level_complete"],
      ["level-complete", "dashes", "level_complete"],
      ["  Boss  Fight!! ", "spaces and marks around it", "boss_fight"],
      ["level_complete", "already a name", null],
      ["2nd level", "starts with a digit", null],
      ["Play Start", "one Genex counts itself", null],
      ["Purchase", "one Genex counts itself, in capitals", null],
      ["!!!", "nothing of it is left", null],
      ["игра", "no letters a name may have", null],
    ];
    for (const [name, why, suggestion] of table) assert.equal(bundle.view.suggestName(name, 40), suggestion, why);
    const cut = bundle.view.suggestName("A Very Long Name That Goes On And On And On", 12);
    assert.equal(cut, "a_very_long");
    assert.ok((cut ?? "").length <= 12);
  });

  it("says in one sentence per reason what to send instead, naming the property when the reason is about one", () => {
    const row = (
      reason: DropReason,
      over: Partial<EventsStatus["dropped"][number]> = {},
    ): EventsStatus["dropped"][number] => ({
      ...DROPPED,
      reason,
      property: null,
      ...over,
    });
    const limits = { ...EVENT_LIMITS, nameLength: 33, names: 77, properties: 13, textLength: 111 };
    const sentence = (reason: DropReason, over = {}): string =>
      bundle.view.droppedLines([row(reason, over)], limits, PAGE_NOW)[0]?.sentence ?? "";
    assert.equal(
      sentence(DropReason.BadName, { name: "Level Complete" }),
      "Names are lower case letters, digits and underscores. Send level_complete.",
    );
    assert.match(
      sentence(DropReason.BadName, { name: "2nd level" }),
      /start with a letter, and run up to 33 characters/,
    );
    assert.equal(
      sentence(DropReason.ReservedName, { name: "purchase" }),
      "Genex counts purchase itself. Send your event under another name.",
    );
    assert.match(sentence(DropReason.TooManyNames), /already uses 77 names/);
    assert.match(sentence(DropReason.TooManyProperties), /more than 13 properties\. Send 13 or fewer/);
    assert.match(
      sentence(DropReason.BadValue, { property: "meta" }),
      /^The property meta isn’t text, a number, or true or false\./,
    );
    assert.match(sentence(DropReason.BadValue), /^A property isn’t text, a number, or true or false\./);
    assert.match(
      sentence(DropReason.TextTooLong, { property: "note" }),
      /^The property note is longer than 111 characters\./,
    );
    assert.match(sentence(DropReason.TextTooLong), /^A text is longer than 111 characters\./);
    assert.match(sentence(DropReason.TooFast), /^Events came faster than Genex takes them\./);
    for (const reason of Object.values(DropReason)) assert.notEqual(sentence(reason, { property: "p" }), "", reason);
  });

  it("counts a dropped row in whole events and dates its last one by the clock", () => {
    const [one = assert.fail(), many = assert.fail()] = bundle.view.droppedLines(
      [
        { ...DROPPED, count: 1 },
        { ...DROPPED, name: "other", count: 41, lastAt: "2026-11-17T09:04:00.000Z" },
      ],
      EVENT_LIMITS,
      PAGE_NOW,
    );
    assert.deepEqual([one.count, many.count], ["1 event", "41 events"]);
    assert.equal(many.last, `last ${formatAgo("2026-11-17T09:04:00.000Z", PAGE_NOW)}`);
    assert.notEqual(one.id, many.id);
    assert.deepEqual(bundle.view.droppedLines([], EVENT_LIMITS, PAGE_NOW), []);
  });

  it("writes the rules from the limits genex.games sent, never from numbers of its own", () => {
    const limits = { nameLength: 33, names: 77, properties: 13, textLength: 111, batchSeconds: 1, keptDays: 45 };
    const lines = bundle.view.ruleLines(limits, 12);
    assert.deepEqual(
      lines.map((line) => line.term),
      ["Names", "Properties", "Delivery", "Players", "Kept for"],
    );
    const text = (id: string): string => (lines.find((line) => line.id === id)?.details ?? []).join(" ");
    assert.match(text("names"), /up to 33 characters\. Up to 77 names in a game\. This game has used 12 of 77\./);
    assert.match(text("properties"), /Up to 13 on an event\. Text up to 111 characters/);
    assert.match(text("delivery"), /every 1 second and when the game closes/);
    assert.match(text("kept"), /Every event for 45 days\./);
    assert.match(text("players"), /Never send a name, an email/);
    const all = lines.flatMap((line) => line.details).join(" ");
    assert.ok(!/\b(40|200|20|90|5)\b/.test(all), `none of the app's own limits: ${all}`);
  });

  it("writes the rules for the app's own limits, and says nothing of names used while none are", () => {
    const lines = bundle.view.ruleLines(EVENT_LIMITS, 0);
    assert.ok(
      !lines
        .flatMap((line) => line.details)
        .join(" ")
        .includes("has used"),
    );
    assert.match((lines[2]?.details ?? []).join(" "), /every 5 seconds/);
    assert.match((lines[4]?.details ?? []).join(" "), /for 90 days/);
  });
});

describe("the SDK tab's face", () => {
  const draw = (status: EventsStatus, over: Partial<SdkPageProps> = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.SdkPage, {
        slug: SLUG,
        refreshing: false,
        stale: false,
        now: PAGE_NOW,
        onOpenTab: noop,
        game: status.game,
        status,
        origin: status.origin,
        onOrigin: noop,
        ...over,
      } satisfies SdkPageProps),
    );
  const rich = madeStatus(SampleKind.Rich);

  it("draws the rich game's page in the mockup's two columns, each block in its place", () => {
    const markup = draw(rich);
    assert.ok(markup.startsWith('<div class="game-analytics-report" data-game-analytics-sdk="true">'));
    assert.deepEqual(
      matches(markup, /data-game-analytics-section="[a-z]+"/).map((attribute) => attribute.split('"')[1]),
      ["counted", "own", "known", "live", "dropped", "rules"],
    );
    const columns = markup.split('<div class="game-analytics-sdk-column">');
    assert.equal(columns.length, 3, "two columns");
    assert.ok(
      columns[1]?.includes('data-game-analytics-section="own"') &&
        !columns[1].includes('data-game-analytics-section="live"'),
    );
    assert.ok(
      columns[2]?.includes('data-game-analytics-section="live"') &&
        columns[2].includes('data-game-analytics-section="rules"'),
    );
  });

  it("names the seven events Genex counts, each with its line", () => {
    const counted = words(sectionOf(draw(rich), "counted"));
    for (const row of bundle.view.autoRows()) assert.ok(counted.includes(`${row.id} ${row.detail}`), row.id);
    assert.equal(matches(sectionOf(draw(rich), "counted"), /<dt>/).length, 7);
  });

  it("gives the code sample with its own Copy, and no way to ask Genex to add the events", () => {
    const own = sectionOf(draw(rich), "own");
    assert.ok(own.includes('data-game-analytics-copy-text="sample"'));
    assert.ok(words(own).includes('import { track, setPlayer } from "@genex-ai/embed-sdk";'));
    assert.ok(words(own).includes('track("level_complete", { level: 4, time_s: 74, deaths: 2 });'));
    assert.ok(words(own).includes('setPlayer({ difficulty: "hard", skin: "storm" });'));
    assert.ok(!own.includes("data-game-analytics-sdk-not-ready"), "a build that can send events says nothing of it");
    for (const status of [
      rich,
      madeStatus(SampleKind.Steady),
      madeStatus(SampleKind.Young),
      madeStatus(SampleKind.Rich, EventOrigin.Preview),
    ]) {
      assert.ok(
        !/ask genex/i.test(words(draw(status))),
        "the SDK that carries these calls has not shipped: no such action",
      );
      assert.ok(!draw(status).includes("data-game-analytics-ask"));
    }
  });

  it("says plainly that a build that cannot send events yet will once it is published again", () => {
    const steady = madeStatus(SampleKind.Steady);
    assert.equal(steady.game.eventsReady, false);
    const own = sectionOf(draw(steady), "own");
    assert.ok(own.includes("data-game-analytics-sdk-not-ready"));
    assert.ok(
      words(own).includes(
        "This game’s published build can’t send its own events yet. They start arriving once you publish it again with a newer Genex SDK.",
      ),
    );
    assert.ok(own.includes('data-game-analytics-copy-text="sample"'), "the sample is still there to add");
  });

  it("lists the names that fill in reports, grouped, with the report each fills", () => {
    const known = sectionOf(draw(rich), "known");
    assert.deepEqual(
      matches(known, /data-game-analytics-known="[a-z]+"/).map((attribute) => attribute.split('"')[1]),
      ["levels", "tutorial", "matches"],
    );
    const text = words(known);
    assert.ok(
      text.includes(
        "level_start level_complete level_fail with level How far players get, and the tries and time each level takes, in Engagement",
      ),
    );
    assert.ok(
      text.includes("tutorial_complete A step between loading the game and playing it for 30 s, in Acquisition"),
    );
    assert.ok(
      text.includes(
        "match_start match_end with players Match length and room size for multiplayer games, in Engagement",
      ),
    );
  });

  it("draws the newest events as rows: how long ago, name, properties as name and value, player", () => {
    const markup = draw(rich);
    const rows = eventRows(markup);
    assert.equal(rows.length, rich.recent.length);
    rich.recent.forEach((event, index) => {
      const row = rows[index] ?? "";
      const pairs = event.properties.map((property) => `${property.name} ${property.value}`).join(" ");
      const expected = [
        formatAgo(event.at, PAGE_NOW),
        event.name,
        event.properties.length > 0 ? pairs : "none",
        event.player,
      ].join(" ");
      assert.equal(words(row), expected, `row ${index}`);
    });
    assert.ok(markup.includes("game-analytics-sdk-event-name"));
    const own = rows.find((row) => row.includes(">level_start<")) ?? "";
    assert.ok(!own.includes("data-automatic"), "the game's own event is not set quiet");
    const counted = rows.find((row) => row.includes(">play_start<")) ?? "";
    assert.ok(counted.includes('data-automatic="true"'), "an event Genex counts is");
    assert.match(markup, /data-game-analytics-table="events"/);
  });

  it("keeps the newest event on top as the clock and the status move", () => {
    const later = PAGE_NOW + 30 * SECOND_MS;
    const newer = madeStatus(SampleKind.Rich, EventOrigin.Published, later);
    const first = eventRows(draw(newer, { now: later }))[0] ?? "";
    assert.ok(words(first).startsWith(formatAgo(newer.recent[0]?.at, later)));
    assert.notEqual(eventRows(draw(newer, { now: later }))[0], eventRows(draw(rich))[0]);
  });

  it("switches between the published game and Studio preview, the one chosen first", () => {
    const published = sectionOf(draw(rich), "live");
    assert.match(published, /data-game-analytics-option="published"/);
    assert.match(
      /<button[^>]*data-game-analytics-option="published"[^>]*>/.exec(published)?.[0] ?? "",
      /aria-checked="true"/,
    );
    assert.match(
      /<button[^>]*data-game-analytics-option="preview"[^>]*>/.exec(published)?.[0] ?? "",
      /aria-checked="false"/,
    );
    const previewStatus = madeStatus(SampleKind.Rich, EventOrigin.Preview);
    const preview = sectionOf(draw(previewStatus), "live");
    assert.match(
      /<button[^>]*data-game-analytics-option="preview"[^>]*>/.exec(preview)?.[0] ?? "",
      /aria-checked="true"/,
    );
    assert.equal(eventRows(draw(previewStatus)).length, previewStatus.recent.length);
    const followed = sectionOf(draw(rich, { origin: EventOrigin.Preview }), "live");
    assert.match(
      /<button[^>]*data-game-analytics-option="preview"[^>]*>/.exec(followed)?.[0] ?? "",
      /aria-checked="true"/,
      "the switch follows the press before the answer lands",
    );
    assert.ok(words(published).includes("Published game Studio preview"));
  });

  it("says that Studio preview's events are never counted, whichever origin is shown", () => {
    const note =
      "Events from Studio preview show under their own switch and are never counted, so you can test freely.";
    for (const status of [rich, madeStatus(SampleKind.Rich, EventOrigin.Preview), madeStatus(SampleKind.Young)]) {
      assert.ok(words(sectionOf(draw(status), "live")).includes(note), status.origin);
    }
  });

  it("says what an empty list means, for each origin", () => {
    const young = madeStatus(SampleKind.Young, EventOrigin.Preview);
    assert.deepEqual(young.recent, []);
    const previewEmpty = sectionOf(draw(young), "live");
    assert.ok(previewEmpty.includes('data-game-analytics-empty="true"'));
    assert.ok(
      words(previewEmpty).includes(
        "No preview events yet. Run your game in Studio preview and its events show up here.",
      ),
    );
    assert.ok(!previewEmpty.includes('role="table"'));
    const quiet = { ...rich, recent: [], dropped: [], lastAt: "2026-11-15T12:04:00.000Z" };
    assert.ok(
      words(sectionOf(draw(quiet), "live")).includes(
        `Nothing arrived lately. The last event came ${formatAgo(quiet.lastAt, PAGE_NOW)}.`,
      ),
    );
    const unheard = { ...quiet, lastAt: null };
    assert.ok(
      words(sectionOf(draw(unheard), "live")).includes(
        "No events yet. They show up here a few seconds after someone plays the published game.",
      ),
    );
  });

  it("lists what was dropped, as the game sent the name, with what to send instead and the count", () => {
    const dropped = sectionOf(draw(rich), "dropped");
    const rows = matches(dropped, /<li class="game-analytics-sdk-dropped-row".*?<\/li>/).map(words);
    assert.deepEqual(rows, [
      `Level Complete Names are lower case letters, digits and underscores. Send level_complete. 41 events last ${formatAgo(rich.dropped[0]?.lastAt, PAGE_NOW)}`,
      `powerup_used The property meta isn’t text, a number, or true or false. Send one of those. 7 events last ${formatAgo(rich.dropped[1]?.lastAt, PAGE_NOW)}`,
    ]);
  });

  it("says in one line that nothing was dropped", () => {
    for (const status of [
      madeStatus(SampleKind.Steady),
      madeStatus(SampleKind.Young),
      madeStatus(SampleKind.Rich, EventOrigin.Preview),
    ]) {
      const dropped = sectionOf(draw(status), "dropped");
      assert.ok(words(dropped).includes("Nothing was dropped. Every event your game sent got through."));
      assert.ok(!dropped.includes("<li"));
    }
  });

  it("writes the rules from the status's own limits", () => {
    const limits = { nameLength: 33, names: 77, properties: 13, textLength: 111, batchSeconds: 1, keptDays: 45 };
    const rules = words(sectionOf(draw({ ...rich, limits }), "rules"));
    assert.ok(
      rules.includes(
        "Names Lower case letters, digits and underscores, starting with a letter, up to 33 characters. Up to 77 names in a game. This game has used 8 of 77.",
      ),
    );
    assert.ok(rules.includes("Properties Up to 13 on an event. Text up to 111 characters, numbers, true or false."));
    assert.ok(rules.includes("Delivery Sent together every 1 second and when the game closes."));
    assert.ok(rules.includes("Players Genex adds who the player is."));
    assert.ok(rules.includes("Kept for Every event for 45 days."));
    assert.ok(!/\b(40|200|90)\b/.test(rules));
    assert.ok(
      words(sectionOf(draw(rich), "rules")).includes("up to 40 characters. Up to 200 names in a game."),
      "the app's own limits when none were sent",
    );
  });

  it("draws a game's words as text: a name or a value that looks like markup is escaped", () => {
    const hostile: EventsStatus = {
      ...rich,
      recent: [
        {
          at: "2026-11-17T12:03:58.000Z",
          name: "<img src=x onerror=alert(1)>",
          player: "<script>alert(1)</script>",
          properties: [{ name: "<b>k</b>", value: '"quoted" & <i>v</i>' }],
        },
      ],
      dropped: [
        {
          name: "<u>bad</u>",
          reason: DropReason.TooFast,
          property: null,
          count: 3,
          lastAt: "2026-11-17T11:00:00.000Z",
        },
      ],
    };
    const markup = draw(hostile);
    for (const tag of ["<img", "<script", "<b>", "<i>", "<u>"]) assert.ok(!markup.includes(tag), tag);
    const text = words(markup);
    for (const phrase of [
      "<img src=x onerror=alert(1)>",
      "<script>alert(1)</script>",
      "<b>k</b>",
      '"quoted" & <i>v</i>',
      "<u>bad</u>",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  it("copes with the longest names and values a game can send", () => {
    const long = "x".repeat(EVENT_LIMITS.textLength);
    const status: EventsStatus = {
      ...rich,
      recent: [
        {
          at: "2026-11-17T12:03:58.000Z",
          name: "n".repeat(EVENT_LIMITS.textLength),
          player: "p".repeat(60),
          properties: Array.from({ length: EVENT_LIMITS.properties }, (_, index) => ({
            name: `property_${index}`,
            value: long,
          })),
        },
      ],
    };
    const [row = ""] = eventRows(draw(status));
    assert.ok(row.includes(`title="property_0 ${long}`), "everything is a hover away");
    assert.equal(matches(row, /game-analytics-sdk-property"/).length, EVENT_LIMITS.properties);
  });
});
