/**
 * What the Assets canvas's waiting cards need from Genex to be approved where they stand: each
 * job's candidates and pictures, and Approve through the plugin's own action (its review and
 * approval dialogs). Genex's status is read only while a card waits on the person, so an open
 * canvas never polls the account's shared request budget for nothing.
 */
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { isUserCancelled } from "../../shared/errors.ts";
import { GENEX_PLUGIN_ID, GenexAction, type GenexJob, GenexJobStatus } from "../../shared/genex.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { type PluginReviewRequest, runPluginAction } from "../plugin-actions.ts";
import { usePlugins } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { type MakingChoice, type MakingReviews, MakingReviewsContext } from "./MakingCard.tsx";
import { PluginApproval } from "./PluginApproval.tsx";
import { genexJobRows } from "./plugins/genex/genex-view.ts";
import { useGenexStatus } from "./plugins/genex/use-genex-status.ts";
import { isActive } from "./plugins/labels.ts";

/** The Genex job a card stands for: the card is keyed by the generation once there is one. */
const jobFor = (jobs: readonly GenexJob[], jobId: string): GenexJob | undefined =>
  jobs.find((job) => job.id === jobId || job.generationId === jobId);

/** One job's choice: its candidates and pictures, while it still waits on the person. */
export function choiceFor(jobs: readonly GenexJob[], jobId: string): MakingChoice | null {
  const job = jobFor(jobs, jobId);
  if (job?.status !== GenexJobStatus.ApprovalRequired) return null;
  const [row] = genexJobRows([job]);
  return row ? { candidates: row.candidates, pictures: row.pictures } : null;
}

interface SourceProps {
  plugin: PluginInfo;
  project: string;
  onNotice: Notify;
  onReviews: (reviews: MakingReviews | null) => void;
}

/** Reads Genex while it is mounted and hands the canvas its reviews; shows the plugin's review dialog. */
function GenexReviews({ plugin, project, onNotice, onReviews }: SourceProps): JSX.Element | null {
  const { status, refresh } = useGenexStatus(plugin, project);
  const [approving, setApproving] = useState(false);
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const jobs = status?.jobs;
  const approve = useCallback(
    async (job: GenexJob, candidate: number | null): Promise<void> => {
      setApproving(true);
      try {
        const args = { id: job.id, ...(candidate === null ? {} : { candidate }) };
        await runPluginAction({ plugin, name: GenexAction.Approve, args, project, review: setReview });
      } catch (error) {
        // Declining a review or the native dialog is the person's choice, not a problem to show.
        if (!isUserCancelled(error)) notifyProblem(onNotice)(error);
      } finally {
        setApproving(false);
        await refresh();
        studio().library.refreshAssets(project);
      }
    },
    [plugin, project, onNotice, refresh],
  );
  const reviews = useMemo((): MakingReviews | null => {
    if (!jobs) return null;
    return {
      choiceOf: (jobId) => choiceFor(jobs, jobId),
      approve: (jobId, candidate) => {
        const job = jobFor(jobs, jobId);
        if (job) void approve(job, candidate);
      },
      busy: approving,
    };
  }, [jobs, approve, approving]);
  useEffect(() => onReviews(reviews), [reviews, onReviews]);
  useEffect(() => () => onReviews(null), [onReviews]);
  return review ? <PluginApproval review={review} onClose={() => setReview(null)} /> : null;
}

/** The canvas's reviews for its cards; Genex is read only while `waiting` (some card waits on the person). */
export function MakingReviewsProvider({
  project,
  waiting,
  onNotice,
  children,
}: {
  project: string;
  waiting: boolean;
  onNotice: Notify;
  children: ReactNode;
}): JSX.Element {
  const genex = usePlugins((s) => s.list.find((plugin) => plugin.manifest.id === GENEX_PLUGIN_ID) ?? null);
  const [reviews, setReviews] = useState<MakingReviews | null>(null);
  const reading = waiting && genex !== null && isActive(genex);
  return (
    <MakingReviewsContext value={reading ? reviews : null}>
      {children}
      {reading && genex && <GenexReviews plugin={genex} project={project} onNotice={onNotice} onReviews={setReviews} />}
    </MakingReviewsContext>
  );
}
