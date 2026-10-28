/**
 * Usage analytics: PostHog events and, for one install in five during its first week, a replay —
 * only after the person agrees (`consent.ts`), once, and afterwards in Settings → Privacy.
 *
 * The recorder comes from the bundle (`posthog-js/full/no-external`), loaded only after a yes: no
 * script is ever fetched, because anything running in this window can call window.studio. Until
 * the recorder is up, events wait in memory (at most `EARLY_EVENTS_MAX`): a yes sends them with
 * their own time, a no drops them, and nothing waits once the answer is no.
 */
import type { PostHog, PostHogConfig } from "posthog-js";
import type { AnalyticsConfig } from "../../shared/analytics.ts";
import type { AnalyticsEvent, AnalyticsEventProperties, SuperProperties } from "./events.ts";
import type { EventProperties } from "./properties.ts";
import { BLOCK_SELECTOR, maskAttribute, maskRequest, maskText, scrubEvent } from "./masking.ts";
import { currentScreen, screenChanged, screenUrl } from "./screens.ts";

/** Events kept before the answer; a launch that never answers keeps no more than this. */
export const EARLY_EVENTS_MAX = 200;
/** PostHog's defaults as of this date; later changes to them wait for a deliberate update. */
const POSTHOG_DEFAULTS = "2026-08-30";

/** Where this launch stands with the person's answer. */
const Answer = {
  Pending: "pending",
  Yes: "yes",
  No: "no",
} as const;
type Answer = (typeof Answer)[keyof typeof Answer];

type Loader = () => Promise<{ posthog: PostHog }>;
const bundled: Loader = () => import("posthog-js/full/no-external");

interface EarlyEvent {
  event: AnalyticsEvent;
  properties: EventProperties;
  at: Date;
}

let answer: Answer = Answer.Pending;
let chunk: Promise<{ posthog: PostHog }> | null = null;
let client: PostHog | null = null;
let early: EarlyEvent[] = [];
let superProperties: Partial<SuperProperties> = {};

/** The bundled recorder, loaded once; a failed load is tried again next time. */
function loadRecorder(load: Loader): Promise<{ posthog: PostHog }> {
  chunk ??= load().catch((error: unknown) => {
    chunk = null;
    throw error;
  });
  return chunk;
}

/** What starting needs beyond the build's config: whether this launch records a replay. */
export interface StartOptions {
  replay: boolean;
}

/**
 * Start, or resume, analytics for this launch. The recorder loads the first time; nothing starts
 * if the person turned it off meanwhile. What waited for the answer leaves first, with its time.
 */
export async function startAnalytics(
  config: AnalyticsConfig,
  { replay }: StartOptions,
  load: Loader = bundled,
): Promise<void> {
  answer = Answer.Yes;
  if (!client) {
    const { posthog } = await loadRecorder(load);
    if (answer !== Answer.Yes) return;
    if (!client) {
      showScreen();
      posthog.init(config.key, options(config));
      client = posthog;
    }
  }
  showScreen();
  if (client.has_opted_out_capturing()) client.opt_in_capturing();
  client.register({ ...superProperties });
  // Recording is off in the options; only a sampled install inside its week starts it, past the project's own sampling.
  if (replay) client.startSessionRecording(true);
  else client.stopSessionRecording();
  pageview();
  flushEarly(client);
}

/** Stop sending for this launch: nothing more leaves until the person turns it back on, and a later yes starts a new id. */
export function stopAnalytics(): void {
  answer = Answer.No;
  early = [];
  const posthog = client;
  if (!posthog) return;
  quietly(() => {
    posthog.stopSessionRecording();
    posthog.opt_out_capturing();
    posthog.reset();
    if (typeof history !== "undefined") history.replaceState(history.state, "", location.href.split("#")[0]);
  });
}

/** The screen the person is on, as a path: /game/live, /settings/privacy, /welcome/connect. */
export function setAnalyticsScreen(path: string): void {
  quietly(() => {
    if (!screenChanged(path)) return;
    if (!client || answer !== Answer.Yes) return;
    showScreen();
    pageview();
  });
}

/**
 * A product event. Properties describe what happened, never what was written: each value is an
 * enum, a switch, a count or a duration (`properties.ts`). Before the recorder is up it waits.
 */
export function track<E extends AnalyticsEvent>(
  event: E,
  properties: AnalyticsEventProperties[E] & EventProperties,
): void {
  quietly(() => {
    if (answer === Answer.No) return;
    if (client && answer === Answer.Yes) {
      client.capture(event, properties);
      return;
    }
    if (early.length < EARLY_EVENTS_MAX) early.push({ event, properties, at: new Date() });
  });
}

/** Properties sent with every event from now on: they describe the app, never the person. */
export function registerSuperProperties(next: Partial<SuperProperties>): void {
  quietly(() => {
    superProperties = { ...superProperties, ...next };
    if (client && answer === Answer.Yes) client.register({ ...next });
  });
}

/**
 * Run analytics-only work so that it never stands in the app's way: whatever fails in it sends
 * nothing and goes no further, neither to its caller nor to the store or stream that called it.
 */
export function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // Analytics never stands in the app's way: work that fails sends nothing.
  }
}

/** A store or stream listener that runs `quietly`, so analytics failing in it never breaks what it listens to. */
export function guarded<A extends unknown[]>(listen: (...args: A) => void): (...args: A) => void {
  return (...args) => quietly(() => listen(...args));
}

/** What waited for the answer, sent with the time it happened; one that fails does not hold back the rest. */
function flushEarly(posthog: PostHog): void {
  const waiting = early;
  early = [];
  for (const item of waiting) quietly(() => posthog.capture(item.event, item.properties, { timestamp: item.at }));
}

/** The address carries the screen, so heatmaps and replay navigation are filed under it as they happen. */
function showScreen(): void {
  if (typeof history !== "undefined") history.replaceState(history.state, "", `#${currentScreen()}`);
}

function pageview(): void {
  if (client && answer === Answer.Yes) client.capture("$pageview", { $current_url: screenUrl() });
}

function options(config: AnalyticsConfig): Partial<PostHogConfig> {
  return {
    api_host: config.host,
    defaults: POSTHOG_DEFAULTS,
    persistence: "localStorage",
    person_profiles: "identified_only",
    // Screens are captured by the app; a single page has no navigation to capture.
    capture_pageview: false,
    capture_pageleave: false,
    // The hash is the screen (see showScreen).
    disable_capture_url_hashes: false,
    // Clicks, without their text or attributes; rage and dead clicks show where the app did not answer.
    autocapture: true,
    capture_dead_clicks: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    capture_heatmaps: true,
    save_referrer: false,
    save_campaign_params: false,
    // Nothing that could carry the work itself: console lines, errors, requests, page scripts.
    capture_performance: false,
    capture_exceptions: false,
    enable_recording_console_log: false,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
    // A replay starts only by startSessionRecording, for a sampled install (consent.ts).
    disable_session_recording: true,
    before_send: scrubEvent,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: maskText,
      maskAttributeFn: maskAttribute,
      // Pinned here: the project's own setting would otherwise switch maskAttribute off and mask class and style too.
      maskAllElementAttributes: false,
      blockSelector: BLOCK_SELECTOR,
      maskCapturedNetworkRequestFn: maskRequest,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
      recordCrossOriginIframes: false,
      captureJsonLd: false,
      collectFonts: false,
      // Plain JSON, so the last pass in scrubEvent can read every replay batch.
      compress_events: false,
    },
    loaded: (instance) => instance.register({ app_version: config.version ?? "unknown", ...superProperties }),
  };
}
