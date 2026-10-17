/**
 * What a plugin manifest's tools, skills and MCP servers may say about where they apply (API 3):
 * `facts`, the project facts of the games they reach (`shared/project-facts.ts`); a tool's
 * `makes`, the facts it makes in a game's folder; a skill's `tools`, the agent tools it explains.
 * Checked here and kept in canonical form; the registry applies them (`pluginReach`).
 */
import { isAgentTool, type PluginManifest, type PluginManifestTool } from "../../shared/plugins.ts";
import { isFactId } from "../../shared/project-facts.ts";

/** How much one tool, skill or server may name. */
const LIMIT = { Facts: 8, Makes: 4, SkillTools: 16 } as const;

/** What a publisher reads when a scope is refused. */
const MESSAGE = {
  NeedsApi3: (field: string) => `${field} requires apiVersion 3`,
  InvalidFacts: (where: string) =>
    `Invalid ${where}.facts (1-${LIMIT.Facts} fact ids: lowercase letters, digits and dashes, starting with a letter, each once)`,
  InvalidMakes: `Invalid tools[].makes (1-${LIMIT.Makes} fact ids, each once)`,
  HarnessMakes: "tools[].makes is for agent tools: a tool only the harness calls makes nothing",
  InvalidSkillTools: `Invalid skills[].tools (1-${LIMIT.SkillTools} names of agent tools the manifest declares, each once)`,
} as const;

/** A list of `min`-`max` distinct entries, each passing `valid`, or undefined. */
function distinctList(value: unknown, max: number, valid: (entry: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return undefined;
  if (!value.every(valid) || new Set(value).size !== value.length) return undefined;
  return [...(value as string[])];
}

/** A `facts` list in canonical form: API 3, 1-8 distinct fact ids. */
function factList(value: unknown, where: string, m: Pick<PluginManifest, "apiVersion">): string[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3(`${where}.facts`));
  const facts = distinctList(value, LIMIT.Facts, isFactId);
  if (!facts) throw new Error(MESSAGE.InvalidFacts(where));
  return facts;
}

/** A tool's `facts` and `makes`, copied onto its canonical form when declared. */
export function applyToolScope(
  raw: PluginManifestTool,
  tool: PluginManifestTool,
  m: Pick<PluginManifest, "apiVersion">,
): void {
  if (raw.facts !== undefined) tool.facts = factList(raw.facts, "tools[]", m);
  if (raw.makes === undefined) return;
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3("tools[].makes"));
  if (!isAgentTool(raw)) throw new Error(MESSAGE.HarnessMakes);
  const makes = distinctList(raw.makes, LIMIT.Makes, isFactId);
  if (!makes) throw new Error(MESSAGE.InvalidMakes);
  tool.makes = makes;
}

/** A skill's `facts` and `tools` (names of agent tools among `tools`), as fields to add to its canonical form. */
export function skillScopeFields(
  raw: Record<string, unknown>,
  tools: readonly PluginManifestTool[],
  m: Pick<PluginManifest, "apiVersion">,
): { facts?: string[]; tools?: string[] } {
  const fields: { facts?: string[]; tools?: string[] } = {};
  if (raw.facts !== undefined) fields.facts = factList(raw.facts, "skills[]", m);
  if (raw.tools === undefined) return fields;
  const agentTools = new Set(tools.filter(isAgentTool).map((t) => t.name));
  const named = distinctList(raw.tools, LIMIT.SkillTools, (name) => typeof name === "string" && agentTools.has(name));
  if (!named) throw new Error(MESSAGE.InvalidSkillTools);
  fields.tools = named;
  return fields;
}

/** A toolbar item's `facts` in canonical form, or undefined when it names none (every game). */
export function toolbarFacts(raw: { facts?: unknown }, m: Pick<PluginManifest, "apiVersion">): string[] | undefined {
  return raw.facts === undefined ? undefined : factList(raw.facts, "toolbar[]", m);
}

/** An MCP server's `facts` in canonical form, or undefined when it names none. */
export function serverFacts(raw: { facts?: unknown }, m: Pick<PluginManifest, "apiVersion">): string[] | undefined {
  return raw.facts === undefined ? undefined : factList(raw.facts, "mcpServers[]", m);
}
