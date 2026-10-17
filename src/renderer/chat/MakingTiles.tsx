/**
 * The assets a piece of work is still making, as the Assets canvas shows them: the same card at
 * the same size, under the work's heading, where its files will show once they land. It is a view
 * of the game's inventory (`ProjectAssets.jobs`): a card shows while the inventory lists its job
 * as waiting, so it never outlives the job, ends with it, and approves in place as on the canvas.
 * An old chat reads the inventory once; it is kept fresh only while something is on its way.
 */
import { type JSX, memo, useEffect, useMemo } from "react";
import { isGenexSource, type MakingJob, MakingPhase } from "../../shared/asset-making.ts";
import { CARD_IMAGE_H, CARD_W } from "../assets-layout.ts";
import { MakingCard, usePluginSources } from "../panels/MakingCard.tsx";
import { MakingReviewsProvider } from "../panels/MakingReviews.tsx";
import { useLibrary } from "../state/hooks.ts";
import { assetsOf } from "../state/library.ts";
import { studio } from "../state/studio.ts";
import type { Notify } from "../state/toasts.ts";
import { MAKING_WORDS } from "../words.ts";
import { jobsOfCalls, keepsReading, type MakingCall } from "./making-calls.ts";

const NO_JOBS: MakingJob[] = [];
/** The gap between the chat's cards, in pixels: the grid's `gap-2`. */
const TILE_GAP = 8;
/**
 * A card that waits on the person's choice is two cards wide and two tall, so its candidate can be
 * seen and picked in a narrow chat; on a chat narrower than two cards it takes the whole row.
 */
const CHOICE_STYLE = {
  gridColumn: "1 / -1",
  width: `min(100%, ${2 * CARD_W + TILE_GAP}px)`,
  aspectRatio: `${2 * CARD_W + TILE_GAP} / ${2 * CARD_IMAGE_H + TILE_GAP}`,
} as const;
const CARD_STYLE = { width: CARD_W, height: CARD_IMAGE_H } as const;

export const MakingTiles = memo(function MakingTiles({
  project,
  calls,
  onNotice,
}: {
  project: string;
  calls: readonly MakingCall[];
  onNotice: Notify;
}): JSX.Element | null {
  const inventory = useLibrary((s) => assetsOf(s, project).value);
  const jobs = inventory?.jobs ?? NO_JOBS;
  const shown = useMemo(() => jobsOfCalls(jobs, calls), [jobs, calls]);
  const reading = keepsReading(inventory !== null, calls, shown);
  useEffect(() => (reading ? studio().library.watchAssets(project) : undefined), [reading, project]);
  const plugins = usePluginSources();
  if (!shown.length) return null;
  const choosing = shown.some((job) => isGenexSource(job.source) && job.phase === MakingPhase.Review);
  return (
    <section
      data-chat-making
      aria-label={MAKING_WORDS.inChat}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD_W}px)` }}
    >
      <MakingReviewsProvider project={project} waiting={choosing} onNotice={onNotice}>
        {shown.map((job) => (
          <div
            key={job.jobId}
            data-chat-making-card={job.phase === MakingPhase.Review ? "choice" : "card"}
            style={job.phase === MakingPhase.Review ? CHOICE_STYLE : CARD_STYLE}
          >
            <MakingCard
              job={job}
              plugin={plugins.get(job.source) ?? (job.sourceName ? { name: job.sourceName } : undefined)}
            />
          </div>
        ))}
      </MakingReviewsProvider>
    </section>
  );
});
