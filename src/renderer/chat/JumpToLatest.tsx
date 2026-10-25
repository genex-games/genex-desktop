/** Shown while entries arrive below a reader who scrolled up; one press brings them back down. */
import type { JSX } from "react";
import { t } from "../../shared/i18n.ts";
import { StatusOrb } from "../ui/StatusOrb.tsx";

const MESSAGE = { jump: t("Jump to latest") } as const;

/** While an agent works, the button holds the status line's loader in place of its words and chevron. */
export function JumpToLatest({
  unseen,
  working = false,
  onJump,
}: {
  unseen: number;
  working?: boolean;
  onJump: () => void;
}): JSX.Element | null {
  if (unseen <= 0) return null;
  return (
    <button
      type="button"
      onClick={onJump}
      {...(working ? { "aria-label": MESSAGE.jump, title: MESSAGE.jump, "data-working": true } : {})}
      className={`chat-jump absolute bottom-3 left-1/2 z-10 flex h-[28px] -translate-x-1/2 items-center justify-center gap-1.5 rounded-full bg-surface text-[13px] text-ink shadow-card ${working ? "w-[28px]" : "px-2.5"}`}
    >
      {working ? (
        <StatusOrb />
      ) : (
        <>
          {MESSAGE.jump}
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      )}
    </button>
  );
}
