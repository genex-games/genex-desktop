/**
 * What a project folder holds, as facts: `unreal-project` at its root, `web-game` in `site/`, and so
 * on, possibly several. A fact says what is there; it picks skills, tools and views and never
 * forbids anything. Genex finds facts by known files (`CORE_FACT_RULES`), an enabled plugin adds
 * its own rules (`detect` in its manifest), and an engine link reads as one
 * (`substrate/game-workspace.ts`). A folder with no facts and nothing of its own has no kind yet:
 * its first message decides (`kindPending`), and until then it is served as a web game would be
 * (`servedFacts`); one of a kind Genex can't name (`kindUnknown`) never is.
 *
 * Renderer-safe: no Node. The walk that lists a folder's files is `substrate/project-facts.ts`.
 */
import { GameEngine } from "./game-engine.ts";
import { PLUGIN_ID } from "./plugin-id.ts";

/** Fact ids Genex itself knows; a plugin's `detect` may add others. Written in records: never rename a value. */
export const CoreFact = {
  WebGame: "web-game",
  UnrealProject: "unreal-project",
  UnrealPlugin: "unreal-plugin",
  GodotProject: "godot-project",
  UnityProject: "unity-project",
  BlenderAssets: "blender-assets",
} as const;
export type CoreFact = (typeof CoreFact)[keyof typeof CoreFact];

/**
 * Where a fact came from, besides a plugin's `detect` (`pluginFactSource`): the core table, an
 * engine link, or the rules of the scaffold recorded in the game's studio.json (`ScaffoldRecord`).
 * Wire values: never rename one.
 */
export const FactSource = { Core: "core", Link: "link", Scaffold: "scaffold" } as const;
export type FactSource = (typeof FactSource)[keyof typeof FactSource];

/** The prefix of a fact found by a plugin's `detect`: `plugin:<id>`. */
const PLUGIN_SOURCE_PREFIX = "plugin:";

/** Where a fact came from: the core table, an engine link, a recorded scaffold, or the `detect` of the plugin named. */
export type ProjectFactSource = FactSource | `plugin:${string}`;

/** The source of a fact a plugin's `detect` found. */
export const pluginFactSource = (pluginId: string): ProjectFactSource => `${PLUGIN_SOURCE_PREFIX}${pluginId}`;

/**
 * One thing a folder holds. `path` is POSIX and relative to the game, `"."` for its root; a link's
 * fact may be absolute when its project lies outside the folder.
 */
export interface ProjectFact {
  id: string;
  path: string;
  source: ProjectFactSource;
}

/** A fact as scope predicates take it: what and where, whoever found it. */
export type FactRef = Pick<ProjectFact, "id" | "path">;

/**
 * A rule that finds a fact by the files a folder holds (a plugin manifest's `detect` entry). `files`
 * and `notUnder` are globs in the grammar `isFileGlob` / `isFolderGlob` accept.
 */
export interface FactRule {
  fact: string;
  files: string[];
  notUnder?: string[];
}

/** A rule with the source its facts carry. */
export interface SourcedFactRule {
  rule: FactRule;
  source: ProjectFactSource;
}

/**
 * Folders the walk never enters besides hidden ones: dependencies, and what engines write while
 * they run (Unreal's Saved/Intermediate/DerivedDataCache/Binaries, Unity's Library/Temp/Logs,
 * .NET's obj). They say nothing about what the project is and can hold many thousands of files.
 * The Assets tab's walk of a whole game folder skips them too.
 */
export const NOT_WALKED: ReadonlySet<string> = new Set([
  "node_modules",
  "Saved",
  "Intermediate",
  "DerivedDataCache",
  "Binaries",
  "Library",
  "Temp",
  "Logs",
  "obj",
]);

/** A fact id: lowercase, starting with a letter, letters, digits and dashes, at most 40 characters. */
export const FACT_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** Whether `value` is a well-formed fact id. */
export const isFactId = (value: unknown): value is string => typeof value === "string" && FACT_ID.test(value);

/**
 * Where Genex never looks for a web game: build output, dependencies, vendored copies and Unity's
 * WebGL templates, whose index.html is a page Unity fills in at build time, not a game.
 */
const NOT_A_WEB_GAME = ["**/node_modules/", "**/dist/", "**/build/", "**/out/", "**/vendor/", "**/WebGLTemplates/"];

/** The kinds Genex knows by their files, before any plugin. */
export const CORE_FACT_RULES: readonly FactRule[] = [
  { fact: CoreFact.WebGame, files: ["**/index.html"], notUnder: NOT_A_WEB_GAME },
  { fact: CoreFact.UnrealProject, files: ["**/*.uproject"] },
  // A .uplugin inside a project's Plugins/ belongs to that project (every Genex Unreal game holds
  // the Genex editor helper there), so it never makes a plugin project.
  { fact: CoreFact.UnrealPlugin, files: ["**/*.uplugin"], notUnder: ["**/Plugins/"] },
  { fact: CoreFact.GodotProject, files: ["**/project.godot"] },
  { fact: CoreFact.UnityProject, files: ["**/ProjectSettings/ProjectVersion.txt"] },
  { fact: CoreFact.BlenderAssets, files: ["**/*.blend"] },
];

/** The glob grammar's limits. */
const GLOB = {
  MaxChars: 120,
  Chars: /^[A-Za-z0-9._*/-]+$/,
  AnyDepth: "**/",
} as const;

/** The root of a game, as a fact's path spells it. */
const ROOT = ".";

/**
 * Whether `glob` is a file glob: an optional leading `**` + `/` (any depth, including none), then
 * `/`-separated segments where `*` matches within a segment. Plain characters only, no `..` or `.`
 * segment, no leading `/`, no empty segment, `**` nowhere else.
 */
export function isFileGlob(glob: unknown): glob is string {
  if (typeof glob !== "string" || glob.length > GLOB.MaxChars || !GLOB.Chars.test(glob)) return false;
  const rest = glob.startsWith(GLOB.AnyDepth) ? glob.slice(GLOB.AnyDepth.length) : glob;
  if (!rest || rest.includes("**")) return false;
  return rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Whether `glob` names a folder: a file glob followed by `/`. */
export const isFolderGlob = (glob: unknown): glob is string =>
  typeof glob === "string" && glob.endsWith("/") && isFileGlob(glob.slice(0, -1));

/** A glob taken apart: whether it matches at any depth, and one matcher per segment. */
interface ParsedGlob {
  anyDepth: boolean;
  segments: RegExp[];
}

function parseGlob(glob: string): ParsedGlob {
  const anyDepth = glob.startsWith(GLOB.AnyDepth);
  const rest = (anyDepth ? glob.slice(GLOB.AnyDepth.length) : glob).replace(/\/$/, "");
  const segments = rest.split("/").map((segment) => {
    const pattern = segment.replace(/[.+?^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${pattern}$`);
  });
  return { anyDepth, segments };
}

/** How many leading segments of `parts` lie before the glob's match, or -1 when it does not match. */
function matchedPrefix(parts: readonly string[], glob: ParsedGlob): number {
  const prefix = parts.length - glob.segments.length;
  if (prefix < 0 || (!glob.anyDepth && prefix !== 0)) return -1;
  return glob.segments.every((segment, i) => segment.test(parts[prefix + i] ?? "")) ? prefix : -1;
}

/**
 * Whether a game-relative POSIX path is a file glob's file or, for a folder glob, that folder or a
 * path inside it: the one matcher the facts use. A glob outside the grammar matches nothing.
 */
export function globMatches(rel: string, glob: string): boolean {
  const folder = isFolderGlob(glob);
  if (!folder && !isFileGlob(glob)) return false;
  const parts = rel.split("/");
  const parsed = parseGlob(glob);
  if (!folder) return matchedPrefix(parts, parsed) >= 0;
  for (let depth = 1; depth <= parts.length; depth++) {
    if (matchedPrefix(parts.slice(0, depth), parsed) >= 0) return true;
  }
  return false;
}

/**
 * Whether a game-relative POSIX path is the file of one of `globs`, each parsed once: the files a
 * walk keeps for these globs. A folder glob, or one outside the grammar, matches nothing.
 */
export function anyFileGlob(globs: readonly string[]): (rel: string) => boolean {
  const parsed = globs.filter(isFileGlob).map(parseGlob);
  return (rel) => {
    const parts = rel.split("/");
    return parsed.some((glob) => matchedPrefix(parts, glob) >= 0);
  };
}

/** Whether a file (by its segments) lies inside a folder some folder glob names. */
function isUnder(parts: readonly string[], folders: readonly ParsedGlob[]): boolean {
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = parts.slice(0, depth);
    if (folders.some((glob) => matchedPrefix(folder, glob) >= 0)) return true;
  }
  return false;
}

/** An absolute fact path (a link to a project outside the game): no folder of the game is above it. */
const ABSOLUTE = /^([A-Za-z]:)?[\\/]/;

/** Whether `ancestor` is a folder strictly above `below`, both as fact paths. */
function isStrictlyAbove(ancestor: string, below: string): boolean {
  if (ancestor === below || ABSOLUTE.test(below)) return false;
  return ancestor === ROOT || below.startsWith(`${ancestor}/`);
}

/** Facts ordered by path, then id. */
function byPathThenId(a: FactRef, b: FactRef): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Facts in their one listed form: each `(id, path)` once (the first one wins, so put the facts
 * whose source should be kept first), none below a folder that already has the same id, sorted by
 * path then id.
 */
export function settleFacts(facts: readonly ProjectFact[]): ProjectFact[] {
  const unique: ProjectFact[] = [];
  for (const fact of facts) {
    if (!unique.some((kept) => kept.id === fact.id && kept.path === fact.path)) unique.push(fact);
  }
  const outer = unique.filter(
    (fact) => !unique.some((other) => other.id === fact.id && isStrictlyAbove(other.path, fact.path)),
  );
  return outer.sort(byPathThenId);
}

/** The fact one file gives under one rule, or undefined. */
function factOfFile(
  parts: readonly string[],
  files: readonly ParsedGlob[],
  notUnder: readonly ParsedGlob[],
): string | undefined {
  if (isUnder(parts, notUnder)) return undefined;
  for (const glob of files) {
    const prefix = matchedPrefix(parts, glob);
    if (prefix >= 0) return prefix === 0 ? ROOT : parts.slice(0, prefix).join("/");
  }
  return undefined;
}

/**
 * The facts a list of files gives (POSIX paths relative to the game), before they are settled: each
 * rule's matches in rule order, minus any under one of its `notUnder` folders. A fact's path is the
 * match's folder minus the glob's own folders (`a/ProjectSettings/ProjectVersion.txt` gives `a`).
 */
export function foundFacts(files: readonly string[], rules: readonly SourcedFactRule[]): ProjectFact[] {
  const found: ProjectFact[] = [];
  const split = files.map((file) => file.split("/"));
  for (const { rule, source } of rules) {
    const globs = rule.files.map(parseGlob);
    const notUnder = (rule.notUnder ?? []).map(parseGlob);
    for (const parts of split) {
      const at = factOfFile(parts, globs, notUnder);
      if (at !== undefined) found.push({ id: rule.fact, path: at, source });
    }
  }
  return found;
}

/**
 * The facts a list of files gives (`foundFacts`), settled (`settleFacts`; earlier rules win a tie,
 * so the core table goes first).
 */
export function factsOfFiles(files: readonly string[], rules: readonly SourcedFactRule[]): ProjectFact[] {
  return settleFacts(foundFacts(files, rules));
}

/** Where a game engine puts the game's web version (Godot's web export, Unity's WebGL build): `web/` at its root. */
const ENGINE_WEB_FOLDER = "web";

/** Whether a folder of the game is `ENGINE_WEB_FOLDER`, in any case: `Web/` is the same folder on macOS and Windows. */
export const isEngineWebFolder = (folder: string): boolean => folder.toLowerCase() === ENGINE_WEB_FOLDER;

/** Whether a fact sits in `ENGINE_WEB_FOLDER`. */
const inEngineWebFolder = (fact: FactRef): boolean => isEngineWebFolder(fact.path);

/** The kinds whose engine exports the game for the web into `ENGINE_WEB_FOLDER`. */
const WEB_EXPORTING: ReadonlySet<string> = new Set<string>([CoreFact.UnityProject, CoreFact.GodotProject]);

/**
 * The folder of a Unity or Godot game's web version (`withEngineWebVersion`), the build its engine
 * makes again from the project; null for any other game, and for one whose root page is its own.
 */
export function engineWebFolderOf(game: GameKind): string | null {
  const exports = game.facts.some((fact) => WEB_EXPORTING.has(fact.id));
  const webVersion = game.facts.find((fact) => fact.id === CoreFact.WebGame && inEngineWebFolder(fact));
  return exports && webVersion ? webVersion.path : null;
}

/**
 * A game as its skills read it: a Unity or Godot game's web version left out, since it is the build
 * its engine exports and no web game's know-how fits it. Any other game is as it is.
 */
export function withoutEngineWebVersion(game: GameKind): GameKind {
  const web = engineWebFolderOf(game);
  if (web === null) return game;
  return { ...game, facts: game.facts.filter((fact) => fact.id !== CoreFact.WebGame || fact.path !== web) };
}

/**
 * A Unity or Godot game's web version among `found` (the folder's facts before settling, which drops
 * a web game below another): its web game in `ENGINE_WEB_FOLDER`; null for any other game.
 */
export function engineWebVersion(listed: readonly FactRef[], found: readonly ProjectFact[]): ProjectFact | null {
  if (!listed.some((fact) => WEB_EXPORTING.has(fact.id))) return null;
  return found.find((fact) => fact.id === CoreFact.WebGame && inEngineWebFolder(fact)) ?? null;
}

/**
 * A Unity or Godot game's listed facts with its web version (`engineWebVersion`) as its web game. A
 * web game at the root beside it is left out when it is Genex's web starter page nobody built on
 * (`starterAtRoot`), whether or not the game's port was recorded; a root page of the folder's own,
 * or a web game built from the starter, keeps its place and the facts are returned as they are, as
 * are any other game's.
 */
export function withEngineWebVersion(
  listed: readonly ProjectFact[],
  found: readonly ProjectFact[],
  starterAtRoot: boolean,
): ProjectFact[] {
  const webVersion = engineWebVersion(listed, found);
  const ownRootPage = hasFact(listed, CoreFact.WebGame, ROOT) && !starterAtRoot;
  if (!webVersion || ownRootPage) return [...listed];
  const besides = listed.filter((fact) => !(fact.id === CoreFact.WebGame && fact.path === ROOT));
  return settleFacts([...besides, webVersion]);
}

/**
 * The starters Genex writes itself into a folder with no kind yet (`game.start`, `game.scaffold`'s
 * `kind`). An older caller's `"studio-template"` is read as Web. Wire values: never rename one.
 */
export const ProjectStarter = { Web: "web" } as const;
export type ProjectStarter = (typeof ProjectStarter)[keyof typeof ProjectStarter];

/** What older callers of `game.scaffold` name the web starter. */
const LEGACY_WEB_STARTER = "studio-template";

/** The starter a `game.scaffold` `kind` asks for: none for no kind, undefined for one Genex can't write. */
export function starterOfKind(kind: unknown): ProjectStarter | null | undefined {
  if (kind === undefined || kind === null) return null;
  if (kind === ProjectStarter.Web || kind === LEGACY_WEB_STARTER) return ProjectStarter.Web;
  return undefined;
}

/** Whether `value` is a starter Genex writes. */
export const isProjectStarter = (value: unknown): value is ProjectStarter =>
  Object.values(ProjectStarter).includes(value as ProjectStarter);

/**
 * What a folder with no facts holds besides Genex's bookkeeping and hidden files (`GameProject.holds`):
 * nothing, loose notes only, files of its own of a kind no rule knows, or nobody knows because the
 * folder could not be read. Only the first two have no kind yet. Wire values: never rename one.
 */
export const FolderHolds = {
  Nothing: "nothing",
  Notes: "notes",
  OwnFiles: "own-files",
  Unreadable: "unreadable",
} as const;
export type FolderHolds = (typeof FolderHolds)[keyof typeof FolderHolds];

/** A game as the kind reads take it: its facts and, when it has none, what its folder holds. */
export interface GameKind {
  facts: readonly FactRef[];
  holds?: FolderHolds | undefined;
}

/**
 * Whether a game with no facts is of a kind Genex can't name: its folder holds files of its own no
 * rule knows (a Pygame or Bevy project, say), or could not be read. It is never handed a starter.
 */
export const kindUnknown = (game: GameKind): boolean =>
  game.facts.length === 0 && (game.holds === FolderHolds.OwnFiles || game.holds === FolderHolds.Unreadable);

/**
 * Whether a game has no kind yet: no facts, and nothing of its own (an empty folder or one of notes),
 * so its first message decides. A game listed without `holds` is read by its facts alone.
 */
export const kindPending = (game: GameKind): boolean => game.facts.length === 0 && !kindUnknown(game);

/** Whether the facts hold `id` (at `path`, when one is named). */
export function hasFact(facts: readonly FactRef[], id: string, path?: string): boolean {
  return facts.some((fact) => fact.id === id && (path === undefined || fact.path === path));
}

/** A web game at the root: what a folder with no kind yet is served as. */
const WEB_AT_ROOT: FactRef = { id: CoreFact.WebGame, path: ROOT };

/**
 * The facts a game is served by: its own; a web game at its root while it has no kind yet
 * (`kindPending`); none for a folder of a kind Genex can't name (`kindUnknown`), which is never
 * served as a web game.
 */
export function servedFacts(game: GameKind): FactRef[] {
  if (game.facts.length > 0) return [...game.facts];
  return kindUnknown(game) ? [] : [WEB_AT_ROOT];
}

/** Whether a game is served as a web game at its root (one with no kind yet is): what Publish exports. */
export const servedAsWebGame = (game: GameKind): boolean => hasFact(servedFacts(game), CoreFact.WebGame, ROOT);

/**
 * How a Loop works on a project: the web method (an integration copy, builders, judges, landing) or
 * in place. Persisted in `autopilot_started.profile`: never rename a value.
 */
export const LoopProfile = { Web: "web", Open: "open" } as const;
export type LoopProfile = (typeof LoopProfile)[keyof typeof LoopProfile];

/** The facts a web Loop's folder may hold beside its page. */
export const WEB_LOOP_FACTS: ReadonlySet<string> = new Set<string>([CoreFact.WebGame, CoreFact.BlenderAssets]);

/**
 * The profile a Loop on a game takes: web when a web game is served at its root (one with no kind
 * yet is) and every fact it is served by is one a web Loop's folder may hold; open otherwise (an
 * engine's project or plugin anywhere, a plugin's kind, or no web game at the root).
 */
export function loopProfileOf(game: GameKind): LoopProfile {
  const webOnly = servedFacts(game).every((fact) => WEB_LOOP_FACTS.has(fact.id));
  return servedAsWebGame(game) && webOnly ? LoopProfile.Web : LoopProfile.Open;
}

/**
 * A game as a scope reads it: one given by its facts alone (`[]`: no kind yet), by its facts and
 * what its folder holds, or by an engine of the older vocabulary (its fact at the root).
 */
export function gameKindOf(scope: readonly FactRef[] | GameKind | GameEngine): GameKind {
  if (typeof scope === "string") return { facts: factsOfEngine(scope) };
  return "facts" in scope ? scope : { facts: scope };
}

/**
 * Whether something scoped to fact ids (a tool, a skill, a connector, a hook) reaches a game: one
 * that names no scope reaches every game; otherwise one of the game's served facts must be named.
 */
export function scopeReaches(scope: readonly string[] | undefined, game: GameKind): boolean {
  if (!scope) return true;
  return servedFacts(game).some((fact) => scope.includes(fact.id));
}

/**
 * The folders of a game a scope applies to, sorted: the root when it names no scope, else the paths
 * of the served facts it names (none when it does not reach the game).
 */
export function scopePaths(scope: readonly string[] | undefined, game: GameKind): string[] {
  if (!scope) return [ROOT];
  const paths = servedFacts(game)
    .filter((fact) => scope.includes(fact.id))
    .map((fact) => fact.path);
  return [...new Set(paths)].sort();
}

/** The fact each engine of the older engine vocabulary stands for (a skill's `engines`, a game's link). */
export const ENGINE_FACT: Readonly<Record<GameEngine, CoreFact>> = {
  [GameEngine.Web]: CoreFact.WebGame,
  [GameEngine.Unreal]: CoreFact.UnrealProject,
  [GameEngine.Godot]: CoreFact.GodotProject,
};

/** The facts an engine of the older vocabulary stands for: its fact at the game's root. */
export function factsOfEngine(engine: GameEngine): ProjectFact[] {
  return [{ id: ENGINE_FACT[engine], path: ROOT, source: FactSource.Core }];
}

/** The most facts a `portedFrom` record keeps, and the longest path one may name. */
const PORTED_FROM = { MaxFacts: 32, MaxPathChars: 1024 } as const;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

const FACT_SOURCES: ReadonlySet<unknown> = new Set(Object.values(FactSource));

/** Whether `value` is a fact source: core, link, scaffold, or `plugin:<id>`. */
function isFactSource(value: unknown): value is ProjectFactSource {
  if (FACT_SOURCES.has(value)) return true;
  if (typeof value !== "string" || !value.startsWith(PLUGIN_SOURCE_PREFIX)) return false;
  return PLUGIN_ID.test(value.slice(PLUGIN_SOURCE_PREFIX.length));
}

/** Whether `value` is a fact path spelled plainly: no control characters and no `..` part. */
function isFactPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > PORTED_FROM.MaxPathChars) return false;
  if (CONTROL.test(value)) return false;
  return !value.split(/[\\/]/).some((part) => part === "..");
}

/** One recorded fact by shape, or undefined; a missing or unknown source reads as the core table's. */
function parseFact(raw: unknown): ProjectFact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!isFactId(record.id) || !isFactPath(record.path)) return undefined;
  return { id: record.id, path: record.path, source: isFactSource(record.source) ? record.source : FactSource.Core };
}

/**
 * The facts a studio.json's `portedFrom` records (what a port replaced, kept as the reference), by
 * shape only: well-formed entries, at most 32; anything else is dropped.
 */
export function parsePortedFrom(raw: unknown): ProjectFact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, PORTED_FROM.MaxFacts)
    .map(parseFact)
    .filter((fact): fact is ProjectFact => fact !== undefined);
}

/** How much one rule may name: files to match, and folders whose files it skips. */
export const FACT_RULE_LIMIT = { Files: 8, NotUnder: 8 } as const;

/** A list of at most `max` (and at least `min`) strings, each passing `valid`, as a copy; else undefined. */
function globList(value: unknown, min: number, max: number, valid: (glob: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > max) return undefined;
  return value.every(valid) ? [...(value as string[])] : undefined;
}

/**
 * One fact rule by shape (`FactRule`, the `detect` grammar): a fact id, 1-8 file globs and at most 8
 * folder globs to skip; null for anything else, a glob that names a parent or an absolute path
 * included.
 */
export function parseFactRule(raw: unknown): FactRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const files = globList(record.files, 1, FACT_RULE_LIMIT.Files, isFileGlob);
  if (!isFactId(record.fact) || !files) return null;
  if (record.notUnder === undefined) return { fact: record.fact, files };
  const notUnder = globList(record.notUnder, 0, FACT_RULE_LIMIT.NotUnder, isFolderGlob);
  return notUnder ? { fact: record.fact, files, notUnder } : null;
}

/** A scaffold's limits: its label's length and how many rules it adds. */
export const SCAFFOLD_LIMIT = { LabelChars: 40, Rules: 4 } as const;

/**
 * What studio.json records of the scaffold a plugin's tool made the game with (`scaffold`): the
 * plugin, the scaffold's id and label, and the rules that add the facts its kind holds
 * (`FactSource.Scaffold`); they keep finding them while the plugin is off.
 */
export interface ScaffoldRecord {
  plugin: string;
  id: string;
  label: string;
  facts: FactRule[];
}

/** Whether `value` is a scaffold label: text of 1-40 characters with no control character. */
export const isScaffoldLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= SCAFFOLD_LIMIT.LabelChars &&
  !CONTROL.test(value);

/**
 * A studio.json's scaffold record by shape only: a plugin id, a fact id, a label and at most four
 * well-formed rules, else null. A record that fails any check adds nothing: its rules are never
 * followed in part.
 */
export function parseScaffoldRecord(raw: unknown): ScaffoldRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const plugin = typeof record.plugin === "string" && PLUGIN_ID.test(record.plugin) ? record.plugin : null;
  if (!plugin || !isFactId(record.id) || !isScaffoldLabel(record.label)) return null;
  if (!Array.isArray(record.facts) || record.facts.length > SCAFFOLD_LIMIT.Rules) return null;
  const facts = record.facts.map(parseFactRule);
  if (facts.some((rule) => rule === null)) return null;
  return { plugin, id: record.id, label: record.label, facts: facts as FactRule[] };
}
