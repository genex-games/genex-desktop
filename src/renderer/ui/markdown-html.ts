import { Marked, Renderer, type Token, type Tokens } from "marked";
import { highlightCommand } from "./command-highlight.ts";
import { highlightCode } from "./syntax-highlight.ts";
import { type ChatFileLookup, type ChatFileRef, wholeFileName } from "../../shared/chat-files.ts";
import { fencedCommand } from "../../shared/terminal.ts";
import { escapeAttribute, escapeHtml, fileLinkHtml, FileLinkStyle, linkifyHtml } from "./file-links.ts";
import { answersOf } from "../chat-files.ts";

/**
 * The files a chat's Markdown may link: what main answered so far (`lookup`), the document the
 * text came from (`base`, for its relative links) and every name the text holds (`names`).
 */
export interface MarkdownFiles {
  lookup: ChatFileLookup;
  base?: string;
  names: ChatFileRef[];
}

/** A link with no scheme (`docs/BRIEF.md`), a `file:` URL or an absolute path names a file. */
const fileDestination = (href: string): string | null => {
  if (!href) return null;
  if (href.startsWith("#") || href.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return null;
  // Main reads a `file:` URL itself; decoding it here would lose what it escaped.
  if (/^file:/i.test(href)) return href;
  const file = href.replace(/[?#].*$/, "");
  try {
    return decodeURI(file) || null;
  } catch {
    return file || null;
  }
};
/** The named entities a destination can hide a scheme behind, as the DOM decodes them. */
const NAMED_ENTITY: Record<string, string> = { colon: ":", tab: "\t", newline: "\n" };
/** The highest code point there is; a numeric entity past it decodes to nothing. */
const MAX_CODE_POINT = 0x10ffff;

/** A destination with its character references decoded, as the DOM will see it. */
const decodedDestination = (href: string): string =>
  href.replace(/&(?:#(\d+);?|#x([\da-f]+);?|(colon|Tab|NewLine);)/gi, (_, decimal, hex, named) => {
    if (named) return NAMED_ENTITY[named.toLowerCase()] ?? "\n";
    const code = parseInt(decimal ?? hex, decimal ? 10 : 16);
    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : "";
  });

const safeDestination = (href: string): boolean => {
  // Check the destination after HTML entity decoding, as the DOM will see it.
  const decoded = decodedDestination(href);
  try {
    return ["http:", "https:", "mailto:", "file:"].includes(new URL(decoded, "https://studio.local").protocol);
  } catch {
    return false;
  }
};

// Set only while one synchronous parse runs.
let files: MarkdownFiles | null = null;
// Inside a web link's words, inline code is the link's text, not a file of its own.
let inWebLink = 0;

const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Escape only HTML tokens. Code tokens are already escaped by Marked exactly once.
    html({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang }) {
      const language = lang?.trim().split(/\s+/)[0];
      const command = fencedCommand(text, language);
      if (command === null) return `<pre><code>${highlightCode(text, language)}</code></pre>\n`;
      // A one-line shell block can be run: Markdown.tsx draws its actions into the empty slot.
      const block = `<pre><code>${highlightCommand(command)}</code></pre>`;
      return `<div class="prose-command" data-command="${escapeAttribute(command)}">${block}<div class="prose-command-actions" data-command-slot></div></div>\n`;
    },
    codespan({ text }) {
      const name = files && !inWebLink ? wholeFileName(text) : null;
      if (!files || !name) return false;
      files.names.push({ name });
      const link = files.lookup(name);
      return link ? fileLinkHtml({ name }, link, escapeHtml(text.trim()), text.trim(), FileLinkStyle.Chip) : false;
    },
    link(token: Tokens.Link) {
      const { href, tokens } = token;
      const file = fileDestination(href);
      if (!file) {
        if (!safeDestination(href)) return this.parser.parseInline(tokens);
        inWebLink += 1;
        try {
          return Renderer.prototype.link.call(this, token);
        } finally {
          inWebLink -= 1;
        }
      }
      // A link to a file is a file button, or only its words while it is not known to be a file.
      const label = this.parser.parseInline(tokens, this.parser.textRenderer);
      const ref: ChatFileRef = files?.base ? { name: file, base: files.base } : { name: file };
      files?.names.push(ref);
      const link = files?.lookup(ref.name, ref.base);
      return link ? fileLinkHtml(ref, link, escapeHtml(label), label, FileLinkStyle.Chip) : escapeHtml(label);
    },
    image({ href, text }) {
      return safeDestination(href) ? false : escapeHtml(text);
    },
  },
});

/** How chat Markdown renders: the files it may link (without, it links none), and whether it is still arriving. */
export interface MarkdownOptions {
  files?: MarkdownFiles;
  /** The text is still arriving: finished blocks come from the cache, and an open fence stays plain text. */
  streaming?: boolean;
}

/** The most characters (keys and HTML) the rendered-Markdown cache keeps. */
const MARKDOWN_CACHE_CHARS = 2_000_000;

/** A rendered piece, the file names it holds, and what main had answered about them when it rendered. */
interface Rendered {
  html: string;
  names: ChatFileRef[];
  answers: string;
}

const htmlCache = new Map<string, Rendered>();
let cachedChars = 0;

/** One parse as HTML, linking the names main has confirmed when there are files to link. */
function renderHtml(parse: () => string, withFiles: MarkdownFiles | undefined): string {
  files = withFiles ?? null;
  try {
    const html = parse();
    return withFiles ? linkifyHtml(html, withFiles.lookup, withFiles.names) : html;
  } finally {
    files = null;
  }
}

/**
 * One piece of Markdown as HTML: from the cache when it rendered before and main's answers about
 * the file names it holds are still the same, so those names are asked about as if it rendered.
 */
function cachedHtml(key: string, withFiles: MarkdownFiles | undefined, parse: () => string): string {
  const cacheKey = withFiles ? `files:${withFiles.base ?? ""}:${key}` : key;
  const hit = htmlCache.get(cacheKey);
  if (hit !== undefined && (!withFiles || answersOf(withFiles.lookup, hit.names) === hit.answers)) {
    htmlCache.delete(cacheKey);
    htmlCache.set(cacheKey, hit);
    withFiles?.names.push(...hit.names);
    return hit.html;
  }
  const names: ChatFileRef[] = [];
  const html = renderHtml(parse, withFiles ? { ...withFiles, names } : undefined);
  withFiles?.names.push(...names);
  remember(cacheKey, { html, names, answers: withFiles ? answersOf(withFiles.lookup, names) : "" });
  return html;
}

function remember(key: string, rendered: Rendered): void {
  const previous = htmlCache.get(key);
  if (previous) {
    cachedChars -= key.length + previous.html.length;
    htmlCache.delete(key);
  }
  const cost = key.length + rendered.html.length;
  if (cost > MARKDOWN_CACHE_CHARS) return;
  htmlCache.set(key, rendered);
  cachedChars += cost;
  while (cachedChars > MARKDOWN_CACHE_CHARS) {
    const oldest = htmlCache.entries().next().value;
    if (!oldest) break;
    cachedChars -= oldest[0].length + oldest[1].html.length;
    htmlCache.delete(oldest[0]);
  }
}

function openFence(token: Token): boolean {
  if (token.type !== "code") return false;
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
  if (!opening?.[1]) return false;
  const marker = opening[1];
  const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*$`, "m");
  return !closing.test(token.raw.slice(opening[0].length));
}

/**
 * Chat Markdown as safe HTML. With `files`, file names that main has confirmed become buttons
 * (file-links.ts); without, the text links no files. Streaming replies reuse completed block HTML
 * and escape open fences.
 */
export function markdownHtml(text: string, options: MarkdownOptions = {}): string {
  const { files: withFiles, streaming } = options;
  if (!streaming) return cachedHtml(`document:${text}`, withFiles, () => parser.parse(text, { async: false }));
  return markdownBlocks(text, options).join("");
}

/** Arriving Markdown as the HTML of each of its blocks, which `markdownHtml` joins. */
export function markdownBlocks(text: string, options: Omit<MarkdownOptions, "streaming"> = {}): string[] {
  const { files: withFiles } = options;
  const tokens = parser.lexer(text);
  const links = JSON.stringify(tokens.links);
  return tokens.map((token) => {
    if (openFence(token) && token.type === "code") return `<pre><code>${escapeHtml(token.text)}</code></pre>\n`;
    return cachedHtml(`block:${links}:${token.raw}`, withFiles, () => parser.parser([token]));
  });
}
