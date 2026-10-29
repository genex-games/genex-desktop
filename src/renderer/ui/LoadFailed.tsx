/** What a region shows when its first load failed: what could not load, why, and Retry. */
import type { JSX } from "react";
import { t } from "../../shared/i18n.ts";
import { Button } from "./Button.tsx";

export function LoadFailed({
  message,
  error,
  onRetry,
  retrying = false,
  className = "p-4 text-ink-2",
  detailClassName,
}: {
  /** The whole sentence saying what could not load: `t("Could not load this chat.")`. */
  message: string;
  error?: string;
  onRetry: () => void;
  /** A Retry is running: the failure stays up and its button waits. */
  retrying?: boolean;
  className?: string;
  detailClassName?: string;
}): JSX.Element {
  return (
    <div role="alert" className={className}>
      {message}
      <p className={detailClassName}>{error}</p>
      <Button onClick={onRetry} disabled={retrying} aria-busy={retrying}>
        {retrying ? t("Retrying…") : t("Retry")}
      </Button>
    </div>
  );
}
