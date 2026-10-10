import type { RuntimeInstallPhase } from "./model-install.ts";
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
} as const;
export type PluginCapability = (typeof PluginCapability)[keyof typeof PluginCapability];

/** Public Studio plugin API. Backend plugins are trusted executable code. API 2 is additive over API 1. */
export const PLUGIN_API_VERSION = 3;
export type PluginApiVersion = 1 | 2 | 3;
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
 * A tool as the manifest declares it. `host` never reaches an agent: the tool list the registry
 * serves is plain `PluginTool`, which the harness seed is generated from.
 */
export interface PluginManifestTool extends PluginTool {
  /** Bundled Genex only: Studio runs this tool itself rather than the backend. */
  host?: PluginHostTool;
}
/** A skill whose text sits in the manifest; agents get the whole text in their brief. */
export interface PluginInlineSkill {
  name: string;
  text: string;
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
}
/** One skill a plugin gives agents. */
export type PluginSkill = PluginInlineSkill | PluginFileSkill;
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
export const TOOLBAR_ICON_NAMES = ["globe", "export", "play", "image", "box", "boxes"] as const;
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
  maxTools?: number;
  callTimeoutMs?: number;
  description: string;
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
  actions: Array<{ name: string; label: string; confirmation?: string }>;
  /** API 2: hosts the backend talks to (disclosure for the install-time scan). */
  network?: { hosts: string[] };
  /** API 2: buttons contributed beside Live/Builds. */
  toolbar?: PluginToolbarItem[];
  /** API 2: MCP servers the plugin ships, run by the host as connectors the plugin owns. */
  mcpServers?: PluginMcpServer[];
  /** Host-managed account flow. Status may finish a pending browser authorization. */
  account?: { connect: string; unlock: string; disconnect: string; status: string; cancel?: string };
  /**
   * The plugin's picture, like an app's in the Dock: a .png, .jpg, .webp or .svg file in the
   * package, square, full-bleed (Studio rounds the corners). Without one Studio shows its initial.
   */
  icon?: string;
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
export type PluginConsentBy = "user" | "timeout" | "stop" | "turn" | "restart";
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

export interface PluginBinding {
  project: string;
  directory: string;
  threadId?: string;
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
} as const;
export type PluginService = (typeof PluginService)[keyof typeof PluginService];

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
  /** Not even the lowest-quality JPEG fits `maxBytes`. */
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

/** Whether a plugin's own saved account is usable right now (`PluginRegistry.accountState`). */
export const PluginAccountState = {
  Locked: "locked",
  Authorizing: "authorizing",
  Unlocked: "unlocked",
  NotConnected: "not connected",
  Failed: "failed",
} as const;
export type PluginAccountState = (typeof PluginAccountState)[keyof typeof PluginAccountState];
