/**
 * Epic's own Blueprint guide for builders who never open Unreal: the Blueprint basics and the
 * Blueprint text syntax that Epic's EditorToolset ships as Python strings in the user's installed
 * engine. Genex reads them from that engine at the time of the call and copies none of Epic's text.
 * The files are the engine's, read by real path, so a link out of the engine folder is refused.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Epic's EditorToolset Python folder inside an engine. */
const TOOLSET_PYTHON = [
  "Engine",
  "Plugins",
  "Experimental",
  "Toolsets",
  "EditorToolset",
  "Content",
  "Python",
  "editor_toolset",
];
/** The guide's parts: the file and the string it holds. */
const GUIDE_PARTS = [
  { file: ["skills", "blueprint_basics.py"], name: "_INSTRUCTIONS" },
  { file: ["toolsets", "blueprint_dsl.py"], name: "USAGE" },
] as const;
/** The largest guide file read. */
const MAX_GUIDE_BYTES = 512 * 1024;

const MESSAGE = {
  Missing: "This Unreal has no Blueprint guide from Epic's EditorToolset, so write from what check-part says.",
  Heading: (version: string) => `Epic's Blueprint guide and Blueprint text syntax, from Unreal ${version}:`,
} as const;

/** The text of `NAME = """…"""` in a Python file, or undefined. A leading `\` line continuation is dropped. */
function pythonString(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^${name} = """`, "m"));
  if (start < 0) return undefined;
  const open = source.indexOf('"""', start) + 3;
  const close = source.indexOf('"""', open);
  if (close < 0) return undefined;
  return source.slice(open, close).replace(/^\\\n/, "").trim();
}

/** One guide file's text, read only when it is a plain file inside the engine by real path. */
async function guidePart(engineDir: string, part: (typeof GUIDE_PARTS)[number]): Promise<string | undefined> {
  const root = await realpath(engineDir).catch(() => undefined);
  if (!root) return undefined;
  const wanted = path.join(root, ...TOOLSET_PYTHON, ...part.file);
  const real = await realpath(wanted).catch(() => undefined);
  if (real !== wanted) return undefined;
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_GUIDE_BYTES) return undefined;
  return pythonString(await readFile(real, "utf8"), part.name);
}

/** Epic's Blueprint guide from the engine at `engineDir`, or an error naming what's missing. */
export async function readBlueprintGuide(engineDir: string, version: string): Promise<string> {
  const parts = await Promise.all(GUIDE_PARTS.map((part) => guidePart(engineDir, part)));
  const texts = parts.filter((text): text is string => Boolean(text));
  if (texts.length !== GUIDE_PARTS.length) throw new Error(MESSAGE.Missing);
  return [MESSAGE.Heading(version), ...texts].join("\n\n");
}
