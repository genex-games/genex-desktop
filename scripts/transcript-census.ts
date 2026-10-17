/**
 * The transcript census: how much brief, how many turns and how many tokens each harness role
 * spends, counted from the transcripts the engines already write.
 *
 * It exists so a diet can be judged per role from data rather than from taste. Run it before a
 * change to the briefs and again after; `--baseline` prints the difference.
 *
 * READ-ONLY BY CONSTRUCTION. The only writes are the files `--json` and `--md` name, and an
 * output path inside the studio's own data is refused (see `refuseOwnedOutput`). No transcript
 * text ever reaches the output: counts, byte lengths, role labels and tool names only. The brief
 * of a session is read to classify it and is then dropped; its length survives, its words do not.
 *
 * Both engines are read through their own formats. Claude Code writes one JSONL per session under
 * `<home>/projects/<slug>/<sessionId>.jsonl`, with per-message `usage`. Codex writes one rollout
 * per session under `<home>/sessions/<year>/<month>/<day>/rollout-*.jsonl`, with a running
 * `total_token_usage`. The census normalises both onto the same fields and the same tool names, so
 * a Claude `mcp__studio__preview_ready` and a Codex `node .studio/bridge/tool.mjs preview_ready`
 * are one row.
 *
 * Tokens are also priced: each request at its own model's row of `evals/prices.json`, split by
 * billing type (fresh input, cache write, cache read, output), because the four bill very
 * differently and a diet is judged on what it costs, not on how many tokens it moved. A request
 * on a model the table has no price for is counted as unpriced, never guessed.
 */
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { isInside } from "../src/substrate/paths.ts";
import { EngineId } from "../src/shared/providers.ts";
import { normalizeToolName } from "../src/shared/tool-category.ts";
import { readPriceTable, type ModelPrice, type PriceTable } from "./evals/prices.ts";

/** The repository the census runs from, where `evals/prices.json` lives. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ roles */

/**
 * A role is in the union only when the sentence that identifies it is a literal in the harness
 * seed. tests/conformance/census.test.ts asserts every one of these is a substring of some file
 * under src/harness-seed, so a reworded brief fails the suite instead of quietly emptying a row.
 * Everything else is `other`, and renderMarkdown says how much of the corpus that is: a diet
 * judged per role is worthless if most of the corpus is one bucket, and an unverified literal is
 * worse than an honest gap.
 */
export const ROLE_LITERALS = [
  ["director", "You are the DIRECTOR of run"],
  ["worker:base", "You are the BASE BUILDER for"],
  ["worker:facet", "You are building ONE FACET"],
  ["worker:integrator", "You are the integrator for Autopilot run"],
  ["worker:spike", "You are building a SPIKE"],
  ["coordinator:intake", "You are the studio's intake interviewer for an"],
  ["playtester", "You are a playtester"],
  ["planner:replan", "You are the planner of an Autopilot run"],
  ["judge:blind-compare", "You are judging two builds of the same game against a quality bar"],
  ["judge:facet-compare", "You are judging ONE FACET of two builds"],
  ["judge:taste", "You are the taste judge for ONE FACET"],
  ["judge:code-review", "You are reviewing ONE diff"],
  ["judge:liveness", "You are the liveness critic"],
  ["judge:readability", "This game is a screen, not a place a player walks through"],
  ["judge:vision-check", "You answer ONE yes/no question about ONE picture"],
  ["judge:vision-batch", "You answer SEVERAL yes/no questions about pictures"],
  ["judge:reference-panel", "You are one vote on the panel that decides whether an Autopilot run has WON"],
  ["skillopt:pick", "You are choosing between two versions of an agent's instructions"],
  ["skillopt:edit", "You improve an agent's skill file"],
  ["ledger:lessons", "You maintain a short list of lessons"],
] as const satisfies readonly (readonly [string, string])[];

/**
 * The roles the studio asks with `engine.complete` rather than `engine.delegate`.
 *
 * Codex runs every completion as `codex exec --ephemeral` (src/substrate/engines/codex.ts), and
 * an ephemeral session writes no rollout at all. So a `codex` count of zero on one of these
 * rows is not a measurement — no file this census could read was ever written — and rendering
 * it as `0` beside a real `0` from a role that simply did not run is the same lie the scratch
 * filter used to tell. These cells print `—` instead, and the table says why.
 */
export const COMPLETION_ROLES: readonly string[] = [
  "planner:replan",
  "judge:blind-compare",
  "judge:facet-compare",
  "judge:taste",
  "judge:code-review",
  "judge:liveness",
  "judge:readability",
  "judge:vision-check",
  "judge:vision-batch",
  "judge:reference-panel",
  "skillopt:pick",
  "skillopt:edit",
  "ledger:lessons",
];

export type ClassifiedRole = (typeof ROLE_LITERALS)[number][0];
export type Role = ClassifiedRole | "other";
export const ROLE_NAMES: readonly Role[] = [...ROLE_LITERALS.map(([role]) => role), "other"];

/** The role of a brief, from its opening sentence. Anything unrecognised is `other`. */
export function classifyBrief(brief: string | null | undefined): Role {
  const head = (brief ?? "").trimStart().slice(0, 400);
  if (!head) return "other";
  for (const [role, literal] of ROLE_LITERALS) if (head.startsWith(literal)) return role;
  return "other";
}

/* ------------------------------------------------------------------ shape */

/** Whose transcripts a session is: Claude Code's or Codex's. */
export const Engine = { Claude: "claude", Codex: "codex" } as const;
export type Engine = (typeof Engine)[keyof typeof Engine];

/** API-equivalent USD by billing type. */
export interface CostSplit {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

const emptyCost = (): CostSplit => ({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });

export interface Session {
  engine: Engine;
  /** The session's own id, when the transcript records one. */
  id: string | null;
  /** Basenames only — enough to find the file again, never a whole private path in a report. */
  file: string;
  folder: string;
  role: Role;
  /** The working directory the session ran in, kept for the --system-codex filter. */
  cwd: string | null;
  briefBytes: number;
  bytes: number;
  turns: number;
  toolCalls: number;
  tools: Record<string, number>;
  input: { fresh: number; cacheCreate: number; cacheRead: number; total: number };
  output: number;
  /** Cache writes at the 1-hour TTL, which bills at twice the 5-minute rate (Claude reports the split). */
  cacheWrite1h: number;
  /** The largest input one request carried: the context a long session ends up re-reading every turn. */
  peakInput: number;
  /** What the priced requests cost. */
  cost: CostSplit;
  /** Requests on a model the price table has no price for. */
  unpricedTurns: number;
  /** Tool results that came back as errors, by tool (Claude marks them; Codex does not). */
  toolErrors: Record<string, number>;
  firstAt: string | null;
  lastAt: string | null;
}

const emptySession = (engine: Engine, file: string): Session => ({
  engine,
  id: null,
  file: path.basename(file),
  folder: path.basename(path.dirname(file)),
  role: "other",
  cwd: null,
  briefBytes: 0,
  bytes: 0,
  turns: 0,
  toolCalls: 0,
  tools: {},
  input: { fresh: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
  output: 0,
  cacheWrite1h: 0,
  peakInput: 0,
  cost: emptyCost(),
  unpricedTurns: 0,
  toolErrors: {},
  firstAt: null,
  lastAt: null,
});

/** One request's tokens, by billing type. */
interface RequestTokens {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** The model's published price, or null when the table has none (or no table was given). */
function priceOf(prices: PriceTable | null, model: string | null): ModelPrice | null {
  const price = model ? prices?.models[model] : undefined;
  return price && !("unknown" in price) ? price : null;
}

/** Adds `turns` requests' cost to the session at the model's price, or counts them unpriced. */
function priceTokens(session: Session, price: ModelPrice | null, tokens: RequestTokens, turns = 1): void {
  if (!price) {
    session.unpricedTurns += turns;
    return;
  }
  const usd = (rate: number, count: number) => (rate * count) / 1_000_000;
  const { cost } = session;
  cost.fresh += usd(price.input, tokens.fresh);
  cost.cacheWrite += usd(price.cacheWrite, tokens.cacheWrite);
  cost.cacheRead += usd(price.cacheRead, tokens.cacheRead);
  cost.output += usd(price.output, tokens.output);
  cost.total = cost.fresh + cost.cacheWrite + cost.cacheRead + cost.output;
}

/* ------------------------------------------------------------------ tools */

const countTool = (session: Session, name: string) => {
  session.tools[name] = (session.tools[name] ?? 0) + 1;
  session.toolCalls += 1;
};

/* ------------------------------------------------------------------ readers */

/** Stream a JSONL file line by line. Transcripts run to hundreds of megabytes. */
async function eachLine(file: string, onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    let carry = "";
    stream.on("data", (chunk) => {
      const parts = (carry + chunk).split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) if (part.trim()) onLine(part);
    });
    stream.on("end", () => {
      if (carry.trim()) onLine(carry);
      resolve();
    });
    stream.on("error", reject);
  });
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const record = asRecord(block);
    const type = record?.["type"];
    if ((type === "text" || type === "input_text" || type === "output_text") && typeof record?.["text"] === "string")
      out += record["text"] as string;
  }
  return out;
}

function stamp(session: Session, at: unknown): void {
  if (typeof at !== "string" || !at) return;
  if (!session.firstAt || at < session.firstAt) session.firstAt = at;
  if (!session.lastAt || at > session.lastAt) session.lastAt = at;
}

/** One JSONL line as an object, or null for a line that is not one. */
function parseRow(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

const stringField = (record: Record<string, unknown> | null | undefined, key: string): string | null =>
  typeof record?.[key] === "string" ? (record[key] as string) : null;

/** A Claude session being read: the session so far, its brief, and the ids already counted. */
interface ClaudeReading {
  session: Session;
  brief: string | null;
  seenMessages: Set<string>;
  seenBlocks: Set<string>;
  /** Each tool call's counted name, by its id, so a failed result is charged to its tool. */
  toolNames: Map<string, string>;
  prices: PriceTable | null;
}

/** The first user message that is neither a tool result nor a side chain is the brief. */
function readClaudeUser(reading: ClaudeReading, row: Record<string, unknown>, message: Record<string, unknown>): void {
  const content = message["content"];
  const isToolResult = Array.isArray(content) && content.some((b) => asRecord(b)?.["type"] === "tool_result");
  if (isToolResult || reading.brief !== null || row["isSidechain"] === true) return;
  const text = textOf(content);
  if (!text.trim()) return;
  reading.brief = text;
  reading.session.briefBytes = Buffer.byteLength(text, "utf8");
}

/** A Claude message is written once per content block; its turn and usage count once, by id. */
function countClaudeTurn(reading: ClaudeReading, message: Record<string, unknown>): void {
  const id = stringField(message, "id");
  if (id && reading.seenMessages.has(id)) return;
  if (id) reading.seenMessages.add(id);
  const { session } = reading;
  session.turns += 1;
  const usage = asRecord(message["usage"]);
  if (!usage) return;
  const tokens: RequestTokens = {
    fresh: asNumber(usage["input_tokens"]),
    cacheWrite: asNumber(usage["cache_creation_input_tokens"]),
    cacheRead: asNumber(usage["cache_read_input_tokens"]),
    output: asNumber(usage["output_tokens"]),
  };
  session.input.fresh += tokens.fresh;
  session.input.cacheCreate += tokens.cacheWrite;
  session.input.cacheRead += tokens.cacheRead;
  session.output += tokens.output;
  session.cacheWrite1h += asNumber(asRecord(usage["cache_creation"])?.["ephemeral_1h_input_tokens"]);
  session.peakInput = Math.max(session.peakInput, tokens.fresh + tokens.cacheWrite + tokens.cacheRead);
  priceTokens(session, priceOf(reading.prices, stringField(message, "model")), tokens);
}

function countClaudeTools(reading: ClaudeReading, message: Record<string, unknown>): void {
  for (const block of Array.isArray(message["content"]) ? (message["content"] as unknown[]) : []) {
    const record = asRecord(block);
    if (record?.["type"] !== "tool_use") continue;
    const blockId = stringField(record, "id");
    if (blockId && reading.seenBlocks.has(blockId)) continue;
    if (blockId) reading.seenBlocks.add(blockId);
    const name = stringField(record, "name") ?? "?";
    const command = stringField(asRecord(record["input"]), "command") ?? "";
    const counted = normalizeToolName(name, command);
    if (blockId) reading.toolNames.set(blockId, counted);
    countTool(reading.session, counted);
  }
}

/** A tool result marked `is_error` counts against the tool that was called. */
function countClaudeToolErrors(reading: ClaudeReading, message: Record<string, unknown>): void {
  for (const block of Array.isArray(message["content"]) ? (message["content"] as unknown[]) : []) {
    const record = asRecord(block);
    if (record?.["type"] !== "tool_result" || record["is_error"] !== true) continue;
    const name = reading.toolNames.get(stringField(record, "tool_use_id") ?? "") ?? "?";
    reading.session.toolErrors[name] = (reading.session.toolErrors[name] ?? 0) + 1;
  }
}

function readClaudeRow(reading: ClaudeReading, line: string): void {
  const row = parseRow(line);
  if (!row) return;
  const { session } = reading;
  if (!session.id && typeof row["sessionId"] === "string") session.id = row["sessionId"];
  if (!session.cwd && typeof row["cwd"] === "string") session.cwd = row["cwd"];
  stamp(session, row["timestamp"]);
  const message = asRecord(row["message"]);
  if (!message) return;
  if (row["type"] === "user") {
    readClaudeUser(reading, row, message);
    countClaudeToolErrors(reading, message);
    return;
  }
  if (row["type"] !== "assistant") return;
  countClaudeTurn(reading, message);
  countClaudeTools(reading, message);
}

/** One Claude Code transcript: `<home>/projects/<slug>/<sessionId>.jsonl`, priced at `prices`. */
export async function readClaudeSession(file: string, prices: PriceTable | null = null): Promise<Session | null> {
  const reading: ClaudeReading = {
    session: emptySession(Engine.Claude, file),
    brief: null,
    seenMessages: new Set(),
    seenBlocks: new Set(),
    toolNames: new Map(),
    prices,
  };
  const { session } = reading;
  session.bytes = await size(file);
  await eachLine(file, (line) => readClaudeRow(reading, line));
  session.input.total = session.input.fresh + session.input.cacheCreate + session.input.cacheRead;
  session.role = classifyBrief(reading.brief);
  return session;
}

/** The envelopes Codex prepends to a session; the brief is the first user message that is not one. */
const CODEX_ENVELOPE = /^\s*<(environment_context|user_instructions|user_shell|project_doc)/;
/** The items that answer a tool call: whatever the model says next is a new response. */
const CODEX_TOOL_OUTPUTS: ReadonlySet<unknown> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
]);
/** The items that are a tool call. */
const CODEX_TOOL_CALLS: ReadonlySet<unknown> = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

/** A Codex rollout being read: the session so far, its brief, and whether a response is open. */
interface CodexReading {
  session: Session;
  brief: string | null;
  /** The model the rollout ran on, from its turn context: what its totals are priced at. */
  model: string | null;
  // A turn is ONE MODEL RESPONSE, the same thing Claude's deduplicated `message.id` counts. Codex
  // writes a response as its items — reasoning, an assistant message, tool calls — and closes it
  // with the outputs of those calls, so a response is the run of items between two outputs (or
  // between a user message and the first output). Counting only the assistant `message` items
  // would count a ninety-tool-call rollout as one turn and put it in the same column as a Claude
  // session that counted ninety.
  inResponse: boolean;
}

function readCodexMeta(session: Session, payload: Record<string, unknown>): void {
  if (typeof payload["id"] === "string") session.id = payload["id"];
  else if (typeof payload["session_id"] === "string") session.id = payload["session_id"];
  if (typeof payload["cwd"] === "string") session.cwd = payload["cwd"];
}

// Codex reports a RUNNING total, so the last one wins; Claude reports per message and sums.
function readCodexTokens(session: Session, payload: Record<string, unknown>): void {
  const info = asRecord(payload["info"]);
  // The last request's input holds its cached tokens too: the context that request carried.
  const last = asNumber(asRecord(info?.["last_token_usage"])?.["input_tokens"]);
  session.peakInput = Math.max(session.peakInput, last);
  const usage = asRecord(info?.["total_token_usage"]);
  if (!usage) return;
  const input = asNumber(usage["input_tokens"]);
  const cached = asNumber(usage["cached_input_tokens"]);
  session.input.cacheRead = cached;
  session.input.cacheCreate = asNumber(usage["cache_write_input_tokens"]);
  session.input.fresh = Math.max(0, input - cached);
  session.output = asNumber(usage["output_tokens"]);
}

/** The rollout's working directory and model, from the first turn context that names them. */
function readCodexContext(reading: CodexReading, payload: Record<string, unknown>): void {
  if (!reading.session.cwd && typeof payload["cwd"] === "string") reading.session.cwd = payload["cwd"];
  if (!reading.model && typeof payload["model"] === "string") reading.model = payload["model"];
}

/** Opens a response when none is open, counting it as a turn. */
function openResponse(reading: CodexReading): void {
  if (reading.inResponse) return;
  reading.session.turns += 1;
  reading.inResponse = true;
}

function readCodexMessage(reading: CodexReading, payload: Record<string, unknown>): void {
  const text = textOf(payload["content"]);
  if (payload["role"] === "assistant") {
    openResponse(reading);
    return;
  }
  reading.inResponse = false;
  const isBrief = payload["role"] === "user" && reading.brief === null && text.trim() && !CODEX_ENVELOPE.test(text);
  if (!isBrief) return;
  reading.brief = text;
  reading.session.briefBytes = Buffer.byteLength(text, "utf8");
}

/** The text a tool call ran with: its arguments, its input, or its shell action. */
function callArguments(payload: Record<string, unknown>): string {
  if (typeof payload["arguments"] === "string") return payload["arguments"];
  if (typeof payload["input"] === "string") return payload["input"];
  return JSON.stringify(payload["action"] ?? "");
}

function readCodexItem(reading: CodexReading, payload: Record<string, unknown>): void {
  const type = payload["type"];
  if (type === "message") {
    readCodexMessage(reading, payload);
    return;
  }
  if (CODEX_TOOL_OUTPUTS.has(type)) {
    // The tool answered: whatever the model says next is a new response.
    reading.inResponse = false;
    return;
  }
  if (!CODEX_TOOL_CALLS.has(type)) return;
  openResponse(reading);
  const name = stringField(payload, "name") ?? "?";
  countTool(reading.session, normalizeToolName(name, callArguments(payload)));
}

function readCodexRow(reading: CodexReading, line: string): void {
  const row = parseRow(line);
  if (!row) return;
  const { session } = reading;
  stamp(session, row["timestamp"]);
  const payload = asRecord(row["payload"]);
  if (!payload) return;
  const type = row["type"];
  if (type === "session_meta") {
    readCodexMeta(session, payload);
    return;
  }
  if (type === "turn_context") readCodexContext(reading, payload);
  if (type === "event_msg" && payload["type"] === "token_count") {
    readCodexTokens(session, payload);
    return;
  }
  if (type === "response_item") readCodexItem(reading, payload);
}

/** One Codex rollout: `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl`, priced at `prices`. */
export async function readCodexSession(file: string, prices: PriceTable | null = null): Promise<Session | null> {
  const reading: CodexReading = {
    session: emptySession(Engine.Codex, file),
    brief: null,
    model: null,
    inResponse: false,
  };
  const { session } = reading;
  session.bytes = await size(file);
  await eachLine(file, (line) => readCodexRow(reading, line));
  session.input.total = session.input.fresh + session.input.cacheCreate + session.input.cacheRead;
  // Codex reports one running total, so the whole rollout is priced at once.
  const { fresh, cacheCreate, cacheRead } = session.input;
  const totals = { fresh, cacheWrite: cacheCreate, cacheRead, output: session.output };
  priceTokens(session, priceOf(prices, reading.model), totals, session.turns);
  session.role = classifyBrief(reading.brief);
  return session;
}

/* ------------------------------------------------------------------ where we looked */

export interface Homes {
  appDir: string;
  /** The data folder the app had as AI Game Studio, before it moved to Genex's; older transcripts name it. */
  legacyAppDir?: string;
  claudeIsolated: string;
  claudeSystem: string;
  codexIsolated: string;
  codexSystem: string;
  gameRoots: string[];
  /** Where the studio makes the scratch folders it runs a playtester and a judge in. */
  tmpDir: string;
}

export function defaultHomes(home = os.homedir()): Homes {
  const appDir = path.join(home, "Library", "Application Support", "Genex");
  const legacyAppDir = path.join(home, "Library", "Application Support", "AI Game Studio");
  return {
    appDir,
    legacyAppDir,
    claudeIsolated: path.join(appDir, "engine-homes", EngineId.ClaudeCode),
    claudeSystem: path.join(home, ".claude"),
    codexIsolated: path.join(appDir, "engine-homes", EngineId.Codex),
    codexSystem: path.join(home, ".codex"),
    gameRoots: [
      path.join(appDir, "workspaces", "games"),
      path.join(appDir, "scratch"),
      path.join(legacyAppDir, "workspaces", "games"),
      path.join(legacyAppDir, "scratch"),
      path.join(home, "AI Games"),
      path.join(home, "ai-games"),
    ],
    tmpDir: os.tmpdir(),
  };
}

/**
 * The studio does not run every Codex session in a game folder. A playtester is a read-only
 * delegation started in a fresh scratch directory, and every judge call gets one too — both under
 * the system temp folder, both named with the studio's own prefix (src/substrate/engines/codex.ts
 * mkdtemps `studio-playtest-` and `studio-judge-`). Filtering the owner's own `~/.codex` on the
 * game roots alone dropped all of them, so a `playtester` row and nine `judge:*` rows read zero
 * while the director and the workers filled in.
 */
export const STUDIO_SCRATCH_PREFIXES = ["studio-playtest-", "studio-judge-"] as const;

/**
 * Whether a session belongs to the studio rather than to the person whose home it sits in: it ran
 * in one of the game roots, or in a scratch folder the studio itself named. Ownership, not path.
 */
export function ownedByStudio(cwd: string | null | undefined, homes: Homes): boolean {
  if (!cwd) return false;
  if (homes.gameRoots.some((root) => isInside(root, cwd))) return true;
  if (!STUDIO_SCRATCH_PREFIXES.some((prefix) => path.basename(cwd).startsWith(prefix))) return false;
  // macOS hands `os.tmpdir()` back as /var/folders/... and reports the same folder to a child
  // process as /private/var/folders/..., so the temp root is matched through both names.
  const parent = path.dirname(path.resolve(cwd));
  const tmp = path.resolve(homes.tmpDir);
  return (
    isInside(tmp, parent) ||
    isInside(path.join("/private", tmp), parent) ||
    isInside(tmp.replace(/^\/private/, ""), parent)
  );
}

export interface Look {
  engine: Engine;
  isolated: boolean;
  where: string;
  files: number;
  note: string;
  /** Sessions read from a system home and left out because they are not the studio's. */
  dropped?: number;
}

/** One sentence per engine: where the census looked and what it found there. */
export function lookLine(look: Look): string {
  const line = `${look.engine}: ${look.note} — ${look.files} ${look.files === 1 ? "transcript" : "transcripts"} under ${look.where}`;
  // A filtered home has to say how much it filtered: a row that reads zero is otherwise
  // indistinguishable from a role that never ran.
  return look.dropped ? `${line}; ${look.dropped} not the studio's and dropped` : line;
}

async function size(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Every `*.jsonl` below a directory, sorted, without following a symlink out of it. */
async function jsonlBelow(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6 || !(await exists(dir))) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonlBelow(full, depth + 1)));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ tally */

export interface Spread {
  min: number;
  median: number;
  max: number;
  total: number;
}

export interface RoleTally {
  role: Role;
  sessions: number;
  engines: Record<Engine, number>;
  briefBytes: Spread;
  turns: Spread;
  input: Spread;
  output: Spread;
  peakInput: Spread;
  /** API-equivalent USD of the role's priced requests. */
  costUsd: number;
  first: string | null;
  last: string | null;
}

export interface Census {
  generatedAt: string;
  sessions: number;
  roles: RoleTally[];
  other: { sessions: number; briefBytes: number; sessionShare: number; briefShare: number };
  totals: {
    sessions: number;
    turns: number;
    toolCalls: number;
    briefBytes: number;
    fresh: number;
    cacheCreate: number;
    cacheRead: number;
    input: number;
    output: number;
    cacheWrite1h: number;
    cost: CostSplit;
    unpricedTurns: number;
  };
  engines: Record<Engine, { sessions: number; turns: number; input: number; output: number }>;
  tools: { name: string; calls: number; sessions: number; errors: number }[];
  looks: Look[];
}

function spread(values: number[]): Spread {
  if (!values.length) return { min: 0, median: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]!, total: values.reduce((a, b) => a + b, 0) };
}

/** `part` as a percentage of `whole`, to one decimal; 0 of nothing is 0. */
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export function tally(sessions: Session[], looks: Look[] = []): Census {
  const roles: RoleTally[] = [];
  for (const role of ROLE_NAMES) {
    const rows = sessions.filter((s) => s.role === role);
    if (!rows.length) continue;
    roles.push({
      role,
      sessions: rows.length,
      engines: {
        claude: rows.filter((r) => r.engine === Engine.Claude).length,
        codex: rows.filter((r) => r.engine === Engine.Codex).length,
      },
      briefBytes: spread(rows.map((r) => r.briefBytes)),
      turns: spread(rows.map((r) => r.turns)),
      input: spread(rows.map((r) => r.input.total)),
      output: spread(rows.map((r) => r.output)),
      peakInput: spread(rows.map((r) => r.peakInput)),
      costUsd: rows.reduce((a, r) => a + r.cost.total, 0),
      first:
        rows
          .map((r) => r.firstAt)
          .filter((v): v is string => !!v)
          .sort()[0] ?? null,
      last:
        rows
          .map((r) => r.lastAt)
          .filter((v): v is string => !!v)
          .sort()
          .at(-1) ?? null,
    });
  }
  roles.sort((a, b) => b.sessions - a.sessions || a.role.localeCompare(b.role));
  const tools = toolTotals(sessions);
  const other = sessions.filter((s) => s.role === "other");
  const briefBytes = sessions.reduce((a, s) => a + s.briefBytes, 0);
  const otherBriefBytes = other.reduce((a, s) => a + s.briefBytes, 0);
  return {
    generatedAt: new Date().toISOString(),
    sessions: sessions.length,
    roles,
    other: {
      sessions: other.length,
      briefBytes: otherBriefBytes,
      sessionShare: percent(other.length, sessions.length),
      briefShare: percent(otherBriefBytes, briefBytes),
    },
    totals: {
      sessions: sessions.length,
      turns: sessions.reduce((a, s) => a + s.turns, 0),
      toolCalls: sessions.reduce((a, s) => a + s.toolCalls, 0),
      briefBytes,
      fresh: sessions.reduce((a, s) => a + s.input.fresh, 0),
      cacheCreate: sessions.reduce((a, s) => a + s.input.cacheCreate, 0),
      cacheRead: sessions.reduce((a, s) => a + s.input.cacheRead, 0),
      input: sessions.reduce((a, s) => a + s.input.total, 0),
      output: sessions.reduce((a, s) => a + s.output, 0),
      cacheWrite1h: sessions.reduce((a, s) => a + s.cacheWrite1h, 0),
      cost: costTotals(sessions),
      unpricedTurns: sessions.reduce((a, s) => a + s.unpricedTurns, 0),
    },
    engines: {
      claude: engineTotals(sessions, Engine.Claude),
      codex: engineTotals(sessions, Engine.Codex),
    },
    tools: [...tools]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    looks,
  };
}

/** Calls, sessions and failed results per tool, across the corpus. */
function toolTotals(sessions: Session[]): Map<string, { calls: number; sessions: number; errors: number }> {
  const tools = new Map<string, { calls: number; sessions: number; errors: number }>();
  for (const session of sessions)
    for (const [name, calls] of Object.entries(session.tools)) {
      const row = tools.get(name) ?? { calls: 0, sessions: 0, errors: 0 };
      row.calls += calls;
      row.sessions += 1;
      row.errors += session.toolErrors[name] ?? 0;
      tools.set(name, row);
    }
  return tools;
}

/** The corpus cost, by billing type. */
function costTotals(sessions: Session[]): CostSplit {
  const total = emptyCost();
  for (const { cost } of sessions) {
    total.fresh += cost.fresh;
    total.cacheWrite += cost.cacheWrite;
    total.cacheRead += cost.cacheRead;
    total.output += cost.output;
    total.total += cost.total;
  }
  return total;
}

function engineTotals(sessions: Session[], engine: Engine) {
  const rows = sessions.filter((s) => s.engine === engine);
  return {
    sessions: rows.length,
    turns: rows.reduce((a, s) => a + s.turns, 0),
    input: rows.reduce((a, s) => a + s.input.total, 0),
    output: rows.reduce((a, s) => a + s.output, 0),
  };
}

/* ------------------------------------------------------------------ markdown */

export const HEADINGS = [
  "## Where the census looked",
  "## Sessions by role",
  "## Corpus totals",
  "## Tool calls",
] as const;
export const CHANGE_HEADING = "## Change against the baseline";

const n = (value: number) => value.toLocaleString("en-US");
const dollars = (value: number) => `$${value.toFixed(2)}`;
/** A cost change; a baseline written before the census priced anything reads as $0.00. */
const dollarDelta = (now: number, before: number) => `${now >= before ? "+" : "-"}${dollars(Math.abs(now - before))}`;
const delta = (now: number, before: number) => {
  const change = now - before;
  return `${change >= 0 ? "+" : ""}${n(change)}${before ? ` (${change >= 0 ? "+" : ""}${Math.round((change / before) * 1000) / 10}%)` : ""}`;
};

/** How many tools the table lists, most called first. */
const SHOWN_TOOLS = 40;
/** A role's row in the sessions-by-role table; `blind` when Codex could never have written one. */
function roleRow(role: Census["roles"][number], blind: boolean): string {
  const codex = blind ? "—" : role.engines.codex;
  const brief = `${n(role.briefBytes.min)} / ${n(role.briefBytes.median)} / ${n(role.briefBytes.max)}`;
  const turns = `${role.turns.min} / ${role.turns.median} / ${role.turns.max}`;
  const first = (role.first ?? "").slice(0, 10);
  const last = (role.last ?? "").slice(0, 10);
  return `| ${role.role} | ${role.sessions} | ${role.engines.claude} / ${codex} | ${brief} | ${turns} | ${n(role.input.median)} | ${n(role.output.median)} | ${first} | ${last} | ${n(role.peakInput.max)} | ${dollars(role.costUsd)} |`;
}

function rolesSection(census: Census): string[] {
  const out: string[] = [
    HEADINGS[1],
    "",
    "| role | sessions | claude / codex | brief bytes min/med/max | turns min/med/max | input tokens med | output tokens med | first | last | peak input max | API-equivalent $ |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  let uncountable = false;
  for (const role of census.roles) {
    // A role Codex can only reach through an ephemeral completion has no codex number to give.
    const blind = COMPLETION_ROLES.includes(role.role) && role.engines.codex === 0;
    if (blind) uncountable = true;
    out.push(roleRow(role, blind));
  }
  out.push("");
  if (uncountable)
    out.push(
      "A `—` in the codex column is not zero. The studio asks its critics, its planner and its skill editor with `engine.complete`, which Codex runs as `codex exec --ephemeral` — those sessions write no rollout, so no census built from session files can ever count one. The claude half of the same row is a real number.",
      "",
    );
  out.push(
    `${n(census.other.sessions)} of ${n(census.sessions)} sessions (${census.other.sessionShare}%) and ${n(census.other.briefBytes)} brief bytes (${census.other.briefShare}%) landed in \`other\`: no verified literal opens them. A per-role diet is only worth what this number is small.`,
    "",
  );
  return out;
}

function totalsSection(census: Census): string[] {
  const { totals, engines } = census;
  return [
    HEADINGS[2],
    "",
    `- sessions: ${n(totals.sessions)} (claude ${n(engines.claude.sessions)}, codex ${n(engines.codex.sessions)})`,
    `- assistant turns: ${n(totals.turns)}`,
    `- tool calls: ${n(totals.toolCalls)}`,
    `- brief bytes: ${n(totals.briefBytes)}`,
    `- input tokens: ${n(totals.input)} (fresh ${n(totals.fresh)}, cache write ${n(totals.cacheCreate)}, cache read ${n(totals.cacheRead)})`,
    `- output tokens: ${n(totals.output)}`,
    `- cache writes at a 1-hour TTL: ${n(totals.cacheWrite1h)} of ${n(totals.cacheCreate)} (${percent(totals.cacheWrite1h, totals.cacheCreate)}%)`,
    costLine(totals.cost, totals.unpricedTurns),
    "",
  ];
}

/** The corpus cost by billing type, and how many requests the price table could not price. */
function costLine(cost: CostSplit, unpriced: number): string {
  const split = `fresh ${dollars(cost.fresh)}, cache write ${dollars(cost.cacheWrite)}, cache read ${dollars(cost.cacheRead)}, output ${dollars(cost.output)}`;
  const gap = unpriced ? `; ${n(unpriced)} ${unpriced === 1 ? "turn" : "turns"} on a model with no price` : "";
  return `- API-equivalent cost: ${dollars(cost.total)} (${split})${gap}`;
}

function toolsSection(census: Census): string[] {
  return [
    HEADINGS[3],
    "",
    "| tool | calls | sessions | errors |",
    "|---|---|---|---|",
    ...census.tools
      .slice(0, SHOWN_TOOLS)
      .map((tool) => `| ${tool.name} | ${n(tool.calls)} | ${n(tool.sessions)} | ${n(tool.errors)} |`),
    ...(census.tools.length ? [] : ["| (none) | 0 | 0 | 0 |"]),
  ];
}

function changeSection(census: Census, baseline: Census): string[] {
  const out = [
    "",
    CHANGE_HEADING,
    "",
    "| role | sessions | brief bytes med | input tokens med | API-equivalent $ |",
    "|---|---|---|---|---|",
  ];
  const before = new Map(baseline.roles.map((r) => [r.role, r]));
  for (const role of census.roles) {
    const was = before.get(role.role);
    out.push(
      `| ${role.role} | ${delta(role.sessions, was?.sessions ?? 0)} | ${delta(role.briefBytes.median, was?.briefBytes.median ?? 0)} | ${delta(role.input.median, was?.input.median ?? 0)} | ${dollarDelta(role.costUsd, was?.costUsd ?? 0)} |`,
    );
  }
  for (const was of baseline.roles)
    if (!census.roles.some((r) => r.role === was.role))
      out.push(
        `| ${was.role} | ${delta(0, was.sessions)} | ${delta(0, was.briefBytes.median)} | ${delta(0, was.input.median)} | ${dollarDelta(0, was.costUsd ?? 0)} |`,
      );
  return out;
}

export function renderMarkdown(census: Census, baseline: Census | null = null): string {
  const out: string[] = [
    `# Transcript census`,
    "",
    `Counted ${n(census.sessions)} sessions on ${census.generatedAt}. No transcript text is reproduced here.`,
    "",
    HEADINGS[0],
    "",
    ...census.looks.map((look) => `- ${lookLine(look)}`),
    ...(census.looks.length ? [] : ["- nothing was scanned"]),
    "",
    ...rolesSection(census),
    ...totalsSection(census),
    ...toolsSection(census),
    ...(baseline ? changeSection(census, baseline) : []),
    "",
  ];
  return out.join("\n");
}
/* ------------------------------------------------------------------ the write guard */

/**
 * The census writes exactly two files, and never inside the studio's own data: an output path
 * under the app directory or under either engine's home would put a report where an agent's
 * sandbox, a seed upgrade or a login could read or overwrite it.
 */
export function refuseOwnedOutput(output: string, homes: Homes): string | null {
  const appDirs = homes.legacyAppDir ? [homes.appDir, homes.legacyAppDir] : [homes.appDir];
  for (const owned of [...appDirs, homes.claudeIsolated, homes.claudeSystem, homes.codexIsolated, homes.codexSystem])
    if (isInside(owned, output)) return `refusing to write inside the studio's own data: ${output} is under ${owned}`;
  return null;
}

/* ------------------------------------------------------------------ the run */

export interface CensusOptions {
  homes?: Homes;
  systemCodex?: boolean;
  systemClaude?: boolean;
  limit?: number;
  /** The table requests are priced at; the repository's `evals/prices.json` when left out, null for none. */
  prices?: PriceTable | null;
}

/** Where the census looked for one engine: its isolated home, or the system home it was told it may read. */
function homeNote(isolatedHome: string, isolated: boolean, systemAsked: boolean | undefined, flag: string): string {
  if (isolated) return `isolated home at ${isolatedHome}`;
  if (systemAsked)
    return `no isolated home at ${isolatedHome}; reading the system home, filtered to the studio's own folders`;
  return `no isolated home at ${isolatedHome}; rerun with ${flag} to read the system home`;
}

/**
 * Reads the Claude sessions of the studio's isolated home, or (asked to) the studio's own ones in
 * the system home: a chat signed in with this Mac's own Claude Code writes its transcripts there,
 * beside the owner's, so only the sessions that ran in a game folder or a studio scratch folder count.
 */
async function claudeSessions(homes: Homes, options: CensusOptions): Promise<{ look: Look; sessions: Session[] }> {
  const claudeIsolated = await exists(path.join(homes.claudeIsolated, "projects"));
  const claudeRoot = claudeIsolated
    ? path.join(homes.claudeIsolated, "projects")
    : path.join(homes.claudeSystem, "projects");
  const claudeFiles = await jsonlBelow(claudeRoot);
  const read = claudeIsolated || options.systemClaude ? claudeFiles : [];
  const look: Look = {
    engine: Engine.Claude,
    isolated: claudeIsolated,
    where: claudeRoot,
    files: claudeFiles.length,
    note: homeNote(homes.claudeIsolated, claudeIsolated, options.systemClaude, "--system-claude"),
  };
  const sessions: Session[] = [];
  let dropped = 0;
  for (const file of read.slice(0, options.limit ?? Infinity)) {
    const session = await readClaudeSession(file, options.prices ?? null);
    if (!session) continue;
    if (!claudeIsolated && !ownedByStudio(session.cwd, homes)) {
      dropped += 1;
      continue;
    }
    sessions.push(session);
  }
  if (dropped) look.dropped = dropped;
  return { look, sessions };
}

/** Reads the Codex rollouts of the isolated home, or (asked to) the studio's own ones in the system home. */
async function codexSessions(homes: Homes, options: CensusOptions): Promise<{ look: Look; sessions: Session[] }> {
  const codexIsolated = await exists(path.join(homes.codexIsolated, "sessions"));
  const codexRoot = codexIsolated
    ? path.join(homes.codexIsolated, "sessions")
    : path.join(homes.codexSystem, "sessions");
  const codexFiles = codexIsolated || options.systemCodex ? await jsonlBelow(codexRoot) : [];
  const unread = !codexIsolated && !options.systemCodex;
  const systemFound = unread ? (await jsonlBelow(path.join(homes.codexSystem, "sessions"))).length : codexFiles.length;
  const look: Look = {
    engine: Engine.Codex,
    isolated: codexIsolated,
    where: codexRoot,
    files: systemFound,
    note: homeNote(homes.codexIsolated, codexIsolated, options.systemCodex, "--system-codex"),
  };
  const sessions: Session[] = [];
  let dropped = 0;
  for (const file of codexFiles.slice(0, options.limit ?? Infinity)) {
    const session = await readCodexSession(file, options.prices ?? null);
    if (!session) continue;
    // The system home is the owner's own Codex, so only the sessions the studio itself started
    // belong to the census: the ones that ran in a game folder, and the ones that ran in a
    // scratch folder the studio named (a playtester, a judge).
    if (!codexIsolated && !ownedByStudio(session.cwd, homes)) {
      dropped += 1;
      continue;
    }
    sessions.push(session);
  }
  if (dropped) look.dropped = dropped;
  return { look, sessions };
}

/** The repository's price table, or null when it cannot be read: the census still counts tokens. */
function repositoryPrices(): PriceTable | null {
  try {
    return readPriceTable(REPO_ROOT);
  } catch {
    return null;
  }
}

export async function runCensus(options: CensusOptions = {}): Promise<Census> {
  const homes = options.homes ?? defaultHomes();
  const priced = { ...options, prices: options.prices === undefined ? repositoryPrices() : options.prices };
  const claude = await claudeSessions(homes, priced);
  const codex = await codexSessions(homes, priced);
  return tally([...claude.sessions, ...codex.sessions], [claude.look, codex.look]);
}

/* ------------------------------------------------------------------ CLI */

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? null : (argv[at + 1] ?? null);
  };
  const homes = defaultHomes();
  const outputs = [value("json"), value("md")].filter((v): v is string => !!v);
  for (const output of outputs) {
    const refusal = refuseOwnedOutput(path.resolve(output), homes);
    if (refusal) {
      console.error(refusal);
      return 1;
    }
  }
  const census = await runCensus({
    homes,
    systemCodex: flag("system-codex"),
    systemClaude: flag("system-claude"),
    ...(value("limit") ? { limit: Number(value("limit")) } : {}),
  });
  for (const look of census.looks) console.log(lookLine(look));
  const markdown = renderMarkdown(
    census,
    value("baseline") ? (JSON.parse(await fs.promises.readFile(value("baseline")!, "utf8")) as Census) : null,
  );
  const json = value("json"),
    md = value("md");
  if (json) await fs.promises.writeFile(path.resolve(json), JSON.stringify(census, null, 2) + "\n", "utf8");
  if (md) await fs.promises.writeFile(path.resolve(md), markdown, "utf8");
  const digest = markdown
    .split("\n")
    .filter((line) => line.startsWith("## ") || line.startsWith("- sessions:"))
    .join("\n");
  console.log(json || md ? digest : markdown);
  if (json) console.log(`json: ${path.resolve(json)}`);
  if (md) console.log(`md: ${path.resolve(md)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
