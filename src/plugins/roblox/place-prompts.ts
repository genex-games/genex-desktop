/**
 * What the Roblox plugin's place tools tell agents: the engine question's words for Roblox (the
 * `engine-status` note) and the answers of `new-game`, `use-project` and `show-steps`.
 */
import { agentTool, RobloxTool } from "./tools.ts";
import { shortVersion } from "./words.ts";

/** The tools these words name, as the host serves them to agents. */
const NEW_GAME = agentTool(RobloxTool.NewGame);
const GET_STUDIO = agentTool(RobloxTool.GetStudio);
const OPTION = `"Roblox game: builds in Roblox Studio on this computer"`;

export const PLACE_PROMPTS = {
  /** The engine question's words while Studio is on this computer. */
  Ready: (version: string | undefined) =>
    `${version ? `Roblox Studio ${shortVersion(version)} is on this computer. ` : ""}Offer ${OPTION}; when the answer (or the request) is Roblox, call ${NEW_GAME}: it makes the game's place in this folder, links this game to it and opens it in Roblox Studio; then build the game there through the Roblox Studio tools, never as a web page.`,
  /** The engine question's words while Studio isn't on this computer. */
  NotInstalled: `Roblox Studio isn't on this computer yet, so offer it as ${OPTION} with the description "Needs Roblox Studio and a Roblox account". If the user picks it, call ${GET_STUDIO} first (it gets Studio from Roblox and sets it up once they approve its card; they sign in to Roblox when Studio opens), then ${NEW_GAME} once Studio is on this computer.`,
  NewGame: (name: string) =>
    `Made ${name} in this game's folder from Genex's Baseplate, linked this game to it and opened it in Roblox Studio. Studio takes a moment to start; once the Roblox Studio tools answer, build the game there.`,
  NewGameNotOpened: (name: string, why: string) =>
    `Made ${name} in this game's folder and linked this game to it, but Roblox Studio didn't open: ${why}`,
  NoGame: "New Roblox games are made in an open game: there is none here.",
  NoStudio: `Roblox Studio isn't on this computer. Call ${GET_STUDIO}: Genex gets it from Roblox once the person approves its card.`,
  StepsDone: "Every Roblox Studio step is done.",
  StepsShown: `The Roblox Studio setup card is in the chat now. Do the steps left yourself with this plugin's tools (${GET_STUDIO}, ${agentTool(RobloxTool.Setup)}, ${agentTool(RobloxTool.RestartStudio)}, ${agentTool(RobloxTool.OpenStudio)}, ${agentTool(RobloxTool.DoItForMe)}, ${agentTool(RobloxTool.Places)} and ${agentTool(RobloxTool.UseProject)}); only signing in to Roblox is the person's.`,
  StepsNoChat: "There is no chat to show the Roblox Studio setup card in.",
  /** `use-project` named a file in a folder macOS asks the person about before Genex reads it. */
  Guarded: `That place is in a folder macOS asks the person about before Genex reads it, so Genex didn't read it. If it is open in Roblox Studio, call ${agentTool(RobloxTool.Places)} and link it by its label with ${agentTool(RobloxTool.UseProject)} instead. If it isn't, opening it in Studio is the person's (only they can let Genex into that folder): ask them to open it there, then link it by its label.`,
} as const;
