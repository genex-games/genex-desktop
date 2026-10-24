/**
 * The Roblox Studio connection: one per game, the manifest's `studio` MCP server. It passes Roblox
 * Studio's own MCP tools through (`studio-tools.ts` classes each one: reads and writes pass, every
 * other class stays hidden), pinned to the game's own Studio:
 *
 * - `studio_id` is never the agent's to choose. The connection fills it from the binding file the
 *   backend keeps once the Genex helper proved which Studio it is in; with no binding file yet, from
 *   the game's linked place matched against the open Studios. A call naming another Studio is
 *   refused.
 * - `datamodel_type` is Edit (the person's place) unless the agent names another, and a picture's
 *   `capture_id` is filled when left out.
 * - Pictures over 1 MB are shrunk through the system's own tools; one that stays too large is a
 *   plain refusal rather than an answer the agent can't take.
 * - `execute_luau` code that reaches the person's account, the internet or a live game, or that
 *   builds the names it looks up, is refused before it reaches Studio (`luau-screen.ts`), naming the
 *   tool that asks the person first; Auto and Bypass skip the connection's own cards.
 * - The agent's writes are marked (`agent-marks.ts`) so the Studio lock tells them from the person's.
 * - A bound Studio the connection's StudioMCP doesn't list is asked for once more through a fresh
 *   StudioMCP: one that reached Studio through another StudioMCP loses it when that one ends.
 *
 * Every refusal is a tool answer in plain words, never a thrown protocol error.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_PLAY_SHOT_BYTES } from "../../shared/engine-play.ts";
import { CONNECTOR_OUTCOME_META } from "../../shared/mcp.ts";
import { RobloxAction } from "./actions.ts";
import { agentBusyMarker } from "./agent-marks.ts";
import { type LuauRefusal, LuauReach, screenLuau } from "./luau-screen.ts";
import { BindingState, type PlaceLink, placeMatcher, readBinding } from "./studio-binding.ts";
import {
  type StudioClient,
  StudioClientError,
  StudioClientFailure,
  type StudioEntry,
  type StudioMcpTool,
  type StudioToolResult,
} from "./studio-client.ts";
import type { ShrinkShot } from "./studio-shot.ts";
import {
  askFirstToolsFor,
  CAPTURE_ID_ARG,
  classOf,
  DATAMODEL_ARG,
  EDIT_DATAMODEL,
  passesThrough,
  pluginToolName,
  STUDIO_ID_ARG,
  StudioTool,
  StudioToolClass,
} from "./studio-tools.ts";
import { agentTool as pluginTool, RobloxTool } from "./tools.ts";
import { MCP_SWITCH_CLICK_PATH } from "./words.ts";

const BRIDGE_VERSION = "0.1.0";
/** The picture types a tool answer may carry as an image. */
const JPEG = "image/jpeg";
/** The base of the capture ids the connection fills in, as Studio's own examples spell them. */
const CAPTURE_PREFIX = "ScreenCapture_";

const MESSAGE = {
  NotLinked: `This game isn't linked to a Roblox place yet, so Genex doesn't know which Roblox Studio is its own. Call ${pluginTool(RobloxTool.Places)} to see the places open in Studio, then ${pluginTool(RobloxTool.UseProject)} with this game's (ask the person which when several could be), or ${pluginTool(RobloxTool.NewGame)} for a new one; then retry.`,
  NotOpen: `Roblox Studio isn't open for this game. Call ${pluginTool(RobloxTool.OpenStudio)}, which opens the game's place, then retry once Studio has started.`,
  NotAnswering: `Roblox Studio is open but isn't answering Genex. It may still be starting: retry in a moment. If it keeps saying this, Studio's MCP server is off: call ${pluginTool(RobloxTool.DoItForMe)}, which switches it on with computer control (${MCP_SWITCH_CLICK_PATH}), then end your turn.`,
  TwoStudios:
    "Two Roblox Studio windows have this game's place open, so Genex can't tell which is its own. Ask the person to close one, then retry.",
  NotInstalled: `Roblox Studio isn't on this computer. Call ${pluginTool(RobloxTool.GetStudio)}: Genex gets it from Roblox once the person approves its card.`,
  Refused:
    "Genex won't start Roblox Studio's MCP server from where it is installed. Ask the person to reinstall Roblox Studio.",
  NoAnswer: `Roblox Studio's MCP server didn't answer. Retry in a moment; if it keeps failing, call ${pluginTool(RobloxTool.RestartStudio)} (the person approves its card).`,
  Lost: "Roblox Studio stopped answering during the call, so whether it took effect is unknown. Look before you repeat it.",
  Closing: "The Roblox Studio connection is closing.",
  OtherStudio:
    "This connection only reaches this game's own Roblox Studio, which it picks itself: leave studio_id out.",
  TooLarge: "Studio's picture is too large to hand over, even made smaller. Take it again closer up.",
  /** Why execute_luau code was refused, by what it reaches; `found` is the code that showed it. */
  Screened: {
    [LuauReach.Insert]: (found: string) =>
      `execute_luau won't run this: ${found} inserts from the Creator Store, and inserts ask the person first. Use ${askFirstToolsFor(StudioTool.InsertAsset).join(" or ")}.`,
    [LuauReach.Upload]: (found: string) =>
      `execute_luau won't run this: ${found} uploads to the person's Roblox account, and uploads ask the person first. Use ${askFirstToolsFor(StudioTool.UploadImage).join(" or ")}.`,
    [LuauReach.Publish]: (found: string) =>
      // The publish tool shares the panel action's name.
      `execute_luau won't run this: ${found} publishes the place, and publishing asks the person first. Use ${pluginToolName(RobloxAction.PublishUpdate)} when the person asks for it.`,
    [LuauReach.Network]: (found: string) =>
      `execute_luau won't run this: ${found} would reach the internet for you. Use Genex's own web tools.`,
    [LuauReach.LiveGame]: (found: string) =>
      `execute_luau won't run this: ${found} reaches the published game's live data, players or purchases, which building never touches.`,
    [LuauReach.Hidden]: (found: string) =>
      `execute_luau won't run this: ${found} looks names up in a way Genex can't read. Write each service and member name out plainly, such as game:GetService("Lighting").`,
  },
  Hidden: {
    [StudioToolClass.PlayLane]: (name: string) =>
      `${name} isn't offered here: play-testing goes through the computer tool and judge_play.`,
    [StudioToolClass.CodeIsFiles]: (name: string) =>
      `${name} isn't offered here: scripts are the game's .luau files under src/, which Genex keeps in step with Studio.`,
    [StudioToolClass.Network]: (name: string) =>
      `${name} isn't offered here: Studio would fetch any address for you. Use Genex's own web tools.`,
    [StudioToolClass.Bridge]: (name: string) =>
      `${name} isn't offered here: this connection already reaches this game's own Studio.`,
    [StudioToolClass.ConfirmedInsert]: (name: string) =>
      `${name} isn't offered here: inserts ask the person first. Use ${askFirstToolsFor(name).join(" or ")}.`,
    [StudioToolClass.ConfirmedAi]: (name: string) =>
      `${name} isn't offered here: Roblox's AI tools run on the person's account and ask them first. Use ${askFirstToolsFor(name).join(" or ")}.`,
    [StudioToolClass.ConfirmedUpload]: (name: string) =>
      `${name} isn't offered here: uploads go to the person's account and ask them first. Use ${askFirstToolsFor(name).join(" or ")}.`,
    [StudioToolClass.Unknown]: (name: string) =>
      `${name} isn't offered yet: it is new in Roblox Studio, and Genex offers a Studio tool only once it knows what the tool does.`,
  },
} as const;

/** What the connection works with; tests hand in fakes. */
export interface StudioMcpDeps {
  client: StudioClient;
  /** The connection's own folder, `<plugin storage>/mcp/<game>`: the binding file and the busy mark. */
  folder: string;
  /** The game's linked place, or undefined when it has none. */
  link(): Promise<PlaceLink | undefined>;
  /** Whether Roblox Studio runs on this computer. */
  running(): Promise<boolean>;
  shrink: ShrinkShot;
  now(): number;
}

type Part = StudioToolResult["content"][number];
type Answer = { content: Part[]; isError?: boolean; _meta?: Record<string, unknown> };

/** A refusal the agent reads; `outcomeUnknown` marks a call that may have taken effect before it failed. */
const refusal = (text: string, outcomeUnknown = false): Answer => ({
  isError: true,
  content: [{ type: "text", text }],
  ...(outcomeUnknown ? { _meta: { [CONNECTOR_OUTCOME_META.Key]: CONNECTOR_OUTCOME_META.Unknown } } : {}),
});

const codeOf = (error: unknown) => (error instanceof StudioClientError ? error.code : undefined);

/** A tool as the agent sees it: no `studio_id`, and Edit or a picture name filled when left out. */
function agentTool(tool: StudioMcpTool): StudioMcpTool {
  const { [STUDIO_ID_ARG]: _pinned, ...properties } = tool.inputSchema.properties ?? {};
  const optional = new Set([STUDIO_ID_ARG, DATAMODEL_ARG, CAPTURE_ID_ARG]);
  const required = (tool.inputSchema.required ?? []).filter((name) => !optional.has(name));
  const schema = { ...tool.inputSchema, properties, required };
  if (properties[DATAMODEL_ARG])
    properties[DATAMODEL_ARG] = { ...(properties[DATAMODEL_ARG] as object), default: EDIT_DATAMODEL };
  return { ...tool, inputSchema: schema };
}

type Pinned = { studio: StudioEntry } | { error: Answer };

/** The words for a Studio that couldn't be reached: by the client's code, then whether Studio runs. */
async function unreached(deps: StudioMcpDeps, error: unknown): Promise<Answer> {
  const code = codeOf(error);
  if (code === StudioClientFailure.TwoStudios) return refusal(MESSAGE.TwoStudios);
  if (code === StudioClientFailure.NotInstalled) return refusal(MESSAGE.NotInstalled);
  if (code === StudioClientFailure.Refused) return refusal(MESSAGE.Refused);
  if (code === StudioClientFailure.Closed) return refusal(MESSAGE.Closing);
  if (code !== StudioClientFailure.NotListed) return refusal(MESSAGE.NoAnswer);
  return refusal((await deps.running().catch(() => false)) ? MESSAGE.NotAnswering : MESSAGE.NotOpen);
}

type Attempt = { studio: StudioEntry } | { failed: unknown };

const attempt = (deps: StudioMcpDeps, match: (studio: StudioEntry) => boolean, signal: AbortSignal) =>
  deps.client.waitForStudio(match, { signal }).then(
    (studio): Attempt => ({ studio }),
    (failed: unknown): Attempt => ({ failed }),
  );

const notListed = (tried: Attempt) => "failed" in tried && codeOf(tried.failed) === StudioClientFailure.NotListed;

async function pinnedBy(deps: StudioMcpDeps, tried: Attempt): Promise<Pinned> {
  return "failed" in tried ? { error: await unreached(deps, tried.failed) } : { studio: tried.studio };
}

/**
 * The Studio the binding file names, asked for once more through a fresh StudioMCP when it isn't
 * listed: still not listed, it isn't open for the game (Studio restarted, or it closed).
 */
async function joinBound(deps: StudioMcpDeps, studioId: string, signal: AbortSignal): Promise<Pinned> {
  const match = (studio: StudioEntry) => studio.id === studioId;
  const first = await attempt(deps, match, signal);
  if (!notListed(first)) return pinnedBy(deps, first);
  await deps.client.restart();
  const again = await attempt(deps, match, signal);
  return notListed(again) ? { error: refusal(MESSAGE.NotOpen) } : pinnedBy(deps, again);
}

/** This game's own Studio: the bound one, or with no binding file yet, the one with its linked place. */
async function pinStudio(deps: StudioMcpDeps, signal: AbortSignal): Promise<Pinned> {
  const read = await readBinding(deps.folder, deps.now());
  if (read.state === BindingState.Stale) return { error: refusal(MESSAGE.NotOpen) };
  if (read.state === BindingState.Bound) return joinBound(deps, read.binding.studioId, signal);
  const link = await deps.link();
  if (!link) return { error: refusal(MESSAGE.NotLinked) };
  return pinnedBy(deps, await attempt(deps, placeMatcher(link), signal));
}

/** A picture part within the cap: as it came, made smaller, or undefined when it can't be. */
async function fitPicture(deps: StudioMcpDeps, part: Part): Promise<Part | undefined> {
  if (part.type !== "image" || typeof part.data !== "string") return part;
  const bytes = Buffer.from(part.data, "base64");
  if (bytes.length <= MAX_PLAY_SHOT_BYTES) return part;
  const smaller = await deps.shrink(bytes).catch(() => undefined);
  if (!smaller || smaller.length > MAX_PLAY_SHOT_BYTES) return undefined;
  return { type: "image", data: smaller.toString("base64"), mimeType: JPEG };
}

/** Studio's answer with every picture within the cap, or a refusal when one can't be. */
async function fitAnswer(deps: StudioMcpDeps, result: StudioToolResult): Promise<Answer> {
  const content: Part[] = [];
  for (const part of result.content) {
    const fitted = await fitPicture(deps, part);
    if (!fitted) return refusal(MESSAGE.TooLarge);
    content.push(fitted);
  }
  return { content, ...(result.isError ? { isError: true } : {}) };
}

/** Whether the listed schema of a tool takes an argument. */
const takes = (tool: StudioMcpTool | undefined, arg: string) => Boolean(tool?.inputSchema.properties?.[arg]);

/** The bridge's state across calls: Studio's tools as last listed, and the picture count. */
interface BridgeState {
  tools: Map<string, StudioMcpTool>;
  captures: number;
}

/** The agent's arguments with the pinned Studio, Edit and a picture name filled in. */
function filledArgs(state: BridgeState, name: string, args: Record<string, unknown>, studio: StudioEntry) {
  const tool = state.tools.get(name);
  const filled: Record<string, unknown> = { ...args, [STUDIO_ID_ARG]: studio.id };
  if (takes(tool, DATAMODEL_ARG) && filled[DATAMODEL_ARG] === undefined) filled[DATAMODEL_ARG] = EDIT_DATAMODEL;
  if (name === StudioTool.ScreenCapture && filled[CAPTURE_ID_ARG] === undefined)
    filled[CAPTURE_ID_ARG] = `${CAPTURE_PREFIX}${++state.captures}`;
  return filled;
}

/** Studio's tools, listed again when the one asked for isn't known yet. */
async function knownTools(deps: StudioMcpDeps, state: BridgeState, name: string): Promise<void> {
  if (state.tools.has(name)) return;
  const listed = await deps.client.listTools().catch(() => []);
  for (const tool of listed) state.tools.set(tool.name, tool);
}

type CallRequest = { name: string; args: Record<string, unknown> };

/** Why the agent's execute_luau code is refused before it reaches Studio, or null. */
function screened(call: CallRequest): LuauRefusal | null {
  if (call.name !== StudioTool.ExecuteLuau) return null;
  const code = call.args.code;
  return typeof code === "string" ? screenLuau(code) : null;
}

async function callStudio(
  deps: StudioMcpDeps,
  state: BridgeState,
  busy: ReturnType<typeof agentBusyMarker>,
  call: CallRequest,
  signal: AbortSignal,
): Promise<Answer> {
  const kind = classOf(call.name);
  if (!passesThrough(kind)) return refusal(MESSAGE.Hidden[kind as keyof typeof MESSAGE.Hidden](call.name));
  const screen = screened(call);
  if (screen) return refusal(MESSAGE.Screened[screen.reach](screen.found));
  const pinned = await pinStudio(deps, signal);
  if ("error" in pinned) return pinned.error;
  const asked = call.args[STUDIO_ID_ARG];
  if (asked !== undefined && asked !== pinned.studio.id) return refusal(MESSAGE.OtherStudio);
  await knownTools(deps, state, call.name);
  const args = filledArgs(state, call.name, call.args, pinned.studio);
  const send = () => deps.client.callTool(call.name, args, { signal });
  try {
    const result = kind === StudioToolClass.Write ? await busy.around(send) : await send();
    return await fitAnswer(deps, result);
  } catch (error) {
    if (codeOf(error) === StudioClientFailure.Closed) return refusal(MESSAGE.Closing);
    if (error instanceof StudioClientError && error.code === StudioClientFailure.Failed)
      return refusal(error.message, kind === StudioToolClass.Write);
    return refusal(MESSAGE.Lost, kind === StudioToolClass.Write);
  }
}

/** The connection's MCP server over the client and folder it is given. */
export function createStudioMcp(deps: StudioMcpDeps) {
  const state: BridgeState = { tools: new Map(), captures: 0 };
  const busy = agentBusyMarker(deps.folder, deps.now);
  const server = new Server({ name: "roblox-studio", version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await deps.client.listTools().catch(() => []);
    for (const tool of listed) state.tools.set(tool.name, tool);
    return { tools: listed.filter((tool) => passesThrough(classOf(tool.name))).map(agentTool) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const call = { name: request.params.name, args: { ...(request.params.arguments ?? {}) } };
    return callStudio(deps, state, busy, call, extra.signal);
  });
  const close = async () => {
    await server.close();
    await deps.client.close();
  };
  return { server, close };
}
