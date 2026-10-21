/**
 * Valve's text KeyValues, the format Steam writes its library list (`libraryfolders.vdf`) and each
 * installed game's manifest (`appmanifest_<id>.acf`) in: quoted keys, each followed by a quoted
 * value or a `{ … }` block of more pairs. Read only as deep and as long as those files need, so a
 * broken or hostile file costs nothing; anything that isn't KeyValues reads as null.
 */

/** A KeyValues block: each key's text, or its block. The first of a repeated key wins. */
export interface VdfBlock {
  [key: string]: string | VdfBlock;
}

/** The deepest block nesting read: Steam's files nest three or four levels. */
const MAX_DEPTH = 16;
/** The most text read: a library list or a manifest is a few kilobytes. */
export const MAX_VDF_CHARS = 1024 * 1024;

/** What `\x` means inside a quoted token, as Valve escapes it. */
const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", "\\": "\\", '"': '"' };

/** The tokens: a quoted string, an opening or a closing brace. */
type Token = { kind: "text"; text: string } | { kind: "open" } | { kind: "close" };

/** Reads one quoted token starting after its opening quote; null when it never closes. */
function quoted(source: string, start: number): { text: string; end: number } | null {
  let text = "";
  for (let at = start; at < source.length; at++) {
    const char = source.charAt(at);
    if (char === '"') return { text, end: at + 1 };
    if (char === "\\" && at + 1 < source.length) {
      const next = source.charAt(at + 1);
      text += ESCAPES[next] ?? `\\${next}`;
      at++;
      continue;
    }
    text += char;
  }
  return null;
}

/** The index just past a `//` comment's line. */
function lineEnd(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end + 1;
}

/** What one step of the reader found at a position: a token (none for space or a comment) and where it ends; null for anything else. */
function step(source: string, at: number): { token?: Token; end: number } | null {
  const char = source.charAt(at);
  if (/\s/.test(char)) return { end: at + 1 };
  if (char === "/" && source.charAt(at + 1) === "/") return { end: lineEnd(source, at) };
  if (char === "{" || char === "}") return { token: { kind: char === "{" ? "open" : "close" }, end: at + 1 };
  if (char !== '"') return null;
  const token = quoted(source, at + 1);
  return token ? { token: { kind: "text", text: token.text }, end: token.end } : null;
}

/** The file's tokens, or null when it holds anything KeyValues doesn't (a bare word, an open quote). */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const found = step(source, at);
    if (!found) return null;
    if (found.token) tokens.push(found.token);
    at = found.end;
  }
  return tokens;
}

/** One pair's value at `at`: its text, or the block it opens; null when it is neither. */
function pairValue(tokens: Token[], at: number, depth: number): { value: string | VdfBlock; end: number } | null {
  const value = tokens[at];
  if (value?.kind === "text") return { value: value.text, end: at + 1 };
  if (value?.kind !== "open" || depth >= MAX_DEPTH) return null;
  const inner = block(tokens, at + 1, depth + 1);
  return inner ? { value: inner.block, end: inner.end } : null;
}

/** Reads pairs from `tokens` at `start` until a closing brace (or the end at depth 0). */
function block(tokens: Token[], start: number, depth: number): { block: VdfBlock; end: number } | null {
  const out: VdfBlock = {};
  let at = start;
  while (at < tokens.length) {
    const key = tokens[at];
    if (key?.kind === "close") return depth > 0 ? { block: out, end: at + 1 } : null;
    if (key?.kind !== "text") return null;
    const pair = pairValue(tokens, at + 1, depth);
    if (!pair) return null;
    if (!Object.hasOwn(out, key.text)) out[key.text] = pair.value;
    at = pair.end;
  }
  return depth === 0 ? { block: out, end: at } : null;
}

/** The KeyValues in `source` as nested blocks, or null when it is no KeyValues or too long to read. */
export function parseVdf(source: string): VdfBlock | null {
  if (source.length > MAX_VDF_CHARS) return null;
  const tokens = tokenize(source);
  return tokens ? (block(tokens, 0, 0)?.block ?? null) : null;
}

/** A block's block under `key`, or null. */
export function vdfBlock(value: VdfBlock | null | undefined, key: string): VdfBlock | null {
  const inner = value?.[key];
  return inner && typeof inner === "object" ? inner : null;
}

/** A block's text under `key`, or null. */
export function vdfText(value: VdfBlock | null | undefined, key: string): string | null {
  const inner = value?.[key];
  return typeof inner === "string" ? inner : null;
}
