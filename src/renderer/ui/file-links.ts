/**
 * File names inside rendered HTML (Markdown, highlighted code) become buttons once main has
 * said they are files. Plain React text uses FileText.tsx with the same tokenizer.
 *
 * Only text between tags is touched, never attributes, and text inside a link or button stays
 * as it is. A piece of text with no file in it is returned byte for byte.
 */
import { type ChatFileLink, type ChatFileLookup, type ChatFileRef, fileMentions } from "../../shared/chat-files.ts";
import { hostPlatform } from "../platform.ts";
import { chatFileWords } from "../words.ts";

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttribute = (text: string): string =>
  escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const FILE_ICON =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M13.5 3.5v5h5"/></svg>';

/** How a file button looks: a chip with a file icon in prose, underlined text in code. */
export const FileLinkStyle = { Chip: "chip", Code: "code" } as const;
export type FileLinkStyle = (typeof FileLinkStyle)[keyof typeof FileLinkStyle];

/** The platform main answered, or none outside a window (tests): the macOS words then. */
const platformHere = (): string => (typeof document === "undefined" ? "" : hostPlatform());

/** A file's own name, from a path written out in full ("/Users/me/Downloads/notes.txt"); null for a short name. */
export function fileNameOfPath(name: string): string | null {
  const url = /^file:\/\//i.test(name);
  if (!url && !/^(?:~|\/|[A-Za-z]:[\\/]|\\\\)/.test(name)) return null;
  const last = name.split(/[\\/]/).filter(Boolean).pop() ?? null;
  if (!last || !url) return last;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The hover text of a file link: what a click does, then where the file is when the label hides it. */
export function fileLinkTitle(link: ChatFileLink, label: string, platform: string = platformHere()): string {
  const words = chatFileWords(platform);
  const lines = [words.open[link.open]];
  if (link.path !== label.trim()) lines.push(link.path);
  if (link.build) lines.push(words.build);
  return lines.join("\n");
}

/**
 * A file button. In prose it is a chip with a file icon; in code it is underlined text, so
 * columns stay aligned. `label` is already HTML; `text` is what it says, for the hover text.
 */
export function fileLinkHtml(
  ref: ChatFileRef,
  link: ChatFileLink,
  label: string,
  text: string,
  style: FileLinkStyle,
): string {
  const chip = style === FileLinkStyle.Chip;
  const attributes = [
    `type="button"`,
    `class="${chip ? "prose-file" : "file-link"}"`,
    `data-file-path="${escapeAttribute(ref.name)}"`,
    ...(ref.base ? [`data-file-base="${escapeAttribute(ref.base)}"`] : []),
    `data-file-open="${link.open}"`,
    `data-file-target="${escapeAttribute(link.path)}"`,
    `title="${escapeAttribute(fileLinkTitle(link, text))}"`,
  ].join(" ");
  return chip
    ? `<button ${attributes}>${FILE_ICON}<span>${label}</span></button>`
    : `<button ${attributes}>${label}</button>`;
}

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** The highest code point there is; a numeric reference past it decodes to nothing. */
const MAX_CODE_POINT = 0x10ffff;

/** Text between tags as the DOM will show it: its character references decoded. */
function decode(text: string): string {
  return text.replace(ENTITY, (_, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named.toLowerCase()] ?? "";
    const code = decimal ? parseInt(decimal, 10) : parseInt(hex ?? "", 16);
    return code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : "";
  });
}

/** Links the names in one run of text; every name is added to `names`. The piece itself when none links. */
function linkText(piece: string, lookup: ChatFileLookup, names: ChatFileRef[], style: FileLinkStyle): string {
  const text = decode(piece);
  let out = "";
  let at = 0;
  for (const mention of fileMentions(text)) {
    names.push({ name: mention.name });
    const link = lookup(mention.name);
    if (!link) continue;
    const words = text.slice(mention.start, mention.end);
    out +=
      escapeHtml(text.slice(at, mention.start)) +
      fileLinkHtml({ name: mention.name }, link, escapeHtml(words), words, style);
    at = mention.end;
  }
  return at ? out + escapeHtml(text.slice(at)) : piece;
}

/** Tags whose text is never linked (it already is a control), and tags whose text is code. */
const INERT_TAGS = new Set(["a", "button"]);
const CODE_TAGS = new Set(["pre", "code"]);

/** How deep the walk is inside controls and code; `floor` is the code the whole HTML sits in. */
interface Depth {
  inert: number;
  code: number;
  floor: number;
}

/** One tag moves the walk one level in (an opening tag), out (a closing one) or nowhere. */
function enterTag(depth: Depth, piece: string, closing: string | undefined, tag: string): void {
  const name = tag.toLowerCase();
  let step = 1;
  if (closing) step = -1;
  else if (piece.endsWith("/>")) step = 0;
  if (INERT_TAGS.has(name)) depth.inert = Math.max(0, depth.inert + step);
  else if (CODE_TAGS.has(name)) depth.code = Math.max(depth.floor, depth.code + step);
}

/**
 * Links the file names in the text of `html`. Every name is added to `names` (to ask main
 * about); those it has not confirmed stay text. `code` renders links as code (the HTML is the
 * inside of one).
 */
export function linkifyHtml(html: string, lookup: ChatFileLookup, names: ChatFileRef[], code = false): string {
  const floor = code ? 1 : 0;
  const depth: Depth = { inert: 0, code: floor, floor };
  return html.replace(
    /<(\/?)([a-z][a-z0-9-]*)\b[^>]*>|[^<]+/gi,
    (piece: string, closing: string | undefined, tag: string | undefined) => {
      if (tag) {
        enterTag(depth, piece, closing, tag);
        return piece;
      }
      if (depth.inert) return piece;
      return linkText(piece, lookup, names, depth.code ? FileLinkStyle.Code : FileLinkStyle.Chip);
    },
  );
}
