/**
 * A translated sentence with parts drawn differently — a link, a bold name — kept whole so a
 * translator can move them: `richText(t("Read the <terms>Genex terms</terms> first."), { terms: (words) =>
 * <a href={TERMS_URL}>{words}</a> })`. A tag the caller does not draw shows as plain words.
 */
import { Fragment, type ReactNode } from "react";

/** How one tag draws the words inside it. */
export type RichTag = (words: ReactNode) => ReactNode;

const TAG = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

/** `text` with each `<tag>…</tag>` drawn by its function in `tags`. */
export function richText(text: string, tags: Readonly<Record<string, RichTag>>): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(TAG)) {
    const [whole, name, inner] = match;
    const index = match.index ?? 0;
    if (index > at) parts.push(text.slice(at, index));
    const draw = tags[name];
    parts.push(<Fragment key={index}>{draw ? draw(inner) : inner}</Fragment>);
    at = index + whole.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
