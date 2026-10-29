/**
 * The Game Animation Sample's settings a game needs beside its content, merged into the game's own
 * config files as text: the `Traversable` trace channel its traversal traces on (it must be the same
 * custom channel the sample's assets name), its data-driven console variables, its plain console
 * variables and its gameplay tags. Only what the game lacks is added; a game whose channel is
 * already another's is refused, since the sample's assets would trace on it. Pure: no file is read
 * or written here (`motion-tools.ts` does that).
 */

/** The config sections the sample's settings live in. */
const Section = {
  Collision: "/Script/Engine.CollisionProfile",
  DataDrivenCvars: "/Script/Engine.DataDrivenConsoleVariableSettings",
  ConsoleVariables: "ConsoleVariables",
  GameplayTags: "/Script/GameplayTags.GameplayTagsSettings",
} as const;
type Section = (typeof Section)[keyof typeof Section];

/** The array lines of the sample's sections that are merged, by their key. */
const CHANNEL_LINE = "+DefaultChannelResponses=";
const CVAR_LINE = "+CVarsArray=";
const TAG_LINES = ["+GameplayTagList=", "+GameplayTagRedirects="] as const;

/** Why the sample's settings can't go into a game: its channel is taken. */
const MESSAGE = {
  ChannelTaken: (channel: string, theirs: string, ours: string) =>
    `The game already uses ${channel} as its "${theirs}" trace channel, and the Game Animation Sample's traversal traces on ${channel} as "${ours}". Free that channel first.`,
} as const;

/** A config file as its sections' lines, in order; lines before the first header belong to "". */
type Ini = Array<{ name: string; lines: string[] }>;
/** A config file parsed, with the line ending it uses, so it is written back with the same. */
type IniFile = { ini: Ini; eol: string };

/** A section header's name, or null for any other line. */
function headerOf(line: string): string | null {
  const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  return match?.[1] ?? null;
}

/** A config file's text as its sections, and its line ending (CRLF when it has one, else LF). */
function parse(text: string): IniFile {
  const ini: Ini = [{ name: "", lines: [] }];
  for (const line of text ? text.split(/\r?\n/) : []) {
    const header = headerOf(line);
    if (header !== null) ini.push({ name: header, lines: [] });
    else ini.at(-1)?.lines.push(line);
  }
  return { ini, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** The sections back as text in the file's line ending, each header then its lines, ending with one line ending. */
function render({ ini, eol }: IniFile): string {
  const lines = ini.flatMap((section) => (section.name ? [`[${section.name}]`, ...section.lines] : section.lines));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return `${lines.join(eol)}${eol}`;
}

/** Whether a config file holds anything yet: a section or a line. */
const holdsAnything = (ini: Ini) => ini.some((section) => section.name || section.lines.some((line) => line.trim()));

/** A section's lines, trimmed and without blanks. */
function linesOf(ini: Ini, name: Section): string[] {
  return ini
    .filter((section) => section.name === name)
    .flatMap((section) => section.lines.map((line) => line.trim()).filter(Boolean));
}

/**
 * Adds lines at the end of a section's own lines (before its trailing blanks), making the section
 * when missing (after a blank line, unless the file is empty).
 */
function addLines(ini: Ini, name: Section, added: readonly string[]): void {
  if (!added.length) return;
  const section = ini.findLast((one) => one.name === name);
  if (!section) {
    const last = ini.at(-1);
    const separated = !holdsAnything(ini) || !last?.lines.at(-1)?.trim();
    ini.push({ name, lines: [...added] });
    if (!separated) last?.lines.push("");
    return;
  }
  let at = section.lines.length;
  while (at > 0 && !section.lines[at - 1]?.trim()) at -= 1;
  section.lines.splice(at, 0, ...added);
}

/** A field of an array line, such as Channel or Name. */
function fieldOf(line: string, field: string): string | null {
  const match = new RegExp(`\\b${field}="?([^",)]+)"?`).exec(line);
  return match?.[1] ?? null;
}

/** The sample's channel lines the game lacks, or why the game can't take them. */
function channelsToAdd(game: Ini, sample: Ini): { lines: string[] } | { conflict: string } {
  const theirs = linesOf(game, Section.Collision).filter((line) => line.startsWith(CHANNEL_LINE));
  const lines: string[] = [];
  for (const line of linesOf(sample, Section.Collision).filter((one) => one.startsWith(CHANNEL_LINE))) {
    const channel = fieldOf(line, "Channel");
    const name = fieldOf(line, "Name") ?? "";
    const taken = theirs.find((one) => fieldOf(one, "Channel") === channel);
    if (!taken) lines.push(line);
    else if (fieldOf(taken, "Name") !== name)
      return { conflict: MESSAGE.ChannelTaken(String(channel), fieldOf(taken, "Name") ?? "", name) };
  }
  return { lines };
}

/** The sample's array lines of a section the game lacks, a line known by `keyOf`. */
function missingBy(
  game: Ini,
  sample: Ini,
  name: Section,
  keep: (line: string) => boolean,
  keyOf: (line: string) => string,
) {
  const have = new Set(linesOf(game, name).filter(keep).map(keyOf));
  return linesOf(sample, name).filter((line) => keep(line) && !have.has(keyOf(line)));
}

/** A plain console variable line's name (the text before `=`). */
const variableOf = (line: string) => line.split("=", 1)[0]?.trim() ?? line;
/** A data-driven console variable line's name. */
const cvarOf = (line: string) => fieldOf(line, "Name") ?? line;
const isCvar = (line: string) => line.startsWith(CVAR_LINE);
const isVariable = (line: string) => line.includes("=") && !line.startsWith("+") && !line.startsWith("-");
const isTag = (line: string) => TAG_LINES.some((start) => line.startsWith(start));

/**
 * The game's DefaultEngine.ini with the sample's trace channel, data-driven console variables and
 * console variables it lacks; or why the channel can't go in. A game with no such file passes "".
 */
export function mergeEngineIni(game: string, sample: string): { text: string } | { conflict: string } {
  const file = parse(game);
  const ours = file.ini;
  const theirs = parse(sample).ini;
  const channels = channelsToAdd(ours, theirs);
  if ("conflict" in channels) return channels;
  addLines(ours, Section.Collision, channels.lines);
  addLines(ours, Section.DataDrivenCvars, missingBy(ours, theirs, Section.DataDrivenCvars, isCvar, cvarOf));
  addLines(ours, Section.ConsoleVariables, missingBy(ours, theirs, Section.ConsoleVariables, isVariable, variableOf));
  return { text: render(file) };
}

/** The game's DefaultGameplayTags.ini with the sample's tags and tag redirects it lacks; the sample's own when the game has none. */
export function mergeGameplayTagsIni(game: string | null, sample: string): string {
  if (game === null) return sample;
  const file = parse(game);
  addLines(
    file.ini,
    Section.GameplayTags,
    missingBy(file.ini, parse(sample).ini, Section.GameplayTags, isTag, (line) => line),
  );
  return render(file);
}
