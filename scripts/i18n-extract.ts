// The app's translatable messages, read out of its `t()` and `tc()` calls (src/shared/i18n.ts).
// Writes src/shared/locales/messages.ts, the list every language's catalog is checked against,
// and, with --context, .studio-dev/i18n/messages.json: each message with where it is used and the
// code around it, for whoever translates it. --check fails when messages.ts is out of date.
import ts from "@typescript/typescript6";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageArguments, messageKey, MessageSyntaxError } from "../src/shared/i18n.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The generated list of messages, by repository path. */
export const MESSAGES_FILE = "src/shared/locales/messages.ts";
/** Where --context writes the translators' notes (ignored by git). */
const CONTEXT_FILE = ".studio-dev/i18n/messages.json";
/** Lines of code around a call the translators' notes quote. */
const CONTEXT_LINES = 3;
/** Agent payload and the catalogs themselves hold no app messages. */
const SKIPPED = [/^src\/harness-seed\//, /^src\/game-template\//, /^src\/shared\/locales\//];

/** One place a message is asked for. */
export interface MessageUse {
  file: string;
  line: number;
  code: string;
}

/** A message: its catalog key, its English and context, and every place it is used. */
export interface ExtractedMessage {
  key: string;
  source: string;
  context?: string;
  uses: MessageUse[];
}

/** A call the extractor cannot read: its first arguments must be plain strings. */
export interface ExtractProblem {
  file: string;
  line: number;
  problem: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The named imports of a statement that imports shared/i18n.ts; none for any other statement. */
function i18nImports(statement: ts.Statement): readonly ts.ImportSpecifier[] {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
  if (!/(^|\/)i18n\.ts$/.test(statement.moduleSpecifier.text)) return [];
  const bindings = statement.importClause?.namedBindings;
  return bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
}

/** The local names `t` and `tc` go by in a file that imports them from shared/i18n.ts. */
function translatorNames(file: ts.SourceFile): { t: Set<string>; tc: Set<string> } {
  const names = { t: new Set<string>(), tc: new Set<string>() };
  for (const element of file.statements.flatMap(i18nImports)) {
    const imported = (element.propertyName ?? element.name).text;
    if (imported === "t") names.t.add(element.name.text);
    if (imported === "tc") names.tc.add(element.name.text);
  }
  return names;
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function codeAround(lines: readonly string[], line: number): string {
  const from = Math.max(0, line - 1 - CONTEXT_LINES);
  return lines.slice(from, line + CONTEXT_LINES).join("\n");
}

/** What one file's calls add: messages by key, and calls that cannot be read. */
interface Collected {
  byKey: Map<string, ExtractedMessage>;
  problems: ExtractProblem[];
}

/** One `t()`/`tc()` call: its message added to `collected`, or why it cannot be read. */
function collectCall(
  call: ts.CallExpression,
  isTc: boolean,
  where: { file: string; lines: readonly string[]; line: number },
  collected: Collected,
): void {
  const { file, line } = where;
  const context = isTc ? literalText(call.arguments[0]) : undefined;
  const source = literalText(call.arguments[isTc ? 1 : 0]);
  if (source === undefined || (isTc && context === undefined)) {
    collected.problems.push({
      file,
      line,
      problem: `${call.expression.getText()}() needs plain string arguments to be translated`,
    });
    return;
  }
  const key = messageKey(context, source);
  const message = collected.byKey.get(key) ?? { key, source, ...(context ? { context } : {}), uses: [] };
  message.uses.push({ file, line, code: codeAround(where.lines, line) });
  collected.byKey.set(key, message);
  try {
    messageArguments(source);
  } catch (error) {
    if (!(error instanceof MessageSyntaxError)) throw error;
    collected.problems.push({ file, line, problem: error.message });
  }
}

/** Every call in one source file to the translators it imports. */
function collectFile(file: string, text: string, collected: Collected): void {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const names = translatorNames(sourceFile);
  if (!names.t.size && !names.tc.size) return;
  const lines = text.split("\n");
  const visit = (node: ts.Node): void => {
    const callee = ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : "";
    if (callee && (names.t.has(callee) || names.tc.has(callee))) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      collectCall(node as ts.CallExpression, names.tc.has(callee), { file, lines, line }, collected);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Every message asked for in the repository's sources, and the calls it could not read. */
export function extractMessages(root = ROOT): { messages: ExtractedMessage[]; problems: ExtractProblem[] } {
  const collected: Collected = { byKey: new Map(), problems: [] };
  for (const full of sourceFiles(path.join(root, "src"))) {
    const file = path.relative(root, full).split(path.sep).join("/");
    if (SKIPPED.some((pattern) => pattern.test(file))) continue;
    const text = fs.readFileSync(full, "utf8");
    if (text.includes("i18n.ts")) collectFile(file, text, collected);
  }
  const messages = [...collected.byKey.values()].sort((a, b) => compareKeys(a.key, b.key));
  return { messages, problems: collected.problems };
}

/** Code-unit order, so the list reads the same on every machine. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A string literal quoted as Biome writes it: double quotes unless single ones need fewer escapes. */
function literal(text: string): string {
  const json = JSON.stringify(text);
  const doubles = text.split('"').length - 1;
  const singles = text.split("'").length - 1;
  if (doubles <= singles) return json;
  return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** messages.ts for a set of messages, formatted as Biome would leave it. */
export function messagesModule(messages: readonly ExtractedMessage[]): string {
  const keys = messages.map((message) => `\n  ${literal(message.key)},`).join("");
  return `// Generated by \`npm run i18n:extract\` from the app's t() and tc() calls; do not edit.

/** Every message the app asks for, by catalog key: its English, or its context and English joined by U+0004. */
export const MESSAGES = [${keys}${keys ? "\n" : ""}] as const;

/** A catalog key the app asks for. */
export type MessageKey = (typeof MESSAGES)[number];

/** One language's translations: a key the app no longer asks for is an error, a missing one shows English. */
export type LocaleCatalog = { readonly [K in MessageKey]?: string };
`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const withContext = process.argv.includes("--context");
  const { messages, problems } = extractMessages();
  for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.problem}`);
  if (problems.length) process.exit(1);
  const target = path.join(ROOT, MESSAGES_FILE);
  const next = messagesModule(messages);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (check) {
    if (current === next) return;
    console.error(`${MESSAGES_FILE} is out of date: run npm run i18n:extract`);
    process.exit(1);
  }
  if (current !== next) fs.writeFileSync(target, next);
  if (withContext) {
    const contextFile = path.join(ROOT, CONTEXT_FILE);
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    fs.writeFileSync(contextFile, `${JSON.stringify(messages, null, 1)}\n`);
  }
  console.log(`${messages.length} messages`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
