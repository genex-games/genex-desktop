/**
 * Genex's bridge to the person's open Unity editor: an MCP server whose three tools carry the
 * commands of Unity's Pipeline package (`pipeline.ts`) for one game. `list_commands` reads the
 * editor's own catalogue, `describe_command` one command's parameters, `run_command` runs one by
 * name. Every call goes to the editor that has this game's own Unity project open, found by the
 * project's folder, and first passes the gate (`pipeline-gate.ts`) against that editor's catalogue,
 * so a command agents never run, or a file outside the game, is refused before it is sent. The tools
 * are listed before an editor is open; a call then says what stands in the way in words that name
 * the fix. The bridge holds no session between calls, so an editor restarted between two calls
 * just answers the next one.
 *
 * Before a command is sent, the bridge looks at the editor's main thread: one that runs nothing
 * (a long import, or a dialog nobody answered) gets the call answered at once, instead of a
 * command queued behind it for a minute. A save Unity would have to ask a file name for is never
 * sent: its system save panel is a dialog Pipeline itself does not see, and it stalls the editor
 * until a person answers. A captured picture is handed over as an image, not as its base64 text.
 * While a play the agent started runs, the bridge keeps a marker (`agent-play.ts`), so the editor
 * lock tells the agent's play from the person's, and it notes each command it sends, so an editor
 * an agent still uses is never taken for idle (`editor-idle.ts`). A capture that names no size is
 * taken at the size of Genex's own looks at the game.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ENGINE_PLAY_VIEW } from "../../shared/engine-play.ts";
import { CONNECTOR_OUTCOME_META } from "../../shared/mcp.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { type AgentPlayMarker, NO_AGENT_PLAY } from "./agent-play.ts";
import { commandAllowed, type GatePlace, type GateRefused, GateRefusal, gateCall } from "./pipeline-gate.ts";
import {
  editorStatus,
  listCommands,
  PIPELINE_PACKAGE,
  type PipelineAnswer,
  type PipelineCommand,
  type PipelineDeps,
  PipelineProblem,
  runCommand,
  systemPipelineDeps,
} from "./pipeline.ts";

const BRIDGE_VERSION = "0.1.0";
/** The most of a command's result handed to the agent as text. */
const MAX_RESULT_CHARS = 60_000;
/** The most pictures one answer hands over, and how deep a result is searched for them. */
const MAX_IMAGES = 4;
const MAX_IMAGE_DEPTH = 6;
/** How a capture names its picture's format and data. */
const PNG = "png";
const PNG_MIME = "image/png";

/** The Pipeline commands the bridge itself knows by name. Wire values: Pipeline's own. */
const Command = {
  Batch: "batch",
  SaveAll: "save_all",
  SaveScene: "save_scene",
  ListOpenScenes: "list_open_scenes",
  Play: "editor_play",
  Stop: "editor_stop",
  Capture: "capture_game_view",
} as const;

/** The bridge's tools, by the names agents call. Wire values: never rename one. */
export const EditorTool = {
  ListCommands: "list_commands",
  DescribeCommand: "describe_command",
  RunCommand: "run_command",
} as const;
export type EditorTool = (typeof EditorTool)[keyof typeof EditorTool];

const isEditorTool = (name: string): name is EditorTool => (Object.values(EditorTool) as string[]).includes(name);

const MESSAGE = {
  UnknownTool: (name: string) => `Unknown tool ${name}.`,
  NoProject:
    "Genex has not found a Unity project in this game's folder (a folder holding ProjectSettings/ProjectVersion.txt). Tell the user; retrying will not help.",
  [PipelineProblem.NotOpen]: `This game's Unity project is not open in Unity, or it has no Pipeline package (${PIPELINE_PACKAGE}). Call unity__open-editor, which opens it (when it says the project has no Pipeline package, call unity__setup first; the user confirms it), then call again.`,
  [PipelineProblem.NotAnswering]:
    "Unity did not answer. It may still be starting or reloading scripts: wait a little and call again; if it stays silent, call unity__open-editor, which says whether Unity has the project open and opens it when it doesn't.",
  [PipelineProblem.Busy]: (reason: string) =>
    `Unity stayed busy${reason ? ` (${reason})` : ""} for the whole wait. Call again in a moment; if it is showing a dialog, ask the user to answer it in the editor.`,
  [PipelineProblem.Refused]:
    "Unity refused Genex's token. Call unity__restart-editor, which ends Unity and opens the project again (the user confirms it; say first that unsaved editor work is lost), then call again.",
  [PipelineProblem.Failed]: (command: string, detail: string) => `${command} failed: ${detail}`,
  [PipelineProblem.Unknown]: (command: string) =>
    `${command} was sent and Unity gave no answer, so whether it took effect is unknown. Look before you repeat it.`,
  [PipelineProblem.Stalled]:
    "Unity's server answers but its main thread ran nothing, so the command did not run: it is in a long import or bake, or showing a dialog nobody answered. Call again in a minute; if it is still so and nobody is at the computer, call unity__restart-editor, which ends Unity and opens the project again (unsaved editor work is lost).",
  UntitledScene:
    "An open scene has never been saved, so Unity would ask for its file name in a save panel, which stalls the editor until someone answers it. Call save_scene with a path under Assets/ (such as Scenes/Main.unity) first; then save_all works.",
  ImageAttached: (n: number) => `[image ${n} attached]`,
  ImageOmitted: `[image omitted: at most ${MAX_IMAGES} per answer]`,
  [GateRefusal.NotACommand]: "command must be the name of a command from list_commands.",
  [GateRefusal.NotParameters]:
    "parameters must be an object (for batch: operations is a list of { id?, command, params }).",
  [GateRefusal.Denied]: (command: string) =>
    `${command} is not available to agents: running C# text that is in no file (eval, eval_file), quitting Unity or opening another project in it (quit, or such a menu item), Pipeline's authoring root and runtime settings, and a batch inside a batch are left out, in a batch's operations too. To run code, write a C# file into the project and call run_script on it, or let Unity compile it; to quit Unity, call unity__quit-editor, which saves first; to start it over, call unity__restart-editor.`,
  [GateRefusal.PathOutside]: (parameter: string) =>
    `${parameter} must name a file or folder inside this game's folder (in a batch, spelled out, not taken from an earlier operation).`,
  Cut: (chars: number) => `\n[cut: the result was ${chars} characters]`,
} as const;

/** The bridge's tools as Genex lists them, so they are there before the editor is open. */
const TOOLS = [
  {
    name: EditorTool.ListCommands,
    description:
      "List the commands the open Unity editor offers (scenes, objects, assets, prefabs, materials, Play mode, captures, tests, settings…), each with what it does and its tags.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: EditorTool.DescribeCommand,
    description:
      "Describe one Unity editor command from list_commands: each parameter's name, type, whether it is required and what it means. Read it before the first run_command of a command.",
    inputSchema: {
      type: "object" as const,
      properties: { command: { type: "string", description: "A command name from list_commands." } },
      required: ["command"],
    },
  },
  {
    name: EditorTool.RunCommand,
    description:
      "Run one Unity editor command by its name from list_commands, with parameters matching describe_command. Changes land in the user's open editor. Paths are relative to the Unity project (Assets/…).",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "A command name from list_commands." },
        parameters: { type: "object", description: "The command's parameters, as describe_command lists them." },
      },
      required: ["command"],
    },
  },
];

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; data: string; mimeType: string };
type ToolResult = { isError?: boolean; content: Array<TextPart | ImagePart>; _meta?: Record<string, string> };

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

const errorResult = (text: string, outcomeUnknown = false): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
  ...(outcomeUnknown ? { _meta: { [CONNECTOR_OUTCOME_META.Key]: CONNECTOR_OUTCOME_META.Unknown } } : {}),
});

/** Why a call got no result, in words for the agent. */
function problemResult(answer: Extract<PipelineAnswer, { ok: false }>, command: string): ToolResult {
  const detail = answer.detail ?? "";
  if (answer.problem === PipelineProblem.Busy) return errorResult(MESSAGE[PipelineProblem.Busy](detail));
  if (answer.problem === PipelineProblem.Failed) return errorResult(MESSAGE[PipelineProblem.Failed](command, detail));
  if (answer.problem === PipelineProblem.Unknown) return errorResult(MESSAGE[PipelineProblem.Unknown](command), true);
  return errorResult(MESSAGE[answer.problem]);
}

/** Why the gate refused a call, in words for the agent. */
function refusedResult(gate: GateRefused): ToolResult {
  if (gate.refusal === GateRefusal.Denied) return errorResult(MESSAGE[GateRefusal.Denied](gate.command ?? ""));
  if (gate.refusal === GateRefusal.PathOutside)
    return errorResult(MESSAGE[GateRefusal.PathOutside](gate.parameter ?? ""));
  return errorResult(MESSAGE[gate.refusal]);
}

/** A command's result as text: its own text, else JSON, cut when too long for a prompt. */
function resultText(result: unknown): string {
  const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}${MESSAGE.Cut(text.length)}` : text;
}

/** Whether `value` is a capture's answer carrying its picture: PNG data as base64 text. */
const isPicture = (value: unknown): value is { base64: string } & Record<string, unknown> =>
  isJsonObject(value) && typeof value.base64 === "string" && value.base64.length > 0 && value.encoding === PNG;

/** A result with every picture in it taken out into `images` (a batch's captures included), a note in its place. */
function takeImages(value: unknown, images: ImagePart[], depth = 0): unknown {
  if (depth > MAX_IMAGE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => takeImages(item, images, depth + 1));
  if (!isJsonObject(value)) return value;
  if (isPicture(value)) {
    if (images.length >= MAX_IMAGES) return { ...value, base64: MESSAGE.ImageOmitted };
    images.push({ type: "image", data: value.base64, mimeType: PNG_MIME });
    return { ...value, base64: MESSAGE.ImageAttached(images.length) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, takeImages(item, images, depth + 1)]));
}

/** A command's result for the agent: its text, and its pictures as images. */
function commandResult(result: unknown): ToolResult {
  const images: ImagePart[] = [];
  const text = resultText(takeImages(result, images));
  return { content: [{ type: "text", text }, ...images] };
}

/** One call's reach: this game's project and folder, the editor's network, the play marker and the call's stop. */
interface Call {
  at: GatePlace;
  deps: PipelineDeps;
  agentPlay: AgentPlayMarker;
  noteUse: () => Promise<void>;
  signal: AbortSignal;
}

type Sent = { command: string; parameters: Record<string, unknown> };

/** The commands a call runs: its own, and for a batch each operation's. */
function commandsOf(sent: Sent): Sent[] {
  if (sent.command !== Command.Batch) return [sent];
  const operations = Array.isArray(sent.parameters.operations) ? sent.parameters.operations : [];
  return operations.filter(isJsonObject).map((operation) => ({
    command: String(operation.command),
    parameters: isJsonObject(operation.params) ? operation.params : {},
  }));
}

/** A capture's parameters with `size` added, unless they name a size of their own. */
function sizedCapture(parameters: Record<string, unknown>, size: Record<string, number>): Record<string, unknown> {
  return "width" in parameters || "height" in parameters ? parameters : { ...size, ...parameters };
}

/** One operation of a batch, its capture sized as {@link sizedCaptures} says. */
function sizedOperation(operation: unknown, size: Record<string, number>): unknown {
  if (!isJsonObject(operation) || operation.command !== Command.Capture) return operation;
  const params = isJsonObject(operation.params) ? operation.params : {};
  return { ...operation, params: sizedCapture(params, size) };
}

/**
 * The command with each capture that names no size given the one Genex's own looks at a Unity game
 * use ({@link ENGINE_PLAY_VIEW}), in the size parameters the editor's capture takes: an unsized
 * capture is the Game view at its full size (a Retina screen's double), and every picture stays in
 * the agent's transcript for the rest of its session. A size the agent names is kept.
 */
function sizedCaptures(sent: Sent, catalogue: readonly PipelineCommand[]): Sent {
  const capture = catalogue.find((command) => command.name === Command.Capture);
  const takes = new Set(capture?.parameters.map((parameter) => parameter.name));
  const size = Object.fromEntries(Object.entries(ENGINE_PLAY_VIEW).filter(([name]) => takes.has(name)));
  if (Object.keys(size).length === 0) return sent;
  if (sent.command === Command.Capture) return { ...sent, parameters: sizedCapture(sent.parameters, size) };
  const operations = sent.parameters.operations;
  if (sent.command !== Command.Batch || !Array.isArray(operations)) return sent;
  const sized = operations.map((operation) => sizedOperation(operation, size));
  return { ...sent, parameters: { ...sent.parameters, operations: sized } };
}

/** Whether a command saves a scene under the name it already has, which an untitled scene has none of. */
const savesUnnamed = ({ command, parameters }: Sent): boolean =>
  command === Command.SaveAll || (command === Command.SaveScene && typeof parameters.path !== "string");

/**
 * Why a save must not be sent, if it must not: an open scene with no name would make Unity ask for
 * one in a save panel. Answers the editor's own trouble when its scenes can't be listed.
 */
async function unnamedSave(call: Call, sent: Sent): Promise<ToolResult | undefined> {
  if (!commandsOf(sent).some(savesUnnamed)) return undefined;
  const listing = { command: Command.ListOpenScenes, parameters: {} };
  const answer = await runCommand(call.at.root, listing, call.deps, { signal: call.signal });
  if (!answer.ok) return problemResult(answer, sent.command);
  const scenes = isJsonObject(answer.result) && Array.isArray(answer.result.scenes) ? answer.result.scenes : [];
  const untitled = scenes.some((scene) => isJsonObject(scene) && scene.path === "");
  return untitled ? errorResult(MESSAGE.UntitledScene) : undefined;
}

/** The last play or stop a call runs, alone or in a batch: what the editor's Play mode ends up as. */
const lastPlayChange = (sent: Sent): string | undefined =>
  commandsOf(sent)
    .map(({ command }) => command)
    .filter((command) => command === Command.Play || command === Command.Stop)
    .at(-1);

/**
 * Marks the agent's own play before the editor gets the command: entering Play reloads the
 * scripts, and the editor lock may ask whose play it is before the command answers. A play that
 * never started is forgotten by the lock's probe once it sees the editor stopped.
 */
async function markPlay(call: Call, sent: Sent): Promise<void> {
  if (commandsOf(sent).some(({ command }) => command === Command.Play))
    await call.agentPlay.started().catch(() => undefined);
}

/** Forgets the agent's own play once the editor took its stop. */
async function noteStop(call: Call, sent: Sent): Promise<void> {
  if (lastPlayChange(sent) === Command.Stop) await call.agentPlay.stopped().catch(() => undefined);
}

/** The editor's catalogue for a call, or the answer that says why it could not be read. */
async function catalogueOf(call: Call, tool: EditorTool): Promise<PipelineCommand[] | ToolResult> {
  const answer = await listCommands(call.at.root, call.deps, { signal: call.signal });
  return answer.ok ? answer.result : problemResult(answer, tool);
}

async function callListCommands(call: Call): Promise<ToolResult> {
  const catalogue = await catalogueOf(call, EditorTool.ListCommands);
  if (!Array.isArray(catalogue)) return catalogue;
  const offered = catalogue.filter((command) => commandAllowed(command.name));
  return textResult(resultText(offered.map(({ name, description, tags }) => ({ name, description, tags }))));
}

async function callDescribeCommand(call: Call, args: Record<string, unknown>): Promise<ToolResult> {
  const catalogue = await catalogueOf(call, EditorTool.DescribeCommand);
  if (!Array.isArray(catalogue)) return catalogue;
  const listed = catalogue.find((command) => command.name === args.command);
  if (!listed) return errorResult(MESSAGE[GateRefusal.NotACommand]);
  if (!commandAllowed(listed.name)) return errorResult(MESSAGE[GateRefusal.Denied](listed.name));
  return textResult(resultText(listed));
}

async function callRunCommand(call: Call, args: Record<string, unknown>): Promise<ToolResult> {
  const catalogue = await catalogueOf(call, EditorTool.RunCommand);
  if (!Array.isArray(catalogue)) return catalogue;
  const gate = await gateCall(call.at, catalogue, args.command, args.parameters);
  if (!gate.ok) return refusedResult(gate);
  const sent = sizedCaptures({ command: gate.command, parameters: gate.parameters }, catalogue);
  // A main thread that runs nothing gets no command queued behind what holds it.
  const look = await editorStatus(call.at.root, call.deps, { signal: call.signal, waits: true });
  if (!look.ok) return problemResult(look, sent.command);
  const held = await unnamedSave(call, sent);
  if (held) return held;
  await markPlay(call, sent);
  await call.noteUse().catch(() => undefined);
  const answer = await runCommand(call.at.root, sent, call.deps, { signal: call.signal });
  if (!answer.ok) return problemResult(answer, sent.command);
  await noteStop(call, sent);
  return commandResult(answer.result);
}

/**
 * The bridge for one game: `findProject` answers the real paths of the game's Unity project and of
 * the game's folder, as the plugin's backend recorded them, `deps` reaches the editor (this
 * computer's own unless a test stands in), `agentPlay` marks the agent's own play and `noteUse`
 * each command sent (without them, nothing is marked).
 */
export function createEditorMcp(
  findProject: () => Promise<GatePlace | undefined>,
  deps: PipelineDeps = systemPipelineDeps,
  agentPlay: AgentPlayMarker = NO_AGENT_PLAY,
  noteUse: () => Promise<void> = async () => {},
) {
  const server = new Server({ name: "unity-editor", version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    if (!isEditorTool(name)) return errorResult(MESSAGE.UnknownTool(name));
    const at = await findProject();
    if (!at) return errorResult(MESSAGE.NoProject);
    const call: Call = { at, deps, agentPlay, noteUse, signal: extra.signal };
    const args = request.params.arguments ?? {};
    if (name === EditorTool.ListCommands) return callListCommands(call);
    if (name === EditorTool.DescribeCommand) return callDescribeCommand(call, args);
    return callRunCommand(call, args);
  });
  return { server, close: () => server.close() };
}
