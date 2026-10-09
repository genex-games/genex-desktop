/**
 * The studio's tools as Codex dynamic tools: the experimental `dynamicTools` of Codex's app server
 * (`codex app-server`, CLI 0.159), where a tool the client declares on `thread/start` is called by
 * a server request (`item/tool/call`) the client answers. It is the native alternative to the file
 * bridge (`studio-bridge.ts`): a screenshot reaches the model as a picture in the answer, not as a
 * file it has to open in a second step, and arguments arrive as JSON, never as string flags.
 *
 * Pure and Electron-free: the declaration of a tool, the answer to a call, and the reading of a
 * call that came from a process the studio does not control. Every reading refuses in words the
 * model can act on, and never throws: a malformed call must not end a build that is going well.
 *
 * The wire shapes are those `codex app-server generate-json-schema --experimental` prints for CLI
 * 0.159 (`DynamicToolSpec`, `DynamicToolCallParams`, `DynamicToolCallResponse`).
 */
import type { LiveToolResult } from "./types.ts";

/** The oldest Codex CLI whose app server takes `dynamicTools` on `thread/start`. */
export const CODEX_DYNAMIC_TOOLS_MIN_VERSION = "0.159.0";

/**
 * The most one answer carries, text and pictures together, as the JSON it is sent as. A screenshot
 * is a few hundred KiB; a cap keeps a runaway tool from pushing a payload no model takes.
 */
export const MAX_TOOL_RESULT_BYTES = 12 * 1024 * 1024;
/** The most a call's arguments may weigh as JSON before the call is refused unread. */
export const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
/** What Codex accepts as a function tool's name: the Responses API's own rule. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The picture types a model is sent inline; anything else is named instead. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Plain base64: what a data URL can carry without being re-encoded. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The headroom a cut answer keeps for the note that says it was cut. */
const NOTE_RESERVE_BYTES = 1024;

/**
 * How a session's studio tools reached a contractor, as its `system/init` log event records it
 * (`tool_delivery`): Codex dynamic tools on the app server, or the file bridge under `codex exec`.
 */
export const ToolDelivery = {
  DynamicTools: "dynamic_tools",
  FileBridge: "file_bridge",
} as const;
export type ToolDelivery = (typeof ToolDelivery)[keyof typeof ToolDelivery];

/** A dynamic tool's declaration type, as the app server spells it. */
export const DynamicToolType = {
  Function: "function",
} as const;
export type DynamicToolType = (typeof DynamicToolType)[keyof typeof DynamicToolType];

/** The kinds of content an answer to a dynamic tool call holds, as the app server spells them. */
export const DynamicContentType = {
  InputText: "inputText",
  InputImage: "inputImage",
} as const;
export type DynamicContentType = (typeof DynamicContentType)[keyof typeof DynamicContentType];

/** One studio tool declared to Codex (`FunctionDynamicToolSpec`). */
export interface DynamicToolSpec {
  type: typeof DynamicToolType.Function;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One part of an answer (`DynamicToolCallOutputContentItem`, without audio, which no tool sends). */
export type DynamicContentItem =
  | { type: typeof DynamicContentType.InputText; text: string }
  | { type: typeof DynamicContentType.InputImage; imageUrl: string };

/** The answer to one `item/tool/call` (`DynamicToolCallResponse`). */
export interface DynamicToolCallResponse {
  contentItems: DynamicContentItem[];
  success: boolean;
}

/** A tool the studio grants a delegation, in the shape the bridge and the app server both read. */
export interface DeclarableTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

/** Why a call was refused, so the caller can count and test refusals without reading words. */
export const ToolCallRefusal = {
  /** The params were not an object with a string call id, a tool name and arguments. */
  Malformed: "malformed",
  /** The call names a thread this turn is not on. */
  WrongThread: "wrong_thread",
  /** The tool was never declared on this thread (or arrived in a namespace none was declared in). */
  UnknownTool: "unknown_tool",
  /** The arguments are not a JSON object. */
  BadArguments: "bad_arguments",
  /** The arguments weigh more than {@link MAX_TOOL_ARGUMENT_BYTES}. */
  TooLarge: "too_large",
} as const;
export type ToolCallRefusal = (typeof ToolCallRefusal)[keyof typeof ToolCallRefusal];

/** One call, read: which call to answer, the tool and its arguments. */
export interface DynamicToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** A call that can run, or the refusal to answer it with. */
export type ParsedToolCall =
  | { ok: true; call: DynamicToolCall }
  | { ok: false; code: ToolCallRefusal; refusal: DynamicToolCallResponse };

/** What the model is told when its call is refused or its answer was trimmed. */
const MESSAGE = {
  [ToolCallRefusal.Malformed]:
    "The studio could not read that tool call: it needs a call id, a tool name and arguments.",
  [ToolCallRefusal.WrongThread]: "That tool call belongs to another session; the studio did not run it.",
  [ToolCallRefusal.UnknownTool]: (name: string) => `The studio has no tool called '${name}' in this session.`,
  [ToolCallRefusal.BadArguments]: "Tool arguments must be one JSON object; the studio did not run the call.",
  [ToolCallRefusal.TooLarge]: `Those tool arguments are larger than ${MAX_TOOL_ARGUMENT_BYTES} bytes; the studio did not run the call.`,
  ImageNotSent: (index: number, why: string) => `Picture ${index + 1} was not attached: ${why}.`,
  UnsupportedImage: (mimeType: string) => `${mimeType || "an unknown type"} is not a picture type a model is sent`,
  BrokenImage: "its data is not base64",
  OverCap: `the answer would pass the ${MAX_TOOL_RESULT_BYTES}-byte cap`,
  TextCut: "[the studio cut this answer to fit the size cap]",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One tool as Codex is told it: its real schema when it has one, else the flat parameters. */
export function dynamicToolSpec(tool: DeclarableTool): DynamicToolSpec | null {
  if (!TOOL_NAME.test(tool.name)) return null;
  return {
    type: DynamicToolType.Function,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? tool.parameters,
  };
}

/**
 * Every tool as Codex is told it, or null when one cannot be declared: a turn either has every
 * tool it was granted natively or keeps them all on the file bridge, never half of each.
 */
export function dynamicToolSpecs(tools: readonly DeclarableTool[]): DynamicToolSpec[] | null {
  const specs: DynamicToolSpec[] = [];
  for (const tool of tools) {
    const spec = dynamicToolSpec(tool);
    if (!spec) return null;
    specs.push(spec);
  }
  return specs;
}

/** A refusal the model reads as the tool's answer. */
export function dynamicToolRefusal(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: DynamicContentType.InputText, text }] };
}

/** Bytes an item weighs in the JSON the answer is sent as. */
function itemBytes(item: DynamicContentItem): number {
  return Buffer.byteLength(JSON.stringify(item));
}

/** A text item cut to `budget` bytes of JSON, with the note that says so. */
function cutText(text: string, budget: number): DynamicContentItem {
  const room = Math.max(0, budget - NOTE_RESERVE_BYTES);
  // JSON escapes can double a character's weight; cut by characters until the item fits.
  let kept = text.slice(0, room);
  while (kept && itemBytes({ type: DynamicContentType.InputText, text: kept }) > room) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }
  return { type: DynamicContentType.InputText, text: `${kept}\n${MESSAGE.TextCut}` };
}

/** Why a picture cannot go inline, or null when it can. */
function imageProblem(image: { mimeType: string; data: string }): string | null {
  if (!INLINE_IMAGE_TYPES.has(image.mimeType)) return MESSAGE.UnsupportedImage(image.mimeType);
  if (typeof image.data !== "string" || !BASE64.test(image.data)) return MESSAGE.BrokenImage;
  return null;
}

/**
 * A live tool's result as the answer Codex reads: the text, then each picture inline as a data URL.
 * A picture of a type no model takes, with broken data, or past the size cap is left out and named
 * in a note, so the model knows something was there; text past the cap is cut.
 */
export function dynamicToolResponse(result: LiveToolResult): DynamicToolCallResponse {
  const text = typeof result === "string" ? result : String(result.text ?? "");
  const images = typeof result === "string" ? [] : (result.images ?? []);
  const failed = typeof result !== "string" && result.isError === true;
  const textItem: DynamicContentItem = { type: DynamicContentType.InputText, text };
  const first = itemBytes(textItem) > MAX_TOOL_RESULT_BYTES ? cutText(text, MAX_TOOL_RESULT_BYTES) : textItem;
  const items: DynamicContentItem[] = [first];
  const notes: DynamicContentItem[] = [];
  let used = itemBytes(first);
  for (const [index, image] of images.entries()) {
    const problem = imageProblem(image);
    const item: DynamicContentItem = {
      type: DynamicContentType.InputImage,
      imageUrl: `data:${image.mimeType};base64,${image.data}`,
    };
    const why =
      problem ?? (used + itemBytes(item) + NOTE_RESERVE_BYTES > MAX_TOOL_RESULT_BYTES ? MESSAGE.OverCap : null);
    if (why) {
      notes.push({ type: DynamicContentType.InputText, text: MESSAGE.ImageNotSent(index, why) });
      continue;
    }
    items.push(item);
    used += itemBytes(item);
  }
  return { success: !failed, contentItems: [...items, ...notes] };
}

/** A refused call: its reason code and the words the model reads. */
function refuse(code: ToolCallRefusal, text: string): ParsedToolCall {
  return { ok: false, code, refusal: dynamicToolRefusal(text) };
}

/** The required fields of a call, or null when one is missing or of the wrong kind. */
function callFields(params: unknown): { threadId: string; callId: string; tool: string; args: unknown } | null {
  if (!isRecord(params)) return null;
  const { threadId, callId, tool } = params;
  const named = typeof threadId === "string" && typeof callId === "string" && typeof tool === "string";
  if (!named || !("arguments" in params) || params.arguments === undefined) return null;
  return { threadId, callId, tool, args: params.arguments };
}

/** Whether a call's arguments weigh more than the cap, measured as the JSON they arrived as. */
function tooLarge(args: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(args)) > MAX_TOOL_ARGUMENT_BYTES;
  } catch {
    return true;
  }
}

/**
 * One `item/tool/call` read defensively: the thread it is on, a tool this thread declared (by its
 * own name, never in a namespace, never an inherited property), and arguments that are one JSON
 * object under the cap. Anything else is a typed refusal to answer the call with.
 */
export function parseDynamicToolCall(
  params: unknown,
  expected: { threadId: string; tools: ReadonlySet<string> },
): ParsedToolCall {
  const fields = callFields(params);
  if (!fields) return refuse(ToolCallRefusal.Malformed, MESSAGE[ToolCallRefusal.Malformed]);
  if (fields.threadId !== expected.threadId) {
    return refuse(ToolCallRefusal.WrongThread, MESSAGE[ToolCallRefusal.WrongThread]);
  }
  const namespace = isRecord(params) ? params.namespace : undefined;
  const namespaced = namespace !== undefined && namespace !== null;
  if (namespaced || !expected.tools.has(fields.tool)) {
    return refuse(ToolCallRefusal.UnknownTool, MESSAGE[ToolCallRefusal.UnknownTool](fields.tool.slice(0, 64)));
  }
  if (!isRecord(fields.args)) return refuse(ToolCallRefusal.BadArguments, MESSAGE[ToolCallRefusal.BadArguments]);
  if (tooLarge(fields.args)) return refuse(ToolCallRefusal.TooLarge, MESSAGE[ToolCallRefusal.TooLarge]);
  return { ok: true, call: { callId: fields.callId, name: fields.tool, args: fields.args } };
}

/** `x.y.z` as numbers, and whether a pre-release tag follows; null for anything else. */
function versionCore(raw: string): { core: number[]; pre: boolean } | null {
  const match = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?/.exec(raw);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: Boolean(match[4]) };
}

/**
 * Whether a CLI's reported version (`codex-cli 0.159.0`) is at least `minimum`. A pre-release of
 * the minimum is below it, and a version that cannot be read is never new enough.
 */
export function meetsMinimumVersion(raw: string | undefined, minimum: string): boolean {
  const found = raw ? versionCore(raw) : null;
  const floor = versionCore(minimum);
  if (!found || !floor) return false;
  for (const [index, part] of found.core.entries()) {
    const delta = part - (floor.core[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return !found.pre;
}
