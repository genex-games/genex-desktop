import { useEffect, useId, useState, type JSX } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { t } from "../../../shared/i18n.ts";
import { nativeJobDisclosure } from "../../../shared/native-job-disclosure.ts";
import {
  NativeJobState,
  type PluginManifest,
  type PluginNativeJobSummary,
  type PluginNativeResult,
} from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Section } from "./rows.tsx";

const JOB_POLL_MS = 2 * SECOND_MS;
const MESSAGE = {
  title: t("Background jobs"),
  permission: t("Agents can start background jobs. Cancel a running job here."),
  cancel: t("Cancel"),
  cancelling: t("Cancelling…"),
  details: t("Details"),
  hideDetails: t("Hide details"),
  loading: t("Loading details…"),
  unavailable: t("Job details are unavailable."),
  empty: t("No logs or output files yet."),
  retry: t("Retry"),
  log: t("Log"),
  files: t("Output files"),
  detailsLabel: (recipe: string) => t("Details for {recipe}", { recipe }),
  showDetailsLabel: (recipe: string) => t("Show details for {recipe}", { recipe }),
  hideDetailsLabel: (recipe: string) => t("Hide details for {recipe}", { recipe }),
  status: {
    [NativeJobState.Running]: t("Running"),
    [NativeJobState.Completed]: t("Completed"),
    [NativeJobState.Cancelled]: t("Cancelled"),
    [NativeJobState.Failed]: t("Failed"),
    [NativeJobState.Interrupted]: t("Interrupted"),
  },
};

/** Host-owned time/GPU disclosure, shown even while the plugin is off. */
export function NativeJobLimits({ manifest }: { manifest: PluginManifest }): JSX.Element | null {
  const lines = nativeJobDisclosure(manifest);
  if (!lines.length) return null;
  return (
    <Section title={MESSAGE.title}>
      <div data-native-job-limits className="space-y-1 text-sm text-ink-3">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>{MESSAGE.permission}</p>
      </div>
    </Section>
  );
}

function elapsed(job: PluginNativeJobSummary): string {
  if (job.state === NativeJobState.Interrupted && !job.finishedAt) return "—";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.createdAt)) / SECOND_MS));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useJobDetails(id: string, job: PluginNativeJobSummary) {
  const [detail, setDetail] = useState<PluginNativeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh only on a state transition or explicit retry, never on each summary poll.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void window.studio.pluginNativeJob(id, job.id).then(
      (next) => {
        if (!alive) return;
        setDetail(next);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [id, job.id, job.state, attempt]);
  return { detail, loading, error, retry: () => setAttempt((previous) => previous + 1) };
}

function JobDetailBody({ job }: { job: PluginNativeResult }): JSX.Element {
  const log = [job.stdout, job.stderr].filter(Boolean).join("\n");
  return (
    <div className="space-y-3 text-sm text-ink-3">
      {job.reason && <p>{job.reason}</p>}
      {!log && !job.files.length && <p>{MESSAGE.empty}</p>}
      {log && (
        <div className="space-y-1">
          <h4 className="font-medium text-ink-2">{MESSAGE.log}</h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs" data-native-job-log>
            {log}
          </pre>
        </div>
      )}
      {job.files.length > 0 && (
        <div className="space-y-1">
          <h4 className="font-medium text-ink-2">{MESSAGE.files}</h4>
          <ul className="list-disc space-y-1 pl-4 break-words" data-native-job-files>
            {job.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function JobDetails({ id, job }: { id: string; job: PluginNativeJobSummary }): JSX.Element {
  const { detail, loading, error, retry } = useJobDetails(id, job);
  if (loading)
    return (
      <p role="status" className="text-sm text-ink-3">
        {MESSAGE.loading}
      </p>
    );
  if (error || !detail)
    return (
      <div className="space-y-2">
        <p role={error ? "alert" : "status"} className="text-sm text-ink-3">
          {error || MESSAGE.unavailable}
        </p>
        <Button onClick={retry}>{MESSAGE.retry}</Button>
      </div>
    );
  return <JobDetailBody job={detail} />;
}

function JobRow({
  id,
  job,
  pending,
  cancel,
}: {
  id: string;
  job: PluginNativeJobSummary;
  pending: boolean;
  cancel: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="genex-account space-y-4" data-native-job={job.id}>
      <div className="genex-account-row">
        <div className="genex-account-copy">
          <h3 className="text-sm font-medium">{job.recipe}</h3>
          <p>
            {job.project} · {MESSAGE.status[job.state]} · <span data-native-job-elapsed>{elapsed(job)}</span>
          </p>
        </div>
        <div className="genex-account-actions">
          <Button
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? MESSAGE.hideDetailsLabel(job.recipe) : MESSAGE.showDetailsLabel(job.recipe)}
            onClick={() => setOpen((previous) => !previous)}
          >
            {open ? MESSAGE.hideDetails : MESSAGE.details}
          </Button>
          {job.state === NativeJobState.Running && (
            <Button disabled={pending} aria-label={t("Cancel {recipe}", { recipe: job.recipe })} onClick={cancel}>
              {pending ? MESSAGE.cancelling : MESSAGE.cancel}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <section id={detailsId} aria-label={MESSAGE.detailsLabel(job.recipe)} data-native-job-details>
          <JobDetails id={id} job={job} />
        </section>
      )}
    </div>
  );
}

/** Durable native jobs, drawn by the host so cancellation does not depend on plugin code. */
export function NativeJobs({ id }: { id: string }): JSX.Element | null {
  const [jobs, setJobs] = useState<PluginNativeJobSummary[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await window.studio.pluginNativeJobs(id);
        if (alive) {
          setJobs(next);
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        reading = false;
      }
    };
    setJobs([]);
    setError("");
    setPending([]);
    void refresh();
    const timer = window.setInterval(() => void refresh(), JOB_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id]);
  const cancel = async (job: PluginNativeJobSummary) => {
    setPending((ids) => [...ids, job.id]);
    try {
      await window.studio.pluginCancelNativeJob(id, job.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending((ids) => ids.filter((value) => value !== job.id));
    }
  };
  if (!jobs.length && !error) return null;
  return (
    <div className="space-y-2" data-native-jobs>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {[...jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((job) => (
          <JobRow id={id} job={job} key={job.id} pending={pending.includes(job.id)} cancel={() => void cancel(job)} />
        ))}
    </div>
  );
}
