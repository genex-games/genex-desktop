/**
 * Two ways to read "how many, of how many": a funnel's steps in order, each with its count, the
 * share that goes on and what is lost before the next; and a list of rows with a value, a share and
 * a bar (channels, items, the values of a property).
 */
import type { JSX } from "react";
import { cssVars } from "./css.ts";
import { DASH, formatNumber, formatPercent } from "./format.ts";
import { barShares, type FunnelFlow, funnelFlow } from "./geometry.ts";
import { KIT_WORDS } from "./words.ts";

/**
 * A step of a funnel. `label` names it and `qualifier` narrows it ("level = 1"); `count` is the
 * people who reached it. `onward` and `lost` are the two lines under its bar: left out, they say
 * "44.2% go on" and "10,820 leave" (the last step says its share of the first); a string words
 * them the report's way (`funnelFlow(counts)` gives the numbers); null hides the line.
 */
export interface FunnelStepItem {
  id: string;
  label: string;
  qualifier?: string;
  count: number;
  onward?: string | null;
  lost?: string | null;
}

/** The line that says who goes on from a step, when the report did not word it. */
function onwardLine(flow: FunnelFlow | undefined, last: boolean): string | null {
  if (!flow) return null;
  if (last) return flow.ofFirst === null ? null : KIT_WORDS.ofFirstStep(formatPercent(flow.ofFirst));
  return flow.onward === null ? null : KIT_WORDS.goOn(formatPercent(flow.onward));
}

/** The line that says how many a step loses, when the report did not word it. */
function lostLine(flow: FunnelFlow | undefined): string | null {
  if (!flow || flow.lost === null || flow.lost <= 0) return null;
  return KIT_WORDS.leave(formatNumber(flow.lost));
}

/**
 * A funnel. Props: `id` names it in `data-game-analytics-funnel`; `label` says what it follows, for
 * assistive technology; `steps` in order, the first being everyone; `mask` when the steps' names
 * are the creator's own (a game's events), so usage recordings hide them.
 */
export function FunnelSteps({
  id,
  label,
  steps,
  mask,
}: {
  id: string;
  label: string;
  steps: readonly FunnelStepItem[];
  mask?: boolean;
}): JSX.Element {
  const flows = funnelFlow(steps.map((step) => step.count));
  return (
    <ol className="game-analytics-funnel" aria-label={label} data-game-analytics-funnel={id}>
      {steps.map((step, index) => {
        const flow = flows[index];
        const onward = step.onward === undefined ? onwardLine(flow, index === steps.length - 1) : step.onward;
        const lost = step.lost === undefined ? lostLine(flow) : step.lost;
        return (
          <li key={step.id} className="game-analytics-step" data-game-analytics-step={step.id}>
            <span className="game-analytics-step-label" data-analytics-mask={mask || undefined}>
              {step.label}
              {step.qualifier && <span className="game-analytics-step-qualifier"> {step.qualifier}</span>}
            </span>
            <span className="game-analytics-step-count">{formatNumber(step.count)}</span>
            <span className="game-analytics-step-track" aria-hidden="true">
              <span
                className="game-analytics-step-bar"
                style={cssVars({ "--game-analytics-share": flow?.ofFirst ?? 0 })}
              />
            </span>
            {onward && <span className="game-analytics-step-onward">{onward}</span>}
            {lost && <span className="game-analytics-step-lost">{lost}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** A row of a bar list: its name, its value, and a quiet second line under the name. */
export interface BarListItem {
  id: string;
  label: string;
  value: number;
  detail?: string;
}

/**
 * Rows with a name, a bar, a value and a share. Props: `id` names it in `data-game-analytics-bars`;
 * `label` says what the rows are, for assistive technology; `items` in the order to show (most
 * first); `total` is what a share is of (the rows' sum when left out; pass the first step's count
 * for a compact funnel); `format` writes a value (a grouped count when left out); `shareDigits` is
 * the share's decimals (none when left out); `mask` when the names are the creator's own.
 */
export function BarList({
  id,
  label,
  items,
  total,
  format = formatNumber,
  shareDigits = 0,
  mask,
}: {
  id: string;
  label: string;
  items: readonly BarListItem[];
  total?: number;
  format?: (value: number) => string;
  shareDigits?: number;
  mask?: boolean;
}): JSX.Element {
  const shares = barShares(
    items.map((item) => item.value),
    total,
  );
  return (
    <ul className="game-analytics-barlist" aria-label={label} data-game-analytics-bars={id}>
      {items.map((item, index) => {
        const share = shares[index]?.share ?? null;
        return (
          <li key={item.id} className="game-analytics-barlist-row" data-game-analytics-bar={item.id}>
            <span className="game-analytics-barlist-name">
              <span className="game-analytics-barlist-label" title={item.label} data-analytics-mask={mask || undefined}>
                {item.label}
              </span>
              {item.detail && <span className="game-analytics-barlist-detail">{item.detail}</span>}
            </span>
            <span className="game-analytics-track" aria-hidden="true">
              <span
                className="game-analytics-track-fill"
                style={cssVars({ "--game-analytics-share": shares[index]?.width ?? 0 })}
              />
            </span>
            <span className="game-analytics-barlist-value">{format(item.value)}</span>
            <span className="game-analytics-barlist-share">
              {share === null ? DASH : formatPercent(share, shareDigits)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
