/**
 * "Maximum concurrent workers" in Settings: a ceiling, not a target. A run's lead decides how many builders
 * it actually starts, and keeps its own windows on top: its view, and one every check leases. The most
 * Settings offers is the most a lead's pool runs at once, `MAX_WORKERS_AT_ONCE` (`workers.ts`).
 */
export const LEAD_WINDOWS = 2;
/** The ceiling until the user changes it. */
export const DEFAULT_BUILDERS = 4;
