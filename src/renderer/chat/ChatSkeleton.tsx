/**
 * A chat on its way (`ChatPanel` while its history is read): the shape of a conversation — your
 * message on the right, a reply, a build card, a disclosure and more reply — over a quiet composer,
 * so opening a long chat keeps the panel's layout instead of going blank.
 */
import type { JSX } from "react";
import { t } from "../../shared/i18n.ts";
import { Pending } from "../ui/Pending.tsx";
import { Skeleton, SkeletonLines } from "../ui/Skeleton.tsx";

/** The conversation and the composer as blocks, announced as the chat loading. */
export function ChatSkeleton(): JSX.Element {
  return (
    <div data-chat-skeleton className="flex h-full min-h-0 flex-col">
      <Pending
        label={t("Loading conversation…")}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 pt-6"
      >
        <Skeleton width={200} height={36} radius={18} className="self-end" />
        <SkeletonLines widths={["100%", "94%", "58%"]} />
        <span className="skeleton-row rounded-card border border-line bg-surface p-2.5">
          <Skeleton width={96} height={54} radius={10} />
          <span className="skeleton-row-text">
            <Skeleton width={120} />
            <Skeleton width={80} height={8} />
          </span>
        </span>
        <Skeleton width={110} />
        <SkeletonLines widths={["100%", "76%"]} />
      </Pending>
      <div aria-hidden className="shrink-0 px-3.5 pb-3.5">
        <div className="composer-panel h-[92px] px-4 py-4">
          <span className="pending-late block">
            <Skeleton width={130} />
          </span>
        </div>
      </div>
    </div>
  );
}
