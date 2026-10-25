/**
 * Godot's API as the installed version has it, for agents who would otherwise guess from older
 * Godot: the engine's own `--doctool` dump (XML per class), made once per version in the plugin's
 * storage and read into an index. An official build's dump carries every class, method, property,
 * signal and constant with its types, but no descriptions. A query is a class's name (answered with
 * its whole API) or a word (answered with the classes and members whose names hold it).
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GodotInstall } from "./find-godot.ts";
import { type GodotJobScope, type GodotRunner, referenceCall } from "./godot-run.ts";

/** One class's API: what it inherits, and its members as Godot writes their signatures. */
export type ClassApi = {
  name: string;
  inherits: string | null;
  methods: string[];
  properties: string[];
  signals: string[];
  constants: string[];
};

/** Every class of one Godot version, by lower-case name. */
export type ClassIndex = Map<string, ClassApi>;

/** The most matches a word query lists. */
const MAX_MATCHES = 40;
/** The most characters one class's answer has: the biggest classes are cut, with a note. */
const CLASS_ANSWER_CHARS = 12_000;
const QUERY = /^[A-Za-z0-9_]{2,60}$/;
const REFERENCE_FOLDER = "reference";
const READY_MARK = ".ready";

const MESSAGE = {
  BadQuery: "Ask for a Godot class (Node3D) or a word of a member's name (velocity): 2 to 60 letters, digits or _.",
  NoMatch: (query: string, version: string) => `Godot ${version} has no class or member named like "${query}".`,
  NoDump: (version: string) => `Godot ${version} didn't write its class reference.`,
  Cut: (shown: number, all: number) => `(${all - shown} more lines not shown: ask for a narrower word.)`,
} as const;

const attribute = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
const decode = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** A method as Godot writes it: `get_limit(margin: int) const -> int`. */
function methodSignature(block: string): string {
  const name = attribute(block, "name");
  const returns = attribute(/<return [^>]*>/.exec(block)?.[0] ?? "", "type") || "void";
  const params = [...block.matchAll(/<param [^>]*>/g)].map((m) => {
    const fallback = attribute(m[0], "default");
    return `${attribute(m[0], "name")}: ${attribute(m[0], "type")}${fallback ? ` = ${decode(fallback)}` : ""}`;
  });
  const qualifiers = attribute(block, "qualifiers");
  return `${name}(${params.join(", ")})${qualifiers ? ` ${qualifiers}` : ""} -> ${returns}`;
}

/** One class's XML read into its API. */
export function readClass(xml: string): ClassApi | null {
  const head = /<class [^>]*>/.exec(xml)?.[0];
  if (!head) return null;
  const blocks = (tag: string) => [...xml.matchAll(new RegExp(`<${tag} [^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"))];
  return {
    name: attribute(head, "name"),
    inherits: attribute(head, "inherits") || null,
    methods: blocks("method").map((m) => methodSignature(m[0])),
    properties: [...xml.matchAll(/<member [^>]*>/g)].map((m) => {
      const fallback = attribute(m[0], "default");
      return `${attribute(m[0], "name")}: ${attribute(m[0], "type")}${fallback ? ` = ${decode(fallback)}` : ""}`;
    }),
    signals: blocks("signal").map((m) => {
      const params = [...m[0].matchAll(/<param [^>]*>/g)].map(
        (p) => `${attribute(p[0], "name")}: ${attribute(p[0], "type")}`,
      );
      return `${attribute(m[0], "name")}(${params.join(", ")})`;
    }),
    constants: [...xml.matchAll(/<constant [^>]*>/g)].map(
      (m) => `${attribute(m[0], "name")} = ${decode(attribute(m[0], "value"))}`,
    ),
  };
}

/** Every XML file below a folder. */
async function xmlFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith(".xml")).map((e) => path.join(e.parentPath, e.name));
}

/** The folder one version's dump lives in, by its whole version line (a .NET build's API differs). */
const versionFolder = (storage: string, install: GodotInstall) =>
  path.join(storage, REFERENCE_FOLDER, install.version.text.replace(/[^A-Za-z0-9.-]+/g, "_"));

/**
 * The version's dump in storage, made now when it isn't there: written beside its place and moved
 * in once whole, so a dump cut short is never read as one.
 */
async function ensureDump(storage: string, install: GodotInstall, run: GodotRunner, job: GodotJobScope) {
  const folder = versionFolder(storage, install);
  if (await readFile(path.join(folder, READY_MARK)).catch(() => null)) return folder;
  const making = `${folder}.making`;
  await rm(making, { recursive: true, force: true });
  await mkdir(making, { recursive: true });
  await run(install.binary, referenceCall(making), job);
  if ((await xmlFiles(making)).length === 0) throw new Error(MESSAGE.NoDump(install.version.text));
  await writeFile(path.join(making, READY_MARK), install.version.text);
  await rm(folder, { recursive: true, force: true });
  await rename(making, folder);
  return folder;
}

/** The class index of each version, made once per backend from its dump in the plugin's `storage`. */
export function createReference(run: GodotRunner) {
  const indexes = new Map<string, Promise<ClassIndex>>();
  const load = async (install: GodotInstall, storage: string, job: GodotJobScope): Promise<ClassIndex> => {
    const folder = await ensureDump(storage, install, run, job);
    const index: ClassIndex = new Map();
    for (const file of await xmlFiles(folder)) {
      const api = readClass(await readFile(file, "utf8"));
      if (api?.name) index.set(api.name.toLowerCase(), api);
    }
    return index;
  };
  return async (install: GodotInstall, storage: string, job: GodotJobScope): Promise<ClassIndex> => {
    const key = install.version.text;
    const known = indexes.get(key) ?? load(install, storage, job);
    indexes.set(key, known);
    return known.catch((error: unknown) => {
      indexes.delete(key);
      throw error;
    });
  };
}

/** One class's whole API as text, cut at a length an answer can carry. */
export function describeClass(api: ClassApi): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? [`${title}:`, ...lines.map((l) => `  ${l}`)] : [];
  const lines = [
    `class ${api.name}${api.inherits ? ` extends ${api.inherits}` : ""}`,
    ...section("properties", api.properties),
    ...section("methods", api.methods),
    ...section("signals", api.signals),
    ...section("constants", api.constants),
  ];
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > CLASS_ANSWER_CHARS) {
      kept.push(MESSAGE.Cut(kept.length, lines.length));
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join("\n");
}

/** The classes and members whose names hold `word`, as `Class.member` lines, at most {@link MAX_MATCHES}. */
function matching(index: ClassIndex, word: string): string[] {
  const found: string[] = [];
  for (const api of index.values()) {
    if (api.name.toLowerCase().includes(word)) found.push(`class ${api.name}`);
    const members = [...api.properties, ...api.methods, ...api.signals];
    for (const member of members)
      if (member.split(/[(:]/)[0]?.toLowerCase().includes(word)) found.push(`${api.name}.${member}`);
    if (found.length >= MAX_MATCHES) break;
  }
  return found.slice(0, MAX_MATCHES);
}

/** The answer to a query: a class's API, else the names that hold the word, else why nothing matched. */
export function answerQuery(index: ClassIndex, query: string, version: string): string {
  const asked = query.trim();
  if (!QUERY.test(asked)) return MESSAGE.BadQuery;
  const exact = index.get(asked.toLowerCase());
  if (exact) return describeClass(exact);
  const found = matching(index, asked.toLowerCase());
  return found.length ? found.join("\n") : MESSAGE.NoMatch(asked, version);
}
