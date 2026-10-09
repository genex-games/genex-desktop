/** One game, one row. The chrome and navigation stay put; only the game list scrolls. */
import type { ComponentPropsWithRef, JSX, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type ReadyUpdate, UpdateAction } from "../../shared/app-update.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { FEEDBACK_WORDS, statusWords, UPDATE_WORDS } from "../words.ts";
import type { ConversationRecord, GameProject, ThreadMeta } from "../types.ts";
import { Dot, IconButton } from "../ui/kit.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { GenexLogo } from "../ui/GenexLogo.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { Shortcut } from "../ui/Shortcut.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.tsx";
import { NotificationsMenu } from "./NotificationsMenu.tsx";
import type { Notice } from "../notifications.ts";
import type { LaunchInSidebar } from "../state/launch.ts";
import { sidebarGames } from "../state/threads.ts";

interface Props {
  threads: ConversationRecord[];
  games: GameProject[];
  activeThreadId: string | null;
  activeProject: string | null;
  /** Home is open: nothing is selected, and the wordmark is where it is. */
  atHome: boolean;
  onHome: () => void;
  /** A game home is starting: a placeholder row until it is made, then its own row, selected and working. */
  launching: LaunchInSidebar;
  building: ReadonlySet<string>;
  busyThreads: ReadonlySet<string>;
  threadStatus: Record<string, { status: string; since: number }>;
  onSearch: () => void;
  notices: Notice[];
  onOpenNotice: (notice: Notice) => void;
  onReadNotices: () => void;
  onClearNotices: () => void;
  onToggle: () => void;
  /** Open Send feedback, from the bug button at the far end of the top line. */
  onFeedback: () => void;
  onSettings: () => void;
  pluginsOpen: boolean;
  onPlugins: () => void;
  stagedCount: number;
  onNewGame: () => void;
  onSelectThread: (threadId: string) => void;
  onSelectGame: (project: string) => void;
  onRenameGame: (game: GameProject) => void;
  onPinGame: (game: GameProject) => void;
  onDeleteGame: (game: GameProject) => void;
  onChangeCover: (game: GameProject) => void;
  /** A new version of the app waiting for a restart or a download, or null. */
  update: ReadyUpdate | null;
  /** Quit and relaunch into it; false when main did not (the person kept a run going). */
  onRestartToUpdate: () => Promise<boolean>;
  /** Open the waiting release's download page (Linux). */
  onDownloadUpdate: () => void;
}
const meta = (thread: ConversationRecord) => (thread.metadata ?? {}) as ThreadMeta;

/** A tooltip that carries a shortcut chip, opening beside the sidebar (or above a control at its foot). */
function Hint({
  label,
  shortcut,
  side = "right",
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "right" | "top";
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut && <Shortcut>{shortcut}</Shortcut>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** How long after the last scroll the list's scrollbar stays shown. */
const SCROLL_SETTLE_MS = 800;

/** The games in the sidebar's order (`sidebarGames`). */
function useSortedGames(games: GameProject[], threads: ConversationRecord[]): GameProject[] {
  return useMemo(() => sidebarGames(games, threads), [games, threads]);
}

/**
 * The list's scroll state. The scrollbar shows while the sidebar is hovered or scrolling; the
 * fade shows once the list has moved.
 */
function useScrollState(nav: RefObject<HTMLElement | null>) {
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => () => clearTimeout(settle.current), []);
  const onScroll = (list: HTMLElement) => {
    setScrolled(list.scrollTop > 0);
    nav.current?.setAttribute("data-scrolling", "true");
    clearTimeout(settle.current);
    settle.current = setTimeout(() => nav.current?.removeAttribute("data-scrolling"), SCROLL_SETTLE_MS);
  };
  return { scrolled, onScroll };
}

export function Sidebar(props: Props): JSX.Element {
  const { threads, games, activeThreadId } = props;
  const studio = threads.find((thread) => meta(thread).kind !== ThreadKind.Game);
  const harnessOpen = !!studio && studio.id === activeThreadId;
  const nav = useRef<HTMLElement>(null);
  const { scrolled, onScroll } = useScrollState(nav);
  const sorted = useSortedGames(games, threads);
  return (
    <nav
      ref={nav}
      data-pane="rail"
      id="studio-sidebar"
      aria-label="Main navigation"
      className="game-sidebar"
      data-scrolled={scrolled}
    >
      <SidebarTop {...props} studio={studio} harnessOpen={harnessOpen} />
      <div className="sidebar-list">
        <div className="sidebar-scroll" data-sidebar-scroll onScroll={(event) => onScroll(event.currentTarget)}>
          <div className="sidebar-games">
            {sorted.map((game, index) => (
              <Fragment key={game.name}>
                {props.launching.placeholder && index === firstUnpinned(sorted) ? (
                  <LaunchRow title={props.launching.title} />
                ) : null}
                <SidebarGame {...props} game={game} harnessOpen={harnessOpen} />
              </Fragment>
            ))}
            {props.launching.placeholder && firstUnpinned(sorted) === sorted.length ? (
              <LaunchRow title={props.launching.title} />
            ) : null}
          </div>
        </div>
        <span className="sidebar-fade" aria-hidden="true" />
        {props.update?.action === UpdateAction.Download && (
          <SidebarDownload update={props.update} onDownload={props.onDownloadUpdate} />
        )}
        {props.update?.action === UpdateAction.Restart && (
          <SidebarUpdate update={props.update} onRestart={props.onRestartToUpdate} />
        )}
      </div>
    </nav>
  );
}

/** Where a new game's row goes: after the pinned ones. */
const firstUnpinned = (sorted: GameProject[]): number => {
  const index = sorted.findIndex((game) => !game.pinned);
  return index === -1 ? sorted.length : index;
};

/** The game home is starting, selected and working, until it is made and has its own row. */
function LaunchRow({ title }: { title: string | null }): JSX.Element {
  return (
    <div className="sidebar-game" data-launching data-active="true" data-busy="true">
      <div className="sidebar-game-select" aria-current="page">
        <span className="game-avatar game-avatar-pending" aria-hidden="true" />
        <span className={`min-w-0 flex-1 truncate ${title ? "" : "text-ink-3"}`}>{title ?? "Naming…"}</span>
        <span className="sr-only">Working</span>
      </div>
      <GameRowEnd busy pinned={false} />
    </div>
  );
}

/** Relaunch to update, over the foot of the game list while a downloaded version waits. */
function SidebarUpdate({ update, onRestart }: { update: ReadyUpdate; onRestart: () => Promise<boolean> }): JSX.Element {
  const [restarting, setRestarting] = useState(false);
  const restart = (): void => {
    setRestarting(true);
    // On a yes main quits; a kept run leaves the row to try again.
    void onRestart().then((quitting) => {
      if (!quitting) setRestarting(false);
    });
  };
  return (
    <div className="sidebar-footer">
      <Hint label={UPDATE_WORDS.hint(update.version)} side="top">
        <button
          type="button"
          className="sidebar-update"
          data-update-restart
          aria-busy={restarting}
          disabled={restarting}
          onClick={restart}
        >
          <span>{restarting ? UPDATE_WORDS.restarting : UPDATE_WORDS.restart}</span>
          <Icon name="reload" size={16} />
        </button>
      </Hint>
    </div>
  );
}

/** Download Genex X, over the foot of the game list while a release Linux installs by hand waits. */
function SidebarDownload({ update, onDownload }: { update: ReadyUpdate; onDownload: () => void }): JSX.Element {
  return (
    <div className="sidebar-footer">
      <Hint label={UPDATE_WORDS.downloadHint} side="top">
        <button type="button" className="sidebar-update" data-update-download onClick={onDownload}>
          <span>{UPDATE_WORDS.download(update.version)}</span>
          <Icon name="arrow-up-right" size={16} />
        </button>
      </Hint>
    </div>
  );
}

/** A game's row, open on its primary (else first) chat; busy while it builds or a chat works. */
function SidebarGame({
  game,
  threads,
  building,
  busyThreads,
  activeProject,
  launching,
  harnessOpen,
  onSelectGame,
  onRenameGame,
  onPinGame,
  onDeleteGame,
  onChangeCover,
}: Props & { game: GameProject; harnessOpen: boolean }): JSX.Element {
  const chats = threads.filter((thread) => meta(thread).project === game.name && !meta(thread).archived);
  const thread = chats.find((chat) => chat.id === game.primaryThreadId) ?? chats[0];
  // The game home is launching keeps its placeholder's look: selected and working.
  const launched = launching.project === game.name;
  const busy = launched || building.has(game.name) || chats.some((chat) => busyThreads.has(chat.id));
  const active = launched || activeProject === game.name;
  return (
    <GameRow
      game={game}
      threadId={thread?.id}
      active={active && !harnessOpen}
      busy={busy}
      onSelect={() => onSelectGame(game.name)}
      onRename={() => onRenameGame(game)}
      onPin={() => onPinGame(game)}
      onDelete={() => onDeleteGame(game)}
      onCover={() => onChangeCover(game)}
    />
  );
}

/**
 * The fixed top: the toggle and Send feedback, the brand with search and notifications, the rooms,
 * the games heading.
 */
function SidebarTop({
  studio,
  harnessOpen,
  games,
  threads,
  busyThreads,
  threadStatus,
  onSearch,
  notices,
  onOpenNotice,
  onReadNotices,
  onClearNotices,
  onToggle,
  onFeedback,
  onSettings,
  pluginsOpen,
  onPlugins,
  stagedCount,
  onNewGame,
  onSelectThread,
  atHome,
  onHome,
}: Props & { studio: ConversationRecord | undefined; harnessOpen: boolean }): JSX.Element {
  const studioStatus = studio ? threadStatus[studio.id]?.status : undefined;
  const studioBusy = Boolean(studio && busyThreads.has(studio.id));
  return (
    <div className="sidebar-fixed">
      <div className="titlebar-drag sidebar-titlebar">
        <Hint label="Hide sidebar" shortcut="⌘B">
          <button
            type="button"
            className="no-drag sidebar-toggle"
            aria-label="Hide sidebar"
            aria-controls="studio-sidebar"
            aria-expanded="true"
            onClick={onToggle}
          >
            <Icon name="sidebar" />
          </button>
        </Hint>
        <Hint label={FEEDBACK_WORDS.title}>
          <button
            type="button"
            className="no-drag sidebar-toggle sidebar-feedback"
            data-feedback-open
            aria-label={FEEDBACK_WORDS.title}
            aria-haspopup="dialog"
            onClick={onFeedback}
          >
            <Icon name="bug" />
          </button>
        </Hint>
      </div>
      <div className="sidebar-brand-row">
        <button
          type="button"
          className="sidebar-home"
          aria-label="Home"
          aria-current={atHome ? "page" : undefined}
          onClick={onHome}
        >
          <GenexLogo className="brand sidebar-wordmark" />
        </button>
        <div className="sidebar-brand-actions">
          <IconButton
            icon="search"
            label="Search games"
            title="Search games · ⌘K"
            className="sidebar-icon"
            onClick={onSearch}
          />
          <NotificationsMenu
            items={notices}
            games={games}
            threads={threads}
            onOpen={onOpenNotice}
            onRead={onReadNotices}
            onClear={onClearNotices}
          />
        </div>
      </div>
      <div className="sidebar-nav">
        <Hint label="New game" shortcut="⌘N">
          <NavRow icon="new-game" aria-keyshortcuts="Meta+N Control+N" onClick={onNewGame}>
            New game
          </NavRow>
        </Hint>
        <NavRow icon="plugins" aria-label="Plugins" current={pluginsOpen} onClick={onPlugins}>
          Plugins
        </NavRow>
        {studio && (
          <Hint label="Harness" shortcut="⌘2">
            <NavRow
              icon="harness"
              data-thread="studio"
              current={harnessOpen}
              busy={studioBusy}
              onClick={() => onSelectThread(studio.id)}
            >
              <span className="min-w-0 flex-1 truncate">Harness</span>
              {stagedCount > 0 && (
                <span className="sidebar-badge" aria-label={`${stagedCount} skill improvements to review`}>
                  {stagedCount}
                </span>
              )}
              {studioBusy && studioStatus && <span className="sr-only">{statusWords(studioStatus).short}</span>}
            </NavRow>
          </Hint>
        )}
        <NavRow icon="settings" aria-label="Settings" aria-haspopup="dialog" onClick={onSettings}>
          Settings
        </NavRow>
      </div>
      <div className="sidebar-games-heading">
        <span>Games</span>
        <IconButton
          icon="plus"
          label="Create game"
          title="Create game · ⌘N"
          className="sidebar-icon"
          onClick={onNewGame}
        />
      </div>
    </div>
  );
}

/** New game, Plugins, Harness and Settings: one stack of equal rows. */
function NavRow({
  icon,
  current = false,
  busy = false,
  children,
  ...rest
}: {
  icon: IconName;
  current?: boolean;
  busy?: boolean;
  children: ReactNode;
} & ComponentPropsWithRef<"button"> &
  Record<`data-${string}`, string>): JSX.Element {
  // Tooltip triggers pass their ref and handlers through `rest`.
  return (
    <button type="button" className="sidebar-action" aria-current={current ? "page" : undefined} {...rest}>
      {busy ? <Dot tone="busy" /> : <Icon name={icon} size={18} />}
      {typeof children === "string" ? <span>{children}</span> : children}
    </button>
  );
}

/** The end of a game row: the working dot while it works, else the pin when pinned. */
function GameRowEnd({ busy, pinned }: { busy: boolean; pinned: boolean | undefined }) {
  if (busy) {
    return (
      <span className="sidebar-game-status" aria-hidden="true">
        <Dot tone="busy" />
      </span>
    );
  }
  if (!pinned) return null;
  return (
    <span className="sidebar-pin" aria-label="Pinned">
      <Icon name="pin" size={13} />
    </span>
  );
}

function GameRow({
  game,
  threadId,
  active,
  busy,
  onSelect,
  onRename,
  onPin,
  onDelete,
  onCover,
}: {
  game: GameProject;
  threadId?: string;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
  onCover: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The row's end is one slot: the working dot, else the pin — and ⋯ in their place on hover.
  return (
    <div className="sidebar-game" data-game={game.name} data-active={active} data-busy={busy} data-menu-open={open}>
      <button
        type="button"
        data-project={game.name}
        data-thread={threadId}
        aria-current={active ? "page" : undefined}
        title={game.pathLabel}
        className="sidebar-game-select"
        onClick={onSelect}
      >
        <GameAvatar cover={game.cover} active={active} gameKey={game.name} />
        <span className="min-w-0 flex-1 truncate">{game.title}</span>
        {busy && <span className="sr-only">Working</span>}
      </button>
      <GameRowEnd busy={busy} pinned={game.pinned} />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button type="button" className="sidebar-game-menu" aria-label={`Actions for ${game.title}`}>
                <Icon name="more" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Game actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="right" className="w-48">
          <DropdownMenuItem data-game-action="rename" onSelect={onRename}>
            <Icon name="rename" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem data-game-action="pin" onSelect={onPin}>
            <Icon name="pin" />
            {game.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem data-game-action="cover" onSelect={onCover}>
            <Icon name="image" />
            Change image…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-game-action="delete" disabled={busy} onSelect={onDelete} className="text-red">
            <Icon name="trash" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
