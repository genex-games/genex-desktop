import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";

const captures = new Map<string, string>();
/** How many captures stay in memory before the oldest is forgotten. */
const CAPTURE_CAP = 24;

function rememberCapture(path: string, value: string): void {
  captures.set(path, value);
  if (captures.size <= CAPTURE_CAP) return;
  const oldest = captures.keys().next().value;
  if (oldest !== undefined) captures.delete(oldest);
}

/** The frame's classes: compact is the finished build card's picture, the size of the running card's. */
function frameClass(compact: boolean, failed: boolean): string {
  if (!compact) return "relative m-0 aspect-[16/10] w-full overflow-hidden rounded-control bg-inset";
  return `relative m-0 h-[55px] w-[88px] shrink-0 overflow-hidden rounded-[10px] ${failed ? "hatch" : "bg-inset"}`;
}

/** A capture that could not be read, with a way to try again. */
function CaptureUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-chat-sub text-ink-3"
    >
      <span>{t("Capture unavailable")}</span>
      <ResultButton onClick={onRetry}>{t("Retry")}</ResultButton>
    </div>
  );
}

/** Reserve the frame before the protected, lazy read to keep chat scroll stable. */
export function RunCapture({ path, compact = false }: { path: string; compact?: boolean }) {
  const host = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState<string | null>(() => captures.get(path) ?? null),
    [failed, setFailed] = useState(false);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useAsyncEffect(
    (alive) => {
      if (!visible) return;
      const cached = captures.get(path);
      setFresh(false);
      setFailed(false);
      if (cached) {
        setSrc(cached);
        return;
      }
      setSrc(null);
      void window.studio
        .readRunStill(path)
        .then((image) => {
          if (!alive()) return;
          if (!image) {
            setFailed(true);
            return;
          }
          const value = `data:${image.mimeType};base64,${image.data}`;
          rememberCapture(path, value);
          setFresh(true);
          setSrc(value);
        })
        .catch(() => {
          if (alive()) setFailed(true);
        });
      return undefined;
    },
    [path, visible, attempt],
  );
  const fit = compact ? "object-cover" : "object-contain";
  return (
    <figure ref={host} data-run-capture className={frameClass(compact, failed)}>
      {src && (
        <img
          src={src}
          alt={t("Recorded build capture")}
          className={`absolute inset-0 h-full w-full ${fit} ${fresh ? "asset-thumbnail" : ""}`}
          onError={() => {
            captures.delete(path);
            setSrc(null);
            setFailed(true);
          }}
        />
      )}
      {failed && !compact && <CaptureUnavailable onRetry={() => setAttempt((n) => n + 1)} />}
    </figure>
  );
}
