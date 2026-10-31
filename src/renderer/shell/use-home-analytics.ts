/**
 * Home's visit as usage analytics hears it: home coming up and how it was reached, its first
 * words, Suggest prompt, the launch, and words left behind when home goes away. What is written
 * never leaves: only where it came from, how long it was and how long home was up.
 */
import { useEffect, useMemo, useRef } from "react";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { countBucket } from "../analytics/properties.ts";
import {
  homeLeftTo,
  homeWords,
  type LaunchFacts,
  launchStartedProperties,
  WAITING_SOURCE,
} from "../analytics/workspace-properties.ts";
import { homeVisit } from "../analytics/workspace-trackers.ts";
import { HomeWords, NavVia } from "../analytics/workspace-vocabulary.ts";
import { BackdropSource } from "../home-backdrop/settings.ts";
import { backdropNow } from "../home-backdrop/store.ts";
import type { Studio } from "../state/studio.ts";
import { roomOf } from "../state/threads.ts";

/** What home tells analytics about its visit. */
export interface HomeVisitAnalytics {
  /** Home came up, with words waiting or not; once per visit. */
  viewed(returned: boolean, words: string | null | undefined): void;
  /** Suggest prompt pressed over `draft`. */
  suggested(draft: string): void;
  /** The draft left as a launch. */
  launched(launch: LaunchFacts): void;
}

/**
 * Whether home just unmounted and its leave waits to be counted. A mount in the same moment takes
 * it back: StrictMode's development replay unmounts and mounts at once, and home never went away.
 */
let leavePending = false;

/** Home went away: the visit ends, and words left in it are counted as discarded. */
function leaveHome(app: Studio, draft: string): void {
  const to = homeLeftTo(roomOf(app.threads.getState()));
  const discarded = homeVisit.left(draft, to, Date.now());
  if (discarded) track(AnalyticsEvent.HomeDraftDiscarded, discarded);
}

/** Home's visit: the first words of `draft`, words lost on leaving, and what home calls to report the rest. */
export function useHomeVisit(app: Studio, draft: string): HomeVisitAnalytics {
  useEffect(() => {
    const started = homeVisit.drafted(draft, Date.now());
    if (started) track(AnalyticsEvent.HomeDraftStarted, started);
  }, [draft]);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    leavePending = false;
    return () => {
      // The visit ends once home is really gone, not on a replayed unmount (see `leavePending`).
      leavePending = true;
      queueMicrotask(() => {
        if (!leavePending) return;
        leavePending = false;
        leaveHome(app, latest.current);
      });
    };
  }, [app]);
  return useMemo(
    () => ({
      viewed(returned, words) {
        if (homeVisit.open()) return;
        const at = Date.now();
        const waiting = homeWords(returned, words);
        const noted = homeVisit.via(at);
        homeVisit.viewed(at, WAITING_SOURCE[waiting]);
        track(AnalyticsEvent.HomeViewed, {
          via: waiting === HomeWords.FailedLaunch ? NavVia.FailedLaunch : noted,
          waiting_words: waiting,
          games_bucket: countBucket(app.library.getState().games.length),
          backdrop_on: backdropNow().source !== BackdropSource.Off,
        });
      },
      suggested(current) {
        track(AnalyticsEvent.HomePromptSuggested, homeVisit.suggested(current));
      },
      launched(launch) {
        const from = homeVisit.launched();
        const games = app.library.getState().games.length;
        track(AnalyticsEvent.GameLaunchStarted, launchStartedProperties(launch, { ...from, games }));
      },
    }),
    [app],
  );
}
