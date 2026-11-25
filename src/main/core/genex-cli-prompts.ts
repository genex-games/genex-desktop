/** What an agent reads back from `genex__cli`, `genex__cli-paid` and `genex__package`. */

/** The Studio tools a refusal can point to instead. */
export const GenexStudioTool = {
  Cli: "genex__cli",
  CliPaid: "genex__cli-paid",
  Asset: "genex__asset",
  Publish: "genex__publish",
  Package: "genex__package",
} as const;
export type GenexStudioTool = (typeof GenexStudioTool)[keyof typeof GenexStudioTool];

/** Refusals and failures of a Studio-run Genex CLI command or package install. */
export const GENEX_CLI_PROMPT = {
  Unavailable: (command: string) =>
    `\`genex ${command}\` is not available in Studio. Available: doctor, budget, llm models, llm status, llm cancel, llm budget status, shop list, shop add, shop set|remove on a local draft, items list and items search through genex__cli; llm bench, llm budget set|clear, shop set|remove on an item in the store, shop test and items add|remove through genex__cli-paid. Studio puts the game's items on sale when it is published; items made before the game is on Genex wait as local drafts, and Studio uploads them after the publish. Say so rather than work around it.`,
  UseTool: (command: string, tool: GenexStudioTool) =>
    `\`genex ${command}\` is ${tool} in Studio: call that tool instead.`,
  PaidTool: (command: string) =>
    `\`genex ${command}\` spends Nex or credits, or changes what the game sells or offers its players on Genex: call genex__cli-paid, which asks the user first.`,
  FreeTool: (command: string) => `\`genex ${command}\` spends nothing: call genex__cli.`,
  ReservedFlag: (name: string) => `--${name} is set by Studio and cannot be passed.`,
  UnknownOption: (command: string, name: string, allowed: readonly string[]) =>
    `\`genex ${command}\` takes no ${name} option here. ${allowed.length ? `It takes: ${allowed.join(", ")}.` : "It takes no options."} Name flags without dashes; only image, model, package and schema name a file or folder, inside this game.`,
  /** `llm price` reads a file the CLI left in its folder, and no Studio run folder outlives its call. */
  NoSavedBench:
    "`genex llm price` is not available in Studio: it reprints the bench the CLI saved in the folder it ran in, and Studio runs every command in a fresh folder it removes afterwards, so there is never one to reprint. The numbers to declare are in the answer of llm bench (genex__cli-paid): write them into the game when you read them, and bench again only when the prompt, the schema or the model changed.",
  /** An option given under its current name and its old one, with two different values. */
  OptionsDisagree: (command: string, name: string, older: string, value: string, olderValue: string) =>
    `\`genex ${command}\` was given ${name} and its old name ${older} with different values (${value} and ${olderValue}). Pass ${name} alone; nothing was run.`,
  BudgetAllowance:
    "Studio does not set a Genex asset allowance: its own asset allowance and the user's consent govern asset spending. genex__cli budget shows the balance.",
  InvalidOptions: 'options must be an object of flags by name, for example {"all": true}.',
  InvalidValue: (name: string, rule: string) => `${name} ${rule}.`,
  NoPositional: (command: string) => `\`genex ${command}\` takes no positional argument; leave args out.`,
  NeedsPositional: (command: string) => `\`genex ${command}\` needs its positional argument in args.`,
  /** A command whose positional is one of its own words (`llm budget`), given another or none. */
  NeedsChoice: (command: string, choices: readonly string[]) =>
    `\`genex ${command}\` takes exactly one of these in args: ${choices.join(", ")}.`,
  /** The pinned CLI is older than `llm budget`: what is true, and what to tell the person. */
  BudgetNeedsUpdate:
    "This version of Genex cannot declare an AI budget yet: it will after an update of Genex, and until then nothing needs declaring for the game to be played in the Unreal editor, where Genex answers its AI calls. Tell the person so; nothing was run.",
  /** A file the game's AI budget is read from that Studio does not read: the command ran without it. */
  BudgetFileNotPlain: (file: string) =>
    `Studio read no AI budget from this game: its ${file} is not a plain file of the game's own folder (it is a link, a folder or a file Studio may not open). The command ran as if the game's folder declared none. Make ${file} a plain file there, then run the command again.`,
  BudgetFileTooLarge: (file: string, kilobytes: number) =>
    `Studio read no AI budget from this game: its ${file} is larger than ${kilobytes} KB, the most Studio reads for it. The command ran as if the game's folder declared none. Shorten ${file}, then run the command again.`,
  /** A declaration that holds more than Studio copies. */
  BudgetTooLarge: (key: string, file: string, kilobytes: number) =>
    `${key} in ${file} is larger than ${kilobytes} KB, the most Studio takes for a game's AI budget. Shorten it; nothing was run.`,
  NeedsOption: (command: string, name: string) => `\`genex ${command}\` needs the ${name} option.`,
  NeedsPicture:
    "A store item is listed with its picture, never without: a square PNG of at least 768 × 768 (1024 × 1024 is best) that the item fills edge to edge, made by any means (genex__asset image among them), saved under .genex/scratch/; then call shop add again with the image option.",
  /** A picture that would not fill its card: its size, and what a card takes. */
  PictureShape: (given: string, width: number, height: number) =>
    `image ${JSON.stringify(given)} is ${width} × ${height}: a store item's picture is square, at least 768 × 768 (1024 × 1024 is best), and fills its card edge to edge. Render it again at that size with the item filling the frame; nothing was run.`,
  PictureNotImage: (given: string) =>
    `image ${JSON.stringify(given)} is not a PNG or WebP picture. Save the render as a square PNG of at least 768 × 768; nothing was run.`,
  Locked: "Genex is locked: ask the user to unlock Genex in Studio's Plugins page, then try again.",
  NoDraft:
    'This game has no hosted Genex project yet. Publish a draft first with genex__publish {"operation":"draft"}, then run the command again.',
  TimedOut: (command: string, seconds: number) =>
    `\`genex ${command}\` did not finish within ${seconds} seconds and was stopped. Check with genex__cli before repeating anything that spends.`,
  Stopped: (command: string) => `\`genex ${command}\` was stopped before it finished.`,
  UnknownPackage: (name: string, allowed: readonly string[]) =>
    `${name} is not a package genex__package adds. It adds: ${allowed.join(", ")}.`,
  NoPackageJson:
    "This game has its own page but no package.json, and is not made from Studio's template, so there is nothing to add Genex packages to: genex__package needs a package.json.",
  GodotGame:
    "This is a Godot game: Genex's multiplayer goes into its Godot project with godot__multiplayer (read the godot-multiplayer skill first), and its web build is Godot's export, which takes no npm packages. Its players' sign-in on Genex is Studio's: nothing to add for it.",
  UnityGame:
    "This is a Unity game: Genex's multiplayer goes into its Unity project with unity__multiplayer (read the unity-multiplayer skill first), and its WebGL build is Unity's, which takes no npm packages. Its players' sign-in on Genex is Studio's: nothing to add for it.",
  TemplatePageUnreadable:
    "This game's index.html has no import map Studio can read, so nothing was added: genex__package adds its entries to the page's import map.",
  TemplateSdkMapped: [
    "index.html now maps @genex-ai/embed-sdk to Studio's copy (/vendor/genex/embed-sdk/index.js) and loads Studio's connect module (/vendor/genex/connect.js) right after its import map. Keep both.",
    'Studio connects the game: in the preview in local test mode, and on Genex to the game\'s project when it is published. Import what you need from "@genex-ai/embed-sdk" (waitForPlayer, loadPlayerState, savePlayerState, submitScore, getLeaderboard) and never call initEmbed() yourself.',
  ],
  TemplateMultiplayerMapped: [
    "index.html now maps @genex-ai/multiplayer and @genex-ai/multiplayer/schema to Studio's copies (/vendor/genex/multiplayer/), @genex-ai/embed-sdk to Studio's copy (/vendor/genex/embed-sdk/index.js), and loads Studio's connect module (/vendor/genex/connect.js) right after its import map. Keep all of them. Nothing was downloaded.",
    'Studio connects the game: never call initEmbed() yourself. Import the rest exactly as the card shows, in plain JavaScript: waitForPlayer, getColyseusAuth and getColyseusUrls from "@genex-ai/embed-sdk", connect() from "@genex-ai/multiplayer". The preview runs in Genex local test mode, where connect() and matchmake() fail: test multiplayer on a published draft.',
  ],
  ForeignFolder:
    "This call is not bound to the game's own folder or one of its Studio worktrees; nothing was installed, read or written.",
  /** A path option that, by its real path, does not lead to what it should inside the game. */
  GamePathOutside: (name: string, given: string) =>
    `${name} ${JSON.stringify(given)} leads outside this game's folder (through ../ or a link). Name a file or folder inside the game; nothing was run.`,
  GamePathMissing: (name: string, given: string) =>
    `${name} ${JSON.stringify(given)} names nothing in this game's folder. Make it first, then run the command again; nothing was run.`,
  GamePathNotFile: (name: string, given: string) =>
    `${name} ${JSON.stringify(given)} is not a file in this game: it takes one file (a .png or .webp picture, a .glb model). Nothing was run.`,
  GamePathNotFolder: (name: string, given: string) =>
    `${name} ${JSON.stringify(given)} is not a folder in this game: it takes the folder of files other games' agents read. Nothing was run.`,
  GamePathTooLarge: (name: string, files: number, megabytes: number) =>
    `${name} holds more than ${files} files or ${megabytes} MB, which Genex does not take for an item. Keep only what another game's agent needs; nothing was run.`,
  /** A small file the CLI reads (a bench's answer shape) that is not one file of its kind, or holds too much. */
  SmallFileNotFile: (name: string, given: string, extension: string) =>
    `${name} ${JSON.stringify(given)} is not a file in this game: it takes one ${extension} file. Nothing was run.`,
  SmallFileWrongKind: (name: string, given: string, extension: string) =>
    `${name} ${JSON.stringify(given)} is not a ${extension} file in this game (it is a link to a file of another kind). Name the ${extension} file itself; nothing was run.`,
  SmallFileTooLarge: (name: string, given: string, kilobytes: number) =>
    `${name} ${JSON.stringify(given)} is larger than ${kilobytes} KB, the most Genex takes for it. Shorten it; nothing was run.`,
  /** `items add` ran, but its folder could not go into the game. */
  ItemNotDelivered: (itemId: string, why: string) =>
    `The item ${itemId} is added to this game on Genex, but Studio wrote nothing to genex-items/${itemId}/ in it: ${why} Fix that, then run items add ${itemId} again.`,
  ItemFolderLink: (where: string) => `${where} is a link or a file, not a folder. Move it aside first.`,
  ItemFolderMissing: "the Genex CLI wrote no item folder.",
  ItemFolderUnwritable: "the game's folder could not be written.",
  ItemFolderEntry: (entry: string) =>
    `the item folder holds ${JSON.stringify(entry)}, which is not a file or a folder.`,
  /** A local `shop add|set|remove` ran, but what it changed could not go into the game's `.genex/items/`. */
  LocalDraftsNotCarried: (why: string) =>
    `The Genex CLI changed this game's local item drafts, but Studio wrote nothing to .genex/items/ in it: ${why} Fix that, then run the command again.`,
  LocalDraftsLink: (where: string) => `${where} is a link or a file, not a folder. Move it aside first.`,
  LocalDraftUnclean: (localId: string) => `the draft ${localId} holds a link, a folder or more than a draft holds.`,
} as const;

/** How each value rule reads in a refusal. */
export const GENEX_VALUE_RULE = {
  Flag: "is a flag: pass true, or leave it out",
  Toggle: "takes true or false",
  WholeNumber: (min: number, max: number) =>
    max === Number.MAX_SAFE_INTEGER
      ? `takes a whole number, ${min} or more`
      : `takes a whole number from ${min} to ${max}`,
  Choice: (values: readonly string[]) => `takes one of ${values.join(", ")}`,
  Text: (max: number) =>
    `takes text of at most ${max} characters, with no line breaks or control characters, not starting with -`,
  TextList: (count: number, max: number) =>
    `takes one text or a list of at most ${count}, each at most ${max} characters, with no line breaks or control characters, not starting with -`,
  GamePath: (target: string) =>
    `takes a ${target === "folder" ? "folder" : "file"} inside this game, relative to its folder (for example .genex/scratch/frost-axe.png), never an absolute path, ~ or ..`,
  SmallGameFile: (extension: string) =>
    `takes a ${extension} file inside this game, relative to its folder (for example answer.schema${extension}), never an absolute path, ~ or ..`,
  ItemId: "takes one store item id, as genex items search or Browse shows it (letters, digits, - and _)",
  LocalId: "takes one local draft id, as genex shop add printed it (local_ and 12 lowercase letters or digits)",
} as const;
