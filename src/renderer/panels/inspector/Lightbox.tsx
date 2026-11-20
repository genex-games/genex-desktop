/**
 * The Builds tab's lightbox: one picture at a time over the whole window, at its own shape with
 * nothing framed around it, Close in the top corner (the app's own lightbox, `ui/Lightbox.tsx`);
 * with several, ← and → step through them and the bar under the picture says which one it is.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { t } from "../../../shared/i18n.ts";
import { useStillRead } from "../../stills.ts";
import { Icon } from "../../ui/icons.tsx";
import { Lightbox as WindowLightbox } from "../../ui/Lightbox.tsx";
import { Pending } from "../../ui/Pending.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";
import type { LightItem } from "./types.ts";

const MESSAGE = {
  loading: t("Loading…"),
  previous: t("Previous (←)"),
  next: t("Next (→)"),
  position: (at: number, count: number) => t("{at} of {count}", { at, count }),
} as const;

/** The skeleton's size while a picture is on its way. */
const PENDING_SIZE = { width: 320, height: 240, radius: 12 } as const;

/** One picture over the window, its name and, with several, where it is among them. */
export function Lightbox({
  item,
  index,
  count,
  onPrev,
  onNext,
  onClose,
}: {
  item: LightItem;
  /** where the picture is among the ones open, from 0 */
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}): JSX.Element {
  const source = item.still ?? (!item.src && item.path ? { run: item.path } : null);
  const loaded = useStillRead(source);
  const src = item.src ?? loaded.src;
  const several = count > 1;
  useEffect(() => {
    if (count < 2) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "ArrowLeft") onPrev();
      else if (event.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, onPrev, onNext]);
  return (
    <WindowLightbox title={item.title} testId="builds-lightbox" onDismiss={onClose}>
      {src ? (
        <img
          src={src}
          alt={item.title}
          draggable={false}
          className="lightbox-media block max-h-[calc(100vh-176px)] max-w-[calc(100vw-160px)] object-contain"
        />
      ) : (
        <Pending label={MESSAGE.loading}>
          <Skeleton {...PENDING_SIZE} />
        </Pending>
      )}
      <div className="lightbox-bar">
        {several ? (
          <button
            type="button"
            aria-label={MESSAGE.previous}
            title={MESSAGE.previous}
            className="lightbox-chip"
            onClick={onPrev}
          >
            <Icon name="chevron-left" size={16} />
          </button>
        ) : null}
        <span className="max-w-[48vw] truncate px-2 text-xs text-ink">{item.title}</span>
        {item.caption ? <span className="max-w-[32vw] truncate text-xs text-ink-3">{item.caption}</span> : null}
        {several ? (
          <span className="px-2 font-mono text-xs text-ink-3 tabular-nums">{MESSAGE.position(index + 1, count)}</span>
        ) : null}
        {several ? (
          <button
            type="button"
            aria-label={MESSAGE.next}
            title={MESSAGE.next}
            className="lightbox-chip"
            onClick={onNext}
          >
            <Icon name="chevron-right" size={16} />
          </button>
        ) : null}
      </div>
    </WindowLightbox>
  );
}
