import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A vocabulary (engine ids, event names, status codes, host methods) is spelled once, in its home
// module, and read everywhere else through its `as const` object: `EngineId.Codex`, not "codex".
// This check fails on the raw spellings the readability pass removed, so they cannot come back.
// It reads src/** and scripts/** (tests may spell wire values: that is what they pin) and knows
// nothing about types, so each rule matches one narrow, unambiguous shape.

/** The shapes this check refuses. The ids name a rule in its report. */
export const VocabularyRule = {
  EventType: "event-type",
  EngineId: "engine-id",
  StatusCode: "status-code",
  HostCall: "host-call",
  RpcKey: "rpc-key",
  Sleep: "sleep",
} as const;
export type VocabularyRule = (typeof VocabularyRule)[keyof typeof VocabularyRule];

/** One raw spelling: where it is, which rule it breaks, and the line it sits on. */
export interface VocabularyFinding {
  file: string;
  line: number;
  rule: VocabularyRule;
  text: string;
}

interface RuleSpec {
  /** The files the rule reads, by repository path. */
  applies: (file: string) => boolean;
  /**
   * The rule's homes: the one module that defines the vocabulary may spell it. Anything else
   * listed here names its reason beside it; a module that needs a raw spelling of the vocabulary
   * itself defines its own vocabulary instead.
   */
  homes: readonly string[];
  patterns: readonly RegExp[];
  /** What to write instead, for the report. */
  instead: string;
}

const ENGINE = String.raw`(["\x60])(?:claude-code|codex|ollama|bonsai)\1`;
const LITERAL = String.raw`(?:"|\x60(?!\$\{))`;
const EVERYWHERE = () => true;
const inSeed = (file: string) => file.startsWith("src/harness-seed/");

const RULES: Record<VocabularyRule, RuleSpec> = {
  [VocabularyRule.EventType]: {
    applies: EVERYWHERE,
    homes: ["src/shared/custom-events.ts", "src/harness-seed/loop/run-events.ts"],
    patterns: [new RegExp(String.raw`\bevent_type\s*:\s*${LITERAL}`)],
    instead:
      "customEventData(CustomEvent.X, payload) in the app, RunEvent.X in the seed, DELEGATED_PREFIX for delegated.*",
  },
  [VocabularyRule.EngineId]: {
    applies: EVERYWHERE,
    homes: [
      "src/shared/providers.ts",
      // The seed's own EngineId: the seed never imports src/shared.
      "src/harness-seed/loop/model-roles.ts",
      // Codex's rate-limit bucket id is spelled "codex" too, but it is Codex's wire value, not an engine id.
      "src/shared/provider-usage.ts",
    ],
    // Compared, a default, a case, an argument or array element, assigned, or returned.
    patterns: [
      new RegExp(String.raw`(?:[!=]==?|\?\?|\|\||&&)\s*${ENGINE}`),
      new RegExp(String.raw`${ENGINE}\s*[!=]==?`),
      new RegExp(String.raw`\bcase\s+${ENGINE}`),
      new RegExp(String.raw`[(\[,]\s*${ENGINE}\s*(?=[,)\]])`),
      new RegExp(String.raw`(?:^|[^=!<>])=\s*${ENGINE}`),
      new RegExp(String.raw`(?:\breturn|=>)\s*${ENGINE}`),
    ],
    instead: "EngineId.ClaudeCode, EngineId.Codex, EngineId.Bonsai, EngineId.Ollama",
  },
  [VocabularyRule.StatusCode]: {
    applies: EVERYWHERE,
    homes: ["src/shared/engine-descriptor.ts"],
    patterns: [
      new RegExp(String.raw`\bstatus\)?\??\.code\s*[!=]==?\s*${LITERAL}`),
      new RegExp(String.raw`${LITERAL}[\w-]*["\x60]\s*[!=]==?\s*[\w.?]*\bstatus\??\.code\b`),
      /\.code\s*[!=]==?\s*"(?:ready|not_installed|not_running|needs_login)"/,
    ],
    instead: "EngineStatusCode.Ready (or isEngineReady / needsSignIn)",
  },
  [VocabularyRule.HostCall]: {
    applies: inSeed,
    homes: ["src/harness-seed/loop/host-methods.ts"],
    patterns: [new RegExp(String.raw`\.call\(\s*${LITERAL}`)],
    instead: "ctx.call(HostMethod.X, params)",
  },
  [VocabularyRule.RpcKey]: {
    applies: (file) => file.startsWith("src/main/harness-rpc/"),
    homes: [],
    patterns: [/(?:^|[{,\s[])"[a-z][\w-]*(?:\.[\w-]+)+"\s*\]?\s*[:(]/],
    instead: "[HostMethod.X]: handler",
  },
  [VocabularyRule.Sleep]: {
    applies: EVERYWHERE,
    homes: [
      "src/harness-seed/loop/time.ts",
      // Serialized with toString() and run inside the game page, where nothing can be imported.
      "src/substrate/audio-observation.ts",
    ],
    patterns: [/new\s+Promise\s*(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*(?:void\s+)?setTimeout\(\s*\1\s*,/],
    instead: 'sleep() from "node:timers/promises" (the seed: sleep from loop/time.ts)',
  },
};

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out"]);
// The game templates are the game's own code, addressed to the in-app agent: none of these
// vocabularies reach them.
const SKIPPED_TREES = ["src/game-template/", "src/game-template-cpp/", "src/game-template-rust/"];

// A `/` starts a regular expression after these; after a name, `)` or `]` it divides.
const REGEX_AFTER = new Set([..."(,=:[!&|?{;+-*%>~^"]);
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

/** Blank the characters of a string's or template's text that could read as code: its quotes. */
const quiet = (ch: string) => (ch === '"' || ch === "'" || ch === "`" ? "_" : ch);

/** The source walker's position and the text it has written so far. */
interface Mask {
  text: string;
  at: number;
  out: string[];
  /** The last character of code (not space, comment or string) written, for the regex rule. */
  lastCode: string;
}

function lineComment(m: Mask): void {
  while (m.at < m.text.length && m.text[m.at] !== "\n") {
    m.out.push(" ");
    m.at++;
  }
}

function blockComment(m: Mask): void {
  const end = m.text.indexOf("*/", m.at + 2);
  const stop = end < 0 ? m.text.length : end + 2;
  for (; m.at < stop; m.at++) m.out.push(m.text[m.at] === "\n" ? "\n" : " ");
}

/** A '…' or "…" string, written as "…" with its inner quotes blanked. A newline ends a broken one. */
function quoted(m: Mask): void {
  const close = m.text[m.at];
  m.out.push('"');
  m.at++;
  while (m.at < m.text.length) {
    const ch = m.text[m.at];
    if (ch === "\n") return;
    if (ch === "\\") {
      m.out.push("\\", quiet(m.text[m.at + 1] ?? ""));
      m.at += 2;
      continue;
    }
    m.at++;
    if (ch === close) {
      m.out.push('"');
      m.lastCode = '"';
      return;
    }
    m.out.push(quiet(ch));
  }
}

/** A template: its text with quotes blanked, and each `${…}` walked as code. */
function template(m: Mask): void {
  m.out.push("`");
  m.at++;
  while (m.at < m.text.length) {
    const ch = m.text[m.at];
    if (ch === "\\") {
      m.out.push("\\", quiet(m.text[m.at + 1] ?? ""));
      m.at += 2;
    } else if (ch === "`") {
      m.out.push("`");
      m.at++;
      m.lastCode = "`";
      return;
    } else if (ch === "$" && m.text[m.at + 1] === "{") {
      m.out.push("${");
      m.at += 2;
      code(m, "}");
    } else {
      m.out.push(quiet(ch));
      m.at++;
    }
  }
}

/** A regular expression literal, blanked; a newline ends one that was really a division. */
function regex(m: Mask): void {
  m.out.push("/");
  m.at++;
  let inClass = false;
  while (m.at < m.text.length && m.text[m.at] !== "\n") {
    const ch = m.text[m.at];
    if (ch === "\\") {
      m.out.push("__");
      m.at += 2;
      continue;
    }
    m.at++;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      m.out.push("/");
      m.lastCode = "/";
      return;
    }
    m.out.push("_");
  }
}

function startsRegex(m: Mask): boolean {
  if (!m.lastCode || REGEX_AFTER.has(m.lastCode)) return true;
  return REGEX_AFTER_WORD.test(m.text.slice(Math.max(0, m.at - 12), m.at).trimEnd());
}

/** What the walker does at a character: a handler that consumes it, or nothing for plain code. */
function specialAt(m: Mask): ((m: Mask) => void) | undefined {
  const ch = m.text[m.at];
  const next = m.text[m.at + 1];
  if (ch === "/" && next === "/") return lineComment;
  if (ch === "/" && next === "*") return blockComment;
  if (ch === '"' || ch === "'") return quoted;
  if (ch === "`") return template;
  if (ch === "/" && startsRegex(m)) return regex;
  return undefined;
}

/** Walk code up to the `until` brace that closes it (a template's `${…}`), or to the end. */
function code(m: Mask, until?: string): void {
  let depth = 0;
  while (m.at < m.text.length) {
    const special = specialAt(m);
    if (special) {
      special(m);
      continue;
    }
    const ch = m.text[m.at];
    if (ch === "{") depth++;
    if (ch === "}" && depth-- === 0 && until) {
      m.out.push("}");
      m.at++;
      m.lastCode = "}";
      return;
    }
    m.out.push(ch);
    m.at++;
    if (!/\s/.test(ch)) m.lastCode = ch;
  }
}

/**
 * The source with comments blanked, every string written as "…" and the quotes inside strings,
 * templates and regular expressions blanked, so a pattern sees only code. Offsets and line
 * breaks are kept, so a match's line is the source's line.
 */
export function maskSource(text: string): string {
  const m: Mask = { text, at: 0, out: [], lastCode: "" };
  code(m);
  return m.out.join("");
}

const TYPE_ALIAS = /^\s*(?:export\s+)?type\s+\w+/;

/** A match on a type alias's line (`type Pick = "codex" | …`): a type, not a value in use. */
function inTypeAlias(masked: string, index: number): boolean {
  const lineStart = masked.lastIndexOf("\n", index) + 1;
  return TYPE_ALIAS.test(masked.slice(lineStart, index));
}

/** The 1-based line of each offset, from where each line starts. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= offset) line++;
    return line + 1;
  };
}

/** The offsets where one rule's patterns match the masked source (type aliases aside for engine ids). */
function ruleMatches(rule: VocabularyRule, masked: string): number[] {
  return RULES[rule].patterns.flatMap((pattern) =>
    [...masked.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
      // Where the literal's context starts, past the space a pattern may begin with.
      .map((match) => (match.index ?? 0) + (match[0].length - match[0].trimStart().length))
      .filter((offset) => rule !== VocabularyRule.EngineId || !inTypeAlias(masked, offset)),
  );
}

/** The rules a file answers to: those that read it, less the ones it is a home of. */
const rulesFor = (file: string): VocabularyRule[] =>
  (Object.keys(RULES) as VocabularyRule[]).filter(
    (rule) => RULES[rule].applies(file) && !RULES[rule].homes.includes(file),
  );

/** Every raw vocabulary spelling in one file, by its repository path: one per rule and line. */
export function findRawVocabulary(file: string, source: string): VocabularyFinding[] {
  const rules = rulesFor(file);
  if (!rules.length) return [];
  const masked = maskSource(source);
  const lines = source.split("\n");
  const lineOf = lineIndex(source);
  const findings = new Map<string, VocabularyFinding>();
  for (const rule of rules) {
    for (const offset of ruleMatches(rule, masked)) {
      const line = lineOf(offset);
      const key = `${rule}:${line}`;
      if (!findings.has(key)) findings.set(key, { file, line, rule, text: (lines[line - 1] ?? "").trim() });
    }
  }
  return [...findings.values()].sort((a, b) => a.line - b.line);
}

/** Every checked file under the roots: code in src/ and scripts/, minus build output and the game template. */
export function vocabularyFiles(root: string, roots: readonly string[] = ["src", "scripts"]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(rel);
      const skipped = SKIPPED_TREES.some((tree) => rel.startsWith(tree)) || rel.endsWith(".d.ts");
      if (entry.isFile() && CODE.test(entry.name) && !skipped) files.push(rel);
    }
  };
  for (const dir of roots) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return files.sort();
}

/** The report lines for every raw spelling in the files; empty when there is none. */
export function checkVocabulary(root: string, files: readonly string[] = vocabularyFiles(root)): string[] {
  return files.flatMap((file) =>
    findRawVocabulary(file, fs.readFileSync(path.join(root, file), "utf8")).map(
      (f) => `${f.file}:${f.line}: raw ${f.rule} literal — write ${RULES[f.rule].instead}\n    ${f.text}`,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const started = performance.now();
  const files = vocabularyFiles(root);
  const errors = checkVocabulary(root, files);
  const ms = Math.round(performance.now() - started);
  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`Vocabulary: ${errors.length} raw literal(s); see AGENTS.md, Readability.`);
    process.exitCode = 1;
  } else console.log(`Vocabulary: no raw literals in ${files.length} files (${ms} ms)`);
}
