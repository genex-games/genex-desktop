/**
 * "Maximum concurrent workers" in Settings: a ceiling, not a target. A run's lead decides how many builders
 * it actually starts, and keeps its own windows on top: its view, and one every check leases.
 */
export const LEAD_WINDOWS = 2;
/** The most workers Settings offers. */
export const MAX_BUILDERS = 12;
/** The ceiling until the user changes it. */
export const DEFAULT_BUILDERS = 4;
