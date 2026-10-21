/**
 * The crash card above the stage (game-systems PROF-7): when the run Live shows (its embedded run,
 * or the Mac window's) ended in a crash, the record the host kept for it: what happened, where,
 * the first named frames, and the tick and seed that replay it. Nothing shows while the run is fine.
 */
import { type JSX, useEffect } from "react";
import type { GameProject } from "../../../shared/game-project.ts";
import { crashCardOf } from "../../live-profile.ts";
import { useLiveProfile, useNative } from "../../state/hooks.ts";
import { liveProfileOf, liveProfileStoreFor } from "../../state/live-profile.ts";
import { nativeEmbedOf, nativeOf } from "../../state/native.ts";
import { studio } from "../../state/studio.ts";
import { PROFILE_WORDS } from "../../words.ts";

/** The crash id of `project`'s shown run, embedded first; null while neither crashed. */
function useShownCrash(project: string): string | null {
  return useNative(
    (state) =>
      nativeEmbedOf(state, project).status?.crash?.crashId ?? nativeOf(state, project).status?.crash?.crashId ?? null,
  );
}

/** The card for `game`'s crashed run, or nothing. */
export function CrashCard({ game }: { game: GameProject }): JSX.Element | null {
  const project = game.name;
  const crashId = useShownCrash(project);
  const entry = useLiveProfile((state) => liveProfileOf(state, project).crash);
  useEffect(() => {
    if (crashId)
      void liveProfileStoreFor(studio().api)
        .readCrash(project, crashId)
        .catch(() => {});
  }, [project, crashId]);
  if (!crashId || entry?.crashId !== crashId) return null;
  const card = crashCardOf(entry);
  const replay = PROFILE_WORDS.crash.replay(card.tick, card.seed);
  const repeat = PROFILE_WORDS.crash.repeat(card.repeat);
  return (
    <div
      role="alert"
      data-stage-crash-card={card.kind}
      className="grid shrink-0 gap-1 border-b border-line bg-red-tint px-3 py-2.5"
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm">
        <span className="font-medium text-ink">{PROFILE_WORDS.crash.heading}</span>
        <span className="text-red">{PROFILE_WORDS.crash.kind[entry.record.kind]}</span>
        {repeat ? <span className="text-xs text-ink-3">{repeat}</span> : null}
        {replay ? <span className="ms-auto text-xs text-ink-3 tabular-nums">{replay}</span> : null}
      </p>
      <p className="text-xs leading-relaxed text-pretty text-ink-2">{card.message}</p>
      {card.location ? <p className="font-mono text-xs text-ink-3">{card.location}</p> : null}
      {card.frames.length > 0 ? (
        <ol className="grid gap-0.5 font-mono text-xs text-ink-3">
          {card.frames.map((frame) => (
            <li key={frame} className="truncate">
              {frame}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
