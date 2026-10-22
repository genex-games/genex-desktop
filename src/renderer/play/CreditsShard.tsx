/**
 * genex.games' credits mark, a pixel shard, and a credits number that scrambles into place. The
 * shard's pixels assemble once in a shuffled order, 35 ms a step, when it first shows; the digits
 * scramble when the number changes and on hover. Both hold still under Reduce Motion.
 */
import type { CSSProperties, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { SCRAMBLE_FRAME_MS, SCRAMBLE_FRAMES, SHARD_CELLS, ShardTone, scrambled } from "./credits-shard.ts";

/** The credits shard, `size` pixels wide. */
export function CreditsShard({ size = 15, tone = ShardTone.Brand }: { size?: number; tone?: ShardTone }): JSX.Element {
  return (
    <svg
      className="credits-shard"
      data-tone={tone}
      viewBox="0 0 11 10"
      width={size}
      height={Math.round((size * 10) / 11)}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {SHARD_CELLS.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={1}
          height={1}
          data-shade={cell.shade}
          style={{ "--shard-delay": `${cell.delay}ms` } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/** A credits number that scrambles into place when it changes and when the pointer comes over it. */
export function ScrambleNumber({ text, className }: { text: string; className?: string }): JSX.Element {
  const [frame, setFrame] = useState(SCRAMBLE_FRAMES);
  const timer = useRef(0);
  const run = () => {
    if (prefersReducedMotion()) return;
    window.clearInterval(timer.current);
    let at = 0;
    setFrame(0);
    timer.current = window.setInterval(() => {
      at += 1;
      setFrame(at);
      if (at >= SCRAMBLE_FRAMES) window.clearInterval(timer.current);
    }, SCRAMBLE_FRAME_MS);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new number is what scrambles
  useEffect(() => {
    run();
    return () => window.clearInterval(timer.current);
  }, [text]);
  return (
    <span className={className} onPointerEnter={run}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{scrambled(text, frame)}</span>
    </span>
  );
}
