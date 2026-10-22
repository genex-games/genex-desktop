/**
 * What the Roblox plugin's setup tools tell the agent that called them: done, or which of its own
 * tools does the next step. Setup is the agent's job: these words never hand the person a click
 * Genex can do, only what Roblox or macOS keep for a person (signing in, answering Studio's own
 * questions such as saving, and macOS's own prompts).
 */
import { agentTool, RobloxTool } from "./tools.ts";
import { MCP_SWITCH_CLICK_PATH, shortVersion } from "./words.ts";

const GET_STUDIO = agentTool(RobloxTool.GetStudio);
const SETUP = agentTool(RobloxTool.Setup);
const RESTART = agentTool(RobloxTool.RestartStudio);
const DO_IT = agentTool(RobloxTool.DoItForMe);
const OPEN = agentTool(RobloxTool.OpenStudio);
const PLACES = agentTool(RobloxTool.Places);
const USE = agentTool(RobloxTool.UseProject);
const NEW_GAME = agentTool(RobloxTool.NewGame);
const SHOW_STEPS = agentTool(RobloxTool.ShowSteps);
const ADD_LUAU = agentTool(RobloxTool.AddLuauChecks);

/** What Restart Studio does, as the agent passes it on. */
const RESTART_DOES = `${RESTART} quits Studio (Studio asks the person to save, as it always does), turns its MCP server on while it is closed and opens it again; the person approves it on a card`;

/** The one click left to the person where Genex can't click and Studio has no settings file to change. */
const PERSONS_CLICK = `If it answers that Studio has no settings file yet, that one click is the person's: tell them ${MCP_SWITCH_CLICK_PATH}.`;

/** The end of a started assist's answer: the turn that answers its message clicks, this one only if that is it. */
const CLICKING_TURN =
  "If that message is already in front of you in this turn, you are that turn: click it now with the desktop tool. Otherwise end this turn now and don't click anything yourself.";

export const SETUP_PROMPTS = {
  NotInstalled: `Roblox Studio isn't on this computer. Call ${GET_STUDIO}: it downloads Studio from Roblox (the person approves a card), installs and sets it up. Signing in to Roblox in the Studio that opens is the person's; Genex finishes the rest.`,
  NotOpen: `Roblox Studio isn't open. Call ${OPEN}, which opens this game's place; once Studio has started, retry.`,
  NotSetUp: `The Genex helper isn't in Roblox Studio yet, and Genex adds it only while Studio is closed. Call ${RESTART}: it quits Studio (Studio asks the person to save), sets it up and opens it again.`,
  NotSetUpClosed: `The Genex helper isn't in Roblox Studio yet. Call ${SETUP} while Studio is closed.`,
  Answering: "Roblox Studio's MCP server is on and answering Genex: there's nothing to switch on.",
  SwitchAlreadyOn: `Studio's MCP server is already on in its settings, so clicking can't help: Studio answers once a place is open and it has finished starting. With no place open, call ${OPEN}; if Studio shows its sign-in screen, the person signs in there (only they can).`,
  AssistStarted: `This chat's message "Roblox Studio asks: Turn on Studio's MCP server…" hands the click to the turn that answers it, with computer control. ${CLICKING_TURN}`,
  AssistUnavailable: `Genex can't click in Roblox Studio on this computer, so nothing was clicked. Instead, ${RESTART_DOES}. ${PERSONS_CLICK}`,
  AssistDeclined: `The person said no to computer control, so nothing was clicked. Without clicks, ${RESTART_DOES}. ${PERSONS_CLICK}`,
  AssistNoChat: "There's no game chat to click it from, so nothing was clicked.",
  AssistNotStarted: `Nothing was clicked. Instead, ${RESTART_DOES}. ${PERSONS_CLICK}`,
  InAssist: `This chat's Do it for me is already under way, so nothing more was posted. If its message ("Roblox Studio asks: …") is in front of you in this turn, you are the turn that clicks it: do its task now with the desktop tool on Roblox Studio. Otherwise end this turn.`,
  SetupDone: (words: string) => `${words} Once Studio is open with a place, its tools answer.`,
  SetupNoSettings: `The Genex helper is in Roblox Studio, but Studio hasn't saved its settings yet, so its MCP server is still off. Once Studio is open with a place, call ${DO_IT} to switch it on.`,
  SetupNoSettingsNoClick: `The Genex helper is in Roblox Studio, but Studio hasn't saved its settings yet, so its MCP server is still off, and Genex can't click in Studio on this computer. That one click is the person's: tell them ${MCP_SWITCH_CLICK_PATH}, with a place open in Studio.`,
  SetupStudioOpen: `Roblox Studio is open, and Genex changes its settings only while it is closed. ${RESTART_DOES}. When only the MCP switch is missing, ${DO_IT} clicks it instead, without closing Studio.`,
  NoRobloxFolder: `Studio hasn't made its Roblox folder yet (it does the first time it runs). Call ${OPEN}, let Studio start, then call ${RESTART}.`,
  SetupStopped: (words: string) => `Set up wrote nothing: ${words}`,
  Restarted: (words: string) => `${words} Once Studio has started, retry.`,
  StillOpen:
    "Roblox Studio is still open: it may be asking the person to save their place, which is theirs to answer. Ask them to answer Studio, then call this again.",
  Opened: (words: string) => words,
  Quit: "Roblox Studio closed; it asked to save anything unsaved first.",
  QuitInUse: (title: string) => `A build of ${title} is using Roblox Studio, so Genex leaves it open.`,
  QuitNotRunning: "Roblox Studio isn't open.",
  Getting: `Genex is getting Roblox Studio from Roblox. When Studio opens, the person signs in to Roblox there (only they can); Studio then closes by itself, and Genex sets it up and opens it again. ${SHOW_STEPS} shows them where it stands.`,
  AlreadyInstalled: (version: string | undefined) =>
    `Roblox Studio ${version ? `${shortVersion(version)} ` : ""}is already on this computer.`,
  Words: (words: string) => words,
  PlacesNote: `Link this game to one with ${USE} (a place open in Studio by its label, or a file by its full path); ask the person which when several could be theirs. ${NEW_GAME} makes a new one. Places in Documents that Studio didn't open lately aren't listed: macOS asks the person before Genex reads that folder.`,
  LuauAdded: (words: string) => `${words} Run check-scripts again.`,
  ChecksNotAdded: `Luau checks aren't added yet, so nothing was checked. Call ${ADD_LUAU}: it downloads them (the person approves a card); meanwhile read your changes over against the luau skill.`,
  /** The places tool's name, for other prompts. */
  Places: PLACES,
  AddLuau: ADD_LUAU,
} as const;
