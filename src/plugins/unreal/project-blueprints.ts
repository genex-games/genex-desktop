/**
 * The game's template Blueprints for the builders' gate. The Genex editor helper's `export_project`
 * writes what the project is made of (its level, game mode, own Blueprints with their components and
 * variables, input actions) to `<project>/Saved/Genex/project.json`; a part may cast to and use those
 * Blueprints as it uses another part's. The file is read as plain data: it must be a regular file
 * really inside the project, small, JSON, and every name an identifier, or it counts as no Blueprints.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { BaseClass, type BlueprintDecl } from "./blueprint-reference.ts";

/** Where the editor writes the project file, inside the project folder. */
export const PROJECT_EXPORT = path.join("Saved", "Genex", "project.json");

/** The largest project file read, and how much of it is used. */
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_BLUEPRINTS = 200;
const MAX_MEMBERS = 60;
const MAX_TYPE_CHARS = 120;
/** A Blueprint, component or variable name as Unreal allows it in a node id. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** What a type may show: names, spaces and the punctuation of "Actor object ref" or "int array". */
const NOT_TYPE = /[^A-Za-z0-9_ .:-]/g;

const BASES: ReadonlySet<string> = new Set(Object.values(BaseClass));
/**
 * The nearest base the node reference covers, for native parents the templates use that aren't one;
 * any other parent counts as an Actor. A base only picks the context of a Blueprint's own graphs,
 * which parts never write for a template Blueprint.
 */
const NEAREST_BASE: Readonly<Record<string, BaseClass>> = {
  GameMode: BaseClass.GameModeBase,
  WheeledVehiclePawn: BaseClass.Pawn,
  DefaultPawn: BaseClass.Pawn,
  SpectatorPawn: BaseClass.Pawn,
  PrimitiveComponent: BaseClass.SceneComponent,
  StaticMeshComponent: BaseClass.SceneComponent,
  SkeletalMeshComponent: BaseClass.SceneComponent,
  CameraComponent: BaseClass.SceneComponent,
  SpringArmComponent: BaseClass.SceneComponent,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string => typeof value === "string" && IDENTIFIER.test(value);

/** The base a template Blueprint is checked as, from its native parent's name. */
export function nearestBase(parent: unknown): BaseClass {
  if (typeof parent !== "string") return BaseClass.Actor;
  if (BASES.has(parent)) return parent as BaseClass;
  return Object.hasOwn(NEAREST_BASE, parent) ? (NEAREST_BASE[parent] ?? BaseClass.Actor) : BaseClass.Actor;
}

/** The named members of a list (components by class, variables by type), names checked, types cleaned. */
function members(list: unknown, kind: "class" | "type"): { name: string; type: string }[] {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_MEMBERS)
    .filter(isRecord)
    .filter((member) => isIdentifier(member.name))
    .map((member) => {
      const type = typeof member[kind] === "string" ? member[kind] : "";
      return { name: member.name as string, type: type.replace(NOT_TYPE, "").slice(0, MAX_TYPE_CHARS) };
    });
}

function declOf(raw: unknown): BlueprintDecl | undefined {
  if (!isRecord(raw) || !isIdentifier(raw.name)) return undefined;
  return {
    name: raw.name,
    base: nearestBase(raw.parent),
    components: members(raw.components, "class").map(({ name, type }) => ({ name, class: type })),
    variables: members(raw.variables, "type"),
    functions: [],
  };
}

/** The Blueprints a project file declares, as the gate reads them; [] for anything of another shape. */
export function parseProjectBlueprints(raw: unknown): BlueprintDecl[] {
  if (!isRecord(raw) || !Array.isArray(raw.blueprints)) return [];
  return raw.blueprints.slice(0, MAX_BLUEPRINTS).flatMap((blueprint) => declOf(blueprint) ?? []);
}

/** The project file the editor exported for the project whose `.uproject` is `projectFile`, parsed; undefined without a usable one. */
async function readProjectExport(projectFile: string | undefined): Promise<unknown> {
  if (!projectFile) return undefined;
  try {
    const file = path.join(path.dirname(projectFile), PROJECT_EXPORT);
    const expected = path.join(await realpath(path.dirname(projectFile)), PROJECT_EXPORT);
    const info = await lstat(file);
    const inside = (await realpath(file)) === expected;
    if (!inside || !info.isFile() || info.size > MAX_PROJECT_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // No project file yet, or one that isn't JSON.
    return undefined;
  }
}

/** The template Blueprints of the project whose `.uproject` is `projectFile`; [] without a usable file (the gate checks against the parts alone). */
export async function readProjectBlueprints(projectFile: string | undefined): Promise<BlueprintDecl[]> {
  return parseProjectBlueprints(await readProjectExport(projectFile));
}

/** Whether the editor exported the template's facts for the project: its project file lists Blueprints. */
export async function projectExported(projectFile: string | undefined): Promise<boolean> {
  const raw = await readProjectExport(projectFile);
  return isRecord(raw) && Array.isArray(raw.blueprints);
}
