/**
 * What a project's history leaves out and where its assets live, by the facts its folder holds
 * (`shared/project-facts.ts`): Genex's own table (`CORE_WORKSPACE`) and the enabled plugins'
 * `workspace` and `assets` sections. Every pattern is placed at its fact's folder, so a Unity
 * project's `Library/` never hides a folder of that name inside its `Assets/`, and a pattern
 * starting `**` + `/` reaches any depth below that folder. Patterns use the facts' one glob grammar
 * (`isFileGlob`, `isFolderGlob`).
 *
 * Renderer-safe: no Node. The ignore file is written by `substrate/nested-repos.ts`.
 */
import { assetExtension, listsModels, MEDIA_FORMATS, MODEL_COMPANION_FORMATS } from "./game-assets.ts";
import {
  CoreFact,
  type FactRef,
  type GameKind,
  globMatches,
  isFileGlob,
  isFolderGlob,
  NOT_WALKED,
  servedAsWebGame,
} from "./project-facts.ts";

/** A folder of assets, relative to its fact's folder (`"."` for it); `formats` are lowercase extensions, absent for any file. */
export interface AssetFolder {
  folder: string;
  formats?: readonly string[];
}

/** What one fact's folder leaves out of history and of writers' copies, and where its assets live. */
export interface FactWorkspace {
  ignore: readonly string[];
  copySkip: readonly string[];
  assets: readonly AssetFolder[];
  /**
   * Where files a plugin delivers (generated assets) land, relative to the fact's folder, for a
   * kind whose engine reads only its own project's folder; absent keeps Genex's default (the game's root).
   */
  deliver?: string;
}

/** The game's root, as a fact's path spells it. */
const ROOT = ".";
/** A pattern's any-depth prefix. */
const ANY_DEPTH = "**/";
/** The most segments a workspace pattern may have. */
const MAX_PATTERN_SEGMENTS = 6;
/** The longest fact folder rules are placed at. */
const MAX_BASE_CHARS = 1024;
/** Where Genex keeps a game's mood-board stills, at its root: never loaded as game assets. */
export const REFERENCES_FOLDER = "references";
/** Build output every game's ignore rules leave out (`substrate/nested-repos.ts`), at any depth. */
export const BUILD_OUTPUT_FOLDERS: readonly string[] = ["dist", "output"];
/**
 * Names of Genex's own bookkeeping, and Claude Code's folder a session loads, which no pattern or
 * asset folder may name. Lowercase: names are compared as a case-insensitive disk reads them (`folderName`).
 */
const BOOKKEEPING: readonly string[] = ["studio.json", ".gitignore", ".git", ".studio", ".claude", REFERENCES_FOLDER];
/** Folders a walk of a whole game folder never enters, at any depth: dependencies, engine scratch, build output. */
const NOT_ASSET_FOLDERS: ReadonlySet<string> = new Set(
  [...NOT_WALKED, ...BUILD_OUTPUT_FOLDERS].map((name) => name.toLowerCase()),
);
/** A name's trailing dots and spaces, which Windows drops when it opens the name. */
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;
/** A pattern no line of the person's can be: what a segment that cannot be compiled matches. */
const MATCHES_NOTHING = /(?!)/;
/** A segment of a fact folder rules may be placed at: plain characters and inner spaces. */
const BASE_SEGMENT = /^[A-Za-z0-9._-]([A-Za-z0-9._ -]*[A-Za-z0-9._-])?$/;

/** What each kind Genex knows leaves out of history, and where its assets live. */
export const CORE_WORKSPACE = {
  // The generic rules (`substrate/nested-repos.ts`) are the web rules. Its asset folders list media
  // only: data a script writes there (tiles, manifests, notes) is the game's input, not an asset.
  [CoreFact.WebGame]: {
    ignore: [],
    copySkip: [],
    assets: [
      { folder: "assets", formats: MEDIA_FORMATS },
      { folder: "public/assets", formats: MEDIA_FORMATS },
    ],
  },
  [CoreFact.UnrealProject]: {
    ignore: [
      "Saved/",
      "Intermediate/",
      "DerivedDataCache/",
      "Binaries/",
      "Plugins/*/Intermediate/",
      "Plugins/*/Binaries/",
    ],
    copySkip: [],
    // Unreal's own packages (.uasset, .umap) have no preview in Genex: Assets shows the media agents
    // bring into the game's asset folders instead.
    assets: [],
  },
  [CoreFact.UnrealPlugin]: {
    ignore: ["Intermediate/", "Binaries/"],
    copySkip: [],
    assets: [],
  },
  // Godot's `*.import` files stay in history: the project needs them to open.
  // Delivered files land in the project, where `res://assets/...` reaches them.
  [CoreFact.GodotProject]: {
    ignore: [".godot/"],
    copySkip: [],
    assets: [{ folder: ROOT, formats: MEDIA_FORMATS }],
    deliver: ROOT,
  },
  [CoreFact.UnityProject]: {
    // Builds/ is where agents build players: a player is output, never the game's history.
    ignore: ["Library/", "Temp/", "Logs/", "obj/", "UserSettings/", "Builds/"],
    copySkip: [],
    assets: [{ folder: "Assets", formats: MEDIA_FORMATS }],
  },
  [CoreFact.BlenderAssets]: {
    ignore: ["**/*.blend1", "**/*.blend2"],
    copySkip: [],
    assets: [{ folder: ROOT, formats: [...new Set(["blend", ...MEDIA_FORMATS])] }],
  },
} satisfies Record<CoreFact, FactWorkspace>;

/** One enabled plugin's `workspace` and `assets`, as the registry hands them over; `facts` already defaulted. */
export interface PluginWorkspace {
  pluginId: string;
  facts: string[];
  ignore: string[];
  copySkip: string[];
  assets?: { folders: string[]; formats?: string[] };
}

/** A pattern placed at a fact's folder (`base`, `"."` for the game's root). */
export interface PlacedRule {
  base: string;
  pattern: string;
}

/** A pattern's segments, without its any-depth prefix and its folder slash. */
function patternSegments(text: string): string[] {
  const rest = text.startsWith(ANY_DEPTH) ? text.slice(ANY_DEPTH.length) : text;
  return rest.replace(/\/$/, "").split("/");
}

/** Whether a segment is wildcards only (`*`, `**`). */
const onlyWildcards = (segment: string): boolean => /^\*+$/.test(segment);

/**
 * A file or folder name as a case-insensitive disk and Windows open it: in any case, without
 * trailing dots or spaces (`substrate/paths.ts` reads `.git` and `.claude` the same way).
 */
const folderName = (name: string): string => name.replace(TRAILING_DOTS_AND_SPACES, "").toLowerCase();

/** Whether a name is one of Genex's bookkeeping names, in any spelling a disk opens as one. */
const isBookkeeping = (name: string): boolean => BOOKKEEPING.includes(folderName(name));

/** Whether a pattern segment, as the glob grammar reads it, matches one of Genex's bookkeeping names in any case. */
function reachesBookkeeping(segment: string): boolean {
  const glob = folderName(segment);
  const matcher = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  return BOOKKEEPING.some((name) => matcher.test(name));
}

/**
 * Whether `text` is a workspace pattern: a file or folder glob of at most six segments that is
 * not only `*` (it would leave everything out) and can reach none of Genex's own bookkeeping. The
 * first segment can meet the game's root, and with an any-depth prefix so can every segment, so a
 * wildcard there that matches a bookkeeping name (`.*`, `*.json`) is refused like the name itself.
 */
export function isWorkspacePattern(text: unknown): text is string {
  if (!isFileGlob(text) && !isFolderGlob(text)) return false;
  const segments = patternSegments(text);
  if (segments.length > MAX_PATTERN_SEGMENTS) return false;
  if (segments.every(onlyWildcards)) return false;
  if (segments.some(isBookkeeping)) return false;
  const atRoot = text.startsWith(ANY_DEPTH) ? segments : segments.slice(0, 1);
  return !atRoot.some((segment) => !onlyWildcards(segment) && reachesBookkeeping(segment));
}

/**
 * Whether rules may be placed at a fact's folder: the root, or plain segments (inner spaces
 * allowed) with no `.` or `..` part. An absolute path (a link to a project outside the game) is not.
 */
export function isPlaceableBase(base: unknown): base is string {
  if (base === ROOT) return true;
  if (typeof base !== "string" || !base || base.length > MAX_BASE_CHARS) return false;
  return base.split("/").every((segment) => segment !== "." && segment !== ".." && BASE_SEGMENT.test(segment));
}

/**
 * Whether a plugin may name `folder` as an asset folder: the fact's folder itself (`"."`), or a
 * placeable folder with no hidden part and no part named like Genex's bookkeeping.
 */
export function isAssetFolderName(folder: unknown): folder is string {
  if (folder === ROOT) return true;
  if (!isPlaceableBase(folder)) return false;
  return folder.split("/").every((segment) => !segment.startsWith(".") && !isBookkeeping(segment));
}

/** Whether a fact's id is one of Genex's own kinds. */
const isCoreFact = (id: string): id is CoreFact => Object.hasOwn(CORE_WORKSPACE, id);

/** Plugins in id order, so their rules and folders come in the same order whatever the registry's. */
const byPluginId = (plugins: readonly PluginWorkspace[]): PluginWorkspace[] =>
  [...plugins].sort((a, b) => (a.pluginId < b.pluginId ? -1 : Number(a.pluginId > b.pluginId)));

/** Patterns placed at every placeable fact: Genex's table first, then plugins in id order, each pair once. */
function placeRules(
  facts: readonly FactRef[],
  plugins: readonly PluginWorkspace[],
  pick: (from: Pick<FactWorkspace, "ignore" | "copySkip">) => readonly string[],
): PlacedRule[] {
  const placed: PlacedRule[] = [];
  const place = (base: string, patterns: readonly string[]) => {
    for (const pattern of patterns) {
      if (!placed.some((rule) => rule.base === base && rule.pattern === pattern)) placed.push({ base, pattern });
    }
  };
  const bases = facts.filter((fact) => isPlaceableBase(fact.path));
  for (const fact of bases) if (isCoreFact(fact.id)) place(fact.path, pick(CORE_WORKSPACE[fact.id]));
  for (const plugin of byPluginId(plugins)) {
    const patterns = pick(plugin).filter(isWorkspacePattern);
    for (const fact of bases) if (plugin.facts.includes(fact.id)) place(fact.path, patterns);
  }
  return placed;
}

/** What history leaves out of a game with these facts: each fact's ignore patterns at its folder. */
export const ignoreRulesFor = (facts: readonly FactRef[], plugins: readonly PluginWorkspace[]): PlacedRule[] =>
  placeRules(facts, plugins, (from) => from.ignore);

/** What a writer's copy leaves out besides: each fact's copy-skip patterns at its folder. */
export const copySkipRulesFor = (facts: readonly FactRef[], plugins: readonly PluginWorkspace[]): PlacedRule[] =>
  placeRules(facts, plugins, (from) => from.copySkip);

/** Whether a pattern has a `/` before its end: git anchors such a line at the ignore file's folder. */
const hasInnerSlash = (pattern: string): boolean => pattern.replace(/\/$/, "").includes("/");

/**
 * The `.gitignore` line for a placed rule, anchored at its folder: at the root a one-segment pattern
 * gets a leading `/` (`/Saved/`), one with an inner `/` is written as is, and `**` + `/x` is written
 * `x` when `x` has no `/` of its own; at another folder it is `<base>/<pattern>` (`unreal/Saved/`).
 */
export function ignoreLine(rule: PlacedRule): string {
  if (rule.base !== ROOT) return `${rule.base}/${rule.pattern}`;
  if (rule.pattern.startsWith(ANY_DEPTH)) {
    const rest = rule.pattern.slice(ANY_DEPTH.length);
    return hasInnerSlash(rest) ? rule.pattern : rest;
  }
  return hasInnerSlash(rule.pattern) ? rule.pattern : `/${rule.pattern}`;
}

/** The path an ignore line names, and whether it is an exception (`!`); null for a comment or a blank. */
function ignoredPath(line: string): { parts: string[]; negated: boolean } | null {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  const negated = text.startsWith("!");
  const bare = (negated ? text.slice(1) : text)
    .replace(/^(\*\*\/)+/, "")
    .replace(/^\//, "")
    .replace(/\/(\*{1,2})?$/, "");
  return bare ? { parts: bare.split("/"), negated } : null;
}

/** One character inside a RegExp class, escaped where the class would read it otherwise. */
const classChar = (char: string): string => (/[\\\][^-]/.test(char) ? `\\${char}` : char);

/**
 * A `[...]` class of a person's ignore line as a RegExp class: `!` or `^` first negates it, and a
 * range whose end comes before its start matches nothing, as git reads it (`[z-a]` matches no
 * character, `[!z-a]` any).
 */
function lineClass(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const chars = [...(negated ? body.slice(1) : body)];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const from = chars[i] ?? "";
    const to = chars[i + 2];
    if (chars[i + 1] !== "-" || to === undefined) {
      out += classChar(from);
      continue;
    }
    if ((from.codePointAt(0) ?? 0) <= (to.codePointAt(0) ?? 0)) out += `${classChar(from)}-${classChar(to)}`;
    i += 2;
  }
  return `[${negated ? "^" : ""}${out}]`;
}

/**
 * One segment of a person's ignore line as git reads it: `*`, `?` and `[...]` classes. A segment
 * no pattern can be made of matches nothing: it never stops Genex from reading the rest of the file.
 */
function lineSegment(segment: string): RegExp {
  let pattern = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment.charAt(i);
    const close = char === "[" ? segment.indexOf("]", i + 2) : -1;
    if (close > 0) {
      pattern += lineClass(segment.slice(i + 1, close));
      i = close;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+?^${}()|[\]\\-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return MATCHES_NOTHING;
  }
}

/** Whether each of the person's segments matches the line's segment at the same place. */
const segmentsMatch = (said: readonly string[], wanted: readonly string[]): boolean =>
  said.every((segment, i) => lineSegment(segment).test(wanted[i] ?? ""));

/**
 * Whether a person's ignore line already says what `line` (a fact's) would: it names that path in
 * any spelling (`Saved`, `/Saved/`, `Saved/*`, `/[Ss]aved/`, an any-depth prefix) or a folder
 * holding it, or it is an exception of that path or of one inside it (`!Saved/Config/`), which the
 * line would override. A narrower rule of theirs (`Saved/Logs/`) says less; a comment says nothing.
 */
export function saysIgnoreLine(present: string, line: string): boolean {
  const said = ignoredPath(present);
  const wanted = ignoredPath(line);
  if (!said || !wanted) return false;
  const holds = said.parts.length <= wanted.parts.length && segmentsMatch(said.parts, wanted.parts);
  if (holds) return true;
  return said.negated && segmentsMatch(said.parts.slice(0, wanted.parts.length), wanted.parts);
}

/**
 * The path glob a placed rule leaves out, relative to the game: a folder pattern reaches everything
 * in it (`Saved/**`, `unreal/Saved/**`), a file pattern is itself (`**` + `/*.blend1`, `props/**` + `/*.blend1`).
 */
export function ruleGlob(rule: PlacedRule): string {
  const glob = rule.pattern.endsWith("/") ? `${rule.pattern}**` : rule.pattern;
  return rule.base === ROOT ? glob : `${rule.base}/${glob}`;
}

/** Whether a game-relative POSIX path is left out by a placed rule. */
export function ruleMatches(rel: string, rule: PlacedRule): boolean {
  if (rule.base === ROOT) return globMatches(rel, rule.pattern);
  const prefix = `${rule.base}/`;
  return rel.startsWith(prefix) && globMatches(rel.slice(prefix.length), rule.pattern);
}

/** The folders every game keeps assets in, whatever it holds: a web game's own, at the game's root. */
export const DEFAULT_ASSET_FOLDERS: readonly AssetFolder[] = CORE_WORKSPACE[CoreFact.WebGame].assets;

/** A folder inside a fact's folder, relative to the game (`"."` stays the fact's folder). */
function joinFolder(base: string, folder: string): string {
  if (base === ROOT) return folder;
  return folder === ROOT ? base : `${base}/${folder}`;
}

/** Whether two folders are the same folder with the same formats (in any order). */
function sameAssetFolder(a: AssetFolder, b: AssetFolder): boolean {
  if (a.folder !== b.folder) return false;
  const left = new Set(a.formats ?? []);
  const right = new Set(b.formats ?? []);
  const sameKind = (a.formats === undefined) === (b.formats === undefined);
  return sameKind && left.size === right.size && [...left].every((format) => right.has(format));
}

/** A plugin's `assets` section as folders inside one fact's folder; no formats, or none listed, is any file. */
function pluginFolders(base: string, assets: NonNullable<PluginWorkspace["assets"]>): AssetFolder[] {
  const formats = assets.formats?.length ? { formats: assets.formats } : {};
  return assets.folders.filter(isAssetFolderName).map((folder) => ({ folder: joinFolder(base, folder), ...formats }));
}

/** Genex's table's asset folders for one fact, relative to the game. */
const coreFolders = (fact: FactRef): AssetFolder[] =>
  isCoreFact(fact.id)
    ? CORE_WORKSPACE[fact.id].assets.map((folder) => ({ ...folder, folder: joinFolder(fact.path, folder.folder) }))
    : [];

/** One plugin's asset folders at each of these facts it reaches, relative to the game. */
function reachedFolders(plugin: PluginWorkspace, facts: readonly FactRef[]): AssetFolder[] {
  const { assets } = plugin;
  if (!assets) return [];
  return facts.filter((fact) => plugin.facts.includes(fact.id)).flatMap((fact) => pluginFolders(fact.path, assets));
}

/**
 * The folder of a game's web game when it has none at its root: the first web game in a folder of
 * the game (a Godot game's web export in `web/`), which Live plays and Publish puts online in the
 * root's place; null for a game served as a web game at its root, or with none.
 */
export function webFolderOf(game: GameKind): string | null {
  if (servedAsWebGame(game)) return null;
  const inFolder = game.facts.find(
    (fact) => fact.id === CoreFact.WebGame && fact.path !== ROOT && isPlaceableBase(fact.path),
  );
  return inFolder?.path ?? null;
}

/** Whether Publish can put the game online: a web game at its root, or one in a folder of it (`webFolderOf`). */
export const publishesAsWebGame = (game: GameKind): boolean => servedAsWebGame(game) || webFolderOf(game) !== null;

/**
 * The folder, relative to the game, where a plugin's delivered files land for a game with these
 * facts: the folder of the first fact (the root's first) whose kind keeps them in its own project;
 * null keeps Genex's default, as does a web game at the root, which serves the files itself.
 */
export function deliveryFolderFor(facts: readonly FactRef[]): string | null {
  if (facts.some((fact) => fact.id === CoreFact.WebGame && fact.path === ROOT)) return null;
  const bases = facts.filter((fact) => isPlaceableBase(fact.path));
  const ordered = [...bases.filter((fact) => fact.path === ROOT), ...bases.filter((fact) => fact.path !== ROOT)];
  for (const fact of ordered) {
    const workspace: FactWorkspace | undefined = isCoreFact(fact.id) ? CORE_WORKSPACE[fact.id] : undefined;
    const deliver = workspace?.deliver;
    if (deliver !== undefined) return joinFolder(fact.path, deliver);
  }
  return null;
}

/**
 * Where a game with these facts keeps its assets: today's folders (`DEFAULT_ASSET_FOLDERS`) always,
 * then each fact's folders from Genex's table, then the enabled plugins' folders at the facts they
 * reach (in id order). A folder is kept once for each distinct set of formats.
 */
export function assetFoldersFor(facts: readonly FactRef[], plugins: readonly PluginWorkspace[]): AssetFolder[] {
  const bases = facts.filter((fact) => isPlaceableBase(fact.path));
  const found = [
    ...DEFAULT_ASSET_FOLDERS,
    ...bases.flatMap(coreFolders),
    ...byPluginId(plugins).flatMap((plugin) => reachedFolders(plugin, bases)),
  ];
  return found.filter((folder, i) => found.findIndex((kept) => sameAssetFolder(kept, folder)) === i);
}

/**
 * Whether a walk of a whole game folder enters the folder `name` inside `parent` (game-relative,
 * `""` for the root): never a hidden one, dependencies, engine scratch or build output, nor Genex's
 * mood boards at the root, in any spelling a case-insensitive disk opens as one of those.
 */
export function wholeFolderEnters(parent: string, name: string): boolean {
  const opened = folderName(name);
  if (name.startsWith(".") || NOT_ASSET_FOLDERS.has(opened)) return false;
  return parent !== "" || opened !== REFERENCES_FOLDER;
}

/** Whether a game-relative POSIX path is inside a folder, as the walk of that folder reaches it. */
function isInside(file: string, folder: string): boolean {
  if (folder !== ROOT) return file.startsWith(`${folder}/`);
  const parts = file.split("/").slice(0, -1);
  return parts.every((name, i) => wholeFolderEnters(parts.slice(0, i).join("/"), name));
}

/** Whether a folder lists a format: any when it names none, and a model's companions beside its models. */
function folderLists(folder: AssetFolder, format: string): boolean {
  if (!folder.formats || folder.formats.includes(format)) return true;
  return MODEL_COMPANION_FORMATS.includes(format) && listsModels(folder.formats);
}

/**
 * Whether a game-relative file is an asset: inside one of the folders, as its walk reaches it, and,
 * when the folder names formats, of one of them or a model's companion. A hidden part is never one.
 */
export function isAssetPath(file: string, folders: readonly AssetFolder[]): boolean {
  if (typeof file !== "string" || !file) return false;
  if (file.split("/").some((part) => part.startsWith("."))) return false;
  const format = assetExtension(file);
  return folders.some((folder) => isInside(file, folder.folder) && folderLists(folder, format));
}
