/** Asset inventory with local image, media, model and animation previews. */
import type { JSX } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import { isGenexSource, type MakingJob, MakingPhase } from "../../shared/asset-making.ts";
import { withoutGenexSources } from "../../shared/genex.ts";
import type { MakingSource } from "../asset-making.ts";
import { foldMotions, type FoldedMotions } from "../../shared/model-rig.ts";
import type { GameLibraryStates } from "../../shared/asset-library.ts";
import {
  cardTagOf,
  lineRows,
  type ShareProgress,
  selectionActions,
  stateOf,
  toggledSelection,
} from "../asset-library-view.ts";
import { layoutAssets } from "../assets-layout.ts";
import { gridTransform, keepView, keptView, useCanvasView, useOnWheel } from "../canvas-view.ts";
import { boundsOf } from "../run-graph.ts";
import { useLibrary, usePeople, useSharing } from "../state/hooks.ts";
import { assetsOf } from "../state/library.ts";
import { libraryOf, sharesOf } from "../state/sharing.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { AssetPreview } from "./AssetPreview.tsx";
import { AssetTile } from "./AssetTile.tsx";
import { AudioTile } from "../chat/AudioStrip.tsx";
import { useModelRigs } from "../model-rigs.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { typingIn } from "./keyboard.ts";
import { Pending } from "../ui/Pending.tsx";
import { MakingCard, usePluginSources } from "./MakingCard.tsx";
import { MakingReviewsProvider } from "./MakingReviews.tsx";
import { AssetSearchField, AssetSearchResults } from "./assets/AssetSearch.tsx";
import { CardTagMark, PickCircle, ShareLineMark } from "./assets/CardMarks.tsx";
import { SelectionBar } from "./assets/SelectionBar.tsx";
import { ShareDialog } from "./assets/ShareDialog.tsx";
import { ViewerActions } from "./assets/ViewerActions.tsx";
import { t } from "../../shared/i18n.ts";
import { Skeleton } from "../ui/Skeleton.tsx";

/** How wide each waiting tile's name is: six tiles, as many as a first look usually shows. */
const ASSET_TILE_NAMES = ["70%", "55%", "62%", "48%", "66%", "40%"] as const;

const NO_WAITING: MakingJob[] = [];
const NOTHING_PICKED: ReadonlySet<string> = new Set();
/** The fewest picked cards that bring up the selection bar. */
const BAR_MIN_PICKED = 2;
/** A Genex job waiting for the person's choice: the canvas then reads Genex for its candidates. */
const waitsForGenexChoice = (job: MakingJob): boolean => isGenexSource(job.source) && job.phase === MakingPhase.Review;
/** Nothing folded: before the models' headers are read. */
const NOTHING_FOLDED: FoldedMotions = { clipsOf: new Map(), loose: [], motions: new Set() };
/** The canvas's dot grid, in canvas pixels, and one press of zoom in or out. */
const GRID_PX = 22;
const ZOOM_STEP = 1.2;

type Layout = ReturnType<typeof layoutAssets>;
type Group = Layout["groups"][number];

interface Props {
  project: string;
  focusJob?: string | null;
  onNotice: Notify;
}

/** A job still on its way, in the spot its asset will land. */
function WaitingCard({
  layout,
  group,
  job,
  plugin,
}: {
  layout: Layout;
  group: Group;
  job: MakingJob;
  plugin: MakingSource;
}): JSX.Element | null {
  const rect = layout.rects[`pending:${group.source}:${job.jobId}`];
  if (!rect) return null;
  return (
    <div className="absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <MakingCard job={job} plugin={plugin} />
    </div>
  );
}

/**
 * Who a group's cards came from: a source Studio names itself (Genex, Blender, your files) by that
 * name, any other plugin by its own name and picture, a connector by the name its jobs carry.
 */
function sourceOf(group: Group, plugins: ReadonlyMap<string, MakingSource>): MakingSource {
  const plugin = plugins.get(group.source);
  const named = group.label !== group.source;
  if (named) return { ...plugin, name: group.label };
  if (plugin) return plugin;
  const carried = group.jobs.find((job) => job.waiting?.sourceName)?.waiting?.sourceName;
  return { name: carried ?? group.label };
}

/** One file's card as the canvas and its search draw it: a sound's waveform, else its picture. */
function CanvasTile({
  project,
  asset,
  companions,
  folded,
  onOpen,
}: {
  project: string;
  asset: ProjectAsset;
  companions: string[];
  folded: FoldedMotions;
  onOpen: (asset: ProjectAsset) => void;
}): JSX.Element {
  if (asset.kind === "audio") return <AudioTile project={project} asset={asset} onOpen={() => onOpen(asset)} />;
  return (
    <AssetTile
      project={project}
      asset={asset}
      companions={companions}
      clips={folded.clipsOf.get(asset.file)?.length ?? 0}
      motion={folded.motions.has(asset.file)}
      onOpen={() => onOpen(asset)}
    />
  );
}

/** What the cards carry besides their pictures: the library's word on each, its share, and the picked ones. */
interface CardMarks {
  library: GameLibraryStates | null;
  shares: Record<string, ShareProgress>;
  picked: ReadonlySet<string>;
  onToggle: (file: string) => void;
}

/** A Cmd- or Shift-click picks the card among several instead of opening it. */
const picksCard = (event: { metaKey: boolean; shiftKey: boolean }): boolean => event.metaKey || event.shiftKey;

/** One asset's card where the layout put it: its tile, its tag, its pick circle and its share's line. */
function AssetCard({
  rect,
  source,
  asset,
  selected,
  marks,
  project,
  children,
}: {
  rect: Layout["rects"][string];
  source: string;
  asset: ProjectAsset;
  selected: boolean;
  marks: CardMarks;
  project: string;
  children: JSX.Element;
}): JSX.Element {
  const tag = cardTagOf(stateOf(marks.library, asset.file));
  const progress = marks.shares[asset.file];
  const picked = marks.picked.has(asset.file);
  return (
    <div
      data-asset-card={asset.file}
      data-asset-kind={asset.kind}
      data-asset-source={source}
      className="asset-card absolute rounded-card"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        boxShadow: selected || picked ? "0 0 0 1.5px var(--accent)" : undefined,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClickCapture={(event) => {
        if (!picksCard(event)) return;
        event.preventDefault();
        event.stopPropagation();
        marks.onToggle(asset.file);
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      {tag && <CardTagMark tag={tag} />}
      {marks.picked.size > 0 && (
        <PickCircle picked={picked} name={assetName(asset)} onToggle={() => marks.onToggle(asset.file)} />
      )}
      {progress && <ShareLineMark project={project} file={asset.file} progress={progress} />}
    </div>
  );
}

/** A file's name as its card's controls say it. */
const assetName = (asset: ProjectAsset): string => asset.file.split("/").at(-1) ?? asset.file;

/** Every group of the inventory: its heading, its jobs still on their way, and its asset cards. */
const AssetGroups = memo(function AssetGroups({
  layout,
  project,
  companions,
  selected,
  folded,
  marks,
  onOpen,
}: {
  layout: Layout;
  project: string;
  companions: string[];
  selected: string | null;
  folded: FoldedMotions;
  marks: CardMarks;
  onOpen: (asset: ProjectAsset) => void;
}): JSX.Element {
  const plugins = usePluginSources();
  const card = (group: Group, asset: ProjectAsset): JSX.Element | null => {
    const rect = layout.rects[`asset:${asset.file}`];
    if (!rect) return null;
    return (
      <AssetCard
        key={asset.file}
        rect={rect}
        source={group.source}
        asset={asset}
        selected={selected === asset.file}
        marks={marks}
        project={project}
      >
        <CanvasTile project={project} asset={asset} companions={companions} folded={folded} onOpen={onOpen} />
      </AssetCard>
    );
  };
  return (
    <>
      {layout.groups.map((group) => {
        const head = layout.rects[group.id];
        if (!head) return null;
        const source = sourceOf(group, plugins);
        return (
          <div key={group.id}>
            <div className="absolute flex items-baseline gap-2" style={{ left: head.x, top: head.y, width: head.w }}>
              <span className="text-body-sm font-medium text-ink">{source.name}</span>
            </div>
            {group.jobs.map((job) => (
              <div key={job.id}>
                {job.waiting && <WaitingCard layout={layout} group={group} job={job.waiting} plugin={source} />}
                {job.assets.map((asset) => card(group, asset))}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
});

/** The canvas with nothing on it: why it could not load, that it is loading, or that nothing has landed yet. */
function EmptyAssets({
  loadError,
  loaded,
  onRetry,
}: {
  loadError: string | null | undefined;
  loaded: boolean;
  onRetry: () => void;
}): JSX.Element {
  if (loadError)
    return (
      <div role="alert" className="flex max-w-sm flex-col items-center gap-2">
        <span className="text-name font-medium text-ink">{t("Could not load assets")}</span>
        <span className="text-body-sm leading-relaxed text-ink-3">{loadError}</span>
        <Button variant="outline" className="mt-2" onClick={onRetry}>
          {t("Retry")}
        </Button>
      </div>
    );
  if (!loaded)
    return (
      <Pending label={t("Loading assets…")} className="skeleton-tiles">
        {ASSET_TILE_NAMES.map((width) => (
          <span key={width} className="skeleton-tile">
            <Skeleton height={90} radius={12} />
            <Skeleton width={width} height={8} />
          </span>
        ))}
      </Pending>
    );
  return (
    <EmptyState
      data-assets-empty=""
      art="assets"
      title={t("No assets yet")}
      subtitle={t("Models, sounds and images land here.")}
    />
  );
}

function AssetsZoom({
  pct,
  onZoom,
  onFit,
}: {
  pct: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
}): JSX.Element {
  return (
    <div className="absolute bottom-2.5 left-2.5 flex h-7 items-center gap-0.5 rounded-control bg-surface px-1 shadow-btn">
      <Button
        variant="ghost"
        aria-label={t("Zoom out of the assets canvas")}
        title={t("Zoom out")}
        className="!h-6 !px-2"
        onClick={() => onZoom(1 / ZOOM_STEP)}
      >
        −
      </Button>
      <span className="w-10 text-center font-mono text-micro text-ink-3 tabular-nums">
        {t("{percent}%", { percent: pct })}
      </span>
      <Button
        variant="ghost"
        aria-label={t("Zoom into the assets canvas")}
        title={t("Zoom in")}
        className="!h-6 !px-2"
        onClick={() => onZoom(ZOOM_STEP)}
      >
        +
      </Button>
      <Button
        variant="ghost"
        aria-label={t("Fit every asset")}
        title={t("Fit everything")}
        className="!h-6 !px-2 !text-micro"
        onClick={onFit}
      >
        {t("Fit")}
      </Button>
    </div>
  );
}

/** One game's canvas, as its kept camera is named. */
const assetsViewKey = (project: string): string => `assets\n${project}`;

/**
 * The canvas's camera: fitted once per game before it is drawn, with small collections kept at
 * their natural size. A camera the user moved (a pan, the wheel, the zoom buttons) comes back as
 * they left it when the tab or the game returns; Fit hands it back to fitting.
 */
function useAssetsCamera(project: string, loaded: boolean, layout: Layout) {
  const touched = useRef(false);
  const touch = useCallback(() => {
    touched.current = true;
  }, []);
  const canvas = useCanvasView({ initial: keptView(assetsViewKey(project)) ?? { k: 1, tx: 0, ty: 0 }, onPan: touch });
  const { viewRef, fit, zoomBy, apply, viewport } = canvas;
  useOnWheel(viewport, touch);
  const fitted = useRef<string | null>(null);
  const fitAssets = useCallback(
    (bounds: ReturnType<typeof boundsOf>) => {
      touched.current = false;
      fit(bounds);
      // A small collection stays at its natural card size; larger collections fit down.
      if (viewRef.current.k > 1) zoomBy(1 / viewRef.current.k);
    },
    [fit, zoomBy, viewRef],
  );
  // Another game is another canvas: its kept camera, else fitted again. Leaving keeps this one's.
  useLayoutEffect(() => {
    const kept = keptView(assetsViewKey(project));
    touched.current = kept !== null;
    fitted.current = kept ? project : null;
    if (kept) apply(kept);
    return () => {
      const moved = touched.current && fitted.current === project;
      keepView(assetsViewKey(project), moved ? viewRef.current : null);
    };
  }, [project, apply, viewRef]);
  // Fit once per project, as soon as there is something to fit, before it is painted.
  useLayoutEffect(() => {
    if (!loaded || fitted.current === project) return;
    const bounds = boundsOf(Object.values(layout.rects));
    if (!bounds) return;
    fitted.current = project;
    fitAssets(bounds);
  }, [loaded, project, layout, fitAssets]);
  const zoomByHand = useCallback(
    (factor: number) => {
      touch();
      zoomBy(factor);
    },
    [touch, zoomBy],
  );
  return { ...canvas, zoomBy: zoomByHand, fitAssets };
}

// One press, one dismissal — the same chain the Builds canvas uses, so Escape never also
// reaches the chat behind the stage.
/** Escape clears the selection (the picked cards first), unless a preview is open or the press belongs to a field. */
function useEscapeClears(active: boolean, previewOpen: boolean, clear: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || previewOpen || !active) return;
      if (typingIn(event.target)) return;
      clear();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, previewOpen, clear]);
}

/** The game's asset inventory from the library store, which keeps it fresh while the canvas is open. */
function useProjectAssets(project: string) {
  // The library store keeps this game's inventory fresh while the canvas is open: one read on a
  // plugin's or a delivery's word, and a walk every ten seconds for hand-dropped files.
  useEffect(() => studio().library.watchAssets(project), [project]);
  const ledger = useLibrary((s) => assetsOf(s, project).value);
  const loadError = useLibrary((s) => assetsOf(s, project).error);
  const refresh = useCallback(() => studio().library.refreshAssets(project), [project]);
  return { ledger, loadError, refresh, assets: ledger?.assets ?? [], waiting: ledger?.jobs ?? NO_WAITING };
}

/** The selected asset and the one open in the preview: cleared for another game, moved to a job the stage asks for. */
function useAssetSelection(project: string, assets: ProjectAsset[], focusJob: string | null | undefined) {
  const [selected, setSelected] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<ProjectAsset | null>(null);
  // Another game is another canvas: nothing selected, nothing open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new game clears the selection and the preview
  useEffect(() => {
    setSelected(null);
    setPreviewAsset(null);
  }, [project]);
  useEffect(() => {
    if (!focusJob) return;
    const found = assets.find((a) => a.jobId === focusJob || a.generationId === focusJob);
    if (found) setSelected(found.file);
  }, [assets, focusJob]);
  return { selected, setSelected, previewAsset, setPreviewAsset };
}

/**
 * The game's animation files folded into the models they move, by the models' headers (newest model
 * first), or null until the headers are read. A folded file gets no card of its own.
 */
function useFoldedMotions(project: string, assets: ProjectAsset[]): FoldedMotions | null {
  const newestFirst = useMemo(
    () => [...assets].sort((a, b) => b.mtime.localeCompare(a.mtime)).map((asset) => asset.file),
    [assets],
  );
  const rigs = useModelRigs(project, newestFirst);
  return useMemo(() => (rigs ? foldMotions(rigs) : null), [rigs]);
}

/**
 * The files that get a card, once the models' headers are read: clips ride on their model (a clip
 * whose model came earlier keeps its own), and a Genex source copy on the finished model it was
 * made into.
 */
function cardedAssets(assets: ProjectAsset[], folded: FoldedMotions | null): ProjectAsset[] {
  if (!folded) return [];
  return withoutGenexSources(
    assets.filter((asset) => !folded.motions.has(asset.file) || folded.loose.includes(asset.file)),
  );
}

/**
 * The open game's files as its library knows them: read when the tab opens, whenever the files
 * change, and when the Genex account signs in, out or changes.
 */
function useLibraryStates(project: string, ledger: unknown) {
  const account = usePeople((s) => s.account);
  const me = usePeople((s) => s.me?.id ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new inventory or account is a new read
  useEffect(() => {
    void studio().sharing.read(project);
  }, [project, ledger, account, me]);
  const library = useSharing((s) => libraryOf(s, project));
  const shares = useSharing((s) => sharesOf(s, project));
  return { library, shares };
}

/**
 * The cards picked among several by Cmd- or Shift-click. Picking starts from the card a plain click
 * selected, which joins the picked ones; another game starts with none.
 */
function usePicked(project: string, selected: string | null, setSelected: (file: string | null) => void) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(NOTHING_PICKED);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new game picks nothing
  useEffect(() => setPicked(NOTHING_PICKED), [project]);
  const toggle = useCallback(
    (file: string) => {
      setPicked((current) => toggledSelection(current, selected, file));
      setSelected(null);
    },
    [selected, setSelected],
  );
  const clear = useCallback(() => setPicked(NOTHING_PICKED), []);
  return { picked, toggle, clear };
}

/** The search box's words, empty again for another game. */
function useSearchQuery(project: string) {
  const [query, setQuery] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new game starts unsearched
  useEffect(() => setQuery(""), [project]);
  return { query, setQuery, searching: query.trim().length > 0 };
}

/** Everything the canvas draws from: the inventory, the library's word on it, the picks, the layout and the camera. */
function useAssetsCanvas(project: string, focusJob: string | null | undefined) {
  const inventory = useProjectAssets(project);
  const { assets, waiting, ledger } = inventory;
  const selection = useAssetSelection(project, assets, focusJob);
  const { library, shares } = useLibraryStates(project, ledger);
  const pick = usePicked(project, selection.selected, selection.setSelected);
  const search = useSearchQuery(project);
  const folded = useFoldedMotions(project, assets);
  const carded = useMemo(() => cardedAssets(assets, folded), [assets, folded]);
  const companions = useMemo(() => assets.map((a) => a.assetRef ?? a.file), [assets]);
  const lines = useMemo(
    () => new Map(Object.entries(shares).map(([file, progress]) => [file, lineRows(progress)])),
    [shares],
  );
  // Nothing is laid out until the models' headers are read, so no card shows that then folds away.
  const headersRead = folded !== null;
  const layout = useMemo(
    () => layoutAssets(carded, headersRead ? waiting : NO_WAITING, lines),
    [carded, waiting, headersRead, lines],
  );
  const camera = useAssetsCamera(project, Boolean(ledger) && headersRead, layout);
  const marks = useMemo<CardMarks>(
    () => ({ library, shares, picked: pick.picked, onToggle: pick.toggle }),
    [library, shares, pick.picked, pick.toggle],
  );
  const pickedAssets = useMemo(() => carded.filter((asset) => pick.picked.has(asset.file)), [carded, pick.picked]);
  return {
    ...inventory,
    ...selection,
    ...search,
    library,
    shares,
    pick,
    folded,
    carded,
    companions,
    layout,
    camera,
    marks,
    pickedAssets,
  };
}

type CanvasModel = ReturnType<typeof useAssetsCanvas>;

/** The dot grid and, over it, the cards where the camera shows them; the cards step aside while a search shows. */
function CanvasStage({
  model,
  project,
  hidden,
  onOpen,
  onNotice,
}: {
  model: CanvasModel;
  project: string;
  hidden: boolean;
  onOpen: (asset: ProjectAsset) => void;
  onNotice: Notify;
}): JSX.Element {
  const { camera, layout, waiting } = model;
  const { view, viewport, onBackgroundDown, moved, panning } = camera;
  return (
    <div
      ref={viewport}
      className={`absolute inset-0 ${panning ? "cursor-grabbing" : "cursor-grab"}`}
      onPointerDown={onBackgroundDown}
      onClick={() => {
        if (moved.current) return;
        model.setSelected(null);
        model.pick.clear();
      }}
    >
      <div
        ref={camera.grid}
        data-grid-scale={view.k}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0"
        style={{
          width: `calc(150% + ${GRID_PX * 2}px)`,
          height: `calc(150% + ${GRID_PX * 2}px)`,
          backgroundImage: "radial-gradient(var(--line-strong) 1px, transparent 1.25px)",
          backgroundSize: `${GRID_PX * view.k}px ${GRID_PX * view.k}px`,
          transform: gridTransform(view, view.k),
          transformOrigin: "0 0",
        }}
      />
      <div
        ref={camera.layer}
        className={`absolute top-0 left-0 ${hidden ? "invisible" : ""}`}
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
          transformOrigin: "0 0",
        }}
      >
        <MakingReviewsProvider project={project} waiting={waiting.some(waitsForGenexChoice)} onNotice={onNotice}>
          <AssetGroups
            layout={layout}
            project={project}
            companions={model.companions}
            selected={model.selected}
            folded={model.folded ?? NOTHING_FOLDED}
            marks={model.marks}
            onOpen={onOpen}
          />
        </MakingReviewsProvider>
      </div>
    </div>
  );
}

/** The bar for two or more picked cards: Save the ones not saved, Share the ones Share can take. */
function PickedBar({
  model,
  project,
  onShare,
  onNotice,
}: {
  model: CanvasModel;
  project: string;
  onShare: (assets: ProjectAsset[]) => void;
  onNotice: Notify;
}): JSX.Element | null {
  const { pickedAssets, library } = model;
  if (pickedAssets.length < BAR_MIN_PICKED) return null;
  const actions = selectionActions(library, new Set(pickedAssets.map((asset) => asset.file)), model.shares);
  const save = (): void => {
    void studio().sharing.save(project, actions.save, true).catch(notifyProblem(onNotice));
  };
  return (
    <SelectionBar
      count={pickedAssets.length}
      canSave={actions.save.length > 0}
      canShare={actions.share.length > 0}
      onSave={save}
      onShare={() => onShare(pickedAssets.filter((asset) => actions.share.includes(asset.file)))}
      onClear={model.pick.clear}
    />
  );
}

/** The opened asset over the window, with Save and Share left of Reveal. */
function OpenedAsset({
  model,
  project,
  asset,
  onShare,
  onNotice,
}: {
  model: CanvasModel;
  project: string;
  asset: ProjectAsset;
  onShare: (asset: ProjectAsset) => void;
  onNotice: Notify;
}): JSX.Element {
  const { assets, folded } = model;
  const reveal = (): void => {
    void window.studio.revealProject(project, asset.assetRef ?? asset.file).catch(notifyProblem(onNotice));
  };
  return (
    <AssetPreview
      key={`${project}:${asset.assetRef ?? asset.file}`}
      project={project}
      asset={asset}
      assets={assets}
      clips={assets.filter((each) => folded?.clipsOf.get(asset.file)?.includes(each.file))}
      library={
        <ViewerActions
          project={project}
          state={stateOf(model.library, asset.file)}
          progress={model.shares[asset.file]}
          onShare={() => onShare(asset)}
          onNotice={onNotice}
        />
      }
      onClose={() => model.setPreviewAsset(null)}
      onReveal={reveal}
    />
  );
}

export function AssetsCanvas({ project, onNotice, focusJob }: Props): JSX.Element {
  const model = useAssetsCanvas(project, focusJob);
  const { ledger, loadError, refresh, assets, waiting, previewAsset, setPreviewAsset, camera, layout } = model;
  const { selected, setSelected, pick, query, setQuery, searching } = model;
  const [sharing, setSharing] = useState<ProjectAsset[] | null>(null);
  const clearPicks = pick.picked.size > 0 ? pick.clear : () => setSelected(null);
  useEscapeClears(pick.picked.size > 0 || selected !== null, previewAsset !== null, clearPicks);
  const openAsset = useCallback(
    (asset: ProjectAsset) => {
      pick.clear();
      setSelected(asset.file);
      setPreviewAsset(asset);
    },
    [pick.clear, setSelected, setPreviewAsset],
  );
  const openFound = useCallback(
    (asset: ProjectAsset) => {
      setQuery("");
      openAsset(asset);
    },
    [setQuery, openAsset],
  );

  return (
    <div data-assets-canvas className="absolute inset-0 overflow-hidden bg-canvas select-none">
      <CanvasStage model={model} project={project} hidden={searching} onOpen={openAsset} onNotice={onNotice} />

      {!assets.length && !waiting.length && !searching ? (
        <div className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8 text-center">
          <EmptyAssets loadError={loadError} loaded={Boolean(ledger)} onRetry={refresh} />
        </div>
      ) : null}

      {ledger?.truncated ? (
        <div className="absolute top-2.5 right-2.5 rounded-control bg-surface px-2 py-1 text-micro text-ink-3 shadow-btn">
          {t("This game has more files than the canvas lists.")}
        </div>
      ) : null}

      {searching ? (
        <AssetSearchResults
          project={project}
          query={query}
          assets={model.carded}
          library={model.library}
          tile={(asset) => (
            <CanvasTile
              project={project}
              asset={asset}
              companions={model.companions}
              folded={model.folded ?? NOTHING_FOLDED}
              onOpen={openFound}
            />
          )}
          onNotice={onNotice}
        />
      ) : (
        <>
          <AssetsZoom
            pct={Math.round(camera.view.k * 100)}
            onZoom={camera.zoomBy}
            onFit={() => camera.fitAssets(boundsOf(Object.values(layout.rects)))}
          />
          <PickedBar model={model} project={project} onShare={setSharing} onNotice={onNotice} />
        </>
      )}
      <AssetSearchField query={query} onQuery={setQuery} />

      {previewAsset ? (
        <OpenedAsset
          model={model}
          project={project}
          asset={previewAsset}
          onShare={(asset) => {
            // The share window opens over the canvas, where the card's line follows the share.
            setPreviewAsset(null);
            setSharing([asset]);
          }}
          onNotice={onNotice}
        />
      ) : null}
      {sharing ? (
        <ShareDialog
          project={project}
          assets={sharing}
          companions={model.companions}
          onDismiss={() => setSharing(null)}
        />
      ) : null}
    </div>
  );
}
