/**
 * The Builds tab's list, drawn: once the run is over its build first, then what works now, then what
 * changed, newest first, ending in one row that opens the steps left out of the build
 * (`builds-list.ts`). It fills the panel edge to edge and scrolls; there is no canvas to pan. A row is
 * its mark, its name, when it ended and what it made or how it stands, and on its right what it left
 * to look at: each thing it made, else its own picture; a row at work shows its agent's screen.
 * Pressing a row opens its card in its place.
 */
import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { assetKind } from "../../../shared/game-assets.ts";
import { t } from "../../../shared/i18n.ts";
import { StepMark } from "../../chat/StepMark.tsx";
import { type AssetInfo, runIdOf } from "../../run-graph.ts";
import { AssetCardState } from "../../run-graph-assets.ts";
import type { BuildCard } from "../../run-graph-builds.ts";
import {
  type AssetCard,
  isLiveStep,
  PictureSource,
  type ResultStatus,
  type Step,
  type WorkerPicture,
} from "../../run-steps.ts";
import { useStill } from "../../stills.ts";
import { Icon } from "../../ui/icons.tsx";
import { AssetThumbnail } from "../AssetThumbnail.tsx";
import { DeliveredPicture } from "../inspector/AssetsPanel.tsx";
import { formatTime } from "../inspector/format.ts";
import { IMAGE_OUTLINE } from "../inspector/pictures.tsx";
import { ScreenWords, useFrameSrc, usePartFrame } from "../inspector/screen.tsx";
import { GraphSelection } from "../inspector/selection.ts";
import { StateGlyph } from "../inspector/tone.tsx";
import { useRoundStill, useSavePointShot, useWorkerStill } from "../run-stills.ts";
import { type BuildsList as List, type ListRow, RowMark } from "./builds-list.ts";

const MESSAGE = {
  working: t("Working now"),
  changed: t("What changed"),
  yourBuild: t("Your build"),
  leftOut: (count: number) => t("{count, plural, other {# left out}}", { count }),
} as const;

/** How many pictures a row shows before it counts the rest. */
const PICTURES_SHOWN = 3;
/** The largest side, in pixels, a row's picture is read at. */
const ROW_PICTURE_PX = 256;
/** The ring of a picture that is an agent's screen right now. */
const LIVE_RING = "0 0 0 1.5px var(--accent), 0 0 0 5px var(--accent-tint)";
/** A picture a step only borrows (its build's screenshot, a save point it read): the same frame on every row. */
const BORROWED: ReadonlySet<WorkerPicture["source"]> = new Set([PictureSource.Build, PictureSource.Reviewed]);

/** What the list is drawn from, and what a press does. */
interface Props {
  list: List;
  project: string | null;
  /** the run's asset jobs, for the Assets row's pictures */
  assetJobs: AssetInfo[];
  runId: string;
  active: boolean;
  /** the run's build once it is over: its words and picture; null while it runs */
  result: { status: ResultStatus; src: string | null } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** close the open row's card */
  onClose: () => void;
  /** the open row's card, drawn in its place */
  card: ReactNode;
}

/** One picture of a row, at the size every row's pictures share. */
function Picture({
  src = null,
  live = false,
  screen = null,
  children = null,
}: {
  src?: string | null;
  live?: boolean;
  /** the agent's window this picture shows, for the smoke */
  screen?: string | null;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span
      data-agent-screen={screen ?? undefined}
      className="relative grid h-[60px] w-24 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-inset text-ink-3 not-first:hidden @min-[560px]/rows:not-first:grid"
      style={{ boxShadow: live ? LIVE_RING : IMAGE_OUTLINE }}
    >
      {src ? (
        <img src={src} decoding="async" alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        children
      )}
    </span>
  );
}

/** One thing a step made: its picture, else as the Assets stage draws it, else a sound's or a box's mark. */
function MadePicture({ project, card }: { project: string | null; card: AssetCard }): JSX.Element {
  const still = useWorkerStill(project, card.picture);
  const file = card.versions.at(-1)?.files[0];
  const sound = file !== undefined && assetKind(file) === "audio";
  if (still.src) return <Picture src={still.src} />;
  return (
    <Picture>
      {project && still.asset ? (
        <AssetThumbnail project={project} asset={still.asset} companions={[]} fallback={null} quiet />
      ) : (
        <Icon name={sound ? "sound" : "box"} size={18} />
      )}
    </Picture>
  );
}

/** A step's own picture: its shown try's, else one its worker left; never one it only borrows. */
function StepStill({
  step,
  project,
  runId,
}: {
  step: Step;
  project: string | null;
  runId: string;
}): JSX.Element | null {
  const shot = useSavePointShot(step.shown, step.earlier);
  const round = useRoundStill({ runId }, step.facetId, step.shown?.iteration ?? 1, shot?.path ?? null, false);
  const own = step.picture && !BORROWED.has(step.picture.source) ? step.picture : undefined;
  const worker = useWorkerStill(project, own);
  const src = round ?? worker.src;
  if (src) return <Picture src={src} />;
  if (!project || !worker.asset) return null;
  return (
    <Picture>
      <AssetThumbnail project={project} asset={worker.asset} companions={[]} fallback={null} quiet />
    </Picture>
  );
}

/** What a step's row shows on its right: its agent's screen while it works, each thing it made, else its own picture. */
function StepPictures({
  step,
  project,
  runId,
  active,
}: {
  step: Step;
  project: string | null;
  runId: string;
  active: boolean;
}): JSX.Element | null {
  const frame = usePartFrame(project, runIdOf({ runId }), step.facetId, isLiveStep(step) && active);
  const screen = useFrameSrc(frame);
  if (frame && screen) return <Picture src={screen} live screen={frame.handle} />;
  const made = step.assets ?? [];
  if (!made.length) return <StepStill step={step} project={project} runId={runId} />;
  return <Several items={made} draw={(card) => <MadePicture key={card.id} project={project} card={card} />} />;
}

/** The first few of a row's pictures, then how many more there are. */
function Several<T>({ items, draw }: { items: readonly T[]; draw: (item: T) => JSX.Element }): JSX.Element {
  const hidden = items.length - PICTURES_SHOWN;
  return (
    <>
      {items.slice(0, PICTURES_SHOWN).map(draw)}
      {hidden > 0 ? (
        <Picture>
          <span className="text-chat-sub text-ink-2">{`+${hidden}`}</span>
        </Picture>
      ) : null}
    </>
  );
}

/** The Assets row's pictures: what the run's asset jobs delivered, newest first. */
function AssetsPictures({ jobs, project }: { jobs: AssetInfo[]; project: string | null }): JSX.Element | null {
  const delivered = jobs.filter((job) => job.state === AssetCardState.Delivered).reverse();
  if (!delivered.length) return null;
  return (
    <Several
      items={delivered}
      draw={(job) => (
        <Picture key={job.jobId ?? job.callId ?? job.at}>
          <DeliveredPicture job={job} project={project} />
        </Picture>
      )}
    />
  );
}

/** A build check's screenshot, when it kept one. */
function BuildPicture({ build }: { build: BuildCard }): JSX.Element | null {
  const src = useStill(build.picture ? { run: build.picture, maxPx: ROW_PICTURE_PX } : null);
  return src ? <Picture src={src} /> : null;
}

/** A row's mark: the chat's own step mark, and a warning for a check that did not pass. */
function Mark({ mark }: { mark: RowMark }): JSX.Element {
  if (mark === RowMark.Problem)
    return (
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-orange">
        <Icon name="warning" size={14} />
      </span>
    );
  return <StepMark done={mark === RowMark.Added} working={mark === RowMark.Working} clear />;
}

/** A working step's line: what its agent is doing at its screen, else how the step stands. */
function StepDoing({
  step,
  detail,
  project,
  runId,
  active,
}: {
  step: Step;
  detail: string | null;
  project: string | null;
  runId: string;
  active: boolean;
}): JSX.Element {
  const frame = usePartFrame(project, runIdOf({ runId }), step.facetId, active);
  return <span className="chat-status-shimmer">{frame ? <ScreenWords frame={frame} /> : detail}</span>;
}

/** A row's second line: when it ended, then how it stands. */
function metaWords(row: ListRow): string {
  return [formatTime(row.at), row.detail].filter(Boolean).join(" · ");
}

/** What every row is drawn with, besides itself. */
type RowProps = Pick<Props, "project" | "runId" | "active" | "assetJobs" | "onSelect">;

/** One row of the list: pressing it opens its card in its place. */
function Row({ row, project, runId, active, assetJobs, onSelect }: RowProps & { row: ListRow }): JSX.Element {
  const working = row.mark === RowMark.Working;
  const muted = row.mark === RowMark.Out || row.mark === RowMark.Waiting;
  const meta = metaWords(row);
  return (
    <button
      type="button"
      data-graph-node={row.id}
      data-working={working || undefined}
      aria-expanded={false}
      // A step is named by the build, from the person's request.
      data-analytics-mask
      onClick={() => onSelect(row.id)}
      className="-mx-3 grid min-h-[68px] w-[calc(100%+24px)] cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] px-3 py-1 text-left hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Mark mark={row.mark} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`truncate text-chat ${muted ? "text-ink-3" : "text-ink"}`}>{row.title}</span>
        {working && row.step ? (
          <span className="truncate text-status text-ink-3">
            <StepDoing step={row.step} detail={row.detail} project={project} runId={runId} active={active} />
          </span>
        ) : null}
        {!working && meta ? (
          <span className={`truncate text-status ${row.mark === RowMark.Problem ? "text-orange" : "text-ink-3"}`}>
            {meta}
          </span>
        ) : null}
        {working && !row.step && row.detail ? (
          <span className="truncate text-status text-ink-3">{row.detail}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        {row.step ? <StepPictures step={row.step} project={project} runId={runId} active={active} /> : null}
        {row.build ? <BuildPicture build={row.build} /> : null}
        {row.id === GraphSelection.Assets ? <AssetsPictures jobs={assetJobs} project={project} /> : null}
      </span>
    </button>
  );
}

/** Rows of the list, the open one as its card. */
function Rows({ rows, props }: { rows: ListRow[]; props: Omit<Props, "list" | "result"> }): JSX.Element {
  return (
    <>
      {rows.map((row) =>
        props.selected === row.id ? <div key={row.id}>{props.card}</div> : <Row key={row.id} row={row} {...props} />,
      )}
    </>
  );
}

/**
 * The steps left out of the build, under one row that opens them in place. It is open while one of
 * them is (pressed on the chat's Building card, or walked to with an arrow); closing it closes that
 * card too.
 */
function LeftOut({ rows, props }: { rows: ListRow[]; props: Omit<Props, "list" | "result"> }): JSX.Element | null {
  const [pressed, setPressed] = useState(false);
  const holdsOpen = rows.some((row) => row.id === props.selected);
  const open = pressed || holdsOpen;
  const toggle = (): void => {
    if (holdsOpen) props.onClose();
    setPressed(!open);
  };
  if (!rows.length) return null;
  return (
    <>
      <button
        type="button"
        data-builds-left-out
        aria-expanded={open}
        onClick={toggle}
        className="-mx-3 grid min-h-[48px] w-[calc(100%+24px)] cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] px-3 py-1 text-left text-chat text-ink-3 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className="flex size-4 items-center justify-center">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        </span>
        <span className="truncate">{MESSAGE.leftOut(rows.length)}</span>
      </button>
      {open ? <Rows rows={rows} props={props} /> : null}
    </>
  );
}

/** A section of the list: its name and how many rows it has, then the rows, the open one as its card. */
function Section({
  label,
  rows,
  props,
  leftOut = [],
}: {
  label: string;
  rows: ListRow[];
  props: Omit<Props, "list" | "result">;
  /** the steps left out of the build, under one row after the rest */
  leftOut?: ListRow[];
}): JSX.Element | null {
  if (!rows.length && !leftOut.length) return null;
  return (
    <section className="flex min-w-0 flex-col">
      <h2 className="mb-3 flex items-baseline gap-2 text-chat-sub text-ink">
        {label}
        <span className="text-ink-3">{rows.length}</span>
      </h2>
      <div className="@container/rows -my-1 flex flex-col">
        <Rows rows={rows} props={props} />
        <LeftOut key={props.runId} rows={leftOut} props={props} />
      </div>
    </section>
  );
}

/** The run's build once it is over: its picture beside what became of it; pressing it opens its card. */
function YourBuild({
  result,
  onSelect,
}: {
  result: NonNullable<Props["result"]>;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-graph-node={GraphSelection.Final}
      aria-expanded={false}
      aria-label={t("{name}: {status}", { name: MESSAGE.yourBuild, status: result.status.word })}
      onClick={() => onSelect(GraphSelection.Final)}
      className="-m-3 flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-4 rounded-card p-3 text-left hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      {result.src ? (
        <span
          className="relative block aspect-video w-full max-w-[480px] min-w-[240px] flex-1 overflow-hidden rounded-card bg-inset"
          style={{ boxShadow: IMAGE_OUTLINE }}
        >
          <img
            src={result.src}
            decoding="async"
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-cover"
          />
        </span>
      ) : null}
      <span className="flex min-w-[200px] flex-1 flex-col gap-1">
        <span className="text-status text-ink-3">{MESSAGE.yourBuild}</span>
        <span className="flex items-center gap-2 text-name text-ink">
          <StateGlyph state={result.status.state} size={12} />
          {result.status.word}
        </span>
      </span>
    </button>
  );
}

/** The Builds tab's list. */
export function BuildsList({ list, result, ...props }: Props): JSX.Element {
  return (
    <div data-builds-list className="absolute inset-0 overflow-y-auto px-6 pt-6 pb-12 select-none">
      <div className="flex flex-col gap-8">
        {result && props.selected === GraphSelection.Final ? props.card : null}
        {result && props.selected !== GraphSelection.Final ? (
          <YourBuild result={result} onSelect={props.onSelect} />
        ) : null}
        <Section label={MESSAGE.working} rows={list.working} props={props} />
        <Section label={MESSAGE.changed} rows={list.changes} props={props} leftOut={list.leftOut} />
      </div>
    </div>
  );
}
