/** Play's sidebar list: the games last opened, newest first, each one press from playing again. */
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { NoCover } from "./NoCover.tsx";
import type { PlayRecentEntry } from "./play-model.ts";

/**
 * A game's small cover, a rectangle so Play's rows read apart from Create's round game pictures: its
 * cover, or the no-cover drawing while it has none or it fails to load (then `onMissing` hears of it).
 */
export function PlayThumb({ src, onMissing }: { src: string | null; onMissing?: () => void }): JSX.Element {
  // The address that failed: a new one is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  const missing = !src || failed === src;
  useEffect(() => {
    if (missing) onMissing?.();
  }, [missing, onMissing]);
  if (!src || missing)
    return (
      <span className="play-thumb play-thumb-blank" aria-hidden="true">
        <NoCover small />
      </span>
    );
  return (
    <img
      className="play-thumb"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      onError={() => setFailed(src)}
    />
  );
}

function RecentRow({ entry }: { entry: PlayRecentEntry }): JSX.Element {
  const { slug } = entry;
  // Saved before the game had a cover, or one that no longer loads: its page names the one it has now.
  const findCover = useCallback(() => void studio().play.findCover(slug), [slug]);
  return (
    <button
      type="button"
      className="sidebar-game-select play-recent-row"
      data-play-recent={entry.slug}
      title={entry.title}
      onClick={() => void studio().play.open(entry)}
    >
      <PlayThumb src={entry.coverUrl} onMissing={findCover} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
    </button>
  );
}

/** The Recent list; nothing at all until a game has been played. */
export function PlayRecent(): JSX.Element | null {
  const recent = usePlay((s) => s.recent);
  if (recent.length === 0) return null;
  return (
    // Other people's games, by their titles.
    <div className="sidebar-games" data-play-recent-list data-analytics-mask>
      {recent.map((entry) => (
        <div key={entry.slug} className="sidebar-game">
          <RecentRow entry={entry} />
        </div>
      ))}
    </div>
  );
}
