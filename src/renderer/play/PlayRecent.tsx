/** Play's sidebar list: the games last opened, newest first, each one press from playing again. */
import type { JSX } from "react";
import { useState } from "react";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import type { PlayRecentEntry } from "./play-model.ts";

/**
 * A game's small cover, a rectangle so Play's rows read apart from Create's round game pictures: its
 * cover, or a plain tile while it has none or it fails to load.
 */
export function PlayThumb({ src }: { src: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="play-thumb play-thumb-blank" aria-hidden="true" />;
  return (
    <img
      className="play-thumb"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function RecentRow({ entry }: { entry: PlayRecentEntry }): JSX.Element {
  return (
    <button
      type="button"
      className="sidebar-game-select play-recent-row"
      data-play-recent={entry.slug}
      title={entry.title}
      onClick={() => void studio().play.open(entry)}
    >
      <PlayThumb src={entry.coverUrl} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
    </button>
  );
}

/** The Recent list; nothing at all until a game has been played. */
export function PlayRecent(): JSX.Element | null {
  const recent = usePlay((s) => s.recent);
  if (recent.length === 0) return null;
  return (
    <div className="sidebar-games" data-play-recent-list>
      {recent.map((entry) => (
        <div key={entry.slug} className="sidebar-game">
          <RecentRow entry={entry} />
        </div>
      ))}
    </div>
  );
}
