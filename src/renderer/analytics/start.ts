/**
 * Usage analytics for this launch, wired once beside the stores (`studio-entry.tsx`): started after
 * a yes and stopped after a no, the listeners subscribed (`observers.ts`), and what every event
 * carries kept current from the stores. Which screen the person is on comes from the shell
 * (`shell/use-analytics-screen.ts`).
 */
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import type { EngineDescriptor } from "../../shared/engine-descriptor.ts";
import { currentLocale } from "../../shared/i18n.ts";
import type { SessionState } from "../state/session.ts";
import { SessionStatus } from "../state/session.ts";
import type { Studio } from "../state/studio.ts";
import type { KeyValueStorage } from "../storage.ts";
import { guarded, registerSuperProperties, startAnalytics, stopAnalytics, track } from "./client.ts";
import { ANALYTICS_CONSENT_VERSION, AnalyticsChoice } from "./consent.ts";
import { AnalyticsEvent } from "./events.ts";
import type { ConsentSurface } from "./events/core.ts";
import { startObservers } from "./observers.ts";

/** The engines ready to answer, sorted, as every event carries them. */
export function readyEngines(list: readonly EngineDescriptor[]): string[] {
  return list
    .filter((engine) => engine.status.code === EngineStatusCode.Ready)
    .map((engine) => engine.id)
    .sort();
}

/** What a session's analytics settles on: off for good, on, or still waiting for the answer. */
const Settled = {
  Off: "off",
  On: "on",
  Waiting: "waiting",
} as const;
type Settled = (typeof Settled)[keyof typeof Settled];

/** Where a ready session leaves analytics: off without a config or after a no, on after a yes. */
export function settled(state: Pick<SessionState, "status" | "analytics" | "analyticsChoice">): Settled {
  if (state.status !== SessionStatus.Ready) return Settled.Waiting;
  if (!state.analytics || state.analyticsChoice === AnalyticsChoice.Off) return Settled.Off;
  return state.analyticsChoice === AnalyticsChoice.On ? Settled.On : Settled.Waiting;
}

/** A random id for one launch, in memory only. */
const launchId = (random: () => number): string => Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36);

/** Wire analytics for this launch. Returns the stop. */
export function startUsageAnalytics(
  app: Studio,
  { storage, now, random }: { storage: KeyValueStorage | null; now: () => number; random: () => number },
): () => void {
  registerSuperProperties({ launch_id: launchId(random), locale: currentLocale() });
  void app.api
    .appAbout()
    .then((about) => registerSuperProperties({ os: about.platform, arch: about.arch }))
    .catch(() => undefined);
  let last: Settled = Settled.Waiting;
  const follow = (state: SessionState): void => {
    const next = settled(state);
    if (next === last) return;
    last = next;
    if (next === Settled.Off) stopAnalytics();
    if (next !== Settled.On || !state.analytics) return;
    const replay = state.replayUntil !== null && now() < state.replayUntil;
    registerSuperProperties({
      app_version: state.analytics.version ?? "unknown",
      first_launch: state.firstLaunch,
      replay,
    });
    void startAnalytics(state.analytics, { replay }).catch(() => undefined);
  };
  const offSession = app.session.subscribe(guarded(follow));
  follow(app.session.getState());
  const engines = (list: readonly EngineDescriptor[]): void => {
    const ready = readyEngines(list);
    registerSuperProperties({
      engines_ready: ready,
      engines_ready_count: ready.length,
      any_model_ready: ready.length > 0,
    });
  };
  const offEngines = app.engines.subscribe(guarded((state) => engines(state.list)));
  engines(app.engines.getState().list);
  const offPeople = app.people.subscribe(
    guarded((state) => registerSuperProperties({ genex_signed_in: state.me !== null })),
  );
  const offObservers = startObservers(app, storage, now());
  return () => {
    offSession();
    offEngines();
    offPeople();
    offObservers();
  };
}

/**
 * The person answered, from the question or Settings → Privacy: kept on the profile, and a yes is
 * the first thing analytics sends. A no is never sent.
 */
export function chooseUsageAnalytics(
  app: Pick<Studio, "chooseAnalytics" | "session">,
  choice: AnalyticsChoice,
  { surface, shownMs, now }: { surface: ConsentSurface; shownMs?: number; now: number },
): void {
  app.chooseAnalytics(choice);
  if (choice !== AnalyticsChoice.On) return;
  const { replayUntil } = app.session.getState();
  track(AnalyticsEvent.AnalyticsTurnedOn, {
    surface,
    ...(shownMs === undefined ? {} : { ms_shown: shownMs }),
    consent_version: ANALYTICS_CONSENT_VERSION,
    replay: replayUntil !== null && now < replayUntil,
  });
}
