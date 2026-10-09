import path from "node:path";
import { watch as watchPath } from "node:fs";
import { mkdir, readFile, readdir, cp, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isPluginId } from "../../shared/plugin-id.ts";
import type { GameEngine } from "../../shared/game-engine.ts";
import {
  type FactRef,
  type GameKind,
  gameKindOf,
  pluginFactSource,
  scopePaths,
  type SourcedFactRule,
} from "../../shared/project-facts.ts";
import type { ToolOffered } from "./tool-allow.ts";
import {
  isAgentTool,
  isFileSkill,
  PLUGIN_SKILL_TOOL,
  pluginReach,
  pluginSkillTool,
  skillScope,
  PluginAccountState,
  PluginCapability,
  PluginChangeReason,
  PluginHealth,
  PluginService,
  PluginSourceKind,
  type CallCutOff,
  type PluginBinding,
  type PluginCatalogEntry,
  type PluginChange,
  type PluginConsentBy,
  type PluginInfo,
  type PluginKindOffer,
  type PluginAppliedSet,
  type PluginFileSkill,
  type PluginHostTool,
  pluginIconUrl,
  type PluginManifest,
  type PluginManifestTool,
  type PluginMcpServer,
  type PluginReach,
  type PluginScan,
  type PluginSkill,
  type PluginSkillChange,
  pluginSkillChange,
  type PluginSkillPage,
  type PluginSource,
  type PluginTool,
  type PluginToolbarItem,
  PluginToolAudience,
} from "../../shared/plugins.ts";
import { atomicWriteJson } from "../fsx.ts";
import {
  canonicalManifest,
  inspectPackage,
  readPluginIcon,
  readSkillFile,
  validateArguments,
  validateManifest,
} from "./manifest.ts";
import { fileSkillIndexLine } from "./skill-prompts.ts";
import { pluginWorkspaces } from "./workspace-manifest.ts";
import { pluginFolderPaths, pluginWorkerTypes, workerTypeOffered } from "./worker-manifest.ts";
import type { WorkerType } from "../../shared/workers.ts";
import type { PluginWorkspace } from "../../shared/project-workspace.ts";
import { canonicalSourceRepo } from "./marketplace.ts";
import { containedReal } from "../paths.ts";
import { SessionCredentials } from "../session-credentials.ts";
import { PluginCallCutOff, PluginProcess } from "./process.ts";
import { MAX_ARTIFACT_BYTES, packageCopyFilter, unpackEnvelope } from "./pack.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

interface Installed {
  rememberAccount?: boolean;
  directory: string;
  manifest: PluginManifest;
  source: PluginSourceKind;
  enabled: boolean;
  removed: boolean;
  origin?: PluginSource;
  scan?: PluginScan;
  identity?: PluginIdentity;
  lastSkillChange?: PluginSkillChange;
}
/**
 * Who a package is, as far as its saved account and data are concerned. The id is only a name: two
 * packages share an identity when the same publisher ships them from the same place — Studio itself
 * (a bundled seed or its curated catalog), a local folder, or one GitHub repository and subfolder
 * (a marketplace entry and a typed spec for that repository are the same place).
 */
export interface PluginIdentity {
  publisher: string;
  from: "studio" | "local" | "github";
  repo?: string;
  subdir?: string;
}
/** Where each kind of source ships from: Studio itself, a local folder, or a GitHub repository. */
const IDENTITY_FROM: Record<PluginSourceKind, PluginIdentity["from"]> = {
  [PluginSourceKind.Bundled]: "studio",
  [PluginSourceKind.Catalog]: "studio",
  [PluginSourceKind.Local]: "local",
  [PluginSourceKind.Github]: "github",
  [PluginSourceKind.Index]: "github",
};
/** Who a package from `origin` is; an official plugin names its current repository ({@link canonicalSourceRepo}). */
export function pluginIdentity(
  manifest: Pick<PluginManifest, "id" | "publisher">,
  origin: PluginSource,
): PluginIdentity {
  const from = Object.hasOwn(IDENTITY_FROM, origin.kind) ? IDENTITY_FROM[origin.kind] : "github";
  if (from !== "github") return { publisher: manifest.publisher, from };
  const repo = canonicalSourceRepo(manifest.id, manifest.publisher, origin.repo ?? "");
  return { publisher: manifest.publisher, from, repo, subdir: origin.subdir ?? "" };
}
/** A recorded identity as it compares now: one saved before an official source moved names the new repository. */
function currentIdentity(id: string, identity: PluginIdentity): PluginIdentity {
  if (identity.repo === undefined) return identity;
  return { ...identity, repo: canonicalSourceRepo(id, identity.publisher, identity.repo) };
}
const identityKey = (identity: PluginIdentity) =>
  JSON.stringify([identity.publisher, identity.from, identity.repo ?? "", identity.subdir ?? ""]);
/** How long a "replace and erase data" answer waits for the install it was given for. */
const REPLACEMENT_TTL_MS = 10 * MINUTE_MS;
/** How often a pending browser sign-in asks the backend whether it finished. */
const ACCOUNT_POLL_MS = 5 * SECOND_MS;
/** A burst of saves in a watched folder is one reload. */
const WATCH_DEBOUNCE_MS = 500;
/** The host's ceiling for one backend call. */
const CALL_TIMEOUT_MS = 190_000;
/** A tool that runs a native job may wait for its longest job plus this margin. */
const NATIVE_JOB_MARGIN_MS = 10 * SECOND_MS;
/**
 * The longest page of a skill file one read answers: under the Claude CLI's ceiling for an MCP
 * tool result, and small enough for a local model, whose plugin tool results are not clipped.
 */
const SKILL_READ_CHUNK_CHARS = 24_000;
/** A runtime install action downloads and unpacks a whole application. */
const RUNTIME_INSTALL_TIMEOUT_MS = 30 * MINUTE_MS;
const CATALOG_DOWNLOAD_TIMEOUT_MS = 30 * SECOND_MS;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** A project name an MCP server's per-project storage may use. */
const MCP_PROJECT = /^[a-zA-Z0-9_-]{1,100}$/;
/** The storage folder that holds each installed package as `packages/<id>/<version>-<uuid>`. */
const PACKAGES_DIR = "packages";
/** A value has a setting's declared type, and a number setting's value is finite. */
function settingValueFits(setting: PluginManifest["settings"][number], value: unknown): boolean {
  if (typeof value !== setting.type) return false;
  return typeof value !== "number" || Number.isFinite(value);
}

/** The account actions a plugin that declares none is assumed to have. */
const DEFAULT_ACCOUNT_ACTIONS: NonNullable<PluginManifest["account"]> = {
  connect: "connect",
  unlock: "unlock",
  disconnect: "disconnect",
  status: "status",
};
type AccountActions = NonNullable<PluginManifest["account"]>;
const accountActionsOf = (manifest: PluginManifest): AccountActions => manifest.account ?? DEFAULT_ACCOUNT_ACTIONS;

const MESSAGE = {
  IdentityMismatch: "Plugin identity mismatch",
  OutsideStorage: "Plugin directory is outside Studio storage",
  PackageMissing: "This plugin's package is missing; remove the plugin and install it again",
  InvalidProject: "Invalid project",
  Unavailable: (id: string) => `Plugin ${id} is unavailable`,
  InstallFirst: "Install the plugin first",
  UnknownPlugin: "Unknown plugin",
  FolderGone: "The folder this plugin was loaded from is gone; load it again",
  OriginUnknown: "Studio does not know where this plugin came from; load it again",
  NeedsMarketplace: "Reinstalling this plugin needs the marketplace, which is unavailable in this session",
  NotReinstalled: "The plugin was not reinstalled",
  ConfirmReplacement: (next: PluginManifest, previous: PluginManifest) =>
    `${next.name} by ${next.publisher} would replace ${previous.name} by ${previous.publisher}, erasing its saved account and data; confirm "Replace and erase data" first`,
  PermissionExpansion: "Permission expansion requires confirmation",
  ServersChanged: "MCP servers changed; load the folder again to review",
  NoHostServices: "Host services unavailable during installation",
  NotInCatalog: "Plugin is not in the curated catalog",
  InvalidCatalogArtifact: "Invalid catalog artifact",
  DownloadFailed: (status: number) => `Plugin download failed (${status})`,
  ArtifactTooLarge: "Plugin artifact exceeds 256 MiB",
  DigestMismatch: "Plugin artifact digest mismatch",
  CatalogMismatch: "Catalog manifest mismatch",
  EnableFirst: "Enable the plugin first",
  OnlyLocalWatch: "Only plugins loaded from a local folder can be watched",
  UnlockRequired: "Explicit account unlock required",
  ConnectionRequired: "Explicit account connection required",
  DisconnectRequired: "Explicit disconnect required",
  NativeUnavailable: "Native runtime service unavailable",
  CapabilityDenied: "Plugin service capability denied",
  UnknownTool: "Unknown plugin tool",
  UnknownSkill: (id: string, name: string) => `Plugin ${id} has no skill named ${JSON.stringify(name)}`,
  UndeclaredSkillFile: "Read a skill's own file or one of the references it lists, exactly as listed",
  InvalidSkillOffset: "offset must be a whole number within the file: the nextOffset of the previous read",
  HostToolBundledOnly: "A host tool runs only for a bundled plugin that ships with Studio",
  HostToolUnavailable: "This host tool is unavailable in this session",
  ConsentUnavailable: "This tool requires user consent, which is unavailable in this session",
  UnknownAction: "Unknown plugin action",
  UnknownPanel: "Unknown panel",
  InvalidSetting: "Invalid plugin setting",
  BundledId: (id: string, fromLocal: boolean) =>
    `"${id}" is a plugin that ships with Studio; a package from ${fromLocal ? "a local folder" : "GitHub"} cannot use its id`,
} as const;

/** The capability a host service needs; undefined for a service no capability grants. */
function capabilityFor(method: string): PluginCapability | undefined {
  if (method.startsWith("credentials.")) return PluginCapability.Credentials;
  if (method.startsWith(PluginService.Observe)) return PluginCapability.Observe;
  if (method.startsWith(PluginService.ProjectRead)) return PluginCapability.ProjectRead;
  if (method.startsWith(PluginService.ProjectWrite) || method === PluginService.AssetsDeliver)
    return PluginCapability.ProjectWrite;
  if (method.startsWith("jobs.") || method === PluginService.EventsEmit) return PluginCapability.Jobs;
  if (method === PluginService.ExportStage) return PluginCapability.Export;
  if (ENGINE_SERVICES.has(method)) return PluginCapability.GameEngine;
  return undefined;
}
/**
 * The services that link a game to an engine project, snapshot the game before the plugin changes
 * it, make a game for a project, and name the games whose run is going.
 */
const ENGINE_SERVICES = new Set<string>([
  PluginService.GameEngineLink,
  PluginService.GameEngineRead,
  PluginService.GameEngineSteps,
  PluginService.GameSnapshot,
  PluginService.GameCreate,
  PluginService.GameEngineRuns,
]);
/** The account services the registry answers from the session lease. */
const CREDENTIAL_SERVICES = new Set<string>([
  PluginService.CredentialsSession,
  PluginService.CredentialsRead,
  PluginService.CredentialsWrite,
  PluginService.CredentialsClear,
]);
const isCredentialService = (method: string) => CREDENTIAL_SERVICES.has(method);
/** Services the native runtime host answers rather than the plugin services. */
const isNativeService = (method: string) => method.startsWith("native.") || method.startsWith("runtime.");
/** An invocation of a user action by one of the given names (never a tool, review or another action). */
const isActionAmong = (invocation: { method: string; name: string }, names: string[]) =>
  invocation.method === "action" && names.includes(invocation.name);
/** Whether an install record is live: enabled and not removed. */
const isLive = (p: { enabled: boolean; removed: boolean } | undefined) => Boolean(p?.enabled) && !p?.removed;
/** What a session is handed, all read from one view of the live plugins. */
export interface PluginSnapshot {
  tools: PluginTool[];
  guidance: string;
  applied: PluginAppliedSet;
  /** The tools on offer that make a kind of project in the game's folder (`makes`). */
  kinds: PluginKindOffer[];
}
/** A manifest tool as an agent sees it: named `<id>__<tool>`, without the host program, audience or scope. */
function agentTool(id: string, tool: PluginManifestTool): PluginTool {
  const { host: _host, audience: _audience, facts: _facts, makes: _makes, ...declared } = tool;
  return { ...declared, name: `${id}__${tool.name}` };
}
/** What one plugin hands a session for a game with `facts`, narrowed to `offered` when the session is. */
interface PluginPart {
  manifest: PluginManifest;
  reach: PluginReach;
}
/**
 * Every tool one plugin gives a session: its declared tools that reach the game, but those only the
 * harness calls (it reaches them by name through `tool`), then its skill tool while a file skill
 * reaches.
 */
function agentTools({ manifest, reach }: PluginPart): PluginTool[] {
  const skillTool = reach.skillTool ? pluginSkillTool(manifest) : undefined;
  return [...reach.tools.map((t) => agentTool(manifest.id, t)), ...(skillTool ? [skillTool] : [])];
}
/**
 * Whether a plugin has a part in a session: something of it reaches, or (for a session not narrowed
 * to offered tools) it declares no agent tool or skill a scope could have left out.
 */
function takesPart({ manifest, reach }: PluginPart, offered: boolean): boolean {
  if (reach.tools.length || reach.skills.length) return true;
  return !offered && !manifest.skills.length && !manifest.tools.some(isAgentTool);
}
/**
 * Where in the folder a skill applies, when that is not the root: ` (for site/)` after its name,
 * so a lead with an Unreal project at the root and a web game in `site/` knows which is which.
 */
function skillWhere(skill: PluginSkill, game: GameKind): string {
  const paths = scopePaths(skillScope(skill), game);
  if (!paths.length || paths.includes(".")) return "";
  return ` (for ${paths.map((p) => `${p}/`).join(", ")})`;
}
/** One plugin's part of the brief: an inline skill whole, a file skill as one index line. */
function skillGuidance({ manifest, reach }: PluginPart, game: GameKind): string[] {
  return reach.skills.map((s) => {
    const where = skillWhere(s, game);
    return isFileSkill(s) ? fileSkillIndexLine(manifest.id, s, where) : `[${manifest.id}/${s.name}]${where}\n${s.text}`;
  });
}
/** The kinds one plugin's reaching tools make, as the snapshot lists them. */
function kindOffers({ manifest, reach }: PluginPart): PluginKindOffer[] {
  return reach.tools.flatMap((t) =>
    t.makes
      ? [{ plugin: manifest.id, name: manifest.name, tool: `${manifest.id}__${t.name}`, makes: [...t.makes] }]
      : [],
  );
}
/** The file a skill read names: the skill's own, or one of its references spelled exactly as listed. */
function declaredSkillFile(skill: PluginFileSkill, file: unknown): string {
  if (file === undefined) return skill.file;
  const listed = typeof file === "string" && (file === skill.file || (skill.references ?? []).includes(file));
  if (!listed) throw new Error(MESSAGE.UndeclaredSkillFile);
  return file;
}
/** A high surrogate: the first half of a character a page must not end on. */
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
/** One page of a skill file from `offset`, and where the next one starts. */
function skillPage(text: string, offset: unknown): Pick<PluginSkillPage, "text" | "offset" | "nextOffset"> {
  const from = offset ?? 0;
  const valid = typeof from === "number" && Number.isInteger(from) && from >= 0 && from <= text.length;
  if (!valid) throw new Error(MESSAGE.InvalidSkillOffset);
  let end = Math.min(text.length, from + SKILL_READ_CHUNK_CHARS);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return { text: text.slice(from, end), offset: from, ...(end < text.length ? { nextOffset: end } : {}) };
}
const isDirectory = (directory: string) =>
  stat(directory).then(
    (s) => s.isDirectory(),
    () => false,
  );
/** Where an install records it came from when the caller names no origin. */
function recordedOrigin(source: PluginSourceKind, directory: string): PluginSource {
  if (source === PluginSourceKind.Bundled) return { kind: PluginSourceKind.Bundled };
  if (source === PluginSourceKind.Local) return { kind: PluginSourceKind.Local, directory: path.resolve(directory) };
  return { kind: source };
}
/** A catalog artifact's bytes, refused past {@link MAX_ARTIFACT_BYTES}. */
async function downloadArtifact(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CATALOG_DOWNLOAD_TIMEOUT_MS), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(MESSAGE.DownloadFailed(response.status));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error(MESSAGE.ArtifactTooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
/** A capability the update asks for that the installed version lacks and the user did not approve now. */
const expandsCapabilities = (next: PluginManifest, current: PluginManifest, approved: string[] | undefined) =>
  next.capabilities.some((c) => !current.capabilities.includes(c) && !approved?.includes(c));
const sameServers = (a: PluginManifest, b: PluginManifest) =>
  JSON.stringify(a.mcpServers ?? []) === JSON.stringify(b.mcpServers ?? []);
/** A package that takes over another identity's id needs the user's fresh "replace and erase data" for it. */
function assertReplacementConfirmed(
  next: PluginManifest,
  previous: PluginManifest,
  identity: PluginIdentity,
  answer: { key: string; expires: number } | undefined,
) {
  const confirmed = answer?.key === identityKey(identity) && answer.expires >= Date.now();
  if (!confirmed) throw new Error(MESSAGE.ConfirmReplacement(next, previous));
}
/** An update may not gain capabilities, servers or hosts the user was never shown. */
function assertUpdateReviewed(
  next: PluginManifest,
  current: PluginManifest,
  approved: string[] | undefined,
  reason: PluginChange["reason"] | undefined,
) {
  if (expandsCapabilities(next, current, approved)) throw new Error(MESSAGE.PermissionExpansion);
  // An MCP server is native code with an environment of its own: changing what one runs, where
  // it runs or what it is handed is an expansion of the same kind a new capability is, and an
  // update that was never shown to anybody must not quietly acquire it.
  if (approved === undefined && !sameServers(next, current)) throw new Error(MESSAGE.PermissionExpansion);
  // A hot reload carries the capabilities the user approved, not a review of new servers or hosts.
  if (reason === PluginChangeReason.Reloaded && reviewedLaunch(next) !== reviewedLaunch(current))
    throw new Error(MESSAGE.ServersChanged);
}
const hasCapability = (p: { manifest: PluginManifest } | undefined, capability: PluginCapability) =>
  Boolean(p?.manifest.capabilities.includes(capability));
interface Unlisted {
  directory: string;
  manifest: PluginManifest;
}
/**
 * The env-file line `credentialFile()` renders for Studio's own Genex CLI; its preload turns the
 * `GENEX_TOKEN` value into the CLI's sign-in record for the pinned API origin. A plugin's own
 * server gets the bare token from `credential()` instead.
 */
const CREDENTIAL_FILE_VARIABLE = "GENEX_TOKEN";
const newerVersion = (next: string | undefined, current: string) =>
  !!next &&
  next
    .split(".")
    .some(
      (part, i, parts) =>
        Number(part) > Number(current.split(".")[i]) &&
        parts.slice(0, i).every((n, j) => Number(n) === Number(current.split(".")[j])),
    );
/**
 * What the host needs to launch one plugin's MCP servers. Everything here is a function: the
 * storage root, the settings and above all the credential are read at launch, so a disabled
 * account or a changed setting is never served from something cached at install time.
 */
export interface PluginMcpLaunch {
  /** The installed package, the only place a `node` server's script may live. */
  packageDir: string;
  storageRoot(): Promise<string>;
  projectStorage(project: string): Promise<string>;
  settings(): Promise<Record<string, unknown>>;
  /**
   * The plugin's credential, the bare token, and only after the user's explicit `unlock`.
   * Undefined otherwise — a server that needs an account is listed unavailable rather than
   * started with nothing, and the host never reads the store behind the user's back. This is what
   * a plugin's own `node` server is handed on file descriptor 3.
   */
  credential(): Promise<string | undefined>;
  /**
   * The same credential as the env-file line Studio's own Genex CLI (`host-cli`) reads through
   * its preload. Not part of the public contract; never framed like this for another server.
   */
  credentialFile(): Promise<string | undefined>;
}
/** What `watch` listens with; the default is a recursive `fs.watch`. Tests drive it by hand. */
export type WatchFolder = (directory: string, onChange: () => void) => { close(): void };
const watchWithFs: WatchFolder = (directory, onChange) =>
  watchPath(directory, { recursive: true, persistent: false }, () => onChange());
/** What an MCP server runs and may reach; a hot reload may not change it without a new review. */
const reviewedLaunch = (m: PluginManifest) => JSON.stringify([m.mcpServers ?? [], m.network?.hosts ?? []]);
/** The connector side of the plugin lifecycle; the host sets it. */
export interface PluginMcpHost {
  register(pluginId: string, servers: PluginMcpServer[], launch: PluginMcpLaunch): Promise<void> | void;
  unregister(pluginId: string): Promise<void> | void;
  /** A replaced plugin's servers (`<pluginId>-<server>`) lose every secret stored for them (M5). */
  erase?(pluginId: string, serverIds: string[]): Promise<void> | void;
}
/** Why a consent was not approved, said about the tool `name`; nobody answering is not a no. */
const DECLINED_MESSAGE: Record<PluginConsentBy, (name: string) => string> = {
  user: (name) => `User declined ${name}`,
  timeout: (name) => `Nobody answered ${name}. The user may be away, so this is not a no: ask again later`,
  stop: (name) => `${name} was declined because the session stopped`,
  turn: (name) => `${name} was declined because the turn ended`,
  restart: (name) => `${name} was declined because the turn ended`,
};
/** Rejects with the reason `signal` is aborted with, once it is: a host tool call's cut-off. */
function cutOffOf(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

/** The user (or the session on their behalf) did not approve a tool that declares `confirmation`. */
export class PluginConsentDeclined extends Error {
  readonly by: PluginConsentBy;
  constructor(name: string, by: PluginConsentBy) {
    super((Object.hasOwn(DECLINED_MESSAGE, by) ? DECLINED_MESSAGE[by] : DECLINED_MESSAGE.turn)(name));
    this.name = "PluginConsentDeclined";
    this.by = by;
  }
}
export class PluginRegistry {
  #installed = new Map<string, Installed>();
  #seedManifests = new Map<string, PluginManifest>();
  #unlisted = new Map<string, Unlisted>();
  /** Where each bundled seed lives, by plugin id: its picture outlives an installed copy made before it had one. */
  #seedDirectories = new Map<string, string>();
  #processes = new Map<string, PluginProcess>();
  /** Each host tool call in flight, by the controller `abortCalls` cuts it off with. */
  #hostCalls = new Set<AbortController>();
  #errors = new Map<string, string>();
  /** Bundled records whose package copy is gone at startup; `#installSeeds` copies their seed again. */
  #lostSeedCopies = new Map<string, Installed>();
  #leases = new Map<string, number>();
  #pending = new Map<string, Installed>();
  #saveAuthorized = new Set<string>();
  #accountPolls = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; expires: number }>();
  #accounts = new Map<string, SessionCredentials>();
  #credentialIo = new Map<string, Promise<unknown>>();
  /** One-shot "replace and erase data" answers, keyed by id, for exactly one identity. */
  #replacements = new Map<string, { key: string; expires: number }>();
  #account(id: string): SessionCredentials {
    let account = this.#accounts.get(id);
    if (!account) {
      const io = <T>(fn: () => Promise<T>) => {
        const next = (this.#credentialIo.get(id) ?? Promise.resolve()).then(fn, fn);
        this.#credentialIo.set(
          id,
          next.catch(() => {}),
        );
        return next;
      };
      account = new SessionCredentials({
        get: () =>
          io(async () => {
            const value = await this.service(id, PluginService.CredentialsRead, {});
            return typeof value === "string" ? value : null;
          }),
        set: (token) =>
          io(async () => {
            await this.service(id, PluginService.CredentialsWrite, { token });
          }),
        clear: () =>
          io(async () => {
            await this.service(id, PluginService.CredentialsClear, {});
          }),
      });
      this.#accounts.set(id, account);
    }
    return account;
  }
  #lockAccount(id: string) {
    const poll = this.#accountPolls.get(id);
    if (poll?.timer) clearTimeout(poll.timer);
    this.#accountPolls.delete(id);
    this.#accounts.get(id)?.lock();
    this.#mcpAuthorized.delete(id);
    this.#saveAuthorized.delete(id);
  }
  /** Memory-only readiness: a healthy backend does not establish an authenticated account. */
  async accountState(id: string): Promise<PluginAccountState | undefined> {
    if (!this.#installed.get(id)?.manifest.account) return undefined;
    if (this.#accountPolls.has(id)) return PluginAccountState.Authorizing;
    const lease = this.#accounts.get(id);
    if (!lease || lease.state !== PluginAccountState.Unlocked) return lease?.state ?? PluginAccountState.Locked;
    return (await lease.get()) ? PluginAccountState.Unlocked : PluginAccountState.NotConnected;
  }

  #pollAccount(id: string, expires: number, binding?: PluginBinding) {
    const action = this.#installed.get(id)?.manifest.account?.status;
    if (!action || this.#accountPolls.has(id)) return;
    const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined, expires };
    this.#accountPolls.set(id, state);
    const tick = async () => {
      if (this.#accountPolls.get(id) !== state || !this.enabled(id)) return;
      if (Date.now() >= state.expires) {
        this.#accountPolls.delete(id);
        this.#saveAuthorized.delete(id);
        this.#fire({ id, reason: PluginChangeReason.Account });
        return;
      }
      try {
        const status = await this.action(id, action, {}, binding);
        if (this.#accountPolls.get(id) !== state) return;
        if (status?.connected || !status?.authorization) {
          this.#accountPolls.delete(id);
          this.#saveAuthorized.delete(id);
          return;
        }
      } catch {
        this.debug?.(id, "Account connection check failed");
      }
      if (this.#accountPolls.get(id) === state) {
        state.timer = setTimeout(tick, ACCOUNT_POLL_MS);
        state.timer.unref();
      }
    };
    state.timer = setTimeout(tick, ACCOUNT_POLL_MS);
    state.timer.unref();
  }
  /** Plugins whose MCP servers may be handed the account credential: set by `unlock`, and only by it. */
  #mcpAuthorized = new Set<string>();
  #watchers = new Map<string, { watcher: { close(): void }; timer: ReturnType<typeof setTimeout> | undefined }>();
  /** How `watch` notices edits in a local plugin's folder. */
  watchFolder: WatchFolder = watchWithFs;
  #pendingReason = new Map<string, PluginChange["reason"]>();
  #tail: Promise<unknown> = Promise.resolve();
  readonly root: string;
  readonly seeds: string;
  nativeService:
    | ((
        manifest: PluginManifest,
        directory: string,
        method: string,
        args: unknown,
        binding: PluginBinding | undefined,
        invocation: { method: string; name: string; signal: AbortSignal },
      ) => Promise<unknown>)
    | undefined;
  /**
   * Runs a manifest tool that names a `host` program (Studio's Genex CLI or package install) rather
   * than the backend. Only a bundled package reaches it; absent, such tools fail closed.
   */
  hostTool:
    | ((
        id: string,
        host: PluginHostTool,
        args: Record<string, unknown>,
        binding: PluginBinding,
        signal?: AbortSignal,
      ) => Promise<unknown>)
    | undefined;
  /**
   * What the user is asked about a consented host tool call: Studio's own account of the call it
   * would run, never the agent's raw arguments. It throws for a call the host would refuse, so
   * nobody is asked about it; absent, consented host tools fail closed.
   */
  hostToolConsent:
    | ((
        id: string,
        host: PluginHostTool,
        args: Record<string, unknown>,
        binding: PluginBinding,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>)
    | undefined;
  seedEnabled: Record<string, boolean> = {};
  readonly bootstrap: string;
  readonly service: (id: string, method: string, args: any, binding?: PluginBinding) => Promise<unknown>;
  /** One source for the `plugins.changed` UI event; the host sets it. A throwing hook never fails a mutation. */
  onChange: ((change: PluginChange) => void) | undefined;
  /** Asks the user before a tool that declares `confirmation` runs. Absent → such tools fail closed. */
  consent:
    | ((
        pluginId: string,
        tool: PluginTool,
        args: Record<string, unknown>,
        binding: PluginBinding,
        signal?: AbortSignal,
      ) => Promise<{ approved: boolean; by: PluginConsentBy }>)
    | undefined;
  /** Re-acquires a removed plugin whose origin is github/index/catalog; the marketplace host sets it. */
  reacquire: ((info: PluginInfo) => Promise<void>) | undefined;
  /**
   * Reads a package's code at install time and says what it appears to do; the host sets it to
   * `scanPackage`. Every install that does not arrive with a scan of its own — a restore from a
   * local folder, a hot reload — is scanned again here, so a card never shows a verdict for code
   * that has since changed on disk. Bundled seeds stay `not scanned`, as they always were.
   */
  scan: ((directory: string, manifest: PluginManifest) => Promise<PluginScan>) | undefined;
  /** Developer sink for backend stderr lines. Never user-facing status: a backend may print provider output. */
  debug: ((id: string, line: string) => void) | undefined;
  /** The user's login PATH for backends to start with; the host sets it. Absent → the app's own. */
  toolPath: (() => Promise<string>) | undefined;
  /**
   * Where a plugin's declared MCP servers are published. Kept in step with the plugin at every
   * point the backend child is: enable, disable, update, remove, cancel — and again after an
   * `unlock`, because that is what decides whether a server may have the credential at all.
   */
  mcpHost: PluginMcpHost | undefined;
  constructor(
    root: string,
    seeds: string,
    bootstrap: string,
    service: (id: string, method: string, args: any, binding?: PluginBinding) => Promise<unknown>,
  ) {
    this.root = root;
    this.seeds = seeds;
    this.bootstrap = bootstrap;
    this.service = service;
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
  #fire(change: PluginChange) {
    try {
      this.onChange?.(change);
    } catch {}
  }
  #packages() {
    return path.join(this.root, PACKAGES_DIR);
  }
  #owned(directory: string) {
    return path.resolve(directory).startsWith(path.resolve(this.#packages()) + path.sep);
  }
  /**
   * A record names its package by absolute path, so one saved before the data folder was renamed
   * or copied (the AI Game Studio → Genex migration) names `<old folder>/packages/<id>/<copy>`.
   * That is the same copy under this storage; any other folder is left as named, to be refused.
   */
  #relocated(id: string, directory: string): string {
    if (this.#owned(directory)) return directory;
    const copy = path.resolve(directory);
    const parent = path.dirname(copy);
    const samePackage = path.basename(parent) === id && path.basename(path.dirname(parent)) === PACKAGES_DIR;
    return samePackage ? path.join(this.#packages(), id, path.basename(copy)) : directory;
  }
  /** Keep a record that failed to load, switched off, with the reason it failed. */
  #refuse(id: string, p: Installed, e: unknown) {
    this.#errors.set(id, String(e));
    this.#installed.set(id, { ...p, enabled: false });
  }
  async #readRecords(file: string): Promise<Record<string, Installed>> {
    return JSON.parse(await readFile(path.join(this.root, file), "utf8").catch(() => "{}")) as Record<
      string,
      Installed
    >;
  }
  /** One saved install record, checked again; a record that fails is kept disabled with its error. */
  async #loadInstalled(id: string, p: Installed) {
    try {
      const manifest = validateManifest(p.manifest);
      if (id !== manifest.id) throw new Error(MESSAGE.IdentityMismatch);
      const record = { ...p, manifest, directory: this.#relocated(id, p.directory) };
      if (!record.removed) {
        if (!this.#owned(record.directory)) throw new Error(MESSAGE.OutsideStorage);
        if (!(await isDirectory(record.directory))) {
          // Older builds refused such a record, then swept the copy it named; a seed can be copied again.
          if (record.source !== PluginSourceKind.Bundled) throw new Error(MESSAGE.PackageMissing);
          this.#lostSeedCopies.set(id, record);
          return;
        }
        await inspectPackage(record.directory);
      }
      this.#installed.set(id, record);
    } catch (e) {
      this.#refuse(id, p, e);
    }
  }
  /** Record every bundled seed's manifest, and install a copy of any seed this profile does not have yet. */
  async #installSeeds() {
    const bundled: PluginSource = { kind: PluginSourceKind.Bundled };
    for (const name of await readdir(this.seeds).catch(() => [])) {
      const directory = path.join(this.seeds, name);
      const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8")));
      this.#seedManifests.set(manifest.id, manifest);
      this.#seedDirectories.set(manifest.id, directory);
      if (this.#installed.has(manifest.id)) continue;
      await inspectPackage(directory);
      const installed = path.join(this.#packages(), manifest.id, `${manifest.version}-${randomUUID()}`);
      await mkdir(path.dirname(installed), { recursive: true });
      await cp(directory, installed, { recursive: true });
      const lost = this.#lostSeedCopies.get(manifest.id);
      this.#lostSeedCopies.delete(manifest.id);
      this.#installed.set(manifest.id, {
        rememberAccount: lost?.rememberAccount,
        directory: installed,
        manifest,
        source: PluginSourceKind.Bundled,
        enabled: lost ? lost.enabled : this.seedEnabled[manifest.id] !== false,
        removed: false,
        origin: { kind: PluginSourceKind.Bundled },
        identity: pluginIdentity(manifest, bundled),
      });
    }
    // A lost copy of a plugin Studio no longer ships has nothing to be copied from.
    for (const [id, p] of this.#lostSeedCopies) this.#refuse(id, p, new Error(MESSAGE.PackageMissing));
    this.#lostSeedCopies.clear();
  }
  /**
   * Updates that waited for a lease when Studio closed take effect now, unless the plugin was
   * removed, and say which skills they changed as an update applied at once would.
   */
  async #applyPending() {
    for (const [id, saved] of Object.entries(await this.#readRecords("pending.json"))) {
      const p = { ...saved, directory: this.#relocated(id, saved.directory) };
      try {
        await inspectPackage(p.directory);
        const previous = this.#installed.get(id);
        if (previous?.removed) continue;
        p.lastSkillChange = previous ? pluginSkillChange(previous, p) : undefined;
        this.#installed.set(id, p);
      } catch (e) {
        this.#errors.set(id, String(e));
      }
    }
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const [id, p] of Object.entries(await this.#readRecords("installed.json"))) await this.#loadInstalled(id, p);
    await this.#installSeeds();
    await this.#applyPending();
    await atomicWriteJson(path.join(this.root, "pending.json"), {});
    await this.#save();
    await this.#sweep();
    await this.#discoverUnlisted();
    // A previous successful user connection grants restoration, not a new browser sign-in.
    // One attempt per launch; a refused OS unlock remains actionable, never retried by polling.
    for (const id of this.#installed.keys()) await this.#restoreSavedAccount(id);
  }
  /** A lifecycle transition can restore previous consent; it never starts browser sign-in. */
  async #restoreSavedAccount(id: string) {
    const p = this.#installed.get(id);
    const hasAccount = Boolean(p?.manifest.account) && hasCapability(p, PluginCapability.Credentials);
    if (!p?.rememberAccount || !isLive(p) || !hasAccount) return;
    try {
      await this.#account(id).unlock();
      if (await this.#account(id).get()) this.#mcpAuthorized.add(id);
    } catch {
      this.debug?.(id, "Saved account could not be restored; explicit retry required");
    }
  }
  /** Allow-list gate: code dropped under packages/<id> without a record is listed, never activated, until allowUnlisted. */
  async #discoverUnlisted() {
    this.#unlisted.clear();
    for (const id of (await readdir(this.#packages()).catch(() => [] as string[])).sort()) {
      if (this.#installed.has(id) || !isPluginId(id)) continue;
      const base = path.join(this.#packages(), id);
      const candidates = [
        base,
        ...(await readdir(base).catch(() => [] as string[])).sort().map((n) => path.join(base, n)),
      ];
      for (const directory of candidates) {
        try {
          const manifest = await inspectPackage(directory);
          if (manifest.id !== id) throw new Error(MESSAGE.IdentityMismatch);
          this.#unlisted.set(id, { directory, manifest });
          break;
        } catch {
          /* not a plugin package; keep looking */
        }
      }
    }
  }
  async #save() {
    await atomicWriteJson(path.join(this.root, "installed.json"), Object.fromEntries(this.#installed));
    await atomicWriteJson(path.join(this.root, "pending.json"), Object.fromEntries(this.#pending));
  }
  bundledManifest(id: string) {
    return this.#seedManifests.get(id);
  }
  #identity(p: Installed): PluginIdentity {
    if (p.identity) return currentIdentity(p.manifest.id, p.identity);
    return pluginIdentity(p.manifest, p.origin ?? { kind: p.source });
  }
  /**
   * Only Studio ships a plugin under a bundled id (genex, blender and every other seed): a package
   * from GitHub, the index or a local folder never takes one over, with its storage and account.
   */
  assertInstallable(manifest: Pick<PluginManifest, "id">, origin: PluginSource) {
    const fromStudio = origin.kind === PluginSourceKind.Bundled || origin.kind === PluginSourceKind.Catalog;
    if (fromStudio || !this.#seedManifests.has(manifest.id)) return;
    throw new Error(MESSAGE.BundledId(manifest.id, origin.kind === PluginSourceKind.Local));
  }
  /**
   * The installed (or removed) plugin this package would replace, when it is not the same identity:
   * installing it erases that plugin's saved account and data, so the host must say so and ask.
   */
  replacement(
    manifest: Pick<PluginManifest, "id" | "publisher">,
    origin: PluginSource,
  ): { name: string; publisher: string; origin?: PluginSource } | undefined {
    const previous = this.#installed.get(manifest.id);
    if (!previous || identityKey(this.#identity(previous)) === identityKey(pluginIdentity(manifest, origin)))
      return undefined;
    return {
      name: previous.manifest.name,
      publisher: previous.manifest.publisher,
      ...(previous.origin ? { origin: previous.origin } : {}),
    };
  }
  /** The user answered "replace and erase data" for this package: the next install of it may replace. */
  authorizeReplacement(manifest: Pick<PluginManifest, "id" | "publisher">, origin: PluginSource) {
    this.#replacements.set(manifest.id, {
      key: identityKey(pluginIdentity(manifest, origin)),
      expires: Date.now() + REPLACEMENT_TTL_MS,
    });
  }
  /**
   * A replaced plugin's account and data do not pass to the package that took its id: the lease is
   * locked and forgotten, the saved credential cleared, and its storage and settings removed.
   */
  async #erase(id: string, previous: Installed) {
    this.#lockAccount(id);
    this.#accounts.delete(id);
    this.#connecting.delete(id);
    // Its MCP servers' keys and tokens too: the package that takes the id may declare the same server.
    await Promise.resolve(
      this.mcpHost?.erase?.(
        id,
        (previous.manifest.mcpServers ?? []).map((server) => server.id),
      ),
    ).catch(() => {
      this.debug?.(id, "Saved MCP secrets of the replaced plugin could not be cleared");
    });
    await this.service(id, PluginService.CredentialsClear, {}).catch(() => {
      this.debug?.(id, "Saved account of the replaced plugin could not be cleared");
    });
    const storage = await this.service(id, PluginService.StorageRoot, {}).catch(() => undefined);
    if (typeof storage === "string" && path.isAbsolute(storage) && path.basename(storage) === id)
      await rm(storage, { recursive: true, force: true });
    await rm(path.join(this.root, "data", id), { recursive: true, force: true });
  }
  /** Failed, running, waiting to start, or stopped. */
  #health(id: string, p: Installed): PluginHealth {
    if (this.#errors.has(id)) return PluginHealth.Failed;
    if (this.#processes.has(id)) return PluginHealth.Ready;
    return isLive(p) ? PluginHealth.Idle : PluginHealth.Stopped;
  }
  /** A newer bundled seed a bundled plugin could update to. */
  #availableVersion(id: string, p: Installed): string | undefined {
    if (p.source !== PluginSourceKind.Bundled || p.removed) return undefined;
    const seed = this.#seedManifests.get(id)?.version;
    return newerVersion(seed, p.manifest.version) ? seed : undefined;
  }
  list(): PluginInfo[] {
    const installed = [...this.#installed].map(
      ([id, p]): PluginInfo => ({
        manifest: p.manifest,
        source: p.source,
        enabled: p.enabled,
        removed: p.removed,
        health: this.#health(id, p),
        error: this.#errors.get(id),
        pendingVersion: this.#pending.get(id)?.manifest.version,
        availableVersion: this.#availableVersion(id, p),
        state: isLive(p) ? "enabled" : "disabled",
        origin: p.origin,
        scan: p.scan,
        watching: this.#watchers.has(id),
        ...(p.lastSkillChange ? { lastSkillChange: p.lastSkillChange } : {}),
        ...this.#iconUrl(id),
      }),
    );
    const unlisted = [...this.#unlisted].map(
      ([id, u]): PluginInfo => ({
        manifest: u.manifest,
        source: PluginSourceKind.Local,
        enabled: false,
        removed: false,
        health: PluginHealth.Stopped,
        error: this.#errors.get(id),
        state: "not-enabled",
        origin: { kind: PluginSourceKind.Local, directory: u.directory },
        unlisted: true,
        ...this.#iconUrl(id),
      }),
    );
    return [...installed, ...unlisted];
  }
  /** Publish every enabled plugin's servers once, after the host has set `mcpHost`. */
  async syncMcpServers() {
    for (const id of [...this.#installed.keys()]) await this.#mcpSync(id);
  }
  /** One plugin's servers, brought in line with what it is right now. A failure here never fails the mutation. */
  async #mcpSync(id: string) {
    const host = this.mcpHost;
    if (!host) return;
    const p = this.#installed.get(id);
    const servers = isLive(p) ? p?.manifest.mcpServers : undefined;
    try {
      if (!p || !servers?.length) {
        await host.unregister(id);
        return;
      }
      await host.register(id, servers, this.#mcpLaunch(id, p));
    } catch (e) {
      try {
        this.debug?.(id, `mcp servers unavailable: ${String(e)}`);
      } catch {}
    }
  }
  #mcpLaunch(id: string, p: Installed): PluginMcpLaunch {
    const storageRoot = () => this.service(id, PluginService.StorageRoot, {}) as Promise<string>;
    return {
      packageDir: p.directory,
      storageRoot,
      projectStorage: async (project) => {
        if (!MCP_PROJECT.test(project)) throw new Error(MESSAGE.InvalidProject);
        return path.join(await storageRoot(), "mcp", project);
      },
      settings: () => this.settings(id),
      credential: () => this.#mcpCredential(id),
      credentialFile: async () => {
        const token = await this.#mcpCredential(id);
        return token === undefined ? undefined : `${CREDENTIAL_FILE_VARIABLE}=${token}\n`;
      },
    };
  }
  /** Every plugin account token unlocked this session (never read from storage to answer): the values Studio's log redactor removes. */
  heldCredentials(): string[] {
    return [...this.#accounts.values()].map((account) => account.held()).filter((token): token is string => !!token);
  }
  async #mcpCredential(id: string): Promise<string | undefined> {
    if (!this.#mcpAuthorized.has(id)) return undefined;
    const token = await this.#account(id).get();
    return typeof token === "string" && token ? token : undefined;
  }
  /**
   * The account credential of a live plugin as its host-run CLI reads it (`GENEX_TOKEN=…`): the
   * same gate its MCP servers pass, so nothing until the user unlocked the account.
   */
  async hostCredentialFile(id: string): Promise<string | undefined> {
    return this.#mcpLaunch(id, this.#active(id)).credentialFile();
  }
  #active(id: string) {
    const p = this.#installed.get(id);
    if (!p || !isLive(p)) throw new Error(MESSAGE.Unavailable(id));
    return p;
  }
  enabled(id: string) {
    return isLive(this.#installed.get(id));
  }
  #live(): PluginInfo[] {
    return this.list().filter(isLive);
  }
  /**
   * The tools, the brief's plugin guidance and the plugins and skills behind them, all from one
   * view of the live plugins: a session that took them apart could be told about a skill whose
   * tools it was never given, or given tools it was never told about. All are those for a game
   * `scope` (`gameKindOf`: facts alone, `[]` being no kind yet and served as a web game; facts and
   * what the folder holds; or an engine of the older vocabulary), by `pluginReach`; a skill that
   * applies only in part of the folder says where. A session narrowed to some tools (`offered`, a run's sub-agent) gets
   * those, and the guidance, skills and skill reader of only the plugins they belong to.
   */
  snapshot(scope: readonly FactRef[] | GameKind | GameEngine = [], offered?: ToolOffered): PluginSnapshot {
    const game = gameKindOf(scope);
    const parts = this.#live()
      .map((p) => ({ manifest: p.manifest, reach: pluginReach(p.manifest, game, offered) }))
      .filter((part) => takesPart(part, offered !== undefined));
    return {
      tools: parts.flatMap(agentTools),
      guidance: parts.flatMap((part) => skillGuidance(part, game)).join("\n\n"),
      applied: {
        plugins: parts.map((part) => part.manifest.id),
        skills: parts.flatMap(({ manifest, reach }) => reach.skills.map((s) => `${manifest.id}/${s.name}`)),
      },
      kinds: parts.flatMap(kindOffers),
    };
  }
  tools(): PluginTool[] {
    return this.snapshot().tools;
  }
  /**
   * The project-detection rules of the enabled plugins (`detect`), each with its plugin as the
   * source. A plugin that is installed but off detects nothing.
   */
  detectRules(): SourcedFactRule[] {
    return this.#live().flatMap((p) =>
      (p.manifest.detect ?? []).map((rule) => ({ rule, source: pluginFactSource(p.manifest.id) })),
    );
  }
  /**
   * The enabled plugins' `workspace` and `assets` sections, each with the facts it reaches (its own
   * `facts`, or the plugin's `detect` facts). A plugin that is installed but off adds none.
   */
  workspaceSections(): PluginWorkspace[] {
    return this.#live().flatMap((p) => pluginWorkspaces(p.manifest));
  }
  /**
   * The kinds of worker a lead on a game `scope` (as for `snapshot`) may start: the enabled
   * plugins' `workerTypes`, in plugin-id order, each with its tools as agent names, and left out
   * when none of those tools reaches the game (`pluginReach`, the other plugin being on). The
   * first declaration of an id wins.
   */
  workerTypes(scope: readonly FactRef[] | GameKind | GameEngine = []): WorkerType[] {
    const offered = this.snapshot(scope).tools.map((tool) => tool.name);
    const seen = new Set<string>();
    return this.#byId()
      .flatMap((p) => pluginWorkerTypes(p.manifest))
      .filter((type) => {
        if (seen.has(type.id) || !workerTypeOffered(type, offered)) return false;
        seen.add(type.id);
        return true;
      });
  }
  /**
   * The folders outside the game the enabled plugins' engine programs write to, `~` expanded,
   * resolved and deduped: workers' write roots. Turning a plugin on approves its folders for its
   * engine programs (the consent card does not list them yet).
   */
  workerFolders(): string[] {
    return [...new Set(this.#byId().flatMap((p) => pluginFolderPaths(p.manifest)))];
  }
  /** The enabled plugins in plugin-id order. */
  #byId(): PluginInfo[] {
    return this.#live().sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
  }
  toolbar(): Array<{ plugin: string; item: PluginToolbarItem }> {
    return this.#live().flatMap((p) => (p.manifest.toolbar ?? []).map((item) => ({ plugin: p.manifest.id, item })));
  }
  /** Inline skills whole; a file skill as one line naming the skill tool that reads it. */
  guidance(): string {
    return this.snapshot().guidance;
  }
  /**
   * Hold every live plugin at its current version while a session uses it; an update that arrives
   * meanwhile waits in `#pending` and activates when the last lease on it is released.
   */
  lease() {
    const ids = this.#live().map((p) => p.manifest.id);
    for (const id of ids) this.#leases.set(id, (this.#leases.get(id) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      for (const id of ids) await this.#releaseLease(id);
    };
  }
  async #releaseLease(id: string) {
    this.#leases.set(id, Math.max(0, (this.#leases.get(id) ?? 1) - 1));
    const p = this.#pending.get(id);
    if (this.#leases.get(id) || !p) return;
    this.#pending.delete(id);
    const reason = this.#pendingReason.get(id);
    this.#pendingReason.delete(id);
    await this.#activate(p, reason);
  }
  async #activate(p: Installed, reason?: PluginChange["reason"]) {
    const id = p.manifest.id,
      previous = this.#installed.get(id);
    // An update or a hot reload says which skills it touched: their text reaches every later brief.
    const skills = previous && !previous.removed ? pluginSkillChange(previous, p) : undefined;
    p.lastSkillChange = skills;
    this.#processes.get(id)?.stop();
    this.#processes.delete(id);
    if (previous && identityKey(this.#identity(previous)) !== identityKey(this.#identity(p)))
      await this.#erase(id, previous);
    this.#installed.set(id, p);
    this.#errors.delete(id);
    this.#unlisted.delete(id);
    await this.#save();
    if (previous?.removed) await this.#restoreSavedAccount(id);
    await this.#mcpSync(id);
    // The servers now run from the new copy, so the one it replaced can go.
    if (previous) await this.#discard(previous.directory);
    this.#fire({
      id,
      reason: reason ?? (previous && !previous.removed ? PluginChangeReason.Updated : PluginChangeReason.Installed),
      ...(skills ? { skills } : {}),
    });
  }
  /** Delete a package copy no install record or pending update points to any more. */
  async #discard(directory: string) {
    if (
      !this.#owned(directory) ||
      [...this.#installed.values(), ...this.#pending.values()].some(
        (p) => path.resolve(p.directory) === path.resolve(directory),
      )
    )
      return;
    await rm(directory, { recursive: true, force: true }).catch(() => {
      this.debug?.(path.basename(path.dirname(directory)), "An old package copy could not be removed");
    });
  }
  /**
   * Start-up sweep: copies of an installed plugin that neither its record nor a pending update
   * points to (an update that crashed before activation, a copy an older build never removed), and
   * staging left by an interrupted install. Folders of ids with no record are unlisted code and stay.
   */
  async #sweep() {
    for (const [id, p] of this.#installed) {
      const base = path.join(this.#packages(), id);
      for (const name of await readdir(base).catch(() => [] as string[]))
        if (path.resolve(base, name) !== path.resolve(p.directory)) await this.#discard(path.join(base, name));
    }
    await rm(path.join(this.root, "staging"), { recursive: true, force: true });
  }
  async setEnabled(id: string, enabled: boolean) {
    return this.#serial(async () => {
      const p = this.#installed.get(id);
      if (!p || p.removed) throw new Error(MESSAGE.InstallFirst);
      const wasEnabled = p.enabled;
      p.enabled = enabled;
      const pending = this.#pending.get(id);
      if (pending) pending.enabled = enabled;
      if (!enabled) {
        this.#lockAccount(id);
        this.#unwatch(id);
        this.#processes.get(id)?.stop();
        this.#processes.delete(id);
      }
      await this.#save();
      if (enabled && !wasEnabled) await this.#restoreSavedAccount(id);
      await this.#mcpSync(id);
      this.#fire({ id, reason: enabled ? PluginChangeReason.Enabled : PluginChangeReason.Disabled });
    });
  }
  async remove(id: string) {
    return this.#serial(async () => {
      const p = this.#installed.get(id);
      if (!p) throw new Error(MESSAGE.UnknownPlugin);
      p.enabled = false;
      p.removed = true;
      this.#lockAccount(id);
      this.#unwatch(id);
      this.#pending.delete(id);
      this.#pendingReason.delete(id);
      this.#processes.get(id)?.stop();
      this.#processes.delete(id);
      await this.#save();
      await this.#mcpSync(id);
      const owned = path.join(this.#packages(), id);
      await rm(owned, { recursive: true, force: true });
      this.#fire({ id, reason: PluginChangeReason.Removed });
    });
  }
  /** Reinstall a removed plugin from where it came: seeds for bundled, the loaded folder for local, the marketplace host for the rest. */
  async restore(id: string, approvedCapabilities?: string[]): Promise<PluginManifest> {
    const p = this.#installed.get(id);
    const bundled = !p || p.source === PluginSourceKind.Bundled;
    const origin = p?.origin ?? (bundled ? { kind: PluginSourceKind.Bundled } : undefined);
    if (origin?.kind === PluginSourceKind.Bundled)
      return this.installLocal(
        path.join(this.seeds, id),
        PluginSourceKind.Bundled,
        approvedCapabilities,
        origin,
        p?.scan,
      );
    if (origin?.kind === PluginSourceKind.Local) {
      if (!origin.directory || !(await isDirectory(origin.directory))) throw new Error(MESSAGE.FolderGone);
      // No `scan` argument: the folder is read again, so the verdict is recomputed rather than inherited.
      return this.installLocal(origin.directory, PluginSourceKind.Local, p?.manifest.capabilities, origin);
    }
    if (!origin) throw new Error(MESSAGE.OriginUnknown);
    const info = this.list().find((x) => x.manifest.id === id);
    if (!this.reacquire || !info) throw new Error(MESSAGE.NeedsMarketplace);
    await this.reacquire(info);
    const after = this.#installed.get(id);
    if (!after || after.removed) throw new Error(MESSAGE.NotReinstalled);
    return after.manifest;
  }
  async installLocal(
    directory: string,
    source: PluginSourceKind = PluginSourceKind.Local,
    approvedCapabilities?: string[],
    origin?: PluginSource,
    scan?: PluginScan,
  ) {
    return this.#serial(() => this.#installLocal(directory, source, approvedCapabilities, origin, scan));
  }
  async #installLocal(
    directory: string,
    source: PluginSourceKind,
    approvedCapabilities?: string[],
    origin?: PluginSource,
    scan?: PluginScan,
    reason?: PluginChange["reason"],
  ) {
    const manifest = await inspectPackage(directory),
      previous = this.#installed.get(manifest.id);
    const recorded = origin ?? recordedOrigin(source, directory);
    // An answer is spent by the next install of that id, whatever becomes of it.
    const answer = this.#replacements.get(manifest.id);
    this.#replacements.delete(manifest.id);
    this.assertInstallable(manifest, recorded);
    // The id is only a name. A package from another publisher or another place replaces the plugin
    // under it — its saved account and data go with it — and only after the user said exactly that.
    const identity = pluginIdentity(manifest, recorded);
    const replaced = previous && identityKey(this.#identity(previous)) !== identityKey(identity) ? previous : undefined;
    if (replaced) assertReplacementConfirmed(manifest, replaced.manifest, identity, answer);
    const replacing = Boolean(replaced);
    // Only an UPDATE can expand silently. Reinstalling something the user removed is an install:
    // the host has just shown the install dialog for this very manifest, capabilities and servers
    // and all, and refusing here would leave a reinstall with no way forward at all.
    const updating = previous && !previous.removed && !replacing ? previous : undefined;
    if (updating) assertUpdateReviewed(manifest, updating.manifest, approvedCapabilities, reason);
    const destination = await this.#stage(directory, manifest);
    // A staged install brings the scan the user was shown; anything else is scanned here, against
    // the copy that is actually being installed. A scan that throws records no verdict, never a wrong one.
    const verdict =
      scan ??
      (source === PluginSourceKind.Bundled
        ? undefined
        : await this.scan?.(destination, manifest).catch(() => undefined));
    const p: Installed = {
      rememberAccount: replacing ? undefined : previous?.rememberAccount,
      directory: destination,
      manifest,
      source,
      enabled: previous?.removed || replacing ? true : (previous?.enabled ?? true),
      removed: false,
      origin: recorded,
      identity,
    };
    if (verdict) p.scan = verdict;
    await this.#commit(p, reason);
    return manifest;
  }
  /** Copy the package into Studio's storage, check it again there, and prove its backend starts. */
  async #stage(directory: string, manifest: PluginManifest): Promise<string> {
    const destination = path.join(this.#packages(), manifest.id, `${manifest.version}-${randomUUID()}`);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await cp(directory, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: packageCopyFilter(directory),
      });
      await inspectPackage(destination);
    } catch (e) {
      await rm(destination, { recursive: true, force: true });
      throw e;
    }
    const probe = new PluginProcess(
      this.bootstrap,
      path.join(destination, manifest.backend),
      async () => {
        throw new Error(MESSAGE.NoHostServices);
      },
      () => {},
    );
    try {
      await probe.call("ping", "", {});
    } catch (e) {
      await rm(destination, { recursive: true, force: true });
      throw e;
    } finally {
      probe.stop();
    }
    return destination;
  }
  /** Activate now, or, while a session holds a lease on the plugin, wait as its pending update. */
  async #commit(p: Installed, reason: PluginChange["reason"] | undefined) {
    const id = p.manifest.id;
    if (!this.#leases.get(id)) {
      await this.#activate(p, reason);
      return;
    }
    const superseded = this.#pending.get(id);
    this.#pending.set(id, p);
    if (superseded) await this.#discard(superseded.directory);
    if (reason) this.#pendingReason.set(id, reason);
    else this.#pendingReason.delete(id);
    await this.#save();
  }
  /** Turn code the user dropped under packages/<id> into a real install (after the host's trust dialog); the dropped copy is removed. */
  async allowUnlisted(id: string, approvedCapabilities?: string[], scan?: PluginScan) {
    return this.#serial(async () => {
      const u = this.#unlisted.get(id);
      if (!u) throw new Error(MESSAGE.UnknownPlugin);
      const manifest = await this.#installLocal(
        u.directory,
        PluginSourceKind.Local,
        approvedCapabilities,
        { kind: PluginSourceKind.Local, directory: u.directory },
        scan,
      );
      this.#unlisted.delete(id);
      await rm(u.directory, { recursive: true, force: true });
      return manifest;
    });
  }
  async catalog(): Promise<PluginCatalogEntry[]> {
    return JSON.parse(await readFile(path.join(this.seeds, "..", "catalog.json"), "utf8").catch(() => "[]"));
  }
  async installCatalog(id: string, approvedCapabilities: string[]) {
    const entry = (await this.catalog()).find((p) => p.manifest.id === id);
    if (!entry) throw new Error(MESSAGE.NotInCatalog);
    if (!entry.url.startsWith("https://") || !SHA256_HEX.test(entry.sha256))
      throw new Error(MESSAGE.InvalidCatalogArtifact);
    const bytes = await downloadArtifact(entry.url);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(MESSAGE.DigestMismatch);
    return this.installEnvelope(
      bytes,
      PluginSourceKind.Catalog,
      approvedCapabilities,
      { kind: PluginSourceKind.Catalog, url: entry.url, sha256: entry.sha256 },
      async (manifest) => {
        if (canonicalManifest(manifest) !== canonicalManifest(entry.manifest)) throw new Error(MESSAGE.CatalogMismatch);
        return undefined;
      },
    );
  }
  /**
   * Install a verified base64-JSON file envelope. Prebuilt files, not npm/tar: no hooks, links or archive
   * extraction semantics. `verify` runs on the staged copy (curated catalog compare, marketplace entry match,
   * static scan) before anything is activated; the marketplace shares this path for `artifact` index entries.
   */
  async installEnvelope(
    bytes: Buffer,
    source: PluginSourceKind,
    approvedCapabilities?: string[],
    origin?: PluginSource,
    verify?: (manifest: PluginManifest, stage: string) => Promise<PluginScan | undefined>,
  ) {
    const stage = path.join(this.root, "staging", randomUUID());
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      await unpackEnvelope(bytes, stage);
      const manifest = await inspectPackage(stage);
      const scan = verify ? await verify(manifest, stage) : undefined;
      return await this.installLocal(stage, source, approvedCapabilities, origin, scan);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  #unwatch(id: string) {
    const w = this.#watchers.get(id);
    if (!w) return;
    this.#watchers.delete(id);
    if (w.timer) clearTimeout(w.timer);
    try {
      w.watcher.close();
    } catch {}
  }
  /**
   * Hot reload for a plugin still being written: re-install from the folder it was loaded from whenever
   * anything under it changes. Local origins only — a sha-pinned or curated install must never follow a
   * moving folder. Best effort: fs.watch coalesces and can miss events, so this is a developer convenience,
   * never a correctness path. Reloads go through the same lease/pending gate as any other update.
   */
  async watch(id: string, enabled: boolean) {
    this.#unwatch(id);
    if (!enabled) return;
    const p = this.#installed.get(id);
    if (!p || !isLive(p)) throw new Error(MESSAGE.EnableFirst);
    const directory = p.origin?.kind === PluginSourceKind.Local ? p.origin.directory : undefined;
    if (!directory) throw new Error(MESSAGE.OnlyLocalWatch);
    if (!(await isDirectory(directory))) throw new Error(MESSAGE.FolderGone);
    const entry: { watcher: { close(): void }; timer: ReturnType<typeof setTimeout> | undefined } = {
      watcher: this.watchFolder(directory, () => {
        if (this.#watchers.get(id) !== entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          void this.#reload(id, directory);
        }, WATCH_DEBOUNCE_MS);
        entry.timer.unref?.();
      }),
      timer: undefined,
    };
    this.#watchers.set(id, entry);
  }
  async #reload(id: string, directory: string) {
    if (!this.#watchers.has(id)) return;
    if (!this.#installed.get(id)?.enabled) return;
    try {
      await this.#serial(async () => {
        // A remove queued ahead of this reload has already run by now: the checks are made again
        // inside the queue, because a watched edit must never bring a removed plugin back.
        if (!this.#watchers.has(id)) return;
        const current = this.#installed.get(id);
        if (!current || current.removed || !current.enabled) return;
        // No `scan` argument: the folder was read again, so the card's verdict is recomputed too.
        await this.#installLocal(
          directory,
          current.source,
          current.manifest.capabilities,
          current.origin,
          undefined,
          PluginChangeReason.Reloaded,
        );
      });
    } catch (e) {
      this.#errors.set(id, String(e));
      this.debug?.(id, `reload failed: ${String(e)}`);
      this.#fire({ id, reason: PluginChangeReason.Failed });
    }
  }
  /**
   * A backend may touch its saved account only from the user's own account actions: read on
   * unlock or connect, write on connect or status after a connect began, clear on disconnect.
   */
  #assertAccountAccess(id: string, p: Installed, method: string, invocation: { method: string; name: string }) {
    const actions = accountActionsOf(p.manifest);
    if (method === PluginService.CredentialsRead && !isActionAmong(invocation, [actions.unlock, actions.connect]))
      throw new Error(MESSAGE.UnlockRequired);
    const mayWrite = this.#saveAuthorized.has(id) && isActionAmong(invocation, [actions.connect, actions.status]);
    if (method === PluginService.CredentialsWrite && !mayWrite) throw new Error(MESSAGE.ConnectionRequired);
    if (method === PluginService.CredentialsClear && !isActionAmong(invocation, [actions.disconnect]))
      throw new Error(MESSAGE.DisconnectRequired);
  }
  /** The account services, answered from the session lease rather than the plugin services. */
  async #credentialService(id: string, p: Installed, method: string, args: any): Promise<unknown> {
    if (method === PluginService.CredentialsSession) return this.#account(id).get();
    if (method === PluginService.CredentialsRead) {
      await this.#account(id).unlock();
      this.#active(id);
      return this.#account(id).get();
    }
    if (method === PluginService.CredentialsClear) return this.#account(id).clear();
    const account = this.#account(id);
    await account.set(args.token);
    this.#active(id);
    this.#saveAuthorized.delete(id);
    p.rememberAccount = true;
    await this.#save();
    if (account.state === PluginAccountState.Unlocked) this.#mcpAuthorized.add(id);
    await this.#mcpSync(id);
    this.#fire({ id, reason: PluginChangeReason.Account });
  }
  /** A native job or runtime service, for a plugin that declares `native-runtime`. */
  #nativeCall(
    p: Installed,
    method: string,
    args: unknown,
    binding: PluginBinding | undefined,
    invocation: { method: string; name: string; signal: AbortSignal },
  ) {
    if (!hasCapability(p, PluginCapability.NativeRuntime) || !this.nativeService)
      throw new Error(MESSAGE.NativeUnavailable);
    return this.nativeService(p.manifest, p.directory, method, args, binding, invocation);
  }
  /** Every host service one plugin's backend calls, gated by its declared capabilities. */
  #hostService(id: string, p: Installed): ConstructorParameters<typeof PluginProcess>[2] {
    return async (method, args, binding, invocation) => {
      this.#active(id);
      this.#assertAccountAccess(id, p, method, invocation);
      if (isNativeService(method)) return this.#nativeCall(p, method, args, binding, invocation);
      if (method === PluginService.SettingsRead) return this.settings(id);
      if (method === PluginService.StorageRoot) return this.service(id, method, args, binding);
      const capability = capabilityFor(method);
      if (!capability || !hasCapability(p, capability)) throw new Error(MESSAGE.CapabilityDenied);
      if (capability === PluginCapability.Credentials && isCredentialService(method))
        return this.#credentialService(id, p, method, args);
      return this.service(id, method, args, binding);
    };
  }
  #process(id: string) {
    const p = this.#active(id);
    let process = this.#processes.get(id);
    if (!process) {
      process = new PluginProcess(
        this.bootstrap,
        path.join(p.directory, p.manifest.backend),
        this.#hostService(id, p),
        (error) => {
          if (this.#processes.get(id) === process) {
            this.#errors.set(id, error);
            this.#processes.delete(id);
            this.#fire({ id, reason: PluginChangeReason.Failed });
          }
        },
        {
          onStderr: (line) => {
            try {
              this.debug?.(id, line);
            } catch {}
          },
          ...(this.toolPath ? { toolPath: this.toolPath } : {}),
        },
      );
      this.#processes.set(id, process);
      this.#errors.delete(id);
    }
    return process;
  }
  /**
   * Run one plugin tool by its agent name for `caller`. A tool its plugin keeps for the harness
   * (`audience: "harness"`) runs only when the harness itself calls it: for any other caller it is
   * unknown, refused before its arguments, consent or backend.
   */
  async tool(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal?: AbortSignal,
    caller: PluginToolAudience = PluginToolAudience.Agents,
  ) {
    const [id, tool, ...extra] = name.split("__");
    const p = this.#active(id);
    // A plugin with file skills has its skill tool answered here, in the host: never by its backend.
    if (!extra.length && tool === PLUGIN_SKILL_TOOL && p.manifest.skills.some(isFileSkill))
      return this.#readSkill(id, p, args);
    const declaration = p.manifest.tools.find((t) => t.name === tool);
    if (extra.length || !declaration) throw new Error(MESSAGE.UnknownTool);
    if (!isAgentTool(declaration) && caller !== PluginToolAudience.Harness) throw new Error(MESSAGE.UnknownTool);
    validateArguments(declaration, args);
    const host = declaration.host;
    if (host) this.#assertHostTool(p);
    if (declaration.confirmation) {
      const shown = host ? await this.#hostConsentArgs(id, host, args, binding) : args;
      await this.#consented(id, name, declaration, shown, binding, signal);
    }
    if (host) return this.#runHostTool(id, host, args, binding, signal);
    const nativeJobTimeouts = (p.manifest.nativeJobs ?? []).map((j) => j.timeoutMs + NATIVE_JOB_MARGIN_MS);
    return this.#process(id).call("tool", tool, args, binding, signal, Math.max(CALL_TIMEOUT_MS, ...nativeJobTimeouts));
  }
  /** Asks the user before a tool that declares `confirmation`; a no is thrown, and the plugin must still be live after. */
  async #consented(
    id: string,
    name: string,
    declaration: PluginTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.consent) throw new Error(MESSAGE.ConsentUnavailable);
    const { approved, by } = await this.consent(id, declaration, args, binding, signal);
    if (!approved) throw new PluginConsentDeclined(name, by);
    this.#active(id);
  }
  /**
   * A host tool runs a program Studio ships. The manifest reserves `host` for the Genex id, and an
   * id is not a provenance: only a package that came with Studio may run one, and only when the
   * host has said how.
   */
  #assertHostTool(p: Installed): void {
    if (p.source !== PluginSourceKind.Bundled) throw new Error(MESSAGE.HostToolBundledOnly);
    if (!this.hostTool) throw new Error(MESSAGE.HostToolUnavailable);
  }
  /** The host's account of a consented host tool call, for the consent card; none, and it fails closed. */
  async #hostConsentArgs(
    id: string,
    host: PluginHostTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
  ): Promise<Record<string, unknown>> {
    const describe = this.hostToolConsent;
    if (!describe) throw new Error(MESSAGE.HostToolUnavailable);
    return describe(id, host, args, binding);
  }
  /**
   * A host tool's call, on its caller's signal and the registry's own: `abortCalls` ends it as cut
   * off (`PluginCallCutOff`), at once, whatever the host's program does after.
   */
  async #runHostTool(
    id: string,
    host: PluginHostTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = this.hostTool;
    if (!run) throw new Error(MESSAGE.HostToolUnavailable);
    const controller = new AbortController();
    this.#hostCalls.add(controller);
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const running = run(id, host, args, binding, callSignal);
      // A cut-off call's own end comes later, into nobody's hands.
      running.catch(() => {});
      return await Promise.race([running, cutOffOf(controller.signal)]);
    } finally {
      this.#hostCalls.delete(controller);
    }
  }
  /**
   * One page of a file skill, for the `<id>__skill` tool. Only a file the skill lists, spelled as
   * listed, read through a handle checked for links and size; nothing is written anywhere.
   */
  async #readSkill(id: string, p: Installed, args: Record<string, unknown>): Promise<PluginSkillPage> {
    const declaration = pluginSkillTool(p.manifest);
    if (!declaration) throw new Error(MESSAGE.UnknownTool);
    validateArguments(declaration, args);
    const skill = p.manifest.skills.find((s): s is PluginFileSkill => isFileSkill(s) && s.name === args.name);
    if (!skill) throw new Error(MESSAGE.UnknownSkill(id, String(args.name)));
    const file = declaredSkillFile(skill, args.file);
    const text = (await readSkillFile(p.directory, file)).toString("utf8");
    const page = skillPage(text, args.offset);
    // Disabled or removed while the file was read: the answer is withheld like any other tool's.
    this.#active(id);
    return { plugin: id, skill: skill.name, file, references: skill.references ?? [], ...page };
  }
  /**
   * A skill's whole text for the Skills page: an inline skill's text, or a file skill's file or one
   * of its references. Any installed plugin, disabled ones too, as the page lists them.
   */
  async skillText(id: string, name: string, file?: string): Promise<string> {
    const p = this.#installed.get(id);
    if (!p || p.removed) throw new Error(MESSAGE.UnknownPlugin);
    const skill = p.manifest.skills.find((s) => s.name === name);
    if (!skill) throw new Error(MESSAGE.UnknownSkill(id, name));
    if (isFileSkill(skill)) return (await readSkillFile(p.directory, declaredSkillFile(skill, file))).toString("utf8");
    if (file !== undefined) throw new Error(MESSAGE.UndeclaredSkillFile);
    return skill.text;
  }
  #connecting = new Map<string, Promise<any>>();
  async action(id: string, name: string, args: unknown, binding?: PluginBinding) {
    const p = this.#active(id);
    if (name !== accountActionsOf(p.manifest).connect) return this.#action(id, name, args, binding);
    const pending = this.#connecting.get(id);
    if (pending) return pending;
    const task = this.#action(id, name, args, binding);
    this.#connecting.set(id, task);
    this.#fire({ id, reason: PluginChangeReason.Account });
    try {
      return await task;
    } finally {
      if (this.#connecting.get(id) === task) {
        this.#connecting.delete(id);
        this.#fire({ id, reason: PluginChangeReason.Account });
      }
    }
  }
  /** Account bookkeeping before an action runs: a cancel ends the sign-in poll, a disconnect forgets the account. */
  async #beforeAccountAction(id: string, p: Installed, name: string, account: AccountActions) {
    if (p.manifest.account?.cancel === name) {
      const poll = this.#accountPolls.get(id);
      if (poll?.timer) clearTimeout(poll.timer);
      this.#accountPolls.delete(id);
      this.#saveAuthorized.delete(id);
    }
    if (name === account.connect) this.#saveAuthorized.add(id);
    if (name === account.disconnect) {
      p.rememberAccount = false;
      await this.#save();
      this.#lockAccount(id);
    }
  }
  /** Account bookkeeping after an action answered: remember an unlocked or reused account, poll a sign-in. */
  async #afterAccountAction(
    id: string,
    p: Installed,
    name: string,
    account: AccountActions,
    answer: { verifyUrl?: unknown; expiresAt?: unknown } | null | undefined,
    binding: PluginBinding | undefined,
  ) {
    // Only an unlock that actually succeeded lets a declared server be handed the credential:
    // authorizing before the call would leave a failed unlock looking like an unlocked account.
    if (name === account.unlock && hasCapability(p, PluginCapability.Credentials)) {
      // A successful explicit unlock is the sole read; MCP launches share its memory lease.
      // Some backends delegate the unlock entirely to the host rather than reading themselves.
      await this.#account(id).unlock();
      this.#active(id);
      if (await this.#account(id).get()) {
        p.rememberAccount = true;
        await this.#save();
        this.#mcpAuthorized.add(id);
      }
    }
    if (name !== account.connect) return;
    // Connect may reuse an existing saved token without writing a new credential.
    if (await this.#account(id).get()) {
      this.#active(id);
      p.rememberAccount = true;
      await this.#save();
    }
    const expiresAt = answer?.expiresAt;
    if (answer?.verifyUrl && typeof expiresAt === "number" && Number.isFinite(expiresAt))
      this.#pollAccount(id, expiresAt, binding);
  }
  /** After any unlock, disconnect or connect, succeeded or not: republish the servers and announce it. */
  async #settleAccountAction(id: string, name: string, account: AccountActions) {
    if (![account.unlock, account.disconnect, account.connect].includes(name)) return;
    if (name === account.connect && (await this.#accounts.get(id)?.get())) this.#mcpAuthorized.add(id);
    await this.#mcpSync(id);
    this.#fire({ id, reason: PluginChangeReason.Account });
  }
  async #action(id: string, name: string, args: unknown, binding?: PluginBinding) {
    const p = this.#active(id);
    if (!p.manifest.actions.some((a) => a.name === name)) throw new Error(MESSAGE.UnknownAction);
    const account = accountActionsOf(p.manifest);
    await this.#beforeAccountAction(id, p, name, account);
    const opensCredentials = name === account.unlock || name === account.connect;
    // A refusal left by an earlier attempt, such as the restore at startup, is not this action's.
    if (opensCredentials) this.#accounts.get(id)?.takeRefusal();
    const installsRuntime = p.manifest.nativeRuntimes?.some((r) => r.install?.action === name);
    try {
      const answer = await this.#process(id).call(
        "action",
        name,
        args,
        binding,
        undefined,
        installsRuntime ? RUNTIME_INSTALL_TIMEOUT_MS : CALL_TIMEOUT_MS,
      );
      await this.#afterAccountAction(id, p, name, account, answer, binding);
      const statusAnswer = name === account.status && answer && typeof answer === "object";
      return statusAnswer ? { ...answer, accountConnecting: this.#connecting.has(id) } : answer;
    } catch (error) {
      if (opensCredentials) {
        // A backend wraps whatever the host answered in its own generic error; a locked secret
        // store's reason (no keyring to start) is the one worth showing.
        const refusal = this.#accounts.get(id)?.takeRefusal();
        this.#lockAccount(id);
        if (refusal) throw refusal;
      }
      throw error;
    } finally {
      await this.#settleAccountAction(id, name, account);
    }
  }
  async review(id: string, name: string, args: unknown, binding?: PluginBinding) {
    this.#active(id);
    return this.#process(id).call("review", name, args, binding);
  }
  /**
   * A plugin's own picture, read from the package Studio installed (or, for one found but not yet
   * allowed, the folder it was found in), whether the plugin is on or off. Null when it ships none
   * or it can't be read: the page then shows the plugin's initial.
   */
  async icon(id: string): Promise<{ bytes: Buffer; type: string } | null> {
    const source = this.#iconSource(id);
    if (!source) return null;
    return readPluginIcon(source.directory, source.file).catch(() => null);
  }
  /** The folder and file a plugin's picture comes from: its own package, else (bundled) the seed Studio ships now. */
  #iconSource(id: string): { directory: string; file: string; version: string } | null {
    const found = this.#installed.get(id) ?? this.#unlisted.get(id);
    if (!found) return null;
    if (found.manifest.icon)
      return { directory: found.directory, file: found.manifest.icon, version: found.manifest.version };
    const seed = this.#seedManifests.get(id);
    const directory = this.#seedDirectories.get(id);
    const bundled = this.#installed.get(id)?.source === PluginSourceKind.Bundled;
    if (!bundled || !seed?.icon || !directory) return null;
    return { directory, file: seed.icon, version: seed.version };
  }
  /** The URL a plugin's picture loads from, when it has one. */
  #iconUrl(id: string): { iconUrl: string } | Record<string, never> {
    const source = this.#iconSource(id);
    const url = source ? pluginIconUrl({ id, version: source.version, icon: source.file }) : undefined;
    return url ? { iconUrl: url } : {};
  }
  async panel(id: string, panelId: string) {
    const p = this.#active(id),
      panel = p.manifest.panels.find((x) => x.id === panelId);
    if (!panel) throw new Error(MESSAGE.UnknownPanel);
    return { title: panel.title, html: await readFile(await containedReal(p.directory, panel.file), "utf8") };
  }
  /**
   * The declared settings, each the stored value when it still has the declared type, otherwise
   * its default. A key an earlier version declared, or stored under another type, never reaches
   * the backend or a `setting:` server variable, and the next save drops it.
   */
  async settings(id: string): Promise<Record<string, unknown>> {
    const p = this.#active(id);
    const stored = JSON.parse(
      await readFile(path.join(this.root, "data", id, "settings.json"), "utf8").catch(() => "{}"),
    ) as Record<string, unknown>;
    return Object.fromEntries(
      p.manifest.settings.map((s) => {
        const value = stored && typeof stored === "object" && Object.hasOwn(stored, s.key) ? stored[s.key] : undefined;
        return [s.key, settingValueFits(s, value) ? value : s.default];
      }),
    );
  }
  async setSetting(id: string, key: string, value: unknown) {
    const p = this.#active(id),
      s = p.manifest.settings.find((s) => s.key === key);
    if (!s || !settingValueFits(s, value)) throw new Error(MESSAGE.InvalidSetting);
    const settings = await this.settings(id);
    settings[key] = value;
    await mkdir(path.join(this.root, "data", id), { recursive: true });
    await atomicWriteJson(path.join(this.root, "data", id, "settings.json"), settings);
    await this.#mcpSync(id);
    this.#fire({ id, reason: PluginChangeReason.Settings });
  }
  /**
   * End every plugin call in flight as cut off, for `reason` (the harness that made them ended).
   * Only the calls: every backend keeps running, every account stays unlocked and every plugin's
   * connectors stay published. Quitting is `cancel()`, which stops all of that too.
   */
  abortCalls(reason: CallCutOff) {
    for (const process of this.#processes.values()) process.cutOff(reason);
    for (const controller of this.#hostCalls) controller.abort(new PluginCallCutOff(reason));
  }
  cancel(binding?: Partial<PluginBinding>) {
    if (binding) {
      for (const process of this.#processes.values()) process.cancel(binding);
      return;
    }
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    for (const process of this.#processes.values()) process.stop();
    this.#processes.clear();
    // A stopped plugin has no servers: the last stop point is one of them too.
    for (const id of this.#accounts.keys()) this.#lockAccount(id);
    this.#mcpAuthorized.clear();
    const host = this.mcpHost;
    if (host)
      for (const id of [...this.#installed.keys()]) {
        try {
          void Promise.resolve(host.unregister(id)).catch(() => {});
        } catch {}
      }
  }
}
