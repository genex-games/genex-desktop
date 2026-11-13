/**
 * The stage's Design tab: the game's design as artboards on one canvas, beside Live and Builds. An
 * artboard is a file of the game's `docs/design/`: a page its agent wrote, drawn in its own closed
 * frame at the size it asks for, a picture, large, or a 3D model that turns once pressed; a folder
 * of the board is a section, named above its artboards. The person zooms and pans the canvas as
 * they do Builds and Assets, moves any artboard, and a picture dropped on it stays where it was
 * dropped (kept in `from-you`). A page runs nothing of its own and carries no buttons: what the
 * person has to say goes on the canvas, as notes and picks that Tell Genex sends to the chat.
 */
import {
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DESIGN_DROPS,
  type DesignBoard,
  type DesignFrameSignal,
  type DesignItem,
  DesignItemKind,
  designItemKind,
  designSection,
  DesignSignal,
  type DesignSpot,
  DesignTheme,
  themedPageUrl,
} from "../../../shared/design-board.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { t } from "../../../shared/i18n.ts";
import {
  type CanvasBounds,
  gridTransform,
  keepView,
  keptView,
  PINCH_ZOOM_RATE,
  useCanvasView,
  useOnWheel,
  WHEEL_ZOOM_RATE,
  zoomAt,
} from "../../canvas-view.ts";
import { chatPrompt, composeInChat } from "../../compose-in-chat.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { addWireScene, WireKind } from "../../ui/wire-art.ts";
import { DESIGN_STILL, designScene } from "../../ui/wire-design.ts";
import { DESIGN_WORDS } from "../../words.ts";
import { DESIGN_FOCUS_EVENT, takeAskedPage } from "./design-asks.ts";
import { refreshBoard } from "./design-boards.ts";
import { type FrameMap, PageFrames, useFrameSignals } from "./design-frames.tsx";
import type { DesignMarks, DesignPick, DesignPlace } from "../../../shared/design-marks.ts";
import { canvasPoint, dropPlace, hasPlaces, placed, tidied, withPick } from "./board-marks.ts";
import { AgentPointer, MakingSheet, useMaking } from "./BoardAgent.tsx";
import { BoardNotes, type NoteDraft } from "./BoardNotes.tsx";
import { BoardPick } from "./BoardPick.tsx";
import { BoardChrome, BoardTool } from "./BoardTools.tsx";
import {
  CAPTION_HEIGHT,
  changedFiles,
  displayName,
  heldAfter,
  heldFrames,
  MODEL_SIZE,
  pageCaption,
  type PageSize,
  pictureSize,
  placedLayout,
  withGhosts,
  sizeAfter,
  turnedModels,
  type WallFrame,
} from "./design-model.ts";
import { ASK_FOR_DESIGN_PROMPT } from "./design-prompts.ts";
import { type ArtboardDrag, type ArtboardDragger, useArtboardDrag } from "./use-artboard-drag.ts";
import { type MarksChange, useBoardMarks } from "./use-board-marks.ts";

/** The canvas's dotted grid, as Builds' and Assets' canvases draw theirs. */
const GRID_PX = 22;
/** One press of a zoom button. */
const ZOOM_STEP = 1.2;
/** How long an artboard that was just added or changed carries Genex's mark. */
const FRESH_MS = 4 * SECOND_MS;
/** What a dragged thing must hold to be dropped on the canvas, and the kind of file kept. */
const DRAGGED_FILES = "Files";
const PICTURE_TYPE = "image/";

/** What a page told the tab about itself: its title, and the size it needs. */
interface PageTold {
  title: string;
  size: PageSize;
}

/** What each address a frame loaded told the tab: a changed page has a new address, so it starts again. */
type Told = Readonly<Record<string, PageTold>>;

/** An artboard on the canvas: the address it shows, and, for a page that changed, the one loading behind it. */
interface HungItem {
  item: DesignItem;
  shown: string;
  next: string | null;
}

/** One game's canvas, as its kept camera is named. */
const wallViewKey = (project: string): string => `design\n${project}`;

/** Leave words in the game's chat, with the cursor after them, for the person to finish and send. */
function leaveInChat(project: string, text: string): void {
  composeInChat({ project, text });
  requestAnimationFrame(() => chatPrompt()?.focus());
}

/** Keep the pictures among dropped files in the game's board, then read the board again: the files kept. */
async function keepDropped(project: string, files: readonly File[]): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    if (!file.type.startsWith(PICTURE_TYPE)) continue;
    const data = new Uint8Array(await file.arrayBuffer());
    const saved = await window.studio.dropOnDesign(project, file.name, data).catch(() => null);
    if (saved) kept.push(saved);
  }
  await refreshBoard(project, true);
  return kept;
}

/** What a canvas on show does with dropped files: it hangs them where they were let go, in the window. */
type DropOnWall = (files: readonly File[], client: { x: number; y: number }) => void;

/**
 * Dropping pictures on the tab: `over` while files are dragged across it, and `dragging` while
 * files are dragged anywhere in the window, when the pages let the pointer through (a frame would
 * keep the drop for itself).
 */
function useDrop(project: string, onWall: RefObject<DropOnWall | null>) {
  const [over, setOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const begin = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(DRAGGED_FILES)) setDragging(true);
    };
    const end = (event: DragEvent): void => {
      if (event.type === "drop" || !event.relatedTarget) setDragging(false);
    };
    window.addEventListener("dragenter", begin);
    window.addEventListener("dragleave", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragenter", begin);
      window.removeEventListener("dragleave", end);
      window.removeEventListener("drop", end);
    };
  }, []);
  const holdsFiles = (event: ReactDragEvent): boolean => event.dataTransfer.types.includes(DRAGGED_FILES);
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!holdsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!holdsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const files = [...event.dataTransfer.files];
    if (onWall.current) onWall.current(files, { x: event.clientX, y: event.clientY });
    else void keepDropped(project, files);
  };
  return { over, dragging, handlers: { onDragOver, onDragLeave, onDrop } };
}

/** The Design tab: the game's artboards on one canvas, or what an empty board offers; pictures drop on either. */
export default function DesignStage({ project, board }: { project: string; board: DesignBoard }): JSX.Element {
  const dropOnWall = useRef<DropOnWall | null>(null);
  const drop = useDrop(project, dropOnWall);
  const making = useMaking(project, board.items);
  return (
    <div
      data-design-stage=""
      data-design-dragging={drop.dragging ? "" : undefined}
      className="absolute inset-0 [&[data-design-dragging]_iframe]:pointer-events-none"
      {...drop.handlers}
    >
      {board.items.length === 0 && making.length === 0 ? (
        <EmptyBoard project={project} />
      ) : (
        <Wall key={project} project={project} board={board} making={making} dropOnWall={dropOnWall} />
      )}
      {drop.over ? (
        <div
          data-design-drop=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 rounded-card shadow-[inset_0_0_0_2px_var(--accent)]"
        />
      ) : null}
    </div>
  );
}

// The empty tab's drawing arrives with the tab: the main bundle's wire art does not carry it.
addWireScene(WireKind.Design, designScene, DESIGN_STILL);

/** A game with no design yet: what the board is for, and one way to ask for one. */
function EmptyBoard({ project }: { project: string }): JSX.Element {
  return (
    <div className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8 text-center">
      <EmptyState
        data-design-empty=""
        art={WireKind.Design}
        title={DESIGN_WORDS.emptyTitle}
        subtitle={DESIGN_WORDS.emptySubtitle}
        action={
          <Button variant="outline" data-design-ask="" onClick={() => leaveInChat(project, ASK_FOR_DESIGN_PROMPT)}>
            {DESIGN_WORDS.ask}
          </Button>
        }
      />
    </div>
  );
}

/**
 * The canvas's camera: fitted to its artboards until the person moves it (a pan, the wheel, the
 * zoom buttons), so artboards that grow to what they hold stay in view; a camera the person moved
 * comes back as they left it when the tab or the game returns. `show` brings one rectangle into view.
 */
function useWallCamera(project: string, bounds: CanvasBounds | null) {
  const touched = useRef(false);
  const touch = useCallback(() => {
    touched.current = true;
  }, []);
  const canvas = useCanvasView({ initial: keptView(wallViewKey(project)) ?? { k: 1, tx: 0, ty: 0 }, onPan: touch });
  const { viewRef, fit, zoomBy, apply, viewport } = canvas;
  useOnWheel(viewport, touch);
  useLayoutEffect(() => {
    const kept = keptView(wallViewKey(project));
    touched.current = kept !== null;
    if (kept) apply(kept);
    return () => keepView(wallViewKey(project), touched.current ? viewRef.current : null);
  }, [project, apply, viewRef]);
  const fitWall = useCallback(() => {
    touched.current = false;
    fit(bounds);
    // A small board hangs at its own size; a larger one fits down.
    if (viewRef.current.k > 1) zoomBy(1 / viewRef.current.k);
  }, [bounds, fit, zoomBy, viewRef]);
  useLayoutEffect(() => {
    if (!touched.current) fitWall();
  }, [fitWall]);
  const show = useCallback(
    (rect: CanvasBounds) => {
      touch();
      fit(rect);
    },
    [touch, fit],
  );
  const zoomByHand = useCallback(
    (factor: number) => {
      touch();
      zoomBy(factor);
    },
    [touch, zoomBy],
  );
  return { ...canvas, touch, fitWall, show, zoomBy: zoomByHand };
}

type WallCamera = ReturnType<typeof useWallCamera>;

/** An artboard with its caption's room above it: what bringing it into view shows. */
const pageRect = (frame: WallFrame): CanvasBounds => ({
  x: frame.x,
  y: frame.y - CAPTION_HEIGHT,
  w: frame.width,
  h: frame.height + CAPTION_HEIGHT,
});

/** The parts of the canvas's camera a page's signals move. */
type SignalCamera = Pick<WallCamera, "touch" | "update" | "viewport" | "viewRef">;

/** A wheel over a page zooms the canvas about the point under the cursor, as a wheel over the canvas does. */
function zoomOverPage(
  camera: SignalCamera,
  frame: HTMLIFrameElement,
  wheel: Extract<DesignFrameSignal, { type: typeof DesignSignal.Wheel }>,
): void {
  const port = camera.viewport.current;
  if (!port) return;
  const sheet = frame.getBoundingClientRect();
  const box = port.getBoundingClientRect();
  const { k } = camera.viewRef.current;
  const rate = wheel.pinch ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
  const px = sheet.left - box.left + wheel.x * k;
  const py = sheet.top - box.top + wheel.y * k;
  camera.touch();
  camera.update((view) => zoomAt(view, Math.exp(-wheel.dy * rate), px, py));
}

/** What a frame told the tab, kept by its address: its title and a size that only grows while the address is the same. */
function toldAfter(
  now: Told,
  url: string,
  signal: Extract<DesignFrameSignal, { type: typeof DesignSignal.Page }>,
): Told {
  return { ...now, [url]: { title: signal.title, size: sizeAfter(now[url]?.size, signal) } };
}

/** What the canvas does with the pages' signals. */
interface SignalHandlers {
  project: string;
  camera: SignalCamera;
  onTold: (next: (now: Told) => Told) => void;
  onShowFile: (file: string) => void;
}

/** One signal of one frame, acted on. */
function actOnSignal(
  { project, camera, onTold, onShowFile }: SignalHandlers,
  url: string,
  frame: HTMLIFrameElement,
  signal: DesignFrameSignal,
): void {
  switch (signal.type) {
    case DesignSignal.Page:
      onTold((now) => toldAfter(now, url, signal));
      break;
    case DesignSignal.Open:
      onShowFile(signal.file);
      break;
    case DesignSignal.Link:
      window.open(signal.url, "_blank", "noopener");
      break;
    case DesignSignal.Wheel:
      zoomOverPage(camera, frame, signal);
      break;
    case DesignSignal.Drag:
      camera.touch();
      camera.update((view) => ({ ...view, tx: view.tx + signal.dx, ty: view.ty + signal.dy }));
      break;
  }
}

/**
 * What the pages' frames tell the tab, acted on: a page's title and size, the words of a pressed
 * button, a link, and the wheel and drags a frame takes from the canvas. Only a message from one
 * of this canvas's own frames is read, and only as a signal (`useFrameSignals`); a sheet still
 * loading behind the one on show says only what it holds.
 */
function usePageSignals(hung: readonly HungItem[], frames: FrameMap, handlers: SignalHandlers): void {
  useFrameSignals(frames, (url, frame, signal) => {
    const sheet = hung.find((one) => one.shown === url || one.next === url);
    if (!sheet) return;
    if (sheet.shown !== url && signal.type !== DesignSignal.Page) return;
    actOnSignal(handlers, url, frame, signal);
  });
}

/** The app's look, light or dark, as it changes: a page is drawn in the same. */
function useAppTheme(): DesignTheme {
  const read = (): DesignTheme =>
    document.documentElement.style.colorScheme === DesignTheme.Light ? DesignTheme.Light : DesignTheme.Dark;
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * The canvas's artboards: for each the address on show, and what each page's address told the tab.
 * A page that changed keeps its sheet up until the changed one has loaded behind it (`settle`); a
 * picture or a model shows its address at once. What an address no frame loads any more told is
 * forgotten.
 */
function useHungItems(items: readonly DesignItem[]) {
  const pages = useMemo(() => items.filter((item) => item.kind === DesignItemKind.Page), [items]);
  const [held, setHeld] = useState(() => heldAfter({}, pages));
  const [told, setTold] = useState<Told>({});
  useEffect(() => {
    setHeld((now) => heldAfter(now, pages));
  }, [pages]);
  const hung = useMemo<HungItem[]>(
    () =>
      items.map((item) =>
        item.kind === DesignItemKind.Page
          ? { item, ...heldFrames(held[item.file], item.url) }
          : { item, shown: item.url, next: null },
      ),
    [items, held],
  );
  useEffect(() => {
    const framed = new Set(hung.flatMap((sheet) => (sheet.next ? [sheet.shown, sheet.next] : [sheet.shown])));
    setTold((now) => {
      const kept = Object.entries(now).filter(([url]) => framed.has(url));
      return kept.length === Object.keys(now).length ? now : Object.fromEntries(kept);
    });
  }, [hung]);
  const settle = useCallback((file: string, url: string) => {
    setHeld((now) => ({ ...now, [file]: url }));
  }, []);
  return { hung, told, setTold, settle };
}

/** The artboards added or changed in the last few seconds: each carries Genex's mark while it is one. */
function useFresh(items: readonly DesignItem[]): ReadonlySet<string> {
  const before = useRef<Map<string, string> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const changed = changedFiles(before.current, items);
    before.current = new Map(items.map((item) => [item.file, item.url]));
    if (changed.length === 0) return;
    setFresh((now) => new Set([...now, ...changed]));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFresh((now) => new Set([...now].filter((file) => !changed.includes(file))));
    }, FRESH_MS);
    timers.current.add(timer);
  }, [items]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  return fresh;
}

/** Where the agent points: the artboard, the spot on it and its few words. */
interface AgentPoint {
  file: string;
  spot: DesignSpot;
  note: string;
}

/**
 * Bring the artboard that was asked for into view (a link in the chat, the agent's `show_design`)
 * once the board holds it. Where the agent pointed on it stays until `forget` (the person's next
 * press on the canvas) or the next artboard asked for.
 */
function useAskedPage(
  project: string,
  frames: readonly WallFrame[],
  show: (rect: CanvasBounds) => void,
): { pointer: AgentPoint | null; forget: () => void } {
  const [pointer, setPointer] = useState<AgentPoint | null>(null);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    const again = (): void => setAsks((count) => count + 1);
    window.addEventListener(DESIGN_FOCUS_EVENT, again);
    return () => window.removeEventListener(DESIGN_FOCUS_EVENT, again);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asks` runs it again for an artboard asked for while the tab is open
  useEffect(() => {
    const asked = takeAskedPage(
      project,
      frames.map((frame) => frame.file),
    );
    const frame = asked ? frames.find((hung) => hung.file === asked.file) : undefined;
    if (!asked || !frame) return;
    show(pageRect(frame));
    setPointer(asked.spot ? { file: asked.file, spot: asked.spot, note: asked.note ?? "" } : null);
  }, [project, frames, show, asks]);
  const forget = useCallback(() => setPointer(null), []);
  return { pointer, forget };
}

/** A file's name as its caption reads before anything is known of it: `world/02-the-fires.png` is "The fires". */
const captionOfFile = (file: string): string => displayName((file.split("/").pop() ?? file).replace(/\.[^.]+$/, ""));

/** An artboard being made as the canvas lays it out: in its section, at the size its kind hangs at before it loads. */
function ghostSheet(file: string): PageSize & { file: string; section: string } {
  const section = designSection(file);
  const laid = { file, section: section === DESIGN_DROPS ? "" : section };
  const kind = designItemKind(file);
  if (kind === DesignItemKind.Picture) return { ...laid, ...pictureSize(undefined) };
  return { ...laid, ...(kind === DesignItemKind.Model ? MODEL_SIZE : sizeAfter(undefined, null)) };
}

/** The section an artboard is laid out in: its folder's, and none for a picture the person dropped. */
const layoutSection = (item: DesignItem): string => (item.section === DESIGN_DROPS ? "" : item.section);

/**
 * Dropped files on a canvas on show: each picture is kept in the board, then hung where it was let
 * go. The handler is the canvas's own while it shows, so a drop on an empty board is simply kept.
 */
function useDropOnWall(
  dropOnWall: RefObject<DropOnWall | null>,
  project: string,
  camera: WallCamera,
  change: (update: MarksChange) => void,
): void {
  const { viewport, viewRef } = camera;
  useEffect(() => {
    dropOnWall.current = (files, client) => {
      const corner = viewport.current?.getBoundingClientRect();
      const point = corner ? canvasPoint(viewRef.current, corner, client) : null;
      void keepDropped(project, files).then((kept) => {
        if (point) change((now) => kept.reduce((all, file, index) => placed(all, file, dropPlace(point, index)), now));
      });
    };
    return () => {
      dropOnWall.current = null;
    };
  }, [dropOnWall, project, viewport, viewRef, change]);
}

/**
 * The board's artboards as the canvas hangs them: pages in the app's look, each at its size, the
 * ones the person moved where they put them and the others laid out section under section, with
 * the artboards the agent said it is making (`making`) each at the end of its section.
 */
function useWallSheets(board: DesignBoard, places: DesignMarks["places"], making: readonly string[]) {
  const theme = useAppTheme();
  const items = useMemo(
    () =>
      board.items.map((item) =>
        item.kind === DesignItemKind.Page ? { ...item, url: themedPageUrl(item.url, theme) } : item,
      ),
    [board.items, theme],
  );
  const { hung, told, setTold, settle } = useHungItems(items);
  const [natural, setNatural] = useState<Readonly<Record<string, PageSize>>>({});
  const pageSize = useCallback((url: string): PageSize => sizeAfter(told[url]?.size, null), [told]);
  const layout = useMemo(
    () =>
      placedLayout(
        withGhosts(
          hung.map(({ item, shown }) => {
            const laid = { ...item, section: layoutSection(item) };
            if (item.kind === DesignItemKind.Picture) return { ...laid, ...pictureSize(natural[item.url]) };
            return { ...laid, ...(item.kind === DesignItemKind.Model ? MODEL_SIZE : pageSize(shown)) };
          }),
          making.map(ghostSheet),
        ),
        places,
      ),
    [hung, natural, pageSize, places, making],
  );
  /** An artboard's caption as the person reads it. */
  const captionOf = (file: string): string => {
    const sheet = hung.find((one) => one.item.file === file);
    return sheet ? pageCaption(sheet.item, told[sheet.shown]?.title) : captionOfFile(file);
  };
  return { hung, told, setTold, settle, setNatural, pageSize, layout, captionOf, making };
}

type WallSheets = ReturnType<typeof useWallSheets>;

/**
 * The person's hand on the canvas: the tool it holds, a note being written, where a point of the
 * window is on the canvas, and pictures chosen from the computer, which hang at the canvas's middle.
 */
function useBoardHand(camera: WallCamera, dropOnWall: RefObject<DropOnWall | null>) {
  const [tool, setTool] = useState<BoardTool>(BoardTool.Move);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const { viewport, viewRef } = camera;
  const pointOf = useCallback(
    (client: { x: number; y: number }): DesignPlace | null => {
      const corner = viewport.current?.getBoundingClientRect();
      return corner ? canvasPoint(viewRef.current, corner, client) : null;
    },
    [viewport, viewRef],
  );
  const addPictures = useCallback(
    (files: readonly File[]): void => {
      const box = viewport.current?.getBoundingClientRect();
      if (box) dropOnWall.current?.(files, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    },
    [viewport, dropOnWall],
  );
  return { tool, setTool, draft, setDraft, pointOf, addPictures };
}

/** Where every artboard hangs this moment, the one being dragged included: notes follow theirs. */
const hangsNow = (frames: readonly WallFrame[], moving: ArtboardDrag | null): readonly WallFrame[] =>
  moving
    ? frames.map((frame) => (frame.file === moving.file ? { ...frame, x: moving.x, y: moving.y } : frame))
    : frames;

/** Every artboard of the canvas, each where it hangs. */
function WallItems({
  project,
  board,
  sheets,
  marks,
  change,
  zoom,
  dragger,
  frames,
  onShow,
}: {
  project: string;
  board: DesignBoard;
  sheets: WallSheets;
  marks: DesignMarks;
  change: (update: MarksChange) => void;
  zoom: number;
  dragger: ArtboardDragger;
  frames: FrameMap;
  /** Bring one artboard into view. */
  onShow: (frame: WallFrame) => void;
}): JSX.Element {
  const { hung, told, layout, pageSize, settle, setNatural } = sheets;
  const fresh = useFresh(board.items);
  /** The name of the section an artboard starts, as the person reads it; null for one that starts none. */
  const sectionAt = (file: string): string | null => {
    const label = layout.labels.find((one) => one.file === file);
    return label ? displayName(label.section) : null;
  };
  const turned = useMemo(() => turnedModels(board.items), [board.items]);
  return (
    <>
      {layout.frames.map((frame) => {
        const sheet = hung.find((one) => one.item.file === frame.file);
        if (!sheet)
          return (
            <MakingSheet
              key={frame.file}
              frame={frame}
              caption={sheets.captionOf(frame.file)}
              section={sectionAt(frame.file)}
              zoom={zoom}
              drawing={sheets.making[0] === frame.file}
            />
          );
        return (
          <WallItem
            key={frame.file}
            project={project}
            sheet={sheet}
            frame={frame}
            caption={pageCaption(sheet.item, told[sheet.shown]?.title)}
            section={sectionAt(frame.file)}
            zoom={zoom}
            drag={dragger.drag?.file === frame.file ? dragger.drag : null}
            onGrab={(event) => dragger.begin(frame, event)}
            takeMoved={dragger.takeMoved}
            pick={marks.picks[frame.file]?.pick ?? null}
            offered={marks.choices.includes(frame.file)}
            onPick={(pick) => change((now) => withPick(now, frame.file, pick))}
            fresh={fresh.has(frame.file) && sheet.item.section !== DESIGN_DROPS}
            turnsItself={turned.has(frame.file)}
            frames={frames}
            pageSize={pageSize}
            onLoaded={(url) => settle(sheet.item.file, url)}
            onNatural={(size) => setNatural((now) => ({ ...now, [sheet.item.url]: size }))}
            onShow={() => onShow(frame)}
          />
        );
      })}
    </>
  );
}

/**
 * The canvas: every artboard of the board under the camera, the person's notes on them, the tools
 * and the zoom control. An artboard the person moved hangs where they put it; the others are laid
 * out section under section.
 */
function Wall({
  project,
  board,
  making,
  dropOnWall,
}: {
  project: string;
  board: DesignBoard;
  /** The artboards the agent said it is making and the board does not hold yet. */
  making: readonly string[];
  dropOnWall: RefObject<DropOnWall | null>;
}): JSX.Element {
  const { marks, change } = useBoardMarks(project);
  const sheets = useWallSheets(board, marks.places, making);
  const { hung, layout } = sheets;
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const camera = useWallCamera(project, layout.bounds);
  const { show } = camera;
  const dragger = useArtboardDrag({
    zoom: camera.view.k,
    onStart: camera.touch,
    onPlace: (file, place) => change((now) => placed(now, file, place)),
  });
  useDropOnWall(dropOnWall, project, camera, change);
  const hand = useBoardHand(camera, dropOnWall);
  const showFile = (file: string): void => {
    const frame = layout.frames.find((placed) => placed.file === file);
    if (frame) show(pageRect(frame));
  };
  usePageSignals(hung, frames, { project, camera, onTold: sheets.setTold, onShowFile: showFile });
  const { pointer, forget } = useAskedPage(project, layout.frames, show);
  const zoom = camera.view.k;
  const hangs = hangsNow(layout.frames, dragger.drag);
  const pointed = pointer ? hangs.find((frame) => frame.file === pointer.file) : undefined;
  return (
    <div className="absolute inset-0 overflow-hidden bg-canvas select-none" onPointerDownCapture={forget}>
      <WallCanvas camera={camera} bounds={layout.bounds}>
        <WallItems
          project={project}
          board={board}
          sheets={sheets}
          marks={marks}
          change={change}
          zoom={zoom}
          dragger={dragger}
          frames={frames}
          onShow={(frame) => show(pageRect(frame))}
        />
        <BoardNotes
          marks={marks}
          frames={hangs}
          zoom={zoom}
          draft={hand.draft}
          change={change}
          onDraft={hand.setDraft}
        />
        {pointer && pointed ? (
          <AgentPointer frame={pointed} spot={pointer.spot} note={pointer.note} zoom={zoom} />
        ) : null}
      </WallCanvas>
      <BoardChrome
        project={project}
        marks={marks}
        frames={hangs}
        tool={hand.tool}
        captionOf={sheets.captionOf}
        pointOf={hand.pointOf}
        change={change}
        onTool={hand.setTool}
        onDraft={hand.setDraft}
        onPictures={hand.addPictures}
      />
      <WallZoom
        percent={Math.round(zoom * 100)}
        onZoom={camera.zoomBy}
        onFit={camera.fitWall}
        onTidy={hasPlaces(marks) ? () => change(tidied) : null}
      />
    </div>
  );
}

/** The canvas under its camera: the dotted grid and the layer the artboards hang on. A drag of the bare canvas pans it. */
function WallCanvas({
  camera,
  bounds,
  children,
}: {
  camera: WallCamera;
  bounds: CanvasBounds | null;
  children: ReactNode;
}): JSX.Element {
  const { view, viewport, layer, grid, onBackgroundDown } = camera;
  // A frame keeps the pointer for itself: while the bare canvas is dragged, the pages let it pass.
  const onDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    onBackgroundDown(event);
    const pages = layer.current;
    if (!pages || event.target !== event.currentTarget) return;
    pages.style.pointerEvents = "none";
    const release = (): void => {
      pages.style.pointerEvents = "";
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  };
  return (
    <div ref={viewport} className="absolute inset-0 cursor-grab" onPointerDown={onDown}>
      <div
        ref={grid}
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
        ref={layer}
        className="absolute top-0 left-0"
        style={{
          width: bounds?.w ?? 0,
          height: bounds?.h ?? 0,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
          transformOrigin: "0 0",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Genex's mark on an artboard that was just added or changed: its ring, and the cursor that drew it. */
function FreshMark({ zoom }: { zoom: number }): JSX.Element {
  return (
    <span
      data-design-fresh=""
      aria-hidden="true"
      className="pointer-events-none absolute top-full left-full z-10 flex items-start gap-0.5"
      style={{ transform: `translate(-28px, -28px) scale(${1 / zoom})`, transformOrigin: "left top" }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" className="shrink-0 text-accent">
        <path d="M4 3l15 8-7 2-3 7z" fill="currentColor" />
      </svg>
      <span className="mt-3 rounded-[9px] bg-accent-fill px-2 py-0.5 text-[12px] text-white leading-4">Genex</span>
    </span>
  );
}

/** Where a model's load stands: on its way, turning on the canvas, or refused (a file the viewer cannot read). */
const ModelLoad = { Loading: "loading", Shown: "shown", Failed: "failed" } as const;
type ModelLoad = (typeof ModelLoad)[keyof typeof ModelLoad];

/**
 * A 3D model on the canvas: the model itself, turned by hand. The board's first few load by
 * themselves (`turnsItself`); one past that, or one whose load failed, is a tile to press. A changed
 * file is a new tile (its key is the file's address), so it loads again.
 */
function ModelTile({
  project,
  item,
  size,
  turnsItself,
}: {
  project: string;
  item: DesignItem;
  size: PageSize;
  turnsItself: boolean;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState(false);
  const [load, setLoad] = useState<ModelLoad>(ModelLoad.Loading);
  const turning = (turnsItself || pressed) && load !== ModelLoad.Failed;
  useEffect(() => {
    const where = host.current;
    if (!turning || !where) return;
    let cancelled = false;
    let viewer: { dispose: () => void } | null = null;
    const settle = (to: ModelLoad) => (): void => {
      if (!cancelled) setLoad(to);
    };
    void import("../../asset-model-viewer.js")
      .then(({ createAssetViewer }) => {
        if (cancelled) return;
        viewer = createAssetViewer(where, {
          file: item.file,
          read: (file: string) => window.studio.previewProjectAsset({ project, file }),
          companions: [],
          motions: [],
          onReady: settle(ModelLoad.Shown),
          onError: settle(ModelLoad.Failed),
          onTime: () => {},
        });
      })
      .catch(settle(ModelLoad.Failed));
    return () => {
      cancelled = true;
      viewer?.dispose();
    };
  }, [turning, project, item.file]);
  return (
    <div
      data-design-model-load={turning ? load : undefined}
      className="relative overflow-hidden rounded-[12px] bg-surface shadow-card"
      style={size}
    >
      <div ref={host} className="absolute inset-0" onPointerDown={(event) => event.stopPropagation()} />
      {turning && load === ModelLoad.Loading ? (
        <div data-design-model-loading="" aria-hidden="true" className="asset-skeleton absolute inset-0" />
      ) : null}
      {turning ? null : (
        <button
          type="button"
          data-design-model={item.file}
          aria-label={DESIGN_WORDS.turnModel}
          title={DESIGN_WORDS.turnModel}
          className="absolute inset-0 grid cursor-pointer place-items-center text-ink-3 hover:text-ink"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setLoad(ModelLoad.Loading);
            setPressed(true);
          }}
        >
          <svg
            width="160"
            height="160"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.75"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9" />
          </svg>
        </button>
      )}
      <span className="pointer-events-none absolute top-5 left-5 rounded-[14px] bg-inset px-4 py-1.5 font-mono text-[26px] text-ink-2 leading-8">
        3D
      </span>
    </div>
  );
}

/**
 * One artboard on the canvas: its caption (a press brings it into view) above it, then the page in
 * its closed frame, the picture, or the model. The caption keeps its size on screen whatever the
 * canvas's zoom, so a far canvas still reads; an artboard that just changed carries Genex's mark.
 * A drag of the caption, or of a picture itself, moves the artboard (`use-artboard-drag.ts`).
 */
function WallItem({
  project,
  sheet,
  frame,
  caption,
  section,
  zoom,
  drag,
  onGrab,
  takeMoved,
  pick,
  offered,
  onPick,
  fresh,
  turnsItself,
  frames,
  pageSize,
  onLoaded,
  onNatural,
  onShow,
}: {
  project: string;
  sheet: HungItem;
  frame: WallFrame;
  caption: string;
  /** Its section's name, on the section's first artboard: it stands above the caption. */
  section: string | null;
  /** The canvas's zoom: the caption is drawn against it. */
  zoom: number;
  /** Where the person is dragging it to, while they are. */
  drag: ArtboardDrag | null;
  /** A press on what moves it. */
  onGrab: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Whether the press that just ended moved it. */
  takeMoved: () => boolean;
  /** What the person said of it, if anything; whether the agent offers it to pick among; and picking. */
  pick: DesignPick | null;
  offered: boolean;
  onPick: (pick: DesignPick) => void;
  fresh: boolean;
  /** A model that loads without a press (`turnedModels`). */
  turnsItself: boolean;
  frames: FrameMap;
  /** The size a page's frame of this address hangs at. */
  pageSize: (url: string) => PageSize;
  /** A changed page has loaded behind its sheet. */
  onLoaded: (url: string) => void;
  /** A picture has loaded: its own size. */
  onNatural: (size: PageSize) => void;
  onShow: () => void;
}): JSX.Element {
  const { item } = sheet;
  const size = { width: frame.width, height: frame.height };
  const at = drag ?? frame;
  return (
    <div
      data-design-page={item.file}
      data-design-kind={item.kind}
      data-design-loading={sheet.next ? "" : undefined}
      data-design-dragged={drag ? "" : undefined}
      data-analytics-mask=""
      className={`group/board absolute ${drag ? "z-10" : ""}`}
      style={{ left: at.x, top: at.y - CAPTION_HEIGHT, width: frame.width }}
    >
      <div className="flex items-end" style={{ height: CAPTION_HEIGHT }}>
        <div
          className="flex flex-col items-start"
          style={{ maxWidth: frame.width * zoom, transform: `scale(${1 / zoom})`, transformOrigin: "left bottom" }}
        >
          {section ? (
            <span
              data-design-section={item.section}
              className="whitespace-nowrap pb-1.5 font-medium text-[15px] text-ink leading-[22px]"
            >
              {section}
            </span>
          ) : null}
          <button
            type="button"
            className="block max-w-full cursor-grab truncate pb-1.5 text-left text-ink-3 text-sm hover:text-ink"
            title={caption}
            onPointerDown={onGrab}
            onClick={() => {
              if (!takeMoved()) onShow();
            }}
          >
            {caption}
          </button>
        </div>
      </div>
      <div
        className={`group/sheet relative rounded-[12px] ${fresh ? "shadow-[0_0_0_3px_var(--accent)]" : ""} ${drag ? "shadow-pop" : ""}`}
        style={size}
      >
        {item.kind === DesignItemKind.Page ? (
          <PageFrames
            shown={sheet.shown}
            next={sheet.next}
            title={caption}
            frames={frames}
            onLoaded={onLoaded}
            styleOf={pageSize}
            className="rounded-[12px] shadow-card"
          />
        ) : null}
        {item.kind === DesignItemKind.Picture ? (
          <img
            src={item.url}
            alt={caption}
            draggable={false}
            className={`block rounded-[12px] bg-inset object-cover ${drag ? "cursor-grabbing" : "cursor-grab"}`}
            style={size}
            onPointerDown={onGrab}
            onLoad={(event) =>
              onNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
          />
        ) : null}
        {item.kind === DesignItemKind.Model ? (
          <ModelTile key={item.url} project={project} item={item} size={size} turnsItself={turnsItself} />
        ) : null}
        {offered || pick ? <BoardPick pick={pick} zoom={zoom} onPick={onPick} /> : null}
        {fresh ? <FreshMark zoom={zoom} /> : null}
      </div>
    </div>
  );
}

/**
 * The canvas's zoom control, as Assets has: out, the zoom, in, and fit everything; and, once the
 * person has moved an artboard, Tidy up, which puts every artboard back where the layout hangs it.
 */
function WallZoom({
  percent,
  onZoom,
  onFit,
  onTidy,
}: {
  percent: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  onTidy: (() => void) | null;
}): JSX.Element {
  return (
    <div className="absolute bottom-2.5 left-2.5 flex h-7 items-center gap-0.5 rounded-control bg-surface px-1 shadow-btn">
      <Button
        variant="ghost"
        aria-label={t("Zoom out")}
        title={t("Zoom out")}
        className="!h-6 !px-2"
        onClick={() => onZoom(1 / ZOOM_STEP)}
      >
        −
      </Button>
      <span className="w-10 text-center font-mono text-micro text-ink-3 tabular-nums">
        {t("{percent}%", { percent })}
      </span>
      <Button
        variant="ghost"
        aria-label={t("Zoom in")}
        title={t("Zoom in")}
        className="!h-6 !px-2"
        onClick={() => onZoom(ZOOM_STEP)}
      >
        +
      </Button>
      <Button
        variant="ghost"
        data-design-fit=""
        aria-label={t("Fit everything")}
        title={t("Fit everything")}
        className="!h-6 !px-2 !text-micro"
        onClick={onFit}
      >
        {t("Fit")}
      </Button>
      {onTidy ? (
        <Button
          variant="ghost"
          data-design-tidy=""
          title={t("Put every artboard back in its row")}
          className="!h-6 !px-2 !text-micro"
          onClick={onTidy}
        >
          {t("Tidy up")}
        </Button>
      ) : null}
    </div>
  );
}
