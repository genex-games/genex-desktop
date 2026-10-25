/**
 * Roblox Studio's own MCP switch, in each account's settings file: Studio keeps
 * `"mcp-server": {"enabled": true}` in `AssistantSettings/<account number>.json` (Mac
 * `~/Library/Roblox/AssistantSettings`, Windows presumed `%LOCALAPPDATA%\Roblox\AssistantSettings`).
 *
 * - Genex turns it on in every file named by digits only (each account's), never makes a file and
 *   never guesses an account: with no file there are no settings, and the person clicks the switch.
 * - Studio rewrites the file while it runs, so the switch is written only while Studio is closed.
 * - The edit is made in the file's own text: every other key keeps its bytes, and Undo can put the
 *   switch back exactly as long as the file still holds Genex's value.
 * - A link, something other than a file, an oversize file or one that isn't a single JSON object
 *   refuses the whole step before any file is written.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { RobloxSetupError, SetupRefusal } from "./setup-refusal.ts";
import { MESSAGE } from "./words.ts";

/** The largest settings file Genex reads: Studio's own is a few hundred bytes. */
export const MAX_SETTINGS_BYTES = 256 * 1024;
/** The settings file's key for Studio's MCP server. */
export const MCP_SERVER_KEY = "mcp-server";
const ENABLED_KEY = "enabled";
/** An account's settings file: its account number and `.json`, nothing else. */
const SETTINGS_NAME = /^\d{1,20}\.json$/;
const JSON_SPACE = " \t\n\r";
const LITERAL_END = `,}]${JSON_SPACE}`;

/** One account's settings file as read: its text and its permission bits. */
export interface SettingsFile {
  file: string;
  text: string;
  mode: number;
}

/** What turning the switch on changed in one file: the switch's value text before (null: absent) and after. */
export interface SwitchChange {
  before: string | null;
  after: string;
}

/** One file to write, with what it changes. */
export interface SwitchWrite extends SwitchChange {
  file: string;
  text: string;
  mode: number;
}

/** The switch across every account's file, read and worked out before anything is written. */
export interface SwitchPlan {
  /** The account files found. */
  files: number;
  /** Files whose switch is already on: left alone. */
  alreadyOn: number;
  writes: SwitchWrite[];
}

/** A member of a JSON object as it sits in the text. */
interface Member {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
}

/** A JSON object in the text: where its braces are and its members in order. */
interface ObjectSpan {
  open: number;
  close: number;
  members: Member[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && JSON_SPACE.includes(text.charAt(at))) at++;
  return at;
}

/** Just past the string whose opening quote is at `from`. */
function stringEnd(text: string, from: number): number {
  for (let at = from + 1; at < text.length; at++) {
    const char = text.charAt(at);
    if (char === "\\") at++;
    else if (char === '"') return at + 1;
  }
  return text.length;
}

/** Just past the literal (a number, true, false or null) that starts at `from`. */
function literalEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && !LITERAL_END.includes(text.charAt(at))) at++;
  return at;
}

/** Just past the object or array whose opening bracket is at `from`. */
function bracketsEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    const char = text.charAt(at);
    if (char === '"') at = stringEnd(text, at) - 1;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth === 0) return at + 1;
  }
  return text.length;
}

/** Just past the JSON value that starts at `from`, in text JSON.parse already accepted. */
function valueEnd(text: string, from: number): number {
  const first = text.charAt(from);
  if (first === '"') return stringEnd(text, from);
  return first === "{" || first === "[" ? bracketsEnd(text, from) : literalEnd(text, from);
}

/** The object whose opening brace is at `open`, in text JSON.parse already accepted. */
function objectAt(text: string, open: number): ObjectSpan {
  const members: Member[] = [];
  let at = skipSpace(text, open + 1);
  while (text.charAt(at) === '"') {
    const keyEnd = stringEnd(text, at);
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, valueStart);
    members.push({ key: JSON.parse(text.slice(at, keyEnd)) as string, start: at, valueStart, valueEnd: end });
    at = skipSpace(text, end);
    if (text.charAt(at) === ",") at = skipSpace(text, at + 1);
  }
  return { open, close: at, members };
}

/** The settings as one JSON object, or undefined when the text isn't one. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The member named `key`, undefined when absent; a key named twice is refused. */
function memberNamed(span: ObjectSpan, key: string): Member | undefined {
  const found = span.members.filter((member) => member.key === key);
  if (found.length > 1) throw new RobloxSetupError(SetupRefusal.UnreadableSettings, MESSAGE.Setup.TwiceNamed(key));
  return found[0];
}

/** The whitespace before an object's first member: a line break and its indent in Studio's layout. */
const leadOf = (text: string, span: ObjectSpan, first: Member) => text.slice(span.open + 1, first.start);

/** The text with `key` set to `value` in the object `span`: replaced where it is, else added first. */
function withMember(text: string, span: ObjectSpan, key: string, value: string): string {
  const found = memberNamed(span, key);
  if (found) return text.slice(0, found.valueStart) + value + text.slice(found.valueEnd);
  const entry = `${JSON.stringify(key)}: ${value}`;
  const first = span.members[0];
  if (!first) return text.slice(0, span.open + 1) + entry + text.slice(span.open + 1);
  return `${text.slice(0, first.start)}${entry},${leadOf(text, span, first)}${text.slice(first.start)}`;
}

/** The text without `member`, and the comma and whitespace that joined it to its neighbour. */
function withoutMember(text: string, span: ObjectSpan, member: Member): string {
  const index = span.members.indexOf(member);
  const next = span.members[index + 1];
  if (next) return text.slice(0, member.start) + text.slice(next.start);
  const previous = span.members[index - 1];
  if (previous) return text.slice(0, previous.valueEnd) + text.slice(member.valueEnd);
  return text.slice(0, member.start) + text.slice(member.valueEnd);
}

/** A new switch's value in the file's own layout: indented like its members, or on one line. */
function switchValue(text: string, span: ObjectSpan): string {
  const first = span.members[0];
  const lead = first ? leadOf(text, span, first) : "";
  const indent = lead.includes("\n") ? lead.slice(lead.lastIndexOf("\n") + 1) : "";
  if (!indent) return `{${JSON.stringify(ENABLED_KEY)}: true}`;
  return `{\n${indent}${indent}${JSON.stringify(ENABLED_KEY)}: true\n${indent}}`;
}

/** The switch member's value text, or null when the file has no switch. */
const switchText = (text: string, span: ObjectSpan) => {
  const member = memberNamed(span, MCP_SERVER_KEY);
  return member ? text.slice(member.valueStart, member.valueEnd) : null;
};

/**
 * One settings file's text with Studio's MCP switch on, and what changed; undefined when it is
 * already on. Text that isn't one JSON object, or that names the switch twice, is refused.
 */
export function switchOnText(text: string): { text: string; change: SwitchChange } | undefined {
  const settings = parseObject(text);
  if (!settings) throw new RobloxSetupError(SetupRefusal.UnreadableSettings, MESSAGE.Setup.NotSettings());
  const current = settings[MCP_SERVER_KEY];
  if (isPlainObject(current) && current[ENABLED_KEY] === true) return undefined;
  const span = objectAt(text, skipSpace(text, 0));
  const member = memberNamed(span, MCP_SERVER_KEY);
  const turned =
    member && isPlainObject(current)
      ? withMember(text, objectAt(text, member.valueStart), ENABLED_KEY, "true")
      : withMember(text, span, MCP_SERVER_KEY, switchValue(text, span));
  const after = switchText(turned, objectAt(turned, skipSpace(turned, 0)));
  if (after === null) throw new RobloxSetupError(SetupRefusal.UnreadableSettings, MESSAGE.Setup.NotSettings());
  return { text: turned, change: { before: member ? text.slice(member.valueStart, member.valueEnd) : null, after } };
}

/**
 * The text with the switch put back as it was before Genex turned it on; undefined when the file
 * no longer holds Genex's value (the person or Studio changed it since), which is then left alone.
 */
export function switchBackText(text: string, change: SwitchChange): string | undefined {
  if (!parseObject(text)) return undefined;
  const span = objectAt(text, skipSpace(text, 0));
  let member: Member | undefined;
  try {
    member = memberNamed(span, MCP_SERVER_KEY);
  } catch {
    return undefined;
  }
  if (!member || text.slice(member.valueStart, member.valueEnd) !== change.after) return undefined;
  if (change.before === null) return withoutMember(text, span, member);
  return text.slice(0, member.valueStart) + change.before + text.slice(member.valueEnd);
}

/** One account's file: a plain file, not a link, of a sane size, holding one JSON object. */
async function readSettingsFile(file: string, realFolder: string): Promise<SettingsFile> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || path.dirname(await realpath(file)) !== realFolder)
    throw new RobloxSetupError(SetupRefusal.Linked, MESSAGE.Setup.Linked(file));
  const bytes = await readRegularFile(file, MAX_SETTINGS_BYTES).catch(() => undefined);
  const text = bytes?.toString("utf8");
  if (text === undefined || !parseObject(text))
    throw new RobloxSetupError(SetupRefusal.UnreadableSettings, MESSAGE.Setup.Unreadable(file));
  return { file, text, mode: info.mode & 0o777 };
}

/**
 * Every account's settings file in `folder`, in name order; none when the folder isn't there.
 * Files not named by digits alone are passed over. A linked folder, or any hostile account file,
 * refuses them all.
 */
export async function readSwitches(folder: string): Promise<SettingsFile[]> {
  const info = await lstat(folder).catch(() => undefined);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new RobloxSetupError(SetupRefusal.Linked, MESSAGE.Setup.Linked(folder));
  if (!info.isDirectory()) throw new RobloxSetupError(SetupRefusal.NotAFolder, MESSAGE.Setup.NotAFolder(folder));
  const real = await realpath(folder);
  const names = (await readdir(folder)).filter((name) => SETTINGS_NAME.test(name)).sort();
  const files: SettingsFile[] = [];
  for (const name of names) files.push(await readSettingsFile(path.join(folder, name), real));
  return files;
}

/** The switch across every account's file in `folder`, worked out without writing anything. */
export async function planSwitches(folder: string): Promise<SwitchPlan> {
  const files = await readSwitches(folder);
  const writes: SwitchWrite[] = [];
  for (const file of files) {
    const on = switchOnText(file.text);
    if (on) writes.push({ file: file.file, text: on.text, mode: file.mode, ...on.change });
  }
  return { files: files.length, alreadyOn: files.length - writes.length, writes };
}

/** Writes a plan's files, each whole or not at all; refused when Studio has started meanwhile. */
export async function turnOn(plan: SwitchPlan, running: () => Promise<boolean>): Promise<void> {
  if (plan.writes.length > 0 && (await running()))
    throw new RobloxSetupError(SetupRefusal.StudioRunning, MESSAGE.Setup.StudioRunning());
  for (const write of plan.writes) await atomicWriteText(write.file, write.text, { mode: write.mode });
}
