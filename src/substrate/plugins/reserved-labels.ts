/**
 * The names Studio's own stage strip shows, which no plugin's toolbar item (`manifest.ts`) or
 * observer's Live tab (`observer-manifest.ts`) may repeat. Its own module so both import it.
 */

/** Labels Studio's own stage-strip buttons use; the build smoke finds them by exact text. */
export const RESERVED_TOOLBAR_LABELS: ReadonlySet<string> = new Set([
  "Retry",
  "Ready",
  "Live",
  "Builds",
  "Assets",
  "Export",
  "Plugins",
  "Reload",
  "State",
  "Close plugins",
]);
