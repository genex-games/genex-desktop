import type { JSX } from "react";
import { t } from "../../shared/i18n.ts";
import { type ToastItem, ToastTone } from "../state/toasts.ts";
import { Icon } from "./icons.tsx";

const TONE_DOT: Record<ToastTone, string> = {
  [ToastTone.Error]: "bg-red",
  [ToastTone.Ok]: "bg-green",
  [ToastTone.Info]: "bg-accent",
};

/** A toast's mark: a bare check for something done, a dot in the tone's colour otherwise. */
function ToneMark({ tone }: { tone: ToastTone }): JSX.Element {
  if (tone === ToastTone.Ok) return <Icon name="check" size={14} className="mt-0.5 text-ink" />;
  return <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[300] flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="pointer-events-auto overflow-hidden rounded-card bg-surface px-3 py-2.5 shadow-overlay"
        >
          <div className="flex items-start gap-2">
            <ToneMark tone={toast.tone} />
            <span className="min-w-0 flex-1 font-mono text-xs leading-relaxed text-ink-2">{toast.text}</span>
            <button
              type="button"
              aria-label={t("Dismiss")}
              onClick={() => onDismiss(toast.id)}
              className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-control-hover hover:text-control-text-hover"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
