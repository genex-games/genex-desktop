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
import { failureLines } from "./publish-platforms-view.ts";
import type { ErrorBlock, usePublishCard } from "./use-publish-card.ts";
import { useCopy } from "../../../use-copy.ts";

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
}: {
  plan: PressPlan | null;
  busy: BusyPress | null;
  /** A press is being sent now. */
  pressing: boolean;
  onPress: (plan: PressPlan) => void;
}): JSX.Element | null {
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

/** Copy the error: its icon turns to a ✓ and says Copied for a moment. */
function CopyError({ text }: { text: string }): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <span className="genex-publish-card-copy">
      <button
        type="button"
        className="genex-publish-card-square"
        aria-label={copied ? WORDS.copied : WORDS.copyError}
        data-publish-error-copy
        onClick={() => copy(text)}
      >
        <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
      {copied && (
        <span className="genex-publish-card-copied" role="status">
          {WORDS.copied}
        </span>
      )}
    </span>
  );
}

/**
 * One error block under the rows: what failed in a few words (never the log), then its press (Send to
 * agent, or Try again) and Copy. Once the agent has it, the block says the agent is fixing it, with a clock.
 */
function ErrorBlockRow({ block }: { block: ErrorBlock }): JSX.Element {
  const name = WORDS.name[block.target];
  if (block.sentAt)
    return (
      <div className="genex-publish-card-error" data-publish-error={block.target} data-sent>
        <span className="genex-publish-card-error-text">
          <span data-shimmer className="chat-status-shimmer">
            {WORDS.fixing(name)}
          </span>
        </span>
        <span className="genex-publish-card-clock">
          <Elapsed since={Date.parse(block.sentAt)} />
        </span>
        <CopyError text={block.text} />
      </div>
    );
  return (
    <div className="genex-publish-card-error" data-publish-error={block.target} data-kind={block.kind}>
      <Icon name="warning" size={16} />
      <span className="genex-publish-card-error-text">{block.title}</span>
      {block.onSend && (
        <button
          type="button"
          className="genex-publish-card-action"
          aria-label={WORDS.sendToAgentLabel(name)}
          data-publish-error-send
          onClick={block.onSend}
        >
          {WORDS.sendToAgent}
        </button>
      )}
      {block.onRetry && (
        <button type="button" className="genex-publish-card-action" data-publish-error-retry onClick={block.onRetry}>
          {WORDS.tryAgain}
        </button>
      )}
      <CopyError text={block.text} />
    </div>
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
  const failures = platforms ? failureLines(platforms, native, reviewed, false) : [];
  return (
    <div className="genex-publish-card" data-genex-publish-card>
      <PublishCardRows rows={card.rows} switches={card.switches} onSwitch={card.onSwitch} />
      {card.rows && card.errors.map((block) => <ErrorBlockRow key={`${block.target}-${block.kind}`} block={block} />)}
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
