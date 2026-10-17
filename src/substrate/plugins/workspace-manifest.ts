/**
 * A plugin manifest's `workspace` and `assets` sections (API 3): what history and writers' copies
 * leave out of a folder holding the plugin's facts, and where that folder's assets live
 * (`shared/project-workspace.ts`). Checked here and kept in canonical form: exactly the keys given.
 * Both reach the facts the plugin's own `detect` declares, or the ones their `facts` name.
 */
import type { PluginManifest } from "../../shared/plugins.ts";
import { isFactId } from "../../shared/project-facts.ts";
import { isAssetFolderName, isWorkspacePattern, type PluginWorkspace } from "../../shared/project-workspace.ts";

/** How much one section may declare. */
const LIMIT = { Facts: 8, Patterns: 16, Folders: 8, Formats: 32 } as const;

/** A format: a lowercase extension without its dot. */
const FORMAT = /^[a-z0-9]{1,10}$/;

/** The section names, as the manifest spells them. */
const Section = { Workspace: "workspace", Assets: "assets" } as const;
type Section = (typeof Section)[keyof typeof Section];

/** The keys each section may hold. */
const SECTION_KEYS: Readonly<Record<Section, readonly string[]>> = {
  [Section.Workspace]: ["facts", "ignore", "copySkip"],
  [Section.Assets]: ["facts", "folders", "formats"],
};

/** What a publisher reads when a section is refused. */
const MESSAGE = {
  NeedsApi3: (section: string) => `${section} requires apiVersion 3`,
  NotObject: (section: Section) => `Invalid ${section} (an object with only ${SECTION_KEYS[section].join(", ")})`,
  InvalidFacts: (section: string) =>
    `Invalid ${section} facts (1-${LIMIT.Facts} fact ids: lowercase letters, digits and dashes, starting with a letter)`,
  NoFacts: (section: string) => `${section} needs facts on a plugin with no detect`,
  InvalidPatterns: (key: string) =>
    `Invalid workspace ${key} (at most ${LIMIT.Patterns} globs of at most 6 segments: plain characters, * within a segment, an optional leading **/, not only *, and none of Genex's own files)`,
  EmptyWorkspace: "Invalid workspace (ignore or copySkip must list at least one pattern)",
  InvalidFolders: `Invalid assets folders (1-${LIMIT.Folders} folders inside the fact's folder, or ".")`,
  InvalidFormats: `Invalid assets formats (at most ${LIMIT.Formats} lowercase extensions without the dot)`,
} as const;

type Workspace = NonNullable<PluginManifest["workspace"]>;
type Assets = NonNullable<PluginManifest["assets"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A list of strings of `min` to `max` entries, each passing `valid`, copied; undefined otherwise. */
function listOf(value: unknown, min: number, max: number, valid: (entry: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > max) return undefined;
  return value.every(valid) ? [...(value as string[])] : undefined;
}

/** The section as a record with only its own keys, refusing anything else and any API but 3. */
function sectionRecord(m: Pick<PluginManifest, "apiVersion">, section: Section, raw: unknown): Record<string, unknown> {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3(section));
  const known = isRecord(raw) && Object.keys(raw).every((key) => SECTION_KEYS[section].includes(key));
  if (!known) throw new Error(MESSAGE.NotObject(section));
  return raw;
}

/** The section's `facts`, checked; a section without them needs the plugin's own `detect`. */
function sectionFacts(m: Pick<PluginManifest, "detect">, section: Section, raw: unknown): string[] | undefined {
  if (raw === undefined) {
    if (!Array.isArray(m.detect) || m.detect.length === 0) throw new Error(MESSAGE.NoFacts(section));
    return undefined;
  }
  const facts = listOf(raw, 1, LIMIT.Facts, isFactId);
  if (!facts) throw new Error(MESSAGE.InvalidFacts(section));
  return facts;
}

/** One pattern list of `workspace`, checked, or undefined when absent. */
function patterns(raw: Record<string, unknown>, key: "ignore" | "copySkip"): string[] | undefined {
  if (raw[key] === undefined) return undefined;
  const list = listOf(raw[key], 0, LIMIT.Patterns, isWorkspacePattern);
  if (!list) throw new Error(MESSAGE.InvalidPatterns(key));
  return list;
}

/** The manifest's `workspace` in canonical form; throws on API 1 or 2 and on anything malformed. */
export function validateWorkspace(m: Pick<PluginManifest, "apiVersion" | "detect" | "workspace">): Workspace {
  const raw = sectionRecord(m, Section.Workspace, m.workspace);
  const facts = sectionFacts(m, Section.Workspace, raw.facts);
  const ignore = patterns(raw, "ignore");
  const copySkip = patterns(raw, "copySkip");
  if (!ignore?.length && !copySkip?.length) throw new Error(MESSAGE.EmptyWorkspace);
  return {
    ...(facts ? { facts } : {}),
    ...(ignore ? { ignore } : {}),
    ...(copySkip ? { copySkip } : {}),
  };
}

/** Whether `value` is an asset folder: the fact's folder itself, or a plain folder inside it that is no hidden or bookkeeping one. */
const isAssetFolder = (value: unknown): boolean => isAssetFolderName(value);
const isFormat = (value: unknown): boolean => typeof value === "string" && FORMAT.test(value);

/** The manifest's `assets` in canonical form; throws on API 1 or 2 and on anything malformed. */
export function validateAssets(m: Pick<PluginManifest, "apiVersion" | "detect" | "assets">): Assets {
  const raw = sectionRecord(m, Section.Assets, m.assets);
  const facts = sectionFacts(m, Section.Assets, raw.facts);
  const folders = listOf(raw.folders, 1, LIMIT.Folders, isAssetFolder);
  if (!folders) throw new Error(MESSAGE.InvalidFolders);
  const formats = raw.formats === undefined ? undefined : listOf(raw.formats, 0, LIMIT.Formats, isFormat);
  if (raw.formats !== undefined && !formats) throw new Error(MESSAGE.InvalidFormats);
  return { ...(facts ? { facts } : {}), folders, ...(formats ? { formats } : {}) };
}

/** Whether two fact lists name the same facts in the same order. */
const sameFacts = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * What a validated manifest hands the workspace: its `workspace` and `assets`, each reaching the
 * facts it names or else those the plugin's `detect` declares. One entry when both reach the same
 * facts, two when they differ, none when the plugin declares neither.
 */
export function pluginWorkspaces(manifest: PluginManifest): PluginWorkspace[] {
  const { workspace, assets } = manifest;
  if (!workspace && !assets) return [];
  const own = [...new Set((manifest.detect ?? []).map((rule) => rule.fact))];
  const pluginId = manifest.id;
  const rules: PluginWorkspace | undefined = workspace && {
    pluginId,
    facts: workspace.facts ?? own,
    ignore: workspace.ignore ?? [],
    copySkip: workspace.copySkip ?? [],
  };
  if (!assets) return rules ? [rules] : [];
  const folders = { folders: assets.folders, ...(assets.formats ? { formats: assets.formats } : {}) };
  const assetFacts = assets.facts ?? own;
  if (rules && sameFacts(rules.facts, assetFacts)) return [{ ...rules, assets: folders }];
  const assetEntry: PluginWorkspace = { pluginId, facts: assetFacts, ignore: [], copySkip: [], assets: folders };
  return rules ? [rules, assetEntry] : [assetEntry];
}
