/**
 * The Publish card of a game made in an engine (canvas "Publish to every platform", round 4): one row
 * per platform the person can act on, each with a dot and one line saying what is true now, a switch
 * for whether players get it (a clock in its place while it works), and one button whose words say
 * what pressing it does. While the game folder or Genex has not answered, the rows are skeletons and
 * there is no button, so nothing claims a state it doesn't know.
 */
import type { JSX } from "react";
import { Button } from "../../../ui/Button.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Elapsed } from "../../../ui/LoadingState.tsx";
import { Skeleton } from "../../../ui/Skeleton.tsx";
import { Toggle } from "../../../ui/Toggle.tsx";
import { PUBLISH_CARD_WORDS, PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import type { GenexNativeRecord } from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { type BusyPress, type CardRow, CardTone, type PressPlan, switchedOn } from "./publish-card-view.ts";
import { type CloudBuildErrors, failureLines } from "./publish-platforms-view.ts";
import type { usePublishCard } from "./use-publish-card.ts";

const WORDS = PUBLISH_CARD_WORDS;

/** Each platform's mark. */
const MARK: Readonly<Record<PublishTarget, IconName>> = {
  [PublishTarget.Web]: "globe",
  [PublishTarget.Mac]: "apple",
  [PublishTarget.Windows]: "windows",
  [PublishTarget.Linux]: "linux",
};

/** How many skeleton rows stand in while the card reads: an engine game has at least two. */
const SKELETON_ROWS = 2;

/** A row's end: its switch, or the clock of the work under way. */
function RowEnd({
  row,
  on,
  onSwitch,
}: {
  row: CardRow;
  on: boolean;
  onSwitch: (target: PublishTarget, on: boolean) => void;
}): JSX.Element {
  if (row.tone === CardTone.Working)
    return (
      <span className="genex-publish-card-clock" data-publish-platform-clock={row.target}>
        {row.since ? <Elapsed since={Date.parse(row.since)} /> : null}
      </span>
    );
  return <Toggle on={on} onChange={(next) => onSwitch(row.target, next)} ariaLabel={WORDS.switchLabel(row.name)} />;
}

/** One platform: its mark, name and status line, then its end note and switch. */
function Row({
  row,
  on,
  onSwitch,
}: {
  row: CardRow;
  on: boolean;
  onSwitch: (target: PublishTarget, on: boolean) => void;
}): JSX.Element {
  const working = row.tone === CardTone.Working;
  return (
    <li className="genex-publish-card-row" data-publish-platform={row.target} data-tone={row.tone} data-on={on}>
      <Icon name={MARK[row.target]} size={18} />
      <span className="genex-publish-card-text">
        <span>{row.name}</span>
        <span className="genex-publish-card-status" data-publish-platform-status>
          {!working && <span className="genex-publish-card-dot" aria-hidden />}
          {working ? (
            <span data-shimmer className="chat-status-shimmer">
              {row.status}
            </span>
          ) : (
            row.status
          )}
        </span>
      </span>
      {row.side && !working && <span className="genex-publish-card-side">{row.side}</span>}
      <RowEnd row={row} on={on} onSwitch={onSwitch} />
    </li>
  );
}

/** The rows' shapes while the folder or Genex is still answering. */
function SkeletonRows(): JSX.Element {
  return (
    <ul className="genex-publish-card-rows" aria-busy data-publish-card-loading>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the skeleton rows are fixed and never reorder.
        <li key={index} className="genex-publish-card-row">
          <Skeleton width={18} height={18} radius={9} />
          <span className="genex-publish-card-text">
            <Skeleton width={64} />
            <Skeleton width={150} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The platforms' rows, or their skeletons while `rows` is null. */
export function PublishCardRows({
  rows,
  switches,
  onSwitch,
}: {
  rows: readonly CardRow[] | null;
  switches: ReadonlyMap<PublishTarget, boolean>;
  onSwitch: (target: PublishTarget, on: boolean) => void;
}): JSX.Element {
  if (!rows) return <SkeletonRows />;
  return (
    <ul className="genex-publish-card-rows" aria-label={WORDS.listLabel} data-genex-publish-platforms>
      {rows.map((row) => (
        <Row key={row.target} row={row} on={switchedOn(row, switches)} onSwitch={onSwitch} />
      ))}
    </ul>
  );
}

/** The card's one button: what pressing it does, or what is under way and its clock; nothing when all is done. */
export function PublishCardPress({
  plan,
  busy,
  pressing,
  onPress,
  onFix,
}: {
  plan: PressPlan | null;
  busy: BusyPress | null;
  /** A press is being sent now. */
  pressing: boolean;
  onPress: (plan: PressPlan) => void;
  /** A failed Genex Cloud build the agent should fix first: with nothing else to press, the button asks it. */
  onFix?: (() => void) | undefined;
}): JSX.Element | null {
  if (!plan && !busy && onFix)
    return (
      <Button variant="default" size="default" className="genex-publish-primary" data-publish-cloud-fix onClick={onFix}>
        {PUBLISH_PLATFORM_WORDS.cloudFix}
      </Button>
    );
  if (busy && !plan)
    return (
      <div className="genex-publish-card-press">
        <Button variant="secondary" size="default" className="genex-publish-primary" aria-busy disabled>
          <span data-shimmer className="chat-status-shimmer">
            {busy.label}
          </span>
          {busy.since && (
            <span className="genex-publish-clock">
              <Elapsed since={Date.parse(busy.since)} />
            </span>
          )}
        </Button>
        {busy.cloud && <p className="genex-publish-card-note">{WORDS.cloudTakesLong}</p>}
      </div>
    );
  if (!plan) return null;
  return (
    <div className="genex-publish-card-press">
      <Button
        variant="default"
        size="default"
        className="genex-publish-primary"
        data-warn={plan.warn || undefined}
        data-genex-publish-press
        disabled={pressing}
        aria-busy={pressing || undefined}
        onClick={() => onPress(plan)}
      >
        {plan.label}
      </Button>
      {busy?.cloud && <p className="genex-publish-card-note">{WORDS.cloudTakesLong}</p>}
    </div>
  );
}

/** What a failed Genex Cloud build's log says: its first error and how many more, in the log's own words. */
function CardErrors({ fix }: { fix: CloudBuildErrors }): JSX.Element {
  const more = fix.errors.length - 1;
  return (
    <p className="genex-publish-card-errors" data-publish-cloud-errors>
      {fix.errors[0]}
      {more > 0 && <span>{PUBLISH_PLATFORM_WORDS.cloudMoreErrors(more)}</span>}
    </p>
  );
}

/**
 * The card's rows, then what went wrong (a failed Genex Cloud build's errors with Fix with agent, why a
 * send was refused or Genex turned an app down) and, when it applies, that this web build takes the
 * place of a page of apps: the facts the press needs, and no other line.
 */
export function EngineCardRows({
  card,
  platforms,
  native,
  reviewed,
  replacesApps,
}: {
  card: ReturnType<typeof usePublishCard>;
  platforms: PublishPlatform[] | null;
  native: GenexNativeRecord | undefined;
  /** Genex's review card or check says how the apps stand: no line repeats it. */
  reviewed: boolean;
  replacesApps: boolean;
}): JSX.Element {
  const failures = platforms ? failureLines(platforms, native, reviewed) : [];
  return (
    <div className="genex-publish-card" data-genex-publish-card>
      <PublishCardRows rows={card.rows} switches={card.switches} onSwitch={card.onSwitch} />
      {card.rows && card.fix && <CardErrors fix={card.fix} />}
      {failures.map((line) => (
        <p key={line} className="genex-publish-platform-failure">
          {line}
        </p>
      ))}
      {replacesApps && card.rows && (
        <p className="genex-publish-reach" data-publish-replaces-apps>
          {PUBLISH_PLATFORM_WORDS.replacesApps}
        </p>
      )}
    </div>
  );
}
