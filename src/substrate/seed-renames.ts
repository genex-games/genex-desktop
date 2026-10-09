/**
 * Names the harness seed renamed. Its code once called a loop run a "night"; the shipped files now
 * say "loop run". A seed upgrade keeps every file the in-app agent edited, and a kept or
 * agent-written file still uses the old names, which the shipped files no longer export or
 * import: the harness would not load. `applySeed` rewrites them in those files before its pass
 * (seed-upgrade.ts `carryRenamesOver`). These tables are the only place the old names remain.
 */
import path from "node:path";

/** Seed modules moved to a new path, by their old workspace-relative path. */
export const RENAMED_SEED_FILES: Readonly<Record<string, string>> = {
  "loop/director/night.ts": "loop/director/loop-run.ts",
  "loop/after-night.ts": "loop/after-loop-run.ts",
  "loop/after-night-prompts.ts": "loop/after-loop-run-prompts.ts",
};

/** Names one seed module exports, or another reads off a shared object, by their old spelling. */
export const RENAMED_SEED_NAMES: Readonly<Record<string, string>> = {
  AfterNight: "AfterLoopRun",
  Night: "LoopRun",
  NightClock: "LoopRunClock",
  NightContract: "LoopRunContract",
  NightData: "LoopRunData",
  NightLogEntry: "LoopRunLogEntry",
  NightShape: "LoopRunShape",
  NightState: "LoopRunState",
  SERVES_AFTER_NIGHT: "SERVES_AFTER_LOOP_RUN",
  afterLeadNight: "afterLeadLoopRun",
  afterNight: "afterLoopRun",
  afterNightGrant: "afterLoopRunGrant",
  afterNightNote: "afterLoopRunNote",
  bindNight: "bindLoopRun",
  closeTheNight: "closeTheLoopRun",
  finishedNight: "finishedLoopRun",
  learnedTonight: "learnedThisRun",
  nightClock: "loopRunClock",
  nightRefusal: "loopRunRefusal",
  nightReport: "loopRunReport",
  ownSessionAfterNight: "ownSessionAfterLoopRun",
  prepareNight: "prepareLoopRun",
  recordNight: "recordLoopRun",
  restoreNight: "restoreLoopRun",
  servesAfterNight: "servesAfterLoopRun",
  tonight: "runLedger",
};

/**
 * Old names that are also plain English: rewritten in code and in a string that is only the name
 * (a key), never in prose — a comment, a string's or a template's text, a pattern. The upgrade
 * runs on every boot, so the agent's own words in its later files must come through as written.
 */
const ENGLISH_NAMES: ReadonlySet<string> = new Set(["Night", "tonight"]);

/** A relative module specifier in quotes. */
const RELATIVE_SPECIFIER = /(["'])(\.{1,2}\/[^"'\n]*)\1/g;

const NAME_RULES = Object.entries(RENAMED_SEED_NAMES).map(([from, to]) => ({
  from,
  pattern: new RegExp(`(?<![\\w$])${from}(?![\\w$])`, "g"),
  to,
  english: ENGLISH_NAMES.has(from),
}));

/** What a piece of a module's text is, to the English old names. */
const PieceKind = { Code: "code", Comment: "comment", Text: "text" } as const;
type PieceKind = (typeof PieceKind)[keyof typeof PieceKind];

/** One piece of a module's text: code, a comment, or a string's, template's or pattern's text. */
interface Piece {
  kind: PieceKind;
  text: string;
}

/** Words after which a `/` opens a regular expression; after any other word it divides. */
const PATTERN_AFTER_WORDS: ReadonlySet<string> = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** An identifier, keyword, number or pattern's flags. */
const WORD = /[\w$]+/y;

/** The last mark of code once a string, a template or a pattern closes: a `/` after it divides. */
const VALUE_END = ")";

/**
 * The source of the module at `rel` (workspace-relative) with every old name and every specifier
 * of a moved module rewritten. Idempotent: text that uses only the new names comes back unchanged.
 */
export function renameInSource(rel: string, text: string): string {
  const moved = text.replace(RELATIVE_SPECIFIER, (whole, quote: string, specifier: string) => {
    const target = movedSpecifier(rel, specifier);
    return target === null ? whole : `${quote}${target}${quote}`;
  });
  return pieces(moved).map(renameInPiece).join("");
}

/** One piece with its old names rewritten, an English one only where it is code. */
function renameInPiece(piece: Piece): string {
  let out = piece.text;
  for (const rule of NAME_RULES)
    if (!rule.english || namesInCode(piece, rule.from)) out = out.replace(rule.pattern, rule.to);
  return out;
}

/** Whether `name` in `piece` is code: the piece is code, or a quoted string that is only the name. */
function namesInCode(piece: Piece, name: string): boolean {
  return piece.kind === PieceKind.Code || piece.text === `"${name}"` || piece.text === `'${name}'`;
}

/** A scan of one module's text into pieces (`pieces`). */
interface Scan {
  source: string;
  out: Piece[];
  at: number;
  /** Where the code not yet added to `out` begins. */
  codeFrom: number;
  /** The code's last word or mark, which tells a pattern from a division. */
  last: string;
  /** Per open template `${`, the braces opened inside it and not yet closed. */
  braces: number[];
}

/**
 * `source` cut into code, comments, and the text of strings, templates and regular expressions, in
 * order: the pieces joined give `source` back. A template's `${…}` is code again.
 */
function pieces(source: string): Piece[] {
  const scan: Scan = { source, out: [], at: 0, codeFrom: 0, last: "", braces: [] };
  while (scan.at < source.length) step(scan);
  endCode(scan);
  return scan.out;
}

/** Move the scan past one comment, string, template text, pattern, word or mark. */
function step(scan: Scan): void {
  const { source, at } = scan;
  const c = source.charAt(at);
  const two = source.slice(at, at + 2);
  if (two === "//") cut(scan, PieceKind.Comment, lineEnd(source, at));
  else if (two === "/*") cut(scan, PieceKind.Comment, blockCommentEnd(source, at));
  else if (c === '"' || c === "'") cut(scan, PieceKind.Text, quotedEnd(source, at));
  else if (c === "`") templateText(scan);
  else if (c === "}" && scan.braces.at(-1) === 0) {
    scan.braces.pop();
    templateText(scan);
  } else if (c === "/" && opensPattern(scan.last)) pattern(scan);
  else codeMark(scan, c);
}

/** Add the code before the scan position, then the piece from there to `end`. */
function cut(scan: Scan, kind: PieceKind, end: number): void {
  endCode(scan);
  scan.out.push({ kind, text: scan.source.slice(scan.at, end) });
  scan.at = end;
  scan.codeFrom = end;
  if (kind === PieceKind.Text) scan.last = VALUE_END;
}

function endCode(scan: Scan): void {
  if (scan.at > scan.codeFrom) scan.out.push({ kind: PieceKind.Code, text: scan.source.slice(scan.codeFrom, scan.at) });
  scan.codeFrom = scan.at;
}

/** A template's text from its backtick or an expression's closing `}`, to its next `${` or its end. */
function templateText(scan: Scan): void {
  const { end, opensExpression } = templateTextEnd(scan.source, scan.at + 1);
  cut(scan, PieceKind.Text, end);
  if (!opensExpression) return;
  scan.braces.push(0);
  scan.last = "{";
}

function templateTextEnd(source: string, from: number): { end: number; opensExpression: boolean } {
  let at = from;
  while (at < source.length) {
    const c = source.charAt(at);
    if (c === "`") return { end: at + 1, opensExpression: false };
    if (c === "$" && source.charAt(at + 1) === "{") return { end: at + 2, opensExpression: true };
    at += c === "\\" ? 2 : 1;
  }
  return { end: source.length, opensExpression: false };
}

/** A regular expression's text, or a lone `/` that turned out to divide. */
function pattern(scan: Scan): void {
  const end = patternEnd(scan.source, scan.at);
  if (end === null) codeMark(scan, "/");
  else cut(scan, PieceKind.Text, end);
}

/** Past the regular expression opened at `start`, flags included; null when its line never closes it. */
function patternEnd(source: string, start: number): number | null {
  let inClass = false;
  let at = start + 1;
  while (at < source.length) {
    const c = source.charAt(at);
    if (c === "\n") return null;
    if (c === "/" && !inClass) return at + 1 + wordAt(source, at + 1).length;
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    at += c === "\\" ? 2 : 1;
  }
  return null;
}

/** Step over one word or mark of code, keeping count of the braces inside a template's `${…}`. */
function codeMark(scan: Scan, c: string): void {
  const word = wordAt(scan.source, scan.at);
  if (word) {
    scan.last = word;
    scan.at += word.length;
    return;
  }
  const open = scan.braces.length - 1;
  if (open >= 0 && c === "{") scan.braces[open] += 1;
  if (open >= 0 && c === "}") scan.braces[open] -= 1;
  // A `!` right after a value is the non-null assertion (`a[i]! / n`): the value still ends there.
  const assertsValue = c === "!" && !opensPattern(scan.last);
  if (c.trim() && !assertsValue) scan.last = c;
  scan.at += 1;
}

/** Whether a `/` after the code's last word or mark opens a regular expression rather than dividing. */
function opensPattern(last: string): boolean {
  if (/^[\w$]+$/.test(last)) return PATTERN_AFTER_WORDS.has(last);
  return last !== VALUE_END && last !== "]";
}

function wordAt(source: string, at: number): string {
  WORD.lastIndex = at;
  return WORD.exec(source)?.[0] ?? "";
}

function lineEnd(source: string, at: number): number {
  const end = source.indexOf("\n", at);
  return end === -1 ? source.length : end;
}

function blockCommentEnd(source: string, at: number): number {
  const end = source.indexOf("*/", at + 2);
  return end === -1 ? source.length : end + 2;
}

/** Past the string opened at `start`: its closing quote, or the end of its line when it has none. */
function quotedEnd(source: string, start: number): number {
  const quote = source.charAt(start);
  let at = start + 1;
  while (at < source.length) {
    const c = source.charAt(at);
    if (c === quote) return at + 1;
    if (c === "\n") return at;
    at += c === "\\" ? 2 : 1;
  }
  return source.length;
}

/** The specifier the module at `rel` reaches a moved module by, or null when `specifier` names none. */
function movedSpecifier(rel: string, specifier: string): string | null {
  const from = path.posix.dirname(rel);
  const moved = RENAMED_SEED_FILES[path.posix.normalize(path.posix.join(from, specifier))];
  if (!moved) return null;
  const relative = path.posix.relative(from, moved);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
