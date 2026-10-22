/**
 * Epic's `describe_toolset` answers, fitted to one tool answer. Some toolsets describe themselves in
 * hundreds of kilobytes (Niagara's system toolset in about 278 KB, some 70,000 tokens), more than an
 * engine takes from one tool (Claude Code's limit is 25,000 tokens), so the agent would read none of
 * it. A description over {@link MAX_DESCRIPTION_CHARS} comes back as its tools' names, each with the
 * first line of its description, and `tool_name` reads one tool's whole entry. A description whose
 * tools the bridge can't find is cut at the limit instead, and so is anything still too long once
 * shortened. Anything shorter is handed over as Epic sent it; each note is a text part of its own.
 */

/** The longest text handed over in one answer, in characters: about 15,000 tokens of JSON. */
const MAX_DESCRIPTION_CHARS = 60_000;
/** The longest first line of a tool's description kept in a shortened description. */
const SUMMARY_CHARS = 200;

const MESSAGE = {
  Listed: (kb: number, lines: boolean) =>
    `This toolset's description is ${kb} KB, too long for one answer, so each tool is listed by name${lines ? " with the first line of its description" : ""}. Call describe_toolset again with tool_name to read one tool's whole description and input schema.`,
  Cut: (kb: number) =>
    `[Cut after the first ${MAX_DESCRIPTION_CHARS / 1000} KB of ${kb} KB: too long for one tool answer.]`,
  NoSuchTool: (tool: string, names: string[]) =>
    `This toolset has no tool ${JSON.stringify(tool)}. Its tools: ${names.join(", ")}.`,
  NoToolList: (tool: string) =>
    `[tool_name ${JSON.stringify(tool)} didn't apply: this description doesn't list its tools in a form Genex reads, so it came as Epic sent it.]`,
} as const;

type Part = { type: string; [key: string]: unknown };
type ToolEntry = { name: string; [key: string]: unknown };
/** A description's tools, and the description with another list in their place. */
type Listed = { tools: ToolEntry[]; with: (tools: unknown[]) => unknown };
type Fit = { parts: Part[]; failed?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isToolList = (value: unknown): value is ToolEntry[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => isRecord(item) && typeof item.name === "string");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const textPart = (text: string): Part => ({ type: "text", text });
const kilobytes = (text: string) => Math.ceil(text.length / 1000);
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** `text`'s first `limit` characters, one fewer when the last would split a character in two. */
function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit);
}

/** `text` as one answer holds it: whole when short enough, else cut with a note saying so. */
function capped(text: string, notes: string[] = []): Part[] {
  if (text.length <= MAX_DESCRIPTION_CHARS) return [text, ...notes].map(textPart);
  return [cutAt(text, MAX_DESCRIPTION_CHARS), ...notes, MESSAGE.Cut(kilobytes(text))].map(textPart);
}

/** Where a description lists its tools: the answer itself, its `tools`, or another field holding the list. */
function toolsIn(value: unknown): Listed | undefined {
  if (isToolList(value)) return { tools: value, with: (tools) => tools };
  if (!isRecord(value)) return undefined;
  const key = isToolList(value.tools) ? "tools" : Object.keys(value).find((name) => isToolList(value[name]));
  if (key === undefined) return undefined;
  return { tools: value[key] as ToolEntry[], with: (tools) => ({ ...value, [key]: tools }) };
}

/** A tool's own name, without the toolset in front of it, in lower case. */
const shortName = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** The first line of a tool's description, at most {@link SUMMARY_CHARS} long. */
function firstLine(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  const line = description.trim().split("\n")[0] ?? "";
  return line.length > SUMMARY_CHARS ? `${cutAt(line, SUMMARY_CHARS - 1)}…` : line;
}

/** A tool as a shortened description lists it: its name and the first line of its description. */
function summary(tool: ToolEntry): ToolEntry {
  const line = firstLine(tool.description);
  return line === undefined ? { name: tool.name } : { name: tool.name, description: line };
}

/** The entry of the one tool `tool` names, or the toolset's tool names when it names none. */
function oneTool(listed: Listed, tool: string): Fit {
  const named = listed.tools.filter((entry) => shortName(entry.name) === shortName(tool));
  if (named.length > 0) return { parts: capped(JSON.stringify(listed.with(named))) };
  const names = listed.tools.map((entry) => entry.name);
  return { parts: capped(MESSAGE.NoSuchTool(tool, names)), failed: true };
}

/** A description too long for one answer, as its tools with their first lines, or by name alone when even those are too long. */
function listing(listed: Listed, text: string): Part[] {
  const withLines = JSON.stringify(listed.with(listed.tools.map(summary)));
  if (withLines.length <= MAX_DESCRIPTION_CHARS)
    return [withLines, MESSAGE.Listed(kilobytes(text), true)].map(textPart);
  const names = JSON.stringify(listed.with(listed.tools.map(({ name }) => ({ name }))));
  return capped(names, [MESSAGE.Listed(kilobytes(text), false)]);
}

/** One text part of a description, fitted; `failed` when `tool` names none of its tools. */
function fitText(text: string, tool: string | undefined): Fit {
  const listed = toolsIn(parseJson(text));
  if (tool !== undefined && listed) return oneTool(listed, tool);
  const notes = tool === undefined ? [] : [MESSAGE.NoToolList(tool)];
  if (listed && text.length > MAX_DESCRIPTION_CHARS) return { parts: listing(listed, text) };
  return { parts: capped(text, notes) };
}

/**
 * Epic's answer to `describe_toolset`, fitted to one tool answer: with `tool`, only that tool's
 * entry (by its name, with or without the toolset in front); without, the description as it came
 * when it is short enough, else its tools by name. A blank `tool` names no tool. `failed` when
 * `tool` names none of its tools.
 */
export function fitDescription(parts: Part[], tool?: string): { parts: Part[]; failed: boolean } {
  const named = tool?.trim() || undefined;
  let failed = false;
  const fitted = parts.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return [part];
    const fit = fitText(part.text, named);
    failed ||= fit.failed === true;
    return fit.parts;
  });
  return { parts: fitted, failed };
}
