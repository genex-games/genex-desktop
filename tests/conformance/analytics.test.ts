/**
 * Usage analytics (PostHog): a build carries it only with a key, a launch offers it only when it may
 * send, the person's answer is kept per consent version, one first launch in five records a replay
 * of its first week, and what leaves shows the app — never the work or the local paths (the page's
 * file:// address holds the user's name on macOS and Windows).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureResult, CapturedNetworkRequest, PostHog } from "posthog-js";
import { analyticsFromEnv, analyticsOrigins, sessionAnalytics, withAnalyticsCsp } from "../../src/shared/analytics.ts";
import type { EventEnvelope } from "../../src/shared/studio-api.ts";
import { setAnalyticsScreen, startAnalytics, stopAnalytics, track } from "../../src/renderer/analytics/client.ts";
import {
  ANALYTICS_CONSENT_VERSION,
  AnalyticsChoice,
  readAnalyticsChoice,
  REPLAY_WINDOW_MS,
  replayDraw,
  replayRunning,
  writeAnalyticsChoice,
} from "../../src/renderer/analytics/consent.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import { ConsentSurface } from "../../src/renderer/analytics/events/core.ts";
import {
  CONTENT_SELECTOR,
  CONTROL_SELECTOR,
  maskAttribute,
  maskRequest,
  maskText,
  scrubEvent,
} from "../../src/renderer/analytics/masking.ts";
import { uncounted } from "../../src/renderer/analytics/observers.ts";
import { charsBucket, countBucket, elapsedMs } from "../../src/renderer/analytics/properties.ts";
import { analyticsScreen, type ScreenPlace } from "../../src/renderer/analytics/screens.ts";
import { readyEngines, settled } from "../../src/renderer/analytics/start.ts";
import { WelcomeScreen } from "../../src/renderer/onboarding/state.ts";
import { SettingsSection } from "../../src/renderer/settings-navigation.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { PlayPage } from "../../src/renderer/state/play.ts";
import { Room } from "../../src/renderer/state/threads.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";

const APP = "file:///Users/ada/Downloads/My%20Apps/Genex.app/Contents/Resources/app.asar/dist/renderer/index.html";
const WINDOWS_APP = "file:///C:/Users/ada/AppData/Local/genex/app-1.0.0/resources/app.asar/dist/renderer/index.html";
/** The renderer page's CSP as the app writes it: connect-src is the one directive analytics extends. */
const PAGE = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob: data:; img-src 'self' data:">`;
const csp = (html: string) => /content="([^"]*)"/.exec(html)?.[1] ?? "";
const TURNED_ON = { surface: ConsentSurface.Settings, consent_version: ANALYTICS_CONSENT_VERSION, replay: false };

/** Stands in for a DOM element: inside a control, a content region, both or neither. */
function element(where: { control?: boolean; content?: boolean }): Element {
  const closest = (selector: string) => {
    const inside = selector === CONTROL_SELECTOR ? where.control : selector === CONTENT_SELECTOR && where.content;
    return inside ? {} : null;
  };
  return { closest } as unknown as Element;
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("usage analytics: build and session", () => {
  it("builds carry analytics only with a key, a developer build only when testing, and only over https", () => {
    assert.equal(analyticsFromEnv({}, false), null);
    assert.equal(analyticsFromEnv({ STUDIO_POSTHOG_KEY: " " }, false), null);
    assert.equal(analyticsFromEnv({ STUDIO_POSTHOG_KEY: "phc_x" }, true), null);
    assert.deepEqual(analyticsFromEnv({ STUDIO_POSTHOG_KEY: "phc_x", STUDIO_ANALYTICS: "1" }, true), {
      key: "phc_x",
      host: "https://eu.i.posthog.com",
    });
    assert.deepEqual(
      analyticsFromEnv({ STUDIO_POSTHOG_KEY: "phc_x", STUDIO_POSTHOG_HOST: "https://us.i.posthog.com/" }, false),
      { key: "phc_x", host: "https://us.i.posthog.com" },
    );
    const refused = [
      ["http://ph.example.com", /https/],
      ["https://eu.posthog.com", /ingest host/],
      ["https://us-assets.i.posthog.com", /ingest host/],
    ] as const;
    for (const [host, why] of refused)
      assert.throws(
        () => analyticsFromEnv({ STUDIO_POSTHOG_KEY: "phc_x", STUDIO_POSTHOG_HOST: host }, false),
        why,
        host,
      );
    assert.deepEqual(
      analyticsFromEnv({ STUDIO_POSTHOG_KEY: "phc_x", STUDIO_POSTHOG_HOST: "https://ph.example.com" }, false),
      { key: "phc_x", host: "https://ph.example.com" },
      "a proxy of one's own",
    );
  });

  it("admits PostHog to connect-src only; scripts stay the app's own", () => {
    assert.deepEqual(analyticsOrigins("https://eu.i.posthog.com"), [
      "https://eu.i.posthog.com",
      "https://eu-assets.i.posthog.com",
    ]);
    assert.deepEqual(analyticsOrigins("https://ph.example.com"), ["https://ph.example.com"]);
    const built = csp(withAnalyticsCsp(PAGE, analyticsOrigins("https://eu.i.posthog.com")));
    const directive = (name: string) =>
      built
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `)) ?? "";
    assert.equal(
      directive("connect-src"),
      "connect-src 'self' blob: data: https://eu.i.posthog.com https://eu-assets.i.posthog.com",
    );
    assert.equal(directive("script-src"), "script-src 'self' 'wasm-unsafe-eval'");
    assert.doesNotMatch(built.replace(directive("connect-src"), ""), /posthog/);
    assert.throws(() => withAnalyticsCsp("<meta content=\"default-src 'self'\">", ["https://eu.i.posthog.com"]));
  });

  it("offers analytics only in a launch that may send, or one testing the integration", () => {
    const config = { key: "phc_x", host: "https://eu.i.posthog.com" };
    const base = { sends: true, env: {}, version: "1.2.3" };
    assert.deepEqual(sessionAnalytics(config, base), { ...config, version: "1.2.3" });
    assert.equal(sessionAnalytics(null, base), null);
    assert.equal(
      sessionAnalytics(config, { ...base, sends: false }),
      null,
      "unpackaged, owned, switched or test launches",
    );
    assert.equal(sessionAnalytics(config, { ...base, sends: false, env: { STUDIO_ANALYTICS: "0" } }), null);
    assert.ok(sessionAnalytics(config, { ...base, sends: false, env: { STUDIO_ANALYTICS: "1" } }));
  });
});

describe("usage analytics: the answer and the replay draw", () => {
  it("keeps an answer only for the consent version it was given for", () => {
    const answers: Array<[string | undefined, AnalyticsChoice | null, string]> = [
      [undefined, null, "never asked"],
      ["on", null, "a bare value from a build that never shipped"],
      ["{", null, "unreadable"],
      [JSON.stringify({ choice: "maybe", version: ANALYTICS_CONSENT_VERSION }), null, "no such answer"],
      [JSON.stringify({ choice: "on", version: ANALYTICS_CONSENT_VERSION - 1 }), null, "an earlier version"],
      [JSON.stringify({ choice: "on", version: ANALYTICS_CONSENT_VERSION }), AnalyticsChoice.On, "this version"],
      [JSON.stringify({ choice: "off", version: ANALYTICS_CONSENT_VERSION }), AnalyticsChoice.Off, "this version"],
    ];
    for (const [stored, expected, why] of answers) {
      const storage = memoryStorage(stored === undefined ? {} : { "studio.analytics": stored });
      assert.equal(readAnalyticsChoice(storage), expected, why);
    }
    const storage = memoryStorage();
    writeAnalyticsChoice(storage, AnalyticsChoice.Off);
    assert.equal(readAnalyticsChoice(storage), AnalyticsChoice.Off);
    assert.equal(readAnalyticsChoice(null), null, "no storage at all");
  });

  it("draws a replay once, for one first launch in five, for a week", () => {
    const now = 5_000;
    const draw = (random: number, firstLaunch: boolean, storage = memoryStorage()) => ({
      storage,
      draw: replayDraw(storage, { firstLaunch, now, random: () => random }),
    });
    assert.deepEqual(draw(0.19, true).draw, { sampled: true, until: now + REPLAY_WINDOW_MS });
    assert.deepEqual(draw(0.2, true).draw, { sampled: false, until: 0 });
    assert.deepEqual(draw(0, false).draw, { sampled: false, until: 0 }, "a profile welcomed before never records");
    const kept = draw(0.05, true);
    assert.deepEqual(replayDraw(kept.storage, { firstLaunch: true, now, random: () => 0.99 }), kept.draw, "drawn once");
    const declined = draw(0.9, true);
    assert.deepEqual(replayDraw(declined.storage, { firstLaunch: true, now, random: () => 0 }), declined.draw);
    const broken = memoryStorage({ "studio.analytics.replay": JSON.stringify({ sampled: "yes", until: 1 }) });
    assert.deepEqual(draw(0.9, false, broken).draw, { sampled: false, until: 0 }, "an unreadable draw is not trusted");
    assert.equal(replayRunning({ sampled: true, until: now + 1 }, now), true);
    assert.equal(replayRunning({ sampled: true, until: now }, now), false, "the week is over");
    assert.equal(replayRunning({ sampled: false, until: now + 1 }, now), false);
    assert.equal(replayRunning(null, now), false);
  });

  it("settles a ready session: off without a config or after a no, on after a yes, waiting otherwise", () => {
    const config = { key: "phc_x", host: "https://eu.i.posthog.com" };
    assert.equal(settled({ status: "loading", analytics: config, analyticsChoice: AnalyticsChoice.On }), "waiting");
    assert.equal(settled({ status: "ready", analytics: null, analyticsChoice: null }), "off");
    assert.equal(settled({ status: "ready", analytics: config, analyticsChoice: null }), "waiting");
    assert.equal(settled({ status: "ready", analytics: config, analyticsChoice: AnalyticsChoice.Off }), "off");
    assert.equal(settled({ status: "ready", analytics: config, analyticsChoice: AnalyticsChoice.On }), "on");
  });
});

describe("usage analytics: screens and properties", () => {
  const place: ScreenPlace = {
    welcoming: false,
    welcomeScreen: null,
    playViewer: false,
    settings: null,
    searching: false,
    feedback: false,
    openFolder: false,
    plugins: false,
    items: false,
    play: null,
    room: Room.Build,
    launching: false,
    stageView: StageView.Live,
  };

  it("names where the person is, whatever covers the window first", () => {
    const screens: Array<[Partial<ScreenPlace>, string]> = [
      [{}, "/game/live"],
      [{ stageView: StageView.Assets }, "/game/assets"],
      [{ room: Room.Home }, "/home"],
      [{ room: Room.Home, launching: true }, "/home/launching"],
      [{ room: Room.Studio }, "/harness"],
      [{ play: PlayPage.Friends }, "/play/friends"],
      [{ items: true, play: PlayPage.Shelf }, "/items"],
      [{ plugins: true, items: true }, "/plugins"],
      [{ openFolder: true, plugins: true }, "/open-folder"],
      [{ feedback: true, openFolder: true }, "/feedback"],
      [{ searching: true, feedback: true }, "/search"],
      [{ settings: SettingsSection.Privacy, searching: true }, "/settings/privacy"],
      [{ playViewer: true, settings: SettingsSection.Games }, "/play/viewer"],
      [{ welcoming: true, playViewer: true }, "/welcome"],
      [{ welcoming: true, welcomeScreen: WelcomeScreen.Welcome }, "/welcome"],
      [{ welcoming: true, welcomeScreen: WelcomeScreen.Connect }, "/welcome/connect"],
    ];
    for (const [over, screen] of screens) assert.equal(analyticsScreen({ ...place, ...over }), screen, screen);
  });

  it("buckets sizes and keeps durations whole and never negative", () => {
    assert.deepEqual([0, 1, 40, 41, 200, 201, 1000, 1001].map(charsBucket), [
      "0",
      "1-40",
      "1-40",
      "41-200",
      "41-200",
      "201-1000",
      "201-1000",
      "1000+",
    ]);
    assert.deepEqual([0, 1, 2, 5, 6, 20, 21].map(countBucket), ["0", "1", "2-5", "2-5", "6-20", "6-20", "21+"]);
    assert.equal(elapsedMs(100, 350.4), 250);
    assert.equal(elapsedMs(500, 100), 0, "a clock that jumped back");
  });

  it("lists the ready engines sorted, nothing else", () => {
    const engine = (id: string, code: string) => ({ id, status: { code } }) as never;
    assert.deepEqual(
      readyEngines([engine("codex", "ready"), engine("claude-code", "ready"), engine("ollama", "needs-login")]),
      ["claude-code", "codex"],
    );
  });
});

describe("usage analytics: what a replay shows", () => {
  it("shows the words of the app's controls and nothing else", () => {
    assert.equal(maskText("Builds", element({ control: true })), "Builds");
    assert.equal(maskText("make the ship faster", element({})), "**** *** **** ******");
    assert.equal(
      maskText("Space Shooter", element({ control: true, content: true })),
      "***** *******",
      "a game or chat name on a button",
    );
    assert.equal(maskText("Open", undefined), "****");
    const paths = [
      "/Users/ada/AI Games",
      "~/AI Games/space",
      "/Volumes/Work/game",
      "C:\\Users\\ada\\AI Games",
      "~\\AI Games\\space",
      "file:///Users/ada/x",
      "%2FUsers%2Fada",
    ];
    for (const path of paths)
      assert.doesNotMatch(maskText(path, element({ control: true })), /ada|AI|space|Work/, path);
  });

  it("masks readable attributes like text and rewrites local paths in the rest", () => {
    assert.equal(maskAttribute("aria-label", "Hide terminal", element({ control: true })), "Hide terminal");
    assert.equal(maskAttribute("title", "~/AI Games/space", element({})), "**** ***********");
    assert.equal(maskAttribute("href", "https://example.com/from-a-reply", element({ content: true })), "");
    setAnalyticsScreen("/game/live");
    const css = maskAttribute(
      "_cssText",
      `@font-face{src:url("${APP.replace("index.html", "fonts/geist.woff2")}")}`,
      element({}),
    );
    assert.doesNotMatch(css, /ada|file:/);
    assert.match(css, /url\("https:\/\/studio\.invalid\/game\/live"\)/);
    assert.equal(maskAttribute("class", "gi shrink-0", element({})), "gi shrink-0");
  });

  it("keeps only the values the app writes for layout; every other value is masked", () => {
    assert.equal(maskAttribute("data-state", "open", element({})), "open", "Radix state styles the page");
    assert.equal(maskAttribute("data-state", "open", element({ content: true })), "open");
    assert.equal(maskAttribute("id", "settings-tab-privacy", element({})), "settings-tab-privacy");
    assert.equal(maskAttribute("data-project", "space-shooter", element({})), "*************", "a game's folder");
    assert.equal(maskAttribute("name", "mcp-my-server", element({})), "*************");
    assert.equal(maskAttribute("value", "secret", element({})), "******");
    assert.equal(maskAttribute("aria-current", "Space Shooter", element({ content: true })), "***** *******");
  });

  it("gives the replay the screen instead of the page's file address", () => {
    const page = (name: string) => ({ name }) as CapturedNetworkRequest;
    setAnalyticsScreen("/settings/privacy");
    const addresses: Array<[string, string, string]> = [
      [APP, "https://studio.invalid/settings/privacy", "macOS"],
      [WINDOWS_APP, "https://studio.invalid/settings/privacy", "Windows"],
      [`${APP}#/game/assets`, "https://studio.invalid/game/assets", "the hash names the screen it was on"],
      [`${APP}#/welcome/connect`, "https://studio.invalid/welcome/connect", "a welcome step"],
      [`${APP}#/Secret%20Plan`, "https://studio.invalid/settings/privacy", "a chat's own anchor is not a screen"],
      ["null/Users/ada/app/index.html", "https://studio.invalid/settings/privacy", "an opaque origin"],
    ];
    for (const [address, screen, why] of addresses) assert.equal(maskRequest(page(address)).name, screen, why);
    const request = maskRequest({
      ...page("https://eu.i.posthog.com/e/"),
      requestHeaders: { a: "b" },
      requestBody: "x",
      responseBody: "y",
    });
    assert.deepEqual(
      [request.requestHeaders, request.requestBody, request.responseBody],
      [undefined, undefined, undefined],
    );
  });

  it("replaces PostHog's URL fields with the screen and rewrites any path left anywhere", () => {
    setAnalyticsScreen("/game/builds");
    const event = {
      uuid: "1",
      event: "$$heatmap",
      timestamp: new Date(0),
      properties: {
        $current_url: APP,
        $pathname: "/Users/ada/Downloads/x/index.html",
        $host: "",
        $heatmap_data: { [APP]: [{ x: 1 }] },
        nested: ["/home/ada/games", "C:\\Users\\ada\\AI Games\\space", "C:/Users/ada/AI Games"],
      },
      $set_once: { $initial_current_url: WINDOWS_APP },
    } as unknown as CaptureResult;
    const clean = scrubEvent(event);
    assert.ok(clean);
    assert.doesNotMatch(JSON.stringify(clean), /ada|file:/);
    assert.equal(clean.properties.$current_url, "https://studio.invalid/game/builds");
    assert.equal(clean.properties.$pathname, "/game/builds");
    assert.deepEqual(clean.properties.$heatmap_data, { "https://studio.invalid/game/builds": [{ x: 1 }] });
    assert.ok(clean.timestamp instanceof Date, "fields PostHog reads afterwards keep their types");
    assert.equal(scrubEvent(null), null);
  });
});

describe("usage analytics: the log is counted once", () => {
  const record = (id: string, at: number): EventEnvelope =>
    ({
      id,
      thread_id: "t",
      session_id: null,
      turn_id: null,
      created_at: new Date(at).toISOString(),
      data: {},
    }) as never;

  it("counts only records newer than the mark, oldest first, and moves the mark", () => {
    const read = uncounted([record("c", 3_000), record("a", 1_000), record("b", 2_000)], 1_000);
    assert.deepEqual(
      read.fresh.map((r) => r.id),
      ["b", "c"],
    );
    assert.equal(read.mark, 3_000);
    const again = uncounted([record("b", 2_000), record("c", 3_000)], read.mark);
    assert.deepEqual(again.fresh, [], "a reload's bootstrap tail counts nothing twice");
    assert.equal(again.mark, 3_000);
    const unreadable = uncounted([{ ...record("x", 0), created_at: "later" }], 0);
    assert.deepEqual(unreadable.fresh, [], "a record without a time is never news");
  });
});

describe("usage analytics: yes and no in one launch", () => {
  it("waits for the answer, sends what waited after a yes, and never starts after a no that came while it loaded", async () => {
    const calls: string[] = [];
    const stamps: Array<Date | undefined> = [];
    let optedOut = false;
    const posthog = {
      init: () => calls.push("init"),
      has_opted_out_capturing: () => optedOut,
      opt_in_capturing: () => {
        optedOut = false;
        calls.push("opt_in");
      },
      opt_out_capturing: () => {
        optedOut = true;
        calls.push("opt_out");
      },
      reset: () => calls.push("reset"),
      register: () => undefined,
      startSessionRecording: (override: unknown) => calls.push(`record ${JSON.stringify(override)}`),
      stopSessionRecording: () => calls.push("stop recording"),
      capture: (name: string, _properties: unknown, options?: { timestamp?: Date }) => {
        calls.push(name);
        stamps.push(options?.timestamp);
      },
    } as unknown as PostHog;
    let resolve: (value: { posthog: PostHog }) => void = () => {};
    const config = { key: "phc_x", host: "https://eu.i.posthog.com" };

    track(AnalyticsEvent.AnalyticsTurnedOn, TURNED_ON);
    const first = startAnalytics(
      config,
      { replay: false },
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    stopAnalytics();
    resolve({ posthog });
    await first;
    track(AnalyticsEvent.AnalyticsTurnedOn, TURNED_ON);
    assert.deepEqual(calls, [], "a no while loading: nothing initialised, nothing that waited is sent");

    calls.length = 0;
    const loading = startAnalytics(config, { replay: true });
    track(AnalyticsEvent.AnalyticsTurnedOn, TURNED_ON);
    await loading;
    assert.deepEqual(calls, ["init", "record true", "$pageview", "analytics_turned_on"], "a sampled install records");
    assert.ok(stamps.at(-1) instanceof Date, "what waited keeps the time it happened");

    calls.length = 0;
    stopAnalytics();
    track(AnalyticsEvent.AnalyticsTurnedOn, TURNED_ON);
    setAnalyticsScreen("/plugins");
    assert.deepEqual(calls, ["stop recording", "opt_out", "reset"], "off: nothing captured, a later yes is a new id");

    calls.length = 0;
    await startAnalytics(config, { replay: false });
    assert.deepEqual(calls, ["opt_in", "stop recording", "$pageview"], "on again, unsampled: no replay");
  });
});
