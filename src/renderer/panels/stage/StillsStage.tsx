/**
 * Live for a folder no observer draws (Godot, Blender, files of its own; `live-views.ts`): the
 * pictures of the run's newest capture, read through the run folder's gate (`useStill`), under the
 * game's name, laid out as the Unreal card lays out its shot. With none yet, the game's name and a
 * sentence saying where pictures come from.
 */
import type { JSX } from "react";
import type { CapturedFile } from "../../../shared/observers.ts";
import { latestCapture } from "../../live-views.ts";
import type { RunGraph as RunGraphModel } from "../../run-graph.ts";
import { useStill } from "../../stills.ts";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { STILLS_WORDS } from "../../words.ts";

/** The longest side a picture is read at for the stage. */
const STILL_MAX_PX = 1280;

/** One kept picture, once the run folder hands it over. */
function Still({ picture, label }: { picture: CapturedFile; label: string }): JSX.Element | null {
  const src = useStill({ run: picture.file, maxPx: STILL_MAX_PX });
  if (!src) return null;
  return (
    <img
      data-live-still=""
      src={src}
      alt={STILLS_WORDS.picture(label, picture.name)}
      className="aspect-video w-full rounded-lg border border-line object-cover"
    />
  );
}

/**
 * Live's latest pictures of the game on the stage, from the run the stage shows: a `stills`
 * observer's own newest capture, or with none named the run's newest capture of any observer.
 */
export function StillsStage({
  title,
  graph,
  observer,
}: {
  title: string;
  graph: RunGraphModel | null;
  observer: string | null;
}): JSX.Element {
  const newest = latestCapture(graph, observer ?? undefined);
  const pictures = newest?.files ?? [];
  const label = newest?.label ?? title;
  if (pictures.length === 0)
    return (
      <div data-live-view="stills" className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8">
        <EmptyState art="idea" title={title} subtitle={STILLS_WORDS.none} />
      </div>
    );
  return (
    <div data-live-view="stills" className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8">
      <div className="flex w-full max-w-[560px] flex-col items-center gap-3 text-center">
        {pictures.map((picture) => (
          <Still key={picture.file} picture={picture} label={label} />
        ))}
        <h2 className="empty-state-title max-w-full" title={title}>
          {title}
        </h2>
      </div>
    </div>
  );
}
