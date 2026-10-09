/**
 * An agent's screen as the Builds graph shows it: the window's newest frame with the agent's cursor drawn where its mouse is, what it
 * is doing in plain words, and on a selected node's card the last few frames it sent, to step back
 * through. The cursor is the agent's, not yours: the picture is a window onto someone else's hands.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AgentScreenFrame } from "../../../shared/agent-screen.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { partFrameOf, trailOf } from "../../state/agent-screens.ts";
import { useAgentScreens } from "../../state/hooks.ts";
import { screenAgo, screenDoing, screenDone } from "../../words.ts";
import { Section } from "./chrome.tsx";
import { coverCursor } from "./screen-cursor.ts";
import { IMAGE_OUTLINE } from "./pictures.tsx";

/** The pointer's size on a node and on a card, in pixels of the canvas or the card. */
const CURSOR_PX = { node: 13, card: 20 } as const;
/** The trail's thumbnails, in pixels. */
const TRAIL_THUMB = { w: 76, h: 48 } as const;
/** The dark pill words sit on over a picture, and the light accent its dot takes there. */
const ON_PICTURE_PILL = "rgb(20 20 21 / 72%)";
const ON_PICTURE_ACCENT = "#a8c3f5";

/** A frame's picture as an image source, made once per picture. */
export function useFrameSrc(frame: AgentScreenFrame | null): string | null {
  const jpeg = frame?.jpeg;
  return useMemo(() => (jpeg ? `data:image/jpeg;base64,${jpeg}` : null), [jpeg]);
}

/** Now, once a second while the app is on screen: a screen's age reads in seconds. */
function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, SECOND_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A macOS-style pointer with its tip at (`left`%, `top`%) of the picture it sits on. */
function Cursor({ left, top, size }: { left: number; top: number; size: number }): JSX.Element {
  return (
    <svg
      className="pointer-events-none absolute"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: size,
        height: size,
        filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))",
      }}
      viewBox="0 0 24 24"
      fill="#111318"
      stroke="#fff"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </svg>
  );
}

/** The agent's cursor over a node's picture, which covers the node. */
export function NodeCursor({ frame, box }: { frame: AgentScreenFrame; box: { w: number; h: number } }): JSX.Element {
  const at = coverCursor(frame, box);
  return <Cursor left={at.left} top={at.top} size={CURSOR_PX.node} />;
}

/**
 * A working node's status: what its agent is doing and how long ago it last showed it
 * ("Pressing Space · 3s"). Under a state that must stay said (Being checked), the state leads.
 */
export function ScreenWords({ frame, state = null }: { frame: AgentScreenFrame; state?: string | null }): JSX.Element {
  if (state) return <>{`${state} · ${screenDoing(frame.act)}`}</>;
  return <ScreenAge frame={frame} words={screenDoing(frame.act)} />;
}

/** Words and the frame's age, ticking: only this text re-renders each second. */
function ScreenAge({
  frame,
  words,
  ago = false,
}: {
  frame: AgentScreenFrame;
  words: string;
  ago?: boolean;
}): JSX.Element {
  const now = useSecondClock();
  return <>{`${words} · ${screenAgo(frame.at, now, { ago })}`}</>;
}

/** The newest frame of the agent working on one part of a live run; null while none is. */
export function usePartFrame(project: string | null, runId: string, facetId: string, live: boolean) {
  return useAgentScreens((s) => (live ? partFrameOf(s, project, runId, facetId) : undefined)) ?? null;
}

/** The same agent's screen and its trail, for a card. */
export function usePartScreen(
  project: string | null,
  runId: string,
  facetId: string,
  live: boolean,
): { frame: AgentScreenFrame | null; trail: readonly AgentScreenFrame[] } {
  const frame = usePartFrame(project, runId, facetId, live);
  const trail = useScreenTrail(frame);
  return { frame, trail };
}

/** A window's trail, for a frame already in hand (the lead's). */
export function useScreenTrail(frame: AgentScreenFrame | null): readonly AgentScreenFrame[] {
  return useAgentScreens((s) => trailOf(s, frame?.handle ?? null));
}

/** One frame at card size with the cursor on it and a pill of words in its corner. */
function ScreenPicture({
  frame,
  label,
  pill,
  onOpen,
}: {
  frame: AgentScreenFrame;
  label: string;
  pill: ReactNode;
  onOpen: (src: string) => void;
}): JSX.Element {
  const src = useFrameSrc(frame);
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  return (
    <div
      data-agent-screen={frame.handle}
      className="relative w-full cursor-zoom-in overflow-hidden rounded-[10px] bg-inset"
      style={{ aspectRatio: `${width} / ${height}`, boxShadow: IMAGE_OUTLINE }}
      onClick={() => {
        if (src) onOpen(src);
      }}
    >
      {src ? <img src={src} alt={label} draggable={false} className="block h-full w-full object-cover" /> : null}
      <Cursor left={(frame.cursor.x / width) * 100} top={(frame.cursor.y / height) * 100} size={CURSOR_PX.card} />
      <span
        className="pointer-events-none absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-20px)] items-center gap-1.5 rounded-[8px] px-2 py-[3px] text-xs text-white"
        style={{ background: ON_PICTURE_PILL }}
      >
        {pill}
      </span>
    </div>
  );
}

/** One step of the trail: its picture and what the agent did there, or Now for the newest. */
function TrailStep({
  frame,
  now,
  shown,
  onShow,
}: {
  frame: AgentScreenFrame;
  now: boolean;
  shown: boolean;
  onShow: () => void;
}): JSX.Element {
  const src = useFrameSrc(frame);
  const words = now ? "Now" : screenDone(frame.act);
  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={words}
      onClick={onShow}
      className="flex shrink-0 cursor-pointer flex-col gap-1 rounded-[8px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{ width: TRAIL_THUMB.w }}
    >
      <span
        className="block overflow-hidden rounded-[8px] bg-inset"
        style={{
          width: TRAIL_THUMB.w,
          height: TRAIL_THUMB.h,
          boxShadow: shown ? "0 0 0 2px var(--accent)" : IMAGE_OUTLINE,
        }}
      >
        {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : null}
      </span>
      <span className={`truncate text-xs ${shown ? "text-accent" : "text-ink-2"}`}>{words}</span>
    </button>
  );
}

/**
 * A selected working node's screen: the newest frame, live, and What it did — the frames the
 * agent already sent, oldest first, the last one Now. A step shows that frame until it scrolls out
 * of the trail or Now is pressed.
 */
export function LiveScreen({
  frame,
  trail,
  label,
  onOpen,
}: {
  frame: AgentScreenFrame;
  trail: readonly AgentScreenFrame[];
  label: string;
  onOpen: (src: string, caption: string) => void;
}): JSX.Element {
  const [held, setHeld] = useState<AgentScreenFrame | null>(null);
  const steps = trail.length ? trail : [frame];
  const newest = steps.at(-1) ?? frame;
  const shown = held && steps.includes(held) ? held : newest;
  const live = shown === newest;
  const words = live ? screenDoing(shown.act) : screenDone(shown.act);
  return (
    <div className="flex flex-col gap-3">
      <ScreenPicture
        frame={shown}
        label={label}
        onOpen={(src) => onOpen(src, words)}
        pill={
          <>
            {live ? (
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: ON_PICTURE_ACCENT }} />
            ) : null}
            <span className="truncate">
              <ScreenAge frame={shown} words={words} ago />
            </span>
          </>
        }
      />
      {steps.length > 1 ? (
        <Section label="What it did">
          <div role="group" aria-label="What it did" className="flex gap-2 overflow-x-auto pb-0.5">
            {steps.map((item) => (
              <TrailStep
                key={`${item.handle}:${item.at}`}
                frame={item}
                now={item === newest}
                shown={item === shown}
                onShow={() => setHeld(item === newest ? null : item)}
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
