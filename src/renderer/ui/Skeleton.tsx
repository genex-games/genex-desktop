/**
 * The shapes a region shows while its content is on its way (inside `Pending`): soft blocks the
 * size of the lines, pictures and controls that come, breathing slowly together, still under
 * reduced motion (`.skeleton` in theme.css). They are drawn only; `Pending` says what is loading.
 */
import type { CSSProperties, JSX } from "react";

/** A block's length along a line: pixels, or a share of the line ("60%"). */
type Length = number | `${number}%`;

/** One block: a text line by default, a picture or a control when given a height and corners. */
export function Skeleton({
  width = "100%",
  height,
  radius,
  className = "",
}: {
  width?: Length;
  height?: number;
  radius?: number;
  className?: string;
}): JSX.Element {
  const style: CSSProperties = { width };
  if (height !== undefined) style.height = height;
  if (radius !== undefined) style.borderRadius = radius;
  return <span aria-hidden className={`skeleton ${className}`} style={style} />;
}

/** A paragraph: one line per width, at the reading line's spacing. */
export function SkeletonLines({
  widths,
  className = "",
}: {
  widths: readonly Length[];
  className?: string;
}): JSX.Element {
  return (
    <span aria-hidden className={`skeleton-lines ${className}`}>
      {widths.map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed and never reorder.
        <Skeleton key={index} width={width} />
      ))}
    </span>
  );
}

/** What a skeleton row holds at its right end: a switch, a button or nothing. */
export const SkeletonControl = { Switch: "switch", Button: "button", None: "none" } as const;
export type SkeletonControl = (typeof SkeletonControl)[keyof typeof SkeletonControl];

/** How wide each row's name and hint are, so stacked rows don't line up like a table. */
const ROW_WIDTHS: readonly (readonly [Length, Length])[] = [
  ["46%", "80%"],
  ["58%", "70%"],
  ["40%", "76%"],
  ["52%", "64%"],
];
const FIRST_ROW: readonly [Length, Length] = ["46%", "80%"];

/**
 * Rows of a list or a settings page: a name over a hint, with what each row has at its ends (an icon
 * on the left, a switch or a button on the right).
 */
export function SkeletonRows({
  count = 3,
  icon = false,
  control = SkeletonControl.Switch,
}: {
  count?: number;
  icon?: boolean;
  control?: SkeletonControl;
}): JSX.Element {
  return (
    <span aria-hidden className="skeleton-rows">
      {Array.from({ length: count }, (_, index) => {
        const [name, hint] = ROW_WIDTHS[index % ROW_WIDTHS.length] ?? FIRST_ROW;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are fixed and never reorder.
          <span key={index} className="skeleton-row">
            {icon && <Skeleton width={32} height={32} radius={8} />}
            <span className="skeleton-row-text">
              <Skeleton width={name} />
              <Skeleton width={hint} height={8} />
            </span>
            {control === SkeletonControl.Switch && <Skeleton width={34} height={20} />}
            {control === SkeletonControl.Button && <Skeleton width={72} height={28} radius={8} />}
          </span>
        );
      })}
    </span>
  );
}
