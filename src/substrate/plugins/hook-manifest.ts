/**
 * A plugin manifest's moments and locks (API 3, `shared/plugin-hooks.ts`): `locks`, `hooks`, the
 * locks a tool or connector `needs`, and an agent tool's `ready` probe. Checked here and kept in
 * canonical form. A handler or probe is one of the plugin's own tools only the harness calls, that
 * asks the person nothing and runs no host program: a moment never waits on a question, and never
 * runs another plugin's code.
 */
import { isHookEvent, isLockScope, LOCK_ID, LOCK_LABEL_CHARS } from "../../shared/plugin-hooks.ts";
import type { PluginHook, PluginLock } from "../../shared/plugin-hooks.ts";
import { isAgentTool, type PluginManifest, type PluginManifestTool } from "../../shared/plugins.ts";
import { isFactId } from "../../shared/project-facts.ts";

/** How much the sections may declare. */
const LIMIT = { Locks: 8, Hooks: 32, Facts: 8, Needs: 4 } as const;

/** Control characters, NUL and line breaks included. */
const CONTROL = /\p{Cc}/u;

/** The keys each entry may hold, in canonical order. */
const LOCK_KEYS = ["id", "label", "per", "personFirst"] as const;
const HOOK_KEYS = ["on", "tool", "facts"] as const;

/** What a publisher reads when a section is refused. */
const MESSAGE = {
  NeedsApi3: (section: string) => `${section} requires apiVersion 3`,
  NotList: (section: string, max: number) => `Invalid ${section} (a list of at most ${max} entries)`,
  InvalidLock: (at: string) =>
    `Invalid locks entry ${at} (id: lowercase letters, digits and dashes, starting with a letter, at most 40; label: 1-${LOCK_LABEL_CHARS} characters on one line; per: project or app; only these keys)`,
  DuplicateLock: (id: string) => `Invalid locks: ${id} is declared twice`,
  InvalidProbe: (at: string) =>
    `Invalid locks entry ${at} personFirst (a tool of this manifest only the harness calls, that asks nothing, runs no host program and does not need this lock)`,
  InvalidHook: (at: string) =>
    `Invalid hooks entry ${at} (on: one of Genex's moments; tool: a tool of this manifest only the harness calls, that asks nothing and runs no host program; facts: 1-${LIMIT.Facts} fact ids, each once; only these keys)`,
  DuplicateHook: (at: string) => `Invalid hooks: ${at} is declared twice`,
  InvalidNeeds: (where: string, name: string) =>
    `Invalid ${where}.needs of ${name} (1-${LIMIT.Needs} lock ids this manifest declares, each once)`,
  InvalidReady: (name: string) =>
    `Invalid tools[].ready of ${name} (only on an agent tool with makes; a tool of this manifest only the harness calls, that asks nothing and runs no host program)`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
/** How an entry is named in a refusal: a name it has, else its place in the list. */
const nameOf = (entry: unknown, key: string, index: number): string => {
  const named = isRecord(entry) && typeof entry[key] === "string" ? String(entry[key]) : "";
  return named ? JSON.stringify(named) : `#${index + 1}`;
};

/** The section's list, refusing anything but a list of at most `max` on API 3. */
function sectionList(m: Pick<PluginManifest, "apiVersion">, section: string, raw: unknown, max: number): unknown[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3(section));
  if (!Array.isArray(raw) || raw.length > max) throw new Error(MESSAGE.NotList(section, max));
  return raw;
}

/** A list of 1-`max` distinct entries, each passing `valid`, or undefined. */
function distinctList(value: unknown, max: number, valid: (entry: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return undefined;
  if (!value.every(valid) || new Set(value).size !== value.length) return undefined;
  return [...(value as string[])];
}

/** The manifest tool `name` when it is one a moment may run: harness only, no question, no host program. */
function quietHarnessTool(tools: readonly PluginManifestTool[], name: unknown): PluginManifestTool | undefined {
  const tool = tools.find((t) => t.name === name);
  const quiet = tool && !isAgentTool(tool) && tool.confirmation === undefined && tool.host === undefined;
  return quiet ? tool : undefined;
}

/** Whether a lock label is 1-60 characters on one line, not only spaces. */
const isLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= LOCK_LABEL_CHARS && !CONTROL.test(value);

/** Whether `entry` is a lock with only its keys, a lock id, a label and a scope (its probe aside). */
function isLockEntry(entry: unknown): entry is PluginLock {
  return (
    isRecord(entry) &&
    hasOnlyKeys(entry, LOCK_KEYS) &&
    typeof entry.id === "string" &&
    LOCK_ID.test(entry.id) &&
    isLabel(entry.label) &&
    isLockScope(entry.per)
  );
}

/** One lock in canonical form; its probe is a quiet harness tool of `tools`. */
function pluginLock(entry: unknown, index: number, tools: readonly PluginManifestTool[]): PluginLock {
  const at = nameOf(entry, "id", index);
  if (!isLockEntry(entry)) throw new Error(MESSAGE.InvalidLock(at));
  const lock: PluginLock = { id: entry.id, label: entry.label, per: entry.per };
  if (entry.personFirst === undefined) return lock;
  if (!quietHarnessTool(tools, entry.personFirst)) throw new Error(MESSAGE.InvalidProbe(at));
  lock.personFirst = entry.personFirst;
  return lock;
}

/** The manifest's `locks` in canonical form; throws on API 1 or 2 and on anything malformed. */
function validateLocks(m: PluginManifest, tools: readonly PluginManifestTool[]): PluginLock[] {
  const seen = new Set<string>();
  return sectionList(m, "locks", m.locks, LIMIT.Locks).map((entry, index) => {
    const lock = pluginLock(entry, index, tools);
    if (seen.has(lock.id)) throw new Error(MESSAGE.DuplicateLock(JSON.stringify(lock.id)));
    seen.add(lock.id);
    return lock;
  });
}

/** A `needs` list in canonical form: API 3, 1-4 distinct ids of locks this manifest declares. */
function needsList(
  value: unknown,
  where: string,
  name: string,
  m: PluginManifest,
  locks: ReadonlySet<string>,
): string[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3(`${where}.needs`));
  const needs = distinctList(value, LIMIT.Needs, (id) => typeof id === "string" && locks.has(id));
  if (!needs) throw new Error(MESSAGE.InvalidNeeds(where, JSON.stringify(name)));
  return needs;
}

/** The `needs` of each tool and connector, copied onto their canonical forms when declared. */
function validateNeeds(m: PluginManifest, canonical: PluginManifest, locks: ReadonlySet<string>): void {
  m.tools.forEach((raw, index) => {
    const tool = canonical.tools[index];
    if (raw.needs !== undefined && tool) tool.needs = needsList(raw.needs, "tools[]", raw.name, m, locks);
  });
  (m.mcpServers ?? []).forEach((raw, index) => {
    const server = canonical.mcpServers?.[index];
    if (raw.needs !== undefined && server) server.needs = needsList(raw.needs, "mcpServers[]", raw.id, m, locks);
  });
}

/** Refuses a lock whose probe needs the lock itself: asking whether the person is busy would wait on the answer. */
function assertProbesFree(locks: readonly PluginLock[], tools: readonly PluginManifestTool[]): void {
  for (const lock of locks) {
    const probe = tools.find((tool) => tool.name === lock.personFirst);
    if (probe?.needs?.includes(lock.id)) throw new Error(MESSAGE.InvalidProbe(JSON.stringify(lock.id)));
  }
}

/** Whether `entry` is a hook with only its keys and a known moment (its tool and facts aside). */
const isHookEntry = (entry: unknown): entry is PluginHook & Record<string, unknown> =>
  isRecord(entry) && hasOnlyKeys(entry, HOOK_KEYS) && isHookEvent(entry.on);

/** One hook in canonical form; its tool is a quiet harness tool of `tools`. */
function pluginHook(entry: unknown, index: number, tools: readonly PluginManifestTool[]): PluginHook {
  const at = nameOf(entry, "tool", index);
  if (!isHookEntry(entry) || !quietHarnessTool(tools, entry.tool)) throw new Error(MESSAGE.InvalidHook(at));
  const hook: PluginHook = { on: entry.on, tool: entry.tool };
  if (entry.facts === undefined) return hook;
  const facts = distinctList(entry.facts, LIMIT.Facts, isFactId);
  if (!facts) throw new Error(MESSAGE.InvalidHook(at));
  hook.facts = facts;
  return hook;
}

/** The manifest's `hooks` in canonical form; throws on API 1 or 2, on anything malformed and on a tool hooked to one moment twice. */
function validateHooks(m: PluginManifest, tools: readonly PluginManifestTool[]): PluginHook[] {
  const seen = new Set<string>();
  return sectionList(m, "hooks", m.hooks, LIMIT.Hooks).map((entry, index) => {
    const hook = pluginHook(entry, index, tools);
    const key = `${hook.on} ${hook.tool}`;
    if (seen.has(key)) throw new Error(MESSAGE.DuplicateHook(JSON.stringify(key)));
    seen.add(key);
    return hook;
  });
}

/** Each agent tool's `ready` probe, copied onto its canonical form when declared. */
function validateReady(m: PluginManifest, tools: PluginManifestTool[]): void {
  m.tools.forEach((raw, index) => {
    const tool = tools[index];
    if (raw.ready === undefined || !tool) return;
    if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3("tools[].ready"));
    const makes = isAgentTool(tool) && tool.makes !== undefined;
    if (!makes || !quietHarnessTool(tools, raw.ready)) throw new Error(MESSAGE.InvalidReady(JSON.stringify(raw.name)));
    tool.ready = raw.ready;
  });
}

/**
 * The manifest's `locks`, `hooks`, `needs` and `ready`, checked against its canonical tools and
 * connectors (already validated) and kept on `canonical` only when declared.
 */
export function validateMomentSections(m: PluginManifest, canonical: PluginManifest): void {
  if (m.locks !== undefined) canonical.locks = validateLocks(m, canonical.tools);
  validateNeeds(m, canonical, new Set((canonical.locks ?? []).map((lock) => lock.id)));
  if (canonical.locks) assertProbesFree(canonical.locks, canonical.tools);
  if (m.hooks !== undefined) canonical.hooks = validateHooks(m, canonical.tools);
  validateReady(m, canonical.tools);
}
