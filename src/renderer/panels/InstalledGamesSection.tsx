/**
 * Settings → Storage's games from Play (canvas board "Storage"): every game installed on this Mac
 * with its picture, when it was last played, the space it takes and Remove, under their count and
 * total. Removing keeps a game's saves. Not a kind "Free up" deletes: a game is removed one at a time.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import type { InstalledGame } from "../../shared/play-native.ts";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { INSTALLED_GAMES_WORDS, NATIVE_WORDS } from "../words.ts";

const WORDS = INSTALLED_GAMES_WORDS;

/** One installed game. */
function InstalledRow({ game, now }: { game: InstalledGame; now: number }): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    setRemoving(true);
    try {
      await studio().play.uninstall(game.slug);
      studio().notify(NATIVE_WORDS.removed(game.title), ToastTone.Ok);
    } catch {
      studio().notify(NATIVE_WORDS.removeFailed, ToastTone.Error);
      setRemoving(false);
    }
  };
  return (
    <li
      data-installed-game={game.slug}
      className="settings-list-row flex min-h-13 min-w-0 items-center gap-3 px-3 py-1.5"
    >
      <span className="installed-game-thumb" aria-hidden="true">
        {game.coverUrl && <img src={game.coverUrl} alt="" draggable={false} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-ink">{game.title}</span>
        <span className="truncate font-mono text-xs text-ink-3">{WORDS.played(game.lastPlayedAt, now)}</span>
      </span>
      <span className="shrink-0 font-mono text-xs text-ink-3">{sizeWords(game.bytes)}</span>
      <Button variant="secondary" busy={removing} data-installed-remove={game.slug} onClick={() => void remove()}>
        {WORDS.remove}
      </Button>
    </li>
  );
}

/** The games installed from Play, or nothing where none are (or Genex installs none here). */
export function InstalledGamesSection(): JSX.Element | null {
  const installs = usePlay((s) => s.installs);
  useEffect(() => {
    void studio().play.loadNative();
  }, []);
  const games = installs.installed;
  if (games.length === 0) return null;
  const total = games.reduce((sum, game) => sum + game.bytes, 0);
  const now = Date.now();
  return (
    <section aria-label={WORDS.title} data-installed-games className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h3 className="settings-card-title">{WORDS.title}</h3>
        <span className="font-mono text-xs text-ink-3">{WORDS.total(games.length, sizeWords(total))}</span>
      </div>
      <ul data-list className="settings-card">
        {games.map((game) => (
          <InstalledRow key={game.slug} game={game} now={now} />
        ))}
      </ul>
      <p className="px-1 text-ink-3">{WORDS.savesStay}</p>
    </section>
  );
}
