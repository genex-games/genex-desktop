/** The Builds tab's lightbox: one still at a time, stepped with the arrow keys when there are several. */
import type { JSX } from "react";
import { useEffect } from "react";
import { t } from "../../../shared/i18n.ts";
import { useStill } from "../../stills.ts";
import { Button } from "../../ui/Button.tsx";
import { PanelButton } from "./chrome.tsx";
import type { LightItem } from "./types.ts";
import { Pending } from "../../ui/Pending.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";

/** One still over the Builds tab, with its title and caption. */
export function Lightbox({
  item,
  count,
  onPrev,
  onNext,
  onClose,
}: {
  item: LightItem;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}): JSX.Element {
  const loaded = useStill(!item.src && item.path ? { run: item.path } : null);
  const src = item.src ?? loaded;
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
    <div
      className="absolute inset-0 z-[6] flex flex-col items-center justify-center gap-3 p-6"
      style={{ background: "color-mix(in oklab, var(--tooltip-bg) 88%, transparent)" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClose}
    >
      <div
        className="grid min-h-0 max-w-full flex-1 place-items-center overflow-hidden rounded-card bg-[#0c1017]"
        style={{ boxShadow: "var(--shadow-overlay)", maxHeight: "calc(100% - 56px)" }}
        onClick={(event) => event.stopPropagation()}
      >
        {src ? (
          <img src={src} alt="" className="block max-h-full max-w-full object-contain" draggable={false} />
        ) : (
          <Pending label={t("Loading…")}>
            <Skeleton width={240} height={160} radius={14} className="skeleton-on-dark" />
          </Pending>
        )}
      </div>
      <div className="flex items-center gap-2.5" onClick={(event) => event.stopPropagation()}>
        {several ? <PanelButton label={t("Previous (←)")} icon="chevron-left" onClick={onPrev} /> : null}
        <span className="text-xs text-ink">{item.title}</span>
        {item.caption ? <span className="text-xs text-ink-3">{item.caption}</span> : null}
        {several ? <PanelButton label={t("Next (→)")} icon="chevron-right" onClick={onNext} /> : null}
        <Button variant="ghost" onClick={onClose}>
          {t("Close")}
        </Button>
      </div>
    </div>
  );
}
