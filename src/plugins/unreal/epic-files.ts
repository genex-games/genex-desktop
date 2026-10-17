/**
 * How Epic's project creation reads and writes text (UE 5.8.3): FFileHelper's encodings, the
 * two-pass ReplacementsInFiles, SaveConfigValues' line-by-line ini edit and FProjectDescriptor's
 * `.uproject` layout. Each mirrors the engine source named beside it, so a project Genex makes reads
 * byte for byte like one from Unreal's New Project dialog.
 */
import { isJsonObject } from "../../substrate/fsx.ts";
import type { TemplateReplacement } from "./template-defs.ts";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16_LE_BOM = [0xff, 0xfe] as const;
const UTF16_BE_BOM = [0xfe, 0xff] as const;
const HIGHEST_ANSI = 0x7f;
const LINE_BREAK = /\r\n|\r|\n/;
/** FChar::IsWhitespace for the characters an ini line can hold once split into lines. */
const EDGE_SPACE = /^[ \t\v\f]+|[ \t\v\f]+$/g;
/** The `.uproject` format version Epic 5.8 writes (EProjectDescriptorVersion::Latest). */
const PROJECT_FILE_VERSION = 3;

/** One value SaveConfigValues sets: a key in a section of a project config file. */
export type ConfigValue = { file: string; section: string; key: string; value: string; replace: boolean };

const startsWithBytes = (bytes: Buffer, prefix: readonly number[]) => prefix.every((byte, i) => bytes[i] === byte);
const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** FFileHelper::LoadFileToString: UTF-16 by its BOM, else UTF-8 with any BOM dropped. */
export function loadEpicText(bytes: Buffer): string {
  const even = bytes.length % 2 === 0;
  if (even && startsWithBytes(bytes, UTF16_LE_BOM)) return bytes.subarray(2).toString("utf16le");
  if (even && startsWithBytes(bytes, UTF16_BE_BOM)) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  const body = startsWithBytes(bytes, UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  return body.toString("utf8");
}

/** FFileHelper::SaveStringToFile with AutoDetect: plain bytes when pure ANSI, else UTF-16LE with its BOM. */
export function saveEpicText(text: string): Buffer {
  const pureAnsi = [...text].every((char) => (char.codePointAt(0) ?? 0) <= HIGHEST_ANSI);
  if (pureAnsi) return Buffer.from(text, "latin1");
  return Buffer.concat([Buffer.from(UTF16_LE_BOM), Buffer.from(text, "utf16le")]);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** FString::ReplaceInline: every occurrence, with the case rule given; an empty pattern changes nothing. */
export function replaceAllText(text: string, from: string, to: string, caseSensitive: boolean): string {
  if (from === "") return text;
  if (caseSensitive) return text.replaceAll(from, to);
  return text.replace(new RegExp(escapeRegExp(from), "gi"), () => to);
}

const placeholder = (index: number) => `{{{REPLACE:${index}}}}`;
const appliesTo = (rule: TemplateReplacement, extension: string) =>
  rule.extensions.some((listed) => sameText(listed, extension));

/**
 * CreateProjectFromTemplate's ReplacementsInFiles (GameProjectUtils.cpp:1847): every rule for the
 * file's extension first turns its pattern into a placeholder, then every placeholder becomes its
 * replacement, so one rule's output never feeds another rule's pattern.
 */
export function replaceInText(text: string, rules: TemplateReplacement[], extension: string): string {
  let out = text;
  rules.forEach((rule, index) => {
    if (appliesTo(rule, extension)) out = replaceAllText(out, rule.from, placeholder(index), rule.caseSensitive);
  });
  rules.forEach((rule, index) => {
    if (appliesTo(rule, extension)) out = out.replaceAll(placeholder(index), rule.to);
  });
  return out;
}

const trimLine = (line: string) => line.replace(EDGE_SPACE, "");

type ConfigWalk = { out: string; section: string; found: boolean };

/** What SaveConfigValues does with one trimmed line while the key is still unplaced: whether it drops the line. */
function placeKey(walk: ConfigWalk, line: string, value: ConfigValue, entry: string, eol: string): boolean {
  if (line.startsWith("[")) {
    if (sameText(walk.section, value.section)) {
      walk.out += entry + eol + eol;
      walk.found = true;
    }
    walk.section = line.slice(1, line.length - 1);
    return false;
  }
  const equals = line.indexOf("=");
  const inSection = line !== "" && !line.startsWith(";") && sameText(walk.section, value.section);
  const matches = inSection && equals >= 0 && sameText(line.slice(0, equals), value.key);
  if (!matches) return false;
  walk.out += entry + eol;
  walk.found = true;
  return value.replace;
}

/**
 * SaveConfigValues (GameProjectUtils.cpp:1565) for one value. The file is read as lines (a final
 * newline leaves an empty last line), every line is trimmed, and the key is replaced in place, added
 * above the first matching key, added at the end of its section (before the next header, then an
 * empty line), or added in a new section at the end; sections and keys compare case-insensitively.
 */
export function setConfigValue(text: string, value: ConfigValue, eol: string): string {
  const lines = text.split(LINE_BREAK);
  const entry = `${value.key}=${value.value}`;
  const walk: ConfigWalk = { out: "", section: "", found: false };
  lines.forEach((raw, index) => {
    const line = trimLine(raw);
    const drop = !walk.found && placeKey(walk, line, value, entry, eol);
    if (!drop) walk.out += line + (index === lines.length - 1 ? "" : eol);
  });
  if (walk.found) return walk.out;
  const header = sameText(walk.section, value.section) ? "" : `${eol}[${value.section}]${eol}`;
  return `${walk.out}${header}${entry}${eol}`;
}

/** Top-level `.uproject` fields FProjectDescriptor::Write keeps only when they are set. */
const OPTIONAL_LISTS = ["AdditionalPluginDirectories", "AdditionalRootDirectories", "TargetPlatforms"] as const;
const OPTIONAL_STEPS = ["PreBuildSteps", "PostBuildSteps"] as const;

const nonEmptyList = (value: unknown) => Array.isArray(value) && value.length > 0;
const asText = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The new project's `.uproject`: the template's descriptor loaded and saved by FProjectDescriptor
 * (ProjectDescriptor.cpp:269) with EngineAssociation emptied and EpicSampleNameHash cleared, then
 * SetEngineAssociationForForeignProject writing the engine's identifier in place. Fields in Epic's
 * order, empty lists left out, unknown fields dropped, tabs, no final newline. Plugin entries keep
 * their own fields in order, as Epic's cached JSON does for the five templates.
 */
export function projectDescriptorText(template: unknown, association: string, eol: string): string {
  const source = isJsonObject(template) ? template : {};
  const out: Record<string, unknown> = {
    FileVersion: PROJECT_FILE_VERSION,
    EngineAssociation: association,
    Category: asText(source.Category),
    Description: asText(source.Description),
  };
  if (source.DisableEnginePluginsByDefault === true) out.DisableEnginePluginsByDefault = true;
  if (source.Enterprise === true) out.Enterprise = true;
  if (nonEmptyList(source.Modules)) out.Modules = source.Modules;
  if (nonEmptyList(source.Plugins)) out.Plugins = source.Plugins;
  for (const key of OPTIONAL_LISTS) if (nonEmptyList(source[key])) out[key] = source[key];
  for (const key of OPTIONAL_STEPS)
    if (isJsonObject(source[key]) && Object.keys(source[key]).length > 0) out[key] = source[key];
  return JSON.stringify(out, null, "\t").replaceAll("\n", eol);
}
