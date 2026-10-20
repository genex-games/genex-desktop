import type { ReactNode } from "react";
import { hostPlatform } from "../platform.ts";
import { shortcutKeys } from "../shortcut-keys.ts";

/** The platform main answered, or none outside a window (tests): the Mac's glyphs then. */
const platformHere = (): string => (typeof document === "undefined" ? "" : hostPlatform());

/** Shared, quiet shortcut hint used in tooltips and keyboard-driven dialogs; Mac glyphs read as Ctrl elsewhere. */
export function Shortcut({ children }: { children: ReactNode }) {
  const text = typeof children === "string" ? shortcutKeys(children, platformHere()) : null;
  const keys = text?.match(/[⌘⌃⌥⇧]|[^⌘⌃⌥⇧]+/g) ?? null;
  return <kbd className="shortcut">{keys ? keys.map((key, i) => <span key={i}>{key}</span>) : children}</kbd>;
}
