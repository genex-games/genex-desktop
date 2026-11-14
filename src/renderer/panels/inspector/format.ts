/** The inspector's small formatters: times and an engine's model line. */
import { intlLocale } from "../../../shared/i18n.ts";

/** The text with its first letter upper-cased. */
export const capitalise = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** Words joined with a middle dot, skipping the empty ones. */
export const joinDots = (parts: ReadonlyArray<string | null | undefined | false>): string =>
  parts.filter(Boolean).join(" · ");

/** A clock time such as 14:05, or nothing for a missing or unreadable date. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
}
