import { validateDetect } from "./detect-manifest.ts";
import { validateAssets, validateWorkspace } from "./workspace-manifest.ts";
import { validateFolders, validateWorkerTypes } from "./worker-manifest.ts";
import { applyToolScope, serverFacts, skillScopeFields } from "./scope-manifest.ts";
import { validateNativeDeclarations } from "./native-manifest.ts";
import { assertRelativePath, containedReal } from "../paths.ts";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import type {
  PluginFileSkill,
  PluginManifest,
  PluginManifestTool,
  PluginMcpEnvValue,
  PluginMcpServer,
  PluginScalar,
  PluginSkill,
  PluginTool,
  PluginToolbarItem,
  PluginToolbarTarget,
} from "../../shared/plugins.ts";
import {
  isFileSkill,
  isToolbarIconName,
  PLUGIN_SKILL_TOOL,
  PluginCapability,
  PluginHostTool,
  PluginToolAudience,
  TOOLBAR_ICON_NAMES,
} from "../../shared/plugins.ts";
import { PLUGIN_ID } from "../../shared/plugin-id.ts";
import { GameEngine, isGameEngine } from "../../shared/game-engine.ts";
import { MCP_ID, McpTransport } from "../../shared/mcp.ts";
import { pictureType } from "../image-sniff.ts";

/** The plugin's id, and every name it declares (tools, skills, panels, actions, settings). */
const id = PLUGIN_ID;
/** A plugin server id joins its plugin id as `<pluginId>-<id>`, which must still fit a connector id. */
const mcpServerId = MCP_ID;
const envName = /^[A-Z_][A-Z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/**
 * `host-cli` runs a program Studio ships rather than one the package contains, which is a
 * different trust class from `node <script in my own folder>`: only the bundled Genex plugin,
 * whose CLI Studio already spawns for asset work, may ask for it.
 */
const HOST_CLI_PLUGIN = "genex";
/** Host tools that spend credits or change the game: each needs the user's consent every time. */
const CONSENTED_HOST_TOOLS: ReadonlySet<string> = new Set([PluginHostTool.GenexCliPaid, PluginHostTool.GenexPackage]);
const HOST_TOOLS: ReadonlySet<unknown> = new Set(Object.values(PluginHostTool));
const TOOL_AUDIENCES: ReadonlySet<unknown> = new Set(Object.values(PluginToolAudience));
const KIB = 1024;
/** The Genex blender server's own per-call ceiling is 15 minutes; 30 is the outer bound. */
const MAX_CALL_TIMEOUT_MS = 1_800_000;
const MIN_CALL_TIMEOUT_MS = 1_000;
/** How many folders a package inspection lists at once. */
const PACKAGE_WALK_FOLDERS = 16;
const hostname = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/i;
/** Every capability a manifest may name. */
export const CAPABILITIES = new Set<string>(Object.values(PluginCapability));
/** Actions that must carry a trusted confirmation: they spend, unlock, connect or publish. */
const SENSITIVE_ACTIONS = new Set([
  "unlock",
  "connect",
  "disconnect",
  "approve",
  "allowance",
  "enable-paid",
  "configure-paid",
  "publish-draft",
  "publish-gallery",
]);
/** Labels Studio's own stage-strip buttons use; the build smoke finds them by exact text. */
export const RESERVED_TOOLBAR_LABELS: ReadonlySet<string> = new Set([
  "Retry",
  "Ready",
  "Live",
  "Builds",
  "Assets",
  "Export",
  "Plugins",
  "Reload",
  "State",
  "Close plugins",
]);
const reservedLower = new Set([...RESERVED_TOOLBAR_LABELS].map((l) => l.toLowerCase()));
const SUPPORTED_API_VERSIONS = [1, 2, 3];
/** Declared limits, each the largest a manifest field may be. */
const LIMIT = {
  NameChars: 200,
  DescriptionChars: 4000,
  ConfirmationChars: 300,
  LabelChars: 120,
  NetworkHosts: 32,
  HostnameChars: 253,
  McpServers: 4,
  McpArgs: 32,
  McpArgChars: 1024,
  McpEnvVars: 32,
  McpEnvNameChars: 64,
  McpLiteralChars: 4096,
  McpRequiredSettings: 32,
  McpMaxTools: 64,
  McpPolicyNames: 64,
  ToolbarItems: 4,
  ToolbarLabelChars: 24,
  ToolbarAriaChars: 60,
  ToolbarGlyphChars: 4,
  TargetArgs: 16,
  ToolInputChars: 100000,
  SkillCount: 32,
  /** The largest bundled inline skill is 1,651 characters. */
  SkillChars: 16_000,
  SkillSummaryChars: 300,
  SkillReferences: 16,
  /** Genex's multiplayer card is 69,881 bytes before Studio's preface. */
  SkillFileBytes: 128 * KIB,
  SkillPackageBytes: 1024 * KIB,
  /** A plugin's picture, drawn at most 64 points square: a 512-pixel PNG is well under this. */
  IconBytes: 512 * KIB,
} as const;
/** The pictures a plugin may ship as its icon, by extension, with the type each is served as. */
export const PLUGIN_ICON_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
/** The array fields every manifest carries. */
const REQUIRED_LISTS = ["capabilities", "tools", "skills", "panels", "settings", "actions"] as const;
const SCALAR_TYPES = ["string", "number", "boolean"];
/** The account actions a declared account flow maps, each to one declared action. */
const ACCOUNT_KEYS = ["connect", "unlock", "disconnect", "status"] as const;
/** Where an MCP server's environment value may come from. */
const EnvSource = {
  CredentialFile: "credential-file",
  Setting: "setting:",
  Secret: "secret:",
  Literal: "literal:",
} as const;

/** What a publisher reads when a manifest is refused, and a caller when tool input is. */
const MESSAGE = {
  InvalidIcon: "icon must name a .png, .jpg, .webp or .svg file inside the package",
  MissingIcon: (file: string) => `icon ${file} is missing from the package`,
  IconNotAFile: (file: string) => `icon ${file} is not a plain file`,
  IconTooLarge: (file: string) => `icon ${file} exceeds ${LIMIT.IconBytes} bytes`,
  IconNotPicture: (file: string) => `icon ${file} is not the picture its name says`,
  ScalarParameters: "Tool parameters must be scalar in API 1 and API 2",
  InvalidParameterDescription: "Invalid tool parameter description",
  InvalidJsonCompatibility: "Invalid JSON input compatibility",
  InvalidTool: "Invalid or duplicate tool",
  InvalidName: (kind: string, name: unknown) =>
    `Invalid ${kind} name ${JSON.stringify(name ?? null)}: use lowercase letters, digits and hyphens, starting with a letter, at most 48 characters (get-scene, not get_scene)`,
  UnknownRequired: "Unknown required field",
  ConfirmationNeedsApi2: "tools[].confirmation requires apiVersion 2",
  InvalidConfirmation: "Invalid tool confirmation (1-300 characters)",
  InvalidSkill: "Invalid plugin skill",
  TooManySkills: `Invalid plugin skills (at most ${LIMIT.SkillCount})`,
  DuplicateSkill: "Invalid plugin skill: duplicate name",
  SkillTextOrFile: "A plugin skill has either text or a file, not both",
  InvalidSkillText: `Invalid plugin skill text (1-${LIMIT.SkillChars} characters)`,
  InvalidSkillSummary: `Invalid plugin skill summary (1-${LIMIT.SkillSummaryChars} characters)`,
  SkillNotMarkdown: "A plugin skill file is a Markdown (.md) file",
  SkillInDotFolder: "A plugin skill file may not be a dot file or sit in a dot folder: packing leaves those out",
  InvalidSkillReferences: `Invalid plugin skill references (at most ${LIMIT.SkillReferences}, distinct, and not the skill's own file)`,
  FileSkillNeedsApi3: "A plugin skill file requires apiVersion 3",
  InvalidSkillEngines: `Invalid plugin skill engines (a non-empty list of ${Object.values(GameEngine).join(", ")}, each once)`,
  ReservedSkillTool: `Tool name "${PLUGIN_SKILL_TOOL}" is reserved for reading the plugin's file skills`,
  MissingSkillFile: (file: string) => `Plugin skill file ${file} is missing`,
  SkillNotAFile: (file: string) => `Plugin skill file ${file} is not a plain file`,
  SkillFileTooLarge: (file: string) =>
    `Plugin skill file ${file} is too large (at most ${LIMIT.SkillFileBytes / KIB} KiB)`,
  SkillFilesTooLarge: `Plugin skill files total more than ${LIMIT.SkillPackageBytes / KIB / KIB} MiB`,
  HostToolReserved:
    "tools[].host runs a program Studio ships and is reserved for the bundled Genex plugin on apiVersion 3",
  InvalidHostTool: `Invalid tools[].host (${[...HOST_TOOLS].join(", ")})`,
  HostToolNeedsConfirmation: "A host tool that spends credits or installs packages needs a confirmation",
  AudienceNeedsApi3: "tools[].audience requires apiVersion 3",
  InvalidToolAudience: `Invalid tools[].audience (${[...TOOL_AUDIENCES].join(", ")})`,
  InvalidPanel: "Invalid panel",
  InvalidAction: "Invalid action",
  SensitiveNeedsConfirmation: "Sensitive actions require trusted confirmation",
  InvalidSetting: "Invalid setting",
  InvalidNetworkHosts: "Invalid network hosts (at most 32 hostnames)",
  AccountNeedsApi2: "Account flow requires API 2 and credentials",
  InvalidAccountAction: (key: string) => `Invalid account action: ${key}`,
  InvalidCancelAction: "Invalid account cancel action",
  AccountActionsDistinct: "Account actions must be distinct",
  InvalidAssetLimits: "Invalid asset delivery limits",
  NetworkNeedsApi2: "network requires apiVersion 2",
  ToolbarNeedsApi2: "toolbar requires apiVersion 2",
  McpNeedsApi2: "mcpServers requires apiVersion 2",
  NativeNeedsApi3: "Native runtimes require API 3 and native-runtime capability",
  IncompatibleManifest: "Invalid or incompatible plugin manifest (Studio API 1, 2 or 3 required)",
  MissingList: (field: string) => `Missing plugin ${field}`,
  UnsupportedCapability: "Unsupported plugin capability",
  McpStdioOnly: "An mcpServers entry is stdio",
  InvalidMcpCommand: "Invalid mcpServers command ('node' or 'host-cli')",
  HostCliReserved:
    "mcpServers command 'host-cli' starts a program Studio ships and is reserved for the bundled Genex plugin; use 'node' with a script inside your own package",
  InvalidMcpArgs: "Invalid mcpServers args (at most 32 strings)",
  NodeNeedsScript: "mcpServers command 'node' needs the script to run as its first argument",
  InvalidMcpCwd: "Invalid mcpServers cwd ('storage' or 'storage:project')",
  McpNeedsDescription: "An mcpServers entry needs a description",
  InvalidMaxTools: "Invalid mcpServers maxTools (1-64)",
  InvalidCallTimeout: `Invalid mcpServers callTimeoutMs (1000-${MAX_CALL_TIMEOUT_MS})`,
  TooManyServers: "Invalid mcpServers (at most 4 servers)",
  InvalidServerId: "Invalid mcpServers id (unique, lowercase letters, digits and dashes, no underscore)",
  ConnectorIdTooLong: (connector: string) =>
    `mcpServers id makes the connector id ${connector} longer than 32 characters; shorten the plugin or server id`,
  InvalidMcpEnv: "Invalid mcpServers env",
  TooManyEnvVars: "Invalid mcpServers env (at most 32 variables)",
  InvalidEnvName: (name: string) => `Invalid mcpServers environment variable name: ${name}`,
  InvalidEnvValue: (name: string) => `Invalid mcpServers env value for ${name}`,
  RefusedEnvValue: (name: string, problem: string) => `Invalid mcpServers env value for ${name}: ${problem}`,
  InvalidRequiredSettings: "Invalid mcpServers requires.settings",
  UndeclaredRequiredSetting: (key: string) => `Invalid mcpServers requires.settings: "${key}" is not declared`,
  InvalidRequires: "Invalid mcpServers requires",
  InvalidRequiresCredential: "Invalid mcpServers requires.credential",
  CredentialNeedsCapability: "mcpServers requires.credential needs the credentials capability",
  InvalidToolPolicy: "Invalid mcpServers toolPolicy",
  InvalidToolPolicyList: (label: string) => `Invalid mcpServers toolPolicy ${label}`,
  InvalidToolbarLabel: "Invalid toolbar label (1-24 characters)",
  ReservedToolbarLabel: (label: string) => `Invalid toolbar label: "${label}" is reserved by Studio`,
  InvalidToolbarAria: "Invalid toolbar ariaLabel (1-60 characters, unique, not reserved)",
  InvalidToolbarIcon: `Invalid toolbar icon (a glyph of at most 4 characters, or one of ${TOOLBAR_ICON_NAMES.join(", ")})`,
  InvalidRequiresProject: "Invalid toolbar requiresProject",
  StatusUndeclared: "Invalid toolbar status: must name a declared action",
  StatusConfirms: "Invalid toolbar status: the action must not require confirmation",
  InvalidNative: "Invalid action: native must be true when present",
  TooManyToolbarItems: "Invalid toolbar (at most 4 items)",
  InvalidToolbarId: "Invalid toolbar item id (unique, lowercase)",
  InvalidToolbarTarget: "Invalid toolbar target",
  UnknownTargetAction: "Invalid toolbar target: unknown action",
  InvalidTargetArgs: "Invalid toolbar target args (scalar values, at most 16 keys)",
  UnknownTargetPanel: "Invalid toolbar target: unknown panel",
  InvalidTargetKind: "Invalid toolbar target kind",
  LinksInPackage: "Plugin packages may not contain links or special files",
  InvalidJsonInput: (key: string) => `Invalid JSON input: ${key}`,
  InputNotObject: "Tool input must be an object",
  MissingInput: (key: string) => `Missing ${key}`,
  InvalidInput: (key: string) => `Invalid tool input: ${key}`,
  CredentialFileNeedsCapability: "credential-file needs the credentials capability",
  UndeclaredEnvSetting: (key: string) => `setting "${key}" is not declared`,
  InvalidSecretName: "a secret name is A-Z, 0-9 and underscore",
  LiteralTooLong: "literal is too long",
  UnknownEnvSource: "use setting:<key>, secret:<name>, literal:<value> or credential-file",
} as const;

const isText = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isScalar = (v: unknown): v is PluginScalar =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasCapability = (m: PluginManifest, capability: PluginCapability) => m.capabilities.includes(capability);
const declaresSetting = (m: PluginManifest, key: string) => m.settings.some((s) => s.key === key);

/** The fields every manifest must have before anything else is read. */
function hasValidHeader(m: PluginManifest): boolean {
  if (!m || typeof m !== "object" || !SUPPORTED_API_VERSIONS.includes(m.apiVersion)) return false;
  if (!id.test(m.id) || !SEMVER.test(m.version)) return false;
  return (
    isText(m.name, 1, LIMIT.NameChars) &&
    isText(m.publisher, 1, LIMIT.NameChars) &&
    isText(m.description, 1, LIMIT.DescriptionChars)
  );
}

type ParameterSpec = PluginTool["parameters"]["properties"][string];

/** One tool parameter: scalar (or, in API 3, an object that may arrive as a JSON string). */
function toolParameter(s: ParameterSpec, apiVersion: number): ParameterSpec {
  const types = [...SCALAR_TYPES, ...(apiVersion === 3 ? ["object"] : [])];
  if (!s || !types.includes(s.type)) throw new Error(MESSAGE.ScalarParameters);
  if (s.description !== undefined && typeof s.description !== "string")
    throw new Error(MESSAGE.InvalidParameterDescription);
  const jsonCompatible = apiVersion === 3 && s.type === "object" && typeof s.acceptJsonString === "boolean";
  if (s.acceptJsonString !== undefined && !jsonCompatible) throw new Error(MESSAGE.InvalidJsonCompatibility);
  return {
    type: s.type,
    ...(s.description === undefined ? {} : { description: s.description }),
    ...(s.acceptJsonString ? { acceptJsonString: true } : {}),
  };
}

const isValidToolHeader = (t: PluginTool, names: Set<string>) =>
  Boolean(t) &&
  id.test(t.name) &&
  !names.has(t.name) &&
  typeof t.description === "string" &&
  t.parameters?.type === "object" &&
  isRecord(t.parameters.properties);

/** A declared name that breaks the id rule is refused with the rule itself, before anything else about it. */
function assertName(kind: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || !id.test(name)) throw new Error(MESSAGE.InvalidName(kind, name));
}

/** A tool's `host`: a known host program, on the bundled Genex plugin's API 3 only, consented when it spends. */
function validateHost(t: PluginManifestTool, m: PluginManifest): void {
  if (m.id !== HOST_CLI_PLUGIN || m.apiVersion !== 3) throw new Error(MESSAGE.HostToolReserved);
  if (!HOST_TOOLS.has(t.host)) throw new Error(MESSAGE.InvalidHostTool);
  if (CONSENTED_HOST_TOOLS.has(String(t.host)) && t.confirmation === undefined)
    throw new Error(MESSAGE.HostToolNeedsConfirmation);
}

/** A tool's `audience` (API 3): one Studio knows. */
function validateAudience(t: PluginManifestTool, m: PluginManifest): void {
  if (m.apiVersion < 3) throw new Error(MESSAGE.AudienceNeedsApi3);
  if (!TOOL_AUDIENCES.has(t.audience)) throw new Error(MESSAGE.InvalidToolAudience);
}

/** A tool's optional declarations: its consent question (API 2), its host program and its audience. */
function validateToolOptions(t: PluginManifestTool, m: PluginManifest): void {
  if (t.confirmation !== undefined) {
    if (m.apiVersion < 2) throw new Error(MESSAGE.ConfirmationNeedsApi2);
    if (!isText(t.confirmation, 1, LIMIT.ConfirmationChars)) throw new Error(MESSAGE.InvalidConfirmation);
  }
  if (t.host !== undefined) validateHost(t, m);
  if (t.audience !== undefined) validateAudience(t, m);
}

/** One tool in canonical form; `names` holds the tool names already declared. */
function validateTool(t: PluginManifestTool, m: PluginManifest, names: Set<string>): PluginManifestTool {
  assertName("tool", t?.name);
  if (!isValidToolHeader(t, names)) throw new Error(MESSAGE.InvalidTool);
  names.add(t.name);
  const properties: PluginTool["parameters"]["properties"] = {};
  for (const [key, s] of Object.entries(t.parameters.properties)) properties[key] = toolParameter(s, m.apiVersion);
  const required = t.parameters.required;
  const unknownRequired =
    required !== undefined &&
    (!Array.isArray(required) || required.some((k) => typeof k !== "string" || !Object.hasOwn(properties, k)));
  if (unknownRequired) throw new Error(MESSAGE.UnknownRequired);
  validateToolOptions(t, m);
  const tool: PluginManifestTool = {
    name: t.name,
    description: t.description,
    parameters:
      required === undefined ? { type: "object", properties } : { type: "object", properties, required: [...required] },
  };
  if (t.confirmation !== undefined) tool.confirmation = t.confirmation;
  if (t.host !== undefined) tool.host = t.host;
  // Agents are the default audience, so only the harness is written.
  if (t.audience === PluginToolAudience.Harness) tool.audience = t.audience;
  applyToolScope(t, tool, m);
  return tool;
}

/** A skill's file or reference path: package-relative, Markdown, and outside every dot folder. */
function assertSkillPath(file: unknown): string {
  const rel = assertRelativePath(typeof file === "string" ? file : "");
  if (!rel.endsWith(".md")) throw new Error(MESSAGE.SkillNotMarkdown);
  if (rel.split("/").some((segment) => segment.startsWith("."))) throw new Error(MESSAGE.SkillInDotFolder);
  return rel;
}

/** A file skill's references: skill paths, at most the cap, none repeated and none the skill's own file. */
function skillReferences(value: unknown, file: string): string[] {
  if (!Array.isArray(value) || value.length > LIMIT.SkillReferences) throw new Error(MESSAGE.InvalidSkillReferences);
  const references = value.map(assertSkillPath);
  if (new Set([file, ...references]).size !== references.length + 1) throw new Error(MESSAGE.InvalidSkillReferences);
  return references;
}

/** An API 3 file skill in canonical form. */
function fileSkill(s: Record<string, unknown>, name: string, m: PluginManifest): PluginFileSkill {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.FileSkillNeedsApi3);
  if (!isText(s.summary, 1, LIMIT.SkillSummaryChars)) throw new Error(MESSAGE.InvalidSkillSummary);
  const file = assertSkillPath(s.file);
  const skill: PluginFileSkill = { name, summary: s.summary, file };
  if (s.references !== undefined) skill.references = skillReferences(s.references, file);
  return skill;
}

/** The engines a skill names, in canonical form: known engines, at least one, each once. */
function skillEngines(value: unknown): GameEngine[] {
  const valid = Array.isArray(value) && value.length > 0 && value.every(isGameEngine);
  if (!valid || new Set(value).size !== value.length) throw new Error(MESSAGE.InvalidSkillEngines);
  return [...value];
}

/** An inline skill's text in canonical form. */
function inlineSkill(raw: Record<string, unknown>, name: string): PluginSkill {
  if (!isText(raw.text, 1, LIMIT.SkillChars)) throw new Error(MESSAGE.InvalidSkillText);
  return { name, text: raw.text };
}

/**
 * One skill in canonical form: inline text, or (API 3) a file with a summary; never both. Either
 * may name the engines or the facts whose games' briefs carry it, and the agent tools it explains.
 */
function validateSkill(
  raw: Record<string, unknown>,
  name: string,
  m: PluginManifest,
  tools: PluginManifestTool[],
): PluginSkill {
  if ((raw.text === undefined) === (raw.file === undefined)) throw new Error(MESSAGE.SkillTextOrFile);
  const skill = raw.file !== undefined ? fileSkill(raw, name, m) : inlineSkill(raw, name);
  const engines = raw.engines === undefined ? {} : { engines: skillEngines(raw.engines) };
  return { ...skill, ...engines, ...skillScopeFields(raw, tools, m) };
}

/**
 * An API 1 or 2 skill, as those manifests loaded before skills were checked, so an installed one
 * is never disabled by a newer Studio: inline text, empty allowed, any other key ignored.
 */
function legacySkill(raw: Record<string, unknown>, name: string): PluginSkill {
  if (raw.text === undefined && raw.file !== undefined) throw new Error(MESSAGE.FileSkillNeedsApi3);
  if (!isText(raw.text, 0, LIMIT.SkillChars)) throw new Error(MESSAGE.InvalidSkillText);
  return { name, text: raw.text };
}

/** Every skill in canonical form. API 3 refuses a repeated name; API 1 and 2 keep the first. */
function validateSkills(m: PluginManifest, tools: PluginManifestTool[]): PluginSkill[] {
  if (m.skills.length > LIMIT.SkillCount) throw new Error(MESSAGE.TooManySkills);
  const legacy = m.apiVersion < 3;
  const names = new Set<string>();
  const skills: PluginSkill[] = [];
  for (const raw of m.skills as unknown[]) {
    if (!isRecord(raw)) throw new Error(MESSAGE.InvalidSkill);
    assertName("plugin skill", raw.name);
    const repeated = names.has(raw.name);
    if (repeated && !legacy) throw new Error(MESSAGE.DuplicateSkill);
    names.add(raw.name);
    if (!repeated) skills.push(legacy ? legacySkill(raw, raw.name) : validateSkill(raw, raw.name, m, tools));
  }
  if (skills.some(isFileSkill) && tools.some((t) => t.name === PLUGIN_SKILL_TOOL))
    throw new Error(MESSAGE.ReservedSkillTool);
  return skills;
}

function validatePanels(m: PluginManifest): PluginManifest["panels"] {
  const names = new Set<string>();
  return m.panels.map((p) => {
    assertName("panel", p?.id);
    const valid =
      p &&
      id.test(p.id) &&
      !names.has(p.id) &&
      isText(p.title, 1, LIMIT.LabelChars) &&
      ["settings", "project"].includes(p.placement);
    if (!valid) throw new Error(MESSAGE.InvalidPanel);
    names.add(p.id);
    assertRelativePath(p.file);
    return { id: p.id, title: p.title, file: p.file, placement: p.placement };
  });
}

type ManifestAction = PluginManifest["actions"][number];

/** A sensitive action needs a confirmation, except connect and unlock when the account flow names them. */
function needsConfirmation(a: ManifestAction, m: PluginManifest): boolean {
  if (!SENSITIVE_ACTIONS.has(a.name)) return false;
  const accountEntry =
    ["connect", "unlock"].includes(a.name) && [m.account?.connect, m.account?.unlock].includes(a.name);
  return !accountEntry;
}

function validateActions(m: PluginManifest): PluginManifest["actions"] {
  const names = new Set<string>();
  return m.actions.map((a) => {
    assertName("action", a?.name);
    const valid =
      a &&
      id.test(a.name) &&
      !names.has(a.name) &&
      isText(a.label, 1, LIMIT.LabelChars) &&
      (a.confirmation === undefined || typeof a.confirmation === "string");
    if (!valid) throw new Error(MESSAGE.InvalidAction);
    if (a.native !== undefined && a.native !== true) throw new Error(MESSAGE.InvalidNative);
    if (needsConfirmation(a, m) && !a.confirmation) throw new Error(MESSAGE.SensitiveNeedsConfirmation);
    names.add(a.name);
    return {
      name: a.name,
      label: a.label,
      ...(a.confirmation === undefined ? {} : { confirmation: a.confirmation }),
      ...(a.native ? { native: true as const } : {}),
    };
  });
}

function validateSettings(m: PluginManifest): PluginManifest["settings"] {
  const names = new Set<string>();
  return m.settings.map((s) => {
    assertName("setting", s?.key);
    const valid =
      s &&
      id.test(s.key) &&
      !names.has(s.key) &&
      isText(s.label, 1, LIMIT.LabelChars) &&
      SCALAR_TYPES.includes(s.type) &&
      typeof s.default === s.type;
    if (!valid) throw new Error(MESSAGE.InvalidSetting);
    names.add(s.key);
    return { key: s.key, label: s.label, type: s.type, default: s.default };
  });
}

function validateNetwork(network: PluginManifest["network"]): NonNullable<PluginManifest["network"]> {
  const valid =
    isRecord(network) &&
    Array.isArray(network.hosts) &&
    network.hosts.length <= LIMIT.NetworkHosts &&
    network.hosts.every((h) => isText(h, 1, LIMIT.HostnameChars) && hostname.test(h));
  if (!valid) throw new Error(MESSAGE.InvalidNetworkHosts);
  return { hosts: [...network.hosts] };
}

/** An account action is invalid when disconnect lacks a confirmation or status has one. */
const isWrongAccountAction = (key: (typeof ACCOUNT_KEYS)[number], action: ManifestAction) =>
  (key === "disconnect" && !action.confirmation) || (key === "status" && Boolean(action.confirmation));

function validateAccount(
  m: PluginManifest,
  actions: PluginManifest["actions"],
): NonNullable<PluginManifest["account"]> {
  if (m.apiVersion < 2 || !isRecord(m.account) || !hasCapability(m, PluginCapability.Credentials))
    throw new Error(MESSAGE.AccountNeedsApi2);
  const declared = m.account;
  const account = {} as NonNullable<PluginManifest["account"]>;
  for (const key of ACCOUNT_KEYS) {
    const action = actions.find((a) => a.name === declared[key]);
    if (!action || isWrongAccountAction(key, action)) throw new Error(MESSAGE.InvalidAccountAction(key));
    account[key] = action.name;
  }
  if (declared.cancel !== undefined) {
    const cancel = actions.find((a) => a.name === declared.cancel);
    if (!cancel || cancel.confirmation || Object.values(account).includes(cancel.name))
      throw new Error(MESSAGE.InvalidCancelAction);
    account.cancel = cancel.name;
  }
  if (new Set(Object.values(account)).size !== (account.cancel ? 5 : 4))
    throw new Error(MESSAGE.AccountActionsDistinct);
  return account;
}

function validateAssetLimits(m: PluginManifest): NonNullable<PluginManifest["assetLimits"]> {
  const limits = m.assetLimits;
  const valid =
    m.apiVersion === 3 &&
    limits &&
    Number.isSafeInteger(limits.fileBytes) &&
    limits.fileBytes > 0 &&
    Number.isSafeInteger(limits.projectBytes) &&
    limits.projectBytes >= limits.fileBytes;
  if (!valid || !limits) throw new Error(MESSAGE.InvalidAssetLimits);
  return { fileBytes: limits.fileBytes, projectBytes: limits.projectBytes };
}

/** The API 2 sections for what a plugin reaches and shows: network hosts, toolbar and MCP servers. */
function validateReachSections(m: PluginManifest, canonical: PluginManifest): void {
  const v2 = m.apiVersion >= 2;
  if (m.network !== undefined) {
    if (!v2) throw new Error(MESSAGE.NetworkNeedsApi2);
    canonical.network = validateNetwork(m.network);
  }
  if (m.toolbar !== undefined) {
    if (!v2) throw new Error(MESSAGE.ToolbarNeedsApi2);
    canonical.toolbar = validateToolbar(m.toolbar, canonical);
  }
  if (m.mcpServers !== undefined) {
    if (!v2) throw new Error(MESSAGE.McpNeedsApi2);
    canonical.mcpServers = validateMcpServers(m.mcpServers, canonical);
  }
}

/**
 * The account flow (API 2), and the API 3 delivery limits, native declarations, project detection,
 * what a project's history leaves out and where its assets live, and the plugin's worker types and
 * the folders its engine programs write to.
 */
function validateHostSections(m: PluginManifest, canonical: PluginManifest): void {
  if (m.account !== undefined) canonical.account = validateAccount(m, canonical.actions);
  if (m.detect !== undefined) canonical.detect = validateDetect(m);
  if (m.workspace !== undefined) canonical.workspace = validateWorkspace(m);
  if (m.assets !== undefined) canonical.assets = validateAssets(m);
  if (m.assetLimits !== undefined) canonical.assetLimits = validateAssetLimits(m);
  if (m.workerTypes !== undefined) canonical.workerTypes = validateWorkerTypes({ ...m, tools: canonical.tools });
  if (m.folders !== undefined) canonical.folders = validateFolders(m);
  if (m.nativeRuntimes !== undefined || m.nativeJobs !== undefined) {
    if (m.apiVersion !== 3 || !hasCapability(m, PluginCapability.NativeRuntime))
      throw new Error(MESSAGE.NativeNeedsApi3);
    Object.assign(canonical, validateNativeDeclarations(m));
  }
}

/**
 * Validate a manifest and return its canonical form: known keys only, in a fixed order
 * (v2-only keys only when present), so catalog and index comparisons never depend on key order.
 * API 2 is additive over API 1; fields that need API 2 are rejected under API 1 rather than ignored,
 * because a plugin relying on consent must refuse to load on a host that cannot grant it.
 */
export function validateManifest(value: unknown): PluginManifest {
  const m = value as PluginManifest;
  if (!hasValidHeader(m)) throw new Error(MESSAGE.IncompatibleManifest);
  assertRelativePath(m.backend);
  for (const field of REQUIRED_LISTS) {
    if (!Array.isArray(m[field])) throw new Error(MESSAGE.MissingList(field));
  }
  if (m.capabilities.some((c) => !CAPABILITIES.has(c))) throw new Error(MESSAGE.UnsupportedCapability);
  const toolNames = new Set<string>();
  const tools = m.tools.map((t) => validateTool(t, m, toolNames));
  const skills = validateSkills(m, tools);
  const panels = validatePanels(m);
  const actions = validateActions(m);
  const settings = validateSettings(m);
  const canonical: PluginManifest = {
    apiVersion: m.apiVersion,
    id: m.id,
    version: m.version,
    name: m.name,
    publisher: m.publisher,
    description: m.description,
    backend: m.backend,
    capabilities: [...m.capabilities],
    tools,
    skills,
    panels,
    settings,
    actions,
  };
  validateReachSections(m, canonical);
  validateHostSections(m, canonical);
  if (m.icon !== undefined) canonical.icon = validateIcon(m.icon);
  return canonical;
}

/** A declared icon: a relative path inside the package to a picture of a type Studio shows. */
function validateIcon(icon: unknown): string {
  const plain = typeof icon === "string" && Boolean(icon);
  let relative = false;
  try {
    relative = plain && assertRelativePath(icon as string) === icon;
  } catch {
    relative = false;
  }
  const known = relative && PLUGIN_ICON_TYPES[path.extname(icon as string).toLowerCase()] !== undefined;
  if (!known) throw new Error(MESSAGE.InvalidIcon);
  return icon as string;
}

/** Whether bytes are the picture an icon's name says: a bitmap by its magic bytes, an SVG by its root element. */
export function isIconPicture(file: string, bytes: Buffer): boolean {
  const type = PLUGIN_ICON_TYPES[path.extname(file).toLowerCase()];
  return Boolean(type) && pictureType(bytes) === type;
}

/**
 * A package's icon: contained in the package, a plain file within its cap, and the picture its
 * name says. Returned with the type it is served as.
 */
export async function readPluginIcon(root: string, file: string): Promise<{ bytes: Buffer; type: string }> {
  const real = await containedReal(root, file).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" ? new Error(MESSAGE.MissingIcon(file)) : error;
  });
  const s = await lstat(real);
  if (!s.isFile()) throw new Error(MESSAGE.IconNotAFile(file));
  if (s.size > LIMIT.IconBytes) throw new Error(MESSAGE.IconTooLarge(file));
  const bytes = await readFile(real);
  if (bytes.length > LIMIT.IconBytes) throw new Error(MESSAGE.IconTooLarge(file));
  if (!isIconPicture(file, bytes)) throw new Error(MESSAGE.IconNotPicture(file));
  return { bytes, type: PLUGIN_ICON_TYPES[path.extname(file).toLowerCase()] ?? "" };
}

const isValidServerId = (raw: PluginMcpServer, ids: Set<string>) =>
  typeof raw.id === "string" && !raw.id.includes("_") && mcpServerId.test(raw.id) && !ids.has(raw.id);
const isValidArgList = (args: unknown) =>
  Array.isArray(args) &&
  args.length <= LIMIT.McpArgs &&
  args.every((a) => typeof a === "string" && a.length <= LIMIT.McpArgChars);

/** What a server runs: `node` with a script inside the package, or the host CLI for Genex only. */
function validateLaunch(raw: PluginMcpServer, m: PluginManifest): void {
  if (raw.transport !== McpTransport.Stdio) throw new Error(MESSAGE.McpStdioOnly);
  if (raw.command !== "node" && raw.command !== "host-cli") throw new Error(MESSAGE.InvalidMcpCommand);
  if (raw.command === "host-cli" && m.id !== HOST_CLI_PLUGIN) throw new Error(MESSAGE.HostCliReserved);
  if (!isValidArgList(raw.args)) throw new Error(MESSAGE.InvalidMcpArgs);
  if (raw.command === "node") {
    const [script] = raw.args;
    if (script === undefined) throw new Error(MESSAGE.NodeNeedsScript);
    assertRelativePath(script);
  }
  if (raw.cwd !== "storage" && raw.cwd !== "storage:project") throw new Error(MESSAGE.InvalidMcpCwd);
  if (!isText(raw.description, 1, LIMIT.DescriptionChars)) throw new Error(MESSAGE.McpNeedsDescription);
}

/** The optional limits of one server: how many tools it may expose and how long a call may take. */
function applyServerLimits(raw: PluginMcpServer, server: PluginMcpServer): void {
  if (raw.maxTools !== undefined) {
    if (!Number.isInteger(raw.maxTools) || raw.maxTools < 1 || raw.maxTools > LIMIT.McpMaxTools)
      throw new Error(MESSAGE.InvalidMaxTools);
    server.maxTools = raw.maxTools;
  }
  if (raw.callTimeoutMs !== undefined) {
    const timeout = raw.callTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < MIN_CALL_TIMEOUT_MS || timeout > MAX_CALL_TIMEOUT_MS)
      throw new Error(MESSAGE.InvalidCallTimeout);
    server.callTimeoutMs = timeout;
  }
}

/** One declared server in canonical form. */
function validateMcpServer(raw: PluginMcpServer, m: PluginManifest): PluginMcpServer {
  validateLaunch(raw, m);
  const server = {
    id: raw.id,
    transport: McpTransport.Stdio,
    command: raw.command,
    args: [...raw.args],
    cwd: raw.cwd,
  } as PluginMcpServer;
  if (raw.env !== undefined) server.env = mcpEnv(raw.env, m);
  const requires = raw.requires === undefined ? undefined : mcpRequires(raw.requires, m);
  if (requires) server.requires = requires;
  const toolPolicy = raw.toolPolicy === undefined ? undefined : mcpToolPolicy(raw.toolPolicy);
  if (toolPolicy) server.toolPolicy = toolPolicy;
  applyServerLimits(raw, server);
  server.description = raw.description;
  const facts = serverFacts(raw, m);
  if (facts) server.facts = facts;
  return server;
}

/**
 * An MCP server a plugin declares is native code the host starts on the user's Mac. What the
 * manifest may say about it is therefore narrow: which script inside the package (or the one
 * host CLI), which of two directories it works in, and where each environment value comes from —
 * never a value, never an absolute path, never a program from the PATH.
 */
function validateMcpServers(value: unknown, m: PluginManifest): PluginMcpServer[] {
  if (!Array.isArray(value) || value.length > LIMIT.McpServers) throw new Error(MESSAGE.TooManyServers);
  const ids = new Set<string>();
  return (value as PluginMcpServer[]).map((raw) => {
    if (!isRecord(raw) || !isValidServerId(raw, ids)) throw new Error(MESSAGE.InvalidServerId);
    // Studio publishes the server as connector `<plugin>-<server>`, which must itself be a connector id.
    const connector = `${m.id}-${raw.id}`;
    if (!mcpServerId.test(connector)) throw new Error(MESSAGE.ConnectorIdTooLong(connector));
    ids.add(raw.id);
    return validateMcpServer(raw, m);
  });
}

/** Why an environment value's source is refused, or undefined when it is allowed. */
function envSourceProblem(source: string, m: PluginManifest): string | undefined {
  if (source === EnvSource.CredentialFile)
    return hasCapability(m, PluginCapability.Credentials) ? undefined : MESSAGE.CredentialFileNeedsCapability;
  if (source.startsWith(EnvSource.Setting)) {
    const key = source.slice(EnvSource.Setting.length);
    return declaresSetting(m, key) ? undefined : MESSAGE.UndeclaredEnvSetting(key);
  }
  if (source.startsWith(EnvSource.Secret))
    return envName.test(source.slice(EnvSource.Secret.length)) ? undefined : MESSAGE.InvalidSecretName;
  if (source.startsWith(EnvSource.Literal))
    return source.length > LIMIT.McpLiteralChars ? MESSAGE.LiteralTooLong : undefined;
  return MESSAGE.UnknownEnvSource;
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

function mcpEnv(value: unknown, m: PluginManifest): Record<string, PluginMcpEnvValue> {
  if (!isRecord(value)) throw new Error(MESSAGE.InvalidMcpEnv);
  const entries = Object.entries(value).sort(byName);
  if (entries.length > LIMIT.McpEnvVars) throw new Error(MESSAGE.TooManyEnvVars);
  const out: Record<string, PluginMcpEnvValue> = {};
  for (const [name, source] of entries) {
    if (!envName.test(name) || name.length > LIMIT.McpEnvNameChars) throw new Error(MESSAGE.InvalidEnvName(name));
    if (typeof source !== "string") throw new Error(MESSAGE.InvalidEnvValue(name));
    const problem = envSourceProblem(source, m);
    if (problem) throw new Error(MESSAGE.RefusedEnvValue(name, problem));
    out[name] = source as PluginMcpEnvValue;
  }
  return out;
}

function requiredSettings(value: unknown, m: PluginManifest): string[] | undefined {
  const valid =
    Array.isArray(value) && value.length <= LIMIT.McpRequiredSettings && value.every((k) => typeof k === "string");
  if (!valid) throw new Error(MESSAGE.InvalidRequiredSettings);
  for (const key of value as string[])
    if (!declaresSetting(m, key)) throw new Error(MESSAGE.UndeclaredRequiredSetting(key));
  return value.length ? [...(value as string[])] : undefined;
}

function mcpRequires(value: unknown, m: PluginManifest): PluginMcpServer["requires"] {
  if (!isRecord(value)) throw new Error(MESSAGE.InvalidRequires);
  const out: NonNullable<PluginMcpServer["requires"]> = {};
  if (value.credential !== undefined) {
    if (typeof value.credential !== "boolean") throw new Error(MESSAGE.InvalidRequiresCredential);
    if (value.credential && !hasCapability(m, PluginCapability.Credentials))
      throw new Error(MESSAGE.CredentialNeedsCapability);
    if (value.credential) out.credential = true;
  }
  if (value.settings !== undefined) {
    const settings = requiredSettings(value.settings, m);
    if (settings) out.settings = settings;
  }
  return Object.keys(out).length ? out : undefined;
}

function mcpToolPolicy(value: unknown): PluginMcpServer["toolPolicy"] {
  if (!isRecord(value)) throw new Error(MESSAGE.InvalidToolPolicy);
  const list = (v: unknown, label: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > LIMIT.McpPolicyNames || v.some((x) => typeof x !== "string"))
      throw new Error(MESSAGE.InvalidToolPolicyList(label));
    return [...(v as string[])];
  };
  const allow = list(value.allow, "allow"),
    deny = list(value.deny, "deny");
  const out: NonNullable<PluginMcpServer["toolPolicy"]> = {};
  if (allow) out.allow = allow;
  if (deny) out.deny = deny;
  return Object.keys(out).length ? out : undefined;
}

/** A toolbar item's label and aria label: in length, trimmed, unique and none of Studio's own. */
function validateToolbarLabels(raw: PluginToolbarItem, arias: Set<string>): void {
  if (!isText(raw.label, 1, LIMIT.ToolbarLabelChars) || raw.label.trim() !== raw.label)
    throw new Error(MESSAGE.InvalidToolbarLabel);
  if (reservedLower.has(raw.label.toLowerCase())) throw new Error(MESSAGE.ReservedToolbarLabel(raw.label));
  const validAria =
    isText(raw.ariaLabel, 1, LIMIT.ToolbarAriaChars) &&
    !arias.has(raw.ariaLabel) &&
    !reservedLower.has(raw.ariaLabel.trim().toLowerCase());
  if (!validAria) throw new Error(MESSAGE.InvalidToolbarAria);
  arias.add(raw.ariaLabel);
}

/** A toolbar item's optional icon, project requirement and status action. */
function validateToolbarExtras(raw: PluginToolbarItem): void {
  if (raw.icon !== undefined && !isText(raw.icon, 1, LIMIT.ToolbarGlyphChars) && !isToolbarIconName(raw.icon))
    throw new Error(MESSAGE.InvalidToolbarIcon);
  if (raw.requiresProject !== undefined && typeof raw.requiresProject !== "boolean")
    throw new Error(MESSAGE.InvalidRequiresProject);
}

function validateToolbarStatus(raw: PluginToolbarItem, m: PluginManifest): void {
  if (raw.status === undefined) return;
  const action = typeof raw.status === "string" ? m.actions.find((a) => a.name === raw.status) : undefined;
  if (!action) throw new Error(MESSAGE.StatusUndeclared);
  if (action.confirmation) throw new Error(MESSAGE.StatusConfirms);
}

function validateToolbar(value: unknown, m: PluginManifest): PluginToolbarItem[] {
  if (!Array.isArray(value) || value.length > LIMIT.ToolbarItems) throw new Error(MESSAGE.TooManyToolbarItems);
  const ids = new Set<string>(),
    arias = new Set<string>();
  return (value as PluginToolbarItem[]).map((raw) => {
    if (!isRecord(raw) || !id.test(raw.id) || ids.has(raw.id)) throw new Error(MESSAGE.InvalidToolbarId);
    ids.add(raw.id);
    validateToolbarLabels(raw, arias);
    validateToolbarExtras(raw);
    const target = validateTarget(raw.target, m);
    validateToolbarStatus(raw, m);
    const item: PluginToolbarItem = { id: raw.id, label: raw.label, ariaLabel: raw.ariaLabel, target };
    if (raw.icon !== undefined) item.icon = raw.icon;
    if (raw.requiresProject !== undefined) item.requiresProject = raw.requiresProject;
    if (raw.status !== undefined) item.status = raw.status;
    return item;
  });
}

function validateTarget(value: unknown, m: PluginManifest): PluginToolbarTarget {
  if (!isRecord(value)) throw new Error(MESSAGE.InvalidToolbarTarget);
  if (value.kind === "action") {
    if (typeof value.name !== "string" || !m.actions.some((a) => a.name === value.name))
      throw new Error(MESSAGE.UnknownTargetAction);
    if (value.args === undefined) return { kind: "action", name: value.name };
    if (
      !isRecord(value.args) ||
      Object.keys(value.args).length > LIMIT.TargetArgs ||
      Object.values(value.args).some((v) => !isScalar(v))
    )
      throw new Error(MESSAGE.InvalidTargetArgs);
    return { kind: "action", name: value.name, args: { ...(value.args as Record<string, PluginScalar>) } };
  }
  if (value.kind === "panel") {
    if (typeof value.id !== "string" || !m.panels.some((p) => p.id === value.id))
      throw new Error(MESSAGE.UnknownTargetPanel);
    return { kind: "panel", id: value.id };
  }
  throw new Error(MESSAGE.InvalidTargetKind);
}

/** The string form catalog and index entries are compared by. */
export function canonicalManifest(value: unknown): string {
  return JSON.stringify(validateManifest(value));
}
export async function inspectPackage(root: string): Promise<PluginManifest> {
  await refuseLinksBelow(root);
  const m = validateManifest(JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8")));
  await containedReal(root, m.backend);
  for (const p of m.panels) await containedReal(root, p.file);
  await inspectSkillFiles(root, m);
  if (m.icon) await readPluginIcon(root, m.icon);
  return m;
}

/**
 * Every entry below `root` must be a plain file or folder: a link or special file anywhere refuses
 * the package. A bundled package holds thousands of files and is inspected at every launch, so the
 * walk takes each entry's type from its folder's listing and reads several folders at once;
 * one at a time with an lstat per entry, it held startup for a third of a second.
 */
async function refuseLinksBelow(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const folders = await Promise.all(pending.splice(0, PACKAGE_WALK_FOLDERS).map(plainFolderEntries));
    pending.push(...folders.flat());
  }
}

/** The folders directly inside `dir`, once every entry there has proved a plain file or folder. */
async function plainFolderEntries(dir: string): Promise<string[]> {
  const folders: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    // A file system that does not say what an entry is gets it asked of the entry itself.
    const kind = typeKnown(entry) ? entry : await lstat(file);
    const linkOrSpecial = kind.isSymbolicLink() || (!kind.isDirectory() && !kind.isFile());
    if (linkOrSpecial) throw new Error(MESSAGE.LinksInPackage);
    if (kind.isDirectory()) folders.push(file);
  }
  return folders;
}

/** Whether the listing said what the entry is. */
function typeKnown(entry: Dirent): boolean {
  return [
    entry.isFile(),
    entry.isDirectory(),
    entry.isSymbolicLink(),
    entry.isFIFO(),
    entry.isSocket(),
    entry.isBlockDevice(),
    entry.isCharacterDevice(),
  ].some(Boolean);
}

/** Every file a skill names, once each: the skill's own file, then its references. */
const skillFiles = (m: PluginManifest): string[] => [
  ...new Set(m.skills.filter(isFileSkill).flatMap((s) => [s.file, ...(s.references ?? [])])),
];

/** The real path of a skill file inside the package, refused when missing, a link, not a file or too large. */
async function skillFile(root: string, file: string): Promise<{ real: string; bytes: number }> {
  const real = await containedReal(root, file).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" ? new Error(MESSAGE.MissingSkillFile(file)) : error;
  });
  const s = await lstat(real);
  if (!s.isFile()) throw new Error(MESSAGE.SkillNotAFile(file));
  if (s.size > LIMIT.SkillFileBytes) throw new Error(MESSAGE.SkillFileTooLarge(file));
  return { real, bytes: s.size };
}

/** Skill files are package files an agent will read: each contained, a plain file, and all within their caps. */
async function inspectSkillFiles(root: string, m: PluginManifest): Promise<void> {
  let total = 0;
  for (const file of skillFiles(m)) {
    total += (await skillFile(root, file)).bytes;
    if (total > LIMIT.SkillPackageBytes) throw new Error(MESSAGE.SkillFilesTooLarge);
  }
}

/**
 * A skill file's bytes, read through the handle that was checked, so a swap after the check is not
 * read: the open refuses a link put in its place, and the size is checked again on the handle.
 */
export async function readSkillFile(root: string, file: string): Promise<Buffer> {
  const { real } = await skillFile(root, file);
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > LIMIT.SkillFileBytes) throw new Error(MESSAGE.SkillFileTooLarge(file));
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * sha256 of each skill, keyed by its name: over the inline text, or over the file and each
 * reference in order, each framed by its path and length. An update whose skill bytes changed
 * therefore shows up even when its manifest entry did not.
 */
export async function pluginSkillDigests(root: string, manifest: PluginManifest): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const skill of manifest.skills) {
    const hash = createHash("sha256");
    if (isFileSkill(skill)) {
      for (const file of [skill.file, ...(skill.references ?? [])]) {
        const bytes = await readSkillFile(root, file);
        hash.update(`file\0${file}\0${bytes.length}\0`).update(bytes);
      }
    } else hash.update(`text\0${skill.text}`);
    digests[skill.name] = hash.digest("hex");
  }
  return digests;
}

/** An object argument: a real object whose JSON form stays within the input limit. */
const isBoundedObject = (value: unknown) =>
  Boolean(value) &&
  !Array.isArray(value) &&
  typeof value === "object" &&
  JSON.stringify(value).length <= LIMIT.ToolInputChars;
/** A scalar of the declared type that is finite when a number and bounded when a string. */
const isDeclaredValue = (spec: ParameterSpec | undefined, raw: unknown, checked: unknown) =>
  Boolean(spec) &&
  typeof checked === spec?.type &&
  !(typeof raw === "number" && !Number.isFinite(raw)) &&
  !(typeof raw === "string" && raw.length > LIMIT.ToolInputChars);

/** The argument as the tool will receive it: an object parameter may arrive as its JSON text. */
function parsedArgument(spec: ParameterSpec | undefined, key: string, value: unknown): unknown {
  if (spec?.type !== "object" || !spec.acceptJsonString || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(MESSAGE.InvalidJsonInput(key));
  }
}

export function validateArguments(tool: PluginTool, args: Record<string, unknown>) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(MESSAGE.InputNotObject);
  for (const k of tool.parameters.required ?? []) if (!Object.hasOwn(args, k)) throw new Error(MESSAGE.MissingInput(k));
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.parameters.properties[key];
    const checked = parsedArgument(spec, key, value);
    if (spec?.type === "object" && !isBoundedObject(checked)) throw new Error(MESSAGE.InvalidInput(key));
    if (!isDeclaredValue(spec, value, checked)) throw new Error(MESSAGE.InvalidInput(key));
  }
}
