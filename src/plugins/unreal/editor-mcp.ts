/**
 * Studio's bridge to the Unreal Editor's own MCP server: Epic's experimental Unreal MCP (UE 5.8),
 * which the user's editor serves on 127.0.0.1 once its project enables the ModelContextProtocol
 * plugin and starts the server on the project's own port. The bridge finds the editor itself: for
 * every call it reads the project chosen in the panel and the set-up projects with their ports.
 * Once the user has chosen a project, calls go only to that project's editor; a chosen project
 * that is closed or not set up gets a message naming the fix, never another project's editor.
 * A chosen project Genex is starting in Unreal (the toolbar's Starting) is waited for, up to
 * 150 s, and one whose log says its port is blocked gets that message at once.
 * Only with nothing chosen does it use the first set-up project whose editor answers. The answer
 * names the project. Agents get Epic's three meta-tools; every call reaches only
 * local endpoints, in a session of its own, so an editor restarted between calls just answers the
 * next one and no call is ever sent twice. Epic's toolsets return pictures as base64 inside their
 * JSON text, which Studio would truncate as text; the bridge hands them to the agent as images.
 * An editor behind Genex plays at 3 frames per second while Unreal's "Use Less CPU when in
 * Background" is on, so the bridge turns it off for the editor's current run while a play test
 * runs and gives it back afterwards; Unreal saves nothing, so the user's preference survives.
 * While a call is pending, the bridge reads what the project's editor log gains every second: when
 * Unreal writes a crash there, the call answers at once with Unreal's own text for what failed,
 * instead of waiting out a call no crashed editor will answer. The Genex editor helper's Loop
 * toolset is Genex's own (its editor queue applies, plays and saves through it): an agent's call
 * or description that names it, however spelled, is refused before any editor is reached. While a
 * play the agent started runs, the bridge keeps a marker beside it (`agent-play.ts`), so the
 * editor lock tells the agent's play from the person's: an agent's `StartPIE` the editor took sets
 * it, and its `StopPIE`, the editor crashing under a call and the bridge closing clear it.
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type AgentPlayMarker, NO_AGENT_PLAY } from "./agent-play.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CONNECTOR_OUTCOME_META } from "../../shared/mcp.ts";
import {
  type CrashWatch,
  type EditorCrash,
  editorLogPath,
  PortBlockedError,
  userHome,
  watchForCrash,
} from "./editor-log.ts";
import {
  type ChosenProject,
  editorEndpoint,
  editorServes,
  HELPER_TOOLSET,
  isEpicServer,
  PROJECT_FILE_TOOL,
  sameProject,
} from "./editor-port.ts";
import { type CaptureClock, captureTool, helperAnswer, liftCapture } from "./editor-captures.ts";
import { LOOP_TOOLSET } from "./editor-queue.ts";
import {
  OBJECT_TOOLSET,
  ObjectTool,
  readThrottleArgs,
  throttleIn,
  tookValues,
  writeThrottleArgs,
} from "./editor-throttle.ts";
import { EditorStart, editorStart, type StartEnv } from "./editor-status.ts";
import { systemEditorLog, systemSetupEnv } from "./setup.ts";

const BRIDGE_VERSION = "0.1.0";
const CONNECT_TIMEOUT_MS = 10 * SECOND_MS;
/** Calls run on the editor's game thread: a PIE start with warmup or an asset render takes a while. */
const CALL_TIMEOUT_MS = 5 * MINUTE_MS;
/** How often a pending call's editor log is read for a crash: a crashed editor's call answers within about this. */
const CRASH_POLL_MS = SECOND_MS;
/** How often a call asks again for an editor Genex is starting. */
const EDITOR_START_POLL_MS = 2 * SECOND_MS;
/**
 * How long a call waits for an editor Genex is starting before it says so. The host gives a bridge
 * call 330 s (plugin.json's `callTimeoutMs`), and the call after the wait has only the rest of its
 * {@link CALL_TIMEOUT_MS}, so the whole call stays inside the host's limit.
 */
const EDITOR_START_WAIT_MS = 150 * SECOND_MS;
/**
 * How much longer a call waits once its editor stops starting without answering: Epic's server
 * answers about a second after the editor's log says it loaded, which ends the Starting state.
 */
const LOADED_ANSWER_MS = 10 * SECOND_MS;
/** Pictures handed over per answer; any more leave the text without becoming images. */
const MAX_IMAGES = 4;
/** The picture types every engine accepts as a tool-result image. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** The SDK's reconnection settings; with no retries a dropped stream fails the call instead. */
const RECONNECTION = {
  initialReconnectionDelay: SECOND_MS,
  maxReconnectionDelay: 5 * SECOND_MS,
  reconnectionDelayGrowFactor: 2,
  maxRetries: 0,
} as const;

/** How long a closing bridge waits to give the user's throttle setting back. */
const GIVE_BACK_ON_CLOSE_MS = 3 * SECOND_MS;

/** The toolset holding the play-in-editor tools whose session the bridge keeps at full speed. */
const PLAY_TOOLSET = "EditorToolset.EditorAppToolset";
/** The tools that start and stop a play-in-editor session, by their wire names. */
const PlayStep = { Start: "StartPIE", Stop: "StopPIE" } as const;
type PlayStep = (typeof PlayStep)[keyof typeof PlayStep];

/**
 * What names the Loop toolset in an agent's call, however spelled: its module (`genex_loop`) and its
 * class (`GenexLoopTools`), each as {@link squashed} spells it.
 */
const LOOP_TOOLSET_MARKS = [
  LOOP_TOOLSET.slice(0, LOOP_TOOLSET.indexOf(".")),
  LOOP_TOOLSET.slice(LOOP_TOOLSET.lastIndexOf(".") + 1),
].map((mark) => mark.toLowerCase());
/** What hides inside a name: whitespace and the zero-width characters. */
const HIDDEN_IN_NAME = /[\s\u200b-\u200d\u2060\ufeff]/g;

/** Epic's meta-tools (the editor's default `bEnableToolSearch` mode), by their wire names. */
export const EditorTool = {
  ListToolsets: "list_toolsets",
  DescribeToolset: "describe_toolset",
  CallTool: "call_tool",
} as const;
export type EditorTool = (typeof EditorTool)[keyof typeof EditorTool];

const MESSAGE = {
  UnexpectedEndpoint: "Unreal MCP requested an unexpected endpoint.",
  Redirected: "Unreal MCP redirected the connection.",
  NotUnreal: "the server there is not Unreal's MCP server",
  OtherProject: "the editor there has another project open",
  UnknownTool: (name: string) =>
    `Unknown Unreal Editor tool ${JSON.stringify(name)}. Use ${Object.values(EditorTool).join(", ")}.`,
  NoProject:
    "No Unreal project is set up for Genex yet. Ask the user to set one up from the Unreal button, then retry.",
  NotAnswering: (name: string, endpoint: URL, reason: string) =>
    `${name}'s Unreal MCP server isn't answering on ${endpoint.host} (${reason}). Ask the user to open ${name} in Unreal from the Unreal button, then retry.`,
  OtherOpen: (name: string, other: string) =>
    `${name}'s Unreal MCP server isn't answering. ${other} is open in Unreal instead. Ask the user to choose ${other} from the Unreal button, or to open ${name}, then retry.`,
  NotSetUp: (name: string) =>
    `${name} isn't set up for Genex. Ask the user to set it up from the Unreal button, then retry.`,
  StillStarting: (name: string) => `Unreal is still starting ${name}. Call again in a minute.`,
  Answered: (name: string) => `[Unreal project: ${name}]`,
  CallFailed: (reason: string) =>
    `Unreal Editor did not complete the call (${reason}), so whether it took effect is unknown. Look before you repeat it.`,
  NotCompleted: (reason: string) => `Unreal Editor did not complete the call: ${reason}`,
  Crashed: (detail: string | undefined) =>
    `Unreal crashed while this call ran${detail ? ` (${detail})` : ""}, so whether it took effect is unknown. Ask the user to reopen it from the Unreal button; once it answers, look before you repeat the call.`,
  ImageAttached: (n: number) => `[image ${n} attached]`,
  ImageOmitted: `[image omitted: at most ${MAX_IMAGES} per answer]`,
  LoopToolset: `${LOOP_TOOLSET} is Genex's own Unreal Loop toolset, which agents can't call. Build with genex_build.tools.GenexBuildTools and play with genex_play.tools.GenexPlayTools.`,
} as const;

/** Epic's meta-tools as Studio lists them, so they are there before the editor is open. */
const TOOLS = [
  {
    name: EditorTool.ListToolsets,
    description:
      "List the Unreal Editor's toolsets (actors, assets, Blueprints, materials, play-in-editor, captures…).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: EditorTool.DescribeToolset,
    description: "Describe one Unreal Editor toolset: its tools, what each does and its input schema.",
    inputSchema: {
      type: "object" as const,
      properties: { toolset_name: { type: "string", description: "A name from list_toolsets." } },
      required: ["toolset_name"],
    },
  },
  {
    name: EditorTool.CallTool,
    description:
      "Call one Unreal Editor tool by toolset_name and tool_name with arguments matching its schema from describe_toolset. Changes land in the user's open editor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        toolset_name: { type: "string", description: "The toolset, from list_toolsets." },
        tool_name: { type: "string", description: "The tool, without the toolset prefix." },
        arguments: { type: "object", description: "Arguments matching the tool's input schema." },
      },
      required: ["tool_name"],
    },
  },
];

const isRedirect = (status: number) => status >= 300 && status < 400;

/** A fetch that only ever reaches the editor's endpoint, and refuses to follow a redirect. */
function pinnedFetch(endpoint: URL, fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint.href) throw new Error(MESSAGE.UnexpectedEndpoint);
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    if (isRedirect(response.status)) throw new Error(MESSAGE.Redirected);
    return response;
  };
}

type Part = { type: string; [key: string]: unknown };
type ImagePart = { type: "image"; mimeType: string; data: string };

const isInlineImage = (value: Record<string, unknown>): value is { mimeType: string; data: string } =>
  typeof value.mimeType === "string" &&
  IMAGE_TYPES.has(value.mimeType) &&
  typeof value.data === "string" &&
  value.data.length > 0;

/** The JSON value with each inline picture moved into `images` and a note left in its place. */
function takeImages(value: unknown, images: ImagePart[], found: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => takeImages(item, images, found));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (isInlineImage(record)) {
    found.count++;
    if (images.length >= MAX_IMAGES) return { ...record, data: MESSAGE.ImageOmitted };
    images.push({ type: "image", mimeType: record.mimeType, data: record.data });
    return { ...record, data: MESSAGE.ImageAttached(images.length) };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, takeImages(item, images, found)]));
}

const parseJson = (text: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

/**
 * Epic's answers, with every `{mimeType, data}` picture inside a JSON text part handed over as an
 * MCP image (at most {@link MAX_IMAGES}); a part with no picture is returned exactly as it was.
 */
export function liftImages(parts: Part[]): Part[] {
  const out: Part[] = [];
  const images: ImagePart[] = [];
  for (const part of parts) {
    const parsed = part.type === "text" && typeof part.text === "string" ? parseJson(part.text) : undefined;
    const found = { count: 0 };
    const value = parsed ? takeImages(parsed.value, images, found) : undefined;
    out.push(found.count ? { ...part, text: JSON.stringify(value) } : part);
  }
  return [...out, ...images];
}

/**
 * A tool answer the agent reads as a failure, never a thrown protocol error. `outcomeUnknown`
 * marks a call that reached the editor and may have taken effect before it failed, so the host
 * records it as outcome unknown; a call refused before any editor was reached stays unmarked.
 */
const errorResult = (text: string, outcomeUnknown = false) => ({
  isError: true,
  content: [{ type: "text" as const, text }],
  ...(outcomeUnknown ? { _meta: { [CONNECTOR_OUTCOME_META.Key]: CONNECTOR_OUTCOME_META.Unknown } } : {}),
});

type CallParams = { name: string; arguments?: Record<string, unknown> };
type CallResult = Awaited<ReturnType<Client["callTool"]>>;
/**
 * One session with the editor at `endpoint`: calls on it share the editor's session id until `end`.
 * `abandon` lets go of a crashed editor's session without asking it to end, failing its pending calls.
 */
type EditorSession = {
  endpoint: URL;
  /** Calls a tool; it fails once `timeoutMs` passes without an answer (default {@link CALL_TIMEOUT_MS}). */
  call: (params: CallParams, timeoutMs?: number) => Promise<CallResult>;
  end: () => Promise<void>;
  abandon: () => Promise<void>;
};

/** A set-up project the bridge may reach: its `.uproject`, its name for the agent and its editor's own port. */
export type EditorProject = { project: string; name: string; port: number };
/** The project chosen in the panel (with its port once set up) and every set-up project; read again for every call. */
export type FindProjects = () => Promise<{ chosen?: ChosenProject; setUp: EditorProject[] }>;

const endpointOf = (project: EditorProject) => editorEndpoint(String(project.port));

/** Starts watching a project's editor for a crash while a call to it is pending; the bridge stops each watch when its call ends. */
export type CrashWatcher = (project: EditorProject) => Promise<CrashWatch>;

/** Whether Genex is starting a project's editor, and the clock a call's wait for it runs on. */
export type StartWait = {
  check: (project: EditorProject) => Promise<EditorStart>;
  now: () => number;
  /** A pause between asks; it ends early, without throwing, once the call is cancelled. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** This computer's clock for a call's wait. */
const SYSTEM_CLOCK: Pick<StartWait, "now" | "sleep"> = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined),
};

/** No editor is ever starting: a bridge without Genex's records answers a closed editor at once. */
const NOTHING_STARTS: StartWait = { ...SYSTEM_CLOCK, check: async () => EditorStart.NotStarting };

/**
 * Whether Genex is starting each project's editor, read the way the toolbar's Starting is: Genex's
 * launch record in the plugin's `storage`, this computer's editor processes, and each project's own
 * log where Unreal writes it under `home` on `platform`.
 */
export function systemStartWait(
  storage: string,
  home: string = userHome(),
  platform: NodeJS.Platform = process.platform,
): StartWait {
  const { editorRunning } = systemSetupEnv(process.env, platform);
  const editorLog: StartEnv["editorLog"] = systemEditorLog(home, platform);
  const check = (project: EditorProject) => editorStart({ editorRunning, editorLog }, storage, project, Date.now());
  return { ...SYSTEM_CLOCK, check };
}

/** Watches each project's own editor log, where Unreal writes it under `home` on `platform`, every `everyMs`. */
export function logCrashWatcher(
  home: string = userHome(),
  platform: NodeJS.Platform = process.platform,
  everyMs: number = CRASH_POLL_MS,
): CrashWatcher {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return (project) => {
    const file = editorLogPath({ file: project.project, directory: paths.dirname(project.project) }, home, platform);
    return watchForCrash(file, project.project, everyMs);
  };
}

/** Opens a session with Epic's server at the endpoint; throws when nothing, or something else, answers. */
async function openSession(endpoint: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<EditorSession> {
  const client = new Client({ name: "genex-studio", version: BRIDGE_VERSION });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: pinnedFetch(endpoint, fetchImpl),
    reconnectionOptions: { ...RECONNECTION },
  });
  // Closing the client aborts the requests still open and fails the calls waiting on them.
  const abandon = () => client.close().catch(() => {});
  const end = async () => {
    await transport.terminateSession().catch(() => {});
    await abandon();
  };
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, signal });
  } catch (error) {
    await abandon();
    throw error;
  }
  if (!isEpicServer(client.getServerVersion(), client.getServerCapabilities())) {
    await end();
    throw new Error(MESSAGE.NotUnreal);
  }
  const call = (params: CallParams, timeoutMs = CALL_TIMEOUT_MS) =>
    client.callTool(params, undefined, { timeout: timeoutMs, signal });
  return { endpoint, call, end, abandon };
}

type Reached = { session: EditorSession; project: EditorProject } | { error: string };

/**
 * A session with the editor on a project's port, kept only when the Genex editor helper there
 * names that same project: Epic's own answer carries no project, so another project's editor on
 * the port would otherwise get the call.
 */
async function openProjectSession(
  project: EditorProject,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<EditorSession> {
  const session = await openSession(endpointOf(project), fetchImpl, signal);
  const asked = toolsetCall(HELPER_TOOLSET, PROJECT_FILE_TOOL, {});
  const named = await session.call(asked).then(returnValue, () => undefined);
  if (typeof named === "string" && (await sameProject(named, project.project))) return session;
  await session.end();
  throw new Error(MESSAGE.OtherProject);
}

/** A session with one project's editor, or why it couldn't be opened. */
async function trySession(
  project: EditorProject,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ session: EditorSession } | { reason: string }> {
  return openProjectSession(project, fetchImpl, signal).then(
    (session) => ({ session }),
    (error: unknown) => ({ reason: errorMessage(error) }),
  );
}

/** The first of the projects whose own editor answers, asked side by side. */
async function firstAnswering(projects: EditorProject[], fetchImpl: typeof fetch): Promise<EditorProject | undefined> {
  const answering = await Promise.all(
    projects.map((project) => editorServes(endpointOf(project), project.project, fetchImpl)),
  );
  return projects.find((_, i) => answering[i]);
}

/** Where a project's start stands; a check that fails counts as nothing starting it. */
const startOf = (starts: StartWait, project: EditorProject) =>
  starts.check(project).catch(() => EditorStart.NotStarting);

/**
 * Asks for a starting editor every {@link EDITOR_START_POLL_MS} until it answers, its own log says
 * its port is blocked, or {@link EDITOR_START_WAIT_MS} passes; once it stops starting without
 * answering, it gets only {@link LOADED_ANSWER_MS} more. Answers the session, or where the start
 * stood last.
 */
async function waitForStart(
  project: EditorProject,
  bridge: Bridge,
  signal: AbortSignal,
): Promise<{ session: EditorSession } | { start: EditorStart }> {
  const { starts } = bridge;
  let ends = starts.now() + EDITOR_START_WAIT_MS;
  let start: EditorStart = EditorStart.Starting;
  while (starts.now() < ends && !signal.aborted) {
    await starts.sleep(EDITOR_START_POLL_MS, signal);
    const tried = await trySession(project, bridge.fetchImpl, signal);
    if ("session" in tried) return tried;
    start = await startOf(starts, project);
    if (start === EditorStart.PortBlocked) return { start };
    if (start !== EditorStart.Starting) ends = Math.min(ends, starts.now() + LOADED_ANSWER_MS);
  }
  return { start };
}

/** What a start says to the agent: a blocked port's own message, still starting, or nothing (the usual message follows). */
function startAnswer(project: EditorProject, start: EditorStart): Reached | undefined {
  if (start === EditorStart.PortBlocked) return { error: new PortBlockedError(project.port).message };
  if (start === EditorStart.Starting) return { error: MESSAGE.StillStarting(project.name) };
  return undefined;
}

/**
 * The chosen project's editor once it answers, while Genex is starting it: Unreal takes minutes to
 * open a project, and the agent's first call often comes seconds after Genex opened it. Undefined
 * when nothing is starting it, or it stopped starting without answering.
 */
async function awaitStart(project: EditorProject, bridge: Bridge, signal: AbortSignal): Promise<Reached | undefined> {
  const start = await startOf(bridge.starts, project);
  if (start !== EditorStart.Starting) return startAnswer(project, start);
  const waited = await waitForStart(project, bridge, signal);
  return "session" in waited ? { session: waited.session, project } : startAnswer(project, waited.start);
}

/**
 * The chosen project's editor, and only it: one Genex is starting is waited for, and when it
 * doesn't answer, the other set-up projects are asked only so the message can name one that is
 * open, never to forward the call there.
 */
async function reachChosen(
  chosen: EditorProject,
  setUp: EditorProject[],
  bridge: Bridge,
  signal: AbortSignal,
): Promise<Reached> {
  const first = await trySession(chosen, bridge.fetchImpl, signal);
  if ("session" in first) return { session: first.session, project: chosen };
  const started = await awaitStart(chosen, bridge, signal);
  if (started) return started;
  const open = await firstAnswering(
    setUp.filter((p) => p.project !== chosen.project),
    bridge.fetchImpl,
  );
  if (open) return { error: MESSAGE.OtherOpen(chosen.name, open.name) };
  return { error: MESSAGE.NotAnswering(chosen.name, endpointOf(chosen), first.reason) };
}

/**
 * The editor a call goes to. Once the user has chosen a project in the panel, only that project's
 * editor: a chosen project that isn't set up gets the set-up message and no editor is asked. With
 * nothing chosen, the first set-up project, or else the first other one whose editor answers. A
 * session that opens is the check itself, so an editor that answers costs no extra round-trip.
 */
async function reachEditor(
  found: Awaited<ReturnType<FindProjects>>,
  bridge: Bridge,
  signal: AbortSignal,
): Promise<Reached> {
  const { chosen, setUp } = found;
  const { fetchImpl } = bridge;
  if (chosen?.port !== undefined) return reachChosen({ ...chosen, port: chosen.port }, setUp, bridge, signal);
  if (chosen) return { error: MESSAGE.NotSetUp(chosen.name) };
  const [first, ...others] = setUp;
  if (!first) return { error: MESSAGE.NoProject };
  const tried = await trySession(first, fetchImpl, signal);
  if ("session" in tried) return { session: tried.session, project: first };
  const next = await firstAnswering(others, fetchImpl);
  const second = next ? await openProjectSession(next, fetchImpl, signal).catch(() => undefined) : undefined;
  if (next && second) return { session: second, project: next };
  return { error: MESSAGE.NotAnswering(first.name, endpointOf(first), tried.reason) };
}

const toolsetCall = (toolset_name: string, tool_name: string, args: Record<string, unknown>): CallParams => ({
  name: EditorTool.CallTool,
  arguments: { toolset_name, tool_name, arguments: args },
});

/** The `returnValue` of an editor answer; undefined when the call failed or answered something else. */
function returnValue(result: CallResult): unknown {
  if (result.isError || !Array.isArray(result.content)) return undefined;
  const text = (result.content as Part[]).find((part) => part.type === "text")?.text;
  const parsed = typeof text === "string" ? parseJson(text) : undefined;
  const value = parsed?.value;
  return value && typeof value === "object" ? (value as { returnValue?: unknown }).returnValue : undefined;
}

/** The text an editor answer carries (its error, when it failed). */
function answerText(result: CallResult): string {
  const parts = Array.isArray(result.content) ? (result.content as Part[]) : [];
  const text = parts.find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

/**
 * Calls one tool on a project's own editor, once the Genex editor helper there names that project,
 * and answers its return value. For the editor queue and the Unreal Loop's own steps, which call
 * the editor themselves rather than through an agent's bridge. A call that blocks the editor
 * longer than most (a hot reload) names its own `timeoutMs`.
 */
export async function callProjectTool(
  project: EditorProject,
  call: { toolset: string; tool: string; args: Record<string, unknown>; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const session = await openProjectSession(project, fetchImpl, signal);
  try {
    const result = await session.call(toolsetCall(call.toolset, call.tool, call.args), call.timeoutMs);
    if (result.isError) throw new Error(answerText(result) || MESSAGE.NotUnreal);
    return returnValue(result);
  } finally {
    await session.end();
  }
}

/** Whether the editor throttles in the background; undefined when it can't be read. */
async function readThrottle(session: EditorSession): Promise<boolean | undefined> {
  const read = toolsetCall(OBJECT_TOOLSET, ObjectTool.GetProperties, readThrottleArgs());
  return throttleIn(returnValue(await session.call(read)));
}

/** Sets the throttle for the editor's current run; true when the editor took it. */
async function writeThrottle(session: EditorSession, on: boolean): Promise<boolean> {
  const write = toolsetCall(OBJECT_TOOLSET, ObjectTool.SetProperties, writeThrottleArgs(on));
  return tookValues(returnValue(await session.call(write)));
}

/** Whether a tool name means `step`, resolved the way Unreal does: case-insensitively, short or qualified. */
function namesStep(tool: string, toolset: string, step: PlayStep): boolean {
  const short = toolset === PLAY_TOOLSET.toLowerCase() && tool === step.toLowerCase();
  return short || tool === `${PLAY_TOOLSET}.${step}`.toLowerCase();
}

/** The play step a forwarded call is, if any. */
function playStep(params: CallParams): PlayStep | undefined {
  if (params.name !== EditorTool.CallTool) return undefined;
  const tool = String(params.arguments?.tool_name ?? "").toLowerCase();
  const toolset = String(params.arguments?.toolset_name ?? "").toLowerCase();
  return Object.values(PlayStep).find((step) => namesStep(tool, toolset, step));
}

/**
 * Keeps a play test at full speed while the editor is behind Genex: a play start turns the user's
 * background throttling off, and stopping play, a refused start or the bridge closing gives it back.
 * A user who already turned it off is never touched; nothing here ever blocks the call itself. Each
 * editor gets back only what was taken from it, so a call that reaches another project's editor
 * never writes that one's setting. A crash ends the editor's run and the setting with it, so a
 * crashed editor is owed nothing and its next run is lifted afresh.
 */
function throttleKeeper() {
  /** The endpoints of the editors whose throttle the bridge turned off and still owes back. */
  const owed = new Set<string>();
  const forget = (session: EditorSession) => {
    owed.delete(session.endpoint.href);
  };
  const giveBack = async (session: EditorSession) => {
    if (!owed.has(session.endpoint.href)) return;
    if (await writeThrottle(session, true).catch(() => false)) owed.delete(session.endpoint.href);
  };
  const lift = async (session: EditorSession) => {
    if (owed.has(session.endpoint.href) || (await readThrottle(session).catch(() => undefined)) !== true) return;
    if (await writeThrottle(session, false).catch(() => false)) owed.add(session.endpoint.href);
  };
  return {
    owed: () => [...owed].map((href) => new URL(href)),
    giveBack,
    forget,
    before: (session: EditorSession, step: PlayStep | undefined) =>
      step === PlayStep.Start ? lift(session) : Promise.resolve(),
    after: (session: EditorSession, step: PlayStep | undefined, failed: boolean) => {
      const refusedStart = step === PlayStep.Start && failed;
      return step === PlayStep.Stop || refusedStart ? giveBack(session) : Promise.resolve();
    },
  };
}
type ThrottleKeeper = ReturnType<typeof throttleKeeper>;

/**
 * What a bridge's calls share: where the projects are found, how editors are reached, watched and
 * waited for while Genex starts them, and the throttle owed.
 */
type Bridge = {
  findProjects: FindProjects;
  fetchImpl: typeof fetch;
  watchCrash: CrashWatcher;
  starts: StartWait;
  keeper: ThrottleKeeper;
  agentPlay: AgentPlayMarker;
};

/** A watch that never sees a crash, for a call whose log can't be watched: the call itself is never held up. */
const UNWATCHED: CrashWatch = { crashed: new Promise<never>(() => {}), stop: async () => {} };

/** What one forwarded call needs besides its session: the project, the throttle, the agent's play, the clock and its time. */
type Forwarding = {
  project: EditorProject;
  keeper: ThrottleKeeper;
  agentPlay: AgentPlayMarker;
  clock: CaptureClock;
  timeoutMs: number;
};

/** Marks the agent's own play once the editor took its start, and clears the mark once it took its stop. */
async function markPlay(marker: AgentPlayMarker, step: PlayStep | undefined, failed: boolean): Promise<void> {
  if (failed || step === undefined) return;
  await (step === PlayStep.Start ? marker.started() : marker.stopped());
}

/** The pictures a capture tool's answer promised (see editor-captures.ts); nothing for any other call. */
async function capturedParts(
  params: CallParams,
  content: Part[],
  project: EditorProject,
  clock: CaptureClock,
  signal: AbortSignal,
) {
  const tool = params.name === EditorTool.CallTool ? captureTool(params.arguments) : undefined;
  if (!tool) return [];
  return liftCapture(tool, helperAnswer(content), project.project, clock, signal);
}

/**
 * The editor's answer to one call on an open session, within its time, naming the project; a
 * capture's pictures follow the answer once Unreal has written them. A failed call is an error answer.
 */
async function forward(session: EditorSession, params: CallParams, how: Forwarding, signal: AbortSignal) {
  const step = playStep(params);
  try {
    await how.keeper.before(session, step);
  } catch (error) {
    return errorResult(MESSAGE.NotCompleted(errorMessage(error)));
  }
  let result: CallResult;
  try {
    result = await session.call(params, how.timeoutMs);
  } catch (error) {
    // A JSON-RPC error is the editor's own answer: it is still there, and the call did not complete.
    if (editorAnswered(error)) return errorResult(MESSAGE.NotCompleted(errorMessage(error)));
    return errorResult(MESSAGE.CallFailed(errorMessage(error)), editorWentAway(error, signal));
  }
  try {
    await how.keeper.after(session, step, Boolean(result.isError));
    await markPlay(how.agentPlay, step, Boolean(result.isError));
    const content = Array.isArray(result.content) ? (result.content as Part[]) : [];
    const captured = result.isError ? [] : await capturedParts(params, content, how.project, how.clock, signal);
    const named = [...liftImages(content), ...captured, { type: "text", text: MESSAGE.Answered(how.project.name) }];
    return { content: named, ...(result.isError ? { isError: true } : {}) };
  } catch (error) {
    // The editor answered: what failed after is Genex's own, and the editor is still there.
    return errorResult(MESSAGE.NotCompleted(errorMessage(error)));
  }
}

/** The MCP SDK's own codes for a call that got no answer: it ran out of time, or its connection closed. */
const NO_ANSWER_CODES: ReadonlySet<number> = new Set([ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]);

/** Whether a failed call is a JSON-RPC error the editor sent back (invalid params, an internal error). */
function editorAnswered(error: unknown): boolean {
  return error instanceof McpError && !NO_ANSWER_CODES.has(error.code);
}

/**
 * Whether a sent call failed because the editor's session went away: its connection closed
 * (`ConnectionClosed`) or broke (a transport or fetch failure, which is no `McpError`). A call that
 * ran out of time is not: the editor may still be running it (a long script), and its answer
 * already says the outcome is unknown. Nor is one its caller stopped, or one the editor answered.
 */
function editorWentAway(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  return !(error instanceof McpError) || error.code === ErrorCode.ConnectionClosed;
}

/**
 * One session with the editor for one call: find it, open, call while watching its log, close; the
 * answer names the project. Time spent waiting for the editor to start comes out of the call's own
 * {@link CALL_TIMEOUT_MS}. A crash written to the log while the call is pending answers at once:
 * the crashed editor answers nothing more, an end of its session included, so it is let go unasked.
 */
async function callEditor(bridge: Bridge, params: CallParams, signal: AbortSignal) {
  const began = bridge.starts.now();
  const reached = await reachEditor(await bridge.findProjects(), bridge, signal);
  if ("error" in reached) return errorResult(reached.error);
  const { session, project } = reached;
  const timeoutMs = CALL_TIMEOUT_MS - (bridge.starts.now() - began);
  const watch = await bridge.watchCrash(project).catch(() => UNWATCHED);
  const how = { project, keeper: bridge.keeper, agentPlay: bridge.agentPlay, clock: bridge.starts, timeoutMs };
  const answered = forward(session, params, how, signal).then((result) => ({ result }));
  const crashed = watch.crashed.then((crash: EditorCrash) => ({ crash }));
  const first = await Promise.race([answered, crashed]).finally(() => watch.stop());
  if ("result" in first) {
    await session.end();
    return first.result;
  }
  bridge.keeper.forget(session);
  await bridge.agentPlay.stopped();
  await session.abandon();
  return errorResult(MESSAGE.Crashed(first.crash.detail), true);
}

/** Gives the throttle setting back to each editor still owed it, from a bridge that is closing, within a short wait. */
async function giveBackOnClose(fetchImpl: typeof fetch, keeper: ThrottleKeeper) {
  const signal = AbortSignal.timeout(GIVE_BACK_ON_CLOSE_MS);
  for (const endpoint of keeper.owed()) {
    const session = await openSession(endpoint, fetchImpl, signal).catch(() => undefined);
    if (!session) continue;
    await keeper.giveBack(session);
    await session.end();
  }
}

const isEditorTool = (name: string): name is EditorTool => (Object.values(EditorTool) as string[]).includes(name);

/** A name as Unreal might resolve it, and then some: compatibility-normalized, lower case, nothing hidden inside. */
const squashed = (value: unknown) =>
  (typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(HIDDEN_IN_NAME, "");

/**
 * Whether an agent's call names the Loop toolset, in its toolset or in a qualified tool name, in any
 * case, with whitespace, behind a prefix or past a suffix.
 */
function namesLoopToolset(args: Record<string, unknown>): boolean {
  const names = [args.toolset_name, args.tool_name].map(squashed);
  return names.some((name) => LOOP_TOOLSET_MARKS.some((mark) => name.includes(mark)));
}

/**
 * The bridge's MCP server: Epic's meta-tools listed by Studio, each call forwarded to the editor it
 * finds while `watchCrash` watches that editor for a crash; a chosen editor that `starts` says
 * Genex is starting is waited for (without one, nothing is ever starting). `agentPlay` marks the
 * agent's own play (without one, nothing is marked).
 */
export function createEditorMcp(
  findProjects: FindProjects,
  fetchImpl: typeof fetch = fetch,
  watchCrash: CrashWatcher = logCrashWatcher(),
  starts: StartWait = NOTHING_STARTS,
  agentPlay: AgentPlayMarker = NO_AGENT_PLAY,
) {
  const keeper = throttleKeeper();
  const bridge: Bridge = { findProjects, fetchImpl, watchCrash, starts, keeper, agentPlay };
  const server = new Server({ name: "unreal-editor", version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    if (!isEditorTool(name)) return errorResult(MESSAGE.UnknownTool(name));
    const params = { name, arguments: request.params.arguments ?? {} };
    if (namesLoopToolset(params.arguments)) return errorResult(MESSAGE.LoopToolset);
    return callEditor(bridge, params, extra.signal);
  });
  const close = async () => {
    await giveBackOnClose(fetchImpl, keeper);
    await agentPlay.stopped();
    await server.close();
  };
  return { server, close };
}
