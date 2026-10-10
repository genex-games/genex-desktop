/**
 * The tools a local session (`local-session.ts`) gives its model, and what each one does. Every
 * path goes through `sessionFileResolver`, which confines reads to the granted roots and writes
 * to the workspace the session owns.
 */
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { allowedFile, ownershipReason, specOf } from "../ownership.ts";
import { isInside, toPosixRelative } from "../paths.ts";
import type { ProcessSandbox } from "../spawn.ts";
import type { ToolCall } from "../types.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { LOCAL_NOTE, LOCAL_TOOL_DESCRIPTION } from "./local-session-prompts.ts";
import { StudioTool } from "./studio-tool-prompts.ts";
import { captureArgs } from "./capture-args.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult, ToolDefinition } from "./types.ts";

/** The local session's own tools, by the name the model calls. */
export const LocalTool = {
  ReadFile: "read_file",
  ListFiles: "list_files",
  EditFile: "edit_file",
  WriteFile: "write_file",
  RunCommand: "run_command",
  Capture: "capture",
} as const;
export type LocalTool = (typeof LocalTool)[keyof typeof LocalTool];

/** Tools that only look: a round of nothing else that changed no file is a round without progress. */
export const INSPECTION_TOOLS = new Set<string>([LocalTool.ReadFile, LocalTool.ListFiles, LocalTool.RunCommand]);

/** How much a local tool may read, list, run and answer. */
export const LOCAL_TOOL_LIMITS = {
  /** Larger files are inspected with a bounded command, never read or edited whole. */
  maxFileBytes: 8 * 1024 ** 2,
  defaultReadLines: 200,
  maxReadLines: 400,
  readChars: 20_000,
  listEntries: 500,
  commandTimeoutMs: 2 * MINUTE_MS,
  commandOutputBytes: 40_000,
} as const;

/** Picture files `read_file` returns as images, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** What the model reads when a local tool call is refused. */
const MESSAGE = {
  NameCollision: "Local session tool name collision",
  ExpectedPath: "Expected a file path",
  NotReadable: "This path is not readable by this session",
  ReadOutside: "Read outside this session workspace",
  WriteOutside: "Write outside this session workspace",
  GitMetadata: "Use Studio integration tools for version control metadata",
  UnknownTool: (name: string) => `Unknown tool ${name}`,
  NoHandler: (name: string) => `${name} has no handler in this session`,
  MalformedArguments: (name: string) =>
    `The arguments for ${name} were not valid JSON, so it did not run. Call it again with a complete JSON object.`,
  TooLargeToRead: "File too large; use a bounded command to inspect it",
  InvalidEdit: "oldText must be nonempty and newText must be a string",
  TooLargeToEdit: "File too large for edit_file",
  AmbiguousEdit: "oldText must match exactly once; include enough surrounding text",
  ContentNotString: "content must be a string",
  CommandNotString: "command must be a string",
  ReadOnlyCommand: "run_command is not available in a read-only session",
  NoCapture: "capture is not available in this session",
} as const;

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({ name, description, parameters: { type: "object", properties, required } });
const str = { type: "string" };

/** The tools this session grants: reading always, writing unless read-only, then the studio's own. */
export function localToolDefinitions(request: DelegateRequest, readonly: boolean): ToolDefinition[] {
  // A blind judge sees the build only through its live tools: no file of the build is offered.
  const definitions: ToolDefinition[] = request.blind ? [] : fileReadTools();
  if (!readonly)
    definitions.push(
      tool(LocalTool.EditFile, LOCAL_TOOL_DESCRIPTION.editFile, { path: str, oldText: str, newText: str }, [
        "path",
        "oldText",
        "newText",
      ]),
      tool(LocalTool.WriteFile, LOCAL_TOOL_DESCRIPTION.writeFile, { path: str, content: str }, ["path", "content"]),
      tool(LocalTool.RunCommand, LOCAL_TOOL_DESCRIPTION.runCommand, { command: str }, ["command"]),
    );
  return withRequestTools(request, definitions);
}

/** The tools that read the session's files. */
function fileReadTools(): ToolDefinition[] {
  return [
    tool(
      LocalTool.ReadFile,
      LOCAL_TOOL_DESCRIPTION.readFile,
      {
        path: str,
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: LOCAL_TOOL_LIMITS.maxReadLines },
      },
      ["path"],
    ),
    tool(LocalTool.ListFiles, LOCAL_TOOL_DESCRIPTION.listFiles, { path: str }),
  ];
}

/** The request's own tools after the session's: capture, live studio tools and interview tools, names unique. */
function withRequestTools(request: DelegateRequest, definitions: ToolDefinition[]): ToolDefinition[] {
  if (request.onCapture)
    definitions.push(
      tool(LocalTool.Capture, LOCAL_TOOL_DESCRIPTION.capture, {
        cameras: str,
        page: { ...str, description: LOCAL_TOOL_DESCRIPTION.capturePage },
      }),
    );
  for (const t of request.liveTools ?? [])
    definitions.push({ name: t.name, description: t.description, parameters: t.inputSchema ?? t.parameters });
  for (const t of request.interviewTools ?? []) definitions.push(t);
  if (new Set(definitions.map((t) => t.name)).size !== definitions.length) throw new Error(MESSAGE.NameCollision);
  return definitions;
}

/** Where a session may read and write, and whose files it may touch. */
export interface FileScope {
  cwd: string;
  readRoots: string[];
  forbidden: string[];
  deniedWrites: string[];
  readonly: boolean;
  ownership: DelegateRequest["ownership"];
}

/** Resolves a model-supplied path to the real file it names, or throws why the session may not touch it. */
export type FileResolver = (raw: unknown, write?: boolean) => Promise<string>;

/** A resolver confined to `scope`: reads inside the granted roots, writes inside the workspace. */
export function sessionFileResolver(scope: FileScope): FileResolver {
  return async (raw, write = false) => {
    if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new Error(MESSAGE.ExpectedPath);
    const target = path.resolve(scope.cwd, raw);
    const actual = await realpathOfNearest(target);
    if (scope.forbidden.some((p) => isInside(p, target) || isInside(p, actual))) throw new Error(MESSAGE.NotReadable);
    if (write) assertWritable(scope, target, actual);
    else if (!scope.readRoots.some((p) => isInside(p, actual))) throw new Error(MESSAGE.ReadOutside);
    return actual;
  };
}

/** Resolve even a not-yet-created file through its nearest existing parent. */
async function realpathOfNearest(target: string): Promise<string> {
  let parent = target;
  const suffix: string[] = [];
  while (true) {
    try {
      parent = await realpath(parent);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const next = path.dirname(parent);
      if (next === parent) throw err;
      suffix.unshift(path.basename(parent));
      parent = next;
    }
  }
  return path.join(parent, ...suffix);
}

/** A write must stay in the workspace, off the denied paths, out of `.git`, and inside the owned files. */
function assertWritable(scope: FileScope, target: string, actual: string): void {
  const outside =
    scope.readonly ||
    !isInside(scope.cwd, actual) ||
    !isInside(scope.cwd, target) ||
    scope.deniedWrites.some((p) => isInside(p, actual) || isInside(p, target));
  if (outside) throw new Error(MESSAGE.WriteOutside);
  const rel = toPosixRelative(path.relative(scope.cwd, actual));
  if (rel.split("/").includes(".git")) throw new Error(MESSAGE.GitMetadata);
  if (scope.ownership && !allowedFile(rel, specOf(scope.ownership), scope.ownership.ownsMain))
    throw new Error(ownershipReason(rel, scope.ownership));
}

/** What a tool call runs with: the session's files, sandbox and studio handlers. */
export interface ToolContext {
  request: DelegateRequest;
  cwd: string;
  signal: AbortSignal;
  resolveFile: FileResolver;
  sandbox: ProcessSandbox | null;
  forbidden: string[];
  deniedWrites: string[];
  /** The sandbox label: `<engine>:<session id>`. */
  label: string;
  /** Sections already read, keyed by file and range, so an unchanged one is not read twice. */
  seenReads: Map<string, string>;
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>;
}

type ToolArgs = Record<string, unknown>;
type LocalToolHandler = (args: ToolArgs, context: ToolContext) => Promise<LiveToolResult>;

/** What each of the session's own tools does. */
const LOCAL_TOOL_HANDLERS: Record<LocalTool, LocalToolHandler> = {
  [LocalTool.ReadFile]: readFileTool,
  [LocalTool.ListFiles]: listFilesTool,
  [LocalTool.EditFile]: editFileTool,
  [LocalTool.WriteFile]: writeFileTool,
  [LocalTool.RunCommand]: runCommandTool,
  [LocalTool.Capture]: captureTool,
};

function isLocalTool(name: string): name is LocalTool {
  return Object.hasOwn(LOCAL_TOOL_HANDLERS, name);
}

/**
 * Run one tool call: a local tool, an interview tool (recorded for the harness), or a live studio
 * tool. Throws on an unknown or failing tool; the caller reports that to the model as text.
 */
export async function executeLocalTool(
  call: ToolCall,
  definitions: ToolDefinition[],
  context: ToolContext,
): Promise<LiveToolResult> {
  if (!definitions.some((t) => t.name === call.name)) throw new Error(MESSAGE.UnknownTool(call.name));
  if (!isArgumentObject(call.arguments ?? {})) throw new Error(MESSAGE.MalformedArguments(call.name));
  const args = (call.arguments ?? {}) as ToolArgs;
  if (isLocalTool(call.name)) return LOCAL_TOOL_HANDLERS[call.name](args, context);
  const { request } = context;
  if (request.interviewTools?.some((t) => t.name === call.name)) {
    context.studioToolCalls.push({ name: call.name, args });
    return call.name === StudioTool.AskUser ? LOCAL_NOTE.askUserReply : LOCAL_NOTE.intakeReply;
  }
  if (!request.onLiveTool) throw new Error(MESSAGE.NoHandler(call.name));
  return request.onLiveTool(call.name, args);
}

/** Arguments a tool can run on: a JSON object (the engine keeps unparseable text as sent). */
function isArgumentObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFileTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  const file = await context.resolveFile(args.path);
  const info = await stat(file);
  if (info.size > LOCAL_TOOL_LIMITS.maxFileBytes) throw new Error(MESSAGE.TooLargeToRead);
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (mime) return { text: file, images: [{ mimeType: mime, data: (await readFile(file)).toString("base64") }] };
  const readKey = `${file}:${args.offset ?? 0}:${args.limit ?? LOCAL_TOOL_LIMITS.defaultReadLines}`;
  const version = `${info.mtimeMs}:${info.size}`;
  if (context.seenReads.get(readKey) === version) throw new Error(LOCAL_NOTE.alreadyRead);
  context.seenReads.set(readKey, version);
  return textSection(args, (await readFile(file, "utf8")).split("\n"));
}

/** The lines `read_file` asked for, headed with where they sit in the file. */
function textSection(args: ToolArgs, lines: string[]): string {
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const requested = Math.floor(Number(args.limit) || LOCAL_TOOL_LIMITS.defaultReadLines);
  const limit = Math.min(LOCAL_TOOL_LIMITS.maxReadLines, Math.max(1, requested));
  if (offset >= lines.length)
    return `End of file: ${args.path} has ${lines.length} lines; offset ${offset} is beyond the end. Read a smaller offset or search with run_command.`;
  const text = lines.slice(offset, offset + limit).join("\n");
  const partial = offset + limit < lines.length || text.length > LOCAL_TOOL_LIMITS.readChars;
  return (
    `[${args.path}: selected lines ${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length}; offset is zero-based]\n` +
    text.slice(0, LOCAL_TOOL_LIMITS.readChars) +
    (partial ? `\n[Partial file: ${lines.length} lines total. Use offset/limit for more.]` : "")
  );
}

async function listFilesTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  return (await readdir(await context.resolveFile(args.path ?? "."), { withFileTypes: true }))
    .slice(0, LOCAL_TOOL_LIMITS.listEntries)
    .map((e) => e.name + (e.isDirectory() ? "/" : ""))
    .join("\n");
}

async function editFileTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  const file = await context.resolveFile(args.path, true);
  const { oldText, newText } = args;
  const validEdit = typeof oldText === "string" && oldText !== "" && typeof newText === "string";
  if (!validEdit) throw new Error(MESSAGE.InvalidEdit);
  if ((await stat(file)).size > LOCAL_TOOL_LIMITS.maxFileBytes) throw new Error(MESSAGE.TooLargeToEdit);
  const source = await readFile(file, "utf8");
  const at = source.indexOf(oldText);
  if (at < 0 || source.indexOf(oldText, at + 1) >= 0) throw new Error(MESSAGE.AmbiguousEdit);
  await writeFile(file, source.slice(0, at) + newText + source.slice(at + oldText.length));
  return "Edited one matching block";
}

async function writeFileTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  const file = await context.resolveFile(args.path, true);
  if (typeof args.content !== "string") throw new Error(MESSAGE.ContentNotString);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, args.content);
  return "Written";
}

async function runCommandTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  if (typeof args.command !== "string") throw new Error(MESSAGE.CommandNotString);
  if (!context.sandbox) throw new Error(MESSAGE.ReadOnlyCommand);
  return JSON.stringify(
    await context.sandbox.run({
      command: args.command,
      cwd: context.cwd,
      signal: context.signal,
      timeoutMs: LOCAL_TOOL_LIMITS.commandTimeoutMs,
      maxOutputBytes: LOCAL_TOOL_LIMITS.commandOutputBytes,
      policy: { denyRead: context.forbidden, denyWrite: context.deniedWrites },
      label: context.label,
    }),
  );
}

async function captureTool(args: ToolArgs, context: ToolContext): Promise<LiveToolResult> {
  const { onCapture } = context.request;
  if (!onCapture) throw new Error(MESSAGE.NoCapture);
  return onCapture(captureArgs(args));
}
