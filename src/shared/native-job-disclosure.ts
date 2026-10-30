import { MINUTE_MS, SECOND_MS } from "./duration.ts";
import { t } from "./i18n.ts";
import type { PluginManifest } from "./plugins.ts";

/** The manifest's compute limits, shared by install consent and the host-drawn plugin page. */
export function nativeJobDisclosure(manifest: Pick<PluginManifest, "nativeJobs">): string[] {
  return (manifest.nativeJobs ?? []).map((job) => {
    const minutes = job.timeoutMs / MINUTE_MS;
    const isMinutes = Number.isInteger(minutes);
    return t(
      "{id}: up to {unit, select, minutes {{count, plural, one {# minute} other {# minutes}}} other {{count, plural, one {# second} other {# seconds}}}} per background job{gpu, select, yes {; uses the GPU} other {}}.",
      {
        id: job.id,
        unit: isMinutes ? "minutes" : "seconds",
        count: isMinutes ? minutes : job.timeoutMs / SECOND_MS,
        gpu: job.gpu ? "yes" : "no",
      },
    );
  });
}
