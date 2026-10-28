/** Analytics' own events: the person turned it on. A no is never sent. */

/** Where analytics was turned on. */
export const ConsentSurface = {
  /** The question over the first launch's welcome. */
  FirstLaunch: "first_launch",
  /** The question at the first launch of a version with analytics, on a profile welcomed before. */
  Upgrade: "upgrade",
  /** Settings → Privacy's switch. */
  Settings: "settings",
} as const;
export type ConsentSurface = (typeof ConsentSurface)[keyof typeof ConsentSurface];

export const CoreEvent = {
  AnalyticsTurnedOn: "analytics_turned_on",
} as const;

export type CoreEventProperties = {
  [CoreEvent.AnalyticsTurnedOn]: {
    surface: ConsentSurface;
    /** How long the question was up before the answer; absent from Settings. */
    ms_shown?: number;
    /** `ANALYTICS_CONSENT_VERSION` the answer was given for. */
    consent_version: number;
    /** This install records a replay of its first week. */
    replay: boolean;
  };
};
