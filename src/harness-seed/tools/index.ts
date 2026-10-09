/**
 * Tool registry — PLAN.md §5.1.
 *
 * Rebuilt on **every round of every turn** by re-scanning `tools/*.ts` and importing each module
 * with an mtime cache-buster. That is the whole trick behind "the studio installed a tool and
 * used it in the same turn": there is no registration ceremony and no restart, just files on disk
 * that the agent can write. Node runs the TypeScript by stripping its types; nothing is built.
 *
 * A module that fails to import is reported as a broken tool rather than taking the turn down —
 * the agent should see its own syntax error as a tool result and fix it.
 *
 * A tool module written before the harness was TypeScript is a `tools/*.mjs` file, and still
 * loads. When both `x.ts` and `x.mjs` are there, `x.ts` wins and `x.mjs` is not imported: an app
 * update lays `x.ts` down beside the old copy, which must not register every tool twice.
 */
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HostMethod } from "../loop/host-methods.ts";
import type { AnyRecord, HarnessCtx, HarnessTool, ToolCtx, ToolOutcome } from "../types/harness.d.ts";

/** One tool module the registry imported, and the tools it exports. */
export interface ToolModule {
  file: string;
  name: string;
  tools: HarnessTool[];
}

/** A tool module that would not load, and why — shown to the agent so it can fix it. */
export interface BrokenTool {
  file: string;
  name: string;
  error: string;
}

/** A registered tool, and where it came from (its module, a host plugin, a connector). */
type RegisteredTool = HarnessTool & { source: string };

/** The turn's options a registry is built for; every one reaches each tool's ctx. */
export interface RegistryOptions {
  candidateId?: string;
  project?: string | null;
  [option: string]: unknown;
}

/** A tool module: TypeScript, or a legacy `.mjs` from before the harness was TypeScript. */
const TOOL_MODULE = /\.(?:ts|mjs)$/;
/** The registry's own module, never a tool module. */
const REGISTRY_MODULES = new Set(["index.ts", "index.mjs"]);
/** The module a candidate's tools come from… */
const CANDIDATE_MODULE = "game-tools";
/** …and the only tools of it a candidate may use: it reads and writes its own files, and checks them. */
const CANDIDATE_TOOLS = new Set(["list_files", "read_file", "write_file", "check_game"]);

/** Where a registered tool came from, when it is not one of the workspace's own modules. */
const ToolSource = {
  Plugin: "host plugin",
  Connector: "connector",
} as const;

/** What a tool without a project is told. */
const NO_PROJECT = "Open a project first";

/** Should this directory entry be imported as a tool module? */
function isToolModule(entry: Dirent, files: ReadonlySet<string>): boolean {
  const moduleFile = entry.isFile() && TOOL_MODULE.test(entry.name) && !entry.name.endsWith(".d.ts");
  if (!moduleFile) return false;
  if (REGISTRY_MODULES.has(entry.name)) return false;
  // `x.ts` wins over the legacy `x.mjs` beside it.
  return !(entry.name.endsWith(".mjs") && files.has(entry.name.replace(/\.mjs$/, ".ts")));
}

export async function loadToolModules(workspace: string): Promise<{ modules: ToolModule[]; broken: BrokenTool[] }> {
  const dir = path.join(workspace, "tools");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const modules: ToolModule[] = [];
  const broken: BrokenTool[] = [];
  for (const entry of entries) {
    if (!isToolModule(entry, files)) continue;
    const file = path.join(dir, entry.name);
    try {
      const { mtimeMs } = await stat(file);
      const module = await import(`${pathToFileURL(file).href}?v=${mtimeMs}`);
      if (Array.isArray(module.tools)) modules.push({ file, name: entry.name, tools: module.tools });
      else broken.push({ file, name: entry.name, error: "module does not export `tools`" });
    } catch (err: any) {
      broken.push({ file, name: entry.name, error: err?.message ?? String(err) });
    }
  }
  return { modules, broken };
}

/** May a candidate's turn use this tool? Only its own file tools, from the game tools module. */
function candidateMayUse(tool: HarnessTool, module: ToolModule): boolean {
  return CANDIDATE_TOOLS.has(tool.name) && module.name.replace(TOOL_MODULE, "") === CANDIDATE_MODULE;
}

/** The workspace's own tools, by name; a candidate's turn gets only its file tools. */
function moduleTools(modules: readonly ToolModule[], options: RegistryOptions): Map<string, RegisteredTool> {
  const byName = new Map<string, RegisteredTool>();
  for (const module of modules) {
    for (const tool of module.tools) {
      if (!tool?.name || typeof tool.execute !== "function") continue;
      if (options.candidateId && !candidateMayUse(tool, module)) continue;
      byName.set(tool.name, { ...tool, source: module.name });
    }
  }
  return byName;
}

/** What the host adds to a registry: its plugins' and connectors' guidance, and their revision. */
interface HostTools {
  pluginGuidance: string;
  connectorGuidance: string;
  toolRegistryRevision: number | undefined;
}

/** Register the host's plugin tools, then its connectors. A name taken twice is an error. */
async function addHostTools(
  ctx: HarnessCtx,
  byName: Map<string, RegisteredTool>,
  options: RegistryOptions,
): Promise<HostTools> {
  const plugins = await ctx.call(HostMethod.PluginsTools, {});
  for (const tool of plugins.tools) {
    if (byName.has(tool.name)) throw new Error(`Plugin tool collision: ${tool.name}`);
    byName.set(tool.name, pluginTool(tool));
  }
  // Connectors last, and on the same terms: the host owns the list and this loop only calls it.
  // A connector's schema is the real one — arrays, enums, nested objects — so it goes to the
  // model as it stands instead of through the flat projection every older tool declares.
  const mcp = await ctx.call(HostMethod.McpTools, { project: options.project ?? null });
  for (const tool of mcp.tools) {
    if (byName.has(tool.name)) throw new Error(`Connector tool collision: ${tool.name}`);
    byName.set(tool.name, connectorTool(tool));
  }
  return {
    pluginGuidance: plugins.guidance ?? "",
    connectorGuidance: mcp.guidance ?? "",
    toolRegistryRevision: mcp.revision === plugins.revision ? plugins.revision : undefined,
  };
}

/** A host plugin's tool: invoked through the host, on the chat's project. */
function pluginTool(tool: Pick<HarnessTool, "name" | "description" | "parameters">): RegisteredTool {
  return {
    ...tool,
    source: ToolSource.Plugin,
    async execute(args, callCtx) {
      if (!callCtx.project) throw new Error(NO_PROJECT);
      const result = await callCtx.call(HostMethod.PluginsInvoke, {
        name: tool.name,
        args,
        project: callCtx.project,
        threadId: callCtx.threadId,
      });
      const { images, ...record } = result as AnyRecord;
      return { ok: true, content: JSON.stringify(record), ...(images ? { images } : {}) };
    },
  };
}

/** A connector's tool: its own schema, invoked through the host on the chat's project. */
function connectorTool(
  tool: Pick<HarnessTool, "name" | "description" | "parameters"> & { inputSchema?: AnyRecord },
): RegisteredTool {
  return {
    ...tool,
    parameters: tool.inputSchema ?? tool.parameters,
    source: ToolSource.Connector,
    async execute(args, callCtx) {
      if (!callCtx.project) throw new Error(NO_PROJECT);
      const result = await callCtx.call(HostMethod.McpInvoke, {
        name: tool.name,
        args,
        project: callCtx.project,
        threadId: callCtx.threadId,
      });
      // A connector answers with the server's own text, not a studio record: it is handed on.
      const text = typeof result === "string" ? result : result?.text;
      const images = typeof result === "string" ? undefined : result?.images;
      return { ok: true, content: text ?? "", ...(images ? { images } : {}) };
    },
  };
}

/** A tool's answer as the turn records it: a sentence, or a result with the sentence in `content`. */
function toolAnswer(result: ToolOutcome | string): ToolOutcome & { ok: boolean; content: string } {
  if (typeof result === "string") return { ok: true, content: result };
  return {
    ok: result?.ok !== false,
    content: result?.content ?? "",
    ...(result?.details ? { details: result.details } : {}),
    ...(result?.images ? { images: result.images } : {}),
    ...(result?.stopTurn ? { stopTurn: result.stopTurn } : {}),
  };
}

export async function createToolRegistry(ctx: HarnessCtx, options: RegistryOptions = {}) {
  const { modules, broken } = await loadToolModules(ctx.workspace);
  const byName = moduleTools(modules, options);
  const host: HostTools = options.candidateId
    ? { pluginGuidance: "", connectorGuidance: "", toolRegistryRevision: undefined }
    : await addHostTools(ctx, byName, options);

  return {
    broken,
    toolRegistryRevision: host.toolRegistryRevision,

    names: () => [...byName.keys()],

    /** Schemas handed to the model. */
    definitions: () =>
      [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      })),

    /**
     * What the tool schemas cannot say: the plugins' and connectors' guidance and the modules
     * that failed to load. Each tool's own description travels once, with its schema.
     */
    summary: () => {
      const lines: string[] = [];
      if (host.pluginGuidance) lines.push(host.pluginGuidance);
      if (host.connectorGuidance) lines.push(host.connectorGuidance);
      if (broken.length) {
        lines.push(...broken.map((entry) => `- (BROKEN) ${entry.name}: ${entry.error} — fix it with write_own_file`));
      }
      return lines.join("\n");
    },

    async execute(
      call: { name: string; arguments?: unknown },
      callCtx: HarnessCtx,
    ): Promise<ToolOutcome & { ok: boolean; content: string }> {
      const tool = byName.get(call.name);
      if (!tool) {
        return { ok: false, content: `no such tool: ${call.name}. Available: ${[...byName.keys()].join(", ")}` };
      }
      const args = (call.arguments ?? {}) as AnyRecord;
      const problems = argumentProblems(tool.parameters, args);
      if (problems.length) return { ok: false, content: ARGS_REFUSED(call.name, problems) };
      try {
        return toolAnswer(await tool.execute(args, { ...callCtx, ...options } as ToolCtx));
      } catch (err: any) {
        // Tool failures are data for the agent, not crashes.
        return { ok: false, content: `${call.name} failed: ${err?.message ?? err}` };
      }
    },
  };
}

/** What the model is told about arguments its tool's schema refuses; the tool did not run. */
const ARGS_REFUSED = (tool: string, problems: string[]) =>
  `${tool} did not run: ${problems.join("; ")}. Call it again with arguments that match its parameters.`;

/** A declared parameter as the registry checks it: its JSON type, and whether an object may come as JSON text. */
type DeclaredParameter = { type?: string; acceptJsonString?: boolean };

/**
 * What is wrong with `args` against the tool's declared parameters: a required one missing, or one
 * of the wrong type. A tool used to coerce a wrong value silently (`Number(x) || default`) and run
 * on its default. A number or a flag sent as its text still reads as one — local models do.
 */
export function argumentProblems(
  parameters: { properties?: Record<string, DeclaredParameter>; required?: string[] } | undefined,
  args: AnyRecord,
): string[] {
  const properties = parameters?.properties ?? {};
  const missing = (parameters?.required ?? []).filter((name) => args[name] === undefined || args[name] === null);
  const wrong = Object.entries(args).flatMap(([name, value]) => {
    const declared = properties[name];
    const type = declared?.type;
    if (!type || value === undefined || value === null || fitsType(type, value)) return [];
    if (declared.acceptJsonString && typeof value === "string") return [];
    return [`${name} must be ${type === "integer" ? "a whole number" : `a ${type}`}, not ${JSON.stringify(value)}`];
  });
  return [...missing.map((name) => `${name} is required`), ...wrong];
}

/** Does `value` read as the JSON `type` a parameter declares? */
function fitsType(type: string, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return Number.isFinite(asNumber(value));
  if (type === "integer") return Number.isInteger(asNumber(value));
  if (type === "boolean") return typeof value === "boolean" || value === "true" || value === "false";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  return true;
}

/** A number, or one sent as its digits; anything else is not a number. */
function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/** The tools of one round, with what a prompt says about them. */
export type ToolRegistry = Awaited<ReturnType<typeof createToolRegistry>>;
