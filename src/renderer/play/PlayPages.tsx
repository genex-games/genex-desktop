/**
 * What Play shows in place of the workspace: the chosen shelf's dashboard, the Friends page,
 * someone's profile, the account's stats or a native game's own page (`PlayState.view`).
 */
import type { JSX } from "react";
import { usePlay } from "../state/hooks.ts";
import { PlayPage } from "../state/play.ts";
import { GamePage } from "./GamePage.tsx";
import { PlayFriends } from "./PlayFriends.tsx";
import { PlayProfile } from "./PlayProfile.tsx";
import { PlayRoom } from "./PlayRoom.tsx";
import { PlayStats } from "./PlayStats.tsx";

/** Play's page for the view the sidebar and the people pages chose. */
export function PlayPages({
  chrome,
  onNewGame,
}: {
  /** The shell's chrome: whether the sidebar is hidden, and its toggle. */
  chrome: { sidebarHidden: boolean; toggleSidebar: () => void };
  /** Start a new game: Create's home, its composer ready. */
  onNewGame: () => void;
}): JSX.Element {
  const { sidebarHidden, toggleSidebar: onToggleSidebar } = chrome;
  const view = usePlay((s) => s.view);
  if (view.page === PlayPage.Friends)
    return <PlayFriends sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar} />;
  if (view.page === PlayPage.Game)
    return (
      <GamePage key={view.slug} slug={view.slug} sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar} />
    );
  if (view.page === PlayPage.Stats)
    return <PlayStats sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar} onNewGame={onNewGame} />;
  if (view.page === PlayPage.Profile)
    return (
      <PlayProfile
        key={view.userId}
        userId={view.userId}
        sidebarHidden={sidebarHidden}
        onToggleSidebar={onToggleSidebar}
        onNewGame={onNewGame}
      />
    );
  return <PlayRoom sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar} />;
}
