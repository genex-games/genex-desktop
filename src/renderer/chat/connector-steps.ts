/**
 * A connector call as a step the chat can name: what it did (a Blueprint written, an actor
 * placed, a screenshot taken, play started), what it did it to, and whether its pictures are play
 * views. Keyed on the exact names Epic's Unreal MCP and the Genex editor helper answer to, as the
 * call's record carries them (`shared/mcp.ts` `ConnectorCall`); `words.ts` turns a step into
 * words. Pure.
 */
import type { ConnectorCall } from "../../shared/mcp.ts";

/** What a step did, whatever tool did it. */
export const StepAction = {
  WroteBlueprint: "wrote-blueprint",
  MadeBlueprint: "made-blueprint",
  CompiledBlueprint: "compiled-blueprint",
  ReadBlueprint: "read-blueprint",
  EditedBlueprint: "edited-blueprint",
  LookedUpNodes: "looked-up-nodes",
  ReadGuide: "read-guide",
  Placed: "placed",
  AddedShape: "added-shape",
  Removed: "removed",
  Moved: "moved",
  OpenedLevel: "opened-level",
  LookedAtLevel: "looked-at-level",
  LookedUpAssets: "looked-up-assets",
  SavedAssets: "saved-assets",
  MadeMaterial: "made-material",
  ImportedAsset: "imported-asset",
  RanScript: "ran-script",
  Played: "played",
  StoppedPlay: "stopped-play",
  CheckedPlay: "checked-play",
  Screenshot: "screenshot",
  PlayShot: "play-shot",
  HeroShot: "hero-shot",
  MotionStrip: "motion-strip",
  ListedCameras: "listed-cameras",
  ViewportShot: "viewport-shot",
  PictureOf: "picture-of",
  ReadLog: "read-log",
  HeldInput: "held-input",
  LetGo: "let-go",
  ReadPlayer: "read-player",
  ReadControls: "read-controls",
  AppliedPart: "applied-part",
  Retargeted: "retargeted",
  Audited: "audited",
  SetRoute: "set-route",
  LaidTerrain: "laid-terrain",
  Settled: "settled",
  DroveRoute: "drove-route",
  MeasuredRoute: "measured-route",
  CheckedProject: "checked-project",
  ListedToolsets: "listed-toolsets",
  ReadToolset: "read-toolset",
  /** A tool the table does not know: the row names its toolset and tool. */
  Other: "other",
} as const;
export type StepAction = (typeof StepAction)[keyof typeof StepAction];

/** A toolset gateway's own tools (Epic's Unreal MCP), called without a toolset. */
const GatewayTool = {
  ListToolsets: "list_toolsets",
  DescribeToolset: "describe_toolset",
} as const;

/** A step: its action, what it acted on, how many when it named a list, and the names it came by. */
export interface ConnectorStep {
  action: StepAction;
  object?: string;
  count?: number;
  /** The toolset's class name (`BlueprintTools`), or the connector's own tool's when it has none. */
  toolset?: string;
  tool: string;
}

type Args = Record<string, unknown>;
type StepRule = { action: StepAction; object?: (args: Args) => string | undefined; count?: (args: Args) => number };

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** An object reference's path: `{refPath}` as Epic's tools take it, or the path itself. */
const refPath = (value: unknown): string | undefined =>
  value && typeof value === "object" ? text((value as { refPath?: unknown }).refPath) : text(value);

/** An asset's name from its path: `/Game/Valley/BP_Lamp.BP_Lamp:EventGraph` → `BP_Lamp`. */
function assetName(value: unknown): string | undefined {
  const path = refPath(value);
  const last = path?.split("/").pop();
  return last ? (last.split(/[.:]/)[0] ?? last) || undefined : undefined;
}

/** An actor's name from its path: the last part after the level (`…:PersistentLevel.BP_Lamp_3` → `BP_Lamp_3`). */
function actorName(value: unknown): string | undefined {
  const path = refPath(value);
  return path ? path.split(/[.:/]/).pop() || undefined : undefined;
}

const listLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const asset = (key: string) => (args: Args) => assetName(args[key]);
const actor = (key: string) => (args: Args) => actorName(args[key]);
const named = (key: string) => (args: Args) => text(args[key]);

/**
 * Epic's common tools and the Genex editor helper's, by `<toolset class>.<tool>` as the record
 * names them. Anything else falls back to its toolset and tool.
 */
const STEPS: Readonly<Record<string, StepRule>> = {
  "BlueprintTools.write_graph_dsl": { action: StepAction.WroteBlueprint, object: asset("graph") },
  "BlueprintTools.create": { action: StepAction.MadeBlueprint, object: named("asset_name") },
  "BlueprintTools.compile_blueprint": { action: StepAction.CompiledBlueprint, object: asset("blueprint") },
  "BlueprintTools.read_graph_dsl": { action: StepAction.ReadBlueprint, object: asset("graph") },
  "BlueprintTools.add_variable": { action: StepAction.EditedBlueprint, object: asset("blueprint") },
  "BlueprintTools.add_function_graph": { action: StepAction.EditedBlueprint, object: asset("blueprint") },
  "BlueprintTools.add_event": { action: StepAction.EditedBlueprint, object: asset("graph") },
  "BlueprintTools.create_node": { action: StepAction.EditedBlueprint, object: asset("graph") },
  "BlueprintTools.connect_pins": { action: StepAction.EditedBlueprint },
  "BlueprintTools.set_pin_value": { action: StepAction.EditedBlueprint },
  "BlueprintTools.find_node_types": { action: StepAction.LookedUpNodes },
  "BlueprintTools.find_nodes": { action: StepAction.LookedUpNodes },
  "BlueprintTools.get_node_type_pins": { action: StepAction.LookedUpNodes },
  "BlueprintTools.find_node_categories": { action: StepAction.LookedUpNodes },
  "BlueprintTools.get_graph_dsl_docs": { action: StepAction.ReadGuide },
  "SceneTools.add_to_scene_from_asset": {
    action: StepAction.Placed,
    object: (args) => text(args.name) ?? assetName(args.asset_path),
  },
  "SceneTools.add_to_scene_from_class": { action: StepAction.Placed, object: (args) => text(args.name) },
  "SceneTools.remove_from_scene": { action: StepAction.Removed, object: actor("actor") },
  "SceneTools.load_level": { action: StepAction.OpenedLevel, object: (args) => assetName(args.level ?? args.path) },
  "SceneTools.get_current_level": { action: StepAction.LookedAtLevel },
  "SceneTools.find_actors": { action: StepAction.LookedAtLevel },
  "SceneTools.get_actors_in_folder": { action: StepAction.LookedAtLevel },
  "ActorTools.set_actor_transform": { action: StepAction.Moved, object: actor("actor") },
  "PrimitiveTools.add_cube": { action: StepAction.AddedShape },
  "PrimitiveTools.add_sphere": { action: StepAction.AddedShape },
  "PrimitiveTools.add_cylinder": { action: StepAction.AddedShape },
  "PrimitiveTools.add_cone": { action: StepAction.AddedShape },
  "AssetTools.find_assets": { action: StepAction.LookedUpAssets },
  "AssetTools.list_folders": { action: StepAction.LookedUpAssets },
  "AssetTools.exists": { action: StepAction.LookedUpAssets },
  "AssetTools.save_assets": { action: StepAction.SavedAssets, count: (args) => listLength(args.asset_paths) },
  "MaterialTools.create_material": { action: StepAction.MadeMaterial, object: named("asset_name") },
  "ProgrammaticToolset.execute_tool_script": { action: StepAction.RanScript },
  "EditorAppToolset.StartPIE": { action: StepAction.Played },
  "EditorAppToolset.StopPIE": { action: StepAction.StoppedPlay },
  "EditorAppToolset.IsPIERunning": { action: StepAction.CheckedPlay },
  "EditorAppToolset.CaptureEditorImage": { action: StepAction.Screenshot },
  "EditorAppToolset.CaptureViewport": { action: StepAction.ViewportShot },
  "EditorAppToolset.CaptureAssetImage": { action: StepAction.PictureOf, object: asset("assetPath") },
  "LogsToolset.GetLogEntries": { action: StepAction.ReadLog },
  "GenexPlayTools.hold": { action: StepAction.HeldInput, object: named("name") },
  "GenexPlayTools.release_all": { action: StepAction.LetGo },
  "GenexPlayTools.player_state": { action: StepAction.ReadPlayer },
  "GenexPlayTools.list_actions": { action: StepAction.ReadControls },
  "GenexPlayTools.settle": { action: StepAction.Settled },
  "GenexPlayTools.drive_route": { action: StepAction.DroveRoute },
  "GenexPlayTools.probe_route": { action: StepAction.MeasuredRoute },
  "GenexPlayTools.project_file": { action: StepAction.CheckedProject },
  "GenexBuildTools.set_route": { action: StepAction.SetRoute },
  "GenexBuildTools.track_terrain": { action: StepAction.LaidTerrain },
  "GenexBuildTools.dirt_material": { action: StepAction.MadeMaterial, object: named("name") },
  "GenexBuildTools.run_script": { action: StepAction.RanScript, object: named("file") },
  "GenexBuildTools.shot_cameras": { action: StepAction.ListedCameras },
  "GenexBuildTools.capture_shot": { action: StepAction.HeroShot, object: named("camera") },
  "GenexBuildTools.capture_play": { action: StepAction.PlayShot },
  "GenexBuildTools.motion_strip": { action: StepAction.MotionStrip },
  "GenexBuildTools.import_model": { action: StepAction.ImportedAsset, object: named("name") },
  "GenexBuildTools.import_character": { action: StepAction.ImportedAsset, object: named("name") },
  "GenexBuildTools.import_animation": { action: StepAction.ImportedAsset, object: named("name") },
  "GenexBuildTools.import_sound": { action: StepAction.ImportedAsset, object: named("name") },
  "GenexBuildTools.retarget": { action: StepAction.Retargeted },
  "GenexBuildTools.attach_to_socket": { action: StepAction.EditedBlueprint, object: asset("target") },
  "GenexBuildTools.attach_mesh": { action: StepAction.EditedBlueprint, object: asset("blueprint") },
  "GenexBuildTools.audit": { action: StepAction.Audited },
  // The helper's older loop toolset, which agents are refused: kept so its records still read.
  "GenexLoopTools.capture_play": { action: StepAction.PlayShot },
  "GenexLoopTools.stop_play": { action: StepAction.StoppedPlay },
  "GenexLoopTools.play_state": { action: StepAction.CheckedPlay },
  "GenexLoopTools.apply_part": { action: StepAction.AppliedPart, object: named("part") },
  "GenexLoopTools.import_asset": { action: StepAction.ImportedAsset, object: named("name") },
};

/** A dotted Python or C++ path's last part: `editor_toolset.toolsets.blueprint.BlueprintTools` → `BlueprintTools`. */
const className = (toolset: string): string => toolset.split(".").pop() || toolset;

/** The step a connector call's record describes. */
export function connectorStep(
  call: Partial<Pick<ConnectorCall, "tool" | "toolset" | "toolName" | "args">>,
): ConnectorStep {
  const toolset = call.toolset ? className(call.toolset) : undefined;
  const tool = call.toolName ?? call.tool ?? "";
  if (!call.toolName) return gatewayStep(tool, toolset);
  const rule = toolset ? STEPS[`${toolset}.${tool}`] : undefined;
  if (!rule) return { action: StepAction.Other, tool, ...(toolset ? { toolset } : {}) };
  const args = call.args ?? {};
  const object = rule.object?.(args);
  const count = rule.count?.(args);
  return {
    action: rule.action,
    tool,
    ...(toolset ? { toolset } : {}),
    ...(object ? { object } : {}),
    ...(count ? { count } : {}),
  };
}

/** A gateway's own tool (listing or describing toolsets), or a connector's plain tool. */
function gatewayStep(tool: string, toolset: string | undefined): ConnectorStep {
  if (tool === GatewayTool.ListToolsets) return { action: StepAction.ListedToolsets, tool };
  if (tool === GatewayTool.DescribeToolset && toolset) return { action: StepAction.ReadToolset, object: toolset, tool };
  return { action: StepAction.Other, tool };
}

/** A step that starts a play session, and one that ends it. */
export const startsPlay = (step: ConnectorStep): boolean => step.action === StepAction.Played;
export const endsPlay = (step: ConnectorStep): boolean => step.action === StepAction.StoppedPlay;

/** The steps whose pictures are always play views: the helper's play shot and its motion strip. */
const PLAY_VIEWS: ReadonlySet<StepAction> = new Set([StepAction.PlayShot, StepAction.MotionStrip]);

/**
 * Whether a step's pictures are play views, for the work's strip: the helper's own play shot and
 * motion strip, or the editor window while a play session runs. The editor camera, a hero
 * camera's still, an asset's picture and the editor window at rest stay in their row.
 */
export function showsPlayView(step: ConnectorStep, playing: boolean): boolean {
  return PLAY_VIEWS.has(step.action) || (step.action === StepAction.Screenshot && playing);
}
