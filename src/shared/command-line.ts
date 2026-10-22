/**
 * A command line as a person types it in Terminal, split into the words a program receives, and
 * back. Only quoting is understood: nothing is expanded (`$HOME`, `~`, `*` stay as typed) and
 * `|`, `;` and `&&` are plain words, because the words go straight to the program with no shell.
 * Pure and renderer-safe.
 */

/** Why a line could not be split. */
export const CommandLineProblem = {
  UnclosedQuote: "unclosed-quote",
  TrailingBackslash: "trailing-backslash",
} as const;
export type CommandLineProblem = (typeof CommandLineProblem)[keyof typeof CommandLineProblem];

/** The words of a line, or why it has none that can be trusted. */
export type CommandLineSplit = { ok: true; words: string[] } | { ok: false; problem: CommandLineProblem };

/** Characters a double-quoted backslash escapes; before any other, the backslash stays. */
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);
/** A word made only of these needs no quotes. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Where the scan stands: the words so far, the one being built, and whether it has begun. */
interface Scan {
  words: string[];
  word: string;
  started: boolean;
}

/** End the current word, if one has begun (an empty `''` has). */
function endWord(scan: Scan): void {
  if (scan.started) scan.words.push(scan.word);
  scan.word = "";
  scan.started = false;
}

/** Read a quoted stretch starting after its opening quote; the index after its closing one, or -1. */
function readQuoted(line: string, from: number, quote: string, scan: Scan): number {
  for (let i = from; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === quote) return i + 1;
    const next = line.charAt(i + 1);
    if (quote === '"' && char === "\\" && next === "\n") {
      i++;
      continue;
    }
    if (quote === '"' && char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      scan.word += next;
      i++;
      continue;
    }
    scan.word += char;
  }
  return -1;
}

/** The character after an unquoted backslash, taken as itself; false when the line ends there. */
function readEscaped(line: string, at: number, scan: Scan): boolean {
  if (at >= line.length) return false;
  const next = line.charAt(at);
  // A backslash before a line break continues the line, as READMEs wrap long commands.
  if (next === "\n") return true;
  scan.word += next;
  scan.started = true;
  return true;
}

/** Split a line the way a POSIX shell quotes it, without expanding anything. */
export function splitCommandLine(line: string): CommandLineSplit {
  const scan: Scan = { words: [], word: "", started: false };
  let i = 0;
  while (i < line.length) {
    const char = line.charAt(i);
    if (/\s/.test(char)) {
      endWord(scan);
      i++;
      continue;
    }
    if (char === "\\") {
      if (!readEscaped(line, i + 1, scan)) return { ok: false, problem: CommandLineProblem.TrailingBackslash };
      i += 2;
      continue;
    }
    scan.started = true;
    if (char !== "'" && char !== '"') {
      scan.word += char;
      i++;
      continue;
    }
    const after = readQuoted(line, i + 1, char, scan);
    if (after < 0) return { ok: false, problem: CommandLineProblem.UnclosedQuote };
    i = after;
  }
  endWord(scan);
  return { ok: true, words: scan.words };
}

/** One word as Terminal would need it typed: bare when plain, else in single quotes. */
function quoteWord(word: string): string {
  if (PLAIN_WORD.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

/** The line that `splitCommandLine` reads back as exactly these words. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map(quoteWord).join(" ");
}
