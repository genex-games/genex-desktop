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
    `\`genex ${command}\` is not available in Studio. Available: doctor, budget, llm models, llm status, llm cancel and shop list through genex__cli; llm bench and shop add|set|remove|test through genex__cli-paid. Say so rather than work around it.`,
  UseTool: (command: string, tool: GenexStudioTool) =>
    `\`genex ${command}\` is ${tool} in Studio: call that tool instead.`,
  PaidTool: (command: string) =>
    `\`genex ${command}\` spends coin or credits or changes what the game sells: call genex__cli-paid, which asks the user first.`,
  FreeTool: (command: string) => `\`genex ${command}\` spends nothing: call genex__cli.`,
  ReservedFlag: (name: string) => `--${name} is set by Studio and cannot be passed.`,
  UnknownOption: (command: string, name: string, allowed: readonly string[]) =>
    `\`genex ${command}\` takes no ${name} option here. ${allowed.length ? `It takes: ${allowed.join(", ")}.` : "It takes no options."} Name flags without dashes; a flag that names a file cannot be read in Studio.`,
  BudgetAllowance:
    "Studio does not set a Genex asset allowance: its own asset allowance and the user's consent govern asset spending. genex__cli budget shows the balance.",
  InvalidOptions: 'options must be an object of flags by name, for example {"all": true}.',
  InvalidValue: (name: string, rule: string) => `${name} ${rule}.`,
  NoPositional: (command: string) => `\`genex ${command}\` takes no positional argument; leave args out.`,
  NeedsPositional: (command: string) => `\`genex ${command}\` needs its positional argument in args.`,
  NeedsOption: (command: string, name: string) => `\`genex ${command}\` needs the ${name} option.`,
  Locked: "Genex is locked: ask the user to unlock Genex in Studio's Plugins page, then try again.",
  NoDraft:
    'This game has no hosted Genex project yet. Publish a draft first with genex__publish {"operation":"draft"}, then run the command again.',
  TimedOut: (command: string, seconds: number) =>
    `\`genex ${command}\` did not finish within ${seconds} seconds and was stopped. Check with genex__cli before repeating anything that spends.`,
  Stopped: (command: string) => `\`genex ${command}\` was stopped before it finished.`,
  UnknownPackage: (name: string, allowed: readonly string[]) =>
    `${name} is not a package genex__package adds. It adds: ${allowed.join(", ")}.`,
  NoPackageJson:
    "This game has its own page but no package.json, and is not made from Studio's template, so there is nothing to add Genex packages to. Give it one with a build (npm init, then a bundler such as Vite), then call genex__package again.",
  GodotGame:
    "This is a Godot game: Genex's multiplayer goes into its Godot project with godot__multiplayer (read the godot-multiplayer skill first), and its web build is Godot's export, which takes no npm packages. Its players' sign-in on Genex is Studio's: nothing to add for it.",
  UnityGame:
    "This is a Unity game: Genex's multiplayer goes into its Unity project with unity__multiplayer (read the unity-multiplayer skill first), and its WebGL build is Unity's, which takes no npm packages. Its players' sign-in on Genex is Studio's: nothing to add for it.",
  TemplatePageUnreadable:
    "This game's index.html has no import map Studio can read, so nothing was added. Restore the template's import map (three from /vendor/) and try again.",
  TemplateSdkMapped: [
    "index.html now maps @genex-ai/embed-sdk to Studio's copy (/vendor/genex/embed-sdk/index.js) and loads Studio's connect module (/vendor/genex/connect.js) right after its import map. Keep both.",
    'Studio connects the game: in the preview in local test mode, and on Genex to the game\'s project when it is published. Import what you need from "@genex-ai/embed-sdk" (waitForPlayer, loadPlayerState, savePlayerState, submitScore, getLeaderboard) and never call initEmbed() yourself.',
  ],
  TemplateMultiplayerMapped: [
    "index.html now maps @genex-ai/multiplayer and @genex-ai/multiplayer/schema to Studio's copies (/vendor/genex/multiplayer/), @genex-ai/embed-sdk to Studio's copy (/vendor/genex/embed-sdk/index.js), and loads Studio's connect module (/vendor/genex/connect.js) right after its import map. Keep all of them. Nothing was downloaded.",
    'Studio connects the game: never call initEmbed() yourself. Import the rest exactly as the card shows, in plain JavaScript: waitForPlayer, getColyseusAuth and getColyseusUrls from "@genex-ai/embed-sdk", connect() from "@genex-ai/multiplayer". The preview runs in Genex local test mode, where connect() and matchmake() fail: test multiplayer on a published draft.',
  ],
  ForeignFolder:
    "This call is not bound to the game's own folder or one of its Studio worktrees; nothing was installed.",
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
} as const;
