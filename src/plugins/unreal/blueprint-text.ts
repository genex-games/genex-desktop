/**
 * Blueprint text: the s-expression language Epic's editor toolset turns into Blueprint graphs
 * (`write_graph_dsl`, UE 5.8 `EditorToolset/.../blueprint_dsl.py`). Genex reads it without Unreal so
 * builders' Blueprints are checked before they reach the editor. The tokenizer follows Epic's own
 * rules exactly: `;` comments, quoted strings with `\"` and `\\` escapes, `:"Quoted Pin"` keywords,
 * `true`/`false` in any case, Python's int and float spellings, and a `(` inside a word taking the
 * balanced group with it (`Equal(==)`, `sin(degrees)`), which also ends the word.
 */

/** What a word of Blueprint text is, by Epic's reading. */
export const AtomKind = { Symbol: "symbol", String: "string", Number: "number", Bool: "bool" } as const;
export type AtomKind = (typeof AtomKind)[keyof typeof AtomKind];

/** One word: a symbol (variable, node type id, operator or `:keyword`), a quoted string, a number or a bool. */
export type BlueprintAtom =
  | { kind: typeof AtomKind.Symbol; text: string; at: number }
  | { kind: typeof AtomKind.String; text: string; at: number }
  | { kind: typeof AtomKind.Number; value: number; integer: boolean; at: number }
  | { kind: typeof AtomKind.Bool; value: boolean; at: number };

/** A parenthesised list, with where it starts in the text. */
export type BlueprintList = { kind: "list"; items: BlueprintForm[]; at: number };
export type BlueprintForm = BlueprintAtom | BlueprintList;

/** A text Epic's parser would refuse, with the 1-based line it fails on. */
export class BlueprintTextError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "BlueprintTextError";
    this.line = line;
  }
}

/** A token: a word, or an opening or closing parenthesis. */
export type Token = BlueprintAtom | { kind: "open"; at: number } | { kind: "close"; at: number };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const WORD_END = new Set([" ", "\t", "\n", "\r", ";", '"', ")"]);
/** Python's int(): optional sign, digits with single underscores between them. */
const PY_INT = /^[+-]?\d+(?:_\d+)*$/;
/** Python's float(): a mantissa with a digit, an optional exponent, underscores between digits; or inf/infinity/nan. */
const PY_FLOAT =
  /^[+-]?(?:(?:\d+(?:_\d+)*\.?(?:\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?|inf|infinity|nan)$/i;

/** The 1-based line holding offset `at`. */
export function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Offset just past the closing quote of the string starting at `from` (the opening quote). */
function stringEnd(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  if (j >= text.length) throw new BlueprintTextError("unterminated string literal", lineOf(text, from));
  return j;
}

const unescapeText = (raw: string) => raw.replaceAll('\\"', '"').replaceAll("\\\\", "\\");

/** Offset where a word starting at `from` ends: at a separator, or just past a balanced `(...)` group. */
function wordEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length && !WORD_END.has(text[j] ?? "")) {
    if (text[j] !== "(") {
      j++;
      continue;
    }
    let depth = 0;
    while (j < text.length) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) return j + 1;
      j++;
    }
    return j;
  }
  return j;
}

/** A word as Epic reads it: bool, int, float, or symbol. */
function atomOf(word: string, at: number): BlueprintAtom {
  const lower = word.toLowerCase();
  if (lower === "true" || lower === "false") return { kind: AtomKind.Bool, value: lower === "true", at };
  if (PY_INT.test(word)) return { kind: AtomKind.Number, value: Number(word.replaceAll("_", "")), integer: true, at };
  if (PY_FLOAT.test(word))
    return { kind: AtomKind.Number, value: Number.parseFloat(word.replaceAll("_", "")), integer: false, at };
  return { kind: AtomKind.Symbol, text: word, at };
}

/** Reads one token at `i`, or skips a comment or a space; returns where the next one starts. */
function readToken(text: string, i: number, tokens: Token[]): number {
  const c = text[i] ?? "";
  if (c === ";") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end;
  }
  if (c === "(" || c === ")") {
    tokens.push({ kind: c === "(" ? "open" : "close", at: i });
    return i + 1;
  }
  if (c === '"') {
    const end = stringEnd(text, i);
    tokens.push({ kind: AtomKind.String, text: unescapeText(text.slice(i + 1, end)), at: i });
    return end + 1;
  }
  if (WHITESPACE.has(c)) return i + 1;
  return readWord(text, i, tokens);
}

/** Splits Blueprint text into tokens exactly as Epic's `tokenize` does. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) i = readToken(text, i, tokens);
  return tokens;
}

/** The exact source of the list form that opens at `at`, through its matching `)`. */
export function formSource(text: string, at: number): string {
  let depth = 0;
  for (const token of tokenize(text)) {
    if (token.at < at) continue;
    if (token.kind === "open") depth++;
    else if (token.kind === "close" && --depth === 0) return text.slice(at, token.at + 1);
  }
  return text.slice(at);
}

/** Reads the word at `from` into `tokens`; a bare `:` before a string is a quoted keyword. */
function readWord(text: string, from: number, tokens: Token[]): number {
  const end = wordEnd(text, from);
  const word = text.slice(from, end);
  if (word === ":" && text[end] === '"') {
    const close = stringEnd(text, end);
    tokens.push({ kind: AtomKind.Symbol, text: `:${unescapeText(text.slice(end + 1, close))}`, at: from });
    return close + 1;
  }
  tokens.push(atomOf(word, from));
  return end;
}

/** Parses Blueprint text into its top-level forms, refusing what Epic's parser refuses. */
export function parseBlueprintText(text: string): BlueprintForm[] {
  const tokens = tokenize(text);
  let pos = 0;
  const readForm = (): BlueprintForm => {
    const token = tokens[pos];
    if (!token) throw new BlueprintTextError("Unexpected end of input", lineOf(text, text.length));
    if (token.kind === "close") throw new BlueprintTextError("Unexpected )", lineOf(text, token.at));
    pos++;
    if (token.kind !== "open") return token;
    const items: BlueprintForm[] = [];
    while (pos < tokens.length) {
      if (tokens[pos]?.kind === "close") {
        pos++;
        return { kind: "list", items, at: token.at };
      }
      items.push(readForm());
    }
    throw new BlueprintTextError("Unclosed parenthesis", lineOf(text, token.at));
  };
  const forms: BlueprintForm[] = [];
  while (pos < tokens.length) forms.push(readForm());
  return forms;
}

/** Whether a form is the symbol `name` (exactly, as Epic compares symbols). */
export const isSymbol = (form: BlueprintForm | undefined, name?: string): form is BlueprintAtom & { kind: "symbol" } =>
  form?.kind === AtomKind.Symbol && (name === undefined || form.text === name);

/** A form written back as Blueprint text, shortened like Epic's error context (80 characters). */
export function formText(form: BlueprintForm, limit = 80): string {
  const full = render(form);
  return full.length <= limit ? full : `${full.slice(0, limit - 3)}...`;
}

function render(form: BlueprintForm): string {
  switch (form.kind) {
    case "list":
      return `(${form.items.map(render).join(" ")})`;
    case AtomKind.String:
      return `"${form.text}"`;
    case AtomKind.Bool:
      return form.value ? "true" : "false";
    case AtomKind.Number:
      return String(form.value);
    default:
      return form.text;
  }
}
