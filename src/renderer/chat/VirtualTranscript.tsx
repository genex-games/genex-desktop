import { appendedEntryIds } from "./transcript-motion.ts";
import {
  anchorShift,
  heightEstimate,
  INITIAL_VIEWPORT,
  mountedRange,
  type RowRange,
  type RowSize,
  retainedViewport,
  rowOffsets,
  type TranscriptLayout,
} from "./transcript-window.ts";
import {
  type AnimationEvent,
  type CSSProperties,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { OPEN_MS } from "../ui/motion.ts";

/** How much longer than its opening a row may take before it counts as open anyway (it never ran). */
const OPEN_SLACK_MS = 200;
/** The row opening's own animation (theme.css), whose end means the row is open. */
const ROW_OPENING = "chat-row-open";

/**
 * Variable-height window. Rich replies mount a few screens around the viewport and stay a little
 * longer as the reader scrolls away (`mountedRange`); `sizeOf` lets rows not yet measured be
 * guessed from those that were. Rows re-render only when their item or `renderItem` changes.
 * `entrance` says how a row that mounts arrives: how far into its opening it starts (0 for a new
 * row, more for one taking over a placeholder mid-opening), or null when it is simply there.
 * `appended` says it arrived after the rows before it (history and earlier pages never are).
 * While `still` (the chat is loading) nothing has been seen, so what is there once it loads is
 * history too. While `hold` (the chat's width is changing) the scroller keeps the reader's line
 * itself, so the rows leave the scroll alone.
 */
export function VirtualTranscript<T extends { id: string }>({
  items,
  scroller,
  follow,
  hold,
  renderItem,
  sizeOf,
  entrance,
  still = false,
}: {
  items: T[];
  scroller: RefObject<HTMLDivElement | null>;
  follow: RefObject<boolean>;
  hold?: RefObject<boolean>;
  renderItem: (item: T) => ReactNode;
  /** What an unmeasured row's height is guessed from (stable: a module-level function). */
  sizeOf?: (item: T) => RowSize;
  entrance?: (item: T, appended: boolean) => number | null;
  still?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const previousIds = useRef<string[] | null>(null);
  const ids = items.map((item) => item.id);
  const entering = appendedEntryIds(previousIds.current, ids);
  useLayoutEffect(() => {
    previousIds.current = still ? null : ids;
  });
  const { offsets, onMeasure } = useRowHeights(items, sizeOf);
  const renderedOf = useRowElements(renderItem);
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const oldPositions = useRef<TranscriptLayout | null>(null);
  const viewportRef = useRef(viewport);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const mounted = useRef<RowRange | undefined>(undefined);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = host.current
        ? host.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
        : 0;
      const next = { top: Math.max(0, element.scrollTop - top), height: element.clientHeight };
      viewportRef.current = next;
      const rows = mounted.current;
      setViewport((previous) => (rows ? retainedViewport(offsetsRef.current, previous, next, rows) : next));
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scroll);
    observer.observe(element);
    element.addEventListener("scroll", scroll, { passive: true });
    measure();
    return () => {
      element.removeEventListener("scroll", scroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);
  useLayoutEffect(() => {
    // Following the bottom, or holding the reader's line, keeps its own place; otherwise the row
    // that was on top stays there.
    const previous = follow.current || hold?.current ? null : oldPositions.current;
    const element = scroller.current;
    const layout = { ids: items.map((item) => item.id), offsets };
    if (previous && element) {
      const delta = anchorShift(previous, layout, viewportRef.current.top);
      if (delta) element.scrollTop += delta;
    }
    oldPositions.current = layout;
  }, [offsets]);
  useHostAnchor(host, scroller, follow, hold);
  const enterFrom = (item: T): number | null => {
    const appended = entering.has(item.id);
    if (entrance) return entrance(item, appended);
    return appended ? 0 : null;
  };
  const range = mountedRange(offsets, viewport, mounted.current);
  useLayoutEffect(() => {
    mounted.current = range;
  });
  const { start, end } = range;
  return (
    <div
      ref={host}
      data-chat-transcript
      data-total-entries={items.length}
      data-mounted-entries={end - start}
      className="min-w-0"
      style={{ overflowAnchor: "none" }}
    >
      <div aria-hidden style={{ height: offsets[start] }} />
      {items.slice(start, end).map((item) => (
        <MeasuredRow key={item.id} id={item.id} enterFrom={enterFrom(item)} onMeasure={onMeasure}>
          {renderedOf(item)}
        </MeasuredRow>
      ))}
      <div aria-hidden style={{ height: (offsets.at(-1) ?? 0) - (offsets[end] ?? 0) }} />
    </div>
  );
}

/**
 * The rows' measured heights and where each row starts: a row not yet measured is guessed from
 * the measured ones (`sizeOf`, which is stable), and every new height lays the rows out again.
 */
function useRowHeights<T extends { id: string }>(items: T[], sizeOf: ((item: T) => RowSize) | undefined) {
  const heights = useRef(new Map<string, number>());
  const [revision, resize] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a measured height (`revision`) moves the rows; `sizeOf` is stable
  const offsets = useMemo(
    () => rowOffsets(items, heights.current, sizeOf && heightEstimate(items, heights.current, sizeOf)),
    [items, revision],
  );
  const onMeasure = useCallback((id: string, height: number) => {
    if (Math.abs((heights.current.get(id) ?? 0) - height) < 1) return;
    heights.current.set(id, height);
    resize((value) => value + 1);
  }, []);
  return { offsets, onMeasure };
}

/** One element per item while `renderItem` holds, so a row whose item is unchanged skips its render. */
function useRowElements<T extends { id: string }>(renderItem: (item: T) => ReactNode): (item: T) => ReactNode {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new renderItem draws every row anew
  const rendered = useMemo(() => new WeakMap<T, ReactNode>(), [renderItem]);
  return (item) => {
    const known = rendered.get(item);
    if (known !== undefined) return known;
    const node = renderItem(item);
    rendered.set(item, node);
    return node;
  };
}

/**
 * Keeps the rows in place when something above the transcript appears or goes, such as Studio's
 * intro once the chat's first page has loaded: the scroll moves with the transcript's top.
 */
function useHostAnchor(
  host: RefObject<HTMLDivElement | null>,
  scroller: RefObject<HTMLDivElement | null>,
  follow: RefObject<boolean>,
  hold: RefObject<boolean> | undefined,
): void {
  const hostTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !host.current) return;
    const top = host.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const moved = hostTop.current === null ? 0 : top - hostTop.current;
    hostTop.current = top;
    if (moved && !follow.current && !hold?.current) element.scrollTop += moved;
  });
}

/** Props of one measured row. */
interface MeasuredRowProps {
  id: string;
  /** How far into its opening the row starts (ms), or null when it is simply there. Read once, at mount. */
  enterFrom: number | null;
  onMeasure: (id: string, height: number) => void;
  children: ReactNode;
}

/**
 * One row, measured for the window. A row that arrives opens in place (theme.css
 * `.chat-entry-arriving`); while it opens its height is the opening's, so it is measured once open.
 * It renders again only for new content: `enterFrom` counts at mount alone.
 */
const MeasuredRow = memo(
  MeasuredRowContent,
  (before: MeasuredRowProps, after: MeasuredRowProps) =>
    before.id === after.id && before.children === after.children && before.onMeasure === after.onMeasure,
);

function MeasuredRowContent({ id, onMeasure, children, enterFrom }: MeasuredRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Fixed at mount: changing a running opening's delay would jump it.
  const [entered] = useState(enterFrom);
  const [arriving, setArriving] = useState(() => enterFrom !== null && !prefersReducedMotion());
  const opening = useRef(arriving);
  opening.current = arriving;
  const measure = useRef((height: number) => onMeasure(id, height));
  measure.current = (height: number) => onMeasure(id, height);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const report = () => {
      if (!opening.current) measure.current(element.getBoundingClientRect().height);
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (arriving) {
      const timer = setTimeout(() => setArriving(false), OPEN_MS + OPEN_SLACK_MS);
      return () => clearTimeout(timer);
    }
    // Open now: a row that opened is measured once, at its own height.
    if (entered !== null && ref.current) measure.current(ref.current.getBoundingClientRect().height);
  }, [arriving, entered]);
  return (
    <div
      ref={ref}
      data-chat-entry={id}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && event.animationName === ROW_OPENING) setArriving(false);
      }}
      className={`flow-root min-w-0 pb-4 ${arriving ? "chat-entry-arriving" : ""}`}
      style={arriving && entered ? ({ "--entered": `${entered}ms` } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
