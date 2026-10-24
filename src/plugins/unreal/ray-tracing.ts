/**
 * Hardware ray tracing in an Unreal project's own config (`Config/DefaultEngine.ini`,
 * `r.RayTracing` in the renderer settings). On a Mac, UE 5.8 rendering a ray-traced level behind
 * another app hangs the GPU and crashes the editor, so Genex makes Mac games without it
 * (`create-project.ts`) and offers to turn it off in a game that has it. Lumen still lights the
 * level, tracing in software. The config is read and written only as a plain small file, never
 * through a link; every other line stays as it was.
 */
import path from "node:path";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { loadEpicText } from "./epic-files.ts";

/** A project's engine config, beside its .uproject. */
const CONFIG = ["Config", "DefaultEngine.ini"] as const;
const RENDERER = "/Script/Engine.RendererSettings";
const KEY = "r.raytracing";
/** A project's engine config is a few KB; past this it is not one Genex rewrites. */
const MAX_CONFIG_BYTES = 1024 * 1024;
const LINE_BREAK = /\r\n|\r|\n/;
const CRLF = "\r\n";
const LF = "\n";
/** The values Unreal reads as on for a boolean console variable. */
const ON = new Set(["true", "1", "yes", "on"]);

const configOf = (projectFile: string) => path.join(path.dirname(projectFile), ...CONFIG);

/** A config line as section header, key and value; null for a blank line, a comment or anything else. */
function parseLine(line: string): { section: string } | { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return { section: trimmed.slice(1, -1) };
  const equals = trimmed.indexOf("=");
  if (trimmed === "" || trimmed.startsWith(";") || equals <= 0) return null;
  return { key: trimmed.slice(0, equals).trim().toLowerCase(), value: trimmed.slice(equals + 1).trim() };
}

/** The index of each `r.RayTracing` line in the renderer settings, and of the section's last line. */
function rayTracingLines(lines: readonly string[]): { found: number[]; sectionEnd: number | null } {
  const found: number[] = [];
  let section = "";
  let sectionEnd: number | null = null;
  lines.forEach((line, index) => {
    const parsed = parseLine(line);
    if (parsed && "section" in parsed) section = parsed.section;
    const inRenderer = section.toLowerCase() === RENDERER.toLowerCase();
    if (inRenderer && line.trim() !== "") sectionEnd = index;
    if (inRenderer && parsed && "key" in parsed && parsed.key === KEY) found.push(index);
  });
  return { found, sectionEnd };
}

/** The config's text, or "" when the project has none; throws for one that is a link, not a file, or too large. */
async function configText(file: string): Promise<string> {
  try {
    return loadEpicText(await readRegularFile(file, MAX_CONFIG_BYTES));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return "";
    throw error;
  }
}

/** Whether Unreal would start the project with hardware ray tracing: the last `r.RayTracing` it reads is on. */
export async function projectRayTracing(projectFile: string): Promise<boolean> {
  const text = await configText(configOf(projectFile)).catch(() => "");
  const lines = text.split(LINE_BREAK);
  const last = rayTracingLines(lines).found.at(-1);
  const parsed = last === undefined ? null : parseLine(lines[last] ?? "");
  return parsed !== null && "value" in parsed && ON.has(parsed.value.toLowerCase());
}

/**
 * Turns hardware ray tracing off in the project's config: every `r.RayTracing` line in the
 * renderer settings becomes `r.RayTracing=False`, or the line is added at the end of that section
 * (a new one when there is none). Unreal reads it at the project's next start.
 */
export async function turnOffRayTracing(projectFile: string): Promise<void> {
  const file = configOf(projectFile);
  const text = await configText(file);
  const eol = text.includes(CRLF) ? CRLF : LF;
  const lines = text === "" ? [] : text.split(LINE_BREAK);
  const { found, sectionEnd } = rayTracingLines(lines);
  const off = "r.RayTracing=False";
  if (found.length > 0) for (const index of found) lines[index] = off;
  else if (sectionEnd !== null) lines.splice(sectionEnd + 1, 0, off);
  else {
    // A config that ends with its final line break keeps one blank line before the new section.
    if (lines.at(-1) === "") lines.pop();
    lines.push(...(lines.length ? [""] : []), `[${RENDERER}]`, off, "");
  }
  await atomicWriteText(file, lines.join(eol));
}
