/**
 * The tools plugin.json declares, named once for the backend, its prompts and the Roblox Studio
 * connection's answers. Every panel action the person can press is also a tool an agent can call,
 * under the action's own name.
 */
import { EnginePlayTool } from "../../shared/engine-play.ts";
import { RobloxAction } from "./actions.ts";
import { RobloxProbe } from "./probes.ts";
import { AskFirstTool } from "./studio-tools.ts";

/** This plugin's id, as the host prefixes its tools for agents. */
const PLUGIN_ID = "roblox";

/** The tools plugin.json declares. Wire values: never rename. */
export const RobloxTool = {
  StudioActivity: "studio-activity",
  CheckScripts: "check-scripts",
  LuauNote: "luau-note",
  LuauFinish: "luau-finish",
  UseProject: "use-project",
  ShowSteps: "show-steps",
  NewGame: "new-game",
  EngineStatus: "engine-status",
  OpenForRun: "open-for-run",
  SavePlace: "save-place",
  HeroShots: "hero-shots",
  LoadPlace: "load-place",
  StudioState: "studio-state",
  StudioCrashNote: "studio-crash-note",
  TeamNote: "team-note",
  PlayOpen: EnginePlayTool.Open,
  PlayInput: EnginePlayTool.Input,
  PlayShot: EnginePlayTool.Shot,
  PlayState: EnginePlayTool.State,
  PlayPause: EnginePlayTool.Pause,
  PlayClose: EnginePlayTool.Close,
  PlayersState: RobloxProbe.PlayersState,
  CheatRemotes: RobloxProbe.CheatRemotes,
  PhoneCheck: RobloxProbe.PhoneCheck,
  GenerateMesh: AskFirstTool.GenerateMesh,
  GenerateModel: AskFirstTool.GenerateModel,
  GenerateTexture: AskFirstTool.GenerateTexture,
  GenerateMaterial: AskFirstTool.GenerateMaterial,
  SegmentMesh: AskFirstTool.SegmentMesh,
  RobloxPlaytest: AskFirstTool.RobloxPlaytest,
  RobloxExplore: AskFirstTool.RobloxExplore,
  UploadImage: AskFirstTool.UploadImage,
  StoreImage: AskFirstTool.StoreImage,
  InsertAsset: AskFirstTool.InsertAsset,
  CheckModel: "check-model",
  ImportModel: "import-model",
  /** The publishing turn's word on how its publish ended, for Studio's publishing card. */
  PublishResult: "publish-result",
  PublishUpdate: RobloxAction.PublishUpdate,
  FirstPublish: RobloxAction.FirstPublish,
  Setup: RobloxAction.Setup,
  UndoSetup: RobloxAction.UndoSetup,
  RestartStudio: RobloxAction.RestartStudio,
  DoItForMe: RobloxAction.DoItForMe,
  GetStudio: RobloxAction.GetStudio,
  CancelGetStudio: RobloxAction.CancelGetStudio,
  OpenStudio: RobloxAction.OpenStudio,
  QuitStudio: RobloxAction.QuitStudio,
  Places: RobloxAction.Places,
  AddLuauChecks: RobloxAction.AddLuauChecks,
  FinishSetup: RobloxAction.FinishSetup,
} as const;
export type RobloxTool = (typeof RobloxTool)[keyof typeof RobloxTool];

/** A tool as agents call it: `roblox__<tool>`. */
export const agentTool = (tool: RobloxTool): string => `${PLUGIN_ID}__${tool}`;
