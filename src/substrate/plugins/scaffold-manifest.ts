/**
 * A plugin manifest's `scaffolds` section (API 3): the kinds of project its tools make, each with its
 * own label (`shared/plugins.ts` `PluginScaffold`). Checked here and kept in canonical form, only the
 * keys a scaffold declares.
 */
import {
  isAgentTool,
  type PluginManifest,
  type PluginManifestTool,
  type PluginScaffold,
} from "../../shared/plugins.ts";
import { type FactRule, isFactId, isScaffoldLabel, parseFactRule, SCAFFOLD_LIMIT } from "../../shared/project-facts.ts";

/** How many scaffolds one manifest may declare. */
const MAX_SCAFFOLDS = 8;

/** What a publisher reads when `scaffolds` is refused. */
const MESSAGE = {
  NeedsApi3: "scaffolds requires apiVersion 3",
  NotList: `Invalid scaffolds (a list of at most ${MAX_SCAFFOLDS})`,
  NotScaffold: "Invalid scaffolds entry (an object with id, label and optional tool, game and facts)",
  InvalidGame: (id: string) => `Invalid scaffold ${id} game (true or false)`,
  InvalidId: "Invalid scaffold id (lowercase letters, digits and dashes, starting with a letter, at most 40)",
  RepeatedId: (id: string) => `Duplicate scaffold id: ${id}`,
  RepeatedTool: (tool: string) => `Duplicate scaffold tool: ${tool} (each scaffold has a tool of its own)`,
  InvalidLabel: `Invalid scaffold label (text of 1-${SCAFFOLD_LIMIT.LabelChars} characters)`,
  InvalidTool: (id: string) => `Invalid scaffold ${id} tool (an agent tool of this plugin that declares makes)`,
  FactsWithoutTool: (id: string) => `Invalid scaffold ${id}: facts need a tool`,
  InvalidFacts: (id: string) =>
    `Invalid scaffold ${id} facts (at most ${SCAFFOLD_LIMIT.Rules} rules in the detect grammar, each of a fact its tool makes)`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The agent tool a scaffold names, when it declares `makes`; else undefined. */
function kindTool(tools: readonly PluginManifestTool[], name: unknown): PluginManifestTool | undefined {
  if (typeof name !== "string") return undefined;
  const tool = tools.find((declared) => declared.name === name);
  return tool && isAgentTool(tool) && tool.makes?.length ? tool : undefined;
}

/** A scaffold's rules: each well-formed and of a fact its tool makes. */
function scaffoldRules(id: string, raw: unknown, makes: readonly string[]): FactRule[] {
  if (!Array.isArray(raw) || raw.length > SCAFFOLD_LIMIT.Rules) throw new Error(MESSAGE.InvalidFacts(id));
  return raw.map((entry) => {
    const rule = parseFactRule(entry);
    if (!rule || !makes.includes(rule.fact)) throw new Error(MESSAGE.InvalidFacts(id));
    return rule;
  });
}

/** One scaffold in canonical form. */
function validateScaffold(raw: unknown, tools: readonly PluginManifestTool[]): PluginScaffold {
  if (!isRecord(raw)) throw new Error(MESSAGE.NotScaffold);
  if (!isFactId(raw.id)) throw new Error(MESSAGE.InvalidId);
  if (!isScaffoldLabel(raw.label)) throw new Error(MESSAGE.InvalidLabel);
  const scaffold: PluginScaffold = { id: raw.id, label: raw.label };
  if (raw.tool === undefined) {
    if (raw.facts !== undefined) throw new Error(MESSAGE.FactsWithoutTool(raw.id));
    return scaffold;
  }
  const tool = kindTool(tools, raw.tool);
  if (!tool) throw new Error(MESSAGE.InvalidTool(raw.id));
  scaffold.tool = tool.name;
  if (raw.game !== undefined) {
    if (typeof raw.game !== "boolean") throw new Error(MESSAGE.InvalidGame(raw.id));
    scaffold.game = raw.game;
  }
  if (raw.facts !== undefined) scaffold.facts = scaffoldRules(raw.id, raw.facts, tool.makes ?? []);
  return scaffold;
}

/**
 * The manifest's `scaffolds` in canonical form, checked against its canonical `tools`: at most eight,
 * each id once and each tool once (a call is recorded as its tool's one scaffold). Throws on API 1 or 2 and on any malformed scaffold.
 */
export function validateScaffolds(m: Pick<PluginManifest, "apiVersion" | "scaffolds" | "tools">): PluginScaffold[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3);
  const raw: unknown = m.scaffolds;
  if (!Array.isArray(raw) || raw.length > MAX_SCAFFOLDS) throw new Error(MESSAGE.NotList);
  const ids = new Set<string>();
  const tools = new Set<string>();
  return raw.map((entry) => {
    const scaffold = validateScaffold(entry, m.tools);
    if (ids.has(scaffold.id)) throw new Error(MESSAGE.RepeatedId(scaffold.id));
    if (scaffold.tool !== undefined && tools.has(scaffold.tool)) throw new Error(MESSAGE.RepeatedTool(scaffold.tool));
    ids.add(scaffold.id);
    if (scaffold.tool !== undefined) tools.add(scaffold.tool);
    return scaffold;
  });
}
