/**
 * What Genex knows about particular games before an agent looks: where a game loads its mods
 * from, where it keeps the person's saves, and the community's route in one line. A game missing
 * here can still be modded (its mods go in its own folder); one listed as online (on Steam or the
 * Epic Games Launcher) is never modded, whatever its folder holds, and neither is a game that ships
 * anti-cheat (`fingerprint.ts`).
 */
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";

/** The folder a place is relative to: the person's home, Windows's roaming app data, Documents, or the game's own folder. */
export const PlaceBase = { Home: "home", AppData: "appdata", Documents: "documents", Game: "game" } as const;
export type PlaceBase = (typeof PlaceBase)[keyof typeof PlaceBase];

/** A folder on one computer: a base and the folders below it. */
export interface Place {
  base: PlaceBase;
  parts: readonly string[];
}

/** A folder on a Mac and on Windows; a side Genex isn't sure of is left out. */
export interface PlacePair {
  mac?: Place;
  win?: Place;
}

/** One game Genex knows: where its mods and saves go, and the route mods take, for the agent. */
export interface KnownGame {
  mods?: PlacePair;
  saves?: PlacePair;
  route: string;
}

/** The roots a place resolves against on this computer. */
export interface PlaceRoots {
  platform: NodeJS.Platform;
  home: string;
  appData: string;
  /** The real Documents folder (on Windows often moved into OneDrive). */
  documents: string;
  game: string;
}

/** The Mac's Application Support, below the home. */
const APP_SUPPORT = ["Library", "Application Support"] as const;

/** A place under the Mac's Application Support. */
const macSupport = (...parts: string[]): Place => ({ base: PlaceBase.Home, parts: [...APP_SUPPORT, ...parts] });
/** A place under Windows's roaming app data. */
const winAppData = (...parts: string[]): Place => ({ base: PlaceBase.AppData, parts });
/** A place inside the game's own folder. */
const inGame = (...parts: string[]): Place => ({ base: PlaceBase.Game, parts });

/** The game id Genex gives Minecraft: Java Edition, found by its launcher rather than a store. */
export const MINECRAFT_ID = "minecraft";
/** The Steam app id of tModLoader, the free app Terraria's code mods load in. */
const TMODLOADER_APP = "1281930";

/** The games Genex knows, by the id `find-games` gives them (`steam:<app id>`, `minecraft`). */
export const KNOWN_GAMES: Readonly<Record<string, KnownGame>> = {
  "steam:2379780": {
    route:
      "Balatro is a LÖVE game: Lua mods made with Steamodded, loaded by the Lovely injector, which sits in the game's own folder.",
    mods: { mac: macSupport("Balatro", "Mods"), win: winAppData("Balatro", "Mods") },
    saves: { mac: macSupport("Balatro"), win: winAppData("Balatro") },
  },
  "steam:427520": {
    route:
      "Factorio has an official Lua mod API: a mod is a folder named <name>_<version> holding info.json, data.lua and control.lua; Factorio loads it from its mods folder.",
    mods: { mac: macSupport("factorio", "mods"), win: winAppData("Factorio", "mods") },
    saves: { mac: macSupport("factorio", "saves"), win: winAppData("Factorio", "saves") },
  },
  "steam:413150": {
    route:
      "Stardew Valley mods load with SMAPI: C# mods, or Content Patcher packs of JSON and pictures. SMAPI installs with its own installer.",
    mods: { mac: inGame("Contents", "MacOS", "Mods"), win: inGame("Mods") },
    saves: {
      mac: { base: PlaceBase.Home, parts: [".config", "StardewValley", "Saves"] },
      win: winAppData("StardewValley", "Saves"),
    },
  },
  [`steam:${TMODLOADER_APP}`]: {
    route:
      "tModLoader builds C# mods from their source in ModSources itself (Workshop, then Develop Mods, then Build); a mod is a folder with build.txt and its .cs files.",
    mods: {
      mac: macSupport("Terraria", "tModLoader", "ModSources"),
      win: { base: PlaceBase.Documents, parts: ["My Games", "Terraria", "tModLoader", "ModSources"] },
    },
    saves: {
      mac: macSupport("Terraria", "tModLoader"),
      win: { base: PlaceBase.Documents, parts: ["My Games", "Terraria", "tModLoader"] },
    },
  },
  "steam:105600": {
    route:
      "Terraria's code mods run in tModLoader, a free separate app on Steam: ask the person to get it, then make the mod for tModLoader.",
    saves: {
      mac: macSupport("Terraria"),
      win: { base: PlaceBase.Documents, parts: ["My Games", "Terraria"] },
    },
  },
  "steam:646570": {
    route:
      "Slay the Spire mods load with ModTheSpire and BaseMod (both on its Steam Workshop): Java mods built as a .jar.",
  },
  "steam:294100": {
    route:
      "RimWorld mods are folders of XML defs and C# Harmony patches, loaded from the Mods folder in the game's folder.",
  },
  [MINECRAFT_ID]: {
    route:
      "Minecraft: Java Edition mods load with Fabric (or Forge), which the person installs into the Minecraft Launcher; a mod is a .jar for that loader's Minecraft version.",
    mods: { mac: inGame("mods"), win: inGame("mods") },
    saves: { mac: inGame("saves"), win: inGame("saves") },
  },
};

/**
 * Steam apps that are online games: Genex makes no mod for them, since changing an online game's
 * files breaks its rules and can get the person's account banned. Anti-cheat in a game's folder is
 * refused too (`fingerprint.ts`); this list covers the online games that ship none Genex can see.
 */
export const ONLINE_STEAM_APPS: ReadonlySet<string> = new Set([
  "730", // Counter-Strike 2
  "570", // Dota 2
  "440", // Team Fortress 2
  "238960", // Path of Exile
  "2694490", // Path of Exile 2
  "578080", // PUBG: Battlegrounds
  "1172470", // Apex Legends
  "359550", // Rainbow Six Siege
  "252490", // Rust
  "271590", // Grand Theft Auto V
  "3240220", // Grand Theft Auto V Enhanced
  "1085660", // Destiny 2
  "1938090", // Call of Duty
  "2357570", // Overwatch 2
  "230410", // Warframe
  "1599340", // Lost Ark
  "553850", // Helldivers 2
  "2073850", // The Finals
  "1517290", // Battlefield 2042
  "236390", // War Thunder
  "1063730", // New World
  "1203220", // Naraka: Bladepoint
  "2767030", // Marvel Rivals
  "1422450", // Deadlock
  "252950", // Rocket League
  "1240440", // Halo Infinite
  "381210", // Dead by Daylight
  "594650", // Hunt: Showdown 1896
  "1172620", // Sea of Thieves
  "1097150", // Fall Guys
  "291550", // Brawlhalla
  "306130", // The Elder Scrolls Online
  "1284210", // Guild Wars 2
  "39210", // Final Fantasy XIV Online
  "8500", // EVE Online
  "582660", // Black Desert
  "761890", // Albion Online
  "2507950", // Delta Force
  "2807960", // Battlefield 6
  "2429640", // Throne and Liberty
  "2139460", // Once Human
]);

/**
 * Epic Games Launcher apps (by their app name) that are online games, for the same reason; most
 * also ship anti-cheat, which refuses them by their folder too.
 */
export const ONLINE_EPIC_APPS: ReadonlySet<string> = new Set([
  "Fortnite",
  "Sugar", // Rocket League
]);

/** Steam apps that are Steam's own tools, never games: its runtimes, Proton and shared redistributables. */
export const STEAM_TOOL_APPS: ReadonlySet<string> = new Set([
  "228980", // Steamworks Common Redistributables
  "1070560", // Steam Linux Runtime 1.0
  "1391110", // Steam Linux Runtime 2.0
  "1628350", // Steam Linux Runtime 3.0
  "1493710", // Proton Experimental
  "1826330", // Proton EasyAntiCheat Runtime
  "1161040", // Proton BattlEye Runtime
]);

/** Where a place is on this computer, or null when Genex doesn't know it here (a Mac-only place on Windows). */
export function placeFolder(pair: PlacePair | undefined, roots: PlaceRoots): string | null {
  const windows = roots.platform === StudioPlatform.Windows;
  const place = windows ? pair?.win : pair?.mac;
  if (!place) return null;
  const join = windows ? path.win32.join : path.posix.join;
  const base = {
    [PlaceBase.Home]: roots.home,
    [PlaceBase.AppData]: roots.appData,
    [PlaceBase.Documents]: roots.documents,
    [PlaceBase.Game]: roots.game,
  }[place.base];
  return base ? join(base, ...place.parts) : null;
}
