/**
 * The Players fact on a game's page. For the owner of a game with no web build (an Unreal, Unity or
 * Godot app tells genex.games nothing about its players) the value is a menu: Single player or
 * Multiplayer, shown at the press and saved at once, back as it was with a toast if genex.games
 * refused. Everyone else, and every game with a web build (whose build says), reads plain words.
 */
import type { JSX } from "react";
import { useState } from "react";
import { ownsPlayGame, PlayChangeKind } from "../../shared/play-manage.ts";
import type { PlayGameDetail } from "../../shared/play.ts";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { NATIVE_WORDS, PLAY_CARD_MENU_WORDS } from "../words.ts";

/** The menu's two values, as Radix names a radio item. */
const Players = { Single: "single", Multi: "multi" } as const;
type Players = (typeof Players)[keyof typeof Players];

/** Whether the viewer may set the game's Players: they made it, and no web build says it. */
function useChoosesPlayers(game: PlayGameDetail): boolean {
  const accountId = usePeople((s) => s.me?.id ?? null);
  const own = ownsPlayGame(game, accountId ? { accountId, isAdmin: false } : null);
  return own && game.native !== undefined && !game.native.web;
}

/** The fact's words for `multiplayer`. */
const playersWords = (multiplayer: boolean): string =>
  multiplayer ? NATIVE_WORDS.multiplayer : NATIVE_WORDS.singlePlayer;

/** The Players value: a menu for the game's owner, else its words. */
export function PlayersValue({ game }: { game: PlayGameDetail }): JSX.Element {
  const chooses = useChoosesPlayers(game);
  // What the owner just picked, shown until genex.games answers (the page then reads it back).
  const [picked, setPicked] = useState<boolean | null>(null);
  const multiplayer = picked ?? game.multiplayer;
  if (!chooses) return <span className="game-fact-value">{playersWords(game.multiplayer)}</span>;
  const choose = (next: boolean) => {
    if (next === multiplayer) return;
    setPicked(next);
    studio()
      .play.manage(game, { kind: PlayChangeKind.Players, multiplayer: next })
      .catch(() => studio().notify(PLAY_CARD_MENU_WORDS.players.failed, ToastTone.Error))
      .finally(() => setPicked(null));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="game-fact-value game-fact-choice"
          data-game-players-choice={multiplayer ? Players.Multi : Players.Single}
          aria-label={`${PLAY_CARD_MENU_WORDS.players.label}: ${playersWords(multiplayer)}`}
        >
          <span>{playersWords(multiplayer)}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-48">
        <DropdownMenuRadioGroup
          value={multiplayer ? Players.Multi : Players.Single}
          onValueChange={(value) => choose(value === Players.Multi)}
        >
          <DropdownMenuRadioItem value={Players.Single}>{NATIVE_WORDS.singlePlayer}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value={Players.Multi}>{NATIVE_WORDS.multiplayer}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
