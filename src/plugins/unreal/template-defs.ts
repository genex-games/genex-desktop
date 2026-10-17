/**
 * An Unreal template's `Config/TemplateDefs.ini`, read the way UTemplateProjectDefs::LoadConfig
 * reads it (UE 5.8.3): one section, a repeated key builds an array, a quoted value is a string,
 * and `(Key=Value,…)` is a struct in Unreal's import-text syntax. Only the fields project creation
 * and the template cards use are kept.
 */

const DEFS_SECTION = "[/Script/GameProjectGeneration.TemplateProjectDefs]";
const ENGLISH = "en";
const BOM = "﻿";
const LINE_BREAK = /\r\n|\r|\n/;
const KEYED_ITEM = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;
const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);

/** A replacement rule: in names (FilenameReplacements) or in text (ReplacementsInFiles). */
export type TemplateReplacement = { extensions: string[]; from: string; to: string; caseSensitive: boolean };
/** A folder the copy moves (FolderRenames). */
export type FolderRename = { from: string; to: string };
/** A shared content pack and the detail levels it comes in (SharedContentPacks). */
export type PackLevelSet = { mount: string; levels: string[] };
/**
 * A starting point the template offers beside its default (Variants, FTemplateVariant): its name,
 * Epic's English display name and description, and the shared packs it adds after the template's.
 */
export type TemplateVariantDefs = {
  name: string;
  displayName: string;
  description: string;
  sharedContentPacks: PackLevelSet[];
};

/** What creation and the template cards read from a template's defs. */
export type TemplateDefs = {
  displayName: string;
  description: string;
  isBlank: boolean;
  /** TemplateProjectDefsClass: a custom C++ defs class, which Genex cannot replicate. */
  customClass: string;
  hiddenSettings: string[];
  foldersToIgnore: string[];
  filesToIgnore: string[];
  folderRenames: FolderRename[];
  filenameReplacements: TemplateReplacement[];
  replacementsInFiles: TemplateReplacement[];
  sharedContentPacks: PackLevelSet[];
  variants: TemplateVariantDefs[];
};

/** A value in Unreal's import-text syntax: a string, a list, or a struct of named values. */
type UeValue = string | UeValue[] | { [key: string]: UeValue };
type Parsed = { value: UeValue; next: number };

const isStruct = (value: UeValue | undefined): value is { [key: string]: UeValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: UeValue | undefined): string => (typeof value === "string" ? value : "");
const list = (value: UeValue | undefined): UeValue[] => (Array.isArray(value) ? value : []);
const isTrue = (value: UeValue | undefined) => TRUE_WORDS.has(text(value).toLowerCase());

const skipSpace = (source: string, at: number) => {
  let i = at;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
};

/** A quoted string from `at` (the opening quote), with Unreal's backslash escapes. */
function parseQuoted(source: string, at: number): Parsed {
  let out = "";
  let i = at + 1;
  while (i < source.length && source[i] !== '"') {
    const escaped = source[i] === "\\" && i + 1 < source.length;
    out += escaped ? source[i + 1] : source[i];
    i += escaped ? 2 : 1;
  }
  return { value: out, next: i + 1 };
}

/** Whether a bare word ends here: at the end of the text, a comma or a closing parenthesis. */
const endsBare = (c: string | undefined) => c === undefined || c === "," || c === ")";

/** A bare word up to the next comma or closing parenthesis. */
function parseBare(source: string, at: number): Parsed {
  let i = at;
  while (!endsBare(source[i])) i++;
  return { value: source.slice(at, i).trim(), next: i };
}

function parseValue(source: string, at: number): Parsed {
  const i = skipSpace(source, at);
  if (source[i] === '"') return parseQuoted(source, i);
  if (source[i] === "(") return parseGroup(source, i);
  return parseBare(source, i);
}

/** `(…)` from `at`: a struct when its items are `Key=Value`, else a list. */
function parseGroup(source: string, at: number): Parsed {
  const items: UeValue[] = [];
  const fields: { [key: string]: UeValue } = {};
  let keyed = false;
  let i = skipSpace(source, at + 1);
  while (i < source.length && source[i] !== ")") {
    const key = KEYED_ITEM.exec(source.slice(i));
    if (key) keyed = true;
    const parsed = parseValue(source, key ? i + key[0].length : i);
    if (key) fields[key[0].replace("=", "").trim()] = parsed.value;
    else items.push(parsed.value);
    i = skipSpace(source, parsed.next);
    if (source[i] === ",") i = skipSpace(source, i + 1);
  }
  return { value: keyed ? fields : items, next: i + 1 };
}

/** One config value as LoadConfig imports it: a quoted string, a struct or list, or the text as written. */
function importValue(raw: string): UeValue {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("(")) return parseValue(value, 0).value;
  return value;
}

/** One `Key=Value` line applied to the keys read so far: `+Key` adds like a repeated key, `-Key` removes, `!Key` clears. */
function applyLine(keys: Map<string, UeValue[]>, line: string, equals: number): void {
  const name = line.slice(0, equals).trim();
  const op = /^[+\-!.]/.test(name) ? name[0] : "";
  const key = (op ? name.slice(1) : name).toLowerCase();
  const values = keys.get(key) ?? [];
  const value = importValue(line.slice(equals + 1));
  const same = (v: UeValue) => JSON.stringify(v) === JSON.stringify(value);
  if (op === "!") keys.set(key, []);
  else if (op === "-")
    keys.set(
      key,
      values.filter((v) => !same(v)),
    );
  else keys.set(key, [...values, value]);
}

const isComment = (line: string) => line.startsWith(";") || line.startsWith("#");

/** The defs section's keys, each with its values in order. */
function readSection(source: string): Map<string, UeValue[]> {
  const keys = new Map<string, UeValue[]>();
  let inSection = false;
  for (const raw of source.replace(BOM, "").split(LINE_BREAK)) {
    const line = raw.trim();
    if (line.startsWith("[")) inSection = line.toLowerCase() === DEFS_SECTION.toLowerCase();
    const equals = line.indexOf("=");
    const setting = inSection && !isComment(line) && equals > 0;
    if (setting) applyLine(keys, line, equals);
  }
  return keys;
}

/** Epic's FLocalizedTemplateString choice for an English reader: English, else the first one. */
function englishText(entries: UeValue[]): string {
  const structs = entries.filter(isStruct);
  const english = structs.find((entry) => text(entry.Language) === ENGLISH) ?? structs[0];
  return text(english?.Text);
}

/** SharedContentPacks entries as pack level sets. */
const packLevelSets = (values: UeValue[]): PackLevelSet[] =>
  values.filter(isStruct).map((v) => ({ mount: text(v.MountName), levels: list(v.DetailLevels).map(text) }));

/**
 * The template's variants as UTemplateProjectDefs keeps them: the first of each name, none without
 * one (NAME_None stands for no variant).
 */
function variantsFrom(values: UeValue[]): TemplateVariantDefs[] {
  const variants: TemplateVariantDefs[] = [];
  for (const value of values.filter(isStruct)) {
    const name = text(value.Name);
    if (name === "" || variants.some((variant) => variant.name === name)) continue;
    variants.push({
      name,
      displayName: englishText(list(value.LocalizedDisplayNames)),
      description: englishText(list(value.LocalizedDescriptions)),
      sharedContentPacks: packLevelSets(list(value.SharedContentPacks)),
    });
  }
  return variants;
}

function replacementFrom(value: UeValue): TemplateReplacement | undefined {
  if (!isStruct(value)) return undefined;
  return {
    extensions: list(value.Extensions).map(text),
    from: text(value.From),
    to: text(value.To),
    caseSensitive: isTrue(value.bCaseSensitive),
  };
}

const present = <T>(item: T | undefined): item is T => item !== undefined;

/** The defs a template's `TemplateDefs.ini` text declares. */
export function parseTemplateDefs(source: string): TemplateDefs {
  const keys = readSection(source);
  const all = (key: string) => keys.get(key.toLowerCase()) ?? [];
  const last = (key: string) => all(key).at(-1);
  return {
    displayName: englishText(all("LocalizedDisplayNames")),
    description: englishText(all("LocalizedDescriptions")),
    isBlank: isTrue(last("bIsBlank")),
    customClass: text(last("TemplateProjectDefsClass")),
    hiddenSettings: all("HiddenSettings").map(text),
    foldersToIgnore: all("FoldersToIgnore").map(text),
    filesToIgnore: all("FilesToIgnore").map(text),
    folderRenames: all("FolderRenames")
      .filter(isStruct)
      .map((v) => ({ from: text(v.From), to: text(v.To) })),
    filenameReplacements: all("FilenameReplacements").map(replacementFrom).filter(present),
    replacementsInFiles: all("ReplacementsInFiles").map(replacementFrom).filter(present),
    sharedContentPacks: packLevelSets(all("SharedContentPacks")),
    variants: variantsFrom(all("Variants")),
  };
}

/** UTemplateProjectDefs::FixString: the template's and the project's name in their three spellings. */
function fixString(value: string, template: string, project: string): string {
  return value
    .replaceAll("%TEMPLATENAME%", template)
    .replaceAll("%TEMPLATENAME_UPPERCASE%", template.toUpperCase())
    .replaceAll("%TEMPLATENAME_LOWERCASE%", template.toLowerCase())
    .replaceAll("%PROJECTNAME%", project)
    .replaceAll("%PROJECTNAME_UPPERCASE%", project.toUpperCase())
    .replaceAll("%PROJECTNAME_LOWERCASE%", project.toLowerCase());
}

/** UTemplateProjectDefs::FixupStrings: the ignore lists, renames and replacements with the names filled in. */
export function fixupStrings(defs: TemplateDefs, template: string, project: string): TemplateDefs {
  const fix = (value: string) => fixString(value, template, project);
  const fixRule = (rule: TemplateReplacement) => ({ ...rule, from: fix(rule.from), to: fix(rule.to) });
  return {
    ...defs,
    foldersToIgnore: defs.foldersToIgnore.map(fix),
    filesToIgnore: defs.filesToIgnore.map(fix),
    folderRenames: defs.folderRenames.map((rename) => ({ from: fix(rename.from), to: fix(rename.to) })),
    filenameReplacements: defs.filenameReplacements.map(fixRule),
    replacementsInFiles: defs.replacementsInFiles.map(fixRule),
  };
}
