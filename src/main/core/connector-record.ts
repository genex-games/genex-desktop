/**
 * What a connector call's records keep beyond its name and outcome (`plugin-tools.ts` writes
 * them): the toolset and tool a toolset gateway reached, the call's own arguments clipped for the
 * log, and the pictures it answered with, saved in the game's captures folder so the chat can show
 * them. The log holds only their game-relative paths; the bytes stay on disk.
 */
import { lstat, mkdir, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONNECTOR_ARGS_RECORD_MAX,
  CONNECTOR_CAPTURES_DIR,
  type ConnectorCall,
  ToolsetGatewayArg,
} from "../../shared/mcp.ts";
import { isCredentialName, REDACTED, redactTokens } from "../../shared/redact.ts";
import { shortId } from "../../substrate/ids.ts";
import { sniffImage } from "../../substrate/image-sniff.ts";

/** A long text argument (a script, Blueprint text) keeps this much of its opening in the record. */
const ARG_TEXT_MAX = 240;
/** What a clipped text ends with. */
const ELLIPSIS = "…";
/** The pictures a game keeps; the oldest go first past either cap. */
export const CAPTURES_KEPT = 60;
export const CAPTURES_TOTAL_BYTES = 128 * 1024 * 1024;
/** A picture bigger than this is not kept: the chat could not open it beside the conversation. */
const CAPTURE_FILE_BYTES = 16 * 1024 * 1024;
/** The names this module gives captures, so pruning never touches a file it did not write. */
const CAPTURE_NAME = /^shot_[0-9a-f]{20}\.(?:png|jpg|webp|gif)$/;

/** The toolset, tool and arguments a connector call's records name. */
export function connectorCallFields(
  args: Record<string, unknown>,
): Pick<ConnectorCall, "toolset" | "toolName" | "args"> {
  const toolset = textArg(args[ToolsetGatewayArg.Toolset]);
  const toolName = textArg(args[ToolsetGatewayArg.Tool]);
  const inner = args[ToolsetGatewayArg.Arguments];
  const own = toolName && isRecord(inner) ? inner : args;
  const kept = fitJson(own, CONNECTOR_ARGS_RECORD_MAX);
  return {
    ...(toolset ? { toolset } : {}),
    ...(toolName ? { toolName } : {}),
    ...(isRecord(kept) && Object.keys(kept).length ? { args: kept } : {}),
  };
}

const textArg = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `value` cut to at most `room` characters of JSON, or undefined when none of it fits. */
function fitJson(value: unknown, room: number): unknown {
  if (typeof value === "string") return fitText(redactTokens(value), room);
  if (Array.isArray(value)) return fitEntries(value.entries(), room, []);
  if (isRecord(value)) return fitEntries(Object.entries(value), room, {});
  const json = JSON.stringify(value);
  return json !== undefined && json.length <= room ? value : undefined;
}

/** A text's opening that fits `room` characters of JSON, ending in "…" when cut. */
function fitText(text: string, room: number): string | undefined {
  const opening = text.length > ARG_TEXT_MAX ? `${text.slice(0, ARG_TEXT_MAX - 1)}${ELLIPSIS}` : text;
  if (JSON.stringify(opening).length <= room) return opening;
  for (let keep = Math.min(text.length, room) - 1; keep > 0; keep--) {
    const cut = `${text.slice(0, keep)}${ELLIPSIS}`;
    if (JSON.stringify(cut).length <= room) return cut;
  }
  return undefined;
}

/** As many entries of an object or array as fit `room`, in order; a credential's value is redacted. */
function fitEntries(
  entries: Iterable<[string | number, unknown]>,
  room: number,
  out: unknown[] | Record<string, unknown>,
): unknown {
  let used = 2;
  for (const [key, item] of entries) {
    const label = typeof key === "string" ? JSON.stringify(key).length + 1 : 0;
    const comma = used > 2 ? 1 : 0;
    const left = room - used - label - comma;
    if (left <= 0) break;
    const fitted = fitEntry(key, item, left);
    if (fitted === undefined) continue;
    if (Array.isArray(out)) out.push(fitted);
    else out[String(key)] = fitted;
    used += label + comma + JSON.stringify(fitted).length;
  }
  return out;
}

/** One entry's value cut to `left` characters of JSON; a credential-named field's is redacted. */
function fitEntry(key: string | number, item: unknown, left: number): unknown {
  const credential = typeof key === "string" && isCredentialName(key);
  const fitted = credential ? REDACTED : fitJson(item, left);
  return fitted !== undefined && JSON.stringify(fitted).length <= left ? fitted : undefined;
}

/** Caps a game's captures folder is held to; the tests pass small ones. */
export interface CaptureLimits {
  kept?: number;
  totalBytes?: number;
}

/**
 * Save a connector's pictures under the game's captures folder and return their game-relative
 * paths. The folder is the game's own: when `.studio` or its `captures` is a link (an agent can
 * write the game folder), nothing is saved, and nothing outside is touched. A part that is not a
 * readable picture, or is too big to open, is skipped. Past either cap the oldest captures go,
 * and only files this module named.
 */
export async function keepCaptures(
  gameDir: string,
  images: ReadonlyArray<{ data: string }>,
  limits: CaptureLimits = {},
): Promise<string[]> {
  if (!images.length) return [];
  const dir = await capturesDir(gameDir);
  if (!dir) return [];
  const kept: string[] = [];
  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    const sniffed = sniffImage(bytes);
    if (!sniffed || bytes.length > CAPTURE_FILE_BYTES) continue;
    const name = `${shortId("shot")}${sniffed.ext}`;
    // `wx`: a file, or a link, already at that name is never written through.
    await writeFile(path.join(dir, name), bytes, { flag: "wx", mode: 0o600 });
    kept.push(`${CONNECTOR_CAPTURES_DIR}/${name}`);
  }
  await pruneCaptures(dir, limits.kept ?? CAPTURES_KEPT, limits.totalBytes ?? CAPTURES_TOTAL_BYTES);
  return kept;
}

/** The game's real captures folder, made when missing; null when any part of it is a link. */
async function capturesDir(gameDir: string): Promise<string | null> {
  const root = await realpath(gameDir);
  let dir = root;
  for (const part of CONNECTOR_CAPTURES_DIR.split("/")) {
    dir = path.join(dir, part);
    const found = await lstat(dir).catch(() => null);
    if (!found) await mkdir(dir, { mode: 0o700 });
    else if (!found.isDirectory()) return null;
  }
  return (await realpath(dir)) === dir ? dir : null;
}

/** Remove the oldest captures this module wrote until both caps hold. */
async function pruneCaptures(dir: string, kept: number, totalBytes: number): Promise<void> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && CAPTURE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const sizes = await Promise.all(names.map(async (name) => (await lstat(path.join(dir, name))).size));
  let count = names.length;
  let total = sizes.reduce((sum, size) => sum + size, 0);
  for (const [index, name] of names.entries()) {
    if (count <= kept && total <= totalBytes) break;
    await unlink(path.join(dir, name));
    count -= 1;
    total -= sizes[index] ?? 0;
  }
}
