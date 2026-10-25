/**
 * The Genex CLI commands an agent may have Studio run, as one table, and the argv each call
 * becomes. Pure: `genexCliRequest` either answers the exact argv for the pinned CLI or throws a
 * typed {@link GenexCliRefusal} naming what to use instead. The host adds the credential, the API
 * origin, `--no-auth` and `--json` itself (`genex-cli.ts`), and `--user-approved` only here, only
 * for a paid command the user has just approved. A store item's picture, model and package name
 * paths inside the bound game (`gamePaths`), which the host checks by real path and copies into the
 * run folder; `items add` names the shared item whose folder the host moves into the game
 * (`delivers`). `shop publish` and `shop unpublish` are never in the table: only the person puts an
 * item on sale, from the Listing draft card (D40). The shop's commands also work on the game's local
 * drafts (`.genex/items/`, made before the game is on Genex): Studio copies them into the run folder
 * and carries a change back (`localItems`). `shop sync`, which uploads them, is Studio's own run after
 * a publish ({@link localSyncRequest}), never the agent's.
 */
import { isLocalItemId } from "../../shared/item-draft.ts";
import { ITEM_DESCRIPTION_MAX, ITEM_TAG_LENGTH_MAX, ITEM_TAGS_MAX, isItemId } from "../../shared/store-items.ts";
import { GENEX_CLI_PROMPT, GENEX_VALUE_RULE, GenexStudioTool } from "./genex-cli-prompts.ts";

/** The commands Studio runs, spelled as their words. Tool arguments: never rename a value. */
export const GenexCliCommand = {
  Doctor: "doctor",
  Budget: "budget",
  LlmModels: "llm models",
  LlmStatus: "llm status",
  LlmCancel: "llm cancel",
  LlmBench: "llm bench",
  ShopList: "shop list",
  ShopAdd: "shop add",
  ShopSet: "shop set",
  ShopRemove: "shop remove",
  ShopTest: "shop test",
  ItemsList: "items list",
  ItemsSearch: "items search",
  ItemsAdd: "items add",
  ItemsRemove: "items remove",
} as const;
export type GenexCliCommand = (typeof GenexCliCommand)[keyof typeof GenexCliCommand];

/** Commands only Studio itself runs, never for an agent: no row in the agent's table. */
export const GenexHostCommand = {
  /** Upload the game's local drafts as drafts on genex.games, after a publish (`local-items.ts`). */
  ShopSync: "shop sync",
} as const;
export type GenexHostCommand = (typeof GenexHostCommand)[keyof typeof GenexHostCommand];

/** How a command uses the game's local drafts: it reads them, or it may change them. */
export const LocalItemsUse = { Read: "read", Change: "change", Sync: "sync" } as const;
export type LocalItemsUse = (typeof LocalItemsUse)[keyof typeof LocalItemsUse];

/** Why a call was refused. */
export const GenexCliRefusalCode = {
  Unavailable: "unavailable",
  UseTool: "use-tool",
  PaidTool: "paid-tool",
  FreeTool: "free-tool",
  ReservedFlag: "reserved-flag",
  UnknownOption: "unknown-option",
  InvalidValue: "invalid-value",
} as const;
export type GenexCliRefusalCode = (typeof GenexCliRefusalCode)[keyof typeof GenexCliRefusalCode];

/** A call Studio will not run; its message tells the agent what to do instead. */
export class GenexCliRefusal extends Error {
  readonly code: GenexCliRefusalCode;
  constructor(code: GenexCliRefusalCode, message: string) {
    super(message);
    this.name = "GenexCliRefusal";
    this.code = code;
  }
}

/** The approval flag the CLI demands for spending; only Studio adds it, after the user said yes. */
const USER_APPROVED_FLAG = "--user-approved";
const POSITIONAL_MAX_CHARS = 4000;
const VALUE_MAX_CHARS = 500;
const COMMAND_MAX_WORDS = 2;
const MAX_BENCH_SAMPLES = 25;
const MAX_ATTEMPT_SECONDS = 60;
/** How much of one value the consent card's summary keeps, so no value pushes another off the card. */
const CONSENT_VALUE_MAX_CHARS = 60;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
/** Line breaks, tabs and every other control character. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** The longest path inside the game a file option may name. */
const GAME_PATH_MAX_CHARS = 500;
/** A path that does not start inside the game: from the root, a drive, a share or a home. */
const NOT_RELATIVE = /^(?:[/\\~]|[A-Za-z]:)/;

/**
 * Flags Studio owns or that reach outside the run: never taken from the agent, whatever the
 * command. The rest of a command's flags are refused unless its row lists them.
 */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "env",
  "api-url",
  "auth-url",
  "dir",
  "agents",
  "out-dir",
  "force",
  "yes",
  "user-approved",
  "source-token",
  "token",
  "no-auth",
  "json",
  "help",
  "version",
]);

/** The shapes an option's value takes. */
const OptionKind = {
  Flag: "flag",
  Toggle: "toggle",
  WholeNumber: "whole-number",
  Choice: "choice",
  Text: "text",
  /** A text value the flag takes once per value, given as one text or a list of them. */
  TextList: "text-list",
  /** A file or folder inside the bound game, which Studio copies into the run folder. */
  GamePath: "game-path",
} as const;

/** What a game path option names. Wire values of `GamePathArg.target`: never rename one. */
export const GamePathTarget = { File: "file", Folder: "folder" } as const;
export type GamePathTarget = (typeof GamePathTarget)[keyof typeof GamePathTarget];

type OptionSpec =
  | { kind: typeof OptionKind.Flag }
  | { kind: typeof OptionKind.Toggle }
  | { kind: typeof OptionKind.WholeNumber; min: number; max: number }
  | { kind: typeof OptionKind.Choice; values: readonly string[] }
  | { kind: typeof OptionKind.Text; max: number; empty: boolean }
  | { kind: typeof OptionKind.TextList; max: number; count: number }
  | { kind: typeof OptionKind.GamePath; target: GamePathTarget };

const flag = { kind: OptionKind.Flag } as const;
const toggle = { kind: OptionKind.Toggle } as const;
const text = { kind: OptionKind.Text, max: VALUE_MAX_CHARS, empty: false } as const;
const wholeNumber = (min: number, max = UNBOUNDED) => ({ kind: OptionKind.WholeNumber, min, max }) as const;
const gamePath = (target: GamePathTarget) => ({ kind: OptionKind.GamePath, target }) as const;
/** An item's search words, one per `--tag` (contract limits). */
const tags = { kind: OptionKind.TextList, max: ITEM_TAG_LENGTH_MAX, count: ITEM_TAGS_MAX } as const;
/** An item's description; `shop set` clears it with an empty one. */
const description = (empty: boolean) => ({ kind: OptionKind.Text, max: ITEM_DESCRIPTION_MAX, empty }) as const;
/** What players pay in coin: 0 is Free (the server says whether this stand's store takes it). */
const itemPrice = wholeNumber(0);
const itemType = { kind: OptionKind.Choice, values: ["consumable", "durable"] } as const;

/** What a command's positional argument is: none, any one line of text, or a store item's id. */
const Positional = { None: "none", Text: "text", ItemId: "item-id" } as const;
type Positional = (typeof Positional)[keyof typeof Positional];

/**
 * One command's row: what it costs, whether it needs the hosted project, and what it takes. A
 * paid row declares the option that sets what it spends first: the consent card lists options in
 * this order (`genexCliConsentArgs`).
 */
interface CommandRow {
  paid: boolean;
  project: boolean;
  positional: Positional;
  options: Readonly<Record<string, OptionSpec>>;
  required?: readonly string[];
  /** The CLI refuses it without `--user-approved`: the spending commands, not the shop's. */
  approval?: boolean;
  /** It writes the item its positional names into the game (`items add`). */
  delivers?: boolean;
  /**
   * It works on the game's local drafts too: Studio copies them into the run folder (and carries a
   * change back), and it runs without a hosted project while the game has none.
   */
  localItems?: LocalItemsUse;
}

const free = (
  project: boolean,
  options: CommandRow["options"] = {},
  positional: Positional = Positional.None,
): CommandRow => ({
  paid: false,
  project,
  positional,
  options,
});
const shopItem = (
  options: CommandRow["options"] = {},
  required?: readonly string[],
  localItems?: LocalItemsUse,
): CommandRow => ({
  paid: true,
  project: true,
  positional: Positional.Text,
  options,
  ...(required ? { required } : {}),
  ...(localItems ? { localItems } : {}),
});
/** A change to which other creators' items this game sells: the person approves it. */
const sharedItem = (delivers: boolean): CommandRow => ({
  paid: true,
  project: true,
  positional: Positional.ItemId,
  options: {},
  ...(delivers ? { delivers } : {}),
});

/**
 * Every command Studio runs. `budget` only reads: its `--assets` allowance lives in the run folder,
 * which Studio removes after each call, and Studio's own allowance and consent govern asset spending.
 */
const GENEX_CLI_COMMANDS: Readonly<Record<GenexCliCommand, CommandRow>> = {
  [GenexCliCommand.Doctor]: free(false),
  [GenexCliCommand.Budget]: free(false),
  [GenexCliCommand.LlmModels]: free(false, { all: flag }),
  [GenexCliCommand.LlmStatus]: free(true),
  [GenexCliCommand.LlmCancel]: free(true, {}, Positional.Text),
  [GenexCliCommand.LlmBench]: {
    paid: true,
    project: true,
    positional: Positional.Text,
    options: {
      "max-coins": wholeNumber(1),
      samples: wholeNumber(1, MAX_BENCH_SAMPLES),
      model: text,
      "json-output": flag,
      text: flag,
      timeout: wholeNumber(1, MAX_ATTEMPT_SECONDS),
    },
    required: ["max-coins"],
    approval: true,
  },
  [GenexCliCommand.ShopList]: { ...free(true), localItems: LocalItemsUse.Read },
  // A new item is a draft: it spends nothing and nobody can buy it until the person puts it on sale
  // from its card, so the free tool runs it and no consent card asks about it.
  [GenexCliCommand.ShopAdd]: {
    ...shopItem(
      {
        price: itemPrice,
        type: itemType,
        description: description(false),
        tag: tags,
        shared: toggle,
        resellable: toggle,
        icon: text,
        image: gamePath(GamePathTarget.File),
        model: gamePath(GamePathTarget.File),
        package: gamePath(GamePathTarget.Folder),
      },
      ["price"],
      LocalItemsUse.Change,
    ),
    paid: false,
  },
  [GenexCliCommand.ShopSet]: shopItem(
    {
      price: itemPrice,
      type: itemType,
      rename: text,
      description: description(true),
      tag: tags,
      shared: toggle,
      resellable: toggle,
      icon: text,
      image: gamePath(GamePathTarget.File),
      model: gamePath(GamePathTarget.File),
      package: gamePath(GamePathTarget.Folder),
    },
    undefined,
    LocalItemsUse.Change,
  ),
  [GenexCliCommand.ShopRemove]: shopItem({}, undefined, LocalItemsUse.Change),
  [GenexCliCommand.ShopTest]: shopItem(),
  [GenexCliCommand.ItemsList]: free(true),
  [GenexCliCommand.ItemsSearch]: free(true, { tag: tags }, Positional.Text),
  [GenexCliCommand.ItemsAdd]: sharedItem(true),
  [GenexCliCommand.ItemsRemove]: sharedItem(false),
};

/** Commands another Studio tool already covers, by their first word. */
const REPLACED_BY: Readonly<Record<string, GenexStudioTool>> = {
  preview: GenexStudioTool.Publish,
  promote: GenexStudioTool.Publish,
  publish: GenexStudioTool.Publish,
  image: GenexStudioTool.Asset,
  model: GenexStudioTool.Asset,
  texture: GenexStudioTool.Asset,
  video: GenexStudioTool.Asset,
  sfx: GenexStudioTool.Asset,
  music: GenexStudioTool.Asset,
  voice: GenexStudioTool.Asset,
  character: GenexStudioTool.Asset,
  creature: GenexStudioTool.Asset,
  animations: GenexStudioTool.Asset,
  motion: GenexStudioTool.Asset,
  wait: GenexStudioTool.Asset,
};

/** A path option's value inside the bound game, and where in the argv it stands. */
export interface GamePathArg {
  option: string;
  /** As the agent gave it: relative to the game's folder. */
  path: string;
  target: GamePathTarget;
  /** Its place in `argv`, which Studio points at its copy in the run folder. */
  index: number;
}

/** One call, ready to run: the command, its argv before Studio's own flags, and what it needs. */
export interface GenexCliRequest {
  command: GenexCliCommand | GenexHostCommand;
  argv: string[];
  /** It runs against the game's hosted project, mirrored into the run folder. */
  project: boolean;
  paid: boolean;
  /** Files and folders of the game it reads, copied into the run folder first; absent when none. */
  gamePaths?: GamePathArg[];
  /** The shared item whose `genex-items/<id>/` Studio moves into the game once the CLI wrote it. */
  delivers?: string;
  /** How it uses the game's local drafts (`.genex/items/`); absent when it does not. */
  localItems?: LocalItemsUse;
}

const refuse = (code: GenexCliRefusalCode, message: string) => new GenexCliRefusal(code, message);
const isCommand = (words: string): words is GenexCliCommand => Object.hasOwn(GENEX_CLI_COMMANDS, words);

/** The command's words, or a refusal naming the tool that covers it. */
function commandOf(raw: unknown): GenexCliCommand {
  const words = typeof raw === "string" ? raw.trim().split(/\s+/).filter(Boolean) : [];
  const spelled = words.join(" ");
  if (isCommand(spelled) && words.length <= COMMAND_MAX_WORDS) return spelled;
  const replacement = REPLACED_BY[words[0] ?? ""];
  if (replacement) throw refuse(GenexCliRefusalCode.UseTool, GENEX_CLI_PROMPT.UseTool(spelled, replacement));
  throw refuse(GenexCliRefusalCode.Unavailable, GENEX_CLI_PROMPT.Unavailable(spelled));
}

/** The options as an object: an object parameter may arrive as its JSON text. */
function optionsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidOptions);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidOptions);
  return value as Record<string, unknown>;
}

/** A text value the CLI can only read as a value: bounded, one line, never a flag; empty only when `empty`. */
function textValue(name: string, value: unknown, max: number, empty = false): string {
  const ok = typeof value === "string" && (value.length > 0 || empty) && value.length <= max;
  if (ok && !CONTROL_CHARACTER.test(value) && !value.startsWith("-")) return value;
  throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue(name, GENEX_VALUE_RULE.Text(max)));
}

/** Each value of a repeated text flag, one text or a list of at most `count`. */
function textListValues(name: string, value: unknown, spec: { max: number; count: number }): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length > spec.count)
    throw refuse(
      GenexCliRefusalCode.InvalidValue,
      GENEX_CLI_PROMPT.InvalidValue(name, GENEX_VALUE_RULE.TextList(spec.count, spec.max)),
    );
  return values.map((one) => textValue(name, one, spec.max));
}

/**
 * A path inside the game, as text: relative to the game's folder, never through `..`, never the
 * folder itself. Where it really leads is the host's to check (`genex-game-paths.ts`).
 */
function gamePathValue(name: string, value: unknown, target: GamePathTarget): string {
  const rule = GENEX_VALUE_RULE.GamePath(target);
  const path = textValue(name, value, GAME_PATH_MAX_CHARS);
  const segments = path.split(/[/\\]+/).filter((segment) => segment !== "" && segment !== ".");
  const inside = !NOT_RELATIVE.test(path) && segments.length > 0 && !segments.includes("..");
  if (inside) return path;
  throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue(name, rule));
}

/** A whole number within its row's bounds; a digit string counts, 1.5 never does. */
function wholeNumberValue(name: string, value: unknown, spec: { min: number; max: number }): string {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n === "number" && Number.isInteger(n) && n >= spec.min && n <= spec.max) return String(n);
  throw refuse(
    GenexCliRefusalCode.InvalidValue,
    GENEX_CLI_PROMPT.InvalidValue(name, GENEX_VALUE_RULE.WholeNumber(spec.min, spec.max)),
  );
}

/** One option as argv: nothing for a false flag, `--no-x` for a false toggle. */
function optionArgv(name: string, value: unknown, spec: OptionSpec): string[] {
  const invalid = (rule: string) => refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue(name, rule));
  switch (spec.kind) {
    case OptionKind.Flag:
      if (typeof value !== "boolean") throw invalid(GENEX_VALUE_RULE.Flag);
      return value ? [`--${name}`] : [];
    case OptionKind.Toggle:
      if (typeof value !== "boolean") throw invalid(GENEX_VALUE_RULE.Toggle);
      return [value ? `--${name}` : `--no-${name}`];
    case OptionKind.WholeNumber:
      return [`--${name}`, wholeNumberValue(name, value, spec)];
    case OptionKind.Choice:
      if (typeof value !== "string" || !spec.values.includes(value))
        throw invalid(GENEX_VALUE_RULE.Choice(spec.values));
      return [`--${name}`, value];
    case OptionKind.Text:
      return [`--${name}`, textValue(name, value, spec.max, spec.empty)];
    case OptionKind.TextList:
      return textListValues(name, value, spec).flatMap((one) => [`--${name}`, one]);
    case OptionKind.GamePath:
      return [`--${name}`, gamePathValue(name, value, spec.target)];
  }
}

/** The options as argv and the game paths among them; reserved and unlisted names are refused. */
interface OptionsArgv {
  argv: string[];
  gamePaths: GamePathArg[];
}

/** Every option as argv, in the order given, after `before` words; reserved and unlisted names are refused. */
function optionsArgv(
  command: GenexCliCommand,
  row: CommandRow,
  options: Record<string, unknown>,
  before: number,
): OptionsArgv {
  const allowed = Object.keys(row.options);
  const argv: string[] = [];
  const gamePaths: GamePathArg[] = [];
  for (const [name, value] of Object.entries(options)) {
    if (RESERVED_FLAGS.has(name)) throw refuse(GenexCliRefusalCode.ReservedFlag, GENEX_CLI_PROMPT.ReservedFlag(name));
    const spec = row.options[name];
    if (!spec) throw refuse(GenexCliRefusalCode.UnknownOption, GENEX_CLI_PROMPT.UnknownOption(command, name, allowed));
    const words = optionArgv(name, value, spec);
    if (spec.kind === OptionKind.GamePath)
      gamePaths.push({ option: name, path: words[1] ?? "", target: spec.target, index: before + argv.length + 1 });
    argv.push(...words);
  }
  for (const name of row.required ?? [])
    if (options[name] === undefined)
      throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NeedsOption(command, name));
  return { argv, gamePaths };
}

/** The positional argument as argv, when the command takes one. */
function positionalArgv(command: GenexCliCommand, row: CommandRow, raw: unknown): string[] {
  const given = raw !== undefined && raw !== "";
  const takes = row.positional !== Positional.None;
  if (!takes && given) throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NoPositional(command));
  if (!takes) return [];
  if (!given) throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NeedsPositional(command));
  if (row.positional === Positional.ItemId && !isItemId(raw))
    throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue("args", GENEX_VALUE_RULE.ItemId));
  return [textValue("args", raw, POSITIONAL_MAX_CHARS)];
}

/** The option `budget` would set a spend allowance with, which no Studio run keeps. */
const BUDGET_ALLOWANCE_OPTION = "assets";

/**
 * The argv for one `genex__cli` or `genex__cli-paid` call, or a typed refusal. `tool.paid` says
 * which tool asked: a paid command never runs through the free tool (which asked nobody), and a
 * free one never through the paid tool (which asked for nothing).
 */
export function genexCliRequest(
  args: Record<string, unknown>,
  tool: { paid: boolean },
): GenexCliRequest & { command: GenexCliCommand } {
  const command = commandOf(args.command);
  const options = optionsOf(args.options);
  const row = GENEX_CLI_COMMANDS[command];
  const setsAllowance = command === GenexCliCommand.Budget && Object.hasOwn(options, BUDGET_ALLOWANCE_OPTION);
  if (setsAllowance) throw refuse(GenexCliRefusalCode.UnknownOption, GENEX_CLI_PROMPT.BudgetAllowance);
  if (row.paid && !tool.paid) throw refuse(GenexCliRefusalCode.PaidTool, GENEX_CLI_PROMPT.PaidTool(command));
  if (!row.paid && tool.paid) throw refuse(GenexCliRefusalCode.FreeTool, GENEX_CLI_PROMPT.FreeTool(command));
  const head = [...command.split(" "), ...positionalArgv(command, row, args.args)];
  const flags = optionsArgv(command, row, options, head.length);
  const argv = [...head, ...flags.argv, ...(row.paid && row.approval ? [USER_APPROVED_FLAG] : [])];
  return {
    command,
    argv,
    project: row.project,
    paid: row.paid,
    ...(flags.gamePaths.length > 0 ? { gamePaths: flags.gamePaths } : {}),
    ...(row.delivers ? { delivers: String(args.args) } : {}),
    ...(row.localItems ? { localItems: row.localItems } : {}),
  };
}

/** Studio's own upload of the game's local drafts after a publish: `genex shop sync`, never an agent's. */
export const localSyncRequest = (): GenexCliRequest => ({
  command: GenexHostCommand.ShopSync,
  argv: GenexHostCommand.ShopSync.split(" "),
  project: true,
  paid: false,
  localItems: LocalItemsUse.Sync,
});

/**
 * The person's "Other games can use it" on a local draft, run by main for them: `genex shop set
 * <localId> --shared|--no-shared`. Anything but a local id is refused before anything runs.
 */
export function localShareRequest(localId: string, shared: boolean): GenexCliRequest {
  if (!isLocalItemId(localId))
    throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue("args", GENEX_VALUE_RULE.LocalId));
  return {
    command: GenexCliCommand.ShopSet,
    argv: [...GenexCliCommand.ShopSet.split(" "), localId, shared ? "--shared" : "--no-shared"],
    project: true,
    paid: true,
    localItems: LocalItemsUse.Change,
  };
}

/** A value as the consent card shows it: one line, clipped. */
function consentValue(value: string): string {
  return value.length > CONSENT_VALUE_MAX_CHARS ? `${value.slice(0, CONSENT_VALUE_MAX_CHARS - 1)}…` : value;
}

/** Options whose value is words or a path the agent chose: the card lists them after the rest. */
const WORDS_KINDS: ReadonlySet<string> = new Set([OptionKind.Text, OptionKind.TextList, OptionKind.GamePath]);

/** The option names in the order the card lists them: the row's own order, words and paths last. */
function consentOrder(row: CommandRow): string[] {
  const names = Object.keys(row.options);
  const isWords = (name: string) => WORDS_KINDS.has(row.options[name]?.kind ?? "");
  return [...names.filter((name) => !isWords(name)), ...names.filter(isWords)];
}

/**
 * What the consent card shows for a `genex__cli-paid` call, made by Studio from the call it would
 * run: the command, then every option in the row's order (what it spends first, free text last),
 * then the agent's own positional text, each clipped. A call Studio would refuse throws here, so
 * nobody is asked about it.
 */
export function genexCliConsentArgs(args: Record<string, unknown>, tool: { paid: boolean }): Record<string, string> {
  const request = genexCliRequest(args, tool);
  const row = GENEX_CLI_COMMANDS[request.command];
  const options = optionsOf(args.options);
  const shown: Record<string, string> = { command: request.command };
  for (const name of consentOrder(row)) {
    const value = options[name];
    if (value !== undefined) shown[name] = consentValue(typeof value === "string" ? value : JSON.stringify(value));
  }
  if (row.positional !== Positional.None) shown.args = consentValue(String(args.args));
  return shown;
}
