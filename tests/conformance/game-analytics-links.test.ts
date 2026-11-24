/**
 * Campaign links, end to end: how main reads a saved link from genex.games (hostile input: a link
 * that cannot be trusted is left out, a rate not known yet stays null), the links a fixture launch
 * makes up (agreeing with the game's sample over every period), what the page derives for display,
 * and the page's face as React's server renderer draws it from the plain renderer build.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureLinks } from "../../src/main/dev/fixture-game-analytics/fixture-links.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  type GameSample,
  gameSample,
  ownSamples,
  SampleKind,
  type SampleSource,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { savedIdOf } from "../../src/main/play/game-analytics/asked.ts";
import { toCampaignLink, toCampaignLinks } from "../../src/main/play/game-analytics/links.ts";
import { AnalyticsRoute, linksRoute } from "../../src/main/play/game-analytics/routes.ts";
import { formatDay } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { LinkFormProps } from "../../src/renderer/play/game-analytics/links-form.tsx";
import type { SavedLinksProps } from "../../src/renderer/play/game-analytics/links-table.tsx";
import type { LinkDraft } from "../../src/renderer/play/game-analytics/links-view.ts";
import type { LinksPageProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import {
  CAMPAIGN_LINKS_MAX,
  CAMPAIGN_TAG_MAX,
  type CampaignLink,
  campaignUrl,
  INSTALL_CREDIT_DAYS,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import { AnalyticsSaveRefusal } from "../../src/shared/game-analytics-asks.ts";
import { CliInstallRefusal } from "../../src/shared/cli-install.ts";
import { CodedError } from "../../src/shared/errors.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import { dayBefore, STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

const SLUG = "lantern-run";
const WEB = "https://genex.games";
const GAME_URL = `${WEB}/${SLUG}`;
/** Where the game's links may point: its page on the website Play links to, and that website's short links. */
const PLACE = { web: WEB, slug: SLUG };
/** Where a fixture game's links may point. */
const placeOf = (slug: string) => ({ web: PLAY_ORIGIN.web, slug });

/** A saved link as genex.games answers it, every part well formed. */
const LINK: CampaignLink = {
  id: "lnk_7kq2x",
  source: "tiktok",
  medium: "social",
  campaign: "launch_trailer",
  content: "bio_link",
  term: null,
  url: `${GAME_URL}?utm_source=tiktok&utm_medium=social&utm_campaign=launch_trailer&utm_content=bio_link`,
  shortUrl: "https://genex.games/go/7kq2x",
  createdOn: "2026-11-04",
  newVisitors: 2150,
  newPlayers: 940,
  day7: 0.086,
};

/** `LINK` with some of it changed, as untyped JSON. */
const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...LINK, ...over });
/** `LINK` without one of its fields. */
const without = (field: keyof CampaignLink): Record<string, unknown> => {
  const { [field]: _dropped, ...rest } = wire();
  return rest;
};

describe("a saved campaign link as main reads it", () => {
  it("reads a well-formed link exactly as it was sent", () => {
    assert.deepEqual(toCampaignLink(wire(), PLACE), LINK);
  });

  it("keeps what is not known as null: a rate nobody can divide for, tags left out, no short link", () => {
    const read = toCampaignLink(wire({ day7: null, content: null, term: null, shortUrl: null }), PLACE);
    assert.deepEqual(read, { ...LINK, day7: null, content: null, term: null, shortUrl: null });
    assert.equal(
      toCampaignLink(wire({ newVisitors: 0, newPlayers: 0, day7: null }), PLACE)?.newPlayers,
      0,
      "zero is a count",
    );
  });

  it("reads a tag left empty as left out", () => {
    assert.equal(toCampaignLink(wire({ content: "" }), PLACE)?.content, null);
    assert.equal(toCampaignLink(wire({ term: "   " }), PLACE)?.term, null);
  });

  it("refuses a link with a part that cannot be trusted", () => {
    const long = "a".repeat(CAMPAIGN_TAG_MAX + 1);
    const table: [string, unknown][] = [
      ["not an object", null],
      ["a list", [wire()]],
      ["text", "link"],
      ["no id", without("id")],
      ["an empty id", wire({ id: "" })],
      ["an id that is a path", wire({ id: "../links" })],
      ["an id with a space", wire({ id: "lnk 1" })],
      ["an id that is a number", wire({ id: 7 })],
      ["an id too long to send back", wire({ id: "a".repeat(400) })],
      ["no source", without("source")],
      ["a source that is a number", wire({ source: 4 })],
      ["an empty source", wire({ source: " " })],
      ["a source over the limit", wire({ source: long })],
      ["no medium", without("medium")],
      ["a medium over the limit", wire({ medium: long })],
      ["no campaign", without("campaign")],
      ["a campaign that is a list", wire({ campaign: ["launch"] })],
      ["a campaign of control characters alone", wire({ campaign: "\u0000\u001b" })],
      ["no content field", without("content")],
      ["content that is a number", wire({ content: 3 })],
      ["content over the limit", wire({ content: long })],
      ["no term field", without("term")],
      ["a term that is an object", wire({ term: {} })],
      ["no address", without("url")],
      ["an address over http", wire({ url: "http://genex.games/lantern-run?utm_source=tiktok" })],
      ["an address that runs a script", wire({ url: "javascript:alert(1)" })],
      ["an address that is a file", wire({ url: "file:///etc/passwd" })],
      ["an address with a sign-in in it", wire({ url: "https://me:secret@genex.games/lantern-run" })],
      ["an address that is not one", wire({ url: "genex.games/lantern-run" })],
      ["an address that is a number", wire({ url: 12 })],
      ["an address too long to show", wire({ url: `${GAME_URL}?utm_source=${"a".repeat(5000)}` })],
      ["an address off Genex", wire({ url: "https://evil.example/lantern-run?utm_source=a" })],
      [
        "an address on a host that only starts like Genex's",
        wire({ url: "https://genex.games.evil.example/lantern-run" }),
      ],
      ["an address on another port", wire({ url: "https://genex.games:8443/lantern-run?utm_source=a" })],
      ["an address on a subdomain", wire({ url: "https://evil.genex.games/lantern-run?utm_source=a" })],
      ["another game's page", wire({ url: "https://genex.games/another-game?utm_source=a" })],
      ["a page under the game's", wire({ url: "https://genex.games/lantern-run/elsewhere?utm_source=a" })],
      ["Genex's own home page", wire({ url: "https://genex.games/?utm_source=a" })],
      ["no day", without("createdOn")],
      ["a day that is a time", wire({ createdOn: "2026-11-04T10:00:00.000Z" })],
      ["a day that does not exist", wire({ createdOn: "2026-02-31" })],
      ["a negative count", wire({ newVisitors: -1 })],
      ["a fractional count", wire({ newPlayers: 9.5 })],
      ["a count as text", wire({ newVisitors: "2150" })],
      ["a missing count", without("newPlayers")],
      ["a count that is not a number", wire({ newVisitors: Number.NaN })],
      ["a rate over one", wire({ day7: 8.6 })],
      ["a negative rate", wire({ day7: -0.1 })],
      ["a rate as text", wire({ day7: "0.086" })],
      ["a missing rate", without("day7")],
    ];
    for (const [name, value] of table) assert.equal(toCampaignLink(value, PLACE), null, name);
  });

  it("drops a short link that is not an address on Genex and keeps the link", () => {
    const table: unknown[] = [
      "https://bit.ly.evil.example/zz",
      "https://evil.example/go/7kq2x",
      "https://genex.games.evil.example/go/7kq2x",
      "http://genex.games/go/7kq2x",
      "javascript:alert(1)",
      "genex.games/go/7kq2x",
      "https://me:secret@genex.games/go/7kq2x",
      7,
      {},
      "",
      undefined,
    ];
    for (const shortUrl of table) {
      const read = toCampaignLink(wire({ shortUrl }), PLACE);
      assert.deepEqual(read, { ...LINK, shortUrl: null }, String(shortUrl));
    }
  });

  it("cleans a tag of the characters that turn text around or control a terminal", () => {
    const read = toCampaignLink(
      wire({ source: "tik‮tok", medium: "\u0000social\u001b[31m", campaign: " launch trailer ", content: "⁦bio⁩" }),
      PLACE,
    );
    assert.deepEqual(
      [read?.source, read?.medium, read?.campaign, read?.content],
      ["tiktok", "social[31m", "launchtrailer", "bio"],
    );
  });

  it("writes an address the way a browser reads it", () => {
    const read = toCampaignLink(
      wire({ url: " HTTPS://Genex.Games/lantern-run?utm_source=tik‮tok ", shortUrl: null }),
      PLACE,
    );
    assert.equal(read?.url, "https://genex.games/lantern-run?utm_source=tiktok");
  });
});

describe("a game's saved campaign links as main reads them", () => {
  it("answers null for a body with no list of links: a broken answer is never an empty list", () => {
    for (const body of [null, undefined, {}, [], "ok", 3, { links: null }, { links: "none" }, { links: {} }, [wire()]])
      assert.equal(toCampaignLinks(body, PLACE), null, JSON.stringify(body));
  });

  it("reads an empty list as no links", () => {
    assert.deepEqual(toCampaignLinks({ links: [] }, PLACE), []);
  });

  it("leaves a malformed link out and keeps the rest, in the order sent", () => {
    const links = [
      wire({ id: "a" }),
      wire({ id: "b", url: "http://genex.games/lantern-run" }),
      null,
      "link",
      wire({ id: "c", day7: 2 }),
      wire({ id: "d", shortUrl: "ftp://genex.games/go/1", day7: null }),
    ];
    assert.deepEqual(toCampaignLinks({ links }, PLACE), [
      { ...LINK, id: "a" },
      { ...LINK, id: "d", shortUrl: null, day7: null },
    ]);
  });

  it("keeps one link per id: the first sent", () => {
    const read = toCampaignLinks(
      { links: [wire({ id: "a", newPlayers: 1 }), wire({ id: "a", newPlayers: 2 })] },
      PLACE,
    );
    assert.deepEqual(
      read?.map((link) => [link.id, link.newPlayers]),
      [["a", 1]],
    );
  });

  it("keeps no more links than a game may have", () => {
    const links = Array.from({ length: CAMPAIGN_LINKS_MAX + 400 }, (_, index) => wire({ id: `lnk_${index}` }));
    const read = toCampaignLinks({ links }, PLACE) ?? assert.fail();
    assert.equal(read.length, CAMPAIGN_LINKS_MAX);
    assert.equal(read[0]?.id, "lnk_0", "the first ones sent");
    assert.equal(read.at(-1)?.id, `lnk_${CAMPAIGN_LINKS_MAX - 1}`);
  });
});

describe("the fixture account's campaign links", () => {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const TODAY = "2026-11-17";
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
  const full = fixtureAccountToken(FixtureAccount.Full);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full): GameSample => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  const linksOf = (slug: string, days: StatsPeriod, account?: FixtureAccount): CampaignLink[] =>
    fixtureLinks(sampleOf(slug, days, account)).links;
  /** What the Campaigns channel brought the game over the period. */
  const paid = (sample: GameSample) =>
    sample.channels.find((channel) => channel.channel === SourceChannel.Campaigns) ??
    assert.fail("no Campaigns channel");
  const fixture = () => createFixtureGameAnalytics({ now: () => NOW });

  it("gives its richest game the six links the page was designed with, over 30 days", () => {
    assert.equal(sampleOf("skate", 30).kind, SampleKind.Rich);
    assert.deepEqual(
      linksOf("skate", 30).map((link) => [
        link.campaign,
        link.content,
        link.source,
        link.medium,
        link.newVisitors,
        link.newPlayers,
        link.day7,
        link.createdOn,
      ]),
      [
        ["launch_trailer", "bio_link", "tiktok", "social", 2150, 940, 0.086, dayBefore(TODAY, 13)],
        ["launch_trailer", "pinned_comment", "tiktok", "social", 1270, 520, 0.075, dayBefore(TODAY, 12)],
        ["devlog_12", "description", "youtube", "video", 1180, 520, 0.149, dayBefore(TODAY, 20)],
        ["halloween_update", "announcement", "discord", "community", 640, 310, 0.197, dayBefore(TODAY, 21)],
        ["newsletter_oct", "cta_button", "email", "newsletter", 410, 130, 0.123, dayBefore(TODAY, 26)],
        ["reddit_webgames", "post", "reddit", "social", 360, 60, 0.067, dayBefore(TODAY, 28)],
      ],
    );
  });

  it("agrees with the game's sample over every period: the campaign's links bring what the campaign did, all of them what the Campaigns channel did", () => {
    for (const days of STATS_PERIODS) {
      const sample = sampleOf("skate", days);
      const links = linksOf("skate", days);
      const campaign = sample.campaign ?? assert.fail(`no campaign over ${days} days`);
      const own = links.filter((link) => link.campaign === campaign.name);
      assert.equal(links[0]?.campaign, campaign.name, `${days} days: the first link is the sample's campaign`);
      assert.equal(own.length, 2);
      assert.ok(
        own.every((link) => link.source === campaign.source && link.medium === campaign.medium),
        `${days} days`,
      );
      assert.equal(sum(own.map((link) => link.newVisitors)), campaign.newVisitors, `${days} days: campaign visitors`);
      assert.equal(sum(own.map((link) => link.newPlayers)), campaign.newPlayers, `${days} days: campaign players`);
      assert.equal(
        sum(links.map((link) => link.newVisitors)),
        paid(sample).newVisitors,
        `${days} days: channel visitors`,
      );
      assert.equal(sum(links.map((link) => link.newPlayers)), paid(sample).newPlayers, `${days} days: channel players`);
      const players = sum(own.map((link) => link.newPlayers));
      const kept = sum(own.map((link) => (link.day7 ?? 0) * link.newPlayers));
      assert.ok(
        Math.abs(kept / players - campaign.day7) < 0.002,
        `${days} days: the campaign's Day 7 is its links' mean`,
      );
    }
  });

  it("keeps the same links over every period, with ids main would send back and addresses made of their tags", () => {
    const month = linksOf("skate", 30);
    assert.equal(new Set(month.map((link) => link.id)).size, 6);
    for (const days of STATS_PERIODS) {
      for (const slug of ["skate", "lost-cathedral"]) {
        const links = linksOf(slug, days);
        const tags = (link: CampaignLink) => [
          link.id,
          link.source,
          link.medium,
          link.campaign,
          link.content,
          link.term,
        ];
        assert.deepEqual(links.map(tags), linksOf(slug, 30).map(tags), `${slug} over ${days} days`);
        assert.deepEqual(
          links.map((link) => [link.createdOn, link.url, link.shortUrl]),
          linksOf(slug, 30).map((link) => [link.createdOn, link.url, link.shortUrl]),
          `${slug} over ${days} days`,
        );
        for (const link of links) {
          assert.equal(savedIdOf(link.id), link.id);
          assert.equal(link.url, campaignUrl(`https://genex.games/${slug}`, link), link.id);
          assert.match(link.shortUrl ?? "", /^https:\/\/genex\.games\/go\/[a-z0-9]{5}$/, link.id);
          assert.ok(link.newPlayers <= link.newVisitors, `${link.id} over ${days} days: a player is a visitor`);
          assert.equal(link.day7 === null, link.newPlayers === 0, `${link.id} over ${days} days: no rate with nobody`);
          assert.ok(link.createdOn <= TODAY, link.id);
        }
      }
    }
    const short = month.map((link) => link.shortUrl);
    assert.equal(new Set(short).size, short.length, "every link has a short link of its own");
  });

  it("gives a steady game one link that brings its Campaigns channel and one that has brought nothing yet", () => {
    for (const days of STATS_PERIODS) {
      const sample = sampleOf("lost-cathedral", days);
      assert.equal(sample.kind, SampleKind.Steady);
      const [first, second, ...rest] = linksOf("lost-cathedral", days);
      assert.deepEqual(rest, []);
      assert.deepEqual([first?.newVisitors, first?.newPlayers], [paid(sample).newVisitors, paid(sample).newPlayers]);
      assert.ok((first?.newPlayers ?? 0) > 0, `${days} days: somebody came`);
      assert.ok((first?.day7 ?? 0) > 0 && (first?.day7 ?? 1) < 1, `${days} days: a rate`);
      assert.deepEqual([second?.newVisitors, second?.newPlayers, second?.day7], [0, 0, null]);
      assert.equal(second?.content, null, "a link may leave content out");
    }
  });

  it("gives the young game no links, and the quiet account's games links that brought nobody this week", () => {
    for (const days of STATS_PERIODS) assert.deepEqual(linksOf("stick-steel", days), []);
    assert.deepEqual(linksOf("lost-cathedral", 7, FixtureAccount.Fresh), []);
    const quiet = linksOf("skate", 7, FixtureAccount.Quiet);
    assert.equal(quiet.length, 6);
    assert.deepEqual(
      quiet.map((link) => [link.newVisitors, link.newPlayers, link.day7]),
      quiet.map(() => [0, 0, null]),
    );
    assert.deepEqual(
      quiet.map((link) => link.id),
      linksOf("skate", 30).map((link) => link.id),
    );
  });

  it("answers links the real parser reads, for every game and period, exactly as they were made", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const answer = fixture().answer(linksRoute(slug, days), { method: "GET", token: full }, catalog);
        assert.equal(answer?.status, 200, `${slug} over ${days} days`);
        const sent = isRecord(answer?.body) ? answer.body.links : undefined;
        const read =
          toCampaignLinks(answer?.body, placeOf(slug)) ?? assert.fail(`${slug} over ${days} days does not read`);
        assert.deepEqual(read, JSON.parse(JSON.stringify(sent)), `${slug} over ${days} days loses nothing`);
        assert.deepEqual(read, linksOf(slug, days));
      }
    }
  });

  it("lets a made-up link be removed for the launch, and keeps its ids apart from the ones a save hands out", () => {
    const made = fixture();
    const send = (method: "GET" | "POST" | "DELETE", route: string, body?: unknown) =>
      made.answer(route, { method, token: full, ...(body === undefined ? {} : { body }) }, catalog);
    const ids = (days: StatsPeriod): string[] =>
      (toCampaignLinks(send("GET", linksRoute("skate", days))?.body, placeOf("skate")) ?? []).map((link) => link.id);
    const [first = assert.fail(), second] = ids(30);
    const tags = { source: "x", medium: "social", campaign: "teaser", content: null, term: null };
    const saved =
      toCampaignLink(send("POST", AnalyticsRoute.links("skate"), tags)?.body, placeOf("skate")) ??
      assert.fail("the saved link does not read");
    assert.deepEqual(
      [saved.newVisitors, saved.newPlayers, saved.day7],
      [0, 0, null],
      "a link just saved has brought nothing",
    );
    assert.equal(new Set(ids(30)).size, 7, "seven links, seven ids");
    assert.equal(send("DELETE", AnalyticsRoute.link("skate", first))?.status, 200);
    for (const days of STATS_PERIODS) assert.deepEqual(ids(days).slice(0, 2), [saved.id, second], `${days} days`);
  });
});

/**
 * What the tests reach in the renderer build: the tab's view model, its page and the two blocks
 * that keep no state of their own (the form and the table), and React's server renderer.
 */
interface LinksBundle {
  view: typeof import("../../src/renderer/play/game-analytics/links-view.ts");
  LinksPage: (props: LinksPageProps) => ReactElement;
  NewLinkForm: (props: LinkFormProps) => ReactElement;
  SavedLinks: (props: SavedLinksProps) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The tab as the plain renderer build compiles it. */
async function linksBundle(): Promise<LinksBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/links-view.ts";',
        'export { LinksPage } from "./src/renderer/play/game-analytics/LinksPage.tsx";',
        'export { NewLinkForm } from "./src/renderer/play/game-analytics/links-form.tsx";',
        'export { SavedLinks } from "./src/renderer/play/game-analytics/links-table.tsx";',
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

/** The day the fixture answers end on: the design's own month. */
const PAGE_NOW = Date.parse("2026-11-17T12:04:00.000Z");

/** A fixture game of `kind`; only the rich one has an app build. */
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

/** The links a fixture launch lists for a game, as they cross the wire and the real parser. */
function listedLinks(kind: SampleKind, days: StatsPeriod = 30): CampaignLink[] {
  const wire: unknown = JSON.parse(JSON.stringify(fixtureLinks(gameSample(sourceOf(kind), days, PAGE_NOW))));
  return toCampaignLinks(wire, PLACE) ?? assert.fail(`the ${kind} game's links over ${days} days do not read`);
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
/** Every match of `pattern` in `markup`. */
const matches = (markup: string, pattern: RegExp): string[] => markup.match(new RegExp(pattern.source, "g")) ?? [];
/** The first opening tag in `markup` that carries `attribute`. */
const tagWith = (markup: string, attribute: string): string =>
  new RegExp(`<[a-z]+ [^>]*${attribute}[^>]*>`).exec(markup)?.[0] ?? "";
/** The rows of the saved links' table, from each opening tag to the next row. */
const tableRows = (markup: string): string[] =>
  matches(
    markup,
    /<div role="row" class="game-analytics-row" data-game-analytics-row=.*?(?=<div role="row"|<\/div><\/div><\/section>)/,
  );

const EMPTY: LinkDraft = { source: "", medium: "", campaign: "", content: "" };
const noop = (): void => {};

let bundle: LinksBundle;
before(async () => {
  bundle = await linksBundle();
});
// The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
beforeEach(() => setLocale(Locale.Japanese, {}));
after(() => setLocale(Locale.English, {}));

describe("what the Campaign links tab derives from the form", () => {
  const draft = (over: Partial<LinkDraft> = {}): LinkDraft => ({ ...EMPTY, ...over });
  const full = (over: Partial<LinkDraft> = {}): LinkDraft =>
    draft({ source: "TikTok", medium: "Social", campaign: "Launch Trailer", ...over });
  const view = (typed: LinkDraft, links: CampaignLink[] = [], gameUrl = GAME_URL) =>
    bundle.view.formView(typed, links, gameUrl);

  it("makes the tags a save keeps: lower case, spaces as underscores, content left out when empty", () => {
    assert.deepEqual(bundle.view.draftTags(full()), {
      source: "tiktok",
      medium: "social",
      campaign: "launch_trailer",
      content: null,
      term: null,
    });
    assert.deepEqual(bundle.view.draftTags(full({ source: "  You  Tube ", content: "Bio Link" })), {
      source: "you_tube",
      medium: "social",
      campaign: "launch_trailer",
      content: "bio_link",
      term: null,
    });
    assert.equal(bundle.view.draftTags(full({ content: "   " }))?.content, null, "spaces alone are no content");
  });

  it("leaves out the characters nobody sees, as main would refuse them", () => {
    const tags = bundle.view.draftTags(full({ source: "tik‮tok\u0000", campaign: "launch trailer\u001b" }));
    assert.deepEqual([tags?.source, tags?.campaign], ["tiktok", "launchtrailer"]);
  });

  it("offers a save only with a source, a medium and a campaign, each within the limit", () => {
    const exactly = "a".repeat(CAMPAIGN_TAG_MAX);
    const over = "a".repeat(CAMPAIGN_TAG_MAX + 1);
    const table: [string, LinkDraft, string, string[]][] = [
      ["nothing typed", draft(), "incomplete", []],
      ["no source", full({ source: "" }), "incomplete", []],
      ["a medium of spaces", full({ medium: "   " }), "incomplete", []],
      ["no campaign", full({ campaign: "" }), "incomplete", []],
      ["only content", draft({ content: "bio" }), "incomplete", []],
      ["everything needed", full(), "ready", []],
      ["words at the limit", full({ campaign: exactly, content: exactly }), "ready", []],
      ["a source over the limit", full({ source: over }), "incomplete", ["source"]],
      ["content over the limit", full({ content: over }), "incomplete", ["content"]],
      ["two fields over the limit", full({ medium: over, campaign: over }), "incomplete", ["medium", "campaign"]],
    ];
    for (const [name, typed, step, tooLong] of table) {
      const made = view(typed);
      assert.deepEqual([made.step, made.tooLong], [step, tooLong], name);
      assert.equal(made.tags === null, step !== "ready", `${name}: tags only for a ready draft`);
    }
  });

  it("writes the link as it will be, a tag at a time", () => {
    assert.equal(view(draft()).url, GAME_URL);
    assert.equal(view(draft({ source: "TikTok" })).url, `${GAME_URL}?utm_source=tiktok`);
    const typed = full({ content: "Bio Link" });
    assert.equal(
      view(typed).url,
      campaignUrl(GAME_URL, {
        source: "tiktok",
        medium: "social",
        campaign: "launch_trailer",
        content: "bio_link",
        term: null,
      }),
    );
    assert.equal(
      view(typed).url,
      `${GAME_URL}?utm_source=tiktok&utm_medium=social&utm_campaign=launch_trailer&utm_content=bio_link`,
    );
    assert.equal(
      view(draft({ source: "x" }), [], "not an address").url,
      "not an address",
      "an address that does not parse is left as it is",
    );
  });

  it("knows a saved link that has exactly these tags, whatever the case and the spaces", () => {
    const same = view(full({ source: " TIKTOK ", medium: "social", campaign: "Launch_Trailer", content: "bio link" }), [
      LINK,
    ]);
    assert.deepEqual([same.step, same.saved?.id], ["saved", LINK.id]);
    const noContent = { ...LINK, content: null };
    assert.equal(
      view(full({ source: "tiktok", campaign: "launch_trailer" }), [noContent]).step,
      "saved",
      "no content is no content",
    );
    assert.equal(
      view(full({ source: "tiktok", campaign: "launch_trailer", content: "bio_link" }), [noContent]).step,
      "ready",
    );
    assert.equal(view(full({ source: "tiktok", campaign: "launch_trailer", content: "other" }), [LINK]).step, "ready");
    assert.equal(view(full({ source: "tiktok", campaign: "other" }), [LINK]).saved, null);
  });

  it("says the list is full at the most links, unless these tags are already saved", () => {
    const links = Array.from({ length: CAMPAIGN_LINKS_MAX }, (_, index) => ({
      ...LINK,
      id: `lnk_${index}`,
      campaign: `c${index}`,
    }));
    assert.equal(view(full(), links).step, "full");
    assert.equal(view(draft(), links).step, "full", "a form with nothing in it says so too");
    assert.equal(view(full({ source: "tiktok", campaign: "c7", content: "bio_link" }), links).step, "saved");
    assert.equal(view(full(), links.slice(1)).step, "ready", "one fewer and there is room");
  });

  it("offers the sources saved links use, each once, in the links' order, at most eight", () => {
    const named = (sources: string[]): CampaignLink[] =>
      sources.map((source, index) => ({ ...LINK, id: `l${index}`, source }));
    assert.deepEqual(bundle.view.usedSources(named(["tiktok", "youtube", "TikTok", "discord", "tiktok"])), [
      "tiktok",
      "youtube",
      "discord",
    ]);
    assert.deepEqual(bundle.view.usedSources([]), []);
    const ten = Array.from({ length: 10 }, (_, index) => `s${index}`);
    assert.deepEqual(bundle.view.usedSources(named(ten)), ten.slice(0, 8));
  });
});

describe("what the Campaign links tab derives for the saved links and the credit rules", () => {
  it("writes a saved link's row, with visit to play worked out from its two counts", () => {
    const rows = bundle.view.linkRows(listedLinks(SampleKind.Rich));
    assert.equal(rows.length, 6);
    const [first = assert.fail(), second = assert.fail()] = rows;
    assert.deepEqual(
      [first.campaign, first.content, first.via, first.name, first.newVisitors, first.newPlayers, first.day7],
      ["launch_trailer", "bio_link", "tiktok / social", "launch_trailer, bio_link", 2150, 940, 0.086],
    );
    assert.equal(first.visitToPlay, 940 / 2150);
    assert.equal(second.visitToPlay, 520 / 1270);
    assert.equal(first.created, formatDay(listedLinks(SampleKind.Rich)[0]?.createdOn));
    assert.equal(first.url, listedLinks(SampleKind.Rich)[0]?.url);
  });

  it("keeps what cannot be known empty: no visit to play without visitors, no Day 7 without it, a name without content", () => {
    const [row = assert.fail()] = bundle.view.linkRows([
      { ...LINK, newVisitors: 0, newPlayers: 0, day7: null, content: null },
    ]);
    assert.deepEqual([row.visitToPlay, row.day7, row.content, row.name], [null, null, null, "launch_trailer"]);
    const [brought = assert.fail()] = bundle.view.linkRows([{ ...LINK, newVisitors: 10, newPlayers: 0 }]);
    assert.equal(brought.visitToPlay, 0, "visitors who never played are 0, not unknown");
    const [late] = bundle.view.linkRows([{ ...LINK, newVisitors: 2, newPlayers: 5 }]);
    assert.equal(late?.visitToPlay, null, "more new players than new visitors is no share of them");
    assert.deepEqual(bundle.view.linkRows([]), []);
  });

  it("lists the five rules a visit is credited by, in the order they apply, with the install window from the contract", () => {
    const rules = bundle.view.creditRules();
    assert.deepEqual(
      rules.map((rule) => rule.id),
      ["tags", "site", "genex", "first", "latest"],
    );
    assert.ok(rules.every((rule) => rule.lead !== "" && rule.detail !== ""));
    assert.ok(
      rules[3]?.detail.includes(String(INSTALL_CREDIT_DAYS)),
      "the first source sticks for the contract's days",
    );
    assert.equal(new Set(rules.map((rule) => rule.lead)).size, 5);
  });
});

describe("what a press on Save or Remove does to the tab's state", () => {
  it("clears a refusal when the person types again, and leaves a save in flight or an idle form as it is", () => {
    const { SavePhase, phaseAfterTyping } = bundle.view;
    assert.equal(phaseAfterTyping(SavePhase.Refused), SavePhase.Idle);
    assert.equal(phaseAfterTyping(SavePhase.Full), SavePhase.Idle);
    assert.equal(phaseAfterTyping(SavePhase.Saving), SavePhase.Saving);
    assert.equal(phaseAfterTyping(SavePhase.Idle), SavePhase.Idle);
  });

  it("tells a save refused because the game keeps no more links from one that may work if tried again", () => {
    const { SavePhase, phaseAfterRefusal, phaseAfterRemoval } = bundle.view;
    assert.equal(phaseAfterRefusal(new CodedError(AnalyticsSaveRefusal.Limit, "full")), SavePhase.Full);
    for (const error of [new Error("offline"), new CodedError(CliInstallRefusal.Busy, "busy"), null, "limit"])
      assert.equal(phaseAfterRefusal(error), SavePhase.Refused, String(error));
    assert.equal(phaseAfterRemoval(SavePhase.Full), SavePhase.Idle, "a removal makes room");
    assert.equal(phaseAfterRemoval(SavePhase.Refused), SavePhase.Refused);
    assert.equal(phaseAfterRemoval(SavePhase.Saving), SavePhase.Saving);
  });

  it("asks about one link, then removes it, and the question is over once the call ended", () => {
    const { RemovalStep, removalAsked, removalStarted, removalEnded } = bundle.view;
    assert.deepEqual(removalAsked("a"), { id: "a", step: RemovalStep.Asking, failed: false });
    assert.deepEqual(removalStarted("a"), { id: "a", step: RemovalStep.Removing, failed: false });
    assert.equal(removalEnded(removalStarted("a"), "a", false), null);
  });

  it("asks again, with the refusal said, when a removal is refused", () => {
    const { RemovalStep, removalStarted, removalEnded } = bundle.view;
    assert.deepEqual(removalEnded(removalStarted("a"), "a", true), { id: "a", step: RemovalStep.Asking, failed: true });
  });

  it("lets a call that ended touch only its own link's question", () => {
    const { removalAsked, removalStarted, removalEnded } = bundle.view;
    const other = removalAsked("b");
    assert.equal(
      removalEnded(other, "a", false),
      other,
      "a removal that went through leaves another question standing",
    );
    assert.equal(removalEnded(other, "a", true), other, "so does a refused one");
    assert.equal(removalEnded(null, "a", true), null, "and a call that ended with no question open is nothing");
    assert.deepEqual(removalEnded(removalStarted("b"), "a", false), removalStarted("b"));
  });
});

describe("the Campaign links tab's face", () => {
  const props = (links: CampaignLink[], over: Partial<LinksPageProps> = {}): LinksPageProps => ({
    slug: SLUG,
    refreshing: false,
    stale: false,
    now: PAGE_NOW,
    onOpenTab: noop,
    game: null,
    gameUrl: GAME_URL,
    days: 30,
    links,
    onSave: async () => LINK,
    onRemove: async () => {},
    ...over,
  });
  const drawPage = (links: CampaignLink[], over: Partial<LinksPageProps> = {}): string =>
    bundle.renderToStaticMarkup(bundle.createElement(bundle.LinksPage, props(links, over)));
  const drawForm = (typed: LinkDraft, links: CampaignLink[] = [], over: Partial<LinkFormProps> = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.NewLinkForm, {
        draft: typed,
        view: bundle.view.formView(typed, links, GAME_URL),
        sources: bundle.view.usedSources(links),
        phase: bundle.view.SavePhase.Idle,
        actions: { onType: noop, onPickSource: noop, onSave: noop },
        ...over,
      } satisfies LinkFormProps),
    );
  const drawTable = (links: CampaignLink[], over: Partial<SavedLinksProps> = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.SavedLinks, {
        links,
        days: 30,
        removal: null,
        actions: { onAsk: noop, onKeep: noop, onRemove: noop },
        ...over,
      } satisfies SavedLinksProps),
    );
  const ready: LinkDraft = { source: "TikTok", medium: "Social", campaign: "Launch Trailer", content: "Bio Link" };
  const READY_URL = `${GAME_URL}?utm_source=tiktok&utm_medium=social&utm_campaign=launch_trailer&utm_content=bio_link`;

  it("draws the rich game's page: the form, the five rules and the six saved links", () => {
    const markup = drawPage(listedLinks(SampleKind.Rich));
    assert.ok(markup.startsWith('<div class="game-analytics-report" data-game-analytics-links="true">'));
    assert.deepEqual(matches(markup, /data-game-analytics-link-field="[a-z]+"/), [
      'data-game-analytics-link-field="source"',
      'data-game-analytics-link-field="medium"',
      'data-game-analytics-link-field="campaign"',
      'data-game-analytics-link-field="content"',
    ]);
    const chips = matches(markup, /data-game-analytics-link-source="[a-z]+"/).map(
      (attribute) => attribute.split('"')[1],
    );
    assert.deepEqual(chips, ["tiktok", "youtube", "discord", "email", "reddit"]);
    assert.equal(matches(markup, /<li data-game-analytics-link-rule="[a-z]+"/).length, 5);
    assert.ok(words(markup).includes("Your own plays and plays in Studio preview are never counted."));
    assert.equal(tableRows(markup).length, 6);
    assert.ok(
      words(markup).includes(
        "Tags are saved in lower case with spaces as underscores, so TikTok and tiktok count as one source.",
      ),
    );
  });

  it("draws a form with nothing typed: the plain link with Copy, and no Save to press", () => {
    const markup = drawForm(EMPTY);
    assert.equal(
      words(
        /<div class="game-analytics-links-address"[^>]*data-game-analytics-link-address="link".*?<\/button><\/div>/.exec(
          markup,
        )?.[0] ?? "",
      ),
      `Your link ${GAME_URL} Copy`,
    );
    assert.match(tagWith(markup, 'data-game-analytics-link-save="incomplete"'), / disabled=""/);
    assert.ok(!markup.includes("data-game-analytics-link-short"), "no short link before there is a saved link");
    assert.ok(!markup.includes("data-game-analytics-link-source"), "no chips while no link is saved");
    assert.deepEqual(
      matches(markup, /<input[^>]*>/).map((input) => /required=""/.test(input)),
      [true, true, true, false],
      "content is the one a person may leave out",
    );
    assert.ok(words(markup).includes("optional, tells two links in one campaign apart"));
  });

  it("updates the link as it is typed, and offers Save and Copy for exactly that link", () => {
    const markup = drawForm(ready);
    assert.ok(words(markup).includes(`Your link ${READY_URL} Copy`));
    assert.ok(!/ disabled=""/.test(tagWith(markup, 'data-game-analytics-link-save="ready"')));
    assert.match(
      markup,
      /<input[^>]*data-game-analytics-link-field="source"[^>]*value="TikTok"/,
      "what was typed stays as it was typed",
    );
    assert.ok(markup.includes('data-game-analytics-copy-text="link"'));
  });

  it("shows the short link of the saved link that has these tags, with its own Copy", () => {
    const markup = drawForm(ready, [LINK]);
    assert.equal(
      tagWith(markup, 'data-game-analytics-link-save="saved"').includes(' disabled=""'),
      true,
      "Saved is not pressed again",
    );
    assert.ok(words(markup).includes("Saved"));
    const short =
      /<div class="game-analytics-links-address"[^>]*data-game-analytics-link-address="short".*?<\/button><\/div>/.exec(
        markup,
      )?.[0] ?? "";
    assert.equal(words(short), `Short link, for places that cut long links or strip the tags ${LINK.shortUrl} Copy`);
    assert.ok(short.includes('data-game-analytics-copy-text="short"'));
    const noShort = drawForm(ready, [{ ...LINK, shortUrl: null }]);
    assert.ok(!noShort.includes('data-game-analytics-link-address="short"'), "a link with no short link shows none");
    assert.ok(noShort.includes('data-game-analytics-link-save="saved"'));
  });

  it("says the list is full in place of Save", () => {
    const links = Array.from({ length: CAMPAIGN_LINKS_MAX }, (_, index) => ({
      ...LINK,
      id: `lnk_${index}`,
      campaign: `c${index}`,
    }));
    const markup = drawForm(ready, links);
    assert.ok(!markup.includes("data-game-analytics-link-save"), "no Save");
    assert.ok(
      words(markup).includes(
        `This game already keeps ${CAMPAIGN_LINKS_MAX} saved links, the most it can. Remove one to save another.`,
      ),
    );
  });

  it("shows a refusal beside the form and keeps what was typed, and shows a save in flight", () => {
    const refused = drawForm(ready, [], { phase: bundle.view.SavePhase.Refused });
    assert.match(refused, /role="alert"[^>]*data-game-analytics-link-refused/);
    assert.ok(words(refused).includes("Couldn’t save this link. Try again."));
    assert.ok(!/ disabled=""/.test(tagWith(refused, 'data-game-analytics-link-save="ready"')), "it can be tried again");
    assert.ok(!drawForm(ready).includes("data-game-analytics-link-refused"));
    const saving = drawForm(ready, [], { phase: bundle.view.SavePhase.Saving });
    assert.match(tagWith(saving, 'data-game-analytics-link-save="ready"'), /aria-busy="true"/);
    assert.ok(words(saving).includes("Saving…"));
  });

  it("says to remove a link first when genex.games refused the save because the game keeps no more", () => {
    const full = drawForm(ready, [], { phase: bundle.view.SavePhase.Full });
    assert.match(full, /role="alert"[^>]*data-game-analytics-link-refused="full"/);
    assert.ok(
      words(full).includes(
        `This game already keeps ${CAMPAIGN_LINKS_MAX} saved links, the most it can. Remove one to save another.`,
      ),
    );
    assert.ok(!words(full).includes("Try again"), "trying again cannot work");
  });

  it("marks a tag that is too long and says what the limit is", () => {
    const markup = drawForm({ ...ready, medium: "m".repeat(CAMPAIGN_TAG_MAX + 1) });
    assert.match(tagWith(markup, 'data-game-analytics-link-field="medium"'), /aria-invalid="true"/);
    assert.ok(!/ aria-invalid="true"/.test(tagWith(markup, 'data-game-analytics-link-field="source"')));
    assert.deepEqual(matches(words(markup), /A tag can be up to \d+ characters\./), [
      `A tag can be up to ${CAMPAIGN_TAG_MAX} characters.`,
    ]);
    assert.match(tagWith(markup, 'data-game-analytics-link-save="incomplete"'), / disabled=""/);
  });

  it("keeps the words a person wrote out of usage recordings", () => {
    const markup = drawPage([LINK]);
    for (const input of matches(markup, /<input[^>]*>/)) assert.match(input, /data-analytics-mask/);
    assert.match(
      markup,
      /data-game-analytics-link-source="tiktok"[^>]*><span data-analytics-mask="true">tiktok<\/span>/,
    );
    assert.match(markup, /data-analytics-mask="true">https:\/\/genex\.games\/lantern-run<\/span>/);
    // A saved link's buttons are named by its tags, and a recording shows a button's name.
    const links = listedLinks(SampleKind.Rich);
    const [first = assert.fail()] = links;
    const idle = drawTable(links);
    const asking = drawTable(links, { removal: { id: first.id, step: bundle.view.RemovalStep.Asking, failed: false } });
    assert.match(idle, /<span[^>]*data-analytics-mask[^>]*><button[^>]*data-game-analytics-copy-text=/);
    assert.match(asking, /<span[^>]*data-analytics-mask[^>]*><button[^>]*data-game-analytics-link-keep=/);
  });

  it("draws the saved links' table: each link's numbers, and Copy and Remove for each", () => {
    const links = listedLinks(SampleKind.Rich);
    const markup = drawTable(links);
    assert.ok(words(markup).includes("Numbers for the last 30 days."));
    const header =
      /<div role="row" class="game-analytics-row game-analytics-row-head">.*?<\/div>/.exec(markup)?.[0] ?? "";
    assert.deepEqual(matches(header, /<span role="columnheader"[^>]*>[^<]*<\/span>/).map(words), [
      "Campaign and content",
      "Source and medium",
      "New visitors",
      "New players",
      "Visit to play",
      "Day 7",
      "Created",
      "",
    ]);
    const rows = tableRows(markup);
    assert.equal(rows.length, links.length);
    assert.equal(
      words(rows[0] ?? ""),
      `launch_trailer bio_link tiktok / social 2,150 940 43.7% 8.6% ${formatDay(links[0]?.createdOn)}`,
    );
    links.forEach((link, index) => {
      const row = rows[index] ?? "";
      assert.ok(row.includes(`data-game-analytics-row="${link.id}"`));
      assert.ok(row.includes(`data-game-analytics-copy-text="${link.id}"`), `${link.id} copies its link`);
      assert.ok(row.includes(`data-game-analytics-link-remove="${link.id}"`), `${link.id} can be removed`);
      assert.ok(row.includes(`aria-label="Copy the link for ${link.campaign}, ${link.content}"`));
    });
  });

  it("writes a dash for what cannot be known, never a zero", () => {
    const unseen: CampaignLink = { ...LINK, newVisitors: 0, newPlayers: 0, day7: null, content: null };
    const row = tableRows(drawTable([unseen]))[0] ?? "";
    assert.equal(words(row), `launch_trailer tiktok / social 0 0 — — ${formatDay(unseen.createdOn)}`);
  });

  it("asks in the row before it removes anything: Keep and Remove in place of the row's buttons", () => {
    const links = listedLinks(SampleKind.Rich);
    const [first = assert.fail(), second = assert.fail()] = links;
    const markup = drawTable(links, { removal: { id: first.id, step: bundle.view.RemovalStep.Asking, failed: false } });
    const [asked = "", other = ""] = tableRows(markup);
    assert.ok(asked.includes(`data-game-analytics-link-keep="${first.id}"`));
    assert.ok(asked.includes(`data-game-analytics-link-confirm="${first.id}"`));
    assert.ok(!asked.includes("data-game-analytics-link-remove="), "the question replaces the button that asked it");
    assert.ok(!asked.includes("data-game-analytics-copy-text"));
    assert.equal(words(asked).endsWith("Keep Remove"), true);
    assert.ok(other.includes(`data-game-analytics-link-remove="${second.id}"`), "the other rows stay as they were");
    assert.ok(!markup.includes("data-game-analytics-link-remove-failed"));
    assert.equal(matches(markup, /data-game-analytics-link-confirm=/).length, 1, "one question at a time");
    assert.match(
      tagWith(asked, "data-game-analytics-link-keep"),
      /aria-label="Keep the link for launch_trailer, bio_link"/,
    );
    assert.match(
      tagWith(asked, "data-game-analytics-link-confirm"),
      /aria-label="Remove the link for launch_trailer, bio_link"/,
    );
  });

  it("shows a removal in flight, and a refused one with the question asked again", () => {
    const [first = assert.fail()] = listedLinks(SampleKind.Rich);
    const removing =
      tableRows(
        drawTable([first], { removal: { id: first.id, step: bundle.view.RemovalStep.Removing, failed: false } }),
      )[0] ?? "";
    assert.match(tagWith(removing, "data-game-analytics-link-confirm"), /aria-busy="true"/);
    assert.match(tagWith(removing, "data-game-analytics-link-keep"), / disabled=""/, "Keep waits for the removal");
    assert.ok(words(removing).includes("Removing…"));
    const failed = drawTable([first], {
      removal: { id: first.id, step: bundle.view.RemovalStep.Asking, failed: true },
    });
    assert.match(failed, /role="alert"[^>]*data-game-analytics-link-remove-failed/);
    assert.ok(words(failed).includes("Couldn’t remove that link. Try again."));
    assert.ok(failed.includes("data-game-analytics-link-confirm"), "it can be tried again");
  });

  it("says what a saved link gives while there is none", () => {
    const markup = drawPage(listedLinks(SampleKind.Young));
    assert.ok(markup.includes('data-game-analytics-empty="true"'));
    assert.ok(
      words(markup).includes(
        "No saved links yet. Save one to get a short link for it, and to see here how many visitors and players it brings.",
      ),
    );
    assert.ok(!markup.includes('role="table"'));
    assert.ok(!markup.includes("data-game-analytics-link-source"), "no chips either");
    assert.ok(markup.includes("data-game-analytics-link-field"), "the form is there to save the first one");
  });

  it("draws a link's text as text: a tag that looks like markup is escaped", () => {
    const hostile: CampaignLink = {
      ...LINK,
      id: "lnk_h",
      campaign: "<img src=x onerror=alert(1)>",
      content: "<b>bold</b>",
      source: "a&b",
    };
    const markup = drawPage([hostile]);
    assert.ok(!markup.includes("<img"));
    assert.ok(!markup.includes("<b>"));
    assert.ok(words(markup).includes("<img src=x onerror=alert(1)>"));
    assert.ok(words(markup).includes("<b>bold</b>"));
    assert.ok(words(markup).includes("a&b"));
  });

  it("copes with a very long tag: the row keeps its shape and the whole of it is a hover away", () => {
    const long = "x".repeat(CAMPAIGN_TAG_MAX);
    const markup = drawTable([{ ...LINK, campaign: long, content: long }]);
    assert.ok(markup.includes(`title="${long}"`));
    assert.equal(tableRows(markup).length, 1);
  });
});
