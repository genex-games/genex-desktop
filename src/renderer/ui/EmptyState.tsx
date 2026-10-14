/**
 * The app's one empty state: a 3D wireframe on a fading floor, a one-line title, a one-line
 * subtitle (or none) and a fixed button slot. Every part has a fixed height, so switching between
 * states never moves the art; `wrap` lets longer words wrap instead, the copy growing under the
 * art. When the stage goes from the first idea to building, the computer hands off to the crane
 * and the words swap in place (see wire-art.ts for the art's half of it); any other change of
 * scene cross-fades the pictures while the words swap the same way, only quicker.
 */
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type JSX, type ReactNode } from "react";
import { WireArt } from "./WireArt.tsx";
import { SECOND_MS } from "../../shared/duration.ts";
import { prefersReducedMotion } from "./media-queries.ts";
import { HANDOFF, WireKind } from "./wire-art.ts";

const FLOOR =
  "M8.2 0L-64 44M22.1 0L-32 44M36.1 0L0 44M50 0L32 44M64 0L64 44M78 0L96 44M91.9 0L128 44M105.9 0L160 44M119.8 0L192 44M0 .5H128M0 3.5H128M0 8H128M0 14H128M0 22H128M0 32.5H128";
const SWAP = "cubic-bezier(0.65, 0, 0.35, 1)";

/** One part of the handoff: how it moves, when it starts and how long it takes (ms). */
type Step = { keyframes: Keyframe[]; delay: number; duration: number; easing?: string };
type HandoffSteps = { outgoing: Step; incoming: Step; slot: Step; fading: Step | null };

const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const RISE_OUT: Keyframe[] = [
  { opacity: 1, transform: "none" },
  { opacity: 0, transform: "translateY(-4px)" },
];
const RISE_IN: Keyframe[] = [
  { opacity: 0, transform: "translateY(4px)" },
  { opacity: 1, transform: "none" },
];
/** Under Reduce Motion everything cross-fades at once, this fast (ms). */
const REDUCED_MS = 150;
/** Under Reduce Motion the swap settles just after that cross-fade (ms). */
const REDUCED_SETTLE_MS = 160;
/** A plain change of scene settles once its cross-fade is done (ms). */
const CROSSFADE_SETTLE_MS = 500;

/** How a change of scene is drawn: the idea → building handoff, a cross-fade, or Reduce Motion's quick one. */
const Swap = { Handoff: "handoff", Crossfade: "crossfade", Reduced: "reduced" } as const;
type Swap = (typeof Swap)[keyof typeof Swap];

/**
 * A change of scene, part by part. The idea → building handoff: the old words rise out, the new
 * ones rise in, then the button slot, while the art hands off on its own. A cross-fade does the
 * same quicker and fades the old art out over the new; Reduce Motion cross-fades everything at once.
 */
function handoffSteps(swap: Swap): HandoffSteps {
  if (swap === Swap.Crossfade)
    return {
      outgoing: { keyframes: RISE_OUT, delay: 0, duration: 180 },
      incoming: { keyframes: RISE_IN, delay: 140, duration: 240 },
      slot: { keyframes: RISE_IN, delay: 220, duration: 260, easing: "ease-out" },
      fading: { keyframes: FADE_OUT, delay: 0, duration: 260, easing: "linear" },
    };
  if (swap === Swap.Reduced)
    return {
      outgoing: { keyframes: FADE_OUT, delay: 0, duration: REDUCED_MS },
      incoming: { keyframes: FADE_IN, delay: 0, duration: REDUCED_MS },
      slot: { keyframes: FADE_IN, delay: 0, duration: REDUCED_MS, easing: "ease-out" },
      fading: { keyframes: FADE_OUT, delay: 0, duration: REDUCED_MS, easing: "linear" },
    };
  return {
    outgoing: { keyframes: RISE_OUT, delay: 300, duration: 175 },
    incoming: { keyframes: RISE_IN, delay: 440, duration: 210 },
    slot: { keyframes: RISE_IN, delay: 1000, duration: 300, easing: "ease-out" },
    fading: null,
  };
}

type Words = { title: string; subtitle: string | undefined };
type Handoff = { at: number; from: Words & { art: WireKind }; swap: Swap; settled: boolean };

/** How the scene `from` → `to` is drawn. */
function swapFor(from: WireKind, to: WireKind): Swap {
  if (prefersReducedMotion()) return Swap.Reduced;
  return from === WireKind.Idea && to === WireKind.Building ? Swap.Handoff : Swap.Crossfade;
}

/** How long a swap takes before the scene is settled (ms). */
const SETTLE_MS: Record<Swap, number> = {
  [Swap.Handoff]: HANDOFF * SECOND_MS,
  [Swap.Crossfade]: CROSSFADE_SETTLE_MS,
  [Swap.Reduced]: REDUCED_SETTLE_MS,
};

/** A title and, when there is one, the sentence under it. */
function WordsOf({ title, subtitle }: Words): JSX.Element {
  return (
    <>
      <h2 className="empty-state-title">{title}</h2>
      {subtitle ? <p className="empty-state-subtitle">{subtitle}</p> : null}
    </>
  );
}

export function EmptyState({
  art,
  title,
  subtitle,
  action,
  wrap = false,
  className = "",
  ...rest
}: {
  art: WireKind;
  title: string;
  /** The sentence under the title; none leaves the title alone. */
  subtitle?: string;
  action?: ReactNode;
  /** Words longer than one line wrap, and the copy grows; the art and the slot keep their heights. */
  wrap?: boolean;
  className?: string;
} & HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const previous = useRef({ art, title, subtitle });
  const outgoing = useRef<HTMLDivElement>(null);
  const incoming = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const fading = useRef<HTMLDivElement>(null);

  // A new scene swaps in: idea → building with its handoff, anything else with a cross-fade.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { art, title, subtitle };
    if (before.art === art) return;
    setHandoff({ at: performance.now(), from: before, swap: swapFor(before.art, art), settled: false });
  }, [art, title, subtitle]);

  // Web Animations rather than CSS, so the 150 ms Reduce Motion cross-fade survives the app's
  // global reduced-motion override.
  useLayoutEffect(() => {
    if (!handoff || handoff.settled) return;
    const steps = handoffSteps(handoff.swap);
    const parts: Record<keyof HandoffSteps, HTMLElement | null> = {
      outgoing: outgoing.current,
      incoming: incoming.current,
      slot: slot.current,
      fading: fading.current,
    };
    const animations = (Object.keys(steps) as Array<keyof HandoffSteps>).map((part) => {
      const step = steps[part];
      if (!step) return undefined;
      return parts[part]?.animate(step.keyframes, {
        delay: step.delay,
        duration: step.duration,
        easing: step.easing ?? SWAP,
        fill: "both",
      });
    });
    const timer = setTimeout(
      () => setHandoff((value) => value && { ...value, settled: true }),
      SETTLE_MS[handoff.swap],
    );
    return () => {
      clearTimeout(timer);
      for (const animation of animations) animation?.cancel();
    };
  }, [handoff]);

  const swapping = !!handoff && !handoff.settled;
  const choreographed = handoff?.swap === Swap.Handoff;
  return (
    <div className={`empty-state ${wrap ? "empty-state-wrap " : ""}${className}`} {...rest}>
      <div className="empty-state-art" aria-hidden="true">
        <svg className="empty-state-floor" viewBox="0 0 128 44" preserveAspectRatio="none">
          <path d={FLOOR} />
        </svg>
        <span className="empty-state-glow" />
        <WireArt kind={art} handoffAt={handoff && choreographed ? handoff.at : null} />
        {swapping && !choreographed && (
          <div ref={fading} className="empty-state-art-fading">
            <WireArt kind={handoff.from.art} />
          </div>
        )}
      </div>
      {/* A state with no subtitle keeps no room for one: its button follows the title. */}
      <div className="empty-state-copy" data-title-only={subtitle ? undefined : ""}>
        {swapping && (
          <div ref={outgoing} className="empty-state-words" aria-hidden="true">
            <WordsOf {...handoff.from} />
          </div>
        )}
        <div ref={incoming} className="empty-state-words">
          <WordsOf title={title} subtitle={subtitle} />
        </div>
      </div>
      <div ref={slot} className="empty-state-slot">
        {action}
      </div>
    </div>
  );
}
