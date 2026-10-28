/**
 * Usage analytics (PostHog): what a build carries, where it may send, and which sessions may
 * use it. The renderer side — consent, masking, screens, events — is src/renderer/analytics/.
 *
 * A build carries analytics only when it is made with `STUDIO_POSTHOG_KEY` in the environment.
 * Without it nothing changes: no key, no CSP entry, no Privacy row, no question.
 */

export interface AnalyticsConfig {
  /** The PostHog project key. Public by design, like the key in any web snippet. */
  key: string;
  /** PostHog's ingestion host, e.g. https://eu.i.posthog.com. */
  host: string;
  /** The app version, sent with every event. */
  version?: string;
}

/** Why a build's analytics settings are refused. */
const MESSAGE = {
  notHttps: "STUDIO_POSTHOG_HOST must be an https URL",
  notIngest: "STUDIO_POSTHOG_HOST must be PostHog's ingest host, https://eu.i.posthog.com or https://us.i.posthog.com",
  noConnectSrc: "The renderer CSP has no connect-src to extend",
} as const;

/** Where events go when the build names no host: PostHog's EU cloud. */
const DEFAULT_HOST = "https://eu.i.posthog.com";
/** PostHog Cloud's ingest hosts; the region names its asset host too. */
const CLOUD = /^https:\/\/(us|eu)\.i\.posthog\.com$/;
/** Any PostHog host: only the ingest hosts above take events. */
const POSTHOG_DOMAIN = /(^|\.)posthog\.com$/;
/**
 * `STUDIO_ANALYTICS=1` tests the integration: at build time it lets a developer build carry the
 * key, and at launch it lets a launch that never sends (unpackaged, an owned profile) offer it.
 * Point it at a test PostHog project, never the release one.
 */
const TEST_OPT_IN = "1";

const testing = (env: Record<string, string | undefined>): boolean => env.STUDIO_ANALYTICS === TEST_OPT_IN;

/** The build's analytics from its environment: none without a key, and none in a developer build unless testing. */
export function analyticsFromEnv(
  env: Record<string, string | undefined>,
  developerBuild: boolean,
): AnalyticsConfig | null {
  const key = env.STUDIO_POSTHOG_KEY?.trim();
  if (!key) return null;
  if (developerBuild && !testing(env)) return null;
  const host = new URL(env.STUDIO_POSTHOG_HOST?.trim() || DEFAULT_HOST);
  if (host.protocol !== "https:") throw new Error(MESSAGE.notHttps);
  // PostHog's app and asset hosts do not take events; the CSP would admit the wrong one.
  if (POSTHOG_DOMAIN.test(host.hostname) && !CLOUD.test(host.origin)) throw new Error(MESSAGE.notIngest);
  return { key, host: host.origin };
}

/**
 * The origins the renderer must reach: ingestion, and on PostHog Cloud the asset host that
 * serves the project's settings. A self-hosted or proxied host serves both itself.
 */
export function analyticsOrigins(host: string): string[] {
  const origin = new URL(host).origin;
  const region = CLOUD.exec(origin)?.[1];
  return region ? [origin, `https://${region}-assets.i.posthog.com`] : [origin];
}

/** The renderer page with those origins added to its CSP's connect-src; scripts stay 'self'. */
export function withAnalyticsCsp(html: string, origins: string[]): string {
  const next = html.replace(/(connect-src [^;"]*)/, `$1 ${origins.join(" ")}`);
  if (next === html) throw new Error(MESSAGE.noConnectSrc);
  return next;
}

/**
 * Whether this launch may offer analytics at all: only a launch that may send (`launchSends`
 * in main/run-sharing.ts — packaged, no `--studio-*` switch, no owned profile, no test data), or
 * one started with `STUDIO_ANALYTICS=1` to test the integration. The person still decides — this
 * only allows the question.
 */
export function sessionAnalytics(
  config: AnalyticsConfig | null,
  session: { sends: boolean; env: Record<string, string | undefined>; version: string },
): AnalyticsConfig | null {
  if (!config) return null;
  if (!session.sends && !testing(session.env)) return null;
  return { ...config, version: session.version };
}
