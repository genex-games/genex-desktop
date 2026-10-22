/**
 * Copy a line of text to the clipboard and say so for a moment: what a Copy button reads as
 * "Copied" while `copied` is true. A refused write changes nothing.
 */
import { useEffect, useState } from "react";

/** How long a Copy button says it copied. */
const COPIED_MS = 1600;

/** `[copied, copy]`: whether the last copy just landed, and the copy itself. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  return [copied, copy];
}
