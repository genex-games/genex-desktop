/**
 * The screen an agent's `execute_luau` code passes before the Roblox Studio connection forwards
 * it. `execute_luau` runs with a plugin's rights, which reach the person's Roblox account: inserting
 * Creator Store assets, uploading, publishing, the internet, and a published game's live data. Each
 * of those goes through a tool that asks the person first, so code that names one of them, or that
 * looks members up by names it builds (the way past a screen of names), is refused with the tool
 * to use instead.
 *
 * The screen reads the code as text and never runs it. It refuses the plain and the disguised
 * ways to these APIs it knows; a name built in a variable and looked up on an instance found by
 * walking the tree still passes, so the asking tools stay the line the person sees, not this screen.
 * `require` takes a script path only (an instance reached by names, or a variable not set to a
 * number): anything else may be an asset id.
 */

/** What refused code reaches. Wire values: never rename. */
export const LuauReach = {
  /** Creator Store assets inserted, or code loaded by asset id. */
  Insert: "insert",
  /** Uploads to the person's Roblox account. */
  Upload: "upload",
  /** Publishing a place. */
  Publish: "publish",
  /** The internet, or Roblox's own web APIs. */
  Network: "network",
  /** A published game's live data, players or purchases. */
  LiveGame: "live-game",
  /** Members looked up by names the code builds, past this screen. */
  Hidden: "hidden",
} as const;
export type LuauReach = (typeof LuauReach)[keyof typeof LuauReach];

/** Why code is refused: what it reaches, and the text that showed it. */
export interface LuauRefusal {
  reach: LuauReach;
  found: string;
}

/** A word standing alone in Luau code, any letter case. */
const words = (...names: string[]) => new RegExp(`\\b(?:${names.join("|")})\\b`, "i");

/** Decision table: each rule's reach and what shows it, first match wins. */
const RULES: ReadonlyArray<{ reach: LuauReach; pattern: RegExp }> = [
  {
    reach: LuauReach.Insert,
    pattern: words("GetObjects", "InsertService", "LoadAsset", "LoadAssetVersion", "GetFreeModels", "GetFreeDecals"),
  },
  // A module loaded by asset id runs code from the Creator Store.
  { reach: LuauReach.Insert, pattern: /\brequire\s*\(\s*(?:\d|tonumber\b)/i },
  { reach: LuauReach.Upload, pattern: words("AssetService", "CreateAssetAsync", "CreateAssetVersionAsync") },
  {
    reach: LuauReach.Publish,
    pattern: words("PublishService", "StudioPublishService", "SavePlaceAsync", "CreatePlaceAsync"),
  },
  {
    reach: LuauReach.Network,
    pattern: words(
      "HttpRbxApiService",
      "RequestAsync",
      "GetAsync",
      "PostAsync",
      "RequestInternal",
      "GetAsyncFullUrl",
      "PostAsyncFullUrl",
      "RequestAsyncFullUrl",
      "CreateWebStreamClient",
      "OpenCloudService",
    ),
  },
  {
    reach: LuauReach.LiveGame,
    pattern: words("DataStoreService", "MemoryStoreService", "MessagingService", "BanAsync", "UnbanAsync"),
  },
  { reach: LuauReach.LiveGame, pattern: /\b(?:Prompt\w*Purchase\w*|PerformPurchase)\b/i },
  { reach: LuauReach.Hidden, pattern: words("getfenv", "setfenv", "loadstring") },
  // The data model or a library indexed by an expression: `game[...]`, `string[...]`.
  { reach: LuauReach.Hidden, pattern: /\b(?:game|workspace|string|utf8)\s*\[/i },
  // A name joined from pieces inside an index: `x["Get" .. "Objects"]`.
  { reach: LuauReach.Hidden, pattern: /\[[^\]\n]*\.\./ },
  // A service asked for by anything but one plain name: `GetService("Lighting")` passes.
  { reach: LuauReach.Hidden, pattern: /(?:\bGetService|\bFindService|:service)\b(?!\s*\(\s*(["'])[A-Za-z]+\1\s*\))/ },
  // Names spelled with character codes or backwards.
  { reach: LuauReach.Hidden, pattern: /\b(?:char|reverse)\s*\(/i },
  { reach: LuauReach.Hidden, pattern: /\\(?:\d|x[0-9a-f]|u\{)/i },
];

/** Each `require` and what follows it. */
const REQUIRE = /\brequire\b\s*(\(?)/g;
/** A string argument that is a path (`"./Util"`, `"@game/X"`); any other string may hold an asset id. */
const PATH_STRING = /^\s*(["'])(?:\.{1,2}\/|@)[^"'\n]*\1/;
/**
 * A script path up to `require`'s closing parenthesis: a name, then `.Name`, `["Name"]` or
 * `:Method("Name")` steps (`script.Parent.Util`, `game:GetService("X"):WaitForChild("Y")`).
 */
const SCRIPT_PATH =
  /^\s*([A-Za-z_]\w*)((?:\s*(?:\.\s*[A-Za-z_]\w*|\[\s*(["'])[^"'\n]*\3\s*\]|:\s*[A-Za-z_]\w*\s*\(\s*(?:(["'])[^"'\n]*\4)?\s*\)))*)\s*\)/;

/** Whether `name` is set to a number anywhere in `code`: `id = 4567`, `id = tonumber(...)`. */
function setToNumber(code: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=\\s*(?:[-(]*\\s*\\d|tonumber\\b|math\\.)`).test(code);
}

/** Why one `require` (its text from the word on) is refused, or null when it takes a script path. */
function requireReach(code: string, rest: string, called: boolean): LuauReach | null {
  if (!called) return PATH_STRING.test(rest) ? null : LuauReach.Hidden;
  const argument = rest.slice(rest.indexOf("(") + 1);
  if (PATH_STRING.test(argument)) return null;
  const path = SCRIPT_PATH.exec(argument);
  if (!path) return LuauReach.Insert;
  const bare = path[2]?.trim() === "";
  return bare && setToNumber(code, path[1] ?? "") ? LuauReach.Insert : null;
}

/** The first `require` that may load a module by asset id, or that is passed on as a value. */
function screenRequire(code: string): LuauRefusal | null {
  for (const match of code.matchAll(REQUIRE)) {
    const rest = code.slice((match.index ?? 0) + "require".length);
    const reach = requireReach(code, rest, match[1] === "(");
    if (reach)
      return {
        reach,
        found:
          code
            .slice(match.index ?? 0)
            .split("\n")[0]
            ?.trim() ?? "require",
      };
  }
  return null;
}

/** Why `code` is refused, or null when it may run. */
export function screenLuau(code: string): LuauRefusal | null {
  for (const rule of RULES) {
    const match = rule.pattern.exec(code);
    if (match) return { reach: rule.reach, found: match[0].trim() };
  }
  return screenRequire(code);
}
