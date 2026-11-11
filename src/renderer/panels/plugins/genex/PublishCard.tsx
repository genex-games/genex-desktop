/**
 * The Publish card of a game made in an engine (canvas "Publish to every platform", round 3 of its
 * redesign): one row per platform the person can act on, each with a dot and one line saying what is
 * true now, and its own control at its end: a button (Build on this computer or on Genex Cloud,
 * Publish, Update, Try again), that platform's loader with its clock while it works, "Queued" while
 * it waits for another build, and the menu that takes down a platform players have. Under the rows,
 * one big button does everything. While the game folder or Genex has not answered, the rows are
 * skeletons and there is no button, so nothing claims a state it doesn't know.
 */
import type { JSX } from "react";
import { Button, buttonVariants } from "../../../ui/Button.tsx";
import { cn } from "../../../ui/cn.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Elapsed } from "../../../ui/LoadingState.tsx";
import { Skeleton } from "../../../ui/Skeleton.tsx";
import { StatusOrb } from "../../../ui/StatusOrb.tsx";
import { PUBLISH_CARD_WORDS, PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import type { GenexNativeRecord } from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { atRest, type CardRow, CardTone, type FollowBar, leftWords, type PressPlan } from "./publish-card-view.ts";
import { failureLines } from "./publish-platforms-view.ts";
import { type SendStatus, sendStatus } from "./send-progress-view.ts";
import { ALL_PLATFORMS, type ErrorBlock, type usePublishCard } from "./use-publish-card.ts";
import { useCopy } from "../../../use-copy.ts";

const WORDS = PUBLISH_CARD_WORDS;

type Card = ReturnType<typeof usePublishCard>;

/** Each platform's mark. */
const MARK: Readonly<Record<PublishTarget, IconName>> = {
  [PublishTarget.Web]: "globe",
  [PublishTarget.Mac]: "apple",
  [PublishTarget.Windows]: "windows",
  [PublishTarget.Linux]: "linux",
};

/** How many skeleton rows stand in while the card reads: an engine game has at least two. */
const SKELETON_ROWS = 2;
const PERCENT = 100;

/** Whether a row ends in the menu that takes its platform down: players have it, and nothing is under way for it. */
const hasMenu = (row: CardRow): boolean => row.live && atRest(row);

/** The menu at the end of a row players have: the one place its platform is taken down. */
function RowMenu({ row, card }: { row: CardRow; card: Card }): JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="genex-publish-card-more"
          aria-label={WORDS.more(row.name)}
          data-publish-platform-more={row.target}
          disabled={card.acting !== null}
        >
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem
          className="genex-publish-card-down"
          data-publish-platform-down={row.target}
          onSelect={() => void card.takeDown(row.target)}
        >
          <Icon name="trash" size={15} />
          {WORDS.takeDown(row.name)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The loader's clock: how long a send has left when its speed is known, else how long the work has run. */
function LoaderClock({ row, send }: { row: CardRow; send: SendStatus | null }): JSX.Element | null {
  if (send && send.leftMs !== null)
    return <span className="genex-publish-card-pill-clock">{leftWords(send.leftMs)}</span>;
  if (!row.since) return null;
  return (
    <span className="genex-publish-card-pill-clock" data-publish-platform-clock={row.target}>
      <Elapsed since={Date.parse(row.since)} />
    </span>
  );
}

/**
 * A row's control: its loader while it works (Genex's own, the work's word and its clock, in the
 * button's shape so nothing jumps), "Queued" while it waits for another build, else its button.
 */
function RowControl({ row, send, card }: { row: CardRow; send: SendStatus | null; card: Card }): JSX.Element | null {
  if (row.busy)
    return (
      <span
        role="status"
        className={cn(
          buttonVariants({ variant: "play-tint", size: "sm" }),
          "genex-publish-card-build genex-publish-card-working",
        )}
        data-publish-platform-busy={row.target}
      >
        <StatusOrb />
        <span data-shimmer className="chat-status-shimmer">
          {row.busy}
        </span>
        <LoaderClock row={row} send={send} />
      </span>
    );
  if (row.queued)
    return (
      <span className="genex-publish-card-queued" data-publish-platform-queued={row.target}>
        {WORDS.queued}
      </span>
    );
  if (!row.act) return null;
  return (
    <Button
      variant="play-tint"
      size="sm"
      className="genex-publish-card-build"
      data-publish-platform-act={row.act.work}
      disabled={card.acting !== null}
      aria-busy={card.acting === row.target || undefined}
      onClick={() => void card.act(row)}
    >
      {row.act.label}
    </Button>
  );
}

/** How far the row's send is: a hairline bar under its status. */
function SendBar({ send }: { send: SendStatus | null }): JSX.Element | null {
  if (!send || send.fraction === null) return null;
  const percent = Math.round(send.fraction * PERCENT);
  return (
    <span
      className="genex-send-progress-bar genex-publish-card-bar"
      role="progressbar"
      aria-label={WORDS.sending}
      aria-valuemin={0}
      aria-valuemax={PERCENT}
      aria-valuenow={percent}
      data-send-progress
    >
      <i style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * One platform: its mark, name and status line, then its end note, its control and, when players
 * have it, its menu. A send says how much went and how fast in the status line, over its bar. Read
 * at each render: the publish record is read again every couple of seconds while a send is going.
 */
function Row({ row, card }: { row: CardRow; card: Card }): JSX.Element {
  const send = row.busy ? sendStatus(row.progress, Date.now()) : null;
  return (
    <li className="genex-publish-card-row" data-publish-platform={row.target} data-tone={row.tone}>
      <Icon name={MARK[row.target]} size={18} />
      <span className="genex-publish-card-text">
        <span>{row.name}</span>
        <span className="genex-publish-card-status" data-publish-platform-status data-stage={row.progress?.stage}>
          {row.tone !== CardTone.Working && <span className="genex-publish-card-dot" aria-hidden />}
          <span className="genex-publish-card-words">{send?.words ?? row.status}</span>
        </span>
        <SendBar send={send} />
      </span>
      {row.side && <span className="genex-publish-card-side">{row.side}</span>}
      <RowControl row={row} send={send} card={card} />
      {hasMenu(row) && <RowMenu row={row} card={card} />}
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

/** The platforms' rows, or their skeletons while the card has none yet. */
export function PublishCardRows({ card }: { card: Card }): JSX.Element {
  const { rows } = card;
  if (!rows) return <SkeletonRows />;
  return (
    <ul className="genex-publish-card-rows" aria-label={WORDS.listLabel} data-genex-publish-platforms>
      {rows.map((row) => (
        <Row key={row.target} row={row} card={card} />
      ))}
    </ul>
  );
}

/**
 * The card's big button: what pressing it does, with the one line under it; while its press is
 * followed, the status in its place; nothing when all is done.
 */
export function PublishCardPress({
  plan,
  bar,
  acting,
  onPress,
}: {
  plan: PressPlan | null;
  /** The status in the button's place while its press is followed. */
  bar: FollowBar | null;
  /** The press being carried out now, or null. */
  acting: Card["acting"];
  onPress: (plan: PressPlan) => void;
}): JSX.Element | null {
  if (bar)
    return (
      <div className="genex-publish-card-press">
        <Button
          variant="secondary"
          size="default"
          className="genex-publish-primary"
          aria-busy
          disabled
          data-genex-publish-following
        >
          <span data-shimmer className="chat-status-shimmer">
            {bar.label}
          </span>
        </Button>
        <p className="genex-publish-card-note">{bar.note}</p>
      </div>
    );
  if (!plan) return null;
  return (
    <div className="genex-publish-card-press">
      <Button
        variant="default"
        size="default"
        className="genex-publish-primary"
        data-genex-publish-press
        disabled={acting !== null}
        aria-busy={acting === ALL_PLATFORMS || undefined}
        onClick={() => onPress(plan)}
      >
        {plan.label}
      </Button>
      {plan.note && <p className="genex-publish-card-note">{plan.note}</p>}
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
 * One error block under the rows: what failed in a few words (never the log), then Send to agent for
 * a failed build, and Copy. Trying again is the row's own button. Once the agent has it, the block
 * says the agent is fixing it, with a clock.
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
      {block.text !== "" && <CopyError text={block.text} />}
    </div>
  );
}

/**
 * The card's rows, then what went wrong (a failed Genex Cloud build's errors with Send to agent, why a
 * send was refused or Genex turned an app down) and, when it applies, that this web build takes the
 * place of a page of apps: the facts a press needs, and no other line.
 */
export function EngineCardRows({
  card,
  platforms,
  native,
  reviewed,
  replacesApps,
}: {
  card: Card;
  platforms: PublishPlatform[] | null;
  native: GenexNativeRecord | undefined;
  /** Genex's review card or check says how the apps stand: no line repeats it. */
  reviewed: boolean;
  replacesApps: boolean;
}): JSX.Element {
  const failures = platforms ? failureLines(platforms, native, reviewed, false) : [];
  return (
    <div className="genex-publish-card" data-genex-publish-card>
      <PublishCardRows card={card} />
      {card.rows && card.errors.map((block) => <ErrorBlockRow key={`${block.target}-${block.kind}`} block={block} />)}
      {failures.map((line) => (
        <p key={line} className="genex-publish-platform-failure">
          {line}
        </p>
      ))}
      {card.followError && (
        <p className="genex-publish-failure" data-publish-follow-error>
          {card.followError}
        </p>
      )}
      {replacesApps && card.rows && (
        <p className="genex-publish-reach" data-publish-replaces-apps>
          {PUBLISH_PLATFORM_WORDS.replacesApps}
        </p>
      )}
    </div>
  );
}
