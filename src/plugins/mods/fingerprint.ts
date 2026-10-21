/**
 * What a game's folder says about it, read from the names of a few hundred files near its top:
 * the engine it was made with (so the agent picks the community's route) and any anti-cheat it
 * ships (so Genex makes no mod for it). Only names are read, never a file's bytes; a top entry that
 * is a link is never looked into, and the walk stops after a fixed number of names.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** The engines Genex tells apart by their files. Wire values: the agent reads them in `find-games`. */
export const BuiltWith = {
  Unity: "unity",
  UnityIl2cpp: "unity-il2cpp",
  Unreal: "unreal",
  Godot: "godot",
  Love: "love",
  GameMaker: "gamemaker",
  RenPy: "renpy",
  RpgMaker: "rpgmaker",
  DotNet: "dotnet",
  Java: "java",
} as const;
export type BuiltWith = (typeof BuiltWith)[keyof typeof BuiltWith];

/** Each engine as people name it, for the agent and the panel. */
export const BUILT_WITH_NAME: Readonly<Record<BuiltWith, string>> = {
  [BuiltWith.Unity]: "Unity (Mono)",
  [BuiltWith.UnityIl2cpp]: "Unity (IL2CPP)",
  [BuiltWith.Unreal]: "Unreal Engine",
  [BuiltWith.Godot]: "Godot",
  [BuiltWith.Love]: "LÖVE",
  [BuiltWith.GameMaker]: "GameMaker",
  [BuiltWith.RenPy]: "Ren'Py",
  [BuiltWith.RpgMaker]: "RPG Maker",
  [BuiltWith.DotNet]: ".NET (XNA, FNA or MonoGame)",
  [BuiltWith.Java]: "Java",
};

/** What a game's folder says: its engine, when Genex can tell, and the anti-cheat it ships. */
export interface Fingerprint {
  builtWith: BuiltWith | null;
  antiCheat: string[];
}

/** The most names one fingerprint reads: a game's top folders hold a few hundred. */
const MAX_NAMES = 4000;

/** Anti-cheat by a file or folder name it always ships with (lowercase), and how people name it. */
const ANTI_CHEAT: ReadonlyArray<[RegExp, string]> = [
  [/^easyanticheat/, "Easy Anti-Cheat"],
  [/^start_protected_game\.exe$/, "Easy Anti-Cheat"],
  [/^battleye$|^beservice/, "BattlEye"],
  [/^mhyprot/, "mhyprot"],
  [/^xigncode/, "XIGNCODE3"],
  [/^gameguard$|^npgg/, "nProtect GameGuard"],
  [/^anticheatexpert$|^ace-base/, "Anti-Cheat Expert"],
  [/^vgk\.sys$|^vanguard$/, "Vanguard"],
];

/** One folder's entries, never through a link; empty when it can't be read. */
async function entries(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** The folders inside a Mac app bundle where an engine leaves its files. */
const BUNDLE_FOLDERS: readonly string[][] = [
  ["Contents"],
  ["Contents", "Resources"],
  ["Contents", "Resources", "Data"],
  ["Contents", "Frameworks"],
  ["Contents", "MacOS"],
  ["Contents", "UE"],
];

/**
 * The folders a fingerprint reads, beside the game's folder itself: each Mac app bundle's engine
 * folders (and the folder's own `Contents`, for a game whose folder is its bundle), and each top
 * folder (a Unity `*_Data`, a `Game` folder with the game's program and its anti-cheat) with its
 * Unreal `Content/Paks`.
 */
function folderLooks(dir: string, top: Dirent[]): string[] {
  const looks: string[] = [];
  const bundles = top.filter((e) => e.isDirectory() && e.name.toLowerCase().endsWith(".app")).map((e) => e.name);
  const hasContents = top.some((e) => e.isDirectory() && e.name === "Contents");
  for (const base of [...bundles.map((name) => path.join(dir, name)), ...(hasContents ? [dir] : [])])
    for (const parts of BUNDLE_FOLDERS) looks.push(path.join(base, ...parts));
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    looks.push(path.join(dir, entry.name), path.join(dir, entry.name, "Content", "Paks"));
  }
  return looks;
}

/** The lowercase names of the game folder's top entries and of the folders an engine keeps its files in, up to the cap. */
async function namesNear(dir: string): Promise<{ names: Set<string>; paks: boolean }> {
  const top = await entries(dir);
  const names = new Set(top.map((e) => e.name.toLowerCase()));
  let paks = false;
  for (const look of folderLooks(dir, top)) {
    if (names.size >= MAX_NAMES) break;
    const found = await entries(look);
    if (look.endsWith(path.join("Content", "Paks")) && found.some((e) => e.name.endsWith(".pak"))) paks = true;
    for (const entry of found.slice(0, MAX_NAMES - names.size)) names.add(entry.name.toLowerCase());
  }
  return { names, paks };
}

/** The names an engine's files carry: whole names, endings, or both of a pair. */
interface EngineSign {
  names?: readonly string[];
  endings?: readonly string[];
  pair?: readonly [string, string];
}

/** Each engine by the files it leaves, the more particular engines first: the first that matches wins. */
const ENGINE_SIGNS: ReadonlyArray<[BuiltWith, EngineSign]> = [
  [BuiltWith.Unreal, { names: ["ue"] }],
  [BuiltWith.Godot, { endings: [".pck"] }],
  [BuiltWith.Love, { names: ["love.dll", "love.framework"], endings: [".love"] }],
  [BuiltWith.GameMaker, { names: ["data.win", "game.ios", "game.unx"] }],
  [BuiltWith.RenPy, { names: ["renpy"] }],
  [BuiltWith.RpgMaker, { names: ["rmmz_core.js", "rpg_core.js"], pair: ["www", "nw.dll"] }],
  [BuiltWith.DotNet, { names: ["fna.dll", "monogame.framework.dll", "microsoft.xna.framework.dll"] }],
  [BuiltWith.Java, { endings: [".jar"] }],
];
/** Unity's player, and the files of its IL2CPP builds. */
const UNITY_NAMES = ["unityplayer.dll", "unityplayer.dylib", "globalgamemanagers"];
const IL2CPP_NAMES = ["gameassembly.dll", "gameassembly.dylib", "il2cpp_data"];

/** Whether a set of names carries an engine's sign. */
function shows(names: Set<string>, sign: EngineSign): boolean {
  if (sign.names?.some((name) => names.has(name))) return true;
  if (sign.pair && names.has(sign.pair[0]) && names.has(sign.pair[1])) return true;
  return Boolean(sign.endings?.some((ending) => [...names].some((name) => name.endsWith(ending))));
}

/** The engine a set of names says: Unity (Mono or IL2CPP) first, an Unreal pak, then the table in order. */
function engineOf(names: Set<string>, paks: boolean): BuiltWith | null {
  if (UNITY_NAMES.some((name) => names.has(name)))
    return IL2CPP_NAMES.some((name) => names.has(name)) ? BuiltWith.UnityIl2cpp : BuiltWith.Unity;
  if (paks) return BuiltWith.Unreal;
  return ENGINE_SIGNS.find(([, sign]) => shows(names, sign))?.[0] ?? null;
}

/** The anti-cheat a set of names says the game ships, each once, in the table's order. */
function antiCheatOf(names: Set<string>): string[] {
  const found = new Set<string>();
  for (const [pattern, name] of ANTI_CHEAT) if ([...names].some((n) => pattern.test(n))) found.add(name);
  return [...found];
}

/** What the game in `dir` was made with and the anti-cheat it ships, read from its files' names. */
export async function fingerprint(dir: string): Promise<Fingerprint> {
  const { names, paks } = await namesNear(dir);
  return { builtWith: engineOf(names, paks), antiCheat: antiCheatOf(names) };
}
