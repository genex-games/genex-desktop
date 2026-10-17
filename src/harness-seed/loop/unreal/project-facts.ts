/**
 * The template an Unreal game is built on, in a few lines for the Loop's lead and builders: which
 * pawn its game mode spawns, its own Blueprints with their components and variables, and its input
 * actions. Read from the Genex editor helper's `export_project` file (`unreal/Saved/Genex/project.json`),
 * which the editor writes; every name is cleaned to one line of name characters, so nothing in the
 * file reads as an instruction.
 */
import type { AnyRecord } from "../../types/harness.d.ts";

/** Where the Genex editor helper writes the project's facts, from the game folder. */
export const PROJECT_FACTS_FILE = "unreal/Saved/Genex/project.json";

/** At most this many Blueprints, components and variables each, and characters in all. */
const MAX_BLUEPRINTS = 40;
const MAX_MEMBERS = 12;
const MAX_FACTS_CHARS = 6000;
const NAME = /[^A-Za-z0-9_ ./:-]/g;
const NAME_CHARS = 120;

/** Room kept for the line saying how many Blueprints were left out. */
const LEFT_OUT_CHARS = 40;
/** The kinds a player-facing part is most likely to build on, first. */
const PLAYER_FACING = /Pawn|Vehicle|Character|GameMode|PlayerController|HUD/;

/** Player-facing Blueprints (pawns, game modes, controllers, HUDs) before the rest, then by path. */
function byRelevance(a: AnyRecord, b: AnyRecord): number {
  const rank = (bp: AnyRecord) => (PLAYER_FACING.test(clean(bp?.parent)) ? 0 : 1);
  return rank(a) - rank(b) || clean(a?.path).localeCompare(clean(b?.path));
}

/** A name from the file: one line of name characters, or "" for anything else. */
function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(NAME, "").trim().slice(0, NAME_CHARS) : "";
}

/** "Name (Class)" for each named member, the first few. */
function members(list: unknown, kind: string): string {
  const named = (Array.isArray(list) ? list : [])
    .map((m: AnyRecord) => [clean(m?.name), clean(m?.[kind])] as const)
    .filter(([name]) => name)
    .map(([name, type]) => (type ? `${name} (${type})` : name));
  const more = named.length > MAX_MEMBERS ? ` and ${named.length - MAX_MEMBERS} more` : "";
  return named.slice(0, MAX_MEMBERS).join(", ") + more;
}

/** One template Blueprint on one line. */
function blueprintLine(bp: AnyRecord): string {
  const name = clean(bp?.name);
  if (!name) return "";
  const where = [clean(bp.parent), clean(bp.path)].filter(Boolean).join(", ");
  const parts = members(bp.components, "class");
  const vars = members(bp.variables, "type");
  const detail = [parts && `components ${parts}`, vars && `variables ${vars}`].filter(Boolean).join("; ");
  return `- ${name}${where ? ` (${where})` : ""}${detail ? `: ${detail}` : ""}`;
}

/** The template's facts for a prompt, or "" when the file is missing or isn't the expected shape. */
export function projectFacts(text: string): string {
  let project: AnyRecord | null = null;
  try {
    project = JSON.parse(text);
  } catch {
    return "";
  }
  const isObject = project !== null && typeof project === "object" && !Array.isArray(project);
  if (!isObject || !Array.isArray(project?.blueprints)) return "";
  const lines: string[] = [];
  const map = clean(project.map);
  if (map) lines.push(`Level: ${map}.`);
  const mode = project.gameMode;
  const modeName = clean(mode?.path).split("/").pop() ?? "";
  const pawn = clean(mode?.defaultPawn);
  if (modeName && pawn) lines.push(`Game mode: ${modeName} spawns ${pawn} as the player.`);
  const actions = (Array.isArray(project.inputActions) ? project.inputActions : []).map(clean).filter(Boolean);
  if (actions.length) lines.push(`Input actions: ${actions.join(", ")}.`);
  const blueprints = [...project.blueprints].sort(byRelevance).map(blueprintLine).filter(Boolean);
  if (blueprints.length) lines.push("The template's own Blueprints:");
  let room = MAX_FACTS_CHARS - lines.join("\n").length - LEFT_OUT_CHARS;
  let shown = 0;
  for (const line of blueprints.slice(0, MAX_BLUEPRINTS)) {
    if (line.length + 1 > room) break;
    lines.push(line);
    room -= line.length + 1;
    shown += 1;
  }
  const leftOut = blueprints.length - shown + exporterLeftOut(project.more);
  if (leftOut > 0) lines.push(`… and ${leftOut} more Blueprints.`);
  return lines.join("\n");
}

/** How many Blueprints the exporter itself left out of the file (its `more`), or 0 for anything else. */
function exporterLeftOut(more: unknown): number {
  const counted = typeof more === "number" && Number.isSafeInteger(more) && more > 0;
  return counted ? more : 0;
}
