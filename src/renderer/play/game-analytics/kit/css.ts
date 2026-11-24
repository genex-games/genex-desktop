/** A custom property on an element's style: how a chart hands CSS a share or a shade to draw. */
import type { CSSProperties } from "react";

/** The style that sets the custom properties in `values`, e.g. `{ "--game-analytics-share": 0.4 }`. */
export function cssVars(values: Readonly<Record<`--${string}`, string | number>>): CSSProperties {
  return values as CSSProperties;
}
