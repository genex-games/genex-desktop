import { MINUTE_MS, SECOND_MS } from "./duration.ts";
import type { PluginManifest } from "./plugins.ts";

const MESSAGE = {
  job: (id: string, time: string, gpu: boolean) =>
    `${id}: up to ${time} per background job${gpu ? "; uses the GPU" : ""}.`,
};

/** The manifest's compute limits, shared by install consent and the host-drawn plugin page. */
export function nativeJobDisclosure(manifest: Pick<PluginManifest, "nativeJobs">): string[] {
  return (manifest.nativeJobs ?? []).map((job) => {
    const minutes = job.timeoutMs / MINUTE_MS;
    const time = Number.isInteger(minutes) ? `${minutes} min` : `${job.timeoutMs / SECOND_MS} s`;
    return MESSAGE.job(job.id, time, Boolean(job.gpu));
  });
}
