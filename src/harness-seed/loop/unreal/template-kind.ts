/**
 * Which of Epic's templates an Unreal game is built on, read from the same export as its facts
 * (`project-facts.ts` `PROJECT_FACTS_FILE`), so the lead hears that template's facts and no other's.
 *
 * A module of its own: `project-facts.ts` is a module the agent may have kept from before, and a kept
 * copy exports only what it did then, so a name the lead newly needs comes from here.
 */
import { isPlainRecord } from "../json.ts";

/** Which of Epic's templates a game is built on, as far as its export says. Prompts key on it: never rename a value. */
export const TemplateKind = {
  /** The vehicle template: a wheeled pawn. */
  Vehicle: "vehicle",
  /** The third-person template's Combat variant: combo, damage, enemy AI and ragdoll. */
  Combat: "combat",
  ThirdPerson: "third-person",
  FirstPerson: "first-person",
  /** None of Epic's that Genex knows: a blank template or the user's own game. */
  Other: "other",
} as const;
export type TemplateKind = (typeof TemplateKind)[keyof typeof TemplateKind];

/** Each template's mark on the names a game's export holds (its game mode, its pawn, its folders), checked in this order. */
const TEMPLATE_MARKS: ReadonlyArray<[TemplateKind, RegExp]> = [
  [TemplateKind.Vehicle, /WheeledVehicle|VehicleTemplate|BP_VehicleAdv/],
  [TemplateKind.Combat, /Variant_Combat|BP_Combat/],
  [TemplateKind.FirstPerson, /FirstPerson/],
  [TemplateKind.ThirdPerson, /ThirdPerson/],
];

/** A name from the export, or "" for anything that isn't text. */
const nameOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The export as a record with its Blueprints listed, or null when the file is missing or isn't that shape. */
function readProject(text: string): Record<string, unknown> | null {
  try {
    const project: unknown = JSON.parse(text);
    return isPlainRecord(project) && Array.isArray(project.blueprints) ? project : null;
  } catch {
    return null;
  }
}

/**
 * Which template the game is built on: read from the names of its map, its game mode, the pawn
 * that mode spawns and that pawn's Blueprint (its parent class and folder). `Other` when the file
 * is missing or names none Genex knows.
 */
export function templateKind(text: string): TemplateKind {
  const project = readProject(text);
  if (!project) return TemplateKind.Other;
  const mode = isPlainRecord(project.gameMode) ? project.gameMode : {};
  const pawn = nameOf(mode.defaultPawn);
  const blueprints = (project.blueprints as unknown[]).filter(isPlainRecord);
  const pawnBlueprint = blueprints.find((bp) => pawn !== "" && nameOf(bp.name) === pawn);
  const names = [project.map, mode.path, pawn, pawnBlueprint?.parent, pawnBlueprint?.path].map(nameOf).join(" ");
  return TEMPLATE_MARKS.find(([, mark]) => mark.test(names))?.[0] ?? TemplateKind.Other;
}
