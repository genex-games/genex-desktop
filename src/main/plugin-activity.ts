/**
 * The host's record of a plugin tool call, as pure builders.
 *
 * A plugin tool used to leave `{pluginId, tool, version, result}` on the delegated paths and
 * nothing at all on the local harness: no start, no arguments, no ok/error, no image count, no
 * plugin name, and — fatally for the Builds graph, which drops any custom event whose
 * `payload.runId` is not the run's — no worker attribution. These builders produce the two
 * payloads that fix that, and they are pure so the digests can be tested without a studio.
 *
 * Nothing here ever carries image bytes: `resultDigest` removes base64 and data URLs, so a
 * generated picture cannot be copied into the thread log by way of a tool result.
 */
import { randomUUID } from "node:crypto";
import type { CallMaking } from "../shared/asset-making.ts";
import { GenexBlocked } from "../shared/genex.ts";
import type { PluginToolFinishedPayload, PluginToolRole, PluginToolStartedPayload } from "../shared/game-assets.ts";
import { isJsonObject } from "../substrate/fsx.ts";

/** The arguments digest is a chat line, not a transcript. */
const ARGS_MAX = 200;
/** The result digest is an inspectable record, capped so one tool call cannot bloat a thread. */
const RESULT_MAX = 4096;
/** Keys whose values are images, credentials or other payloads that must never reach the log. */
const DROPPED_KEYS = new Set([
  "approval",
  "images",
  "image",
  "data",
  "dataUrl",
  "dataURL",
  "base64",
  "token",
  "secret",
  "credential",
  "credentials",
]);
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A value that prints as itself in one line: not undefined or null, not an object or a function. */
function isScalar(value: unknown): value is string | number | boolean | bigint | symbol {
  const type = typeof value;
  return value !== undefined && value !== null && type !== "object" && type !== "function";
}

/**
 * A string that is (or contains) an encoded payload becomes a note about its size, never its
 * bytes. The test for "this is base64" is deliberately narrow — unbroken, correctly padded,
 * and varied enough to be encoded bytes rather than prose — because a wrongly-redacted prompt
 * is a worse chat line than a slightly long one, and every string is clipped anyway.
 */
function redactText(value: string): string {
  if (/^data:[^;,]*;base64,/i.test(value)) return `[data url omitted: ${value.length} chars]`;
  if (
    value.length >= 64 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    new Set(value).size >= 16
  ) {
    return `[base64 omitted: ${value.length} chars]`;
  }
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

function redact(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key)) continue;
    out[key] = redact(item, depth + 1);
  }
  return out;
}

/**
 * What the model asked for, in one line: the fields a generation tool actually varies come
 * first, then whatever else it declared. Only scalars — a plugin's own parameters are scalar
 * by contract, and anything else is a shape this digest has no business unfolding.
 */
export function argsDigest(args: unknown): string {
  if (!isJsonObject(args)) return "";
  const record = args;
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (key: string): void => {
    if (seen.has(key)) return;
    const value = record[key];
    if (!isScalar(value)) return;
    seen.add(key);
    parts.push(`${key}=${redactText(String(value)).replace(/\s+/g, " ").trim()}`);
  };
  for (const key of ["operation", "prompt", "id"]) push(key);
  for (const key of Object.keys(record)) push(key);
  return clip(parts.join(" "), ARGS_MAX);
}

/** The result record as JSON, with encoded payloads removed and a hard ceiling. */
export function resultDigest(record: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redact(record, 0)) ?? "";
  } catch {
    json = "";
  }
  return clip(json, RESULT_MAX);
}

/**
 * Which session asked. There is no `role` on a delegate request: the worker path sets
 * `selfCapture`, a run's sub-agent sets `attribution`, the director path sets `director`, and a
 * plain chat build sets none of them.
 */
export function roleOf(context: { director?: unknown; selfCapture?: unknown; attribution?: unknown }): PluginToolRole {
  if (context.director) return "director";
  if (context.selfCapture || context.attribution) return "builder";
  return "chat";
}

/** Everything the host knows when a plugin tool call begins. */
export interface PluginToolCall {
  callId?: string;
  pluginId: string;
  pluginName: string;
  /** The bare declared name (`asset`). */
  tool: string;
  /** The namespaced name the engines call (`genex__asset`). */
  toolName: string;
  args: unknown;
  project: string;
  threadId?: string;
  runId?: string;
  facetId?: string;
  iteration?: number;
  engine: string;
  role: PluginToolRole;
  at?: string;
  /** What the call makes, when its tool says (`shared/asset-making.ts`). */
  making?: CallMaking;
}

/** The `plugin_tool_started` payload. `runId`/`facetId`/`iteration` stay at the top level on purpose. */
export function startedPayload(call: PluginToolCall): PluginToolStartedPayload {
  const payload: PluginToolStartedPayload = {
    callId: call.callId ?? randomUUID(),
    pluginId: call.pluginId,
    pluginName: call.pluginName,
    tool: call.tool,
    toolName: call.toolName,
    args: argsDigest(call.args),
    project: call.project,
    ...(call.threadId ? { threadId: call.threadId } : {}),
    ...(call.runId ? { runId: call.runId } : {}),
    ...(call.facetId ? { facetId: call.facetId } : {}),
    ...(call.iteration !== undefined ? { iteration: call.iteration } : {}),
    engine: call.engine,
    role: call.role,
    at: call.at ?? new Date().toISOString(),
    ...(call.making ? { making: call.making } : {}),
  };
  return payload;
}

/** What the call returned, or what it threw. */
export type PluginToolOutcome = { result: unknown; version?: string } | { error: unknown; version?: string };

/**
 * The `plugin_tool` payload: the start, plus how it ended. A result shaped like a plugin job
 * record (`{id, files?, generationId?}`) also yields the ids the Assets canvas and the Builds
 * graph join a delivery on — Genex is the shape that exists today, and any plugin that answers
 * with the same three fields is read the same way.
 */
export function finishedPayload(
  started: PluginToolStartedPayload,
  outcome: PluginToolOutcome,
  images: number,
  durationMs: number,
): PluginToolFinishedPayload {
  const failed = "error" in outcome;
  const record = failed ? null : (outcome as { result: unknown }).result;
  const { files, jobId, generationId } = jobIds(record);
  const error = failed ? String((outcome as { error: unknown }).error ?? "") : null;
  const blocked = blockedBy(record);
  return {
    ...started,
    ok: !failed,
    ...(error ? { error: clip(error.replace(/^Error:\s*/, ""), 600) } : {}),
    result: failed ? "" : resultDigest(record),
    images: positiveOrZero(images, Math.floor),
    ...(files?.length ? { files } : {}),
    ...(jobId ? { jobId } : {}),
    ...(generationId !== null ? { generationId } : {}),
    ...(blocked ? { blocked } : {}),
    durationMs: positiveOrZero(durationMs, Math.round),
    ...(outcome.version ? { version: outcome.version } : {}),
  };
}

/** What a job-shaped result says the job is waiting on the person for, when it names a known reason. */
function blockedBy(record: unknown): GenexBlocked | null {
  if (!isJsonObject(record)) return null;
  return Object.values(GenexBlocked).find((reason) => reason === record.blocked) ?? null;
}

/** A count or a duration as a whole number, and 0 for anything that is not a positive number. */
function positiveOrZero(value: number, whole: (n: number) => number): number {
  return Number.isFinite(value) && value > 0 ? whole(value) : 0;
}

/**
 * The ids a job-shaped result carries (`{id, files?, generationId?}`): an id counts only beside
 * files or a generation id, so an arbitrary `{id}` answer is not read as a job.
 */
function jobIds(record: unknown): { files: string[] | null; jobId: string | null; generationId: string | null } {
  if (!isJsonObject(record)) return { files: null, jobId: null, generationId: null };
  const job = record;
  const files = Array.isArray(job.files)
    ? job.files.filter((f): f is string => typeof f === "string").slice(0, MAX_ITEMS)
    : null;
  const generationId = typeof job.generationId === "string" ? job.generationId : null;
  const jobShaped = files !== null || generationId !== null;
  const jobId = typeof job.id === "string" && jobShaped ? job.id : null;
  return { files, jobId, generationId };
}
