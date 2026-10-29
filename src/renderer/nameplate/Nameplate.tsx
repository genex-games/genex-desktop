/**
 * A Pro's nameplate: lit, the row takes the art's own colour, the piece melts in from the right
 * behind a soft dark wash, and sparkles twinkle around the face in the avatar's glow. A plate in the
 * sidebar lights up only under the pointer (never while its menu is open), and its art moves only
 * then; one shown off (Settings) is always lit. The art is one canvas on the plate painter; the rest is CSS
 * (`theme.css`, "Pro nameplate").
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type PlateRecipe, plateRecipe } from "../../shared/plate-recipe.ts";
import { type PlateHandle, mountPlate } from "./plate-painter.ts";
import { usePlateVariant } from "./plate-variant.ts";

/** How many sparkles twinkle around the face. */
const SPARKLES = 4;

/** The plate an account shows: its id, the variant it rolled on this Mac and the avatar it shows. */
export function useNameplate(accountId: string, avatarVariant: number): PlateRecipe {
  const variant = usePlateVariant(accountId);
  return useMemo(() => plateRecipe(accountId, variant, avatarVariant), [accountId, variant, avatarVariant]);
}

/** The plate's colours as the CSS reads them. */
function plateStyle(recipe: PlateRecipe): CSSProperties {
  return {
    "--plate-glow": recipe.colors.glow,
    "--plate-tint": recipe.tint,
  } as CSSProperties;
}

/** The art: one canvas the painter draws the piece into, moving while `live`. */
function NameplateArt({ recipe, live }: { recipe: PlateRecipe; live: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<PlateHandle | null>(null);
  const shown = useRef(recipe);
  shown.current = recipe;
  useEffect(() => {
    if (!canvas.current) return;
    const mounted = mountPlate(canvas.current, shown.current);
    handle.current = mounted;
    return () => {
      mounted.dispose();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.set(recipe);
  }, [recipe]);
  useEffect(() => {
    handle.current?.animate(live);
  }, [live]);
  return (
    <span className="nameplate-art" aria-hidden="true">
      <canvas ref={canvas} data-nameplate-scene={recipe.scene} />
    </span>
  );
}

/** A four-point star. */
function Sparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 0C5.5 3.6 6.4 4.5 10 5 6.4 5.5 5.5 6.4 5 10 4.5 6.4 3.6 5.5 0 5 3.6 4.5 4.5 3.6 5 0z" />
    </svg>
  );
}

/** The sparkles around the face, staggered so they never twinkle together. */
function Sparkles(): JSX.Element {
  return (
    <span className="nameplate-sparkles" aria-hidden="true">
      {Array.from({ length: SPARKLES }, (_, at) => (
        <i key={at}>
          <Sparkle />
        </i>
      ))}
    </span>
  );
}

/**
 * Whether the pointer is over a `hover` plate: what lights it. `dim` (its menu open) puts it out and
 * forgets the pointer, which an open menu keeps from leaving; closing it looks again.
 */
function useLit(hover: boolean, dim: boolean, plate: { current: HTMLDivElement | null }) {
  const [pointer, setPointer] = useState(false);
  // An open menu forgets the pointer; once it closes, a pointer still on the plate lights it again.
  useEffect(() => {
    if (dim) {
      setPointer(false);
      return;
    }
    const frame = requestAnimationFrame(() => setPointer(plate.current?.matches(":hover") ?? false));
    return () => cancelAnimationFrame(frame);
  }, [dim, plate]);
  const events = hover ? { onPointerEnter: () => setPointer(true), onPointerLeave: () => setPointer(false) } : {};
  return { lit: !dim && (!hover || pointer), events };
}

/**
 * The plate around its row's contents (the face, the name, the credits); `sparkles` around the
 * face, on by default; `hover` lights it only under the pointer; `dim` puts it out (its menu open).
 */
export function Nameplate({
  recipe,
  className,
  sparkles = true,
  hover = false,
  dim = false,
  children,
}: {
  recipe: PlateRecipe;
  className?: string;
  sparkles?: boolean;
  hover?: boolean;
  dim?: boolean;
  children: ReactNode;
}): JSX.Element {
  const plate = useRef<HTMLDivElement>(null);
  const { lit, events } = useLit(hover, dim, plate);
  return (
    <div
      ref={plate}
      className={className ? `nameplate ${className}` : "nameplate"}
      style={plateStyle(recipe)}
      data-nameplate
      data-lit={lit || undefined}
      {...events}
    >
      <NameplateArt recipe={recipe} live={lit} />
      <span className="nameplate-wash" aria-hidden="true" />
      {sparkles && <Sparkles />}
      {children}
    </div>
  );
}
