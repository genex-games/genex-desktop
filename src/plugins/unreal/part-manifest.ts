/**
 * A part's declaration (`unreal/parts/<Part>/part.json`): its title, its goal in the user's words,
 * the C++ classes it defines (`cpp`: UCLASS names without the A or U prefix, in
 * `unreal/Source/<Module>/Parts/<Part>/`), and the Blueprints it owns with their base class (or one
 * of its C++ classes as their parent), components, variables and functions. The Genex editor helper
 * builds exactly this before the part's `apply.py` runs, and the builders' gate checks each
 * Blueprint's text against it without Unreal. Builders write it, so it is read as data.
 */
import { BaseClass, type BlueprintDecl } from "./blueprint-reference.ts";

/** A Blueprint, component, variable, function, pin or C++ class name: an identifier, never a path. */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The longest type a variable or pin may name ("PointLightComponent object ref" and the like). */
const MAX_TYPE = 64;
/** The most Blueprints one part may own. */
const MAX_BLUEPRINTS = 12;
/** The most C++ classes one part may define. */
export const MAX_CPP_CLASSES = 12;
/** The prefixes Unreal gives a C++ class: A for an actor, U for any other object. */
const CPP_PREFIXES: ReadonlySet<string> = new Set(["A", "U"]);
const BASES: ReadonlySet<string> = new Set(Object.values(BaseClass));

export type PartComponent = { name: string; class: string; parent?: string };
export type PartVariable = { name: string; type: string; category?: string };
export type PartPin = { name: string; type: string };
export type PartFunction = { name: string; inputs: PartPin[]; outputs: PartPin[] };
/** One Blueprint a part owns. */
export type PartBlueprint = {
  name: string;
  /** The nearest class the node reference covers: Actor for a C++ parent unless part.json says otherwise. */
  base: BaseClass;
  /** One of the part's own C++ classes it is made from, without the prefix. */
  parent?: string;
  components: PartComponent[];
  variables: PartVariable[];
  functions: PartFunction[];
};
/** A part's declaration as the gate and the helper read it; `cpp` is [] for a Blueprint-only part. */
export type PartManifest = { title: string; goal: string; cpp: string[]; blueprints: PartBlueprint[] };

const MESSAGE = {
  CppNotList: 'part.json\'s cpp must be a list of C++ class names, such as ["BikeCamera"]',
  CppName: (at: string) =>
    `${at}: a C++ class is named as UCLASS names it without its A or U prefix: a letter, then letters, digits or _ (BikeCamera for ABikeCamera)`,
  CppTooMany: `a part defines at most ${MAX_CPP_CLASSES} C++ classes`,
  CppTwice: (name: string) => `C++ class ${name} is listed twice in cpp`,
  Parent: (blueprint: string, parent: string) =>
    `${blueprint}: its parent ${parent} isn't one of the part's C++ classes (part.json cpp); a Blueprint made from an engine class names it as its base`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && NAME.test(value);
const isType = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TYPE;
const isBase = (value: unknown): value is BaseClass => typeof value === "string" && BASES.has(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

type Reader<T> = (raw: unknown, at: string, problems: string[]) => T | undefined;

const readComponent: Reader<PartComponent> = (raw, at, problems) => {
  if (!isRecord(raw) || !isName(raw.name) || !isName(raw.class)) {
    problems.push(`${at}: a component needs a name and a class, both plain identifiers`);
    return undefined;
  }
  const parent = isName(raw.parent) ? raw.parent : undefined;
  return { name: raw.name, class: raw.class, ...(parent ? { parent } : {}) };
};

const readVariable: Reader<PartVariable> = (raw, at, problems) => {
  if (!isRecord(raw) || !isName(raw.name) || !isType(raw.type)) {
    problems.push(`${at}: a variable needs a name and a type`);
    return undefined;
  }
  const category = typeof raw.category === "string" && raw.category ? raw.category : undefined;
  return { name: raw.name, type: raw.type.trim(), ...(category ? { category } : {}) };
};

function readPins(raw: unknown, at: string, problems: string[]): PartPin[] {
  return list(raw).flatMap((pin) => {
    if (isRecord(pin) && isName(pin.name) && isType(pin.type)) return [{ name: pin.name, type: pin.type.trim() }];
    problems.push(`${at}: a function's inputs and outputs need a name and a type`);
    return [];
  });
}

const readFunction: Reader<PartFunction> = (raw, at, problems) => {
  if (!isRecord(raw) || !isName(raw.name)) {
    problems.push(`${at}: a function needs a plain name`);
    return undefined;
  }
  return { name: raw.name, inputs: readPins(raw.inputs, at, problems), outputs: readPins(raw.outputs, at, problems) };
};

function readAll<T>(raw: unknown, at: string, read: Reader<T>, problems: string[]): T[] {
  return list(raw).flatMap((item, i) => {
    const value = read(item, `${at} #${i + 1}`, problems);
    return value === undefined ? [] : [value];
  });
}

/** A parent a component names must be one of the Blueprint's own components. */
function parentProblems(blueprint: PartBlueprint, at: string): string[] {
  const names = new Set(blueprint.components.map((c) => c.name));
  return blueprint.components
    .filter((c) => c.parent !== undefined && !names.has(c.parent))
    .map((c) => `${at}: component ${c.name}'s parent ${c.parent} isn't one of its components`);
}

/** The part's C++ class a Blueprint's parent names, with or without its A or U prefix. */
function cppParent(parent: string, cpp: readonly string[]): string | undefined {
  if (cpp.includes(parent)) return parent;
  const bare = parent.slice(1);
  return CPP_PREFIXES.has(parent.charAt(0)) && cpp.includes(bare) ? bare : undefined;
}

/**
 * A Blueprint's base and C++ parent: a parent must be one of the part's C++ classes, and the base
 * one the reference covers, Actor when a C++ parent leaves it out.
 */
function readLineage(raw: Record<string, unknown>, at: string, cpp: readonly string[], problems: string[]) {
  const parent = isName(raw.parent) ? cppParent(raw.parent, cpp) : undefined;
  const badParent = raw.parent !== undefined && parent === undefined;
  if (badParent) problems.push(MESSAGE.Parent(at, String(raw.parent)));
  const base = raw.base === undefined && parent !== undefined ? BaseClass.Actor : raw.base;
  if (!isBase(base)) {
    problems.push(`${at}: its base must be one of ${[...BASES].join(", ")}`);
    return undefined;
  }
  return badParent ? undefined : { base, parent };
}

/** Reads a Blueprint whose parent may be one of `cpp`, the part's C++ classes. */
const blueprintReader =
  (cpp: readonly string[]): Reader<PartBlueprint> =>
  (raw, at, problems) => {
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object`);
      return undefined;
    }
    if (!isName(raw.name)) problems.push(`${at}: its name must be a plain identifier such as BP_Lantern`);
    const lineage = readLineage(raw, isName(raw.name) ? raw.name : at, cpp, problems);
    if (!isName(raw.name) || !lineage) return undefined;
    const blueprint: PartBlueprint = {
      name: raw.name,
      base: lineage.base,
      ...(lineage.parent ? { parent: lineage.parent } : {}),
      components: readAll(raw.components, `${raw.name} component`, readComponent, problems),
      variables: readAll(raw.variables, `${raw.name} variable`, readVariable, problems),
      functions: readAll(raw.functions, `${raw.name} function`, readFunction, problems),
    };
    problems.push(...parentProblems(blueprint, raw.name));
    return blueprint;
  };

/** The C++ classes part.json lists: identifiers without their prefix, each once, at most {@link MAX_CPP_CLASSES}. */
function readCppClasses(raw: unknown, problems: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(MESSAGE.CppNotList);
    return [];
  }
  if (raw.length > MAX_CPP_CLASSES) problems.push(MESSAGE.CppTooMany);
  const names: string[] = [];
  for (const [i, name] of raw.entries()) {
    if (!isName(name)) problems.push(MESSAGE.CppName(`cpp #${i + 1}`));
    else if (names.includes(name)) problems.push(MESSAGE.CppTwice(name));
    else names.push(name);
  }
  return names;
}

/** A part's declaration, or every problem with it. */
export function parsePartManifest(raw: unknown): { ok: true; part: PartManifest } | { ok: false; problems: string[] } {
  if (!isRecord(raw)) return { ok: false, problems: ["part.json must be an object with title, goal and blueprints"] };
  if (!Array.isArray(raw.blueprints)) return { ok: false, problems: ["part.json's blueprints must be a list"] };
  const problems: string[] = [];
  const cpp = readCppClasses(raw.cpp, problems);
  if (raw.blueprints.length > MAX_BLUEPRINTS) problems.push(`a part owns at most ${MAX_BLUEPRINTS} Blueprints`);
  const blueprints = readAll(raw.blueprints, "Blueprint", blueprintReader(cpp), problems);
  const names = blueprints.map((b) => b.name);
  const twice = names.filter((name, i) => names.indexOf(name) !== i);
  if (twice.length) problems.push(`Blueprint ${twice[0]} is declared twice`);
  if (problems.length) return { ok: false, problems };
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { ok: true, part: { title: text(raw.title), goal: text(raw.goal), cpp, blueprints } };
}

/** A declared Blueprint as the node lookup reads it. */
export function declOf(blueprint: PartBlueprint): BlueprintDecl {
  return {
    name: blueprint.name,
    base: blueprint.base,
    components: blueprint.components.map((c) => ({ name: c.name, class: c.class })),
    variables: blueprint.variables.map((v) => ({
      name: v.name,
      type: v.type,
      ...(v.category ? { category: v.category } : {}),
    })),
    functions: blueprint.functions.map((f) => ({
      name: f.name,
      inputs: f.inputs.map((p) => p.name),
      outputs: f.outputs.map((p) => p.name),
    })),
  };
}
