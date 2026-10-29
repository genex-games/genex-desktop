/**
 * `check-scripts`: the game's `.luau` files under `src/` checked without Studio. luau-lsp checks
 * types with Roblox's definitions and a sourcemap of `src/` (`sourcemap.ts`, or the game's own
 * `sourcemap.json` when a Rojo project keeps one), selene lints with Roblox's library and StyLua
 * checks the format. The three run side by side from the game folder, each by its full path with an
 * argument list (never a shell), within its own time limit and output cap, and their findings come
 * back as plain lines at a file and line. A program that hangs, floods or fails is named, never
 * taken for a clean check.
 *
 * A file every program found clean is remembered (its sha256, with the programs that checked it, in
 * the plugin's storage) and checked again only once it changes; a file with findings is checked
 * each time. At a worker's end the changed files are checked and noted; before a finish every file
 * is, and only errors hold the finish back: warnings and format differences are notes.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { type HookAnswer, HOOK_NOTE_CHARS, HOOK_REASON_CHARS } from "../../shared/plugin-hooks.ts";
import { atomicWriteJson, atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { LUAU_FOLDER, LuauTool, type LuauToolset, seleneEnv } from "./luau-tools.ts";
import { SCRIPTS_FOLDER } from "./script-paths.ts";
import { scriptFiles, sourcemapOf } from "./sourcemap.ts";
import { isGameId } from "./studio-binding.ts";
import { SETUP_PROMPTS } from "./setup-prompts.ts";
import { MESSAGE } from "./words.ts";

/** What a finding is. Wire values: never rename. */
export const FindingKind = { Error: "error", Warning: "warning", Format: "format" } as const;
export type FindingKind = (typeof FindingKind)[keyof typeof FindingKind];

/** One thing a program found, at a file below the game folder (`src/…`, `/`-separated) and a line. */
export interface LuauFinding {
  tool: LuauTool;
  kind: FindingKind;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  rule?: string;
  message: string;
}

/** How long each program may run: luau-lsp reads every module a checked file requires. */
export const CHECK_TOOL_MAX_MS = {
  [LuauTool.LuauLsp]: 90 * SECOND_MS,
  [LuauTool.Selene]: 60 * SECOND_MS,
  [LuauTool.StyLua]: 30 * SECOND_MS,
} as const satisfies Record<LuauTool, number>;
/** The longest a check takes: its programs run side by side. */
export const CHECK_MAX_MS = Math.max(...Object.values(CHECK_TOOL_MAX_MS));
/** The most a program may print on each stream; past it the program is stopped. */
export const MAX_CHECK_OUTPUT_BYTES = 2 * 1024 * 1024;
/** The most files one check names on a command line (Windows takes about 32,000 characters). */
export const MAX_CHECK_FILES = 300;
/** The largest script a check fingerprints; a larger one is always checked. */
const MAX_FINGERPRINT_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** How many finding lines a hook's note keeps before the count of the rest. */
const NOTE_LINES = 20;
const BYTES_PER_MB = 1024 * 1024;
/** The exit codes that mean a program checked: 0 clean, 1 something found. */
const CHECKED_CODES: ReadonlySet<number | null> = new Set([0, 1]);

/** How each program is named in a line. */
const TOOL_LABEL = {
  [LuauTool.LuauLsp]: "luau-lsp",
  [LuauTool.Selene]: "selene",
  [LuauTool.StyLua]: "StyLua",
} as const satisfies Record<LuauTool, string>;

/** The settings a new game starts with: selene with Roblox's library, StyLua in Roblox's common style. */
export const CHECK_CONFIGS = {
  "selene.toml": 'std = "roblox"\n',
  "stylua.toml": [
    "column_width = 120",
    'line_endings = "Unix"',
    'indent_type = "Tabs"',
    "indent_width = 4",
    'quote_style = "AutoPreferDouble"',
    'call_parentheses = "Always"',
    "",
  ].join("\n"),
} as const;
const SELENE_CONFIG = "selene.toml";
/** A Rojo project's own sourcemap, which luau-lsp then reads instead of Genex's. */
const OWN_SOURCEMAP = "sourcemap.json";
/** Where the clean files are remembered, per game, in the storage's luau folder. */
const CLEAN_FOLDER = "clean";

/** How a program is run: from `cwd`, with extra environment, until `signal` ends it. */
export interface CheckRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** What a program did: its exit code (null when stopped), what it printed, whether it was cut or stopped. */
export interface CheckRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cut: boolean;
  stopped: boolean;
}

/** Runs a program by its full path with an argument list; rejects when it can't start. */
export type CheckRun = (file: string, args: readonly string[], options: CheckRunOptions) => Promise<CheckRunResult>;

/** Collects a stream up to the cap; past it, `onCut` once. */
function capped(onCut: () => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add(chunk: Buffer) {
      if (size >= MAX_CHECK_OUTPUT_BYTES) return;
      size += chunk.length;
      chunks.push(chunk);
      if (size >= MAX_CHECK_OUTPUT_BYTES) onCut();
    },
    text: () => Buffer.concat(chunks).subarray(0, MAX_CHECK_OUTPUT_BYTES).toString("utf8"),
  };
}

/**
 * This computer's runner: spawn (no shell, no window on Windows), each stream kept up to
 * {@link MAX_CHECK_OUTPUT_BYTES}. A program past the cap, or whose signal ends, is killed.
 */
export const systemCheckRun: CheckRun = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let cut = false;
    let stopped = false;
    const kill = () => child.kill("SIGKILL");
    const out = capped(() => {
      cut = true;
      kill();
    });
    const err = capped(() => {
      cut = true;
      kill();
    });
    const stop = () => {
      stopped = true;
      kill();
    };
    if (options.signal.aborted) stop();
    options.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", out.add);
    child.stderr.on("data", err.add);
    child.once("error", (error) => {
      options.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", stop);
      resolve({ code, stdout: out.text(), stderr: err.text(), cut, stopped });
    });
  });

/** `/`-separated, for paths printed on either system. */
const slashed = (file: string) => file.replaceAll("\\", "/");

/** A printed path as a path below the game folder, when it is inside it; else as printed. */
function inFolder(printed: string, folder: string): string {
  const file = slashed(printed);
  const root = `${slashed(folder).replace(/\/+$/, "")}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

/** luau-lsp's `--formatter=gnu` line: path, optional `[module]`, line.col-line.col, the rule and the message. */
const LUAU_LSP_LINE = /^(.+?)(?: \[[^\]]*\])?:(\d+)\.(\d+)-(\d+)\.(\d+): ([A-Za-z]+): (.*)$/;
/** luau-lsp's rules that are errors; every other rule is a lint, a warning. */
const LUAU_LSP_ERRORS: ReadonlySet<string> = new Set(["TypeError", "SyntaxError"]);

/** luau-lsp's findings in what it printed (`--formatter=gnu`), its own log lines skipped. */
export function parseLuauLsp(text: string, folder: string): LuauFinding[] {
  const found: LuauFinding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LUAU_LSP_LINE.exec(line);
    if (!match || line.startsWith("[")) continue;
    const [, file = "", start = "0", column = "0", , , rule = "", message = ""] = match;
    const kind = LUAU_LSP_ERRORS.has(rule) ? FindingKind.Error : FindingKind.Warning;
    found.push({
      tool: LuauTool.LuauLsp,
      kind,
      file: inFolder(file, folder),
      line: Number(start),
      column: Number(column),
      rule,
      message,
    });
  }
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Each line of `text` that is a JSON value, parsed; other lines skipped. */
function jsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // Not one of the program's JSON lines.
    }
  }
  return values;
}

const numberOr = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);

/** selene's findings in what it printed (`--display-style=Json2`): lines and columns count from zero. */
export function parseSelene(text: string): LuauFinding[] {
  const found: LuauFinding[] = [];
  for (const value of jsonLines(text)) {
    if (!isRecord(value) || value.type !== "Diagnostic" || !isRecord(value.primary_label)) continue;
    const label = value.primary_label;
    const span = isRecord(label.span) ? label.span : {};
    if (typeof label.filename !== "string") continue;
    found.push({
      tool: LuauTool.Selene,
      kind: value.severity === "Error" ? FindingKind.Error : FindingKind.Warning,
      file: slashed(label.filename),
      line: numberOr(span.start_line, 0) + 1,
      column: numberOr(span.start_column, 0) + 1,
      rule: String(value.code ?? ""),
      message: String(value.message ?? ""),
    });
  }
  return found;
}

/** A StyLua file whose layout differs: each difference from its first line (counted from zero). */
function styluaMismatches(value: Record<string, unknown>): LuauFinding[] {
  if (typeof value.file !== "string" || !Array.isArray(value.mismatches)) return [];
  return value.mismatches.filter(isRecord).map((mismatch) => {
    const line = numberOr(mismatch.original_start_line, 0) + 1;
    const endLine = numberOr(mismatch.original_end_line, line - 1) + 1;
    return {
      tool: LuauTool.StyLua,
      kind: FindingKind.Format,
      file: slashed(String(value.file)),
      line,
      endLine,
      message: MESSAGE.Checks.Format(line, endLine),
    };
  });
}

/** A file StyLua couldn't read: an error at its line and column (counted from one). */
function styluaParseError(value: Record<string, unknown>): LuauFinding | undefined {
  if (value.type !== "parse_error" || typeof value.filename !== "string" || !isRecord(value.location)) return undefined;
  return {
    tool: LuauTool.StyLua,
    kind: FindingKind.Error,
    file: slashed(value.filename),
    line: numberOr(value.location.start_line, 0),
    column: numberOr(value.location.start_column, 0),
    rule: "parse_error",
    message: String(value.message ?? ""),
  };
}

/** StyLua's findings in what it printed (`--check --output-format=json`): format differences and parse errors. */
export function parseStylua(text: string): LuauFinding[] {
  const found: LuauFinding[] = [];
  for (const value of jsonLines(text)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries.filter(isRecord)) {
      const parseError = styluaParseError(entry);
      if (parseError) found.push(parseError);
      else found.push(...styluaMismatches(entry));
    }
  }
  return found;
}

/** What a check is given: the runner, Genex's storage, the system and the programs found. */
export interface CheckDeps {
  run: CheckRun;
  storage: string;
  platform: NodeJS.Platform;
  tools: LuauToolset;
  /** A signal that ends after `ms`; the system's timer by default. */
  timeout?(ms: number): AbortSignal;
}

/** Which game folder, which game (for what was clean), and whether every file, not only the changed ones. */
export interface CheckOptions {
  folder: string;
  game?: string;
  all?: boolean;
  /** The person's stop. */
  signal?: AbortSignal;
}

/** A program that didn't check, and why, in plain words. */
export interface CheckFailure {
  tool: LuauTool;
  why: string;
}

/** A check's answer: what it checked and found, and its plain lines. */
export interface ScriptCheck {
  files: string[];
  findings: LuauFinding[];
  ran: LuauTool[];
  missing: LuauTool[];
  failed: CheckFailure[];
  errors: number;
  warnings: number;
  format: number;
  /** Files past {@link MAX_CHECK_FILES}, left for the next check. */
  left: number;
  message: string;
}

/** What is remembered as clean for one game: the programs that checked, and each clean file's sha256. */
interface CleanRecord {
  by: string;
  files: Record<string, string>;
}

const emptyCheck = (message: string, missing: LuauTool[] = []): ScriptCheck => ({
  files: [],
  findings: [],
  ran: [],
  missing,
  failed: [],
  errors: 0,
  warnings: 0,
  format: 0,
  left: 0,
  message,
});

/** The programs a check can run: luau-lsp only with the definitions. */
function runnable(tools: LuauToolset) {
  const missing = Object.values(LuauTool).filter((tool) => !tools.programs[tool]);
  const lspWithoutTypes = Boolean(tools.programs[LuauTool.LuauLsp] && !tools.definitions);
  const ran = Object.values(LuauTool).filter(
    (tool) => tools.programs[tool] && !(tool === LuauTool.LuauLsp && lspWithoutTypes),
  );
  return { ran, missing, lspWithoutTypes };
}

/** The programs and definitions a clean record was made with: a change means every file is checked again. */
const signature = (tools: LuauToolset, ran: readonly LuauTool[]) =>
  JSON.stringify([...ran.map((tool) => tools.programs[tool]?.file ?? ""), tools.definitions ?? ""]);

const recordFile = (storage: string, game: string) => path.join(storage, LUAU_FOLDER, CLEAN_FOLDER, `${game}.json`);

async function readRecord(storage: string, game: string | undefined, by: string): Promise<CleanRecord> {
  const fresh: CleanRecord = { by, files: {} };
  if (!game || !isGameId(game)) return fresh;
  const bytes = await readRegularFile(recordFile(storage, game), MAX_RECORD_BYTES).catch(() => undefined);
  try {
    const value: unknown = bytes && JSON.parse(bytes.toString("utf8"));
    if (isRecord(value) && value.by === by && isRecord(value.files))
      return { by, files: value.files as Record<string, string> };
  } catch {
    // A record that isn't JSON is no record: every file is checked.
  }
  return fresh;
}

/** A script file's sha256, or undefined when it can't be read whole. */
async function fingerprint(folder: string, file: string): Promise<string | undefined> {
  const bytes = await readRegularFile(path.join(folder, ...file.split("/")), MAX_FINGERPRINT_BYTES).catch(
    () => undefined,
  );
  return bytes && createHash("sha256").update(bytes).digest("hex");
}

/** The files to check: every one, or those not remembered clean as they are now. */
async function chooseFiles(folder: string, files: readonly string[], record: CleanRecord, all: boolean) {
  const prints = new Map<string, string | undefined>();
  for (const file of files) prints.set(file, await fingerprint(folder, file));
  const chosen = all
    ? [...files]
    : files.filter((file) => !prints.get(file) || record.files[file] !== prints.get(file));
  return { chosen, prints };
}

/** The storage's luau folder for a check's own files: refused (undefined) when it is a link. */
async function checkFolder(storage: string): Promise<string | undefined> {
  const root = path.join(storage, LUAU_FOLDER);
  await mkdir(root, { recursive: true }).catch(() => undefined);
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return undefined;
  return mkdtemp(path.join(root, ".check-"));
}

/** Whether the game folder holds `name` as a plain file. */
const holds = async (folder: string, name: string) => {
  const info = await lstat(path.join(folder, name)).catch(() => undefined);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
};

/** One program's run: its file, arguments and environment, and how its output is read. */
interface ToolRun {
  tool: LuauTool;
  args: string[];
  env?: NodeJS.ProcessEnv;
  parse(result: CheckRunResult): LuauFinding[];
}

/** Each program's run over `files`, with the sourcemap and selene config it needs. */
async function toolRuns(deps: CheckDeps, folder: string, files: string[], scratch: string | undefined) {
  const { tools } = deps;
  const runs: ToolRun[] = [];
  if (tools.programs[LuauTool.LuauLsp] && tools.definitions && scratch) {
    const own = await holds(folder, OWN_SOURCEMAP);
    const map = own ? OWN_SOURCEMAP : path.join(scratch, OWN_SOURCEMAP);
    if (!own) await writeFile(map, `${JSON.stringify(sourcemapOf(await scriptFiles(folder)))}\n`);
    const args = ["analyze", "--formatter=gnu", "--platform=roblox", `--sourcemap=${map}`];
    runs.push({
      tool: LuauTool.LuauLsp,
      args: [...args, `--definitions=@roblox=${tools.definitions}`, ...files],
      parse: (result) => parseLuauLsp(`${result.stderr}\n${result.stdout}`, folder),
    });
  }
  const selene = tools.programs[LuauTool.Selene];
  if (selene) {
    const config = path.join(deps.storage, LUAU_FOLDER, SELENE_CONFIG);
    const own = await holds(folder, SELENE_CONFIG);
    if (!own) await atomicWriteText(config, CHECK_CONFIGS["selene.toml"]);
    runs.push({
      tool: LuauTool.Selene,
      args: ["--display-style=Json2", "--no-summary", ...(own ? [] : [`--config=${config}`]), ...files],
      ...(selene.ours ? { env: seleneEnv(deps.storage, deps.platform) } : {}),
      parse: (result) => parseSelene(result.stdout),
    });
  }
  if (tools.programs[LuauTool.StyLua])
    runs.push({
      tool: LuauTool.StyLua,
      args: ["--check", "--output-format=json", ...files],
      parse: (result) => parseStylua(result.stdout),
    });
  return runs;
}

/** Why a finished run didn't check, or undefined when it did. */
function failureOf(result: CheckRunResult, tool: LuauTool, timedOut: boolean): string | undefined {
  if (result.cut) return MESSAGE.Checks.Cut(MAX_CHECK_OUTPUT_BYTES / BYTES_PER_MB);
  if (timedOut) return MESSAGE.Checks.TimedOut(CHECK_TOOL_MAX_MS[tool] / SECOND_MS);
  if (result.stopped) return MESSAGE.Checks.Stopped;
  return CHECKED_CODES.has(result.code) ? undefined : MESSAGE.Checks.Code(result.code ?? -1);
}

/** Runs one program within its limit: its findings, or why it didn't check. */
async function runTool(deps: CheckDeps, run: ToolRun, folder: string, signal: AbortSignal | undefined) {
  const program = deps.tools.programs[run.tool]?.file ?? "";
  const limit = (deps.timeout ?? AbortSignal.timeout)(CHECK_TOOL_MAX_MS[run.tool]);
  const ends = AbortSignal.any(signal ? [signal, limit] : [limit]);
  try {
    const result = await deps.run(program, run.args, {
      cwd: folder,
      ...(run.env ? { env: run.env } : {}),
      signal: ends,
    });
    const why = failureOf(result, run.tool, limit.aborted && !signal?.aborted);
    return why ? { tool: run.tool, why } : { tool: run.tool, findings: run.parse(result) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { tool: run.tool, why: MESSAGE.Checks.CouldNotStart(reason) };
  }
}

const TOOL_ORDER = Object.values(LuauTool);
const KIND_ORDER = Object.values(FindingKind);

/** Findings by file, line, column (none first), program and kind: the same order every time. */
function byPlace(a: LuauFinding, b: LuauFinding): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if ((a.column ?? 0) !== (b.column ?? 0)) return (a.column ?? 0) - (b.column ?? 0);
  if (a.tool !== b.tool) return TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool);
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/** A finding as one plain line. */
export function findingLine(finding: LuauFinding): string {
  const column = finding.column ? `:${finding.column}` : "";
  const rule = finding.rule ? ` ${finding.rule}` : "";
  return `${finding.file}:${finding.line}${column} ${finding.kind} (${TOOL_LABEL[finding.tool]}${rule}): ${finding.message}`;
}

/** The counts' words: "3 errors, 3 warnings, 1 format difference". */
const countsOf = (check: Pick<ScriptCheck, "errors" | "warnings" | "format">) =>
  MESSAGE.Checks.Counts(check.errors, check.warnings, check.format);

/** The lines that say what wasn't checked: missing programs, missing definitions, failures, files left. */
function gapLines(check: ScriptCheck, lspWithoutTypes: boolean): string[] {
  const lines: string[] = [];
  const missing = check.missing.map((tool) => TOOL_LABEL[tool]);
  if (missing.length > 0) lines.push(MESSAGE.Checks.Missing(missing));
  if (lspWithoutTypes) lines.push(MESSAGE.Checks.NoDefinitions);
  for (const failure of check.failed) lines.push(MESSAGE.Checks.Failed(TOOL_LABEL[failure.tool], failure.why));
  if (check.left > 0) lines.push(MESSAGE.Checks.Left(check.left));
  return lines;
}

/** A check's plain lines: the counts, each finding, then what wasn't checked. */
function messageOf(check: ScriptCheck, lspWithoutTypes: boolean): string {
  const found = check.findings.length > 0;
  const head = found
    ? MESSAGE.Checks.Summary(check.files.length, countsOf(check))
    : MESSAGE.Checks.Clean(check.files.length);
  return [head, ...check.findings.map(findingLine), ...gapLines(check, lspWithoutTypes)].join("\n");
}

/** Remembers the files every program found clean; the rest are checked again next time. */
async function remember(
  storage: string,
  game: string | undefined,
  record: CleanRecord,
  check: ScriptCheck,
  prints: Map<string, string | undefined>,
) {
  if (!game || !isGameId(game)) return;
  const flagged = new Set(check.findings.map((finding) => finding.file));
  const sound = check.failed.length === 0;
  for (const file of check.files) {
    const print = prints.get(file);
    if (sound && print && !flagged.has(file)) record.files[file] = print;
    else delete record.files[file];
  }
  await atomicWriteJson(recordFile(storage, game), record).catch(() => undefined);
}

/** Checks the game's scripts (the changed ones unless `all`) with every program found. */
export async function checkScripts(deps: CheckDeps, options: CheckOptions): Promise<ScriptCheck> {
  const { ran, missing, lspWithoutTypes } = runnable(deps.tools);
  if (missing.length === TOOL_ORDER.length) return emptyCheck(SETUP_PROMPTS.ChecksNotAdded, missing);
  const folder = await realpath(options.folder);
  const files = (await scriptFiles(folder)).map((file) => `${SCRIPTS_FOLDER}/${file}`);
  if (files.length === 0) return emptyCheck(MESSAGE.Checks.NoScripts, missing);
  const record = await readRecord(deps.storage, options.game, signature(deps.tools, ran));
  const { chosen, prints } = await chooseFiles(folder, files, record, options.all === true);
  if (chosen.length === 0) return emptyCheck(MESSAGE.Checks.AllClean, missing);
  const checked = chosen.slice(0, MAX_CHECK_FILES);
  const scratch = await checkFolder(deps.storage);
  try {
    const runs = await toolRuns(deps, folder, checked, scratch);
    const results = await Promise.all(runs.map((run) => runTool(deps, run, folder, options.signal)));
    const findings = results.flatMap((result) => ("findings" in result ? (result.findings ?? []) : [])).sort(byPlace);
    const check: ScriptCheck = {
      files: checked,
      findings,
      ran: results.filter((result) => "findings" in result).map((result) => result.tool),
      missing,
      failed: results.flatMap((result) =>
        "why" in result && result.why ? [{ tool: result.tool, why: result.why }] : [],
      ),
      errors: findings.filter((finding) => finding.kind === FindingKind.Error).length,
      warnings: findings.filter((finding) => finding.kind === FindingKind.Warning).length,
      format: findings.filter((finding) => finding.kind === FindingKind.Format).length,
      left: chosen.length - checked.length,
      message: "",
    };
    check.message = messageOf(check, lspWithoutTypes);
    await remember(deps.storage, options.game, record, check, prints);
    return check;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** `text` within `max` characters, cut at a line where it can be. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atLine = cut.lastIndexOf("\n");
  return `${atLine > max / 2 ? cut.slice(0, atLine) : cut}…`;
}

/** A hook's note of a check: its head line, at most {@link NOTE_LINES} findings, what wasn't checked. */
function noteOf(check: ScriptCheck, head: string): string {
  const lines = check.findings.map(findingLine);
  const shown = lines.slice(0, NOTE_LINES);
  const more = lines.length > shown.length ? [`… and ${lines.length - shown.length} more.`] : [];
  const gaps = check.message
    .split("\n")
    .filter((line) => !lines.includes(line))
    .slice(1);
  return clip([head, ...shown, ...more, ...gaps].join("\n"), HOOK_NOTE_CHARS);
}

/** The finish's answer: held while there are errors, a note otherwise; never held for missing checks. */
export function luauFinish(check: ScriptCheck): HookAnswer {
  if (check.files.length === 0 && check.ran.length === 0) return check.message ? { note: check.message } : {};
  if (check.errors === 0) return { note: clip(check.message, HOOK_NOTE_CHARS) };
  const first = check.findings.find((finding) => finding.kind === FindingKind.Error);
  const firstLine = first ? `${first.file}:${first.line} ${first.message}.` : "";
  const block = clip(MESSAGE.Checks.FinishHeld(check.errors, firstLine), HOOK_REASON_CHARS);
  return { block, note: noteOf(check, MESSAGE.Checks.Summary(check.files.length, countsOf(check))) };
}

/** A worker's end: a note of what its changed scripts still have, nothing when they are clean or unchecked. */
export function luauNote(check: ScriptCheck, worker: string | undefined): HookAnswer {
  const quiet = check.findings.length === 0 && check.failed.length === 0;
  if (quiet) return {};
  return { note: noteOf(check, MESSAGE.Checks.WorkerNote(worker || MESSAGE.Checks.AWorker, countsOf(check))) };
}

/** Writes a new game's selene.toml and stylua.toml where the game has none; answers the names written. */
export async function writeCheckConfigs(folder: string): Promise<string[]> {
  const written: string[] = [];
  for (const [name, text] of Object.entries(CHECK_CONFIGS)) {
    const wrote = await writeFile(path.join(folder, name), text, { flag: "wx", mode: 0o644 }).then(
      () => true,
      () => false,
    );
    if (wrote) written.push(name);
  }
  return written;
}
