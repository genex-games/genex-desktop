/** Discovery only: never sends a model prompt, executes a skill, or imports user tools. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveCodingCli } from "../substrate/engines/external-cli.ts";
import { isBelow, isInside, toPosixRelative } from "../substrate/paths.ts";
import { codexSubscriptionEnv } from "../substrate/engines/codex-cli.ts";
import {
  type ProjectSkill,
  type ProjectSkillInventory,
  type ProviderSkill,
  ProviderBuilderUse,
  type ProviderSkillInventory,
} from "../shared/provider-skills.ts";
import { LoginSource } from "../shared/engine-descriptor.ts";
import { errorMessage } from "../shared/errors.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";
import { CodingCliState } from "../shared/coding-cli.ts";

/** How long Codex may take to list its skills. */
const CODEX_DISCOVERY_TIMEOUT_MS = 12 * SECOND_MS;
/** The largest skill inventory Codex may answer with, in bytes. */
const CODEX_INVENTORY_MAX_BYTES = 2 * 1024 * 1024;
/** The largest skill or plugin-registry file read, in bytes. */
const SKILL_FILE_MAX_BYTES = 256 * 1024;
/** How deep, and through how many folders, one skill root is walked. */
const SKILL_WALK_MAX_DEPTH = 6;
const SKILL_WALK_MAX_FOLDERS = 2000;

/** What the Skills panel reads when discovery could not finish; each names the next step. */
const MESSAGE = {
  codexUnavailable: "Codex CLI is unavailable. Check Model Providers, then refresh skills.",
  codexTimedOut: "Codex skill discovery timed out. Refresh to retry.",
  codexNotStarted: "Could not start Codex skill discovery. Check Model Providers.",
  codexExited: "Codex closed before returning its skills. Refresh to retry.",
  codexPipeClosed: "Codex skill discovery closed. Refresh to retry.",
  codexOversized: "Codex returned an oversized skill inventory.",
  codexRefused: "Codex could not list skills with this configuration. Check the CLI, then refresh.",
  codexUnreadable: "Codex reported unreadable skills. Check its configuration, then refresh.",
  claudeLimit: "Some skill folders exceeded the discovery limit.",
  claudePlugins: "Could not read the installed Claude plugin inventory.",
  claudeNote:
    "Installed globally. Studio currently loads project skills only; these personal skills are not enabled in its Claude sessions.",
  openCodeUnavailable: "OpenCode CLI is unavailable. Check Model Providers, then refresh skills.",
  openCodeNote: "Installed globally. Studio's OpenCode sessions load no skills, so these are not enabled in them.",
  codexNote:
    "Reported by the selected Codex CLI profile. Availability does not mean a skill was used in a conversation.",
  invalidSkillMetadata: "Invalid skill metadata",
} as const;

/** One Codex catalog entry as a global skill, or null for project scope and malformed entries. */
function codexSkill(item: unknown): ProviderSkill | null {
  const s = item as Record<string, unknown>;
  // This surface is global discovery; project instructions stay with their project.
  if (s.scope === "repo") return null;
  if (typeof s.name !== "string" || typeof s.path !== "string") return null;
  if (!path.isAbsolute(s.path)) return null;
  return {
    name: s.name,
    description: typeof s.description === "string" ? s.description : "",
    path: s.path,
    scope: typeof s.scope === "string" ? s.scope : "global",
    ...(typeof s.enabled === "boolean" ? { enabled: s.enabled } : {}),
  };
}

export function normalizeCodexSkills(value: unknown): ProviderSkill[] {
  const data = (value as { data?: Array<{ skills?: unknown[] }> })?.data;
  const result = new Map<string, ProviderSkill>();
  for (const group of Array.isArray(data) ? data : [])
    for (const item of group.skills ?? []) {
      const skill = codexSkill(item);
      if (skill) result.set(skill.path, skill);
    }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function codexCatalog(cwd: string, home: string | null): Promise<unknown> {
  const cli = await resolveCodingCli(EngineId.Codex);
  const executable = cli.status.path;
  if (cli.status.state !== CodingCliState.Ready || !executable) throw new Error(MESSAGE.codexUnavailable);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], {
      cwd,
      env: codexSubscriptionEnv({ ...cli.env, ...(home ? { CODEX_HOME: home } : {}) }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let bytes = 0;
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(MESSAGE.codexTimedOut));
    }, CODEX_DISCOVERY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    const send = (data: unknown) => child.stdin.write(`${JSON.stringify(data)}\n`);
    child.on("error", () => finish(new Error(MESSAGE.codexNotStarted)));
    child.on("exit", () => finish(new Error(MESSAGE.codexExited)));
    child.stdin.on("error", () => finish(new Error(MESSAGE.codexPipeClosed)));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > CODEX_INVENTORY_MAX_BYTES) finish(new Error(MESSAGE.codexOversized));
    });
    lines.on("line", (line) => {
      let data: { id?: number; error?: unknown; result?: unknown };
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      if (data.id !== 1 && data.id !== 2) return;
      if (data.error) {
        finish(new Error(MESSAGE.codexRefused));
        return;
      }
      if (data.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } });
      } else finish(undefined, data.result);
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "studio-skill-inventory", version: "1.0" }, capabilities: {} },
    });
  });
}

async function smallFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > SKILL_FILE_MAX_BYTES) throw new Error(MESSAGE.invalidSkillMetadata);
  return readFile(file, "utf8");
}

/** A skill file's front matter: the text between its leading `---` lines, or nothing. */
function frontMatter(text: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
}

/** A folded or literal YAML block (`key: >` then indented lines), joined into one line. */
function blockScalar(after: string): string {
  const block: string[] = [];
  for (const line of after.split(/\r?\n/).slice(1)) {
    if (line && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(" ").trim();
}

/** One front-matter field, unquoted, a block scalar read as its text. */
function frontMatterField(front: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(front);
  const value = match?.[1]?.trim();
  const isBlock = Boolean(value && /^[>|][-+]?$/u.test(value));
  if (!match || !isBlock) return value?.replace(/^["']|["']$/g, "");
  return blockScalar(front.slice(match.index + match[0].length));
}

/** What a walk fills: the skills found and what could not be read. */
type SkillOutput = Pick<ProviderSkillInventory, "skills" | "warnings">;

/** What every scan of one inventory shares: the inventory, and the files and folders already read. */
interface SkillInventoryScan {
  output: SkillOutput;
  seen: Set<string>;
  directories: Set<string>;
}

/** One skill root being walked. */
interface SkillRootScan extends SkillInventoryScan {
  roots: Array<string | null>;
  scope: string;
  /** A commands folder: every `.md` is one, rather than each folder's `SKILL.md`. */
  commands: boolean;
  visited: number;
}

const withinRoots = (roots: ReadonlyArray<string | null>, file: string): boolean =>
  roots.some((root) => root && isInside(root, file));

const isSkillFile = (name: string, commands: boolean): boolean =>
  commands ? name.endsWith(".md") : name === "SKILL.md";

function warnOnce(output: SkillOutput, warning: string): void {
  if (!output.warnings.includes(warning)) output.warnings.push(warning);
}

async function listSkill(scan: SkillRootScan, dir: string, file: string, name: string): Promise<void> {
  const target = await realpath(file);
  if (scan.seen.has(target) || !withinRoots(scan.roots, target)) return;
  try {
    const front = frontMatter(await smallFile(file));
    scan.seen.add(target);
    scan.output.skills.push({
      name: frontMatterField(front, "name") || (scan.commands ? name.slice(0, -3) : path.basename(dir)),
      description: frontMatterField(front, "description") || "",
      path: file,
      scope: scan.scope,
    });
  } catch {
    scan.output.warnings.push(`Could not read skill ${name}.`);
  }
}

async function walkSkills(scan: SkillRootScan, dir: string, depth: number): Promise<void> {
  if (depth > SKILL_WALK_MAX_DEPTH || ++scan.visited > SKILL_WALK_MAX_FOLDERS) {
    warnOnce(scan.output, MESSAGE.claudeLimit);
    return;
  }
  const actual = await realpath(dir);
  if (!withinRoots(scan.roots, actual) || scan.directories.has(actual)) return;
  scan.directories.add(actual);
  const entries = await readdir(dir, { withFileTypes: true });
  const foundSkill = !scan.commands && entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (!foundSkill && !entry.name.startsWith(".")) await walkSkills(scan, file, depth + 1).catch(() => {});
      continue;
    }
    if (isSkillFile(entry.name, scan.commands)) await listSkill(scan, dir, file, entry.name);
  }
}

async function scanSkillRoot(
  inventory: SkillInventoryScan,
  root: string,
  scope: string,
  commands = false,
  extraRoots: string[] = [],
): Promise<void> {
  const roots = await Promise.all([root, ...extraRoots].map((p) => realpath(p).catch(() => null)));
  if (!roots[0]) return;
  try {
    await walkSkills({ ...inventory, roots, scope, commands, visited: 0 }, root, 0);
  } catch {
    inventory.output.warnings.push(`Could not read ${scope} skills.`);
  }
}

/** Read installed identities, not every stale version left under the cache. */
async function scanInstalledPlugins(inventory: SkillInventoryScan, home: string): Promise<void> {
  try {
    const registry = JSON.parse(await smallFile(path.join(home, "plugins/installed_plugins.json"))) as {
      plugins?: Record<string, Array<{ scope?: string; installPath?: string }>>;
    };
    const cache = await realpath(path.join(home, "plugins")).catch(() => null);
    for (const [name, versions] of Object.entries(registry.plugins ?? {}))
      for (const version of Array.isArray(versions) ? versions : []) await scanPlugin(inventory, cache, name, version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") inventory.output.warnings.push(MESSAGE.claudePlugins);
  }
}

/** One installed plugin version's skills and commands, when it is a global install inside the cache. */
async function scanPlugin(
  inventory: SkillInventoryScan,
  cache: string | null,
  name: string,
  version: { scope?: string; installPath?: string },
): Promise<void> {
  if (!cache || version.scope === "project") return;
  if (!version.installPath) return;
  const root = await realpath(version.installPath).catch(() => null);
  if (!root || !isInside(cache, root)) return;
  await scanSkillRoot(inventory, path.join(root, "skills"), `plugin ${name}`);
  await scanSkillRoot(inventory, path.join(root, "commands"), `plugin ${name}`, true);
}

/** Claude's project-only sessions intentionally exclude personal settings and their hooks. */
export async function claudeGlobalSkills(
  home: string,
  sharedHome = os.homedir(),
  managed = "/Library/Application Support/ClaudeCode/skills",
): Promise<ProviderSkillInventory> {
  const output: ProviderSkillInventory = {
    provider: EngineId.ClaudeCode,
    label: "Claude Code",
    source: "installed-files",
    skills: [],
    warnings: [],
    note: MESSAGE.claudeNote,
    builders: ProviderBuilderUse.NotLoaded,
  };
  const inventory: SkillInventoryScan = { output, seen: new Set(), directories: new Set() };
  await scanSkillRoot(inventory, path.join(home, "skills"), "personal", false, [
    path.join(sharedHome, ".agents/skills"),
  ]);
  await scanSkillRoot(inventory, path.join(home, "commands"), "personal command", true);
  await scanSkillRoot(inventory, managed, "managed");
  await scanInstalledPlugins(inventory, home);
  output.skills.sort((a, b) => a.name.localeCompare(b.name));
  return output;
}

/** Which login Codex's builders use decides whether its global skills reach them. */
const CODEX_BUILDER_USE = {
  [LoginSource.System]: ProviderBuilderUse.BorrowedLogin,
  [LoginSource.Env]: ProviderBuilderUse.BorrowedLogin,
  [LoginSource.Isolated]: ProviderBuilderUse.StudioProfile,
  [LoginSource.None]: ProviderBuilderUse.NoLogin,
} as const satisfies Record<LoginSource, ProviderBuilderUse>;

/** Whether Codex's global skills reach Studio's builders, from the login they use. */
export const codexBuilderUse = (source: LoginSource): ProviderBuilderUse => CODEX_BUILDER_USE[source];

/** The Codex login discovery runs under: its home, and where that login comes from. */
export interface CodexSkillLogin {
  home: string | null;
  source: LoginSource;
}

export async function codexGlobalSkills(cwd: string, login: CodexSkillLogin | null): Promise<ProviderSkillInventory> {
  const output: ProviderSkillInventory = {
    provider: EngineId.Codex,
    label: "Codex",
    source: "native-catalog",
    skills: [],
    warnings: [],
    note: MESSAGE.codexNote,
    builders: codexBuilderUse(login?.source ?? LoginSource.None),
  };
  try {
    const value = await codexCatalog(cwd, login?.home ?? null);
    output.skills = normalizeCodexSkills(value);
    if ((value as { data?: Array<{ errors?: unknown[] }> }).data?.some((group) => group.errors?.length))
      output.warnings.push(MESSAGE.codexUnreadable);
  } catch (error) {
    output.warnings.push(errorMessage(error));
  }
  return output;
}

/** OpenCode's global config folder: XDG's when absolute, else the classic dot-config under home. */
function openCodeConfigDir(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, "opencode") : path.join(home, ".config", "opencode");
}

/** Whether the installed OpenCode CLI answers; test doubles stand in for discovery. */
async function openCodeCliReady(): Promise<boolean> {
  const cli = await resolveCodingCli(EngineId.OpenCode).catch(() => null);
  return cli?.status.state === CodingCliState.Ready;
}

/**
 * OpenCode's global skills, read-only: the `skills` folders its global config loads. Studio's
 * OpenCode sessions deny every skill (`openCodeConfig`), so these never reach a builder (`NotLoaded`). A
 * missing CLI reads as a warning naming the next step, never a throw, as Codex's does.
 */
export async function openCodeGlobalSkills(
  home: string,
  configDir: string = openCodeConfigDir(home),
  cliReady: () => Promise<boolean> = openCodeCliReady,
): Promise<ProviderSkillInventory> {
  const output: ProviderSkillInventory = {
    provider: EngineId.OpenCode,
    label: "OpenCode",
    source: "installed-files",
    skills: [],
    warnings: [],
    note: MESSAGE.openCodeNote,
    builders: ProviderBuilderUse.NotLoaded,
  };
  if (!(await cliReady().catch(() => false))) {
    output.warnings.push(MESSAGE.openCodeUnavailable);
    return output;
  }
  const inventory: SkillInventoryScan = { output, seen: new Set(), directories: new Set() };
  await scanSkillRoot(inventory, path.join(configDir, "skills"), "global");
  output.skills.sort((a, b) => a.name.localeCompare(b.name));
  return output;
}

/** Where a game folder keeps the skills its builders load, and which builders load each. */
const PROJECT_SKILL_ROOTS: ReadonlyArray<Pick<ProjectSkill, "kind" | "engines"> & { dir: string }> = [
  { dir: ".claude/skills", kind: "skill", engines: [EngineId.ClaudeCode] },
  { dir: ".claude/commands", kind: "command", engines: [EngineId.ClaudeCode] },
  { dir: ".agents/skills", kind: "skill", engines: [EngineId.Codex] },
];

/**
 * The skills and commands a game folder gives its builders. Discovery only, and confined to the
 * game: a root, folder or file whose real path leaves the game folder is not the game's and is not
 * read. One file two roots reach (a linked `.agents/skills`) is one skill for both builders.
 */
export async function projectSkills(gameDir: string): Promise<Omit<ProjectSkillInventory, "project">> {
  const game = await realpath(gameDir);
  const found = new Map<string, ProjectSkill>();
  const warnings: string[] = [];
  for (const root of PROJECT_SKILL_ROOTS) {
    const dir = path.join(game, root.dir);
    const real = await realpath(dir).catch(() => null);
    if (!real || !isBelow(game, real)) continue;
    const output: SkillOutput = { skills: [], warnings: [] };
    await scanSkillRoot({ output, seen: new Set(), directories: new Set() }, dir, root.kind, root.kind === "command");
    for (const warning of output.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    for (const skill of output.skills) await addProjectSkill(found, game, skill, root);
  }
  const skills = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

async function addProjectSkill(
  found: Map<string, ProjectSkill>,
  game: string,
  skill: ProviderSkill,
  root: (typeof PROJECT_SKILL_ROOTS)[number],
): Promise<void> {
  const key = await realpath(skill.path).catch(() => skill.path);
  const known = found.get(key);
  if (known) {
    for (const engine of root.engines) if (!known.engines.includes(engine)) known.engines.push(engine);
    return;
  }
  found.set(key, {
    name: skill.name,
    description: skill.description,
    path: toPosixRelative(path.relative(game, skill.path)),
    kind: root.kind,
    engines: [...root.engines],
  });
}
