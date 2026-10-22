/**
 * A generated avatar in the page: its box and three stacked canvases (gear behind, the body, the
 * eyes and the rest), painted by the shared painter. Still in lists; it runs while hovered (the
 * nearest `[data-avatar-host]` around it, else itself) or, live, all the time.
 */
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";
import { type AvatarHandle, mountAvatar } from "./avatar-painter.ts";

/** When an avatar moves. */
export const AvatarMotion = {
  /** Never: a still frame. */
  Still: "still",
  /** While the pointer is over it or over the card it sits in. */
  Hover: "hover",
  /** All the time (a profile's header, the avatar's own settings). */
  Live: "live",
} as const;
export type AvatarMotion = (typeof AvatarMotion)[keyof typeof AvatarMotion];

/** Run the avatar while the pointer is over its host: the nearest `[data-avatar-host]`, else its box. */
function useHover(box: { current: HTMLElement | null }, handle: { current: AvatarHandle | null }, on: boolean): void {
  useEffect(() => {
    const host = box.current?.closest("[data-avatar-host]") ?? box.current;
    if (!on || !host) return;
    const enter = () => handle.current?.animate(true);
    const leave = () => handle.current?.animate(false);
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      handle.current?.animate(false);
    };
  }, [box, handle, on]);
}

/** One generated avatar, `size` CSS pixels a side; `full` fills the box with the body and leaves gear out. */
export function GeneratedAvatar({
  recipe,
  size,
  full,
  ghost = false,
  quiet = false,
  flat = false,
  motion = AvatarMotion.Hover,
}: {
  recipe: AvatarRecipe;
  size: number;
  full: boolean;
  ghost?: boolean;
  /** A face that stays in the background (the painter's `quiet`): faint eyes, dim stars. */
  quiet?: boolean;
  /** Drawn as genex.games' link previews draw it: the body a 2D still, never on the GPU. */
  flat?: boolean;
  motion?: AvatarMotion;
}): JSX.Element {
  const box = useRef<HTMLSpanElement>(null);
  const back = useRef<HTMLCanvasElement>(null);
  const body = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const look = { recipe, size, full, ghost, quiet, flat };
  const shown = useRef(look);
  shown.current = look;
  // The painter holds the canvases for the avatar's life; a change of look is a `set` below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `full` decides which canvases exist, `flat` how the body is drawn
  useEffect(() => {
    const layers =
      body.current && front.current ? { back: back.current, body: body.current, front: front.current } : null;
    if (!layers) return;
    const mounted = mountAvatar(layers, shown.current);
    handle.current = mounted;
    return () => {
      mounted.dispose();
      handle.current = null;
    };
  }, [full, flat]);
  useEffect(() => {
    handle.current?.set({ recipe, size, full, ghost, quiet, flat });
  }, [recipe, size, full, ghost, quiet, flat]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `full` is a new handle to set going
  useEffect(() => {
    handle.current?.animate(motion === AvatarMotion.Live);
  }, [motion, full]);
  useHover(box, handle, motion === AvatarMotion.Hover);
  return (
    <span
      ref={box}
      className="cy-avatar"
      style={{ width: size, height: size }}
      data-avatar={recipe.body}
      data-avatar-eyes={recipe.eyes}
      aria-hidden="true"
    >
      {!full && <canvas key="back" ref={back} className="cy-avatar-layer" />}
      <canvas key="body" ref={body} className="cy-avatar-layer" />
      <canvas key="front" ref={front} className="cy-avatar-layer" />
    </span>
  );
}
