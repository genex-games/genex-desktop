import type { PluginToolAsset } from "./asset-making.ts";
import type { EngineCatalog, EngineDeclaration, EngineId, GameEngine } from "./game-engine.ts";
import type { RuntimeInstallPhase } from "./model-install.ts";
import type { ObserveContext, PluginObserver } from "./observers.ts";
import type { HookContext, PluginHook, PluginLock } from "./plugin-hooks.ts";
import { ENGINE_FACT, type FactRule, type GameKind, scopeReaches } from "./project-facts.ts";
import type { WorkerIsolation } from "./workers.ts";
import type { CaptureSource, StillExposure, StillMimeType } from "./preview-contract.ts";

/** Where a plugin's native runtime stands on this Mac (`PluginNativeStatus.state`). */
export const NativeRuntimeState = {
  Ready: "ready",
  Missing: "missing",
  Incompatible: "incompatible",
  Failed: "failed",
} as const;
export type NativeRuntimeState = (typeof NativeRuntimeState)[keyof typeof NativeRuntimeState];

/** Where a native job is (`PluginNativeResult.state`). Persisted in job records: never rename a value. */
export const NativeJobState = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type NativeJobState = (typeof NativeJobState)[keyof typeof NativeJobState];

/** API 3. Runtime names and launch recipes come from reviewed plugin code, never tool inputs. */
export interface PluginNativeRuntime {
  id: string;
  label: string;
  candidates: string[];
  version: { args: string[]; pattern: string; minimum: string };
  install?: {
    action: string;
    url: string;
    sha256: string;
    bytes: number;
    unpackedBytes: number;
    format: "dmg" | "tar.gz";
    entry: string;
    executable: string;
    notices: string[];
  };
}
export type PluginNativeArg = string | { source: "package" | "input" | "output" | "value"; name: string };
export interface PluginNativeJob {
  id: string;
  runtime: string;
  args: PluginNativeArg[];
  inputs: string[];
  values: Record<string, { pattern: string; maxLength: number }>;
  outputs: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  maxAssetBytes: number;
  gpu?: boolean;
}
export interface PluginNativeStatus {
  state: NativeRuntimeState;
  path?: string;
  version?: string;
  detail: string;
}
export interface PluginRuntimeInstall {
  runtime: string;
  phase: RuntimeInstallPhase;
  completed: number;
  total: number;
  active: boolean;
  updatedAt: string;
  error?: string;
}
export interface PluginNativeResult {
  inputs?: Record<string, { file: string; sha256: string }>;
  id: string;
  recipe: string;
  runtime: string;
  version?: string;
  state: NativeJobState;
  project: string;
  output: string;
  files: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  reason?: string;
  createdAt: string;
  finishedAt?: string;
}

/**
 * What a plugin may ask for in its manifest (`capabilities`); the host refuses any other
 * (`substrate/plugins/manifest.ts`). Published in plugin manifests: never rename a value.
 */
export const PluginCapability = {
  ProjectRead: "project.read",
  ProjectWrite: "project.write",
  Credentials: "credentials",
  Observe: "observe",
  ExternalAuth: "external-auth",
  Jobs: "jobs",
  Settings: "settings",
  Network: "network",
  Export: "export",
  NativeRuntime: "native-runtime",
  GameEngine: "game-engine",
} as const;
export type PluginCapability = (typeof PluginCapability)[keyof typeof PluginCapability];

/** Public Studio plugin API. Backend plugins are trusted executable code. API 2 is additive over API 1. */
export const PLUGIN_API_VERSION = 3;
export type PluginApiVersion = 1 | 2 | 3;
/**
 * A typed reason a panel request failed, carried beside its text so a panel never matches words:
 * `cancelled` when the person declined Studio's confirmation. Wire values: never rename.
 */
export const PanelErrorCode = { Cancelled: "cancelled" } as const;
export type PanelErrorCode = (typeof PanelErrorCode)[keyof typeof PanelErrorCode];
export type PluginScalar = string | number | boolean;
export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; acceptJsonString?: boolean }>;
    required?: string[];
  };
  /** API 2: an agent-invoked tool that needs the user's consent before it runs. */
  confirmation?: string;
}
/**
 * Which program Studio itself runs for a manifest tool (`PluginManifestTool.host`), instead of the
 * plugin's backend. Only the bundled Genex plugin on API 3 may name one. Published in the Genex
 * manifest: never rename a value.
 */
export const PluginHostTool = {
  GenexCli: "genex-cli",
  GenexCliPaid: "genex-cli-paid",
  GenexPackage: "genex-package",
} as const;
export type PluginHostTool = (typeof PluginHostTool)[keyof typeof PluginHostTool];
/**
 * Who may call a manifest tool (`PluginManifestTool.audience`, API 3): agents (the default), or
 * only Genex's harness through its own plugin calls, for a step a harness loop takes and no agent
 * should, such as the Unreal Loop's editor queue. Published in manifests: never rename a value.
 */
export const PluginToolAudience = {
  Agents: "agents",
  Harness: "harness",
} as const;
export type PluginToolAudience = (typeof PluginToolAudience)[keyof typeof PluginToolAudience];
/**
 * Why a plugin call answered without running (its answer, never an error, carries it as
 * `blocker`): the chat is in Plan mode. The seed's copy is `PluginCallBlocker` in
 * `loop/unreal/lead-steps.ts` (seed-contracts.test.ts). Never rename a value.
 */
export const PluginCallBlocker = {
  PlanMode: "plan_mode",
  /** A lock the call needs was not given in time: the person kept using it, or another holder did. */
  Lock: "lock",
} as const;
export type PluginCallBlocker = (typeof PluginCallBlocker)[keyof typeof PluginCallBlocker];
/**
 * Why a plugin or connector call ended before its answer, so whether it took effect is unknown:
 * the harness that made it ended, its plugin's backend ended, or the app it drives went away (an
 * editor crash). Written in call records: never rename a value.
 */
export const CallCutOff = {
  HarnessEnded: "harness-ended",
  PluginEnded: "plugin-ended",
  AppLost: "app-lost",
} as const;
export type CallCutOff = (typeof CallCutOff)[keyof typeof CallCutOff];
/**
 * The one text parameter of a confirmed tool that the person may edit on its card (API 3): the
 * card shows the agent's value under its question, in a field with this label, and the person's
 * Allow sends their edit as that parameter.
 */
export interface PluginConfirmationInput {
  parameter: string;
  /** One plain line of at most {@link CONFIRMATION_INPUT_LABEL_MAX_CHARS} characters. */
  label: string;
}
/** The longest label a card's field carries. */
export const CONFIRMATION_INPUT_LABEL_MAX_CHARS = 60;
/** The longest edit a card's field sends. */
export const CONFIRMATION_INPUT_MAX_CHARS = 200;
/** The last character code of the ASCII controls, and DEL: characters that break a plain line. */
const LAST_CONTROL = 0x1f;
const DELETE = 0x7f;
const breaksLine = (char: string) => {
  const code = char.charCodeAt(0);
  return code <= LAST_CONTROL || code === DELETE;
};

/**
 * The person's edit on a card, as the host takes it: one plain line, trimmed, of 1 to
 * {@link CONFIRMATION_INPUT_MAX_CHARS} characters; anything else is no edit (undefined).
 */
export function confirmationInputValue(value: unknown): string | undefined {
  if (typeof value !== "string" || [...value].some(breaksLine)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= CONFIRMATION_INPUT_MAX_CHARS ? trimmed : undefined;
}

/**
 * A tool as the manifest declares it. `host`, `audience`, `facts`, `makes`, `needs` and `ready`
 * never reach an agent: the tool list the registry serves is plain `PluginTool`, which the harness
 * seed is generated from.
 */
export interface PluginManifestTool extends PluginTool {
  /** Bundled Genex only: Studio runs this tool itself rather than the backend. */
  host?: PluginHostTool;
  /** API 3: `harness` keeps the tool from every agent, chat and plan; absent, agents get it. */
  audience?: PluginToolAudience;
  /** API 3: the facts (`shared/project-facts.ts`) of the games whose sessions get it; every game when absent. */
  facts?: string[];
  /** API 3, agent tools only: the facts the tool makes in the game's folder (a new project of a kind, a port). */
  makes?: string[];
  /** API 3: the plugin's locks (`locks[].id`) a call of this tool holds while it runs. */
  needs?: string[];
  /** API 3, agent tools with `makes` only: the harness tool that answers whether what it makes is ready to make. */
  ready?: string;
  /**
   * API 3, agent tools only: the kind of asset a call makes. While a call runs it is a card on the
   * Assets canvas and in the chat, in the spot its files will land.
   */
  asset?: PluginToolAsset;
  /** API 3, with `confirmation`: the text parameter the person may edit on the card. */
  confirmationInput?: PluginConfirmationInput;
}
/** Whether agents are handed a manifest tool: every one but those only the harness calls. */
export const isAgentTool = (tool: Pick<PluginManifestTool, "audience">): boolean =>
  tool.audience !== PluginToolAudience.Harness;
/** A skill whose text sits in the manifest; agents get the whole text in their brief. */
export interface PluginInlineSkill {
  name: string;
  text: string;
  /** API 3, the older spelling of `facts`: the engines whose games' briefs carry this skill. */
  engines?: GameEngine[];
  /** API 3: the facts of the games whose briefs carry this skill; every game when absent (and no `engines`). */
  facts?: string[];
  /** API 3: the plugin's agent tools this skill explains; it reaches a brief only while one of them does. */
  tools?: string[];
}
/**
 * API 3: a skill whose text is a Markdown file in the package. Agents get its summary in their
 * brief and read the file, and any reference beside it, on demand through the plugin's skill tool.
 */
export interface PluginFileSkill {
  name: string;
  summary: string;
  /** Package-relative path to a `.md` file. */
  file: string;
  /** Further package-relative `.md` files the skill points its reader to. */
  references?: string[];
  /** API 3, the older spelling of `facts`: the engines whose games' briefs carry this skill. */
  engines?: GameEngine[];
  /** API 3: the facts of the games whose briefs carry this skill; every game when absent (and no `engines`). */
  facts?: string[];
  /** API 3: the plugin's agent tools this skill explains; it reaches a brief only while one of them does. */
  tools?: string[];
}
/** One skill a plugin gives agents. */
export type PluginSkill = PluginInlineSkill | PluginFileSkill;
/**
 * The facts a skill is for: its `facts`, else its `engines` read as facts (`ENGINE_FACT`), else
 * undefined, every game's. The web's three.js advice never reaches an Unreal game's brief.
 */
export function skillScope(skill: Pick<PluginSkill, "engines" | "facts">): string[] | undefined {
  if (skill.facts) return skill.facts;
  return skill.engines?.map((engine) => ENGINE_FACT[engine]);
}
/**
 * A tool a plugin offers that makes a kind of project (its manifest's `makes`), as a session's
 * snapshot lists it: the plugin's id and name, the tool's agent name `<plugin>__<tool>`, and the
 * facts. `asksReady` says the tool declares a `ready` harness tool (a plugin's new-game tool, the
 * one its engine card offers). For a game with no kind yet, the host fills `ready` and `note` from
 * that tool (whether one can be made here now, and the words the engine card offers it with); both
 * are absent when it declares none or its answer didn't come.
 */
export interface PluginKindOffer {
  plugin: string;
  name: string;
  tool: string;
  makes: string[];
  asksReady?: boolean;
  ready?: boolean;
  note?: string;
  /** The scaffold this offer is (`PluginScaffold.id`), when the plugin declares scaffolds. */
  scaffold?: string;
  /** The scaffold's label, what the card names this kind ("Unreal plugin"); else the plugin's name. */
  label?: string;
  /** False when what it makes is no game (`PluginScaffold.game`): the new game's question never offers it. */
  game?: boolean;
}
/**
 * API 3: a kind of project a plugin's tool makes, with its own label. With a `tool` (an agent tool
 * of the same manifest that declares `makes`) it is a kind on offer of its own, and once that tool
 * made the project Genex records the scaffold in the game's studio.json (`ScaffoldRecord`): its
 * `facts` rules (the `detect` grammar, each of a fact the tool makes) then find facts detection
 * skips, such as a plugin inside its host project's `Plugins/`.
 */
export interface PluginScaffold {
  id: string;
  label: string;
  tool?: string;
  /**
   * False when what it makes is no game (a plugin or tool project): the new game's question
   * ("Where should your game play?") never offers it, and the agent makes it when the request asks for it.
   */
  game?: boolean;
  facts?: FactRule[];
}
/** What of one plugin reaches a game's session: its agent tools, its skills and whether its skill reader does. */
export interface PluginReach {
  tools: PluginManifestTool[];
  skills: PluginSkill[];
  skillTool: boolean;
}
/**
 * What of one plugin reaches a session for a game (`{ facts: [] }`: no kind yet, served as a web
 * game; one of a kind Genex can't name is served by no fact), narrowed to `offered` when the session was: the agent tools whose `facts` reach; the skills
 * whose scope reaches and, when they name tools, one of those reaches too (a skill follows its
 * tools); the skill reader while a file skill reaches. A narrowed session none of whose offered
 * tools the plugin has gets nothing of it, not even its skills. The registry's snapshot and the
 * capability facts both read this one rule.
 */
export function pluginReach(
  manifest: Pick<PluginManifest, "id" | "tools" | "skills">,
  game: GameKind,
  offered?: (agentName: string) => boolean,
): PluginReach {
  const tools = manifest.tools.filter(
    (t) => isAgentTool(t) && scopeReaches(t.facts, game) && (!offered || offered(`${manifest.id}__${t.name}`)),
  );
  if (offered && !tools.length) return { tools, skills: [], skillTool: false };
  const reaching = new Set(tools.map((t) => t.name));
  const skills = manifest.skills.filter(
    (s) => scopeReaches(skillScope(s), game) && (!s.tools || s.tools.some((name) => reaching.has(name))),
  );
  return { tools, skills, skillTool: skills.some(isFileSkill) };
}
/** The tool name, after `<pluginId>__`, that reads a plugin's file skills; a manifest may not declare it beside them. */
export const PLUGIN_SKILL_TOOL = "skill";
/** What the synthetic skill tool tells an agent; the skill names follow. */
const SKILL_TOOL_WORDS = {
  Description: (plugin: string, names: string) =>
    `Read one of the ${plugin} plugin's skills on demand. Skills: ${names}. Pass the skill's name; pass one of its reference files as file to read that instead, and nextOffset as offset to continue a long file.`,
  Name: "The skill's name.",
  File: "A reference file the skill lists, exactly as listed.",
  Offset: "Where to continue a long file: the nextOffset of the previous read.",
} as const;

/** Whether a skill's text is a file the agent reads on demand. */
export const isFileSkill = (skill: PluginSkill): skill is PluginFileSkill => "file" in skill;

/** One line about a skill: a file skill's summary, or the first non-empty line of an inline one. */
export function pluginSkillLine(skill: PluginSkill): string {
  if (isFileSkill(skill)) return skill.summary;
  return (
    skill.text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** The `<pluginId>__skill` tool that reads a plugin's file skills, or undefined when it has none. */
export function pluginSkillTool(manifest: Pick<PluginManifest, "id" | "name" | "skills">): PluginTool | undefined {
  const names = manifest.skills.filter(isFileSkill).map((s) => s.name);
  if (!names.length) return undefined;
  return {
    name: `${manifest.id}__${PLUGIN_SKILL_TOOL}`,
    description: SKILL_TOOL_WORDS.Description(manifest.name, names.join(", ")),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: SKILL_TOOL_WORDS.Name },
        file: { type: "string", description: SKILL_TOOL_WORDS.File },
        offset: { type: "number", description: SKILL_TOOL_WORDS.Offset },
      },
      required: ["name"],
    },
  };
}

export type PluginToolbarTarget =
  | { kind: "action"; name: string; args?: Record<string, PluginScalar> }
  | { kind: "panel"; id: string };
/** Host icons a toolbar item may name instead of drawing its own glyph. */
export const TOOLBAR_ICON_NAMES = ["globe", "export", "play", "image", "box", "boxes", "unreal", "godot"] as const;
export type ToolbarIconName = (typeof TOOLBAR_ICON_NAMES)[number];
export const isToolbarIconName = (value: unknown): value is ToolbarIconName =>
  (TOOLBAR_ICON_NAMES as readonly unknown[]).includes(value);
export interface PluginToolbarItem {
  id: string;
  label: string;
  ariaLabel: string;
  /** A glyph of at most 4 characters, or one of TOOLBAR_ICON_NAMES. */
  icon?: string;
  requiresProject?: boolean;
  /**
   * API 3: the facts of the games whose strip shows this button (an engine's project, say); every
   * game when absent. Its status can still bring it out on another game (`shown`).
   */
  facts?: string[];
  target: PluginToolbarTarget;
  /** Names a declared action without confirmation that returns a PluginToolbarStatus. */
  status?: string;
}
export interface PluginToolbarStatus {
  badge?: string;
  disabled?: boolean;
  title?: string;
  tone?: "ok" | "warn" | "err" | "info";
  /** The button's action is due now (a game with something to publish): drawn in the accent fill. */
  attention?: boolean;
  /** The badge drawn as a dot in its tone (ok green, warn amber, err red, info grey), its word said in the tooltip. */
  dot?: boolean;
  /** A button scoped to `facts` shows on this game anyway (its chat chose the engine before the project exists). */
  shown?: boolean;
}
/**
 * Where one environment variable of a plugin's MCP server gets its value. The manifest names a
 * source, never a value: `setting:<key>` a declared plugin setting, `secret:<name>` a value the
 * user stored for this connector, `literal:<value>` a constant, and `credential-file` the plugin's
 * own credential, which the host hands the child down an anonymous pipe on fd 3, so a token is
 * never in argv, in the environment or in a file on disk. A `node` server's variable is
 * `/dev/fd/3` and the pipe carries the bare token; Studio's own Genex CLI (`host-cli`) gets the
 * `GENEX_TOKEN=` line and a virtual path. Mirrors `src/plugin-sdk/index.d.ts`.
 */
export type PluginMcpEnvValue = `setting:${string}` | `secret:${string}` | `literal:${string}` | "credential-file";
/**
 * API 2: an MCP server the plugin ships. Studio runs it as a connector the plugin owns — started
 * with it, stopped with it, removed with it, and trusted by the plugin's own install dialog
 * rather than by the connector trust dialog a user-typed connector needs.
 */
export interface PluginMcpServer {
  /** Lowercase, no `_`: the connector is `<pluginId>-<id>` and its tools `<connector>__<tool>`. */
  id: string;
  transport: "stdio";
  /** `node` runs a script inside the package; `host-cli` runs a CLI Studio itself ships. */
  command: "node" | "host-cli";
  args: string[];
  /** Plugin storage, or a per-project folder inside it. Never the package: an update replaces that. */
  cwd: "storage" | "storage:project";
  env?: Record<string, PluginMcpEnvValue>;
  /** What must be true before the server is started at all, rather than started to fail. */
  requires?: { credential?: boolean; settings?: string[] };
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** API 3: raw MCP tool names that only read (list or describe what the server offers): they run with no card in any mode, as a file read does. A local plugin's still ask. */
  reads?: string[];
  maxTools?: number;
  callTimeoutMs?: number;
  description: string;
  /** API 3: the facts of the games whose sessions get this connector; every game when absent. Never started for another. */
  facts?: string[];
  /** API 3: the plugin's locks (`locks[].id`) a call of this connector's tools holds while it runs. */
  needs?: string[];
}
/**
 * API 3: a kind of worker a plugin declares (`shared/workers.ts`). `tools` names the plugin's own
 * agent tools, or another plugin's by prefix (`blender__`) or agent name (`genex__asset`); a lead
 * is offered the kind only while one of them reaches its game.
 */
export interface PluginWorkerType {
  id: string;
  description: string;
  tools: string[];
  isolation: WorkerIsolation;
}
/**
 * API 3: a folder outside the game the plugin's engine programs write to (`~/` or an absolute
 * path), and why. Turning the plugin on approves it as a write root for workers and jobs; the
 * plugin's page and its suggestion card name it first.
 */
export interface PluginFolder {
  path: string;
  why: string;
}
export interface PluginManifest {
  /** API 3: delivery limits enforced by the host per plugin and project. */
  assetLimits?: { fileBytes: number; projectBytes: number };
  nativeRuntimes?: PluginNativeRuntime[];
  nativeJobs?: PluginNativeJob[];
  apiVersion: PluginApiVersion;
  id: string;
  version: string;
  name: string;
  publisher: string;
  description: string;
  backend: string;
  capabilities: string[];
  tools: PluginManifestTool[];
  skills: PluginSkill[];
  panels: Array<{ id: string; title: string; file: string; placement: "settings" | "project" }>;
  settings: Array<{
    key: string;
    label: string;
    type: "string" | "boolean" | "number";
    default: string | boolean | number;
  }>;
  /** `native`: the action starts, quits or opens a desktop app or the browser, or writes outside the plugin's storage. */
  actions: Array<{ name: string; label: string; confirmation?: string; native?: true }>;
  /** API 2: hosts the backend talks to (disclosure for the install-time scan). */
  network?: { hosts: string[] };
  /** API 2: buttons contributed beside Live/Builds. */
  toolbar?: PluginToolbarItem[];
  /** API 2: MCP servers the plugin ships, run by the host as connectors the plugin owns. */
  mcpServers?: PluginMcpServer[];
  /**
   * API 3: how the plugin knows its kinds of project by their files (`shared/project-facts.ts`).
   * While the plugin is on, a game whose folder matches a rule holds that fact.
   */
  detect?: FactRule[];
  /**
   * API 3, capability `game-engine`: the engine the plugin declares, by its own id
   * (`shared/game-engine.ts`): what a game linked to its projects builds in.
   */
  engine?: EngineDeclaration;
  /**
   * API 3: what history (`ignore`) and writers' copies (`copySkip`) leave out of a folder holding
   * the plugin's facts, as patterns placed at each fact's folder (`shared/project-workspace.ts`).
   * `facts` names the facts it reaches; without it, those the plugin's `detect` declares.
   */
  workspace?: { facts?: string[]; ignore?: string[]; copySkip?: string[] };
  /**
   * API 3: where the assets of a folder holding the plugin's facts live (folders inside each fact's
   * folder, `"."` for it) and, when `formats` is given, of which lowercase extensions. `facts` as
   * for `workspace`.
   */
  assets?: { facts?: string[]; folders: string[]; formats?: string[] };
  /** API 3: the kinds of worker the plugin declares; the first declaration of an id wins. */
  workerTypes?: PluginWorkerType[];
  /** API 3: the kinds of project its tools make, each with its own label (`PluginScaffold`). */
  scaffolds?: PluginScaffold[];
  /** API 3: folders outside the game its engine programs write to: workers' write roots. */
  folders?: PluginFolder[];
  /** API 3: what one holder at a time may use (an editor), each giving way to the person (`shared/plugin-hooks.ts`). */
  locks?: PluginLock[];
  /** API 3: the plugin's harness tools Genex runs at its moments (`shared/plugin-hooks.ts`). */
  hooks?: PluginHook[];
  /**
   * API 3: what Genex can capture of a project with these facts (evidence for a reviewer), and the
   * Live view it shows (`shared/observers.ts`).
   */
  observers?: PluginObserver[];
  /**
   * API 3, capability `game-engine` with an `engine`: the blind judges that play the engine's games
   * in its editor, each with its own brief, players and probe (`PluginJudge`).
   */
  judges?: PluginJudge[];
  /** Host-managed account flow. Status may finish a pending browser authorization. */
  account?: { connect: string; unlock: string; disconnect: string; status: string; cancel?: string };
  /**
   * The plugin's picture, like an app's in the Dock: a .png, .jpg, .webp or .svg file in the
   * package, square, full-bleed (Studio rounds the corners). Without one Studio shows its initial.
   */
  icon?: string;
  /** What to do to start using it, for its page: plain one-line steps Genex draws ({@link isPluginSetup}). */
  setup?: string[];
}

/** The most judges one manifest declares. */
export const MAX_PLUGIN_JUDGES = 8;
/** The longest judge brief, in characters: a package file read and checked at install. */
export const MAX_JUDGE_BRIEF_CHARS = 16_000;

/**
 * API 3: a blind judge an engine plugin declares (`judges`). It plays a game in the engine's editor
 * through the play tools, never sees code, and answers from playing. Data only: the host runs it.
 */
export interface PluginJudge {
  /** Unique in the manifest: what an agent names the judge by. */
  id: string;
  /** What the person and the agent read it as, 1-40 characters on one line. */
  label: string;
  /** The facts of the games it judges; every game the plugin plays in its editor when absent. */
  facts?: string[];
  /** The package's Markdown file holding its brief, appended to the judge's rubric (at most `MAX_JUDGE_BRIEF_CHARS`). */
  brief: string;
  /** How many players its play opens, 1 to the engine's `play.players`; one when absent. */
  players?: number;
  /**
   * A quiet harness tool of the plugin, needing the play tools' locks, that the host runs once in
   * the judge's play right after it opens: its `note` and `images` (measurements and pictures,
   * never source) open the judge's first message.
   */
  probe?: string;
}

/** A judge as a game's descriptor and an agent name it. */
export type JudgeRef = Pick<PluginJudge, "id" | "label">;

/** The judges that reach a game: those naming no facts, and those whose facts the game holds. */
export function judgesFor(judges: readonly PluginJudge[] | undefined, game: GameKind): PluginJudge[] {
  return (judges ?? []).filter((judge) => scopeReaches(judge.facts, game));
}

/** The engines `manifests` declare, by id: the first declaration of an id wins. */
export function engineCatalog(manifests: readonly Pick<PluginManifest, "engine">[]): EngineCatalog {
  const catalog = new Map<EngineId, EngineDeclaration>();
  for (const { engine } of manifests) if (engine && !catalog.has(engine.id)) catalog.set(engine.id, engine);
  return catalog;
}

/** Where an installed plugin came from. Persisted in install records: never rename a value. */
export const PluginSourceKind = {
  Bundled: "bundled",
  Catalog: "catalog",
  Local: "local",
  Github: "github",
  Index: "index",
} as const;
export type PluginSourceKind = (typeof PluginSourceKind)[keyof typeof PluginSourceKind];

/** Whether a plugin's backend is running (`PluginInfo.health`). */
export const PluginHealth = {
  Idle: "idle",
  Stopped: "stopped",
  Ready: "ready",
  Failed: "failed",
} as const;
export type PluginHealth = (typeof PluginHealth)[keyof typeof PluginHealth];

/** Why the plugin list changed (`PluginChange.reason`, the `plugins.changed` UI event). */
export const PluginChangeReason = {
  Installed: "installed",
  Updated: "updated",
  Enabled: "enabled",
  Disabled: "disabled",
  Removed: "removed",
  Failed: "failed",
  Reloaded: "reloaded",
  Account: "account",
  Settings: "settings",
} as const;
export type PluginChangeReason = (typeof PluginChangeReason)[keyof typeof PluginChangeReason];
export interface PluginSource {
  kind: PluginSourceKind;
  directory?: string;
  repo?: string;
  sha?: string;
  subdir?: string;
  url?: string;
  sha256?: string;
}
export interface PluginScanFinding {
  rule: string;
  severity: "caution" | "dangerous";
  file: string;
  line: number;
  excerpt: string;
}
export interface PluginScan {
  verdict: "safe" | "caution" | "dangerous";
  findings: PluginScanFinding[];
  files: number;
  bytes: number;
  scannedAt: string;
  /** sha256 of each skill's text, or of its file and references, keyed by skill name. */
  skillDigests?: Record<string, string>;
}
export interface PluginInfo {
  manifest: PluginManifest;
  source: PluginSourceKind;
  enabled: boolean;
  removed: boolean;
  health: PluginHealth;
  error?: string;
  pendingVersion?: string;
  availableVersion?: string;
  state: "enabled" | "disabled" | "not-enabled";
  origin?: PluginSource;
  scan?: PluginScan;
  watching?: boolean;
  /** Code found under the packages folder without an install record; never activated until allowed. */
  unlisted?: boolean;
  /** How the last update or reload changed the plugin's skills, by skill name. */
  lastSkillChange?: PluginSkillChange;
  /** Where the plugin's picture loads from, when it has one (its own, or for a bundled plugin the one Studio bundles now). */
  iconUrl?: string;
  /** Agent tools of a local plugin the person allowed to run without asking; cleared when its code changes or it is turned off. */
  allowedTools?: string[];
}
/**
 * The plugins and skills one session was handed, as `plugin` ids and `plugin/skill` names: the
 * `tool_registry_applied` record's set, which a resumed session is compared against.
 */
export interface PluginAppliedSet {
  plugins: string[];
  skills: string[];
}
/** One page of a file skill, as the `<pluginId>__skill` tool answers it. */
export interface PluginSkillPage {
  plugin: string;
  skill: string;
  /** The file this page is from: the skill's own file or one of its references. */
  file: string;
  references: string[];
  text: string;
  offset: number;
  /** Where the next page starts; absent on the last page. */
  nextOffset?: number;
}
/** Skills an update added, changed or removed, by name. */
export interface PluginSkillChange {
  added: string[];
  changed: string[];
  removed: string[];
}
/** One version of a plugin as far as its skills go: the manifest entries and, when scanned, their digests. */
export interface PluginSkillVersion {
  manifest: Pick<PluginManifest, "skills">;
  scan?: Pick<PluginScan, "skillDigests">;
}
/** Whether one skill differs between two versions: its manifest entry, or the digest of its bytes when both were scanned. */
function skillDiffers(name: string, before: PluginSkillVersion, after: PluginSkillVersion): boolean {
  const entry = (p: PluginSkillVersion) => JSON.stringify(p.manifest.skills.find((s) => s.name === name));
  if (entry(before) !== entry(after)) return true;
  const was = before.scan?.skillDigests?.[name];
  const now = after.scan?.skillDigests?.[name];
  return was !== undefined && now !== undefined && was !== now;
}
/** Skills an update added, changed or removed, by name; undefined when it left them all alone. */
export function pluginSkillChange(
  before: PluginSkillVersion,
  after: PluginSkillVersion,
): PluginSkillChange | undefined {
  const names = (p: PluginSkillVersion) => p.manifest.skills.map((s) => s.name);
  const was = names(before);
  const now = names(after);
  const change: PluginSkillChange = {
    added: now.filter((n) => !was.includes(n)),
    changed: now.filter((n) => was.includes(n) && skillDiffers(n, before, after)),
    removed: was.filter((n) => !now.includes(n)),
  };
  const any = change.added.length || change.changed.length || change.removed.length;
  return any ? change : undefined;
}
export interface PluginChange {
  id: string;
  reason: PluginChangeReason;
  /** Set when an update or reload changed the plugin's skills. */
  skills?: PluginSkillChange;
}
/** How a consent question ended; `mode`: the person switched the chat to a mode that asks nothing first for it. */
export type PluginConsentBy = "user" | "timeout" | "stop" | "turn" | "restart" | "mode";
/** Host-generated paths in the staged public copy, shown before upload approval. */
export interface ExportReview {
  included: string[];
  excluded: string[];
}
/** Payload of the thread custom event `plugin_consent`. */
export interface PluginConsentEvent {
  exportReview?: ExportReview;
  /** Actual monotonic wait duration on a settled request, independent of provider translation. */
  durationMs?: number;
  /** Original worker; the envelope can live in the owning run conversation. */
  originThreadId?: string;
  runId?: string;
  facetId?: string;
  consentId: string;
  pluginId: string;
  pluginName: string;
  tool: string;
  args: Record<string, unknown>;
  project: string;
  threadId?: string;
  prompt: string;
  /** A connector's card: the person may also allow this exact tool from now on. */
  alwaysOffered?: boolean;
  /** Approved with Always allow: the tool runs without asking from now on. */
  always?: boolean;
  /**
   * A card with a field the person may edit (`confirmationInput`): its label and the agent's value;
   * on an approval, the value the call was made with.
   */
  input?: { label: string; value: string };
  state: "pending" | "approved" | "declined";
  by?: PluginConsentBy;
  expiresAt?: number;
}
/** A catalog entry's standing: official ids are reserved by the catalog policy; anyone else is community. */
export const PluginTier = {
  Official: "official",
  Community: "community",
} as const;
export type PluginTier = (typeof PluginTier)[keyof typeof PluginTier];
/**
 * The plugin guide, on the repository's default branch: the app's Create a plugin and Read the
 * guide links, and what `plugin:new` points an author and their coding agent at.
 */
export const PLUGIN_GUIDE_URL = "https://github.com/genex-games/genex-desktop/blob/dev/docs/PLUGIN_GUIDE.md";
/** How many setup steps a plugin's page shows, and how long each may be. */
export const PLUGIN_SETUP_STEPS = 6;
export const PLUGIN_SETUP_STEP_CHARS = 200;
/** Control characters, line breaks and text direction overrides or isolates: none belongs in a step. */
const UNSAFE_STEP_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * Whether a value is a plugin page's setup steps: one to six short lines of plain text the author
 * writes and Genex draws itself, as text, never as markup. The catalog's validator
 * (`marketplace/template/scripts/check-catalog.mjs`) applies the same rule.
 */
export function isPluginSetup(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PLUGIN_SETUP_STEPS) return false;
  return value.every(isSetupStep);
}

const isSetupStep = (step: unknown): boolean =>
  typeof step === "string" &&
  step.trim() !== "" &&
  step.length <= PLUGIN_SETUP_STEP_CHARS &&
  !UNSAFE_STEP_CHARACTER.test(step);

export const PLUGIN_CATEGORIES = ["assets", "publishing", "tools", "analytics", "other"] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];
export interface PluginIndexEntry {
  id: string;
  name: string;
  publisher: string;
  description: string;
  category: PluginCategory;
  tier: PluginTier;
  /** owner/repo */
  repo: string;
  /** 40-hex commit sha */
  sha: string;
  subdir?: string;
  version: string;
  capabilities: string[];
  minStudioVersion?: string;
  docsUrl?: string;
  /** The steps its page shows before it is installed, copied from its manifest ({@link isPluginSetup}). */
  setup?: string[];
  artifact?: { url: string; sha256: string };
}
export interface PluginIndex {
  version: 1;
  updatedAt: string;
  plugins: PluginIndexEntry[];
}
export interface PluginIndexView {
  url: string;
  /** The Studio this view was built for, so the UI can say "Needs Studio ≥ x" without a second call. */
  studioVersion: string;
  fetchedAt: number | null;
  stale: boolean;
  error?: string;
  entries: PluginIndexEntry[];
  updates: Array<{ id: string; installedVersion: string; version: string; sha: string }>;
}

/** The path a plugin's picture is served at on its `studio-plugin:` origin: a leading dot is never a panel id. */
export const PLUGIN_ICON_PATH = ".icon";

/** Where a plugin's picture loads from, or undefined when it ships none; the version refetches it after an update. */
export function pluginIconUrl(manifest: Pick<PluginManifest, "id" | "version" | "icon">): string | undefined {
  if (!manifest.icon) return undefined;
  return `studio-plugin://${manifest.id}/${PLUGIN_ICON_PATH}?v=${encodeURIComponent(manifest.version)}`;
}

/** Which version a pasted GitHub link settled on: the latest release, the default branch's newest code, a named ref or a commit. */
export const GithubVersionKind = {
  Release: "release",
  Branch: "branch",
  Ref: "ref",
  Commit: "commit",
} as const;
export type GithubVersionKind = (typeof GithubVersionKind)[keyof typeof GithubVersionKind];

/** The version a link settled on: its kind, its name (tag, branch, ref or short commit) and when it was made. */
export interface GithubVersion {
  kind: GithubVersionKind;
  label: string;
  /** ISO time the release was published or the commit made, when GitHub says. */
  date?: string;
}

/** The longest version name a lookup accepts back from the page. */
const VERSION_LABEL_MAX_CHARS = 255;
const VERSION_KINDS: ReadonlySet<string> = new Set(Object.values(GithubVersionKind));

/** Whether a value from the page is a version the list offered: a known kind and a plain name. */
export function isGithubVersion(value: unknown): value is GithubVersion {
  const v = value as Partial<GithubVersion> | null;
  if (!v || typeof v !== "object" || typeof v.kind !== "string" || !VERSION_KINDS.has(v.kind)) return false;
  const plainLabel =
    typeof v.label === "string" &&
    v.label.length > 0 &&
    v.label.length <= VERSION_LABEL_MAX_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(v.label);
  return plainLabel && (v.date === undefined || typeof v.date === "string");
}

/** What a plugin says about itself in its plugin.json, shown before anything is installed. */
export interface GithubPluginSummary {
  id: string;
  name: string;
  description: string;
  publisher: string;
  version: string;
}

/** One plugin found in a repository, pinned and ready to install with `pluginInstallGithub(spec)`. */
export interface GithubPluginFound {
  repo: string;
  sha: string;
  subdir?: string;
  /** `owner/repo[/subdir]@sha`: the exact commit the install fetches. */
  spec: string;
  version: GithubVersion;
  plugin: GithubPluginSummary;
}

/** Why a pasted link found no plugin to install. */
export const GithubLookupProblem = {
  /** Not a github.com repository link. */
  NotALink: "not-a-link",
  /** GitHub has no such public repository, branch or tag. */
  NotFound: "not-found",
  /** The repository (or folder) has no plugin.json. */
  NoPlugin: "no-plugin",
  /** The plugin.json is there but Studio can't use it. */
  InvalidPlugin: "invalid-plugin",
  /** GitHub is limiting requests from this network for now. */
  RateLimited: "rate-limited",
} as const;
export type GithubLookupProblem = (typeof GithubLookupProblem)[keyof typeof GithubLookupProblem];

/** The kinds of answer a GitHub link lookup gives. */
export const GithubLookupKind = { Plugin: "plugin", Choose: "choose", Problem: "problem" } as const;

/** What a pasted GitHub link leads to: one plugin, several to choose from, or why none. */
export type GithubLookup =
  | ({ kind: typeof GithubLookupKind.Plugin } & GithubPluginFound)
  | { kind: typeof GithubLookupKind.Choose; repo: string; version: GithubVersion; plugins: GithubPluginFound[] }
  | { kind: typeof GithubLookupKind.Problem; problem: GithubLookupProblem; detail?: string };

/**
 * Consent cards the studio itself asks with, not a plugin: their source id, and the name the card
 * shows for it. Persisted in every log: never rename an id.
 */
export const StudioConsentSource = {
  Desktop: "studio-desktop",
  /** Turning computer control on for every chat, asked when a plugin's Do it for me finds it off. */
  ComputerSetting: "studio-computer-setting",
} as const;
export type StudioConsentSource = (typeof StudioConsentSource)[keyof typeof StudioConsentSource];

/**
 * The question the computer-setting card asks: the chat's card shows it as its title, and the
 * consent record keeps it as the prompt, so both say the same words.
 */
export const COMPUTER_SETTING_QUESTION =
  "Turn on computer control? Agents in every chat can then ask to use apps on this Mac, one app at a time.";

/** The name a studio consent card shows. */
export const STUDIO_CONSENT_NAMES: Readonly<Record<StudioConsentSource, string>> = {
  [StudioConsentSource.Desktop]: "Computer control",
  [StudioConsentSource.ComputerSetting]: "Computer control",
};

export interface PluginBinding {
  project: string;
  directory: string;
  threadId?: string;
  /** Set when Genex runs the tool at one of its moments: which, and for what. */
  hook?: HookContext;
  /** Set when Genex runs the tool as one of the plugin's observers: which, for which run, and why. */
  observe?: ObserveContext;
}
export interface PluginCatalogEntry {
  manifest: PluginManifest;
  url: string;
  sha256: string;
}
export interface PluginPanelDocument {
  html: string;
  title: string;
  url?: string;
}

/**
 * A host service a plugin backend calls (`ctx.host(method, args)`), each gated by a capability in
 * `substrate/plugins/registry.ts`. Mirrors `PluginHostCall` in `src/plugin-sdk/index.d.ts`, which
 * plugins compile against: never rename a value.
 */
export const PluginService = {
  CredentialsRead: "credentials.read",
  CredentialsWrite: "credentials.write",
  CredentialsClear: "credentials.clear",
  CredentialsSession: "credentials.session",
  SettingsRead: "settings.read",
  StorageRoot: "storage.root",
  EventsEmit: "events.emit",
  Observe: "observe",
  ProjectRead: "project.read",
  ProjectWrite: "project.write",
  AssetsDeliver: "assets.deliver",
  ExportStage: "export.stage",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
  NativeRun: "native.run",
  NativeJobs: "native.jobs",
  NativeResult: "native.result",
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
  GameEngineLink: "game.engine.link",
  GameEngineRead: "game.engine.read",
  GameEngineSteps: "game.engine.steps",
  /** `game-engine`: a game snapshot of the bound game, taken before the plugin changes files there. */
  GameSnapshot: "game.snapshot",
  /** `game-engine`: a new Genex game for an engine project made with no game open, which the plugin may then link. */
  GameCreate: "game.create",
  /** `game-engine`: the games whose run is going now, each with the project this plugin linked it to. */
  GameEngineRuns: "game.engine.runs",
  /**
   * `game-engine`: Do it for me. Hands a setup task to the bound game's chat, whose own session
   * clicks it with computer control, limited to the apps the plugin's `engine.apps` declares.
   */
  GameEngineAssist: "game.engine.assist",
  /**
   * `game-engine`: whether Do it for me can run for this plugin on this computer: computer control
   * has a desktop and its driver, and the plugin's engine declares apps here. Asks the person nothing.
   */
  GameEngineCanAssist: "game.engine.canAssist",
} as const;
export type PluginService = (typeof PluginService)[keyof typeof PluginService];

/** The longest task a plugin may hand to the chat with `game.engine.assist`. */
export const ENGINE_ASSIST_TASK_MAX_CHARS = 300;

/** Why `game.engine.assist` started nothing. */
export const EngineAssistRefusal = {
  /** No computer control on this computer: Windows, or a Mac with no desktop driver. */
  Unavailable: "unavailable",
  /** The person said no to the task's card or to turning computer control on. */
  Declined: "declined",
  /** The call names no game, so there is no chat to hand the task to. */
  NoChat: "no-chat",
  /**
   * Not the person's: neither an action they pressed nor a tool call whose card they approved, from a
   * plugin that did not come with Genex, or any Genex moment's or observer's step.
   */
  NotPerson: "not-person",
  /** The plugin's engine declares no apps for this computer, so there is nothing it may click. */
  NoApps: "no-apps",
  /**
   * An assist the person didn't ask for, while the chat's own assist is under way: the turn that
   * answers it does the clicking, so nothing more is posted.
   */
  InAssist: "in-assist",
} as const;
export type EngineAssistRefusal = (typeof EngineAssistRefusal)[keyof typeof EngineAssistRefusal];

/** `game.engine.assist`'s arguments: the task, one plain line of at most {@link ENGINE_ASSIST_TASK_MAX_CHARS} characters. */
export interface EngineAssistArgs {
  task: string;
}

/** `game.engine.assist`'s answer: whether the task's turn was started, and why not. */
export interface EngineAssistAnswer {
  started: boolean;
  reason?: EngineAssistRefusal;
}

/** The folder in a `game-engine` plugin's storage where the host keeps each game's link, `<game>.json`. */
export const ENGINE_LINKS_FOLDER = "links";

/** A still's view name: a `config.demos` or `config.cameras` key, or a built-in `eye:*` camera. */
export const PLUGIN_STILL_VIEW_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
/** The least, the most and the default size of a still's encoded image. */
export const PLUGIN_STILL_MIN_BYTES = 64 * 1024;
export const PLUGIN_STILL_MAX_BYTES = 16 * 1024 * 1024;
export const PLUGIN_STILL_DEFAULT_BYTES = 8 * 1024 * 1024;
/** The most view names a `view_unknown` answer lists. */
export const PLUGIN_STILL_AVAILABLE_MAX = 32;

/** Which view a still photographs: a demo run to its end state, or a camera placed. Exactly one. */
export type PluginStillView = { demo: string; camera?: undefined } | { camera: string; demo?: undefined };
/**
 * `observe` with a `still` (API 3, additive): one named view of the bound game on a hidden window
 * of its own at `width`×`height` (each within a pooled window's least and most size), encoded in at
 * most `maxBytes`. Mirrors `PluginStillRequest` in `src/plugin-sdk/index.d.ts`.
 */
export type PluginStillRequest = PluginStillView & { width: number; height: number; maxBytes?: number };
/** A still request as the host checked it: one view, whole-pixel sides, the byte limit filled in. */
export type PluginStillOrder = PluginStillView & { width: number; height: number; maxBytes: number };

/** Why `observe` took no still. Published to plugins: never rename a value. */
export const PluginStillProblemCode = {
  /**
   * This host cannot take a still: it has no hidden window (a still never borrows the person's
   * own), or the window could not be opened, sized or asked for one.
   */
  Unavailable: "unavailable",
  LoadFailed: "load_failed",
  /** The game has no demo or camera by that name; `available` lists the ones it has. */
  ViewUnknown: "view_unknown",
  ViewFailed: "view_failed",
  CaptureFailed: "capture_failed",
  /** Not even the lowest-quality JPEG (or, for a clip, the lowest bitrate) fits `maxBytes`. */
  TooLarge: "too_large",
  Timeout: "timeout",
} as const;
export type PluginStillProblemCode = (typeof PluginStillProblemCode)[keyof typeof PluginStillProblemCode];

/** A still: the encoded image, its size, which path read it, the view, its exposure and a small JPEG preview. */
export interface PluginStill {
  image: Uint8Array;
  mimeType: StillMimeType;
  width: number;
  height: number;
  /** `page` is the page's own read of its canvas; `compositor` is the window's frame. */
  source: CaptureSource;
  view: PluginStillView;
  stats: StillExposure;
  /** JPEG, at most 1280 px on its long side. */
  preview: Uint8Array;
}
export interface PluginStillProblem {
  code: PluginStillProblemCode;
  reason?: string;
  available?: string[];
}
/** What `observe` with a `still` answers. A host older than the option answers an ordinary observation instead. */
export type PluginStillAnswer = { still: PluginStill } | { stillProblem: PluginStillProblem };

/** The least, the most and the default length of a clip, in seconds of the game running. */
export const PLUGIN_CLIP_MIN_SECONDS = 2;
export const PLUGIN_CLIP_MAX_SECONDS = 10;
export const PLUGIN_CLIP_DEFAULT_SECONDS = 5;
/** The least, the most and the default frames per second a clip records. */
export const PLUGIN_CLIP_MIN_FPS = 15;
export const PLUGIN_CLIP_MAX_FPS = 30;
export const PLUGIN_CLIP_DEFAULT_FPS = 30;
/** The least, the most and the default size of a clip's encoded video. */
export const PLUGIN_CLIP_MIN_BYTES = 256 * 1024;
export const PLUGIN_CLIP_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_CLIP_DEFAULT_BYTES = 8 * 1024 * 1024;

/** How a clip's video is contained: MP4 (H.264) where the recorder can, else WebM. Published to plugins: never rename a value. */
export const PluginClipMimeType = { Webm: "video/webm", Mp4: "video/mp4" } as const;
export type PluginClipMimeType = (typeof PluginClipMimeType)[keyof typeof PluginClipMimeType];

/**
 * `observe` with a `clip` (API 3, additive): `seconds` of the bound game running from the start
 * of a moment a demo stages, recorded on a hidden window of its own at `width`×`height`, at `fps`,
 * in at most `maxBytes`. Mirrors `PluginClipRequest` in `src/plugin-sdk/index.d.ts`.
 */
export interface PluginClipRequest {
  demo: string;
  width: number;
  height: number;
  seconds?: number;
  fps?: number;
  maxBytes?: number;
}
/** A clip request as the host checked it: whole-pixel sides and every default filled in. */
export interface PluginClipOrder {
  demo: string;
  width: number;
  height: number;
  seconds: number;
  fps: number;
  maxBytes: number;
}
/** A clip: the video, its size and length, the demo that staged it, a poster and how much moved. */
export interface PluginClip {
  video: Uint8Array;
  mimeType: PluginClipMimeType;
  width: number;
  height: number;
  durationMs: number;
  view: { demo: string };
  /** JPEG of the first recorded frame, at most 1280 px on its long side. */
  poster: Uint8Array;
  /** 0–1: the share of sampled frame pairs that differ visibly; a frozen recording is about 0. */
  motion: number;
}
/** What `observe` with a `clip` answers; the problem codes are a still's. A host older than the option answers an ordinary observation. */
export type PluginClipAnswer = { clip: PluginClip } | { clipProblem: PluginStillProblem };

/** Whether a plugin's own saved account is usable right now (`PluginRegistry.accountState`). */
export const PluginAccountState = {
  Locked: "locked",
  Authorizing: "authorizing",
  Unlocked: "unlocked",
  NotConnected: "not connected",
  Failed: "failed",
} as const;
export type PluginAccountState = (typeof PluginAccountState)[keyof typeof PluginAccountState];
