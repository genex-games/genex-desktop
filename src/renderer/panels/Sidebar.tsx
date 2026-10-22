/**
 * One game, one row. The chrome and navigation stay put; the game list scrolls, and under it the
 * friends scroll on their own.
 */
import type { ComponentPropsWithRef, CSSProperties, JSX, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type ReadyUpdate, UpdateAction } from "../../shared/app-update.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { FEEDBACK_WORDS, statusWords, UPDATE_WORDS } from "../words.ts";
import type { ConversationRecord, GameProject, ThreadMeta } from "../types.ts";
import { Dot, IconButton } from "../ui/kit.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { GenexLogo } from "../ui/GenexLogo.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { projectKindLabel } from "../project-kind.ts";
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
import { SidebarPluginUpdates } from "./SidebarPluginUpdates.tsx";
import { GenexTermsLine } from "./plugins/genex/GenexTermsLine.tsx";
import { AgentsStartLine } from "./AgentsStartLine.tsx";
import type { PluginUpdate } from "../state/plugins.ts";
import type { Notice } from "../notifications.ts";
import type { LaunchInSidebar } from "../state/launch.ts";
import { sidebarGames } from "../state/threads.ts";
import { PLAY_SHELVES, PlayShelf } from "../../shared/play.ts";
import { formatCount } from "../play/play-model.ts";
import { PlayPromo } from "../play/PlayPromo.tsx";
import { ProfilePlate } from "../play/ProfilePlate.tsx";
import { usePeopleSync } from "../play/use-people-sync.ts";
import { PlayRecent } from "../play/PlayRecent.tsx";
import { PlaySwitch } from "../play/PlaySwitch.tsx";
import { SidebarFriends } from "../play/SidebarFriends.tsx";
import { useAgentsStart, usePeople, usePlay, useShallow } from "../state/hooks.ts";
import { PlayPage } from "../state/play.ts";
import { besideRemix, remixCovers, remixShare } from "../play/remix-model.ts";
import { remixTitle } from "../../shared/play.ts";
import { studio as studioApp } from "../state/studio.ts";
import { PLAY_WORDS } from "../words.ts";
import { t } from "../../shared/i18n.ts";
import { SidebarToggle } from "../shell/use-shell-chrome.ts";

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
  /** Play is up: the rooms fold away and the list is the games played last. */
  playOpen: boolean;
  /** Play or Create, from the switch under the wordmark. */
  onPlayMode: (play: boolean) => void;
  stagedCount: number;
  onNewGame: () => void;
  onSelectThread: (threadId: string) => void;
  onSelectGame: (project: string) => void;
  /** Back to the Play remix being made, from its row. */
  onShowRemix: () => void;
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
  /** The plugin updates waiting to be installed (`pluginUpdates`). */
  pluginUpdates: readonly PluginUpdate[];
  /** Update plugins is installing them. */
  updatingPlugins: boolean;
  /** Install every waiting plugin update but the unticked ones (`updateKey`), one after another. */
  onUpdatePlugins: (skipped: ReadonlySet<string>) => void;
  /** Open Plugins at one plugin's page. */
  onOpenPlugin: (id: string) => void;
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
function useSortedGames(games: readonly GameProject[], threads: ConversationRecord[]): GameProject[] {
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
  // Only the adopted name: the remix's steps and bytes are its row's to follow, not the whole list's.
  const adopted = usePlay((s) => s.making?.name ?? null);
  const listed = useMemo(() => besideRemix(games, adopted), [games, adopted]);
  const sorted = useSortedGames(listed, threads);
  const pending = (
    <>
      <RemixRow onShow={props.onShowRemix} />
      <PendingLaunch launching={props.launching} />
    </>
  );
  const { playOpen } = props;
  usePeopleSync();
  return (
    <nav
      ref={nav}
      data-pane="rail"
      id="studio-sidebar"
      aria-label={t("Main navigation")}
      className="game-sidebar"
      data-scrolled={scrolled}
      data-play={playOpen}
    >
      <SidebarTop {...props} studio={studio} harnessOpen={harnessOpen} />
      <div className="sidebar-list">
        <div className="sidebar-lists">
          <div
            className="sidebar-scroll play-recent-scroll"
            data-off={!playOpen}
            inert={!playOpen}
            onScroll={(event) => onScroll(event.currentTarget)}
          >
            <PlayRecent />
          </div>
          <div
            className="sidebar-scroll"
            data-sidebar-scroll
            data-off={playOpen}
            inert={playOpen}
            onScroll={(event) => onScroll(event.currentTarget)}
          >
            <div className="sidebar-games">
              {sorted.map((game, index) => (
                <Fragment key={game.name}>
                  {index === firstUnpinned(sorted) ? pending : null}
                  <SidebarGame {...props} game={game} harnessOpen={harnessOpen} />
                </Fragment>
              ))}
              {firstUnpinned(sorted) === sorted.length ? pending : null}
            </div>
          </div>
          <span className="sidebar-fade" aria-hidden="true" />
        </div>
        <SidebarFriends onPlayMode={props.onPlayMode} />
        <SidebarFooter {...props} />
      </div>
      {/* Shown once, until the first sign-in: the account plate stays under it. */}
      {playOpen && <PlayPromo />}
      <ProfilePlate onPlayMode={props.onPlayMode} />
    </nav>
  );
}

/** Where a new game's row goes: after the pinned ones. */
const firstUnpinned = (sorted: GameProject[]): number => {
  const index = sorted.findIndex((game) => !game.pinned);
  return index === -1 ? sorted.length : index;
};

/** The game home is starting, until it is made and has its own row; nothing when there is none. */
function PendingLaunch({ launching }: { launching: LaunchInSidebar }): JSX.Element | null {
  return launching.placeholder ? <LaunchRow title={launching.title} /> : null;
}

/**
 * A Play remix being made, working: the cover it copies inside a ring that fills as it is made.
 * Selected while Create shows it; pressed, it comes back. Its game, once adopted, waits off the
 * list for it.
 */
function RemixRow({ onShow }: { onShow: () => void }): JSX.Element | null {
  const making = usePlay((s) => s.making);
  if (!making) return null;
  const shown = remixCovers(making);
  const share = { "--remix-share": remixShare(making) } as CSSProperties;
  return (
    <div className="sidebar-game" data-remixing={making.step} data-active={shown} data-busy="true">
      <button type="button" className="sidebar-game-select" aria-current={shown ? "page" : undefined} onClick={onShow}>
        <span className="remix-avatar" style={share} aria-hidden="true">
          {making.coverUrl ? <img src={making.coverUrl} alt="" /> : <span />}
        </span>
        <span className="min-w-0 flex-1 truncate">{remixTitle(making.title)}</span>
        <span className="sr-only">{PLAY_WORDS.making.row}</span>
      </button>
      <GameRowEnd busy pinned={false} />
    </div>
  );
}

/** The game home is starting, selected and working, until it is made and has its own row. */
function LaunchRow({ title }: { title: string | null }): JSX.Element {
  return (
    <div className="sidebar-game" data-launching data-active="true" data-busy="true">
      <div className="sidebar-game-select" aria-current="page">
        <span className="game-avatar game-avatar-pending" aria-hidden="true" />
        <span className={`min-w-0 flex-1 truncate ${title ? "" : "text-ink-3"}`}>{title ?? t("Naming…")}</span>
        <span className="sr-only">{t("Working")}</span>
      </div>
      <GameRowEnd busy pinned={false} />
    </div>
  );
}

/**
 * What waits for the person, over the foot of the game list: agents that didn't start, Genex's
 * updated terms to review, the plugin updates line, then the app's own Relaunch to update or Download.
 */
function SidebarFooter({
  update,
  onRestartToUpdate,
  onDownloadUpdate,
  pluginUpdates,
  updatingPlugins,
  onUpdatePlugins,
  onPlugins,
  onOpenPlugin,
}: Props): JSX.Element | null {
  const pluginsWait = pluginUpdates.length > 0 || updatingPlugins;
  const genexTerms = usePeople((s) => s.genexTermsPending);
  const agentsFailed = useAgentsStart((s) => s.failure !== null);
  const waiting = Boolean(update) || pluginsWait || genexTerms || agentsFailed;
  if (!waiting) return null;
  return (
    <div className="sidebar-footer">
      <AgentsStartLine />
      <GenexTermsLine />
      {pluginsWait && (
        <SidebarPluginUpdates
          updates={pluginUpdates}
          updating={updatingPlugins}
          onUpdate={onUpdatePlugins}
          onOpenPlugins={onPlugins}
          onOpenPlugin={onOpenPlugin}
        />
      )}
      {update?.action === UpdateAction.Download && <SidebarDownload update={update} onDownload={onDownloadUpdate} />}
      {update?.action === UpdateAction.Restart && <SidebarUpdate update={update} onRestart={onRestartToUpdate} />}
    </div>
  );
}

/** Relaunch to update, while a downloaded version waits. */
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
  );
}

/** Download Genex X, while a release Linux installs by hand waits. */
function SidebarDownload({ update, onDownload }: { update: ReadyUpdate; onDownload: () => void }): JSX.Element {
  return (
    <Hint label={UPDATE_WORDS.downloadHint} side="top">
      <button type="button" className="sidebar-update" data-update-download onClick={onDownload}>
        <span>{UPDATE_WORDS.download(update.version)}</span>
        <Icon name="arrow-up-right" size={16} />
      </button>
    </Hint>
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
 * The fixed top: the toggle with search, notifications and Send feedback; the brand with the Play /
 * Create switch; the rooms in Create or the shelves in Play; the games or Recent heading.
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
  playOpen,
  onPlayMode,
}: Props & { studio: ConversationRecord | undefined; harnessOpen: boolean }): JSX.Element {
  const studioStatus = studio ? threadStatus[studio.id]?.status : undefined;
  const studioBusy = Boolean(studio && busyThreads.has(studio.id));
  const hasRecent = usePlay((s) => s.recent.length > 0);
  return (
    <div className="sidebar-fixed">
      <div className="titlebar-drag sidebar-titlebar">
        <Hint label={t("Hide sidebar")} shortcut="⌘B">
          <button
            type="button"
            className="no-drag sidebar-toggle"
            data-sidebar-toggle={SidebarToggle.Hide}
            aria-label={t("Hide sidebar")}
            aria-controls="studio-sidebar"
            aria-expanded="true"
            onClick={onToggle}
          >
            <Icon name="sidebar" />
          </button>
        </Hint>
        <div className="no-drag sidebar-brand-actions">
          <IconButton
            icon="search"
            label={t("Search games")}
            title={t("Search games · {shortcut}", { shortcut: "⌘K" })}
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
          <Hint label={FEEDBACK_WORDS.title}>
            <button
              type="button"
              className="sidebar-toggle sidebar-feedback"
              data-feedback-open
              aria-label={FEEDBACK_WORDS.title}
              aria-haspopup="dialog"
              onClick={onFeedback}
            >
              <Icon name="bug" />
            </button>
          </Hint>
        </div>
      </div>
      <div className="sidebar-brand-row">
        <button
          type="button"
          className="sidebar-home"
          aria-label={t("Home")}
          aria-current={atHome && !playOpen ? "page" : undefined}
          onClick={onHome}
        >
          <GenexLogo className="brand sidebar-wordmark" />
        </button>
        <PlaySwitch playing={playOpen} onChange={onPlayMode} />
      </div>
      <div className="sidebar-fold" data-folded={!playOpen} inert={!playOpen}>
        <PlayShelfRows />
      </div>
      <div className="sidebar-fold" data-folded={playOpen} inert={playOpen}>
        <div className="sidebar-nav">
          <Hint label={t("New game")} shortcut="⌘N">
            <NavRow icon="new-game" aria-keyshortcuts="Meta+N Control+N" onClick={onNewGame}>
              {t("New game")}
            </NavRow>
          </Hint>
          <NavRow icon="plugins" aria-label={t("Plugins")} current={pluginsOpen} onClick={onPlugins}>
            {t("Plugins")}
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
                  <span
                    className="sidebar-badge"
                    aria-label={t(
                      "{count, plural, one {# skill improvement to review} other {# skill improvements to review}}",
                      { count: stagedCount },
                    )}
                  >
                    {stagedCount}
                  </span>
                )}
                {studioBusy && studioStatus && <span className="sr-only">{statusWords(studioStatus).short}</span>}
              </NavRow>
            </Hint>
          )}
        </div>
      </div>
      {/* Settings is in both Create and Play: under whichever rows are up. */}
      <div className="sidebar-nav sidebar-nav-shared">
        <NavRow icon="settings" aria-label={t("Settings")} aria-haspopup="dialog" onClick={onSettings}>
          {t("Settings")}
        </NavRow>
      </div>
      {playOpen ? (
        // Nothing played yet, nothing to head: Recent appears with the first game played.
        hasRecent && (
          <div className="sidebar-games-heading" key="recent">
            <span>{PLAY_WORDS.recent}</span>
          </div>
        )
      ) : (
        <div className="sidebar-games-heading" key="games">
          <span>{t("Games")}</span>
          <IconButton
            icon="plus"
            label={t("Create game")}
            title={`${t("Create game")} · ⌘N`}
            className="sidebar-icon"
            onClick={onNewGame}
          />
        </div>
      )}
    </div>
  );
}

/** Each shelf's glyph in Play's sidebar. */
const SHELF_ICONS = {
  [PlayShelf.Games]: "gamepad",
  [PlayShelf.Tools]: "wrench",
  [PlayShelf.Assets]: "box",
} as const satisfies Record<PlayShelf, IconName>;

/**
 * Play's shelves in the rooms' place: Games, Tools and Assets, each with its count, as genex.games
 * lists them. Friends are under the games (`SidebarFriends`), not a row here.
 */
function PlayShelfRows(): JSX.Element {
  const onShelf = usePlay((s) => s.view.page === PlayPage.Shelf);
  const shown = usePlay((s) => s.shelf);
  const counts = usePlay(useShallow((s) => s.counts));
  return (
    <div className="sidebar-nav" role="group" aria-label={PLAY_WORDS.shelvesLabel}>
      {PLAY_SHELVES.map((shelf) => {
        const count = counts[shelf];
        return (
          <NavRow
            key={shelf}
            icon={SHELF_ICONS[shelf]}
            current={onShelf && shelf === shown}
            data-play-shelf={shelf}
            onClick={() => studioApp().play.chooseShelf(shelf)}
          >
            <span className="min-w-0 flex-1 truncate">{PLAY_WORDS.shelves[shelf]}</span>
            {count !== null && <span className="sidebar-count">{formatCount(count)}</span>}
          </NavRow>
        );
      })}
    </div>
  );
}

/** New game, Plugins, Harness (or Play's shelves) and Settings: one stack of equal rows. */
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
    <span className="sidebar-pin" aria-label={t("Pinned")}>
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
  // A project that isn't a game says what it is beside its name.
  const kind = projectKindLabel(game);
  // The row's end is one slot: the working dot, else the pin — and ⋯ in their place on hover.
  return (
    <div className="sidebar-game" data-game={game.name} data-active={active} data-busy={busy} data-menu-open={open}>
      <button
        type="button"
        data-project={game.name}
        data-thread={threadId}
        aria-current={active ? "page" : undefined}
        title={kind ? `${game.pathLabel} · ${kind}` : game.pathLabel}
        className="sidebar-game-select"
        onClick={onSelect}
      >
        <GameAvatar cover={game.cover} active={active} gameKey={game.name} />
        {/* The kind label keeps its words: the name shortens first, down to its first letters, and only a
            row narrower than that shortens the label too. */}
        <span className="min-w-8 flex-1 truncate">{game.title}</span>
        {kind && <span className="ms-1.5 min-w-0 truncate text-ink-3">{kind}</span>}
        {busy && <span className="sr-only">{t("Working")}</span>}
      </button>
      <GameRowEnd busy={busy} pinned={game.pinned} />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sidebar-game-menu"
                aria-label={t("Actions for {game}", { game: game.title })}
              >
                <Icon name="more" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{t("Game actions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="right" className="w-48">
          <DropdownMenuItem data-game-action="rename" onSelect={onRename}>
            <Icon name="rename" />
            {t("Rename")}
          </DropdownMenuItem>
          <DropdownMenuItem data-game-action="pin" onSelect={onPin}>
            <Icon name="pin" />
            {game.pinned ? t("Unpin") : t("Pin")}
          </DropdownMenuItem>
          <DropdownMenuItem data-game-action="cover" onSelect={onCover}>
            <Icon name="image" />
            {t("Change image…")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-game-action="delete" disabled={busy} onSelect={onDelete} className="text-red">
            <Icon name="trash" />
            {t("Delete…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
