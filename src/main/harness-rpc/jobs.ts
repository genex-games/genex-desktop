/** Harness RPC: the jobs of a game, read-only. The harness can neither start nor stop a job. */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { type JobScope, JobScopeKind, jobView } from "../../shared/jobs.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** The `jobs.*` handlers: one read of a game's jobs, by run and end number. */
export function jobsRpc(core: StudioCore, _x: CoreInternals) {
  return {
    [HostMethod.JobsList]: async (p) => {
      const scope: JobScope | undefined = p.runId ? { kind: JobScopeKind.Run, runId: p.runId } : undefined;
      const endedAfter = Number.isFinite(p.endedAfter) ? Number(p.endedAfter) : undefined;
      const { records, seq } = await core.jobs.listWithSeq(p.project, { scope, endedAfter });
      return { jobs: records.map(jobView), seq };
    },
  } satisfies Partial<HarnessHostHandlers>;
}
