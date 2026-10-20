/**
 * The bell after Search, and its panel.
 *
 * A glance, not a task: the panel hangs off the bell and the app stays lit behind it. What waits
 * on you comes first and stays until it is answered; what happened follows by day and is read by
 * opening. Every row opens the place that owns the action, so no answer or approval is repeated
 * here. The bell carries a count for waiting work and a dot for unread news, and rings once when
 * something arrives.
 */
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PickerLabel } from "../ui/PickerPanel.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { isRovingKey, RovingAxis, rovingTarget } from "../ui/roving-focus.ts";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { CLAUDE_CODE_MARK, CODEX_MARK } from "../ui/provider-marks.ts";
import { relativeTime } from "../chat-labels.ts";
import { activityNotices, dayGroup, type Notice, NoticeKind, noticeSource, waitingNotices } from "../notifications.ts";
import { isGameThread, threadMeta } from "../state/threads.ts";
import type { ConversationRecord, GameProject } from "../types.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";

const ACTION: Partial<Record<Notice["kind"], string>> = { question: "Answer", plan: "Review", permission: "Review" };

/** The bell's count shows up to this many, then "9+". */
const BADGE_MAX = 9;
/** How long the bell rings when something arrives. */
const RING_MS = 1600;
/** After the panel closes, focus returning to the bell does not open its tooltip for this long. */
const TIP_QUIET_MS = 400;

interface Props {
  items: Notice[];
  games: GameProject[];
  threads: ConversationRecord[];
  onOpen: (notice: Notice) => void;
  /** Opening the panel reads the news in it. */
  onRead: () => void;
  onClear: () => void;
}

/** The bell's accessible name: what waits on you, else whether there is news. */
function bellLabel(waiting: number, unread: number): string {
  if (waiting) return `Notifications, ${waiting} waiting for you`;
  return unread ? "Notifications, new activity" : "Notifications";
}

/** The bell's badge: a count while work waits, a dot for unread news, else nothing. */
function badgeShows(waiting: number, unread: number): "count" | "dot" | undefined {
  if (waiting) return "count";
  return unread ? "dot" : undefined;
}

/** The waiting count as the badge prints it. */
const badgeCount = (waiting: number): string => (waiting > BADGE_MAX ? `${BADGE_MAX}+` : String(waiting));

/** Arrows move between rows; Tab still leaves the panel. */
function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>): void {
  if (!isRovingKey(event.key, RovingAxis.Vertical)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".notify-row")];
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rovingTarget(event.key, current, rows.length, RovingAxis.Vertical);
  if (next !== null) rows[next]?.focus();
}

/** Ring once when something new waits or arrives; the first render is the app starting, not news. */
function useRing(latest: string): boolean {
  const heard = useRef<string | null>(null);
  const [ringing, setRinging] = useState(false);
  useEffect(() => {
    const before = heard.current;
    heard.current = latest;
    if (before === null || !latest) return;
    if (latest <= before) return;
    setRinging(true);
    const timer = setTimeout(() => setRinging(false), RING_MS);
    return () => clearTimeout(timer);
  }, [latest]);
  return ringing;
}

/** When a row happened, or for a notice that waits to start, how soon it starts. */
function noticeTime(notice: Notice, now: number): string {
  if (!notice.until) return relativeTime(notice.at, now);
  return `starts in ${Math.max(1, Math.ceil((notice.until - now) / MINUTE_MS))}m`;
}

/** A row's glyph with no game cover: Play's for a game from Play, else the chat's kind. */
const artIcon = (notice: Notice, gameChat: boolean): IconName => {
  if (notice.kind === NoticeKind.Play) return "gamepad";
  return gameChat ? "new-game" : "harness";
};

/** A row's picture: its game's cover, else the provider's mark or the chat's kind. */
function NoticeArt({ notice, game, gameChat }: { notice: Notice; game?: GameProject; gameChat: boolean }) {
  if (game) return <GameAvatar cover={game.cover} gameKey={game.name} className="notify-art" />;
  return (
    <span className="notify-art notify-art-tile" aria-hidden>
      {notice.kind === NoticeKind.SignIn ? (
        <ProviderGlyph engine={notice.engine} />
      ) : (
        <Icon name={artIcon(notice, gameChat)} size={15} />
      )}
    </span>
  );
}

/** A row's end: the action a waiting row asks for, else the dot of a row new since the panel opened. */
function NoticeTrail({ notice, fresh }: { notice: Notice; fresh: boolean }) {
  const action = notice.waiting ? ACTION[notice.kind] : undefined;
  if (action) return <span className="notify-action">{action}</span>;
  if (!fresh) return null;
  return (
    <span className="notify-dot">
      <span className="sr-only">New</span>
    </span>
  );
}

/** One notification: what it is about, when, what it says, and what it asks. */
function NoticeRow({
  notice,
  games,
  threads,
  fresh,
  now,
  onChoose,
}: {
  notice: Notice;
  games: GameProject[];
  threads: ConversationRecord[];
  fresh: boolean;
  now: number;
  onChoose: (notice: Notice) => void;
}): JSX.Element {
  const thread = threads.find((item) => item.id === notice.threadId);
  const project = notice.project ?? threadMeta(thread).project;
  const game = project && notice.kind !== NoticeKind.SignIn ? games.find((item) => item.name === project) : undefined;
  const gameChat = isGameThread(thread);
  return (
    <button
      type="button"
      className="notify-row"
      data-notice={notice.kind}
      data-tone={notice.tone}
      data-fresh={fresh || undefined}
      onClick={() => onChoose(notice)}
    >
      <NoticeArt notice={notice} game={game} gameChat={gameChat} />
      <span className="notify-copy">
        <span className="notify-title">
          <span className="min-w-0 truncate">{noticeSource(notice, game?.title, gameChat)}</span>
          <span className="notify-time">{noticeTime(notice, now)}</span>
        </span>
        <span className="notify-text" title={notice.text}>
          {notice.text}
        </span>
      </span>
      <NoticeTrail notice={notice} fresh={fresh} />
    </button>
  );
}

/** The panel's list: what waits on you, then the news by day, or "all caught up". */
function NoticeList({
  waiting,
  activity,
  row,
}: {
  waiting: Notice[];
  activity: Notice[];
  row: (notice: Notice) => JSX.Element;
}): JSX.Element {
  const groups = useMemo(() => {
    const byDay = new Map<string, Notice[]>();
    for (const item of activity) {
      const day = dayGroup(item.at);
      byDay.set(day, [...(byDay.get(day) ?? []), item]);
    }
    return [...byDay];
  }, [activity]);
  return (
    <div className="notify-list">
      {waiting.length > 0 && (
        <section aria-label="Waiting for you">
          <PickerLabel first>Waiting for you</PickerLabel>
          {waiting.map(row)}
        </section>
      )}
      {groups.map(([day, rows], index) => (
        <section key={day} aria-label={day}>
          <PickerLabel first={index === 0 && !waiting.length}>{day}</PickerLabel>
          {rows.map(row)}
        </section>
      ))}
      {!waiting.length && !activity.length && (
        <div className="notify-empty">
          <p>You’re all caught up</p>
          <p>Questions, plans and finished builds from your games show up here.</p>
        </div>
      )}
    </div>
  );
}

export function NotificationsMenu({ items, games, threads, onOpen, onRead, onClear }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  // The rows that were new when the panel opened keep their dot until it closes.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const now = Date.now();
  const waiting = waitingNotices(items, now);
  const activity = activityNotices(items);
  const unreadItems = activity.filter((item) => !item.read);
  const unread = unreadItems.length;
  const latest = [...waiting, ...unreadItems].reduce((max, item) => (item.id > max ? item.id : max), "");
  const ringing = useRing(latest);

  // Focus returns to the bell when the panel closes; that is not a request for its tooltip.
  const quietUntil = useRef(0);
  const change = (next: boolean) => {
    setOpen(next);
    quietUntil.current = Date.now() + TIP_QUIET_MS;
    if (next) {
      setTip(false);
      setFresh(new Set(unreadItems.map((item) => item.id)));
      onRead();
    } else setFresh(new Set());
  };
  const choose = (notice: Notice) => {
    change(false);
    onOpen(notice);
  };
  const row = (notice: Notice) => (
    <NoticeRow
      key={notice.id}
      notice={notice}
      games={games}
      threads={threads}
      fresh={fresh.has(notice.id)}
      now={now}
      onChoose={choose}
    />
  );

  return (
    <Popover open={open} onOpenChange={change}>
      <Tooltip
        open={tip && !open}
        onOpenChange={(next) => {
          if (!next || Date.now() >= quietUntil.current) setTip(next);
        }}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger
            render={<button type="button" />}
            aria-label={bellLabel(waiting.length, unread)}
            data-open={open || undefined}
            data-announce={ringing || undefined}
            className="hit-24 notify-bell sidebar-icon grid size-ctl shrink-0 place-items-center rounded-sm text-fg-3 transition-[background-color,color] duration-[var(--dur)] ease-out"
          >
            <Icon name="bell" size={16} />
            <span className="notify-badge" data-show={badgeShows(waiting.length, unread)} aria-hidden>
              <span className="notify-badge-mark">{waiting.length ? badgeCount(waiting.length) : null}</span>
            </span>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        aria-label="Notifications"
        onKeyDown={moveBetweenRows}
        className="picker-panel notify-panel flex w-[360px] max-w-(--available-width) flex-col p-1.5"
        style={{ maxHeight: "min(560px, var(--available-height))" }}
      >
        <div className="notify-head">
          <h2>Notifications</h2>
          {activity.length > 0 && (
            <button type="button" className="notify-clear" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
        <NoticeList waiting={waiting} activity={activity} row={row} />
      </PopoverContent>
    </Popover>
  );
}

function ProviderGlyph({ engine }: { engine?: string }): JSX.Element {
  if (engine !== EngineId.ClaudeCode && engine !== EngineId.Codex) return <Icon name="globe" size={15} />;
  const mark = engine === EngineId.Codex ? CODEX_MARK : CLAUDE_CODE_MARK;
  const gradient = `notify-mark-${engine}`;
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      {mark.colors.length > 1 && (
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            {mark.colors.map((color, i) => (
              <stop key={color} offset={i / (mark.colors.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
      )}
      <path fillRule="evenodd" d={mark.path} fill={mark.colors.length > 1 ? `url(#${gradient})` : mark.colors[0]} />
    </svg>
  );
}
