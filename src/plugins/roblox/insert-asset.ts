/**
 * A Creator Store insert as the Roblox Studio plugin's ask-first tool (`insert-asset`): the person
 * approves each one on a card, Studio fetches the asset on their Roblox account, and Genex inserts
 * free assets only.
 *
 * - The id must be plain digits; anything else reaches no Studio.
 * - The price comes first: Studio's own Creator Store search for that id (`search_asset`, which says
 *   whether it is free). An asset the search doesn't find is read by its product info in Edit: free
 *   to take (public), or the signed-in person's own. A paid asset, or one Genex can't show is free,
 *   is refused, and nothing is inserted.
 * - The insert runs under the agent's busy mark, so the Studio lock doesn't read it as the person's.
 * - A store model can carry scripts, and they run when the game plays. The answer lists every script
 *   the asset brought (what was added under its parent since just before the insert), with the ways
 *   backdoors hide flagged: `require` with an id, `loadstring`, `getfenv`, `HttpService`,
 *   `MarketplaceService`.
 */
import {
  type AskFirstAnswer,
  type AskFirstDeps,
  type AskFirstGame,
  askStudio,
  CallMark,
  refuse,
  refusedOr,
  refusedWords,
  unbound,
} from "./ai-tools.ts";
import { probeCode } from "./probes.ts";
import { DATAMODEL_ARG, DataModel, StudioTool } from "./studio-tools.ts";

/** A Roblox asset id: digits, no leading zero, as long as the largest ids get. */
const ASSET_ID = /^[1-9][0-9]{0,19}$/;
/** The most Creator Store results read when looking for the id's price. */
const SEARCH_RESULTS = 20;
/** The longest name the inserted instance is given. */
const MAX_NAME_CHARS = 100;
/** The longest parent path (`Workspace.Folder`). */
const MAX_PARENT_CHARS = 300;
/** Where Studio inserts when the agent names no parent. */
const DEFAULT_PARENT = "Workspace";
/** The asset types `insert_asset` takes, in Studio's words. Wire values: never rename. */
const ASSET_TYPES = ["Model", "Package", "Mesh", "MeshPart", "Image", "Decal", "Audio", "Video", "Animation"] as const;
/** The search scope that holds prices. Wire value: never rename. */
const CREATOR_STORE = "creator_store";

/** The Luau steps an insert runs in Edit, by name. Wire values: never rename. */
const InsertStep = { Info: "info", Children: "children", Scripts: "scripts" } as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f]/;

const MESSAGE = {
  notAnId: "id must be the asset's number: plain digits, such as 580221169.",
  name: `name must be one line of at most ${MAX_NAME_CHARS} characters.`,
  parent: `parent must be a Studio path such as Workspace.Folder, one line of at most ${MAX_PARENT_CHARS} characters.`,
  type: `type must be one of: ${ASSET_TYPES.join(", ")}.`,
  paid: (id: string, name: string, price: string, url: string) =>
    `${name} (${id}) costs ${price} on the Creator Store, and Genex inserts only free assets. The person can buy it${url ? ` at ${url}` : " there"} and insert it themselves.`,
  unknownPrice: (id: string) =>
    `Genex couldn't confirm that asset ${id} is free (not on the Creator Store as free, not public and not the person's own), so it inserts only free assets and left it out.`,
  inserted: (id: string, parent: string) => `Inserted asset ${id} under ${parent}.`,
  noScripts: "It brought no scripts.",
  scripts: (count: number) =>
    `It brought ${count === 1 ? "1 script" : `${count} scripts`}, which run when the game plays. Read each one; delete any you don't understand, and every one flagged below:`,
  scriptLine: (script: InsertedScript) =>
    `- ${script.path} (${script.class}, ${script.lines} lines)${script.flags.length ? `: uses ${script.flags.join(", ")}` : ""}`,
} as const;

/** A script an inserted asset brought, with the ways backdoors hide that its source uses. */
export interface InsertedScript {
  path: string;
  class: string;
  lines: number;
  flags: string[];
}

/** What a free insert answers: the asset, what was added and the scripts it brought. */
export interface Inserted {
  assetId: string;
  added: string[];
  scripts: InsertedScript[];
}

/** The insert's arguments, checked: the id, and the name, type and parent Studio is given. */
interface InsertArgs {
  id: string;
  name?: string;
  type?: string;
  parent?: string;
}

function checkedArgs(args: Record<string, unknown>): InsertArgs {
  const id = args.id;
  if (typeof id !== "string" || !ASSET_ID.test(id)) return refuse(MESSAGE.notAnId);
  const checked: InsertArgs = { id };
  const { name, type, parent } = args;
  if (name !== undefined) {
    const ok =
      typeof name === "string" && name.trim() && name.length <= MAX_NAME_CHARS && !LINE_BREAK_OR_CONTROL.test(name);
    checked.name = ok ? name : refuse(MESSAGE.name);
  }
  if (type !== undefined)
    checked.type = ASSET_TYPES.includes(type as (typeof ASSET_TYPES)[number]) ? String(type) : refuse(MESSAGE.type);
  if (parent !== undefined) {
    const ok =
      typeof parent === "string" &&
      parent.length <= MAX_PARENT_CHARS &&
      !LINE_BREAK_OR_CONTROL.test(parent) &&
      parent.split(".").every((part) => part.trim().length > 0);
    checked.parent = ok ? parent : refuse(MESSAGE.parent);
  }
  return checked;
}

/** A JSON object out of Studio's words, or undefined. */
function objectOf(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The price search's answer for this id: free or not, its name, price and store page; undefined when not found. */
async function storePrice(deps: AskFirstDeps, game: AskFirstGame, id: string) {
  const call = {
    tool: StudioTool.SearchAsset,
    args: { query: id, scope: CREATOR_STORE, maxResults: SEARCH_RESULTS },
    mark: CallMark.None,
  };
  const outcome = await askStudio(deps, game, call);
  if (!outcome.ok) return undefined;
  const results = objectOf(outcome.text)?.results;
  if (!Array.isArray(results)) return undefined;
  const found = results.find((result) => (result as { assetId?: unknown })?.assetId === id) as
    | Record<string, unknown>
    | undefined;
  if (!found) return undefined;
  return {
    free: found.isFree === true && (found.priceCents ?? 0) === 0,
    name: typeof found.name === "string" ? found.name : `Asset ${id}`,
    price: typeof found.priceLabel === "string" ? found.priceLabel : `${Number(found.priceCents ?? 0) / 100} USD`,
    url: typeof found.creatorStoreUrl === "string" ? found.creatorStoreUrl : "",
  };
}

/**
 * The Luau the insert runs in Edit, one step per call. `info`: the asset's product info and the
 * signed-in person's id. `children`: the debug ids of the parent's children now. `scripts`: what the
 * parent holds that it didn't before, and every script in it, with the patterns backdoors use.
 */
const INSERT_LUAU = `return function(args)
  local HttpService = game:GetService("HttpService")
  local function parentOf(path)
    local at = game
    for name in string.gmatch(path, "[^%.]+") do
      if not (at == game and name == "game") then
        at = at:FindFirstChild(name)
        if not at then return nil end
      end
    end
    return at
  end
  if args.op == "info" then
    local ok, info = pcall(function()
      return game:GetService("MarketplaceService"):GetProductInfo(tonumber(args.id), Enum.InfoType.Asset)
    end)
    if not ok then return HttpService:JSONEncode({ error = tostring(info) }) end
    local okUser, user = pcall(function() return game:GetService("StudioService"):GetUserId() end)
    return HttpService:JSONEncode({
      publicDomain = info.IsPublicDomain == true,
      creatorId = info.Creator and info.Creator.CreatorTargetId,
      creatorType = info.Creator and info.Creator.CreatorType,
      user = okUser and user or nil,
      name = info.Name,
    })
  end
  local parent = parentOf(args.parent)
  if not parent then return HttpService:JSONEncode({ error = "no parent " .. args.parent }) end
  if args.op == "children" then
    local ids = {}
    for _, child in parent:GetChildren() do table.insert(ids, child:GetDebugId()) end
    return HttpService:JSONEncode({ ids = ids })
  end
  local before = {}
  for _, id in args.before do before[id] = true end
  local added, scripts = {}, {}
  local patterns = {
    { "require with an id", "require%s*%(%s*%d" },
    { "loadstring", "loadstring" },
    { "getfenv", "getfenv" },
    { "HttpService", "HttpService" },
    { "MarketplaceService", "MarketplaceService" },
  }
  local function note(item)
    if not item:IsA("LuaSourceContainer") then return end
    local source = item.Source
    local flags = {}
    for _, pattern in patterns do
      if string.find(source, pattern[2]) then table.insert(flags, pattern[1]) end
    end
    local _, lines = string.gsub(source, "\\n", "")
    table.insert(scripts, { path = item:GetFullName(), class = item.ClassName, lines = lines + 1, flags = flags })
  end
  for _, child in parent:GetChildren() do
    if not before[child:GetDebugId()] then
      table.insert(added, child:GetFullName())
      note(child)
      for _, item in child:GetDescendants() do note(item) end
    end
  end
  return HttpService:JSONEncode({ added = added, scripts = scripts })
end`;

/** One Luau step in the game's Studio, in Edit; its JSON answer, or undefined. */
async function luauStep(deps: AskFirstDeps, game: AskFirstGame, args: Record<string, unknown>) {
  const code = probeCode(INSERT_LUAU, args);
  const call = { tool: StudioTool.ExecuteLuau, args: { code, [DATAMODEL_ARG]: DataModel.Edit }, mark: CallMark.None };
  const outcome = await askStudio(deps, game, call);
  return outcome.ok ? objectOf(outcome.text) : undefined;
}

/** Whether the asset's product info shows it free to take or the person's own. */
async function freeByInfo(deps: AskFirstDeps, game: AskFirstGame, id: string): Promise<boolean> {
  const info = await luauStep(deps, game, { op: InsertStep.Info, id });
  if (!info || info.error !== undefined) return false;
  if (info.publicDomain === true) return true;
  return info.creatorType === "User" && typeof info.user === "number" && info.creatorId === info.user;
}

/** A list of strings out of Luau's answer: Luau writes an empty table as [] or {}. */
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

function scriptsOf(value: unknown): InsertedScript[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const one = item as Record<string, unknown>;
    if (typeof one?.path !== "string" || typeof one.class !== "string") return [];
    return [{ path: one.path, class: one.class, lines: Number(one.lines) || 0, flags: strings(one.flags) }];
  });
}

/** The agent's answer after a free insert: what was added and each script it brought. */
function insertedAnswer(
  id: string,
  parent: string,
  words: string,
  after: Record<string, unknown> | undefined,
): AskFirstAnswer {
  const scripts = scriptsOf(after?.scripts);
  const lines = [MESSAGE.inserted(id, parent), words].filter(Boolean);
  lines.push(scripts.length ? MESSAGE.scripts(scripts.length) : MESSAGE.noScripts, ...scripts.map(MESSAGE.scriptLine));
  const result: Inserted = { assetId: id, added: strings(after?.added), scripts };
  return { done: true, message: lines.join("\n"), result };
}

async function insertChecked(deps: AskFirstDeps, game: AskFirstGame, checked: InsertArgs): Promise<AskFirstAnswer> {
  const { id } = checked;
  const store = await storePrice(deps, game, id);
  if (store && !store.free) return { done: false, message: MESSAGE.paid(id, store.name, store.price, store.url) };
  if (!store && !(await freeByInfo(deps, game, id))) return { done: false, message: MESSAGE.unknownPrice(id) };
  const parent = checked.parent ?? DEFAULT_PARENT;
  const before = await luauStep(deps, game, { op: InsertStep.Children, parent });
  const insertArgs = {
    assetId: id,
    ...(checked.name ? { assetName: checked.name } : {}),
    ...(checked.type ? { assetType: checked.type } : {}),
    ...(checked.parent ? { parentPath: checked.parent } : {}),
  };
  const outcome = await askStudio(deps, game, { tool: StudioTool.InsertAsset, args: insertArgs, mark: CallMark.Busy });
  if (!outcome.ok) return { done: false, message: refusedWords(outcome) };
  const after = await luauStep(deps, game, { op: InsertStep.Scripts, parent, before: strings(before?.ids) });
  return insertedAnswer(id, parent, outcome.text, after);
}

/** Inserts a free Creator Store asset in the game's own Studio; anything refused reaches no Studio. */
export async function insertAsset(
  deps: AskFirstDeps,
  args: Record<string, unknown>,
  game: AskFirstGame,
): Promise<AskFirstAnswer> {
  const checked = await refusedOr(async () => checkedArgs(args));
  if ("done" in checked) return checked;
  return unbound(deps, game) ?? insertChecked(deps, game, checked);
}
