/**
 * The Builds tab's list, drawn: once the run is over its build first, then what works now, then what
 * changed, newest first, ending in one row that opens the steps left out of the build
 * (`builds-list.ts`). It fills the panel edge to edge and scrolls; there is no canvas to pan. A row is
 * its mark, its name, when it ended and what it made or how it stands, and on its right what it left
 * to look at: each thing it made, else its own picture; a row at work shows its agent's screen.
 * Pressing a row opens it in place: its header stays where it was and its card's body opens under it,
 * pushing the rows below down.
 */
import type { JSX, MouseEvent, ReactNode, Ref, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { ProjectAsset } from "../../../shared/game-assets.ts";
import { t } from "../../../shared/i18n.ts";
import { AudioThumb } from "../../chat/AudioStrip.tsx";
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
import { type StillSource, StillsNear, useStillRead } from "../../stills.ts";
import { Icon } from "../../ui/icons.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";
import { OUTCOME_WORDS } from "../../words.ts";
import { AssetThumbnail } from "../AssetThumbnail.tsx";
import { DeliveredPicture } from "../inspector/AssetsPanel.tsx";
import { blenderRender, firstImage } from "../inspector/asset-jobs.ts";
import { OPEN_EDGE, UnderRowHeader } from "../inspector/chrome.tsx";
import { formatTime } from "../inspector/format.ts";
import { IMAGE_OUTLINE } from "../inspector/pictures.tsx";
import { ScreenWords, useFrameSrc, usePartFrame } from "../inspector/screen.tsx";
import { GraphSelection } from "../inspector/selection.ts";
import { StateGlyph } from "../inspector/tone.tsx";
import type { LightItem } from "../inspector/types.ts";
import { useRoundStill, useSavePointShot, useWorkerStill, workerStillSource } from "../run-stills.ts";
import { type BuildsList as List, type ListRow, madeKind, RowMark } from "./builds-list.ts";

const MESSAGE = {
  working: t("Working now"),
  changed: t("What changed"),
  yourBuild: t("Your build"),
  leftOut: (count: number) => t("{count, plural, other {# left out}}", { count }),
  close: t("Close (Esc)"),
  showAll: (count: number) => t("Show all {count}", { count }),
} as const;

/** How many pictures a row shows before it counts the rest. */
const PICTURES_SHOWN = 3;
/** The largest side, in pixels, a row's picture is read at. */
const ROW_PICTURE_PX = 256;
/** The largest side, in pixels, a picture of the game is read at for the lightbox. */
const LIGHTBOX_PX = 2048;
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
  /** the run's build once it is over: how it stands, which version of the game it is, when it ended */
  result: { status: ResultStatus; version: number | null; endedAt: string | null } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** close the open row's card */
  onClose: () => void;
  /** open pictures in the lightbox, on the one at `index` */
  onLight: (items: LightItem[], index: number) => void;
  /** the open row's card, drawn under its row's header */
  card: ReactNode;
}

/** The classes every picture of a row shares: one size, and only the first on a narrow list. */
const PICTURE_CLASS =
  "relative grid h-[60px] w-24 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-inset text-ink-3 not-first:hidden @min-[560px]/rows:not-first:grid";

/** One picture of a row, at the size every row's pictures share; a skeleton while it is on its way. */
function Picture({
  src = null,
  live = false,
  loading = false,
  screen = null,
  children = null,
}: {
  src?: string | null;
  live?: boolean;
  loading?: boolean;
  /** the agent's window this picture shows, for the smoke */
  screen?: string | null;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span
      data-agent-screen={screen ?? undefined}
      className={PICTURE_CLASS}
      style={{ boxShadow: live ? LIVE_RING : IMAGE_OUTLINE }}
    >
      {src ? (
        <img src={src} decoding="async" alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : null}
      {!src && loading ? <Skeleton width="100%" height={60} radius={10} className="absolute inset-0" /> : null}
      {!src && !loading ? children : null}
    </span>
  );
}

/** A thing a step made, as its picture: its still, else as the Assets stage draws it, else a sound's or a box's mark. */
function MadePicture({ project, card }: { project: string | null; card: AssetCard }): JSX.Element {
  const still = useWorkerStill(project, card.picture, ROW_PICTURE_PX);
  const sound = madeKind(card) === "audio";
  if (still.src || still.loading) return <Picture src={still.src} loading={still.loading} />;
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
  const worker = useWorkerStill(project, own, ROW_PICTURE_PX);
  const src = round ?? worker.src;
  if (src) return <Picture src={src} />;
  if (!project || !worker.asset) return null;
  return (
    <Picture>
      <AssetThumbnail project={project} asset={worker.asset} companions={[]} fallback={null} quiet />
    </Picture>
  );
}

/**
 * One thing a row made, as the row shows it: a sound that plays in place, or a picture that opens
 * the lightbox (`full`, the whole picture) or, with nothing to open, only shows.
 */
interface Tile {
  key: string;
  name: string;
  /** the game's record of a sound it can play; null for anything else, or a sound not in the game */
  sound: ProjectAsset | null;
  /** the whole picture, for the lightbox; null for a sound, a model or a picture with none */
  full: StillSource | null;
  picture: JSX.Element;
}

/** What the row's tiles do: open the lightbox, open the row's card. */
interface TileActions {
  project: string | null;
  /** the row's name, the lightbox's caption */
  title: string;
  onLight: Props["onLight"];
  /** open the row's card, for the +N of a row whose rest are not all pictures; none once it is open */
  onMore?: () => void;
}

/** The lightbox items of a row's tiles: each that has a whole picture, in order. */
const lightItems = (tiles: readonly Tile[], title: string): LightItem[] =>
  tiles.flatMap((tile) =>
    tile.full ? [{ path: null, src: null, still: tile.full, title: tile.name, caption: title }] : [],
  );

/** One tile of a row: a sound that plays, a picture that opens the lightbox on itself, else its picture. */
function TileView({ tile, tiles, actions }: { tile: Tile; tiles: readonly Tile[]; actions: TileActions }): JSX.Element {
  if (tile.sound && actions.project)
    return (
      <span className={PICTURE_CLASS} style={{ boxShadow: IMAGE_OUTLINE }}>
        <AudioThumb project={actions.project} asset={tile.sound} className="absolute inset-0 rounded-[10px]" />
      </span>
    );
  const full = tile.full;
  if (!full) return tile.picture;
  const items = lightItems(tiles, actions.title);
  const open = (event: MouseEvent): void => {
    event.stopPropagation();
    actions.onLight(
      items,
      Math.max(
        0,
        items.findIndex((item) => item.still === full),
      ),
    );
  };
  return (
    <button
      type="button"
      aria-label={t("Open {name}", { name: tile.name })}
      title={tile.name}
      onClick={open}
      className="relative shrink-0 cursor-zoom-in rounded-[10px] not-first:hidden focus-visible:outline-2 focus-visible:outline-accent @min-[560px]/rows:not-first:block"
    >
      {tile.picture}
    </button>
  );
}

/**
 * The first few of a row's tiles, then how many more there are: a +N that opens the lightbox on
 * the next picture when every one is a picture, else the row's card.
 */
function Tiles({ tiles, actions }: { tiles: readonly Tile[]; actions: TileActions }): JSX.Element {
  const hidden = tiles.length - PICTURES_SHOWN;
  const items = lightItems(tiles, actions.title);
  const allPictures = items.length === tiles.length;
  // An open row has no card to open: its +N opens the next picture past the tiles, if it has one.
  const next = tiles.slice(PICTURES_SHOWN).find((tile) => tile.full);
  const nextAt = next ? items.findIndex((item) => item.still === next.full) : -1;
  const opens = allPictures || actions.onMore !== undefined || nextAt >= 0;
  const more = (event: MouseEvent): void => {
    event.stopPropagation();
    if (allPictures) actions.onLight(items, PICTURES_SHOWN);
    else if (actions.onMore) actions.onMore();
    else actions.onLight(items, nextAt);
  };
  return (
    <>
      {tiles.slice(0, PICTURES_SHOWN).map((tile) => (
        <TileView key={tile.key} tile={tile} tiles={tiles} actions={actions} />
      ))}
      {hidden > 0 && !opens ? (
        <span className={`${PICTURE_CLASS} text-chat-sub text-ink-3`} style={{ boxShadow: IMAGE_OUTLINE }}>
          {`+${hidden}`}
        </span>
      ) : null}
      {hidden > 0 && opens ? (
        <button
          type="button"
          aria-label={MESSAGE.showAll(tiles.length)}
          onClick={more}
          className={`${PICTURE_CLASS} cursor-pointer text-chat-sub text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent`}
          style={{ boxShadow: IMAGE_OUTLINE }}
        >
          {`+${hidden}`}
        </button>
      ) : null}
    </>
  );
}

/** The game's record of a sound a step made, when the game has it to play. */
function madeSound(card: AssetCard): ProjectAsset | null {
  const preview = card.versions.at(-1)?.preview;
  return preview?.kind === "audio" ? preview : null;
}

/** A step's made things as tiles. */
function madeTiles(project: string | null, cards: readonly AssetCard[]): Tile[] {
  return cards.map((card) => ({
    key: card.id,
    name: card.name,
    sound: madeSound(card),
    full: workerStillSource(project, card.picture, null, LIGHTBOX_PX),
    picture: <MadePicture key={card.id} project={project} card={card} />,
  }));
}

/** What a step's row shows on its right: its agent's screen while it works, each thing it made, else its own picture. */
function StepPictures({
  step,
  project,
  runId,
  active,
  actions,
}: {
  step: Step;
  project: string | null;
  runId: string;
  active: boolean;
  actions: TileActions;
}): JSX.Element | null {
  const frame = usePartFrame(project, runIdOf({ runId }), step.facetId, isLiveStep(step) && active);
  const screen = useFrameSrc(frame);
  if (frame && screen) return <Picture src={screen} live screen={frame.handle} />;
  const made = step.assets ?? [];
  if (!made.length) return <StepStill step={step} project={project} runId={runId} />;
  return <Tiles tiles={madeTiles(project, made)} actions={actions} />;
}

/** Where a delivered job's whole picture is read from: the copy Genex kept, the picture in the game, the modeller's render. */
function jobFull(job: AssetInfo, project: string | null): StillSource | null {
  if (job.picture) return { run: job.picture };
  // The picture its tile draws: a delivery the game has a record of is that file, else its first image.
  const image = job.preview ? deliveredImage(job.preview) : firstImage(job);
  if (image && project) return { project, asset: image, maxPx: LIGHTBOX_PX };
  return blenderRender(job);
}

/** The file of a delivery the game has a record of, when that file is a picture. */
const deliveredImage = (preview: ProjectAsset): string | null => (preview.kind === "image" ? preview.file : null);

/** The Assets row's pictures: what the run's asset jobs delivered, newest first. */
function AssetsPictures({ jobs, actions }: { jobs: AssetInfo[]; actions: TileActions }): JSX.Element | null {
  const delivered = jobs.filter((job) => job.state === AssetCardState.Delivered).reverse();
  if (!delivered.length) return null;
  const tiles = delivered.map((job) => {
    const key = job.jobId ?? job.callId ?? job.at;
    return {
      key,
      name: job.name,
      sound: job.preview?.kind === "audio" ? job.preview : null,
      full: jobFull(job, actions.project),
      picture: (
        <Picture key={key}>
          <DeliveredPicture job={job} project={actions.project} />
        </Picture>
      ),
    };
  });
  return <Tiles tiles={tiles} actions={actions} />;
}

/** A build check's screenshot, when it kept one. */
function BuildPicture({ build }: { build: BuildCard }): JSX.Element | null {
  const { src, loading } = useStillRead(build.picture ? { run: build.picture, maxPx: ROW_PICTURE_PX } : null);
  return src || loading ? <Picture src={src} loading={loading} /> : null;
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
type RowProps = Pick<Props, "project" | "runId" | "active" | "assetJobs" | "onSelect" | "onClose" | "onLight">;

/** How far below or above the screen a row's pictures start to load. */
const NEAR_SCREEN_MARGIN = "400px";

/** Whether `element` has come near the screen; once it has, it stays so. */
function useNearScreen(element: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (near || !target) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      // The rows scroll inside the list, so the margin is measured from its edges, not the window's.
      { root: target.closest("[data-builds-list]"), rootMargin: NEAR_SCREEN_MARGIN },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

/**
 * What a row's header shows on its right: what it left to look at. Open, a step keeps the
 * pictures it made there (its sounds are in the card); anything else gives way to its card.
 */
function RowPictures({ row, open, ...props }: RowProps & { row: ListRow; open: boolean }): JSX.Element | null {
  const { project, runId, active, assetJobs, onLight, onSelect } = props;
  const actions: TileActions = { project, title: row.title, onLight, onMore: () => onSelect(row.id) };
  if (open) {
    const pictures = (row.step?.assets ?? []).filter((card) => madeKind(card) !== "audio");
    const shown: TileActions = { project, title: row.title, onLight };
    return pictures.length ? <Tiles tiles={madeTiles(project, pictures)} actions={shown} /> : null;
  }
  return (
    <>
      {row.step ? (
        <StepPictures step={row.step} project={project} runId={runId} active={active} actions={actions} />
      ) : null}
      {row.build ? <BuildPicture build={row.build} /> : null}
      {row.id === GraphSelection.Assets ? <AssetsPictures jobs={assetJobs} actions={actions} /> : null}
    </>
  );
}

/**
 * One row of the list: pressing it opens it, pressing it again closes it. Its header button holds
 * its mark and words, and a press anywhere on the row (but on a picture that plays or opens) is
 * that button's. Open or closed the header is drawn the same, so it never moves. Its pictures load
 * only once the row nears the screen.
 */
function Row({
  row,
  open = false,
  header,
  ...props
}: RowProps & { row: ListRow; open?: boolean; header?: Ref<HTMLButtonElement> }): JSX.Element {
  const { project, runId, active, onSelect, onClose } = props;
  const element = useRef<HTMLDivElement>(null);
  const near = useNearScreen(element);
  const working = row.mark === RowMark.Working;
  const muted = row.mark === RowMark.Out || row.mark === RowMark.Waiting;
  const meta = metaWords(row);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the header button inside is the row's control; a press elsewhere on the row is its press
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard reaches the row through its header button, whose click bubbles here
    <div
      ref={element}
      data-graph-node={row.id}
      data-working={working || undefined}
      // A step is named by the build, from the person's request; its pictures are the person's work.
      data-analytics-mask
      onClick={() => (open ? onClose() : onSelect(row.id))}
      className="-mx-3 grid min-h-[68px] w-[calc(100%+24px)] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] px-3 py-1 hover:bg-control-hover has-[>button:focus-visible]:outline-2 has-[>button:focus-visible]:outline-accent"
    >
      <button
        ref={header}
        type="button"
        aria-expanded={open}
        title={open ? MESSAGE.close : undefined}
        className="grid min-w-0 cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-center gap-x-3 self-stretch text-left outline-none"
      >
        <Mark mark={row.mark} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={`truncate text-chat ${muted ? "text-ink-3" : "text-ink"}`}>{row.title}</span>
          {working && row.step ? (
            <span className="chat-status-shimmer truncate text-status text-ink-3">
              <StepDoing step={row.step} detail={row.detail} project={project} runId={runId} active={active} />
            </span>
          ) : null}
          {!working && meta ? (
            <span className={`truncate text-status ${row.mark === RowMark.Problem ? "text-orange" : "text-ink-3"}`}>
              {meta}
            </span>
          ) : null}
          {working && !row.step && row.detail ? (
            <span className="chat-status-shimmer truncate text-status text-ink-3">{row.detail}</span>
          ) : null}
        </span>
      </button>
      <span className="flex items-center gap-2">
        <StillsNear.Provider value={near}>
          <RowPictures row={row} open={open} {...props} />
        </StillsNear.Provider>
        {open ? (
          <span aria-hidden="true" className="flex size-7 items-center justify-center text-ink-3">
            <Icon name="caret-up" size={15} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** What the rows of a section are drawn with. */
type RowsProps = Omit<Props, "list" | "result">;

/**
 * A row in its slot, open or closed: the same header button either way, so pressing it to close
 * keeps the focus on it. Open, its card's body follows the header inside one soft line that takes up
 * no room. Opened from elsewhere (an arrow, the chat's Building card) the header is brought into view
 * if it is not; one already in view stays exactly where it is, and showing the tab again moves nothing.
 */
function RowSlot({ row, props }: { row: ListRow; props: RowsProps }): JSX.Element {
  const open = props.selected === row.id;
  const header = useRef<HTMLButtonElement>(null);
  const shownOpen = useRef(false);
  useEffect(() => {
    if (open && !shownOpen.current) header.current?.scrollIntoView({ block: "nearest" });
    shownOpen.current = open;
  }, [open]);
  return (
    <div data-builds-open={open ? row.id : undefined} className="relative flex flex-col">
      {open ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -inset-x-3 rounded-[12px]"
          style={{ boxShadow: OPEN_EDGE }}
        />
      ) : null}
      <Row row={row} open={open} header={header} {...props} />
      {open ? <UnderRowHeader.Provider value>{props.card}</UnderRowHeader.Provider> : null}
    </div>
  );
}

/** Rows of the list, the open one with its card under it. */
function Rows({ rows, props }: { rows: ListRow[]; props: RowsProps }): JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <RowSlot key={row.id} row={row} props={props} />
      ))}
    </>
  );
}

/**
 * The steps left out of the build, under one row that opens them in place. It is open while one of
 * them is (pressed on the chat's Building card, or walked to with an arrow); closing it closes that
 * card too.
 */
function LeftOut({ rows, props }: { rows: ListRow[]; props: RowsProps }): JSX.Element | null {
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
  props: RowsProps;
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

/**
 * The run's build once it is over, in one line above what changed: which version of the game it is
 * now and when it ended, else how it stands. Pressing it opens its card.
 */
function YourBuild({
  result,
  onSelect,
}: {
  result: NonNullable<Props["result"]>;
  onSelect: (id: string) => void;
}): JSX.Element {
  const word = result.version ? OUTCOME_WORDS.inGame(result.version) : result.status.word;
  const time = result.endedAt ? formatTime(result.endedAt) : null;
  return (
    <button
      type="button"
      data-graph-node={GraphSelection.Final}
      aria-expanded={false}
      aria-label={t("{name}: {status}", { name: MESSAGE.yourBuild, status: word })}
      onClick={() => onSelect(GraphSelection.Final)}
      className="-mx-3 -my-2 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-card px-3 py-2 text-left text-chat-sub hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      {result.version ? (
        // A version in the game is a bare check, as the chat's line wears it.
        <span aria-hidden="true" className="self-center text-ink">
          <Icon name="check" size={12} />
        </span>
      ) : (
        <StateGlyph state={result.status.state} size={12} />
      )}
      <span className="min-w-0 truncate text-ink">{word}</span>
      {time ? <span className="shrink-0 text-ink-3">· {time}</span> : null}
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
